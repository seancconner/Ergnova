// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * views/history-browser.js
 *
 * Workout history list. Renders into a container element: sessions are poster
 * tiles grouped by calendar week, and tapping one opens the shared detail sheet
 * (ui/detail-sheet.js) — the chart as the hero, the stat tiles below it, then the
 * laps, with Download and Delete in the sheet's header — rather than expanding
 * the tile in place or navigating to a separate screen.
 *
 * Uses ChartCarousel (one metric per swipeable page, plus a leading "All"
 * overview page overlaying every metric with a color-coded Y-axis legend)
 * to render the session's chart.
 *
 * Usage:
 *   import { HistoryBrowser } from './views/history-browser.js';
 *   const browser = new HistoryBrowser(document.getElementById('history-panel'));
 *   await browser.load();  // fetches sessions from IndexedDB
 */

import { db } from '../storage/db.js';
import { ChartCarousel } from '../charts/chart-carousel.js';
import { sortMetricDefs } from '../charts/chart-order.js';
import { CHART_COLORS } from '../charts/chart-engine.js';
import { formatDistance, formatDistanceValue, distanceUnitLabel, kmhToDisplaySpeed, speedUnitLabel, avgSpeedKmh } from '../metrics/units.js';
import { attachDownloadMenu, closeDownloadMenu } from '../recording/activity-formats.js';
import { fitText } from '../ux/fit-text.js';
import { saveFile } from '../platform/save-file.js';
import { pickTextFile } from '../platform/pick-file.js';
import {
  buildHistoryArchive, parseHistoryArchive, planSessionImport, importSummary, importErrorMessage,
} from '../recording/history-archive.js';
import { MasterDetailRail } from '../ui/master-detail.js';
import { detailSheet } from '../ui/detail-sheet.js';
import { groupByWeek, weekTotalsText, emptyStateContent } from './history-layout.js';
import { posterTileBody } from './session-poster.js';

// ── History rail categories ──────────────────
// A session's own meta already carries everything needed to place it: a
// strength session's meta.type is 'strength' (see core/strength-model.js's
// header comment), and any of the four fitness tests (FTP ramp/20-minute,
// VO2 Max, Resting HR — see metrics/ftp-test.js, vo2max.js, hr-test.js) tags
// meta.testType with its own TEST_TYPE constant. Nothing else ever sets
// testType, so its mere presence is enough — no need to import and compare
// against each of the four constants individually. Everything left over
// (a Free Ride or a scripted cardio workout) is a ride.
const HISTORY_CATS = [
  ['all',  'All',       'icon-grid'],
  ['ride', 'Rides',     'icon-bike'],
  ['str',  'Strength',  'icon-dumbbell'],
  ['test', 'Tests',     'icon-activity'],
];
function _sessionCategory(s) {
  if (s.meta?.type === 'strength') return 'str';
  if (s.meta?.testType) return 'test';
  return 'ride';
}

// How long the detail chart's All page sits on one metric before stepping to the next: the same dwell as the
// live chart's All page (app.js's OVERVIEW_HERO_INTERVAL_MS) and its rotating badge.
const DETAIL_ROTATION_MS = 3500;

export class HistoryBrowser {
  /**
   * @param {HTMLElement} container
   * @param {Object}   [opts]
   * @param {string}   [opts.units='metric']  'metric' | 'imperial' — drives
   *   Distance chips and the expanded chart's Speed series/label.
   */
  constructor(container, { units = 'metric' } = {}) {
    this._container = container;
    this._units     = units;
    this._sessions  = [];
    this._detailCarousel = null;    // ChartCarousel inside the open detail sheet, or null
    this._detailRotation = null;    // interval that steps the detail chart's All page from metric to metric, or null
    this._detailMetric = null;      // the metric that rotation is on
    this._rail = null;
    this._render();
  }

  /** Load sessions from IndexedDB and display them. */
  async load() {
    this._sessions = await db.getSessions();
    this._renderList();
  }

  /** Update the Metric/Imperial display unit and re-render whatever's loaded. */
  setUnits(units) {
    this._units = units;
    if (this._sessions.length) this._renderList();
  }

