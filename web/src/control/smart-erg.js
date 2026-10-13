// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * control/smart-erg.js
 *
 * Software ("smart") ERG controller — for trainers that don't expose a real
 * FTMS power target, only a resistance target. The Merach S09 is the
 * motivating case: its control point (see ble/merach-device.js) accepts
 * SET_TARGET_RESISTANCE but has no power-target op, so holding a wattage
 * steady means periodically comparing measured power against the target and
 * nudging resistance up or down.
 *
 * Real FTMS trainers that DO support a direct power target should keep using
 * control/erg.js's ErgMode instead — it's a single write, no loop needed.
 * That's why this lives in its own module rather than folding into erg.js:
 * the two controllers have the same public shape (activate/deactivate/
 * setTarget/setTargetPct/adjust/setFtp) but fundamentally different
 * strategies underneath, so mode-switch.js can treat whichever one occupies
 * the ERG slot interchangeably.
 *
 * The periodic compare-and-step loop lives in onPowerSample() below: every
 * ~1.5s (ADJUST_INTERVAL) it compares a smoothed power reading against the
 * active target within a ±10% tolerance band, and nudges resistance ±1,
 * clamped to this unit's supported range. onPowerSample() also tracks
 * cadence/power idleness and auto-rests to a low resistance after a few
 * seconds of no pedaling (checklist done). Resistance writes now retry on
 * failure too — see ble/merach-device.js's setResistanceTarget() (also
 * done).
 *
 * DONE (checklist 2a) — mode-switch.js now wires this in automatically: its
 * constructor picks SmartErgMode for the ERG slot whenever the connected
 * device exposes setResistanceTarget() but no real setErgTarget() (Merach
 * today; any future "fake FTMS" resistance-only unit for free, with no
 * mode-switch.js changes needed). app.js feeds live telemetry into whichever
 * mode is active via ModeSwitch#onPowerSample() every trainer data tick, and
 * connectMerachBike() constructs a ModeSwitch the same way connectTrainer()
 * does instead of leaving it null.
 * REF: old-version/reference-files/src/ble/ftms/ftms.js — handleBikeData(),
 * ADJUST_INTERVAL, tolerance logic, REST_RESISTANCE branch
 *
 * Usage:
 *   import { SmartErgMode } from './control/smart-erg.js';
 *   const smartErg = new SmartErgMode(merachDevice);
 *   await smartErg.activate();
 *   await smartErg.setTarget(220);       // watts
 *   smartErg.onIdleRest(() => console.log('rider stopped pedaling'));
 *   smartErg.onPowerSample(187, 82);     // watts, cadence — fed from the device's onData callback
 *   await smartErg.deactivate();
 */

const ADJUST_INTERVAL     = 1500; // ms between resistance nudges — matches the old ftms.js loop
const TOLERANCE_FRACTION  = 0.10; // ±10% of target before nudging resistance
const REST_RESISTANCE     = 4;    // easy level to settle at when idle — same value as old ftms.js's REST_RESISTANCE
const IDLE_TIMEOUT        = 3000; // ms of zero cadence + zero power before dropping to REST_RESISTANCE ("a few seconds")

export class SmartErgMode {
  /**
   * @param {MerachDevice|Proform750rDevice} device  A connected device
   *   exposing setResistanceTarget(level).
   */
  constructor(device) {
    this._device = device;
    this._target = 0;    // watt target
    this._active = false;
    this._ftp    = 200;  // reference FTP — used only for % display, not control (mirrors ErgMode)

    // Loop state
    this._resistance        = 8;  // current commanded resistance level, seeded to a mid value
    this._smoothedPower     = 0;
    this._lastAdjustmentTime = 0;
    this._isAdjusting        = false; // true while a resistance write is in flight
    this._idleSince          = null;  // timestamp of first zero-cadence/zero-power sample, or null when not idle
    this._idleNotified       = false; // true once onIdleRest() has fired for the current idle episode — see _maybeAutoRest()

    this._idleSubscribers = new Set(); // see onIdleRest() / _notifyIdleRest()

    // Per-device resistance ceiling — read from device.ergResistanceRange,
    // NOT device.resistanceRange. Those are deliberately different
    // properties: device.resistanceRange is what mode-switch.js's
    // capability detection checks to decide whether to offer real
    // ResistanceMode/VirtualGearMode (percentage-based, direct control) —
    // Merach and Proform intentionally don't declare it, since neither of
    // those modes is wired up for them, only ERG via this class. If this
    // constructor read that same property, declaring it on either device
    // would have silently lit up Resistance/VirtualGear mode in the UI as
    // a side effect of fixing the ERG ceiling. ergResistanceRange exists
    // purely for this loop to clamp against, with no such side effect.
    // ✅ CONFIRMED per-device: Merach 1–16, Proform 1–24 (see each
    // device's own ergResistanceRange for where these come from). Falls
    // back to the old 1–20 placeholder for any future device that hasn't
    // declared its own yet.
    this.resistanceRange = device.ergResistanceRange ?? { min: 1, max: 20 };
  }

