# LSL Marker Bridge

Publishes an LSL **Markers** outlet named `tPBM-Markers` and relays experiment
events from the browser apps (`APP/index.html`, `APP/arduino.html`) to it over a
localhost WebSocket, so **NIC2** (or LabRecorder) can time-stamp them into the
Enobio EEG/EMG recording.

See `../docs/lsl_eeg_marker_integration.md` for the concepts.

## Install

```bash
pip install -r requirements.txt
```

`pylsl` needs the native **liblsl** library. If `pip install pylsl` can't find
it:

```bash
conda install -c conda-forge liblsl        # or
brew install labstreaminglayer/tap/lsl     # macOS
```

## Run

```bash
python lsl_bridge.py
```

It prints:

```
[bridge] LSL Markers outlet 'tPBM-Markers' is live (type=Markers, format=int32).
[bridge] WebSocket listening on ws://127.0.0.1:3535
[bridge] Marker codebook (event -> code written into the EEG file):
[bridge]   ... (the full code list; check it includes POST_START=44 ... CARD_REMOVE=54)
```

**Order matters:** start this bridge **before** starting the NIC2 recording, and
point NIC2's LSL marker configuration at the outlet name `tPBM-Markers`
(case-sensitive).

## Session order

1. `python lsl_bridge.py`
2. In NIC2: enable LSL, set the marker source to `tPBM-Markers`, start recording.
3. Open the experiment pages in Chrome (they connect to the bridge
   automatically; the telemetry console shows "Marker bridge connected").
4. Run the session. Markers are pushed to LSL as events happen.
5. Stop the NIC2 recording. Markers are now inside the file.

## Markers emitted

Task page (`index.html`), per participant: `BLOCKED_START/END` (48/49),
`BLOCKED_SEG;cond=…` (50–52), `BLOCKED_OFF` (53), `CARD_REMOVE` (54),
`PRE_START/END` (46/47); per condition: `SESSION_START;cond=…` (10–12),
`EMG_START/END` (20/21), `COOL_START/END` (42/43), `RT_START/END` (22/23),
`TONE` (1), `RESPONSE;rt=…` (2), `FALSE_ALARM` (3), `OMISSION` (4),
`POST_START/END` (44/45), `SESSION_END;cond=…` (15–17); on a thermal trip
`SESSION_PAUSE/RESUME` (40/41).

Device telemetry (relayed by the task page's `arduino_link.js`, or by the
hardware dashboard on the bench): `NIR_ON;cond=…` (31/32), `STIM_OFF` (29),
`HEAT_ON`/`HEAT_OFF` (34/35; `HEATER_ON/OFF` are aliased), `SAFETY_TRIP` (99).
Anything else is written as `255` and reported on stderr — never `0`, which
the `.easy` trigger column cannot distinguish from "no marker". Full table:
`analysis/trigger_codes.csv`.

## Quick self-test (no browser, no EEG)

With the bridge running, `test_bridge.py` sends a marker over the WebSocket and
reads it back from an LSL inlet to prove the whole path works:

```bash
python test_bridge.py
```
