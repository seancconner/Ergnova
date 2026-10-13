// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * editor/workout-editor.js
 *
 * Interactive workout editor.
 * Renders a visual timeline of workout steps inside a container element.
 * Supports:
 *   - Adding steps from one "Add Step" tool: a flat target by default, or
 *     a linear ramp from a start value to an end value across a timespan
 *     once the Ramp toggle (beside the Target field) is switched
 *     on — for any of the four target types (power/slope/resistance/heart
 *     rate). One tool covers both a steady interval and a gradual change,
 *     and is the only step shape the builder needs to construct a workout
 *     from scratch. Heart rate is the odd one out: it can't be commanded
 *     to a trainer, so a heart-rate step leaves the trainer uncontrolled
 *     and instead nudges the rider with audio when their measured heart
 *     rate strays outside the target zone (see core/cardio-model.js#
 *     heartRateZone and playback/scripted-session.js#_checkHeartRateZone).
 *   - Splitting a SLOPE-target ramp into a run of fixed-grade steps on
 *     demand (see the per-step editor's "Split into steps" action, and
 *     core/cardio-model.js#stepsFromRamp) — for trainers whose slope/
 *     resistance control can't smoothly chase a moving target the way
 *     ERG mode chases a moving power target.
 *   - Editing duration/name and power/slope/resistance targets per step
 *   - Drag to reorder steps
 *   - Delete steps
 *   - Import/export via format-registry
 *   - Live preview of the workout shape, drawn by the same painter as the
 *     live session's target map (ui/hud-timeline.js): a line along each
 *     step's target with a glow beneath it, in the live HUD's colours
 *
 * Legacy step types (warmup, cooldown, rest, free ride, interval) can no
 * longer be *created* from the toolbar, but the editor still fully
 * displays and edits them when they arrive via import — those formats
 * (ZWO, FIT, TCX, PWX…) still use the richer type set under the hood; see
 * core/cardio-model.js. The same is true of eased ("parabolic") ramps —
 * the builder only ever creates straight-line ramps now, but one loaded
 * from an older saved workout still displays and plays back correctly
 * until it's next edited here.
 *
 * Usage:
 *   import { WorkoutEditor } from './editor/workout-editor.js';
 *   const editor = new WorkoutEditor(containerEl, {
 *     onSave: (model) => { ... },
 *     onSavePreset: (model) => { ... },  // see load()'s `intent` doc below
 *     enabledTargetTypes: [TARGET_TYPES.POWER, TARGET_TYPES.SLOPE],
 *     ftp: 280,
 *   });
 *   editor.load(existingWorkoutModel);  // or starts blank
 */

import {
  createWorkout, createStep, STEP_TYPES, TARGET_TYPES,
  totalDuration, flattenWorkout, stepTargetLabel,
  createRampStep, stepsFromRamp, heartRateZone,
} from '../core/cardio-model.js';
import { registry }  from '../formats/format-registry.js';
import { fitText }   from '../ux/fit-text.js';
import { drawTimeline } from '../ui/hud-timeline.js';
import { themeColor } from '../charts/chart-theme.js';
import { saveFile }  from '../platform/save-file.js';

// Ensure formats are registered
import '../formats/zwo.js';
import '../formats/erg-mrc.js';

// Step color palette — resolved from style.css's --step-* tokens (which alias the
// --zone-* palette where a step maps onto a zone) — exported so the live
// session HUD's workout-target timeline (see app.js's _drawWorkoutTimeline())
// can reuse the same palette instead of drifting from the editor's.
export const STEP_COLORS = {
  [STEP_TYPES.WARMUP]:    themeColor('--step-warmup'),
  [STEP_TYPES.COOLDOWN]:  themeColor('--step-cooldown'),
  [STEP_TYPES.STEADY]:    themeColor('--step-steady'),
  [STEP_TYPES.RAMP]:      themeColor('--step-ramp'),
  [STEP_TYPES.REST]:      themeColor('--step-rest'),
  [STEP_TYPES.FREE_RIDE]: themeColor('--step-free-ride'),
  [STEP_TYPES.INTERVAL]:  themeColor('--step-interval'),
};

// Parabolic ramps share STEP_TYPES.RAMP with linear ones (they differ only
// by step.curve), so they'd otherwise be indistinguishable at a glance in
// the step list — this gives the parabolic case its own swatch color,
// kept local rather than folded into STEP_COLORS since app.js's HUD
// timeline colors by type alone and has no concept of curve.
function _swatchColor(step) {
  if (step.type === STEP_TYPES.RAMP && step.curve === 'parabolic') return themeColor('--step-ramp-curve');
  return STEP_COLORS[step.type] ?? themeColor('--step-rest');
}

// The shape preview's colour for a step: by step type alone, the same STEP_COLORS lookup the live
// session's target map uses (app.js's _drawWorkoutTimeline()), so a step is the same colour in the
// editor's preview as on the live page. (A parabolic ramp keeps its own swatch in the step list above;
// in the preview its curve already shows in the line.)
function _previewColor(step) {
  return STEP_COLORS[step.type] ?? themeColor('--step-rest');
}

// Icon sprite id per step type, for the step-editor panel's header glyph
// (see #icon-* symbols in index.html). Purely decorative — falls back to
// the generic activity glyph for anything unmapped (e.g. a bare-type call).
const STEP_ICONS = {
  [STEP_TYPES.WARMUP]:    'icon-flame',
  [STEP_TYPES.COOLDOWN]:  'icon-droplet',
  [STEP_TYPES.STEADY]:    'icon-square',
  [STEP_TYPES.RAMP]:      'icon-activity',
  [STEP_TYPES.REST]:      'icon-pause',
  [STEP_TYPES.FREE_RIDE]: 'icon-bike',
  [STEP_TYPES.INTERVAL]:  'icon-refresh',
};
function _typeIcon(step) {
  return STEP_ICONS[step?.type] ?? 'icon-activity';
}

// Target types the Add-step panel and per-step editor offer, in display
// order — driving the segmented control both places share so the two
// forms stay visually and behaviorally identical. Each carries its own
// icon and instrument color (reusing the same three hues the live-session
// metric cards already use for power/slope-adjacent/resistance-adjacent
// readouts — see --color-power/--color-cadence in style.css) so a target
// type reads as a consistent color everywhere it shows up, not just here.
const TARGET_TYPE_OPTIONS = [
  { value: TARGET_TYPES.POWER,      label: 'Power',      icon: 'icon-lightning', color: 'var(--color-power)' },
  { value: TARGET_TYPES.SLOPE,      label: 'Slope',      icon: 'icon-activity',  color: 'var(--indigo)' },
  { value: TARGET_TYPES.RESISTANCE, label: 'Resistance', icon: 'icon-sliders',   color: 'var(--color-cadence)' },
  // Reuses --color-hr, the same red every other heart-rate readout in the
  // app (metric cards, chart series) already uses — see style.css.
  { value: TARGET_TYPES.HEART_RATE, label: 'Heart Rate', icon: 'icon-heart',     color: 'var(--color-hr)' },
];
const TARGET_TYPE_COLOR = Object.fromEntries(TARGET_TYPE_OPTIONS.map(o => [o.value, o.color]));
const ALL_TARGET_TYPES  = TARGET_TYPE_OPTIONS.map(o => o.value);

// Settings → Targets (index.html/app.js's pref-target-* toggles) hands this
// constructor/setEnabledTargetTypes() an arbitrary saved array — normalize
// it the same defensive way app.js's own loadPreferences() does (drop
// anything not a real target type, fall back to every type rather than an
// empty list) so a bad/legacy saved value can never leave the Add-step
// panel's picker with nothing offered at all.
function _normalizeEnabledTypes(list) {
  const filtered = Array.isArray(list) ? list.filter(t => ALL_TARGET_TYPES.includes(t)) : [];
  return filtered.length ? filtered : ALL_TARGET_TYPES;
}

// Sensible starting values per target type, keyed the same way the panel's
// three value fields are ordered everywhere they're bound (see
// _bindTargetControls's `fields` param): the flat/steady Target field, then
// Start, then End. Used only when the target *type* itself changes (see the
// segmented-control click handler below) — a raw number carried over from
// another type is actively misleading once reinterpreted under a new unit
// (e.g. a Power multiplier of 0.60 read as a Heart Rate target would insert
// a step that nudges outside a nonsensical "-4-6 bpm" zone), so switching
// types resets the fields to numbers that are actually sane for whichever
// type was just picked, rather than leaving whatever was typed under the
// previous one.
const TARGET_TYPE_DEFAULTS = {
  [TARGET_TYPES.POWER]:      { value: 0.60, start: 0.60, end: 0.90 },
  [TARGET_TYPES.SLOPE]:      { value: 2.0,  start: 0.0,  end: 5.0  },
  [TARGET_TYPES.RESISTANCE]: { value: 50,   start: 30,   end: 70   },
  // Centered on a moderate aerobic effort — HR_TOLERANCE_BPM (see
  // core/cardio-model.js) widens whichever of these actually lands into
  // the zone that gets checked live.
  [TARGET_TYPES.HEART_RATE]: { value: 140,  start: 130,  end: 150  },
};

export class WorkoutEditor {
  /**
   * @param {HTMLElement} container
   * @param {Object}      opts
   * @param {number}      [opts.ftp=200]
   * @param {Function}    [opts.onSave]   Called with the WorkoutModel when
   *   Save is pressed under the default 'workout' intent — see load().
   * @param {Function}    [opts.onSavePreset]  Called with the WorkoutModel
   *   when Save is pressed under the 'preset' intent instead — see load().
   * @param {Function}    [opts.onLoad]   Called with the WorkoutModel after import
   * @param {string[]}    [opts.enabledTargetTypes]  Which TARGET_TYPES the
   *   Add-step panel and per-step editor's target-type picker offer (see
   *   setEnabledTargetTypes() below) — defaults to all four when omitted.
   * @param {Function}    [opts.getTimelinePresets]  () => TimelinePreset[] —
   *   backs the 'preset' intent's "Load a preset timeline" select (see
   *   _renderPresetLoadRow()) with the live bundled+custom list from
   *   data/cardio-timelines.js. Called fresh every time that row becomes
   *   visible, not just once, so a preset saved elsewhere since this
   *   editor opened is never stale. Left undefined, the row still renders
   *   under the 'preset' intent but offers nothing but its placeholder —
   *   the editor stays usable without this wired up, same as any other
   *   optional callback here.
   * @param {Function}    [opts.onLoadPreset]  (presetId) => void — called
   *   when a preset is picked from that select. This editor only renders
   *   the list and reports the choice; it's the caller's job (app.js's
   *   openPresetInAdvancedBuilder()) to resolve the id, build a fresh
   *   WorkoutModel from it, and load() it back in under the 'preset'
   *   intent — same division of responsibility as onSave/onSavePreset
   *   above, which likewise only ever hand a model outward rather than
   *   deciding what happens to it.
   */
  constructor(container, { ftp = 200, onSave, onSavePreset, onLoad, enabledTargetTypes, getTimelinePresets, onLoadPreset } = {}) {
    this._container   = container;
    this._ftp         = ftp;
    this._onSave      = onSave;
    this._onSavePreset = onSavePreset;
    this._onLoad      = onLoad;
    this._getTimelinePresets = getTimelinePresets;
    this._onLoadPreset       = onLoadPreset;
    this._model       = createWorkout();
    this._selected    = null; // selected step index
    this._addOpen     = false; // whether the "Add Step" panel is open
    this._intent      = 'workout'; // 'workout' | 'preset' — see load() below
    this._enabledTargetTypes = _normalizeEnabledTypes(enabledTargetTypes);
    this._previewSteps  = null;  // flattened steps the preview canvas was last drawn for (see _renderPreview())
    this._previewResize = null;  // ResizeObserver that redraws it when its box changes size

    this._render();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load a WorkoutModel into the editor.
   *
   * @param {WorkoutModel} model
   * @param {Object} [opts]
   * @param {'workout'|'preset'} [opts.intent='workout']  Which callback the
   *   toolbar's one Save button invokes for *this* loaded model:
   *     'workout' (the default) — the normal session-bound "Workout
   *       Editor" FAB entry. Save calls onSave, meaning "load this into
   *       the session and go".
   *     'preset' — set by app.js's openPresetInAdvancedBuilder() when
   *       Quick Start's Mapped picker's "Open in Advanced Builder…"
   *       action opens a *copy* of a bundled or custom timeline preset
   *       here to tweak. Save instead calls onSavePreset, meaning
   *       "persist the edited copy as a new named custom preset" —
   *       the original preset and any running session are left alone.
   *       The toolbar's #we-name field doubles as the new preset's name
   *       in this case (see _applyIntentChrome(), which relabels it
   *       "Preset name" and the Save button "Save as Preset" for as
   *       long as this intent is in effect).
   *   One button reads either way because a rider editing a preset copy
   *   should never be surprised into starting a session by pressing the
   *   same Save they'd press for a real workout — the *intent* the
   *   editor was opened with decides which happens, not anything about
   *   the model itself (a preset's materialized steps are ordinary
   *   WorkoutStep POJOs, indistinguishable from a hand-built workout's).
   *   Stays in effect for every subsequent Save until the next load() or
   *   setIntent() call — see openWorkoutEditor()'s own setIntent('workout')
   *   in app.js for why the plain "Workout Editor" FAB entry resets it
   *   explicitly rather than leaving a stale 'preset' intent in place
   *   from an earlier, un-saved preset edit.
   */
  load(model, { intent = 'workout' } = {}) {
    this._model    = { ...model, steps: model.steps.map(s => ({ ...s })) };
    this._selected = null;
    this._intent   = intent;
    this._closeAddPanel();
    this._refresh();
    this._onLoad?.(this._model);
  }

  /** Changes which Save callback is in effect without touching the
   *  currently loaded model — see load()'s `intent` doc comment above for
   *  what 'workout' vs 'preset' means. */
  setIntent(intent) {
    this._intent = intent === 'preset' ? 'preset' : 'workout';
    this._applyIntentChrome();
  }

  /** Updates which TARGET_TYPES the Add-step panel and per-step editor's
   *  target-type picker offer (Settings → Targets — see app.js's
   *  settings-save wiring). Re-renders whichever picker is currently open
   *  so a mid-edit toggle takes effect immediately, same as setFtp()
   *  below. A step already using a type that's since been disabled keeps
   *  displaying and editing normally either way — see
   *  _targetTypeSegmented()'s own comment — this only ever narrows which
   *  types are offered for a *new* choice, never invalidates one already
   *  on a step. */
  setEnabledTargetTypes(types) {
    this._enabledTargetTypes = _normalizeEnabledTypes(types);
    if (this._addOpen) this._openAddPanel();
    this._renderStepEditor(this._selected);
  }

  /** Update the FTP reference (for label display and validation). */
  setFtp(ftp) {
    this._ftp = ftp;
    this._refresh();
  }

  /** Returns the current WorkoutModel. */
  get model() {
    return this._model;
  }

  /**
   * Call when the editor's panel becomes visible (e.g. on tab switch).
   * The preview canvas is sized off its own on-screen box (see
   * _renderPreview()), which reads as 0 while the panel is display:none —
   * re-rendering once it's actually shown is what makes it pick up its
   * real, current size instead of staying stuck at the constructor-time
   * fallback.
   */
  onShow() {
    this._renderPreview();
    // Same reasoning as _renderPreview() above: the step list can first
    // render while this panel is still display:none (e.g. at app
    // startup, before the Workout tab has ever been opened), where every
    // row measures as zero-width — re-fit now that it's actually on
    // screen and has a real width to measure against.
    const list = this._container.querySelector('#we-step-list');
    if (list) fitText(list, '.we-step-type, .we-step-label');
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  _render() {
    this._container.innerHTML = `
      <div class="we-shell">

        <!-- Unified toolbar — name, Add Step, and import/export/save all
             live together in one place instead of import/export/save up
             top and "add step" in a separate row below the whole step
             list. Styled as its own instrument-cluster card (chromatic
             top edge, like the cockpit metric cards' left edge, just
             rotated to sit above a header row instead of beside a
             reading) rather than a bare flex row of controls. -->
        <div class="we-toolbar">
          <div class="we-name-group">
            <label class="we-name-label" id="we-name-label" for="we-name">Workout</label>
            <input class="input we-name" id="we-name" placeholder="Untitled workout" />
          </div>

          <div class="we-toolbar-tools">
            <button class="btn we-add-btn" id="we-add-btn"
              title="Add a step — flip on Ramp for a gradual change from a start value to an end value"
              aria-label="Add a step" aria-expanded="false">
              <span class="we-add-icon-wrap"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-plus"/></svg></span>
              <span class="btn-label">Add Step</span>
            </button>

            <div class="we-toolbar-actions">
              <button class="btn btn-ghost we-btn" id="we-import">
                <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-upload"/></svg>
                <span class="btn-label">Import</span>
              </button>
              <input  type="file" id="we-file-input" accept=".zwo,.erg,.mrc,.fit,.pwx,.tcx" hidden />
              <select class="input we-btn we-export-select" id="we-export-select" aria-label="Export format">
                <option value="" selected>Export…</option>
                <option value=".zwo">ZWO</option>
                <option value=".erg">ERG/MRC</option>
                <option value=".pwx">PWX</option>
                <option value=".tcx">TCX</option>
              </select>
              <button class="btn btn-primary we-btn" id="we-save">
                <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-save"/></svg>
                <span class="btn-label">Save</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Shown only under the 'preset' intent (see load()'s doc
             comment) — hidden the rest of the time by _applyIntentChrome()
             toggling .hidden, not re-rendered per intent switch, since it
             never needs anything but a class flip. -->
        <p class="we-intent-note hidden" id="we-intent-note">Editing a copy — Save adds it as a new preset; the original is untouched.</p>

        <!-- Also shown only under the 'preset' intent (see load()'s
             intent doc comment) — lets a rider switch which bundled or
             custom cardio-timelines.js preset they're building from
             without leaving the builder and going back through Quick
             Start's card grid. Repopulated by _renderPresetLoadRow()
             (called from _applyIntentChrome()) every time this becomes
             visible, and resets to the placeholder after each pick — a
             one-shot action, not a persistent selection, same convention
             as the Export select below. -->
        <div class="we-preset-load-row hidden" id="we-preset-load-row">
          <label class="we-preset-load-label" for="we-load-preset">Load a preset timeline</label>
          <select class="input we-preset-load-select" id="we-load-preset" aria-label="Load a preset timeline">
            <option value="" selected>Choose a preset…</option>
          </select>
        </div>

        <!-- Add-step form — appears directly under the toolbar when Add
             Step above is active, so new steps are authored right where
             they were requested instead of in a distant part of the
             page. -->
        <div class="we-add-panel hidden" id="we-add-panel"></div>

        <!-- Step shape preview — the wrap hosts .we-preview-cursor, an
             overlay marking the start of the timeline while it's still
             empty (see _renderPreview()'s is-empty toggle below). Framed
             as its own labeled instrument card, same language as the
             live-session chart. -->
        <div class="we-preview-card">
          <span class="we-preview-label">Shape preview</span>
          <div class="we-preview-wrap" id="we-preview-wrap">
            <canvas class="we-preview" id="we-preview" height="80"></canvas>
            <span class="we-preview-cursor" id="we-preview-cursor" aria-hidden="true"></span>
          </div>
        </div>

        <!-- Step list -->
        <div class="we-step-list" id="we-step-list"></div>

        <!-- Step editor panel (appears when a step is selected) -->
        <div class="we-step-editor hidden" id="we-step-editor"></div>

        <!-- Duration / stats footer -->
        <div class="we-footer" id="we-footer"></div>

      </div>
    `;

    // Bind toolbar
    this._container.querySelector('#we-name').addEventListener('input', e => {
      this._model.name = e.target.value;
    });
    this._container.querySelector('#we-import').addEventListener('click', () => {
      this._container.querySelector('#we-file-input').click();
    });
    this._container.querySelector('#we-file-input').addEventListener('change', e => {
      this._importFile(e.target.files[0]);
    });
    // Single compact "Export…" select replaces four separate format buttons
    // — same four formats, picked from a dropdown instead of a button row,
    // so the toolbar stays a short, mobile-friendly one-liner. Resets back
    // to the placeholder after each export so it's ready to pick again.
    this._container.querySelector('#we-export-select').addEventListener('change', (e) => {
      const ext = e.target.value;
      e.target.value = '';
      if (ext) this._export(ext);
    });
    this._container.querySelector('#we-save').addEventListener('click', () => {
      this._model.updatedAt = new Date().toISOString();
      // Which of the two callbacks fires depends on the intent the editor
      // was load()ed under, not on anything about the model itself — see
      // load()'s doc comment above for the full reasoning.
      if (this._intent === 'preset') this._onSavePreset?.(this._model);
      else this._onSave?.(this._model);
    });

    // Add Step toggles the add-panel open/closed
    this._container.querySelector('#we-add-btn').addEventListener('click', () => {
      if (this._addOpen) this._closeAddPanel(); else this._openAddPanel();
    });

    // "Load a preset timeline" ('preset' intent only — see this row's own
    // markup comment above). Resets to the placeholder immediately, same
    // as the Export select above, since picking one is a one-shot action
    // rather than a value this control holds onto.
    this._container.querySelector('#we-load-preset')?.addEventListener('change', (e) => {
      const id = e.target.value;
      e.target.value = '';
      if (id) this._onLoadPreset?.(id);
    });

    this._refresh();
  }

  _refresh() {
    this._container.querySelector('#we-name').value = this._model.name ?? '';
    this._applyIntentChrome();
    this._renderStepList();
    this._renderPreview();
    this._renderFooter();
  }

  // Toggles the toolbar's name-field label, Save button label, and the
  // "editing a copy" note between the two intents load()/setIntent() can
  // set — purely cosmetic, the actual onSave-vs-onSavePreset routing lives
  // in the Save button's click handler in _render() above, not here.
  _applyIntentChrome() {
    const isPreset  = this._intent === 'preset';
    const nameLabel = this._container.querySelector('#we-name-label');
    const saveLabel = this._container.querySelector('#we-save .btn-label');
    const note      = this._container.querySelector('#we-intent-note');
    const presetRow = this._container.querySelector('#we-preset-load-row');
    if (nameLabel) nameLabel.textContent = isPreset ? 'Preset name' : 'Workout';
    if (saveLabel) saveLabel.textContent = isPreset ? 'Save as Preset' : 'Save';
    if (note) note.classList.toggle('hidden', !isPreset);
    if (presetRow) {
      presetRow.classList.toggle('hidden', !isPreset);
      // Only bother refreshing the option list once the row is actually
      // shown — same laziness as the rest of this method, which only
      // touches chrome relevant to the intent currently in effect.
      if (isPreset) this._renderPresetLoadRow();
    }
  }

  // Fills in the 'preset' intent's "Load a preset timeline" select from
  // whatever getTimelinePresets() currently returns — see this
  // constructor option's own doc comment for why that's called fresh
  // here rather than cached once.
  _renderPresetLoadRow() {
    const select = this._container.querySelector('#we-load-preset');
    if (!select) return;
    const presets = this._getTimelinePresets?.() ?? [];
    select.innerHTML = `
      <option value="" selected>Choose a preset…</option>
      ${presets.map(p => `<option value="${_esc(p.id)}">${_esc(p.label)}${p.custom ? ' (Custom)' : ''} \u2014 ${Math.round(p.durationMin)} min</option>`).join('')}
    `;
  }

  // ─── Step list ──────────────────────────────────────────────────────────────

  _renderStepList() {
    const list = this._container.querySelector('#we-step-list');
    list.innerHTML = '';

    if (this._model.steps.length === 0) {
      // Styled as an empty slot in the same rail a real step row occupies
      // (see .we-empty-marker vs. .we-step-row's own chromatic left bar)
      // rather than a caption floating in the middle of the panel — so
      // the first thing you see already looks like the timeline you're
      // about to build, just waiting for its first entry.
      list.innerHTML = `
        <div class="we-empty">
          <span class="we-empty-marker" aria-hidden="true"></span>
          <div class="we-empty-copy">
            <span class="we-empty-title">No steps yet</span>
            <span class="we-empty-sub">Use Add Step above to start shaping the workout.</span>
          </div>
        </div>
      `;
      return;
    }

    this._model.steps.forEach((step, idx) => {
      const el = document.createElement('div');
      el.className = `we-step-row${idx === this._selected ? ' selected' : ''}`;
      el.dataset.idx = idx;
      el.draggable = true;

      const color = _swatchColor(step);
      const label = stepTargetLabel(step, this._ftp);
      const dur   = _fmtDuration(step.duration ?? 0);
      const title = step.name || _typeLabel(step);

      // Row itself carries the chromatic left-edge bar (via --card-color,
      // read by .we-step-row::before) — same signature element as
      // .metric-card/.stat-chip elsewhere in the app — instead of a
      // separate swatch div, so a step row reads as the same kind of
      // instrument tile as everything else, just one that happens to be
      // a list item.
      el.style.setProperty('--card-color', color);

      el.innerHTML = `
        <div class="we-step-info">
          <span class="we-step-type">${title}</span>
          <span class="we-step-label">${_typeLabel(step)} · ${label}</span>
        </div>
        <span class="we-step-dur">${dur}</span>
        <div class="we-step-actions">
          <button class="btn btn-ghost we-step-btn" data-action="up"   title="Move up" aria-label="Move up">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-chevron-up"/></svg>
          </button>
          <button class="btn btn-ghost we-step-btn" data-action="down" title="Move down" aria-label="Move down">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-chevron-down"/></svg>
          </button>
          <button class="btn btn-ghost we-step-btn" data-action="dup"  title="Duplicate" aria-label="Duplicate">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-duplicate"/></svg>
          </button>
          <button class="btn btn-ghost we-step-btn we-step-delete" data-action="del" title="Delete" aria-label="Delete">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg>
          </button>
        </div>
      `;

      // Select on click
      el.addEventListener('click', (e) => {
        if (e.target.closest('.we-step-btn')) return;
        this._selected = idx;
        this._refresh();
        this._renderStepEditor(idx);
      });

      // Action buttons
      el.querySelectorAll('.we-step-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._stepAction(idx, btn.dataset.action);
        });
      });

      // Drag to reorder
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', idx);
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        const from = parseInt(e.dataTransfer.getData('text/plain'));
        const to   = idx;
        if (from !== to) this._moveStep(from, to);
      });

      list.appendChild(el);
    });

    // Shrink each row's type/label text to fit instead of letting a long
    // step name or target label get cut off. See ux/fit-text.js. No-op
    // (harmlessly) if the editor panel is hidden right now — onShow()
    // below re-runs this once it's actually on screen.
    fitText(list, '.we-step-type, .we-step-label');
  }

  _stepAction(idx, action) {
    const steps = this._model.steps;
    switch (action) {
      case 'up':
        if (idx > 0) [steps[idx-1], steps[idx]] = [steps[idx], steps[idx-1]];
        break;
      case 'down':
        if (idx < steps.length - 1) [steps[idx], steps[idx+1]] = [steps[idx+1], steps[idx]];
        break;
      case 'dup':
        steps.splice(idx + 1, 0, { ...steps[idx], id: `step_${Date.now()}` });
        break;
      case 'del': {
        const deletingOpenStep = idx === this._selected;
        steps.splice(idx, 1);
        if (deletingOpenStep) {
          // The step whose editor panel is open just got deleted — close
          // the panel instead of leaving it showing a step that no longer
          // exists.
          this._selected = null;
        } else if (this._selected != null) {
          // A different step was removed — keep the editor pointing at the
          // same step by shifting the index down if needed.
          if (idx < this._selected) this._selected--;
          if (this._selected >= steps.length) this._selected = steps.length - 1;
        }
        break;
      }
    }
    this._refresh();
    if (action === 'del') this._renderStepEditor(this._selected);
  }

  _moveStep(from, to) {
    const steps = this._model.steps;
    const [item] = steps.splice(from, 1);
    steps.splice(to, 0, item);
    this._selected = to;
    this._refresh();
  }

  // ─── Add-step panel ─────────────────────────────────────────────────────────

  _openAddPanel() {
    this._addOpen = true;
    this._renderAddPanel();
  }

  _closeAddPanel() {
    this._addOpen = false;
    this._renderAddPanel();
  }

  _renderAddPanel() {
    const panel = this._container.querySelector('#we-add-panel');
    if (!panel) return;

    const toggleBtn = this._container.querySelector('#we-add-btn');
    toggleBtn?.classList.toggle('active', this._addOpen);
    toggleBtn?.setAttribute('aria-expanded', String(this._addOpen));

    if (!this._addOpen) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
    panel.classList.remove('hidden');

    panel.innerHTML = `
      <div class="we-panel-header" style="--we-accent:${TARGET_TYPE_COLOR[TARGET_TYPES.POWER]}">
        <span class="we-panel-header-icon"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-plus"/></svg></span>
        <h4 class="we-panel-title">Add Step</h4>
        <button type="button" class="we-panel-close" id="ap-close-x" aria-label="Cancel">
          <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg>
        </button>
      </div>
      <div class="we-add-panel-grid">
        <label class="we-field">
          <span class="we-field-label">Step name</span>
          <input class="input" type="text" id="ap-name" placeholder="Step" />
        </label>
        <label class="we-field">
          <span class="we-field-label">Timespan</span>
          <div class="we-field-control">
            <input class="input" type="number" id="ap-duration" min="1" value="600" />
            <span class="we-unit-badge">sec</span>
          </div>
        </label>
        <div class="we-field-subhead">Target</div>
        <div class="we-field we-target-row">
          <span class="we-field-label">Target type</span>
          <div class="we-target-row-controls">
            ${_targetTypeSegmented('ap-target-type', TARGET_TYPES.POWER, this._enabledTargetTypes)}
          </div>
        </div>
        <div class="we-target-value-row">
          ${_rampToggle('ap-ramp-toggle', false)}
          <label class="we-field" id="ap-target-field">
            <span class="we-field-label">Target</span>
            <span class="we-field-readout" id="ap-target-readout"></span>
            <div class="we-field-control">
              <input class="input" type="number" id="ap-target" step="0.01" value="0.60" />
              <span class="we-unit-badge" id="ap-target-unit">${_targetUnit(TARGET_TYPES.POWER)}</span>
            </div>
          </label>
          <label class="we-field hidden" id="ap-start-field">
            <span class="we-field-label">Start</span>
            <div class="we-field-control">
              <input class="input" type="number" id="ap-start" step="0.01" value="0.60" />
              <span class="we-unit-badge" id="ap-start-unit">${_targetUnit(TARGET_TYPES.POWER)}</span>
            </div>
            <span class="we-field-readout" id="ap-start-readout"></span>
          </label>
          <label class="we-field hidden" id="ap-end-field">
            <span class="we-field-label">End</span>
            <div class="we-field-control">
              <input class="input" type="number" id="ap-end" step="0.01" value="0.90" />
              <span class="we-unit-badge" id="ap-end-unit">${_targetUnit(TARGET_TYPES.POWER)}</span>
            </div>
            <span class="we-field-readout" id="ap-end-readout"></span>
          </label>
        </div>
      </div>
      <div class="we-editor-actions">
        <button class="btn btn-primary" id="ap-insert">Insert</button>
        <button class="btn btn-ghost"   id="ap-cancel">Cancel</button>
      </div>
    `;

    this._bindTargetControls(panel, {
      groupId: 'ap-target-type',
      unitIds: ['ap-target-unit', 'ap-start-unit', 'ap-end-unit'],
      fields: [
        { valueId: 'ap-target', readoutId: 'ap-target-readout' },
        { valueId: 'ap-start',  readoutId: 'ap-start-readout' },
        { valueId: 'ap-end',    readoutId: 'ap-end-readout' },
      ],
    });
    this._bindRampToggle(panel, {
      toggleId:      'ap-ramp-toggle',
      steadyFieldId: 'ap-target-field',
      rampFieldIds:  ['ap-start-field', 'ap-end-field'],
      steadyValueId: 'ap-target',
      startValueId:  'ap-start',
      endValueId:    'ap-end',
    });

    panel.querySelector('#ap-insert').addEventListener('click', () => this._insertFromAddPanel());
    panel.querySelector('#ap-cancel').addEventListener('click', () => this._closeAddPanel());
    panel.querySelector('#ap-close-x').addEventListener('click', () => this._closeAddPanel());
    // Enter submits, Escape cancels, from anywhere in the form.
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); this._insertFromAddPanel(); }
      if (e.key === 'Escape') { e.preventDefault(); this._closeAddPanel(); }
    });
  }

  /**
   * Wires a segmented control rendered by _targetTypeSegmented() to
   * everything in the panel that depends on which target type is active:
   *   - the segmented control's own active/inactive button states
   *   - the unit hint badge(s) next to each value field (e.g. "(% grade)")
   *   - the panel header's accent color and icon color, via --we-accent —
   *     so the whole form re-tints (power=orange, slope=indigo,
   *     resistance=teal) the instant a different target type is picked
   *   - the live numeric readout(s) under each value field (e.g. typing
   *     0.75 under a Power target shows "≈ 210 W" against the current FTP)
   * Both the Add-step panel and the per-step editor share this one binder
   * so the two forms can't drift apart in behavior.
   */
  _bindTargetControls(root, { groupId, unitIds = [], fields = [] }) {
    const group  = root.querySelector(`#${groupId}`);
    const header = root.querySelector('.we-panel-header');

    // Set on `root` — the whole panel — rather than on the segmented
    // group itself, since the CSS that reads --seg-accent (the field
    // readouts in particular) lives in sibling .we-field elements, not
    // inside the segmented control. A custom property only cascades to
    // descendants, so the common ancestor of "the control" and "every
    // readout that should match its color" is the panel, not the group.
    const applyAccent = (type) => {
      const color = TARGET_TYPE_COLOR[type] ?? 'var(--indigo)';
      root.style.setProperty('--seg-accent', color);
      if (header) header.style.setProperty('--we-accent', color);
    };

    const refreshReadouts = () => {
      const type = group?.querySelector('.segmented-btn.active')?.dataset.value ?? TARGET_TYPES.POWER;
      fields.forEach(({ valueId, readoutId }) => {
        const input = root.querySelector(`#${valueId}`);
        const out   = root.querySelector(`#${readoutId}`);
        if (!out) return;
        const v = parseFloat(input?.value);
        out.textContent = Number.isFinite(v) ? _targetReadoutText(type, v, this._ftp) : '';
      });
    };

    group?.addEventListener('click', (e) => {
      const btn = e.target.closest('.segmented-btn');
      if (!btn) return;
      const prevType = group.querySelector('.segmented-btn.active')?.dataset.value;
      const newType  = btn.dataset.value;

      group.querySelectorAll('.segmented-btn').forEach(b => b.classList.toggle('active', b === btn));
      applyAccent(newType);
      unitIds.forEach(uid => {
        const el = root.querySelector(`#${uid}`);
        if (el) el.textContent = _targetUnit(newType);
      });

      // Reset the value field(s) to defaults for the newly-picked type —
      // see TARGET_TYPE_DEFAULTS above. Skipped when the click landed on
      // the type that was already active (e.g. re-clicking the current
      // pill), so it never clobbers a value the rider actually typed.
      if (newType !== prevType) {
        const defaults = TARGET_TYPE_DEFAULTS[newType];
        const [mainField, startField, endField] = fields;
        if (defaults && mainField)  { const el = root.querySelector(`#${mainField.valueId}`);  if (el) el.value = defaults.value; }
        if (defaults && startField) { const el = root.querySelector(`#${startField.valueId}`); if (el) el.value = defaults.start; }
        if (defaults && endField)   { const el = root.querySelector(`#${endField.valueId}`);   if (el) el.value = defaults.end; }
      }

      refreshReadouts();
    });

    fields.forEach(({ valueId }) => {
      root.querySelector(`#${valueId}`)?.addEventListener('input', refreshReadouts);
    });

    applyAccent(group?.querySelector('.segmented-btn.active')?.dataset.value ?? TARGET_TYPES.POWER);
    refreshReadouts();
  }

  /**
   * Wires the Ramp switch that sits beside the Target field (see
   * _rampToggle()) to the two field groups it toggles between: a single
   * flat Target field when off, or a split Start/End pair when on.
   * Shared by the Add-step panel and the per-step editor, same reasoning
   * as _bindTargetControls above.
   *
   * Flipping the switch carries the current value across the split
   * rather than resetting it, so turning Ramp on starts from the flat
   * value that was just showing (Start = End = that value, ready to
   * nudge one side), and turning it back off collapses to whatever
   * Start was left at.
   */
  _bindRampToggle(root, { toggleId, steadyFieldId, rampFieldIds, steadyValueId, startValueId, endValueId }) {
    const toggle   = root.querySelector(`#${toggleId}`);
    const steadyEl = root.querySelector(`#${steadyFieldId}`);
    const rampEls  = rampFieldIds.map(id => root.querySelector(`#${id}`));
    if (!toggle) return;

    const applyVisibility = () => {
      const on = toggle.checked;
      steadyEl?.classList.toggle('hidden', on);
      rampEls.forEach(el => el?.classList.toggle('hidden', !on));
    };

    toggle.addEventListener('change', () => {
      const steadyInput = root.querySelector(`#${steadyValueId}`);
      const startInput  = root.querySelector(`#${startValueId}`);
      const endInput    = root.querySelector(`#${endValueId}`);
      if (toggle.checked) {
        const v = steadyInput?.value ?? '';
        if (startInput) startInput.value = v;
        if (endInput)   endInput.value   = v;
      } else if (steadyInput) {
        steadyInput.value = startInput?.value ?? steadyInput.value;
      }
      applyVisibility();
      steadyInput?.dispatchEvent(new Event('input'));
      startInput?.dispatchEvent(new Event('input'));
      endInput?.dispatchEvent(new Event('input'));
    });

    applyVisibility();
  }

  _insertFromAddPanel() {
    const get = id => this._container.querySelector(`#${id}`)?.value;
    const num = (id, fallback) => {
      const v = parseFloat(get(id));
      return Number.isFinite(v) ? v : fallback;
    };

    const name       = (get('ap-name') || '').trim();
    const duration   = Math.max(1, Math.round(num('ap-duration', 60)));
    const targetType = this._container.querySelector('#ap-target-type .segmented-btn.active')?.dataset.value
      ?? TARGET_TYPES.POWER;
    // Ramp off: the single Target field is used as both ends, which
    // plays back as a flat, steady effort — one tool covers both shapes,
    // so there's no separate "Steady" creation path to keep in sync with
    // this one. Ramp on: Start and End come from their own split fields.
    const rampOn = this._container.querySelector('#ap-ramp-toggle')?.checked ?? false;
    const steady = num('ap-target', 0.5);
    const start  = rampOn ? num('ap-start', steady) : steady;
    const end    = rampOn ? num('ap-end', steady)   : steady;

    const inserted = [createRampStep({
      name, duration, targetType,
      startValue: start, endValue: end,
    })];

    const insertAt = this._model.steps.length;
    this._model.steps.push(...inserted);
    this._selected = insertAt;
    this._closeAddPanel();
    this._refresh();
    this._renderStepEditor(this._selected);
  }

  // ─── Step editor panel ───────────────────────────────────────────────────────

  _renderStepEditor(idx) {
    const panel = this._container.querySelector('#we-step-editor');
    const step  = this._model.steps[idx];
    if (!step) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');

    const isInterval = step.type === STEP_TYPES.INTERVAL;
    const isFree     = step.type === STEP_TYPES.FREE_RIDE;
    const isRamp     = step.type === STEP_TYPES.RAMP;

    // Whether this step currently has a genuine Start≠End ramp — drives
    // the Ramp toggle's initial position (see _bindRampToggle below) so a
    // step loaded with a real gradient opens already split into Start/
    // End, while a flat one opens collapsed to the single Target field.
    const rampOn = step.targetHigh != null && step.targetHigh !== step.targetLow;

    // Splitting into fixed steps only makes sense for a SLOPE-target ramp
    // that actually changes value — a trainer's slope/resistance control
    // generally can't smoothly chase a moving grade the way ERG mode
    // chases a moving power target, so this offers the staircase shape
    // back out for that one case. See core/cardio-model.js#stepsFromRamp.
    const showSplit = isRamp
      && step.targetType === TARGET_TYPES.SLOPE
      && step.targetHigh != null
      && step.targetHigh !== step.targetLow;

    // Header accent: a target-having step (ramp/steady/etc.) tracks its
    // *target type*'s color, kept in sync live by _bindTargetControls
    // below; a free-ride or interval step (no single target type) falls
    // back to its own swatch color instead.
    const headerColor = (!isFree && !isInterval) ? TARGET_TYPE_COLOR[step.targetType] : _swatchColor(step);

    panel.innerHTML = `
      <div class="we-panel-header" style="--we-accent:${headerColor}">
        <span class="we-panel-header-icon"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#${_typeIcon(step)}"/></svg></span>
        <h4 class="we-panel-title">Edit ${_typeLabel(step)}</h4>
        <button type="button" class="we-panel-close" id="se-close-x" aria-label="Close">
          <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg>
        </button>
      </div>
      <div class="we-editor-grid">
        <label class="we-field">
          <span class="we-field-label">Step name</span>
          <input class="input" type="text" id="se-name" placeholder="${_typeLabel(step)}" />
        </label>
        <label class="we-field">
          <span class="we-field-label">Timespan</span>
          <div class="we-field-control">
            <input class="input" type="number" id="se-duration" value="${step.duration ?? 60}" min="1" />
            <span class="we-unit-badge">sec</span>
          </div>
        </label>
        ${!isFree && !isInterval ? `
        <div class="we-field-subhead">Target</div>
        <div class="we-field we-target-row">
          <span class="we-field-label">Target type</span>
          <div class="we-target-row-controls">
            ${_targetTypeSegmented('se-target-type', step.targetType, this._enabledTargetTypes)}
          </div>
        </div>
        <div class="we-target-value-row">
          ${_rampToggle('se-ramp-toggle', rampOn)}
          <label class="we-field${rampOn ? ' hidden' : ''}" id="se-target-field">
            <span class="we-field-label">Target</span>
            <div class="we-field-control">
              <input class="input" type="number" id="se-target" value="${step.targetLow ?? 0}" step="0.01" />
              <span class="we-unit-badge" id="se-target-unit">${_targetUnit(step.targetType)}</span>
            </div>
            <span class="we-field-readout" id="se-target-readout"></span>
          </label>
          <label class="we-field${rampOn ? '' : ' hidden'}" id="se-target-low-field">
            <span class="we-field-label">Start</span>
            <div class="we-field-control">
              <input class="input" type="number" id="se-target-low" value="${step.targetLow ?? 0}" step="0.01" />
              <span class="we-unit-badge" id="se-target-low-unit">${_targetUnit(step.targetType)}</span>
            </div>
            <span class="we-field-readout" id="se-target-low-readout"></span>
          </label>
          <label class="we-field${rampOn ? '' : ' hidden'}" id="se-target-high-field">
            <span class="we-field-label">End</span>
            <div class="we-field-control">
              <input class="input" type="number" id="se-target-high" value="${step.targetHigh ?? step.targetLow ?? 0}" step="0.01" />
              <span class="we-unit-badge" id="se-target-high-unit">${_targetUnit(step.targetType)}</span>
            </div>
            <span class="we-field-readout" id="se-target-high-readout"></span>
          </label>
        </div>
        <label class="we-field">
          <span class="we-field-label">Cadence target <span class="we-field-note">(0 = none)</span></span>
          <div class="we-field-control">
            <input class="input" type="number" id="se-cadence" value="${step.cadenceTarget ?? 0}" min="0" max="200" />
            <span class="we-unit-badge">rpm</span>
          </div>
        </label>
        ${showSplit ? `
        <div class="we-field-subhead">
          Split into steps
          <button type="button" class="info-btn" aria-label="Why split into steps"
            data-tip="Some trainers can't smoothly chase a moving slope the way ERG mode chases a moving power target — splitting turns this ramp into a run of fixed-grade steps instead.">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
          </button>
        </div>
        <div class="we-split-row">
          <label class="we-field">
            <span class="we-field-label">Divisions</span>
            <input class="input input-num" type="number" id="se-split-count" min="2" max="40" value="5" />
          </label>
          <button type="button" class="btn btn-ghost we-split-btn" id="se-split-btn">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-stairs"/></svg>
            <span class="btn-label">Split</span>
          </button>
        </div>
        ` : ''}
        ` : ''}
        ${isInterval ? `
        <label class="we-field">
          <span class="we-field-label">Repeats</span>
          <div class="we-field-control">
            <input class="input" type="number" id="se-repeat" value="${step.repeat ?? 5}" min="1" max="50" />
            <span class="we-unit-badge">×</span>
          </div>
        </label>
        <div class="we-field-subhead">On / off</div>
        <label class="we-field">
          <span class="we-field-label">On duration</span>
          <div class="we-field-control">
            <input class="input" type="number" id="se-on-dur" value="${step.onStep?.duration ?? 60}" min="1" />
            <span class="we-unit-badge">sec</span>
          </div>
        </label>
        <label class="we-field">
          <span class="we-field-label">On power</span>
          <div class="we-field-control">
            <input class="input" type="number" id="se-on-pow" value="${step.onStep?.targetLow ?? 1.20}" step="0.01" />
            <span class="we-unit-badge">×FTP</span>
          </div>
          <span class="we-field-readout" id="se-on-pow-readout"></span>
        </label>
        <label class="we-field">
          <span class="we-field-label">Off duration</span>
          <div class="we-field-control">
            <input class="input" type="number" id="se-off-dur" value="${step.offStep?.duration ?? 60}" min="1" />
            <span class="we-unit-badge">sec</span>
          </div>
        </label>
        <label class="we-field">
          <span class="we-field-label">Off power</span>
          <div class="we-field-control">
            <input class="input" type="number" id="se-off-pow" value="${step.offStep?.targetLow ?? 0.50}" step="0.01" />
            <span class="we-unit-badge">×FTP</span>
          </div>
          <span class="we-field-readout" id="se-off-pow-readout"></span>
        </label>
        ` : ''}
      </div>
      <div class="we-editor-actions">
        <button class="btn btn-primary" id="se-apply">Apply</button>
        <button class="btn btn-ghost"   id="se-close">Close</button>
      </div>
    `;

    // Set via JS rather than an HTML value="" attribute, same reasoning as
    // #we-name in _refresh(): a step name containing a quote would
    // otherwise break out of the attribute.
    panel.querySelector('#se-name').value = step.name ?? '';

    if (!isFree && !isInterval) {
      this._bindTargetControls(panel, {
        groupId: 'se-target-type',
        unitIds: ['se-target-unit', 'se-target-low-unit', 'se-target-high-unit'],
        fields: [
          { valueId: 'se-target',      readoutId: 'se-target-readout' },
          { valueId: 'se-target-low',  readoutId: 'se-target-low-readout' },
          { valueId: 'se-target-high', readoutId: 'se-target-high-readout' },
        ],
      });
      this._bindRampToggle(panel, {
        toggleId:      'se-ramp-toggle',
        steadyFieldId: 'se-target-field',
        rampFieldIds:  ['se-target-low-field', 'se-target-high-field'],
        steadyValueId: 'se-target',
        startValueId:  'se-target-low',
        endValueId:    'se-target-high',
      });
    }

    // The interval on/off power fields are always POWER-targeted (no
    // segmented control of their own to read from), so their readouts
    // wire up directly rather than through _bindTargetControls.
    if (isInterval) {
      const onInput  = panel.querySelector('#se-on-pow');
      const onOut    = panel.querySelector('#se-on-pow-readout');
      const offInput = panel.querySelector('#se-off-pow');
      const offOut   = panel.querySelector('#se-off-pow-readout');
      const refresh = (input, out) => {
        const v = parseFloat(input?.value);
        if (out) out.textContent = Number.isFinite(v) ? _targetReadoutText(TARGET_TYPES.POWER, v, this._ftp) : '';
      };
      onInput?.addEventListener('input', () => refresh(onInput, onOut));
      offInput?.addEventListener('input', () => refresh(offInput, offOut));
      refresh(onInput, onOut);
      refresh(offInput, offOut);
    }

    panel.querySelector('#se-split-btn')?.addEventListener('click', () => {
      const count = Math.max(2, Math.round(parseFloat(panel.querySelector('#se-split-count')?.value) || 5));
      this._splitRampToSteps(idx, count);
    });

    panel.querySelector('#se-apply').addEventListener('click', () => {
      this._applyStepEdit(idx);
    });
    const closeEditor = () => {
      panel.classList.add('hidden');
      this._selected = null;
      this._refresh();
    };
    panel.querySelector('#se-close')?.addEventListener('click', closeEditor);
    panel.querySelector('#se-close-x')?.addEventListener('click', closeEditor);
  }

  _applyStepEdit(idx) {
    const step = this._model.steps[idx];
    if (!step) return;

    const get = id => this._container.querySelector(`#${id}`)?.value;
    const num = id => parseFloat(get(id)) || 0;

    step.name     = (get('se-name') || '').trim();
    step.duration = Math.max(1, Math.round(num('se-duration')));

    if (step.type === STEP_TYPES.RAMP) {
      // The builder only ever creates straight-line ramps now — applying
      // an edit normalizes the curve to linear even if this step arrived
      // via import or an older save with an eased ("parabolic") curve.
      step.curve = 'linear';
    }

    if (step.type !== STEP_TYPES.FREE_RIDE && step.type !== STEP_TYPES.INTERVAL) {
      step.targetType = this._container.querySelector('#se-target-type .segmented-btn.active')?.dataset.value
        ?? step.targetType;

      // Ramp toggle off: the single Target field is the flat value for
      // the whole step. On: Start/End come from their own split fields —
      // still collapsed back to a flat (null-high) step if a user leaves
      // them equal, same as before, but no longer gated on End being
      // positive, which used to silently drop a legitimate negative
      // Slope-grade End (e.g. ramping down to a -5% descent).
      const rampOn = this._container.querySelector('#se-ramp-toggle')?.checked ?? false;
      if (rampOn) {
        step.targetLow  = num('se-target-low');
        const hi        = num('se-target-high');
        step.targetHigh = hi !== step.targetLow ? hi : null;
      } else {
        step.targetLow  = num('se-target');
        step.targetHigh = null;
      }
      const cad = num('se-cadence');
      step.cadenceTarget = cad > 0 ? cad : null;
    }

    if (step.type === STEP_TYPES.INTERVAL) {
      step.repeat = Math.max(1, Math.round(num('se-repeat')));
      if (!step.onStep)  step.onStep  = createStep({ type: STEP_TYPES.STEADY });
      if (!step.offStep) step.offStep = createStep({ type: STEP_TYPES.REST });
      step.onStep.duration    = Math.max(1, Math.round(num('se-on-dur')));
      step.onStep.targetLow   = num('se-on-pow');
      step.offStep.duration   = Math.max(1, Math.round(num('se-off-dur')));
      step.offStep.targetLow  = num('se-off-pow');
      step.duration = (step.onStep.duration + step.offStep.duration) * step.repeat;
    }

    this._refresh();
    // Re-render (rather than leave the previous markup showing) so a
    // target-type change is reflected immediately — e.g. the "Split into
    // steps" section above appearing the moment a ramp becomes
    // Slope-targeted, without having to close and reopen this panel.
    this._renderStepEditor(idx);
  }

  /**
   * Replaces a single RAMP step with a run of discrete flat zones covering
   * the same start-to-end range — see core/cardio-model.js#stepsFromRamp.
   * Only reachable from the Slope-target "Split into steps" action above.
   */
  _splitRampToSteps(idx, divisions) {
    const step = this._model.steps[idx];
    if (!step) return;
    const zones = stepsFromRamp(step, divisions);
    this._model.steps.splice(idx, 1, ...zones);
    this._selected = null;
    this._refresh();
    this._renderStepEditor(this._selected);
  }

  // ─── Preview chart ───────────────────────────────────────────────────────────

  /**
   * Draws the shape preview with ui/hud-timeline.js — the painter behind the live session's target
   * map — so the two cannot drift: a solid 2px line along each step's target with a glow that softens
   * to nothing beneath it (no floor, no side walls), a ramp following the curve the trainer is
   * actually sent, every height a fraction of the workout's highest target, a step with no target
   * sitting on the baseline, and the live HUD's own step colours and Metric-token strengths. Like the
   * live map it is drawn at the screen's pixel density on a transparent canvas — the glass behind it
   * is the card's (.we-preview-card), as the HUD's is the scripted HUD's. What it does not have is
   * the live map's "now" line, dot and number: nothing is running here.
   */
  _renderPreview() {
    const canvas = this._container.querySelector('#we-preview');
    if (!canvas) return;

    const flat = flattenWorkout(this._model);
    this._previewSteps = flat;
    // Before any step exists there's nothing to plot — mark the wrap empty so CSS can show an idle
    // baseline and a pulsing cursor at the start of the timeline (see .we-preview-wrap.is-empty)
    // instead of leaving the canvas a blank rectangle.
    this._container.querySelector('#we-preview-wrap')?.classList.toggle('is-empty', flat.length === 0);

    if (flat.length === 0) {
      // drawTimeline() returns without touching the canvas when there is nothing to draw, so wipe
      // whatever the last workout left (the canvas is transparent now, nothing paints over it).
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    drawTimeline(canvas, flat, { colorFor: _previewColor });

    // The drawing is made at the canvas's pixel size, so it is redrawn when that changes (a phone
    // turned on its side, a resized window) — the same ResizeObserver the live map uses. Skipped
    // while the panel is hidden (a zero box); onShow() redraws once it is visible.
    if (!this._previewResize && typeof ResizeObserver === 'function') {
      let lastW = canvas.clientWidth, lastH = canvas.clientHeight;
      this._previewResize = new ResizeObserver(() => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!this._previewSteps?.length || !w || !h || (w === lastW && h === lastH)) return;
        lastW = w; lastH = h;
        drawTimeline(canvas, this._previewSteps, { colorFor: _previewColor });
      });
      this._previewResize.observe(canvas);
    }
  }

  // ─── Footer ─────────────────────────────────────────────────────────────────

  _renderFooter() {
    const el  = this._container.querySelector('#we-footer');
    if (!el) return;
    const dur   = totalDuration(this._model);
    const steps = this._model.steps.length;
    // Same .stat-chip instrument-readout tile the post-workout recap and
    // history cards use (chromatic left bar + tabular-nums value + muted
    // caption) — see the Stat chips section in style.css — rather than a
    // plain caption line, so the workout's own vitals read the same way
    // a completed session's do.
    el.innerHTML = `
      <div class="stat-chip" data-metric="steps">
        <span class="stat-val">${steps}</span>
        <span class="stat-lbl">Step${steps !== 1 ? 's' : ''}</span>
      </div>
      <div class="stat-chip" data-metric="duration">
        <span class="stat-val">${_fmtDuration(dur)}</span>
        <span class="stat-lbl">Total time</span>
      </div>
    `;
  }

  // ─── Import / export ─────────────────────────────────────────────────────────

  async _importFile(file) {
    if (!file) return;
    try {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      let content;

      // FIT is binary — read as ArrayBuffer
      if (ext === '.fit') {
        content = await file.arrayBuffer();
      } else {
        content = await file.text();
      }

      const model = registry.parse(content, ext);
      this.load(model);
    } catch (err) {
      alert('Import failed: ' + err.message);
      console.error('[workout-editor] Import error', err);
    }
  }

  _export(ext) {
    this._model.name = this._container.querySelector('#we-name')?.value || this._model.name;
    try {
      let content;
      let mimeType = 'text/plain';

      if (ext === '.fit') {
        content  = registry.write(this._model, ext);
        mimeType = 'application/octet-stream';
      } else {
        content = registry.write(this._model, ext);
      }

      const blob = new Blob([content], { type: mimeType });
      const name = (this._model.name ?? 'workout').replace(/[^a-z0-9]/gi, '_');
      saveFile(`${name}${ext}`, blob);
    } catch (err) {
      alert('Export failed: ' + err.message);
      console.error('[workout-editor] Export error', err);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Accepts either a step object or a bare STEP_TYPES value (some callers
// only have the type). RAMP steps are labeled by their curve — "Linear"
// or "Parabolic" — purely for legacy display: the builder itself only
// ever creates (and, after any edit, normalizes to) linear ramps now. A
// bare-type call falls back to "Linear" (the default curve).
function _typeLabel(stepOrType) {
  const isStep = typeof stepOrType === 'object' && stepOrType !== null;
  const type   = isStep ? stepOrType.type : stepOrType;

  if (type === STEP_TYPES.RAMP) {
    return isStep && stepOrType.curve === 'parabolic' ? 'Parabolic' : 'Linear';
  }
  return {
    [STEP_TYPES.WARMUP]:    'Warm-up',
    [STEP_TYPES.COOLDOWN]:  'Cooldown',
    [STEP_TYPES.STEADY]:    'Steady',
    [STEP_TYPES.REST]:      'Rest',
    [STEP_TYPES.FREE_RIDE]: 'Free Ride',
    [STEP_TYPES.INTERVAL]:  'Interval',
  }[type] ?? type;
}

// Renders a segmented control (see .segmented in style.css — the same
// pattern as the Settings page's Units toggle) for choosing a
// TARGET_TYPES value. Returned as a themed button group rather than a
// native <select> so target type reads as a first-class choice consistent
// with the rest of the app, instead of dropping into a plain browser
// widget partway through an otherwise custom-styled form. Each option
// carries its own icon; the active pill's color (--seg-accent) is set by
// _bindTargetControls() on the whole panel, not here, since it also has
// to reach sibling readout fields the control itself has no descendant
// relationship with.
function _targetTypeSegmented(id, current, enabledTypes = ALL_TARGET_TYPES) {
  // Always include `current` even if it's since been turned off in
  // Settings → Targets — a step already using a type shouldn't have that
  // choice vanish out from under it mid-edit; disabling a type there only
  // hides it from being newly *picked* elsewhere, same contract the
  // Settings page's own info tooltip describes (see index.html).
  const options = TARGET_TYPE_OPTIONS.filter(opt => opt.value === current || enabledTypes.includes(opt.value));
  return `
    <div class="segmented we-target-segmented" id="${id}" role="group" aria-label="Target type">
      ${options.map(opt => `
        <button type="button" class="segmented-btn${opt.value === current ? ' active' : ''}" data-value="${opt.value}">
          <svg class="btn-icon" viewBox="0 0 24 24"><use href="#${opt.icon}"/></svg>
          <span>${opt.label}</span>
        </button>
      `).join('')}
    </div>
  `;
}

// Renders the Ramp switch that sits to the left of the Target field
// (inside .we-target-value-row, ahead of the Target/Start/End labels) —
// flipping it is what splits the single flat Target field into a
// Start/End pair, or collapses them back down; see _bindRampToggle(). It
// lives as a persistent sibling there rather than inside the Target field
// itself, since that field gets hidden once Ramp is on — nesting the
// switch inside it would hide the only control that can switch it back
// off. The switch itself reuses the app's standard .switch component
// (same markup as the Settings page's toggles) so it doesn't introduce a
// new control style; the label text and info button sit outside that
// switch's own <label>, not inside it, so tapping the info icon doesn't
// also flip the switch it's sitting next to.
function _rampToggle(id, checked) {
  return `
    <div class="we-ramp-toggle">
      <label class="switch">
        <input type="checkbox" id="${id}"${checked ? ' checked' : ''} />
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </label>
      <span class="we-ramp-toggle-label">Ramp</span>
      <button type="button" class="info-btn" aria-label="What Ramp does"
        data-tip="Off: one flat target for the whole step. On: split the target into a Start and an End value, so it changes gradually across the step.">
        <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
      </button>
    </div>
  `;
}

// Live numeric readout shown under a target value field as it's typed —
// e.g. "≈ 210 W" under a Power target's 0.75 — so the abstract 0–2 FTP
// multiplier (or % grade, or % resistance) the model actually stores has
// a concrete, current-FTP-relative number sitting right next to it. For
// Heart Rate, there's no unit conversion to show (bpm is already the
// stored unit) — instead this surfaces the actual acceptable zone
// (target ± HR_TOLERANCE_BPM, see core/cardio-model.js#heartRateZone)
// so the rider can see exactly what will and won't trigger an audio
// nudge during playback. Rounds rather than truncates; returns '' for a
// value that isn't finite yet (an empty or mid-edit field) so the caller
// can blank the readout instead of showing "NaN".
function _targetReadoutText(targetType, value, ftp) {
  if (!Number.isFinite(value)) return '';
  switch (targetType) {
    case TARGET_TYPES.POWER:      return `≈ ${Math.round(value * ftp)} W`;
    case TARGET_TYPES.SLOPE:      return `${value.toFixed(1)}% grade`;
    case TARGET_TYPES.RESISTANCE: return `${Math.round(value)}% resistance`;
    case TARGET_TYPES.HEART_RATE: {
      const { low, high } = heartRateZone(value);
      return `nudges outside ${Math.round(low)}–${Math.round(high)} bpm`;
    }
    default: return '';
  }
}

function _targetUnit(targetType) {
  return {
    [TARGET_TYPES.POWER]:      '(0–2x FTP)',
    [TARGET_TYPES.SLOPE]:      '(% grade)',
    [TARGET_TYPES.RESISTANCE]: '(0–100%)',
    [TARGET_TYPES.HEART_RATE]: '(bpm)',
  }[targetType] ?? '';
}

// Minimal HTML-escaper for the one piece of rider-authored text this file
// interpolates into markup outside a form control's `value` attribute — a
// custom preset's saved label, in the "Load a preset timeline" select
// built by _renderPresetLoadRow(). Every other string this file inserts is
// either fixed copy or a plain numeric readout.
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function _fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default WorkoutEditor;
