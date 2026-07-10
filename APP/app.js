/**
 * @file app.js
 * @brief High-precision Reaction Time Task Experiment Engine.
 * 
 * Implements the experiment UI, auditory stimulus delivery via Web Audio API,
 * microsecond-precision keyboard response capture, real-time statistics,
 * data plotting, and persistent session storage.
 * 
 * Task Protocol:
 * - Session duration: 40 seconds (20 seconds for the silent Wrist EMG run).
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
let pauseTimer = null;          // Timer for rest phase countdowns
let sessionTimer = null;
let stimulusTimer = null;
let responseTimer = null;       // Response-window timer; fires a NO_RESPONSE miss if no press arrives in time

// Timing boundaries
const SESSION_DURATION_MS = 40000; // 40 seconds
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
window.addEventListener('load', () => {
  loadRunsHistory();
  logToConsole('SYSTEM', 'Ready. Enter details and click Start Session.');
});

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

  // If in the Wrist EMG condition, ignore spacebar clicks
  const currentCondition = sessionConditions[currentRunIndex];
  if (currentCondition === 'Wrist EMG') return;

  // Handle keypress inside active trial
  const timeOffsetSec = (pressTime - trialStartPerfTime) / 1000;

  if (awaitingResponse) {
    // Valid stimulus response
    awaitingResponse = false;
    clearTimeout(stimulusTimer);
    clearTimeout(responseTimer); // press arrived in time -> cancel the pending miss

    const latencyMs = pressTime - stimulusPerfTime;
    reactionTimes.push(latencyMs);
    
    currentTrialData.logs.push({
      timeSec: timeOffsetSec.toFixed(3),
      eventType: 'RESPONSE',
      latencyMs: latencyMs.toFixed(2)
    });

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
    
    currentTrialData.logs.push({
      timeSec: timeOffsetSec.toFixed(3),
      eventType: 'PREMATURE_PRESS',
      latencyMs: null
    });

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
  
  // Set States
  sessionActive = true;
  currentRunIndex = 0;
  inPausePhase = false;
  
  // Shuffle conditions
  const conditions = ['Heating Control', '10 Hz NIR', '40 Hz NIR', 'Wrist EMG'];
  sessionConditions = shuffle([...conditions]);
  elSequenceDisplay.textContent = sessionConditions.join(' ➔ ');

  // Save session details
  currentSessionData = {
    participantId: participantId,
    sessionId: sessionId,
    startTime: Date.now(),
    endTime: 0,
    conditionsSequence: [...sessionConditions],
    runs: []
  };

  // Lock configuration inputs
  elParticipantId.disabled = true;
  elSessionRun.disabled = true;
  elPauseDuration.disabled = true;
  elBtnStart.disabled = true;
  elBtnAbort.disabled = false;

  // Toggle View layout
  elParticipantArea.classList.add('active-trial');
  elInfoOverlay.style.opacity = '0';
  elInfoOverlay.style.transform = 'translateY(-20px)';
  setTimeout(() => {
    elInfoOverlay.style.display = 'none';
  }, 400);

  logToConsole('SYSTEM', `STARTING SESSION: ${participantId} | Session: ${sessionId} | Sequence: [${sessionConditions.join(', ')}]`);

  // Start the first run!
  startRun();
}

/**
 * @brief Begins an experimental run (either 40s or 20s for Wrist EMG).
 */
