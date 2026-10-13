// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * views/diet-log-sheet.js
 *
 * The Diet tab's log sheet: logging an ingredient or a recipe happens in the shared detail sheet
 * (ui/detail-sheet.js), not in a form that drops down inside the page. Everything that opens a log form
 * lands here — a search result on Today (ingredient or recipe), an Ingredients tile, a recipe card's
 * "Log" button on Recipes.
 *
 *   ingredient:  [live nutrition preview]  [Weight | Volume | Size]  amount + unit  [meal]  Add to diary
 *   recipe:      [live nutrition preview]  servings                  [meal]                 Add to diary
 *
 * The live preview (kcal / protein / carbs / fat for the amount as typed) is what makes this a
 * *confirmation*: the rider sees what the diary will store before it is stored. Size mode also keeps its
 * "≈ N g total" line.
 *
 * What the numbers are is in views/diet-log-logic.js (pure, covered by __diet_log_logic_smoketest__.js);
 * this file is the DOM around it and holds the sheet's own draft state, so typing never re-renders the page
 * behind the scrim. Saving is the page's job: the sheet builds the diary entry and hands it to `onAdd`
 * (DietPage writes it and reloads), then closes itself.
 *
 * Usage (views/diet.js):
 *   const log = new DietLogSheet({ getUnits: () => profile.units, onAdd: async (entry) => { … } });
 *   log.openIngredient(ingredient);   // or log.openRecipe(recipe)
 *   log.close();                      // e.g. when the page resets
 */

import { detailSheet } from '../ui/detail-sheet.js';
import { MEAL_SLOTS } from '../core/nutrition-model.js';
import { VOLUME_UNITS, VOLUME_UNIT_LABELS, smallWeightUnitLabel } from '../metrics/units.js';
import {
  MEAL_SLOT_LABELS, initialIngredientForm, amountModes, switchMode, resolveAmountG, sizeHintText,
  parseServings, servingsUnitLabel, ingredientPreview, recipePreview, referenceLine, ingredientEntry, recipeEntry,
} from './diet-log-logic.js';

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODE_LABELS = { weight: 'Weight', volume: 'Volume', size: 'Size' };
const DASH = '\u2014';

export class DietLogSheet {
  /**
   * @param {Object} opts
   * @param {() => 'metric'|'imperial'} opts.getUnits  read each time the sheet opens, so a units change in Settings is picked up
   * @param {(entry: Object) => Promise<void>|void} opts.onAdd  called with the finished diary entry; the sheet closes once it resolves
   */
  constructor({ getUnits, onAdd } = {}) {
    this._getUnits = getUnits ?? (() => 'metric');
    this._onAdd = onAdd ?? (() => {});
    this._handle = null;
    this._body = null;
    this._token = 0;       // a newer open() took over -> an older sheet's onClose must not clear the new state
    this._kind = null;     // 'ingredient' | 'recipe'
    this._item = null;
    this._units = 'metric';
    this._form = null;     // ingredient: { mode, value, volumeUnit, sizeOptionId, mealSlot }
    this._servings = '1';  // recipe: the servings field, as typed
    this._mealSlot = MEAL_SLOTS.SNACK;   // recipe's meal; an ingredient's lives in _form
    this._busy = false;
  }

  get isOpen() { return !!this._handle?.isOpen; }

  openIngredient(ingredient) {
    if (!ingredient) return;
    this._units = this._getUnits();
    this._form = initialIngredientForm(ingredient, this._units);
    this._open('ingredient', ingredient);
  }

  openRecipe(recipe) {
    if (!recipe) return;
    this._units = this._getUnits();
    this._servings = '1';
    this._mealSlot = MEAL_SLOTS.SNACK;
    this._open('recipe', recipe);
  }

  close() { this._handle?.close(); }

  // ─── Open / state ───────────────────────────────────────────────────────

  _open(kind, item) {
    this._kind = kind;
    this._item = item;
    this._busy = false;
    const token = ++this._token;
    this._handle = detailSheet.open({
      title: item.name,
      subtitle: referenceLine(kind, item),
      size: 'auto',
      content: (body) => { this._body = body; this._render(); },
      onClose: () => {
        if (token !== this._token) return;   // a newer open() already replaced this one
        this._handle = null; this._body = null; this._kind = null; this._item = null; this._form = null;
      },
    });
    // An empty field needs typing, so put the cursor there; a pre-filled one (a recipe's 1 serving, an
    // ingredient's size count of 1) is ready to confirm as it is.
    const input = this._body?.querySelector('.dls-amount');
    if (input && input.value === '') input.focus();
  }

