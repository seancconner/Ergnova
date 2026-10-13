// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/muscle-diagram.js
 *
 * Renders a pair of small body-silhouette diagrams (front + back) with a
 * given set of muscle regions highlighted. Used by views/strength-session.js's
 * exercise picker to show what a selected exercise targets, sourced from
 * data/exercises.js's `primaryMuscles`.
 *
 * Shapes are built from tapered, gently-bulging paths (see _taper() below)
 * rather than plain rects — a rounded, human-proportioned silhouette with
 * shoulders wider than the waist, limbs that narrow toward the joints, and
 * a bit of muscle curvature — while still staying a simplified illustration,
 * not a traced anatomical drawing.
 *
 * Both views always render side by side rather than picking one — an
 * exercise's primary muscles are often split across the two (e.g. a bench
 * press's chest is front-only, its triceps are back-only), and always
 * showing both keeps the layout predictable instead of jumping between a
 * one-diagram and two-diagram layout depending on what's picked.
 *
 * Usage:
 *   import { renderMuscleDiagram } from '../ui/muscle-diagram.js';
 *   container.innerHTML = renderMuscleDiagram(['chest', 'triceps', 'shoulders']);
 */

export const MUSCLE_LABELS = {
  chest: 'Chest', shoulders: 'Shoulders', biceps: 'Biceps', triceps: 'Triceps',
  forearms: 'Forearms', abs: 'Abs', obliques: 'Obliques', lats: 'Lats',
  upperBack: 'Upper Back', lowerBack: 'Lower Back', traps: 'Traps',
  glutes: 'Glutes', quads: 'Quads', hamstrings: 'Hamstrings', calves: 'Calves',
};

// ─── Shape helpers ──────────────────────────────────────────────────────────
// Every region is a "taper": a quadrilateral with a given width at its top
// and bottom edge, joined by two curved sides instead of straight ones. A
// positive `bulge` pushes both side-curves outward (away from the shape's
// own centerline) partway down, which is what gives limbs/torso regions
// their slight muscle curvature instead of reading as a straight-edged
// trapezoid. `bulge` of 0 is a plain (straight-sided) trapezoid — used for
// the few regions that shouldn't visibly bulge (e.g. the traps yoke).

function _taper(xTopL, xTopR, yTop, xBotL, xBotR, yBot, bulge = 0) {
  const y1 = yTop + (yBot - yTop) * 0.32;
  const y2 = yTop + (yBot - yTop) * 0.68;
  return `M${xTopL},${yTop} ` +
    `C${xTopL - bulge},${y1} ${xBotL - bulge},${y2} ${xBotL},${yBot} ` +
    `L${xBotR},${yBot} ` +
    `C${xBotR + bulge},${y2} ${xTopR + bulge},${y1} ${xTopR},${yTop} Z`;
}

/** Same shape, mirrored across the viewBox's vertical centerline (x=50) —
 *  how every right-side region is derived from its left-side twin's params,
 *  so the two always stay in lockstep instead of risking hand-mirrored
 *  coordinates drifting apart over edits. */
function _taperMirrored(xTopL, xTopR, yTop, xBotL, xBotR, yBot, bulge = 0) {
  return _taper(100 - xTopR, 100 - xTopL, yTop, 100 - xBotR, 100 - xBotL, yBot, bulge);
}

function _ellipseAttrs({ cx, cy, r }) { return { cx, cy, rx: r, ry: r }; }

// ─── Shared landmarks ───────────────────────────────────────────────────────
// Same screen position, different meaning front vs back (e.g. the upper-arm
// region is biceps from the front, triceps from the back) — and identical
// between views so the two silhouettes line up.

const SHOULDER_L = { cx: 24, cy: 35, r: 8.5 };
const SHOULDER_R = { cx: 76, cy: 35, r: 8.5 };

const UPPER_ARM_L = _taper(17, 28, 39, 15, 25, 75, 3.2);
const UPPER_ARM_R = _taperMirrored(17, 28, 39, 15, 25, 75, 3.2);
const FOREARM_L = _taper(15, 24, 75, 14, 21, 112, 1.5);
const FOREARM_R = _taperMirrored(15, 24, 75, 14, 21, 112, 1.5);
const UPPER_LEG_L = _taper(31, 48, 84, 35, 47, 123, 3);
const UPPER_LEG_R = _taperMirrored(31, 48, 84, 35, 47, 123, 3);
const CALF_L = _taper(35, 47, 125, 38, 44, 163, 4.5);
const CALF_R = _taperMirrored(35, 47, 125, 38, 44, 163, 4.5);

// The neck/hip "bridge" pieces differ slightly front vs back (the front
// hip line sits a touch higher, tracking the abs rather than the fuller
// lower-back/glute line) so each view gets its own.
const NECK = 'M44,22 L56,22 L59,31 L41,31 Z';
const HIP_BRIDGE_FRONT = _taper(41, 59, 80, 31, 69, 86, 1);
const HIP_BRIDGE_BACK = _taper(35, 65, 82, 31, 69, 86, 1);

