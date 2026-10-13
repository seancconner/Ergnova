// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/ui/__hr_slot_smoketest__.js
//
// Covers ui/hr-slot.js's pure parts: which face each
// status shows, the strip's number format, the miniature chart's geometry and trimming, and the
// markup both faces share. The DOM class is checked in the running app
// (scripts/browser-checks/live-strength-hr-slot.py) — there is no DOM runner in this project.

import {
  HR_SLOT_STATUSES, HR_SPARK_RANGE, hrSlotState, formatHr, sparkPoints, trimReadings, hrSlotHtml,
} from './hr-slot.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}
const count = (s, re) => (s.match(re) ?? []).length;

console.log('state per status');
const conn = hrSlotState('connected');
check('connected: strip only, no button', conn.showStrip && !conn.showButton && !conn.animating);
const disc = hrSlotState('disconnected');
check('disconnected: button, tappable, still', disc.showButton && !disc.showStrip && disc.tappable && !disc.animating);
check('disconnected says Connect', disc.label === 'Connect');
const ing = hrSlotState('connecting');
check('connecting: button, pulsing, NOT tappable', ing.showButton && ing.animating && !ing.tappable && ing.label === 'Connecting…');
const re = hrSlotState('reconnecting');
check('reconnecting: button, pulsing, own wording', re.showButton && re.animating && re.label === 'Reconnecting…');
check('reconnecting stays TAPPABLE (the wait has no deadline; a tap takes over)', re.tappable === true);
check('reconnecting tells a screen reader a tap chooses another monitor', /tap to choose/i.test(re.ariaLabel));
check('a deliberate disconnect (plain disconnected) never animates', !hrSlotState('disconnected').animating);
check('an unknown status falls back to the tappable button', (() => {
  const s = hrSlotState('banana');
  return s.status === 'disconnected' && s.showButton && s.tappable;
})());
check('undefined falls back too', hrSlotState(undefined).status === 'disconnected');
check('exactly one face shows in every status', HR_SLOT_STATUSES.every(s => {
  const st = hrSlotState(s);
  return st.showStrip !== st.showButton;
}));
check('only disconnected and reconnecting are tappable (connecting is in flight)', HR_SLOT_STATUSES.filter(s => hrSlotState(s).tappable).join() === 'reconnecting,disconnected');
check('every status that pulses can be told apart from one that is tappable and still', hrSlotState('connecting').animating && !hrSlotState('connecting').tappable && hrSlotState('disconnected').tappable && !hrSlotState('disconnected').animating);
check('every status has an accessible name', HR_SLOT_STATUSES.every(s => hrSlotState(s).ariaLabel.length > 0));

console.log('\nvalue format');
check('rounds to a whole number', formatHr(131.6) === '132' && formatHr(60) === '60');
check('no reading is a dash', formatHr(null) === '—' && formatHr(undefined) === '—' && formatHr(NaN) === '—');
check('zero is a dash, not "0 bpm"', formatHr(0) === '—' && formatHr(-3) === '—');

console.log('\nminiature chart geometry');
const NOW = 1_000_000;
const W = 200, H = 40;
const at = (secAgo, v) => ({ t: NOW - secAgo * 1000, v });
let pts = sparkPoints([at(0, 120)], NOW, W, H);
check('a reading from right now sits on the right edge', pts.length === 1 && pts[0].x === W);
pts = sparkPoints([at(120, 120)], NOW, W, H);
check('one from a full window ago sits on the left edge', pts.length === 1 && pts[0].x === 0);
pts = sparkPoints([at(60, 120)], NOW, W, H);
check('half a window ago is mid-strip', Math.abs(pts[0].x - W / 2) < 1e-9);
check('older than the window is dropped', sparkPoints([at(121, 120)], NOW, W, H).length === 0);
check('a reading from the future is dropped', sparkPoints([{ t: NOW + 5000, v: 120 }], NOW, W, H).length === 0);
const lo = sparkPoints([at(1, HR_SPARK_RANGE.yMin)], NOW, W, H)[0];
const hi = sparkPoints([at(1, HR_SPARK_RANGE.yMax)], NOW, W, H)[0];
check('higher bpm is higher on the strip (smaller y)', hi.y < lo.y);
check('the range ends stay inside the strip', lo.y <= H && hi.y >= 0, `lo.y=${lo.y} hi.y=${hi.y}`);
const wild = sparkPoints([at(1, 255), at(2, 12)], NOW, W, H);
check('a glitchy 255 or 12 is clamped onto the strip', wild.every(p => p.y >= 0 && p.y <= H));
check('null / NaN / zero readings are skipped', sparkPoints([at(1, null), at(2, NaN), at(3, 0), at(4, 100)], NOW, W, H).length === 1);
check('empty and missing input are fine', sparkPoints([], NOW, W, H).length === 0 && sparkPoints(undefined, NOW, W, H).length === 0);
check('points come back oldest to newest (x ascending)', (() => {
  const p = sparkPoints([at(90, 100), at(60, 110), at(30, 120), at(0, 130)], NOW, W, H);
  return p.every((q, i) => i === 0 || q.x > p[i - 1].x);
})());
check('a custom window rescales x', Math.abs(sparkPoints([at(30, 100)], NOW, W, H, { windowSec: 60 })[0].x - W / 2) < 1e-9);

console.log('\ntrimming');
const trimmed = trimReadings([at(300, 100), at(130, 100), at(100, 100), at(10, 100)], NOW);
check('drops what scrolled out, keeping one just outside so the line enters from the edge', trimmed.length === 3 && trimmed[0].t === NOW - 130_000);
check('everything old leaves nothing', trimReadings([at(500, 100), at(400, 100)], NOW).length === 0);
check('all-recent is untouched', trimReadings([at(20, 1), at(10, 1)], NOW).length === 2);
check('does not mutate its input', (() => {
  const input = [at(300, 100), at(10, 100)];
  trimReadings(input, NOW);
  return input.length === 2;
})());

console.log('\nmarkup');
const html = hrSlotHtml();
check('one slot root, one strip, one connect button', count(html, /data-hr-slot/g) === 1 && count(html, /data-hr-strip/g) === 1 && count(html, /data-hr-connect\b/g) >= 1 && count(html, /<button /g) === 1);
check('the strip starts hidden and the button visible (disconnected is the first frame)', /hr-slot-strip hidden/.test(html) && !/hr-slot-btn[^"]*hidden/.test(html));
check('the heart comes from the sprite, on both faces', count(html, /href="#icon-heart"/g) === 2);
check('the chart canvas is aria-hidden; the strip is named', html.includes('data-hr-spark aria-hidden="true"') && html.includes('aria-label="Heart rate"'));
check('the button is a real <button type="button">', html.includes('<button type="button"'));
check('the strip carries a value and a unit', html.includes('data-hr-value') && html.includes('>bpm<'));

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll HR slot checks passed.');
