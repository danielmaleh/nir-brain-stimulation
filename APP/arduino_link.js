/**
 * @file arduino_link.js
 * @brief Robust Web Serial link that lets the Experiment Task page (index.html)
 *        drive the Arduino NIR/heater stimulation, independently of the Hardware
 *        Dashboard tab.
 *
 * Connection design (robust + clearly separate from arduino.html):
 *  - Explicit Connect opens the port directly. If the port is busy (the dashboard
 *    tab holds it) the operator gets a clear "disconnect the dashboard" message —
 *    no silent takeover race.
 *  - Once connected, this page HOLDS the port firmly: it never yields to another
 *    tab, so a running session can't have the port pulled out from under it.
 *    (The dashboard's auto-reconnect yields to us instead, via SerialLock.claim.)
 *  - Never double-opens: connect() is a no-op if already connected/connecting,
 *    and openPort() closes any stale handle first.
 *  - Status reflects reality: OFFLINE / CONNECTED (no data yet) / RECEIVING, and
 *    it detects unexpected drops (cable pulled / port closed) and surfaces the
 *    reason a run's stimulation stopped (thermal trip, sensor fault, time limit).
 *
 * At each run it selects the matching firmware condition and starts stimulation,
 * targeting the NIR-matched heating setpoint (baseline + calibrated rise).
 */
