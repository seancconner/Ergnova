// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/body-history.js
 *
 * Pure data layer behind Overview's "Weight & Composition" card
 * (views/overview.js's _bodyCard()). Takes the raw weigh-in history —
 * db.getBodyMeasurements() rows, the same BodyMeasurement shape
 * core/nutrition-model.js's createBodyMeasurement() builds and app.js's
 * _recordScaleMeasurement() saves on every settled scale reading — and turns
 * it into a ready-to-draw view model: which metrics have data, the series for
 * the selected metric + time range, the headline number and change badge,
 * and a latest-reading breakdown of where the body's weight is going.
 *
 * No DOM, no IndexedDB — same scope as metrics/nutrition.js — so it runs
 * under plain `node` for __body_history_smoketest__.js. The SVG itself is
 * drawn by charts/body-history-chart.js; this file only decides *what* to
 * draw.
 *
 * Design notes:
 *
 *   - One point per calendar day, per metric. A scale can settle more than
 *     once a day (re-weighs, a second sync), and a day can hold a
 *     weight-only reading followed by a handle-contact composition one
 *     (see body-composition.js — muscle/bone/water only exist on the
 *     latter). Each metric collapses to the *last* valid reading of its
 *     local day, built from only the readings that actually have that
 *     metric, so a later weight-only weigh-in never blanks out that
 *     morning's body-fat number.
 *
 *   - The chart plots the raw readings themselves, joined by one line. Earlier
 *     versions laid a trailing-average line over faint raw dots; that is gone,
 *     so what is drawn is exactly what the scale reported.
 *
 *   - "Fat vs Lean" plots each component's change since the first reading
 *     in range instead of absolute mass. Lean mass is ~4x fat mass for most
 *     people, so on a shared absolute axis a 3 lb fat loss is a sliver;
 *     as change-from-start both lines start at zero and the recomposition
 *     (fat down, lean flat/up) is the whole picture. Fat and lean are
 *     derived from weight × body-fat % (fat + lean == weight by
 *     construction), falling back to weight − leanBodyMassKg for a row that
 *     only carries lean mass.
 *
 *   - Storage stays metric (kg) — mass metrics convert to the display
 *     unit here, at the boundary, same rule metrics/units.js documents.
 *
 * Usage:
 *   import { buildBodyHistory } from './metrics/body-history.js';
 *   const model = buildBodyHistory(await db.getBodyMeasurements(), {
 *     metricKey: 'weight',
 *     rangeKey: null,          // null = auto-pick (see resolveRange())
 *     units: profile.units,
 *   });
 *   if (!model.empty) { // model.series, model.headline, model.pill, ... }
 */

import { UNITS, kgToLb, weightUnitLabel } from './units.js';

const DAY = 24 * 60 * 60 * 1000;
const MINUS = '\u2212'; // typographic minus — same width as '+', unlike a hyphen

/** Time-range chips, in display order. `days: null` = the full history. */
export const BODY_RANGES = [
  { key: '30d', label: '30D', days: 30 },
  { key: '90d', label: '90D', days: 90 },
  { key: '1y',  label: '1Y',  days: 365 },
  { key: 'all', label: 'All', days: null },
];

// Fat/lean identity colors are shared by the chart lines and the latest-
// reading breakdown bar so the two read as one legend. Existing per-metric
// tokens (see style.css :root) — no new hex values, same rule the diet
// macro colors follow.
const FAT_COLOR  = 'var(--color-power)';
const LEAN_COLOR = 'var(--color-smo2)';

/**
 * Every metric the card can chart. `kind` drives unit conversion and
 * formatting; `field` is the BodyMeasurement property it reads. The
 * 'composition' entry is virtual (derived from weight + body fat).
 */
export const BODY_METRICS = [
  { key: 'weight',      label: 'Weight',      kind: 'mass',    field: 'weightKg',               colorVar: 'var(--indigo)' },
  { key: 'bodyFat',     label: 'Body Fat',    kind: 'percent', field: 'bodyFatPct',             colorVar: FAT_COLOR },
  { key: 'composition', label: 'Fat vs Lean', kind: 'composition' },
  { key: 'muscle',      label: 'Muscle',      kind: 'mass',    field: 'muscleMassKg',           colorVar: LEAN_COLOR },
  { key: 'water',       label: 'Water',       kind: 'mass',    field: 'bodyWaterKg',            colorVar: 'var(--color-cadence)' },
  { key: 'bone',        label: 'Bone',        kind: 'mass',    field: 'boneMassKg',             colorVar: 'var(--text-secondary)' },
  { key: 'visceral',    label: 'Visceral',    kind: 'index',   field: 'visceralFatRating',      colorVar: 'var(--warning)' },
  { key: 'bmr',         label: 'BMR',         kind: 'kcal',    field: 'basalMetabolicRateKcal', colorVar: 'var(--color-carbs)' },
];

// ─── Small helpers ──────────────────────────────────────────────────────────

/** A usable number for `kind`, or null. Percent must sit strictly inside
 *  (0, 100); everything else just has to be positive. Guards the chart
 *  against a corrupt/partial row rather than trusting the store. */
function validValue(kind, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (kind === 'percent') return v > 0 && v < 100 ? v : null;
  return v > 0 ? v : null;
}

function toDisplay(kind, v, units) {
  return kind === 'mass' && units === UNITS.IMPERIAL ? kgToLb(v) : v;
}

function sortedAscending(measurements) {
  return (measurements ?? [])
    .filter(m => m && Number.isFinite(m.measuredAt))
    .slice()
    .sort((a, b) => a.measuredAt - b.measuredAt);
}

/** Keeps the last point of each local calendar day. Input must be ascending. */
function lastPerDay(points) {
  const byDay = new Map();
  for (const p of points) byDay.set(new Date(p.t).toDateString(), p);
  return [...byDay.values()];
}

/** Full-history series for one plain (non-composition) metric, display units. */
function seriesFor(sorted, metric, units) {
  const pts = [];
  for (const m of sorted) {
    const v = validValue(metric.kind, m[metric.field]);
    if (v != null) pts.push({ t: m.measuredAt, v: toDisplay(metric.kind, v, units) });
  }
  return lastPerDay(pts);
}

/** Full-history fat/lean mass pairs, display units. */
function compositionPoints(sorted, units) {
  const pts = [];
  for (const m of sorted) {
    const w = validValue('mass', m.weightKg);
    if (w == null) continue;
    const bf = validValue('percent', m.bodyFatPct);
    let fatKg, leanKg;
    if (bf != null) {
      fatKg = w * bf / 100;
      leanKg = w - fatKg;
    } else {
      const lean = validValue('mass', m.leanBodyMassKg);
      if (lean == null || lean >= w) continue;
      leanKg = lean;
      fatKg = w - lean;
    }
    pts.push({ t: m.measuredAt, fat: toDisplay('mass', fatKg, units), lean: toDisplay('mass', leanKg, units) });
  }
  return lastPerDay(pts);
}

/** Picks the range to show before the rider has chosen one. `anchorT` is the
 *  end of the window — the last recorded reading (see buildBodyHistory()):
 *   - the whole history if all of it fits inside 90 days (a new rider gets
 *     a chart that fills its width instead of a 90D window that's half blank);
 *   - otherwise the 90 days up to the last reading, if that holds at least
 *     two readings;
 *   - otherwise the whole history, so a rider who's only weighed in a few
 *     times, long ago, still sees a chart. */
export function resolveRange(requestedKey, fullPoints, anchorT = Date.now()) {
  if (requestedKey && BODY_RANGES.some(r => r.key === requestedKey)) return requestedKey;
  if (!fullPoints.length || fullPoints[0].t >= anchorT - 90 * DAY) return 'all';
  const recent = fullPoints.filter(p => p.t >= anchorT - 90 * DAY).length;
  return recent >= 2 ? '90d' : 'all';
}

/**
 * "Nice" axis bounds + tick values around [min, max] (the classic
 * nice-numbers algorithm) so gridlines land on round numbers. `integer`
 * keeps the step at 1 or more — for whole-number metrics (visceral rating,
 * kcal) where a 6.5 gridline would mean nothing.
 * @returns {{min:number, max:number, step:number, ticks:number[], decimals:number}|null}
 */
export function niceScale(min, max, targetTicks = 4, { integer = false } = {}) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.02, 0.5);
    min -= pad; max += pad;
  }
  const niceNum = (x, round) => {
    const exp = Math.floor(Math.log10(x));
    const f = x / 10 ** exp;
    let nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    else       nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * 10 ** exp;
  };
  const range = niceNum(max - min, false);
  let step = niceNum(range / (targetTicks - 1), true);
  if (integer && step < 1) step = 1;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(decimals + 2)));
  return { min: lo, max: hi, step, ticks, decimals };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/** Display number for a value of `kind`; `signed` adds a leading +/−. */
