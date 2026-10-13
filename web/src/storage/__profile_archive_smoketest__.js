// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Full-profile export/import format: storage/profile-archive.js. Pure logic, no DOM or IndexedDB.
// Run with: node src/storage/__profile_archive_smoketest__.js

import {
  PROFILE_ARCHIVE_FORMAT, PROFILE_ARCHIVE_VERSION,
  profileArchiveFilename, buildProfileArchive, parseProfileArchive,
  planProfileImport, profileImportSummary, profileImportErrorMessage,
  TRANSIENT_PREF_KEYS, planAddCount, profileImportConfirmText,
  recipeNameKey, resolveRecipeReferences,
} from './profile-archive.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const sample = (t, power = 200) => ({ timestamp: t, power, heartRate: 140, cadence: 90, speed: null, distance: null, calories: null });
const session = (startTime, extra = {}) => ({
  id: startTime % 1000,
  startTime, endTime: startTime + 60000, duration: 60,
  samples: [sample(startTime), sample(startTime + 1000, 210)],
  laps: [], workoutName: 'Free Ride', meta: {}, summary: {},
  ...extra,
});
const diaryEntry = (loggedAt, extra = {}) => ({
  id: loggedAt % 1000, loggedAt, mealSlot: 'snack',
  source: { type: 'ingredient', id: 'seed:apple', amountG: 100, servings: null },
  nutrients: { calories: 52 },
  ...extra,
});
const bodyMeasurement = (measuredAt, extra = {}) => ({
  id: measuredAt % 1000, measuredAt, source: 'manual', weightKg: 75, bodyFatPct: null, leanBodyMassKg: null,
  ...extra,
});
const recipe = (name, extra = {}) => ({
  id: 7, name, cuisine: null, servings: 2, sourcePresetId: null,
  ingredients: [{ ingredientId: 'seed:apple', amountG: 150 }], perServing: null, steps: [],
  ...extra,
});
const ingredient = (id, name) => ({ id, name, perHundredG: { calories: 50 } });
const exercise = (id, name) => ({ id, name, category: 'fullBody', equipment: 'bodyweight', mode: 'reps', primaryMuscles: [], custom: true });
const cardioPreset = (id, label) => ({ id, label, tagline: '', durationMin: 30, custom: true, basePresetId: null, steps: [] });

console.log('filename');
check('local-date filename', profileArchiveFilename(new Date(2026, 8, 20, 12).getTime()) === 'ergnova-profile-2026-09-20.json');

console.log('export');
const built = buildProfileArchive({
  prefs: { ftp: 220, units: 'metric' },
  sessions: [session(3_000_000), session(1_000_000)],
  diaryEntries: [diaryEntry(2_000_000), diaryEntry(1_000_000)],
  bodyMeasurements: [bodyMeasurement(2_000_000)],
  ingredients: [ingredient('custom:abc', 'Homemade Granola')],
  recipes: [recipe('Chili')],
  exercises: [exercise('custom:def', 'Cossack Squat')],
  cardioPresets: [cardioPreset('custom:ghi', 'Sunday Spin')],
}, { now: Date.UTC(2026, 8, 20) });
const envelope = JSON.parse(built.json);
check('envelope carries format + version + exportedAt',
  envelope.format === PROFILE_ARCHIVE_FORMAT && envelope.version === PROFILE_ARCHIVE_VERSION && envelope.exportedAt === '2026-09-20T00:00:00.000Z');
check('counts match every category', JSON.stringify(built.counts) === JSON.stringify({
  sessions: 2, diaryEntries: 2, bodyMeasurements: 1, ingredients: 1, recipes: 1, exercises: 1, cardioPresets: 1,
}));
check('prefs travel through as-is', envelope.data.prefs.ftp === 220 && envelope.data.prefs.units === 'metric');
check('sessions are written oldest first, ids dropped',
  envelope.data.sessions.map(s => s.startTime).join() === '1000000,3000000' && envelope.data.sessions.every(s => !('id' in s)));
