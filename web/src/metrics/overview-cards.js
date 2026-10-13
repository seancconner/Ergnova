// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/overview-cards.js
 *
 * Which Overview cards have enough data to draw, what each one still needs
 * when it doesn't, and the order they go in on screen. Pure — no DOM, no
 * IndexedDB — so views/overview.js only lays out what this decides, the same
 * split it already has with metrics/body-history.js.
 *
 * Every card is always on the page. One with enough data shows it; one
 * without shows a single line saying what it needs (OVERVIEW_NEEDS). Ready
 * cards come first, in OVERVIEW_CARD_ORDER's order, then the empty ones in
 * that same order — so a card moves up the moment it has data and nothing
 * else reshuffles.
 *
 * Each rule in overviewReadiness() mirrors what its card actually draws
 * (same window, same "is there anything to plot" test as the aggregate that
 * feeds it in views/overview.js), so a card is never "ready" and then blank,
 * or "empty" while it could have shown something. If you change what a card
 * draws, change its rule here and its line in OVERVIEW_NEEDS with it — the
 * smoke test (__overview_cards_smoketest__.js) pins the window edges.
 *
 * Usage:
 *   const ready = overviewReadiness({ sessions, diaryEntries, bodyMeasurements, profile });
 *   for (const id of orderOverviewCards(ready)) { ... ready[id] ? drawCard(id) : drawEmpty(id, OVERVIEW_NEEDS[id]) }
 */

import { buildBodyHistory } from './body-history.js';
import { buildYearConcentration, MONTHS_SHOWN } from './year-concentration.js';
import { estimateMaxHr } from './hr-zones.js';

const DAY = 24 * 60 * 60 * 1000;

/** How many weeks the Weekly Volume card plots — views/overview.js draws this many bars. */
export const OVERVIEW_TREND_WEEKS = 8;

/** Card ids in their default on-screen order (the order before ready/empty grouping). */
export const OVERVIEW_CARD_ORDER = Object.freeze([
  'week',      // This Week
  'year',      // Past 12 Months
  'volume',    // Weekly Volume
  'nutrition', // Weekly Nutrition
  'body',      // Weight & Composition
  'zones',     // Power Zones — Last 30 Days
  'pwr',       // Power-to-Weight
  'vo2max',    // VO2 Max
  'bests',     // Personal Bests
  'recent',    // Recent Sessions
  'heart',     // Heart (resting/max HR) — Body category
  'ftp',       // FTP readout — Zones category
  'hrzones',   // Heart Rate Zones — Last 30 Days — Zones category
]);

/** What each card needs, as the one line an empty card shows after "Needs". Short on
 *  purpose: it is the whole body of the card, and each line has to stay on ONE line on a
 *  phone. Measured with the "Needs" label included, in Inter at the card's 12px, the longest
 *  of these (VO2 Max) is ~306px against the ~334px of text width a 360px-wide screen gives
 *  the card, so they fit with a little to spare — a longer line wraps. Where to go is named
 *  only when it isn't obvious from the card itself. */
export const OVERVIEW_NEEDS = Object.freeze({
  week:      'session in last 7 days.',
  year:      `session in last ${MONTHS_SHOWN} months.`,
  volume:    `session in last ${OVERVIEW_TREND_WEEKS} weeks.`,
  nutrition: 'meal logged in last 7 days.',
  body:      'weigh-in \u2014 sync scale in Settings.',
  zones:     'session with power in last 30 days.',
  pwr:       'your FTP and weight in Settings \u2192 Profile.',
  vo2max:    'ramp test, age, sex, weight in Settings.',
  bests:     'completed session.',
  recent:    'completed session.',
  heart:     'resting or max HR in Settings \u2192 Testing.',
  ftp:       'FTP in Settings \u2192 Testing.',
  hrzones:   'session with heart rate in last 30 days.',
});

/** Card ids whose OVERVIEW_NEEDS line above is "a session/completed session
 *  ...": nothing to type into for these, so app.js's Overview needs-tap-
 *  through (an empty card's onNeedsCardTap) just pops the FAB menu open and
 *  highlights its two session-starting entries there, rather than linking
 *  to a Settings/Diet field the way every other card does. */
export const OVERVIEW_SESSION_CARDS = Object.freeze(['week', 'year', 'volume', 'zones', 'hrzones', 'bests', 'recent']);

