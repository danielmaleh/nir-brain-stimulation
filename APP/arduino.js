/**
 * @file arduino.js
 * @brief Web Serial Controller and Telemetry Dashboard for the tPBM Arduino.
 * 
 * Provides interactive bi-directional serial controls and visual rendering of
 * temperature, safety latch states, LED pulses, and heater cycles.
 */

// --- Dashboard State Variables ---
let port = null;
let reader = null;
let writer = null;
let keepReading = false;
let inputBuffer = '';

// Telemetry History
let tempHistory = [];
const MAX_HISTORY_POINTS = 60; // Keep 60 seconds of history at 1Hz poll
const MAX_CONSOLE_LINES = 800; // Cap console DOM growth (pulse logs arrive at ~80/s)
let minTemp = Infinity;
let maxTemp = -Infinity;
let lastTempTime = null;
let tempUpdateRates = [];

// DOM Elements
const btnConnect = document.getElementById('btn-serial-connect');
const btnDisconnect = document.getElementById('btn-serial-disconnect');
const btnCycleMode = document.getElementById('btn-cycle-mode');
const btnStartStim = document.getElementById('btn-start-stim');
const btnStopStim = document.getElementById('btn-stop-stim');
const btnResetSafety = document.getElementById('btn-reset-safety');
const btnSimTemp = document.getElementById('btn-sim-temp');

const connectionBadge = document.getElementById('connection-badge');
const connectionStatusText = document.getElementById('connection-status-text');

const tempDisplayVal = document.getElementById('temp-display-val');
const tempGaugeFill = document.getElementById('temp-gauge-fill');
const tempSessionMin = document.getElementById('temp-session-min');
const tempSessionMax = document.getElementById('temp-session-max');
const tempUpdateRate = document.getElementById('temp-update-rate');
const tempSparkline = document.getElementById('temp-sparkline');

const blockPulse = document.getElementById('block-pulse');
const pulseStatusText = document.getElementById('pulse-status-text');
const blockHeater = document.getElementById('block-heater');
const heaterStatusText = document.getElementById('heater-status-text');

const safetyStatusBox = document.getElementById('safety-status-box');
const safetyIconOk = document.getElementById('safety-icon-ok');
const safetyIconTripped = document.getElementById('safety-icon-tripped');
const safetyTitleText = document.getElementById('safety-title-text');
const safetyDescText = document.getElementById('safety-desc-text');

const arduinoStateVal = document.getElementById('arduino-state-val');
const arduinoConditionVal = document.getElementById('arduino-condition-val');

const consoleOutput = document.getElementById('diag-console-output');
const btnClearConsole = document.getElementById('btn-clear-diag-console');
const logFilters = document.querySelectorAll('.log-filters .filter-btn');

let activeLogFilter = 'all';

// State Mapping
const STATE_NAMES = {
  0: 'IDLE',
  1: 'STIMULATING',
  2: 'REST',
  3: 'SAFETY_TRIP'
};

const CONDITION_NAMES = {
  0: 'Heating Control',
  1: '10 Hz NIR',
  2: '40 Hz NIR',
  3: 'None / Off'
};

// Canvas context for sparkline
let canvasCtx = null;
if (tempSparkline) {
  canvasCtx = tempSparkline.getContext('2d');
  // Handle high-DPI scaling
  const dpr = window.devicePixelRatio || 1;
  const rect = tempSparkline.getBoundingClientRect();
  tempSparkline.width = rect.width * dpr;
  tempSparkline.height = rect.height * dpr;
  canvasCtx.scale(dpr, dpr);
}

