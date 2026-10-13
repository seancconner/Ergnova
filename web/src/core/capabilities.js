// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * core/capabilities.js
 *
 * Central registry of which metrics and features are currently available,
 * derived from which devices are connected and what roles they fill.
 *
 * All UI panels, chart modules, and training-metrics modules subscribe here
 * rather than polling devices directly. This is the single source of truth.
 *
 * Usage:
 *   import { capabilities } from './core/capabilities.js';
 *   capabilities.subscribe(snapshot => { ... });
 *   capabilities.set('power', true);
 *   capabilities.has('heartRate');
 */

// ─── Metric keys ──────────────────────────────────────────────────────────────
// These are the canonical string keys used everywhere in the app.
export const METRICS = Object.freeze({
  POWER:        'power',        // watts from trainer or dedicated power meter
  CADENCE:      'cadence',      // rpm
  HEART_RATE:   'heartRate',    // bpm
  SPEED:        'speed',        // km/h
  DISTANCE:     'distance',     // meters (derived)
  SMO2:         'smo2',         // muscle oxygen saturation % (Moxy)
  THB:          'thb',          // total haemoglobin (Moxy)
  CORE_TEMP:    'coreTemp',     // °C (core-temp sensor)
  RESISTANCE:   'resistance',   // raw resistance level (0–100%)
  RR_INTERVAL:  'rrInterval',   // milliseconds between R-peaks (HRV)
  ELAPSED_TIME: 'elapsedTime',  // seconds since session start
  LAP:          'lap',          // lap counter
});

// ─── Feature flags ────────────────────────────────────────────────────────────
// Boolean capabilities tied to device support rather than a live metric stream.
export const FEATURES = Object.freeze({
  ERG_MODE:         'ergMode',        // trainer accepts power targets
  RESISTANCE_MODE:  'resistanceMode', // trainer accepts resistance %
  SLOPE_MODE:       'slopeMode',      // trainer accepts grade targets
  VIRTUAL_GEAR:     'virtualGear',    // gear-table control is possible
  CALIBRATION:      'calibration',    // trainer supports spindown calibration
  CONTROLLABLE:     'controllable',   // at least one controllable device is connected
});

// ─── Internal state ───────────────────────────────────────────────────────────
const _metrics  = new Map();   // metricKey -> boolean
const _features = new Map();   // featureKey -> boolean
const _subscribers = new Set(); // callbacks

function _notify() {
  const snapshot = capabilities.snapshot();
  for (const fn of _subscribers) {
    try { fn(snapshot); } catch (e) { console.error('[capabilities] subscriber error', e); }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
export const capabilities = {

  /**
   * Returns true if the given metric key is currently available.
   * @param {string} key  One of METRICS.*
   */
  has(key) {
    return _metrics.get(key) === true;
  },

  /**
   * Returns true if the given feature flag is currently active.
   * @param {string} key  One of FEATURES.*
   */
  hasFeature(key) {
    return _features.get(key) === true;
  },

  /**
   * Mark a metric as available (true) or unavailable (false).
   * Notifies all subscribers.
   * @param {string}  key
   * @param {boolean} available
   */
  set(key, available) {
    const prev = _metrics.get(key);
    _metrics.set(key, Boolean(available));
    if (prev !== _metrics.get(key)) _notify();
  },

  /**
   * Mark a feature flag as enabled (true) or disabled (false).
   * @param {string}  key
   * @param {boolean} enabled
   */
  setFeature(key, enabled) {
    const prev = _features.get(key);
    _features.set(key, Boolean(enabled));
    if (prev !== _features.get(key)) _notify();
  },

  /**
   * Bulk-update metrics from a plain object.
   * Only triggers one notification regardless of how many keys change.
   * @param {Object} updates  e.g. { power: true, cadence: false }
   */
  update(updates) {
    let changed = false;
    for (const [key, val] of Object.entries(updates)) {
      const prev = _metrics.get(key);
      _metrics.set(key, Boolean(val));
      if (prev !== _metrics.get(key)) changed = true;
    }
    if (changed) _notify();
  },

  /**
   * Bulk-update feature flags.
   * @param {Object} updates  e.g. { ergMode: true, slopeMode: false }
   */
  updateFeatures(updates) {
    let changed = false;
    for (const [key, val] of Object.entries(updates)) {
      const prev = _features.get(key);
      _features.set(key, Boolean(val));
      if (prev !== _features.get(key)) changed = true;
    }
    if (changed) _notify();
  },

  /**
   * Reset all metrics and features to unavailable/disabled.
   * Call when all devices disconnect.
   */
  clear() {
    _metrics.clear();
    _features.clear();
    _notify();
  },

  /**
   * Returns an immutable snapshot of the current state.
   * Convenient for passing into chart components without binding.
   */
  snapshot() {
    return Object.freeze({
      metrics:  Object.fromEntries(_metrics),
      features: Object.fromEntries(_features),
    });
  },

  /**
   * Register a callback that fires whenever capabilities change.
   * The callback receives a capabilities snapshot.
   * Returns an unsubscribe function.
   * @param {Function} fn
   * @returns {Function} unsubscribe
   */
  subscribe(fn) {
    _subscribers.add(fn);
    // Fire immediately with current state so the subscriber can initialise.
    try { fn(capabilities.snapshot()); } catch (e) { /* ignore on first call */ }
    return () => _subscribers.delete(fn);
  },

  /**
   * Returns an array of metric keys that are currently available.
   */
  availableMetrics() {
    return [..._metrics.entries()]
      .filter(([, v]) => v)
      .map(([k]) => k);
  },

  /**
   * Returns an array of feature keys that are currently enabled.
   */
  enabledFeatures() {
    return [..._features.entries()]
      .filter(([, v]) => v)
      .map(([k]) => k);
  },
};

export default capabilities;
