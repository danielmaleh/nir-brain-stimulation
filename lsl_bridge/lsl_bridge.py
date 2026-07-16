#!/usr/bin/env python3
"""
LSL marker bridge for the NIR tPBM experiment.

Bridges browser experiment events to a Lab Streaming Layer (LSL) marker outlet
so NIC2 (or LabRecorder) can time-stamp them into the EEG/EMG recording.

Flow:
    browser (APP/index.html, APP/arduino.html)
      --(localhost WebSocket, JSON {"marker": "...", "t": <perf_ms>})-->
    this bridge
      --(pylsl StreamOutlet, name "tPBM-Markers", type "Markers")-->
    LSL network  -->  NIC2 embeds the markers into the recording

Markers are pushed at receipt time on the LSL clock (~1-3 ms after the browser
event, dominated by the localhost WebSocket hop). See
docs/lsl_eeg_marker_integration.md for the full picture.

Usage:
    pip install -r requirements.txt      # pylsl + websockets
    python lsl_bridge.py                 # start BEFORE the NIC2 recording

Then point NIC2's LSL marker configuration at the outlet name "tPBM-Markers"
(case-sensitive), and make sure this bridge is already running before you start
the NIC2 protocol/recording, or NIC2 will not find the stream.
"""
import asyncio
import json
import sys

OUTLET_NAME = "tPBM-Markers"
WS_HOST = "127.0.0.1"
WS_PORT = 3535

# NIC2 only ingests NUMERIC markers ("Do not send marker names as objects like
# 'hand'"). It accepts an int32 marker stream OR a string stream carrying numeric
# strings. So the browser keeps sending readable strings (STIM_ON;cond=40Hz), and
# this bridge translates each into a stable integer CODE before pushing to LSL.
#
# MARKER_FORMAT selects how the code is put on the wire:
#   "int32"  -> an int32 Markers stream (canonical LSL; use NIC2's Integer option)
#   "string" -> a string Markers stream carrying "21" etc (NIC2's Numeric-String option)
# If NIC2 shows nothing with one, flip to the other to match NIC2's marker config.
MARKER_FORMAT = "int32"

# --- Marker codebook: readable event -> integer code written into the EEG file --
# Keep these STABLE; the analysis scripts map codes back to events. The condition
# order below is added as an offset to the condition-bearing base codes.
COND_ORDER = {"Heating": 0, "10Hz": 1, "40Hz": 2, "EMG": 3}

# Events with no condition attached -> fixed code.
SIMPLE_CODES = {
    "STIM": 1,          # tone onset (task)
    "RESPONSE": 2,      # keypress within the response window (task)
    "PREMATURE": 3,     # keypress before the tone / false alarm (task)
    "NO_RESPONSE": 4,   # omission, no press in the window (task)
    "STIM_OFF": 29,     # stimulation block ended/aborted (hardware)
    "HEATER_ON": 30,    # heater element on (hardware)
    "HEATER_OFF": 31,   # heater element off (hardware)
    "SAFETY_TRIP": 99,  # 40 C safety cutoff latched (hardware)
}

# Events carrying ";cond=..." -> base code + COND_ORDER[cond].
#   RUN_START:        10 Heating, 11 10Hz, 12 40Hz, 13 EMG
#   RUN_END:          15 Heating, 16 10Hz, 17 40Hz, 18 EMG
#   STIM_ON:          20 Heating, 21 10Hz, 22 40Hz
#   STIM_COND_SWITCH: 40 Heating, 41 10Hz, 42 40Hz
COND_CODES = {
    "RUN_START": 10,
    "RUN_END": 15,
    "STIM_ON": 20,
    "STIM_COND_SWITCH": 40,
}

UNKNOWN_CODE = 0  # anything unrecognized -> 0 (logged as a warning)


def encode_marker(marker):
    """Map a readable marker string to its integer code (see codebook above)."""
    base, _, rest = marker.partition(";")
    base = base.strip()
    if base in SIMPLE_CODES:
        return SIMPLE_CODES[base]
    if base in COND_CODES:
        cond = ""
        for field in rest.split(";"):
            key, _, val = field.partition("=")
            if key.strip() == "cond":
                cond = val.strip()
        return COND_CODES[base] + COND_ORDER.get(cond, 0)
    return UNKNOWN_CODE

