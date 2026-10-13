// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/ui/__chart_badge_smoketest__.js
//
// Covers ui/chart-badge-logic.js — the pure parts of the live chart's fixed badge bar: which metrics get a badge, which one steps aside for the chart on screen, and the
// badge text. The DOM and the animation are checked in the running app by
// scripts/browser-checks/live-chart-badges.py (this project has no DOM test runner).

import { BADGE_METRIC_KEYS, badgeMetricKeys, awayKey, coveredKey, rotatorDefs, oppositeKey, ROTATOR_INTERVAL_MS, metricBadgeText, latestSample } from './chart-badge-logic.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}

console.log('which metrics get a badge');
check('heart rate, power, cadence and speed, in that order (the chart\'s own order)', BADGE_METRIC_KEYS.join() === 'heartRate,power,cadence,speed');
check('whatever order the chart\'s pages arrive in, the row is heart rate first', badgeMetricKeys(['speed', 'power', 'cadence', 'heartRate']).join() === 'heartRate,power,cadence,speed');
check('only the chart\'s own metrics, in row order whatever order they arrive in',
  badgeMetricKeys(['speed', 'power', 'cadence']).join() === 'power,cadence,speed');
check('SmO2 and core temp have no badge', badgeMetricKeys(['power', 'smo2', 'coreTemp']).join() === 'power');
check('nothing in, nothing out', badgeMetricKeys([]).length === 0 && badgeMetricKeys(undefined).length === 0 && badgeMetricKeys(null).length === 0);

console.log('\nwhich metric steps aside');
const shown = ['power', 'heartRate', 'cadence', 'speed'];
check('the active metric\'s own badge', awayKey('heartRate', shown) === 'heartRate' && awayKey('power', shown) === 'power');
check('the All page hides none', awayKey('__overview__', shown) === null);
check('nor does a metric with no badge', awayKey('smo2', shown) === null);
check('nor does a missing active key', awayKey(null, shown) === null && awayKey(undefined, shown) === null);
check('a metric whose badge is not in the row hides none', awayKey('speed', ['power', 'heartRate']) === null);
check('no badges at all', awayKey('power', []) === null && awayKey('power', undefined) === null);

console.log('\nwhich badge the hero covers');
check("on a metric's page, that page's metric (the hero is on it)", coveredKey('heartRate', null, shown) === 'heartRate');
check("a metric page wins over a stray hero key", coveredKey('power', 'speed', shown) === 'power');
check("on the All page, whichever metric the hero is on", coveredKey('__overview__', 'cadence', shown) === 'cadence' && coveredKey('__overview__', 'power', shown) === 'power');
check("on the All page with a hero metric that has no badge (SmO2), none steps aside", coveredKey('__overview__', 'smo2', shown) === null);
check("on the All page with no hero key yet, none steps aside", coveredKey('__overview__', null, shown) === null && coveredKey('__overview__', undefined, shown) === null);
check("a hero metric whose badge is not in the row covers nothing", coveredKey('__overview__', 'speed', ['power', 'heartRate']) === null);
check("nothing at all does not throw", coveredKey(null, null, undefined) === null);

console.log('\nthe rotating badge\'s pool');
const defs = shown.map(key => ({ key }));
const pool = (active, hero) => rotatorDefs(defs, active, hero).map(d => d.key).join();
check('on a metric\'s page it cycles through the other three, in row order', pool('heartRate', null) === 'power,cadence,speed' && pool('power', null) === 'heartRate,cadence,speed' && pool('speed', null) === 'power,heartRate,cadence');
check('on the All page it skips whichever metric the hero is on', pool('__overview__', 'cadence') === 'power,heartRate,speed' && pool('__overview__', 'power') === 'heartRate,cadence,speed');
check('on the All page with no hero yet it cycles through all four', pool('__overview__', null) === 'power,heartRate,cadence,speed');
check('SmO2 / core temp pages cover none of them, so all four rotate', pool('smo2', null) === 'power,heartRate,cadence,speed');
check('a page wins over a stray hero key', pool('power', 'speed') === 'heartRate,cadence,speed');
check('with two metrics, the other one holds still', pool('power', null) === 'heartRate,cadence,speed' && rotatorDefs([{ key: 'power' }, { key: 'heartRate' }], 'power', null).map(d => d.key).join() === 'heartRate');
check('with one metric on its own page there is nothing to show', rotatorDefs([{ key: 'power' }], 'power', null).length === 0);
check('the defs themselves come back (not copies of the keys)', rotatorDefs([{ key: 'power', label: 'Power' }, { key: 'speed', label: 'Speed' }], 'speed', null)[0].label === 'Power');
check('missing defs do not throw', rotatorDefs(undefined, 'power', null).length === 0 && rotatorDefs(null, null, null).length === 0);
check('the dwell is a few seconds', ROTATOR_INTERVAL_MS >= 2000 && ROTATOR_INTERVAL_MS <= 6000);

console.log('\nthe badge that goes with the hero (All page)');
const ring4 = ['power', 'heartRate', 'cadence', 'speed'];
const opp = (ring, hero, badges = ring) => oppositeKey(ring, hero, badges);
check('with four metrics Power pairs with Cadence and Heart rate with Speed',
  opp(ring4, 'power') === 'cadence' && opp(ring4, 'heartRate') === 'speed');