// --- Initialize Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
  btnConnect.addEventListener('click', connectSerial);
  btnDisconnect.addEventListener('click', disconnectSerial);
  
  btnCycleMode.addEventListener('click', () => sendCommand('m'));
  btnStartStim.addEventListener('click', () => sendCommand('g'));
  btnStopStim.addEventListener('click', () => sendCommand('x'));
  btnResetSafety.addEventListener('click', () => sendCommand('r'));
  btnSimTemp.addEventListener('click', () => sendCommand('s'));
  
  btnClearConsole.addEventListener('click', clearConsole);
  
  logFilters.forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.target.id === 'btn-clear-diag-console') return;
      logFilters.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeLogFilter = btn.dataset.filter;
      applyLogFilters();
    });
  });

  // Watch for Web Serial API availability
  if (!('serial' in navigator)) {
    logToConsole('Web Serial API is not supported in this browser. Please use Google Chrome or Edge.', 'error');
    btnConnect.disabled = true;
    btnConnect.textContent = 'Serial Unsupported';
  }

  // Handle hardware disconnect event (USB cable pulled)
  navigator.serial?.addEventListener('disconnect', (e) => {
    logToConsole('Serial device physically disconnected.', 'error');
    handleDisconnectCleanup();
  });

  // Render initial flatline canvas
  drawSparkline();

  // If this origin already has permission for a port (e.g. the tab was discarded
  // by Chrome Memory Saver and reloaded), reconnect without prompting.
  tryAutoReconnect();
});

// --- Web Serial Connection Logic ---
async function openPort(selected) {
  logToConsole('Opening port connection (115200 baud)...', 'system');
  port = selected;
  await port.open({ baudRate: 115200 });

  // Toggle connection states
  updateConnectionUI(true);
  keepReading = true;

  // Launch reading loop
  readLoop();
}

async function connectSerial() {
  try {
    logToConsole('Requesting port from user...', 'system');
    const selected = await navigator.serial.requestPort();
    await openPort(selected);
    logToConsole('Connected. Stream running.', 'success');
  } catch (error) {
    console.error('Serial connection failed:', error);
    logToConsole(`Connection failed: ${error.message}`, 'error');
    handleDisconnectCleanup();
  }
}

async function tryAutoReconnect() {
  if (!('serial' in navigator)) return;
  const ports = await navigator.serial.getPorts();
  if (ports.length === 0) return;

  // Prefer a genuine Arduino (USB vendor 0x2341) if several ports were authorized.
  const target = ports.find(p => p.getInfo().usbVendorId === 0x2341) || ports[0];
  try {
    logToConsole('Previously authorized port found — reconnecting automatically...', 'system');
    await openPort(target);
    logToConsole('Auto-reconnected. Note: opening the port resets the Arduino.', 'success');
  } catch (error) {
    // Most likely another tab is holding the port — leave manual Connect available.
    logToConsole(`Auto-reconnect skipped: ${error.message}`, 'system');
    handleDisconnectCleanup();
  }
}

async function disconnectSerial() {
  logToConsole('Disconnecting port...', 'system');
  keepReading = false;
  
  // Abort reader
  if (reader) {
    try {
      await reader.cancel();
    } catch (err) {
      console.warn('Error cancelling reader:', err);
    }
  }
  
  // Close port
  if (port) {
    try {
      await port.close();
    } catch (err) {
      console.warn('Error closing port:', err);
    }
  }

  handleDisconnectCleanup();
  logToConsole('Disconnected by user request.', 'system');
}

function handleDisconnectCleanup() {
  port = null;
  reader = null;
  writer = null;
  keepReading = false;
  inputBuffer = '';
  
  updateConnectionUI(false);
  
  // Reset peripheral states
  blockPulse.classList.remove('active-pulse');
  pulseStatusText.textContent = 'OFF / IDLE';
  blockHeater.classList.remove('active-heater');
  heaterStatusText.textContent = 'OFF / IDLE';
  
  arduinoStateVal.textContent = 'UNKNOWN';
  arduinoConditionVal.textContent = 'UNKNOWN';
  
  tempDisplayVal.textContent = '--.-';
  updateGaugeProgress(20.0); // Reset to cool reading display
}

function updateConnectionUI(isConnected) {
  if (isConnected) {
    connectionBadge.className = 'arduino-badge connected';
    connectionStatusText.textContent = 'CONNECTED';
    
    btnConnect.style.display = 'none';
    btnDisconnect.removeAttribute('disabled');
    
    // Enable command actions
    btnCycleMode.removeAttribute('disabled');
    btnStartStim.removeAttribute('disabled');
    btnStopStim.removeAttribute('disabled');
    btnResetSafety.removeAttribute('disabled');
    btnSimTemp.removeAttribute('disabled');
  } else {
    connectionBadge.className = 'arduino-badge disconnected';
    connectionStatusText.textContent = 'DISCONNECTED';
    
    btnConnect.style.display = 'block';
    btnDisconnect.setAttribute('disabled', 'true');
    
    // Disable command actions
    btnCycleMode.setAttribute('disabled', 'true');
    btnStartStim.setAttribute('disabled', 'true');
    btnStopStim.setAttribute('disabled', 'true');
    btnResetSafety.setAttribute('disabled', 'true');
    btnSimTemp.setAttribute('disabled', 'true');
  }
}

