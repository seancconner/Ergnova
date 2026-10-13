// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * charts/chart-carousel.js
 *
 * Splits the single overlaid live chart into one page per metric, laid out
 * in a horizontally swipeable, scroll-snapped track — swipe (or click a dot)
 * to switch which metric the chart is showing. Each page is its own
 * ChartEngine in 'singleMetric' mode, so it gets a real numeric Y-axis
 * instead of the old stacked color-coded corner labels.
 *
 * This class owns chart rendering/swiping only. It has no opinion about
 * current/average/peak readouts — it just reports which metric key is
 * active (on rebuild, swipe, or dot click) via onActiveMetric, so the
 * caller can drive its own stat display from whatever data source makes
 * sense (e.g. live BLE ticks pre-session, recorded samples mid-session).
 *
 * Pass `showOverview: true` to also get a leading "All" page — every
 * currently-available metric overlaid on one chart (each on its own
 * normalized scale), told apart by color alone rather than a Y-axis legend.
 * A crosshair there (see focus-lock below) surfaces every series' value in
 * a stacked chip, the same chip style single-metric pages use. Unlike the
 * individual metric pages, this page's series set is fully rebuilt on every
 * setAvailableMetrics() call rather than diffed, since it always needs to
 * reflect the complete current set.
 *
 * A small grid-icon button hovering over that page's top-left corner (see
 * _buildSplitToggle()/_setOverviewSplit() below) swaps the overlay for a
 * 2x2 grid of up to 4 separate per-metric mini charts instead — handy for
 * telling similarly-scaled series apart at a glance. Focus-lock is a no-op
 * on that page while the split view is open, since there's no single
 * crosshair position that means anything across four independent charts.
 * Instead, press-and-hold on any one split-grid cell (the same long press
 * that focus-locks a single chart; a plain touch or drag does nothing, so
 * swiping between pages still works from over the grid), then drag, and
 * every cell's crosshair moves together (see _beginSplitScrub()), snapped to
 * the same instant — so all four quadrants always read out the value each
 * metric had at that one moment, not just the touched chart's own. A
 * shared time marker (see _updateSplitTimeMarker()) sits right on top of
 * the touched chart's own fixed time-axis row, at the crosshair's exact x,
 * spelling out the precise elapsed time that row's nearby tick increments
 * are measured against. The same marker also rides the overview page's own
 * crosshair when its split view is closed (the ordinary overlaid/combined
 * chart) — see _updateCrosshairAt() — since that chip anchors to the
 * top-right corner instead of tracking the crosshair (see ChartEngine's
 * crosshairChipAnchor doc), and elapsed time reads better hovering along
 * the axis than pinned to that corner too.
 *
 * Press-and-hold a page to focus-lock onto it: swiping is suspended, a
 * colored ring glows in from that page's own edge, and drags move a
 * crosshair (rendered by its ChartEngine) instead of switching pages. A
 * second long-press, the small exit chip it shows, Escape, or picking a
 * different page from the dots all release it again — see _engageLock()/
 * _disengageLock() and _bindSwipeGestures() below.
 *
 * Usage:
 *   import { ChartCarousel } from './charts/chart-carousel.js';
 *
 *   const carousel = new ChartCarousel(containerEl, {
 *     mode: 'live',
 *     windowSec: 300,
 *     showOverview: true,
 *     onActiveMetric: (key) => { ... },
 *     onSplitChange: (on, defs) => { ... },
 *   });
 *
 *   carousel.setAvailableMetrics([
 *     { key: 'power', label: 'Power', color: CHART_COLORS.power, yMin: 0, yMax: 700 },
 *     { key: 'heartRate', label: 'Heart Rate', color: CHART_COLORS.heartRate, yMin: 40, yMax: 220 },
 *   ]);
 *   // (The live chart's corner readouts — current Power/HR/Cadence/Speed, Zone, Calories, Distance, Pace —
 *   // are not built here: ui/chart-badge-bar.js holds them above the track so swiping never moves them.)
 *
 *   carousel.push(sample);            // forward each live sample
 *   carousel.setData(samples, laps);  // reset/replace the full buffer
 *   carousel.setWorkoutMarks(marks);  // step-complete/workout-complete markers (live scripted workouts)
 */

import { ChartEngine, CHART_COLORS, formatElapsed } from './chart-engine.js';
import { pageOrder } from './chart-order.js';

// Fraction of the track's width a drag/swipe needs to cross before it
// commits to switching pages — see _bindSwipeGestures() below. 1/8 means
// a short flick is enough; raise it (e.g. toward 1/2) to require a drag
// closer to a full page-width instead.
const SWIPE_THRESHOLD_FRACTION = 1 / 8;

// Release velocity (px/ms, measured from the last move sample before
// release — see _bindSwipeGestures()) that commits to a page change on
// its own, even if SWIPE_THRESHOLD_FRACTION's distance wasn't crossed —
// this is what makes a fast short flick feel as responsive as native
// swipe, rather than requiring every swipe to travel the full distance
// regardless of speed. ~0.5px/ms is a brisk, deliberate flick; a slow
// drag rarely exceeds ~0.1-0.2px/ms even over a large distance.
const FLICK_VELOCITY_PX_MS = 0.5;

// Hold duration (ms) for a press-and-hold to engage/disengage a page's
// focus-lock — see _bindSwipeGestures() and _engageLock()/_disengageLock()
// below. Long enough that an ordinary swipe attempt never accidentally
// triggers it (a real swipe typically starts moving well under this), short
// enough that it still reads as immediate and deliberate.
const LONG_PRESS_MS = 450;

// Max pointer movement (px) allowed during the hold before it's treated as
// a swipe/scrub attempt instead and the pending lock-toggle is cancelled.
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

// The overview page's split view (see _setOverviewSplit() below) always
// lays out as a 2x2 grid of at most this many separate mini charts —
// mirroring the "up to 4 metric series simultaneously" design the
// overlaid view already assumes (see chart-engine.js's class doc). Series
// beyond the 4th still show up in the overlaid combined view, just not in
// the split grid.
const OVERVIEW_SPLIT_MAX = 4;

// Upward nudge (px) applied when positioning the split-grid time marker
// against ChartEngine's reported axisY — see _updateSplitTimeMarker().
// axisY is a text *baseline* (glyphs sit above it, with a little
// descender room below), but the marker is centered vertically via CSS
// transform, so lining its center straight up with the baseline reads as
// sitting slightly below the axis text rather than on it. This shifts the
// centering point up toward the glyphs' actual vertical middle instead.
const TIME_MARKER_Y_NUDGE = 18;

export class ChartCarousel {
  // Fixed key for the overview page, exposed so a host can tell whether
  // onActiveMetric's `key` refers to it (e.g. to decide whether its own
  // split-driven UI — see onSplitChange below — should currently be
  // visible at all, on top of just being toggled on: the split grid can
  // stay open while the rider swipes away to a single-metric page, and a
  // host's own per-metric readout needs to hide right along with it).
  // Never collides with a real metric key, which always comes from a
  // Sample field name.
  static OVERVIEW_KEY = '__overview__';

