// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// platform/background-snapshot.js smoke test — pure formatting, no DOM/timers.
// Run with: node src/platform/__background_snapshot_smoketest__.js

import { formatClock, buildCardioSnapshot, buildStrengthSnapshot } from './background-snapshot.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

// Same shape app.js's buildMetricDefs() hands over (label / unit / fmt only matter here).
const defs = {
  power:     { label: 'Power',      unit: 'W',   color: '#f97316', fmt: v => Math.round(v) },
  heartRate: { label: 'Heart Rate', unit: 'bpm', color: '#ef4444', fmt: v => Math.round(v) },
  cadence:   { label: 'Cadence',    unit: 'rpm', color: '#22d3ee', fmt: v => Math.round(v) },
  speed:     { label: 'Speed',      unit: 'km/h', color: '#a78bfa', fmt: v => v.toFixed(1) },
  smo2:      { label: 'SmO2',       unit: '%',   color: '#34d399', fmt: v => v.toFixed(1) },
};
const order = ['power', 'heartRate', 'cadence', 'speed', 'smo2'];
const base = { title: 'Threshold', status: 'running', elapsedSec: 754.2, metricDefs: defs, metricOrder: order, units: 'metric' };

console.log('background-snapshot.js');

// ── formatClock ────────────────────────────────────────────────────────
check('formatClock: m:ss under an hour', formatClock(754.9) === '12:34');
check('formatClock: h:mm:ss past an hour', formatClock(3725) === '1:02:05');
check('formatClock: zero and negatives clamp to 0:00', formatClock(0) === '0:00' && formatClock(-5) === '0:00');
check('formatClock: missing/NaN reads as an em dash', formatClock(null) === '—' && formatClock(NaN) === '—');

// ── cardio ─────────────────────────────────────────────────────────────
{
  const sample = { power: 215.4, heartRate: 148.2, cadence: 88, speed: 30, smo2: null, calories: 120.6, distance: 5230 };
  const s = buildCardioSnapshot({ ...base, sample });
  check('cardio: collapsed line is the first three live metrics, unit-formatted', s.text === '215 W · 148 bpm · 88 rpm');
  check('cardio: a metric with no reading is left out entirely', !s.expanded.includes('SmO2'));
  check('cardio: expanded packs metrics two per line', s.expanded.split('\n')[0] === 'Power 215 W · Heart Rate 148 bpm');
  check('cardio: expanded carries calories and distance', /Calories 121 kcal/.test(s.expanded) && /Distance/.test(s.expanded));
  check('cardio: title, status and elapsed pass straight through', s.title === 'Threshold' && s.status === 'running' && s.elapsedSec === 754.2);
}
{
  const s = buildCardioSnapshot({ ...base, status: 'waiting', elapsedSec: 0, sample: null });
  check('cardio: armed-and-waiting says so', s.text === 'Waiting for you to start pedaling');
}
{
  const s = buildCardioSnapshot({ ...base, sample: { power: null, heartRate: null } });
  check('cardio: running with no sensor data yet says so', s.text === 'Waiting for sensor data');
}
{
  const s = buildCardioSnapshot({
    ...base, sample: { power: 250 },
    step: { index: 1, count: 5, label: 'Interval', remainingSec: 90, targetLabel: '250W' },
  });
  const lines = s.expanded.split('\n');
  check('cardio: scripted step line shows position, label and time left', lines.includes('Step 2/5 · Interval · 1:30 left'));
  check('cardio: scripted target gets its own line', lines.includes('Target 250W'));
}
{
  const s = buildCardioSnapshot({ ...base, title: '', elapsedSec: NaN, sample: null });
  check('cardio: blank title falls back to Free Ride, NaN elapsed to 0', s.title === 'Free Ride' && s.elapsedSec === 0);
}

