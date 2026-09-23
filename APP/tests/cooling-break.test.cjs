// Regression test: a scheduled cooling break (COOL_START..COOL_END) must be free of
// task events. Before the fix, a spacebar press during an RT break logged FALSE_ALARM
// and started a self-sustaining TONE/OMISSION loop with stimulation off, and the
// second half then ran two racing tone chains. Run: node APP/tests/cooling-break.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');

const constants = ['EMG_PHASE_MS', 'RT_PHASE_MS', 'TEST_EMG_PHASE_MS', 'TEST_RT_PHASE_MS', 'COOLING_BREAK_MS',
  'RESUME_TEMP_C', 'RESUME_SURFACE_C', 'BASE_DELAY_MS', 'JITTER_MAX_MS', 'RESPONSE_WINDOW_MS', 'AUDIO_ATTACK_S'];
const names = ['emgPhaseMs', 'rtPhaseMs', 'phaseSplit', 'handleKeyPress', 'scheduleNextStimulus', 'triggerStimulus',
  'handleMissedResponse', 'startRtPhase', 'coolingBreak', 'resumeRtSecondHalf', 'runPhaseTimer', 'phaseTick',
  'handleThermalShutdown', 'resumeAfterThermal', 'abortTrial', 'logEvent', 'sendMarker'];
