// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/views/__history_layout_smoketest__.js
//
// Covers views/history-layout.js (week grouping, header labels and totals,
// poster numbers) and views/session-poster.js's sparkline and tile body — the pure
// parts of History's poster-tile list (and of Overview's Recent strip, which draws
// the same tile). Dates are built from local calendar fields, so
// the checks hold in any time zone.

import {
  WEEK_START_DAY, weekStart, weekLabel, weekTotals, fmtTotalTime, weekTotalsText, groupByWeek, posterNumbers, chipDate, emptyStateContent,
} from './history-layout.js';
import { sparkline, posterTileBody } from './session-poster.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();   // local time, month 1-based

console.log('week start');
// 2026-09-30 is a Wednesday; with a Sunday start its week began Sun Sep 27.
check('the default week starts on Sunday', WEEK_START_DAY === 0);
check('a Wednesday maps to that week\'s Sunday at local midnight', weekStart(at(2026, 9, 30)) === at(2026, 9, 27, 0));
check('the Sunday itself maps to itself', weekStart(at(2026, 9, 27, 0)) === at(2026, 9, 27, 0));
check('a Sunday evening belongs to the week it starts, not the one before', weekStart(at(2026, 9, 27, 23)) === at(2026, 9, 27, 0));
check('a Saturday belongs to the week that began the Sunday before', weekStart(at(2026, 9, 26, 23)) === at(2026, 9, 20, 0));
check('a Monday-start week is still available as an argument', weekStart(at(2026, 9, 30), 1) === at(2026, 9, 28, 0));
check('the week start works across a month boundary', weekStart(at(2026, 10, 1)) === at(2026, 9, 27, 0));
check('the week start works across a year boundary', weekStart(at(2027, 1, 1)) === at(2026, 12, 27, 0));

console.log('\nweek labels');
const now = at(2026, 9, 30);
check('the current week reads "This week"', weekLabel(at(2026, 9, 27, 0), now) === 'This week');
check('the week before reads "Last week"', weekLabel(at(2026, 9, 20, 0), now) === 'Last week');
check('an older week inside one month reads "Sep 6 – 12"', weekLabel(at(2026, 9, 6, 0), now) === 'Sep 6 – 12', weekLabel(at(2026, 9, 6, 0), now));
check('a week spanning two months names both', weekLabel(at(2026, 8, 30, 0), now) === 'Aug 30 – Sep 5', weekLabel(at(2026, 8, 30, 0), now));
check('a week in an earlier year carries the year', weekLabel(at(2025, 12, 28, 0), now) === 'Dec 28 – Jan 3, 2026', weekLabel(at(2025, 12, 28, 0), now));
check('"Last week" still works when the week before crosses a month', weekLabel(at(2026, 9, 27, 0), at(2026, 10, 7)) === 'Last week');

console.log('\nweek totals');
const a = { startTime: at(2026, 9, 29), duration: 2520, summary: { totalDistance: 18900 }, meta: {} };
const b = { startTime: at(2026, 9, 28), duration: 3300, summary: { totalDistance: null }, meta: { type: 'strength', sets: [] } };
const t = weekTotals([a, b]);
check('counts sessions', t.count === 2);
check('sums time', t.durationSec === 5820);
check('sums distance and skips sessions without any', t.distanceM === 18900);
check('formats total time with hours', fmtTotalTime(15120) === '4h 12m');
check('formats total time under an hour', fmtTotalTime(2280) === '38m');
check('rounds 59.6 minutes up to the next hour cleanly', fmtTotalTime(3576) === '1h 0m', fmtTotalTime(3576));
check('totals text includes distance when there is some', weekTotalsText(t, 'metric') === '2 sessions · 1h 37m · 18.9 km', weekTotalsText(t, 'metric'));
check('totals text drops distance when there is none', weekTotalsText(weekTotals([b]), 'metric') === '1 session · 55m', weekTotalsText(weekTotals([b]), 'metric'));
check('totals text honors imperial', weekTotalsText(t, 'imperial').endsWith('11.7 mi'), weekTotalsText(t, 'imperial'));

