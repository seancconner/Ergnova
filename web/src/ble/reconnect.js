// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/reconnect.js
 *
 * Stores paired device IDs and auto-reconnects on the next launch using
 * bleTransport.getDevices() + device.watchAdvertisements() so the chooser
 * dialog is only shown the first time a device is paired.
 *
 * Backed by whichever BLE transport resolved (see ble/transport/index.js) —
 * real Web Bluetooth's Persistent Permissions API (Chrome 85+) when running
 * as a plain PWA, or the native bridge's equivalent when wrapped in the
 * C#/.NET MAUI shell.
 *
 * Usage:
 *   import { reconnect } from './ble/reconnect.js';
 *
 *   // After pairing a device for the first time:
 *   reconnect.remember(device);
 *
 *   // On app startup:
 *   await reconnect.start(onDeviceFound);
 *
 *   // To forget a device:
 *   reconnect.forget(deviceId);
 *
 *   // After a device drops mid-session (a real, accidental drop — not the rider
 *   // disconnecting it), listen for just that one device coming back:
 *   await reconnect.watch(deviceId, onDeviceFound);
 *   // ...and if the rider picks something else by hand instead, stop listening:
 *   reconnect.unwatch(deviceId);
 *
 *   // Right before/after a user-initiated (not a real drop) disconnect,
 *   // so it doesn't instantly hook back — see pause()'s own doc comment:
 *   reconnect.pause(deviceId);
 *   // ...and once the user manually reconnects it:
 *   reconnect.resume(deviceId);
 */
import { bleTransport } from './transport/index.js';

const STORAGE_KEY = 'ergnova_paired_devices';

// ─── Persisted device metadata (name + id for display) ───────────────────────

function _loadMeta() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch { return {}; }
}

function _saveMeta(meta) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
  } catch { /* quota exceeded or private mode */ }
}

// ─── Active watch handles ─────────────────────────────────────────────────────

const _watches = new Map(); // deviceId -> AbortController

// ─── Manual-disconnect pause ──────────────────────────────────────────────────
//
// Deliberately in-memory only (not persisted alongside _loadMeta()/_saveMeta()
// above) — a pause means "don't hook this device back up for the rest of the
// *current* session," not "never again." A fresh app launch is a fresh
// start()/watchAdvertisements() pass over every remembered device regardless
// of what was paused last time, which matches this module's own "reconnects
// on the next launch" framing at the top of this file: the person opening a
// new session presumably wants their gear back, even if they walked away from
// it mid-way through the last one.
const _paused = new Set(); // deviceId -> paused this session

// ─── Arming one watch ─────────────────────────────────────────────────────────

/**
 * Arms a watchAdvertisements() watch for one device handle, replacing any watch already open for
 * it. The first advertisement disarms the watch and calls onFound(device) — the caller does the
 * connecting. Shared by start() (every remembered device, at launch) and watch() (one device,
 * after a mid-session drop). Resolves true if the watch is armed.
 */