export function formatBodyValue(kind, v, { signed = false } = {}) {
  const decimals = kind === 'mass' || kind === 'percent' ? 1 : 0;
  const rounded = Number(v.toFixed(decimals));
  const abs = Math.abs(rounded).toFixed(decimals);
  if (!signed || rounded === 0) return abs;
  return `${rounded > 0 ? '+' : MINUS}${abs}`;
}

/** Axis-tick label — same as formatBodyValue but with the axis' own decimals. */
export function formatTickValue(v, decimals, signed) {
  const rounded = Number(v.toFixed(decimals));
  const abs = Math.abs(rounded).toFixed(decimals);
  if (rounded === 0) return abs;
  if (rounded < 0) return `${MINUS}${abs}`;
  return signed ? `+${abs}` : abs;
}

function unitLabel(kind, units) {
  if (kind === 'mass' || kind === 'composition') return weightUnitLabel(units);
  if (kind === 'percent') return '%';
  if (kind === 'kcal') return 'kcal';
  return '';
}

// Unit suffix for a *change* — body-fat percentage points read as "pts", not
// "%", so a 1.2 drop isn't mistaken for a 1.2% relative change.
function deltaUnitLabel(kind, units) {
  if (kind === 'percent') return ' pts';
  const u = unitLabel(kind, units);
  return u ? ` ${u}` : '';
}

