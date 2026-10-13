// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/weigh-in-manager.js
 *
 * The weigh-in editor — a sheet (ui/detail-sheet.js) for finding, fixing and removing
 * weigh-ins that look wrong. Weigh-ins arrive from a Bluetooth scale the moment
 * a reading settles (app.js's _recordScaleMeasurement()), with no review step,
 * so one misread ends up on the Weight & Composition chart until something like
 * this removes it. What counts as "looks wrong", and how an edit form turns back
 * into a valid record, is all in metrics/weigh-in-review.js (pure, smoke-tested
 * in node); this file is only the DOM around it and the db calls.
 *
 * One instance of the shared detail sheet (ui/detail-sheet.js): open()
 * puts the editor in it, close() takes it away, and the sheet's own Close
 * button, scrim tap, Esc and drag-down all back out. One sheet, two views:
 * the LIST (flagged weigh-ins first, or all of them) and, from a row's
 * pencil, the EDIT form for that one weigh-in. Cancel/Esc/scrim/Close from
 * the edit form goes back to the list rather than closing everything (the
 * sheet's `beforeClose` hook), and the edit form pins Delete / Cancel /
 * Save to the sheet's foot. A "Profile settings" button in the sheet's
 * header (the `onOpenSettings` option) closes it and lands on Settings →
 * Profile → Body composition, where the Profile's own weight is kept.
 *
 * Two entry points call open(): the Weight & Composition card on the Overview
 * tab (views/overview.js — it shows how many readings look off), and Settings →
 * Profile → Body composition → Weigh-in history, which doesn't depend on the
 * Overview tab or on that card being ready.
 *
 * "May be wrong" is a hint, not a verdict: a real 4 kg swing after a long trip
 * is flagged the same as a misread, so nothing is ever changed without the rider
 * pressing Save or confirming a delete. That includes "Clear all that need
 * review" on the Needs review tab, which deletes every reading in that list in
 * one go (after a confirm that says real readings go too). There is no stored
 * "reviewed" state: a weigh-in needs review for as long as flagWeighIns() flags
 * it, so editing one that still looks odd leaves it in the list.
 *
 * This edits the weigh-in HISTORY only. The Profile's own weight and body
 * composition fields are a separate snapshot in the prefs store (a scale sync
 * fills the Profile form and autosaves it, revertable from the Settings tab's
 * autosave-pill — see app.js's _applyScaleReading()), so the list says so
 * rather than leaving a rider to assume deleting a bad reading also corrected
 * their profile.
 *
 * Usage:
 *   const weighInManager = new WeighInManager({
 *     profile,                                   // live object; only `.units` is read, at render time
 *     onChange: () => { overviewPage.load(); },  // after an edit or delete has been saved
 *     onOpenSettings: () => { ... },             // the sheet's "Profile settings" button (omit for none)
 *   });
 *   weighInManager.open();
 */

import { db } from '../storage/db.js';
import { detailSheet } from './detail-sheet.js';
import {
  flagWeighIns, isCertainlyWrong, describeFlag, weighInDraft, parseWeighInDraft, weighInHeadline, WEIGH_IN_FIELDS,
} from '../metrics/weigh-in-review.js';
import { weightUnitLabel } from '../metrics/units.js';
import { MEASUREMENT_SOURCES } from '../core/nutrition-model.js';

const FILTERS = Object.freeze({ REVIEW: 'review', ALL: 'all' });

export class WeighInManager {
  /**
   * @param {Object}   [opts]
   * @param {Object}   [opts.profile]   Live profile object (`units` is read each render).
   * @param {Function} [opts.onChange]  () => void — called after an edit or delete lands, so the
   *   caller can redraw whatever shows weigh-ins.
   * @param {Function} [opts.onOpenSettings]  () => void — the sheet's "Profile settings" button; the
   *   caller closes nothing itself (this button's handler is expected to close the sheet and navigate).
   */
  constructor({ profile, onChange, onOpenSettings } = {}) {
    this._profile = profile ?? { units: 'metric' };
    this._onChange = onChange ?? null;
    this._onOpenSettings = onOpenSettings ?? null;
    this._handle = null;             // the open detail-sheet handle, or null
    this._root = null;               // the editor's root element inside the sheet's body

    this._rows = [];                 // every weigh-in, newest first (db.getBodyMeasurements())
    this._flags = new Map();         // id -> WeighInFlag[] (metrics/weigh-in-review.js's flagWeighIns())
    this._filter = FILTERS.REVIEW;
    this._editing = null;            // { original, draft, errors } while the edit form is up
    this._notice = null;             // { text, error? } — one line above the list ("Weigh-in deleted.")
    this._loading = false;
    this._busy = false;              // a save/delete is in flight
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  get isOpen() { return !!this._handle?.isOpen; }

  /** Opens the sheet on the list, flagged weigh-ins first (or everything, if none are flagged). */
  async open() {
    this._editing = null;
    this._notice = null;
    this._loading = true;
    this._busy = false;
    const actions = this._onOpenSettings
      ? [{ id: 'open-settings', label: 'Profile settings', icon: 'icon-settings', showLabel: true,
           onClick: () => this._onOpenSettings() }]
      : [];
    this._handle = detailSheet.open({
      title: 'Weigh-ins',
      size: 'tall',
      flush: true,                                   // the editor scrolls its own body and pins its own foot
      actions,
      content: (body) => this._build(body),
      beforeClose: () => this._beforeClose(),
      onClose: () => { this._handle = null; this._root = null; this._editing = null; },
    });
    this._render();
    try {
      await this._load();
      this._filter = this._flags.size ? FILTERS.REVIEW : FILTERS.ALL;
    } catch (err) {
      console.error('[weigh-ins] load failed', err);
      this._notice = { text: 'Couldn’t load your weigh-ins.', error: true };
    } finally {
      this._loading = false;
    }
    this._render();   // a no-op if the sheet was closed while loading
  }

  close() {
    this._handle?.close();
  }

  // ─── Data ───────────────────────────────────────────────────────────────

  async _load() {
    this._rows = await db.getBodyMeasurements(); // newest first
    this._flags = flagWeighIns(this._rows);
  }

  // ─── Content (built each time the sheet opens) ──────────────────────────────────────

  _build(host) {
    host.innerHTML = `
      <div class="wi-sheet">
        <div class="wi-sheet-body" id="wi-body"></div>
        <div class="wi-sheet-foot hidden" id="wi-foot">
          <button class="btn btn-danger" id="wi-delete-edit">Delete</button>
          <span class="wi-foot-spacer"></span>
          <button class="btn btn-ghost" id="wi-back">Cancel</button>
          <button class="btn btn-glass-cta" id="wi-save">Save</button>
        </div>
      </div>
    `;
    this._root = host.querySelector('.wi-sheet');

    const $ = sel => this._root.querySelector(sel);
    $('#wi-back').addEventListener('click', () => this._back());
    $('#wi-save').addEventListener('click', () => this._save());
    $('#wi-delete-edit').addEventListener('click', () => {
      if (this._editing) this._delete(this._editing.original.id);
    });

    // Delegated: the body is re-rendered wholesale, so per-element listeners would need rebinding each time.
    const body = $('#wi-body');
    body.addEventListener('click', e => {
      const filterBtn = e.target.closest('[data-wi-filter]');
      if (filterBtn) { this._filter = filterBtn.dataset.wiFilter; this._render(); return; }
      if (e.target.closest('.wi-clear')) { this._clearFlagged(); return; }
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const id = Number(row.dataset.id);
      if (e.target.closest('.wi-edit')) this._beginEdit(id);
      else if (e.target.closest('.wi-delete')) this._delete(id);
    });
    // The form's values live in the draft as they're typed — no re-render per keystroke (it would
    // steal the cursor), same reasoning as ui/ingredient-editor.js.
    body.addEventListener('input', e => {
      const input = e.target.closest('.wi-input');
      if (input && this._editing) this._editing.draft[input.dataset.field] = input.value;
    });
    body.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.closest('.wi-input')) { e.preventDefault(); this._save(); }
    });

  }

  /** The sheet's Close button / scrim / Esc / drag-down all land here first: a save or delete in flight
   *  keeps the sheet up, the edit form steps back to the list, and only the list actually closes. */
  _beforeClose() {
    if (this._busy) return false;
    if (this._editing) { this._editing = null; this._render(); return false; }
    return true;
  }

  /** The Cancel button: out of the edit form to the list. */
  _back() {
    if (this._busy) return;
    if (this._editing) { this._editing = null; this._render(); }
    else this.close();
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  _render() {
    if (!this._root) return;                       // the sheet isn't open (or was closed mid-load)
    const $ = sel => this._root.querySelector(sel);
    const editing = this._editing;
    this._handle?.setTitle(editing ? 'Edit weigh-in' : 'Weigh-ins');
    $('#wi-foot').classList.toggle('hidden', !editing);
    $('#wi-body').innerHTML = editing ? this._editHtml() : this._listHtml();
    this._syncBusy();
  }

  _syncBusy() {
    if (!this._root) return;
    for (const id of ['#wi-save', '#wi-delete-edit', '#wi-back', '.wi-clear']) {
      const btn = this._root.querySelector(id);
      if (btn) btn.disabled = this._busy;
    }
  }

  _setBusy(busy) {
    this._busy = busy;
    this._syncBusy();
  }

  _listHtml() {
    if (this._loading) return `<p class="wi-empty">Loading\u2026</p>`;

    const units = this._profile.units;
    const total = this._rows.length;
    const flaggedCount = this._flags.size;
    const notice = this._notice
      ? `<p class="settings-row-sub wi-notice${this._notice.error ? ' error' : ''}" role="status">${_esc(this._notice.text)}</p>`
      : '';

    if (!total) {
      return `${notice}<p class="wi-empty">No weigh-ins saved yet.<br>Sync a Bluetooth scale (Settings \u2192 Profile \u2192 Sync scale) to start.</p>`;
    }

    const summary = `${total} weigh-in${total === 1 ? '' : 's'} saved \u00B7 ${flaggedCount ? `${flaggedCount} may be wrong` : 'none look wrong'}`;
    const filterBar = `
      <div class="segmented wi-filter" role="group" aria-label="Show">
        <button type="button" class="segmented-btn${this._filter === FILTERS.REVIEW ? ' active' : ''}" data-wi-filter="${FILTERS.REVIEW}">Needs review (${flaggedCount})</button>
        <button type="button" class="segmented-btn${this._filter === FILTERS.ALL ? ' active' : ''}" data-wi-filter="${FILTERS.ALL}">All (${total})</button>
      </div>`;

    const bulk = this._filter === FILTERS.REVIEW && flaggedCount
      ? `<div class="wi-bulk"><button type="button" class="btn btn-danger btn-sm wi-clear"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg>${flaggedCount === 1 ? 'Clear the 1 that needs review' : `Clear all ${flaggedCount} that need review`}</button></div>`
      : '';

    let list;
    if (this._filter === FILTERS.REVIEW) {
      const flagged = this._rows
        .filter(m => this._flags.has(m.id))
        // Impossible values before "worth a look", newest first within each group.
        .sort((a, b) => Number(isCertainlyWrong(this._flags.get(b.id))) - Number(isCertainlyWrong(this._flags.get(a.id)))
                        || b.measuredAt - a.measuredAt);
      list = flagged.length
        ? flagged.map(m => this._itemHtml(m, units)).join('')
        : `<p class="wi-empty">Nothing looks off \u2014 your weigh-ins are consistent with each other.<br>Switch to <strong>All</strong> to see every one.</p>`;
    } else {
      list = this._rows.map(m => this._itemHtml(m, units)).join('');
    }

    return `
      <p class="wi-summary">${summary}</p>
      ${filterBar}
      ${notice}
      ${bulk}
      <div class="wi-list">${list}</div>
      <p class="settings-sub wi-note">\u201CMay be wrong\u201D is only a hint \u2014 a real change gets flagged too, so nothing is touched until you edit or delete it. This only changes your weigh-in history: your Profile weight and body composition (Settings \u2192 Profile) are saved separately, so correct them there too if a bad reading ended up in them.</p>
    `;
  }

  _itemHtml(m, units) {
    const flags = this._flags.get(m.id) ?? [];
    const cls = flags.length ? (isCertainlyWrong(flags) ? ' wi-item-bad' : ' wi-item-warn') : '';
    const when = _fmtWhen(m.measuredAt);
    const source = m.source === MEASUREMENT_SOURCES.MANUAL ? 'Entered by hand' : 'Scale';
    const headline = weighInHeadline(m, units);
    return `
      <div class="wi-item${cls}" data-id="${m.id}">
        <div class="wi-item-main">
          <span class="wi-item-headline">${_esc(headline)}</span>
          <span class="wi-item-date">${_esc(when)} \u00B7 ${source}</span>
          ${flags.map(f => this._flagHtml(f, units)).join('')}
        </div>
        <div class="wi-item-actions">
          <button type="button" class="btn btn-ghost btn-sm wi-edit" title="Edit" aria-label="Edit the weigh-in from ${_esc(when)}"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-pencil"/></svg></button>
          <button type="button" class="btn btn-danger btn-sm wi-delete" title="Delete" aria-label="Delete the weigh-in from ${_esc(when)}"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>
        </div>
      </div>
    `;
  }

  _flagHtml(flag, units = this._profile.units) {
    const bad = isCertainlyWrong([flag]);
    return `<span class="wi-flag${bad ? ' wi-flag-bad' : ''}">${_esc(describeFlag(flag, units))}</span>`;
  }

  _editHtml() {
    const { original, draft, errors } = this._editing;
    const units = this._profile.units;
    const flags = this._flags.get(original.id) ?? [];

    const fieldError = key => errors[key] ? `<span class="wi-field-error" role="alert">${_esc(errors[key])}</span>` : '';
    const fields = WEIGH_IN_FIELDS.map(f => `
      <label class="sf-field">
        <span>${_esc(f.label)} <span class="settings-sub">(${_fieldUnit(f, units)})</span></span>
        <input type="number" step="any" min="0" inputmode="${f.kind === 'mass' || f.kind === 'percent' ? 'decimal' : 'numeric'}"
               class="input full-width wi-input" data-field="${f.key}" value="${_esc(draft[f.key] ?? '')}"${errors[f.key] ? ' aria-invalid="true"' : ''}>
        ${fieldError(f.key)}
      </label>
    `).join('');

    return `
      ${flags.length ? `<div class="wi-flags">${flags.map(f => this._flagHtml(f, units)).join('')}</div>` : ''}
      ${errors.form ? `<p class="wi-form-error" role="alert">${_esc(errors.form)}</p>` : ''}
      <label class="sf-field">
        <span>Date &amp; time</span>
        <input type="datetime-local" class="input full-width wi-input" data-field="measuredAt" value="${_esc(draft.measuredAt ?? '')}"${errors.measuredAt ? ' aria-invalid="true"' : ''}>
        ${fieldError('measuredAt')}
      </label>
      <div class="wi-field-grid">${fields}</div>
      <p class="settings-sub wi-note">Clear a reading to remove it from this weigh-in. Lean mass is worked out from weight and body fat, so it isn\u2019t typed here.</p>
    `;
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  _beginEdit(id) {
    const original = this._rows.find(m => m.id === id);
    if (!original || this._busy) return;
    this._editing = { original, draft: weighInDraft(original, this._profile.units), errors: {} };
    this._render(); // no autofocus: on a phone that would raise the keyboard over a form the rider may only want to look at
  }

  async _save() {
    if (!this._editing || this._busy) return;
    const { original, draft } = this._editing;
    const parsed = parseWeighInDraft(draft, original, { units: this._profile.units });
    if (!parsed.ok) {
      this._editing.errors = parsed.errors;
      this._render();
      const firstBad = Object.keys(parsed.errors).find(k => k !== 'form');
      this._root?.querySelector(firstBad ? `[data-field="${firstBad}"]` : '.wi-input')?.focus();
      return;
    }

    this._setBusy(true);
    try {
      await db.updateBodyMeasurement(parsed.value);
    } catch (err) {
      console.error('[weigh-ins] save failed', err);
      this._editing.errors = { form: 'Couldn\u2019t save that change. Nothing was changed.' };
      this._setBusy(false);
      this._render();
      return;
    }
    await this._afterChange('Weigh-in updated.');
  }

  async _delete(id) {
    const row = this._rows.find(m => m.id === id);
    if (!row || this._busy) return;
    const units = this._profile.units;
    if (!confirm(`Delete this weigh-in?\n\n${weighInHeadline(row, units)}\n${_fmtWhen(row.measuredAt)}\n\nThis can\u2019t be undone.`)) return;

    this._setBusy(true);
    try {
      await db.deleteBodyMeasurement(id);
    } catch (err) {
      console.error('[weigh-ins] delete failed', err);
      const text = 'Couldn\u2019t delete that weigh-in. Nothing was changed.';
      // From the edit form, keep the rider's edits and say so there; from the list, say so above it.
      if (this._editing) this._editing.errors = { form: text };
      else this._notice = { text, error: true };
      this._setBusy(false);
      this._render();
      return;
    }
    await this._afterChange('Weigh-in deleted.');
  }

  /** "Clear all that need review": deletes every weigh-in flagWeighIns() currently flags — exactly the
   *  ones the Needs review tab lists — in one transaction, after a confirm. Nothing is deleted if the
   *  rider cancels or the write fails. */
  async _clearFlagged() {
    if (this._busy) return;
    const ids = this._rows.filter(m => this._flags.has(m.id)).map(m => m.id);
    if (!ids.length) return;
    const n = ids.length;
    const what = n === 1 ? 'the 1 weigh-in' : `all ${n} weigh-ins`;
    if (!confirm(`Delete ${what} that need${n === 1 ? 's' : ''} review?\n\n\u201CMay be wrong\u201D is only a hint, so this also removes any real readings in the list. Weigh-ins that look fine are kept.\n\nThis can\u2019t be undone.`)) return;

    this._setBusy(true);
    try {
      await db.deleteBodyMeasurements(ids);
    } catch (err) {
      console.error('[weigh-ins] clear failed', err);
      this._notice = { text: 'Couldn\u2019t clear those weigh-ins. Nothing was changed.', error: true };
      this._setBusy(false);
      this._render();
      return;
    }
    await this._afterChange(`${n} weigh-in${n === 1 ? '' : 's'} deleted.`);
  }

  /** Common tail of a saved edit / delete: back to the list, re-flagged from what's now stored, and the
   *  caller told. The write already succeeded by the time this runs, so a failure to reload the list is
   *  logged rather than reported as a failed edit. */
  async _afterChange(text) {
    this._editing = null;
    this._notice = { text };
    try {
      await this._load();
    } catch (err) {
      console.error('[weigh-ins] reload after change failed', err);
    }
    this._setBusy(false);
    this._render();
    this._onChange?.();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Unit text next to a field's label, in the rider's units. */
function _fieldUnit(field, units) {
  switch (field.kind) {
    case 'mass':    return weightUnitLabel(units);
    case 'percent': return '%';
    case 'kcal':    return 'kcal';
    default:        return 'index';
  }
}

/** "Sun, Sep 20, 2026, 2:30 PM" — 'en-US' like the rest of the app's date strings (views/diet.js). */
function _fmtWhen(ms) {
  return new Date(ms).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function _esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export default WeighInManager;
