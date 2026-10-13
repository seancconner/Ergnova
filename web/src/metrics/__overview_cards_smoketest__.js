// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Overview card readiness, needs text and ordering: metrics/overview-cards.js.
// Pure, no DOM or IndexedDB.
// Run with: node src/metrics/__overview_cards_smoketest__.js

import {
  OVERVIEW_CARD_ORDER, OVERVIEW_NEEDS, OVERVIEW_TREND_WEEKS, overviewReadiness, orderOverviewCards,
} from './overview-cards.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 20, 12, 0).getTime();
const ago = (days) => NOW - days * DAY;

const powerSamples = [{ power: 180 }, { power: 210 }];
const noPowerSamples = [{ power: null, heartRate: 140 }, { power: null, heartRate: 142 }];
const session = (startTime, extra = {}) => ({ startTime, duration: 1800, samples: powerSamples, summary: {}, ...extra });
const diary = (loggedAt) => ({ loggedAt, nutrients: {} });
const weighIn = (measuredAt, weightKg) => ({
  id: measuredAt, measuredAt, source: 'ble-scale', weightKg,
  bodyFatPct: null, leanBodyMassKg: null, muscleMassKg: null, boneMassKg: null,
  bodyWaterKg: null, visceralFatRating: null, basalMetabolicRateKcal: null,
});
const profile = { ftp: 200, riderWeight: 75, units: 'metric', vo2Max: null };

const ready = (data, p = profile) => overviewReadiness({ profile: p, ...data }, { now: NOW });
const idsWhere = (r, want) => OVERVIEW_CARD_ORDER.filter((id) => r[id] === want);

// ─── Nothing recorded yet ───────────────────────────────────────────────────

console.log('nothing recorded yet');
{
  const r = overviewReadiness(undefined, { now: NOW });
  check('with no arguments at all, nothing is ready', idsWhere(r, true).length === 0);
  check('a result has exactly one entry per card', Object.keys(r).sort().join() === [...OVERVIEW_CARD_ORDER].sort().join());
}
{
  const r = ready({});
  check('no sessions, diary or weigh-ins: only Power-to-Weight and FTP are ready (both are on the profile)',
    idsWhere(r, true).join() === 'pwr,ftp');
  const r2 = ready({}, { units: 'metric' });
  check('with no FTP or weight either, nothing is ready', idsWhere(r2, true).length === 0);
}

// The profile a first launch has: app.js leaves ftp and riderWeight null until the
// rider enters them, so the Power-to-Weight card must not be ready off nothing.
console.log('first launch');
{
  const fresh = { ftp: null, riderWeight: null, units: 'metric', vo2Max: null };
  check('a fresh profile (no FTP, no weight entered) makes no card ready', idsWhere(ready({}, fresh), true).length === 0);
  check('Power-to-Weight sits with the empty cards until both are entered',
    orderOverviewCards(ready({}, fresh)).join() === OVERVIEW_CARD_ORDER.join());
}

// ─── Each card's own rule ───────────────────────────────────────────────────

console.log('This Week');
check('a session 6 days 23 hours ago counts', ready({ sessions: [session(ago(7) + 60 * 60 * 1000)] }).week);
check('a session exactly 7 days ago does not', !ready({ sessions: [session(ago(7))] }).week);
check('an older session alone does not', !ready({ sessions: [session(ago(20))] }).week);

console.log('Past 12 Months');
// NOW is 20 Sep 2026, so the window is the calendar months Oct 2025 .. Sep 2026.
check('a session a few months ago counts', ready({ sessions: [session(ago(100))] }).year);
check('a session in December of last year counts (it would have missed a calendar-year card)', ready({ sessions: [session(new Date(2025, 11, 31, 23, 59).getTime())] }).year);
check('a session on the first instant of the window (1 Oct 2025) counts', ready({ sessions: [session(new Date(2025, 9, 1, 0, 0).getTime())] }).year);
check('a session in the last minute before the window (30 Sep 2025) does not', !ready({ sessions: [session(new Date(2025, 8, 30, 23, 59).getTime())] }).year);
check('a session this time last year does not', !ready({ sessions: [session(ago(365))] }).year);
check('a session with no duration does not', !ready({ sessions: [session(ago(100), { duration: 0 })] }).year);
check('no sessions does not', !ready({ sessions: [] }).year);