console.log('\ngrouping');
const sessions = [
  { startTime: at(2026, 9, 30, 6),  duration: 600, summary: {} },
  { startTime: at(2026, 9, 29, 18), duration: 600, summary: {} },
  { startTime: at(2026, 9, 27, 7),  duration: 600, summary: {} },   // Sunday → starts this week
  { startTime: at(2026, 9, 26, 23), duration: 600, summary: {} },   // Saturday → last week
  { startTime: at(2026, 9, 14, 7),  duration: 600, summary: {} },
];
const groups = groupByWeek(sessions.map((s, i) => ({ s, i })), now);
check('five sessions fall into three weeks', groups.length === 3, String(groups.length));
check('newest week first', groups[0].weekStart > groups[1].weekStart && groups[1].weekStart > groups[2].weekStart);
check('the three newest sessions share "This week"', groups[0].label === 'This week' && groups[0].entries.length === 3);
check('a Sunday session lands in "This week", the week it starts', groups[0].entries[2].i === 2);
check('a Saturday session lands in "Last week"', groups[1].label === 'Last week' && groups[1].entries[0].i === 3);
check('entries keep their original index', groups[2].entries[0].i === 4);
check('each group carries its own totals', groups[0].totals.count === 3 && groups[0].totals.durationSec === 1800);
check('no sessions gives no groups', groupByWeek([], now).length === 0);
check('order inside a week is preserved (newest first)', groups[0].entries.map(e => e.i).join() === '0,1,2');

console.log('\nchip date');
check('a chip reads weekday + day of month', chipDate(at(2026, 9, 29, 18)) === 'Tue 29', chipDate(at(2026, 9, 29, 18)));
check('a single-digit day has no leading zero', chipDate(at(2026, 9, 6)) === 'Sun 6', chipDate(at(2026, 9, 6)));

console.log('\nposter numbers');
const ride = { duration: 2520, summary: { avgPower: 182, avgHr: 164, totalDistance: 18900 }, meta: {} };
let n = posterNumbers(ride, 'metric');
check('a ride reads TIME / AVG W / HR', n.map(x => x.lbl).join() === 'TIME,AVG W,HR' && n[0].val === '42m' && n[1].val === '182' && n[2].val === '164', JSON.stringify(n));
check('every ride number is tagged with its metric', n.map(x => x.metric).join() === 'time,power,hr', JSON.stringify(n));
n = posterNumbers({ duration: 3900, summary: { avgPower: null, avgHr: null, totalDistance: 29200 }, meta: {} }, 'metric');
check('no power: the middle number is tagged distance', n[1].metric === 'distance', JSON.stringify(n));
check('no power falls back to distance in the rider\'s unit', n[1].lbl === 'DIST (KM)' && n[1].val === '29.2' && n[2].val === '—', JSON.stringify(n));
n = posterNumbers({ duration: 3900, summary: { totalDistance: 29200 }, meta: {} }, 'imperial');
check('imperial distance is in miles', n[1].lbl === 'DIST (MI)' && n[1].val === '18.1', JSON.stringify(n));
check('no duration shows a dash, not 0m', posterNumbers({ summary: {}, meta: {} }, 'metric')[0].val === '—');

const sets = [
  { mode: 'reps', reps: 8, weight: 80 }, { mode: 'reps', reps: 8, weight: 80 }, { mode: 'reps', reps: 8, weight: 60 },
];
n = posterNumbers({ duration: 3300, summary: { avgHr: 101 }, meta: { type: 'strength', sets } }, 'metric');
check('strength reads TIME / SETS / VOL', n.map(x => x.lbl).join() === 'TIME,SETS,VOL (KG)', JSON.stringify(n));
check('strength numbers are tagged time / sets / volume', n.map(x => x.metric).join() === 'time,sets,volume', JSON.stringify(n));
check('strength volume is weight x reps summed', n[2].val === '1,760' && n[1].val === '3', JSON.stringify(n));
n = posterNumbers({ duration: 3300, summary: {}, meta: { type: 'strength', sets } }, 'imperial');
check('strength volume converts to lb', n[2].lbl === 'VOL (LB)' && n[2].val === '3,880', JSON.stringify(n));
n = posterNumbers({ duration: 600, summary: {}, meta: { type: 'strength', sets: [{ mode: 'hold', holdSeconds: 90 }, { mode: 'hold', holdSeconds: 30 }] } }, 'metric');
check('an all-holds session shows total hold time', n[2].lbl === 'HOLD' && n[2].val === '2m', JSON.stringify(n));
n = posterNumbers({ duration: 600, summary: {}, meta: { type: 'strength', sets: [{ mode: 'reps', reps: 10, weight: null }, { mode: 'reps', reps: 12, weight: null }] } }, 'metric');
check('an all-bodyweight session shows total reps', n[2].lbl === 'REPS' && n[2].val === '22', JSON.stringify(n));
n = posterNumbers({ duration: 600, summary: {}, meta: { type: 'strength' } }, 'metric');
check('a strength session with no sets recorded still renders', n[1].val === '—' && n[2].val === '—', JSON.stringify(n));

