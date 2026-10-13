// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/ui/__hud_timeline_smoketest__.js
//
// Covers ui/hud-timeline.js — the scripted HUD's workout target map: the geometry (max, levels, plot
// height, the dot's motion) and the painter (paintTimeline, which draws on any 2D-context-shaped object,
// not just a real canvas). drawTimeline() and placeTimelineDot() touch the DOM and are not covered here —
// see the module's own doc comment.

import {
  TIMELINE_TOP_PAD, TIMELINE_BOTTOM_PAD, TIMELINE_LINE_WIDTH, JUMP_MIN_LEVEL, DEFAULT_ALPHAS,
  timelineMax, levelOf, profileLevel, isRamp, plotY, dotMotion, paintTimeline, readTimelineAlphas,
} from './hud-timeline.js';
import { STEP_TYPES, TARGET_TYPES } from '../core/cardio-model.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ─── Fixtures ───────────────────────────────────────────────────────────────

let _id = 0;
const flat = (type, targetLow, duration, targetType = TARGET_TYPES.POWER) =>
  ({ id: ++_id, type, targetType, targetLow, targetHigh: null, duration, curve: 'linear' });
const ramp = (low, high, curve, duration, targetType = TARGET_TYPES.POWER) =>
  ({ id: ++_id, type: STEP_TYPES.RAMP, targetType, targetLow: low, targetHigh: high, duration, curve });
const none = (duration) =>
  ({ id: ++_id, type: STEP_TYPES.FREE_RIDE, targetType: TARGET_TYPES.NONE, targetLow: null, targetHigh: null, duration, curve: 'linear' });

const W = 300, H = 48;
const COLORS = {
  [STEP_TYPES.WARMUP]: '#5290f4', [STEP_TYPES.COOLDOWN]: '#5290f4',
  [STEP_TYPES.STEADY]: '#39d98a', [STEP_TYPES.RAMP]: '#f4b740',
  [STEP_TYPES.INTERVAL]: '#f45266', [STEP_TYPES.REST]: '#8a94a6',
  [STEP_TYPES.FREE_RIDE]: '#8a94a6',
};
const colorFor = (step) => COLORS[step.type] ?? '#888888';

/** A 2D-context-shaped recorder: every fill (with its gradient's colour stops) and every stroked path,
 *  in draw order, so a test can inspect exactly what paintTimeline() drew without a real canvas. */
function fakeCtx() {
  const self = {
    fills: [], strokes: [],
    fillStyle: null, strokeStyle: null, lineWidth: null, lineCap: null, lineJoin: null,
    _path: [],
    clearRect() {},
    createLinearGradient(x0, y0, x1, y1) {
      const stops = [];
      return { x0, y0, x1, y1, stops, addColorStop: (offset, color) => stops.push([offset, color]) };
    },
    fillRect(x, y, w, h) { self.fills.push({ x, y, w, h, grad: self.fillStyle }); },
    beginPath() { self._path = []; },
    moveTo(x, y) { self._path.push([x, y]); },
    lineTo(x, y) { self._path.push([x, y]); },
    stroke() { self.strokes.push({ points: self._path.slice(), color: self.strokeStyle, width: self.lineWidth }); },
  };
  return self;
}

/** The numeric alpha a gradient stop's rgba(...) string carries. */
const stopAlpha = (rgba) => Number(rgba.match(/[\d.]+(?=\)$)/)[0]);
/** 'r, g, b' from a gradient stop's rgba(...) string, for comparing against colorFor()'s own hex. */
const stopRgb = (rgba) => rgba.match(/rgba\(([^)]+)\)/)[1].split(',').slice(0, 3).map((n) => n.trim()).join(',');
const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(','); };

// ─── Geometry ───────────────────────────────────────────────────────────────

