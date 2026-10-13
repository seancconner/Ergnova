// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/charts/__chart_axis_gutter_smoketest__.js
//
// Covers ChartEngine#_measureLeftPad(): the Y-axis label gutter is one worst-case width for every metric, so
// the plot's left edge does not move as the All page steps from metric to metric, or between the live chart
// and History's. Called on a stand-in `this` with a 2D context that only measures text (6px a character, a
// narrow '.' of 3px), so no canvas or DOM is needed.

import { ChartEngine } from './chart-engine.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}

const measure = (text) => ({ width: [...text].reduce((w, ch) => w + (ch === '.' ? 3 : 6), 0) });
const pad = (series) => ChartEngine.prototype._measureLeftPad.call({ _ctx: { measureText: measure, set font(v) {} } }, series);

console.log('the same gutter for every metric');
const metrics = {
  power:     { yMin: 0,  yMax: 700 },
  heartRate: { yMin: 40, yMax: 220 },
  cadence:   { yMin: 0,  yMax: 140 },
  speed:     { yMin: 0,  yMax: 60 },
  smo2:      { yMin: 0,  yMax: 100 },
  coreTemp:  { yMin: 30, yMax: 42 },        // labels like "42.0", "39.0"
  historySpeed: { yMin: 0, yMax: 27.7 },    // a session-scaled History axis: "27.7", "20.8", "13.9", "6.9"
  historyPower: { yMin: 0, yMax: 412.3 },
  small:     { yMin: 0,  yMax: 8 },         // "8", "6", "4", "2", "0"
};
const widths = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, pad(v)]));
check('every metric gets exactly the same width', new Set(Object.values(widths)).size === 1, JSON.stringify(widths));
check('it is the width of four digits plus the 14px gap (6 x 4 + 14)', widths.power === 6 * 4 + 14, widths.power);
check('a 1000+ W History axis ("1320") fits in it', pad({ yMin: 0, yMax: 1320 }) === widths.power);

console.log('\nedge cases');
check('a five-digit label grows the gutter rather than being clipped', pad({ yMin: 0, yMax: 12000 }) === 6 * 5 + 14, pad({ yMin: 0, yMax: 12000 }));
check('an overview chart (no tick labels) keeps its hairline margin', pad(null) === 12);

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll chart axis gutter checks passed.');