const code = constants.map(name => {
  const line = source.match(new RegExp(`^const ${name} = .*$`, 'm'));
  assert.ok(line, `app.js no longer defines ${name}`);
  return line[0];
}).concat(names.map(name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js no longer defines ${name}()`);
  const prefix = source.slice(start - 6, start) === 'async ' ? 'async ' : '';
  const lineEnd = source.indexOf('\n', start);
  const oneLiner = source.slice(start, lineEnd).trimEnd().endsWith('}');
  return prefix + source.slice(start, oneLiner ? lineEnd : source.indexOf('\n}', start) + 2);
})).join('\n');

const TASK_EVENTS = ['TONE', 'RESPONSE', 'FALSE_ALARM', 'OMISSION'];
const space = () => ({ key: ' ', code: 'Space', repeat: false, preventDefault() {} });
const settle = () => new Promise(resolve => setImmediate(resolve));
const noop = () => {};

/** A fresh app instance with a fake clock driving timers, performance.now and Date.now. */
function makeApp() {
  let clock = 0;
  let nextId = 1;
  const timers = new Map();
  const markers = [];
  const stimRequests = [];
  const addTimer = (fn, ms, every) => { timers.set(nextId, { fn, at: clock + Math.max(0, ms || 0), every }); return nextId++; };
  const link = {
    stop: async () => {},
    resetTrip: async () => true,
    runCondition: () => new Promise(resolve => stimRequests.push(resolve)), // real device: ~0.2-3 s
  };
  const context = vm.createContext({
    Date: class extends Date { static now() { return clock; } },
    performance: { now: () => clock },
    setTimeout: (fn, ms) => addTimer(fn, ms, 0),
    setInterval: (fn, ms) => addTimer(fn, ms, ms),
    clearTimeout: id => timers.delete(id),
    clearInterval: id => timers.delete(id),
    window: { LSLMarkers: { send: marker => markers.push(marker) }, ArduinoLink: link },
    ArduinoLink: link,
    trialRunning: true, sessionActive: true, testModeActive: false, inPausePhase: false, runPhase: null,
    inCoolingBreak: false, pausedForThermal: false, resumingThermal: false, pausedPhase: null,
    pausedRemainingMs: 0, pausedOnDone: null, pausedInCooling: false,
    phaseStartMs: 0, phaseDurationMs: 0, phaseOnDone: null,
    sessionTimer: null, stimulusTimer: null, responseTimer: null, pauseTimer: null,
    awaitingResponse: false, trialStartPerfTime: 0, lastEventPerfTime: 0, stimulusPerfTime: 0,
    reactionTimes: [], falseAlarmsCount: 0, missedCount: 0, audioCtx: null,
    currentRunIndex: 0, sessionConditions: ['10 Hz NIR'],
    currentTrialData: { condition: '10 Hz NIR', logs: [] }, currentSessionData: { runs: [] },
    elChartOverlay: { classList: { add: noop, remove: noop } }, elStatsTimeLeft: {},
    recordTemperature: noop, finishTemperatureLog: noop, logToConsole: noop, updateStats: noop,
    plotDataPoints: noop, persistProgress: noop, saveSessionToStorage: noop, resetControlInterface: noop,
    showParticipantMessage: noop, hideParticipantMessage: noop, hideNirAlert: noop,
    triggerVisualFlash: noop, initAudio: noop, playStimulusTone: noop, playTestSound: noop,
    fmtMMSS: String, currentTempC: () => null, endRun: noop,
  });
  vm.runInContext(code + '\nMath.random = () => 0.5;', context);
  const app = {
    context, markers,
    advance(ms) {
      const end = clock + ms;
      for (;;) {
        let due = null;
        for (const entry of timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        clock = due[1].at;
        if (due[1].every) due[1].at += due[1].every; else timers.delete(due[0]);
        due[1].fn();
      }
      clock = end;
    },
    untilBreak() { for (let i = 0; !context.inCoolingBreak; i++) { assert.ok(i < 5000, 'cooling break never started'); app.advance(200); } },
    async releaseStimulation() {
      await settle(); // let callers reach their runCondition() await first
      assert.ok(stimRequests.length > 0, 'nothing was waiting for stimulation to restart');
      stimRequests.splice(0).forEach(resolve => resolve(true));
      await settle();
    },
    pendingStimulusTimers: () => [...timers.values()].filter(t => String(t.fn).includes('triggerStimulus()')).length,
    pendingResponseTimers: () => [...timers.values()].filter(t => t.fn === context.handleMissedResponse).length,
    events: () => context.currentTrialData.logs.map(log => log.eventType),
    taskEventsSince(label) { const e = app.events(); return e.slice(e.lastIndexOf(label) + 1).filter(t => TASK_EVENTS.includes(t)); },
    taskMarkersSince(label) { return markers.slice(markers.lastIndexOf(label) + 1).filter(m => TASK_EVENTS.some(t => m.startsWith(t))); },
  };
  return app;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('spacebar during an RT cooling break is ignored and starts no tone loop', async () => {
  const app = makeApp();
  const { context } = app;
  context.startRtPhase();
  app.untilBreak();
  const falseAlarmsBefore = context.falseAlarmsCount;
  context.handleKeyPress(space());
  assert.equal(context.falseAlarmsCount, falseAlarmsBefore, 'break press counted as a false alarm');
  assert.deepEqual(app.taskEventsSince('COOL_START'), [], 'task event logged during the break');
  assert.equal(app.pendingStimulusTimers(), 0, 'break press scheduled a tone');
  app.advance(vm.runInContext('COOLING_BREAK_MS', context));
  assert.ok(app.events().includes('COOL_END'), 'break did not end');
  assert.deepEqual(app.taskEventsSince('COOL_START'), [], 'TONE/OMISSION loop ran inside COOL_START..COOL_END');
  assert.deepEqual(app.taskMarkersSince('COOL_START'), [], 'task marker sent inside the break');
});

check('press while stimulation restarts after COOL_END is ignored; second half has one tone chain', async () => {
  const app = makeApp();
  const { context } = app;
  context.startRtPhase();
  app.untilBreak();
  app.advance(vm.runInContext('COOLING_BREAK_MS', context)); // break over; runCondition still pending
  assert.ok(app.events().includes('COOL_END'), 'break did not end');
  context.handleKeyPress(space());
  assert.deepEqual(app.taskEventsSince('COOL_START'), [], 'press logged before the second half started');
  await app.releaseStimulation();
  assert.equal(app.pendingStimulusTimers(), 1, 'second half must run exactly one tone chain');
  assert.equal(app.pendingResponseTimers(), 0, 'stale response window survived into the second half');
  app.advance(vm.runInContext('BASE_DELAY_MS + JITTER_MAX_MS', context));
  assert.deepEqual(app.taskEventsSince('COOL_END'), ['TONE'], 'second half must start with exactly one tone');
});

check('stale break-time timers cannot race the second half', async () => {
  const app = makeApp();
  const { context } = app;
  context.startRtPhase();
  app.untilBreak();
  // Plant a leftover break-time chain (pending tone + open response window), then
  // clear the flag the way the COOL_END handler does just before resuming.
  context.inCoolingBreak = false;
  context.triggerStimulus();
  context.scheduleNextStimulus();
  assert.equal(app.pendingStimulusTimers(), 1);
  assert.equal(app.pendingResponseTimers(), 1);
  context.resumeRtSecondHalf();
  assert.equal(app.pendingStimulusTimers(), 1, 'resumeRtSecondHalf left a stale stimulus timer running');
  assert.equal(app.pendingResponseTimers(), 0, 'resumeRtSecondHalf left a stale response window running');
  assert.equal(context.awaitingResponse, false, 'resumeRtSecondHalf kept awaiting a break-time tone');
});

check('thermal trip inside an RT break resumes the break still guarded', async () => {
  const app = makeApp();
  const { context } = app;
  context.startRtPhase();
  app.untilBreak();
  app.advance(10000);
  context.handleThermalShutdown('SAFETY_TRIP');
  const resumed = context.resumeAfterThermal();
  await app.releaseStimulation();
  await resumed;
  app.advance(2500);                  // "good temperature" confirmation delay
  assert.equal(context.pausedForThermal, false);
  assert.equal(context.inCoolingBreak, true, 'resumed break lost its inCoolingBreak flag');
  context.handleKeyPress(space());
  assert.equal(app.pendingStimulusTimers(), 0, 'press in the resumed break scheduled a tone');
  app.advance(context.pausedRemainingMs);
  await app.releaseStimulation();
  assert.deepEqual(app.taskEventsSince('COOL_START'), [], 'task event inside the thermally-interrupted break');
  assert.equal(app.pendingStimulusTimers(), 1, 'second half after an interrupted break must run one tone chain');
});

check('aborting mid-break does not leave the next (unbroken test) session guarded', async () => {
  const app = makeApp();
  const { context } = app;
  context.startRtPhase();
  app.untilBreak();
  context.abortTrial('MANUAL_ABORT');
  assert.equal(context.inCoolingBreak, false, 'abort left inCoolingBreak set');
  Object.assign(context, { sessionActive: true, trialRunning: true, testModeActive: true, currentTrialData: { logs: [] } });
  context.startRtPhase();
  assert.equal(app.pendingStimulusTimers(), 1, 'test-session RT phase scheduled no tones after a mid-break abort');
  context.handleKeyPress(space());
  assert.equal(context.falseAlarmsCount, 1, 'test-session RT phase ignored a premature press');
});

check('tone scheduling, tone onset and miss handling are each inert during a break', async () => {
  const app = makeApp();
  const { context } = app;
  context.startRtPhase();
  app.untilBreak();
  const missedBefore = context.missedCount;
  context.scheduleNextStimulus();
  assert.equal(app.pendingStimulusTimers(), 0, 'scheduleNextStimulus armed a tone during the break');
  context.triggerStimulus();
  assert.equal(context.awaitingResponse, false, 'triggerStimulus opened a response window during the break');
  assert.equal(app.pendingResponseTimers(), 0, 'triggerStimulus armed a miss timer during the break');
  context.awaitingResponse = true; // as if a response window had leaked into the break
  context.handleMissedResponse();
  assert.equal(context.missedCount, missedBefore, 'handleMissedResponse counted a miss during the break');
  assert.equal(app.pendingStimulusTimers(), 0, 'handleMissedResponse armed a tone during the break');
  assert.deepEqual(app.taskEventsSince('COOL_START'), [], 'task event logged during the break');
});

check('scheduling a tone replaces any pending one, so only one tone chain can run', async () => {
  const app = makeApp();
  const { context } = app;
  context.startRtPhase();
  assert.equal(app.pendingStimulusTimers(), 1);
  context.scheduleNextStimulus(); // a caller that did not clear the pending tone first
  assert.equal(app.pendingStimulusTimers(), 1, 'scheduleNextStimulus left a second tone chain pending');
  app.advance(vm.runInContext('BASE_DELAY_MS + JITTER_MAX_MS', context));
  assert.deepEqual(app.events().filter(type => type === 'TONE'), ['TONE'], 'one schedule played more than one tone');
});

let finished = false;
process.on('exit', () => {
  // A never-settling promise would otherwise end the process silently with exit code 0.
  if (!finished) { console.log('Cooling break checks did not finish (a scenario hung).'); process.exitCode = 1; }
});
(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ok   ${name}`); } catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`); }
  }
  finished = true;
  if (failed) { console.log(`Cooling break checks: ${failed} of ${checks.length} failed.`); process.exit(1); }
  console.log(`Cooling break checks passed: ${checks.length} scenarios (break presses, restart window, stale timers, thermal trip in a break, abort mid-break, guarded task functions, single tone chain).`);
})();
