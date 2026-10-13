// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// core/nutrition-model.js smoke test. Run with:
//   node src/core/__nutrition_smoketest__.js
//
// Covers the pure model functions only (scaleNutrients/sumNutrients/
// macroCalorieSplit/recipeNutrientsPerServing) — same scope as
// __strength_smoketest__.js's strength-model.js coverage, no IndexedDB
// involved (storage/db.js's new stores/CRUD aren't exercised here; there's
// no indexedDB shim in plain Node, same reason db.js itself has never been
// covered by these scripts).

import {
  MEAL_SLOTS, createEmptyNutrients, scaleNutrients, sumNutrients,
  macroCalorieSplit, createIngredient, createRecipe, recipeNutrientsPerServing,
  createDiaryEntry, createBodyMeasurement, deriveLeanBodyMassKg, gramsForSizeOption,
  scaleRecipeIngredients, perHundredGFromLabel,
} from './nutrition-model.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

console.log('nutrition-model.js — factories');
{
  const chicken = createIngredient({
    name: 'Chicken Breast, Raw',
    perHundredG: {
      ...createEmptyNutrients(),
      calories: 165, protein: 31,
      carbs: { total: 0, sugar: 0, fiber: 0, starch: 0 },
      fat:   { total: 3.6, saturated: 1.0, monounsaturated: 1.2, polyunsaturated: 0.8, trans: 0 },
    },
  });
  check('createIngredient: id is a stable custom: string', chicken.id.startsWith('custom:'));
  check('createIngredient: two calls get different ids', createIngredient().id !== createIngredient().id);
  check('createIngredient: caller fields win', chicken.name === 'Chicken Breast, Raw');
  check('createIngredient: unset density defaults to null (no volume entry)', chicken.densityGPerMl === null);
  check('createIngredient: unset sizeOptions defaults to null (no Size mode)', chicken.sizeOptions === null);

  const oliveOil = createIngredient({ name: 'Olive Oil', densityGPerMl: 0.92 });
  check('createIngredient: density carries through when provided', oliveOil.densityGPerMl === 0.92);

  const recipe = createRecipe({ name: 'Grilled Chicken', servings: 2 });
  check('createRecipe: no id until db.saveRecipe() assigns one', !('id' in recipe));
  check('createRecipe: defaults servings/ingredients sanely', recipe.servings === 2 && Array.isArray(recipe.ingredients) && recipe.ingredients.length === 0);
  check('createRecipe: defaults steps to an empty array (print sheet has nothing to number yet)', Array.isArray(recipe.steps) && recipe.steps.length === 0);
  check('createRecipe: caller-supplied steps carry through in order', createRecipe({ steps: ['Sear the chicken.', 'Rest, then slice.'] }).steps[1] === 'Rest, then slice.');

  const entry = createDiaryEntry({ mealSlot: MEAL_SLOTS.LUNCH });
  check('createDiaryEntry: no id until db.saveDiaryEntry() assigns one', !('id' in entry));
  check('createDiaryEntry: mealSlot override applied', entry.mealSlot === 'lunch');
  check('createDiaryEntry: defaults to now', Math.abs(entry.loggedAt - Date.now()) < 1000);

  const measurement = createBodyMeasurement({ weightKg: 74.2 });
  check('createBodyMeasurement: no id until db.saveBodyMeasurement() assigns one', !('id' in measurement));
  check('createBodyMeasurement: defaults source to manual', measurement.source === 'manual');
  check('createBodyMeasurement: bodyFatPct/leanBodyMassKg stay null until a scale reports them', measurement.bodyFatPct === null && measurement.leanBodyMassKg === null);

  // deriveLeanBodyMassKg() — shared by app.js's manual Rider Profile entry
  // and _recordScaleMeasurement()'s BLE-reading path (see its doc comment).
  check('deriveLeanBodyMassKg: 80kg @ 20% body fat -> 64kg lean mass', deriveLeanBodyMassKg(80, 20) === 64);
  check('deriveLeanBodyMassKg: null weight -> null', deriveLeanBodyMassKg(null, 20) === null);
  check('deriveLeanBodyMassKg: null bodyFatPct -> null', deriveLeanBodyMassKg(80, null) === null);
  check('deriveLeanBodyMassKg: both null -> null', deriveLeanBodyMassKg(null, null) === null);
  check('deriveLeanBodyMassKg: 0% body fat -> lean mass equals weight', deriveLeanBodyMassKg(70, 0) === 70);
}

