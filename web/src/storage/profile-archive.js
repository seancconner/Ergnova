// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * storage/profile-archive.js
 *
 * The file format behind Settings → Backup & Restore's "Export"/"Import"
 * buttons: everything on this device in one JSON file — workout history,
 * diet diary, weigh-ins, custom ingredients/recipes/exercises/cardio
 * presets, and a snapshot of every setting (storage/db.js's `prefs`
 * store). Pure functions only (no DOM, no IndexedDB), same split as
 * recording/history-archive.js — this module owns the file shape,
 * validation, and dedup rules; app.js's Backup & Restore wiring does the
 * actual IndexedDB reads/writes and file I/O (platform/save-file.js,
 * platform/pick-file.js).
 *
 * This is a superset of, not a replacement for, History's own "Export
 * all"/Import (recording/history-archive.js) — that stays as the quick
 * "just my workouts" path. The `sessions` half of this file is written
 * and read with that module's own normalizeImportedSession()/
 * planSessionImport(), so there is exactly one place a session record's
 * shape is validated.
 *
 * File shape:
 *   { format: 'ergnova-profile', version: 1, exportedAt: <ISO string>,
 *     counts: { sessions, diaryEntries, bodyMeasurements, ingredients,
 *               recipes, exercises, cardioPresets },
 *     data: {
 *       prefs: { <every key/value in storage/db.js's prefs store> },
 *       sessions: [ <SessionRecord>, ... ],           // no id — see below
 *       diaryEntries: [ <DiaryEntry>, ... ],           // no id; own-recipe entries carry source.recipeName
 *       bodyMeasurements: [ <BodyMeasurement>, ... ],  // no id
 *       recipes: [ <Recipe>, ... ],                    // no id
 *       ingredients: [ <Ingredient>, ... ],             // 'custom:'-id kept
 *       exercises: [ <Exercise>, ... ],                 // 'custom:'-id kept
 *       cardioPresets: [ <TimelinePreset>, ... ],       // 'custom:'-id kept
 *     } }
 *
 * Ids: sessions/diaryEntries/bodyMeasurements/recipes live in autoIncrement
 * IndexedDB stores — their local `id` belongs to one device and is dropped
 * on export, never trusted on import, same reasoning as history-archive.js.
 * ingredients/exercises/cardioPresets carry their own stable `custom:<uuid>`
 * id (assigned once, at creation — see core/nutrition-model.js's nextId()
 * and its two siblings in data/exercises.js and data/cardio-timelines.js)
 * — that id *is* their identity, so it travels with the record and is used
 * to dedup on import instead of being stripped.
 *
 * Diary entries that logged one of the rider's OWN recipes: such an entry
 * points at its recipe by `source.id`, and for an own recipe that is the
 * autoIncrement id from THIS device's recipes store — meaningless (or, worse,
 * a different recipe) anywhere else. So on export the numeric id is swapped
 * for `source.recipeName`, and on import recipes are added first and each
 * entry is re-pointed at the local recipe with that name
 * (resolveRecipeReferences()) — the same "same name = same recipe" identity
 * the recipe dedup below uses. Bundled preset / seed ids are strings, stable
 * across devices, and are left exactly as they are. Only a NUMBER is treated
 * as a device-local id; a numeric `source.id` found in a file is never
 * trusted on import (it is nulled), whatever wrote the file. A reference that
 * can't be resolved (recipe missing from the file and from this device) ends
 * up `source.id: null`, the same state an entry is in after its recipe is
 * deleted locally — its saved nutrients are untouched.
 *
 * Duplicates — "already-present wins; skipped, not merged" for every
 * category, same rule history-archive.js uses for sessions:
 *   - sessions:                    startTime (via history-archive.js)
 *   - diaryEntries:                loggedAt
 *   - bodyMeasurements:            measuredAt
 *   - ingredients/exercises/cardioPresets: their own `custom:` id
 *   - recipes: no stable id (autoIncrement, and nothing else about a
 *     Recipe is guaranteed unique) — deduped on normalized name instead.
 *     A same-named recipe already on the device wins; the imported one is
 *     skipped rather than creating a second entry with the same name.
 *
 * Settings snapshot: unlike every list above, `prefs` isn't an
 * append-only log — it's a point-in-time snapshot, so import doesn't
 * "merge" it the way it merges sessions/diary/etc. It's applied wholesale,
 * replacing whatever's currently saved (see db.setPrefs()). The Backup &
 * Restore UI makes this distinction explicit before importing: new
 * records are added, but settings are replaced.
 *
 * Two guards on that snapshot, because it is a raw dump of db.js's whole
 * `prefs` store rather than a hand-picked key list (so a new setting is
 * included automatically, without this file needing to know about it):
 *   - TRANSIENT_PREF_KEYS are runtime state that happens to live in the same
 *     store — the crash-recovery snapshot of a workout in progress
 *     (recording/session-persistence.js). They're never exported (a snapshot
 *     holds a sample per second, and isn't a setting), and never imported (it
 *     would either resurrect a "resume workout?" prompt for a ride from some
 *     other device, or — as `null` — silently erase a real recovery snapshot
 *     already sitting on this one).
 *   - Values for the settings app.js reads back WITHOUT type checks
 *     (loadPreferences()) are validated on import, same "make sure it won't
 *     crash something downstream" bar as the per-entry checks below. A
 *     known key with a wrong-typed value is dropped and counted in
 *     `invalid.prefs`; a key this file has never heard of passes through, so
 *     a setting added by a newer build survives a round trip.
 */

