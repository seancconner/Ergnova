// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// The Backup & Restore button flows: storage/profile-backup-flow.js, with every page hook faked and the
// database replaced by the shared in-memory stand-in (./__fake_db__.js). No DOM, no IndexedDB.
// Run with: node src/storage/__profile_backup_flow_smoketest__.js

import { createProfileBackupFlow, WORKOUT_BLOCKS_IMPORT_MESSAGE } from './profile-backup-flow.js';
import { exportProfile } from './profile-transfer.js';
import { buildProfileArchive } from './profile-archive.js';
import { makeDb } from './__fake_db__.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

// The flow logs the failures it reports (console.error) — expected here, so keep the test output readable.
async function quiet(fn) {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 8, 20, 12);
const sample = (t) => ({ timestamp: t, power: 200, heartRate: 140, cadence: 90, speed: null, distance: null, calories: null });
const session = (startTime) => ({ startTime, endTime: startTime + 60000, duration: 60, samples: [sample(startTime)], laps: [], workoutName: 'Free Ride', meta: {}, summary: {} });
const weighIn = (measuredAt, kg) => ({ measuredAt, source: 'manual', weightKg: kg, bodyFatPct: null, leanBodyMassKg: null });
const recipe = (name, id) => ({ id, name, cuisine: null, servings: 2, sourcePresetId: null, ingredients: [], perServing: null, steps: [] });
const recipeEntry = (loggedAt, recipeId) => ({ loggedAt, mealSlot: 'dinner', source: { type: 'recipe', id: recipeId, servings: 1 }, nutrients: { calories: 520 } });

const rider = () => makeDb({
  prefs: { ftp: 230, units: 'imperial', activeWorkout: { samples: [1, 2, 3] } },
  sessions: [session(1_000_000), session(3_000_000)],
  diary: [recipeEntry(2_500_000, 1)],
  body: [weighIn(1_100_000, 82.4), weighIn(3_100_000, 81.9)],
  recipes: [recipe('Chili', 1)],
  ingredients: [{ id: 'custom:granola', name: 'Homemade Granola', perHundredG: { calories: 450 } }],
});

/** A flow wired to recording fakes. `over` tweaks individual hooks. */
function harness(db, over = {}) {
  const h = { events: [], statuses: [], busy: [], saved: [], confirms: [], refreshes: [] };
  h.flow = createProfileBackupFlow({
    db,
    saveFile: async (filename, blob) => { h.events.push('save'); h.saved.push({ filename, blob }); return over.saveResult ?? true; },
    pickTextFile: async () => { h.events.push('pick'); if (over.pickThrows) throw new Error('unreadable'); return over.picked ?? null; },
    confirm: (text) => { h.events.push('confirm'); h.confirms.push(text); return over.confirm ?? true; },
    isWorkoutRunning: over.isWorkoutRunning ?? (() => false),
    setStatus: (text, opts) => { h.events.push('status'); h.statuses.push({ text, error: !!opts?.error }); },
    setBusy: (b) => { h.events.push(b ? 'busy' : 'idle'); h.busy.push(b); },
    refreshAfterImport: async (info) => {
      h.events.push('refresh'); h.refreshes.push(info);
      if (over.refreshThrows) throw new Error('view blew up');
    },
    now: NOW,
  });
  h.last = () => h.statuses[h.statuses.length - 1];
  return h;
}
const total = (db) => db.auto.sessions.length + db.auto.diary.length + db.auto.body.length + db.auto.recipes.length + db.own.ingredients.size;
const writes = (db) => db.state.calls.filter((m) => /^(add|set)/.test(m));

// A backup file made from `rider()`, as the Export button would write it.
const backupText = async () => (await exportProfile(rider(), { now: NOW })).json;

// ─── Export ─────────────────────────────────────────────────────────────────

