// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/cardio-session-flow.js
 *
 * Single-screen cardio setup flow — opened from the floating "+" button's
 * pillbox menu ("Cardio Session" item). Asks exactly one screen's worth of
 * questions rather than walking through separate steps:
 *
 *   1. Activity       (Stride, Cycling, Rowing, Stairmaster, Treadmill, or
 *                      Elliptical — see EQUIPMENT_TYPES below, picked from
 *                      a dropdown — plus an Indoor/Outdoor toggle for
 *                      whichever of those can genuinely go either way, i.e.
 *                      Cycling/Rowing; hidden for the rest, which are
 *                      either always-indoor machines or, for Stride,
 *                      always outdoor by definition)
 *   2. Target style   (Free, Steady, or Sequence — data/cardio-timelines.js's
 *                      TARGET_STYLES, in that display order; Sequence is the
 *                      internal 'mapped' value, kept as-is for backward
 *                      compatibility with already-saved rider settings)
 *   3. Target zone    (Steady/Sequence only — a dropdown of color-coded
 *                      shortcuts, one zone per row, backed by metrics/
 *                      ftp-zones.js's 7 power zones or metrics/hr-zones.js's
 *                      5 HR zones, see _zoneOptions(); same .sf-zone-
 *                      dropdown/-trigger/-panel shape the Cardio Sequence
 *                      picker below it uses. Picking a row is a shortcut,
 *                      not a lock — for Steady it autofills the numeric
 *                      Target field below to that zone's midpoint
 *                      (_zoneMidpoint()), for Sequence it filters the
 *                      Cardio Sequence panel down to the one matching
 *                      preset group's four duration presets, see
 *                      FTP_ZONE_TO_TIMELINE_GROUP)
 *   4. Steady target  (Steady only — HR Zone/FTP, see STEADY_MODES
 *                      below, each a rider-dialed-in numeric value) or
 *                      Cardio Sequence (Sequence style only — a bundled or
 *                      rider-saved cardio-timelines.js preset, picked from
 *                      a card panel grouped by output — see TIMELINE_GROUPS
 *                      — same .sf-sequence-dropdown/-trigger/-panel/-card
 *                      shape ui/strength-session-flow.js's Resistance
 *                      Sequence step uses)
 *   5. Workout name    (seeded from the activity/style/mode/preset, fully
 *                      editable — see _composeName())
 *   6. Equipment       (controller/HRM/SmO2/core temp connect rows — a BLE
 *                      pairing checklist, unrelated to the Activity picker
 *                      above despite the shared word)
 *   7. Length of time  (minutes — Free/Steady only; a Sequence preset's own
 *                      shape already determines the session's length)
 *
 * Tapping "Start Workout" builds a WorkoutModel and hands it to onStart
 * immediately — there is no "review" step and no intermediate "load into
 * editor" hop, the caller is expected to start the session right away (see
 * app.js's onStart wiring). Free/Steady both build a single flat block
 * spanning the whole duration; Sequence builds the picked preset's whole
 * warm-up/interval/cool-down shape instead (see buildQuickStartWorkout()
 * below).
 *
 * Free specifically builds a STEP_TYPES.FREE_RIDE / TARGET_TYPES.NONE step,
 * which the playback engine (playback/scripted-session.js) already treats
 * as "leave control alone" — so an unstructured quick ride still gets the
 * session/recording/auto-stop-at-time-limit machinery for free, without
 * imposing any power target. It's the flow's default target style — see
 * _blankDraft().
 *
 * Sequence's "Open in Advanced Builder…" action (shown once a preset is
 * picked) hands that preset to onEditPreset instead of starting anything —
 * app.js's openPresetInAdvancedBuilder() opens a *copy* of it in
 * editor/workout-editor.js for the rider to tweak and save as a new named
 * preset (see that function's own doc comment, and workout-editor.js's
 * load()/`intent` doc comment for how one Save button there ends up
 * meaning "save as preset" instead of "load into session"). Saving one
 * reopens this flow with the new preset already picked (see app.js's
 * onSavePreset wiring) — since the Cardio Sequence panel always reads a
 * fresh data/cardio-timelines.js#allTimelinePresets() at render time, a
 * newly-saved custom preset shows up in it (in its own trailing "Custom"
 * group — see TIMELINE_GROUPS) with no extra plumbing needed here.
 *
 * buildQuickStartWorkout() is exported standalone (not just as a method on
 * the class) so callers can rebuild the same shape of workout from saved
 * settings without opening the UI at all — see app.js's "repeat last
 * workout" FAB menu item. It also degrades gracefully from the older
 * settings shape (a `workoutType` string, from before Steady's HR Zone/
 * FTP split existed) so an already-saved "repeat last" draft on a
 * rider's device never hard-fails — see its own doc comment. The same
 * fallback also catches an already-saved `steadyMode: 'vo2max'` draft
 * from after that split but before VO2 Max was folded into FTP (it was
 * always just a %-of-FTP target within FTP's own range) — see
 * buildQuickStartWorkout()'s own doc comment.
 *
 * Lives in the shared detail sheet (ui/detail-sheet.js, `size: 'tall'`, `flush`): open() puts the
 * form in it, close() takes it away, and the sheet's own Close button, scrim tap, Esc and drag-down
 * all count as Cancel (onCancel runs; Start Workout and Open in Advanced Builder close it without
 * onCancel). The form owns its own scrolling body and pinned Cancel / Start Workout foot.
 *
 * Usage:
 *   const quickStart = new CardioSessionFlow({
 *     ftp: 200,
 *     hrProfile: { maxHr: 185, restingHr: 52 },  // feeds Steady's HR Zone name segment
 *     onStart:      (model, settings) => { ... },  // settings = { targetStyle, equipment, location, steadyMode, steadyValue, mappedPresetId, name, durationMin }
 *     onEditPreset: (preset) => { ... },            // "Open in Advanced Builder…"
 *     onCancel: () => { ... },
 *   });
 *   quickStart.open();
 *   quickStart.open({ targetStyle: 'mapped', mappedPresetId: 'custom:abc123' });
 */

import { detailSheet } from './detail-sheet.js';
import { tileGroupHtml, deviceTileHtml, patchDeviceTile } from './setup-tiles.js';
import { createWorkout, createStep, STEP_TYPES, TARGET_TYPES, flattenStep, curveProgress } from '../core/cardio-model.js';
import {
  TARGET_STYLES, TIMELINE_GROUPS, TIMELINE_GROUP_ORDER, allTimelinePresets, timelinePresetById, buildTimelineWorkout,
} from '../data/cardio-timelines.js';
import { STEP_COLORS } from '../editor/workout-editor.js';
import { zoneForPower, zonesForFtp } from '../metrics/ftp-zones.js';
import { zoneForHr, zonesForHr } from '../metrics/hr-zones.js';

const DEFAULT_DURATION_MIN = 30;

// ─── Activity / equipment ───────────────────────────────────────────────────
// What the rider is actually doing/using this session — picked from the
// Activity dropdown (#qs-equipment) — a naming input for the default
// Workout name (see _equipmentLabel()/_composeName() below) and nothing
// else; no other part of the flow branches on it. `supportsLocation`
// gates the Indoor/Outdoor toggle that appears beneath it: Cycling and
// Rowing can genuinely go either way, but a Stairmaster, Treadmill, or
// Elliptical is always indoor gear, and Stride (unstructured running/
// walking/sprints) is always outdoor by definition — so both the toggle
// and any "Indoor "/"Outdoor " prefix on the name are skipped for those
// four, same "hide what can't apply" idea as Sequence's own preset
// section only showing up for its one relevant target style.
export const EQUIPMENT_TYPES = [
  { value: 'stride',      label: 'Stride',      supportsLocation: false, blurb: 'Outdoor running, walking, or sprints \u2014 no equipment to pair.' },
  { value: 'cycling',     label: 'Cycling',     supportsLocation: true,  blurb: 'Indoor trainer or outdoor bike.' },
  { value: 'rowing',      label: 'Rowing',      supportsLocation: true,  blurb: 'Indoor rowing machine or on the water.' },
  { value: 'stairmaster', label: 'Stairmaster', supportsLocation: false, blurb: 'Stair-climbing machine \u2014 always indoor.' },
  { value: 'treadmill',   label: 'Treadmill',   supportsLocation: false, blurb: 'Treadmill running or walking \u2014 always indoor.' },
  { value: 'elliptical',  label: 'Elliptical',  supportsLocation: false, blurb: 'Elliptical trainer \u2014 always indoor.' },
];
// Cycling — the app's most common indoor-trainer use case (see this file's
// own module doc comment) — same "never land on an empty, unstartable
// choice" convention as DEFAULT_STEADY_MODE below.
const DEFAULT_EQUIPMENT = EQUIPMENT_TYPES[1];

const LOCATIONS = [
  { value: 'indoor',  label: 'Indoor' },
  { value: 'outdoor', label: 'Outdoor' },
];
const DEFAULT_LOCATION = LOCATIONS[0].value;

// Icons for the tile rows (ui/setup-tiles.js) — keyed by the same values the draft stores, so a
// value with no entry just shows its label.
const LOCATION_ICONS     = { indoor: 'icon-home', outdoor: 'icon-sun' };
const TARGET_STYLE_ICONS = { free: 'icon-free', steady: 'icon-steady', mapped: 'icon-steps' };
const STEADY_MODE_ICONS  = { hrZone: 'icon-heart', ftp: 'icon-lightning' };
const DEVICE_ICONS       = { controller: 'icon-bike', hrm: 'icon-heart', smo2: 'icon-droplet', coreTemp: 'icon-thermometer' };

/** The Workout-name-facing label for a piece of equipment — "Indoor "-
 *  prefixed when it supports both locations and Indoor is picked,
 *  otherwise just its plain label (see EQUIPMENT_TYPES' own doc comment;
 *  there's no "Outdoor " prefix — outdoor is the unmarked default, same
 *  as the app's pre-existing "Bicycle" vs "Indoor Cycling" naming). */
function _equipmentLabel(equipmentValue, location) {
  const eq = EQUIPMENT_TYPES.find(e => e.value === equipmentValue) ?? DEFAULT_EQUIPMENT;
  return eq.supportsLocation && location === 'indoor' ? `Indoor ${eq.label}` : eq.label;
}

// ─── Steady sub-modes ───────────────────────────────────────────────────────
// Picked once "Steady" is the target style — replaces the old flat Workout
// Type dropdown (a canned list of activity/session names, each carrying its
// own fixed power rang with a direct numeric target the rider dials in 
// themselves, on whichever basis they actually train by. min/max are a sanity
// clamp against fat-fingering, not a training prescription — wide enough to
// cover every realistic steady effort on that basis; buildQuickStartWorkout()
// below re-clamps to them regardless of what the number input itself enforces.

const STEADY_MODES = [
  {
    value: 'hrZone', label: 'HR Zone', unit: 'bpm', targetType: TARGET_TYPES.HEART_RATE,
    min: 60, max: 220, step: 1, default: 140,
    blurb: 'Hold a target heart rate for the whole session.',
  },
  {
    value: 'ftp', label: 'FTP', unit: '% of FTP', targetType: TARGET_TYPES.POWER,
    min: 40, max: 150, step: 1, default: 70,
    blurb: 'Hold a target power as a percentage of your FTP.',
  },
];
// 'ftp' is the most generically useful basis to land on the moment Steady
// is picked — same "never land on an empty, unstartable choice" convention
// _blankDraft() applies everywhere else in this file.
const DEFAULT_STEADY_MODE = STEADY_MODES[1];

// ─── Target zone dropdown ───────────────────────────────────────────────────
// Color-coded shortcuts shown directly below the Target style toggle for
// both Steady and Sequence (see this file's own module doc comment) — one
// shared dropdown, backed by whichever of metrics/ftp-zones.js's 7 power
// zones or metrics/hr-zones.js's 5 HR zones actually applies (see the
// CardioSessionFlow class's own _zoneOptions()): Sequence's presets are all
// POWER-based (see data/cardio-timelines.js's own doc comment), same basis
// Steady's FTP sub-mode uses, so all three share the ftp-zones.js list;
// only Steady's HR Zone sub-mode reads hr-zones.js's instead.
//
// FTP_ZONE_TO_TIMELINE_GROUP is what makes a zone tap a real filter for
// Sequence rather than just a label: it maps each of the 7 ftp-zones.js
// zones onto whichever of the four TIMELINE_GROUPS a bundled preset at
// that intensity actually belongs to (Recovery's ~60-62% onTarget sits in
// Zone 2; the Build group spans Zone 3's Tempo intensity through Zone 4's
// Threshold; VO2 Max's ~105-110% is Zone 5 outright; Sprints' 140-150% is
// Zone 6, with Zone 7 folded in alongside it as the next-hardest bucket
// rather than left with no matching group of its own) — so picking any
// zone always resolves to exactly one group, and every group has exactly
// four presets, one per duration (see BUILTIN_TIMELINE_PRESETS' own doc
// comment), which is what narrows the Cardio Sequence panel down to
// exactly the four durations that apply rather than some other count.
const FTP_ZONE_TO_TIMELINE_GROUP = {
  1: TIMELINE_GROUPS.RECOVERY,
  2: TIMELINE_GROUPS.RECOVERY,
  3: TIMELINE_GROUPS.BUILD,
  4: TIMELINE_GROUPS.BUILD,
  5: TIMELINE_GROUPS.VO2MAX,
  6: TIMELINE_GROUPS.SPRINTS,
  7: TIMELINE_GROUPS.SPRINTS,
};

/**
 * The numeric middle of a zone's range, on whichever basis `mode` itself
 * uses (bpm for HEART_RATE, %-of-FTP for POWER) — what a Target zone tap
 * actually writes into Steady's numeric Target field (see
 * _bindBodyEvents()'s [data-target-zone] handler). The top zone's open
 * ceiling (zone.high === null — Neuromuscular/Maximum) has no real
 * midpoint to split, so it splits against the mode's own sane ceiling
 * instead, landing partway up from the zone's floor rather than pinned to
 * either extreme. Always re-clamped to [mode.min, mode.max] regardless —
 * same "never trust a derived number blindly" convention
 * buildQuickStartWorkout() already applies to a hand-typed value.
 *
 * @param {Object} zone  One entry from zonesForFtp()/zonesForHr() — { low, high, ... }.
 * @param {Object} mode  A STEADY_MODES entry.
 */
function _zoneMidpoint(zone, mode) {
  const high = zone.high ?? mode.max;
  const mid  = (zone.low + high) / 2;
  return Math.round(Math.min(mode.max, Math.max(mode.min, mid)));
}

/**
 * The training-zone name a Steady session's current numeric target falls
 * into, per the rider's own profile — the "{Target zone}" segment of
 * Steady's default Workout name (see _composeName()). HR Zone reads
 * hrProfile (maxHr/restingHr, already resolved by the caller — see
 * app.js's _resolvedMaxHr(), which folds in the Tanaka age estimate)
 * through metrics/hr-zones.js#zoneForHr. FTP already stores its value as
 * a %-of-FTP number (see STEADY_MODES below), so
 * metrics/ftp-zones.js#zoneForPower can read it straight off a fake
 * 100-watt FTP — `watts / ftp` still comes out to the same fraction —
 * without needing the rider's real FTP at all.
 *
 * Returns null when a zone can't be resolved yet (no maxHr on file for HR
 * Zone) — callers drop the segment entirely rather than showing a
 * placeholder or wrong zone.
 *
 * @param {Object} mode        A STEADY_MODES entry.
 * @param {number|string} rawValue
 * @param {Object} [hrProfile] { maxHr, restingHr } — HR Zone only.
 */
function _steadyZoneLabel(mode, rawValue, hrProfile) {
  const parsed  = parseFloat(rawValue);
  const clamped = Math.min(mode.max, Math.max(mode.min, Number.isFinite(parsed) ? parsed : mode.default));
  if (mode.targetType === TARGET_TYPES.HEART_RATE) {
    if (!hrProfile?.maxHr) return null;
    return zoneForHr(clamped, hrProfile)?.name ?? null;
  }
  return zoneForPower(clamped, 100)?.name ?? null;
}

/**
 * Builds this session's default Workout name. The shape differs by target
 * style:
 *   Free:   "Free {Equipment}"                    e.g. "Free Stride"
 *   Steady: "Steady {Equipment} - {Target zone}"  e.g. "Steady Indoor Cycling - Threshold"
 *           (the " - {zone}" segment is dropped when _steadyZoneLabel()
 *           can't resolve one yet)
 *   Sequence: "{Equipment} - {Preset name}"       e.g. "Treadmill - VO2 Max"
 * {Equipment} is _equipmentLabel()'s own "Indoor "-prefixed-where-it-
 * applies label. Always just a starting point — every caller reseeds
 * through this (see _reseedName()) on any equipment/location/style/mode/
 * value/preset change, and the field remains fully editable afterward
 * regardless of what seeded it.
 *
 * @param {'free'|'steady'|'mapped'} style
 * @param {string} equipLabel
 * @param {Object} [opts]
 * @param {string|null} [opts.zoneLabel]    Steady only — see _steadyZoneLabel().
 * @param {string}      [opts.presetLabel]  Sequence only.
 */
function _composeName(style, equipLabel, { zoneLabel, presetLabel } = {}) {
  if (style === 'mapped') return `${equipLabel} - ${presetLabel}`;
  if (style === 'steady') return zoneLabel ? `Steady ${equipLabel} - ${zoneLabel}` : `Steady ${equipLabel}`;
  return `Free ${equipLabel}`;
}

/**
 * Builds a WorkoutModel from quick-start settings.
 *
 * Sequence (settings.targetStyle === 'mapped') materializes the picked
 * cardio-timelines.js preset via buildTimelineWorkout() — a whole warm-up/
 * interval/cool-down shape rather than one flat block — falling through to
 * the Free path below if the preset id doesn't resolve (e.g. a custom
 * preset deleted since a "repeat last workout" draft was recorded; see
 * data/cardio-timelines.js's timelinePresetById() for that null-on-miss
 * contract) so a stale saved draft never hard-fails.
 *
 * Steady (settings.targetStyle === 'steady') looks up settings.steadyMode
 * in STEADY_MODES and builds a single STEADY step at settings.steadyValue,
 * re-clamped to that mode's [min, max] (never trusting a value that may
 * have been hand-edited into a saved pref) — the HEART_RATE mode stores
 * the value directly in bpm, the POWER mode (FTP, %-of-FTP) divides by
 * 100 for the FTP multiplier the model actually stores. A saved
 * settings.steadyMode of 'vo2max' — retired from STEADY_MODES since it
 * was always just a %-of-FTP target sitting inside FTP's own range —
 * degrades to the FTP mode instead, same steadyValue carried over
 * unchanged (VO2 Max's whole 100–150 range already sits inside FTP's
 * wider 40–150 one), rather than falling all the way through to Free.
 *
 * Everything else — Free (targetStyle === 'free'), a Sequence preset that
 * didn't resolve, a Steady settings.steadyMode that doesn't match any
 * STEADY_MODES entry (nor the retired 'vo2max' value, which degrades to
 * FTP instead — see above), and legacy settings shapes (a `workoutType`
 * string instead of steadyMode/steadyValue, from before this split
 * existed — 'freeRide' or no workoutType at all degrades here too, same
 * as it always has; any other legacy workoutType degrades to a generic
 * FTP target rather than trying to resurrect the retired per-type power
 * ranges) — falls through to an unstructured FREE_RIDE/NONE step (no
 * enforced target — the rider controls resistance manually), same as any
 * other free ride.
 *
 * @param {Object} settings
 * @param {'free'|'steady'|'mapped'} [settings.targetStyle='free']
 * @param {string} [settings.equipment]       One of EQUIPMENT_TYPES' values — only feeds the
 *                                            fallback name below (see equipLabel); settings.name
 *                                            is already fully composed by the time the UI class
 *                                            calls this, so this rarely does anything in practice.
 * @param {string} [settings.location]        'indoor'|'outdoor' — equipment that supportsLocation only.
 * @param {Object} [settings.hrProfile]        { maxHr, restingHr } — HR Zone's fallback name only.
 * @param {string} [settings.steadyMode]      Steady only — one of STEADY_MODES' values.
 * @param {number} [settings.steadyValue]     Steady only — numeric value on that mode's basis.
 * @param {string} [settings.mappedPresetId]  Sequence only — a cardio-timelines.js preset id.
 * @param {string} settings.name
 * @param {number} settings.durationMin       Free/Steady only — ignored for Sequence.
 * @returns {WorkoutModel}
 */
export function buildQuickStartWorkout(settings) {
  const {
    targetStyle, name, durationMin, mappedPresetId, steadyMode, steadyValue, workoutType,
    equipment, location, hrProfile,
  } = settings ?? {};
  const durationSec = Math.max(60, Math.round((durationMin || DEFAULT_DURATION_MIN) * 60));
  const equipLabel  = _equipmentLabel(equipment ?? DEFAULT_EQUIPMENT.value, location ?? DEFAULT_LOCATION);

  if (targetStyle === 'mapped') {
    const preset = timelinePresetById(mappedPresetId);
    if (preset) {
      const finalName = (name ?? '').trim() || _composeName('mapped', equipLabel, { presetLabel: preset.label });
      return buildTimelineWorkout(preset, { name: finalName });
    }
    // Falls through to Free below on a miss.
  }

  // The `|| (targetStyle == null && workoutType != null)` half of this
  // condition is what actually makes a *pre-Sequence* "repeat last workout"
  // draft degrade gracefully: those were saved before `targetStyle`
  // existed as a field at all, so they carry a bare `workoutType` with no
  // `targetStyle` of any kind — not even 'steady' — which an explicit
  // `=== 'steady'` check alone would miss entirely and send straight past
  // this whole branch to Free below, silently dropping whatever power
  // target that old draft used to hold.
  if (targetStyle === 'steady' || (targetStyle == null && workoutType != null)) {
    const mode = STEADY_MODES.find(m => m.value === steadyMode)
      // Legacy fallback — see this function's own doc comment. A saved
      // 'vo2max' steadyMode (retired from STEADY_MODES — it was always
      // just a %-of-FTP target sitting inside FTP's own range) degrades
      // to FTP the same way an even older bare workoutType string does.
      ?? ((steadyMode === 'vo2max' || (workoutType && workoutType !== 'freeRide')) ? STEADY_MODES.find(m => m.value === 'ftp') : null);
    if (mode) {
      // 'vo2max' also counts as a resolvable steadyMode here so its
      // original steadyValue carries over unchanged into the FTP mode
      // above, rather than falling back to FTP's own default — VO2 Max's
      // whole 100–150 range already sits inside FTP's wider 40–150 one,
      // so the re-clamp just below is a no-op for any value it actually held.
      const raw     = (STEADY_MODES.some(m => m.value === steadyMode) || steadyMode === 'vo2max') ? parseFloat(steadyValue) : NaN;
      const clamped = Math.min(mode.max, Math.max(mode.min, Number.isFinite(raw) ? raw : mode.default));
      const value   = mode.targetType === TARGET_TYPES.POWER ? clamped / 100 : clamped;
      const finalName = (name ?? '').trim() || _composeName('steady', equipLabel, { zoneLabel: _steadyZoneLabel(mode, clamped, hrProfile) });
      const step = createStep({
        type: STEP_TYPES.STEADY, duration: durationSec,
        targetType: mode.targetType, targetLow: value, targetHigh: value,
        name: finalName,
      });
      return createWorkout({ name: finalName, sourceFormat: 'manual', steps: [step] });
    }
    // Falls through to Free below.
  }

  const finalName = (name ?? '').trim() || _composeName('free', equipLabel);
  const step = createStep({
    type: STEP_TYPES.FREE_RIDE, duration: durationSec,
    targetType: TARGET_TYPES.NONE, name: finalName,
  });
  return createWorkout({ name: finalName, sourceFormat: 'manual', steps: [step] });
}

export class CardioSessionFlow {
  /**
   * @param {Object}      opts
   * @param {number}      [opts.ftp=200]
   * @param {Object}      [opts.hrProfile]  { maxHr, restingHr } — feeds Steady's HR Zone
   *   mode's "{Target zone}" name segment (see _steadyZoneLabel()). Pass the already-resolved
   *   maxHr (see app.js's _resolvedMaxHr(), which folds in the Tanaka age estimate), not just
   *   a raw profile.maxHr that might be null.
   * @param {Function}    [opts.onStart]   (WorkoutModel, settings) => void — "Start Workout"
   * @param {Function}    [opts.onCancel]  () => void
   * @param {Function}    [opts.onEditPreset]  (preset) => void — Sequence's "Open in
   *   Advanced Builder…" action, called instead of onStart with the currently
   *   selected cardio-timelines.js preset. Closes the flow first, same as onStart.
   * @param {Function}    [opts.onConnectController]  () => void — "Connect" clicked for Controller
   * @param {Function}    [opts.onConnectHrm]         () => void — "Connect" clicked for HRM
   * @param {Function}    [opts.onConnectSmo2]        () => void — "Connect" clicked for SmO₂ sensor
   * @param {Function}    [opts.onConnectCoreTemp]    () => void — "Connect" clicked for core temp sensor
   */
  constructor({
    ftp = 200, hrProfile = null, onStart, onCancel, onEditPreset,
    onConnectController, onConnectHrm, onConnectSmo2, onConnectCoreTemp,
  } = {}) {
    this._handle = null;     // the open detail-sheet handle, or null
    this._root   = null;     // the form's root element inside the sheet's body
    this._openToken = 0;     // tells a stale onClose (an old sheet finishing late) from the current one
    this._userClosing = false; // set by a Close / scrim / Esc / drag / Cancel, so onClose can fire onCancel
    this._ftp        = ftp;
    this._hrProfile   = hrProfile ?? { maxHr: null, restingHr: null };
    this._onStart     = onStart;
    this._onCancel    = onCancel;
    this._onEditPreset = onEditPreset;
    this._onConnectController = onConnectController;
    this._onConnectHrm        = onConnectHrm;
    this._onConnectSmo2       = onConnectSmo2;
    this._onConnectCoreTemp   = onConnectCoreTemp;
    this._draft = this._blankDraft();
    // Tracks the last name _reseedName() actually wrote, so the
    // high-frequency Steady value input (see _bindBodyEvents()) can tell
    // "still the auto-composed name" apart from "rider already typed
    // their own" without a separate dirty flag — see that handler's own
    // comment.
    this._lastAutoName = this._draft.name;

    // Tri-state dot convention — app.js pushes updates here (via
    // setDeviceStatus) so this always reflects true BLE state.
    this._deviceStatus = {
      controller: 'disconnected', hrm: 'disconnected',
      smo2: 'disconnected', coreTemp: 'disconnected',
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Reset to a blank draft and show the sheet. Optionally pre-seeds the
   * Sequence target style with a specific preset already selected — used by
   * app.js's WorkoutEditor onSavePreset callback so saving a new custom
   * preset from the Advanced Builder reopens Quick Start with that
   * brand-new preset picked and ready to start, instead of dropping back
   * to a blank Free Ride draft.
   * @param {Object} [opts]
   * @param {'free'|'steady'|'mapped'} [opts.targetStyle]  Only 'mapped' is
   *   handled specially below — the sole caller (app.js's onSavePreset) only
   *   ever passes 'mapped'. Anything else is ignored, same as omitting it.
   * @param {string}            [opts.mappedPresetId]
   */
  open({ targetStyle, mappedPresetId } = {}) {
    this._draft = this._blankDraft();
    this._lastAutoName = this._draft.name;
    if (targetStyle === 'mapped') {
      const presets = allTimelinePresets();
      const preset  = (mappedPresetId && timelinePresetById(mappedPresetId)) || presets[0] || null;
      this._draft.targetStyle    = 'mapped';
      this._draft.mappedPresetId = preset?.id ?? null;
      if (preset) this._reseedName();
    }
    this._userClosing = false;
    const token = ++this._openToken;
    this._handle = detailSheet.open({
      title: 'Cardio Session',
      subtitle: 'Pick your activity and target style, name it, connect your gear, and go.',
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
    this._root?.querySelector('select, input')?.focus();
  }

  get isOpen() { return !!this._handle?.isOpen; }

  /** Close the sheet. Does not discard the draft (re-opening starts fresh anyway) and does not
   *  call onCancel — that is only for the rider backing out. */
  close() {
    this._handle?.close();
  }

  setFtp(ftp) { this._ftp = ftp; }

  /** Update the HR profile _steadyZoneLabel() reads for Steady's HR Zone
   *  mode — see the constructor's own opts.hrProfile doc comment. Doesn't
   *  retroactively re-seed an already-composed name; only affects the
   *  next reseed trigger (same "push new value in, only used going
   *  forward" contract as setFtp() above). */
  setHrProfile(hrProfile) { this._hrProfile = hrProfile ?? { maxHr: null, restingHr: null }; }

  /**
   * Update a device's connection status. Safe to call whether or not this
   * flow is currently open — patches the dot/button in place if the
   * relevant row is on screen, no-ops otherwise.
   * @param {'controller'|'hrm'|'smo2'|'coreTemp'} kind
   * @param {'disconnected'|'connecting'|'connected'} status
   */
  setDeviceStatus(kind, status) {
    if (!(kind in this._deviceStatus)) return;
    this._deviceStatus[kind] = status;
    this._updateDeviceRow(kind);
  }

  _updateDeviceRow(kind) {
    patchDeviceTile(this._root, 'qs', kind, this._deviceStatus[kind]);   // a no-op if that tile isn't on screen
  }

  // ─── Draft state ────────────────────────────────────────────────────────

  _blankDraft() {
    return {
      targetStyle: 'free',          // 'free' | 'steady' | 'mapped' — see data/cardio-timelines.js's TARGET_STYLES
      equipment: DEFAULT_EQUIPMENT.value,   // see EQUIPMENT_TYPES
      location: DEFAULT_LOCATION,           // 'indoor' | 'outdoor' — EQUIPMENT_TYPES.supportsLocation only
      steadyMode: DEFAULT_STEADY_MODE.value,
      steadyValue: DEFAULT_STEADY_MODE.default,
      mappedPresetId: null,         // set when targetStyle === 'mapped'
      targetZone: null,             // last Target zone dropdown pick — see _zoneOptions()/_zoneMidpoint()
      // Whether the Target zone dropdown's option panel is currently
      // expanded — same "closed by default, collapses back down on pick"
      // idea as presetMenuOpen just below, and ui/strength-session-flow.js's
      // own sequenceMenuOpen.
      zoneMenuOpen: false,
      // Whether the Cardio Sequence dropdown's option panel is currently
      // expanded — same "closed by default, collapses back down on pick"
      // idea as ui/strength-session-flow.js's sequenceMenuOpen.
      presetMenuOpen: false,
      name: _composeName('free', _equipmentLabel(DEFAULT_EQUIPMENT.value, DEFAULT_LOCATION)),
      durationMin: DEFAULT_DURATION_MIN,
    };
  }

  /**
   * Recomposes d.name from the draft's current equipment/location/target
   * style/steady mode & value/preset — the single place every reseed
   * trigger in _bindBodyEvents() funnels through, so the three name
   * shapes (see _composeName()'s own doc comment) never drift between
   * call sites. No-ops (leaves d.name untouched) for Sequence before any
   * preset has resolved — mirrors the pre-refactor target-style handler's
   * own `if (preset) …` guard, since there's nothing sensible to seed
   * yet in that case.
   */
  _reseedName() {
    const d = this._draft;
    const equipLabel = _equipmentLabel(d.equipment, d.location);
    if (d.targetStyle === 'mapped') {
      const preset = timelinePresetById(d.mappedPresetId);
      if (!preset) return;
      d.name = _composeName('mapped', equipLabel, { presetLabel: preset.label });
    } else if (d.targetStyle === 'steady') {
      const mode = STEADY_MODES.find(m => m.value === d.steadyMode) ?? DEFAULT_STEADY_MODE;
      d.name = _composeName('steady', equipLabel, { zoneLabel: _steadyZoneLabel(mode, d.steadyValue, this._hrProfile) });
    } else {
      d.name = _composeName('free', equipLabel);
    }
    this._lastAutoName = d.name;
  }

  /**
   * Which zone list currently backs the Target zone dropdown (see that
   * block's own doc comment above _zoneMidpoint()) — Steady's HR Zone
   * sub-mode reads metrics/hr-zones.js's 5 zones (empty without a real
   * maxHr on file yet — see zonesForHr()); everything else (Steady's FTP
   * sub-mode, and every Sequence session) reads metrics/ftp-zones.js's 7,
   * fed a flat 100 "FTP" so the zone boundaries come back as plain
   * %-of-FTP numbers rather than real watts — matching how Steady's own
   * FTP value is already stored (see STEADY_MODES).
   */
  _zoneOptions() {
    const d = this._draft;
    if (d.targetStyle === 'steady') {
      const mode = STEADY_MODES.find(m => m.value === d.steadyMode) ?? DEFAULT_STEADY_MODE;
      if (mode.targetType === TARGET_TYPES.HEART_RATE) return zonesForHr(this._hrProfile);
    }
    return zonesForFtp(100);
  }

  _canStart() {
    const d = this._draft;
    if (d.targetStyle === 'mapped') return d.name.trim().length > 0 && !!d.mappedPresetId;
    return d.name.trim().length > 0 && (parseFloat(d.durationMin) || 0) > 0;
  }

  /** The Cancel button: the same as any other way the rider backs out (onCancel runs from onClose). */
  _cancel() {
    this._userClosing = true;
    this.close();
  }

  _start() {
    if (!this._canStart()) return;
    const settings = {
      targetStyle:    this._draft.targetStyle,
      equipment:      this._draft.equipment,
      location:       this._draft.location,
      steadyMode:     this._draft.steadyMode,
      steadyValue:    this._draft.steadyValue,
      mappedPresetId: this._draft.mappedPresetId,
      name:           this._draft.name.trim(),
      durationMin:    parseFloat(this._draft.durationMin) || DEFAULT_DURATION_MIN,
    };
    const model = buildQuickStartWorkout(settings);
    this.close();
    this._onStart?.(model, settings);
  }

  /** Sequence's "Open in Advanced Builder…" action — closes the flow the
   *  same way _start() does, but hands the currently selected preset to
   *  onEditPreset instead of building/starting anything here. */
  _editPreset() {
    const preset = timelinePresetById(this._draft.mappedPresetId);
    if (!preset) return;
    this.close();
    this._onEditPreset?.(preset);
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  /** Content for the sheet's body (built each time the sheet opens). */
  _build(host) {
    host.innerHTML = `
      <div class="ds-flow">
        <div class="ds-flow-body" id="qs-body"></div>
        <div class="ds-flow-foot">
          <button class="btn btn-ghost" id="qs-cancel">Cancel</button>
          <button class="btn btn-glass-cta" id="qs-finish">Start Workout</button>
        </div>
      </div>
    `;
    this._root = host.querySelector('.ds-flow');

    this._root.querySelector('#qs-cancel').addEventListener('click', () => this._cancel());
    this._root.querySelector('#qs-finish').addEventListener('click', () => this._start());

    this._refresh();
  }

  _refresh() {
    if (!this._root) return;
    this._renderBody();
    this._renderFoot();
  }

  _renderFoot() {
    const finishBtn = this._root.querySelector('#qs-finish');
    if (finishBtn) finishBtn.disabled = !this._canStart();
  }

  /** One device tile: the whole tile is the Connect button, with a status ring around its icon. */
  _deviceRowHtml(kind, label) {
    return deviceTileHtml({ prefix: 'qs', kind, label, icon: DEVICE_ICONS[kind], status: this._deviceStatus[kind] });
  }

  /** The Target zone control — a dropdown matching the Cardio Sequence
   *  picker's own .sf-sequence-dropdown/-trigger/-panel shape (see
   *  _presetPickerHtml()) rather than a wrapping row of small buttons:
   *  .sf-zone-trigger is the always-visible collapsed row (the current
   *  pick's name, color-coded to match via the same left-border
   *  convention .zone-chip elsewhere in the app already uses, or a plain
   *  placeholder before one's made); tapping it reveals .sf-zone-panel,
   *  which lists every zone from _zoneOptions() one per line — each row
   *  carrying its own left-border color too, so the coding reads the
   *  same whether the dropdown's open or collapsed. Skipped entirely
   *  when that list comes back empty (Steady's HR Zone sub-mode with no
   *  maxHr on file yet — same "nothing sensible to show" case
   *  _steadyZoneLabel() already handles for the Workout name's own zone
   *  segment). Tapping a row is a shortcut, not a lock — see
   *  _bindBodyEvents()'s [data-target-zone] handler for what it
   *  actually does for Steady vs. Sequence. */
  _zoneDropdownHtml() {
    const d = this._draft;
    const zones = this._zoneOptions();
    if (zones.length === 0) return '';
    return `
      <div class="sf-field">
        <span>Target zone</span>
        <div class="sf-zone-dropdown${d.zoneMenuOpen ? ' open' : ''}">
          ${this._zoneTriggerHtml(zones)}
          ${d.zoneMenuOpen ? this._zonePanelHtml(zones) : ''}
        </div>
      </div>
    `;
  }

  /** The always-visible collapsed row — either the picked zone's name +
   *  its %-based range (color-coded via the same left border every row
   *  in the panel below uses) or, before anything's picked, a plain
   *  placeholder. Toggles .sf-zone-panel open/closed on click — same
   *  contract as _presetTriggerHtml(). */
  _zoneTriggerHtml(zones) {
    const d = this._draft;
    const zone = zones.find(z => z.zone === d.targetZone) ?? null;
    return `
      <button type="button" class="sf-zone-trigger" id="qs-zone-trigger"
        style="${zone ? `border-left: 3px solid ${zone.color}` : ''}"
        aria-haspopup="listbox" aria-expanded="${d.zoneMenuOpen ? 'true' : 'false'}">
        ${zone ? `
          <span class="sf-zone-trigger-label">${_esc(zone.name)}</span>
          <span class="sf-zone-trigger-range">${_esc(zone.label)}</span>
        ` : `
          <span class="sf-zone-trigger-placeholder">Choose a target zone…</span>
        `}
        <svg class="btn-icon sf-sequence-trigger-chevron" viewBox="0 0 24 24"><use href="#icon-chevron-${d.zoneMenuOpen ? 'up' : 'down'}"/></svg>
      </button>
    `;
  }

  /** The expanded option list — every zone from _zoneOptions(), one per
   *  row instead of wrapped horizontally, each still color-coded via its
   *  own left border (same inline-color convention the old .sf-zone-btn
   *  row used, and .zone-chip elsewhere in the app still does) — just
   *  with room now for the zone's %-based range alongside its name,
   *  instead of that range being a hover-only title tooltip. */
  _zonePanelHtml(zones) {
    const d = this._draft;
    return `
      <div class="sf-zone-panel" role="listbox" aria-label="Target zone">
        ${zones.map(z => `
          <button type="button" class="sf-zone-item${d.targetZone === z.zone ? ' selected' : ''}"
            style="border-left: 3px solid ${z.color}" role="option" aria-selected="${d.targetZone === z.zone}"
            data-target-zone="${z.zone}">
            <span class="sf-zone-item-name">${_esc(z.name)}</span>
            <span class="sf-zone-item-range">${_esc(z.label)}</span>
          </button>`).join('')}
      </div>
    `;
  }

  _renderBody() {
    const body = this._root.querySelector('#qs-body');
    const d = this._draft;
    const isMapped = d.targetStyle === 'mapped';
    const isSteady = d.targetStyle === 'steady';
    const equipment = EQUIPMENT_TYPES.find(e => e.value === d.equipment) ?? DEFAULT_EQUIPMENT;
    const steadyMode = STEADY_MODES.find(m => m.value === d.steadyMode) ?? DEFAULT_STEADY_MODE;
    body.innerHTML = `
      <label class="sf-field">
        <span>Activity</span>
        <select class="input full-width" id="qs-equipment">
          ${EQUIPMENT_TYPES.map(eq => `
            <option value="${eq.value}" ${d.equipment === eq.value ? 'selected' : ''} title="${_esc(eq.blurb)}">${_esc(eq.label)}</option>`).join('')}
        </select>
      </label>

      ${equipment.supportsLocation ? `
        <div class="sf-field">
          <span>Location</span>
          ${tileGroupHtml(LOCATIONS.map(l => ({ ...l, icon: LOCATION_ICONS[l.value] })), { attr: 'data-location', selected: d.location })}
        </div>
      ` : ''}

      <div class="sf-field">
        <span>Target style</span>
        ${tileGroupHtml(TARGET_STYLES.map(s => ({ ...s, icon: TARGET_STYLE_ICONS[s.value] })), { attr: 'data-target-style', selected: d.targetStyle })}
      </div>

      ${(isMapped || isSteady) ? this._zoneDropdownHtml() : ''}

      ${isMapped ? `
        <div class="sf-field">
          <span>Cardio Sequence</span>
          <div id="qs-timeline-section">${this._presetPickerHtml()}</div>
        </div>
      ` : isSteady ? `
        <div class="sf-field">
          <span>Steady target</span>
          ${tileGroupHtml(STEADY_MODES.map(m => ({ ...m, icon: STEADY_MODE_ICONS[m.value] })), { attr: 'data-steady-mode', selected: d.steadyMode })}
        </div>
        <label class="sf-field">
          <span>Target (${_esc(steadyMode.unit)})</span>
          <input type="number" class="input full-width" id="qs-steady-value"
            min="${steadyMode.min}" max="${steadyMode.max}" step="${steadyMode.step}" value="${d.steadyValue}" />
        </label>
      ` : ''}

      <label class="sf-field">
        <span>Workout name</span>
        <input class="input full-width" id="qs-name" placeholder="e.g. Evening Spin" value="${_esc(d.name)}" autofocus />
      </label>
      <div class="sf-field">
        <span>Equipment</span>
        <div class="sf-device-grid">
          ${this._deviceRowHtml('controller', 'Controller')}
          ${this._deviceRowHtml('hrm', 'Heart Rate Monitor')}
          ${this._deviceRowHtml('smo2', 'SmO₂ Sensor')}
          ${this._deviceRowHtml('coreTemp', 'Core Temp Sensor')}
        </div>
      </div>
      ${!isMapped ? `
        <label class="sf-field">
          <span>Length of time (minutes)</span>
          <input type="number" class="input full-width" id="qs-duration" min="1" max="300" step="1" value="${d.durationMin}" />
        </label>
      ` : ''}
    `;
    this._bindBodyEvents();
  }

  // Cardio Sequence picker (Sequence target style only) — same
  // .sf-sequence-dropdown/-trigger/-panel/-card shape
  // ui/strength-session-flow.js's Resistance Sequence step uses, rather than
  // a plain <select>: .sf-sequence-trigger is the
  // always-visible collapsed row (current pick, or a placeholder before
  // one's made); tapping it reveals .sf-sequence-panel, which lists every
  // preset in full card form, one per row — icon-free (unlike a Resistance
  // Sequence card, a cardio preset has no SEQUENCE_ICONS-style templateId
  // to pick one from), but each still carrying its own shape preview
  // (_timelinePreviewSvg()), a duration/Custom pill, and its tagline
  // behind an info tap, the same per-card detail a Resistance Sequence
  // card shows. Cards are grouped under a plain heading per data/cardio-
  // timelines.js TIMELINE_GROUP_ORDER entry, with a rider's own saved
  // presets in a trailing "Custom" group (every preset.custom === true
  // entry, regardless of its own — nonexistent — `group` field; see that
  // file's own TIMELINE_GROUPS doc comment) — see _groupPresetsByOutput().
  // There's still no "+ Create Your Own" card here — Sequence's
  // equivalent of "build your own" is the "Open in Advanced Builder…"
  // action beneath the dropdown, since a timeline preset is built from
  // the full step editor, not a lighter in-flow builder.
  _presetPickerHtml() {
    const d = this._draft;
    return `
      <div class="sf-sequence-dropdown${d.presetMenuOpen ? ' open' : ''}">
        ${this._presetTriggerHtml()}
        ${d.presetMenuOpen ? this._presetPanelHtml() : ''}
      </div>
      ${d.mappedPresetId ? `
        <button type="button" class="btn btn-ghost btn-sm sf-timeline-edit-btn" id="qs-edit-preset">
          <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-pencil"/></svg>
          <span class="btn-label">Advanced Builder</span>
        </button>
      ` : ''}
    `;
  }

  /** The always-visible collapsed row — either a compact summary of the
   *  currently picked preset (label + duration pill) or, before anything's
   *  picked, a plain placeholder. Toggles .sf-sequence-panel open/closed
   *  on click — same contract as ui/strength-session-flow.js's own
   *  _sequenceTriggerHtml(). */
  _presetTriggerHtml() {
    const d = this._draft;
    const preset = timelinePresetById(d.mappedPresetId);
    return `
      <button type="button" class="sf-sequence-trigger" id="qs-preset-trigger"
        aria-haspopup="listbox" aria-expanded="${d.presetMenuOpen ? 'true' : 'false'}">
        ${preset ? `
          <span class="sf-sequence-trigger-label">${_esc(preset.label)}</span>
          <span class="sf-sequence-card-scheme sf-sequence-trigger-scheme">${Math.round(preset.durationMin)} min</span>
        ` : `
          <span class="sf-sequence-trigger-placeholder">Choose a cardio sequence…</span>
        `}
        <svg class="btn-icon sf-sequence-trigger-chevron" viewBox="0 0 24 24"><use href="#icon-chevron-${d.presetMenuOpen ? 'up' : 'down'}"/></svg>
      </button>
    `;
  }

  /** The expanded option list — every bundled + custom preset, grouped
   *  under a plain text heading per TIMELINE_GROUP_ORDER entry (+ a
   *  trailing "Custom" group), in the same full card form
   *  ui/strength-session-flow.js's own sequence panel uses. Stacked one per
   *  row, same as that panel. */
  _presetPanelHtml() {
    const d = this._draft;
    // A Target zone tap narrows this down to exactly one TIMELINE_GROUPS
    // entry's four duration presets (see FTP_ZONE_TO_TIMELINE_GROUP's own
    // doc comment) — custom presets are excluded whenever a zone filter
    // is active since they carry no `group` of their own to match against
    // (see data/cardio-timelines.js's TimelinePreset shape comment), and
    // leaving them in would break the "only four" promise the filter
    // exists to keep.
    const presets = d.targetZone != null
      ? allTimelinePresets().filter(p => !p.custom && p.group === FTP_ZONE_TO_TIMELINE_GROUP[d.targetZone])
      : allTimelinePresets();
    const groups = _groupPresetsByOutput(presets);
    return `
      <div class="sf-sequence-panel" role="listbox" aria-label="Cardio sequence">
        ${groups.map(({ label, presets }) => `
          <div class="sf-sequence-group-label">${_esc(label)}</div>
          ${presets.map(preset => this._presetCardHtml(preset, d)).join('')}
        `).join('')}
      </div>
    `;
  }

  /** One preset's full card — label + info-tap tagline in the header row,
   *  a duration pill (+ "Custom" chip for a rider-saved preset) below
   *  that, then its own shape preview strip (_timelinePreviewSvg()) —
   *  the same per-card layout ui/strength-session-flow.js's own
   *  _sequencePanelHtml() gives each Resistance Sequence card, just
   *  without an icon (a cardio preset has no SEQUENCE_ICONS-style
   *  templateId to pick one from) and with a shape preview standing in
   *  for that card's exercise chips. */
  _presetCardHtml(preset, d) {
    return `
      <button type="button" class="sf-sequence-card${d.mappedPresetId === preset.id ? ' selected' : ''}" role="option" aria-selected="${d.mappedPresetId === preset.id}" data-preset-id="${preset.id}">
        <div class="sf-sequence-card-head">
          <span class="sf-sequence-card-label">${_esc(preset.label)}</span>
          <span class="sf-sequence-card-info" role="button" tabindex="0"
            aria-label="About ${_esc(preset.label)}" data-tip="${_esc(preset.tagline)}">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg>
          </span>
        </div>
        <div class="sf-sequence-card-meta">
          <span class="sf-sequence-card-scheme">${Math.round(preset.durationMin)} min</span>
          ${preset.custom ? '<span class="sf-sequence-card-chip">Custom</span>' : ''}
        </div>
        ${_timelinePreviewSvg(preset)}
      </button>
    `;
  }

  _bindBodyEvents() {
    const $$ = sel => this._root.querySelector(sel);
    const d  = this._draft;

    $$('#qs-equipment')?.addEventListener('change', e => {
      const eq = EQUIPMENT_TYPES.find(eqType => eqType.value === e.target.value) ?? DEFAULT_EQUIPMENT;
      d.equipment = eq.value;
      // Equipment that can't go both ways always resets to the one
      // location that actually applies to it — same "never land on a
      // choice that doesn't apply" convention as DEFAULT_EQUIPMENT
      // itself (see EQUIPMENT_TYPES' own doc comment) — so switching
      // e.g. Cycling→Treadmill can't leave a stale "Outdoor" pick
      // silently baked into the name once Location's toggle disappears.
      if (!eq.supportsLocation) d.location = DEFAULT_LOCATION;
      this._reseedName();
      this._renderBody();
      this._renderFoot();
    });

    this._root.querySelectorAll('[data-location]').forEach(btn => {
      btn.addEventListener('click', () => {
        d.location = btn.dataset.location;
        this._reseedName();
        this._renderBody();
        this._renderFoot();
      });
    });

    this._root.querySelectorAll('[data-target-style]').forEach(btn => {
      btn.addEventListener('click', () => {
        d.targetStyle = btn.dataset.targetStyle;
        // A previous Target zone pick doesn't carry meaning across a style
        // switch (Free has no zone dropdown at all, and Steady vs.
        // Sequence can back it with entirely different zone lists — see
        // _zoneOptions()) — reset it the same "don't leave a stale pick
        // silently baked in" way d.location resets on an equipment switch
        // above. The dropdown's own open/closed state gets the same
        // reset, so a switch away from and back to Steady/Sequence never
        // resurfaces a panel the rider never reopened themselves.
        d.targetZone = null;
        d.zoneMenuOpen = false;
        // Re-seed the name the same way for every style — it stays a
        // simple "pick style → tweak" path, and the name remains editable
        // afterward regardless of which style seeded it (see
        // _composeName()'s own doc comment).
        if (d.targetStyle === 'mapped') {
          // Seed with a real, selectable preset the moment Sequence is
          // picked — same "never land on an empty, unstartable choice"
          // convention applies to Steady's mode/value below — rather
          // than opening on a dropdown with nothing selected.
          const preset = timelinePresetById(d.mappedPresetId) ?? allTimelinePresets()[0] ?? null;
          d.mappedPresetId = preset?.id ?? null;
          d.presetMenuOpen = false;
        } else if (d.targetStyle === 'steady') {
          const mode = STEADY_MODES.find(m => m.value === d.steadyMode) ?? DEFAULT_STEADY_MODE;
          d.steadyMode = mode.value;
        }
        this._reseedName();
        this._renderBody();
        this._renderFoot();
      });
    });

    this._root.querySelectorAll('[data-steady-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = STEADY_MODES.find(m => m.value === btn.dataset.steadyMode) ?? DEFAULT_STEADY_MODE;
        d.steadyMode = mode.value;
        d.steadyValue = mode.default;
        // Switching basis changes which zone list backs the Target zone
        // dropdown (HR Zone reads hr-zones.js's 5, FTP reads ftp-
        // zones.js's 7 — see _zoneOptions()), so a previously-picked zone
        // number can't be trusted to still mean the same thing; its
        // dropdown resets closed for the same reason the target-style
        // handler above closes it on a style switch.
        d.targetZone = null;
        d.zoneMenuOpen = false;
        // Re-seed the name the same way the target-style toggle does —
        // switching basis mid-flow is still "pick → tweak", not a locked
        // choice (see _composeName()'s own doc comment).
        this._reseedName();
        this._renderBody();
        this._renderFoot();
      });
    });

    // Target zone dropdown trigger (see _zoneDropdownHtml()/
    // _zoneTriggerHtml()) — same open/close-on-click contract as
    // #qs-preset-trigger below.
    $$('#qs-zone-trigger')?.addEventListener('click', () => {
      d.zoneMenuOpen = !d.zoneMenuOpen;
      this._renderBody();
      this._renderFoot();
    });

    // Target zone dropdown's option rows (see _zonePanelHtml()) — a
    // shortcut, not a lock: Steady gets its numeric Target field
    // autofilled to the zone's midpoint (_zoneMidpoint()) and stays
    // freely editable afterward, same as every other seeded value in
    // this flow; Sequence gets its Cardio Sequence panel filtered down
    // to the one matching TIMELINE_GROUPS entry (FTP_ZONE_TO_TIMELINE_GROUP)
    // — always exactly four duration presets — re-picking the currently
    // selected preset only if it still belongs to that group, same
    // "never land on an empty, unstartable choice" convention the
    // target-style/steady-mode handlers above already follow. Picking a
    // row also collapses the dropdown back down, same as picking a card
    // does for #qs-preset-trigger's own panel below.
    this._root.querySelectorAll('[data-target-zone]').forEach(btn => {
      btn.addEventListener('click', () => {
        const zoneNum = parseInt(btn.dataset.targetZone, 10);
        const zone = this._zoneOptions().find(z => z.zone === zoneNum);
        if (!zone) return;
        d.targetZone = zoneNum;
        d.zoneMenuOpen = false;
        if (d.targetStyle === 'mapped') {
          const group = FTP_ZONE_TO_TIMELINE_GROUP[zoneNum];
          const matching = allTimelinePresets().filter(p => !p.custom && p.group === group);
          if (!matching.some(p => p.id === d.mappedPresetId)) {
            d.mappedPresetId = matching[0]?.id ?? null;
          }
        } else if (d.targetStyle === 'steady') {
          const mode = STEADY_MODES.find(m => m.value === d.steadyMode) ?? DEFAULT_STEADY_MODE;
          d.steadyValue = _zoneMidpoint(zone, mode);
        }
        this._reseedName();
        this._renderBody();
        this._renderFoot();
      });
    });
    $$('#qs-steady-value')?.addEventListener('input', e => {
      d.steadyValue = e.target.value;
      // Keep the "{Target zone}" segment of the default name fresh as the
      // rider dials in their target — but only while the name still
      // matches what we last auto-composed. Unlike the discrete pickers
      // above (a whole new style/mode/equipment is a big, rare move that
      // always earns a fresh name), this fires on every keystroke, so it
      // shouldn't stomp a name the rider has already typed themselves —
      // just patch the input in place rather than a full _renderBody(),
      // which would also drop focus out of this field mid-type.
      if (d.name === this._lastAutoName) {
        this._reseedName();
        const nameInput = $$('#qs-name');
        if (nameInput) nameInput.value = d.name;
      }
      this._renderFoot();
    });

    $$('#qs-preset-trigger')?.addEventListener('click', () => {
      d.presetMenuOpen = !d.presetMenuOpen;
      this._renderBody();
      this._renderFoot();
    });

    this._root.querySelectorAll('[data-preset-id]').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('[data-tip]')) return; // info-tap tagline, not a selection
        const preset = timelinePresetById(card.dataset.presetId);
        if (!preset) return;
        d.mappedPresetId = preset.id;
        d.presetMenuOpen = false;
        this._reseedName();
        this._renderBody();
        this._renderFoot();
      });
    });

    // The info-tap tagline is a <span role="button">, not a real <button>
    // (it already sits inside the preset card's own <button> — see
    // _presetCardHtml()), so Enter/Space need a manual nudge into a real
    // click for ux/info-tooltip.js's delegated handler (and the guard
    // just above) to see — same convention ui/strength-session-flow.js's
    // own sequence cards use for their info-tap/"+N more" chips.
    this._root.querySelectorAll('[data-tip][role="button"]').forEach(chip => {
      chip.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        chip.click();
      });
    });

    $$('#qs-edit-preset')?.addEventListener('click', () => this._editPreset());
    $$('#qs-name')?.addEventListener('input', e => {
      d.name = e.target.value;
      this._renderFoot();
    });
    $$('#qs-duration')?.addEventListener('input', e => {
      d.durationMin = e.target.value;
      this._renderFoot();
    });
    $$('#qs-connect-controller')?.addEventListener('click', () => {
      if (this._deviceStatus.controller !== 'disconnected') return;
      this._onConnectController?.();
    });
    $$('#qs-connect-hrm')?.addEventListener('click', () => {
      if (this._deviceStatus.hrm !== 'disconnected') return;
      this._onConnectHrm?.();
    });
    $$('#qs-connect-smo2')?.addEventListener('click', () => {
      if (this._deviceStatus.smo2 !== 'disconnected') return;
      this._onConnectSmo2?.();
    });
    $$('#qs-connect-coreTemp')?.addEventListener('click', () => {
      if (this._deviceStatus.coreTemp !== 'disconnected') return;
      this._onConnectCoreTemp?.();
    });
  }
}

