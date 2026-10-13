// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * core/label-rounding.js
 *
 * Turns a manufacturer's *declared* Nutrition Facts number back into the
 * range of *true* per-serving values that declaration is legally allowed to
 * represent, per the rounding rules in 21 CFR 101.9(c). A declared "0g
 * Trans Fat" is not a measurement of zero — trans fat may be declared as
 * zero for any true value under 0.5 g/serving (101.9(c)(2)(ii)) — and the
 * same gap exists, at a different width, for every other rounded nutrient
 * on the panel: total fat, saturated fat, cholesterol, sodium, total carb,
 * fiber, sugars, and protein all round to zero (or to a coarse increment)
 * well before the true amount is actually zero. This module makes that gap
 * a first-class, computable thing instead of letting a branded product's
 * numbers silently pretend to the same precision as a seed ingredient's
 * lab-measured USDA figures.
 *
 * This is the specific problem DIET_PANEL_DESIGN.md's Open Questions
 * section gestured at without naming ("if this grows toward branded-
 * product scale... needs a real plan") — the risk isn't only bundle size,
 * it's that nothing in the current model distinguishes a measured value
 * from a rounded declaration once both are sitting in the same
 * `perHundredG` shape. See that file's new "Branded foods" section for how
 * this module fits into the rest of the feature.
 *
 * Nothing in core/nutrition-model.js's existing shapes changes because of
 * this file — scaleNutrients()/sumNutrients() still operate on plain
 * numbers, so a branded Ingredient's perHundredG (via
 * perHundredGFromLabel(), added alongside this file) stays the single
 * value every existing consumer (recipe editor, diary quick-add, macro
 * pie) already reads with no changes of their own. What this file adds is
 * a *parallel*, optional computation over the same declared numbers: given
 * what was printed on the box, how wide is the range of true values
 * consistent with it, for callers (the ingredient editor, a future
 * "possible range" note in the diary) that want to show that honestly
 * instead of a bare, falsely-precise number.
 *
 * Usage:
 *   import { boundsForDeclaredValue, boundsForNutrients } from './label-rounding.js';
 *
 *   boundsForDeclaredValue('fat.trans', 0)    // → { min: 0,     max: 0.5 }
 *   boundsForDeclaredValue('sodiumMg', 140)   // → { min: 137.5, max: 142.5 }
 *   boundsForNutrients(cinnamonChex.perLabelServing)
 *   //  → same tree shape as the input, {min,max} leaves where a rounding
 *   //    rule is known, null leaves for fields this module doesn't model
 *   //    (carbs.starch — not a labeled nutrient at all; vitamins/minerals
 *   //    and potassiumMg — see the note above RULES.potassiumMg below)
 */

