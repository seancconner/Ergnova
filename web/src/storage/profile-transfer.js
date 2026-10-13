// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * storage/profile-transfer.js
 *
 * The glue between storage/profile-archive.js (the pure file format: shape,
 * validation, duplicate rules) and storage/db.js (IndexedDB): reads everything
 * on this device into an export, and turns a picked file into a plan and then
 * into writes. app.js's Backup & Restore wiring does only the parts that need
 * the page — the file picker, the confirm(), the status line, refreshing views —
 * and calls in here for everything else.
 *
 * `db` is a parameter, never an import, so the whole export -> import path is
 * smoke-tested in plain node against an in-memory stand-in
 * (__profile_transfer_smoketest__.js) without an IndexedDB.
 *
 * Import order matters, and is fixed here rather than left to the caller:
 *   1. Recipes before diary entries — an entry that logged one of the rider's
 *      own recipes carries the recipe's NAME in the file, and is resolved to a
 *      local id only once every recipe is in (resolveRecipeReferences()).
 *      Custom ingredients go in before recipes for the same reason: a recipe
 *      can reference one.
 *   2. Settings LAST. Everything else only adds; replacing the settings is the
 *      one step that overwrites something, so it must not run if a category
 *      before it failed.
 * Each category is its own IndexedDB transaction (all-or-nothing within the
 * category, db.js's bulk adds), not one transaction for the whole import — so a
 * failure part-way leaves the earlier categories in. That is safe to retry:
 * the plan is built from what's already on the device, so importing the same
 * file again skips whatever landed and adds the rest. applyProfileImport()
 * reports what got in (`err.importedSoFar`) so the message can say so.
 */

import {
  buildProfileArchive, parseProfileArchive, planProfileImport, planAddCount,
  resolveRecipeReferences, recipeNameKey,
} from './profile-archive.js';

/**
 * Everything on this device, in buildProfileArchive()'s `source` shape.
 * @param {Object} db  storage/db.js's `db`
 */
export async function readProfileSource(db) {
  const [prefs, sessions, diaryEntries, bodyMeasurements, ingredients, recipes, exercises, cardioPresets] = await Promise.all([
    db.getAllPrefs(), db.getSessions(), db.getDiaryEntries(), db.getBodyMeasurements(),
    db.getCustomIngredients(), db.getRecipes(), db.getCustomExercises(), db.getCustomCardioPresets(),
  ]);
  return { prefs, sessions, diaryEntries, bodyMeasurements, ingredients, recipes, exercises, cardioPresets };
}

/** Builds the export file from this device's saved data. Same return as buildProfileArchive(). */
export async function exportProfile(db, { now } = {}) {
  return buildProfileArchive(await readProfileSource(db), now == null ? {} : { now });
}

/** What's already on this device, keyed the way planProfileImport() dedups. Sessions come
 *  from db.getSessionStartTimes() rather than getSessions(): a key cursor, so the (large)
 *  per-second sample arrays aren't loaded just to read a timestamp. */
export async function readExistingKeys(db) {
  const [sessionStartTimes, diary, body, ingredients, recipes, exercises, cardioPresets] = await Promise.all([
    db.getSessionStartTimes(), db.getDiaryEntries(), db.getBodyMeasurements(),
    db.getCustomIngredients(), db.getRecipes(), db.getCustomExercises(), db.getCustomCardioPresets(),
  ]);
  return {
    sessionStartTimes,
    diaryLoggedAts: diary.map((e) => e.loggedAt),
    bodyMeasuredAts: body.map((m) => m.measuredAt),
    ingredientIds: ingredients.map((i) => i.id),
    exerciseIds: exercises.map((x) => x.id),
    cardioPresetIds: cardioPresets.map((c) => c.id),
    recipeNames: recipes.map((r) => recipeNameKey(r.name)),
  };
}

/**
 * Reads a picked file and works out what importing it would do, without
 * changing anything — so the caller can show a confirmation first.
 *
 * @param {Object} db
 * @param {string} text  contents of the picked file
 * @returns {Promise<
 *   { ok: false, error: string }
 * | { ok: true, parsed: Object, plan: Object, addCount: number, hasSettings: boolean }>}
 *   `error` is one of parseProfileArchive()'s codes (see profileImportErrorMessage()).
 *   `hasSettings` is whether the file carries a settings snapshot that an import would apply.
 */
export async function prepareProfileImport(db, text) {
  const parsed = parseProfileArchive(text);
  if (!parsed.ok) return parsed;
  const plan = planProfileImport(await readExistingKeys(db), parsed.data);
  return {
    ok: true,
    parsed,
    plan,
    addCount: planAddCount(plan),
    hasSettings: Object.keys(parsed.data.prefs).length > 0,
  };
}

/**
 * Writes an import plan (see the module doc comment for the order and its
 * reasons). Throws on the first failure, with `err.importedSoFar` naming the
 * categories that had already been written.
 *
 * @param {Object} db
 * @param {Object} plan                   prepareProfileImport().plan
 * @param {Object} [opts]
 * @param {Object} [opts.prefs={}]        prepareProfileImport().parsed.data.prefs
 * @param {boolean} [opts.restoreSettings=false]  apply `prefs` over the saved settings
 * @returns {Promise<{ prefsRestored: boolean }>}
 */
export async function applyProfileImport(db, plan, { prefs = {}, restoreSettings = false } = {}) {
  const done = [];
  const addAll = async (name, toAdd, write) => {
    if (!toAdd.length) return;
    await write(toAdd);
    done.push(name);
  };

  try {
    await addAll('sessions', plan.sessions.toAdd, (r) => db.addSessions(r));
    await addAll('ingredients', plan.ingredients.toAdd, (r) => db.addCustomIngredients(r));
    await addAll('recipes', plan.recipes.toAdd, (r) => db.addRecipes(r));

    // Diary entries: recipe references are resolved against every recipe now on
    // the device. If two local recipes share a name the first one wins — the same
    // "same name = same recipe" rule the duplicate check uses.
    await addAll('diaryEntries', plan.diaryEntries.toAdd, async (entries) => {
      const recipeIdByName = new Map();
      for (const recipe of await db.getRecipes()) {
        const key = recipeNameKey(recipe.name);
        if (!recipeIdByName.has(key)) recipeIdByName.set(key, recipe.id);
      }
      await db.addDiaryEntries(resolveRecipeReferences(entries, recipeIdByName));
    });

    await addAll('bodyMeasurements', plan.bodyMeasurements.toAdd, (r) => db.addBodyMeasurements(r));
    await addAll('exercises', plan.exercises.toAdd, (r) => db.addCustomExercises(r));
    await addAll('cardioPresets', plan.cardioPresets.toAdd, (r) => db.addCustomCardioPresets(r));

    let prefsRestored = false;
    if (restoreSettings && Object.keys(prefs).length) {
      await db.setPrefs(prefs);
      prefsRestored = true;
    }
    return { prefsRestored };
  } catch (err) {
    err.importedSoFar = done;
    throw err;
  }
}
