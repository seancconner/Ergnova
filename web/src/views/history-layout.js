// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * views/history-layout.js
 *
 * The pure half of History's poster-tile list:
 * grouping sessions under calendar-week headers, the totals on each header,
 * and the three numbers on each poster. No DOM and no IndexedDB, so it runs
 * under plain node and has its own smoke test (__history_layout_smoketest__.js);
 * views/history-browser.js just turns what comes out of here into markup.
 */

import { formatDistance, formatDistanceValue, distanceUnitLabel, kgToLb, weightUnitLabel, UNITS } from '../metrics/units.js';
import { totalVolume, totalHoldTime } from '../core/strength-model.js';

const DAY = 86400000;

/** First day of the week as a JS getDay() number (0 = Sunday … 6 = Saturday).
 *  One tunable constant: Sunday. Overview's "This
 *  Week" is a rolling seven days rather than a calendar week, so the two can
 *  still disagree by a day or two. */
export const WEEK_START_DAY = 0;

/** Local-midnight timestamp of the first day of the week containing `ts`.
 *  Built from calendar fields (not `ts - n * DAY`) so a daylight-saving
 *  change inside the week can't land it an hour off midnight. */
export function weekStart(ts, startDay = WEEK_START_DAY) {
  const d = new Date(ts);
  const back = (d.getDay() - startDay + 7) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
}

function _fmt(ts, opts) { return new Date(ts).toLocaleDateString('en-US', opts); }

/** Header label for the week starting at `weekStartMs`: "This week" / "Last
 *  week" for the two most recent, otherwise the date span — "Sep 14 – 20"
 *  within a month, "Aug 31 – Sep 6" across one, with the year added once the
 *  week is not in the current year. */
export function weekLabel(weekStartMs, nowMs = Date.now()) {
  const thisWeek = weekStart(nowMs);
  if (weekStartMs === thisWeek) return 'This week';
  if (weekStartMs === weekStart(thisWeek - 1)) return 'Last week';   // the day before this week began sits in the previous one

  const first = new Date(weekStartMs);
  const last  = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 6);
  const sameMonth = first.getMonth() === last.getMonth();
  const a = _fmt(first, { month: 'short', day: 'numeric' });
  const b = sameMonth ? String(last.getDate()) : _fmt(last, { month: 'short', day: 'numeric' });
  const yr = first.getFullYear() !== new Date(nowMs).getFullYear() ? `, ${last.getFullYear()}` : '';
  return `${a} – ${b}${yr}`;
}

/** The date chip on a poster tile: "Tue 23". The week header above it already
 *  says which week, so weekday + day-of-month is what actually tells two
 *  tiles apart. */
