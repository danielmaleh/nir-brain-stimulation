# Recording Computer Setup (Windows PC running NIC2)

This is the machine connected to the Enobio 32 that runs NIC2 and saves the
recording. It also runs the experiment (browser), the Arduino (USB), and the
LSL marker bridge — **everything lives on this one computer** because the
browser talks to the bridge over `localhost` and to the Arduino over USB.

---

## A. One-time install (do once)

1. **Python 3.10+** — install from <https://python.org/downloads/>.
   During install, tick **"Add python.exe to PATH"**. Verify in a new
   PowerShell / Command Prompt:
   ```
   python --version
   ```

2. **Bridge libraries** — from the project folder:
   ```
   pip install -r lsl_bridge\requirements.txt
   ```
   This installs `pylsl` and `websockets`. On Windows the `pylsl` wheel already
   bundles the native `liblsl.dll`, so there is **no separate liblsl install** —
   if `pip` finished without errors you are done. Sanity check:
   ```
   python -c "import pylsl, websockets; print('ok')"
   ```

3. **Google Chrome** (or Edge) — required. The app uses the Web Serial and
   BroadcastChannel APIs, which Firefox and other browsers do not support.

4. **NIC2** — already installed for the Enobio 32. No change.

5. **Arduino driver** — a genuine Uno uses Windows' built-in USB-serial driver
   and shows up as `COMx` in Device Manager automatically. (A clone with a CH340
   chip would need the CH340 driver.) You do not need the Arduino IDE or toolchain
   on this PC — the board is already flashed; the browser just talks to it.

---

## B. Get the project onto the PC

```
git clone https://github.com/danielmaleh/nir-brain-stimulation.git
cd nir-brain-stimulation
```
(The repo is public; no login is needed to clone or pull.)

To pull later updates: `git pull`, then **always**:
1. stop and restart `lsl_bridge.py` and check its start-up codebook lists
   `POST_START=44 … CARD_REMOVE=54` — a bridge left running from an older
   checkout writes the newer markers as `255`;
2. hard-reload the app page (Ctrl+Shift+R) and confirm the page source loads
   `app.js?v=22` (or newer) — Chrome caches the old script otherwise;
3. if `firmware/` changed, the board must be reflashed (done from the Mac with
   `arduino-cli`; this PC only talks to it). The page shows which build the
   board runs when you connect.

---

## C. Every session — start things in THIS order

The one rule that bites people: the marker stream must exist **before** NIC2
starts recording, or NIC2 won't find it.

1. **Plug in the Arduino** (USB) and confirm the **Enobio 32** is on and paired
   in NIC2 with good signal quality.

2. **Start the marker bridge** in a terminal (leave it running):
   ```
   python lsl_bridge\lsl_bridge.py
   ```
   Wait for: `LSL Markers outlet 'tPBM-Markers' is live` and
   `WebSocket listening on ws://127.0.0.1:3535`.

3. **In NIC2**, enable LSL and subscribe to the marker outlet named exactly
   **`tPBM-Markers`** (case-sensitive).

4. **Start the NIC2 recording.**

5. **Serve the app** in a second terminal (Web Serial won't run from a bare
   `file://` path):
   ```
   cd APP
   python -m http.server 8000
   ```

6. **Open Chrome** at `http://localhost:8000/index.html` (the task page — it
   drives the device itself; do **not** connect the hardware dashboard
   `arduino.html` during a session, only one tab can hold the port). Click
   **Connect NIR Device** and pick the Arduino's COM port. In the on-page
   console confirm:
   - `Marker bridge connected`
   - `Firmware build: PROTOCOL (thermal cutoff 40 °C)` — appears ~2 s after
     connecting. If it says **BENCH**, or never appears, stop: the board must be
     reflashed from `firmware/main`. A real session is refused on a BENCH build
     and cannot start without a connected device.

7. **Put the blocking card over the light on the device NOW**, enter the
   participant and session IDs, and press **Start Session**. The first 2 min are
   the blocked-light calibration (30 s each of 10 Hz, 40 Hz, heating, off, with
   the card on); the screen then says **Remove the Card** and gives you 10 s.
   After that the session runs itself: pre gap, three 13.5-min conditions with
   rests. Keep your eyes on the sidebar.

8. **Sham question.** Each time a block's stimulation ends (start of its
   1.5-min post gap) a yellow panel appears in the sidebar: ask the participant
   *"Did you notice the stimulation during this block?"* and click
   **Yes / No / Don't know**. The last block's panel stays open after the
   session ends until you answer it.

9. **Stop the NIC2 recording** at the end — the markers are now inside the
   file. The app downloads three files by itself when the session ends (or is
   aborted): `..._session.csv`, `..._temperature.csv` and `..._full.json`.
   The first time, Chrome asks whether `localhost:8000` may download multiple
   files — click **Allow**. Keep all three with the NIC2 recording.

---

## D. Before real participants — one dry run

Run one full **Test session** (tick the checkbox; identical timing, CSV stamped
TEST) with the NIC2 recording on, and confirm the integer markers landed in the
file at sensible times: `48` then `51` and `31` in the first minute (blocked
10 Hz), `54` at ~2:00, `46` at ~2:10, the first `10`/`11`/`12` at ~3:40, then
`20`, `42`/`43` around the EMG midpoint, `22` at ~9:40 followed by a `1` every
~5–7 s each answered by `2` or `4`, `44`/`45` and `15`/`16`/`17` at the block
end. The full table is `analysis/trigger_codes.csv`. This catches the two
things that can only fail on this machine:
- `liblsl` / `pylsl` not importing (fix: redo step A2), and
- NIC2 not ingesting the external marker stream on your NIC2 version.

**Fallback if NIC2 won't record the markers:** run the free **LabRecorder**
tool instead — it records NIC2's EEG stream *and* the `tPBM-Markers` stream
together into one `.xdf` file (they share the LSL clock, so alignment is
automatic). No code changes needed.

---

## E. Windows gotchas

- **Chrome Memory Saver** can discard a backgrounded tab and reload it, which
  makes the dashboard re-grab the serial port. Add `localhost:8000` to
  `chrome://settings/performance` → "Always keep these sites active".
- **Only one program can hold the COM port at a time.** During a session the
  task page must hold it (it drives the stimulation); the hardware dashboard
  tab yields to it automatically (see `APP/serial_lock.js`), but nothing else
  (Arduino IDE Serial Monitor, PuTTY) can be open on that COM port.
- **Automatic downloads:** the session's three files are downloaded by the
  page at the end. If Chrome silently blocks the 2nd and 3rd file, allow
  "Automatic downloads" for `localhost:8000` in
  `chrome://settings/content/automaticDownloads`.
- **Firewall:** everything is `localhost`, so no inbound firewall rule is needed
  as long as the bridge, browser, and NIC2 are all on this one PC.
