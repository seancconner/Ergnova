// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * views/diet-log-logic.js
 *
 * What the Diet tab's log sheet (views/diet-log-sheet.js) works out, as pure functions so the rules can
 * be read and tested without a DOM. They are the arithmetic that used to live inside DietPage's inline
 * "quick-add" and "log servings" forms (_resolveAmountG(), _sizeHintText(), _recipeLogHintText(),
 * _addDiaryEntry(), _addRecipeDiaryEntry()), moved here unchanged in behaviour when those forms became a
 * detail sheet.
 *
 * Two kinds of thing get logged:
 *   - an INGREDIENT, by an amount in Weight, Volume (only if it has a density) or Size (only if it has
 *     size options) — resolved to grams, which is what a diary entry stores;
 *   - a RECIPE, by a number of servings — free-typed, so 0.5 or 1.5 are as loggable as 1.
 * Either way the entry snapshots its nutrients at log time (see core/nutrition-model.js's DiaryEntry).
 */

import {
  macroCalorieSplit, scaleNutrients, scaleRecipeNutrients, createDiaryEntry, gramsForSizeOption, MEAL_SLOTS,
} from '../core/nutrition-model.js';
import {
  displayWeightToG, displayVolumeToMl, gToDisplayWeight, smallWeightUnitLabel, VOLUME_UNITS,
} from '../metrics/units.js';

const _round1 = (v) => (v == null ? v : Math.round(v * 10) / 10);

/** The label each meal slot wears on its button (and on a logged entry's row in views/diet.js). */
export const MEAL_SLOT_LABELS = Object.freeze({
  [MEAL_SLOTS.BREAKFAST]: 'Breakfast',
  [MEAL_SLOTS.LUNCH]:     'Lunch',
  [MEAL_SLOTS.DINNER]:    'Dinner',
  [MEAL_SLOTS.SNACK]:     'Snack',
});

/**
 * The form an ingredient opens into. Weight is the one measure that needs a scale to read accurately, so
 * a fresh pick opens into whichever of volume / size the ingredient actually offers and only falls back to
 * weight when it has neither (density is checked first, to match ui/recipe-editor.js's tie-break, though
 * in practice no ingredient sets both). Size opens at a count of 1 — "1 medium onion" is what someone
 * almost always means.
 * @param {Object} ingredient
 * @param {'metric'|'imperial'} units
 * @returns {{ mode:'weight'|'volume'|'size', value:string, volumeUnit:string, sizeOptionId:string|null, mealSlot:string }}
 */
export function initialIngredientForm(ingredient, units) {
  const mode = ingredient.densityGPerMl != null ? 'volume'
    : ingredient.sizeOptions?.length ? 'size'
    : 'weight';
  return {
    mode,
    value: mode === 'size' ? '1' : '',
    volumeUnit: VOLUME_UNITS[units][0],
    sizeOptionId: ingredient.sizeOptions?.[0]?.id ?? null,
    mealSlot: MEAL_SLOTS.SNACK,
  };
}

/** Which amount modes this ingredient offers, in display order. Weight is always one. */
export function amountModes(ingredient) {
  return [
    'weight',
    ...(ingredient.densityGPerMl != null ? ['volume'] : []),
    ...(ingredient.sizeOptions?.length ? ['size'] : []),
  ];
}

/**
 * Switching mode: Size with an empty field fills in "1" (same reasoning as the initial form); anything
 * else keeps what was typed.
 * @returns {{ mode:string, value:string }}
 */
export function switchMode(form, mode) {
  return { mode, value: mode === 'size' && form.value === '' ? '1' : form.value };
}

/**
 * Grams the form currently resolves to, honouring whichever of weight / volume / size is selected — null
 * while the amount is blank or not a positive number, which is what gates the Add button.
 * @param {Object} ingredient
 * @param {{ mode:string, value:string, volumeUnit:string, sizeOptionId:string|null }} form
 * @param {'metric'|'imperial'} units
 * @returns {number|null}
 */
export function resolveAmountG(ingredient, form, units) {
  const raw = Number(form.value);
  if (!ingredient || form.value === '' || !isFinite(raw) || raw <= 0) return null;

  if (form.mode === 'volume' && ingredient.densityGPerMl != null) {
    const ml = displayVolumeToMl(raw, form.volumeUnit);
    return ml != null ? ml * ingredient.densityGPerMl : null;
  }
  if (form.mode === 'size' && ingredient.sizeOptions?.length) {
    return gramsForSizeOption(ingredient, form.sizeOptionId, raw);
  }
  return displayWeightToG(raw, units);
}

/** "≈ 182 g total" under the Size picker, so "2 x Medium" shows its resolved weight. */
export function sizeHintText(grams, units) {
  if (grams == null) return 'Pick a count and size to see the total weight.';
  return `\u2248 ${_round1(gToDisplayWeight(grams, units))} ${smallWeightUnitLabel(units)} total`;
}

/** A servings field's value as a number, or null when it is blank, not a number, or not above zero. */
export function parseServings(value) {
  const raw = Number(value);
  return value === '' || value == null || !isFinite(raw) || raw <= 0 ? null : raw;
}

/** "serving" / "servings" for the unit beside the field: only exactly 1 is singular. */
export function servingsUnitLabel(servings) {
  return servings === 1 ? 'serving' : 'servings';
}

/**
 * The four numbers the sheet previews and the diary will store, from a NutrientProfile — the same
 * rounding the recipe card's chips use (kcal from the macro split; grams from each macro's kcal).
 * @returns {{ kcal:number, protein:number, carbs:number, fat:number }|null}  null with no profile
 */
export function previewMacros(nutrients) {
  if (!nutrients) return null;
  const split = macroCalorieSplit(nutrients);
  return {
    kcal:    Math.round(split.proteinKcal + split.carbsKcal + split.fatKcal),
    protein: Math.round(split.proteinKcal / 4),
    carbs:   Math.round(split.carbsKcal / 4),
    fat:     Math.round(split.fatKcal / 9),
  };
}

/** What logging `grams` of `ingredient` would store, or null while the amount is not valid. */
export function ingredientPreview(ingredient, grams) {
  return grams == null ? null : previewMacros(scaleNutrients(ingredient.perHundredG, grams));
}

/** What logging `servings` of `recipe` would store, or null while the count is not valid. */
export function recipePreview(recipe, servings) {
  return servings == null || recipe.perServing == null ? null : previewMacros(scaleRecipeNutrients(recipe.perServing, servings));
}

/** The reference line under the sheet's title: what one 100 g / one serving of this holds. */
export function referenceLine(kind, item) {
  if (kind === 'recipe') {
    const kcal = previewMacros(item.perServing)?.kcal;
    const bits = ['Recipe'];
    if (item.servings) bits.push(`makes ${item.servings} serving${item.servings === 1 ? '' : 's'}`);
    if (kcal != null) bits.push(`${kcal} kcal per serving`);
    return bits.join(' \u00b7 ');
  }
  const kcal = previewMacros(item.perHundredG)?.kcal;
  return kcal != null ? `Ingredient \u00b7 ${kcal} kcal per 100 g` : 'Ingredient';
}

/**
 * The diary entry for an ingredient: its resolved grams and the nutrients snapshotted at that amount.
 * Same shape DietPage._addDiaryEntry() always wrote — amountG only, servings null.
 */
export function ingredientEntry(ingredient, grams, mealSlot) {
  return createDiaryEntry({
    mealSlot,
    source: { type: 'ingredient', id: ingredient.id, amountG: grams, servings: null },
    nutrients: scaleNutrients(ingredient.perHundredG, grams),
  });
}

/**
 * The diary entry for a recipe: servings only (amountG null) and the nutrients snapshotted at that count.
 * Same shape DietPage._addRecipeDiaryEntry() always wrote, for the rider's own recipes and presets alike.
 */
export function recipeEntry(recipe, servings, mealSlot) {
  return createDiaryEntry({
    mealSlot,
    source: { type: 'recipe', id: recipe.id, amountG: null, servings },
    nutrients: scaleRecipeNutrients(recipe.perServing, servings),
  });
}
