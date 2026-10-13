// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/daily-values.js
 *
 * The single canonical registry of every micro/macro nutrient this app
 * tracks below the three headline macros (protein/carbs/fat stay
 * core/nutrition-model.js#macroCalorieSplit()'s job) — one entry per
 * NutrientProfile leaf, each carrying its own label/unit/get() accessor
 * plus, where one is actually established, a Daily Value. This is what
 * lets charts/macro-pie.js's "Advanced nutrition info" panel show a %DV
 * next to each row instead of a bare amount, and what views/diet.js's
 * "Today's focus" overview / Log-food smart filter read to decide which
 * nutrients a rider is short on and which they're close to a limit on —
 * one shared source of truth rather than three files independently
 * guessing at the same numbers.
 *
 * Daily Values below are the current FDA Nutrition Facts label reference
 * intakes (21 CFR 101.9, 2016 update) — the same publicly-published
 * figures printed on every packaged food's label, the same kind of
 * public-domain reference DIET_PANEL_DESIGN.md §4 already credits USDA
 * FoodData Central for on the ingredient side. Three adjustments layer on
 * top of the flat table when a rider's profile has real data to support
 * them — deliberately narrow, well-established ones, not a full
 * personalized-RDA engine this app has no business guessing at (same
 * never-guess-a-number-it-doesn't-have-data-for rule
 * metrics/nutrition.js's estimateBmr() already follows):
 *
 *   - Nutrients the FDA itself defines as a fixed *percentage of calorie
 *     intake* (total carbohydrate, fiber, total fat, saturated fat) scale
 *     by targetKcal/2000 once metrics/nutrition.js's
 *     dailyCalorieBalance() has a real budgetKcal for today (BMR +
 *     today's exercise) — the same math the label's own "your daily
 *     value may be higher or lower depending on your calorie needs"
 *     footnote describes, just computed instead of left for the rider to
 *     do by hand.
 *   - Protein uses 0.8 g per kg body weight (the NASEM RDA) once
 *     profile.riderWeight is on file, instead of the flat label's 50 g —
 *     itself just that same formula rounded for a hypothetical
 *     2,000 kcal/68 kg adult.
 *   - Iron uses the one sex-specific RDA gap large enough to matter here
 *     (18 mg/day for menstruating women vs. 8 mg/day otherwise) once
 *     profile.sex is on file.
 *
 * Everything else uses the flat FDA value regardless of profile
 * completeness — real age/sex/life-stage RDA tables exist for those too,
 * but encoding all of them (and keeping them current as the DRI tables
 * themselves get revised) is a separately-scoped effort; the FDA label
 * value is a legitimate published reference on its own, not a
 * placeholder, so it degrades to "as accurate as the label on a cereal
 * box" rather than to nothing.
 *
 * A handful of tracked leaves have no dv at all (monounsaturated/
 * polyunsaturated/trans fat, total sugars, starch) — same as a real
 * Nutrition Facts label, which prints trans fat and total sugars with no
 * %DV column at all (added sugars has one; this app doesn't track added
 * vs. naturally-occurring sugar separately, so it can't show that one
 * honestly) and doesn't list starch as its own line at all.
 *
 * Usage:
 *   import { NUTRIENT_REFERENCE, dailyValueFor, nutrientStatusList,
 *            focusNutrients, watchNutrients, rankIngredientsForFocus,
 *            rankRecipesForFocus, bestFocusMatch }
 *     from './metrics/daily-values.js';
 *
 *   const status = nutrientStatusList(todayTotals, { profile, targetKcal });
 *   const focus  = focusNutrients(status);   // furthest below 100% DV — "get more of"
 *   const watch  = watchNutrients(status);   // closest to/over 100% DV on a limit nutrient
 *   const picks  = rankIngredientsForFocus(searchHits, status); // best-fit first, over-limit ones dropped
 *   const recipePicks = rankRecipesForFocus(recipeHits, status); // same, scored off one serving instead of 100g
 */

// ─── Reference table ────────────────────────────────────────────────────────
// get() reads off any NutrientProfile-shaped object — a summed daily total
// (core/nutrition-model.js#sumNutrients() output) or a single ingredient's
// perHundredG alike, same "one shape, every consumer" rule the rest of the
// Diet panel already follows. Object order matters a little:
// protein/fiber/potassium ahead of the vitamin/mineral tail is what
// focusNutrients() below falls back to at a 0%-DV three-way tie — the
// state every nutrient starts a fresh, nothing-logged-yet day in — so a
// rider who hasn't eaten anything yet sees generically useful guidance
// rather than whichever object key happens to sort first.
export const NUTRIENT_REFERENCE = {
  protein:     { label: 'Protein',         unit: 'g',   get: n => n?.protein,
                 dv: { baseAmount: 50, bodyWeightGPerKg: 0.8 } },
  fiber:       { label: 'Dietary Fiber',   unit: 'g',   get: n => n?.carbs?.fiber,
                 dv: { baseAmount: 28, scalesWithCalories: true } },
  potassium:   { label: 'Potassium',       unit: 'mg',  get: n => n?.potassiumMg,
                 dv: { baseAmount: 4700 } },

  totalSugars: { label: 'Total Sugars',    unit: 'g',   get: n => n?.carbs?.sugar,          dv: null },
  starch:      { label: 'Starch',          unit: 'g',   get: n => n?.carbs?.starch,         dv: null },
  monoFat:     { label: 'Monounsaturated', unit: 'g',   get: n => n?.fat?.monounsaturated,  dv: null },
  polyFat:     { label: 'Polyunsaturated', unit: 'g',   get: n => n?.fat?.polyunsaturated,  dv: null },
  transFat:    { label: 'Trans',           unit: 'g',   get: n => n?.fat?.trans,            dv: null },

  satFat:      { label: 'Saturated Fat',   unit: 'g',   get: n => n?.fat?.saturated,
                 dv: { baseAmount: 20, scalesWithCalories: true, upperLimit: true } },
  cholesterol: { label: 'Cholesterol',     unit: 'mg',  get: n => n?.cholesterolMg,
                 dv: { baseAmount: 300, upperLimit: true } },
  sodium:      { label: 'Sodium',          unit: 'mg',  get: n => n?.sodiumMg,
                 dv: { baseAmount: 2300, upperLimit: true } },

  vitaminA:    { label: 'Vitamin A',       unit: 'mcg', get: n => n?.vitamins?.aMcg,        dv: { baseAmount: 900 } },
  vitaminC:    { label: 'Vitamin C',       unit: 'mg',  get: n => n?.vitamins?.cMg,         dv: { baseAmount: 90 } },
  vitaminD:    { label: 'Vitamin D',       unit: 'mcg', get: n => n?.vitamins?.dMcg,        dv: { baseAmount: 20 } },
  vitaminE:    { label: 'Vitamin E',       unit: 'mg',  get: n => n?.vitamins?.eMg,         dv: { baseAmount: 15 } },
  vitaminK:    { label: 'Vitamin K',       unit: 'mcg', get: n => n?.vitamins?.kMcg,        dv: { baseAmount: 120 } },
  thiamin:     { label: 'Vitamin B1',      unit: 'mg',  get: n => n?.vitamins?.b1Mg,        dv: { baseAmount: 1.2 } },
  riboflavin:  { label: 'Vitamin B2',      unit: 'mg',  get: n => n?.vitamins?.b2Mg,        dv: { baseAmount: 1.3 } },
  niacin:      { label: 'Vitamin B3',      unit: 'mg',  get: n => n?.vitamins?.b3Mg,        dv: { baseAmount: 16 } },
  vitaminB6:   { label: 'Vitamin B6',      unit: 'mg',  get: n => n?.vitamins?.b6Mg,        dv: { baseAmount: 1.7 } },
  vitaminB12:  { label: 'Vitamin B12',     unit: 'mcg', get: n => n?.vitamins?.b12Mcg,      dv: { baseAmount: 2.4 } },
  folate:      { label: 'Folate',          unit: 'mcg', get: n => n?.vitamins?.folateMcg,   dv: { baseAmount: 400 } },
  calcium:     { label: 'Calcium',         unit: 'mg',  get: n => n?.minerals?.calciumMg,   dv: { baseAmount: 1300 } },
  iron:        { label: 'Iron',            unit: 'mg',  get: n => n?.minerals?.ironMg,
                 dv: { baseAmount: 18, sexValues: { male: 8, female: 18 } } },
  magnesium:   { label: 'Magnesium',       unit: 'mg',  get: n => n?.minerals?.magnesiumMg, dv: { baseAmount: 420 } },
  zinc:        { label: 'Zinc',            unit: 'mg',  get: n => n?.minerals?.zincMg,      dv: { baseAmount: 11 } },
};

// ─── Daily Value math ───────────────────────────────────────────────────────

/**
 * Resolves a nutrient's Daily Value amount for this rider right now —
 * flat FDA figure by default, personalized per the three rules in the
 * file doc comment above wherever profile/targetKcal supports one.
 *
 * @param {string} key  A NUTRIENT_REFERENCE key.
 * @param {Object} [opts]
 * @param {Object|null} [opts.profile]     Live profile object — only riderWeight/sex are read here.
 * @param {number|null} [opts.targetKcal]  metrics/nutrition.js#dailyCalorieBalance()'s budgetKcal, or null.
 * @returns {{amount: number, unit: string, upperLimit: boolean}|null}  null for a key with no established DV.
 */
export function dailyValueFor(key, { profile = null, targetKcal = null } = {}) {
  const ref = NUTRIENT_REFERENCE[key];
  const dv = ref?.dv;
  if (!dv) return null;

  let amount = dv.baseAmount;
  if (dv.bodyWeightGPerKg != null && profile?.riderWeight != null) {
    amount = dv.bodyWeightGPerKg * profile.riderWeight;
  } else if (dv.sexValues && (profile?.sex === 'male' || profile?.sex === 'female')) {
    amount = dv.sexValues[profile.sex];
  } else if (dv.scalesWithCalories && targetKcal != null && targetKcal > 0) {
    amount = dv.baseAmount * (targetKcal / 2000);
  }
  return { amount, unit: ref.unit, upperLimit: !!dv.upperLimit };
}

/**
 * @param {string} key
 * @param {number|null} amount  Amount actually consumed (or per 100g, for an ingredient row).
 * @returns {number|null}  Percent of Daily Value, or null for a key with no established DV.
 */
export function percentDailyValue(key, amount, opts) {
  const dv = dailyValueFor(key, opts);
  if (!dv || !dv.amount) return null;
  return (Math.max(0, amount ?? 0) / dv.amount) * 100;
}

/**
 * Every DV-tracked nutrient's current status for a NutrientProfile total
 * (typically views/diet.js's _todayTotals()) — the one call both
 * charts/macro-pie.js's Advanced nutrition info panel and views/diet.js's
 * focus overview/smart filter build off, so a row's badge and the
 * overview naming that same nutrient always agree.
 *
 * @param {import('../core/nutrition-model.js').NutrientProfile|null} nutrients
 * @param {Object} [opts]  Same shape dailyValueFor() takes.
 * @returns {{key: string, label: string, unit: string, amount: number, dvAmount: number, upperLimit: boolean, pct: number}[]}
 *   Only nutrients with an established DV — skips the six with `dv: null` above.
 */
export function nutrientStatusList(nutrients, opts = {}) {
  return Object.entries(NUTRIENT_REFERENCE)
    .filter(([, ref]) => ref.dv != null)
    .map(([key, ref]) => {
      const amount = ref.get(nutrients) ?? 0;
      const dv = dailyValueFor(key, opts);
      return {
        key, label: ref.label, unit: ref.unit,
        amount, dvAmount: dv.amount, upperLimit: dv.upperLimit,
        pct: percentDailyValue(key, amount, opts),
      };
    });
}

/**
 * The nutrients furthest below 100% DV, excluding anything that's a
 * nutrient-to-limit (getting *more* of sodium/saturated fat/cholesterol
 * is never the goal) — "what to eat more of today", worst-first.
 *
 * @param {ReturnType<typeof nutrientStatusList>} statusList
 * @param {Object} [opts]
 * @param {number} [opts.limit=4]
 */
export function focusNutrients(statusList, { limit = 4 } = {}) {
  return statusList
    .filter(s => !s.upperLimit && s.pct != null && s.pct < 100)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, limit);
}

/**
 * Nutrients-to-limit that are already meaningfully eaten into today —
 * "keep an eye on this", closest-to/over-100%-first. Nothing logged yet
 * means every upperLimit nutrient sits at 0% DV, so this naturally comes
 * back empty rather than needing its own separate empty-state check.
 *
 * @param {ReturnType<typeof nutrientStatusList>} statusList
 * @param {Object} [opts]
 * @param {number} [opts.thresholdPct=60]
 */
export function watchNutrients(statusList, { thresholdPct = 60 } = {}) {
  return statusList
    .filter(s => s.upperLimit && s.pct != null && s.pct >= thresholdPct)
    .sort((a, b) => b.pct - a.pct);
}

/**
 * Re-orders a pool of ingredients (typically the Today quick-add's
 * current search hits) so the ones richest in whatever's currently most
 * deficient (focusNutrients(), weighted by how deficient each one is)
 * sort first, and drops any ingredient that a plain 100g serving of it
 * would, on its own, push a nutrient-to-limit past 100% DV for the day —
 * the "without going over" half of the request this exists for — plus,
 * regardless of what's already logged today, anything whose reference
 * serving alone is already within ABSOLUTE_LIMIT_HEADROOM_PCT of a
 * nutrient-to-limit's full daily amount (a very sodium-dense recipe
 * being the clearest case; see _fitsWithinLimits() below). Both checks
 * read per-100g figures (ingredient.perHundredG is itself a
 * NutrientProfile, same canonical-per-100g shape core/nutrition-model.js
 * documents everywhere else), not the eventual logged amount, which isn't
 * known until after an ingredient is picked — a coarser signal than the
 * exact serving would give, but the same one every other density figure
 * in this database (kcal/100g in the search row itself) already uses.
 *
 * @param {import('../core/nutrition-model.js').Ingredient[]} ingredients
 * @param {ReturnType<typeof nutrientStatusList>} statusList
 * @param {Object} [opts]
 * @param {number} [opts.focusLimit=4]  How many of the top focus nutrients drive the score — same default focusNutrients() itself uses, so the ranking always reflects exactly the nutrients a rider sees named in the focus overview.
 * @returns {import('../core/nutrition-model.js').Ingredient[]}
 */
export function rankIngredientsForFocus(ingredients, statusList, opts = {}) {
  return _rankForFocus(ingredients, ing => ing.perHundredG, statusList, opts);
}

/**
 * Same ranking and "without going over" exclusion rankIngredientsForFocus()
 * applies to a raw ingredient's 100g reference amount, applied instead to
 * one serving of a recipe — Recipe.perServing (core/nutrition-model.js) is
 * already the exact NutrientProfile shape a rider actually logs a recipe
 * by, the same role a 100g figure plays for an ingredient, so it needs no
 * further scaling to stand in for "the amount one Log-food tap adds."
 * Kept as its own exported function rather than a perServing/perHundredG
 * flag on rankIngredientsForFocus() so a caller's own array (ingredients
 * vs. recipes) always lines up with the accessor actually used on it —
 * both funnel through the same private _rankForFocus() below, so a
 * behavior fix to one automatically covers the other.
 *
 * @param {import('../core/nutrition-model.js').Recipe[]} recipes
 * @param {ReturnType<typeof nutrientStatusList>} statusList
 * @param {Object} [opts]
 * @param {number} [opts.focusLimit=4]
 * @returns {import('../core/nutrition-model.js').Recipe[]}
 */
export function rankRecipesForFocus(recipes, statusList, opts = {}) {
  return _rankForFocus(recipes, recipe => recipe.perServing, statusList, opts);
}

function _rankForFocus(items, getProfile, statusList, { focusLimit = 4 } = {}) {
  const focus = focusNutrients(statusList, { limit: focusLimit });
  const limits = statusList.filter(s => s.upperLimit && s.dvAmount);

  return items
    .filter(item => _fitsWithinLimits(getProfile(item), limits))
    .map(item => ({ item, score: _focusScore(getProfile(item), focus) }))
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

/**
 * The single focus nutrient (from the same list rankIngredientsForFocus()/
 * rankRecipesForFocus() score against) a given ingredient or recipe is the
 * best source of, per whichever reference amount the caller passes in
 * (an ingredient's perHundredG, or a recipe's perServing — this function
 * doesn't care which, it just reads a plain NutrientProfile) — purely a
 * "High in Fiber"-style tag for one search-result row, not a ranking
 * signal itself (rankIngredientsForFocus()/rankRecipesForFocus() above
 * weigh every focus nutrient at once, not just the top one, so the two
 * can legitimately disagree on which single nutrient "wins" for a given
 * item).
 *
 * @param {import('../core/nutrition-model.js').NutrientProfile} nutrients
 * @param {ReturnType<typeof focusNutrients>} focus
 * @returns {{label: string, pct: number}|null}  null if this item doesn't meaningfully contribute any focus nutrient.
 */
export function bestFocusMatch(nutrients, focus) {
  let best = null;
  for (const f of focus) {
    const amount = NUTRIENT_REFERENCE[f.key].get(nutrients) ?? 0;
    if (amount <= 0 || !f.dvAmount) continue;
    const pct = (amount / f.dvAmount) * 100;
    if (!best || pct > best.pct) best = { label: f.label, pct };
  }
  return best;
}

// A reference serving's own contribution (100g for an ingredient, one
// serving for a recipe — see getProfile in _rankForFocus() above)
// outweighing whatever headroom is left today (dvAmount - amount already
// logged) is treated as "would go over" — see rankIngredientsForFocus()'s
// doc comment for why 100g is the unit that check uses for an ingredient;
// rankRecipesForFocus() applies the exact same rule to one serving
// instead. amount > 0 guards a nutrient this item doesn't contain at all
// from being wrongly excluded once remaining has already gone negative (a
// rider already over today's sodium limit shouldn't have every
// zero-sodium item disappear from search too).
//
// On top of that remaining-budget check, a reference serving that alone
// already sits within ABSOLUTE_LIMIT_HEADROOM_PCT of the *full* daily
// limit is excluded outright, independent of what's already been logged
// today. Sodium is the clearest case: a recipe carrying, say, 2200mg
// sodium in one serving already accounts for ~96% of a rider's whole
// day's 2300mg limit — worth calling "too high" from the very first
// suggestion on an otherwise still-empty day, not just once the
// remaining-budget check above happens to catch up with it later once
// other food has been logged.
const ABSOLUTE_LIMIT_HEADROOM_PCT = 5;

function _fitsWithinLimits(nutrients, limits) {
  return limits.every(({ key, amount: loggedAmount, dvAmount }) => {
    const amount = NUTRIENT_REFERENCE[key].get(nutrients) ?? 0;
    if (amount <= 0) return true;
    if (dvAmount > 0 && amount >= dvAmount * (1 - ABSOLUTE_LIMIT_HEADROOM_PCT / 100)) return false;
    const remaining = dvAmount - loggedAmount;
    return !(amount > remaining);
  });
}

// Sum of each focus nutrient's %DV for this reference serving, weighted by
// how far short of 100% that nutrient currently is — a nutrient a rider is
// barely short on contributes less to the score than one they're nowhere
// close to, so an item that's a great source of the single worst gap
// outranks one that's a mediocre source of everything.
function _focusScore(nutrients, focus) {
  return focus.reduce((sum, f) => {
    const amount = NUTRIENT_REFERENCE[f.key].get(nutrients) ?? 0;
    const pct = f.dvAmount ? (amount / f.dvAmount) * 100 : 0;
    const deficitWeight = Math.max(0, 100 - f.pct) / 100;
    return sum + pct * deficitWeight;
  }, 0);
}

export default {
  NUTRIENT_REFERENCE,
  dailyValueFor,
  percentDailyValue,
  nutrientStatusList,
  focusNutrients,
  watchNutrients,
  rankIngredientsForFocus,
  rankRecipesForFocus,
  bestFocusMatch,
};