try:
    from pylsl import StreamInfo, StreamOutlet, IRREGULAR_RATE, local_clock
except Exception as exc:  # pragma: no cover - environment dependent
    sys.exit(
        f"ERROR: pylsl is not available ({exc}).\n"
        "Install with:  pip install -r requirements.txt\n"
        "pylsl needs the native liblsl library. If it is missing, on macOS use:\n"
        "  conda install -c conda-forge liblsl\n"
        "  (or)  brew install labstreaminglayer/tap/lsl\n"
    )

try:
    import websockets
except Exception:  # pragma: no cover - environment dependent
    sys.exit("ERROR: 'websockets' is not installed. Run:  pip install -r requirements.txt")


def make_outlet():
    """Create the single-channel numeric Markers outlet NIC2 will subscribe to."""
    info = StreamInfo(
        name=OUTLET_NAME,
        type="Markers",
        channel_count=1,
        nominal_srate=IRREGULAR_RATE,
        channel_format=MARKER_FORMAT,  # "int32" or "string" (numeric strings)
        source_id="tpbm-marker-bridge-v1",
    )
    info.desc().append_child_value("manufacturer", "NIR-tPBM-project")
    return StreamOutlet(info)


def push_code(outlet, code):
    """Push a numeric marker code in whichever format the outlet was created with."""
    if MARKER_FORMAT == "int32":
        outlet.push_sample([int(code)], local_clock())
    else:
        outlet.push_sample([str(int(code))], local_clock())


async def handle_client(ws, outlet):
    peer = getattr(ws, "remote_address", "?")
    print(f"[bridge] client connected: {peer}", flush=True)
    try:
        async for raw in ws:
            marker = None
            try:
                obj = json.loads(raw)
                marker = obj.get("marker") if isinstance(obj, dict) else None
            except (ValueError, TypeError):
                marker = raw if isinstance(raw, str) else None
            if not marker:
                continue
            # Translate the readable string to its numeric code and push it at
            # receipt time on the LSL clock (NIC2 only records numeric markers).
            code = encode_marker(str(marker))
            push_code(outlet, code)
            if code == UNKNOWN_CODE:
                print(f"[bridge] -> LSL marker: {marker}  -> code {code}  (UNKNOWN — add it to the codebook)", flush=True)
            else:
                print(f"[bridge] -> LSL marker: {marker}  -> code {code}", flush=True)
            try:
                await ws.send(json.dumps({"ack": marker, "code": code}))
            except Exception:
                pass
    except websockets.ConnectionClosed:
        pass
    finally:
        print(f"[bridge] client disconnected: {peer}", flush=True)


async def main():
    outlet = make_outlet()
    print(f"[bridge] LSL Markers outlet '{OUTLET_NAME}' is live (type=Markers, format={MARKER_FORMAT}).", flush=True)
    print(f"[bridge] WebSocket listening on ws://{WS_HOST}:{WS_PORT}", flush=True)
    print("[bridge] Point NIC2's marker config at this outlet name BEFORE recording.", flush=True)
    print("[bridge] Marker codebook (event -> code written into the EEG file):", flush=True)
    print("[bridge]   STIM=1 RESPONSE=2 PREMATURE=3 NO_RESPONSE=4", flush=True)
    print("[bridge]   RUN_START=10/11/12/13  RUN_END=15/16/17/18   (Heating/10Hz/40Hz/EMG)", flush=True)
    print("[bridge]   STIM_ON=20/21/22  STIM_OFF=29  STIM_COND_SWITCH=40/41/42", flush=True)
    print("[bridge]   HEATER_ON=30 HEATER_OFF=31  SAFETY_TRIP=99", flush=True)

    # Accept both the newer (ws) and older (ws, path) websockets handler signatures.
    async def entry(ws, *_):
        await handle_client(ws, outlet)

    async with websockets.serve(entry, WS_HOST, WS_PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[bridge] stopped.")
