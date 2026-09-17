/**
 * @file app.js
 * @brief High-precision Reaction Time Task Experiment Engine.
 * 
 * Implements the experiment UI, auditory stimulus delivery via Web Audio API,
 * microsecond-precision keyboard response capture, real-time statistics,
 * data plotting, and persistent session storage.
 * 
 * Task Protocol:
 * - Each session (one of 3 conditions) is 17 min: a 10-min silent EMG-baseline phase
 *   (no tones/clicks) then a 7-min reaction-time phase. Stimulation runs throughout.
 * - Stimulus delay: 5.0 seconds base + [0.0, 2.0] seconds random jitter after the last press or miss.
 * - Response window: 2.0 seconds after each tone; if no press arrives it is logged as
 *   NO_RESPONSE and the run continues to the next stimulus (never stalls on a missed press).
 * - Keypress: Space bar (high-precision event capture phase, debounced).
 * - Feedback sound: Programmatically generated non-alarming 600 Hz tone.
 */

// --- Global States ---
let audioCtx = null;
let trialRunning = false;
let sessionActive = false;      // True if the multi-run session is active
let sessionConditions = [];     // Randomized list of conditions for the session
let currentRunIndex = 0;        // Index of the current run (0, 1, 2)
let inPausePhase = false;       // True during intermediate rest phases
let runPhase = null;            // 'EMG' | 'RT' — current phase within the 17-min session
// Thermal-shutdown pause/resume state
let pausedForThermal = false;   // true while the session is frozen waiting for cool-down
let resumingThermal = false;    // guards the async resume so it runs once
let pausedPhase = null;         // which phase to resume ('EMG' | 'RT')
let pausedRemainingMs = 0;      // time left in that phase when it was paused
let pausedOnDone = null;        // the frozen timer's continuation (phase half, next phase, or cooling end)
let pausedInCooling = false;    // the trip landed inside a scheduled cooling break
// Phase-timer bookkeeping (module-level so a thermal pause can freeze/resume it)
let phaseStartMs = 0;
let phaseDurationMs = 0;
let phaseOnDone = null;
let pauseTimer = null;          // Timer for rest phase countdowns
let sessionTimer = null;
let stimulusTimer = null;
let responseTimer = null;       // Response-window timer; fires a NO_RESPONSE miss if no press arrives in time

// Timing boundaries
// Each session (condition) is 17 min: a 10-min silent EMG baseline phase followed
// by a 7-min reaction-time task phase. Stimulation (NIR/heater) runs the whole time.
const EMG_PHASE_MS = 600000;       // 10 minutes — EMG phase (no tones, no clicks)
const RT_PHASE_MS = 420000;        // 7 minutes — reaction-time phase (tones + clicks)

// TEST SESSION (researcher toggle in the config panel): a shortened bench
// dry-run — 5 min EMG + 5 min RT per condition instead of 10 + 7. Markers,
// randomisation, rest pauses and stimulation control are IDENTICAL to a real
// session; only the phase lengths change, and the CSV/log are stamped TEST so
// this data can never pass as a real session. The toggle deliberately does NOT
// touch the thermal cutoff: that lives in firmware (MAX_SAFE_TEMP, compiled),
// and the page can only VERIFY which build is flashed via the boot BUILD line.
const TEST_EMG_PHASE_MS = 5 * 60 * 1000;  // 5 minutes
const TEST_RT_PHASE_MS = 5 * 60 * 1000;   // 5 minutes
let testModeActive = false;        // latched from the checkbox when a session starts
function emgPhaseMs() { return testModeActive ? TEST_EMG_PHASE_MS : EMG_PHASE_MS; }
function rtPhaseMs() { return testModeActive ? TEST_RT_PHASE_MS : RT_PHASE_MS; }

// Mid-phase cooling breaks (REAL sessions only): each phase is split at its
// midpoint and stimulation is switched OFF for a fixed cool-down, so skin
// temperature cannot ramp for 10 (or 7) unbroken minutes. Bench measurements
// (2026-08) showed ~1.5-2.5 C/min climb at protocol duty with no plateau, so
// unbroken phases would cross the 40 C cutoff mid-session. The break is marked
// COOL_START/COOL_END (42/43) - deliberately distinct from SESSION_PAUSE/
// RESUME (40/41), which mean an EMERGENCY thermal shutdown - so analysis can
// separate scheduled pacing from safety events. Delivered light energy per
// condition is unchanged (same total on-time); only the pacing changes.
// Test sessions run their phases unbroken.
const COOLING_BREAK_MS = 90000;    // 1.5 minutes, stimulation off
let inCoolingBreak = false;        // true while a scheduled cooling break runs
function phaseSplit() { return !testModeActive; }
function sessionShape() {
  const m = (ms) => (ms / 60000).toFixed(1).replace(/\.0$/, '');
  const base = `${m(emgPhaseMs())} EMG + ${m(rtPhaseMs())} RT`;
  if (!phaseSplit()) return `${m(emgPhaseMs() + rtPhaseMs())} min: ${base}`;
  const total = emgPhaseMs() + rtPhaseMs() + 2 * COOLING_BREAK_MS;
  return `${m(total)} min: ${base}, each phase split by a ${m(COOLING_BREAK_MS)} min cooling break`;
}
const RESUME_TEMP_C = 37.5;        // after a thermal shutdown, auto-resume once temp cools to this
const BASE_DELAY_MS = 5000;        // 5 seconds
const JITTER_MAX_MS = 2000;        // 2 second jitter range (0 to 2s)
const RESPONSE_WINDOW_MS = 2000;   // Wait this long for a press after a tone; no press -> NO_RESPONSE and the run continues
const AUDIO_ATTACK_S = 0.01;       // 10ms tone attack; audible onset is offset by this
const MAX_CONSOLE_LINES = 500;     // cap console DOM growth during long sessions

// Complete session database structure
let currentSessionData = {
  participantId: '',
  sessionId: '',
  startTime: 0,
  endTime: 0,
  conditionsSequence: [],
  runs: [] // Array of run objects: { condition, logs, reactionTimes, falseAlarmsCount }
};

// Current run metrics
let currentTrialData = {
  condition: '',
  logs: [] // Array of event objects: { timeSec, eventType, latencyMs }
};

let reactionTimes = [];  // Valid reaction times (ms) for current run
let falseAlarmsCount = 0;
let missedCount = 0;     // Omissions: tones with no keypress within the response window
let soundVolume = 0.25;

// High precision timing variables
let trialStartPerfTime = 0;   // performance.now() at run start
let lastEventPerfTime = 0;    // performance.now() at last press / start
let stimulusPerfTime = 0;     // performance.now() when stimulus played
let awaitingResponse = false;

// --- DOM References ---
const elParticipantId = document.getElementById('participant-id');
const elSessionRun = document.getElementById('session-run');
const elPauseDuration = document.getElementById('pause-duration');
const elSequenceDisplay = document.getElementById('sequence-display');
const elStatsRunIdx = document.getElementById('stats-run-idx');
const elStatsCondition = document.getElementById('stats-condition');
const elStatsCompleted = document.getElementById('stats-completed');
const elStatsAvgRt = document.getElementById('stats-avg-rt');
const elStatsErrors = document.getElementById('stats-errors');
const elStatsMisses = document.getElementById('stats-misses');
const elStatsTimeLeft = document.getElementById('stats-time-left');

const elBtnStart = document.getElementById('btn-start');
const elBtnAbort = document.getElementById('btn-abort');
const elBtnTestSound = document.getElementById('btn-test-sound');
const elSoundVol = document.getElementById('sound-vol');

