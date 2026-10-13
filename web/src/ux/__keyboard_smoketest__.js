// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/ux/__keyboard_smoketest__.js
//
// Covers ux/keyboard.js's KeyboardController._onKey — the global shortcuts — without a DOM:
// it is called directly with stand-in key events.

import { KeyboardController } from './keyboard.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}

function setup({ running = false } = {}) {
  const calls = [];
  const kc = new KeyboardController({
    isRunning: () => running,
    onStart: () => calls.push('start'), onStop: () => calls.push('stop'),
    onLap: () => calls.push('lap'), onCancel: () => calls.push('cancel'),
  });
  const press = (key, { tag = 'DIV', defaultPrevented = false, ctrl = false } = {}) => {
    const e = { key, target: { tagName: tag }, defaultPrevented, ctrlKey: ctrl, metaKey: false, altKey: false,
      preventDefault() { this.defaultPrevented = true; } };
    kc._onKey(e);
    return e;
  };
  return { calls, press };
}

console.log('shortcuts fire');
{
  const { calls, press } = setup();
  const e = press(' ');
  check('Space starts a session when none is running', calls.join() === 'start');
  check('and stops the page scrolling', e.defaultPrevented === true);
  press('l'); press('Escape');
  check('L is a lap and Escape cancels', calls.join() === 'start,lap,cancel', calls.join());
}
{
  const { calls, press } = setup({ running: true });
  press(' ');
  check('Space stops a running session', calls.join() === 'stop');
}

console.log('\nshortcuts stay out of the way');
{
  const { calls, press } = setup();
  press(' ', { tag: 'INPUT' }); press('l', { tag: 'TEXTAREA' }); press('s', { tag: 'SELECT' });
  check('typing in a field is never a shortcut', calls.length === 0, calls.join());
  press(' ', { ctrl: true });
  check('a Ctrl chord is never a shortcut', calls.length === 0);
  press('q');
  check('an unmapped key does nothing', calls.length === 0);
}

console.log('\na widget that already handled the key');
{
  const { calls, press } = setup();
  const e = press(' ', { defaultPrevented: true });
  check('Space a tile/card already handled does not also start a session', calls.length === 0, calls.join());
  press('l', { defaultPrevented: true }); press('Escape', { defaultPrevented: true });
  check('nor do the other shortcuts', calls.length === 0, calls.join());
  check('the event is left exactly as the widget left it', e.defaultPrevented === true);
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll keyboard checks passed.');
