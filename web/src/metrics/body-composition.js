// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/body-composition.js
 *
 * Estimates the body-composition figures the Fitdays app shows (body fat %,
 * muscle mass, bone mass, body water, visceral fat rating, BMR) from the one
 * thing this project has actually confirmed the scale transmits beyond
 * weight: raw segmental bioelectrical impedance (ble/fitdays-device.js,
 * cheatsheet §3.1). Fitdays' own algorithm for turning impedance + weight +
 * a stored profile into those numbers is proprietary and isn't on the wire
 * anywhere this project has found — see that file's PROTOCOL STATUS note.
 * Everything below is this project's own best-effort reconstruction, not a
 * decode of Fitdays' actual formula.
 * *
 * DERIVATION — calibrated against this project's own reference data, not
 * decoded off the wire. src/ble/smart-scale-ref/fitdays_captures_datasheet.xlsx
 * now has 10 distinct full-composition ground-truth readings for the one
 * subject this scale has ever been tested against (male, 33, 5'4"/162.6cm —
 * the sheets named *_full), spanning 81.4-237.0 lb. Only 7 of those 10 have
 * a raw-Z impedance table though — the 3 from btsnoop1 (183.6/186.0/187.0 lb,
 * the mobile-card-style Fitdays screens) only ever captured the *displayed*
 * composition numbers, not the underlying impedance. That's a hard
 * constraint, not an oversight: BFPCT_*, BONE_TO_FFM_RATIO, and
 * WATER_TO_MUSCLE_RATIO below all take impedance as an input, so those 3
 * rows structurally can't be part of that fit — there's no path to a wider
 * calibration there without a fresh capture from those weights (or nearby
 * ones) that happens to land on the raw-Z-table screen. The visceral-fat
 * fit below is different: it regresses against Fitdays' own displayed Fat
 * Mass number, not impedance, so all 10 rows *are* usable there and all 10
 * were used. Lining up the four composition numbers Fitdays displays
 * side by side (Fat Mass, Bone Mass, Protein Mass, Water Weight) across the
 * original seven turned up two fixed ratios that hold to within rounding on
 * every single one:
 *   - Fat Mass + Bone Mass + Protein Mass + Water Weight == Weight (the
 *     four displayed masses are a strict partition of total weight)
 *   - "Muscle Mass" == Protein Mass + Water Weight, exactly, every row
 *   - Bone Mass / (Weight − Fat Mass) sits at 0.0664-0.0680 (mean 0.0673)
 *     regardless of weight
 *   - Water Weight / Muscle Mass sits at 0.7843-0.7869 (mean 0.7855)
 *     regardless of weight
 * i.e. once Fat Mass is known, Bone Mass/Muscle Mass/Water Weight all fall
 * out as fixed fractions of the remainder — Fitdays isn't independently
 * measuring four things here, it's estimating one (body fat) and
 * partitioning the rest by a fixed formula. That partition is very likely
 * tied to this one subject's frame (bone-mass-as-a-fraction-of-lean-mass is
 * known clinically to depend on frame size, which this single-subject
 * dataset can't vary) — see LIMITATIONS below.
 *
 * That leaves one real unknown to estimate: body fat %. A least-squares fit
 * of body-fat% against weight and a resistance index (height² / average
 * 20kHz limb impedance — the classic single-frequency BIA predictor,
 * adapted here because this project only has impedance magnitude at two
 * frequencies, not the reactance/phase-angle data equations like Kyle et
 * al. actually call for) over the same 7 rows lands within ~3.5 percentage
 * points of every known reading (see __body_composition_smoketest__.js).
 * That's roughly the same order of disagreement two different consumer BIA
 * scales typically show on the same person — "plausible ballpark," not
 * "matches Fitdays."
 *
 * VISCERAL FAT RATING — added once the 10-row dataset made this checkable.
 * Regressing the scale's displayed visceral-fat-rating integer against
 * *known* fat mass (lb) alone (not against impedance — fat mass, already
 * itself an estimate one step removed at inference time, see below) is a
 * very clean fit: R²=0.988, worst residual 1.27 rating-points across all
 * 10 rows, most under 0.7. That's the fit against ground-truth fat mass,
 * though — estimateBodyComposition() actually feeds it *estimated* fat
 * mass (from the 7-row bodyFatPct fit above), so the real end-to-end error
 * is a bit wider: replaying all 7 impedance-bearing ground-truth rows
 * through the full function gives a worst-case 2-rating-point miss, most
 * within 1 (see __body_composition_smoketest__.js). Treat it with the same
 * "rough estimate, single-subject-calibrated" caveat as everything else
 * here; see LIMITATIONS.
 *
 * BASAL METABOLIC RATE — NOT reimplemented here. The moment bodyFatPct is
 * known, deriveLeanBodyMassKg() (core/nutrition-model.js) + estimateBmr()
 * (metrics/nutrition.js, Katch-McArdle) already give a BMR from it — adding
 * a second formula here would just be a competing guess. This module calls
 * that same estimateBmr() at the bottom of estimateBodyComposition() so
 * every consumer (Fitdays sync included) gets one consistent BMR number
 * instead of two that can disagree.
 *
 * LIMITATIONS (read before trusting this for anyone but the calibration
 * subject):
 *   - All 10 calibration points are the same person at the same height —
 *     nothing here shows how any of this should change for a different
 *     height, age, or sex. heightCm is still a real input (taller → higher
 *     resistance index → higher predicted fat-free mass, the physically
 *     correct direction), but its coefficient was never fit against anyone
 *     but this one subject — treat a result for a very different body type
 *     as a rough decoration, not a number to log and trust.
 *   - Trunk impedance was never decoded off this scale (cheatsheet §3.1's
 *     one open item) — this estimate only ever sees the four limbs. Real
 *     8-point BIA formulas fold trunk in too; leaving it out is one more
 *     reason this is a rough estimate rather than a lab result.
 *   - Visceral fat rating is estimated from fat mass, which is itself
 *     already an estimate — errors compound rather than being independent
 *     measurements agreeing (worst observed end-to-end: 2 rating-points,
 *     see module doc comment above). It's also an integer field on a 1-59
 *     scale that this dataset has only ever exercised 1-20 of; treat any
 *     reading this pushes toward the high end of that range as
 *     extrapolation, not a validated result.
 *   - BMR inherits whatever error bodyFatPct/leanBodyMassKg already carry —
 *     Katch-McArdle itself is a well-established formula, but "well
 *     established formula fed a rough estimate" is still a rough estimate
 *     out the other end, not a lab-grade BMR.
 *
 * Usage:
 *   import { estimateBodyComposition } from './metrics/body-composition.js';
 *   const est = estimateBodyComposition({
 *     weightKg, heightCm,
 *     impedance20kHzOhm: { leftArm, rightArm, leftLeg, rightLeg },
 *   });
 *   // est: { bodyFatPct, muscleMassKg, boneMassKg, bodyWaterKg,
 *   //        visceralFatRating, basalMetabolicRateKcal } | null
 */

