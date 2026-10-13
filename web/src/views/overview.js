// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * views/overview.js
 *
 * The app's home tab. Everything here is derived from sources that
 * already exist elsewhere in the app: saved sessions (IndexedDB, via
 * db.getSessions() — same records HistoryBrowser reads), Diet-tab diary
 * entries, scale weigh-ins (db.getBodyMeasurements()), and the rider's
 * profile (FTP / weight / units — the same live `profile` object app.js
 * mutates whenever Settings autosaves, passed in by reference so a
 * re-render after a save just needs `.load()` again, no extra wiring).
 *
 * Every card is always on the page. Cards with enough data come first; the
 * rest sit below them, each saying in one line what it still needs. Which is
 * which, the order, and those lines all live in metrics/overview-cards.js —
 * this file only lays them out.
 *
 * Usage:
 *   const overview = new OverviewPage(document.getElementById('overview-panel'), {
 *     profile,                       // { ftp, riderWeight, units, ... }
 *   });
 *   await overview.load();  // fetch sessions + render
 */

import { db } from '../storage/db.js';
import { MasterDetailRail } from '../ui/master-detail.js';
import { timeInZones, resolveFtp } from '../metrics/ftp-zones.js';
import { timeInZonesHr, estimateMaxHr } from '../metrics/hr-zones.js';
import { formatDistance, formatDistanceValue, distanceUnitLabel, weightUnitLabel } from '../metrics/units.js';
import { estimateBmr } from '../metrics/nutrition.js';
import { sumNutrients, macroCalorieSplit } from '../core/nutrition-model.js';
import { fitText } from '../ux/fit-text.js';
import { buildBodyHistory } from '../metrics/body-history.js';
import { renderBodyHistoryChart } from '../charts/body-history-chart.js';
import { flagWeighIns } from '../metrics/weigh-in-review.js';
import { overviewReadiness, OVERVIEW_NEEDS, OVERVIEW_TREND_WEEKS } from '../metrics/overview-cards.js';
import { buildYearConcentration } from '../metrics/year-concentration.js';
import { posterTileBody } from './session-poster.js';
import { detailSheet } from '../ui/detail-sheet.js';
import { overviewDetail, DETAIL_IDS, fmtDuration as _fmtDuration } from './overview-detail.js';

const DAY = 24 * 60 * 60 * 1000;

// How many sessions the Recent card shows — one two-up row of History's own poster tiles.
const RECENT_COUNT = 2;

// ── One compact page ────────────────────────────────────────────────────────
// Overview is one compact page: the rail is just the "+" start button (see
// MasterDetailRail's `fabOnly`), and every card lives in this one grid, in this
// order. Settings, History and Diet keep their categories.
//
// Order, top to bottom: the week at a glance, the year and volume side by side,
// bests and recent sessions, then the fitness readouts in pairs (FTP + W/kg,
// VO2 Max + Heart), then the longer cards — body composition, the two zone bars,
// nutrition. Every id here must exist as a key on the `cards` object built in
// _renderData(). The order is fixed rather than "cards with data first": a tile
// keeps its place as data arrives, so nothing jumps around on the page.
const CARD_ORDER = [
  'week', 'year', 'volume', 'bests', 'recent',
  'ftp', 'pwr', 'vo2max', 'heart',
  'body', 'zones', 'hrzones', 'nutrition',
];

// Cards whose tile sits at half the page's width, two to a row; every other card
// spans the full width (the ".overview-tiles" rule in style.css — the grid uses
// dense auto-flow, so a half tile whose usual partner is absent, e.g. the first-run
// hero standing in for Past 12 Months, is paired with the next half tile instead
// of leaving a hole).
const HALF_WIDTH_CARDS = new Set(['year', 'volume', 'ftp', 'pwr', 'vo2max', 'heart']);

// Rough, commonly-cited FTP W/kg tiers (not a substitute for a real power
// profile test) — shown with a caption making clear it's a loose guide.
const PWR_TIERS = [
  { max: 1.5, label: 'Beginner' },
  { max: 2.5, label: 'Recreational' },
  { max: 3.5, label: 'Intermediate' },
  { max: 4.5, label: 'Advanced' },
  { max: 5.5, label: 'Competitive' },
  { max: Infinity, label: 'Elite' },
];

export class OverviewPage {
  /**
   * @param {HTMLElement} container
   * @param {Object}   opts
   * @param {Object}   opts.profile           Live profile object (ftp, riderWeight, units, ...). ftp and
   *   riderWeight are null until the rider enters them — the Power-to-Weight card waits for both.
   * @param {Function} [opts.onReviewWeighIns] () => void — opens the weigh-in
   *   editor (ui/weigh-in-manager.js). Only rendered once there's at least one
   *   weigh-in to review (before that the Weight & Composition card is the
   *   "needs a weigh-in" card, which points the rider at Settings).
   * @param {Function} [opts.onOpenSettings] (ids: string[]) => void — a card's detail sheet has an
   *   "Edit ..." button (FTP, heart rate, weight); this takes the rider to those Settings fields.
   *   Omitted, the sheets simply have no such button.
   * @param {Function} [opts.onNeedsCardTap] (id) => void — an empty card
   *   (metrics/overview-cards.js's OVERVIEW_NEEDS) was tapped; id is its
   *   OVERVIEW_CARD_ORDER id. app.js routes this to wherever that id's need
   *   actually lives — a Settings field, the Diet tab, or (for a session-fed
   *   card) the FAB menu — and highlights it there. Omitted, every empty
   *   card just sits there same as before — OverviewPage stays usable
   *   without app.js wired in.
   */
  constructor(container, { profile, onReviewWeighIns, onNeedsCardTap, onOpenSettings } = {}) {
    this._container = container;
    this._profile = profile;
    this._onReviewWeighIns = onReviewWeighIns ?? null;
    this._onNeedsCardTap = onNeedsCardTap ?? null;
    this._onOpenSettings = onOpenSettings ?? null;
    // What the open card's detail sheet is built from - set by _renderData() on every render.
    this._detailData = null;
    this._sessions = [];
    this._diaryEntries = [];
    this._bodyMeasurements = [];
    // Weight & Composition card selection. `_bodyRange` stays null until the
    // rider taps a range chip — null means "auto" (see metrics/body-history.js's
    // resolveRange()). Kept on the instance so a re-load() (new weigh-in, a
    // units change) redraws whatever they were looking at.
    this._bodyMetric = 'weight';
    this._bodyRange = null;
    this._bodyModel = null;
    this._bodyWidth = 0;
    this._bodyResize = null;
    // The rail — built once by _render()
    // below, same "shell built once, data refreshed in place" split
    // HistoryBrowser uses, so a background load() (a scale reading
    // settling, a diary entry logged) doesn't yank the rider back to
    // Training out from under them mid-scroll on some other category.
    this._rail = null;
    this._render();
  }

  /** Fetch sessions + diary entries + scale weigh-ins from IndexedDB and
   *  re-render. Safe to call anytime — e.g. after a workout is saved, the
   *  profile (FTP/weight/age/sex/height) is saved, a scale reading settles
   *  (app.js's _recordScaleMeasurement() calls this), or (via the Overview
   *  tab's own switchTab() re-load in app.js — no extra wiring needed, same
   *  as sessions already work) a diary entry is logged on the Diet tab.
   *  Only refreshes each category's tile content (_renderData()) — the rail
   *  itself, and whichever category is currently selected, are untouched. */
  async load() {
    const [sessions, diaryEntries, bodyMeasurements] = await Promise.all([
      db.getSessions(), db.getDiaryEntries(), db.getBodyMeasurements(),
    ]);
    this._sessions = sessions;
    this._diaryEntries = diaryEntries;
    this._bodyMeasurements = bodyMeasurements;
    this._renderData();
  }

  // ─── Shell ──────────────────────────────────────────────────────────────

