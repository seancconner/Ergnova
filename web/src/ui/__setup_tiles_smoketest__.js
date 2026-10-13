// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/ui/__setup_tiles_smoketest__.js
//
// Covers ui/setup-tiles.js's HTML builders: the icon tile group and the
// device tile the two setup flows share, and the swipeable card strip (markup + which-card maths). patchDeviceTile() is exercised against a tiny stand-in
// for the two elements it touches (there is no DOM runner in this project); the rest of the
// behaviour is checked in the running app (scripts/browser-checks/session-flow-sheets.py).

import { tileGroupHtml, deviceTileHtml, patchDeviceTile, cardStripHtml, activeStripIndex, esc, DEVICE_STATUS_TEXT } from './setup-tiles.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}
const count = (s, re) => (s.match(re) ?? []).length;

console.log('tile group');
const tiles = [
  { value: 'indoor', label: 'Indoor', icon: 'icon-home', blurb: 'On a trainer' },
  { value: 'outdoor', label: 'Outdoor', icon: 'icon-sun' },
];
const g = tileGroupHtml(tiles, { attr: 'data-location', selected: 'outdoor' });
check('one button per tile', count(g, /<button /g) === 2);
check('each carries the caller\'s data attribute', g.includes('data-location="indoor"') && g.includes('data-location="outdoor"'));
check('only the selected tile is .selected / aria-pressed', count(g, /sf-tile selected/g) === 1 && g.includes('data-location="outdoor"\n          aria-pressed="true"'));
check('the other tile is aria-pressed false', g.includes('aria-pressed="false"'));
check('the column count follows the tile count', g.includes('--cols:2') && tileGroupHtml([tiles[0]], { attr: 'data-x' }).includes('--cols:1'));
check('a blurb becomes the title; no blurb, no title', g.includes('title="On a trainer"') && count(g, /title=/g) === 1);
check('icons are drawn from the sprite', g.includes('href="#icon-home"') && g.includes('href="#icon-sun"'));
check('an empty list is still one valid group', tileGroupHtml([], { attr: 'data-x' }).includes('sf-tile-group') && tileGroupHtml(undefined).includes('--cols:1'));
check('labels and values are escaped', (() => {
  const h = tileGroupHtml([{ value: 'a"b', label: '<b>x</b>', icon: 'icon-x' }], { attr: 'data-k' });
  return !h.includes('<b>x</b>') && h.includes('&lt;b&gt;x&lt;/b&gt;') && h.includes('data-k="a&quot;b"');
})());
check('no selection selects nothing', count(tileGroupHtml(tiles, { attr: 'data-l' }), /sf-tile selected/g) === 0);

console.log('\ndevice tile');
const d = deviceTileHtml({ prefix: 'qs', kind: 'hrm', label: 'Heart Rate Monitor', icon: 'icon-heart', status: 'disconnected' });
check('the tile is the connect button with the old ids', d.includes('id="qs-connect-hrm"') && d.includes('id="qs-dot-hrm"'));
check('disconnected: enabled, says Connect, ring status-disconnected', !d.includes(' disabled') && d.includes('>Connect<') && d.includes('status-disconnected'));
const c = deviceTileHtml({ prefix: 'qs', kind: 'hrm', label: 'HRM', icon: 'icon-heart', status: 'connecting' });
check('connecting: disabled, says Connecting…', c.includes(' disabled') && c.includes('>Connecting…<') && c.includes('status-connecting'));
const k = deviceTileHtml({ prefix: 'ss', kind: 'hrm', label: 'HRM', icon: 'icon-heart', status: 'connected' });
check('connected: disabled, .connected, says Connected', k.includes(' disabled') && k.includes('sf-device-tile connected') && k.includes('>Connected<'));
check('an unknown status falls back to disconnected', deviceTileHtml({ prefix: 'qs', kind: 'x', label: 'X', icon: 'icon-dot', status: 'bogus' }).includes('status-disconnected'));
check('the prefix keeps the two flows\' ids apart', k.includes('id="ss-connect-hrm"') && !k.includes('qs-'));
check('the label is escaped', !deviceTileHtml({ prefix: 'qs', kind: 'x', label: '<i>', icon: 'icon-dot' }).includes('<i>'));
check('status words match the documented set', DEVICE_STATUS_TEXT.disconnected === 'Connect' && DEVICE_STATUS_TEXT.connecting === 'Connecting…' && DEVICE_STATUS_TEXT.connected === 'Connected');

