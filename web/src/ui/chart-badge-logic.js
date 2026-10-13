// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/chart-badge-logic.js
 *
 * The pure parts of the live chart's fixed badge bar (ui/chart-badge-bar.js is
 * the DOM around them): which metrics get a "current value" badge, which of them the hero is already
 * reading out (so the rotating badge skips it), and how a reading becomes a badge's text. No imports
 * and no DOM beyond the one pure import below, so it runs under plain node (__chart_badge_smoketest__.js).
 */

import { CHART_METRIC_ORDER } from '../charts/chart-order.js';

/** The metrics that get a current-value badge, in the order they sit in the row: the chart's own order
 *  (charts/chart-order.js — heart rate, power, cadence, speed), so the row reads like the dots under it.
 *  SmO2 and core temp have charts but no badge: the hero covers them on their own page, and nothing else
 *  shows them. */
export const BADGE_METRIC_KEYS = CHART_METRIC_ORDER.filter(k => ['heartRate', 'power', 'cadence', 'speed'].includes(k));

/** Of the metrics the chart currently has pages for, the ones that get a badge, in row order.
 *  @param {string[]} chartKeys  keys of the live chart's metric pages (any order)
 *  @returns {string[]} */
export function badgeMetricKeys(chartKeys) {
  const have = new Set(chartKeys ?? []);
  return BADGE_METRIC_KEYS.filter(k => have.has(k));
}

/** The badge that should step aside (fade toward the hero) while `activeKey`'s chart is on screen:
 *  that metric's own, because the hero, Average and Peak are showing it. Null on the "All" page and on
 *  a metric with no badge (SmO2, core temp) — then every badge stays.
 *  @param {string|null} activeKey  the carousel's active page key
 *  @param {string[]} shownKeys     the metrics that currently have a badge
 *  @returns {string|null} */
export function awayKey(activeKey, shownKeys) {
  return activeKey != null && (shownKeys ?? []).includes(activeKey) ? activeKey : null;
}

/** The badge that steps aside given both the chart page on screen and the metric the hero is reading out.
 *  On a metric's own page they are the same thing and the page decides (awayKey). On the "All" page, whose
 *  hero rotates through the metrics, it is the metric the hero is on at the moment, so the hero's metric is
 *  not also shown as a badge right below it. Null when neither has a badge (SmO2, core temp), or when the
 *  hero has nothing to say.
 *  @param {string|null} activeKey  the carousel's active page key
 *  @param {string|null} heroKey    the metric the hero is on while the All page is showing (else null)
 *  @param {string[]} shownKeys     the metrics that currently have a badge
 *  @returns {string|null} */
export function coveredKey(activeKey, heroKey, shownKeys) {
  return awayKey(activeKey, shownKeys) ?? awayKey(heroKey, shownKeys);
}

/** The metric defs the bar's single rotating badge should cycle through: every metric that gets a
 *  badge, except whichever one `coveredKey` says the hero is already reading out (so the rotation
 *  never repeats the metric already on screen as the big numeral). Order follows `metricDefs`' own
 *  order (badgeMetricKeys() already produces that in BADGE_METRIC_KEYS order), so the rotation is
 *  stable rather than shuffling between renders.
 *  @param {{key:string}[]} metricDefs  the bar's current metric defs (ChartBadgeBar#setMetrics)
 *  @param {string|null} activeKey      the carousel's active page key
 *  @param {string|null} heroKey        the metric the hero is on while the All page is showing (else null)
 *  @returns {Object[]} */
export function rotatorDefs(metricDefs, activeKey, heroKey) {
  const defs = metricDefs ?? [];
  const away = coveredKey(activeKey, heroKey, defs.map(d => d.key));
  return away == null ? defs : defs.filter(d => d.key !== away);
}

/** The metric the rotating badge shows while the All page's hero is on `heroKey`: the one half a rotation
 *  away from it in the hero's own order. With four metrics (heart rate, power, cadence, speed) Heart rate
 *  pairs with Cadence and Power with Speed (and back again); with two it is simply the other one; with three it is the next one on.
 *  Always a metric that has a badge, and never the hero's own: where the metric half a turn away has no
 *  badge (SmO2, core temp), the next one on that does is used. Null when the hero is not on the ring, the
 *  ring has fewer than two metrics, or none of the others has a badge.
 *  Because it is a function of the hero's metric alone, the badge can change at the very moment the hero
 *  does (and hold still when the hero holds) without a timer of its own to drift out of step.
 *  @param {string[]} ringKeys   the hero's rotation order — the All page's metric keys
 *  @param {string|null} heroKey the metric the hero is on
 *  @param {string[]} badgeKeys  the metrics that have a badge
 *  @returns {string|null} */
export function oppositeKey(ringKeys, heroKey, badgeKeys) {
  const ring = ringKeys ?? [];
  const at = ring.indexOf(heroKey);
  if (ring.length < 2 || at < 0) return null;
  const hasBadge = new Set(badgeKeys ?? []);
  const start = (at + Math.floor(ring.length / 2)) % ring.length;
  for (let step = 0; step < ring.length; step++) {
    const key = ring[(start + step) % ring.length];
    if (key !== heroKey && hasBadge.has(key)) return key;
  }
  return null;
}

// How long the rotating badge sits on one metric before stepping to the next — the same dwell the
// scripted HUD's own rotator chip used before this replaced it. (On the All page it no longer has a
// dwell of its own: it follows the hero, which has the same 3.5s one — see ChartBadgeBar#setHero.)
export const ROTATOR_INTERVAL_MS = 3500;

/** The text of a metric badge: the formatted reading and its unit, or an em dash when there is no
 *  reading (no sample yet, or the sensor dropped out and left null).
 *  @param {number|null|undefined} raw
 *  @param {{fmt:(v:number)=>string|number, unit?:string}} def */
export function metricBadgeText(raw, { fmt, unit = '' } = {}) {
  if (raw == null || Number.isNaN(raw)) return '\u2014';
  const text = String(fmt ? fmt(raw) : raw);
  return unit ? `${text} ${unit}` : text;
}

/** The newest sample of a buffer, or null.
 *  @param {Object[]|null|undefined} samples */
export function latestSample(samples) {
  return samples?.length ? samples[samples.length - 1] : null;
}
