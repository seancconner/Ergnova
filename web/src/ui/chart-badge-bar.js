// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/chart-badge-bar.js
 *
 * The live chart's badge bar: one row of small readouts that sits in the chart
 * panel above the swipeable chart track and does not move when the chart is swiped: Zone, Calories, a
 * rotating badge, Distance and Pace.
 *
 * The bar is not part of ChartCarousel (which used to build a copy of it inside every page): it is told
 * which page is on screen (setActive) and, on the All page, which metric the rotating hero numeral is on
 * right now (its second argument, then setHero on each of the hero's own steps) — both only matter for the
 * rotating badge below, which must not show the same metric the hero is already reading out.
 *
 * The rotating badge sits between Calories and Distance. It cycles on its own timer (ROTATOR_INTERVAL_MS,
 * chart-badge-logic.js) through whichever of Power / Heart rate / Cadence / Speed is not the metric on
 * screen (rotatorDefs()) — a rider parked on the Power chart for a whole session otherwise never sees
 * Cadence or Heart rate again until they swipe away from it. With only one metric left to show (or none), the rotation just holds still on it rather than animating
 * — the Zone / Calories / Distance / Pace badges beside it never move at all either.
 *
 * Two modes. On a metric's own page the hero holds still, so the badge rotates on its own timer through
 * the other metrics (above). On the All page the hero is itself rotating, and the badge has no timer of its
 * own: it is the hero's partner — oppositeKey(), the metric half a rotation away — and changes in the same
 * tick as the hero (setHero), so the two can never drift apart or show the same metric. Either way it
 * stands still while the chart is held (setPausedProbe): the hero's tick skips while ChartCarousel#locked
 * is true, and the badge's follows the same signal, so a long-press freezes both.
 *
 * Usage:
 *   const bar = new ChartBadgeBar(document.getElementById('chart-container'));   // prepends itself
 *   bar.setMetrics([{ key: 'power', label: 'Power', color, unit: 'W', fmt: v => Math.round(v) }, …]);
 *   bar.setStats([{ key: 'zone', label: 'Zone', getValue: s => s, fmt: s => …, getColor: s => … }, …]);
 *   bar.setActive('power');     // the carousel's onActiveMetric key (or its All page's key); on the All page
 *                               // pass the metric its rotating hero is on as the 2nd argument
 *   bar.setHero('heartRate');   // the All page's hero moved on to another metric
 *   bar.setHeroRing(['power', …]);   // the order the hero rotates in (the All page's metric keys)
 *   bar.setPausedProbe(() => carousel.locked);   // true while the chart is held: no stepping
 *   bar.setLatest(sample);      // every live sample; null on a reset
 */

import { metricBadgeText, rotatorDefs, oppositeKey, ROTATOR_INTERVAL_MS } from './chart-badge-logic.js';

export class ChartBadgeBar {
  /** @param {HTMLElement} container  the chart panel; the bar is inserted as its first child */
  constructor(container) {
    this._el = document.createElement('div');
    this._el.className = 'chart-badge-bar hidden';
    this._el.setAttribute('role', 'group');
    this._el.setAttribute('aria-label', 'Live readings');

    this._metricDefs = [];   // [{ key, label, color, unit, fmt }] — power/heartRate/cadence/speed
    this._statDefs   = [];   // [{ key, label, getValue, fmt, getColor }] — zone/calories/distance/pace
    this._active = null;
    this._hero = null;       // the metric the All page's rotating hero is on (null on every other page)
    this._ring = [];         // the order the All page's hero rotates in — what oppositeKey() measures half a turn along
    this._isPaused = () => false;   // see setPausedProbe()
    this._shownKey = null;   // the metric the rotating badge was last drawn on (to tell a real step from a redraw)
    this._rotatorKeys = [];  // rotatorDefs()' keys, this render — just to detect when the set changes
    this._rotatorIndex = 0;
    this._rotatorTimer = null;
    this._latest = null;

    container.prepend(this._el);
  }

  get element() { return this._el; }

  /** Power / heart rate / cadence / speed — whichever the chart currently has a page for. Not rendered
   *  as badges of their own any more (see this file's doc comment); kept only as the rotating badge's
   *  pool. @param {{key:string, label:string, color:string, unit?:string, fmt:Function}[]} defs */
  setMetrics(defs) {
    this._metricDefs = defs ?? [];
    this._el.classList.toggle('hidden', this._metricDefs.length === 0);   // no sensor yet: the Connect tile keeps the room
    this._rebuildRotator({ reset: true });
  }

  /** Zone / Calories / Distance / Pace. Called again when the active page changes (Zone is the heart-rate
   *  zone on the heart-rate page and the power zone elsewhere) and when the units change.
   *  @param {{key:string, label:string, getValue:Function, fmt:Function, getColor?:Function}[]} defs */
  setStats(defs) {
    this._statDefs = defs ?? [];
    this._el.classList.toggle('hidden', this._metricDefs.length === 0);   // no sensor yet: the Connect tile keeps the room
    this._rebuildRotator();
  }

  /** The key of the page now on screen (a metric, or the All page's key).
   *  @param {string|null} key
   *  @param {string|null} [heroKey]  on the All page, the metric its rotating hero is on right now */
  setActive(key, heroKey = null) {
    this._active = key ?? null;
    this._hero = heroKey ?? null;
    this._rebuildRotator({ reset: true });   // a fresh chart on screen — start its rotation from the top
  }

  /** The All page's hero stepped to another metric: the badge steps with it, to the hero's partner
   *  (oppositeKey()), in this same call — and with the same fade the hero's own readout replays. No timer
   *  is involved, so there is nothing to drift. No-op when the hero is already on that metric.
   *  @param {string|null} heroKey */
  setHero(heroKey) {
    if ((heroKey ?? null) === this._hero) return;
    this._hero = heroKey ?? null;
    this._rebuildRotator({ step: true });
  }

  /** The order the All page's hero rotates in — the metric keys of its rotation, SmO2 and core temp
   *  included — which is what "half a rotation away" is measured along. Changes when a sensor pairs or
   *  unpairs. @param {string[]} keys */
  setHeroRing(keys) {
    this._ring = [...(keys ?? [])];
    if (this._hero != null) this._rebuildRotator();
  }

  /** `fn()` returns true while the badge must hold still: the live chart is being held (its crosshair
   *  focus-lock), the same condition under which the hero stops stepping. Asked at each tick of the badge's
   *  own timer (a metric's own page); on the All page the badge follows the hero, which is already holding.
   *  @param {() => boolean} fn */
  setPausedProbe(fn) {
    this._isPaused = typeof fn === 'function' ? fn : () => false;
  }

  /** The newest sample, or null after a reset.
   *  @param {Object|null} sample */
  setLatest(sample) {
    this._latest = sample ?? null;
    this._render();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  _makeItem(def) {
    const item = document.createElement('div');
    item.className = 'chart-badge-item';
    item.dataset.badge = def.key;
    item.innerHTML = '<span class="chart-badge-value">\u2014</span><span class="chart-badge-label"></span>';
    item.querySelector('.chart-badge-label').textContent = def.label;
    return item;
  }

  /** Make the row's children match `defs` by key, in order — creating only what is missing, removing
   *  only what is no longer wanted, and updating the label/colour of anything that stays (so a fade or
   *  other transition already under way on it is not restarted). */
  _reconcile(defs) {
    const row = this._el;
    const byKey = new Map([...row.children].map(el => [el.dataset.badge, el]));
    const wanted = new Set(defs.map(d => d.key));
    for (const [key, el] of byKey) if (!wanted.has(key)) { el.remove(); byKey.delete(key); }
    defs.forEach((def, i) => {
      let el = byKey.get(def.key);
      if (!el) el = this._makeItem(def);
      else {
        el.querySelector('.chart-badge-label').textContent = def.label;
        if (def.color) el.style.setProperty('--chip-color', def.color);
      }
      if (!el.parentNode) row.appendChild(el);
      else if (row.children[i] !== el) row.insertBefore(el, row.children[i] ?? null);
    });
  }

  /** The row's full def list, Zone / Calories / [rotating badge] / Distance / Pace — the rotating badge
   *  spliced in right after Calories, omitted entirely when there is nothing left to rotate through
   *  (every badge metric is the one already on screen or on the hero). `reset` restarts its position at
   *  the first metric of the new pool — used when the chart on screen changes, so each chart's rotation
   *  always starts from the same place rather than wherever the previous chart's happened to land.
   *  `step` is a real change of the hero's metric (the All page), so the badge's change is animated. */
  _rebuildRotator({ reset = false, step = false } = {}) {
    const pool = rotatorDefs(this._metricDefs, this._active, this._hero);
    const keys = pool.map(d => d.key);
    const shownKey = this._rotatorKeys[this._rotatorIndex];   // what the badge is on now, before the pool changes
    this._rotatorKeys = keys;
    if (reset) this._rotatorIndex = 0;
    else if (keys.includes(shownKey)) this._rotatorIndex = keys.indexOf(shownKey);   // the pool moved under it: stay put
    // (else the metric it was on just became the hero's: the index now points at whatever followed it)
    if (this._rotatorIndex >= pool.length) this._rotatorIndex = 0;

    // On the All page (a hero metric is set) the badge follows the hero and has no timer: it changes in
    // setHero(), so it cannot drift, and holds whenever the hero holds. On a metric's own page it turns
    // over on its own timer. A change that is not a fresh chart (a unit change, a new ring) must not
    // restart that dwell.
    if (this._hero != null || pool.length < 2) this._stopRotatorTimer();
    else if (reset || !this._rotatorTimer) {
      this._stopRotatorTimer();
      this._rotatorTimer = setInterval(() => this._tickRotator(), ROTATOR_INTERVAL_MS);
    }

    this._applyRotatorFrame({ animate: step });
  }

  _tickRotator() {
    if (this._rotatorKeys.length < 2) return;   // belt and braces — the timer is stopped in this case
    if (this._isPaused()) return;               // the chart is held: stand still, as the hero does (setPausedProbe)
    this._rotatorIndex = (this._rotatorIndex + 1) % this._rotatorKeys.length;
    this._applyRotatorFrame({ animate: true });
  }

  /** The def the rotating badge is on right now, or null when there is nothing to show. With a hero metric
   *  set (the All page) that is the hero's partner; otherwise the pool's current step. The one place that
   *  decides it, so what is drawn and what is rendered cannot disagree. */
  _rotatingDef() {
    const pool = rotatorDefs(this._metricDefs, this._active, this._hero);
    if (this._hero != null) {
      const partner = oppositeKey(this._ring, this._hero, this._metricDefs.map(d => d.key));
      return pool.find(d => d.key === partner) ?? null;
    }
    return pool[this._rotatorIndex] ?? null;
  }

  /** Builds the row's def list for the rotating badge's *current* step and reconciles the DOM to it.
   *  `animate` re-triggers the badge's fade-in (see .chart-badge-item.rotator-in in style.css) so a
   *  change the timer or the hero made reads as an arrival rather than a snap — but only if the metric
   *  shown actually changed: most calls are the units changing or a new page landing on the same step. */
  _applyRotatorFrame({ animate }) {
    const rotating = this._rotatingDef();
    const changed = (rotating?.key ?? null) !== this._shownKey;
    this._shownKey = rotating?.key ?? null;

    const defs = [...this._statDefs];
    if (rotating) {
      const at = defs.findIndex(d => d.key === 'calories');
      const def = { ...rotating, key: 'rotator', getValue: s => s?.[rotating.key], fmt: rotating.fmt };
      defs.splice(at >= 0 ? at + 1 : defs.length, 0, def);
    }
    this._reconcile(defs);
    this._render();

    if (animate && changed) {
      const item = this._el.querySelector('[data-badge="rotator"]');
      if (item && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        item.classList.remove('rotator-in');
        void item.offsetWidth;
        item.classList.add('rotator-in');
      }
    }
  }

  _stopRotatorTimer() {
    if (this._rotatorTimer) { clearInterval(this._rotatorTimer); this._rotatorTimer = null; }
  }

  _render() {
    const last = this._latest;
    for (const def of this._statDefs) {
      const item = this._el.querySelector(`[data-badge="${def.key}"]`);
      const value = item?.querySelector('.chart-badge-value');
      if (!value) continue;
      const raw = last ? def.getValue(last) : null;
      value.textContent = def.fmt(raw);
      // A badge can colour itself per reading (Zone does): setting --chip-color on the item drives the
      // value's rule and wash together. With none, remove it so the static [data-badge] rule (or the
      // neutral fallback) takes back over — an *empty* custom property would suppress var()'s fallback.
      const dynamic = def.getColor?.(raw);
      if (dynamic) item.style.setProperty('--chip-color', dynamic);
      else item.style.removeProperty('--chip-color');
    }
    const rotating = this._el.querySelector('[data-badge="rotator"]');
    if (rotating) {
      const def = this._rotatingDef();
      const value = rotating.querySelector('.chart-badge-value');
      if (value && def) value.textContent = metricBadgeText(last?.[def.key], def);
      if (def?.color) rotating.style.setProperty('--chip-color', def.color);
    }
  }
}
