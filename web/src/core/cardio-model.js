// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * core/cardio-model.js
 *
 * Canonical in-memory representation of a *planned* cardio workout — ERG/
 * slope/resistance/heart-rate steps for a continuous trainer/rower/
 * elliptical effort. This is the format-independent intermediate model that:
 *   - Every importer (ZWO, FIT, TCX, ERG, MRC, PWX…) parses INTO
 *   - Every exporter writes FROM
 *   - The editor manipulates directly
 *   - The playback engine steps through
 *
 * A WorkoutModel is a plain JS object — no class instances, no circular
 * references — so it can be serialised to/from JSON freely.
 *
 * See core/strength-model.js for the reps/sets/holds counterpart: a
 * strength session is a series of discrete logged events rather than a
 * continuous stream against a plan, so it deliberately doesn't reuse
 * WorkoutModel/WorkoutStep at all.
 *
 * Usage:
 *   import { createWorkout, createStep, STEP_TYPES } from './core/cardio-model.js';
 *
 *   const workout = createWorkout({
 *     name: 'Sweet Spot 2x20',
 *     steps: [
 *       createStep({ type: STEP_TYPES.WARMUP,  duration: 600, targetType: 'power', targetLow: 0.50, targetHigh: 0.65 }),
 *       createStep({ type: STEP_TYPES.STEADY,  duration: 1200, targetType: 'power', targetLow: 0.88, targetHigh: 0.94 }),
 *       createStep({ type: STEP_TYPES.REST,    duration: 300,  targetType: 'power', targetLow: 0.50, targetHigh: 0.60 }),
 *       createStep({ type: STEP_TYPES.STEADY,  duration: 1200, targetType: 'power', targetLow: 0.88, targetHigh: 0.94 }),
 *       createStep({ type: STEP_TYPES.COOLDOWN,duration: 600,  targetType: 'power', targetLow: 0.40, targetHigh: 0.55 }),
 *     ],
 *   });
 */

// ─── Step type constants ──────────────────────────────────────────────────────

export const STEP_TYPES = Object.freeze({
  WARMUP:    'warmup',
  COOLDOWN:  'cooldown',
  STEADY:    'steady',      // constant target for entire duration
  RAMP:      'ramp',        // linearly transitions from targetLow to targetHigh
  FREE_RIDE: 'freeRide',    // no enforced target, trainer in resistance or free mode
  INTERVAL:  'interval',    // repeating on/off block (contains sub-steps)
  REST:      'rest',        // recovery between interval reps
});

// ─── Target type constants ────────────────────────────────────────────────────

export const TARGET_TYPES = Object.freeze({
  POWER:      'power',      // targets expressed as FTP multipliers (0.0–2.0)
  SLOPE:      'slope',      // targets expressed as grade percentage (e.g. 3.5 = 3.5%)
  RESISTANCE: 'resistance', // targets expressed as resistance % (0–100)
  HEART_RATE: 'heartRate',  // targets expressed in bpm — see HR_TOLERANCE_BPM/heartRateZone() below
  NONE:       'none',       // free ride, no target
});

// ─── Heart-rate zone tolerance ─────────────────────────────────────────────────
// Unlike power/slope/resistance, a heart-rate target can't be commanded to a
// trainer — it's the rider's own physiological response, not something a
// control loop can set directly (see control/mode-switch.js, which simply
// deactivates structured control for a HEART_RATE step). Instead, targetLow/
// targetHigh (or the single ramping value they interpolate — see
// resolveRampTarget() below) is read as the *center* of an acceptable zone,
// widened by this tolerance on each side, and the live playback engine
// (playback/scripted-session.js) nudges the rider with an audio cue when
// their measured heart rate strays outside it.
export const HR_TOLERANCE_BPM = 5;

/**
 * Widens a single target heart-rate value into a [low, high] bpm zone.
 * @param {number} targetBpm
 * @param {number} [tolerance=HR_TOLERANCE_BPM]
 * @returns {{low: number, high: number}}
 */
export function heartRateZone(targetBpm, tolerance = HR_TOLERANCE_BPM) {
  return { low: targetBpm - tolerance, high: targetBpm + tolerance };
}

// ─── ID generator ────────────────────────────────────────────────────────────
// Simple monotonic counter; good enough for in-memory IDs.
let _idCounter = 1;
function nextId() { return `step_${_idCounter++}`; }

// ─── Step factory ─────────────────────────────────────────────────────────────