function startRun() {
  if (!sessionActive) return;

  const currentCondition = sessionConditions[currentRunIndex];
  const runDurationMs = currentCondition === 'Wrist EMG' ? 20000 : 40000;
  
  trialRunning = true;
  awaitingResponse = false;
  reactionTimes = [];
  falseAlarmsCount = 0;
  missedCount = 0;

  // Reset Run Trial Log
  currentTrialData = {
    condition: currentCondition,
    logs: []
  };

  // Clear previous plotting chart points
  elChartPathLine.setAttribute('d', '');
  elChartDatapoints.innerHTML = '';
  elChartOverlay.classList.remove('hidden');

  // Trigger high-precision clock reference
  trialStartPerfTime = performance.now();
  lastEventPerfTime = trialStartPerfTime;

  logToConsole('SYSTEM', `STARTING RUN ${currentRunIndex + 1}/4: ${currentCondition}`);
  
  currentTrialData.logs.push({
    timeSec: "0.000",
    eventType: 'RUN_START',
    latencyMs: null
  });

  updateStats();

  // Run dynamic countdown clock
  let startMs = Date.now();
  sessionTimer = setInterval(() => {
    let elapsedMs = Date.now() - startMs;
    let remaining = Math.max(0, (runDurationMs - elapsedMs) / 1000);
    elStatsTimeLeft.textContent = `${remaining.toFixed(1)}s`;

    if (elapsedMs >= runDurationMs) {
      endRun();
    }
  }, 100);

  // Schedule first stimulus tone only if not in Wrist EMG condition
  if (currentCondition !== 'Wrist EMG') {
    scheduleNextStimulus();
  }
}

/**
 * @brief Schedules the next sound stimulus at exactly 5s + random [0, 1s] jitter.
 */
function scheduleNextStimulus() {
  if (!trialRunning) return;

  const jitter = Math.random() * JITTER_MAX_MS;
  const totalDelay = BASE_DELAY_MS + jitter;
  
  // Calculate relative scheduling target
  const now = performance.now();
  const timeSpentSinceLastPress = now - lastEventPerfTime;
  const timeRemaining = Math.max(0, totalDelay - timeSpentSinceLastPress);

  stimulusTimer = setTimeout(() => {
    triggerStimulus();
  }, timeRemaining);
}

/**
 * @brief Triggers the stimulus tone and logs the start point.
 */
function triggerStimulus() {
  if (!trialRunning) return;

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

  // Open the response window: if no keypress arrives within RESPONSE_WINDOW_MS the
  // tone is tagged NO_RESPONSE and the run advances to the next stimulus.
  clearTimeout(responseTimer);
  responseTimer = setTimeout(handleMissedResponse, RESPONSE_WINDOW_MS);

  const elapsedSec = (stimulusPerfTime - trialStartPerfTime) / 1000;
  
  currentTrialData.logs.push({
    timeSec: elapsedSec.toFixed(3),
    eventType: 'STIMULUS',
    latencyMs: null
  });

  logToConsole('STIM', `Stimulus triggered at ${elapsedSec.toFixed(3)}s`);
}

/**
 * @brief Fires when the response window closes with no keypress. Tags the tone as a
 *        miss (NO_RESPONSE) and schedules the next stimulus so the run keeps going.
 */
function handleMissedResponse() {
  if (!trialRunning || !awaitingResponse) return;
  awaitingResponse = false;

  const missPerfTime = performance.now();
  const timeOffsetSec = (missPerfTime - trialStartPerfTime) / 1000;

  missedCount++;

  currentTrialData.logs.push({
    timeSec: timeOffsetSec.toFixed(3),
    eventType: 'NO_RESPONSE',
    latencyMs: null
  });

  logToConsole('MISS', `No press within ${(RESPONSE_WINDOW_MS / 1000).toFixed(1)}s — tagged NO_RESPONSE.`);
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

  const currentCondition = sessionConditions[currentRunIndex];
  const runDurationMs = currentCondition === 'Wrist EMG' ? 20000 : 40000;
  
  currentTrialData.logs.push({
    timeSec: (runDurationMs / 1000).toFixed(3),
    eventType: 'RUN_END',
    latencyMs: null
  });

  logToConsole('SYSTEM', `RUN ${currentRunIndex + 1}/4 (${currentCondition}) COMPLETED.`);

  // Save data for the current run into the session object
  currentSessionData.runs.push({
    condition: currentCondition,
    logs: [...currentTrialData.logs],
    reactionTimes: [...reactionTimes],
    falseAlarmsCount: falseAlarmsCount,
    missedCount: missedCount
  });

  // Persist every completed run immediately (not just at session end).
  saveSessionToStorage();

  // Decide if we go to pause or end the session (4 runs total now)
  if (currentRunIndex < 3) {
    // Start intermediate pause phase
    startPausePhase();
  } else {
    // All 4 runs complete!
    completeSession();
  }
}

