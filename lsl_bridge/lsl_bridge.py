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
COND_ORDER = {"Heating": 0, "10Hz": 1, "40Hz": 2}

# Events with no condition attached -> fixed code.
#   TASK (from the experiment page):
SIMPLE_CODES = {
    "TONE": 1,          # auditory stimulus onset (reaction-time phase)
    "RESPONSE": 2,      # spacebar within the response window
    "FALSE_ALARM": 3,   # spacebar before the tone (anticipation)
    "OMISSION": 4,      # no press within the response window
    "EMG_START": 20,    # 10-min EMG baseline phase begins
    "EMG_END": 21,      # EMG phase ends
    "RT_START": 22,     # 7-min reaction-time phase begins
    "RT_END": 23,       # reaction-time phase ends
    "SESSION_PAUSE": 40,  # session frozen by a thermal shutdown (>40 C)
    "SESSION_RESUME": 41, # session resumed after the temperature recovered (<=37.5 C)
    "COOL_START": 42,   # scheduled mid-phase cooling break begins (stimulation off; planned, NOT a safety event)
    "COOL_END": 43,     # scheduled cooling break over (stimulation back on, phase second half resumes)
    # HARDWARE (from the device telemetry):
    "STIM_OFF": 29,     # device stimulation block ended/aborted
    "HEAT_ON": 34,      # heater element energised (heating condition)
    "HEAT_OFF": 35,     # heater element off
    "SAFETY_TRIP": 99,  # 40 C safety cutoff latched
}

# Events carrying ";cond=..." -> base code + COND_ORDER[cond] (Heating/10Hz/40Hz).
#   SESSION_START: 10 Heating, 11 10Hz, 12 40Hz
#   SESSION_END:   15 Heating, 16 10Hz, 17 40Hz
#   NIR_ON:        31 10Hz, 32 40Hz  (30 would be "NIR_ON Heating", which is a
#                  contradiction - the heating arm emits no NIR. See INVALID_CODES.)
COND_CODES = {
    "SESSION_START": 10,
    "SESSION_END": 15,
    "NIR_ON": 30,
}

# Codes the arithmetic above can produce but which mean nothing. Emitting one is
# always a bug upstream, so it is reported instead of written into the EEG file.
INVALID_CODES = {30}

# The browser emits a couple of these under a different spelling than the
# codebook. They are the same events, so translate rather than drop them:
# APP/arduino.js sends HEATER_ON/HEATER_OFF, the codebook calls them HEAT_ON/HEAT_OFF.
ALIASES = {
    "HEATER_ON": "HEAT_ON",
    "HEATER_OFF": "HEAT_OFF",
}

# An unrecognised marker MUST NOT be encoded as 0. The trigger column of a
# Neuroelectrics .easy file is 0 whenever no marker is present, so a 0 code is
# indistinguishable from "nothing happened" and vanishes silently from the
# recording. 255 is outside the codebook and shows up in any downstream check.
UNKNOWN_CODE = 255

# Identical codes arriving closer together than this are treated as one event.
# Both browser pages (index.html and arduino.html) hold their own WebSocket to
# this bridge, so a duplicated emission is possible; real task events are never
# this close (tones are ~6 s apart, a response follows its tone by >=200 ms).
DEDUP_SEC = 0.05


def encode_marker(marker):
    """Map a readable marker string to its integer code.

    Returns (code, error). `error` is None on success, otherwise a string
    describing why the marker could not be encoded; the caller logs it and
    pushes UNKNOWN_CODE so the problem is visible in the recording itself.
    """
    base, _, rest = marker.partition(";")
    base = ALIASES.get(base.strip(), base.strip())

    if base in SIMPLE_CODES:
        return SIMPLE_CODES[base], None

    if base in COND_CODES:
        cond = ""
        for field in rest.split(";"):
            key, _, val = field.partition("=")
            if key.strip() == "cond":
                cond = val.strip()
        # Never default a missing/misspelt condition to 0. That silently relabels
        # the run as the Heating arm, which is unrecoverable after the fact.
        if cond not in COND_ORDER:
            return UNKNOWN_CODE, (
                f"{base} carries no valid cond= (got {cond!r}; "
                f"expected one of {sorted(COND_ORDER)})"
            )
        code = COND_CODES[base] + COND_ORDER[cond]
        if code in INVALID_CODES:
            return UNKNOWN_CODE, (
                f"{base};cond={cond} maps to reserved code {code}, which is not a "
                "real event - the heating arm must not emit NIR_ON"
            )
        return code, None

    return UNKNOWN_CODE, f"unrecognised marker {base!r} - add it to the codebook"

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


async def handle_client(ws, outlet, recent):
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
            code, err = encode_marker(str(marker))

            # Drop a repeat of the same code from any client within DEDUP_SEC.
            # `recent` is shared across connections, so a marker emitted by both
            # browser pages is recorded once.
            now = local_clock()
            if code != UNKNOWN_CODE and now - recent.get(code, -1e9) < DEDUP_SEC:
                print(f"[bridge] .. duplicate {marker} (code {code}) within "
                      f"{DEDUP_SEC * 1000:.0f} ms - not pushed", flush=True)
                continue
            recent[code] = now

            push_code(outlet, code)
            if err is not None:
                print(f"[bridge] !! {marker!r} -> code {code}  ERROR: {err}",
                      file=sys.stderr, flush=True)
            else:
                print(f"[bridge] -> LSL marker: {marker}  -> code {code}", flush=True)
            try:
                await ws.send(json.dumps({"ack": marker, "code": code, "error": err}))
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
    print("[bridge]   TONE=1 RESPONSE=2 FALSE_ALARM=3 OMISSION=4", flush=True)
    print("[bridge]   SESSION_START=10/11/12  SESSION_END=15/16/17   (Heating/10Hz/40Hz)", flush=True)
    print("[bridge]   EMG_START=20 EMG_END=21  RT_START=22 RT_END=23", flush=True)
    print("[bridge]   SESSION_PAUSE=40 SESSION_RESUME=41 (thermal shutdown/recovery)", flush=True)
    print("[bridge]   COOL_START=42 COOL_END=43 (scheduled mid-phase cooling breaks)", flush=True)
    print("[bridge]   NIR_ON=31/32 (10Hz/40Hz)  STIM_OFF=29  HEAT_ON=34 HEAT_OFF=35  SAFETY_TRIP=99", flush=True)

    print(f"[bridge]   unrecognised markers -> {UNKNOWN_CODE} (never 0: 0 is "
          "indistinguishable from 'no marker' in the .easy trigger column)", flush=True)

    recent = {}  # code -> last push time, shared by every connected page

    # Accept both the newer (ws) and older (ws, path) websockets handler signatures.
    async def entry(ws, *_):
        await handle_client(ws, outlet, recent)

    async with websockets.serve(entry, WS_HOST, WS_PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[bridge] stopped.")
