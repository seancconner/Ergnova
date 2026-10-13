// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * views/session-poster.js
 *
 * Shared pieces of the "poster" treatment a saved session gets wherever it is
 * drawn as a tile: the tiny signature sparkline, and
 * the tile's whole inner markup (date chip + name, sparkline, three readouts).
 * Lives here, rather than inside views/overview.js where it started, so
 * History's poster tiles (views/history-browser.js) and Overview's Recent
 * strip (views/overview.js) draw exactly the same tile — one implementation,
 * no copy to drift. Each caller wraps posterTileBody() in its own
 * `.history-poster` element, which carries what is particular to it (History's
 * expand behaviour, Overview's link to History).
 *
 * Pure (string in → string out, no DOM), so it runs under plain node.
 */

import { posterNumbers, chipDate } from './history-layout.js';

function _esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** A tiny inline sparkline (no axes, no padding) for a poster tile's
 *  signature metric — power if the session ever recorded it, else heart
 *  rate, else speed; null if none of the three exist on this session's
 *  samples (a trainer with no sensors paired, say), in which case the
 *  poster tile draws a plain strip instead. Downsampled to at most 40
 *  points — plenty for a ~70px-wide sparkline, and cheap regardless of how
 *  long the session ran.
 *  @param {Object[]} [samples] @returns {string|null} inline <svg> or null */
export function sparkline(samples) {
  if (!samples?.length) return null;
  const key = samples.some(x => Number.isFinite(x?.power)) ? 'power'
    : samples.some(x => Number.isFinite(x?.heartRate)) ? 'heartRate'
    : samples.some(x => Number.isFinite(x?.speed)) ? 'speed'
    : null;
  if (!key) return null;

  const n = Math.min(40, samples.length);
  const step = samples.length / n;
  const pts = Array.from({ length: n }, (_, i) => samples[Math.floor(i * step)][key]).filter(Number.isFinite);
  if (pts.length < 2) return null;

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;   // a dead-flat session (e.g. an even-effort hold) still draws a flat line, not a divide-by-zero
  const W = 100, H = 28;
  const coords = pts
    .map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${(H - ((v - min) / range) * H).toFixed(1)}`)
    .join(' ');

  // data-series lets the stylesheet colour the line by what it actually plots
  // (power orange, heart-rate red, speed blue) — the same colours those metrics
  // carry everywhere else in the app.
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-series="${key}" aria-hidden="true"><polyline points="${coords}"/></svg>`;
}

/** The inside of one poster tile: the date chip and session name, the signature
 *  sparkline (a plain strip when the session has none), and its three readouts —
 *  each tagged with `data-metric` so the stylesheet can give it its colour (see
 *  `.history-poster-stats`). The caller supplies the `.history-poster` wrapper.
 *  @param {Object} s a saved session  @param {string} units 'metric' | 'imperial'
 *  @returns {string} */
export function posterTileBody(s, units) {
  const spark = sparkline(s.samples);
  const nums  = posterNumbers(s, units);
  return `
        <div class="history-poster-head">
          <span class="history-poster-chip">${chipDate(s.startTime)}</span>
          <span class="history-poster-name">${_esc(s.workoutName ?? 'Free Ride')}</span>
        </div>
        ${spark ? `<div class="history-poster-spark">${spark}</div>` : '<div class="history-poster-spark history-poster-spark-empty"></div>'}
        <div class="history-poster-stats">
          ${nums.map(n => `<div data-metric="${n.metric}"><span class="stat-val">${n.val}</span><span class="stat-lbl">${n.lbl}</span></div>`).join('')}
        </div>
      `;
}