  _servingsNumber() { return parseServings(this._servings); }

  /** The grams (ingredient) or servings (recipe) the form resolves to right now, or null. */
  _resolved() {
    if (this._kind === 'ingredient') return resolveAmountG(this._item, this._form, this._units);
    return this._item.perServing == null ? null : this._servingsNumber();
  }

  _preview() {
    const v = this._resolved();
    if (v == null) return null;
    return this._kind === 'ingredient' ? ingredientPreview(this._item, v) : recipePreview(this._item, v);
  }

  _mealSlotNow() { return this._kind === 'ingredient' ? this._form.mealSlot : this._mealSlot; }

  // ─── Render ─────────────────────────────────────────────────────────────

  _chipsHtml(p) {
    const val = (n) => (p ? n : DASH);
    return `
      <div class="stat-chip" data-metric="calories"><span class="stat-val">${val(p?.kcal)}</span><span class="stat-lbl">KCAL</span></div>
      <div class="stat-chip" data-metric="protein"><span class="stat-val">${val(p?.protein)}</span><span class="stat-lbl">PROTEIN (G)</span></div>
      <div class="stat-chip" data-metric="carbs"><span class="stat-val">${val(p?.carbs)}</span><span class="stat-lbl">CARBS (G)</span></div>
      <div class="stat-chip" data-metric="fat"><span class="stat-val">${val(p?.fat)}</span><span class="stat-lbl">FAT (G)</span></div>`;
  }

  _ingredientControlsHtml() {
    const ing = this._item, f = this._form, units = this._units;
    const modes = amountModes(ing);
    const hasSizes = ing.sizeOptions?.length > 0;
    const unitControl = f.mode === 'volume' && ing.densityGPerMl != null
      ? `<select class="input diet-volume-unit dls-volume-unit" aria-label="Volume unit">${VOLUME_UNITS[units].map(u =>
          `<option value="${_esc(u)}" ${u === f.volumeUnit ? 'selected' : ''}>${_esc(VOLUME_UNIT_LABELS[u])}</option>`).join('')}</select>`
      : f.mode === 'size' && hasSizes
        // Each option carries its cut/prep detail as a title (e.g. "roughly ½-inch pieces"), and the control's own
        // title previews the picked one — same as ui/recipe-editor.js's size select.
        ? `<select class="input diet-size-option dls-size-option" aria-label="Size" title="${_esc(ing.sizeOptions.find(o => o.id === f.sizeOptionId)?.detail ?? '')}">${ing.sizeOptions.map(o =>
            `<option value="${_esc(o.id)}" ${o.id === f.sizeOptionId ? 'selected' : ''} ${o.detail ? `title="${_esc(o.detail)}"` : ''}>${_esc(o.label)}</option>`).join('')}</select>`
        : `<span class="diet-amount-unit">${_esc(smallWeightUnitLabel(units))}</span>`;
    return `
      ${modes.length > 1 ? `
        <div class="segmented diet-amount-mode segmented-full" role="group" aria-label="Amount type">
          ${modes.map(m => `<button type="button" class="segmented-btn ${f.mode === m ? 'active' : ''}" data-mode="${m}" aria-pressed="${f.mode === m}">${MODE_LABELS[m]}</button>`).join('')}
        </div>` : ''}
      <div class="diet-amount-row">
        <input type="number" min="0" step="any" inputmode="decimal" class="input diet-amount-input dls-amount"
               aria-label="${f.mode === 'size' ? 'Count' : 'Amount'}" placeholder="${f.mode === 'size' ? 'Count' : 'Amount'}" value="${_esc(f.value)}">
        ${unitControl}
      </div>
      ${f.mode === 'size' && hasSizes ? `<p class="settings-sub dls-hint">${_esc(sizeHintText(this._resolved(), units))}</p>` : ''}`;
  }