check('diary entries are written oldest first, ids dropped',
  envelope.data.diaryEntries.map(e => e.loggedAt).join() === '1000000,2000000' && envelope.data.diaryEntries.every(e => !('id' in e)));
check('recipes have their id dropped', !('id' in envelope.data.recipes[0]));
check('custom ingredients/exercises/cardio presets KEEP their id',
  envelope.data.ingredients[0].id === 'custom:abc' && envelope.data.exercises[0].id === 'custom:def' && envelope.data.cardioPresets[0].id === 'custom:ghi');
check('output is compact, not pretty-printed', !built.json.includes('\n'));
check('an empty profile still builds a valid file', JSON.parse(buildProfileArchive({}).json).data.sessions.length === 0);

console.log('import: round trip');
const parsed = parseProfileArchive(built.json);
check('parses what export wrote, nothing invalid',
  parsed.ok && parsed.data.sessions.length === 2 && parsed.data.diaryEntries.length === 2
  && parsed.data.bodyMeasurements.length === 1 && parsed.data.ingredients.length === 1
  && parsed.data.recipes.length === 1 && parsed.data.exercises.length === 1 && parsed.data.cardioPresets.length === 1
  && Object.values(parsed.invalid).every(n => n === 0));
check('prefs round-trip', parsed.data.prefs.ftp === 220);
check('a UTF-8 BOM in front is tolerated', parseProfileArchive('\uFEFF' + built.json).ok === true);

console.log('import: rejections');
check('garbage is "not-json"', parseProfileArchive('nope {').error === 'not-json');
check('valid JSON with no data field is "unrecognized"', parseProfileArchive('{"hello":1}').error === 'unrecognized');
check('a number is "unrecognized"', parseProfileArchive('42').error === 'unrecognized');
check('a different app\'s envelope is "wrong-format"',
  parseProfileArchive(JSON.stringify({ format: 'other', data: {} })).error === 'wrong-format');
check('a plain history export (different format) is "wrong-format"',
  parseProfileArchive(JSON.stringify({ format: 'ergnova-history', data: {} })).error === 'wrong-format');
check('a newer version is "newer-version"',
  parseProfileArchive(JSON.stringify({ format: PROFILE_ARCHIVE_FORMAT, version: 99, data: {} })).error === 'newer-version');
check('every failure code has its own message',
  new Set(['not-json', 'wrong-format', 'newer-version', 'unrecognized'].map(profileImportErrorMessage)).size === 4);

console.log('import: per-entry validation');
const mixed = parseProfileArchive(JSON.stringify({
  format: PROFILE_ARCHIVE_FORMAT, version: 1,
  data: {
    sessions: [session(5_000_000), { startTime: 'nope', samples: [] }],
    diaryEntries: [diaryEntry(5_000_000), { loggedAt: -1 }, 'x', null],
    bodyMeasurements: [bodyMeasurement(5_000_000), { measuredAt: 0 }],
    recipes: [recipe('Soup'), { name: '' }, { name: 'No ingredients array' }],
    ingredients: [ingredient('custom:x1', 'Oats'), { id: 'seed:not-custom', name: 'Bad' }, { id: 'custom:y', name: '' }],
    exercises: [exercise('custom:x2', 'Lunge'), { id: 'custom:z' }],
    cardioPresets: [cardioPreset('custom:x3', 'Hill Repeats'), { id: 'custom:w', label: '' }],
  },
}));
check('usable entries survive, unusable ones are counted', mixed.ok
  && mixed.data.sessions.length === 1 && mixed.invalid.sessions === 1
  && mixed.data.diaryEntries.length === 1 && mixed.invalid.diaryEntries === 3
  && mixed.data.bodyMeasurements.length === 1 && mixed.invalid.bodyMeasurements === 1
  && mixed.data.recipes.length === 1 && mixed.invalid.recipes === 2
  && mixed.data.ingredients.length === 1 && mixed.invalid.ingredients === 2
  && mixed.data.exercises.length === 1 && mixed.invalid.exercises === 1
  && mixed.data.cardioPresets.length === 1 && mixed.invalid.cardioPresets === 1);