console.log('Weekly Volume');
check('a session 55 days ago is inside the 8 weeks', ready({ sessions: [session(ago(55))] }).volume);
check('a session 56 days ago is outside them', !ready({ sessions: [session(ago(56))] }).volume);
check('a session with no duration adds no minutes, so is not enough',
  !ready({ sessions: [session(ago(2), { duration: 0 })] }).volume);
check('a session dated in the future is not in any week bucket', !ready({ sessions: [session(NOW + DAY)] }).volume);
check('the window is the trend length the card draws', OVERVIEW_TREND_WEEKS === 8);

console.log('Weekly Nutrition');
check('a meal logged 6 days ago counts', ready({ diaryEntries: [diary(ago(6))] }).nutrition);
check('a meal logged 7 days ago does not', !ready({ diaryEntries: [diary(ago(7))] }).nutrition);

console.log('Weight & Composition');
check('one weigh-in is enough', ready({ bodyMeasurements: [weighIn(ago(3), 75.2)] }).body);
check('no weigh-ins is not', !ready({ bodyMeasurements: [] }).body);
check('weigh-ins are enough with no sessions at all',
  ready({ bodyMeasurements: [weighIn(ago(3), 75.2)] }).body && !ready({ bodyMeasurements: [weighIn(ago(3), 75.2)] }).recent);

console.log('Power Zones');
check('a session with power data in the last 30 days counts', ready({ sessions: [session(ago(10))] }).zones);
check('power of exactly 0 W is still power data',
  ready({ sessions: [session(ago(10), { samples: [{ power: 0 }] })] }).zones);
check('a session with no power meter does not', !ready({ sessions: [session(ago(10), { samples: noPowerSamples })] }).zones);
check('a session with no samples at all does not', !ready({ sessions: [session(ago(10), { samples: undefined })] }).zones);
check('power data older than 30 days does not', !ready({ sessions: [session(ago(31))] }).zones);
check('one session with power among ones without is enough',
  ready({ sessions: [session(ago(2), { samples: noPowerSamples }), session(ago(9))] }).zones);

console.log('Power-to-Weight');
check('needs both FTP and weight', ready({}, { ftp: 250, riderWeight: 80 }).pwr);
check('FTP alone is not enough', !ready({}, { ftp: 250, riderWeight: null }).pwr);
check('weight alone is not enough', !ready({}, { ftp: null, riderWeight: 80 }).pwr);

console.log('VO2 Max');
check('a stored estimate makes it ready', ready({}, { ...profile, vo2Max: 48 }).vo2max);
check('no estimate does not', !ready({}, { ...profile, vo2Max: null }).vo2max);

console.log('Heart, FTP, Heart Rate Zones');
check('a resting HR alone makes Heart ready', ready({}, { ...profile, restingHr: 52, maxHr: null }).heart);
check('a max HR alone makes Heart ready', ready({}, { ...profile, restingHr: null, maxHr: 187 }).heart);
check('neither makes Heart not ready', !ready({}, { ...profile, restingHr: null, maxHr: null }).heart);
check('an FTP on file makes FTP ready', ready({}, { ...profile, ftp: 250 }).ftp);
check('no FTP does not', !ready({}, { ...profile, ftp: null }).ftp);
check('a session with heart-rate data in the last 30 days, plus a max HR, is enough for Heart Rate Zones',
  ready({ sessions: [session(ago(2), { samples: noPowerSamples })] }, { ...profile, maxHr: 187 }).hrzones);
check('an age to estimate max HR from is enough too',
  ready({ sessions: [session(ago(2), { samples: noPowerSamples })] }, { ...profile, maxHr: null, age: 34 }).hrzones);
check('no resolvable max HR (measured or estimated) is not enough, even with HR data',
  !ready({ sessions: [session(ago(2), { samples: noPowerSamples })] }, { ...profile, maxHr: null, age: null }).hrzones);
check('HR data older than 30 days does not count',
  !ready({ sessions: [session(ago(31), { samples: noPowerSamples })] }, { ...profile, maxHr: 187 }).hrzones);
