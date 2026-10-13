// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * charts/body-history-chart.js
 *
 * Draws the line chart inside Overview's "Weight & Composition" card
 * as an inline SVG string. Deliberately *not* built on chart-engine.js: that
 * is the live-workout canvas engine (scrolling time window, per-frame
 * redraws); this is a static, low-point-count history plot that only redraws
 * when the rider changes the metric/range or the card's width changes, and
 * inline SVG gives crisp text, free theming through the app's CSS custom
 * properties, and no canvas DPR bookkeeping.
 *
 * Pure function of its inputs — no DOM access — so it runs under plain
 * `node` for __body_history_smoketest__.js. It returns the markup plus a
 * `hits` table (one entry per reading, x-sorted, in SVG user units) that the
 * view uses for scrub/hover: the SVG itself carries no event handlers.
 *
 * All colors come in as CSS `var(...)` strings and are applied via a `--c`
 * custom property on each series group (see the .bh-* rules in style.css),
 * not as SVG presentation attributes — custom properties in inline style
 * resolve reliably in every WebView the MAUI shell targets.
 *
 * Series drawing rules:
 *   - The raw readings are the chart: joined by one solid line, with a dot
 *     on each reading (dots are dropped past 90 readings to keep the line
 *     legible). No smoothing or averaging is drawn on top.
 *   - A lone single-series, non-baseline plot also gets a soft area fill
 *     under its line.
 *   - `zeroBaseline` (the Fat vs Lean change view) forces 0 into the y-range
 *     and draws a dashed zero line.
 *   - `integerAxis` keeps gridlines on whole numbers (visceral rating, kcal).
 */

import { niceScale } from '../metrics/body-history.js';

const PAD_TOP = 10;
const PAD_BOTTOM = 22;
const PAD_RIGHT = 12;
const MIN_PAD_LEFT = 30;
const CHAR_W = 6.2; // ≈ width of one 10px tabular digit, for sizing the y-label gutter

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const num = n => (Math.round(n * 10) / 10).toString();

/**
 * @param {Object}   o
 * @param {number}   o.width         Pixel width the SVG is drawn at (its viewBox width).
 * @param {number}   o.height        Pixel height.
 * @param {{startT:number,endT:number}} o.domain  X range (Unix ms).
 * @param {{key:string,label:string,colorVar:string,points:{t:number,v:number}[]}[]} o.series
 * @param {boolean}  [o.zeroBaseline=false]
 * @param {boolean}  [o.integerAxis=false]
 * @param {(v:number, decimals:number)=>string} o.formatTick   Y-axis label formatter.
 * @param {(t:number, spanDays:number)=>string} o.formatDate   X-axis label formatter.
 * @param {string}   [o.ariaLabel]
 * @returns {{ svg:string, hits:{ t:number, x:number, items:{key:string,label:string,colorVar:string,v:number,y:number}[] }[], plot:{left:number,right:number,top:number,bottom:number} }}
 */
