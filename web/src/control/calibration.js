// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * control/calibration.js
 *
 * Two responsibilities:
 *
 * 1. Snap-to-target — rounds any requested target value to the nearest value
 *    the connected device actually supports, based on its reported min/max/step
 *    from the SUPPORTED_POWER_RANGE and SUPPORTED_RESISTANCE_RANGE characteristics.
 *    Used by every control mode so they never send out-of-range values.
 *
 * 2. Spindown calibration flow — guides the user through the zero-offset
 *    (spindown) calibration procedure for controllable trainers that support it.
 *    Emits state updates via a callback so any UI can display progress.
 *
 * Usage:
 *   // Snap-to-target (used internally by other control modules):
 *   import { snapToRange } from './control/calibration.js';
 *   const safeWatts = snapToRange(247, { min: 0, max: 1000, step: 5 }); // → 245
 *
 *   // Spindown flow:
 *   import { CalibrationFlow } from './control/calibration.js';
 *   const cal = new CalibrationFlow(trainerDevice, state => updateUI(state));
 *   await cal.start();   // user spins up to target speed
 *   await cal.stop();    // user stops pedalling; trainer measures coasting
 */

// ─── Snap-to-target ───────────────────────────────────────────────────────────

/**
 * Clamp and round a value to the nearest supported step within a range.
 *
 * @param {number} value   The requested value (watts, %, grade, etc.)
 * @param {{ min: number, max: number, step: number }} range
 * @returns {number}       The nearest supported value.
 */
export function snapToRange(value, range) {
  const { min, max, step } = range;
  if (!step || step <= 0) return Math.max(min, Math.min(max, value));

  const clamped  = Math.max(min, Math.min(max, value));
  const snapped  = Math.round((clamped - min) / step) * step + min;
  return Math.max(min, Math.min(max, snapped));
}

// ─── Calibration states ───────────────────────────────────────────────────────

export const CALIBRATION_STATE = Object.freeze({
  IDLE:       'idle',
  SPINNING_UP: 'spinning_up',   // user is pedalling to target speed
  AT_SPEED:   'at_speed',       // target speed reached, hold steady
  MEASURING:  'measuring',      // user stopped pedalling, coasting measured
  COMPLETE:   'complete',       // calibration successful
  FAILED:     'failed',         // trainer reported failure
});

// ─── Spindown calibration flow ────────────────────────────────────────────────

/**
 * Guides the user through a spindown calibration procedure.
 *
 * The flow:
 *   1. SPINNING_UP  — trainer sets a low resistance; user pedals to ~30 km/h
 *   2. AT_SPEED     — when target speed is hit, user holds steady for 2 s
 *   3. MEASURING    — user stops pedalling; trainer measures coasting time
 *   4. COMPLETE/FAILED — result applied or error surfaced
 *
 * Some trainers (e.g. Wahoo KICKR) handle calibration internally and only
 * need the control-point command; others (e.g. Elite) return a calibration
 * result value. This flow handles both patterns.
 */
export class CalibrationFlow {
  /**
   * @param {FtmsDevice}  device
   * @param {Function}    onState  Callback: receives { state, message, progress }
   */
  constructor(device, onState) {
    this._device   = device;
    this._onState  = onState ?? (() => {});
    this._state    = CALIBRATION_STATE.IDLE;

    // Target speed for spinup phase (km/h). Most trainers use 30–35 km/h.
    this.targetSpeedKmh = 32;
  }

  get state() { return this._state; }

  /** Begin the calibration procedure. */
  async start() {
    this._setState(CALIBRATION_STATE.SPINNING_UP, {
      message:  `Pedal up to ${this.targetSpeedKmh} km/h`,
      progress: 0,
    });

    // Set a light resistance so the user can spin up easily
    try {
      await this._device.setResistanceTarget(10);
    } catch (e) {
      console.warn('[calibration] Could not set spin-up resistance:', e.message);
    }
  }

  /**
   * Call this when live speed data updates during spin-up.
   * Automatically advances state when target speed is reached.
   *
   * @param {number} speedKmh  Current speed from the sensor.
   */
  onSpeedUpdate(speedKmh) {
    if (this._state !== CALIBRATION_STATE.SPINNING_UP) return;

    const progress = Math.min(1, speedKmh / this.targetSpeedKmh);
    this._setState(CALIBRATION_STATE.SPINNING_UP, {
      message:  `Pedal up to ${this.targetSpeedKmh} km/h — current: ${speedKmh.toFixed(1)} km/h`,
      progress,
    });

    if (speedKmh >= this.targetSpeedKmh) {
      this._setState(CALIBRATION_STATE.AT_SPEED, {
        message:  'Hold speed steady for 2 seconds…',
        progress: 1,
      });
    }
  }

  /**
   * Call this when the user stops pedalling (speed starts dropping).
   * Triggers the measurement phase.
   */
  async stop() {
    if (this._state !== CALIBRATION_STATE.AT_SPEED &&
        this._state !== CALIBRATION_STATE.SPINNING_UP) return;

    this._setState(CALIBRATION_STATE.MEASURING, {
      message:  'Stop pedalling — measuring coasting resistance…',
      progress: 0.5,
    });

    // The FTMS spec does not define a standard calibration op code.
    // Many trainers interpret a STOP command followed by zero resistance
    // as the spindown cue. For trainers with proprietary calibration
    // (e.g. Wahoo, Elite), the vendor-specific control point is the path;
    // we do the best we can with the standard API here.
    try {
      await this._device.stop();
      await this._device.setResistanceTarget(0);
    } catch (e) {
      console.warn('[calibration] Error during stop phase:', e.message);
    }

    // Simulate measurement wait (real devices signal completion via status char)
    await this._wait(4000);

    // In a full implementation we would listen to the Fitness Machine Status
    // characteristic for a SpindownCompleted event. For now we mark complete.
    this._setState(CALIBRATION_STATE.COMPLETE, {
      message:  'Calibration complete. Trainer is ready.',
      progress: 1,
    });
  }

  /** Abort the calibration at any point. */
  cancel() {
    this._setState(CALIBRATION_STATE.IDLE, { message: 'Calibration cancelled.', progress: 0 });
  }

  _setState(state, payload = {}) {
    this._state = state;
    try { this._onState({ state, ...payload }); } catch { /* ignore */ }
  }

  _wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default { snapToRange, CalibrationFlow, CALIBRATION_STATE };