function changeBadge(delta, kind, units) {
  const rounded = Number(delta.toFixed(kind === 'mass' || kind === 'percent' || kind === 'composition' ? 1 : 0));
  if (rounded === 0) return { text: 'No change', dir: 'flat' };
  const dir = rounded > 0 ? 'up' : 'down';
  const abs = formatBodyValue(kind === 'composition' ? 'mass' : kind, Math.abs(delta));
  return { text: `${dir === 'up' ? '\u25B2' : '\u25BC'} ${abs}${deltaUnitLabel(kind === 'composition' ? 'mass' : kind, units)}`, dir };
}

// ─── Latest-reading breakdown ───────────────────────────────────────────────

/**
 * Where the most recent reading *with a body-fat figure* says the body's
 * weight is going, as segments that partition 100% of it.
 *
 * With muscle mass (and ideally bone mass) present and consistent — fat +
 * muscle + bone ≤ 100% of weight, which the Fitdays composition estimate
 * satisfies exactly (see body-composition.js's partition notes) — the bar is
 * Fat / Muscle / Bone (+ "Other" for whatever's left on a scale that doesn't
 * report bone). If those don't add up (a scale whose "muscle" means
 * something narrower, say), or muscle is missing, it falls back to the
 * always-valid two-way Fat / Lean split rather than drawing a bar that
 * overflows.
 *
 * @returns {{ t:number, segments:{key:string,label:string,pct:number,amount:number,colorVar:string}[] }|null}
 */
export function latestBreakdown(measurements, units = UNITS.METRIC) {
  const sorted = sortedAscending(measurements);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i];
    const w = validValue('mass', m.weightKg);
    const bf = validValue('percent', m.bodyFatPct);
    if (w == null || bf == null) continue;

    const muscle = validValue('mass', m.muscleMassKg);
    const bone = validValue('mass', m.boneMassKg);
    const musclePct = muscle != null ? (muscle / w) * 100 : null;
    const bonePct = bone != null ? (bone / w) * 100 : null;
    const seg = (key, label, pct, colorVar) => ({
      key, label, pct, colorVar, amount: toDisplay('mass', (w * pct) / 100, units),
    });

    const segments = [seg('fat', 'Fat', bf, FAT_COLOR)];
    if (musclePct != null && bf + musclePct + (bonePct ?? 0) <= 100.5) {
      segments.push(seg('muscle', 'Muscle', musclePct, LEAN_COLOR));
      if (bonePct != null) segments.push(seg('bone', 'Bone', bonePct, 'var(--text-secondary)'));
      const other = 100 - segments.reduce((s, x) => s + x.pct, 0);
      if (other >= 1) segments.push(seg('other', 'Other', other, 'var(--border-mid)'));
    } else {
      segments.push(seg('lean', 'Lean', 100 - bf, LEAN_COLOR));
    }
    return { t: m.measuredAt, segments };
  }
  return null;
}

// ─── View model ─────────────────────────────────────────────────────────────

/**
 * Builds everything the card needs for one (metric, range) selection.
 *
 * @param {Object[]} measurements  db.getBodyMeasurements() rows (any order).
 * @param {Object}   opts
 * @param {string}   [opts.metricKey='weight']  A BODY_METRICS key; falls back to the first metric with data.
 * @param {string|null} [opts.rangeKey=null]    A BODY_RANGES key, or null to auto-pick (see resolveRange()).
 * @param {string}   [opts.units='metric']
 * @returns {Object} `{ empty: true }` when there's no usable reading at all; otherwise the model
 *   documented inline below.
 */