check('missing lists default to empty rather than throwing',
  parseProfileArchive(JSON.stringify({ format: PROFILE_ARCHIVE_FORMAT, data: {} })).ok === true);

console.log('import: duplicate plan');
const existing = {
  sessionStartTimes: [1_000_000],
  diaryLoggedAts: [1_000_000],
  bodyMeasuredAts: [],
  ingredientIds: ['custom:abc'],
  exerciseIds: [],
  cardioPresetIds: [],
  recipeNames: ['chili'], // already normalized, matches recipe('Chili') below case-insensitively
};
const plan = planProfileImport(existing, parsed.data);
check('a session already on the device is skipped', plan.sessions.duplicates === 1 && plan.sessions.toAdd.length === 1);
check('a diary entry already on the device (same loggedAt) is skipped', plan.diaryEntries.duplicates === 1 && plan.diaryEntries.toAdd.length === 1);
check('a body measurement with no local match is added', plan.bodyMeasurements.toAdd.length === 1 && plan.bodyMeasurements.duplicates === 0);
check('a custom ingredient with a matching id is skipped', plan.ingredients.duplicates === 1 && plan.ingredients.toAdd.length === 0);
check('a recipe matching an existing name (case-insensitive) is skipped', plan.recipes.duplicates === 1 && plan.recipes.toAdd.length === 0);
check('a recipe with no local match is added', planProfileImport({ recipeNames: ['something else'] }, parsed.data).recipes.toAdd.length === 1);
check('missing existing-data fields default to empty', planProfileImport({}, parsed.data).sessions.toAdd.length === parsed.data.sessions.length);

console.log('messages');
const emptyPlan = { sessions: { toAdd: [], duplicates: 0 }, diaryEntries: { toAdd: [], duplicates: 0 }, bodyMeasurements: { toAdd: [], duplicates: 0 }, ingredients: { toAdd: [], duplicates: 0 }, recipes: { toAdd: [], duplicates: 0 }, exercises: { toAdd: [], duplicates: 0 }, cardioPresets: { toAdd: [], duplicates: 0 } };
check('nothing to import', profileImportSummary(emptyPlan) === 'Nothing new to import.');
check('a single category', profileImportSummary({
  ...emptyPlan, sessions: { toAdd: [1], duplicates: 0 },
}) === 'Imported 1 workout.');
check('two categories joined with "and"', profileImportSummary({
  ...emptyPlan, sessions: { toAdd: [1, 2], duplicates: 0 }, recipes: { toAdd: [1], duplicates: 0 },
}) === 'Imported 2 workouts and 1 recipe.');
check('three+ categories use an Oxford comma', profileImportSummary({
  ...emptyPlan,
  sessions: { toAdd: [1], duplicates: 0 }, diaryEntries: { toAdd: [1, 2], duplicates: 0 }, recipes: { toAdd: [1], duplicates: 0 },
}) === 'Imported 1 workout, 2 diet entries, and 1 recipe.');
check('duplicates are summed across categories', profileImportSummary({
  ...emptyPlan, sessions: { toAdd: [1], duplicates: 2 }, recipes: { toAdd: [], duplicates: 3 },
}) === 'Imported 1 workout. 5 items already on this device were skipped.');
check('invalid entries are summed across categories', profileImportSummary(emptyPlan, {
  invalid: { sessions: 1, diaryEntries: 2, bodyMeasurements: 0, ingredients: 0, recipes: 0, exercises: 0, cardioPresets: 0 },
}) === 'Nothing new to import. 3 entries couldn\u2019t be read.');
check('prefsRestored appends its own sentence', profileImportSummary(emptyPlan, { prefsRestored: true })
  === 'Nothing new to import. Settings restored.');
