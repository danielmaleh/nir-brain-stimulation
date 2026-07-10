# Tagging the EEG/EMG with Experiment Events — LSL, Enobio & NIC2

A plain-language guide to how we get our experiment's events (tones, key
presses, NIR stimulation on/off) written into the Enobio EEG/EMG recording as
time-stamped **markers**, so the brain/muscle data can be aligned to what
happened in the task.

---

## 1. Why we need this

The Enobio records a continuous stream of EEG (and EMG) samples. On its own,
that stream has no idea *when the participant heard a tone* or *when the 40 Hz
NIR light turned on*. To analyse the data we need to cut the continuous
recording into **epochs** around events — e.g. "the 1 second of EEG after each
tone", or "the EEG during 10 Hz vs 40 Hz stimulation". That requires the
recording to contain **markers**: little labelled flags placed at exact times.

The hard requirement is a **shared clock**: the marker's timestamp and the EEG
samples must be measured on the same timeline, or the epochs land in the wrong
place. Getting that shared clock is the whole job, and it is what Lab Streaming
Layer solves.

---

## 2. The systems and words

| Term | What it is |
|---|---|
| **Enobio (NE)** | The wireless EEG/EMG amplifier (the headset + electrodes). Also does EXG channels for wrist EMG. |
| **NIC2** | *Neuroelectrics Instrument Controller v2* — the PC software that talks to the Enobio, shows signal quality, and **saves the recording** (`.easy` / `.nedf` / `.edf`). |
| **LSL (Lab Streaming Layer)** | A small, free networking system for research. Each data source publishes a **stream**; LSL keeps all streams **synchronized to ~1 ms** on one clock. The standard glue for multimodal experiments. |
| **Outlet** | An LSL "sender". NIC2 publishes EEG as an outlet; our bridge publishes a *Markers* outlet. |
| **Inlet** | An LSL "receiver". NIC2 acts as an inlet for our markers; a recorder acts as an inlet for everything. |
| **Marker / trigger / annotation** | A short event label (a string like `STIM` or a code) placed at a precise time in the recording. Same idea, different names. |

### What NIC2 gives you over LSL
When LSL is enabled in NIC2, it exposes up to four outlets, named after a base
name you choose:

- `NAME-EEG` — the EEG samples
- `NAME-Accelerometer`
- `NAME-Quality` — per-channel signal quality
- `NAME-Markers` — markers

Crucially, **NIC2 can also *receive* markers** from another program (over LSL or
TCP) and **write them straight into the recording file**. That is the path we
use: our experiment produces markers, NIC2 files them next to the EEG. No
separate merge step needed.

---

## 3. Our architecture

Our experiment runs in a **web browser** (`APP/index.html` for the behavioural
task, `APP/arduino.html` for the hardware). Browsers **cannot speak LSL
directly** — LSL is a native (C/UDP) library, and browser JavaScript can't load
it or send the UDP/multicast traffic LSL uses.

So we insert a tiny **local bridge**: a small Python program (using the
`pylsl` library) that:

1. creates an LSL **Markers outlet** (e.g. named `tPBM-Markers`), and
2. listens on a **localhost WebSocket** for events from the browser, pushing
   each one to the outlet the instant it arrives.

```
  index.html   ─┐
                 ├─(localhost WebSocket, ws://127.0.0.1:PORT)─►  Python bridge
  arduino.html ─┘                                                (pylsl outlet
                                                                   "tPBM-Markers")
                                                                        │
                                                                   LSL network
                                                                    (~1 ms sync)
                                                                        │
                                                        NIC2  ──►  writes markers INTO
                                                                   the EEG/EMG recording
```

- The **behavioural app** sends: run/condition start & end, tone onset, key
  press (with reaction time), premature press, and no-response omissions.
- The **hardware dashboard** sends: NIR stimulation start/stop (10 Hz / 40 Hz),
  heating on/off, and safety trips — these mark *when the light was actually on*,
  which for a tPBM study is the most important thing to align the EEG to.

> **Alternative:** instead of NIC2 receiving the markers, you can run the free
> **LabRecorder** tool, which records *every* LSL stream (NIC2's EEG **and** our
> markers) together into one **XDF** file. Both approaches give time-aligned
> data; NIC2-direct keeps everything in NIC2's native file, LabRecorder gives a
> single portable XDF. We default to **NIC2-direct** for simplicity.

---

## 4. The marker vocabulary

