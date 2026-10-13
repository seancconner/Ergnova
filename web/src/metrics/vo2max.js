// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/vo2max.js
 *
 * VO2max estimation from a cycle-ergometer ramp test, using the
 * Storer-Davis regression equation:
 *
 *   Storer TW, Davis JA, Caiozzo VJ. "Accurate prediction of VO2max in
 *   cycle ergometry." Med Sci Sports Exerc. 1990;22(5):704-712.
 *
 * That study put 115 men and 116 women (aged 20-70) through a 15 W·min⁻¹
 * ramp test to volitional exhaustion, then fit VO2max (measured by gas
 * analysis) against peak power output (Wmax), body weight, and age:
 *
 *   Men:   VO2max (mL/min) = 10.51 × Wmax + 6.35 × weight(kg) − 10.49 × age + 519.3
 *   Women: VO2max (mL/min) =  9.39 × Wmax + 7.70 × weight(kg) −  5.88 × age + 136.7
 *
 * The published standard error was ~212 mL/min (men) / ~147 mL/min
 * (women) — the authors describe estimates as accurate to within ~10% of
 * true VO2max for most healthy adults. It's a solid field estimate, not a
 * lab substitute, and it's only as good as the effort behind it: it's
 * calibrated against a 15 W/min ramp specifically, so buildRampTestWorkout()
 * defaults to exactly that rate, and the whole thing under-reads if the
 * rider stops for any reason short of genuine volitional exhaustion.
 *
 * Usage:
 *   import { buildRampTestWorkout, estimatePeakPowerOutput, estimateVo2Max }
 *     from './metrics/vo2max.js';
 *
 *   const workout = buildRampTestWorkout({ ftp: profile.ftp });
 *   // ... ride it as a ScriptedSession, tagged with workout.testType ...
 *   const ppo    = estimatePeakPowerOutput({ rampConfig, stepIndexAtStop, stepElapsedAtStop });
 *   const result = estimateVo2Max({ ppoWatts: ppo.watts, weightKg, age, sex });
 */

import { createWorkout, createStep, STEP_TYPES, TARGET_TYPES } from '../core/cardio-model.js';

export const TEST_TYPE = 'vo2max-ramp';

/**
 * Builds a ramp-test WorkoutModel: fixed-duration steady stages stepping up
 * by a constant wattage, matching the original Storer-Davis 15 W·min⁻¹
 * protocol by default. Targets are expressed in absolute watts internally,
 * then converted to FTP multipliers since that's what WorkoutStep uses —
 * so the watts actually ridden don't silently drift if FTP changes later.
 *
 * @param {Object} opts
 * @param {number} opts.ftp                    Current FTP (watts) — only
 *                                              used to express steps as FTP
 *                                              multipliers for playback.
 * @param {number} [opts.startWatts]            First stage's power.
 *                                              Defaults to ~50% FTP,
 *                                              rounded to the nearest 5W
 *                                              (minimum 50W).
 * @param {number} [opts.incrementWatts=15]     Watts added each stage —
 *                                              15 W/min matches the
 *                                              original validated protocol.
 * @param {number} [opts.stageDurationSec=60]   Seconds per stage.
 * @param {number} [opts.maxStages=40]          Safety cap on generated
 *                                              stages (40 × 60s = 40 min,
 *                                              far past anyone's
 *                                              exhaustion point) so the
 *                                              workout can't run away.
 * @returns {WorkoutModel}
 */
export function buildRampTestWorkout({
  ftp,
  startWatts,
  incrementWatts = 15,
  stageDurationSec = 60,
  maxStages = 40,
} = {}) {
  const start = startWatts ?? Math.max(50, Math.round((ftp * 0.5) / 5) * 5);
  const rampConfig = { startWatts: start, incrementWatts, stageDurationSec };

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
    name:         'VO2 Max Ramp Test',
    description:  `Ride until volitional exhaustion. Power steps up ${incrementWatts}W every ${stageDurationSec}s, starting at ${start}W. Stop as soon as you genuinely can't hold the stage — don't push past that for the sake of a bigger number, it just needs your real limit.`,
    sourceFormat: 'manual',
    steps,
  });

  // Extra fields beyond the documented WorkoutModel schema. createWorkout()
  // spreads caller fields last, so these ride along on the plain object;
  // app.js reads them off `loadedWorkout` to tag the ScriptedSession.
  workout.testType   = TEST_TYPE;
  workout.rampConfig = rampConfig;

  return workout;
}

