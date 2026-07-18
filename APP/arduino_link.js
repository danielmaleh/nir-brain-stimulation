/**
 * @file arduino_link.js
 * @brief Lets the Experiment Task page (index.html) drive the Arduino NIR/heater
 *        stimulation directly over Web Serial, in sync with each behavioural run.
 *
 * The task page OWNS the serial port for the session (coordinated with the
 * hardware dashboard via serial_lock.js, so the dashboard yields the port). At
 * each run it selects the matching firmware condition and starts stimulation,
 * then stops it when the run ends — so the NIR follows the task's clock (40 s /
 * 20 s), not the firmware's own 60 s timer.
 *
 * Condition mapping (task name -> firmware StimCondition index):
 *   'Heating Control' -> 0,  '10 Hz NIR' -> 1,  '40 Hz NIR' -> 2,  'Wrist EMG' -> none
 *
 * The firmware is driven with its EXISTING command set (no reflash): 'x' to
 * return to IDLE, 'm' to cycle the selected condition (confirmed via MODE_SELECT
 * telemetry), 'g' to start. Because the dashboard is not connected during the
 * session, this module also re-emits the hardware LSL markers (STIM_ON/OFF,
 * HEATER_ON/OFF, SAFETY_TRIP, condition switches) so the EEG still gets them.
 */
