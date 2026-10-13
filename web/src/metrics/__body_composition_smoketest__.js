// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// metrics/body-composition.js smoke test. Run with:
//   node src/metrics/__body_composition_smoketest__.js
//
// Checks estimateBodyComposition() against the 7 distinct full-composition
// ground-truth rows in src/ble/smart-scale-ref/fitdays_captures_datasheet.xlsx
// that carry a raw-Z impedance table (see that module's own doc comment for
// why it's 7 of the 10 known rows, and for how these numbers were read off
// the workbook) — a regression check that the calibration hasn't drifted,
// not a claim that the formula is exact. Covers bodyFatPct/muscleMassKg/
// boneMassKg/bodyWaterKg (the original four) plus visceralFatRating and
// basalMetabolicRateKcal (added later). Also covers the null-until-
// filled-in empty state, same "don't guess from partial input" shape
// metrics/__nutrition_smoketest__.js checks for estimateBmr(). Pure math —
// no DOM/BLE/IndexedDB involved, so this runs directly under plain Node.

import { estimateBodyComposition, __internal } from './body-composition.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

const LB_TO_KG = 0.45359237;

// The 7 *_full sheets in fitdays_captures_datasheet.xlsx with a raw-Z
// table, same person throughout (male, 33, 5'4" = 64in = 162.56cm):
// [weightLb, {leftArm,rightArm,leftLeg,rightLeg} @20kHz, knownBodyFatPct,
//  knownVisceralFatRating]
const HEIGHT_CM = 64 * 2.54;
const GROUND_TRUTH = [
  { weightLb: 164.4, imp: { leftArm: 311.5, rightArm: 282.5, leftLeg: 276,   rightLeg: 277   }, bodyFatPct: 31.3, visceralFatRating: 9  },
  { weightLb: 201.6, imp: { leftArm: 300.5, rightArm: 277.5, leftLeg: 277.5, rightLeg: 277.5 }, bodyFatPct: 41.0, visceralFatRating: 16 },
  { weightLb: 182.0, imp: { leftArm: 313.7, rightArm: 302.5, leftLeg: 271.2, rightLeg: 271.5 }, bodyFatPct: 37.0, visceralFatRating: 13 },
  { weightLb: 122.2, imp: { leftArm: 296.5, rightArm: 302.5, leftLeg: 272.5, rightLeg: 274.5 }, bodyFatPct: 12.1, visceralFatRating: 1  },
  { weightLb: 219.4, imp: { leftArm: 309,   rightArm: 303,   leftLeg: 275,   rightLeg: 273   }, bodyFatPct: 44.9, visceralFatRating: 20 },
  { weightLb: 237.0, imp: { leftArm: 271.5, rightArm: 251.5, leftLeg: 160,   rightLeg: 170   }, bodyFatPct: 44.7, visceralFatRating: 20 },
  { weightLb: 81.4,  imp: { leftArm: 291.5, rightArm: 287.5, leftLeg: 272.5, rightLeg: 269.5 }, bodyFatPct: 3.0,  visceralFatRating: 1  },
];
const BODY_FAT_TOLERANCE_PP = 3.5; // percentage points — see module doc comment
// End-to-end (through the estimated, not known, fat mass) — see module doc
// comment's VISCERAL FAT RATING section for why this is wider than the
// 1.27 the pure fit-against-known-fat-mass gets.
const VISCERAL_FAT_TOLERANCE_RATING = 2;

console.log('body-composition.js (calibration fit against the 7 known full readings)');
{
  for (const row of GROUND_TRUTH) {
    const est = estimateBodyComposition({
      weightKg: row.weightLb * LB_TO_KG,
      heightCm: HEIGHT_CM,
      impedance20kHzOhm: row.imp,
    });
    check(
      `${row.weightLb} lb: body-fat% within ${BODY_FAT_TOLERANCE_PP}pp of known ${row.bodyFatPct}% (got ${est.bodyFatPct}%)`,
      Math.abs(est.bodyFatPct - row.bodyFatPct) <= BODY_FAT_TOLERANCE_PP,
    );
    check(
      `${row.weightLb} lb: visceral fat rating within ${VISCERAL_FAT_TOLERANCE_RATING} of known ${row.visceralFatRating} (got ${est.visceralFatRating})`,
      Math.abs(est.visceralFatRating - row.visceralFatRating) <= VISCERAL_FAT_TOLERANCE_RATING,
    );
  }
}

