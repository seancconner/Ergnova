// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/roles.js
 *
 * Device role model. Every connected BLE device declares which roles it can
 * fill. Roles are what the rest of the app cares about — not device types.
 *
 * A single device can fill multiple roles (e.g. a smart trainer reports power,
 * cadence, speed, and accepts control commands all at once).
 *
 * Usage:
 *   import { roles, ROLES } from './ble/roles.js';
 *
 *   roles.register('device-id-abc', [ROLES.CONTROLLABLE_TRAINER, ROLES.POWER_SOURCE]);
 *   roles.getDevicesForRole(ROLES.POWER_SOURCE); // -> ['device-id-abc']
 *   roles.unregister('device-id-abc');
 */

import capabilities, { FEATURES, METRICS } from '../core/capabilities.js';

// ─── Role constants ───────────────────────────────────────────────────────────

export const ROLES = Object.freeze({
  /** Smart trainer that accepts resistance / ERG / slope commands. */
  CONTROLLABLE_TRAINER: 'controllable_trainer',

  /** Any device that reports power (watts). Could be trainer or dedicated PM. */
  POWER_SOURCE: 'power_source',

  /** Any device that reports cadence. */
  CADENCE_SOURCE: 'cadence_source',

  /** Any device that reports speed. */
  SPEED_SOURCE: 'speed_source',

  /** Heart rate monitor. */
  HEART_RATE_MONITOR: 'heart_rate_monitor',

  /** Moxy / BSX muscle oxygen sensor (SmO2 + tHb). */
  SMO2_MONITOR: 'smo2_monitor',

  /** Core body temperature sensor. */
  CORE_TEMP_MONITOR: 'core_temp_monitor',
});

// ─── Role → capability mapping ────────────────────────────────────────────────
// When a role becomes active/inactive, these capabilities are updated.

const ROLE_METRICS = {
  [ROLES.POWER_SOURCE]:        [METRICS.POWER],
  [ROLES.CADENCE_SOURCE]:      [METRICS.CADENCE],
  [ROLES.SPEED_SOURCE]:        [METRICS.SPEED, METRICS.DISTANCE],
  [ROLES.HEART_RATE_MONITOR]:  [METRICS.HEART_RATE, METRICS.RR_INTERVAL],
  [ROLES.SMO2_MONITOR]:        [METRICS.SMO2, METRICS.THB],
  [ROLES.CORE_TEMP_MONITOR]:   [METRICS.CORE_TEMP],
  [ROLES.CONTROLLABLE_TRAINER]: [],   // features, not metrics — handled separately
};

const ROLE_FEATURES = {
  [ROLES.CONTROLLABLE_TRAINER]: [
    FEATURES.CONTROLLABLE,
    FEATURES.ERG_MODE,
    FEATURES.RESISTANCE_MODE,
    FEATURES.SLOPE_MODE,
    FEATURES.CALIBRATION,
  ],
};

// ─── Internal state ───────────────────────────────────────────────────────────

/** Map<deviceId, Set<role>> */
const _deviceRoles = new Map();

/** Map<role, Set<deviceId>> */
const _roleDevices = new Map();

function _recomputeCapabilities() {
  // For each role, check if at least one device fills it.
  for (const role of Object.values(ROLES)) {
    const devices = _roleDevices.get(role);
    const active  = devices && devices.size > 0;

    // Update metrics
    for (const metric of (ROLE_METRICS[role] || [])) {
      capabilities.set(metric, active);
    }

    // Update features
    for (const feature of (ROLE_FEATURES[role] || [])) {
      capabilities.setFeature(feature, active);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const roles = {

  /**
   * Register a device with the roles it supports.
   * Automatically updates capabilities.
   *
   * @param {string}   deviceId  Unique BLE device identifier.
   * @param {string[]} roleList  Array of ROLES.* values.
   */
  register(deviceId, roleList) {
    if (!_deviceRoles.has(deviceId)) {
      _deviceRoles.set(deviceId, new Set());
    }
    const deviceSet = _deviceRoles.get(deviceId);

    for (const role of roleList) {
      deviceSet.add(role);

      if (!_roleDevices.has(role)) {
        _roleDevices.set(role, new Set());
      }
      _roleDevices.get(role).add(deviceId);
    }

    _recomputeCapabilities();
    console.debug(`[roles] Registered ${deviceId} with roles:`, roleList);
  },

  /**
   * Unregister a device (e.g. on disconnect).
   * Removes it from all roles and updates capabilities.
   *
   * @param {string} deviceId
   */
  unregister(deviceId) {
    const deviceSet = _deviceRoles.get(deviceId);
    if (!deviceSet) return;

    for (const role of deviceSet) {
      _roleDevices.get(role)?.delete(deviceId);
    }
    _deviceRoles.delete(deviceId);

    _recomputeCapabilities();
    console.debug(`[roles] Unregistered ${deviceId}`);
  },

  /**
   * Returns an array of device IDs currently filling a given role.
   * @param {string} role
   * @returns {string[]}
   */
  getDevicesForRole(role) {
    return [...(_roleDevices.get(role) ?? [])];
  },

  /**
   * Returns an array of roles a specific device fills.
   * @param {string} deviceId
   * @returns {string[]}
   */
  getRolesForDevice(deviceId) {
    return [...(_deviceRoles.get(deviceId) ?? [])];
  },

  /**
   * Returns true if at least one connected device fills the given role.
   * @param {string} role
   * @returns {boolean}
   */
  hasRole(role) {
    const devices = _roleDevices.get(role);
    return devices != null && devices.size > 0;
  },

  /**
   * Returns true if the given device fills the given role.
   * @param {string} deviceId
   * @param {string} role
   * @returns {boolean}
   */
  deviceHasRole(deviceId, role) {
    return _deviceRoles.get(deviceId)?.has(role) ?? false;
  },

  /**
   * Returns a snapshot of the current device→role mapping.
   * Useful for the pairing UI.
   * @returns {Object}
   */
  snapshot() {
    const out = {};
    for (const [deviceId, roleSet] of _deviceRoles) {
      out[deviceId] = [...roleSet];
    }
    return out;
  },

  /**
   * Clears all registered devices. Call on full disconnect.
   */
  clear() {
    _deviceRoles.clear();
    _roleDevices.clear();
    _recomputeCapabilities();
  },
};

export default roles;
