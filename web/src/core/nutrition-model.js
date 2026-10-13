// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * core/nutrition-model.js
 *
 * Canonical shapes for the Diet panel — the nutrition counterpart to
 * core/cardio-model.js (planned cardio steps) and core/strength-model.js
 * (logged sets/holds). Four plain-object shapes, no class instances, no
 * circular references, same rationale as those two: everything here needs
 * to serialise straight into/out of IndexedDB (storage/db.js's
 * `ingredients`/`recipes`/`diaryEntries`/`bodyMeasurements` stores) and
 * round-trip through the bundled seed JSON (data/nutrition/*.json) without
 * any translation layer.
 *
 * Nutrient amounts are always stored **per 100 g** (or per 100 mL for a
 * liquid entered by volume — see densityGPerMl below) on an Ingredient,
 * and scaled to an actual logged/recipe amount only at the point of use —
 * same canonical-then-convert-at-the-boundary rule metrics/units.js
 * already documents for distance/speed/weight, just applied to food
 * instead of a ride. scaleNutrients() below is that boundary.
 *
 * A DiaryEntry snapshots its resolved NutrientProfile at log time rather
 * than re-resolving it from the ingredient/recipe on every read — same
 * reasoning as storage/db.js's updateSession() doc comment about
 * attaching a result "so it travels with the record": editing a custom
 * ingredient's numbers later, or deleting a recipe, shouldn't silently
 * rewrite what a past day's diary said was eaten.
 *
 * Usage:
 *   import { createIngredient, createRecipe, createDiaryEntry, createBodyMeasurement,
 *            scaleNutrients, sumNutrients, macroCalorieSplit, recipeNutrientsPerServing,
 *            scaleRecipeNutrients, scaleRecipeIngredients, gramsForSizeOption }
 *     from './core/nutrition-model.js';
 *
 *   const scaled = scaleNutrients(chickenBreast.perHundredG, 150); // 150 g logged
 *   const split  = macroCalorieSplit(scaled); // { proteinKcal, carbsKcal, fatKcal }
 *   const grams  = gramsForSizeOption(onion, 'medium', 2); // "2 Medium" onions, in grams
 *   const logged = scaleRecipeNutrients(bolognese.perServing, 1.5); // 1.5 servings logged
 *   const lines  = scaleRecipeIngredients(bolognese, 6); // shopping/cook list for 6 servings
 */

// ─── Constants ──────────────────────────────────────────────────────────────

export const MEAL_SLOTS = Object.freeze({
  BREAKFAST: 'breakfast',
  LUNCH:     'lunch',
  DINNER:    'dinner',
  SNACK:     'snack',
});

export const MEASUREMENT_SOURCES = Object.freeze({
  BLE_SCALE: 'ble-scale',
  MANUAL:    'manual',
});

/** kcal per gram, used by macroCalorieSplit() below — the standard Atwater
 *  factors for the three macros this app tracks by calorie contribution. */
const KCAL_PER_G = Object.freeze({ protein: 4, carbs: 4, fat: 9 });

// ─── ID generator ───────────────────────────────────────────────────────────
// Only Ingredient uses this: Recipe/DiaryEntry/BodyMeasurement live in
// autoIncrement IndexedDB stores and get their id from db.js's own
// req.result on save (see recording/session.js's saveSession()+record.id=id
// pattern) — those three factories deliberately leave `id` unset rather
// than defaulting it to null, since an explicit null on an autoIncrement
// keyPath is a foot-gun (IndexedDB only generates a key when the property
// is *absent*, not when it's present-but-null).
//
// Unlike cardio-model.js's/strength-model.js's nextId() — an in-memory
// monotonic counter, fine there because a WorkoutModel's steps are only
// ever addressed *within* the one model they belong to — a custom
// Ingredient's id has to stay unique for the life of the IndexedDB store,
// across reloads, because diary entries and recipe ingredient lines keep
// referencing it by id long after the page that created it is gone. A
// counter that resets to 1 on every page load would hand out an
// already-used id the moment a second custom ingredient is ever created in
// a fresh session, silently overwriting the first one on save. A random
// UUID (per DIET_PANEL_DESIGN.md §3's `'custom:<uuid>'` shape) has no such
// reset problem.
function nextId() {
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `custom:${uuid}`;
}

// ─── Nutrient profile ───────────────────────────────────────────────────────

/**
 * A fresh, all-zero/null NutrientProfile in the canonical per-100g shape —
 * the default every Ingredient factory call starts from, and a safe base
 * for UI forms (ingredient-editor.js) to bind inputs against.
 * @returns {NutrientProfile}
 */
export function createEmptyNutrients() {
  return {
    calories: 0,
    protein: 0,
    carbs: { total: 0, sugar: 0, fiber: 0, starch: 0 },
    fat:   { total: 0, saturated: 0, monounsaturated: 0, polyunsaturated: 0, trans: 0 },
    sodiumMg: 0, cholesterolMg: 0, potassiumMg: 0,
    vitamins: { aMcg: 0, cMg: 0, dMcg: 0, eMg: 0, kMcg: 0, b1Mg: 0, b2Mg: 0, b3Mg: 0, b6Mg: 0, b12Mcg: 0, folateMcg: 0 },
    minerals: { calciumMg: 0, ironMg: 0, magnesiumMg: 0, zincMg: 0 },
  };
}

/**
 * Scales a NutrientProfile tree by a factor of (grams / 100) — the one
 * place "per 100g" becomes "an actual amount". Walks the nested
 * carbs/fat/vitamins/minerals objects generically rather than hand-listing
 * every field, so adding a new tracked nutrient later never means finding
 * and updating a scaling function too.
 *
 * @param {NutrientProfile|null} perHundredG
 * @param {number|null}          grams
 * @returns {NutrientProfile|null}  null if either input is missing
 */
export function scaleNutrients(perHundredG, grams) {
  if (perHundredG == null || grams == null) return null;
  return _scaleTree(perHundredG, grams / 100);
}

function _scaleTree(node, factor) {
  if (node == null) return null;
  if (typeof node === 'number') return node * factor;
  if (typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = _scaleTree(value, factor);
    return out;
  }
  return node;
}

/**
 * Adds two NutrientProfile-shaped trees together, field by field — used to
 * accumulate a recipe's ingredient lines into a total, and a day's diary
 * entries into a daily total. Either side may be null/absent (an
 * ingredient missing a vitamin field it was never given data for); a
 * missing leaf is treated as 0 on whichever side lacks it, so the sum
 * doesn't silently drop the other side's real value.
 *
 * @param {NutrientProfile|null} a
 * @param {NutrientProfile|null} b
 * @returns {NutrientProfile|null}  null only if both inputs are null
 */
export function sumNutrients(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return _sumTree(a, b);
}

function _sumTree(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return (a ?? 0) + (b ?? 0);
  if (typeof a === 'object' || typeof b === 'object') {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    const out = {};
    for (const key of keys) out[key] = _sumTree(a?.[key], b?.[key]);
    return out;
  }
  return a ?? b ?? null;
}

/**
 * Splits a NutrientProfile's calories into what each macro contributed,
 * via the standard Atwater kcal/g factors (protein 4, carbs 4, fat 9) —
 * this is what feeds the Diet tab's macro pie chart (charts/macro-pie.js)
 * and the tab-bar icon's same three colors.
 *
 * @param {NutrientProfile|null} nutrients
 * @returns {{proteinKcal: number, carbsKcal: number, fatKcal: number}}
 */
export function macroCalorieSplit(nutrients) {
  if (!nutrients) return { proteinKcal: 0, carbsKcal: 0, fatKcal: 0 };
  return {
    proteinKcal: (nutrients.protein ?? 0) * KCAL_PER_G.protein,
    carbsKcal:   (nutrients.carbs?.total ?? 0) * KCAL_PER_G.carbs,
    fatKcal:     (nutrients.fat?.total ?? 0) * KCAL_PER_G.fat,
  };
}

// ─── Ingredient ─────────────────────────────────────────────────────────────

/**
 * Creates a custom Ingredient (id prefixed `custom:`, so lookups never
 * collide with the bundled seed set's `seed:`-prefixed ids even after a
 * future ingredients.json update). Bundled ingredients are authored
 * directly as JSON in this same shape rather than built through this
 * factory — see nutrition/ingredient-repository.js for where the two are
 * merged.
 *
 * @param {Partial<Ingredient>} fields
 * @returns {Ingredient}
 */
export function createIngredient(fields = {}) {
  return {
    id: nextId(),
    name: '',
    brand: null,
    cuisineTags: [],
    /** grams per mL — set for anything a rider would reach for a
     *  measuring cup/spoon rather than a scale to portion: pourable
     *  liquids (oils, milk, sauces...), dry powders (flour, sugar, cocoa,
     *  ground spices...), and spoonable soft solids (peanut butter, cream
     *  cheese...). Presence of this field is what the amount-entry UI
     *  uses to decide whether to offer a weight/volume toggle at all —
     *  see metrics/units.js's volume helpers.
     *
     *  RULE FOR ANY NEW INGREDIENT: every powder, every soft/spoonable
     *  solid, and every liquid — thick/viscous (honey, cream, syrup) or
     *  thin (water, brewed coffee/tea) — should carry a value here. It's
     *  the *only* thing that turns on the tsp/tbsp/fl-oz/cup ladder
     *  (mlToDisplayVolume()/displayVolumeToMl()); a correct nutrient
     *  profile with this left null still can't be measured by spoon or
     *  cup in the UI, only by weight (and, if set, a sizeOptions count).
     *  sizeOptions can still be added alongside it for a named shortcut
     *  ("Tablespoon", "Cup, Packed") — the two aren't mutually exclusive,
     *  see views/diet.js's Weight/Volume/Size toggle — but density is
     *  what makes the general-purpose units work at *any* amount, not
     *  just the one preset size. Leave it null only for things with no
     *  real cup/spoon measure at all: whole cuts of meat, whole produce,
     *  a cooked grain/rice/pasta measured by weight. */
    densityGPerMl: null,
    /** "Common measures" — named preset serving sizes, e.g. Small/Medium/
     *  Large for a whole item (an apple, an onion), a single discrete unit
     *  (a garlic clove, a slice of bread), or a cut preparation measured
     *  by volume (a cup of diced onion, a cup of sliced carrot). Each
     *  entry's `grams` is the weight of ONE of that unit — see
     *  gramsForSizeOption() below, which the amount-entry UI (views/
     *  diet.js) multiplies by a rider-typed count the same way weight/
     *  volume mode multiply a typed number by a unit conversion. Same
     *  "presence of the field decides whether the picker offers this
     *  mode" rule densityGPerMl already uses for weight/volume — null (or
     *  simply omitted; data/nutrition/ingredients.json's bundled seed set
     *  only writes this key on ingredients that actually have it, same
     *  sparse-key convention the rest of that file's per-ingredient
     *  optional data already uses) for the vast majority of ingredients,
     *  especially anything already naturally bought/measured by weight or
     *  volume directly (rice, flour, oils, sauces, spices). Populate only
     *  where the weight is a genuinely well-established reference figure
     *  (USDA FoodData Central's own "common measures" convention, which
     *  is where this app's bundled values come from) — a missing size
     *  option just means the rider falls back to typing grams, which is
     *  always correct; a fabricated one wouldn't be, and this is
     *  health-adjacent data someone is trusting instead of double-
     *  checking themselves (see this app's own reasoning for never
     *  guessing a fitness estimate it doesn't have enough data for, e.g.
     *  metrics/nutrition.js's estimateBmr() returning null rather than a
     *  bad number).
     *  @type {SizeOption[]|null} */
    sizeOptions: null,
    perHundredG: createEmptyNutrients(),
    /** Set only for a branded/packaged product added from its printed
     *  Nutrition Facts panel (a rider's "add a custom ingredient" flow for
     *  something like a specific cereal or protein bar, as opposed to a
     *  generic USDA-sourced ingredient or one entered directly in
     *  per-100g form). When set, perHundredG above is a *derived* figure —
     *  computed via perHundredGFromLabel() below — not an independently
     *  measured one; these three fields are what it was derived from, and
     *  what core/label-rounding.js's boundsForNutrients() reads to show
     *  how much rounding uncertainty that derivation carries. Left null
     *  for every other ingredient, seed or custom, the same "presence of
     *  the field decides whether a UI path is offered at all" rule
     *  densityGPerMl/sizeOptions already use. See DIET_PANEL_DESIGN.md's
     *  "Branded foods" section for the full reasoning. */
    perLabelServing: null,
    /** Grams, per 21 CFR 101.9(b)(7)(ii)'s own rounding of the serving
     *  size itself (nearest whole gram over 5 g) — the divisor
     *  perHundredGFromLabel() rescales perLabelServing by. */
    labelServingSizeG: null,
    /** "About N servings per container," as printed — not used by any
     *  nutrient math (perHundredG/perLabelServing already fully describe
     *  one serving), kept purely so a diary quick-add showing "whole box"
     *  as a quantity shortcut can multiply by the label's own count
     *  instead of a rider re-deriving it from container weight ÷ serving
     *  size themselves. */
    labelServingsPerContainer: null,
    ...fields,
  };
}

/**
 * Resolves a chosen SizeOption + a rider-typed count into grams — the
 * "size" counterpart to metrics/units.js's displayWeightToG()/
 * displayVolumeToMl(), used the same way: views/diet.js's amount-entry
 * calls this instead of those two whenever the rider's picked "Size" mode
 * (only offered when ingredient.sizeOptions is set, same gating
 * densityGPerMl already does for the volume toggle).
 *
 * A SizeOption's `label` is deliberately written without a leading count
 * ("Medium", "Clove", "Cup, Chopped" — never "1 medium" or "2 cloves") so
 * the UI can read naturally as "[count] × [label]" with the count typed
 * separately, the same way weight mode reads as "[amount] [g/oz]" rather
 * than baking a number into the unit string.
 *
 * @param {Ingredient}   ingredient
 * @param {string}       optionId  One of ingredient.sizeOptions[].id.
 * @param {number|null}  count     Rider-typed count, e.g. 2 for "2 medium".
 * @returns {number|null}  grams, or null if the option/count don't resolve
 *   (unknown optionId, count missing/≤0) — same "null propagates, never a
 *   guessed number" rule every other amount-resolver in this app follows.
 */
export function gramsForSizeOption(ingredient, optionId, count) {
  const option = ingredient?.sizeOptions?.find(o => o.id === optionId);
  if (!option || count == null || !isFinite(count) || count <= 0) return null;
  return option.grams * count;
}

/**
 * Converts a manufacturer's declared per-serving NutrientProfile (values
 * exactly as printed on the Nutrition Facts panel) into the canonical
 * per-100g shape every other Ingredient already stores — the "branded
 * product" counterpart to typing an ingredient's numbers directly in
 * per-100g form, which never needs this step at all.
 *
 * This does NOT make the result any more precise than the label itself —
 * it's a unit conversion, not a measurement. A branded Ingredient's
 * perHundredG, unlike a seed ingredient's USDA-sourced one, is only as
 * precise as whatever rounding the label's own declared numbers already
 * carry; see core/label-rounding.js's boundsForNutrients(perLabelServing)
 * for computing how wide that is, and DIET_PANEL_DESIGN.md's "Branded
 * foods" section for where that's meant to surface in the UI.
 *
 * Reuses scaleNutrients()'s per-100 ratio math rather than a second
 * scalar-multiply helper, the same trick recipeNutrientsPerServing() below
 * already documents: scaleNutrients(x, g) computes x * (g / 100), so
 * passing g = 10000 / labelServingSizeG yields x * (100 / labelServingSizeG)
 * — "the declared amount, rescaled from the label's serving size to 100 g."
 *
 * @param {NutrientProfile|null} perLabelServing    Values exactly as printed, at labelServingSizeG.
 * @param {number|null}          labelServingSizeG  The label's declared serving size, in grams.
 * @returns {NutrientProfile|null}  null if either input is missing/zero
 */
export function perHundredGFromLabel(perLabelServing, labelServingSizeG) {
  if (perLabelServing == null || !labelServingSizeG) return null;
  return scaleNutrients(perLabelServing, 10000 / labelServingSizeG);
}

// ─── Recipe ─────────────────────────────────────────────────────────────────

/**
 * Creates a Recipe. `id` is deliberately left unset — recipes live in an
 * autoIncrement IndexedDB store and get their id from db.saveRecipe()'s
 * return value, same pattern recording/session.js uses for session records.
 *
 * @param {Partial<Recipe>} fields
 * @returns {Recipe}
 */
export function createRecipe(fields = {}) {
  return {
    name: '',
    cuisine: null,
    servings: 1,
    /** id of the seed-recipe.json entry this was cloned from, if any —
     *  purely a "based on ___" credit line; never re-read from the
     *  preset after cloning, so editing a saved recipe never mutates
     *  (and can't, since it's static JSON) the shared preset. */
    sourcePresetId: null,
    /** @type {{ingredientId: string, amountG: number, sizeOptionId?: string}[]} */
    ingredients: [],
    /** Cached NutrientProfile per serving — recomputed via
     *  recipeNutrientsPerServing() on every save so recipe-list/pie-chart
     *  reads never have to re-walk every ingredient line. */
    perServing: null,
    /** @type {string[]} Ordered plain-text cooking instructions, one entry
     *  per step — the print sheet's (ui/recipe-print.js) numbered method,
     *  and the only piece of a Recipe that isn't itself nutrition data.
     *  Optional: an empty array is a valid recipe (ingredients/macros still
     *  work for logging), it just has nothing to print under "Method". */
    steps: [],
    ...fields,
  };
}

/**
 * Resolves a Recipe's ingredient lines into a per-serving NutrientProfile.
 * Unknown ingredients (e.g. a custom ingredient the lookup can no longer
 * find, because it was deleted after this recipe referenced it) are
 * skipped rather than throwing — same degrade-gracefully-on-missing-data
 * approach metrics/units.js's formatDistance() takes for a null input,
 * just returning a partial total instead of a '—' string.
 *
 * @param {Recipe}                          recipe
 * @param {(id: string) => Ingredient|null} ingredientLookupFn
 * @returns {NutrientProfile|null}  null if the recipe has no resolvable ingredients
 */
export function recipeNutrientsPerServing(recipe, ingredientLookupFn) {
  if (!recipe?.servings) return null;

  const total = (recipe.ingredients ?? []).reduce((acc, line) => {
    const ingredient = ingredientLookupFn(line.ingredientId);
    if (!ingredient) return acc;
    return sumNutrients(acc, scaleNutrients(ingredient.perHundredG, line.amountG));
  }, null);

  if (!total) return null;

  // Reuse scaleNutrients()'s per-100 ratio math to divide by servings
  // rather than adding a second scalar-multiply helper: scaleNutrients(x, g)
  // computes x * (g / 100), so passing g = 100/servings yields x * (1/servings).
  return scaleNutrients(total, 100 / recipe.servings);
}

/**
 * Scales a Recipe's per-serving NutrientProfile to a rider-typed number of
 * servings logged to the diary — the "portions of a recipe" counterpart to
 * scaleNutrients()'s "grams of an ingredient". `portions` needn't be a
 * whole number (0.5 for half a serving, 1.5 for a serving and a half,
 * etc.) — this is what lets a recipe be logged at any portion, not just
 * whole multiples of its own `servings` count.
 *
 * Reuses the same per-100 ratio trick recipeNutrientsPerServing() already
 * documents above: scaleNutrients(x, g) computes x * (g / 100), so passing
 * g = portions * 100 yields x * portions, rather than adding a second
 * scalar-multiply helper.
 *
 * @param {NutrientProfile|null} perServing  A Recipe's precomputed `perServing`.
 * @param {number|null}          portions    Servings logged, e.g. 0.5, 1, 2.
 * @returns {NutrientProfile|null}  null if either input is missing
 */
export function scaleRecipeNutrients(perServing, portions) {
  if (perServing == null || portions == null) return null;
  return scaleNutrients(perServing, portions * 100);
}

/**
 * Scales a Recipe's own ingredient lines (its authored `servings` count) to
 * however many servings someone actually wants to cook — the "shopping/cook
 * list" counterpart to scaleRecipeNutrients()'s "how many kcal did I eat".
 * This is the one place that math lives, so a recipe printed for 6 servings
 * (ui/recipe-print.js) and a recipe logged at 1.5 servings
 * (scaleRecipeNutrients()) always agree on what "N servings" means for that
 * recipe, and any other future consumer (a shopping-list export, say) gets
 * the same numbers without re-deriving the ratio itself.
 *
 * Ingredient identity/sizeOptionId pass through unchanged; only amountG is
 * scaled. Line order is preserved so a printed ingredient list still reads
 * top-to-bottom the way the recipe was authored.
 *
 * @param {Recipe}        recipe
 * @param {number|null}   servings  Target serving count to scale to, e.g. 2,
 *   4, 6.5. Falls back to `recipe.servings` (i.e. an unscaled 1:1 copy) for a
 *   missing/non-positive value, same "don't guess, return the safe default"
 *   rule scaleRecipeNutrients() takes on missing input, just with a default
 *   instead of null since a print sheet always needs *some* list to show.
 * @returns {{ingredientId: string, amountG: number, sizeOptionId?: string}[]}
 */
export function scaleRecipeIngredients(recipe, servings) {
  const lines = recipe?.ingredients ?? [];
  if (!recipe?.servings) return lines;
  const target = servings != null && isFinite(servings) && servings > 0 ? servings : recipe.servings;
  const factor = target / recipe.servings;
  return lines.map(line => ({ ...line, amountG: line.amountG * factor }));
}

// ─── Diary entry ────────────────────────────────────────────────────────────

/**
 * Creates a DiaryEntry — one logged food item. `id` left unset, same
 * autoIncrement reasoning as createRecipe() above.
 *
 * @param {Partial<DiaryEntry>} fields
 * @returns {DiaryEntry}
 */
export function createDiaryEntry(fields = {}) {
  return {
    loggedAt: Date.now(),
    mealSlot: MEAL_SLOTS.SNACK,
    /** @type {{type: 'ingredient'|'recipe', id: string, amountG: number|null, servings: number|null}|null} */
    source: null,
    /** Snapshot NutrientProfile at log time — see the module doc comment
     *  above for why this isn't resolved live from source on every read. */
    nutrients: null,
    ...fields,
  };
}

// ─── Body measurement ───────────────────────────────────────────────────────

/**
 * Derives lean body mass from a weight + body-fat % pair — the
 * `riderWeight × (1 − bodyFat%/100)` relationship DIET_PANEL_DESIGN.md §6
 * describes. Factored out so app.js's manual Rider Profile entry and a BLE
 * scale sync compute it identically instead of each inlining the same
 * formula — neither BLE path reports `leanBodyMassKg` directly, only
 * `bodyFatPct`: ble/scale-device.js's `_parseBodyComposition()` for the
 * standard-GATT path, and ble/fitdays-device.js's composition-record
 * correlation (metrics/body-composition.js#estimateBodyComposition()) for
 * the Fitdays path.
 *
 * @param {number|null} weightKg
 * @param {number|null} bodyFatPct
 * @returns {number|null} null unless both inputs are present
 */
export function deriveLeanBodyMassKg(weightKg, bodyFatPct) {
  if (weightKg == null || bodyFatPct == null) return null;
  return weightKg * (1 - bodyFatPct / 100);
}

/**
 * Creates a BodyMeasurement — one weigh-in, from a BLE scale or entered by
 * hand. `id` left unset, same autoIncrement reasoning as createRecipe().
 *
 * The five fields below `leanBodyMassKg` have mixed provenance depending on
 * source:
 *   - muscleMassKg/bodyWaterKg: reported by the standard-GATT path
 *     (ble/scale-device.js's Body Composition parse) when the connected
 *     scale supports it, *and* by the Fitdays path
 *     (ble/fitdays-device.js/metrics/body-composition.js) as an estimate,
 *     but only on a reading where the rider held the electrode handle with
 *     bare feet on the plate — a Fitdays weight-only weigh-in leaves them
 *     null, same as a standard-GATT scale that doesn't support composition.
 *   - boneMassKg: same Fitdays-estimate condition as above; never reported
 *     by the standard-GATT path (not part of that GATT characteristic).
 *   - basalMetabolicRateKcal: standard-GATT's own characteristic field when
 *     supported, *or* the Fitdays composition estimate's Katch-McArdle step
 *     (metrics/body-composition.js, which calls the same
 *     metrics/nutrition.js#estimateBmr() this app uses everywhere else, so
 *     there's one BMR formula rather than two that could disagree) — same
 *     handle-contact condition as muscleMassKg/bodyWaterKg above.
 *   - visceralFatRating: standard-GATT never reports it (not part of that
 *     characteristic) — the Fitdays path estimates it (a from-fat-mass
 *     regression, wider error bars than the other estimated fields; see
 *     body-composition.js's LIMITATIONS section), same handle-contact
 *     condition as above. Manual entry still covers it for anyone whose
 *     number comes from elsewhere (a DEXA scan, an in-clinic BIA reading,
 *     a different scale's app) or a scale/session that leaves it null.
 * A row built from any BLE reading simply leaves whichever of these its
 * source didn't provide null, same as bodyFatPct/leanBodyMassKg already do
 * for a weight-only reading.
 *
 * @param {Partial<BodyMeasurement>} fields
 * @returns {BodyMeasurement}
 */
export function createBodyMeasurement(fields = {}) {
  return {
    measuredAt: Date.now(),
    source: MEASUREMENT_SOURCES.MANUAL,
    weightKg: null,
    /** Set only when the scale/entry actually provides body composition —
     *  a weight-only reading leaves both of these null, which is what
     *  metrics/nutrition.js's estimateBmr() checks to decide whether it
     *  can use Katch-McArdle or has to fall back to Mifflin-St Jeor. */
    bodyFatPct: null,
    leanBodyMassKg: null,
    /** See doc comment above for which source(s) can populate each of
     *  these. Not read by any formula in metrics/nutrition.js today except
     *  basalMetabolicRateKcal (see estimateBmr()'s direct-report tier,
     *  still unwired — that file's own comment explains why); the rest are
     *  stored purely so a rider who has them can keep them alongside
     *  weight/body-fat% history instead of nowhere. */
    muscleMassKg: null,
    boneMassKg: null,
    bodyWaterKg: null,
    /** Unitless index (typically ~1-59) — the same "visceral fat grade/
     *  rating" scale most consumer BIA scales and DEXA reports print. */
    visceralFatRating: null,
    basalMetabolicRateKcal: null,
    ...fields,
  };
}

export default {
  MEAL_SLOTS,
  MEASUREMENT_SOURCES,
  createEmptyNutrients,
  scaleNutrients,
  sumNutrients,
  macroCalorieSplit,
  createIngredient,
  gramsForSizeOption,
  perHundredGFromLabel,
  createRecipe,
  recipeNutrientsPerServing,
  createDiaryEntry,
  createBodyMeasurement,
  deriveLeanBodyMassKg,
};

/**
 * @typedef {Object} NutrientProfile
 * @property {number} calories
 * @property {number} protein
 * @property {{total: number, sugar: number, fiber: number, starch: number}} carbs
 * @property {{total: number, saturated: number, monounsaturated: number, polyunsaturated: number, trans: number}} fat
 * @property {number} sodiumMg
 * @property {number} cholesterolMg
 * @property {number} potassiumMg
 * @property {{aMcg: number, cMg: number, dMcg: number, eMg: number, kMcg: number, b1Mg: number, b2Mg: number, b3Mg: number, b6Mg: number, b12Mcg: number, folateMcg: number}} vitamins
 * @property {{calciumMg: number, ironMg: number, magnesiumMg: number, zincMg: number}} minerals
 *
 * @typedef {Object} Ingredient
 * @property {string}              id             'seed:<slug>' (bundled) or 'custom:<n>' (user-created)
 * @property {string}              name
 * @property {string|null}         brand
 * @property {string[]}            cuisineTags
 * @property {number|null}         densityGPerMl
 * @property {SizeOption[]|null}   [sizeOptions]   see createIngredient()'s doc comment
 * @property {NutrientProfile}     perHundredG
 * @property {NutrientProfile|null} [perLabelServing]        set only for a branded/packaged product — see createIngredient()'s doc comment and perHundredGFromLabel()
 * @property {number|null}         [labelServingSizeG]       grams; the divisor perHundredGFromLabel() rescales perLabelServing by
 * @property {number|null}         [labelServingsPerContainer]  display-only, see createIngredient()'s doc comment
 *
 * @typedef {Object} SizeOption
 * @property {string} id      Stable within one ingredient's list — the amount-entry UI's <select> value.
 * @property {string} label   e.g. 'Medium', 'Clove', 'Cup, Chopped', 'Slice' — see gramsForSizeOption()'s doc comment for the "no leading count" convention.
 * @property {number} grams   Weight of ONE of this unit — gramsForSizeOption() multiplies by the rider-typed count.
 * @property {string} [detail]  Optional cut/prep note for an option that isn't self-evident from the
 *   label alone — e.g. Cup, Chopped's "roughly ½-inch pieces", Cup, Shredded's "shredded, lightly
 *   packed", a wedge's "⅛ wedge, for juicing or serving". Shown as a hover tooltip on the size picker
 *   (ui/recipe-editor.js's <select title>, views/diet.js's Size-mode hint) rather than inline, so a
 *   whole/piece option that needs no cut explanation (a clove, a slice, a whole lemon) can simply omit
 *   it. Purely descriptive — never read by gramsForSizeOption() or any nutrient math, only by the UI.
 *
 * @typedef {Object} Recipe
 * @property {number}              [id]            assigned by db.saveRecipe()
 * @property {string}              name
 * @property {string|null}         cuisine
 * @property {number}              servings
 * @property {string|null}         sourcePresetId
 * @property {{ingredientId: string, amountG: number, sizeOptionId?: string, unitMode?: 'weight'|'volume'|'size', volumeUnit?: string}[]} ingredients
 *   sizeOptionId is optional and purely a display preference: which of ingredient.sizeOptions a line
 *   should default to showing (e.g. a caprese salad's tomato wants "Medium" while most other recipes'
 *   tomato line lands on "Small") — see ui/recipe-editor.js's _rowDisplay(). amountG alone doesn't
 *   determine this (two different options can multiply out to the same gram figure), so a line that
 *   cares which one it reads as records it explicitly instead of leaving it to whichever option
 *   happens to be first in the ingredient's list. Absent/stale (naming an option the ingredient no
 *   longer has) just falls back to that same first-option default — never a hard error.
 *   unitMode/volumeUnit are the same kind of display preference, one level up: which of
 *   Weight/Volume/Size a line reads as at all (unitMode), and, when that's Volume, which specific
 *   cooking-measure unit (volumeUnit, one of metrics/units.js's VOLUME_UNITS for the rider's current
 *   metric/imperial setting) rather than whichever one mlToDisplayVolume()'s largest-unit-it-reaches
 *   rule would auto-pick. Both are optional and only ever set once a rider manually toggles a row
 *   (ui/recipe-editor.js's per-row Weight/Volume/Size control) — absent, or naming a mode/unit the
 *   ingredient no longer supports (e.g. an ingredient swapped out from under a saved line), falls back
 *   to the same density-then-sizeOptions-then-weight auto-pick this app used before the toggle existed.
 * @property {NutrientProfile|null} perServing
 *
 * @typedef {Object} DiaryEntry
 * @property {number}              [id]            assigned by db.saveDiaryEntry()
 * @property {number}              loggedAt        Unix ms
 * @property {'breakfast'|'lunch'|'dinner'|'snack'} mealSlot
 * @property {{type: 'ingredient'|'recipe', id: string, amountG: number|null, servings: number|null}|null} source
 * @property {NutrientProfile|null} nutrients
 *
 * @typedef {Object} BodyMeasurement
 * @property {number}              [id]            assigned by db.saveBodyMeasurement()
 * @property {number}              measuredAt      Unix ms
 * @property {'ble-scale'|'manual'} source
 * @property {number|null}         weightKg
 * @property {number|null}         bodyFatPct
 * @property {number|null}         leanBodyMassKg
 * @property {number|null}         muscleMassKg          Standard-GATT, Fitdays-estimated (handle held), or manual — see createBodyMeasurement()'s doc comment.
 * @property {number|null}         boneMassKg            Fitdays-estimated (handle held) or manual — never standard-GATT.
 * @property {number|null}         bodyWaterKg           Standard-GATT, Fitdays-estimated (handle held), or manual.
 * @property {number|null}         visceralFatRating     Manual-entry only — unitless index.
 * @property {number|null}         basalMetabolicRateKcal Standard-GATT or manual only (never Fitdays). Not yet read by estimateBmr() (metrics/nutrition.js)
 *   — a rider with a lab-measured BMR can log it here, but a direct-report
 *   tier ahead of Katch-McArdle/Mifflin-St Jeor is still unwired; see that
 *   file and app.js's `profile.basalMetabolicRateKcal` doc comment.
 */
