// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * views/strength-session.js
 *
 * Live set-logging panel for a strength or isometric-hold session — the
 * reps/sets/holds counterpart to the cardio live Session panel
 * (index.html's #session-panel, wired up in app.js). Doesn't touch BLE
 * directly and doesn't own a Session: it's handed one that's already
 * running (recording/session.js — the very same class used for rides). A
 * strength session is just a Session with no trainer/power source
 * connected, so normally the only device feeding it is an HR strap via
 * ble/hr-device.js, connected up front from ui/strength-session-flow.js
 * (app.js#startStrengthSession()'s caller) — which means live heart rate
 * arrives through the same onSample plumbing app.js already has for the
 * cardio panel; this view just needs to be told about each sample (see
 * onSample() below). The reading lives in ui/hr-slot.js's slot: a slim glass
 * strip with a miniature chart and the live value while the strap is
 * connected, and — in the same spot, so nothing around it moves — a heart
 * button in its place whenever it isn't. Because that strap is the *only*
 * device a strength session depends on, that button is the rider's one way
 * to get it back mid-workout (see setDeviceStatus() and opts.onConnectHrm
 * below) rather than the readout just going quiet the way it would mid-ride,
 * where the trainer keeps everything else moving regardless.
 *
 * Sets themselves are recorded via recording/set-tracker.js's SetTracker,
 * not by this view directly — this view is presentation + input handling
 * over that tracker, same separation as the cardio panel keeping Session
 * itself free of any DOM concerns.
 *
 * The exercise field is backed by data/exercises.js's catalog (bundled
 * presets plus whatever the rider has authored via ui/exercise-editor.js —
 * see that catalog's own allExercises()) — Browse opens a searchable,
 * category-grouped picker (pre-filtered to the focus picked in
 * ui/strength-session-flow.js, e.g. "Push", "Legs"); picking an entry fills
 * the same free-text field a typed name always has, and shows
 * ui/muscle-diagram.js's front/back diagram for that entry's
 * primaryMuscles. A hand-typed name that happens to match a catalog entry
 * (including via the datalist) shows the diagram too; anything custom/
 * unlisted just logs with no diagram, exactly as this field worked before
 * the catalog existed. A rider-authored entry shows a small "Custom" badge
 * on its chip plus an edit pencil (wired through onEditCustomExercise
 * below); the picker's search box also doubles as the seed for a
 * "+ Create Custom Exercise" row (onAddCustomExercise) when nothing in the
 * catalog fits.
 *
 * A catalog entry with a bodyweightLoadPct (data/exercises.js) fills Weight
 * with a calculated number and grays the field out (see
 * _applyBodyweightLoad()), with a "+" field ahead of it — on its left,
 * where a rider's eye reaches first — for any real extra load: a weighted
 * vest, dip belt, ankle weights. That extra figure is scaled by the same
 * pct together with the rider's own bodyweight (_bodyweightTotalKg()), not
 * added on top 1:1, since a vest on a partial-support move like a push-up
 * is only carried through the arms to the same fraction bodyweight is —
 * an "=" between the two fields marks the read-only one as the result of
 * the editable one, not a second thing to fill in.
 *
 * A catalog entry that's part of a named calisthenics skill line (see
 * data/exercises.js's own doc comment on progressionGroup/level) shows its
 * whole novice→master ladder (progressionChain()) alongside the muscle
 * diagram, with the picked rung highlighted — tapping another rung swaps
 * straight to it, same as picking a fresh chip from Browse.
 *
 * There's no manual Reps/Hold toggle — the catalog entry's own `mode`
 * (data/exercises.js) decides which Log a Set fields show, same match as
 * the diagram above. An unmatched custom name logs as Reps by default.
 *
 * ── Sequence rail ────────────────────────────────────────────────────────
 * When ui/strength-session-flow.js hands over a chosen
 * data/workout-sequences.js Sequence (`opts.sequence`), a horizontally
 * scrolling rail of step chips renders above Log a Set — one per
 * `sequence.exercises` entry, each showing its name and a live "logged /
 * target" count (matched against `tracker.sets` by exercise name, the same
 * string groupByExercise() already groups on). The field is pre-filled
 * with the first step on mount, and tapping any chip re-runs the same
 * _selectExercise() path a Browse pick does — so the rail is a *guide*,
 * not a wizard: Browse stays fully available for swapping a step's
 * exercise or logging something the sequence didn't plan for, sets aren't
 * required to be logged in rail order, and a step's target count is never
 * enforced, same "not enforced" stance data/workout-sequences.js's own
 * doc comment already takes on `targetSets`. No `sequence` (a session
 * started before this existed, or without one for any other reason) just
 * omits the rail — everything below behaves exactly as it did before this
 * existed.
 *
 * Usage:
 *   import { StrengthSessionPanel } from './views/strength-session.js';
 *   import { SetTracker } from './recording/set-tracker.js';
 *
 *   const tracker = new SetTracker();
 *   const panel = new StrengthSessionPanel(document.getElementById('strength-panel'), {
 *     session,                    // a running Session, no trainer connected
 *     tracker,
 *     units: profile.units,       // 'metric' | 'imperial'
 *     recentExercises,            // string[], e.g. from strength-model.js's recentExerciseNames()
 *     focus,                      // SEQUENCE_FOCUS_GROUPS value from the setup flow, e.g. 'push'
 *     sequence,                   // optional data/workout-sequences.js Sequence — see "Sequence rail" above
 *     onSetsChanged: () => session.setMeta({ type: 'strength', sets: tracker.sets }),
 *     onAddCustomExercise:  (prefillName) => Promise<Exercise|null>,      // opens ui/exercise-editor.js
 *     onEditCustomExercise: (exercise) => Promise<{saved}|{deleted}|null>, // ditto, pre-filled
 *   });
 *   panel.render();
 *
 *   // Session's onSample is constructor-only (no public setter), so fold
 *   // panel.onSample() into whatever callback you pass when the strength
 *   // Session is created:
 *   const session = new Session({
 *     onSample: sample => { ...; panel.onSample(sample); },
 *     meta: { type: 'strength' },
 *   });
 *
 *   // On tab-away / session end:
 *   panel.destroy();
 */

import { SET_MODES, groupByExercise, totalVolume, totalHoldTime } from '../core/strength-model.js';
import { kgToLb, lbToKg, weightUnitLabel, UNITS } from '../metrics/units.js';
import { audioCues } from '../ux/audio-cues.js';
import { HrSlot, hrSlotHtml } from '../ui/hr-slot.js';
import { CATEGORIES, PROGRESSION_GROUPS, LEVELS, exercisesForFocus, searchExercises,
         exerciseByName, exerciseById, progressionChain, allExercises,
         estimateBodyweightLoadKg } from '../data/exercises.js';
import { renderMuscleDiagram, MUSCLE_LABELS } from '../ui/muscle-diagram.js';
import {
  REPS_STEP, HOLD_STEP_SEC, weightStep, stepValue, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS,
  nextSetNumber, ladderWindow, ladderTip, railScrollTarget,
} from '../ui/strength-live-logic.js';

const LEVEL_LABELS = Object.fromEntries(LEVELS.map(l => [l.value, l.label]));

const TICK_MS = 250;

export class StrengthSessionPanel {
  /**
   * @param {HTMLElement} container
   * @param {Object}   opts
   * @param {Object}   opts.session          A running recording/session.js Session.
   * @param {Object}   opts.tracker          A recording/set-tracker.js SetTracker.
   * @param {string}   [opts.units]          'metric' | 'imperial'. Defaults to metric.
   * @param {number}   [opts.riderWeightKg]  Rider's body weight in kilograms (profile.riderWeight
   *                                          in app.js) — feeds _applyBodyweightLoad()'s calculated,
   *                                          read-only Weight display for calisthenics moves (plus
   *                                          its own "+" field for any real extra load). Omit (or
   *                                          0/null) to fall back to a plain manual Weight field for
   *                                          everything, same as before that existed.
   * @param {string[]} [opts.recentExercises] Names for the exercise datalist.
   * @param {string}   [opts.focus]          SEQUENCE_FOCUS_GROUPS value from the setup
   *                                          flow — pre-filters the Browse picker's
   *                                          default list.
   * @param {Object}   [opts.sequence]       A data/workout-sequences.js Sequence from
   *                                          the setup flow — drives the sequence rail.
   *                                          See this file's own doc comment. Omit for
   *                                          the plain Browse-only flow.
   * @param {Function} [opts.onSetsChanged]  Called after every logged set — the
   *                                          hook point for persisting tracker.sets
   *                                          into session.setMeta() so an
   *                                          unexpected disconnect still
   *                                          auto-saves the sets logged so far,
   *                                          same guarantee the cardio panel gets
   *                                          from Session's own auto-save path.
   * @param {Function} [opts.onAddCustomExercise]  (prefillName) => Promise<Exercise|null> —
   *   opens ui/exercise-editor.js pre-filled with the picker's search text. Omit to hide
   *   the picker's "+ Create Custom Exercise" row entirely.
   * @param {Function} [opts.onEditCustomExercise] (exercise) => Promise<{saved}|{deleted}|null> —
   *   opens ui/exercise-editor.js pre-filled with an existing custom entry. Omit to hide
   *   the edit pencil on custom chips.
   * @param {Function} [opts.onConnectHrm]   () => void — tapped the heart button the slot shows
   *                                          while no strap is connected, i.e. app.js's
   *                                          same connectHrMonitor() the setup flow's own
   *                                          Connect button uses. Omit to leave the button
   *                                          shown but inert.
   * @param {string}   [opts.hrmStatus]      'connected' | 'connecting' | 'reconnecting' |
   *                                          'disconnected' — the HR strap's status as of
   *                                          mount, so the slot renders correctly from the
   *                                          first frame instead of waiting for a
   *                                          setDeviceStatus() call after render().
   *                                          Defaults to 'disconnected'.
   */
  constructor(container, { session, tracker, units = UNITS.METRIC, riderWeightKg = null, recentExercises = [], focus = 'fullBody',
                            sequence = null, onSetsChanged, onAddCustomExercise, onEditCustomExercise,
                            onConnectHrm, hrmStatus = 'disconnected' } = {}) {
    this._container = container;
    this._session = session;
    this._tracker = tracker;
    this._units = units;
    this._riderWeightKg = riderWeightKg;
    this._recentExercises = recentExercises;
    this._focus = focus;
    // A custom sequence with no exercises (buildCustomSequence([])) is
    // treated the same as no sequence at all — nothing for the rail to
    // show, so it shouldn't render an empty one.
    this._sequence = sequence?.exercises?.length ? sequence : null;
    this._onSetsChanged = onSetsChanged ?? (() => {});
    this._onAddCustomExercise = onAddCustomExercise ?? null;
    this._onEditCustomExercise = onEditCustomExercise ?? null;
    this._onConnectHrm = onConnectHrm ?? null;
    this._hrmStatus = hrmStatus;

    this._mode = SET_MODES.REPS;
    this._holdCueFired = false;
    this._timer = null;
    this._pickerQuery = '';
    this._hrSlot = null;

    // Bodyweight-load state (see _applyBodyweightLoad()).
    // _bodyweightLoadPct is the current matched exercise's
    // bodyweightLoadPct fraction (null when the selected exercise isn't a
    // bodyweight/reps move, or there's no rider weight on file) —
    // _bodyweightTotalKg() scales (riderWeightKg + Added-weight) by this
    // fraction together, rather than adding a raw extra load on top of a
    // separately-computed bodyweight-only figure.
    // _lastLoadEstimateExerciseId tracks the matched exercise so the
    // Added-weight field resets to empty only when the rider actually
    // picks/types a *different* exercise, not on every keystroke.
    this._bodyweightLoadPct = null;
    this._lastLoadEstimateExerciseId = null;
    // Which sequence step the strip was last centred on, so a re-render (every set, every
    // exercise change) only scrolls it when the current step has actually moved.
    this._lastRailIndex = -2;
    // The steppers' press-and-hold auto-repeat timers — see _bindSteppers().
    this._repeatDelay = null;
    this._repeatTimer = null;
    // When Space last activated a hero button by hand, and when a pointer last pressed or released
    // one — see _bindSteppers(), which uses both to tell a click that already stepped from a new one.
    this._spaceAt = 0;
    this._pointerAt = 0;
    // What the muscle diagram last drew, so typing a custom name does not redraw it per keystroke.
    this._diagramKey = null;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  render() {
    this._container.innerHTML = this._template();
    this._els = {
      restTimer:   this._container.querySelector('[data-rest-timer]'),
      sequenceRail:this._container.querySelector('[data-sequence-rail]'),
      exercise:    this._container.querySelector('[data-exercise-input]'),
      browseBtn:   this._container.querySelector('[data-browse-btn]'),
      picker:      this._container.querySelector('[data-exercise-picker]'),
      pickerSearch:this._container.querySelector('[data-picker-search]'),
      pickerGroups:this._container.querySelector('[data-picker-groups]'),
      addCustomRow:this._container.querySelector('[data-add-custom-row]'),
      muscleRow:   this._container.querySelector('[data-muscle-row]'),
      muscleSlot:  this._container.querySelector('[data-muscle-slot]'),
      setNumber:   this._container.querySelector('[data-set-number]'),
      muscleList:  this._container.querySelector('[data-muscle-list]'),
      progressionRow:    this._container.querySelector('[data-progression-row]'),
      progressionLabel:  this._container.querySelector('[data-progression-label]'),
      progressionRungs:  this._container.querySelector('[data-progression-rungs]'),
      weight:      this._container.querySelector('[data-weight-input]'),
      weightUnit:  this._container.querySelector('[data-weight-unit]'),
      weightInfoBtn:   this._container.querySelector('[data-weight-info-btn]'),
      bodyweightBox:   this._container.querySelector('[data-bodyweight-box]'),
      bodyweightPct:   this._container.querySelector('[data-bodyweight-pct]'),
      addedWeightPlus: this._container.querySelector('[data-added-weight-plus]'),
      addedWeight:     this._container.querySelector('[data-added-weight-input]'),
      bwCalc:          this._container.querySelector('[data-bw-calc]'),
      reps:        this._container.querySelector('[data-reps-input]'),
      rpe:         this._container.querySelector('[data-rpe-input]'),
      repsFields:  this._container.querySelector('[data-reps-fields]'),
      holdFields:  this._container.querySelector('[data-hold-fields]'),
      targetHold:  this._container.querySelector('[data-target-hold-input]'),
      holdTimer:   this._container.querySelector('[data-hold-timer]'),
      holdBtn:     this._container.querySelector('[data-hold-btn]'),
      logRepsBtn:  this._container.querySelector('[data-log-reps-btn]'),
      setsList:    this._container.querySelector('[data-sets-list]'),
      setsSummary: this._container.querySelector('[data-sets-summary]'),
    };

    // The slot builds itself from the markup _template() put in the DOM, and opens on the face
    // for opts.hrmStatus so the first frame is already right.
    this._hrSlot = new HrSlot(this._container, {
      onConnect: this._onConnectHrm,
      status: this._hrmStatus,
    });

    this._bind();
    // Opens the session already on step one instead of a blank field — the
    // whole point of picking a sequence up front (see this file's own doc
    // comment) is that the rider doesn't have to go find their first
    // exercise before they can log anything. `focus: false` since this
    // runs on mount — popping the keyboard/number-pad before the rider's
    // even looked at the screen would be surprising, unlike a deliberate
    // tap on a picker chip or rail step, which still steals focus.
    if (this._sequence) this._selectSequenceStep(this._sequence.exercises[0], { focus: false });
    this._renderSetsList();
    this._renderPicker();
    this._renderSequenceRail();
    this._updateMuscleDiagram();
    this._tick();
    this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  /** Call on every new session sample (same one Session's onSample already
   *  receives) to keep the live HR readout — and its miniature chart — current. */
  onSample(sample) {
    if (!this._els) return;
    this._hrSlot?.push(sample?.heartRate);
  }

  /** @param {'hrm'} kind  @param {'disconnected'|'connecting'|'reconnecting'|'connected'} status
   *  Mirrors ui/strength-session-flow.js's own setDeviceStatus() — app.js's
   *  _setDeviceStatus() fans every HR status change out to whichever of
   *  the two happens to be mounted, so a strap that drops mid-session
   *  (connectHrMonitor()'s 'disconnected' listener in app.js) swaps the
   *  slot's strip for the heart button the same way it'd flip the setup
   *  flow's own Connect row, and a tap on that button runs through that
   *  exact same connectHrMonitor() via onConnectHrm. */
  setDeviceStatus(kind, status) {
    if (kind !== 'hrm' || !this._els) return;
    this._hrmStatus = status;
    this._hrSlot?.setStatus(status);
  }

  destroy() {
    this._stopRepeat();
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._hrSlot?.destroy();
    this._hrSlot = null;
  }

  // ─── Template ───────────────────────────────────────────────────────────

  _template() {
    const unitLabel = weightUnitLabel(this._units);
    // Union of recent-history names and the full catalog, so the native
    // datalist autocompletes against both without needing Browse opened —
    // Browse (and its category grouping / muscle diagram) is there for
    // discovery, the datalist is there for "I know the name, just let me
    // type it" same as before this catalog existed.
    const datalistOptions = this._datalistOptions();

    return `
      <div class="strength-panel">
        <!-- The live row: heart rate on the left (ui/hr-slot.js — strip when a strap is
             connected, heart button in the same spot when not), Rest on the right. Rest
             stays visible with or without a strap, so it lives beside the slot rather
             than inside it. -->
        <div class="strength-live-row">
          ${hrSlotHtml()}
          <div class="chart-badge-item strength-rest-badge" data-badge="rest">
            <span class="chart-badge-value" data-rest-timer>0:00</span>
            <span class="chart-badge-label">Rest</span>
          </div>
        </div>

        ${this._sequence ? `
          <section class="settings-card">
            <div class="settings-title-line">
              <h2 class="settings-title">${_esc(this._sequence.label)}</h2>
              <button type="button" class="info-btn" aria-label="About ${_esc(this._sequence.label)}" data-tip="${_esc(this._sequence.tagline)} \u00b7 ${_esc(this._sequence.scheme)}">
                <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
              </button>
            </div>
            <div class="strength-sequence-rail" data-sequence-rail></div>
          </section>
        ` : ''}

        <!-- The hero: the set being logged right now. The exercise name is the
             title, big reps/weight steppers are the controls, and the check is pinned to the bottom
             of the screen while the card is on it (.strength-dock). -->
        <section class="settings-card strength-hero">
          <div class="strength-hero-head">
            <span class="strength-set-label">Set <span class="strength-hero-set-num" data-set-number>1</span></span>
            <button type="button" class="btn btn-ghost btn-sm strength-browse-btn" data-browse-btn title="Browse exercises" aria-label="Browse exercises">
              <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-grid"/></svg>
              Browse
            </button>
          </div>
          <input class="strength-hero-name" list="strength-exercise-list" data-exercise-input placeholder="Exercise name" aria-label="Exercise" autocomplete="off" />
          <datalist id="strength-exercise-list">${datalistOptions}</datalist>

          <div class="strength-exercise-picker hidden" data-exercise-picker>
            <input class="input full-width" type="search" placeholder="Search exercises…" data-picker-search />
            <div class="strength-exercise-picker-groups" data-picker-groups></div>
            <div data-add-custom-row></div>
          </div>

          <!-- Always visible: a slim front/back diagram, and — for a skill line — the ladder's current
               rung with its neighbours. Tapping the current rung lists every rung; tapping a
               neighbour steps to it. -->
          <div class="strength-muscle-row" data-muscle-row>
            <div class="strength-muscle-diagram-slot" data-muscle-slot role="img" aria-label="Target muscles"></div>
            <div class="strength-muscle-info">
              <span class="strength-muscle-list" data-muscle-list></span>
              <div class="strength-progression-row hidden" data-progression-row>
                <div class="strength-progression-label" data-progression-label></div>
                <div class="strength-progression-rungs" data-progression-rungs></div>
              </div>
            </div>
          </div>

          <div class="strength-fields" data-reps-fields>
            <div class="strength-steppers">
              <div class="strength-stepper" data-stepper-box="weight">
                <div class="strength-stepper-label">
                  <span>Weight</span>
                  <span class="strength-stepper-unit" data-weight-unit>${unitLabel}</span>
                  <button type="button" class="info-btn hidden" data-weight-info-btn aria-label="About this weight" data-tip="Calculated from your bodyweight — not editable directly. Use the highlighted extra-weight field to add a vest, belt, or plates.">
                    <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
                  </button>
                </div>
                <div class="strength-stepper-row">
                  <button type="button" class="strength-step-btn" data-step="weight" data-dir="-1" aria-label="Less weight"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-minus"/></svg></button>
                  <input class="strength-stepper-input" type="number" inputmode="decimal" data-weight-input min="0" step="0.5" placeholder="0" aria-label="Weight" />
                  <button type="button" class="strength-step-btn" data-step="weight" data-dir="1" aria-label="More weight"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-plus"/></svg></button>
                </div>
              </div>
              <div class="strength-stepper" data-stepper-box="reps">
                <div class="strength-stepper-label"><span>Reps</span></div>
                <div class="strength-stepper-row">
                  <button type="button" class="strength-step-btn" data-step="reps" data-dir="-1" aria-label="Fewer reps"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-minus"/></svg></button>
                  <input class="strength-stepper-input" type="number" inputmode="numeric" data-reps-input min="0" step="1" placeholder="0" aria-label="Reps" />
                  <button type="button" class="strength-step-btn" data-step="reps" data-dir="1" aria-label="More reps"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-plus"/></svg></button>
                </div>
              </div>
            </div>

            <!-- Only for a calisthenics move with a bodyweight estimate: what the (read-only) weight is
                 made of — bodyweight x percent, plus an optional vest/belt. -->
            <div class="strength-bw-calc hidden" data-bw-calc>
              <input class="input input-num" type="number" data-bodyweight-box disabled aria-label="Your bodyweight, not editable here" />
              <span class="strength-weight-plus" data-bodyweight-pct></span>
              <span class="strength-weight-plus" data-added-weight-plus aria-hidden="true">+</span>
              <input class="input input-num input-num-added" type="number" inputmode="decimal" data-added-weight-input min="0" step="0.5" placeholder="0" aria-label="Extra wearable weight — vest, belt, or plates" />
              <span class="strength-bw-calc-hint">added</span>
            </div>

            <div class="strength-rpe-row">
              <span class="settings-row-label-line">
                <span class="settings-row-label">RPE</span>
                <button type="button" class="info-btn" aria-label="About RPE" data-tip="Rate of Perceived Exertion — how hard that set felt, on a scale of 1 to 10. 10 is an all-out max effort with nothing left; 7\u20138 is a hard set with a couple reps still in the tank; 5 or below is light-to-moderate effort. Optional — leave it blank if you're not tracking it.">
                  <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
                </button>
              </span>
              <input class="input input-num" type="number" inputmode="numeric" data-rpe-input min="1" max="10" step="1" placeholder="—" aria-label="RPE" />
            </div>
            <!-- Checkmark alone, no label — the name lives in aria-label/title. -->
            <div class="strength-dock">
              <button type="button" class="strength-log-btn strength-check-btn" data-log-reps-btn aria-label="Log set" title="Log set">
                <svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-check"/></svg>
              </button>
            </div>
          </div>

          <div class="strength-fields hidden" data-hold-fields>
            <div class="strength-steppers strength-steppers-single">
              <div class="strength-stepper" data-stepper-box="hold">
                <div class="strength-stepper-label"><span>Target hold</span><span class="strength-stepper-unit">sec</span></div>
                <div class="strength-stepper-row">
                  <button type="button" class="strength-step-btn" data-step="hold" data-dir="-1" aria-label="Shorter hold"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-minus"/></svg></button>
                  <input class="strength-stepper-input" type="number" inputmode="numeric" data-target-hold-input min="0" step="5" placeholder="60" aria-label="Target hold, seconds" />
                  <button type="button" class="strength-step-btn" data-step="hold" data-dir="1" aria-label="Longer hold"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-plus"/></svg></button>
                </div>
              </div>
            </div>
            <div class="strength-hold-timer" data-hold-timer>0:00</div>
            <!-- Idle: a clock face with a play triangle in it. Running: the same green check as the
                 reps button, because tapping it now stops the hold and logs it. -->
            <div class="strength-dock">
              <button type="button" class="strength-log-btn strength-check-btn" data-hold-btn data-hold-state="idle" aria-label="Start hold" title="Start hold">
                <svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-hold-play" data-hold-icon/></svg>
              </button>
            </div>
          </div>
        </section>

        <section class="settings-card">
          <h2 class="settings-title">This Session</h2>
          <div class="strength-sets-summary" data-sets-summary></div>
          <div class="strength-sets-list" data-sets-list></div>
        </section>
      </div>
    `;
  }

  // ─── Binding ────────────────────────────────────────────────────────────

  _bind() {
    this._els.logRepsBtn.addEventListener('click', () => this._logRepsSet());
    this._els.holdBtn.addEventListener('click', () => this._toggleHold());
    // Keeps the (read-only) Weight field's displayed total in sync as the
    // rider types into Added-weight — see _refreshBodyweightTotal()'s doc
    // comment for why this re-derives the whole total rather than just
    // tacking the typed number on.
    this._els.addedWeight?.addEventListener('input', () => this._refreshBodyweightTotal());

    this._els.exercise.addEventListener('input', () => {
      this._updateMuscleDiagram();
      this._renderSequenceRail();
    });
    this._bindSteppers();
    this._els.browseBtn.addEventListener('click', () => this._togglePicker());
    this._els.pickerSearch.addEventListener('input', e => {
      this._pickerQuery = e.target.value;
      this._renderPicker();
    });
    // Delegated once against the container, not the (re-rendered-per-search)
    // innerHTML inside it — a custom chip's edit pencil is checked first
    // since it's a sibling of the chip button, never nested inside it (two
    // buttons can't nest), so the two checks are mutually exclusive.
    this._els.pickerGroups.addEventListener('click', e => {
      const editBtn = e.target.closest('[data-edit-exercise-id]');
      if (editBtn) { this._editCustomExercise(editBtn.dataset.editExerciseId); return; }

      const btn = e.target.closest('[data-exercise-id]');
      if (!btn) return;
      const ex = exerciseById(btn.dataset.exerciseId);
      if (!ex) return;
      this._selectExercise(ex);
    });
    // Same delegation approach for the picker's "+ Create Custom Exercise"
    // row, whose innerHTML is rebuilt (to keep its label in sync with the
    // search box) on every _renderPicker() call.
    this._els.addCustomRow?.addEventListener('click', e => {
      if (e.target.closest('[data-add-custom-btn]')) this._addCustomExercise();
    });
    // The progression ladder's rungs are just alternate exercises — jumping
    // to one selects it exactly like a fresh picker chip would.
    this._els.progressionRungs?.addEventListener('click', e => {
      const btn = e.target.closest('[data-exercise-id]');
      if (!btn) return;
      const ex = exerciseById(btn.dataset.exerciseId);
      if (ex) this._selectExercise(ex);
    });
    // The sequence rail's step chips — see _renderSequenceRail()/
    // _selectSequenceStep(). Delegated against the rail container since
    // its innerHTML is rebuilt on every set logged (to refresh the
    // logged/target badges).
    this._els.sequenceRail?.addEventListener('click', e => {
      const btn = e.target.closest('[data-step-index]');
      if (!btn || !this._sequence) return;
      const step = this._sequence.exercises[Number(btn.dataset.stepIndex)];
      if (step) this._selectSequenceStep(step);
    });
  }

  // ─── Steppers ───────────────────────────────────────────────────────────

  /** Wires the − / + buttons beside Weight, Reps and Target hold. One tap is one step
   *  (ui/strength-live-logic.js's stepValue()); holding a button repeats after a short wait.
   *  Pointer events do the stepping so a held press can repeat; the `click` that follows a press
   *  is ignored, so keyboard activation (Enter) still steps once and a tap steps once. Not told
   *  apart by `click.detail`: a touch tap's click has detail 0, exactly like a keyboard click
   *  (seen in Chromium), so it is a short window after the last pointer event instead.
   *  Delegated from the hero card, which is never rebuilt. */
  _bindSteppers() {
    const hero = this._container.querySelector('.strength-hero');
    if (!hero) return;
    hero.addEventListener('pointerdown', e => {
      const btn = e.target.closest('[data-step]');
      if (!btn || btn.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();               // no text selection / focus-steal while holding
      this._pointerAt = Date.now();
      this._stopRepeat();
      this._stepField(btn.dataset.step, Number(btn.dataset.dir));
      this._repeatDelay = setTimeout(() => {
        this._repeatTimer = setInterval(() => this._stepField(btn.dataset.step, Number(btn.dataset.dir)), REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) {
      hero.addEventListener(type, () => { this._pointerAt = Date.now(); this._stopRepeat(); });
    }
    hero.addEventListener('click', e => {
      const btn = e.target.closest('[data-step]');
      if (!btn || btn.disabled) return;
      if (Date.now() - this._pointerAt < 500) return;   // the click that follows a press: already stepped
      this._stepField(btn.dataset.step, Number(btn.dataset.dir));
    });
    hero.addEventListener('contextmenu', e => { if (e.target.closest('[data-step]')) e.preventDefault(); });

    // Space on a focused hero button. ux/keyboard.js treats Space as Start/Stop and only leaves a key
    // alone when a widget has called preventDefault() on it — it checks for text fields, not buttons —
    // so without this, Space on the check (or a stepper) fired the shortcut instead of the button and
    // the whole panel went away. The widget does the activating itself, as that handler's own comment
    // asks. A held Space repeats a stepper, like a held press; it must not repeat anything else (a
    // held Space on the check would log a pile of sets).
    hero.addEventListener('keydown', e => {
      if (e.key !== ' ') return;
      const btn = e.target.closest?.('button');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      this._spaceAt = Date.now();
      if (btn.dataset.step) this._stepField(btn.dataset.step, Number(btn.dataset.dir));
      else if (!e.repeat) btn.click();
    });
    // Some engines still send a click when the key comes back up; that one has already been handled.
    // (btn.click() above is untrusted, so it is not caught here.)
    hero.addEventListener('click', e => {
      if (e.isTrusted && e.detail === 0 && Date.now() - this._spaceAt < 700 && e.target.closest('button')) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
  }

  _stopRepeat() {
    clearTimeout(this._repeatDelay);
    clearInterval(this._repeatTimer);
    this._repeatDelay = this._repeatTimer = null;
  }

  /** Applies one stepper tap to the field `which` ('weight' | 'reps' | 'hold'), then fires the
   *  field's own `input` event so anything listening to it (the bodyweight total, say) sees the
   *  change exactly as if it had been typed. */
  _stepField(which, direction) {
    const field = which === 'weight' ? this._els.weight : which === 'reps' ? this._els.reps : this._els.targetHold;
    if (!field || field.disabled) { this._stopRepeat(); return; }
    const step = which === 'weight' ? weightStep(this._units === UNITS.IMPERIAL) : which === 'reps' ? REPS_STEP : HOLD_STEP_SEC;
    field.value = stepValue(_parseNum(field.value), direction, { step, min: 0 });
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Fills the exercise field with `ex`, refreshes the muscle diagram +
   *  progression ladder + sequence rail highlight, and closes Browse — the
   *  one path every "I picked an exercise" source (a picker chip, a
   *  progression rung, a sequence rail step, or a freshly-saved custom
   *  exercise) funnels through.
   *  @param {Object}  [opts]
   *  @param {boolean} [opts.focus=true] Steals focus into Weight/Reps (or
   *    the hold target, in Hold mode) — skipped for the initial sequence
   *    pre-fill on mount (see render()), which shouldn't pop the keyboard
   *    before the rider's looked at the screen. */
  _selectExercise(ex, { focus = true } = {}) {
    this._els.exercise.value = ex.name;
    this._updateMuscleDiagram();
    this._closePicker();
    this._renderSequenceRail();
    // A phone has steppers now, and focusing a number field there pops the keyboard over the check
    // button on every pick (and on every auto-advance after a logged set). Only a fine pointer (a
    // desktop, a tablet with a keyboard) still gets the focus jump.
    const finePointer = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true;
    if (focus && finePointer) {
      // Straight into Weight/Reps (or the hold target, in Hold mode) — the
      // whole point of picking from the catalog is to get to logging
      // faster than typing the name out by hand. _updateMuscleDiagram()
      // above already ran _applyBodyweightLoad() for this pick, so a
      // calisthenics move with an estimate (Weight now read-only) sends
      // focus to Reps instead of a field that can't accept it.
      const nextField = this._mode === SET_MODES.HOLD
        ? this._els.targetHold
        : (this._bodyweightLoadPct != null ? this._els.reps : this._els.weight);
      nextField?.focus();
    }
  }

  /** A sequence rail step tapped (or the initial pre-fill on mount — see
   *  render()). Looks the step's exerciseId back up in the live catalog
   *  rather than trusting the sequence's own denormalized name/mode
   *  (data/workout-sequences.js's own doc comment explains why a Sequence
   *  carries both) — a rename since the sequence was built should still
   *  show the current muscle diagram/progression ladder. Falls back to the
   *  denormalized name alone if the entry's gone missing entirely (a
   *  deleted custom exercise), same as any unmatched free-typed name. */
  _selectSequenceStep(step, opts) {
    const ex = exerciseById(step.exerciseId);
    if (ex) { this._selectExercise(ex, opts); return; }
    this._els.exercise.value = step.name;
    this._updateMuscleDiagram();
    this._closePicker();
    this._renderSequenceRail();
  }

  /** Switches the Log a Set fields between Reps and Hold. No manual toggle
   *  drives this anymore — see _updateMuscleDiagram() below, which is the
   *  only caller, keyed off the selected exercise's catalog `mode`. */
  _setMode(mode) {
    this._mode = mode;
    this._els.repsFields.classList.toggle('hidden', mode !== SET_MODES.REPS);
    this._els.holdFields.classList.toggle('hidden', mode !== SET_MODES.HOLD);
  }

  // ─── Exercise picker ────────────────────────────────────────────────────

  _togglePicker() {
    const opening = this._els.picker.classList.contains('hidden');
    this._els.picker.classList.toggle('hidden', !opening);
    if (opening) {
      this._pickerQuery = '';
      this._els.pickerSearch.value = '';
      this._renderPicker();
      this._els.pickerSearch.focus();
    }
  }

  _closePicker() {
    this._els.picker.classList.add('hidden');
  }

  /** Search overrides the focus filter (broader = more useful once someone's
   *  actually looking for something specific); an empty search falls back
   *  to the focus this session was set up with. Either way, grouped by
   *  category in the catalog's own display order (data/exercises.js's
   *  CATEGORIES) so the list reads the same as the picker in
   *  ui/strength-session-flow.js's chip grid. */
  _renderPicker() {
    const q = this._pickerQuery.trim();
    const list = q ? searchExercises(q) : exercisesForFocus(this._focus);
    const byId = new Set(list.map(e => e.id));

    const groups = CATEGORIES
      .map(c => ({ label: c.label, exercises: list.filter(e => e.category === c.value) }))
      .filter(g => g.exercises.length);

    this._els.pickerGroups.innerHTML = groups.length ? groups.map(g => `
      <div class="strength-picker-group">
        <div class="strength-picker-group-label">${_esc(g.label)}</div>
        <div class="strength-picker-chips">
          ${g.exercises.map(ex => this._pickerChip(ex)).join('')}
        </div>
      </div>
    `).join('') : `<p class="settings-sub">No exercises match "${_esc(q)}".</p>`;

    // Always present (when the caller wired it up) rather than only on an
    // empty search — a rider might not bother searching before deciding
    // the catalog just doesn't have their move.
    if (this._els.addCustomRow) {
      this._els.addCustomRow.innerHTML = this._onAddCustomExercise ? `
        <button type="button" class="btn btn-ghost full-width strength-picker-add-custom" data-add-custom-btn>
          + Create Custom Exercise${q ? ` "${_esc(q)}"` : ''}
        </button>
      ` : '';
    }

    void byId; // (kept for a future "highlight already-logged" pass — not needed yet)
  }

  /** One chip's markup — a rider-authored entry gets a small "Custom" badge
   *  baked into the chip button plus a sibling edit-pencil button (two
   *  buttons can't nest, so the pencil sits next to the chip rather than
   *  inside it — see _bind()'s delegated click handler for how the two
   *  are told apart). The pencil only renders when onEditCustomExercise
   *  was actually wired up. */
  _pickerChip(ex) {
    const chip = `
      <button type="button" class="strength-picker-chip" data-exercise-id="${ex.id}">
        ${_esc(ex.name)}${ex.custom ? '<span class="strength-picker-custom-badge">Custom</span>' : ''}
      </button>
    `;
    if (!ex.custom || !this._onEditCustomExercise) return `<div class="strength-picker-chip-group">${chip}</div>`;
    return `
      <div class="strength-picker-chip-group">
        ${chip}
        <button type="button" class="strength-picker-chip-edit" data-edit-exercise-id="${ex.id}"
                title="Edit ${_esc(ex.name)}" aria-label="Edit ${_esc(ex.name)}">
          <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-pencil"/></svg>
        </button>
      </div>
    `;
  }

  /** Union of recent-history names and the full merged catalog (bundled +
   *  custom — see data/exercises.js's allExercises()), for the native
   *  datalist's free-typing autocomplete. Rebuilt (not just computed once
   *  at render()) so a custom exercise saved mid-session shows up in the
   *  datalist immediately — see _refreshDatalist(). */
  _datalistOptions() {
    const names = [...new Set([...this._recentExercises, ...allExercises().map(e => e.name)])];
    return names.map(name => `<option value="${_esc(name)}">`).join('');
  }

  _refreshDatalist() {
    const datalist = this._container.querySelector('#strength-exercise-list');
    if (datalist) datalist.innerHTML = this._datalistOptions();
  }

  /** "+ Create Custom Exercise" — opens ui/exercise-editor.js (via app.js's
   *  onAddCustomExercise bridge) pre-filled with whatever's currently typed
   *  into the picker's search box, same "seed the editor with the search
   *  that came up empty" idea as views/diet.js's own custom-ingredient
   *  fallback. A saved exercise is selected immediately — that's the whole
   *  point of reaching for "create custom" from inside the picker instead
   *  of some separate settings screen. */
  async _addCustomExercise() {
    if (!this._onAddCustomExercise) return;
    const ex = await this._onAddCustomExercise(this._pickerQuery.trim());
    if (!ex) return; // cancelled
    this._refreshDatalist();
    this._selectExercise(ex);
  }

  /** A custom chip's edit pencil — opens ui/exercise-editor.js (via app.js's
   *  onEditCustomExercise bridge) pre-filled with the existing entry. If
   *  the exercise being edited is the one currently sitting in the field
   *  (matched by name, same case-insensitive match _updateMuscleDiagram()
   *  uses elsewhere), a rename is reflected there and a delete clears the
   *  field — either way the picker re-renders so the chip itself catches up. */
  async _editCustomExercise(id) {
    if (!this._onEditCustomExercise) return;
    const ex = exerciseById(id);
    if (!ex) return;

    const result = await this._onEditCustomExercise(ex);
    if (!result) return; // cancelled

    this._refreshDatalist();
    const wasSelected = this._els.exercise.value.trim().toLowerCase() === ex.name.toLowerCase();
    if (wasSelected) {
      this._els.exercise.value = result.saved ? result.saved.name : '';
      this._updateMuscleDiagram();
    }
    this._renderPicker();
  }

  /** Shows/hides the muscle diagram based on whatever's currently in the
   *  exercise field — matched by exact (case-insensitive) name against the
   *  catalog, whether that got there by typing, the datalist, or Browse.
   *  Also the sole place that drives _setMode(): a catalog match's `mode`
   *  (data/exercises.js) is authoritative, switching the Log a Set fields
   *  between Reps and Hold with no manual toggle in the way; an unmatched
   *  custom name falls back to Reps, same default createStrengthSet()
   *  (core/strength-model.js) already used. */
  _updateMuscleDiagram() {
    const ex = exerciseByName(this._els.exercise.value);
    this._setMode(ex ? ex.mode : SET_MODES.REPS);
    this._applyBodyweightLoad(ex);

    // Always visible: a custom or half-typed name just gets the silhouette
    // with nothing lit, so the row never disappears while the rider types (only the ladder, which
    // needs a catalog entry, comes and goes).
    const muscles = ex?.primaryMuscles ?? [];
    const key = muscles.join(',');
    if (key !== this._diagramKey || !this._els.muscleSlot.firstElementChild) {
      this._diagramKey = key;
      this._els.muscleSlot.innerHTML = renderMuscleDiagram(muscles, { compact: true });
      this._els.muscleSlot.setAttribute('aria-label',
        muscles.length ? `Target muscles: ${muscles.map(_muscleLabel).join(', ')}` : 'Target muscles');
    }
    this._els.muscleList.textContent = ex
      ? muscles.map(_muscleLabel).join(' \u00b7 ')
      : 'Pick an exercise to see the muscles it works';
    this._updateProgressionLadder(ex);
    this._syncSetNumber();
  }

  /** The hero's "Set N": the set the rider is about to log for the exercise in the name field. */
  _syncSetNumber() {
    const name = this._els.exercise.value.trim();
    this._els.setNumber.textContent = name ? String(nextSetNumber(this._tracker.sets, name)) : '\u2014';
  }

  /** Fills the Weight field for a calisthenics move with a calculated
   *  load, and keeps it live-updated as the rider types into the "+"
   *  Added-weight field next to it — so a bodyweight exercise is never
   *  something the rider has to weigh and type in themselves, same
   *  "don't type what can be computed" spirit as the muscle diagram and
   *  progression ladder above. Its info-btn spells out the calculation
   *  as a tooltip (see ux/info-tooltip.js).
   *
   *  The total isn't just the bodyweight estimate plus a raw extra
   *  load — added weight is scaled by the same bodyweightLoadPct
   *  (data/exercises.js) the rider's own mass is: a vest strapped to the
   *  torso during a partial-support move like a push-up is only carried
   *  through the arms to the same fraction the rider's bodyweight is,
   *  not 1:1. So the actual formula is
   *  (riderWeightKg + addedWeightKg) × bodyweightLoadPct, computed by
   *  _bodyweightTotalKg() and shown live in the (now read-only) Weight
   *  field by _refreshBodyweightTotal() every time Added-weight changes
   *  (see its 'input' listener in _bind()) — what's logged always
   *  matches what's on screen. A read-only bodyweight box and a "× N%"
   *  annotation sit ahead of the "+" field so it's visible at a glance
   *  what the percentage is being taken of, rather than leaving the
   *  rider to infer it purely from the tooltip; both are filled in here
   *  since — unlike Added-weight — neither changes on every keystroke.
   *
   *  Unlike the muscle diagram/progression ladder, this one *does* change
   *  what the rider can do with the field: since the number is calculated
   *  rather than measured, the Weight input itself goes read-only
   *  (.input:disabled in style.css grays it out) for as long as a
   *  bodyweightLoadPct applies. The Added-weight field resets to empty
   *  when the matched exercise actually changes (tracked via
   *  _lastLoadEstimateExerciseId, same "not on every keystroke" guard the
   *  muscle diagram uses) — an extra load doesn't necessarily carry over
   *  from, say, weighted dips to a bodyweight-only plank.
   *
   *  Falls back to the plain manual field this view always had — Weight
   *  enabled, bodyweight box/pct/info-btn/added-weight field all hidden,
   *  existing value left untouched — for anything
   *  estimateBodyweightLoadKg() can't
   *  estimate: a weighted-equipment lift, a HOLD-mode exercise (no Weight
   *  field to fill), a custom/unlisted name, or no rider weight on file
   *  yet (Settings → Rider Profile). */
  _applyBodyweightLoad(ex) {
    const matchedId = ex?.id ?? null;
    const exerciseChanged = matchedId !== this._lastLoadEstimateExerciseId;
    if (exerciseChanged) this._lastLoadEstimateExerciseId = matchedId;

    // estimateBodyweightLoadKg() decides *whether* a pct applies (same
    // null cases as before: HOLD mode, weighted equipment, no rider
    // weight) — its actual return value isn't used here, since the total
    // now needs the raw pct against (rider + added), not the bodyweight-
    // only figure that function computes.
    const applicable = estimateBodyweightLoadKg(ex, this._riderWeightKg) != null;
    this._bodyweightLoadPct = applicable ? ex.bodyweightLoadPct : null;

    // The weight's own − / + go dead whenever the number is calculated, same as the field.
    const setWeightSteppers = disabled =>
      this._container.querySelectorAll('[data-step="weight"]').forEach(b => { b.disabled = disabled; });

    if (!applicable) {
      this._els.weight.disabled = false;
      setWeightSteppers(false);
      this._els.weightInfoBtn?.classList.add('hidden');
      this._els.bwCalc?.classList.add('hidden');
      return;
    }

    if (exerciseChanged && this._els.addedWeight) this._els.addedWeight.value = '';

    this._els.weight.disabled = true;
    setWeightSteppers(true);
    this._refreshBodyweightTotal();

    const pct = Math.round(ex.bodyweightLoadPct * 100);
    if (this._els.bodyweightBox) {
      const bwDisplay = this._units === UNITS.IMPERIAL ? kgToLb(this._riderWeightKg) : this._riderWeightKg;
      this._els.bodyweightBox.value = Math.round(bwDisplay * 10) / 10;
    }
    if (this._els.bodyweightPct) this._els.bodyweightPct.textContent = `\u00d7 ${pct}%`;
    if (this._els.weightInfoBtn) {
      this._els.weightInfoBtn.dataset.tip =
        `Calculated as ${pct}% of your bodyweight plus whatever you add in the highlighted field — ` +
        `a vest or belt is carried at the same fraction your bodyweight is on this move, ` +
        `not added on top 1:1. The total on the right isn't editable directly — change the added-weight field instead.`;
      this._els.weightInfoBtn.classList.remove('hidden');
    }
    this._els.bwCalc?.classList.remove('hidden');
  }

  /** The current bodyweight-based load in kg — (riderWeightKg +
   *  whatever's typed into Added-weight, converted from the rider's
   *  display unit) × the matched exercise's bodyweightLoadPct — or null
   *  when no such exercise is selected (see _applyBodyweightLoad()).
   *  Rounded to the nearest 0.5kg, the same granularity
   *  data/exercises.js's estimateBodyweightLoadKg() uses for the
   *  bodyweight-only figure. The one shared calculation behind both
   *  _refreshBodyweightTotal() (what's shown) and _currentLoggedWeightKg()
   *  (what's logged), so the two can never drift apart. */
  _bodyweightTotalKg() {
    if (this._bodyweightLoadPct == null) return null;
    const addedDisplay = _parseNum(this._els.addedWeight?.value) ?? 0;
    const addedKg = this._units === UNITS.IMPERIAL ? lbToKg(addedDisplay) : addedDisplay;
    return Math.round((this._riderWeightKg + addedKg) * this._bodyweightLoadPct * 2) / 2;
  }

  /** Re-renders the read-only Weight field from _bodyweightTotalKg() —
   *  called once when a bodyweight-estimate exercise is first matched
   *  (_applyBodyweightLoad()) and again on every keystroke in
   *  Added-weight (see its 'input' listener in _bind()), so the grayed
   *  Weight number always reflects the current rider-weight + added-load
   *  total, scaled together, rather than looking stale the moment the
   *  rider types a vest weight in next to it. No-op while no
   *  bodyweightLoadPct applies. */
  _refreshBodyweightTotal() {
    const totalKg = this._bodyweightTotalKg();
    if (totalKg == null) return;
    const display = this._units === UNITS.IMPERIAL ? kgToLb(totalKg) : totalKg;
    this._els.weight.value = Math.round(display * 10) / 10;
  }

  /** Shows the named skill line's full novice→master ladder
   *  (data/exercises.js's progressionChain()) beneath the muscle diagram
   *  when the selected exercise belongs to one — a rider who's picked,
   *  say, Pull-Up should see Scapular Pull-Up behind it and Archer/One-Arm
   *  ahead of it in the same glance, not have to go back into Browse and
   *  guess at a different search term. Hidden entirely for an exercise
   *  with no progressionGroup (every weighted-equipment entry, plus
   *  standalone bodyweight moves and anything custom/unlisted) — same
   *  "simply doesn't participate" convention progressionChain() itself
   *  documents. Tapping a rung other than the current one re-runs the same
   *  _selectExercise() path a picker chip does (see _bind()'s delegated
   *  click handler on data-progression-rungs). */
  _updateProgressionLadder(ex) {
    const chain = ex?.progressionGroup ? progressionChain(ex.progressionGroup) : [];
    const win = ladderWindow(chain, ex?.id);
    if (!win) {
      this._els.progressionRow?.classList.add('hidden');
      return;
    }

    const groupLabel = PROGRESSION_GROUPS.find(g => g.value === ex.progressionGroup)?.label ?? 'Skill';
    this._els.progressionRow.classList.remove('hidden');
    this._els.progressionLabel.textContent = `${groupLabel} progression \u00b7 ${win.index + 1} of ${win.total}`;

    // The current rung and one neighbour each side. A neighbour steps to that rung (the same
    // _selectExercise() path a picker chip takes); the current rung opens a tooltip listing all of
    // them (ux/info-tooltip.js reads data-tip). A missing neighbour — first or last rung — leaves an
    // empty slot, so the current rung does not slide sideways as the rider climbs.
    const rung = (r, cls) => r
      ? `<button type="button" class="strength-progression-rung ${cls}" data-exercise-id="${r.id}" aria-label="Switch to ${_esc(r.name)}">
           <span class="strength-progression-rung-name">${_esc(r.name)}</span>
           <span class="strength-progression-rung-level">${_esc(LEVEL_LABELS[r.level] ?? r.level)}</span>
         </button>`
      : `<span class="strength-progression-rung strength-progression-rung-empty" aria-hidden="true"></span>`;
    const tip = ladderTip(chain.map(r => ({ id: r.id, name: r.name, levelLabel: LEVEL_LABELS[r.level] ?? r.level })), ex.id, groupLabel);
    const cur = win.current;
    this._els.progressionRungs.innerHTML = `
      ${rung(win.prev, 'prev')}
      <button type="button" class="strength-progression-rung current" data-tip="${_esc(tip)}" aria-label="${_esc(cur.name)}, step ${win.index + 1} of ${win.total}. Show every step">
        <span class="strength-progression-rung-name">${_esc(cur.name)}</span>
        <span class="strength-progression-rung-level">${_esc(LEVEL_LABELS[cur.level] ?? cur.level)}</span>
      </button>
      ${rung(win.next, 'next')}
    `;
  }

  // ─── Sequence rail ──────────────────────────────────────────────────────

  /** Rebuilds the sequence rail's step chips — called after render(), after
   *  every exercise selection (_selectExercise()), and after every logged
   *  set (_afterSetLogged()), so both the "current step" highlight and
   *  each step's logged/target badge stay live. No-op when this session
   *  has no sequence (see this file's own doc comment on the rail) or
   *  before the rail's actually in the DOM.
   *
   *  A set/the current field counts toward a step on an exact
   *  (case-insensitive) name match, same as always, *or* on sharing the
   *  step's own progressionGroup (see _stepMatches() below) — otherwise
   *  swapping to an easier or harder rung on the progression ladder (e.g.
   *  dropping from Pistol Squat to Assisted Pistol Squat because the
   *  plain version isn't there yet) would log real sets that never count
   *  toward the step's logged/target badge and never highlight it as
   *  current, just because the rung's name no longer matches the
   *  sequence's own denormalized step.name exactly. The "current"
   *  highlight itself, though, only ever goes on one step at a time —
   *  see _currentStepIndex() for how a sequence that revisits the same
   *  progression chain more than once gets narrowed down to a single
   *  match. */
  _renderSequenceRail() {
    if (!this._sequence || !this._els.sequenceRail) return;
    const currentName = this._els.exercise.value;
    const sets = this._tracker.sets;
    const currentIndex = this._currentStepIndex(currentName);

    const rail = this._els.sequenceRail;
    const keepScroll = rail.scrollLeft;

    // One line per step — "1 · Chest Dip 0/3" — so a long name never wraps; the rail scrolls and
    // snaps instead.
    rail.innerHTML = this._sequence.exercises.map((step, i) => {
      const logged = sets.filter(s => this._stepMatches(step, s.exercise)).length;
      const complete = step.targetSets > 0 && logged >= step.targetSets;
      const isCurrent = i === currentIndex;
      return `
        <button type="button" class="strength-sequence-step${isCurrent ? ' current' : ''}${complete ? ' complete' : ''}"
                data-step-index="${i}"${isCurrent ? ' aria-current="step"' : ''}>
          <span class="strength-sequence-step-name">${i + 1} \u00b7 ${_esc(step.name)}</span>
          <span class="strength-sequence-step-badge">${logged}/${step.targetSets}${complete ? ' \u2713' : ''}</span>
        </button>
      `;
    }).join('');

    // Rebuilding the buttons forgets where the rail was scrolled to; put it back, then bring the
    // current step to the middle — but only when the current step actually moved, so a rider who
    // has swiped along the strip to look ahead is not yanked back by every keystroke or logged set.
    rail.scrollLeft = keepScroll;
    if (currentIndex !== this._lastRailIndex) {
      const first = this._lastRailIndex === -2;
      this._lastRailIndex = currentIndex;
      this._centerRailOn(currentIndex, !first);
    }
  }

  /** Scrolls the strip so step `index` sits in the middle (railScrollTarget() does the clamping).
   *  Does nothing for no current step (a free-typed exercise) or a strip that is not laid out. */
  _centerRailOn(index, smooth) {
    const rail = this._els.sequenceRail;
    const item = rail?.children[index];
    if (!item || !rail.clientWidth) return;
    const itemLeft = item.getBoundingClientRect().left - rail.getBoundingClientRect().left + rail.scrollLeft;
    const left = railScrollTarget({ itemLeft, itemWidth: item.offsetWidth, railWidth: rail.clientWidth, scrollWidth: rail.scrollWidth });
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    rail.scrollTo({ left, behavior: smooth && !reduce ? 'smooth' : 'auto' });
  }

  /** Whether a logged set (or the exercise field's current value) should
   *  count toward `step` — exact name match, same as before, or any other
   *  rung of the same progression chain the step's own exercise belongs
   *  to (data/exercises.js's progressionGroup/progressionChain()). A step
   *  with no catalog entry (exerciseId gone missing — a deleted custom
   *  exercise) or whose exercise isn't part of a progression chain just
   *  falls back to the exact-name match alone, same as always. */
  _stepMatches(step, exerciseName) {
    const name = (exerciseName ?? '').trim().toLowerCase();
    if (!name) return false;
    if (name === step.name.toLowerCase()) return true;

    const stepEx = exerciseById(step.exerciseId);
    if (!stepEx?.progressionGroup) return false;
    return exerciseByName(exerciseName)?.progressionGroup === stepEx.progressionGroup;
  }

  /** Resolves the exercise field's current value to the single sequence
   *  step (its index) that counts as "the one in progress" — shared by
   *  the rail's "current" highlight (_renderSequenceRail()) and by
   *  auto-advance (_maybeAdvanceSequence()), so the two always agree on
   *  which step a logged set belongs to.
   *
   *  _stepMatches() alone can match more than one step at once: a
   *  sequence that revisits the same progression chain later on (e.g. a
   *  Push-Up warm-up early in the rail and a Diamond Push-Up main set
   *  further down, both under the same progressionGroup) means a rider
   *  on plain Push-Ups matches both by shared chain, even though only
   *  one of them is the step actually being worked. This picks exactly
   *  one: an exact name match wins outright, being the most specific
   *  signal there is. Failing that, among steps that only match by
   *  shared progression chain, the first one that hasn't already hit its
   *  own targetSets wins — a rung swap almost always means "log toward
   *  whichever of these I haven't finished yet," not one already checked
   *  off. Falls back to the first matching step of any kind if every
   *  match is already complete (nothing left to point at), and to -1 if
   *  nothing matches at all. */
  _currentStepIndex(currentName) {
    const name = (currentName ?? '').trim().toLowerCase();
    if (!name || !this._sequence) return -1;

    const exactIndex = this._sequence.exercises.findIndex(step => step.name.toLowerCase() === name);
    if (exactIndex !== -1) return exactIndex;

    const sets = this._tracker.sets;
    let firstMatch = -1;
    for (let i = 0; i < this._sequence.exercises.length; i++) {
      const step = this._sequence.exercises[i];
      if (!this._stepMatches(step, currentName)) continue;
      if (firstMatch === -1) firstMatch = i;
      const logged = sets.filter(s => this._stepMatches(step, s.exercise)).length;
      const complete = step.targetSets > 0 && logged >= step.targetSets;
      if (!complete) return i;
    }
    return firstMatch;
  }

  // ─── Reps-mode logging ──────────────────────────────────────────────────

  /** The Weight actually recorded for a Reps-mode set, in kg. For anything
   *  without a bodyweightLoadPct this is just the plain Weight field,
   *  converted from the rider's display unit exactly as it always was.
   *  Once a pct applies (Weight field read-only at that point — see
   *  _applyBodyweightLoad()), it's _bodyweightTotalKg() — the same figure
   *  already showing in the (disabled) Weight field, so what's logged is
   *  never different from what was on screen. */
  _currentLoggedWeightKg() {
    const bwTotalKg = this._bodyweightTotalKg();
    if (bwTotalKg != null) return bwTotalKg;
    const weightDisplay = _parseNum(this._els.weight.value);
    return weightDisplay != null
      ? (this._units === UNITS.IMPERIAL ? lbToKg(weightDisplay) : weightDisplay)
      : null;
  }

  _logRepsSet() {
    const exercise = this._els.exercise.value.trim();
    const reps = _parseNum(this._els.reps.value);
    const rpe = _parseNum(this._els.rpe.value);

    if (!exercise || !reps) return; // nothing meaningful to log yet

    const weight = this._currentLoggedWeightKg();

    this._tracker.logSet(
      { exercise, mode: SET_MODES.REPS, reps, weight, rpe },
      this._session.sampleCount,
      this._session.samples
    );

    // Clear reps/RPE for the next set but keep exercise + weight — the
    // common case is logging several sets of the same lift at the same load.
    this._els.reps.value = '';
    this._els.rpe.value = '';

    this._afterSetLogged();
  }

  // ─── Hold-mode logging ──────────────────────────────────────────────────

  _toggleHold() {
    if (this._tracker.inProgress) {
      this._finishHold();
    } else {
      this._startHold();
    }
  }

  _startHold() {
    const exercise = this._els.exercise.value.trim();
    if (!exercise) { this._els.exercise.focus(); return; }

    const targetHoldSeconds = _parseNum(this._els.targetHold.value);
    this._holdCueFired = false;
    this._tracker.beginSet(
      { exercise, mode: SET_MODES.HOLD, targetHoldSeconds },
      this._session.sampleCount
    );

    this._setHoldBtn('running');
  }

  /** The hold button's two faces: 'idle' (clock + play, "Start hold") and 'running' (the green
   *  check, "Log hold" — the same button the reps side uses, since a tap now logs the hold). */
  _setHoldBtn(state) {
    const btn = this._els.holdBtn;
    const running = state === 'running';
    btn.dataset.holdState = running ? 'running' : 'idle';
    btn.setAttribute('aria-label', running ? 'Log hold' : 'Start hold');
    btn.title = running ? 'Log hold' : 'Start hold';
    btn.querySelector('[data-hold-icon]')?.setAttribute('href', running ? '#icon-check' : '#icon-hold-play');
  }

  _finishHold() {
    const pending = this._tracker.pendingSet;
    const holdSeconds = pending?.startedAt ? Math.round((Date.now() - pending.startedAt) / 1000) : 0;

    this._tracker.completeSet(
      { holdSeconds },
      this._session.sampleCount,
      this._session.samples
    );

    this._els.holdTimer.textContent = '0:00';
    this._setHoldBtn('idle');

    this._afterSetLogged();
  }

  _afterSetLogged() {
    this._syncSetNumber();
    this._renderSetsList();
    if (!this._maybeAdvanceSequence()) this._renderSequenceRail();
    this._onSetsChanged();
  }

  /** Auto-advances the exercise field to the next sequence step after
   *  *every* set logged against the current step — one set in, one step
   *  forward, regardless of how many sets that step's own targetSets
   *  calls for. (An earlier version waited for the step's full target to
   *  be met before advancing; that's no longer the trigger — the
   *  logged/target badge in _renderSequenceRail() still climbs toward
   *  targetSets exactly as before and still marks a step "complete" once
   *  it's reached, but hitting that count doesn't do anything special
   *  for navigation anymore.) Saves an explicit rail tap between every
   *  set for the common case of working straight down the rail in order
   *  — a rider who wants a second set logged against a step already
   *  passed just taps back on that step's own rail chip; this method
   *  only ever moves forward one step. Runs _selectSequenceStep() (same
   *  path a manual rail tap takes, so it re-renders the rail, updates
   *  the muscle/progression panel, and — same as picking a step by hand
   *  — focuses Weight/Reps or the hold target for the next set) and
   *  returns true when it did, so _afterSetLogged() above knows not to
   *  also render the rail itself.
   *
   *  Only advances *from* the step the just-logged set actually matches
   *  (_currentStepIndex() — exact name, or the one in-progress step
   *  among several sharing a progression chain; see that method's own
   *  doc comment), only to the very next step in sequence order (not
   *  hunting for the next incomplete one — a guide, not a wizard, same
   *  stance the rail already takes elsewhere), and never past the end of
   *  the sequence. A set logged outside the sequence entirely (free-
   *  typed/Browse pick), or no sequence at all, just leaves the exercise
   *  field exactly where it was.
   *
   *  Logging against the very last step wraps back to the top for the next
   *  pass (see _nextPassStepIndex()) — exercise 1..N for set one, then set
   *  two starts at exercise 1 again — unless every step has already hit its
   *  targetSets, in which case it stays on the last step. */
  _maybeAdvanceSequence() {
    if (!this._sequence) return false;

    const currentName = this._els.exercise.value;
    const idx = this._currentStepIndex(currentName);
    if (idx < 0) return false;

    const next = this._sequence.exercises[idx + 1];
    if (next) {
      this._selectSequenceStep(next);
      return true;
    }

    // Logged against the last step: that finishes a pass down the rail, so
    // wrap back to the top for the next pass (set 2, exercise 1, and so on).
    const wrapIdx = this._nextPassStepIndex();
    if (wrapIdx < 0) return false;
    this._selectSequenceStep(this._sequence.exercises[wrapIdx]);
    return true;
  }

  /** Where the rail wraps to after a set is logged against its *last* step:
   *  the first step that still has sets left to log (logged < targetSets),
   *  which for a normal sequence is simply step 1 again — each pass down the
   *  rail is one more set of every exercise, so the logged/target badges
   *  (and each set's own setNumber, which SetTracker counts per exercise)
   *  climb 1, 2, 3 in step with the passes. Returns -1 once every step has
   *  reached its targetSets, so a finished sequence stays put on its last
   *  step instead of looping forever — a rider who wants extra sets beyond
   *  the plan just taps a rail chip, same "guide, not a wizard" stance as
   *  the rest of the rail. A step with targetSets <= 0 never counts as
   *  having sets left. */
  _nextPassStepIndex() {
    const sets = this._tracker.sets;
    return this._sequence.exercises.findIndex(step => {
      if (!(step.targetSets > 0)) return false;
      const logged = sets.filter(s => this._stepMatches(step, s.exercise)).length;
      return logged < step.targetSets;
    });
  }

  // ─── Ticking (rest timer / hold timer) ─────────────────────────────────

  _tick() {
    // Hold timer — only moves while a hold is actually in progress.
    const pending = this._tracker.pendingSet;
    if (pending?.startedAt) {
      const elapsed = (Date.now() - pending.startedAt) / 1000;
      this._els.holdTimer.textContent = _fmtMmSs(elapsed);

      if (pending.targetHoldSeconds && !this._holdCueFired && elapsed >= pending.targetHoldSeconds) {
        this._holdCueFired = true;
        audioCues.play('beep');
      }
    }

    // Rest timer — time since the last logged set ended. Reads 0:00 until
    // the first set is logged (Session doesn't expose its start time
    // publicly, and "rest before the first set" isn't a meaningful number
    // anyway). Kept simple for readability; a caller wanting it to freeze
    // once a new hold starts can check tracker.inProgress and skip calling
    // this while true.
    const sets = this._tracker.sets;
    if (sets.length) {
      const since = sets[sets.length - 1].completedAt;
      this._els.restTimer.textContent = _fmtMmSs((Date.now() - since) / 1000);
    }
  }

  // ─── Sets list ──────────────────────────────────────────────────────────

  _renderSetsList() {
    const sets = this._tracker.sets;
    const groups = groupByExercise(sets);
    const unitLabel = weightUnitLabel(this._units);

    this._els.setsSummary.innerHTML = sets.length ? `
      <div class="history-card-stats">
        <div class="stat-chip"><span class="stat-val">${sets.length}</span><span class="stat-lbl">SETS</span></div>
        <div class="stat-chip"><span class="stat-val">${this._fmtWeight(totalVolume(sets))}</span><span class="stat-lbl">VOLUME (${unitLabel})</span></div>
        <div class="stat-chip"><span class="stat-val">${_fmtMmSs(totalHoldTime(sets))}</span><span class="stat-lbl">HOLD TIME</span></div>
      </div>
    ` : `<p class="settings-sub">No sets logged yet this session.</p>`;

    this._els.setsList.innerHTML = groups.map(g => `
      <div class="strength-exercise-group">
        <div class="strength-exercise-name">${_esc(g.exercise)}</div>
        ${g.sets.map(s => this._setRow(s, unitLabel)).join('')}
      </div>
    `).join('');
  }

  _setRow(s, unitLabel) {
    const detail = s.mode === SET_MODES.HOLD
      ? `${_fmtMmSs(s.holdSeconds ?? 0)} hold`
      : `${s.weight != null ? this._fmtWeight(s.weight) + ' ' + unitLabel + ' × ' : ''}${s.reps} reps`;

    const hr = s.avgHr != null
      ? `<span class="strength-set-hr" data-metric="heartRate">${s.avgHr} bpm${s.hrDrift ? ` <span class="strength-hr-drift">(+${s.hrDrift})</span>` : ''}</span>`
      : '';

    return `
      <div class="strength-set-row">
        <span class="strength-set-num">${s.setNumber}</span>
        <span class="strength-set-detail">${detail}</span>
        ${s.rpe ? `<span class="strength-set-rpe">RPE ${s.rpe}</span>` : ''}
        ${hr}
      </div>
    `;
  }

  _fmtWeight(kg) {
    const v = this._units === UNITS.IMPERIAL ? kgToLb(kg) : kg;
    return Math.round(v * 10) / 10;
  }
}

// ─── Local formatting helpers ───────────────────────────────────────────────

function _muscleLabel(id) { return MUSCLE_LABELS[id] ?? id; }

function _fmtMmSs(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function _parseNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default StrengthSessionPanel;