console.log('body-composition.js (partition ratios / internal consistency)');
{
  const est = estimateBodyComposition({
    weightKg: 182.0 * LB_TO_KG,
    heightCm: HEIGHT_CM,
    impedance20kHzOhm: { leftArm: 313.7, rightArm: 302.5, leftLeg: 271.2, rightLeg: 271.5 },
  });
  const weightKg = 182.0 * LB_TO_KG;
  // bodyFatPct is rounded to 1 decimal on the way out (see module doc
  // comment's returned shape), so reconstructing fat-free mass from it
  // reintroduces a small rounding gap — a fraction of a rounding step in
  // weightKg, not a real inconsistency. ROUNDING_SLOP_KG covers that.
  const ROUNDING_SLOP_KG = weightKg * 0.001;
  const fatMassKg = weightKg * (est.bodyFatPct / 100);
  const ffmKg = weightKg - fatMassKg;

  check('muscleMassKg + boneMassKg reconstructs fat-free mass', Math.abs((est.muscleMassKg + est.boneMassKg) - ffmKg) < ROUNDING_SLOP_KG);
  check('boneMassKg matches the fixed BONE_TO_FFM_RATIO', Math.abs(est.boneMassKg - ffmKg * __internal.BONE_TO_FFM_RATIO) < ROUNDING_SLOP_KG);
  check('bodyWaterKg matches the fixed WATER_TO_MUSCLE_RATIO', Math.abs(est.bodyWaterKg - est.muscleMassKg * __internal.WATER_TO_MUSCLE_RATIO) < 1e-6);
  check('bodyWaterKg stays below muscleMassKg (water is a fraction of it, not on top of it)', est.bodyWaterKg < est.muscleMassKg);

  // basalMetabolicRateKcal should be exactly Katch-McArdle (370 + 21.6 ×
  // leanBodyMassKg) applied to this same reading's own muscleMassKg +
  // boneMassKg — see module doc comment's BASAL METABOLIC RATE section.
  const expectedBmr = 370 + 21.6 * (est.muscleMassKg + est.boneMassKg);
  check('basalMetabolicRateKcal matches Katch-McArdle on this reading\'s own lean mass', Math.abs(est.basalMetabolicRateKcal - expectedBmr) < 1);
}

console.log('body-composition.js (empty/invalid-input handling)');
{
  check('missing weightKg returns null', estimateBodyComposition({ heightCm: 165, impedance20kHzOhm: { leftArm: 300, rightArm: 300, leftLeg: 270, rightLeg: 270 } }) === null);
  check('missing heightCm returns null', estimateBodyComposition({ weightKg: 80, impedance20kHzOhm: { leftArm: 300, rightArm: 300, leftLeg: 270, rightLeg: 270 } }) === null);
  check('missing impedance returns null', estimateBodyComposition({ weightKg: 80, heightCm: 165 }) === null);
  check('a zero/negative limb impedance returns null rather than dividing oddly', estimateBodyComposition({ weightKg: 80, heightCm: 165, impedance20kHzOhm: { leftArm: 300, rightArm: 0, leftLeg: 270, rightLeg: 270 } }) === null);
  check('called with no arguments at all returns null', estimateBodyComposition() === null);
}

console.log('body-composition.js (clamp on out-of-calibration-range input)');
{
  // An implausibly tall/low-impedance input would otherwise drive the raw
  // linear fit negative or past 100% — MIN/MAX_BODY_FAT_PCT clamp it.
  const extreme = estimateBodyComposition({
    weightKg: 50 * LB_TO_KG, heightCm: 210,
    impedance20kHzOhm: { leftArm: 200, rightArm: 200, leftLeg: 200, rightLeg: 200 },
  });
  check('clamps to MIN_BODY_FAT_PCT rather than going negative', extreme.bodyFatPct === __internal.MIN_BODY_FAT_PCT);
  check('clamps to MIN_VISCERAL_FAT_RATING rather than going negative', extreme.visceralFatRating === __internal.MIN_VISCERAL_FAT_RATING);

  const heavy = estimateBodyComposition({
    weightKg: 500 * LB_TO_KG, heightCm: 150,
    impedance20kHzOhm: { leftArm: 400, rightArm: 400, leftLeg: 400, rightLeg: 400 },
  });
  check('clamps to MAX_BODY_FAT_PCT rather than exceeding it', heavy.bodyFatPct === __internal.MAX_BODY_FAT_PCT);
  check('clamps to MAX_VISCERAL_FAT_RATING rather than exceeding it', heavy.visceralFatRating === __internal.MAX_VISCERAL_FAT_RATING);
  // No MIN/MAX_BMR_KCAL clamp check here — reaching either bound would need
  // a leanBodyMassKg past what MAX_BODY_FAT_PCT/realistic weightKg inputs
  // can produce upstream (the "heavy" case above, already at the body-fat
  // ceiling, only reaches ~2085 kcal). The clamp is a defensive floor/
  // ceiling against a corrupted upstream value, not something this
  // function's own valid input range can trigger — see its declaration
  // comment.
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
else console.log('All body-composition checks passed.');
