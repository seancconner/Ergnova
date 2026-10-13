// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * core/strength-model.js
 *
 * Canonical shape for a single *logged* strength set or isometric hold —
 * the reps/sets/holds counterpart to core/cardio-model.js (which models
 * *planned* cardio steps) and core/sample.js (which models one time-stamped
 * cardio reading). Where those two exist because cardio sessions are a
 * continuous stream against a plan, a strength session is a series of
 * discrete, user-reported events — so the model here is deliberately
 * flatter: no steps/targets to resolve, just what happened.
 *
 * A StrengthSet is a plain JS object — no class instances, no circular
 * references — same rationale as WorkoutModel: it needs to serialise
 * straight into a Session's `meta` (see recording/session.js's
 * constructor `opts.meta` / `setMeta()`) and round-trip through IndexedDB
 * via storage/db.js's existing `sessions` store without any schema change
 * there — a strength session is simply a Session with no trainer/power
 * source connected (typically just an HR strap, if worn) whose saved
 * record carries `meta: { type: 'strength', sets: [...] }`.
 *
 * Weight is always stored in kilograms, matching the rest of the app's
 * canonical-SI-then-convert-at-display-time convention (power in watts,
 * distance in meters, etc. — see metrics/units.js) — convert to/from the
 * rider's display unit with metrics/units.js's kgToLb()/lbToKg() at the
 * UI boundary, not in this model.
 *
 * Usage:
 *   import { createStrengthSet, SET_MODES, totalVolume } from './core/strength-model.js';
 *
 *   const set = createStrengthSet({
 *     exercise: 'Back Squat',
 *     mode: SET_MODES.REPS,
 *     weight: 100,   // kg
 *     reps: 5,
 *   });
 */

// ─── Set mode constants ────────────────────────────────────────────────────

export const SET_MODES = Object.freeze({
  REPS: 'reps', // a standard set: N reps, optionally against a load
  HOLD: 'hold', // an isometric hold: a duration instead of reps (plank, wall-sit, dead hang...)
});

// ─── ID generator ───────────────────────────────────────────────────────────
// Same pattern as cardio-model.js's nextId() — a simple monotonic counter,
// good enough for in-memory IDs before a set is persisted.
let _idCounter = 1;
function nextId() { return `set_${_idCounter++}`; }

// ─── Set factory ────────────────────────────────────────────────────────────

/**
 * Creates a single logged StrengthSet with defaults.
 *
 * @param {Partial<StrengthSet>} fields
 * @returns {StrengthSet}
 */
export function createStrengthSet(fields = {}) {
  return {
    /** Unique ID within a session (string). */
    id: nextId(),

    /** Display name, e.g. "Back Squat", "Plank". Free text — see
     *  recentExerciseNames() below for autocomplete sourced from history. */
    exercise: '',

    /** One of SET_MODES. */
    mode: SET_MODES.REPS,

    // ── REPS mode ──────────────────────────────────────────────────────────
    /** Reps completed. Null until logged. */
    reps: null,

    /** Reps the set was aiming for, if the rider set one. Purely informational. */
    targetReps: null,

    /** Load in kilograms. Null = bodyweight / no added load. */
    weight: null,

    // ── HOLD mode ──────────────────────────────────────────────────────────
    /** Actual held duration in seconds. Null until logged. */
    holdSeconds: null,

    /** Target hold duration in seconds, if the rider set one. */
    targetHoldSeconds: null,

    // ── Shared ──────────────────────────────────────────────────────────────
    /** Rate of perceived exertion, 1–10. Optional. */
    rpe: null,

    /** Seconds rested *before* this set (since the previous one finished, or
     *  since session start for the first set). Filled by recording/set-tracker.js. */
    restSec: null,

    /** 1-based position of this set within its exercise (2nd "Back Squat"
     *  set of the session = 2, independent of other exercises interleaved
     *  in between). Filled by recording/set-tracker.js. */
    setNumber: null,

    /** Unix ms — when this set/hold began. */
    startedAt: null,

    /** Unix ms — when this set/hold was logged as complete. */
    completedAt: null,

    /** Index into the session's sample buffer at set start/end — lets any
     *  later HR/analysis reach back into the raw samples for this exact
     *  window, same idea as laps.js's LapMark.sampleIndex. Filled by
     *  recording/set-tracker.js. */
    sampleIndexStart: null,
    sampleIndexEnd: null,

    // ── HR summary (filled by recording/set-tracker.js from the session's
    // sample buffer between sampleIndexStart/End — see that file) ──────────
    /** Average heart rate (bpm) across the set/hold. */
    avgHr: null,
    /** Peak heart rate (bpm) across the set/hold. */
    maxHr: null,
    /** Heart rate at the very start of the set/hold. */
    hrStart: null,
    /** Heart rate at the very end of the set/hold. */
    hrEnd: null,
    /** hrEnd - hrStart. Positive = HR climbed over the course of the set —
     *  the main signal worth watching for isometric holds, where a rising
     *  drift over repeated holds of the same target duration is a decent
     *  proxy for accumulating cardiovascular strain / fatigue. */
    hrDrift: null,

    // Spread caller fields last so they override defaults.
    ...fields,
  };
}

