// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/strength-session-flow.js
 *
 * Single-screen strength setup — opened from the floating "+" button's
 * pillbox menu ("Strength Session" item), the strength counterpart to
 * ui/cardio-session-flow.js's "Cardio Session" screen. Same
 * shape/CSS (.setup-flow/.sf-*) as that file, scaled to what a strength
 * session actually needs:
 *
 *   1. Equipment     (HRM connect row only — a strength session has no
 *                      trainer/controller of its own, see
 *                      views/strength-session.js's own doc comment; always
 *                      visible, independent of anything picked below)
 *   2. Muscle Group  (data/workout-sequences.js's SEQUENCE_FOCUS_GROUPS —
 *                      defaults to Full Body)
 *   3. Style         (data/workout-sequences.js's WORKOUT_STYLES —
 *                      Calisthenics vs. Weights / Home Gym)
 *   4. Resistance Sequence — a dropdown: a collapsed row showing the current
 *      pick that expands into a column of cards, one per preset sequence for
 *      the picked muscle group + style (data/workout-sequences.js's
 *      presetSequencesFor()), each in its full card form (icon, info tap,
 *      scheme, exercise chips), then "+ Create Your Own Sequence" at the end
 *      to open a build-your-own step (it was a swipeable card strip in
 *      deltas 18–25; the dropdown is back by request):
 *      search/browse data/exercises.js's catalog and tap exercises on, in
 *      the order they'll be done, reorder/remove as needed, then
 *      "Use This Sequence" to finalize (data/workout-sequences.js's
 *      buildCustomSequence()).
 *   5. Session name  (seeded from the muscle group + chosen sequence,
 *                      fully editable)
 *
 * Step 5 only appears once a sequence has been picked — the whole point
 * of this rewrite (previously: Focus, then straight to Name/Equipment,
 * with exercises picked one at a time once the session panel was already
 * running) is that the session's whole exercise structure is chosen here,
 * before views/strength-session.js ever mounts. That panel still has its
 * own Browse picker for swapping a step's exercise or logging something
 * unplanned mid-session — this flow just stops making "pick exercises one
 * at a time" the *first* thing a rider has to do. Equipment sits above all
 * of that (and stays visible throughout) since connecting an HRM has
 * nothing to do with which sequence ends up picked — no reason to make
 * someone wait on it.
 *
 * ── Weekly schedule ──────────────────────────────────────────────────────
 * A rider can map each day of the week to a SEQUENCE_FOCUS_GROUPS value (or
 * "Rest Day") via the "Edit Weekly Schedule" link above the Muscle Group
 * step — persisted as a single `weeklyStrengthSchedule` pref (see
 * _loadSchedule()/_saveSchedule(); storage/db.js's plain getPref()/setPref()
 * is enough here, same "one small object, not a collection" reasoning
 * profile-level prefs like lastQuickStart already use, no new object store
 * needed). Every _blankDraft() (a fresh open(), or returning from the
 * editor) re-derives the day-of-week's default via _scheduleDefaults():
 * today's scheduled focus becomes the pre-selected Muscle Group, and the
 * *first* preset resistance sequence for that focus (data/workout-sequences.js
 * lists 'foundations' first — see that file's SEQUENCE_TEMPLATES) becomes
 * the pre-selected Resistance Sequence, so a rider who set this up once can
 * open the flow and tap Start Session straight through on a scheduled day
 * — Muscle Group/Style/Sequence are still fully changeable before starting,
 * same as any other default here. A scheduled Rest Day shows a note instead
 * of pre-selecting anything (never blocks starting a session — someone
 * might train anyway) and a day with nothing scheduled behaves exactly as
 * this flow always has (defaults to Full Body, no sequence pre-picked).
 *
 * Tapping "Start Session" hands { focus, style, name, sequence } to
 * onStart — app.js's startStrengthSession() takes it from there (builds
 * the Session, mounts StrengthSessionPanel with the picked sequence
 * driving its step-by-step logging flow). There's no cardio-style
 * scripted WorkoutModel built here — a Sequence is an ordered exercise
 * list, not a set of timed/targeted steps.
 *
 * Usage:
 *   const strengthSetup = new StrengthSessionFlow({
 *     onStart:  (settings) => { ... },  // settings = { focus, style, name, sequence }
 *     onCancel: () => { ... },
 *     onConnectHrm: () => { ... },
 *   });
 *   strengthSetup.open();
 */

