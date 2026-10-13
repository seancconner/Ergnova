// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/ftp-test.js
 *
 * Functional Threshold Power (FTP) estimation from two independent field
 * test protocols. Unlike VO2max (see metrics/vo2max.js), which has one
 * well-validated regression behind it, FTP has no single canonical test —
 * these are the two most widely used field estimates in cycling training,
 * and each has real, different trade-offs, so both are offered rather than
 * picking one for the rider.
 *
 *   RAMP TEST (ftp-ramp)
 *   Structurally the same as the VO2 Max Ramp Test: power increases in
 *   fixed steps until volitional exhaustion. FTP is estimated as ~75% of
 *   the best sustained 1-minute average power reached anywhere in the
 *   ride — the convention popularized by TrainerRoad's Ramp Test. Faster
 *   to run (usually well under 20 minutes total), but the 75% multiplier
 *   is an empirical shortcut rather than a physiological law — published
 *   and in-the-wild versions of this style of test use multipliers
 *   anywhere from roughly 70-76%, so treat the result as a solid starting
 *   number, not a precise one. It also wants the same stopping rule as
 *   the VO2max test: stop because you genuinely can't hold the wattage,
 *   not for any other reason.
 *
 *   20-MINUTE TEST (ftp-20min)
 *   The original Coggan/TrainingPeaks protocol (Allen H, Coggan A.
 *   "Training and Racing with a Power Meter"): warm up, then ride a
 *   sustained 20-minute effort paced as hard as can genuinely be held for
 *   the whole 20 minutes, then FTP is estimated as 95% of that 20-minute
 *   average power. Longer and more demanding to execute well — starting
 *   too hard and fading undershoots the true number — but the 95% figure
 *   has a longer track record and doesn't depend on picking out a single
 *   best-minute window from an already-fatiguing ramp.
 *
 * Both numbers are estimates of a threshold that itself isn't perfectly
 * well-defined physiologically. Treat either as a useful training
 * reference, not a certified lab value — and note that neither of these
 * tests auto-applies its result to the rider's saved FTP; see app.js's
 * FTP-test confirmation banner. FTP drives every future workout's target
 * watts, so overwriting it silently on the strength of one field estimate
 * is exactly the kind of thing that deserves a confirmation, not an
 * automatic update.
 *
 * Usage:
 *   import { buildFtpRampTestWorkout, buildFtpTwentyMinTestWorkout,
 *            estimateFtpFromRamp, estimateFtpFromTwentyMin }
 *     from './metrics/ftp-test.js';
 *
 *   const workout = buildFtpRampTestWorkout({ ftp: profile.ftp });
 *   // ... ride it as a ScriptedSession, tagged with workout.testType ...
 *   const result = estimateFtpFromRamp({ samples: record.samples });
 */

import { createWorkout, createStep, STEP_TYPES, TARGET_TYPES } from '../core/cardio-model.js';

export const TEST_TYPE_RAMP   = 'ftp-ramp';
export const TEST_TYPE_TWENTY = 'ftp-20min';

// ─── Ramp protocol ──────────────────────────────────────────────────────────

/**
 * Builds an FTP Ramp Test WorkoutModel: fixed-duration steady stages
 * stepping up by a constant wattage until the rider stops. Structurally
 * identical to buildRampTestWorkout() in metrics/vo2max.js — same
 * step-based construction — but with a larger default increment (20W/min
 * is the common default for this style of test, vs. the VO2max protocol's
 * validated 15W/min) and no rampConfig/PPO bookkeeping, since the FTP
 * estimate here is read straight off the ride's best 1-minute power
 * rather than credited per-stage.
 *
 * @param {Object} opts
 * @param {number} opts.ftp                    Current FTP (watts) — only
 *                                              used to express steps as FTP
 *                                              multipliers for playback.
 * @param {number} [opts.startWatts]            First stage's power.
 *                                              Defaults to ~50% FTP,
 *                                              rounded to the nearest 5W
 *                                              (minimum 50W).
 * @param {number} [opts.incrementWatts=20]     Watts added each stage.
 * @param {number} [opts.stageDurationSec=60]   Seconds per stage.
 * @param {number} [opts.maxStages=30]          Safety cap on generated
 *                                              stages so the workout can't
 *                                              run away.
 * @returns {WorkoutModel}
 */
