// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/ingredient-editor.js
 *
 * Custom ingredient editor — a modal form producing an `Ingredient` in
 * core/nutrition-model.js's canonical shape, `id` prefixed `custom:`.
 * DIET_PANEL_DESIGN.md §10.
 *
 * Same full-screen overlay shape as ui/cardio-session-flow.js / ui/ble-debug-
 * flow.js (a #container.setup-flow host, hidden by default, populated once
 * in the constructor, toggled via open()/close(), Escape/backdrop-click
 * both cancel) — but unlike those two, this one is a shared singleton with
 * no fixed purpose of its own: it's reachable from two different places
 * (the Recipes tab's "+ Custom Ingredient" button, and the diary quick-
 * add's "can't find it?" fallback in views/diet.js), each of which needs
 * its own "what do I do once this ingredient is saved" behavior. So rather
 * than a constructor-level onSave callback, open() itself takes
 * { onSaved, onCancel } — one instance, many callers, each open() call
 * says what happens next. ui/recipe-editor.js's per-row "add a custom
 * ingredient" fallback is a third caller of this same instance, wired
 * through app.js the same way (see openIngredientEditorFor() there).
 *
 * Fields are grouped to match core/nutrition-model.js's NutrientProfile
 * shape: Macros (calories/protein/carbs/fat — the common case, always
 * visible) then Carb breakdown / Fat breakdown / Vitamins / Minerals as
 * collapsible <details> sections (style.css's existing .settings-details
 * pattern, the same one Settings → Keyboard Shortcuts/Developer already
 * use) so fixing a brand's calories doesn't force scrolling through every
 * vitamin field.
 *
 * Usage:
 *   const ingredientEditor = new IngredientEditor($('ingredient-editor-flow'));
 *   ingredientEditor.open({
 *     prefillName: 'Trader Joe's Granola',   // or ingredient: <existing custom Ingredient> to edit
 *     onSaved: (ingredient) => { ... },       // called after db.saveCustomIngredient() resolves
 *     onCancel: () => { ... },                // called on Escape/backdrop/Cancel — optional
 *   });
 */

import { db } from '../storage/db.js';
import { createIngredient } from '../core/nutrition-model.js';

// ─── Field group definitions ────────────────────────────────────────────────
// Each entry drives both the <input> markup and the draft read/write path —
// adding a nutrient later (e.g. a new vitamin) is a one-line addition here,
// not a new hand-wired listener.

const MACRO_FIELDS = [
  { path: 'calories',    label: 'Calories',  unit: 'kcal' },
  { path: 'protein',     label: 'Protein',   unit: 'g' },
  { path: 'carbs.total', label: 'Carbs',     unit: 'g' },
  { path: 'fat.total',   label: 'Fat',       unit: 'g' },
];
const CARB_BREAKDOWN_FIELDS = [
  { path: 'carbs.sugar',  label: 'Sugar',  unit: 'g' },
  { path: 'carbs.fiber',  label: 'Fiber',  unit: 'g' },
  { path: 'carbs.starch', label: 'Starch', unit: 'g' },
];
const FAT_BREAKDOWN_FIELDS = [
  { path: 'fat.saturated',       label: 'Saturated',       unit: 'g' },
  { path: 'fat.monounsaturated', label: 'Monounsaturated', unit: 'g' },
  { path: 'fat.polyunsaturated', label: 'Polyunsaturated', unit: 'g' },
  { path: 'fat.trans',           label: 'Trans',           unit: 'g' },
];
const VITAMIN_FIELDS = [
  { path: 'vitamins.aMcg',      label: 'Vitamin A',  unit: 'mcg' },
  { path: 'vitamins.cMg',       label: 'Vitamin C',  unit: 'mg' },
  { path: 'vitamins.dMcg',      label: 'Vitamin D',  unit: 'mcg' },
  { path: 'vitamins.eMg',       label: 'Vitamin E',  unit: 'mg' },
  { path: 'vitamins.kMcg',      label: 'Vitamin K',  unit: 'mcg' },
  { path: 'vitamins.b1Mg',      label: 'B1 (Thiamin)',    unit: 'mg' },
  { path: 'vitamins.b2Mg',      label: 'B2 (Riboflavin)', unit: 'mg' },
  { path: 'vitamins.b3Mg',      label: 'B3 (Niacin)',     unit: 'mg' },
  { path: 'vitamins.b6Mg',      label: 'B6',              unit: 'mg' },
  { path: 'vitamins.b12Mcg',    label: 'B12',             unit: 'mcg' },
  { path: 'vitamins.folateMcg', label: 'Folate',          unit: 'mcg' },
];
// Sodium/cholesterol/potassium live at the top level of NutrientProfile
// rather than nested under a sub-object (see nutrition-model.js's
// createEmptyNutrients()) — grouped here with the named minerals since
// there's no sixth collapsible section for them in the design and they're
// the same "electrolyte/mineral-adjacent" tier of least-common-need as
// calcium/iron/magnesium/zinc.
const MINERAL_FIELDS = [
  { path: 'sodiumMg',        label: 'Sodium',      unit: 'mg' },
  { path: 'cholesterolMg',   label: 'Cholesterol', unit: 'mg' },
  { path: 'potassiumMg',     label: 'Potassium',   unit: 'mg' },
  { path: 'minerals.calciumMg',   label: 'Calcium',   unit: 'mg' },
  { path: 'minerals.ironMg',      label: 'Iron',      unit: 'mg' },
  { path: 'minerals.magnesiumMg', label: 'Magnesium', unit: 'mg' },
  { path: 'minerals.zincMg',      label: 'Zinc',      unit: 'mg' },
];

function _getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}
function _setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