  /** Re-measures the md-rail's rendered height (ui/master-detail.js's
   *  _measureRailHeight(), which style.css's .md-pane padding-bottom reads
   *  as --rail-h) — a no-op if the rail hasn't been built yet. Needed
   *  because this page's rail is constructed during startup (app.js's
   *  init()) while `overview-panel` happens to already be the visible tab,
   *  so it isn't itself affected — but app.js calls this from switchTab()
   *  for every md-rail tab uniformly (Settings/History/Diet *are* built
   *  while hidden, where it matters: offsetHeight reads 0 on a
   *  display:none ancestor) rather than special-casing Overview out, so
   *  this page doesn't need to know it's the one that's already fine. */
  refreshRailPosition() {
    this._rail?.refreshPosition();
  }

  /** Builds the static rail + one empty tile-slot per category, once —
   *  mirrors HistoryBrowser's _render()/_renderList() split exactly, for
   *  the same reason (see load()'s doc comment above). Nothing here reads
   *  `this._sessions`/etc.; the hero's streak badge and every card live in
   *  a slot this fills, refreshed by _renderData() instead of rebuilt here. */
  _render() {
    this._container.innerHTML = `
      <div class="overview-hero-slot"></div>
      <div class="md-shell" id="overview-md-shell">
        <nav class="md-rail" aria-label="Start a session"></nav>
        <div class="md-pane">
          <section class="md-cat overview-page" data-cat="overview" data-label="Overview" data-icon="icon-activity">
            <div class="overview-tiles" data-overview-tiles></div>
          </section>
        </div>
      </div>
    `;

    // fabOnly: no category tabs and no collapse toggle, just the "+" (see
    // MasterDetailRail's doc comment). The one `.md-cat` above is kept open.
    // alwaysCollapsed: this page's rail is pinned collapsed and ignores the
    // shared collapse toggle on the other tabs (Settings/History/Diet).
    this._rail = new MasterDetailRail(this._container.querySelector('#overview-md-shell'), {
      fabOnly: true,
      alwaysCollapsed: true,
      onSelect: () => this._fitVisible(),
    });
  }

  /** Only the currently-visible category needs shrink-to-fit — a hidden
   *  `.md-cat` has no layout box to measure against. Called after every
   *  data refresh and every rail switch (MasterDetailRail's onSelect,
   *  wired in _render() above), same split HistoryBrowser's own
   *  _fitVisible() uses. */
  _fitVisible() {
    const active = this._container.querySelector('.md-cat.active');
    if (active) fitText(active, '.history-card .stat-val, .history-card .stat-lbl, .history-poster-stats .stat-val, .history-poster-stats .stat-lbl, .overview-bests-card .stat-val, .overview-bests-card .stat-lbl');
  }

  // ─── Data refresh ───────────────────────────────────────────────────────

  _renderData() {
    const profile = this._profile;
    const now = Date.now();

    // Which cards have enough data decides the order: those first, the rest
    // below as "needs ..." cards (metrics/overview-cards.js). There is no
    // page-level empty state any more — a rider with weigh-ins or diary
    // entries but no sessions yet still sees those cards, on top.
    const ready = overviewReadiness({
      sessions: this._sessions,
      diaryEntries: this._diaryEntries,
      bodyMeasurements: this._bodyMeasurements,
      profile,
    }, { now });

    const thisWeek = this._sessions.filter(s => now - s.startTime < 7 * DAY);
    const lastWeek = this._sessions.filter(s => now - s.startTime >= 7 * DAY && now - s.startTime < 14 * DAY);
    const last30   = this._sessions.filter(s => now - s.startTime < 30 * DAY);

    const weekStats     = _aggregate(thisWeek);
    const yearMap       = buildYearConcentration(this._sessions, { now });
    const prevWeekStats = _aggregate(lastWeek);
    const zoneDist       = timeInZones(last30.flatMap(s => s.samples ?? []), resolveFtp(profile.ftp));
    // Same last-30-days window as zoneDist above, so "Power Zones" and
    // "Heart Rate Zones" are always answering the same question about the
    // same stretch of training. maxHr mirrors app.js's own _resolvedMaxHr()
    // (a measured value if the rider entered/tested one, else the Tanaka
    // age estimate) — duplicated as a one-liner here rather than imported,
    // since app.js's version is a private closure over its own `profile`.
    const maxHr           = profile.maxHr ?? estimateMaxHr(profile.age);
    const hrZoneDist       = timeInZonesHr(last30.flatMap(s => s.samples ?? []), { maxHr, restingHr: profile.restingHr });
    const pwrRatio        = profile.ftp && profile.riderWeight ? profile.ftp / profile.riderWeight : null;
    const bests           = _personalBests(this._sessions);
    const streak           = _streak(this._sessions);
    const trend             = _weeklyTrend(this._sessions, OVERVIEW_TREND_WEEKS);
    const bmr                = estimateBmr(profile);
    const nutritionWeek        = _weeklyNutrition(this._diaryEntries, this._sessions, bmr);

    // One entry per card id in metrics/overview-cards.js. A card draws itself
    // only when it's ready; otherwise it's the shared empty card, whose
    // tooltip says what the card shows and whose body says what it needs.
    // A card with data is a button that opens its detail sheet (_openDetail()); the (i) it used to
    // carry now lives in that sheet. An empty card has no sheet, so it keeps its (i) - its tap
    // goes to wherever its need is met instead.
    this._detailData = {
      units: profile.units, week: weekStats, prev: prevWeekStats, yearMap, trend, nutrition: nutritionWeek,
      zoneDist, hrZoneDist, profile, estimatedMaxHr: estimateMaxHr(profile.age), ratio: pwrRatio,
      tier: pwrRatio != null ? (PWR_TIERS.find(t => pwrRatio < t.max)?.label ?? 'Elite') : null, bests,
    };
    const card = (id, title, about, draw) => ready[id]
      ? _asDetailButton(id, draw())
      : this._emptyCard(id, title, about);
    const cards = {
      week: card('week', 'This Week',
        'Sessions, time, distance and calories for the last 7 days, compared with the week before.',
        () => this._weekCard(weekStats, prevWeekStats, profile.units)),
      year: card('year', 'Past 12 Months',
        'How much you trained in each of the past 12 months, as a grid of shaded squares.',
        () => this._yearCard(yearMap)),
      volume: card('volume', 'Weekly Volume',
        `Minutes trained, last ${OVERVIEW_TREND_WEEKS} weeks.`,
        () => this._trendCard(trend)),
      nutrition: card('nutrition', 'Weekly Nutrition',
        'Average daily calories and macro split over the last 7 days, from the Diet tab.',
        () => this._nutritionWeekCard(nutritionWeek)),
      // Draws its own empty state (it is also re-rendered on its own by
      // _refreshBodyCard()), and sets this._bodyModel as it goes.
      body: this._bodyCard(),
      // There's no daily HR history on file anywhere (only the
      // one live profile.restingHr/maxHr value), so this reads today's
      // two numbers rather than a 30-day sparkline. See _heartCard()'s
      // own doc comment for what a real trend would need.
      heart: card('heart', 'Heart',
        'Your current resting and max heart rate, from Settings \u2192 Testing.',
        () => this._heartCard(profile)),
      zones: card('zones', 'Power Zones — Last 30 Days',
        'Time in zone across all sessions with power data, based on your saved FTP.',
        () => this._zonesCard(zoneDist)),
      hrzones: card('hrzones', 'Heart Rate Zones — Last 30 Days',
        'Time in zone across all sessions with heart-rate data, based on your saved max/resting HR.',
        () => this._hrZonesCard(hrZoneDist)),
      pwr: card('pwr', 'Power-to-Weight',
        'Your FTP divided by your body weight, with a rough level. A guide, not a lab test.',
        () => this._pwrCard(pwrRatio, profile)),
      vo2max: card('vo2max', 'VO2 Max',
        'Estimated from ramp-test peak power output (Storer-Davis) — a field estimate, not a lab test.',
        () => this._vo2MaxCard(profile)),
      ftp: card('ftp', 'FTP',
        'Your saved Functional Threshold Power, from Settings \u2192 Testing.',
        () => this._ftpCard(profile)),
      bests: card('bests', 'Personal Bests',
        'Peak power, best normalized power, longest session and furthest distance across all your sessions.',
        () => this._bestsCard(bests, profile.units)),
      recent: card('recent', 'Recent Sessions',
        'Your two most recent sessions, with a link to the full History tab.',
        () => this._recentCard(profile.units)),
    };

    this._container.querySelector('.overview-hero-slot').innerHTML = this._hero(streak);
    const grid = this._container.querySelector('[data-overview-tiles]');
    if (grid) {
      // First run (no sessions at all): one composed hero stands in for Past 12 Months.
      const firstRun = this._sessions.length === 0;
      // Past 12 Months is the half tile Volume normally shares a row with; with the
      // hero standing in for it, Volume takes the full width instead, so the pairs
      // below it (FTP + W/kg, VO2 Max + Heart) still line up two to a row.
      if (firstRun) cards.volume = cards.volume.replace(' overview-tile-half', '');
      grid.innerHTML = (firstRun ? this._firstRunHero() : '')
        + CARD_ORDER.filter(id => !(firstRun && id === 'year')).map(id => cards[id]).join('');
    }

    this._fitVisible();
    this._bind();
    this._bindBodyCard();
  }