  /** Re-measures the md-rail's rendered height (ui/master-detail.js's
   *  _measureRailHeight(), which style.css's .md-pane padding-bottom reads
   *  as --rail-h). The constructor above builds the rail immediately,
   *  while `history-panel` still has app.js's initial `hidden` class on it
   *  — a display:none ancestor collapses offsetHeight to zero, so the
   *  rail's first real height is wrong (and .md-pane under-reserves space
   *  for it) until something re-measures it. app.js's switchTab() calls
   *  this the moment the History tab is actually shown, rather than
   *  leaving that reservation wrong until the rider happens to trigger a
   *  collapse toggle. A no-op if the rail hasn't been built yet. */
  refreshRailPosition() {
    this._rail?.refreshPosition();
  }

  // ─── Shell ──────────────────────────────────────────────────────────────

  _render() {
    this._container.innerHTML = `
      <div class="history-header history-header-compact">
        <h2 class="history-title">Workout History</h2>
        <div class="history-header-actions">
          <button class="btn btn-ghost history-import" title="Import history from a file" aria-label="Import workout history"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-upload"/></svg></button>
          <button class="btn btn-ghost history-export" title="Export all history to a file" aria-label="Export all workout history"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-download"/></svg></button>
        </div>
      </div>
      <p class="history-status" role="status" hidden></p>

      <!-- ── History's master-detail rail ────
           Same MasterDetailRail Settings uses, wired to a rail-defined
           category (All/Rides/Strength/Tests) instead of a settings
           group. Every category section is pre-rendered up front — the
           class only toggles which one shows — so a session that's e.g.
           a ride ends up rendered twice (once under "all", once under
           "ride"); see _renderList()'s comment on why that's the right
           tradeoff instead of re-rendering content on every rail click. -->
      <div class="md-shell" id="history-md-shell">
        <nav class="md-rail" aria-label="History categories"></nav>
        <div class="md-pane">
          ${HISTORY_CATS.map(([cat, label, icon]) => `
            <section class="md-cat" data-cat="${cat}" data-label="${label}" data-icon="${icon}">
              <div class="history-list" data-cat-list="${cat}"><p class="history-empty">Loading…</p></div>
            </section>
          `).join('')}
        </div>
      </div>
    `;
    this._container.querySelector('.history-export').addEventListener('click', () => this._exportAll());
    this._container.querySelector('.history-import').addEventListener('click', () => this._importFile());

    // onSelect: a session's detail sheet is about the category the rider was just
    // looking at, so changing category closes it (the sheet's scrim covers the rail,
    // so this is for a keyboard or programmatic change rather than a tap).
    this._rail = new MasterDetailRail(this._container.querySelector('#history-md-shell'), {
      onSelect: () => { this._closeDetail(); this._fitVisible(); },
    });

    // One delegated listener for every card, in every category list, present
    // or future — simpler and more robust than a per-card forEach now that a
    // session's card can exist in two places in the DOM at once (see
    // _renderList()). The tiles are role="button", so Enter and Space open one too.
    const pane = this._container.querySelector('.md-pane');
    pane.addEventListener('click', (e) => this._onPaneClick(e));
    pane.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tile = e.target.closest?.('.history-poster');
      if (!tile) return;
      e.preventDefault();
      this._openDetail(Number(tile.closest('.history-item')?.dataset.index));
    });
  }

  /** Only the currently-visible category needs shrink-to-fit — a hidden
   *  `.md-cat` has no layout box to measure against, and re-fitting it
   *  would either no-op uselessly or measure garbage. Called after every
   *  re-render and every rail switch, since a category hidden during the
   *  last render was never fitted while invisible. */
  _fitVisible() {
    const active = this._container.querySelector('.md-cat.active');
    if (active) fitText(active, '.stat-val, .stat-lbl');
  }

  _onPaneClick(e) {
    if (e.target.closest('.history-empty-import')) { this._importFile(); return; }
    const itemEl = e.target.closest('.history-poster')?.closest('.history-item');
    if (itemEl) this._openDetail(Number(itemEl.dataset.index));
  }

  async _deleteSession(index) {
    const session = this._sessions[index];
    if (!session) return;
    if (!confirm('Delete this workout?')) return;
    await db.deleteSession(session.id);
    await this.load();
  }

  // ─── Export all / Import ────────────────────────────────────────────────
  // The file format, validation and duplicate rules live in
  // recording/history-archive.js; this is just the wiring between those, the
  // save/pick helpers in platform/, and the status line under the header.

  /** Shows a one-line result under the header; '' hides it. Fades out on its own. */
  _setStatus(text, { error = false } = {}) {
    const el = this._container.querySelector('.history-status');
    if (!el) return;
    clearTimeout(this._statusTimer);
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('error', !!text && error);
    if (text) this._statusTimer = setTimeout(() => this._setStatus(''), error ? 12000 : 8000);
  }

  /** Locks Import/Export while one of them is working — not while the file
   *  picker is open, since a picker that never reports back (see
   *  platform/pick-file.js) would otherwise leave them stuck. */
  _setBusy(busy) {
    this._busy = busy;
    this._container.querySelectorAll('.history-import, .history-export')
      .forEach(btn => { btn.disabled = busy; });
  }

  async _exportAll() {
    if (this._busy) return;
    this._setBusy(true);
    try {
      // Straight from the store rather than this._sessions, so it's
      // everything saved, not whatever the list last rendered.
      const sessions = await db.getSessions();
      if (!sessions.length) {
        this._setStatus('No workouts to export yet.');
        return;
      }
      const { json, count, filename } = buildHistoryArchive(sessions);
      const saved = await saveFile(filename, new Blob([json], { type: 'application/json' }));
      this._setStatus(saved
        ? `Exported ${count} workout${count === 1 ? '' : 's'}.`
        : 'The export wasn\u2019t saved.');
    } catch (err) {
      console.error('[history] export failed', err);
      this._setStatus('Couldn\u2019t export your history.', { error: true });
    } finally {
      this._setBusy(false);
    }
  }

  async _importFile() {
    if (this._busy) return;
    let picked;
    try {
      picked = await pickTextFile();
    } catch (err) {
      console.error('[history] reading the picked file failed', err);
      this._setStatus('Couldn\u2019t read that file.', { error: true });
      return;
    }
    if (!picked) return; // cancelled

    this._setBusy(true);
    try {
      const parsed = parseHistoryArchive(picked.text);
      if (!parsed.ok) {
        this._setStatus(importErrorMessage(parsed.error), { error: true });
        return;
      }
      if (!parsed.sessions.length) {
        this._setStatus(importErrorMessage('empty'), { error: true });
        return;
      }
      const existing = await db.getSessionStartTimes();
      const { toAdd, duplicates } = planSessionImport(existing, parsed.sessions);
      if (toAdd.length) await db.addSessions(toAdd);
      await this.load();
      this._setStatus(importSummary({ added: toAdd.length, duplicates, invalid: parsed.invalid }));
    } catch (err) {
      console.error('[history] import failed', err);
      this._setStatus('Couldn\u2019t import that file. Nothing was changed.', { error: true });
    } finally {
      this._setBusy(false);
    }
  }

  _renderList() {
    // An open detail sheet is about a session by its index into the list being replaced,
    // so it closes rather than risk showing (or deleting) a different session. Its
    // teardown also closes any Download menu and destroys the chart carousel.
    this._closeDetail();

    if (this._sessions.length === 0) {
      for (const [cat] of HISTORY_CATS) {
        const el = this._container.querySelector(`[data-cat-list="${cat}"]`);
        if (el) el.innerHTML = this._emptyState(cat, false);
      }
      return;
    }

    // Every session keeps its real index into this._sessions as data-index
    // wherever it's rendered — "all" gets every session, the other three
    // each get their own filtered subset, so a ride's card exists in both
    // the "all" list and the "ride" list at once. That's the simplest way
    // to satisfy MasterDetailRail's contract (every .md-cat is fully
    // rendered up front; selecting one only toggles which is visible — see
    // ui/master-detail.js) without teaching it to move nodes between
    // sections or re-render on every rail click. The duplication costs
    // nothing functionally: both copies carry the same data-index, so a tap
    // on either opens the same session in the detail sheet, and only one
    // copy of any card is ever visible (and therefore reachable) at a time.
    const withCat = this._sessions.map((s, i) => ({ s, i, cat: _sessionCategory(s) }));
    for (const [cat] of HISTORY_CATS) {
      const el = this._container.querySelector(`[data-cat-list="${cat}"]`);
      if (!el) continue;
      const entries = cat === 'all' ? withCat : withCat.filter(e => e.cat === cat);
      el.innerHTML = entries.length
        ? this._weekSections(entries)
        : this._emptyState(cat, true);
    }

    this._fitVisible();
  }

  /** A designed empty state instead of a sentence: a hero
   *  glass card holding a ghosted pair of poster tiles — the real tile's own
   *  classes, so the ghost stays in step with it — then a headline and one muted
   *  line. What it says comes from history-layout.js's emptyStateContent(). With
   *  no sessions anywhere it also offers Import, which is the other way in; the
   *  header's own Import button stays as it was.
   *  @param {string} cat  the rail category id  @param {boolean} hasAny  any session at all */
  _emptyState(cat, hasAny) {
    const c = emptyStateContent(cat, hasAny);
    const glyph = '<span class="overview-fab-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#icon-x"/></svg></span>';
    const ghostTile = `
      <div class="history-poster">
        <div class="history-poster-head">
          <span class="history-poster-chip"></span>
          <span class="history-poster-name"></span>
        </div>
        <div class="history-poster-spark"><svg viewBox="0 0 100 28" preserveAspectRatio="none"><polyline points="0,22 20,18 40,20 60,12 80,14 100,6"/></svg></div>
        <div class="history-poster-stats">
          ${c.ghost.map(n => `<div data-metric="${n.metric}"><span class="stat-val">—</span><span class="stat-lbl">${n.lbl}</span></div>`).join('')}
        </div>
      </div>`;
    return `
      <section class="history-empty-state" data-empty="${cat}">
        <div class="history-week-grid history-empty-ghost" aria-hidden="true">${ghostTile}${ghostTile}</div>
        <h3 class="history-empty-title">${c.title}</h3>
        <p class="history-empty-line">${c.line.replace('{+}', glyph)}</p>
        ${c.showImport ? '<button type="button" class="btn btn-ghost btn-sm history-empty-import"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-upload"/></svg> Import history</button>' : ''}
      </section>`;
  }

  /** One header + a two-up grid of poster tiles per calendar week,
   *  newest week first (views/history-layout.js does the grouping). */
  _weekSections(entries) {
    return groupByWeek(entries).map(g => `
      <section class="history-week" data-week="${g.weekStart}">
        <header class="history-week-head">
          <span class="history-week-label">${g.label}</span>
          <span class="history-week-totals">${weekTotalsText(g.totals, this._units)}</span>
        </header>
        <div class="history-week-grid">${g.entries.map(({ s, i }) => this._sessionItem(s, i)).join('')}</div>
      </section>
    `).join('');
  }

  // ─── Card + expand panel ────────────────────────────────────────────────

  _sessionItem(s, i) {
    return `
      <div class="history-item" data-index="${i}">
        ${this._sessionCard(s)}
      </div>
    `;
  }

  /** A session as a poster tile: date chip + name, the
   *  signature sparkline, three numbers. Everything else — the rest of the
   *  stats, the chart, laps, Download and Delete — lives in the expand panel
   *  (and, at the next step, in the detail sheet). */
  _sessionCard(s) {
    const when = new Date(s.startTime).toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const name = s.workoutName ?? 'Free Ride';

    return `
      <div class="history-poster" role="button" tabindex="0" aria-haspopup="dialog" aria-label="${_esc(name)}, ${_esc(when)}">${posterTileBody(s, this._units)}</div>
    `;
  }

  /** Opens the shared detail sheet (ui/detail-sheet.js) for one session: the chart as the
   *  hero, the stat tiles below it, then the laps; Download and Delete in the header.
   *  @param {number} index  the session's index into this._sessions — the same `data-index`
   *    its tile carries, which is the same for both DOM copies of a card (see _renderList()). */
  _openDetail(index) {
    const session = this._sessions[index];
    if (!session) return;

    const when = new Date(session.startTime).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const sheet = detailSheet.open({
      title: session.workoutName ?? 'Free Ride',
      subtitle: when,
      size: 'tall',
      actions: [
        { id: 'download', label: 'Download workout', icon: 'icon-download', setup: (btn) => attachDownloadMenu(btn, session) },
        { id: 'delete',   label: 'Delete workout',   icon: 'icon-trash',    onClick: () => this._deleteSession(index) },
      ],
      content: `
        <div class="chart-container history-detail-chart"></div>
        <div class="detail-summary">${this._summaryChips(session)}</div>
        ${session.laps?.length ? `<div class="detail-laps">${this._lapsTable(session)}</div>` : ''}
      `,
      onClose: () => this._teardownDetail(),
    });

    // The chart is built once the sheet is on screen, so it measures a real box.
    this._buildDetailChart(sheet.body.querySelector('.history-detail-chart'), session);
  }

  /** Closes the detail sheet if it is open (its onClose does the teardown). */
  _closeDetail() {
    detailSheet.close();
    // close() finishes after the slide-out, so tear the chart down now too: a list
    // re-render is about to replace the sessions this sheet was showing.
    this._teardownDetail();
  }

  /** What the sheet leaves behind: the chart carousel (and its ResizeObserver), and a
   *  Download menu that may be anchored to a button that is going away. Safe to call twice. */
  _teardownDetail() {
    closeDownloadMenu();
    this._stopDetailRotation();
    if (this._detailCarousel) { this._detailCarousel.destroy(); this._detailCarousel = null; }
  }

  /** Arriving on the detail chart's All page: it starts on the first metric and the timer starts from zero,
   *  so the first metric gets a full dwell too (the same as the live chart's All page). */
  _startDetailRotation() {
    this._stopDetailRotation();
    const c = this._detailCarousel;
    if (!c) return;
    this._detailMetric = c.metricKeys[0] ?? null;
    c.setOverviewMetric(this._detailMetric);
    this._detailRotation = setInterval(() => this._tickDetailRotation(), DETAIL_ROTATION_MS);
  }

  _stopDetailRotation() {
    if (this._detailRotation) { clearInterval(this._detailRotation); this._detailRotation = null; }
  }

  /** One step: the next metric, wrapping round; the chart fades in on it (ChartCarousel#setOverviewMetric). */
  _tickDetailRotation() {
    const c = this._detailCarousel;
    if (!c) { this._stopDetailRotation(); return; }
    const keys = c.metricKeys;
    if (keys.length < 2) return;   // nothing to rotate to
    if (c.locked) return;          // a held crosshair stays on its metric; the rotation resumes when it is released
    this._detailMetric = keys[(keys.indexOf(this._detailMetric) + 1) % keys.length];
    c.setOverviewMetric(this._detailMetric);
  }

  /** Builds the chart carousel — one page per recorded metric, plus a leading "All"
   *  page that steps through the metrics one chart at a time on a timer, as the live chart's
   *  All page does (see ChartCarousel's showOverview and overviewFollowsHero options). */
  _buildDetailChart(chartEl, session) {
    this._detailCarousel = new ChartCarousel(chartEl, {
      mode: 'history',
      windowSec: session.duration || 3600,
      showOverview: true,
      // The All page draws one metric's chart at a time and rotates through them (_startDetailRotation), as
      // the live chart's All page does, rather than overlaying every metric.
      overviewFollowsHero: true,
      onActiveMetric: (key) => {
        if (key === ChartCarousel.OVERVIEW_KEY) { if (!this._detailRotation) this._startDetailRotation(); }
        else this._stopDetailRotation();
      },
      // The canvases paint no background of their own: the chart sits on the same hero-tier glass as the
      // live chart's panel (.history-detail-chart in style.css), so the two read as the same surface.
      chartBgAlpha: 0,
      emptyMessage: 'No metrics recorded for this workout.',
    });

    const hasPower = session.samples.some(s => s.power !== null);
    const hasHR    = session.samples.some(s => s.heartRate !== null);
    const hasCad   = session.samples.some(s => s.cadence !== null);
    const hasSpeed = session.samples.some(s => s.speed !== null);

    const defs = [];
    if (hasPower) defs.push({ key: 'power', color: CHART_COLORS.power, label: 'PWR', yMin: 0, yMax: _yMax(session.samples, 'power', 600) });
    if (hasHR)    defs.push({ key: 'heartRate', color: CHART_COLORS.heartRate, label: 'HR', yMin: 40, yMax: 220 });
    if (hasCad)   defs.push({ key: 'cadence', color: CHART_COLORS.cadence, label: 'CAD', yMin: 0, yMax: 140 });
    if (hasSpeed) {
      // Stored samples stay metric (km/h) regardless of the display unit —
      // `transform` converts at render time only, so toggling units later
      // redraws correctly instead of needing the data itself converted.
      const toDisplaySpeed = v => kmhToDisplaySpeed(v, this._units);
      defs.push({
        key: 'speed',
        color: CHART_COLORS.speed,
        label: 'SPD',
        yMin: 0,
        yMax: _yMax(session.samples, 'speed', 60, toDisplaySpeed),
        transform: toDisplaySpeed,
      });
    }

    // The same dot order as the live chart (heart rate, power, cadence, speed — charts/chart-order.js).
    this._detailCarousel.setAvailableMetrics(sortMetricDefs(defs));
    this._detailCarousel.setData(session.samples, session.laps ?? []);
  }

  _summaryChips(s) {
    // The poster tile only carries three numbers (see _sessionCard()), so
    // the detail sheet holds the full set, as a tile grid under the hero chart:
    // Time, Avg Power, Avg HR, Distance, then Calories, NP, Avg Cadence and
    // Avg Speed. Two 4-up rows (see .detail-summary .stat-chip in style.css),
    // plain (non-`large`) chips so both rows read as one continuous grid.
    const avgSpeed = avgSpeedKmh(s.summary?.totalDistance, s.duration);
    const chips = [
      ['time',      'TIME',          _fmtDuration(s.duration)],
      ['power',     'APWR (W)',      s.summary?.avgPower != null ? `${s.summary.avgPower}` : '—'],
      ['heartRate', 'AVG HR (BPM)',  s.summary?.avgHr    != null ? `${s.summary.avgHr}`    : '—'],
      ['distance',  `DIST (${distanceUnitLabel(this._units).toUpperCase()})`, formatDistanceValue(s.summary?.totalDistance, this._units)],
      ['calories',  'KCAL',    s.summary?.totalCalories != null ? `${Math.round(s.summary.totalCalories)}` : '—'],
      ['np',        'NPWR (W)',    s.summary?.normalizedPower != null ? `${s.summary.normalizedPower}` : '—'],
      ['cadence',   'AVG CAD (RPM)', s.summary?.avgCadence  != null ? `${s.summary.avgCadence}` : '—'],
      // Colored inline straight from CHART_COLORS.speed — the colour the
      // Speed series is drawn in on the live/history chart (see
      // _buildDetailChart()'s `defs` and app.js's METRIC_DEFS), which is
      // itself resolved from --color-speed. There's no
      // .stat-chip[data-metric="speed"] rule in style.css (only
      // "distance" shares --color-speed), so without this the chip would
      // fall back to the muted default.
      ['speed',     `AVG SPD (${speedUnitLabel(this._units).toUpperCase()})`, avgSpeed != null ? `${kmhToDisplaySpeed(avgSpeed, this._units).toFixed(1)}` : '—', CHART_COLORS.speed],
    ];
    return chips.map(([metric, lbl, val, color]) =>
      `<div class="stat-chip" data-metric="${metric}"${color ? ` style="--chip-color:${color}"` : ''}><span class="stat-val">${val}</span><span class="stat-lbl">${lbl}</span></div>`
    ).join('');
  }

  _lapsTable(session) {
    if (!session.laps?.length) return '';
    // Build lap summaries from marks
    const marks = session.laps;
    const samples = session.samples;
    const boundaries = [
      { sampleIndex: 0 }, ...marks, { sampleIndex: samples.length }
    ];

    let rows = '';
    for (let i = 0; i < boundaries.length - 1; i++) {
      const slice  = samples.slice(boundaries[i].sampleIndex, boundaries[i + 1].sampleIndex);
      if (!slice.length) continue;
      const powers = slice.map(s => s.power).filter(v => v != null);
      const hrs    = slice.map(s => s.heartRate).filter(v => v != null);
      const dur    = Math.round((slice[slice.length-1].timestamp - slice[0].timestamp) / 1000);
      rows += `<tr>
        <td>Lap ${i + 1}</td>
        <td>${_fmtDuration(dur)}</td>
        <td>${powers.length ? Math.round(powers.reduce((a,b)=>a+b)/powers.length) + ' W' : '—'}</td>
        <td>${hrs.length ? Math.round(hrs.reduce((a,b)=>a+b)/hrs.length) + ' bpm' : '—'}</td>
      </tr>`;
    }

    return `<h3 class="detail-section-title">Laps</h3>
    <table class="laps-table">
      <thead><tr><th>Lap</th><th>Duration</th><th>Avg Power</th><th>Avg HR</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _fmtDuration(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function _esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function _yMax(samples, key, fallback, transform = v => v) {
  const vals = samples.map(s => s[key]).filter(v => v != null).map(transform);
  return vals.length ? Math.max(...vals) * 1.1 : transform(fallback);
}

export default HistoryBrowser;