console.log('\nsparkline');
const pw = Array.from({ length: 100 }, (_, i) => ({ power: 100 + (i % 10) * 10, heartRate: 120 }));
check('draws a polyline for a session with power', /<polyline points="/.test(sparkline(pw) ?? ''));
check('tags the line with the metric it plots', sparkline(pw).includes('data-series="power"')
  && sparkline(pw.map(x => ({ power: null, heartRate: x.power }))).includes('data-series="heartRate"')
  && sparkline(pw.map(x => ({ power: null, heartRate: null, speed: x.power }))).includes('data-series="speed"'));
check('caps the line at 40 points', (sparkline(pw).match(/,/g) || []).length === 40);
check('falls back to heart rate when there is no power', !!sparkline(pw.map(x => ({ power: null, heartRate: x.power }))));
check('no signature metric gives null', sparkline([{ power: null, heartRate: null, speed: null }, { power: null, heartRate: null, speed: null }]) === null);
check('no samples gives null', sparkline([]) === null && sparkline(undefined) === null);
check('a dead-flat session does not divide by zero', !/NaN|Infinity/.test(sparkline(Array.from({ length: 10 }, () => ({ power: 150 })))));

console.log('\nposter tile body (shared by History and Overview\'s Recent strip)');
const rideSession = { startTime: at(2026, 9, 29), duration: 3720, workoutName: 'Sweet <Spot>', samples: pw, summary: { avgPower: 214, avgHr: 148 }, meta: {} };
const body = posterTileBody(rideSession, 'metric');
check('carries the date chip, the name, the sparkline and the readouts',
  body.includes('history-poster-chip') && body.includes('history-poster-name') && body.includes('history-poster-spark') && body.includes('history-poster-stats'));
check('the chip is the weekday + day-of-month', body.includes(`>${chipDate(rideSession.startTime)}<`));
check('the name is escaped', body.includes('Sweet &lt;Spot&gt;') && !body.includes('<Spot>'));
check('three readouts, each tagged with its data-metric', (body.match(/data-metric="/g) || []).length === 3
  && ['time', 'power', 'hr'].every(m => body.includes(`data-metric="${m}"`)));
check('a session with no samples draws the plain strip instead of a sparkline',
  posterTileBody({ ...rideSession, samples: [] }, 'metric').includes('history-poster-spark-empty'));
check('a nameless session reads Free Ride', posterTileBody({ ...rideSession, workoutName: null }, 'metric').includes('>Free Ride<'));
check('a strength session gets the SETS readout, like History',
  posterTileBody({ startTime: at(2026, 9, 29), duration: 600, summary: {}, meta: { type: 'strength', sets: [{ reps: 5, weightKg: 20 }] } }, 'metric').includes('data-metric="sets"'));

console.log('\nempty state');
let e = emptyStateContent('all', false);
check('no history at all: names the page and offers Import', e.title === 'No workouts yet' && e.showImport === true, JSON.stringify(e));
check('every category offers Import while History is empty', ['all', 'ride', 'str', 'test'].every(c => emptyStateContent(c, false).showImport));
check('a category that is empty on its own does not offer Import', ['all', 'ride', 'str', 'test'].every(c => emptyStateContent(c, true).showImport === false));
check('each category has its own title', new Set(['all', 'ride', 'str', 'test'].map(c => emptyStateContent(c, true).title)).size === 4);
check('strength ghosts TIME / SETS / VOL, like a real strength tile', emptyStateContent('str', true).ghost.map(x => x.lbl).join() === 'TIME,SETS,VOL');
check('rides and tests ghost TIME / AVG W / HR, like a real ride tile', ['ride', 'test', 'all'].every(c => emptyStateContent(c, true).ghost.map(x => x.lbl).join() === 'TIME,AVG W,HR'));
check('ghost metric keys match what posterNumbers() tags', emptyStateContent('str', true).ghost.map(x => x.metric).join() === 'time,sets,volume' && emptyStateContent('ride', true).ghost.map(x => x.metric).join() === 'time,power,hr');
check('every line points at the + button exactly once', ['all', 'ride', 'str', 'test'].every(c => (emptyStateContent(c, true).line.match(/\{\+\}/g) || []).length === 1));
check('an unknown category falls back to the All copy', emptyStateContent('nope', true).title === 'No workouts yet');

console.log(failures === 0 ? '\nAll history layout checks passed.' : `\n${failures} history layout check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