console.log('\ncardStripHtml');
const cards = [
  { html: '<button data-a>A</button>', selected: false },
  { html: '<button data-b>B</button>', selected: true },
  { html: '<button data-c>C</button>', selected: false },
];
const strip = cardStripHtml({ id: 'ss-sequence-strip', label: 'Resistance sequence', cards });
check('the strip carries the caller\'s id and a labelled listbox', strip.includes('id="ss-sequence-strip"') && strip.includes('role="listbox"') && strip.includes('aria-label="Resistance sequence"'));
check('every card\'s own markup is kept, in order', strip.indexOf('data-a') < strip.indexOf('data-b') && strip.indexOf('data-b') < strip.indexOf('data-c'));
check('one snap item per card; only the selected one is .selected', count(strip, /class="sf-strip-item/g) === 3 && count(strip, /sf-strip-item selected/g) === 1);
check('one dot per card, the first lit', count(strip, /class="sf-strip-dot[ "]/g) === 3 && count(strip, /sf-strip-dot active/g) === 1);
check('a single card has nothing to swipe to, so no dots', !cardStripHtml({ id: 'x', label: 'x', cards: [cards[0]] }).includes('sf-strip-dot'));
check('an empty or missing list is still one valid strip', cardStripHtml({ id: 'x', label: 'x' }).includes('sf-strip-track') && cardStripHtml().includes('sf-strip-track'));
check('id and label are escaped', cardStripHtml({ id: 'a"b', label: '<i>', cards: [] }).includes('id="a&quot;b"') && !cardStripHtml({ id: 'a', label: '<i>', cards: [] }).includes('<i>'));

console.log('\nactiveStripIndex');
const offsets = [0, 270, 540, 810];           // four cards, 270px apart
check('at the start, the first card', activeStripIndex(offsets, 0, 600) === 0);
check('a little past the first card is still the first', activeStripIndex(offsets, 100, 600) === 0);
check('past the halfway point it is the next card', activeStripIndex(offsets, 150, 600) === 1);
check('exactly on a card', activeStripIndex(offsets, 540, 600) === 2);
check('the far end counts as the last card even when its own offset is out of reach', activeStripIndex(offsets, 600, 600) === 3);
check('one pixel short of the far end still rounds to the last card', activeStripIndex(offsets, 599, 600) === 3);
check('a strip that does not scroll stays on the first card', activeStripIndex([0, 100], 0, 0) === 0);
check('no cards is index 0, not a crash', activeStripIndex([], 50, 100) === 0 && activeStripIndex(undefined, 0, 0) === 0);

console.log('\npatchDeviceTile');
function fakeRoot() {
  const ring = { className: 'sf-device-ring status-disconnected' };
  const text = { textContent: 'Connect' };
  const set = new Set();
  const btn = { disabled: false, classList: { toggle: (n, on) => (on ? set.add(n) : set.delete(n)), has: n => set.has(n) }, querySelector: () => text };
  const root = { querySelector: sel => (sel === '#qs-dot-hrm' ? ring : sel === '#qs-connect-hrm' ? btn : null) };
  return { root, ring, btn, text };
}
let f = fakeRoot();
patchDeviceTile(f.root, 'qs', 'hrm', 'connecting');
check('connecting: ring class, disabled, words', f.ring.className === 'sf-device-ring status-connecting' && f.btn.disabled && f.text.textContent === 'Connecting…');
patchDeviceTile(f.root, 'qs', 'hrm', 'connected');
check('connected: .connected on, still disabled', f.btn.classList.has('connected') && f.btn.disabled && f.text.textContent === 'Connected');
patchDeviceTile(f.root, 'qs', 'hrm', 'disconnected');
check('back to disconnected: enabled, .connected off', !f.btn.disabled && !f.btn.classList.has('connected') && f.text.textContent === 'Connect');
check('a tile that is not on screen is a no-op', (() => { try { patchDeviceTile(f.root, 'qs', 'smo2', 'connected'); patchDeviceTile(null, 'qs', 'hrm', 'connected'); return true; } catch { return false; } })());

console.log('\nesc');
check('escapes the five HTML characters', esc(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;');
check('null and undefined become empty', esc(null) === '' && esc(undefined) === '');

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll setup tile checks passed.');
