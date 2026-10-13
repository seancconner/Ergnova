// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Past 12 Months card model: metrics/year-concentration.js. Pure, no DOM or IndexedDB.
// Run with: node src/metrics/__year_concentration_smoketest__.js

import { MONTHS_SHOWN, MAX_LEVEL, concentrationLevel, buildYearConcentration } from './year-concentration.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Local-time constructors throughout: the model buckets by the LOCAL calendar
// month, so nothing here may depend on the machine's timezone.

const NOW = new Date(2026, 8, 20, 12, 0).getTime();            // Sun 20 Sep 2026 -> window Oct 2025 .. Sep 2026
const at = (year, month, day, hour = 8) => new Date(year, month, day, hour, 0).getTime(); // month is 0-based
const ride = (startTime, minutes = 60) => ({ startTime, duration: minutes * 60 });
const build = (sessions, now = NOW) => buildYearConcentration(sessions, { now });
/** The window's entry for a given calendar month. */
const monthOf = (y, year, month) => y.months.find((m) => m.year === year && m.month === month);
const windowText = (y) => y.months.map((m) => `${m.label} ${m.year}`).join(', ');

// ─── Shape ──────────────────────────────────────────────────────────────────

console.log('shape');
{
  const y = build([]);
  check('twelve months, laid out as two rows of six', y.months.length === 12 && MONTHS_SHOWN === 12);
  check('oldest first: Oct 2025 through Sep 2026', windowText(y)
    === 'Oct 2025, Nov 2025, Dec 2025, Jan 2026, Feb 2026, Mar 2026, Apr 2026, May 2026, Jun 2026, Jul 2026, Aug 2026, Sep 2026');
  check('the window spans two calendar years rather than stopping at January',
    y.months[0].year === 2025 && y.months[11].year === 2026);
  check('full month names are there for screen readers', monthOf(y, 2026, 8).name === 'September' && monthOf(y, 2025, 9).name === 'October');
  check('exactly one month is current: the last, September 2026',
    y.months.filter((m) => m.current).length === 1 && y.months[11].current && y.months[11].label === 'Sep');
  check('with no sessions there is no data and nothing is shaded',
    !y.hasData && y.totalSessions === 0 && y.totalSeconds === 0 && y.maxMonthSeconds === 0
    && y.months.every((m) => m.level === 0));
  check('no arguments at all is fine', buildYearConcentration(undefined, { now: NOW }).months.length === 12);
  check('there is no "still ahead" state any more', y.months.every((m) => !('future' in m)));
}
{
  const dec = build([], at(2026, 11, 31, 23));
  check('in December the window is exactly the calendar year (Jan..Dec 2026)',
    dec.months[0].label === 'Jan' && dec.months[0].year === 2026 && dec.months[11].label === 'Dec' && dec.months[11].current);
  const jan = build([], at(2026, 0, 1, 0));
  check('on 1 January the window is Feb of last year to Jan (the new month is already the current one)',
    jan.months[0].label === 'Feb' && jan.months[0].year === 2025 && jan.months[11].label === 'Jan' && jan.months[11].year === 2026 && jan.months[11].current);
  const leap = build([], at(2028, 1, 29, 12));
  check('a leap-year February is just another month: Mar 2027..Feb 2028', leap.months[0].label === 'Mar' && leap.months[0].year === 2027 && leap.months[11].label === 'Feb');
}
{
  const w = build([], at(2026, 8, 1, 0));
  const w2 = build([], at(2026, 8, 30, 23));
  check('the window only rolls on the 1st: first and last day of September show the same twelve months', windowText(w) === windowText(w2));
  check('and the next minute into October it has moved on one', build([], at(2026, 9, 1, 0)).months[0].label === 'Nov');
}

// ─── Which month a session lands in ────────────────────────────────────────

console.log('bucketing');
{
  const y = build([
    ride(at(2026, 1, 1)), ride(at(2026, 1, 14)), ride(at(2026, 1, 28), 30),   // three Feb rides: 60 + 60 + 30 min
    ride(at(2026, 4, 3), 45), ride(at(2026, 4, 4), 15),                       // two May rides: 45 + 15 min
    ride(at(2025, 10, 12), 90),                                               // Nov 2025: the previous calendar year
  ]);
  check('sessions in one month add up (Feb 2026: 2.5 h)', monthOf(y, 2026, 1).seconds === 150 * 60);
  check('and May is separate (1 h)', monthOf(y, 2026, 4).seconds === 60 * 60);
  check('a session from last year lands in that month of last year (Nov 2025: 1.5 h)', monthOf(y, 2025, 10).seconds === 90 * 60);
  check('everything else is empty', y.months.filter((m) => m.seconds === 0).length === 9);
}
{
  const y = build([ride(at(2026, 0, 31, 23) + 59 * 60 * 1000), ride(at(2026, 1, 1, 0))]);
  check('a ride at 23:59 on Jan 31 is January\u2019s, one at midnight on Feb 1 is February\u2019s',
    monthOf(y, 2026, 0).seconds === 3600 && monthOf(y, 2026, 1).seconds === 3600);
}
{
  const y = build([ride(at(2025, 11, 31, 23) + 59 * 60 * 1000), ride(at(2026, 0, 1, 0))]);
  check('the year boundary is no different (Dec 31 23:59 is December 2025\u2019s, Jan 1 00:00 is January 2026\u2019s)',
    monthOf(y, 2025, 11).seconds === 3600 && monthOf(y, 2026, 0).seconds === 3600);
}
{
  const leap = at(2028, 5, 1);
  const y = buildYearConcentration([ride(at(2028, 1, 29, 9))], { now: leap });
  check('Feb 29 in a leap year is February\u2019s', monthOf(y, 2028, 1).seconds === 3600);
}

