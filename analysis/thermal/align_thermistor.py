#!/usr/bin/env python3
"""Align an external thermistor log with the tPBM app's Temperature CSV.

The thermistor logger (temp_sensor/scripts/log_run.py) and the app's
"Debug: record temperature with computer UTC time" export both stamp each
reading with the wall clock of the computer that received it (``unix_time_ms``
and ``UnixTimeMs``). When both ran on one computer they share that clock, so
the tables are joined on absolute time and no offset is applied. A clock step
during either recording would break the join, so each log's wall-minus-monotonic
drift is checked and reported.

Every row of the app export (device readings and phase markers) receives the
thermistor temperature linearly interpolated at its timestamp.

Outputs, next to the thermistor log unless --out-dir is given:
    aligned_<app>__<thermistor>.csv   app export + SessionTimeSec, ThermistorTempC,
                                      ThermistorNearestDtMs, ThermistorMinusDeviceC
    phases_<app>__<thermistor>.csv    per-block summary of both sensors
    aligned_<app>__<thermistor>.html  both traces, stimulation blocks, hover readout

Usage:
    python3 analysis/thermal/align_thermistor.py THERMISTOR_CSV APP_TEMPERATURE_CSV
        [--out-dir DIR]
"""

import argparse
import bisect
import csv
import datetime as dt
import html
import json
import math
import sys
from pathlib import Path

MEASUREMENT_STATUSES = {"ok", "outside_sensor_rating"}
PHASE_MARKERS = {"EMG_START": "EMG", "RT_START": "RT", "REST_START": "REST"}
REQUIRED_APP_COLUMNS = ("UnixTimeMs", "ElapsedMonotonicMs", "Event", "TemperatureC",
                        "RunIndex", "Condition", "Phase", "ThermalPaused")
MAX_BRACKET_MS = 2500      # never interpolate across a longer gap between samples
CLOCK_STEP_WARN_MS = 250   # drift range that suggests the wall clock was stepped
LAG_SEARCH_S = 180         # +/- window for the response-lag estimate
PHASE_FIELDS = ("RunIndex", "Condition", "Block", "StartUTC", "EndUTC", "DurationSec",
                "DeviceReadings", "DeviceStartC", "DeviceEndC", "DevicePeakC",
                "DevicePeakAtSec", "DeviceRiseC", "ThermistorStartC", "ThermistorEndC",
                "ThermistorPeakC", "ThermistorPeakAtSec", "ThermistorRiseC",
                "MeanDiffC", "MaxDiffC")


def fmt(value, digits=2):
    return "" if value is None else f"{value:.{digits}f}"


def iso_utc(unix_ms):
    t = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(milliseconds=unix_ms)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def load_thermistor(path):
    """Measurement rows as time-sorted (unix_ms, temp_c, elapsed_ms) lists."""
    rows = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if row.get("status") in MEASUREMENT_STATUSES and row.get("temperature_c"):
                rows.append((int(row["unix_time_ms"]), float(row["temperature_c"]),
                             float(row["elapsed_seconds"]) * 1000.0))
    if not rows:
        sys.exit(f"{path}: no thermistor measurement rows")
    rows.sort()
    return [r[0] for r in rows], [r[1] for r in rows], [r[2] for r in rows]


def load_app(path):
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    missing = [c for c in REQUIRED_APP_COLUMNS if c not in (reader.fieldnames or [])]
    if missing:
        sys.exit(f"{path}: not an app Temperature CSV (missing {', '.join(missing)})")
    if not rows:
        sys.exit(f"{path}: no rows")
    return reader.fieldnames, rows


def interpolate(times, values, t):
    """Linear interpolation at t -> (value or None, signed ms to the nearest sample)."""
    i = bisect.bisect_left(times, t)
    nearest = min((times[j] - t for j in (i - 1, i) if 0 <= j < len(times)), key=abs)
    if i < len(times) and times[i] == t:
        return values[i], 0
    if i == 0 or i == len(times) or times[i] - times[i - 1] > MAX_BRACKET_MS:
        return None, nearest
    w = (t - times[i - 1]) / (times[i] - times[i - 1])
    return values[i - 1] + w * (values[i] - values[i - 1]), nearest


