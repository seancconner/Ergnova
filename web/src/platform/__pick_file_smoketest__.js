// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Import file picker, JS side: public/native-shell-bridge.js's __ergnovaNativeFile.pickText wired
// to platform/pick-file.js, with a fake HybridWebView standing in for the MAUI shell. The method
// name and reply shape asserted here are the contract with Services/NativeBridgeMethods.cs's
// FilePickText() -> { name, text } | null — change one side, change the other.
// Run with: node src/platform/__pick_file_smoketest__.js

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

const publicRoot = fileURLToPath(new URL('../../public', import.meta.url));

const invoked = [];
let nativeReply = () => Promise.resolve(null);
const win = {
  HybridWebView: { InvokeDotNet: (name, args) => { invoked.push({ name, args }); return nativeReply(name, args); } },
  addEventListener: () => {},
  FileReader: class {},
};
globalThis.window = win;
win.window = win;
vm.runInNewContext(readFileSync(join(publicRoot, 'native-shell-bridge.js'), 'utf8'), win, { filename: 'native-shell-bridge.js' });

const { pickTextFile } = await import('./pick-file.js');

console.log('native bridge');
check('the bridge exposes __ergnovaNativeFile.pickText', typeof win.__ergnovaNativeFile?.pickText === 'function');

nativeReply = () => Promise.resolve({ name: 'history.json', text: '{"a":1}' });
invoked.length = 0;
const picked = await pickTextFile();
check('pickTextFile() invokes FilePickText with no arguments', invoked.length === 1 && invoked[0].name === 'FilePickText' && invoked[0].args === undefined);
check('...and resolves { name, text } from the native reply', picked?.name === 'history.json' && picked?.text === '{"a":1}');

nativeReply = () => Promise.resolve(null);
check('a cancelled pick (null) resolves null', (await pickTextFile()) === null);

// ── Fallback: <input type="file"> ──────────────────────────────────────────
console.log('<input type="file"> fallback');
let lastInput = null;
function fakeInput(behaviour) {
  const listeners = {};
  const el = {
    type: '', accept: '', hidden: false, files: [],
    addEventListener(name, fn) { listeners[name] = fn; },
    remove() { el.removed = true; },
    click() { queueMicrotask(() => behaviour(el, listeners)); },
  };
  lastInput = el;
  return el;
}
const setDocument = (behaviour) => {
  globalThis.document = { createElement: () => fakeInput(behaviour), body: { appendChild() {} } };
};

const nativeFile = win.__ergnovaNativeFile;

nativeReply = () => Promise.reject(new Error('bridge down'));
const origWarn = console.warn; console.warn = () => {};
setDocument(async (el, l) => { el.files = [{ name: 'fallback.json', text: async () => 'hello' }]; await l.change(); });
const viaFallback = await pickTextFile();
console.warn = origWarn;
check('a throwing bridge call falls back to the file input', viaFallback?.name === 'fallback.json' && viaFallback?.text === 'hello');
check('...the input filters to JSON and is removed afterwards', lastInput.accept.includes('.json') && lastInput.removed === true);

delete win.__ergnovaNativeFile;
setDocument(async (el, l) => { el.files = [{ name: 'web.json', text: async () => 'web' }]; await l.change(); });
check('with no native bridge (plain browser) the file input is used',
  (await pickTextFile())?.text === 'web');

setDocument((el, l) => l.cancel());
check('cancelling the file dialog resolves null', (await pickTextFile()) === null);

setDocument(async (el, l) => { el.files = []; await l.change(); });
check('a change event with no file resolves null', (await pickTextFile()) === null);

setDocument(async (el, l) => { el.files = [{ name: 'bad.json', text: () => Promise.reject(new Error('unreadable')) }]; await l.change(); });
let rejected = false;
try { await pickTextFile(); } catch { rejected = true; }
check('a chosen-but-unreadable file rejects', rejected);

win.__ergnovaNativeFile = nativeFile;
delete globalThis.document;

if (failures) {
  console.log(`\n${failures} pick-file check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll pick-file checks passed.');
