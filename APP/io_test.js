/**
 * @file io_test.js
 * @brief Web Serial Client logic for the Standalone Hardware I/O Diagnostics Suite.
 */

// State Variables
let port = null;
let reader = null;
let writer = null;
let keepReading = false;
let inputBuffer = '';
let streamActive = false;

// DOM Elements - Connection & Controls
const btnConnect = document.getElementById('btn-serial-connect');
const btnDisconnect = document.getElementById('btn-serial-disconnect');
const btnToggleStream = document.getElementById('btn-toggle-stream');
const btnQueryHelp = document.getElementById('btn-query-help');

const connectionBadge = document.getElementById('connection-badge');
const connectionStatusText = document.getElementById('connection-status-text');

// DOM Elements - Outputs
const indLedHeating = document.getElementById('ind-led-heating');
const indLed10hz = document.getElementById('ind-led-10hz');
const indLed40hz = document.getElementById('ind-led-40hz');
const indLedError = document.getElementById('ind-led-error');
const indMosfetLed = document.getElementById('ind-mosfet-led');
const indMosfetHeater = document.getElementById('ind-mosfet-heater');

const btnTestCycleLeds = document.getElementById('btn-test-cycle-leds');
const btnToggleNir = document.getElementById('btn-toggle-nir');
const btnToggleHeater = document.getElementById('btn-toggle-heater');
const btnToggleStby = document.getElementById('btn-toggle-stby');
const indTbStby = document.getElementById('ind-tb-stby');

// DOM Elements - Inputs
const testTempValue = document.getElementById('test-temp-value');

const btnReadTemp = document.getElementById('btn-read-temp');

// DOM Elements - Manual Console
const consoleOutput = document.getElementById('test-console-output');
const btnClearConsole = document.getElementById('btn-clear-test-console');
const manualCmdInput = document.getElementById('manual-cmd-input');
const btnSendManualCmd = document.getElementById('btn-send-manual-cmd');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  btnConnect.addEventListener('click', connectSerial);
  btnDisconnect.addEventListener('click', disconnectSerial);
  
  btnToggleStream.addEventListener('click', () => sendCommand('s'));
  btnQueryHelp.addEventListener('click', () => sendCommand('h'));
  
  btnTestCycleLeds.addEventListener('click', () => sendCommand('c'));
  btnToggleNir.addEventListener('click', () => sendCommand('a'));
  btnToggleHeater.addEventListener('click', () => sendCommand('b'));
  btnToggleStby.addEventListener('click', () => sendCommand('y'));

  btnReadTemp.addEventListener('click', () => sendCommand('t'));
  
  btnClearConsole.addEventListener('click', clearConsole);
  
  btnSendManualCmd.addEventListener('click', sendManualCmd);
  manualCmdInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendManualCmd();
    }
  });

  // Check Web Serial support
  if (!('serial' in navigator)) {
    logToConsole('Web Serial API is not supported in this browser. Please use Chrome or Edge.', 'error');
    btnConnect.disabled = true;
    btnConnect.textContent = 'Serial Unsupported';
  }

  // Handle hardware disconnect event
  navigator.serial?.addEventListener('disconnect', (e) => {
    logToConsole('Serial device physically disconnected.', 'error');
    handleDisconnectCleanup();
  });
});

// --- Web Serial Connection Logic ---
async function connectSerial() {
  try {
    logToConsole('Requesting port from user...', 'system');
    port = await navigator.serial.requestPort();
    
    logToConsole('Opening port connection (115200 baud)...', 'system');
    await port.open({ baudRate: 115200 });
    
    updateConnectionUI(true);
    keepReading = true;
    
    readLoop();
    logToConsole('Connected to Diagnostic Port. Diagnostics ready.', 'success');
  } catch (error) {
    console.error('Serial connection failed:', error);
    logToConsole(`Connection failed: ${error.message}`, 'error');
    handleDisconnectCleanup();
  }
}

async function disconnectSerial() {
  logToConsole('Disconnecting port...', 'system');
  keepReading = false;
  
  if (reader) {
    try {
      await reader.cancel();
    } catch (err) {
      console.warn('Error cancelling reader:', err);
    }
  }
  
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
  streamActive = false;
  
  updateConnectionUI(false);
  resetAllIndicators();
}