Markers are just agreed-upon strings. These mirror the events the experiment
already logs, so nothing new has to be invented:

| Marker string | When it fires | Source |
|---|---|---|
| `RUN_START;cond=10Hz` | a run begins (condition appended) | behavioural app |
| `STIM` | a tone is played (audible onset) | behavioural app |
| `RESPONSE;rt=312.4` | space pressed in the window (RT in ms) | behavioural app |
| `PREMATURE` | space pressed before the tone (false alarm) | behavioural app |
| `NO_RESPONSE` | no press within the 2 s window (omission) | behavioural app |
| `RUN_END;cond=10Hz` | a run ends | behavioural app |
| `NIR_ON;freq=40` | NIR stimulation starts (10/40 Hz) | Arduino dashboard |
| `NIR_OFF` | NIR stimulation stops | Arduino dashboard |
| `HEATER_ON` / `HEATER_OFF` | heating control switches | Arduino dashboard |
| `SAFETY_TRIP` | 40 °C safety cutoff latched | Arduino dashboard |

Keep the names short, stable, and documented — your analysis scripts key off
these exact strings.

---

## 5. Setup checklist (once per session)

1. **Install the bridge dependencies** (one time): `pip install pylsl websockets`.
   `pylsl` needs the native `liblsl` library present (bundled on most installs;
   otherwise install `liblsl`).
2. **Start the bridge** program *before* NIC2's recording. It prints something
   like `LSL Markers outlet 'tPBM-Markers' is live`.
3. **Configure NIC2**: enable LSL, and in NIC2's marker/LSL settings point it at
   the outlet name **`tPBM-Markers`**.
   - ⚠️ The name is **case-sensitive** and must match *exactly*.
   - ⚠️ The marker outlet **must already exist** (bridge running) *before* you
     start the NIC2 protocol/recording, or NIC2 won't find it.
4. **Start the NIC2 recording.**
5. **Open the experiment** in Chrome; it connects to the bridge automatically.
   Run the session as normal.
6. **Stop the NIC2 recording** at the end. The markers are now inside the file.

**Sanity check before real participants:** run one short test session and
confirm the markers appear in the NIC2 recording at sensible times (e.g. a
`STIM` roughly every ~5–7 s, each followed by a `RESPONSE` or `NO_RESPONSE`).

---

## 6. Timing accuracy — what to expect

- LSL synchronizes streams to about **1 ms**, which is well within what an ERP
  or tPBM analysis needs.
- Our localhost bridge adds a small, roughly constant **~1–3 ms** delay between
  the browser event and the LSL push. That is fine for this study.
- The behavioural app already captures the *true* event time with
  `performance.now()` (microsecond resolution) and anchors the tone marker to
  the **audible onset** (including audio output latency). If you ever need
  sub-millisecond precision (e.g. exact auditory ERP latencies), the bridge can
  forward that original timestamp so LSL stamps the marker at the true event
  time rather than at receipt — or you move to a **hardware trigger**, which is
  the gold standard but needs extra electronics.

---

## 7. Analysis (later)

- **NIC2 native file** (`.easy` + `.info`, or `.edf`): markers appear as an
  events column / annotations. In Python, load with **MNE** and read the events
  into annotations; epoch around each marker string.
- **XDF file** (if you used LabRecorder): load with **pyxdf**, then hand the EEG
  stream + marker stream to MNE. The two share LSL timestamps, so alignment is
  automatic.
- Group epochs by condition using the `RUN_START;cond=…` and `NIR_ON;freq=…`
  markers to compare 10 Hz vs 40 Hz vs heating.

---

## 8. References

- Neuroelectrics — [LSL & TCP Integration](https://www.neuroelectrics.com/lsl-tcp-integration)
- Neuroelectrics Support — [Set Up LSL](https://supportne.freshdesk.com/support/solutions/articles/35000292694-set-up-lsl)
- Neuroelectrics Wiki — [Interacting with NIC](https://ne-wiki.netlify.app/index.php/interacting_with_nic)
- Lab Streaming Layer — [official docs & LabRecorder](https://labstreaminglayer.readthedocs.io/)
- `pylsl` (Python bindings) — [pypi.org/project/pylsl](https://pypi.org/project/pylsl/)

---

*This document describes the intended integration. The Python bridge and the
browser-side marker hooks are the implementation step — see the project's
`analysis/` or a dedicated `lsl_bridge/` folder once built.*
