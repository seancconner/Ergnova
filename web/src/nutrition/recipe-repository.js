// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * nutrition/recipe-repository.js
 *
 * Bundled cuisine-preset recipes (data/nutrition/recipes/<cuisine>.json) —
 * the Recipes tab's other data source alongside the user's own saved
 * recipes (storage/db.js's `recipes` store). Counterpart to
 * nutrition/ingredient-repository.js, but simpler in one direction:
 * presets are read-only static JSON, never edited in place. Cloning one
 * ("Save" on a preset in the Recipes tab) copies it into the user's own
 * `recipes` store with a new id and `sourcePresetId` set — see
 * DIET_PANEL_DESIGN.md §4 — it never mutates this module's data.
 *
 * `import.meta.glob(..., { eager: true })` rather than a hand-written list
 * of `import italian from '../data/nutrition/recipes/italian.json'` lines
 * — same "expand the library over time without touching any code" goal
 * ingredient-repository.js's bundled seed set already has: dropping a new
 * `<cuisine>.json` file into data/nutrition/recipes/ picks it up on the
 * next build, no import to add here.
 *
 * Usage:
 *   import { recipeRepository } from './nutrition/recipe-repository.js';
 *   recipeRepository.presets              // Recipe[] — every bundled preset
 *   recipeRepository.presetsByCuisine('italian')
 *   recipeRepository.cuisines()           // ['italian', 'japanese', 'mexican', ...]
 *   const results = await recipeRepository.search('bolognese'); // own first, then presets
 */

import { db } from '../storage/db.js';

// Eagerly resolved at module load — the bundled set is static for the life
// of the page, same reasoning ingredient-repository.js gives for indexing
// its seed set once rather than per-call.
const _cuisineFiles = import.meta.glob('../data/nutrition/recipes/*.json', { eager: true });

/** @type {Recipe[]} */
const PRESET_RECIPES = Object.values(_cuisineFiles).flatMap((mod) => mod.default ?? mod);

function _matches(recipe, query) {
  return recipe.name.toLowerCase().includes(query)
    || (recipe.cuisine ?? '').toLowerCase().includes(query);
}

export const recipeRepository = {
  /** Every bundled preset recipe, flattened across every cuisine file. */
  presets: PRESET_RECIPES,

  /**
   * @param {string} id  'seed-recipe:...'
   * @returns {Recipe|null}
   */
  getPreset(id) {
    return PRESET_RECIPES.find((r) => r.id === id) ?? null;
  },

  /**
   * @param {string} cuisine
   * @returns {Recipe[]}
   */
  presetsByCuisine(cuisine) {
    return PRESET_RECIPES.filter((r) => r.cuisine === cuisine);
  },

  /** Sorted, deduped cuisine tags actually present among the bundled
   *  presets — drives the Recipes tab's cuisine filter alongside whatever
   *  cuisine tags the rider's own saved recipes happen to use. */
  cuisines() {
    return [...new Set(PRESET_RECIPES.map((r) => r.cuisine).filter(Boolean))].sort();
  },

  /**
   * Case-insensitive substring match on name (and cuisine, e.g. "italian"
   * turns up every Italian preset) — same shape as
   * ingredient-repository.js's search(): the rider's own saved recipes
   * (storage/db.js's `recipes` store) sort first, ahead of the bundled
   * presets, same "the rider's own data wins" precedence
   * ingredient-repository.js's custom-first search already uses. Drives
   * views/diet.js's Today quick-add, so a recipe turns up there the same
   * way an ingredient already does.
   *
   * @param {string} query
   * @returns {Promise<Recipe[]>}  empty array for a blank/whitespace query, never every recipe
   */
  async search(query) {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return [];

    const own = await db.getRecipes();
    const ownMatches = own.filter((r) => _matches(r, q));
    const presetMatches = PRESET_RECIPES.filter((r) => _matches(r, q));
    return [...ownMatches, ...presetMatches];
  },

  /**
   * Every recipe available to rank/browse without a text query — the
   * rider's own saved recipes first, then every bundled preset, same
   * own-first precedence search() already uses. Backs views/diet.js's
   * Log-food Smart filter "Suggested for today's focus" browse
   * (metrics/daily-values.js#rankRecipesForFocus() run over the complete
   * candidate pool instead of a name-matched subset), alongside
   * ingredient-repository.js's own all().
   *
   * @returns {Promise<Recipe[]>}
   */
  async all() {
    const own = await db.getRecipes();
    return [...own, ...PRESET_RECIPES];
  },
};

export default recipeRepository;