import { detailSheet } from './detail-sheet.js';
import { tileGroupHtml, deviceTileHtml, patchDeviceTile } from './setup-tiles.js';
import { CATEGORIES, exercisesForFocus, searchExercises, exerciseById } from '../data/exercises.js';
import { WORKOUT_STYLES, SEQUENCE_FOCUS_GROUPS, presetSequencesFor, buildCustomSequence } from '../data/workout-sequences.js';
import { db } from '../storage/db.js';

// Day-of-week schedule — keyed by JS Date#getDay() (0=Sunday…6=Saturday) so
// looking up "today" needs no translation, but *displayed* Monday-first
// (the order a training week is actually thought in). Each entry's value is
// either a SEQUENCE_FOCUS_GROUPS value, the literal 'rest', or null/absent
// (nothing scheduled that day).
const SCHEDULE_PREF_KEY = 'weeklyStrengthSchedule';
const _DAY_ORDER  = [1, 2, 3, 4, 5, 6, 0];
const _DAY_LABELS = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 0: 'Sunday' };

// One icon per SEQUENCE_TEMPLATES id (data/workout-sequences.js) — display
// only, purely so the six preset cards read as six distinct shapes at a
// glance instead of six blocks of near-identical text. Keyed by
// seq.templateId, not seq.id (which is a "focus:style:templateId"
// composite). A custom sequence has no templateId and never renders
// through _sequencePanelHtml's preset-card path, so it doesn't need an
// entry here.
const SEQUENCE_ICONS = {
  foundations: 'icon-grid',       // balanced default — even coverage
  strength:    'icon-dumbbell',   // fewer moves, heavier effort
  hypertrophy: 'icon-refresh',    // "Circuit" — the repeating-loop icon
  supersets:   'icon-duplicate',  // back-to-back pairs
  quick:       'icon-lightning',  // short on time
  finisher:    'icon-flame',      // burnout
};
const _DEFAULT_SEQUENCE_ICON = 'icon-grid';

// Icons for the Style tiles (ui/setup-tiles.js), keyed by data/workout-sequences.js's WORKOUT_STYLES values.
const STYLE_ICONS = { calisthenics: 'icon-user', weights: 'icon-dumbbell', halfAndHalf: 'icon-half' };

export class StrengthSessionFlow {
  /**
   * Lives in the shared detail sheet (ui/detail-sheet.js, `size: 'tall'`, `flush`), exactly as
   * CardioSessionFlow does: the sheet's Close, scrim tap, Esc and drag-down all count as Cancel
   * (onCancel runs); Start Session closes it without onCancel.
   * @param {Object}   opts
   * @param {Function} [opts.onStart]       ({focus, style, name, sequence}) => void
   * @param {Function} [opts.onCancel]      () => void
   * @param {Function} [opts.onConnectHrm]  () => void — "Connect" clicked for HRM
   */
  constructor({ onStart, onCancel, onConnectHrm } = {}) {
    this._handle = null;       // the open detail-sheet handle, or null
    this._root = null;         // the form's root element inside the sheet's body
    this._openToken = 0;       // tells a stale onClose (an old sheet finishing late) from the current one
    this._userClosing = false; // set by a Close / scrim / Esc / drag / Cancel, so onClose can fire onCancel
    this._onStart = onStart;
    this._onCancel = onCancel;
    this._onConnectHrm = onConnectHrm;

    // null until _loadSchedule() resolves — _scheduleReady lets open() wait
    // for that first read without every other method needing to guard
    // against "haven't loaded yet".
    this._schedule = null;
    this._scheduleReady = this._loadSchedule();

    this._draft = this._blankDraft();

    // Same tri-state convention as CardioSessionFlow — app.js's
    // _setDeviceStatus() pushes updates here so this always reflects true
    // BLE state, whether or not this flow happens to be the one open.
    this._deviceStatus = { hrm: 'disconnected' };
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  async open() {
    if (!this._schedule) await this._scheduleReady;
    this._draft = this._blankDraft();
    this._userClosing = false;
    const token = ++this._openToken;
    this._handle = detailSheet.open({
      title: 'Strength Session',
      subtitle: 'Pick a muscle group and style, then a resistance sequence to guide your session.',
      size: 'tall',
      flush: true,                                   // the form scrolls its own body and pins its own foot
      content: (body) => this._build(body),
      beforeClose: () => { this._userClosing = true; return true; },   // every user close is a Cancel
      onClose: () => {
        if (token !== this._openToken) return;       // a newer open() already took over
        const cancelled = this._userClosing;
        this._userClosing = false;
        this._handle = null;
        this._root = null;
        if (cancelled) this._onCancel?.();
      },
    });
  }

  get isOpen() { return !!this._handle?.isOpen; }

  /** Close the sheet. Does not call onCancel — that is only for the rider backing out. */
  close() {
    this._handle?.close();
  }

  /** @param {'hrm'} kind  @param {'disconnected'|'connecting'|'connected'} status */
  setDeviceStatus(kind, status) {
    if (!(kind in this._deviceStatus)) return;
    this._deviceStatus[kind] = status;
    patchDeviceTile(this._root, 'ss', 'hrm', status);   // a no-op if it isn't on screen (e.g. mid Weekly Schedule edit)
  }

  // ─── Weekly schedule ────────────────────────────────────────────────────

  async _loadSchedule() {
    const saved = await db.getPref(SCHEDULE_PREF_KEY, null).catch(() => null);
    this._schedule = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, ...(saved ?? {}) };
    return this._schedule;
  }