check('everything together, in order', profileImportSummary({
  ...emptyPlan, sessions: { toAdd: [1], duplicates: 1 },
}, { prefsRestored: true, invalid: { sessions: 1 } })
  === 'Imported 1 workout. Settings restored. 1 item already on this device was skipped. 1 entry couldn\u2019t be read.');

console.log('settings snapshot: runtime state never travels');
const crashSnapshot = { savedAt: 1, samples: [sample(1), sample(2)] }; // stand-in for a session-persistence.js snapshot
const withTransient = buildProfileArchive({
  prefs: { ftp: 250, units: 'imperial', activeWorkout: crashSnapshot, activeStrengthWorkout: null, weeklyStrengthSchedule: { 1: 'legs' } },
});
const exportedPrefs = JSON.parse(withTransient.json).data.prefs;
check('TRANSIENT_PREF_KEYS names the two crash-recovery snapshots',
  TRANSIENT_PREF_KEYS.length === 2 && TRANSIENT_PREF_KEYS.includes('activeWorkout') && TRANSIENT_PREF_KEYS.includes('activeStrengthWorkout'));
check('export leaves out the crash-recovery snapshots, even the null one',
  !('activeWorkout' in exportedPrefs) && !('activeStrengthWorkout' in exportedPrefs));
check('export keeps every real setting, including ones it has never heard of',
  exportedPrefs.ftp === 250 && exportedPrefs.units === 'imperial' && exportedPrefs.weeklyStrengthSchedule[1] === 'legs');
check('the export file does not contain the snapshot\'s samples at all', !withTransient.json.includes('"samples"'));
const foreign = parseProfileArchive(JSON.stringify({
  format: PROFILE_ARCHIVE_FORMAT, version: 1,
  data: { prefs: { ftp: 250, activeWorkout: crashSnapshot, activeStrengthWorkout: null } },
}));
check('import ignores crash-recovery keys in a file (even null, which would erase a real snapshot)',
  foreign.ok && !('activeWorkout' in foreign.data.prefs) && !('activeStrengthWorkout' in foreign.data.prefs) && foreign.data.prefs.ftp === 250);
check('...and does not count them as unreadable', foreign.invalid.prefs === 0);

console.log('settings snapshot: validation');
const prefsIn = (prefs) => parseProfileArchive(JSON.stringify({ format: PROFILE_ARCHIVE_FORMAT, version: 1, data: { prefs } }));
const goodInput = {
  ftp: 240, riderWeight: 72.5, chartWindow: 300, units: 'metric', sex: null, age: 41, heightCm: 178,
  bodyFatPct: null, audioCues: true, autoPause: false, backgroundNotification: true,
  autoPauseTriggers: { idle: true }, autoPauseModes: {}, autoPauseControllers: {}, enabledTargetTypes: ['power'],
  ftpTestDate: '2026-09-01', ftpTestLabel: null, vo2Max: 48.2,
};
const good = prefsIn(goodInput);
check('a normal settings snapshot passes untouched',
  good.ok && good.invalid.prefs === 0 && JSON.stringify(good.data.prefs) === JSON.stringify(goodInput));
// Saving the profile with FTP and weight left blank stores null for both (nothing is filled
// in for the rider), and that snapshot has to come back in as-is, not as "couldn't be read".
const blankProfile = prefsIn({ ftp: null, riderWeight: null, units: 'metric' });
check('a snapshot with FTP and weight not entered (null) is valid',
  blankProfile.ok && blankProfile.invalid.prefs === 0 && blankProfile.data.prefs.ftp === null && blankProfile.data.prefs.riderWeight === null);
const bad = prefsIn({
  ftp: 'abc',            // wrong type
  riderWeight: 0,        // must be positive
  units: 'furlongs',     // not an allowed value
  sex: 'other',          // not an allowed value
  audioCues: 'yes',      // must be boolean
  autoPauseTriggers: [], // must be an object
  enabledTargetTypes: 'power', // must be an array
  age: NaN, // JSON turns NaN into null, so this one is actually fine
  chartWindow: 600,      // fine
});
check('known settings with the wrong type or value are dropped and counted',
  bad.ok && bad.invalid.prefs === 7 && !('ftp' in bad.data.prefs) && !('units' in bad.data.prefs)
  && !('riderWeight' in bad.data.prefs) && !('enabledTargetTypes' in bad.data.prefs));