  /** A card with nothing to show yet: its title (the tooltip says what the
   *  card will show once it has data) and one line saying what it needs —
   *  OVERVIEW_NEEDS[id], metrics/overview-cards.js. Rendered below every
   *  card that has data, muted (.overview-card-empty in style.css), with a ghosted
   *  stand-in for the card's own visual (_ghostVisual()) between
   *  the title and the hint, so the card already has its shape before it has data.
   *  `titleHtml` follows _titleLine()'s rule: markup the caller has already
   *  made safe.
   *
   *  With an onNeedsCardTap wired up, the whole card is also a button
   *  (.overview-card-tappable, a trailing chevron) that jumps straight to
   *  whatever the "Requires" line says — app.js's job, this method just
   *  marks the card up as tappable and _bind() below wires the tap. */
  _emptyCard(id, titleHtml, about, subject = titleHtml) {
    const tappable = Boolean(this._onNeedsCardTap);
    const half = HALF_WIDTH_CARDS.has(id) ? ' overview-tile-half' : '';
    return `
      <section class="settings-card overview-card-empty${half}${tappable ? ' overview-card-tappable' : ''}"
               data-overview-card="${id}"${tappable ? ' role="button" tabindex="0"' : ''}>
        ${_titleLine(titleHtml, about, subject)}
        <div class="overview-ghost overview-ghost-${id}" aria-hidden="true">${_ghostVisual(id)}</div>
        <div class="overview-need-row">
          <p class="overview-need">Needs ${_esc(OVERVIEW_NEEDS[id])}</p>
          ${tappable ? '<svg class="btn-icon overview-need-arrow" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-chevron-right"/></svg>' : ''}
        </div>
      </section>
    `;
  }

  /** The first-run hero. With no sessions at all it
   *  stands in for the Past 12 Months card: the ghosted heatmap (the real card's
   *  own 12 squares, shaded at level 0), a headline, and a line pointing at the
   *  rail's green "+" (the same glyph, drawn small and green, so it is
   *  recognisable when the eye goes looking for it). The rest of the page keeps
   *  its ordinary empty cards, each with its own ghosted visual. Only used for the
   *  true zero-sessions case (see the call site in _renderData()). The hero stays
   *  tappable like the other empty cards: a tap opens the FAB menu (app.js's
   *  _highlightFabSessionButtons(), via onNeedsCardTap('year')). */
  _firstRunHero() {
    const tappable = Boolean(this._onNeedsCardTap);
    const ghost = Array.from({ length: 12 }, () => '<span class="year-cell" data-level="0"></span>').join('');
    return `
      <section class="settings-card overview-training-empty${tappable ? ' overview-card-tappable' : ''}"
               data-overview-card="year"${tappable ? ' role="button" tabindex="0"' : ''}>
        <div class="year-grid overview-ghost" aria-hidden="true">${ghost}</div>
        <h2 class="overview-training-empty-title">Start your first session</h2>
        <p>Tap <span class="overview-fab-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><use href="#icon-x"/></svg></span> to begin \u2014 your heatmap, weekly volume, bests and recent rides build up from here.</p>
      </section>
    `;
  }

  /** Opens card `id`'s detail sheet (what the model says is in views/overview-detail.js).
   *  @param {string} id */
  _openDetail(id) {
    const model = this._detailData ? overviewDetail(id, this._detailData) : null;
    if (!model) return;
    const settings = model.settings && this._onOpenSettings ? model.settings : null;
    detailSheet.open({
      title: model.title,
      subtitle: model.subtitle,
      size: 'auto',
      actions: settings ? [{
        id: 'settings', label: settings.label, icon: 'icon-settings', showLabel: true,
        onClick: () => this._onOpenSettings(settings.ids),
      }] : [],
      content: _detailHtml(model),
    });
  }