console.log('export');
{
  const h = harness(rider());
  const outcome = await h.flow.exportBackup();
  const text = await h.saved[0].blob.text();
  const file = JSON.parse(text);
  check('a normal export saves one file and reports exported', outcome === 'exported' && h.saved.length === 1);
  check('the file is named for the day', h.saved[0].filename === 'ergnova-profile-2026-09-20.json');
  check('it is a JSON blob', h.saved[0].blob.type === 'application/json');
  check('it carries the whole rider: workouts, diary, weigh-ins, recipes, ingredients',
    file.counts.sessions === 2 && file.counts.diaryEntries === 1 && file.counts.bodyMeasurements === 2 && file.counts.recipes === 1 && file.counts.ingredients === 1);
  check('and a settings snapshot, without the crash-recovery key', file.data.prefs.ftp === 230 && !('activeWorkout' in file.data.prefs));
  check('the status line says what was exported', h.last().text === 'Exported 2 workouts, 1 diet entry, 2 weigh-ins, 1 ingredient, 1 recipe, and your settings.' && !h.last().error);
  check('the buttons are locked while it runs and freed after', h.busy.join() === 'true,false');
}
{
  const h = harness(rider(), { saveResult: false });
  check('a cancelled save is reported, and is not an error', (await h.flow.exportBackup()) === 'not-saved' && h.last().text === 'The export wasn\u2019t saved.' && !h.last().error);
}
{
  const h = harness(makeDb());
  check('an empty device writes no file', (await h.flow.exportBackup()) === 'nothing-to-export' && h.saved.length === 0 && h.last().text === 'Nothing to export yet.');
}
{
  const h = harness(makeDb({ prefs: { ftp: 200 } }));
  check('settings alone are worth exporting', (await h.flow.exportBackup()) === 'exported' && h.last().text === 'Exported your settings.');
}
{
  const db = rider();
  db.state.failOn = 'getDiaryEntries';
  const h = harness(db);
  const outcome = await quiet(() => h.flow.exportBackup());
  check('a database failure is reported as an error and frees the buttons',
    outcome === 'failed' && h.last().error && h.saved.length === 0 && h.busy[h.busy.length - 1] === false);
}
{
  const h = harness(rider());
  const [first, second] = await Promise.all([h.flow.exportBackup(), h.flow.exportBackup()]);
  check('a second tap while the first is running is ignored', first === 'exported' && second === 'busy' && h.saved.length === 1);
}

// ─── Import: refusals before anything is touched ────────────────────────────

console.log('import: refusals');
{
  const db = makeDb();
  const h = harness(db, { picked: { name: 'b.json', text: await backupText() }, isWorkoutRunning: () => true });
  check('refused while a workout is running', (await h.flow.importBackup()) === 'blocked');
  check('...before the picker even opens', !h.events.includes('pick'));
  check('...with the reason, as an error', h.last().text === WORKOUT_BLOCKS_IMPORT_MESSAGE && h.last().error);
  check('...and nothing written', writes(db).length === 0);
}
{
  const h = harness(makeDb(), { picked: null });
  check('cancelling the picker does nothing at all', (await h.flow.importBackup()) === 'cancelled' && h.statuses.length === 0 && h.busy.length === 0);
}
{
  const h = harness(makeDb(), { pickThrows: true });
  check('a file that cannot be read is reported', (await quiet(() => h.flow.importBackup())) === 'unreadable' && h.last().error);
}
{
  const db = makeDb();
  const h = harness(db, { picked: { name: 'x.json', text: 'this is not json' } });
  check('a file that is not a backup is refused with a message', (await h.flow.importBackup()) === 'refused' && h.last().error && /valid Ergnova profile backup/.test(h.last().text));
  check('...without asking to confirm, and without writing', !h.events.includes('confirm') && writes(db).length === 0);
  check('...and the buttons are freed', h.busy.join() === 'true,false');
}
{
  const db = makeDb();
  const h = harness(db, { picked: { name: 'n.json', text: JSON.stringify({ format: 'ergnova-profile', version: 99, data: {} }) } });
  check('a backup from a newer app is refused with the update advice', (await h.flow.importBackup()) === 'refused' && /newer version/.test(h.last().text));
}
{
  // Everything in this file is already on the device, and the file carries no settings.
  const db = rider();
  const noSettings = buildProfileArchive({ sessions: await db.getSessions(), bodyMeasurements: await db.getBodyMeasurements() }, { now: NOW }).json;
  const h = harness(db, { picked: { name: 'same.json', text: noSettings } });
  const before = total(db);
  check('a file with nothing new and no settings just says so', (await h.flow.importBackup()) === 'nothing-new' && /Nothing new to import/.test(h.last().text));
  check('...no confirmation, no writes', !h.events.includes('confirm') && total(db) === before && writes(db).length === 0);
}

