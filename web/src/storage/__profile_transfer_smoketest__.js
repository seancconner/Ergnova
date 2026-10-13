// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Export -> import orchestration: storage/profile-transfer.js, against an in-memory stand-in for
// storage/db.js (no IndexedDB, no DOM). Run with: node src/storage/__profile_transfer_smoketest__.js
//
// The stand-in (./__fake_db__.js, shared with __profile_backup_flow_smoketest__.js) mirrors the parts
// of db.js the transfer module leans on:
//   - sessions / diary / body measurements / recipes are autoIncrement stores: a bulk add gets fresh ids,
//     and a record that already carries an `id` is refused (db.js's docs say records "must not carry an id")
//   - custom ingredients / exercises / cardio presets are keyed by their own `custom:` id: a repeat id is refused
//   - every bulk add is all-or-nothing (validated before anything is written), like the real single transaction
//   - `failOn` makes one named method throw, to exercise the "part-way failure" path

import {
  exportProfile, prepareProfileImport, applyProfileImport, readExistingKeys,
} from './profile-transfer.js';
import { profileArchiveFilename } from './profile-archive.js';
import { makeDb } from './__fake_db__.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const sample = (t) => ({ timestamp: t, power: 200, heartRate: 140, cadence: 90, speed: null, distance: null, calories: null });
const session = (startTime) => ({ startTime, endTime: startTime + 60000, duration: 60, samples: [sample(startTime)], laps: [], workoutName: 'Free Ride', meta: {}, summary: {} });
const ingredientEntry = (loggedAt) => ({ loggedAt, mealSlot: 'snack', source: { type: 'ingredient', id: 'custom:granola', amountG: 40, servings: null }, nutrients: { calories: 180 } });
const recipeEntry = (loggedAt, recipeId) => ({ loggedAt, mealSlot: 'dinner', source: { type: 'recipe', id: recipeId, servings: 1 }, nutrients: { calories: 520 } });
const weighIn = (measuredAt, kg) => ({ measuredAt, source: 'manual', weightKg: kg, bodyFatPct: null, leanBodyMassKg: null });
const recipe = (name, id) => ({ ...(id == null ? {} : { id }), name, cuisine: null, servings: 2, sourcePresetId: null, ingredients: [{ ingredientId: 'custom:granola', amountG: 150 }], perServing: null, steps: [] });

// Device A: a rider's phone, with a recipe that has a low local id and a diary entry pointing at it.
const deviceA = () => makeDb({
  prefs: { ftp: 230, units: 'imperial', chartWindow: 600, activeWorkout: { samples: [1, 2, 3] }, futureSetting: { a: 1 } },
  sessions: [session(1_000_000), session(3_000_000)],
  diary: [ingredientEntry(1_500_000), recipeEntry(2_500_000, 1), recipeEntry(2_600_000, 2)],
  body: [weighIn(1_100_000, 82.4), weighIn(3_100_000, 81.9)],
  ingredients: [{ id: 'custom:granola', name: 'Homemade Granola', perHundredG: { calories: 450 } }],
  recipes: [recipe('Chili', 1), recipe('Overnight Oats', 2)],
  exercises: [{ id: 'custom:cossack', name: 'Cossack Squat', category: 'fullBody', equipment: 'bodyweight', mode: 'reps', primaryMuscles: [], custom: true }],
  cardio: [{ id: 'custom:sunday', label: 'Sunday Spin', tagline: '', durationMin: 30, custom: true, basePresetId: null, steps: [] }],
});

const NOW = Date.UTC(2026, 8, 20, 12);
const counts = (db) => ({
  sessions: db.auto.sessions.length, diary: db.auto.diary.length, body: db.auto.body.length, recipes: db.auto.recipes.length,
  ingredients: db.own.ingredients.size, exercises: db.own.exercises.size, cardio: db.own.cardio.size,
});

async function importFile(db, json, opts = {}) {
  const prep = await prepareProfileImport(db, json);
  if (!prep.ok) return { prep };
  const applied = await applyProfileImport(db, prep.plan, { prefs: prep.parsed.data.prefs, restoreSettings: opts.restoreSettings ?? false });
  return { prep, applied };
}

// ─── Export ─────────────────────────────────────────────────────────────────

console.log('export');
const a = deviceA();
const exported = await exportProfile(a, { now: NOW });
const env = JSON.parse(exported.json);
check('export reads this device into the archive shape', exported.counts.sessions === 2 && exported.counts.diaryEntries === 3
  && exported.counts.bodyMeasurements === 2 && exported.counts.recipes === 2 && exported.counts.ingredients === 1
  && exported.counts.exercises === 1 && exported.counts.cardioPresets === 1);
check('export filename uses the supplied clock', exported.filename === profileArchiveFilename(NOW));
check('export carries the settings snapshot but not the crash-recovery key',
  env.data.prefs.ftp === 230 && env.data.prefs.futureSetting.a === 1 && !('activeWorkout' in env.data.prefs));
check('export names the recipe in each own-recipe diary entry',
  env.data.diaryEntries.filter((e) => e.source.recipeName).map((e) => e.source.recipeName).join() === 'Chili,Overnight Oats');