export function buildBodyHistory(measurements, { metricKey = 'weight', rangeKey = null, units = UNITS.METRIC } = {}) {
  const sorted = sortedAscending(measurements);

  // Full-history series per metric — needed up front to know which tabs to offer.
  const full = {};
  for (const m of BODY_METRICS) {
    full[m.key] = m.kind === 'composition' ? compositionPoints(sorted, units) : seriesFor(sorted, m, units);
  }
  const tabs = BODY_METRICS
    .filter(m => full[m.key].length >= (m.kind === 'composition' ? 2 : 1))
    .map(m => ({ key: m.key, label: m.label }));
  if (!tabs.length) return { empty: true };

  const metric = BODY_METRICS.find(m => m.key === metricKey && tabs.some(t => t.key === m.key))
    ?? BODY_METRICS.find(m => m.key === tabs[0].key);
  const isComposition = metric.kind === 'composition';
  const signed = isComposition;

  // Range + domain, keyed off the selected metric's own history.
  //
  // The window is anchored to the last *recorded* reading, not to today: the
  // newest reading always sits on the chart's right edge and the range chips
  // count back from it. Anchoring to "now" instead squeezed the whole line
  // leftward by one slice of width for every day since the last weigh-in,
  // leaving a blank stretch on the right.
  const primaryFull = isComposition ? full.composition.map(p => ({ t: p.t, v: p.fat })) : full[metric.key];
  const endT = primaryFull[primaryFull.length - 1].t;
  const resolvedRange = resolveRange(rangeKey, primaryFull, endT);
  const range = BODY_RANGES.find(r => r.key === resolvedRange);
  let startT = range.days == null ? primaryFull[0].t : endT - range.days * DAY;
  if (startT >= endT) startT = endT - DAY; // a lone reading: still sits on the right edge

  const cut = pts => pts.filter(p => p.t >= startT);
  const build = (fullPts, key, label, colorVar, baseline = 0) => ({
    key, label, colorVar,
    points: cut(fullPts).map(p => ({ t: p.t, v: p.v - baseline })),
  });

  let series;
  let headline;
  let pill = null;
  let sinceT = null;
  let latestT;

  if (isComposition) {
    const fatFull  = full.composition.map(p => ({ t: p.t, v: p.fat }));
    const leanFull = full.composition.map(p => ({ t: p.t, v: p.lean }));
    const inRange = cut(fatFull);
    const fatBase  = inRange.length ? inRange[0].v : 0;
    const leanBase = inRange.length ? cut(leanFull)[0].v : 0;
    series = [
      build(fatFull,  'fat',  'Fat',  FAT_COLOR,  fatBase),
      build(leanFull, 'lean', 'Lean', LEAN_COLOR, leanBase),
    ];
    const last = full.composition[full.composition.length - 1];
    latestT = last.t;
    const unit = unitLabel('mass', units);
    if (series[0].points.length >= 2) {
      const dFat  = series[0].points[series[0].points.length - 1].v;
      const dLean = series[1].points[series[1].points.length - 1].v;
      headline = [
        { label: 'Fat',  value: formatBodyValue('mass', dFat,  { signed: true }), unit, colorVar: FAT_COLOR },
        { label: 'Lean', value: formatBodyValue('mass', dLean, { signed: true }), unit, colorVar: LEAN_COLOR },
      ];
      pill = changeBadge(dFat + dLean, 'composition', units);
      pill.text = `Net ${pill.text}`;
      sinceT = series[0].points[0].t;
    } else {
      headline = [
        { label: 'Fat',  value: formatBodyValue('mass', last.fat),  unit, colorVar: FAT_COLOR },
        { label: 'Lean', value: formatBodyValue('mass', last.lean), unit, colorVar: LEAN_COLOR },
      ];
    }
  } else {
    series = [build(full[metric.key], metric.key, metric.label, metric.colorVar)];
    const last = full[metric.key][full[metric.key].length - 1];
    latestT = last.t;
    headline = [{ label: null, value: formatBodyValue(metric.kind, last.v), unit: unitLabel(metric.kind, units), colorVar: metric.colorVar }];
    const pts = series[0].points;
    if (pts.length >= 2) {
      pill = changeBadge(pts[pts.length - 1].v - pts[0].v, metric.kind, units);
      sinceT = pts[0].t;
    }
  }

  const count = series[0].points.length;
  const hasComposition = tabs.some(t => t.key !== 'weight');

  return {
    empty: false,
    title: hasComposition ? 'Weight & Composition' : 'Weight',
    tabs,
    metricKey: metric.key,
    kind: metric.kind,
    unit: unitLabel(metric.kind, units),
    signed,
    ranges: BODY_RANGES,
    rangeKey: resolvedRange,
    domain: { startT, endT },
    series,
    zeroBaseline: isComposition,
    integerAxis: metric.kind === 'index' || metric.kind === 'kcal',
    count,
    headline,
    pill,
    sinceT,
    latestT,
    estimated: metric.key !== 'weight',
    fmt: v => formatBodyValue(isComposition ? 'mass' : metric.kind, v, { signed }),
    fmtTick: (v, decimals) => formatTickValue(v, decimals, signed),
    breakdown: latestBreakdown(measurements, units),
  };
}

export default { BODY_RANGES, BODY_METRICS, buildBodyHistory, latestBreakdown, niceScale };
