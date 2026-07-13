/**
 * @file lsl_markers.js
 * @brief Browser-side sender for LSL experiment markers.
 *
 * Connects to the local LSL bridge (lsl_bridge/lsl_bridge.py) over a localhost
 * WebSocket and forwards experiment events as marker strings. The bridge pushes
 * them to an LSL "Markers" outlet that NIC2 (or LabRecorder) records into the
 * EEG/EMG file. See docs/lsl_eeg_marker_integration.md.
 *
 * Design notes:
 * - Best-effort and non-blocking: if the bridge is not running the experiment
 *   still works; markers are simply not recorded and a warning is logged.
 * - Markers are NEVER buffered/replayed. A marker only means anything at the
 *   instant it happens, so if the socket is down at send time the marker is
 *   dropped (and reported loudly) rather than sent late with a wrong timestamp.
 * - Auto-reconnects so the operator can start the bridge before or after the page.
 */
window.LSLMarkers = (function () {
  let ws = null;
  let connected = false;
  let url = 'ws://127.0.0.1:3535';
  let logger = null;
  let retryTimer = null;
  let manualClose = false;

  function log(msg) {
    if (typeof logger === 'function') logger(msg);
    else console.log('[LSL] ' + msg);
  }

  function open() {
    manualClose = false;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleRetry();
      return;
    }
    ws.addEventListener('open', () => {
      connected = true;
      log('Marker bridge connected (' + url + ')');
    });
    ws.addEventListener('close', () => {
      connected = false;
      if (!manualClose) {
        log('Marker bridge disconnected — markers will NOT be recorded until it reconnects');
        scheduleRetry();
      }
    });
    // 'error' is followed by 'close'; let close handle the retry to avoid double timers.
    ws.addEventListener('error', () => {});
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, 2000);
  }

  /**
   * @param {{url?: string, logger?: (msg: string) => void}} [opts]
   */
  function connect(opts) {
    if (opts && opts.url) url = opts.url;
    if (opts && typeof opts.logger === 'function') logger = opts.logger;
    open();
  }

  /**
   * Send a marker string. Returns true if it was handed to the socket.
   */
  function send(marker) {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      log('MARKER DROPPED (bridge offline): ' + marker);
      return false;
    }
    try {
      ws.send(JSON.stringify({ marker: String(marker), t: performance.now() }));
      return true;
    } catch (e) {
      log('MARKER SEND FAILED: ' + marker + ' (' + e.message + ')');
      return false;
    }
  }

  function disconnect() {
    manualClose = true;
    clearTimeout(retryTimer);
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
    connected = false;
  }

  return { connect, send, disconnect, isConnected: () => connected };
})();
