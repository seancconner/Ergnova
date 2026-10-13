// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/charts/__chart_order_smoketest__.js
//
// Covers charts/chart-order.js — the one list that says what order the chart metrics (and so the carousel's
// dots) run in: heart rate, power, cadence, speed. The carousel's DOM re-seating and the dots themselves are
// checked in the running app (this project has no DOM test runner).

import { CHART_METRIC_ORDER, sortMetricKeys, sortMetricDefs, pageOrder } from './chart-order.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}

console.log('the order');
check('heart rate, power, cadence, speed, then SmO2 and core temp',
  CHART_METRIC_ORDER.join() === 'heartRate,power,cadence,speed,smo2,coreTemp');

console.log('\nsorting keys');
check('whatever order sensors paired in, the result is chart order',
  sortMetricKeys(['speed', 'power', 'heartRate', 'cadence']).join() === 'heartRate,power,cadence,speed');
check('a power meter that pairs before the strap still lands after heart rate',
  sortMetricKeys(['power', 'heartRate']).join() === 'heartRate,power');
check('a subset keeps chart order', sortMetricKeys(['speed', 'power']).join() === 'power,speed');
check('SmO2 and core temp go after the four main metrics',
  sortMetricKeys(['coreTemp', 'speed', 'smo2', 'heartRate']).join() === 'heartRate,speed,smo2,coreTemp');
check('unknown keys follow the known ones, in the order they came',
  sortMetricKeys(['zzz', 'power', 'aaa', 'heartRate']).join() === 'heartRate,power,zzz,aaa');
check('the input array is not modified', (() => { const a = ['speed', 'heartRate']; sortMetricKeys(a); return a.join() === 'speed,heartRate'; })());
check('nothing in, nothing out', sortMetricKeys([]).length === 0 && sortMetricKeys(undefined).length === 0 && sortMetricKeys(null).length === 0);

console.log('\nsorting defs');
const defs = [{ key: 'speed', n: 1 }, { key: 'power', n: 2 }, { key: 'heartRate', n: 3 }];
const sorted = sortMetricDefs(defs);
check('defs come back in chart order with their own fields', sorted.map(d => d.key).join() === 'heartRate,power,speed' && sorted[0].n === 3);
check('the input array is not modified', defs[0].key === 'speed');
check('empty and missing', sortMetricDefs([]).length === 0 && sortMetricDefs(undefined).length === 0);

console.log('\nthe carousel\'s page order');
check('the All page first, then the metrics in the host\'s order',
  pageOrder('__overview__', ['heartRate', 'power', 'cadence'], ['power', 'cadence', 'heartRate', '__overview__']).join() === '__overview__,heartRate,power,cadence');
check('no All page: just the metrics', pageOrder(null, ['heartRate', 'power'], ['power', 'heartRate']).join() === 'heartRate,power');
check('a wanted metric with no page yet is skipped', pageOrder(null, ['heartRate', 'power', 'speed'], ['power', 'speed']).join() === 'power,speed');
check('a page nobody wants any more is dropped', pageOrder(null, ['power'], ['power', 'cadence']).join() === 'power');
check('works with a Set or a Map\'s keys', pageOrder(null, ['heartRate', 'power'], new Map([['power', 1], ['heartRate', 2]]).keys()).join() === 'heartRate,power');
check('nothing wanted', pageOrder('__overview__', [], []).join() === '__overview__' && pageOrder(null, undefined, []).length === 0);

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll chart order checks passed.');