import {
  normalizeImportedSession, planSessionImport,
} from '../recording/history-archive.js';

export const PROFILE_ARCHIVE_FORMAT  = 'ergnova-profile';
export const PROFILE_ARCHIVE_VERSION = 1;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Keys in the `prefs` store that hold runtime state, not settings — see the
 *  "Two guards" note in the module doc comment. Exported so the test (and
 *  anything else that dumps the store) can share the one list. */
export const TRANSIENT_PREF_KEYS = Object.freeze(['activeWorkout', 'activeStrengthWorkout']);
const _TRANSIENT_PREF_KEYS = new Set(TRANSIENT_PREF_KEYS);

const _isNum    = (v) => typeof v === 'number' && Number.isFinite(v);
const _isPosNum = (v) => _isNum(v) && v > 0;
const _isBool   = (v) => typeof v === 'boolean';
const _isStr    = (v) => typeof v === 'string';
const _nullable = (check) => (v) => v === null || check(v);

/** Type check per setting that app.js's loadPreferences() reads back without
 *  guarding. Mirrors what savePreferences()/the test flows actually write: the
 *  optional profile fields are a positive number or null (never 0 or NaN — see
 *  savePreferences()'s `<= 0 ? null` pattern), the test-result dates are the
 *  strings _saveFtpTestResult() and friends store. ftp and riderWeight are in
 *  that group too: a rider who saves the profile without filling them in has
 *  null stored for both. */
const PREF_CHECKS = {
  ftp: _nullable(_isPosNum), riderWeight: _nullable(_isPosNum), chartWindow: _isPosNum,
  units: (v) => v === 'metric' || v === 'imperial',
  sex: (v) => v === null || v === 'male' || v === 'female',
  audioCues: _isBool, autoPause: _isBool, backgroundNotification: _isBool,
  autoPauseControllers: isPlainObject, autoPauseModes: isPlainObject, autoPauseTriggers: isPlainObject,
  enabledTargetTypes: Array.isArray,
  ...Object.fromEntries([
    'age', 'restingHr', 'maxHr', 'heightCm', 'bodyFatPct', 'leanBodyMassKg', 'muscleMassKg', 'boneMassKg',
    'bodyWaterKg', 'visceralFatRating', 'basalMetabolicRateKcal', 'vo2Max', 'ftpTestWatts', 'restingHrTestBpm',
  ].map((k) => [k, _nullable(_isPosNum)])),
  ...Object.fromEntries([
    'vo2MaxDate', 'ftpTestDate', 'ftpTestLabel', 'restingHrTestDate',
  ].map((k) => [k, _nullable(_isStr)])),
};