/**
 * Creates a single workout step with defaults.
 *
 * Power targets are expressed as FTP multipliers (e.g. 0.88 = 88% of FTP).
 * Slope targets are grade percentages. Resistance targets are 0–100%. Heart-
 * rate targets are bpm — read as the center of an acceptable zone rather
 * than a trainer command; see HR_TOLERANCE_BPM/heartRateZone() above.
 *
 * For RAMP steps, targetLow is the starting value and targetHigh the ending value.
 * For STEADY steps, targetLow === targetHigh (or only targetLow is used).
 *
 * @param {Partial<WorkoutStep>} fields
 * @returns {WorkoutStep}
 */
export function createStep(fields = {}) {
  return {
    /** Unique ID within this workout (string). */
    id: nextId(),

    /** Step type — one of STEP_TYPES. */
    type: STEP_TYPES.STEADY,

    /** Duration in seconds. Required for all types except FREE_RIDE (which may be open-ended). */
    duration: 60,

    /** Target type — one of TARGET_TYPES. */
    targetType: TARGET_TYPES.POWER,

    /**
     * Lower target bound.
     * For power: FTP multiplier. For slope: grade %. For resistance: 0–100.
     * For STEADY steps this is the sole target; for RAMP it is the start value.
     */
    targetLow: 0.50,

    /**
     * Upper target bound.
     * For RAMP steps this is the end value; for STEADY steps it equals targetLow.
     * Set to null to treat as a single-value target.
     */
    targetHigh: null,

    /** Cadence target in RPM, or null if not prescribed. */
    cadenceTarget: null,

    /** Optional display name for this step. */
    name: '',

    /**
     * For RAMP steps only: the interpolation shape used to travel from
     * targetLow to targetHigh over the step's duration.
     *   'linear'    — constant rate of change (the default).
     *   'parabolic' — eases in with a squared curve (slow start,
     *                 accelerating finish). See curveProgress() below.
     * Ignored for every other step type.
     */
    curve: 'linear',

    /**
     * For INTERVAL steps only: array of sub-steps [{on: WorkoutStep, off: WorkoutStep}]
     * and a repeat count.
     */
    repeat: null,      // integer, only for INTERVAL type
    onStep: null,      // WorkoutStep for the "on" portion (only for INTERVAL)
    offStep: null,     // WorkoutStep for the "off" / recovery portion

    // Spread caller fields last.
    ...fields,
  };
}

// ─── Workout factory ──────────────────────────────────────────────────────────

/**
 * Creates a new WorkoutModel with defaults.
 *
 * @param {Partial<WorkoutModel>} fields
 * @returns {WorkoutModel}
 */
export function createWorkout(fields = {}) {
  return {
    /** Human-readable workout name. */
    name: 'Untitled Workout',

    /** Optional longer description. */
    description: '',

    /** Original source format, e.g. 'zwo', 'fit', 'mrc', 'manual'. */
    sourceFormat: 'manual',

    /** Array of WorkoutStep objects in playback order. */
    steps: [],

    /**
     * Suggested FTP value stored with the workout file, if any.
     * The actual FTP used during playback comes from the user profile;
     * this is metadata carried through import/export round-trips.
     */
    suggestedFtp: null,

    /** Sport type: 'cycling' | 'running' | 'generic'. */
    sport: 'cycling',

    /** ISO 8601 date string when this workout was created or imported. */
    createdAt: new Date().toISOString(),

    /** ISO 8601 date string when this workout was last edited. */
    updatedAt: new Date().toISOString(),

    // Spread caller fields last.
    ...fields,
  };
}

// ─── Derived helpers ──────────────────────────────────────────────────────────

/**
 * Returns the total duration of a workout in seconds,
 * accounting for interval repeats.
 *
 * @param {WorkoutModel} workout
 * @returns {number}
 */
export function totalDuration(workout) {
  return workout.steps.reduce((acc, step) => {
    if (step.type === STEP_TYPES.INTERVAL && step.repeat && step.onStep && step.offStep) {
      const onDur  = step.onStep.duration  ?? 0;
      const offDur = step.offStep.duration ?? 0;
      return acc + (onDur + offDur) * step.repeat;
    }
    return acc + (step.duration ?? 0);
  }, 0);
}

/**
 * Flattens an interval step into its individual on/off reps.
 * Returns an array of plain steps in sequential order.
 *
 * @param {WorkoutStep} step
 * @returns {WorkoutStep[]}
 */
export function flattenStep(step) {
  if (step.type !== STEP_TYPES.INTERVAL || !step.repeat) return [step];

  const flat = [];
  for (let i = 0; i < step.repeat; i++) {
    if (step.onStep)  flat.push({ ...step.onStep,  id: `${step.id}_on_${i}`  });
    if (step.offStep) flat.push({ ...step.offStep, id: `${step.id}_off_${i}` });
  }
  return flat;
}

