// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * charts/chart-order.js
 *
 * The one place that says what order the chart metrics run in: the carousel's pages (and so its dots),
 * the All page's series, split grid and hero rotation, History's session chart, and the live badge row
 * all follow it. Heart rate first, then Power, Cadence and Speed; SmO2 and core temp, the rarer sensors,
 * come after. No imports and no DOM, so it runs under plain node (__chart_order_smoketest__.js).
 *
 * This is the *chart's* order only. app.js's METRIC_ORDER (what the Scripted HUD rotator, the stat row
 * and the background snapshot walk, with Power first) is a separate list and is left as it was.
 */

/** Metric keys in the order the chart shows them. */
export const CHART_METRIC_ORDER = ['heartRate', 'power', 'cadence', 'speed', 'smo2', 'coreTemp'];

/** `keys` in chart order. Keys the chart order doesn't know keep their relative order, after the known ones.
 *  Returns a new array; the input is untouched.
 *  @param {string[]} keys
 *  @returns {string[]} */
export function sortMetricKeys(keys) {
  const rank = k => {
    const i = CHART_METRIC_ORDER.indexOf(k);
    return i < 0 ? CHART_METRIC_ORDER.length : i;
  };
  return (keys ?? []).map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map(x => x.k);
}

/** `defs` (objects with a `.key`) in chart order, same rules as sortMetricKeys. Returns a new array.
 *  @template {{key:string}} T
 *  @param {T[]} defs
 *  @returns {T[]} */
export function sortMetricDefs(defs) {
  const order = sortMetricKeys((defs ?? []).map(d => d.key));
  return order.map(k => defs.find(d => d.key === k));
}

/** The page order a carousel should settle on: the All page first (when it has one), then the metrics that
 *  have a page, in the host's `wanted` order. Metrics in `wanted` without a page are skipped; pages the host
 *  no longer wants are dropped (the carousel removes those separately).
 *  @param {string|null} overviewKey  the All page's key, or null when there is no All page
 *  @param {string[]} wanted          the host's metric keys, in display order
 *  @param {Iterable<string>} have    the keys that currently have a page
 *  @returns {string[]} */
export function pageOrder(overviewKey, wanted, have) {
  const has = new Set(have);
  const metrics = (wanted ?? []).filter(k => has.has(k));
  return overviewKey != null ? [overviewKey, ...metrics] : metrics;
}
