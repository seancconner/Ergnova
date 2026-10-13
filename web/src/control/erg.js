// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * control/erg.js
 *
 * ERG mode controller. Holds the current power target and writes it to the
 * trainer whenever the target changes or the trainer requests a refresh.
 *
 * ERG mode ignores the rider's gear and enforces an absolute watt target.
 * The trainer adjusts resistance automatically to maintain the target power.
 *
 * Usage:
 *   import { ErgMode } from './control/erg.js';
 *   const erg = new ErgMode(trainerDevice);
 *   await erg.activate();
 *   await erg.setTarget(220);   // watts
 *   await erg.adjust(+5);       // relative nudge
 *   await erg.deactivate();
 */

import { snapToRange } from './calibration.js';

export class ErgMode {
  /**
   * @param {FtmsDevice} device  A connected FtmsDevice instance.
   */
  constructor(device) {
    this._device  = device;
    this._target  = 0;       // current watt target
    this._active  = false;
    this._ftp     = 200;     // reference FTP — used only for % display, not control
  }

  get name()   { return 'erg'; }
  get target() { return this._target; }
  get isActive() { return this._active; }

  /**
   * Activate ERG mode. Sends the current target immediately so the
   * trainer knows what mode it is in.
   */
  async activate() {
    this._active = true;
    if (this._target > 0) {
      await this._apply();
    }
    console.debug('[erg] Activated at', this._target, 'W');
  }

  /** Deactivate — called by mode-switch.js before switching to another mode. */
  async deactivate() {
    this._active = false;
    console.debug('[erg] Deactivated');
  }

  /**
   * Set an absolute watt target and send it to the trainer.
   * Snaps to the nearest value the trainer actually supports.
   *
   * @param {number} watts
   */
  async setTarget(watts) {
    const snapped = snapToRange(watts, this._device.powerRange);
    this._target = snapped;
    if (this._active) await this._apply();
  }

  /**
   * Set target as an FTP percentage.
   * @param {number} pct  e.g. 0.88 for 88% FTP
   */
  async setTargetPct(pct) {
    await this.setTarget(Math.round(pct * this._ftp));
  }

  /**
   * Nudge the current target up or down by a delta.
   * @param {number} delta  Watts (positive or negative)
   */
  async adjust(delta) {
    await this.setTarget(this._target + delta);
  }

  /** Set the FTP reference value (for % display helpers). */
  setFtp(ftp) { this._ftp = ftp; }

  async _apply() {
    await this._device.setErgTarget(this._target);
  }
}

export default ErgMode;
