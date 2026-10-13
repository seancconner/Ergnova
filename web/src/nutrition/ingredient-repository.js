// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * nutrition/ingredient-repository.js
 *
 * The one place "where a given ingredient's data lives" gets resolved —
 * merges the bundled seed database (data/nutrition/ingredients.json,
 * `seed:`-prefixed, static/build-time, sourced from USDA FoodData Central)
 * with custom ingredients a rider has added (storage/db.js's `ingredients`
 * store, `custom:`-prefixed). Nothing else — the diary quick-add,
 * ui/recipe-editor.js, charts/macro-pie.js — talks to either source
 * directly; see DIET_PANEL_DESIGN.md §4.
 *
 * A plain exported object, same shape as storage/db.js's `db` namespace
 * (no class, no instance state beyond the module-level seed index below).
 *
 * Usage:
 *   import { ingredientRepository } from './nutrition/ingredient-repository.js';
 *   const chicken = await ingredientRepository.get('seed:chicken-breast-raw');
 *   const results = await ingredientRepository.search('chick'); // custom first, then seed
 *   const everything = await ingredientRepository.all();        // custom first, then seed — no name filter
 */

import { db } from '../storage/db.js';
import SEED_INGREDIENTS from '../data/nutrition/ingredients.json';

// Indexed once at module load — the bundled set is static for the life of
// the page (a new seed file only ever arrives via a fresh build), so
// there's no reason to re-scan the array on every get() call the way
// search() below reasonably does for a one-off substring match.
const _seedById = new Map(SEED_INGREDIENTS.map(ing => [ing.id, ing]));

function _matches(ingredient, query) {
  return ingredient.name.toLowerCase().includes(query)
    || (ingredient.brand ?? '').toLowerCase().includes(query);
}

export const ingredientRepository = {
  /**
   * Resolves a single ingredient by id, regardless of which store it lives
   * in — callers (recipeNutrientsPerServing()'s ingredientLookupFn, the
   * diary quick-add) never need to branch on the id prefix themselves.
   *
   * @param {string|null} id  'custom:...' or 'seed:...'
   * @returns {Promise<Ingredient|null>}
   */
  async get(id) {
    if (id == null) return null;
    if (id.startsWith('custom:')) {
      const custom = await db.getCustomIngredients();
      return custom.find(ing => ing.id === id) ?? null;
    }
    return _seedById.get(id) ?? null;
  },

  /**
   * Case-insensitive substring match on name (and brand, for custom
   * ingredients — the bundled set never sets one). Custom results sort
   * first: a rider's own correction or addition should outrank the
   * generic bundled entry it's meant to supplement, same "custom-first"
   * rule DIET_PANEL_DESIGN.md §4 calls for.
   *
   * @param {string} query
   * @returns {Promise<Ingredient[]>}  empty array for a blank/whitespace query, never all ingredients
   */
  async search(query) {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return [];

    const custom = await db.getCustomIngredients();
    const customMatches = custom.filter(ing => _matches(ing, q));
    const seedMatches = SEED_INGREDIENTS.filter(ing => _matches(ing, q));
    return [...customMatches, ...seedMatches];
  },

  /**
   * Every ingredient available to rank/browse without a text query —
   * custom ingredients first, then the full bundled seed set, same
   * custom-first precedence search() already uses. Backs views/diet.js's
   * Log-food Smart filter "Suggested for today's focus" browse
   * (metrics/daily-values.js#rankIngredientsForFocus() run over the
   * complete candidate pool instead of a name-matched subset).
   *
   * @returns {Promise<Ingredient[]>}
   */
  async all() {
    const custom = await db.getCustomIngredients();
    return [...custom, ...SEED_INGREDIENTS];
  },

  /**
   * Bundled seed ingredients tagged with a given cuisine — used by the
   * Recipes tab's cuisine filter alongside the preset recipe packs
   * (data/nutrition/recipes/<cuisine>.json). Custom ingredients are
   * deliberately excluded: cuisineTags on a seed entry is curated
   * metadata for browsing, not something a quickly-added custom
   * ingredient reliably has filled in.
   *
   * @param {string} cuisine
   * @returns {Ingredient[]}  synchronous — no IndexedDB round-trip needed
   */
  seedByCuisine(cuisine) {
    return SEED_INGREDIENTS.filter(ing => ing.cuisineTags?.includes(cuisine));
  },
};

export default ingredientRepository;