const elConsoleOutput = document.getElementById('console-output');
const elRunsHistory = document.getElementById('runs-history');
const elParticipantArea = document.getElementById('participant-area');
const elInfoOverlay = document.getElementById('info-overlay');
const elChartOverlay = document.getElementById('chart-overlay');
const elStimFlash = document.getElementById('stim-flash');

const elChartPathLine = document.getElementById('chart-path-line');
const elChartDatapoints = document.getElementById('chart-datapoints');

// --- SVG Gradient Setup (Programmatic) ---
setupSvgGradient();

// --- Event Listeners ---
const elNirConnect = document.getElementById('btn-nir-connect');
const elNirStatus = document.getElementById('nir-link-status');
const elStatsTemp = document.getElementById('stats-temp');
const elNirAlert = document.getElementById('nir-alert');
const elNirAlertText = document.getElementById('nir-alert-text');

window.addEventListener('load', () => {
  loadRunsHistory();
  // Keep the calibration card's duration line honest when the test toggle flips.
  const elTestModeCb = document.getElementById('test-mode');
  const elDurationVal = document.getElementById('session-duration-val');
  const elTestModeDescription = document.getElementById('test-mode-description');
  if (elTestModeDescription) {
    elTestModeDescription.textContent = `Test session — bench dry-run (${TEST_EMG_PHASE_MS / 60000} min EMG + ${TEST_RT_PHASE_MS / 60000} min RT per condition; CSV stamped TEST)`;
  }
  if (elTestModeCb && elDurationVal) {
    const updateDurationLabel = () => {
      const emgMs = elTestModeCb.checked ? TEST_EMG_PHASE_MS : EMG_PHASE_MS;
      const rtMs = elTestModeCb.checked ? TEST_RT_PHASE_MS : RT_PHASE_MS;
      if (elTestModeCb.checked) {
        // Test sessions run their phases unbroken.
        elDurationVal.textContent = `${(emgMs + rtMs) / 60000} min (${emgMs / 60000} EMG + ${rtMs / 60000} reaction-time) — TEST`;
      } else {
        const total = (emgMs + rtMs + 2 * COOLING_BREAK_MS) / 60000;
        elDurationVal.textContent = `${total} min (${emgMs / 60000} EMG + ${rtMs / 60000} reaction-time, each split by a ${COOLING_BREAK_MS / 60000} min cooling break)`;
      }
    };
    elTestModeCb.addEventListener('change', updateDurationLabel);
    updateDurationLabel();
  }
  // Connect to the LSL marker bridge (best-effort; the task runs fine without it).
  if (window.LSLMarkers) LSLMarkers.connect({ logger: (m) => logToConsole('LSL', m) });

  // Wire the NIR device link: the task page drives the Arduino stimulation itself.
  if (window.ArduinoLink) {
    ArduinoLink.setLogger((m) => logToConsole('NIR', m));
    ArduinoLink.setOnStatus(updateNirStatus);
    ArduinoLink.setOnTemp(onDeviceTemp);             // temp monitor + thermal-recovery watch
    ArduinoLink.setOnStop(onDeviceStop);             // stop-reason alert + thermal pause
    if (elNirConnect) elNirConnect.addEventListener('click', () => {
      if (ArduinoLink.isConnected()) ArduinoLink.disconnect();
      else ArduinoLink.connect();
    });
    // Reconnect silently if this origin already has permission for the port.
    ArduinoLink.tryAutoReconnect();
  }

  logToConsole('SYSTEM', 'Ready. Enter details and click Start Session.');
});

/**
 * @brief Reflects the NIR device connection in the sidebar status chip.
 *        OFFLINE / CONNECTED (no data) / RECEIVING / TRIPPED — "RECEIVING" means
 *        the board is genuinely streaming telemetry, so a good connection is clear.
 */
function updateNirStatus(s) {
  if (!elNirStatus) return;
  if (!s.connected) {
    elNirStatus.textContent = '● OFFLINE';
    elNirStatus.style.color = 'var(--text-muted)';
  } else if (s.tripped) {
    elNirStatus.textContent = '● TRIPPED';
    elNirStatus.style.color = 'var(--color-danger)';
  } else if (!s.receiving) {
    elNirStatus.textContent = '● CONNECTED (no data)';
    elNirStatus.style.color = 'var(--color-warning)';
  } else {
    elNirStatus.textContent = '● RECEIVING';
    elNirStatus.style.color = 'var(--color-success)';
  }
  if (elNirConnect) elNirConnect.textContent = s.connected ? 'Disconnect NIR Device' : 'Connect NIR Device';
  // Clear the stop alert once the device is healthy and streaming again.
  if (s.connected && s.receiving && !s.tripped) hideNirAlert();
}

/**
 * @brief Live contact-temperature readout (fed from every TEMP_LOG telemetry line).
 */
function updateTempMonitor(tempC) {
  if (!elStatsTemp) return;
  elStatsTemp.textContent = tempC.toFixed(1) + ' °C';
  elStatsTemp.style.color = tempC >= 39 ? 'var(--color-danger)'
    : tempC >= 38 ? 'var(--color-warning)' : 'var(--accent-secondary)';
}

/**
 * @brief Prominently surface WHY the NIR/heater stopped (thermal trip, sensor
 *        fault, firmware time-limit, connection lost) — on screen and in the console.
 */
function showNirAlert(reason) {
  logToConsole('ERROR', 'STIMULATION STOPPED: ' + reason);
  if (elNirAlert && elNirAlertText) {
    elNirAlertText.textContent = reason;
    elNirAlert.style.display = 'block';
  }
}

function hideNirAlert() {
  if (elNirAlert) elNirAlert.style.display = 'none';
}

// --- Thermal shutdown: pause the session, wait for cool-down, auto-resume ---

/** Temperature updates: refresh the monitor and, if paused, watch for recovery. */
function onDeviceTemp(tempC) {
  if (sessionActive && Number.isFinite(tempC)) recordTemperature('TEMPERATURE', tempC);
  updateTempMonitor(tempC);
  if (pausedForThermal && !resumingThermal && tempC <= RESUME_TEMP_C) {
    resumeAfterThermal();
  }
}

/** Device stopped: show the reason, and if it's a safety trip during a live session, pause it. */
function onDeviceStop(reason) {
  showNirAlert(reason);
  if (sessionActive && !pausedForThermal && window.ArduinoLink && ArduinoLink.isTripped()) {
    handleThermalShutdown(reason);
  }
}

/**
 * @brief A safety cutoff fired mid-session: freeze the current phase (stop tones and
 *        the countdown, remember the time left) and wait for the temperature to recover.
 *        SAFETY_TRIP(99) is already sent by the device layer; we add SESSION_PAUSE.
 */
function handleThermalShutdown(reason) {
  if (!runPhase) return; // not inside an active phase
  pausedForThermal = true;
  recordTemperature('THERMAL_PAUSE');
  pausedPhase = runPhase;
  pausedRemainingMs = Math.max(0, phaseDurationMs - (Date.now() - phaseStartMs));
  // With split phases the timer's continuation differs per segment (first half ->
  // cooling break, cooling -> second half, second half -> next phase), so resume
  // must run the FROZEN continuation, not a hardcoded next phase.
  pausedOnDone = phaseOnDone;
  pausedInCooling = inCoolingBreak;

  clearInterval(sessionTimer);
  clearTimeout(stimulusTimer);
  clearTimeout(responseTimer);
  awaitingResponse = false;

  const leftS = Math.round(pausedRemainingMs / 1000);
  logToConsole('ERROR', `THERMAL SHUTDOWN — session PAUSED in the ${pausedPhase} phase (${leftS}s left). ${reason}`);
  logEvent(((performance.now() - trialStartPerfTime) / 1000).toFixed(3), 'SESSION_PAUSE', null);
  sendMarker('SESSION_PAUSE');

  elStatsTimeLeft.textContent = 'PAUSED';
  showParticipantMessage('⚠ Paused — Cooling Down',
    `Skin temperature exceeded the 40 °C limit and stimulation was cut for safety.<br>` +
    `The session will resume automatically once it cools to ${RESUME_TEMP_C} °C.`);
}

