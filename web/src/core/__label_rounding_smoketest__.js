// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// core/label-rounding.js smoke test. Run with:
//   node src/core/__label_rounding_smoketest__.js
//
// Covers boundsForDeclaredValue()'s tiers/zeroFloor/altTextFloor branches
// against worked examples taken straight from 21 CFR 101.9(c)'s own text
// (a declared "0g Trans Fat" implying <0.5g, a declared "140mg Sodium"
// sitting exactly on that nutrient's tier boundary, etc.), plus
// boundsForNutrients()'s tree walk and isMeaningfullyUncertain()'s two
// trigger cases. No I/O, same scope/style as core/__nutrition_smoketest__.js.

import { boundsForDeclaredValue, boundsForNutrients, isMeaningfullyUncertain } from './label-rounding.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

console.log('label-rounding.js — boundsForDeclaredValue()');
{
  // Trans fat: this module's whole reason for existing. A declared 0g
  // implies a true value anywhere under 0.5g (101.9(c)(2)(ii)) — the
  // Cinnamon-Chex-per-serving-times-a-whole-box case.
  const transZero = boundsForDeclaredValue('fat.trans', 0);
  check('fat.trans: declared 0 → [0, 0.5)', transZero.min === 0 && transZero.max === 0.5);

  // Total fat below the 5g tier boundary rounds to the nearest 0.5g.
  const fat3 = boundsForDeclaredValue('fat.total', 3);
  check('fat.total: declared 3 (below 5g tier) → ±0.25', fat3.min === 2.75 && fat3.max === 3.25);

  // Total fat above 5g rounds to the nearest whole gram instead.
  const fat12 = boundsForDeclaredValue('fat.total', 12);
  check('fat.total: declared 12 (above 5g tier) → ±0.5', fat12.min === 11.5 && fat12.max === 12.5);

  // Sodium's tier boundary is at 140mg exactly — worked example from the
  // reg text itself (nearest 5mg up to 140, nearest 10mg above).
  const sodium140 = boundsForDeclaredValue('sodiumMg', 140);
  check('sodiumMg: declared 140 (at the tier boundary) → ±2.5', sodium140.min === 137.5 && sodium140.max === 142.5);
  const sodium150 = boundsForDeclaredValue('sodiumMg', 150);
  check('sodiumMg: declared 150 (above the tier boundary) → ±5', sodium150.min === 145 && sodium150.max === 155);
  const sodiumZero = boundsForDeclaredValue('sodiumMg', 0);
  check('sodiumMg: declared 0 → [0, 5)', sodiumZero.min === 0 && sodiumZero.max === 5);

  // Calories: nearest 5 up to and including 50, nearest 10 above, <5 may
  // round all the way to zero.
  const calZero = boundsForDeclaredValue('calories', 0);
  check('calories: declared 0 → [0, 5)', calZero.min === 0 && calZero.max === 5);
  const cal50 = boundsForDeclaredValue('calories', 50);
  check('calories: declared 50 (at the tier boundary) → ±2.5', cal50.min === 47.5 && cal50.max === 52.5);
  const cal120 = boundsForDeclaredValue('calories', 120);
  check('calories: declared 120 (above 50) → ±5', cal120.min === 115 && cal120.max === 125);

  // Carb family: whole-gram rounding, with the "<1g" text alternative
  // widening things further when a caller flags it.
  const carbZero = boundsForDeclaredValue('carbs.fiber', 0);
  check('carbs.fiber: declared 0 → [0, 0.5)', carbZero.min === 0 && carbZero.max === 0.5);
  const carbOne = boundsForDeclaredValue('carbs.total', 1);
  check('carbs.total: declared 1 → ±0.5', carbOne.min === 0.5 && carbOne.max === 1.5);
  const proteinLessThanOne = boundsForDeclaredValue('protein', 0, { lessThanOneGram: true });
  check('protein: "<1g" text alternative → [0, 1)', proteinLessThanOne.min === 0 && proteinLessThanOne.max === 1);

  // Unmodeled paths (not a labeled nutrient at all, or no clean citation
  // for a fixed increment — see the RULES comment on potassiumMg) return
  // null rather than a fabricated range.
  check('carbs.starch: not a labeled nutrient → null', boundsForDeclaredValue('carbs.starch', 5) === null);
  check('potassiumMg: no codified fixed-increment rule → null', boundsForDeclaredValue('potassiumMg', 200) === null);
  check('vitamins.cMg: %DV-tiered, not modeled → null', boundsForDeclaredValue('vitamins.cMg', 10) === null);
  check('null declaredValue → null, never a guessed range', boundsForDeclaredValue('sodiumMg', null) === null);
}

console.log('label-rounding.js — boundsForNutrients()');
{
  check('null input → null', boundsForNutrients(null) === null);

  const cinnamonChexPerServing = {
    calories: 120, protein: 1,
    carbs: { total: 26, sugar: 9, fiber: 1, starch: 0 },
    fat: { total: 1, saturated: 0, monounsaturated: 0, polyunsaturated: 0, trans: 0 },
    sodiumMg: 160, cholesterolMg: 0, potassiumMg: 35,
    vitamins: { aMcg: 0, cMg: 0, dMcg: 1, eMg: 0, kMcg: 0, b1Mg: 0.4, b2Mg: 0.4, b3Mg: 5, b6Mg: 0.5, b12Mcg: 1.5, folateMcg: 400 },
    minerals: { calciumMg: 100, ironMg: 8, magnesiumMg: 8, zincMg: 4 },
  };
  const bounds = boundsForNutrients(cinnamonChexPerServing);

  check('walks nested fat.* leaves', bounds.fat.trans.min === 0 && bounds.fat.trans.max === 0.5);
  check('walks nested carbs.* leaves', bounds.carbs.fiber.min === 0.5 && bounds.carbs.fiber.max === 1.5);
  check('walks top-level scalar leaves', bounds.sodiumMg.min === 155 && bounds.sodiumMg.max === 165);
  check('carbs.starch leaf present but null (unmodeled)', 'starch' in bounds.carbs && bounds.carbs.starch === null);
  check('vitamins/minerals subtrees present but all-null leaves (unmodeled)',
    bounds.vitamins.cMg === null && bounds.minerals.ironMg === null);
}

console.log('label-rounding.js — isMeaningfullyUncertain()');
{
  check('declared 0 with a nonzero ceiling → true (the trans-fat case)',
    isMeaningfullyUncertain(0, { min: 0, max: 0.5 }) === true);
  check('declared 0 with a zero ceiling (hypothetical) → false',
    isMeaningfullyUncertain(0, { min: 0, max: 0 }) === false);
  check('band as wide as the declared value itself → true',
    isMeaningfullyUncertain(1, { min: 0.5, max: 1.5 }) === true);
  check('narrow band relative to a larger declared value → false',
    isMeaningfullyUncertain(150, { min: 145, max: 155 }) === false);
  check('null bounds → false, never throws', isMeaningfullyUncertain(5, null) === false);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
