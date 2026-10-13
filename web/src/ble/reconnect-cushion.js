// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/reconnect-cushion.js
 *
 * A brief grace period after any device (re)connects, during which the
 * app treats its readings as not-yet-arrived rather than live — see
 * app.js's onAuxData()/onTrainerData(), which check isSettling() before
 * forwarding a device's data into session.pushData()/deviceManager.update().
 *
 * Exists because a BLE sensor's very first notification(s) right after
 * establishing (or re-establishing) its connection are sometimes garbage
 * or a placeholder zero — a heart-rate strap that hasn't yet detected
 * skin contact, a power meter mid-handshake — rather than a real reading.
 * Without this, that stray value gets charted and recorded exactly like
 * any other live sample: a heart-rate strap reconnecting mid-ride, for
 * instance, would draw its line dropping to 0 and holding there in its
 * own color until real beats start arriving, instead of just continuing
 * the existing "stale" gray forward-fill (charts/chart-engine.js's own
 * _drawSeries()) a beat or two longer, then jumping straight to the
 * real reading once the cushion clears.
 *
 * Keyed by whatever id the caller already uses for that device elsewhere
 * (trainer.id / device.id / 'hr-monitor', ...) — deliberately not GATT
 * connection state itself, so a query for a device this module has never
 * heard of just isn't settling, no special-casing needed at call sites.
 * Applied the same way on a device's very first connect this session as
 * on a reconnect — there's no reliable, cheap way to tell "first ever"
 * apart from "reconnected after a drop" from here, and a first connect
 * can hit the same notification-settling quirk anyway; the only visible
 * cost of applying it uniformly is that first live point landing a couple
 * of seconds later than it otherwise would.
 *
 * Usage:
 *   import { reconnectCushion } from './ble/reconnect-cushion.js';
 *
 *   // Right after a device's connect()/connectDevice() resolves:
 *   reconnectCushion.markConnected(device.id);
 *
 *   // In the shared onData handler, before forwarding anywhere:
 *   if (reconnectCushion.isSettling(device.id)) return;
 */

// How long to hold a (re)connected device's readings back from the chart/
// recording pipeline. Long enough to clear a strap's first stray zero or
// two at a ~1Hz notification rate; short enough that a rider reconnecting
// mid-set doesn't feel like the app is ignoring them.
const CUSHION_MS = 2500;

export class ReconnectCushion {
  constructor(cushionMs = CUSHION_MS, now = () => Date.now()) {
    this._cushionMs = cushionMs;
    this._now = now;
    this._settleUntil = new Map(); // deviceId -> timestamp (ms) cushion ends
  }

  /** Call the moment a device's connection succeeds (first connect or a
   *  reconnect alike — see this module's own doc comment for why no
   *  distinction is made between the two). Starts (or restarts, if
   *  somehow called again mid-cushion) that device's grace period. */
  markConnected(deviceId) {
    this._settleUntil.set(deviceId, this._now() + this._cushionMs);
  }

  /** True while `deviceId` is still within its post-connect grace period.
   *  A device markConnected() has never been called for — including one
   *  whose cushion has already elapsed — always returns false. */
  isSettling(deviceId) {
    const until = this._settleUntil.get(deviceId);
    return until != null && this._now() < until;
  }

  /** Ends a device's grace period early, if it has one running. Not
   *  currently called anywhere in app.js — a device that disconnects
   *  again mid-cushion just has its (harmless, unreachable) old timestamp
   *  overwritten by the next markConnected() — but kept as a public
   *  method for a caller that wants live data to resume immediately, e.g.
   *  a future "skip the wait" affordance in the UI. */
  clear(deviceId) {
    this._settleUntil.delete(deviceId);
  }
}

/** Shared singleton for app.js to use. */
export const reconnectCushion = new ReconnectCushion();
export default reconnectCushion;