  _recipeControlsHtml() {
    const raw = this._servingsNumber();
    return `
      <div class="diet-amount-row">
        <input type="number" min="0" step="any" inputmode="decimal" class="input diet-amount-input dls-amount"
               aria-label="Servings" placeholder="Servings" value="${_esc(this._servings)}">
        <span class="diet-amount-unit dls-servings-unit">${servingsUnitLabel(raw)}</span>
      </div>
      ${this._item.perServing == null ? '<p class="settings-sub dls-hint">Add ingredients to this recipe to log it.</p>' : ''}`;
  }

  _render() {
    if (!this._body) return;
    const slot = this._mealSlotNow();
    this._body.innerHTML = `
      <div class="diet-log-sheet">
        <div class="history-card-stats dls-preview" role="group" aria-label="Nutrition for this amount">${this._chipsHtml(this._preview())}</div>
        ${this._kind === 'ingredient' ? this._ingredientControlsHtml() : this._recipeControlsHtml()}
        <div class="segmented diet-meal-slot segmented-full" role="group" aria-label="Meal">
          ${Object.values(MEAL_SLOTS).map(s =>
            `<button type="button" class="segmented-btn ${slot === s ? 'active' : ''}" data-slot="${s}" aria-pressed="${slot === s}">${_esc(MEAL_SLOT_LABELS[s])}</button>`).join('')}
        </div>
        <button type="button" class="btn btn-primary full-width dls-add" ${this._resolved() != null ? '' : 'disabled'}>Add to diary</button>
      </div>`;
    this._bind();
  }

  /** Updates what a keystroke or a select change affects, in place — a full _render() on every keystroke
   *  would take focus back out of the field being typed in. */
  _patch() {
    if (!this._body) return;
    const q = (s) => this._body.querySelector(s);
    const p = this._preview();
    const preview = q('.dls-preview');
    if (preview) preview.innerHTML = this._chipsHtml(p);
    const add = q('.dls-add');
    if (add) add.disabled = this._busy || this._resolved() == null;
    if (this._kind === 'ingredient') {
      const hint = q('.dls-hint');
      if (hint) hint.textContent = sizeHintText(this._resolved(), this._units);
      const sel = q('.dls-size-option');
      if (sel) sel.title = this._item.sizeOptions.find(o => o.id === this._form.sizeOptionId)?.detail ?? '';
    } else {
      const unit = q('.dls-servings-unit');
      if (unit) unit.textContent = servingsUnitLabel(this._servingsNumber());
    }
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  _bind() {
    const q = (s) => this._body.querySelector(s);
    const input = q('.dls-amount');

    input?.addEventListener('input', (e) => {
      if (this._kind === 'ingredient') this._form.value = e.target.value; else this._servings = e.target.value;
      this._patch();
    });
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._confirm(); } });

    this._body.querySelectorAll('.diet-amount-mode .segmented-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        Object.assign(this._form, switchMode(this._form, btn.dataset.mode));
        this._render();
        this._body.querySelector('.dls-amount')?.focus();
      })
    );

    q('.dls-volume-unit')?.addEventListener('change', (e) => { this._form.volumeUnit = e.target.value; this._patch(); });
    q('.dls-size-option')?.addEventListener('change', (e) => { this._form.sizeOptionId = e.target.value; this._patch(); });

    this._body.querySelectorAll('.diet-meal-slot .segmented-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        if (this._kind === 'ingredient') this._form.mealSlot = btn.dataset.slot; else this._mealSlot = btn.dataset.slot;
        this._body.querySelectorAll('.diet-meal-slot .segmented-btn').forEach(b => {
          const on = b === btn;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', String(on));
        });
      })
    );

    q('.dls-add')?.addEventListener('click', () => this._confirm());
  }

  /** The finished diary entry for what the form says, or null while it is not valid. */
  _entry() {
    const v = this._resolved();
    if (v == null) return null;
    return this._kind === 'ingredient'
      ? ingredientEntry(this._item, v, this._form.mealSlot)
      : recipeEntry(this._item, v, this._mealSlot);
  }

  async _confirm() {
    if (this._busy) return;
    const entry = this._entry();
    if (!entry) return;
    this._busy = true;
    this._patch();   // disables Add while the save is in flight, so a double tap cannot log twice
    try {
      await this._onAdd(entry);
      this.close();
    } catch (err) {
      console.error('[diet-log-sheet] could not add the entry', err);
      this._busy = false;
      this._patch();
    }
  }
}