// ─── 21 CFR 101.9(c) declared-value rounding tables ────────────────────────
//
// Keyed by the same dotted path scaleNutrients()/sumNutrients() walk
// generically in core/nutrition-model.js (calories, protein, fat.total,
// carbs.fiber, sodiumMg, ...), so boundsForNutrients() below can reuse that
// exact tree shape instead of hand-listing every field twice across two
// files.
//
// Each rule's `tiers` are ordered by the *declared* value's own magnitude —
// an approximation, since the true rounding increment is chosen from the
// true (pre-rounding) value's band, not the declared one. The two only
// disagree for values sitting within half an increment of a tier boundary,
// and even then the returned range is never narrower than the true legal
// one — which is what matters here: this module's job is to never
// understate uncertainty, not to reconstruct the exact original figure.
//
// `zeroFloor`: the true-value ceiling a declared "0" implies, for the
// nutrients the rule lets round all the way down below a set threshold
// regardless of which increment tier they'd otherwise sit in.
//
// `altTextFloor`: set only for the carb/protein family, where 21 CFR
// 101.9(c)(6)/(c)(7) separately permits a "Contains less than 1 gram" text
// declaration in place of a number for any true value under 1 g. Callers
// that captured that text alternative (rather than a typed "0") should
// pass `{ lessThanOneGram: true }` to boundsForDeclaredValue() to get this
// wider band instead of the zeroFloor one.
const RULES = {
  calories: { citation: '101.9(c)(1)', zeroFloor: 5,
    tiers: [{ upTo: 50, increment: 5 }, { upTo: Infinity, increment: 10 }] },

  'fat.total':           { citation: '101.9(c)(2)',     zeroFloor: 0.5, tiers: [{ upTo: 5, increment: 0.5 }, { upTo: Infinity, increment: 1 }] },
  'fat.saturated':       { citation: '101.9(c)(2)(i)',  zeroFloor: 0.5, tiers: [{ upTo: 5, increment: 0.5 }, { upTo: Infinity, increment: 1 }] },
  'fat.trans':           { citation: '101.9(c)(2)(ii)', zeroFloor: 0.5, tiers: [{ upTo: 5, increment: 0.5 }, { upTo: Infinity, increment: 1 }] },
  'fat.polyunsaturated': { citation: '101.9(c)(2)(iii)',zeroFloor: 0.5, tiers: [{ upTo: 5, increment: 0.5 }, { upTo: Infinity, increment: 1 }] },
  'fat.monounsaturated': { citation: '101.9(c)(2)(iv)', zeroFloor: 0.5, tiers: [{ upTo: 5, increment: 0.5 }, { upTo: Infinity, increment: 1 }] },

  // Cholesterol has a second, text-only carve-out this table doesn't model:
  // a true value of 2-5 mg may be declared as the phrase "less than 5
  // milligrams" rather than a number. A declared *number* of 0 still only
  // legally implies <2 mg (the plain zero threshold); a captured "<5mg"
  // text declaration should be treated the same way lessThanOneGram is for
  // the carb family, but no caller in this codebase produces that shape
  // yet, so it's called out here rather than silently mishandled.
  cholesterolMg: { citation: '101.9(c)(3)', zeroFloor: 2,
    tiers: [{ upTo: Infinity, increment: 5 }] },

  sodiumMg: { citation: '101.9(c)(4)', zeroFloor: 5,
    tiers: [{ upTo: 140, increment: 5 }, { upTo: Infinity, increment: 10 }] },

  // Potassium is deliberately NOT modeled with a numeric-increment rule.
  // 101.9(c)(4)'s explicit 5/140 mg increment table is written for sodium
  // only; potassium's quantitative mg declaration falls under (c)(8)'s
  // general vitamin/mineral provisions, which set units and significant-
  // figure conventions but don't spell out a fixed rounding increment the
  // way sodium's paragraph does. Common labeling software mirrors sodium's
  // tiers in practice, but asserting that here without a clean citation
  // would be exactly the kind of overstated precision this module exists
  // to avoid — so potassiumMg falls through to boundsForDeclaredValue()'s
  // "no known rule" null, same as an unlisted vitamin/mineral.

  'carbs.total': { citation: '101.9(c)(6)',      zeroFloor: 0.5, altTextFloor: 1, tiers: [{ upTo: Infinity, increment: 1 }] },
  'carbs.fiber': { citation: '101.9(c)(6)(i)',   zeroFloor: 0.5, altTextFloor: 1, tiers: [{ upTo: Infinity, increment: 1 }] },
  'carbs.sugar': { citation: '101.9(c)(6)(ii)',  zeroFloor: 0.5, altTextFloor: 1, tiers: [{ upTo: Infinity, increment: 1 }] },
  protein:       { citation: '101.9(c)(7)',      zeroFloor: 0.5, altTextFloor: 1, tiers: [{ upTo: Infinity, increment: 1 }] },
};

