const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
const names = ['recordTemperature', 'onDeviceTemp', 'finishTemperatureLog', 'temperatureCSV', 'persistProgress', 'abortTrial', 'completeSession'];
const functions = names.map(name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');
let now = 1000;
let wall = 1800000000000;
const elements = {};
const saved = new Map();
const context = vm.createContext({
  Date: class extends Date { static now() { return wall; } },
  performance: { now: () => now },
  document: { getElementById: id => elements[id] ||= { textContent: '', style: {} } },
  localStorage: { setItem: (k, v) => saved.set(k, v) },
  currentSessionData: { participantId: 'P,"1', sessionId: 'S1', startTime: wall, endTime: 0, testMode: true, temperatureLogging: true, temperatureLog: [], runs: [], conditionsSequence: ['Heating Control'] },
  temperatureStartPerfMs: 1000, temperatureLastSaveMs: 1000,
  currentRunIndex: 0, sessionConditions: ['Heating Control'], runPhase: 'EMG',
  sessionActive: true, trialRunning: false, inPausePhase: false,
  pausedForThermal: false, resumingThermal: false, awaitingResponse: false,
  currentTrialData: null, sessionTimer: null, stimulusTimer: null, responseTimer: null, pauseTimer: null,
  clearInterval() {}, clearTimeout() {}, setTimeout() {},
  window: {}, console, updateTempMonitor() {}, resumeAfterThermal() {},
  logToConsole() {}, resetControlInterface() {},
  saveSessionToStorage() { saved.set('final', JSON.stringify(context.currentSessionData)); },
  elInfoOverlay: { style: {} }, RESUME_TEMP_C: 37.5
});
vm.runInContext(functions, context);
context.recordTemperature('SESSION_START', null, wall);
now += 1000; wall += 1000;
context.onDeviceTemp(36.25);
assert.equal(context.currentSessionData.temperatureLog[1].unixMs, wall);
assert.equal(context.currentSessionData.temperatureLog[1].elapsedMs, 1000);
context.inPausePhase = true;
now += 5000; wall += 5000;
context.onDeviceTemp(36.5);
assert.equal(context.currentSessionData.temperatureLog[2].phase, 'REST');
const snapshot = JSON.parse([...saved.values()][0]);
assert.equal(snapshot.temperatureLog.length, 3);
assert.equal(snapshot.testMode, true);
// A backwards wall-clock correction does not reverse monotonic elapsed time.
now += 1000; wall -= 2000;
context.onDeviceTemp(36.75);
assert.equal(context.currentSessionData.temperatureLog[3].elapsedMs, 7000);
context.abortTrial('MANUAL_ABORT');
const aborted = JSON.parse(saved.get('final'));
assert.equal(aborted.temperatureLog.at(-1).event, 'SESSION_ABORTED_MANUAL_ABORT');
assert.equal(aborted.temperatureLog.at(-1).unixMs, aborted.endTime);
const count = aborted.temperatureLog.length;
context.onDeviceTemp(37);
assert.equal(context.currentSessionData.temperatureLog.length, count);
const csv = context.temperatureCSV(aborted);
assert.ok(csv.includes('"P,""1"'));
assert.ok(csv.includes(new Date(wall).toISOString()));
assert.ok(csv.includes('"SESSION_START",""'));
assert.ok(csv.includes('"computer_receive_time"'));
// Normal completion records its boundary before saving, including no-sensor sessions.
context.currentSessionData.temperatureLog = [];
context.sessionActive = true;
context.completeSession();
assert.equal(JSON.parse(saved.get('final')).temperatureLog[0].event, 'SESSION_END');
context.currentSessionData.temperatureLogging = false;
context.recordTemperature('TEMPERATURE', 38);
assert.equal(context.currentSessionData.temperatureLog.length, 1);
console.log('Temperature log checks passed: timestamps, pauses, persistence, abort, completion, disabled logging and CSV escaping.');
