# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the live cardio chart's device row (ui/device-row.js + ui/device-row-logic.js,
wired in app.js): reconnect buttons over the chart's top-right corner.

Not part of `npm test`; run it by hand against a running DEV server (it uses the dev-only
window.__debug hooks, which a production build strips):

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/device-row.py

Needs `pip install playwright` and a Chromium. Fakes three connected sensors (heart-rate strap, SmO2,
core temp) in the app's own sensor map before a free-ride cardio session starts from the FAB menu, then
drops and restores them through the same _setDeviceStatus() every real connect/disconnect uses. Checks:

  - nothing shows while every device is connected, and nothing shows outside a session at all;
  - a dropped device gets a button, in a fixed order, and it goes when the device is back and returns
    on the next drop;
  - a device that was NOT connected at session start (core temp here, and the trainer) never gets a
    button, whatever its status does, even after it connects and drops mid-session;
  - the row sits over the chart's top-right corner, inside the panel, above the chart (a tap lands on
    the button), without moving the chart or the badge bar, and never scrolls the page sideways;
  - 'connecting' pulses and is not tappable; 'reconnecting' pulses and is; a tap runs the real connect
    handler (the Bluetooth chooser is stubbed to never answer, so the app stays 'connecting');
  - the X dismisses exactly the buttons showing, they stay dismissed when they flap, a device that was
    connected at that moment still gets its button if it drops later, and the X is a real button with a
    label;
  - the session ending clears everything, and the next session starts fresh from what is connected then.
