// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * storage/__fake_db__.js
 *
 * A plain-object stand-in for storage/db.js's `db`, shared by
 * __profile_transfer_smoketest__.js and __profile_backup_flow_smoketest__.js
 * so the two don't drift into two slightly-different fakes. Mirrors just the
 * methods storage/profile-transfer.js and ui/weigh-in-manager.js actually
 * call — no IndexedDB, no real persistence.
 *
 * `state.calls` records every method name called, in order — used by tests
 * to assert nothing was written (e.g. `writes(db).length === 0`, matching
 * calls whose name starts with "add" or "set") and by `state.failOn` to
 * inject a failure at a chosen point in the write sequence.
 */

const clone = (v) => JSON.parse(JSON.stringify(v));

export function makeDb(seed = {}) {
  const auto = { sessions: [], diary: [], body: [], recipes: [] };
  const own = { ingredients: new Map(), exercises: new Map(), cardio: new Map() };
  const state = {
    prefs: { ...(seed.prefs ?? {}) },
    nextId: { sessions: 1, diary: 1, body: 1, recipes: 1 },
    calls: [],
    failOn: null,
  };

  // Seeds go in through the same paths as real saves, so they get ids the way real records do.
  const seedAuto = (name, list = []) => {
    for (const r of list) {
      const { id, ...rest } = r;
      auto[name].push({ ...clone(rest), id: id ?? state.nextId[name] });
      state.nextId[name] = Math.max(state.nextId[name], (id ?? state.nextId[name]) + 1);
    }
  };
  seedAuto('sessions', seed.sessions); seedAuto('diary', seed.diary);
  seedAuto('body', seed.body); seedAuto('recipes', seed.recipes);
  for (const i of seed.ingredients ?? []) own.ingredients.set(i.id, clone(i));
  for (const x of seed.exercises ?? []) own.exercises.set(x.id, clone(x));
  for (const c of seed.cardio ?? []) own.cardio.set(c.id, clone(c));

  const guard = (method) => {
    state.calls.push(method);
    if (state.failOn === method) throw new Error(`injected failure in ${method}`);
  };
  const bulkAuto = (method, name) => async (records) => {
    guard(method);
    if (records.some((r) => 'id' in r)) throw new Error(`${method}: records must not carry an id`);
    for (const r of records) auto[name].push({ ...clone(r), id: state.nextId[name]++ });
    return records.length;
  };
  const bulkOwn = (method, map) => async (records) => {
    guard(method);
    for (const r of records) if (map.has(r.id)) throw new Error(`${method}: duplicate key ${r.id}`);
    for (const r of records) map.set(r.id, clone(r));
    return records.length;
  };

  return {
    state, auto, own,
    async getAllPrefs() { guard('getAllPrefs'); return clone(state.prefs); },
    async setPrefs(map) { guard('setPrefs'); Object.assign(state.prefs, clone(map)); },
    async getSessions() { guard('getSessions'); return clone(auto.sessions); },
    async getSessionStartTimes() { guard('getSessionStartTimes'); return auto.sessions.map((s) => s.startTime); },
    addSessions: bulkAuto('addSessions', 'sessions'),
    async getDiaryEntries() { guard('getDiaryEntries'); return clone(auto.diary); },
    addDiaryEntries: bulkAuto('addDiaryEntries', 'diary'),
    async getBodyMeasurements() { guard('getBodyMeasurements'); return clone(auto.body).sort((a, b) => b.measuredAt - a.measuredAt); },
    addBodyMeasurements: bulkAuto('addBodyMeasurements', 'body'),
    // Weigh-in editor (ui/weigh-in-manager.js) parity with the real db.js:
    // put()-style upsert by id (throws with no id, same "would silently
    // insert a duplicate" reasoning as the real store), and a no-op-on-miss
    // delete.
    async updateBodyMeasurement(measurement) {
      guard('updateBodyMeasurement');
      if (measurement?.id == null) throw new Error('updateBodyMeasurement() needs a measurement with an id');
      const i = auto.body.findIndex((r) => r.id === measurement.id);
      const row = clone(measurement);
      if (i === -1) auto.body.push(row); else auto.body[i] = row;
      return row;
    },
    async deleteBodyMeasurement(id) {
      guard('deleteBodyMeasurement');
      const i = auto.body.findIndex((r) => r.id === id);
      if (i !== -1) auto.body.splice(i, 1);
    },
    async deleteBodyMeasurements(ids) {
      guard('deleteBodyMeasurements');
      for (const id of ids) {
        const i = auto.body.findIndex((r) => r.id === id);
        if (i !== -1) auto.body.splice(i, 1);
      }
      return ids.length;
    },
    async getRecipes() { guard('getRecipes'); return clone(auto.recipes); },
    addRecipes: bulkAuto('addRecipes', 'recipes'),
    async getCustomIngredients() { guard('getCustomIngredients'); return clone([...own.ingredients.values()]); },
    addCustomIngredients: bulkOwn('addCustomIngredients', own.ingredients),
    async getCustomExercises() { guard('getCustomExercises'); return clone([...own.exercises.values()]); },
    addCustomExercises: bulkOwn('addCustomExercises', own.exercises),
    async getCustomCardioPresets() { guard('getCustomCardioPresets'); return clone([...own.cardio.values()]); },
    addCustomCardioPresets: bulkOwn('addCustomCardioPresets', own.cardio),
  };
}

export default makeDb;
