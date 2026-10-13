// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * charts/chart-engine.js
 *
 * Canvas-based chart engine for rendering workout metrics over time.
 * Works in two modes:
 *   - LIVE: subscribes to a session's onSample stream and auto-scrolls
 *   - HISTORY: renders a completed session's sample array statically
 *
 * Renders up to 4 metric series simultaneously (power, HR, cadence, speed).
 * Supports pan/zoom on the time axis. Lap markers shown as vertical lines.
 *
 * Usage:
 *   import { ChartEngine, CHART_COLORS } from './charts/chart-engine.js';
 *   const chart = new ChartEngine(canvasEl, { mode: 'live' });
 *   chart.addSeries('power',   { color: CHART_COLORS.power, label: 'Power (W)',   yMax: 600 });
 *   chart.addSeries('heartRate',{ color: CHART_COLORS.heartRate, label: 'HR (bpm)',   yMax: 220 });
 *   chart.addSeries('cadence', { color: CHART_COLORS.cadence, label: 'Cadence',     yMax: 140 });
 *
 *   // Live mode: push each new sample
 *   chart.push(sample);
 *
 *   // History mode: set full buffer
 *   chart.setData(samples, lapMarks);
 */

import { themeColor, withAlpha } from './chart-theme.js';

// Time-window zoom bounds (seconds) — shared by every zoomAt() caller,
// desktop wheel and mobile pinch alike. 15s is about as tight as a zoom
// still reads as a trend rather than individual points; 6h comfortably
// covers a long endurance session shown in full.
const MIN_WINDOW_SEC = 15;
const MAX_WINDOW_SEC = 6 * 3600;

// Baseline offset (px, below the plot's own bottom edge) that
// _drawTimeAxis() draws its tick labels at. Pulled out as a constant so
// getPlotRect() below can hand a caller the exact same row without
// duplicating the literal — see that method's doc.
const TIME_AXIS_BASELINE_OFFSET = 18;

export const CHART_COLORS = {
  // Metric lines — the same tokens the metric cards and chips use, so a
  // metric is one colour everywhere (see charts/chart-theme.js).
  power:    themeColor('--color-power'),
  power3s:  themeColor('--color-power-avg'),
  heartRate:themeColor('--color-hr'),
  cadence:  themeColor('--color-cadence'),
  speed:    themeColor('--color-speed'),
  smo2:     themeColor('--color-smo2'),
  coreTemp: themeColor('--color-temp'),
  // Canvas chrome.
  bg:       themeColor('--chart-bg'),
  grid:     themeColor('--chart-grid'),
  text:     themeColor('--chart-text'),
  // A series draws in this instead of its own color for any stretch where
  // the device supplying it is disconnected — see _drawSeries()'s forward-
  // fill/run-splitting and _drawCrosshair()'s matching dot/chip color.
  // Distinct from `text` (used for axis labels) so a frozen reading still
  // reads as "this metric, but stale" rather than blending into the UI
  // chrome.
  stale:    themeColor('--chart-stale'),
  lap:      themeColor('--chart-lap'),
  step:     themeColor('--chart-step'),   // subtle tick where a scripted workout step completed
  complete: themeColor('--chart-complete'),   // pronounced marker where the whole workout completed
  // Crosshair line / total-time label, and the tooltip + chip backing.
  crosshair:      themeColor('--chart-crosshair'),
  crosshairSoft:  withAlpha(themeColor('--chart-crosshair'), 0.5),
  tipBg:          withAlpha(themeColor('--chart-tip-bg'), 0.9),
  tipBgSoft:      withAlpha(themeColor('--chart-tip-bg'), 0.82),
};

/**
 * The three strengths every metric readout shares — the left rule and the two ends of the wash —
 * read from the same :root tokens the CSS readouts use (--metric-rule-alpha, --metric-wash-alpha,
 * --metric-wash-alpha-end), so the canvas badge cluster retunes with them. Percent or unit
 * values both parse; anything unreadable falls back to the shipped defaults.
 */
export const READOUT_ALPHA = (() => {
  const read = (token, fallback) => {
    try {
      if (typeof document === 'undefined') return fallback;
      const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return fallback;
      return raw.endsWith('%') ? n / 100 : n;
    } catch { return fallback; }
  };
  return {
    rule:    read('--metric-rule-alpha',     0.70),
    washEnd0: read('--metric-wash-alpha',    0.22),
    washEnd1: read('--metric-wash-alpha-end', 0),
  };
})();