  async _saveSchedule(schedule) {
    this._schedule = schedule;
    await db.setPref(SCHEDULE_PREF_KEY, schedule).catch(() => {});
  }

  _todayIndex() {
    return new Date().getDay();
  }

  /** What today's schedule entry means for a fresh draft — the pre-picked
   *  Muscle Group + (first preset) Resistance Sequence on a scheduled day, a
   *  rest-day flag on a scheduled rest day, or the flow's original
   *  Full-Body/no-sequence defaults on a day with nothing scheduled. See
   *  this file's own doc comment ("Weekly schedule") for the reasoning. */
  _scheduleDefaults() {
    const entry = this._schedule?.[this._todayIndex()] ?? null;
    const isRestDay = entry === 'rest';
    const focus = (entry && !isRestDay) ? entry : 'fullBody';
    const style = WORKOUT_STYLES[0].value;

    let sequence = null;
    if (entry && !isRestDay) {
      sequence = presetSequencesFor(focus, style)[0] ?? null;
    }

    return {
      focus, style, sequence, isRestDay,
      name: sequence ? this._sequenceSessionName(focus, sequence) : this._focusLabel(focus),
    };
  }

  _sequenceSessionName(focus, sequence) {
    const focusLabel = this._focusLabel(focus);
    return sequence.custom ? `${focusLabel} — Custom Sequence` : `${focusLabel} — ${sequence.label}`;
  }

  // ─── Draft state ────────────────────────────────────────────────────────

  _blankDraft() {
    const scheduled = this._scheduleDefaults();
    return {
      ...scheduled,
      // Whether the Resistance Sequence dropdown's option panel is currently
      // open — see _sequencePickerHtml()/_sequenceTriggerHtml() below.
      sequenceMenuOpen: false,
      // Build-your-own sub-step state — only relevant while `building`.
      building: false,
      buildQuery: '',
      buildPicks: [],
      // Schedule-editor sub-step state — only relevant while `editingSchedule`.
      editingSchedule: false,
      scheduleDraft: null,
    };
  }

  _focusLabel(focus) {
    return SEQUENCE_FOCUS_GROUPS.find(g => g.value === focus)?.label ?? 'Full Body';
  }

  _canStart() {
    return !this._draft.editingSchedule && !this._draft.building && this._draft.sequence != null && this._draft.name.trim().length > 0;
  }

  /** The Cancel button: the same as any other way the rider backs out (onCancel runs from onClose). */
  _cancel() {
    this._userClosing = true;
    this.close();
  }

  _start() {
    if (!this._canStart()) return;
    const settings = {
      focus: this._draft.focus,
      style: this._draft.style,
      name: this._draft.name.trim(),
      sequence: this._draft.sequence,
    };
    this.close();
    this._onStart?.(settings);
  }