window.ArduinoLink = (function () {
  let port = null;
  let reader = null;
  let keepReading = false;
  let buf = '';

  let connected = false;
  let selectedCond = 0;   // firmware's currently-selected condition (0/1/2)
  let tripped = false;    // firmware latched in SAFETY_TRIP
  let logFn = (m) => console.log('[NIR] ' + m);
  let statusFn = null;    // (connected:boolean, tripped:boolean) => void

  const COND_INDEX = { 'Heating Control': 0, '10 Hz NIR': 1, '40 Hz NIR': 2 };
  const COND_CODE = ['Heating', '10Hz', '40Hz']; // for STIM_ON;cond= markers

  // Heating-control target: matched to the NIR thermal plateau by the calibration
  // tool (calibration/calibrate_thermal.py -> APP/thermal_profile.json). Null until
  // loaded; if uncalibrated the firmware keeps its built-in 37.5 C default.
  let heatingTargetC = null;
  let profileCalibrated = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Load the thermal calibration profile (best-effort; served alongside the app).
  async function loadThermalProfile() {
    try {
      const resp = await fetch('thermal_profile.json', { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const p = await resp.json();
      profileCalibrated = !!p.calibrated;
      if (typeof p.heating_target_c === 'number') heatingTargetC = p.heating_target_c;
      if (profileCalibrated) {
        logFn('Thermal calibration loaded: heating-control target = ' + heatingTargetC.toFixed(2) + ' °C (NIR-matched).');
      } else {
        logFn('Thermal profile is NOT calibrated — heating control will use the firmware default (37.5 °C). Run calibrate_thermal.py.');
      }
    } catch (e) {
      logFn('No thermal profile loaded (' + e.message + ') — heating control uses the firmware default.');
    }
  }

  function setLogger(fn) { if (typeof fn === 'function') logFn = fn; }
  function setOnStatus(fn) { statusFn = fn; }
  function emitStatus() { if (statusFn) statusFn(connected, tripped); }
  function marker(m) { if (window.LSLMarkers) window.LSLMarkers.send(m); }

  // --- Connection ---
  async function openPort(selected) {
    port = selected;
    await port.open({ baudRate: 115200 });
    connected = true;
    keepReading = true;
    // Opening the port resets the Uno: it boots to COND_HEATING (0) in IDLE.
    selectedCond = 0;
    tripped = false;
    if (window.SerialLock) SerialLock.claim();
    emitStatus();
    loadThermalProfile();
    readLoop();
  }

  async function connect() {
    if (!('serial' in navigator)) {
      logFn('Web Serial not supported in this browser (use Chrome/Edge).');
      return;
    }
    try {
      // Take the port from the hardware dashboard tab if it holds it.
      if (window.SerialLock && await SerialLock.isHeldElsewhere()) {
        logFn('Taking the Arduino port from the hardware dashboard...');
        await SerialLock.requestTakeover();
      }
      const selected = await navigator.serial.requestPort();
      await openPort(selected);
      logFn('NIR device connected — runs will drive the light automatically.');
    } catch (e) {
      logFn('Connect failed: ' + e.message);
      cleanup();
    }
  }

  async function tryAutoReconnect() {
    if (!('serial' in navigator)) return;
    if (window.SerialLock && await SerialLock.isHeldElsewhere()) {
      logFn('Arduino port is in use by another tab — click "Connect NIR Device" to take it over.');
      return;
    }
    const ports = await navigator.serial.getPorts();
    if (ports.length === 0) return;
    const target = ports.find((p) => p.getInfo().usbVendorId === 0x2341) || ports[0];
    try {
      await openPort(target);
      logFn('NIR device auto-reconnected.');
    } catch (e) {
      logFn('Auto-reconnect skipped: ' + e.message);
      cleanup();
    }
  }

  async function disconnect() {
    keepReading = false;
    if (reader) { try { await reader.cancel(); } catch (_) {} }
    if (port) { try { await port.close(); } catch (_) {} }
    cleanup();
  }

  function cleanup() {
    port = null;
    reader = null;
    keepReading = false;
    buf = '';
    connected = false;
    if (window.SerialLock) SerialLock.release();
    emitStatus();
  }

  // --- Read loop + telemetry parsing (tracks condition, trip, and re-emits markers) ---
  async function readLoop() {
    const dec = new TextDecoder();
    while (port && port.readable && keepReading) {
      try {
        reader = port.readable.getReader();
        while (keepReading) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            buf += dec.decode(value);
            const lines = buf.split(/\r?\n/);
            buf = lines.pop();
            for (const ln of lines) {
              try { parseLine(ln.trim()); } catch (_) {}
            }
          }
        }
      } catch (_) {
        break;
      } finally {
        if (reader) { reader.releaseLock(); reader = null; }
      }
    }
  }

  function parseLine(line) {
    if (!line) return;
    if (line.indexOf('No temperature sensor') >= 0) { tripped = true; emitStatus(); }

    const parts = line.split(',');
    if (parts.length < 2) return;
    const ev = parts[1].trim();
    const v1 = parts[2] ? parts[2].trim() : '';

    switch (ev) {
      case 'MODE_SELECT':
      case 'STIM_START':
      case 'COND_SWITCH': {
        const c = parseInt(v1);
        if (!isNaN(c) && c >= 0) selectedCond = c;
        if (ev === 'STIM_START') marker('STIM_ON;cond=' + (COND_CODE[c] || 'unknown'));
        if (ev === 'COND_SWITCH') marker('STIM_COND_SWITCH;cond=' + (COND_CODE[c] || 'unknown'));
        break;
      }
      case 'HEATER':
        marker(v1 === '1' ? 'HEATER_ON' : 'HEATER_OFF');
        break;
      case 'STIM_END':
      case 'STIM_STOP':
        marker('STIM_OFF');
        break;
      case 'SAFETY_TRIP':
        tripped = true;
        marker('SAFETY_TRIP');
        logFn('NIR device SAFETY_TRIP: ' + (v1 || ''));
        emitStatus();
        break;
      default:
        break;
    }
  }

  // --- Command send ---
  async function send(ch) {
    if (!port || !port.writable) {
      logFn("Cannot send '" + ch + "': serial port not writable.");
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
   * Wrist EMG (or any non-NIR/heater name) -> ensure the board is stopped/OFF.
   * Returns true if it started the requested condition.
   */
  async function runCondition(condName) {
    if (!connected) {
      logFn('⚠ NIR device NOT connected — "' + condName + '" will run with NO light. Click "Connect NIR Device".');
      return false;
    }
    if (tripped) {
      logFn('⚠ NIR device is in SAFETY_TRIP — cannot stimulate. Reset it on the hardware dashboard first.');
      return false;
    }
    const target = COND_INDEX[condName];
    if (target === undefined) { // Wrist EMG or unknown -> no stimulation
      await send('x');
      logFn(condName + ' run — NIR and heater kept OFF.');
      return true;
    }
    // Ensure we start from IDLE, then cycle to the target condition.
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
    // For the heating-control condition, set the heater set point to the
    // NIR-matched temperature from calibration before starting the thermostat.
    if (target === 0 && profileCalibrated && typeof heatingTargetC === 'number') {
      await send('H' + heatingTargetC.toFixed(2) + '\n');
      await sleep(50);
      logFn('Heating-control target set to ' + heatingTargetC.toFixed(2) + ' °C (NIR-matched).');
    }
    await send('g');
    logFn('NIR device: started "' + condName + '".');
    return true;
  }

  /** Stop stimulation and return the board to IDLE (called at run end/abort). */
  async function stop() {
    if (!connected) return;
    await send('x');
  }

  return {
    connect, disconnect, tryAutoReconnect,
    runCondition, stop,
    isConnected: () => connected,
    isTripped: () => tripped,
    setLogger, setOnStatus,
  };
})();
