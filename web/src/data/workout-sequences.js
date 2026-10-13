// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * data/workout-sequences.js
 *
 * Preset & custom **workout sequences** — ordered, named lists of exercises
 * that back ui/strength-session-flow.js's "choose your workout structure
 * before you start" step. Where data/exercises.js answers "what exercises
 * exist", this file answers "what order should someone actually do them
 * in" for a given muscle group + training style, so a rider starting a
 * strength session picks a whole session shape up front instead of
 * building it one exercise at a time once the session's already running
 * (views/strength-session.js's Browse picker still exists for swapping a
 * slot or logging something unplanned — see that file's own doc comment —
 * it's just no longer the *first* thing a rider has to do).
 *
 * ── Two axes, not one ───────────────────────────────────────────────────
 * data/exercises.js's FOCUS_GROUPS already covers "which muscles" (chest,
 * legs, push, full body...) *and* folds in two style-flavored entries of
 * its own ('calisthenics', 'skills') alongside a catch-all ('all'). Once
 * this file adds a second, explicit "which style" axis (WORKOUT_STYLES —
 * bodyweight calisthenics, barbell/dumbbell/kettlebell/cable/machine
 * "weights / home gym", or a "Half & Half" mix of the two), those three
 * FOCUS_GROUPS entries stop pulling their weight — 'calisthenics' becomes
 * redundant with picking the calisthenics style, 'skills' is a
 * calisthenics-only slice better expressed as a style-aware template (see
 * SEQUENCE_TEMPLATES' 'finisher' pulling from the tail of a skill-heavy
 * pool), and 'all'/"Custom" is superseded by buildCustomSequence() below.
 * SEQUENCE_FOCUS_GROUPS is FOCUS_GROUPS with exactly those three filtered
 * out — the muscle-group grid ui/strength-session-flow.js's Focus step
 * actually shows.
 *
 * Half & Half isn't a third `equipment`-style predicate the way the other
 * two are — "matches everything" would just reproduce whatever order the
 * catalog happens to list a focus's bodyweight vs. weighted entries in,
 * which could easily hand every SEQUENCE_TEMPLATES strategy (all of them
 * plain slices over pool order) an all-one-type pool rather than an
 * actual mix. See _poolForStyle()'s doc comment below for how its pool is
 * actually built.
 *
 * ── Presets are generated, not hand-authored ────────────────────────────
 * Rather than hand-typing 5–6 literal exercise lists for every one of
 * SEQUENCE_FOCUS_GROUPS' ~12 focus values × 3 styles (a lot of content to
 * keep in sync with the catalog by hand), SEQUENCE_TEMPLATES below is a
 * small set of named *selection strategies* — "Foundations", "Strength",
 * "Hypertrophy", "Supersets", "Quick", "Finisher" — each a pure function
 * over whatever exercise pool matches a given focus+style. This is the
 * same "predicate over the catalog, not a fixed list" convention
 * data/exercises.js's own FOCUS_GROUPS already uses for exercisesForFocus()
 * — a new catalog entry automatically shows up in the right presets with
 * no changes needed here.
 * presetSequencesFor() applies every template to the matching pool and
 * dedupes any that land on an identical exercise list (a thin pool — a
 * handful of muscle groups only have 2–3 bodyweight entries — can make
 * several templates coincide; showing five near-identical "presets" would
 * be worse than just showing the ones that are actually distinct).
 *
 * ── Custom sequences ─────────────────────────────────────────────────────
 * buildCustomSequence() wraps a rider-ordered list of exercise ids (picked
 * via ui/strength-session-flow.js's own build-your-own step, which reuses
 * data/exercises.js's searchExercises()/exercisesForFocus() the same way
 * views/strength-session.js's Browse picker already does) into the same
 * shape a preset has, `custom: true` — same "extra flag, same downstream
 * shape" convention data/exercises.js's createCustomExercise() uses for
 * custom exercises. Deliberately NOT persisted to storage/db.js — a
 * custom sequence lives for the session it was built for and is rebuilt
 * fresh next time, the same "ephemeral is fine, don't force a store"
 * choice as, say, a Quick Ride's WorkoutModel. A future "save this
 * sequence for reuse" feature could follow the exact
 * getCustomExercises()/saveCustomExercise() store pattern
 * data/exercises.js's custom exercises already use, without needing to
 * touch anything in this file's shape.
 *
 * A Sequence (preset or custom) has the shape:
 *   {
 *     id: string,               // stable within one focus+style (presets) or time-based (custom)
 *     templateId: string|null,  // the originating SEQUENCE_TEMPLATES id (presets only, e.g.
 *                               // 'foundations') — `id` itself is a composite
 *                               // "focus:style:templateId" key, not safe to match a template
 *                               // against directly; null for a custom sequence, which has no
 *                               // template. ui/strength-session-flow.js uses this to pick each
 *                               // preset card's icon.
 *     label: string,
 *     tagline: string,          // one line, shown on the picker card
 *     scheme: string,           // e.g. "3 sets × 8–12 reps · ~30s hold" — a single-line Set/Rep/
 *                               // Hold summary, kept short enough to never wrap inside a preset
 *                               // card (see .sf-sequence-card-scheme in style.css) — display only
 *     targetSets: number,       // informs each step's "logged / target" badge, not enforced
 *     focus: string,            // a SEQUENCE_FOCUS_GROUPS value
 *     style: string,            // a WORKOUT_STYLES value
 *     custom: boolean,
 *     exercises: [
 *       { exerciseId, name, mode, category, targetSets }, ...
 *     ],
 *   }
 *
 * `exercises` entries deliberately carry their own denormalized
 * name/mode/category (copied from the matching data/exercises.js catalog
 * entry at build time) rather than just an id — a Sequence gets embedded
 * into a Session's `meta` (see app.js's startStrengthSession()) and saved
 * with the record, same "flat, serializable, no re-lookup needed"
 * rationale core/strength-model.js's own doc comment gives for
 * StrengthSet. views/strength-session.js reads `.name` directly to drive
 * each step; `.exerciseId`/`.mode`/`.category` ride along for anything
 * that wants them without a fresh exerciseById() call.
 *
 * Usage:
 *   import { WORKOUT_STYLES, SEQUENCE_FOCUS_GROUPS, presetSequencesFor,
 *            buildCustomSequence } from '../data/workout-sequences.js';
 *
 *   const sequences = presetSequencesFor('push', 'calisthenics'); // up to 6 Sequences
 *   const mixed = presetSequencesFor('push', 'halfAndHalf'); // bodyweight + weighted, interleaved
 *   const custom = buildCustomSequence(['push-up', 'plank'], { focus: 'push', style: 'calisthenics' });
 */