// --- Serial Bi-directional Messaging ---
async function sendCommand(char) {
  if (!port || !port.writable) {
    logToConsole('Cannot send command: Serial port is not writable.', 'error');
    return;
  }
  
  try {
    const textEncoder = new TextEncoder();
    writer = port.writable.getWriter();
    logToConsole(`Sending command character: '${char}'`, 'control');
    await writer.write(textEncoder.encode(char));
    writer.releaseLock();
  } catch (error) {
    console.error('Failed to write to port:', error);
    logToConsole(`Send failed: ${error.message}`, 'error');
    if (writer) writer.releaseLock();
  }
}

// --- Non-blocking Reading Stream Loop ---
async function readLoop() {
  const textDecoder = new TextDecoder();
  
  while (port && port.readable && keepReading) {
    try {
      reader = port.readable.getReader();
      
      while (keepReading) {
        const { value, done } = await reader.read();
        if (done) {
          logToConsole('Reading stream completed.', 'system');
          break;
        }
        
        if (value) {
          const chunkStr = textDecoder.decode(value);
          inputBuffer += chunkStr;
          
          // Split buffer by lines
          const lines = inputBuffer.split(/\r?\n/);
          // Keep the last partial line in buffer
          inputBuffer = lines.pop();
          
          for (const line of lines) {
            parseSerialLine(line.trim());
          }
        }
      }
    } catch (error) {
      console.error('Read loop error:', error);
      logToConsole(`Stream error: ${error.message}`, 'error');
      break;
    } finally {
      if (reader) {
        reader.releaseLock();
        reader = null;
      }
    }
  }
}

// --- Telemetry Event Parser ---
function parseSerialLine(line) {
  if (!line) return;
  
  // 1. Log the raw line to console (categorized)
  let category = 'system';
  if (line.includes('TEMP_LOG') || line.includes('PULSE') || line.includes('HEATER')) {
    category = 'telemetry';
  } else if (line.includes('STATE_CHANGE') || line.includes('MODE_SELECT') || line.includes('SAFETY_TRIP') || line.includes('STIM_')) {
    category = 'control';
  }
  logToConsole(line, category);
  
  // 2. Parse structured telemetry events
  // Log format: TIMESTAMP_US,EVENT_TYPE,VALUE1,VALUE2
  const parts = line.split(',');
  if (parts.length >= 2) {
    const timestampUs = parseInt(parts[0]);
    const eventType = parts[1].trim();
    
    // Confirm first column is indeed a microsecond timestamp (numeric)
    if (!isNaN(timestampUs)) {
      const val1 = parts[2] ? parts[2].trim() : '';
      const val2 = parts[3] ? parts[3].trim() : '';
      
      handleTelemetryEvent(eventType, val1, val2);
    }
  }
}

function handleTelemetryEvent(eventType, val1, val2) {
  switch (eventType) {
    case 'TEMP_LOG': {
      const tempVal = parseFloat(val1);
      const condIdx = parseInt(val2);
      if (!isNaN(tempVal)) {
        updateTemperatureDisplay(tempVal);
      }
      if (!isNaN(condIdx)) {
        updateArduinoConditionDisplay(condIdx);
      }
      break;
    }
    
    case 'PULSE': {
      const pulseOn = val1 === '1';
      updatePulseDisplay(pulseOn);
      break;
    }
    
    case 'HEATER': {
      const heaterOn = val1 === '1';
      updateHeaterDisplay(heaterOn);
      break;
    }
    
    case 'STATE_CHANGE': {
      const newStateIdx = parseInt(val2);
      if (!isNaN(newStateIdx)) {
        updateArduinoStateDisplay(newStateIdx);
      }
      break;
    }
    
    case 'MODE_SELECT': {
      const condIdx = parseInt(val1);
      if (!isNaN(condIdx)) {
        updateArduinoConditionDisplay(condIdx);
      }
      break;
    }
    
    case 'SAFETY_TRIP': {
      triggerSafetyShutdownDisplay(val1 || 'Temperature safety threshold exceeded.');
      break;
    }

    case 'STIM_START': {
      const condIdx = parseInt(val1);
      if (!isNaN(condIdx)) {
        updateArduinoConditionDisplay(condIdx);
      }
      logToConsole('Stimulation started.', 'success');
      break;
    }

    case 'STIM_END':
      logToConsole('Stimulation finished successfully.', 'success');
      break;

    case 'STIM_STOP':
      logToConsole(`Stimulation aborted: ${val1}`, 'warning');
      break;
  }
}