/**
 * Estimates peak power output (PPO / Wmax) from where the rider stopped in
 * a ramp test, using the standard partial-stage credit formula:
 *
 *   PPO = (power of the last FULLY completed stage)
 *         + (seconds into the final, incomplete stage ÷ stage duration)
 *           × stage increment
 *
 * @param {Object} opts
 * @param {{startWatts:number, incrementWatts:number, stageDurationSec:number}} opts.rampConfig
 * @param {number} opts.stepIndexAtStop    0-based index of the stage the
 *                                         rider was on when they stopped —
 *                                         i.e. this many stages were fully
 *                                         completed before it.
 * @param {number} opts.stepElapsedAtStop  Seconds completed into that
 *                                         (possibly partial) final stage.
 * @returns {{ watts: number, warnings: string[] }}
 */
export function estimatePeakPowerOutput({ rampConfig, stepIndexAtStop, stepElapsedAtStop }) {
  const { startWatts, incrementWatts, stageDurationSec } = rampConfig;
  const warnings = [];

  const completedStages = Math.max(0, stepIndexAtStop ?? 0);
  const fraction = stageDurationSec > 0
    ? Math.min(1, Math.max(0, (stepElapsedAtStop ?? 0) / stageDurationSec))
    : 0;

  // Power of the last fully completed stage. If the rider stopped during
  // the very first stage (completedStages === 0) there IS no completed
  // stage yet — base is 0 and only the first increment gets prorated. That
  // slightly under-credits true PPO, but a test this short is flagged as
  // unreliable below regardless.
  const lastCompletedWatts = completedStages > 0
    ? startWatts + incrementWatts * (completedStages - 1)
    : 0;

  const watts = Math.round(lastCompletedWatts + fraction * incrementWatts);
  const totalStages = completedStages + fraction;

  if (totalStages < 4) {
    warnings.push("Test ended in under 4 stages — too short to trust. A valid ramp test runs about 8-12 minutes; if it's much shorter, start at a lower wattage next time.");
  }

  return { watts, warnings };
}

/**
 * Storer-Davis VO2max prediction from peak power output.
 * Storer TW, Davis JA, Caiozzo VJ. Med Sci Sports Exerc. 1990;22(5):704-712.
 *
 * @param {Object} opts
 * @param {number} opts.ppoWatts       Peak power output (watts), from estimatePeakPowerOutput().
 * @param {number} opts.weightKg       Body weight (kg).
 * @param {number} opts.age            Age (years).
 * @param {'male'|'female'} opts.sex   Storer-Davis only published these two coefficient sets.
 * @returns {{ vo2MaxMlMin: number, vo2MaxMlKgMin: number }|null}
 *          null if any required input is missing/invalid.
 */
export function estimateVo2Max({ ppoWatts, weightKg, age, sex }) {
  if (!ppoWatts || !weightKg || !age || (sex !== 'male' && sex !== 'female')) return null;

  const vo2MaxMlMin = sex === 'male'
    ? (10.51 * ppoWatts) + (6.35 * weightKg) - (10.49 * age) + 519.3
    : (9.39  * ppoWatts) + (7.7  * weightKg) - (5.88  * age) + 136.7;

  return {
    vo2MaxMlMin:   Math.round(vo2MaxMlMin),
    vo2MaxMlKgMin: Math.round((vo2MaxMlMin / weightKg) * 10) / 10,
  };
}

export default { TEST_TYPE, buildRampTestWorkout, estimatePeakPowerOutput, estimateVo2Max };
