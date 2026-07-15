/**
 * @file serial_lock.js
 * @brief Cross-tab coordination for the single physical Arduino serial port.
 *
 * The Hardware Dashboard (arduino.html) and the I/O Diagnostics page
 * (io_test.html) run on the same origin but share ONE USB serial port, and only
 * one tab can hold it open at a time. Without coordination they fought over it:
 * disconnecting in one tab (or Chrome Memory Saver reloading a backgrounded tab,
 * which re-runs auto-reconnect) let the other tab immediately grab the freed
 * port — the "disconnect here, reconnects there" ping-pong.
 *
 * This module uses a BroadcastChannel so the tabs agree on who owns the port:
 *   - Auto-reconnect on load YIELDS if another tab already holds the port,
 *     instead of stealing it.
 *   - An explicit user "Connect" performs a takeover: it asks the current holder
 *     to release first, so switching between the two pages is clean and
 *     intentional rather than a race.
 *
 * Degrades gracefully: if BroadcastChannel is unavailable, every method is a
 * no-op and the pages behave as before (single-tab use is unaffected).
 */
window.SerialLock = (function () {
  const supported = 'BroadcastChannel' in window;
  const bc = supported ? new BroadcastChannel('tpbm-serial-lock') : null;
  const tabId = Math.random().toString(36).slice(2);
  let iOwn = false;
  let releaseFn = null; // page-provided disconnect routine, invoked on takeover

  if (bc) {
    bc.addEventListener('message', (e) => {
      const m = e.data || {};
      if (!m || m.tabId === tabId) return;

      if (m.type === 'query' && iOwn) {
        // Someone is probing ownership before auto-connecting; announce we hold it.
        bc.postMessage({ type: 'claim', tabId });
      } else if (m.type === 'takeover' && iOwn) {
        // Another tab's user explicitly wants the port. Yield it by disconnecting;
        // our disconnect path calls release(), which broadcasts 'release'.
        if (typeof releaseFn === 'function') releaseFn();
      }
    });
  }

  /** Register how this tab disconnects, so a takeover can release the port. */
  function setReleaseHandler(fn) { releaseFn = fn; }

  /** Mark this tab as the port owner and announce it to other tabs. */
  function claim() {
    iOwn = true;
    if (bc) bc.postMessage({ type: 'claim', tabId });
  }

  /** Mark this tab as no longer owning the port and announce the release. */
  function release() {
    iOwn = false;
    if (bc) bc.postMessage({ type: 'release', tabId });
  }

  /**
   * Resolve true if another tab currently holds the port. Used to gate the
   * on-load auto-reconnect so a reloaded tab yields instead of stealing.
   */
  function isHeldElsewhere(timeoutMs = 200) {
    return new Promise((resolve) => {
      if (!bc) return resolve(false);
      let held = false;
      const onMsg = (e) => {
        const m = e.data || {};
        if (m && m.tabId !== tabId && m.type === 'claim') held = true;
      };
      bc.addEventListener('message', onMsg);
      bc.postMessage({ type: 'query', tabId });
      setTimeout(() => {
        bc.removeEventListener('message', onMsg);
        resolve(held);
      }, timeoutMs);
    });
  }

  /**
   * Ask any current holder to release the port, then wait (briefly) for it to
   * confirm before the caller opens the port. Resolves as soon as a 'release'
   * arrives, or after waitMs at the latest.
   */
  function requestTakeover(waitMs = 400) {
    return new Promise((resolve) => {
      if (!bc) return resolve();
      let released = false;
      const onMsg = (e) => {
        const m = e.data || {};
        if (m && m.tabId !== tabId && m.type === 'release') released = true;
      };
      bc.addEventListener('message', onMsg);
      bc.postMessage({ type: 'takeover', tabId });

      const start = Date.now();
      (function poll() {
        if (released || Date.now() - start >= waitMs) {
          bc.removeEventListener('message', onMsg);
          resolve();
        } else {
          setTimeout(poll, 30);
        }
      })();
    });
  }

  return { supported, setReleaseHandler, claim, release, isHeldElsewhere, requestTakeover };
})();