import { FOCUS_GROUPS, allExercises, exerciseById } from './exercises.js';

// ─── Styles ─────────────────────────────────────────────────────────────────
// The second axis alongside a SEQUENCE_FOCUS_GROUPS muscle group. `match`
// follows data/exercises.js's FOCUS_GROUPS convention exactly (a predicate
// over a catalog entry) so both axes compose with a plain
// .filter(focus.match).filter(style.match).
export const WORKOUT_STYLES = [
  {
    value: 'calisthenics',
    label: 'Calisthenics',
    blurb: 'Bodyweight only — push-ups, pull-ups, dips, holds, skill progressions.',
    match: ex => ex.equipment === 'bodyweight',
  },
  {
    value: 'weights',
    label: 'Weights / Home Gym',
    blurb: 'Barbell, dumbbell, kettlebell, cable & machine — free weights and home-gym stack equipment.',
    match: ex => ex.equipment !== 'bodyweight',
  },
  {
    value: 'halfAndHalf',
    label: 'Half & Half',
    blurb: 'A mix of both — bodyweight moves alongside free weights/machines for the same muscle group.',
    // Deliberately "matches everything", not a real partition alongside
    // the two above — this is a display-time convenience (e.g. the
    // build-your-own step below filters its browse pool by this, and
    // "show me everything" is exactly the right filter for a mixed
    // session) rather than the thing presetSequencesFor() actually pools
    // against for this style — see _poolForStyle().
    match: () => true,
  },
];