console.log('nutrition-model.js — scaleNutrients');
{
  const chickenPer100g = {
    calories: 165, protein: 31,
    carbs: { total: 0, sugar: 0, fiber: 0, starch: 0 },
    fat:   { total: 3.6, saturated: 1.0, monounsaturated: 1.2, polyunsaturated: 0.8, trans: 0 },
    sodiumMg: 74, cholesterolMg: 85, potassiumMg: 256,
    vitamins: { aMcg: 6, cMg: 0, dMcg: 0.1, eMg: 0.3, kMcg: 0.3, b1Mg: 0.07, b2Mg: 0.1, b3Mg: 13.7, b6Mg: 0.6, b12Mcg: 0.3, folateMcg: 4 },
    minerals: { calciumMg: 15, ironMg: 0.4, magnesiumMg: 29, zincMg: 1.0 },
  };

  const scaled150g = scaleNutrients(chickenPer100g, 150);
  check('scaleNutrients: 150g scales top-level fields by 1.5x', scaled150g.calories === 247.5 && scaled150g.protein === 46.5);
  // Float-multiplication tolerance (1.2 * 1.5 !== 1.8 to the bit in IEEE 754) rather than a bug in scaleNutrients() itself.
  check('scaleNutrients: scales nested fat tree too, not just top-level', scaled150g.fat.saturated === 1.5 && Math.abs(scaled150g.fat.monounsaturated - 1.8) < 1e-9);
  check('scaleNutrients: scales nested vitamins tree', Math.abs(scaled150g.vitamins.b3Mg - 13.7 * 1.5) < 1e-9);
  check('scaleNutrients: 100g is identity', scaleNutrients(chickenPer100g, 100).calories === 165);
  check('scaleNutrients: null input short-circuits to null', scaleNutrients(null, 150) === null && scaleNutrients(chickenPer100g, null) === null);
}

console.log('nutrition-model.js — sumNutrients');
{
  const a = { calories: 100, protein: 10, carbs: { total: 5, sugar: 1, fiber: 2, starch: 2 }, fat: { total: 3, saturated: 1, monounsaturated: 1, polyunsaturated: 1, trans: 0 } };
  const b = { calories: 50,  protein: 5,  carbs: { total: 5, sugar: 5, fiber: 0, starch: 0 }, fat: { total: 1, saturated: 0, monounsaturated: 1, polyunsaturated: 0, trans: 0 } };
  const sum = sumNutrients(a, b);
  check('sumNutrients: adds top-level fields', sum.calories === 150 && sum.protein === 15);
  check('sumNutrients: adds nested carbs tree field-by-field', sum.carbs.total === 10 && sum.carbs.sugar === 6);
  check('sumNutrients: null + x returns x unchanged (usable as a reduce seed)', sumNutrients(null, a) === a);
  check('sumNutrients: x + null returns x unchanged', sumNutrients(a, null) === a);

  // A field present on one side and entirely absent on the other (e.g. an
  // ingredient with no vitamin data merged with one that has it) shouldn't
  // drop the side that does have a value.
  const partial = sumNutrients({ calories: 10 }, { calories: 20, protein: 5 });
  check('sumNutrients: a missing leaf on one side treated as 0, not dropped', partial.calories === 30 && partial.protein === 5);
}

console.log('nutrition-model.js — macroCalorieSplit');
{
  // 30g protein, 40g carbs, 10g fat -> 30*4 + 40*4 + 10*9 = 120+160+90 = 370
  const nutrients = { protein: 30, carbs: { total: 40 }, fat: { total: 10 } };
  const split = macroCalorieSplit(nutrients);
  check('macroCalorieSplit: protein/carbs at 4 kcal/g, fat at 9 kcal/g', split.proteinKcal === 120 && split.carbsKcal === 160 && split.fatKcal === 90);
  check('macroCalorieSplit: null input returns all-zero split, not a throw', JSON.stringify(macroCalorieSplit(null)) === JSON.stringify({ proteinKcal: 0, carbsKcal: 0, fatKcal: 0 }));
}

