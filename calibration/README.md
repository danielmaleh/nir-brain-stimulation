# Thermal calibration (heating-control matching)

The heating-control condition exists to reproduce the **warmth** of the NIR
stimulation without the light, so any behavioural/EEG difference reflects the
photobiomodulation rather than the heat. This tool measures that warmth once and
stores it; the experiment then drives the heater to the matched temperature.

## What it does

`calibrate_thermal.py` runs the 10 Hz and 40 Hz NIR conditions on the device for
one stimulation block of the protocol (150 s; `--duration 150`), records the DS18B20 contact temperature,
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
#   --duration 150                stimulation seconds per condition (one 2.5-min protocol block)
#   --plateau-window 10           trailing window used for the plateau
#   --cooldown 15                 post-stimulation recording
```

It prints the per-condition baseline/plateau and the final heating-control
target, then writes both JSON files. **Commit them** so the value persists:

```
git add calibration/thermal_profile.json APP/thermal_profile.json && git commit -m "Calibrate thermal profile"
```

## How it's used in a session

During a **Heating Control** run the task page replays, on the device sensor,
the device-temperature trajectory recorded during the same participant's NIR
runs earlier in the session (an `H<temp>` target every 5 s; the firmware tracks
it with a feedforward + PI controller under a 20 % duty cap). This profile is
only the **fallback** when Heating is drawn as the first condition and nothing
has been recorded yet: then the page sends baseline + `heating_rise_c`. The
committed profile is from a 40-s July run (`heating_rise_c` 0.74 °C) and
under-represents a 2.5-min block — re-run the calibration with `--duration 150`
and commit both copies. The thermal cutoff always applies (estimated skin
surface 37 °C, raw 40 °C backstop), and the set point is clamped below it.