/**
 * @brief Temperature recovered to the resume threshold: reset the device, restart the
 *        condition's stimulation, announce good temperature, and continue the SAME phase
 *        with the time that was left. Emits SESSION_RESUME to NIC2.
 */
async function resumeAfterThermal() {
  if (!pausedForThermal || resumingThermal) return;
  resumingThermal = true;

  logToConsole('SYSTEM', `Temperature recovered to ≤ ${RESUME_TEMP_C} °C — clearing the trip and resuming.`);

  if (window.ArduinoLink) {
    const ok = await ArduinoLink.resetTrip();            // send 'R' (succeeds since temp < 40)
    if (!ok) {
      logToConsole('ERROR', 'Could not clear the device safety trip — staying paused.');
      resumingThermal = false;
      return;
    }
    await ArduinoLink.runCondition(sessionConditions[currentRunIndex]); // restart stimulation
  }

  logEvent(((performance.now() - trialStartPerfTime) / 1000).toFixed(3), 'SESSION_RESUME', null);
  sendMarker('SESSION_RESUME');
  hideNirAlert();
  showParticipantMessage('✓ Good Temperature — Resuming',
    'Temperature is back to a safe level. Stimulation is back on and the session is continuing.');

  // Brief "good temperature" confirmation, then continue the phase where it left off.
  setTimeout(() => {
    const remaining = pausedRemainingMs;
    const phase = pausedPhase;
    pausedForThermal = false;
    recordTemperature('THERMAL_RESUME');
    resumingThermal = false;
    logToConsole('SYSTEM', `Resumed ${phase} phase (${Math.round(remaining / 1000)}s remaining).`);

    const onDone = pausedOnDone;
    pausedOnDone = null;
    if (pausedInCooling) {
      // The trip landed inside a scheduled cooling break (possible only if the
      // temperature was still over the limit right after stimulation stopped).
      // Stimulation is already back on from the reset above; finish the break's
      // remaining time and let its own completion handler carry on. Rare enough
      // that a slightly warmer break beats more special-case machinery.
      pausedInCooling = false;
      showParticipantMessage('Short Break',
        'A short scheduled break.<br>Please stay still and keep resting — the session continues automatically.');
      runPhaseTimer(remaining, onDone);
    } else if (phase === 'EMG') {
      runPhase = 'EMG';
      showParticipantMessage('EMG Recording',
        'Please rest with your eyes closed.<br>No response is needed during this phase.');
      runPhaseTimer(remaining, onDone);
    } else {
      runPhase = 'RT';
      hideParticipantMessage();
      elChartOverlay.classList.remove('hidden');
      lastEventPerfTime = performance.now();
      scheduleNextStimulus();
      runPhaseTimer(remaining, onDone);
    }
  }, 2500);
}

/**
 * @brief Maps a full condition name to a compact LSL marker code.
 */
function condCode(name) {
  switch (name) {
    case 'Heating Control': return 'Heating';
    case '10 Hz NIR': return '10Hz';
    case '40 Hz NIR': return '40Hz';
    default: return 'unknown';
  }
}

/**
 * @brief Sends an LSL marker via the bridge (no-op if the bridge script/connection is absent).
 */
function sendMarker(marker) {
  if (window.LSLMarkers) window.LSLMarkers.send(marker);
}

elBtnStart.addEventListener('click', startTrial);
elBtnAbort.addEventListener('click', () => abortTrial('MANUAL_ABORT'));
elBtnTestSound.addEventListener('click', playTestSound);
elSoundVol.addEventListener('input', (e) => {
  soundVolume = e.target.value / 100;
});
document.getElementById('btn-clear-console').addEventListener('click', () => {
  elConsoleOutput.innerHTML = '';
});
document.getElementById('btn-clear-history').addEventListener('click', clearAllHistory);

// --- High-Precision Keyboard Event Capture ---
// Listen on the capture phase (third arg: true) to intercept events as early as possible
window.addEventListener('keydown', handleKeyPress, { capture: true, passive: false });

/**
 * @brief Main keyboard handler.
 */
void function initKeyboard() {
  // Named function scope placeholder for module loading if required
}();

function handleKeyPress(e) {
  const pressTime = performance.now();

  // We are only interested in the Space bar
  if (e.key !== ' ' && e.code !== 'Space') return;

  // Stop browser default action (e.g. page scrolling)
  e.preventDefault();

  // Filter out key repeat signals (user holding down space bar)
  if (e.repeat) return;

  if (!trialRunning) {
    // If a session is active but a trial is not currently running (e.g. in a pause), do nothing
    if (sessionActive) return;
    
    // If not running and no session is active, pressing Space bar is a test sound trigger for calibration
    playTestSound();
    return;
  }

  // Spacebar only counts during the reaction-time phase; ignored during EMG, a cooling
  // break (no task, stimulation off) or a thermal pause.
  if (runPhase !== 'RT' || pausedForThermal || inCoolingBreak) return;

  // Handle keypress inside active trial
  const timeOffsetSec = (pressTime - trialStartPerfTime) / 1000;

  if (awaitingResponse) {
    // Valid stimulus response
    awaitingResponse = false;
    clearTimeout(stimulusTimer);
    clearTimeout(responseTimer); // press arrived in time -> cancel the pending miss

    const latencyMs = pressTime - stimulusPerfTime;
    sendMarker('RESPONSE;rt=' + latencyMs.toFixed(1));
    reactionTimes.push(latencyMs);
    logEvent(timeOffsetSec.toFixed(3), 'RESPONSE', latencyMs.toFixed(2));

    logToConsole('PRESS', `Spacebar pressed: RT = ${latencyMs.toFixed(1)} ms`);
    updateStats();
    plotDataPoints();
    persistProgress(); // save immediately so a crash never loses a captured response

    // Prepare next stimulus scheduling 5s + jitter from this key press time
    lastEventPerfTime = pressTime;
    scheduleNextStimulus();

  } else {
    // Premature press (false alarm / anticipation)
    falseAlarmsCount++;
    sendMarker('FALSE_ALARM');
    logEvent(timeOffsetSec.toFixed(3), 'FALSE_ALARM', null);

    logToConsole('ERROR', `Premature press detected! Resetting stimulus delay.`);
    updateStats();
    persistProgress(); // save immediately so false alarms survive a crash too

    // Visual cue for premature press (brief dark red glow)
    triggerVisualFlash(true);

    // Reset the delay timer: schedule sound 5s + jitter from this premature press time
    clearTimeout(stimulusTimer);
    lastEventPerfTime = pressTime;
    scheduleNextStimulus();
  }
}

/**
 * @brief Initialize AudioContext on first user action to comply with browser privacy settings.
 */
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

/**
 * @brief Programmatically generates a clean, soft tone stimulus using Web Audio API.
 * Prevents harsh popping/clicking sounds by applying a smooth amplitude envelope.
 * @param {number} [startTime] AudioContext time to begin the tone. Defaults to "now".
 * @returns {number} The AudioContext time the tone was scheduled to start.
 */
function playStimulusTone(startTime) {
  initAudio();
  if (!audioCtx) return 0;

  const start = (typeof startTime === 'number') ? startTime : audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  // Soft, clear frequency
  osc.type = 'sine';
  osc.frequency.setValueAtTime(600, start);

  // Apply amplitude envelope (10ms attack, 150ms decay)
  gainNode.gain.setValueAtTime(0, start);
  gainNode.gain.linearRampToValueAtTime(soundVolume, start + AUDIO_ATTACK_S); // attack
  gainNode.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);           // 150ms decay

  osc.start(start);
  osc.stop(start + 0.18);

  return start;
}