// ─── Aggregate helpers ──────────────────────────────────────────────────────

/**
 * Total volume (weight × reps, summed) across a list of REPS-mode sets.
 * Bodyweight sets (weight === null) don't contribute — there's no
 * meaningful load to multiply by reps for those.
 *
 * @param {StrengthSet[]} sets
 * @returns {number} kilograms
 */
export function totalVolume(sets) {
  return (sets ?? [])
    .filter(s => s.mode === SET_MODES.REPS && s.weight != null && s.reps != null)
    .reduce((acc, s) => acc + s.weight * s.reps, 0);
}

/**
 * Total time held (seconds) across a list of HOLD-mode sets.
 * @param {StrengthSet[]} sets
 * @returns {number}
 */
export function totalHoldTime(sets) {
  return (sets ?? [])
    .filter(s => s.mode === SET_MODES.HOLD && s.holdSeconds != null)
    .reduce((acc, s) => acc + s.holdSeconds, 0);
}

/**
 * Groups a flat list of sets by exercise name, preserving logged order
 * within each group. Returns an array (not a Map) of
 * { exercise, sets } so it's directly usable in a template-literal
 * render loop, same shape convention as chart-carousel.js's page list.
 *
 * @param {StrengthSet[]} sets
 * @returns {{exercise: string, sets: StrengthSet[]}[]}
 */
export function groupByExercise(sets) {
  const order = [];
  const map = new Map();
  for (const s of sets ?? []) {
    if (!map.has(s.exercise)) {
      map.set(s.exercise, []);
      order.push(s.exercise);
    }
    map.get(s.exercise).push(s);
  }
  return order.map(exercise => ({ exercise, sets: map.get(exercise) }));
}

/**
 * Distinct exercise names from past strength sessions, most-recently-used
 * first, for feeding an autocomplete/datalist — mirrors how overview.js
 * derives its stats straight from db.getSessions() records rather than
 * keeping a separate exercise-library store.
 *
 * @param {Object[]} sessions  Records from db.getSessions() (any type;
 *                             non-strength records are ignored).
 * @param {number}   [limit=20]
 * @returns {string[]}
 */
export function recentExerciseNames(sessions, limit = 20) {
  const seen = new Set();
  for (const session of sessions ?? []) {
    if (session?.meta?.type !== 'strength') continue;
    for (const set of session.meta.sets ?? []) {
      if (set.exercise) seen.add(set.exercise);
      if (seen.size >= limit) return [...seen];
    }
  }
  return [...seen];
}

export default {
  SET_MODES,
  createStrengthSet,
  totalVolume,
  totalHoldTime,
  groupByExercise,
  recentExerciseNames,
};

/**
 * @typedef {Object} StrengthSet
 * @property {string}      id
 * @property {string}      exercise
 * @property {'reps'|'hold'} mode
 * @property {number|null} reps
 * @property {number|null} targetReps
 * @property {number|null} weight              kilograms
 * @property {number|null} holdSeconds
 * @property {number|null} targetHoldSeconds
 * @property {number|null} rpe                 1-10
 * @property {number|null} restSec
 * @property {number|null} setNumber
 * @property {number|null} startedAt           Unix ms
 * @property {number|null} completedAt         Unix ms
 * @property {number|null} sampleIndexStart
 * @property {number|null} sampleIndexEnd
 * @property {number|null} avgHr
 * @property {number|null} maxHr
 * @property {number|null} hrStart
 * @property {number|null} hrEnd
 * @property {number|null} hrDrift
 */