def drift_ms(unix_ms, elapsed_ms):
    """Wall-clock minus monotonic time since the first row (flat = no clock change)."""
    return [(u - unix_ms[0]) - (e - elapsed_ms[0]) for u, e in zip(unix_ms, elapsed_ms)]


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx and syy else None


def response_lag(dev_t, dev_v, thm_t, thm_v):
    """Shift (s) that maximises correlation; positive = device trails thermistor.

    Returns ((lag_s, r), r_at_zero). This measures how the two sensors respond,
    not clock error: the timestamps are already on one clock.
    """
    start, end = max(dev_t[0], thm_t[0]), min(dev_t[-1], thm_t[-1])
    grid = range(start, end + 1, 1000)
    dev = [interpolate(dev_t, dev_v, t)[0] for t in grid]
    thm = [interpolate(thm_t, thm_v, t)[0] for t in grid]
    best, r_zero = None, None
    for lag in range(-LAG_SEARCH_S, LAG_SEARCH_S + 1):
        pairs = [(thm[k], dev[k + lag]) for k in range(max(0, -lag), min(len(grid), len(grid) - lag))
                 if thm[k] is not None and dev[k + lag] is not None]
        r = pearson([p[0] for p in pairs], [p[1] for p in pairs])
        if r is None:
            continue
        if lag == 0:
            r_zero = r
        if best is None or r > best[1]:
            best = (lag, r)
    return best, r_zero


def phase_blocks(app_rows):
    """Blocks between phase markers in log order, each run's EMG+RT block after its RT."""
    blocks, current = [], None
    for row in app_rows:
        event, t = row["Event"], int(row["UnixTimeMs"])
        if current and (event in PHASE_MARKERS or event == "SESSION_END"
                        or event.startswith("SESSION_ABORTED")):
            current["end_ms"] = t
            blocks.append(current)
            current = None
        if event in PHASE_MARKERS:
            current = {"run": row["RunIndex"], "condition": row["Condition"],
                       "block": PHASE_MARKERS[event], "start_ms": t}
    if current:  # no end marker: the page closed before the session was finalised
        current["end_ms"] = int(app_rows[-1]["UnixTimeMs"])
        blocks.append(current)

    ordered = []
    for i, b in enumerate(blocks):
        ordered.append(b)
        nxt = blocks[i + 1] if i + 1 < len(blocks) else None
        run_ends = b["block"] in ("EMG", "RT") and not (
            nxt and nxt["run"] == b["run"] and nxt["block"] in ("EMG", "RT"))
        if run_ends:
            stim = [s for s in blocks if s["run"] == b["run"] and s["block"] in ("EMG", "RT")]
            ordered.append({"run": b["run"], "condition": b["condition"], "block": "EMG+RT",
                            "start_ms": min(s["start_ms"] for s in stim),
                            "end_ms": max(s["end_ms"] for s in stim)})
    return ordered