  /**
   * @param {HTMLElement} container   Empty element this carousel takes over.
   * @param {Object}   opts
   * @param {'live'|'history'} [opts.mode='live']
   * @param {number}   [opts.windowSec=300]
   * @param {boolean}  [opts.showOverview=false]  Add a leading "All" page
   *   overlaying every available metric — see class doc above.
   * @param {string}   [opts.emptyMessage]  Shown when there are no metrics
   *   to display. Defaults to the live-session wording; history usage
   *   should pass something like "No metrics recorded for this workout."
   * @param {{label:string, onClick:Function, title?:string}|null} [opts.emptyAction]
   *   When set, the empty state is a tile (icon, `emptyTitle`, the message, and a button labelled
   *   `label` that calls `onClick`) instead of one muted line. Live cardio passes a Connect action
   *   that opens the sensor menu; History passes nothing and keeps the plain line.
   * @param {string}   [opts.emptyTitle='No live data yet']  Heading of the empty tile (with emptyAction).
   * @param {number}   [opts.chartBgAlpha=1]  Opacity of each chart canvas's own background (0-1) —
   *   see ChartEngine's bgAlpha. Live cardio passes 0 so its hero-tier glass panel shows through.
   * @param {boolean}  [opts.overviewFollowsHero=false]  The All page draws ONE metric's chart at a time
   *   — whichever the host last named with setOverviewMetric() — instead of overlaying every metric
   *   (or offering the split grid, whose toggle is not built). Live cardio uses it: the host rotates
   *   its hero readout on a timer and tells the chart to follow, so the All page reads as the hero's
   *   own chart. The page's dot (--dot-color) takes that metric's colour too. History leaves it off
   *   and keeps the overlay.
   * @param {Function} [opts.onActiveMetric]   (key: string|null) => void
   * @param {Function} [opts.onMetricOrder]   (keys: string[]) => void. Fired by setAvailableMetrics() once the
   *   metric pages are in place and before anything reads them: the metric keys in the order their dots
   *   run (the All page's own dot excluded). The host's All-page rotation and the badge bar's partner
   *   metric follow this list, so every place that orders the metrics agrees with the dots by
   *   construction, however the sensors happened to pair.
   * @param {Function} [opts.onSplitChange]   (on: boolean, defs: Array) =>
   *   void. Fired whenever the overview page's own metric set is (re)built —
   *   initial build, a sensor (un)pairing mid-ride, or its split view (see
   *   _setOverviewSplit() below) turning on or off. `defs` is always the
   *   same up-to-OVERVIEW_SPLIT_MAX list the split grid itself would be (or
   *   is) built from, regardless of whether that split grid is actually on
   *   screen — the overlaid combined chart carries the exact same metric
   *   set, just drawn differently. Lets the host drive its own per-metric
   *   stat readout (e.g. a Current/Average/Peak column per metric) for
   *   *either* of the overview page's two chart styles from one code path,
   *   without this class needing any opinion on what that readout looks
   *   like — same division of responsibility as onActiveMetric above. `on`
   *   still tells the host which chart style is currently on screen, in
   *   case that ever matters to it.
   */
  constructor(container, {
    mode = 'live', windowSec = 300, showOverview = false,
    emptyMessage = 'Connect a sensor to see live metrics', emptyAction = null, emptyTitle = 'No live data yet',
    chartBgAlpha = 1, overviewFollowsHero = false, onActiveMetric, onMetricOrder, onSplitChange,
  } = {}) {
    this._container      = container;
    this._mode           = mode;
    this._windowSec      = windowSec;
    this._showOverview   = showOverview;
    this._emptyMessage   = emptyMessage;
    this._emptyAction    = emptyAction;
    this._emptyTitle     = emptyTitle;
    this._chartBgAlpha   = chartBgAlpha;
    this._followHero     = overviewFollowsHero;
    this._overviewMetric = null;   // the metric the All page is drawing in follow mode — see setOverviewMetric()
    this._onActiveMetric = onActiveMetric ?? (() => {});
    this._onMetricOrder  = onMetricOrder ?? (() => {});
    this._onSplitChange  = onSplitChange ?? (() => {});

    this._pages  = new Map();  // key -> { def, page, canvas, engine, ... } — see _insertPageAt()/_buildOrUpdateOverviewPage()
    this._order  = [];         // keys, in display order (overview page, if any, is always first)
    this._activeKey = null;
    this._samples = [];
    this._laps    = [];
    this._workoutMarks = []; // see setWorkoutMarks() — threaded to every engine same as _laps
    this._locked  = false;     // true while the active page is focus-locked — see _engageLock()
    this._lockExitEl = null;   // exit chip shown while locked — see _engageLock()/_disengageLock()
    this._onLockKeydown = (e) => { if (e.key === 'Escape') this._disengageLock(); };
    this._splitScrub = null;   // { p, key, engine, cell, canvas } while a held press is scrubbing the split grid — see _beginSplitScrub()
    this._overviewSplit = false; // true while the overview page shows its split grid — see _setOverviewSplit()

    this._OVERVIEW_KEY = ChartCarousel.OVERVIEW_KEY;

    this._buildShell();

    this._scrollRaf = null;
    this._track.addEventListener('scroll', () => this._onScroll(), { passive: true });
    this._bindSwipeGestures();

    this._resizeObserver = new ResizeObserver(() => this._resnap());
    this._resizeObserver.observe(this._track);
  }

  // ─── Shell ────────────────────────────────────────────────────────────────

  _buildShell() {
    this._container.innerHTML = '';

    this._track = document.createElement('div');
    this._track.className = 'chart-track';
    this._container.appendChild(this._track);

    this._dots = document.createElement('div');
    this._dots.className = 'chart-dots hidden';
    this._container.appendChild(this._dots);

    this._emptyEl = document.createElement('div');
    this._emptyEl.className = 'chart-empty';
    const action = this._emptyAction;
    if (action?.onClick) {
      // A real tile: the icon, a heading, one muted line, and the button that fixes it.
      this._emptyEl.classList.add('chart-empty--tile');
      this._emptyEl.innerHTML = `
        <div class="chart-empty-tile">
          <span class="chart-empty-icon" aria-hidden="true"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-bluetooth"/></svg></span>
          <span class="chart-empty-title"></span>
          <span class="chart-empty-sub"></span>
          <button type="button" class="btn btn-glass-cta chart-empty-btn"></button>
        </div>`;
      this._emptyEl.querySelector('.chart-empty-title').textContent = this._emptyTitle;
      this._emptyEl.querySelector('.chart-empty-sub').textContent = this._emptyMessage;
      const btn = this._emptyEl.querySelector('.chart-empty-btn');
      btn.textContent = action.label ?? 'Connect';
      if (action.title) btn.title = action.title;
      btn.addEventListener('click', (e) => { e.stopPropagation(); action.onClick(btn); });
    } else {
      this._emptyEl.textContent = this._emptyMessage;
    }
    this._container.appendChild(this._emptyEl);
  }

  // ─── Pages ────────────────────────────────────────────────────────────────

  /**
   * Rebuild the set of visible metric pages. Pages for metrics still present
   * are left untouched (no re-render, no lost scroll position) — only the
   * difference is applied, so e.g. pairing an HR strap mid-ride doesn't
   * disturb whichever page the rider is currently looking at.
   *
   * @param {Array<{key,label,color,yMin,yMax}>} defs   Already filtered to
   *   whichever metrics are currently available, in display order.
   */
  setAvailableMetrics(defs) {
    const nextKeys = defs.map(d => d.key);
    // The overview page only earns its keep once there's more than one
    // metric to overlay — with just one it would just duplicate that
    // metric's own page.
    const showOverview = this._showOverview && defs.length > 1;
    const pageOffset = showOverview ? 1 : 0; // overview page occupies slot 0

    for (const key of [...this._order]) {
      if (key === this._OVERVIEW_KEY) continue; // handled separately below
      if (!nextKeys.includes(key)) this._removePage(key);
    }

    defs.forEach((def, i) => {
      if (!this._pages.has(def.key)) this._insertPageAt(def, i + pageOffset);
    });

    // Pages are created as sensors pair, so left alone their order would be the order the sensors connected
    // in (a power meter that pairs before the heart-rate strap would leave Power's page ahead of Heart
    // rate's, and the dots with it). `defs` is the host's display order, so seat the pages in it. The dots,
    // the All page's metric list and split grid, and the host's hero rotation all follow `_order`, so they
    // can never disagree with each other.
    this._arrangePages(nextKeys);
    const ordered = this._order
      .filter(k => k !== this._OVERVIEW_KEY)
      .map(k => defs.find(d => d.key === k))
      .filter(Boolean);
    this._onMetricOrder(ordered.map(d => d.key));

    if (showOverview) this._buildOrUpdateOverviewPage(ordered);
    else if (this._pages.has(this._OVERVIEW_KEY)) this._removePage(this._OVERVIEW_KEY);

    this._rebuildDots();

    const empty = this._order.length === 0;
    this._track.classList.toggle('hidden', empty);
    this._emptyEl.classList.toggle('hidden', !empty);

    if (!this._activeKey || !this._pages.has(this._activeKey)) {
      this._setActive(showOverview ? this._OVERVIEW_KEY : (nextKeys[0] ?? null), true);
    }
  }