/** The exportable half of a raw prefs dump: everything except runtime state. */
function _settingsOnly(prefs) {
  if (!isPlainObject(prefs)) return {};
  return Object.fromEntries(Object.entries(prefs).filter(([key]) => !_TRANSIENT_PREF_KEYS.has(key)));
}

/** Import-side counterpart: drops runtime-state keys (silently — they were
 *  never meant to travel, so their presence isn't "unreadable data") and
 *  known-key values of the wrong type (counted). */
function _normalizePrefs(raw) {
  const out = {};
  let invalid = 0;
  if (!isPlainObject(raw)) return { out, invalid };
  for (const [key, value] of Object.entries(raw)) {
    if (_TRANSIENT_PREF_KEYS.has(key)) continue;
    const check = PREF_CHECKS[key];
    if (check && !check(value)) { invalid++; continue; }
    out[key] = value;
  }
  return { out, invalid };
}

/** `ergnova-profile-2026-09-20.json` — local date, same convention as
 *  history-archive.js's historyArchiveFilename(). */
export function profileArchiveFilename(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `ergnova-profile-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

// ─── Export ─────────────────────────────────────────────────────────────────

const _stripId = (list) => list.map(({ id, ...rest }) => rest);

/** The key "same recipe" is decided on: trimmed, case-insensitive name. Shared
 *  by the recipe dedup (planProfileImport) and the diary re-pointing
 *  (resolveRecipeReferences), so the two can never disagree. */
export const recipeNameKey = (name) => String(name ?? '').trim().toLowerCase();

/** One diary entry, export side: id dropped, and a numeric (device-local) recipe
 *  id in `source` swapped for the recipe's name. An id that matches no recipe on
 *  this device is just dropped — there's nothing to name. */
function _exportDiaryEntry(entry, recipeNameById) {
  const { id, ...e } = entry;
  if (!isPlainObject(e.source) || typeof e.source.id !== 'number') return e;
  const { id: recipeId, ...source } = e.source;
  const name = recipeNameById.get(recipeId);
  return { ...e, source: typeof name === 'string' ? { ...source, recipeName: name } : source };
}

/**
 * @param {Object}   source
 * @param {Object}   [source.prefs={}]             db.getAllPrefs()
 * @param {Object[]} [source.sessions=[]]          db.getSessions()
 * @param {Object[]} [source.diaryEntries=[]]      db.getDiaryEntries()
 * @param {Object[]} [source.bodyMeasurements=[]]  db.getBodyMeasurements()
 * @param {Object[]} [source.ingredients=[]]       db.getCustomIngredients()
 * @param {Object[]} [source.recipes=[]]           db.getRecipes()
 * @param {Object[]} [source.exercises=[]]         db.getCustomExercises()
 * @param {Object[]} [source.cardioPresets=[]]     db.getCustomCardioPresets()
 * @param {Object}   [opts]
 * @param {number}   [opts.now=Date.now()]
 * @returns {{ json: string, counts: Object, settingsCount: number, filename: string }}
 *   `settingsCount` is how many settings keys the snapshot carries (0 when
 *   there's nothing to restore) — storage/profile-backup-flow.js uses it,
 *   alongside `counts`, to decide whether there's anything to export at all.
 *   Compact JSON on purpose, same reasoning as buildHistoryArchive() —
 *   sessions carry one sample per second, so this is already the biggest
 *   file the app writes.
 */
export function buildProfileArchive(source = {}, { now = Date.now() } = {}) {
  const {
    prefs = {}, sessions = [], diaryEntries = [], bodyMeasurements = [],
    ingredients = [], recipes = [], exercises = [], cardioPresets = [],
  } = source;

  const recipeNameById = new Map(recipes.map((r) => [r.id, r.name]));

  const data = {
    prefs: _settingsOnly(prefs),
    sessions: _stripId(sessions).sort((a, b) => a.startTime - b.startTime),
    diaryEntries: diaryEntries
      .map((e) => _exportDiaryEntry(e, recipeNameById))
      .sort((a, b) => a.loggedAt - b.loggedAt),
    bodyMeasurements: _stripId(bodyMeasurements).sort((a, b) => a.measuredAt - b.measuredAt),
    recipes: _stripId(recipes),
    // Ids kept — see module doc comment above.
    ingredients,
    exercises,
    cardioPresets,
  };

  const counts = {
    sessions: data.sessions.length,
    diaryEntries: data.diaryEntries.length,
    bodyMeasurements: data.bodyMeasurements.length,
    ingredients: data.ingredients.length,
    recipes: data.recipes.length,
    exercises: data.exercises.length,
    cardioPresets: data.cardioPresets.length,
  };

  const json = JSON.stringify({
    format: PROFILE_ARCHIVE_FORMAT,
    version: PROFILE_ARCHIVE_VERSION,
    exportedAt: new Date(now).toISOString(),
    counts,
    data,
  });
  return { json, counts, settingsCount: Object.keys(data.prefs).length, filename: profileArchiveFilename(now) };
}

// ─── Import: per-category validation ───────────────────────────────────────
// Each normalizer checks only what the rest of the app actually
// dereferences without guarding, same "don't guess, just make sure it
// won't crash something downstream" bar normalizeImportedSession() sets in
// history-archive.js. Everything else on a record passes through
// untouched — an unrecognized extra field is kept, not stripped.

function normalizeImportedDiaryEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const { id, ...e } = raw;
  if (!Number.isFinite(e.loggedAt) || e.loggedAt <= 0) return null;
  if (e.mealSlot != null && typeof e.mealSlot !== 'string') return null;
  if (e.source != null && !isPlainObject(e.source)) return null;
  if (e.nutrients != null && !isPlainObject(e.nutrients)) return null;
  // A numeric source.id is another device's recipe id (see module doc) — never
  // trust it. resolveRecipeReferences() re-points the entry by recipeName.
  if (e.source && typeof e.source.id === 'number') return { ...e, source: { ...e.source, id: null } };
  return e;
}

function normalizeImportedBodyMeasurement(raw) {
  if (!isPlainObject(raw)) return null;
  const { id, ...m } = raw;
  if (!Number.isFinite(m.measuredAt) || m.measuredAt <= 0) return null;
  return m;
}

function normalizeImportedRecipe(raw) {
  if (!isPlainObject(raw)) return null;
  const { id, ...r } = raw;
  if (typeof r.name !== 'string' || !r.name.trim()) return null;
  if (!Array.isArray(r.ingredients)) return null;
  return r;
}

/** Shared by ingredients/exercises/cardioPresets — all three keep their own
 *  `custom:<uuid>` id (see module doc comment) and are named by `nameField`
 *  ('name' for ingredients/exercises, 'label' for cardio presets). */
function _normalizeImportedCustomRecord(raw, nameField) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id.startsWith('custom:')) return null;
  if (typeof raw[nameField] !== 'string' || !raw[nameField].trim()) return null;
  return raw;
}
const normalizeImportedIngredient   = (raw) => _normalizeImportedCustomRecord(raw, 'name');
const normalizeImportedExercise     = (raw) => _normalizeImportedCustomRecord(raw, 'name');
const normalizeImportedCardioPreset = (raw) => _normalizeImportedCustomRecord(raw, 'label');

function _normalizeList(list, fn) {
  const out = [];
  let invalid = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    const n = fn(raw);
    if (n) out.push(n); else invalid++;
  }
  return { out, invalid };
}

// ─── Import: parse ──────────────────────────────────────────────────────────

/**
 * @param {string} text  Contents of the picked file.
 * @returns {{ ok: true, data: Object, invalid: Object }
 *          |{ ok: false, error: 'not-json'|'unrecognized'|'wrong-format'|'newer-version' }}
 *   `data` has the same seven list fields as buildProfileArchive()'s input
 *   plus `prefs`; `invalid` counts unusable entries per list — and, under
 *   `prefs`, settings dropped for having the wrong type (see
 *   normalizeImportedSession()'s doc comment in history-archive.js for why
 *   one bad entry doesn't sink the rest).
 */
export function parseProfileArchive(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text).replace(/^\uFEFF/, '')); // a BOM is legal in a file some editors touched
  } catch {
    return { ok: false, error: 'not-json' };
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.data)) return { ok: false, error: 'unrecognized' };
  if (parsed.format !== undefined && parsed.format !== PROFILE_ARCHIVE_FORMAT) return { ok: false, error: 'wrong-format' };
  if (Number.isFinite(parsed.version) && parsed.version > PROFILE_ARCHIVE_VERSION) return { ok: false, error: 'newer-version' };

  const d = parsed.data;
  const sessionsR      = _normalizeList(d.sessions, normalizeImportedSession);
  const diaryR         = _normalizeList(d.diaryEntries, normalizeImportedDiaryEntry);
  const bodyR          = _normalizeList(d.bodyMeasurements, normalizeImportedBodyMeasurement);
  const ingredientsR   = _normalizeList(d.ingredients, normalizeImportedIngredient);
  const recipesR       = _normalizeList(d.recipes, normalizeImportedRecipe);
  const exercisesR     = _normalizeList(d.exercises, normalizeImportedExercise);
  const cardioPresetsR = _normalizeList(d.cardioPresets, normalizeImportedCardioPreset);
  const prefsR = _normalizePrefs(d.prefs);

  return {
    ok: true,
    data: {
      prefs: prefsR.out,
      sessions: sessionsR.out,
      diaryEntries: diaryR.out,
      bodyMeasurements: bodyR.out,
      ingredients: ingredientsR.out,
      recipes: recipesR.out,
      exercises: exercisesR.out,
      cardioPresets: cardioPresetsR.out,
    },
    invalid: {
      prefs: prefsR.invalid,
      sessions: sessionsR.invalid,
      diaryEntries: diaryR.invalid,
      bodyMeasurements: bodyR.invalid,
      ingredients: ingredientsR.invalid,
      recipes: recipesR.invalid,
      exercises: exercisesR.invalid,
      cardioPresets: cardioPresetsR.invalid,
    },
  };
}

// ─── Import: recipe references ──────────────────────────────────────────────

/**
 * Re-points diary entries that carry `source.recipeName` at the local recipe
 * with that name. Call it once every recipe in the file is on this device.
 * Pure; returns new entry objects and leaves the input alone. Entries without
 * a `recipeName` are returned as-is. A name with no local recipe gives
 * `source.id: null`.
 * @param {Object[]} entries  diary entries (no ids), from plan.diaryEntries.toAdd
 * @param {Map<string, number>} recipeIdByName  recipeNameKey(name) -> local recipe id
 */
export function resolveRecipeReferences(entries, recipeIdByName) {
  return entries.map((entry) => {
    const source = entry.source;
    if (!isPlainObject(source) || !('recipeName' in source)) return entry;
    const { recipeName, ...rest } = source;
    const localId = typeof recipeName === 'string' ? recipeIdByName.get(recipeNameKey(recipeName)) : undefined;
    return { ...entry, source: { ...rest, id: localId ?? null } };
  });
}

// ─── Import: duplicate plan ─────────────────────────────────────────────────

function _planByKey(existingKeys, list, keyFn) {
  const seen = new Set(existingKeys);
  const toAdd = [];
  let duplicates = 0;
  for (const item of list) {
    const key = keyFn(item);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    toAdd.push(item);
  }
  return { toAdd, duplicates };
}

/**
 * Splits every list in a parsed archive into what to add vs. what to skip
 * as already-present, one category at a time. `existing` is whatever's
 * already on this device — plain arrays/iterables the caller (app.js)
 * builds from its own db.get*() calls, so this stays pure/DB-free like the
 * rest of the module.
 *
 * @param {Object} existing
 * @param {Iterable<number>} existing.sessionStartTimes
 * @param {Iterable<number>} existing.diaryLoggedAts
 * @param {Iterable<number>} existing.bodyMeasuredAts
 * @param {Iterable<string>} existing.ingredientIds
 * @param {Iterable<string>} existing.exerciseIds
 * @param {Iterable<string>} existing.cardioPresetIds
 * @param {Iterable<string>} existing.recipeNames   already normalized (trim+lowercase)
 * @param {Object} data  parseProfileArchive().data
 * @returns {Object}  one `{ toAdd, duplicates }` per category (see module doc comment)
 */
export function planProfileImport(existing, data) {
  const sessionPlan = planSessionImport(existing.sessionStartTimes ?? [], data.sessions ?? []);

  return {
    sessions: { toAdd: sessionPlan.toAdd, duplicates: sessionPlan.duplicates },
    diaryEntries: _planByKey(existing.diaryLoggedAts ?? [], data.diaryEntries ?? [], (e) => e.loggedAt),
    bodyMeasurements: _planByKey(existing.bodyMeasuredAts ?? [], data.bodyMeasurements ?? [], (m) => m.measuredAt),
    ingredients: _planByKey(existing.ingredientIds ?? [], data.ingredients ?? [], (i) => i.id),
    exercises: _planByKey(existing.exerciseIds ?? [], data.exercises ?? [], (x) => x.id),
    cardioPresets: _planByKey(existing.cardioPresetIds ?? [], data.cardioPresets ?? [], (c) => c.id),
    recipes: _planByKey(existing.recipeNames ?? [], data.recipes ?? [], (r) => recipeNameKey(r.name)),
  };
}

// ─── Messages ───────────────────────────────────────────────────────────────

const _CATEGORY_LABELS = {
  sessions: ['workout', 'workouts'],
  diaryEntries: ['diet entry', 'diet entries'],
  bodyMeasurements: ['weigh-in', 'weigh-ins'],
  ingredients: ['ingredient', 'ingredients'],
  recipes: ['recipe', 'recipes'],
  exercises: ['custom exercise', 'custom exercises'],
  cardioPresets: ['cardio preset', 'cardio presets'],
};

function _count(n, [singular, plural]) { return `${n} ${n === 1 ? singular : plural}`; }

function _joinList(parts) {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/** How many records an import plan would actually add, across every category. */
export function planAddCount(plan) {
  let n = 0;
  for (const key of Object.keys(_CATEGORY_LABELS)) n += plan[key]?.toAdd?.length ?? 0;
  return n;
}

/**
 * The text of the confirmation shown before an import is applied — the one
 * place the "new records are ADDED but settings are REPLACED" distinction (see
 * the module doc comment) is spelled out to the rider. A plain string with
 * line breaks, because the caller shows it in a native confirm().
 * @param {Object}  plan                    planProfileImport()'s return value
 * @param {Object}  [opts]
 * @param {boolean} [opts.replacesSettings=false]  the file carries a settings snapshot that will be applied
 */
export function profileImportConfirmText(plan, { replacesSettings = false } = {}) {
  const addedParts = [];
  for (const key of Object.keys(_CATEGORY_LABELS)) {
    const added = plan[key]?.toAdd?.length ?? 0;
    if (added) addedParts.push(_count(added, _CATEGORY_LABELS[key]));
  }
  const bullets = [];
  if (addedParts.length) bullets.push(`\u2022 Add ${_joinList(addedParts)}`);
  if (replacesSettings) bullets.push('\u2022 Replace your current settings with the ones in this file');
  return [
    'Import this backup?',
    '',
    ...bullets,
    '',
    'Anything already on this device is kept \u2014 only settings are overwritten.',
  ].join('\n');
}

/**
 * The one-line result shown under Backup & Restore after an import.
 * @param {Object} plan   planProfileImport()'s return value
 * @param {Object} [opts]
 * @param {boolean} [opts.prefsRestored=false]  whether the settings snapshot was applied
 * @param {Object}  [opts.invalid={}]           parseProfileArchive().invalid
 */
export function profileImportSummary(plan, { prefsRestored = false, invalid = {} } = {}) {
  const addedParts = [];
  let totalDuplicates = 0;
  for (const key of Object.keys(_CATEGORY_LABELS)) {
    const added = plan[key]?.toAdd?.length ?? 0;
    totalDuplicates += plan[key]?.duplicates ?? 0;
    if (added) addedParts.push(_count(added, _CATEGORY_LABELS[key]));
  }
  const totalInvalid = Object.values(invalid).reduce((sum, n) => sum + (n || 0), 0);

  const parts = [addedParts.length ? `Imported ${_joinList(addedParts)}.` : 'Nothing new to import.'];
  if (prefsRestored) parts.push('Settings restored.');
  if (totalDuplicates) {
    parts.push(`${totalDuplicates} item${totalDuplicates === 1 ? '' : 's'} already on this device ${totalDuplicates === 1 ? 'was' : 'were'} skipped.`);
  }
  if (totalInvalid) parts.push(`${totalInvalid} entr${totalInvalid === 1 ? 'y' : 'ies'} couldn\u2019t be read.`);
  return parts.join(' ');
}

/**
 * The one-line result shown under Backup & Restore after a successful
 * export — "Exported 2 workouts, 1 diet entry, ..., and your settings."
 * Unlike profileImportSummary() there's no duplicate/invalid bookkeeping
 * here: everything on the device went into the file, full stop.
 * @param {Object} counts          buildProfileArchive()'s `counts`
 * @param {Object} [opts]
 * @param {number} [opts.settingsCount=0]  buildProfileArchive()'s `settingsCount`
 */
export function profileExportSummary(counts, { settingsCount = 0 } = {}) {
  const parts = [];
  for (const key of Object.keys(_CATEGORY_LABELS)) {
    const n = counts?.[key] ?? 0;
    if (n) parts.push(_count(n, _CATEGORY_LABELS[key]));
  }
  if (settingsCount) parts.push('your settings');
  return `Exported ${_joinList(parts)}.`;
}

/**
 * The one-line result shown under Backup & Restore when an import fails
 * part-way through (storage/profile-transfer.js's applyProfileImport()
 * writes one category at a time, so an earlier one may already be in).
 * With nothing landed yet, says so plainly instead of talking about a
 * "part-way" stop that didn't happen.
 * @param {Object}   plan             planProfileImport()'s return value
 * @param {string[]} importedSoFar    err.importedSoFar from the failed applyProfileImport() call —
 *                                    category names that had already been written when it threw
 * @param {Object}   [opts]
 * @param {boolean}  [opts.settingsPending=false]  the file carried a settings snapshot that
 *                                                  never got applied (the write failed before reaching it)
 */
export function profileImportFailureMessage(plan, importedSoFar = [], { settingsPending = false } = {}) {
  if (!importedSoFar.length) {
    return 'Couldn\u2019t import that file. Nothing was changed.';
  }
  const parts = importedSoFar.map((key) => _count(plan[key]?.toAdd?.length ?? 0, _CATEGORY_LABELS[key]));
  const total = importedSoFar.reduce((sum, key) => sum + (plan[key]?.toAdd?.length ?? 0), 0);
  const sentences = [`Import stopped part-way: ${_joinList(parts)} ${total === 1 ? 'was' : 'were'} added.`];
  if (settingsPending) sentences.push('Your settings weren\u2019t changed.');
  sentences.push('Import the same file again to finish the rest.');
  return sentences.join(' ');
}

/** Message for a parseProfileArchive() failure. */
export function profileImportErrorMessage(code) {
  switch (code) {
    case 'not-json':      return 'That file isn\u2019t a valid Ergnova profile backup.';
    case 'wrong-format':  return 'That file is a different kind of export, not an Ergnova profile backup.';
    case 'newer-version': return 'That backup was made by a newer version of Ergnova. Update the app and try again.';
    default:              return 'Nothing usable was found in that file.';
  }
}