check('a session with a max HR but no heart-rate strap does not',
  !ready({ sessions: [session(ago(2))] }, { ...profile, maxHr: 187 }).hrzones);

console.log('Personal Bests and Recent Sessions');
{
  const bare = session(ago(2), { duration: 0, samples: noPowerSamples, summary: {} });
  const r = ready({ sessions: [bare] });
  check('a session with nothing to record a best from leaves Bests empty', !r.bests);
  check('but it is still a recent session', r.recent);
}
check('a duration is a best', ready({ sessions: [session(ago(2), { samples: noPowerSamples })] }).bests);
check('peak power alone is a best',
  ready({ sessions: [session(ago(2), { duration: 0, samples: [{ power: 300 }], summary: {} })] }).bests);
check('a distance alone is a best',
  ready({ sessions: [session(ago(2), { duration: 0, samples: noPowerSamples, summary: { totalDistance: 12000 } })] }).bests);
check('normalized power alone is a best',
  ready({ sessions: [session(ago(2), { duration: 0, samples: noPowerSamples, summary: { normalizedPower: 190 } })] }).bests);

// ─── Ordering ───────────────────────────────────────────────────────────────

console.log('ordering');
check('Past 12 Months sits straight after This Week by default', OVERVIEW_CARD_ORDER.indexOf('year') === OVERVIEW_CARD_ORDER.indexOf('week') + 1);
{
  const none = Object.fromEntries(OVERVIEW_CARD_ORDER.map((id) => [id, false]));
  const all  = Object.fromEntries(OVERVIEW_CARD_ORDER.map((id) => [id, true]));
  check('everything ready keeps the default order', orderOverviewCards(all).join() === OVERVIEW_CARD_ORDER.join());
  check('nothing ready keeps the default order', orderOverviewCards(none).join() === OVERVIEW_CARD_ORDER.join());
  check('every card is listed exactly once', new Set(orderOverviewCards({ ...none, body: true })).size === OVERVIEW_CARD_ORDER.length);

  const mixed = { ...none, body: true, pwr: true, week: false, recent: true };
  check('cards with data come first, in default order, then the rest in default order',
    orderOverviewCards(mixed).join() === ['body', 'pwr', 'recent', 'week', 'year', 'volume', 'nutrition', 'zones', 'vo2max', 'bests', 'heart', 'ftp', 'hrzones'].join());
  check('a missing entry counts as not ready', orderOverviewCards({ body: true })[0] === 'body' && orderOverviewCards({}).length === OVERVIEW_CARD_ORDER.length);
}
{
  // The situation this exists for: weigh-ins and a profile, no workouts yet.
  // The fixture profile (line 30) also has an FTP on file, so the new FTP
  // readout card leads too, same as Power-to-Weight already does.
  const r = ready({ bodyMeasurements: [weighIn(ago(1), 74.9)] });
  const order = orderOverviewCards(r);
  check('weigh-ins with no workouts: Weight & Composition, Power-to-Weight and FTP lead, the workout cards follow',
    order.slice(0, 3).join() === 'body,pwr,ftp' && order.slice(3).join() === 'week,year,volume,nutrition,zones,vo2max,bests,recent,heart,hrzones');
}

// ─── Needs text ─────────────────────────────────────────────────────────────

console.log('needs text');
check('every card has a needs line and nothing else does',
  Object.keys(OVERVIEW_NEEDS).sort().join() === [...OVERVIEW_CARD_ORDER].sort().join());
// 48 characters is the most that stayed on one line on a 360px-wide phone when measured
// (Inter, 12px, "Needs" label included); the old 58- and 65-character lines wrapped there.
check('each one is a short sentence (48 characters at most, ends with a full stop)',
  OVERVIEW_CARD_ORDER.every((id) => OVERVIEW_NEEDS[id].length <= 48 && OVERVIEW_NEEDS[id].endsWith('.')));
check('the VO2 Max line names weight too, since the estimate needs it',
  /weight/i.test(OVERVIEW_NEEDS.vo2max));
check('the ones that live in Settings say where',
  ['body', 'pwr', 'vo2max'].every((id) => OVERVIEW_NEEDS[id].includes('Settings')));

if (failures) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll overview card checks passed.');