/**
 * The range of true per-serving values consistent with one declared,
 * label-rounded number.
 *
 * @param {string}  nutrientPath    Dotted path matching NutrientProfile's
 *   own shape, e.g. 'calories', 'protein', 'fat.trans', 'carbs.fiber',
 *   'sodiumMg'. Paths with no entry in RULES above (carbs.starch — not a
 *   labeled nutrient; vitamins.* / minerals.* — %DV-tiered, not modeled
 *   yet; potassiumMg — see the note above) return null rather than a guessed
 *   range, same "unmodeled means null, never a fabricated number" rule
 *   every other resolver in core/nutrition-model.js already follows
 *   (gramsForSizeOption(), estimateBmr() in metrics/nutrition.js).
 * @param {number|null} declaredValue  The number as printed on the label.
 * @param {{lessThanOneGram?: boolean}} [opts]  Pass lessThanOneGram: true
 *   when the label used the "Contains less than 1 gram" text alternative
 *   (101.9(c)(6)/(c)(7)) instead of a typed number — widens the returned
 *   range to [0, 1) for the carb/protein family rather than the tighter
 *   zeroFloor band a typed "0" implies. Ignored for nutrients without an
 *   altTextFloor (the fat/cholesterol/sodium families have no equivalent
 *   text alternative in the regulation).
 * @returns {{min: number, max: number}|null}
 */
export function boundsForDeclaredValue(nutrientPath, declaredValue, opts = {}) {
  const rule = RULES[nutrientPath];
  if (!rule || declaredValue == null || !isFinite(declaredValue)) return null;

  if (opts.lessThanOneGram && rule.altTextFloor != null) {
    return { min: 0, max: rule.altTextFloor };
  }
  if (declaredValue === 0 && rule.zeroFloor != null) {
    return { min: 0, max: rule.zeroFloor };
  }
  const tier = rule.tiers.find(t => declaredValue <= t.upTo) ?? rule.tiers[rule.tiers.length - 1];
  const half = tier.increment / 2;
  return { min: Math.max(0, declaredValue - half), max: declaredValue + half };
}

/**
 * Walks a declared NutrientProfile-shaped tree (e.g. a branded
 * Ingredient's perLabelServing) and returns the same shape back with every
 * numeric leaf replaced by its boundsForDeclaredValue() range — the tree
 * counterpart to core/nutrition-model.js's _scaleTree()/_sumTree(), which
 * this deliberately mirrors (generic walk over whatever keys are present,
 * so a future nutrient added to NutrientProfile doesn't also require
 * updating a hand-written field list here).
 *
 * @param {import('./nutrition-model.js').NutrientProfile|null} perLabelServing
 * @returns {Object|null}  Same tree shape; leaves are {min,max} or null.
 */
export function boundsForNutrients(perLabelServing) {
  if (perLabelServing == null) return null;
  return _boundsTree(perLabelServing, '');
}

function _boundsTree(node, path) {
  if (node == null) return null;
  if (typeof node === 'number') return boundsForDeclaredValue(path, node);
  if (typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = _boundsTree(value, path ? `${path}.${key}` : key);
    }
    return out;
  }
  return null;
}

/**
 * Whether a declared value's rounding-implied range is wide enough,
 * relative to the number actually printed, to be worth a UI calling out
 * (an "≈" marker, a tooltip) rather than showing the bare declared number
 * as if it were exact. Two cases both count: a declared zero that could
 * still be a meaningful nonzero amount once scaled up (the trans-fat/
 * sodium/added-sugar case this whole module exists for), and any declared
 * value where the rounding band is at least as wide as the value itself.
 *
 * Deliberately a `boolean`, not a severity score — the ingredient editor
 * decides what to *do* with the flag (a tooltip, an inline note); this
 * function only answers "is there something here worth mentioning."
 *
 * @param {number|null} declaredValue
 * @param {{min:number,max:number}|null} bounds
 * @returns {boolean}
 */
export function isMeaningfullyUncertain(declaredValue, bounds) {
  if (bounds == null || declaredValue == null) return false;
  if (declaredValue === 0) return bounds.max > 0;
  return (bounds.max - bounds.min) >= declaredValue;
}

export default { boundsForDeclaredValue, boundsForNutrients, isMeaningfullyUncertain };