console.log('nutrition-model.js — recipeNutrientsPerServing');
{
  const chicken = createIngredient({
    id: 'seed:chicken-breast-raw',
    perHundredG: { calories: 165, protein: 31, carbs: { total: 0, sugar: 0, fiber: 0, starch: 0 }, fat: { total: 3.6, saturated: 1, monounsaturated: 1.2, polyunsaturated: 0.8, trans: 0 } },
  });
  const rice = createIngredient({
    id: 'seed:white-rice-cooked',
    perHundredG: { calories: 130, protein: 2.7, carbs: { total: 28, sugar: 0, fiber: 0.4, starch: 27 }, fat: { total: 0.3, saturated: 0.1, monounsaturated: 0.1, polyunsaturated: 0.1, trans: 0 } },
  });
  const lookup = (id) => ({ [chicken.id]: chicken, [rice.id]: rice }[id] ?? null);

  // 300g chicken + 200g rice, 2 servings.
  const recipe = createRecipe({
    name: 'Chicken & Rice', servings: 2,
    ingredients: [
      { ingredientId: chicken.id, amountG: 300 },
      { ingredientId: rice.id, amountG: 200 },
    ],
  });

  const perServing = recipeNutrientsPerServing(recipe, lookup);
  // total calories = 165*3 + 130*2 = 495 + 260 = 755; /2 servings = 377.5
  check('recipeNutrientsPerServing: sums scaled ingredients then divides by servings', perServing.calories === 377.5);
  // total protein = 31*3 + 2.7*2 = 93 + 5.4 = 98.4; /2 = 49.2
  check('recipeNutrientsPerServing: protein matches hand-calculated total', Math.abs(perServing.protein - 49.2) < 1e-9);

  const unknownIngredientRecipe = createRecipe({
    name: 'Mystery Bowl', servings: 1,
    ingredients: [ { ingredientId: 'custom:does-not-exist', amountG: 100 }, { ingredientId: rice.id, amountG: 100 } ],
  });
  const partial = recipeNutrientsPerServing(unknownIngredientRecipe, lookup);
  check('recipeNutrientsPerServing: skips an unresolvable ingredient instead of throwing', partial.calories === 130);

  check('recipeNutrientsPerServing: no servings returns null rather than dividing by zero', recipeNutrientsPerServing(createRecipe({ servings: 0, ingredients: [{ ingredientId: rice.id, amountG: 100 }] }), lookup) === null);
  check('recipeNutrientsPerServing: no resolvable ingredients returns null', recipeNutrientsPerServing(createRecipe({ servings: 1, ingredients: [{ ingredientId: 'custom:nope', amountG: 100 }] }), lookup) === null);
}

console.log('nutrition-model.js — scaleRecipeIngredients');
{
  const chicken = createIngredient({ id: 'seed:chicken-breast-raw' });
  const rice = createIngredient({ id: 'seed:white-rice-cooked' });

  // Authored for 2 servings: 300g chicken + 200g rice.
  const recipe = createRecipe({
    name: 'Chicken & Rice', servings: 2,
    ingredients: [
      { ingredientId: chicken.id, amountG: 300 },
      { ingredientId: rice.id, amountG: 200, sizeOptionId: null },
    ],
  });

  const doubled = scaleRecipeIngredients(recipe, 4);
  check('scaleRecipeIngredients: doubling servings doubles every line\'s amountG', doubled[0].amountG === 600 && doubled[1].amountG === 400);
  check('scaleRecipeIngredients: ingredientId/sizeOptionId pass through unchanged', doubled[0].ingredientId === chicken.id && doubled[1].sizeOptionId === null);
  check('scaleRecipeIngredients: original recipe.ingredients is untouched (no in-place mutation)', recipe.ingredients[0].amountG === 300);

  const half = scaleRecipeIngredients(recipe, 1);
  check('scaleRecipeIngredients: half the authored servings halves every line', half[0].amountG === 150 && half[1].amountG === 100);

  const same = scaleRecipeIngredients(recipe, 2);
  check('scaleRecipeIngredients: scaling to the recipe\'s own servings is a no-op copy', same[0].amountG === 300 && same[1].amountG === 200);

  check('scaleRecipeIngredients: missing/zero target falls back to the recipe\'s own servings rather than guessing', scaleRecipeIngredients(recipe, null)[0].amountG === 300 && scaleRecipeIngredients(recipe, 0)[0].amountG === 300);
  check('scaleRecipeIngredients: a recipe with no servings set returns its lines unscaled rather than dividing by zero', scaleRecipeIngredients(createRecipe({ servings: 0, ingredients: [{ ingredientId: rice.id, amountG: 100 }] }), 4)[0].amountG === 100);
}