Prints PASS/FAIL per check; screenshots go to /tmp/device-row-*.png.
"""
import os, asyncio, sys
from playwright.async_api import async_playwright
BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

# A chooser that never answers: a tap on a button starts a real connect, which then sits at 'connecting'.
STUB_BT = """(() => { const never = () => new Promise(() => {});
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: never, getDevices: async () => [], getAvailability: async () => true, addEventListener() {}, removeEventListener() {} } }); })();"""

FEED = """async (on) => {
  const { deviceManager } = await import('/src/ble/device-manager.js');
  clearInterval(window.__feed);
  if (!on) return;
  const cap = window.__debug.capabilities; cap.set('power', true); cap.set('heartRate', true); cap.set('cadence', true); cap.set('speed', true);
  let t = 0;
  window.__feed = setInterval(() => { t++;
    const d = { power: 180 + Math.round(60 * Math.sin(t / 6)) + (t % 7), heartRate: 120 + Math.min(40, t), cadence: 85 + (t % 5), speed: 28 + (t % 3) };
    deviceManager.update('fake', d); window.__debug.session()?.pushData?.(d); }, 250);
}"""

# Make a sensor "connected" the way the app records it, so startSession() really reads it: an entry in the
# app's sensor map AND a registered role (the app's own reconcile pass drops any sensor with no role, on the
# next capabilities change, exactly as it would a real one that vanished).
ROLE_OF = "{ hrm: 'heart_rate_monitor', smo2: 'smo2_monitor', coreTemp: 'core_temp_monitor' }"
CONNECT = """(kind) => { const m = window.__debug.auxSensors(); const inst = { id: 'fake-' + kind, disconnect() {} };
  const id = kind === 'hrm' ? 'hr-monitor' : 'fake-' + kind;
  m.set(id, { id, name: 'Test ' + kind, kind: kind === 'hrm' ? 'hr' : kind, instance: inst });
  window.__debug.roles.register(id, [""" + ROLE_OF + """[kind]]);
  window.__debug.setDeviceStatus(kind, 'connected'); }"""
DROP = """(kind) => { const m = window.__debug.auxSensors(); const id = kind === 'hrm' ? 'hr-monitor' : 'fake-' + kind;
  m.delete(id); window.__debug.roles.unregister(id);
  window.__debug.setDeviceStatus(kind, 'disconnected'); }"""
SHOWN = "() => window.__debug.deviceRow().shown.map(b => b.kind).join(',')"
DOM_KINDS = "() => [...document.querySelectorAll('.device-row-btn[data-device-row-kind]')].map(b => b.dataset.deviceRowKind).join(',')"

async def start_session(pg):
    await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.getElementById('fab-menu-cardio').click()"); await pg.wait_for_timeout(800)
    await pg.evaluate("document.getElementById('qs-finish').click()"); await pg.wait_for_timeout(1300)
    await pg.evaluate(FEED, True); await pg.wait_for_timeout(1500)

async def stop_session(pg):
    await pg.evaluate("document.getElementById('pause-btn').click()"); await pg.wait_for_timeout(500)
    await pg.evaluate("document.getElementById('stop-btn').click()"); await pg.wait_for_timeout(1800)
    await pg.evaluate(FEED, False)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for width, height in [(390, 844), (320, 640)]:
            ctx = await b.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
            await ctx.add_init_script(STUB_BT)
            pg = await ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: m.type == "error" and 'Failed to load resource' not in m.text and errs.append("console: " + m.text))
            tag = f'{width}px'
            await pg.goto(BASE, wait_until='load'); await pg.wait_for_timeout(1500)

            # ---- outside a session: devices come and go, the row never shows
            for k in ('hrm', 'smo2', 'coreTemp'): await pg.evaluate(CONNECT, k)
            for k in ('hrm', 'smo2', 'coreTemp'): await pg.evaluate(DROP, k)
            check(f'{tag}: outside a session, dropped devices show no buttons', await pg.evaluate(SHOWN) == '' and await pg.evaluate(DOM_KINDS) == '')
            for k in ('hrm', 'smo2', 'coreTemp'): await pg.evaluate(CONNECT, k)

            # ---- session starts with strap, SmO2 and core temp connected; the trainer is not
            await start_session(pg)
            check(f'{tag}: everything connected at the start -> no buttons', await pg.evaluate(SHOWN) == '' and await pg.evaluate(DOM_KINDS) == '')
            sw0 = await pg.evaluate("document.documentElement.scrollWidth")
            track0 = await pg.evaluate("(() => { const t = document.querySelector('#chart-container .chart-track').getBoundingClientRect(); const bb = document.querySelector('.chart-badge-bar')?.getBoundingClientRect(); return { top: t.top, h: t.height, bar: bb ? bb.bottom : null }; })()")

            # ---- a drop gives a button; coming back removes it; the next drop returns it
            await pg.evaluate(DROP, 'hrm'); await pg.wait_for_timeout(200)
            check(f'{tag}: the strap drops -> exactly its button appears', await pg.evaluate(DOM_KINDS) == 'hrm' and await pg.evaluate(SHOWN) == 'hrm', await pg.evaluate(DOM_KINDS))
            await pg.evaluate("window.__debug.setDeviceStatus('hrm', 'connecting')"); await pg.wait_for_timeout(150)
            st = await pg.evaluate("(() => { const b = document.querySelector('[data-device-row-kind=\"hrm\"]'); return { cls: b.className, dis: b.getAttribute('aria-disabled'), label: b.getAttribute('aria-label') }; })()")
            check(f'{tag}: connecting pulses and is not tappable', 'is-connecting' in st['cls'] and st['dis'] == 'true' and st['label'].startswith('Connecting'), st)
            await pg.evaluate("window.__debug.setDeviceStatus('hrm', 'reconnecting')"); await pg.wait_for_timeout(150)
            st = await pg.evaluate("(() => { const b = document.querySelector('[data-device-row-kind=\"hrm\"]'); return { cls: b.className, dis: b.getAttribute('aria-disabled'), label: b.getAttribute('aria-label') }; })()")
            check(f'{tag}: reconnecting pulses but stays tappable', 'is-reconnecting' in st['cls'] and st['dis'] is None, st)
            await pg.evaluate(CONNECT, 'hrm'); await pg.wait_for_timeout(200)
            check(f'{tag}: the strap is back -> its button goes', await pg.evaluate(DOM_KINDS) == '' and await pg.evaluate("document.querySelector('.device-row').classList.contains('hidden')"))
            await pg.evaluate(DROP, 'hrm'); await pg.wait_for_timeout(200)
            check(f'{tag}: it drops again -> the button is back', await pg.evaluate(DOM_KINDS) == 'hrm')

            # ---- order, and devices that were not there at the start never show
            await pg.evaluate(DROP, 'smo2'); await pg.wait_for_timeout(200)
            check(f'{tag}: two dropped devices -> two buttons in fixed order', await pg.evaluate(DOM_KINDS) == 'hrm,smo2', await pg.evaluate(DOM_KINDS))
            await pg.screenshot(path=f'/tmp/device-row-{width}-two.png')
            for status in ('disconnected', 'connecting', 'reconnecting'):
                await pg.evaluate(f"window.__debug.setDeviceStatus('controller', '{status}')")
            check(f'{tag}: the trainer was not connected at the start -> never a button', 'controller' not in (await pg.evaluate(DOM_KINDS)))
            await pg.evaluate("window.__debug.setDeviceStatus('controller', 'connected')"); await pg.evaluate("window.__debug.setDeviceStatus('controller', 'disconnected')")
            check(f'{tag}: ...not even after it connects and drops mid-session', 'controller' not in (await pg.evaluate(DOM_KINDS)))

            # ---- geometry: over the chart's top-right corner, above it, not moving anything
            geo = await pg.evaluate("""() => { const panel = document.getElementById('chart-container').getBoundingClientRect(); const row = document.querySelector('.device-row').getBoundingClientRect();
              const track = document.querySelector('#chart-container .chart-track').getBoundingClientRect(); const bar = document.querySelector('.chart-badge-bar')?.getBoundingClientRect();
              const btns = [...document.querySelectorAll('.device-row-btn')]; const hit = btns.map(b => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b || b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
              return { inPanel: row.left >= panel.left && row.right <= panel.right && row.top >= panel.top, rightGap: panel.right - row.right, onTrack: row.top >= track.top - 1 && row.top < track.top + 60,
                       belowBar: bar ? row.top >= bar.bottom - 1 : true, rightHalf: row.left > panel.left + panel.width / 2 - 1 || row.width > panel.width / 2, hit, trackTop: track.top, trackH: track.height, sw: document.documentElement.scrollWidth, vw: innerWidth,
                       size: btns.map(b => Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height)) } }""")
            check(f'{tag}: the row is inside the chart panel, in its top-right corner, over the chart (below the badge bar)', geo['inPanel'] and geo['onTrack'] and geo['belowBar'] and 0 <= geo['rightGap'] <= 24, geo)
            check(f'{tag}: a tap on each button lands on that button (nothing covers it)', all(geo['hit']), geo['hit'])
            check(f'{tag}: buttons are at least 40x40', all(int(s.split('x')[0]) >= 40 and int(s.split('x')[1]) >= 40 for s in geo['size']), geo['size'])
            check(f'{tag}: showing the row does not move the chart or the badge bar', abs(geo['trackTop'] - track0['top']) < 0.5 and abs(geo['trackH'] - track0['h']) < 0.5, (track0, geo['trackTop'], geo['trackH']))
            check(f'{tag}: the page never scrolls sideways', geo['sw'] <= geo['vw'] and geo['sw'] == sw0, (sw0, geo['sw'], geo['vw']))

            # ---- X: dismisses the showing buttons only
            x = pg.locator('.device-row-close')
            check(f'{tag}: the X is a labelled button on the row', await x.count() == 1 and bool(await x.get_attribute('aria-label')))
            await x.click(); await pg.wait_for_timeout(200)
            check(f'{tag}: X closes the row (the two showing buttons are dismissed)', await pg.evaluate(DOM_KINDS) == '' and await pg.evaluate("document.querySelector('.device-row').classList.contains('hidden')"))
            await pg.evaluate("window.__debug.setDeviceStatus('hrm', 'reconnecting')"); await pg.evaluate(DROP, 'smo2')
            check(f'{tag}: dismissed devices stay dismissed when they flap', await pg.evaluate(DOM_KINDS) == '')
            await pg.evaluate(CONNECT, 'hrm'); await pg.evaluate(DROP, 'hrm')
            check(f'{tag}: ...even after one reconnects and drops again', await pg.evaluate(DOM_KINDS) == '')
            await pg.evaluate(DROP, 'coreTemp'); await pg.wait_for_timeout(200)
            check(f'{tag}: a device that was connected when X was pressed still gets its button if it drops', await pg.evaluate(DOM_KINDS) == 'coreTemp', await pg.evaluate(DOM_KINDS))
            if width == 390: await pg.screenshot(path='/tmp/device-row-390-core.png')

            # ---- a tap runs the real connect handler (chooser stubbed to never answer -> 'connecting')
            await pg.evaluate(CONNECT, 'coreTemp'); await pg.evaluate(DROP, 'coreTemp'); await pg.wait_for_timeout(150)
            await pg.locator('[data-device-row-kind="coreTemp"]').click(); await pg.wait_for_timeout(500)
            st = await pg.evaluate("(() => { const b = document.querySelector('[data-device-row-kind=\"coreTemp\"]'); return b ? { cls: b.className, dis: b.getAttribute('aria-disabled') } : null; })()")
            check(f'{tag}: tapping a button starts a real connect (it goes to connecting and stops being tappable)', st and 'is-connecting' in st['cls'] and st['dis'] == 'true', st)

            # ---- the session ends: everything is forgotten
            await stop_session(pg)
            check(f'{tag}: the session ends -> the row is gone and nothing is offered', await pg.evaluate(SHOWN) == '' and await pg.evaluate(DOM_KINDS) == '')
            await pg.evaluate("window.__debug.setDeviceStatus('hrm', 'disconnected')")
            check(f'{tag}: after the session, drops show nothing', await pg.evaluate(DOM_KINDS) == '')

            # ---- next session starts fresh from what is connected THEN (strap only), dismissal forgotten
            for k in ('hrm', 'smo2', 'coreTemp'): await pg.evaluate(DROP, k)
            await pg.evaluate(CONNECT, 'hrm')
            await start_session(pg)
            await pg.evaluate(DROP, 'hrm'); await pg.evaluate(DROP, 'smo2'); await pg.evaluate(DROP, 'coreTemp'); await pg.wait_for_timeout(200)
            check(f'{tag}: a new session offers only what was connected at its start (the strap), with no old dismissals', await pg.evaluate(DOM_KINDS) == 'hrm', await pg.evaluate(DOM_KINDS))

            check(f'{tag}: no page errors', not errs, errs[:3])
            await ctx.close()
        await b.close()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
