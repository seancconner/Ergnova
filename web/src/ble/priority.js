// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/priority.js
 *
 * Resolves conflicts when multiple connected devices report the same metric.
 * Example: a smart trainer and a dedicated power meter both report watts —
 * priority.js decides which value wins.
 *
 * The user-visible priority order is stored per-metric and persisted to
 * localStorage so it survives page reloads.
 *
 * Usage:
 *   import { priority, METRICS } from './ble/priority.js';
 *
 *   priority.setOrder(METRICS.POWER, ['power-meter-id', 'trainer-id']);
 *   const winnerId = priority.resolve(METRICS.POWER, ['trainer-id', 'power-meter-id']);
 *   // -> 'power-meter-id'  (first in priority list that is currently connected)
 */

import { METRICS } from '../core/capabilities.js';

const STORAGE_KEY = 'ergnova_priority_order';

// ─── Internal state ───────────────────────────────────────────────────────────

// Map<metricKey, string[]>  — ordered device IDs (highest priority first)
const _order = new Map();

// Load persisted order from localStorage
function _load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [metric, order] of Object.entries(parsed)) {
      _order.set(metric, order);
    }
  } catch { /* ignore */ }
}

function _save() {
  try {
    const out = {};
    for (const [metric, order] of _order) {
      out[metric] = order;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch { /* ignore */ }
}

_load();

// ─── Public API ───────────────────────────────────────────────────────────────

export const priority = {

  /**
   * Set the priority order for a metric.
   * First entry in the array has the highest priority.
   *
   * @param {string}   metricKey  One of METRICS.*
   * @param {string[]} deviceIds  Ordered list of device IDs.
   */
  setOrder(metricKey, deviceIds) {
    _order.set(metricKey, [...deviceIds]);
    _save();
  },

  /**
   * Get the current priority order for a metric.
   * @param {string} metricKey
   * @returns {string[]}  Device IDs in priority order (may be empty).
   */
  getOrder(metricKey) {
    return _order.get(metricKey) ?? [];
  },

  /**
   * Given a set of currently-connected device IDs that all report the same
   * metric, returns the device ID that should "win."
   *
   * Resolution rules (in order):
   *   1. Use the stored priority list — return the first entry that appears
   *      in `connectedIds`.
   *   2. If no stored preference exists, fall back to the first connected
   *      device alphabetically (deterministic tie-break).
   *
   * @param {string}   metricKey     One of METRICS.*
   * @param {string[]} connectedIds  Device IDs currently connected for this metric.
   * @returns {string|null}          Winning device ID, or null if none.
   */
  resolve(metricKey, connectedIds) {
    if (!connectedIds || connectedIds.length === 0) return null;
    if (connectedIds.length === 1) return connectedIds[0];

    const order = _order.get(metricKey) ?? [];
    for (const deviceId of order) {
      if (connectedIds.includes(deviceId)) return deviceId;
    }

    // Fallback: alphabetical
    return [...connectedIds].sort()[0];
  },

  /**
   * Move a device up one position in the priority list for a metric.
   * @param {string} metricKey
   * @param {string} deviceId
   */
  promoteDevice(metricKey, deviceId) {
    const order = [...(this.getOrder(metricKey))];
    const idx = order.indexOf(deviceId);
    if (idx > 0) {
      [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
      this.setOrder(metricKey, order);
    }
  },

  /**
   * Ensure a device appears in the priority list for a metric.
   * If not already present it is appended (lowest priority).
   * Call this when a new device is registered for a role.
   *
   * @param {string} metricKey
   * @param {string} deviceId
   */
  ensureDevice(metricKey, deviceId) {
    const order = this.getOrder(metricKey);
    if (!order.includes(deviceId)) {
      this.setOrder(metricKey, [...order, deviceId]);
    }
  },

  /**
   * Remove a device from the priority list for a metric.
   * Call this when a device disconnects permanently.
   *
   * @param {string} metricKey
   * @param {string} deviceId
   */
  removeDevice(metricKey, deviceId) {
    const order = this.getOrder(metricKey).filter(id => id !== deviceId);
    this.setOrder(metricKey, order);
  },

  /**
   * Remove a device from all metric priority lists.
   * Call on device unregister.
   *
   * @param {string} deviceId
   */
  removeDeviceAll(deviceId) {
    for (const metricKey of Object.values(METRICS)) {
      this.removeDevice(metricKey, deviceId);
    }
  },

  /**
   * Returns a plain-object snapshot for display in a priority settings UI.
   * @returns {Object}  Map of metricKey -> orderedDeviceIds[]
   */
  snapshot() {
    const out = {};
    for (const [metric, order] of _order) {
      if (order.length > 0) out[metric] = [...order];
    }
    return out;
  },
};

export { METRICS };
export default priority;
