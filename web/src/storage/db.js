// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

const DB_NAME = 'ergnova';
const DB_VERSION = 5;
const STORE = 'workouts';
const SESSIONS_STORE = 'sessions';
const PREFS_STORE = 'prefs';
const INGREDIENTS_STORE = 'ingredients';
const RECIPES_STORE = 'recipes';
const DIARY_STORE = 'diaryEntries';
const BODY_MEASUREMENTS_STORE = 'bodyMeasurements';
// custom (rider-authored) exercises only — the bundled catalog in
// data/exercises.js never passes through here, same "seed json + custom
// store" split as INGREDIENTS_STORE/ingredient-repository.js above. See
// data/exercises.js's createCustomExercise()/loadCustomExercises().
const CUSTOM_EXERCISES_STORE = 'customExercises';
// Rider-saved cardio timeline ("Mapped" quick-start target style) presets
// only — the four bundled presets in data/cardio-timelines.js never pass
// through here, same seed-data/custom-store split as CUSTOM_EXERCISES_STORE
// above. See that file's addCustomTimelinePreset()/loadCustomTimelinePresets().
const CUSTOM_CARDIO_PRESETS_STORE = 'customCardioPresets';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('startedAt', 'startedAt');
        store.createIndex('machineType', 'machineType');
      }
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const sessions = db.createObjectStore(SESSIONS_STORE, { keyPath: 'id', autoIncrement: true });
        sessions.createIndex('startTime', 'startTime');
      }
      if (!db.objectStoreNames.contains(PREFS_STORE)) {
        db.createObjectStore(PREFS_STORE, { keyPath: 'key' });
      }
      // ── Diet panel stores (v3) ──────────────────────────────────────────
      // ingredients only holds *custom* ingredients (id prefixed 'custom:') —
      // the bundled seed database is static JSON shipped with the build, not
      // duplicated in here on first run. See core/nutrition-model.js and
      // nutrition/ingredient-repository.js.
      if (!db.objectStoreNames.contains(INGREDIENTS_STORE)) {
        const ingredients = db.createObjectStore(INGREDIENTS_STORE, { keyPath: 'id' });
        ingredients.createIndex('name', 'name');
      }
      if (!db.objectStoreNames.contains(RECIPES_STORE)) {
        const recipes = db.createObjectStore(RECIPES_STORE, { keyPath: 'id', autoIncrement: true });
        recipes.createIndex('name', 'name');
        recipes.createIndex('cuisine', 'cuisine');
      }
      if (!db.objectStoreNames.contains(DIARY_STORE)) {
        const diary = db.createObjectStore(DIARY_STORE, { keyPath: 'id', autoIncrement: true });
        diary.createIndex('loggedAt', 'loggedAt');
      }
      if (!db.objectStoreNames.contains(BODY_MEASUREMENTS_STORE)) {
        const bodyMeasurements = db.createObjectStore(BODY_MEASUREMENTS_STORE, { keyPath: 'id', autoIncrement: true });
        bodyMeasurements.createIndex('measuredAt', 'measuredAt');
      }
      // ── Custom exercises (v4) ────────────────────────────────────────────
      if (!db.objectStoreNames.contains(CUSTOM_EXERCISES_STORE)) {
        const customExercises = db.createObjectStore(CUSTOM_EXERCISES_STORE, { keyPath: 'id' });
        customExercises.createIndex('name', 'name');
      }
      // ── Custom cardio timeline presets (v5) ───────────────────────────────
      if (!db.objectStoreNames.contains(CUSTOM_CARDIO_PRESETS_STORE)) {
        const customCardioPresets = db.createObjectStore(CUSTOM_CARDIO_PRESETS_STORE, { keyPath: 'id' });
        customCardioPresets.createIndex('label', 'label');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveWorkout(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add(record);
    req.onsuccess = () => resolve({ ...record, id: req.result });
    req.onerror = () => reject(req.error);
  });
}

