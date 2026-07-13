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
    """Create the single-channel string Markers outlet NIC2 will subscribe to."""
    info = StreamInfo(
        name=OUTLET_NAME,
        type="Markers",
        channel_count=1,
        nominal_srate=IRREGULAR_RATE,
        channel_format="string",
        source_id="tpbm-marker-bridge-v1",
    )
    info.desc().append_child_value("manufacturer", "NIR-tPBM-project")
    return StreamOutlet(info)


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
            # Push at receipt time on the LSL clock.
            outlet.push_sample([str(marker)], local_clock())
            print(f"[bridge] -> LSL marker: {marker}", flush=True)
            try:
                await ws.send(json.dumps({"ack": marker}))
            except Exception:
                pass
    except websockets.ConnectionClosed:
        pass
    finally:
        print(f"[bridge] client disconnected: {peer}", flush=True)


async def main():
    outlet = make_outlet()
    print(f"[bridge] LSL Markers outlet '{OUTLET_NAME}' is live (type=Markers).", flush=True)
    print(f"[bridge] WebSocket listening on ws://{WS_HOST}:{WS_PORT}", flush=True)
    print("[bridge] Point NIC2's marker config at this outlet name BEFORE recording.", flush=True)

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
