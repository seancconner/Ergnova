// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * recording/session-persistence.js
 *
 * Makes the active workout survive an app kill — the phone's home button,
 * swiping the app away, the OS reclaiming a backgrounded tab, or the screen
 * simply locking (some browsers/PWA shells still discard a backgrounded tab
 * on screen-lock even with ux/wake-lock.js's Screen Wake Lock held, so this
 * is the backup for when that happens) all stop JS execution without
 * warning. There's no way to keep recording through that, and BLE GATT
 * connections don't survive it either, so the correct resting state is:
 * pause the workout, snapshot it to IndexedDB, and let the rider pick it
 * back up next launch — reopened straight into the resume banner instead of
 * silently dropped back on the Overview tab with no trace it existed — once
 * they've reopened the app and reconnected their hardware.
 *
 * Works with anything that implements Session's snapshot contract —
 * isRunning / isPaused / pause() / toSnapshot() — so it doesn't need to
 * know whether it's holding a free-ride Session or a ScriptedSession (see
 * recording/session.js and playback/scripted-session.js), and — since a
 * strength/isometric session (views/strength-session.js) is itself just a
 * plain Session under the hood (see recording/set-tracker.js's own
 * docstring) — not whether it's a cardio ride or a strength session either.
 * Cardio and strength each get their own IndexedDB slot (see _persist()'s
 * `key` below) so a killed ride and a killed strength session don't
 * clobber each other's snapshot — both can be waiting to resume at once.
 *
 * One exception to "pause, then snapshot": inside the native shell, when
 * platform/background-session.js reports its keep-alive service is running
 * (Android foreground service), the app is NOT frozen in the background and
 * the workout should keep recording — app.js then passes { pause: false }
 * so the snapshot is only a crash-recovery checkpoint (a swipe-away or an OS
 * kill would otherwise lose everything since the app was last visible).
 * Session#toSnapshot() is valid whether or not the session is paused, and a
 * restored session always comes back paused either way.
 *
 * Usage (see app.js):
 *   import { persistActiveWorkout, loadActiveWorkout, clearActiveWorkout,
 *            persistActiveStrengthWorkout, loadActiveStrengthWorkout,
 *            clearActiveStrengthWorkout }
 *     from './recording/session-persistence.js';
 *
 *   // The one service method each pair is built around — call it anywhere
 *   // the page might be about to die while a workout is running
 *   // (visibilitychange → hidden, pagehide, an auto/manual pause, etc.):
 *   document.addEventListener('visibilitychange', () => {
 *     if (document.visibilityState === 'hidden') {
 *       persistActiveWorkout(session);
 *       persistActiveStrengthWorkout(strengthSession);
 *     }
 *   });
 *
 *   // On next launch, before showing the normal "ready to train" state:
 *   const snapshot = await loadActiveWorkout();
 *   if (snapshot) {
 *     // Rebuild via Session.fromSnapshot() / ScriptedSession.fromSnapshot()
 *     // (snapshot.type is 'free' or 'scripted') and offer it back to the
 *     // rider — it comes back running-but-paused, ready for resume().
 *   }
 *   // loadActiveStrengthWorkout() is the same shape — snapshot.type is
 *   // always 'free' (a strength session never uses ScriptedSession), and
 *   // snapshot.meta.sets is the SetTracker log to hand to its restore().
 *
 *   // Once a workout ends normally (Stop/Finish, or the rider discards a
 *   // restored one instead of resuming it):
 *   await clearActiveWorkout();          // cardio
 *   await clearActiveStrengthWorkout();  // strength
 */

import { db } from '../storage/db.js';

const CARDIO_PREF_KEY   = 'activeWorkout';
const STRENGTH_PREF_KEY = 'activeStrengthWorkout';

/**
 * Shared implementation behind persistActiveWorkout()/
 * persistActiveStrengthWorkout() — pauses `session` (if it isn't already)
 * and writes its snapshot to IndexedDB under `key` so it can be restored on
 * next launch. If there's no running session, this just clears any stale
 * snapshot instead — that's the normal "nothing to protect" case, not an
 * error.
 * @param {Object|null} session  A Session or ScriptedSession instance.
 * @param {string} key
 * @param {Object}  [opts]
 * @param {boolean} [opts.pause=true]  Pass false to checkpoint a running
 *        session without pausing it (see this file's header).
 * @returns {Promise<Object|null>} the snapshot that was saved, or null
 */
async function _persist(session, key, { pause = true } = {}) {
  if (!session?.isRunning) {
    await db.setPref(key, null);
    return null;
  }
  if (pause && !session.isPaused) session.pause();

  const snapshot = { ...session.toSnapshot(), savedAt: Date.now() };
  await db.setPref(key, snapshot);
  return snapshot;
}

/** @param {Object|null} session  A Session or ScriptedSession instance (cardio's).
 *  @param {{pause?: boolean}} [opts]  See _persist().
 *  @returns {Promise<Object|null>} the snapshot that was saved, or null */
export async function persistActiveWorkout(session, opts) {
  return _persist(session, CARDIO_PREF_KEY, opts);
}

/**
 * Returns the persisted cardio snapshot, or null if there isn't one.
 * @returns {Promise<Object|null>}
 */
export async function loadActiveWorkout() {
  return db.getPref(CARDIO_PREF_KEY, null);
}

/**
 * Clears any persisted cardio snapshot. Call once a ride ends normally, or
 * once the rider declines to resume a restored one.
 * @returns {Promise<void>}
 */
export async function clearActiveWorkout() {
  await db.setPref(CARDIO_PREF_KEY, null);
}

/** Strength counterpart to persistActiveWorkout() — same reasoning, its own
 *  IndexedDB slot (see this file's own doc comment above).
 *  @param {Object|null} session  A Session instance (strength's).
 *  @param {{pause?: boolean}} [opts]  See _persist().
 *  @returns {Promise<Object|null>} the snapshot that was saved, or null */
export async function persistActiveStrengthWorkout(session, opts) {
  return _persist(session, STRENGTH_PREF_KEY, opts);
}

/**
 * Returns the persisted strength snapshot, or null if there isn't one.
 * @returns {Promise<Object|null>}
 */
export async function loadActiveStrengthWorkout() {
  return db.getPref(STRENGTH_PREF_KEY, null);
}

/**
 * Clears any persisted strength snapshot. Call once a strength session ends
 * normally (Finish), or once the rider declines to resume a restored one.
 * @returns {Promise<void>}
 */
export async function clearActiveStrengthWorkout() {
  await db.setPref(STRENGTH_PREF_KEY, null);
}
