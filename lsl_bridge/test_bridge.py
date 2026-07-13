#!/usr/bin/env python3
"""
Self-test for lsl_bridge.py (no browser, no EEG hardware needed).

Sends a marker over the bridge's WebSocket and reads it back from an LSL inlet,
proving the whole path browser -> bridge -> LSL works.

Run the bridge first:
    python lsl_bridge.py
Then in another terminal:
    python test_bridge.py
"""
import asyncio
import json
import sys
import time

try:
    from pylsl import resolve_byprop, StreamInlet
except Exception as exc:
    sys.exit(f"pylsl not available: {exc}")
try:
    import websockets
except Exception as exc:
    sys.exit(f"websockets not available: {exc}")

WS_URL = "ws://127.0.0.1:3535"
OUTLET_NAME = "tPBM-Markers"


async def main():
    print(f"Resolving LSL stream '{OUTLET_NAME}' ...")
    streams = resolve_byprop("name", OUTLET_NAME, timeout=5)
    if not streams:
        sys.exit("FAIL: LSL stream not found — is lsl_bridge.py running?")
    inlet = StreamInlet(streams[0])
    # LSL inlets connect lazily; force the connection and flush any backlog BEFORE
    # sending, so the marker we send next is guaranteed to be captured.
    inlet.open_stream(timeout=5)
    while inlet.pull_sample(timeout=0.1)[0] is not None:
        pass
    time.sleep(0.3)

    test_marker = f"SELFTEST_{int(time.time())}"
    async with websockets.connect(WS_URL) as ws:
        await ws.send(json.dumps({"marker": test_marker}))
        print(f"sent over WebSocket: {test_marker}")

    deadline = time.time() + 3
    while time.time() < deadline:
        sample, ts = inlet.pull_sample(timeout=0.5)
        if sample and sample[0] == test_marker:
            print(f"PASS: received '{sample[0]}' on LSL at t={ts:.3f}")
            return
    sys.exit("FAIL: marker was not received on the LSL inlet")


if __name__ == "__main__":
    asyncio.run(main())