  /**
   * Put the metric pages in `wantedKeys`' order (the All page, if there is one, stays first), moving their
   * elements to match and keeping whichever page is on screen on screen. A no-op when they are already in
   * order, which is almost every call: nothing is touched, so a sensor pairing mid-ride does not disturb
   * the page being looked at unless the new page really belongs before it.
   * @param {string[]} wantedKeys  the host's metric keys, in display order
   */
  _arrangePages(wantedKeys) {
    const overviewKey = this._pages.has(this._OVERVIEW_KEY) ? this._OVERVIEW_KEY : null;
    const next = pageOrder(overviewKey, wantedKeys, this._pages.keys());
    if (next.length === this._order.length && next.every((k, i) => k === this._order[i])) return;

    this._order = next;
    // appendChild on an element that is already in the track moves it, so this re-seats every page in order.
    for (const key of next) this._track.appendChild(this._pages.get(key).page);
    this._resnap();   // the same scrollLeft now holds a different page: put the active one back under it
  }

  /**
   * Build (once) or refresh the leading "All" overview page — one
   * ChartEngine in overview mode carrying every currently-available
   * metric's series. Unlike individual metric pages, its series set is
   * fully replaced on every call rather than diffed, so it always mirrors
   * the current `defs` exactly. Also carries the split-view toggle button
   * and (grid-)markup — see _setOverviewSplit() below.
   * @param {Array<{key,label,color,yMin,yMax,transform}>} defs
   */
  _buildOrUpdateOverviewPage(defs) {
    let p = this._pages.get(this._OVERVIEW_KEY);

    if (!p) {
      const page = document.createElement('div');
      page.className = 'chart-page chart-page-overview';
      page.dataset.metric = this._OVERVIEW_KEY;

      const canvas = document.createElement('canvas');
      canvas.className = 'live-chart';
      page.appendChild(canvas);

      // Split-view grid — built lazily (see _rebuildSplitEngines()) the
      // first time someone actually taps the toggle, so the common
      // overlaid view never pays for the extra ChartEngine instances/
      // ResizeObservers unless split view gets used.
      const splitGrid = document.createElement('div');
      splitGrid.className = 'chart-split-grid hidden';
      page.appendChild(splitGrid);

      // Single shared readout for the instant every split-grid cell's
      // crosshair is currently snapped to — see _updateSplitTimeMarker().
      // Also reused, un-split, for this same page's own combined/overlaid
      // crosshair (see _updateCrosshairAt()), since that view's value chip
      // is pinned to the top-right corner rather than tracking the
      // crosshair. Positioned dynamically (inline style, set on every
      // move) right over the touched chart's own time-axis row rather
      // than pinned anywhere fixed in this markup, so its resting
      // position here is irrelevant until the first scrub places it.
      const splitTimeMarker = document.createElement('div');
      splitTimeMarker.className = 'chart-split-time-marker hidden';
      page.appendChild(splitTimeMarker);

      // Follow mode draws one metric at a time, so there is nothing to split.
      const splitToggle = this._followHero ? null : this._buildSplitToggle(page);

      this._track.insertBefore(page, this._track.firstChild);

      const engine = new ChartEngine(canvas, this._followHero
        // One metric at a time: exactly a single-metric page's engine (numeric Y axis, its own chip).
        ? { mode: this._mode, windowSec: this._windowSec, singleMetric: true, bgAlpha: this._chartBgAlpha }
        : {
          mode: this._mode,
          windowSec: this._windowSec,
          overview: true,
          bgAlpha: this._chartBgAlpha,
          // Combined/overlaid series' per-metric values read better as a
          // steady corner panel than as a chip chasing the touch point —
          // see ChartEngine's crosshairChipAnchor doc and
          // _drawCrosshairChipFixed(). Elapsed time is no longer part of
          // that panel though — see the shared splitTimeMarker above.
          crosshairChipAnchor: 'top-right',
        });
      if (this._samples.length) engine.setData(this._samples, this._laps);
      if (this._workoutMarks.length) engine.setWorkoutMarks(this._workoutMarks);

      p = {
        def: { key: this._OVERVIEW_KEY, label: 'All', color: CHART_COLORS.text },
        page, canvas, engine,
        splitGrid, splitTimeMarker, splitToggle, splitEngines: null, overviewDefs: [],
      };
      this._pages.set(this._OVERVIEW_KEY, p);
      this._order.unshift(this._OVERVIEW_KEY);
    }

    p.overviewDefs = defs; // stashed so a later split-toggle can (re)build the mini charts from the current set
    if (this._followHero) {
      // Keep the metric the host chose if it is still available, otherwise fall back to the first.
      if (!defs.some(d => d.key === this._overviewMetric)) this._overviewMetric = defs[0]?.key ?? null;
      this._applyOverviewMetric(p);
    } else {
      p.engine.setSeries(defs.map(def => ({
        key: def.key, color: def.color, label: def.label, yMin: def.yMin, yMax: def.yMax,
        transform: def.transform, unit: def.unit, fmt: def.fmt,
      })));
      p.engine.refresh();
    }

    // Keep an already-open split grid in sync too — e.g. a sensor pairs or
    // unpairs mid-ride while the rider's looking at the split view rather
    // than the overlay.
    if (this._overviewSplit) {
      this._rebuildSplitEngines(p);
      // Metrics can reorder or swap as sensors (un)pair, changing which
      // one lands in the top-left cell (and how wide its labels are) —
      // resync the toggle's offset to match whatever's there now.
      this._syncSplitToggleOffset(p);
    }
    // Unconditional, unlike the two calls above: the host's own per-metric
    // readout (see onSplitChange's doc) mirrors the overview page's metric
    // set no matter which of its two chart styles is currently on screen,
    // so it needs this on every rebuild — the very first one included, not
    // just while the split grid happens to already be open.
    this._onSplitChange(this._overviewSplit, p.overviewDefs.slice(0, OVERVIEW_SPLIT_MAX));
  }

  /** Follow mode: which metric the All page should draw. Swaps its one series, takes the metric's colour
   *  for the page's dot and lock ring, and replays the chart's arrival fade. No-op outside follow mode, for
   *  a key that is not available, or when the All page already shows it. */
  setOverviewMetric(key) {
    if (!this._followHero || key === this._overviewMetric) return;
    const p = this._pages.get(this._OVERVIEW_KEY);
    if (!p || !p.overviewDefs.some(d => d.key === key)) return;
    this._overviewMetric = key;
    this._applyOverviewMetric(p);
    this._replayChartFade(p);
  }

  /** True while a page is focus-locked (a held crosshair): a host that rotates the All page should wait. */
  get locked() { return this._locked; }

  /** The metric keys in the order their dots run (the All page's own dot excluded). */
  get metricKeys() { return this._order.filter(k => k !== this._OVERVIEW_KEY); }

  /** Draw `this._overviewMetric` on the All page (follow mode): one series, the page's colour, its dot. */
  _applyOverviewMetric(p) {
    const def = p.overviewDefs.find(d => d.key === this._overviewMetric);
    if (!def) { p.engine.setSeries([]); p.engine.refresh(); return; }
    p.def.color = def.color;
    p.engine.setSeries([{
      key: def.key, color: def.color, label: def.label, yMin: def.yMin, yMax: def.yMax,
      transform: def.transform, unit: def.unit, fmt: def.fmt,
    }]);
    p.engine.refresh();
    const at = this._order.indexOf(this._OVERVIEW_KEY);
    this._dots.children[at]?.style.setProperty('--dot-color', def.color);
    if (this._locked && this._activeKey === this._OVERVIEW_KEY) p.page.style.setProperty('--lock-color', def.color);
  }

