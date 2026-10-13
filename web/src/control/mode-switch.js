// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * control/mode-switch.js
 *
 * Runtime mode switcher. Manages which control mode is currently active
 * and handles clean transitions between modes on a live connected device.
 *
 * Modes:
 *   erg         — fixed power target (watts), trainer adjusts resistance
 *   resistance  — fixed resistance %, rider effort controls power
 *   slope       — grade simulation, physics-based resistance
 *   virtualGear — gear-table resistance, shifted up/down by input
 *
 * Not every device supports every mode — a device wrapper only needs to
 * implement the write methods a mode actually calls (see "Capability
 * detection" below), and the constructor only instantiates the modes that
 * device can actually do. Unsupported modes are simply absent from
 * availableModes / switchTo() rather than constructed and left to throw the
 * first time someone tries to use them.
 *
 * Capability detection (duck-typed off the device instance, not its class —
 * this is what keeps future device wrappers plug-and-play with zero changes
 * here):
 *   erg          — setErgTarget()       present -> ErgMode (real FTMS power target)
 *                  else setResistanceTarget() present -> SmartErgMode (software
 *                  compare-and-step loop over resistance; see control/smart-erg.js)
 *                  else -> erg unavailable
 *   resistance   — setResistanceTarget() + resistanceRange both present
 *   slope        — setSimulationGrade() present
 *   virtualGear  — setResistanceTarget() + resistanceRange both present (it
 *                  drives gears via the same resistance write as resistance mode)
 *
 * The Merach S09 today (ble/merach-device.js) implements setResistanceTarget()
 * but not setErgTarget()/resistanceRange()/setSimulationGrade(), so it gets
 * ERG (via SmartErgMode) only — resistance/slope/virtualGear stay unavailable
 * for it rather than being offered and failing on first use.
 *
 * Usage:
 *   import { ModeSwitch, MODES } from './control/mode-switch.js';
 *
 *   const modeSwitch = new ModeSwitch(trainerDevice, userProfile);
 *   modeSwitch.availableModes;             // e.g. ['erg'] for a Merach, all 4 for a real FTMS trainer
 *   await modeSwitch.switchTo(MODES.ERG);
 *   modeSwitch.currentMode.setTarget(220);
 *   await modeSwitch.switchTo(MODES.SLOPE);
 *   modeSwitch.currentMode.setTarget(4.5);
 *   modeSwitch.subscribe(({ mode }) => updateUI(mode));
 *   modeSwitch.onPowerSample(watts, cadence, speed); // feed live telemetry every tick —
 *                                              // forwarded to the active mode if it wants it
 *                                              // (SmartErgMode) AND always fed to this class's
 *                                              // own mode-independent activity tracking below.
 *   modeSwitch.onIdle(() => pauseTheWorkout());  // fires ~3s after watts/cadence/speed all read
 *                                                 // 0 — regardless of which mode (if any) is
 *                                                 // active, as long as the device is connected
 *                                                 // and feeding onPowerSample().
 *   modeSwitch.onActive(() => startTheClock());   // the mirror image of onIdle() — fires the
 *                                                  // instant a sample shows real activity again
 *                                                  // after being idle (no debounce, unlike
 *                                                  // onIdle() — see _checkActivity() below).
 */

import { ErgMode }          from './erg.js';
import { SmartErgMode }     from './smart-erg.js';
import { ResistanceMode }   from './resistance.js';
import { SlopeSimMode }     from './slope-sim.js';
import { VirtualGearMode }  from './virtual-gear.js';

export const MODES = Object.freeze({
  ERG:          'erg',
  RESISTANCE:   'resistance',
  SLOPE:        'slope',
  VIRTUAL_GEAR: 'virtualGear',
});

// ms of watts/cadence/speed all reading 0 before onIdle() fires — mirrors
// smart-erg.js's own IDLE_TIMEOUT so the "auto-pause after a few seconds of
// no pedaling" feel is the same regardless of which mode is driving the
// device (see _checkActivity() below).
const IDLE_TIMEOUT = 3000;

export class ModeSwitch {
  /**
   * @param {FtmsDevice|MerachDevice} device
   * @param {Object}      [profile]   Optional user profile { ftp, riderWeight, bikeWeight }
   */
  constructor(device, profile = {}) {
    this._device = device;

    // Instantiate only the mode controllers this device can actually
    // support — see the capability-detection docs above.
    this._modes = {};

    this._idleSubscribers   = new Set(); // see onIdle() / _notifyIdle()
    this._activeSubscribers = new Set(); // see onActive() / _notifyActive()

    // Mode-independent activity tracking (see onPowerSample()/_checkActivity()
    // below) — deliberately separate from any one mode controller's own
    // state, so onIdle()/onActive() work the same whether ERG/resistance/
    // slope/virtualGear (or no mode at all) is currently active.
    this._idleSince    = null;  // timestamp activity was first lost, or null while active
    this._idleNotified = false; // true once onIdle() has fired for the current idle episode
    this._wasActive    = false; // previous sample's activity state, for onActive()'s edge trigger

    if (typeof device.setErgTarget === 'function') {
      this._modes[MODES.ERG] = new ErgMode(device);
    } else if (typeof device.setResistanceTarget === 'function') {
      const smartErg = new SmartErgMode(device);
      // Relay through ModeSwitch's own idle subscribers so callers (app.js)
      // have one place to listen regardless of which device/mode is
      // actually driving idle detection underneath. Redundant with (but
      // harmless alongside) the general _checkActivity() tracking below —
      // both ultimately call _notifyIdle(), which app.js's autoPauseSession()
      // treats idempotently (no-ops if already paused).
      smartErg.onIdleRest(() => this._notifyIdle());
      this._modes[MODES.ERG] = smartErg;
    }

    if (typeof device.setResistanceTarget === 'function' && device.resistanceRange) {
      this._modes[MODES.RESISTANCE]   = new ResistanceMode(device);
      this._modes[MODES.VIRTUAL_GEAR] = new VirtualGearMode(device);
    }

    if (typeof device.setSimulationGrade === 'function') {
      this._modes[MODES.SLOPE] = new SlopeSimMode(device);
    }

    // Apply profile to modes that care about it (and are actually present).
    if (profile.ftp) {
      this._modes[MODES.ERG]?.setFtp(profile.ftp);
    }
    if (profile.riderWeight || profile.bikeWeight) {
      this._modes[MODES.SLOPE]?.setRiderParams({
        riderWeight: profile.riderWeight ?? 75,
        bikeWeight:  profile.bikeWeight  ?? 8,
      });
    }

    this._active      = null;   // active mode key
    this._subscribers = new Set();
  }

  /** Mode keys this device actually supports (see capability detection above). */
  get availableModes() {
    return Object.keys(this._modes);
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /** The currently active mode key, or null if no mode is active. */
  get activeModeName() { return this._active; }

  /**
   * The currently active mode controller instance, or null.
   * @returns {ErgMode|ResistanceMode|SlopeSimMode|VirtualGearMode|null}
   */
  get currentMode() {
    return this._active ? this._modes[this._active] : null;
  }

  /**
   * Convenience accessors for each mode controller (always available,
   * regardless of which is active — useful for pre-setting targets).
   */
  get erg()          { return this._modes[MODES.ERG]; }
  get resistance()   { return this._modes[MODES.RESISTANCE]; }
  get slope()        { return this._modes[MODES.SLOPE]; }
  get virtualGear()  { return this._modes[MODES.VIRTUAL_GEAR]; }

  // ── Switching ─────────────────────────────────────────────────────────────

  /**
   * Switch to a new mode mid-session.
   * Deactivates the current mode before activating the new one.
   * No-op if the requested mode is already active.
   *
   * @param {string} modeName  One of MODES.*
   */
  async switchTo(modeName) {
    if (!this._modes[modeName]) {
      const known = Object.values(MODES).includes(modeName);
      throw new Error(known
        ? `[mode-switch] "${modeName}" is not supported by the connected device`
        : `[mode-switch] Unknown mode: "${modeName}"`);
    }
    if (this._active === modeName) return;

    // Deactivate current
    if (this._active) {
      try {
        await this._modes[this._active].deactivate();
      } catch (err) {
        console.warn('[mode-switch] Error deactivating', this._active, err.message);
      }
    }

    this._active = modeName;

    // Activate new
    try {
      await this._modes[modeName].activate();
    } catch (err) {
      console.error('[mode-switch] Error activating', modeName, err.message);
      this._active = null;
      throw err;
    }

    console.info('[mode-switch] Switched to', modeName);
    this._notify();
  }

  /**
   * Deactivate all modes (e.g. when a session ends or device disconnects).
   */
  async deactivateAll() {
    if (this._active) {
      try { await this._modes[this._active].deactivate(); } catch { /* ignore */ }
      this._active = null;
      this._notify();
    }
  }

  // ── Target helpers (delegate to current mode) ─────────────────────────────

  /**
   * Set a target on the currently active mode.
   * The meaning of `value` depends on the mode:
   *   erg:          watts
   *   resistance:   percent (0–100)
   *   slope:        grade percent (e.g. 4.5)
   *   virtualGear:  (use shiftUp/shiftDown instead)
   *
   * @param {number} value
   */
  async setTarget(value) {
    if (!this.currentMode) throw new Error('[mode-switch] No active mode');
    await this.currentMode.setTarget(value);
  }

  /**
   * Nudge the current mode's target.
   * @param {number} delta  Positive or negative; units depend on mode.
   */
  async adjust(delta) {
    if (!this.currentMode) throw new Error('[mode-switch] No active mode');
    if (typeof this.currentMode.adjust === 'function') {
      await this.currentMode.adjust(delta);
    }
  }

  /**
   * Feed a live telemetry sample to whichever mode is currently active, AND
   * to this class's own mode-independent activity tracking (see
   * _checkActivity() below), which is what drives onIdle()/onActive().
   * Safe to call unconditionally on every trainer data tick regardless of
   * device or active mode — forwarding to the current mode is a no-op
   * unless it defines onPowerSample() (today, only SmartErgMode does; real
   * FTMS trainers hold their target with a single write and don't need a
   * feedback loop), but the activity tracking always runs.
   * @param {number} watts
   * @param {number} [cadence]
   * @param {number} [speed]  km/h — optional third activity signal, for
   *                          devices/modes where cadence isn't reported but
   *                          wheel/crank-derived speed is (see ble/ftms-device.js).
   */
  onPowerSample(watts, cadence, speed) {
    this.currentMode?.onPowerSample?.(watts, cadence);
    this._checkActivity(watts, cadence, speed);
  }

  /**
   * Mode-independent "is the rider actually riding" tracker. Runs off the
   * same raw watts/cadence/speed every mode already gets via
   * onPowerSample(), rather than any one mode's internal state — that's
   * what makes onIdle()/onActive() work the same for real FTMS ERG,
   * resistance, slope, and virtualGear, not just SmartErgMode's software
   * loop (which only ever fed idle events for itself — see the
   * onIdleRest() relay in the constructor above).
   *
   * Two distinct edges, driven by the same isActive test:
   *   - onIdle():   debounced by IDLE_TIMEOUT (mirrors smart-erg.js's own
   *                 debounce) so a momentary gap between pedal strokes
   *                 doesn't trigger an auto-pause — fires once per idle
   *                 episode via _idleNotified, same pattern as
   *                 smart-erg.js#_maybeAutoRest.
   *   - onActive():  NOT debounced — fires the instant activity resumes
   *                 (or is first seen), so app.js can start a workout's
   *                 timer the moment the rider actually starts pedaling
   *                 rather than lagging behind by IDLE_TIMEOUT. Edge-
   *                 triggered off _wasActive so it fires once per
   *                 activity episode, not on every active sample.
   * @param {number} watts
   * @param {number} [cadence]
   * @param {number} [speed]
   */
  _checkActivity(watts, cadence, speed) {
    const isActive = (watts ?? 0) > 0 || (cadence ?? 0) > 0 || (speed ?? 0) > 0;

    if (isActive) {
      if (!this._wasActive) this._notifyActive();
      this._wasActive    = true;
      this._idleSince    = null;
      this._idleNotified = false;
      return;
    }

    this._wasActive = false;

    const now = Date.now();
    if (this._idleSince == null) {
      this._idleSince = now;
      return;
    }
    if (now - this._idleSince < IDLE_TIMEOUT) return;
    if (this._idleNotified) return;

    this._idleNotified = true;
    this._notifyIdle();
  }

  /** Shift up (virtual gear only; no-op for other modes). */
  async shiftUp() {
    if (this._active === MODES.VIRTUAL_GEAR) {
      await this._modes[MODES.VIRTUAL_GEAR].shiftUp();
    }
  }

  /** Shift down (virtual gear only; no-op for other modes). */
  async shiftDown() {
    if (this._active === MODES.VIRTUAL_GEAR) {
      await this._modes[MODES.VIRTUAL_GEAR].shiftDown();
    }
  }

  // ── Profile updates ───────────────────────────────────────────────────────

  /**
   * Update the FTP used by ERG mode's percentage helpers.
   * @param {number} ftp
   */
  setFtp(ftp) {
    this._modes[MODES.ERG]?.setFtp(ftp);
  }

  /**
   * Update rider/bike physics for slope simulation. No-op if this device
   * doesn't support slope mode.
   * @param {Object} params
   */
  setRiderParams(params) {
    this._modes[MODES.SLOPE]?.setRiderParams(params);
  }

  // ── Subscription ──────────────────────────────────────────────────────────

  /**
   * Subscribe to mode change events.
   * Callback receives { mode: string|null, controller: object|null }
   * Returns an unsubscribe function.
   *
   * @param {Function} fn
   * @returns {Function}
   */
  subscribe(fn) {
    this._subscribers.add(fn);
    try { fn({ mode: this._active, controller: this.currentMode }); } catch { /* ignore */ }
    return () => this._subscribers.delete(fn);
  }

  _notify() {
    const payload = { mode: this._active, controller: this.currentMode };
    for (const fn of this._subscribers) {
      try { fn(payload); } catch (e) { console.error('[mode-switch] subscriber error', e); }
    }
  }

  // ── Idle / activity notification ──────────────────────────────────────────

  /**
   * Subscribe to idle events, for as long as this ModeSwitch instance (and
   * thus the device connection) lives — not tied to which mode happens to
   * be active at subscribe time, or to any mode being active at all. Driven
   * by this class's own _checkActivity() off raw watts/cadence/speed (see
   * onPowerSample() above), so it fires the same way for real FTMS ERG,
   * resistance, slope, and virtualGear as it does for SmartErgMode's
   * software loop — not just the latter, which is all this used to cover.
   * Used by app.js to auto-pause the workout when the rider stops pedaling,
   * for any mode, as long as the device is connected and sending data.
   * @param {Function} fn  Called with no arguments
   * @returns {Function} unsubscribe
   */
  onIdle(fn) {
    this._idleSubscribers.add(fn);
    return () => this._idleSubscribers.delete(fn);
  }

  _notifyIdle() {
    for (const fn of this._idleSubscribers) {
      try { fn(); } catch (e) { console.error('[mode-switch] idle subscriber error', e); }
    }
  }

  /**
   * Subscribe to "the rider just started providing live activity" — the
   * mirror image of onIdle(), driven by the same _checkActivity() above.
   * Unlike onIdle(), this is NOT debounced: it fires on the very first
   * watts/cadence/speed>0 sample after an idle (or initial) state, so
   * app.js can use it to start a workout's timer the moment the rider
   * actually starts pedaling instead of when they merely press Start —
   * see app.js's startSession()/_armPendingStart().
   * @param {Function} fn  Called with no arguments
   * @returns {Function} unsubscribe
   */
  onActive(fn) {
    this._activeSubscribers.add(fn);
    return () => this._activeSubscribers.delete(fn);
  }

  _notifyActive() {
    for (const fn of this._activeSubscribers) {
      try { fn(); } catch (e) { console.error('[mode-switch] active subscriber error', e); }
    }
  }
}

export default ModeSwitch;