/**
 * Returns a fully flattened array of steps with no INTERVAL nesting.
 * This is what the playback engine iterates over.
 *
 * @param {WorkoutModel} workout
 * @returns {WorkoutStep[]}
 */
export function flattenWorkout(workout) {
  return workout.steps.flatMap(flattenStep);
}

/**
 * Resolves a power target multiplier to absolute watts given an FTP.
 *
 * @param {number} multiplier  e.g. 0.88
 * @param {number} ftp         e.g. 250
 * @returns {number}           e.g. 220
 */
export function resolveWatts(multiplier, ftp) {
  return Math.round(multiplier * ftp);
}

// ─── Ramp curves ───────────────────────────────────────────────────────────────

/**
 * Eases a 0–1 progress fraction (elapsed / duration) according to a RAMP
 * step's curve shape. Applied to *progress*, not to the low/high values
 * directly, so it produces the same easing shape whether the ramp is
 * climbing or falling.
 *
 *   'linear'    — t, unchanged (constant rate of change).
 *   'parabolic' — t², i.e. a slow start that accelerates into the finish.
 *
 * @param {number} t      Raw progress, will be clamped to [0, 1].
 * @param {string} [curve]
 * @returns {number}      Eased progress in [0, 1].
 */
export function curveProgress(t, curve) {
  const clamped = Math.min(1, Math.max(0, t));
  return curve === 'parabolic' ? clamped * clamped : clamped;
}

/**
 * Resolves the live target value for a RAMP-type step at a given point in
 * its duration, honoring step.curve. Falls back to targetLow for
 * non-ramp steps, ramps with no targetHigh, or a zero/missing duration —
 * i.e. it's always safe to call on any step.
 *
 * @param {WorkoutStep} step
 * @param {number}      elapsedSec  Seconds into this step.
 * @returns {number}
 */
export function resolveRampTarget(step, elapsedSec) {
  if (step.type !== STEP_TYPES.RAMP || step.targetHigh == null || !step.duration) {
    return step.targetLow ?? 0;
  }
  const t = curveProgress(elapsedSec / step.duration, step.curve);
  return step.targetLow + (step.targetHigh - step.targetLow) * t;
}

// ─── Step generators ─────────────────────────────────────────────────────────
// Used by the workout editor's "Add step" tools — kept here rather than in
// the editor because they're pure, format-independent model construction,
// same as createStep()/createWorkout() above.

/**
 * Builds a single RAMP step that transitions from startValue to endValue
 * over `duration` seconds, following the given curve.
 *
 * @param {Object} opts
 * @param {string} [opts.name]
 * @param {number} opts.duration     Seconds, >= 1.
 * @param {string} [opts.targetType] One of TARGET_TYPES. Defaults to POWER.
 * @param {number} opts.startValue
 * @param {number} opts.endValue
 * @param {string} [opts.curve]      'linear' (default) or 'parabolic'.
 * @returns {WorkoutStep}
 */
export function createRampStep({
  name = '', duration, targetType = TARGET_TYPES.POWER, startValue, endValue, curve = 'linear',
} = {}) {
  return createStep({
    type: STEP_TYPES.RAMP,
    duration: Math.max(1, Math.round(duration)),
    targetType,
    targetLow:  startValue,
    targetHigh: endValue,
    curve,
    name,
  });
}

/**
 * Builds a series of flat (STEADY) steps — "zones" — that evenly divide
 * `duration` into `count` equal-length segments, with each zone's target
 * stepping evenly from startValue (first zone) to endValue (last zone).
 * A classic staircase/step-test shape.
 *
 * Zone durations are computed by rounding accumulated fractional seconds
 * at each boundary (rather than rounding each zone independently), so the
 * individual durations always sum to exactly `duration` instead of
 * drifting by a second or two from rounding error.
 *
 * @param {Object} opts
 * @param {string} [opts.name]       Base name; zones are suffixed " 1", " 2", … when count > 1.
 * @param {number} opts.duration     Total seconds across all zones, >= 1.
 * @param {number} opts.count        Number of flat zones, >= 1.
 * @param {string} [opts.targetType] One of TARGET_TYPES. Defaults to POWER.
 * @param {number} opts.startValue   Target of the first zone.
 * @param {number} opts.endValue     Target of the last zone.
 * @returns {WorkoutStep[]}
 */
