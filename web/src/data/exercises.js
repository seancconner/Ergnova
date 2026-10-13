// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * data/exercises.js
 *
 * Catalog of strength & calisthenics exercises — backs the exercise picker
 * in views/strength-session.js (search/browse instead of typing a free-text
 * name from scratch) and feeds ui/muscle-diagram.js (each exercise's
 * primaryMuscles map straight onto that diagram's region ids).
 *
 * This is a reference catalog, not the record of what anyone actually did —
 * a logged CreateStrengthSet (core/strength-model.js) only ever stores the
 * plain `exercise` name string, same as before this file existed. Picking a
 * catalog entry just fills that field (see _pickExercise() in
 * views/strength-session.js) — nothing here is persisted per-set, so a
 * custom/unlisted exercise typed by hand still works exactly as it always
 * has, just without a muscle diagram to show alongside it.
 *
 * Muscle ids referenced by `primaryMuscles` below must match the region ids
 * ui/muscle-diagram.js knows how to highlight — see that file's own
 * FRONT_MUSCLES/BACK_MUSCLES lists. A muscle appearing in neither is simply
 * never highlighted, not an error.
 *
 * ── Two catalogs merged into one list ───────────────────────────────────
 * EXERCISES below is the bundled/preset catalog, static for the life of the
 * page — same "seed" role data/nutrition/ingredients.json plays for
 * nutrition (see nutrition/ingredient-repository.js). Alongside it, a rider
 * can author their own entries through ui/exercise-editor.js
 * (createCustomExercise() below, id prefixed `custom:`, persisted via
 * storage/db.js's getCustomExercises()/saveCustomExercise()/
 * deleteCustomExercise()). Unlike the ingredient repository's async
 * get()/search() (fine there — the diary quick-add awaits a handful of
 * calls), the exercise picker re-renders on every keystroke and needs a
 * synchronous list to filter, so the custom set is loaded **once** into an
 * in-memory cache via loadCustomExercises() (call during app init, same
 * timing as ui/ingredient-editor.js's singleton setup in app.js) and kept
 * in sync from there by addCustomExercise()/updateCustomExercise()/
 * removeCustomExercise() — no caller of searchExercises()/
 * exercisesForFocus()/exercisesByCategory()/exerciseById()/exerciseByName()
 * below needs to know or care that two sources feed them; see allExercises().
 *
 * ── Calisthenics load estimation ────────────────────────────────────────
 * Every bodyweight-equipment entry whose `mode` is 'reps' also carries a
 * `bodyweightLoadPct` (0–1) — the estimated fraction of the rider's total
 * body weight actually being moved on a rep, used by
 * views/strength-session.js to auto-fill the Weight field for a
 * calisthenics move (see that file's _applyBodyweightLoad()) instead of
 * asking the rider to weigh something there's usually no scale for.
 * estimateBodyweightLoadKg() below turns a rider's weight into that
 * estimate; once logged as a set's `weight` it flows into
 * core/strength-model.js's totalVolume() and metrics/one-rep-max.js
 * exactly like a barbell/dumbbell lift's weight would.
 *
 * These are estimates, not lab measurements, assigned by movement
 * pattern rather than looked up per exercise from a force plate:
 *   - Full hang or full support (pull-up/chin-up/muscle-up family,
 *     freestanding handstand push-up, unassisted single-leg squat/dip
 *     variants): ~100% — the rider's entire mass is suspended from or
 *     balanced on the working limb(s) regardless of grip/leverage, same
 *     convention strength training already uses for "bodyweight" squats
 *     and dips as a loaded lift.
 *   - Partial-support pushing/pressing moves (push-up family, dips with
 *     feet still grounded, pike/wall-assisted handstand work): graded by
 *     body angle, following the published EMG/force-plate range for
 *     hand-elevated and incline push-ups (e.g. Ebben et al. 2011) — more
 *     horizontal (feet grounded, hands doing more of the work) is a
 *     higher fraction than a near-vertical wall push-up.
 *   - Single-limb or partial-body-segment moves with no direct study
 *     (core work, glute bridges, crawling/carry-style full-body moves):
 *     approximated from anthropometric segment-mass tables (e.g. de Leva
 *     1996) for the body segment actually being lifted.
 * Good enough to trend relative progression over time (heavier estimate
 * = more reps needed for the same volume); not a substitute for an
 * actual load cell. The number itself isn't hand-editable in the UI — a
 * rider who adds a weighted vest/belt logs that separately, in the
 * Added-weight field next to it, which is scaled by this same
 * bodyweightLoadPct together with the rider's own bodyweight, not added
 * on top 1:1, since a vest only rides along at the same fraction the
 * rider's mass does on a partial-support move — see
 * _applyBodyweightLoad()'s own doc comment in views/strength-session.js.
 *
 * ── Calisthenics skill progressions ─────────────────────────────────────
 * Bodyweight entries that belong to a named skill line (push-up, pull-up,
 * squat/pistol, dip, handstand push-up, front lever, back lever, L-sit,
 * planche, muscle-up, human flag) carry two extra fields on top of the
 * base shape: `level` (one of LEVELS, novice→master) and `progressionGroup`
 * (a PROGRESSION_GROUPS id) plus `progressionOf` (the prior exercise's id
 * in that chain, or null for the first rung). Nothing downstream requires
 * these — an exercise missing them (every weighted-equipment entry, plus a
 * handful of standalone bodyweight moves that aren't part of a named skill
 * line) just doesn't participate in progressionChain() below, same
 * "extra/unknown fields are simply never matched, not an error" convention
 * primaryMuscles already follows for muscle-diagram.js.
 *
 * Usage:
 *   import { EXERCISES, FOCUS_GROUPS, CATEGORIES, EQUIPMENT, LEVELS,
 *            PROGRESSION_GROUPS, exercisesForFocus, searchExercises,
 *            exercisesByCategory, progressionChain, allExercises,
 *            createCustomExercise, loadCustomExercises, addCustomExercise,
 *            updateCustomExercise, removeCustomExercise, isCustomExercise,
 *            estimateBodyweightLoadKg,
 *   } from '../data/exercises.js';
 */

import { db } from '../storage/db.js';

// ─── Categories ─────────────────────────────────────────────────────────────
// One primary category per exercise — the grouping used when browsing the
// full catalog (see exercisesByCategory()). Separate from `primaryMuscles`,
// which can span more than one region (e.g. a bench press is category
// 'chest' but lights up shoulders + triceps too as secondary movers).
export const CATEGORIES = [
  { value: 'chest',     label: 'Chest' },
  { value: 'back',      label: 'Back' },
  { value: 'shoulders', label: 'Shoulders' },
  { value: 'arms',      label: 'Arms' },
  { value: 'legs',      label: 'Legs' },
  { value: 'glutes',    label: 'Glutes' },
  { value: 'core',      label: 'Core' },
  { value: 'fullBody',  label: 'Full Body' },
];

// ─── Equipment ──────────────────────────────────────────────────────────────
// Every value any catalog entry's `equipment` field uses below — exposed as
// a labeled list (rather than callers hand-rolling their own) for
// ui/exercise-editor.js's Equipment dropdown and views/strength-session.js's
// picker equipment filter. 'bodyweight' deliberately covers "needs a
// pull-up bar/rings/wall" too, same loose convention the existing catalog
// already used for pull-up/dip/handstand entries — there's no separate
// "bar" or "rings" tier.
export const EQUIPMENT = [
  { value: 'bodyweight', label: 'Bodyweight' },
  { value: 'barbell',    label: 'Barbell' },
  { value: 'dumbbell',   label: 'Dumbbell' },
  { value: 'kettlebell', label: 'Kettlebell' },
  { value: 'cable',      label: 'Cable' },
  { value: 'machine',    label: 'Machine' },
  { value: 'band',       label: 'Band' },
  { value: 'other',      label: 'Other' },
];

// ─── Skill levels ───────────────────────────────────────────────────────────
// Ordered novice→master — see this file's own doc comment on calisthenics
// skill progressions. LEVEL_ORDER is the same list reduced to a
// {value: index} lookup so progressionChain() below can sort a group's
// entries without re-scanning LEVELS on every comparison.
export const LEVELS = [
  { value: 'novice',       label: 'Novice' },
  { value: 'beginner',     label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced',     label: 'Advanced' },
  { value: 'master',       label: 'Master' },
];
export const LEVEL_ORDER = Object.fromEntries(LEVELS.map((l, i) => [l.value, i]));

// ─── Progression groups ─────────────────────────────────────────────────────
// The named calisthenics skill lines a bodyweight exercise's
// `progressionGroup` can point at — metadata only (id + label + the muscle
// category its rungs live under), used by progressionChain() below and by
// views/strength-session.js to label a chip with the skill it belongs to.
export const PROGRESSION_GROUPS = [
  { value: 'push-up',    label: 'Push-Up',           category: 'chest' },
  { value: 'pull-up',    label: 'Pull-Up',           category: 'back' },
  { value: 'pistol-squat', label: 'Pistol Squat',    category: 'legs' },
  { value: 'dip',        label: 'Dip',                category: 'chest' },
  { value: 'handstand',  label: 'Handstand Push-Up',  category: 'shoulders' },
  { value: 'front-lever', label: 'Front Lever',       category: 'back' },
  { value: 'back-lever', label: 'Back Lever',         category: 'back' },
  { value: 'l-sit',      label: 'L-Sit',               category: 'core' },
  { value: 'planche',    label: 'Planche',            category: 'chest' },
  { value: 'muscle-up',  label: 'Muscle-Up',          category: 'back' },
  { value: 'human-flag', label: 'Human Flag',         category: 'core' },
];

// ─── Focus groups ───────────────────────────────────────────────────────────
// Broader "what kind of session is this" tags — what ui/strength-session-flow.js
// shows as the organized workout-type picker. Each maps to a filter run
// against the catalog below (`match`), not a fixed list, so a new exercise
// added to the right category/equipment automatically shows up under the
// right focus too. 'all' is the no-filter fallback ("Custom" in the UI).
export const FOCUS_GROUPS = [
  { value: 'fullBody',     label: 'Full Body',    match: () => true },
  { value: 'upper',        label: 'Upper Body',   match: ex => ['chest', 'back', 'shoulders', 'arms'].includes(ex.category) },
  { value: 'lower',        label: 'Lower Body',   match: ex => ['legs', 'glutes'].includes(ex.category) },
  { value: 'push',         label: 'Push',         match: ex => ex.category === 'chest' || ex.category === 'shoulders' || (ex.category === 'arms' && ex.primaryMuscles.includes('triceps')) },
  { value: 'pull',         label: 'Pull',         match: ex => ex.category === 'back' || (ex.category === 'arms' && ex.primaryMuscles.includes('biceps')) },
  { value: 'legs',         label: 'Legs',         match: ex => ['legs', 'glutes'].includes(ex.category) },
  { value: 'core',         label: 'Core',         match: ex => ex.category === 'core' },
  // Individual muscle-focused workout types — previously only reachable
  // bundled inside Upper Body/Push/Pull; useful on their own for a rider
  // running a body-part split (e.g. "Chest Day").
  { value: 'chest',        label: 'Chest',        match: ex => ex.category === 'chest' },
  { value: 'back',         label: 'Back',         match: ex => ex.category === 'back' },
  { value: 'shoulders',    label: 'Shoulders',    match: ex => ex.category === 'shoulders' },
  { value: 'arms',         label: 'Arms',         match: ex => ex.category === 'arms' },
  { value: 'glutes',       label: 'Glutes',       match: ex => ex.category === 'glutes' },
  { value: 'calisthenics', label: 'Calisthenics', match: ex => ex.equipment === 'bodyweight' },
  // Narrower than 'calisthenics' above (which is every bodyweight move,
  // including plain push-ups/squats) — just the named skill lines, for a
  // rider who specifically wants to work toward a lever/planche/muscle-up/
  // handstand push-up/human flag rather than a general bodyweight session.
  { value: 'skills',       label: 'Skill Progressions', match: ex => ex.progressionGroup != null },
  { value: 'all',          label: 'Custom',       match: () => true },
];

// ─── Catalog ─────────────────────────────────────────────────────────────────
//
// mode mirrors core/strength-model.js's SET_MODES — 'reps' for a standard
// weighted/bodyweight set, 'hold' for an isometric (plank, dead hang, wall
// sit...). This is the authoritative source for a catalog exercise's mode —
// views/strength-session.js reads it straight off the matched entry
// (exerciseByName()) to switch the Log a Set fields between Reps and Hold,
// no manual Reps/Hold toggle involved. A custom/unlisted name (no catalog
// match) has no `mode` to read and logs as SET_MODES.REPS, same default
// core/strength-model.js's createStrengthSet() already used.
export const EXERCISES = [
  // ── Chest ──────────────────────────────────────────────────────────────
  { id: 'barbell-bench-press',   name: 'Barbell Bench Press',     category: 'chest',     equipment: 'barbell',    mode: 'reps', primaryMuscles: ['chest', 'triceps', 'shoulders'] },
  { id: 'incline-bench-press',   name: 'Incline Bench Press',     category: 'chest',     equipment: 'barbell',    mode: 'reps', primaryMuscles: ['chest', 'shoulders', 'triceps'] },
  { id: 'dumbbell-bench-press',  name: 'DB Bench Press',          category: 'chest',     equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['chest', 'triceps', 'shoulders'] },
  { id: 'dumbbell-fly',          name: 'Dumbbell Fly',            category: 'chest',     equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['chest'] },
  { id: 'cable-crossover',       name: 'Cable Crossover',         category: 'chest',     equipment: 'cable',      mode: 'reps', primaryMuscles: ['chest'] },
  { id: 'chest-dip',             name: 'Chest Dip',               category: 'chest',     equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.95, primaryMuscles: ['chest', 'triceps', 'shoulders'],
    level: 'intermediate', progressionGroup: 'dip', progressionOf: 'dip-support-hold' },
  // ── Push-Up progression (novice → master) ──────────────────────────────
  { id: 'wall-push-up',          name: 'Wall Push-Up',            category: 'chest',     equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.2, primaryMuscles: ['chest', 'triceps', 'shoulders'],
    level: 'novice', progressionGroup: 'push-up', progressionOf: null },
  { id: 'incline-push-up',       name: 'Incline Push-Up',         category: 'chest',     equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.45, primaryMuscles: ['chest', 'shoulders', 'triceps'],
    level: 'beginner', progressionGroup: 'push-up', progressionOf: 'wall-push-up' },
  { id: 'push-up',               name: 'Push-Up',                 category: 'chest',     equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.64, primaryMuscles: ['chest', 'triceps', 'shoulders', 'abs'],
    level: 'intermediate', progressionGroup: 'push-up', progressionOf: 'incline-push-up' },
  { id: 'archer-push-up',        name: 'Archer Push-Up',          category: 'chest',     equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.75, primaryMuscles: ['chest', 'triceps', 'shoulders'],
    level: 'advanced', progressionGroup: 'push-up', progressionOf: 'push-up' },
  { id: 'one-arm-push-up',       name: 'One-Arm Push-Up',         category: 'chest',     equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.9, primaryMuscles: ['chest', 'triceps', 'shoulders', 'abs'],
    level: 'master', progressionGroup: 'push-up', progressionOf: 'archer-push-up' },
  { id: 'pseudo-planche-push-up', name: 'Pseudo Planche Push-Up', category: 'chest',     equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.75, primaryMuscles: ['chest', 'shoulders', 'triceps', 'abs'] },
  // ── Planche progression (novice → master) ───────────────────────────────
  { id: 'planche-lean',          name: 'Planche Lean',            category: 'chest',     equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['chest', 'shoulders', 'abs'],
    level: 'novice', progressionGroup: 'planche', progressionOf: null },
  { id: 'tuck-planche',          name: 'Tuck Planche',            category: 'chest',     equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['chest', 'shoulders', 'abs', 'triceps'],
    level: 'beginner', progressionGroup: 'planche', progressionOf: 'planche-lean' },
  { id: 'advanced-tuck-planche', name: 'Adv Tuck Planche',        category: 'chest',     equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['chest', 'shoulders', 'abs', 'triceps'],
    level: 'intermediate', progressionGroup: 'planche', progressionOf: 'tuck-planche' },
  { id: 'straddle-planche',      name: 'Straddle Planche',        category: 'chest',     equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['chest', 'shoulders', 'abs', 'triceps'],
    level: 'advanced', progressionGroup: 'planche', progressionOf: 'advanced-tuck-planche' },
  { id: 'planche',               name: 'Full Planche',            category: 'chest',     equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['chest', 'shoulders', 'abs', 'triceps'],
    level: 'master', progressionGroup: 'planche', progressionOf: 'straddle-planche' },

  // ── Back ───────────────────────────────────────────────────────────────
  { id: 'deadlift',              name: 'Deadlift',                category: 'back',      equipment: 'barbell',    mode: 'reps', primaryMuscles: ['lowerBack', 'glutes', 'hamstrings', 'traps'] },
  { id: 'barbell-row',           name: 'Barbell Row',             category: 'back',      equipment: 'barbell',    mode: 'reps', primaryMuscles: ['lats', 'upperBack', 'biceps'] },
  { id: 'dumbbell-row',          name: 'Single-Arm DB Row',       category: 'back',      equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['lats', 'upperBack', 'biceps'] },
  { id: 'lat-pulldown',          name: 'Lat Pulldown',            category: 'back',      equipment: 'cable',      mode: 'reps', primaryMuscles: ['lats', 'biceps'] },
  { id: 'seated-cable-row',      name: 'Seated Cable Row',        category: 'back',      equipment: 'cable',      mode: 'reps', primaryMuscles: ['upperBack', 'lats', 'biceps'] },
  { id: 'chin-up',               name: 'Chin-Up',                 category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps'] },
  { id: 'inverted-row',          name: 'Inverted Row',            category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.55, primaryMuscles: ['upperBack', 'lats', 'biceps'] },
  { id: 'superman',              name: 'Superman Hold',           category: 'back',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lowerBack', 'glutes'] },
  { id: 'dead-hang',             name: 'Dead Hang',               category: 'back',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'forearms'] },
  { id: 'typewriter-pull-up',    name: 'Typewriter Pull-Up',      category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps', 'upperBack'] },
  // ── Pull-Up progression (novice → master) ───────────────────────────────
  { id: 'scapular-pull-up',      name: 'Scapular Pull-Up',        category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'upperBack', 'traps'],
    level: 'novice', progressionGroup: 'pull-up', progressionOf: null },
  { id: 'negative-pull-up',      name: 'Negative Pull-Up',        category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps', 'upperBack'],
    level: 'beginner', progressionGroup: 'pull-up', progressionOf: 'scapular-pull-up' },
  { id: 'pull-up',               name: 'Pull-Up',                 category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps', 'upperBack'],
    level: 'intermediate', progressionGroup: 'pull-up', progressionOf: 'negative-pull-up' },
  { id: 'archer-pull-up',        name: 'Archer Pull-Up',          category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps', 'upperBack'],
    level: 'advanced', progressionGroup: 'pull-up', progressionOf: 'pull-up' },
  { id: 'one-arm-pull-up',       name: 'One-Arm Pull-Up',         category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps', 'upperBack', 'forearms'],
    level: 'master', progressionGroup: 'pull-up', progressionOf: 'archer-pull-up' },
  // ── Muscle-Up progression (novice → master) ─────────────────────────────
  { id: 'high-pull-up',          name: 'High Pull-Up',            category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps', 'upperBack'],
    level: 'novice', progressionGroup: 'muscle-up', progressionOf: null },
  { id: 'chest-to-bar-pull-up',  name: 'C2B Pull-Up',             category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps', 'upperBack'],
    level: 'beginner', progressionGroup: 'muscle-up', progressionOf: 'high-pull-up' },
  { id: 'kipping-muscle-up',     name: 'Kipping Muscle-Up',       category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps', 'triceps', 'chest', 'upperBack'],
    level: 'intermediate', progressionGroup: 'muscle-up', progressionOf: 'chest-to-bar-pull-up' },
  { id: 'strict-muscle-up',      name: 'Strict Muscle-Up',        category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps', 'triceps', 'chest', 'upperBack'],
    level: 'advanced', progressionGroup: 'muscle-up', progressionOf: 'kipping-muscle-up' },
  { id: 'ring-muscle-up',        name: 'Ring Muscle-Up',          category: 'back',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['lats', 'biceps', 'triceps', 'chest', 'upperBack'],
    level: 'master', progressionGroup: 'muscle-up', progressionOf: 'strict-muscle-up' },
  // ── Front Lever progression (novice → master) ───────────────────────────
  { id: 'tuck-front-lever',      name: 'Tuck Front Lever',        category: 'back',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'abs', 'upperBack', 'forearms'],
    level: 'novice', progressionGroup: 'front-lever', progressionOf: null },
  { id: 'advanced-tuck-front-lever', name: 'Adv Tuck Front Lever', category: 'back', equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'abs', 'upperBack', 'forearms'],
    level: 'beginner', progressionGroup: 'front-lever', progressionOf: 'tuck-front-lever' },
  { id: 'single-leg-front-lever', name: '1-Leg Front Lever',      category: 'back',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'abs', 'upperBack', 'forearms'],
    level: 'intermediate', progressionGroup: 'front-lever', progressionOf: 'advanced-tuck-front-lever' },
  { id: 'straddle-front-lever',  name: 'Straddle Front Lever',    category: 'back',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'abs', 'upperBack', 'forearms'],
    level: 'advanced', progressionGroup: 'front-lever', progressionOf: 'single-leg-front-lever' },
  { id: 'front-lever',           name: 'Full Front Lever',        category: 'back',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'abs', 'upperBack', 'forearms'],
    level: 'master', progressionGroup: 'front-lever', progressionOf: 'straddle-front-lever' },
  // ── Back Lever progression (novice → master) ────────────────────────────
  { id: 'tuck-back-lever',       name: 'Tuck Back Lever',         category: 'back',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'shoulders', 'abs', 'forearms'],
    level: 'novice', progressionGroup: 'back-lever', progressionOf: null },
  { id: 'advanced-tuck-back-lever', name: 'Adv Tuck Back Lever', category: 'back',  equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'shoulders', 'abs', 'forearms'],
    level: 'beginner', progressionGroup: 'back-lever', progressionOf: 'tuck-back-lever' },
  { id: 'single-leg-back-lever', name: '1-Leg Back Lever',        category: 'back',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'shoulders', 'abs', 'forearms'],
    level: 'intermediate', progressionGroup: 'back-lever', progressionOf: 'advanced-tuck-back-lever' },
  { id: 'straddle-back-lever',   name: 'Straddle Back Lever',     category: 'back',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'shoulders', 'abs', 'forearms'],
    level: 'advanced', progressionGroup: 'back-lever', progressionOf: 'single-leg-back-lever' },
  { id: 'back-lever',            name: 'Full Back Lever',         category: 'back',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['lats', 'shoulders', 'abs', 'forearms'],
    level: 'master', progressionGroup: 'back-lever', progressionOf: 'straddle-back-lever' },

  // ── Shoulders ──────────────────────────────────────────────────────────
  { id: 'overhead-press',        name: 'Overhead Press',          category: 'shoulders', equipment: 'barbell',    mode: 'reps', primaryMuscles: ['shoulders', 'triceps'] },
  { id: 'dumbbell-shoulder-press', name: 'DB Shoulder Press',     category: 'shoulders', equipment: 'dumbbell', mode: 'reps', primaryMuscles: ['shoulders', 'triceps'] },
  { id: 'lateral-raise',         name: 'Lateral Raise',           category: 'shoulders', equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['shoulders'] },
  { id: 'front-raise',           name: 'Front Raise',             category: 'shoulders', equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['shoulders'] },
  { id: 'rear-delt-fly',         name: 'Rear Delt Fly',           category: 'shoulders', equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['shoulders', 'upperBack'] },
  { id: 'face-pull',             name: 'Face Pull',               category: 'shoulders', equipment: 'cable',      mode: 'reps', primaryMuscles: ['shoulders', 'upperBack', 'traps'] },
  // ── Handstand Push-Up progression (novice → master) ─────────────────────
  { id: 'pike-push-up',          name: 'Pike Push-Up',            category: 'shoulders', equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.7, primaryMuscles: ['shoulders', 'triceps'],
    level: 'novice', progressionGroup: 'handstand', progressionOf: null },
  { id: 'wall-walk',             name: 'Wall Walk',               category: 'shoulders', equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.8, primaryMuscles: ['shoulders', 'triceps', 'abs'],
    level: 'beginner', progressionGroup: 'handstand', progressionOf: 'pike-push-up' },
  { id: 'handstand-hold',        name: 'Handstand Hold',          category: 'shoulders', equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['shoulders', 'abs', 'triceps'],
    level: 'intermediate', progressionGroup: 'handstand', progressionOf: 'wall-walk' },
  { id: 'handstand-push-up',     name: 'Handstand Push-Up',       category: 'shoulders', equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.9, primaryMuscles: ['shoulders', 'triceps', 'abs'],
    level: 'advanced', progressionGroup: 'handstand', progressionOf: 'handstand-hold' },
  { id: 'freestanding-hspu',     name: 'Freestanding HSPU',       category: 'shoulders', equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['shoulders', 'triceps', 'abs'],
    level: 'master', progressionGroup: 'handstand', progressionOf: 'handstand-push-up' },

  // ── Arms ───────────────────────────────────────────────────────────────
  { id: 'barbell-curl',          name: 'Barbell Curl',            category: 'arms',      equipment: 'barbell',    mode: 'reps', primaryMuscles: ['biceps'] },
  { id: 'dumbbell-curl',         name: 'Dumbbell Curl',           category: 'arms',      equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['biceps'] },
  { id: 'hammer-curl',           name: 'Hammer Curl',             category: 'arms',      equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['biceps', 'forearms'] },
  { id: 'concentration-curl',    name: 'Concentration Curl',      category: 'arms',      equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['biceps'] },
  { id: 'tricep-pushdown',       name: 'Tricep Pushdown',         category: 'arms',      equipment: 'cable',      mode: 'reps', primaryMuscles: ['triceps'] },
  { id: 'skull-crusher',         name: 'Skull Crusher',           category: 'arms',      equipment: 'barbell',    mode: 'reps', primaryMuscles: ['triceps'] },
  { id: 'overhead-tricep-ext',   name: 'Tricep Extension',        category: 'arms',    equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['triceps'] },
  { id: 'diamond-push-up',       name: 'Diamond Push-Up',         category: 'arms',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.66, primaryMuscles: ['triceps', 'chest'] },
  // ── Dip progression (novice → master) ───────────────────────────────────
  { id: 'tricep-dip',            name: 'Tricep Dip (Bench)',      category: 'arms',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.65, primaryMuscles: ['triceps', 'chest'],
    level: 'novice', progressionGroup: 'dip', progressionOf: null },
  { id: 'dip-support-hold',      name: 'Bar Support Hold',        category: 'arms',    equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['triceps', 'chest', 'shoulders'],
    level: 'beginner', progressionGroup: 'dip', progressionOf: 'tricep-dip' },
  { id: 'ring-dip',              name: 'Ring Dip',                category: 'arms',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.95, primaryMuscles: ['triceps', 'chest', 'shoulders'],
    level: 'advanced', progressionGroup: 'dip', progressionOf: 'chest-dip' },
  { id: 'one-arm-dip',           name: 'One-Arm Dip',             category: 'arms',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.95, primaryMuscles: ['triceps', 'chest', 'shoulders'],
    level: 'master', progressionGroup: 'dip', progressionOf: 'ring-dip' },

  // ── Legs ───────────────────────────────────────────────────────────────
  { id: 'back-squat',            name: 'Back Squat',              category: 'legs',      equipment: 'barbell',    mode: 'reps', primaryMuscles: ['quads', 'glutes', 'hamstrings'] },
  { id: 'front-squat',           name: 'Front Squat',             category: 'legs',      equipment: 'barbell',    mode: 'reps', primaryMuscles: ['quads', 'glutes', 'abs'] },
  { id: 'goblet-squat',          name: 'Goblet Squat',            category: 'legs',      equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['quads', 'glutes'] },
  { id: 'leg-press',             name: 'Leg Press',               category: 'legs',      equipment: 'machine',    mode: 'reps', primaryMuscles: ['quads', 'glutes', 'hamstrings'] },
  { id: 'romanian-deadlift',     name: 'Romanian Deadlift',       category: 'legs',      equipment: 'barbell',    mode: 'reps', primaryMuscles: ['hamstrings', 'glutes', 'lowerBack'] },
  { id: 'leg-curl',              name: 'Leg Curl',                category: 'legs',      equipment: 'machine',    mode: 'reps', primaryMuscles: ['hamstrings'] },
  { id: 'leg-extension',         name: 'Leg Extension',           category: 'legs',      equipment: 'machine',    mode: 'reps', primaryMuscles: ['quads'] },
  { id: 'walking-lunge',         name: 'Walking Lunge',           category: 'legs',      equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['quads', 'glutes', 'hamstrings'] },
  { id: 'bulgarian-split-squat', name: 'Bulgarian Split Squat',   category: 'legs',      equipment: 'dumbbell',   mode: 'reps', primaryMuscles: ['quads', 'glutes'] },
  { id: 'calf-raise',            name: 'Standing Calf Raise',     category: 'legs',      equipment: 'machine',    mode: 'reps', primaryMuscles: ['calves'] },
  { id: 'jump-squat',            name: 'Jump Squat',              category: 'legs',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['quads', 'glutes', 'calves'] },
  { id: 'wall-sit',              name: 'Wall Sit',                category: 'legs',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['quads'] },
  { id: 'nordic-curl',           name: 'Nordic Curl',             category: 'legs',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.65, primaryMuscles: ['hamstrings'] },
  // ── Pistol Squat progression (novice → master) ──────────────────────────
  { id: 'bodyweight-squat',      name: 'Bodyweight Squat',        category: 'legs',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['quads', 'glutes'],
    level: 'novice', progressionGroup: 'pistol-squat', progressionOf: null },
  { id: 'bodyweight-split-squat', name: 'Split Squat',            category: 'legs',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.85, primaryMuscles: ['quads', 'glutes', 'hamstrings'],
    level: 'beginner', progressionGroup: 'pistol-squat', progressionOf: 'bodyweight-squat' },
  { id: 'shrimp-squat',          name: 'Shrimp Squat',            category: 'legs',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.95, primaryMuscles: ['quads', 'glutes', 'hamstrings'],
    level: 'intermediate', progressionGroup: 'pistol-squat', progressionOf: 'bodyweight-split-squat' },
  { id: 'assisted-pistol-squat', name: 'Asst Pistol Squat',       category: 'legs',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.85, primaryMuscles: ['quads', 'glutes'],
    level: 'advanced', progressionGroup: 'pistol-squat', progressionOf: 'shrimp-squat' },
  { id: 'pistol-squat',          name: 'Pistol Squat',            category: 'legs',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 1, primaryMuscles: ['quads', 'glutes'],
    level: 'master', progressionGroup: 'pistol-squat', progressionOf: 'assisted-pistol-squat' },

  // ── Glutes ─────────────────────────────────────────────────────────────
  { id: 'hip-thrust',            name: 'Barbell Hip Thrust',      category: 'glutes',    equipment: 'barbell',    mode: 'reps', primaryMuscles: ['glutes', 'hamstrings'] },
  { id: 'glute-bridge',          name: 'Glute Bridge',            category: 'glutes',    equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.4, primaryMuscles: ['glutes', 'hamstrings'] },
  { id: 'cable-kickback',        name: 'Cable Kickback',          category: 'glutes',    equipment: 'cable',      mode: 'reps', primaryMuscles: ['glutes'] },
  { id: 'clamshell',             name: 'Clamshell',               category: 'glutes',    equipment: 'band',       mode: 'reps', primaryMuscles: ['glutes'] },
  { id: 'single-leg-glute-bridge', name: '1-Leg Glute Bridge',    category: 'glutes',  equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.5, primaryMuscles: ['glutes', 'hamstrings'] },

  // ── Core ───────────────────────────────────────────────────────────────
  { id: 'plank',                 name: 'Plank',                   category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['abs', 'obliques', 'lowerBack'] },
  { id: 'side-plank',            name: 'Side Plank',              category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['obliques', 'abs'] },
  { id: 'hollow-body-hold',      name: 'Hollow Body Hold',        category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['abs'] },
  { id: 'crunch',                name: 'Crunch',                  category: 'core',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.3, primaryMuscles: ['abs'] },
  { id: 'bicycle-crunch',        name: 'Bicycle Crunch',          category: 'core',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.3, primaryMuscles: ['abs', 'obliques'] },
  { id: 'sit-up',                name: 'Sit-Up',                  category: 'core',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.5, primaryMuscles: ['abs'] },
  { id: 'hanging-leg-raise',     name: 'Hanging Leg Raise',       category: 'core',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.35, primaryMuscles: ['abs', 'forearms'] },
  { id: 'russian-twist',         name: 'Russian Twist',           category: 'core',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.3, primaryMuscles: ['obliques', 'abs'] },
  { id: 'mountain-climber',      name: 'Mountain Climber',        category: 'core',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.2, primaryMuscles: ['abs', 'shoulders'] },
  { id: 'ab-wheel-rollout',      name: 'Ab Wheel Rollout',        category: 'core',      equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.5, primaryMuscles: ['abs', 'lowerBack'] },
  { id: 'cable-woodchopper',     name: 'Cable Woodchopper',       category: 'core',      equipment: 'cable',      mode: 'reps', primaryMuscles: ['obliques', 'abs'] },
  // ── L-Sit progression (novice → master) ─────────────────────────────────
  { id: 'foot-supported-l-sit',  name: 'Supported L-Sit',         category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['abs', 'quads'],
    level: 'novice', progressionGroup: 'l-sit', progressionOf: null },
  { id: 'tuck-l-sit',            name: 'Tuck L-Sit',              category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['abs', 'forearms', 'triceps'],
    level: 'beginner', progressionGroup: 'l-sit', progressionOf: 'foot-supported-l-sit' },
  { id: 'l-sit',                 name: 'L-Sit',                   category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['abs', 'quads', 'forearms', 'triceps'],
    level: 'intermediate', progressionGroup: 'l-sit', progressionOf: 'tuck-l-sit' },
  { id: 'v-sit',                 name: 'V-Sit',                   category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['abs', 'quads', 'forearms', 'triceps'],
    level: 'advanced', progressionGroup: 'l-sit', progressionOf: 'l-sit' },
  { id: 'manna',                 name: 'Manna',                   category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['abs', 'quads', 'forearms', 'shoulders', 'chest'],
    level: 'master', progressionGroup: 'l-sit', progressionOf: 'v-sit' },
  // ── Human Flag progression (novice → master) ────────────────────────────
  { id: 'vertical-flag-hold',    name: 'Vertical Flag Hold',      category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['obliques', 'abs', 'shoulders', 'lats'],
    level: 'novice', progressionGroup: 'human-flag', progressionOf: null },
  { id: 'tuck-human-flag',       name: 'Tuck Human Flag',         category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['obliques', 'abs', 'shoulders', 'lats'],
    level: 'beginner', progressionGroup: 'human-flag', progressionOf: 'vertical-flag-hold' },
  { id: 'straddle-human-flag',   name: 'Straddle Human Flag',     category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['obliques', 'abs', 'shoulders', 'lats'],
    level: 'intermediate', progressionGroup: 'human-flag', progressionOf: 'tuck-human-flag' },
  { id: 'single-leg-human-flag', name: '1-Leg Human Flag',        category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['obliques', 'abs', 'shoulders', 'lats'],
    level: 'advanced', progressionGroup: 'human-flag', progressionOf: 'straddle-human-flag' },
  { id: 'human-flag',            name: 'Full Human Flag',         category: 'core',      equipment: 'bodyweight', mode: 'hold', primaryMuscles: ['obliques', 'abs', 'shoulders', 'lats'],
    level: 'master', progressionGroup: 'human-flag', progressionOf: 'single-leg-human-flag' },

  // ── Full Body ──────────────────────────────────────────────────────────
  { id: 'burpee',                name: 'Burpee',                  category: 'fullBody',  equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.6, primaryMuscles: ['chest', 'quads', 'abs', 'shoulders'] },
  { id: 'kettlebell-swing',      name: 'Kettlebell Swing',        category: 'fullBody',  equipment: 'kettlebell', mode: 'reps', primaryMuscles: ['glutes', 'hamstrings', 'lowerBack', 'shoulders'] },
  { id: 'clean-and-press',       name: 'Clean and Press',         category: 'fullBody',  equipment: 'barbell',    mode: 'reps', primaryMuscles: ['quads', 'glutes', 'shoulders', 'traps'] },
  { id: 'thruster',              name: 'Thruster',                category: 'fullBody',  equipment: 'barbell',    mode: 'reps', primaryMuscles: ['quads', 'glutes', 'shoulders'] },
  { id: 'turkish-get-up',        name: 'Turkish Get-Up',          category: 'fullBody',  equipment: 'kettlebell', mode: 'reps', primaryMuscles: ['shoulders', 'abs', 'glutes', 'quads'] },
  { id: 'bear-crawl',            name: 'Bear Crawl',              category: 'fullBody',  equipment: 'bodyweight', mode: 'reps', bodyweightLoadPct: 0.45, primaryMuscles: ['abs', 'shoulders', 'quads'] },
  { id: 'farmers-carry',         name: "Farmer's Carry",          category: 'fullBody',  equipment: 'dumbbell',   mode: 'hold', primaryMuscles: ['forearms', 'traps', 'abs'] },
];