  _bind() {
    // A card with data opens its detail sheet. The tap ignores anything inside the card that has
    // a job of its own (a link, a button), the way the empty cards' tap ignores their (i).
    this._container.querySelectorAll('[data-detail]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('a, button, input, select, textarea')) return;
        this._openDetail(el.dataset.detail);
      });
      el.addEventListener('keydown', (e) => {
        if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        this._openDetail(el.dataset.detail);
      });
    });

    this._container.querySelectorAll('[data-goto-history]').forEach(el =>
      el.addEventListener('click', () => document.querySelector('[data-tab="history"]')?.click())
    );

    // Empty-card tap-through (see _emptyCard()'s doc comment). Guards
    // against the title's own info button (_infoBtn() — a nested,
    // independently-clickable element wired by ux/info-tooltip.js's own
    // delegated listener) so tapping it opens the tooltip only, not both
    // the tooltip and app.js's navigate-and-highlight.
    if (this._onNeedsCardTap) {
      this._container.querySelectorAll('[data-overview-card]').forEach(el =>
        el.addEventListener('click', (e) => {
          if (e.target.closest('.info-btn')) return;
          // For OVERVIEW_SESSION_CARDS this tap is what opens app.js's FAB
          // menu (_highlightFabSessionButtons()) — left alone, the event
          // would go on to bubble up to app.js's document-level "tap
          // outside the menu closes it" listener, which sees this same
          // card (outside #fab-menu and #fab-start-btn) and immediately
          // closes the menu it was just told to open, wiping the
          // highlight in the same tick. Stopping it here is safe for the
          // other cards too — nothing else listens for this click further
          // up.
          e.stopPropagation();
          this._onNeedsCardTap(el.dataset.overviewCard);
        })
      );
    }
  }

  // ─── Sections ───────────────────────────────────────────────────────────

  _hero(streak) {
    return `
      <div class="history-header history-header-compact overview-hero">
        <div class="overview-greeting-line">
          <h2 class="history-title">Overview</h2>
          ${_infoBtn(_greetingSub(), 'Overview')}
        </div>
        ${streak >= 2 ? `<div class="overview-streak" title="Consecutive days trained"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-flame"/></svg> ${streak}-day streak</div>` : ''}
      </div>
    `;
  }

  // Shares the .history-card header/stats markup that the History tab's expand
  // panel uses (see _sessionCard() in history-browser.js) so both read as the
  // same kind of card — a name on the left, something on the right (History's
  // action buttons, this card's trend badge). Unlike that, this card's stats
  // are week-long aggregates rather than a single session's, which run longer ("3h 45m", "1850 kcal"). Deliberately just
  // 4 stats (Sessions/Time/Dist/KCAL) so this fills exactly the one 4-up
  // row the grid gives it, same as the collapsed history card — no APWR
  // chip spilling a lone 5th stat onto a second row (see
  // .history-card .history-card-stats in style.css for the grid math).
  _weekCard(week, prev, units) {
    const trend    = _trendInfo(week.duration, prev.duration);
    const distUnit = distanceUnitLabel(units).toUpperCase();
    return `
      <section class="history-card overview-recap-card">
        <div class="history-card-header">
          <div>
            <span class="history-card-name">This Week</span>
          </div>
          ${trend.text ? `<span class="history-card-trend ${trend.cls}">${trend.text}</span>` : ''}
        </div>
        <div class="history-card-stats">
          <div class="stat-chip"><span class="stat-val">${week.count}</span><span class="stat-lbl">Sessions</span></div>
          <div class="stat-chip" data-metric="time"><span class="stat-val">${_fmtDuration(week.duration)}</span><span class="stat-lbl">TIME</span></div>
          <div class="stat-chip" data-metric="distance"><span class="stat-val">${formatDistanceValue(week.distance, units)}</span><span class="stat-lbl">DIST (${distUnit})</span></div>
          <div class="stat-chip" data-metric="calories"><span class="stat-val">${week.calories ? Math.round(week.calories) : '—'}</span><span class="stat-lbl">KCAL</span></div>
        </div>
      </section>
    `;
  }

  /** How much was trained in each of the past 12 months: twelve squares in two
   *  rows of six, oldest first, so the top row runs from the start of the window
   *  and the last square, bottom right, is this month (which is still filling
   *  up). Each is shaded by the time trained that month (see
   *  metrics/year-concentration.js for how the shades are chosen). The window
   *  usually spans two calendar years, so the labels carry no year; the tip
   *  names the range and each month's title and aria-label include its year.
   *  Colour alone would not carry the amount, so every month also has its time
   *  as a title and an aria-label. */
  _yearCard(y) {
    const first = y.months[0];
    const last = y.months[y.months.length - 1];
    const range = `${first.label} ${first.year} to ${last.label} ${last.year}`;
    const sessionsText = `${y.totalSessions} session${y.totalSessions === 1 ? '' : 's'} \u00b7 ${_fmtDuration(y.totalSeconds)}`;

    const months = y.months.map(m => {
      const what = m.seconds ? `${_fmtDuration(m.seconds)} trained` : 'no training';
      return `
        <div class="year-month${m.current ? ' current' : ''}" role="listitem" aria-label="${m.name} ${m.year}: ${what}" title="${m.name} ${m.year} \u00b7 ${what}">
          <span class="year-month-label">${m.label}</span>
          <span class="year-cell" data-level="${m.level}" aria-hidden="true"></span>
        </div>
      `;
    }).join('');

    return `
      <section class="settings-card overview-year-card overview-tile-half">
        ${_plainTitle('Past 12 Months')}
        <div class="year-grid" role="list" aria-label="Time trained by month, ${range}">${months}</div>
        <p class="overview-year-total">${sessionsText}</p>
      </section>
    `;
  }

  _trendCard(weeks) {
    const maxMin = Math.max(1, ...weeks.map(w => w.minutes));
    const current = weeks[weeks.length - 1]?.minutes ?? 0;
    // No per-bar label at this width (8 of them doesn't fit a half tile) —
    // the instrument number above carries the "how much, right now" job,
    // these are just the tiny shape behind it.
    const bars = weeks.map((w, i) => `
      <div class="overview-bar-col">
        <div class="overview-bar-track">
          <div class="overview-bar ${i === weeks.length - 1 ? 'current' : ''}"
               style="height:${Math.max(4, Math.round((w.minutes / maxMin) * 100))}%"
               title="${Math.round(w.minutes)} min"></div>
        </div>
      </div>
    `).join('');

    return `
      <section class="settings-card overview-tile-half">
        ${_plainTitle('Volume')}
        <div class="overview-pwr-row">
          <div>
            <span class="overview-pwr-value">${_fmtDuration(Math.round(current * 60))}</span>
            <span class="overview-pwr-unit">this week</span>
          </div>
        </div>
        <div class="overview-weekly-chart overview-weekly-chart-compact">${bars}</div>
      </section>
    `;
  }

  /** A compact rollup of the last 7 days' Diet tab activity, placed right
   *  next to _trendCard() ("Weekly Volume"). Reuses _zonesCard()'s `.zone-strip`/`.zone-chip`/
   *  `.overview-zone-row`/`.overview-zone-fill` bar treatment for the
   *  macro split (a proportional-width fill behind each row, same as the
   *  power-zone rows above) instead of a second pie chart or
   *  views/diet.js's thin _macroSplitBar() strip — Overview already
   *  leans on bars for density, and this way the card needs zero new CSS,
   *  same rule every prior phase's style.css work followed. The kcal
   *  readout/tier-pill row reuses _pwrCard()'s `.overview-pwr-*` shell
   *  the same way. No new CSS variables. */
  _nutritionWeekCard(nutrition) {
    const { daysLogged, avgKcal, targetKcal, split } = nutrition;

    const totalKcal = split.proteinKcal + split.carbsKcal + split.fatKcal;
    const macroBar = totalKcal > 0 ? this._stackedBar([
      ['P', 'Protein', split.proteinKcal, '--color-protein'],
      ['C', 'Carbs',   split.carbsKcal,   '--color-carbs'],
      ['F', 'Fat',     split.fatKcal,     '--color-fat'],
    ].map(([key, name, kcal, colorVar]) => {
      const pct = Math.round((kcal / totalKcal) * 100);
      return { key, name, pct, color: `var(${colorVar})`, detail: `${pct}% \u00b7 ${Math.round(kcal)} kcal` };
    })) : '';

    return `
      <section class="settings-card overview-nutrition-card">
        ${_plainTitle('Weekly Nutrition')}
        <div class="overview-pwr-row">
          <div>
            <span class="overview-pwr-value">${Math.round(avgKcal)}</span>
            <span class="overview-pwr-unit">avg kcal/day</span>
          </div>
          <span class="overview-pwr-tier">${daysLogged}/7 days logged</span>
        </div>
        ${macroBar}
      </section>
    `;
  }

  /** Weight & body-composition history — the one card on this page fed by
   *  the scale's bodyMeasurements store rather than by sessions. Layout, top
   *  to bottom: title + time-range chips; a metric tab strip (only metrics
   *  the scale has actually reported — weight-only riders just get Weight);
   *  the latest value with a change badge; a scrubbable line chart (one line
   *  through the raw readings, see charts/body-history-chart.js); and a stacked bar splitting the latest
   *  reading's weight into fat / muscle / bone. The notes about the latest
   *  reading date and the estimate caveat live in the
   *  title's info tooltip rather than in a caption at the foot of the card.
   *
   *  What to draw is decided by metrics/body-history.js's buildBodyHistory();
   *  this method only lays out the result. The tab/range chips re-render
   *  just this card (_refreshBodyCard()) rather than the whole page, so the
   *  Overview's scroll position doesn't jump. The chart SVG itself is filled
   *  in after insertion (_drawBodyChart()) because it's sized to the card's
   *  real pixel width. Neutral indigo/grey for the change badge on purpose —
   *  unlike training volume, "up" isn't inherently good or bad for weight. */
  _bodyCard() {
    const m = buildBodyHistory(this._bodyMeasurements, {
      metricKey: this._bodyMetric,
      rangeKey: this._bodyRange,
      units: this._profile.units,
    });
    this._bodyModel = m;

    if (m.empty) {
      return this._emptyCard('body', 'Weight &amp; Composition',
        'Weight and body composition over time, from your scale\u2019s weigh-ins.', 'Weight & Composition');
    }

    const rangeChips = m.ranges.map(r => `
      <button type="button" class="body-range-btn" data-body-range="${r.key}" aria-pressed="${r.key === m.rangeKey}">${r.label}</button>
    `).join('');

    const tabs = m.tabs.length > 1 ? `
      <div class="body-tabs" role="group" aria-label="Metric">
        ${m.tabs.map(t => `
          <button type="button" class="body-tab" data-body-metric="${t.key}" aria-pressed="${t.key === m.metricKey}">${t.label}</button>
        `).join('')}
      </div>
    ` : '';

    const headline = m.headline.map(h => `
      <div class="body-headline-item">
        ${h.label ? `<span class="body-headline-label"><i style="background:${h.colorVar}"></i>${h.label}</span>` : ''}
        <span>
          <span class="overview-pwr-value">${h.value}</span>${h.unit ? `<span class="overview-pwr-unit">${h.unit}</span>` : ''}
        </span>
      </div>
    `).join('');
    const pill = m.pill
      ? `<span class="overview-pwr-tier body-pill" title="${m.sinceT ? `Change since ${_fmtShortDate(m.sinceT)}` : 'Change over this range'}">${m.pill.text}</span>`
      : '';

    const notes = [`Latest reading ${_fmtShortDate(m.latestT)}.`];
    if (m.metricKey === 'composition') notes.push('Change in fat and lean mass since the first reading in this range.');
    if (m.estimated) notes.push('Composition figures are scale estimates — watch the trend, not a single reading.');

    return `
      <section class="settings-card overview-body-card">
        <div class="overview-card-head">
          ${_titleLine(_esc(m.title), notes.join(' '), m.title)}
          <div class="body-range" role="group" aria-label="Time range">${rangeChips}</div>
        </div>
        ${tabs}
        <div class="overview-pwr-row body-headline-row">
          <div class="body-headline">${headline}</div>
          ${pill}
        </div>
        <div class="body-readout" data-body-readout></div>
        <div class="body-chart" data-body-chart></div>
        ${this._bodySplit(m.breakdown)}
        ${this._bodyReviewRow()}
      </section>
    `;
  }

  /** A one-line link into the weigh-in editor (ui/weigh-in-manager.js) —
   *  named after how many readings metrics/weigh-in-review.js's
   *  flagWeighIns() thinks look off, same "hint, not a verdict" wording the
   *  editor itself uses. Omitted with no onReviewWeighIns wired up (nothing
   *  to open) so this degrades cleanly wherever OverviewPage is used without it. */
  _bodyReviewRow() {
    if (!this._onReviewWeighIns) return '';
    const flaggedCount = flagWeighIns(this._bodyMeasurements).size;
    const text = flaggedCount
      ? `${flaggedCount} weigh-in${flaggedCount === 1 ? '' : 's'} may be wrong \u2014 review`
      : 'Review weigh-in history';
    return `
      <button type="button" class="body-review-link${flaggedCount ? ' body-review-link-warn' : ''}" data-body-review>${text}</button>
    `;
  }

  /** Stacked bar + legend for the latest reading's fat/muscle/bone (or
   *  fat/lean) split — segments are a true partition of body weight, see
   *  metrics/body-history.js's latestBreakdown().
   *
   *  The legend is a single row of equal-width columns, one per segment
   *  (`--n`, read by .body-split-legend in style.css), each stacking label /
   *  percentage / amount. Stacked, a column only needs ~60px, so it always fits. */
  _bodySplit(breakdown) {
    if (!breakdown) return '';
    const wUnit = weightUnitLabel(this._profile.units);
    const pct = v => `${(Math.round(v * 10) / 10).toFixed(1)}%`;
    const segs = breakdown.segments.map(s =>
      `<span class="body-split-seg" style="flex:${s.pct} 1 0; background:${s.colorVar}"></span>`
    ).join('');
    const legend = breakdown.segments.map(s => `
      <div class="body-split-legend-item">
        <span class="body-split-legend-label"><i style="background:${s.colorVar}"></i>${s.label}</span>
        <span class="body-split-legend-pct">${pct(s.pct)}</span>
        <span class="body-split-legend-amt">${s.amount.toFixed(1)} ${wUnit}</span>
      </div>
    `).join('');
    const label = breakdown.segments.map(s => `${s.label} ${pct(s.pct)}`).join(', ');
    return `
      <div class="body-split">
        <div class="body-split-head">Latest breakdown · ${_fmtShortDate(breakdown.t)}</div>
        <div class="body-split-bar" role="img" aria-label="${label}">${segs}</div>
        <div class="body-split-legend" style="--n:${breakdown.segments.length}">${legend}</div>
      </div>
    `;
  }

  /** Re-renders just the Weight & Composition card after a tab/range tap. */
  _refreshBodyCard() {
    const el = this._container.querySelector('.overview-body-card');
    if (!el) return;
    // The tab strip scrolls sideways on narrow screens — keep its position
    // across the re-render so tapping a tab far along it doesn't snap the
    // strip back to Weight.
    const scrollLeft = el.querySelector('.body-tabs')?.scrollLeft ?? 0;
    el.outerHTML = this._bodyCard();
    const tabs = this._container.querySelector('.overview-body-card .body-tabs');
    if (tabs) tabs.scrollLeft = scrollLeft;
    this._bindBodyCard();
  }

  _bindBodyCard() {
    this._container.querySelectorAll('[data-body-metric]').forEach(btn =>
      btn.addEventListener('click', () => { this._bodyMetric = btn.dataset.bodyMetric; this._refreshBodyCard(); })
    );
    this._container.querySelectorAll('[data-body-range]').forEach(btn =>
      btn.addEventListener('click', () => { this._bodyRange = btn.dataset.bodyRange; this._refreshBodyCard(); })
    );
    this._container.querySelector('[data-body-review]')?.addEventListener('click', () => this._onReviewWeighIns?.());
    this._drawBodyChart();
    this._watchBodyWidth(this._container.querySelector('[data-body-chart]'));
  }

  /** Redraws the chart if the card's width changes (rotation, window
   *  resize, or the Overview tab becoming visible after having rendered
   *  while hidden — that first draw falls back to a default width). */
  _watchBodyWidth(host) {
    if (typeof ResizeObserver === 'undefined') return;
    this._bodyResize ??= new ResizeObserver(() => {
      const el = this._container.querySelector('[data-body-chart]');
      const w = el ? Math.round(el.clientWidth) : 0;
      if (w && Math.abs(w - this._bodyWidth) > 1) this._drawBodyChart();
    });
    this._bodyResize.disconnect();
    if (host) this._bodyResize.observe(host);
  }

  /** Fills the card's chart host with the SVG at its real pixel width and
   *  wires scrub/hover: pointer x → nearest reading → guide line, dots and a
   *  readout line above the chart. Touch-action is pan-y (style.css), so a
   *  horizontal drag scrubs while a vertical one still scrolls the page. */
  _drawBodyChart() {
    const m = this._bodyModel;
    const host = this._container.querySelector('[data-body-chart]');
    const readout = this._container.querySelector('[data-body-readout]');
    if (!m || m.empty || !host) return;

    if (!m.count) {
      host.innerHTML = '<p class="body-chart-empty">No readings in this range — try a longer one.</p>';
      if (readout) readout.textContent = '';
      return;
    }

    const width = Math.round(host.clientWidth) || 320;
    const height = Math.round(Math.min(132, Math.max(104, width * 0.3)));
    this._bodyWidth = width;

    const { svg, hits } = renderBodyHistoryChart({
      width, height,
      domain: m.domain,
      series: m.series,
      zeroBaseline: m.zeroBaseline,
      integerAxis: m.integerAxis,
      formatTick: m.fmtTick,
      formatDate: _fmtAxisDate,
      ariaLabel: `${m.title} history, ${m.count} reading${m.count === 1 ? '' : 's'}`,
    });
    host.innerHTML = svg;

    const spanDays = (m.domain.endT - m.domain.startT) / DAY;
    const idleText = `${_fmtAxisDate(m.domain.startT, spanDays)} – ${_fmtAxisDate(m.domain.endT, spanDays)} · ${m.count} reading${m.count === 1 ? '' : 's'}`;
    if (readout) readout.textContent = idleText;

    const svgEl = host.querySelector('svg');
    if (!svgEl || !hits.length) return;
    const guide = svgEl.querySelector('.bh-guide');
    const dots = new Map([...svgEl.querySelectorAll('.bh-hover-dot')].map(d => [d.dataset.key, d]));
    const unitSuffix = m.unit ? (m.unit === '%' ? '%' : ` ${m.unit}`) : '';

    const show = clientX => {
      const rect = svgEl.getBoundingClientRect();
      if (!rect.width) return;
      const hit = _nearestHit(hits, ((clientX - rect.left) / rect.width) * width);
      if (!hit) return;
      guide.setAttribute('x1', hit.x);
      guide.setAttribute('x2', hit.x);
      guide.setAttribute('visibility', 'visible');
      for (const [key, dot] of dots) {
        const item = hit.items.find(i => i.key === key);
        if (item) {
          dot.setAttribute('cx', hit.x);
          dot.setAttribute('cy', item.y);
          dot.setAttribute('visibility', 'visible');
        } else {
          dot.setAttribute('visibility', 'hidden');
        }
      }
      if (readout) {
        const parts = hit.items.map(i => `${hit.items.length > 1 ? `${i.label} ` : ''}${m.fmt(i.v)}${unitSuffix}`);
        readout.textContent = `${_fmtFullDate(hit.t)} · ${parts.join(' · ')}`;
      }
    };
    const reset = () => {
      guide.setAttribute('visibility', 'hidden');
      dots.forEach(d => d.setAttribute('visibility', 'hidden'));
      if (readout) readout.textContent = idleText;
    };

    svgEl.addEventListener('pointerdown', e => show(e.clientX));
    svgEl.addEventListener('pointermove', e => show(e.clientX));
    // Mouse: clear on leave. Touch: leave the last-touched reading up after
    // the finger lifts (pointerleave fires on release for touch) so it can
    // actually be read; the next touch or a re-render replaces it.
    svgEl.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') reset(); });
  }

  /** One thin stacked bar plus a legend — the compact form of a time-in-zone
   *  card, shared by the two zone cards and the nutrition card's macro split.
   *  Each segment is `{ key, name, pct, color, detail }`; the bar's width shares are
   *  the percentages, and the legend keeps one short key ("Z2 32%") per segment
   *  with the full name and time in its tooltip and the bar's aria-label (a
   *  segment at 0% keeps its legend key, dimmed, so the set of zones never
   *  changes shape between riders). */
  _stackedBar(segments) {
    const label = segments.map(z => `${z.name} ${z.pct}%`).join(', ');
    const bar = segments.filter(z => z.pct > 0).map(z =>
      `<span style="flex:${z.pct} 1 0; background:${z.color}" title="${_esc(z.name)} \u00b7 ${_esc(z.detail)}"></span>`).join('');
    const legend = segments.map(z => `
      <span class="overview-stack-key${z.pct > 0 ? '' : ' is-zero'}" title="${_esc(z.name)} \u00b7 ${_esc(z.detail)}">
        <i style="background:${z.color}"></i>${_esc(z.key)} <b>${z.pct}%</b>
      </span>`).join('');
    return `
      <div class="overview-stack-bar" role="img" aria-label="${_esc(label)}">${bar || '<span class="overview-stack-none"></span>'}</div>
      <div class="overview-stack-legend">${legend}</div>
    `;
  }

  _zonesCard(zoneDist) {
    const segs = zoneDist.map(z => ({
      key: `Z${z.zone}`, name: `Z${z.zone} ${z.name}`, pct: z.pct, color: z.color,
      detail: `${z.pct}% \u00b7 ${_fmtDuration(z.seconds)}`,
    }));
    return `
      <section class="settings-card overview-zones-card">
        ${_plainTitle('Power Zones \u2014 30 Days')}
        ${this._stackedBar(segs)}
      </section>
    `;
  }

  /** Time-in-zone for heart rate, over the same last-30-days window as
   *  _zonesCard()'s power version — same stacked bar, just fed by
   *  metrics/hr-zones.js's timeInZonesHr() instead of ftp-zones.js's
   *  timeInZones(). Readiness (overview-cards.js) already guarantees maxHr is
   *  resolvable and at least one session in the window has heart-rate data by
   *  the time this draws. */
  _hrZonesCard(zoneDist) {
    const segs = zoneDist.map(z => ({
      key: `Z${z.zone}`, name: `Z${z.zone} ${z.name}`, pct: z.pct, color: z.color,
      detail: `${z.pct}% \u00b7 ${_fmtDuration(z.seconds)}`,
    }));
    return `
      <section class="settings-card overview-zones-card">
        ${_plainTitle('Heart Rate Zones \u2014 30 Days')}
        ${this._stackedBar(segs)}
      </section>
    `;
  }

  /** Today's saved FTP as a plain readout (Zones category), distinct from
   *  _pwrCard()'s Power-to-Weight ratio below. Same half-width shell as
   *  that card and _vo2MaxCard() so the three pair up two-to-a-row. */
  _ftpCard(profile) {
    return `
      <section class="settings-card overview-tile-half">
        ${_plainTitle('FTP')}
        <div class="overview-pwr-row">
          <div>
            <span class="overview-pwr-value">${profile.ftp}</span>
            <span class="overview-pwr-unit">W</span>
          </div>
        </div>
      </section>
    `;
  }

  /** Today's resting/max HR as a plain readout — the Body → Heart
   *  card. It isn't a 30-day resting-HR
   *  sparkline because nothing in the app stores a daily HR history to chart
   *  (only the one live profile.restingHr/maxHr value — see
   *  metrics/hr-zones.js) — a real trend would need a new per-day HR
   *  record (written once a day, alongside or instead of a Resting HR
   *  Test result) and a rolling-window reader modeled on
   *  metrics/body-history.js's buildBodyHistory(). Until that lands, this
   *  reads today's two numbers side by side, same shell _weekCard()'s
   *  stat-chip row uses. Half-width — see HALF_WIDTH_CARDS. */
  _heartCard(profile) {
    return `
      <section class="settings-card overview-tile-half">
        ${_plainTitle('Heart')}
        <div class="history-card-stats overview-heart-stats">
          <div class="stat-chip" data-metric="heartRate"><span class="stat-val">${profile.restingHr ?? '—'}</span><span class="stat-lbl">RESTING</span></div>
          <div class="stat-chip" data-metric="heartRate"><span class="stat-val">${profile.maxHr ?? estimateMaxHr(profile.age) ?? '—'}</span><span class="stat-lbl">MAX</span></div>
        </div>
      </section>
    `;
  }

  _pwrCard(ratio, profile) {
    const tier = PWR_TIERS.find(t => ratio < t.max)?.label ?? 'Elite';
    return `
      <section class="settings-card overview-tile-half">
        ${_plainTitle('Power-to-Weight')}
        <div class="overview-pwr-row">
          <div>
            <span class="overview-pwr-value">${ratio.toFixed(2)}</span>
            <span class="overview-pwr-unit">W/kg</span>
          </div>
          <span class="overview-pwr-tier">${tier}</span>
        </div>
      </section>
    `;
  }

  /** Mirrors the Settings → Profile VO2max readout (see app.js
   *  _renderVo2MaxCard()) — same profile.vo2Max/vo2MaxDate fields, so a
   *  freshly-completed ramp test shows up here the next time this tab is
   *  opened (switchTab('overview') calls load()), no extra wiring needed. */
  _vo2MaxCard(profile) {
    return `
      <section class="settings-card overview-tile-half">
        ${_plainTitle('VO2 Max')}
        <div class="overview-pwr-row">
          <div>
            <span class="overview-pwr-value">${profile.vo2Max}</span>
            <span class="overview-pwr-unit">mL/kg/min</span>
          </div>
        </div>
      </section>
    `;
  }

  _bestsCard(bests, units) {
    // Each best is a .stat-chip, so it carries the same metric rule + wash as every other
    // readout; the data-metric is the one the same figure uses elsewhere (peak power orange,
    // NP its muted orange, distance blue; a duration has no colour of its own, so TIME's neutral).
    const items = [
      ['Peak',     'icon-lightning', 'power',    bests.peakPower != null ? `${Math.round(bests.peakPower)} W`    : '—', bests.peakPowerDate],
      ['NP',       'icon-activity',  'np',       bests.bestNp    != null ? `${Math.round(bests.bestNp)} W`       : '—', bests.bestNpDate],
      ['Longest',  'icon-flag',      'time',     bests.longest   != null ? _fmtBestDuration(bests.longest)       : '—', bests.longestDate],
      ['Furthest', 'icon-bike',      'distance', bests.furthest  != null ? formatDistance(bests.furthest, units) : '—', bests.furthestDate],
    ];
    const cells = items.map(([label, icon, metric, val, ts]) => `
      <div class="overview-best-item stat-chip" data-metric="${metric}">
        <svg class="btn-icon overview-best-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#${icon}"/></svg>
        <span class="stat-val">${val}</span>
        <span class="stat-lbl">${label}</span>
        ${ts ? `<span class="overview-best-date">${_fmtShortDate(ts)}</span>` : ''}
      </div>
    `).join('');

    return `
      <section class="settings-card overview-bests-card">
        <h2 class="settings-title">Bests</h2>
        <div class="overview-bests-grid">${cells}</div>
      </section>
    `;
  }

  /** One session as History's own poster tile — the same markup (session-poster.js's
   *  posterTileBody()) in the same `.history-week-grid` > `.history-item` > `.history-poster`
   *  nesting History uses, so it takes every one of History's styles and cannot drift from
   *  them. The only difference is what a tap does: it opens the History tab (`data-goto-history`)
   *  rather than expanding in place.
   *  @param {Object} s @param {string} units */
  _posterTile(s, units) {
    return `
      <div class="history-item">
        <div class="history-poster" data-goto-history role="button" tabindex="0">${posterTileBody(s, units)}</div>
      </div>
    `;
  }

  _recentCard(units) {
    const tiles = this._sessions.slice(0, RECENT_COUNT).map(s => this._posterTile(s, units)).join('');

    return `
      <section class="overview-recent-section">
        <div class="overview-card-head">
          <h2 class="settings-title">Recent</h2>
          <button class="btn btn-ghost btn-sm" data-goto-history>See all ›</button>
        </div>
        <div class="history-week-grid">${tiles}</div>
      </section>
    `;
  }
}

// ─── Aggregation helpers ──────────────────────────────────────────────────

function _aggregate(sessions) {
  const count    = sessions.length;
  const duration = sessions.reduce((a, s) => a + (s.duration || 0), 0);
  const distance = sessions.reduce((a, s) => a + (s.summary?.totalDistance || 0), 0);
  const calories = sessions.reduce((a, s) => a + (s.summary?.totalCalories || 0), 0);
  const powers   = sessions.map(s => s.summary?.avgPower).filter(v => v != null);
  const avgPower = powers.length ? Math.round(powers.reduce((a, b) => a + b, 0) / powers.length) : null;
  return { count, duration, distance, calories, avgPower };
}

/** Last 7 days' Diet-tab rollup, same plain-timestamp-filter style as
 *  _aggregate()/_weeklyTrend() above.
 *
 *  Diary entries are bucketed by calendar day first (same toDateString()
 *  grouping views/diet.js's _pastDayGroups()/_todayEntries() use, and the
 *  same sumNutrients()/macroCalorieSplit() pipeline that feeds the Diet
 *  tab's own pie/history rows) so `daysLogged` counts distinct days, not
 *  entries — a day with three snacks logged doesn't inflate it.
 *
 *  `avgKcal` divides the week's total logged calories by `daysLogged`
 *  (days actually logged), not by 7 — otherwise a two-day-old habit would
 *  read as a suspiciously low daily average, and `daysLogged` is already
 *  its own separate X/7 stat for that signal. `targetKcal` mirrors
 *  metrics/nutrition.js's dailyCalorieBalance() differentiator (BMR +
 *  real logged exercise, not a generic activity-multiplier guess) but
 *  averaged across the full 7 calendar days including rest days, since a
 *  target is what the week's pace should be measured against, not just
 *  the days food happened to get logged; null exactly when estimateBmr()
 *  is null, same empty-until-filled-in pattern _pwrCard()/_vo2MaxCard()
 *  already follow for a missing FTP/VO2max.
 *
 * @param {Object[]}     diaryEntries  All diary entries (any date; filtered to the last 7 days internally).
 * @param {Object[]}     sessions      All sessions (any date; filtered to the last 7 days internally).
 * @param {number|null}  bmr           From estimateBmr(profile).
 * @returns {{ daysLogged: number, avgKcal: number, targetKcal: number|null,
 *             split: {proteinKcal: number, carbsKcal: number, fatKcal: number} }}
 */
function _weeklyNutrition(diaryEntries, sessions, bmr) {
  const now = Date.now();

  const byDay = new Map(); // dateStr (toDateString()) -> summed NutrientProfile
  for (const e of diaryEntries) {
    if (now - e.loggedAt >= 7 * DAY) continue;
    const key = new Date(e.loggedAt).toDateString();
    byDay.set(key, sumNutrients(byDay.get(key) ?? null, e.nutrients));
  }
  const daysLogged = byDay.size;

  const weekTotals = [...byDay.values()].reduce((acc, n) => sumNutrients(acc, n), null);
  const split = macroCalorieSplit(weekTotals);
  const totalKcal = split.proteinKcal + split.carbsKcal + split.fatKcal;
  const avgKcal = daysLogged ? totalKcal / daysLogged : 0;

  const exerciseKcal = sessions
    .filter(s => now - s.startTime < 7 * DAY)
    .reduce((sum, s) => sum + (s.summary?.totalCalories ?? 0), 0);
  const targetKcal = bmr != null ? bmr + exerciseKcal / 7 : null;

  return { daysLogged, avgKcal, targetKcal, split };
}

function _personalBests(sessions) {
  const b = {
    peakPower: null, peakPowerDate: null,
    bestNp:    null, bestNpDate:    null,
    longest:   null, longestDate:   null,
    furthest:  null, furthestDate:  null,
  };
  for (const s of sessions) {
    let maxP = 0;
    for (const sample of s.samples ?? []) if (sample.power > maxP) maxP = sample.power;
    if (maxP && (b.peakPower === null || maxP > b.peakPower)) { b.peakPower = maxP; b.peakPowerDate = s.startTime; }

    const np = s.summary?.normalizedPower;
    if (np && (b.bestNp === null || np > b.bestNp)) { b.bestNp = np; b.bestNpDate = s.startTime; }

    if (s.duration && (b.longest === null || s.duration > b.longest)) { b.longest = s.duration; b.longestDate = s.startTime; }

    const dist = s.summary?.totalDistance;
    if (dist && (b.furthest === null || dist > b.furthest)) { b.furthest = dist; b.furthestDate = s.startTime; }
  }
  return b;
}

/** Consecutive calendar days (ending today or yesterday) with >=1 session. */
function _streak(sessions) {
  const days = new Set(sessions.map(s => new Date(s.startTime).toDateString()));
  let cursor = new Date();
  if (!days.has(cursor.toDateString())) cursor = new Date(cursor.getTime() - DAY);
  let streak = 0;
  while (days.has(cursor.toDateString())) {
    streak++;
    cursor = new Date(cursor.getTime() - DAY);
  }
  return streak;
}

/** Total minutes trained per week, oldest → newest, current week last. */
function _weeklyTrend(sessions, weeks) {
  const now = Date.now();
  const buckets = Array.from({ length: weeks }, () => 0);
  for (const s of sessions) {
    const diffDays = Math.floor((now - s.startTime) / DAY);
    const weekIdx  = Math.floor(diffDays / 7);
    if (weekIdx >= 0 && weekIdx < weeks) buckets[weekIdx] += (s.duration || 0) / 60;
  }
  return buckets
    .map((minutes, i) => ({ minutes, label: i === 0 ? 'Now' : `-${i}w` }))
    .reverse();
}

/** Returns { cls, text } for the "This Week" card's header-right trend
 *  badge — cls is a .history-card-trend color modifier (see style.css),
 *  text is '' when there's nothing to show yet (no prior week to compare
 *  to). */
function _trendInfo(current, previous) {
  if (!previous) return current ? { cls: 'trend-new', text: 'New this week' } : { cls: '', text: '' };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { cls: 'trend-flat', text: 'Flat vs last week' };
  const up = pct > 0;
  return { cls: up ? 'trend-up' : 'trend-down', text: `${up ? '▲' : '▼'} ${Math.abs(pct)}% vs last week` };
}

function _greetingSub() {
  const h = new Date().getHours();
  if (h < 5)  return 'Late session? Here’s where things stand.';
  if (h < 12) return 'Good morning — here’s your training at a glance.';
  if (h < 18) return 'Good afternoon — here’s your training at a glance.';
  return 'Good evening — here’s your training at a glance.';
}

/** The Longest personal best, sized for a four-across row: seconds are kept
 *  under an hour ("45m 12s"), dropped once there are hours ("1h 29m"). */
function _fmtBestDuration(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return _fmtDurationWithSeconds(sec);
}

/** Same as _fmtDuration but keeps seconds — used for the Longest Ride
 *  personal best, where the extra precision is worth the space. */
function _fmtDurationWithSeconds(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function _fmtShortDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** X-axis tick label — "Sep 20", or "Sep 2026" once the span is long enough
 *  that a bare month/day would be ambiguous. */
function _fmtAxisDate(ts, spanDays) {
  const opts = spanDays > 330 ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' };
  return new Date(ts).toLocaleDateString('en-US', opts);
}

/** Readout-line date — always with the year, since the scrub readout can
 *  land anywhere in a multi-year history. */
function _fmtFullDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Reading nearest to `x` in an x-ascending hit table (binary search). */
function _nearestHit(hits, x) {
  if (!hits.length) return null;
  let lo = 0;
  let hi = hits.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].x < x) lo = mid; else hi = mid;
  }
  return Math.abs(hits[lo].x - x) <= Math.abs(hits[hi].x - x) ? hits[lo] : hits[hi];
}

/** Small "i" button next to a header. Its tooltip (ux/info-tooltip.js — one
 *  delegated listener on `document` drives every [data-tip], so markup added
 *  here needs no wiring) carries the explanation for that header. `subject` is plain text for the aria-label. */
function _infoBtn(tip, subject) {
  return `<button type="button" class="info-btn" aria-label="More info about ${_esc(subject)}" data-tip="${_esc(String(tip).trim())}"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-info"/></svg></button>`;
}