  /** The chart's arrival: the canvas fades in (.chart-swap in style.css), the same .35s the readout uses. */
  _replayChartFade(p) {
    p.canvas.classList.remove('chart-swap');
    void p.canvas.offsetWidth;
    p.canvas.classList.add('chart-swap');
  }

  /** Small top-left "split into separate charts" toggle for the overview
   *  page — a 2x2-squares icon that swaps the overlaid combined chart for
   *  up to OVERVIEW_SPLIT_MAX separate per-metric mini charts and back.
   *  See _setOverviewSplit() for what the toggle itself does. */
  _buildSplitToggle(page) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chart-split-toggle';
    btn.title = 'Split into separate charts';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = '<svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-grid"/></svg>';
    // Stop the tap from also reaching the track's own mousedown/touchstart
    // (they bubble from any child, including this button) — same reason
    // the lock-exit chip does this in _engageLock() below: otherwise
    // pressing the toggle would first register as a page-drag/long-press.
    const stopPointer = (e) => e.stopPropagation();
    btn.addEventListener('mousedown', stopPointer);
    btn.addEventListener('touchstart', stopPointer, { passive: true });
    btn.addEventListener('click', (e) => {
      stopPointer(e);
      this._setOverviewSplit(!this._overviewSplit);
    });
    page.appendChild(btn);
    return btn;
  }

  /**
   * Toggle the overview page between its default overlaid chart and a 2x2
   * grid of up to OVERVIEW_SPLIT_MAX separate per-metric mini charts (each
   * a normal singleMetric ChartEngine, same as an individual carousel
   * page — just smaller and all shown at once instead of swiped between).
   * Mini charts are (re)built fresh on every switch to split — cheap,
   * since there are at most 4 — and torn down on switch back.
   */
  _setOverviewSplit(on) {
    if (this._followHero || this._overviewSplit === on) return;   // follow mode has no split view
    this._overviewSplit = on;

    const p = this._pages.get(this._OVERVIEW_KEY);
    if (!p) return; // defensive only — unreachable via the UI, since the toggle button that calls this lives on the overview page itself

    p.splitToggle.classList.toggle('active', on);
    p.splitToggle.title = on ? 'Combine into one chart' : 'Split into separate charts';
    p.splitToggle.setAttribute('aria-label', p.splitToggle.title);
    // Icon mirrors the action the next click performs, not the current
    // state: 4 squares (split up) while combined, 1 square (merge back)
    // while split — same "icon shows what happens next" convention as the
    // play/pause button.
    p.splitToggle.querySelector('use')?.setAttribute('href', on ? '#icon-square' : '#icon-grid');

    if (on) {
      this._rebuildSplitEngines(p);
      p.canvas.classList.add('hidden');
      p.splitGrid.classList.remove('hidden');
    } else {
      this._teardownSplitEngines(p);
      p.splitGrid.classList.add('hidden');
      p.canvas.classList.remove('hidden');
    }
    this._syncSplitToggleOffset(p);
    // The metric set itself doesn't change when this toggle flips — only
    // how it's drawn — so the host gets the same defs list either way; see
    // onSplitChange's doc.
    this._onSplitChange(on, p.overviewDefs.slice(0, OVERVIEW_SPLIT_MAX));
  }

  /** Keeps the split-toggle button's horizontal offset in sync with how
   *  wide the top-left split-cell's own Y-axis tick-label gutter
   *  currently is (see ChartEngine#measureLeftPad(): a worst-case width, the
   *  same for every metric), so a label never ends up underneath the
   *  button sitting in that same corner. The +8 mirrors
   *  the 6px gap _drawGrid() leaves between a label's right edge and the
   *  gridline plus a couple px of breathing room. Falls back to the CSS
   *  default (left: 14px, see .chart-split-toggle) whenever split view
   *  is off — the combined/overlaid chart draws no tick labels at all,
   *  so there's nothing there to clear. */
  _syncSplitToggleOffset(p) {
    if (!p.splitToggle) return;   // follow mode builds no toggle
    const firstEngine = p.splitEngines?.[0]?.engine;
    p.splitToggle.style.left = (this._overviewSplit && firstEngine)
      ? `${firstEngine.measureLeftPad() + 8}px`
      : '';
  }

  /** (Re)build the split grid's mini charts from `p.overviewDefs`, capped
   *  to the first OVERVIEW_SPLIT_MAX metrics. Tears down any previous set
   *  first, so this is also what keeps an already-open split view in sync
   *  when the available metrics change (see _buildOrUpdateOverviewPage()). */
  _rebuildSplitEngines(p) {
    this._teardownSplitEngines(p);
    const defs = p.overviewDefs.slice(0, OVERVIEW_SPLIT_MAX);

    p.splitGrid.innerHTML = '';
    p.splitGrid.className = `chart-split-grid chart-split-grid-${defs.length}`;

    p.splitEngines = defs.map(def => {
      const cell = document.createElement('div');
      cell.className = 'chart-split-cell';

      const canvas = document.createElement('canvas');
      canvas.className = 'live-chart';
      cell.appendChild(canvas);

      // Crosshair value readout — hidden until a held press on this cell (see
      // _beginSplitScrub() below) puts a reading in it via
      // _updateSplitReadout(). Reuses the exact .metric-value/.metric-label
      // markup the live current/average/peak row uses below the main
      // chart, so a pinned value here reads exactly like it would there.
      const readout = document.createElement('div');
      readout.className = 'chart-split-readout hidden';
      readout.innerHTML = '<span class="metric-value"></span><span class="metric-label"></span>';
      cell.appendChild(readout);

      p.splitGrid.appendChild(cell);

      const engine = new ChartEngine(canvas, {
        mode: this._mode,
        windowSec: this._windowSec,
        singleMetric: true,
        bgAlpha: this._chartBgAlpha,
        // The DOM readout above replaces the built-in canvas value chip —
        // showing both at once would be redundant. The guide line + dot
        // still draw normally.
        showCrosshairChip: false,
        onCrosshairChange: (readouts) => this._updateSplitReadout(readout, readouts),
      });
      engine.addSeries(def.key, {
        color: def.color, label: def.label, yMin: def.yMin, yMax: def.yMax,
        transform: def.transform, unit: def.unit, fmt: def.fmt,
      });
      if (this._samples.length) engine.setData(this._samples, this._laps);
      if (this._workoutMarks.length) engine.setWorkoutMarks(this._workoutMarks);

      // No handlers on the cell itself: the press-and-hold that starts a scrub is
      // read by the track (see _bindSwipeGestures()), which finds the held cell
      // through the `cell`/`canvas` kept here (see _beginSplitScrub()).
      return { key: def.key, engine, cell, canvas };
    });
  }

  /** Push a split-cell mini chart's crosshair reading into its DOM value
   *  chip (see _rebuildSplitEngines() above) — `readouts` is whatever
   *  ChartEngine's onCrosshairChange handed back: null while there's
   *  nothing to show, otherwise the same per-series array its built-in
   *  chip would have drawn from, which for a singleMetric engine is
   *  always exactly one entry. */
  _updateSplitReadout(el, readouts) {
    const r = readouts?.[0];
    if (!r) { el.classList.add('hidden'); return; }
    const valueEl = el.querySelector('.metric-value');
    valueEl.textContent = r.text;
    valueEl.style.color = r.color;
    el.querySelector('.metric-label').textContent = r.label;
    el.classList.remove('hidden');
  }

  /** Press-and-hold scrub on the split grid. Same gesture as a single chart's
   *  focus-lock (LONG_PRESS_MS, LONG_PRESS_MOVE_TOLERANCE_PX): a quick touch,
   *  tap or drag on a cell does nothing here — it stays an ordinary swipe
   *  between pages — and only a held press pins every quadrant's value at
   *  once (shown via _updateSplitReadout() on each cell) plus the shared time
   *  marker (see _updateSplitTimeMarker()). Dragging while still held then
   *  moves them all together; releasing hides them again (_endSplitScrub()).
   *
   *  Armed by _bindSwipeGestures()' own press timer rather than a timer of its
   *  own, so there is one long-press per press, and it is never the page-level
   *  focus-lock either: that stays inert while split view is open (see
   *  _engageLock()), since there's no single *pixel* position that means
   *  anything across four independently laid-out charts. There is a single
   *  *instant* though — resolved from the held cell via its own
   *  canvasXToSec(), then applied to every quadrant by time by
   *  _setSplitCrosshairAtSec() below — so all four always show the reading
   *  each metric had at that one moment, not just the held chart's own.
   *
   *  `x`/`y` are the client-space position of the hold. Returns false (and does
   *  nothing) unless the overview page is the active one with split view open
   *  and the hold is on one of its cells. */
  _beginSplitScrub(x, y) {
    const p = this._pages.get(this._activeKey);
    if (!p || this._activeKey !== this._OVERVIEW_KEY || !this._overviewSplit || !p.splitEngines?.length) return false;
    const hit = p.splitEngines.find(({ cell }) => {
      const r = cell.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (!hit) return false;
    this._splitScrub = { p, ...hit };
    navigator.vibrate?.(12); // same single tick a single chart's focus-lock gives
    // Show every quadrant's reading at the hold point right away, rather than
    // leaving the press with no feedback until the first pixel of movement.
    this._moveSplitScrub(x);
    return true;
  }

  /** Move the held split scrub to a client-space X (see _beginSplitScrub()). */
  _moveSplitScrub(clientX) {
    const sc = this._splitScrub;
    if (!sc) return;
    if (!sc.cell.isConnected) { this._endSplitScrub(); return; } // cell torn down mid-scrub (split closed) — defensive only
    const rect = sc.canvas.getBoundingClientRect();
    const sec  = sc.engine.canvasXToSec(clientX - rect.left);
    if (sec === null) return; // this cell hasn't rendered geometry yet — defensive only
    this._setSplitCrosshairAtSec(sc.p, sec, sc.engine, sc.canvas);
  }

  /** Release the held split scrub: hides every quadrant's crosshair and the shared
   *  time marker together, so a stale reading never outlives the press. */
  _endSplitScrub() {
    const sc = this._splitScrub;
    if (!sc) return;
    this._splitScrub = null;
    this._hideSplitCrosshair(sc.p);
  }

  /** Move every split-grid mini chart's crosshair to the sample nearest
   *  `sec` at once, and update the shared time marker to match — the
   *  cross-quadrant sync at the heart of _beginSplitScrub() above.
   *  Each engine resolves its own nearest sample independently (they all
   *  share the same underlying `_samples`, kept in sync via push()/
   *  setData() — see _enginesFor()), so this reads as one crosshair
   *  moving across four charts rather than four separately-driven ones.
   *  `sourceEngine`/`sourceCanvas` are the touched cell's own — passed
   *  through to _updateSplitTimeMarker() so the marker can position
   *  itself against that specific chart's real, already-rendered axis
   *  geometry rather than an approximation shared across all four. */
  _setSplitCrosshairAtSec(p, sec, sourceEngine, sourceCanvas) {
    if (!p.splitEngines) return;
    for (const { engine } of p.splitEngines) engine.setCrosshairAtSec(sec);
    this._updateSplitTimeMarker(p, sec, sourceEngine, sourceCanvas);
  }

  /** Hide every split-grid mini chart's crosshair together with the shared
   *  time marker — called on drag release so a stale reading never
   *  outlives the gesture that produced it. */
  _hideSplitCrosshair(p) {
    if (!p.splitEngines) return;
    for (const { engine } of p.splitEngines) engine.hideCrosshair();
    this._hideSplitTimeMarker(p);
  }

  /** Shows/updates the shared time marker giving the precise elapsed time
   *  a crosshair currently represents. Originally just the split grid's
   *  "which instant am I looking at" readout — a 2x2 grid of independent
   *  mini charts otherwise has no single place for it, since each cell's
   *  own value chip is pinned to that cell's corner, not to a shared time
   *  axis (called from _setSplitCrosshairAtSec() there, `engine`/`canvas`
   *  being whichever cell the gesture actually started on). Also called
   *  from _updateCrosshairAt() for the overview page's own combined/
   *  overlaid crosshair (split view closed) — that page's single value
   *  chip is pinned to the top-right corner rather than tracking the
   *  crosshair (see ChartEngine's crosshairChipAnchor doc), so its elapsed
   *  time needs the same floating treatment; `engine`/`canvas` there are
   *  just that page's own single engine/canvas. Either way, positioned to
   *  sit directly over the given chart's own time-axis row, at the exact x
   *  its vertical guide line is drawn at (see ChartEngine's
   *  getPlotRect()/crosshairCanvasX()) — so it reads as an annotation on
   *  that chart's real, fixed axis increments rather than a badge floating
   *  free of it. In the split-grid case the other three quadrants' own
   *  axes can sit a few px off from this (a split cell's own size
   *  differs, though its left-axis gutter is the same worst-case width — see
   *  ChartEngine#_measureLeftPad()), which is why that caller
   *  anchors to the touched chart specifically instead of averaging
   *  across all four. */
  _updateSplitTimeMarker(p, sec, engine, canvas) {
    p.splitTimeMarker.textContent = formatElapsed(sec);

    const plot = engine.getPlotRect();
    const x    = engine.crosshairCanvasX();
    if (plot && x !== null) {
      const canvasRect = canvas.getBoundingClientRect();
      const pageRect   = p.page.getBoundingClientRect();
      p.splitTimeMarker.style.left = `${canvasRect.left - pageRect.left + x}px`;
      p.splitTimeMarker.style.top  = `${canvasRect.top  - pageRect.top  + plot.axisY - TIME_MARKER_Y_NUDGE}px`;
    }

    p.splitTimeMarker.classList.remove('hidden');
  }

  /** Hide the shared time marker — see _hideSplitCrosshair() above and
   *  _teardownSplitEngines() below (split view closing mid-scrub). */
  _hideSplitTimeMarker(p) {
    p.splitTimeMarker.classList.add('hidden');
  }

  /** Destroy the split grid's mini charts, if any are currently built —
   *  a harmless no-op for any page that never had a split view (i.e.
   *  every page except the overview page). */
  _teardownSplitEngines(p) {
    if (!p.splitEngines) return;
    if (this._splitScrub?.p === p) this._splitScrub = null; // split view closed mid-scrub
    for (const { engine } of p.splitEngines) engine.destroy();
    p.splitEngines = null;
    this._hideSplitTimeMarker(p); // in case split view closes mid-scrub
  }

  /** Every ChartEngine currently live for page `p` — normally just its own
   *  `engine`, plus that page's split mini-charts too while they're built
   *  (see _rebuildSplitEngines()), so push()/setData()/etc. below keep the
   *  combined chart's data current in the background even while its canvas
   *  is hidden behind the split grid, and it's instantly up to date again
   *  the moment split view closes. */
  _enginesFor(p) {
    return p.splitEngines ? [p.engine, ...p.splitEngines.map(s => s.engine)] : [p.engine];
  }

  _insertPageAt(def, index) {
    const page = document.createElement('div');
    page.className = 'chart-page';
    page.dataset.metric = def.key;

    const canvas = document.createElement('canvas');
    canvas.className = 'live-chart';
    page.appendChild(canvas);

    const refKey  = this._order[index];
    const refPage = refKey ? this._pages.get(refKey)?.page : null;
    this._track.insertBefore(page, refPage ?? null);

    const engine = new ChartEngine(canvas, {
      mode: this._mode,
      windowSec: this._windowSec,
      singleMetric: true,
      bgAlpha: this._chartBgAlpha,
    });
    engine.addSeries(def.key, {
      color: def.color, label: def.label, yMin: def.yMin, yMax: def.yMax,
      transform: def.transform, unit: def.unit, fmt: def.fmt,
    });
    if (this._samples.length) engine.setData(this._samples, this._laps);
    if (this._workoutMarks.length) engine.setWorkoutMarks(this._workoutMarks);

    this._pages.set(def.key, { def, page, canvas, engine });
    this._order.splice(index, 0, def.key);
  }

  /**
   * Update an already-built page's series config in place (color/label/axis/
   * transform) — e.g. when the Settings units toggle changes how the Speed
   * page should scale/label without rebuilding the page or losing scroll
   * position. No-op if that metric isn't currently a page.
   * @param {{key,label,color,yMin,yMax,transform}} def
   */
  updateMetricDef(def) {
    const p = this._pages.get(def.key);
    if (!p) return;
    p.def = def;
    p.engine.addSeries(def.key, {
      color: def.color, label: def.label, yMin: def.yMin, yMax: def.yMax,
      transform: def.transform, unit: def.unit, fmt: def.fmt,
    });
    p.engine.refresh();
    this._rebuildDots();
    // The lock glow's color follows the page's own metric color (see
    // _engageLock()) — keep it in sync if that color just changed too.
    if (this._locked && def.key === this._activeKey) {
      p.page.style.setProperty('--lock-color', def.color);
    }
  }

  _removePage(key) {
    const p = this._pages.get(key);
    if (!p) return;
    // Don't leave the carousel permanently frozen/locked-out if the page
    // someone's focused on disappears out from under them (e.g. a sensor
    // that just unpaired).
    if (this._locked && key === this._activeKey) this._disengageLock();
    // The overview page disappearing (e.g. capabilities drop to <=1 metric)
    // while its split grid was open leaves nothing for it to reflect — tell
    // the host so it can clear its own per-metric readout. this._overviewSplit
    // itself is deliberately left alone: it's a standing preference, and
    // _buildOrUpdateOverviewPage() re-fires onSplitChange(true, ...) on its
    // own if/when the overview page comes back with it still set.
    if (p.splitEngines) this._onSplitChange(false, []);
    this._teardownSplitEngines(p); // no-op for any page that never had a split view
    p.engine.destroy();
    p.page.remove(); // lockExitEl/splitToggle/splitGrid are children of page — removed along with it
    this._pages.delete(key);
    this._order = this._order.filter(k => k !== key);
  }

  // ─── Data ─────────────────────────────────────────────────────────────────

  /** Forward one live sample to every page's chart(s). */
  push(sample) {
    this._samples.push(sample);
    for (const p of this._pages.values()) {
      for (const engine of this._enginesFor(p)) engine.push(sample);
    }
    // A live value crossing a digit boundary (e.g. power 98 -> 102) widens
    // that split cell's tick labels mid-ride, so re-check the toggle's
    // offset on every sample rather than only when the split grid itself
    // is (re)built.
    this._syncSplitToggleOffsetIfOverview();
  }

  /** Reset/replace the full sample buffer (new session, or session load). */
  setData(samples, laps = []) {
    this._samples = samples;
    this._laps    = laps;
    for (const p of this._pages.values()) {
      for (const engine of this._enginesFor(p)) engine.setData(samples, laps);
    }
    this._syncSplitToggleOffsetIfOverview();
  }

  /** push()/setData() convenience — looks up the overview page (if it
   *  exists yet) and resyncs its split-toggle offset. A no-op whenever
   *  split view is off, since _syncSplitToggleOffset() itself bails out
   *  to the CSS default in that case. */
  _syncSplitToggleOffsetIfOverview() {
    const p = this._pages.get(this._OVERVIEW_KEY);
    if (p) this._syncSplitToggleOffset(p);
  }

  setLaps(laps) {
    this._laps = laps;
    for (const p of this._pages.values()) {
      for (const engine of this._enginesFor(p)) engine.setLaps(laps);
    }
  }

  /** Forward scripted-workout progress markers (step completions + the
   *  workout-complete marker) to every page's chart(s) — same shape of
   *  call as setLaps() above, just a separate marker set (see
   *  ChartEngine#setWorkoutMarks()). */
  setWorkoutMarks(marks) {
    this._workoutMarks = marks;
    for (const p of this._pages.values()) {
      for (const engine of this._enginesFor(p)) engine.setWorkoutMarks(marks);
    }
  }

  snapToLive() {
    for (const p of this._pages.values()) {
      for (const engine of this._enginesFor(p)) engine.snapToLive();
    }
  }

  setWindow(sec) {
    this._windowSec = sec;
    for (const p of this._pages.values()) {
      for (const engine of this._enginesFor(p)) engine.setWindow(sec);
    }
  }

  // ─── Active page ────────────────────────────────────────────────────────

  /**
   * Click-and-drag / touch-swipe between pages, advancing as soon as the
   * drag clears SWIPE_THRESHOLD_FRACTION of the track's width (currently
   * 1/8) rather than needing to drag (close to) a full page — see that
   * constant above. Below the threshold, releasing snaps back to the page
   * the gesture started on.
   *
   * Touch is handled here explicitly rather than left to the track's
   * native `overflow-x:auto` + scroll-snap (see the CSS): native scroll-
   * snap has no way to configure how far a drag needs to travel before it
   * commits to the next page — that threshold is an unexposed browser/
   * engine heuristic, not a CSS property — so getting an exact, tunable
   * fraction like 1/8 means fully overriding native touch scrolling
   * instead of relying on it. Trade-off worth knowing: this gives up the
   * native momentum/rubber-band feel during the drag itself in exchange
   * for an exact, consistent threshold on both touch and mouse.
   *
   * Touch axis-locking: a touch gesture doesn't commit to being a
   * horizontal swipe (and start overriding scroll) until it's moved more
   * than AXIS_LOCK_PX predominantly sideways — if it turns out to be
   * mostly vertical instead, this backs off entirely (native page scroll,
   * if any, proceeds untouched). Mouse doesn't need this: a mousedown
   * inside the chart area is unambiguous.
   *
   * Commits on EITHER distance (SWIPE_THRESHOLD_FRACTION) OR release
   * velocity (FLICK_VELOCITY_PX_MS), matching native swipe: a fast short
   * flick advances a page even if it barely crossed the distance
   * threshold, the same way it does on a native scroll view. Velocity is
   * measured from the single most recent move sample before release, not
   * an average over the whole gesture — a gesture that drifted slowly and
   * then flicked at the very end should register as a flick, and a fast
   * start that decelerates into a slow stop shouldn't.
   */
  _bindSwipeGestures() {
    const track = this._track;
    const AXIS_LOCK_PX = 6; // touch-only — see docstring

    let mode = null;          // 'mouse' | 'touch' | 'pinch' | null (no gesture in progress)
    let axisLocked = null;    // touch only: null (undecided) | 'x' | 'y'
    // Two-finger pan/pinch-zoom on the engaged (locked) chart — see the
    // touchstart/touchmove handlers below. Distance and midpoint (both in
    // client px) of the two touches as of the last move sample.
    let pinchDist = null, pinchMidX = null;
    let startX = 0, startY = 0, lastX = 0;
    let prevX = 0, prevT = 0, lastT = 0; // for release-velocity — see docstring
    let startScrollLeft = 0;
    let startIndex = 0;

    // Long-press state — layered on top of the swipe tracking above rather
    // than replacing it, so an ordinary swipe's begin()/recordMove()/
    // finish() path is untouched by any of this. Armed on every press;
    // cancelled the moment the pointer moves past
    // LONG_PRESS_MOVE_TOLERANCE_PX (that's an ordinary swipe or, while
    // locked, a crosshair scrub) or on release. See _engageLock()/
    // _disengageLock() below for what firing actually does.
    let pressTimer = null;

    const clearPressTimer = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };

    const armPressTimer = () => {
      clearPressTimer();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (this._locked) { this._disengageLock(); return; }
        // Quad (split) view: the hold scrubs all four charts instead of
        // focus-locking one — see _beginSplitScrub().
        if (this._beginSplitScrub(lastX, startY)) {
          // The hold has become a scrub, so undo any few pixels of page drag the
          // press picked up inside the tolerance and let the track re-snap.
          track.scrollLeft = startScrollLeft;
          track.classList.remove('dragging');
          return;
        }
        this._engageLock(this._activeKey);
        // Place the crosshair immediately at wherever the hold is sitting,
        // rather than leaving the glow up with no readout until the first
        // pixel of subsequent movement.
        if (this._locked) this._updateCrosshairAt(lastX);
      }, LONG_PRESS_MS);
    };

    const movedPastTolerance = (x, y) =>
      Math.abs(x - startX) > LONG_PRESS_MOVE_TOLERANCE_PX ||
      Math.abs(y - startY) > LONG_PRESS_MOVE_TOLERANCE_PX;

    const begin = (x, y) => {
      startX = lastX = prevX = x;
      startY = y;
      lastT = prevT = performance.now();
      startScrollLeft = track.scrollLeft;
      startIndex = Math.max(0, this._order.indexOf(this._activeKey));
    };

    /** Records one move sample for both position and release-velocity tracking. */
    const recordMove = (x) => {
      prevX = lastX;
      prevT = lastT;
      lastX = x;
      lastT = performance.now();
    };

    /** -1/0/1: does `value` clear `threshold` in either direction? Shared by the distance and velocity checks below. */
    const commitDirection = (value, threshold) => {
      if (value <= -threshold) return 1;  // dragged/flicked left -> advance to next page
      if (value >= threshold) return -1;  // dragged/flicked right -> back to previous page
      return 0;
    };

    const finish = () => {
      const w = track.clientWidth || 1;
      const dx = lastX - startX; // negative = dragged left = advance to next page
      const dt = lastT - prevT;
      const velocity = dt > 0 ? (lastX - prevX) / dt : 0; // px/ms, same sign convention as dx

      const direction = commitDirection(dx, w * SWIPE_THRESHOLD_FRACTION)
        || commitDirection(velocity, FLICK_VELOCITY_PX_MS);

      const targetIndex = Math.max(0, Math.min(this._order.length - 1, startIndex + direction));
      const key = this._order[targetIndex];
      if (key) this.goTo(key); // also correctly "snaps back" when targetIndex === startIndex
    };

    /**
     * Ends a drag that should hand off to finish()'s own smooth scrollTo.
     * Deliberately does NOT remove 'dragging' up front: that class is what
     * holds `scroll-snap-type: none` on .chart-track (see style.css), and
     * removing it before finish()'s scrollTo has landed re-enables
     * `scroll-snap-type: x mandatory` while scrollLeft is still sitting
     * mid-drag — the browser then runs its own instant snap-correction
     * (almost always back to the page the drag started from, since a
     * partial drag rarely crosses a full page width) a frame before
     * finish()'s smooth scroll gets going, producing a visible snap-back-
     * then-transition double motion. Keeping 'dragging' (and so
     * scroll-snap-type: none) applied through the whole animated
     * transition, and only lifting it once scrollend confirms the track
     * has actually arrived, means CSS snap has nothing to "correct" by the
     * time it's re-enabled — the JS-driven scroll already lands exactly on
     * a valid snap-aligned page position.
     */
    const releaseDrag = () => {
      finish();
      track.addEventListener('scrollend', () => track.classList.remove('dragging'), { once: true });
    };

    // Mouse
    track.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // primary button only
      mode = 'mouse';
      begin(e.clientX, e.clientY);
      armPressTimer();
      if (this._locked) this._updateCrosshairAt(e.clientX);
      else track.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (mode !== 'mouse') return;
      if (pressTimer && movedPastTolerance(e.clientX, e.clientY)) clearPressTimer();
      if (this._splitScrub) { this._moveSplitScrub(e.clientX); return; }
      if (this._locked) { this._updateCrosshairAt(e.clientX); return; }
      recordMove(e.clientX);
      track.scrollLeft = startScrollLeft - (lastX - startX);
    });
    window.addEventListener('mouseup', () => {
      if (mode !== 'mouse') return;
      mode = null;
      clearPressTimer();
      if (this._splitScrub) { this._endSplitScrub(); return; } // held scrub just ends — no page-commit
      if (this._locked) return; // crosshair drag just ends — no page-commit while locked
      releaseDrag();
    });

    // Middle-click hold + drag pans the engaged (focus-locked) chart's
    // time window. A separate button from the primary-button crosshair
    // scrub above, so the two gestures never fight over the same drag —
    // and it only does anything once a page is actually locked, since
    // panning an unlocked, swipeable page isn't a meaningful action.
    let midPanX = null;
    track.addEventListener('mousedown', (e) => {
      if (e.button !== 1 || !this._locked) return;
      e.preventDefault(); // stop the browser's native middle-click autoscroll
      midPanX = e.clientX;
    });
    window.addEventListener('mousemove', (e) => {
      if (midPanX === null) return;
      const dx = midPanX - e.clientX;
      midPanX = e.clientX;
      this._pages.get(this._activeKey)?.engine.panByPixels(dx);
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 1) midPanX = null; });

    // Scroll wheel zooms the engaged chart, anchored on whatever's under
    // the cursor — same gate as the middle-click pan above.
    track.addEventListener('wheel', (e) => {
      if (!this._locked) return;
      const p = this._pages.get(this._activeKey);
      if (!p) return;
      e.preventDefault();
      const rect = p.canvas.getBoundingClientRect();
      const factor = e.deltaY > 0 ? 1.2 : 0.8;
      p.engine.zoomAt(factor, e.clientX - rect.left);
    }, { passive: false });

    // Touch — see the axis-locking note in the docstring above.
    track.addEventListener('touchstart', (e) => {
      // A second finger landing on an engaged (locked) chart hands off
      // from single-finger crosshair-scrub to two-finger pan/pinch-zoom
      // for as long as it stays down — this is the touch equivalent of
      // the desktop middle-click-drag/wheel above, kept on a separate
      // finger-count so it never fights the scrub gesture over the same
      // touch.
      if (this._locked && e.touches.length >= 2) {
        mode = 'pinch';
        clearPressTimer();
        const [t0, t1] = e.touches;
        pinchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        pinchMidX = (t0.clientX + t1.clientX) / 2;
        return;
      }
      mode = 'touch';
      // Locked: skip axis-guessing entirely — every move is a crosshair
      // scrub, horizontal or not, so there's no ambiguous direction to
      // resolve the way an ordinary swipe-vs-scroll gesture has.
      axisLocked = this._locked ? 'x' : null;
      const t = e.touches[0];
      begin(t.clientX, t.clientY);
      armPressTimer();
      if (this._locked) this._updateCrosshairAt(t.clientX);
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
      if (mode === 'pinch') {
        if (!this._locked || e.touches.length < 2 || pinchDist === null) return;
        e.preventDefault();
        const p = this._pages.get(this._activeKey);
        const [t0, t1] = e.touches;
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const midX = (t0.clientX + t1.clientX) / 2;
        if (p) {
          const rect = p.canvas.getBoundingClientRect();
          p.engine.zoomAt(pinchDist / dist, midX - rect.left);
          p.engine.panByPixels(pinchMidX - midX);
        }
        pinchDist = dist;
        pinchMidX = midX;
        return;
      }

      if (mode !== 'touch') return;
      const t = e.touches[0];
      if (pressTimer && movedPastTolerance(t.clientX, t.clientY)) clearPressTimer();

      if (this._splitScrub) {
        e.preventDefault(); // held scrub on the quad view — never hand this off to native page scroll
        this._moveSplitScrub(t.clientX);
        return;
      }

      if (this._locked) {
        e.preventDefault(); // scrubbing — never hand this off to native page scroll
        this._updateCrosshairAt(t.clientX);
        return;
      }

      if (axisLocked === null) {
        const dx = Math.abs(t.clientX - startX);
        const dy = Math.abs(t.clientY - startY);
        if (dx < AXIS_LOCK_PX && dy < AXIS_LOCK_PX) return; // not enough movement to decide yet
        axisLocked = dx > dy ? 'x' : 'y';
        // Vertical — hand back to native page scroll untouched, and this
        // was never a long-press to begin with (a real hold doesn't drift
        // 6px vertically before the timer even fires).
        if (axisLocked === 'y') { mode = null; clearPressTimer(); return; }
        track.classList.add('dragging');
      }

      e.preventDefault(); // committed to horizontal — stop native scroll from double-applying
      recordMove(t.clientX);
      track.scrollLeft = startScrollLeft - (lastX - startX);
    }, { passive: false }); // must be non-passive so preventDefault() above can take effect

    track.addEventListener('touchend', (e) => {
      if (mode === 'pinch') {
        // Wait for every finger to lift rather than falling back to
        // single-finger scrub mid-gesture — resuming scrub here would
        // otherwise read the remaining finger's position as a sudden
        // crosshair jump.
        if (e.touches.length < 2) { mode = null; pinchDist = pinchMidX = null; }
        return;
      }
      if (mode !== 'touch') return;
      mode = null;
      clearPressTimer();
      if (this._splitScrub) { this._endSplitScrub(); return; } // held scrub just ends — no page-commit
      if (this._locked) return; // crosshair drag just ends — no page-commit while locked
      // Same ordering fix as mouseup's releaseDrag() above — only relevant
      // when the gesture actually committed to a horizontal swipe (and so
      // called finish()); an axis-locked-vertical release never touched
      // 'dragging' in the first place (see touchmove), so there's nothing
      // to hold open here for that case.
      if (axisLocked === 'x') releaseDrag();
      else track.classList.remove('dragging');
    });
    track.addEventListener('touchcancel', () => {
      mode = null;
      pinchDist = pinchMidX = null;
      clearPressTimer();
      this._endSplitScrub();
      track.classList.remove('dragging');
    });
  }

  // ─── Focus lock (long-press to explore one chart) ────────────────────────
  //
  // See the class doc above for the full gesture map. This is layered
  // entirely on top of the swipe/scrub plumbing in _bindSwipeGestures() and
  // ChartEngine's own freeze()/setCrosshair()/hideCrosshair() — engaging or
  // disengaging just flips _locked and dresses the page accordingly; the
  // pointer-handling changes are what actually reads as "locked."

  /** Engage focus-lock on `key`'s page: suspends swipe-to-switch, freezes
   *  that page's live auto-scroll (so it isn't scrolling out from under a
   *  mid-read crosshair), and shows the border glow + exit chip. No-op if
   *  already locked, `key` isn't a real page (e.g. called before the first
   *  page has built), or `key` is the overview page with its split view
   *  open — there's no single crosshair position that means anything
   *  across four independent mini charts, so the page-level lock stays
   *  inert there until split view closes again (the same long press scrubs
   *  the quadrants instead — see _beginSplitScrub()). */
  _engageLock(key) {
    const p = key && this._pages.get(key);
    if (!p || this._locked || (key === this._OVERVIEW_KEY && this._overviewSplit)) return;
    this._locked = true;
    this._track.classList.remove('dragging'); // no page-drag while locked, whatever gesture led in here
    p.page.classList.add('locked');
    p.page.style.setProperty('--lock-color', p.def.color);
    p.engine.freeze();
    navigator.vibrate?.(12); // one short tick — the only feedback a press-and-hold otherwise gets before the glow renders

    const exit = document.createElement('button');
    exit.type = 'button';
    exit.className = 'chart-lock-exit';
    exit.setAttribute('aria-label', 'Exit chart focus');
    exit.innerHTML = '<svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg>';
    // Stop the tap from also reaching the track's own mousedown/touchstart
    // (they bubble from any child, including this button) — otherwise
    // pressing "exit" would first jump the crosshair to that corner.
    const stopPointer = (e) => e.stopPropagation();
    exit.addEventListener('mousedown', stopPointer);
    exit.addEventListener('touchstart', stopPointer, { passive: true });
    exit.addEventListener('click', (e) => { stopPointer(e); this._disengageLock(); });
    p.page.appendChild(exit);
    this._lockExitEl = exit;

    document.addEventListener('keydown', this._onLockKeydown);
  }

  /** Release focus-lock — via a second long-press, the exit chip, Escape
   *  (all three route here through _onLockKeydown/pressTimer above), or
   *  picking a different page from the dots (goTo() calls this directly).
   *  Resumes live auto-scroll and clears the crosshair so the page comes
   *  back to being a normal swipeable carousel page. */
  _disengageLock() {
    if (!this._locked) return;
    this._locked = false;
    const p = this._pages.get(this._activeKey);
    if (p) {
      p.page.classList.remove('locked');
      p.page.style.removeProperty('--lock-color');
      p.engine.unfreeze();
      p.engine.hideCrosshair();
      if (this._activeKey === this._OVERVIEW_KEY) this._hideSplitTimeMarker(p);
    }
    navigator.vibrate?.(8);
    this._lockExitEl?.remove();
    this._lockExitEl = null;
    document.removeEventListener('keydown', this._onLockKeydown);
  }

  /** Move the active (locked) page's crosshair to a client-space X —
   *  shared by the mouse and touch handlers in _bindSwipeGestures(). On
   *  the overview page's combined (overlaid, non-split) view, this also
   *  drives the same shared time marker the split grid uses (see
   *  _updateSplitTimeMarker()), so its elapsed-time readout hovers along
   *  the time axis at the crosshair's x instead of the corner chip drawing
   *  its own fixed elapsed-time line (see ChartEngine's
   *  _drawCrosshairChipFixed()). */
  _updateCrosshairAt(clientX) {
    const p = this._pages.get(this._activeKey);
    if (!p) return;
    const rect = p.canvas.getBoundingClientRect();
    const canvasX = clientX - rect.left;
    p.engine.setCrosshair(canvasX);
    if (this._activeKey === this._OVERVIEW_KEY && !this._overviewSplit && !this._followHero) {
      const sec = p.engine.canvasXToSec(canvasX);
      if (sec !== null) this._updateSplitTimeMarker(p, sec, p.engine, p.canvas);
    }
  }

  get activeKey() { return this._activeKey; }

  /** Every page's key, left to right — the All page first when there is one. A copy. */
  get pageKeys() { return [...this._order]; }

  /** Swipe to a specific metric's page (used by dot clicks). Picking a page
   *  — even re-picking the current one — always releases any focus-lock,
   *  since it's a deliberate "take me elsewhere" action. */
  goTo(key) {
    const idx = this._order.indexOf(key);
    const w   = this._track.clientWidth;
    if (idx < 0 || !w) return;
    if (this._locked) this._disengageLock();
    this._track.scrollTo({ left: idx * w, behavior: 'smooth' });
  }

  _onScroll() {
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = null;
      // Never re-derive the active page from scroll position while
      // focus-locked — the track doesn't move on its own while locked (see
      // _bindSwipeGestures()), so a scroll event here can only be a stray.
      if (this._locked) return;
      const w = this._track.clientWidth || 1;
      const idx = Math.round(this._track.scrollLeft / w);
      const key = this._order[idx];
      if (key && key !== this._activeKey) this._setActive(key, false);
    });
  }

  /** Re-align scroll position to the active page after a resize. */
  _resnap() {
    if (!this._activeKey) return;
    const idx = this._order.indexOf(this._activeKey);
    const w   = this._track.clientWidth;
    if (idx >= 0 && w) this._track.scrollLeft = idx * w;
  }

  _setActive(key, jump) {
    if (this._activeKey === key) return;
    this._activeKey = key;
    this._rebuildDots();
    if (jump && key) {
      const idx = this._order.indexOf(key);
      const w   = this._track.clientWidth;
      if (idx >= 0 && w) this._track.scrollLeft = idx * w;
    }
    this._onActiveMetric(key);
  }

  _rebuildDots() {
    this._dots.innerHTML = '';
    this._dots.classList.toggle('hidden', this._order.length <= 1);
    for (const key of this._order) {
      const def = this._pages.get(key).def;
      const dot = document.createElement('button');
      dot.type  = 'button';
      dot.className = 'chart-dot' + (key === this._activeKey ? ' active' : '');
      dot.style.setProperty('--dot-color', def.color);
      dot.title = def.label;
      dot.setAttribute('aria-label', `Show ${def.label} chart`);
      dot.addEventListener('click', () => this.goTo(key));
      this._dots.appendChild(dot);
    }
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────

  destroy() {
    this._resizeObserver.disconnect();
    for (const key of [...this._order]) this._removePage(key);
  }
}

export default ChartCarousel;