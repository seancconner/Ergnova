// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * src/app.js  (v3 — full Phases 0–4)
 *
 * Wires every module: BLE, control modes, recording, scripted playback,
 * workout editor, history browser, metrics, UX polish, settings.
 */

import { FtmsDevice }           from './ble/ftms-device.js';
import { HrDevice }             from './ble/hr-device.js';
import { MoxyDevice }           from './ble/moxy.js';
import { CoreTempDevice }       from './ble/core-temp.js';
import { MerachDevice, MERACH_NAME_PREFIX } from './ble/merach-device.js';
import { Proform750rDevice, PROFORM_NAME_PREFIX, PROFORM_SERVICE } from './ble/proform-device.js';
import { FTMS_SERVICE }         from './ble/ftms-constants.js';
import { ScaleDevice }          from './ble/scale-device.js';
import { FitdaysScaleDevice }   from './ble/fitdays-device.js';
import { BODY_COMPOSITION_SERVICE, WEIGHT_SCALE_SERVICE, FITDAYS_SERVICE, FITDAYS_NAME_PREFIX }
                                 from './ble/scale-constants.js';
import { bleTransport }         from './ble/transport/index.js';
import { createBodyMeasurement, MEASUREMENT_SOURCES, deriveLeanBodyMassKg }
                                 from './core/nutrition-model.js';
import { roles, ROLES }         from './ble/roles.js';
import { deviceManager }        from './ble/device-manager.js';
import { priority }             from './ble/priority.js';
import { pairingMode, PAIRING_MODES } from './ble/pairing-mode.js';
import { ModeSwitch, MODES }    from './control/mode-switch.js';
import { capabilities, METRICS } from './core/capabilities.js';
import { reconnect }            from './ble/reconnect.js';
import { reconnectCushion }     from './ble/reconnect-cushion.js';
import { db }                   from './storage/db.js';
import { createProfileBackupFlow } from './storage/profile-backup-flow.js';
import { Session }              from './recording/session.js';
import { ScriptedSession }      from './playback/scripted-session.js';
import { SetTracker }           from './recording/set-tracker.js';
import { persistActiveWorkout, loadActiveWorkout, clearActiveWorkout,
         persistActiveStrengthWorkout, loadActiveStrengthWorkout, clearActiveStrengthWorkout }
                                 from './recording/session-persistence.js';
import { renderDownloadControl } from './recording/activity-formats.js';
import { CHART_COLORS }        from './charts/chart-engine.js';
import { themeColor }          from './charts/chart-theme.js';
import { ChartCarousel }       from './charts/chart-carousel.js';
import { CHART_METRIC_ORDER }  from './charts/chart-order.js';
import { DeviceRow } from './ui/device-row.js';
import { ChartBadgeBar }       from './ui/chart-badge-bar.js';
import { badgeMetricKeys, latestSample } from './ui/chart-badge-logic.js';
import { drawTimeline, levelOf, dotMotion, placeTimelineDot } from './ui/hud-timeline.js';
import { HistoryBrowser }       from './views/history-browser.js';
import { detailSheet }          from './ui/detail-sheet.js';
import { OverviewPage }         from './views/overview.js';
import { DietPage }             from './views/diet.js';
import { StrengthSessionPanel } from './views/strength-session.js';
import { WorkoutEditor, STEP_COLORS } from './editor/workout-editor.js';
import { TARGET_TYPES, STEP_TYPES, totalDuration } from './core/cardio-model.js';
import { recentExerciseNames }  from './core/strength-model.js';
import { loadCustomExercises }  from './data/exercises.js';
import { loadCustomTimelinePresets, addCustomTimelinePreset, buildTimelineWorkout, allTimelinePresets, timelinePresetById } from './data/cardio-timelines.js';
import { ExerciseEditor }       from './ui/exercise-editor.js';
import { CardioSessionFlow, buildQuickStartWorkout } from './ui/cardio-session-flow.js';
import { StrengthSessionFlow } from './ui/strength-session-flow.js';
import { BleDebugFlow }         from './ui/ble-debug-flow.js';
import { IngredientEditor }     from './ui/ingredient-editor.js';
import { RecipeEditor }         from './ui/recipe-editor.js';
import { RecipePrintSheet }     from './ui/recipe-print.js';
import { WeighInManager }       from './ui/weigh-in-manager.js';
import { CardioZoneReferenceSheet } from './ui/cardio-zone-reference.js';
import { MasterDetailRail } from './ui/master-detail.js';
import { CalibrationFlow }      from './control/calibration.js';
import { KeyboardController }   from './ux/keyboard.js';
import { wakeLock }             from './ux/wake-lock.js';
import { backgroundSession }    from './platform/background-session.js';
import { buildCardioSnapshot, buildStrengthSnapshot } from './platform/background-snapshot.js';
import { saveFile }             from './platform/save-file.js';
import { pickTextFile }         from './platform/pick-file.js';
import { audioCues }            from './ux/audio-cues.js';
import { infoTooltips }         from './ux/info-tooltip.js';
import { fitText }              from './ux/fit-text.js';
import { fullscreenUX }         from './ux/fullscreen.js';
import { computeMetrics }       from './metrics/normalized-power.js';
import { timeInZones, zonesForFtp, zoneForPower, resolveFtp } from './metrics/ftp-zones.js';
import { estimateMaxHr, zonesForHr, zoneForHr }    from './metrics/hr-zones.js';
import { TEST_TYPE as VO2MAX_TEST_TYPE, buildRampTestWorkout, estimatePeakPowerOutput, estimateVo2Max }
                                 from './metrics/vo2max.js';
import { TEST_TYPE_RAMP as FTP_RAMP_TEST_TYPE, TEST_TYPE_TWENTY as FTP_TWENTY_TEST_TYPE,
         buildFtpRampTestWorkout, estimateFtpFromRamp,
         buildFtpTwentyMinTestWorkout, estimateFtpFromTwentyMin }
                                 from './metrics/ftp-test.js';
import { TEST_TYPE as RESTING_HR_TEST_TYPE, buildRestingHrTestWorkout, estimateRestingHr }
                                 from './metrics/hr-test.js';
import { kmhToDisplaySpeed, speedUnitLabel, formatDistance, formatPace, kgToLb, lbToKg, weightUnitLabel,
         cmToIn, inToCm, heightUnitLabel }
                                 from './metrics/units.js';
import { flagWeighIns }         from './metrics/weigh-in-review.js';
import { OVERVIEW_SESSION_CARDS } from './metrics/overview-cards.js';

// Register all formats so the editor's import/export work
import './formats/zwo.js';
import './formats/erg-mrc.js';
import './formats/fit-workout.js';
import './formats/pwx.js';
import './formats/tcx.js';
// gpx.js is registered too — it parses to a RouteModel (GPS route), not a
// WorkoutModel, so it's intentionally left off the workout editor's
// import/export UI below until a route-session player consumes it.
import './formats/gpx.js';

// Dev-only console access to otherwise module-scoped singletons/state — ES
// modules don't leak imports onto `window`, so `capabilities.snapshot()`
// typed directly into devtools throws ReferenceError regardless of whether
// capabilities are actually populated correctly. This gives a real way to
// inspect them. `capabilities`/`roles` are singletons (safe to expose
// directly); the rest are reassigned `let` bindings, so exposed as getters
// so they don't go stale. Stripped from production builds by Vite since
// import.meta.env.DEV is false there.
if (import.meta.env.DEV) {
  window.__debug = {
    capabilities, roles,
    modeSwitch:    () => modeSwitch,
    trainer:       () => trainer,
    session:       () => session,
    strengthSession: () => strengthSession,
    chartCarousel: () => chartCarousel,
    // Live cardio chart's device row (scripts/browser-checks/device-row.py): the row itself, the status
    // plumbing every real connect/disconnect goes through, and the sensor map startSession() reads.
    deviceRow:     () => deviceRow,
    setDeviceStatus: (kind, status) => _setDeviceStatus(kind, status),
    auxSensors:    () => auxSensors,
    // Lets a headless check stand in for a connected trainer: startSession() builds a ScriptedSession
    // only when a modeSwitch exists, and there is no Bluetooth in the browser scripts (live-scripted-hud.py).
    setModeSwitch: (m) => { modeSwitch = m; },
    // Lets a headless check change tab from code in the middle of a drag, the way a finishing session does
    // (a tap on the bar would be swallowed by the swipe's click guard) -- rail-fab-swipe.py.
    switchTab:     (name, opts) => switchTab(name, opts),
  };
}

// ─── State ────────────────────────────────────────────────────────────────────


let trainer        = null;
let modeSwitch     = null;
let session        = null;      // free Session OR ScriptedSession
let pendingStart    = false;    // true while armed, waiting for the rider to actually start
                                 // pedaling before session.start() runs — see startSession()'s
                                 // _armPendingStart()/_confirmPendingStart()/_beginSession()
let _pausedAutomatically = false; // true while the current pause is one the software put it in
                                 // (an _autoPause() — idleness or dropped controller — or a
                                 // restored/crash-recovered session reopened via
                                 // _openRestoredSession()) rather than the manual Pause/Play
                                 // button — gates autoResumeSession() below so activity only
                                 // auto-resumes a pause the software created, never one the
                                 // rider chose deliberately. Kept in sync by _autoPause(),
                                 // _openRestoredSession(), togglePause(), and _autoResume() itself.
// Strength tab — deliberately its own Session, entirely separate from
// `session` above: a strength session has no trainer/modeSwitch and
// doesn't feed chartCarousel/HUD. It does get its own crash-recovery
// snapshot in recording/session-persistence.js, under a separate IndexedDB
// slot from the cardio one above so a killed ride and a killed strength
// session don't clobber each other. See startStrengthSession() below and
// views/strength-session.js / recording/set-tracker.js for the rest.
let strengthSession = null;
let strengthTracker = null;
let strengthPanel   = null;
let chartCarousel  = null;
let chartBadgeBar  = null;     // the fixed badge bar above the chart track (ui/chart-badge-bar.js)
let deviceRow      = null;     // reconnect buttons over the live chart's top-right corner (ui/device-row.js)
let activeMetricKey = null;     // metric key of whichever chart page is currently showing
let _overviewKeys = [];          // metric keys the All page carries, in the order the chart's dots run (ChartCarousel's onMetricOrder) — what the hero rotates through while the All page is on screen
let _overviewHeroKey = null;    // the metric the hero is reading out right now while the All page is on screen
let _overviewHeroTimer = null;  // interval that steps _overviewHeroKey; runs only while the All page is the one on screen
let liveSampleBuffer = [];      // recorded samples for the running session, updated on each onSample tick
let _availableMetricDefs = [];  // currently-*live* metric defs (mirrors capabilities exactly) — read by the Scripted HUD rotator and the stat row, neither of which should show a number for a disconnected metric. See updateCapabilityUI() below.
let _knownChartMetricKeys = new Set(); // sticky superset of the above: once a metric has reported live data at least once this ride, its chart-carousel page persists through a later disconnect instead of disappearing — see updateCapabilityUI() and startSession(). ChartEngine itself decides live-vs-frozen per sample (see recording/session.js#clearData), so this only governs whether the *page* stays mounted.
let _prevCapabilityMetrics = {}; // last snapshot.metrics seen by the capabilities.subscribe callback below, so it can tell a fresh disconnect (true -> false) apart from an already-known one
let historyBrowser = null;
let overviewPage   = null;
let dietPage       = null;
// Settings' master-detail rail — see ui/master-detail.js and the
// "Master-detail" block in style.css. Created once here (like
// historyBrowser/overviewPage/dietPage above), not from populateSettingsUI()
// or _runTabLoad(), since those re-run every time the Settings tab is shown
// and would otherwise pile up a fresh click listener on the rail each time.
let settingsRail    = null;
let workoutEditor  = null;
let quickStartFlow  = null;
// Set just before opening workoutEditor to edit a copy of a mapped preset
// (see openPresetInAdvancedBuilder() below) — { basePresetId, basePresetLabel }
// or null when the editor is open for its normal session-bound "Workout
// Editor" FAB entry instead. Read once by the onSavePreset callback above
// and cleared immediately after, so it never lingers into an unrelated
// later save.
let workoutEditorPresetContext = null;
let strengthSetupFlow = null;
let bleDebugFlow     = null;
let ingredientEditor = null;
let recipeEditor     = null;
let recipePrintSheet = null;
let exerciseEditor   = null;
let weighInManager   = null;
let cardioZoneReferenceSheet = null;
let profileBackupFlow = null;
let keyboard       = null;
let calibration    = null;
let loadedWorkout  = null;      // WorkoutModel queued from editor → train tab — set only via _setLoadedWorkout() below, never assigned directly
let _timelineSteps = null;      // flattened steps the timeline canvas was last drawn for — see _drawWorkoutTimeline()
let _timelineMax = 1;           // the highest target in those steps: what the drawing, and the dot's height, are a fraction of
let _timelineStepIndex = -1;    // which step the dot was last placed in — a change is what makes its move a jump
let _timelineLevel = 0;         // the height the dot was last placed at
let _timelineResize = null;     // ResizeObserver that redraws the timeline when its box changes size

// Live-chart workout-progress markers (step completions + the final
// workout-complete marker) for the running scripted session — see
// _onScriptedStep()/_onScriptedComplete() below. _lastMarkedStepIndex
// tracks the most recent stepIndex a marker was already placed for, so
// the per-second onStep() refresh tick (see ScriptedSession#_tick()) —
// which re-fires with the SAME stepIndex every second a step is running —
// doesn't add a duplicate marker; only a genuine advance to a new index
// does. -1 means no step has started yet this session (so the very first
// onStep() call, for step 0, has no "previous step" to mark as complete).
let _workoutMarks = [];
let _lastMarkedStepIndex = -1;

let primaryDeviceId = null;     // roles.js id of the connected trainer (FTMS, Merach, or Proform)
let screenLocked    = false;    // true while the session controls are hold-to-unlock locked — see lockScreen()
const auxSensors     = new Map(); // id -> { id, name, kind, instance } — HR/SmO2/CoreTemp

// The currently-connected smart scale (ScaleDevice | FitdaysScaleDevice), or
// null. Deliberately NOT an auxSensors entry — a scale isn't a live-session
// sensor (see scale-device.js's header), it's a Settings-only, one-weigh-in-
// at-a-time pairing, same spirit as the VO2max/FTP test flows below.
let scaleDevice = null;

// Bike weight is a small, fiddly number most riders won't bother looking
// up, and slope-sim's physics (control/slope-sim.js#estimatePower) aren't
// sensitive enough to it to justify asking — a typical road/gravel bike is
// used for every rider instead of exposing it as a setting. Matches
// SlopeSimMode's own default for the same field.
const TYPICAL_BIKE_WEIGHT_KG = 8;

// Slope-sim's physics needs *a* rider mass to work with, but the profile's
// riderWeight is null until the rider enters their own (nothing is filled in
// for them — see the profile defaults below), so this is what savePreferences()
// hands the slope simulation in the meantime. Matches SlopeSimMode's own
// default for the same field; it's never stored or shown.
const DEFAULT_SIM_RIDER_WEIGHT_KG = 75;

const profile = {
  // ftp/riderWeight are null until the rider enters them (Settings → Profile,
  // an accepted FTP-test estimate, or a scale sync for weight) — nothing is
  // filled in on first launch. That is what lets the Overview's Power-to-Weight
  // card wait for both instead of showing a ratio built from made-up numbers.
  // Anything that just needs a working FTP reads it through _resolvedFtp()
  // (falls back to a typical 200 W), the way max HR goes through
  // _resolvedMaxHr() below; riderWeight's consumers (BMR, protein targets,
  // VO2max, bodyweight exercises) already treat null as "not known".
  ftp: null, riderWeight: null, bikeWeight: TYPICAL_BIKE_WEIGHT_KG, chartWindow: 300, audioCues: true, units: 'metric',
  // Native shell only (Android today — see platform/background-session.js):
  // keep a running workout alive with a foreground service and show its live
  // stats in an ongoing tray notification. Android requires that notification
  // for any app that keeps running in the background, so "notification off"
  // and "keep running in the background off" are the same switch. Applied
  // immediately from Settings (see applyBackgroundNotificationChange()).
  backgroundNotification: true,
  // Whether losing pedaling activity, losing the controller entirely, or
  // the app being hidden should pause a running session on its own — see
  // autoPauseSession()/_resetTrainerState()/_autoPauseOnHide() below.
  // Defaults to FALSE: auto-pause is opt-in.
  // Doesn't affect the fitness tests' own idle-triggered ending (see
  // _isSelfPacedTestInEffortSegment()) — that's a correctness property of
  // those specific tests, not a convenience this toggle is meant to cover.
  autoPause: false,
  // Finer-grained gates on top of autoPause above — both default every
  // known controller type / control mode to disabled, matching autoPause's
  // own off-by-default setting. (Switching Auto Pause on in Settings turns
  // every one of these on together — see _forceChildrenOn() — so these
  // defaults only matter until the rider first opts in.) Checked in
  // _shouldAutoPause() below,
  // ANDed with autoPause: turning one of these off suppresses auto-pause
  // for that specific controller or mode without needing to turn off auto-
  // pause entirely. 'controller' is the single toggle for whichever
  // exercise machine is actually connected — Merach bike, ProForm 750R
  // rower, or a generic FTMS trainer (see _controllerKindFor() below) —
  // collapsed into one key because exactly one of those is ever connected
  // at a time as the primary controller, so separate per-model toggles
  // just meant re-finding and re-checking the right one after switching
  // equipment, with no actual "leave it off for the rower but on for the
  // bike" use case behind it. 'hrm'/'temps' stay their own keys because,
  // unlike the primary controller, both can genuinely be connected
  // alongside it at the same time (see connectHrMonitor()/
  // _reconcileDeviceState() below) and a rider may reasonably want auto-
  // pause on a lost trainer connection but not a flaky HR strap, or vice
  // versa. Mode keys match control/mode-switch.js's MODES. (A profile
  // saved before this toggle was consolidated may still carry its old
  // 'merach'/'proform-750r'/'trainer' keys on disk — loadPreferences()'s
  // merge leaves them in place but nothing reads them anymore, so they're
  // just inert leftovers rather than something needing a migration step.)
  autoPauseControllers: { controller: false, hrm: false, temps: false },
  autoPauseModes: { erg: false, resistance: false, slope: false, virtualGear: false },
  // Per-trigger gate on top of autoPause above, same shape/reasoning as
  // autoPauseControllers/autoPauseModes: 'idle' is the "stopped pedaling"
  // trigger (autoPauseSession()), 'controllerDisconnect' is the "controller
  // disconnected" trigger (_resetTrainerState()). 'modes' isn't a trigger of
  // its own — it's the on/off for the Control modes checklist nested under
  // it (profile.autoPauseModes), letting a rider collapse/ignore that whole
  // checklist without losing its individual saved values, same relationship
  // 'controllerDisconnect' has with the Controller types checklist. Turning
  // any one of these off doesn't touch the others — see _shouldAutoPause().
  // 'hide' is the "app hidden" trigger (_autoPauseOnHide()): pause the
  // workout when the page goes hidden — switching to another app or locking
  // the screen. It's about the app, not the equipment, so unlike the two
  // triggers above it ignores the Controller types / Control modes
  // checklists.
  autoPauseTriggers: { idle: false, controllerDisconnect: false, modes: false, hide: false },
  // age/sex/vo2Max are only used for the Storer-Davis VO2max estimate (see
  // metrics/vo2max.js) — age and sex are null until the rider fills in the
  // Profile settings (needed for the regression's coefficients),
  // vo2Max is null until they've completed a VO2 Max Ramp Test.
  age: null, sex: null, vo2Max: null, vo2MaxDate: null,
  // Last FTP-test estimate (see metrics/ftp-test.js) — recorded whenever a
  // ramp or 20-minute FTP test completes, whether or not the rider chose
  // to apply it to `ftp` above via the confirmation banner in app.js.
  ftpTestWatts: null, ftpTestDate: null, ftpTestLabel: null,
  // heightCm/bodyFatPct/leanBodyMassKg feed metrics/nutrition.js's
  // estimateBmr() — leanBodyMassKg (Katch-McArdle) wins when known,
  // otherwise heightCm falls into the Mifflin-St Jeor fallback alongside
  // age/sex/riderWeight above. leanBodyMassKg is never entered directly —
  // savePreferences() derives it from riderWeight/bodyFatPct whenever
  // bodyFatPct changes, same "derived, not its own field" relationship
  // DIET_PANEL_DESIGN.md §6 describes for a BLE scale reading.
  heightCm: null, bodyFatPct: null, leanBodyMassKg: null,
  // The five manual-entry-only fields core/nutrition-model.js's
  // createBodyMeasurement() also carries (see that file's doc comment) —
  // mirrored here as the Profile's "current" snapshot, same
  // relationship riderWeight has to each BodyMeasurement row's weightKg.
  // Nothing in metrics/nutrition.js reads muscleMassKg/boneMassKg/
  // bodyWaterKg/visceralFatRating — reference-only fields, the same way
  // core/nutrition-model.js's createBodyMeasurement() doc comment
  // describes them. basalMetabolicRateKcal is the exception: a rider with
  // a lab-measured (or scale-reported) BMR can skip both formulas below —
  // estimateBmr() checks it first, ahead of Katch-McArdle/Mifflin-St Jeor.
  muscleMassKg: null, boneMassKg: null, bodyWaterKg: null,
  visceralFatRating: null, basalMetabolicRateKcal: null,
  // restingHr/maxHr feed the Heart Rate zone strip (see metrics/hr-zones.js)
  // and are otherwise informational — heart rate can never be commanded to
  // a trainer (see core/cardio-model.js#heartRateZone), so unlike FTP
  // neither of these drives any workout target. maxHr is null until the
  // rider enters one directly; when absent, every consumer falls back to
  // estimateMaxHr(profile.age) (Tanaka formula) rather than leaving the
  // zone strip empty. restingHr is null until entered by hand or accepted
  // from a Resting HR Test result (see restingHrTest* below).
  restingHr: null, maxHr: null,
  // Last Resting HR Test estimate — same "recorded regardless of whether
  // it was applied" pattern as ftpTestWatts/Date/Label above.
  restingHrTestBpm: null, restingHrTestDate: null,
  // Which TARGET_TYPES the Advanced Builder's target-type picker offers
  // (Settings → Targets) — see editor/workout-editor.js's
  // setEnabledTargetTypes(). Power stays on by default alongside the other
  // three since it's what every generated workout (Quick Start's steady
  // block, the FTP/VO2max tests) already defaults to.
  enabledTargetTypes: [TARGET_TYPES.POWER, TARGET_TYPES.SLOPE, TARGET_TYPES.RESISTANCE, TARGET_TYPES.HEART_RATE],
};

// ─── Chart metric catalogue ───────────────────────────────────────────────────
// Every metric the carousel can show a page for, in swipe order. On every
// capabilities change (see updateCapabilityUI) this is filtered down to
// whichever are actually available right now and handed to the carousel.
const METRIC_ORDER = ['power', 'heartRate', 'cadence', 'speed', 'smo2', 'coreTemp'];

// The rider's max HR, resolved the same way everywhere it's needed: a
// directly-entered value wins, otherwise fall back to the Tanaka
// age-based estimate (see metrics/hr-zones.js#estimateMaxHr) rather than
// leaving every HR-zone consumer (the chart badge below, the Settings
// zone strip) with nothing to show just because the rider hasn't typed a
// number in themselves.
function _resolvedMaxHr() {
  return profile.maxHr ?? estimateMaxHr(profile.age);
}

// The FTP to compute with — the rider's own, or a typical 200 W until they've
// entered one (metrics/ftp-zones.js#resolveFtp). Zones, workout targets, the
// fitness tests and TSS all read this; only the Overview's Power-to-Weight card
// looks at the raw profile.ftp, because it needs to know whether one was given.
function _resolvedFtp() {
  return resolveFtp(profile.ftp);
}

// Recorded samples always stay metric (km/h) — only the Speed page's display
// (label/axis/plotted line, via `transform`) depends on the units setting.
// Rebuilt whenever the units preference changes; see savePreferences().
function buildMetricDefs(units) {
  const toDisplaySpeed = v => kmhToDisplaySpeed(v, units);

  // The corner "Zone" badge reads Power zone (metrics/ftp-zones.js) on
  // every page except Heart Rate's own, which reads HR zone
  // (metrics/hr-zones.js) instead — showing a power-derived zone number on
  // the HR page (or vice versa) would just be confusing, so each page gets
  // the zone badge for the quantity it's actually plotting.
  const powerZoneBadge = {
    key: 'zone', label: 'Zone', pair: 'stats', getValue: s => s,
    fmt:      s => (s?.power != null) ? `Z${zoneForPower(s.power, _resolvedFtp()).zone}` : '—',
    getColor: s => (s?.power != null) ? zoneForPower(s.power, _resolvedFtp()).color : null,
  };
  const hrZoneBadge = {
    key: 'zone', label: 'Zone', pair: 'stats', getValue: s => s,
    fmt:      s => (s?.heartRate != null && _resolvedMaxHr()) ? `Z${zoneForHr(s.heartRate, { maxHr: _resolvedMaxHr(), restingHr: profile.restingHr }).zone}` : '—',
    getColor: s => (s?.heartRate != null && _resolvedMaxHr()) ? zoneForHr(s.heartRate, { maxHr: _resolvedMaxHr(), restingHr: profile.restingHr }).color : null,
  };

  // The same three readouts sit beside the zone badge in the chart's fixed badge bar (ui/chart-badge-bar.js,
  // its second row) — Calories burned so far this session, cumulative Distance travelled, and Pace. All
  // derived from the same recorded samples so they track live during a session and match the History
  // card's figures.
  const statBadges = [
    { key: 'calories', label: 'Calories', getValue: s => s?.calories, fmt: v => v != null ? `${Math.round(v)} kcal` : '—' },
    { key: 'distance', label: 'Distance', getValue: s => s?.distance, fmt: v => formatDistance(v, units) },
    { key: 'pace',     label: 'Pace',     getValue: s => s, fmt: s => formatPace(s?.distance, s?.elapsedTime, units) },
  ];
  const powerBadges = [powerZoneBadge, ...statBadges];
  const hrBadges     = [hrZoneBadge, ...statBadges];

  return {
    metrics: {
    power:     { label: 'Power', color: CHART_COLORS.power, yMin: 0, yMax: 700, unit: 'W', fmt: v => Math.round(v) },
    heartRate: { label: 'Heart Rate', color: CHART_COLORS.heartRate, yMin: 40, yMax: 220, unit: 'bpm',  fmt: v => Math.round(v) },
    cadence:   { label: 'Cadence',    color: CHART_COLORS.cadence,   yMin: 0,  yMax: 140, unit: 'rpm',  fmt: v => Math.round(v) },
    speed:     {
      label: 'Speed', color: CHART_COLORS.speed, yMin: 0,
      yMax: units === 'imperial' ? 40 : 60,
      unit: speedUnitLabel(units),
      fmt: v => toDisplaySpeed(v).toFixed(1),
      transform: toDisplaySpeed,
    },
    smo2:      { label: 'SmO2',       color: CHART_COLORS.smo2,      yMin: 0,  yMax: 100, unit: '%',    fmt: v => v.toFixed(1) },
    coreTemp:  { label: 'Core Temp',  color: CHART_COLORS.coreTemp,  yMin: 30, yMax: 42,  unit: '°C',   fmt: v => v.toFixed(1) },
    },
    // The bar's second row: Zone is the heart-rate zone on the heart-rate page and the power zone on every
    // other (the same split the corner badge always had); the other three are the same everywhere.
    statBadges: key => (key === 'heartRate' ? hrBadges : powerBadges),
  };
}

let _builtDefs = buildMetricDefs(profile.units);
let METRIC_DEFS = _builtDefs.metrics;
let _statBadgesFor = _builtDefs.statBadges;

/** Rebuilds METRIC_DEFS (and the badge bar's stat badges) for a units setting. */
function _rebuildMetricDefs(units) {
  _builtDefs = buildMetricDefs(units);
  METRIC_DEFS = _builtDefs.metrics;
  _statBadgesFor = _builtDefs.statBadges;
}

/** Hands the fixed badge bar what it needs from the current defs: a current-value badge for each of
 *  power / heart rate / cadence / speed that the chart has a page for, and the stat row for the page on
 *  screen. Safe to call before the bar exists, and as often as the defs, the units or the page change. */
function _syncChartBadgeBar() {
  if (!chartBadgeBar) return;
  const keys = badgeMetricKeys([..._knownChartMetricKeys]);
  chartBadgeBar.setMetrics(keys.map(key => ({ key, ...METRIC_DEFS[key] })));
  chartBadgeBar.setHeroRing(_overviewKeys);   // the hero's rotation order: the badge on the All page sits half a turn from it
  chartBadgeBar.setStats(_statBadgesFor(activeMetricKey));
  chartBadgeBar.setActive(activeMetricKey, _badgeHeroKey());
}

/** The metric whose badge the bar should hide because the All page's rotating hero is reading it out
 *  (null on every other page, where the page's own metric is the one that steps aside). */
function _badgeHeroKey() {
  return activeMetricKey === ChartCarousel.OVERVIEW_KEY ? _overviewHeroKey : null;
}

// ─── DOM ─────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const setText = (id, v) => { const el=$(id); if(el) el.textContent=v; };
// Same as setText, but for the HUD workout title/step name: those used to
// truncate with an ellipsis when long, so this shrinks the font to fit
// instead (see ux/fit-text.js) — only re-measuring when the text actually
// changed, since this runs from updateScriptedHUD() on every tick but the
// title/step name themselves only change once per session/step.
const setHudText = (id, v) => {
  const el = $(id);
  if (!el || el.textContent === String(v)) return;
  el.textContent = v;
  fitText($('scripted-hud'), `#${id}`);
};

// Fans a device-status update out to whichever pre-session flow or live
// panel happens to be mounted — each needs to stay in sync with real BLE
// state on its own, so every call site below goes through this instead of
// poking any one of them directly.
function _setDeviceStatus(kind, status) {
  // The pre-session flows have three states (Connect / Connecting… / Connected). 'reconnecting'
  // is only a live-session idea, so for them the strap simply reads as not connected — and their
  // tile stays tappable, which hands control back to the rider (connectHrMonitor()).
  const flowStatus = status === 'reconnecting' ? 'disconnected' : status;
  quickStartFlow?.setDeviceStatus(kind, flowStatus);
  strengthSetupFlow?.setDeviceStatus(kind, flowStatus);
  // The live cardio chart's device row wants the full status too ('reconnecting' pulses and stays
  // tappable); it ignores everything while no cardio session is running.
  deviceRow?.setStatus(kind, status);
  // A live strength session has no pre-session flow open to update — its
  // HR slot (ui/hr-slot.js) needs the full status so a strap that drops
  // mid-session flips it into a pulsing "Reconnecting…" button (or, if the
  // rider unplugged it themselves, a plain Connect button).
  strengthPanel?.setDeviceStatus(kind, status);
}

// Maps each connectable BLE role to its button in the trainer menu (the
// control bar's Settings menu — see #trainer-menu in index.html). Each
// button connects when that role is empty and disconnects (after a
// confirm) when it's already occupied — see the trainer-menu-connect-*
// handlers in bindControls().
const TRAINER_MENU_ITEM_ID = {
  controller: 'trainer-menu-connect',
  hrm:        'trainer-menu-connect-hrm',
  smo2:       'trainer-menu-connect-smo2',
  coreTemp:   'trainer-menu-connect-coretemp',
};

/**
 * Flips a trainer-menu device button between its "Connect X" and
 * "<name> Connected" states. `name` is the actual connected device's name
 * when known (falls back to the button's generic data-label, the same
 * fallback the old standalone Disconnect item used). While connected, a
 * second label ("Disconnect <name>") sits underneath and only shows on
 * hover — see .trainer-menu-label-hover in style.css — so the button warns
 * what clicking it will do right as the pointer lands on it.
 * @param {'controller'|'hrm'|'smo2'|'coreTemp'} kind
 */
function _updateDeviceMenuItem(kind, connected, name) {
  const item = $(TRAINER_MENU_ITEM_ID[kind]);
  if (!item) return;
  item.classList.toggle('connected', connected);
  const shownName = name || item.dataset.label;
  const defaultLabel = item.querySelector('.trainer-menu-label-default');
  const hoverLabel   = item.querySelector('.trainer-menu-label-hover');
  if (defaultLabel) {
    defaultLabel.textContent = connected ? `${shownName} Connected` : `Connect ${item.dataset.label}`;
  }
  if (hoverLabel) {
    hoverLabel.textContent = `Disconnect ${shownName}`;
  }
}

