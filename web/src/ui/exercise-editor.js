// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/exercise-editor.js
 *
 * Custom exercise editor — a modal form producing an Exercise in
 * data/exercises.js's canonical catalog shape, `id` prefixed `custom:`.
 * The strength-catalog counterpart to ui/ingredient-editor.js: same
 * full-screen `.setup-flow` overlay shell, same "one shared singleton,
 * many callers, open() itself takes {onSaved, onCancel}" shape (see that
 * file's own doc comment for the rationale) — reachable from
 * views/strength-session.js's exercise Browse picker (the "+ Create
 * Custom Exercise" row, and each custom chip's own edit pencil), wired
 * through app.js the same way ui/ingredient-editor.js is.
 *
 * The fields here are deliberately exactly the filters the rest of the
 * strength catalog already runs on — Category (exercisesByCategory()'s
 * grouping), Equipment + primary Muscles (exercisesForFocus()'s focus
 * matching, e.g. picking 'bodyweight' equipment makes a custom move show
 * up under Calisthenics automatically), and Reps/Hold Mode
 * (core/strength-model.js's SET_MODES — decides whether the live session
 * logs reps+weight or a timed hold, exactly like a catalog entry's own
 * `mode`). Filling them out is what makes a custom exercise behave like a
 * first-class catalog one everywhere else in the app rather than a plain
 * typed name with no diagram or grouping.
 *
 * Usage:
 *   const exerciseEditor = new ExerciseEditor($('exercise-editor-flow'));
 *   exerciseEditor.open({
 *     prefillName: 'Reverse Nordic Curl',      // or exercise: <existing custom Exercise> to edit
 *     onSaved:   (exercise) => { ... },        // called after db.saveCustomExercise() resolves
 *     onDeleted: (id) => { ... },              // called after a delete (edit mode only)
 *     onCancel:  () => { ... },                // called on Escape/backdrop/Cancel — optional
 *   });
 */

import { createCustomExercise, addCustomExercise, updateCustomExercise, removeCustomExercise,
         CATEGORIES, EQUIPMENT } from '../data/exercises.js';
import { renderMuscleDiagram, MUSCLE_LABELS } from './muscle-diagram.js';

// Checkbox grid order — front-of-body regions first, then back, matching
// how ui/muscle-diagram.js's own FRONT_MUSCLES/BACK_MUSCLES read, so the
// grid and the live preview beneath it line up in a rider's head. A muscle
// missing from both diagram lists would just never highlight (see that
// file's doc comment) — everything here is a real region id, so that case
// never actually arises.
const MUSCLE_ORDER = [
  'chest', 'shoulders', 'biceps', 'triceps', 'forearms', 'abs', 'obliques',
  'lats', 'upperBack', 'lowerBack', 'traps', 'glutes', 'quads', 'hamstrings', 'calves',
];