import { estimateBmr } from './nutrition.js';


const LB_TO_KG = 0.45359237;
const KG_TO_LB = 1 / LB_TO_KG;
const CM_TO_IN = 0.393701;

// Least-squares fit of body-fat% against [resistanceIndex, weightLb, 1]
// over the 7 ground-truth rows in fitdays_captures_datasheet.xlsx (see
// module doc comment) — residuals were all under 3.5 percentage points.
const BFPCT_RESISTANCE_INDEX_COEFF = -1.526;
const BFPCT_WEIGHT_LB_COEFF        = 0.3196;
const BFPCT_INTERCEPT              = -1.664;

// Fixed partition ratios read directly off the same 7 rows (see module doc
// comment) — not fit to noise, just the ratio Fitdays' own numbers already
// show between each other.
const BONE_TO_FFM_RATIO     = 0.0673; // Bone Mass / (Weight - Fat Mass)
const WATER_TO_MUSCLE_RATIO = 0.7855; // Water Weight / Muscle Mass

// Clamp so a wildly out-of-calibration-range input (very different body
// type, or a noisy impedance read) can't produce a negative or
// physiologically-impossible percentage — same "clamp rather than trust
// extrapolation" stance _decodeWeightByte()'s K_SEARCH_RANGE takes in
// fitdays-device.js, just for a different field.
const MIN_BODY_FAT_PCT = 3;
const MAX_BODY_FAT_PCT = 65;

// Least-squares fit of the scale's displayed visceral-fat-rating integer
// against estimated fat mass (lb) alone, over all 10 ground-truth rows (see
// module doc comment) — R²=0.988, worst residual 1.27 rating-points.
const VISCERAL_FAT_MASS_LB_COEFF = 0.20162;
const VISCERAL_FAT_INTERCEPT     = -0.7161;

// Clamped to the same 1-59 range #pref-visceral-fat's own min/max already
// assert in index.html — not a range this project derived independently.
// The calibration data only ever exercised 1-20 of it; see LIMITATIONS.
const MIN_VISCERAL_FAT_RATING = 1;
const MAX_VISCERAL_FAT_RATING = 59;