  /** Picking a new muscle group or style invalidates whatever sequence
   *  was chosen against the old pool — same "re-seed on change, stays
   *  editable after" convention as CardioSessionFlow's workout type. */
  _onFocusOrStyleChanged() {
    this._draft.sequence = null;
    this._draft.sequenceMenuOpen = false;
    this._draft.name = this._focusLabel(this._draft.focus);
  }

  _reseedNameFromSequence() {
    const { sequence } = this._draft;
    if (!sequence) return;
    this._draft.name = this._sequenceSessionName(this._draft.focus, sequence);
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  /** Content for the sheet's body (built each time the sheet opens). */
  _build(host) {
    host.innerHTML = `
      <div class="ds-flow">
        <div class="ds-flow-body" id="ss-body"></div>
        <div class="ds-flow-foot">
          <button class="btn btn-ghost" id="ss-cancel">Cancel</button>
          <button class="btn btn-glass-cta" id="ss-finish">Start Session</button>
        </div>
      </div>
    `;
    this._root = host.querySelector('.ds-flow');

    this._root.querySelector('#ss-cancel').addEventListener('click', () => this._cancel());
    this._root.querySelector('#ss-finish').addEventListener('click', () => this._start());

    this._refresh();
  }

  _refresh() {
    if (!this._root) return;
    this._renderBody();
    this._renderFoot();
  }

  _renderFoot() {
    const finishBtn = this._root.querySelector('#ss-finish');
    if (finishBtn) finishBtn.disabled = !this._canStart();
  }

  _renderBody() {
    const body = this._root.querySelector('#ss-body');
    const d = this._draft;

    if (d.editingSchedule) {
      body.innerHTML = this._scheduleEditorHtml();
      this._bindBodyEvents();
      return;
    }

    const status = this._deviceStatus.hrm;

    body.innerHTML = `
      ${this._scheduleBannerHtml()}

      <div class="sf-field">
        <span>Equipment</span>
        <div class="sf-device-grid" style="--cols:1">
          ${deviceTileHtml({ prefix: 'ss', kind: 'hrm', label: 'Heart Rate Monitor', icon: 'icon-heart', status })}
        </div>
      </div>

      <label class="sf-field">
        <span>Muscle Group</span>
        <select class="input full-width" id="ss-focus-select">
          ${SEQUENCE_FOCUS_GROUPS.map(g => `
            <option value="${g.value}" ${d.focus === g.value ? 'selected' : ''}>${_esc(g.label)}</option>
          `).join('')}
        </select>
      </label>

      <div class="sf-field">
        <span>Style</span>
        ${tileGroupHtml(WORKOUT_STYLES.map(s => ({ ...s, icon: STYLE_ICONS[s.value] })), { attr: 'data-style', selected: d.style })}
      </div>

      <div class="sf-field">
        <span>Resistance Sequence</span>
        <div id="ss-sequence-section">${d.building ? this._builderHtml() : this._sequencePickerHtml()}</div>
      </div>

      ${d.sequence ? `
        <label class="sf-field">
          <span>Session name</span>
          <input class="input full-width" id="ss-name" placeholder="e.g. Push Day" value="${_esc(d.name)}" />
        </label>
      ` : ''}
    `;
    this._bindBodyEvents();
  }

  // ─── Weekly schedule banner + editor ────────────────────────────────────

  _scheduleBannerHtml() {
    const todayLabel = _DAY_LABELS[this._todayIndex()];
    const entry = this._schedule?.[this._todayIndex()] ?? null;
    const text = entry === 'rest'
      ? `${todayLabel}: <strong>Rest Day</strong>.`
      : entry
        ? `${todayLabel}: <strong>${_esc(this._focusLabel(entry))}</strong> focus`
        : `${todayLabel}: Please select focus`;

    return `
      <div class="sf-schedule-banner">
        <span class="sf-schedule-banner-text">${text}</span>
        <button type="button" class="btn btn-ghost btn-sm" id="ss-edit-schedule">Edit Weekly Schedule</button>
      </div>
    `;
  }

  /** Full-body-swap sub-step (unlike the build-your-own sequence step,
   *  which only replaces the Resistance Sequence section — see this file's
   *  own doc comment) since a 7-day schedule has nothing to do with
   *  whatever Muscle Group/Style/Sequence happens to be selected while
   *  editing it. `d.scheduleDraft` is a working copy (`this._schedule`
   *  untouched until Save) so Back-without-saving is a true discard. */
  _scheduleEditorHtml() {
    const draft = this._draft.scheduleDraft;
    return `
      <button type="button" class="btn btn-ghost btn-sm sf-build-back" id="ss-schedule-back">&larr; Back</button>
      <h2 class="sf-title">Weekly Schedule</h2>
      <p class="sf-sub">Set a muscle group (or Rest Day) for each day — the setup screen will pick it as the default the next time that day comes around.</p>
      <div class="sf-schedule-list">
        ${_DAY_ORDER.map(day => `
          <div class="sf-schedule-row${day === this._todayIndex() ? ' sf-schedule-row--today' : ''}">
            <span class="sf-schedule-day-label">${_DAY_LABELS[day]}</span>
            <select class="input" data-schedule-day="${day}">
              <option value="" ${!draft[day] ? 'selected' : ''}>Not scheduled</option>
              <option value="rest" ${draft[day] === 'rest' ? 'selected' : ''}>Rest Day</option>
              ${SEQUENCE_FOCUS_GROUPS.map(g => `
                <option value="${g.value}" ${draft[day] === g.value ? 'selected' : ''}>${_esc(g.label)}</option>
              `).join('')}
            </select>
          </div>
        `).join('')}
      </div>
      <button type="button" class="btn btn-glass-cta full-width" id="ss-schedule-save">Save Schedule</button>
    `;
  }

  // ─── Sequence dropdown (collapsed trigger + expandable card panel) ─────
  //
  // A single dropdown-style field, the same "collapsed row that expands into a
  // taller panel" shape as ble-debug-flow.js's service rows and the cardio
  // flow's own sequence picker: .sf-sequence-trigger is the always-visible
  // collapsed row (the current pick, or a placeholder before anything's
  // chosen), and .sf-sequence-panel is the option list — the .sf-sequence-card
  // markup for every preset plus "+ Create Your Own Sequence", stacked in one
  // column — which only renders while d.sequenceMenuOpen is true. Picking a
  // card (or "Create Your Own") closes the panel, like a native <select>.
  // (Deltas 18–25 had this as a swipeable card strip; ui/setup-tiles.js's
  // cardStripHtml()/bindCardStrip() and the .sf-strip* CSS are still there,
  // unused by this flow.)

  _sequencePickerHtml() {
    const d = this._draft;
    return `
      <div class="sf-sequence-dropdown${d.sequenceMenuOpen ? ' open' : ''}" id="ss-sequence-dropdown">
        ${this._sequenceTriggerHtml()}
        ${d.sequenceMenuOpen ? this._sequencePanelHtml() : ''}
      </div>
    `;
  }

  /** The always-visible collapsed row — a compact summary of the picked
   *  sequence (the icon/label/scheme its card carries in the panel, in one
   *  row) or, before anything's picked, a plain placeholder. */
  _sequenceTriggerHtml() {
    const d = this._draft;
    const seq = d.sequence;
    return `
      <button type="button" class="sf-sequence-trigger" id="ss-sequence-trigger"
        aria-haspopup="listbox" aria-expanded="${d.sequenceMenuOpen ? 'true' : 'false'}">
        ${seq ? `
          <svg class="btn-icon sf-sequence-card-icon" viewBox="0 0 24 24">
            <use href="#${SEQUENCE_ICONS[seq.templateId] ?? _DEFAULT_SEQUENCE_ICON}"/>
          </svg>
          <span class="sf-sequence-trigger-label">${_esc(seq.label)}</span>
          <span class="sf-sequence-card-scheme sf-sequence-trigger-scheme">${_esc(seq.scheme)}</span>
        ` : `
          <span class="sf-sequence-trigger-placeholder">Choose a resistance sequence…</span>
        `}
        <svg class="btn-icon sf-sequence-trigger-chevron" viewBox="0 0 24 24"><use href="#icon-chevron-${d.sequenceMenuOpen ? 'up' : 'down'}"/></svg>
      </button>
    `;
  }

  /** The expanded option list: every preset for the current muscle group +
   *  style as a card (icon, label, info tap, scheme pill, exercise chips),
   *  then "+ Create Your Own Sequence". */
  _sequencePanelHtml() {
    const d = this._draft;
    const presets = presetSequencesFor(d.focus, d.style);
    return `
      <div class="sf-sequence-panel" role="listbox" aria-label="Resistance sequence">
        ${presets.map(seq => `
          <button type="button" class="sf-sequence-card${d.sequence?.id === seq.id ? ' selected' : ''}" role="option" aria-selected="${d.sequence?.id === seq.id}" data-sequence-id="${seq.id}">
            <div class="sf-sequence-card-head">
              <svg class="btn-icon sf-sequence-card-icon" viewBox="0 0 24 24">
                <use href="#${SEQUENCE_ICONS[seq.templateId] ?? _DEFAULT_SEQUENCE_ICON}"/>
              </svg>
              <span class="sf-sequence-card-label">${_esc(seq.label)}</span>
              <!-- Tagline lives behind the info tap (a plain <span>, not a nested
                   <button>, since it sits inside the card's own <button> — see
                   _exerciseChipsHtml() below) so each card stays compact. -->
              <span class="sf-sequence-card-info" role="button" tabindex="0"
                aria-label="About ${_esc(seq.label)}" data-tip="${_esc(seq.tagline)}">
                <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
              </span>
            </div>
            <span class="sf-sequence-card-scheme">${_esc(seq.scheme)}</span>
            ${this._exerciseChipsHtml(seq.exercises)}
          </button>
        `).join('')}
        <button type="button" class="sf-sequence-card sf-sequence-card--custom${d.sequence?.custom ? ' selected' : ''}" role="option" aria-selected="${!!d.sequence?.custom}" data-build-sequence>
          <span class="sf-sequence-card-label">+ Create Your Own Sequence</span>
          <span class="sf-sequence-card-tagline">Pick your own exercises, in your own order.</span>
        </button>
      </div>
    `;
  }

  // Renders a sequence's exercises as a compact chip row instead of one
  // long "A → B → C → D → E" run-on line — past MAX_PREVIEW_CHIPS, the
  // rest collapse into a single "+N" chip, clickable to reveal the hidden
  // names in a tooltip (ux/info-tooltip.js's delegated [data-tip] handler —
  // see that file's own doc comment; a plain <span>, not a nested <button>,
  // since this already sits inside the sequence card's own <button>, and
  // the card's click handler explicitly skips selecting the sequence when
  // the click landed on this chip — see _bindBodyEvents()). The chips still
  // read left-to-right in the order the exercises are done; a preset with a
  // handful of moves fits without a "+N" chip at all.
  _exerciseChipsHtml(exercises) {
    const MAX_PREVIEW_CHIPS = 3;
    const shown = exercises.slice(0, MAX_PREVIEW_CHIPS);
    const hidden = exercises.slice(MAX_PREVIEW_CHIPS);
    return `
      <div class="sf-sequence-card-chips">
        ${shown.map(e => `<span class="sf-sequence-card-chip">${_esc(e.name)}</span>`).join('')}
        ${hidden.length ? `
          <span class="sf-sequence-card-chip sf-sequence-card-chip--more" role="button" tabindex="0"
            aria-label="${hidden.length} more exercises in this sequence" data-tip="${_esc(hidden.map(e => e.name).join(', '))}">+${hidden.length} more</span>
        ` : ''}
      </div>
    `;
  }

  // ─── Build-your-own sequence sub-step ───────────────────────────────────

  _builderHtml() {
    const d = this._draft;
    return `
      <div class="sf-build">
        <button type="button" class="btn btn-ghost btn-sm sf-build-back" id="ss-build-back">&larr; Back to presets</button>
        <p class="settings-sub">Search or browse exercises, tap to add them in the order you'll do them.</p>
        <input class="input full-width" type="search" placeholder="Search exercises…" id="ss-build-search" value="${_esc(d.buildQuery)}" />
        <div class="sf-build-picks" id="ss-build-picks">${this._buildPicksHtml()}</div>
        <div class="strength-exercise-picker-groups sf-build-results" id="ss-build-results">${this._buildResultsHtml()}</div>
        <button type="button" class="btn btn-glass-cta full-width" id="ss-build-use" ${d.buildPicks.length ? '' : 'disabled'}>
          Use This Sequence${d.buildPicks.length ? ` (${d.buildPicks.length})` : ''}
        </button>
      </div>
    `;
  }

  _buildPicksHtml() {
    const d = this._draft;
    if (!d.buildPicks.length) return `<p class="settings-sub">Nothing added yet — tap exercises below.</p>`;
    return `
      <div class="sf-build-picks-list">
        ${d.buildPicks.map((id, i) => {
          const ex = exerciseById(id);
          if (!ex) return '';
          return `
            <div class="sf-build-pick-row">
              <span class="sf-build-pick-num">${i + 1}</span>
              <span class="sf-build-pick-name">${_esc(ex.name)}</span>
              <div class="sf-build-pick-actions">
                <button type="button" class="btn btn-ghost btn-sm" data-move-up="${id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
                <button type="button" class="btn btn-ghost btn-sm" data-move-down="${id}" ${i === d.buildPicks.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
                <button type="button" class="btn btn-ghost btn-sm" data-remove-pick-id="${id}" aria-label="Remove ${_esc(ex.name)}">
                  <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg>
                </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  /** Same grouped-chip shape as views/strength-session.js's own Browse
   *  picker (_renderPicker()) — search overrides the muscle-group/style
   *  filter, same "broader = more useful once you're looking for
   *  something specific" convention that file already uses. An
   *  already-added exercise gets a checkmark and toggles off on a second
   *  tap instead of ignoring the click. */
  _buildResultsHtml() {
    const d = this._draft;
    const q = d.buildQuery.trim();
    const styleGroup = WORKOUT_STYLES.find(s => s.value === d.style);
    const pool = q ? searchExercises(q) : exercisesForFocus(d.focus).filter(styleGroup?.match ?? (() => true));

    const groups = CATEGORIES
      .map(c => ({ label: c.label, exercises: pool.filter(e => e.category === c.value) }))
      .filter(g => g.exercises.length);

    if (!groups.length) return `<p class="settings-sub">No exercises match "${_esc(q)}".</p>`;

    return groups.map(g => `
      <div class="strength-picker-group">
        <div class="strength-picker-group-label">${_esc(g.label)}</div>
        <div class="strength-picker-chips">
          ${g.exercises.map(ex => `
            <button type="button" class="strength-picker-chip${d.buildPicks.includes(ex.id) ? ' added' : ''}" data-add-exercise-id="${ex.id}">
              ${_esc(ex.name)}${d.buildPicks.includes(ex.id) ? ' ✓' : ''}
            </button>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  /** Narrow update — only the results list, never the search `<input>`
   *  itself — so typing doesn't lose focus/cursor position on every
   *  keystroke. Everything else in this flow re-renders the whole body on
   *  every change (discrete button clicks, nothing to preserve); this is
   *  the one spot that needs the same surgical-update care
   *  views/strength-session.js's own _renderPicker() already takes. */
  _renderBuildResultsOnly() {
    const el = this._root?.querySelector('#ss-build-results');
    if (el) el.innerHTML = this._buildResultsHtml();
  }

  _moveBuildPick(id, delta) {
    const { buildPicks } = this._draft;
    const idx = buildPicks.indexOf(id);
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= buildPicks.length) return;
    [buildPicks[idx], buildPicks[next]] = [buildPicks[next], buildPicks[idx]];
    this._renderBody();
    this._renderFoot();
  }

  // ─── Binding ────────────────────────────────────────────────────────────

  _bindBodyEvents() {
    const $$ = sel => this._root.querySelector(sel);
    const d = this._draft;

    $$('#ss-focus-select')?.addEventListener('change', e => {
      d.focus = e.target.value;
      this._onFocusOrStyleChanged();
      this._renderBody();
      this._renderFoot();
    });

    this._root.querySelectorAll('[data-style]').forEach(btn => {
      btn.addEventListener('click', () => {
        d.style = btn.dataset.style;
        this._onFocusOrStyleChanged();
        this._renderBody();
        this._renderFoot();
      });
    });

    $$('#ss-sequence-trigger')?.addEventListener('click', () => {
      d.sequenceMenuOpen = !d.sequenceMenuOpen;
      this._renderBody();
      this._renderFoot();
    });

    this._root.querySelectorAll('[data-sequence-id]').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-tip]')) return; // "+N more" tooltip chip, not a selection
        const seq = presetSequencesFor(d.focus, d.style).find(s => s.id === card.dataset.sequenceId);
        if (!seq) return;
        d.sequence = seq;
        d.sequenceMenuOpen = false;
        this._reseedNameFromSequence();
        this._renderBody();
        this._renderFoot();
      });
    });

