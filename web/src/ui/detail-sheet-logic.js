// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/detail-sheet-logic.js
 *
 * The pure arithmetic behind ui/detail-sheet.js: when a
 * drag-down dismisses the sheet, how far the sheet follows a finger, how fast a
 * flick was, and where Tab goes next inside the focus trap. Kept free of the DOM
 * so it runs under plain node and is covered by __detail_sheet_smoketest__.js —
 * the component itself is only wiring around these.
 *
 * Every number the gesture is judged by is a named constant here: like the
 * carousel's pull threshold (§4), it is meant to be tuned by hand on a phone.
 */

/** A drag past this fraction of the sheet's height dismisses it on release. */
export const DISMISS_FRACTION = 0.28;
/** A flick faster than this (px per ms) dismisses it, if it also moved at all… */
export const DISMISS_VELOCITY = 0.6;
/** …by at least this many px, so a twitch of the thumb doesn't close it. */
export const DISMISS_MIN_TRAVEL = 24;
/** Dragging *up* past the open position is resisted: the sheet follows at this share of the finger… */
export const RUBBER_BAND = 0.2;
/** …and never rises more than this many px above its resting place. */
export const RUBBER_BAND_MAX = 24;
/** Only pointer samples this recent (ms) count toward a flick's velocity. */
export const VELOCITY_WINDOW_MS = 100;

/** Where the sheet sits while a finger is `dy` px below (positive) or above (negative)
 *  where the drag began. Down is 1:1; up is resisted and capped.
 *  @param {number} dy @returns {number} translateY in px */
export function dragOffset(dy) {
  if (!(dy < 0)) return dy || 0;
  return Math.max(dy * RUBBER_BAND, -RUBBER_BAND_MAX);
}

/** How far through a dismiss the drag is, 0 (resting) to 1 (a full sheet height down) —
 *  what the scrim fades by. @param {number} offset @param {number} height */
export function dragProgress(offset, height) {
  if (!(height > 0) || !(offset > 0)) return 0;
  return Math.min(offset / height, 1);
}

/** Speed of a drag in px/ms (positive = downward), from its recent pointer samples
 *  [{t, y}] — the newest sample against the oldest one still inside the window.
 *  @param {{t:number, y:number}[]} samples @returns {number} */
export function flickVelocity(samples) {
  if (!samples || samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > VELOCITY_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/** Whether releasing a drag should close the sheet.
 *  @param {{dy:number, velocity:number, height:number}} drag */
export function shouldDismiss({ dy, velocity, height }) {
  if (!(dy > 0)) return false;
  if (height > 0 && dy > height * DISMISS_FRACTION) return true;
  return velocity > DISMISS_VELOCITY && dy > DISMISS_MIN_TRAVEL;
}

/** Where Tab moves inside the focus trap, as an index into `count` focusable elements.
 *  `index` is the current one, or -1 when focus is on the sheet itself or has strayed
 *  outside it. Wraps at both ends. Returns -1 when there is nothing focusable (the
 *  caller then keeps focus on the sheet).
 *  @param {number} count @param {number} index @param {boolean} shift */
export function nextTabStop(count, index, shift) {
  if (!(count > 0)) return -1;
  if (index < 0 || index >= count) return shift ? count - 1 : 0;
  return shift ? (index - 1 + count) % count : (index + 1) % count;
}

/** Elements the trap cycles through. */
export const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');
