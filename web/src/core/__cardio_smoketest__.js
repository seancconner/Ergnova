// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// core/ smoke test — validates the canonical APIs used by the whole app.
// Run with: npm run test:phase0

import { capabilities, METRICS, FEATURES } from './capabilities.js';
import { createSample, mergeSample, sparseSample, rolling3sPower } from './sample.js';
import {
  createWorkout, createStep, STEP_TYPES, TARGET_TYPES,
  totalDuration, flattenWorkout, resolveWatts, stepTargetLabel,
} from './cardio-model.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

console.log('capabilities.js');
{
  capabilities.set(METRICS.POWER, true);
  check('set/has: power available after set(true)', capabilities.has(METRICS.POWER));
  capabilities.set(METRICS.POWER, false);
  check('set/has: power unavailable after set(false)', !capabilities.has(METRICS.POWER));

  capabilities.setFeature(FEATURES.ERG_MODE, true);
  check('setFeature/hasFeature: ergMode enabled', capabilities.hasFeature(FEATURES.ERG_MODE));

  let snapCalled = false;
  const unsub = capabilities.subscribe(snap => { snapCalled = true; });
  check('subscribe fires immediately', snapCalled);

  capabilities.set(METRICS.HEART_RATE, true);
  check('availableMetrics includes heartRate', capabilities.availableMetrics().includes(METRICS.HEART_RATE));

  capabilities.update({ [METRICS.CADENCE]: true, [METRICS.SPEED]: true });
  check('update bulk-sets multiple metrics', capabilities.has(METRICS.CADENCE) && capabilities.has(METRICS.SPEED));

  capabilities.clear();
  check('clear() removes all metrics and features', !capabilities.has(METRICS.CADENCE) && !capabilities.hasFeature(FEATURES.ERG_MODE));

  unsub();
}

console.log('sample.js');
{
  const s = createSample({ power: 220, cadence: 90, heartRate: 152 });
  check('createSample sets timestamp automatically', typeof s.timestamp === 'number');
  check('createSample populates provided fields', s.power === 220 && s.cadence === 90);
  check('createSample defaults unprovided fields to null', s.smo2 === null);

  const merged = mergeSample(s, { heartRate: 160, power: 230 });
  check('mergeSample overrides provided fields', merged.power === 230 && merged.heartRate === 160);
  check('mergeSample preserves unprovided fields', merged.cadence === 90);
  check('mergeSample does not mutate original', s.power === 220);

  const sparse = sparseSample(s);
  check('sparseSample omits null fields', !('smo2' in sparse));
  check('sparseSample keeps non-null fields', sparse.power === 220);

  const buf = [
    createSample({ power: 200, timestamp: Date.now() - 2000 }),
    createSample({ power: 220, timestamp: Date.now() - 1000 }),
    createSample({ power: 240, timestamp: Date.now() }),
  ];
  const avg = rolling3sPower(buf);
  check('rolling3sPower averages the 3s window', avg === Math.round((200+220+240)/3));
}

console.log('cardio-model.js');
{
  const workout = createWorkout({
    name: 'Sweet Spot 2x20',
    suggestedFtp: 250,
    steps: [
      createStep({ type: STEP_TYPES.WARMUP,   duration: 600,  targetType: TARGET_TYPES.POWER, targetLow: 0.50 }),
      createStep({ type: STEP_TYPES.INTERVAL, duration: 3000, repeat: 2,
        onStep:  createStep({ type: STEP_TYPES.STEADY, duration: 1200, targetType: TARGET_TYPES.POWER, targetLow: 0.90 }),
        offStep: createStep({ type: STEP_TYPES.REST,   duration: 300,  targetType: TARGET_TYPES.POWER, targetLow: 0.50 }),
      }),
      createStep({ type: STEP_TYPES.COOLDOWN, duration: 300,  targetType: TARGET_TYPES.POWER, targetLow: 0.40 }),
    ],
  });

  check('createWorkout sets name', workout.name === 'Sweet Spot 2x20');
  // 600 + 2*(1200+300) + 300 = 3900
  check('totalDuration expands interval repeats', totalDuration(workout) === 3900);

  const flat = flattenWorkout(workout);
  // warmup + 2*(on+off) + cooldown = 6
  check('flattenWorkout expands interval into individual reps', flat.length === 6);
  check('flattenWorkout preserves step order (warmup first)', flat[0].type === STEP_TYPES.WARMUP);
  check('flattenWorkout produces on/off pairs for interval', flat[1].type === STEP_TYPES.STEADY && flat[2].type === STEP_TYPES.REST);

  check('resolveWatts converts FTP fraction to watts', resolveWatts(0.90, 250) === 225);

  const label = stepTargetLabel(flat[1], 250);
  check('stepTargetLabel produces watts string with FTP', label.includes('W'));

  const labelPct = stepTargetLabel(flat[1], null);
  check('stepTargetLabel falls back to % FTP when no FTP given', labelPct.includes('FTP'));
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
else console.log('All Phase 0 (canonical API) checks passed.');