/** A card's .settings-title with its info button on the same line.
 *  `titleHtml` is markup the caller has already made safe (a literal, with
 *  &amp; for an ampersand); `subject` defaults to it as plain text and only
 *  needs passing when the markup contains entities. */
// ─── Ghosted card visuals ─────────────────────────
// What an empty card shows between its title and its "Needs ..." hint: a
// low-contrast stand-in built from the real card's own classes (so it takes
// the real card's size and rhythm, and needs almost no CSS of its own), with
// "—" for every number. Decorative only — the wrapper is aria-hidden and
// pointer-events:none (.overview-ghost in style.css); the title and hint carry
// the meaning. Keep these in step with the card they stand in for: if a card's
// layout changes, its ghost should change with it.
const GHOST_ZONE_WIDTHS = [14, 44, 62, 40, 24, 10, 6];
const GHOST_BAR_HEIGHTS = [30, 55, 40, 70, 50, 85, 60, 35];
const GHOST_BEST_ICONS = [['Peak', 'icon-lightning'], ['NP', 'icon-activity'], ['Longest', 'icon-flag'], ['Furthest', 'icon-bike']];

const _ghostChips = (labels) => labels.map(l =>
  `<div class="stat-chip"><span class="stat-val">\u2014</span><span class="stat-lbl">${l}</span></div>`).join('');
