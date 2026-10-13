// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * data/cardio-timelines.js
 *
 * Preset & custom **cardio timelines** — named, structured target profiles
 * ("erg timelines") that back ui/cardio-session-flow.js's Sequence target
 * style (internal value 'mapped' — see TARGET_STYLES below).
 * Where a Steady quick-start session is one flat block for the whole
 * duration, a Sequence one plays back a whole shaped session (warm-up,
 * structured work, cool-down) picked from this file's presets, the same
 * "pick a whole shape up front" idea data/workout-sequences.js already
 * uses for a strength session's exercise sequence — this is that same
 * pattern one level up, for a *cardio* session's target shape instead of
 * an exercise list.
 *
 * ── Bundled + custom, same shape ────────────────────────────────────────
 * BUILTIN_TIMELINE_PRESETS ships sixteen presets — four different
 * training-use-case shapes (Sweet Spot/Tempo/Threshold/Endurance-Surges,
 * VO2 Max, Recovery/Endurance, and Anaerobic Sprints) at each of the
 * 20/30/45/60-minute durations, so every duration offers a real choice
 * instead of one fixed shape. ui/cardio-session-flow.js's "Open in Advanced Builder" action
 * loads a preset's materialized steps into editor/workout-editor.js so a
 * rider can tweak it and save the result as their own named preset —
 * that's addCustomTimelinePreset() below, same
 * createCustomExercise()-style `custom: true` flag and in-memory-cache-
 * over-storage/db.js shape data/exercises.js already uses for rider-authored
 * custom exercises (see that file's own doc comment). allTimelinePresets()
 * merges both lists exactly like data/exercises.js's allExercises() does,
 * so cardio-session-flow.js never needs to know or care that two sources feed
 * its preset picker.
 *
 * A TimelinePreset has the shape:
 *   {
 *     id: string,               // 'builtin:<slug>' or 'custom:<time-based>'
 *     label: string,
 *     tagline: string,          // one line, when-to-use guidance — shown in
 *                               // an info tooltip next to the title on
 *                               // ui/cardio-session-flow.js's picker card,
 *                               // not as a visible text line (that spot now
 *                               // shows a shape preview instead — see that
 *                               // file's _timelinePreviewSvg())
 *     durationMin: number,      // informational — the *real* duration is
 *                               // whatever steps actually sum to; kept in
 *                               // sync by _timelineFromSteps() below for
 *                               // every bundled preset, and recomputed
 *                               // fresh from the edited steps whenever a
 *                               // custom preset is saved (see app.js's
 *                               // WorkoutEditor onSavePreset wiring).
 *     group: string|undefined,  // one of TIMELINE_GROUPS — which output/
 *                               // training-effect section a bundled preset
 *                               // belongs to (see that constant below).
 *                               // undefined for custom presets — the
 *                               // Sequence picker buckets those into their
 *                               // own trailing "Custom" section by
 *                               // preset.custom instead of by this field.
 *     custom: boolean,
 *     basePresetId: string|null, // which preset a custom one started from, if any — display/reference only
 *     steps: WorkoutStep[],      // see core/cardio-model.js — POJOs, not
 *                               // live createStep() instances; always run
 *                               // through _freshStepClone() before being
 *                               // handed to a real session so every
 *                               // playback gets its own step ids (see
 *                               // buildTimelineWorkout()).
 *   }
 *
 * Usage:
 *   import { TARGET_STYLES, TIMELINE_GROUPS, TIMELINE_GROUP_ORDER,
 *            allTimelinePresets, timelinePresetById,
 *            buildTimelineWorkout, loadCustomTimelinePresets,
 *            addCustomTimelinePreset } from '../data/cardio-timelines.js';
 *
 *   await loadCustomTimelinePresets();               // once, during app init
 *   const presets = allTimelinePresets();             // 16 builtin + any custom
 *   const workout = buildTimelineWorkout(presets[0]);  // ready for a session
 */

import {
  createStep, createRampStep, createWorkout, totalDuration,
  STEP_TYPES, TARGET_TYPES,
} from '../core/cardio-model.js';
import { db } from '../storage/db.js';

// ─── Target styles ──────────────────────────────────────────────────────────
// The choice ui/cardio-session-flow.js's "Target style" control offers. Free is
// the original unstructured Free Ride behavior (now its own style rather
// than a Workout Type entry under Steady — see that file's own doc
// comment); Steady is one flat, rider-dialed-in target (HR Zone/FTP/VO2 Max
// — see cardio-session-flow.js's STEADY_MODES) for the whole session; Sequence
// (internal value 'mapped', kept as-is for backward compatibility with
// already-saved rider settings) swaps that one flat block for a whole
// cardio sequence — a preset timeline — from this file.
// Listed in this order (Free, Steady, Sequence) since that's also the
// display order of the toggle itself.
export const TARGET_STYLES = [
  {
    value: 'free',
    label: 'Free',
    blurb: 'No enforced target \u2014 ride at whatever effort you like. Pick a duration and go.',
  },
  {
    value: 'steady',
    label: 'Steady',
    blurb: 'One flat target for the whole session — pick a duration and go.',
  },
  {
    value: 'mapped',
    label: 'Sequence',
    blurb: 'A cardio sequence that shapes the target over the session — warm-up, structured work, cool-down — instead of one flat block.',
  },
];

// ─── Preset "output" categories ─────────────────────────────────────────────
// Which training-effect section a bundled preset belongs to — matches the
// four use-case comment blocks BUILTIN_TIMELINE_PRESETS is itself organized
// into below. Used by ui/cardio-session-flow.js's Cardio Sequence picker to
// group its option panel by output rather than by duration; TIMELINE_GROUP_ORDER is
// that dropdown's group display order. Custom (rider-saved) presets aren't
// classified into one of these — cardio-session-flow.js buckets every
// preset.custom === true entry into its own trailing "Custom" section
// instead, regardless of what training effect it actually has.
export const TIMELINE_GROUPS = Object.freeze({
  BUILD:    'Sweet Spot, Tempo & Threshold',
  VO2MAX:   'VO2 Max',
  RECOVERY: 'Recovery & Endurance',
  SPRINTS:  'Anaerobic Sprints',
});
export const TIMELINE_GROUP_ORDER = Object.freeze([
  TIMELINE_GROUPS.BUILD, TIMELINE_GROUPS.VO2MAX, TIMELINE_GROUPS.RECOVERY, TIMELINE_GROUPS.SPRINTS,
]);

// ─── Builders for the four bundled presets ─────────────────────────────────
// Every bundled preset is warm-up ramp → interval block → cool-down ramp,
// all in POWER (FTP-multiplier) targets — the same target type every other
// generated workout in the app (quick-start's steady block, the FTP/VO2max
// tests) already defaults to, so a rider without a power meter reads these
// exactly like any other structured workout here. Durations are chosen so
// warmup + repeat*(on+off) + cooldown sums to *exactly* durationMin*60 —
// see __cardio_timelines_smoketest__.js, which checks this against
// totalDuration() rather than trusting the arithmetic in the comments below.
function _timeline({ id, label, tagline, durationMin, group, warmup, interval, cooldown }) {
  const steps = [
    createRampStep({
      name: 'Warm-up', duration: warmup.duration, targetType: TARGET_TYPES.POWER,
      startValue: warmup.from, endValue: warmup.to,
    }),
    createStep({
      type: STEP_TYPES.INTERVAL, name: interval.name, repeat: interval.repeat,
      onStep: createStep({
        type: STEP_TYPES.STEADY, name: 'On', duration: interval.onDuration,
        targetType: TARGET_TYPES.POWER, targetLow: interval.onTarget,
      }),
      offStep: createStep({
        type: STEP_TYPES.REST, name: 'Recovery', duration: interval.offDuration,
        targetType: TARGET_TYPES.POWER, targetLow: interval.offTarget,
      }),
    }),
    createRampStep({
      name: 'Cool-down', duration: cooldown.duration, targetType: TARGET_TYPES.POWER,
      startValue: cooldown.from, endValue: cooldown.to,
    }),
  ];
  return { id, label, tagline, durationMin, group, custom: false, basePresetId: null, steps };
}

/** Sixteen bundled cardio timelines — four training-use-case shapes
 *  (Sweet Spot/Tempo/Threshold/Endurance-Surges, VO2 Max, Recovery/
 *  Endurance, and Anaerobic Sprints), each realized at all four of
 *  20/30/45/60 minutes, so a rider picking a duration still has a real
 *  choice of what kind of session to do in that time. Every preset is
 *  still the same warm-up ramp → repeating on/off interval block →
 *  cool-down ramp shape (see _timeline() above), sized so the whole
 *  thing plays back to exactly that many minutes. Grouped by use case
 *  (not by duration) below so the four durations of a given shape sit
 *  together for easy comparison/editing. */
export const BUILTIN_TIMELINE_PRESETS = [
  // ── Sweet Spot / Tempo / Threshold / Endurance-Surges ─────────────────
  // The original four presets — sustained, moderately-hard structured
  // work that builds aerobic power without digging a huge recovery hole.
  _timeline({
    id: 'builtin:20min-sweet-spot',
    label: 'Sweet Spot',
    tagline: 'Use when you\u2019re short on time but still want quality tempo-to-threshold work \u2014 three sweet-spot efforts build muscular endurance without a big recovery cost.',
    durationMin: 20,
    group: TIMELINE_GROUPS.BUILD,
    warmup:   { duration: 240, from: 0.50, to: 0.70 },
    interval: { name: 'Sweet Spot Intervals', repeat: 3, onDuration: 180, onTarget: 0.90, offDuration: 60, offTarget: 0.55 },
    cooldown: { duration: 240, from: 0.55, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:30min-tempo-build',
    label: 'Tempo',
    tagline: 'Use on a moderate training day to build sustainable aerobic power \u2014 four tempo efforts that push without wrecking tomorrow\u2019s legs.',
    durationMin: 30,
    group: TIMELINE_GROUPS.BUILD,
    warmup:   { duration: 300, from: 0.50, to: 0.68 },
    interval: { name: 'Tempo Intervals', repeat: 4, onDuration: 240, onTarget: 0.85, offDuration: 60, offTarget: 0.55 },
    cooldown: { duration: 300, from: 0.55, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:45min-threshold',
    label: 'Threshold',
    tagline: 'Use when raising FTP is the goal \u2014 five sustained threshold efforts that teach your body to hold a hard, steady pace.',
    durationMin: 45,
    group: TIMELINE_GROUPS.BUILD,
    warmup:   { duration: 360, from: 0.50, to: 0.68 },
    interval: { name: 'Threshold Intervals', repeat: 5, onDuration: 270, onTarget: 0.92, offDuration: 120, offTarget: 0.55 },
    cooldown: { duration: 390, from: 0.55, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:60min-endurance-surges',
    label: 'Endurance Surges',
    tagline: 'Use for a longer aerobic ride with a bit of spice \u2014 moderate surges keep it engaging without turning it into a full interval day.',
    durationMin: 60,
    group: TIMELINE_GROUPS.BUILD,
    warmup:   { duration: 480, from: 0.50, to: 0.65 },
    interval: { name: 'Endurance Surges', repeat: 6, onDuration: 300, onTarget: 0.85, offDuration: 120, offTarget: 0.55 },
    cooldown: { duration: 600, from: 0.55, to: 0.40 },
  }),

  // ── VO2 Max Intervals ──────────────────────────────────────────────────
  // Short, hard aerobic-ceiling work (~105-110% FTP) with recovery close
  // to 1:1 with the effort — the classic "raise your aerobic ceiling"
  // interval shape, at four different session lengths.
  _timeline({
    id: 'builtin:20min-vo2max',
    label: 'VO2 Max',
    tagline: 'Use for a quick, high-intensity aerobic-ceiling boost \u2014 four hard 2:30 efforts when you can\u2019t spare more than 20 minutes.',
    durationMin: 20,
    group: TIMELINE_GROUPS.VO2MAX,
    warmup:   { duration: 180, from: 0.50, to: 0.72 },
    interval: { name: 'VO2 Max Intervals', repeat: 4, onDuration: 150, onTarget: 1.10, offDuration: 60, offTarget: 0.50 },
    cooldown: { duration: 180, from: 0.55, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:30min-vo2max',
    label: 'VO2 Max',
    tagline: 'Use once or twice a week to raise your aerobic ceiling \u2014 four solid 4-minute efforts at classic VO2 max intensity.',
    durationMin: 30,
    group: TIMELINE_GROUPS.VO2MAX,
    warmup:   { duration: 240, from: 0.50, to: 0.72 },
    interval: { name: 'VO2 Max Intervals', repeat: 4, onDuration: 240, onTarget: 1.08, offDuration: 90, offTarget: 0.50 },
    cooldown: { duration: 240, from: 0.55, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:45min-vo2max',
    label: 'VO2 Max',
    tagline: 'Use for a serious aerobic-power session \u2014 five 4-minute VO2 max efforts, the classic interval workout for raising your ceiling.',
    durationMin: 45,
    group: TIMELINE_GROUPS.VO2MAX,
    warmup:   { duration: 300, from: 0.50, to: 0.72 },
    interval: { name: 'VO2 Max Intervals', repeat: 5, onDuration: 240, onTarget: 1.08, offDuration: 180, offTarget: 0.50 },
    cooldown: { duration: 300, from: 0.55, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:60min-vo2max',
    label: 'VO2 Max',
    tagline: 'Use for your hardest scheduled session of the week \u2014 six 4-minute VO2 max efforts to push your aerobic ceiling up.',
    durationMin: 60,
    group: TIMELINE_GROUPS.VO2MAX,
    warmup:   { duration: 360, from: 0.50, to: 0.70 },
    interval: { name: 'VO2 Max Intervals', repeat: 6, onDuration: 240, onTarget: 1.05, offDuration: 240, offTarget: 0.50 },
    cooldown: { duration: 360, from: 0.55, to: 0.40 },
  }),

  // ── Recovery / Endurance ───────────────────────────────────────────────
  // Low, steady zone-2-ish effort with only a short easy breather partway
  // through — a rest-day spin or aerobic base-building ride, not a
  // structured interval session, at four different lengths.
  _timeline({
    id: 'builtin:20min-recovery',
    label: 'Recovery',
    tagline: 'Use the day after a hard effort, or whenever you need blood flow and looseness without any real training stress.',
    durationMin: 20,
    group: TIMELINE_GROUPS.RECOVERY,
    warmup:   { duration: 180, from: 0.40, to: 0.55 },
    interval: { name: 'Easy Spin', repeat: 1, onDuration: 780, onTarget: 0.60, offDuration: 60, offTarget: 0.50 },
    cooldown: { duration: 180, from: 0.50, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:30min-recovery',
    label: 'Endurance Recovery',
    tagline: 'Use for an easy spin on a rest or travel day \u2014 long steady zone-2 riding with a short breather in the middle.',
    durationMin: 30,
    group: TIMELINE_GROUPS.RECOVERY,
    warmup:   { duration: 240, from: 0.40, to: 0.55 },
    interval: { name: 'Easy Spin', repeat: 1, onDuration: 1200, onTarget: 0.60, offDuration: 120, offTarget: 0.50 },
    cooldown: { duration: 240, from: 0.50, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:45min-recovery',
    label: 'Endurance',
    tagline: 'Use for aerobic base-building \u2014 two long easy blocks that add mileage without digging a fatigue hole.',
    durationMin: 45,
    group: TIMELINE_GROUPS.RECOVERY,
    warmup:   { duration: 300, from: 0.40, to: 0.55 },
    interval: { name: 'Endurance Blocks', repeat: 2, onDuration: 960, onTarget: 0.62, offDuration: 90, offTarget: 0.50 },
    cooldown: { duration: 300, from: 0.50, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:60min-recovery',
    label: 'Long Endurance',
    tagline: 'Use for real base-building or a long weekend ride \u2014 two extended steady blocks at an all-day pace.',
    durationMin: 60,
    group: TIMELINE_GROUPS.RECOVERY,
    warmup:   { duration: 360, from: 0.40, to: 0.55 },
    interval: { name: 'Endurance Blocks', repeat: 2, onDuration: 1320, onTarget: 0.62, offDuration: 120, offTarget: 0.50 },
    cooldown: { duration: 360, from: 0.50, to: 0.40 },
  }),

  // ── Anaerobic Sprints ──────────────────────────────────────────────────
  // Short maximal efforts (well above FTP) with long, generous recovery —
  // top-end power and neuromuscular work, not aerobic conditioning, at
  // four different lengths.
  _timeline({
    id: 'builtin:20min-sprints',
    label: 'Sprints',
    tagline: 'Use to sharpen top-end power and neuromuscular snap \u2014 six short maximal sprints with full recovery between.',
    durationMin: 20,
    group: TIMELINE_GROUPS.SPRINTS,
    warmup:   { duration: 300, from: 0.50, to: 0.75 },
    interval: { name: 'Anaerobic Sprints', repeat: 6, onDuration: 20, onTarget: 1.50, offDuration: 80, offTarget: 0.50 },
    cooldown: { duration: 300, from: 0.55, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:30min-sprints',
    label: 'Sprints',
    tagline: 'Use to develop sprint power and repeatability \u2014 six all-out 30-second efforts with generous recovery.',
    durationMin: 30,
    group: TIMELINE_GROUPS.SPRINTS,
    warmup:   { duration: 360, from: 0.50, to: 0.75 },
    interval: { name: 'Anaerobic Sprints', repeat: 6, onDuration: 30, onTarget: 1.45, offDuration: 150, offTarget: 0.50 },
    cooldown: { duration: 360, from: 0.55, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:45min-sprints',
    label: 'Sprints',
    tagline: 'Use to build repeatable sprint power over a longer session \u2014 six well-recovered maximal efforts spread across 45 minutes.',
    durationMin: 45,
    group: TIMELINE_GROUPS.SPRINTS,
    warmup:   { duration: 420, from: 0.50, to: 0.75 },
    interval: { name: 'Anaerobic Sprints', repeat: 6, onDuration: 40, onTarget: 1.40, offDuration: 270, offTarget: 0.50 },
    cooldown: { duration: 420, from: 0.55, to: 0.40 },
  }),
  _timeline({
    id: 'builtin:60min-sprints',
    label: 'Sprints',
    tagline: 'Use to combine an endurance-length ride with top-end power work \u2014 eight maximal sprints spread across a full hour.',
    durationMin: 60,
    group: TIMELINE_GROUPS.SPRINTS,
    warmup:   { duration: 480, from: 0.50, to: 0.75 },
    interval: { name: 'Anaerobic Sprints', repeat: 8, onDuration: 30, onTarget: 1.45, offDuration: 300, offTarget: 0.50 },
    cooldown: { duration: 480, from: 0.55, to: 0.40 },
  }),
];

// ─── Custom presets (rider-saved, from the advanced builder) ───────────────
// Same in-memory-cache-over-storage/db.js shape as data/exercises.js's
// _customExercises/loadCustomExercises() — see that file's own doc comment.

let _customTimelinePresets = [];

/** Creates a custom timeline preset with defaults — called from app.js once
 *  the advanced builder's "Save as Preset" action has a WorkoutModel to
 *  wrap (see editor/workout-editor.js's onSavePreset). `steps` should
 *  already be plain WorkoutStep-shaped objects (a saved WorkoutModel's
 *  `.steps` qualifies directly). */
export function createCustomTimelinePreset(fields = {}) {
  return {
    // Random suffix alongside the timestamp, not just Date.now() alone —
    // two presets saved in the same millisecond (plausible for a
    // scripted/rapid save, and hit by this file's own smoketest) would
    // otherwise collide. Same shape as data/exercises.js's own id
    // generation for custom exercises.
    id: `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    label: 'Custom Timeline',
    tagline: '',
    durationMin: 0,
    custom: true,
    basePresetId: null,
    steps: [],
    ...fields,
  };
}

/** Loads every rider-saved custom preset into the in-memory cache. Call
 *  once during app init (see app.js), same timing as loadCustomExercises(). */
export async function loadCustomTimelinePresets() {
  _customTimelinePresets = await db.getCustomCardioPresets();
  return _customTimelinePresets;
}

/** Synchronous — reflects whatever loadCustomTimelinePresets() last loaded
 *  plus any addCustomTimelinePreset()/removeCustomTimelinePreset() calls
 *  since, same contract as data/exercises.js's getCustomExercises(). */
export function getCustomTimelinePresets() {
  return _customTimelinePresets;
}

/** Persists a new custom preset and adds it to the in-memory cache. */
export async function addCustomTimelinePreset(fields) {
  const preset = createCustomTimelinePreset(fields);
  await db.saveCustomCardioPreset(preset);
  _customTimelinePresets = [..._customTimelinePresets, preset];
  return preset;
}

/** Removes a custom preset from storage and the in-memory cache. No-op
 *  (resolves normally) if the id doesn't match a custom preset — bundled
 *  presets aren't stored here at all, so there's nothing to delete for a
 *  'builtin:' id. */
export async function removeCustomTimelinePreset(id) {
  await db.deleteCustomCardioPreset(id);
  _customTimelinePresets = _customTimelinePresets.filter(p => p.id !== id);
}

/** Every timeline preset available to the picker — bundled + custom,
 *  bundled first so the sixteen fixed-duration/use-case presets always
 *  lead the list. */
export function allTimelinePresets() {
  return [...BUILTIN_TIMELINE_PRESETS, ..._customTimelinePresets];
}

/** Looks up one preset by id across both bundled and custom lists, or null
 *  if it's gone (e.g. a custom preset deleted since a saved quick-start
 *  draft was recorded — see ui/cardio-session-flow.js's buildQuickStartWorkout()
 *  for the fallback this enables). */
export function timelinePresetById(id) {
  return allTimelinePresets().find(p => p.id === id) ?? null;
}

// ─── Materializing a preset into a real, playable WorkoutModel ─────────────

/** Deep-clones a WorkoutStep (recursing into onStep/offStep) with a fresh
 *  id at every level — core/cardio-model.js's own doc comment calls a
 *  step's id "unique ID within this workout", so reusing a preset's stored
 *  ids verbatim across repeated session starts (or across the original
 *  preset and an edited copy of it open in the builder at once) would
 *  violate that. Every other field rides along unchanged. */
function _freshStepClone(step) {
  if (!step) return step;
  const { id, onStep, offStep, ...rest } = step;
  return createStep({
    ...rest,
    onStep:  onStep  ? _freshStepClone(onStep)  : null,
    offStep: offStep ? _freshStepClone(offStep) : null,
  });
}

/** Turns a TimelinePreset into a ready-to-run WorkoutModel — fresh step ids
 *  throughout (see _freshStepClone()), so starting the same preset twice,
 *  or opening it in the advanced builder while a session built from it is
 *  already running, never shares step identity with another instance.
 *
 * @param {Object}  preset
 * @param {Object}  [opts]
 * @param {string}  [opts.name]  Overrides preset.label as the workout name.
 * @returns {WorkoutModel}
 */
export function buildTimelineWorkout(preset, { name } = {}) {
  const steps = (preset?.steps ?? []).map(_freshStepClone);
  return createWorkout({
    name: (name ?? preset?.label ?? 'Mapped Workout'),
    sourceFormat: 'manual',
    steps,
  });
}

export default {
  TARGET_STYLES, TIMELINE_GROUPS, TIMELINE_GROUP_ORDER, BUILTIN_TIMELINE_PRESETS,
  createCustomTimelinePreset, loadCustomTimelinePresets, getCustomTimelinePresets,
  addCustomTimelinePreset, removeCustomTimelinePreset,
  allTimelinePresets, timelinePresetById, buildTimelineWorkout,
};

// Re-exported purely so the smoketest can verify BUILTIN_TIMELINE_PRESETS'
// declared durationMin against the real totalDuration() math without
// duplicating the import — not meant for other callers (they should use
// buildTimelineWorkout() + core/cardio-model.js's totalDuration() on the
// result, same as anywhere else a WorkoutModel's length matters).
export { totalDuration as _totalDurationForTest };
