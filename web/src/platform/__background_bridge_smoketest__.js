// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Native -> JS wire for the notification's Pause / Play button: public/native-shell-bridge.js
// (the classic script that owns window.__ergnovaNativeBackground) wired up to the real
// platform/background-session.js, with a fake HybridWebView standing in for the MAUI shell.
// The push message below is byte-for-byte what NativeBridgeMethods.DispatchBackgroundAction
// serializes on the C# side.
// Run with: node src/platform/__background_bridge_smoketest__.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));

// ── A fake shell: HybridWebView.InvokeDotNet records calls, and the page's
//    'HybridWebViewMessageReceived' listener is captured so we can push at it. ──
const invoked = [];
let onNativeMessage = null;
const win = {
  HybridWebView: {
    InvokeDotNet: (name, args) => {
      invoked.push({ name, args });
      if (name === 'BackgroundGetInfo') return Promise.resolve({ supported: true, platform: 'android', notificationsAllowed: true, running: false });
      if (name === 'BackgroundStart') return Promise.resolve({ supported: true, platform: 'android', notificationsAllowed: true, running: true });
      return Promise.resolve(undefined);
    },
  },
  addEventListener: (type, fn) => { if (type === 'HybridWebViewMessageReceived') onNativeMessage = fn; },
};
globalThis.window = win;
win.window = win;

// The bridge is a classic (non-module) script — run it the way the browser does.
const bridgeSrc = readFileSync(fileURLToPath(new URL('../../public/native-shell-bridge.js', import.meta.url)), 'utf8');
vm.runInNewContext(bridgeSrc, win, { filename: 'native-shell-bridge.js' });

const { backgroundSession } = await import('./background-session.js');

// C# side: JsonSerializer.Serialize(new { channel = "background", type = "action", detail = new { action } })
const push = action => onNativeMessage({ detail: { message: JSON.stringify({ channel: 'background', type: 'action', detail: { action } }) } });
const updates = () => invoked.filter(c => c.name === 'BackgroundUpdate').map(c => JSON.parse(c.args[0]));
const snap = (over = {}) => ({ title: 'Free Ride', status: 'running', elapsedSec: 10, text: '200 W', expanded: '', ...over });

console.log('native-shell-bridge.js + background-session.js (notification actions)');

check('the bridge script exposes the background bridge and listens for native pushes',
  typeof win.__ergnovaNativeBackground?.setActionHandler === 'function' && typeof onNativeMessage === 'function');

const received = [];
backgroundSession.onAction(action => {
  received.push(action);
  // What app.js does: pause the workout, then tell the module what's showing now.
  if (action === 'pause') backgroundSession.sync(snap({ status: 'paused', text: '200 W' }));
  if (action === 'play')  backgroundSession.sync(snap({ status: 'running' }));
});
await backgroundSession.init();
backgroundSession.sync(snap());
await flush();
check('setup: service started with the running snapshot', invoked.some(c => c.name === 'BackgroundStart') && backgroundSession.isKeepingAlive);

push('pause');
await flush();
check('a native "pause" push reaches the app callback', received[0] === 'pause');
check('...and the notification is updated to the paused state', updates().at(-1)?.status === 'paused');

push('play');
await flush();
check('a native "play" push reaches the app callback', received[1] === 'play');
check('...and the notification flips back to running', updates().at(-1)?.status === 'running');

const before = received.length;
onNativeMessage({ detail: { message: JSON.stringify({ channel: 'ble', type: 'action', detail: { action: 'pause' } }) } });
onNativeMessage({ detail: { message: 'not json' } });
push('stop');
await flush();
check('other channels, junk payloads and unknown actions never reach the app', received.length === before);

if (failures) {
  console.log(`\n${failures} background-bridge check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll background-bridge checks passed.');