/**
 * @brief Converts an AudioContext clock time to the performance.now() timeline,
 * including the output (hardware buffer) latency the participant actually hears.
 * This makes measured reaction times reflect true audible onset, not the moment
 * the tone was queued.
 */
function audioTimeToPerf(contextTime) {
  if (!audioCtx) return performance.now();

  let mapCtx = audioCtx.currentTime;
  let mapPerf = performance.now();
  if (typeof audioCtx.getOutputTimestamp === 'function') {
    const ts = audioCtx.getOutputTimestamp();
    if (ts && ts.contextTime != null && ts.performanceTime != null) {
      mapCtx = ts.contextTime;
      mapPerf = ts.performanceTime;
    }
  }
  const outputLatencyMs = (audioCtx.outputLatency || 0) * 1000;
  return mapPerf + (contextTime - mapCtx) * 1000 + outputLatencyMs;
}

function playTestSound() {
  playStimulusTone();
  logToConsole('INFO', 'Test tone played (600Hz Sine).');
}

/**
 * @brief Activates visual stimulation flash overlay (dimmed to avoid breaking blinding).
 */
function triggerVisualFlash(isError = false) {
  elStimFlash.style.backgroundColor = isError ? 'rgba(239, 68, 68, 0.08)' : 'rgba(255, 255, 255, 0.03)';
  elStimFlash.classList.add('flash-active');
  setTimeout(() => {
    elStimFlash.classList.remove('flash-active');
  }, 80);
}

/**
 * @brief Standard array shuffle helper (Fisher-Yates).
 */
function shuffle(array) {
  let currentIndex = array.length, randomIndex;
  while (currentIndex != 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex], array[currentIndex]];
  }
  return array;
}

/**
 * @brief Begins the 3-run experimental session.
 */
function startTrial() {
  initAudio();
  
  const participantId = elParticipantId.value.trim();
  if (!participantId) {
    alert('Please enter a valid Participant ID.');
    return;
  }

  const sessionId = elSessionRun.value.trim();
  if (!sessionId) {
    alert('Please enter a valid Session ID.');
    return;
  }

  const pauseSecInput = parseInt(elPauseDuration.value);
  const pauseDurationSec = isNaN(pauseSecInput) || pauseSecInput < 5 ? 180 : pauseSecInput;

  // Test-session toggle + firmware build gate. The cutoff itself is compiled
  // into the firmware; the page can only verify which build is flashed (from
  // the boot BUILD line) and refuse the dangerous combination.
  const elTestMode = document.getElementById('test-mode');
  const wantTest = !!(elTestMode && elTestMode.checked);
  const build = (window.ArduinoLink && ArduinoLink.getBuildInfo) ? ArduinoLink.getBuildInfo() : null;
  if (!wantTest && build && build.type === 'BENCH') {
    alert('The connected device is running a BENCH firmware build — its thermal cutoff is '
      + (build.cutoff ?? '?') + ' °C, i.e. the 40 °C protection is DISABLED.\n\n'
      + 'A real session must not run on this build. Reflash firmware/main from the main '
      + 'branch, or tick "Test session" for a bench dry-run.');
    return;
  }
  if (wantTest) {
    if (build && build.type === 'PROTOCOL') {
      logToConsole('SYSTEM', 'Test session on a PROTOCOL build: the 40 °C cutoff is ACTIVE and may trip during the test (safe — the session auto-pauses and resumes).');
    } else if (!build) {
      logToConsole('SYSTEM', '⚠ Test session: firmware build unknown (no BUILD line seen — old firmware or not connected). Cannot verify which thermal cutoff is flashed.');
    }
  }
  testModeActive = wantTest;
  if (elTestMode) elTestMode.disabled = true;

  // Set States
  sessionActive = true;
  currentRunIndex = 0;
  inPausePhase = false;
  
  // Shuffle conditions
  const conditions = ['Heating Control', '10 Hz NIR', '40 Hz NIR'];
  sessionConditions = shuffle([...conditions]);
  elSequenceDisplay.textContent = sessionConditions.join(' ➔ ');

  // Save session details
  currentSessionData = {
    participantId: participantId,
    sessionId: sessionId,
    startTime: Date.now(),
    endTime: 0,
    conditionsSequence: [...sessionConditions],
    testMode: testModeActive,
    runs: []
  };
  const temperatureDebug = document.getElementById('temperature-debug');
  temperatureDebug.disabled = true;
  currentSessionData.temperatureLogging = temperatureDebug.checked;
  currentSessionData.temperatureLog = [];
  temperatureStartPerfMs = performance.now();
  temperatureLastSaveMs = temperatureStartPerfMs;
  recordTemperature('SESSION_START', null, currentSessionData.startTime);
  document.getElementById('temperature-log-status').textContent = temperatureDebug.checked
    ? 'Recording — waiting for temperature readings.' : 'Temperature logging is off for this session.';
  persistProgress();

  // Lock configuration inputs
  elParticipantId.disabled = true;
  elSessionRun.disabled = true;
  elPauseDuration.disabled = true;
  elBtnStart.disabled = true;
  elBtnAbort.disabled = false;

  // Toggle View layout. The overlay is NOT hidden here — startEmgPhase immediately
  // repurposes it to show the EMG rest message; the RT phase hides it for the task.
  elParticipantArea.classList.add('active-trial');

  logToConsole('SYSTEM', `STARTING SESSION: ${participantId} | Session: ${sessionId} | Sequence: [${sessionConditions.join(', ')}]`);

  // Start the first session (condition).
  startRun();
}

/**
 * @brief Latest contact temperature from the device (null if not connected). Logged with every event.
 */
function currentTempC() {
  return (window.ArduinoLink && typeof ArduinoLink.getTemp === 'function') ? ArduinoLink.getTemp() : null;
}

// Wall time enables cross-software alignment; monotonic elapsed time exposes clock adjustments.
let temperatureStartPerfMs = 0;
let temperatureLastSaveMs = 0;
function recordTemperature(event, tempC = null, unixMs = Date.now()) {
  if (!currentSessionData.temperatureLogging) return;
  const perfMs = performance.now();
  currentSessionData.temperatureLog.push({
    unixMs,
    elapsedMs: Math.round((perfMs - temperatureStartPerfMs) * 1000) / 1000,
    event,
    tempC,
    runIndex: currentRunIndex + 1,
    condition: sessionConditions[currentRunIndex] || '',
    phase: inPausePhase ? 'REST' : (runPhase || 'TRANSITION'),
    thermalPaused: pausedForThermal
  });
  if (event === 'TEMPERATURE') {
    document.getElementById('temperature-log-status').textContent =
      `Recording: ${tempC.toFixed(2)} °C at ${new Date(unixMs).toISOString()}`;
    // Save during silent EMG and rest too, without writing storage for every sample.
    if (perfMs - temperatureLastSaveMs >= 5000) {
      temperatureLastSaveMs = perfMs;
      persistProgress();
    }
  }
}

function finishTemperatureLog(event) {
  recordTemperature(event, null, currentSessionData.endTime);
  if (currentSessionData.temperatureLogging) {
    const count = currentSessionData.temperatureLog.filter(row => row.event === 'TEMPERATURE').length;
    document.getElementById('temperature-log-status').textContent =
      `Saved ${count} temperature readings. Download Temperature CSV from history.`;
  }
}