// ── cardio: structured fields for the icon layouts ────────────────────
{
  const sample = { power: 215.4, heartRate: 148.2, cadence: 88, speed: 30, smo2: null, calories: 120.6, distance: 5230 };
  const s = buildCardioSnapshot({ ...base, sample });
  check('cardio: metrics are the live readings in display order, keyed for the icon lookup',
    s.metrics.map(m => m.key).join() === 'power,heartRate,cadence,speed');
  check('cardio: metric value is the bare number and unit travels separately',
    s.metrics[0].value === '215' && s.metrics[0].unit === 'W' && s.metrics[0].label === 'Power');
  check('cardio: each metric carries its own chart colour', s.metrics[1].color === '#ef4444' && s.metrics[2].color === '#22d3ee');
  check('cardio: a metric with no reading is not in the structured list either', !s.metrics.some(m => m.key === 'smo2'));
  check('cardio: totals are calories and distance, unit split out',
    s.totals.length === 2 && s.totals[0].key === 'calories' && s.totals[0].value === '121' && s.totals[0].unit === 'kcal'
    && s.totals[1].key === 'distance' && s.totals[1].value === '5.2' && s.totals[1].unit === 'km');
  check('cardio: totals have no colour of their own (the native side tints them neutral)', s.totals.every(t => t.color === null));
  check('cardio: a free ride has no context notes', Array.isArray(s.notes) && s.notes.length === 0);
}
{
  const s = buildCardioSnapshot({ ...base, sample: { calories: 10, distance: 1609.344 }, units: 'imperial' });
  check('cardio: imperial distance total is in miles', s.totals[1].value === '1.0' && s.totals[1].unit === 'mi');
}
{
  const s = buildCardioSnapshot({
    ...base, sample: { power: 250 },
    step: { index: 1, count: 5, label: 'Interval', remainingSec: 90, targetLabel: '250W' },
  });
  check('cardio: scripted step is a note with its time left as the trailing value',
    s.notes[0].key === 'step' && s.notes[0].text === 'Step 2/5 · Interval' && s.notes[0].trailing === '1:30 left');
  check('cardio: scripted target is its own note', s.notes[1].key === 'target' && s.notes[1].text === 'Target 250W');
}
{
  const s = buildCardioSnapshot({ ...base, status: 'waiting', elapsedSec: 0, sample: { heartRate: 90 }, step: { index: 0, count: 1, label: 'Warm up', remainingSec: 60, targetLabel: null } });
  check('cardio: waiting has no step notes but still lists live readings (a strap can be streaming)',
    s.notes.length === 0 && s.metrics.length === 1 && s.metrics[0].key === 'heartRate');
}
{
  const s = buildCardioSnapshot({ ...base, sample: null });
  check('cardio: no sample yet gives empty (not missing) structured lists', s.metrics.length === 0 && s.totals.length === 0 && s.notes.length === 0);
}

// ── strength ───────────────────────────────────────────────────────────
{
  const s = buildStrengthSnapshot({ title: 'Legs', status: 'running', elapsedSec: 600, sample: { heartRate: 121.4 }, setCount: 3, restSec: 65 });
  check('strength: collapsed line is sets + heart rate', s.text === '3 sets · 121 bpm');
  check('strength: rest timer shows when no set is in progress', s.expanded.split('\n').includes('Resting 1:05'));
}
{
  const s = buildStrengthSnapshot({ title: 'Legs', status: 'running', elapsedSec: 60, sample: null, setCount: 1, activeExercise: 'Back Squat', restSec: 12 });
  check('strength: singular "1 set", and no heart rate when no strap is connected', s.text === '1 set');
  check('strength: an active set/hold wins over the rest timer', s.expanded.includes('Now Back Squat') && !s.expanded.includes('Resting'));
}
{
  const s = buildStrengthSnapshot({ title: 'Legs', status: 'running', elapsedSec: 600, sample: { heartRate: 121.4 }, setCount: 3, restSec: 65, metricDefs: defs });
  check('strength: metrics are sets then heart rate (the status-bar rotation)', s.metrics.map(m => m.key).join() === 'sets,heartRate');
  check('strength: sets is a bare count with its unit split out', s.metrics[0].value === '3' && s.metrics[0].unit === 'sets');
  check('strength: heart rate takes its label and colour from the metric defs', s.metrics[1].value === '121' && s.metrics[1].color === '#ef4444');
  check('strength: rest timer is a note with the clock as its trailing value', s.notes.length === 1 && s.notes[0].key === 'rest' && s.notes[0].trailing === '1:05');
  check('strength: no totals row', s.totals.length === 0);
}
{
  const s = buildStrengthSnapshot({ title: 'Legs', status: 'running', elapsedSec: 60, sample: null, setCount: 1, activeExercise: 'Back Squat', restSec: 12 });
  check('strength: no strap means sets is the only metric, singular unit', s.metrics.length === 1 && s.metrics[0].unit === 'set');
  check('strength: the exercise in progress is a note, and beats the rest timer', s.notes.length === 1 && s.notes[0].key === 'exercise' && s.notes[0].text === 'Back Squat');
}
{
  const s = buildStrengthSnapshot({ title: '', status: 'paused', elapsedSec: 5, setCount: 0 });
  check('strength: blank title falls back to Strength; status passes through', s.title === 'Strength' && s.status === 'paused' && s.text === '0 sets');
}

if (failures) {
  console.log(`\n${failures} background-snapshot check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll background-snapshot checks passed.');