def summarize(block, dev_t, dev_v, thm_t, thm_v, diff):
    s, e = block["start_ms"], block["end_ms"]
    lo, hi = bisect.bisect_left(dev_t, s), bisect.bisect_left(dev_t, e)
    tlo, thi = bisect.bisect_left(thm_t, s), bisect.bisect_left(thm_t, e)
    dv, tv = dev_v[lo:hi], thm_v[tlo:thi]
    diffs = [d for d in diff[lo:hi] if d is not None]

    def at(times, values, t, fallback):
        value = interpolate(times, values, t)[0]
        return fallback if value is None else value

    dev_start = at(dev_t, dev_v, s, dv[0] if dv else None)
    dev_end = at(dev_t, dev_v, e, dv[-1] if dv else None)
    thm_start = at(thm_t, thm_v, s, tv[0] if tv else None)
    thm_end = at(thm_t, thm_v, e, tv[-1] if tv else None)

    def peak(values, times, start_value, end_value):
        """Highest value, boundary values included -> (value, s from block start)."""
        candidates = list(zip(values, times)) + [
            (v, t) for v, t in ((start_value, s), (end_value, e)) if v is not None]
        if not candidates:
            return None, None
        value, t = max(candidates, key=lambda c: c[0])
        return value, (t - s) / 1000

    dev_peak, dev_peak_at = peak(dv, dev_t[lo:hi], dev_start, dev_end)
    thm_peak, thm_peak_at = peak(tv, thm_t[tlo:thi], thm_start, thm_end)
    rise = lambda a, b: None if a is None or b is None else b - a
    return {
        "RunIndex": block["run"], "Condition": block["condition"], "Block": block["block"],
        "StartUTC": iso_utc(s), "EndUTC": iso_utc(e), "DurationSec": fmt((e - s) / 1000, 1),
        "DeviceReadings": len(dv),
        "DeviceStartC": fmt(dev_start), "DeviceEndC": fmt(dev_end),
        "DevicePeakC": fmt(dev_peak), "DevicePeakAtSec": fmt(dev_peak_at, 1),
        "DeviceRiseC": fmt(rise(dev_start, dev_end)),
        "ThermistorStartC": fmt(thm_start), "ThermistorEndC": fmt(thm_end),
        "ThermistorPeakC": fmt(thm_peak), "ThermistorPeakAtSec": fmt(thm_peak_at, 1),
        "ThermistorRiseC": fmt(rise(thm_start, thm_end)),
        "MeanDiffC": fmt(sum(diffs) / len(diffs)) if diffs else "",
        "MaxDiffC": fmt(max(diffs)) if diffs else "",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("thermistor_csv", type=Path, help="temp_sensor logger CSV")
    parser.add_argument("app_csv", type=Path, help="app Temperature CSV (tpbm_temperature_*.csv)")
    parser.add_argument("--out-dir", type=Path, help="default: the thermistor log's folder")
    args = parser.parse_args()

    thm_t, thm_v, thm_e = load_thermistor(args.thermistor_csv)
    fieldnames, app_rows = load_app(args.app_csv)
    readings = sorted((int(r["UnixTimeMs"]), float(r["TemperatureC"])) for r in app_rows
                      if r["Event"] == "TEMPERATURE" and r["TemperatureC"])
    if not readings:
        sys.exit(f"{args.app_csv}: no TEMPERATURE readings (was temperature logging enabled?)")
    dev_t, dev_v = [r[0] for r in readings], [r[1] for r in readings]
    thm_at_dev = [interpolate(thm_t, thm_v, t)[0] for t in dev_t]
    diff = [None if th is None else th - v for th, v in zip(thm_at_dev, dev_v)]
    matched = sum(d is not None for d in diff)
    if not matched:
        sys.exit(f"No time overlap: device {iso_utc(dev_t[0])}..{iso_utc(dev_t[-1])}, "
                 f"thermistor {iso_utc(thm_t[0])}..{iso_utc(thm_t[-1])}")

    # Clock check: both drifts must stay flat, and move together on the overlap.
    app_t = [int(r["UnixTimeMs"]) for r in app_rows]
    app_drift = drift_ms(app_t, [float(r["ElapsedMonotonicMs"]) for r in app_rows])
    thm_drift = drift_ms(thm_t, thm_e)
    gaps = [d - td for t, d in zip(app_t, app_drift)
            for td in [interpolate(thm_t, thm_drift, t)[0]] if td is not None]
    app_range = max(app_drift) - min(app_drift)
    thm_range = max(thm_drift) - min(thm_drift)
    agreement = max(gaps) - min(gaps) if gaps else None
    clock_ok = app_range <= CLOCK_STEP_WARN_MS and thm_range <= CLOCK_STEP_WARN_MS

    (lag_s, lag_r), r_zero = response_lag(dev_t, dev_v, thm_t, thm_v)

    session_start = next((int(r["UnixTimeMs"]) for r in app_rows if r["Event"] == "SESSION_START"),
                         app_t[0])
    session_end = next((int(r["UnixTimeMs"]) for r in app_rows if r["Event"] == "SESSION_END"
                        or r["Event"].startswith("SESSION_ABORTED")), app_t[-1])
    blocks = phase_blocks(app_rows)
    summary = [summarize(b, dev_t, dev_v, thm_t, thm_v, diff) for b in blocks]
    summary.append(summarize({"run": "", "condition": "", "block": "SESSION",
                              "start_ms": session_start, "end_ms": session_end},
                             dev_t, dev_v, thm_t, thm_v, diff))

    out_dir = args.out_dir or args.thermistor_csv.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{args.app_csv.stem}__{args.thermistor_csv.stem}"
    aligned_path = out_dir / f"aligned_{stem}.csv"
    phases_path = out_dir / f"phases_{stem}.csv"
    html_path = out_dir / f"aligned_{stem}.html"

    with open(aligned_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(fieldnames) + [
            "SessionTimeSec", "ThermistorTempC", "ThermistorNearestDtMs", "ThermistorMinusDeviceC"])
        writer.writeheader()
        for row in app_rows:
            t = int(row["UnixTimeMs"])
            thm, nearest = interpolate(thm_t, thm_v, t)
            device = float(row["TemperatureC"]) if row["TemperatureC"] else None
            writer.writerow({
                **row,
                "SessionTimeSec": fmt((t - session_start) / 1000, 3),
                "ThermistorTempC": fmt(thm),
                "ThermistorNearestDtMs": nearest,
                "ThermistorMinusDeviceC": fmt(thm - device) if row["Event"] == "TEMPERATURE"
                and thm is not None and device is not None else "",
            })

    with open(phases_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=PHASE_FIELDS)
        writer.writeheader()
        writer.writerows(summary)

    first = app_rows[0]
    clock_note = (
        f"Wall-clock-minus-monotonic drift stayed within {app_range:.0f} ms (app) and "
        f"{thm_range:.0f} ms (thermistor) and the two agreed within {agreement:.0f} ms, "
        "consistent with one unstepped computer clock, so no time offset was applied."
        if clock_ok and agreement is not None else
        f"WARNING: clock drift range {app_range:.0f} ms (app) / {thm_range:.0f} ms (thermistor) "
        "suggests the computer clock was adjusted during recording; check the join.")
    lag_note = (
        f"Highest correlation between the traces when the device is shifted {abs(lag_s)} s "
        f"{'later' if lag_s >= 0 else 'earlier'} (r = {lag_r:.3f}, vs {r_zero:.3f} at zero shift). "
        "That reflects how the sensors respond, not clock error, and is not applied.")
    payload = {
        "title": f"Device sensor vs thermistor probe, {first['ParticipantID']} / {first['SessionID']}",
        "subtitle": (f"Session {iso_utc(session_start)[:19].replace('T', ' ')} to "
                     f"{iso_utc(session_end)[11:19]} UTC, joined on each computer receive timestamp"),
        "notes": f"{clock_note} {lag_note}",
        "sessionStartMs": session_start,
        "thermistor": [[round((t - session_start) / 1000, 3), v] for t, v in zip(thm_t, thm_v)],
        "aligned": [[round((t - session_start) / 1000, 3), v, None if th is None else round(th, 3)]
                    for t, v, th in zip(dev_t, dev_v, thm_at_dev)],
        "blocks": [{"condition": b["condition"],
                    "short": b["condition"].replace(" NIR", "").replace(" Control", ""),
                    "block": b["block"],
                    "start": round((b["start_ms"] - session_start) / 1000, 3),
                    "end": round((b["end_ms"] - session_start) / 1000, 3)} for b in blocks],
        "summary": summary,
    }
    page = (HTML_TEMPLATE.replace("__TITLE__", html.escape(payload["title"]))
            .replace("__PAYLOAD__", json.dumps(payload, separators=(",", ":")).replace("</", "<\\/")))
    html_path.write_text(page)

    print(f"App export:     {args.app_csv.name}  ({len(dev_t)} device readings)")
    print(f"Thermistor log: {args.thermistor_csv.name}  ({len(thm_t)} readings)")
    print(f"Matched:        {matched}/{len(dev_t)} device readings have an interpolated thermistor value")
    print(f"Clock check:    {clock_note}")
    print(f"Response lag:   {lag_note}")
    print("\nBlock summary (device -> thermistor, C):")
    print(f"  {'run':<3} {'condition':<16} {'block':<7} {'dur s':>6}  {'device start>end (peak)':<24}"
          f"  {'thermistor start>end (peak)':<27}  {'mean diff':>9}  {'max diff':>8}")
    for s in summary:
        print(f"  {s['RunIndex']:<3} {s['Condition']:<16} {s['Block']:<7} {s['DurationSec']:>6}  "
              f"{s['DeviceStartC'] + '>' + s['DeviceEndC'] + ' (' + s['DevicePeakC'] + ')':<24}  "
              f"{s['ThermistorStartC'] + '>' + s['ThermistorEndC'] + ' (' + s['ThermistorPeakC'] + ')':<27}  "
              f"{s['MeanDiffC']:>9}  {s['MaxDiffC']:>8}")
    print(f"\nWrote:\n  {aligned_path}\n  {phases_path}\n  {html_path}")


HTML_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root {
  color-scheme: light dark;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11, 11, 11, 0.10);
  --device: #2a78d6; --thermistor: #eb6834; --diff: #52514e;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255, 255, 255, 0.10);
    --device: #3987e5; --thermistor: #d95926; --diff: #c3c2b7;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); padding: 24px 16px 40px;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; }
h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 15px; font-weight: 600; margin: 28px 0 8px; }
.sub, .notes { color: var(--ink-2); }
.sub { margin: 0 0 16px; }
.notes { font-size: 13px; margin: 12px 0 0; max-width: 88ch; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 10px; color: var(--ink-2); font-size: 13px; }
.key { display: inline-flex; align-items: center; gap: 6px; }
.key i { display: inline-block; width: 16px; height: 2px; border-radius: 1px; }
.key b { display: inline-block; width: 14px; height: 10px; border-radius: 2px; background: var(--grid); }
.k-device { background: var(--device); } .k-thermistor { background: var(--thermistor); } .k-diff { background: var(--diff); }
.panel-title { color: var(--ink-2); font-size: 12px; margin: 0; }
#chart { position: relative; }
#chart svg { display: block; outline: none; touch-action: pan-y; }
#chart svg:focus-visible { outline: 2px solid var(--device); outline-offset: 2px; border-radius: 4px; }
.grid { stroke: var(--grid); stroke-width: 1; shape-rendering: crispEdges; }
.axis { stroke: var(--axis); stroke-width: 1; shape-rendering: crispEdges; }
.band { fill: var(--grid); fill-opacity: 0.5; }
.tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.blk { fill: var(--ink-2); font-size: 12px; }
.phase { fill: var(--muted); font-size: 11px; }
.lbl { fill: var(--ink-2); font-size: 12px; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.s-device { stroke: var(--device); } .s-thermistor { stroke: var(--thermistor); } .s-diff { stroke: var(--diff); }
.dot { stroke: var(--surface); stroke-width: 2; }
.d-device { fill: var(--device); } .d-thermistor { fill: var(--thermistor); } .d-diff { fill: var(--diff); }
.cross { stroke: var(--ink-2); stroke-width: 1; }
#tip { position: absolute; top: 0; left: 0; pointer-events: none; background: var(--surface);
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12); white-space: nowrap; }
#tip .t { color: var(--ink-2); }
#tip .t + .t { margin-bottom: 4px; }
#tip .r { display: flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
#tip .r i { width: 12px; height: 2px; border-radius: 1px; flex: none; }
#tip .r b { min-width: 62px; text-align: right; color: var(--ink); font-weight: 600; }
#tip .r span { color: var(--ink-2); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; width: 100%; }
th, td { text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th:nth-child(-n+3), td:nth-child(-n+3) { text-align: left; }
th { color: var(--ink-2); font-weight: 600; }
tr.stim td { font-weight: 600; }
tr.session td { border-top: 1px solid var(--axis); }
</style>
</head>
<body>
<main>
  <h1 id="title"></h1>
  <p class="sub" id="subtitle"></p>
  <div class="card">
    <div class="legend">
      <span class="key"><i class="k-device"></i>Device DS18B20 (app log)</span>
      <span class="key"><i class="k-thermistor"></i>Thermistor probe</span>
      <span class="key"><i class="k-diff"></i>Thermistor minus device</span>
      <span class="key"><b></b>Stimulation on (EMG + RT)</span>
    </div>
    <p class="panel-title">Temperature, °C</p>
    <div id="chart"><div id="plot"></div><div id="tip" hidden></div></div>
    <p class="notes" id="notes"></p>
  </div>
  <h2>Per-block summary</h2>
  <div class="table-wrap"><table id="summary"></table></div>
</main>
<script>
const DATA = __PAYLOAD__;
const NS = "http://www.w3.org/2000/svg";
const plot = document.getElementById("plot");
const tip = document.getElementById("tip");
const A = DATA.aligned; // [session s, device C, thermistor C | null]
const TH = DATA.thermistor;
document.getElementById("title").textContent = DATA.title;
document.getElementById("subtitle").textContent = DATA.subtitle;
document.getElementById("notes").textContent = DATA.notes;

function svgEl(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}
function svgText(parent, x, y, str, cls, anchor) {
  const t = svgEl("text", { x, y, class: cls, "text-anchor": anchor || "start" }, parent);
  t.textContent = str;
  return t;
}
function ticks(lo, hi, step) {
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6 || 0);
  return out;
}
function pathD(points, x, y) {
  let d = "", prev = null;
  for (const [s, v] of points) {
    if (v === null) { prev = null; continue; }
    d += (prev !== null && s - prev <= 2.5 ? "L" : "M") + x(s).toFixed(1) + " " + y(v).toFixed(1);
    prev = s;
  }
  return d;
}
function peak(points) {
  let best = null;
  for (const p of points) if (p[1] !== null && (best === null || p[1] > best[1])) best = p;
  return best;
}
const signed = v => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
const clock = (ms, zone) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false, timeZone: zone });
const mmss = s => (s < 0 ? "−" : "") + Math.floor(Math.abs(s) / 60) + ":" + String(Math.floor(Math.abs(s) % 60)).padStart(2, "0");