  get name()     { return 'smartErg'; }
  get target()   { return this._target; }
  get isActive() { return this._active; }

  /** Activate smart-ERG mode. The resistance loop reacts on the next onPowerSample() call. */
  async activate() {
    this._active = true;
    console.debug('[smart-erg] Activated at', this._target, 'W (resistance level', this._resistance, ')');
  }

  /** Deactivate — called by mode-switch.js before switching to another mode. */
  async deactivate() {
    this._active = false;
    this._idleSince = null; // don't carry idle state across activations
    this._idleNotified = false;
    console.debug('[smart-erg] Deactivated');
  }

  /**
   * Set an absolute watt target. Unlike ErgMode, this doesn't write to the
   * device directly — there's no single control-point command that can hit a
   * wattage on this hardware. onPowerSample()'s loop is what actually steps
   * resistance toward this target over time.
   * @param {number} watts
   */
  async setTarget(watts) {
    this._target = Math.max(0, Math.round(watts));
  }

  /**
   * Set target as an FTP percentage — kept symmetrical with ErgMode's API.
   * Uses the stored FTP (see setFtp()) unless one is passed explicitly.
   * @param {number} pct  e.g. 0.88 for 88% FTP
   * @param {number} [ftp]
   */
  async setTargetPct(pct, ftp = this._ftp) {
    await this.setTarget(Math.round(pct * ftp));
  }

  /**
   * Nudge the current target up or down by a delta.
   * @param {number} delta  Watts (positive or negative)
   */
  async adjust(delta) {
    await this.setTarget(this._target + delta);
  }

  /**
   * Set the FTP reference value (for % display helpers). Mirrors
   * ErgMode#setFtp() so mode-switch.js can call it on the ERG slot without
   * caring which controller is occupying it.
   * @param {number} ftp
   */
  setFtp(ftp) { this._ftp = ftp; }

  /**
   * Subscribe to idle-rest events. Fired exactly once per idle episode — at
   * the moment _maybeAutoRest() actually drops resistance to
   * REST_RESISTANCE — not on every subsequent idle sample while it's
   * already resting there. mode-switch.js relays this so app.js can
   * auto-pause the workout when the rider stops pedaling.
   * @param {Function} fn  Called with no arguments
   * @returns {Function} unsubscribe
   */
  onIdleRest(fn) {
    this._idleSubscribers.add(fn);
    return () => this._idleSubscribers.delete(fn);
  }

  _notifyIdleRest() {
    for (const fn of this._idleSubscribers) {
      try { fn(); } catch (e) { console.error('[smart-erg] idle subscriber error', e); }
    }
  }

  /**
   * Feed in a live power + cadence reading. Smooths power, then routes to
   * exactly ONE of two mutually-exclusive branches per sample — mirroring
   * old ftms.js's handleBikeData(), which used
   * "if (currentTargetPower > 0 && powerToCompare > 0) {...}
   *  else if (cadence === 0 && currentResistanceLevel > REST_RESISTANCE) {...}":
   *   - pedaling (cadence>0 or watts>0): step resistance toward the watt
   *     target, throttled to once per ADJUST_INTERVAL within a ±10%
   *     tolerance band (see _maybeAdjust()).
   *   - not pedaling: track how long we've been idle, and once that holds
   *     for IDLE_TIMEOUT, drop resistance to REST_RESISTANCE (see
   *     _maybeAutoRest()).
   *
   * These two must stay mutually exclusive — that's what the old code's
   * if/else did and what was missing here before. The bug this fixes: this
   * method used to run _maybeAutoRest() AND _maybeAdjust() independently,
   * gating the latter only on `smoothedPower > 0`. Since smoothedPower is an
   * EMA (`smoothedPower * 0.7 + watts * 0.3`), once watts drops to 0 it
   * decays toward zero asymptotically but never actually reaches it — so
   * _maybeAdjust() kept firing on that lingering residual, nudging
   * resistance from REST_RESISTANCE (4) back up to 5 roughly every
   * ADJUST_INTERVAL, which _maybeAutoRest() then immediately reset back to
   * 4 on the very next sample. That ping-pong was the "alternating between
   * 5 and 4 while idle" symptom. Branching on raw cadence/watts here instead
   * of the smoothed value sidesteps the decay problem entirely.
   * REF: old-version/reference-files/src/ble/ftms/ftms.js — handleBikeData()
   * @param {number} watts
   * @param {number} [cadence]  RPM; defaults to 0 (treated as stopped) if omitted
   */
  onPowerSample(watts, cadence = 0) {
    // Light EMA so a single noisy sample doesn't trigger a resistance step.
    this._smoothedPower = this._smoothedPower > 0
      ? (this._smoothedPower * 0.7) + (watts * 0.3)
      : watts;

    if (!this._active) return;

    const isPedaling = cadence > 0 || watts > 0;

    if (isPedaling) {
      this._idleSince = null;
      this._idleNotified = false;
      if (this._target > 0 && this._smoothedPower > 0) this._maybeAdjust();
    } else {
      this._maybeAutoRest();
    }
  }