// Small shape-preview SVG rendered on each preset's own card by
// _presetCardHtml() above — see data/cardio-timelines.js's TimelinePreset
// comment. Same "flatten, scale by duration and target value, fill one
// shape per step" approach as editor/workout-editor.js's own live canvas
// preview (_renderPreview()) — just built as a static SVG string instead
// of a canvas draw loop, since this renders once per card rather than
// needing a live redraw the way the editor's own in-progress preview
// does. Colors come from metrics/ftp-zones.js's zonesForFtp() palette
// instead of that editor's per-step-type STEP_COLORS — the same zone
// colors the Target zone dropdown's own rows use (see _zonePanelHtml()),
// so a preset's shape reads as "which intensity, when" rather than
// "which kind of step, when": a flat step's whole block gets its target's
// own zone color (see _zoneColor()); a RAMP step (warm-up/cool-down)
// gets sampled into thin adjacent bands, each colored by its own local
// zone, so the ramp visibly shifts color as it crosses zone boundaries
// instead of averaging into one less-informative color. STEP_COLORS is
// kept only as a fallback for a non-POWER step, which no preset actually
// produces today (see this file's own module doc comment — Sequence's
// presets are all POWER-based) but costs nothing to guard against.
const TIMELINE_PREVIEW_W = 200;
const TIMELINE_PREVIEW_H = 32;

