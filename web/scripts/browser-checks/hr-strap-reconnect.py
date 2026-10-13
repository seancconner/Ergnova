# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for heart-rate strap auto-reconnect, end to end through the real app
(ble/reconnect.js watch()/unwatch(), ble/hr-device.js connectDevice(), app.js connectHrMonitor() /
_resetHrmState() / disconnectAuxSensor(), and the live strength screen's HR slot).

Not part of `npm test`; run by hand against a running app:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/hr-strap-reconnect.py

Needs `pip install playwright` and a Chromium. There is no Bluetooth in headless Chromium, so an init
script installs a fake navigator.bluetooth with one heart-rate strap. Like the native bridge's
backend, the fake hands back the SAME device and characteristic objects on every connect, and counts
live listeners on them -- that is what catches listeners piling up across reconnects.

Scenarios (390x844, a live strength session open throughout):
  1. First connect by hand: the heart button opens the chooser; the strap is remembered as kind 'hr';
     readings show.
  2. Accidental drop: straight to 'reconnecting' (never a 'disconnected' frame), pulsing, a watch is
     armed, the strip is gone. The strap advertises -> 'connecting' -> 'connected' with NO chooser, and
     exactly one live listener per event remains (no pile-up).
  3. Dropped again, then the rider taps the pulsing button: the watch is cancelled and the chooser
     opens (a tap is not swallowed while waiting).
  4. Deliberate disconnect (trainer menu): plain 'disconnected', never 'reconnecting', no watch, and an
     advertisement from the strap does nothing. Connecting by hand afterwards lifts that again.
  5. A failed automatic attempt retries and recovers; four failures in a row give the slot back as a
     plain, tappable Connect button.
  6. A fresh launch with a remembered strap in range connects on its own, before any session opens.

Prints PASS/FAIL per check; screenshots go to /tmp/hrr-*.png.
"""
import os, asyncio, sys, json
from playwright.async_api import async_playwright
BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

FAKE_BLE = r"""
(() => {
  const F = window.__fake = {
    chooserOpens: 0, failConnects: 0, connectAttempts: 0, watching: false, watchArms: 0,
    autoAdvertise: localStorage.getItem('__fakeAuto') === '1',
    granted: localStorage.getItem('__fakeGranted') === '1',
    listeners: { dev: 0, char: 0 },
  };
  const counted = (target, key, type) => {
    const add = target.addEventListener.bind(target), rem = target.removeEventListener.bind(target);
    const live = new Map();   // listener -> true, per type we care about
    target.addEventListener = (t, fn, o) => { if (t === type && !live.has(fn)) { live.set(fn, 1); F.listeners[key] = live.size; } return add(t, fn, o); };
    target.removeEventListener = (t, fn, o) => { if (t === type && live.delete(fn)) F.listeners[key] = live.size; return rem(t, fn, o); };
  };
  class FakeChar extends EventTarget { async startNotifications() {} }
  class FakeService { constructor(c) { this.c = c; } async getCharacteristic() { return this.c; } }
  const char = new FakeChar();
  counted(char, 'char', 'characteristicvaluechanged');
  const dev = new EventTarget();
  dev.id = 'AA:BB:CC:11'; dev.name = 'Fake HR Strap';
  counted(dev, 'dev', 'gattserverdisconnected');
  dev.gatt = {
    connected: false,
    async connect() {
      F.connectAttempts++;
      if (F.failConnects > 0) { F.failConnects--; throw new Error('GATT busy'); }
      this.connected = true; return this;
    },
    disconnect() { this.connected = false; },
    async getPrimaryService() { return new FakeService(char); },
  };
  dev.watchAdvertisements = async ({ signal } = {}) => {
    F.watching = true; F.watchArms++;
    signal?.addEventListener('abort', () => { F.watching = false; });
    if (F.autoAdvertise) setTimeout(() => { if (F.watching) dev.dispatchEvent(new Event('advertisementreceived')); }, 150);
  };
  F.emit = (bpm) => { const dv = new DataView(new ArrayBuffer(2)); dv.setUint8(0, 0); dv.setUint8(1, bpm); char.value = dv; char.dispatchEvent(new Event('characteristicvaluechanged')); };
  F.drop = () => { dev.gatt.connected = false; dev.dispatchEvent(new Event('gattserverdisconnected')); };
  F.advertise = () => dev.dispatchEvent(new Event('advertisementreceived'));
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {
    requestDevice: async () => { F.chooserOpens++; F.granted = true; localStorage.setItem('__fakeGranted', '1'); return dev; },
    getDevices: async () => (F.granted ? [dev] : []),
  }});
})();
"""

SLOT = "document.querySelector('[data-hr-slot]')"
async def state(pg): return await pg.evaluate(f"{SLOT}?.dataset.state ?? null")
async def start_session(pg):
    await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.getElementById('fab-menu-strength').click()"); await pg.wait_for_timeout(700)
    await pg.evaluate("document.querySelector('.detail-sheet [data-style=\"weights\"]').click()"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.getElementById('ss-sequence-trigger').click(); document.querySelector('.detail-sheet .sf-sequence-panel .sf-sequence-card').click()"); await pg.wait_for_timeout(400)
    await pg.evaluate("document.getElementById('ss-finish').click()"); await pg.wait_for_timeout(1200)
async def record_states(pg):
    # One observer at a time: a second call must replace the first, or every state is logged once per call.
    await pg.evaluate(f"""() => {{ window.__states = []; window.__obs?.disconnect(); const s = {SLOT};
        window.__obs = new MutationObserver(() => window.__states.push(s.dataset.state));
        window.__obs.observe(s, {{ attributes: true, attributeFilter: ['data-state'] }}); }}""")
async def states(pg): return await pg.evaluate("window.__states")
async def view(pg):
    return await pg.evaluate(f"""() => {{
        const slot = {SLOT}, btn = slot.querySelector('[data-hr-connect]'), strip = slot.querySelector('[data-hr-strip]');
        const vis = e => getComputedStyle(e).display !== 'none';
        return {{ state: slot.dataset.state, btn: vis(btn), strip: vis(strip), label: btn.textContent.trim(),
                  aria: btn.getAttribute('aria-disabled'), anim: getComputedStyle(btn).animationName,
                  pe: getComputedStyle(btn).pointerEvents, value: slot.querySelector('[data-hr-value]').textContent,
                  watching: window.__fake.watching, chooser: window.__fake.chooserOpens, lis: window.__fake.listeners }};
    }}""")
def meta_js(): return "JSON.parse(localStorage.getItem('ergnova_paired_devices') || '{}')"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        await ctx.add_init_script(FAKE_BLE)
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and 'Failed to load resource' not in m.text and errs.append("console: " + m.text))
        pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(BASE, wait_until="load"); await pg.wait_for_timeout(1500)
        await start_session(pg)

        # ── 1. first connect by hand ──
        v = await view(pg)
        check('1: before any strap: plain Connect button, nothing watching', v['state'] == 'disconnected' and v['btn'] and not v['strip'] and not v['watching'], v)
        await pg.evaluate("document.querySelector('[data-hr-connect]').click()"); await pg.wait_for_timeout(800)
        v = await view(pg)
        check('1: the heart button opened the chooser and the strip is showing', v['chooser'] == 1 and v['state'] == 'connected' and v['strip'] and not v['btn'], v)
        meta = await pg.evaluate(meta_js())
        check("1: the strap was remembered as kind 'hr'", any(m.get('kind') == 'hr' for m in meta.values()), meta)
        await pg.wait_for_timeout(2700)  # past the 2.5s reconnect cushion, which drops readings straight after a connect
        await pg.evaluate("window.__fake.emit(132)"); await pg.wait_for_timeout(1600)
        check('1: a reading shows', (await view(pg))['value'] == '132')
        check('1: one live listener per event on the (reused) device objects', v['lis'] == {'dev': 1, 'char': 1}, v['lis'])

        # ── 2. accidental drop -> reconnecting -> automatic reconnect ──
        await record_states(pg)
        await pg.evaluate("window.__fake.drop()"); await pg.wait_for_timeout(500)
        v = await view(pg); seq = await states(pg)
        check('2: a drop goes straight to reconnecting, never through a disconnected frame', seq == ['reconnecting'], seq)
        check('2: reconnecting: pulsing button, strip gone, stale number cleared', v['btn'] and not v['strip'] and v['label'] == 'Reconnecting…' and v['anim'] == 'hr-slot-pulse' and v['value'] == '—', v)
        check('2: reconnecting stays tappable (pointer events on, not aria-disabled)', v['pe'] != 'none' and v['aria'] == 'false', v)
        check('2: a watch for the strap is armed', v['watching'] is True, v)
        await pg.screenshot(path='/tmp/hrr-reconnecting.png')
        await record_states(pg)
        await pg.evaluate("window.__fake.advertise()"); await pg.wait_for_timeout(900)
        v = await view(pg); seq = await states(pg)
        check('2: the strap advertising reconnects it: connecting -> connected', seq == ['connecting', 'connected'], seq)
        check('2: ...with no chooser (still just the one from the first connect)', v['chooser'] == 1, v['chooser'])
        check('2: ...the strip is back and the watch is spent', v['strip'] and not v['btn'] and not v['watching'], v)
        await pg.wait_for_timeout(2700)  # past the 2.5s reconnect cushion, which drops readings straight after a connect
        await pg.evaluate("window.__fake.emit(141)"); await pg.wait_for_timeout(1600)
        check('2: readings flow again', (await view(pg))['value'] == '141')
        check('2: still exactly one live listener per event after a reconnect (no pile-up)', v['lis'] == {'dev': 1, 'char': 1}, v['lis'])

        # a second drop/return cycle, to be sure the first wasn't a one-off
        await pg.evaluate("window.__fake.drop()"); await pg.wait_for_timeout(400)
        await pg.evaluate("window.__fake.advertise()"); await pg.wait_for_timeout(900)
        v = await view(pg)
        check('2: a second drop recovers the same way, listeners still 1/1', v['state'] == 'connected' and v['lis'] == {'dev': 1, 'char': 1} and v['chooser'] == 1, v)

        # ── 3. a tap while reconnecting takes over ──
        await pg.evaluate("window.__fake.drop()"); await pg.wait_for_timeout(400)
        check('3: dropped again: reconnecting with a watch armed', (await view(pg))['state'] == 'reconnecting' and (await view(pg))['watching'])
        await pg.evaluate("document.querySelector('[data-hr-connect]').click()"); await pg.wait_for_timeout(900)
        v = await view(pg)
        check('3: a tap opened the chooser (it was not swallowed) and cancelled the watch', v['chooser'] == 2 and not v['watching'], v)
        check('3: ...and the rider ends up connected', v['state'] == 'connected' and v['strip'], v)

        # ── 4. deliberate disconnect ──
        await record_states(pg)
        await pg.evaluate("document.getElementById('trainer-menu-connect-hrm').click()"); await pg.wait_for_timeout(600)
        v = await view(pg); seq = await states(pg)
        check('4: a deliberate disconnect is a plain disconnected, never reconnecting', v['state'] == 'disconnected' and 'reconnecting' not in seq, seq)
        check('4: ...no watch, button still and tappable', not v['watching'] and v['anim'] == 'none' and v['aria'] == 'false', v)
        await pg.evaluate("window.__fake.advertise()"); await pg.wait_for_timeout(700)
        v = await view(pg)
        check('4: the strap advertising afterwards does NOT pull it back', v['state'] == 'disconnected' and v['chooser'] == 2, v)
        await pg.evaluate("document.querySelector('[data-hr-connect]').click()"); await pg.wait_for_timeout(800)
        check('4: connecting by hand afterwards works', (await view(pg))['state'] == 'connected' and (await view(pg))['chooser'] == 3)
        await pg.evaluate("window.__fake.drop()"); await pg.wait_for_timeout(400)
        check('4: ...and that lifts the pause: a later drop auto-reconnects again', (await view(pg))['state'] == 'reconnecting')
        await pg.evaluate("window.__fake.advertise()"); await pg.wait_for_timeout(800)
        check('4: ...and recovers', (await view(pg))['state'] == 'connected')

        # ── 5. failed automatic attempts ──
        await pg.evaluate("window.__fake.autoAdvertise = true; window.__fake.failConnects = 1")
        await record_states(pg)
        await pg.evaluate("window.__fake.drop()"); await pg.wait_for_timeout(4500)
        v = await view(pg); seq = await states(pg)
        check('5: one failed attempt retries and recovers on its own', v['state'] == 'connected' and seq[-1] == 'connected' and seq.count('connecting') == 2, seq)
        await pg.evaluate("window.__fake.failConnects = 99")
        await record_states(pg)
        await pg.evaluate("window.__fake.drop()"); await pg.wait_for_timeout(9000)
        v = await view(pg); seq = await states(pg)
        check('5: four failures in a row give the slot back as a plain Connect button', v['state'] == 'disconnected' and v['label'] == 'Connect' and not v['watching'] and v['anim'] == 'none', (v, seq))
        check('5: ...after trying exactly four times (the first plus three retries)', seq.count('connecting') == 4, seq)
        await pg.evaluate("window.__fake.failConnects = 0; window.__fake.autoAdvertise = false")
        await pg.evaluate("document.querySelector('[data-hr-connect]').click()"); await pg.wait_for_timeout(800)
        check('5: the rider can still connect by hand afterwards', (await view(pg))['state'] == 'connected')
        check('5: no stray listeners after all that churn', (await view(pg))['lis'] == {'dev': 1, 'char': 1}, (await view(pg))['lis'])
        check('5: no page errors so far', not errs, errs[:3])

        # ── 6. launch with a remembered strap in range ──
        await pg.evaluate("localStorage.setItem('__fakeAuto', '1'); localStorage.setItem('__fakeGranted', '1')")
        await pg.reload(wait_until="load"); await pg.wait_for_timeout(2200)
        pre = await pg.evaluate("({ chooser: window.__fake.chooserOpens, attempts: window.__fake.connectAttempts })")
        await start_session(pg)
        v = await view(pg)
        check('6: a fresh launch connects the remembered strap by itself, no chooser', pre['chooser'] == 0 and pre['attempts'] >= 1, pre)
        check('6: ...so a strength session opens with the strip already showing', v['state'] == 'connected' and v['strip'], v)
        await pg.screenshot(path='/tmp/hrr-launch.png')

        check('no page errors', not errs, errs[:3])
        await b.close()
    passed = sum(1 for _, ok, _ in results if ok)
    print(f'\n{passed}/{len(results)} checks passed')
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
