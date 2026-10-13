// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// metrics/ smoke test — validates vo2max.js's math: PPO partial-stage
// credit (including edge cases), both Storer-Davis sex-coefficient
// branches, and buildRampTestWorkout()'s step generation.
// Run with: node src/metrics/__smoketest__.js
// Pure math — no DOM/BLE/IndexedDB involved, so this runs directly.

import { TEST_TYPE, buildRampTestWorkout, estimatePeakPowerOutput, estimateVo2Max }
  from './vo2max.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}
function closeTo(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

console.log('vo2max.js (buildRampTestWorkout)');
{
  const w = buildRampTestWorkout({ ftp: 220 });
  check('tags workout with TEST_TYPE', w.testType === TEST_TYPE);
  check('default startWatts is ~50% FTP rounded to nearest 5W', w.rampConfig.startWatts === 110);
  check('default incrementWatts is 15W/min (Storer-Davis protocol)', w.rampConfig.incrementWatts === 15);
  check('default stageDurationSec is 60s', w.rampConfig.stageDurationSec === 60);
  check('default maxStages produces 40 steps', w.steps.length === 40);
  check('first step name reflects startWatts', w.steps[0].name.includes('110W'));
  check('second step is one increment higher', w.steps[1].name.includes('125W'));
  check('step targets expressed as FTP fraction', closeTo(w.steps[0].targetLow, 110 / 220));

  // Low FTP: 50% would round below the 50W floor — floor should win.
  const wLow = buildRampTestWorkout({ ftp: 60 });
  check('startWatts floors at 50W for low FTP', wLow.rampConfig.startWatts === 50);

  // Explicit overrides all flow through to rampConfig and step count.
  const wCustom = buildRampTestWorkout({ ftp: 200, startWatts: 80, incrementWatts: 20, stageDurationSec: 90, maxStages: 5 });
  check('custom startWatts/increment/duration reflected in rampConfig',
    wCustom.rampConfig.startWatts === 80 && wCustom.rampConfig.incrementWatts === 20 && wCustom.rampConfig.stageDurationSec === 90);
  check('maxStages caps step count', wCustom.steps.length === 5);
  check('last step watts = start + increment*(maxStages-1)', wCustom.steps[4].name.includes('160W'));

  // No FTP on file: falls back to a flat 0.5 target rather than dividing by zero.
  const wNoFtp = buildRampTestWorkout({ ftp: 0, startWatts: 100, maxStages: 2 });
  check('falls back to 0.5 target fraction when ftp is falsy', wNoFtp.steps[0].targetLow === 0.5);
}

console.log('vo2max.js (estimatePeakPowerOutput — PPO edge cases)');
{
  const rampConfig = { startWatts: 100, incrementWatts: 15, stageDurationSec: 60 };

  // Normal case: 4 full stages done, half-way into the 5th.
  const mid = estimatePeakPowerOutput({ rampConfig, stepIndexAtStop: 4, stepElapsedAtStop: 30 });
  check('mid-test stop: prorates the partial stage onto the last completed stage', mid.watts === 153);
  check('mid-test stop (4.5 stages): no "too short" warning', mid.warnings.length === 0);

  // Edge case called out in the source comment: stopping during the very
  // FIRST stage means there is no completed stage yet, so base is 0 and
  // only the first increment is prorated (documented as slightly
  // under-crediting true PPO for this case).
  const firstStage = estimatePeakPowerOutput({ rampConfig, stepIndexAtStop: 0, stepElapsedAtStop: 20 });
  check('stop during stage 0: no completed-stage base, only the increment is prorated', firstStage.watts === 5);
  check('stop during stage 0: flagged as too short to trust', firstStage.warnings.length === 1);

  // Edge case: workout ran to completion (ScriptedSession.stop() clamps
  // stepIndexAtStop to steps.length and zeroes stepElapsedAtStop in this
  // case — see playback/scripted-session.js). PPO should land exactly on
  // the final stage's wattage.
  const completed = estimatePeakPowerOutput({ rampConfig, stepIndexAtStop: 5, stepElapsedAtStop: 0 });
  check('full completion: PPO = final (5th) stage wattage exactly', completed.watts === 160);
  check('full completion (5 stages): no "too short" warning', completed.warnings.length === 0);

  // Edge case: fraction over 1 (stepElapsedAtStop > stageDurationSec)
  // clamps to a full stage's credit rather than over-crediting.
  const overStage = estimatePeakPowerOutput({ rampConfig, stepIndexAtStop: 2, stepElapsedAtStop: 90 });
  check('stepElapsedAtStop beyond stage duration clamps fraction to 1', overStage.watts === 130);

  // Edge case: negative stepElapsedAtStop (shouldn't happen, but defended
  // against) clamps to 0 rather than crediting negative progress.
  const negative = estimatePeakPowerOutput({ rampConfig, stepIndexAtStop: 3, stepElapsedAtStop: -5 });
  check('negative stepElapsedAtStop clamps fraction to 0', negative.watts === 130);

  // Edge case: both inputs omitted entirely defaults to 0/0 rather than
  // throwing on undefined arithmetic.
  const omitted = estimatePeakPowerOutput({ rampConfig });
  check('omitted stepIndexAtStop/stepElapsedAtStop default to 0 watts, not NaN', omitted.watts === 0);
  check('omitted inputs (0 stages) flagged as too short', omitted.warnings.length === 1);

  // Edge case: stageDurationSec of 0 (guards the division in the fraction
  // calc rather than producing Infinity/NaN).
  const zeroDuration = estimatePeakPowerOutput({
    rampConfig: { ...rampConfig, stageDurationSec: 0 }, stepIndexAtStop: 2, stepElapsedAtStop: 10,
  });
  check('stageDurationSec=0 guards the fraction calc instead of dividing by zero', zeroDuration.watts === 115);
}

console.log('vo2max.js (estimateVo2Max — both Storer-Davis sex branches)');
{
  // Male branch, hand-computed from the published coefficients:
  // 10.51×300 + 6.35×75 − 10.49×35 + 519.3 = 3781.4
  const male = estimateVo2Max({ ppoWatts: 300, weightKg: 75, age: 35, sex: 'male' });
  check('male branch: vo2MaxMlMin matches Storer-Davis male equation', male.vo2MaxMlMin === 3781);
  check('male branch: vo2MaxMlKgMin normalizes by weight, rounded to 0.1', male.vo2MaxMlKgMin === 50.4);

  // Female branch: 9.39×220 + 7.70×60 − 5.88×28 + 136.7 = 2499.86
  const female = estimateVo2Max({ ppoWatts: 220, weightKg: 60, age: 28, sex: 'female' });
  check('female branch: vo2MaxMlMin matches Storer-Davis female equation', female.vo2MaxMlMin === 2500);
  check('female branch: vo2MaxMlKgMin normalizes by weight, rounded to 0.1', female.vo2MaxMlKgMin === 41.7);

  // Same PPO/weight/age, opposite sex must not produce the same result —
  // guards against the two branches accidentally collapsing to one.
  const crossCheck = estimateVo2Max({ ppoWatts: 250, weightKg: 70, age: 30, sex: 'male' });
  const crossCheckF = estimateVo2Max({ ppoWatts: 250, weightKg: 70, age: 30, sex: 'female' });
  check('male and female branches diverge for identical inputs', crossCheck.vo2MaxMlMin !== crossCheckF.vo2MaxMlMin);

  // Missing/invalid required inputs return null rather than a bogus number
  // people might otherwise act on.
  check('returns null when ppoWatts is 0/missing', estimateVo2Max({ ppoWatts: 0, weightKg: 75, age: 35, sex: 'male' }) === null);
  check('returns null when weightKg is missing', estimateVo2Max({ ppoWatts: 300, weightKg: null, age: 35, sex: 'male' }) === null);
  check('returns null when age is missing', estimateVo2Max({ ppoWatts: 300, weightKg: 75, age: null, sex: 'male' }) === null);
  check('returns null for an unrecognized sex value', estimateVo2Max({ ppoWatts: 300, weightKg: 75, age: 35, sex: 'other' }) === null);
  check('returns null when sex is omitted', estimateVo2Max({ ppoWatts: 300, weightKg: 75, age: 35 }) === null);
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
else console.log('All vo2max.js checks passed.');
