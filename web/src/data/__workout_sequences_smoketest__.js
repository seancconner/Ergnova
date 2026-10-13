// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// data/workout-sequences.js smoke test. Run with:
//   node src/data/__workout_sequences_smoketest__.js

import { EXERCISES, exerciseById } from './exercises.js';
import {
  WORKOUT_STYLES, SEQUENCE_FOCUS_GROUPS, presetSequencesFor, buildCustomSequence,
} from './workout-sequences.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

console.log('workout-sequences.js — axes');
{
  check('WORKOUT_STYLES has calisthenics + weights + halfAndHalf', WORKOUT_STYLES.map(s => s.value).sort().join(',') === 'calisthenics,halfAndHalf,weights');
  check('calisthenics.match is bodyweight-only', EXERCISES.filter(WORKOUT_STYLES.find(s => s.value === 'calisthenics').match).every(e => e.equipment === 'bodyweight'));
  check('weights.match excludes bodyweight', EXERCISES.filter(WORKOUT_STYLES.find(s => s.value === 'weights').match).every(e => e.equipment !== 'bodyweight'));
  // halfAndHalf isn't a real partition alongside the two above — it's a
  // "matches everything" convenience for display-time filtering (the
  // build-your-own step's browse pool) — see WORKOUT_STYLES' own doc
  // comment on it. presetSequencesFor()'s actual pool-building for this
  // style is covered separately below.
  check('halfAndHalf.match matches every exercise', EXERCISES.every(WORKOUT_STYLES.find(s => s.value === 'halfAndHalf').match));
  check('every exercise matches exactly one of calisthenics/weights', EXERCISES.every(e => ['calisthenics', 'weights'].filter(v => WORKOUT_STYLES.find(s => s.value === v).match(e)).length === 1));

  check('SEQUENCE_FOCUS_GROUPS excludes calisthenics/skills/all', SEQUENCE_FOCUS_GROUPS.every(g => !['calisthenics', 'skills', 'all'].includes(g.value)));
  check('SEQUENCE_FOCUS_GROUPS is non-empty', SEQUENCE_FOCUS_GROUPS.length > 0);
}

console.log('workout-sequences.js — presetSequencesFor()');
{
  // Every bundled focus+style combination should produce at least one
  // sequence — a template landing on zero exercises is skipped, but the
  // catalog is meant to cover every muscle group in both styles, however
  // thinly (see this file's own doc comment on dedup for thin pools).
  let emptyCombos = 0;
  for (const g of SEQUENCE_FOCUS_GROUPS) {
    for (const s of WORKOUT_STYLES) {
      if (presetSequencesFor(g.value, s.value).length === 0) emptyCombos++;
    }
  }
  check('every bundled focus+style combination has at least one preset', emptyCombos === 0);

  const pushCalisthenics = presetSequencesFor('push', 'calisthenics');
  check('presetSequencesFor: returns at most 6 sequences', pushCalisthenics.length <= 6);
  check('presetSequencesFor: every sequence is flagged custom: false', pushCalisthenics.every(sq => sq.custom === false));
  check('presetSequencesFor: every exercise matches the requested style', pushCalisthenics.every(sq => sq.exercises.every(ex => ex.mode === 'reps' || ex.mode === 'hold')));
  check('presetSequencesFor: sequence ids are unique', new Set(pushCalisthenics.map(sq => sq.id)).size === pushCalisthenics.length);
  check('presetSequencesFor: no two sequences share an identical exercise list', new Set(pushCalisthenics.map(sq => sq.exercises.map(e => e.exerciseId).join('|'))).size === pushCalisthenics.length);
  check('presetSequencesFor: each exercise entry carries a denormalized name/mode/category', pushCalisthenics.every(sq => sq.exercises.every(e => typeof e.name === 'string' && e.name.length > 0 && e.mode && e.category)));

  const thinPool = presetSequencesFor('glutes', 'calisthenics'); // only 2 bodyweight glute entries in the bundled catalog
  check('presetSequencesFor: a thin pool still returns at least one sequence', thinPool.length >= 1);
  check('presetSequencesFor: a thin pool never exceeds its own pool size per exercise list', thinPool.every(sq => sq.exercises.length <= 2));

  check('presetSequencesFor: unknown focus falls back to the first focus group rather than throwing', presetSequencesFor('not-a-real-focus', 'weights').length > 0);
  check('presetSequencesFor: unknown style falls back to the first style rather than throwing', presetSequencesFor('legs', 'not-a-real-style').length > 0);
}