    // "+N more" chip and each card's info icon are <span role="button">,
    // not real <button>s (they already sit inside the sequence card's own
    // <button> — see _exerciseChipsHtml()/_sequencePanelHtml()'s doc
    // comments), so Enter/Space need a manual nudge into a real click for
    // ux/info-tooltip.js's delegated handler (and the guard just above) to
    // see.
    this._root.querySelectorAll('[data-tip][role="button"]').forEach(chip => {
      chip.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        chip.click();
      });
    });

    $$('[data-build-sequence]')?.addEventListener('click', () => {
      d.sequenceMenuOpen = false;
      d.building = true;
      d.buildQuery = '';
      d.buildPicks = [];
      this._renderBody();
      this._renderFoot();
    });

    $$('#ss-build-back')?.addEventListener('click', () => {
      d.building = false;
      this._renderBody();
      this._renderFoot();
    });

    $$('#ss-build-search')?.addEventListener('input', e => {
      d.buildQuery = e.target.value;
      this._renderBuildResultsOnly();
    });

    $$('#ss-build-results')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-add-exercise-id]');
      if (!btn) return;
      const id = btn.dataset.addExerciseId;
      const idx = d.buildPicks.indexOf(id);
      if (idx >= 0) d.buildPicks.splice(idx, 1); else d.buildPicks.push(id);
      this._renderBody();
      this._renderFoot();
    });

    $$('#ss-build-picks')?.addEventListener('click', e => {
      const removeBtn = e.target.closest('[data-remove-pick-id]');
      if (removeBtn) {
        d.buildPicks = d.buildPicks.filter(id => id !== removeBtn.dataset.removePickId);
        this._renderBody();
        this._renderFoot();
        return;
      }
      const upBtn = e.target.closest('[data-move-up]');
      if (upBtn) { this._moveBuildPick(upBtn.dataset.moveUp, -1); return; }
      const downBtn = e.target.closest('[data-move-down]');
      if (downBtn) { this._moveBuildPick(downBtn.dataset.moveDown, 1); return; }
    });

    $$('#ss-build-use')?.addEventListener('click', () => {
      if (!d.buildPicks.length) return;
      d.sequence = buildCustomSequence(d.buildPicks, { focus: d.focus, style: d.style });
      d.building = false;
      this._reseedNameFromSequence();
      this._renderBody();
      this._renderFoot();
    });

    $$('#ss-name')?.addEventListener('input', e => {
      d.name = e.target.value;
      this._renderFoot();
    });

    $$('#ss-connect-hrm')?.addEventListener('click', () => {
      if (this._deviceStatus.hrm !== 'disconnected') return;
      this._onConnectHrm?.();
    });

    $$('#ss-edit-schedule')?.addEventListener('click', () => {
      d.scheduleDraft = { ...this._schedule };
      d.editingSchedule = true;
      this._renderBody();
      this._renderFoot();
    });

    $$('#ss-schedule-back')?.addEventListener('click', () => {
      d.editingSchedule = false;
      d.scheduleDraft = null;
      this._renderBody();
      this._renderFoot();
    });

    this._root.querySelectorAll('[data-schedule-day]').forEach(sel => {
      sel.addEventListener('change', () => {
        d.scheduleDraft[Number(sel.dataset.scheduleDay)] = sel.value || null;
      });
    });

    $$('#ss-schedule-save')?.addEventListener('click', async () => {
      await this._saveSchedule(d.scheduleDraft);
      d.editingSchedule = false;
      d.scheduleDraft = null;
      // Re-apply today's (possibly just-changed) schedule on top of
      // whatever Muscle Group/Style/Sequence was selected before — the
      // point of editing from here is to use the new default right away.
      Object.assign(d, this._scheduleDefaults());
      this._refresh();   // a no-op if the sheet was closed while the schedule saved
    });
  }
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export default StrengthSessionFlow;
