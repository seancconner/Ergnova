// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// History export/import format: recording/history-archive.js. Pure logic, no DOM or IndexedDB.
// Run with: node src/recording/__history_archive_smoketest__.js

import {
  HISTORY_ARCHIVE_FORMAT, HISTORY_ARCHIVE_VERSION,
  historyArchiveFilename, buildHistoryArchive, normalizeImportedSession,
  parseHistoryArchive, planSessionImport, importSummary, importErrorMessage,
} from './history-archive.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

const sample = (t, power = 200) => ({ timestamp: t, power, heartRate: 140, cadence: 90, speed: null, distance: null, calories: null });
const session = (startTime, extra = {}) => ({
  id: startTime % 1000,               // a local id that must not survive a round trip
  startTime,
  endTime: startTime + 60000,
  duration: 60,
  samples: [sample(startTime), sample(startTime + 1000, 210)],
  laps: [{ t: 30 }],
  workoutName: 'Free Ride',
  meta: { type: 'free' },
  summary: { avgPower: 205, avgHr: 140 },
  ...extra,
});

console.log('filename');
check('local-date filename', historyArchiveFilename(new Date(2026, 8, 20, 12).getTime()) === 'ergnova-history-2026-09-20.json');

console.log('export');
const a = session(3_000_000), b = session(1_000_000), c = session(2_000_000, { testResult: { ftp: 250 } });
const built = buildHistoryArchive([a, b, c], { now: Date.UTC(2026, 8, 20) });
const envelope = JSON.parse(built.json);
check('reports the session count', built.count === 3 && envelope.count === 3);
check('envelope carries format + version + exportedAt',
  envelope.format === HISTORY_ARCHIVE_FORMAT && envelope.version === HISTORY_ARCHIVE_VERSION && envelope.exportedAt === '2026-09-20T00:00:00.000Z');
check('sessions are written oldest first', envelope.sessions.map(s => s.startTime).join() === '1000000,2000000,3000000');
check('local ids are dropped', envelope.sessions.every(s => !('id' in s)));
check('extra fields (a test result) travel with the record', envelope.sessions[1].testResult?.ftp === 250);
check('the caller\'s records are not mutated', a.id === 3_000_000 % 1000);
check('output is compact, not pretty-printed', !built.json.includes('\n'));
check('an empty history still builds a valid file', JSON.parse(buildHistoryArchive([]).json).sessions.length === 0);

console.log('import: round trip');
const parsed = parseHistoryArchive(built.json);
check('parses what export wrote', parsed.ok && parsed.sessions.length === 3 && parsed.invalid === 0);
check('records come back equal apart from the id', JSON.stringify(parsed.sessions[0]) === JSON.stringify((({ id, ...r }) => r)(b)));
check('a UTF-8 BOM in front is tolerated', parseHistoryArchive('\uFEFF' + built.json).ok === true);

console.log('import: other accepted shapes');
const single = parseHistoryArchive(JSON.stringify(a));
check('one session\'s own JSON download imports as a single session', single.ok && single.sessions.length === 1 && !('id' in single.sessions[0]));
const bare = parseHistoryArchive(JSON.stringify([a, b]));
check('a bare array of records imports', bare.ok && bare.sessions.length === 2);

console.log('import: rejections');
check('garbage is "not-json"', parseHistoryArchive('nope {').error === 'not-json');
check('valid JSON that is not a history is "unrecognized"', parseHistoryArchive('{"hello":1}').error === 'unrecognized');
check('a number is "unrecognized"', parseHistoryArchive('42').error === 'unrecognized');
check('a different app\'s envelope is "wrong-format"', parseHistoryArchive(JSON.stringify({ format: 'other', sessions: [] })).error === 'wrong-format');
check('a newer version is "newer-version"', parseHistoryArchive(JSON.stringify({ format: HISTORY_ARCHIVE_FORMAT, version: 99, sessions: [] })).error === 'newer-version');
check('every failure code has its own message', new Set(['not-json', 'wrong-format', 'newer-version', 'unrecognized'].map(importErrorMessage)).size === 4);

console.log('import: per-entry validation');
const mixed = parseHistoryArchive(JSON.stringify({
  format: HISTORY_ARCHIVE_FORMAT, version: 1,
  sessions: [session(5_000_000), { startTime: 'yesterday', samples: [] }, null, 'x', { startTime: 6_000_000, samples: 'nope', duration: 5 }, session(7_000_000)],
}));
check('usable entries survive, unusable ones are counted', mixed.ok && mixed.sessions.length === 2 && mixed.invalid === 4);
check('an entry with no samples array is unusable', normalizeImportedSession({ startTime: 1, duration: 1 }) === null);
check('a sample that is not an object is unusable', normalizeImportedSession({ startTime: 1, duration: 1, samples: [1] }) === null);
check('a non-positive startTime is unusable', normalizeImportedSession({ startTime: 0, duration: 1, samples: [] }) === null);

const bare1 = normalizeImportedSession({ startTime: 10_000, endTime: 70_000, samples: [] });
check('duration is derived from endTime when missing', bare1?.duration === 60);
const bare2 = normalizeImportedSession({ startTime: 10_000, duration: 30, samples: [], id: 7 });
check('endTime, laps, meta and summary get safe defaults',
  bare2.endTime === 40_000 && Array.isArray(bare2.laps) && bare2.laps.length === 0
  && typeof bare2.meta === 'object' && typeof bare2.summary === 'object');
check('an id on an imported record is discarded', !('id' in bare2));
check('no duration and no endTime is unusable', normalizeImportedSession({ startTime: 10_000, samples: [] }) === null);

console.log('import: duplicates');
const plan = planSessionImport([1_000_000, 9_000_000], parsed.sessions);
check('sessions already on the device are skipped', plan.toAdd.length === 2 && plan.duplicates === 1
  && plan.toAdd.every(s => s.startTime !== 1_000_000));
const dupInFile = planSessionImport([], [session(1), session(1), session(2)].map(normalizeImportedSession));
check('a repeat within the file is only added once', dupInFile.toAdd.length === 2 && dupInFile.duplicates === 1);
check('importing the same file twice adds nothing the second time',
  planSessionImport(parsed.sessions.map(s => s.startTime), parsed.sessions).toAdd.length === 0);

console.log('messages');
check('plain success', importSummary({ added: 1 }) === 'Imported 1 workout.');
check('plural + skipped', importSummary({ added: 12, duplicates: 30 }) === 'Imported 12 workouts. 30 workouts already in your history were skipped.');
check('singular skipped + unreadable',
  importSummary({ added: 0, duplicates: 1, invalid: 2 }) === 'Nothing new to import. 1 workout already in your history was skipped. 2 entries couldn\u2019t be read.');

if (failures) {
  console.log(`\n${failures} history archive check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll history archive checks passed.');
