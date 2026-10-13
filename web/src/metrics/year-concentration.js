// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/year-concentration.js
 *
 * How much was trained in each of the past 12 months, for the Overview's
 * "Past 12 Months" card (views/overview.js's _yearCard()). Twelve months, one
 * square each, oldest first and ending with the current month, shaded by how
 * much time was trained in that month relative to the busiest month in the
 * window, so a glance shows which months were heavy and which were light.
 * Pure: no DOM, no IndexedDB; this decides what to draw and the view only lays
 * it out (same split as metrics/body-history.js).
 *
 * "Past 12 months" means calendar months: the current month (so far) plus the
 * eleven before it, so on 20 Sep 2026 the window runs Oct 2025 to Sep 2026.
 * It rolls forward on the first of each month, not day by day. Every month in
 * it has started, so unlike a calendar-year view nothing is "still ahead".
 * (The file keeps its old name, from when this was a This Year card.)
 *
 * Time zone: sessions land on the LOCAL calendar month they started in, same as
 * the rest of the Overview (its streak and diary grouping use toDateString()).
 * A ride that crosses midnight at the end of a month counts entirely for the
 * month it started in.
 *
 * Levels: 0 is "nothing trained this month"; 1-4 split the range up to the
 * busiest month into four even steps (<=25%, <=50%, <=75%, above). Linear on
 * purpose — it is the honest scale — at the cost that one huge month can flatten
 * the rest toward level 1. The current month is still filling up, so it will
 * usually read lighter than it will end up.
 *
 * Usage:
 *   const y = buildYearConcentration(sessions);   // sessions: db.getSessions()
 *   if (y.hasData) for (const m of y.months) draw(m.label, m.year, m.level);
 */

const MONTH_LABELS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

/** Months in the window (the card draws them as two rows of six). */
export const MONTHS_SHOWN = 12;

/** Highest shading level; levels run 0..MAX_LEVEL. */
export const MAX_LEVEL = 4;

/** Which shading level a month with `seconds` trained gets, given the busiest month's `maxSeconds`. */
export function concentrationLevel(seconds, maxSeconds) {
  if (!(seconds > 0) || !(maxSeconds > 0)) return 0;
  const ratio = seconds / maxSeconds;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** A month as one number, so "which month is this session in, relative to now" is a subtraction. */
const monthKey = (date) => date.getFullYear() * 12 + date.getMonth();

/**
 * @param {Object[]} sessions  db.getSessions() — only `startTime` (ms) and `duration` (seconds) are read.
 * @param {Object}   [opts]
 * @param {number}   [opts.now=Date.now()]  Decides which month is the current (last) one.
 * @returns {{
 *   months: Array<{
 *     month: number, year: number, label: string, name: string, current: boolean,
 *     seconds: number, level: number,
 *   }>,
 *   totalSeconds: number, totalSessions: number, maxMonthSeconds: number, hasData: boolean,
 * }}
 *   `months` is oldest first; `month` is 0-11 and `year` the calendar year that
 *   month belongs to (the window usually spans two). `hasData` is whether any
 *   session with a duration falls in the window; sessions with no duration add
 *   nothing and are not counted, nor are ones before the window or in a later month.
 */
export function buildYearConcentration(sessions, { now = Date.now() } = {}) {
  const currentKey = monthKey(new Date(now));
  const firstKey = currentKey - (MONTHS_SHOWN - 1);

  const months = Array.from({ length: MONTHS_SHOWN }, (_, i) => {
    const key = firstKey + i;
    const month = key % 12;
    return {
      month, year: Math.floor(key / 12), label: MONTH_LABELS[month], name: MONTH_NAMES[month],
      current: key === currentKey, seconds: 0, level: 0,
    };
  });

  let totalSeconds = 0;
  let totalSessions = 0;
  for (const s of sessions ?? []) {
    if (!(s?.duration > 0)) continue;
    const slot = monthKey(new Date(s.startTime)) - firstKey;   // NaN for an unusable date, which fails both tests
    if (!(slot >= 0 && slot < MONTHS_SHOWN)) continue;
    months[slot].seconds += s.duration;
    totalSeconds += s.duration;
    totalSessions++;
  }

  let maxMonthSeconds = 0;
  for (const m of months) if (m.seconds > maxMonthSeconds) maxMonthSeconds = m.seconds;
  for (const m of months) m.level = concentrationLevel(m.seconds, maxMonthSeconds);

  return { months, totalSeconds, totalSessions, maxMonthSeconds, hasData: totalSessions > 0 };
}

export default { MONTHS_SHOWN, MAX_LEVEL, concentrationLevel, buildYearConcentration };
