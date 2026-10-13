// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Export + print bridge, JS side: public/native-shell-bridge.js (the classic script that owns
// window.__ergnovaNativeFile / window.__ergnovaNativePrint) wired up to the real
// platform/save-file.js and platform/print.js, with a fake HybridWebView standing in for the
// MAUI shell. The method names and argument order asserted below are the contract with
// Services/NativeBridgeMethods.cs's FileSaveBlob(filename, base64Data, mimeType) and
// PrintCurrentPage(jobName, html) — change one side, change the other.
//
// Also guards the regression that killed exports once: call sites that build their own
// `<a download>` (or call window.print()) instead of going through the bridge helpers, which
// does nothing inside the HybridWebView shell.
// Run with: node src/platform/__native_file_print_smoketest__.js

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

const srcRoot = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = fileURLToPath(new URL('../../public', import.meta.url));

// ── Fake shell ─────────────────────────────────────────────────────────────
const invoked = [];
let nativeReply = (name) => Promise.resolve(true);
const win = {
  HybridWebView: {
    InvokeDotNet: (name, args) => { invoked.push({ name, args }); return nativeReply(name, args); },
  },
  addEventListener: () => {},
  // The bridge's blobToBase64 uses FileReader (a browser API); node has none, so provide the
  // one method the bridge touches.
  FileReader: class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
        this.onloadend();
      }, (err) => this.onerror(err));
    }
  },
  print: () => { win.__printCalls++; },
  __printCalls: 0,
};
globalThis.window = win;
win.window = win;

const bridgeSrc = readFileSync(join(publicRoot, 'native-shell-bridge.js'), 'utf8');
vm.runInNewContext(bridgeSrc, win, { filename: 'native-shell-bridge.js' });

const { saveFile } = await import('./save-file.js');
const { printPage } = await import('./print.js');

// ── Export: bridge contract ────────────────────────────────────────────────
console.log('native-shell-bridge.js + save-file.js (export)');

check('the bridge exposes __ergnovaNativeFile.saveBlob', typeof win.__ergnovaNativeFile?.saveBlob === 'function');

const payload = new Blob([Uint8Array.from([0, 1, 2, 250, 255])], { type: 'application/octet-stream' });
invoked.length = 0;
const savedOk = await saveFile('2026-09-20_Free_Ride.fit', payload);
const saveCall = invoked.find((c) => c.name === 'FileSaveBlob');
check('saveFile() invokes FileSaveBlob', !!saveCall);
check('...with (filename, base64, mime) in that order',
  saveCall?.args?.[0] === '2026-09-20_Free_Ride.fit'
  && saveCall?.args?.[1] === Buffer.from([0, 1, 2, 250, 255]).toString('base64')
  && saveCall?.args?.[2] === 'application/octet-stream');
check('...and resolves true when the native side saved it', savedOk === true);

nativeReply = () => Promise.resolve(false); // person cancelled the native save dialog / FileSaver failed
check('saveFile() resolves false (not a rejection) when the native side reports not-saved',
  (await saveFile('x.tcx', new Blob(['<x/>'], { type: 'application/xml' }))) === false);

nativeReply = () => Promise.reject(new Error('bridge down'));
const origWarn = console.warn; console.warn = () => {};
const savedAfterThrow = await saveFile('x.csv', new Blob(['a,b'], { type: 'text/csv' }));
console.warn = origWarn;
check('saveFile() resolves false (not a rejection) when the bridge call throws', savedAfterThrow === false);

// ── Export: web fallback when there is no native bridge ────────────────────
const nativeFile = win.__ergnovaNativeFile;
delete win.__ergnovaNativeFile;
const clicks = [];
globalThis.document = {
  createElement: () => ({ click() { clicks.push(this); } }),
  body: { appendChild() {}, removeChild() {} },
};
const webSaved = await saveFile('web.json', new Blob(['{}'], { type: 'application/json' }));
check('without the native bridge, saveFile() falls back to an <a download> click',
  clicks.length === 1 && clicks[0].download === 'web.json' && typeof clicks[0].href === 'string' && webSaved === true);
