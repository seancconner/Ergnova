// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * views/diet.js
 *
 * The Diet tab — DietPage. Follows OverviewPage's exact shape
 * (constructor(container, opts) / async load() fetches + re-renders /
 * plain template-string _render()).
 *
 * **Today** is the macro pie +
 * calorie-balance readout, the quick-add flow against the bundled/custom
 * ingredient database, and today's logged items. The quick-add amount
 * entry is Weight always, plus Volume when the picked ingredient has a
 * densityGPerMl, plus Size ("2 × Medium", "1 × Clove") when it has
 * core/nutrition-model.js's sizeOptions — see views/diet-log-logic.js's
 * resolveAmountG()/gramsForSizeOption()'s own doc comments; same
 * "presence of the field decides whether the mode is offered" rule for
 * both. Phase 5 adds **Recipes**:
 * the rider's own saved recipes (storage/db.js's `recipes` store) and the
 * bundled cuisine-preset packs (nutrition/recipe-repository.js), both
 * filterable through a collapsible filter menu — region/cuisine, a
 * calorie-per-serving band, and AND'd nutrition-profile chips (High
 * Protein/Low Carb/Low Fat/High Fiber/Low Sodium), plus a sort order —
 * see NUTRITION_FILTERS/CALORIE_BANDS/RECIPE_SORTS below and
 * _renderRecipesSearchBar()/_recipeMatchesFilters(). "+ New Recipe"/"+ Custom Ingredient" entry
 * points into the shared ui/recipe-editor.js / ui/ingredient-editor.js
 * overlays (opened via the onOpenRecipeEditor/onAddCustomIngredient
 * callbacks below — app.js owns the actual instances, same "view calls
 * back into app.js" shape WorkoutEditor's onSave/CardioSessionFlow's onStart
 * already use), and a "Save" action on a preset that opens the recipe
 * editor pre-filled with a clone (DIET_PANEL_DESIGN.md §4). Phase 6 adds
 * **History** (the fourth rail category — see DIET_CATS): past days as `.history-card` rows (date, total kcal, a small
 * macro-split bar), tap to expand — the same accordion-expand-a-card
 * interaction history-browser.js uses for session detail, applied to a
 * day of diary entries instead of a session's laps. The expanded log
 * reuses _entryItem() as-is, so a past day's amounts stay editable/
 * deletable the same way today's are.
 *
 * Master-detail layout: a MasterDetailRail — Today / Recipes / Ingredients /
 * History — built once by _buildShell(), with only the active category's
 * `[data-cat-body]` slot holding markup (see _render()). Ingredients is a
 * searchable kcal-per-100g tile browse of the whole ingredient database;
 * tapping a tile opens it in the log sheet (below).
 *
 * Post-Phase-6 fix: a recipe card's own "Log" button (own recipes and
 * presets alike) opens an inline panel to log any number of servings —
 * DiaryEntry.source's `type: 'recipe'`/`servings` shape existed from Phase
 * 1 onward, but nothing before this actually wrote one; see
 * _recipeLogPanel()/_addRecipeDiaryEntry()/_resolveRecipe().
 * _entryItem()/
 * _entryEditForm()/_saveEditedAmount() branch on `source.type` so a
 * logged recipe portion displays, edits, and deletes the same way a
 * logged ingredient amount always has.
 *
 * Post-Phase-6 fix #2: the Today quick-add's "Log food" search now
 * matches recipes as well as ingredients (nutrition/recipe-repository.js
 * grew a search(), mirroring ingredient-repository.js's own shape —
 * rider's own saved recipes first, then bundled presets). A recipe hit is
 * badged and priced per serving rather than per 100g (see
 * _recipeSearchResultRow()), and picking one opens the exact same
 * servings-based _recipeLogPanel() the Recipes tab's "Log" button already
 * used — see _selectRecipeFromSearch()/_applySelectedRecipeForLog(), and
 * _bindToday()'s wiring for that panel's controls (_selectedRecipeForLog
 * is mutually exclusive with _selectedIngredient the same way the two
 * quick-add forms below the search box already are).
 *
 * Log sheet: the two inline forms described above (the ingredient
 * quick-add form and the recipe servings panel) are gone. Logging an ingredient or a recipe now opens
 * the shared detail sheet (ui/detail-sheet.js) through DietLogSheet (views/diet-log-sheet.js; the rules
 * it applies are in views/diet-log-logic.js) from all three places that used to open a form — a
 * search result on Today, an Ingredients tile, a recipe card's "Log" button. The sheet holds its own
 * draft, so nothing of it lives on this page any more (no _selectedIngredient, _amountMode,
 * _loggingRecipeId and so on); it hands the finished diary entry back through _addLoggedEntry().
 *
 * Post-Phase-6 fix #3: the Smart filter toggle above the "Log food" search
 * (macro-pie.js's _focusOverview()) now actually reaches the recipe half of
 * that search's results, not just the ingredient half — _applySearchResults()
 * runs recipes through metrics/daily-values.js#rankRecipesForFocus() the same
 * way it already ran ingredients through rankIngredientsForFocus(), so a
 * recipe hit sorts toward today's focus nutrients and picks up its own
 * "High in X" tag (_recipeSearchResultRow()) exactly like an ingredient hit
 * always has. Both rankers also gained a second, absolute exclusion
 * alongside their existing "would push a Watch nutrient past today's
 * remaining budget" one: an item whose single reference amount (100g for an
 * ingredient, one serving for a recipe) already sits within 5% of a
 * nutrient-to-limit's *full* daily value is dropped outright, regardless of
 * what's logged so far today — a recipe carrying most of a whole day's
 * sodium in one serving being the case that motivated it (see
 * metrics/daily-values.js#_fitsWithinLimits()).
 *
 * Post-Phase-6 fix #4: turning the Smart filter on used to show nothing in
 * the "Log food" dropdown until the rider actually typed a query — the
 * filter only ever re-ranked whatever _runSearch() had already fetched for
 * the current query, and an empty box means _runSearch() never ran.
 * _loadFocusSuggestions() closes that gap: with the box empty and the
 * filter on, it pulls the *entire* candidate pool (ingredientRepository/
 * recipeRepository#all(), not #search()) through the exact same
 * _applySearchResults() ranking a typed search's hits go through, so the
 * dropdown immediately shows "Suggested for today's focus" picks instead
 * of staying blank. Wired in from three places — the toggle's own change
 * handler, _runSearch()'s empty-query branch (clearing the box back out
 * while the filter's already on), and a check at the top of _bindToday()
 * that re-fires it after any Today-tab render where it should be showing
 * but isn't loaded yet (e.g. right after a diary entry gets logged, which
 * clears the dropdown) — see that method's own doc comment for how it
 * guards against redundant/stale fetches.
 *
 * Post-Phase-6 fix #5 (superseded by fix #6 below): "Suggested for today's
 * focus" briefly suggested recipes only, not standalone ingredients, to
 * keep the empty-box browse from feeling crowded.
 *
 * Post-Phase-6 fix #6: "Suggested for today's focus" browses both kinds
 * again, each ranked and capped to its own top 10 — _loadFocusSuggestions()
 * fetches ingredientRepository#all() alongside recipeRepository#all() (see
 * that method's own doc comment for why fix #5's ingredient-free browse
 * came back), and _applySearchResults() gives the empty-box browse case a
 * roomier 10-ingredient/10-recipe cap instead of a typed query's tighter
 * 5/3, so a rider gets a real top-10 ranking of each kind rather than a
 * handful blurred together. _renderSearchResults() renders the two kinds
 * as separately-labeled "Top 10 recipes"/"Top 10 ingredients" groups for
 * this browse case rather than one flat list. A *typed* search is
 * unaffected — _runSearch() still fetches and shows both kinds capped to
 * 5/3 for an actual query, exactly as before.
 *
 * Post-Phase-6 fix #7: the Recipes tab's own search box
 * (_recipeMatchesFilters()/_recipeMatchesQuery()) now matches a recipe by
 * any ingredient it's made from, not just its own name — e.g. typing
 * "paneer" turns up every recipe containing paneer, not only one actually
 * named that. _resolveRecipeIngredientNames(), called once per load()
 * right after _resolveEntryNames(), resolves every ingredient any recipe
 * (the rider's own plus every bundled preset) references into the same
 * _ingredientById map, so the match itself stays a synchronous name check
 * against already-resolved data on every keystroke.
 *
 * Usage:
 *   const dietPage = new DietPage($('diet-panel'), {
 *     profile,
 *     onAddCustomIngredient: (prefillName) => Promise<Ingredient|null>,  // opens the shared ingredient editor
 *     onOpenRecipeEditor:    (recipe) => void,                          // opens the shared recipe editor (omit recipe for a blank new one)
 *   });
 *   await dietPage.load();   // fetch diaryEntries + sessions + recipes, re-render
 */

import { db } from '../storage/db.js';
import { ingredientRepository } from '../nutrition/ingredient-repository.js';
import { recipeRepository }     from '../nutrition/recipe-repository.js';
import { estimateBmr, dailyCalorieBalance } from '../metrics/nutrition.js';
import { macroCalorieSplit, scaleNutrients, sumNutrients, scaleRecipeNutrients }
                                 from '../core/nutrition-model.js';
import { renderMacroPie }       from '../charts/macro-pie.js';
import { nutrientStatusList, focusNutrients, rankIngredientsForFocus, rankRecipesForFocus, bestFocusMatch }
                                 from '../metrics/daily-values.js';
import { smallWeightUnitLabel, gToDisplayWeight, displayWeightToG }
                                 from '../metrics/units.js';
import { fitText }              from '../ux/fit-text.js';
import { MasterDetailRail }     from '../ui/master-detail.js';
import { DietLogSheet }         from './diet-log-sheet.js';
import { MEAL_SLOT_LABELS }     from './diet-log-logic.js';

// ── Diet rail categories ────────────────────────────────────────────────────
// Today / Recipes / Ingredients / History. Ingredients is a searchable browse of
// ingredientRepository's bundled + custom database (see _renderIngredientsView()):
// plain kcal/100g tiles. History is the diary's own day-by-day log.
const DIET_CATS = [
  ['today',       'Today',       'icon-sun'],
  ['recipes',     'Recipes',     'icon-bowl'],
  ['ingredients', 'Ingredients', 'icon-carrot'],
  ['history',     'History',     'icon-session-history'],
];

/** Recipes tab filter menu — nutrition-profile facets, multi-select and
 *  AND'd together. Pure per-serving threshold checks against a Recipe's
 *  precomputed `perServing` (the exact NutrientProfile _recipeCard()
 *  already reads for its stat chips), so a recipe that matches a filter
 *  and the numbers shown on its own card always agree.
 *
 *  Deliberately limited to numeric macro/micronutrient thresholds rather
 *  than diet-restriction labels (vegetarian/vegan/allergen-free, etc.) —
 *  those would need every ingredient (bundled seed set *and* whatever a
 *  rider's custom ingredients happen to be named) tagged with an accurate
 *  food-category, which nothing in core/nutrition-model.js or
 *  data/nutrition/ingredients.json carries today. A wrong guess on a
 *  restriction filter is worse than not offering it — same reasoning
 *  metrics/units.js's volume-toggle only turning on for ingredients with a
 *  real densityGPerMl already applies elsewhere in this feature. */
const NUTRITION_FILTERS = {
  highProtein: { label: 'High Protein', hint: '≥25g protein / serving', test: (p) => (p.protein ?? 0) >= 25 },
  lowCarb:     { label: 'Low Carb',     hint: '≤20g carbs / serving',   test: (p) => (p.carbs?.total ?? 0) <= 20 },
  lowFat:      { label: 'Low Fat',      hint: '≤10g fat / serving',     test: (p) => (p.fat?.total ?? 0) <= 10 },
  highFiber:   { label: 'High Fiber',   hint: '≥5g fiber / serving',    test: (p) => (p.carbs?.fiber ?? 0) >= 5 },
  lowSodium:   { label: 'Low Sodium',   hint: '≤500mg sodium / serving', test: (p) => (p.sodiumMg ?? 0) <= 500 },
};

/** Calorie-per-serving bands — single-select ("mood" more than nutrition
 *  target: Light vs. Hearty). Tested against the same macroCalorieSplit()
 *  total _recipeCard()'s KCAL chip displays (not perServing.calories
 *  directly), so a recipe filed under "Light" always matches the number
 *  printed on its own card. */
const CALORIE_BANDS = {
  light:    { label: 'Light',    hint: '<400 kcal / serving',       test: (kcal) => kcal < 400 },
  moderate: { label: 'Moderate', hint: '400–700 kcal / serving',    test: (kcal) => kcal >= 400 && kcal <= 700 },
  hearty:   { label: 'Hearty',   hint: '>700 kcal / serving',       test: (kcal) => kcal > 700 },
};

const RECIPE_SORTS = {
  default:         'Default',
  'calories-asc':  'Calories: Low to High',
  'calories-desc': 'Calories: High to Low',
  'protein-desc':  'Protein: High to Low',
};

// How long to wait after the last keystroke before actually searching —
// ingredientRepository.search() round-trips through IndexedDB (custom
// ingredients) on every call, so this avoids firing one per keystroke.
const SEARCH_DEBOUNCE_MS = 150;

export class DietPage {
  /**
   * @param {HTMLElement} container
   * @param {Object} opts
   * @param {Object} opts.profile               Live profile object (age, sex, heightCm,
   *   leanBodyMassKg, riderWeight, units, ...) — same reference app.js mutates whenever Settings autosaves.
   * @param {Object} [opts.ingredientRepository] Defaults to the shared singleton; overridable for tests.
   * @param {Function} [opts.onAddCustomIngredient] (prefillName) => Promise<Ingredient|null> —
   *   opens the shared ingredient editor (app.js's ingredientEditor); used by the Today quick-add's
   *   "can't find it?" fallback and the Recipes tab's "+ Custom Ingredient" button.
   * @param {Function} [opts.onOpenRecipeEditor]     (recipe|null) => void — opens the shared recipe
   *   editor (app.js's recipeEditor); omit the argument for a blank new recipe, pass an existing
   *   saved Recipe to edit it, or a preset clone (id stripped, sourcePresetId set) to save a copy.
   * @param {Function} [opts.onPrintRecipe]          (recipe) => void — opens the shared printable
   *   recipe sheet (app.js's recipePrintSheet, see ui/recipe-print.js) for a saved recipe or preset.
   */
  constructor(container, {
    profile,
    ingredientRepository: repo = ingredientRepository,
    onAddCustomIngredient,
    onOpenRecipeEditor,
    onPrintRecipe,
  } = {}) {
    this._container = container;
    this._profile = profile;
    this._repo = repo;
    this._onAddCustomIngredient = onAddCustomIngredient ?? null;
    this._onOpenRecipeEditor = onOpenRecipeEditor ?? null;
    this._onPrintRecipe = onPrintRecipe ?? null;

    this._diaryEntries = [];
    this._sessions = [];
    this._recipes = [];             // user's own saved recipes (storage/db.js's `recipes` store)

    // Recipes tab filter menu state — see NUTRITION_FILTERS/CALORIE_BANDS
    // above and _renderRecipesSearchBar()/_recipeMatchesFilters() below.
    this._recipeFilters = {
      cuisines: new Set(),   // empty = "All" cuisines; else recipe.cuisine must be one of these
      nutrition: new Set(),  // subset of NUTRITION_FILTERS keys, AND'd together
      calorieBand: null,     // null | 'light' | 'moderate' | 'hearty'
    };
    this._recipeSort = 'default';   // one of RECIPE_SORTS' keys
    this._filterMenuOpen = false;   // whether the Recipes tab's filter panel is expanded
    this._recipeSearchQuery = '';   // Recipes tab's own name search — see _recipeMatchesFilters()/_renderRecipesSearchBar()

    this._ingredientById = new Map(); // resolved names for today's ingredient-sourced entries, plus every ingredient any recipe references — see _resolveEntryNames()/_resolveRecipeIngredientNames()
    this._recipeById = new Map();     // resolved names for today's recipe-sourced entries — own recipes + presets, see _resolveRecipe()

    this._activeView = 'today'; // one of DIET_CATS' ids: 'today' | 'recipes' | 'ingredients' | 'history'

    // The rail — built once by _buildShell()
    // on the first _render(), same "shell built once, content refreshed in
    // place" split OverviewPage/HistoryBrowser use, so a background load()
    // (a diary entry saved, a recipe edited) doesn't reset the rail or drop
    // the rider back on Today. Only the active category's slot holds markup
    // at any moment — see _render().
    this._rail = null;

    // Ingredients category — the whole browse pool (custom first, then the
    // bundled set; ingredientRepository.all()), refreshed by load() so
    // _renderIngredientsView() can stay synchronous like every other view
    // here, plus the name filter typed into that category's search box.
    this._ingredientPool = [];
    this._ingredientQuery = '';

    // Quick-add draft state — instance fields (not re-fetched) so typing
    // in the search box or picking a result survives the small targeted
    // DOM updates below without a full re-render stealing input focus.
    this._searchQuery = '';
    this._searchResults = [];
    this._lastIngredientMatches = []; // raw, pre-smart-filter ingredientRepository.search() hits for the current query — see _applySearchResults()
    this._lastRecipeMatches = [];     // raw recipeRepository.search() hits for the current query, same as above
    this._searchFocus = null;         // this render's focusNutrients() list, while the smart filter is on — feeds both _ingredientSearchResultRow()'s and _recipeSearchResultRow()'s "High in X" tag; null when the filter is off
    this._smartFilterNote = null;     // set when the smart filter would exclude every match, so results fall back to unfiltered instead of hiding real hits — see _applySearchResults()
    this._isBrowsingFocus = false;    // true while _lastIngredientMatches/_lastRecipeMatches hold the full .all() candidate pool (Smart filter's "Suggested for today's focus" browse, empty search box) rather than a typed search's hits — see _loadFocusSuggestions()/_renderSearchResults()
    this._searchToken = 0;      // guards a slow search() resolving after a newer one started
    this._searchDebounce = null;
    // The log sheet (views/diet-log-sheet.js): logging an ingredient or a recipe opens the shared detail
    // sheet, which keeps its own draft (amount, unit, meal) — none of it lives on this page. Built once;
    // `getUnits` is read each time it opens, so a units change in Settings is picked up.
    this._logSheet = new DietLogSheet({
      getUnits: () => this._profile.units,
      onAdd: (entry) => this._addLoggedEntry(entry),
    });

    this._expandedEntryId = null; // diary entry currently showing its inline edit-amount panel
    this._editAmountValue = '';

    this._expandedHistoryDate = null; // History tab: dateStr (toDateString()) of the day currently expanded, or null

    this._macroAdvancedOpen = false; // Today tab: whether the macro pie's "Advanced nutrition info" panel is expanded
    this._smartFilterOn = false; // Today tab: the Advanced panel's "Today's focus" overview — Log-food smart filter toggle, see _renderSearchResults()
  }

  /** Fetch diary entries + sessions (sessions feed today's exercise
   *  calories via metrics/nutrition.js's dailyCalorieBalance()) + the
   *  rider's saved recipes, and re-render. Safe to call anytime — matches
   *  OverviewPage's load() shape exactly; see app.js#init() and
   *  switchTab(). Also the refresh point after a recipe/ingredient save,
   *  a diary entry save/delete, or a recipe delete — same "re-render just
   *  re-reads it" pattern every other mutation in this file already uses. */
  async load() {
    const [diaryEntries, sessions, recipes, ingredientPool] = await Promise.all([
      db.getDiaryEntries(), db.getSessions(), db.getRecipes(),
      this._repo.all?.() ?? [],
    ]);
    this._diaryEntries = diaryEntries;
    this._sessions = sessions;
    this._recipes = recipes;
    this._ingredientPool = ingredientPool;
    await this._resolveEntryNames(diaryEntries);
    await this._resolveRecipeIngredientNames();
    this._render();
  }

  /** Overview's "needs a meal logged" tap-through (metrics/overview-cards.js's
   *  `nutrition` need) lands here: switches to the Today view if the rider
   *  was elsewhere (Recipes/Ingredients/History), then hands back the quick-add search
   *  box so app.js can scroll to it and light it up the same way it does a
   *  Settings field (see app.js's _highlightElement()). Doesn't touch the
   *  highlight itself — that stays app.js's one shared implementation
   *  rather than a second copy of the dismiss-on-input wiring here.
   *  @returns {HTMLInputElement|null} */
  focusLogFood() {
    this._showView('today');
    return this._container.querySelector('.diet-search-input');
  }

  /** Re-measures the md-rail's rendered height (ui/master-detail.js's
   *  _measureRailHeight(), which style.css's .md-pane padding-bottom reads
   *  as --rail-h). _buildShell() (called from load(), during app.js's
   *  startup sequence) constructs the rail while `diet-panel` still has
   *  its initial `hidden` class on it — a display:none ancestor collapses
   *  offsetHeight to zero, so the rail's first real height is wrong (and
   *  .md-pane under-reserves space for it) until something re-measures it.
   *  app.js's switchTab() calls this the moment the Diet tab is actually
   *  shown, rather than leaving that reservation wrong until the rider
   *  happens to trigger a collapse toggle. A no-op if the rail hasn't been
   *  built yet. */
  refreshRailPosition() {
    this._rail?.refreshPosition();
  }

  // ─── Data helpers ───────────────────────────────────────────────────────

  /** DiaryEntry only snapshots resolved *nutrients* (see
   *  core/nutrition-model.js's module doc comment) — not a display name —
   *  so the logged-items list has to resolve each entry's ingredient or
   *  recipe separately, split by `source.type` into the two lookups below.
   *  Batched once per load() rather than once per row, and keyed so a
   *  since-deleted custom ingredient or a since-deleted recipe each
   *  degrade to their own "removed" label instead of breaking the row
   *  (see _entryItem()/_entryEditForm()). */
  async _resolveEntryNames(entries) {
    const ingredientIds = new Set();
    const recipeIds = new Set();
    for (const e of entries) {
      if (!e.source?.id) continue;
      (e.source.type === 'recipe' ? recipeIds : ingredientIds).add(e.source.id);
    }
    const [ingredientPairs, recipePairs] = await Promise.all([
      Promise.all([...ingredientIds].map(async id => [id, await this._repo.get(id)])),
      Promise.all([...recipeIds].map(async id => [id, this._resolveRecipe(id)])),
    ]);
    this._ingredientById = new Map(ingredientPairs);
    this._recipeById = new Map(recipePairs);
  }

  /** Every ingredient any recipe — the rider's own saved ones plus every
   *  bundled cuisine preset — references, resolved once per load() so the
   *  Recipes tab's search box (_recipeMatchesQuery()) can match on an
   *  ingredient's name (e.g. typing "chicken" turning up a recipe named
   *  "Weeknight Stir-Fry") without an async ingredientRepository round
   *  trip on every keystroke — same batch-once-not-per-row reasoning
   *  _resolveEntryNames() above already gives for the logged-items list.
   *  Merges into that same _ingredientById map (an id already resolved
   *  for today's diary entries doesn't need a second network round trip
   *  just because a recipe also references it) rather than keeping a
   *  separate map — called right after _resolveEntryNames() in load(),
   *  never before, so this fills gaps in that map instead of being wiped
   *  out by its own `new Map(...)` reset. An id this app can no longer
   *  resolve (e.g. a since-deleted custom ingredient another recipe still
   *  references) simply never gets an entry — _recipeMatchesQuery() below
   *  already treats a missing entry as "doesn't match", same
   *  degrade-gracefully rule recipeNutrientsPerServing() applies to the
   *  identical situation. */
  async _resolveRecipeIngredientNames() {
    const ids = new Set();
    for (const recipe of [...this._recipes, ...recipeRepository.presets]) {
      for (const line of recipe.ingredients ?? []) {
        if (line.ingredientId != null && !this._ingredientById.has(line.ingredientId)) {
          ids.add(line.ingredientId);
        }
      }
    }
    const pairs = await Promise.all([...ids].map(async id => [id, await this._repo.get(id)]));
    for (const [id, ingredient] of pairs) this._ingredientById.set(id, ingredient);
  }

  /** A recipe-type DiaryEntry's (or the Recipes tab's "Log" panel's)
   *  source.id points at either the rider's own saved recipes
   *  (storage/db.js's `recipes` store, a numeric autoIncrement id) or a
   *  bundled cuisine preset (nutrition/recipe-repository.js, a string
   *  'seed-recipe:' id) — the same two sources _bindRecipes()'s "Save a
   *  preset" flow already reads from. Own recipes are checked first (the
   *  id spaces never actually collide, since one's always a number and
   *  the other's always a string), mirroring the "the rider's own data
   *  wins" precedence ingredient-repository.js's custom-first search
   *  already uses elsewhere in this feature. Returns null — not thrown —
   *  for a recipe that's since been deleted, same degrade-gracefully rule
   *  _ingredientById already follows for a removed custom ingredient. */
  _resolveRecipe(id) {
    return this._recipes.find(r => r.id === id) ?? recipeRepository.getPreset(id) ?? null;
  }

  _todayEntries() {
    const todayStr = new Date().toDateString();
    return this._diaryEntries
      .filter(e => new Date(e.loggedAt).toDateString() === todayStr)
      .sort((a, b) => b.loggedAt - a.loggedAt);
  }

  _todayTotals() {
    return this._todayEntries().reduce((acc, e) => sumNutrients(acc, e.nutrients), null);
  }

  /** Today's full metrics/daily-values.js status list — every DV-tracked
   *  nutrient's amount/%DV against this rider's own targets (personalized
   *  wherever profile/BMR supports it, flat FDA label value otherwise;
   *  see that file's own doc comment). The one call charts/macro-pie.js's
   *  "Today's focus" overview computes internally to render its chips/
   *  badges, and _applySearchResults() below computes independently off
   *  the same two inputs (todayTotals + targetKcal) to drive the
   *  Log-food smart filter — same inputs into the same pure function, so
   *  a rider never sees the overview and the search results disagree on
   *  what's short today. */
  _currentNutrientStatus() {
    const bmr = estimateBmr(this._profile);
    const balance = dailyCalorieBalance({ bmr, sessions: this._sessions, diaryEntries: this._diaryEntries });
    return nutrientStatusList(this._todayTotals(), { profile: this._profile, targetKcal: balance.budgetKcal });
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  // ─── Shell + rail ───────────────────────────────────────────────────────

  /** Builds the static header, rail and one empty slot per DIET_CATS
   *  category, once. Every category's content is drawn into its own
   *  `[data-cat-body]` slot by _render(); nothing here reads any state
   *  except which category to open first. */
  _buildShell() {
    this._container.innerHTML = `
      <div class="history-header history-header-compact">
        <h2 class="history-title">Diet</h2>
      </div>
      <div class="md-shell" id="diet-md-shell">
        <nav class="md-rail" aria-label="Diet categories"></nav>
        <div class="md-pane">
          ${DIET_CATS.map(([cat, label, icon]) => `
            <section class="md-cat" data-cat="${cat}" data-label="${label}" data-icon="${icon}">
              <div class="diet-tiles" data-cat-body="${cat}"></div>
            </section>
          `).join('')}
        </div>
      </div>
    `;
    // MasterDetailRail's own constructor selects the first category before
    // this assignment lands — _onRailSelect() ignores that call (this._rail
    // is still null), and the select() below then syncs to whichever view
    // is actually active (a no-op when it's the first).
    this._rail = new MasterDetailRail(this._container.querySelector('#diet-md-shell'), {
      onSelect: (cat) => this._onRailSelect(cat),
    });
    if (this._activeView !== DIET_CATS[0][0]) this._rail.select(this._activeView);
  }

  /** MasterDetailRail's onSelect. A rider tapping a rail item lands here
   *  after the rail has already swapped which pane is visible; this fills
   *  that pane. Ignores re-taps of the active item and the rail's own
   *  initial select() during construction. */
  _onRailSelect(cat) {
    if (!this._rail || cat === this._activeView) return;
    this._showView(cat);
  }

  /** The one way to change category — from a rail tap (via _onRailSelect()),
   *  or in code (focusLogFood()).
   *  Draft state that only made sense inside the category being left
   *  (an open log sheet, a half-typed search, an expanded card) is
   *  dropped, same reset the old Today/Recipes/History switch did. */
  _showView(cat) {
    if (this._rail && this._activeView === cat) return;
    this._resetTransient();
    this._activeView = cat;
    this._rail?.select(cat);   // idempotent: _onRailSelect() sees the view already set and does nothing
    this._render();
  }

  _resetTransient() {
    this._searchQuery = '';
    this._searchResults = [];
    this._lastIngredientMatches = [];
    this._lastRecipeMatches = [];
    this._searchFocus = null;
    this._smartFilterNote = null;
    this._isBrowsingFocus = false;
    this._expandedEntryId = null;
    this._expandedHistoryDate = null;
    this._ingredientQuery = '';
    this._logSheet.close();   // a half-filled log belongs to the category it was opened from
  }

  /** Re-draws the active category only (the rail and every other
   *  category's slot are left alone — hidden slots are emptied instead of
   *  kept, so ids like #diet-macro-pie can never appear twice). */
  _render() {
    if (!this._rail) this._buildShell();

    const view = this._activeView;
    const isToday = view === 'today';
    let bmr = null, balance = null;
    if (isToday) {
      bmr = estimateBmr(this._profile);
      balance = dailyCalorieBalance({ bmr, sessions: this._sessions, diaryEntries: this._diaryEntries });
    }

    for (const [cat] of DIET_CATS) {
      if (cat !== view) {
        const other = this._container.querySelector(`[data-cat-body="${cat}"]`);
        if (other) other.innerHTML = '';
      }
    }
    const body = this._container.querySelector(`[data-cat-body="${view}"]`);
    if (!body) return;
    body.innerHTML = isToday ? this._renderToday(bmr, balance)
      : view === 'recipes' ? this._renderRecipesView()
      : view === 'ingredients' ? this._renderIngredientsView()
      : this._renderHistoryView();

    if (isToday) {
      const totals = this._todayTotals();
      const split = macroCalorieSplit(totals);
      const pieEl = this._container.querySelector('#diet-macro-pie');
      // `totals` (the full summed NutrientProfile, not just its kcal
      // split) also drives the legend's fiber/sugar/sodium/vitamin sub
      // rows — see charts/macro-pie.js's `nutrients` option.
      if (pieEl) renderMacroPie(pieEl, { ...split, targetKcal: balance.budgetKcal, nutrients: totals, advancedOpen: this._macroAdvancedOpen, profile: this._profile, smartFilterOn: this._smartFilterOn });
    }

    // Same shrink-to-fit treatment every other .history-card stat grid
    // gets (history-browser.js/overview.js) — a 4-digit KCAL chip
    // shouldn't get cut off. Unconditional now (not just isToday) since
    // Phase 6's History day-expand (_dayExpandContent()) renders these
    // exact same .diet-entry-card chips too; harmless no-op when neither
    // view currently has any on screen.
    fitText(this._container, '.diet-entry-card .stat-val, .diet-entry-card .stat-lbl');

    this._bind();
  }

  _renderToday(bmr, balance) {
    return `
      <section class="settings-card diet-pie-card">
        <div class="macro-pie-wrap">
          <button type="button" class="info-btn macro-pie-info" aria-label="More info about your calorie balance" data-tip="${this._balanceCaption(bmr, balance)}">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
          </button>
          <div id="diet-macro-pie"></div>
        </div>
      </section>
      ${this._quickAddCard()}
      ${this._loggedItemsSection(this._todayEntries())}
    `;
  }

  // ─── History ────────────────────────────────────────────────────────────

  /** Non-today diary entries grouped by calendar day (today has its own
   *  tab — see _todayEntries()), most-recent-day-first. Each group's
   *  `totals` runs through the exact same sumNutrients()/macroCalorieSplit()
   *  pipeline _todayTotals()/_renderToday() already use for the Today
   *  pie, so a day row's kcal/macro-split bar is computed the same way
   *  the Today tab's own numbers are — just aggregated over a whole day
   *  of entries instead of read off a running total. */
  _pastDayGroups() {
    const todayStr = new Date().toDateString();
    const byDay = new Map(); // dateStr (toDateString()) -> DiaryEntry[]
    for (const e of this._diaryEntries) {
      const dayStr = new Date(e.loggedAt).toDateString();
      if (dayStr === todayStr) continue;
      if (!byDay.has(dayStr)) byDay.set(dayStr, []);
      byDay.get(dayStr).push(e);
    }
    return [...byDay.entries()]
      .map(([key, entries]) => {
        entries.sort((a, b) => b.loggedAt - a.loggedAt);
        return {
          key,
          date: new Date(entries[0].loggedAt),
          entries,
          totals: entries.reduce((acc, e) => sumNutrients(acc, e.nutrients), null),
        };
      })
      .sort((a, b) => b.date - a.date);
  }

  _renderHistoryView() {
    const groups = this._pastDayGroups();
    if (!groups.length) {
      return _emptyCard({
        ghost: 'entry',
        title: 'No past days yet',
        line: "Once today rolls over to tomorrow, it'll show up here.",
      });
    }
    // Same .history-list shell history-browser.js's session list uses —
    // reads as "this app's history list" rather than a new pattern, per
    // DIET_PANEL_DESIGN.md §9.
    return `<div class="history-list diet-history-list">${groups.map(g => this._dayCard(g)).join('')}</div>`;
  }

  /** One past day's row — collapsed: date, total kcal, and a small
   *  macro-split bar (see _macroSplitBar()); expanded: that day's full
   *  log via _dayExpandContent(). Same .history-item/.history-card/
   *  .history-expand accordion shell history-browser.js's _sessionItem()
   *  uses for a session, just keyed by day-string instead of array index
   *  since diary entries — unlike sessions — don't already come with a
   *  stable per-item index this view fetches independently of load(). */
  _dayCard(group) {
    const split = macroCalorieSplit(group.totals);
    const kcal = Math.round(split.proteinKcal + split.carbsKcal + split.fatKcal);
    const dateLabel = group.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const entryCountLabel = `${group.entries.length} item${group.entries.length === 1 ? '' : 's'} logged`;
    const expanded = this._expandedHistoryDate === group.key;

    return `
      <div class="history-item" data-history-date="${_esc(group.key)}">
        <div class="history-card diet-history-day-card ${expanded ? 'expanded' : ''}" role="button" tabindex="0" aria-expanded="${expanded}">
          <div class="history-card-header">
            <div>
              <span class="history-card-name">${_esc(dateLabel)}</span>
              <span class="history-card-date">${entryCountLabel}</span>
            </div>
            <div class="history-card-actions">
              <span class="diet-day-kcal">${kcal} kcal</span>
              <span class="history-expand-icon" aria-hidden="true"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-chevron-down"/></svg></span>
            </div>
          </div>
          <div class="history-card-stats diet-day-stats">${this._macroSplitBar(split)}</div>
        </div>
        <div class="history-expand" ${expanded ? '' : 'hidden'}>${expanded ? this._dayExpandContent(group) : ''}</div>
      </div>
    `;
  }

  /** Thin 3-segment strip standing in for the Today pie at day-row scale
   *  (a full donut per row would be too much chrome in a scrolling list) —
   *  same --color-protein/-carbs/-fat tokens, segment widths straight from
   *  the same macroCalorieSplit() percentages the pie's legend already
   *  shows. Degrades to a flat empty-colored strip on a day with entries
   *  that all zeroed out (e.g. every ingredient on that day was since
   *  deleted), same "never divide by zero" guard _entryItem() doesn't need
   *  but the pie chart's empty state already established the pattern for. */
  _macroSplitBar(split) {
    const total = split.proteinKcal + split.carbsKcal + split.fatKcal;
    if (total <= 0) return `<div class="diet-macro-bar diet-macro-bar-empty"></div>`;
    const segs = [
      ['protein', '--color-protein', split.proteinKcal],
      ['carbs',   '--color-carbs',   split.carbsKcal],
      ['fat',     '--color-fat',     split.fatKcal],
    ];
    const label = segs.map(([key, , kcal]) => `${Math.round((kcal / total) * 100)}% ${key}`).join(', ');
    return `
      <div class="diet-macro-bar" role="img" aria-label="Macro split: ${_esc(label)}">
        ${segs.map(([, colorVar, kcal]) =>
          kcal > 0 ? `<span class="diet-macro-bar-seg" style="width:${(kcal / total) * 100}%; background:var(${colorVar})"></span>` : ''
        ).join('')}
      </div>
    `;
  }

  /** A day's full log — _entryItem() as-is, fed this group's entries
   *  instead of _todayEntries()'s. A diary entry doesn't stop being
   *  editable just because the day it was logged on has already ended,
   *  so this deliberately reuses the exact tap-to-edit-amount/delete
   *  component the Today tab uses rather than a second, read-only
   *  variant of the same row — see _bindHistory() for the matching
   *  bindings. */
  _dayExpandContent(group) {
    return `<div class="diet-logged-list diet-history-entries">${group.entries.map(e => this._entryItem(e)).join('')}</div>`;
  }

  // ─── Recipes ─────────────────────────────────────────────────────────────

  /** Cuisine tags actually in play right now — every bundled preset's tag
   *  plus whatever the rider's own saved recipes happen to use (a saved
   *  recipe can carry a cuisine that isn't a preset pack yet, per
   *  ui/recipe-editor.js's KNOWN_CUISINES comment) — so the filter row
   *  never shows a tag with nothing behind it, and never hides one either. */
  // ─── Ingredients ────────────────────────────────────────────────────────

  /** The Ingredients rail category — a browse of the whole ingredient
   *  database (the rider's custom entries first, then the bundled set
   *  A→Z) as the plan's kcal-per-100g tiles: name, a big instrument-style
   *  readout, and a tick bar scaled against ~950 kcal (pure oil). The
   *  search box filters the pool in memory (this._ingredientPool, kept
   *  fresh by load()), and tapping a tile opens that ingredient in
   *  the log sheet — the same amount form a search-result tap opens —
   *  since browsing food is only useful if you can log it from there. */
  _renderIngredientsView() {
    return `
      <section class="settings-card diet-recipes-actions">
        <button type="button" class="btn btn-ghost full-width diet-new-custom-ingredient">+ Custom Ingredient</button>
      </section>
      <section class="settings-card">
        <input type="text" class="input diet-ingredient-search-input" placeholder="Search ingredients…"
               aria-label="Search ingredients" value="${_esc(this._ingredientQuery)}" autocomplete="off">
      </section>
      <div id="diet-ingredients-grid">${this._renderIngredientTiles()}</div>
    `;
  }

  /** The tile grid alone, split out (like _renderRecipesLists()) so a
   *  keystroke can patch just this wrapper without a full _render()
   *  stealing focus from the search box. */
  _renderIngredientTiles() {
    const q = this._ingredientQuery.trim().toLowerCase();
    const isCustom = (ing) => String(ing.id ?? '').startsWith('custom:');
    const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
    const matches = q
      ? this._ingredientPool.filter(ing =>
          String(ing.name ?? '').toLowerCase().includes(q) || String(ing.brand ?? '').toLowerCase().includes(q))
      : this._ingredientPool;

    if (!matches.length) {
      return q
        ? _emptyCard({
            ghost: 'ingredient',
            title: 'No matches',
            line: `Nothing matches "${_esc(this._ingredientQuery.trim())}".`,
            action: `<button type="button" class="btn btn-ghost full-width diet-ingredient-add-custom">+ Add "${_esc(this._ingredientQuery.trim())}" as a custom ingredient</button>`,
          })
        : _emptyCard({ ghost: 'ingredient', title: 'No ingredients', line: 'There are no ingredients to show yet.' });
    }
    const ordered = [...matches.filter(isCustom).sort(byName), ...matches.filter(ing => !isCustom(ing)).sort(byName)];
    return `<div class="diet-ingredient-tiles">${ordered.map(ing => this._ingredientTile(ing)).join('')}</div>`;
  }

  _ingredientTile(ing) {
    const kcal = Math.round(ing.perHundredG?.calories ?? 0);
    const unit = ing.densityGPerMl != null ? 'mL' : 'g';   // same rule _ingredientSearchResultRow() uses
    const fill = Math.max(4, Math.min(95, Math.round(kcal / 9.5)));
    const custom = String(ing.id ?? '').startsWith('custom:');
    return `
      <button type="button" class="diet-ing-tile" data-ingredient-id="${_esc(ing.id)}">
        <span class="diet-ing-name">${_esc(ing.name)}${ing.brand ? ` <span class="diet-ing-brand">· ${_esc(ing.brand)}</span>` : ''}${custom ? ' <span class="diet-ing-badge">Custom</span>' : ''}</span>
        <span class="diet-ing-kcal"><span class="diet-ing-num">${kcal}</span><small>kcal/100${unit}</small></span>
        <span class="diet-ing-ticks" style="--fill:${fill}%" aria-hidden="true"></span>
      </button>
    `;
  }

  _updateIngredientsDom() {
    const el = this._container.querySelector('#diet-ingredients-grid');
    if (!el) return;
    el.innerHTML = this._renderIngredientTiles();
    this._bindIngredientTiles();
  }

  _bindIngredients() {
    this._container.querySelector('.diet-new-custom-ingredient')?.addEventListener('click', () => this._addCustomIngredientFromBrowse(''));
    this._container.querySelector('.diet-ingredient-search-input')?.addEventListener('input', (e) => {
      this._ingredientQuery = e.target.value;
      this._updateIngredientsDom();
    });
    this._bindIngredientTiles();
  }

  _bindIngredientTiles() {
    this._container.querySelectorAll('.diet-ing-tile').forEach(btn =>
      btn.addEventListener('click', () => this._logIngredientFromBrowse(btn.dataset.ingredientId))
    );
    this._container.querySelector('.diet-ingredient-add-custom')?.addEventListener('click', () =>
      this._addCustomIngredientFromBrowse(this._ingredientQuery.trim())
    );
  }

  /** Opens the shared custom-ingredient editor; on save, refreshes the
   *  pool so the new tile shows up straight away (app.js's editor
   *  callback only resolves with the saved ingredient — it doesn't reload
   *  the Diet tab itself). A cancel resolves null and changes nothing. */
  async _addCustomIngredientFromBrowse(prefillName) {
    const created = await this._onAddCustomIngredient?.(prefillName);
    if (!created) return;
    this._ingredientPool = await this._repo.all?.() ?? this._ingredientPool;
    if (this._activeView === 'ingredients') this._updateIngredientsDom();
  }

  /** A tile tap: opens the log sheet for that ingredient, right where the rider is — no jump to Today. */
  _logIngredientFromBrowse(id) {
    const ingredient = this._ingredientPool.find(ing => ing.id === id);
    if (!ingredient) return;
    this._logSheet.openIngredient(ingredient);
  }

  _availableCuisines() {
    const tags = new Set(recipeRepository.cuisines());
    for (const r of this._recipes) if (r.cuisine) tags.add(r.cuisine);
    return [...tags].sort();
  }

  _renderRecipesView() {
    const cuisines = this._availableCuisines();
    return `
      <section class="settings-card diet-recipes-actions">
        <button type="button" class="btn btn-primary full-width diet-new-recipe">+ New Recipe</button>
        <button type="button" class="btn btn-ghost full-width diet-new-custom-ingredient">+ Custom Ingredient</button>
      </section>
      ${this._renderRecipesSearchBar(cuisines)}
      <div id="diet-recipes-lists">${this._renderRecipesLists()}</div>
    `;
  }

  /** My Recipes + Preset Recipes lists, split out from _renderRecipesView()
   *  so a keystroke in the search box (_bindRecipes()'s input handler)
   *  can patch just this wrapper via _updateRecipesListDom() instead of a
   *  full _render() that would steal focus back out of the box the rider
   *  is actively typing in — same reasoning _bindToday()'s own search
   *  input gives for _updateSearchResultsDom(). */
  _renderRecipesLists() {
    const active = this._activeFilterCount();
    const hasQuery = this._recipeSearchQuery.trim().length > 0;
    const anyActive = active > 0 || hasQuery;
    const filterLabel = anyActive ? ' matching these filters' : '';
    const myRecipes = this._sortRecipes(this._recipes.filter(r => this._recipeMatchesFilters(r)));
    const presets = this._sortRecipes(recipeRepository.presets.filter(p => this._recipeMatchesFilters(p)));

    return `
      <section class="diet-recipes-section">
        <h2 class="settings-title diet-logged-title">My Recipes</h2>
        ${myRecipes.length
          ? `<div class="diet-recipes-list">${myRecipes.map(r => this._recipeCard(r, { isPreset: false })).join('')}</div>`
          : _emptyCard({
              ghost: 'entry',
              title: `No saved recipes${filterLabel}`,
              line: `${anyActive ? 'Try clearing a filter, or build' : 'Build'} one with "+ New Recipe", or save a preset below.`,
            })}
      </section>
      <section class="diet-recipes-section">
        <h2 class="settings-title diet-logged-title">Preset Recipes</h2>
        ${presets.length
          ? `<div class="diet-recipes-list">${presets.map(p => this._recipeCard(p, { isPreset: true })).join('')}</div>`
          : _emptyCard({
              ghost: 'entry',
              title: `No preset recipes${filterLabel}`,
              line: anyActive ? 'Try clearing a filter or the search.' : 'There are no preset recipes to show.',
            })}
      </section>
    `;
  }

  _updateRecipesListDom() {
    const el = this._container.querySelector('#diet-recipes-lists');
    if (!el) return;
    el.innerHTML = this._renderRecipesLists();
    this._bindRecipeCards();
  }

  /** A name-or-ingredient search (see _recipeMatchesFilters()/
   *  _recipeMatchesQuery()) next to a funnel icon button that expands the
   *  same region/cuisine + calorie-band +
   *  nutrition-profile chip panel a "Filters" label toggle used to open —
   *  icon-only now that the label's gone, so the active-filter count
   *  badge moved onto the button itself (style.css's .diet-filter-count
   *  comment). Same "re-render replaces innerHTML" reasoning as before
   *  means _filterMenuOpen stays plain toggled state rather than a
   *  native <details open>. Closed by default so a rider who only wants
   *  the search box doesn't have three chip rows in the way. */
  _renderRecipesSearchBar(cuisines) {
    const open = this._filterMenuOpen;
    const active = this._activeFilterCount();
    return `
      <section class="settings-card">
        <div class="diet-filter-header">
          <input type="text" class="input diet-recipe-search-input" placeholder="Search recipes or ingredients…"
                 value="${_esc(this._recipeSearchQuery)}" autocomplete="off">
          <button type="button" class="diet-filter-toggle ${active ? 'active' : ''}" aria-expanded="${open}"
                  aria-controls="diet-filter-body" aria-label="Filters" title="Filters">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-filter"/></svg>
            ${active ? `<span class="diet-filter-count">${active}</span>` : ''}
          </button>
          ${active ? `<button type="button" class="btn btn-ghost btn-sm diet-filter-clear-all">Clear</button>` : ''}
        </div>
        ${open ? this._filterMenuBody(cuisines) : ''}
      </section>
    `;
  }

  _filterMenuBody(cuisines) {
    const f = this._recipeFilters;
    return `
      <div class="diet-filter-body" id="diet-filter-body">
        ${cuisines.length ? `
          <div class="diet-filter-group">
            <span class="diet-filter-group-label">Region / Cuisine</span>
            <div class="diet-filter-chips" role="group" aria-label="Filter by cuisine">
              <button type="button" class="diet-filter-chip ${f.cuisines.size === 0 ? 'active' : ''}" data-cuisine="">All</button>
              ${cuisines.map(c => `
                <button type="button" class="diet-filter-chip ${f.cuisines.has(c) ? 'active' : ''}" data-cuisine="${_esc(c)}">${_esc(_titleCase(c))}</button>
              `).join('')}
            </div>
          </div>
        ` : ''}
        <div class="diet-filter-group">
          <span class="diet-filter-group-label">Calories per serving</span>
          <div class="diet-filter-chips" role="group" aria-label="Filter by calories per serving">
            ${Object.entries(CALORIE_BANDS).map(([key, band]) => `
              <button type="button" class="diet-filter-chip ${f.calorieBand === key ? 'active' : ''}" data-calorie-band="${key}" title="${_esc(band.hint)}">${_esc(band.label)}</button>
            `).join('')}
          </div>
        </div>
        <div class="diet-filter-group">
          <span class="diet-filter-group-label">Nutrition profile</span>
          <div class="diet-filter-chips" role="group" aria-label="Filter by nutrition profile">
            ${Object.entries(NUTRITION_FILTERS).map(([key, nf]) => `
              <button type="button" class="diet-filter-chip ${f.nutrition.has(key) ? 'active' : ''}" data-nutrition="${key}" title="${_esc(nf.hint)}">${_esc(nf.label)}</button>
            `).join('')}
          </div>
        </div>
        <div class="diet-filter-group">
          <label class="diet-filter-group-label" for="diet-recipe-sort">Sort by</label>
          <select id="diet-recipe-sort" class="input diet-sort-select">
            ${Object.entries(RECIPE_SORTS).map(([key, label]) => `
              <option value="${key}" ${this._recipeSort === key ? 'selected' : ''}>${_esc(label)}</option>
            `).join('')}
          </select>
        </div>
      </div>
    `;
  }

  _activeFilterCount() {
    const f = this._recipeFilters;
    return f.cuisines.size + f.nutrition.size + (f.calorieBand ? 1 : 0);
  }

  /** Same total _recipeCard()'s KCAL chip shows — see CALORIE_BANDS'
   *  comment on why this reads macroCalorieSplit() rather than
   *  perServing.calories directly. */
  _recipeKcal(recipe) {
    const split = macroCalorieSplit(recipe.perServing);
    return split.proteinKcal + split.carbsKcal + split.fatKcal;
  }

  _recipeMatchesFilters(recipe) {
    const f = this._recipeFilters;
    const q = this._recipeSearchQuery.trim().toLowerCase();
    if (q && !this._recipeMatchesQuery(recipe, q)) return false;
    if (f.cuisines.size && !f.cuisines.has(recipe.cuisine)) return false;
    if (f.calorieBand && !CALORIE_BANDS[f.calorieBand].test(this._recipeKcal(recipe))) return false;
    if (f.nutrition.size) {
      // No perServing data to test against (e.g. every ingredient line was
      // since deleted) — exclude rather than guess whether it'd match.
      if (!recipe.perServing) return false;
      for (const key of f.nutrition) {
        if (!NUTRITION_FILTERS[key].test(recipe.perServing)) return false;
      }
    }
    return true;
  }

  /** A recipe matches the Recipes tab's search box either by its own name
   *  (the original behavior) or by any ingredient it's made from — typing
   *  "paneer" turns up a curry recipe by that name, but now also any
   *  recipe that simply *contains* paneer, the same way a rider would
   *  search a cookbook's index. Resolved ingredient names come from
   *  _ingredientById (populated once per load() by
   *  _resolveRecipeIngredientNames()) rather than a live repo lookup here,
   *  since this runs inside a synchronous .filter() on every keystroke
   *  (_updateRecipesListDom()) alongside every other recipe in the list. */
  _recipeMatchesQuery(recipe, q) {
    if ((recipe.name ?? '').toLowerCase().includes(q)) return true;
    return (recipe.ingredients ?? []).some(line => {
      const ingredient = this._ingredientById.get(line.ingredientId);
      return !!ingredient && ingredient.name.toLowerCase().includes(q);
    });
  }

  _sortRecipes(recipes) {
    const sort = this._recipeSort;
    if (sort === 'default') return recipes;
    return [...recipes].sort((a, b) => {
      if (sort === 'calories-asc')  return this._recipeKcal(a) - this._recipeKcal(b);
      if (sort === 'calories-desc') return this._recipeKcal(b) - this._recipeKcal(a);
      if (sort === 'protein-desc')  return (b.perServing?.protein ?? 0) - (a.perServing?.protein ?? 0);
      return 0;
    });
  }

  /** One recipe row — a saved recipe (tap to edit, trash to delete) or a
   *  bundled preset (a "Save" button clones it into the recipe editor;
   *  the card itself isn't tap-to-open, since there's nothing to edit in
   *  place on a preset — see DIET_PANEL_DESIGN.md §4). Both shapes carry
   *  a precomputed `perServing` (recipe-editor.js recomputes it on every
   *  save; presets ship it precomputed in their JSON), so this reads the
   *  same macroCalorieSplit() math _entryItem() already uses for a diary
   *  entry — same stat-chip visual language either way. */
  _recipeCard(recipe, { isPreset }) {
    const split = macroCalorieSplit(recipe.perServing);
    const kcal    = Math.round(split.proteinKcal + split.carbsKcal + split.fatKcal);
    const protein = Math.round(split.proteinKcal / 4);
    const carbs   = Math.round(split.carbsKcal / 4);
    const fat     = Math.round(split.fatKcal / 9);
    const servingsLabel = `${recipe.servings} serving${recipe.servings === 1 ? '' : 's'}`;
    // No perServing to scale (e.g. every ingredient line was since
    // deleted) — same "exclude rather than guess" rule
    // _recipeMatchesFilters() already applies to the nutrition-profile
    // filter chips for this exact case.
    const canLog = recipe.perServing != null;

    return `
      <div class="history-item" data-recipe-id="${_esc(String(recipe.id))}" data-is-preset="${isPreset ? '1' : '0'}">
        <div class="history-card diet-recipe-card" ${isPreset ? '' : 'role="button" tabindex="0"'}>
          <div class="history-card-header">
            <div>
              <span class="history-card-name">${_esc(recipe.name)}</span>
              <span class="history-card-date">${recipe.cuisine ? `<span class="diet-cuisine-badge">${_esc(_titleCase(recipe.cuisine))}</span> · ` : ''}${servingsLabel}</span>
            </div>
            <div class="history-card-actions">
              <button type="button" class="btn btn-ghost btn-sm diet-recipe-log" ${canLog ? '' : 'disabled title="Add ingredients to this recipe to log it"'}>Log</button>
              <button type="button" class="diet-recipe-print btn btn-ghost btn-sm" title="Print recipe" aria-label="Print recipe">
                <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-print"/></svg>
              </button>
              ${isPreset
                ? `<button type="button" class="btn btn-ghost btn-sm diet-recipe-save">Save</button>`
                : `<button type="button" class="diet-recipe-delete btn btn-ghost btn-sm" title="Delete" aria-label="Delete"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>`}
            </div>
          </div>
          <div class="history-card-stats">
            <div class="stat-chip" data-metric="calories"><span class="stat-val">${kcal}</span><span class="stat-lbl">KCAL</span></div>
            <div class="stat-chip" data-metric="protein"><span class="stat-val">${protein}</span><span class="stat-lbl">PROTEIN (G)</span></div>
            <div class="stat-chip" data-metric="carbs"><span class="stat-val">${carbs}</span><span class="stat-lbl">CARBS (G)</span></div>
            <div class="stat-chip" data-metric="fat"><span class="stat-val">${fat}</span><span class="stat-lbl">FAT (G)</span></div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Today: calorie balance ─────────────────────────────────────────────

  // Same copy the old loose .settings-sub caption under the chart used to
  // show — now the data-tip on the circled-i badge in the pie's top-left
  // corner (ux/info-tooltip.js renders data-tip as plain text, so no
  // <strong>/color-coded deficit-vs-surplus span here; the tooltip just
  // says which one it is in words).
  _balanceCaption(bmr, balance) {
    if (bmr == null) {
      return `Add your age, sex, height, and weight in Settings → Profile to see a calorie budget here. ${Math.round(balance.loggedKcal)} kcal logged so far today.`;
    }
    const deficit = balance.balanceKcal >= 0;
    return `Budget ${Math.round(balance.budgetKcal)} kcal (BMR + ${Math.round(balance.exerciseKcal)} kcal exercise) − ${Math.round(balance.loggedKcal)} kcal logged = ${Math.round(Math.abs(balance.balanceKcal))} kcal ${deficit ? 'deficit' : 'surplus'}.`;
  }

  // ─── Today: quick-add ───────────────────────────────────────────────────

  _quickAddCard() {
    return `
      <section class="settings-card diet-quickadd-card">
        <h2 class="settings-title">Log food</h2>
        <input type="text" class="input diet-search-input" placeholder="Search ingredients or recipes…"
               value="${_esc(this._searchQuery)}" autocomplete="off">
        <div class="diet-search-results" id="diet-search-results">${this._renderSearchResults()}</div>
      </section>
    `;
  }

  /** A blank query normally means "nothing to show yet" — same as
   *  before this method grew a second, query-less case. While the Smart
   *  filter is on, a blank query instead means "browsing
   *  _loadFocusSuggestions()'s full-pool suggestions", which needs its own
   *  handling here: no "No matches"/"+ Add as custom" empty state (there's
   *  no typed query to prefill that button with, or to have failed to
   *  match), a genuinely-empty render while that async .all() round trip
   *  is still in flight (this._searchResults is whatever it was on the
   *  last render — `[]` the very first time — until
   *  _loadFocusSuggestions() resolves and patches the dropdown itself;
   *  see _updateSearchResultsDom()), and — since _applySearchResults()
   *  now ranks up to 10 of *each* kind for this browse case rather than
   *  the tighter 5-ingredient/3-recipe cap a typed query gets (see that
   *  method's own doc comment) — two separately-labeled top-10 groups
   *  instead of one flat mixed list, so "10 recipes and 10 ingredients"
   *  reads as two clear rankings rather than 20 items blurred together. */
  _renderSearchResults() {
    const hasQuery = this._searchQuery.trim().length > 0;
    if (!hasQuery && !this._smartFilterOn) return '';
    if (!hasQuery && !this._searchResults.length) return '';

    if (hasQuery && !this._searchResults.length) {
      const q = this._searchQuery.trim();
      return `
        <div class="diet-search-empty">
          <p class="settings-sub">No matches for "${_esc(q)}".</p>
          <button type="button" class="btn btn-ghost btn-sm diet-add-custom">+ Add "${_esc(q)}" as a custom ingredient</button>
        </div>
      `;
    }

    if (!hasQuery) {
      // Browsing the Smart filter's full-pool suggestions — recipes
      // first (a whole meal is the more actionable "catch up on X" move)
      // then ingredients, each its own top-10 ranked by
      // metrics/daily-values.js#rankRecipesForFocus()/
      // rankIngredientsForFocus(), same ranking a typed search's results
      // go through, just uncapped down to 10 apiece instead of 3/5 (see
      // _applySearchResults()).
      const recipes = this._searchResults.filter(r => r.kind === 'recipe');
      const ingredients = this._searchResults.filter(r => r.kind === 'ingredient');
      return `
        ${this._smartFilterNote ? `<p class="diet-search-empty-note">${_esc(this._smartFilterNote)}</p>` : ''}
        ${recipes.length ? `
          <p class="diet-search-suggested-label">Top ${recipes.length} recipes for today's focus</p>
          ${recipes.map(r => this._recipeSearchResultRow(r.item, this._searchFocus)).join('')}
        ` : ''}
        ${ingredients.length ? `
          <p class="diet-search-suggested-label">Top ${ingredients.length} ingredients for today's focus</p>
          ${ingredients.map(r => this._ingredientSearchResultRow(r.item, this._searchFocus)).join('')}
        ` : ''}
      `;
    }

    // Typed query — capped to 5 ingredient hits + 3 recipe hits (8 total)
    // by _applySearchResults() — this is a quick-add dropdown, not the
    // eventual Recipes-tab browser; both repositories already sort their
    // own custom/saved entries first (see ingredient-repository.js#search()/
    // #all()/recipe-repository.js#search()/#all()), and _applySearchResults()
    // re-sorts both halves on top of that whenever the Smart filter is on.
    return `
      ${this._smartFilterNote ? `<p class="diet-search-empty-note">${_esc(this._smartFilterNote)}</p>` : ''}
      ${this._searchResults.map(result =>
        result.kind === 'recipe' ? this._recipeSearchResultRow(result.item, this._searchFocus) : this._ingredientSearchResultRow(result.item, this._searchFocus)
      ).join('')}
    `;
  }

  /** @param {Object|null} focus  _applySearchResults()'s focusNutrients()
   *  list while the Smart filter is on, else null — the same list its own
   *  ranking scored this ingredient against, so a "High in X" tag here
   *  never names a nutrient the filter itself wasn't weighing. Only ever
   *  populated while the filter is on (see style.css's
   *  .diet-search-result-focus-tag doc comment); a plain result renders
   *  the exact same .diet-search-result-main wrapper with just the name
   *  inside. */
  _ingredientSearchResultRow(ing, focus) {
    const match = focus ? bestFocusMatch(ing.perHundredG, focus) : null;
    return `
      <button type="button" class="diet-search-result" data-ingredient-id="${_esc(ing.id)}">
        <span class="diet-search-result-main">
          <span class="diet-search-result-name">${_esc(ing.name)}${ing.brand ? ` <span class="diet-search-result-brand">· ${_esc(ing.brand)}</span>` : ''}</span>
          ${match ? `<span class="diet-search-result-focus-tag">High in ${_esc(match.label)}</span>` : ''}
        </span>
        <span class="diet-search-result-kcal">${Math.round(ing.perHundredG?.calories ?? 0)} kcal/100${ing.densityGPerMl != null ? 'mL' : 'g'}</span>
      </button>
    `;
  }

  /** A recipe hit in the Today quick-add search — same row shape as an
   *  ingredient hit (name on the left, a kcal figure on the right), badged
   *  "Recipe" so it doesn't read as just another ingredient, and priced
   *  per serving rather than per 100g/mL since a recipe has no per-100g
   *  figure to show (same macroCalorieSplit() math _recipeCard()'s KCAL
   *  chip already uses — see _recipeKcal()). data-is-preset carries the
   *  same string-vs-number id cast _bindRecipes() already uses elsewhere
   *  in this file, since a recipe id is only reliably typed once you know
   *  which store it came from. Picking one opens the log sheet
   *  (views/diet-log-sheet.js), the same servings-based sheet the Recipes tab's own "Log" button
   *  opens, instead of the ingredient sheet's weight/volume/size controls; see _selectRecipeFromSearch().
   *
   *  @param {Object|null} focus  Same focusNutrients() list
   *  _ingredientSearchResultRow() takes, while the Smart filter is on —
   *  a recipe hit gets the identical "High in X" tag (via bestFocusMatch()
   *  against its own perServing profile, the same reference amount
   *  rankRecipesForFocus() scored it against in _applySearchResults()),
   *  in the same .diet-search-result-main wrapper the ingredient row
   *  uses, so the two kinds of result read as one consistent list. */
  _recipeSearchResultRow(recipe, focus) {
    const match = focus ? bestFocusMatch(recipe.perServing, focus) : null;
    const kcal = Math.round(this._recipeKcal(recipe));
    return `
      <button type="button" class="diet-search-result diet-search-result-recipe"
              data-recipe-result-id="${_esc(String(recipe.id))}" data-is-preset="${typeof recipe.id === 'string' ? '1' : '0'}">
        <span class="diet-search-result-main">
          <span class="diet-search-result-name"><span class="diet-recipe-badge">Recipe</span>${_esc(recipe.name)}</span>
          ${match ? `<span class="diet-search-result-focus-tag">High in ${_esc(match.label)}</span>` : ''}
        </span>
        <span class="diet-search-result-kcal">${kcal} kcal/serving</span>
      </button>
    `;
  }

  // ─── Today: logged items ────────────────────────────────────────────────

  _loggedItemsSection(entries) {
    if (!entries.length) {
      return `
        <section class="diet-logged-section">
          <h2 class="settings-title diet-logged-title">Today's Log</h2>
          ${_emptyCard({
            ghost: 'entry',
            title: 'Nothing logged yet today',
            line: 'Search above to add your first item.',
            clearRail: true,
          })}
        </section>
      `;
    }
    return `
      <section class="diet-logged-section">
        <h2 class="settings-title diet-logged-title">Today's Log</h2>
        <div class="diet-logged-list">${entries.map(e => this._entryItem(e)).join('')}</div>
      </section>
    `;
  }

  _entryItem(entry) {
    const isRecipe = entry.source?.type === 'recipe';
    const resolved = isRecipe ? this._recipeById.get(entry.source?.id) : this._ingredientById.get(entry.source?.id);
    const name = resolved?.name ?? (isRecipe ? 'Removed recipe' : 'Removed ingredient');
    const n = entry.nutrients;
    const kcal    = Math.round(n?.calories ?? 0);
    const protein = Math.round(n?.protein ?? 0);
    const carbs   = Math.round(n?.carbs?.total ?? 0);
    const fat     = Math.round(n?.fat?.total ?? 0);
    const units = this._profile.units;
    const amountLabel = isRecipe
      ? (entry.source?.servings != null
          ? `${_round1(entry.source.servings)} serving${entry.source.servings === 1 ? '' : 's'}`
          : null)
      : (entry.source?.amountG != null
          ? `${_round1(gToDisplayWeight(entry.source.amountG, units))} ${smallWeightUnitLabel(units)}`
          : null);
    const timeStr = new Date(entry.loggedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const mealLabel = MEAL_SLOT_LABELS[entry.mealSlot] ?? 'Snack';
    const expanded = this._expandedEntryId === entry.id;

    return `
      <div class="history-item" data-entry-id="${entry.id}">
        <div class="history-card diet-entry-card ${expanded ? 'expanded' : ''}" role="button" tabindex="0" aria-expanded="${expanded}">
          <div class="history-card-header">
            <div>
              <span class="history-card-name">${_esc(name)}</span>
              <span class="history-card-date">${mealLabel}${amountLabel ? ` · ${amountLabel}` : ''} · ${timeStr}</span>
            </div>
            <div class="history-card-actions">
              <button class="diet-entry-delete btn btn-ghost" title="Delete" aria-label="Delete"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>
              <span class="history-expand-icon" aria-hidden="true"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-chevron-down"/></svg></span>
            </div>
          </div>
          <div class="history-card-stats">
            <div class="stat-chip" data-metric="calories"><span class="stat-val">${kcal}</span><span class="stat-lbl">KCAL</span></div>
            <div class="stat-chip" data-metric="protein"><span class="stat-val">${protein}</span><span class="stat-lbl">PROTEIN (G)</span></div>
            <div class="stat-chip" data-metric="carbs"><span class="stat-val">${carbs}</span><span class="stat-lbl">CARBS (G)</span></div>
            <div class="stat-chip" data-metric="fat"><span class="stat-val">${fat}</span><span class="stat-lbl">FAT (G)</span></div>
          </div>
        </div>
        <div class="history-expand" ${expanded ? '' : 'hidden'}>${expanded ? this._entryEditForm(entry, resolved) : ''}</div>
      </div>
    `;
  }

  /** Edit-amount for an ingredient entry is weight-only, regardless of how
   *  the entry was originally logged (weight or volume) — canonical
   *  storage is grams either way (see core/nutrition-model.js §5's "every
   *  amount is resolved to grams" rule), and re-deriving a meaningful
   *  volume amount from a gram figure would need the same density math the
   *  original entry already resolved once; simplest to just let a
   *  correction be typed in the unit the amount is actually stored in,
   *  converted for display. A recipe entry has no weight at all — its
   *  "amount" is the servings count — so its edit form is the servings
   *  field instead, the same kind of input the log sheet uses to log
   *  one in the first place. `resolved` is whichever of
   *  _ingredientById/_recipeById the entry's source.type points at (see
   *  _entryItem()). */
  _entryEditForm(entry, resolved) {
    const isRecipe = entry.source?.type === 'recipe';
    if (!resolved) {
      const kind = isRecipe ? 'recipe' : 'ingredient';
      return `<p class="settings-sub">This ${kind} was removed, so its amount can no longer be recalculated. You can still delete this entry.</p>`;
    }
    if (isRecipe) {
      const value = this._editAmountValue !== '' ? this._editAmountValue : entry.source.servings;
      const n = Number(value);
      return `
        <div class="diet-entry-edit-form">
          <div class="diet-amount-row">
            <input type="number" min="0" step="any" inputmode="decimal" class="input diet-edit-amount-input" value="${_esc(value)}">
            <span class="diet-amount-unit">serving${n === 1 ? '' : 's'}</span>
          </div>
          <button type="button" class="btn btn-primary diet-entry-save">Save amount</button>
        </div>
      `;
    }
    const units = this._profile.units;
    const displayAmount = _round1(gToDisplayWeight(entry.source.amountG, units));
    const value = this._editAmountValue !== '' ? this._editAmountValue : displayAmount;
    return `
      <div class="diet-entry-edit-form">
        <div class="diet-amount-row">
          <input type="number" min="0" step="any" inputmode="decimal" class="input diet-edit-amount-input" value="${_esc(value)}">
          <span class="diet-amount-unit">${smallWeightUnitLabel(units)}</span>
        </div>
        <button type="button" class="btn btn-primary diet-entry-save">Save amount</button>
      </div>
    `;
  }

  // ─── Bind ───────────────────────────────────────────────────────────────

  _bind() {
    if (this._activeView === 'today') this._bindToday();
    else if (this._activeView === 'recipes') this._bindRecipes();
    else if (this._activeView === 'ingredients') this._bindIngredients();
    else if (this._activeView === 'history') this._bindHistory();
  }

  _bindToday() {
    this._container.querySelector('.macro-pie-advanced-toggle')?.addEventListener('click', () => {
      this._macroAdvancedOpen = !this._macroAdvancedOpen;
      this._render();
    });

    this._container.querySelector('.diet-smart-filter-toggle')?.addEventListener('change', (e) => {
      this._smartFilterOn = e.target.checked;
      if (!this._smartFilterOn) {
        // Turning the filter back off drops the browse pool if that's what
        // was on screen (a typed search's own hits are left alone — those
        // stay valid, just unranked/uncapped by focus from here on; see
        // _applySearchResults()) so the dropdown goes back to matching
        // exactly what plain _runSearch() would have shown.
        this._isBrowsingFocus = false;
        if (!this._searchQuery.trim()) {
          this._lastIngredientMatches = [];
          this._lastRecipeMatches = [];
        }
        this._applySearchResults();
        this._updateSearchResultsDom();
      } else if (!this._searchQuery.trim()) {
        this._loadFocusSuggestions();
      } else {
        this._applySearchResults();
        this._updateSearchResultsDom();
      }
    });

    // Re-triggers the Smart filter's "Suggested for today's focus" browse
    // after any Today-tab render where it should be showing but isn't yet
    // loaded — e.g. logging an item (which clears the dropdown, see
    // _clearSearchForLog()) with the
    // filter already on, or switching back to this tab after it was left
    // on. _loadFocusSuggestions() itself no-ops if the filter's off, a
    // query's typed, or a load is already in flight/done — see its own
    // doc comment — so this is a harmless check on every render, not a
    // fetch on every render.
    if (this._smartFilterOn && !this._searchQuery.trim() && !this._isBrowsingFocus) {
      this._loadFocusSuggestions();
    }

    this._container.querySelector('.diet-search-input')?.addEventListener('input', (e) => {
      this._searchQuery = e.target.value;
      this._runSearch(this._searchQuery);
    });

    this._bindSearchResults();

    this._container.querySelectorAll('.diet-entry-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = Number(card.closest('[data-entry-id]').dataset.entryId);
        this._expandedEntryId = this._expandedEntryId === id ? null : id;
        this._editAmountValue = '';
        this._render();
      });
    });

    this._container.querySelectorAll('.diet-entry-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.closest('[data-entry-id]').dataset.entryId);
        if (!confirm('Delete this entry?')) return;
        await db.deleteDiaryEntry(id);
        await this.load();
      });
    });

    const editInput = this._container.querySelector('.diet-edit-amount-input');
    editInput?.addEventListener('click', (e) => e.stopPropagation());
    editInput?.addEventListener('input', (e) => { this._editAmountValue = e.target.value; });

    this._container.querySelector('.diet-entry-save')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this._saveEditedAmount();
    });
  }

  _bindRecipes() {
    this._container.querySelector('.diet-new-recipe')?.addEventListener('click', () => {
      this._onOpenRecipeEditor?.();
    });

    this._container.querySelector('.diet-new-custom-ingredient')?.addEventListener('click', () => {
      this._onAddCustomIngredient?.('');
    });

    // Targeted DOM patch on keystroke, same reasoning _bindToday()'s own
    // search input handler gives — a full _render() on every keystroke
    // would steal focus back out of the box (see _updateRecipesListDom()).
    this._container.querySelector('.diet-recipe-search-input')?.addEventListener('input', (e) => {
      this._recipeSearchQuery = e.target.value;
      this._updateRecipesListDom();
    });

    this._container.querySelector('.diet-filter-toggle')?.addEventListener('click', () => {
      this._filterMenuOpen = !this._filterMenuOpen;
      this._render();
    });

    this._container.querySelector('.diet-filter-clear-all')?.addEventListener('click', () => {
      this._recipeFilters = { cuisines: new Set(), nutrition: new Set(), calorieBand: null };
      this._render();
    });

    // Region/cuisine — multi-select; the "All" chip (empty data-cuisine)
    // clears the set instead of toggling into it.
    this._container.querySelectorAll('.diet-filter-body [data-cuisine]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cuisine = btn.dataset.cuisine;
        const set = this._recipeFilters.cuisines;
        if (!cuisine) set.clear();
        else if (set.has(cuisine)) set.delete(cuisine);
        else set.add(cuisine);
        this._render();
      });
    });

    // Calorie band — single-select; clicking the already-active chip clears it.
    this._container.querySelectorAll('.diet-filter-body [data-calorie-band]').forEach(btn => {
      btn.addEventListener('click', () => {
        const band = btn.dataset.calorieBand;
        this._recipeFilters.calorieBand = this._recipeFilters.calorieBand === band ? null : band;
        this._render();
      });
    });

    // Nutrition profile — multi-select, AND'd together (see _recipeMatchesFilters()).
    this._container.querySelectorAll('.diet-filter-body [data-nutrition]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.nutrition;
        const set = this._recipeFilters.nutrition;
        if (set.has(key)) set.delete(key); else set.add(key);
        this._render();
      });
    });

    this._container.querySelector('.diet-sort-select')?.addEventListener('change', (e) => {
      this._recipeSort = e.target.value;
      this._render();
    });

    this._bindRecipeCards();
  }

  /** Every binding scoped to a recipe/preset card — split out from
   *  _bindRecipes() so _updateRecipesListDom()'s targeted DOM patch (the
   *  search box's keystroke handler above) can re-wire just the cards it
   *  just replaced, instead of a full _bindRecipes() re-run that would
   *  also re-attach (harmlessly, but pointlessly) the search box/filter-
   *  panel listeners that patch never touched. */
  _bindRecipeCards() {
    this._container.querySelectorAll('.diet-recipe-card').forEach(card => {
      const wrapper = card.closest('[data-recipe-id]');
      if (wrapper.dataset.isPreset === '1') return; // presets aren't tap-to-edit — only "Save" (below) does anything
      card.addEventListener('click', () => {
        const id = Number(wrapper.dataset.recipeId);
        const recipe = this._recipes.find(r => r.id === id);
        if (recipe) this._onOpenRecipeEditor?.(recipe);
      });
    });

    this._container.querySelectorAll('.diet-recipe-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.closest('[data-recipe-id]').dataset.recipeId);
        if (!confirm('Delete this recipe?')) return;
        await db.deleteRecipe(id);
        await this.load();
      });
    });

    /** "Save" on a preset — clones it (new id, sourcePresetId pointing back
     *  at the preset) and opens that clone in the recipe editor rather than
     *  saving directly, so the rider can adjust servings/ingredients before
     *  it actually lands in their own `recipes` store — the original preset
     *  JSON is never touched either way. See DIET_PANEL_DESIGN.md §4. */
    this._container.querySelectorAll('.diet-recipe-save').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const presetId = btn.closest('[data-recipe-id]').dataset.recipeId;
        const preset = recipeRepository.getPreset(presetId);
        if (!preset) return;
        const clone = { ...preset, sourcePresetId: preset.id };
        delete clone.id; // absent, not null — see nutrition-model.js's nextId() comment on autoIncrement keys
        this._onOpenRecipeEditor?.(clone);
      });
    });

    /** "Log" — opens the log sheet for that recipe (views/diet-log-sheet.js). Same string-vs-number id
     *  cast the "Save"/delete handlers above already use per data-is-preset (a preset's id is a
     *  'seed-recipe:' string, an own recipe's is a numeric autoIncrement id), since _resolveRecipe()
     *  compares strictly. stopPropagation() keeps this from also triggering the card's own click (which
     *  opens the recipe editor for a saved recipe — see the click handler above). */
    this._container.querySelectorAll('.diet-recipe-log').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrapper = btn.closest('[data-recipe-id]');
        const id = wrapper.dataset.isPreset === '1' ? wrapper.dataset.recipeId : Number(wrapper.dataset.recipeId);
        const recipe = this._resolveRecipe(id);
        if (recipe) this._logSheet.openRecipe(recipe);
      });
    });

    /** "Print" — opens the shared printable recipe sheet (see
     *  ui/recipe-print.js). Same string-vs-number id cast as "Log"/"Save"/
     *  delete above, and works identically for a saved recipe or a preset —
     *  both already carry a precomputed `perServing` and their own
     *  ingredients/steps, so nothing needs to be saved first just to print
     *  it. stopPropagation() keeps this from also triggering the card's own
     *  click (which opens the recipe editor for a saved recipe). */
    this._container.querySelectorAll('.diet-recipe-print').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrapper = btn.closest('[data-recipe-id]');
        const id = wrapper.dataset.isPreset === '1' ? wrapper.dataset.recipeId : Number(wrapper.dataset.recipeId);
        const recipe = this._resolveRecipe(id);
        if (recipe) this._onPrintRecipe?.(recipe);
      });
    });
  }

  /** Day-card toggle (only one day expanded at a time, same rule
   *  history-browser.js's session accordion follows) plus the bindings
   *  for whatever day is currently expanded — a straight re-use of
   *  _bindToday()'s own entry-card/delete/edit-amount wiring, since
   *  _dayExpandContent() rendered those rows with _entryItem() too. No
   *  stopPropagation() is needed between a day's card and its own
   *  .history-expand: they're siblings under the same .history-item, not
   *  ancestor/descendant, so a tap inside the expanded log never bubbles
   *  up into the day-card's own click handler below. */
  _bindHistory() {
    this._container.querySelectorAll('.diet-history-day-card').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.closest('[data-history-date]').dataset.historyDate;
        this._expandedHistoryDate = this._expandedHistoryDate === key ? null : key;
        this._expandedEntryId = null;
        this._editAmountValue = '';
        this._render();
      });
    });

    this._container.querySelectorAll('.diet-history-entries .diet-entry-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = Number(card.closest('[data-entry-id]').dataset.entryId);
        this._expandedEntryId = this._expandedEntryId === id ? null : id;
        this._editAmountValue = '';
        this._render();
      });
    });

    this._container.querySelectorAll('.diet-history-entries .diet-entry-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.closest('[data-entry-id]').dataset.entryId);
        if (!confirm('Delete this entry?')) return;
        await db.deleteDiaryEntry(id);
        await this.load();
      });
    });

    const editInput = this._container.querySelector('.diet-history-entries .diet-edit-amount-input');
    editInput?.addEventListener('click', (e) => e.stopPropagation());
    editInput?.addEventListener('input', (e) => { this._editAmountValue = e.target.value; });

    this._container.querySelector('.diet-history-entries .diet-entry-save')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this._saveEditedAmount();
    });
  }

  /** Wires the search-result buttons currently in the DOM — called both
   *  from _bind() (after a full _render()) and from _runSearch()'s
   *  targeted results-only update, so a result picked mid-search binds
   *  the same way either path got it on screen. */
  _bindSearchResults() {
    this._container.querySelectorAll('.diet-search-result[data-ingredient-id]').forEach(btn =>
      btn.addEventListener('click', () => this._selectIngredient(btn.dataset.ingredientId))
    );
    this._container.querySelectorAll('.diet-search-result[data-recipe-result-id]').forEach(btn =>
      btn.addEventListener('click', () => this._selectRecipeFromSearch(btn.dataset.recipeResultId, btn.dataset.isPreset === '1'))
    );
    this._container.querySelector('.diet-add-custom')?.addEventListener('click', () => this._addCustomIngredientFromSearch());
  }

  async _selectIngredient(id) {
    const ingredient = await this._repo.get(id);
    if (!ingredient) return;
    this._openLogForIngredient(ingredient);
  }

  /** A recipe result tapped in the Today quick-add search — resolves it
   *  via the same two-source lookup _resolveRecipe() already does for a
   *  past diary entry (own saved recipes first, then bundled presets),
   *  then opens the log sheet. `isPreset` is
   *  _recipeSearchResultRow()'s data-is-preset, needed because a
   *  dataset value is always a string — an own recipe's real id is
   *  numeric, so it has to be cast back before _resolveRecipe()'s
   *  strict-equality lookup against this._recipes will find it. */
  _selectRecipeFromSearch(rawId, isPreset) {
    const recipe = this._resolveRecipe(isPreset ? rawId : Number(rawId));
    if (!recipe) return;
    this._openLogForRecipe(recipe);
  }

  /** "Can't find it?" fallback from the quick-add's empty search state —
   *  opens the shared ingredient editor (app.js's openIngredientEditorFor(),
   *  passed down as onAddCustomIngredient) prefilled with whatever was
   *  typed, and — once saved — selects it immediately so the rider can go
   *  straight on to entering an amount and logging it, same as picking any
   *  other search result would. A cancel resolves null and leaves the
   *  quick-add card exactly as it was. */
  async _addCustomIngredientFromSearch() {
    if (!this._onAddCustomIngredient) return;
    const prefillName = this._searchQuery.trim();
    const ingredient = await this._onAddCustomIngredient(prefillName);
    if (!ingredient) return;
    this._openLogForIngredient(ingredient);
  }

  /** Picking a search result clears the box and its dropdown, the same as clearing it by hand —
   *  _bindToday()'s post-render check reloads the browse suggestions if the Smart filter's still on —
   *  and redraws the page, so it is already in its final state behind the sheet's scrim. */
  _clearSearchForLog() {
    this._searchQuery = '';
    this._searchResults = [];
    this._lastIngredientMatches = [];
    this._lastRecipeMatches = [];
    this._searchFocus = null;
    this._smartFilterNote = null;
    this._isBrowsingFocus = false;
    this._render();
  }

  /** Opens the log sheet for an ingredient picked from the search (or just created from its
   *  "can't find it?" fallback). */
  _openLogForIngredient(ingredient) {
    this._clearSearchForLog();
    this._logSheet.openIngredient(ingredient);
  }

  /** Opens the log sheet for a recipe or preset picked from the search. */
  _openLogForRecipe(recipe) {
    this._clearSearchForLog();
    this._logSheet.openRecipe(recipe);
  }

  /** Debounced search that only touches the results dropdown (not the
   *  whole card) — re-rendering the card on every keystroke would steal
   *  focus back out of the input the rider is actively typing in. Clearing
   *  the box back to empty while the Smart filter is on hands off to
   *  _loadFocusSuggestions() instead of just going blank — same "Suggested
   *  for today's focus" browse the filter's own toggle switches into (see
   *  that method's doc comment) — since there's no longer a typed query to
   *  have been searching for. */
  _runSearch(query) {
    clearTimeout(this._searchDebounce);
    const q = query.trim();
    if (!q) {
      if (this._smartFilterOn) {
        this._loadFocusSuggestions();
      } else {
        this._isBrowsingFocus = false;
        this._lastIngredientMatches = [];
        this._lastRecipeMatches = [];
        this._applySearchResults();
        this._updateSearchResultsDom();
      }
      return;
    }
    this._isBrowsingFocus = false; // a typed query always means "search", even before this debounce resolves
    this._searchDebounce = setTimeout(async () => {
      const token = ++this._searchToken;
      const [ingredientMatches, recipeMatches] = await Promise.all([
        this._repo.search(q),
        recipeRepository.search(q),
      ]);
      if (token !== this._searchToken) return; // superseded by a newer keystroke
      this._lastIngredientMatches = ingredientMatches;
      this._lastRecipeMatches = recipeMatches;
      this._applySearchResults();
      this._updateSearchResultsDom();
    }, SEARCH_DEBOUNCE_MS);
  }

  /** The Smart filter's "Suggested for today's focus" browse — both
   *  nutrition/recipe-repository.js#all() and
   *  ingredient-repository.js#all() (every recipe/ingredient available,
   *  not just a name-matched search hit) fed into the exact same
   *  _applySearchResults() ranking a typed search's hits already go
   *  through, which then caps each kind to its own top 10 rather than the
   *  tighter 5/3 a typed query gets (see that method's own doc comment) —
   *  see the file-level doc comment's "Post-Phase-6 fix #6". Earlier
   *  ("fix #5") this suggested recipes only; ingredients are back because
   *  a rider chasing a specific short nutrient often wants the single
   *  richest raw ingredient just as much as a whole recipe built around
   *  it, and there's now enough room (10 apiece, in two labeled groups —
   *  see _renderSearchResults()) to show both without one crowding the
   *  other out the way they would sharing the old flat 8-item cap.
   *  Without this, turning the
   *  Smart filter on with an empty "Log food" box showed nothing at all
   *  until the rider started typing — the toggle's own change handler and
   *  _runSearch()'s empty-query branch (see _bindToday()) both call this
   *  instead of leaving the dropdown blank, and _bindToday() itself calls
   *  it again after every Today-tab render (a diary entry logged, a tab
   *  switch back to Today) so the suggestions stay current rather than
   *  only appearing once, right after the toggle is first flipped on.
   *
   *  this._isBrowsingFocus flips true up front, not just once the fetch
   *  resolves, and doubles as this method's own re-entrancy guard — a
   *  second call racing in behind this one (another render, a rapid
   *  on/off/on of the toggle) sees it's already true and no-ops instead of
   *  firing a redundant fetch. The shared _searchToken counter
   *  (_runSearch()'s debounced fetch guards itself with the same one)
   *  makes sure only the most recently *started* call's result ever lands,
   *  and the second check right after the await covers a call that was
   *  still the newest when it started but is stale by the time it
   *  resolves (Smart filter switched back off, or a query typed, while
   *  the .all() round trip was in flight). */
  async _loadFocusSuggestions() {
    if (!this._smartFilterOn || this._searchQuery.trim() || this._isBrowsingFocus) return;
    this._isBrowsingFocus = true;
    const token = ++this._searchToken;
    const [ingredients, recipes] = await Promise.all([
      this._repo.all(),
      recipeRepository.all(),
    ]);
    if (token !== this._searchToken) return; // superseded by a newer keystroke/toggle
    if (!this._smartFilterOn || this._searchQuery.trim()) return; // filter turned back off, or a query typed, while this was in flight
    this._lastIngredientMatches = ingredients;
    this._lastRecipeMatches = recipes;
    this._applySearchResults();
    this._updateSearchResultsDom();
  }

  /** Builds this._searchResults from the last-fetched raw ingredient/
   *  recipe matches (_lastIngredientMatches/_lastRecipeMatches above),
   *  honoring the current Smart filter state — split out of _runSearch()
   *  so toggling the filter re-sorts/re-filters whatever's already on
   *  screen instantly, without waiting on a fresh debounced
   *  ingredientRepository/recipeRepository round trip for a query that
   *  hasn't actually changed (see the toggle's own change handler in
   *  _bindToday()).
   *
   *  A typed query caps ingredients to 5 and recipes to 3 (8 total)
   *  rather than one flat cap — a common word (e.g. "chicken") can
   *  otherwise return enough ingredient matches on its own to crowd every
   *  recipe match out of the dropdown entirely. Browsing
   *  _loadFocusSuggestions()'s full pool (this._isBrowsingFocus) uses a
   *  much roomier 10-and-10 instead: there's no query result count to
   *  worry about crowding since it's always the complete ranked pool, and
   *  a rider scanning "what should I eat to catch up on X" benefits from
   *  seeing a real top-10 of each kind rather than the same tight cap a
   *  live keystroke search needs to stay a compact dropdown (see
   *  _renderSearchResults()'s two labeled groups for that case). A recipe
   *  with no perServing (e.g. every ingredient line was since deleted) is
   *  excluded either way — same "exclude rather than guess" rule
   *  _recipeMatchesFilters() already applies — since _recipeLogPanel()
   *  has nothing to scale.
   *
   *  When the filter is on, ranking runs over the *full* raw match list
   *  for each kind — ingredients through
   *  metrics/daily-values.js#rankIngredientsForFocus(), recipes through
   *  that same file's rankRecipesForFocus() (same today's-status input
   *  _currentNutrientStatus() gives charts/macro-pie.js's own focus
   *  overview) — before the top-5/top-3 caps are applied, rather than
   *  re-ranking only whichever handful the plain relevance order would
   *  have shown; otherwise a great fit sitting further down on relevance
   *  alone could never surface. Both rankers also drop anything that
   *  would push a Watch nutrient past 100% today, or whose reference
   *  amount alone already sits within 5% of that nutrient's full daily
   *  limit regardless of what's logged so far — a recipe running close
   *  to a whole day's sodium in a single serving being the clearest case
   *  (see rankRecipesForFocus()/_fitsWithinLimits()). Ingredients and
   *  recipes are ranked/excluded independently, so one kind coming back
   *  empty doesn't blank out the other kind's still-real ranked matches.
   *  If a kind's ranking would exclude every one of its own raw matches,
   *  that's the documented "shows all matches instead of hiding real
   *  hits" fallback (see .diet-search-empty-note in style.css): that
   *  kind's original unranked list is used instead and _smartFilterNote
   *  is set so _renderSearchResults() can say so, rather than a search
   *  with real results silently rendering as if nothing matched. */
  _applySearchResults() {
    let ingredients = this._lastIngredientMatches;
    let recipes = this._lastRecipeMatches.filter(r => r.perServing != null);
    this._smartFilterNote = null;
    this._searchFocus = null;

    if (this._smartFilterOn && (ingredients.length || recipes.length)) {
      const status = this._currentNutrientStatus();
      this._searchFocus = focusNutrients(status, { limit: 4 });

      const rankedIngredients = rankIngredientsForFocus(ingredients, status);
      const rankedRecipes = rankRecipesForFocus(recipes, status);

      if (ingredients.length && !rankedIngredients.length) {
        this._smartFilterNote = "Nothing here fits today's remaining limits — showing every match instead.";
      } else {
        ingredients = rankedIngredients;
      }
      if (recipes.length && !rankedRecipes.length) {
        this._smartFilterNote = "Nothing here fits today's remaining limits — showing every match instead.";
      } else {
        recipes = rankedRecipes;
      }
    }

    const ingredientCap = this._isBrowsingFocus ? 10 : 5;
    const recipeCap = this._isBrowsingFocus ? 10 : 3;
    this._searchResults = [
      ...ingredients.slice(0, ingredientCap).map(item => ({ kind: 'ingredient', item })),
      ...recipes.slice(0, recipeCap).map(item => ({ kind: 'recipe', item })),
    ];
  }

  _updateSearchResultsDom() {
    const el = this._container.querySelector('#diet-search-results');
    if (!el) return;
    el.innerHTML = this._renderSearchResults();
    this._bindSearchResults();
  }

  /** Writes a finished diary entry and reloads. The entry comes from the log sheet
   *  (views/diet-log-sheet.js, built by views/diet-log-logic.js): an ingredient is amountG only, a
   *  recipe is servings only, and the nutrients are snapshotted at that amount, the same shapes this
   *  page has always written. The sheet awaits this before it closes, so a failed save leaves it open
   *  with the draft intact; a failed reload after a successful save must not look like one (the sheet
   *  would re-enable Add and a second tap would log the item twice), so that is only logged. */
  async _addLoggedEntry(entry) {
    await db.saveDiaryEntry(entry);
    try { await this.load(); }
    catch (err) { console.error('[diet] the entry was saved but the page could not reload', err); }
  }

  async _saveEditedAmount() {
    const entry = this._diaryEntries.find(e => e.id === this._expandedEntryId);
    if (!entry) return;

    const raw = Number(this._editAmountValue);
    if (!isFinite(raw) || raw <= 0) return;

    if (entry.source?.type === 'recipe') {
      const recipe = this._recipeById.get(entry.source?.id);
      if (!recipe) return;
      await db.updateDiaryEntry({
        ...entry,
        source: { ...entry.source, servings: raw },
        nutrients: scaleRecipeNutrients(recipe.perServing, raw),
      });
    } else {
      const ingredient = this._ingredientById.get(entry.source?.id);
      if (!ingredient) return;
      const amountG = displayWeightToG(raw, this._profile.units);
      await db.updateDiaryEntry({
        ...entry,
        source: { ...entry.source, amountG },
        nutrients: scaleNutrients(ingredient.perHundredG, amountG),
      });
    }

    this._expandedEntryId = null;
    this._editAmountValue = '';
    await this.load();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function _round1(v) { return v == null ? v : Math.round(v * 10) / 10; }

/** 'italian' -> 'Italian' — cuisine tags are stored lowercase (matching
 *  ui/recipe-editor.js's KNOWN_CUISINES and the seed recipe JSON), display
 *  only capitalizes the first letter. */
/** The designed empty state every Diet list uses instead of a sentence — the same hero glass
 *  card as History's (`.history-empty-state`, views/history-browser.js `_emptyState()`): a
 *  dimmed ghost of the real thing that will appear, a headline, one muted line, and an optional
 *  action. The ghost is built from the real classes (`.history-card` + `.stat-chip`,
 *  `.diet-ing-tile`) so it can't drift from them; it is aria-hidden and inert. `title`, `line`
 *  and `action` are HTML — callers escape anything user-typed. `clearRail` shifts the content
 *  clear of the floating rail, for an empty state that lands low on the page (Today's Log sits
 *  under the summary and search, right where the rail is); the card's glass still runs under it. */
function _emptyCard({ ghost, title, line, action = '', clearRail = false }) {
  return `
    <section class="history-empty-state diet-empty${clearRail ? ' diet-empty-clear-rail' : ''}">
      <div class="diet-empty-ghost" aria-hidden="true">${ghost === 'ingredient' ? _ghostIngredients() : _ghostEntry()}</div>
      <h3 class="history-empty-title">${title}</h3>
      <p class="history-empty-line">${line}</p>
      ${action}
    </section>
  `;
}

/** One ghost diary/recipe/day card: skeleton name + sub-line over four "—" macro chips. */
function _ghostEntry() {
  const chip = (metric, label) =>
    `<div class="stat-chip" data-metric="${metric}"><span class="stat-val">—</span><span class="stat-lbl">${label}</span></div>`;
  return `
    <div class="history-card diet-empty-ghost-card">
      <div class="history-card-header">
        <div><span class="diet-empty-skel diet-empty-skel-name"></span><span class="diet-empty-skel diet-empty-skel-sub"></span></div>
      </div>
      <div class="history-card-stats">
        ${chip('calories', 'KCAL')}${chip('protein', 'PROTEIN')}${chip('carbs', 'CARBS')}${chip('fat', 'FAT')}
      </div>
    </div>
  `;
}

/** A pair of ghost ingredient tiles (skeleton name, "—" kcal, empty tick strip). */
function _ghostIngredients() {
  const tile = `
    <div class="diet-ing-tile">
      <span class="diet-ing-name"><span class="diet-empty-skel diet-empty-skel-name"></span></span>
      <span class="diet-ing-kcal"><span class="diet-ing-num">—</span><small>kcal/100g</small></span>
      <span class="diet-ing-ticks" style="--fill:0%" aria-hidden="true"></span>
    </div>`;
  return `<div class="diet-ingredient-tiles">${tile}${tile}</div>`;
}

function _titleCase(str) {
  return str.length ? str[0].toUpperCase() + str.slice(1) : str;
}

function _esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export default DietPage;