// Defensive clamp matching #pref-bmr's own min/max in index.html — Katch-
// McArdle shouldn't realistically leave this range for a plausible human
// leanBodyMassKg, but a corrupted/out-of-range upstream estimate shouldn't
// be allowed to write a nonsense value into a saved profile either.
const MIN_BMR_KCAL = 500;
const MAX_BMR_KCAL = 5000;

/**
 * @param {Object} params
 * @param {number} params.weightKg
 * @param {number} params.heightCm
 * @param {{leftArm:number, rightArm:number, leftLeg:number, rightLeg:number}} params.impedance20kHzOhm
 *   Raw 20kHz segmental impedance in ohms, as decoded from the INDICATE
 *   composition record — see fitdays-device.js's _decodeCompositionRecord().
 * @returns {{bodyFatPct:number, muscleMassKg:number, boneMassKg:number, bodyWaterKg:number, visceralFatRating:number, basalMetabolicRateKcal:number}|null}
 *   null if weightKg/heightCm/impedance are missing or non-positive — same
 *   "don't guess from partial input" stance estimateBmr() takes in
 *   metrics/nutrition.js.
 */
export function estimateBodyComposition({ weightKg, heightCm, impedance20kHzOhm } = {}) {
  if (!weightKg || weightKg <= 0 || !heightCm || heightCm <= 0 || !impedance20kHzOhm) return null;
  const { leftArm, rightArm, leftLeg, rightLeg } = impedance20kHzOhm;
  const limbs = [leftArm, rightArm, leftLeg, rightLeg];
  if (!limbs.every(v => typeof v === 'number' && v > 0)) return null;

  const weightLb = weightKg * KG_TO_LB;
  const heightIn = heightCm * CM_TO_IN;
  const avgLimbOhm = limbs.reduce((sum, v) => sum + v, 0) / limbs.length;
  const resistanceIndex = (heightIn * heightIn) / avgLimbOhm;

  const rawBodyFatPct = BFPCT_RESISTANCE_INDEX_COEFF * resistanceIndex
    + BFPCT_WEIGHT_LB_COEFF * weightLb
    + BFPCT_INTERCEPT;
  const bodyFatPct = Math.min(MAX_BODY_FAT_PCT, Math.max(MIN_BODY_FAT_PCT, rawBodyFatPct));

  const fatMassLb   = weightLb * (bodyFatPct / 100);
  const ffmLb       = weightLb - fatMassLb;
  const boneMassLb  = BONE_TO_FFM_RATIO * ffmLb;
  const muscleMassLb = ffmLb - boneMassLb;
  const bodyWaterLb  = WATER_TO_MUSCLE_RATIO * muscleMassLb;

  const rawVisceralFatRating = VISCERAL_FAT_MASS_LB_COEFF * fatMassLb + VISCERAL_FAT_INTERCEPT;
  const visceralFatRating = Math.round(
    Math.min(MAX_VISCERAL_FAT_RATING, Math.max(MIN_VISCERAL_FAT_RATING, rawVisceralFatRating))
  );

  // Katch-McArdle via the same canonical formula every other BMR consumer
  // in this app uses (see module doc comment's BASAL METABOLIC RATE
  // section) — leanBodyMassKg alone is enough to take estimateBmr() straight
  // to that branch, no age/sex/height needed.
  const leanBodyMassKg = ffmLb * LB_TO_KG;
  const rawBmr = estimateBmr({ leanBodyMassKg });
  const basalMetabolicRateKcal = Math.round(
    Math.min(MAX_BMR_KCAL, Math.max(MIN_BMR_KCAL, rawBmr))
  );

  return {
    bodyFatPct: Math.round(bodyFatPct * 10) / 10,
    muscleMassKg: muscleMassLb * LB_TO_KG,
    boneMassKg: boneMassLb * LB_TO_KG,
    bodyWaterKg: bodyWaterLb * LB_TO_KG,
    visceralFatRating,
    basalMetabolicRateKcal,
  };
}

// Exported for the smoke test — not part of the module's public surface.
export const __internal = {
  BFPCT_RESISTANCE_INDEX_COEFF, BFPCT_WEIGHT_LB_COEFF, BFPCT_INTERCEPT,
  BONE_TO_FFM_RATIO, WATER_TO_MUSCLE_RATIO,
  MIN_BODY_FAT_PCT, MAX_BODY_FAT_PCT,
  VISCERAL_FAT_MASS_LB_COEFF, VISCERAL_FAT_INTERCEPT,
  MIN_VISCERAL_FAT_RATING, MAX_VISCERAL_FAT_RATING,
  MIN_BMR_KCAL, MAX_BMR_KCAL,
};

export default { estimateBodyComposition };