const x0 = Math.min(0, TH[0][0], A[0][0]);
const x1 = Math.max(TH[TH.length - 1][0], A[A.length - 1][0]);
let tMin = Infinity, tMax = -Infinity, dMin = 0, dMax = 0;
for (const p of TH) { tMin = Math.min(tMin, p[1]); tMax = Math.max(tMax, p[1]); }
for (const r of A) {
  tMin = Math.min(tMin, r[1]); tMax = Math.max(tMax, r[1]);
  if (r[2] !== null) { dMin = Math.min(dMin, r[2] - r[1]); dMax = Math.max(dMax, r[2] - r[1]); }
}
const tLo = Math.floor(tMin / 5) * 5, tHi = Math.ceil(tMax / 5) * 5;
const dStep = dMax - dMin > 12 ? 5 : 2;
const dLo = Math.floor(dMin / dStep) * dStep, dHi = Math.max(Math.ceil(dMax / dStep) * dStep, dLo + dStep);
const DIFF = A.map(r => [r[0], r[2] === null ? null : r[2] - r[1]]);
let current = 0;

function blockAt(s) {
  return DATA.blocks.find(b => b.block !== "EMG+RT" && s >= b.start && s < b.end) || null;
}

function render() {
  const W = Math.max(300, plot.clientWidth);
  const narrow = W < 600;
  const M = { l: 40, r: 14, t: 36 };
  const topH = narrow ? 220 : 320, gap = 36, botH = narrow ? 96 : 130, axisH = 42;
  const bTop = M.t + topH + gap, axisY = bTop + botH, H = axisY + axisH;
  const x = s => M.l + (s - x0) / (x1 - x0) * (W - M.l - M.r);
  const yT = v => M.t + (tHi - v) / (tHi - tLo) * topH;
  const yB = v => bTop + (dHi - v) / (dHi - dLo) * botH;
  plot.textContent = "";
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: 0, role: "img",
    "aria-label": "Device and thermistor temperature over the session, with their difference below. Arrow keys step through readings." }, plot);

  for (const b of DATA.blocks) {
    const bx = x(b.start), bw = Math.max(0, x(b.end) - x(b.start));
    if (b.block === "EMG+RT") {
      svgEl("rect", { x: bx, y: M.t, width: bw, height: topH, class: "band" }, svg);
      svgEl("rect", { x: bx, y: bTop, width: bw, height: botH, class: "band" }, svg);
      svgText(svg, bx + bw / 2, M.t - 20, bw < 110 ? b.short : b.condition, "blk", "middle");
      continue;
    }
    if (b.block === "RT") {
      svgEl("line", { x1: bx, x2: bx, y1: M.t, y2: M.t + topH, class: "axis" }, svg);
      svgEl("line", { x1: bx, x2: bx, y1: bTop, y2: axisY, class: "axis" }, svg);
    }
    if (bw > 30) svgText(svg, bx + bw / 2, M.t - 6, b.block === "REST" ? "rest" : b.block, "phase", "middle");
  }

  for (const v of ticks(tLo, tHi, 5)) {
    svgEl("line", { x1: M.l, x2: W - M.r, y1: yT(v), y2: yT(v), class: v === tLo ? "axis" : "grid" }, svg);
    svgText(svg, M.l - 6, yT(v) + 4, String(v), "tick", "end");
  }
  svgText(svg, M.l, bTop - 12, "Thermistor minus device, °C", "lbl");
  for (const v of ticks(dLo, dHi, dStep)) {
    svgEl("line", { x1: M.l, x2: W - M.r, y1: yB(v), y2: yB(v), class: v === 0 ? "axis" : "grid" }, svg);
    svgText(svg, M.l - 6, yB(v) + 4, v > 0 ? "+" + v : String(v).replace("-", "−"), "tick", "end");
  }
  svgEl("line", { x1: M.l, x2: W - M.r, y1: axisY, y2: axisY, class: "axis" }, svg);
  for (const m of ticks(x0 / 60, x1 / 60, narrow ? 10 : 5)) svgText(svg, x(m * 60), axisY + 16, String(m), "tick", "middle");
  svgText(svg, W - M.r, axisY + 34, "minutes from session start", "tick", "end");

  svgEl("path", { d: pathD(TH, x, yT), class: "line s-thermistor" }, svg);
  svgEl("path", { d: pathD(A, x, yT), class: "line s-device" }, svg);
  svgEl("path", { d: pathD(DIFF, x, yB), class: "line s-diff" }, svg);

  for (const [p, cls, name] of [[peak(TH), "thermistor", "Thermistor peak"], [peak(A), "device", "Device peak"]]) {
    const cx = x(p[0]), cy = yT(p[1]);
    svgEl("circle", { cx, cy, r: 4, class: "dot d-" + cls }, svg);
    const left = cx > W * 0.6;
    svgText(svg, cx + (left ? 4 : -4), cy - 10, `${name} ${p[1].toFixed(2)} °C`, "lbl", left ? "end" : "start");
  }

  const cross = svgEl("line", { y1: M.t, y2: axisY, class: "cross", visibility: "hidden" }, svg);
  const dots = ["device", "thermistor", "diff"].map(c => svgEl("circle", { r: 4, class: "dot d-" + c, visibility: "hidden" }, svg));
  const hit = svgEl("rect", { x: M.l, y: M.t, width: W - M.l - M.r, height: axisY - M.t, fill: "transparent" }, svg);

  function place(dot, cx, cy) {
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", cy);
    dot.setAttribute("visibility", cy === null ? "hidden" : "visible");
  }
  function show(i) {
    current = i;
    const [s, dev, thm] = A[i];
    const cx = x(s);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    place(dots[0], cx, yT(dev));
    place(dots[1], cx, thm === null ? null : yT(thm));
    place(dots[2], cx, thm === null ? null : yB(thm - dev));

    const ms = DATA.sessionStartMs + s * 1000;
    const b = blockAt(s);
    tip.textContent = "";
    const line = (cls, str) => { const d = document.createElement("div"); d.className = cls; d.textContent = str; tip.append(d); };
    line("t", `${clock(ms)} local · ${clock(ms, "UTC")} UTC · ${mmss(s)} into session`);
    line("t", b ? `${b.condition} · ${b.block === "REST" ? "rest" : b.block}` : "Outside logged phases");
    for (const [cls, value, label] of [["device", dev.toFixed(2) + " °C", "Device"],
      ["thermistor", thm === null ? "n/a" : thm.toFixed(2) + " °C", "Thermistor"],
      ["diff", thm === null ? "n/a" : signed(thm - dev) + " °C", "Difference"]]) {
      const row = document.createElement("div"); row.className = "r";
      const key = document.createElement("i"); key.className = "k-" + cls;
      const val = document.createElement("b"); val.textContent = value;
      const lab = document.createElement("span"); lab.textContent = label;
      row.append(key, val, lab); tip.append(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = (cx + 14 + tw > W ? Math.max(0, cx - 14 - tw) : cx + 14) + "px";
    tip.style.top = (M.t + 6) + "px";
  }
  function hide() {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
    dots.forEach(d => d.setAttribute("visibility", "hidden"));
  }
  function nearest(s) {
    let lo = 0, hi = A.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (A[mid][0] < s) lo = mid; else hi = mid; }
    return Math.abs(A[lo][0] - s) <= Math.abs(A[hi][0] - s) ? lo : hi;
  }
  hit.addEventListener("pointermove", e => {
    const px = e.clientX - svg.getBoundingClientRect().left;
    show(nearest(x0 + (px - M.l) / (W - M.l - M.r) * (x1 - x0)));
  });
  hit.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(current));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", e => {
    const step = e.shiftKey ? 60 : 1;
    if (e.key === "ArrowRight") { show(Math.min(A.length - 1, current + step)); e.preventDefault(); }
    if (e.key === "ArrowLeft") { show(Math.max(0, current - step)); e.preventDefault(); }
  });
}