check('export leaves the ingredient entry\u2019s string id alone', env.data.diaryEntries[0].source.id === 'custom:granola');
check('no numeric device-local id survives anywhere in the diary', env.data.diaryEntries.every((e) => typeof e.source.id !== 'number'));
check('exporting changes nothing on the device', counts(a).sessions === 2 && a.state.prefs.activeWorkout.samples.length === 3);

// ─── Round trip onto an empty device ────────────────────────────────────────

console.log('round trip onto an empty device');
const b = makeDb();
const first = await importFile(b, exported.json, { restoreSettings: true });
check('the file is accepted, with a settings snapshot to apply', first.prep.ok && first.prep.hasSettings);
check('every record lands', JSON.stringify(counts(b)) === JSON.stringify({ sessions: 2, diary: 3, body: 2, recipes: 2, ingredients: 1, exercises: 1, cardio: 1 }));
check('the plan counts what it will add', first.prep.addCount === 12);
check('settings are restored', first.applied.prefsRestored === true && b.state.prefs.ftp === 230 && b.state.prefs.units === 'imperial');
check('a runtime crash-recovery snapshot never arrives', !('activeWorkout' in b.state.prefs));
check('ids were assigned by the receiving device, not carried in', b.auto.sessions.every((s) => Number.isInteger(s.id)) && b.auto.sessions[0].id === 1);
const localIdOf = (dev, name) => dev.auto.recipes.find((r) => r.name === name).id;
const chiliEntry = b.auto.diary.find((e) => e.loggedAt === 2_500_000);
const oatsEntry = b.auto.diary.find((e) => e.loggedAt === 2_600_000);
check('recipe diary entries point at the recipes they logged',
  chiliEntry.source.id === localIdOf(b, 'Chili') && oatsEntry.source.id === localIdOf(b, 'Overnight Oats'));
check('no recipeName is left behind once resolved', !('recipeName' in chiliEntry.source));
check('the ingredient entry still points at its custom ingredient', b.auto.diary.find((e) => e.loggedAt === 1_500_000).source.id === 'custom:granola');
check('saved nutrients on the entries are untouched', chiliEntry.nutrients.calories === 520);

// ─── The dangling-reference bug ─────────────────────────────────────────────

console.log('recipe ids differ between devices');
const c = makeDb({ recipes: [recipe('Lentil Soup', 1), recipe('Pancakes', 2), recipe('Curry', 3)] }); // ids 1..3 already taken, by other recipes
await importFile(c, exported.json);
const chiliOnC = localIdOf(c, 'Chili');
check('imported recipes got fresh ids past the local ones', chiliOnC > 3 && localIdOf(c, 'Overnight Oats') > 3);
check('the entry follows its recipe, not the number it had on the other device (was id 1 = Lentil Soup here)',
  c.auto.diary.find((e) => e.loggedAt === 2_500_000).source.id === chiliOnC);
check('local recipes are untouched', c.auto.recipes.slice(0, 3).map((r) => r.name).join() === 'Lentil Soup,Pancakes,Curry');

console.log('same-named recipe already on the device');
const d = makeDb({ recipes: [recipe('  chili ', 5)] });
const dImport = await importFile(d, exported.json);
check('the local recipe wins and the imported one is skipped', dImport.prep.plan.recipes.duplicates === 1 && d.auto.recipes.filter((r) => /chili/i.test(r.name)).length === 1);
check('the entry is pointed at the local same-named recipe', d.auto.diary.find((e) => e.loggedAt === 2_500_000).source.id === 5);

console.log('a recipe missing from both the file and the device');
const orphanFile = JSON.stringify({ format: 'ergnova-profile', version: 1, data: { diaryEntries: [{ loggedAt: 9_000, source: { type: 'recipe', recipeName: 'Gone', servings: 1 }, nutrients: { calories: 300 } }] } });
const e = makeDb();
await importFile(e, orphanFile);
check('the entry is kept, unlinked (id null), nutrients intact',
  e.auto.diary.length === 1 && e.auto.diary[0].source.id === null && e.auto.diary[0].nutrients.calories === 300);

// ─── Re-import, preview, refusals ───────────────────────────────────────────

console.log('re-importing the same file');
const before = counts(b);
const second = await importFile(b, exported.json, { restoreSettings: true });
check('nothing new is planned', second.prep.addCount === 0 && JSON.stringify(counts(b)) === JSON.stringify(before));
check('everything is reported as already present', second.prep.plan.sessions.duplicates === 2 && second.prep.plan.diaryEntries.duplicates === 3
  && second.prep.plan.recipes.duplicates === 2 && second.prep.plan.bodyMeasurements.duplicates === 2);