export function chipDate(ts) {
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}`;
}

/** Totals for one week's sessions: how many, total time, and distance (only
 *  counting sessions that recorded any). */
export function weekTotals(sessions) {
  let durationSec = 0;
  let distanceM = 0;
  for (const s of sessions) {
    durationSec += s.duration || 0;
    distanceM   += s.summary?.totalDistance || 0;
  }
  return { count: sessions.length, durationSec, distanceM };
}

/** Compact duration for a header total: "4h 12m", "38m". */
export function fmtTotalTime(sec) {
  if (!sec) return '0m';
  const totalMin = Math.round(sec / 60);   // round first, then split — 59.6 min must read 1h 0m, not 60m
  const h = Math.floor(totalMin / 60);
  return h > 0 ? `${h}h ${totalMin % 60}m` : `${totalMin}m`;
}

/** "3 sessions · 4h 12m · 52.3 km" — the distance part only when the week
 *  has any. */
export function weekTotalsText(totals, units) {
  const parts = [`${totals.count} session${totals.count === 1 ? '' : 's'}`, fmtTotalTime(totals.durationSec)];
  if (totals.distanceM > 0) parts.push(formatDistance(totals.distanceM, units));
  return parts.join(' · ');
}

/** Groups entries under calendar-week headers, newest week first.
 *  @param {{s: Object, i: number}[]} entries  sessions already newest-first,
 *    each paired with its real index into the browser's session array
 *  @returns {{weekStart:number, label:string, entries:Object[], totals:Object}[]} */
export function groupByWeek(entries, nowMs = Date.now()) {
  const groups = [];
  const byStart = new Map();
  for (const e of entries) {
    const ws = weekStart(e.s.startTime);
    let g = byStart.get(ws);
    if (!g) {
      g = { weekStart: ws, label: weekLabel(ws, nowMs), entries: [], totals: null };
      byStart.set(ws, g);
      groups.push(g);
    }
    g.entries.push(e);
  }
  for (const g of groups) g.totals = weekTotals(g.entries.map(e => e.s));
  groups.sort((a, b) => b.weekStart - a.weekStart);
  return groups;
}

/** The three numbers on a poster tile, as [{val, lbl}] — TIME first, always.
 *  A strength session reads TIME / SETS / VOL (total weight moved, in the
 *  rider's unit; or total hold time when it was all holds, or REPS when it
 *  was all bodyweight), because power and distance are always dashes there.
 *  Everything else reads TIME / AVG W (distance when no power was
 *  recorded) / HR. */
export function posterNumbers(s, units) {
  const time = { val: _fmtDuration(s.duration), lbl: 'TIME', metric: 'time' };

  if (s.meta?.type === 'strength') {
    const sets = Array.isArray(s.meta.sets) ? s.meta.sets : [];
    const volKg = totalVolume(sets);
    let third;
    if (volKg > 0) {
      const v = units === UNITS.IMPERIAL ? kgToLb(volKg) : volKg;
      third = { val: Math.round(v).toLocaleString('en-US'), lbl: `VOL (${weightUnitLabel(units).toUpperCase()})`, metric: 'volume' };
    } else if (totalHoldTime(sets) > 0) {
      third = { val: _fmtDuration(totalHoldTime(sets)), lbl: 'HOLD', metric: 'hold' };
    } else {
      const reps = sets.reduce((a, x) => a + (x.reps || 0), 0);
      third = { val: reps > 0 ? String(reps) : '—', lbl: 'REPS', metric: 'reps' };
    }
    return [time, { val: sets.length ? String(sets.length) : '—', lbl: 'SETS', metric: 'sets' }, third];
  }

  const power = s.summary?.avgPower;
  const second = power != null
    ? { val: String(power), lbl: 'AVG W', metric: 'power' }
    : { val: formatDistanceValue(s.summary?.totalDistance, units), lbl: `DIST (${distanceUnitLabel(units).toUpperCase()})`, metric: 'distance' };
  return [time, second, { val: s.summary?.avgHr != null ? String(s.summary.avgHr) : '—', lbl: 'HR', metric: 'hr' }];
}

/** What an empty History category says and draws.
 *  Pure content, no markup: history-browser.js turns it into the composed empty
 *  state (a ghosted pair of poster tiles + a headline + one muted line).
 *
 *  - `cat` is one of the rail's ids: 'all' | 'ride' | 'str' | 'test'.
 *  - `hasAny` is whether History holds *any* session at all. With none, every
 *    category is empty for the same reason, so each also offers Import (the other
 *    way to fill it). With some, this category is just empty on its own, so it
 *    only says what belongs there.
 *  - `ghost` is the three labelled readouts the ghost tiles draw, matching what a
 *    real tile of that category shows (posterNumbers() above): a ride and a test
 *    read TIME / AVG W / HR, strength reads TIME / SETS / VOL.
 *  - `line` may contain the token `{+}`, which the renderer swaps for the small
 *    green glyph of the rail's start button — the same pointer Overview's
 *    first-run hero uses. It is a constant, never user text. */
export function emptyStateContent(cat, hasAny) {
  const RIDE = [
    { lbl: 'TIME', metric: 'time' }, { lbl: 'AVG W', metric: 'power' }, { lbl: 'HR', metric: 'hr' },
  ];
  const STR = [
    { lbl: 'TIME', metric: 'time' }, { lbl: 'SETS', metric: 'sets' }, { lbl: 'VOL', metric: 'volume' },
  ];
  const copy = {
    all:  { title: 'No workouts yet',          line: 'Tap {+} to start a session — every ride, strength session and test lands here.', ghost: RIDE },
    ride: { title: 'No rides yet',             line: 'Free rides and structured workouts show up here. Tap {+} to start one.',          ghost: RIDE },
    str:  { title: 'No strength sessions yet', line: 'Sets, reps and holds you log show up here. Tap {+} to start one.',                ghost: STR },
    test: { title: 'No fitness tests yet',     line: 'FTP, VO2 Max and resting heart rate tests show up here. Tap {+} to start one.',   ghost: RIDE },
  };
  const c = copy[cat] ?? copy.all;
  return { title: c.title, line: c.line, ghost: c.ghost, showImport: !hasAny };
}

/** "42m" / "1h 5m" — no seconds: a poster has no room for them. */
function _fmtDuration(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