/** Format seconds as M:SS for the long (10-17 min) phase countdowns. */
function fmtMMSS(sec) {
  const s = Math.max(0, Math.floor(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** Push an event into the current run log, always stamping the contact temperature. */
function logEvent(timeSec, eventType, latencyMs) {
  currentTrialData.logs.push({ timeSec, eventType, latencyMs, tempC: currentTempC() });
}

/** Show the participant-facing rest/instruction overlay (used during the EMG phase). */
function showParticipantMessage(title, text) {
  document.getElementById('overlay-title').textContent = title;
  document.getElementById('overlay-instruction').innerHTML = text;
  elInfoOverlay.style.display = 'block';
  requestAnimationFrame(() => { elInfoOverlay.style.opacity = '1'; elInfoOverlay.style.transform = 'translateY(0)'; });
  elChartOverlay.classList.add('hidden');
}

function hideParticipantMessage() {
  elInfoOverlay.style.opacity = '0';
  elInfoOverlay.style.transform = 'translateY(-20px)';
  setTimeout(() => { elInfoOverlay.style.display = 'none'; }, 400);
}

/**
 * @brief Begins a session (one condition): 10-min EMG phase then 7-min reaction-time
 *        phase, with NIR/heating stimulation delivered throughout both phases.
 */
function startRun() {
  if (!sessionActive) return;

  const currentCondition = sessionConditions[currentRunIndex];

  trialRunning = true;
  awaitingResponse = false;
  reactionTimes = [];
  falseAlarmsCount = 0;
  missedCount = 0;

  currentTrialData = { condition: currentCondition, logs: [] };

  elChartPathLine.setAttribute('d', '');
  elChartDatapoints.innerHTML = '';

  trialStartPerfTime = performance.now();
  lastEventPerfTime = trialStartPerfTime;

  logToConsole('SYSTEM', `STARTING SESSION ${currentRunIndex + 1}/3: ${currentCondition} (${sessionShape()})${testModeActive ? ' [TEST SESSION]' : ''}`);
  logEvent('0.000', 'SESSION_START', null);
  sendMarker('SESSION_START;cond=' + condCode(currentCondition));

  // Stimulation ON for the whole 17-min session (both phases).
  if (window.ArduinoLink) ArduinoLink.runCondition(currentCondition);

  updateStats();
  startEmgPhase();
}

/**
 * @brief EMG phase (first 10 min): silent baseline — no tones, keypresses ignored.
 */
function startEmgPhase() {
  runPhase = 'EMG';
  recordTemperature('EMG_START');
  awaitingResponse = false;
  logToConsole('SYSTEM', `EMG phase (${(emgPhaseMs()/60000).toFixed(1)} min) — rest, no response needed.`);
  logEvent(((performance.now() - trialStartPerfTime) / 1000).toFixed(3), 'EMG_START', null);
  sendMarker('EMG_START');
  showParticipantMessage('EMG Recording',
    'Please rest with your eyes closed.<br>No response is needed during this phase.<br>The reaction-time task begins afterward.');
  if (phaseSplit()) {
    runPhaseTimer(emgPhaseMs() / 2, () => coolingBreak(resumeEmgSecondHalf));
  } else {
    runPhaseTimer(emgPhaseMs(), startRtPhase);
  }
}

/**
 * @brief Reaction-time phase (last 7 min): tones + spacebar responses, as before.
 */
function startRtPhase() {
  logEvent(((performance.now() - trialStartPerfTime) / 1000).toFixed(3), 'EMG_END', null);
  sendMarker('EMG_END');

  runPhase = 'RT';
  recordTemperature('RT_START');
  logToConsole('SYSTEM', `Reaction-time phase (${(rtPhaseMs()/60000).toFixed(1)} min) — respond to each tone with SPACE.`);
  logEvent(((performance.now() - trialStartPerfTime) / 1000).toFixed(3), 'RT_START', null);
  sendMarker('RT_START');

  hideParticipantMessage();
  elChartOverlay.classList.remove('hidden');
  lastEventPerfTime = performance.now();
  scheduleNextStimulus();
  if (phaseSplit()) {
    runPhaseTimer(rtPhaseMs() / 2, () => coolingBreak(resumeRtSecondHalf));
  } else {
    runPhaseTimer(rtPhaseMs(), endRun);
  }
}

/**
 * @brief Scheduled mid-phase cooling break (real sessions only): stimulation
 *        OFF for COOLING_BREAK_MS, then back on for the phase's second half.
 *        The device layer emits STIM_OFF/HEAT_OFF and NIR_ON/HEAT_ON around it,
 *        so the recording carries physical confirmation of the off-window too.
 */
function coolingBreak(onDone) {
  inCoolingBreak = true;
  recordTemperature('COOL_START');
  clearTimeout(stimulusTimer);
  clearTimeout(responseTimer);
  awaitingResponse = false;
  if (window.ArduinoLink) ArduinoLink.stop();
  logEvent(((performance.now() - trialStartPerfTime) / 1000).toFixed(3), 'COOL_START', null);
  sendMarker('COOL_START');
  logToConsole('SYSTEM', `Mid-${runPhase} cooling break (${COOLING_BREAK_MS / 60000} min) — stimulation off.`);
  showParticipantMessage('Short Break',
    'A short scheduled break.<br>Please stay still and keep resting — the session continues automatically.');
  runPhaseTimer(COOLING_BREAK_MS, async () => {
    recordTemperature('COOL_END');
    logEvent(((performance.now() - trialStartPerfTime) / 1000).toFixed(3), 'COOL_END', null);
    sendMarker('COOL_END');
    if (window.ArduinoLink) await ArduinoLink.runCondition(sessionConditions[currentRunIndex]);
    logToConsole('SYSTEM', `Cooling break over — stimulation back on, ${runPhase} phase resumes.`);
    // Keep task events blocked until the second half actually starts: restarting the
    // device can take seconds, and a press during that restart is not a task response.
    inCoolingBreak = false;
    onDone();
  });
}

/** Second half of the EMG phase, after its cooling break. */
function resumeEmgSecondHalf() {
  showParticipantMessage('EMG Recording',
    'Please rest with your eyes closed.<br>No response is needed during this phase.');
  runPhaseTimer(emgPhaseMs() / 2, startRtPhase);
}

/** Second half of the RT phase, after its cooling break. */
function resumeRtSecondHalf() {
  hideParticipantMessage();
  elChartOverlay.classList.remove('hidden');
  // Start from a clean slate so no timer left over from before the break can run a
  // second tone chain alongside this one.
  clearTimeout(stimulusTimer);
  clearTimeout(responseTimer);
  awaitingResponse = false;
  lastEventPerfTime = performance.now();
  scheduleNextStimulus();
  runPhaseTimer(rtPhaseMs() / 2, endRun);
}

/** Drives the phase countdown display (M:SS) and fires onDone when the phase elapses.
 *  Uses module-level bookkeeping so a thermal shutdown can freeze and later resume it. */
function runPhaseTimer(durationMs, onDone) {
  clearInterval(sessionTimer);
  phaseStartMs = Date.now();
  phaseDurationMs = durationMs;
  phaseOnDone = onDone;
  elStatsTimeLeft.textContent = fmtMMSS(durationMs / 1000);
  sessionTimer = setInterval(phaseTick, 200);
}

function phaseTick() {
  const remaining = (phaseDurationMs - (Date.now() - phaseStartMs)) / 1000;
  elStatsTimeLeft.textContent = fmtMMSS(remaining);
  if (remaining <= 0) {
    clearInterval(sessionTimer);
    const done = phaseOnDone;
    phaseOnDone = null;
    if (done) done();
  }
}

/**
 * @brief Schedules the next sound stimulus at exactly 5s + random [0, 1s] jitter.
 */
function scheduleNextStimulus() {
  if (!trialRunning || pausedForThermal || inCoolingBreak) return;

  const jitter = Math.random() * JITTER_MAX_MS;
  const totalDelay = BASE_DELAY_MS + jitter;
  
  // Calculate relative scheduling target
  const now = performance.now();
  const timeSpentSinceLastPress = now - lastEventPerfTime;
  const timeRemaining = Math.max(0, totalDelay - timeSpentSinceLastPress);

  // Replace, never add: a still-pending tone would run a second chain alongside this one.
  clearTimeout(stimulusTimer);
  stimulusTimer = setTimeout(() => {
    triggerStimulus();
  }, timeRemaining);
}

/**
 * @brief Triggers the stimulus tone and logs the start point.
 */
function triggerStimulus() {
  if (!trialRunning || runPhase !== 'RT' || pausedForThermal || inCoolingBreak) return;

  initAudio();
  // Schedule ~20ms ahead so the tone starts glitch-free on a Web Audio buffer boundary.
  const startAt = audioCtx ? audioCtx.currentTime + 0.02 : 0;
  playStimulusTone(startAt);
  triggerVisualFlash(false);

  // Anchor the reaction-time clock to the actual audible onset (attack + output latency),
  // mapped into the same performance.now() timeline as the keypress capture.
  const audibleOnset = startAt + AUDIO_ATTACK_S;
  stimulusPerfTime = audioCtx ? audioTimeToPerf(audibleOnset) : performance.now();
  awaitingResponse = true;

  // Emit the LSL 'TONE' marker at the audible onset so it lands with the tone in the EEG.
  const stimMarkerDelay = Math.max(0, stimulusPerfTime - performance.now());
  setTimeout(() => sendMarker('TONE'), stimMarkerDelay);

  // Open the response window: if no keypress arrives within RESPONSE_WINDOW_MS the
  // tone is tagged OMISSION and the run advances to the next stimulus.
  clearTimeout(responseTimer);
  responseTimer = setTimeout(handleMissedResponse, RESPONSE_WINDOW_MS);

  const elapsedSec = (stimulusPerfTime - trialStartPerfTime) / 1000;
  logEvent(elapsedSec.toFixed(3), 'TONE', null);
  logToConsole('STIM', `Tone at ${elapsedSec.toFixed(3)}s`);
}

/**
 * @brief Fires when the response window closes with no keypress. Tags the tone as a
 *        miss (NO_RESPONSE) and schedules the next stimulus so the run keeps going.
 */
function handleMissedResponse() {
  if (!trialRunning || !awaitingResponse || inCoolingBreak) return;
  awaitingResponse = false;

  const missPerfTime = performance.now();
  const timeOffsetSec = (missPerfTime - trialStartPerfTime) / 1000;

  missedCount++;
  sendMarker('OMISSION');
  logEvent(timeOffsetSec.toFixed(3), 'OMISSION', null);

  logToConsole('MISS', `No press within ${(RESPONSE_WINDOW_MS / 1000).toFixed(1)}s — tagged OMISSION.`);
  updateStats();
  persistProgress(); // save immediately so omissions survive a crash

  // Keep the run going: schedule the next tone 5s + jitter from the window close.
  lastEventPerfTime = missPerfTime;
  scheduleNextStimulus();
}

/**
 * @brief Concludes the run successfully, logs results, and enters intermediate rest.
 */
function endRun() {
  if (!trialRunning) return;

  // Clear timers immediately to stop stimulate sound and loop
  clearInterval(sessionTimer);
  clearTimeout(stimulusTimer);
  clearTimeout(responseTimer);

  trialRunning = false;
  awaitingResponse = false;
  runPhase = null;

  const currentCondition = sessionConditions[currentRunIndex];
  const tNow = ((performance.now() - trialStartPerfTime) / 1000).toFixed(3);

  logEvent(tNow, 'RT_END', null);
  sendMarker('RT_END');
  logEvent(tNow, 'SESSION_END', null);
  sendMarker('SESSION_END;cond=' + condCode(currentCondition));

  // Stop the Arduino stimulation at session end (board returns to IDLE for the rest).
  if (window.ArduinoLink) ArduinoLink.stop();

  logToConsole('SYSTEM', `SESSION ${currentRunIndex + 1}/3 (${currentCondition}) COMPLETED.`);

  // Save data for the current session into the session object
  currentSessionData.runs.push({
    condition: currentCondition,
    logs: [...currentTrialData.logs],
    reactionTimes: [...reactionTimes],
    falseAlarmsCount: falseAlarmsCount,
    missedCount: missedCount
  });

  // Persist every completed session immediately (not just at the very end).
  saveSessionToStorage();

  // 3 sessions total: pause after the first two, finish after the third.
  if (currentRunIndex < 2) {
    startPausePhase();
  } else {
    completeSession();
  }
}

/**
 * @brief Manages intermediate pause countdown before launching the next run.
 */
function startPausePhase() {
  inPausePhase = true;
  recordTemperature('REST_START');
  clearTimeout(stimulusTimer);
  clearTimeout(responseTimer);
  
  const pauseSecInput = parseInt(elPauseDuration.value);
  const pauseDurationSec = isNaN(pauseSecInput) || pauseSecInput < 5 ? 180 : pauseSecInput;
  let remainingPauseSec = pauseDurationSec;

  const nextCondition = sessionConditions[currentRunIndex + 1];

  logToConsole('SYSTEM', `Entering intermediate pause: ${pauseDurationSec} seconds. Next condition: ${nextCondition}`);
  updateStats();

  // Update participant overlay screen dynamically to show pause
  elInfoOverlay.style.display = 'block';
  setTimeout(() => {
    elInfoOverlay.style.opacity = '1';
    elInfoOverlay.style.transform = 'translateY(0)';
  }, 50);

  // Update the labels in the instruction-box overlay
  document.getElementById('overlay-title').textContent = `Pause Phase (Rest)`;
  document.getElementById('overlay-instruction').innerHTML = `
    Session ${currentRunIndex + 1} of 3 completed.<br>
    Please keep eyes closed and rest.<br>
    <strong style="color: var(--accent-secondary); font-size: 1.15rem;">Next condition starts in ${remainingPauseSec}s</strong>
  `;
  elStatsTimeLeft.textContent = `Rest: ${remainingPauseSec}s`;

  pauseTimer = setInterval(() => {
    remainingPauseSec--;
    elStatsTimeLeft.textContent = `Rest: ${remainingPauseSec}s`;
    
    document.getElementById('overlay-instruction').innerHTML = `
      Session ${currentRunIndex + 1} of 3 completed.<br>
      Please keep eyes closed and rest.<br>
      <strong style="color: var(--accent-secondary); font-size: 1.15rem;">Next condition starts in ${remainingPauseSec}s</strong>
    `;

    if (remainingPauseSec <= 0) {
      clearInterval(pauseTimer);
      inPausePhase = false;
      
      // Hide overlay
      elInfoOverlay.style.opacity = '0';
      elInfoOverlay.style.transform = 'translateY(-20px)';
      setTimeout(() => {
        elInfoOverlay.style.display = 'none';
      }, 400);

      // Increment index and start next run
      currentRunIndex++;
      updateStats();
      startRun();
    }
  }, 1000);
}

/**
 * @brief Concludes the session, displaying summary analytics.
 */
function completeSession() {
  sessionActive = false;
  currentSessionData.endTime = Date.now();
  finishTemperatureLog('SESSION_END');

  // Belt-and-suspenders: make sure the board is stopped at session end.
  if (window.ArduinoLink) ArduinoLink.stop();

  logToConsole('SYSTEM', `ALL RUNS COMPLETED. SESSION FINISHED.`);

  // Save complete session data to storage
  saveSessionToStorage();

  // Show nice completion details in the participant view
  elInfoOverlay.style.display = 'block';
  setTimeout(() => {
    elInfoOverlay.style.opacity = '1';
    elInfoOverlay.style.transform = 'translateY(0)';
  }, 50);

  document.getElementById('overlay-title').textContent = `Session Completed`;
  
  let runsSummaryHtml = '';
  currentSessionData.runs.forEach((r, idx) => {
    const sum = r.reactionTimes.reduce((a, b) => a + b, 0);
    const avg = r.reactionTimes.length > 0 ? (sum / r.reactionTimes.length).toFixed(1) : '--';
    runsSummaryHtml += `
      <div style="margin-top: 0.5rem; font-size: 0.85rem; text-align: left; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); padding: 0.5rem 0.75rem; border-radius: 8px;">
        <strong>Run ${idx + 1}: ${r.condition}</strong><br>
        Avg RT: ${avg} ms | Completed: ${r.reactionTimes.length} | Misses: ${r.missedCount || 0} | False Alarms: ${r.falseAlarmsCount}
      </div>
    `;
  });

  document.getElementById('overlay-instruction').innerHTML = `
    Session data saved successfully. You can download the combined session sheet or individual run files.<br>
    ${runsSummaryHtml}
    <p style="margin-top: 1rem;"><strong style="color: var(--color-success);">Click 'CSV' in the panel history to export the full combined log.</strong></p>
  `;

  // Reset inputs
  resetControlInterface();
}

/**
 * @brief Interrupts the trial, saving partial logs.
 */
function abortTrial(reason) {
  if (!sessionActive) return;
  currentSessionData.endTime = Date.now();
  finishTemperatureLog(`SESSION_ABORTED_${reason}`);

  clearInterval(sessionTimer);
  clearTimeout(stimulusTimer);
  clearTimeout(responseTimer);
  clearInterval(pauseTimer);

  sessionActive = false;
  trialRunning = false;
  inPausePhase = false;
  runPhase = null;
  pausedForThermal = false;
  resumingThermal = false;
  // An abort mid-break never reaches COOL_END; a stale flag would silence the next
  // session's task (test sessions have no break to clear it).
  inCoolingBreak = false;

  // If aborted during an active run, log the abort in the run
  if (currentTrialData && currentTrialData.logs) {
    currentTrialData.logs.push({
      timeSec: ((performance.now() - trialStartPerfTime) / 1000).toFixed(3),
      eventType: `RUN_ABORTED_${reason}`,
      latencyMs: null
    });
    
    // Save partial run data
    currentSessionData.runs.push({
      condition: sessionConditions[currentRunIndex],
      logs: [...currentTrialData.logs],
      reactionTimes: [...reactionTimes],
      falseAlarmsCount: falseAlarmsCount,
      missedCount: missedCount
    });
  }

  // Immediately stop any active NIR/heater stimulation on abort.
  if (window.ArduinoLink) ArduinoLink.stop();

  logToConsole('ERROR', `Session aborted: ${reason}`);

  saveSessionToStorage();
  resetControlInterface();
}

/**
 * @brief Resets input locks and transitions overlays back to idle setup state.
 */
function resetControlInterface() {
  elParticipantId.disabled = false;
  elSessionRun.disabled = false;
  elPauseDuration.disabled = false;
  elBtnStart.disabled = false;
  const elTestModeReset = document.getElementById('test-mode');
  if (elTestModeReset) elTestModeReset.disabled = false;
  document.getElementById('temperature-debug').disabled = false;
  elBtnAbort.disabled = true;

  elStatsTimeLeft.textContent = '40.0s';
  elParticipantArea.classList.remove('active-trial');
  
  // If the session was completed or aborted, we keep the final overlay message visible.
  // Otherwise, reset to default info message.
  if (!sessionActive && currentSessionData.endTime !== 0) {
    // Keep completion overlay on screen
  } else {
    elInfoOverlay.style.display = 'block';
    setTimeout(() => {
      elInfoOverlay.style.opacity = '1';
      elInfoOverlay.style.transform = 'translateY(0)';
    }, 50);
    
    document.getElementById('overlay-title').textContent = `Visual & Auditory Calibration`;
    document.getElementById('overlay-instruction').textContent = `Please ensure the participant is fitted with the EEG cap and NIR headgear.`;
  }

  loadRunsHistory();
}

/**
 * @brief Saves complete session log to localStorage.
 */
function saveSessionToStorage() {
  try {
    const key = `rt-run-${currentSessionData.participantId}-${currentSessionData.startTime}`;
    localStorage.setItem(key, JSON.stringify(currentSessionData));
  } catch (err) {
    console.error('Storage full or error saving data:', err);
  }
}

/**
 * @brief Snapshots the session INCLUDING the in-progress run to localStorage.
 * Called after every keypress so an unexpected crash/refresh keeps the current
 * run's data (finalized runs are already persisted by saveSessionToStorage).
 */
function persistProgress() {
  if (!sessionActive || !currentSessionData.participantId) return;
  try {
    const snapshot = {
      ...currentSessionData,
      participantId: currentSessionData.participantId,
      sessionId: currentSessionData.sessionId,
      startTime: currentSessionData.startTime,
      endTime: currentSessionData.endTime,
      conditionsSequence: currentSessionData.conditionsSequence,
      runs: currentSessionData.runs.slice()
    };
    if (trialRunning && currentTrialData) {
      snapshot.runs.push({
        condition: currentTrialData.condition,
        logs: currentTrialData.logs.slice(),
        reactionTimes: reactionTimes.slice(),
        falseAlarmsCount: falseAlarmsCount,
        missedCount: missedCount,
        inProgress: true
      });
    }
    const key = `rt-run-${currentSessionData.participantId}-${currentSessionData.startTime}`;
    localStorage.setItem(key, JSON.stringify(snapshot));
  } catch (err) {
    console.error('persistProgress failed:', err);
  }
}

/**
 * @brief Reloads and lists past runs from localStorage.
 */
function loadRunsHistory() {
  elRunsHistory.innerHTML = '';
  let itemsFound = false;

  // Retrieve keys in chronological order
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('rt-run-')) {
      keys.push(key);
    }
  }
  keys.sort().reverse(); // Show newest first

  keys.forEach(key => {
    itemsFound = true;
    const data = JSON.parse(localStorage.getItem(key));
    const dateStr = new Date(data.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-info">
        <span class="history-name">${data.participantId} (${data.sessionId})</span>
        <span class="history-meta">${data.conditionsSequence.join(', ')} - ${dateStr}</span>
      </div>
      <button class="btn-download-run" onclick="downloadCSV('${key}')">CSV</button>
    `;
    elRunsHistory.appendChild(item);
    if (data.temperatureLogging && data.temperatureLog) {
      const button = document.createElement('button');
      button.className = 'btn-download-run';
      button.textContent = 'Temperature CSV';
      button.addEventListener('click', () => downloadTemperatureCSV(key));
      item.appendChild(button);
    }
  });

  if (!itemsFound) {
    elRunsHistory.innerHTML = '<p class="empty-history">No runs logged yet in this session.</p>';
  }
}

/**
 * @brief Clears storage history.
 */
function clearAllHistory() {
  if (!confirm('Are you sure you want to permanently delete all session logs?')) return;
  
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('rt-run-')) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));
  
  logToConsole('SYSTEM', 'Saved session history cleared.');
  loadRunsHistory();
}

/**
 * @brief Exports trial data structure as a downloadable CSV.
 */
function temperatureCSV(data) {
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [[
    'ParticipantID', 'SessionID', 'TestMode', 'TimestampUTC', 'UnixTimeMs',
    'ElapsedMonotonicMs', 'Event', 'TemperatureC', 'RunIndex', 'Condition',
    'Phase', 'ThermalPaused', 'TimestampSource'
  ]];
  for (const row of data.temperatureLog || []) {
    rows.push([
      data.participantId, data.sessionId, !!data.testMode,
      new Date(row.unixMs).toISOString(), row.unixMs, row.elapsedMs,
      row.event, row.tempC, row.runIndex, row.condition, row.phase,
      row.thermalPaused, 'computer_receive_time'
    ]);
  }
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

function downloadTemperatureCSV(storageKey) {
  const data = JSON.parse(localStorage.getItem(storageKey));
  if (!data || !data.temperatureLogging) return;
  const blob = new Blob([temperatureCSV(data)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const clean = value => String(value).replace(/[^a-z0-9]/gi, '_').toLowerCase();
  link.href = url;
  link.download = `tpbm_temperature_${clean(data.participantId)}_${clean(data.sessionId)}_${data.startTime}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.downloadCSV = function(storageKey) {
  const data = JSON.parse(localStorage.getItem(storageKey));
  if (!data) return;

  // Strip commas/newlines from free-text header fields so they can't corrupt the CSV.
  const safe = (v) => String(v == null ? '' : v).replace(/[\r\n,]+/g, ' ');

  let csvContent = "";

  // Header details
  csvContent += `Experiment: NIR tPBM Cognitive Motor Performance Task\r\n`;
  if (data.testMode) csvContent += `*** TEST SESSION — shortened bench dry-run, NOT participant data ***\r\n`;
  csvContent += `Participant ID: ${safe(data.participantId)}\r\n`;
  csvContent += `Session ID: ${safe(data.sessionId)}\r\n`;
  csvContent += `Generated Sequence: ${safe(data.conditionsSequence.join(' | '))}\r\n`;
  csvContent += `Timestamp: ${new Date(data.startTime).toISOString()}\r\n`;
  csvContent += `--------------------------------------------------\r\n`;
  csvContent += `SessionIndex,Condition,RelativeTimeSec,EventType,LatencyMs,ContactTempC\r\n`;

  data.runs.forEach((run, runIdx) => {
    run.logs.forEach(log => {
      const temp = (log.tempC === null || log.tempC === undefined) ? '--' : log.tempC;
      csvContent += `${runIdx + 1},${safe(run.condition)},${log.timeSec},${log.eventType},${log.latencyMs !== null ? log.latencyMs : '--'},${temp}\r\n`;
    });
  });

  // Use a Blob object URL (no data-URI length limit for long sessions).
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const downloadLink = document.createElement("a");
  downloadLink.setAttribute("href", url);

  const cleanId = data.participantId.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const cleanSession = data.sessionId.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  downloadLink.setAttribute("download", `tpbm_session_${cleanId}_${cleanSession}.csv`);

  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
  URL.revokeObjectURL(url);
};

/**
 * @brief UI stats calculator.
 */
function updateStats() {
  if (sessionActive && !inPausePhase) {
    const phaseLabel = runPhase === 'EMG' ? ' · EMG' : runPhase === 'RT' ? ' · RT' : '';
    elStatsRunIdx.textContent = `Session ${currentRunIndex + 1} / 3${phaseLabel}`;
    elStatsCondition.textContent = sessionConditions[currentRunIndex];
  } else if (sessionActive && inPausePhase) {
    elStatsRunIdx.textContent = `Resting...`;
    if (currentRunIndex + 1 < sessionConditions.length) {
      elStatsCondition.textContent = `Next: ${sessionConditions[currentRunIndex + 1]}`;
    } else {
      elStatsCondition.textContent = `Done`;
    }
  } else if (!sessionActive && currentSessionData.endTime !== 0) {
    elStatsRunIdx.textContent = `3 / 3 Done`;
    elStatsCondition.textContent = `Finished`;
  } else {
    elStatsRunIdx.textContent = `0 / 3`;
    elStatsCondition.textContent = `--`;
  }

  // Update spacebar presses captured (starts at 0 and increments with each spacebar click)
  elStatsCompleted.textContent = reactionTimes.length;
  elStatsErrors.textContent = falseAlarmsCount;
  if (elStatsMisses) elStatsMisses.textContent = missedCount;

  if (reactionTimes.length > 0) {
    const sum = reactionTimes.reduce((a, b) => a + b, 0);
    const avg = sum / reactionTimes.length;
    elStatsAvgRt.textContent = `${avg.toFixed(1)} ms`;
  } else {
    elStatsAvgRt.textContent = '-- ms';
  }
}

/**
 * @brief Console printer utility.
 */
function logToConsole(type, msg) {
  const line = document.createElement('div');
  line.className = `log-line ${type.toLowerCase()}`;
  
  const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `[${time}] [${type}] ${msg}`;

  elConsoleOutput.appendChild(line);

  // Cap DOM growth: drop the oldest lines once past the limit.
  while (elConsoleOutput.childElementCount > MAX_CONSOLE_LINES) {
    elConsoleOutput.removeChild(elConsoleOutput.firstChild);
  }

  elConsoleOutput.scrollTop = elConsoleOutput.scrollHeight;
}

/**
 * @brief Sets up linear color gradient for SVG charts.
 */
function setupSvgGradient() {
  const svg = document.getElementById('rt-chart');
  
  // Create defs
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  
  // Create gradient
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  grad.setAttribute('id', 'chart-grad');
  grad.setAttribute('x1', '0%');
  grad.setAttribute('y1', '0%');
  grad.setAttribute('x2', '100%');
  grad.setAttribute('y2', '0%');
  
  const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', 'var(--accent-primary)');
  
  const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', 'var(--accent-secondary)');
  
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);
}

/**
 * @brief Dynamic SVG line and scatter graph generator.
 */
function plotDataPoints() {
  const points = currentTrialData.logs;
  if (points.length === 0) return;

  const svgWidth = 500;
  const svgHeight = 150;
  const marginY = 20;
  const displayHeight = svgHeight - (marginY * 2); // 110px

  // Select only keypress responses and premature hits for plotting
  const graphablePoints = points.filter(p => p.eventType === 'RESPONSE' || p.eventType === 'PREMATURE_PRESS');
  if (graphablePoints.length === 0) return;

  elChartDatapoints.innerHTML = '';
  
  let pathD = '';
  const xIncrement = svgWidth / Math.max(10, graphablePoints.length + 1);

  graphablePoints.forEach((pt, index) => {
    const x = xIncrement * (index + 1);
    let y = svgHeight - marginY; // Default y coordinate for bottom axis (0ms / False Alarm)

    const isResponse = pt.eventType === 'RESPONSE';

    if (isResponse && pt.latencyMs) {
      // Scale latency (clamp at 500 ms max, map to SVG space)
      const lat = parseFloat(pt.latencyMs);
      const clampedLat = Math.min(500, Math.max(0, lat));
      // Map 0-500ms to SVG height boundaries
      y = (svgHeight - marginY) - ((clampedLat / 500) * displayHeight);
    }

    // Accumulate path segment if valid response
    if (isResponse) {
      if (pathD === '') {
        pathD = `M ${x} ${y}`;
      } else {
        pathD += ` L ${x} ${y}`;
      }
    }

    // Draw Scatter Circles
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', isResponse ? 4.5 : 3.5);
    circle.setAttribute('class', isResponse ? 'chart-dot' : 'chart-dot premature');
    
    // SVG tooltip
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = isResponse ? `Time: ${pt.timeSec}s | RT: ${pt.latencyMs}ms` : `False Alarm at ${pt.timeSec}s`;
    circle.appendChild(title);

    elChartDatapoints.appendChild(circle);
  });

  elChartPathLine.setAttribute('d', pathD);
}
