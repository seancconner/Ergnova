// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/views/__diet_log_logic_smoketest__.js
//
// Covers views/diet-log-logic.js — what the Diet tab's log sheet (views/diet-log-sheet.js) works out: the
// form an ingredient opens into, which amount modes it offers, how an amount resolves to grams, the live
// nutrition preview, the sheet's reference line, and the diary entries it writes — plus a few checks that
// views/diet.js is wired to the sheet and no longer carries the inline forms it replaced. Pure logic only;
// the sheet's DOM is checked by hand in a browser.

import { readFileSync } from 'node:fs';
import { MEAL_SLOTS } from '../core/nutrition-model.js';
import { displayVolumeToMl } from '../metrics/units.js';
import {
  MEAL_SLOT_LABELS, initialIngredientForm, amountModes, switchMode, resolveAmountG, sizeHintText,
  parseServings, servingsUnitLabel, previewMacros, ingredientPreview, recipePreview, referenceLine,
  ingredientEntry, recipeEntry,
} from './diet-log-logic.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}
const near = (a, b, eps = 1e-6) => a != null && Math.abs(a - b) < eps;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Per 100 g: 10 g protein + 70 g carbs + 2 g fat = 40 + 280 + 18 = 338 kcal.
const flour = { id: 'flour', name: 'Flour', perHundredG: { protein: 10, carbs: { total: 70 }, fat: { total: 2 } } };
const milk  = { id: 'milk',  name: 'Milk',  densityGPerMl: 1.03, perHundredG: { protein: 3.3, carbs: { total: 4.8 }, fat: { total: 3.6 } } };
const onion = { id: 'onion', name: 'Onion', perHundredG: { protein: 1, carbs: { total: 9 }, fat: { total: 0.1 } },
  sizeOptions: [{ id: 'small', label: 'Small', grams: 70 }, { id: 'medium', label: 'Medium', grams: 110, detail: 'about 2.5 inches across' }] };
const both  = { id: 'oil', name: 'Oil', densityGPerMl: 0.92, perHundredG: { fat: { total: 100 } }, sizeOptions: [{ id: 'tbsp', label: 'Tbsp', grams: 14 }] };
// One serving: 20 g protein + 30 g carbs + 10 g fat = 80 + 120 + 90 = 290 kcal.
const stew = { id: 7, name: 'Stew', servings: 4, perServing: { protein: 20, carbs: { total: 30 }, fat: { total: 10 } } };

console.log('what an ingredient opens into');
let f = initialIngredientForm(flour, 'metric');
check('an ingredient with neither density nor sizes opens into Weight, blank', f.mode === 'weight' && f.value === '', JSON.stringify(f));
check('...with the Snack meal and no size picked', f.mealSlot === MEAL_SLOTS.SNACK && f.sizeOptionId === null);
f = initialIngredientForm(milk, 'metric');
check('a density opens into Volume, in the first metric unit', f.mode === 'volume' && f.volumeUnit === 'ml' && f.value === '', JSON.stringify(f));
check('...and in the first imperial unit when the rider uses imperial', initialIngredientForm(milk, 'imperial').volumeUnit === 'tsp');
f = initialIngredientForm(onion, 'metric');
check('size options open into Size at a count of 1, first option picked', f.mode === 'size' && f.value === '1' && f.sizeOptionId === 'small', JSON.stringify(f));
check('density wins over size options when an ingredient has both', initialIngredientForm(both, 'metric').mode === 'volume');

console.log('\nwhich amount modes are offered');
check('Weight alone for a plain ingredient', same(amountModes(flour), ['weight']));
check('Weight + Volume for a density', same(amountModes(milk), ['weight', 'volume']));
check('Weight + Size for size options', same(amountModes(onion), ['weight', 'size']));
check('all three, in that order, for both', same(amountModes(both), ['weight', 'volume', 'size']));
check('an empty size list offers no Size', same(amountModes({ ...flour, sizeOptions: [] }), ['weight']));

console.log('\nswitching mode');
check('switching into Size with an empty field fills in 1', same(switchMode({ value: '' }, 'size'), { mode: 'size', value: '1' }));
check('switching into Size keeps what was typed', same(switchMode({ value: '3' }, 'size'), { mode: 'size', value: '3' }));
check('switching into Weight leaves an empty field empty', same(switchMode({ value: '' }, 'weight'), { mode: 'weight', value: '' }));