check('the valid settings in the same file survive', bad.data.prefs.chartWindow === 600 && bad.data.prefs.age === null);
check('a setting this version has never heard of passes through', prefsIn({ someFutureSetting: { a: 1 } }).data.prefs.someFutureSetting.a === 1);
check('a non-object prefs field becomes an empty snapshot, not an error',
  prefsIn('nope').ok && Object.keys(prefsIn('nope').data.prefs).length === 0 && prefsIn(['x']).invalid.prefs === 0);
check('bad settings feed the "couldn\u2019t be read" total',
  profileImportSummary(emptyPlan0(), { invalid: bad.invalid }) === 'Nothing new to import. 7 entries couldn\u2019t be read.');

console.log('import confirmation');
function emptyPlan0() {
  return { sessions: { toAdd: [], duplicates: 0 }, diaryEntries: { toAdd: [], duplicates: 0 }, bodyMeasurements: { toAdd: [], duplicates: 0 }, ingredients: { toAdd: [], duplicates: 0 }, recipes: { toAdd: [], duplicates: 0 }, exercises: { toAdd: [], duplicates: 0 }, cardioPresets: { toAdd: [], duplicates: 0 } };
}
check('planAddCount sums toAdd across every category', planAddCount({
  ...emptyPlan0(), sessions: { toAdd: [1, 2], duplicates: 9 }, bodyMeasurements: { toAdd: [1], duplicates: 0 }, recipes: { toAdd: [1], duplicates: 0 },
}) === 4 && planAddCount(emptyPlan0()) === 0);
const confirmText = profileImportConfirmText({
  ...emptyPlan0(), sessions: { toAdd: [1, 2, 3], duplicates: 0 }, bodyMeasurements: { toAdd: [1], duplicates: 0 },
}, { replacesSettings: true });
check('confirm text lists what is added and that settings are replaced',
  confirmText.startsWith('Import this backup?')
  && confirmText.includes('\u2022 Add 3 workouts and 1 weigh-in')
  && confirmText.includes('\u2022 Replace your current settings with the ones in this file'));
check('confirm text makes clear existing data is kept', /already on this device is kept/.test(confirmText));
check('settings line is left out when the file carries none',
  !profileImportConfirmText({ ...emptyPlan0(), sessions: { toAdd: [1], duplicates: 0 } }).includes('Replace your current settings'));
check('with nothing to add, only the settings line remains',
  profileImportConfirmText(emptyPlan0(), { replacesSettings: true }).split('\n').filter(l => l.startsWith('\u2022')).length === 1);

console.log('own-recipe references in diary entries');
const recipeEntry = (loggedAt, sourceExtra = {}) => diaryEntry(loggedAt, { source: { type: 'recipe', id: 7, servings: 1, ...sourceExtra } });
const ownRecipeDevice = { diaryEntries: [recipeEntry(5_000_000)], recipes: [recipe('Chili')] }; // recipe() has id 7
const recipeFile = JSON.parse(buildProfileArchive(ownRecipeDevice).json).data;
check('export swaps the device-local recipe id for the recipe name',
  recipeFile.diaryEntries[0].source.recipeName === 'Chili' && !('id' in recipeFile.diaryEntries[0].source));
check('export keeps the rest of the entry source', recipeFile.diaryEntries[0].source.servings === 1 && recipeFile.diaryEntries[0].source.type === 'recipe');
const seedRefs = JSON.parse(buildProfileArchive({
  diaryEntries: [diaryEntry(1_000, { source: { type: 'recipe', id: 'preset:chili', servings: 2 } }), diaryEntry(2_000)],
  recipes: [recipe('Chili')],
}).json).data.diaryEntries;
check('a string id (bundled preset / seed ingredient) is left exactly as it is',
  seedRefs[0].source.id === 'preset:chili' && !('recipeName' in seedRefs[0].source) && seedRefs[1].source.id === 'seed:apple');