const _hasPowerData = (session) => (session.samples ?? []).some((x) => Number.isFinite(x?.power));
const _hasHrData    = (session) => (session.samples ?? []).some((x) => Number.isFinite(x?.heartRate));

/** True if the Personal Bests card would fill in at least one of its four cells for this session. */
const _hasAnyBest = (session) =>
  session.duration > 0
  || session.summary?.normalizedPower > 0
  || session.summary?.totalDistance > 0
  || (session.samples ?? []).some((x) => x?.power > 0);

/**
 * Whether each card has enough data to show.
 *
 * @param {Object}   data
 * @param {Object[]} [data.sessions=[]]          db.getSessions()
 * @param {Object[]} [data.diaryEntries=[]]      db.getDiaryEntries()
 * @param {Object[]} [data.bodyMeasurements=[]]  db.getBodyMeasurements()
 * @param {Object}   [data.profile={}]           the live profile (ftp, riderWeight, units, vo2Max) — ftp and
 *                                               riderWeight are null until the rider has entered them
 * @param {Object}   [opts]
 * @param {number}   [opts.now=Date.now()]
 * @returns {Object<string, boolean>}  one entry per id in OVERVIEW_CARD_ORDER
 */
export function overviewReadiness(
  { sessions = [], diaryEntries = [], bodyMeasurements = [], profile = {} } = {},
  { now = Date.now() } = {},
) {
  const within = (t, days) => now - t < days * DAY;

  return {
    week: sessions.some((s) => within(s.startTime, 7)),

    // Same test the card draws from: a session with a duration, started in the
    // current calendar month or one of the 11 before it (metrics/year-concentration.js).
    year: buildYearConcentration(sessions, { now }).hasData,

    // _weeklyTrend()'s own window: a bucket only exists for a session that started
    // between now and OVERVIEW_TREND_WEEKS weeks ago (not in the future), and
    // only adds minutes if it has a duration.
    volume: sessions.some((s) => s.duration > 0
      && now - s.startTime >= 0
      && within(s.startTime, 7 * OVERVIEW_TREND_WEEKS)),

    nutrition: diaryEntries.some((e) => within(e.loggedAt, 7)),

    body: !buildBodyHistory(bodyMeasurements, { units: profile.units, now }).empty,

    // A session with no power meter or smart trainer has `power: null` on every
    // sample, which would draw as an empty zone strip — that is not "has data".
    zones: sessions.some((s) => within(s.startTime, 30) && _hasPowerData(s)),

    // Both must have been entered by the rider: the profile leaves ftp and riderWeight
    // null until then (app.js), so a fresh install has no ratio to show yet.
    pwr: Boolean(profile.ftp && profile.riderWeight),

    vo2max: profile.vo2Max != null,

    bests: sessions.some(_hasAnyBest),

    recent: sessions.length > 0,

    // Either a measured resting HR or a measured/estimated max HR is
    // enough for the card to show something — see views/overview.js's
    // _heartCard(), which reads whichever of the two it has and falls
    // back to "—" for the other rather than requiring both.
    heart: profile.restingHr != null || profile.maxHr != null,

    ftp: profile.ftp != null,

    // Same shape as `zones` above (a session with power data in the last
    // 30 days): a session with no heart-rate strap has `heartRate: null`
    // on every sample, which would draw as an empty zone strip — and
    // without a resolvable max HR there's no boundary to bucket against
    // at all (timeInZonesHr() itself returns all-zero zones in that case
    // — see metrics/hr-zones.js).
    hrzones: (profile.maxHr ?? estimateMaxHr(profile.age)) != null
      && sessions.some((s) => within(s.startTime, 30) && _hasHrData(s)),
  };
}

/**
 * Card ids in on-screen order: the ones with data first, then the ones without,
 * each group in OVERVIEW_CARD_ORDER's order.
 *
 * @param {Object<string, boolean>} readiness  overviewReadiness()'s result
 * @returns {string[]}
 */
export function orderOverviewCards(readiness) {
  return [
    ...OVERVIEW_CARD_ORDER.filter((id) => readiness[id]),
    ...OVERVIEW_CARD_ORDER.filter((id) => !readiness[id]),
  ];
}

export default { OVERVIEW_CARD_ORDER, OVERVIEW_NEEDS, OVERVIEW_TREND_WEEKS, OVERVIEW_SESSION_CARDS, overviewReadiness, orderOverviewCards };