console.log('timelineMax');
check('the largest abs target anywhere, low or high', timelineMax([flat(STEP_TYPES.STEADY, 0.6, 60), ramp(0.3, 0.9, 'linear', 60)]) === 0.9);
check('steps with no target do not count', timelineMax([none(60), flat(STEP_TYPES.STEADY, 0.5, 60)]) === 0.5);
check('never zero, even with nothing to measure', timelineMax([]) > 0 && timelineMax([none(60)]) > 0);
check('negative targets (slope downhill) count by magnitude', timelineMax([flat(STEP_TYPES.STEADY, -2.5, 60, TARGET_TYPES.SLOPE)]) === 2.5);

console.log('\nlevelOf');
check('a target as a fraction of max', levelOf(flat(STEP_TYPES.STEADY, 0.5, 60), 0.5, 1) === 0.5);
check('a step with no target is always 0', levelOf(none(60), 100, 1) === 0);
check('clamped to [0, 1]', levelOf(flat(STEP_TYPES.STEADY, 2, 60), 2, 1) === 1 && levelOf(flat(STEP_TYPES.STEADY, -1, 60), -1, 1) === 1);
check('a missing value falls back to the step\u2019s own targetLow', levelOf(flat(STEP_TYPES.STEADY, 0.4, 60), null, 1) === 0.4);
check('a zero or missing max is never divided by', levelOf(flat(STEP_TYPES.STEADY, 0.5, 60), 0.5, 0) === 0 && levelOf(null, 1, 1) === 0);

console.log('\nprofileLevel (ramps follow their own curve)');
{
  // targetLow = 0.5, targetHigh = 1.0, max = 1.0: at frac 0.5 a *straight* interpolation reads 0.75,
  // but a parabolic one (curveProgress(0.5) = 0.25) reads 0.625 \u2014 the two are far enough apart that a
  // paintTimeline() that ignored the curve (drew a straight ramp regardless of step.curve) would miss.
  const step = ramp(0.5, 1.0, 'parabolic', 20);
  check('a parabolic ramp is not halfway at halfway (0.625, not 0.75)', near(profileLevel(step, 0.5, 1.0), 0.625));
  check('it opens on targetLow and closes on targetHigh', near(profileLevel(step, 0, 1.0), 0.5) && near(profileLevel(step, 1, 1.0), 1.0));
}
check('a linear ramp is halfway at halfway', near(profileLevel(ramp(0, 1, 'linear', 20), 0.5, 1), 0.5));
check('a flat (non-ramp) step reads the same target the whole way through', (() => {
  const step = flat(STEP_TYPES.STEADY, 0.6, 60);
  return near(profileLevel(step, 0, 1), 0.6) && near(profileLevel(step, 0.5, 1), 0.6) && near(profileLevel(step, 1, 1), 0.6);
})());

console.log('\nisRamp');
check('a ramp with two different targets and a duration', isRamp(ramp(0.3, 0.9, 'linear', 60)));
check('a ramp whose high equals its low is not (nothing to slope)', !isRamp(ramp(0.5, 0.5, 'linear', 60)));
check('a ramp with no duration is not', !isRamp({ ...ramp(0.3, 0.9, 'linear', 60), duration: 0 }));
check('a ramp with no high at all is not', !isRamp({ ...ramp(0.3, 0.9, 'linear', 60), targetHigh: null }));
check('a free-ride (no target) ramp is not, even with two different numbers on it', !isRamp(ramp(0.3, 0.9, 'linear', 60, TARGET_TYPES.NONE)));
check('a flat step is never a ramp', !isRamp(flat(STEP_TYPES.STEADY, 0.5, 60)));

console.log('\nplotY');
check('level 0 sits TIMELINE_BOTTOM_PAD above the bottom', plotY(0, 100) === 100 - TIMELINE_BOTTOM_PAD);
check('level 1 sits TIMELINE_TOP_PAD below the top', plotY(1, 100) === TIMELINE_TOP_PAD);
check('linear in between', near(plotY(0.5, 100), (plotY(0, 100) + plotY(1, 100)) / 2));