  /**
   * Auto-rest: once cadence and power have both read 0 for a sustained
   * period, drop resistance to REST_RESISTANCE so a rider who stops
   * pedaling isn't left against a hard erg setting, and notify subscribers
   * (app.js's auto-pause) that the rider has gone idle. Ported from old
   * ftms.js's "else if (cadence === 0 && currentResistanceLevel >
   * REST_RESISTANCE)" branch, with one change: the old code dropped
   * resistance on the very first zero-cadence sample; IDLE_TIMEOUT adds a
   * short debounce here so a momentary gap between pedal strokes doesn't
   * trigger it.
   *
   * The idle notification and the resistance write are deliberately
   * independent: notifying is "the rider has been idle for IDLE_TIMEOUT",
   * which is true regardless of what resistance happens to already be set
   * to. Gating the notification on `resistance > restLevel` (as this used
   * to) meant that any time the ERG loop had already settled at or below
   * REST_RESISTANCE before the rider stopped — a low-wattage target, or a
   * previous idle episode that hadn't climbed back up yet — the function
   * returned before _notifyIdleRest() ever ran, so auto-pause silently
   * never fired even though cadence/watts correctly read 0. _idleNotified
   * (reset alongside _idleSince, see onPowerSample()/deactivate()) is what
   * now keeps this to once per idle episode instead.
   *
   * Only called from onPowerSample() once it has already determined the
   * rider isn't pedaling — see isPedaling there. That mutual exclusivity is
   * what keeps this from fighting with _maybeAdjust() (see that method's
   * docstring for what goes wrong without it).
   * REF: old-version/reference-files/src/ble/ftms/ftms.js — REST_RESISTANCE branch
   */
  _maybeAutoRest() {
    const now = Date.now();
    if (this._idleSince == null) {
      this._idleSince = now;
      return;
    }
    if (now - this._idleSince < IDLE_TIMEOUT) return;
    if (this._idleNotified) return;

    const { min, max } = this.resistanceRange;
    const restLevel = Math.max(min, Math.min(max, REST_RESISTANCE));

    if (this._resistance > restLevel && !this._isAdjusting) {
      this._isAdjusting = true;
      this._resistance   = restLevel;
      this._lastAdjustmentTime = now;
      console.debug(
        '[smart-erg] Cadence 0, no power for', IDLE_TIMEOUT, 'ms — resistance -> rest level', restLevel,
      );
      this._applyResistance();
    }

    this._idleNotified = true;
    this._notifyIdleRest();
  }

  _maybeAdjust() {
    if (this._isAdjusting) return;

    const now = Date.now();
    if (now - this._lastAdjustmentTime < ADJUST_INTERVAL) return;

    const tolerance = this._target * TOLERANCE_FRACTION;
    const { min, max } = this.resistanceRange;
    let newResistance = this._resistance;

    if (this._smoothedPower < (this._target - tolerance)) {
      newResistance = Math.min(max, this._resistance + 1);
    } else if (this._smoothedPower > (this._target + tolerance)) {
      newResistance = Math.max(min, this._resistance - 1);
    }

    if (newResistance !== this._resistance) {
      this._isAdjusting = true;
      this._resistance   = newResistance;
      this._lastAdjustmentTime = now;
      console.debug(
        '[smart-erg] Power', Math.round(this._smoothedPower), 'W vs target', this._target,
        'W — resistance ->', this._resistance,
      );
      this._applyResistance();
    }
  }

  /** Fire-and-forget write — releases the isAdjusting lock once acknowledged (or failed). */
  _applyResistance() {
    this._device.setResistanceTarget(this._resistance)
      .catch((err) => console.warn('[smart-erg] resistance write failed:', err.message))
      .finally(() => { this._isAdjusting = false; });
  }
}

export default SmartErgMode;