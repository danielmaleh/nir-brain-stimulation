# Thermal calibration (heating-control matching)

The heating-control condition exists to reproduce the **warmth** of the NIR
stimulation without the light, so any behavioural/EEG difference reflects the
photobiomodulation rather than the heat. This tool measures that warmth once and
stores it; the experiment then drives the heater to the matched temperature.

## What it does

`calibrate_thermal.py` runs the 10 Hz and 40 Hz NIR conditions on the device for
the experiment's run duration (40 s), records the DS18B20 contact temperature,
and computes the **plateau temperature** each reached (mean of the last 10 s).
The heating-control set point is stored as the **average** of the two plateaus
(they should be nearly equal, since both run at 50 % duty cycle / equal average
optical power).

Output (two identical copies, both committed so the calibration persists):
- `calibration/thermal_profile.json` — canonical record (full temperature series + metadata)
- `APP/thermal_profile.json` — the copy the task page loads at runtime

## Prerequisites

- The **main firmware** flashed on the board (uses `M`/`G`/`X` and the `TEMP_LOG`
  stream, and the `H<temp>` set-point command for playback).
- A **stable, representative contact setup** (tissue phantom or a fixed mounting)
  with the DS18B20 in the same position it occupies during a session. Calibrate
  once here — do **not** recalibrate per participant.
- `pip install -r calibration/requirements.txt` (pyserial).

## Run it

```
python calibration/calibrate_thermal.py           # auto-detects the Arduino port
# options:
#   --port /dev/cu.usbmodemXXXX   (or COMx on Windows)
#   --duration 40                 stimulation seconds per condition
#   --plateau-window 10           trailing window used for the plateau
#   --cooldown 15                 post-stimulation recording
```

It prints the per-condition baseline/plateau and the final heating-control
target, then writes both JSON files. **Commit them** so the value persists:

```
git add calibration/thermal_profile.json APP/thermal_profile.json && git commit -m "Calibrate thermal profile"
```

## How it's used in a session

When the task page runs the **Heating Control** condition, it reads
`APP/thermal_profile.json` and sends the matched set point to the firmware
(`H<temp>`), so the heater thermostat regulates to the NIR-matched temperature
instead of the default 37.5 °C. If the profile is uncalibrated or missing, the
firmware falls back to 37.5 °C (and the task page logs a warning). The 40 °C
latching safety cutoff always applies, and the set point is clamped below it.