console.log('preview and refusals');
const g = makeDb();
const writesBefore = g.state.calls.length;
const preview = await prepareProfileImport(g, exported.json);
check('preparing an import writes nothing', g.state.calls.slice(writesBefore).every((m) => /^get/.test(m)) && counts(g).sessions === 0);
check('a file with no settings snapshot says so', (await prepareProfileImport(g, orphanFile)).hasSettings === false);
check('unparseable text is refused with a code', (await prepareProfileImport(g, 'not json')).error === 'not-json');
check('another kind of export is refused with a code', (await prepareProfileImport(g, JSON.stringify({ format: 'ergnova-history', data: {} }))).error === 'wrong-format');
check('a newer file is refused with a code', (await prepareProfileImport(g, JSON.stringify({ format: 'ergnova-profile', version: 99, data: {} }))).error === 'newer-version');
const keys = await readExistingKeys(b);
check('existing keys come out the way the planner dedups', keys.recipeNames.includes('chili') && keys.sessionStartTimes.length === 2 && keys.ingredientIds[0] === 'custom:granola');

// ─── Settings ───────────────────────────────────────────────────────────────

console.log('settings');
const h = makeDb({ prefs: { ftp: 150, units: 'metric', activeWorkout: { samples: [9] }, onlyHere: true } });
await importFile(h, exported.json, { restoreSettings: false });
check('settings are left alone unless asked', h.state.prefs.ftp === 150 && !h.state.calls.includes('setPrefs'));
await importFile(h, exported.json, { restoreSettings: true });
check('asked to, the snapshot replaces matching settings', h.state.prefs.ftp === 230 && h.state.prefs.units === 'imperial');
check('a real crash-recovery snapshot already on this device survives a restore', h.state.prefs.activeWorkout.samples[0] === 9);
check('settings only in the local store are not deleted', h.state.prefs.onlyHere === true);

// ─── Order ──────────────────────────────────────────────────────────────────

console.log('write order');
const i = makeDb();
await importFile(i, exported.json, { restoreSettings: true });
const writes = i.state.calls.filter((m) => /^(add|setPrefs)/.test(m));
check('categories are written in the documented order, settings last',
  writes.join() === 'addSessions,addCustomIngredients,addRecipes,addDiaryEntries,addBodyMeasurements,addCustomExercises,addCustomCardioPresets,setPrefs');
const lastAddRecipes = i.state.calls.indexOf('addRecipes');
const recipeReadForDiary = i.state.calls.indexOf('getRecipes', lastAddRecipes);
check('recipes are re-read after they are added and before the diary is written',
  recipeReadForDiary > lastAddRecipes && recipeReadForDiary < i.state.calls.indexOf('addDiaryEntries'));

// ─── Failure part-way ───────────────────────────────────────────────────────

console.log('a failure part-way through');
const j = makeDb();
j.state.failOn = 'addCustomExercises';
const jPrep = await prepareProfileImport(j, exported.json);
let thrown = null;
try { await applyProfileImport(j, jPrep.plan, { prefs: jPrep.parsed.data.prefs, restoreSettings: true }); } catch (err) { thrown = err; }
check('it throws, and says which categories had already landed',
  thrown && /injected failure/.test(thrown.message)
  && thrown.importedSoFar.join() === 'sessions,ingredients,recipes,diaryEntries,bodyMeasurements');
check('the categories before the failure are in', counts(j).sessions === 2 && counts(j).diary === 3 && counts(j).body === 2);
check('the failed category and the ones after it are not', counts(j).exercises === 0 && counts(j).cardio === 0);
check('settings were NOT replaced, since something before them failed', !('ftp' in j.state.prefs) && !j.state.calls.includes('setPrefs'));
j.state.failOn = null;
const retry = await importFile(j, exported.json, { restoreSettings: true });
check('retrying the same file adds only what is missing', retry.prep.plan.exercises.toAdd.length === 1 && retry.prep.plan.cardioPresets.toAdd.length === 1
  && retry.prep.plan.sessions.toAdd.length === 0 && retry.prep.plan.diaryEntries.toAdd.length === 0);
check('after the retry the device matches a clean import, with no duplicates',
  JSON.stringify(counts(j)) === JSON.stringify(counts(b)) && retry.applied.prefsRestored && j.state.prefs.ftp === 230);
check('the diary entries written before the failure are still linked to the right recipes',
  j.auto.diary.find((x) => x.loggedAt === 2_500_000).source.id === localIdOf(j, 'Chili'));

const k = makeDb();
k.state.failOn = 'addSessions';
const kPrep = await prepareProfileImport(k, exported.json);
let kErr = null;
try { await applyProfileImport(k, kPrep.plan, { prefs: kPrep.parsed.data.prefs, restoreSettings: true }); } catch (err) { kErr = err; }
check('a failure on the very first write reports nothing imported and changes nothing', kErr.importedSoFar.length === 0 && JSON.stringify(counts(k)) === JSON.stringify(counts(makeDb())));

console.log('categories with nothing to add are skipped');
const l = makeDb();
await importFile(l, JSON.stringify({ format: 'ergnova-profile', version: 1, data: { bodyMeasurements: [weighIn(5_000, 70)] } }));
check('only the one category is written', l.state.calls.filter((m) => /^add/.test(m)).join() === 'addBodyMeasurements');

if (failures) {
  console.log(`\n${failures} profile transfer check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll profile transfer checks passed.');
