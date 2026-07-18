#!/usr/bin/env python3
"""
Thermal calibration for the heating-control condition.

The heating-control condition must reproduce the skin-contact warmth that the
NIR stimulation produces, so that any behavioural/EEG difference reflects the
light rather than the heat. This tool measures that warmth: it runs the 10 Hz
and 40 Hz NIR conditions on the device for the experiment's run duration, records
the DS18B20 temperature, and stores the plateau temperature each reached. The
experiment task then drives the heater to that matched set point (via the
firmware 'H<temp>' command).

It writes two copies of the result (kept identical):
  * calibration/thermal_profile.json  - canonical record (full series + metadata)
  * APP/thermal_profile.json          - the copy the browser loads (same content)

Run it ONCE on a stable phantom/skin setup; the profile persists in the repo and
is reused every session. Re-run only if the optics, contact, or geometry change.

Requires the MAIN firmware flashed (uses its M/G/X commands and TEMP_LOG stream).
Usage:
    python calibration/calibrate_thermal.py [--port /dev/cu.usbmodemXXXX]
                                            [--duration 40] [--plateau-window 10]
                                            [--cooldown 15]
"""
import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("ERROR: pyserial is required.  pip install pyserial")

BAUD = 115200
ARDUINO_VID = 0x2341  # genuine Arduino USB vendor id
COND = {"10Hz": 1, "40Hz": 2}  # firmware StimCondition indices

REPO_ROOT = Path(__file__).resolve().parent.parent
CANONICAL_OUT = REPO_ROOT / "calibration" / "thermal_profile.json"
BROWSER_OUT = REPO_ROOT / "APP" / "thermal_profile.json"


def find_port(explicit):
    if explicit:
        return explicit
    ports = list(list_ports.comports())
    for p in ports:
        if getattr(p, "vid", None) == ARDUINO_VID:
            return p.device
    if ports:
        print("[calib] No genuine-Arduino VID found; using first serial port:", ports[0].device)
        return ports[0].device
    sys.exit("ERROR: no serial ports found. Pass --port explicitly.")


def parse_temp(line):
    """Return the temperature from a '<us>,TEMP_LOG,<temp>,<cond>' line, else None."""
    parts = line.split(",")
    if len(parts) >= 3 and parts[1].strip() == "TEMP_LOG":
        try:
            return float(parts[2])
        except ValueError:
            return None
    return None


def parse_mode(line):
    parts = line.split(",")
    if len(parts) >= 3 and parts[1].strip() == "MODE_SELECT":
        try:
            return int(parts[2])
        except ValueError:
            return None
    return None


def drain_and_watch(ser, seconds, on_temp=None):
    """Read serial for `seconds`, forwarding temperatures to on_temp(t, temp)."""
    t0 = time.time()
    while time.time() - t0 < seconds:
        raw = ser.readline().decode("ascii", "replace").strip()
        if not raw:
            continue
        if "No temperature sensor" in raw or ",SAFETY_TRIP," in raw:
            sys.exit("ERROR: device reported a sensor fault / safety trip during calibration:\n  " + raw)
        temp = parse_temp(raw)
        if temp is not None and on_temp:
            on_temp(time.time() - t0, temp)


def send(ser, s):
    ser.write(s.encode("ascii"))
    ser.flush()


def select_condition(ser, target_idx):
    """Cycle the firmware mode until MODE_SELECT reports target_idx (device must be IDLE)."""
    send(ser, "x")          # ensure IDLE
    time.sleep(0.3)
    ser.reset_input_buffer()
    for _ in range(6):
        # peek current condition by cycling once and reading the MODE_SELECT echo
        send(ser, "m")
        t0 = time.time()
        current = None
        while time.time() - t0 < 1.0:
            raw = ser.readline().decode("ascii", "replace").strip()
            m = parse_mode(raw)
            if m is not None:
                current = m
                break
        if current == target_idx:
            return True
    return False