// ─── Custom exercises ───────────────────────────────────────────────────────
// A rider-authored entry, same shape as a catalog entry above plus
// `custom: true` (so views/strength-session.js can badge it in the picker)
// — created through ui/exercise-editor.js, persisted via storage/db.js's
// getCustomExercises()/saveCustomExercise()/deleteCustomExercise(). See
// this file's own doc comment for why the merged list is cached
// in-memory rather than resolved async on every lookup.

let _customExercises = [];

/** Monotonic-safe id generator — same `custom:<uuid>` shape (and same
 *  crypto.randomUUID()-with-fallback approach) as core/nutrition-model.js's
 *  nextId(), for the same reason: a custom exercise's id has to stay
 *  unique for the life of the IndexedDB store, across reloads, not just
 *  within one in-memory session. */
function _nextCustomId() {
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `custom:${uuid}`;
}

/**
 * Creates a custom Exercise (id prefixed `custom:`, `custom: true`) in the
 * same shape as a bundled catalog entry — `category`/`equipment`/`mode`/
 * `primaryMuscles` are exactly the fields ui/exercise-editor.js's form
 * fills in, so a saved custom exercise slots into exercisesByCategory()'s
 * grouping, exercisesForFocus()'s focus matching, and
 * views/strength-session.js's mode-driven Reps/Hold fields and muscle
 * diagram with no special-casing anywhere downstream.
 *
 * @param {Partial<Exercise>} fields
 * @returns {Exercise}
 */