// ─── Import: confirmation ───────────────────────────────────────────────────

console.log('import: confirmation');
{
  const db = makeDb({ prefs: { ftp: 150 } });
  const h = harness(db, { picked: { name: 'b.json', text: await backupText() }, confirm: false });
  check('declining the confirmation changes nothing', (await h.flow.importBackup()) === 'declined' && writes(db).length === 0 && total(db) === 0 && db.state.prefs.ftp === 150);
  check('...and clears the status line', h.last().text === '');
  check('the confirmation says what is added and that settings are replaced',
    /Add 2 workouts/.test(h.confirms[0]) && /Replace your current settings/.test(h.confirms[0]));
  check('exactly one confirmation is asked for', h.confirms.length === 1);
}
{
  // A workout starts while the confirmation (or the native picker) sat open.
  const db = makeDb();
  let asked = 0;
  const h = harness(db, { picked: { name: 'b.json', text: await backupText() }, isWorkoutRunning: () => ++asked > 1 });
  check('a workout that starts while the confirmation is open blocks the write', (await h.flow.importBackup()) === 'blocked');
  check('...it was checked before the picker and again before writing', asked === 2);
  check('...nothing was written', writes(db).length === 0 && total(db) === 0);
}

// ─── Import: success ────────────────────────────────────────────────────────

console.log('import: success');
{
  const db = makeDb({ prefs: { ftp: 150, chartWindow: 300, deviceOnlySetting: true } });
  const h = harness(db, { picked: { name: 'b.json', text: await backupText() } });
  const outcome = await h.flow.importBackup();
  check('a good file is imported', outcome === 'imported');
  check('workouts, weigh-ins, ingredients and recipes all landed', db.auto.sessions.length === 2 && db.auto.body.length === 2 && db.own.ingredients.size === 1 && db.auto.recipes.length === 1 && db.auto.diary.length === 1);
  check('the diary entry follows its recipe to the new local id', db.auto.diary[0].source.id === db.auto.recipes[0].id);
  check('the settings snapshot replaced the matching settings', db.state.prefs.ftp === 230 && db.state.prefs.units === 'imperial');
  check('settings only on this device are left alone', db.state.prefs.deviceOnlySetting === true && db.state.prefs.chartWindow === 300);
  check('the views are refreshed once, after the write and before the message',
    h.refreshes.length === 1 && h.events.indexOf('refresh') > h.events.indexOf('confirm') && h.events.indexOf('refresh') < h.events.lastIndexOf('status'));
  check('the refresh is told settings were restored, and what was added', h.refreshes[0].prefsRestored === true && h.refreshes[0].plan.sessions.toAdd.length === 2);
  check('the summary is shown', /^Imported 2 workouts/.test(h.last().text) && /Settings restored\./.test(h.last().text) && !h.last().error);
  check('the buttons are locked only around the work (not while the picker was open)', h.busy.join() === 'true,false' && h.events.indexOf('pick') < h.events.indexOf('busy'));

  // Importing the same file again: every record is a duplicate, so only the settings step remains.
  const h2 = harness(db, { picked: { name: 'b.json', text: await backupText() } });
  await h2.flow.importBackup();
  check('importing the same file twice adds no duplicates', db.auto.sessions.length === 2 && db.auto.body.length === 2 && db.auto.recipes.length === 1 && db.auto.diary.length === 1);
}
{
  const h = harness(makeDb(), { picked: { name: 'b.json', text: await backupText() }, refreshThrows: true });
  check('a view that fails to refresh does not turn a finished import into a failure',
    (await quiet(() => h.flow.importBackup())) === 'imported' && !h.last().error && /^Imported/.test(h.last().text));
}

