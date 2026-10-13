// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/ble/__reconnect_smoketest__.js
//
// Covers ble/reconnect.js against a fake Bluetooth transport: the pre-existing start() (launch-time
// watches — checked here because it was refactored onto a shared helper) and the additions for HR
// strap auto-reconnect, watch()/unwatch()/isWatching() (re-arming ONE device after a mid-session
// drop). No real Bluetooth: devices are EventTargets with a scripted watchAdvertisements().

// ── fakes, installed before reconnect.js (and the transport it imports) load ──────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

class FakeDevice extends EventTarget {
  constructor(id, name = id) {
    super();
    this.id = id; this.name = name;
    this.watchCalls = 0;
    this.lastSignal = null;
    this.watchError = null;
  }
  async watchAdvertisements({ signal } = {}) {
    this.watchCalls++;
    this.lastSignal = signal;
    if (this.watchError) throw this.watchError;
  }
  advertise() { this.dispatchEvent(new Event('advertisementreceived')); }
}

let granted = [];
let getDevicesImpl = async () => granted;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { bluetooth: { requestDevice: async () => null, getDevices: () => getDevicesImpl() } },
});

const { reconnect } = await import('./reconnect.js');

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}
const tick = () => new Promise(r => setTimeout(r, 0));

function reset() {
  reconnect.stop();
  for (const m of reconnect.remembered()) { reconnect.forget(m.id); }
  for (const id of ['strap', 'strap2', 'bike', 'ghost']) { reconnect.resume(id); }
  store.clear();
  granted = [];
  getDevicesImpl = async () => granted;
}

console.log('support');
check('the fake transport is picked up', reconnect.isSupported() === true);

console.log('\nwatch(): re-arming one device');
{
  reset();
  const strap = new FakeDevice('strap', 'Polar H10');
  granted = [strap];
  reconnect.remember(strap, 'hr');
  const found = [];
  const armed = await reconnect.watch('strap', d => found.push(d));
  check('a remembered, granted strap arms a watch', armed === true && strap.watchCalls === 1 && reconnect.isWatching('strap'));
  check('the watch carries an abort signal', strap.lastSignal instanceof AbortSignal && !strap.lastSignal.aborted);
  strap.advertise(); await tick();
  check('an advertisement calls onFound once, with the device', found.length === 1 && found[0] === strap);
  check('...and disarms the watch (it fires once, not on every advert)', !reconnect.isWatching('strap') && strap.lastSignal.aborted);
  strap.advertise(); await tick();
  check('a later advertisement does not call onFound again', found.length === 1);
}

{
  reset();
  const strap = new FakeDevice('strap');
  granted = [strap];
  check('a device that was never remembered is not watched', (await reconnect.watch('strap', () => {})) === false && strap.watchCalls === 0);
}

{
  reset();
  const strap = new FakeDevice('strap');
  reconnect.remember(strap, 'hr');
  granted = [];
  check('remembered but not handed back by the transport -> false', (await reconnect.watch('strap', () => {})) === false);
  check('an unknown id -> false', (await reconnect.watch('ghost', () => {})) === false);
}

{
  reset();
  const strap = new FakeDevice('strap');
  granted = [strap];
  reconnect.remember(strap, 'hr');
  reconnect.pause('strap');
  check('a paused strap (rider disconnected it on purpose) is not watched', (await reconnect.watch('strap', () => {})) === false && strap.watchCalls === 0);
  reconnect.resume('strap');
  check('resume() lets it be watched again', (await reconnect.watch('strap', () => {})) === true);
  reconnect.pause('strap');
  check('pausing an open watch cancels it', !reconnect.isWatching('strap') && strap.lastSignal.aborted);
}

{
  reset();
  const strap = new FakeDevice('strap');
  granted = [strap];
  reconnect.remember(strap, 'hr');
  getDevicesImpl = async () => { await tick(); reconnect.pause('strap'); return granted; };
  check('paused while getDevices() was in flight -> not armed', (await reconnect.watch('strap', () => {})) === false && strap.watchCalls === 0);
}

