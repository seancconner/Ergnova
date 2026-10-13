// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * recording/history-archive.js
 *
 * The file format behind History's "Export all" and "Import" buttons
 * (views/history-browser.js): every saved session in one JSON file, and the
 * reverse — validate a file someone picked, and work out which of its
 * sessions are new. Pure functions only (no DOM, no IndexedDB), so it runs
 * under plain `node` for __history_archive_smoketest__.js; storage/db.js
 * does the actual reads and writes.
 *
 * File shape:
 *   { format: 'ergnova-history', version: 1, exportedAt: <ISO string>,
 *     count: <n>, sessions: [ <SessionRecord>, ... ] }
 * Each entry is a session record exactly as recording/session.js saves it
 * (samples, laps, meta, summary, and anything attached later, such as a
 * fitness-test result) minus its local `id`. Ids belong to one device's
 * IndexedDB — they're dropped on export and never trusted on import, so an
 * import can't overwrite or collide with a session that already has that id.
 *
 * Import also accepts the two things people are likely to have lying around:
 * a single session's "JSON" download from the History list (a bare record),
 * and a bare array of records.
 *
 * Duplicates: a session is identified by its `startTime` (epoch ms) — two
 * different rides can't start on the same millisecond, and importing the same
 * file twice, or an export that overlaps what's already on the device, must
 * not double anything up. Already-present sessions win; they're skipped, not
 * merged.
 */

export const HISTORY_ARCHIVE_FORMAT  = 'ergnova-history';
export const HISTORY_ARCHIVE_VERSION = 1;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `ergnova-history-2026-09-20.json` — local date, so it matches what the rider sees on the calendar. */
export function historyArchiveFilename(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `ergnova-history-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/**
 * @param {Object[]} sessions  Records from db.getSessions() (any order).
 * @param {Object}   [opts]
 * @param {number}   [opts.now=Date.now()]
 * @returns {{ json: string, count: number, filename: string }}
 *   Compact JSON on purpose — a session carries one sample per second, so
 *   pretty-printing would roughly double a file that is already the biggest
 *   thing the app writes.
 */
export function buildHistoryArchive(sessions, { now = Date.now() } = {}) {
  const records = sessions
    .map(({ id, ...rest }) => rest)
    .sort((a, b) => a.startTime - b.startTime); // oldest first: reads chronologically, and imports back in the order it happened
  const json = JSON.stringify({
    format: HISTORY_ARCHIVE_FORMAT,
    version: HISTORY_ARCHIVE_VERSION,
    exportedAt: new Date(now).toISOString(),
    count: records.length,
    sessions: records,
  });
  return { json, count: records.length, filename: historyArchiveFilename(now) };
}

/**
 * Checks one imported entry and fills in the optional fields the rest of the
 * app reads without guarding (laps, meta, summary, endTime). Returns a fresh
 * record without `id`, or null if it isn't usable. What's required is what
 * every consumer of a session actually dereferences: a real start time, a
 * duration, and a samples array of objects (the chart and the stat chips
 * call .some()/.length on it). Everything else on the record is passed
 * through untouched.
 */
export function normalizeImportedSession(raw) {
  if (!isPlainObject(raw)) return null;
  const { id, ...s } = raw;

  if (!Number.isFinite(s.startTime) || s.startTime <= 0) return null;
  if (!Array.isArray(s.samples) || !s.samples.every(isPlainObject)) return null;

  let duration = s.duration;
  if (!Number.isFinite(duration) || duration < 0) {
    if (Number.isFinite(s.endTime) && s.endTime >= s.startTime) {
      duration = Math.round((s.endTime - s.startTime) / 1000);
    } else {
      return null;
    }
  }
  s.duration = duration;
  if (!Number.isFinite(s.endTime)) s.endTime = s.startTime + duration * 1000;
  if (!Array.isArray(s.laps))      s.laps = [];
  if (!isPlainObject(s.meta))      s.meta = {};
  if (!isPlainObject(s.summary))   s.summary = {};
  if (s.workoutName != null && typeof s.workoutName !== 'string') s.workoutName = String(s.workoutName);
  return s;
}

/**
 * @param {string} text  Contents of the picked file.
 * @returns {{ ok: true, sessions: Object[], invalid: number }
 *          |{ ok: false, error: 'not-json'|'unrecognized'|'wrong-format'|'newer-version' }}
 *   `invalid` counts entries that were present but unusable (see
 *   normalizeImportedSession()); the usable ones are still returned, so one
 *   bad entry doesn't sink the whole import.
 */
export function parseHistoryArchive(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, '')); // a BOM is legal in a file some editors touched
  } catch {
    return { ok: false, error: 'not-json' };
  }

  let list;
  if (Array.isArray(data)) {
    list = data;
  } else if (isPlainObject(data) && Array.isArray(data.sessions)) {
    if (data.format !== undefined && data.format !== HISTORY_ARCHIVE_FORMAT) return { ok: false, error: 'wrong-format' };
    if (Number.isFinite(data.version) && data.version > HISTORY_ARCHIVE_VERSION) return { ok: false, error: 'newer-version' };
    list = data.sessions;
  } else if (isPlainObject(data) && 'startTime' in data && Array.isArray(data.samples)) {
    list = [data]; // one session's own JSON download
  } else {
    return { ok: false, error: 'unrecognized' };
  }

  const sessions = [];
  let invalid = 0;
  for (const raw of list) {
    const s = normalizeImportedSession(raw);
    if (s) sessions.push(s); else invalid++;
  }
  return { ok: true, sessions, invalid };
}

/**
 * Splits imported sessions into the ones to add and a count of the ones to
 * skip, matching on startTime — against what's already stored and against
 * earlier entries in the same file.
 * @param {Iterable<number>} existingStartTimes  db.getSessionStartTimes()
 * @param {Object[]}         sessions            parseHistoryArchive().sessions
 * @returns {{ toAdd: Object[], duplicates: number }}
 */
export function planSessionImport(existingStartTimes, sessions) {
  const seen = new Set(existingStartTimes);
  const toAdd = [];
  let duplicates = 0;
  for (const s of sessions) {
    if (seen.has(s.startTime)) { duplicates++; continue; }
    seen.add(s.startTime);
    toAdd.push(s);
  }
  return { toAdd, duplicates };
}

/** The one-line result shown under the History header after an import. */
export function importSummary({ added, duplicates = 0, invalid = 0 }) {
  const workouts = (n) => `${n} workout${n === 1 ? '' : 's'}`;
  const parts = [added ? `Imported ${workouts(added)}.` : 'Nothing new to import.'];
  if (duplicates) parts.push(`${workouts(duplicates)} already in your history ${duplicates === 1 ? 'was' : 'were'} skipped.`);
  if (invalid)    parts.push(`${invalid} ${invalid === 1 ? 'entry' : 'entries'} couldn\u2019t be read.`);
  return parts.join(' ');
}

/** Message for a parseHistoryArchive() failure. */
export function importErrorMessage(code) {
  switch (code) {
    case 'not-json':       return 'That file isn\u2019t a valid Ergnova history export.';
    case 'wrong-format':   return 'That file is a different kind of export, not an Ergnova workout history.';
    case 'newer-version':  return 'That export was made by a newer version of Ergnova. Update the app and try again.';
    default:               return 'No workouts were found in that file.';
  }
}