console.log('\nresolving an amount to grams');
check('weight in metric is grams as typed', near(resolveAmountG(flour, { mode: 'weight', value: '150' }, 'metric'), 150));
check('weight in imperial is ounces, converted', near(resolveAmountG(flour, { mode: 'weight', value: '4' }, 'imperial'), 113.398, 0.01));
check('a decimal amount resolves', near(resolveAmountG(flour, { mode: 'weight', value: '0.5' }, 'metric'), 0.5));
for (const [label, value] of [['blank', ''], ['zero', '0'], ['negative', '-5'], ['not a number', 'abc']]) {
  check(`${label} resolves to null`, resolveAmountG(flour, { mode: 'weight', value }, 'metric') === null);
}
check('no ingredient resolves to null', resolveAmountG(null, { mode: 'weight', value: '5' }, 'metric') === null);
check('volume uses the density: 250 ml of milk', near(resolveAmountG(milk, { mode: 'volume', value: '250', volumeUnit: 'ml' }, 'metric'), 250 * 1.03));
const cup = resolveAmountG(milk, { mode: 'volume', value: '1', volumeUnit: 'cup' }, 'imperial');
check('volume in imperial: 1 cup of milk is about 244 g', near(cup, displayVolumeToMl(1, 'cup') * 1.03) && cup > 240 && cup < 248, String(cup));
check('an unknown volume unit resolves to null', resolveAmountG(milk, { mode: 'volume', value: '1', volumeUnit: 'gallon' }, 'imperial') === null);
check('size is count x the option\'s grams: 2 medium onions', near(resolveAmountG(onion, { mode: 'size', value: '2', sizeOptionId: 'medium' }, 'metric'), 220));
check('size takes the fractional count: half a small onion', near(resolveAmountG(onion, { mode: 'size', value: '0.5', sizeOptionId: 'small' }, 'metric'), 35));
check('an unknown size option resolves to null', resolveAmountG(onion, { mode: 'size', value: '1', sizeOptionId: 'huge' }, 'metric') === null);

console.log('\nthe size hint');
check('no amount yet reads as a prompt', sizeHintText(null, 'metric') === 'Pick a count and size to see the total weight.');
check('metric hint reads "≈ 220 g total"', sizeHintText(220, 'metric') === '\u2248 220 g total', sizeHintText(220, 'metric'));
check('imperial hint converts and rounds to one place', sizeHintText(220, 'imperial') === '\u2248 7.8 oz total', sizeHintText(220, 'imperial'));
check('a fractional gram total rounds to one place', sizeHintText(182.04, 'metric') === '\u2248 182 g total', sizeHintText(182.04, 'metric'));

console.log('\nservings');
check('1.5 parses', parseServings('1.5') === 1.5);
check('0.5 parses (half a serving is loggable)', parseServings('0.5') === 0.5);
for (const [label, v] of [['blank', ''], ['null', null], ['zero', '0'], ['negative', '-1'], ['not a number', 'x']]) {
  check(`${label} is not a servings count`, parseServings(v) === null);
}
check('only exactly 1 is singular', servingsUnitLabel(1) === 'serving' && servingsUnitLabel(2) === 'servings' && servingsUnitLabel(0.5) === 'servings' && servingsUnitLabel(1.5) === 'servings');
check('a blank field reads as plural', servingsUnitLabel(null) === 'servings');

console.log('\nthe preview');
check('no profile gives no preview', previewMacros(null) === null);
check('per-100 g flour is 338 kcal, 10 / 70 / 2 g', same(previewMacros(flour.perHundredG), { kcal: 338, protein: 10, carbs: 70, fat: 2 }), JSON.stringify(previewMacros(flour.perHundredG)));
check('each figure is rounded on its own', same(previewMacros(milk.perHundredG), { kcal: 65, protein: 3, carbs: 5, fat: 4 }), JSON.stringify(previewMacros(milk.perHundredG)));
check('...rounded to nearest, not down: x.7 g goes up on every macro', same(previewMacros({ protein: 3.7, carbs: { total: 7.7 }, fat: { total: 2.7 } }), { kcal: 70, protein: 4, carbs: 8, fat: 3 }),
  JSON.stringify(previewMacros({ protein: 3.7, carbs: { total: 7.7 }, fat: { total: 2.7 } })));
check('150 g of flour scales to 507 kcal, 15 / 105 / 3 g', same(ingredientPreview(flour, 150), { kcal: 507, protein: 15, carbs: 105, fat: 3 }), JSON.stringify(ingredientPreview(flour, 150)));
check('an invalid amount gives no ingredient preview', ingredientPreview(flour, null) === null);
check('1.5 servings of stew is 435 kcal, 30 / 45 / 15 g', same(recipePreview(stew, 1.5), { kcal: 435, protein: 30, carbs: 45, fat: 15 }), JSON.stringify(recipePreview(stew, 1.5)));
check('an invalid servings count gives no recipe preview', recipePreview(stew, null) === null);
check('a recipe with nothing in it gives no recipe preview', recipePreview({ ...stew, perServing: null }, 2) === null);