export class IngredientEditor {
  /** @param {HTMLElement} container  Full-screen overlay host (hidden by default). */
  constructor(container) {
    this._container = container;
    this._draft = null;      // Ingredient being edited — set fresh by each open()
    this._onSaved = null;
    this._onCancel = null;

    this._renderShell();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * @param {Object}      [opts]
   * @param {Ingredient}  [opts.ingredient]    Existing custom ingredient to edit; omit to create new.
   * @param {string}      [opts.prefillName]   Seeds the name field for a new ingredient (e.g. the
   *   diary quick-add search query that came up empty) — ignored when opts.ingredient is set.
   * @param {Function}    [opts.onSaved]       (savedIngredient) => void — called after the save lands.
   * @param {Function}    [opts.onCancel]      () => void — called on Escape/backdrop/Cancel.
   */
  open({ ingredient = null, prefillName = '', onSaved, onCancel } = {}) {
    this._draft = ingredient
      ? _deepClone(ingredient)
      : createIngredient({ name: prefillName });
    this._onSaved = onSaved ?? null;
    this._onCancel = onCancel ?? null;
    this._isEditing = ingredient != null;

    this._container.classList.remove('hidden');
    this._renderBody();
    this._container.querySelector('#ie-name')?.focus();
  }

  close() {
    this._container.classList.add('hidden');
  }

  // ─── Shell (built once) ─────────────────────────────────────────────────

  _renderShell() {
    this._container.classList.add('setup-flow', 'hidden');
    this._container.innerHTML = `
      <div class="setup-flow-card">
        <div class="setup-flow-head">
          <span class="setup-flow-head-title" id="ie-head-title">Custom Ingredient</span>
          <button class="setup-flow-close" id="ie-close" title="Cancel" aria-label="Cancel">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg>
          </button>
        </div>
        <div class="setup-flow-body" id="ie-body"></div>
        <div class="setup-flow-foot">
          <button class="btn btn-ghost" id="ie-cancel">Cancel</button>
          <button class="btn btn-glass-cta" id="ie-save">Save Ingredient</button>
        </div>
      </div>
    `;

    this._container.querySelector('#ie-close').addEventListener('click', () => this._cancel());
    this._container.querySelector('#ie-cancel').addEventListener('click', () => this._cancel());
    this._container.querySelector('#ie-save').addEventListener('click', () => this._save());

    this._container.addEventListener('click', e => {
      if (e.target === this._container) this._cancel();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this._container.classList.contains('hidden')) this._cancel();
    });
  }

  _cancel() {
    this.close();
    this._onCancel?.();
  }

  async _save() {
    const d = this._draft;
    d.name = (d.name ?? '').trim();
    if (!d.name) return;
    d.brand = (d.brand ?? '').trim() || null;

    // Drop any size row left blank (e.g. "+ Add Size" clicked, then never
    // filled in before Save) rather than persisting a useless entry the
    // amount-entry picker would show with an empty label.
    if (d.sizeOptions) {
      d.sizeOptions = d.sizeOptions
        .map(o => ({ ...o, label: (o.label ?? '').trim() }))
        .filter(o => o.label && o.grams > 0);
      if (!d.sizeOptions.length) d.sizeOptions = null;
    }

    const saved = await db.saveCustomIngredient(d);
    this.close();
    this._onSaved?.(saved);
  }