console.log('\ndotMotion');
check('a new step with a different target jumps', dotMotion({ stepChanged: true, prevLevel: 0.2, level: 0.8 }) === 'jump');
check('a new step with (near enough) the same target does not', dotMotion({ stepChanged: true, prevLevel: 0.5, level: 0.5 + JUMP_MIN_LEVEL / 2 }) === 'glide');
check('the same step moving (a ramp\u2019s steady climb) glides, however far it has moved', dotMotion({ stepChanged: false, prevLevel: 0, level: 1 }) === 'glide');
check('right at the threshold is not yet a jump', dotMotion({ stepChanged: true, prevLevel: 0, level: JUMP_MIN_LEVEL }) === 'glide');
check('just past it is', dotMotion({ stepChanged: true, prevLevel: 0, level: JUMP_MIN_LEVEL * 1.01 }) === 'jump');

// ─── Painting ───────────────────────────────────────────────────────────────

console.log('\npaintTimeline: line weight');
check('the line is thin enough that its lower half still fits in the bottom pad (never clipped at level 0)',
  TIMELINE_BOTTOM_PAD >= TIMELINE_LINE_WIDTH / 2, `pad ${TIMELINE_BOTTOM_PAD}, width ${TIMELINE_LINE_WIDTH}`);
{
  const ctx = fakeCtx();
  paintTimeline(ctx, { steps: [flat(STEP_TYPES.STEADY, 0.5, 60), ramp(0.2, 0.8, 'linear', 60)], width: W, height: H, colorFor });
  check('every stroked line is the HUD border\u2019s own thickness', ctx.strokes.every((s) => s.width === TIMELINE_LINE_WIDTH));
}

console.log('\npaintTimeline: the glow');
{
  const alphas = { rule: 0.7, wash: 0.3, washEnd: 0.05 };
  const ctx = fakeCtx();
  paintTimeline(ctx, { steps: [flat(STEP_TYPES.STEADY, 0.5, 60)], width: W, height: H, colorFor, alphas });
  check('every fill is a two-stop gradient', ctx.fills.every((f) => f.grad?.stops?.length === 2));
  check('every gradient runs from the wash strength at the line (offset 0) to washEnd at the bottom (offset 1) \u2014 never the other way round',
    ctx.fills.every((f) => f.grad.stops[0][0] === 0 && near(stopAlpha(f.grad.stops[0][1]), alphas.wash)
      && f.grad.stops[1][0] === 1 && near(stopAlpha(f.grad.stops[1][1]), alphas.washEnd)));
  check('a column\u2019s colour is its own step\u2019s', ctx.fills.every((f) => stopRgb(f.grad.stops[0][1]) === hexRgb(colorFor(flat(STEP_TYPES.STEADY, 0.5, 60)))));
}
{
  // DEFAULT_ALPHAS.washEnd is 0 \u2014 the real "0 being fully transparent", as opposed
  // to the merely-low-but-nonzero washEnd used above to make the two stops easy to tell apart.
  const ctx = fakeCtx();
  paintTimeline(ctx, { steps: [flat(STEP_TYPES.STEADY, 0.5, 60)], width: W, height: H, colorFor });
  check('with the real tokens, washEnd really is fully transparent (alpha 0) at the bottom', near(stopAlpha(ctx.fills[0].grad.stops[1][1]), 0));
}
{
  const ctx = fakeCtx();
  paintTimeline(ctx, { steps: [flat(STEP_TYPES.STEADY, 0.5, 60)], width: W, height: H, colorFor });
  check('a level (non-ramp) step is one fill from its line down, not a strip of columns', ctx.fills.length === 1 && ctx.fills[0].x === 0 && near(ctx.fills[0].x + ctx.fills[0].w, W));
}
{
  // A ramp step's column fills should trace the same curve profileLevel() computes \u2014 the mid column of
  // a parabolic ramp lands where plotY(profileLevel(step, 0.5, max), height) says it should, independent
  // of paintTimeline's own column math (so a paintTimeline bug that ignored the curve, or miscounted
  // columns, shows up here even though profileLevel() itself is correct).
  const step = ramp(0.5, 1.0, 'parabolic', 20);
  const max = 1.0;
  const ctx = fakeCtx();
  paintTimeline(ctx, { steps: [step], width: W, height: H, colorFor, max });
  const midFill = ctx.fills.find((f) => f.x <= W / 2 && f.x + f.w > W / 2);
  const expectedY = plotY(profileLevel(step, (midFill.x + midFill.w / 2) / W, max), H);
  check('the ramp\u2019s drawn column sits exactly on the curve profileLevel() computes for it (so the dot, which reads profileLevel() too, never drifts off the line)',
    near(midFill.y, expectedY, 0.5), { drawn: midFill.y, expected: expectedY });
}