/**
 * @brief Manages intermediate pause countdown before launching the next run.
 */
function startPausePhase() {
  inPausePhase = true;
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
    Run ${currentRunIndex + 1} completed.<br>
    Please keep eyes closed and rest.<br>
    <strong style="color: var(--accent-secondary); font-size: 1.15rem;">Next condition starts in ${remainingPauseSec}s</strong>
  `;
  elStatsTimeLeft.textContent = `Rest: ${remainingPauseSec}s`;

  pauseTimer = setInterval(() => {
    remainingPauseSec--;
    elStatsTimeLeft.textContent = `Rest: ${remainingPauseSec}s`;
    
    document.getElementById('overlay-instruction').innerHTML = `
      Run ${currentRunIndex + 1} completed.<br>
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

  clearInterval(sessionTimer);
  clearTimeout(stimulusTimer);
  clearTimeout(responseTimer);
  clearInterval(pauseTimer);

  sessionActive = false;
  trialRunning = false;
  inPausePhase = false;

  currentSessionData.endTime = Date.now();
  
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
window.downloadCSV = function(storageKey) {
  const data = JSON.parse(localStorage.getItem(storageKey));
  if (!data) return;

  // Strip commas/newlines from free-text header fields so they can't corrupt the CSV.
  const safe = (v) => String(v == null ? '' : v).replace(/[\r\n,]+/g, ' ');

  let csvContent = "";

  // Header details
  csvContent += `Experiment: NIR tPBM Cognitive Motor Performance Task\r\n`;
  csvContent += `Participant ID: ${safe(data.participantId)}\r\n`;
  csvContent += `Session ID: ${safe(data.sessionId)}\r\n`;
  csvContent += `Generated Sequence: ${safe(data.conditionsSequence.join(' | '))}\r\n`;
  csvContent += `Timestamp: ${new Date(data.startTime).toISOString()}\r\n`;
  csvContent += `--------------------------------------------------\r\n`;
  csvContent += `RunIndex,Condition,RelativeTimeSec,EventType,LatencyMs\r\n`;

  data.runs.forEach((run, runIdx) => {
    run.logs.forEach(log => {
      csvContent += `${runIdx + 1},${safe(run.condition)},${log.timeSec},${log.eventType},${log.latencyMs !== null ? log.latencyMs : '--'}\r\n`;
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
    elStatsRunIdx.textContent = `Run ${currentRunIndex + 1} / 4`;
    elStatsCondition.textContent = sessionConditions[currentRunIndex];
  } else if (sessionActive && inPausePhase) {
    elStatsRunIdx.textContent = `Resting...`;
    if (currentRunIndex + 1 < sessionConditions.length) {
      elStatsCondition.textContent = `Next: ${sessionConditions[currentRunIndex + 1]}`;
    } else {
      elStatsCondition.textContent = `Done`;
    }
  } else if (!sessionActive && currentSessionData.endTime !== 0) {
    elStatsRunIdx.textContent = `4 / 4 Done`;
    elStatsCondition.textContent = `Finished`;
  } else {
    elStatsRunIdx.textContent = `0 / 4`;
    elStatsCondition.textContent = `--`;
  }

  // Update spacebar presses captured (starts at 0 and increments with each spacebar click)
  elStatsCompleted.textContent = reactionTimes.length;
  elStatsErrors.textContent = falseAlarmsCount;

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