export function buildFtpRampTestWorkout({
  ftp,
  startWatts,
  incrementWatts = 20,
  stageDurationSec = 60,
  maxStages = 30,
} = {}) {
  const start = startWatts ?? Math.max(50, Math.round((ftp * 0.5) / 5) * 5);

  const steps = [];
  for (let i = 0; i < maxStages; i++) {
    const watts = start + incrementWatts * i;
    steps.push(createStep({
      type:       STEP_TYPES.STEADY,
      duration:   stageDurationSec,
      targetType: TARGET_TYPES.POWER,
      targetLow:  ftp ? watts / ftp : 0.5,
      targetHigh: ftp ? watts / ftp : 0.5,
      name:       `Stage ${i + 1} — ${watts}W`,
    }));
  }

  const workout = createWorkout({
    name:         'FTP Ramp Test',
    description:  `Ride until volitional exhaustion. Power steps up ${incrementWatts}W every ${stageDurationSec}s, starting at ${start}W. FTP is estimated from your best 1-minute average power, so stop as soon as you genuinely can't hold the stage — same rule as the VO2 Max test.`,
    sourceFormat: 'manual',
    steps,
  });

  workout.testType = TEST_TYPE_RAMP;
  return workout;
}

/**
 * Finds the best (highest) rolling average power over a given window
 * length, scanning the whole sample buffer — e.g. the best sustained
 * 1-minute power anywhere in the ride. Assumes ~1Hz sampling with no
 * large gaps, same assumption metrics/normalized-power.js makes for its
 * 30-second rolling window.
 *
 * @param {Sample[]} samples
 * @param {number}   windowSec
 * @returns {number|null}   Watts, or null if there isn't enough power data.
 */
function bestRollingAveragePower(samples, windowSec) {
  const powers = samples.map(s => s.power).filter(v => v !== null && v !== undefined);
  if (powers.length < windowSec) return null;

  let windowSum = 0;
  for (let i = 0; i < windowSec; i++) windowSum += powers[i];
  let best = windowSum / windowSec;

  for (let i = windowSec; i < powers.length; i++) {
    windowSum += powers[i] - powers[i - windowSec];
    const avg = windowSum / windowSec;
    if (avg > best) best = avg;
  }
  return best;
}

/**
 * Estimates FTP from an FTP Ramp Test ride, as ~75% of the best sustained
 * 1-minute average power anywhere in the ride.
 *
 * @param {Object}   opts
 * @param {Sample[]} opts.samples      Full session sample buffer.
 * @param {number}   [opts.multiplier=0.75]
 * @returns {{ bestOneMinWatts: number|null, ftpWatts: number|null, warnings: string[] }}
 */
export function estimateFtpFromRamp({ samples, multiplier = 0.75 }) {
  const warnings = [];
  const best1min = bestRollingAveragePower(samples ?? [], 60);

  if (best1min == null) {
    warnings.push('Not enough power data to estimate FTP from this ride — need at least a minute of continuous power.');
    return { bestOneMinWatts: null, ftpWatts: null, warnings };
  }

  const totalSec = (samples ?? []).length; // 1Hz assumed, consistent with the rest of the codebase
  if (totalSec < 4 * 60) {
    warnings.push('Test ended in under 4 minutes — too short to trust. A valid ramp test needs a genuine multi-minute effort.');
  }

  return {
    bestOneMinWatts: Math.round(best1min),
    ftpWatts:        Math.round(best1min * multiplier),
    warnings,
  };
}

// ─── 20-minute protocol ─────────────────────────────────────────────────────

/**
 * Builds an FTP 20-Minute Test WorkoutModel: warm-up, a 5-minute hard
 * "opener" effort (primes the legs and clears some anaerobic capacity —
 * part of the original protocol, not the measured segment), an easy
 * recovery spin, the 20-minute test itself, then a cooldown. The opener
 * and the test segment are both FREE_RIDE/NONE-target steps rather than
 * ERG-locked — both are meant to be self-paced maximal efforts, not held
 * to a prescribed wattage.
 *
 * testSegmentStartSec/testSegmentDurationSec are computed once here (every
 * earlier step has a fixed, known duration) and carried on the returned
 * workout object so app.js can forward them into the session's meta at
 * start — see estimateFtpFromTwentyMin(), which uses them to slice exactly
 * the 20-minute segment's samples out of the full ride.
 *
 * @param {Object} opts
 * @param {number} opts.ftp                     Current FTP (watts) — used
 *                                               to express the warm-up/
 *                                               recovery/cooldown steps as
 *                                               FTP multipliers.
 * @param {number} [opts.warmupSec=600]
 * @param {number} [opts.openerSec=300]
 * @param {number} [opts.recoverySec=600]
 * @param {number} [opts.testDurationSec=1200]
 * @param {number} [opts.cooldownSec=300]
 * @returns {WorkoutModel}
 */
