// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/pairing-mode.js
 *
 * Manages the toggle between two pairing strategies:
 *
 *   SINGLE  — "one machine reports everything." The trainer is the only
 *             device. All metrics come from it. Simpler connection flow,
 *             no conflict resolution needed.
 *
 *   MULTI   — "independent multi-sensor pairing." Each device fills
 *             whatever roles it supports. Power meter beats trainer power,
 *             etc. priority.js arbitrates conflicts.
 *
 * The mode can be switched at runtime without disconnecting devices that
 * remain valid in the new mode. When switching MULTI → SINGLE the non-
 * trainer devices are suspended (they stay connected but their readings
 * are ignored until mode switches back).
 *
 * Usage:
 *   import { pairingMode, PAIRING_MODES } from './ble/pairing-mode.js';
 *   pairingMode.set(PAIRING_MODES.MULTI);
 *   pairingMode.subscribe(mode => console.log('mode is now', mode));
 */

export const PAIRING_MODES = Object.freeze({
  SINGLE: 'single',
  MULTI:  'multi',
});

const STORAGE_KEY = 'ergnova_pairing_mode';

// ─── Internal state ───────────────────────────────────────────────────────────

let _current = localStorage.getItem(STORAGE_KEY) ?? PAIRING_MODES.SINGLE;
const _subscribers = new Set();

function _notify() {
  for (const fn of _subscribers) {
    try { fn(_current); } catch (e) { console.error('[pairing-mode]', e); }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const pairingMode = {

  /** Returns the current pairing mode string. */
  get current() { return _current; },

  /** Returns true when in SINGLE mode. */
  get isSingle() { return _current === PAIRING_MODES.SINGLE; },

  /** Returns true when in MULTI mode. */
  get isMulti() { return _current === PAIRING_MODES.MULTI; },

  /**
   * Switch to a new pairing mode.
   * Notifies all subscribers. No-op if already in the requested mode.
   *
   * @param {string} mode  One of PAIRING_MODES.
   */
  set(mode) {
    if (!Object.values(PAIRING_MODES).includes(mode)) {
      console.warn('[pairing-mode] Unknown mode:', mode);
      return;
    }
    if (_current === mode) return;

    const prev = _current;
    _current = mode;
    localStorage.setItem(STORAGE_KEY, mode);

    console.debug(`[pairing-mode] ${prev} → ${mode}`);
    _notify();
  },

  /** Toggle between SINGLE and MULTI. */
  toggle() {
    this.set(
      _current === PAIRING_MODES.SINGLE
        ? PAIRING_MODES.MULTI
        : PAIRING_MODES.SINGLE
    );
  },

  /**
   * Subscribe to mode changes.
   * The callback is fired immediately with the current mode, then on each change.
   *
   * @param {Function} fn  Receives the new mode string.
   * @returns {Function}   Unsubscribe function.
   */
  subscribe(fn) {
    _subscribers.add(fn);
    try { fn(_current); } catch { /* ignore on initial call */ }
    return () => _subscribers.delete(fn);
  },

  /**
   * Given a set of device IDs and the primary trainer device ID,
   * returns the subset of devices that should be active in the current mode.
   *
   * In SINGLE mode only the trainer (primary device) is active.
   * In MULTI  mode all connected devices are active.
   *
   * @param {string[]} connectedIds
   * @param {string|null} primaryId   The trainer / main device ID.
   * @returns {string[]}
   */
  activeDevices(connectedIds, primaryId) {
    if (_current === PAIRING_MODES.SINGLE) {
      return primaryId && connectedIds.includes(primaryId) ? [primaryId] : [];
    }
    return connectedIds;
  },

  /**
   * Returns true if a given device's readings should currently be used.
   *
   * @param {string}      deviceId
   * @param {string|null} primaryId
   * @returns {boolean}
   */
  isDeviceActive(deviceId, primaryId) {
    if (_current === PAIRING_MODES.SINGLE) {
      return deviceId === primaryId;
    }
    return true;
  },
};

export default pairingMode;