export async function listWorkouts() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('startedAt').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.startedAt - a.startedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function getWorkout(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteWorkout(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── `db` namespace ─────────────────────────────────────────────────────────
// app.js, recording/session.js, and views/history-browser.js all import this
// higher-level object (open / prefs / sessions) rather than the bare
// workout-store functions above.
export const db = {
  open: () => openDb(),

  async getPref(key, defaultValue) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(PREFS_STORE, 'readonly').objectStore(PREFS_STORE).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
      req.onerror = () => reject(req.error);
    });
  },

  async setPref(key, value) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(PREFS_STORE, 'readwrite');
      tx.objectStore(PREFS_STORE).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * Every stored preference as one plain `{key: value}` object — the
   * "settings snapshot" half of storage/profile-archive.js's full-profile
   * export. Deliberately generic (a raw dump of the whole PREFS_STORE)
   * rather than a hand-picked list of keys, so a new pref added anywhere
   * else in the app (a new `db.setPref(...)` call site) is automatically
   * included without this needing to be updated too.
   */
  async getAllPrefs() {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(PREFS_STORE, 'readonly').objectStore(PREFS_STORE).getAll();
      req.onsuccess = () => resolve(Object.fromEntries(req.result.map(({ key, value }) => [key, value])));
      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Bulk-writes many preferences in a single transaction — the settings-
   * snapshot half of a profile import (storage/profile-archive.js). Each
   * key is put() individually (overwrites whatever was there, same as
   * setPref()), but sharing one transaction means a failure partway
   * through can't leave the settings half-restored.
   * @param {Object<string, *>} map
   */
  async setPrefs(map) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(PREFS_STORE, 'readwrite');
      const store = tx.objectStore(PREFS_STORE);
      for (const [key, value] of Object.entries(map)) store.put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  async getSessions() {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(SESSIONS_STORE, 'readonly')
        .objectStore(SESSIONS_STORE).index('startTime').getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.startTime - a.startTime));
      req.onerror = () => reject(req.error);
    });
  },

  async saveSession(record) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(SESSIONS_STORE, 'readwrite').objectStore(SESSIONS_STORE).add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Overwrites an already-saved session record in place (requires
   * record.id — the id saveSession() returned). Used to attach data that
   * isn't known until after the record was first saved, e.g. a fitness
   * test's estimated result (see app.js's _persistTestResult()), so it
   * travels with the record into every later export from history rather
   * than living only in the rider profile.
   */
  async updateSession(record) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(SESSIONS_STORE, 'readwrite');
      tx.objectStore(SESSIONS_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async deleteSession(id) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(SESSIONS_STORE, 'readwrite');
      tx.objectStore(SESSIONS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * The startTime of every saved session — what History's Import matches
   * incoming sessions against to skip ones already on this device (see
   * recording/history-archive.js's planSessionImport()). Walks a key cursor
   * over the startTime index rather than reading records, so it doesn't pull
   * every session's sample array into memory. (Not index.getAllKeys(): that
   * returns the records' *primary* keys — the ids — not the indexed values.)
   */
  async getSessionStartTimes() {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const times = [];
      const req = conn.transaction(SESSIONS_STORE, 'readonly')
        .objectStore(SESSIONS_STORE).index('startTime').openKeyCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) { times.push(cursor.key); cursor.continue(); }
        else resolve(times);
      };
      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Adds many session records in a single transaction — either all of them
   * land or none do, so a failure partway through an import can't leave half
   * a file behind. Records must not carry an `id`: the store assigns fresh
   * ones. Resolves with how many were added.
   */
  async addSessions(records) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(SESSIONS_STORE, 'readwrite');
      const store = tx.objectStore(SESSIONS_STORE);
      for (const record of records) store.add(record);
      tx.oncomplete = () => resolve(records.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  // ── Diet panel: custom ingredients ─────────────────────────────────────
  // Bundled/seed ingredients never pass through here — see
  // nutrition/ingredient-repository.js for where custom (this store) and
  // seed (static JSON) ingredients get merged for lookup/search.

  async getCustomIngredients() {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(INGREDIENTS_STORE, 'readonly').objectStore(INGREDIENTS_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  /** Ingredient already carries its own id (core/nutrition-model.js's
   *  createIngredient() generates a 'custom:' one) — put() rather than
   *  add(), so re-saving an edited custom ingredient overwrites in place
   *  instead of erroring on a duplicate key. */
  async saveCustomIngredient(ingredient) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(INGREDIENTS_STORE, 'readwrite');
      tx.objectStore(INGREDIENTS_STORE).put(ingredient);
      tx.oncomplete = () => resolve(ingredient);
      tx.onerror = () => reject(tx.error);
    });
  },

  async deleteCustomIngredient(id) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(INGREDIENTS_STORE, 'readwrite');
      tx.objectStore(INGREDIENTS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * Bulk-adds many custom ingredients in one transaction, for a full-
   * profile import (storage/profile-archive.js). Unlike saveCustomIngredient()
   * above, this uses add() rather than put() deliberately: every id
   * reaching here should already be new (the import's dedup plan filters
   * out ids that already exist locally), so a collision here is a bug
   * worth surfacing — and aborting the whole transaction — rather than
   * silently overwriting a rider's existing ingredient with an imported one.
   */
  async addCustomIngredients(records) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(INGREDIENTS_STORE, 'readwrite');
      const store = tx.objectStore(INGREDIENTS_STORE);
      for (const record of records) store.add(record);
      tx.oncomplete = () => resolve(records.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  // ── Diet panel: recipes ─────────────────────────────────────────────────

  async getRecipes() {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(RECIPES_STORE, 'readonly').objectStore(RECIPES_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async saveRecipe(recipe) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(RECIPES_STORE, 'readwrite').objectStore(RECIPES_STORE).add(recipe);
      req.onsuccess = () => resolve({ ...recipe, id: req.result });
      req.onerror = () => reject(req.error);
    });
  },

  /** Overwrites an already-saved recipe in place (requires recipe.id) —
   *  same shape as updateSession() above, e.g. for recomputing perServing
   *  after the ingredient list changes in ui/recipe-editor.js. */
  async updateRecipe(recipe) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(RECIPES_STORE, 'readwrite');
      tx.objectStore(RECIPES_STORE).put(recipe);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async deleteRecipe(id) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(RECIPES_STORE, 'readwrite');
      tx.objectStore(RECIPES_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /** Bulk counterpart of saveRecipe() — same all-or-nothing single-
   *  transaction shape as addSessions() above, for a full-profile import. */
  async addRecipes(records) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(RECIPES_STORE, 'readwrite');
      const store = tx.objectStore(RECIPES_STORE);
      for (const record of records) store.add(record);
      tx.oncomplete = () => resolve(records.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  // ── Diet panel: diary entries ───────────────────────────────────────────
  // No date-range query params, deliberately — views/diet.js and
  // overview.js's weekly nutrition card fetch everything and bucket
  // client-side with plain timestamp filters, same as overview.js already
  // does with db.getSessions() (_aggregate()/_weeklyTrend()). This store
  // never grows large enough for that to matter.

  async getDiaryEntries() {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(DIARY_STORE, 'readonly').objectStore(DIARY_STORE).index('loggedAt').getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.loggedAt - a.loggedAt));
      req.onerror = () => reject(req.error);
    });
  },

  async saveDiaryEntry(entry) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(DIARY_STORE, 'readwrite').objectStore(DIARY_STORE).add(entry);
      req.onsuccess = () => resolve({ ...entry, id: req.result });
      req.onerror = () => reject(req.error);
    });
  },

  /** Overwrites an already-saved diary entry in place (requires
   *  entry.id) — same put()-based shape as updateSession()/updateRecipe()
   *  above. Not part of Phase 1's original CRUD list (DIET_PANEL_DESIGN.md
   *  §2 only called for get/save/delete on this store); added in Phase 4
   *  once the Today view's tap-to-edit-amount flow (views/diet.js) needed
   *  a way to recompute an entry's nutrients after the logged amount
   *  changes without deleting and re-adding it, which would lose its
   *  original loggedAt ordering. */
  async updateDiaryEntry(entry) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(DIARY_STORE, 'readwrite');
      tx.objectStore(DIARY_STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async deleteDiaryEntry(id) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(DIARY_STORE, 'readwrite');
      tx.objectStore(DIARY_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * Adds many diary entries in a single transaction — either all land or
   * none do, same all-or-nothing shape as addSessions() above. Records
   * must not carry an `id`: the store assigns fresh ones. Used by a
   * full-profile import (storage/profile-archive.js); the diary's own
   * per-entry CRUD above has no bulk caller otherwise.
   */
  async addDiaryEntries(records) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(DIARY_STORE, 'readwrite');
      const store = tx.objectStore(DIARY_STORE);
      for (const record of records) store.add(record);
      tx.oncomplete = () => resolve(records.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  // ── Diet panel: body measurements (BLE scale weigh-ins) ─────────────────

  async getBodyMeasurements() {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(BODY_MEASUREMENTS_STORE, 'readonly').objectStore(BODY_MEASUREMENTS_STORE).index('measuredAt').getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.measuredAt - a.measuredAt));
      req.onerror = () => reject(req.error);
    });
  },

  async saveBodyMeasurement(measurement) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(BODY_MEASUREMENTS_STORE, 'readwrite').objectStore(BODY_MEASUREMENTS_STORE).add(measurement);
      req.onsuccess = () => resolve({ ...measurement, id: req.result });
      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Rewrites an existing weigh-in — the weigh-in editor's Save
   * (ui/weigh-in-manager.js). The record's `id` picks the row. Rejects when
   * there isn't one: put() on an autoIncrement store with no key quietly
   * INSERTS a new row, so an "edit" of an id-less record would silently
   * duplicate the weigh-in instead of changing it.
   */
  async updateBodyMeasurement(measurement) {
    if (measurement?.id == null) throw new Error('updateBodyMeasurement() needs a measurement with an id');
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(BODY_MEASUREMENTS_STORE, 'readwrite');
      tx.objectStore(BODY_MEASUREMENTS_STORE).put(measurement);
      tx.oncomplete = () => resolve(measurement);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  /** Removes one weigh-in. Only the history row — the Profile's own weight and
   *  body-composition fields (a separate "current" snapshot in the prefs
   *  store) are not touched. */
  async deleteBodyMeasurement(id) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(BODY_MEASUREMENTS_STORE, 'readwrite');
      tx.objectStore(BODY_MEASUREMENTS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  /** Removes several weigh-ins in ONE transaction, so it is all-or-nothing: if
   *  anything fails, none of them are deleted. The weigh-in editor's "Clear all
   *  that need review" (ui/weigh-in-manager.js). Same history-only scope as
   *  deleteBodyMeasurement(), and an id that isn't there is skipped, not an
   *  error. Resolves to how many ids it was asked to delete. */
  async deleteBodyMeasurements(ids) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(BODY_MEASUREMENTS_STORE, 'readwrite');
      const store = tx.objectStore(BODY_MEASUREMENTS_STORE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve(ids.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  /** Bulk counterpart of saveBodyMeasurement() — same all-or-nothing single-
   *  transaction shape as addDiaryEntries() above, for a full-profile import. */
  async addBodyMeasurements(records) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(BODY_MEASUREMENTS_STORE, 'readwrite');
      const store = tx.objectStore(BODY_MEASUREMENTS_STORE);
      for (const record of records) store.add(record);
      tx.oncomplete = () => resolve(records.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  // ── Custom exercises (rider-created, feeds data/exercises.js's catalog) ──
  // Same put()-keyed-by-own-id shape as saveCustomIngredient() above — a
  // custom Exercise already carries its own 'custom:'-prefixed id (see
  // data/exercises.js's createCustomExercise()), so re-saving an edited one
  // overwrites in place instead of erroring on a duplicate key.

  async getCustomExercises() {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(CUSTOM_EXERCISES_STORE, 'readonly').objectStore(CUSTOM_EXERCISES_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async saveCustomExercise(exercise) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(CUSTOM_EXERCISES_STORE, 'readwrite');
      tx.objectStore(CUSTOM_EXERCISES_STORE).put(exercise);
      tx.oncomplete = () => resolve(exercise);
      tx.onerror = () => reject(tx.error);
    });
  },

  async deleteCustomExercise(id) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(CUSTOM_EXERCISES_STORE, 'readwrite');
      tx.objectStore(CUSTOM_EXERCISES_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /** Bulk counterpart of saveCustomExercise() — add()-based, not put()-based,
   *  same "the import's dedup plan already filtered out existing ids, so a
   *  collision here should abort rather than silently overwrite" reasoning
   *  as addCustomIngredients() above. For a full-profile import. */
  async addCustomExercises(records) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(CUSTOM_EXERCISES_STORE, 'readwrite');
      const store = tx.objectStore(CUSTOM_EXERCISES_STORE);
      for (const record of records) store.add(record);
      tx.oncomplete = () => resolve(records.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  // ── Custom cardio timeline presets (rider-saved "Mapped" quick-start ────
  // presets, feeds data/cardio-timelines.js's catalog) ────────────────────
  // Same put()-keyed-by-own-id shape as saveCustomExercise() above — a
  // custom preset already carries its own 'custom:'-prefixed id (see
  // data/cardio-timelines.js's createCustomTimelinePreset()), so re-saving
  // an edited one overwrites in place instead of erroring on a duplicate key.

  async getCustomCardioPresets() {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const req = conn.transaction(CUSTOM_CARDIO_PRESETS_STORE, 'readonly').objectStore(CUSTOM_CARDIO_PRESETS_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async saveCustomCardioPreset(preset) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(CUSTOM_CARDIO_PRESETS_STORE, 'readwrite');
      tx.objectStore(CUSTOM_CARDIO_PRESETS_STORE).put(preset);
      tx.oncomplete = () => resolve(preset);
      tx.onerror = () => reject(tx.error);
    });
  },

  async deleteCustomCardioPreset(id) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(CUSTOM_CARDIO_PRESETS_STORE, 'readwrite');
      tx.objectStore(CUSTOM_CARDIO_PRESETS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /** Bulk counterpart of saveCustomCardioPreset() — same add()-based,
   *  collision-should-abort reasoning as addCustomExercises() above.
   *  For a full-profile import. */
  async addCustomCardioPresets(records) {
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(CUSTOM_CARDIO_PRESETS_STORE, 'readwrite');
      const store = tx.objectStore(CUSTOM_CARDIO_PRESETS_STORE);
      for (const record of records) store.add(record);
      tx.oncomplete = () => resolve(records.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
};
