// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/hr-test.js
 *
 * Resting heart-rate measurement, structured the same way as the fitness
 * tests in metrics/ftp-test.js and metrics/vo2max.js: a purpose-built
 * WorkoutModel the rider "rides" (here, sits or lies still through) as a
 * ScriptedSession, tagged with a testType so app.js's onSessionComplete()
 * routes the finished recording to the matching estimator.
 *
 * Unlike every other test in this app, there's no effort to prescribe —
 * the whole point is the *opposite* of a structured target, so the
 * generated workout is a single untargeted step (TARGET_TYPES.NONE,
 * STEP_TYPES.FREE_RIDE — same "leave the trainer alone" shape the FTP
 * 20-minute test's own self-paced segments use), just long enough to let
 * a heart rate that started slightly elevated (sitting down, anticipating
 * the test) settle to its true resting value.
 *
 * A true clinical resting HR is measured lying down, ideally first thing
 * after waking, before caffeine or any activity — this in-app version is
 * a reasonable seated approximation, not a substitute for that. The
 * estimator accounts for the settling-in period (see settleSec below) but
 * can't correct for "rode over here first" or "just had coffee".
 *
 * Usage:
 *   import { buildRestingHrTestWorkout, estimateRestingHr } from './metrics/hr-test.js';
 *
 *   const workout = buildRestingHrTestWorkout();
 *   // ... ride it as a ScriptedSession, tagged with workout.testType ...
 *   const result = estimateRestingHr({ samples: record.samples });
 */

import { createWorkout, createStep, STEP_TYPES, TARGET_TYPES } from '../core/cardio-model.js';

export const TEST_TYPE = 'resting-hr';

// ─── Test protocol ──────────────────────────────────────────────────────────

/**
 * Builds a Resting Heart Rate Test WorkoutModel: one untargeted, fixed
 * duration step asking the rider to sit or lie still and breathe
 * normally. Deliberately short (3 minutes by default) to keep the test
 * quick enough to actually get run, while still leaving enough settled
 * time (see settleSec in estimateRestingHr()) for a meaningful reading —
 * a rider who wants a more clinically accurate number is better served
 * measuring by hand on waking than a longer in-app sit, so this doesn't
 * try to chase that with duration alone.
 *
 * @param {Object} opts
 * @param {number} [opts.durationSec=180]  Total seconds to sit/lie still.
 * @returns {WorkoutModel}
 */
export function buildRestingHrTestWorkout({ durationSec = 180 } = {}) {
  const steps = [
    createStep({
      type:       STEP_TYPES.FREE_RIDE,
      duration:   durationSec,
      targetType: TARGET_TYPES.NONE,
      targetLow:  0,
      name:       'Sit or lie still, breathe normally — the more relaxed, the more accurate.',
    }),
  ];

  const workout = createWorkout({
    name:         'Resting Heart Rate Test',
    description:  'Sit or, ideally, lie down somewhere quiet and stay still for the full test, breathing normally. The first stretch is discarded to let a heart rate that started slightly elevated settle — this only reads the calmest sustained stretch after that.',
    sourceFormat: 'manual',
    steps,
  });

  workout.testType = TEST_TYPE;
  return workout;
}

// ─── Estimator ───────────────────────────────────────────────────────────────

/**
 * Finds the lowest (rather than highest — see bestRollingAveragePower() in
 * metrics/ftp-test.js, which this mirrors in shape) rolling average over a
 * given window length, scanning the whole sample buffer. Assumes ~1Hz
 * sampling with no large gaps, same assumption the rest of the codebase's
 * rolling-window math makes.
 *
 * @param {Sample[]} samples
 * @param {number}   windowSec
 * @returns {number|null}
 */
function lowestRollingAverageHr(samples, windowSec) {
  const hrs = samples.map(s => s.heartRate).filter(v => v != null);
  if (hrs.length < windowSec) return null;

  let windowSum = 0;
  for (let i = 0; i < windowSec; i++) windowSum += hrs[i];
  let lowest = windowSum / windowSec;

  for (let i = windowSec; i < hrs.length; i++) {
    windowSum += hrs[i] - hrs[i - windowSec];
    const avg = windowSum / windowSec;
    if (avg < lowest) lowest = avg;
  }
  return lowest;
}

/**
 * Estimates resting heart rate from a Resting HR Test recording, as the
 * lowest sustained rolling average heart rate found anywhere in the ride
 * after discarding the first `settleSec` — a rolling *minimum* rather than
 * a plain average over the whole thing, since a straight average is
 * dragged up by however elevated the rider's HR still was right after
 * sitting down, while the lowest sustained window is far closer to their
 * actual resting rate and self-corrects for a slow settle without needing
 * to guess how long that took.
 *
 * @param {Object}   opts
 * @param {Sample[]} opts.samples          Full session sample buffer.
 * @param {number}   [opts.settleSec=30]   Seconds discarded from the start.
 * @param {number}   [opts.windowSec=60]   Rolling-average window length.
 * @returns {{ restingHrBpm: number|null, warnings: string[] }}
 */
export function estimateRestingHr({ samples, settleSec = 30, windowSec = 60 }) {
  const warnings = [];
  const all = samples ?? [];

  // elapsedTime is seconds-into-session on every recorded sample (see
  // core/sample.js / recording/session.js#_tick) — slicing on it rather
  // than array index keeps this correct even if a sample or two was
  // dropped along the way.
  const settled = all.filter(s => s.elapsedTime == null || s.elapsedTime >= settleSec);

  const lowest = lowestRollingAverageHr(settled, windowSec);
  if (lowest == null) {
    warnings.push(`Not enough heart-rate data after the first ${settleSec}s to estimate a resting rate — need a strap paired and at least ${windowSec}s of continuous readings once settled.`);
    return { restingHrBpm: null, warnings };
  }

  const totalSec = all.length; // 1Hz assumed, consistent with the rest of the codebase
  if (totalSec < settleSec + windowSec) {
    warnings.push('Test ended too soon to trust — it needs to run long enough to both settle and hold still afterward.');
  }

  return {
    restingHrBpm: Math.round(lowest),
    warnings,
  };
}

export default { TEST_TYPE, buildRestingHrTestWorkout, estimateRestingHr };
