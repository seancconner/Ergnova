// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/ui/__detail_sheet_smoketest__.js
//
// Covers ui/detail-sheet-logic.js — the pure parts of the shared detail sheet
//: the drag-to-dismiss decision, the rubber band, flick
// velocity, and where Tab goes in the focus trap. The component's DOM wiring is
// not exercised here (this project has no DOM test runner); it is checked in the
// running app.

import {
  DISMISS_FRACTION, DISMISS_VELOCITY, DISMISS_MIN_TRAVEL, RUBBER_BAND, RUBBER_BAND_MAX, VELOCITY_WINDOW_MS,
  dragOffset, dragProgress, flickVelocity, shouldDismiss, nextTabStop, FOCUSABLE_SELECTOR,
} from './detail-sheet-logic.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}

console.log('drag offset');
check('dragging down follows the finger 1:1', dragOffset(80) === 80 && dragOffset(0) === 0);
check('dragging up is resisted', dragOffset(-50) === -50 * RUBBER_BAND && dragOffset(-50) > -50);
check('dragging up is capped', dragOffset(-5000) === -RUBBER_BAND_MAX);
check('junk input is a resting sheet', dragOffset(NaN) === 0 && dragOffset(undefined) === 0);

console.log('\ndrag progress');
check('resting is 0', dragProgress(0, 600) === 0 && dragProgress(-10, 600) === 0);
check('half way down is 0.5', dragProgress(300, 600) === 0.5);
check('never exceeds 1', dragProgress(900, 600) === 1);
check('a zero-height sheet does not divide by zero', dragProgress(50, 0) === 0);

console.log('\nflick velocity');
check('no samples or one sample is 0', flickVelocity([]) === 0 && flickVelocity([{ t: 0, y: 0 }]) === 0 && flickVelocity(undefined) === 0);
check('100px in 100ms is 1 px/ms downward', flickVelocity([{ t: 0, y: 0 }, { t: 100, y: 100 }]) === 1);
check('upward motion is negative', flickVelocity([{ t: 0, y: 100 }, { t: 100, y: 0 }]) === -1);
check('samples older than the window are ignored (a slow start then a fast finish)',
  flickVelocity([{ t: 0, y: 0 }, { t: 400, y: 10 }, { t: 450, y: 60 }]) === 1, String(flickVelocity([{ t: 0, y: 0 }, { t: 400, y: 10 }, { t: 450, y: 60 }])));
check('identical timestamps do not divide by zero', flickVelocity([{ t: 5, y: 0 }, { t: 5, y: 50 }]) === 0);
check('the window is the documented constant', VELOCITY_WINDOW_MS === 100);

console.log('\ndismiss decision');
const H = 600;
check('a short, slow drag springs back', shouldDismiss({ dy: 60, velocity: 0.1, height: H }) === false);
check('a drag past the fraction of the height dismisses', shouldDismiss({ dy: H * DISMISS_FRACTION + 1, velocity: 0, height: H }) === true);
check('exactly at the fraction does not (strictly past it)', shouldDismiss({ dy: H * DISMISS_FRACTION, velocity: 0, height: H }) === false);
check('a fast flick dismisses even a short drag', shouldDismiss({ dy: DISMISS_MIN_TRAVEL + 1, velocity: DISMISS_VELOCITY + 0.1, height: H }) === true);
check('a fast twitch with almost no travel does not', shouldDismiss({ dy: DISMISS_MIN_TRAVEL - 1, velocity: 3, height: H }) === false);
check('a fast flick exactly at the speed limit does not (strictly faster)', shouldDismiss({ dy: 100, velocity: DISMISS_VELOCITY, height: H }) === false);
check('upward drags never dismiss', shouldDismiss({ dy: -200, velocity: -5, height: H }) === false && shouldDismiss({ dy: 0, velocity: 9, height: H }) === false);
check('an unmeasured height falls back to the flick rule only', shouldDismiss({ dy: 500, velocity: 0, height: 0 }) === false && shouldDismiss({ dy: 500, velocity: 1, height: 0 }) === true);

console.log('\nfocus trap');
check('Tab from the sheet itself goes to the first stop', nextTabStop(4, -1, false) === 0);
check('Shift+Tab from the sheet itself goes to the last stop', nextTabStop(4, -1, true) === 3);
check('Tab moves forward', nextTabStop(4, 1, false) === 2);
check('Tab wraps from the last to the first', nextTabStop(4, 3, false) === 0);
check('Shift+Tab moves back', nextTabStop(4, 2, true) === 1);
check('Shift+Tab wraps from the first to the last', nextTabStop(4, 0, true) === 3);
check('focus that strayed past the end is pulled back in', nextTabStop(4, 9, false) === 0 && nextTabStop(4, 9, true) === 3);
check('nothing focusable gives -1 so the caller can keep focus on the sheet', nextTabStop(0, -1, false) === -1);
check('one stop loops onto itself', nextTabStop(1, 0, false) === 0 && nextTabStop(1, 0, true) === 0);
check('the focusable selector skips disabled buttons and tabindex=-1', FOCUSABLE_SELECTOR.includes('button:not([disabled])') && FOCUSABLE_SELECTOR.includes('[tabindex]:not([tabindex="-1"])'));

console.log(failures === 0 ? '\nAll detail sheet checks passed.' : `\n${failures} detail sheet check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
