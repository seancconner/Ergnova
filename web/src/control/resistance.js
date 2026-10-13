// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * control/resistance.js
 *
 * Static resistance mode controller.
 * Sets the trainer to a fixed resistance percentage (0–100%) regardless of
 * speed or cadence. The rider's effort is what changes power — the trainer
 * provides a constant mechanical load.
 *
 * Usage:
 *   import { ResistanceMode } from './control/resistance.js';
 *   const res = new ResistanceMode(trainerDevice);
 *   await res.activate();
 *   await res.setTarget(40);   // 40% resistance
 *   await res.adjust(-5);      // nudge down 5%
 *   await res.deactivate();
 */

import { snapToRange } from './calibration.js';

export class ResistanceMode {
  /**
   * @param {FtmsDevice} device
   */
  constructor(device) {
    this._device = device;
    this._target = 25;   // default 25% — a reasonable starting resistance
    this._active = false;
  }

  get name()   { return 'resistance'; }
  get target() { return this._target; }
  get isActive() { return this._active; }

  async activate() {
    this._active = true;
    await this._apply();
    console.debug('[resistance] Activated at', this._target, '%');
  }

  async deactivate() {
    this._active = false;
    console.debug('[resistance] Deactivated');
  }

  /**
   * Set resistance as a percentage of the trainer's supported range.
   * Snaps to the nearest value the trainer supports.
   *
   * @param {number} percent  0–100
   */
  async setTarget(percent) {
    const snapped = snapToRange(percent, this._device.resistanceRange);
    this._target  = snapped;
    if (this._active) await this._apply();
  }

  /**
   * Nudge resistance by a delta.
   * @param {number} delta  Percentage points (positive or negative)
   */
  async adjust(delta) {
    await this.setTarget(this._target + delta);
  }

  async _apply() {
    await this._device.setResistanceTarget(this._target);
  }
}

export default ResistanceMode;