export function createCustomExercise(fields = {}) {
  return {
    id: _nextCustomId(),
    name: '',
    category: 'fullBody',
    equipment: 'bodyweight',
    mode: 'reps',
    primaryMuscles: [],
    custom: true,
    ...fields,
  };
}

/** True for any exercise (or bare id string) from the custom store, false
 *  for a bundled catalog entry — views/strength-session.js uses this to
 *  show the edit/delete affordance only where it's meaningful. */
export function isCustomExercise(exOrId) {
  const id = typeof exOrId === 'string' ? exOrId : exOrId?.id;
  return typeof id === 'string' && id.startsWith('custom:');
}

/** Populates the in-memory custom-exercise cache from storage/db.js —
 *  call once during app init (see app.js, same timing as
 *  ui/ingredient-editor.js's singleton setup) before any strength UI that
 *  reads allExercises()/searchExercises()/exercisesForFocus()/etc. is
 *  shown, so custom entries are present from the first render rather than
 *  popping in after an async gap. Safe to call again later (e.g. to
 *  recover from a failed add) — replaces the cache wholesale rather than
 *  merging into it. */
export async function loadCustomExercises() {
  _customExercises = await db.getCustomExercises();
  return _customExercises;
}

/** @returns {Exercise[]} the current in-memory custom-exercise cache —
 *  synchronous, reflects whatever loadCustomExercises() last loaded plus
 *  any add/update/remove since. */
