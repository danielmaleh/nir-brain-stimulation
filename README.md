# Transcranial Photobiomodulation (tPBM) — NIR Brain Stimulation Device

An open, low-cost apparatus for delivering **pulsed 850 nm near-infrared light to the scalp** and recording its effect on cortical activity and motor performance. This repository contains everything needed to rebuild the device and run the protocol: Arduino firmware, a browser-based experiment application, an EEG marker bridge, and the calibration and bring-up procedures.

Built at EPFL for a within-subject study in healthy adults comparing **10 Hz NIR**, **40 Hz NIR**, and a **heating-only control**, with continuous EEG, wrist EMG, and an auditory reaction-time task.

---

## What the system is

Three components, each in its own directory, joined over USB serial and a localhost WebSocket:

```
   ┌──────────────────┐   Web Serial    ┌─────────────────┐   D9 ─► NIR LED strip (850 nm)
   │  Browser app     │◄───────────────►│  Arduino Uno    │   D10 ─► heater element
   │  APP/index.html  │   115200 bps    │  firmware/main  │   D2  ◄─ DS18B20 skin temp
   └────────┬─────────┘                 └─────────────────┘
            │ ws://127.0.0.1:3535
            ▼
   ┌──────────────────┐    LSL (~1 ms)   ┌─────────────────┐
   │  lsl_bridge.py   │─────────────────►│  NIC2 / Enobio  │──► EEG + EMG recording
   │ "tPBM-Markers"   │                  │                 │    with markers inside
   └──────────────────┘                  └─────────────────┘
```

- **`firmware/`** — generates the pulse train on a Timer1 compare interrupt (jitter-free 10.00 / 40.00 Hz), runs a PID thermostat for the heating control, polls skin temperature every 200 ms, and latches a hard cut-off at 40 °C.
- **`APP/`** — runs the participant task in Chrome, drives the device over Web Serial, captures keypresses with `performance.now()`, and logs every trial to `localStorage` with CSV export.
- **`lsl_bridge/`** — translates browser events into numeric LSL markers so NIC2 writes them directly into the EEG file on a shared clock.

The device works standalone over USB; no laptop-side runtime is required beyond a browser.

---

## Study design

| | |
|---|---|
| **Participants** | 20 healthy adults, one session each |
| **Design** | Within-subject; the three conditions run in a per-participant randomised order |
| **Conditions** | `Heating Control` · `10 Hz NIR` · `40 Hz NIR` |
| **Per condition** | 17 min — a 10-min silent EMG-baseline phase, then a 7-min reaction-time phase. Stimulation is on throughout both phases. |
| **Rest between conditions** | Configurable, default 3 min |
| **Total in-protocol time** | ~57 min per participant, plus EEG capping and setup |
| **Measures** | Continuous EEG (Enobio 32 via NIC2), wrist EMG on EXG channels, auditory reaction time |

### Reaction-time task

A 600 Hz sine tone (10 ms attack, 150 ms decay, generated in the Web Audio API) is presented **5.0 s + a random [0, 2.0] s jitter** after the previous response. The participant presses the spacebar. Each tone opens a **2.0 s response window**; no press is logged as an `OMISSION` and the run continues. A press *before* the tone is a `FALSE_ALARM` and resets the timer. Reaction time is anchored to the *audible* tone onset, not the scheduling call.

---

## Light dose and safety

| Parameter | Value |
|---|---|
| Wavelength | 850 nm |
| Pulse frequencies | 10.00 Hz and 40.00 Hz (Timer1 CTC, prescaler 64) |
| Duty cycle | 50 % |
| Illumination area | ~4 cm² |
| Exposure per condition | 17 min (1020 s) continuous |
| Skin-contact temperature | Hard latching cut-off at **40.0 °C** |
| Heating-control set point | 37.5 °C default, PID-regulated, heater duty capped at 20 % |

> **Before running participants, measure the delivered irradiance at the scalp with a calibrated power meter** and compute the per-condition fluence as `irradiance × 1020 s`. Confirm the result against your ethics-approved dose and the published tPBM window (0.3–3 J/cm² useful range, ~5–100 mW/cm² irradiance — see References). Do not infer the dose from the drive current.

Non-negotiable safety properties, all enforced in firmware and verified by `firmware/safety_test/`:

- Skin temperature never exceeds 40 °C — the cut-off **latches** and de-energises both channels; it only resets once the real temperature is back below 40 °C.
- A disconnected or faulty DS18B20 (reading −127 °C, or three consecutive 85 °C power-on values) latches a trip rather than failing open.
- The heater target is clamped to stay at least 1 °C below the cut-off, whatever value is commanded.
- Every pulse and temperature reading is timestamped and logged over USB serial.

**Blinding.** NIR at 850 nm is invisible, which is what makes the heating control meaningful. The mode-indicator LEDs are held **off** during active stimulation, and the participant-facing screen is deliberately plain. Do not add visible indicators that activate during a NIR condition.

---

## Repository layout

| Path | Contents |
|---|---|
| `firmware/main/` | Experiment controller — pulse generation, PID heating, safety latch, serial command interface |
| `firmware/io_test/` | Pin-by-pin wiring verification sketch |
| `firmware/safety_test/` | 40 °C cut-off proof — the go/no-go gate before any participant |
| `firmware/onewire_scan/` | DS18B20 bus scanner for diagnosing an undetected sensor |
| `firmware/*/pins.h` | Single source of truth for pin assignments |
| `APP/index.html`, `app.js` | Participant task + researcher dashboard |
| `APP/arduino.html`, `arduino.js` | Hardware dashboard — telemetry, manual control, safety state |
| `APP/io_test.html`, `wiring_check.html` | Bench diagnostics and the interactive wiring checklist |
| `APP/arduino_link.js`, `lsl_markers.js`, `serial_lock.js` | Web Serial link, marker client, cross-tab port arbitration |
| `lsl_bridge/` | WebSocket → LSL marker bridge and its self-test |
| `calibration/` | Thermal calibration script that matches the heating control to NIR warming |
| `hardware/` | Wiring documentation |
| `analysis/` | `trigger_codes.csv` codebook; `behavior/`, `eeg/`, `emg/` for analysis scripts |
| `docs/` | Marker integration guide, methods text, testing and validation procedures |

---

## Reproducing the setup

### 1. Build the hardware

You need an Arduino Uno, an 850 nm SMD2835 LED strip segment, a heater element, a DS18B20 with a 4.7 kΩ pull-up, logic-level MOSFET driver modules, and the supplies for each load.

Work through **`APP/wiring_check.html`** — open it in any browser (no device connection needed) and follow the interactive schematic. It groups the build into three passes: continuity, voltage, then functional. It reflects the current low-side MOSFET topology.

> `hardware/wiring_guide.md` documents an earlier TB6612FNG-based build of the same pin map. The Arduino pin assignments are identical either way; the driver hardware differs. Confirm which one you are building before wiring.

Two things that will bite you: **common ground is mandatory** (the supply negatives, driver grounds, and Arduino GND must all tie together, or the channels never switch), and the **4.7 kΩ pull-up on the 1-Wire data line** is not optional — without it the sensor reads −127 °C and the firmware trips at startup.

### 2. Flash and validate, in order

Install the `OneWire` and `DallasTemperature` libraries, then run the bring-up ladder. Do not skip ahead:

1. **`firmware/io_test/`** — open a serial monitor at 115200 baud (or `APP/io_test.html`). Send `A` and `B` to confirm the NIR and heater channels switch, `T` for a sane temperature, `C` to cycle all four indicator LEDs.
2. **`firmware/safety_test/`** — the safety gate. `H` / `L` toggle the loads, `S` simulates a 41.5 °C spike. **All outputs must cut off and stay off.** `R` must refuse to reset until the real temperature is under 40 °C.
3. **`firmware/main/`** — the full controller. Confirm a steady `PULSE,1` / `PULSE,0` cadence with no `PULSE_DROPPED` lines, and verify 10 Hz and 40 Hz on a scope or photodiode (±0.5 Hz tolerance).

`main` accepts single-letter commands over serial: `M` cycle mode, `G` start, `X` abort, `S` simulate over-temperature, `R` reset the safety latch, `H<temp>` set the heating target (e.g. `H38.25`).

### 3. Install the software

```bash
# LSL marker bridge (needs the native liblsl; bundled on most installs)
pip install -r lsl_bridge/requirements.txt

# Thermal calibration
pip install -r calibration/requirements.txt

# Serve the app — Web Serial requires a real origin, not file://
python -m http.server 8000     # then open http://localhost:8000/APP/
```

