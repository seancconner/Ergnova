// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/hr-slot.js
 *
 * The live-session heart-rate slot.
 * One fixed-height slot with two faces that swap in place, so nothing around it jumps:
 *
 *   connected     -> a slim glass strip: a miniature chart behind the live value
 *   anything else -> a glass button with a heart, which is the only in-session way to get a strap
 *                    back (connect, or reconnect after a dropout)
 *
 * Statuses:
 *   'connected'     strip
 *   'connecting'    button, pulsing, not tappable (a connect is in flight — the rider's tap, or an
 *                   automatic attempt that has just found the strap)
 *   'reconnecting'  button, pulsing, STILL TAPPABLE: the strap dropped and the app is listening for
 *                   it to come back on its own (app.js _watchForHrmReturn()). That wait has no
 *                   deadline — the strap may be flat or in a bag — and this button is the only
 *                   in-session way to get a heart rate, so a tap ends the wait and opens the
 *                   chooser instead of being swallowed
 *   'disconnected'  button, still, tappable — also what a *deliberate* disconnect shows: the rider
 *                   unplugged it themselves, so no "reconnecting" animation
 *
 * Shared on purpose: live cardio's HR display is meant to use the same slot.
 *
 * Pure helpers (state, markup, sparkline geometry) are exported separately and covered by
 * ui/__hr_slot_smoketest__.js; the DOM class is checked in the running app
 * (scripts/browser-checks/live-strength-hr-slot.py).
 */

export const HR_SLOT_STATUSES = ['connected', 'connecting', 'reconnecting', 'disconnected'];

/** Y range of the miniature chart (bpm) — the same 40–200 the old full-size chart used. */
export const HR_SPARK_RANGE = { yMin: 40, yMax: 200 };

/** How much history the miniature chart shows, in seconds. */
export const HR_SPARK_WINDOW_SEC = 120;

/**
 * What the slot should look like for a status. An unknown status reads as 'disconnected' — the
 * button is the safe face, because it is the one that lets the rider fix things.
 */
export function hrSlotState(status) {
  const s = HR_SLOT_STATUSES.includes(status) ? status : 'disconnected';
  const animating = s === 'connecting' || s === 'reconnecting';
  return {
    status: s,
    showStrip: s === 'connected',
    showButton: s !== 'connected',
    tappable: s === 'disconnected' || s === 'reconnecting',
    animating,
    label: s === 'connecting' ? 'Connecting…' : s === 'reconnecting' ? 'Reconnecting…' : 'Connect',
    ariaLabel:
      s === 'connected'    ? 'Heart rate' :
      s === 'connecting'   ? 'Connecting heart rate monitor' :
      s === 'reconnecting' ? 'Reconnecting heart rate monitor — tap to choose a different one' :
                             'Connect heart rate monitor',
  };
}

/** A bpm reading as the strip shows it: a whole number, or an em dash when there is none. */
export function formatHr(bpm) {
  return Number.isFinite(bpm) && bpm > 0 ? String(Math.round(bpm)) : '—';
}

/**
 * Turns timestamped readings into canvas points for the miniature chart. Readings older than the
 * window, or that are not real numbers, are dropped; the rest are clamped into the y range so a
 * glitchy 255 can't draw off the strip. x runs left (windowSec ago) to right (now).
 *
 * @param {{t:number, v:number}[]} readings   t in ms
 * @param {number} nowMs
 * @param {number} width   canvas CSS px
 * @param {number} height  canvas CSS px
 * @param {{windowSec?:number, yMin?:number, yMax?:number, pad?:number}} [opts]
 * @returns {{x:number, y:number}[]}
 */
export function sparkPoints(readings, nowMs, width, height, opts = {}) {
  const { windowSec = HR_SPARK_WINDOW_SEC, yMin = HR_SPARK_RANGE.yMin, yMax = HR_SPARK_RANGE.yMax, pad = 4 } = opts;
  const span = windowSec * 1000;
  const innerH = Math.max(1, height - pad * 2);
  const pts = [];
  for (const r of readings ?? []) {
    if (!r || !Number.isFinite(r.t) || !Number.isFinite(r.v) || r.v <= 0) continue;
    const age = nowMs - r.t;
    if (age < 0 || age > span) continue;
    const v = Math.min(yMax, Math.max(yMin, r.v));
    pts.push({
      x: width * (1 - age / span),
      y: pad + innerH * (1 - (v - yMin) / (yMax - yMin)),
    });
  }
  return pts;
}

/** Drops readings that have scrolled out of the window (keeps one just outside, so the line
 *  enters from the left edge instead of starting mid-strip). Returns a new array. */
export function trimReadings(readings, nowMs, windowSec = HR_SPARK_WINDOW_SEC) {
  const cutoff = nowMs - windowSec * 1000;
  const firstIn = readings.findIndex(r => r.t >= cutoff);
  if (firstIn === -1) return [];
  return readings.slice(Math.max(0, firstIn - 1));
}

