// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/ui/__strength_live_logic_smoketest__.js
//
// Covers ui/strength-live-logic.js — the pure parts of the live strength hero: stepper arithmetic, the set number, the compact progression ladder and its
// tooltip, and the single-line sequence strip's scroll target. The DOM wiring is not
// exercised here (this project has no DOM test runner); scripts/browser-checks/
// live-strength-hero.py checks it in the running app.

import {
  REPS_STEP, HOLD_STEP_SEC, weightStep, stepValue, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS,
  nextSetNumber, ladderWindow, ladderTip, railScrollTarget,
} from './strength-live-logic.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}

console.log('steppers');
check('reps step by one, hold by five seconds', REPS_STEP === 1 && HOLD_STEP_SEC === 5);
check('weight steps by a plate: 2.5 kg, 5 lb', weightStep(false) === 2.5 && weightStep(true) === 5);
check('+ adds a step', stepValue(10, 1, { step: 2.5 }) === 12.5);
check('- subtracts a step', stepValue(10, -1, { step: 2.5 }) === 7.5);
check('a blank field counts as 0', stepValue(null, 1, { step: 1 }) === 1 && stepValue(undefined, 1, { step: 5 }) === 5 && stepValue(NaN, 1, { step: 1 }) === 1);
check('it never goes below the minimum (default 0)', stepValue(1, -1, { step: 5 }) === 0 && stepValue(0, -1, { step: 1 }) === 0);
check('a minimum can be set', stepValue(2, -1, { step: 5, min: 1 }) === 1);
check('a maximum can be set', stepValue(9, 1, { step: 5, max: 10 }) === 10);
check('forty 2.5 steps land on exactly 100 (no float drift)', (() => { let v = 0; for (let i = 0; i < 40; i++) v = stepValue(v, 1, { step: 2.5 }); return v === 100; })());
check('thirty 0.1 steps land on exactly 3', (() => { let v = 0; for (let i = 0; i < 30; i++) v = stepValue(v, 1, { step: 0.1 }); return v === 3; })());
check('only the sign of the direction matters', stepValue(5, -7, { step: 1 }) === 4 && stepValue(5, 7, { step: 1 }) === 6);
check('auto-repeat waits, then repeats faster than the wait', REPEAT_DELAY_MS > REPEAT_INTERVAL_MS && REPEAT_INTERVAL_MS > 0);

console.log('\nset number');
const sets = [{ exercise: 'Chest Dip' }, { exercise: 'Push-Up' }, { exercise: 'Chest Dip' }];
check('one more than what is logged for that exercise', nextSetNumber(sets, 'Chest Dip') === 3 && nextSetNumber(sets, 'Push-Up') === 2);
check('the first set of something new is 1', nextSetNumber(sets, 'Ring Dip') === 1 && nextSetNumber([], 'Ring Dip') === 1 && nextSetNumber(undefined, 'X') === 1);
check('the name is trimmed like the logger trims it', nextSetNumber(sets, '  Chest Dip ') === 3);
check('the match is exact, as SetTracker numbers sets', nextSetNumber(sets, 'chest dip') === 1);

console.log('\nprogression ladder');
const chain = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: `Rung ${id.toUpperCase()}`, levelLabel: `L${id}` }));
const mid = ladderWindow(chain, 'c');
check('the middle of the chain has both neighbours', mid.prev.id === 'b' && mid.current.id === 'c' && mid.next.id === 'd' && mid.index === 2 && mid.total === 5);
const first = ladderWindow(chain, 'a');
check('the first rung has no previous', first.prev === null && first.next.id === 'b' && first.index === 0);
const last = ladderWindow(chain, 'e');
check('the last rung has no next', last.next === null && last.prev.id === 'd' && last.index === 4);
check('an unknown exercise or an empty chain is no ladder', ladderWindow(chain, 'zzz') === null && ladderWindow([], 'a') === null && ladderWindow(undefined, 'a') === null);
check('a one-rung chain is just itself', (() => { const w = ladderWindow([chain[0]], 'a'); return w.prev === null && w.next === null && w.total === 1; })());
const lines = ladderTip(chain, 'c', 'Dip').split('\n');
check('the tooltip lists every rung in order, one per line, under a heading', lines.length === 6 && lines[0] === 'Dip progression' && lines[1].startsWith('1. Rung A') && lines[5].startsWith('5. Rung E'), lines.join(' | '));
check('it marks only the current rung', lines.filter(l => l.includes('you')).length === 1 && lines[3].includes('you'));
check('it includes the level labels', lines[1].includes('(La)') && lines[5].includes('(Le)'));
check('a rung with no level label has no empty brackets', !ladderTip([{ id: 'x', name: 'Lone' }], 'x', 'G').includes('()'));

console.log('\nsequence strip scroll');
check('centres the item', railScrollTarget({ itemLeft: 500, itemWidth: 100, railWidth: 300, scrollWidth: 1200 }) === 400);
check('never scrolls below 0', railScrollTarget({ itemLeft: 10, itemWidth: 100, railWidth: 300, scrollWidth: 1200 }) === 0);
check('never past the end', railScrollTarget({ itemLeft: 1100, itemWidth: 100, railWidth: 300, scrollWidth: 1200 }) === 900);
check('a strip that fits does not scroll', railScrollTarget({ itemLeft: 50, itemWidth: 100, railWidth: 300, scrollWidth: 300 }) === 0);

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll strength-live checks passed.');