window.ArduinoLink = (function () {
  let port = null;
  let reader = null;
  let keepReading = false;
  let connecting = false;
  let buf = '';

  let connected = false;
  let receiving = false;     // genuinely receiving telemetry from the board
  let lastDataMs = 0;
  let lastReason = '';       // why the device / stimulation last stopped
  let selectedCond = 0;      // firmware's currently-selected condition (0/1/2)
  let tripped = false;       // firmware latched in SAFETY_TRIP
  let watchdog = null;

  let logFn = (m) => console.log('[NIR] ' + m);
  let statusFn = null;       // ({connected, receiving, tripped, reason}) => void
  let tempFn = null;         // (tempC:number) => void   — live temperature monitor
  let stopFn = null;         // (reason:string) => void  — stimulation stopped unexpectedly

  const COND_INDEX = { 'Heating Control': 0, '10 Hz NIR': 1, '40 Hz NIR': 2 };
  const COND_CODE = ['Heating', '10Hz', '40Hz']; // for NIR_ON;cond= markers

  // Heating match: reproduce the calibrated NIR temperature RISE above the
  // participant's baseline skin temp (see calibrate_thermal.py / thermal_profile.json).
  let heatingRiseC = null;
  let profileCalibrated = false;
  let latestTempC = null;
  let latestSurfaceEstC = null;   // firmware's estimated skin-surface temperature (TEMP_LOG 4th field)
  let heaterTargetFn = null;      // () => C; when set, the heating run replays a target instead of the profile
  let buildInfo = null;      // {type: "PROTOCOL"|"BENCH", cutoff} from the boot BUILD line

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- Status / callbacks ---
  function setLogger(fn) { if (typeof fn === 'function') logFn = fn; }
  function setOnStatus(fn) { statusFn = fn; }
  function setOnTemp(fn) { tempFn = fn; }
  function setOnStop(fn) { stopFn = fn; }
  function statusObj() { return { connected, receiving, tripped, reason: lastReason, build: buildInfo }; }
  function emitStatus() { if (statusFn) statusFn(statusObj()); }
  function marker(m) { if (window.LSLMarkers) window.LSLMarkers.send(m); }

  // Load the thermal calibration profile (best-effort; served alongside the app).
  async function loadThermalProfile() {
    try {
      const resp = await fetch('thermal_profile.json', { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const p = await resp.json();
      profileCalibrated = !!p.calibrated;
      if (typeof p.heating_rise_c === 'number') heatingRiseC = p.heating_rise_c;
      if (profileCalibrated && typeof heatingRiseC === 'number') {
        logFn('Thermal calibration loaded: heating reproduces +' + heatingRiseC.toFixed(2) + ' °C above baseline skin temp.');
      } else {
        logFn('Thermal profile NOT calibrated — heating uses the firmware default (37.5 °C). Run calibrate_thermal.py.');
      }
    } catch (e) {
      logFn('No thermal profile loaded (' + e.message + ') — heating uses the firmware default.');
    }
  }

  // --- Connection ---
  async function openPort(selected) {
    // Never double-open: drop any stale handle first.
    if (port) { try { await port.close(); } catch (_) {} port = null; }
    port = selected;
    await port.open({ baudRate: 115200 });
    connected = true;
    keepReading = true;
    receiving = false;
    lastDataMs = Date.now();
    lastReason = '';
    selectedCond = 0;
    tripped = false;
    buildInfo = null; // fresh boot banner arrives after the open-triggered reset
    if (window.SerialLock) SerialLock.claim(); // the dashboard yields to us
    emitStatus();
    loadThermalProfile();
    readLoop();
    startWatchdog();
  }

  async function connect() {
    if (connected || connecting) { logFn('Already connected to the NIR device.'); return; }
    if (!('serial' in navigator)) { logFn('Web Serial not supported in this browser (use Chrome/Edge).'); return; }
    connecting = true;
    try {
      const selected = await navigator.serial.requestPort();
      await openPort(selected);
      logFn('NIR device connected — the session will drive it automatically.');
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      if (/already open|in use|busy|failed to open|access denied/i.test(msg)) {
        logFn('⚠ Port is busy — it is held by the Hardware Dashboard tab. Disconnect it there (or close that tab), then Connect here again.');
      } else if (/no port selected|cancel/i.test(msg)) {
        logFn('Port selection cancelled.');
      } else {
        logFn('Connect failed: ' + msg);
      }
      await hardCleanup('connect failed');
    } finally {
      connecting = false;
    }
  }

  async function tryAutoReconnect() {
    if (connected || connecting) return;
    if (!('serial' in navigator)) return;
    // Don't fight the dashboard: only silently reconnect if no other tab holds it.
    if (window.SerialLock && await SerialLock.isHeldElsewhere()) {
      logFn('Arduino port is in use by the Hardware Dashboard tab — click "Connect NIR Device" to take it over here.');
      return;
    }
    const ports = await navigator.serial.getPorts();
    if (ports.length === 0) return;
    const target = ports.find((p) => p.getInfo().usbVendorId === 0x2341) || ports[0];
    connecting = true;
    try {
      await openPort(target);
      logFn('NIR device reconnected automatically.');
    } catch (e) {
      await hardCleanup(''); // likely the dashboard still holds it; leave manual Connect available
    } finally {
      connecting = false;
    }
  }

  async function disconnect() {
    await hardCleanup('disconnected by operator');
    logFn('NIR device disconnected.');
  }

  // Fully tear down the connection (properly closing the OS port) and report OFFLINE.
  async function hardCleanup(reason) {
    keepReading = false;
    stopWatchdog();
    if (reader) { try { await reader.cancel(); } catch (_) {} reader = null; }
    if (port) { try { await port.close(); } catch (_) {} port = null; }
    connected = false;
    receiving = false;
    buf = '';
    if (reason) lastReason = reason;
    if (window.SerialLock) SerialLock.release();
    emitStatus();
  }

  // Called when the read loop ends while we still intended to read (port died).
  function onUnexpectedDrop() {
    if (!connected) return;
    logFn('⚠ NIR device connection LOST (port closed or USB unplugged).');
    if (stopFn) stopFn('connection lost — port closed or USB unplugged');
    hardCleanup('connection lost');
  }

  // Watchdog: mark "receiving" from actual data flow, and warn if a connected
  // port goes silent (board unpowered / not flashed).
  function startWatchdog() {
    stopWatchdog();
    watchdog = setInterval(() => {
      if (!connected) return;
      const gap = Date.now() - lastDataMs;
      const was = receiving;
      receiving = gap < 3000; // telemetry streams ~1-5 Hz; a 3 s gap = not receiving
      if (was !== receiving) emitStatus();
      if (!receiving && gap > 4000 && gap < 4700) {
        logFn('⚠ Connected to the port but no data from the board for >4 s — is it powered and flashed with firmware/main?');
      }
    }, 1000);
  }
  function stopWatchdog() { if (watchdog) { clearInterval(watchdog); watchdog = null; } }

  async function readLoop() {
    const dec = new TextDecoder();
    while (port && port.readable && keepReading) {
      try {
        reader = port.readable.getReader();
        while (keepReading) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            lastDataMs = Date.now();
            if (!receiving) { receiving = true; emitStatus(); }
            buf += dec.decode(value);
            const lines = buf.split(/\r?\n/);
            buf = lines.pop();
            for (const ln of lines) { try { parseLine(ln.trim()); } catch (_) {} }
          }
        }
      } catch (_) {
        break;
      } finally {
        if (reader) { reader.releaseLock(); reader = null; }
      }
    }
    // The loop exited. If we didn't ask it to, the port dropped underneath us.
    if (keepReading) onUnexpectedDrop();
  }

  function parseLine(line) {
    if (!line) return;

    // Boot banner build identity: "BUILD,PROTOCOL,cutoff=40.0" or
    // "BUILD,BENCH,cutoff=150.0". Printed once per boot by firmware/main, so
    // it arrives on every connect (opening the port resets the Uno). This is
    // the only way the page can know which thermal cutoff is actually flashed.
    if (line.indexOf('BUILD,') === 0) {
      const bp = line.split(',');
      const cutoff = parseFloat((bp[2] || '').split('=')[1]);
      buildInfo = { type: (bp[1] || '').trim(), cutoff: isNaN(cutoff) ? null : cutoff };
      if (buildInfo.type === 'BENCH') {
        logFn('⚠ BENCH FIRMWARE flashed: thermal cutoff is ' + (buildInfo.cutoff ?? '?') +
              ' °C — the 40 °C protection is NOT active. Not for use on a person.');
      } else {
        logFn('Firmware build: ' + buildInfo.type + ' (thermal cutoff ' + buildInfo.cutoff + ' °C).');
      }
      emitStatus();
      return;
    }

    // Boot-time sensor fault
    if (line.indexOf('No temperature sensor') >= 0) {
      tripped = true;
      lastReason = 'temperature sensor not detected';
      emitStatus();
    }

    const parts = line.split(',');
    if (parts.length < 2) return;
    const ev = parts[1].trim();
    const v1 = parts[2] ? parts[2].trim() : '';
    const v2 = parts[3] ? parts[3].trim() : '';

    if (ev === 'TEMP_LOG') {
      const t = parseFloat(v1);
      const est = parts[4] !== undefined ? parseFloat(parts[4]) : NaN;   // absent on older firmware
      if (!isNaN(est)) latestSurfaceEstC = est;
      if (!isNaN(t)) { latestTempC = t; if (tempFn) tempFn(t, isNaN(est) ? null : est); }
      return;
    }
    if (line.indexOf('SURF_MODEL,') === 0) {
      const sp = line.split(',');
      logFn('Surface-temperature model ' + (sp[1] || '?') + ' active; skin-surface cutoff at ' + ((sp[2] || '').split('=')[1] || '?') + ' °C.');
      return;
    }

    switch (ev) {
      case 'MODE_SELECT':
      case 'STIM_START':
      case 'COND_SWITCH': {
        const c = parseInt(v1);
        if (!isNaN(c) && c >= 0) selectedCond = c;
        // NIR light physically on (10/40 Hz only; heating is marked by HEAT_ON).
        if (ev === 'STIM_START' && c >= 1) marker('NIR_ON;cond=' + (COND_CODE[c] || 'unknown'));
        break;
      }
      case 'HEATER':
        marker(v1 === '1' ? 'HEAT_ON' : 'HEAT_OFF');
        break;
      case 'STIM_END':
        // The firmware hit its own stimulation ceiling and stopped — a real dropout.
        marker('STIM_OFF');
        lastReason = 'firmware stimulation time-limit reached';
        if (stopFn) stopFn(lastReason);
        emitStatus();
        break;
      case 'STIM_STOP':
        marker('STIM_OFF');
        break;
      case 'STATE_CHANGE':
        // <us>,STATE_CHANGE,<from>,<to>; state 0 = IDLE. Returning to IDLE clears a trip
        // (e.g. after a successful 'R' reset once the temperature has recovered).
        if (parseInt(v2) === 0 && tripped) { tripped = false; emitStatus(); }
        break;
      case 'SAFETY_TRIP':
        tripped = true;
        marker('SAFETY_TRIP');
        lastReason = 'SAFETY SHUTDOWN — ' + (v1 || 'temperature cutoff (≥40 °C)');
        logFn('⚠ NIR device SAFETY_TRIP: ' + (v1 || ''));
        if (stopFn) stopFn(lastReason);
        emitStatus();
        break;
      default:
        break;
    }
  }

  // --- Command send ---
  async function send(ch) {
    if (!port || !port.writable) {
      logFn("Cannot send '" + ch + "': serial port not writable (not connected).");
      return false;
    }
    try {
      const w = port.writable.getWriter();
      await w.write(new TextEncoder().encode(ch));
      w.releaseLock();
      return true;
    } catch (e) {
      logFn('Send failed: ' + e.message);
      return false;
    }
  }

  function waitForCond(target, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function poll() {
        if (selectedCond === target) return resolve(true);
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(poll, 25);
      })();
    });
  }

  /**
   * Drive the board to `condName` and start stimulation for the run.
   * Returns true if it started the requested condition.
   */
  async function runCondition(condName) {
    if (!connected) {
      logFn('⚠ NIR device NOT connected — "' + condName + '" will run with NO stimulation. Click "Connect NIR Device".');
      return false;
    }
    if (tripped) {
      logFn('⚠ NIR device is in SAFETY_TRIP — cannot stimulate. Reset it on the hardware dashboard first.');
      return false;
    }
    const target = COND_INDEX[condName];
    if (target === undefined) { // unknown -> ensure OFF
      await send('x');
      logFn(condName + ' — NIR and heater kept OFF.');
      return true;
    }
    // Ensure IDLE, then cycle to the target condition.
    await send('x');
    await sleep(150);
    let guard = 0;
    while (selectedCond !== target && guard++ < 5) {
      await send('m');
      await waitForCond(target, 600);
    }
    if (selectedCond !== target) {
      logFn('⚠ Could not select "' + condName + '" on the device (still on ' + selectedCond + ').');
      return false;
    }
    // Heating: a session-replay provider (the task page replaying this participant's
    // NIR device-temperature trajectory) takes precedence over the static profile.
    const replayTarget = (target === 0 && heaterTargetFn) ? heaterTargetFn() : null;
    if (target === 0 && typeof replayTarget === 'number' && Number.isFinite(replayTarget)) {
      await send('H' + replayTarget.toFixed(2) + '\n');
      await sleep(50);
      logFn('Heating target ' + replayTarget.toFixed(2) + ' °C (replaying this session\'s NIR device-temperature trajectory).');
    } else if (target === 0 && profileCalibrated && typeof heatingRiseC === 'number') {
      if (typeof latestTempC === 'number') {
        const setpoint = latestTempC + heatingRiseC;
        await send('H' + setpoint.toFixed(2) + '\n');
        await sleep(50);
        logFn('Heating target ' + setpoint.toFixed(2) + ' °C = baseline ' +
              latestTempC.toFixed(2) + ' + NIR rise ' + heatingRiseC.toFixed(2) + ' °C.');
      } else {
        logFn('⚠ No baseline temp reading yet — heating uses the firmware default this run.');
      }
    }
    await send('g');
    logFn('NIR device: started "' + condName + '".');
    return true;
  }

  /** Register (or clear with null) a function returning the heating target in C. */
  function setHeaterTargetProvider(fn) { heaterTargetFn = (typeof fn === 'function') ? fn : null; }

  /** Push a heating target to the firmware now (it clamps to its own safe range). */
  async function setHeaterTarget(tempC) {
    if (!connected || !Number.isFinite(tempC)) return false;
    return send('H' + tempC.toFixed(2) + '\n');
  }

  /** Stop stimulation and return the board to IDLE (called at run end/abort). */
  async function stop() {
    if (!connected) return;
    await send('x');
  }

  /**
   * Clear a latched safety trip ('R'). The firmware re-measures and only returns to
   * IDLE if the temperature is back below the 40 C cutoff, so call this once cooled.
   * Resolves true if the trip actually cleared.
   */
  async function resetTrip() {
    if (!connected) return false;
    await send('r');
    const start = Date.now();
    while (tripped && Date.now() - start < 2500) await sleep(120);
    return !tripped;
  }

  return {
    connect, disconnect, tryAutoReconnect,
    runCondition, stop, resetTrip,
    setHeaterTargetProvider, setHeaterTarget,
    isConnected: () => connected,
    isReceiving: () => receiving,
    isTripped: () => tripped,
    getTemp: () => latestTempC,
    getSurfaceEst: () => latestSurfaceEstC,
    getBuildInfo: () => buildInfo,
    setLogger, setOnStatus, setOnTemp, setOnStop,
  };
})();