  // ─── Body ───────────────────────────────────────────────────────────────

  _renderBody() {
    const d = this._draft;
    this._container.querySelector('#ie-head-title').textContent =
      this._isEditing ? 'Edit Custom Ingredient' : 'New Custom Ingredient';

    const body = this._container.querySelector('#ie-body');
    body.innerHTML = `
      <label class="sf-field">
        <span>Name</span>
        <input class="input full-width" id="ie-name" placeholder="e.g. Trader Joe's Granola" value="${_esc(d.name)}">
      </label>
      <label class="sf-field">
        <span>Brand <span class="settings-sub">(optional)</span></span>
        <input class="input full-width" id="ie-brand" placeholder="e.g. Trader Joe's" value="${_esc(d.brand ?? '')}">
      </label>
      <label class="sf-field">
        <span>Density <span class="settings-sub">(optional — g per mL; for anything measured by cup/spoon rather than scale: pourable liquids like oils or milk, dry powders like flour or cocoa, or soft solids like peanut butter. Set this to let this ingredient be logged by volume too, with units — tsp/tbsp/fl oz/cup — matching the amount.)</span></span>
        <input type="number" min="0" step="any" inputmode="decimal" class="input full-width" id="ie-density"
               placeholder="e.g. 0.92 for olive oil, 0.53 for flour" value="${d.densityGPerMl ?? ''}">
      </label>

      <div class="sf-field">
        <span>Common Sizes <span class="settings-sub">(optional — e.g. "Small"/"Medium"/"Large", "Clove", "Slice", "Cup, Chopped". Lets this be logged as a count instead of a typed weight — see the label's placeholder text below for the naming convention. If a size is a cut/prep form rather than a whole item — chopped, sliced, diced, shredded, crumbled — add a Detail note so whoever's logging it knows what size the cut is, e.g. "½-inch dice".)</span></span>
        <div class="ie-size-list" id="ie-size-list">${this._sizeOptionsHtml()}</div>
        <button type="button" class="btn btn-ghost btn-sm" id="ie-add-size">+ Add Size</button>
      </div>

      <p class="settings-sub ie-per100-note">Every value below is per 100&nbsp;g${d.densityGPerMl != null ? ' / 100 mL' : ''}, the amount you actually log gets scaled from this automatically.</p>

      <div class="ie-field-grid">${this._fieldsHtml(MACRO_FIELDS)}</div>

      ${this._detailsSection('Carb breakdown', 'ie-carb', CARB_BREAKDOWN_FIELDS)}
      ${this._detailsSection('Fat breakdown', 'ie-fat', FAT_BREAKDOWN_FIELDS)}
      ${this._detailsSection('Vitamins', 'ie-vit', VITAMIN_FIELDS)}
      ${this._detailsSection('Minerals', 'ie-min', MINERAL_FIELDS)}
    `;
    this._bindBodyEvents();
  }

  /** core/nutrition-model.js's Ingredient.sizeOptions, editable as a plain
   *  add/remove list (label + grams-for-one) rather than a fixed Small/
   *  Medium/Large shape — a custom ingredient might just as easily want
   *  "Clove" or "Cup, Chopped" as it would "Small/Medium/Large", same
   *  variety the bundled seed set's own curated entries use (see
   *  data/nutrition/ingredients.json). Labels are written without a
   *  leading count ("Medium", not "1 medium") — see
   *  core/nutrition-model.js#gramsForSizeOption()'s doc comment for why;
   *  the placeholder text below is the only place that convention gets
   *  explained to whoever's actually filling the field in. */
  _sizeOptionsHtml() {
    const opts = this._draft.sizeOptions ?? [];
    if (!opts.length) return `<p class="settings-sub ie-size-empty">No sizes added yet.</p>`;
    return opts.map((o, i) => `
      <div class="ie-size-row" data-size-idx="${i}">
        <div class="ie-size-row-main">
          <input class="input ie-size-label" placeholder="e.g. Medium, Clove, Cup, Chopped" value="${_esc(o.label)}">
          <input type="number" min="0" step="any" inputmode="decimal" class="input input-num ie-size-grams" placeholder="grams" value="${o.grams ?? ''}">
          <button type="button" class="btn btn-ghost btn-sm ie-size-remove" title="Remove" aria-label="Remove this size">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg>
          </button>
        </div>
        <input class="input full-width ie-size-detail" placeholder="Detail (optional) — e.g. roughly ½-inch pieces" value="${_esc(o.detail ?? '')}">
      </div>
    `).join('');
  }

