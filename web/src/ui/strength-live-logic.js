// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/strength-live-logic.js
 *
 * The pure parts of the live strength hero — everything that is arithmetic
 * or string-building and so can be checked in node: the stepper maths, the "Set N" number, the
 * compact progression ladder and its tooltip, and where the sequence strip should scroll to.
 * views/strength-session.js is the DOM around it; __strength_live_logic_smoketest__.js covers this
 * file, and scripts/browser-checks/live-strength-hero.py covers the wiring in the running app.
 *
 * No imports and no DOM: the named constants are meant to be tuned by hand on a phone.
 */

/** One tap on Reps' − / + is one rep. */
export const REPS_STEP = 1;
/** One tap on Target hold's − / + is five seconds. */
export const HOLD_STEP_SEC = 5;

/** Holding a stepper: wait this long, then repeat every REPEAT_INTERVAL_MS until released. */
export const REPEAT_DELAY_MS = 400;
export const REPEAT_INTERVAL_MS = 90;

/** A plate's worth: 2.5 kg, or 5 lb (the smallest pair of change plates most gyms stock). */
export function weightStep(imperial) {
  return imperial ? 5 : 2.5;
}

/**
 * The value after one tap on a stepper.
 * @param {number|null|undefined} current  what is in the field now; blank / NaN counts as 0
 * @param {number} direction  only its sign matters: positive adds a step, negative takes one off
 * @param {{step:number, min?:number, max?:number}} opts  `min` defaults to 0 (a rep count or a
 *   load is never negative); `max` has no default
 * @returns {number}
 */
export function stepValue(current, direction, { step, min = 0, max = Infinity } = {}) {
  const base = Number.isFinite(current) ? current : 0;
  const next = base + (direction < 0 ? -step : step);
  // 0.1 added thirty times is 3.0000000000000004; steps are small decimals, so round the drift off.
  const rounded = Math.round(next * 1e6) / 1e6;
  return Math.min(max, Math.max(min, rounded));
}

/**
 * The set the rider is about to log for `exerciseName`: one more than what is already logged for
 * it. Matches the way SetTracker numbers sets — exact name, after trimming.
 * @param {{exercise:string}[]} sets  every set logged so far this session
 * @param {string} exerciseName
 */
export function nextSetNumber(sets, exerciseName) {
  const name = (exerciseName ?? '').trim();
  return (sets ?? []).filter(s => s.exercise === name).length + 1;
}

/**
 * The compact ladder: the current rung and the one before and after it.
 * @param {{id:string}[]} chain  the whole skill line, novice -> master
 * @param {string} currentId
 * @returns {{prev:Object|null, current:Object, next:Object|null, index:number, total:number}|null}
 *   null when there is no chain or the exercise is not in it (so the ladder is hidden)
 */
export function ladderWindow(chain, currentId) {
  if (!Array.isArray(chain) || !chain.length) return null;
  const index = chain.findIndex(r => r.id === currentId);
  if (index < 0) return null;
  return {
    prev: chain[index - 1] ?? null,
    current: chain[index],
    next: chain[index + 1] ?? null,
    index,
    total: chain.length,
  };
}

/**
 * The tooltip behind the current rung: a heading, then every rung on its own line, with the
 * current one marked. The tooltip renders with `white-space: pre-line`, so "\n" is a line break.
 * @param {{id:string, name:string, levelLabel?:string}[]} chain
 * @param {string} currentId
 * @param {string} groupLabel  e.g. "Dip"
 */
export function ladderTip(chain, currentId, groupLabel) {
  const lines = chain.map((r, i) => {
    const level = r.levelLabel ? ` (${r.levelLabel})` : '';
    return `${i + 1}. ${r.name}${level}${r.id === currentId ? ' \u2190 you' : ''}`;
  });
  return [`${groupLabel} progression`, ...lines].join('\n');
}

/**
 * Where to scroll the sequence strip so an item sits in the middle of it — clamped to what the
 * strip can actually scroll, so the first and last pills stop at the edges instead of overshooting.
 * @param {{itemLeft:number, itemWidth:number, railWidth:number, scrollWidth:number}} g
 *   itemLeft is the item's left edge measured from the start of the scrollable content
 * @returns {number} the scrollLeft to set
 */
export function railScrollTarget({ itemLeft, itemWidth, railWidth, scrollWidth }) {
  const max = Math.max(0, scrollWidth - railWidth);
  return Math.min(max, Math.max(0, itemLeft + itemWidth / 2 - railWidth / 2));
}
