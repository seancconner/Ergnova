// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// strength/ smoke test — validates strength-model.js, set-tracker.js, and
// metrics/one-rep-max.js. Run with: node src/core/__strength_smoketest__.js

import { createStrengthSet, SET_MODES, totalVolume, totalHoldTime, groupByExercise, recentExerciseNames } from './strength-model.js';
import { SetTracker } from '../recording/set-tracker.js';
import { estimatedOneRepMax, bestOneRepMax } from '../metrics/one-rep-max.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

console.log('strength-model.js');
{
  const s = createStrengthSet({ exercise: 'Back Squat', weight: 100, reps: 5 });
  check('createStrengthSet: defaults mode to reps', s.mode === SET_MODES.REPS);
  check('createStrengthSet: caller fields win', s.exercise === 'Back Squat' && s.weight === 100 && s.reps === 5);
  check('createStrengthSet: unset fields are null, not undefined', s.rpe === null && s.holdSeconds === null);

  const sets = [
    createStrengthSet({ exercise: 'Back Squat', weight: 100, reps: 5 }),
    createStrengthSet({ exercise: 'Back Squat', weight: 100, reps: 5 }),
    createStrengthSet({ exercise: 'Plank', mode: SET_MODES.HOLD, holdSeconds: 45 }),
  ];
  check('totalVolume: sums weight*reps, ignores holds/bodyweight', totalVolume(sets) === 1000);
  check('totalHoldTime: sums hold seconds, ignores reps sets', totalHoldTime(sets) === 45);

  const groups = groupByExercise(sets);
  check('groupByExercise: groups by exercise, preserves order', groups.length === 2 && groups[0].exercise === 'Back Squat' && groups[0].sets.length === 2);

  const sessions = [
    { meta: { type: 'strength', sets: [{ exercise: 'Back Squat' }, { exercise: 'Plank' }] } },
    { meta: { type: 'cardio' } }, // non-strength session, should be ignored
    { meta: { type: 'strength', sets: [{ exercise: 'Back Squat' }, { exercise: 'Deadlift' }] } },
  ];
  const recent = recentExerciseNames(sessions);
  check('recentExerciseNames: dedupes and skips non-strength sessions', recent.length === 3 && recent.includes('Deadlift'));
}

console.log('metrics/one-rep-max.js');
{
  check('estimatedOneRepMax: epley 100kg x5 ~ 117', estimatedOneRepMax(100, 5) === 117);
  check('estimatedOneRepMax: reps=1 returns weight unchanged', estimatedOneRepMax(120, 1) === 120);
  check('estimatedOneRepMax: brzycki differs from epley at other rep counts', estimatedOneRepMax(100, 8, 'brzycki') !== estimatedOneRepMax(100, 8, 'epley'));
  check('estimatedOneRepMax: invalid input returns null', estimatedOneRepMax(0, 5) === null && estimatedOneRepMax(100, 0) === null);

  const sets = [
    createStrengthSet({ mode: SET_MODES.REPS, weight: 100, reps: 5 }),  // ~117
    createStrengthSet({ mode: SET_MODES.REPS, weight: 90, reps: 8 }),   // ~114
    createStrengthSet({ mode: SET_MODES.HOLD, holdSeconds: 30 }),       // ignored
  ];
  check('bestOneRepMax: picks the highest estimate, ignores holds', bestOneRepMax(sets) === 117);
}

console.log('recording/set-tracker.js');
{
  const tracker = new SetTracker();
  const now = Date.now();

  // Simulate a 1Hz sample buffer with a rising heart rate, like a real
  // isometric hold — HR climbing from 110 to 130 across 8 samples.
  const samples = Array.from({ length: 10 }, (_, i) => ({
    timestamp: now + i * 1000,
    heartRate: 110 + i * 2,
  }));

  check('inProgress: false before any beginSet()', tracker.inProgress === false);
  tracker.beginSet({ exercise: 'Plank', mode: SET_MODES.HOLD, targetHoldSeconds: 45 }, 1, now + 1000);
  check('inProgress: true after beginSet()', tracker.inProgress === true);

  // sampleIndex here mirrors session.sampleCount, which always equals
  // session.samples.length — so "end" is the array length (10), not 9,
  // the same way slice(start, samples.length) naturally reaches the last
  // element in real usage.
  const finished = tracker.completeSet({ holdSeconds: 8 }, samples.length, samples, now + 9000);
  check('completeSet: returns the finished set with setNumber 1', finished.setNumber === 1);
  check('completeSet: HR summary reflects the sample window (start=112, end=128)', finished.hrStart === 112 && finished.hrEnd === 128);
  check('completeSet: hrDrift = hrEnd - hrStart', finished.hrDrift === 16);
  check('inProgress: false again after completeSet()', tracker.inProgress === false);

  // Second set on the same exercise should increment setNumber, and a set
  // on a different exercise should track its own numbering independently.
  tracker.logSet({ exercise: 'Plank', mode: SET_MODES.HOLD, holdSeconds: 40 }, 10, samples, now + 10000);
  const secondPlank = tracker.sets[tracker.sets.length - 1];
  check('logSet: second set of same exercise gets setNumber 2', secondPlank.setNumber === 2);

  tracker.logSet({ exercise: 'Wall Sit', mode: SET_MODES.HOLD, holdSeconds: 30 }, 11, samples, now + 11000);
  const wallSit = tracker.sets[tracker.sets.length - 1];
  check('logSet: different exercise starts its own numbering at 1', wallSit.setNumber === 1);

  check('sets: returns a copy, not the live array', tracker.sets !== tracker._sets);

  const cancelTracker = new SetTracker();
  cancelTracker.beginSet({ exercise: 'Plank', mode: SET_MODES.HOLD }, 0, now);
  cancelTracker.cancelSet();
  check('cancelSet: discards the pending set without logging it', cancelTracker.inProgress === false && cancelTracker.sets.length === 0);
}

console.log(failures === 0 ? '\nAll strength smoke tests passed.' : `\n${failures} strength smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