export function renderBodyHistoryChart({
  width, height, domain, series, zeroBaseline = false, integerAxis = false, formatTick, formatDate, ariaLabel = 'Body history chart',
}) {
  const empty = { svg: '', hits: [], plot: { left: 0, right: width, top: 0, bottom: height } };

  // ── Y domain ────────────────────────────────────────────────────────────
  const ys = [];
  for (const s of series) {
    for (const p of s.points) ys.push(p.v);
  }
  if (!ys.length) return empty;
  if (zeroBaseline) ys.push(0);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  const scale = niceScale(lo, hi, height < 150 ? 3 : 4, { integer: integerAxis });
  if (!scale) return empty;

  // ── Layout ──────────────────────────────────────────────────────────────
  const tickLabels = scale.ticks.map(v => formatTick(v, scale.decimals));
  const left = Math.max(MIN_PAD_LEFT, Math.ceil(Math.max(...tickLabels.map(l => l.length)) * CHAR_W) + 10);
  const plotW = Math.max(10, width - left - PAD_RIGHT);
  const plotH = Math.max(10, height - PAD_TOP - PAD_BOTTOM);
  const bottom = PAD_TOP + plotH;

  const t0 = domain.startT;
  const t1 = domain.endT > domain.startT ? domain.endT : domain.startT + 24 * 3600 * 1000;
  const xOf = t => left + ((t - t0) / (t1 - t0)) * plotW;
  const yOf = v => PAD_TOP + (1 - (v - scale.min) / (scale.max - scale.min)) * plotH;
  const spanDays = (t1 - t0) / (24 * 3600 * 1000);

  // ── Grid + y labels ─────────────────────────────────────────────────────
  let grid = '';
  let yLabels = '';
  scale.ticks.forEach((v, i) => {
    const y = yOf(v);
    grid += `<line x1="${left}" y1="${num(y)}" x2="${num(left + plotW)}" y2="${num(y)}"/>`;
    yLabels += `<text class="bh-ylabel" x="${left - 6}" y="${num(y + 3.5)}" text-anchor="end">${esc(tickLabels[i])}</text>`;
  });
  const zero = zeroBaseline
    ? `<line class="bh-zero" x1="${left}" y1="${num(yOf(0))}" x2="${num(left + plotW)}" y2="${num(yOf(0))}"/>`
    : '';

  // ── X labels ────────────────────────────────────────────────────────────
  // Labels carry a date but no time, so never space them closer than a day
  // apart — a 2-day span (a rider's first couple of weigh-ins) would
  // otherwise print "Sep 19, Sep 19".
  const nX = Math.min(width < 320 ? 3 : 5, Math.max(2, Math.floor(spanDays) + 1));
  let xLabels = '';
  for (let i = 0; i < nX; i++) {
    const t = t0 + ((t1 - t0) * i) / (nX - 1);
    const anchor = i === 0 ? 'start' : i === nX - 1 ? 'end' : 'middle';
    xLabels += `<text class="bh-xlabel" x="${num(xOf(t))}" y="${height - 6}" text-anchor="${anchor}">${esc(formatDate(t, spanDays))}</text>`;
  }

  // ── Series ──────────────────────────────────────────────────────────────
  const linePath = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${num(xOf(p.t))},${num(yOf(p.v))}`).join('');
  const soloArea = series.length === 1 && !zeroBaseline;
  let body = '';
  for (const s of series) {
    const pts = s.points;
    if (!pts.length) continue;
    const dotR = pts.length > 90 ? 1.5 : pts.length > 45 ? 2 : 2.8;
    let g = '';
    if (pts.length >= 2) {
      if (soloArea) {
        g += `<path class="bh-area" d="${linePath(pts)}L${num(xOf(pts[pts.length - 1].t))},${num(bottom)}L${num(xOf(pts[0].t))},${num(bottom)}Z"/>`;
      }
      g += `<path class="bh-line" d="${linePath(pts)}"/>`;
      if (pts.length <= 90) g += pts.map(p => `<circle class="bh-dot" cx="${num(xOf(p.t))}" cy="${num(yOf(p.v))}" r="${dotR}"/>`).join('');
    }
    const lastPt = pts[pts.length - 1];
    g += `<circle class="bh-last" cx="${num(xOf(lastPt.t))}" cy="${num(yOf(lastPt.v))}" r="${pts.length === 1 ? 4.5 : 4}"/>`;
    body += `<g style="--c:${s.colorVar}">${g}</g>`;
  }

  // ── Hit table (one entry per timestamp of the first series) ────────────
  const others = series.slice(1).map(s => new Map(s.points.map(p => [p.t, p])));
  const hits = (series[0]?.points ?? []).map(p => {
    const items = [{ key: series[0].key, label: series[0].label, colorVar: series[0].colorVar, v: p.v, y: yOf(p.v) }];
    others.forEach((m, i) => {
      const q = m.get(p.t);
      if (q) items.push({ key: series[i + 1].key, label: series[i + 1].label, colorVar: series[i + 1].colorVar, v: q.v, y: yOf(q.v) });
    });
    return { t: p.t, x: xOf(p.t), items };
  });

  // ── Hover layer (hidden until the view scrubs it) ──────────────────────
  const hoverDots = series
    .map(s => `<circle class="bh-hover-dot" data-key="${esc(s.key)}" r="4.5" visibility="hidden" style="--c:${s.colorVar}"/>`)
    .join('');
  const guide = `<line class="bh-guide" y1="${PAD_TOP}" y2="${num(bottom)}" visibility="hidden"/>`;
  const hitRect = `<rect class="bh-hit" x="${left}" y="${PAD_TOP}" width="${num(plotW)}" height="${num(plotH)}" fill="transparent"/>`;

  const svg =
    `<svg class="bh-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(ariaLabel)}">` +
    `<g class="bh-grid">${grid}</g>${zero}${yLabels}${xLabels}${body}${guide}${hoverDots}${hitRect}` +
    `</svg>`;

  return { svg, hits, plot: { left, right: left + plotW, top: PAD_TOP, bottom } };
}

export default { renderBodyHistoryChart };
