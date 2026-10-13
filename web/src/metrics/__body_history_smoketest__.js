// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// metrics/body-history.js + charts/body-history-chart.js smoke test. Run with:
//   node src/metrics/__body_history_smoketest__.js
//
// Covers the pure pieces behind Overview's "Weight & Composition" card:
// per-day collapsing (and that a later weight-only reading doesn't blank an
// earlier body-fat one), kg -> lb display conversion, range cutting and the
// auto-range rule, the Fat vs Lean change
// baseline (fat + lean deltas must add up to the weight delta), the change
// badge/formatting, niceScale()'s tick math, latestBreakdown()'s
// partition-vs-fallback logic, and that the SVG renderer emits well-formed
// markup + an x-sorted hit table without NaNs. No DOM/IndexedDB involved,
// same scope as metrics/__nutrition_smoketest__.js.

import {
  BODY_RANGES, buildBodyHistory, latestBreakdown,
  niceScale, formatBodyValue, formatTickValue, resolveRange,
} from './body-history.js';
import { renderBodyHistoryChart } from '../charts/body-history-chart.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}
function closeTo(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

const DAY = 24 * 60 * 60 * 1000;
// Fixed "now" at local noon so ±N-day offsets never straddle a local-midnight
// boundary (per-day collapsing uses the local calendar day).
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
const daysAgo = n => NOW - n * DAY;
const KG_TO_LB = 2.20462;

function row(daysBack, fields = {}, hoursOffset = 0) {
  return {
    measuredAt: daysAgo(daysBack) + hoursOffset * 3600 * 1000,
    source: 'ble-scale',
    weightKg: null, bodyFatPct: null, leanBodyMassKg: null, muscleMassKg: null,
    boneMassKg: null, bodyWaterKg: null, visceralFatRating: null, basalMetabolicRateKcal: null,
    ...fields,
  };
}

console.log('body-history.js (empty / invalid input)');
{
  check('no measurements -> empty', buildBodyHistory([], { now: NOW }).empty === true);
  check('null/undefined measurements -> empty', buildBodyHistory(undefined, { now: NOW }).empty === true);
  const junk = [row(1, { weightKg: -5 }), row(2, { weightKg: NaN }), { measuredAt: 'x', weightKg: 80 }, row(3, { bodyFatPct: 150 })];
  check('rows with only invalid values -> empty', buildBodyHistory(junk, { now: NOW }).empty === true);
}

console.log('body-history.js (weight-only history)');
{
  const rows = [row(50, { weightKg: 90 }), row(30, { weightKg: 88 }), row(10, { weightKg: 86 }), row(2, { weightKg: 85 })];
  const m = buildBodyHistory(rows, { now: NOW });
  check('not empty', m.empty === false);
  check('only the Weight tab is offered', m.tabs.length === 1 && m.tabs[0].key === 'weight');
  check('title is plain "Weight" with no composition data', m.title === 'Weight');
  check('auto range shows the whole history when it all fits inside 90 days', m.rangeKey === 'all');
  check('all four readings are in the 90d window', m.count === 4);
  check('headline shows the newest reading, 1 decimal', m.headline[0].value === '85.0' && m.headline[0].unit === 'kg');
  check('pill is a downward change badge of the full 5.0 kg', m.pill?.dir === 'down' && m.pill.text === '\u25BC 5.0 kg');
  check('the series is the raw readings only — no trend/average line is built', m.series[0].points.length === 4 && !('trend' in m.series[0]) && m.trendDays === undefined);
  check('zero-baseline is off for a plain metric', m.zeroBaseline === false);
  check('no composition data -> no breakdown', m.breakdown === null);
  check('not flagged as estimated', m.estimated === false);

  const imp = buildBodyHistory(rows, { now: NOW, units: 'imperial' });
  check('imperial converts kg -> lb at the display boundary', closeTo(imp.series[0].points.at(-1).v, 85 * KG_TO_LB, 1e-6));
  check('imperial unit label is lb', imp.headline[0].unit === 'lb');
}

console.log('body-history.js (range cutting + auto range)');
{
  const rows = [row(200, { weightKg: 95 }), row(120, { weightKg: 92 }), row(20, { weightKg: 90 }), row(5, { weightKg: 89 })];
  const m30 = buildBodyHistory(rows, { now: NOW, rangeKey: '30d' });
  check('30d keeps only readings inside 30 days', m30.count === 2);
  check('30d domain starts exactly 30 days before the newest reading', m30.domain.startT === daysAgo(5) - 30 * DAY);
  check('domain end is the newest reading, not "now" (no blank stretch on the right)', m30.domain.endT === daysAgo(5));
  const lastHit = renderBodyHistoryChart({ width: 340, height: 143, domain: m30.domain, series: m30.series, formatTick: m30.fmtTick, formatDate: t => String(t) }).hits.at(-1);
  const m30Plot = renderBodyHistoryChart({ width: 340, height: 143, domain: m30.domain, series: m30.series, formatTick: m30.fmtTick, formatDate: t => String(t) }).plot;
  check('the newest reading is drawn on the plot\'s right edge', Math.abs(lastHit.x - m30Plot.right) < 0.01);
  check('headline still reports the newest reading', m30.headline[0].value === '89.0');

  const all = buildBodyHistory(rows, { now: NOW, rangeKey: 'all' });
  check('all keeps every reading', all.count === 4);
  check('all starts at the first reading', all.domain.startT === daysAgo(200));

  const auto = buildBodyHistory(rows, { now: NOW });
  check('auto: older history with 2 readings inside 90d -> 90d', auto.rangeKey === '90d' && auto.count === 2);
  const fresh = buildBodyHistory([row(40, { weightKg: 82 }), row(3, { weightKg: 81 })], { now: NOW });
  check('auto: history that starts inside 90d -> all (no half-empty chart)', fresh.rangeKey === 'all' && fresh.domain.startT === daysAgo(40));

  const stale = [row(400, { weightKg: 95 }), row(300, { weightKg: 94 }), row(200, { weightKg: 93 })];
  const autoStale = buildBodyHistory(stale, { now: NOW });
  check('auto: nothing recent -> falls back to the whole history', autoStale.rangeKey === 'all' && autoStale.count === 3);

  const empty30 = buildBodyHistory(stale, { now: NOW, rangeKey: '30d' });
  check('an explicit range always holds the newest reading, even when it is old (window counts back from it)', empty30.count === 1 && empty30.pill === null && empty30.domain.endT === daysAgo(200));
  const lone = buildBodyHistory([row(3, { weightKg: 80 })], { now: NOW, rangeKey: 'all' });
  check('a single reading ends the domain (right edge) with a day of lead-in', lone.domain.endT === daysAgo(3) && lone.domain.startT < lone.domain.endT);
  check('resolveRange honors an explicit valid key', resolveRange('1y', [], NOW) === '1y');
  check('resolveRange ignores an unknown key', resolveRange('bogus', [], NOW) === 'all');
  check('BODY_RANGES ends with an "all" entry', BODY_RANGES.at(-1).key === 'all' && BODY_RANGES.at(-1).days === null);
}

console.log('body-history.js (per-day collapsing)');
{
  const rows = [
    row(3, { weightKg: 80, bodyFatPct: 20 }, -2),   // morning, full composition reading
    row(3, { weightKg: 80.6 }, 0),                  // same day, later weight-only weigh-in
    row(2, { weightKg: 79.5, bodyFatPct: 19.5 }),
    row(1, { weightKg: 79.2, bodyFatPct: 19.4 }),
  ];
  const w = buildBodyHistory(rows, { now: NOW, metricKey: 'weight', rangeKey: '30d' });
  check('two same-day weigh-ins collapse to one point', w.count === 3);
  check('the LATER reading of the day wins for weight', closeTo(w.series[0].points[0].v, 80.6));
  const bf = buildBodyHistory(rows, { now: NOW, metricKey: 'bodyFat', rangeKey: '30d' });
  check("a later weight-only reading doesn't blank that day's body fat", bf.count === 3 && closeTo(bf.series[0].points[0].v, 20));
  check('body-fat headline is a percent', bf.headline[0].unit === '%' && bf.headline[0].value === '19.4');
  check('body-fat change badge uses "pts", not "%"', bf.pill.text.endsWith('pts'));
  check('body-fat metric is flagged as an estimate', bf.estimated === true);
}

console.log('body-history.js (Fat vs Lean change view)');
{
  // 80 kg @ 20% -> 16 fat / 64 lean ; 78 kg @ 17% -> 13.26 fat / 64.74 lean ; 77 kg @ 15.4% -> 11.858 / 65.142
  // (15.4% rather than a rounder figure so the headline's 1-decimal rounding doesn't land on an exact .x5 tie)
  const rows = [
    row(40, { weightKg: 80, bodyFatPct: 20 }),
    row(20, { weightKg: 78, bodyFatPct: 17 }),
    row(5,  { weightKg: 77, bodyFatPct: 15.4 }),
  ];
  const m = buildBodyHistory(rows, { now: NOW, metricKey: 'composition' });
  check('composition tab is offered with 2+ composition readings', m.tabs.some(t => t.key === 'composition'));
  check('composition view has two series (fat, lean) and a zero baseline', m.series.length === 2 && m.zeroBaseline === true);
  check('both series start at 0 (change since first reading in range)', closeTo(m.series[0].points[0].v, 0) && closeTo(m.series[1].points[0].v, 0));
  const dFat = m.series[0].points.at(-1).v;
  const dLean = m.series[1].points.at(-1).v;
  check('fat change is 11.858 - 16 kg', closeTo(dFat, 77 * 0.154 - 16, 1e-9));
  check('lean change is 65.142 - 64 kg', closeTo(dLean, 77 * 0.846 - 64, 1e-9));
  check('fat delta + lean delta == weight delta (-3 kg)', closeTo(dFat + dLean, -3, 1e-9));
  check('headline carries signed deltas with a true minus', m.headline[0].value === '\u22124.1' && m.headline[1].value === '+1.1');
  check('net badge reads as a net weight change', m.pill.text === 'Net \u25BC 3.0 kg');
  check('composition ticks are signed', m.fmtTick(2, 0) === '+2' && m.fmtTick(-2, 0) === '\u22122' && m.fmtTick(0, 0) === '0');
  check('composition metric is flagged as an estimate', m.estimated === true);
  check('title mentions composition once a non-weight metric exists', m.title === 'Weight & Composition');

  const narrow = buildBodyHistory(rows, { now: NOW, metricKey: 'composition', rangeKey: '30d' });
  check('baseline re-anchors to the first reading INSIDE the range', closeTo(narrow.series[0].points[0].v, 0) && narrow.count === 2);
  check('re-anchored fat delta = 11.858 - 13.26', closeTo(narrow.series[0].points.at(-1).v, 77 * 0.154 - 78 * 0.17, 1e-9));

  const one = buildBodyHistory([row(5, { weightKg: 80, bodyFatPct: 20 })], { now: NOW, metricKey: 'composition' });
  check('a single composition reading does not offer the change view (falls back to Weight)', one.metricKey === 'weight' && !one.tabs.some(t => t.key === 'composition'));

  const leanOnly = [
    row(10, { weightKg: 80, leanBodyMassKg: 64 }),
    row(2,  { weightKg: 79, leanBodyMassKg: 64.5 }),
  ];
  const lo = buildBodyHistory(leanOnly, { now: NOW, metricKey: 'composition' });
  check('a row with only lean mass derives fat = weight - lean', lo.series[0].points.length === 2 && closeTo(lo.series[0].points.at(-1).v, (79 - 64.5) - (80 - 64), 1e-9));
}

console.log('body-history.js (tabs + every metric)');
{
  const rows = [
    row(9, { weightKg: 80, bodyFatPct: 20, muscleMassKg: 60, boneMassKg: 3.4, bodyWaterKg: 45, visceralFatRating: 7, basalMetabolicRateKcal: 1750 }),
    row(2, { weightKg: 79, bodyFatPct: 19, muscleMassKg: 60.5, boneMassKg: 3.4, bodyWaterKg: 45.3, visceralFatRating: 6, basalMetabolicRateKcal: 1760 }),
  ];
  const m = buildBodyHistory(rows, { now: NOW });
  check('every reported metric gets a tab, Weight first', m.tabs.map(t => t.key).join(',') === 'weight,bodyFat,composition,muscle,water,bone,visceral,bmr');
  const vis = buildBodyHistory(rows, { now: NOW, metricKey: 'visceral' });
  check('visceral fat is an integer rating with no unit', vis.headline[0].value === '6' && vis.headline[0].unit === '');
  check('visceral and BMR flag an integer axis; weight does not', vis.integerAxis === true && buildBodyHistory(rows, { now: NOW, metricKey: 'bmr' }).integerAxis === true && m.integerAxis === false);
  check('visceral change reads "\u25BC 1"', vis.pill.text === '\u25BC 1');
  const bmr = buildBodyHistory(rows, { now: NOW, metricKey: 'bmr' });
  check('BMR is whole kcal', bmr.headline[0].value === '1760' && bmr.headline[0].unit === 'kcal' && bmr.pill.text === '\u25B2 10 kcal');
  const mus = buildBodyHistory(rows, { now: NOW, metricKey: 'muscle', units: 'imperial' });
  check('muscle mass converts to lb', closeTo(mus.series[0].points.at(-1).v, 60.5 * KG_TO_LB, 1e-6) && mus.unit === 'lb');
  const missing = buildBodyHistory([row(2, { weightKg: 80 }), row(1, { weightKg: 79 })], { now: NOW, metricKey: 'muscle' });
  check('asking for a metric with no data falls back to a valid one', missing.metricKey === 'weight');
  const flat = buildBodyHistory([row(2, { weightKg: 80 }), row(1, { weightKg: 80 })], { now: NOW });
  check('an unchanged value shows a flat "No change" badge', flat.pill.dir === 'flat' && flat.pill.text === 'No change');
}

console.log('body-history.js (formatting)');
{
  check('mass rounds to 1 decimal', formatBodyValue('mass', 84.96) === '85.0');
  check('signed positive gets +', formatBodyValue('mass', 1.24, { signed: true }) === '+1.2');
  check('signed negative gets a true minus', formatBodyValue('mass', -1.24, { signed: true }) === '\u22121.2');
  check('a value that rounds to zero shows no sign (and never "-0.0")', formatBodyValue('mass', -0.04, { signed: true }) === '0.0');
  check('kcal/index are whole numbers', formatBodyValue('kcal', 1759.6) === '1760' && formatBodyValue('index', 6.4) === '6');
  check('tick formatter honors decimals', formatTickValue(84, 0, false) === '84' && formatTickValue(84.5, 1, false) === '84.5');
}

console.log('body-history.js (niceScale)');
{
  const s = niceScale(83.2, 90.7, 4);
  check('bounds enclose the data', s.min <= 83.2 && s.max >= 90.7);
  check('ticks are evenly spaced multiples of a 1/2/5 step', s.ticks.every((t, i) => i === 0 || closeTo(t - s.ticks[i - 1], s.step, 1e-9)) && [1, 2, 5].includes(Number((s.step / 10 ** Math.floor(Math.log10(s.step))).toFixed(6))));
  check('first/last tick are the bounds', s.ticks[0] === s.min && s.ticks.at(-1) === s.max);
  const flat = niceScale(80, 80, 4);
  check('a flat series still gets a non-degenerate scale', flat.max > flat.min && flat.ticks.length >= 2);
  check('non-finite input -> null', niceScale(NaN, 5) === null);
  const whole = niceScale(6.6, 8.2, 4, { integer: true });
  check('integer axes never use a fractional step or bound', whole.step >= 1 && whole.decimals === 0 && whole.ticks.every(Number.isInteger));
  check('without the integer flag the same range does get fractional ticks', niceScale(6.6, 8.2, 4).ticks.some(t => !Number.isInteger(t)));
  const small = niceScale(0.12, 0.31, 4);
  check('sub-1 steps report enough decimals', small.decimals >= 1);
}

console.log('body-history.js (latestBreakdown)');
{
  // Fitdays-style: fat + muscle + bone partition weight exactly (see body-composition.js's derivation notes).
  const fat = 80 * 0.2;               // 16
  const bone = (80 - fat) * 0.0673;   // ~4.3
  const muscle = 80 - fat - bone;
  const b = latestBreakdown([row(1, { weightKg: 80, bodyFatPct: 20, muscleMassKg: muscle, boneMassKg: bone })]);
  check('segments: Fat / Muscle / Bone (no "Other" when they partition the weight)', b.segments.map(s => s.key).join(',') === 'fat,muscle,bone');
  check('segment percentages sum to 100', closeTo(b.segments.reduce((s, x) => s + x.pct, 0), 100, 1e-6));
  check('segment amounts sum to body weight', closeTo(b.segments.reduce((s, x) => s + x.amount, 0), 80, 1e-6));

  const noBone = latestBreakdown([row(1, { weightKg: 80, bodyFatPct: 20, muscleMassKg: 40 })]);
  check('muscle without bone leaves an "Other" remainder', noBone.segments.map(s => s.key).join(',') === 'fat,muscle,other' && closeTo(noBone.segments.at(-1).pct, 30, 1e-9));

  const inconsistent = latestBreakdown([row(1, { weightKg: 80, bodyFatPct: 20, muscleMassKg: 75 })]);
  check("fat + muscle overflowing 100% falls back to a Fat / Lean split", inconsistent.segments.map(s => s.key).join(',') === 'fat,lean');

  const fatOnly = latestBreakdown([row(1, { weightKg: 80, bodyFatPct: 20 })]);
  check('body fat alone -> Fat / Lean', fatOnly.segments.map(s => s.key).join(',') === 'fat,lean' && closeTo(fatOnly.segments[1].pct, 80, 1e-9));

  check('weight-only history -> null', latestBreakdown([row(1, { weightKg: 80 })]) === null);
  const newest = latestBreakdown([row(9, { weightKg: 80, bodyFatPct: 20 }), row(1, { weightKg: 79 })]);
  check('uses the newest reading that HAS body fat, not merely the newest reading', newest.t === daysAgo(9));
  const imp = latestBreakdown([row(1, { weightKg: 80, bodyFatPct: 20 })], 'imperial');
  check('imperial amounts are in lb', closeTo(imp.segments[0].amount, 16 * KG_TO_LB, 1e-6));
}

console.log('body-history-chart.js');
{
  const rows = Array.from({ length: 12 }, (_, i) => row(60 - i * 5, { weightKg: 90 - i * 0.5 + (i % 2 ? 0.4 : 0), bodyFatPct: 24 - i * 0.3 }));
  const m = buildBodyHistory(rows, { now: NOW, metricKey: 'weight', rangeKey: '90d' });
  const args = { width: 340, height: 143, domain: m.domain, series: m.series, zeroBaseline: m.zeroBaseline, formatTick: m.fmtTick, formatDate: (t) => new Date(t).toISOString().slice(5, 10) };
  const out = renderBodyHistoryChart(args);
  check('returns an <svg> sized to the requested viewBox', out.svg.startsWith('<svg') && out.svg.includes('viewBox="0 0 340 143"'));
  check('svg has no NaN/undefined/Infinity anywhere', !/NaN|undefined|Infinity/.test(out.svg));
  check('the raw readings are one solid line with a dot per reading, nothing ghosted', (out.svg.match(/class="bh-line"/g) ?? []).length === 1 && (out.svg.match(/class="bh-dot"/g) ?? []).length === m.count && !/bh-trend|faint/.test(out.svg));
  check('single-series plot gets an area fill', out.svg.includes('bh-area'));
  check('one hit per reading, x-ascending', out.hits.length === m.count && out.hits.every((h, i) => i === 0 || h.x > out.hits[i - 1].x));
  check('hits fall inside the plot area', out.hits.every(h => h.x >= out.plot.left && h.x <= out.plot.right));
  check('each hit carries its series value', out.hits.every(h => h.items.length === 1 && Number.isFinite(h.items[0].v) && Number.isFinite(h.items[0].y)));
  check('hover layer + hit rect present', out.svg.includes('bh-guide') && out.svg.includes('bh-hover-dot') && out.svg.includes('bh-hit'));
  check('no zero line on a plain metric', !out.svg.includes('bh-zero'));
  check('left gutter is wide enough for the widest y label', out.plot.left >= 30);

  const comp = buildBodyHistory(rows, { now: NOW, metricKey: 'composition', rangeKey: '90d' });
  const cOut = renderBodyHistoryChart({ ...args, domain: comp.domain, series: comp.series, zeroBaseline: true, formatTick: comp.fmtTick });
  check('composition chart draws a zero line', cOut.svg.includes('bh-zero'));
  check('composition chart draws both series, no area fill', (cOut.svg.match(/class="bh-line"/g) ?? []).length === 2 && !cOut.svg.includes('bh-area'));
  check('composition hits carry both fat and lean', cOut.hits.every(h => h.items.length === 2 && h.items[0].key === 'fat' && h.items[1].key === 'lean'));
  check('composition svg has no NaN', !/NaN|undefined|Infinity/.test(cOut.svg));

  const two = buildBodyHistory([row(9, { weightKg: 80 }), row(1, { weightKg: 79 })], { now: NOW, rangeKey: '30d' });
  const tOut = renderBodyHistoryChart({ ...args, domain: two.domain, series: two.series, zeroBaseline: false, formatTick: two.fmtTick });
  check('2 readings: one solid line, area + dots', tOut.svg.includes('class="bh-line"') && tOut.svg.includes('bh-area') && tOut.svg.includes('bh-dot'));

  const shortSpan = renderBodyHistoryChart({ ...args, domain: { startT: NOW - 2 * DAY, endT: NOW }, formatDate: t => new Date(t).toDateString() });
  const shortLabels = [...shortSpan.svg.matchAll(/class="bh-xlabel"[^>]*>([^<]*)</g)].map(x => x[1]);
  check('a 2-day span gets 3 x-labels, all distinct days', shortLabels.length === 3 && new Set(shortLabels).size === 3);
  const tinySpan = renderBodyHistoryChart({ ...args, domain: { startT: NOW - 0.5 * DAY, endT: NOW }, formatDate: t => new Date(t).toDateString() });
  check('a sub-day span falls back to just 2 x-labels', (tinySpan.svg.match(/class="bh-xlabel"/g) ?? []).length === 2);

  const one = buildBodyHistory([row(3, { weightKg: 80 })], { now: NOW, rangeKey: '30d' });
  const oOut = renderBodyHistoryChart({ ...args, domain: one.domain, series: one.series, zeroBaseline: false, formatTick: one.fmtTick });
  check('a single reading draws just the marker dot, no line', oOut.svg.includes('bh-last') && !oOut.svg.includes('bh-line') && oOut.hits.length === 1 && !/NaN/.test(oOut.svg));

  const none = renderBodyHistoryChart({ ...args, series: [{ key: 'weight', label: 'Weight', colorVar: 'var(--indigo)', points: [] }] });
  check('no points -> empty svg and no hits', none.svg === '' && none.hits.length === 0);

  const narrow = renderBodyHistoryChart({ ...args, width: 280 });
  check('narrow charts use 3 x-labels instead of 5', (narrow.svg.match(/class="bh-xlabel"/g) ?? []).length === 3 && (out.svg.match(/class="bh-xlabel"/g) ?? []).length === 5);
  check('first x-label is start-anchored, last is end-anchored (no clipping)', out.svg.includes('text-anchor="start"') && out.svg.includes('text-anchor="end">'));

  const esc = renderBodyHistoryChart({ ...args, ariaLabel: 'a "quoted" <label>' });
  check('aria-label is escaped', esc.svg.includes('a &quot;quoted&quot; &lt;label&gt;'));
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
else console.log('All body-history checks passed.');
