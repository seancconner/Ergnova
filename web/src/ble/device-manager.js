// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/device-manager.js
 *
 * Optional convenience layer over the individual device wrappers.
 * Handles multi-device session data merging so app.js can call
 * session.pushData(manager.latestData) and get a unified view
 * across Merach + HR strap + any other future device.
 *
 * For the S09-first use case: app.js connects MerachDevice directly
 * (matching the pattern used for FtmsDevice) and optionally passes
 * the device manager's mergeData() into the onData callback chain.
 *
 * Each device handles its own roles.register() / roles.unregister()
 * call (see merach-device.js, ftms-device.js, hr-device.js) — this
 * manager does not duplicate that work.
 */

/** Minimal merged data view across all registered device onData payloads. */
export class DeviceManager {
  constructor() {
    /** @type {Map<string, Object>} deviceId -> latest partial data */
    this._latest = new Map();
  }

  /**
   * Register a device's latest data payload. Call from each device's
   * onData callback with the device's id and the data object.
   * @param {string} deviceId
   * @param {Object} data
   */
  update(deviceId, data) {
    this._latest.set(deviceId, data);
  }

  /**
   * Remove a device's contribution (call on disconnect).
   * @param {string} deviceId
   */
  remove(deviceId) {
    this._latest.delete(deviceId);
  }

  /**
   * Merge all registered device data into one partial-Sample object.
   * Last-writer-wins per metric key — priority.js arbitrates when
   * two devices report the same metric.
   * @returns {Object}
   */
  get latestData() {
    const merged = {};
    for (const data of this._latest.values()) {
      for (const [k, v] of Object.entries(data)) {
        if (v != null) merged[k] = v;
      }
    }
    return merged;
  }
}

/** Shared singleton for app.js to use. */
export const deviceManager = new DeviceManager();
export default deviceManager;
