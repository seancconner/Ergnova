// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/recipe-editor.js
 *
 * Recipe builder — DIET_PANEL_DESIGN.md §9's "simpler cousin of
 * editor/workout-editor.js's list-building UI (add/reorder/remove rows)
 * but for ingredient rows instead of workout steps". Simpler in one
 * concrete way workout-editor.js isn't: an ingredient row's position in
 * the list has no effect on the recipe's nutrition (unlike a workout
 * step's position, which changes what the ride actually does), so this
 * skips workout-editor.js's drag-to-reorder machinery entirely — add and
 * remove are the only row operations a recipe needs.
 *
 * Same full-screen overlay shape as ui/cardio-session-flow.js / ui/
 * ingredient-editor.js (a #container.setup-flow host, hidden by default,
 * built once in the constructor, toggled via open()/close()).
 *
 * Each row is an ingredient + a gram amount + that amount's computed
 * nutrient contribution (core/nutrition-model.js#scaleNutrients()), and a
 * footer shows the live per-serving total
 * (core/nutrition-model.js#recipeNutrientsPerServing()), recomputed on
 * every row add/remove/amount edit and every change to servings.
 * recipeNutrientsPerServing()'s ingredientLookupFn has to be synchronous,
 * but ingredientRepository.get() is async (custom ingredients round-trip
 * through IndexedDB) — so, same pattern views/diet.js's
 * _resolveEntryNames()/_ingredientById already uses, every ingredient a
 * row references gets resolved into an in-memory Map once (when the row
 * is added, or up front when opening an existing recipe) and the totals
 * math reads that Map synchronously rather than the repository directly.
 *
 * Row amounts still store canonical grams (Recipe.ingredients[].amountG),
 * same as ever, but the *display* unit now comes from metrics/units.js's
 * modular measurement display — smallWeightUnitLabel()/gToDisplayWeight()
 * for solids, mlToDisplayVolume() for anything with densityGPerMl set
 * (oils, milk, sauces, honey), which auto-picks the largest unit the row's
 * amount reaches at least 1 of (tsp/tbsp/fl oz/cup, or mL/L), and a count
 * against one of core/nutrition-model.js's SizeOption entries (e.g. "2
 * Medium") for anything with sizeOptions set (eggs, onions, cloves of
 * garlic) — see _rowDisplay() below, and views/diet.js's Weight/Volume/Size
 * `.segmented` toggle for the diary's version of the same three modes.
 *
 * Each row that has an alternative to weight at all (densityGPerMl and/or
 * sizeOptions set) gets its own copy of that same Weight/Volume/Size
 * `.segmented` control, so a rider can force whichever mode actually
 * matches how they think about that ingredient — a kitchen-scale user
 * forcing Weight on a "cocoa powder" or "brown sugar" line the auto-pick
 * would otherwise land on Volume for, or the reverse for someone working
 * from a written recipe's cup/tbsp measures. The auto-pick (density >
 * sizeOptions > weight) is still what a fresh row starts on — it's a
 * sensible default for most ingredients most of the time — but it's a
 * default now, not the only option. When a row is in Volume mode, a second
 * `<select>` (of metrics/units.js's VOLUME_UNITS for the rider's
 * metric/imperial setting) lets them force the *specific* cooking-measure
 * unit too, rather than trusting mlToDisplayVolume()'s largest-unit-it-
 * reaches rule — e.g. pinning "cup" for a dry-measure ingredient that
 * would otherwise auto-pick "fl oz" once its amount crosses that
 * threshold, which reads oddly for something nobody actually measures in
 * fluid ounces.
 *
 * Both choices — which mode, and which volume unit — are written back onto
 * the line itself (Recipe.ingredients[].unitMode/.volumeUnit) the moment a
 * rider picks them, same "survives Save and reopens the same way" pattern
 * this.rowSizeOptionId/line.sizeOptionId already established below for
 * size mode; a line that's never had either manually set keeps falling
 * back to the auto-pick, so every recipe authored before this toggle
 * existed reopens looking exactly as it did before. this._rowUnitMode/
 * this._rowVolumeUnit mirror whichever choice is currently in effect
 * across renders — same in-session bookkeeping as this._rowSizeOptionId —
 * seeded from the line the first time a row is shown, and falling back to
 * the auto-pick only if neither the line nor the remembered value names a
 * still-valid mode/unit (e.g. Volume, remembered from before an ingredient
 * swap left this row's new ingredient with no densityGPerMl).
 *
 * Size mode is the one case where, even once a mode is picked, *which*
 * sizeOptions entry applies still isn't something amountG alone
 * determines — "2 Medium" and "3 Small" onions can land on the same gram
 * figure — so which one a row is being read against is its own separate
 * choice (a `<select>` of the ingredient's sizeOptions), remembered in
 * this._rowSizeOptionId (separately from _rowDisplayUnits, which gets
 * rebuilt on every render) so it survives row adds/removes elsewhere in
 * the list. The chosen weight/volume *value*, by contrast, is fully
 * determined by amountG once a mode (and, for volume, a unit) is picked,
 * and re-derived on every render — see _rowDisplay() — and, like the
 * amount input itself, never reformats mid-keystroke — see
 * _bindBodyEvents()'s amount-input handler.
 *
 * Usage:
 *   const recipeEditor = new RecipeEditor($('recipe-editor-flow'), {
 *     profile,
 *     onSave: (recipe) => { ... },                      // after db.saveRecipe()/updateRecipe()
 *     onAddCustomIngredient: (prefillName) => Promise<Ingredient|null>,  // bridges to IngredientEditor
 *     onPrint: (recipe, opts) => recipePrintSheet.print(recipe, opts),   // bridges to ui/recipe-print.js
 *   });
 *   recipeEditor.open();          // new recipe
 *   recipeEditor.open(existing);  // edit (existing.id set) or clone-from-preset (existing.id unset)
 */

import { db } from '../storage/db.js';
import { ingredientRepository } from '../nutrition/ingredient-repository.js';
import { createRecipe, recipeNutrientsPerServing, macroCalorieSplit, gramsForSizeOption }
                                 from '../core/nutrition-model.js';
import { smallWeightUnitLabel, gToDisplayWeight, displayWeightToG,
         mlToDisplayVolume, displayVolumeToMl, mlToUnit, VOLUME_UNITS, VOLUME_UNIT_LABELS,
         pluralizeUnit } from '../metrics/units.js';

const SEARCH_DEBOUNCE_MS = 150;
const DEFAULT_ROW_AMOUNT_G = 100;

// Known cuisine tags, offered as a <datalist> so the free-text field stays
// consistent with the preset packs' tags without hard-locking the field to
// only-ever those six — DIET_PANEL_DESIGN.md §1 already anticipated more
// cuisine packs (indian/mediterranean/american) arriving over time without
// any code change; now that data/nutrition/recipes/ ships all six, this list
// is updated to match. A rider naming a cuisine that still isn't a preset
// pack (e.g. "thai") remains expected, not an error.
const KNOWN_CUISINES = ['italian', 'mexican', 'japanese', 'indian', 'mediterranean', 'american'];

export class RecipeEditor {
  /**
   * @param {HTMLElement} container
   * @param {Object}   opts
   * @param {Object}   opts.profile                 Live profile object (for units.g/oz display).
   * @param {Function} [opts.onSave]                 (savedRecipe) => void
   * @param {Function} [opts.onAddCustomIngredient]  (prefillName) => Promise<Ingredient|null> —
   *   opens the shared ingredient editor and resolves with the saved ingredient, or null on cancel.
   * @param {Function} [opts.onPrint]                 (recipe, { lookup }) => void — opens the shared
   *   printable recipe sheet (ui/recipe-print.js) on the in-progress draft, with a sync ingredient
   *   lookup bound to this editor's own cache so nothing has to be saved first just to print it.
   * @param {Object}   [opts.ingredientRepository]   Defaults to the shared singleton; overridable for tests.
   */
  constructor(container, { profile, onSave, onAddCustomIngredient, onPrint, ingredientRepository: repo = ingredientRepository } = {}) {
    this._container = container;
    this._profile = profile;
    this._onSave = onSave;
    this._onAddCustomIngredient = onAddCustomIngredient;
    this._onPrint = onPrint;
    this._repo = repo;

    this._draft = null;
    this._ingredientCache = new Map(); // ingredientId -> Ingredient, see module doc comment
    this._rowDisplayUnits = []; // parallel to draft.ingredients — {value, unit, label, kind} per row,
                                 // set by _renderRows()/_rowDisplay(), read back by the amount-input handler
    this._rowSizeOptionId = []; // parallel to draft.ingredients — which Ingredient.sizeOptions[] entry a
                                 // "size"-kind row is currently expressed in, e.g. 'medium' for "2 Medium".
                                 // Unlike _rowDisplayUnits this survives across _renderRows() calls (see
                                 // _rowDisplay()'s doc comment): unlike weight/volume, which unit a size
                                 // row shows isn't derivable from amountG alone, so the rider's choice of
                                 // *which* size option has to be remembered somewhere, not re-picked on
                                 // every render. Kept in sync with draft.ingredients by _addRow() and the
                                 // row-remove handler; seeded in open() from each line's own sizeOptionId
                                 // (see module doc comment), unlike unitMode/volumeUnit below this one
                                 // preference *is* persisted onto the line itself.
    this._rowUnitMode = [];      // parallel to draft.ingredients — 'weight'|'volume'|'size', the mode a
                                 // row's manual Weight/Volume/Size toggle is currently set to. Seeded in
                                 // open() from each line's own unitMode (if still valid for that line's
                                 // ingredient), else null — meaning "no manual choice yet, auto-pick" —
                                 // and locked in by _rowDisplay() the first time a row is shown, same
                                 // "remembered across renders, written onto the line the moment it's
                                 // chosen" pattern as this._rowSizeOptionId/line.sizeOptionId. See module
                                 // doc comment.
    this._rowVolumeUnit = [];    // parallel to draft.ingredients — one of metrics/units.js's
                                 // VOLUME_UNITS[units], the specific cooking-measure unit a "volume"-mode
                                 // row is currently forced to (e.g. 'cup'), or null for "no manual choice
                                 // yet, let mlToDisplayVolume() auto-pick". Same seed/lock-in/persist
                                 // pattern as this._rowUnitMode above, just one level more specific and
                                 // only meaningful while that row is actually in volume mode.

    this._searchQuery = '';
    this._searchResults = [];
    this._searchToken = 0;
    this._searchDebounce = null;

    this._renderShell();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * @param {Recipe|null} recipe  Omit for a blank new recipe. Pass an existing Recipe to edit it
   *   in place (its `id` is preserved and db.updateRecipe() is used on Save), or a preset clone
   *   with `id` already stripped and `sourcePresetId` set (db.saveRecipe() adds it as new).
   */
  async open(recipe = null) {
    this._draft = recipe ? _deepClone(recipe) : createRecipe();
    this._isEditing = recipe != null && recipe.id != null;
    this._searchQuery = '';
    this._searchResults = [];
    // Seed each row from the line's own sizeOptionId (if any) so a recipe
    // that was authored/edited against a specific option — e.g. "Medium"
    // tomato for a caprese salad — reopens showing that, not whatever's
    // first in the ingredient's list; a line with no sizeOptionId yet
    // (or a non-size-kind row, ingoring it does no harm) picks the first
    // option at render, same as before.
    this._rowSizeOptionId = this._draft.ingredients.map(line => line.sizeOptionId ?? null);
    // Same seeding for the mode/unit toggles — null means "nothing manually
    // chosen yet", so _rowDisplay() falls back to its usual auto-pick; see
    // module doc comment and this._rowUnitMode's own doc comment above.
    this._rowUnitMode = this._draft.ingredients.map(line => line.unitMode ?? null);
    this._rowVolumeUnit = this._draft.ingredients.map(line => line.volumeUnit ?? null);

    await this._resolveRowIngredients();

    this._container.classList.remove('hidden');
    this._renderBody();
    this._container.querySelector('#re-name')?.focus();
  }

  close() {
    this._container.classList.add('hidden');
  }

  // ─── Ingredient resolution ──────────────────────────────────────────────

  /** Populates this._ingredientCache for every ingredientId currently in
   *  the draft — needed up front when opening an existing recipe/preset
   *  clone, since recipeNutrientsPerServing()'s lookup has to be sync. */
  async _resolveRowIngredients() {
    const ids = [...new Set(this._draft.ingredients.map(line => line.ingredientId))];
    const pairs = await Promise.all(ids.map(async id => [id, await this._repo.get(id)]));
    for (const [id, ingredient] of pairs) this._ingredientCache.set(id, ingredient);
  }

  _lookup(id) {
    return this._ingredientCache.get(id) ?? null;
  }

  _perServing() {
    return recipeNutrientsPerServing(this._draft, id => this._lookup(id));
  }

  // ─── Shell (built once) ─────────────────────────────────────────────────

  _renderShell() {
    this._container.classList.add('setup-flow', 'hidden');
    this._container.innerHTML = `
      <div class="setup-flow-card">
        <div class="setup-flow-head">
          <span class="setup-flow-head-title" id="re-head-title">Recipe</span>
          <button class="setup-flow-close" id="re-close" title="Cancel" aria-label="Cancel">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg>
          </button>
        </div>
        <div class="setup-flow-body" id="re-body"></div>
        <div class="setup-flow-foot" id="re-foot"></div>
      </div>
    `;

    this._container.querySelector('#re-close').addEventListener('click', () => this._cancel());
    this._container.addEventListener('click', e => {
      if (e.target === this._container) this._cancel();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this._container.classList.contains('hidden')) this._cancel();
    });
  }

  _cancel() {
    this.close();
  }

  async _save() {
    const d = this._draft;
    d.name = (d.name ?? '').trim();
    if (!d.name || d.ingredients.length === 0) return;
    d.servings = Math.max(1, Math.round(Number(d.servings) || 1));
    d.perServing = this._perServing();

    let saved;
    if (this._isEditing) {
      await db.updateRecipe(d);
      saved = d;
    } else {
      saved = await db.saveRecipe(d); // assigns the autoIncrement id
    }
    this.close();
    this._onSave?.(saved);
  }

  // ─── Body ───────────────────────────────────────────────────────────────

  _renderBody() {
    const d = this._draft;
    this._container.querySelector('#re-head-title').textContent =
      this._isEditing ? 'Edit Recipe' : (d.sourcePresetId ? 'Save Recipe' : 'New Recipe');

    const body = this._container.querySelector('#re-body');
    body.innerHTML = `
      <label class="sf-field">
        <span>Recipe name</span>
        <input class="input full-width" id="re-name" placeholder="e.g. Weeknight Chili" value="${_esc(d.name)}">
      </label>
      <div class="sf-range-row">
        <label class="sf-field">
          <span>Servings</span>
          <input type="number" min="1" step="1" class="input full-width" id="re-servings" value="${d.servings}">
        </label>
        <label class="sf-field">
          <span>Cuisine <span class="settings-sub">(optional)</span></span>
          <input class="input full-width" id="re-cuisine" list="re-cuisine-list" placeholder="e.g. italian" value="${_esc(d.cuisine ?? '')}">
          <datalist id="re-cuisine-list">${KNOWN_CUISINES.map(c => `<option value="${c}">`).join('')}</datalist>
        </label>
      </div>
      ${d.sourcePresetId ? `<p class="settings-sub">Based on a preset recipe — saving keeps your own editable copy; the original preset never changes.</p>` : ''}

      <div class="re-ingredients-head">
        <h2 class="settings-title">Ingredients</h2>
      </div>
      <input type="text" class="input full-width re-search-input" placeholder="Search ingredients to add…"
             value="${_esc(this._searchQuery)}" autocomplete="off">
      <div class="re-search-results" id="re-search-results">${this._renderSearchResults()}</div>

      <div class="re-row-list" id="re-row-list">${this._renderRows()}</div>
      ${d.ingredients.length === 0 ? `<p class="history-empty re-empty">No ingredients yet — search above to add the first one.</p>` : ''}

      <div class="re-steps-head">
        <h2 class="settings-title">Method <span class="settings-sub">(optional)</span></h2>
      </div>
      <div class="re-step-list" id="re-step-list">${this._renderSteps()}</div>
      <button type="button" class="btn btn-ghost btn-sm re-add-step">+ Add step</button>
    `;
    this._bindBodyEvents();
    this._renderFoot();
  }

  /** Method/steps section — Recipe.steps[] (core/nutrition-model.js), the
   *  print sheet's (ui/recipe-print.js) numbered "Method" list and, per
   *  the module doc comment, the only piece of a Recipe that isn't itself
   *  nutrition data. Unlike the ingredient rows above, a step's position
   *  in the list *does* matter (it's a cooking order), but reordering
   *  wasn't asked for here — add/remove are the only two row operations,
   *  same reasoning the module doc comment already gives for skipping
   *  workout-editor.js's drag machinery on the ingredient rows. Deleting
   *  a step in the middle and retyping is the escape hatch for "put it
   *  somewhere else" until/unless reordering is ever asked for. */
  _renderSteps() {
    if (!this._draft.steps.length) {
      return `<p class="history-empty re-empty">No steps yet — add the first one below.</p>`;
    }
    return this._draft.steps.map((step, idx) => `
      <div class="re-step-row" data-step-index="${idx}">
        <span class="re-step-number">${idx + 1}</span>
        <textarea class="input re-step-text" data-step-index="${idx}" rows="2"
                  placeholder="Describe this step…" aria-label="Step ${idx + 1}">${_esc(step)}</textarea>
        <button type="button" class="btn btn-ghost re-step-remove" data-step-index="${idx}"
                title="Remove step" aria-label="Remove step ${idx + 1}">
          <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg>
        </button>
      </div>
    `).join('');
  }

  _renderSearchResults() {
    if (!this._searchQuery.trim()) return '';
    const q = this._searchQuery.trim();
    if (!this._searchResults.length) {
      return `
        <div class="re-search-empty">
          <p class="settings-sub">No matches for "${_esc(q)}".</p>
          <button type="button" class="btn btn-ghost btn-sm re-add-custom">+ Add "${_esc(q)}" as a custom ingredient</button>
        </div>
      `;
    }
    return this._searchResults.slice(0, 8).map(ing => `
      <button type="button" class="diet-search-result re-search-result" data-ingredient-id="${_esc(ing.id)}">
        <span class="diet-search-result-name">${_esc(ing.name)}${ing.brand ? ` <span class="diet-search-result-brand">· ${_esc(ing.brand)}</span>` : ''}</span>
        <span class="diet-search-result-kcal">${Math.round(ing.perHundredG?.calories ?? 0)} kcal/100${ing.densityGPerMl != null ? 'mL' : 'g'}</span>
      </button>
    `).join('');
  }

  /** Picks the one display unit a row's amount input shows — weight for a
   *  solid ingredient, a volume unit (tsp/tbsp/fl oz/cup, or mL/L) for
   *  anything with densityGPerMl set, or a count against one of the
   *  ingredient's sizeOptions (e.g. "2" against "Medium") for anything
   *  that has those. Which of the three (the row's *mode*) is either the
   *  rider's own manual choice — this._rowUnitMode[idx], or the line's own
   *  persisted line.unitMode the first time a reopened/existing row is
   *  shown — or, absent either, the same "presence of the field decides"
   *  auto-pick (density > sizeOptions > weight) DIET_PANEL_DESIGN.md §5
   *  documents for the diary's own Weight/Volume/Size toggle (views/
   *  diet.js). A remembered/persisted mode naming something the row's
   *  *current* ingredient doesn't actually support (e.g. Volume, left over
   *  from before an ingredient swap dropped densityGPerMl) is discarded
   *  before falling through to the auto-pick, same "stale choice, ignore
   *  it" treatment sizeOptionId already gets below. See module doc comment.
   *
   *  Within Volume mode, *which* specific unit (tsp vs. cup, say) is a
   *  second, independent choice — this._rowVolumeUnit[idx]/
   *  line.volumeUnit, falling back to mlToDisplayVolume()'s auto-selected
   *  largest-unit-it-reaches pick when neither names a unit valid for the
   *  rider's current metric/imperial setting. mlToUnit() then reads the
   *  row's amountG against that specific unit, manually-chosen or not,
   *  the same way gToDisplayWeight() always has for weight mode.
   *
   *  Size mode is the one case here where "the right unit" isn't fully
   *  determined by amountG alone -- a count of "Medium" onions and a count
   *  of "Large" onions can both land on the same gram figure, so *which*
   *  sizeOptions entry a row is being read against has to be a choice
   *  someone makes. A recipe line can carry that choice explicitly as
   *  line.sizeOptionId (see core/nutrition-model.js's Recipe typedef) --
   *  set either by whoever authored the recipe (the bundled seed presets
   *  all do, e.g. a caprese salad's tomato line pins "Medium" instead of
   *  falling through to whatever's first) or by the rider picking a
   *  different option in this row's <select> (see _bindBodyEvents(), which
   *  writes it back onto the line so it survives Save). this._rowSizeOptionId
   *  mirrors whichever id is currently in effect across renders -- same
   *  in-session bookkeeping as before, just seeded from the line the first
   *  time a row is shown, and falling back to the first sizeOptions entry
   *  only if neither the line nor the remembered id names a still-valid
   *  option (e.g. a stale id from before the ingredient's sizes were edited).
   *
   *  Falls back to weight if mlToDisplayVolume() ever returns null (only
   *  possible if amountG were null, which a saved/in-progress row never is). */
  _rowDisplay(line, ingredient, units, idx) {
    const hasDensity = ingredient?.densityGPerMl != null;
    const hasSizes = ingredient?.sizeOptions?.length > 0;

    let mode = this._rowUnitMode[idx] ?? line.unitMode ?? null;
    if (mode === 'volume' && !hasDensity) mode = null;
    if (mode === 'size' && !hasSizes) mode = null;
    if (mode == null) mode = hasDensity ? 'volume' : (hasSizes ? 'size' : 'weight');
    this._rowUnitMode[idx] = mode; // lock in so the toggle's initial active state matches

    if (mode === 'volume') {
      const ml = line.amountG / ingredient.densityGPerMl;
      const volumeUnits = VOLUME_UNITS[units];
      let unit = this._rowVolumeUnit[idx] ?? line.volumeUnit ?? null;
      if (!unit || !volumeUnits.includes(unit)) unit = mlToDisplayVolume(ml, units)?.unit ?? volumeUnits[0];
      this._rowVolumeUnit[idx] = unit; // lock in so the <select>'s initial value matches
      return { value: mlToUnit(ml, unit), unit, label: VOLUME_UNIT_LABELS[unit] ?? unit, kind: 'volume' };
    }
    if (mode === 'size') {
      const options = ingredient.sizeOptions;
      const preferredId = this._rowSizeOptionId[idx] ?? line.sizeOptionId;
      const option = options.find(o => o.id === preferredId) ?? options[0];
      this._rowSizeOptionId[idx] = option.id; // lock in the default so the <select>'s initial value matches
      return { value: line.amountG / option.grams, unit: option.id, label: option.label, detail: option.detail ?? null, kind: 'size' };
    }
    const label = smallWeightUnitLabel(units);
    return { value: gToDisplayWeight(line.amountG, units), unit: label, label, kind: 'weight' };
  }

  /** Weight-equivalent caption shown under a row's controls whenever its
   *  display unit isn't already a weight — a "1 tbsp" or "2 Medium" row
   *  reads fine to whoever wrote the recipe, but a rider trying to shop
   *  or scale it accurately shouldn't have to trust an unseen conversion
   *  happened correctly, same reasoning as views/diet.js's
   *  _sizeHintText(), just covering volume rows too since a row can land
   *  in volume mode either by auto-pick or by the rider's own manual
   *  toggle (see module doc comment). Reads amountG directly — the
   *  canonical value every row already stores — rather than re-deriving
   *  it from whatever the display unit currently is, so it stays correct
   *  no matter which kind is showing.
   *  @param {number} amountG
   *  @param {string} kind    One of _rowDisplay()'s 'volume'/'size'/'weight'.
   */
  _rowWeightHintText(amountG, kind) {
    const units = this._profile.units;
    const suffix = kind === 'size' ? ' total' : '';
    return `≈ ${_round1(gToDisplayWeight(amountG, units))} ${smallWeightUnitLabel(units)}${suffix}`;
  }

  _renderRows() {
    const units = this._profile.units;
    this._rowDisplayUnits = this._draft.ingredients.map((line, idx) =>
      this._rowDisplay(line, this._lookup(line.ingredientId), units, idx));

    return this._draft.ingredients.map((line, idx) => {
      const ingredient = this._lookup(line.ingredientId);
      const name = ingredient?.name ?? 'Removed ingredient';
      // Just the row's own calorie contribution (amount × its per-100g
      // calories) — the aggregate protein/carbs/fat split already lives
      // in the footer (_renderFoot()) via recipeNutrientsPerServing(), so
      // repeating a full macro breakdown on every row would be the same
      // numbers shown twice for little extra clarity.
      const kcal = ingredient ? Math.round((ingredient.perHundredG.calories ?? 0) * line.amountG / 100) : 0;
      const disp = this._rowDisplayUnits[idx];
      const hasDensity = ingredient?.densityGPerMl != null;
      const hasSizes = ingredient?.sizeOptions?.length > 0;
      // The manual Weight/Volume/Size toggle — same three modes and same
      // `.segmented`/`.segmented-btn` markup as the diary's own amount-mode
      // switch (views/diet.js's _quickAddForm()), just one copy per row
      // instead of one for the whole form, and only shown at all when this
      // row actually has an alternative to weight (see module doc
      // comment). Weight is always offered as the fallback/baseline mode.
      const unitToggle = (hasDensity || hasSizes) ? `
        <div class="segmented re-row-unit-mode segmented-full" role="group" aria-label="Amount type for ${_esc(name)}">
          <button type="button" class="segmented-btn ${disp.kind === 'weight' ? 'active' : ''}" data-row-index="${idx}" data-mode="weight">Weight</button>
          ${hasDensity ? `<button type="button" class="segmented-btn ${disp.kind === 'volume' ? 'active' : ''}" data-row-index="${idx}" data-mode="volume">Volume</button>` : ''}
          ${hasSizes ? `<button type="button" class="segmented-btn ${disp.kind === 'size' ? 'active' : ''}" data-row-index="${idx}" data-mode="size">Size</button>` : ''}
        </div>
      ` : '';
      // A size row needs a *choice* of unit (see _rowDisplay()'s doc
      // comment), so it gets a <select> of the ingredient's sizeOptions
      // in place of the plain unit label every other row shows. The
      // select's title mirrors the currently-picked option's cut/prep
      // detail (e.g. "roughly ½-inch pieces") as a hover tooltip — most
      // options don't set one (a clove, a slice, a whole lemon need no
      // explanation), so this is empty/absent for those. Each <option>
      // also carries its own detail as a title, so hovering an unselected
      // choice in the dropdown previews its cut size too, not just the
      // currently-selected one.
      //
      // A volume row similarly gets a <select> of VOLUME_UNITS[units] —
      // mirroring the diary quick-add's own diet-volume-unit select — so
      // the rider can force a specific cooking-measure unit (e.g. "cup")
      // instead of trusting mlToDisplayVolume()'s auto-pick, which is
      // exactly the "why did this default to fl oz" complaint the toggle
      // as a whole exists to fix. Only a plain weight row still gets the
      // bare, non-interactive label — there's only ever one weight unit
      // (g or oz) for a given metric/imperial setting, so there's nothing
      // to choose between.
      const unitControl = disp.kind === 'size'
        ? `<select class="input re-row-size-option" data-row-index="${idx}" aria-label="Size for ${_esc(name)}" title="${_esc(disp.detail ?? '')}">
             ${ingredient.sizeOptions.map(o =>
               `<option value="${_esc(o.id)}" ${o.id === disp.unit ? 'selected' : ''} ${o.detail ? `title="${_esc(o.detail)}"` : ''}>${_esc(o.label)}</option>`
             ).join('')}
           </select>`
        : disp.kind === 'volume'
          ? `<select class="input re-row-volume-unit" data-row-index="${idx}" aria-label="Unit for ${_esc(name)}">
               ${VOLUME_UNITS[units].map(u =>
                 `<option value="${u}" ${u === disp.unit ? 'selected' : ''}>${VOLUME_UNIT_LABELS[u]}</option>`
               ).join('')}
             </select>`
          // Weight rows pair the visible label with the same
          // singular/plural rule the print sheet's _lineDisplay() uses
          // ("1 cup" vs "2 cups"); the amount-input handler below keeps
          // this in sync live as the rider types, without a full re-render.
          : `<span class="diet-amount-unit" data-row-index="${idx}">${_esc(pluralizeUnit(disp.label, _round1(disp.value)))}</span>`;
      // Screen-reader label for the bare number input — sighted riders
      // read it off the unit control right next to it, but the input has
      // no visible label of its own otherwise. A size row's input is a
      // count against whichever option the <select> holds, not an
      // "amount in <option label>", so it gets its own phrasing.
      const amountAriaLabel = disp.kind === 'size'
        ? `Count of ${_esc(disp.label)}`
        : `Amount in ${_esc(disp.label)}`;
      // Only a non-weight unit needs the gram/oz equivalent spelled out —
      // a weight row's own number already *is* the weight.
      const weightHint = disp.kind !== 'weight'
        ? `<p class="settings-sub re-row-weight-hint" id="re-row-weight-hint-${idx}">${this._rowWeightHintText(line.amountG, disp.kind)}</p>`
        : '';
      return `
        <div class="re-row" data-row-index="${idx}">
          <div class="re-row-main">
            <span class="re-row-name">${_esc(name)}${ingredient?.brand ? ` <span class="diet-search-result-brand">· ${_esc(ingredient.brand)}</span>` : ''}</span>
            <span class="re-row-kcal" id="re-row-kcal-${idx}">${kcal} kcal</span>
          </div>
          ${unitToggle}
          <div class="re-row-controls">
            <input type="number" min="0" step="any" inputmode="decimal" class="input re-row-amount"
                   data-row-index="${idx}" value="${_round1(disp.value)}" aria-label="${amountAriaLabel}">
            ${unitControl}
            <button type="button" class="btn btn-ghost re-row-remove" data-row-index="${idx}" title="Remove" aria-label="Remove">
              <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg>
            </button>
          </div>
          ${weightHint}
        </div>
      `;
    }).join('');
  }

  _renderFoot() {
    const foot = this._container.querySelector('#re-foot');
    const split = macroCalorieSplit(this._perServing());
    const totalKcal = Math.round(split.proteinKcal + split.carbsKcal + split.fatKcal);
    const canSave = this._draft.name.trim().length > 0 && this._draft.ingredients.length > 0;

    foot.innerHTML = `
      <span class="setup-flow-total re-per-serving">
        ${totalKcal} kcal/serving · P ${Math.round(split.proteinKcal / 4)}g ·
        C ${Math.round(split.carbsKcal / 4)}g · F ${Math.round(split.fatKcal / 9)}g
      </span>
      <button class="btn btn-ghost" id="re-cancel">Cancel</button>
      <button class="btn btn-ghost" id="re-print" ${canSave ? '' : 'disabled title="Add a name and at least one ingredient to print"'}>Print</button>
      <button class="btn btn-glass-cta" id="re-save" ${canSave ? '' : 'disabled'}>Save Recipe</button>
    `;
    foot.querySelector('#re-cancel').addEventListener('click', () => this._cancel());
    foot.querySelector('#re-save').addEventListener('click', () => this._save());
    // Prints the in-progress draft as-is — no Save required first. perServing
    // isn't written onto the draft itself until _save() runs, so a fresh
    // copy carrying the live total (this._perServing(), the same figure the
    // "kcal/serving" readout above is already showing) is handed to the
    // print sheet instead, alongside a sync lookup bound to this editor's
    // own ingredient cache (see ui/recipe-print.js's `lookup` option).
    foot.querySelector('#re-print').addEventListener('click', () => {
      this._onPrint?.({ ...this._draft, perServing: this._perServing() }, { lookup: id => this._lookup(id) });
    });
  }

  /** Targeted refresh after an amount edit or row add/remove — updates the
   *  footer totals (and, for an amount edit, that one row's kcal readout
   *  and weight-equivalent hint) without rebuilding the whole row list, so
   *  an in-progress edit in an amount input never loses focus
   *  mid-keystroke. The hint's "kind" comes from this._rowDisplayUnits,
   *  which _renderRows() last set — it doesn't change between renders
   *  (only which sizeOptions entry a size row reads against does, and
   *  that never touches amountG — see _rowDisplay()'s doc comment), so
   *  it's still accurate here. */
  _refreshTotals(changedRowIndex = null) {
    if (changedRowIndex != null) {
      const line = this._draft.ingredients[changedRowIndex];
      const ingredient = line ? this._lookup(line.ingredientId) : null;
      const kcalEl = this._container.querySelector(`#re-row-kcal-${changedRowIndex}`);
      if (kcalEl && ingredient) {
        kcalEl.textContent = `${Math.round((ingredient.perHundredG.calories ?? 0) * line.amountG / 100)} kcal`;
      }
      const hintEl = this._container.querySelector(`#re-row-weight-hint-${changedRowIndex}`);
      if (hintEl && line) {
        const kind = this._rowDisplayUnits[changedRowIndex]?.kind;
        hintEl.textContent = this._rowWeightHintText(line.amountG, kind);
      }
    }
    this._renderFoot();
  }

  // ─── Bind ───────────────────────────────────────────────────────────────

  _bindBodyEvents() {
    const $ = sel => this._container.querySelector(sel);
    const d = this._draft;

    $('#re-name')?.addEventListener('input', e => { d.name = e.target.value; this._renderFoot(); });
    $('#re-servings')?.addEventListener('input', e => { d.servings = e.target.value; this._renderFoot(); });
    $('#re-cuisine')?.addEventListener('input', e => { d.cuisine = e.target.value.trim() || null; });

    $('.re-search-input')?.addEventListener('input', e => {
      this._searchQuery = e.target.value;
      this._runSearch(this._searchQuery);
    });
    this._bindSearchResults();

    this._container.querySelectorAll('.re-row-amount').forEach(input => {
      input.addEventListener('input', e => {
        const idx = Number(input.dataset.rowIndex);
        const raw = Number(e.target.value);
        if (!isFinite(raw) || raw < 0) return;

        // Convert back through whichever unit this row was showing as of
        // the last render, not whatever mlToDisplayVolume() would pick for
        // `raw` right now — same reason the row's amount input itself
        // isn't reformatted mid-keystroke (see module doc comment):
        // re-picking the unit on every keystroke would make the number the
        // rider is mid-typing jump between tsp/tbsp/cup under their cursor.
        const disp = this._rowDisplayUnits[idx];
        const ingredient = this._lookup(d.ingredients[idx].ingredientId);
        if (disp?.kind === 'volume' && ingredient?.densityGPerMl != null) {
          d.ingredients[idx].amountG = (displayVolumeToMl(raw, disp.unit) ?? 0) * ingredient.densityGPerMl;
        } else if (disp?.kind === 'size' && ingredient?.sizeOptions?.length) {
          d.ingredients[idx].amountG = gramsForSizeOption(ingredient, disp.unit, raw) ?? 0;
        } else {
          d.ingredients[idx].amountG = displayWeightToG(raw, this._profile.units);
        }
        // Keep the unit label's singular/plural in sync with what the
        // rider is typing, same "targeted DOM patch, no full re-render"
        // approach as the kcal/weight-hint updates below — re-picking the
        // unit itself still waits for the next full render (see this
        // handler's own doc comment above), only the word's plural-ness
        // tracks live. A size or volume row's unit lives in its own
        // <select>, not this span, so it's untouched here — only a plain
        // weight row's bare label needs this live patch.
        if (disp?.kind === 'weight') {
          const unitEl = this._container.querySelector(`.diet-amount-unit[data-row-index="${idx}"]`);
          if (unitEl) unitEl.textContent = pluralizeUnit(disp.label, raw);
        }
        this._refreshTotals(idx);
      });
    });

    // The per-row Weight/Volume/Size toggle — picking a new mode never
    // changes amountG (the canonical figure every row stores), only which
    // unit it's read against next, so this just records the choice and
    // lets the next render re-derive everything through _rowDisplay() —
    // same "switching modes re-expresses the same amount, doesn't change
    // it" idea the sizeOptions-entry switch below already uses. Writing
    // the choice onto line.unitMode (not just this._rowUnitMode) is what
    // makes it survive Save and reopen the same way next time, mirroring
    // line.sizeOptionId. A full _renderBody() (rather than the targeted
    // DOM patch other row edits use) is fine here since this is a click,
    // not an in-progress keystroke that could lose focus.
    this._container.querySelectorAll('.re-row-unit-mode .segmented-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.rowIndex);
        const mode = btn.dataset.mode;
        const line = d.ingredients[idx];
        if (!line || this._rowUnitMode[idx] === mode) return;
        this._rowUnitMode[idx] = mode;
        line.unitMode = mode;
        this._renderBody();
      });
    });

    // Forcing a specific cooking-measure unit within Volume mode (e.g.
    // "cup" instead of whatever mlToDisplayVolume() would've auto-picked)
    // — same "re-express the same amountG against the newly-picked unit,
    // never change the amount itself" idea as the sizeOptions-entry switch
    // just below, and the same targeted DOM patch (no full re-render, so
    // nothing else on the row loses its current state) rather than the
    // mode toggle's full re-render above, since picking a unit is the more
    // fine-grained, possibly-repeated adjustment. Persisted onto
    // line.volumeUnit so it survives Save/reopen, mirroring
    // line.sizeOptionId.
    this._container.querySelectorAll('.re-row-volume-unit').forEach(select => {
      select.addEventListener('change', () => {
        const idx = Number(select.dataset.rowIndex);
        const line = d.ingredients[idx];
        const ingredient = this._lookup(line?.ingredientId);
        if (!ingredient?.densityGPerMl) return;
        const unit = select.value;
        this._rowVolumeUnit[idx] = unit;
        line.volumeUnit = unit;
        const ml = line.amountG / ingredient.densityGPerMl;
        const value = mlToUnit(ml, unit);
        this._rowDisplayUnits[idx] = { value, unit, label: VOLUME_UNIT_LABELS[unit] ?? unit, kind: 'volume' };
        const amountInput = this._container.querySelector(`.re-row-amount[data-row-index="${idx}"]`);
        if (amountInput) amountInput.value = _round1(value);
      });
    });

    // Switching which sizeOptions entry a row is read against (e.g. "Medium"
    // → "Large") re-expresses the row's existing amountG as a count of the
    // newly-picked option — same as picking a different volume unit would,
    // if that were a manual choice here too — it never changes the amount
    // itself, only how many of the new unit that amount comes out to. The
    // choice is also written onto the line itself (line.sizeOptionId) so it
    // survives Save and this row reopens against the same option next time,
    // rather than reverting to the ingredient's first option.
    this._container.querySelectorAll('.re-row-size-option').forEach(select => {
      select.addEventListener('change', () => {
        const idx = Number(select.dataset.rowIndex);
        const line = d.ingredients[idx];
        const ingredient = this._lookup(line.ingredientId);
        const option = ingredient?.sizeOptions?.find(o => o.id === select.value);
        if (!option) return;
        this._rowSizeOptionId[idx] = option.id;
        line.sizeOptionId = option.id;
        this._rowDisplayUnits[idx] = { value: line.amountG / option.grams, unit: option.id, label: option.label, detail: option.detail ?? null, kind: 'size' };
        select.title = option.detail ?? '';
        const amountInput = this._container.querySelector(`.re-row-amount[data-row-index="${idx}"]`);
        if (amountInput) amountInput.value = _round1(line.amountG / option.grams);
      });
    });

    this._container.querySelectorAll('.re-row-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.rowIndex);
        d.ingredients.splice(idx, 1);
        this._rowSizeOptionId.splice(idx, 1);
        this._rowUnitMode.splice(idx, 1);
        this._rowVolumeUnit.splice(idx, 1);
        this._renderBody();
      });
    });

    // Steps/Method — plain text, no live totals depend on it (unlike an
    // ingredient row's amount), so an edit just writes straight into the
    // draft with no _refreshTotals()/_renderFoot() call needed. No
    // re-render on every keystroke either, same reasoning as the
    // ingredient amount inputs above: re-rendering the whole body on
    // 'input' would steal focus back out of the textarea mid-sentence.
    this._container.querySelectorAll('.re-step-text').forEach(textarea => {
      textarea.addEventListener('input', e => {
        const idx = Number(textarea.dataset.stepIndex);
        d.steps[idx] = e.target.value;
      });
    });

    this._container.querySelectorAll('.re-step-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.stepIndex);
        d.steps.splice(idx, 1);
        this._renderBody(); // renumbers the remaining rows' labels/data-step-index
      });
    });

    this._container.querySelector('.re-add-step')?.addEventListener('click', () => {
      d.steps.push('');
      this._renderBody();
      // Focus the newly-added (last) step's textarea, same "land the
      // cursor where the rider will type next" courtesy the search
      // input's own focus() call gets on open().
      const rows = this._container.querySelectorAll('.re-step-text');
      rows[rows.length - 1]?.focus();
    });
  }

  _bindSearchResults() {
    this._container.querySelectorAll('.re-search-result').forEach(btn =>
      btn.addEventListener('click', () => this._addRow(btn.dataset.ingredientId))
    );
    this._container.querySelector('.re-add-custom')?.addEventListener('click', () => this._addCustomIngredient());
  }

  async _addRow(ingredientId) {
    const ingredient = await this._repo.get(ingredientId);
    if (!ingredient) return;
    this._ingredientCache.set(ingredient.id, ingredient);
    this._draft.ingredients.push({ ingredientId: ingredient.id, amountG: DEFAULT_ROW_AMOUNT_G });
    this._rowSizeOptionId.push(null); // default (first option) picked at render, same as open()
    this._rowUnitMode.push(null);     // no manual mode yet — auto-pick decides, same as open()
    this._rowVolumeUnit.push(null);   // no manual volume unit yet — auto-pick decides, same as open()
    this._searchQuery = '';
    this._searchResults = [];
    this._renderBody();
  }

  async _addCustomIngredient() {
    if (!this._onAddCustomIngredient) return;
    const prefillName = this._searchQuery.trim();
    const ingredient = await this._onAddCustomIngredient(prefillName);
    if (!ingredient) return; // canceled
    await this._addRow(ingredient.id);
  }

  /** Debounced search restricted to the results dropdown, same reasoning
   *  as views/diet.js's _runSearch() — a full _renderBody() on every
   *  keystroke would steal focus back out of the search input. */
  _runSearch(query) {
    clearTimeout(this._searchDebounce);
    const q = query.trim();
    if (!q) {
      this._searchResults = [];
      this._updateSearchResultsDom();
      return;
    }
    this._searchDebounce = setTimeout(async () => {
      const token = ++this._searchToken;
      const results = await this._repo.search(q);
      if (token !== this._searchToken) return;
      this._searchResults = results;
      this._updateSearchResultsDom();
    }, SEARCH_DEBOUNCE_MS);
  }

  _updateSearchResultsDom() {
    const el = this._container.querySelector('#re-search-results');
    if (!el) return;
    el.innerHTML = this._renderSearchResults();
    this._bindSearchResults();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function _deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function _round1(v) { return v == null ? v : Math.round(v * 10) / 10; }

function _esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export default RecipeEditor;
