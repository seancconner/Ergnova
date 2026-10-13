// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/calibration.js
 *
 * Generic calibration system for BLE devices that don't speak a standard,
 * pre-calibrated protocol (FTMS, CSC, etc). A "proprietary" bike/rower like
 * the Merach reports raw sensor ticks that get converted to speed/power via
 * device-specific coefficients (gear ratio, drag coefficient, resistance
 * scaling...) — and those coefficients are frequently wrong out of the box,
 * or wrong for a specific unit due to manufacturing tolerance. This module
 * lets the *user* fix that: pedal steadily, read a trusted number off the
 * bike's own console (or a separate power meter), type it in, and the
 * relevant coefficient gets solved for and persisted.
 *
 * This is intentionally NOT Merach-specific. Any device module registers a
 * `deviceTypeId`, its tunable `params`, and (optionally) custom `solvers`
 * per metric; `ble/merach-device.js` is just the first consumer.
 *
 * Persistence is injected so this works standalone today (in-memory) and
 * can be backed by `storage/db.js` once Phase 5 exists, without this module
 * needing to change.
 */

/**
 * @typedef {Object} CalibrationParam
 * @property {number} value
 * @property {string} [description]
 * @property {string} [unit]
 */

/**
 * @typedef {Object} DeviceTypeProfile
 * @property {Object<string, CalibrationParam>} params - default/current coefficient values
 * @property {Object<string, CalibrationSolver>} [solvers] - per-metric custom solve functions; falls back to a proportional-ratio solver keyed by the same name as the metric if omitted
 */

/**
 * A solver takes the device type's current params plus a calibration
 * context (raw computed value, user-entered reference value, and whatever
 * else the device needs — e.g. resistance level, cadence) and returns the
 * FULL updated params object (not a diff) so solvers can adjust more than
 * one coefficient if the physics requires it (see the Merach power solver).
 * @callback CalibrationSolver
 * @param {Object<string, number>} currentParams
 * @param {Object} ctx - must include `computed` and `reference`; devices may add more fields
 * @returns {Object<string, number>} updated params
 */

/** Default persistence adapter: in-memory only, lost on reload. Swap in a
 * real adapter (e.g. one backed by `storage/db.js` in Phase 5) via the
 * `CalibrationStore` constructor. */
export class InMemoryCalibrationAdapter {
  constructor() {
    this._data = new Map();
  }
  async get(key) {
    return this._data.has(key) ? this._data.get(key) : null;
  }
  async set(key, value) {
    this._data.set(key, value);
  }
}

/**
 * Ratio-based fallback solver. Correct for any metric that is directly
 * (`inverse: false`) or inversely (`inverse: true`) proportional to a
 * single coefficient — which covers most simple sensor-scaling cases.
 * Metrics with more complex physics (e.g. an additive term, like power)
 * need a device-supplied custom solver instead — see merach-device.js.
 *
 * @param {string} paramName
 * @param {{inverse?: boolean}} [opts]
 * @returns {CalibrationSolver}
 */
export function proportionalSolver(paramName, opts = {}) {
  return (params, ctx) => {
    if (!(paramName in params)) throw new Error(`proportionalSolver: unknown param "${paramName}"`);
    if (!ctx.computed) throw new Error('proportionalSolver: ctx.computed must be a non-zero number');
    const ratio = opts.inverse ? ctx.computed / ctx.reference : ctx.reference / ctx.computed;
    return { ...params, [paramName]: params[paramName] * ratio };
  };
}

export class CalibrationStore {
  /** @param {{get(key:string): Promise<any>, set(key:string, value:any): Promise<void>}} [adapter] */
  constructor(adapter = new InMemoryCalibrationAdapter()) {
    this._adapter = adapter;
    /** @type {Map<string, DeviceTypeProfile>} */
    this._profiles = new Map();
    /** @type {Map<string, Object<string, number>>} deviceTypeId -> resolved (defaults + persisted overrides) params, cached after first load */
    this._resolved = new Map();
  }

  /**
   * Register a device type's default calibration params and solvers. Safe
   * to call more than once for the same id (e.g. hot reload) — re-registers
   * defaults but does not clear any already-loaded persisted overrides.
   * @param {string} deviceTypeId
   * @param {DeviceTypeProfile} profile
   */
  registerDeviceType(deviceTypeId, profile) {
    if (!profile || typeof profile.params !== 'object') {
      throw new Error('registerDeviceType: profile.params is required');
    }
    this._profiles.set(deviceTypeId, { params: profile.params, solvers: profile.solvers || {} });
  }

  /**
   * Resolve current params for a device type: defaults overlaid with any
   * persisted user calibration. Must be called (and awaited) before
   * `getParams`/`calibrate` will reflect persisted values — devices should
   * call this once during `connect()`.
   * @param {string} deviceTypeId
   * @returns {Promise<Object<string, number>>}
   */
  async load(deviceTypeId) {
    const profile = this._requireProfile(deviceTypeId);
    const defaults = Object.fromEntries(Object.entries(profile.params).map(([k, p]) => [k, p.value]));
    const stored = await this._adapter.get(this._key(deviceTypeId));
    const resolved = stored ? { ...defaults, ...stored } : defaults;
    this._resolved.set(deviceTypeId, resolved);
    return { ...resolved };
  }

  /**
   * Current param values for a device type. Returns defaults if `load()`
   * hasn't been called yet (i.e. no persisted overrides applied).
   * @param {string} deviceTypeId
   * @returns {Object<string, number>}
   */
  getParams(deviceTypeId) {
    const profile = this._requireProfile(deviceTypeId);
    if (this._resolved.has(deviceTypeId)) return { ...this._resolved.get(deviceTypeId) };
    return Object.fromEntries(Object.entries(profile.params).map(([k, p]) => [k, p.value]));
  }

  /**
   * Run calibration for one metric against a user-supplied reference
   * reading, persist the result, and return the updated params.
   *
   * @param {string} deviceTypeId
   * @param {string} metricName - e.g. 'speed', 'power' — looked up in the device type's `solvers`, falling back to a proportional solver on a same-named param if no custom solver is registered
   * @param {Object} ctx - `{ computed, reference, ...extra }` — see CalibrationSolver
   * @returns {Promise<Object<string, number>>} the new full params object
   */
  async calibrate(deviceTypeId, metricName, ctx) {
    const profile = this._requireProfile(deviceTypeId);
    const solver = profile.solvers[metricName] || proportionalSolver(metricName);
    const current = this.getParams(deviceTypeId);
    const updated = solver(current, ctx);
    this._resolved.set(deviceTypeId, updated);
    await this._adapter.set(this._key(deviceTypeId), updated);
    return { ...updated };
  }

  /** Discard persisted overrides and revert to the registered defaults. */
  async reset(deviceTypeId) {
    this._requireProfile(deviceTypeId);
    await this._adapter.set(this._key(deviceTypeId), null);
    return this.load(deviceTypeId);
  }

  _requireProfile(deviceTypeId) {
    const profile = this._profiles.get(deviceTypeId);
    if (!profile) throw new Error(`CalibrationStore: unknown device type "${deviceTypeId}" — call registerDeviceType first`);
    return profile;
  }

  _key(deviceTypeId) {
    return `calibration:${deviceTypeId}`;
  }
}

/** Most of the app wants exactly one of these, shared across every raw
 * protocol device, so calibrating one Merach unit doesn't require plumbing
 * a store reference through every layer. Tests should construct their own
 * `new CalibrationStore()` for isolation. */
export const calibrationStore = new CalibrationStore();