console.log('workout-sequences.js — presetSequencesFor() — halfAndHalf');
{
  // _poolForStyle() interleaves the calisthenics- and weights-filtered
  // pools for this style rather than using WORKOUT_STYLES' own
  // "matches everything" halfAndHalf.match — that's covered here, not by
  // the generic loop above (which only checks a preset came back non-empty,
  // not what's actually in it).
  const pushMixed = presetSequencesFor('push', 'halfAndHalf');
  check('halfAndHalf: returns at least one sequence for a well-stocked focus', pushMixed.length > 0);
  const foundations = pushMixed.find(sq => sq.id.endsWith(':foundations'));
  const equipTypes = new Set(foundations.exercises.map(e => exerciseById(e.exerciseId)?.equipment === 'bodyweight' ? 'bodyweight' : 'weighted'));
  check('halfAndHalf: Foundations preset actually mixes bodyweight and weighted exercises', equipTypes.has('bodyweight') && equipTypes.has('weighted'));

  // A thin pool (see the calisthenics-only thinPool check above) should
  // still produce a halfAndHalf preset rather than an empty one, as long
  // as either half of the interleave has anything at all.
  const glutesMixed = presetSequencesFor('glutes', 'halfAndHalf');
  check('halfAndHalf: a thin-pool focus still returns at least one sequence', glutesMixed.length >= 1);
}

console.log('workout-sequences.js — progression-group de-duplication (calisthenics)');
{
  // Progression-chain rungs (e.g. the push-up family's five entries) sit
  // consecutively in the bundled catalog — see data/exercises.js's own
  // doc comment on calisthenics skill progressions. A preset built from a
  // raw, un-deduped pool could easily hand a rider several rungs of the
  // exact same skill line in one sequence (four of the five push-up
  // variants back-to-back, say) instead of a balanced session — this is
  // what _dedupeByProgressionGroup() in workout-sequences.js exists to
  // prevent, for every bundled focus+style combination, not just the
  // thin/obvious cases.
  let violations = 0;
  let checkedAny = false;
  for (const g of SEQUENCE_FOCUS_GROUPS) {
    for (const s of WORKOUT_STYLES) {
      for (const sq of presetSequencesFor(g.value, s.value)) {
        const groups = sq.exercises
          .map(e => exerciseById(e.exerciseId)?.progressionGroup)
          .filter(Boolean);
        checkedAny = true;
        if (new Set(groups).size !== groups.length) violations++;
      }
    }
  }
  check('checked at least one sequence', checkedAny);
  check('no preset sequence (any focus/style) repeats a progression group', violations === 0);

  // A focused, concrete case: 'chest' calisthenics pools the entire
  // push-up progression (5 rungs) plus the entire planche progression (5
  // rungs) back to back — exactly the shape that would break without the
  // dedupe.
  const chestCalisthenics = presetSequencesFor('chest', 'calisthenics');
  check('chest/calisthenics: at least one preset came back', chestCalisthenics.length > 0);
  check('chest/calisthenics: no sequence has two push-up-progression rungs',
    chestCalisthenics.every(sq => sq.exercises.filter(e => exerciseById(e.exerciseId)?.progressionGroup === 'push-up').length <= 1));
  check('chest/calisthenics: no sequence has two planche-progression rungs',
    chestCalisthenics.every(sq => sq.exercises.filter(e => exerciseById(e.exerciseId)?.progressionGroup === 'planche').length <= 1));
}

console.log('workout-sequences.js — buildCustomSequence()');
{
  const custom = buildCustomSequence(['push-up', 'plank'], { focus: 'push', style: 'calisthenics' });
  check('buildCustomSequence: flagged custom: true', custom.custom === true);
  check('buildCustomSequence: preserves picked order', custom.exercises.map(e => e.exerciseId).join(',') === 'push-up,plank');
  check('buildCustomSequence: denormalizes name/mode/category from the catalog', custom.exercises[0].name === 'Push-Up' && custom.exercises[0].mode === 'reps' && custom.exercises[1].mode === 'hold');
  check('buildCustomSequence: carries the requested focus/style through for display', custom.focus === 'push' && custom.style === 'calisthenics');
  check('buildCustomSequence: defaults targetSets to 3', custom.targetSets === 3 && custom.exercises.every(e => e.targetSets === 3));

  const withUnknown = buildCustomSequence(['push-up', 'not-a-real-id', 'plank']);
  check('buildCustomSequence: silently drops an unknown id instead of throwing', withUnknown.exercises.length === 2);

  const empty = buildCustomSequence([]);
  check('buildCustomSequence: empty picks list returns an empty (not missing) exercises array', Array.isArray(empty.exercises) && empty.exercises.length === 0);

  const idA = buildCustomSequence(['push-up']).id;
  check('buildCustomSequence: id is a custom: string', idA.startsWith('custom:'));
}

console.log(failures === 0 ? '\nAll workout-sequences.js smoke tests passed.' : `\n${failures} workout-sequences.js smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