const _ghostReadout = (unit) =>
  `<div class="overview-pwr-row"><div><span class="overview-pwr-value">\u2014</span><span class="overview-pwr-unit">${unit}</span></div></div>`;
// One thin segmented strip (a flex share per zone) rather than a row per zone:
// the real list is 5-7 rows tall, and a ghost that tall only pushes the card's
// hint further down the page, under the rail. The strip keeps the shape of "time
// split across zones" at about a tenth of the height.
const _ghostStrip = (widths) =>
  `<div class="overview-ghost-strip">${widths.map(w => `<span style="flex:${w} 1 0"></span>`).join('')}</div>`;

function _ghostVisual(id) {
  switch (id) {
    case 'week':
      return `<div class="history-card-stats">${_ghostChips(['SESSIONS', 'TIME', 'DIST', 'KCAL'])}</div>`;
    case 'year':
      return `<div class="year-grid">${Array.from({ length: 12 }, () => '<span class="year-cell" data-level="0"></span>').join('')}</div>`;
    case 'volume':
      return `${_ghostReadout('this week')}
        <div class="overview-weekly-chart overview-weekly-chart-compact">${GHOST_BAR_HEIGHTS.map(h =>
          `<div class="overview-bar-col"><div class="overview-bar-track"><div class="overview-bar" style="height:${h}%"></div></div></div>`).join('')}</div>`;
    case 'nutrition':
      return `${_ghostReadout('avg kcal/day')}${_ghostStrip([30, 45, 25])}`;
    case 'body':
      return `<svg class="overview-ghost-line" viewBox="0 0 300 70" preserveAspectRatio="none">
        <path d="M0 58 C30 52 50 56 80 44 S130 38 160 30 S230 26 300 10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="2 7"/>
      </svg>`;
    case 'heart':
      return `<div class="history-card-stats overview-heart-stats">${_ghostChips(['RESTING', 'MAX'])}</div>`;
    case 'zones':
      return _ghostStrip(GHOST_ZONE_WIDTHS);
    case 'hrzones':
      return _ghostStrip(GHOST_ZONE_WIDTHS.slice(0, 5));
    case 'pwr':    return _ghostReadout('W/kg');
    case 'vo2max': return _ghostReadout('mL/kg/min');
    case 'ftp':    return _ghostReadout('W');
    case 'bests':
      return `<div class="overview-bests-grid">${GHOST_BEST_ICONS.map(([label, icon]) => `
        <div class="overview-best-item stat-chip">
          <svg class="btn-icon overview-best-icon" viewBox="0 0 24 24"><use href="#${icon}"/></svg>
          <span class="stat-val">\u2014</span><span class="stat-lbl">${label}</span>
        </div>`).join('')}</div>`;
    case 'recent':
      return `<div class="history-week-grid">${[0, 1].map(() => `
        <div class="history-item"><div class="history-poster">
          <div class="history-poster-head"><span class="history-poster-chip">\u2014</span><span class="history-poster-name">Session</span></div>
          <div class="history-poster-spark history-poster-spark-empty"></div>
          <div class="history-poster-stats">
            <div data-metric="time"><span class="stat-val">\u2014</span><span class="stat-lbl">TIME</span></div>
            <div data-metric="power"><span class="stat-val">\u2014</span><span class="stat-lbl">AVG W</span></div>
            <div data-metric="hr"><span class="stat-val">\u2014</span><span class="stat-lbl">HR</span></div>
          </div>
        </div></div>`).join('')}</div>`;
    default:
      return '';
  }
}