// ─── Focus groups for the sequence picker ──────────────────────────────────
// FOCUS_GROUPS minus the three entries a style axis makes redundant — see
// this file's own doc comment above.
const _EXCLUDED_FOCUS = ['calisthenics', 'skills', 'all'];
export const SEQUENCE_FOCUS_GROUPS = FOCUS_GROUPS.filter(g => !_EXCLUDED_FOCUS.includes(g.value));

// ─── Selection strategies ───────────────────────────────────────────────────
// Pure functions over an already focus+style-filtered pool (catalog order
// preserved — data/exercises.js lists each category's compound/foundational
// movements first, isolation and skill-progression variants after, so a
// simple front/back/spread slice already reads as a sensible session
// rather than a random draw).

function _firstN(pool, n) {
  return pool.slice(0, Math.min(n, pool.length));
}

function _lastN(pool, n) {
  return pool.slice(Math.max(0, pool.length - n));
}

/** Evenly-spaced picks across the whole pool (inclusive of both ends) —
 *  more variety than a front-loaded slice once a pool is bigger than the
 *  requested count. */
function _evenlySpaced(pool, n) {
  const total = pool.length;
  const count = Math.min(n, total);
  if (count <= 0) return [];
  if (count >= total) return pool.slice();

  const idx = [];
  for (let i = 0; i < count; i++) {
    idx.push(Math.round((i * (total - 1)) / (count - 1 || 1)));
  }
  const unique = [...new Set(idx)];
  for (let i = 0; unique.length < count && i < total; i++) {
    if (!unique.includes(i)) unique.push(i);
  }
  return unique.slice(0, count).sort((a, b) => a - b).map(i => pool[i]);
}

/** Alternates a pick from the front half of the pool with one from the
 *  back half — meant to read as "pair a foundational move with a
 *  different one" for a Superset Pairs preset, rather than just another
 *  front-loaded slice. */
function _pairedHalves(pool, n) {
  const total = pool.length;
  const count = Math.min(n, total);
  if (count <= 0) return [];

  const mid = Math.ceil(total / 2);
  const front = pool.slice(0, mid);
  const back = pool.slice(mid);
  const picks = [];
  for (let i = 0; picks.length < count && (i < front.length || i < back.length); i++) {
    if (i < front.length && picks.length < count) picks.push(front[i]);
    if (i < back.length && picks.length < count) picks.push(back[i]);
  }
  return picks;
}

/** Alternates elements from two lists — a[0], b[0], a[1], b[1], ... —
 *  appending whatever's left in the longer list once the shorter one runs
 *  out. The building block _poolForStyle() below uses to turn two
 *  single-style pools into one that reads as an actual mix. */
