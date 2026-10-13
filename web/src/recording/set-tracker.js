// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * recording/set-tracker.js
 *
 * Set/hold logging for a live strength session — the reps-sets-and-holds
 * counterpart to laps.js's LapTracker. Deliberately built the same way:
 * a small class that records boundaries against a Session's existing
 * sample buffer and derives summaries from it on demand, rather than
 * keeping its own parallel copy of the data.
 *
 * That reuse is the whole point: a strength/isometric session is just a
 * recording/session.js Session with no trainer/power source connected —
 * typically just an HR strap via ble/hr-device.js, same role-based
 * plumbing every other device uses (see ble/roles.js/capabilities.js).
 * Session already samples heartRate at 1Hz into `samples` for any
 * connected HR source, completely unaware this is a strength session — so
 * every logged set here gets a real HR summary (average, peak, and
 * *drift*, i.e. HR at the end of the set vs. the start — a genuine
 * cardiovascular-strain signal, especially for isometric holds) for free,
 * with no new BLE code at all.
 *
 * Usage:
 *   import { SetTracker } from './recording/set-tracker.js';
 *   const tracker = new SetTracker();
 *
 *   // Timed (hold) set — begin when the hold starts, complete when it ends:
 *   tracker.beginSet({ exercise: 'Plank', mode: 'hold', targetHoldSeconds: 60 }, session.sampleCount);
 *   // ...user holds, session keeps sampling HR in the background...
 *   const logged = tracker.completeSet({ holdSeconds: 47 }, session.sampleCount, session.samples);
 *
 *   // Manually-entered (reps) set — logged after the fact, in one call:
 *   tracker.logSet({ exercise: 'Back Squat', mode: 'reps', weight: 100, reps: 5 },
 *                   session.sampleCount, session.samples);
 *
 *   // Before session.stop(), attach the log so it's saved with the record:
 *   session.setMeta({ type: 'strength', sets: tracker.sets });
 */

import { createStrengthSet } from '../core/strength-model.js';

export class SetTracker {
  constructor() {
    /** Completed StrengthSet[], in logged order. */
    this._sets = [];
    /** { set, sampleIndexStart } while a timed (HOLD) set is in progress, else null. */
    this._pending = null;
  }

  /** Reset for a new session. */
  reset() {
    this._sets = [];
    this._pending = null;
  }

  /**
   * Restore previously logged sets — used the same way LapTracker.restore()
   * rehydrates a Session from a snapshot after an app restart (see
   * recording/session-persistence.js).
   * @param {import('../core/strength-model.js').StrengthSet[]} sets
   */
  restore(sets) {
    this._sets = (sets ?? []).map(s => ({ ...s }));
  }

  /** All completed sets, in logged order. */
  get sets() { return [...this._sets]; }

  /** True while a beginSet() is awaiting its matching completeSet(). */
  get inProgress() { return this._pending !== null; }

  /** The set currently being timed, if any (read-only snapshot). */
  get pendingSet() { return this._pending ? { ...this._pending.set } : null; }

  /**
   * Starts timing a set/hold. Call when the rider taps "Start Hold" (or,
   * for a rep-mode set they want a live timer on too, "Start Set") — for
   * a rep-mode set entered only after the fact, skip straight to logSet()
   * instead.
   *
   * @param {Partial<import('../core/strength-model.js').StrengthSet>} fields
   *        At minimum `{ exercise, mode }`.
   * @param {number} sampleIndex  Current session.sampleCount.
   * @param {number} [timestamp]
   * @returns {import('../core/strength-model.js').StrengthSet} the pending set
   */
  beginSet(fields, sampleIndex, timestamp = Date.now()) {
    const set = createStrengthSet({ ...fields, startedAt: timestamp, sampleIndexStart: sampleIndex });
    this._pending = { set, sampleIndexStart: sampleIndex };
    return { ...set };
  }

  /** Discards the in-progress set without logging it (e.g. rider cancels a hold). */
  cancelSet() {
    this._pending = null;
  }

  /**
   * Finishes the in-progress set: attaches setNumber, restSec, and an HR
   * summary computed from the sample buffer between beginSet() and now,
   * then appends it to the log.
   *
   * @param {Partial<import('../core/strength-model.js').StrengthSet>} fields
   *        Result fields — e.g. `{ holdSeconds: 47 }` or `{ reps: 5, weight: 100 }`.
   * @param {number}   sampleIndex  Current session.sampleCount.
   * @param {import('../core/sample.js').Sample[]} samples  session.samples.
   * @param {number}   [timestamp]
   * @returns {import('../core/strength-model.js').StrengthSet|null} null if nothing was pending.
   */
  completeSet(fields, sampleIndex, samples, timestamp = Date.now()) {
    if (!this._pending) return null;

    const { set, sampleIndexStart } = this._pending;
    const finished = {
      ...set,
      ...fields,
      setNumber: this._nextSetNumber(set.exercise),
      completedAt: timestamp,
      sampleIndexEnd: sampleIndex,
      restSec: this._restSecBefore(sampleIndexStart, samples),
      ..._hrSummary(samples, sampleIndexStart, sampleIndex),
    };

    this._sets.push(finished);
    this._pending = null;
    return finished;
  }

  /**
   * Shortcut for rep-mode sets the app only learns about after they're
   * done (typed in after the set, not timed live) — logs a complete set
   * in one call. The HR summary spans from the end of the previous set (or
   * session start) to now, so even a manually-entered set gets a
   * meaningful HR reading covering its rest-then-lift window.
   *
   * @param {Partial<import('../core/strength-model.js').StrengthSet>} fields
   * @param {number} sampleIndex
   * @param {import('../core/sample.js').Sample[]} samples
   * @param {number} [timestamp]
   * @returns {import('../core/strength-model.js').StrengthSet}
   */
  logSet(fields, sampleIndex, samples, timestamp = Date.now()) {
    const prevEnd = this._sets.length ? this._sets[this._sets.length - 1].sampleIndexEnd : 0;
    this.beginSet(fields, prevEnd, timestamp);
    return this.completeSet(fields, sampleIndex, samples, timestamp);
  }

  /** All logged sets for one exercise, in logged order. */
  forExercise(name) {
    return this._sets.filter(s => s.exercise === name);
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _nextSetNumber(exercise) {
    return this._sets.filter(s => s.exercise === exercise).length + 1;
  }

  _restSecBefore(sampleIndexStart, samples) {
    if (!this._sets.length || !samples?.length) return null;
    const prev = this._sets[this._sets.length - 1];
    if (prev.completedAt == null) return null;
    const startSample = samples[Math.min(sampleIndexStart, samples.length - 1)];
    if (!startSample) return null;
    return Math.max(0, Math.round((startSample.timestamp - prev.completedAt) / 1000));
  }
}

function _hrSummary(samples, startIdx, endIdx) {
  const from = Math.max(0, startIdx ?? 0);
  const to = Math.max(from, endIdx ?? from);
  const slice = (samples ?? []).slice(from, to);
  const hrs = slice.map(s => s.heartRate).filter(v => v !== null && v !== undefined);

  if (!hrs.length) {
    return { avgHr: null, maxHr: null, hrStart: null, hrEnd: null, hrDrift: null };
  }

  const avgHr = Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length);
  const maxHr = Math.max(...hrs);
  const hrStart = hrs[0];
  const hrEnd = hrs[hrs.length - 1];
  return { avgHr, maxHr, hrStart, hrEnd, hrDrift: hrEnd - hrStart };
}

export default SetTracker;