async function _arm(device, onFound) {
  const old = _watches.get(device.id);
  if (old) old.abort();

  const ac = new AbortController();
  _watches.set(device.id, ac);

  device.addEventListener('advertisementreceived', async () => {
    // Stop watching as soon as we get an advertisement — the caller
    // will handle connecting. Cancelling prevents repeated callbacks.
    ac.abort();
    if (_watches.get(device.id) === ac) _watches.delete(device.id);
    console.debug('[reconnect] Advertisement received from', device.id);
    try {
      await onFound(device);
    } catch (err) {
      console.error('[reconnect] onFound callback failed:', err);
    }
  }, { signal: ac.signal });

  try {
    await device.watchAdvertisements({ signal: ac.signal });
    console.debug('[reconnect] Watching advertisements for', device.id, device.name);
    return true;
  } catch (err) {
    // watchAdvertisements throws if the device is already connected or
    // the API is not supported — either is fine, just skip.
    if (err.name !== 'AbortError') {
      console.warn('[reconnect] watchAdvertisements failed for', device.id, err.message);
    }
    if (_watches.get(device.id) === ac) _watches.delete(device.id);
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const reconnect = {

  /**
   * Persist a device so it will be auto-reconnected next session.
   * Call this after the user successfully pairs a new device.
   *
   * @param {BluetoothDevice} device
   * @param {string} [kind]  Which wrapper class reconnects this device —
   *   'trainer' | 'merach' | 'smo2' | 'coreTemp' | 'hr' — so the app's reconnect
   *   dispatcher knows which class to instantiate without opening a chooser.
   *   Defaults to 'trainer' for back-compat with existing remembered entries.
   */
  remember(device, kind = 'trainer') {
    const meta = _loadMeta();
    meta[device.id] = { id: device.id, name: device.name ?? 'Unknown', kind };
    _saveMeta(meta);
    // A fresh remember() only ever follows a chooser pick the rider just
    // made themselves — connectController()/ScaleDevice#connect()/etc. all
    // call this right after requestDevice() resolves — so it's as much a
    // "the rider just manually (re)connected this" signal as pairing one.
    // Clearing any earlier pause here means disconnecting, then manually
    // picking the same device again, is enough to resume watching it;
    // callers don't each need their own resume() call for that path (see
    // pause()'s own doc comment for the one path that still does: the
    // reconnect.js-driven auto-reconnect route, connectDevice(existingDevice),
    // never calls remember() at all).
    this.resume(device.id);
    console.debug('[reconnect] Remembered device:', device.id, device.name, kind);
  },

  /**
   * Remove a device from the remembered list.
   * Also cancels any active watchAdvertisements() for it.
   *
   * @param {string} deviceId
   */
  forget(deviceId) {
    const meta = _loadMeta();
    delete meta[deviceId];
    _saveMeta(meta);

    const ac = _watches.get(deviceId);
    if (ac) { ac.abort(); _watches.delete(deviceId); }
    _paused.delete(deviceId);
    console.debug('[reconnect] Forgot device:', deviceId);
  },

  /**
   * Returns an array of { id, name } objects for all remembered devices.
   * @returns {{id: string, name: string}[]}
   */
  remembered() {
    return Object.values(_loadMeta());
  },

  /**
   * Pause auto-reconnect for one specific device — call this right when the
   * user *manually* disconnects it (a menu toggle, a sensor-chip's ✕), NOT
   * from a device's own 'disconnected'/gattserverdisconnected event, which
   * also fires for a real accidental drop (bike out of range, strap losing
   * skin contact) that auto-reconnect should still recover from on its own.
   * Getting that distinction right at each call site is what keeps this
   * scoped to "the thing the rider just told to disconnect" — pause()/
   * resume()/isPaused() are all keyed by deviceId, so pausing the trainer
   * has no effect on the HR strap's or the scale's own watch, and vice
   * versa; there's deliberately no app-wide "pause everything" toggle here.
   *
   * Two things this does:
   *  1. Marks deviceId so a future start() call (next reconnect.start()
   *     invocation — see that method) won't arm a watch for it.
   *  2. Immediately cancels this device's watch if one happens to already
   *     be active — covers the case where this device's watch, armed by an
   *     earlier start() call, never actually found it (it wasn't in range
   *     yet) and is still open when the rider manually connects and then
   *     disconnects it within the same session; without this, that
   *     leftover watch could still fire the moment the device resumes
   *     advertising post-disconnect, which is exactly the "hooks back
   *     instantly" symptom this exists to prevent.
   *
   * Stays paused until resume() is called (remember() calls it
   * automatically — see that method) or the app restarts (see this
   * module's own header comment on why _paused isn't persisted).
   *
   * @param {string} deviceId
   */
  pause(deviceId) {
    _paused.add(deviceId);
    const ac = _watches.get(deviceId);
    if (ac) { ac.abort(); _watches.delete(deviceId); }
    console.debug('[reconnect] Paused auto-reconnect for', deviceId);
  },

  /**
   * Clear a pause set by pause(). Does not, by itself, re-arm a watch for
   * the device — the next reconnect.start() call (or remember(), which
   * calls this automatically) is what does that.
   * @param {string} deviceId
   */
  resume(deviceId) {
    if (_paused.delete(deviceId)) {
      console.debug('[reconnect] Resumed auto-reconnect for', deviceId);
    }
  },

  /**
   * @param {string} deviceId
   * @returns {boolean} True while deviceId is paused (see pause()).
   */
  isPaused(deviceId) {
    return _paused.has(deviceId);
  },

  /**
   * Start watching for advertisements from all remembered devices.
   * For each device that is found, calls `onFound(device)`.
   *
   * This uses bleTransport.getDevices() to retrieve previously-granted
   * device handles, then calls watchAdvertisements() on each. Requires
   * either a Web Bluetooth backend with Chrome 85+'s persistent-permissions
   * API, or a native bridge that implements the equivalent (see
   * ble/transport/native-bridge-backend.js).
   *
   * @param {Function} onFound  Async callback receiving a device handle.
   * @returns {Promise<void>}
   */
  async start(onFound) {
    if (!bleTransport.isAvailable) {
      console.warn('[reconnect] No BLE transport available');
      return;
    }

    let devices;
    try {
      devices = await bleTransport.getDevices();
    } catch (err) {
      console.warn('[reconnect] getDevices() failed:', err);
      return;
    }

    if (!devices || devices.length === 0) {
      console.debug('[reconnect] No previously granted devices found');
      return;
    }

    const meta = _loadMeta();

    for (const device of devices) {
      // Only watch devices the user explicitly remembered.
      if (!meta[device.id]) continue;
      // ...and that aren't mid-pause from a manual disconnect earlier this
      // session (see pause()'s own doc comment).
      if (_paused.has(device.id)) {
        console.debug('[reconnect] Skipping paused device', device.id);
        continue;
      }
      await _arm(device, onFound);
    }
  },

  /**
   * Listen for one remembered device to start advertising again, then call
   * `onFound(device)` once. start() only arms its watches once, at launch, and
   * each one disarms itself after the first advertisement — so a device that
   * drops *mid-session* (a strap losing skin contact, a bike out of range) has
   * nothing listening for it any more. This re-arms exactly that one device.
   *
   * Does nothing (resolves `false`) when the device isn't remembered, is paused
   * (the rider disconnected it on purpose), or the transport can't hand it back.
   * Calling it again for a device already being watched replaces the old watch
   * rather than stacking a second one.
   *
   * @param {string} deviceId
   * @param {Function} onFound  Async callback receiving the device handle.
   * @returns {Promise<boolean>} true if a watch is now armed
   */
  async watch(deviceId, onFound) {
    if (!bleTransport.isAvailable) return false;
    if (!_loadMeta()[deviceId]) return false;
    if (_paused.has(deviceId)) return false;

    let devices;
    try {
      devices = await bleTransport.getDevices();
    } catch (err) {
      console.warn('[reconnect] getDevices() failed:', err);
      return false;
    }
    const device = (devices ?? []).find(d => d.id === deviceId);
    if (!device) return false;

    // The rider may have paused it while getDevices() was in flight.
    if (_paused.has(deviceId)) return false;
    return _arm(device, onFound);
  },

  /**
   * Stop watching one device, without pausing it or forgetting it. For when the
   * rider takes over by hand (picks a strap from the chooser) while a watch for
   * the old one is still open.
   * @param {string} deviceId
   */
  unwatch(deviceId) {
    const ac = _watches.get(deviceId);
    if (ac) { ac.abort(); _watches.delete(deviceId); }
  },

  /**
   * @param {string} deviceId
   * @returns {boolean} True while a watch for deviceId is armed.
   */
  isWatching(deviceId) {
    return _watches.has(deviceId);
  },

  /**
   * Stop watching all devices (e.g. when the session starts to save battery).
   */
  stop() {
    for (const [deviceId, ac] of _watches) {
      ac.abort();
      console.debug('[reconnect] Stopped watching', deviceId);
    }
    _watches.clear();
  },

  /**
   * Returns true if auto-reconnect is available through whichever BLE
   * transport resolved (Web Bluetooth or the native bridge).
   * @returns {boolean}
   */
  isSupported() {
    return bleTransport.isAvailable;
  },
};

export default reconnect;
