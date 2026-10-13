// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// platform/background-session.js smoke test — drives the module against a
// fake window.__ergnovaNativeBackground bridge (no native shell, DOM, or
// timers involved) and checks the start/update/stop/throttle decisions.
// Run with: node src/platform/__background_session_smoketest__.js

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

// Deterministic clock: the module only ever reads Date.now().
let now = 1_000_000;
Date.now = () => now;
const tick = ms => { now += ms; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function makeBridge({ info, startResult, startDelayMs = 0 } = {}) {
  const calls = { getInfo: 0, ensurePermissions: 0, start: [], update: [], stop: 0, openSettings: 0 };
  let releaseStart = null;
  let actionHandler = null; // what the module registered for notification button taps
  const bridge = {
    setActionHandler: (fn) => { actionHandler = fn; },
    getInfo: async () => { calls.getInfo++; return info ?? { supported: true, platform: 'android', notificationsAllowed: true, running: false }; },
    ensurePermissions: async () => { calls.ensurePermissions++; return { supported: true, notificationsAllowed: true }; },
    start: async (snap) => {
      calls.start.push(snap);
      if (startDelayMs) await new Promise(resolve => { releaseStart = resolve; });
      return startResult ?? { supported: true, running: true, notificationsAllowed: true };
    },
    update: async (snap) => { calls.update.push(snap); },
    stop: async () => { calls.stop++; },
    openNotificationSettings: async () => { calls.openSettings++; },
  };
  return {
    bridge, calls,
    release: () => releaseStart?.(),
    // Stands in for the native shell pushing a notification button tap up to the page.
    fire: (action) => actionHandler?.(action),
  };
}

const snap = (over = {}) => ({ title: 'Free Ride', status: 'running', elapsedSec: 10, text: '200 W', expanded: '', ...over });

// Each scenario gets a fresh copy of the module (module-level state) via a cache-busting import.
let importCounter = 0;
async function freshModule(bridge) {
  globalThis.window = bridge ? { __ergnovaNativeBackground: bridge } : {};
  const mod = await import(`./background-session.js?run=${importCounter++}`);
  return mod.backgroundSession;
}

console.log('background-session.js');

// ── 1. No bridge (browser/PWA/desktop) ─────────────────────────────────
{
  const bg = await freshModule(null);
  await bg.init();
  check('no bridge: isSupported is false', bg.isSupported === false);
  bg.sync(snap());
  bg.sync(null);
  check('no bridge: sync() is a harmless no-op', bg.isKeepingAlive === false);
}

// ── 2. Bridge present but platform unsupported (iOS/desktop shells) ────
{
  const { bridge, calls } = makeBridge({ info: { supported: false, platform: 'ios', notificationsAllowed: true, running: false } });
  const bg = await freshModule(bridge);
  await bg.init();
  check('unsupported platform: isSupported is false', bg.isSupported === false);
  bg.sync(snap());
  await flush();
  check('unsupported platform: never starts the native service', calls.start.length === 0);
}

// ── 3. Happy path: start once, throttle updates, stop on session end ───
{
  const { bridge, calls } = makeBridge();
  const bg = await freshModule(bridge);
  await bg.init();
  check('supported android bridge: isSupported is true', bg.isSupported === true);

  bg.sync(snap());
  await flush();
  check('first sync with a session starts the service exactly once', calls.start.length === 1);
  check('start carries the snapshot', calls.start[0].title === 'Free Ride' && calls.start[0].status === 'running');
  check('isKeepingAlive is true once the native side confirms', bg.isKeepingAlive === true);

  bg.sync(snap({ text: '210 W' }));
  await flush();
  check('metric change inside the throttle window is held back', calls.update.length === 0);

  tick(1000);
  bg.sync(snap({ text: '215 W', elapsedSec: 12 }));
  await flush();
  check('metric change after the throttle window is sent', calls.update.length === 1 && calls.update[0].text === '215 W');

  tick(1000);
  bg.sync(snap({ text: '215 W', elapsedSec: 13 }));
  await flush();
  check('unchanged content is not re-sent just because time passed', calls.update.length === 1);

  bg.sync(snap({ status: 'paused', text: 'Paused at 0:13' }));
  await flush();
  check('a status change (pause) is sent immediately, ignoring the throttle', calls.update.length === 2 && calls.update[1].status === 'paused');

  bg.sync(null);
  await flush();
  check('sync(null) stops the service', calls.stop === 1 && bg.isKeepingAlive === false);

  bg.sync(null);
  await flush();
  check('repeated sync(null) does not stop twice', calls.stop === 1);
}

// ── 4. Setting off / on mid-session ────────────────────────────────────
{
  const { bridge, calls } = makeBridge();
  const bg = await freshModule(bridge);
  await bg.init();
  bg.sync(snap());
  await flush();
  check('setup: service running', bg.isKeepingAlive === true && calls.start.length === 1);

  bg.setEnabled(false);
  await flush();
  check('setEnabled(false) mid-session stops the service', calls.stop === 1 && bg.isKeepingAlive === false);

  tick(1000);
  bg.sync(snap({ text: '220 W' }));
  await flush();
  check('while disabled, further syncs never restart it', calls.start.length === 1);

  bg.setEnabled(true);
  await flush();
  check('setEnabled(true) mid-session starts it again right away', calls.start.length === 2 && bg.isKeepingAlive === true);
}

// ── 5. Session ends while Start is still in flight ─────────────────────
{
  const { bridge, calls, release } = makeBridge({ startDelayMs: 1 });
  const bg = await freshModule(bridge);
  await bg.init();
  bg.sync(snap());
  await flush();
  bg.sync(null); // rider stopped before the service finished coming up
  await flush();
  check('stop is deferred while Start is pending', calls.stop === 0);
  release();
  await flush();
  await flush();
  check('once Start resolves, the pending stop goes through', calls.stop === 1 && bg.isKeepingAlive === false);
}

// ── 6. Start failure: reported once, not retried at 1 Hz ───────────────
{
  const { bridge, calls } = makeBridge({ startResult: { supported: true, running: false, error: 'boom' } });
  const bg = await freshModule(bridge);
  const problems = [];
  const kinds = [];
  bg.onProblem((msg, kind) => { problems.push(msg); kinds.push(kind); });
  await bg.init();

  bg.sync(snap());
  await flush();
  check('failed start leaves isKeepingAlive false', bg.isKeepingAlive === false);
  check('failed start reports one problem message mentioning the error', problems.length === 1 && problems[0].includes('boom'));
  check('failed start is reported with kind "start"', kinds[0] === 'start');

  for (let i = 0; i < 5; i++) { tick(1000); bg.sync(snap({ elapsedSec: 11 + i })); await flush(); }
  check('no retry storm inside the backoff window', calls.start.length === 1);
  check('the same problem is not re-announced every second', problems.length === 1);

  tick(31_000);
  bg.sync(snap({ elapsedSec: 60 }));
  await flush();
  check('after the backoff window it tries again', calls.start.length === 2);
}

// ── 7. Notifications blocked: still runs, but says so once ─────────────
{
  const { bridge } = makeBridge({ startResult: { supported: true, running: true, notificationsAllowed: false } });
  const bg = await freshModule(bridge);
  const problems = [];
  const kinds = [];
  bg.onProblem((msg, kind) => { problems.push(msg); kinds.push(kind); });
  await bg.init();
  bg.sync(snap());
  await flush();
  check('blocked notifications: service still counts as keeping the app alive', bg.isKeepingAlive === true);
  check('blocked notifications: rider is told once', problems.length === 1 && /blocked/i.test(problems[0]));
  check('blocked notifications: reported with kind "notifications"', kinds[0] === 'notifications');
  check('notificationsAllowed getter reflects the native answer', bg.notificationsAllowed === false);
}

// ── 8. Permission + settings passthrough ───────────────────────────────
{
  const { bridge, calls } = makeBridge();
  const bg = await freshModule(bridge);
  await bg.init();
  await bg.requestPermissions();
  bg.openNotificationSettings();
  await flush();
  check('requestPermissions() reaches the bridge', calls.ensurePermissions === 1);
  check('openNotificationSettings() reaches the bridge', calls.openSettings === 1);
}

// ── 9. Native service outlived the page (reload / renderer crash) ──────
{
  const { bridge, calls } = makeBridge({ info: { supported: true, platform: 'android', notificationsAllowed: true, running: true } });
  const bg = await freshModule(bridge);
  await bg.init();
  await flush();
  check('orphaned service with no session in progress is stopped on init', calls.stop === 1 && bg.isKeepingAlive === false);
}

// ── 10. ...and a session already in progress adopts it instead ─────────
{
  const { bridge, calls } = makeBridge({ info: { supported: true, platform: 'android', notificationsAllowed: true, running: true } });
  const bg = await freshModule(bridge);
  const ready = bg.init();
  bg.sync(snap()); // session state arrives while getInfo() is still in flight
  await ready;
  await flush();
  check('existing service is adopted, not started a second time', calls.start.length === 0 && bg.isKeepingAlive === true);
  check('adopted service is fed the current snapshot', calls.update.length === 1 && calls.update[0].title === 'Free Ride');
  check('adopted service is not stopped', calls.stop === 0);
}

// ── 11. Notification Pause / Play taps reach the app ───────────────────
{
  const { bridge, calls, fire } = makeBridge();
  const bg = await freshModule(bridge);
  const actions = [];
  bg.onAction(a => actions.push(a)); // the app just observes here — it does NOT change state
  await bg.init();
  bg.sync(snap());
  await flush();
  check('setup: service running, no updates sent yet', bg.isKeepingAlive === true && calls.update.length === 0);

  fire('pause');
  fire('play');
  check('pause and play taps are delivered to the app callback', actions.join() === 'pause,play');

  fire('stop');
  fire(undefined);
  check('anything but pause/play is ignored', actions.length === 2);

  await flush();
  check('taps that changed nothing still re-send the notification, one update per tap (it re-asserts the truth)',
    calls.update.length === 2 && calls.update.every(u => u.status === 'running'));
}

// ── 12. ...and when the app reacts, exactly one update goes out ────────
{
  const { bridge, calls, fire } = makeBridge();
  const bg = await freshModule(bridge);
  bg.onAction(a => { if (a === 'pause') bg.sync(snap({ status: 'paused', text: 'Paused' })); });
  await bg.init();
  bg.sync(snap());
  await flush();

  fire('pause');
  await flush();
  check('the app pausing in response produces a single paused update, not two', calls.update.length === 1 && calls.update[0].status === 'paused');
}

// ── 13. A throwing app callback can't break the module ─────────────────
{
  const { bridge, calls, fire } = makeBridge();
  const bg = await freshModule(bridge);
  bg.onAction(() => { throw new Error('boom'); });
  await bg.init();
  bg.sync(snap());
  await flush();
  let threw = false;
  try { fire('pause'); } catch { threw = true; }
  await flush();
  check('an exception in the action callback is contained', threw === false);
  check('the notification is still re-synced after a failed callback', calls.update.length === 1);
}

// ── 14. onAction() with no bridge at all is harmless ───────────────────
{
  const bg = await freshModule(null);
  let threw = false;
  try { bg.onAction(() => {}); await bg.init(); } catch { threw = true; }
  check('no bridge: onAction()/init() do not throw', threw === false);
}

if (failures) {
  console.log(`\n${failures} background-session check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll background-session checks passed.');