export class ChartEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} opts
   * @param {'live'|'history'} opts.mode
   * @param {number} [opts.windowSec=300]   Visible time window in live mode (seconds)
   * @param {boolean} [opts.singleMetric=false]
   *   When true, the engine is expected to carry exactly one series (used by
   *   ChartCarousel, one instance per swipeable metric page). In this mode
   *   the chart draws real numeric Y-axis labels instead of the small
   *   color-coded corner label, and skips its own drag/wheel handling since
   *   horizontal gestures belong to the parent carousel's swipe-to-switch
   *   interaction instead.
   * @param {boolean} [opts.overview=false]
   *   When true, the engine overlays every one of its series on the same
   *   plot (each scaled to its own yMin/yMax, same as the legacy combined
   *   chart), leaving the Y-axis unlabeled (numeric ticks) since the
   *   overlaid series don't share units — series are told apart by color
   *   alone, and a crosshair surfaces each one's value in a stacked chip
   *   (see _drawCrosshairChip()) rather than a left-axis legend. Used by
   *   ChartCarousel's "All" page. Like singleMetric, this skips the
   *   engine's own drag/wheel handling; an overview page also lives inside
   *   a swipeable carousel.
   * @param {boolean} [opts.showCrosshairChip=true]
   *   When false, the vertical guide line + snapped dot at the crosshair's
   *   sample still draw, but the small canvas-rendered value/time chip
   *   above it (see _drawCrosshairChip()) is skipped — for a caller that's
   *   rendering its own DOM readout instead (see opts.onCrosshairChange)
   *   and doesn't want both showing at once.
   * @param {'floating'|'top-right'} [opts.crosshairChipAnchor='floating']
   *   'floating' (the default, used by every single-metric page) keeps the
   *   chip centered directly above the crosshair's x position, clamped to
   *   the plot edges — see _drawCrosshairChipFloating(). 'top-right' (used
   *   by the overview/"combined" page) instead pins the chip to the
   *   plot's top-right corner regardless of where the crosshair sits —
   *   see _drawCrosshairChipFixed() — echoing the same panel look as the
   *   .chart-badges DOM overlay (Zone/Calories/Distance/Pace) shown during
   *   an active workout, tucked into the corner itself rather than a box
   *   chasing the touch point across several overlaid, differently-scaled
   *   series.
   * @param {Function} [opts.onCrosshairChange]
   *   (readouts: Array<{key,label,color,text}>|null, sec?: number) => void
   *   Fired every time the crosshair moves, is released, or scrolls
   *   outside the visible window — the same per-series readouts the
   *   built-in chip draws from (one entry for a singleMetric engine,
   *   possibly several for an overview engine), or null when there's
   *   nothing to show. Lets a caller drive its own DOM value display —
   *   e.g. ChartCarousel's split-grid cells format this into the same
   *   .metric-value/.metric-label markup the live current/average/peak
   *   readout uses — without needing to read this engine's internals.
   * @param {number} [opts.bgAlpha=1]
   *   Opacity of the canvas's own background fill, 0-1. 1 (the default, and what History uses) paints
   *   the solid --chart-bg; live cardio passes 0 so the glass panel behind the canvas (hero tier,
   *   #chart-container) is what the lines and grid sit on. The crosshair dot's halo stays solid.
   * @param {Function} [opts.getBadgesRect]
   *   () => {left,right,top,bottom}|null — canvas-local (CSS-px) bounding
   *   box of that page's own .chart-badges corner cluster (Zone/Calories/
   *   Distance/Pace), if it has one right now, or null. Queried live on
   *   every floating-chip draw rather than cached, since a page's badges
   *   can appear/disappear after construction (see ChartCarousel's
   *   updateMetricDef()). Only consulted by the 'floating' anchor — see
   *   _drawCrosshairChipFloating() — so the chip can drop below the
   *   badges instead of scrubbing underneath them near the top-right
   *   corner they both occupy. **Nothing passes this today:** the live
   *   chart's badges sit in a fixed bar above the
   *   track (ui/chart-badge-bar.js), so there is no overlay to
   *   dodge; the hook stays for anything that overlays a page again.
   */
  constructor(canvas, {
    mode = 'live', windowSec = 300, singleMetric = false, overview = false,
    showCrosshairChip = true, crosshairChipAnchor = 'floating', onCrosshairChange = null,
    getBadgesRect = null, bgAlpha = 1,
  } = {}) {
    this._canvas       = canvas;
    this._ctx          = canvas.getContext('2d');
    this._mode         = mode;
    this._windowSec    = windowSec;
    this._defaultWindowSec = windowSec; // restored on unfreeze() — see there
    this._singleMetric = singleMetric;
    this._overview     = overview;
    this._showCrosshairChip = showCrosshairChip;
    this._crosshairChipAnchor = crosshairChipAnchor;
    this._onCrosshairChange = onCrosshairChange;
    this._getBadgesRect = getBadgesRect;
    this._bgAlpha = Math.min(1, Math.max(0, Number.isFinite(bgAlpha) ? bgAlpha : 1));

    /** @type {Map<string, SeriesConfig>} */
    this._series    = new Map();
    /** @type {Sample[]} */
    this._samples   = [];
    /** @type {LapMark[]} */
    this._laps      = [];
    /** @type {WorkoutMark[]} Scripted-workout progress markers (step
     *  completions + the final workout-complete marker) — see
     *  setWorkoutMarks(). Separate from _laps: these are automatic
     *  progress markers with no lap-summary math behind them, not
     *  something the rider marks themselves. */
    this._workoutMarks = [];

    this._viewStart = 0;   // seconds offset from session start (scroll position)
    this._frozen    = false; // true while focus-locked — see freeze()/unfreeze()
    this._crosshair = null;  // { index } into _samples, or null — see setCrosshair()
    this._lastGeom  = null;  // plot geometry from the last render — see setCrosshair()
    this._animFrame = null;
    this._cssWidth  = 0;   // canvas size in CSS px (post-dpr-scale drawing space)
    this._cssHeight = 0;

    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(canvas);
    this._resize();

    this._bindInteraction();
  }

  // ─── Series ───────────────────────────────────────────────────────────────

  /**
   * Register a metric to display.
   * @param {string} metricKey   e.g. 'power', 'heartRate'
   * @param {Object} config
   * @param {string} config.color
   * @param {string} config.label
   * @param {number} config.yMax
   * @param {number} [config.yMin=0]
   * @param {Function} [config.transform]  Applied to each raw sample value
   *   before plotting/scaling (e.g. km/h → mph for a units toggle). Stored
   *   sample data is never mutated — this only affects rendering, so
   *   changing it later (via addSeries again) redraws correctly instead of
   *   compounding on already-converted values.
   * @param {string} [config.unit]   Short unit suffix (e.g. 'W', 'bpm')
   *   shown next to the crosshair readout — see setCrosshair() below.
   *   Purely cosmetic; has no effect on scaling.
   * @param {Function} [config.fmt]  Formats a *raw* (untransformed) sample
   *   value for the crosshair readout, mirroring how the same def's `fmt`
   *   already formats the current/average/peak stat readouts elsewhere in
   *   the app (see app.js's METRIC_DEFS). Falls back to the axis-tick
   *   formatter when omitted, e.g. on history-mode pages that don't pass one.
   */
  addSeries(metricKey, { color, label, yMax, yMin = 0, transform, unit, fmt }) {
    this._series.set(metricKey, { color, label, yMax, yMin, transform, unit, fmt });
  }

  removeSeries(metricKey) {
    this._series.delete(metricKey);
  }

  /**
   * Replace the full set of series in one call — any series not present in
   * `defs` is removed, the rest are added/updated. Used by ChartCarousel's
   * combined "All" overview page, whose series list changes whenever the
   * set of available metrics does (e.g. a sensor pairing/unpairing).
   * @param {Array<{key,color,label,yMax,yMin,transform}>} defs
   */
  setSeries(defs) {
    const nextKeys = new Set(defs.map(d => d.key));
    for (const key of [...this._series.keys()]) {
      if (!nextKeys.has(key)) this.removeSeries(key);
    }
    for (const def of defs) {
      this.addSeries(def.key, {
        color: def.color, label: def.label, yMax: def.yMax, yMin: def.yMin,
        transform: def.transform, unit: def.unit, fmt: def.fmt,
      });
    }
  }

  // ─── Data ─────────────────────────────────────────────────────────────────

  /**
   * Push one sample in live mode.
   * @param {Sample} sample
   */
  push(sample) {
    this._samples.push(sample);
    // Auto-scroll is suspended while frozen (see freeze()) — the sample
    // still lands in the buffer so nothing is lost, it just doesn't drag
    // the view forward out from under someone mid-crosshair on a locked page.
    if (this._mode === 'live' && !this._frozen) {
      // Auto-scroll: keep the view window at the trailing edge
      const elapsed = sample.elapsedTime ?? (this._samples.length - 1);
      if (elapsed >= this._windowSec) {
        this._viewStart = elapsed - this._windowSec;
      }
    }
    this._scheduleRender();
  }

  /**
   * Set full dataset (history mode or on session load).
   * @param {Sample[]} samples
   * @param {LapMark[]} [laps=[]]
   */
  setData(samples, laps = []) {
    this._samples   = samples;
    this._laps      = laps;
    this._viewStart = 0;
    this._scheduleRender();
  }

  /** Add/update lap markers (called in live mode after markLap). */
  setLaps(laps) {
    this._laps = laps;
    this._scheduleRender();
  }

  /**
   * Add/update scripted-workout progress markers — called in live mode as
   * a ScriptedSession advances (see app.js's _onScriptedStep()/
   * _onScriptedComplete()). Replaces the whole set each time, same as
   * setLaps() above.
   * @param {WorkoutMark[]} marks
   */
  setWorkoutMarks(marks) {
    this._workoutMarks = marks;
    this._scheduleRender();
  }

  /** Snap the view to the most recent data (live button). */
  snapToLive() {
    if (this._samples.length === 0) return;
    const last = this._samples[this._samples.length - 1];
    const elapsed = last.elapsedTime ?? this._samples.length;
    this._viewStart = Math.max(0, elapsed - this._windowSec);
    this._scheduleRender();
  }

  /** Change the visible time window. */
  setWindow(sec) {
    this._windowSec = sec;
    this.snapToLive();
  }

  // ─── Pan / zoom (focus-lock exploration) ───────────────────────────────
  //
  // Like the crosshair above, these are driven from outside — ChartCarousel
  // calls them on the currently focus-locked page's engine in response to
  // its own pointer/wheel handling (middle-click-drag and wheel on desktop,
  // two-finger-drag and pinch on mobile — see _bindSwipeGestures()). This
  // engine's own _bindInteraction() below calls the same methods for its
  // (currently unused) standalone drag/wheel/touch handling.

  /** Shift the visible window by `deltaSec` (positive = later in time),
   *  clamped so it never runs past the start or end of the data. */
  panBy(deltaSec) {
    const total    = this._totalDuration();
    const maxStart = Math.max(0, total - this._windowSec);
    this._viewStart = Math.max(0, Math.min(maxStart, this._viewStart + deltaSec));
    this._scheduleRender();
  }

  /** Same as panBy(), but takes a horizontal drag distance in CSS px
   *  (positive = dragged toward the left = pan later in time) and
   *  converts it through the current window's pixels-per-second, so
   *  callers don't need to know this engine's plot geometry. */
  panByPixels(pxDelta) {
    const plotW = this._lastGeom?.plotW ?? this._cssWidth;
    if (plotW <= 0) return;
    const pxPerSec = plotW / this._windowSec;
    if (pxPerSec <= 0) return;
    this.panBy(pxDelta / pxPerSec);
  }

  /**
   * Zoom the visible window by `factor` (>1 widens it/zooms out, <1
   * narrows it/zooms in), clamped to [MIN_WINDOW_SEC, MAX_WINDOW_SEC].
   * When `canvasX` (CSS px, canvas-space) is given and geometry is
   * available, the data-second currently under it stays under it after
   * the resize — the same "zoom toward the pointer" behavior as a map.
   * Otherwise zooms around the window's own center.
   */
  zoomAt(factor, canvasX = null) {
    const oldWindow = this._windowSec;
    const newWindow = Math.max(MIN_WINDOW_SEC, Math.min(MAX_WINDOW_SEC, oldWindow * factor));
    if (newWindow === oldWindow) return;

    let anchorFrac = 0.5;
    let anchorSec  = this._viewStart + oldWindow / 2;
    if (canvasX !== null && this._lastGeom) {
      const { PAD, plotW, visStart, visEnd } = this._lastGeom;
      if (plotW > 0) {
        anchorFrac = Math.max(0, Math.min(1, (canvasX - PAD.left) / plotW));
        anchorSec  = visStart + anchorFrac * (visEnd - visStart);
      }
    }

    const total    = this._totalDuration();
    const maxStart = Math.max(0, total - newWindow);
    this._windowSec = newWindow;
    this._viewStart = Math.max(0, Math.min(maxStart, anchorSec - anchorFrac * newWindow));
    this._scheduleRender();
  }

  /**
   * Suspend live auto-scroll (see push()) without losing incoming samples —
   * used by ChartCarousel while a page is focus-locked, so the window
   * someone's reading a crosshair value off of doesn't keep sliding out
   * from under them mid-workout. No-op in history mode, which never
   * auto-scrolls in the first place.
   */
  freeze() {
    this._frozen = true;
  }

  /**
   * Resume live auto-scroll and snap straight back to the trailing edge.
   * Also resets any pan/zoom picked up while focus-locked (see panBy()/
   * zoomAt()) back to the window size this engine was created with, so
   * every fresh engage starts from the normal live view rather than
   * wherever the last exploration left off. History-mode engines don't
   * auto-scroll in the first place, so their pan/zoom state is left alone
   * — there's nothing "live" to resume, and the point of unlocking there
   * is just to stop scrubbing, not to discard the zoomed-in view.
   */
  unfreeze() {
    this._frozen = false;
    if (this._mode === 'live') {
      this._windowSec = this._defaultWindowSec;
      this.snapToLive();
    }
  }

  // ─── Crosshair (focus-lock exploration) ────────────────────────────────
  //
  // Driven entirely by ChartCarousel: it owns the long-press gesture and
  // the canvas's bounding rect, this engine just turns a canvas-space X
  // into the nearest sample and draws the result. Kept in data-space
  // (a sample index) rather than pixel-space, so it stays correctly
  // aligned across resizes and further renders without the carousel
  // needing to re-issue it.

  /**
   * Move the crosshair to whichever sample is nearest the given canvas-
   * space X (CSS px — the same space as the canvas element's own
   * getBoundingClientRect(), not device pixels). No-op before the first
   * render has established plot geometry, or with fewer than 2 samples.
   */
  setCrosshair(canvasX) {
    const sec = this.canvasXToSec(canvasX);
    if (sec === null) return;
    this.setCrosshairAtSec(sec);
  }

  /**
   * Convert a canvas-space X (CSS px, same space as setCrosshair() above)
   * into the data-space elapsed-time second it lands on in this engine's
   * *current* view, clamped to the visible window. Returns null before the
   * first render has established plot geometry — same guard setCrosshair()
   * used to apply inline before it was split out of this method.
   *
   * Exists so a caller driving several independent ChartEngine instances
   * from one touch/drag (e.g. ChartCarousel's split grid — see
   * _beginSplitScrub()) can resolve the dragged chart's own canvasX
   * into an absolute time once, then hand that same time to every other
   * engine via setCrosshairAtSec() below — each engine can have a
   * differently-sized left-axis gutter (see _measureLeftPad()), so the
   * same canvasX would land on a different instant on each one; the
   * resolved second is what's actually shared, not the pixel position.
   */
  canvasXToSec(canvasX) {
    if (!this._lastGeom) return null;
    const { PAD, plotW, visStart, visEnd } = this._lastGeom;
    const frac = plotW > 0 ? (canvasX - PAD.left) / plotW : 0;
    return visStart + Math.max(0, Math.min(1, frac)) * (visEnd - visStart);
  }

  /**
   * Move the crosshair to whichever sample is nearest a given data-space
   * elapsed-time second — the same placement setCrosshair() computes from
   * a canvasX, but for a caller that already has an absolute time instead
   * (see canvasXToSec() above). Unlike setCrosshair(), this doesn't need
   * plot geometry, so it works even on an engine that hasn't rendered
   * this specific frame's layout — only needs data. No-op with fewer than
   * 2 samples.
   */
  setCrosshairAtSec(sec) {
    if (this._samples.length < 2) return;
    const index = this._nearestSampleIndex(sec);
    if (this._crosshair?.index === index) return;
    this._crosshair = { index };
    this._scheduleRender();
  }

  /**
   * Read-only snapshot of this engine's current plot geometry, in canvas-
   * local CSS px (the same coordinate space canvasX arguments above use)
   * — { left, width, axisY }: the plot area's left edge and width (what
   * canvasXToSec() maps a canvasX through), and axisY, the exact baseline
   * _drawTimeAxis() draws its tick labels on. Null before the first
   * render. Exists so a caller positioning its own DOM overlay against
   * this engine's actual rendered layout — rather than guessing at PAD
   * constants that could drift out of sync with a future tweak here —
   * can just read it: see ChartCarousel's shared split-grid time marker,
   * which sits right on top of the touched chart's own axis row via this.
   */
  getPlotRect() {
    if (!this._lastGeom) return null;
    const { PAD, plotW, plotH } = this._lastGeom;
    return { left: PAD.left, width: plotW, axisY: PAD.top + plotH + TIME_AXIS_BASELINE_OFFSET };
  }

  /**
   * The crosshair's current x position, in this engine's own canvas-local
   * CSS px — the exact x _drawCrosshair() draws its vertical guide line
   * at. Null when there's no crosshair set, its sample has scrolled
   * outside the visible window, or before the first render. Lets a
   * caller line its own DOM overlay up with the guide line this engine
   * is already drawing, instead of re-deriving the same canvasX-to-time
   * mapping a second time and risking the two drifting apart — see
   * ChartCarousel's shared split-grid time marker.
   */
  crosshairCanvasX() {
    if (!this._crosshair || !this._lastGeom) return null;
    const s = this._samples[this._crosshair.index];
    if (!s) return null;
    const { PAD, plotW, visStart, visEnd } = this._lastGeom;
    const sec = s.elapsedTime ?? this._crosshair.index;
    if (sec < visStart || sec > visEnd) return null;
    const visRange = (visEnd - visStart) || 1;
    return PAD.left + ((sec - visStart) / visRange) * plotW;
  }

  /** Clear the crosshair — e.g. when a page's focus-lock disengages. */
  hideCrosshair() {
    if (!this._crosshair) return;
    this._crosshair = null;
    this._onCrosshairChange?.(null);
    this._scheduleRender();
  }

  /** Binary search for the sample whose elapsedTime is closest to `sec`
   *  (samples are always time-ordered — see push()/setData()). */
  _nearestSampleIndex(sec) {
    const s = this._samples;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const t = s[mid].elapsedTime ?? mid;
      if (t < sec) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) {
      const tLo   = s[lo].elapsedTime ?? lo;
      const tPrev = s[lo - 1].elapsedTime ?? (lo - 1);
      if (Math.abs(tPrev - sec) < Math.abs(tLo - sec)) return lo - 1;
    }
    return lo;
  }

  /**
   * Resolves what a series should show at a given sample index: its own
   * value there when the device supplying it is live, or the most recent
   * earlier value when it isn't (see recording/session.js#clearData, which
   * is what makes a disconnected metric's samples null) — paired with
   * whether the resolved value is live right now or being held over from
   * before the gap started. Mirrors _drawSeries()'s own forward-fill, but
   * for a single instant rather than a whole run, so the crosshair's dot
   * and chip can match whatever the line itself is showing there instead
   * of just disappearing the moment the sample it's snapped to goes null.
   * Returns null if this series has never had a value at or before this
   * index.
   *
   * A sample.backfilled reading is treated the same as a null one here —
   * see _drawSeries()'s matching masking and the Sample.backfilled doc in
   * core/sample.js — so scrubbing across a background-throttled gap snaps
   * to the same held-over pre-gap value the gray line itself is showing,
   * instead of surfacing the copied-forward post-gap reading early.
   * @param {string} key
   * @param {number} uptoIndex
   * @returns {{val: number, live: boolean}|null}
   */
  _lastKnownAt(key, uptoIndex) {
    const at = this._samples[uptoIndex];
    const raw = at?.[key];
    if (raw !== null && raw !== undefined && !at?.backfilled) return { val: raw, live: true };
    for (let i = uptoIndex - 1; i >= 0; i--) {
      const s = this._samples[i];
      const v = s[key];
      if (v !== null && v !== undefined && !s.backfilled) return { val: v, live: false };
    }
    return null;
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  /** Re-render with the current data/config — e.g. after addSeries() changes
   *  a series' transform/label/axis externally (units toggle) and the chart
   *  isn't about to receive a new sample on its own to trigger a redraw. */
  refresh() {
    this._scheduleRender();
  }

  _scheduleRender() {
    if (this._animFrame) return;
    this._animFrame = requestAnimationFrame(() => {
      this._animFrame = null;
      this._render();
    });
  }

  /** Width (px) of the left-edge gutter reserved for real Y-axis tick labels. It is the same for every
   *  metric, page and size: sized for the worst case a label can take (AXIS_LABEL_WORST_CASE: four
   *  digits, the widest a tick gets) rather than for the labels actually being drawn, so the plot's left
   *  edge never moves as the All page steps from one metric to the next ("700" and "42.0" used to take
   *  different widths and the plot jumped), nor between the live chart and History's, nor with the
   *  History chart's session-scaled ranges. Should a label ever be wider still (a five-digit tick), the
   *  gutter grows to fit it rather than clip it. An overview/multi-series chart draws no tick labels at
   *  all (see _drawGrid()), so it gets only a hairline margin matching PAD.right.
   *  @param {{yMin:number,yMax:number}|null} soleSeries */
  _measureLeftPad(soleSeries) {
    if (!soleSeries) return 12;
    const ctx = this._ctx;
    ctx.font = '10px system-ui';
    let maxTickW = 0;
    for (const text of AXIS_LABEL_WORST_CASE) maxTickW = Math.max(maxTickW, ctx.measureText(text).width);
    for (let i = 0; i <= 4; i++) {
      const val = soleSeries.yMax - (i / 4) * (soleSeries.yMax - soleSeries.yMin);
      maxTickW = Math.max(maxTickW, ctx.measureText(_fmtAxisVal(val)).width);
    }
    return Math.ceil(maxTickW) + 14; // text width + gap before the gridline
  }

  /** Public read of the left-axis gutter width this engine is currently
   *  drawing (or would draw for its current series/scale), without
   *  needing to wait on a render pass. Used by ChartCarousel to keep the
   *  overview page's split-view toggle button clear of a split-cell
   *  mini chart's tick labels — see _syncSplitToggleOffset(). */
  measureLeftPad() {
    const soleSeries = (this._singleMetric && this._series.size === 1)
      ? [...this._series.values()][0]
      : null;
    return this._measureLeftPad(soleSeries);
  }

  _render() {
    const { _ctx: ctx } = this;
    const W = this._cssWidth;
    const H = this._cssHeight;

    // Grid — in single-metric mode, label the gridlines with real values
    // for the one series this chart carries. Overview mode draws plain
    // unlabeled gridlines instead — its overlaid series don't share a
    // scale, so there's nothing meaningful to tick, and the left-axis
    // legend that used to name each series has been removed; a crosshair
    // there now surfaces per-series values in the chip drawn in
    // _drawCrosshair() instead (see below).
    const soleSeries = (this._singleMetric && this._series.size === 1)
      ? [...this._series.values()][0]
      : null;

    const PAD = { top: 12, right: 12, bottom: 28, left: this._measureLeftPad(soleSeries) };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top  - PAD.bottom;

    if (plotW <= 0 || plotH <= 0) return;

    ctx.clearRect(0, 0, W, H);

    // Background (skipped entirely when the page behind the canvas is meant to show through)
    if (this._bgAlpha > 0) {
      ctx.fillStyle = this._bgAlpha >= 1 ? CHART_COLORS.bg : withAlpha(CHART_COLORS.bg, this._bgAlpha);
      ctx.fillRect(0, 0, W, H);
    }

    if (this._samples.length < 2 || this._series.size === 0) {
      ctx.fillStyle = CHART_COLORS.text;
      ctx.font      = '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('No data yet', W / 2, H / 2);
      return;
    }

    const totalSec  = this._totalDuration();
    const viewStart = this._viewStart;
    const viewEnd   = viewStart + this._windowSec;

    // Clamp view
    const visStart  = Math.max(0, viewStart);
    const visEnd    = Math.min(totalSec, viewEnd);
    const visRange  = visEnd - visStart || 1;

    const toX = (sec) =>
      PAD.left + ((sec - visStart) / visRange) * plotW;

    // Stashed for setCrosshair(), which is called from outside a render
    // pass (by ChartCarousel, in response to pointer events) and needs the
    // same canvas<->data mapping this render just computed.
    this._lastGeom = { PAD, plotW, plotH, visStart, visEnd, totalSec };

    // Resolved once per render, used by the crosshair overlay drawn at the
    // very end of this method.
    let crosshairSample = null, crosshairSec = 0;
    if (this._crosshair && this._samples[this._crosshair.index]) {
      const s   = this._samples[this._crosshair.index];
      const sec = s.elapsedTime ?? this._crosshair.index;
      if (sec >= visStart && sec <= visEnd) { crosshairSample = s; crosshairSec = sec; }
    }

    this._drawGrid(ctx, PAD, plotW, plotH, visStart, visEnd, soleSeries);

    // Lap markers
    for (const mark of this._laps) {
      const sec = this._sampleToSec(mark.sampleIndex);
      if (sec < visStart || sec > visEnd) continue;
      const x = toX(sec);
      ctx.strokeStyle = CHART_COLORS.lap;
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle  = CHART_COLORS.text;
      ctx.font       = '10px system-ui';
      ctx.textAlign  = 'left';
      ctx.fillText(`L${mark.lapNumber}`, x + 3, PAD.top + 12);
    }

    // Workout progress markers — a subtle dotted tick at each completed
    // step boundary, and one more pronounced marker where the whole
    // scripted workout finished. No text labels here (unlike the lap
    // markers above): a multi-interval workout can have dozens of step
    // boundaries, and labeling every one would clutter far more than it
    // clarifies — the line itself is enough to see progress at a glance.
    for (const mark of this._workoutMarks) {
      const sec = this._sampleToSec(mark.sampleIndex);
      if (sec < visStart || sec > visEnd) continue;
      const x = toX(sec);

      if (mark.kind === 'complete') {
        ctx.strokeStyle = CHART_COLORS.complete;
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, PAD.top + plotH);
        ctx.stroke();

        ctx.fillStyle = CHART_COLORS.complete;
        ctx.beginPath();
        ctx.arc(x, PAD.top, 3.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = CHART_COLORS.step;
        ctx.lineWidth   = 1;
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, PAD.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Series lines (one per metric, each with its own Y scale)
    for (const [key, cfg] of this._series) {
      this._drawSeries(ctx, key, cfg, PAD, plotW, plotH, visStart, visEnd, toX);
    }

    // Time axis labels — the trailing/right-end readout is anchored to
    // visEnd (the visible window's own edge) rather than the session's
    // running total, so it correctly holds still while this page is
    // focus-locked/frozen instead of counting up past what's on screen.
    // During normal live auto-scroll the two are equal anyway, so this is
    // a no-op change for the common case.
    this._drawTimeAxis(ctx, PAD, plotW, plotH, visStart, visEnd, visEnd);

    // Crosshair — drawn last so it sits on top of the grid/laps/series.
    if (crosshairSample) {
      this._drawCrosshair(ctx, crosshairSample, crosshairSec, PAD, plotW, plotH, toX);
    } else if (this._crosshair) {
      // Crosshair is set but its sample has scrolled outside the visible
      // window (e.g. live auto-scroll while a split-cell scrub is mid-drag
      // near the trailing edge) — nothing to draw, and any external DOM
      // readout should clear too rather than keep showing a stale value.
      this._onCrosshairChange?.(null);
    }
  }

  _drawGrid(ctx, PAD, plotW, plotH, visStart, visEnd, soleSeries = null) {
    ctx.strokeStyle = CHART_COLORS.grid;
    ctx.lineWidth   = 1;

    // Horizontal grid (4 lines)
    for (let i = 0; i <= 4; i++) {
      const y = PAD.top + (i / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + plotW, y);
      ctx.stroke();

      if (soleSeries) {
        const { yMin, yMax } = soleSeries;
        const val = yMax - (i / 4) * (yMax - yMin);
        ctx.fillStyle    = CHART_COLORS.text;
        ctx.font         = '10px system-ui';
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(_fmtAxisVal(val), PAD.left - 6, y);
      }
    }
    ctx.textBaseline = 'alphabetic'; // restore default used by other draw calls
  }

  _drawSeries(ctx, key, cfg, PAD, plotW, plotH, visStart, visEnd, toX) {
    const { color, yMin, yMax, transform } = cfg;
    const xform  = transform ?? (v => v);
    const yRange = yMax - yMin || 1;

    const toY = (val) =>
      PAD.top + plotH - ((val - yMin) / yRange) * plotH;

    // Points actually plotted, across the visible window: a sample's own
    // value while the device supplying this metric is live, or the most
    // recent value known before that — held flat — everywhere it isn't
    // (see recording/session.js#clearData, which is what makes a
    // disconnected metric report null here instead of silently repeating
    // its last reading forever). `live` records which of the two each
    // point is, so runs of it below can be drawn in this series' own color
    // vs. a dimmed stale gray. The carried-forward value is resolved from
    // the *full* sample buffer rather than just the visible slice, since
    // an outage can have started before the visible window's own left
    // edge (e.g. scrolled forward mid-outage) — otherwise the line would
    // incorrectly restart from nothing at the window's edge instead of
    // showing what was already known.
    //
    // A sample.backfilled reading (see recording/session.js#_tick() and
    // Sample.backfilled in core/sample.js) is excluded here the same way a
    // null reading is: it's _latestData copied onto a second it wasn't
    // actually measured at, so it must not become `lastVal` — doing so
    // would draw the line jumping straight to the post-gap reading at the
    // *start* of a background stretch (i.e. before the app was foregrounded
    // and that reading was ever taken), across a run of instants nothing
    // was really known about. Skipping it instead leaves `lastVal` at
    // whatever the last genuine reading was, so that whole stretch draws
    // flat and gray like any other gap, and the line only jumps to the
    // real post-gap value at the one sample that's actually current as of
    // its own timestamp.
    let lastVal = null;
    const points = [];
    for (const s of this._samples) {
      const sec = s.elapsedTime ?? 0;
      const raw = s[key];
      const hasRaw = raw !== null && raw !== undefined && !s.backfilled;
      if (hasRaw) lastVal = raw;
      if (sec < visStart - 2 || sec > visEnd + 2) continue;
      if (lastVal === null) continue; // nothing known yet at this point in time
      points.push({ sec, val: lastVal, live: hasRaw });
    }

    if (points.length < 2) return;

    // Split into runs of consecutive same-liveness points. `kind` is
    // decided once per run (from the point that opened it) rather than
    // read back off each point, because the point where a run ends is
    // duplicated into the next run too — shared so the two segments'
    // strokes meet exactly instead of leaving a visible seam — and that
    // shared point's own `live` belongs to the *next* run, not this one.
    const runs = [];
    let kind = points[0].live;
    let pts  = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      pts.push(p);
      if (p.live !== kind) {
        runs.push({ kind, pts });
        pts = [p];
        kind = p.live;
      }
    }
    runs.push({ kind, pts });

    for (const run of runs) {
      if (run.pts.length < 2) continue;
      const runColor = run.kind ? color : CHART_COLORS.stale;
      const first = run.pts[0], last = run.pts[run.pts.length - 1];

      // Filled area
      ctx.beginPath();
      ctx.moveTo(toX(first.sec), PAD.top + plotH);
      for (const p of run.pts) ctx.lineTo(toX(p.sec), toY(xform(p.val)));
      ctx.lineTo(toX(last.sec), PAD.top + plotH);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
      grad.addColorStop(0, runColor + '50');
      grad.addColorStop(1, runColor + '08');
      ctx.fillStyle = grad;
      ctx.fill();

      // Line
      ctx.beginPath();
      ctx.strokeStyle = runColor;
      ctx.lineWidth   = 1.5;
      ctx.lineJoin    = 'round';
      run.pts.forEach((p, i) => {
        const x = toX(p.sec);
        const y = toY(xform(p.val));
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Y label (left axis — last series wins, but labels stack). Skipped in
    // single-metric mode: numeric axis ticks (drawn in _drawGrid) already
    // convey the scale, and the metric name is shown above the chart
    // instead. Also skipped in overview mode, where overlaid series don't
    // share a scale and are told apart by color alone (a crosshair surfaces
    // each one's value in the chip drawn in _drawCrosshair() instead).
    if (!this._singleMetric && !this._overview) {
      ctx.fillStyle  = color;
      ctx.font       = '10px system-ui';
      ctx.textAlign  = 'right';
      ctx.fillText(cfg.label, PAD.left - 4, PAD.top + 10);
    }
  }

  /** Vertical guide line + one snapped dot per series at the crosshair's
   *  sample, plus a chip listing every series' value (color-matched to its
   *  dot) with the elapsed time underneath — floating above the touched
   *  point or fixed to the top-right corner, per opts.crosshairChipAnchor
   *  (see _drawCrosshairChip() below). */
  _drawCrosshair(ctx, sample, sec, PAD, plotW, plotH, toX) {
    const x = toX(sec);

    ctx.save();
    ctx.strokeStyle = CHART_COLORS.crosshairSoft;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + plotH);
    ctx.stroke();

    // One dot per series, snapped to its own value — each series scales
    // independently (see _drawSeries), so the dot has to use that same
    // series' own yMin/yMax/transform rather than a shared mapping.
    const readouts = [];
    for (const [key, cfg] of this._series) {
      // Same last-known-value resolution _drawSeries() uses to draw the
      // flat gray line — so scrubbing the crosshair across a disconnected
      // stretch still snaps to a dot on it, gray to match, instead of
      // that series just vanishing from the readout.
      const resolved = this._lastKnownAt(key, this._crosshair.index);
      if (!resolved) continue;
      const { val, live } = resolved;
      const dotColor = live ? cfg.color : CHART_COLORS.stale;
      const xform  = cfg.transform ?? (v => v);
      const yRange = cfg.yMax - cfg.yMin || 1;
      const y = PAD.top + plotH - ((xform(val) - cfg.yMin) / yRange) * plotH;

      ctx.beginPath();
      ctx.fillStyle = dotColor;
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth   = 1.25;
      ctx.strokeStyle = CHART_COLORS.bg;
      ctx.stroke();

      const text = _fmtCrosshairValue(val, cfg);
      if (text) readouts.push({ key, label: cfg.label, color: dotColor, text });
    }

    // A single-metric page produces exactly one readout here; the overview
    // page can produce several (one per overlaid series) — the chip stacks
    // however many it's handed, so both share the same rendering.
    if (this._showCrosshairChip && readouts.length) {
      this._drawCrosshairChip(ctx, x, sec, PAD, plotW, readouts);
    }
    this._onCrosshairChange?.(readouts.length ? readouts : null, sec);
    ctx.restore();
  }

  /** Value/time chip shown at the crosshair — see opts.crosshairChipAnchor
   *  above for which of the two layouts below a given engine uses. */
  _drawCrosshairChip(ctx, x, sec, PAD, plotW, readouts) {
    if (this._crosshairChipAnchor === 'top-right') {
      this._drawCrosshairChipFixed(ctx, PAD, plotW, readouts);
    } else {
      this._drawCrosshairChipFloating(ctx, x, sec, PAD, plotW, readouts);
    }
  }

  /** Small rounded value/time chip anchored above the crosshair, clamped so
   *  it never runs past the plot's own left/right edges. Stacks one
   *  color-matched value line per reading — a single-metric page passes
   *  one — with the elapsed time as a shared line underneath.
   *
   *  Rests at a fixed distance below the plot's top edge by default, but
   *  that resting spot sits in the same top-right corner as a page's own
   *  .chart-badges cluster (Zone/Calories/Distance/Pace, live only) — so
   *  scrubbing the crosshair near the right edge would otherwise slide
   *  this chip in right underneath/behind that DOM overlay. When
   *  opts.getBadgesRect reports a badges box whose horizontal span the
   *  chip is about to share, drop the chip below it instead, so the two
   *  never fight over the same spot. */
  _drawCrosshairChipFloating(ctx, x, sec, PAD, plotW, readouts) {
    const timeText = _fmtSec(sec);
    const ROW_H    = 15; // baseline-to-baseline spacing between stacked values
    const TOP      = 16; // chip top -> first value baseline
    const GAP      = 12; // last value baseline -> time baseline
    const BOTTOM   = 5;  // time baseline -> chip bottom edge

    ctx.font = 'bold 13px system-ui';
    let maxW = 0;
    for (const r of readouts) maxW = Math.max(maxW, ctx.measureText(r.text).width);
    ctx.font = '10px system-ui';
    maxW = Math.max(maxW, ctx.measureText(timeText).width);

    const chipW    = Math.ceil(maxW) + 20;
    const lastValY = TOP + (readouts.length - 1) * ROW_H;
    const timeY    = lastValY + GAP;
    const chipH    = timeY + BOTTOM;
    const chipX = Math.max(PAD.left + 2, Math.min(PAD.left + plotW - chipW - 2, x - chipW / 2));

    let chipY = PAD.top + 6;
    const badgesRect = this._getBadgesRect?.();
    // Only the horizontal span matters here: both this chip and the badges
    // cluster already live at the same fixed distance from the plot's top
    // edge, so if their x-ranges overlap at all their y-ranges do too.
    if (badgesRect && chipX < badgesRect.right && chipX + chipW > badgesRect.left) {
      chipY = Math.max(chipY, badgesRect.bottom + 6);
    }

    ctx.fillStyle   = CHART_COLORS.tipBg;
    ctx.strokeStyle = 'rgba(255,255,255,.1)';
    ctx.lineWidth   = 1;
    _roundRectPath(ctx, chipX, chipY, chipW, chipH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font      = 'bold 13px system-ui';
    readouts.forEach((r, i) => {
      ctx.fillStyle = r.color;
      ctx.fillText(r.text, chipX + chipW / 2, chipY + TOP + i * ROW_H);
    });

    ctx.fillStyle = CHART_COLORS.text;
    ctx.font      = '10px system-ui';
    ctx.fillText(timeText, chipX + chipW / 2, chipY + timeY);
  }

  /** Fixed top-right variant, used by the overview/"combined" page. Pinned
   *  to the same corner as the .chart-badges DOM overlay used for the
   *  Zone/Calories/Distance/Pace readouts during an active workout, rather
   *  than tracking the crosshair's x position — several overlaid,
   *  differently-scaled series read better as a steady corner cluster than
   *  as a box chasing the touch point. Each reading draws as its own small
   *  panel — translucent background, a full-height 2px rule and a soft wash
   *  in that series' own color, plain bold value over a muted uppercase
   *  label (the shared readout look; see "Stat chips" in style.css) — the
   *  canvas equivalent of one .chart-badge-item, so this crosshair cluster
   *  reads as the same instrument-panel language as that DOM one instead
   *  of a plain stacked list. Panels sit side by side in a single row
   *  (unlike .chart-badges' own column of stacked items) since several
   *  differently-named series appearing at once here reads more like a
   *  readout strip than a corner stack. Elapsed time is no longer drawn
   *  inside this chip — see ChartCarousel's shared split-grid time marker
   *  (_updateSplitTimeMarker()), which now also drives the combined page's
   *  own crosshair, hovering the elapsed-time readout along the time axis
   *  at the crosshair's x instead of pinning it to this corner. */
  _drawCrosshairChipFixed(ctx, PAD, plotW, readouts) {
    // Padding numbers mirror .chart-badge-item's own CSS (padding: 4px 10px 4px 12px, the
    // 12 being the 2px rule plus 10px of padding) — so PAD_LEFT includes the BAR_W-wide rule.
    const PAD_TOP = 5, PAD_BOTTOM = 5, PAD_LEFT = 12, PAD_RIGHT = 10;
    const BAR_W   = 2;
    const CHIP_GAP = 4; // matches .chart-badge-pair's own gap between same-row badges
    const RADIUS  = 5;  // var(--radius-sm)
    const VAL_H   = 13; // value baseline -> its own label baseline, unchanged from the old stacked layout

    const valBaselineY   = PAD_TOP + 10;
    const labelBaselineY = valBaselineY + VAL_H;
    const chipH          = labelBaselineY + PAD_BOTTOM - 2;

    // Measure each panel's own content width independently — a narrow
    // reading (e.g. "88 rpm") no longer pays for a wide neighbor's column,
    // same reasoning ChartEngine's own axis-label gutter uses.
    ctx.font = 'bold 13px system-ui';
    const valWidths = readouts.map(r => ctx.measureText(r.text).width);
    ctx.font = '9px system-ui';
    const lblWidths = readouts.map(r => ctx.measureText((r.label ?? '').toUpperCase()).width);
    const chipWidths = readouts.map((_, i) =>
      Math.ceil(Math.max(valWidths[i], lblWidths[i])) + PAD_LEFT + PAD_RIGHT);

    const totalW = chipWidths.reduce((a, b) => a + b, 0) + CHIP_GAP * Math.max(0, readouts.length - 1);
    // Tucked into the canvas' true top-right corner. CORNER_INSET is
    // measured from the canvas edge itself (via PAD.right below), not from
    // the plot's own inner edge, so the cluster sits flush past the
    // chart's axis margin rather than floating inside the plot area —
    // previously pinned to .chart-badges' own top:10px, which read as
    // sitting further from the corner than intended once PAD.right's own
    // inset stacked on top of it.
    const CORNER_INSET = 6;
    const chipY  = CORNER_INSET;
    // Row anchors to the canvas' true right edge — PAD.left + plotW is
    // only the plot's inner edge, PAD.right accounts for the chart's own
    // axis margin beyond that — clamped so a wide row (many overlaid
    // metrics on a narrow chart) runs off the plot's own left edge instead
    // of the canvas'.
    const rowStartX = Math.max(PAD.left + 2, PAD.left + plotW + PAD.right - totalW - CORNER_INSET);

    let x = rowStartX;
    readouts.forEach((r, i) => {
      const w = chipWidths[i];

      // No backing panel, same as .chart-badge-item: the wash below fades
      // to nothing and the chart shows through. The shape is the shared readout one — left
      // corners square, right ones soft (radius [0, R, R, 0]) — and there is no outline.
      //
      // Metric wash: the series' colour fading left -> right behind the text, as in the CSS.
      const wash = ctx.createLinearGradient(x, 0, x + w, 0);
      wash.addColorStop(0, withAlpha(r.color, READOUT_ALPHA.washEnd0));
      wash.addColorStop(1, withAlpha(r.color, READOUT_ALPHA.washEnd1));
      ctx.fillStyle = wash;
      _roundRectPath(ctx, x, chipY, w, chipH, [0, RADIUS, RADIUS, 0]);
      ctx.fill();

      // The rule: a straight full-height 2px edge at the shared rule strength — the CSS border-left.
      ctx.fillStyle = withAlpha(r.color, READOUT_ALPHA.rule);
      ctx.fillRect(x, chipY, BAR_W, chipH);

      // Value + label, right-aligned within the panel — same right-flush
      // stack .chart-badge-item's align-items:flex-end produces.
      const rightEdge = x + w - PAD_RIGHT;
      ctx.textAlign = 'right';
      ctx.fillStyle = CHART_COLORS.crosshair;   // plain primary text; the colour is the rule's and the wash's
      ctx.font      = 'bold 13px system-ui';
      ctx.fillText(r.text, rightEdge, chipY + valBaselineY);
      ctx.fillStyle = CHART_COLORS.text;
      ctx.font      = '9px system-ui';
      ctx.fillText((r.label ?? '').toUpperCase(), rightEdge, chipY + labelBaselineY);

      x += w + CHIP_GAP;
    });
  }

  _drawTimeAxis(ctx, PAD, plotW, plotH, visStart, visEnd, totalSec) {
    const visRange = visEnd - visStart || 1;
    const step      = _niceStep(visRange, 6);
    const firstTick = Math.ceil(visStart / step) * step;
    const rightEdgeX = PAD.left + plotW;
    const baseline    = PAD.top + plotH + TIME_AXIS_BASELINE_OFFSET;

    ctx.fillStyle  = CHART_COLORS.text;
    ctx.font       = '10px system-ui';
    ctx.textAlign  = 'center';

    for (let t = firstTick; t <= visEnd; t += step) {
      const x = PAD.left + ((t - visStart) / visRange) * plotW;
      // Skip regular ticks that would collide with the elapsed-time
      // readout anchored at the axis' right end, drawn below.
      if (rightEdgeX - x < 26) continue;
      ctx.fillText(_fmtSec(t), x, baseline);
    }

    // Elapsed time — replaces the old toolbar readout. Always anchored to
    // the trailing end of the time axis, since that's where "now" lives
    // whether the chart is auto-scrolling live or showing a finished
    // session in full.
    ctx.font       = 'bold 10px system-ui';
    ctx.fillStyle  = CHART_COLORS.crosshair;
    ctx.textAlign  = 'right';
    ctx.fillText(_fmtSec(totalSec), rightEdgeX, baseline);
  }

  _totalDuration() {
    if (this._samples.length === 0) return 0;
    return this._samples[this._samples.length - 1].elapsedTime ?? this._samples.length;
  }

  _sampleToSec(idx) {
    const s = this._samples[Math.min(idx, this._samples.length - 1)];
    return s?.elapsedTime ?? idx;
  }

  // ─── Interaction ──────────────────────────────────────────────────────────

  _bindInteraction() {
    // Single-metric and overview instances live inside ChartCarousel pages —
    // horizontal drag/wheel there drives swiping between metrics, not
    // panning this chart's own time axis, so this engine stays passive and
    // just renders. (ChartCarousel instead drives pan/zoom directly via
    // panByPixels()/zoomAt() on whichever page is focus-locked — see its
    // _bindSwipeGestures().)
    if (this._singleMetric || this._overview) return;

    const c = this._canvas;

    // Middle-click hold + drag pans the time window. Left-click is left
    // free (e.g. for a future click-to-select), so panning only starts on
    // the middle button.
    let midDragX = null;
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 1) return;
      e.preventDefault(); // stop the browser's native middle-click autoscroll
      midDragX = e.clientX;
    });
    c.addEventListener('mousemove', (e) => {
      if (midDragX === null) return;
      const dx = midDragX - e.clientX;
      midDragX = e.clientX;
      this.panByPixels(dx);
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 1) midDragX = null; });

    // Scroll wheel zooms, anchored on whatever's under the cursor.
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const factor = e.deltaY > 0 ? 1.2 : 0.8;
      this.zoomAt(factor, e.clientX - rect.left);
    }, { passive: false });

    // Touch: one finger pans; two fingers pinch-to-zoom, anchored at the
    // midpoint between them (and pan along with that midpoint too, so a
    // two-finger drag that also pinches doesn't fight the zoom).
    let touchDragX = null;
    let pinchDist  = null, pinchMidX = null;

    c.addEventListener('touchstart', (e) => {
      if (e.touches.length >= 2) {
        touchDragX = null;
        const [t0, t1] = e.touches;
        pinchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        pinchMidX = (t0.clientX + t1.clientX) / 2;
        return;
      }
      pinchDist  = null;
      touchDragX = e.touches[0].clientX;
    });

    c.addEventListener('touchmove', (e) => {
      if (e.touches.length >= 2) {
        if (pinchDist === null) return;
        const [t0, t1] = e.touches;
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const midX = (t0.clientX + t1.clientX) / 2;
        const rect = c.getBoundingClientRect();
        this.zoomAt(pinchDist / dist, midX - rect.left);
        this.panByPixels(pinchMidX - midX);
        pinchDist = dist;
        pinchMidX = midX;
        return;
      }
      if (touchDragX === null) return;
      const dx = touchDragX - e.touches[0].clientX;
      touchDragX = e.touches[0].clientX;
      this.panByPixels(dx);
    });

    c.addEventListener('touchend',    () => { touchDragX = null; pinchDist = null; });
    c.addEventListener('touchcancel', () => { touchDragX = null; pinchDist = null; });
  }

  // ─── Resize ───────────────────────────────────────────────────────────────

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this._canvas.getBoundingClientRect();
    this._cssWidth       = rect.width;
    this._cssHeight      = rect.height;
    this._canvas.width  = rect.width  * dpr;
    this._canvas.height = rect.height * dpr;
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._scheduleRender();
  }

  /** Clean up observers and animation frames. */
  destroy() {
    this._resizeObserver.disconnect();
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _fmtSec(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Public wrapper around the same elapsed-time formatting every chip and
 *  axis label on this engine already uses internally, for a caller that
 *  wants to render its own time readout in the same m:ss/h:mm:ss style
 *  (e.g. ChartCarousel's shared split-grid time marker — see
 *  _updateSplitTimeMarker()). */
export function formatElapsed(sec) {
  return _fmtSec(sec);
}

/**
 * @typedef {Object} WorkoutMark
 * @property {number} sampleIndex
 * @property {'step'|'complete'} kind  'step' for a completed step boundary
 *   inside a multi-step workout, 'complete' for the single marker where the
 *   whole scripted workout finished.
 */

/** The widest Y-axis tick label a chart can be asked to draw, measured to fix the gutter's width (see
 *  ChartEngine#_measureLeftPad()). _fmtAxisVal() gives whole numbers from 100 up and one decimal below,
 *  so the widest is four digits ("8888": 8 is among the widest digits), as on a 1000+ W History axis; a
 *  decimal like "27.7" is narrower. No chart's axis goes negative, so there is no sign to allow for. */
const AXIS_LABEL_WORST_CASE = ['8888'];

/** Formats a Y-axis tick value: whole numbers for large scales, 1 decimal for small ones. */
function _fmtAxisVal(v) {
  if (Math.abs(v) >= 100 || Number.isInteger(v)) return String(Math.round(v));
  return v.toFixed(1);
}

/** Formats a crosshair readout value: the series' own `fmt` (raw sample
 *  value in, display string out) when one's configured, falling back to
 *  the axis-tick formatter applied to the transformed/display value
 *  otherwise. Appends the unit suffix when one's configured. */
function _fmtCrosshairValue(raw, cfg) {
  if (raw === null || raw === undefined) return null;
  const text = cfg.fmt ? String(cfg.fmt(raw)) : _fmtAxisVal((cfg.transform ?? (v => v))(raw));
  return cfg.unit ? `${text} ${cfg.unit}` : text;
}

/** Traces a rounded-rect path, using the native roundRect() where available
 *  and falling back to manual arcs on older engines. Caller fills/strokes. */
/** `r` is one radius for all four corners, or [topLeft, topRight, bottomRight, bottomLeft]. */
function _roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  // Fallback for a canvas without roundRect(): the same four corners, one arc each.
  const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y,     x + w, y + tr,     tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x,     y + h, x,     y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x,     y,     x + tl, y,         tl);
  ctx.closePath();
}

function _niceStep(range, targetTicks) {
  const rough = range / targetTicks;
  const candidates = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return candidates.find(c => c >= rough) ?? 3600;
}

export default ChartEngine;