const orphan = JSON.parse(buildProfileArchive({ diaryEntries: [recipeEntry(3_000)], recipes: [] }).json).data.diaryEntries[0];
check('a numeric id matching no recipe is dropped rather than exported as a dangling number',
  !('id' in orphan.source) && !('recipeName' in orphan.source));
const srcEntries = [recipeEntry(4_000)];
buildProfileArchive({ diaryEntries: srcEntries, recipes: [recipe('Chili')] });
check('export does not mutate what it was given', srcEntries[0].source.id === 7 && !('recipeName' in srcEntries[0].source));

const recipeParsed = parseProfileArchive(JSON.stringify({ format: PROFILE_ARCHIVE_FORMAT, version: 1, data: {
  diaryEntries: [
    { loggedAt: 1_000, source: { type: 'recipe', recipeName: 'Chili', servings: 1 } },
    { loggedAt: 2_000, source: { type: 'recipe', id: 7, servings: 1 } },              // numeric id from some other device
    { loggedAt: 3_000, source: { type: 'recipe', id: 9, recipeName: 'Soup' } },
    { loggedAt: 4_000, source: { type: 'ingredient', id: 'custom:abc', amountG: 50 } },
  ],
  recipes: [recipe('Chili')],
} }));
check('import keeps recipeName', recipeParsed.data.diaryEntries[0].source.recipeName === 'Chili');
check('import never trusts a numeric source.id from a file',
  recipeParsed.data.diaryEntries[1].source.id === null && recipeParsed.data.diaryEntries[2].source.id === null);
check('a string ingredient id passes through import untouched', recipeParsed.data.diaryEntries[3].source.id === 'custom:abc');

check('recipeNameKey trims and lowercases', recipeNameKey('  Chili Con Carne ') === 'chili con carne' && recipeNameKey(null) === '');
const idByName = new Map([['chili', 42]]);
const resolved = resolveRecipeReferences([
  { loggedAt: 1, source: { type: 'recipe', recipeName: ' CHILI ', servings: 2 } },
  { loggedAt: 2, source: { type: 'recipe', recipeName: 'Nonexistent' } },
  { loggedAt: 3, source: { type: 'ingredient', id: 'seed:apple' } },
  { loggedAt: 4, source: null },
  { loggedAt: 5 },
], idByName);
check('a recipeName resolves to the local id (name match is trim + case-insensitive)', resolved[0].source.id === 42 && resolved[0].source.servings === 2);
check('the recipeName is consumed once resolved', !('recipeName' in resolved[0].source));
check('an unknown recipe name leaves source.id null', resolved[1].source.id === null && !('recipeName' in resolved[1].source));
check('entries with no recipeName come back unchanged',
  resolved[2].source.id === 'seed:apple' && resolved[3].source === null && !('source' in resolved[4]));
const inputEntries = [{ loggedAt: 1, source: { type: 'recipe', recipeName: 'Chili' } }];
resolveRecipeReferences(inputEntries, idByName);
check('resolve does not mutate its input', inputEntries[0].source.recipeName === 'Chili' && !('id' in inputEntries[0].source));

// The bug this exists for: device A's recipe #7 is "Chili"; device B's #7 is a different recipe.
const onDeviceB = new Map([['soup', 7], ['chili', 8]]); // "Chili" arrived as a new recipe and got id 8
const roundTrip = parseProfileArchive(buildProfileArchive(ownRecipeDevice).json);
check('round trip: the entry follows its recipe, not the number 7 that now belongs to a different recipe',
  resolveRecipeReferences(roundTrip.data.diaryEntries, onDeviceB)[0].source.id === 8);


if (failures) {
  console.log(`\n${failures} profile archive check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll profile archive checks passed.');