check('...and back again: Cadence with Power, Speed with Heart rate',
  opp(ring4, 'cadence') === 'power' && opp(ring4, 'speed') === 'heartRate');
check('with two metrics it is simply the other one', opp(['power', 'heartRate'], 'power') === 'heartRate' && opp(['power', 'heartRate'], 'heartRate') === 'power');
check('with three it is the next one on', opp(['power', 'heartRate', 'cadence'], 'power') === 'heartRate' && opp(['power', 'heartRate', 'cadence'], 'heartRate') === 'cadence' && opp(['power', 'heartRate', 'cadence'], 'cadence') === 'power');
const ring5 = ['power', 'heartRate', 'cadence', 'speed', 'smo2'], badges4 = ['power', 'heartRate', 'cadence', 'speed'];
check('five metrics (SmO2 on the ring): Power -> Cadence, Heart rate -> Speed, Speed -> Power',
  opp(ring5, 'power', badges4) === 'cadence' && opp(ring5, 'heartRate', badges4) === 'speed' && opp(ring5, 'speed', badges4) === 'power');
check('where the metric half a turn away has no badge (Cadence -> SmO2) it takes the next one that does (Power)', opp(ring5, 'cadence', badges4) === 'power');
check('the hero on a metric with no badge still gets one (SmO2 -> Heart rate)', opp(ring5, 'smo2', badges4) === 'heartRate');
check('SmO2 and core temp in the middle of the ring are stepped over',
  opp(['power', 'smo2', 'heartRate', 'coreTemp'], 'power', ['power', 'heartRate']) === 'heartRate' && opp(['power', 'smo2', 'heartRate', 'coreTemp'], 'coreTemp', ['power', 'heartRate']) === 'heartRate' && opp(['power', 'smo2', 'heartRate', 'coreTemp'], 'smo2', ['power', 'heartRate']) === 'power');
check('never the hero\'s own metric, always on the ring, whatever the ring size',
  [2, 3, 4, 5, 6].every(n => { const ring = 'abcdef'.split('').slice(0, n); return ring.every(h => { const o = opp(ring, h); return o !== h && ring.includes(o); }); }));
check('with an even ring it is a true pairing: the opposite of the opposite is the hero',
  [2, 4, 6].every(n => { const ring = 'abcdef'.split('').slice(0, n); return ring.every(h => opp(ring, opp(ring, h)) === h); }));
check('over a full turn of the hero every metric is the badge exactly once (four metrics)',
  new Set(ring4.map(h => opp(ring4, h))).size === 4);
check('a hero that is not on the ring, or a ring of one, has no partner', opp(ring4, 'smo2') === null && opp(ring4, null) === null && opp(['power'], 'power') === null && opp([], 'power') === null);
check('no other metric with a badge means none', opp(['power', 'smo2'], 'power', ['power']) === null && opp(ring4, 'power', []) === null);
check('missing arguments do not throw', oppositeKey(undefined, 'power', undefined) === null && oppositeKey(null, null, null) === null);
// The ring is the order the chart's dots run in, which is not always METRIC_ORDER (a strap that pairs before
// the power meter leaves Heart rate's dot ahead of Power's): the partner is half a turn along *that* order.
const dotRing = ['heartRate', 'power', 'cadence', 'speed'];
check('the partner follows the ring it is given, not a fixed order (dots: Heart rate, Power, Cadence, Speed)',
  opp(dotRing, 'heartRate') === 'cadence' && opp(dotRing, 'power') === 'speed' && opp(dotRing, 'cadence') === 'heartRate' && opp(dotRing, 'speed') === 'power');
check('the same four metrics in the other order pair differently (Heart rate <-> Speed there)',
  opp(ring4, 'heartRate') === 'speed' && opp(dotRing, 'heartRate') !== opp(ring4, 'heartRate'));

console.log('\nbadge text');
check('a reading with its unit', metricBadgeText(212.4, { fmt: v => Math.round(v), unit: 'W' }) === '212 W');
check('a decimal formatter is respected', metricBadgeText(28.44, { fmt: v => v.toFixed(1), unit: 'km/h' }) === '28.4 km/h');
check('zero is a reading, not a gap', metricBadgeText(0, { fmt: v => Math.round(v), unit: 'rpm' }) === '0 rpm');
check('no reading is an em dash', metricBadgeText(null, { fmt: v => v, unit: 'W' }) === '\u2014' && metricBadgeText(undefined, { fmt: v => v }) === '\u2014' && metricBadgeText(NaN, { fmt: v => v }) === '\u2014');
check('a missing unit leaves no trailing space', metricBadgeText(5, { fmt: v => v }) === '5' && metricBadgeText(5) === '5');

console.log('\nlatest sample');
check('the newest one', latestSample([{ a: 1 }, { a: 2 }]).a === 2);
check('none for an empty or missing buffer', latestSample([]) === null && latestSample(undefined) === null && latestSample(null) === null);

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll chart badge checks passed.');