function updateConnectionUI(isConnected) {
  if (isConnected) {
    connectionBadge.className = 'arduino-badge connected';
    connectionStatusText.textContent = 'CONNECTED';
    
    btnConnect.style.display = 'none';
    btnDisconnect.removeAttribute('disabled');
    
    // Enable inputs / commands
    btnToggleStream.removeAttribute('disabled');
    btnQueryHelp.removeAttribute('disabled');
    btnTestCycleLeds.removeAttribute('disabled');
    btnToggleNir.removeAttribute('disabled');
    btnToggleHeater.removeAttribute('disabled');
    btnToggleStby.removeAttribute('disabled');
    btnReadTemp.removeAttribute('disabled');
    
    manualCmdInput.removeAttribute('disabled');
    btnSendManualCmd.removeAttribute('disabled');
  } else {
    connectionBadge.className = 'arduino-badge disconnected';
    connectionStatusText.textContent = 'DISCONNECTED';
    
    btnConnect.style.display = 'block';
    btnDisconnect.setAttribute('disabled', 'true');
    
    // Disable inputs / commands
    btnToggleStream.setAttribute('disabled', 'true');
    btnToggleStream.textContent = 'Start Live Stream (S)';
    btnToggleStream.className = 'btn btn-secondary';
    btnQueryHelp.setAttribute('disabled', 'true');
    btnTestCycleLeds.setAttribute('disabled', 'true');
    btnToggleNir.setAttribute('disabled', 'true');
    btnToggleHeater.setAttribute('disabled', 'true');
    btnToggleStby.setAttribute('disabled', 'true');
    btnReadTemp.setAttribute('disabled', 'true');
    
    manualCmdInput.setAttribute('disabled', 'true');
    btnSendManualCmd.setAttribute('disabled', 'true');
  }
}

// --- Serial Transmission ---
async function sendCommand(char) {
  if (!port || !port.writable) {
    logToConsole('Cannot send command: Serial port is not writable.', 'error');
    return;
  }
  
  try {
    const textEncoder = new TextEncoder();
    writer = port.writable.getWriter();
    logToConsole(`Transmitting character command: '${char}'`, 'control');
    await writer.write(textEncoder.encode(char));
    writer.releaseLock();
  } catch (error) {
    console.error('Failed to write to port:', error);
    logToConsole(`Send failed: ${error.message}`, 'error');
    if (writer) writer.releaseLock();
  }
}

function sendManualCmd() {
  const val = manualCmdInput.value.trim();
  if (val.length === 1) {
    sendCommand(val);
    manualCmdInput.value = '';
  } else {
    logToConsole('Please enter exactly one character to transmit.', 'error');
  }
}

