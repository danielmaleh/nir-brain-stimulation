#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""Render a static figure (PNG, PDF, SVG) from an aligned thermistor/device table.

The HTML written by align_thermistor.py is for reading on screen; this is the
version to drop into a slide or a paper. uv fetches matplotlib on demand:

    uv run analysis/thermal/plot_aligned.py ALIGNED_CSV [--thermistor THERMISTOR_CSV]
        [--out-dir DIR]

Passing the thermistor log adds its trace before and after the session and
enables the response-lag figure in the subtitle.
"""

import argparse
import csv
import datetime as dt
import math
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from matplotlib.transforms import blended_transform_factory

sys.path.insert(0, str(Path(__file__).resolve().parent))
from align_thermistor import load_thermistor, phase_blocks, response_lag  # noqa: E402

DEVICE, THERMISTOR, DIFF = "#2a78d6", "#eb6834", "#52514e"
GRID, AXIS, MUTED, INK, INK2, SURFACE = "#e1e0d9", "#c3c2b7", "#898781", "#0b0b0b", "#52514e", "#fcfcfb"
NAN = float("nan")


def style(ax):
    ax.set_facecolor(SURFACE)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(AXIS)
        ax.spines[side].set_linewidth(0.8)
    ax.tick_params(colors=MUTED, labelsize=9, length=0)


def limits(values, step):
    lo = math.floor(min(values) / step) * step
    hi = math.ceil(max(values) / step) * step
    return lo, hi if hi > lo else lo + step


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("aligned_csv", type=Path, help="aligned_*.csv from align_thermistor.py")
    parser.add_argument("--thermistor", type=Path, help="the thermistor log, for the pre/post tails")
    parser.add_argument("--out-dir", type=Path, help="default: the aligned table's folder")
    args = parser.parse_args()

    with open(args.aligned_csv, newline="") as f:
        rows = list(csv.DictReader(f))
    temps = [r for r in rows if r["Event"] == "TEMPERATURE" and r["TemperatureC"]]
    if not temps:
        sys.exit(f"{args.aligned_csv}: no device readings")
    start_ms = int(next((r["UnixTimeMs"] for r in rows if r["Event"] == "SESSION_START"), rows[0]["UnixTimeMs"]))
    minutes = lambda ms: (ms - start_ms) / 60000

    t = [float(r["SessionTimeSec"]) / 60 for r in temps]
    dev = [float(r["TemperatureC"]) for r in temps]
    thm = [float(r["ThermistorTempC"]) if r["ThermistorTempC"] else NAN for r in temps]
    diff = [b - a for a, b in zip(dev, thm)]

    lag_note = ""
    thm_t, thm_v = t, thm
    if args.thermistor:
        raw_ms, raw_v, _ = load_thermistor(args.thermistor)
        thm_t = [minutes(ms) for ms in raw_ms]
        thm_v = raw_v
        (lag_s, lag_r), _ = response_lag([int(r["UnixTimeMs"]) for r in temps], dev, raw_ms, raw_v)
        lag_note = f"; device lags by {lag_s} s (r = {lag_r:.2f})"

    dev_peak = max(range(len(dev)), key=dev.__getitem__)
    thm_peak = max(range(len(thm_v)), key=lambda i: thm_v[i])
    first = temps[0]
    date = dt.datetime.fromisoformat(first["TimestampUTC"].replace("Z", "+00:00")).strftime("%d %b %Y")

    fig, (ax1, ax2) = plt.subplots(
        2, 1, sharex=True, figsize=(10, 6.4), dpi=300,
        gridspec_kw={"height_ratios": [2.6, 1], "hspace": 0.18})
    fig.patch.set_facecolor(SURFACE)
    for ax in (ax1, ax2):
        style(ax)

    blocks = phase_blocks(rows)
    span = blended_transform_factory(ax1.transData, ax1.transAxes)
    for b in blocks:
        a, z = minutes(b["start_ms"]), minutes(b["end_ms"])
        if b["block"] == "EMG+RT":
            for ax in (ax1, ax2):
                ax.axvspan(a, z, color=GRID, alpha=0.55, linewidth=0, zorder=0)
            ax1.text((a + z) / 2, 1.03, b["condition"], transform=span,
                     ha="center", va="bottom", fontsize=9, color=INK2)
        else:
            if b["block"] == "RT":
                for ax in (ax1, ax2):
                    ax.axvline(a, color=AXIS, linewidth=0.8, zorder=1)
            ax1.text((a + z) / 2, 0.97, "rest" if b["block"] == "REST" else b["block"],
                     transform=span, ha="center", va="top", fontsize=8, color=MUTED)

    ax1.plot(thm_t, thm_v, color=THERMISTOR, linewidth=1.8, solid_joinstyle="round",
             label="Thermistor probe", zorder=3)
    ax1.plot(t, dev, color=DEVICE, linewidth=1.8, solid_joinstyle="round",
             label="Device DS18B20 (app log)", zorder=3)
    for xs, ys, colour in ((thm_t[thm_peak], thm_v[thm_peak], THERMISTOR), (t[dev_peak], dev[dev_peak], DEVICE)):
        ax1.plot([xs], [ys], marker="o", markersize=5, markerfacecolor=colour,
                 markeredgecolor=SURFACE, markeredgewidth=1.5, zorder=4)
    ax2.plot(t, diff, color=DIFF, linewidth=1.6, zorder=3)
    ax2.axhline(0, color=AXIS, linewidth=0.8, zorder=2)

    ax1.set_ylim(*limits([v for v in dev + list(thm_v) if v == v], 5))
    ax2.set_ylim(*limits([0] + [v for v in diff if v == v], 2))
    ax1.set_xlim(min(min(t), min(thm_t)), max(max(t), max(thm_t)))
    ax1.set_ylabel("Temperature (°C)", fontsize=9, color=INK2)
    ax2.set_ylabel("Thermistor − device (°C)", fontsize=9, color=INK2)
    ax2.set_xlabel("Minutes from session start", fontsize=9, color=INK2)
    handles = [*ax1.get_legend_handles_labels()[0],
               Patch(facecolor=GRID, alpha=0.55, label="Stimulation on (EMG + RT)")]
    legend = ax1.legend(handles=handles, loc="lower right", fontsize=9, frameon=True,
                        facecolor=SURFACE, edgecolor="none", framealpha=0.85)
    for text in legend.get_texts():
        text.set_color(INK2)

    fig.text(0.015, 0.975, f"Device sensor vs thermistor probe — {first['ParticipantID']} / "
             f"{first['SessionID']}, {date}", fontsize=12, color=INK, va="top")
    fig.text(0.015, 0.935, f"Aligned on computer receive time (UTC). Peaks: thermistor "
             f"{thm_v[thm_peak]:.1f} °C, device {dev[dev_peak]:.1f} °C{lag_note}.",
             fontsize=9, color=INK2, va="top")
    fig.subplots_adjust(left=0.07, right=0.985, top=0.86, bottom=0.09)

    out_dir = args.out_dir or args.aligned_csv.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.aligned_csv.stem.replace("aligned_", "plot_", 1)
    written = []
    for suffix in ("png", "pdf", "svg"):
        path = out_dir / f"{stem}.{suffix}"
        fig.savefig(path, facecolor=SURFACE)
        written.append(path)
    print("Wrote:\n  " + "\n  ".join(str(p) for p in written))


if __name__ == "__main__":
    main()