/** The slot's markup. Both faces are always in the DOM; the class toggles which one shows. */
export function hrSlotHtml() {
  return `
    <div class="hr-slot" data-hr-slot data-state="disconnected">
      <div class="hr-slot-strip hidden" data-hr-strip role="img" aria-label="Heart rate">
        <canvas class="hr-slot-spark" data-hr-spark aria-hidden="true"></canvas>
        <svg class="btn-icon hr-slot-heart" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-heart"/></svg>
        <span class="hr-slot-value" data-hr-value>—</span>
        <span class="hr-slot-unit">bpm</span>
      </div>
      <button type="button" class="hr-slot-btn" data-hr-connect aria-label="Connect heart rate monitor">
        <svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-heart"/></svg>
        <span class="hr-slot-btn-label" data-hr-connect-label>Connect</span>
      </button>
    </div>`;
}

export class HrSlot {
  /**
   * @param {HTMLElement} container  an element containing hrSlotHtml()'s markup
   * @param {Object}   [opts]
   * @param {Function} [opts.onConnect]  () => void — the rider tapped the heart button. Omit and
   *                                     the button is shown but inert.
   * @param {string}   [opts.status]     status as of mount, so the first frame is right
   */
  constructor(container, { onConnect = null, status = 'disconnected' } = {}) {
    this._root = container.querySelector('[data-hr-slot]');
    this._strip = this._root.querySelector('[data-hr-strip]');
    this._btn = this._root.querySelector('[data-hr-connect]');
    this._btnLabel = this._root.querySelector('[data-hr-connect-label]');
    this._value = this._root.querySelector('[data-hr-value]');
    this._canvas = this._root.querySelector('[data-hr-spark]');
    this._onConnect = onConnect;
    this._readings = [];
    this._status = 'disconnected';

    this._btn.addEventListener('click', () => {
      // The status check is the real guard: a tap that lands between a state change and the DOM
      // catching up must not start a second connect. (The native `disabled` attribute is avoided
      // on purpose — some browsers dull a disabled <button> in ways CSS can't undo.)
      if (!hrSlotState(this._status).tappable) return;
      this._onConnect?.();
    });
    this._resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => this._draw())
      : null;
    this._resizeObserver?.observe(this._strip);

    this.setStatus(status);
  }

  get status() { return this._status; }

  setStatus(status) {
    const st = hrSlotState(status);
    this._status = st.status;
    this._root.dataset.state = st.status;
    this._strip.classList.toggle('hidden', !st.showStrip);
    this._btn.classList.toggle('hidden', !st.showButton);
    // 'is-pending' = in flight and not tappable (pointer events off); 'is-reconnecting' = pulsing
    // but live. Two classes because the pulse alone must not decide whether a tap lands.
    this._btn.classList.toggle('is-pending', st.animating && !st.tappable);
    this._btn.classList.toggle('is-reconnecting', st.animating && st.tappable);
    this._btn.setAttribute('aria-label', st.ariaLabel);
    this._btn.setAttribute('aria-disabled', String(!st.tappable || !this._onConnect));
    this._btn.tabIndex = st.tappable && this._onConnect ? 0 : -1;
    this._btnLabel.textContent = st.label;
    if (!st.showStrip) {
      // The strap is gone: don't leave a stale line (or number) waiting for when it comes back.
      this._readings = [];
      this._value.textContent = '—';
      this._clearCanvas();
    } else {
      this._draw();
    }
  }

  /** @param {number|null|undefined} bpm  one new reading; null/undefined is a gap, not a zero */
  push(bpm, nowMs = Date.now()) {
    if (this._status !== 'connected') return;
    this._value.textContent = formatHr(bpm);
    if (Number.isFinite(bpm) && bpm > 0) {
      this._readings = trimReadings([...this._readings, { t: nowMs, v: bpm }], nowMs);
    }
    this._draw(nowMs);
  }

  destroy() {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._readings = [];
  }

  _clearCanvas() {
    const ctx = this._canvas.getContext?.('2d');
    if (ctx) ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  }

  _draw(nowMs = Date.now()) {
    if (this._status !== 'connected') return;
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (this._canvas.width !== Math.round(w * dpr) || this._canvas.height !== Math.round(h * dpr)) {
      this._canvas.width = Math.round(w * dpr);
      this._canvas.height = Math.round(h * dpr);
    }
    const ctx = this._canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pts = sparkPoints(this._readings, nowMs, w, h);
    if (pts.length < 2) return;
    const color = getComputedStyle(this._root).getPropertyValue('--color-hr').trim() || '#f66';

    ctx.beginPath();
    ctx.moveTo(pts[0].x, h);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(pts[pts.length - 1].x, h);
    ctx.closePath();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = color;
    ctx.fill();

    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