function renderTable() {
  const cols = [["RunIndex", "Run"], ["Condition", "Condition"], ["Block", "Block"], ["StartUTC", "Start UTC"],
    ["DurationSec", "Duration s"], ["DeviceStartC", "Device start"], ["DeviceEndC", "Device end"],
    ["DevicePeakC", "Device peak"], ["DeviceRiseC", "Device rise"], ["ThermistorStartC", "Thermistor start"],
    ["ThermistorEndC", "Thermistor end"], ["ThermistorPeakC", "Thermistor peak"],
    ["ThermistorRiseC", "Thermistor rise"], ["MeanDiffC", "Mean diff"], ["MaxDiffC", "Max diff"]];
  const signedCols = new Set(["DeviceRiseC", "ThermistorRiseC", "MeanDiffC", "MaxDiffC"]);
  const table = document.getElementById("summary");
  const head = table.createTHead().insertRow();
  for (const [, label] of cols) { const th = document.createElement("th"); th.textContent = label; head.append(th); }
  const body = table.createTBody();
  for (const row of DATA.summary) {
    const tr = body.insertRow();
    if (row.Block === "EMG+RT") tr.className = "stim";
    if (row.Block === "SESSION") tr.className = "session";
    for (const [key] of cols) {
      let v = String(row[key]);
      if (key === "StartUTC") v = v.slice(11, 19);
      else if (signedCols.has(key) && v !== "") v = signed(Number(v));
      tr.insertCell().textContent = v;
    }
  }
}

renderTable();
render();
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 80); }).observe(plot);
</script>
</body>
</html>
"""


if __name__ == "__main__":
    main()