{
  reset();
  const strap = new FakeDevice('strap');
  granted = [strap];
  reconnect.remember(strap, 'hr');
  getDevicesImpl = async () => { throw new Error('boom'); };
  const origWarn = console.warn; console.warn = () => {};
  const r = await reconnect.watch('strap', () => {});
  console.warn = origWarn;
  check('getDevices() rejecting -> false, no throw', r === false);
}

{
  reset();
  const strap = new FakeDevice('strap');
  granted = [strap];
  reconnect.remember(strap, 'hr');
  strap.watchError = Object.assign(new Error('already connected'), { name: 'InvalidStateError' });
  const origWarn = console.warn; console.warn = () => {};
  const r = await reconnect.watch('strap', () => {});
  console.warn = origWarn;
  check('watchAdvertisements() throwing -> false and nothing left marked as watching', r === false && !reconnect.isWatching('strap'));
}

{
  reset();
  const strap = new FakeDevice('strap');
  granted = [strap];
  reconnect.remember(strap, 'hr');
  const calls = [];
  await reconnect.watch('strap', () => calls.push('first'));
  const firstSignal = strap.lastSignal;
  await reconnect.watch('strap', () => calls.push('second'));
  check('watching twice replaces the first watch (old one aborted)', firstSignal.aborted && !strap.lastSignal.aborted && reconnect.isWatching('strap'));
  strap.advertise(); await tick();
  check('...so one advertisement calls only the newer callback, once', calls.join() === 'second');
}

console.log('\nunwatch()');
{
  reset();
  const strap = new FakeDevice('strap');
  granted = [strap];
  reconnect.remember(strap, 'hr');
  const calls = [];
  await reconnect.watch('strap', () => calls.push('x'));
  reconnect.unwatch('strap');
  check('unwatch() stops the watch', !reconnect.isWatching('strap') && strap.lastSignal.aborted);
  strap.advertise(); await tick();
  check('...and an advertisement afterwards calls nothing', calls.length === 0);
  check('...without forgetting the device', reconnect.remembered().some(m => m.id === 'strap'));
  check('...or pausing it (it can be watched again)', !reconnect.isPaused('strap') && (await reconnect.watch('strap', () => {})) === true);
  reconnect.unwatch('ghost');
  check('unwatching something never watched is a no-op', true);
}

console.log('\nstart(): launch-time watches (refactored onto the shared helper)');
{
  reset();
  const strap = new FakeDevice('strap'), bike = new FakeDevice('bike'), stranger = new FakeDevice('ghost'), muted = new FakeDevice('strap2');
  granted = [strap, bike, stranger, muted];
  reconnect.remember(strap, 'hr');
  reconnect.remember(bike, 'trainer');
  reconnect.remember(muted, 'hr');
  reconnect.pause('strap2');
  const found = [];
  await reconnect.start(d => found.push(d.id));
  check('arms every remembered, un-paused device', strap.watchCalls === 1 && bike.watchCalls === 1);
  check('skips a device that was never remembered', stranger.watchCalls === 0);
  check('skips a paused one', muted.watchCalls === 0);
  check('the HR strap is among the launch-time watches (kind hr is remembered now)', reconnect.isWatching('strap'));
  bike.advertise(); strap.advertise(); await tick();
  check('each device calls back once with its own handle', found.sort().join() === 'bike,strap');
  check('both watches disarm after their advertisement', !reconnect.isWatching('bike') && !reconnect.isWatching('strap'));
}

{
  reset();
  const strap = new FakeDevice('strap');
  granted = [strap];
  reconnect.remember(strap, 'hr');
  await reconnect.start(() => {});
  reconnect.stop();
  check('stop() cancels every open watch', !reconnect.isWatching('strap') && strap.lastSignal.aborted);
}

console.log('\nthe remembered kind');
{
  reset();
  reconnect.remember(new FakeDevice('strap', 'Polar H10'), 'hr');
  const meta = reconnect.remembered().find(m => m.id === 'strap');
  check("an HR strap is remembered with kind 'hr', for app.js's dispatcher", meta?.kind === 'hr' && meta.name === 'Polar H10');
  reconnect.forget('strap');
  check('forget() removes it', !reconnect.remembered().some(m => m.id === 'strap'));
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll reconnect checks passed.');