def run_condition(ser, name, duration, cooldown):
    """Select `name`, stimulate for `duration` s recording temp, then cool down."""
    idx = COND[name]
    print(f"[calib] --- {name} ---")
    if not select_condition(ser, idx):
        sys.exit(f"ERROR: could not select condition {name} on the device.")
    print(f"[calib] selected {name}; recording baseline...")

    series = []  # list of {t, temp}, t seconds from stimulation start
    baseline = []
    drain_and_watch(ser, 4, on_temp=lambda t, temp: baseline.append(temp))
    base_temp = sum(baseline) / len(baseline) if baseline else None

    print(f"[calib] starting {name} stimulation for {duration}s...")
    ser.reset_input_buffer()
    send(ser, "g")  # start stimulation
    drain_and_watch(ser, duration, on_temp=lambda t, temp: series.append({"t": round(t, 2), "temp": temp}))
    send(ser, "x")  # stop
    print(f"[calib] {name} done; recording {cooldown}s cooldown...")
    drain_and_watch(ser, cooldown,
                    on_temp=lambda t, temp: series.append({"t": round(duration + t, 2), "temp": temp}))
    return base_temp, series


def plateau_of(series, duration, window):
    """Mean temperature over the last `window` s of the stimulation phase."""
    pts = [p["temp"] for p in series if (duration - window) <= p["t"] <= duration]
    if not pts:
        pts = [p["temp"] for p in series if p["t"] <= duration] or [p["temp"] for p in series]
    return sum(pts) / len(pts)


def main():
    ap = argparse.ArgumentParser(description="Thermal calibration for the heating-control condition.")
    ap.add_argument("--port", default=None, help="serial port (auto-detected if omitted)")
    ap.add_argument("--duration", type=float, default=40.0, help="stimulation duration per condition (s)")
    ap.add_argument("--plateau-window", type=float, default=10.0, help="trailing window used for the plateau (s)")
    ap.add_argument("--cooldown", type=float, default=15.0, help="post-stimulation recording (s)")
    args = ap.parse_args()

    port = find_port(args.port)
    print(f"[calib] opening {port} @ {BAUD}...")
    ser = serial.Serial(port, BAUD, timeout=1)
    ser.reset_input_buffer()
    time.sleep(2.5)  # let the Uno finish resetting/booting after the port opens
    ser.reset_input_buffer()

    profile = {"conditions": {}}
    for name in ("10Hz", "40Hz"):
        base_temp, series = run_condition(ser, name, args.duration, args.cooldown)
        plateau = plateau_of(series, args.duration, args.plateau_window)
        profile["conditions"][name] = {
            "baseline_c": round(base_temp, 3) if base_temp is not None else None,
            "plateau_c": round(plateau, 3),
            "series": series,
        }
        print(f"[calib] {name}: baseline={base_temp:.2f} C  plateau={plateau:.2f} C")
        # brief settle so the next condition starts from a comparable baseline
        drain_and_watch(ser, 5)

    ser.close()

    p10 = profile["conditions"]["10Hz"]["plateau_c"]
    p40 = profile["conditions"]["40Hz"]["plateau_c"]
    heating_target = round((p10 + p40) / 2.0, 2)
    if abs(p10 - p40) > 1.0:
        print(f"[calib] WARNING: 10 Hz and 40 Hz plateaus differ by {abs(p10 - p40):.2f} C "
              "(expected ~equal at 50% duty). Check contact/geometry before trusting this.")

    profile.update({
        "schema": "tpbm-thermal-profile/1",
        "calibrated": True,
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "port": port,
        "run_duration_s": args.duration,
        "plateau_window_s": args.plateau_window,
        # The single set point the heating-control condition targets (avg of both NIR freqs).
        "heating_target_c": heating_target,
    })

    for out in (CANONICAL_OUT, BROWSER_OUT):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(profile, indent=2))
    print(f"\n[calib] DONE. Heating-control target = {heating_target:.2f} C "
          f"(10Hz {p10:.2f} / 40Hz {p40:.2f}).")
    print(f"[calib] wrote {CANONICAL_OUT}")
    print(f"[calib] wrote {BROWSER_OUT}")
    print("[calib] Commit these so the calibration persists across sessions.")


if __name__ == "__main__":
    main()