// --- Graphical Element Updates ---

// Update Temperature Meter
function updateTemperatureDisplay(temp) {
  tempDisplayVal.textContent = temp.toFixed(2);
  
  // Tracking Min / Max bounds
  if (temp < minTemp) {
    minTemp = temp;
    tempSessionMin.textContent = minTemp.toFixed(1);
  }
  if (temp > maxTemp) {
    maxTemp = temp;
    tempSessionMax.textContent = maxTemp.toFixed(1);
  }
  
  // Track poll updates for rate logging
  const now = performance.now();
  if (lastTempTime) {
    const elapsedMs = now - lastTempTime;
    const currentRateHz = 1000 / elapsedMs;
    tempUpdateRates.push(currentRateHz);
    if (tempUpdateRates.length > 5) tempUpdateRates.shift();
    const avgRate = tempUpdateRates.reduce((a, b) => a + b, 0) / tempUpdateRates.length;
    tempUpdateRate.textContent = `${avgRate.toFixed(1)} Hz`;
  }
  lastTempTime = now;
  
  // Radial progress calculations
  // Maps 20.0 °C to 40.0 °C onto a scale of 0 to 100%
  updateGaugeProgress(temp);
  
  // Update sparkline history
  tempHistory.push(temp);
  if (tempHistory.length > MAX_HISTORY_POINTS) {
    tempHistory.shift();
  }
  drawSparkline();

  // Handle thermal warnings dynamically if approaching limits
  if (temp >= 39.0) {
    tempDisplayVal.style.color = 'var(--color-danger)';
    if (!safetyStatusBox.classList.contains('tripped')) {
      safetyTitleText.textContent = 'System Status: THERMAL WARNING';
      safetyDescText.textContent = 'Skin contact temperature approaching 40°C threshold.';
      safetyStatusBox.style.backgroundColor = 'rgba(239, 68, 68, 0.05)';
      safetyStatusBox.style.borderColor = 'rgba(239, 68, 68, 0.2)';
    }
  } else if (temp >= 38.0) {
    tempDisplayVal.style.color = 'var(--color-warning)';
    if (!safetyStatusBox.classList.contains('tripped')) {
      safetyTitleText.textContent = 'System Status: ELEVATED';
      safetyDescText.textContent = 'Active warming is occurring.';
      safetyStatusBox.style.backgroundColor = 'rgba(245, 158, 11, 0.05)';
      safetyStatusBox.style.borderColor = 'rgba(245, 158, 11, 0.2)';
    }
  } else {
    tempDisplayVal.style.color = 'var(--text-main)';
    if (!safetyStatusBox.classList.contains('tripped')) {
      safetyTitleText.textContent = 'System Health: SECURE';
      safetyDescText.textContent = 'All parameters within safety thresholds.';
      safetyStatusBox.style.backgroundColor = 'rgba(16, 185, 129, 0.05)';
      safetyStatusBox.style.borderColor = 'rgba(16, 185, 129, 0.2)';
    }
  }
}

function updateGaugeProgress(temp) {
  // Bound temp between 20.0 and 40.0
  const minRange = 20.0;
  const maxRange = 40.0;
  const clamped = Math.max(minRange, Math.min(maxRange, temp));
  const percent = (clamped - minRange) / (maxRange - minRange);
  
  // Circular stroke length = 2 * Math.PI * radius = 2 * 3.14159 * 45 = 282.74
  const strokeLength = 282.74;
  const offset = strokeLength - (percent * strokeLength);
  
  tempGaugeFill.style.strokeDashoffset = offset;
  
  // Dynamic color transition based on temperature
  if (temp < 35.0) {
    tempGaugeFill.style.stroke = 'var(--accent-secondary)'; // Cool Cyan
  } else if (temp < 38.0) {
    tempGaugeFill.style.stroke = 'var(--color-success)'; // Normal Green
  } else if (temp < 39.5) {
    tempGaugeFill.style.stroke = 'var(--color-warning)'; // Warning Amber
  } else {
    tempGaugeFill.style.stroke = 'var(--color-danger)'; // Dangerous Red
  }
}