export function getCustomExercises() {
  return _customExercises;
}

/** Saves a new custom Exercise and updates the in-memory cache so it's
 *  immediately visible to every lookup below — no reload needed.
 *  @param {Partial<Exercise>} fields
 *  @returns {Promise<Exercise>} */
export async function addCustomExercise(fields) {
  const ex = createCustomExercise(fields);
  await db.saveCustomExercise(ex);
  _customExercises = [..._customExercises, ex];
  return ex;
}

/** Overwrites an already-saved custom Exercise in place (requires
 *  `exercise.id`) — same put()-based shape as saveCustomExercise() itself.
 *  @param {Exercise} exercise
 *  @returns {Promise<Exercise>} */
export async function updateCustomExercise(exercise) {
  await db.saveCustomExercise(exercise);
  _customExercises = _customExercises.map(ex => ex.id === exercise.id ? exercise : ex);
  return exercise;
}

/** @param {string} id
 *  @returns {Promise<void>} */
export async function removeCustomExercise(id) {
  await db.deleteCustomExercise(id);
  _customExercises = _customExercises.filter(ex => ex.id !== id);
}

/** The one list every lookup below actually filters — bundled catalog
 *  first, then whatever's in the custom cache, same "custom entries
 *  supplement rather than replace the seed set" ordering
 *  nutrition/ingredient-repository.js's search() uses (there custom sorts
 *  first, since a rider's own correction should outrank a generic bundled
 *  entry; here there's no such override relationship — a custom exercise
 *  is additive, not a correction of a preset one — so bundled-first reads
 *  more naturally: presets are usually what a rider is scanning for). */
