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
(The repo is private, so Git will prompt for your GitHub login. If you have the
GitHub CLI: `gh repo clone danielmaleh/nir-brain-stimulation`.)

To pull later updates: `git pull`.

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

6. **Open Chrome** at `http://localhost:8000/index.html` (task) and
   `http://localhost:8000/arduino.html` (hardware). Click **Connect to Arduino**
   and pick the Arduino's COM port. The pages auto-connect to the bridge — you'll
   see `Marker bridge connected` in the on-page console.

7. Run the session. **Stop the NIC2 recording** at the end — the markers are now
   inside the file.

---

## D. Before real participants — one dry run

Record ~60 seconds and confirm the markers actually landed in the NIC2 file at
sensible times (a `STIM` every ~5-7 s, each followed by `RESPONSE` or
`NO_RESPONSE`; `STIM_ON;cond=...` when a hardware run starts). This catches the
two things that can only fail on this machine:
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
- **Only one program can hold the COM port at a time.** The two app tabs now
  coordinate automatically (see `APP/serial_lock.js`), but nothing else
  (Arduino IDE Serial Monitor, PuTTY) can be open on that COM port while the
  dashboard is using it.
- **Firewall:** everything is `localhost`, so no inbound firewall rule is needed
  as long as the bridge, browser, and NIC2 are all on this one PC.