// --- Serial Read Loop ---
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
          
          const lines = inputBuffer.split(/\r?\n/);
          inputBuffer = lines.pop();
          
          for (const line of lines) {
            parseDiagnosticLine(line.trim());
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

// --- Diagnostic Output Parser ---
function parseDiagnosticLine(line) {
  if (!line) return;
  
  // Categorize log print color in the terminal
  let type = 'system';
  if (line.startsWith('[INFO]')) {
    type = 'info';
  } else if (line.startsWith('[WARN]') || line.startsWith('TEMP_READ,ERROR')) {
    type = 'warning';
  } else if (line.startsWith('[ERROR]')) {
    type = 'error';
  } else if (line.includes('NIR_LED,') || line.includes('HEATER,') || line.includes('TB6612_STBY,') || line.includes('STATUS_LEDS,') || line.includes('TEMP_READ') || line.includes('STREAM_DATA')) {
    type = 'stim'; // diagnostics variables
  }
  
  logToConsole(line, type);
  
  // Parse variables
  const parts = line.split(',');
  if (parts.length >= 2) {
    const key = parts[0].trim();
    const val = parts[1].trim();
    
    switch (key) {
      case 'NIR_LED': {
        const active = val === '1';
        indMosfetLed.className = active ? 'status-indicator-light active-mosfet-led' : 'status-indicator-light';
        break;
      }
      
      case 'HEATER': {
        const active = val === '1';
        indMosfetHeater.className = active ? 'status-indicator-light active-mosfet-heater' : 'status-indicator-light';
        break;
      }

      case 'TB6612_STBY': {
        // val is '1', '0', or 'NA' (STBY tied to 5V / not Arduino-controlled)
        if (val === 'NA') {
          indTbStby.className = 'status-indicator-light active-btn';
          btnToggleStby.setAttribute('disabled', 'true');
          btnToggleStby.textContent = 'STBY tied to 5V — driver always enabled';
        } else {
          const active = val === '1';
          indTbStby.className = active ? 'status-indicator-light active-btn' : 'status-indicator-light';
        }
        break;
      }
      
      case 'STATUS_LEDS': {
        resetLedIndicators();
        if (val === 'HEATING_ON') {
          indLedHeating.className = 'status-indicator-light active-heating-led';
        } else if (val === '10HZ_ON') {
          indLed10hz.className = 'status-indicator-light active-10hz-led';
        } else if (val === '40HZ_ON') {
          indLed40hz.className = 'status-indicator-light active-40hz-led';
        } else if (val === 'ERROR_ON') {
          indLedError.className = 'status-indicator-light active-error-led';
        } else if (val === 'ALL_ON') {
          indLedHeating.className = 'status-indicator-light active-heating-led';
          indLed10hz.className = 'status-indicator-light active-10hz-led';
          indLed40hz.className = 'status-indicator-light active-40hz-led';
          indLedError.className = 'status-indicator-light active-error-led';
        }
        break;
      }
      
      case 'TEMP_READ': {
        if (val === 'ERROR_NO_SENSOR') {
          testTempValue.textContent = 'NO SENSOR';
          testTempValue.style.color = 'var(--color-danger)';
        } else if (val === 'DISCONNECTED') {
          testTempValue.textContent = 'DISCONNECTED';
          testTempValue.style.color = 'var(--color-danger)';
        } else {
          testTempValue.textContent = `${val} °C`;
          testTempValue.style.color = 'var(--accent-secondary)';
        }
        break;
      }
      
      case 'STREAM_MODE': {
        streamActive = val === '1';
        if (streamActive) {
          btnToggleStream.textContent = 'Stop Live Stream (S)';
          btnToggleStream.className = 'btn btn-danger';
        } else {
          btnToggleStream.textContent = 'Start Live Stream (S)';
          btnToggleStream.className = 'btn btn-secondary';
        }
        break;
      }
      
      case 'STREAM_DATA': {
        // Format: STREAM_DATA,TEMP_C
        const tempVal = val;
        if (tempVal === 'NaN' || tempVal === 'DISCONNECTED' || !tempVal) {
          testTempValue.textContent = 'NO SENSOR';
          testTempValue.style.color = 'var(--color-danger)';
        } else {
          testTempValue.textContent = `${tempVal} °C`;
          testTempValue.style.color = 'var(--accent-secondary)';
        }
        break;
      }
    }
  }
}

// --- DOM Cleanup Helpers ---
function resetLedIndicators() {
  indLedHeating.className = 'status-indicator-light';
  indLed10hz.className = 'status-indicator-light';
  indLed40hz.className = 'status-indicator-light';
  indLedError.className = 'status-indicator-light';
}

function resetAllIndicators() {
  resetLedIndicators();
  indMosfetLed.className = 'status-indicator-light';
  indMosfetHeater.className = 'status-indicator-light';
  if (indTbStby) indTbStby.className = 'status-indicator-light';
  testTempValue.textContent = '--.- °C';
  testTempValue.style.color = 'var(--text-main)';
}

function logToConsole(text, type = 'system') {
  const logLine = document.createElement('div');
  logLine.className = `log-line ${type}`;
  
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
  
  logLine.textContent = `[${timeStr}] ${text}`;
  consoleOutput.appendChild(logLine);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function clearConsole() {
  consoleOutput.innerHTML = '<div class="log-line system">[TEST] Test Console cleared.</div>';
}