/** First connected aux sensor of a given kind ('hr' | 'smo2' | 'coreTemp'). */
function _findAuxByKind(kind) {
  return [...auxSensors.values()].find(s => s.kind === kind);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await db.open();
  await loadPreferences();

  // Native-shell background keep-alive. Deliberately not awaited: a slow (or
  // failing) native round trip must never hold up the rest of startup, and
  // the module reads as "unsupported" until it resolves anyway.
  _initBackgroundSession().catch(err => console.warn('[app] background session init failed', err));

  // Rider-authored custom exercises — populates data/exercises.js's
  // in-memory cache so allExercises()/searchExercises()/exercisesForFocus()
  // etc. include them from the Strength tab's very first render, same
  // timing/reasoning as the custom exercise editor singleton set up below.
  await loadCustomExercises().catch(() => {});

  // Rider-saved cardio timeline ("Mapped" quick-start target style)
  // presets — populates data/cardio-timelines.js's in-memory cache so
  // allTimelinePresets() includes them from cardio-session-flow.js's very
  // first render, same timing/reasoning as loadCustomExercises() above.
  await loadCustomTimelinePresets().catch(() => {});
  _rebuildMetricDefs(profile.units);

  // Live chart — one swipeable page per currently-available metric. Which
  // metrics are available is driven entirely by capabilities.subscribe()
  // below (updateCapabilityUI calls setAvailableMetrics on every change).
  chartCarousel = new ChartCarousel($('chart-container'), {
    mode: 'live',
    windowSec: profile.chartWindow,
    showOverview: true,
    // The chart sits on the live panel's hero-tier glass (#chart-container in style.css), so the
    // canvases paint no background of their own; with no metric yet, the empty state is a tile
    // whose button opens the same sensor menu the control bar's Settings button does.
    chartBgAlpha: 0,
    // The All page draws the hero's current metric only (its readout rotates on a timer, _tickOverviewHero),
    // rather than overlaying every metric; History's All page keeps the overlay.
    overviewFollowsHero: true,
    emptyTitle: 'No live data yet',
    emptyMessage: 'Connect a trainer or sensor to see live metrics.',
    emptyAction: { label: 'Connect', title: 'Open the sensor menu', onClick: () => _openSensorMenu() },
    // The metric order the dots run in (CHART_METRIC_ORDER, which updateCapabilityUI() hands the carousel).
    // The All page's hero rotation (and so the badge bar's "half a turn away" partner) is measured along
    // this list, not along METRIC_ORDER, which the HUD rotator and background snapshot use with Power first.
    // Fired inside setAvailableMetrics(), before the page-change callback below reads it.
    onMetricOrder: (keys) => { _overviewKeys = keys; },
    onActiveMetric: (key) => {
      const wasAll = activeMetricKey === ChartCarousel.OVERVIEW_KEY;
      const heroBefore = _heroKey();   // what the readout was showing before this page change
      activeMetricKey = key;
      // The All page's hero rotates on a timer, starting from its first metric each time you arrive;
      // any other page reads out its own metric, so the timer stops.
      if (key === ChartCarousel.OVERVIEW_KEY) { if (!wasAll) _startOverviewHero(); }
      else _stopOverviewHero();
      // The badge for this metric steps aside toward the hero, and the stat row's Zone follows the page.
      chartBadgeBar?.setActive(key, _badgeHeroKey());
      chartBadgeBar?.setStats(_statBadgesFor(key));
      _renderMetricStats();
      // The readout now shows another metric: fade it in, the same animation the All page's rotation uses
      // for each of its steps, rather than snapping to the new one. (Arriving on the All page on the metric
      // the hero was already on, or the very first page, changes nothing on screen, so there is nothing to fade.)
      const heroNow = _heroKey();
      if (heroBefore != null && heroNow != null && heroBefore !== heroNow) _replayHeroFade();
    },
  });

  // The badge bar rides in the same panel, above the swipeable track: the current Power / Heart rate /
  // Cadence / Speed plus Zone / Calories / Distance / Pace, which stay put while the chart is swiped.
  chartBadgeBar = new ChartBadgeBar($('chart-container'));
  // A held chart (long-press focus-lock) stops the hero stepping (_tickOverviewHero); the badge stands
  // still under the same condition rather than carrying on rotating beside a frozen hero.
  chartBadgeBar.setPausedProbe(() => chartCarousel?.locked === true);
  _syncChartBadgeBar();
  // The device row floats over that panel's top-right corner during a cardio session: a button per
  // device that was connected when the session started and has dropped, tapped to get it back. A tap
  // runs the same connect handler as the setup flow's tile for that device.
  deviceRow = new DeviceRow($('chart-container'), { onConnect: (kind) => _connectDeviceKind(kind) });

  // History browser
  historyBrowser = new HistoryBrowser($('history-panel'), { units: profile.units });
  await historyBrowser.load();

  // Settings' master-detail rail — see ui/master-detail.js's own doc
  // comment. Developer tools (the BLE Debug Console) no longer get a rail
  // category of their own — that was a whole extra button for one row —
  // they're the last row of General instead, shown only in a live `vite
  // dev` session (same import.meta.env.DEV gate as always). The row starts
  // `hidden` in index.html, so a built app never shows it even if this
  // line doesn't run.
  settingsRail = new MasterDetailRail($('settings-md-shell'));
  $('developer-settings-group')?.classList.toggle('hidden', !import.meta.env.DEV);
  settingsRail.select('general');

  // Overview — health/training dashboard built from saved sessions + profile.
  overviewPage = new OverviewPage($('overview-panel'), {
    profile,
    onReviewWeighIns: () => weighInManager?.open(),
    onNeedsCardTap: (id) => _onOverviewNeedsTap(id),
    onOpenSettings: (ids) => _openSettingsAt(ids),
  });
  await overviewPage.load();

  // Weigh-in editor — a detail sheet (ui/detail-sheet.js) for finding, fixing and removing
  // weigh-ins that look wrong (metrics/weigh-in-review.js's flagWeighIns()).
  // Two entry points reach it: the Weight & Composition card's review link
  // above (via the onReviewWeighIns closure, resolved lazily so construction
  // order here doesn't matter) and Settings → Profile → Weigh-in history,
  // wired in bindControls() below.
  weighInManager = new WeighInManager({
    profile,
    onChange: () => { overviewPage?.load(); _renderWeighInReviewSub(); },
    // The sheet's "Profile settings" button: Settings → Profile → Body composition, expanded,
    // where the Profile's own (separate) weight and body-composition values live.
    onOpenSettings: () => _openSettingsAt(['body-comp-toggle'], { before: () => _toggleBodyCompPanel(true) }),
  });

  // Cardio Zone Reference — a detail sheet, opened from Settings → Display beneath the Power/Heart
  // rate zone strips (see ui/cardio-zone-reference.js's doc comment).
  // Handed the same resolvers those strips render from (_resolvedFtp/
  // _resolvedMaxHr) so the embedded page opens pre-filled with whatever
  // they're currently showing.
  cardioZoneReferenceSheet = new CardioZoneReferenceSheet({
    profile,
    resolvedFtp: _resolvedFtp,
    resolvedMaxHr: _resolvedMaxHr,
    // The sheet's "Edit FTP & heart rate" button: the three Profile fields the reference reads from.
    onOpenSettings: () => _openSettingsAt(['pref-ftp', 'pref-resting-hr', 'pref-max-hr']),
  });

  // Settings → Backup & Restore — everything on this device in one file:
  // workout/diet/weigh-in history, custom ingredients/recipes/exercises/
  // cardio presets, and a settings snapshot (storage/profile-archive.js).
  // The actual export/import decisions live in storage/profile-backup-flow.js;
  // these hooks just connect it to this device's db, the platform file
  // bridges, the Settings status line, and every view an import could add
  // data to.
  profileBackupFlow = createProfileBackupFlow({
    db,
    saveFile,
    pickTextFile,
    confirm: (text) => confirm(text),
    // Swapping in workout/settings history or overwriting the rider's
    // current settings mid-ride would be actively destructive — same
    // reasoning History's own Import refuses this too.
    isWorkoutRunning: () => _backgroundWorkoutKind() !== null,
    setStatus: _setProfileBackupStatus,
    setBusy: _setProfileBackupBusy,
    refreshAfterImport: async () => {
      await Promise.all([
        loadCustomExercises().catch(() => {}),
        loadCustomTimelinePresets().catch(() => {}),
        historyBrowser?.load(),
        overviewPage?.load(),
        dietPage?.load(),
      ]);
      await _renderWeighInReviewSub();
    },
  });

  // Custom ingredient editor — a shared singleton reachable from three
  // places (the Diet tab's Recipes "+ Custom Ingredient" button, the
  // diary quick-add's "can't find it?" fallback, and the recipe editor's
  // own per-row "add a custom ingredient" fallback below), each of which
  // needs its own "what happens once this is saved" behavior — see
  // ui/ingredient-editor.js's doc comment.
  ingredientEditor = new IngredientEditor($('ingredient-editor-flow'));

  // Bridges the three callers above onto that one instance: opens it
  // pre-filled with whatever the caller was searching for, and resolves
  // with the saved Ingredient (or null on cancel) instead of taking a
  // callback — this is exactly the `(prefillName) => Promise<Ingredient|null>`
  // shape ui/recipe-editor.js's onAddCustomIngredient already expects, so
  // it's handed straight through below without a wrapper on that side.
  function openIngredientEditorFor(prefillName = '') {
    return new Promise((resolve) => {
      ingredientEditor.open({
        prefillName,
        onSaved: (ingredient) => resolve(ingredient),
        onCancel: () => resolve(null),
      });
    });
  }

  // Recipe editor — Diet tab's Recipes "+ New Recipe" button, editing an
  // existing saved recipe, or cloning a preset (DIET_PANEL_DESIGN.md §4's
  // "picking a preset recipe clones it" — the clone opens here so the
  // rider can adjust it before it's actually saved as their own).
  // Printable recipe sheet — the Recipes tab's "Print" action and the
  // recipe editor's own "Print" button below both open this same shared
  // instance (see ui/recipe-print.js's doc comment).
  recipePrintSheet = new RecipePrintSheet($('recipe-print-sheet'), { profile });

  recipeEditor = new RecipeEditor($('recipe-editor-flow'), {
    profile,
    onSave: () => dietPage?.load(),
    onAddCustomIngredient: openIngredientEditorFor,
    onPrint: (recipe, opts) => recipePrintSheet.print(recipe, opts),
  });

  // Custom exercise editor — a shared singleton reachable from the Strength
  // tab's exercise Browse picker (the "+ Create Custom Exercise" row, and
  // each custom chip's own edit pencil), same one-instance-many-callers
  // shape as ingredientEditor above (see ui/exercise-editor.js's own doc
  // comment). The bridge functions that open it (openExerciseEditorFor/
  // openExerciseEditorToEdit) live at module scope near startStrengthSession
  // below, not nested here — unlike openIngredientEditorFor above, they're
  // called from outside init() (StrengthSessionPanel is constructed fresh
  // on every "Start Strength Session", well after init() has returned).
  exerciseEditor = new ExerciseEditor($('exercise-editor-flow'));

  // Diet — food diary + calorie balance (DIET_PANEL_DESIGN.md). Eager like
  // historyBrowser/overviewPage above, not lazy on first tab visit.
  dietPage = new DietPage($('diet-panel'), {
    profile,
    onAddCustomIngredient: openIngredientEditorFor,
    onOpenRecipeEditor: (recipe) => recipeEditor.open(recipe),
    onPrintRecipe: (recipe) => recipePrintSheet.print(recipe),
  });
  await dietPage.load();

  // Workout editor
  workoutEditor = new WorkoutEditor($('workout-panel'), {
    ftp:    _resolvedFtp(),
    enabledTargetTypes: profile.enabledTargetTypes,
    onSave: (model) => {
      _setLoadedWorkout(model);
      const nameInput = $('workout-name-input');
      if (nameInput) nameInput.value = model.name;
      switchTab('session');
      setStatus(`"${model.name}" ready — press Start to begin scripted session`);
    },
    // Opened from Quick Start's Mapped preset picker ("Open in Advanced
    // Builder…" — see quickStartFlow's onEditPreset below), editing a copy
    // of a preset rather than a session-bound workout: Save here means
    // "persist this as a new named preset" instead of "load into the
    // session and go". The editor's own #we-name field doubles as the new
    // preset's name — see editor/workout-editor.js's load()/intent doc
    // comment for why one Save button can mean either thing depending on
    // how the editor was opened.
    onSavePreset: async (model) => {
      const preset = await addCustomTimelinePreset({
        label: model.name || 'Custom Timeline',
        tagline: workoutEditorPresetContext?.basePresetLabel
          ? `Customized from \u201c${workoutEditorPresetContext.basePresetLabel}\u201d.`
          : '',
        durationMin: Math.round(totalDuration(model) / 60),
        basePresetId: workoutEditorPresetContext?.basePresetId ?? null,
        steps: model.steps,
      });
      workoutEditorPresetContext = null;
      setStatus(`"${preset.label}" saved as a preset`);
      quickStartFlow?.open({ targetStyle: 'mapped', mappedPresetId: preset.id });
    },
    // Backs the 'preset' intent's "Load a preset timeline" select — see
    // that constructor option's own doc comment in workout-editor.js.
    // Bundled + custom, same list Quick Start's Mapped grid offers.
    getTimelinePresets: () => allTimelinePresets(),
    // Picking a preset from that select is just another way to reach
    // openPresetInAdvancedBuilder()'s "load a copy under the 'preset'
    // intent" behavior — same as Quick Start's "Open in Advanced
    // Builder…" action below, just without leaving the builder first.
    onLoadPreset: (id) => openPresetInAdvancedBuilder(timelinePresetById(id)),
  });

  // Quick-start flow — single-screen shortcut opened by the floating +'s
  // "Cardio Session" menu item. This starts the session immediately once
  // "Start Workout" is tapped — no intermediate "load into editor" step.
  // This is also the one place devices get paired from now, so it covers
  // the full equipment set: controller (FTMS, Merach, or Proform), HRM,
  // SmO2, core temp.
  quickStartFlow = new CardioSessionFlow({
    ftp: _resolvedFtp(),
    // Feeds Steady's HR Zone mode "{Target zone}" name segment (see
    // cardio-session-flow.js's _steadyZoneLabel()) — _resolvedMaxHr() folds
    // in the Tanaka age estimate so this still works before the rider has
    // entered a measured max HR, same as the chart badge/zone strip do.
    hrProfile: { maxHr: _resolvedMaxHr(), restingHr: profile.restingHr },
    onConnectController: () => connectController(),
    onConnectHrm:         () => connectHrMonitor(),
    onConnectSmo2:        () => connectSmo2Monitor(),
    onConnectCoreTemp:    () => connectCoreTempSensor(),
    // Mapped's "Open in Advanced Builder…" action — see
    // openPresetInAdvancedBuilder()'s own doc comment below.
    onEditPreset: (preset) => openPresetInAdvancedBuilder(preset),
    onStart: (model, settings) => {
      db.setPref('lastQuickStart', settings).catch(() => {});
      _setLoadedWorkout(model);
      const nameInput = $('workout-name-input');
      if (nameInput) nameInput.value = model.name;
      startSession();
    },
  });

  // Strength setup flow — the strength counterpart to quickStartFlow above:
  // same single-screen shape, scaled to what a strength session needs (a
  // Muscle Group + Style + preset-or-custom Workout Sequence in place of a
  // duration/workout-type picker, an HRM-only Equipment row since there's
  // no controller/SmO2/core-temp relevance without a trainer). The whole
  // point of the sequence step is that the session's exercise structure is
  // chosen here, before views/strength-session.js ever mounts — see
  // ui/strength-session-flow.js's own doc comment.
  strengthSetupFlow = new StrengthSessionFlow({
    onConnectHrm: () => connectHrMonitor(),
    onStart: (settings) => startStrengthSession(settings),
  });

  // Strength tab — has no bottom-nav entry of its own (see switchTab()'s
  // own comment on 'session' for why a live-logging panel doesn't need
  // one). Pre-rendered idle here purely as a harmless default in case
  // switchTab('strength') is ever reached with no session running (see
  // that defensive branch) — in normal use the rider never actually sees
  // this: the FAB's "Strength Session" item opens strengthSetupFlow, whose
  // onStart above is what actually swaps this panel to the live view via
  // startStrengthSession(). Finishing doesn't swap back to this idle
  // prompt — see _onStrengthSessionEnd(), which leaves the panel behind
  // for History instead, the same "somewhere real" landing a finished
  // ride gets.
  _renderStrengthIdle();

  // BLE Debug Console — nRF-Connect-style GATT browser, opened from Settings
  // → Developer. Standalone diagnostic tool: takes no options and doesn't
  // touch profile/session state, so it's safe to construct unconditionally
  // here alongside the other overlays.
  bleDebugFlow = new BleDebugFlow($('ble-debug-flow'));

  // Keyboard
  keyboard = new KeyboardController({
    // Counts as "running" for Space's start/stop toggle while armed and
    // waiting on _armPendingStart() too — otherwise Space would try to
    // start a second session on top of the one already waiting for
    // pedaling instead of cancelling it (see stopSession()).
    isRunning:    () => (session?.isRunning ?? false) || pendingStart,
    onStart:      startSession,
    onStop:       stopSession,
    onLap:        markLap,
    onNudge:      dir  => nudgeTarget(dir),
    onModeSwitch: mode => switchMode(mode),
    onShift:      dir  => dir === 'up' ? modeSwitch?.shiftUp() : modeSwitch?.shiftDown(),
    onCancel:     ()   => modeSwitch?.deactivateAll(),
  });
  keyboard.enable();
  infoTooltips.init();

  capabilities.subscribe(snap => {
    // A metric that just dropped (was live, isn't anymore) needs whichever
    // session is actually running right now to have its accumulator
    // cleared for it — see recording/session.js#clearData — otherwise it
    // would keep silently repeating the last reading it ever got, forever,
    // on every future tick. This is what lets a live chart tell a real
    // disconnect apart from an unchanged-but-still-live reading and draw a
    // flat gray line at the last known value instead of one that looks
    // like it's still live (see ChartEngine's _drawSeries()/
    // _drawCrosshair()). `session` and `strengthSession` are mutually
    // exclusive in practice (a rider is on one live tab at a time), but
    // capabilities is a single app-wide singleton that doesn't know which
    // tab is active — clearing both is harmless (clearData on a null/
    // not-running/unrelated-key session is a no-op) and means an HR strap
    // dropping mid-*strength*-session correctly freezes
    // views/strength-session.js's own heart-rate ChartEngine too, not just
    // the free-ride chart carousel's.
    const dropped = METRIC_ORDER.filter(key => _prevCapabilityMetrics[key] && !snap.metrics[key]);
    if (dropped.length) { session?.clearData(dropped); strengthSession?.clearData(dropped); }
    _prevCapabilityMetrics = { ...snap.metrics };

    updateCapabilityUI(snap);
    _reconcileDeviceState();
  });

  if (reconnect.isSupported()) {
    reconnect.start(device => _reconnectDevice(device)).catch(() => {});
  }

  // Snapshot the active workout at every point the page might die without
  // warning — the phone's home button, swiping the app away, the screen
  // locking (the backup for when ux/wake-lock.js's Screen Wake Lock doesn't
  // stop that), or the OS reclaiming a backgrounded tab all stop JS
  // execution with no guaranteed callback. visibilitychange (hidden)
  // catches backgrounding an open tab (screen-lock included — that's what
  // fires it on a phone); pagehide catches actual navigation/unload,
  // including bfcache eviction, which doesn't always fire visibilitychange
  // first. Both funnel into _checkpointWorkouts() — which pauses + snapshots
  // via persistActiveWorkout()/persistActiveStrengthWorkout() (see
  // recording/session-persistence.js; each a no-op beyond clearing its own
  // stale snapshot when there's no running session of that kind) — EXCEPT
  // when the native shell's background keep-alive is running: then the app
  // isn't frozen, so the workout keeps recording and this only checkpoints.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      _autoPauseOnHide(); // opt-in "App hidden" auto-pause — runs first so the snapshot below already has the paused state
      _checkpointWorkouts();
      _startBackgroundCheckpointTimer();
    } else {
      _stopBackgroundCheckpointTimer();
      // A hidden page's timer is throttled and may not fire again for up to a
      // minute — flush whatever seconds are still owed to the sample buffer
      // now, so the chart is already complete on the frame the rider sees it
      // (see recording/session.js#catchUp()/#_tick()).
      session?.catchUp?.();
      strengthSession?.catchUp?.();
      _setStrengthPausedUI(!!strengthSession?.isPaused);
      // The rider may have changed the notification permission (or this
      // channel) in system Settings while away — re-read it, then re-sync.
      backgroundSession.refresh()
        .then(() => { _renderBackgroundSettingsRow(); _syncBackgroundSession(); })
        .catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => _checkpointWorkouts());

  const restored         = await _restoreActiveWorkout();
  const strengthRestored = await _restoreActiveStrengthWorkout();

  setupTabs();
  bindControls();
  populateSettingsUI();
  _renderWeighInReviewSub();

  // One-time initial placement, matching whichever tab index.html already
  // marks active (Overview, normally) — switchTab()'s own call to
  // _placeFabInRail() takes over from here on every tab change. Can't just
  // happen inside MasterDetailRail's own constructor instead: whichever of
  // the four rails gets built last would otherwise win regardless of which
  // tab is actually showing, since every constructor runs during this same
  // init(), not just the active tab's.
  _placeFabInRail(document.querySelector('.tab-bar [data-tab].active')?.dataset.tab ?? 'overview');

  if (!restored && !strengthRestored) setStatus('Ready — connect a trainer to begin');
}

// ─── Preferences ─────────────────────────────────────────────────────────────

async function loadPreferences() {
  profile.ftp         = await db.getPref('ftp',         null);
  profile.riderWeight = await db.getPref('riderWeight', null);
  // bikeWeight is intentionally not a stored preference — see
  // TYPICAL_BIKE_WEIGHT_KG above.
  profile.chartWindow = await db.getPref('chartWindow', 300);
  profile.audioCues   = await db.getPref('audioCues',   true);
  profile.autoPause   = await db.getPref('autoPause',   false);
  profile.backgroundNotification = await db.getPref('backgroundNotification', true);
  // Merged over the defaults already on `profile` (rather than replaced
  // outright) so a saved object from before a new controller/mode/trigger
  // key existed (autoPauseTriggers.hide, say) still comes back with that
  // key present at its default — off — instead of silently missing.
  profile.autoPauseControllers = { ...profile.autoPauseControllers, ...(await db.getPref('autoPauseControllers', profile.autoPauseControllers)) };
  profile.autoPauseModes       = { ...profile.autoPauseModes,       ...(await db.getPref('autoPauseModes',       profile.autoPauseModes)) };
  profile.autoPauseTriggers    = { ...profile.autoPauseTriggers,    ...(await db.getPref('autoPauseTriggers',    profile.autoPauseTriggers)) };
  profile.units       = await db.getPref('units',   'metric');
  profile.age         = await db.getPref('age',       null);
  profile.sex         = await db.getPref('sex',       null);
  profile.vo2Max      = await db.getPref('vo2Max',     null);
  profile.vo2MaxDate  = await db.getPref('vo2MaxDate', null);
  // heightCm/bodyFatPct/leanBodyMassKg plus the five manual-entry fields
  // below are now written by the Profile's "Body composition" form in
  // savePreferences(), and also by a BLE scale sync (see connectSmartScale()/
  // _applyScaleReading() — DIET_PANEL_DESIGN.md §7) for whichever of
  // heightCm/bodyFatPct/muscleMassKg/bodyWaterKg/basalMetabolicRateKcal the
  // paired scale actually reports.
  profile.heightCm       = await db.getPref('heightCm',       null);
  profile.bodyFatPct     = await db.getPref('bodyFatPct',     null);
  profile.leanBodyMassKg = await db.getPref('leanBodyMassKg', null);
  profile.muscleMassKg          = await db.getPref('muscleMassKg',          null);
  profile.boneMassKg            = await db.getPref('boneMassKg',            null);
  profile.bodyWaterKg           = await db.getPref('bodyWaterKg',           null);
  profile.visceralFatRating     = await db.getPref('visceralFatRating',     null);
  profile.basalMetabolicRateKcal = await db.getPref('basalMetabolicRateKcal', null);
  profile.ftpTestWatts = await db.getPref('ftpTestWatts', null);
  profile.ftpTestDate  = await db.getPref('ftpTestDate',  null);
  profile.ftpTestLabel = await db.getPref('ftpTestLabel', null);
  profile.restingHr    = await db.getPref('restingHr',    null);
  profile.maxHr        = await db.getPref('maxHr',        null);
  profile.restingHrTestBpm = await db.getPref('restingHrTestBpm', null);
  profile.restingHrTestDate = await db.getPref('restingHrTestDate', null);
  // Merged over the default (rather than replaced outright), same reasoning
  // as autoPauseControllers/autoPauseModes/autoPauseTriggers above — a
  // saved list from before a new target type existed shouldn't silently
  // read as "off" for it. Falls back to the full default list (rather than
  // whatever partial list survives the filter) if a corrupted/empty saved
  // value would otherwise leave every target type hidden in the Advanced
  // Builder with no way back in short of clearing storage.
  // TARGET_TYPES.NONE is the internal "no target" sentinel (Free Ride), not
  // a real pickable target type, so it's deliberately excluded from the
  // valid set here even though it lives in the same enum.
  const validTargetTypes = [TARGET_TYPES.POWER, TARGET_TYPES.SLOPE, TARGET_TYPES.RESISTANCE, TARGET_TYPES.HEART_RATE];
  const savedTargetTypes = await db.getPref('enabledTargetTypes', profile.enabledTargetTypes);
  profile.enabledTargetTypes = Array.isArray(savedTargetTypes) && savedTargetTypes.length
    ? savedTargetTypes.filter(t => validTargetTypes.includes(t))
    : profile.enabledTargetTypes;
  if (!profile.enabledTargetTypes.length) profile.enabledTargetTypes = [TARGET_TYPES.POWER];
  if (profile.audioCues) audioCues.enable();
}

// ─── Backup & Restore / weigh-in review (Settings) ─────────────────────────
// storage/profile-backup-flow.js owns the actual export/import decisions;
// these three just relay its hooks to the Settings DOM (the status line
// under the buttons, the button-disable while a save/import runs) and keep
// the "N weigh-ins may be wrong" summary next to Weigh-in history in sync.

/** profileBackupFlow's setStatus hook — the one-line result under the
 *  Backup & Restore buttons (#profile-backup-status). */