console.log('\npaintTimeline: no seams');
// Round widths would make snapping a no-op and prove nothing, so this workout is awkward on purpose:
// durations that share no factor with a width that is not a whole number of pixels, ramps included.
const awkward = [ramp(0.3, 0.9, 'linear', 7), flat(STEP_TYPES.INTERVAL, 1.0, 11), flat(STEP_TYPES.REST, 0.4, 13), ramp(0.9, 0.2, 'parabolic', 17)];
const AW = 297.3;
for (const dpr of [1, 2, 3]) {
  const ctx = fakeCtx();
  paintTimeline(ctx, { steps: awkward, width: AW, height: H, dpr, colorFor });
  const fills = ctx.fills.slice().sort((a, b) => a.x - b.x);
  const contiguous = fills.every((f, i) => i === 0 || near(f.x, fills[i - 1].x + fills[i - 1].w, 1e-9));
  check(`at ${dpr}x every fill starts exactly where the last one ended, edge to edge across the steps (no hairline between translucent edges)`,
    contiguous && fills[0].x === 0 && near(fills[fills.length - 1].x + fills[fills.length - 1].w, Math.round(AW * dpr) / dpr, 1e-9),
    `${fills.length} fills, ends ${fills[fills.length - 1].x + fills[fills.length - 1].w}`);
  check(`at ${dpr}x every edge sits on a whole device pixel`, fills.every((f) => near(f.x * dpr, Math.round(f.x * dpr), 1e-6) && near((f.x + f.w) * dpr, Math.round((f.x + f.w) * dpr), 1e-6)));
  check(`at ${dpr}x no fill is empty or negative`, fills.every((f) => f.w > 0));
}

console.log('\npaintTimeline: misc');
check('returns the max it drew against, defaulting to timelineMax(steps)', paintTimeline(fakeCtx(), { steps: [flat(STEP_TYPES.STEADY, 0.6, 60)], width: W, height: H, colorFor }) === 0.6);
check('an explicit max overrides the default', paintTimeline(fakeCtx(), { steps: [flat(STEP_TYPES.STEADY, 0.6, 60)], width: W, height: H, colorFor, max: 2 }) === 2);
check('an empty workout draws nothing and does not throw', (() => { const ctx = fakeCtx(); paintTimeline(ctx, { steps: [], width: W, height: H, colorFor }); return ctx.fills.length === 0 && ctx.strokes.length === 0; })());
check('a step with no duration takes no width and is skipped, not drawn as a sliver', (() => {
  const ctx = fakeCtx();
  paintTimeline(ctx, { steps: [flat(STEP_TYPES.STEADY, 0.5, 0), flat(STEP_TYPES.STEADY, 0.5, 60)], width: W, height: H, colorFor });
  return ctx.fills.length === 1;
})());

// ─── readTimelineAlphas ─────────────────────────────────────────────────────

console.log('\nreadTimelineAlphas');
check('falls back to DEFAULT_ALPHAS outside a DOM (no document/getComputedStyle here under plain node)',
  JSON.stringify(readTimelineAlphas()) === JSON.stringify(DEFAULT_ALPHAS));

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll HUD timeline checks passed.');