// Sparkline Canvas Drawing
function drawSparkline() {
  if (!canvasCtx || !tempSparkline) return;
  
  const width = tempSparkline.width / (window.devicePixelRatio || 1);
  const height = tempSparkline.height / (window.devicePixelRatio || 1);
  
  // Clear canvas
  canvasCtx.clearRect(0, 0, width, height);
  
  // Render grid background
  canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
  canvasCtx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 1; i < gridLines; i++) {
    const y = (height / gridLines) * i;
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, y);
    canvasCtx.lineTo(width, y);
    canvasCtx.stroke();
  }
  
  // Draw base safety line at 40 degrees
  const safetyY = getSparklineY(40.0, height);
  canvasCtx.strokeStyle = 'rgba(239, 68, 68, 0.2)';
  canvasCtx.lineWidth = 1;
  canvasCtx.setLineDash([4, 4]);
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, safetyY);
  canvasCtx.lineTo(width, safetyY);
  canvasCtx.stroke();
  canvasCtx.setLineDash([]); // Reset
  
  if (tempHistory.length < 2) {
    // Render flatline
    canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    canvasCtx.lineWidth = 2;
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, height / 2);
    canvasCtx.lineTo(width, height / 2);
    canvasCtx.stroke();
    return;
  }
  
  // Plot temperature data points
  canvasCtx.beginPath();
  const stepX = width / (MAX_HISTORY_POINTS - 1);
  const startX = width - (tempHistory.length - 1) * stepX;
  
  tempHistory.forEach((temp, idx) => {
    const x = startX + idx * stepX;
    const y = getSparklineY(temp, height);
    if (idx === 0) {
      canvasCtx.moveTo(x, y);
    } else {
      canvasCtx.lineTo(x, y);
    }
  });
  
  // Style and stroke the path line
  const gradient = canvasCtx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, 'rgba(139, 92, 246, 0.3)'); // Violet start
  gradient.addColorStop(1, 'var(--accent-secondary)'); // Cyan end
  canvasCtx.strokeStyle = gradient;
  canvasCtx.lineWidth = 2.5;
  canvasCtx.stroke();
  
  // Draw area gradient fill
  canvasCtx.lineTo(width, height);
  canvasCtx.lineTo(startX, height);
  canvasCtx.closePath();
  const fillGrad = canvasCtx.createLinearGradient(0, 0, 0, height);
  fillGrad.addColorStop(0, 'rgba(6, 182, 212, 0.1)');
  fillGrad.addColorStop(1, 'rgba(6, 182, 212, 0)');
  canvasCtx.fillStyle = fillGrad;
  canvasCtx.fill();
}

function getSparklineY(temp, canvasHeight) {
  // Let visual bounds of sparkline be 25.0 °C at bottom and 41.0 °C at top
  const minVisualTemp = 25.0;
  const maxVisualTemp = 41.0;
  const clamped = Math.max(minVisualTemp, Math.min(maxVisualTemp, temp));
  const percent = (clamped - minVisualTemp) / (maxVisualTemp - minVisualTemp);
  // Subtract from height to invert canvas 0,0 top-left origin
  return canvasHeight - (percent * (canvasHeight - 10)) - 5;
}

// Update LEDs Pulse visual display
function updatePulseDisplay(isActive) {
  if (isActive) {
    blockPulse.classList.add('active-pulse');
    pulseStatusText.textContent = 'PULSING (ACTIVE)';
  } else {
    blockPulse.classList.remove('active-pulse');
    pulseStatusText.textContent = 'OFF / IDLE';
  }
}

// Update Heater visual display
function updateHeaterDisplay(isActive) {
  if (isActive) {
    blockHeater.classList.add('active-heater');
    heaterStatusText.textContent = 'ON (HEATING)';
  } else {
    blockHeater.classList.remove('active-heater');
    heaterStatusText.textContent = 'OFF (IDLE)';
  }
}

