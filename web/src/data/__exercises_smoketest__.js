// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// data/exercises.js smoke test. Run with:
//   node src/data/__exercises_smoketest__.js
//
// Covers the pure catalog/lookup functions and the progression-chain data
// only — same scope rule as core/__nutrition_smoketest__.js's coverage of
// nutrition-model.js: loadCustomExercises()/addCustomExercise()/
// updateCustomExercise()/removeCustomExercise() go through storage/db.js's
// IndexedDB and aren't exercised here (no indexedDB shim in plain Node).

import {
  CATEGORIES, FOCUS_GROUPS, EQUIPMENT, LEVELS, LEVEL_ORDER, PROGRESSION_GROUPS, EXERCISES,
  searchExercises, exercisesForFocus, exercisesByCategory, exerciseById, exerciseByName,
  progressionChain, allExercises, createCustomExercise, isCustomExercise,
  estimateBodyweightLoadKg,
} from './exercises.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

console.log('exercises.js — catalog shape');
{
  const ids = EXERCISES.map(e => e.id);
  check('every entry has a unique id', new Set(ids).size === ids.length);
  check('every entry\'s category is a known CATEGORIES value', EXERCISES.every(e => CATEGORIES.some(c => c.value === e.category)));
  check('every entry\'s equipment is a known EQUIPMENT value', EXERCISES.every(e => EQUIPMENT.some(eq => eq.value === e.equipment)));
  check('every entry\'s mode is reps or hold', EXERCISES.every(e => e.mode === 'reps' || e.mode === 'hold'));

  const byId = new Map(EXERCISES.map(e => [e.id, e]));
  const danglingRefs = EXERCISES.filter(e => e.progressionOf && !byId.has(e.progressionOf));
  check('every progressionOf points at a real catalog id', danglingRefs.length === 0);

  const taggedWithoutGroup = EXERCISES.filter(e => e.level && !e.progressionGroup);
  check('every entry with a level also has a progressionGroup', taggedWithoutGroup.length === 0);
}

console.log('exercises.js — progression chains (novice → master)');
{
  for (const g of PROGRESSION_GROUPS) {
    const chain = progressionChain(g.value);
    check(`${g.value}: has all ${LEVELS.length} tiers`, chain.length === LEVELS.length);
    check(`${g.value}: sorted novice → master`, chain.every((ex, i) => i === 0 || LEVEL_ORDER[chain[i - 1].level] < LEVEL_ORDER[ex.level]));
    // Each rung (after the first) should point back at the previous rung —
    // a real chain, not five same-group entries in arbitrary order.
    check(`${g.value}: each rung's progressionOf is the previous rung`, chain.every((ex, i) => i === 0 ? ex.progressionOf === null : ex.progressionOf === chain[i - 1].id));
  }
  check('progressionChain: unknown group returns empty array', progressionChain('not-a-real-group').length === 0);
}

console.log('exercises.js — lookups');
{
  check('searchExercises: blank query returns everything', searchExercises('').length === EXERCISES.length);
  check('searchExercises: matches by name substring', searchExercises('pistol').some(e => e.id === 'pistol-squat'));
  check('searchExercises: matches by category label', searchExercises('glutes').some(e => e.category === 'glutes'));

  check('exercisesForFocus: calisthenics is bodyweight-only', exercisesForFocus('calisthenics').every(e => e.equipment === 'bodyweight'));
  check('exercisesForFocus: skills is progression-tagged only', exercisesForFocus('skills').every(e => e.progressionGroup != null) && exercisesForFocus('skills').length > 0);
  check('exercisesForFocus: chest is chest-category only', exercisesForFocus('chest').every(e => e.category === 'chest'));
  check('exercisesForFocus: unknown focus falls back to everything', exercisesForFocus('not-a-real-focus').length === EXERCISES.length);

  const grouped = exercisesByCategory();
  check('exercisesByCategory: covers every non-empty category', grouped.length === CATEGORIES.filter(c => EXERCISES.some(e => e.category === c.value)).length);
  check('exercisesByCategory: total count matches catalog', grouped.reduce((n, g) => n + g.exercises.length, 0) === EXERCISES.length);

  check('exerciseById: known id resolves', exerciseById('pull-up')?.name === 'Pull-Up');
  check('exerciseById: unknown id returns null', exerciseById('not-a-real-id') === null);
  check('exerciseByName: case-insensitive exact match', exerciseByName('back squat')?.id === 'back-squat');
  check('exerciseByName: unmatched custom name returns null', exerciseByName('Not A Real Exercise') === null);
}

console.log('exercises.js — custom exercises');
{
  const custom = createCustomExercise({ name: 'Reverse Nordic', category: 'legs', equipment: 'bodyweight', mode: 'reps', primaryMuscles: ['quads'] });
  check('createCustomExercise: id is a stable custom: string', custom.id.startsWith('custom:'));
  check('createCustomExercise: two calls get different ids', createCustomExercise().id !== createCustomExercise().id);
  check('createCustomExercise: caller fields win', custom.name === 'Reverse Nordic' && custom.category === 'legs');
  check('createCustomExercise: flagged custom: true', custom.custom === true);
  check('isCustomExercise: true for a custom entry (object or bare id)', isCustomExercise(custom) === true && isCustomExercise(custom.id) === true);
  check('isCustomExercise: false for a bundled catalog entry', isCustomExercise(EXERCISES[0]) === false);

  check('allExercises: bundled catalog only before any load (no custom loaded in this script)', allExercises().length === EXERCISES.length);
}

console.log('exercises.js — bodyweight load estimation');
{
  const pullUp = exerciseById('pull-up');
  const pushUp = exerciseById('push-up');
  const backSquat = exerciseById('back-squat'); // barbell, no bodyweightLoadPct
  const plank = exerciseById('plank'); // bodyweight, but HOLD mode

  const everyBwRepsExercise = EXERCISES.filter(e => e.equipment === 'bodyweight' && e.mode === 'reps');
  check('every bodyweight/reps entry has a bodyweightLoadPct in (0, 1]',
    everyBwRepsExercise.every(e => typeof e.bodyweightLoadPct === 'number' && e.bodyweightLoadPct > 0 && e.bodyweightLoadPct <= 1));
  check('no weighted-equipment or HOLD-mode entry has a bodyweightLoadPct',
    EXERCISES.filter(e => e.equipment !== 'bodyweight' || e.mode !== 'reps').every(e => e.bodyweightLoadPct == null));

  check('pull-up at 80kg estimates 80kg (100% bodyweight)', estimateBodyweightLoadKg(pullUp, 80) === 80);
  check('push-up at 80kg estimates 64% of bodyweight, rounded to nearest 0.5kg',
    estimateBodyweightLoadKg(pushUp, 80) === Math.round(80 * 0.64 * 2) / 2);
  check('a barbell lift with no bodyweightLoadPct returns null', estimateBodyweightLoadKg(backSquat, 80) === null);
  check('a HOLD-mode bodyweight exercise returns null (no Weight field to fill)', estimateBodyweightLoadKg(plank, 80) === null);
  check('missing rider weight returns null', estimateBodyweightLoadKg(pullUp, null) === null);
  check('zero/negative rider weight returns null', estimateBodyweightLoadKg(pullUp, 0) === null && estimateBodyweightLoadKg(pullUp, -5) === null);
  check('a null exercise returns null', estimateBodyweightLoadKg(null, 80) === null);
}

console.log(failures === 0 ? '\nAll exercises.js smoke tests passed.' : `\n${failures} exercises.js smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