export class ExerciseEditor {
  /** @param {HTMLElement} container  Full-screen overlay host (hidden by default). */
  constructor(container) {
    this._container = container;
    this._draft = null;       // Exercise being edited — set fresh by each open()
    this._onSaved = null;
    this._onDeleted = null;
    this._onCancel = null;
    this._isEditing = false;

    this._renderShell();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * @param {Object}      [opts]
   * @param {Exercise}    [opts.exercise]      Existing custom exercise to edit; omit to create new.
   * @param {string}      [opts.prefillName]   Seeds the name field for a new exercise (e.g. a
   *   Browse search that came up empty) — ignored when opts.exercise is set.
   * @param {Function}    [opts.onSaved]       (savedExercise) => void — called after the save lands.
   * @param {Function}    [opts.onDeleted]     (id) => void — called after Delete (edit mode only).
   * @param {Function}    [opts.onCancel]      () => void — called on Escape/backdrop/Cancel.
   */
  open({ exercise = null, prefillName = '', onSaved, onDeleted, onCancel } = {}) {
    this._draft = exercise
      ? _deepClone(exercise)
      : createCustomExercise({ name: prefillName });
    this._onSaved = onSaved ?? null;
    this._onDeleted = onDeleted ?? null;
    this._onCancel = onCancel ?? null;
    this._isEditing = exercise != null;

    this._container.classList.remove('hidden');
    this._renderBody();
    this._container.querySelector('#ee-name')?.focus();
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
          <span class="setup-flow-head-title" id="ee-head-title">Custom Exercise</span>
          <button class="setup-flow-close" id="ee-close" title="Cancel" aria-label="Cancel">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg>
          </button>
        </div>
        <div class="setup-flow-body" id="ee-body"></div>
        <div class="setup-flow-foot">
          <button class="btn btn-danger hidden" id="ee-delete">Delete</button>
          <button class="btn btn-ghost" id="ee-cancel">Cancel</button>
          <button class="btn btn-glass-cta" id="ee-save">Save Exercise</button>
        </div>
      </div>
    `;

    this._container.querySelector('#ee-close').addEventListener('click', () => this._cancel());
    this._container.querySelector('#ee-cancel').addEventListener('click', () => this._cancel());
    this._container.querySelector('#ee-save').addEventListener('click', () => this._save());
    this._container.querySelector('#ee-delete').addEventListener('click', () => this._delete());

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

    const saved = this._isEditing
      ? await updateCustomExercise(d)
      : await addCustomExercise(d);
    this.close();
    this._onSaved?.(saved);
  }

  async _delete() {
    if (!this._isEditing) return;
    const id = this._draft.id;
    await removeCustomExercise(id);
    this.close();
    this._onDeleted?.(id);
  }

  // ─── Body ───────────────────────────────────────────────────────────────

  _renderBody() {
    const d = this._draft;
    this._container.querySelector('#ee-head-title').textContent =
      this._isEditing ? 'Edit Custom Exercise' : 'New Custom Exercise';
    this._container.querySelector('#ee-delete').classList.toggle('hidden', !this._isEditing);

    const body = this._container.querySelector('#ee-body');
    body.innerHTML = `
      <label class="sf-field">
        <span>Name</span>
        <input class="input full-width" id="ee-name" placeholder="e.g. Reverse Nordic Curl" value="${_esc(d.name)}">
      </label>

      <div class="sf-field">
        <span>Category</span>
        <select class="input full-width" id="ee-category">
          ${CATEGORIES.map(c => `<option value="${c.value}"${d.category === c.value ? ' selected' : ''}>${c.label}</option>`).join('')}
        </select>
      </div>

      <div class="sf-field">
        <span>Equipment</span>
        <select class="input full-width" id="ee-equipment">
          ${EQUIPMENT.map(eq => `<option value="${eq.value}"${d.equipment === eq.value ? ' selected' : ''}>${eq.label}</option>`).join('')}
        </select>
      </div>

      <div class="sf-field">
        <span>Logged as</span>
        <div class="sf-toggle-group" id="ee-mode-group">
          <button type="button" class="sf-toggle-btn${d.mode === 'reps' ? ' selected' : ''}" data-mode="reps">Reps</button>
          <button type="button" class="sf-toggle-btn${d.mode === 'hold' ? ' selected' : ''}" data-mode="hold">Hold</button>
        </div>
      </div>

      <div class="sf-field">
        <span>Primary Muscles <span class="settings-sub">(shown on the muscle diagram while logging)</span></span>
        <div class="ee-muscle-grid" id="ee-muscle-grid">
          ${MUSCLE_ORDER.map(id => `
            <label class="ee-muscle-check">
              <input type="checkbox" value="${id}" ${d.primaryMuscles.includes(id) ? 'checked' : ''}>
              <span>${MUSCLE_LABELS[id]}</span>
            </label>
          `).join('')}
        </div>
      </div>

      <div class="ee-muscle-preview" id="ee-muscle-preview"></div>
    `;
    this._renderMusclePreview();
    this._bindBodyEvents();
  }

  _renderMusclePreview() {
    this._container.querySelector('#ee-muscle-preview').innerHTML =
      renderMuscleDiagram(this._draft.primaryMuscles, { compact: true });
  }

  _bindBodyEvents() {
    const $ = sel => this._container.querySelector(sel);
    const d = this._draft;

    $('#ee-name')?.addEventListener('input', e => { d.name = e.target.value; });
    $('#ee-category')?.addEventListener('change', e => { d.category = e.target.value; });
    $('#ee-equipment')?.addEventListener('change', e => { d.equipment = e.target.value; });

    $('#ee-mode-group')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      d.mode = btn.dataset.mode;
      this._container.querySelectorAll('#ee-mode-group .sf-toggle-btn').forEach(b =>
        b.classList.toggle('selected', b.dataset.mode === d.mode));
    });

    this._container.querySelectorAll('#ee-muscle-grid input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        d.primaryMuscles = [...this._container.querySelectorAll('#ee-muscle-grid input:checked')].map(el => el.value);
        this._renderMusclePreview();
      });
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Structured-clone-shaped deep copy — editing the draft must never mutate
 *  the exercise object the caller (e.g. the picker's in-memory list) still
 *  has a reference to until Save actually commits. Same helper as
 *  ui/ingredient-editor.js's own _deepClone(). */
function _deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function _esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export default ExerciseEditor;