// ─── Import: failing part-way ───────────────────────────────────────────────

console.log('import: failing part-way');
{
  const db = makeDb({ prefs: { ftp: 150 } });
  db.state.failOn = 'addRecipes'; // sessions and ingredients are written first; recipes is where it breaks
  const h = harness(db, { picked: { name: 'b.json', text: await backupText() } });
  const outcome = await quiet(() => h.flow.importBackup());
  check('a failure after some categories landed is reported as partial', outcome === 'partial');
  check('what landed is in, and what did not is not', db.auto.sessions.length === 2 && db.own.ingredients.size === 1 && db.auto.recipes.length === 0 && db.auto.diary.length === 0);
  check('the settings were NOT replaced', db.state.prefs.ftp === 150 && !('units' in db.state.prefs));
  check('the views were refreshed anyway, since data did land (and settings did not)', h.refreshes.length === 1 && h.refreshes[0].prefsRestored === false);
  check('the message says what landed, that settings are untouched, and how to finish',
    h.last().error && /part-way: 2 workouts and 1 ingredient were added/.test(h.last().text)
    && /Your settings weren\u2019t changed/.test(h.last().text) && /Import the same file again/.test(h.last().text));
  check('the buttons are freed', h.busy[h.busy.length - 1] === false);

  // The retry the message promises: same file, fault gone.
  db.state.failOn = null;
  const retry = harness(db, { picked: { name: 'b.json', text: await backupText() } });
  check('retrying the same file finishes the job', (await retry.flow.importBackup()) === 'imported');
  check('...with no duplicates of what had already landed', db.auto.sessions.length === 2 && db.own.ingredients.size === 1 && db.auto.recipes.length === 1 && db.auto.diary.length === 1);
  check('...and the settings restored now', db.state.prefs.ftp === 230);
  check('...the diary entry is linked to the recipe that arrived on the retry', db.auto.diary[0].source.id === db.auto.recipes[0].id);
}
{
  const db = makeDb({ prefs: { ftp: 150 } });
  db.state.failOn = 'addSessions'; // the very first write
  const h = harness(db, { picked: { name: 'b.json', text: await backupText() } });
  const outcome = await quiet(() => h.flow.importBackup());
  check('a failure on the very first write reports nothing changed', outcome === 'failed' && h.last().error && /Nothing was changed/.test(h.last().text));
  check('...and does not bother refreshing the views', h.refreshes.length === 0 && total(db) === 0 && db.state.prefs.ftp === 150);
}
{
  const db = makeDb();
  db.state.failOn = 'getSessionStartTimes'; // while reading what is already here, before any write
  const h = harness(db, { picked: { name: 'b.json', text: await backupText() } });
  check('a failure while reading the device is reported as nothing changed', (await quiet(() => h.flow.importBackup())) === 'failed' && /Nothing was changed/.test(h.last().text) && writes(db).length === 0);
}

// ─── The stand-in's weigh-in calls (used by the weigh-in editor's tests) ────

console.log('stand-in parity: weigh-in edit/delete');
{
  const db = rider();
  const [first] = await db.getBodyMeasurements();
  await db.updateBodyMeasurement({ ...first, weightKg: 70 });
  check('an update rewrites the row with that id, without adding one', db.auto.body.length === 2 && db.auto.body.find((r) => r.id === first.id).weightKg === 70);
  let threw = false;
  try { await db.updateBodyMeasurement({ measuredAt: 1, weightKg: 70 }); } catch { threw = true; }
  check('an update with no id is refused (the real one would silently insert a duplicate)', threw && db.auto.body.length === 2);
  await db.deleteBodyMeasurement(first.id);
  check('a delete removes just that row', db.auto.body.length === 1 && !db.auto.body.some((r) => r.id === first.id));
  await db.deleteBodyMeasurement(9999);
  check('deleting an id that is not there is not an error', db.auto.body.length === 1);
}

if (failures) {
  console.log(`\n${failures} profile backup flow check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll profile backup flow checks passed.');