win.__ergnovaNativeFile = nativeFile;
delete globalThis.document;

// ── Print: bridge contract + fallback ──────────────────────────────────────
console.log('native-shell-bridge.js + print.js (print)');

check('the bridge exposes __ergnovaNativePrint.printPage', typeof win.__ergnovaNativePrint?.printPage === 'function');

nativeReply = () => Promise.resolve(true);
invoked.length = 0;
const printed = await printPage('Chicken Tikka');
const printCall = invoked.find((c) => c.name === 'PrintCurrentPage');
check('printPage() invokes PrintCurrentPage with the job name', printCall?.args?.[0] === 'Chicken Tikka');
check('...resolves true, and does not also call window.print()', printed === true && win.__printCalls === 0);
check('with no html, PrintCurrentPage still gets exactly two args (html as "") — InvokeDotNet matches by count',
  printCall?.args?.length === 2 && printCall.args[1] === '');

invoked.length = 0;
const standaloneDoc = '<!DOCTYPE html><html><body>Recipe</body></html>';
await printPage('Chicken Tikka', { html: standaloneDoc });
check('printPage(job, { html }) passes the standalone document as the second arg',
  invoked[0]?.name === 'PrintCurrentPage' && invoked[0].args?.length === 2 && invoked[0].args[1] === standaloneDoc);

invoked.length = 0;
await win.__ergnovaNativePrint.printPage('');
check('an empty job name is replaced with a default rather than crossing empty', invoked[0]?.args?.[0] === 'Ergnova');

nativeReply = () => Promise.resolve(false); // this platform can't print natively
const fellBack = await printPage('Recipe');
check('native says it cannot print -> falls back to window.print()', fellBack === true && win.__printCalls === 1);

nativeReply = () => Promise.reject(new Error('bridge down'));
console.warn = () => {};
const fellBackOnThrow = await printPage('Recipe');
console.warn = origWarn;
check('native call throws -> falls back to window.print()', fellBackOnThrow === true && win.__printCalls === 2);

const nativePrint = win.__ergnovaNativePrint;
delete win.__ergnovaNativePrint;
await printPage('Recipe');
check('no native bridge (plain browser) -> window.print()', win.__printCalls === 3);
win.__ergnovaNativePrint = nativePrint;

// ── Regression guard: nothing bypasses the helpers ─────────────────────────
console.log('call sites go through the bridge helpers');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}
const codeOnly = (line) => line.replace(/\/\/.*$/, '').trim();
const isCommentLine = (line) => /^\s*(\*|\/\*|\/\/)/.test(line);

const skipFile = (rel) =>
  rel.includes(`ble${sep}reference${sep}`)
  || /__.*smoketest__\.js$/.test(rel);

const rawDownloads = [];
const rawPrints = [];
for (const file of walk(srcRoot)) {
  const rel = relative(srcRoot, file);
  if (skipFile(rel)) continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    const code = codeOnly(line);
    if (rel !== join('platform', 'save-file.js') && (/\bdownload\s*:/.test(code) || /createObjectURL\s*\(/.test(code))) {
      rawDownloads.push(`${rel}:${i + 1}`);
    }
    if (rel !== join('platform', 'print.js') && /\bwindow\.print\s*\(/.test(code)) {
      rawPrints.push(`${rel}:${i + 1}`);
    }
  });
}
check(`no <a download>/createObjectURL outside platform/save-file.js${rawDownloads.length ? ` — found: ${rawDownloads.join(', ')}` : ''}`,
  rawDownloads.length === 0);
check(`no window.print() outside platform/print.js${rawPrints.length ? ` — found: ${rawPrints.join(', ')}` : ''}`,
  rawPrints.length === 0);

if (failures) {
  console.log(`\n${failures} export/print bridge check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll export/print bridge checks passed.');