console.log('nutrition-model.js — gramsForSizeOption');
{
  const onion = createIngredient({
    name: 'Onion, Raw',
    sizeOptions: [
      { id: 'small',  label: 'Small',  grams: 70 },
      { id: 'medium', label: 'Medium', grams: 110 },
      { id: 'large',  label: 'Large',  grams: 150 },
    ],
  });

  check('gramsForSizeOption: 1 x Medium resolves to that option\'s own gram figure', gramsForSizeOption(onion, 'medium', 1) === 110);
  check('gramsForSizeOption: count multiplies the option\'s grams ("2 x Medium")', gramsForSizeOption(onion, 'medium', 2) === 220);
  check('gramsForSizeOption: a fractional count is honored, not rounded', gramsForSizeOption(onion, 'small', 1.5) === 105);
  check('gramsForSizeOption: unknown optionId returns null rather than guessing', gramsForSizeOption(onion, 'jumbo', 1) === null);
  check('gramsForSizeOption: null count returns null', gramsForSizeOption(onion, 'medium', null) === null);
  check('gramsForSizeOption: zero/negative count returns null (never a Log button enabled at 0)', gramsForSizeOption(onion, 'medium', 0) === null && gramsForSizeOption(onion, 'medium', -1) === null);
  check('gramsForSizeOption: an ingredient with no sizeOptions at all returns null', gramsForSizeOption(createIngredient({ name: 'Rice' }), 'medium', 1) === null);
}

console.log('nutrition-model.js — perHundredGFromLabel');
{
  // Cinnamon Chex-style panel: "3/4 cup (30g)" serving, 120 cal, 1g fat,
  // 26g carb, 1g fiber, 9g sugar, 1g protein, 160mg sodium.
  const perLabelServing = {
    ...createEmptyNutrients(),
    calories: 120, protein: 1,
    carbs: { total: 26, sugar: 9, fiber: 1, starch: 0 },
    fat: { total: 1, saturated: 0, monounsaturated: 0, polyunsaturated: 0, trans: 0 },
    sodiumMg: 160,
  };
  const perHundredG = perHundredGFromLabel(perLabelServing, 30);
  check('perHundredGFromLabel: rescales a 30g-serving label to per-100g (×10/3)', Math.abs(perHundredG.calories - 400) < 1e-9);
  check('perHundredGFromLabel: rescales nested carbs.* leaves the same way', Math.abs(perHundredG.carbs.sugar - 30) < 1e-9);
  check('perHundredGFromLabel: rescales top-level scalar leaves', Math.abs(perHundredG.sodiumMg - 533.333) < 0.01);

  check('perHundredGFromLabel: missing perLabelServing returns null', perHundredGFromLabel(null, 30) === null);
  check('perHundredGFromLabel: missing/zero labelServingSizeG returns null rather than dividing by zero', perHundredGFromLabel(perLabelServing, null) === null && perHundredGFromLabel(perLabelServing, 0) === null);

  const chex = createIngredient({
    name: 'Cinnamon Chex', brand: 'General Mills',
    perLabelServing, labelServingSizeG: 30, labelServingsPerContainer: 12,
    perHundredG,
  });
  check('createIngredient: label fields carry through when provided', chex.brand === 'General Mills' && chex.labelServingSizeG === 30 && chex.labelServingsPerContainer === 12);
  check('createIngredient: label fields default to null for every other ingredient', createIngredient({ name: 'Rice' }).perLabelServing === null);
}

console.log(failures === 0 ? '\nAll nutrition smoke tests passed.' : `\n${failures} nutrition smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