// A target fraction (e.g. 0.7 for 70% FTP) → that fraction's zone color,
// via the same fed-a-flat-100-FTP convention _zoneOptions() above uses so
// zone boundaries come back as plain %-of-FTP numbers rather than needing
// the rider's real FTP at all.
function _zoneColor(ftpFraction) {
  return zoneForPower(Math.max(0, ftpFraction) * 100, 100)?.color ?? '#888';
}

function _timelinePreviewSvg(preset) {
  const flat = (preset?.steps ?? []).flatMap(flattenStep);
  if (flat.length === 0) {
    return `<svg class="sf-sequence-card-preview" viewBox="0 0 ${TIMELINE_PREVIEW_W} ${TIMELINE_PREVIEW_H}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  }

  const durTotal = flat.reduce((a, s) => a + (s.duration ?? 0), 0) || 1;
  const maxPow = Math.max(...flat.map(s => {
    if (s.targetType !== TARGET_TYPES.POWER) return 0;
    return Math.max(s.targetLow ?? 0, s.targetHigh ?? 0);
  }), 0.5);

  let x = 0;
  const polys = [];
  for (const step of flat) {
    const w = ((step.duration ?? 0) / durTotal) * TIMELINE_PREVIEW_W;
    const isRamp = step.type === STEP_TYPES.RAMP
      && step.targetType === TARGET_TYPES.POWER
      && step.targetHigh != null
      && step.targetHigh !== step.targetLow;

    if (isRamp) {
      // Sample the ramp into thin adjacent bands instead of one flat
      // trapezoid, so its color shifts band-by-band across whichever
      // zones it actually crosses — same eased-curve sampling this used
      // to reserve for shaping a parabolic ramp's outline only (see the
      // editor's own _renderPreview(), which does the same thing on a
      // canvas; curveProgress() already no-ops to a straight line for a
      // 'linear' ramp's own curve), just generalized to every ramp
      // regardless of curve, and now driving each band's fill as well as
      // its shape.
      const SAMPLES = 10;
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = i / SAMPLES;
        const t1 = (i + 1) / SAMPLES;
        const v0 = step.targetLow + (step.targetHigh - step.targetLow) * curveProgress(t0, step.curve);
        const v1 = step.targetLow + (step.targetHigh - step.targetLow) * curveProgress(t1, step.curve);
        const x0 = x + t0 * w;
        const x1 = x + t1 * w;
        const y0 = TIMELINE_PREVIEW_H - (v0 / maxPow) * (TIMELINE_PREVIEW_H - 4) - 2;
        const y1 = TIMELINE_PREVIEW_H - (v1 / maxPow) * (TIMELINE_PREVIEW_H - 4) - 2;
        const color = _zoneColor((v0 + v1) / 2);
        const points = [
          `${x0.toFixed(1)},${TIMELINE_PREVIEW_H}`,
          `${x0.toFixed(1)},${y0.toFixed(1)}`,
          `${x1.toFixed(1)},${y1.toFixed(1)}`,
          `${x1.toFixed(1)},${TIMELINE_PREVIEW_H}`,
        ];
        polys.push(`<polygon points="${points.join(' ')}" fill="${color}" fill-opacity="0.85" />`);
      }
    } else {
      const lo = step.targetType === TARGET_TYPES.POWER ? (step.targetLow  ?? 0) / maxPow : 0.3;
      const hi = step.targetType === TARGET_TYPES.POWER ? (step.targetHigh ?? step.targetLow ?? 0) / maxPow : lo;
      const color = step.targetType === TARGET_TYPES.POWER
        ? _zoneColor(((step.targetLow ?? 0) + (step.targetHigh ?? step.targetLow ?? 0)) / 2)
        : (STEP_COLORS[step.type] ?? '#888');

      const points = [`${x.toFixed(1)},${TIMELINE_PREVIEW_H}`];
      points.push(`${x.toFixed(1)},${(TIMELINE_PREVIEW_H - lo * (TIMELINE_PREVIEW_H - 4) - 2).toFixed(1)}`);
      points.push(`${(x + w).toFixed(1)},${(TIMELINE_PREVIEW_H - hi * (TIMELINE_PREVIEW_H - 4) - 2).toFixed(1)}`);
      points.push(`${(x + w).toFixed(1)},${TIMELINE_PREVIEW_H}`);

      polys.push(`<polygon points="${points.join(' ')}" fill="${color}" fill-opacity="0.85" />`);
    }
    x += w;
  }

  return `<svg class="sf-sequence-card-preview" viewBox="0 0 ${TIMELINE_PREVIEW_W} ${TIMELINE_PREVIEW_H}" preserveAspectRatio="none" aria-hidden="true">${polys.join('')}</svg>`;
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Buckets presets into the Cardio Sequence panel's group-label sections
// (_presetPanelHtml() above) — bundled presets by their own `group`
// field, walked in TIMELINE_GROUP_ORDER so the sections always land in
// the same order the bundled presets themselves are organized into (see
// cardio-timelines.js's own TIMELINE_GROUPS doc comment), then every
// rider-saved preset.custom === true entry together in one trailing
// "Custom" group regardless of what training effect it actually has —
// customs carry no `group` of their own to sort by (same file, same
// comment). Groups with no presets are dropped rather than rendered as
// an empty section — only reachable today if every preset of some
// output category were somehow removed from BUILTIN_TIMELINE_PRESETS,
// since Custom only appears once a rider has actually saved one.
function _groupPresetsByOutput(presets) {
  const groups = TIMELINE_GROUP_ORDER
    .map(group => ({ label: group, presets: presets.filter(p => !p.custom && p.group === group) }))
    .filter(g => g.presets.length > 0);
  const custom = presets.filter(p => p.custom);
  if (custom.length > 0) groups.push({ label: 'Custom', presets: custom });
  return groups;
}