export function allExercises() {
  return [...EXERCISES, ..._customExercises];
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

/** Case-insensitive substring match against name (and category label, so
 *  typing "leg" surfaces the Legs category's exercises even if "leg" isn't
 *  in every one of their names). Empty/blank query returns the full catalog,
 *  same "nothing typed yet = show everything" convention the recipe/
 *  ingredient search boxes use. Searches across both the bundled catalog
 *  and any custom exercises (see allExercises()). */
export function searchExercises(query) {
  const q = (query ?? '').trim().toLowerCase();
  const all = allExercises();
  if (!q) return all;
  return all.filter(ex =>
    ex.name.toLowerCase().includes(q) ||
    CATEGORIES.find(c => c.value === ex.category)?.label.toLowerCase().includes(q)
  );
}

/** @returns {Object[]} catalog entries (bundled + custom) whose category or
 *  equipment matches the given focus tag's `match` predicate. `focus` not
 *  found (or 'all') returns the full merged catalog. */
export function exercisesForFocus(focus) {
  const group = FOCUS_GROUPS.find(g => g.value === focus);
  const all = allExercises();
  return group ? all.filter(group.match) : all;
}

/** Groups the full merged catalog by category, in CATEGORIES' own display
 *  order — same {category,exercises} shape convention as
 *  strength-model.js's groupByExercise(), for a template-literal render
 *  loop. Within each category, exercises sharing a `progressionGroup` sort
 *  together in novice→master order (LEVEL_ORDER) so a skill's rungs read
 *  top-to-bottom instead of scattered at their alphabetical/declared
 *  position; everything else keeps its catalog order. */
export function exercisesByCategory() {
  return CATEGORIES.map(c => ({
    category: c.value,
    label: c.label,
    exercises: allExercises().filter(ex => ex.category === c.value).sort(_progressionSort),
  })).filter(g => g.exercises.length);
}

function _progressionSort(a, b) {
  if (a.progressionGroup && b.progressionGroup) {
    if (a.progressionGroup !== b.progressionGroup) return a.progressionGroup.localeCompare(b.progressionGroup);
    return (LEVEL_ORDER[a.level] ?? 0) - (LEVEL_ORDER[b.level] ?? 0);
  }
  if (a.progressionGroup) return -1; // grouped skills float above ungrouped variety exercises
  if (b.progressionGroup) return 1;
  return 0;
}

export function exerciseById(id) {
  return allExercises().find(ex => ex.id === id) ?? null;
}

/** Best-effort match from a free-typed exercise name back to a catalog
 *  entry (exact, case-insensitive) — used so re-opening the picker for an
 *  exercise already typed in (e.g. editing weight/reps on a repeat set)
 *  still shows its muscle diagram. Returns null for anything custom/unlisted
 *  (including a custom exercise not yet saved). */
export function exerciseByName(name) {
  const n = (name ?? '').trim().toLowerCase();
  if (!n) return null;
  return allExercises().find(ex => ex.name.toLowerCase() === n) ?? null;
}

/**
 * Estimates the load (kilograms) actually being lifted on one rep of a
 * bodyweight exercise — riderWeightKg × that exercise's
 * `bodyweightLoadPct` (see this file's own doc comment on calisthenics
 * load estimation above), rounded to the nearest 0.5kg to match the
 * Weight field's own step. Returns null for anything that isn't a
 * REPS-mode entry with a `bodyweightLoadPct` (a weighted-equipment lift,
 * a HOLD-mode entry, a custom/unlisted exercise missing the field) or
 * when `riderWeightKg` isn't a usable positive number (no rider weight
 * on file yet) — either way, the caller falls back to a plain manual
 * Weight field, exactly as if this function didn't exist.
 *
 * @param {Object|null} exercise      A catalog entry (see EXERCISES above).
 * @param {number|null} riderWeightKg
 * @returns {number|null} kilograms
 */
export function estimateBodyweightLoadKg(exercise, riderWeightKg) {
  if (!exercise || exercise.mode !== 'reps' || exercise.bodyweightLoadPct == null) return null;
  if (!riderWeightKg || riderWeightKg <= 0) return null;
  return Math.round(riderWeightKg * exercise.bodyweightLoadPct * 2) / 2;
}

/** A named skill line's rungs, novice→master, for a "here's the whole
 *  ladder" view (e.g. views/strength-session.js showing what leads up to
 *  a chip the rider tapped). Only ever reads the bundled catalog — a
 *  custom exercise can carry a `progressionGroup`/`level` of its own, but
 *  invent a group id, mislabel a level, or otherwise makes no sense to
 *  splice into a curated preset chain, so custom entries are excluded here
 *  even though they otherwise participate in allExercises() normally.
 *  @param {string} groupId  A PROGRESSION_GROUPS value.
 *  @returns {Object[]} */
export function progressionChain(groupId) {
  return EXERCISES
    .filter(ex => ex.progressionGroup === groupId)
    .sort((a, b) => (LEVEL_ORDER[a.level] ?? 0) - (LEVEL_ORDER[b.level] ?? 0));
}

export default {
  CATEGORIES, FOCUS_GROUPS, EQUIPMENT, LEVELS, LEVEL_ORDER, PROGRESSION_GROUPS, EXERCISES,
  searchExercises, exercisesForFocus, exercisesByCategory, exerciseById, exerciseByName,
  progressionChain, allExercises, createCustomExercise, isCustomExercise,
  loadCustomExercises, getCustomExercises, addCustomExercise, updateCustomExercise, removeCustomExercise,
  estimateBodyweightLoadKg,
};