/** A card title with no (i): its explanation is in the card's detail sheet. */
function _plainTitle(titleHtml) {
  return `<div class="settings-title-line"><h2 class="settings-title">${titleHtml}</h2></div>`;
}

/** Makes a card's root element a button that opens its detail sheet (see OverviewPage._bind()). */
function _asDetailButton(id, html) {
  if (!DETAIL_IDS.includes(id)) return html;
  return html.replace(/<section/, `<section data-detail="${id}" role="button" tabindex="0" aria-haspopup="dialog"`);
}

/** A detail model (views/overview-detail.js) as the sheet's body. */
function _detailHtml(model) {
  const rows = model.rows.map(r => `
    <div class="ov-detail-row"${r.metric ? ` data-metric="${r.metric}"` : ''}${r.color ? ` style="--row-color:${r.color}"` : ''}>
      <span class="ov-detail-label">${_esc(r.label)}</span>
      <span class="ov-detail-value">${_esc(r.value)}</span>
      ${r.note ? `<span class="ov-detail-note">${_esc(r.note)}</span>` : ''}
    </div>`).join('');
  return `<p class="ov-detail-about">${_esc(model.about)}</p><div class="ov-detail-list">${rows}</div>`;
}

function _titleLine(titleHtml, tip, subject = titleHtml) {
  return `<div class="settings-title-line"><h2 class="settings-title">${titleHtml}</h2>${_infoBtn(tip, subject)}</div>`;
}

function _esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export default OverviewPage;
