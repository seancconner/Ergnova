// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// metrics/daily-values.js smoke test. Run with:
//   node src/metrics/__daily_values_smoketest__.js
//
// Covers dailyValueFor()'s three personalization rules (calorie-scaled,
// body-weight-scaled, sex-specific) plus its flat-FDA-value fallback,
// percentDailyValue()/nutrientStatusList()'s math, focusNutrients()'s
// upperLimit exclusion + tie-break order, watchNutrients()'s threshold,
// and rankIngredientsForFocus()/rankRecipesForFocus()/bestFocusMatch()'s
// scoring + both the "without going over today's remaining budget" and
// the absolute "already within 5% of the full daily limit on its own"
// exclusions. Pure math — no DOM/IndexedDB involved, same scope as
// metrics/__nutrition_smoketest__.js.

import {
  NUTRIENT_REFERENCE, dailyValueFor, percentDailyValue, nutrientStatusList,
  focusNutrients, watchNutrients, rankIngredientsForFocus, rankRecipesForFocus, bestFocusMatch,
} from './daily-values.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}
function closeTo(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

console.log('daily-values.js (dailyValueFor — flat FDA fallback)');
{
  const fiber = dailyValueFor('fiber', {});
  check('flat baseAmount used with no profile/targetKcal', closeTo(fiber.amount, 28));
  check('unit carried through from NUTRIENT_REFERENCE', fiber.unit === 'g');
  check('upperLimit false for a get-more-of nutrient', fiber.upperLimit === false);

  const sodium = dailyValueFor('sodium', {});
  check('upperLimit true for a nutrient-to-limit', sodium.upperLimit === true);

  check('null for a key with no established DV (totalSugars)', dailyValueFor('totalSugars', {}) === null);
  check('null for an unknown key', dailyValueFor('notAKey', {}) === null);
}

console.log('daily-values.js (dailyValueFor — scalesWithCalories)');
{
  const at2000 = dailyValueFor('fiber', { targetKcal: 2000 });
  check('targetKcal=2000 matches the flat baseAmount (2000 is the reference)', closeTo(at2000.amount, 28));

  const at3000 = dailyValueFor('fiber', { targetKcal: 3000 });
  check('targetKcal=3000 scales up proportionally (28 * 1.5 = 42)', closeTo(at3000.amount, 42));

  const noTarget = dailyValueFor('fiber', { targetKcal: null });
  check('null targetKcal falls back to the flat baseAmount', closeTo(noTarget.amount, 28));

  const satFatUpper = dailyValueFor('satFat', { targetKcal: 4000 });
  check('scalesWithCalories applies to upperLimit nutrients too (20 * 2 = 40)', closeTo(satFatUpper.amount, 40));
}

console.log('daily-values.js (dailyValueFor — bodyWeightGPerKg)');
{
  const withWeight = dailyValueFor('protein', { profile: { riderWeight: 90 } });
  check('0.8 g/kg * 90 kg = 72', closeTo(withWeight.amount, 72));

  const noWeight = dailyValueFor('protein', { profile: {} });
  check('missing riderWeight falls back to the flat 50g label value', closeTo(noWeight.amount, 50));

  const noProfile = dailyValueFor('protein', {});
  check('missing profile entirely falls back to the flat 50g label value', closeTo(noProfile.amount, 50));
}

console.log('daily-values.js (dailyValueFor — sexValues)');
{
  const male = dailyValueFor('iron', { profile: { sex: 'male' } });
  check('male iron RDA is 8mg', closeTo(male.amount, 8));

  const female = dailyValueFor('iron', { profile: { sex: 'female' } });
  check('female iron RDA is 18mg', closeTo(female.amount, 18));

  const unknownSex = dailyValueFor('iron', { profile: { sex: 'unspecified' } });
  check('unrecognized sex value falls back to the flat 18mg label value', closeTo(unknownSex.amount, 18));

  const noProfile = dailyValueFor('iron', {});
  check('missing profile falls back to the flat 18mg label value', closeTo(noProfile.amount, 18));
}

console.log('daily-values.js (percentDailyValue)');
{
  check('50% of a 2300mg sodium DV', closeTo(percentDailyValue('sodium', 1150, {}), 50));
  check('0% floor for a negative/garbage amount', percentDailyValue('sodium', -500, {}) === 0);
  check('null amount treated as 0', percentDailyValue('sodium', null, {}) === 0);
  check('null for a key with no DV at all', percentDailyValue('totalSugars', 50, {}) === null);
}

console.log('daily-values.js (nutrientStatusList)');
{
  const nutrients = { protein: 40, sodiumMg: 1150, minerals: { ironMg: 9 } };
  const status = nutrientStatusList(nutrients, { profile: { sex: 'female' } });
  check('only DV-tracked keys are included (excludes the 5 null-dv keys)', status.length === Object.keys(NUTRIENT_REFERENCE).length - 5);
  const sodiumRow = status.find(s => s.key === 'sodium');
  check('sodium row carries the right amount/pct', sodiumRow.amount === 1150 && closeTo(sodiumRow.pct, 50));
  const ironRow = status.find(s => s.key === 'iron');
  check('iron row personalizes off profile.sex (9 / 18 = 50%)', closeTo(ironRow.pct, 50));
  const proteinRow = status.find(s => s.key === 'protein');
  check('a missing accessor path (unmeasured nutrient) reads as amount 0, not a crash',
    status.find(s => s.key === 'calcium').amount === 0);
  check('protein row present and non-crashing', proteinRow.amount === 40);
}

console.log('daily-values.js (focusNutrients)');
{
  // Fresh-day tie: everything at 0% DV. protein/fiber/potassium should win
  // the tie by object order (the file's own documented fallback), not by
  // whichever key happens to sort first alphabetically or by insertion
  // in this test.
  const emptyStatus = nutrientStatusList(null, {});
  const freshDayFocus = focusNutrients(emptyStatus);
  check('fresh-day (nothing logged) focus is generically useful, not upperLimit nutrients',
    freshDayFocus.every(f => !f.upperLimit));
  check('fresh-day focus leads with protein/fiber/potassium (documented tie-break order)',
    freshDayFocus[0].key === 'protein' && freshDayFocus[1].key === 'fiber' && freshDayFocus[2].key === 'potassium');

  const mixedStatus = nutrientStatusList(
    { protein: 60, carbs: { fiber: 2 }, potassiumMg: 4000, sodiumMg: 2200 },
    { profile: { riderWeight: 75, sex: 'male' } }
  );
  const focus = focusNutrients(mixedStatus, { limit: 4 });
  check('upperLimit nutrients (sodium) never appear in focus even when far under 100%',
    !focus.some(f => f.key === 'sodium'));
  check('worst-first ordering (lowest %DV leads)', focus[0].pct <= focus[focus.length - 1].pct);
  check('limit option caps the returned count', focusNutrients(mixedStatus, { limit: 2 }).length === 2);
}

console.log('daily-values.js (watchNutrients)');
{
  const emptyStatus = nutrientStatusList(null, {});
  check('fresh day (nothing logged) has no watch nutrients', watchNutrients(emptyStatus).length === 0);

  const status = nutrientStatusList({ sodiumMg: 2100, fat: { saturated: 5 }, cholesterolMg: 50 }, {});
  const watch = watchNutrients(status, { thresholdPct: 60 });
  check('sodium at ~91% clears the 60% watch threshold', watch.some(w => w.key === 'sodium'));
  check('cholesterol at ~17% stays below threshold and is excluded', !watch.some(w => w.key === 'cholesterol'));
  check('highest-pct-first ordering', watch[0].pct >= watch[watch.length - 1].pct);
  check('only upperLimit nutrients ever appear', watch.every(w => w.upperLimit));
}

console.log('daily-values.js (rankIngredientsForFocus / bestFocusMatch)');
{
  // Nothing logged yet at all, so the top-4 focus list is the documented
  // 0%-tie fallback order: protein, fiber, potassium, vitaminA (see the
  // focusNutrients test block above) — fiber is genuinely "in focus"
  // here, unlike a status where fiber already has partial progress and
  // would rank *behind* nutrients still sitting at a flat 0%.
  const status = nutrientStatusList(null, { profile: { sex: 'female' } });
  const highFiber = { id: 'a', perHundredG: { carbs: { fiber: 12 }, sodiumMg: 5 } };
  const highSodium = { id: 'b', perHundredG: { carbs: { fiber: 1 }, sodiumMg: 3000 } }; // would blow the whole day's sodium DV on its own
  const irrelevant = { id: 'c', perHundredG: { carbs: { fiber: 0 }, sodiumMg: 5 } };

  const ranked = rankIngredientsForFocus([irrelevant, highSodium, highFiber], status);
  check('an ingredient that would push sodium over 100% DV on its own is excluded entirely',
    !ranked.some(i => i.id === 'b'));
  check('the best source of the most-deficient focus nutrient sorts first', ranked[0].id === 'a');
  check('nothing is fabricated — the excluded ingredient is really gone, not just sorted last', ranked.length === 2);

  const focus = focusNutrients(status, { limit: 4 });
  const match = bestFocusMatch(highFiber.perHundredG, focus);
  check('bestFocusMatch names Dietary Fiber for the high-fiber ingredient', match?.label === 'Dietary Fiber');

  const noMatch = bestFocusMatch(irrelevant.perHundredG, focus);
  check('bestFocusMatch returns null for an ingredient with nothing to offer', noMatch === null);
}

console.log('daily-values.js (rankRecipesForFocus — same ranking, applied to perServing)');
{
  const status = nutrientStatusList(null, { profile: { sex: 'female' } });
  const highFiberRecipe = { id: 'r1', perServing: { carbs: { fiber: 10 }, sodiumMg: 100 } };
  const highSodiumRecipe = { id: 'r2', perServing: { carbs: { fiber: 1 }, sodiumMg: 3000 } }; // would blow the whole day's sodium DV on its own
  const irrelevantRecipe = { id: 'r3', perServing: { carbs: { fiber: 0 }, sodiumMg: 5 } };

  const ranked = rankRecipesForFocus([irrelevantRecipe, highSodiumRecipe, highFiberRecipe], status);
  check('a recipe that would push sodium over 100% DV on its own is excluded entirely',
    !ranked.some(r => r.id === 'r2'));
  check('the best source of the most-deficient focus nutrient sorts first', ranked[0].id === 'r1');
  check('nothing is fabricated — the excluded recipe is really gone, not just sorted last', ranked.length === 2);
}

console.log('daily-values.js (rankIngredientsForFocus/rankRecipesForFocus — absolute nutrient-to-limit exclusion)');
{
  // Fresh day: nothing logged yet, so remaining sodium headroom is the
  // *full* 2300mg DV — the pre-existing "would push past today's
  // remaining budget" check alone would NOT catch either recipe below,
  // since neither one's sodium exceeds 2300mg on its own. The newer
  // absolute check (within 5% of the full DV) is what excludes r2 here.
  const status = nutrientStatusList(null, { profile: { sex: 'female' } });
  const veryHighSodiumRecipe = { id: 'r1', perServing: { carbs: { fiber: 1 }, sodiumMg: 2200 } }; // 2200/2300 ≈ 95.7% — within 5% of the full DV
  const moderateSodiumRecipe = { id: 'r2', perServing: { carbs: { fiber: 1 }, sodiumMg: 1000 } }; // well under the full DV, and under today's remaining budget

  const ranked = rankRecipesForFocus([veryHighSodiumRecipe, moderateSodiumRecipe], status);
  check("a recipe within 5% of a full day's sodium DV in one serving is excluded even on a fresh, nothing-logged day",
    !ranked.some(r => r.id === 'r1'));
  check('a recipe comfortably under that absolute threshold is kept', ranked.some(r => r.id === 'r2'));

  // Same absolute rule applies to ingredients (shared _fitsWithinLimits()
  // under both rankers) — a 100g reference amount within 5% of the full
  // sodium DV is excluded too, not just a recipe serving.
  const veryHighSodiumIngredient = { id: 'i1', perHundredG: { carbs: { fiber: 1 }, sodiumMg: 2250 } };
  const rankedIngredients = rankIngredientsForFocus([veryHighSodiumIngredient], status);
  check('the same absolute exclusion applies to a plain ingredient\'s 100g reference amount',
    rankedIngredients.length === 0);
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
else console.log('All daily-values.js checks passed.');