function _interleave(a, b) {
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/** Collapses a filtered pool down to at most one exercise per
 *  `progressionGroup` — see data/exercises.js's own doc comment on
 *  calisthenics skill progressions. Every SEQUENCE_TEMPLATES strategy
 *  below is a plain slice over pool order, and a progression chain's
 *  rungs (e.g. the push-up family's five entries) sit consecutively in
 *  the bundled catalog, so an un-deduped pool can hand something like
 *  "Foundations" four of its five picks from the exact same skill line —
 *  every rung of one movement pattern, not a balanced session. Since
 *  `progressionGroup` only appears on bodyweight catalog entries (see
 *  that same doc comment), this only ever changes anything for a
 *  calisthenics-filtered pool — a 'weights' pool passes through
 *  unaffected.
 *
 *  Keeps each group's `intermediate`-level rung when the pool happens to
 *  include it — every bundled PROGRESSION_GROUPS chain has exactly one
 *  (data/exercises.js's LEVELS has 5 tiers, novice→master), and it reads
 *  as the single most representative "do this" version of the skill for
 *  a preset rather than the beginner or master end of the ladder.
 *  Otherwise keeps whichever rung the pool happens to encounter first.
 *  The result is always a subsequence of the input — entries are only
 *  ever dropped, never reordered or added — so callers don't need to
 *  re-sort anything downstream. */
function _dedupeByProgressionGroup(pool) {
  const keeper = new Map(); // progressionGroup -> the one rung to keep
  for (const ex of pool) {
    if (!ex.progressionGroup) continue;
    const current = keeper.get(ex.progressionGroup);
    if (!current || (ex.level === 'intermediate' && current.level !== 'intermediate')) {
      keeper.set(ex.progressionGroup, ex);
    }
  }
  const emitted = new Set();
  return pool.filter(ex => {
    if (!ex.progressionGroup) return true;
    if (emitted.has(ex.progressionGroup)) return false;
    if (keeper.get(ex.progressionGroup)?.id !== ex.id) return false;
    emitted.add(ex.progressionGroup);
    return true;
  });
}

/** The exercise pool a style's SEQUENCE_TEMPLATES actually select from,
 *  given `focusExercises` (a focus group's exercises, style not yet
 *  applied). 'calisthenics'/'weights' are a plain predicate filter — see
 *  their `match` in WORKOUT_STYLES above. 'halfAndHalf' pools the
 *  calisthenics-filtered and weights-filtered lists separately and
 *  interleaves them (see _interleave()), rather than using its own
 *  "matches everything" `match` here — filtering by that would just
 *  reproduce the catalog's own bodyweight/weighted ordering for this
 *  focus, which could easily skew an entire preset to one equipment type
 *  depending on which happens to come first. Interleaving means every
 *  SEQUENCE_TEMPLATES strategy (all plain slices over pool order) comes
 *  out mixed instead.
 *
 *  The non-mixed branch below runs its whole filtered pool through
 *  _dedupeByProgressionGroup() too — a no-op for 'weights' (no weighted
 *  entry carries a progressionGroup) and the fix described above for
 *  'calisthenics'. The 'halfAndHalf' branch only needs it on the
 *  calisthenics half before interleaving — see that function's own doc
 *  comment for why a raw filtered pool can otherwise hand an entire
 *  preset several rungs of the same skill progression. */
function _poolForStyle(focusExercises, styleGroup) {
  if (styleGroup.value === 'halfAndHalf') {
    const calisthenics = WORKOUT_STYLES.find(s => s.value === 'calisthenics');
    const weights = WORKOUT_STYLES.find(s => s.value === 'weights');
    return _interleave(
      _dedupeByProgressionGroup(focusExercises.filter(calisthenics.match)),
      focusExercises.filter(weights.match),
    );
  }
  return _dedupeByProgressionGroup(focusExercises.filter(styleGroup.match));
}

// Six named strategies — presetSequencesFor() runs every one of these
// against a focus+style pool and keeps whatever comes out distinct (see
// that function). `targetSets`/`scheme` are display/reference only,
// nothing here enforces them — the rider still logs whatever they
// actually did, same as every other set logged in
// views/strength-session.js.
const SEQUENCE_TEMPLATES = [
  {
    id: 'foundations', label: 'Foundations',
    tagline: 'A balanced default hitting this focus\u2019s main movements.',
    targetSets: 3, scheme: '3 sets \u00d7 8\u201312 reps \u00b7 ~30s hold',
    select: pool => _firstN(pool, 5),
  },
  {
    id: 'strength', label: 'Strength',
    tagline: 'Fewer moves, heavier effort.',
    targetSets: 4, scheme: '4 sets \u00d7 4\u20136 reps \u00b7 20\u201330s hold',
    select: pool => _firstN(pool, 4),
  },
  {
    id: 'hypertrophy', label: 'Hypertrophy',
    tagline: 'More variety, higher rep ranges.',
    targetSets: 3, scheme: '3 sets \u00d7 10\u201315 reps',
    select: pool => _evenlySpaced(pool, 6),
  },
  {
    id: 'supersets', label: 'Supersets',
    tagline: 'Work through in back-to-back pairs, minimal rest between the two.',
    targetSets: 3, scheme: '3 rounds \u00b7 paired sets',
    select: pool => _pairedHalves(pool, 6),
  },
  {
    id: 'quick', label: 'Quick',
    tagline: 'Short on time \u2014 hit the essentials.',
    targetSets: 3, scheme: '3 sets \u00d7 10\u201312 reps',
    select: pool => _firstN(pool, 3),
  },
  {
    id: 'finisher', label: 'Finisher',
    tagline: 'Close out with higher reps and shorter rest.',
    targetSets: 2, scheme: '2\u20133 sets \u00d7 15\u201320 reps \u00b7 long hold',
    select: pool => _lastN(pool, 5),
  },
];

function _sequenceExercise(ex, targetSets) {
  return { exerciseId: ex.id, name: ex.name, mode: ex.mode, category: ex.category, targetSets };
}

/** Every preset workout sequence for a given muscle group + style, built
 *  fresh from the current catalog (bundled + any rider-authored custom
 *  exercises — see data/exercises.js's allExercises()). Up to
 *  SEQUENCE_TEMPLATES.length (6) — fewer when the matching pool is thin
 *  enough that two or more templates land on the exact same exercise list
 *  (deduped, first-defined-template wins so the order stays stable) or
 *  empty (a template with nothing to pick from is simply skipped, not
 *  shown as an empty card).
 *
 *  @param {string} focus  A SEQUENCE_FOCUS_GROUPS value.
 *  @param {string} style  A WORKOUT_STYLES value.
 *  @returns {Object[]} Sequence objects — see this file's own doc comment
 *    for the shape. Empty array only if focus+style matches nothing in
 *    the catalog at all (not expected for any bundled combination). */
export function presetSequencesFor(focus, style) {
  const focusGroup = SEQUENCE_FOCUS_GROUPS.find(g => g.value === focus) ?? SEQUENCE_FOCUS_GROUPS[0];
  const styleGroup = WORKOUT_STYLES.find(s => s.value === style) ?? WORKOUT_STYLES[0];
  const pool = _poolForStyle(allExercises().filter(focusGroup.match), styleGroup);
  if (!pool.length) return [];

  const seen = new Set();
  const sequences = [];
  for (const tpl of SEQUENCE_TEMPLATES) {
    const picked = tpl.select(pool);
    if (!picked.length) continue;
    const key = picked.map(ex => ex.id).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    sequences.push({
      id: `${focusGroup.value}:${styleGroup.value}:${tpl.id}`,
      templateId: tpl.id,
      label: tpl.label,
      tagline: tpl.tagline,
      scheme: tpl.scheme,
      targetSets: tpl.targetSets,
      focus: focusGroup.value,
      style: styleGroup.value,
      custom: false,
      exercises: picked.map(ex => _sequenceExercise(ex, tpl.targetSets)),
    });
  }
  return sequences;
}

/** Wraps a rider-ordered list of exercise ids (from
 *  ui/strength-session-flow.js's build-your-own step) into the same Sequence
 *  shape a preset has, `custom: true`. Unknown ids are silently dropped
 *  (defensive only — the setup flow only ever offers ids it just got from
 *  data/exercises.js's own lookups) rather than throwing, same
 *  "best-effort, no dangling reference" spirit as
 *  data/exercises.js's own progressionChain().
 *
 *  @param {string[]} exerciseIds  In the order the rider tapped them.
 *  @param {Object}   [opts]
 *  @param {string}   [opts.focus]       A SEQUENCE_FOCUS_GROUPS value, for display only.
 *  @param {string}   [opts.style]       A WORKOUT_STYLES value, for display only.
 *  @param {number}   [opts.targetSets=3]
 *  @returns {Object} A Sequence — see this file's own doc comment for the shape. */
export function buildCustomSequence(exerciseIds, { focus = null, style = null, targetSets = 3 } = {}) {
  const exercises = (exerciseIds ?? [])
    .map(id => exerciseById(id))
    .filter(Boolean)
    .map(ex => _sequenceExercise(ex, targetSets));

  return {
    id: `custom:${Date.now().toString(36)}`,
    templateId: null,
    label: 'Custom Sequence',
    tagline: 'Built by you for this session.',
    scheme: `${targetSets} sets \u00d7 8\u201312 reps \u00b7 ~30s hold`,
    targetSets,
    focus,
    style,
    custom: true,
    exercises,
  };
}

export default { WORKOUT_STYLES, SEQUENCE_FOCUS_GROUPS, presetSequencesFor, buildCustomSequence };