  _detailsSection(title, idPrefix, fields) {
    return `
      <details class="settings-group settings-details ie-details" id="${idPrefix}-details">
        <summary class="settings-group-head">
          <h2 class="settings-group-title">${title}</h2>
          <svg class="btn-icon settings-details-chevron" viewBox="0 0 24 24"><use href="#icon-chevron-down"/></svg>
        </summary>
        <div class="ie-field-grid">${this._fieldsHtml(fields)}</div>
      </details>
    `;
  }

  _fieldsHtml(fields) {
    const d = this._draft;
    return fields.map(f => `
      <label class="sf-field ie-subfield">
        <span>${f.label} <span class="settings-sub">(${f.unit})</span></span>
        <input type="number" min="0" step="any" inputmode="decimal" class="input full-width ie-input"
               data-path="${f.path}" value="${_getPath(d.perHundredG, f.path) ?? 0}">
      </label>
    `).join('');
  }

  _bindBodyEvents() {
    const $ = sel => this._container.querySelector(sel);
    const d = this._draft;

    $('#ie-name')?.addEventListener('input', e => { d.name = e.target.value; });
    $('#ie-brand')?.addEventListener('input', e => { d.brand = e.target.value; });
    $('#ie-density')?.addEventListener('input', e => {
      const v = e.target.value;
      d.densityGPerMl = v === '' ? null : Number(v);
    });

    $('#ie-add-size')?.addEventListener('click', () => {
      d.sizeOptions = [...(d.sizeOptions ?? []), { id: _newSizeOptionId(), label: '', grams: 0 }];
      this._container.querySelector('#ie-size-list').innerHTML = this._sizeOptionsHtml();
      this._bindSizeOptionRows();
    });
    this._bindSizeOptionRows();

    this._container.querySelectorAll('.ie-input').forEach(input => {
      input.addEventListener('input', e => {
        const raw = Number(e.target.value);
        _setPath(d.perHundredG, input.dataset.path, isFinite(raw) ? raw : 0);
      });
    });
  }

  /** Re-bound after every add/remove (see _bindBodyEvents()'s #ie-add-size
   *  handler) since those patch #ie-size-list's innerHTML directly rather
   *  than going through the full _renderBody() — same targeted-DOM-patch
   *  reasoning ie-input above skips for a full re-render: typing a label
   *  or a gram figure shouldn't re-render the whole form out from under
   *  the rider's cursor. Remove is the one row action that does need a
   *  fresh render (the list shrinks by one and every row after it shifts
   *  index), so it goes through the same patch-and-rebind path Add uses. */
  _bindSizeOptionRows() {
    const d = this._draft;
    this._container.querySelectorAll('.ie-size-row').forEach(row => {
      const idx = Number(row.dataset.sizeIdx);
      row.querySelector('.ie-size-label')?.addEventListener('input', e => {
        d.sizeOptions[idx].label = e.target.value;
      });
      row.querySelector('.ie-size-grams')?.addEventListener('input', e => {
        const raw = Number(e.target.value);
        d.sizeOptions[idx].grams = isFinite(raw) ? raw : 0;
      });
      // Same "absent, not an empty string" convention as sizeOptions itself
      // going null when the list empties out (see the remove handler below)
      // — a blank Detail field should disappear from the saved option
      // entirely rather than round-trip as detail: ''.
      row.querySelector('.ie-size-detail')?.addEventListener('input', e => {
        const value = e.target.value.trim();
        if (value) d.sizeOptions[idx].detail = value;
        else delete d.sizeOptions[idx].detail;
      });
      row.querySelector('.ie-size-remove')?.addEventListener('click', () => {
        d.sizeOptions.splice(idx, 1);
        if (!d.sizeOptions.length) d.sizeOptions = null; // same "absent, not an empty array" convention as a never-added list
        this._container.querySelector('#ie-size-list').innerHTML = this._sizeOptionsHtml();
        this._bindSizeOptionRows();
      });
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Structured-clone-shaped deep copy — editing the draft must never mutate
 *  the ingredient object the caller (e.g. views/diet.js's Recipes tab list)
 *  still has a reference to until Save actually commits. */
function _deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Unique within one ingredient's sizeOptions list — never shown to the
 *  rider (the <select> in views/diet.js's Size mode reads `label`, not
 *  `id`), so this just needs to not collide with another row in the same
 *  list, not be pretty. Assigned once when a row is added and never
 *  regenerated, including across edits — see _bindSizeOptionRows()'s doc
 *  comment. */
function _newSizeOptionId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function _esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export default IngredientEditor;