// [muscle id, shape type, one-or-two attrs objects (paired shapes share a label)]
const FRONT_REGIONS = [
  ['shoulders', 'ellipse', [_ellipseAttrs(SHOULDER_L), _ellipseAttrs(SHOULDER_R)]],
  ['chest',     'path',    [{ d: _taper(30, 70, 31, 35, 65, 55, 4.5) }]],
  ['biceps',    'path',    [{ d: UPPER_ARM_L }, { d: UPPER_ARM_R }]],
  ['forearms',  'path',    [{ d: FOREARM_L }, { d: FOREARM_R }]],
  ['abs',       'path',    [{ d: _taper(39, 61, 55, 41, 59, 80, 1.5) }]],
  ['obliques',  'path',    [{ d: _taper(30, 39, 56, 33, 40, 79, 0.5) }, { d: _taperMirrored(30, 39, 56, 33, 40, 79, 0.5) }]],
  ['quads',     'path',    [{ d: UPPER_LEG_L }, { d: UPPER_LEG_R }]],
  ['calves',    'path',    [{ d: CALF_L }, { d: CALF_R }]],
];

const BACK_REGIONS = [
  ['traps',      'path', [{ d: _taper(46, 54, 25, 27, 73, 40, 1) }]],
  ['shoulders',  'ellipse', [_ellipseAttrs(SHOULDER_L), _ellipseAttrs(SHOULDER_R)]],
  ['upperBack',  'path', [{ d: _taper(38, 62, 40, 40, 60, 62, 1.5) }]],
  ['lats',       'path', [{ d: _taper(24, 39, 42, 32, 40, 67, 3.5) }, { d: _taperMirrored(24, 39, 42, 32, 40, 67, 3.5) }]],
  ['triceps',    'path', [{ d: UPPER_ARM_L }, { d: UPPER_ARM_R }]],
  ['forearms',   'path', [{ d: FOREARM_L }, { d: FOREARM_R }]],
  ['lowerBack',  'path', [{ d: _taper(38, 62, 62, 35, 65, 82, 1) }]],
  ['glutes',     'path', [{ d: _taper(31, 69, 83, 34, 66, 106, 5) }]],
  ['hamstrings', 'path', [{ d: UPPER_LEG_L }, { d: UPPER_LEG_R }]],
  ['calves',     'path', [{ d: CALF_L }, { d: CALF_R }]],
];

export const FRONT_MUSCLES = [...new Set(FRONT_REGIONS.map(r => r[0]))];
export const BACK_MUSCLES  = [...new Set(BACK_REGIONS.map(r => r[0]))];

function _attrsToStr(attrs) {
  return Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
}

/** Head/neck/hip-bridge/hands/feet, drawn first (so region shapes layer on
 *  top) — purely contextual, never highlighted. `view` picks the
 *  front-vs-back hip bridge (see HIP_BRIDGE_FRONT/BACK above); everything
 *  else is identical between the two. */
function _baseOutline(view) {
  const hipBridge = view === 'back' ? HIP_BRIDGE_BACK : HIP_BRIDGE_FRONT;
  return `
    <ellipse cx="50" cy="13" rx="8.5" ry="10" class="md-base" />
    <path d="${NECK}" class="md-base" />
    <path d="${hipBridge}" class="md-base" />
    <ellipse cx="19" cy="115" rx="4.5" ry="6" class="md-base" />
    <ellipse cx="81" cy="115" rx="4.5" ry="6" class="md-base" />
    <ellipse cx="38" cy="171" rx="7.5" ry="4" class="md-base" />
    <ellipse cx="62" cy="171" rx="7.5" ry="4" class="md-base" />
  `;
}

function _renderView(regions, highlighted, view) {
  const shapes = regions.map(([muscle, shape, attrList]) => {
    const isHi = highlighted.has(muscle);
    const cls = `md-region${isHi ? ' md-region-active' : ''}`;
    const label = MUSCLE_LABELS[muscle] ?? muscle;
    return attrList.map(attrs => `<${shape} ${_attrsToStr(attrs)} class="${cls}" data-muscle="${muscle}"><title>${label}</title></${shape}>`).join('');
  }).join('');
  return `<svg viewBox="0 0 100 200" class="muscle-diagram-svg">${_baseOutline(view)}${shapes}</svg>`;
}

/**
 * @param {string[]} muscleIds  Region ids to highlight (extras/unknown ids
 *   are simply never matched — not an error, see this file's doc comment).
 * @param {Object} [opts]
 * @param {boolean} [opts.compact=false]  Slightly smaller, for inline use
 *   next to a picker row instead of its own full-width card.
 * @returns {string} HTML for a `.muscle-diagram` container with both views.
 */
export function renderMuscleDiagram(muscleIds = [], { compact = false } = {}) {
  const highlighted = new Set(muscleIds);
  return `
    <div class="muscle-diagram${compact ? ' muscle-diagram-compact' : ''}">
      <div class="muscle-diagram-view">
        ${_renderView(FRONT_REGIONS, highlighted, 'front')}
        <span class="muscle-diagram-label">Front</span>
      </div>
      <div class="muscle-diagram-view">
        ${_renderView(BACK_REGIONS, highlighted, 'back')}
        <span class="muscle-diagram-label">Back</span>
      </div>
    </div>
  `;
}

export default { renderMuscleDiagram, FRONT_MUSCLES, BACK_MUSCLES, MUSCLE_LABELS };