// State display changes
function updateArduinoStateDisplay(stateIdx) {
  const stateName = STATE_NAMES[stateIdx] || 'UNKNOWN';
  arduinoStateVal.textContent = stateName;
  
  // Set glow indicators based on active state
  if (stateIdx === 0) { // IDLE
    arduinoStateVal.style.color = 'var(--text-muted)';
    resetSafetyDisplay();
  } else if (stateIdx === 1) { // STIMULATING
    arduinoStateVal.style.color = 'var(--accent-secondary)';
  } else if (stateIdx === 2) { // REST
    arduinoStateVal.style.color = 'var(--accent-primary)';
  } else if (stateIdx === 3) { // SAFETY_TRIP
    triggerSafetyShutdownDisplay('Hardware safety cutoff activated.');
  }
}

// Condition display changes
function updateArduinoConditionDisplay(condIdx) {
  const condName = CONDITION_NAMES[condIdx] || 'UNKNOWN';
  arduinoConditionVal.textContent = condName;
  
  if (condIdx === 0) {
    arduinoConditionVal.style.color = 'var(--color-warning)'; // heating control is amber
  } else if (condIdx === 1 || condIdx === 2) {
    arduinoConditionVal.style.color = 'var(--accent-primary)'; // stimulation conditions are violet
  } else {
    arduinoConditionVal.style.color = 'var(--text-muted)';
  }
}

// Safety display alerts
function triggerSafetyShutdownDisplay(reason) {
  safetyStatusBox.className = 'safety-status-box tripped';
  safetyIconOk.style.display = 'none';
  safetyIconTripped.style.display = 'block';
  
  safetyTitleText.textContent = 'SAFETY SHUTDOWN ACTIVE';
  safetyTitleText.style.color = 'var(--color-danger)';
  safetyDescText.textContent = reason;
  
  arduinoStateVal.textContent = 'SAFETY_TRIP';
  arduinoStateVal.style.color = 'var(--color-danger)';
  
  // Clear pulsing blocks visually
  updatePulseDisplay(false);
  updateHeaterDisplay(false);
}

function resetSafetyDisplay() {
  safetyStatusBox.className = 'safety-status-box';
  safetyIconOk.style.display = 'block';
  safetyIconTripped.style.display = 'none';
  
  safetyTitleText.textContent = 'System Health: SECURE';
  safetyTitleText.style.color = 'var(--color-success)';
  safetyDescText.textContent = 'All parameters within safety thresholds.';
}

// --- Telemetry Log Console Helper ---
function logToConsole(text, type = 'system') {
  const logLine = document.createElement('div');
  logLine.className = `log-line ${type}`;
  logLine.dataset.type = type;
  
  // Format timestamp: HH:MM:SS.mmm
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
  
  logLine.textContent = `[${timeStr}] ${text}`;

  consoleOutput.appendChild(logLine);

  // Cap DOM growth: drop the oldest lines once past the limit.
  while (consoleOutput.childElementCount > MAX_CONSOLE_LINES) {
    consoleOutput.removeChild(consoleOutput.firstChild);
  }

  // Auto scroll logic
  consoleOutput.scrollTop = consoleOutput.scrollHeight;

  // Apply active filters immediately to the newly created element
  applyFilterToElement(logLine);
}

function clearConsole() {
  consoleOutput.innerHTML = '<div class="log-line system">[CONSOLE] Console logs cleared.</div>';
}

function applyLogFilters() {
  const lines = consoleOutput.querySelectorAll('.log-line');
  lines.forEach(line => applyFilterToElement(line));
}

function applyFilterToElement(element) {
  const type = element.dataset.type;
  if (!type) return; // Ignore clear notice/system starter notices
  
  if (activeLogFilter === 'all') {
    element.style.display = 'block';
  } else if (activeLogFilter === 'telemetry') {
    if (type === 'telemetry') {
      element.style.display = 'block';
    } else {
      element.style.display = 'none';
    }
  } else if (activeLogFilter === 'controls') {
    if (type === 'control' || type === 'error' || type === 'warning' || type === 'success') {
      element.style.display = 'block';
    } else {
      element.style.display = 'none';
    }
  }
}
