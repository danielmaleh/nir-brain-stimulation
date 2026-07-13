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
[bridge] LSL Markers outlet 'tPBM-Markers' is live (type=Markers).
[bridge] WebSocket listening on ws://127.0.0.1:3535
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

Behavioural task (`index.html`):
`RUN_START;cond=…`, `STIM`, `RESPONSE;rt=…`, `PREMATURE`, `NO_RESPONSE`, `RUN_END;cond=…`

Hardware dashboard (`arduino.html`):
`STIM_ON;cond=…`, `STIM_OFF`, `HEATER_ON`, `HEATER_OFF`, `SAFETY_TRIP`

## Quick self-test (no browser, no EEG)

With the bridge running, `test_bridge.py` sends a marker over the WebSocket and
reads it back from an LSL inlet to prove the whole path works:

```bash
python test_bridge.py
```
