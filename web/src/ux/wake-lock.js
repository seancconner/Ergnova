// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ux/wake-lock.js
 *
 * Keeps the screen awake during an active session.
 *
 * Strategy (in priority order):
 *   1. Electron: uses window.electronWakeLock (IPC → main powerSaveBlocker)
 *      because navigator.wakeLock is not implemented in Electron's renderer.
 *   2. Browser: falls back to the Screen Wake Lock API (Chrome 84+).
 *   3. Neither available: silently degrades — all calls become no-ops.
 *
 * Usage:
 *   import { wakeLock } from './ux/wake-lock.js';
 *   await wakeLock.acquire();   // call when session starts
 *   wakeLock.release();         // call when session ends
 */

let _sentinel  = null;   // browser WakeLockSentinel
let _requested = false;
let _useIPC    = typeof window !== 'undefined' && !!window.electronWakeLock;

async function _acquireBrowser() {
  if (!('wakeLock' in navigator)) return;
  try {
    _sentinel = await navigator.wakeLock.request('screen');
    _sentinel.addEventListener('release', () => {
      _sentinel = null;
      console.debug('[wake-lock] Released by browser');
    });
    console.debug('[wake-lock] Acquired (browser)');
  } catch (err) {
    console.warn('[wake-lock] Could not acquire:', err.message);
  }
}

// Re-acquire if the page becomes visible again (browser releases on hide)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (_requested && document.visibilityState === 'visible') {
      if (_useIPC) {
        window.electronWakeLock.acquire().catch(() => {});
      } else if (!_sentinel) {
        _acquireBrowser();
      }
    }
  });
}

export const wakeLock = {
  get isSupported() {
    return _useIPC || ('wakeLock' in navigator);
  },

  get isActive() {
    return _useIPC ? _requested : _sentinel !== null;
  },

  async acquire() {
    _requested = true;
    if (_useIPC) {
      await window.electronWakeLock.acquire();
    } else {
      await _acquireBrowser();
    }
  },

  release() {
    _requested = false;
    if (_useIPC) {
      window.electronWakeLock.release().catch(() => {});
    } else if (_sentinel) {
      _sentinel.release();
      _sentinel = null;
      console.debug('[wake-lock] Released by app');
    }
  },
};

export default wakeLock;
