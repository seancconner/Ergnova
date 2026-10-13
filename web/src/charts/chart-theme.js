// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * charts/chart-theme.js
 *
 * Single source of truth for every colour the canvas charts draw with:
 * style.css's :root tokens (--color-power, --chart-bg, ...). Canvas 2D can't
 * use var(), so the chart engine used to carry its own hard-coded hex palette
 * — which drifted away from the metric cards (Speed was a blue card over a
 * purple line, Cadence a dull teal card over a bright cyan line, the canvas
 * itself a lighter navy than --bg-deep). This module reads the tokens at
 * runtime instead, so the two can't disagree.
 *
 * Resolution goes through a 1x1 canvas rather than parsing the token text:
 * a token's computed value can be hsl(), color-mix(), color(srgb ...), etc.,
 * and painting it then reading the pixel back turns any of them into a plain
 * #rrggbb the chart code (and the Android notification bridge, which is handed
 * these colours as strings) can use directly.
 *
 * TOKEN_FALLBACKS holds the same colours as static hex (charts, plus the
 * training-zone and workout-step palettes in metrics/*-zones.js and editor/). It is used when the
 * stylesheet hasn't been applied yet at import time, when there is no DOM
 * (the node smoke tests), or if the canvas readback is blocked.
 * __chart_theme_smoketest__.js fails `npm test` if a plain-hsl entry here
 * stops matching style.css, so update both together.
 */

export const TOKEN_FALLBACKS = {
  '--color-power':     '#f97415',
  '--color-power-avg': '#fb9b56',
  '--color-hr':        '#ff4040',
  '--color-cadence':   '#23c7c2',
  '--color-speed':     '#0da6f2',
  '--color-smo2':      '#11d45c',
  '--color-temp':      '#ffbf1f',
  '--chart-bg':        '#0d1e26',
  '--chart-grid':      '#223947',
  '--chart-lap':       '#314d60',
  '--chart-step':      '#406076',
  '--chart-text':      '#a6bac5',
  '--chart-stale':     '#6c808a',
  '--chart-complete':  '#00b318',
  '--chart-crosshair': '#e0e7eb',
  '--chart-tip-bg':    '#163443',
  '--zone-recovery':   '#8594a3',
  '--zone-endurance':  '#5290f4',
  '--zone-tempo':      '#2dbe7a',
  '--zone-threshold':  '#fbdc41',
  '--zone-vo2':        '#ff9429',
  '--zone-anaerobic':  '#e60f0f',
  '--zone-neuro':      '#d374e7',
  '--step-warmup':     '#5290f4',
  '--step-cooldown':   '#ba97f7',
  '--step-steady':     '#ff9429',
  '--step-ramp':       '#fbdc41',
  '--step-ramp-curve': '#e85eba',
  '--step-rest':       '#8594a3',
  '--step-free-ride':  '#1bcdda',
  '--step-interval':   '#e60f0f',
};

let _probe;   // undefined = not tried yet, null = unavailable

function _probeCtx() {
  if (_probe !== undefined) return _probe;
  try {
    if (typeof document === 'undefined') return (_probe = null);
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    _probe = c.getContext('2d', { willReadFrequently: true });
  } catch {
    _probe = null;
  }
  return _probe;
}

const _hex2 = (n) => n.toString(16).padStart(2, '0');

/** Any CSS colour string -> '#rrggbb', or null if it can't be parsed. */
export function resolveCssColor(value) {
  const ctx = _probeCtx();
  if (!ctx || !value) return null;
  try {
    // An unparseable value leaves fillStyle unchanged, so seed it with a
    // sentinel and treat "still the sentinel" as a parse failure.
    ctx.fillStyle = '#010203';
    ctx.fillStyle = value;
    if (ctx.fillStyle === '#010203' && value.trim().toLowerCase() !== '#010203') return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return null;
    return `#${_hex2(r)}${_hex2(g)}${_hex2(b)}`;
  } catch {
    return null;
  }
}

/** Resolved value of a style.css token as '#rrggbb' (static fallback if unavailable). */
export function themeColor(token) {
  const fallback = TOKEN_FALLBACKS[token];
  try {
    if (typeof document === 'undefined') return fallback;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return resolveCssColor(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

/** '#rrggbb' + alpha -> 'rgba(r, g, b, a)' for canvas fills/strokes. */
export function withAlpha(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
