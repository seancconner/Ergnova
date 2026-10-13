// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * control/slope-sim.js
 *
 * Slope simulation mode. Computes what resistance the trainer should apply
 * to simulate riding at a given road gradient, taking into account rider
 * weight, bike weight, CdA (aerodynamic drag), Crr (rolling resistance),
 * drivetrain loss, and a small wind term.
 *
 * The resistance value is sent to the trainer via FTMS's Indoor Bike
 * Simulation Parameters control point (op 0x11), which accepts grade
 * directly — so this module acts as both physics model and mode controller.
 *
 * Usage:
 *   import { SlopeSimMode } from './control/slope-sim.js';
 *   const slope = new SlopeSimMode(trainerDevice);
 *   slope.setRiderParams({ riderWeight: 75, bikeWeight: 8 });
 *   await slope.activate();
 *   await slope.setTarget(5.0);   // 5% grade
 *   await slope.adjust(-1.0);     // nudge to 4%
 *   await slope.deactivate();
 */

export class SlopeSimMode {
  /**
   * @param {FtmsDevice} device
   */
  constructor(device) {
    this._device  = device;
    this._grade   = 0;      // current grade in percent
    this._active  = false;

    // Physics parameters — editable by user profile
    this.params = {
      riderWeight:    75,    // kg
      bikeWeight:     8,     // kg
      cda:            0.320, // m² — frontal area × drag coefficient (default road position)
      crr:            0.004, // rolling resistance coefficient (road tyre default)
      drivetrainLoss: 0.97,  // drivetrain efficiency (3% loss)
      windSpeed:      0,     // m/s headwind (positive = headwind)
      airDensity:     1.225, // kg/m³ (sea level, 15°C)
    };
  }

  get name()   { return 'slope'; }
  get target() { return this._grade; }
  get isActive() { return this._active; }

  /**
   * Override default physics parameters.
   * Only provided keys are updated.
   * @param {Partial<typeof this.params>} updates
   */
  setRiderParams(updates) {
    Object.assign(this.params, updates);
  }

  async activate() {
    this._active = true;
    await this._apply();
    console.debug('[slope-sim] Activated at', this._grade, '%');
  }

  async deactivate() {
    this._active = false;
    // Set grade back to 0 so the trainer doesn't stay in a steep climb
    await this._device.setSimulationGrade(0);
    console.debug('[slope-sim] Deactivated');
  }

  /**
   * Set grade target in percent (e.g. 5.0 = 5% uphill, -3.0 = 3% downhill).
   * Clamped to the range most trainers support: -20% to +20%.
   *
   * @param {number} grade
   */
  async setTarget(grade) {
    this._grade = Math.max(-20, Math.min(20, grade));
    if (this._active) await this._apply();
  }

  /**
   * Nudge grade by a delta.
   * @param {number} delta  Percent (e.g. +0.5 or -1.0)
   */
  async adjust(delta) {
    await this.setTarget(this._grade + delta);
  }

  /**
   * Estimate the power a rider would produce at the current grade and speed.
   * Useful for display purposes ("estimated power") when the trainer is in
   * slope mode and not reporting an ERG target.
   *
   * P = (F_gravity + F_drag + F_rolling) × v / efficiency
   *
   * @param {number} speedKmh  Current speed in km/h.
   * @returns {number}         Estimated watts.
   */
  estimatePower(speedKmh) {
    const v   = speedKmh / 3.6;                          // m/s
    const m   = this.params.riderWeight + this.params.bikeWeight;
    const g   = 9.80665;
    const rad = Math.atan(this._grade / 100);            // grade % → radians

    const Fg  = m * g * Math.sin(rad);                   // gravitational force
    const Fr  = m * g * Math.cos(rad) * this.params.crr; // rolling resistance
    const vRel = v + this.params.windSpeed;
    const Fd  = 0.5 * this.params.airDensity * this.params.cda * vRel * vRel; // aerodynamic drag

    const totalForce = Fg + Fr + Fd;
    const power = (totalForce * v) / this.params.drivetrainLoss;

    return Math.max(0, Math.round(power));
  }

  async _apply() {
    await this._device.setSimulationGrade(this._grade);
  }
}

export default SlopeSimMode;