console.log('\nthe reference line');
check('an ingredient: its kcal per 100 g', referenceLine('ingredient', flour) === 'Ingredient \u00b7 338 kcal per 100 g', referenceLine('ingredient', flour));
check('an ingredient with no profile is just "Ingredient"', referenceLine('ingredient', { ...flour, perHundredG: null }) === 'Ingredient');
check('a recipe: how many it makes and its kcal per serving', referenceLine('recipe', stew) === 'Recipe \u00b7 makes 4 servings \u00b7 290 kcal per serving', referenceLine('recipe', stew));
check('"makes 1 serving" is singular', referenceLine('recipe', { ...stew, servings: 1 }).includes('makes 1 serving \u00b7'));
check('a recipe with no serving count leaves that part out', referenceLine('recipe', { ...stew, servings: 0 }) === 'Recipe \u00b7 290 kcal per serving');
check('a recipe with no ingredients leaves the kcal part out', referenceLine('recipe', { ...stew, perServing: null }) === 'Recipe \u00b7 makes 4 servings');

console.log('\nthe diary entries');
const ie = ingredientEntry(flour, 150, MEAL_SLOTS.LUNCH);
check('an ingredient entry is grams only: amountG set, servings null', same(ie.source, { type: 'ingredient', id: 'flour', amountG: 150, servings: null }), JSON.stringify(ie.source));
check('...in the chosen meal, stamped with a log time', ie.mealSlot === 'lunch' && typeof ie.loggedAt === 'number');
check('...with the nutrients snapshotted at that amount', near(ie.nutrients.protein, 15) && near(ie.nutrients.carbs.total, 105) && near(ie.nutrients.fat.total, 3));
check('...as a copy: the ingredient\'s own per-100 g profile is untouched', flour.perHundredG.protein === 10 && flour.perHundredG.carbs.total === 70);
const re = recipeEntry(stew, 1.5, MEAL_SLOTS.DINNER);
check('a recipe entry is servings only: servings set, amountG null', same(re.source, { type: 'recipe', id: 7, amountG: null, servings: 1.5 }), JSON.stringify(re.source));
check('...in the chosen meal, nutrients snapshotted at that many servings', re.mealSlot === 'dinner' && near(re.nutrients.protein, 30) && near(re.nutrients.fat.total, 15));
check('...a copy too: the recipe\'s per-serving profile is untouched', stew.perServing.protein === 20);
check('the preview shows exactly what an ingredient entry stores', same(previewMacros(ie.nutrients), ingredientPreview(flour, 150)));
check('the preview shows exactly what a recipe entry stores', same(previewMacros(re.nutrients), recipePreview(stew, 1.5)));

console.log('\nmeal labels');
check('every meal slot has a label', Object.values(MEAL_SLOTS).every((s) => typeof MEAL_SLOT_LABELS[s] === 'string' && MEAL_SLOT_LABELS[s].length > 0));
check('the labels read Breakfast / Lunch / Dinner / Snack', same(Object.values(MEAL_SLOTS).map((s) => MEAL_SLOT_LABELS[s]), ['Breakfast', 'Lunch', 'Dinner', 'Snack']));
check('the label table is frozen', Object.isFrozen(MEAL_SLOT_LABELS));

console.log('\ndiet.js is wired to the sheet');
const code = readFileSync(new URL('./diet.js', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');   // code only, no comments
check('it imports DietLogSheet and builds one with getUnits and onAdd',
  /import \{ DietLogSheet \}\s+from '\.\/diet-log-sheet\.js'/.test(code) && /new DietLogSheet\(\{[^}]*getUnits[^}]*onAdd/.test(code));
check('a search result, an Ingredients tile and a recipe\'s Log button all open the sheet',
  (code.match(/_logSheet\.openIngredient\(/g) || []).length >= 2 && (code.match(/_logSheet\.openRecipe\(/g) || []).length >= 2);
check('the sheet\'s onAdd writes the entry through _addLoggedEntry()', /_addLoggedEntry\(entry\)/.test(code) && /async _addLoggedEntry\(entry\) \{\s*await db\.saveDiaryEntry\(entry\);/.test(code));
check('MEAL_SLOT_LABELS comes from the logic file, not a second copy', /import \{ MEAL_SLOT_LABELS \}\s+from '\.\/diet-log-logic\.js'/.test(code) && !/const MEAL_SLOT_LABELS/.test(code));
for (const gone of ['diet-quickadd-form', 'diet-quickadd-add', 'diet-recipe-log-add', 'diet-recipe-portions-input', '_selectedIngredient', '_selectedRecipeForLog', '_loggingRecipeId', '_recipeLogPanel', '_quickAddForm']) {
  check(`the inline form's ${gone} is gone`, !code.includes(gone));
}

console.log(failures === 0 ? '\nAll diet log logic checks passed.' : `\n${failures} diet log logic check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