function _setProfileBackupStatus(text, { error = false } = {}) {
  const el = $('profile-backup-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!error);
  el.hidden = !text;
}

/** profileBackupFlow's setBusy hook — locks/unlocks the two buttons while
 *  an export or import is in flight, same reasoning as every other
 *  busy-while-in-flight button pair in this file. */
function _setProfileBackupBusy(busy) {
  const exportBtn = $('profile-export-btn');
  const importBtn = $('profile-import-btn');
  if (exportBtn) exportBtn.disabled = busy;
  if (importBtn) importBtn.disabled = busy;
}

/** The "N weigh-ins may be wrong" hint next to Settings → Profile →
 *  Weigh-in history (#weigh-in-review-sub) — same flagWeighIns() count the
 *  weigh-in editor itself opens on. Refreshed on every Settings tab visit
 *  and after the editor reports a change, so it never goes stale while the
 *  rider is looking at it. A read failure is logged, not surfaced — it's
 *  only a hint, and the row simply keeps showing whatever it last had. */
async function _renderWeighInReviewSub() {
  const el = $('weigh-in-review-sub');
  if (!el) return;
  try {
    const rows = await db.getBodyMeasurements();
    const flaggedCount = flagWeighIns(rows).size;
    el.textContent = rows.length
      ? `${rows.length} saved${flaggedCount ? ` \u00b7 ${flaggedCount} may be wrong` : ''}`
      : '';
    el.hidden = !rows.length;
  } catch (err) {
    console.warn('[app] weigh-in review summary failed', err);
  }
}

// Rider weight is always stored canonically in kg (that's what the
// slope-simulation physics in control/slope-sim.js expects) — Imperial only
// changes what's shown/entered in this field, converted at the boundary.
// (Bike weight uses the same kg convention but isn't a user-facing field —
// see TYPICAL_BIKE_WEIGHT_KG above.)
function populateSettingsUI() {
  const set = (id, v) => { const el=$(id); if(el && v!=null) el.value=v; };
  const unitsEl = $('pref-units');
  unitsEl?.querySelectorAll('.segmented-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.value === profile.units));

  // .settings-row-unit (style.css) sits right after its row's label with
  // nothing but rendered whitespace between them ("Height cm") — a leading
  // ", " here, inside the same styled span as the unit itself, reads as
  // "Height, cm" without an unstyled comma breaking the muted unit color.
  const setUnit = (id, u) => setText(id, `, ${u}`);

  const wUnit = weightUnitLabel(profile.units);
  setUnit('weight-unit-label', wUnit);

  const toDisplayWeight = kg => profile.units === 'imperial' ? kgToLb(kg) : kg;
  // FTP and weight are left blank until the rider has entered them (the FTP
  // field's placeholder shows the 200 W that's used meanwhile). Written
  // directly rather than through set(), which skips null and would leave a
  // stale value in the field after, say, a profile restore.
  const ftpEl = $('pref-ftp');
  if (ftpEl) ftpEl.value = profile.ftp ?? '';
  const weightEl = $('pref-weight');
  if (weightEl) weightEl.value = profile.riderWeight != null ? _round1(toDisplayWeight(profile.riderWeight)) : '';
  set('pref-window', profile.chartWindow);

  // Body composition — height and the three mass fields follow the
  // metric/imperial toggle exactly like weight above (same
  // toDisplayWeight for muscle/bone/water mass, per units.js's doc comment
  // on cmToIn/inToCm: "muscle/bone/water mass reuse kgToLb()/lbToKg()
  // directly"); bodyFatPct/visceralFatRating/basalMetabolicRateKcal are
  // unit-system-independent (a %, an index, and kcal are the same number
  // either way) so they're plain set() calls with no conversion.
  const hUnit = heightUnitLabel(profile.units);
  setUnit('height-unit-label', hUnit);
  setUnit('muscle-mass-unit-label', wUnit);
  setUnit('bone-mass-unit-label', wUnit);
  setUnit('body-water-unit-label', wUnit);
  const toDisplayHeight = cm => profile.units === 'imperial' ? cmToIn(cm) : cm;
  set('pref-height',      profile.heightCm != null ? _round1(toDisplayHeight(profile.heightCm)) : null);
  set('pref-body-fat',    profile.bodyFatPct);
  set('pref-muscle-mass', profile.muscleMassKg != null ? _round1(toDisplayWeight(profile.muscleMassKg)) : null);
  set('pref-bone-mass',   profile.boneMassKg   != null ? _round1(toDisplayWeight(profile.boneMassKg))   : null);
  set('pref-body-water',  profile.bodyWaterKg  != null ? _round1(toDisplayWeight(profile.bodyWaterKg))  : null);
  set('pref-visceral-fat', profile.visceralFatRating);
  set('pref-bmr',          profile.basalMetabolicRateKcal);
  // Starts expanded if there's already saved body-composition data worth
  // seeing, collapsed otherwise — same "reflect what toggling it live would
  // leave it in" reasoning as auto-pause-triggers above, just derived from
  // saved data instead of a saved switch state (this switch has no backing
  // preference — see _toggleBodyCompPanel()'s doc comment).
  const hasBodyCompData = [
    profile.heightCm, profile.bodyFatPct, profile.muscleMassKg,
    profile.boneMassKg, profile.bodyWaterKg, profile.visceralFatRating, profile.basalMetabolicRateKcal,
  ].some(v => v != null);
  _toggleBodyCompPanel(hasBodyCompData);
  set('pref-age',    profile.age);
  const sexEl = $('pref-sex');
  if (sexEl && profile.sex) sexEl.value = profile.sex;
  const audioEl = $('pref-audio');
  if (audioEl) audioEl.checked = profile.audioCues;
  _renderBackgroundSettingsRow();
  const autoPauseEl = $('pref-auto-pause');
  if (autoPauseEl) autoPauseEl.checked = profile.autoPause;
  // Panel starts expanded/collapsed to match the switch, same as toggling
  // it live would do (see the 'change' listener in bindControls()) —
  // without this it'd always render collapsed on load/reconnect regardless
  // of the saved autoPause value.
  $('auto-pause-triggers')?.classList.toggle('hidden', !profile.autoPause);
  const idleTriggerEl = $('pref-auto-pause-trigger-idle');
  if (idleTriggerEl) idleTriggerEl.checked = !!profile.autoPauseTriggers.idle;
  const hideTriggerEl = $(AUTO_PAUSE_HIDE_ID);
  if (hideTriggerEl) hideTriggerEl.checked = !!profile.autoPauseTriggers.hide;
  const ctrlTriggerEl = $('pref-auto-pause-trigger-controller');
  if (ctrlTriggerEl) ctrlTriggerEl.checked = !!profile.autoPauseTriggers.controllerDisconnect;
  const modesTriggerEl = $('pref-auto-pause-trigger-modes');
  if (modesTriggerEl) modesTriggerEl.checked = !!profile.autoPauseTriggers.modes;
  // Same "starts in whatever state toggling it live would leave it in" logic
  // as auto-pause-triggers above, one level down: each nested checklist only
  // means anything while its own trigger row above it is on.
  $('auto-pause-controller-types')?.classList.toggle('hidden', !profile.autoPauseTriggers.controllerDisconnect);
  $('auto-pause-control-modes')?.classList.toggle('hidden', !profile.autoPauseTriggers.modes);
  for (const [kind, id] of Object.entries({
    controller: 'pref-auto-pause-ctrl-controller',
    hrm: 'pref-auto-pause-ctrl-hrm', temps: 'pref-auto-pause-ctrl-temps',
  })) {
    const el = $(id);
    if (el) el.checked = !!profile.autoPauseControllers[kind];
  }
  for (const [mode, id] of Object.entries({
    erg: 'pref-auto-pause-mode-erg', resistance: 'pref-auto-pause-mode-resistance',
    slope: 'pref-auto-pause-mode-slope', virtualGear: 'pref-auto-pause-mode-virtualGear',
  })) {
    const el = $(id);
    if (el) el.checked = !!profile.autoPauseModes[mode];
  }

  set('pref-resting-hr', profile.restingHr);
  set('pref-max-hr',     profile.maxHr);
  // When the rider hasn't entered a max HR directly, the field's
  // placeholder shows the age-based Tanaka estimate (if there's enough
  // profile data for one) instead of a generic hint — a live preview of
  // exactly what every HR-zone consumer will fall back to using, same
  // reasoning as pref-ftp's own placeholder.
  const maxHrEl = $('pref-max-hr');
  if (maxHrEl && profile.maxHr == null) {
    const est = estimateMaxHr(profile.age);
    maxHrEl.placeholder = est != null ? `≈${est}` : '—';
  }

  const targetTypeCheckboxIds = {
    [TARGET_TYPES.POWER]:      'pref-target-power',
    [TARGET_TYPES.SLOPE]:      'pref-target-slope',
    [TARGET_TYPES.RESISTANCE]: 'pref-target-resistance',
    [TARGET_TYPES.HEART_RATE]: 'pref-target-heartRate',
  };
  for (const [type, id] of Object.entries(targetTypeCheckboxIds)) {
    const el = $(id);
    if (el) el.checked = profile.enabledTargetTypes.includes(type);
  }

  _renderVo2MaxCard();
  _renderFtpTestCard();
  _renderRestingHrTestCard();
}

// Fields the Settings tab actually persists — every key here is both a
// `profile` field name and the db.setPref() key it's stored under (see
// _persistProfileFields() below), so a plain snapshot of these straight off
// `profile` doubles as exactly what a revert needs to write back.
const AUTOSAVE_PROFILE_KEYS = [
  'ftp', 'riderWeight', 'chartWindow', 'audioCues', 'autoPause', 'units',
  'enabledTargetTypes', 'autoPauseControllers', 'autoPauseModes', 'autoPauseTriggers',
  'age', 'sex', 'restingHr', 'maxHr', 'heightCm', 'bodyFatPct', 'leanBodyMassKg',
  'muscleMassKg', 'boneMassKg', 'bodyWaterKg', 'visceralFatRating', 'basalMetabolicRateKcal',
];

async function savePreferences() {
  await _persistProfileFields(_readPreferenceFieldsFromForm());
}

/** Reads every Settings field into a plain object keyed exactly like
 *  AUTOSAVE_PROFILE_KEYS/profile itself (the parsing/validation/unit-
 *  conversion logic that used to live directly in savePreferences()). */
function _readPreferenceFieldsFromForm() {
  const units  = $('pref-units')?.querySelector('.segmented-btn.active')?.dataset.value === 'imperial' ? 'imperial' : 'metric';
  // FTP and weight are optional and stay unset (null) when left blank — nothing
  // invents a number for them; see the profile defaults above.
  const ftpRaw = parseInt($('pref-ftp')?.value);
  const ftp    = ftpRaw > 0 ? ftpRaw : null;
  const win    = parseInt($('pref-window')?.value) || 300;
  const audio  = $('pref-audio')?.checked ?? true;
  const autoPause = $('pref-auto-pause')?.checked ?? false;
  // Falls back to just Power (rather than leaving the list empty) if every
  // toggle got switched off — an empty list would hide every option from
  // the Advanced Builder's target-type picker with no way back short of
  // clearing storage, the same defensive floor loadPreferences() applies
  // when reading a saved value back.
  const enabledTargetTypesRaw = [
    $('pref-target-power')?.checked      ?? true ? TARGET_TYPES.POWER      : null,
    $('pref-target-slope')?.checked      ?? true ? TARGET_TYPES.SLOPE      : null,
    $('pref-target-resistance')?.checked ?? true ? TARGET_TYPES.RESISTANCE : null,
    $('pref-target-heartRate')?.checked  ?? true ? TARGET_TYPES.HEART_RATE : null,
  ].filter(Boolean);
  const enabledTargetTypes = enabledTargetTypesRaw.length ? enabledTargetTypesRaw : [TARGET_TYPES.POWER];
  const autoPauseControllers = {
    controller:      $('pref-auto-pause-ctrl-controller')?.checked   ?? false,
    hrm:             $('pref-auto-pause-ctrl-hrm')?.checked          ?? false,
    temps:           $('pref-auto-pause-ctrl-temps')?.checked        ?? false,
  };
  const autoPauseModes = {
    erg:         $('pref-auto-pause-mode-erg')?.checked         ?? false,
    resistance:  $('pref-auto-pause-mode-resistance')?.checked  ?? false,
    slope:       $('pref-auto-pause-mode-slope')?.checked       ?? false,
    virtualGear: $('pref-auto-pause-mode-virtualGear')?.checked ?? false,
  };
  const autoPauseTriggers = {
    idle:                 $('pref-auto-pause-trigger-idle')?.checked       ?? false,
    controllerDisconnect: $('pref-auto-pause-trigger-controller')?.checked ?? false,
    modes:                $('pref-auto-pause-trigger-modes')?.checked      ?? false,
    hide:                 $(AUTO_PAUSE_HIDE_ID)?.checked                   ?? false,
  };

  // Weight field is entered in whichever unit is currently displayed —
  // convert back to canonical kg before storing/using in physics.
  // (Bike weight has no input field to read — see TYPICAL_BIKE_WEIGHT_KG.)
  const weightRaw = parseFloat($('pref-weight')?.value);
  const weight = weightRaw > 0 ? (units === 'imperial' ? lbToKg(weightRaw) : weightRaw) : null;

  // Age/sex are optional — only needed for the VO2max ramp test estimate
  // (metrics/vo2max.js) — so leave them unset rather than defaulting.
  const ageRaw = parseInt($('pref-age')?.value);
  const age    = isNaN(ageRaw) || ageRaw <= 0 ? null : ageRaw;
  const sexRaw = $('pref-sex')?.value;
  const sex    = (sexRaw === 'male' || sexRaw === 'female') ? sexRaw : null;

  // Resting/max HR are optional, same as age/sex — left unset rather than
  // defaulted, since a wrong guess here would silently skew every HR zone
  // boundary rather than just falling back to the Tanaka estimate (see
  // _resolvedMaxHr()) or the plain %max-HR zones (see hr-zones.js#usesHrr).
  const restingHrRaw = parseInt($('pref-resting-hr')?.value);
  const restingHr    = isNaN(restingHrRaw) || restingHrRaw <= 0 ? null : restingHrRaw;
  const maxHrRaw      = parseInt($('pref-max-hr')?.value);
  const maxHr          = isNaN(maxHrRaw) || maxHrRaw <= 0 ? null : maxHrRaw;

  // Body composition — all optional, same leave-unset-rather-than-default
  // reasoning as age/sex/resting-max HR above. Height and the three mass
  // fields are entered in whichever unit is currently displayed, converted
  // back to canonical cm/kg here exactly like weight above.
  const heightRaw = parseFloat($('pref-height')?.value);
  const heightCm  = isNaN(heightRaw) || heightRaw <= 0 ? null : (units === 'imperial' ? inToCm(heightRaw) : heightRaw);
  const bodyFatRaw = parseFloat($('pref-body-fat')?.value);
  const bodyFatPct = isNaN(bodyFatRaw) || bodyFatRaw <= 0 ? null : bodyFatRaw;
  // Derived, not entered directly — same relationship DIET_PANEL_DESIGN.md
  // §6 describes for a BLE scale reading, just re-run here off the
  // manually entered bodyFatPct instead (see deriveLeanBodyMassKg()'s doc
  // comment for why this is shared with _recordScaleMeasurement() below
  // rather than each inlining the formula).
  const leanBodyMassKg = deriveLeanBodyMassKg(weight, bodyFatPct);

  const muscleMassRaw = parseFloat($('pref-muscle-mass')?.value);
  const muscleMassKg  = isNaN(muscleMassRaw) || muscleMassRaw <= 0 ? null : (units === 'imperial' ? lbToKg(muscleMassRaw) : muscleMassRaw);
  const boneMassRaw = parseFloat($('pref-bone-mass')?.value);
  const boneMassKg  = isNaN(boneMassRaw) || boneMassRaw <= 0 ? null : (units === 'imperial' ? lbToKg(boneMassRaw) : boneMassRaw);
  const bodyWaterRaw = parseFloat($('pref-body-water')?.value);
  const bodyWaterKg  = isNaN(bodyWaterRaw) || bodyWaterRaw <= 0 ? null : (units === 'imperial' ? lbToKg(bodyWaterRaw) : bodyWaterRaw);
  // Unitless index and kcal — same either way regardless of units, so no
  // conversion branch, unlike every field above this one.
  const visceralFatRaw = parseInt($('pref-visceral-fat')?.value);
  const visceralFatRating = isNaN(visceralFatRaw) || visceralFatRaw <= 0 ? null : visceralFatRaw;
  const bmrRaw = parseInt($('pref-bmr')?.value);
  const basalMetabolicRateKcal = isNaN(bmrRaw) || bmrRaw <= 0 ? null : bmrRaw;

  return {
    ftp, riderWeight: weight, chartWindow: win, audioCues: audio, autoPause, autoPauseControllers, autoPauseModes, autoPauseTriggers, units, age, sex,
    restingHr, maxHr, heightCm, bodyFatPct, leanBodyMassKg, muscleMassKg, boneMassKg, bodyWaterKg, visceralFatRating, basalMetabolicRateKcal,
    enabledTargetTypes,
  };
}

/** Writes a fields object — from _readPreferenceFieldsFromForm(), or a
 *  pre-edit snapshot handed back by _revertAutosave() — to IndexedDB, folds
 *  it into the in-memory `profile`, and refreshes every view that depends
 *  on it. Shared so a revert applies exactly the same way a save does. */
async function _persistProfileFields(fields) {
  await Promise.all(AUTOSAVE_PROFILE_KEYS.map(key => db.setPref(key, fields[key])));

  Object.assign(profile, fields);
  // profile.bikeWeight is never reassigned — it stays at TYPICAL_BIKE_WEIGHT_KG
  // for the life of the app (see that constant's doc comment above).
  modeSwitch?.setFtp(_resolvedFtp());
  modeSwitch?.setRiderParams({ riderWeight: fields.riderWeight ?? DEFAULT_SIM_RIDER_WEIGHT_KG, bikeWeight: profile.bikeWeight });
  workoutEditor?.setFtp(_resolvedFtp());
  workoutEditor?.setEnabledTargetTypes(fields.enabledTargetTypes);
  quickStartFlow?.setFtp(_resolvedFtp());
  quickStartFlow?.setHrProfile({ maxHr: _resolvedMaxHr(), restingHr: profile.restingHr });
  chartCarousel?.setWindow(fields.chartWindow);
  fields.audioCues ? audioCues.enable() : audioCues.disable();

  // Units affect display only — refresh whichever views show unit-dependent
  // values (the badge bar's Distance/Pace and Speed badges, Speed's own axis, live
  // stat row, History cards/detail) immediately.
  _rebuildMetricDefs(fields.units);
  for (const key of METRIC_ORDER) chartCarousel?.updateMetricDef({ key, ...METRIC_DEFS[key] });
  _syncChartBadgeBar();
  _renderMetricStats();
  historyBrowser?.setUnits(fields.units);
  overviewPage?.load();
  dietPage?.load(); // age/sex/height/body-fat% may have just changed, which BMR depends on
  populateSettingsUI(); // reflect the canonical, rounded value back into the fields
  renderZoneStrip();    // FTP may have just changed — refresh the Power zone strip
  renderHrZoneStrip();  // resting/max HR may have just changed — refresh the HR zone strip
}

function _round1(v) { return Math.round(v * 10) / 10; }

// ─── Settings autosave ──────────────────────────────────────────────────────
// The Settings tab has no "Save Profile" button — any edit to a pref-*
// field is written to disk a moment after the rider stops (see the
// delegated 'input'/'change' listener in bindControls()), and the
// autosave-pill (index.html, fixed to the viewport's top edge) confirms it.
// _autosaveSnapshot holds AUTOSAVE_PROFILE_KEYS as `profile` stood right
// before the *first* edit in the current run — taken once per pill
// "session" and cleared on confirm/revert — so Revert always undoes the
// whole run of edits at once, not just the last keystroke, and the
// checkmark just dismisses the pill and keeps whatever's already saved.
let _autosaveSnapshot = null;
let _autosaveDebounceTimer = null;
const AUTOSAVE_DEBOUNCE_MS = 700;

function _scheduleAutosave() {
  if (_autosaveSnapshot == null) {
    const snap = {};
    for (const key of AUTOSAVE_PROFILE_KEYS) snap[key] = profile[key];
    // JSON round-trip rather than structuredClone() — every value here is
    // plain JSON (numbers/strings/nulls plus the auto-pause/target-type
    // objects and arrays), so this is a cheap, universally-supported deep
    // copy that keeps a later revert's write-back from being able to
    // mutate this snapshot back out from under itself.
    _autosaveSnapshot = JSON.parse(JSON.stringify(snap));
  }
  clearTimeout(_autosaveDebounceTimer);
  _autosaveDebounceTimer = setTimeout(async () => {
    await savePreferences();
    $('settings-autosave-pill')?.classList.remove('hidden');
  }, AUTOSAVE_DEBOUNCE_MS);
}

/** Checkmark (right) — keeps whatever's already saved, just closes the pill. */
function _confirmAutosave() {
  $('settings-autosave-pill')?.classList.add('hidden');
  _autosaveSnapshot = null;
}

/** Revert (red, left) — writes the pre-edit snapshot back over whatever's
 *  been autosaved since, then closes the pill the same way confirm does. */
async function _revertAutosave() {
  if (!_autosaveSnapshot) { _confirmAutosave(); return; }
  clearTimeout(_autosaveDebounceTimer);
  await _persistProfileFields(_autosaveSnapshot);
  _confirmAutosave();
}

/**
 * Units apply immediately on change (like the Chart Window select) rather
 * than waiting for the autosave debounce — otherwise the weight fields
 * would show stale kg/lb values next to a label that already flipped. Any
 * edits to the other fields (FTP, weight) still mid-debounce are re-drawn
 * from the last saved profile as a side effect, same as reopening the
 * Settings tab would.
 */
async function applyUnitsChange(units) {
  if (units === profile.units) return;
  profile.units = units;
  await db.setPref('units', units);

  _rebuildMetricDefs(units);
  for (const key of METRIC_ORDER) chartCarousel?.updateMetricDef({ key, ...METRIC_DEFS[key] });
  _syncChartBadgeBar();
  _renderMetricStats();
  historyBrowser?.setUnits(units);
  populateSettingsUI();
}

// ─── Device connection ────────────────────────────────────────────────────────
//
// Three kinds of device hold the "primary" slot (mutually exclusive — the
// sport's one controllable/main data source): FtmsDevice (generic FTMS
// trainer/rower/cross-trainer), MerachDevice (Sean's actual bike — has a
// real control point now, but no direct power-target op, so it gets ERG via
// the software SmartErgMode loop and stays without resistance/slope/
// virtualGear — see connectMerachBike() below), or Proform750rDevice (a
// ProForm 750R rower — same shape as Merach: a real, hardware-confirmed
// control point but no direct power-target op, so it also gets ERG via the
// software SmartErgMode loop and stays without resistance/slope/
// virtualGear — see connectProformRower() below). Everything else — HR
// strap, Moxy SmO2, core temp — is an auxiliary sensor that merges its data
// in alongside it, gated by ble/pairing-mode.js (Single = ignore aux
// readings, Multi = merge them).

/**
 * The wizard's single "Controller" connect action. A Merach bike or a
 * Proform rower IS a controller as far as the person setting up a workout
 * is concerned — they're just BLE exercise equipment identified by name
 * instead of (only) by exposing a real FTMS control point — so there's one
 * chooser covering all of them, and the right wrapper class (FtmsDevice vs
 * MerachDevice vs Proform750rDevice) is picked afterward based on which
 * device the person actually selected.
 */
// Device IDs currently mid-connect (GATT connect + init handshake running)
// or already connected as the primary controller. Without this, a manual
// "Connect Controller" pick can race reconnect.js's watchAdvertisements()
// callback for the same device (or a stray double-tap), starting a second
// device.gatt.connect()/init-handshake sequence on top of one already in
// flight. Two GATT operations racing on one device is exactly what throws
// "GATT operation already in progress" and the disconnect cascade that
// follows. Currently owned (added/removed) by connectProformRower() —
// where this race was actually observed — and checked here and in
// _reconnectDevice() before either dispatches to it; extend the same
// ownership to connectMerachBike()/connectTrainer() if they ever show the
// same symptom.
const _connectingDeviceIds = new Set();

async function connectController() {
  let device;
  try {
    device = await bleTransport.requestDevice({
      filters: [
        { services: [FTMS_SERVICE] },
        { namePrefix: MERACH_NAME_PREFIX },
        { namePrefix: PROFORM_NAME_PREFIX },
      ],
      optionalServices: [FTMS_SERVICE, PROFORM_SERVICE, 0x180d],
    });
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus('Connection failed — ' + err.message);
    return;
  }

  if (_connectingDeviceIds.has(device.id)) {
    console.warn('[app] connectController: already connecting/connected to', device.name ?? device.id, '— ignoring');
    return;
  }

  const isMerach  = device.name?.startsWith(MERACH_NAME_PREFIX);
  const isProform = device.name?.startsWith(PROFORM_NAME_PREFIX);
  reconnect.remember(device, isProform ? 'proform-750r' : (isMerach ? 'merach' : 'trainer'));
  if      (isProform) await connectProformRower(device);
  else if (isMerach)  await connectMerachBike(device);
  else                await connectTrainer(device);
}

async function connectTrainer(existingDevice = null) {
  _setDeviceStatus('controller', 'connecting');
  try {
    trainer = new FtmsDevice();
    if (existingDevice) await trainer.connectDevice(existingDevice, onTrainerData);
    else                await trainer.connect(onTrainerData);

    primaryDeviceId = trainer.id;
    reconnectCushion.markConnected(primaryDeviceId);
    priority.ensureDevice(METRICS.POWER, trainer.id);

    modeSwitch = new ModeSwitch(trainer, {
      ftp: _resolvedFtp(), riderWeight: profile.riderWeight, bikeWeight: profile.bikeWeight,
    });
    modeSwitch.subscribe(({ mode }) => updateModeUI(mode));
    modeSwitch.onIdle(autoPauseSession);
    modeSwitch.onActive(_confirmPendingStart); // resolves the "wait for pedaling" gate — see startSession()
    modeSwitch.onActive(autoResumeSession);    // pulls an auto-paused session back out of pause — see _autoResume()
    _populateModeOptions(modeSwitch);
    // Re-attach a live or restored ScriptedSession to the (re)connected
    // controller — see ScriptedSession#setModeSwitch(). No-op for a free
    // Session (it has no such method) or when there's no session yet.
    if (session instanceof ScriptedSession) session.setModeSwitch(modeSwitch);

    trainer.addEventListener('disconnected', () => _resetTrainerState());

    updateTrainerUI(true, true);
    _setDeviceStatus('controller', 'connected');
    setStatus(`Connected: ${trainer.name}`);
    audioCues.play('beep');
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus('Connection failed — ' + err.message);
    trainer = null; modeSwitch = null;
    _setDeviceStatus('controller', 'disconnected');
  }
}

/**
 * Sean's actual bike (see ble/merach-device.js). It has a real control point
 * now — start()/stop() and resistance control — but no direct power-target
 * op, so ModeSwitch gives it ERG via the software SmartErgMode loop instead
 * of a real FTMS power write, and leaves resistance/slope/virtualGear
 * unavailable (it has no resistanceRange to drive them against). See
 * control/mode-switch.js's capability-detection docs for the general rule.
 */
async function connectMerachBike(existingDevice = null) {
  _setDeviceStatus('controller', 'connecting');
  try {
    const device = new MerachDevice();
    // toPartialData() converts mph→km/h and matches the shape FtmsDevice's
    // parsers produce — raw .metrics is in Merach's own units (see its docstring).
    const onData = () => onTrainerData(device.toPartialData());
    if (existingDevice) await device.connectDevice(existingDevice, onData);
    else                await device.connect(onData);

    trainer = device;
    modeSwitch = new ModeSwitch(device, {
      ftp: _resolvedFtp(), riderWeight: profile.riderWeight, bikeWeight: profile.bikeWeight,
    });
    modeSwitch.subscribe(({ mode }) => updateModeUI(mode));
    modeSwitch.onIdle(autoPauseSession);
    modeSwitch.onActive(_confirmPendingStart); // resolves the "wait for pedaling" gate — see startSession()
    modeSwitch.onActive(autoResumeSession);    // pulls an auto-paused session back out of pause — see _autoResume()
    _populateModeOptions(modeSwitch);
    // Re-attach a live or restored ScriptedSession to the (re)connected
    // controller — see ScriptedSession#setModeSwitch(). No-op for a free
    // Session (it has no such method) or when there's no session yet.
    if (session instanceof ScriptedSession) session.setModeSwitch(modeSwitch);
    primaryDeviceId = device.id;
    reconnectCushion.markConnected(primaryDeviceId);
    priority.ensureDevice(METRICS.POWER, device.id);

    device.addEventListener('disconnected', () => _resetTrainerState());

    updateTrainerUI(true, true);
    _setDeviceStatus('controller', 'connected');
    setStatus(`Connected: ${device.name}`);
    audioCues.play('beep');
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus('Connection failed — ' + err.message);
    _setDeviceStatus('controller', 'disconnected');
  }
}

/**
 * A ProForm 750R rower (see ble/proform-device.js). It reports power and
 * stroke rate over BLE and, like MerachDevice, has a real, now
 * hardware-confirmed control point: Proform750rDevice's
 * setResistanceTarget() has no direct power-target op either, so ModeSwitch
 * gives it ERG via the same software SmartErgMode loop Merach uses, via the
 * same duck-typed capability detection (see control/mode-switch.js) — no
 * special case needed here. Resistance/virtualGear stay unavailable for it,
 * same as for Merach, since it has no resistanceRange to drive them
 * against. ModeSwitch is constructed here the same way as for FTMS/Merach;
 * its mode-independent idle/active tracking (auto-pause, the "wait for the
 * rider" gate) works off raw watts/cadence the same way regardless.
 */
async function connectProformRower(existingDevice = null) {
  const guardId = existingDevice?.id ?? null;
  if (guardId) {
    if (_connectingDeviceIds.has(guardId)) {
      console.warn('[app] connectProformRower: already connecting/connected to', guardId, '— ignoring');
      return;
    }
    _connectingDeviceIds.add(guardId);
  }

  _setDeviceStatus('controller', 'connecting');
  let device;
  try {
    device = new Proform750rDevice();
    const onData = () => onTrainerData(device.toPartialData());
    if (existingDevice) await device.connectDevice(existingDevice, onData);
    else                await device.connect(onData);

    // Only known post-connect when this opened its own chooser (no
    // existingDevice) — register it now so it stays guarded while connected.
    if (!guardId) _connectingDeviceIds.add(device.id);

    trainer = device;
    modeSwitch = new ModeSwitch(device, {
      ftp: _resolvedFtp(), riderWeight: profile.riderWeight, bikeWeight: profile.bikeWeight,
    });
    modeSwitch.subscribe(({ mode }) => updateModeUI(mode));
    modeSwitch.onIdle(autoPauseSession);
    modeSwitch.onActive(_confirmPendingStart); // resolves the "wait for pedaling" gate — see startSession()
    modeSwitch.onActive(autoResumeSession);    // pulls an auto-paused session back out of pause — see _autoResume()
    _populateModeOptions(modeSwitch);
    // Re-attach a live or restored ScriptedSession to the (re)connected
    // controller — see ScriptedSession#setModeSwitch(). No-op for a free
    // Session (it has no such method) or when there's no session yet.
    if (session instanceof ScriptedSession) session.setModeSwitch(modeSwitch);
    primaryDeviceId = device.id;
    reconnectCushion.markConnected(primaryDeviceId);
    priority.ensureDevice(METRICS.POWER, device.id);

    device.addEventListener('disconnected', () => {
      _connectingDeviceIds.delete(device.id);
      _resetTrainerState();
    });

    // ERG is now available (see docstring above), so this computed check —
    // same one connectMerachBike()/connectTrainer() rely on — lights up the
    // "controllable" UI (Control Mode / Spindown Calibration) on its own,
    // rather than needing a Proform-specific case here.
    updateTrainerUI(true, modeSwitch.availableModes.length > 0);
    _setDeviceStatus('controller', 'connected');
    setStatus(`Connected: ${device.name}`);
    audioCues.play('beep');
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus('Connection failed — ' + err.message);
    _setDeviceStatus('controller', 'disconnected');
    _connectingDeviceIds.delete(device?.id ?? guardId);
  }
}

/**
 * True while `s` is running an in-progress fitness test whose protocol
 * treats "stopped producing power" as the actual finish line, rather than
 * something to pause through:
 *   - FTP Ramp Test / VO2 Max Ramp Test: every stage asks the rider to
 *     hold a wattage, so there's no such thing as a legitimate mid-test
 *     lull — going idle at any point IS the rider reaching genuine
 *     exhaustion (see metrics/ftp-test.js / metrics/vo2max.js).
 *   - FTP 20-Minute Test: same "idle = done" logic, but only during its
 *     two self-paced maximal-effort segments (the 5-min opener and the
 *     20-minute test itself — both FREE_RIDE steps; see
 *     buildFtpTwentyMinTestWorkout()). Its warm-up/recovery/cooldown are
 *     prescribed easy-power segments where a momentary gap shouldn't end
 *     the whole test.
 * The Resting HR Test is deliberately NOT covered here — for it, idleness
 * is the entire point of the test, not a stopping condition; see the
 * separate check in both call sites below.
 * @param {Session|ScriptedSession} s
 * @returns {boolean}
 */
function _isSelfPacedTestInEffortSegment(s) {
  const testType = s?.meta?.testType;
  if (testType === FTP_RAMP_TEST_TYPE || testType === VO2MAX_TEST_TYPE) return true;
  if (testType === FTP_TWENTY_TEST_TYPE) {
    return s.currentStepInfo?.step?.type === STEP_TYPES.FREE_RIDE;
  }
  return false;
}

/**
 * Which controller-type bucket `device` falls into, for the Auto Pause
 * "Controller types" checklist (see profile.autoPauseControllers). A
 * Merach bike, a ProForm 750R rower, and a generic FTMS trainer all map to
 * the same 'controller' kind — exactly one of them is ever connected at a
 * time as the primary controller, so they share one toggle rather than
 * three (see the doc comment on profile.autoPauseControllers above for
 * why). That means this no longer needs to distinguish device type at
 * all — it's kept as its own named helper anyway (rather than inlining
 * `trainer ? 'controller' : null` at call sites) so the checklist key
 * lives in one place, and so a future controller role that *does* need
 * its own distinct toggle has an obvious spot to reintroduce that
 * distinction. Returns null when there's no controller at all.
 * @param {FtmsDevice|MerachDevice|Proform750rDevice|null} device
 * @returns {'controller'|null}
 */
function _controllerKindFor(device) {
  if (!device) return null;
  return 'controller';
}

/**
 * Whether auto-pause should actually fire right now, ANDing the master
 * Auto Pause switch (profile.autoPause) with the finer-grained per-trigger,
 * per-controller-type, and per-control-mode checklists underneath it (see
 * profile.autoPauseTriggers / profile.autoPauseControllers /
 * profile.autoPauseModes) — e.g. a rider who's turned off auto-pause for
 * their primary controller (bike/rower/trainer — because, say, a rower's
 * natural pauses between strokes were tripping idle detection) should
 * still get it from a lost HR-strap connection, and a rider who only wants
 * auto-pause on a dropped connection (not on merely stopping pedaling) can
 * leave the 'idle' trigger off.
 *
 * `kind`/`mode` default to reading the live connected controller/mode, for
 * call sites where those are still live (autoPauseSession(), fired via
 * modeSwitch.onIdle() while still connected) — but _resetTrainerState()
 * below nulls `trainer`/`modeSwitch` out before this would otherwise run,
 * so it captures both up front and passes them in explicitly instead.
 * Either being null/absent from its checklist (a kind or mode not yet
 * covered by a toggle) is treated as not gated — a missing entry isn't the
 * rider switching anything off. (The checklist entries themselves now
 * default to off, but only ever come back on together with Auto Pause
 * itself.) `trigger` is always passed explicitly by every call site below,
 * identifying which trigger is asking — the Controller types checklist only
 * applies to the 'controllerDisconnect' trigger (see the nested panel in
 * index.html), but checking autoPauseTriggers[trigger] first up here, before
 * kind/mode, keeps that gating in one place regardless of which trigger it's
 * for.
 * profile.autoPauseTriggers.modes is a further gate specifically on `mode`:
 * unlike 'idle'/'controllerDisconnect' it isn't itself a pause trigger, just
 * the on/off for the Control modes checklist as a whole — false there skips
 * the per-mode checklist entirely (every mode allowed) without touching any
 * individual mode's own saved toggle underneath it.
 * `kind` isn't limited to the primary controller — connectHrMonitor()'s
 * disconnect handler and _reconcileDeviceState() pass 'hrm'/'temps'
 * explicitly for the same Controller types checklist, gating the HR
 * monitor/core temp sensor the same way a lost primary-controller
 * connection is.
 * The 'hide' trigger (_autoPauseOnHide()) passes null for both `kind` and
 * `mode`: whether the app is on screen has nothing to do with which
 * controller is connected or which control mode is active, so those
 * checklists mustn't be able to veto it.
 * @param {'idle'|'controllerDisconnect'|'hide'} trigger
 * @param {'controller'|'hrm'|'temps'|null} [kind]
 * @param {'erg'|'resistance'|'slope'|'virtualGear'|null} [mode]
 * @returns {boolean}
 */
function _shouldAutoPause(trigger, kind = _controllerKindFor(trainer), mode = modeSwitch?.activeModeName ?? null) {
  if (!profile.autoPause) return false;
  if (trigger && !profile.autoPauseTriggers[trigger]) return false;
  if (kind && profile.autoPauseControllers[kind] === false) return false;
  if (mode && profile.autoPauseTriggers.modes !== false && profile.autoPauseModes[mode] === false) return false;
  return true;
}

/**
 * Shared cleanup for losing the primary controller — whether that's a real
 * BLE disconnect event (bike powered off, out of range) firing on either
 * FtmsDevice or MerachDevice, or the trainer-menu's Connect/Disconnect
 * toggle item calling disconnectTrainer() directly once the rider confirms.
 * Idempotent, so it's safe if both paths fire for the same disconnect (see
 * disconnectTrainer()).
 *
 * Losing the controller is one of the two auto-pause triggers now (the
 * other being rider idleness — see autoPauseSession()): a running,
 * unpaused session gets auto-paused here too (gated on the Auto Pause
 * setting — and its own 'controllerDisconnect' trigger toggle plus the
 * per-controller-type/per-mode checklists nested under it, see
 * _shouldAutoPause() — same overall gating shape as the idleness trigger),
 * since a dropped
 * connection is exactly the kind of "nobody's actually riding right now"
 * situation auto-pause exists for — UNLESS it's a fitness test, which gets
 * special handling regardless of that setting (mirroring
 * autoPauseSession()):
 *   - Resting HR Test doesn't need a controller at all, so losing one
 *     shouldn't interrupt a sit that's already in progress.
 *   - Every other fitness test can't meaningfully continue without a
 *     controller feeding it resistance/power data, so it's ended outright
 *     (see _isSelfPacedTestInEffortSegment()) rather than left auto-paused
 *     with no controller left to ever auto-resume it.
 * If a session was still waiting on _armPendingStart() (rider hasn't
 * started pedaling yet), there's no controller left to wait on, so it
 * starts now instead of leaving the rider stuck on "get on and start
 * pedaling" forever.
 */
function _resetTrainerState() {
  // Captured before trainer/modeSwitch are nulled below — _shouldAutoPause()
  // needs to know which controller/mode this disconnect was for, and there's
  // nothing left to inspect once this function is done clearing state.
  const _controllerKind = _controllerKindFor(trainer);
  const _controllerMode = modeSwitch?.activeModeName ?? null;
  if (primaryDeviceId) priority.removeDeviceAll(primaryDeviceId);
  trainer = null; modeSwitch = null; primaryDeviceId = null;
  updateTrainerUI(false, false);
  _populateModeOptions(null);
  _setDeviceStatus('controller', 'disconnected');

  if (pendingStart) {
    pendingStart = false;
    _beginSession();
  } else if (session?.isRunning && !session.isPaused && session.meta?.testType === RESTING_HR_TEST_TYPE) {
    setStatus('Trainer disconnected');
  } else if (session?.isRunning && !session.isPaused && _isSelfPacedTestInEffortSegment(session)) {
    stopSession().catch(err => console.error('[app] Failed to auto-end fitness test:', err));
  } else if (session?.isRunning && !session.isPaused && _shouldAutoPause('controllerDisconnect', _controllerKind, _controllerMode)) {
    _autoPause('Auto-paused — controller disconnected');
  } else {
    setStatus('Trainer disconnected');
  }
}

/** Called once the rider confirms disconnecting from the trainer-menu's
 *  Connect/Disconnect toggle item (see bindControls()). Tears down state
 *  immediately rather than waiting on the device's own 'disconnected'
 *  event (which still fires afterward and no-ops harmlessly against
 *  _resetTrainerState()). */
function disconnectTrainer() {
  if (!trainer) return;
  trainer.disconnect();
  _resetTrainerState();
}

/**
 * Settings → Profile → Body composition's "Sync" button. Same one-chooser-
 * covers-every-variant shape as connectController() above: a single
 * requestDevice() call combines the SIG-standard scale filters (ScaleDevice)
 * with the Fitdays/ICOMON name-prefix filter (FitdaysScaleDevice), and the
 * device the rider actually picked decides which wrapper class parses it —
 * there's no way to know which protocol a given scale speaks before the
 * chooser resolves. Whichever it turns out to be gets remembered under its
 * own reconnect kind ('scale' vs 'fitdays-scale') so _reconnectDevice() can
 * skip the chooser entirely next time.
 */
async function connectSmartScale() {
  let device;
  try {
    device = await bleTransport.requestDevice({
      filters: [
        { services: [BODY_COMPOSITION_SERVICE] },
        { services: [WEIGHT_SCALE_SERVICE] },
        { namePrefix: FITDAYS_NAME_PREFIX },
      ],
      optionalServices: [BODY_COMPOSITION_SERVICE, WEIGHT_SCALE_SERVICE, FITDAYS_SERVICE],
    });
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus('Connection failed — ' + err.message);
    return;
  }

  const isFitdays = device.name?.startsWith(FITDAYS_NAME_PREFIX);
  reconnect.remember(device, isFitdays ? 'fitdays-scale' : 'scale');
  if (isFitdays) await connectFitdaysScale(device);
  else           await connectStandardScale(device);
}

/** SIG-compliant path (Body Composition Service, or Weight Scale Service
 *  fallback) — see ble/scale-device.js. Unconfirmed against real hardware
 *  (see that file's header) but the only path that can ever report muscle
 *  mass/body water/BMR automatically, since the Fitdays unit doesn't. */
async function connectStandardScale(existingDevice = null) {
  _setScaleSyncStatus('connecting');
  try {
    const device = new ScaleDevice();
    const onData = reading => _applyScaleReading(reading, device.name);
    if (existingDevice) await device.connectDevice(existingDevice, onData);
    else                await device.connect(onData);
    scaleDevice = device;
    device.addEventListener('disconnected', () => { scaleDevice = null; _setScaleSyncStatus('idle'); });
    _setScaleSyncStatus('waiting', device.name);
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus('Connection failed — ' + err.message);
    _setScaleSyncStatus('idle');
  }
}

/** The actual physical scale this app was built against — see
 *  ble/fitdays-device.js. Weight always decodes; the rest of Body
 *  composition (fat %, muscle mass, bone mass, body water) is an *estimate*
 *  (metrics/body-composition.js) that only fills in when the rider stood on
 *  the scale holding the electrode handle with bare feet — that's what
 *  produces the composition record fitdays-device.js correlates against the
 *  settled weight (cheatsheet §3.1). A bare-feet-only weigh-in (no handle
 *  contact) still updates Weight, same as before. profile.riderWeight is
 *  the wraparound-disambiguation hint (see _decodeWeightByte() there);
 *  profile.heightCm feeds the composition estimate's resistance-index term
 *  (metrics/body-composition.js) — without it the device can still decode
 *  weight and receive the composition record, but estimateBodyComposition()
 *  has nothing to compute from, so composition fields stay null exactly as
 *  if the handle had never been held (see _setScaleSyncStatus()'s
 *  compositionEstimated === false case below). */
async function connectFitdaysScale(existingDevice = null) {
  _setScaleSyncStatus('connecting');
  try {
    const device = new FitdaysScaleDevice();
    const onData = reading => _applyScaleReading(reading, device.name);
    if (existingDevice) await device.connectDevice(existingDevice, onData, profile.riderWeight, profile.heightCm);
    else                await device.connect(onData, profile.riderWeight, profile.heightCm);
    scaleDevice = device;
    device.addEventListener('disconnected', () => { scaleDevice = null; _setScaleSyncStatus('idle'); });
    _setScaleSyncStatus('waiting', device.name);
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus('Connection failed — ' + err.message);
    _setScaleSyncStatus('idle');
  }
}

/**
 * Writes a scale reading into the Body composition fields, then autosaves
 * them — same "review, correct if it's wrong" shape the fields always had,
 * just via the Settings tab's autosave-pill/Revert now instead of a
 * fill-in-then-hit-Save-Profile step: setting .value programmatically here
 * doesn't itself fire the 'input'/'change' events bindControls()'s
 * delegated autosave listens for, so _scheduleAutosave() is called
 * explicitly below rather than relying on that. Only fields the reading
 * actually carries are touched; a Fitdays weight-only weigh-in (bare feet,
 * no handle contact — or handle contact without profile.heightCm on file,
 * see connectFitdaysScale()'s doc comment) leaves every field but Weight
 * exactly as it was, the same as a standard-GATT Weight Scale Service
 * fallback reading does. `reading.settled === false` (Fitdays mid-weigh-in
 * only — see that file's doc comment) is reported as a live "still
 * weighing" status instead, and skips both this and
 * _recordScaleMeasurement() below — it isn't a real reading yet.
 *
 * The weigh-in *itself* (as opposed to the profile fields) is recorded
 * unconditionally regardless of what happens to the form fields after —
 * see _recordScaleMeasurement().
 */
function _applyScaleReading(reading, deviceName) {
  if (reading.settled === false) {
    _setScaleSyncStatus('weighing');
    return;
  }

  _recordScaleMeasurement(reading);

  const units = profile.units;
  const toDisplayWeight = kg => units === 'imperial' ? kgToLb(kg) : kg;
  const toDisplayHeight = cm => units === 'imperial' ? cmToIn(cm) : cm;
  const set = (id, v) => { const el = $(id); if (el && v != null) el.value = _round1(v); };

  if (reading.weightKg != null)    set('pref-weight',      toDisplayWeight(reading.weightKg));
  if (reading.heightCm != null)    set('pref-height',      toDisplayHeight(reading.heightCm));
  if (reading.bodyFatPct != null)  set('pref-body-fat',    reading.bodyFatPct);
  if (reading.muscleMassKg != null) set('pref-muscle-mass', toDisplayWeight(reading.muscleMassKg));
  if (reading.boneMassKg != null)   set('pref-bone-mass',   toDisplayWeight(reading.boneMassKg));
  if (reading.bodyWaterKg != null)  set('pref-body-water',  toDisplayWeight(reading.bodyWaterKg));
  if (reading.visceralFatRating != null) set('pref-visceral-fat', reading.visceralFatRating);
  if (reading.basalMetabolicRateKcal != null) set('pref-bmr', reading.basalMetabolicRateKcal);
  // Both visceral fat rating and BMR are now populated by the Fitdays
  // composition estimate (metrics/body-composition.js) on the same terms
  // as bodyFatPct/muscleMassKg/etc above — only on a reading where the
  // rider held the electrode handle bar with bare feet on the plate, and
  // only once profile.heightCm is on file. A standard-GATT scale never
  // reports visceral fat rating regardless (not part of that
  // characteristic); it does report BMR itself on some models, same as
  // muscleMassKg/bodyWaterKg above.

  _setScaleSyncStatus('synced', deviceName, reading);
  setStatus(`${deviceName} synced`);
  _scheduleAutosave();
}

/**
 * Persists a settled scale reading as a permanent BodyMeasurement row — the
 * weigh-in *history*, same "recorded regardless of whether the rider
 * applies it" pattern _saveFtpTestResult() already uses for FTP-test
 * results, just via db.saveBodyMeasurement()'s autoIncrement history store
 * instead of a single scalar db.setPref(). This is independent of the Body
 * composition form fields _applyScaleReading() fills in above: this row is
 * written unconditionally the moment the scale settles, regardless of
 * whether the rider then reverts the autosaved profile fields (a misread
 * still happened — the weigh-in history should say so — even if it
 * shouldn't overwrite the rider's actual body-composition profile).
 *
 * leanBodyMassKg isn't part of either device's reading shape (see
 * ble/scale-device.js's/ble/fitdays-device.js's reading shapes) — derived
 * here via deriveLeanBodyMassKg(), the same helper savePreferences() uses
 * for a manual entry. muscleMassKg/bodyWaterKg are copied straight through
 * when either device reports them — the standard-GATT path via its own
 * characteristic fields, the Fitdays path via its composition estimate
 * (fitdays-device.js/metrics/body-composition.js), which only fires when
 * the rider held the electrode handle with bare feet on the plate; a
 * Fitdays weight-only weigh-in leaves them null, same as before.
 * boneMassKg is now also Fitdays-composition-estimated when available
 * (never reported by the standard-GATT path). basalMetabolicRateKcal comes
 * from either source now too — standard-GATT's own characteristic field,
 * or (as of the composition estimate's Katch-McArdle step) the Fitdays
 * path, both landing in the same reading.basalMetabolicRateKcal. Same for
 * visceralFatRating on the Fitdays side (a from-fat-mass regression, see
 * body-composition.js), though the standard-GATT path still never reports
 * it — not part of that characteristic.
 *
 * overviewPage's Weight & Composition card reads this store (see
 * views/overview.js's _bodyCard()), which is why overviewPage.load() below
 * matters: it redraws that card the moment a new weigh-in lands. dietPage
 * doesn't read bodyMeasurements yet — DIET_PANEL_DESIGN.md §7 calls for it,
 * and its load() below is the one place that'll need touching when it does.
 */
async function _recordScaleMeasurement(reading) {
  const measurement = createBodyMeasurement({
    source: MEASUREMENT_SOURCES.BLE_SCALE,
    weightKg: reading.weightKg ?? null,
    bodyFatPct: reading.bodyFatPct ?? null,
    leanBodyMassKg: deriveLeanBodyMassKg(reading.weightKg, reading.bodyFatPct),
    muscleMassKg: reading.muscleMassKg ?? null,
    boneMassKg: reading.boneMassKg ?? null,
    bodyWaterKg: reading.bodyWaterKg ?? null,
    visceralFatRating: reading.visceralFatRating ?? null,
    basalMetabolicRateKcal: reading.basalMetabolicRateKcal ?? null,
  });

  try {
    await db.saveBodyMeasurement(measurement);
  } catch (err) {
    // A failed history write shouldn't block the rider from reviewing/
    // saving the fields _applyScaleReading() already filled in — log and
    // move on, same "don't let a storage error break the live flow"
    // stance session-persistence.js's own save failures take.
    console.error('[scale] Failed to save body measurement:', err);
    return;
  }
  overviewPage?.load();
  dietPage?.load();
}

/**
 * Settings-only status line under the Sync button (#scale-sync-status) —
 * a settings-row-sub, same role as #vo2max-result/#ftp-test-result, just
 * updated live through a connect rather than "test complete" once.
 *
 * `reading` (only meaningful for state 'synced') is the just-applied
 * reading from _applyScaleReading() — its `compositionEstimated` flag
 * (set by fitdays-device.js's _tryMatchComposition(), per that file's doc
 * comment) is what lets this line tell the rider *which* of the Fitdays
 * scale's two outcomes just happened, rather than a generic "synced" that
 * reads the same whether or not the handle was actually held:
 *   - true  → a composition record correlated and the estimate ran (i.e.
 *     the rider held the electrode handle with bare feet on the plate) —
 *     caveat that the composition fields are an estimate, not a hardware
 *     measurement (see metrics/body-composition.js's LIMITATIONS section).
 *   - false → a composition record correlated but estimateBodyComposition()
 *     still returned null — today that only happens when profile.heightCm
 *     isn't on file yet (see connectFitdaysScale()'s doc comment); point
 *     the rider at Height rather than leaving them guessing why nothing
 *     but Weight changed.
 *   - undefined → either a standard-GATT reading (that path's composition,
 *     when present, is a real hardware measurement, not an estimate — no
 *     caveat needed) or a Fitdays weight-only weigh-in (bare feet only, no
 *     handle contact — nothing to caveat, Weight is the whole story).
 */
function _setScaleSyncStatus(state, name, reading) {
  const messages = {
    idle:       '', // the "Not synced" flag next to the info-btn covers this — no redundant caption below
    connecting: 'Connecting…',
    waiting:    `Connected to ${name ?? 'scale'} — step on to weigh in.`,
    weighing:   'Weighing…',
    synced:     _scaleSyncedMessage(name, reading),
  };
  const el = $('scale-sync-status');
  if (el) {
    el.textContent = messages[state] ?? messages.idle;
    el.hidden = state === 'idle';
  }
  // Same short inline flag the test rows use — only for the fully-idle
  // "never synced" state, not for the in-progress connecting/weighing
  // states (those already say so themselves in the caption above, a
  // "Not synced" flag next to the icon while it's visibly mid-sync would
  // just be confusing).
  _setWarn('scale-sync-warn', state === 'idle');
}

function _scaleSyncedMessage(name, reading) {
  const who = name ?? 'scale';
  if (reading?.compositionEstimated === true) {
    return `Synced from ${who} — estimated body composition, saved automatically. Review below and tap Revert on the pill above if it looks off.`;
  }
  if (reading?.compositionEstimated === false) {
    return `Synced from ${who} — weight synced, but composition couldn't be estimated (add Height above, then step back on). Saved automatically — Revert above if it looks off.`;
  }
  return `Synced from ${who} — saved automatically. Review below and tap Revert on the pill above if it looks off.`;
}

/**
 * Body composition's own disclosure control (see index.html's #body-comp-
 * toggle/#body-comp-panel) — a switch, same look as Auto Pause's Control
 * modes row below, but with no backing on/off preference of its own: open/
 * closed state lives purely in the checkbox's own DOM state rather than
 * profile (see bindControls()'s change listener, which mirrors pref-auto-
 * pause-trigger-modes' pattern exactly). `expand` omitted just flips
 * whatever the current state is; passed explicitly by populateSettingsUI()
 * to start checked/expanded when there's already saved body-composition
 * data worth seeing.
 */
function _toggleBodyCompPanel(expand) {
  const toggle = $('body-comp-toggle');
  const panel  = $('body-comp-panel');
  if (!toggle || !panel) return;
  const willExpand = expand ?? !toggle.checked;
  toggle.checked = willExpand;
  panel.classList.toggle('hidden', !willExpand);
}

/**
 * Shared cleanup for losing the HR monitor — whether that's a real BLE
 * 'disconnected' event firing (strap powered off, out of range) or
 * disconnectAuxSensor() calling this directly right after the person
 * confirms disconnecting from the trainer-menu/sensor-chip. Idempotent
 * (see the auxSensors.has() guard up front), so it's safe if both paths
 * fire for the same disconnect — same shape as _resetTrainerState(), and
 * for the same reason: BleGattDisconnect (NativeBridgeMethods.cs) disposes
 * its connection-state watcher *before* calling CancelConnection(), so a
 * person-initiated disconnect never gets its own 'gattserverdisconnected'
 * relayed back to JS — only an unexpected/remote one does, where that
 * watcher is still alive. Trainer disconnect is immune to this because
 * disconnectTrainer() never waited on the event either; this gives the HR
 * monitor the same immunity instead of changing the native side.
 */
function _resetHrmState() {
  const hrm = auxSensors.get('hr-monitor');
  if (!hrm) return; // already reset
  roles.unregister('hr-monitor');
  priority.removeDeviceAll('hr-monitor');
  auxSensors.delete('hr-monitor');
  renderSensorChips();
  // An accidental drop (strap lost skin contact, wandered out of range) starts listening for that
  // same strap to come back; a deliberate disconnect paused it first (disconnectAuxSensor()), so
  // it falls through to a plain 'disconnected' and stays that way until the rider reconnects.
  if (!_watchForHrmReturn(hrm.instance?.id)) _setDeviceStatus('hrm', 'disconnected');
  // Same 'controllerDisconnect' trigger/Controller-types gating as
  // losing the primary trainer (see _resetTrainerState()) — just for
  // the 'hrm' kind instead, so a rider who only cares about losing the
  // trainer can leave this one off in the Controller types checklist.
  if (session?.isRunning && !session.isPaused && _shouldAutoPause('controllerDisconnect', 'hrm')) {
    _autoPause('Auto-paused — heart rate monitor disconnected');
  }
}

// ── HR strap auto-reconnect ───────────────────────────────────────────────────────────────────
// A remembered strap (ble/reconnect.js, kind 'hr') comes back on its own in two situations:
//   - at launch, like every other remembered device (reconnect.start() in init), and
//   - after it drops mid-session, which start() can't cover — its watches are armed once at launch
//     and disarm after the first advertisement — so _watchForHrmReturn() re-arms just this strap.
// A strap the rider disconnected on purpose is paused (disconnectAuxSensor()) and never comes back
// by itself. While a watch is open the live strength screen's slot shows 'reconnecting', and tapping
// it hands control back to the rider: the watch is dropped and the chooser opens.
let _hrmReconnectId = null;   // BLE id of the strap we're waiting on, or null
let _hrmConnecting = false;   // a connect (chooser or automatic) is in flight
let _hrmAutoFailures = 0;     // consecutive failed automatic attempts
const HRM_AUTO_RETRY_LIMIT = 3;
const HRM_AUTO_RETRY_DELAY_MS = 1500;

/** The status the HR strap is in right now, for anything mounting after the fact. */
function _hrmStatusNow() {
  if (auxSensors.has('hr-monitor')) return 'connected';
  if (_hrmConnecting) return 'connecting';
  return _hrmReconnectId ? 'reconnecting' : 'disconnected';
}

/**
 * Starts waiting for a dropped strap to advertise again. Returns true when it will wait (the status
 * is already 'reconnecting'), false when it won't — not remembered, paused by the rider, or no
 * transport support — so the caller can settle on 'disconnected' in the same breath. The check is
 * synchronous on purpose: the slot goes straight from the strip to the pulsing button with no
 * "disconnected" frame in between; arming the watch finishes in the background and falls back to
 * 'disconnected' if the transport can't hand the device back.
 */
function _watchForHrmReturn(deviceId) {
  if (!deviceId || !reconnect.isSupported() || reconnect.isPaused(deviceId)) return false;
  if (!reconnect.remembered().some(m => m.id === deviceId)) return false;
  _hrmReconnectId = deviceId;
  _setDeviceStatus('hrm', 'reconnecting');
  reconnect.watch(deviceId, device => _reconnectDevice(device)).then(armed => {
    if (!armed && _hrmReconnectId === deviceId && !_hrmConnecting) {
      _hrmReconnectId = null;
      _setDeviceStatus('hrm', _hrmStatusNow());
    }
  }).catch(() => {});
  return true;
}

/** @param {BluetoothDevice} [existingDevice]  a handle from ble/reconnect.js — skips the chooser */
async function connectHrMonitor(existingDevice = null) {
  if (auxSensors.has('hr-monitor') || _hrmConnecting) return;
  // A rider tap while we're waiting for the old strap: they're choosing for themselves now.
  if (!existingDevice && _hrmReconnectId) {
    reconnect.unwatch(_hrmReconnectId);
    _hrmReconnectId = null;
  }
  _hrmConnecting = true;
  _setDeviceStatus('hrm', 'connecting');
  try {
    const device = new HrDevice();
    if (existingDevice) await device.connectDevice(existingDevice);
    else                await device.connect();

    roles.register('hr-monitor', [ROLES.HEART_RATE_MONITOR]);
    priority.ensureDevice(METRICS.HEART_RATE, 'hr-monitor');
    reconnectCushion.markConnected('hr-monitor');
    auxSensors.set('hr-monitor', { id: 'hr-monitor', name: device.name, kind: 'hr', instance: device });

    device.addEventListener('data', e => onAuxData('hr-monitor', e.detail));
    // Only the strap that is current may reset the state — a stale instance's late event (the
    // transport reuses device objects across reconnects) must not tear down its replacement.
    device.addEventListener('disconnected', () => {
      if (auxSensors.get('hr-monitor')?.instance === device) _resetHrmState();
    });

    _hrmReconnectId = null;
    _hrmAutoFailures = 0;
    _hrmConnecting = false;
    renderSensorChips();
    _setDeviceStatus('hrm', 'connected');
    setStatus('Heart rate monitor connected');
  } catch (err) {
    _hrmConnecting = false;
    if (err.name !== 'NotFoundError') setStatus('Connection failed — ' + err.message);
    // A failed *automatic* attempt (the strap advertised but wouldn't take a connection — typically
    // a strap that is still waking up) tries again a few times before giving the slot back to the
    // rider as a plain Connect button.
    const id = existingDevice?.id;
    if (id && ++_hrmAutoFailures <= HRM_AUTO_RETRY_LIMIT && reconnect.isSupported() && !reconnect.isPaused(id)) {
      _hrmReconnectId = id;
      _setDeviceStatus('hrm', 'reconnecting');
      setTimeout(() => {
        // The rider may have taken over, or the strap come back some other way, meanwhile.
        if (_hrmReconnectId !== id || auxSensors.has('hr-monitor') || _hrmConnecting) return;
        reconnect.watch(id, device => _reconnectDevice(device)).then(armed => {
          if (!armed && _hrmReconnectId === id && !_hrmConnecting) {
            _hrmReconnectId = null;
            _setDeviceStatus('hrm', _hrmStatusNow());
          }
        }).catch(() => {});
      }, HRM_AUTO_RETRY_DELAY_MS);
      return;
    }
    _hrmReconnectId = null;
    _hrmAutoFailures = 0;
    _setDeviceStatus('hrm', 'disconnected');
  }
}

async function connectSmo2Monitor(existingDevice = null) {
  _setDeviceStatus('smo2', 'connecting');
  try {
    const device = new MoxyDevice();
    if (existingDevice) await device.connectDevice(existingDevice, data => onAuxData(device.id, data));
    else                await device.connect(data => onAuxData(device.id, data));

    priority.ensureDevice(METRICS.SMO2, device.id);
    reconnectCushion.markConnected(device.id);
    auxSensors.set(device.id, { id: device.id, name: device.name, kind: 'smo2', instance: device });
    renderSensorChips();
    _setDeviceStatus('smo2', 'connected');
    setStatus(`${device.name} connected`);
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus('Connection failed — ' + err.message);
    _setDeviceStatus('smo2', 'disconnected');
  }
}

async function connectCoreTempSensor(existingDevice = null) {
  _setDeviceStatus('coreTemp', 'connecting');
  try {
    const device = new CoreTempDevice();
    if (existingDevice) await device.connectDevice(existingDevice, data => onAuxData(device.id, data));
    else                await device.connect(data => onAuxData(device.id, data));

    priority.ensureDevice(METRICS.CORE_TEMP, device.id);
    reconnectCushion.markConnected(device.id);
    auxSensors.set(device.id, { id: device.id, name: device.name, kind: 'coreTemp', instance: device });
    renderSensorChips();
    _setDeviceStatus('coreTemp', 'connected');
    setStatus(`${device.name} connected`);
  } catch (err) {
    if (err.name !== 'NotFoundError') setStatus('Connection failed — ' + err.message);
    _setDeviceStatus('coreTemp', 'disconnected');
  }
}

function disconnectAuxSensor(id) {
  // The rider told this strap to go: pause it *before* disconnecting so neither the drop handler
  // nor a leftover watch can bring it straight back (see ble/reconnect.js pause()). Reconnecting it
  // by hand later (remember() in HrDevice.connect()) lifts the pause again.
  if (id === 'hr-monitor') {
    const bleId = auxSensors.get(id)?.instance?.id;
    if (bleId) reconnect.pause(bleId);
    _hrmReconnectId = null;
  }
  auxSensors.get(id)?.instance?.disconnect();
  // HrDevice's own 'disconnected' event isn't reliable for a person-
  // initiated disconnect specifically (see _resetHrmState()'s doc comment
  // for why), so reset immediately here too — idempotent against that
  // event firing afterward, same belt-and-suspenders shape as
  // disconnectTrainer()/_resetTrainerState().
  if (id === 'hr-monitor') _resetHrmState();
  // Moxy/CoreTemp unregister their role internally on gattserverdisconnected,
  // which _reconcileDeviceState() picks up via the next capabilities notification.
  // Untested whether they hit the same native-event gap as HrDevice did —
  // worth checking if their menu buttons show the same stuck-connected
  // symptom after a person-initiated disconnect.
}

function onTrainerData(data) {
  // Still settling after (re)connecting — see ble/reconnect-cushion.js —
  // so this tick's reading (power/cadence/speed/HR-from-trainer, whatever
  // this particular device reports) is held back rather than risking a
  // spurious post-connect value landing on the chart/recorded samples.
  if (primaryDeviceId && reconnectCushion.isSettling(primaryDeviceId)) return;
  if (primaryDeviceId) deviceManager.update(primaryDeviceId, data);
  if (session?.isRunning) session.pushData?.(data);
  // Feed whichever mode is currently active (no-op unless it wants a live
  // feedback loop — today that's only SmartErgMode, for devices like the
  // Merach that hold an ERG target by nudging resistance off measured power
  // rather than a single control-point write) AND ModeSwitch's own
  // mode-independent idle/activity tracking (see control/mode-switch.js#
  // _checkActivity), which drives auto-pause and the pending-start gate
  // for any mode, not just SmartErgMode.
  if (modeSwitch && data.power != null) {
    modeSwitch.onPowerSample(data.power, data.cadence ?? 0, data.speed ?? 0);
  }
  // Pre-session, the stat row has no recorded buffer to read yet — reflect
  // the raw tick directly. Once a session is running, onSample (below) drives
  // it instead, at the recorded 1Hz cadence rather than every raw BLE notify.
  if (!session?.isRunning) _renderMetricStats();
}

/** Auxiliary sensor data (HR/SmO2/CoreTemp) — gated by pairing mode. */
function onAuxData(id, data) {
  // Still settling after (re)connecting — see ble/reconnect-cushion.js —
  // so hold this tick back rather than risk a spurious post-connect
  // reading (e.g. a heart-rate strap's stray 0 before it locks onto a
  // real signal) landing on the chart in this device's own color.
  if (reconnectCushion.isSettling(id)) return;
  deviceManager.update(id, data);
  if (!pairingMode.isDeviceActive(id, primaryDeviceId)) return; // Single mode: ignore aux readings
  if (session?.isRunning) session.pushData?.(data);
  else _renderMetricStats();
  // A strength session has no trainer of its own to feed onTrainerData(), so
  // this is the only path its live heart rate (and set-tracker.js's per-set
  // HR summaries, computed from strengthSession.samples after the fact) ever
  // arrives through.
  if (strengthSession?.isRunning) strengthSession.pushData?.(data);
}

/**
 * Reconciles local UI state (trainer slot + sensor chips) against
 * ble/roles.js after any capabilities change. Needed for the device
 * classes that don't dispatch their own JS disconnect event (Moxy,
 * CoreTemp, Merach) — they only call roles.unregister() internally.
 */
function _reconcileDeviceState() {
  const active = roles.snapshot();

  if (primaryDeviceId && trainer && !(trainer instanceof FtmsDevice) && !active[primaryDeviceId]) {
    // Same teardown as a real 'disconnected' event — routes through
    // _resetTrainerState() so the auto-pause-on-disconnect and
    // pending-start fallback behave the same regardless of which path
    // noticed the drop (see _resetTrainerState()'s docstring).
    _resetTrainerState();
  }

  for (const id of [...auxSensors.keys()]) {
    if (!active[id]) {
      const meta = auxSensors.get(id);
      auxSensors.delete(id);
      // Moxy/CoreTemp don't dispatch their own JS 'disconnected' event (see
      // note above), so this is the only place their wizard dot gets reset.
      if (meta?.kind === 'smo2')     _setDeviceStatus('smo2', 'disconnected');
      if (meta?.kind === 'coreTemp') {
        _setDeviceStatus('coreTemp', 'disconnected');
        // Same 'controllerDisconnect' trigger/Controller-types gating as
        // losing the primary trainer or the HR monitor (see
        // _resetTrainerState()/connectHrMonitor()) — 'temps' kind, gated
        // through the Controller types checklist's Core temp sensor toggle.
        if (session?.isRunning && !session.isPaused && _shouldAutoPause('controllerDisconnect', 'temps')) {
          _autoPause('Auto-paused — core temp sensor disconnected');
        }
      }
    }
  }

  renderSensorChips();
}

/**
 * Every sensor connect happens through the workout setup wizard, so
 * there's no scenario where a device is connected but the person doesn't
 * want its readings used — so this just derives the mode from whether any
 * auxiliary sensor is currently connected instead of asking.
 */
function _syncPairingMode() {
  pairingMode.set(auxSensors.size > 0 ? PAIRING_MODES.MULTI : PAIRING_MODES.SINGLE);
}

/** Auto-reconnect dispatcher — picks the right wrapper class by remembered kind. */
async function _reconnectDevice(device) {
  if (_connectingDeviceIds.has(device.id)) {
    console.warn('[reconnect] already connecting/connected to', device.id, '— ignoring duplicate advertisement');
    return;
  }

  const meta = reconnect.remembered().find(m => m.id === device.id);
  const kind = meta?.kind ?? 'trainer';
  try {
    if      (kind === 'trainer')      await connectTrainer(device);
    else if (kind === 'merach')       await connectMerachBike(device);
    else if (kind === 'proform-750r') await connectProformRower(device);
    else if (kind === 'smo2')         await connectSmo2Monitor(device);
    else if (kind === 'coreTemp')     await connectCoreTempSensor(device);
    else if (kind === 'scale')        await connectStandardScale(device);
    else if (kind === 'fitdays-scale') await connectFitdaysScale(device);
    else if (kind === 'hr')           await connectHrMonitor(device);
  } catch (err) {
    console.warn('[reconnect] failed to restore', kind, err);
  }
}

function _sensorIcon(kind) {
  return { hr: 'icon-heart', smo2: 'icon-droplet', coreTemp: 'icon-thermometer' }[kind] ?? 'icon-dot';
}

function renderSensorChips() {
  const wrap = $('sensor-chips');
  if (!wrap) return;
  wrap.innerHTML = '';

  if (trainer && !(trainer instanceof FtmsDevice)) {
    wrap.appendChild(_buildChip('icon-bike', trainer.name, () => {
      trainer.disconnect();
      trainer = null; modeSwitch = null; primaryDeviceId = null;
      updateTrainerUI(false, false);
      _setDeviceStatus('controller', 'disconnected');
    }));
  }
  for (const { id, name, kind } of auxSensors.values()) {
    wrap.appendChild(_buildChip(_sensorIcon(kind), name, () => disconnectAuxSensor(id)));
  }

  // Keep the trainer-menu's own Connect/Disconnect buttons for the aux
  // roles in sync too — the sensor chips above are the quick "✕ to drop"
  // path; the menu buttons are the confirm-guarded path for the same
  // action (see the trainer-menu-connect-* handlers in bindControls()).
  const hrm      = auxSensors.get('hr-monitor');
  const smo2     = _findAuxByKind('smo2');
  const coreTemp = _findAuxByKind('coreTemp');
  _updateDeviceMenuItem('hrm',      !!hrm,      hrm?.name);
  _updateDeviceMenuItem('smo2',     !!smo2,     smo2?.name);
  _updateDeviceMenuItem('coreTemp', !!coreTemp, coreTemp?.name);

  _syncPairingMode();
}

function _buildChip(iconId, label, onRemove) {
  const chip = document.createElement('div');
  chip.className = 'sensor-chip';
  chip.innerHTML = `
    <svg class="btn-icon sensor-chip-icon" viewBox="0 0 24 24"${iconId === 'icon-dot' ? ' style="fill:currentColor;stroke:none"' : ''}><use href="#${iconId}"/></svg>
    <span class="sensor-chip-label"></span>
    <button class="sensor-chip-x" aria-label="Disconnect"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg></button>
  `;
  const span = chip.querySelector('.sensor-chip-label');
  span.textContent = label;
  span.title = label; // full name still reachable once the label truncates on small screens
  chip.querySelector('.sensor-chip-x').addEventListener('click', onRemove);
  return chip;
}

// ─── Session ──────────────────────────────────────────────────────────────────

function _sessionCallbacks(workoutName) {
  return {
    workoutName,
    // Session and ScriptedSession both call onSample(sample, buffer) — buffer
    // is the authoritative recorded-samples array regardless of which one is
    // running (ScriptedSession doesn't expose its own .samples getter), so
    // it's what drives the current/average/peak stat row while a session is up.
    onSample: (sample, buffer) => {
      chartCarousel.push(sample);
      chartBadgeBar?.setLatest(sample);
      chartCarousel.setLaps(session?.laps?.marks ?? []);
      updateElapsed(sample.elapsedTime);
      liveSampleBuffer = buffer;
      _renderMetricStats();
      _updateResumeBar();
      _syncBackgroundSession();
    },
    onEnd: async (record) => {
      _releaseWakeLockIfIdle();
      _syncBackgroundSession(); // session.isRunning is already false here — drops the service/notification
      await onSessionComplete(record);
    },
  };
}

/**
 * Releases the shared screen wake lock (ux/wake-lock.js) only once neither
 * a cardio ride nor a strength session is still running. Both acquire the
 * same singleton — there's only ever one screen to keep on — so a plain
 * wakeLock.release() the moment either one ends would turn the screen back
 * off out from under the other if a rider ever has both going at once
 * (logging strength sets while riding, however unlikely). acquire() has no
 * such hazard: it's a no-op once already held, so both call sites can just
 * call it unconditionally on start/resume.
 */
function _releaseWakeLockIfIdle() {
  if (session?.isRunning || strengthSession?.isRunning) return;
  wakeLock.release();
}

// ─── Background keep-alive (native shell) ────────────────────────────────────
//
// Keeps a running workout alive while the rider switches apps or locks the
// phone. Inside the Android MAUI shell that's a foreground service plus an
// ongoing tray notification (live metrics + a system-drawn elapsed timer) —
// see platform/background-session.js for the contract and
// Ergnova/Platforms/Android/ErgnovaSessionService.cs for the native half.
// Everywhere else (browser/PWA, Windows, Mac Catalyst, iOS) the module
// reports "unsupported", every call below is a no-op, and the app keeps its
// old pause-and-snapshot-on-hide behavior (see _checkpointWorkouts()).
//
// This file never talks to the bridge directly: it only tells the module what
// SHOULD be showing right now (_syncBackgroundSession() → sync(snapshot)) and
// the module decides when to start, update (throttled ~1/s) and stop the
// service — including when the rider flips the setting off mid-session.

const BACKGROUND_CHECKPOINT_MS = 30_000; // crash-recovery snapshot cadence while the page is hidden and kept alive
let _bgSafetyTimer = null;               // 1 Hz reconcile — see _initBackgroundSession()
let _bgCheckpointTimer = null;           // see _startBackgroundCheckpointTimer()
let _bgPermissionAsked = false;          // notification permission is requested at most once per launch (plus whenever the rider re-enables the setting)
let _bgPermissionPending = false;        // system permission dialog in flight — the service isn't started underneath it
let _bgNotificationBannerShown = false;  // the "notifications are blocked" banner shows once per launch, not once per workout
let _restoredCardioAwaitingOpen = false; // a cardio session rebuilt from a snapshot that's still sitting on the resume banner — not in progress yet, so no notification

/**
 * Runs once at startup (fire-and-forget from init(), so a slow native round
 * trip can never hold up the app's own startup). Reads what the shell
 * supports, applies the rider's saved setting, and — only when the shell can
 * actually keep the app alive — starts a 1 Hz reconcile so the native
 * service can never outlive the workout it was started for, whichever path
 * ended it.
 */
async function _initBackgroundSession() {
  backgroundSession.onProblem(_showBackgroundProblemBanner);
  backgroundSession.onAction(_handleBackgroundAction);
  backgroundSession.setEnabled(profile.backgroundNotification);
  await backgroundSession.init();
  if (!backgroundSession.isSupported) return;
  _renderBackgroundSettingsRow();
  if (!_bgSafetyTimer) _bgSafetyTimer = setInterval(_syncBackgroundSession, 1000);
  _syncBackgroundSession();
}

/** Current-step summary for a scripted workout, or null for a free ride. */
function _backgroundStepInfo() {
  if (!(session instanceof ScriptedSession)) return null;
  const info = session.currentStepInfo;
  if (!info) return null;
  const { step, stepIndex, stepCount, stepRemaining, targetNow } = info;
  // Same naming rule as the HUD (see updateScriptedHUD()): a single-step
  // workout is labelled by its own name, anything else by its step type.
  const redundantName = stepCount <= 1 && !!step.name && step.name === session.workoutName;
  return {
    index: stepIndex,
    count: stepCount,
    label: redundantName ? step.name : _typeLabel(step.type),
    remainingSec: stepRemaining,
    targetLabel: step.targetType === TARGET_TYPES.NONE ? null : _stepTargetNowLabel(step, targetNow),
  };
}

/**
 * Which workout the tray notification describes — and therefore which one its
 * Pause / Play button controls: 'cardio', 'strength', or null when nothing is
 * in progress. Cardio wins if both are somehow running (see the
 * capabilities.subscribe() comment in init() — they're mutually exclusive in
 * practice). A session that was only rebuilt from a crash-recovery snapshot
 * and is still waiting on its resume banner is deliberately NOT "in
 * progress": nothing is recording, and a non-dismissable notification for it
 * would be a lie. strengthPanel is only mounted once the rider has actually
 * opened the session (fresh start, or Resume on the restore banner) — same
 * reasoning.
 */
function _backgroundWorkoutKind() {
  if (session && !_restoredCardioAwaitingOpen && (pendingStart || session.isRunning)) return 'cardio';
  if (strengthSession?.isRunning && strengthPanel) return 'strength';
  return null;
}

/**
 * What the tray notification should show right now, or null when no workout
 * is in progress (see _backgroundWorkoutKind()).
 */
function _computeBackgroundSnapshot() {
  const kind = _backgroundWorkoutKind();
  if (kind === 'cardio') {
    const waiting = pendingStart;
    const samples = liveSampleBuffer.length ? liveSampleBuffer : (session.samples ?? []);
    return buildCardioSnapshot({
      title:      session.workoutName,
      status:     waiting ? 'waiting' : session.isPaused ? 'paused' : 'running',
      elapsedSec: waiting ? 0 : session.elapsedSec,
      sample:     samples[samples.length - 1] ?? null,
      metricDefs: METRIC_DEFS,
      metricOrder: METRIC_ORDER,
      units:      profile.units,
      step:       waiting ? null : _backgroundStepInfo(),
    });
  }

  if (kind === 'strength') {
    const sets = strengthTracker?.sets ?? [];
    const pending = strengthTracker?.pendingSet ?? null;
    const lastDoneAt = sets.length ? sets[sets.length - 1].completedAt : null;
    const samples = strengthSession.samples ?? [];
    return buildStrengthSnapshot({
      title:      strengthSession.workoutName,
      status:     strengthSession.isPaused ? 'paused' : 'running',
      elapsedSec: strengthSession.elapsedSec,
      sample:     samples[samples.length - 1] ?? null,
      setCount:   sets.length,
      activeExercise: pending?.exercise ?? null,
      restSec:    !pending && lastDoneAt ? (Date.now() - lastDoneAt) / 1000 : null,
      metricDefs: METRIC_DEFS,
    });
  }
  return null;
}

/**
 * Hands the module the desired state. Cheap and idempotent (the module
 * dedupes and throttles), so it's called both at every session transition —
 * so pause/resume/stop reach the tray immediately — and from the 1 Hz
 * reconcile started in _initBackgroundSession(), which is what guarantees a
 * stale "workout running" notification can't outlive its workout even if
 * some end path forgot to call this.
 */
function _syncBackgroundSession() {
  if (_bgPermissionPending) return; // don't bring the service up underneath the system permission dialog
  try {
    backgroundSession.sync(_computeBackgroundSnapshot());
  } catch (err) {
    console.warn('[app] background session sync failed', err);
  }
}

/**
 * The tray notification's Pause / Play button (platform/background-session.js
 * → onAction()). Runs the very same code path as the on-screen button —
 * togglePause() for a cardio workout, toggleStrengthPause() for a strength
 * one — so the in-app UI, the recording, the crash-recovery snapshot and the
 * notification itself can't disagree about what state the workout is in.
 *
 * Both actions are requests, applied only if they still make sense: the
 * notification can lag the page by a moment, so a tap on "Pause" may arrive
 * after the workout already paused itself (auto-pause) and must not toggle it
 * straight back on. That's why this checks the current state instead of
 * calling the toggles blindly. "Play" from a cardio workout that's still
 * armed and waiting for the first pedal stroke means "start now" — the same
 * thing the in-app Play button does in that state (see togglePause()).
 * @param {'pause'|'play'} action
 */
function _handleBackgroundAction(action) {
  const kind = _backgroundWorkoutKind();
  if (kind === 'cardio') {
    const paused = !pendingStart && session.isPaused;
    if (action === 'pause' && !pendingStart && !paused) togglePause();
    else if (action === 'play' && (pendingStart || paused)) togglePause();
  } else if (kind === 'strength') {
    const paused = strengthSession.isPaused;
    if (action === 'pause' && !paused) toggleStrengthPause();
    else if (action === 'play' && paused) toggleStrengthPause();
  }
  _syncBackgroundSession(); // no-op if a toggle above already synced; otherwise re-asserts the truth
}

/**
 * Asks the OS for the notification permission (Android 13+ shows a system
 * dialog; older versions, and a permission already granted, resolve
 * immediately). Requested in context — when a workout starts, or when the
 * rider turns the setting on — rather than at app launch. Resolves once the
 * dialog is dismissed; never rejects.
 */
async function _requestBackgroundPermission() {
  if (_bgPermissionAsked || !backgroundSession.isSupported) return;
  if (backgroundSession.notificationsAllowed) return;
  _bgPermissionAsked = true;
  _bgPermissionPending = true;
  try {
    await backgroundSession.requestPermissions();
  } catch { /* the module already logs a failed request */ } finally {
    _bgPermissionPending = false;
  }
}

/** Fire-and-forget form for session starts: ask (if needed), then sync. */
function _maybeRequestBackgroundPermission() {
  if (!backgroundSession.isEnabled) return;
  _requestBackgroundPermission().finally(() => {
    _renderBackgroundSettingsRow();
    _syncBackgroundSession();
  });
}

/**
 * Persists whatever workout is running so an app kill can't lose it. When the
 * native keep-alive is up the app is NOT frozen, so the session must keep
 * recording — checkpoint without pausing. Otherwise (browser/PWA, a platform
 * with no keep-alive, the setting off, or the service not up yet) fall back
 * to the original behavior: pause + snapshot, since JS execution is about to
 * stop with no guaranteed callback. See recording/session-persistence.js.
 */
function _checkpointWorkouts() {
  const pause = !backgroundSession.isKeepingAlive;
  persistActiveWorkout(session, { pause }).catch(() => {});
  persistActiveStrengthWorkout(strengthSession, { pause }).catch(() => {});
}

/** While hidden AND kept alive, refresh the crash-recovery snapshot on a
 *  timer — the only thing that would otherwise have written one is the
 *  moment the app was last visible, which may be hours ago by the time the
 *  rider swipes the app away (that also stops the service — see
 *  ErgnovaSessionService.OnTaskRemoved()). */
function _startBackgroundCheckpointTimer() {
  if (_bgCheckpointTimer || !backgroundSession.isKeepingAlive) return;
  _bgCheckpointTimer = setInterval(() => {
    if (!backgroundSession.isKeepingAlive) { _stopBackgroundCheckpointTimer(); return; }
    _checkpointWorkouts();
  }, BACKGROUND_CHECKPOINT_MS);
}

function _stopBackgroundCheckpointTimer() {
  clearInterval(_bgCheckpointTimer);
  _bgCheckpointTimer = null;
}

/** Reflects the shell's support/permission state into the Settings row —
 *  hidden entirely where there's nothing to configure (browser/PWA,
 *  Windows, Mac Catalyst, iOS). */
function _renderBackgroundSettingsRow() {
  const row = $('background-notification-row');
  if (!row) return;
  const supported = backgroundSession.isSupported;
  row.classList.toggle('hidden', !supported);
  if (!supported) return;

  const enabled = profile.backgroundNotification;
  const blocked = enabled && !backgroundSession.notificationsAllowed;
  const toggle = $('pref-background');
  if (toggle) toggle.checked = enabled;
  _setWarn('background-notification-warn', blocked);
  $('background-open-settings')?.classList.toggle('hidden', !blocked);
  setText('background-notification-status',
    !enabled ? 'Off — switching apps or locking the screen may pause a running workout.'
    : blocked ? 'Notifications are blocked for Ergnova. The workout still keeps running in the background, but the tray entry won’t show.'
    : 'On — the tray shows live stats and elapsed time while a workout runs in the background.');
}

/** Applies the Settings switch immediately (like units) rather than through
 *  the autosave debounce — see bindControls()'s autosave delegation, which
 *  deliberately excludes pref-background for exactly this reason. */
async function applyBackgroundNotificationChange(enabled) {
  if (enabled === profile.backgroundNotification) return;
  profile.backgroundNotification = enabled;
  await db.setPref('backgroundNotification', enabled).catch(() => {});
  if (enabled) {
    // They just asked for it — worth asking the OS again even if a workout
    // start already did this launch (Android itself decides whether a dialog
    // can still be shown). Resolved before enabling so the service isn't
    // started underneath the dialog.
    _bgPermissionAsked = false;
    await _requestBackgroundPermission();
  }
  backgroundSession.setEnabled(enabled);
  _renderBackgroundSettingsRow();
}

/**
 * The module's onProblem() callback: the service couldn't start, or the OS is
 * blocking the notification. Shown as a dismissable banner (same pattern as
 * the resume/FIT banners) since the status bar alone is easy to miss mid-
 * workout. `message` can embed a native exception message, so it goes in via
 * textContent, never innerHTML.
 * @param {string} message
 * @param {'start'|'notifications'} [kind]
 */
function _showBackgroundProblemBanner(message, kind) {
  _renderBackgroundSettingsRow();
  if (kind === 'notifications') {
    if (_bgNotificationBannerShown) return; // the Settings row keeps saying so; don't nag once per workout
    _bgNotificationBannerShown = true;
  }
  setStatus(message);

  let b = $('background-problem-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'background-problem-banner';
    b.className = 'fit-banner';
    document.querySelector('#app').appendChild(b);
  }
  b.innerHTML = `
    <span></span>
    ${kind === 'notifications' ? '<button class="btn btn-ghost btn-sm" id="background-banner-settings">Open settings</button>' : ''}
    <button class="fit-banner-close" id="background-banner-dismiss" aria-label="Dismiss"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg></button>`;
  b.firstElementChild.textContent = message;
  b.hidden = false;
  $('background-banner-settings')?.addEventListener('click', () => backgroundSession.openNotificationSettings());
  $('background-banner-dismiss')?.addEventListener('click', () => { b.hidden = true; });
}

function startSession() {
  if (session?.isRunning || pendingStart) return;
  // Setup is over: whichever devices are connected right now are the ones the live chart's device row
  // will offer to bring back if they drop. Anything not connected now is never offered this session.
  deviceRow?.begin(_deviceStatusesNow());
  _maybeRequestBackgroundPermission(); // Android 13+: the notification permission prompt, in context — see _requestBackgroundPermission()
  // No fullscreenUX.enter() here — starting a workout should not force the
  // whole document into fullscreen. stopSession() still calls
  // fullscreenUX.exit(), which is a harmless no-op if fullscreen was never
  // entered, and still cleans up correctly if something else (or a future
  // explicit fullscreen toggle) put the document into fullscreen.
  switchTab('session'); // in case this fired from the Space shortcut on another tab

  const workoutName = $('workout-name-input')?.value?.trim() || 'Free Ride';
  chartCarousel.setData([], []);
  chartBadgeBar?.setLatest(null);
  // Drop any chart page left over from a metric that disconnected mid-ride
  // last time and never came back — this new ride starts fresh, showing
  // only pages for whatever's actually live right now (see
  // updateCapabilityUI()'s doc for why the chart carousel otherwise keeps
  // a disconnected metric's page mounted).
  _knownChartMetricKeys.clear();
  updateCapabilityUI(capabilities.snapshot());
  _workoutMarks = [];
  _lastMarkedStepIndex = -1;
  chartCarousel.setWorkoutMarks(_workoutMarks);
  liveSampleBuffer = [];
  _lastElapsedSec = 0;

  // Scripted: use the workout loaded from the editor
  if (loadedWorkout && modeSwitch) {
    // buildRampTestWorkout()/buildFtpRampTestWorkout()/buildFtpTwentyMinTestWorkout()/
    // buildRestingHrTestWorkout() (metrics/vo2max.js, metrics/ftp-test.js,
    // metrics/hr-test.js) tag the workout object with testType and
    // test-specific extras (rampConfig, or testSegmentStartSec/
    // testSegmentDurationSec) beyond the normal WorkoutModel fields —
    // forward those into the session's meta so onSessionComplete() can
    // recognize a finished fitness test and compute its result. Extra
    // fields a given test type doesn't use are simply undefined, which is
    // harmless (the Resting HR Test uses none of rampConfig/testSegment*).
    const FITNESS_TEST_TYPES = new Set([VO2MAX_TEST_TYPE, FTP_RAMP_TEST_TYPE, FTP_TWENTY_TEST_TYPE, RESTING_HR_TEST_TYPE]);
    const meta = FITNESS_TEST_TYPES.has(loadedWorkout.testType)
      ? {
          testType:               loadedWorkout.testType,
          rampConfig:             loadedWorkout.rampConfig,
          testSegmentStartSec:    loadedWorkout.testSegmentStartSec,
          testSegmentDurationSec: loadedWorkout.testSegmentDurationSec,
        }
      : undefined;

    session = new ScriptedSession({
      workout: loadedWorkout,
      modeSwitch,
      ftp:     _resolvedFtp(),
      onStep:  _onScriptedStep,
      onComplete: _onScriptedComplete,
      onCountdown: (sec) => setText('hud-remaining', sec + 's'),
      meta,
      ..._sessionCallbacks(loadedWorkout.name),
    });
    _setHudVisible(true);
  } else {
    // Free session
    session = new Session(_sessionCallbacks(workoutName));
    if (modeSwitch) {
      const mode = $('mode-select')?.value ?? MODES.ERG;
      modeSwitch.switchTo(mode).catch(console.error);
    }
    _setHudVisible(false);
  }

  _renderMetricStats(); // clear the stat row to '—' immediately rather than waiting for the first tick

  // A connected BLE controller means there's something to actually wait on
  // before starting the clock — arm the "wait for pedaling" gate instead of
  // starting immediately, so jumping the gun on Start (pressing it before
  // actually getting on the bike) doesn't leave the workout already
  // auto-paused by the time the rider sits down and starts riding. See
  // _armPendingStart()/_confirmPendingStart() and modeSwitch.onActive()
  // (subscribed in connectTrainer()/connectMerachBike()). No controller
  // connected -> nothing to wait for, start right away as before.
  //
  // The Resting HR Test is the one exception: it's testing what happens
  // when the rider does NOT pedal, so gating its start on modeSwitch
  // detecting pedaling activity would mean the clock (and the strap
  // readings the estimator needs) never even starts whenever a trainer
  // happens to be connected — the opposite of what "wait for pedaling"
  // is for elsewhere. Start it immediately regardless of trainer state.
  if (trainer && modeSwitch && loadedWorkout?.testType !== RESTING_HR_TEST_TYPE) {
    _armPendingStart();
  } else {
    _beginSession();
  }
}

/**
 * Arms the "wait for the rider to actually start pedaling" gate: the
 * session object already exists (chart/HUD are wired up, mode/target
 * already applied for a free ride) but its clock hasn't started yet.
 * Reuses the manual-pause look (Play in place of Pause, Stop visible) via
 * _setPausedUI(true) — Play force-starts immediately (see togglePause()),
 * Stop cancels the not-yet-started session (see stopSession()).
 * Resolved automatically by _confirmPendingStart() once modeSwitch
 * detects real activity (see modeSwitch.onActive()), or immediately if the
 * controller disconnects before that happens (see _resetTrainerState()).
 */
function _armPendingStart() {
  pendingStart = true;
  updateSessionUI(true);
  _setPausedUI(true);
  setStatus('Get on and start pedaling — the timer starts automatically');
  _syncBackgroundSession(); // 'waiting' — so switching apps before the first pedal stroke still has a notification
}

/** Resolves _armPendingStart() the moment modeSwitch reports real activity. */
function _confirmPendingStart() {
  if (!pendingStart) return;
  pendingStart = false;
  _beginSession();
}

/**
 * Actually starts the session clock/recording. Called either immediately
 * from startSession() (no BLE controller connected — nothing to wait for)
 * or once the "wait for pedaling" gate above resolves.
 */
function _beginSession() {
  session.start();
  wakeLock.acquire();
  updateSessionUI(true); // re-assert the running (not paused) look in case _armPendingStart() left it paused
  audioCues.play('interval');
  setStatus('Session started');
  _syncBackgroundSession();
}

async function stopSession() {
  fullscreenUX.exit();
  if (pendingStart) {
    // Cancel a session that was armed but never actually started — the
    // rider tapped Start, then Stop, without ever pedaling. Nothing was
    // recorded, so discard rather than save.
    pendingStart = false;
    session?.discard();
    session = null;
    updateSessionUI(false);
    _setHudVisible(false);
    setStatus('Cancelled');
    _syncBackgroundSession();
    return;
  }
  if (!session?.isRunning) return;
  updateSessionUI(false);
  _setHudVisible(false);
  setStatus('Saving…');
  if (modeSwitch) await modeSwitch.deactivateAll().catch(() => {});
  if (session instanceof ScriptedSession) await session.stop();
  else await session.stop();
  await clearActiveWorkout().catch(() => {});
  _syncBackgroundSession();
}

// Bridges the Strength tab's exercise Browse picker onto the exerciseEditor
// singleton created in init() above. Module-scoped (not nested in init())
// because they're called from startStrengthSession()'s StrengthSessionPanel
// below, which runs long after init() has returned — unlike
// openIngredientEditorFor, whose only callers (recipeEditor/dietPage) are
// themselves constructed inside init()'s own closure.

/** Opens exerciseEditor pre-filled with whatever was typed into the
 *  picker's search box, resolving with the saved Exercise (or null on
 *  cancel) — the `(prefillName) => Promise<Exercise|null>` shape
 *  views/strength-session.js's onAddCustomExercise expects. */
function openExerciseEditorFor(prefillName = '') {
  return new Promise((resolve) => {
    exerciseEditor.open({
      prefillName,
      onSaved: (exercise) => resolve(exercise),
      onCancel: () => resolve(null),
    });
  });
}

/** Opens exerciseEditor pre-filled with an existing custom exercise,
 *  resolving with either `{ saved }` (Save) or `{ deleted: id }` (Delete)
 *  so the picker can update or drop that chip in place — or null on
 *  cancel. The `(exercise) => Promise<{saved}|{deleted}|null>` shape
 *  views/strength-session.js's onEditCustomExercise expects. */
function openExerciseEditorToEdit(exercise) {
  return new Promise((resolve) => {
    exerciseEditor.open({
      exercise,
      onSaved: (saved) => resolve({ saved }),
      onDeleted: (id) => resolve({ deleted: id }),
      onCancel: () => resolve(null),
    });
  });
}

// ─── Strength tab ───────────────────────────────────────────────────────────
// A strength/isometric-hold session is just a Session with no trainer/power
// source connected — typically just an HR strap, if the rider is wearing
// one (see recording/set-tracker.js's own docstring). Kept on its own
// strengthSession/strengthTracker/strengthPanel state rather than reusing
// the cardio `session` variable above, since that one is wired into
// chartCarousel and the HUD, neither of which apply here. It DOES share the
// same wakeLock singleton (see _releaseWakeLockIfIdle() above) and has its
// own session-persistence.js crash-recovery slot, same idea as cardio's —
// see _mountStrengthPanel()/_onStrengthSessionEnd() and
// _restoreActiveStrengthWorkout() below.

/** Renders the tab's idle "Start Strength Session" prompt. */
function _renderStrengthIdle() {
  const panel = $('strength-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="history-header">
      <h2 class="history-title">Strength</h2>
    </div>
    <section class="settings-card">
      <h2 class="settings-title">Log sets &amp; holds</h2>
      <p class="settings-sub">Reps and weight, or timed isometric holds — with live heart rate if an HR strap is connected.</p>
      <button type="button" class="btn btn-primary strength-log-btn" id="strength-start-btn">Start Strength Session</button>
    </section>
  `;
  $('strength-start-btn')?.addEventListener('click', openStrengthSession);
}

/**
 * @param {Object} [settings]          From strengthSetupFlow's onStart.
 * @param {string} [settings.focus]    SEQUENCE_FOCUS_GROUPS value — pre-filters
 *                                      the live panel's Browse picker (same
 *                                      role FOCUS_GROUPS played here before
 *                                      the sequence-picking rewrite).
 * @param {string} [settings.style]    WORKOUT_STYLES value — display/meta only,
 *                                      the sequence chosen against it already
 *                                      bakes in which exercises that implies.
 * @param {string} [settings.name]     Session title — shown in the header and
 *                                      saved as the record's workoutName,
 *                                      same as a Cardio Session's typed name.
 * @param {Object} [settings.sequence] A data/workout-sequences.js Sequence —
 *                                      the ordered exercise list
 *                                      StrengthSessionPanel's sequence rail
 *                                      guides the session with.
 */
async function startStrengthSession(settings = {}) {
  if (strengthSession?.isRunning) return;
  _maybeRequestBackgroundPermission(); // see startSession()
  switchTab('strength'); // in case this fired from another tab — see startSession()'s switchTab('session')
  const { focus = 'fullBody', style = null, name = 'Strength', sequence = null } = settings;

  strengthTracker = new SetTracker();
  strengthSession = new Session({
    workoutName: name,
    meta: { type: 'strength', focus, style, sequence, sets: [] },
    onSample: sample => { strengthPanel?.onSample(sample); _syncBackgroundSession(); },
    onEnd: _onStrengthSessionEnd,
  });

  // Recent exercise names for the autocomplete datalist — re-fetched fresh
  // on every Start so a set logged earlier this same run shows up next time
  // too, without needing a live subscription to the sessions store.
  const pastSessions = await db.getSessions().catch(() => []);
  _mountStrengthPanel({ name, focus, style, sequence, recentExercises: recentExerciseNames(pastSessions) });

  strengthSession.start();
  wakeLock.acquire();
  strengthPanel.render();
  _syncTabBarVisibility();   // switchTab('strength') above ran before this session existed
  _syncBackgroundSession();
}

/** Ends the running strength session and saves it — triggers the Session's
 *  onEnd above (_onStrengthSessionEnd), which resets the tab back to its
 *  idle prompt. */
async function stopStrengthSession() {
  if (!strengthSession?.isRunning) return;
  await strengthSession.stop();
}

/**
 * Pause / Play for a strength session — the header button and the tray
 * notification's action button both land here. Pausing freezes the session
 * clock and stops the 1 Hz sample recording (heart rate, when a strap is
 * connected); it does not touch the set log, so a set the rider logs while
 * paused is still saved. Same persist-on-pause as togglePause() does for
 * cardio, so a pause that's followed by an app kill isn't lost.
 */
function toggleStrengthPause() {
  if (!strengthSession?.isRunning) return;
  if (strengthSession.isPaused) {
    strengthSession.resume();
    setStatus('Resumed strength session');
  } else {
    strengthSession.pause();
    setStatus('Paused strength session');
    persistActiveStrengthWorkout(strengthSession).catch(() => {});
  }
  _setStrengthPausedUI(strengthSession.isPaused);
  _syncBackgroundSession(); // reaches the tray immediately, not on the next tick
}

/** Reflects a strength session's paused state in its header button — the
 *  strength counterpart of _setPausedUI(). A no-op when the panel isn't
 *  mounted. @param {boolean} paused */
function _setStrengthPausedUI(paused) {
  const btn = $('strength-pause-btn');
  if (!btn) return;
  btn.querySelector('use')?.setAttribute('href', paused ? '#icon-play' : '#icon-pause');
  const label = paused ? 'Play' : 'Pause';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  $('strength-panel')?.classList.toggle('session-paused', paused);
}

/**
 * Builds the Strength tab's live DOM (header + body) and mounts a
 * StrengthSessionPanel wired to the current strengthSession/strengthTracker
 * module-scope state — shared by startStrengthSession() (a fresh session)
 * and _openRestoredStrengthSession() (one recovered from a snapshot after
 * an app kill or screen-lock reload — see recording/session-persistence.js),
 * which both need the exact same markup and panel wiring, just a different
 * session/tracker underneath.
 * @param {Object}   opts
 * @param {string}   opts.name
 * @param {string}   opts.focus
 * @param {string|null} opts.style
 * @param {Object|null} opts.sequence
 * @param {string[]} opts.recentExercises
 */
function _mountStrengthPanel({ name, focus, style, sequence, recentExercises }) {
  const panel = $('strength-panel');
  if (!panel) return;

  panel.innerHTML = `
    <div class="history-header">
      <h2 class="history-title" id="strength-session-title">Strength</h2>
      <div class="history-header-actions">
        <button type="button" class="btn btn-ghost history-refresh" id="strength-pause-btn" title="Pause" aria-label="Pause">
          <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-pause"/></svg>
        </button>
        <button type="button" class="btn btn-ghost history-refresh" id="strength-finish-btn" title="Finish" aria-label="Finish">
          <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-stop"/></svg>
        </button>
      </div>
    </div>
    <div id="strength-session-body"></div>
  `;
  setText('strength-session-title', name);
  $('strength-pause-btn')?.addEventListener('click', toggleStrengthPause);
  $('strength-finish-btn')?.addEventListener('click', stopStrengthSession);
  _setStrengthPausedUI(!!strengthSession?.isPaused); // a restored session mounts paused

  strengthPanel = new StrengthSessionPanel($('strength-session-body'), {
    session: strengthSession,
    tracker: strengthTracker,
    units: profile.units,
    riderWeightKg: profile.riderWeight,
    recentExercises,
    focus,
    sequence,
    // Keeps the in-progress record's meta current as sets are logged, so an
    // unexpected disconnect/app-kill mid-session still auto-saves whatever
    // was logged so far — same guarantee session.stop()'s normal
    // db.saveSession() path already gives a dropped BLE connection on a ride,
    // and what persistActiveStrengthWorkout()'s periodic snapshot captures.
    onSetsChanged: () => strengthSession.setMeta({ type: 'strength', focus, style, sequence, sets: strengthTracker.sets }),
    onAddCustomExercise: openExerciseEditorFor,
    onEditCustomExercise: openExerciseEditorToEdit,
    // Whatever the HR strap's actual status already is (connected from
    // strength-session-flow.js, or never connected at all) — so the Heart
    // Rate badge reads right from its very first frame instead of
    // defaulting to "disconnected" and flipping a beat later. Anything
    // that changes after mount arrives through _setDeviceStatus()'s own
    // fan-out to strengthPanel above.
    hrmStatus: _hrmStatusNow(),
    onConnectHrm: () => connectHrMonitor(),
  });
}

/** Shared onEnd for a strength Session, whether it started fresh
 *  (startStrengthSession()) or was recovered from a snapshot
 *  (_restoreActiveStrengthWorkout()) — releases the wake lock (if the
 *  cardio side isn't still using it) and clears the now-stale persisted
 *  snapshot, same as before. Tearing down the panel no longer swaps the
 *  (nav-less) Strength tab-panel back to its own idle prompt and leaves
 *  the rider parked there — mirrors cardio's onSessionComplete() instead:
 *  reload History (so the set/hold session just saved shows up) and
 *  switch to it, the same "somewhere real, not the launcher panel" landing
 *  spot a finished ride gets. See this file's own doc comment on the
 *  Strength tab — the panel itself is only ever opened by
 *  startStrengthSession()/_openRestoredStrengthSession() while a session
 *  is actually running, never as a place to land afterward. */
async function _onStrengthSessionEnd() {
  _releaseWakeLockIfIdle();
  clearActiveStrengthWorkout().catch(() => {});
  strengthPanel?.destroy();
  strengthPanel   = null;
  strengthTracker = null;
  strengthSession = null;
  _syncBackgroundSession();
  setStatus('Strength session saved');
  await historyBrowser.load();
  switchTab('history');
}

/**
 * Strength counterpart to _restoreActiveWorkout() below — same reasoning
 * (see recording/session-persistence.js's own doc comment), its own
 * IndexedDB slot so a killed ride and a killed strength session don't
 * clobber each other. Rebuilds the Session and rehydrates its SetTracker
 * via SetTracker.restore() (recording/set-tracker.js) from the sets already
 * folded into the snapshot's meta (see _mountStrengthPanel()'s
 * onSetsChanged), then offers it back via its own resume banner rather than
 * silently losing the logged sets.
 * @returns {Promise<boolean>} true if a strength session was restored
 */
async function _restoreActiveStrengthWorkout() {
  let snapshot;
  try {
    snapshot = await loadActiveStrengthWorkout();
  } catch (err) {
    console.warn('[app] Failed to check for a restorable strength session:', err);
    return false;
  }
  if (!snapshot) return false;

  try {
    strengthSession = Session.fromSnapshot(snapshot, {
      onSample: sample => { strengthPanel?.onSample(sample); _syncBackgroundSession(); },
      onEnd:    _onStrengthSessionEnd,
    });
    strengthTracker = new SetTracker();
    strengthTracker.restore(snapshot.meta?.sets);
  } catch (err) {
    console.warn('[app] Could not restore the saved strength session — discarding it:', err);
    strengthSession = null;
    strengthTracker = null;
    await clearActiveStrengthWorkout().catch(() => {});
    return false;
  }

  _showResumeStrengthBanner(snapshot);
  return true;
}

/**
 * Shows the "unfinished strength session" banner for a session restored
 * from a snapshot — strength counterpart to _showResumeBanner() below.
 * Resume reopens the live panel with every previously logged set already
 * in place, then picks the session right back up (no "wait for pedaling"
 * gate to clear here — see _openRestoredStrengthSession()). Discard drops
 * it for good.
 * @param {Object} snapshot
 */
function _showResumeStrengthBanner(snapshot) {
  let b = $('resume-strength-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'resume-strength-banner';
    b.className = 'fit-banner';
    document.querySelector('#app').appendChild(b);
  }
  const name = snapshot.workoutName ?? 'Strength';
  const setCount = snapshot.meta?.sets?.length ?? 0;
  const setLabel = setCount === 1 ? '1 set' : `${setCount} sets`;
  b.innerHTML = `
    <span>Unfinished strength session: <strong>${name}</strong> (${setLabel} logged) — paused when the app closed</span>
    <button class="btn btn-primary btn-sm" id="resume-strength-btn">Resume</button>
    <button class="btn btn-ghost btn-sm"   id="discard-strength-btn">Discard</button>`;
  b.hidden = false;
  $('resume-strength-btn') ?.addEventListener('click', () => { b.hidden = true; _openRestoredStrengthSession(snapshot); });
  $('discard-strength-btn')?.addEventListener('click', () => { b.hidden = true; _discardRestoredStrengthSession(); });
}

/**
 * Reopens a restored strength session in the live view. Unlike cardio's
 * _openRestoredSession() (below), there's no hardware-activity gate to wait
 * on — a strength session's own "recording" is just whatever HR strap
 * happens to be connected, not something to hold the session paused for —
 * so this resumes it immediately rather than leaving it paused for a
 * manual Play tap.
 * @param {Object} snapshot
 */
async function _openRestoredStrengthSession(snapshot) {
  if (!strengthSession) return;
  switchTab('strength');
  const { focus = 'fullBody', style = null, sequence = null } = snapshot.meta ?? {};
  const name = snapshot.workoutName ?? 'Strength';
  const pastSessions = await db.getSessions().catch(() => []);
  _mountStrengthPanel({ name, focus, style, sequence, recentExercises: recentExerciseNames(pastSessions) });
  strengthPanel.render();
  strengthSession.resume();
  _setStrengthPausedUI(false);
  wakeLock.acquire();
  setStatus('Strength session restored — resuming');
  _maybeRequestBackgroundPermission();
  _syncBackgroundSession();
}

/** Drops a restored-but-not-yet-reopened strength session for good. */
async function _discardRestoredStrengthSession() {
  strengthSession?.discard();
  strengthSession = null;
  strengthTracker = null;
  await clearActiveStrengthWorkout().catch(() => {});
  setStatus('Discarded');
}

/**
 * Runs once at startup, before the ready-to-train status is shown. If the
 * previous run ended mid-workout without a normal Stop — the common case
 * on mobile is the app getting killed while running (home button, swiping
 * the app away, or the OS reclaiming a backgrounded tab) — a paused
 * snapshot is waiting in IndexedDB (see recording/session-persistence.js).
 * Rebuilds the Session/ScriptedSession from it and offers it back via the
 * resume banner instead of silently losing it.
 * @returns {Promise<boolean>} true if a workout was restored
 */
async function _restoreActiveWorkout() {
  let snapshot;
  try {
    snapshot = await loadActiveWorkout();
  } catch (err) {
    console.warn('[app] Failed to check for a restorable workout:', err);
    return false;
  }
  if (!snapshot) return false;

  try {
    if (snapshot.type === 'scripted') {
      _setLoadedWorkout(snapshot.workout);
      session = ScriptedSession.fromSnapshot(snapshot, {
        modeSwitch, // null until the rider's controller reconnects — connectTrainer()/
                    // connectMerachBike() call session.setModeSwitch() once it does
        ftp: _resolvedFtp(),
        onStep: _onScriptedStep,
        onComplete: _onScriptedComplete,
        onCountdown: (sec) => setText('hud-remaining', sec + 's'),
        ..._sessionCallbacks(snapshot.session.workoutName ?? snapshot.workout?.name),
      });
    } else {
      session = Session.fromSnapshot(snapshot, _sessionCallbacks(snapshot.workoutName));
    }
  } catch (err) {
    console.warn('[app] Could not restore the saved workout — discarding it:', err);
    session = null;
    await clearActiveWorkout().catch(() => {});
    return false;
  }

  const nameInput = $('workout-name-input');
  if (nameInput) {
    nameInput.value = snapshot.workoutName ?? snapshot.session?.workoutName ?? loadedWorkout?.name ?? '';
  }

  _restoredCardioAwaitingOpen = true; // not in progress until the rider taps Resume — see _computeBackgroundSnapshot()
  _showResumeBanner(snapshot);
  return true;
}

/**
 * Shows the "unfinished workout" banner for a session restored from a
 * snapshot — same create-once/reuse pattern as _showFitBanner() below.
 * Resume reopens the live session view in its paused state (the rider then
 * uses the toolbar's own ▶ Play control once their hardware is back, same
 * as coming back from any other pause). Discard drops it for good.
 * @param {Object} snapshot
 */
function _showResumeBanner(snapshot) {
  let b = $('resume-workout-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'resume-workout-banner';
    b.className = 'fit-banner';
    document.querySelector('#app').appendChild(b);
  }
  const name    = snapshot.workoutName ?? snapshot.session?.workoutName ?? snapshot.workout?.name ?? 'Free Ride';
  const elapsed = _fmtDuration(Math.round(snapshot.session?.elapsedSec ?? snapshot.elapsedSec ?? 0));
  b.innerHTML = `
    <span>Unfinished workout: <strong>${name}</strong> (${elapsed}) — paused when the app closed</span>
    <button class="btn btn-primary btn-sm" id="resume-workout-btn">Resume</button>
    <button class="btn btn-ghost btn-sm"   id="discard-workout-btn">Discard</button>`;
  b.hidden = false;
  $('resume-workout-btn') ?.addEventListener('click', () => { b.hidden = true; _openRestoredSession(); });
  $('discard-workout-btn')?.addEventListener('click', () => { b.hidden = true; _discardRestoredSession(); });
}

/**
 * Reopens a restored session in the live view, still paused. Marked
 * _pausedAutomatically so it's eligible for the same auto-resume as any
 * other auto-pause (see _autoResume()/autoResumeSession()): once the rider
 * reconnects their hardware and modeSwitch.onActive() sees real activity,
 * the workout picks back up on its own instead of waiting on a manual tap.
 * The ▶ Play control still works too, same as any other pause, for anyone
 * who'd rather resume by hand before actually getting back on the bike.
 */
function _openRestoredSession() {
  if (!session) return;
  _restoredCardioAwaitingOpen = false;
  switchTab('session');
  updateSessionUI(true);
  _pausedAutomatically = true;
  _setPausedUI(true);
  _setHudVisible(session instanceof ScriptedSession);
  // Workout-progress markers aren't part of the persisted snapshot (only
  // laps are — see recording/session-persistence.js), so any step
  // boundaries crossed before the app was killed can't be redrawn here.
  // Reset to empty and pick marking back up from this point forward —
  // _lastMarkedStepIndex is primed to the step already in progress so the
  // next onStep() tick doesn't mistake "nothing changed yet" for a step
  // just having completed.
  _workoutMarks = [];
  _lastMarkedStepIndex = session instanceof ScriptedSession ? session.currentStepInfo.stepIndex : -1;
  if (session instanceof ScriptedSession) updateScriptedHUD(session.currentStepInfo);
  chartCarousel.setData(session.samples, session.laps.marks);
  chartBadgeBar?.setLatest(latestSample(session.samples));
  chartCarousel.setWorkoutMarks(_workoutMarks);
  updateElapsed(Math.round(session.elapsedSec));
  _renderMetricStats();
  wakeLock.acquire();
  setStatus('Workout restored, paused — reconnect your hardware and start pedaling to resume');
  _maybeRequestBackgroundPermission();
  _syncBackgroundSession(); // 'paused' — the notification stays until they resume or stop
}

/** Drops a restored-but-not-yet-reopened session for good. */
async function _discardRestoredSession() {
  _restoredCardioAwaitingOpen = false;
  session?.discard();
  session = null;
  _setLoadedWorkout(null);
  await clearActiveWorkout().catch(() => {});
  setStatus('Discarded');
  _syncBackgroundSession();
}

/**
 * Builds a VO2 Max Ramp Test workout (metrics/vo2max.js) at the rider's
 * current FTP and queues it the same way the workout editor/setup wizard
 * do — sets loadedWorkout, primes the name field, and switches to the
 * session tab ready for the normal Start button.
 */
function startVo2MaxTest() {
  const model = buildRampTestWorkout({ ftp: _resolvedFtp() });
  _setLoadedWorkout(model);
  const nameInput = $('workout-name-input');
  if (nameInput) nameInput.value = model.name;
  switchTab('session');
  setStatus(`"${model.name}" ready — ride to genuine exhaustion; it ends on its own once you stop pedaling`);
}

/**
 * Builds an FTP Ramp Test workout (metrics/ftp-test.js) and queues it the
 * same way startVo2MaxTest() does.
 */
function startFtpRampTest() {
  const model = buildFtpRampTestWorkout({ ftp: _resolvedFtp() });
  _setLoadedWorkout(model);
  const nameInput = $('workout-name-input');
  if (nameInput) nameInput.value = model.name;
  switchTab('session');
  setStatus(`"${model.name}" ready — ride to genuine exhaustion; it ends on its own once you stop pedaling`);
}

/**
 * Builds an FTP 20-Minute Test workout (metrics/ftp-test.js) and queues it
 * the same way startVo2MaxTest() does.
 */
function startFtpTwentyMinTest() {
  const model = buildFtpTwentyMinTestWorkout({ ftp: _resolvedFtp() });
  _setLoadedWorkout(model);
  const nameInput = $('workout-name-input');
  if (nameInput) nameInput.value = model.name;
  switchTab('session');
  setStatus(`"${model.name}" ready — follow the warm-up, then pace the 20-minute effort evenly`);
}

/**
 * Builds a Resting Heart Rate Test workout (metrics/hr-test.js) and queues
 * it the same way startVo2MaxTest() does. Unlike every other test here,
 * this one doesn't need FTP at all, and success means the rider stayed
 * still rather than went hard — the queued status message reflects that.
 */
function startRestingHrTest() {
  const model = buildRestingHrTestWorkout();
  _setLoadedWorkout(model);
  const nameInput = $('workout-name-input');
  if (nameInput) nameInput.value = model.name;
  switchTab('session');
  setStatus(`"${model.name}" ready — sit or lie still, then press Start`);
}

function markLap() {
  if (!session?.isRunning) return;
  const n = session.markLap();
  audioCues.play('beep');
  setStatus(`Lap ${n} marked`);
}

/**
 * Reflects paused/unpaused state in the UI — shared by the manual toggle
 * and auto-pause below so both paths leave the button and panel in the
 * same state.
 *
 * Stop lives inside this toggle too, not just updateSessionUI(): it's
 * meant to appear only once the rider actually pauses (Pause "splits
 * into" Play + Stop), not for the whole duration of a running session,
 * so its hidden/disabled state tracks `paused` rather than `running`.
 * @param {boolean} paused
 */
function _setPausedUI(paused) {
  document.querySelector('#pause-btn use')?.setAttribute('href', paused ? '#icon-play' : '#icon-pause');
  setText('pause-btn-label', paused ? 'Play' : 'Pause');
  $('session-panel')?.classList.toggle('session-paused', paused);
  const stopBtn = $('stop-btn');
  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !paused);
    stopBtn.disabled = !paused;
  }
}

/** Manual Pause/Play button — works for both free-ride Session and ScriptedSession. */
function togglePause() {
  if (pendingStart) {
    // Waiting on _armPendingStart() — treat a manual Play tap as "start
    // now" instead of waiting for pedaling to be detected.
    _confirmPendingStart();
    return;
  }
  if (!session?.isRunning) return;
  if (session.isPaused) {
    session.resume();
    _pausedAutomatically = false;
    _setPausedUI(false);
    setStatus('Resumed workout');
  } else {
    session.pause();
    _pausedAutomatically = false; // a deliberate manual pause, not one autoResumeSession() should touch
    _setPausedUI(true);
    setStatus('Paused');
    persistActiveWorkout(session).catch(() => {});
  }
  _syncBackgroundSession(); // pause/resume reach the tray immediately, not on the next tick
}

/**
 * Shared by every auto-pause trigger (rider idleness, controller
 * disconnect) so they all leave the button/panel in the same state and
 * resume identically via the manual Pause/Play button. No-ops if there's
 * no running, unpaused session to pause.
 * @param {string}  reason  Status message describing why.
 * @param {Object}  [opts]
 * @param {boolean} [opts.trimIdleTail]  Pass true when this pause was
 *   triggered by a debounced idle detection (see autoPauseSession() below)
 *   so the dead samples logged during that debounce get scrapped from the
 *   recording — see Session#trimTrailingIdle(). Left false for the
 *   controller-disconnect trigger (_resetTrainerState()), which has no
 *   such debounce/lag: whatever was last recorded there is real data, not
 *   an idle-detection artifact.
 * @param {boolean} [opts.silent]  Pass true to skip the warning beep — used
 *   when the app is hidden (see _autoPauseOnHide()), where a cue would just
 *   play over whatever the rider switched to.
 * @param {boolean} [opts.resumable]  Whether pedaling again may lift this
 *   pause on its own (see _autoResume()). Defaults to true; the hidden-app
 *   pause passes false so it stays paused until the rider taps Play.
 */
function _autoPause(reason, { trimIdleTail = false, silent = false, resumable = true } = {}) {
  if (!session?.isRunning || session.isPaused) return;
  session.pause();
  if (trimIdleTail) session.trimTrailingIdle();
  _pausedAutomatically = resumable;
  _setPausedUI(true);
  setStatus(reason);
  if (!silent) audioCues.play('warning');
  persistActiveWorkout(session).catch(() => {});
  _syncBackgroundSession();
}

/**
 * Auto-pause on rider idleness: wired to modeSwitch.onIdle() in
 * connectTrainer()/connectMerachBike(). Now fires for ANY active mode (or
 * none) once watts/cadence/speed have all read 0 for a few seconds — see
 * control/mode-switch.js#_checkActivity() — not just SmartErgMode's
 * software resistance loop, which is all this used to cover.
 * onIdle() only fires after that few-second debounce, so the samples
 * recorded between the rider actually stopping and this call landing are
 * dead zeros, not ride data — trimIdleTail scraps them back off the
 * recording (see Session#trimTrailingIdle()).
 * The other auto-pause trigger, losing the controller entirely, is handled
 * by _resetTrainerState() below, via the same _autoPause() helper.
 *
 * Fitness tests change what "idle" means, so those get checked first:
 *   - Resting HR Test: idleness is the entire point of the test, not a
 *     sign it should be paused — left alone entirely so its single fixed-
 *     duration step runs to completion on its own (see
 *     ScriptedSession#_advanceStep()). Without this, a connected trainer
 *     would auto-pause the test within a few seconds of it starting, and
 *     it would never auto-resume (nothing will ever "start pedaling"
 *     during a test that asks the rider to sit still) — silently
 *     freezing it forever.
 *   - FTP Ramp / VO2 Max Ramp Test, and the FTP 20-Minute Test's two
 *     self-paced maximal-effort segments: going idle IS the test's actual
 *     finish line (genuine exhaustion), not something to pause through
 *     and wait on a manual Stop for — see
 *     _isSelfPacedTestInEffortSegment(). Ends the workout immediately
 *     instead of pausing it, so the result is computed and the
 *     apply-to-profile banner shows up right away.
 * Neither branch is gated on the Auto Pause setting below — both are
 * correctness properties of how those specific tests work, not the
 * general "pause my ride when I stop pedaling" convenience that setting
 * (and its per-controller-type/per-mode checklists — see
 * _shouldAutoPause()) controls.
 */
function autoPauseSession() {
  if (!session?.isRunning || session.isPaused) return;

  if (session.meta?.testType === RESTING_HR_TEST_TYPE) return;

  if (_isSelfPacedTestInEffortSegment(session)) {
    stopSession().catch(err => console.error('[app] Failed to auto-end fitness test:', err));
    return;
  }

  if (!_shouldAutoPause('idle')) return;
  _autoPause('Auto-paused — no pedaling detected', { trimIdleTail: true });
}

/**
 * Auto-pause when the app is hidden (Settings → Auto Pause → App hidden,
 * profile.autoPauseTriggers.hide): called from the visibilitychange
 * listener in init() the moment the page goes hidden — the rider switching
 * to another app, or the screen locking. Only does anything when that
 * setting is on (via _shouldAutoPause()), and covers both a cardio and a
 * strength session, since the setting is about the app rather than the
 * equipment.
 *
 * This is what lets a rider opt out of the native keep-alive's "keep
 * recording in the background" (see _checkpointWorkouts()): the foreground
 * service keeps the process alive, and this pauses the workout anyway. It
 * is NOT what pauses a workout when there's no keep-alive at all (browser/
 * PWA, notification setting off) — there JS is about to be frozen, so
 * _checkpointWorkouts() still pauses regardless of this setting.
 *
 * Deliberately not auto-resumable and silent — see _autoPause()'s
 * `resumable`/`silent`. Skipped while the system notification-permission
 * dialog is up (_bgPermissionPending): that dialog is the app asking, not
 * the rider leaving, and pausing a workout that just started underneath it
 * would be a bug.
 */
function _autoPauseOnHide() {
  if (_bgPermissionPending) return;
  if (!_shouldAutoPause('hide', null, null)) return;

  if (session?.isRunning && !session.isPaused) {
    _autoPause('Auto-paused — app hidden', { silent: true, resumable: false });
  }
  if (strengthSession?.isRunning && !strengthSession.isPaused) {
    strengthSession.pause();
    setStatus('Auto-paused — app hidden');
    _setStrengthPausedUI(true);
    persistActiveStrengthWorkout(strengthSession).catch(() => {});
    _syncBackgroundSession();
  }
}

/**
 * Mirror image of _autoPause(): shared by every auto-resume trigger
 * (rider activity resuming — see autoResumeSession() below) so it leaves
 * the button/panel in the same state a manual Play tap would. Gated on
 * _pausedAutomatically so it only ever resolves a pause the software
 * created — either a live _autoPause() (idleness/dropped controller) or a
 * restored (crash-recovered) session reopened via _openRestoredSession(),
 * which sets the same flag. A session the rider paused deliberately via
 * the manual Pause/Play button (togglePause()) still only comes back via
 * that same button.
 * @param {string} reason  Status message describing why.
 */
function _autoResume(reason) {
  if (!session?.isRunning || !session.isPaused || !_pausedAutomatically) return;
  session.resume();
  _pausedAutomatically = false;
  _setPausedUI(false);
  setStatus(reason);
  audioCues.play('beep');
  _syncBackgroundSession();
}

/**
 * Auto-resume on rider activity: wired to modeSwitch.onActive() in
 * connectTrainer()/connectMerachBike(), alongside _confirmPendingStart() —
 * the two share the onActive edge (see control/mode-switch.js#onActive())
 * but never conflict, since exactly one of pendingStart / an auto-paused
 * session can be true at a time. Fires the instant watts/cadence/speed
 * shows activity again — no debounce, unlike the onIdle() side — so
 * getting back on and pedaling (or a reconnected controller picking up
 * cadence again) picks the workout back up without reaching for Play.
 */
function autoResumeSession() {
  _autoResume('Resumed — pedaling detected');
}

// ─── Scripted HUD ─────────────────────────────────────────────────────────────

/**
 * Shows or hides #scripted-hud and keeps .train-panel's grid in sync via
 * .no-hud (see the .train-panel.session-active.no-hud rule in style.css) —
 * hiding the HUD also drops its row, and the 12px gap around it, out of
 * the grid template, the same way .session-active already drops the
 * toolbar row. Without this, a free-ride session (no HUD content) is left
 * with a blank HUD row and its gap sitting above the metric cards. Always
 * go through this helper rather than toggling #scripted-hud's .hidden
 * class directly, so the two stay in sync everywhere.
 */
function _setHudVisible(visible) {
  $('scripted-hud')?.classList.toggle('hidden', !visible);
  $('session-panel')?.classList.toggle('no-hud', !visible);
}

/**
 * ScriptedSession's onStep callback for a live workout — drives the HUD
 * (updateScriptedHUD(), unchanged) and, on top of that, drops a step-
 * complete marker on the live chart the moment a step actually finishes.
 *
 * onStep() fires every second while a step is running (see
 * ScriptedSession#_tick()), not just on genuine step changes, so a marker
 * is only added when info.stepIndex has moved past
 * _lastMarkedStepIndex — that's the tick where the PREVIOUS step just
 * ended and this one started. The very first call of a workout (step 0,
 * _lastMarkedStepIndex still -1) has no previous step to mark.
 * @param {Object} info  ScriptedSession#currentStepInfo
 */
function _onScriptedStep(info) {
  updateScriptedHUD(info);
  if (!info) return;

  if (_lastMarkedStepIndex !== -1 && info.stepIndex > _lastMarkedStepIndex) {
    _workoutMarks.push({ sampleIndex: Math.max(0, (session?.samples?.length ?? 1) - 1), kind: 'step' });
    chartCarousel.setWorkoutMarks(_workoutMarks);
  }
  _lastMarkedStepIndex = info.stepIndex;
}

/**
 * ScriptedSession's onComplete callback (see scripted-session.js) — fires
 * once, only when every step has run to completion on its own. Drops the
 * single, more pronounced "workout complete" marker on the live chart —
 * see ChartEngine#setWorkoutMarks(). Not called for a manual Stop or an
 * auto-ended self-paced fitness test, so those don't get this marker.
 *
 * Also the only place that resets the Start/FAB/Lap/Pause controls for
 * this path: _advanceStep() (scripted-session.js) calls this and then
 * session.stop() directly, never app.js's own stopSession() — the wrapper
 * that normally calls updateSessionUI(false) *before* the session's own
 * stop() runs. Skip it here and a workout that finishes on its own left
 * the FAB stuck in its disabled/gray look (updateSessionUI(true) from
 * start time never got undone) even though the workout had genuinely
 * ended — only a manual Stop, or an auto-ended fitness test (which does
 * go through stopSession()), left the controls in the right state.
 */
function _onScriptedComplete() {
  _workoutMarks.push({ sampleIndex: Math.max(0, (session?.samples?.length ?? 1) - 1), kind: 'complete' });
  chartCarousel.setWorkoutMarks(_workoutMarks);
  updateSessionUI(false);
}

function updateScriptedHUD(info) {
  if (!info) return;
  const {
    stepIndex, stepCount, step, stepRemaining,
    totalDuration, totalElapsed, totalRemaining, targetNow,
  } = info;

  // Tints the HUD's left-edge rule, step badge, progress fill and the
  // timeline's dot to match the current step's own color — the same
  // STEP_COLORS palette _drawWorkoutTimeline() below paints that step
  // with, so the badge and the stretch of target line the dot is riding
  // visibly agree (see --hud-color in style.css).
  $('scripted-hud')?.style.setProperty('--hud-color', STEP_COLORS[step.type] ?? 'var(--indigo)');

  // ── Top row: the workout as a whole ─────────────────────────────────
  setHudText('hud-workout-title', session?.workoutName || 'Workout');
  setText('hud-total-remaining', _fmtDuration(totalRemaining));
  const totalPct = totalDuration ? (totalElapsed / totalDuration) * 100 : 0;
  const totalFill = $('hud-total-fill');
  if (totalFill) totalFill.style.width = Math.min(100, Math.max(0, totalPct)) + '%';

  // ── Bottom row: the current step ────────────────────────────────────
  // Always show "Step X/Y", even for a single-step workout, so the
  // badge is present for any workout rather than only multi-step ones.
  $('hud-step-badge')?.classList.remove('hidden');
  setText('hud-step-badge', `Step ${stepIndex + 1}/${stepCount}`);

  // A single-step workout built by Cardio Session (see cardio-session-flow.js's
  // buildQuickStartWorkout()) gives its one step the exact same name as
  // the workout itself — the step *is* the workout there, so show the
  // workout's own name in that case (this is the only place it's ever
  // shown on screen — the workout-name-input in index.html is
  // intentionally hidden). Any workout with more than one step, or a step
  // named differently from its workout, labels the step by its type
  // ("Warm-up", "Interval") as normal. Its target isn't part of this
  // label any more — see the timeline block below, which is where that
  // reading now lives.
  const redundantName = stepCount <= 1 && !!step.name && step.name === session?.workoutName;
  setHudText('hud-step-name', redundantName ? step.name : _typeLabel(step.type));
  setText('hud-remaining', _fmtDuration(stepRemaining));

  const stepPct = step.duration ? (1 - stepRemaining / step.duration) * 100 : 0;
  const stepFill = $('hud-step-fill');
  if (stepFill) stepFill.style.width = Math.min(100, Math.max(0, stepPct)) + '%';

  // ── Workout target map ──────────────────────────────────────────────────────────
  // Only worth drawing when some step in the workout actually enforces a
  // target — a pure Free Ride (every step's targetType is 'none') has no
  // shape to map, so the whole row stays hidden for it.
  const steps = session?.steps ?? [];
  const hasTargets = steps.some(s => s.targetType !== TARGET_TYPES.NONE);
  $('hud-timeline-row')?.classList.toggle('hidden', !hasTargets);
  if (hasTargets) {
    // The drawing only depends on the workout's shape, not the clock, so
    // it is made once per workout (the steps array's identity changes only
    // when a new session starts) — and again if its box is resized, see
    // _drawWorkoutTimeline(). A new workout also forgets which step the
    // dot was in, so its first placement is instant rather than a long
    // glide from wherever the last workout left it.
    if (_timelineSteps !== steps) {
      _timelineSteps = steps;
      _timelineStepIndex = -1;
      _drawWorkoutTimeline(steps);
    }
    const pct = totalDuration ? Math.min(100, Math.max(0, (totalElapsed / totalDuration) * 100)) : 0;
    const marker = $('hud-timeline-marker');
    if (marker) marker.style.left = pct + '%';

    // The dot rides the target line at "now": its height is the live target
    // (continuously interpolated through a ramp, see targetNow) on the same
    // scale the drawing used, so it stays on the line. When a new step begins
    // somewhere else the move is a "jump" and animates up or down the step
    // edge; the small steady changes along a ramp just glide (see
    // .hud-timeline-dot in style.css).
    const level = levelOf(step, targetNow, _timelineMax);
    const first = _timelineStepIndex === -1;
    const motion = dotMotion({ stepChanged: !first && stepIndex !== _timelineStepIndex, prevLevel: _timelineLevel, level });
    placeTimelineDot($('hud-timeline-dot'), { pct, level, instant: first, jump: motion === 'jump' });
    _timelineStepIndex = stepIndex;
    _timelineLevel = level;

    // The live target's number sits at the bottom left of the map, fixed
    // there (it used to travel along the top with the "now" line).
    setText('hud-timeline-target', _stepTargetNowLabel(step, targetNow));
  }
}

/**
 * Draws the workout's target map onto the timeline canvas (ui/hud-timeline.js
 * does the drawing: a thin solid line along each step's target, with a glow
 * that softens to nothing beneath it, ramps following the curve the trainer
 * is actually sent). Steps are coloured with the same STEP_COLORS palette the
 * editor's preview uses. Remembers the highest target it scaled to
 * (_timelineMax), which the dot's height is measured against, and redraws
 * itself when the canvas's box changes size (a phone turned on its side, a
 * resized window), since the drawing is made at the box's pixel size.
 * @param {WorkoutStep[]} steps  Flattened steps (see ScriptedSession#steps).
 */
function _drawWorkoutTimeline(steps) {
  const canvas = $('hud-timeline-canvas');
  if (!canvas || steps.length === 0) return;
  const colorFor = (step) => STEP_COLORS[step.type] ?? themeColor('--step-rest');

  const max = drawTimeline(canvas, steps, { colorFor });
  if (max != null) _timelineMax = max;

  if (!_timelineResize && typeof ResizeObserver === 'function') {
    let lastW = canvas.clientWidth, lastH = canvas.clientHeight;
    _timelineResize = new ResizeObserver(() => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      // Nothing to redraw while the HUD is hidden (a zero box), or when only something else changed.
      if (!_timelineSteps || !w || !h || (w === lastW && h === lastH)) return;
      lastW = w; lastH = h;
      const m = drawTimeline(canvas, _timelineSteps, { colorFor });
      if (m != null) _timelineMax = m;
    });
    _timelineResize.observe(canvas);
  }
}

/**
 * Formats the live target readout at the timeline's bottom left — the same shape of
 * label the old per-step "· 220W" text used, but built from the
 * continuously-interpolated targetNow (see ScriptedSession#currentStepInfo)
 * rather than the step's static targetLow, so it actually climbs/falls
 * through a ramp instead of jumping at step boundaries.
 * @param {WorkoutStep} step
 * @param {number} targetNow
 */
function _stepTargetNowLabel(step, targetNow) {
  const value = targetNow ?? step.targetLow ?? 0;
  switch (step.targetType) {
    case 'power':      return `${Math.round(value * _resolvedFtp())}W`;
    case 'slope':      return `${value.toFixed(1)}% grade`;
    case 'resistance': return `${Math.round(value)}%`;
    default:           return 'Free';
  }
}

// ─── Mode & target ────────────────────────────────────────────────────────────

async function applyTarget() {
  if (!modeSwitch || !trainer) return;
  const mode  = $('mode-select')?.value ?? MODES.ERG;
  const value = parseFloat($('target-input')?.value ?? '0');
  if (isNaN(value)) return;
  try {
    if (modeSwitch.activeModeName !== mode) await modeSwitch.switchTo(mode);
    await modeSwitch.setTarget(value);
    audioCues.play('beep');
    setStatus(`${_modeLabel(mode)}: ${value}${_modeUnit(mode)}`);
  } catch (err) { setStatus('Error: ' + err.message); }
}

async function nudgeTarget(dir) {
  if (!modeSwitch) return;
  const delta = _nudgeDelta(modeSwitch.activeModeName) * dir;
  try {
    await modeSwitch.adjust(delta);
    const cur = modeSwitch.currentMode?.target ?? '?';
    setStatus(`${_modeLabel(modeSwitch.activeModeName)}: ${cur}${_modeUnit(modeSwitch.activeModeName)}`);
  } catch (err) { setStatus('Adjust error: ' + err.message); }
}

async function switchMode(mode) {
  if (!modeSwitch) return;
  try {
    await modeSwitch.switchTo(mode);
    const sel = $('mode-select');
    if (sel) sel.value = mode;
    updateTargetHints(mode);
  } catch (err) { setStatus('Mode error: ' + err.message); }
}

// ─── Calibration ─────────────────────────────────────────────────────────────

function startCalibration() {
  if (!trainer) { setStatus('No trainer connected'); return; }
  calibration = new CalibrationFlow(trainer, ({ state, message, progress }) => {
    setText('cal-status', message ?? '');
    const p = $('cal-progress'); if (p) p.value = Math.round((progress ?? 0) * 100);
    if (state === 'complete' || state === 'failed') {
      $('cal-stop-btn').disabled  = true;
      $('cal-start-btn').disabled = false;
      if (state === 'complete') audioCues.play('complete');
    }
  });
  $('cal-start-btn').disabled = true;
  $('cal-stop-btn').disabled  = false;
  calibration.start().catch(console.error);
}

function stopCalibration() {
  calibration?.cancel();
  $('cal-stop-btn').disabled  = true;
  $('cal-start-btn').disabled = false;
}

// ─── Post-session ─────────────────────────────────────────────────────────────

/**
 * Attaches a fitness test's estimated result to the already-saved session
 * record (record.meta.testResult) and persists that back to IndexedDB via
 * db.updateSession(). The rider-profile prefs (ftpTestWatts, vo2Max, etc.
 * — see _saveFtpTestResult()/_saveVo2MaxResult()) remain the source of
 * truth for "what's my current FTP/VO2max"; this is purely so the
 * specific ride's own record carries its result with it into every later
 * export from history (CSV/JSON show it directly; see
 * recording/activity-formats.js), not just the completion-banner download.
 * @param {SessionRecord} record
 * @param {string} label     e.g. 'FTP Ramp Test'
 * @param {Object} metrics   Plain key→number map, e.g. { ftpWatts: 225 }
 */
async function _persistTestResult(record, label, metrics) {
  record.meta = { ...(record.meta ?? {}), testResult: { label, metrics } };
  try {
    await db.updateSession(record);
  } catch (err) {
    console.error('[app] Failed to persist test result to session record:', err);
  }
}

async function onSessionComplete(record) {
  if (record.meta?.testType === VO2MAX_TEST_TYPE) {
    await _handleVo2MaxTestComplete(record);
    return;
  }
  if (record.meta?.testType === FTP_RAMP_TEST_TYPE) {
    await _handleFtpRampTestComplete(record);
    return;
  }
  if (record.meta?.testType === FTP_TWENTY_TEST_TYPE) {
    await _handleFtpTwentyMinTestComplete(record);
    return;
  }
  if (record.meta?.testType === RESTING_HR_TEST_TYPE) {
    await _handleRestingHrTestComplete(record);
    return;
  }

  const m     = computeMetrics(record.samples, _resolvedFtp());
  if (m.np) record.summary.normalizedPower = m.np;

  const msg = [
    `Saved! ${_fmtDuration(record.duration)}`,
    m.np  ? `NP ${m.np}W`    : null,
    m.if  ? `IF ${m.if}`     : null,
    m.tss ? `TSS ${m.tss}`   : null,
    record.summary?.totalCalories ? `${Math.round(record.summary.totalCalories)} kcal` : null,
  ].filter(Boolean).join(' · ');

  setStatus(msg);
  audioCues.play('complete');
  _showFitBanner(record);
  await historyBrowser.load();
  switchTab('history');
}

/**
 * Post-session handling specific to a VO2 Max Ramp Test: derive peak power
 * output from exactly where the rider stopped (record.meta, set by
 * ScriptedSession.stop() — see playback/scripted-session.js), run the
 * Storer-Davis estimate if age/sex/weight are on file, record it as the
 * rider's latest VO2max-test result, and offer — but don't force — an
 * update to their saved VO2max (same confirm-before-applying pattern as
 * the FTP tests and the Resting HR Test; see _showFtpConfirmBanner()'s doc
 * comment for why).
 */
async function _handleVo2MaxTestComplete(record) {
  const ppo = estimatePeakPowerOutput({
    rampConfig:       record.meta.rampConfig,
    stepIndexAtStop:  record.meta.stepIndexAtStop,
    stepElapsedAtStop: record.meta.stepElapsedAtStop,
  });

  const result = estimateVo2Max({
    ppoWatts: ppo.watts,
    weightKg: profile.riderWeight,
    age:      profile.age,
    sex:      profile.sex,
  });

  let lines = [`Peak power output: ${ppo.watts}W`];
  ppo.warnings.forEach(w => lines.push(w));

  if (result) {
    lines.push(`Estimated VO2max: ${result.vo2MaxMlKgMin} mL/kg/min`);
  } else {
    lines.push('Add your age, sex and weight in Settings → Profile to get a VO2max estimate from this.');
  }

  await _persistTestResult(record, 'VO2 Max Ramp Test', {
    peakPowerOutputWatts: ppo.watts,
    ...(result ? { vo2MaxMlKgMin: result.vo2MaxMlKgMin } : {}),
  });

  setStatus(lines.join(' · '));
  audioCues.play('complete');
  _showVo2MaxBanner(ppo, result, record);
  await historyBrowser.load();
  switchTab('history');
}

/** Persists a computed VO2max result to the rider profile (prefs + in-memory). */
async function _saveVo2MaxResult(result) {
  const dateStr = new Date().toISOString();
  await Promise.all([
    db.setPref('vo2Max', result.vo2MaxMlKgMin),
    db.setPref('vo2MaxDate', dateStr),
  ]);
  Object.assign(profile, { vo2Max: result.vo2MaxMlKgMin, vo2MaxDate: dateStr });
  _renderVo2MaxCard();
}

/**
 * Shows a confirmation banner for a fresh VO2max estimate. Deliberately
 * requires an explicit tap before it touches profile.vo2Max — same
 * confirm-before-applying pattern as the FTP-test and Resting-HR-test
 * banners (see _showFtpConfirmBanner()'s doc comment for why): a single
 * field-test estimate shouldn't silently overwrite a fitness stat any more
 * than it should silently overwrite FTP or resting HR.
 *
 * Shown even when there's no result to apply (missing age/sex, or no power
 * data at all) — the ride was still saved to history, so the download
 * control stays available either way; only the "Update VO2max" button is
 * conditional on there being an estimate.
 */
function _showVo2MaxBanner(ppo, result, record) {
  let b = $('vo2max-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'vo2max-banner';
    b.className = 'fit-banner';
    document.querySelector('#app').appendChild(b);
  }
  const resultHtml = result
    ? `<span>VO2max estimate: <strong>${result.vo2MaxMlKgMin} mL/kg/min</strong> (PPO ${ppo.watts}W)${profile.vo2Max != null ? ` — current ${profile.vo2Max} mL/kg/min` : ''}</span>
       <button class="btn btn-primary btn-sm" id="vo2max-accept">Update VO2max</button>`
    : `<span>Peak power output: <strong>${ppo.watts}W</strong> — add age/sex in Settings for a VO2max estimate</span>`;
  b.innerHTML = `
    ${resultHtml}
    <span class="download-control" id="vo2max-banner-dl"></span>
    <button class="fit-banner-close" id="vo2max-dismiss" aria-label="Dismiss"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg></button>`;
  b.hidden = false;
  renderDownloadControl($('vo2max-banner-dl'), record);
  if (result) {
    $('vo2max-accept')?.addEventListener('click', async () => {
      await _saveVo2MaxResult(result);
      b.hidden = true;
      setStatus(`VO2max updated to ${result.vo2MaxMlKgMin} mL/kg/min`);
    });
  }
  $('vo2max-dismiss')?.addEventListener('click', () => { b.hidden = true; });
}

/**
 * Post-session handling for an FTP Ramp Test: estimate FTP from the best
 * sustained 1-minute power in the ride (metrics/ftp-test.js), record it as
 * the rider's latest FTP-test result, and offer — but don't force — an
 * update to their saved FTP.
 */
async function _handleFtpRampTestComplete(record) {
  const result = estimateFtpFromRamp({ samples: record.samples });

  let lines = [];
  if (result.bestOneMinWatts != null) {
    lines.push(`Best 1-min power: ${result.bestOneMinWatts}W`);
    lines.push(`Estimated FTP: ${result.ftpWatts}W`);
  }
  result.warnings.forEach(w => lines.push(w));

  if (result.ftpWatts != null) {
    await _saveFtpTestResult(result.ftpWatts, 'FTP Ramp Test');
    await _persistTestResult(record, 'FTP Ramp Test', {
      bestOneMinWatts: result.bestOneMinWatts,
      ftpWatts:        result.ftpWatts,
    });
  }

  setStatus(lines.join(' · '));
  audioCues.play('complete');
  _showFtpConfirmBanner(result.ftpWatts, 'FTP Ramp Test', record);
  await historyBrowser.load();
  switchTab('history');
}

/**
 * Post-session handling for an FTP 20-Minute Test: isolate the 20-minute
 * test segment's samples using the offsets carried on record.meta (see
 * buildFtpTwentyMinTestWorkout()), estimate FTP from its average power,
 * record it, and offer an update to the saved FTP.
 */
async function _handleFtpTwentyMinTestComplete(record) {
  const result = estimateFtpFromTwentyMin({
    samples:                record.samples,
    testSegmentStartSec:    record.meta.testSegmentStartSec,
    testSegmentDurationSec: record.meta.testSegmentDurationSec,
  });

  let lines = [];
  if (result.avgWatts != null) {
    lines.push(`20-min average power: ${result.avgWatts}W`);
    lines.push(`Estimated FTP: ${result.ftpWatts}W`);
  }
  result.warnings.forEach(w => lines.push(w));

  if (result.ftpWatts != null) {
    await _saveFtpTestResult(result.ftpWatts, 'FTP 20-Minute Test');
    await _persistTestResult(record, 'FTP 20-Minute Test', {
      avgWatts: result.avgWatts,
      ftpWatts: result.ftpWatts,
    });
  }

  setStatus(lines.join(' · '));
  audioCues.play('complete');
  _showFtpConfirmBanner(result.ftpWatts, 'FTP 20-Minute Test', record);
  await historyBrowser.load();
  switchTab('history');
}

/**
 * Persists the latest FTP-test estimate (fitness-test history — same as
 * VO2max, not something that belongs on one session record) regardless of
 * whether the rider chooses to apply it to their saved FTP.
 */
async function _saveFtpTestResult(ftpWatts, label) {
  const dateStr = new Date().toISOString();
  await Promise.all([
    db.setPref('ftpTestWatts', ftpWatts),
    db.setPref('ftpTestDate',  dateStr),
    db.setPref('ftpTestLabel', label),
  ]);
  Object.assign(profile, { ftpTestWatts: ftpWatts, ftpTestDate: dateStr, ftpTestLabel: label });
  _renderFtpTestCard();
}

/**
 * Shows a confirmation banner for a fresh FTP-test estimate. Deliberately
 * requires an explicit tap before it touches profile.ftp — same
 * confirm-before-applying pattern as the VO2max and Resting-HR-test
 * banners (see _showVo2MaxBanner()/_showRestingHrConfirmBanner()): FTP
 * drives every future workout's target watts app-wide, so a single
 * field-test estimate should never silently overwrite it.
 *
 * Shown even when the estimate itself failed (ftpWatts == null — too
 * short an effort, no power data, etc.): the ride was still saved to
 * history, and the rider may still want the raw recording, so the
 * download control stays available either way — only the "Update FTP"
 * button is conditional on there being an estimate to apply.
 */
function _showFtpConfirmBanner(ftpWatts, testLabel, record) {
  let b = $('ftp-test-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'ftp-test-banner';
    b.className = 'fit-banner';
    document.querySelector('#app').appendChild(b);
  }
  const estimateHtml = ftpWatts != null
    ? `<span>${testLabel}: estimated FTP <strong>${ftpWatts}W</strong> (current ${_resolvedFtp()}W)</span>
       <button class="btn btn-primary btn-sm" id="ftp-test-accept">Update FTP</button>`
    : `<span>${testLabel}: couldn't estimate FTP from this ride</span>`;
  b.innerHTML = `
    ${estimateHtml}
    <span class="download-control" id="ftp-banner-dl"></span>
    <button class="fit-banner-close" id="ftp-test-dismiss" aria-label="Dismiss"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg></button>`;
  b.hidden = false;
  renderDownloadControl($('ftp-banner-dl'), record);
  if (ftpWatts != null) {
    $('ftp-test-accept')?.addEventListener('click', async () => {
      await _applyFtpUpdate(ftpWatts);
      b.hidden = true;
      setStatus(`FTP updated to ${ftpWatts}W`);
    });
  }
  $('ftp-test-dismiss')?.addEventListener('click', () => { b.hidden = true; });
}

/**
 * Applies a new FTP the same way savePreferences() does — persists it and
 * pushes it to every live consumer (mode switch, workout editor/setup
 * flows, Settings UI) — reused by the FTP-test confirmation banner so
 * accepting an estimate behaves identically to hand-entering the value
 * and letting it autosave.
 */
async function _applyFtpUpdate(ftpWatts) {
  await db.setPref('ftp', ftpWatts);
  profile.ftp = ftpWatts;
  modeSwitch?.setFtp(ftpWatts);
  workoutEditor?.setFtp(ftpWatts);
  quickStartFlow?.setFtp(ftpWatts);
  populateSettingsUI();
}

/**
 * Reflects the last saved FTP-test result (if any) in the Settings panel —
 * the shared caption under the 20-minute test row, plus a short "Not
 * tested" flag next to each test row's own info-btn (Ramp test and
 * 20-minute test both feed the same saved result, so both get the flag).
 * While there's no result yet, the caption is empty — the inline flag is
 * the only "nothing here yet" signal, rather than duplicating it below.
 */
function _renderFtpTestCard() {
  const el = $('ftp-test-result');
  const noTest = profile.ftpTestWatts == null;
  _setWarn('ftp-ramp-warn', noTest);
  _setWarn('ftp-20min-warn', noTest);
  if (!el) return;
  if (noTest) {
    el.textContent = '';
    el.hidden = true;
    return;
  }
  const dateStr = profile.ftpTestDate ? new Date(profile.ftpTestDate).toLocaleDateString() : '';
  el.hidden = false;
  el.textContent = `${profile.ftpTestLabel}: ${profile.ftpTestWatts}W estimated${dateStr ? ` — ${dateStr}` : ''} (current FTP: ${_resolvedFtp()}W)`;
}

/**
 * Post-session handling for a Resting Heart Rate Test: estimate resting
 * HR from the lowest sustained stretch of the sit (metrics/hr-test.js),
 * record it as the rider's latest resting-HR-test result, and offer —
 * but don't force — an update to their saved resting HR, same
 * confirm-before-applying pattern as the FTP tests (see
 * _showFtpConfirmBanner()'s doc comment for why: this feeds the
 * Karvonen/HRR zone math in metrics/hr-zones.js, so a single test's
 * result shouldn't silently override whatever's already on file).
 */
async function _handleRestingHrTestComplete(record) {
  const result = estimateRestingHr({ samples: record.samples });

  let lines = [];
  if (result.restingHrBpm != null) {
    lines.push(`Estimated resting HR: ${result.restingHrBpm} bpm`);
  }
  result.warnings.forEach(w => lines.push(w));

  if (result.restingHrBpm != null) {
    await _saveRestingHrTestResult(result.restingHrBpm);
    await _persistTestResult(record, 'Resting Heart Rate Test', {
      restingHrBpm: result.restingHrBpm,
    });
  }

  setStatus(lines.join(' · '));
  audioCues.play('complete');
  _showRestingHrConfirmBanner(result.restingHrBpm, record);
  await historyBrowser.load();
  switchTab('history');
}

/**
 * Persists the latest Resting-HR-test estimate (fitness-test history —
 * same as ftpTestWatts/vo2Max, not something that belongs on one session
 * record) regardless of whether the rider chooses to apply it to their
 * saved resting HR.
 */
async function _saveRestingHrTestResult(bpm) {
  const dateStr = new Date().toISOString();
  await Promise.all([
    db.setPref('restingHrTestBpm', bpm),
    db.setPref('restingHrTestDate', dateStr),
  ]);
  Object.assign(profile, { restingHrTestBpm: bpm, restingHrTestDate: dateStr });
  _renderRestingHrTestCard();
}

/**
 * Shows a confirmation banner for a fresh Resting HR Test estimate.
 * Shown even when the estimate itself failed (restingHrBpm == null — too
 * short a sit, no strap data, etc.): the recording was still saved to
 * history, so the download control stays available either way — only the
 * "Update Resting HR" button is conditional on there being an estimate to
 * apply.
 */
function _showRestingHrConfirmBanner(bpm, record) {
  let b = $('resting-hr-test-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'resting-hr-test-banner';
    b.className = 'fit-banner';
    document.querySelector('#app').appendChild(b);
  }
  const estimateHtml = bpm != null
    ? `<span>Resting Heart Rate Test: estimated <strong>${bpm} bpm</strong>${profile.restingHr != null ? ` (current ${profile.restingHr} bpm)` : ''}</span>
       <button class="btn btn-primary btn-sm" id="resting-hr-test-accept">Update Resting HR</button>`
    : `<span>Resting Heart Rate Test: couldn't estimate a resting rate from this sit</span>`;
  b.innerHTML = `
    ${estimateHtml}
    <span class="download-control" id="resting-hr-banner-dl"></span>
    <button class="fit-banner-close" id="resting-hr-test-dismiss" aria-label="Dismiss"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg></button>`;
  b.hidden = false;
  renderDownloadControl($('resting-hr-banner-dl'), record);
  if (bpm != null) {
    $('resting-hr-test-accept')?.addEventListener('click', async () => {
      await _applyRestingHrUpdate(bpm);
      b.hidden = true;
      setStatus(`Resting HR updated to ${bpm} bpm`);
    });
  }
  $('resting-hr-test-dismiss')?.addEventListener('click', () => { b.hidden = true; });
}

/**
 * Applies a new resting HR the same way savePreferences() does —
 * persists it and refreshes the Settings UI/HR zone strip — reused by
 * the Resting HR Test confirmation banner so accepting an estimate
 * behaves identically to hand-entering the value and hitting Save
 * Profile. Unlike _applyFtpUpdate(), there's no modeSwitch/workoutEditor
 * push: resting HR never drives a commanded target (see
 * metrics/hr-zones.js's module doc) — the zone strip, Settings fields,
 * and quickStartFlow's Steady HR Zone name segment (see that file's
 * _steadyZoneLabel()) are the only live consumers.
 */
async function _applyRestingHrUpdate(bpm) {
  await db.setPref('restingHr', bpm);
  profile.restingHr = bpm;
  quickStartFlow?.setHrProfile({ maxHr: _resolvedMaxHr(), restingHr: profile.restingHr });
  populateSettingsUI();
  renderHrZoneStrip();
}

/**
 * Reflects the last saved Resting HR Test result (if any) in the Settings
 * panel. Empty caption (not a "no test yet" sentence) while there's
 * nothing to show — the inline flag next to the info-btn covers that.
 */
function _renderRestingHrTestCard() {
  const el = $('resting-hr-test-result');
  const noTest = profile.restingHrTestBpm == null;
  _setWarn('resting-hr-warn', noTest);
  if (!el) return;
  if (noTest) {
    el.textContent = '';
    el.hidden = true;
    return;
  }
  const dateStr = profile.restingHrTestDate ? new Date(profile.restingHrTestDate).toLocaleDateString() : '';
  const current  = profile.restingHr != null ? ` (current resting HR: ${profile.restingHr} bpm)` : '';
  el.hidden = false;
  el.textContent = `${profile.restingHrTestBpm} bpm estimated${dateStr ? ` — ${dateStr}` : ''}${current}`;
}

/**
 * Reflects the last saved VO2max result (if any) in the Settings panel.
 * Empty caption (not a "no test yet" sentence) while there's nothing to
 * show — the inline flag next to the info-btn covers that.
 */
function _renderVo2MaxCard() {
  const el = $('vo2max-result');
  const noTest = profile.vo2Max == null;
  _setWarn('vo2max-warn', noTest);
  if (!el) return;
  if (noTest) {
    el.textContent = '';
    el.hidden = true;
    return;
  }
  const dateStr = profile.vo2MaxDate ? new Date(profile.vo2MaxDate).toLocaleDateString() : '';
  el.hidden = false;
  el.textContent = `${profile.vo2Max} mL/kg/min${dateStr ? ` — ${dateStr}` : ''}`;
}

/**
 * Shows/hides one of the short "Not tested"/"Not synced" flags that sit
 * next to a test or sync row's info-btn (see .settings-warn in
 * style.css) — a no-op if the element isn't in the DOM (settings panel
 * not yet built, or run outside a browser in a smoke test).
 */
function _setWarn(id, show) {
  const el = $(id);
  if (el) el.hidden = !show;
}

/**
 * Auto Pause's three levels (the Auto Pause switch → its own trigger
 * checklist → each trigger's nested per-type checklist below it) all say
 * the same thing: a switch that exists only to gate a list of children is
 * pointless once every one of those children is off, so it turns itself
 * off right along with the last one instead of sitting on with nothing
 * left for it to gate. Wired bottom-up in bindControls() below on each
 * child's own 'change' — unticking the last controller-type or control-
 * mode box can cascade all the way up through its trigger to Auto Pause
 * itself, if that leaves every trigger off too. Dispatches a real 'change'
 * event on the parent (rather than just setting .checked) so the parent's
 * own listener still runs — collapsing its panel and, for a trigger,
 * feeding this same check one level further up.
 *
 * Like every other autoPause* checkbox here, this feeds the Settings tab's
 * autosave the same way a real keystroke/click would — the dispatched
 * 'change' bubbles up to bindControls()'s delegated autosave listener same
 * as any other pref-* field's — and this never runs retroactively against
 * whatever was last saved, only in response to an actual change.
 */
function _autoDisableIfAllChildrenOff(childIds, parentId) {
  const children = childIds.map(id => $(id)).filter(Boolean);
  if (children.length === 0 || !children.every(el => !el.checked)) return;
  const parent = $(parentId);
  if (parent && parent.checked) {
    parent.checked = false;
    parent.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/**
 * The mirror image of _autoDisableIfAllChildrenOff above: switching a
 * governing switch back on forces every child under it back on too, rather
 * than leaving whatever mix of on/off it had the last time it was turned
 * off — Auto Pause coming back on always means everything under it is back
 * on, not last session's leftover state. Dispatches a real 'change' event
 * on each child that actually flips (not just setting .checked), so the
 * cascade keeps going another level down through that child's own
 * listener — forcing AUTO_PAUSE_TRIGGER_IDS on from Auto Pause's own
 * listener, for instance, also forces each trigger's nested checklist on
 * via that trigger's own listener in bindControls() below. Skips children
 * already on, so it never dispatches a no-op 'change'.
 */
function _forceChildrenOn(childIds) {
  for (const id of childIds) {
    const el = $(id);
    if (el && !el.checked) {
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
}

/** id of the "App hidden" checkbox in Settings → Auto Pause. */
const AUTO_PAUSE_HIDE_ID = 'pref-auto-pause-trigger-hide';

/**
 * Makes sure Settings → Auto Pause has an "App hidden" row (the
 * profile.autoPauseTriggers.hide switch). If the markup already supplies a
 * checkbox with AUTO_PAUSE_HIDE_ID this does nothing; otherwise it builds
 * the row by cloning the "Stopped pedaling" row and re-labelling the copy,
 * so it picks up exactly the same markup, classes and switch styling as its
 * siblings without this file having to know them. Must run before
 * bindControls() wires the trigger checkboxes and before
 * populateSettingsUI() reads them. A no-op if the idle row isn't in the DOM
 * (settings panel not built, or a smoke test running outside a browser).
 */
function _ensureAutoPauseHideRow() {
  if ($(AUTO_PAUSE_HIDE_ID)) return;
  const idleRow = $('pref-auto-pause-trigger-idle')?.closest('li, .settings-check-row');
  if (!idleRow) return;

  const row = idleRow.cloneNode(true);
  // The clone still carries the idle row's ids/for-links — repoint them all
  // so the two rows can never share an id or toggle each other's switch.
  for (const el of row.querySelectorAll('[id]')) el.id = el.id.replace('idle', 'hide');
  for (const el of row.querySelectorAll('label[for]')) el.htmlFor = el.htmlFor.replace('idle', 'hide');

  const input = row.querySelector('input[type="checkbox"]');
  if (!input) return;
  input.checked = false;
  if (input.hasAttribute('aria-label')) input.setAttribute('aria-label', 'Auto-pause when the app is hidden');
  const name = row.querySelector('.settings-trigger-name');
  if (name) name.textContent = 'App hidden';
  const desc = row.querySelector('.settings-trigger-desc');
  if (desc) desc.textContent = 'Pause when you switch to another app or lock the screen';

  idleRow.after(row);
}

function _showFitBanner(record) {
  let b = $('fit-download-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'fit-download-banner';
    b.className = 'fit-banner';
    document.querySelector('#app').appendChild(b);
  }
  b.innerHTML = `
    <span>Workout saved!</span>
    <span class="download-control" id="fit-banner-dl"></span>
    <button class="fit-banner-close" id="fit-dismiss" aria-label="Dismiss"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg></button>`;
  b.hidden = false;
  renderDownloadControl($('fit-banner-dl'), record);
  $('fit-dismiss')?.addEventListener('click', () => { b.hidden=true; });
}

// ─── UI ───────────────────────────────────────────────────────────────────────

/**
 * Current/average/peak readout below the live chart: one hero row (#metrics-row — the current value as a
 * giant numeral, Average over Peak beside it) for whichever metric the chart is showing. Swipe the chart
 * and it follows. On the chart's "All" page, which overlays several metrics at once and so has no single
 * metric to speak for, the very same row is reused and steps through the page's metrics on a timer
 * (OVERVIEW_HERO_INTERVAL_MS — see _heroKey() and _startOverviewHero() below). Every change of the metric on
 * show — a step of that rotation or a swipe to another chart — arrives with the same short fade
 * (_replayHeroFade()) instead of snapping. Reads from the recorded sample buffer while a session is running, and from the latest raw BLE tick
 * beforehand (there's no recorded buffer yet to average/peak over).
 */
function _renderMetricStats() {
  // With no metric page at all the readout has nothing to say: hide it and let the panel's grid
  // drop its row (.no-metrics), so the chart panel's Connect tile gets the whole height.
  const empty = !activeMetricKey;
  $('metrics-row')?.classList.toggle('is-empty', empty);
  $('session-panel')?.classList.toggle('no-metrics', empty);

  const key = _heroKey();
  const def = key ? METRIC_DEFS[key] : null;
  const row = $('metrics-row');
  if (row) {
    if (key) row.dataset.metric = key;
    else row.removeAttribute('data-metric');
  }
  setText('stat-metric-name', def?.label ?? '—');

  if (!def) {
    _setHeroValue('—', '');
    setText('stat-average-value', '—');
    setText('stat-peak-value',   '—');
    return;
  }

  // Average and Peak stay "value unit" strings; the hero splits number and unit so the unit can sit
  // small beside a giant numeral.
  const fmt = v => v == null ? '—' : `${def.fmt(v)} ${def.unit}`;
  const heroVal = v => v == null ? '—' : String(def.fmt(v));
  const heroUnit = v => v == null ? '' : (def.unit ?? '');

  if (session?.isRunning) {
    const { current, avg, peak } = _statsForMetric(key, liveSampleBuffer);
    _setHeroValue(heroVal(current), heroUnit(current));
    setText('stat-average-value', fmt(avg));
    setText('stat-peak-value',   fmt(peak));
  } else {
    const live = deviceManager.latestData[key];
    _setHeroValue(heroVal(live), heroUnit(live));
    setText('stat-average-value', '—');
    setText('stat-peak-value',   '—');
  }
}

/** The metric the hero reads out: the chart page's own, or — on the All page — whichever one the rotation
 *  is on right now (null when that page carries nothing). */
function _heroKey() {
  return activeMetricKey === ChartCarousel.OVERVIEW_KEY ? _overviewHeroKey : activeMetricKey;
}

// How long the All page's hero sits on one metric before stepping to the next — the same dwell as the
// chart badge bar's rotating badge (ROTATOR_INTERVAL_MS): long enough to read, short enough that every
// metric keeps coming back around.
const OVERVIEW_HERO_INTERVAL_MS = 3500;

/** Arriving on the All page: the hero starts on its first metric and the timer starts from zero, so
 *  the first metric gets a full dwell too. */
function _startOverviewHero() {
  _stopOverviewHero();
  _overviewHeroKey = _overviewKeys[0] ?? null;
  chartCarousel?.setOverviewMetric(_overviewHeroKey);   // the All page's chart starts on the hero's metric
  _overviewHeroTimer = setInterval(_tickOverviewHero, OVERVIEW_HERO_INTERVAL_MS);
}

function _stopOverviewHero() {
  if (_overviewHeroTimer) { clearInterval(_overviewHeroTimer); _overviewHeroTimer = null; }
}

/** The All page's metric set just changed (a sensor paired or unpaired): if the metric the hero is on is
 *  gone, fall back to the first; otherwise leave it alone so the rotation is not nudged. */
function _syncOverviewHero() {
  if (activeMetricKey !== ChartCarousel.OVERVIEW_KEY) return;
  if (!_overviewKeys.includes(_overviewHeroKey)) _overviewHeroKey = _overviewKeys[0] ?? null;
  chartCarousel?.setOverviewMetric(_overviewHeroKey);
}

/** One step of the rotation: the next metric of the All page, wrapping round, with the readout's fade-in
 *  so the change reads as an arrival rather than a snap. */
function _tickOverviewHero() {
  if (activeMetricKey !== ChartCarousel.OVERVIEW_KEY) { _stopOverviewHero(); return; }   // belt and braces
  if (_overviewKeys.length < 2) return;                                                    // nothing to rotate to
  if (chartCarousel?.locked) return;   // a held crosshair stays on its metric; the rotation resumes when it is released
  const at = _overviewKeys.indexOf(_overviewHeroKey);
  _overviewHeroKey = _overviewKeys[(at + 1) % _overviewKeys.length];
  chartCarousel?.setOverviewMetric(_overviewHeroKey);   // the chart follows the hero, fading in with it
  chartBadgeBar?.setHero(_badgeHeroKey());   // the badge steps to the hero's partner in this same tick, with the same fade
  _renderMetricStats();
  _replayHeroFade();
}

/** The readout's arrival animation: the whole row (name, numeral, Average, Peak and the cards' colours) fades
 *  in over .35s (`.metrics-row-in` in style.css). One function for both ways the metric on show changes — a
 *  step of the All page's rotation (_tickOverviewHero) and a swipe to another chart (onActiveMetric in init)
 *  — so the two are the same animation by construction. Replayed by removing the class, forcing a reflow and
 *  adding it back. */
function _replayHeroFade() {
  const row = $('metrics-row');
  if (!row) return;
  row.classList.remove('metrics-row-in');
  void row.offsetWidth;
  row.classList.add('metrics-row-in');
}

/** The hero numeral. Only touches the DOM (and re-fits) when the text actually changed — this runs
 *  on every tick, but most ticks repeat the same value. ux/fit-text.js shrinks it to its box when a
 *  long reading ("12:34", "1,284") would overflow, and grows it back when a short one follows. */
function _setHeroValue(text, unit) {
  const val = $('stat-current-value'), un = $('stat-current-unit');
  if (!val) return;
  const unitChanged = un && un.textContent !== unit;
  if (unitChanged) un.textContent = unit;         // first: the unit takes room the numeral then fits around
  if (val.textContent !== text || unitChanged) {
    val.textContent = text;
    fitText($('metrics-row'), '#stat-current-value');
  }
}

/** The chart panel's Connect tile: open the control bar's Settings menu, which holds the Connect
 *  buttons for the trainer, heart-rate strap, SmO2 and core-temp sensors. Opens only — a second tap
 *  on the tile must not close the menu it just opened. */
function _openSensorMenu() {
  if ($('trainer-menu')?.classList.contains('hidden')) _toggleTrainerMenu();
}

function _statsForMetric(key, samples) {
  const vals = samples.map(s => s[key]).filter(v => v != null);
  if (!vals.length) return { current: null, avg: null, peak: null };
  return {
    current: vals[vals.length - 1],
    avg:     vals.reduce((a, b) => a + b, 0) / vals.length,
    peak:    Math.max(...vals),
  };
}

// Elapsed time no longer has its own toolbar readout — it's drawn directly
// on the live chart, at the end of the time axis (see ChartEngine). This
// tracks the latest value anyway, since the resume pill (_updateResumeBar)
// still needs a text readout for when the chart itself is off-screen.
let _lastElapsedSec = 0;

function updateElapsed(sec) {
  if (sec != null) _lastElapsedSec = sec;
}

function updateSessionUI(running) {
  if ($('start-btn'))     $('start-btn').disabled     = running;
  if ($('fab-start-btn')) $('fab-start-btn').disabled  = running;
  if ($('lap-btn'))    $('lap-btn').disabled    = !running;
  // Pause is available for any running session now, not just scripted
  // workouts — both Session and ScriptedSession implement pause()/resume()/
  // isPaused (see recording/session.js, playback/scripted-session.js).
  $('pause-btn')?.classList.toggle('hidden', !running);
  // Stop is deliberately NOT handled here — see _setPausedUI() below. It
  // only appears once the rider actually pauses (Pause "splits into" Play
  // + Stop), not for the whole time a session is running.
  _setPausedUI(false); // a session that just started or just stopped is never "paused"
  $('session-panel')?.classList.toggle('session-active', running);
  if (!running) deviceRow?.end();   // no session -> nothing to reconnect for; forget the offer and any dismissal
}

function updateTrainerUI(connected, controllable = true) {
  const btn = $('trainer-menu-btn');
  if (btn) {
    const viaFtms = connected && controllable;
    btn.classList.toggle('connected', viaFtms);
    btn.title = viaFtms ? `Trainer: ${trainer?.name ?? 'Connected'}` : 'Trainer: not connected';
  }
  _updateDeviceMenuItem('controller', connected, trainer?.name);
  // Control Mode + Spindown Calibration (now inside the trainer menu —
  // see #trainer-menu-controls in index.html) only make sense once
  // there's an actual controllable trainer to point them at.
  $('trainer-menu-controls')?.classList.toggle('hidden', !(connected && controllable));
  renderSensorChips();
}

function updateModeUI(mode) {
  if (!mode) return;
  const sel = $('mode-select');
  if (sel) sel.value = mode;
  updateTargetHints(mode);
  document.querySelector('.gear-row')?.classList.toggle('hidden', mode !== MODES.VIRTUAL_GEAR);
}

/**
 * Enables/disables <option>s in the mode-select dropdown to match what the
 * connected device can actually do — e.g. a Merach-family bike only gets
 * ERG (see control/mode-switch.js's capability detection), so resistance/
 * slope/virtualGear are grayed out instead of being selectable and failing
 * on Apply. Pass null to re-enable every option (on disconnect).
 *
 * ERG is separately forced off whenever `loadedWorkout` is a Free Ride
 * (see _workoutIsFreeRide() below) — a Free Ride step has no target, and
 * scripted-session.js's _startStep() deliberately never touches modeSwitch
 * for a STEP_TYPES.FREE_RIDE step, so this is the only place actually
 * stopping a rider from dialing in a manual ERG watt target here and
 * quietly turning a Free Ride into a scripted one. _setLoadedWorkout()
 * re-runs this every time loadedWorkout changes, so picking a Free Ride
 * (or leaving one) takes effect immediately even mid-connection.
 * @param {ModeSwitch|null} modeSwitch
 */
function _populateModeOptions(modeSwitch) {
  const sel = $('mode-select');
  if (!sel) return;
  const available  = modeSwitch ? new Set(modeSwitch.availableModes) : null;
  const ergBlocked = _workoutIsFreeRide(loadedWorkout);
  for (const opt of sel.options) {
    const capable = available ? available.has(opt.value) : true;
    opt.disabled = !capable || (opt.value === MODES.ERG && ergBlocked);
  }
  if (sel.options[sel.selectedIndex]?.disabled) {
    const fallback = [...sel.options].find(opt => !opt.disabled);
    sel.value = fallback?.value ?? sel.value;
    updateTargetHints(sel.value);
  }
}

/** True when `model` is nothing but a single Free Ride step — Quick
 *  Start's Free Ride workout type and the Resting HR Test both build
 *  exactly this shape (see ui/cardio-session-flow.js's buildQuickStartWorkout()
 *  and metrics/hr-test.js's buildRestingHrTestWorkout()); multi-step
 *  workouts that merely *include* a Free Ride segment (the FTP ramp/VO2max/
 *  20-minute tests) do NOT match here, since their other steps still need
 *  ERG. Used only to decide whether _populateModeOptions() should block
 *  ERG — has no effect on playback itself.
 * @param {WorkoutModel|null} model
 * @returns {boolean}
 */
function _workoutIsFreeRide(model) {
  return !!model && model.steps?.length === 1 && model.steps[0]?.type === STEP_TYPES.FREE_RIDE;
}

/** Every `loadedWorkout = ...` assignment in this file goes through here
 *  instead, so _populateModeOptions() re-syncs the Control Mode dropdown's
 *  ERG option (see that function's own doc comment on _workoutIsFreeRide())
 *  the instant a Free Ride loads or a Free Ride gets replaced by something
 *  else — never just on the next trainer (re)connect. Safe to call with
 *  `modeSwitch` still null (no trainer connected yet); _populateModeOptions()
 *  no-ops on the device-capability half of its job in that case but still
 *  applies the Free Ride block, so the dropdown is already correct by the
 *  time a controller connects.
 * @param {WorkoutModel|null} model
 */
function _setLoadedWorkout(model) {
  loadedWorkout = model;
  _populateModeOptions(modeSwitch);
}

function updateTargetHints(mode) {
  const input = $('target-input');
  const hint  = $('target-hint');
  if (!input || !hint) return;
  const cfg = {
    [MODES.ERG]:          { ph: profile.ftp || '200', hint: 'Watts',       min:0, max:1500 },
    [MODES.RESISTANCE]:   { ph: '30',                  hint: '% (0–100)',   min:0, max:100  },
    [MODES.SLOPE]:        { ph: '3.5',                  hint: '% grade',    min:-20, max:20 },
    [MODES.VIRTUAL_GEAR]: { ph: '—',                   hint: 'Use ← →',    min:0, max:0    },
  }[mode] ?? { ph:'0', hint:'', min:0, max:1000 };
  input.placeholder = cfg.ph;
  input.min = cfg.min; input.max = cfg.max;
  input.disabled = mode === MODES.VIRTUAL_GEAR;
  hint.textContent = cfg.hint;
}

/** Rebuilds the chart carousel's pages to match whichever metrics have
 *  data to show. Called on every capabilities change.
 *
 *  Two different lists come out of this, deliberately: `_availableMetricDefs`
 *  mirrors live capability exactly (used by the Scripted HUD rotator and the
 *  stat row below the chart, neither of which should show a number for a
 *  metric nothing is currently reporting) — while the chart carousel itself
 *  gets the sticky superset in `_knownChartMetricKeys`, so a metric's page
 *  stays mounted through a disconnect instead of disappearing. The page
 *  itself then draws that gap as a flat gray line at the last known value
 *  (see ChartEngine's null-driven rendering) rather than vanishing, which
 *  would read as "this metric never existed" instead of "reconnecting."
 */
function updateCapabilityUI(snap) {
  const defs = METRIC_ORDER
    .filter(key => snap.metrics[key])
    .map(key => ({ key, ...METRIC_DEFS[key] }));
  _availableMetricDefs = defs;

  for (const key of defs) _knownChartMetricKeys.add(key.key);
  // The chart's own order (heart rate, power, cadence, speed — charts/chart-order.js), not METRIC_ORDER's:
  // the carousel seats its pages, and so its dots, in this order whatever order the sensors paired in.
  const chartDefs = CHART_METRIC_ORDER
    .filter(key => _knownChartMetricKeys.has(key))
    .map(key => ({ key, ...METRIC_DEFS[key] }));
  // The same list, ahead of the carousel's own onMetricOrder callback (which confirms it) so nothing
  // reads an empty ring in between.
  _overviewKeys = chartDefs.map(d => d.key);
  chartCarousel?.setAvailableMetrics(chartDefs);
  _syncOverviewHero();
  _syncChartBadgeBar();
  _renderMetricStats();
}

function renderZoneStrip() {
  const el = $('zone-strip');
  if (!el) return;
  el.innerHTML = zonesForFtp(_resolvedFtp()).map(z => `
    <div class="zone-chip" style="border-left:3px solid ${z.color}">
      <span class="zone-num">Z${z.zone}</span>
      <span class="zone-name">${z.name}</span>
      <span class="zone-range">${z.low}–${z.high ?? '∞'} W</span>
    </div>`).join('');
}

/**
 * Heart Rate zone strip — same shape/markup as renderZoneStrip() above,
 * just fed from metrics/hr-zones.js instead of ftp-zones.js. Reads maxHr
 * through _resolvedMaxHr() (a direct entry, or the Tanaka age estimate)
 * so the strip still shows *something* the moment age is on file, even
 * before the rider has entered a max HR by hand or typed a resting HR —
 * zonesForHr() itself renders an empty (fully absent) strip only when
 * there's truly nothing to compute from.
 */
function renderHrZoneStrip() {
  const el = $('hr-zone-strip');
  if (!el) return;
  const maxHr = _resolvedMaxHr();
  const zones = zonesForHr({ maxHr, restingHr: profile.restingHr });
  if (zones.length === 0) {
    el.innerHTML = `<span class="zone-strip-empty">Add an age (for an estimate) or a max HR in Profile above to see zones here.</span>`;
    return;
  }
  el.innerHTML = zones.map(z => `
    <div class="zone-chip" style="border-left:3px solid ${z.color}">
      <span class="zone-num">Z${z.zone}</span>
      <span class="zone-name">${z.name}</span>
      <span class="zone-range">${z.low}–${z.high ?? '∞'} bpm</span>
    </div>`).join('');
}

function setStatus(msg) {
  const el = $('status-bar');
  if (el) { el.textContent = msg; el.title = msg; }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function setupTabs() {
  // A tap plays the same slide / rail stack / FAB flight as a committed swipe, over the fixed --swipe-settle
  // (_swipeTo(), in setupSwipeNav below); where it can't (an overlay is open, reduced motion, a tab outside the
  // bar) it is the plain, instant switch it always was.
  document.querySelectorAll('[data-tab]').forEach(btn =>
    btn.addEventListener('click', () => { if (!_swipeTo(btn.dataset.tab)) switchTab(btn.dataset.tab); }));
  setupSwipeNav();
}

// ─── Swipe navigation ───────────────────────────────────────────────────────
// A horizontal drag anywhere on a nav-tab panel moves to the next/previous
// tab, same order as the bottom bar. It tracks the finger like an Android
// home screen: as soon as the drag is clearly horizontal, the panel in that
// direction slides in from the edge by exactly the distance dragged, and the
// current one slides out with it. On release the pair either finishes the
// move (dragged past COMMIT_FRACTION of the width, or flicked) or snaps back
// and the peeked panel is hidden again. Dragging back past the start point
// swaps to the panel on the other side; at either end of the bar there's
// nothing to peek, so the current panel just stretches a little (see
// EDGE_RESISTANCE) and springs back.
//
// Still deliberately narrow in scope: it steps back off if the drag starts
// vertical (that's a scroll), if it starts inside something that already
// scrolls sideways (the live chart carousel, the wizard's step strip) or
// owns horizontal drags (range sliders, an armed chart), or if we're not
// actually looking at a nav tab (mid-session, or an overlay like the FAB
// menu / setup wizard is open) — so it never fights those other gestures.
//
// Timing/easing of the settle live in style.css's :root (--swipe-settle,
// --swipe-ease); the panel layering is .swipe-peek / .swipe-drag /
// .swipe-settle there too.

// Set by setupSwipeNav(). switchTab() calls it first so a programmatic tab
// change (a tap on the bar, a shortcut) never lands in the middle of a drag
// or a settle animation.
let _swipeAbort = () => {};
// Also set by setupSwipeNav(): moves to a nav tab with the swipe's own animation, at the fixed
// --swipe-settle speed rather than a finger's. Returns false (and does nothing) when it can't.
let _swipeTo = () => false;

function setupSwipeNav() {
  const app = $('app');
  if (!app) return;

  const LOCK_SLOP       = 8;     // px of travel before we decide horizontal vs vertical
  const COMMIT_FRACTION = 0.35;  // release past this share of the width and the move commits
  const FLING_VELOCITY  = 0.3;   // px/ms — a quicker flick commits even when it's shorter…
  const FLING_MIN_DIST  = 40;    // …as long as it travelled at least this far
  const EDGE_RESISTANCE = 0.25;  // 0–1: how far the panel follows the finger when there's no tab that way (0 = doesn't move)
  const CLICK_CLAIM_DIST = 12;   // px of horizontal travel after which a drag is a page swipe and nothing else (see the click guard below)
  const CLICK_GUARD_MS   = 400;  // how long after release a stray click is still swallowed

  let g = null;        // the gesture in progress, or null
  let settle = null;   // { finish() } while a released swipe is still animating

  // ── Click guard ───────────────────────────────────────────────────────
  // A swipe is only ever a page swipe. Once a drag has travelled
  // CLICK_CLAIM_DIST it is "claimed", and the click the browser synthesises
  // when the finger/button is released — on whichever button, tile, rail
  // item, label or link the drag happened to start on or end over — is
  // swallowed in the capture phase, before any handler can see it. (Without
  // this a swipe that began on a tile ran that tile's action on release: we
  // preventDefault() the touchmoves so the panel doesn't scroll, and the
  // browser then reads the gesture as a tap that never moved.) Shorter
  // travel is still an ordinary tap with a little finger wobble, so those
  // clicks go through untouched. The touch path also preventDefault()s its
  // touchend, which stops the click being generated at all where that
  // works; this is the net for the mouse path and for WebViews that
  // dispatch it anyway.
  let guardOn = false, guardTimer = 0;
  const guard = {
    arm()     { guardOn = true; clearTimeout(guardTimer); },
    release() { clearTimeout(guardTimer); guardTimer = setTimeout(() => { guardOn = false; }, CLICK_GUARD_MS); },
    drop()    { guardOn = false; clearTimeout(guardTimer); },
  };
  window.addEventListener('click', e => {
    if (!guardOn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    guard.drop();
  }, true);
  // A fresh press means the next click is a real one — never let the guard
  // outlive the gesture it belongs to.
  window.addEventListener('touchstart', guard.drop, { capture: true, passive: true });
  window.addEventListener('mousedown',  guard.drop, true);

  // Called on every move of a drag that has locked horizontal.
  function claimIfFarEnough(dx) {
    if (g.claimed || Math.abs(dx) < CLICK_CLAIM_DIST) return;
    g.claimed = true;
    guard.arm();
  }

  const navTabs = () => Array.from(document.querySelectorAll('.tab-bar [data-tab]'));
  const panelOf = name => document.querySelector(`[data-panel="${name}"]`);
  const width   = () => app.clientWidth || window.innerWidth;
  // The tab bar itself — for .swiping/.swipe-settling (style.css's
  // .tab-bar.swiping rules, next to --activation's own comment) and for
  // finding a tab's .md-rail (below) while a drag is live.
  const tabBarEl = document.querySelector('.tab-bar');
  const railFor  = name => document.querySelector(`.md-rail[data-rail-for="${name}"]`);

  // The rail's stack dial, style.css's --rail-stack (see its @property
  // comment): 0 = the rail's full button set, 1 = stacked down to its one
  // active button, faded out. Driven exactly like the tab buttons'
  // --activation -- set inline every drag frame from the same dx/width, so
  // the outgoing rail stacks and the incoming one unstacks in step with the
  // panels and the bar (render() below), then eased to its final value on
  // release by .md-rail.swipe-settling over the same --swipe-settle/
  // --swipe-ease as the panel's own slide (settleGesture()). .swiping is
  // what switches the rail's ordinary transitions off and lets the dial be
  // the only thing animating; railEnd() drops both again.
  const setStack = (rail, v) => rail?.style.setProperty('--rail-stack', String(v));
  function railEnd(rail) {
    if (!rail) return;
    rail.classList.remove('swiping', 'swipe-settling');
    rail.style.removeProperty('--rail-stack');
  }

  // ── The FAB in flight ───────────────────────────────────────────────────
  // The "+" is one shared element living in the active rail's .md-rail-fab-slot, and the rails differ in
  // where and how big it is (Overview's is a 48px column with the FAB alone at the bottom; the others hold a
  // 60x56 FAB above the collapse toggle). Left alone it sat in the outgoing rail while that folded away, then
  // teleported into the incoming one when the swipe landed. So once a swipe peeks a neighbour, the FAB moves
  // into a fixed layer (.fab-flight, style.css) and is driven by --fab-t: the same 0-1 dial as the rails'
  // --rail-stack, set each drag frame from dx / width and eased over --swipe-settle / --swipe-ease on
  // release. It slides and resizes from its box in the outgoing rail to the box it will have in the
  // incoming one, and drops into its slot (or back, if the swipe is cancelled) at the end.
  let fly = null;   // { layer, fab, from, to, home } while a swipe has the FAB in the air
  const fabBox = fab => {
    const r = fab.getBoundingClientRect();
    const icon = fab.querySelector('.fab-start-icon');
    return { x: r.left, y: r.top, w: r.width, h: r.height, i: (icon && parseFloat(getComputedStyle(icon).width)) || 26 };
  };
  const flySetBox = (which, b) => {                      // which: '0' (from) or '1' (to)
    const s = fly.layer.style;
    s.setProperty('--fx' + which, b.x + 'px'); s.setProperty('--fy' + which, b.y + 'px');
    s.setProperty('--fw' + which, b.w + 'px'); s.setProperty('--fh' + which, b.h + 'px');
    s.setProperty('--fi' + which, b.i + 'px');
  };
  /** Take off from the outgoing rail (idempotent: a swipe that changes direction keeps its one flight). */
  function flyBegin() {
    const fab = $('fab-start-btn');
    if (fly || !fab) return;
    const home = fab.parentElement;
    const from = fabBox(fab);
    const layer = document.createElement('div');
    layer.className = 'md-rail-fab-slot fab-flight';
    fly = { layer, fab, from, to: from, home };
    flySetBox('0', from); flySetBox('1', from);
    layer.style.setProperty('--fab-t', '0');
    (tabBarEl ?? document.body).after(layer);
    layer.appendChild(fab);
  }
  /** Aim at the FAB's box in `rail` (null: back to where it started). Measured by putting the FAB in that
   *  rail's slot for a moment, at the rail's unstacked size -- the same layout it will have on arrival (the
   *  slot reserves the FAB's height while empty, so nothing else in the rail moves when it lands). */
  function flyAim(rail) {
    if (!fly) return;
    let to = fly.from;
    const slot = rail?.querySelector('.md-rail-fab-slot');
    if (slot) {
      const keep = rail.style.getPropertyValue('--rail-stack');
      setStack(rail, 0);
      const held = fly.fab.parentElement;
      slot.appendChild(fly.fab);
      to = fabBox(fly.fab);
      held.appendChild(fly.fab);
      if (keep) setStack(rail, keep); else rail.style.removeProperty('--rail-stack');
    }
    fly.to = to;
    flySetBox('1', to);
    // Same box in both rails: nowhere to glide to, so it folds with the rails instead (.fab-fold, style.css).
    // Aiming back at the start (rail == null) leaves the class alone: the dial is at 0 and nothing shows.
    if (rail) {
      const f = fly.from;
      const same = ['x', 'y', 'w', 'h'].every(k => Math.abs(f[k] - to[k]) < 1);
      fly.layer.classList.toggle('fab-fold', same);
    }
  }
  const flyT = t => fly?.layer.style.setProperty('--fab-t', String(t));
  /** Landed (or cancelled). On a commit switchTab() has already moved the FAB into the new rail's slot, so
   *  only a FAB still in the layer is put back where it started. */
  function flyEnd() {
    if (!fly) return;
    const { layer, fab, home } = fly;
    fly = null;
    if (fab.parentElement === layer) home.appendChild(fab);
    layer.remove();
  }

  // Shows the panel `dir` steps away (+1 = next tab, on the right) parked just
  // off-screen, and runs its per-tab load now so it has real content to peek.
  function beginPeek(dir) {
    const tabs = navTabs();
    const idx  = tabs.findIndex(b => b.classList.contains('active'));
    const next = g.target ?? tabs[idx + dir];   // g.target: a tap names its tab, which needn't be the neighbour
    if (idx < 0 || !next) return null;
    const name  = next.dataset.tab;
    const panel = panelOf(name);
    if (!panel) return null;
    // Stale enter-animation classes would replay the moment the panel stops
    // being display:none, so clear them.
    panel.classList.remove('panel-enter-l', 'panel-enter-r');
    panel.classList.add('swipe-peek');
    panel.style.transform = `translate3d(${dir * width()}px,0,0)`;
    panel.classList.remove('hidden');
    if (!g.loaded.has(name)) { g.loaded.add(name); _runTabLoad(name); }
    // The incoming tab's rail rides along: fully stacked (so it starts out
    // invisible), revealed now and unstacked by render() as the drag goes,
    // instead of appearing after the panel lands.
    const rail = railFor(name);
    if (rail) {
      rail.classList.add('swiping');
      setStack(rail, 1);
      rail.classList.remove('hidden');
    }
    // The FAB leaves its rail for the length of the swipe and heads for this one (flyBegin() above).
    flyBegin();
    flyAim(rail);
    return { dir, name, panel, btn: next, rail };
  }

  function endPeek(peek) {
    flyAim(null);   // no neighbour any more -- the FAB heads back to where it started (flyT(0) in render())
    peek.panel.classList.remove('swipe-peek', 'swipe-settle');
    peek.panel.style.transform = '';
    peek.panel.classList.add('hidden');
    if (peek.rail) { railEnd(peek.rail); peek.rail.classList.add('hidden'); }
    // The tab-btn highlight this peek was transferring toward (render()
    // below is what actually drives it while dragging) drops back to
    // whatever its .active class alone says.
    peek.btn.style.removeProperty('--activation');
  }

  function render(rawDx) {
    const w  = width();
    const dx = Math.max(-w, Math.min(w, rawDx));
    const dir = dx < 0 ? 1 : dx > 0 ? -1 : 0;
    if (g.peek && g.peek.dir !== dir) {
      endPeek(g.peek);
      g.peek = null;
      g.curBtn.style.setProperty('--activation', '1'); setStack(g.curRail, 0);   // no longer heading anywhere — back to fully on
    }
    if (dir && !g.peek && !g.blocked.has(dir)) {
      g.peek = beginPeek(dir);
      if (!g.peek) g.blocked.add(dir);
    }
    const shown = (dir && !g.peek) ? dx * EDGE_RESISTANCE : dx;
    g.cur.style.transform = `translate3d(${shown}px,0,0)`;
    if (g.peek) {
      g.peek.panel.style.transform = `translate3d(${g.peek.dir * w + dx}px,0,0)`;
      // Transfers the tab-bar highlight in step with the panel's own
      // drag — same dx, scaled the same 0–1 way the comment on
      // --activation (style.css) describes. No transition is active here
      // (.tab-bar.swiping above turns it off, same as .panel.swipe-drag
      // never transitions its own transform), so this tracks the finger
      // 1:1 exactly like the panel does, rather than lagging behind it.
      const t = Math.min(1, Math.abs(dx) / w);
      g.curBtn.style.setProperty('--activation', String(1 - t));
      g.peek.btn.style.setProperty('--activation', String(t));
      // Same 0-1 dial for the rails: this one stacks as the other unstacks.
      setStack(g.curRail, t);
      setStack(g.peek.rail, 1 - t);
      flyT(t);
    } else {
      flyT(0);
    }
  }

  function velocity() {           // px/ms over roughly the last 100ms
    const a = g.samples[0], b = g.samples[g.samples.length - 1];
    return (a && b && b.t > a.t) ? (b.x - a.x) / (b.t - a.t) : 0;
  }

  // Hands both panels back to normal flow — instantly, no animation.
  function reset(cur, curBtn, curRail, peek) {
    cur.classList.remove('swipe-drag', 'swipe-settle');
    cur.style.transform = '';
    tabBarEl?.classList.remove('swiping', 'swipe-settling');
    curBtn.style.removeProperty('--activation');
    railEnd(curRail);
    if (peek) endPeek(peek);
    flyEnd();
  }

  function settleGesture(commit) {
    const { cur, curBtn, curRail, peek, dx } = g;
    if (g.claimed) guard.release();
    g = null;
    const w = width();

    const done = () => {
      settle = null;
      cur.classList.remove('swipe-drag', 'swipe-settle');
      cur.style.transform = '';
      // Whichever finished last — the settle transition below, or the
      // instant bail-out right under this — this is the one place both
      // paths end up, so it's the right spot to drop the tab bar out of
      // "mid-swipe" mode regardless of how the gesture ended.
      tabBarEl?.classList.remove('swiping', 'swipe-settling');
      if (peek) {
        if (commit) {
          peek.panel.classList.remove('swipe-peek', 'swipe-settle');
          peek.panel.style.transform = '';
          // The incoming rail was revealed when the peek began and has been
          // unstacking in step with the drag and this settle, so it is
          // already fully open here (its --rail-stack is 0). Drop both
          // rails' swipe state *before* switchTab(): it re-measures the
          // now-visible rail's height (refreshPosition() -> --rail-h, the
          // pane's bottom padding), which has to read the full rail, not a
          // still-stacked one if the settle was cut short. curRail is about
          // to be hidden by switchTab() -- clearing its dial means it opens
          // normally the next time it is shown some other way.
          railEnd(peek.rail);
          railEnd(curRail);
          switchTab(peek.name, { animate: false, preloaded: true });
          // switchTab() above already flipped .active onto peek.btn and
          // off curBtn — clearing the inline --activation overrides just
          // lets that class-driven CSS show through cleanly instead of
          // staying pinned to wherever the drag left them.
          curBtn.style.removeProperty('--activation');
          peek.btn.style.removeProperty('--activation');
        } else {
          railEnd(curRail);   // same rail, unstacks back to its own full set
          endPeek(peek);   // clears peek.btn's --activation
        }
      } else {
        railEnd(curRail);   // edge-resistance drag, no peek ever formed — still unstacks back
      }
      flyEnd();   // the FAB lands: in the new rail's slot after a commit (switchTab above), back in its own otherwise
    };

    const ms = _cssTimeMs('--swipe-settle', 240);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (ms <= 0 || reduced || (!peek && Math.abs(dx) < 1)) { done(); return; }

    cur.classList.add('swipe-settle');
    peek?.panel.classList.add('swipe-settle');
    // Re-enables exactly one transition (style.css's .swiping.swipe-settling
    // rule) so the highlight eases from wherever the drag left it to its
    // final value over the same --swipe-settle/--swipe-ease timing as the
    // panel's own slide, landing in the same instant instead of snapping.
    tabBarEl?.classList.add('swipe-settling');
    curRail?.classList.add('swipe-settling');
    peek?.rail?.classList.add('swipe-settling');
    if (peek) {
      curBtn.style.setProperty('--activation', commit ? '0' : '1');
      peek.btn.style.setProperty('--activation', commit ? '1' : '0');
      setStack(curRail, commit ? 1 : 0);
      setStack(peek.rail, commit ? 0 : 1);
      fly?.layer.classList.add('swipe-settling');
      flyT(commit ? 1 : 0);
    }
    void cur.offsetWidth;   // flush, so the transition starts from the finger's last position
    cur.style.transform = `translate3d(${commit ? -peek.dir * w : 0}px,0,0)`;
    if (peek) peek.panel.style.transform = `translate3d(${commit ? 0 : peek.dir * w}px,0,0)`;

    let finished = false;
    const watch = peek?.panel ?? cur;
    const onEnd = e => { if (e.target === watch && e.propertyName === 'transform') finish(); };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      watch.removeEventListener('transitionend', onEnd);
      done();
    };
    const timer = setTimeout(finish, ms + 40);
    watch.addEventListener('transitionend', onEnd);
    settle = { finish };
  }

  _swipeAbort = () => {
    settle?.finish();
    if (g) { if (g.claimed) guard.release(); reset(g.cur, g.curBtn, g.curRail, g.peek); g = null; }
  };

  // A tap on the tab bar: the same gesture a finger would make, played by hand. Parks the target tab's panel
  // at the edge it would swipe in from (one px in, so render() peeks it exactly as a drag does), then hands
  // over to settleGesture(true) -- so the panels, the tab buttons, the rails' stack dial and the FAB's flight
  // all run over --swipe-settle / --swipe-ease together, at one speed whatever the distance between the tabs.
  _swipeTo = name => {
    if (settle) settle.finish();                         // the last move still landing: land it now
    if (g || !_onSwipeableTab()) return false;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || _cssTimeMs('--swipe-settle', 240) <= 0) return false;
    const tabs = navTabs();
    const idx  = tabs.findIndex(b => b.classList.contains('active'));
    const tIdx = tabs.findIndex(b => b.dataset.tab === name);
    if (idx < 0 || tIdx < 0 || idx === tIdx) return false;
    const curBtn = tabs[idx], cur = panelOf(curBtn.dataset.tab);
    if (!cur || !panelOf(name)) return false;
    g = {
      startX: 0, startY: 0, phase: 'dragging', cur, curBtn, curRail: railFor(curBtn.dataset.tab), peek: null, dx: 0,
      samples: [], loaded: new Set(), blocked: new Set(), target: tabs[tIdx],
    };
    cur.classList.add('swipe-drag');
    tabBarEl?.classList.add('swiping');
    g.curRail?.classList.add('swiping');
    infoTooltips.closeAll();
    const dir = tIdx > idx ? 1 : -1;
    render(-dir);
    if (!g.peek) { reset(cur, curBtn, g.curRail, null); g = null; return false; }
    settleGesture(true);
    return true;
  };

  app.addEventListener('touchstart', e => {
    if (settle) settle.finish();                         // last swipe still landing: land it now
    if (g) {                                             // a second finger mid-drag: back off
      if (g.phase === 'dragging') settleGesture(false); else g = null;
      return;
    }
    if (e.touches.length !== 1 || !_onSwipeableTab() || _swipeBlocked(e.target)) return;
    const curBtn = navTabs().find(b => b.classList.contains('active'));
    const name = curBtn?.dataset.tab;
    const cur  = name && panelOf(name);
    if (!cur) return;
    g = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      phase: 'pending', cur, curBtn, curRail: railFor(name), peek: null, dx: 0,
      samples: [], loaded: new Set(), blocked: new Set(),
    };
  }, { passive: true });

  // Not passive: once the drag is clearly horizontal we preventDefault() so
  // the browser doesn't also start scrolling the panel underneath it.
  app.addEventListener('touchmove', e => {
    if (!g || e.touches.length !== 1) return;
    const t  = e.touches[0];
    const dx = t.clientX - g.startX;
    const dy = t.clientY - g.startY;
    if (g.phase === 'pending') {
      if (Math.hypot(dx, dy) < LOCK_SLOP) return;
      if (Math.abs(dx) <= Math.abs(dy)) { g = null; return; }   // vertical: it's a scroll, not ours
      g.phase = 'dragging';
      g.cur.classList.add('swipe-drag');
      tabBarEl?.classList.add('swiping');
      // The on-screen rail joins the swipe: .swiping hands its stack dial
      // to render() below (--rail-stack, style.css), so it stacks down in
      // step with the drag instead of jumping on lock.
      g.curRail?.classList.add('swiping');
      infoTooltips.closeAll();
    }
    if (e.cancelable) e.preventDefault();
    const now = performance.now();
    g.samples.push({ x: t.clientX, t: now });
    while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift();
    g.dx = dx;
    claimIfFarEnough(dx);
    render(dx);
  }, { passive: false });

  app.addEventListener('touchend', e => {
    if (!g) return;
    if (g.phase !== 'dragging') { g = null; return; }
    if (g.claimed && e.cancelable) e.preventDefault();   // no compat mouse events, no click
    const w = width(), dx = g.dx, v = velocity();
    const backing = Math.abs(v) > FLING_VELOCITY && Math.sign(v) !== Math.sign(dx);   // flicked back the way it came
    const far   = Math.abs(dx) > w * COMMIT_FRACTION;
    const flick = Math.abs(v) > FLING_VELOCITY && Math.abs(dx) > FLING_MIN_DIST && Math.sign(v) === Math.sign(dx);
    settleGesture(!!g.peek && !backing && (far || flick));
  }, { passive: false });

  app.addEventListener('touchcancel', () => {
    if (!g) return;
    if (g.phase === 'dragging') settleGesture(false); else g = null;
  });

  // ── Mouse (desktop/PC) ────────────────────────────────────────────────
  // Same state machine as the touch handlers above, driven by mouse events
  // instead of touches — a click-drag on a trackpad or mouse now does the
  // same peek/commit/settle dance a finger swipe does. mousemove/mouseup
  // are bound on window rather than app: once a drag is under way the
  // cursor can move past app's own bounds (fast drags, or dragging right
  // off the panel edge) and would otherwise stop delivering events.
  app.addEventListener('mousedown', e => {
    if (e.button !== 0) return;                          // primary button only
    if (settle) settle.finish();
    if (g) return;                                        // a touch gesture is already in progress
    if (!_onSwipeableTab() || _swipeBlocked(e.target)) return;
    const curBtn = navTabs().find(b => b.classList.contains('active'));
    const name = curBtn?.dataset.tab;
    const cur  = name && panelOf(name);
    if (!cur) return;
    g = {
      startX: e.clientX,
      startY: e.clientY,
      phase: 'pending', cur, curBtn, curRail: railFor(name), peek: null, dx: 0,
      samples: [], loaded: new Set(), blocked: new Set(),
      mouse: true,
    };
  });

  window.addEventListener('mousemove', e => {
    if (!g || !g.mouse) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.phase === 'pending') {
      if (Math.hypot(dx, dy) < LOCK_SLOP) return;
      if (Math.abs(dx) <= Math.abs(dy)) { g = null; return; }   // vertical: not ours
      g.phase = 'dragging';
      g.cur.classList.add('swipe-drag');
      tabBarEl?.classList.add('swiping');
      g.curRail?.classList.add('swiping');
      infoTooltips.closeAll();
      window.getSelection?.()?.removeAllRanges();   // drop any text selection nicked before the lock threshold
    }
    e.preventDefault();   // stop the browser turning the drag into a text/image selection
    const now = performance.now();
    g.samples.push({ x: e.clientX, t: now });
    while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift();
    g.dx = dx;
    claimIfFarEnough(dx);
    render(dx);
  });

  const _endMouseDrag = () => {
    if (!g || !g.mouse) return;
    if (g.phase !== 'dragging') { g = null; return; }
    const w = width(), dx = g.dx, v = velocity();
    const backing = Math.abs(v) > FLING_VELOCITY && Math.sign(v) !== Math.sign(dx);
    const far   = Math.abs(dx) > w * COMMIT_FRACTION;
    const flick = Math.abs(v) > FLING_VELOCITY && Math.abs(dx) > FLING_MIN_DIST && Math.sign(v) === Math.sign(dx);
    settleGesture(!!g.peek && !backing && (far || flick));
  };
  window.addEventListener('mouseup', _endMouseDrag);
  // Mouse button released outside the window (e.g. over the OS taskbar), or
  // focus left the window entirely mid-drag (alt-tab): land the gesture
  // instead of leaving it stuck mid-drag with no further mouseup coming.
  window.addEventListener('blur', _endMouseDrag);
}

// Reads a CSS time custom property (e.g. "240ms" / ".24s") off :root, in ms.
function _cssTimeMs(prop, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.endsWith('ms') ? n : n * 1000;
}

// True only while a plain nav-tab panel is on screen — not the live session
// (its chart carousel owns horizontal swipes there) and not behind an open
// overlay (FAB menu, quick-start, advanced wizard).
function _onSwipeableTab() {
  const overlayOpen =
    !$('fab-menu')?.classList.contains('hidden') ||
    detailSheet.isOpen;
  if (overlayOpen) return false;
  return $('session-panel')?.classList.contains('hidden') ?? true;
}

// A touch that starts on something which owns horizontal drags itself: a
// sideways scroller (see below), a range slider, or a chart in its armed
// pan/zoom mode. Opt any other element out with data-no-swipe.
function _swipeBlocked(target) {
  if (_insideHorizontalScroller(target)) return true;
  const el = target instanceof Element ? target : target?.parentElement;
  return !!el?.closest('input[type="range"], .chart-page.locked, [data-no-swipe]');
}

// Walks up from a touch's target looking for an ancestor that already
// scrolls horizontally (e.g. .chart-track, .setup-flow-steps), so a swipe
// meant for that element doesn't also get read as a tab-change gesture.
function _insideHorizontalScroller(target) {
  let el = target instanceof Element ? target : target?.parentElement;
  while (el && el !== document.body) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    el = el.parentElement;
  }
  return false;
}

// Per-tab work that has to happen when a tab's panel is about to be seen.
// Split out of switchTab() so a swipe can run it as the panel starts to peek
// in (it needs real content on screen while it slides), and switchTab() then
// skips it on commit rather than loading twice.
function _runTabLoad(name) {
  if (name === 'overview') overviewPage?.load();
  if (name === 'diet')     dietPage?.load();
  if (name === 'history')  historyBrowser?.load();
  if (name === 'workout')  workoutEditor?.onShow();
  if (name === 'settings') { populateSettingsUI(); renderZoneStrip(); renderHrZoneStrip(); _renderWeighInReviewSub(); }
}

// opts.animate:   false skips the slide-in class (a swipe already slid it in).
// opts.preloaded: true skips the per-tab load (a swipe already ran it while peeking).
/** Shows or hides the bottom tab bar to match whatever panel is on screen:
 *  hidden for both live workout views ('session' = cardio, 'strength' only
 *  while a strength session is actually running — see switchTab()'s own
 *  comment on why the idle fallback keeps the bar). Reads the DOM instead of
 *  taking a tab name because it has two callers: switchTab(), and
 *  startStrengthSession(), which has to re-run it after creating its session
 *  — switchTab('strength') fires *before* that session exists, so the check
 *  inside switchTab() alone would see "no session" and leave the bar up. */
function _syncTabBarVisibility() {
  const name = document.querySelector('[data-panel]:not(.hidden)')?.dataset.panel;
  const liveView = name === 'session' || (name === 'strength' && !!strengthSession);
  document.querySelector('.tab-bar')?.classList.toggle('hidden', liveView);
}

function switchTab(name, { animate = true, preloaded = false } = {}) {
  _swipeAbort();
  infoTooltips.closeAll();
  detailSheet.close();   // a sheet belongs to the screen that opened it

  // Figure out whether we're moving to a later or earlier tab (by its
  // position in the bottom nav) so the incoming panel can slide in from
  // the matching side — same direction a swipe in that spot would produce.
  // 'session' isn't in the nav (no data-tab), so this is skipped for it.
  const navTabs = Array.from(document.querySelectorAll('.tab-bar [data-tab]'));
  const prevIdx = navTabs.findIndex(b => b.classList.contains('active'));
  const nextIdx = navTabs.findIndex(b => b.dataset.tab === name);
  const panel = document.querySelector(`[data-panel="${name}"]`);
  if (animate && panel && prevIdx >= 0 && nextIdx >= 0 && prevIdx !== nextIdx) {
    panel.classList.remove('panel-enter-l', 'panel-enter-r');
    panel.classList.add(nextIdx > prevIdx ? 'panel-enter-r' : 'panel-enter-l');
  }

  document.querySelectorAll('[data-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('[data-panel]').forEach(p =>
    p.classList.toggle('hidden', p.dataset.panel !== name));
  // Each tab's md-rail (Settings/Overview/History/Diet) now lives outside
  // its [data-panel] entirely — ui/master-detail.js's constructor moves it
  // to be a sibling of .tab-bar instead, so it's never nested inside the
  // element app.js's swipe nav and panel-enter animations apply `transform`
  // to (see that constructor's own comment for why: nested, that transform
  // hijacks position: fixed's containing block and drags the rail along
  // with the panel's slide). Hiding the [data-panel] above no longer hides
  // its rail as a side effect, so mirror that same active/hidden split onto
  // every relocated rail here, via the data-rail-for this constructor set
  // to match its owning panel's data-panel.
  document.querySelectorAll('.md-rail[data-rail-for]').forEach(r =>
    r.classList.toggle('hidden', r.dataset.railFor !== name));
  _placeFabInRail(name);
  // The md-rail (Settings/Overview/History/Diet — ui/master-detail.js)
  // reserves its own rendered height in its pane's bottom padding (--rail-h,
  // style.css's .md-pane — see the class's own comment) from a live
  // offsetHeight read, which is worthless while the panel it lives in was
  // hidden (a display:none ancestor collapses that read to zero) — exactly
  // the state Settings/History/Diet's rails are actually built in during
  // init() (Overview happens to start as the visible tab, so it's never
  // wrong, but gets the same call rather than being special-cased out).
  // Re-run it now that the panel above is visible, so a tab's pane isn't
  // left under-reserving space for its own rail until the rider happens to
  // trigger a collapse toggle (the only other thing that re-measures it).
  if (name === 'settings') settingsRail?.refreshPosition();
  if (name === 'overview') overviewPage?.refreshRailPosition();
  if (name === 'history')  historyBrowser?.refreshRailPosition();
  if (name === 'diet')     dietPage?.refreshRailPosition();
  // Both live workout views take the whole screen while they're active —
  // hide the bottom nav bar rather than leave it floating over the session
  // UI. It comes back the moment any other tab (including via the resume
  // bar, for cardio) becomes active again. (.train-panel in style.css no
  // longer reserves space for the bar for the same reason.) 'strength' only
  // counts as live when a strength session is actually running: the
  // defensive _renderStrengthIdle() fallback below can reach this panel
  // with none, and that screen has no rail and no other way out, so it
  // keeps the bar rather than becoming a dead end.
  _syncTabBarVisibility();
  // The "+" button now lives inside the active tab's rail (_placeFabInRail
  // above) instead of floating independently, so it's hidden automatically
  // whenever that rail is — true for both live session views ('session'
  // and 'strength'), neither of which has a rail. Its pillbox menu is
  // still its own fixed-position sibling of #app, not nested in any rail,
  // so it doesn't get hidden the same way — close it explicitly on the way
  // into either, in case it was left open.
  if (name === 'session' || name === 'strength') _closeFabMenu();
  if (!preloaded) _runTabLoad(name);
  // Defensive fallback only — every real path onto this nav-less panel
  // (startStrengthSession(), _openRestoredStrengthSession()) already has a
  // session running by the time it calls switchTab('strength'), and
  // _onStrengthSessionEnd() now leaves the panel for History rather than
  // switching back to it. Renders something reasonable rather than a
  // blank panel on the off chance this is ever reached with no session.
  if (name === 'strength' && !strengthSession) _renderStrengthIdle();
  _updateResumeBar();
}

// The live session view (data-panel="session") has no nav tab of its own —
// it's opened via Start (any FAB menu flow — Cardio Session or Repeat
// Last — or the keyboard shortcut) and minimized by navigating to any
// other tab, same as any other panel
// above. This pill is the way back in: it shows whenever a session is
// running but that panel isn't the one currently on screen.
function _updateResumeBar() {
  const bar = $('session-resume-bar');
  if (!bar) return;
  const minimized = $('session-panel')?.classList.contains('hidden');
  const running    = session?.isRunning ?? false;
  bar.classList.toggle('hidden', !(running && minimized));
  if (running) {
    setText('session-resume-name', $('workout-name-input')?.value?.trim() || loadedWorkout?.name || 'Free Ride');
    setText('session-resume-elapsed', _fmtDuration(_lastElapsedSec));
  }
}

// ─── Bind ─────────────────────────────────────────────────────────────────────

function bindControls() {
  // Developer tools (currently just the BLE Debug Console) are only
  // meaningful against a live `vite dev` session, not a built app — the
  // General category's Developer row is hidden outside dev mode instead
  // (see #developer-settings-group, toggled once alongside settingsRail's
  // own creation).

  $('session-resume-bar')?.addEventListener('click', () => switchTab('session'));
  $('start-btn')     ?.addEventListener('click', startSession);
  $('fab-start-btn')      ?.addEventListener('click', () => _toggleFabMenu());
  $('fab-menu-cardio')    ?.addEventListener('click', () => { _closeFabMenu(); openQuickStart(); });
  $('fab-menu-strength')  ?.addEventListener('click', () => { _closeFabMenu(); openStrengthSession(); });
  $('fab-menu-repeat')    ?.addEventListener('click', () => { _closeFabMenu(); repeatLastWorkout(); });
  $('fab-menu-editor')    ?.addEventListener('click', () => { _closeFabMenu(); openWorkoutEditor(); });
  $('trainer-menu-btn')       ?.addEventListener('click', () => _toggleTrainerMenu());
  // Each device button below both connects (its role is empty) and
  // disconnects (its role is already occupied — gated on a confirm, since
  // that drops a live reading or the ride's controller). The old
  // standalone "Disconnect" item is gone; its job now lives on whichever
  // Connect button is already lit up — see _updateDeviceMenuItem().
  $('trainer-menu-connect')?.addEventListener('click', () => {
    _closeTrainerMenu();
    if (trainer) { if (confirm(`Disconnect ${trainer.name ?? 'trainer'}?`)) disconnectTrainer(); }
    else connectController();
  });
  $('trainer-menu-connect-hrm')?.addEventListener('click', () => {
    _closeTrainerMenu();
    const hrm = auxSensors.get('hr-monitor');
    if (hrm) { if (confirm(`Disconnect ${hrm.name}?`)) disconnectAuxSensor(hrm.id); }
    else connectHrMonitor();
  });
  $('trainer-menu-connect-smo2')?.addEventListener('click', () => {
    _closeTrainerMenu();
    const smo2 = _findAuxByKind('smo2');
    if (smo2) { if (confirm(`Disconnect ${smo2.name}?`)) disconnectAuxSensor(smo2.id); }
    else connectSmo2Monitor();
  });
  $('trainer-menu-connect-coretemp')?.addEventListener('click', () => {
    _closeTrainerMenu();
    const coreTemp = _findAuxByKind('coreTemp');
    if (coreTemp) { if (confirm(`Disconnect ${coreTemp.name}?`)) disconnectAuxSensor(coreTemp.id); }
    else connectCoreTempSensor();
  });
  // Any click outside a menu (and not on that menu's own toggle button,
  // which has its own handler above) closes it — same "tap away to
  // dismiss" convention as the setup-flow overlays' backdrop click.
  document.addEventListener('click', e => {
    const fabMenu = $('fab-menu');
    if (fabMenu && !fabMenu.classList.contains('hidden') &&
        !fabMenu.contains(e.target) && !$('fab-start-btn')?.contains(e.target)) {
      _closeFabMenu();
    }
    const trainerMenu = $('trainer-menu');
    if (trainerMenu && !trainerMenu.classList.contains('hidden') &&
        !trainerMenu.contains(e.target) && !$('trainer-menu-btn')?.contains(e.target)) {
      _closeTrainerMenu();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { _closeFabMenu(); _closeTrainerMenu(); }
  });
  $('stop-btn')      ?.addEventListener('click', stopSession);
  $('lap-btn')       ?.addEventListener('click', markLap);
  const lockBtn = $('lock-btn');
  // #lock-btn is dual-purpose: unlocked, a tap locks the screen; locked,
  // it IS the "Hold to Unlock" control (CSS reskins the same button, see
  // #session-control-bar.locked #lock-btn in style.css) — there's no
  // separate unlock element, so both the click and the hold-tracking
  // pointer events bind to this one button.
  lockBtn?.addEventListener('click', () => {
    // A hold that just completed unlockScreen() still ends in a 'click'
    // from that same press/release — swallow exactly that one click so
    // it doesn't immediately call lockScreen() again. See _armUnlockHold().
    if (_suppressLockClick) { _suppressLockClick = false; return; }
    lockScreen();
  });
  lockBtn?.addEventListener('pointerdown',  _armUnlockHold);
  lockBtn?.addEventListener('pointerup',    _cancelUnlockHold);
  lockBtn?.addEventListener('pointerleave', _cancelUnlockHold);
  lockBtn?.addEventListener('pointercancel',_cancelUnlockHold);
  $('pause-btn')     ?.addEventListener('click', togglePause);
  $('apply-target')  ?.addEventListener('click', applyTarget);
  $('nudge-up')      ?.addEventListener('click', () => nudgeTarget(+1));
  $('nudge-down')    ?.addEventListener('click', () => nudgeTarget(-1));
  // Note: no "snap to live" control here — the live-session chart pages run
  // singleMetric (see ChartCarousel/ChartEngine), which intentionally leaves
  // drag/wheel panning disabled so horizontal gestures stay reserved for
  // swiping between metrics. There's no way to scroll the time axis away
  // from the live edge in this view, so a Live button would have nothing to
  // do — that control belongs on the History detail chart instead, which
  // does support panning.
  $('mode-select')   ?.addEventListener('change', e => updateTargetHints(e.target.value));
  $('cal-start-btn') ?.addEventListener('click', startCalibration);
  $('cal-stop-btn')  ?.addEventListener('click', stopCalibration);
  $('shift-up')      ?.addEventListener('click', () => modeSwitch?.shiftUp());
  $('shift-down')    ?.addEventListener('click', () => modeSwitch?.shiftDown());
  // Autosave — delegated so every current and future pref-* field (text
  // inputs, checkboxes, the age/sex select, etc.) is covered by one
  // listener instead of needing its own. Filtered to id starting "pref-"
  // so it only fires for fields _readPreferenceFieldsFromForm() actually
  // reads — not, say, body-comp-toggle (no backing preference — see
  // _toggleBodyCompPanel()'s doc comment) or pref-background (applies and
  // persists immediately via applyBackgroundNotificationChange() below,
  // same as pref-units already does via applyUnitsChange()). Both 'input'
  // (text fields, as the rider types) and 'change' (checkboxes/selects)
  // are bound since which one a given control fires varies.
  const _onAutosaveField = e => {
    if (e.target?.id?.startsWith('pref-') && e.target.id !== 'pref-background') _scheduleAutosave();
  };
  // $() only looks up by id (see its definition), so this one needs a real
  // querySelector — .settings-page wraps every field in the Settings tab.
  const settingsPageEl = document.querySelector('.settings-page');
  settingsPageEl?.addEventListener('input', _onAutosaveField);
  settingsPageEl?.addEventListener('change', _onAutosaveField);
  $('autosave-revert-btn') ?.addEventListener('click', _revertAutosave);
  $('autosave-confirm-btn')?.addEventListener('click', _confirmAutosave);
  $('open-ble-debug')?.addEventListener('click', () => bleDebugFlow?.open());
  $('sync-scale-btn')?.addEventListener('click', () => connectSmartScale());
  $('weigh-in-history-btn')?.addEventListener('click', () => weighInManager?.open());
  $('open-cardio-zone-reference')?.addEventListener('click', () => cardioZoneReferenceSheet?.open());
  $('profile-export-btn')?.addEventListener('click', () => profileBackupFlow?.exportBackup());
  $('profile-import-btn')?.addEventListener('click', () => profileBackupFlow?.importBackup());
  // Body composition's disclosure control — a real switch now (matches
  // Auto Pause's Control modes row look), so it drives its panel exactly
  // like pref-auto-pause-trigger-modes below: no backing preference, see
  // _toggleBodyCompPanel()'s doc comment. The info-btn sits outside the
  // switch's own <label> now, so — unlike before — it doesn't need a guard
  // to stop its click from also flipping this.
  $('body-comp-toggle')?.addEventListener('change', e => {
    $('body-comp-panel')?.classList.toggle('hidden', !e.target.checked);
  });
  // Auto Pause's three levels (the switch itself → its own trigger
  // checklist → each trigger's nested per-type checklist) — declared once,
  // up front, since every listener below (panel show/hide, the on-cascade,
  // and the off-cascade) reads from the same three lists.
  _ensureAutoPauseHideRow(); // before anything below looks the row up by id
  const AUTO_PAUSE_CONTROLLER_TYPE_IDS = ['pref-auto-pause-ctrl-controller', 'pref-auto-pause-ctrl-hrm', 'pref-auto-pause-ctrl-temps'];
  const AUTO_PAUSE_CONTROL_MODE_IDS    = ['pref-auto-pause-mode-erg', 'pref-auto-pause-mode-resistance', 'pref-auto-pause-mode-slope', 'pref-auto-pause-mode-virtualGear'];
  const AUTO_PAUSE_TRIGGER_IDS         = ['pref-auto-pause-trigger-idle', AUTO_PAUSE_HIDE_ID, 'pref-auto-pause-trigger-controller', 'pref-auto-pause-trigger-modes'];

  // The trigger/controller-type/mode panel below Auto Pause now expands
  // and collapses with the switch itself — no separate chevron button
  // (there's nothing useful to configure in there once auto-pause is off).
  // Switching it back ON also forces every trigger back on (see
  // _forceChildrenOn's doc comment) — and because that dispatches a real
  // 'change' on each one, the cascade keeps going another level down too,
  // via each trigger's own listener below.
  $('pref-auto-pause')?.addEventListener('change', e => {
    $('auto-pause-triggers')?.classList.toggle('hidden', !e.target.checked);
    if (e.target.checked) _forceChildrenOn(AUTO_PAUSE_TRIGGER_IDS);
  });
  // Same idea one level down: each nested checklist only expands while its
  // own trigger row above it is on (nothing useful to configure per-
  // controller-type/per-mode once that trigger itself won't apply) — and
  // switching the trigger back on forces its own checklist back on too.
  $('pref-auto-pause-trigger-controller')?.addEventListener('change', e => {
    $('auto-pause-controller-types')?.classList.toggle('hidden', !e.target.checked);
    if (e.target.checked) _forceChildrenOn(AUTO_PAUSE_CONTROLLER_TYPE_IDS);
  });
  $('pref-auto-pause-trigger-modes')?.addEventListener('change', e => {
    $('auto-pause-control-modes')?.classList.toggle('hidden', !e.target.checked);
    if (e.target.checked) _forceChildrenOn(AUTO_PAUSE_CONTROL_MODE_IDS);
  });
  // Auto-off cascade (see _autoDisableIfAllChildrenOff's doc comment):
  // unticking the last box in either nested checklist can turn off its own
  // trigger above it, which — via the very same check one level up — can
  // in turn turn off Auto Pause itself, if that was the last trigger left on.
  AUTO_PAUSE_CONTROLLER_TYPE_IDS.forEach(id => $(id)?.addEventListener('change', () =>
    _autoDisableIfAllChildrenOff(AUTO_PAUSE_CONTROLLER_TYPE_IDS, 'pref-auto-pause-trigger-controller')));
  AUTO_PAUSE_CONTROL_MODE_IDS.forEach(id => $(id)?.addEventListener('change', () =>
    _autoDisableIfAllChildrenOff(AUTO_PAUSE_CONTROL_MODE_IDS, 'pref-auto-pause-trigger-modes')));
  AUTO_PAUSE_TRIGGER_IDS.forEach(id => $(id)?.addEventListener('change', () =>
    _autoDisableIfAllChildrenOff(AUTO_PAUSE_TRIGGER_IDS, 'pref-auto-pause')));
  $('start-vo2max-test') ?.addEventListener('click', startVo2MaxTest);
  $('start-ftp-ramp-test') ?.addEventListener('click', startFtpRampTest);
  $('start-ftp-20min-test')?.addEventListener('click', startFtpTwentyMinTest);
  $('start-resting-hr-test')?.addEventListener('click', startRestingHrTest);
  $('pref-window')   ?.addEventListener('change', e => chartCarousel?.setWindow(parseInt(e.target.value)||300));
  $('pref-units')?.addEventListener('click', e => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    $('pref-units').querySelectorAll('.segmented-btn').forEach(b => b.classList.toggle('active', b === btn));
    applyUnitsChange(btn.dataset.value === 'imperial' ? 'imperial' : 'metric');
  });
  // Background workout notification — applies immediately, like units above.
  $('pref-background')?.addEventListener('change', e => applyBackgroundNotificationChange(!!e.target.checked));
  $('background-open-settings')?.addEventListener('click', () => backgroundSession.openNotificationSettings());
}

// ─── FAB menu ─────────────────────────────────────────────────────────────────
// The floating + opens a small pillbox menu with four ways to get into a
// session or start building one — the "strength" and "workout" bottom nav
// tabs are both gone, so this is now the only entry point for either:
//   - Cardio Session:    single-screen flow (type/name/gear/duration),
//                        starts the session the moment "Start Workout" is
//                        tapped.
//   - Strength Session:  jumps straight to the Strength panel, which opens
//                        on its own idle "Start Strength Session" prompt —
//                        same one-tap-to-begin shape as Cardio Session.
//   - Repeat Last:       re-runs whatever Cardio Session settings were used
//                        last time, with no dialog at all.
//   - Workout Editor:    jumps straight to the free-form WorkoutEditor
//                        timeline (still its own "workout" panel/tab under
//                        the hood — just no bottom-nav entry of its own).

// The floating "+" start button now lives inside whichever tab's rail is
// on screen (see ui/master-detail.js's .md-rail-fab-slot, always the row
// directly above that rail's collapse toggle) instead of floating as an
// independent fixed element — moved here into the right rail's slot every
// time the active tab changes, the exact same relocate-on-the-fly pattern
// MasterDetailRail's own constructor already uses to move a rail to be a
// sibling of .tab-bar (see that constructor's doc comment for why a
// relocated node beats one nested inside something a swipe transform
// touches). Both nav-less live session panels ('session', 'strength')
// have no rail of their own, so there's no slot to move it into for
// either — it just stays put inside whatever rail it was last placed in,
// which is what actually hides it: that rail gets .hidden the same as
// every other one that isn't the active tab (see switchTab()'s existing
// .md-rail[data-rail-for] loop above this function's own call site).
// That's a structural fix for the "+ button floats over the live
// strength form" problem the old code only half-solved (it special-cased
// 'session' but never 'strength' — see this function's call site).
function _placeFabInRail(name) {
  const slot = document.querySelector(`.md-rail[data-rail-for="${name}"] .md-rail-fab-slot`);
  const fab = $('fab-start-btn');
  if (slot && fab && fab.parentElement !== slot) slot.appendChild(fab);
}

function _toggleFabMenu() {
  const menu = $('fab-menu');
  if (!menu) return;
  const opening = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !opening);
  $('fab-start-btn')?.classList.toggle('menu-open', opening);
  $('fab-start-btn')?.setAttribute('aria-expanded', String(opening));
}

function _closeFabMenu() {
  $('fab-menu')?.classList.add('hidden');
  $('fab-start-btn')?.classList.remove('menu-open');
  $('fab-start-btn')?.setAttribute('aria-expanded', 'false');
  // Whatever Overview's needs-tap-through lit up in here (see below) is
  // moot once the menu itself is gone — closing it any other way (Escape,
  // outside tap, actually picking an item) should clear the highlight the
  // same as tapping the highlighted button would.
  _clearFabHighlights();
  _clearFabHighlights = () => {};
}

// ─── Overview "needs" tap-through ───────────────────────────────────────────
// An empty Overview card (metrics/overview-cards.js's OVERVIEW_NEEDS) is
// tappable (views/overview.js's onNeedsCardTap) — this routes the tap to
// wherever that card's "Requires" line actually lives and lights it up
// there with .field-highlight (style.css), so "needs a weigh-in" becomes an
// actual place to go instead of a dead end. OVERVIEW_SESSION_CARDS (session-
// fed cards — This Week, Past 12 Months, Weekly Volume, Power Zones, Heart
// Rate Zones, Personal Bests, Recent Sessions) have no single field to
// point at, so those just pop the FAB menu open with its two
// session-starting entries lit up instead (see _highlightFabSessionButtons()
// below).
//
// _clearFieldHighlights/_clearFabHighlights each undo whatever the
// previous call lit up — kept as two separate slots (rather than one)
// because they clear on different triggers: a field/button on its own
// input/click, the FAB pair on the menu closing (_closeFabMenu() above) —
// so one shouldn't wipe the other out from under it.
let _clearFieldHighlights = () => {};
let _clearFabHighlights = () => {};

async function _onOverviewNeedsTap(id) {
  _clearFieldHighlights();
  _clearFieldHighlights = () => {};

  if (OVERVIEW_SESSION_CARDS.includes(id)) { _highlightFabSessionButtons(); return; }
  _closeFabMenu(); // in case it was left open from a previous session-card tap

  switch (id) {
    case 'pwr':
      switchTab('settings');
      _highlightFields([profile.riderWeight ? null : 'pref-weight', profile.ftp ? null : 'pref-ftp'].filter(Boolean));
      break;
    case 'vo2max': {
      switchTab('settings');
      // The VO2 Max test itself needs FTP set and weight/age/sex on file
      // first (its own info tooltip in index.html spells this out) — send
      // the rider to whichever of those is still missing before the "Start"
      // button, since tapping Start without them just won't get anywhere.
      const missing = [
        profile.riderWeight ? null : 'pref-weight',
        profile.age         ? null : 'pref-age',
        profile.sex         ? null : 'pref-sex',
        profile.ftp         ? null : 'pref-ftp',
      ].filter(Boolean);
      _highlightFields(missing.length ? missing : ['start-vo2max-test']);
      break;
    }
    case 'body':
      // The only way to add a weigh-in is a scale sync (ui/weigh-in-
      // manager.js only reviews/edits ones that already exist) — expand the
      // body-composition disclosure so Sync is actually on screen to light up.
      switchTab('settings');
      _toggleBodyCompPanel(true);
      _highlightFields(['sync-scale-btn']);
      break;
    case 'nutrition': {
      switchTab('diet');
      // switchTab() above already kicked off its own dietPage.load() (fire-
      // and-forget, same as every other tab switch) — awaiting one more
      // ourselves just lets us line up behind it, so we highlight the
      // search box on the DOM that's actually going to stick around
      // instead of one about to be replaced out from under us the moment
      // that reload's own re-render lands.
      await dietPage?.load();
      const input = dietPage?.focusLogFood();
      if (input) {
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        _clearFieldHighlights = _highlightElement(input);
      }
      break;
    }
    default:
      break;
  }
}

/** Adds the pulsing .field-highlight treatment (style.css) to one
 *  input/select/button and wires it to clear itself the moment the
 *  Overview card it's for would actually update: an input/select clears on
 *  the first value it holds, a button clears on its own first click
 *  (Sync/Start … — there's no value to type, so the click itself is the
 *  signal an intake test/sync flow was opened). Returns a cleanup fn that
 *  undoes both, independent of any other element's — _highlightFields()
 *  below composes several of these into one _clearFieldHighlights. */
function _highlightElement(el) {
  el.classList.add('field-highlight');
  const isButton = el.tagName === 'BUTTON';
  const evt = isButton ? 'click' : (el.tagName === 'SELECT' ? 'change' : 'input');
  const cleanup = () => { el.classList.remove('field-highlight'); el.removeEventListener(evt, handler); };
  const handler = () => {
    if (!isButton && !el.value?.trim()) return; // still empty — a stray keystroke then delete shouldn't clear it
    cleanup();
  };
  el.addEventListener(evt, handler);
  return cleanup;
}

/** _highlightElement() for one or more Settings field/button ids, selecting
 *  whichever md-rail category each lives in first (see settingsRail, and
 *  ui/master-detail.js) and scrolling the first into view. */
function _highlightFields(ids) {
  const cleanups = [];
  ids.forEach((id, i) => {
    const el = $(id);
    if (!el) return;
    const cat = el.closest('.md-cat[data-cat]');
    if (cat) settingsRail?.select(cat.dataset.cat);
    if (i === 0) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    cleanups.push(_highlightElement(el));
  });
  _clearFieldHighlights = () => cleanups.forEach(fn => fn());
}

/** The "open in Settings" button inside a detail sheet (the weigh-in editor, the Cardio Zone
 *  Reference): closes the sheet, goes to the Settings tab and lights up the field(s) the sheet was
 *  about. _highlightFields() picks the right rail category and scrolls, so this only has to get
 *  Settings on screen first — `before` runs once it is (e.g. to expand a collapsed panel the
 *  target sits in), and the highlight waits a frame so the scroll measures the final layout. */
function _openSettingsAt(ids, { before } = {}) {
  detailSheet.close();
  switchTab('settings');
  before?.();
  requestAnimationFrame(() => _highlightFields(ids));
}

/** Session-fed Overview card tapped: pop the FAB menu open (if it isn't
 *  already) and light up its two session-starting entries — Cardio Session
 *  and Strength Session, the two that actually begin a recorded session;
 *  Repeat Last and Workout Editor aren't what "Requires a session" is
 *  pointing at. Cleared by _closeFabMenu() however the menu ends up
 *  closing, not by anything in here. */
function _highlightFabSessionButtons() {
  if ($('fab-menu')?.classList.contains('hidden')) _toggleFabMenu();
  const ids = ['fab-menu-cardio', 'fab-menu-strength'];
  ids.forEach(id => $(id)?.classList.add('field-highlight'));
  _clearFabHighlights = () => ids.forEach(id => $(id)?.classList.remove('field-highlight'));
}

// ─── Trainer menu ─────────────────────────────────────────────────────────────
// Same pillbox-menu pattern as the FAB above, anchored to the session
// control bar's 🔌 button instead — see the trainer-menu-* markup in
// index.html for why this is a menu rather than a single connect button.

function _toggleTrainerMenu() {
  const menu = $('trainer-menu');
  if (!menu) return;
  const opening = menu.classList.contains('hidden');
  if (opening) _positionTrainerMenu();
  menu.classList.toggle('hidden', !opening);
  $('trainer-menu-btn')?.classList.toggle('menu-open', opening);
  $('trainer-menu-btn')?.setAttribute('aria-expanded', String(opening));
}

/**
 * Left-aligns the trainer menu with its settings button, clamped so it
 * never runs off either edge of the screen. Computed fresh each time the
 * menu opens rather than anchored via CSS, because the button's own
 * x-position isn't stable — see .trainer-menu's docs in style.css for why
 * (Start being the bar's flex:1 item and getting hidden mid-session
 * shifts this button from ~85% across the bar to almost the left edge).
 * `menuWidth` mirrors the CSS `width: min(320px, calc(100vw - 24px))` on
 * .trainer-menu — keep the two in sync if either changes.
 */
function _positionTrainerMenu() {
  const menu = $('trainer-menu');
  const btn  = $('trainer-menu-btn');
  if (!menu || !btn) return;
  const margin    = 12;
  const menuWidth = Math.min(320, window.innerWidth - margin * 2);
  const maxLeft   = window.innerWidth - margin - menuWidth;
  const left      = Math.max(margin, Math.min(btn.getBoundingClientRect().left, maxLeft));
  menu.style.left = `${left}px`;
}

function _closeTrainerMenu() {
  $('trainer-menu')?.classList.add('hidden');
  $('trainer-menu-btn')?.classList.remove('menu-open');
  $('trainer-menu-btn')?.setAttribute('aria-expanded', 'false');
}

/**
 * Pushes current BLE state into whichever setup UI is about to open, so it
 * shows real connected/disconnected dots immediately (covers devices paired
 * earlier or auto-reconnected on load) instead of defaulting to red dots.
 */
function _syncDeviceStatusFromState() {
  for (const [kind, status] of Object.entries(_deviceStatusesNow())) _setDeviceStatus(kind, status);
}

/** Every device kind's status right now, read from the live BLE state (not from any UI's copy of it). */
function _deviceStatusesNow() {
  const hasKind = kind => [...auxSensors.values()].some(s => s.kind === kind);
  return {
    controller: trainer ? 'connected' : 'disconnected',
    hrm:        _hrmStatusNow(),
    smo2:       hasKind('smo2')     ? 'connected' : 'disconnected',
    coreTemp:   hasKind('coreTemp') ? 'connected' : 'disconnected',
  };
}

/** What a tap on a device-row button does: the same handler the setup flow's tile for that device runs. */
function _connectDeviceKind(kind) {
  if      (kind === 'controller') connectController();
  else if (kind === 'hrm')        connectHrMonitor();
  else if (kind === 'smo2')       connectSmo2Monitor();
  else if (kind === 'coreTemp')   connectCoreTempSensor();
}

function openQuickStart() {
  _syncDeviceStatusFromState();
  quickStartFlow?.open();
}

/** "Strength Session" FAB menu item, and _renderStrengthIdle()'s own "Start
 *  Strength Session" button — both open strengthSetupFlow (Focus picker,
 *  session name, HRM connect), the strength counterpart to Cardio
 *  Session's quickStartFlow (see that file's own doc comment). Doesn't
 *  switch tabs itself — same as openQuickStart() — so closing the setup
 *  without starting leaves you wherever you were; startStrengthSession()
 *  switches to the Strength tab once a session actually starts, mirroring
 *  how startSession() does it for cardio. */
function openStrengthSession() {
  _syncDeviceStatusFromState();
  strengthSetupFlow?.open();
}

/** "Workout Editor" FAB menu item — jumps straight to the free-form
 * WorkoutEditor timeline (switchTab('workout') already calls its onShow()
 * hook — see switchTab()). Explicitly resets the editor back to the
 * 'workout' intent first — without this, opening a preset copy via
 * openPresetInAdvancedBuilder() below and then leaving without saving
 * would leave the editor's Save button silently wired to onSavePreset
 * (and its toolbar still reading "Preset name" / "Save as Preset") the
 * next time it's reached through this plain FAB entry instead. See
 * workout-editor.js's load()/`intent` doc comment for the full picture. */
function openWorkoutEditor() {
  workoutEditor?.setIntent('workout');
  switchTab('workout');
}

/** Opens a *copy* of the given cardio-timelines.js preset in the
 *  WorkoutEditor under the 'preset' intent (see workout-editor.js's
 *  load()/`intent` doc comment), so its one Save button persists the edit
 *  as a new named custom preset via onSavePreset above instead of loading
 *  it into the session like the plain "Workout Editor" FAB entry does.
 *  Two callers reach this the same way: Quick Start's Mapped picker
 *  ("Open in Advanced Builder…" — quickStartFlow's onEditPreset, wired
 *  below), and the builder's own "Load a preset timeline" select once
 *  already inside the editor (workoutEditor's onLoadPreset above) — the
 *  latter is what lets a rider switch which preset they're building from
 *  without leaving the builder for Quick Start's card grid first.
 *  workoutEditorPresetContext
 *  records which preset this copy started from — read once by
 *  onSavePreset for the new preset's tagline/basePresetId and cleared
 *  immediately after (see that declaration's own comment) — and is set
 *  here, right before load(), so it's never stale by the time a Save
 *  can actually reach it. buildTimelineWorkout() gives every copy its
 *  own fresh step ids, so tweaking this copy never touches the original
 *  preset or any session already built from it. */
function openPresetInAdvancedBuilder(preset) {
  if (!preset) return;
  workoutEditorPresetContext = { basePresetId: preset.id, basePresetLabel: preset.label };
  const model = buildTimelineWorkout(preset);
  workoutEditor?.load(model, { intent: 'preset' });
  switchTab('workout');
}

/** "Repeat Last" FAB menu item — rebuilds and starts the last Cardio
 * Session settings with no dialog. Falls back to opening Cardio Session
 * itself the first time, when nothing has been saved yet. */
async function repeatLastWorkout() {
  const last = await db.getPref('lastQuickStart', null);
  if (!last?.name) {
    setStatus('No recent workout yet — set one up with Cardio Session');
    openQuickStart();
    return;
  }
  const model = buildQuickStartWorkout(last);
  _setLoadedWorkout(model);
  const nameInput = $('workout-name-input');
  if (nameInput) nameInput.value = model.name;
  startSession();
}

// ─── Screen lock ──────────────────────────────────────────────────────────────
// No overlay at all — locking doesn't cover the screen in any form. Armed
// by the lap-btn-adjacent 🔒 button (see index.html), it turns that same
// button into the ONLY thing that still responds while locked: every other
// transport button hides and #lock-btn widens to fill the bar (pure CSS,
// see #session-control-bar.locked in style.css), and a document-wide
// capture-phase listener (_blockWhileLocked, below) swallows any tap
// anywhere else and surfaces a reminder tooltip instead of whatever that
// tap would normally have done. Getting out again takes a deliberate
// press-and-hold on #lock-btn itself rather than a tap, since a tap is
// exactly the kind of accidental touch locking is meant to absorb. Shared
// by every session type that shows the transport bar (cardio and strength
// both — neither has its own lock code, they just get this one for free).

const LOCK_HOLD_MS = 1200; // kept in sync with the .lock-btn-fill transition in style.css
let _unlockHoldTimer  = null;
let _suppressLockClick = false; // see the comment where this is set, below

function lockScreen() {
  if (screenLocked) return;
  screenLocked = true;
  $('session-control-bar')?.classList.add('locked');
  $('lock-btn')?.setAttribute('aria-label', 'Hold to unlock screen');
  keyboard?.disable(); // no shortcut should reach the session while it's locked
}

function unlockScreen() {
  if (!screenLocked) return;
  screenLocked = false;
  $('session-control-bar')?.classList.remove('locked');
  $('lock-btn')?.setAttribute('aria-label', 'Lock screen');
  keyboard?.enable();
}

function _armUnlockHold() {
  // Only the "hold to unlock" gesture uses this timer — a press on the
  // small, unlocked lock-btn is a plain tap-to-lock and should just fall
  // through to the click handler, not run the fill animation.
  if (!screenLocked) return;
  $('lock-btn-fill')?.classList.add('filling');
  _unlockHoldTimer = setTimeout(() => {
    _unlockHoldTimer = null;
    _cancelUnlockHold();
    // unlockScreen() below is about to make #lock-btn a normal (small,
    // click-to-lock) button again mid-gesture — the pointerup that ends
    // this same press/release is still going to fire a 'click' on it
    // afterward (a long press with no movement is still a click), and
    // without this flag that click would immediately call lockScreen()
    // again right after this unlocks it. The click handler checks and
    // clears this itself; see bindControls().
    _suppressLockClick = true;
    unlockScreen();
  }, LOCK_HOLD_MS);
}

function _cancelUnlockHold() {
  if (_unlockHoldTimer) { clearTimeout(_unlockHoldTimer); _unlockHoldTimer = null; }
  const fill = $('lock-btn-fill');
  if (!fill) return;
  // Snap back to empty without animating the retreat — only the fill-up
  // toward a completed hold should ease, not an abandoned one.
  fill.classList.remove('filling');
  void fill.offsetWidth; // force reflow so the next 'filling' add re-triggers the transition
}

// The actual "nothing but the unlock button responds while locked" rule —
// #session-control-bar.locked (style.css) only handles what #lock-btn
// itself looks like; every OTHER element on the page (chart swipe/drag,
// any other button, anything) is still live in the DOM and would still
// respond to a tap on it if this didn't intervene. Runs on every input
// event type that anything in this app acts on (see the chart-carousel
// drag handlers, which use mousedown/touchstart rather than click) so
// there's no gap a gesture could sneak through; capture phase + a fixed
// listener per event type is what lets a single stopPropagation() here
// stop it from reaching any of those, no matter where in the DOM it lives.
function _blockWhileLocked(e) {
  if (!screenLocked) return;
  const lockBtn = $('lock-btn');
  if (lockBtn && lockBtn.contains(e.target)) return; // the unlock control itself is exempt
  e.preventDefault();
  e.stopPropagation();
  infoTooltips.flash(e.target, 'Locked — hold the button below to unlock');
}
for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click']) {
  document.addEventListener(type, _blockWhileLocked, { capture: true, passive: false });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=Math.floor(sec%60);
  if (h>0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function _modeLabel(m)  { return {erg:'ERG',resistance:'Resistance',slope:'Slope',virtualGear:'Gear'}[m]??m; }
function _modeUnit(m)   { return {erg:'W',resistance:'%',slope:'%',virtualGear:''}[m]??''; }
function _nudgeDelta(m) { return {erg:5,resistance:2,slope:0.5,virtualGear:1}[m]??5; }
function _typeLabel(t)  {
  return {warmup:'Warm-up',cooldown:'Cooldown',steady:'Steady',ramp:'Ramp',
          rest:'Rest',freeRide:'Free Ride',interval:'Interval'}[t]??t;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);