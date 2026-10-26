# Protocol timing: what changed and why (2026-10-20)

Reference sheet for the paper, report and presentation. Every number here is
what the software enforces (`APP/app.js` constants) unless marked *nominal*.

## 1. Per-condition timing

| | Original design (Jul–Sep 2026) | Interim (14 Sep – 20 Oct 2026) | **Current (from 20 Oct 2026)** |
|---|---|---|---|
| EMG baseline phase | 10 min, unbroken | 5 + **1.5 cool** + 5 = 11.5 min | **2.5 + 1 cool + 2.5 = 6 min** |
| Reaction-time phase | 7 min, unbroken | 3.5 + 1.5 cool + 3.5 = 8.5 min | **2.5 + 1 cool + 2.5 = 6 min** |
| Off gap ending the block (stimulation off) | — (3-min rest between conditions only) | 1.5 min + 3-min rest | **1.5 min (default; one window)** |
| **Per condition** | **17 min** | **21.5 min** | **13.5 min** |
| Light/heater ON time per condition | 17 min (1020 s) | 17 min (1020 s) | **10 min (600 s)** |
| Light-on blocks per condition | 1 continuous (17 min) | 3 (5, 8.5, 3.5 min — no break at the EMG→RT boundary) | **3 (2.5, 5, 2.5 min — no break at the EMG→RT boundary)** |

The current timing is the former *test-session* timing promoted to the protocol;
test sessions now differ from real ones only in the `TEST` stamp and in being
allowed on a bench firmware build.

## 2. Whole session

| Step | Original | Interim | **Current** |
|---|---|---|---|
| Blocked-light calibration (card on the device: 30 s × 10 Hz, 40 Hz, heating, off) | — | — | **2 min** |
| Card-removal window | — | — | **10 s** |
| Pre gap (stimulation off) | — | 1.5 min (from 4 Oct) | **1.5 min** |
| Condition 1 | 17 | 21.5 | **13.5** |
| Rest between conditions | 3 | 3 (in addition to the post gap) | **none — the block's own off gap is the separation** |
| Condition 2 | 17 | 21.5 | **13.5** |
| Condition 3 | 17 | 21.5 | **13.5** |
| **Total in-protocol** | **57 min** | **~72 min** | **~44 min** |
| Sham-awareness question | — | — | asked by the experimenter during each post gap; adds no time |

The off gap is configurable in the app ("Off gap after each block", default 90 s, minimum 5 s); from 26 Oct 2026 it is the only gap between conditions — the earlier design stacked a 3-min rest on top of it.

## 3. Light dose

Fluence is *irradiance × light-on time*. Irradiance must be measured at the scalp
with a calibrated power meter; the numbers below use the **nominal** design values
from the hardware spec (average optical power ~84 mW over ~4 cm² ≈ 21 mW/cm²,
50 % duty already included) only to show how the change scales the dose.

| | Original | Interim | **Current** |
|---|---|---|---|
| Light-on time per condition | 1020 s | 1020 s | **600 s** |
| Fluence formula | E × 1020 s | E × 1020 s | **E × 600 s** |
| Nominal fluence at 21 mW/cm² | 21.4 J/cm² | 21.4 J/cm² | **12.6 J/cm²** |
| Nominal energy at 84 mW | 85.7 J | 85.7 J | **50.4 J** |
| Pulse frequency / duty | 10.00 or 40.00 Hz, 50 % | same | **same** |

Two things to state explicitly in any write-up:

- The hardware spec's original "target fluence ~1.25 J/cm²" and "~5 J per condition" dated
  from a **1-minute** exposure design and were never updated; at 600 s the
  nominal fluence is ~10× that figure and above the 0.3–3 J/cm² window cited
  for tPBM. The measured irradiance, not the nominal one, has to settle this
  before participants.
- Cooling breaks and gaps change **pacing**, not dose: the 600 s on-time is
  delivered in three blocks (2.5, 5, 2.5 min) with the light fully off in
  between. Note the middle block spans the EMG→RT boundary unbroken (5 min);
  adding a break there would make it four 2.5-min blocks and add 1 min.

## 4. Why the timing changed

Bench measurements with an external thermistor at the skin-contact point
(11 and 17 Sep 2026) showed the device climbing ~1.5–3 °C/min at protocol duty
with no plateau; an unbroken 10-minute phase crossed the 40 °C limit. The same
runs showed the device's own DS18B20 reading up to ~9 °C low and ~90 s late
during a ramp, so the firmware now trips on an *estimated* surface temperature
(37 °C) rather than the raw reading. Shorter blocks with stimulation-off breaks
keep the surface temperature inside the limit without changing the pulse
parameters, and the 1-minute break was chosen as the shortest the thermistor
runs showed to be sufficient at 2.5-minute block length.

## 5. Markers added with the structure

| Codes | Event |
|---|---|
| 42 / 43 | `COOL_START` / `COOL_END` — mid-phase cooling break |
| 44 / 45 | `POST_START` / `POST_END` — post gap ending every condition |
| 46 / 47 | `PRE_START` / `PRE_END` — pre gap before the first condition |
| 48 / 49 | `BLOCKED_START` / `BLOCKED_END` — blocked-light calibration |
| 50 / 51 / 52 | `BLOCKED_SEG;cond=` Heating / 10 Hz / 40 Hz (30-s segments) |
| 53 | `BLOCKED_OFF` — 30-s off segment of the calibration |
| 54 | `CARD_REMOVE` — 10-s card-removal window |

Full codebook: `analysis/trigger_codes.csv`.

## 6. Heating control (sham) at the current timing

The heater follows, on the device sensor, the trajectory recorded during the
same participant's NIR blocks (feedforward + PI, 20 % duty cap, unchanged).
At 20 % the heater's initial rise is ~2.4 °C/min and its plateau ~+10 °C, while
a 2.5-minute NIR block raised the device sensor by ~+7–9 °C from ambient on the
bench; expect the sham to follow the shape of the NIR curve and to end each
2.5-minute block ~2–3 °C below it. The per-block `HEATER_PID` telemetry
(duty, temperature, target, feedforward) records how closely it tracked.