Chrome or Edge is required — the app depends on Web Serial and BroadcastChannel, which Firefox and Safari do not implement.

### 4. Calibrate the heating control

The heating control only works as a control if it warms the skin *the same amount* the NIR does. `calibration/calibrate_thermal.py` measures the plateau temperature reached under each condition and writes the matched set point to `thermal_profile.json`:

```bash
python calibration/calibrate_thermal.py --port /dev/cu.usbmodemXXXX
```

This is a **per-device** calibration, not a per-participant one — run it once for a given physical build, and again after any change to the LED segment, heater, or sensor placement. See `calibration/README.md`.

### 5. Run a session

Order matters. The marker outlet must exist before NIC2 starts looking for it:

1. Start the bridge: `python lsl_bridge/lsl_bridge.py` — wait for `LSL Markers outlet 'tPBM-Markers' is live`.
2. In NIC2, enable LSL and point the marker inlet at **`tPBM-Markers`** (case-sensitive, exact match).
3. Start the NIC2 recording.
4. Open `APP/index.html` in Chrome, connect to the device, enter the participant ID, and start. The condition order is randomised automatically.
5. Stop the NIC2 recording at the end, then export the behavioural CSV from the app.

Full per-session detail, including Windows-specific pitfalls (COM-port exclusivity, Chrome's Memory Saver discarding the tab mid-session), is in **`SETUP.md`**. Run one full dry run before your first participant and confirm markers land in the recording at sensible times.

**If the device trips at 40 °C mid-session**, the app pauses automatically, emits `SESSION_PAUSE` (code 40), waits for the temperature to fall to 37.5 °C, then resumes the *same phase* and emits `SESSION_RESUME` (41). The session is not lost, but the pause is in the marker stream and should be accounted for in analysis.

---

## Data and analysis

Each session produces two aligned artefacts:

- **Behavioural CSV** exported from the app — per-trial reaction times, false alarms, omissions, contact temperature, and condition, all on a `performance.now()` timeline.
- **EEG/EMG recording** from NIC2 (`.easy` + `.info`, or `.edf`) with numeric markers written inline.

Markers are integers because NIC2 does not record string markers. The codebook is `analysis/trigger_codes.csv`, mirrored in `lsl_bridge.py` (`SIMPLE_CODES` / `COND_CODES`):

| Code | Event | Condition | Marker string | Source | Meaning |
|---|---|---|---|---|---|
| `255` | UNKNOWN | — | *(unrecognized)* | bridge | Marker string not in the codebook, or a `cond=` that could not be parsed. Reported on stderr. **Never 0** — the `.easy` trigger column is 0 whenever no marker is present, so a 0 code is indistinguishable from "nothing happened" and vanishes silently from the recording. |
| `1` | TONE | — | `TONE` | task page | Auditory stimulus onset. Reaction time is measured from here |
| `2` | RESPONSE | — | `RESPONSE;rt=312.4` | task page | Spacebar within the 2 s window (the RT value lives in the CSV, not the code) |
| `3` | FALSE_ALARM | — | `FALSE_ALARM` | task page | Spacebar *before* the tone (anticipation); resets the stimulus timer |
| `4` | OMISSION | — | `OMISSION` | task page | No press within the 2 s window (a miss) |
| `10` | SESSION_START | Heating Control | `SESSION_START;cond=Heating` | task page | Session begins, stimulation on |
| `11` | SESSION_START | 10 Hz NIR | `SESSION_START;cond=10Hz` | task page | Session begins |
| `12` | SESSION_START | 40 Hz NIR | `SESSION_START;cond=40Hz` | task page | Session begins |
| `15` | SESSION_END | Heating Control | `SESSION_END;cond=Heating` | task page | Session ends, stimulation off |
| `16` | SESSION_END | 10 Hz NIR | `SESSION_END;cond=10Hz` | task page | Session ends |
| `17` | SESSION_END | 40 Hz NIR | `SESSION_END;cond=40Hz` | task page | Session ends |
| `20` | EMG_START | — | `EMG_START` | task page | 10-min silent EMG-baseline phase begins (stimulation on, no tones) |
| `21` | EMG_END | — | `EMG_END` | task page | EMG phase ends |
| `22` | RT_START | — | `RT_START` | task page | 7-min reaction-time phase begins |
| `23` | RT_END | — | `RT_END` | task page | Reaction-time phase ends |
| `29` | STIM_OFF | — | `STIM_OFF` | device | Stimulation block ended or aborted (NIR and heater off) |
| `31` | NIR_ON | 10 Hz NIR | `NIR_ON;cond=10Hz` | device | NIR light physically ON — 850 nm @ 10 Hz, 50 % duty |
| `32` | NIR_ON | 40 Hz NIR | `NIR_ON;cond=40Hz` | device | NIR light physically ON — 850 nm @ 40 Hz, 50 % duty |
| `34` | HEAT_ON | — | `HEAT_ON` | device | Heater element energised (heating-control condition, PID-regulated) |
| `35` | HEAT_OFF | — | `HEAT_OFF` | device | Heater element off |
| `40` | SESSION_PAUSE | — | `SESSION_PAUSE` | task page | Session frozen by a thermal shutdown (> 40 °C); pairs with `99` |
| `41` | SESSION_RESUME | — | `SESSION_RESUME` | task page | Session resumed after the temperature recovered to ≤ 37.5 °C |
| `99` | SAFETY_TRIP | — | `SAFETY_TRIP` | device | 40 °C skin-temperature cut-off latched; all stimulation force-stopped |

Condition-bearing events are encoded as **base code + condition offset** (`Heating` = 0, `10Hz` = 1, `40Hz` = 2), which is why `30` is deliberately unused — the heating control emits `HEAT_ON` (34) instead of a `NIR_ON`. The arithmetic can still *produce* 30 (`NIR_ON` + Heating), which is a contradiction, so the bridge rejects it as invalid rather than writing it. A `cond=` that is missing or misspelt is likewise rejected, never defaulted to offset 0 — silently relabelling a 10 Hz run as the heating arm is unrecoverable after the fact. "Task page" codes originate in the browser app; "device" codes are derived from Arduino serial telemetry, so `11` (the task says stimulation started) and `31` (the device confirms the LED is pulsing) are independent confirmations.

**Keep these codes stable** — analysis scripts key off the exact integers. To epoch: group by the `SESSION_START` codes (10–12), split phases with `EMG_START` / `RT_START` (20 / 22), and confirm the light was physically on using `NIR_ON` (31 / 32) rather than assuming it from the condition label. Load NIC2 files with MNE, or XDF with pyxdf if you recorded via LabRecorder instead.

Expect ~1 ms of LSL synchronisation error plus ~1–3 ms of roughly constant localhost bridge latency — well within what an ERP or tPBM analysis needs. For sub-millisecond auditory ERP latencies you would need a hardware trigger.

---

## Documentation

| Document | Covers |
|---|---|
| [`SETUP.md`](SETUP.md) | Recording-computer install and the per-session startup sequence |
| [`docs/lsl_eeg_marker_integration.md`](docs/lsl_eeg_marker_integration.md) | Why the bridge exists, the full marker vocabulary, NIC2 configuration |
| [`docs/methods_software.md`](docs/methods_software.md) | Manuscript-level description of the control system |
| [`docs/testing_and_validation.md`](docs/testing_and_validation.md) | The bring-up ladder and what each sketch proves |
| [`hardware/wiring_guide.md`](hardware/wiring_guide.md) | Pinout table and per-component wiring |
| [`calibration/README.md`](calibration/README.md) | Thermal matching procedure |
| [`lsl_bridge/README.md`](lsl_bridge/README.md) | Bridge install, run, and self-test |

---

## References

- Vlahinić et al. (2020) — 850 nm, 10 Hz tPBM EEG study in healthy adults
- El Khoury et al. (2019) — 810 nm pulsed tPBM up to 100 mW/cm²
- Salehpour et al. (2018) — LED-based brain PBM review; 10–70 mW/cm² typical, 0.3–3 J/cm² useful fluence window
- [Lab Streaming Layer](https://labstreaminglayer.readthedocs.io/) · [Neuroelectrics LSL/TCP integration](https://www.neuroelectrics.com/lsl-tcp-integration)

---

## Contact

Daniel Elmaleh — EPFL — daniel.elmaleh@epfl.ch

Participant-facing documents and the study protocol are deliberately excluded from this repository.