// ─── What is counted ───────────────────────────────────────────────────────

console.log('what is counted');
{
  const y = build([
    ride(at(2025, 8, 30, 23)),                       // Sep 2025: the month just before the window
    ride(at(2025, 8, 20)),                           // this time last year: same month name as the current one, outside the window
    ride(at(2026, 9, 1, 0)),                         // Oct 2026: a later month
    { startTime: at(2026, 5, 10), duration: 0 },     // no duration
    { startTime: at(2026, 5, 11) },                  // no duration field
    { startTime: NaN, duration: 3600 },              // unusable date
    ride(at(2026, 5, 12)),                           // counts
  ]);
  check('only sessions in the window, with a duration and a real date, are counted', y.totalSessions === 1 && y.totalSeconds === 3600);
  check('and hasData follows', y.hasData);
  check('September of last year is not added to this September', monthOf(y, 2026, 8).seconds === 0);
}
{
  const y = build([ride(at(2025, 9, 1, 0)), ride(at(2026, 8, 30, 23))]);
  check('the first instant of the window (Oct 1 2025 00:00) and the last day of the current month are both in',
    y.totalSessions === 2 && y.months[0].seconds === 3600 && y.months[11].seconds === 3600);
}
{
  const y = build([ride(at(2026, 8, 25))]);
  check('a session later this month than now still counts for this month (a wrong clock, say)', y.months[11].seconds === 3600);
}
{
  const y = build([{ startTime: at(2026, 5, 10), duration: 0 }]);
  check('a window of only zero-length sessions has no data', !y.hasData && y.totalSessions === 0);
}
{
  const y = build([ride(at(2025, 11, 10), 60), ride(at(2026, 3, 10), 30), ride(at(2026, 8, 2), 90)]);
  check('totals: sessions and seconds across the window', y.totalSessions === 3 && y.totalSeconds === (60 + 30 + 90) * 60);
  check('the busiest month sets the scale', y.maxMonthSeconds === 90 * 60);
}
{
  const y = build([ride(at(2026, 2, 1), 30), ride(at(2026, 2, 15), 30), ride(at(2026, 2, 31), 30), ride(at(2026, 5, 9), 60)]);
  check('the scale is a month\u2019s total across its sessions (March: three 30 min rides beat June\u2019s single 60 min)',
    y.maxMonthSeconds === 90 * 60);
}

// ─── Shading levels ────────────────────────────────────────────────────────

console.log('levels');
check('nothing trained is level 0', concentrationLevel(0, 1000) === 0);
check('nothing at all to compare against is level 0, not NaN', concentrationLevel(0, 0) === 0 && concentrationLevel(5, 0) === 0);
check('exactly 25% is level 1, just over is level 2', concentrationLevel(250, 1000) === 1 && concentrationLevel(251, 1000) === 2);
check('exactly 50% is level 2, just over is level 3', concentrationLevel(500, 1000) === 2 && concentrationLevel(501, 1000) === 3);
check('exactly 75% is level 3, just over is level 4', concentrationLevel(750, 1000) === 3 && concentrationLevel(751, 1000) === 4);
check('the busiest month is the top level', concentrationLevel(1000, 1000) === MAX_LEVEL && MAX_LEVEL === 4);
check('a sliver of training still shows (level 1, not 0)', concentrationLevel(1, 100000) === 1);
{
  const y = build([ride(at(2025, 11, 3), 100), ride(at(2026, 0, 3), 20), ride(at(2026, 1, 3), 60), ride(at(2026, 1, 20), 20)]);
  check('levels are set against the busiest month of the window (Dec 2025 100 min: 4, Feb 80: 4, Jan 20: 1)',
    monthOf(y, 2025, 11).level === 4 && monthOf(y, 2026, 1).level === 4 && monthOf(y, 2026, 0).level === 1);
  check('a month with nothing in it, in a window that has data, is level 0', monthOf(y, 2026, 3).level === 0);
}
{
  const y = build([ride(at(2025, 8, 1), 600), ride(at(2026, 4, 1), 30)]);
  check('a month that has dropped out of the window no longer sets the scale (only May counts: level 4)',
    y.maxMonthSeconds === 30 * 60 && monthOf(y, 2026, 4).level === 4);
}

if (failures) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll year concentration checks passed.');