export function createSteppedZones({
  name = '', duration, count, targetType = TARGET_TYPES.POWER, startValue, endValue,
} = {}) {
  const n = Math.max(1, Math.round(count));
  const totalDur = Math.max(n, Math.round(duration));
  const perZone = totalDur / n;

  const zones = [];
  let boundary = 0;
  for (let i = 0; i < n; i++) {
    const from = Math.round(boundary);
    boundary += perZone;
    const to = Math.round(boundary);
    const value = n === 1 ? startValue : startValue + (endValue - startValue) * (i / (n - 1));

    zones.push(createStep({
      type: STEP_TYPES.STEADY,
      duration: Math.max(1, to - from),
      targetType,
      targetLow:  value,
      targetHigh: null,
      name: name ? (n > 1 ? `${name} ${i + 1}` : name) : '',
    }));
  }
  return zones;
}

/**
 * Splits an existing RAMP step into a run of discrete STEADY zones —
 * a "staircase" version of the same start-to-end range, dividing it into
 * `divisions` equal-length flat steps instead of one continuous ramp.
 *
 * This is what the editor's toolbar dedicated "Step" tool used to build
 * from scratch; it's now a transform on a ramp instead of a separate
 * creation tool, since a linear ramp already covers everything the old
 * Step tool could produce — this just offers the staircase shape back out
 * of it on demand. Intended mainly for SLOPE-target ramps: a trainer's
 * slope/resistance control generally can't (or shouldn't) chase a
 * continuously moving grade the way ERG mode chases a continuously moving
 * power target, so a climb drafted as a smooth ramp often needs to ship
 * as fixed grade steps instead. Reuses createSteppedZones() for the
 * actual division math.
 *
 * @param {WorkoutStep} step        A RAMP step (targetLow -> targetHigh).
 * @param {number}      divisions   Number of flat zones to split into, >= 1.
 * @returns {WorkoutStep[]}
 */
export function stepsFromRamp(step, divisions) {
  return createSteppedZones({
    name: step.name,
    duration: step.duration,
    count: divisions,
    targetType: step.targetType,
    startValue: step.targetLow,
    endValue: step.targetHigh ?? step.targetLow,
  });
}

/**
 * Returns a human-readable string for a step target.
 * e.g. "220–235 W" or "5% grade" or "55% resistance"
 *
 * @param {WorkoutStep} step
 * @param {number|null} ftp   Required when targetType === 'power'
 * @returns {string}
 */
export function stepTargetLabel(step, ftp = null) {
  if (step.targetType === TARGET_TYPES.NONE) return 'Free ride';

  const lo = step.targetLow;
  const hi = step.targetHigh;

  if (step.targetType === TARGET_TYPES.POWER) {
    if (!ftp) {
      const loStr = `${Math.round(lo * 100)}%`;
      const hiStr = hi ? `–${Math.round(hi * 100)}%` : '';
      return `${loStr}${hiStr} FTP`;
    }
    const loW = resolveWatts(lo, ftp);
    const hiW = hi ? resolveWatts(hi, ftp) : null;
    return hiW && hiW !== loW ? `${loW}–${hiW} W` : `${loW} W`;
  }

  if (step.targetType === TARGET_TYPES.SLOPE) {
    const loStr = `${lo.toFixed(1)}%`;
    const hiStr = hi !== null && hi !== lo ? `–${hi.toFixed(1)}%` : '';
    return `${loStr}${hiStr} grade`;
  }

  if (step.targetType === TARGET_TYPES.RESISTANCE) {
    const loStr = `${Math.round(lo)}%`;
    const hiStr = hi !== null && hi !== lo ? `–${Math.round(hi)}%` : '';
    return `${loStr}${hiStr} resistance`;
  }

  if (step.targetType === TARGET_TYPES.HEART_RATE) {
    const loStr = `${Math.round(lo)}`;
    const hiStr = hi !== null && hi !== lo ? `–${Math.round(hi)}` : '';
    return `${loStr}${hiStr} bpm`;
  }

  return '';
}

// ─── Type documentation ───────────────────────────────────────────────────────

/**
 * @typedef {Object} WorkoutStep
 * @property {string}            id
 * @property {string}            type          - STEP_TYPES value
 * @property {number}            duration      - seconds
 * @property {string}            targetType    - TARGET_TYPES value
 * @property {number}            targetLow
 * @property {number|null}       targetHigh
 * @property {number|null}       cadenceTarget
 * @property {string}            name
 * @property {number|null}       repeat        - interval repeats
 * @property {WorkoutStep|null}  onStep
 * @property {WorkoutStep|null}  offStep
 */

/**
 * @typedef {Object} WorkoutModel
 * @property {string}        name
 * @property {string}        description
 * @property {string}        sourceFormat
 * @property {WorkoutStep[]} steps
 * @property {number|null}   suggestedFtp
 * @property {string}        sport
 * @property {string}        createdAt
 * @property {string}        updatedAt
 */
