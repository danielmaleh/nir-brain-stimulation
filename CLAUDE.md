# NIR Brain Stimulation Project — Claude Instructions

## Project Overview

This is a neuroscience research project studying **Transcranial Photobiomodulation (tPBM)**: delivering near-infrared (NIR) light to the scalp to modulate cortical activity non-invasively.

The goal is to build a custom Arduino-controlled head-mounted device that delivers NIR light at precise pulse frequencies (10 Hz and 40 Hz), and to study the effect on brain activity (EEG) and motor performance in healthy adults.

## Research Context

- **Institution**: EPFL (researcher: Daniel Elmaleh, daniel.elmaleh@epfl.ch)
- **Participants**: 20 healthy adults, single 30-minute session each
- **Design**: Within-subject, 3 conditions in randomized order:
  1. **Heating control** — skin warming only, no NIR light (separates light effect from warmth sensation)
  2. **10 Hz NIR** — 850 nm LED pulsed at 10 Hz, 50% duty cycle
  3. **40 Hz NIR** — 850 nm LED pulsed at 40 Hz, 50% duty cycle
- **Measurements**: EEG (continuous), reaction time (finger-tapping), wrist EMG

## Light Dose Specifications

| Parameter | Value |
|---|---|
| Wavelength | 850 nm |
| Target fluence | ~1.25 J/cm² |
| Illumination area | ~4 cm² |
| Total energy per condition | ~5 J |
| Average optical power | ~84 mW |
| Peak optical power | ~168 mW |
| Duty cycle | 50% |
| Exposure duration | ~1 minute per condition |

## Hardware (Ordered/In Use)

| Component | Role |
|---|---|
| Arduino (Uno/Mega) | Microcontroller — controls timing, logging, safety cutoffs |
| 850 nm LED strip (SMD2835 dual-row, 95W/5m IR) | NIR light source |
| PCB (perfboard) | Mounting and wiring the LED array |
| Connecting cables (jumper wires) | Breadboard/circuit connections |
| 12V power supply (wall-mounted switching adapter) | Powers LEDs and heater |
| Heater ring/wire | Warming-only control condition |
| Temperature sensor | Monitors skin-contact temperature (cutoff ≤ 40 °C) |
| MOSFET driver modules | Switch LEDs and heater on/off at precise frequencies |

## Safety Requirements (Non-Negotiable)

- Skin temperature must **never exceed 40 °C** — the heater must cut off automatically
- Peak irradiance must stay within published safe ranges (~5–100 mW/cm² for 850 nm tPBM)
- The Arduino must log every delivered pulse and temperature reading for data integrity
- Pulse frequency must be accurate to within ±0.5 Hz at both 10 Hz and 40 Hz

## Software Architecture (To Be Built)

```
firmware/          # Arduino sketches
  main/            # Main experiment controller
  calibration/     # LED power and frequency calibration tools
  safety_test/     # Standalone safety/temperature cutoff test

analysis/          # Python data analysis
  eeg/             # EEG processing scripts
  emg/             # EMG processing scripts
  behavior/        # Reaction time analysis

hardware/          # Circuit diagrams, BOM, PCB layouts

data/
  raw/             # Raw EEG/EMG/log files (gitignored)
  processed/       # Processed/anonymized data

docs/              # Study protocol, ethics docs, references
```

## Coding Conventions

- **Arduino**: C/C++ standard. Use `millis()` for timing (never `delay()` in interrupt-sensitive code). Name constants in `ALL_CAPS`. Keep the main loop non-blocking.
- **Python**: Python 3.10+. Use numpy/scipy/mne for EEG analysis. PEP 8 style.
- Hardware pin assignments go in a dedicated `pins.h` header — never hardcode in logic files.
- Every firmware release must pass safety tests before being used with participants.

## Key Constraints

- The device must work standalone (no laptop required during sessions)
- The Arduino logs must be timestamped and exportable over USB serial
- EEG is recorded by a separate system (not controlled by this codebase)
- The blinding design relies on NIR being invisible — do not add visible indicator LEDs that activate during NIR conditions

## References

- Vlahinić et al. (2020): 850 nm, 10 Hz tPBM EEG study in healthy adults
- El Khoury et al. (2019): 810 nm pulsed tPBM up to 100 mW/cm²
- Salehpour et al. (2018): LED-based brain PBM review, 10–70 mW/cm² typical range, useful fluence window 0.3–3 J/cm²
