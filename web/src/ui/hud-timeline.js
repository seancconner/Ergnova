// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/hud-timeline.js
 *
 * The scripted HUD's workout target map (index.html's #hud-timeline; app.js's updateScriptedHUD()
 * drives it): the shape of every step's target across the whole workout, with a dot riding the target
 * line at "now".
 *
 * How a step is drawn — the same language as every other readout in the app (the "Stat chips" rule and
 * the Metric wash in style.css), turned on its side:
 *   - a solid 2px line along the top of the step, in the step's colour at --metric-rule-alpha: the HUD's
 *     own left border, laid along the target instead of down the edge;
 *   - under it, a gradient that is --metric-wash-alpha at the line and softens to --metric-wash-alpha-end
 *     (fully transparent) at zero, so the step has no floor and no side walls — only its target, and the
 *     glow beneath it. The gradient is laid per column, so on a ramp it starts at full strength right
 *     under the line all the way along the slope, rather than being cut across it;
 *   - a ramp follows the curve the trainer is actually being sent (linear or parabolic, via
 *     resolveRampTarget), so the dot, which reads the live target, never drifts off the line.
 * The dot's height is the live target (continuously interpolated through a ramp) on the same scale as the
 * drawing; when it has to jump — a new step with a different target — it animates up or down the step
 * edge instead of snapping (see .hud-timeline-dot in style.css). The target's number is a separate label
 * (#hud-timeline-target), overlaid at the bottom left.
 *
 * The geometry (max, levels, plot height, the dot's motion) is pure, and paintTimeline() draws on any
 * 2D-context-shaped object, so all of it runs under plain node (__hud_timeline_smoketest__.js); only
 * drawTimeline() and placeTimelineDot() touch the DOM.
 */

import { TARGET_TYPES, STEP_TYPES, resolveRampTarget } from '../core/cardio-model.js';
import { withAlpha } from '../charts/chart-theme.js';

/** Headroom above the highest target, px: room for the dot (and its ring) at 100% so it is never clipped. */
export const TIMELINE_TOP_PAD = 6;
/** Room under the lowest target, px: half the line, so a step with no target (its line sits on the
 *  baseline) is not half cut off by the canvas edge. */
export const TIMELINE_BOTTOM_PAD = 1;
/** Thickness of a step's top line, px — the HUD's own border thickness. */
export const TIMELINE_LINE_WIDTH = 2;
/** A step change that moves the dot by more than this (of the full height) is a jump, and animates as one. */
export const JUMP_MIN_LEVEL = 0.005;

/** The strengths used when the stylesheet's tokens can't be read (node, or before styles apply). */
export const DEFAULT_ALPHAS = Object.freeze({ rule: 0.7, wash: 0.22, washEnd: 0 });

// ─── Geometry (pure) ──────────────────────────────────────────────────────

/** The largest target anywhere in the workout — what every height is a fraction of. Steps with no target
 *  don't count. Never zero, so a level can always be divided by it.
 *  @param {Object[]} steps @returns {number} */
export function timelineMax(steps) {
  let max = 0;
  for (const s of steps ?? []) {
    if (s.targetType === TARGET_TYPES.NONE) continue;
    max = Math.max(max, Math.abs(s.targetLow ?? 0), Math.abs(s.targetHigh ?? s.targetLow ?? 0));
  }
  return Math.max(max, 0.0001);
}

/** A target value as a height, 0 (nothing) to 1 (the workout's highest target). A step with no target
 *  is always 0. @param {Object} step @param {number|null|undefined} value  falls back to the step's targetLow
 *  @param {number} max  timelineMax() @returns {number} */
export function levelOf(step, value, max) {
  if (!step || step.targetType === TARGET_TYPES.NONE || !(max > 0)) return 0;
  const v = Math.abs(value ?? step.targetLow ?? 0) / max;
  return Math.min(1, Math.max(0, v));
}

/** The height of a step's target `frac` (0 to 1) of the way through it, following a ramp's curve.
 *  @param {Object} step @param {number} frac @param {number} max @returns {number} */
export function profileLevel(step, frac, max) {
  return levelOf(step, resolveRampTarget(step, frac * (step.duration ?? 0)), max);
}

/** Whether a step's target moves through it (so its top edge is a slope or a curve, not level). */
export function isRamp(step) {
  return step.targetType !== TARGET_TYPES.NONE && step.type === STEP_TYPES.RAMP
    && step.targetHigh != null && step.targetHigh !== step.targetLow && !!step.duration;
}

/** A height as a y coordinate on a canvas `height` px tall (y grows downward): level 0 sits
 *  TIMELINE_BOTTOM_PAD above the bottom, level 1 TIMELINE_TOP_PAD below the top.
 *  The stylesheet places the dot with the same two pads, so it lands on the line. */
export function plotY(level, height) {
  return height - TIMELINE_BOTTOM_PAD - level * (height - TIMELINE_TOP_PAD - TIMELINE_BOTTOM_PAD);
}

/** How the dot should travel to its new height: a "jump" when a new step has begun and its target is
 *  somewhere else (an animated climb or drop), otherwise a "glide" (the small, steady changes along a
 *  ramp, followed at the clock's own pace). @returns {'jump'|'glide'} */
export function dotMotion({ stepChanged, prevLevel, level }) {
  return stepChanged && Math.abs((level ?? 0) - (prevLevel ?? 0)) > JUMP_MIN_LEVEL ? 'jump' : 'glide';
}

// ─── Painting (any 2D-context-shaped object) ──────────────────────────────

/**
 * Draws the whole target map on `ctx`, which must already be scaled to CSS pixels (see drawTimeline()).
 * Every x edge is snapped to the device pixel grid, so neighbouring steps and the columns of a ramp
 * meet without the hairline seams that translucent fills leave between anti-aliased edges.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} o
 * @param {Object[]} o.steps  flattened steps (ScriptedSession#steps)
 * @param {number} o.width @param {number} o.height  CSS px
 * @param {number} [o.dpr=1]
 * @param {(step:Object)=>string} o.colorFor  '#rrggbb' for a step
 * @param {{rule:number, wash:number, washEnd:number}} [o.alphas=DEFAULT_ALPHAS]
 * @param {number} [o.max]  defaults to timelineMax(steps)
 * @returns {number} the max used, which the dot's height must be measured against too
 */
export function paintTimeline(ctx, { steps, width, height, dpr = 1, colorFor, alphas = DEFAULT_ALPHAS, max = timelineMax(steps) }) {
  ctx.clearRect(0, 0, width, height);
  const total = steps.reduce((a, s) => a + (s.duration ?? 0), 0) || 1;
  const snap = (v) => Math.round(v * dpr) / dpr;

  let x = 0;
  for (const step of steps) {
    const w = ((step.duration ?? 0) / total) * width;
    const xa = snap(x), xb = snap(x + w);
    x += w;
    if (!(xb > xa)) continue;
    const color = colorFor(step);

    // The glow: the wash strength at the line, softening to nothing at zero.
    const fill = (from, to, y) => {
      const g = ctx.createLinearGradient(0, y, 0, height);
      g.addColorStop(0, withAlpha(color, alphas.wash));
      g.addColorStop(1, withAlpha(color, alphas.washEnd));
      ctx.fillStyle = g;
      ctx.fillRect(from, y, to - from, height - y);
    };

    ctx.strokeStyle = withAlpha(color, alphas.rule);
    ctx.lineWidth = TIMELINE_LINE_WIDTH;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    if (!isRamp(step)) {
      const y = snap(plotY(profileLevel(step, 0, max), height));   // snapped: a 2px line on whole pixels
      fill(xa, xb, y);
      ctx.moveTo(xa, y);
      ctx.lineTo(xb, y);
    } else {
      const n = Math.max(2, Math.ceil(xb - xa));   // a column per CSS px
      for (let i = 0; i < n; i++) {
        const ca = snap(xa + (i * (xb - xa)) / n), cb = snap(xa + ((i + 1) * (xb - xa)) / n);
        if (cb > ca) fill(ca, cb, plotY(profileLevel(step, (i + 0.5) / n, max), height));
      }
      for (let i = 0; i <= n; i++) {
        const f = i / n, px = xa + f * (xb - xa), py = plotY(profileLevel(step, f, max), height);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }
  return max;
}

// ─── DOM ──────────────────────────────────────────────────────────────────

/** The line and glow strengths, read from the stylesheet's shared Metric tokens so retuning them there
 *  retunes the timeline with every chip, badge and card. Falls back to DEFAULT_ALPHAS. */
export function readTimelineAlphas() {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return { ...DEFAULT_ALPHAS };
  const cs = getComputedStyle(document.documentElement);
  const pct = (name, fallback) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v / 100 : fallback;
  };
  return {
    rule:    pct('--metric-rule-alpha', DEFAULT_ALPHAS.rule),
    wash:    pct('--metric-wash-alpha', DEFAULT_ALPHAS.wash),
    washEnd: pct('--metric-wash-alpha-end', DEFAULT_ALPHAS.washEnd),
  };
}

/** Sizes the canvas to its box at the screen's pixel density, draws the map, and tells the container the
 *  two pads so the stylesheet's dot sits on the line. Call again when the box changes size.
 *  @param {HTMLCanvasElement} canvas @param {Object[]} steps @param {{colorFor:(step:Object)=>string}} o
 *  @returns {number|null} the max the drawing was scaled to (null if there was nothing to draw) */
export function drawTimeline(canvas, steps, { colorFor }) {
  if (!canvas || !steps?.length) return null;
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 48;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas.parentElement?.style.setProperty('--timeline-top-pad', `${TIMELINE_TOP_PAD}px`);
  canvas.parentElement?.style.setProperty('--timeline-bottom-pad', `${TIMELINE_BOTTOM_PAD}px`);
  return paintTimeline(ctx, { steps, width, height, dpr, colorFor, alphas: readTimelineAlphas() });
}

/** Moves the dot: `pct` along the workout, `level` up the target scale. `instant` puts it there without
 *  animating (a new workout, or the first tick); `jump` animates the climb or drop with the jump timing
 *  rather than the clock's steady one. The vertical position is a custom property the stylesheet turns
 *  into a height, so the same value stays right when the box is resized.
 *  @param {HTMLElement|null} dot @param {{pct:number, level:number, instant?:boolean, jump?:boolean}} o */
export function placeTimelineDot(dot, { pct, level, instant = false, jump = false }) {
  if (!dot) return;
  dot.classList.toggle('is-snapping', instant);
  dot.classList.toggle('is-jumping', !instant && jump);
  dot.style.left = `${pct}%`;
  dot.style.setProperty('--tl-v', String(Math.round(level * 10000) / 10000));
  if (instant) {
    void dot.offsetWidth;   // commit the new position before animation is switched back on
    dot.classList.remove('is-snapping');
  }
}
