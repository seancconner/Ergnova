// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * control/virtual-gear.js
 *
 * Virtual gear mode. Simulates a gear-table (chainring × sprocket ratios)
 * and translates a "shift up / shift down" input into an effective resistance
 * or power target sent to the trainer.
 *
 * The default gear table mimics a typical road bike:
 *   Front: 50/34  (compact double)
 *   Rear:  11-28  (10-speed: 11, 13, 15, 17, 19, 21, 24, 28)
 *
 * Each gear ratio is mapped to a resistance percentage relative to the
 * trainer's supported resistance range. Higher gear = more resistance.
 *
 * Usage:
 *   import { VirtualGearMode } from './control/virtual-gear.js';
 *   const vg = new VirtualGearMode(trainerDevice);
 *   await vg.activate();
 *   await vg.shiftUp();
 *   await vg.shiftDown();
 *   vg.setGearTable({ front: [50, 34], rear: [11,13,15,17,19,21,24,28] });
 *   await vg.deactivate();
 */

import { snapToRange } from './calibration.js';

// ─── Default gear table ───────────────────────────────────────────────────────

const DEFAULT_FRONT = [34, 50];       // small ring first
const DEFAULT_REAR  = [28, 24, 21, 19, 17, 15, 13, 11]; // big cog first (easiest first)

function buildRatioTable(front, rear) {
  // Cartesian product, sorted ascending (easiest → hardest)
  const ratios = [];
  for (const f of front) {
    for (const r of rear) {
      ratios.push(f / r);
    }
  }
  return ratios.sort((a, b) => a - b);
}

export class VirtualGearMode {
  /**
   * @param {FtmsDevice} device
   */
  constructor(device) {
    this._device  = device;
    this._ratios  = buildRatioTable(DEFAULT_FRONT, DEFAULT_REAR);
    this._gearIdx = Math.floor(this._ratios.length / 3); // start in lower third
    this._active  = false;
  }

  get name()       { return 'virtualGear'; }
  get gearIndex()  { return this._gearIdx; }
  get gearCount()  { return this._ratios.length; }
  get gearRatio()  { return this._ratios[this._gearIdx]; }
  get isActive()   { return this._active; }

  /**
   * Replace the gear table with a custom front/rear combination.
   * Resets current gear to the equivalent position in the new table.
   *
   * @param {{ front: number[], rear: number[] }} table
   */
  setGearTable({ front, rear }) {
    const prevRatio = this.gearRatio;
    this._ratios    = buildRatioTable(front, rear);

    // Find the closest gear in the new table to maintain feel
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < this._ratios.length; i++) {
      const diff = Math.abs(this._ratios[i] - prevRatio);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    this._gearIdx = bestIdx;
  }

  async activate() {
    this._active = true;
    await this._apply();
    console.debug('[virtual-gear] Activated at gear', this._gearIdx + 1, 'of', this.gearCount);
  }

  async deactivate() {
    this._active = false;
    console.debug('[virtual-gear] Deactivated');
  }

  /** Shift up (harder gear). No-op at top gear. */
  async shiftUp() {
    if (this._gearIdx < this._ratios.length - 1) {
      this._gearIdx++;
      if (this._active) await this._apply();
    }
  }

  /** Shift down (easier gear). No-op at bottom gear. */
  async shiftDown() {
    if (this._gearIdx > 0) {
      this._gearIdx--;
      if (this._active) await this._apply();
    }
  }

  /**
   * Jump directly to a specific gear index (0-based).
   * @param {number} idx
   */
  async setGear(idx) {
    this._gearIdx = Math.max(0, Math.min(this._ratios.length - 1, idx));
    if (this._active) await this._apply();
  }

  /**
   * Returns current gear as a 1-based string for display, e.g. "7 / 16"
   * @returns {string}
   */
  get label() {
    return `${this._gearIdx + 1} / ${this._ratios.length}`;
  }

  /**
   * Map the current gear ratio to a resistance percentage.
   * The lowest ratio → resistanceRange.min, highest → resistanceRange.max.
   */
  _ratioToResistance() {
    const { min, max } = this._device.resistanceRange;
    const ratioMin = this._ratios[0];
    const ratioMax = this._ratios[this._ratios.length - 1];
    const normalised = (this.gearRatio - ratioMin) / (ratioMax - ratioMin);
    return min + normalised * (max - min);
  }

  async _apply() {
    const resistance = this._ratioToResistance();
    const snapped    = snapToRange(resistance, this._device.resistanceRange);
    await this._device.setResistanceTarget(snapped);
  }
}

export default VirtualGearMode;