export function buildFtpTwentyMinTestWorkout({
  ftp,
  warmupSec       = 600,
  openerSec       = 300,
  recoverySec     = 600,
  testDurationSec = 1200,
  cooldownSec     = 300,
} = {}) {
  const steps = [
    createStep({
      type:       STEP_TYPES.WARMUP,
      duration:   warmupSec,
      targetType: TARGET_TYPES.POWER,
      targetLow:  0.55,
      targetHigh: 0.55,
      name:       'Warm-up',
    }),
    createStep({
      type:       STEP_TYPES.FREE_RIDE,
      duration:   openerSec,
      targetType: TARGET_TYPES.NONE,
      targetLow:  0,
      name:       '5-min hard opener — hard, not all-out. This primes the legs; it is not the test.',
    }),
    createStep({
      type:       STEP_TYPES.REST,
      duration:   recoverySec,
      targetType: TARGET_TYPES.POWER,
      targetLow:  0.5,
      targetHigh: 0.5,
      name:       'Easy recovery spin',
    }),
    createStep({
      type:       STEP_TYPES.FREE_RIDE,
      duration:   testDurationSec,
      targetType: TARGET_TYPES.NONE,
      targetLow:  0,
      name:       '20-MINUTE TEST — pace it evenly, don\u2019t blow up in the first 5',
    }),
    createStep({
      type:       STEP_TYPES.COOLDOWN,
      duration:   cooldownSec,
      targetType: TARGET_TYPES.POWER,
      targetLow:  0.4,
      targetHigh: 0.4,
      name:       'Cooldown',
    }),
  ];

  const testSegmentStartSec = warmupSec + openerSec + recoverySec;

  const workout = createWorkout({
    name:         'FTP 20-Minute Test',
    description:  'Warm up, a 5-min hard opener, an easy spin, then a 20-minute effort ridden as hard as you can genuinely sustain for the full 20 minutes — even pacing beats starting too hot. FTP is estimated as 95% of your average power for that 20-minute block.',
    sourceFormat: 'manual',
    steps,
  });

  workout.testType               = TEST_TYPE_TWENTY;
  workout.testSegmentStartSec    = testSegmentStartSec;
  workout.testSegmentDurationSec = testDurationSec;

  return workout;
}

/**
 * Estimates FTP from an FTP 20-Minute Test ride, as 95% of the average
 * power over just the 20-minute test segment (not the whole ride — the
 * warm-up/opener/recovery/cooldown are excluded by slicing on
 * elapsedTime, which tracks active session time the same way the rest of
 * the recording pipeline does).
 *
 * @param {Object}   opts
 * @param {Sample[]} opts.samples                 Full session sample buffer.
 * @param {number}   opts.testSegmentStartSec     From the workout (see
 *                                                 buildFtpTwentyMinTestWorkout()),
 *                                                 forwarded via record.meta.
 * @param {number}   opts.testSegmentDurationSec  Same.
 * @param {number}   [opts.multiplier=0.95]
 * @returns {{ avgWatts: number|null, ftpWatts: number|null, warnings: string[] }}
 */
export function estimateFtpFromTwentyMin({
  samples,
  testSegmentStartSec,
  testSegmentDurationSec,
  multiplier = 0.95,
}) {
  const warnings = [];

  if (testSegmentStartSec == null || testSegmentDurationSec == null) {
    warnings.push('Missing test segment info for this ride — can\u2019t isolate the 20-minute effort.');
    return { avgWatts: null, ftpWatts: null, warnings };
  }

  const segmentEndSec = testSegmentStartSec + testSegmentDurationSec;
  const segmentSamples = (samples ?? []).filter(
    s => s.elapsedTime != null && s.elapsedTime >= testSegmentStartSec && s.elapsedTime < segmentEndSec
  );

  if (segmentSamples.length < testSegmentDurationSec * 0.9) {
    warnings.push('The 20-minute test segment looks incomplete — the ride may have been stopped early or steps were skipped. Treat this estimate with caution.');
  }

  const powers = segmentSamples.map(s => s.power).filter(v => v !== null && v !== undefined);
  if (powers.length === 0) {
    warnings.push('No power data found for the 20-minute test segment.');
    return { avgWatts: null, ftpWatts: null, warnings };
  }

  const avgWatts = powers.reduce((a, b) => a + b, 0) / powers.length;

  return {
    avgWatts: Math.round(avgWatts),
    ftpWatts: Math.round(avgWatts * multiplier),
    warnings,
  };
}

export default {
  TEST_TYPE_RAMP,
  TEST_TYPE_TWENTY,
  buildFtpRampTestWorkout,
  estimateFtpFromRamp,
  buildFtpTwentyMinTestWorkout,
  estimateFtpFromTwentyMin,
};