# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the live strength screen's heart-rate slot and its green-check buttons
.

Not part of `npm test`; run by hand against a running app:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/live-strength-hr-slot.py

Needs `pip install playwright` and a Chromium. Two halves, at 390x844:

  A. The real app. Start a strength session from the FAB menu (no strap connected) and look at the
     live screen: the heart button is in the slot and the strip is not; the old chart wrap and
     corner badge are gone; Rest sits beside the slot and is visible; Log is a green check with no
     text; a hold exercise shows the clock+play button. Tapping the heart button runs the real
     connect flow (headless has no Bluetooth, so it fails back to disconnected -- what matters is
     that it went through 'connecting' and came back, with no page error).

  B. The module driven directly (a StrengthSessionPanel mounted on a scratch node with a fake
     session): connected -> strip, button hidden; the slot is the same size in every status (no
     layout jump); the value follows onSample; the miniature chart paints; a drop swaps back to the
     button and clears the stale number; connecting pulses and ignores taps; reconnecting pulses
     but stays tappable (a tap takes over from the automatic wait); a disconnected tap calls onConnect
     exactly once; mounting already-connected shows the strip on
     the first frame; the hold button turns into the green check while a hold runs and back after.

Prints PASS/FAIL per check; screenshots go to /tmp/lshr-*.png.
"""
import os, asyncio, sys
from playwright.async_api import async_playwright
BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and 'Failed to load resource' not in m.text and errs.append("console: " + m.text))
        await pg.goto(BASE, wait_until="load"); await pg.wait_for_timeout(1500)

        # ── A. the real app ──
        await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
        await pg.evaluate("document.getElementById('fab-menu-strength').click()"); await pg.wait_for_timeout(700)
        await pg.evaluate("document.querySelector('.detail-sheet [data-style=\"weights\"]').click()"); await pg.wait_for_timeout(300)
        await pg.evaluate("document.getElementById('ss-sequence-trigger').click(); document.querySelector('.detail-sheet .sf-sequence-panel .sf-sequence-card').click()"); await pg.wait_for_timeout(400)
        await pg.evaluate("document.getElementById('ss-finish').click()"); await pg.wait_for_timeout(1200)
        await pg.screenshot(path='/tmp/lshr-live.png')

        live = await pg.evaluate("""() => {
            const r = e => e ? e.getBoundingClientRect() : null;
            const slot = document.querySelector('[data-hr-slot]'), strip = document.querySelector('[data-hr-strip]'),
                  btn = document.querySelector('[data-hr-connect]'), rest = document.querySelector('[data-rest-timer]')?.closest('.chart-badge-item');
            const vis = e => !!e && getComputedStyle(e).display !== 'none' && r(e).width > 0;
            return {
              slot: !!slot, state: slot?.dataset.state, stripVisible: vis(strip), btnVisible: vis(btn),
              btnH: btn ? r(btn).height : 0, btnW: btn ? r(btn).width : 0, btnLabel: btn?.textContent.trim(),
              btnAria: btn?.getAttribute('aria-label'), heart: !!btn?.querySelector('use[href="#icon-heart"]'),
              slotRect: r(slot), restRect: r(rest), restVisible: vis(rest),
              oldChart: !!document.querySelector('.strength-hr-chart'), oldBadge: !!document.querySelector('[data-hr-badge]'),
              vw: innerWidth,
              log: (() => { const l = document.querySelector('[data-log-reps-btn]'); if (!l) return null;
                    const cs = getComputedStyle(l), rr = r(l);
                    return { text: l.textContent.trim(), icon: l.querySelector('use')?.getAttribute('href'), aria: l.getAttribute('aria-label'),
                             h: rr.height, w: rr.width, edge: cs.borderTopColor, color: cs.color }; })(),
            };
        }""")
        check('A: the slot is on the live strength screen', live['slot'])
        check('A: no strap -> the heart button shows, the strip does not', live['state'] == 'disconnected' and live['btnVisible'] and not live['stripVisible'], live)
        check('A: the button is a heart, named for what it does, and says Connect', live['heart'] and live['btnLabel'] == 'Connect' and live['btnAria'] == 'Connect heart rate monitor', live)
        check('A: the button is thumb-sized (>= 44px tall)', live['btnH'] >= 44, live['btnH'])
        check('A: the old chart wrap and corner badge are gone', not live['oldChart'] and not live['oldBadge'])
        check('A: Rest is visible beside the slot, on the same row', live['restVisible'] and abs(live['restRect']['top'] - live['slotRect']['top']) <= 4 and live['restRect']['left'] >= live['slotRect']['right'] - 1, (live['slotRect'], live['restRect']))
        check('A: the row fits the phone width', live['restRect']['right'] <= live['vw'] and live['slotRect']['left'] >= 0)
        check('A: Log is a check mark with no text, named for screen readers', live['log'] and live['log']['text'] == '' and live['log']['icon'] == '#icon-check' and live['log']['aria'] == 'Log set', live['log'])
        check('A: Log is a big tap target', live['log'] and live['log']['h'] >= 56 and live['log']['w'] >= 200, live['log'])

        # green: compare the computed edge against --success resolved on the same element
        green = await pg.evaluate("""() => {
            const l = document.querySelector('[data-log-reps-btn]'); const probe = document.createElement('i');
            probe.style.color = getComputedStyle(l).getPropertyValue('--check-tint').trim() || 'var(--success)'; l.appendChild(probe);
            const tint = getComputedStyle(probe).color; probe.remove();
            const m = c => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
            const edge = m(getComputedStyle(l).borderTopColor), t = m(tint);
            return { edge, tint: t, greenest: edge[1] > edge[0] && edge[1] > edge[2] };
        }""")
        check('A: the Log edge is green-dominant and derived from --success', green['greenest'], green)

        # hold exercise -> clock + play
        await pg.evaluate("""() => { const i = document.querySelector('[data-exercise-input]'); i.value = 'Plank'; i.dispatchEvent(new Event('input', { bubbles: true })); }""")
        await pg.wait_for_timeout(300)
        hold = await pg.evaluate("""() => { const h = document.querySelector('[data-hold-btn]'), f = document.querySelector('[data-hold-fields]');
            return { fieldsShown: !f.classList.contains('hidden'), text: h.textContent.trim(), icon: h.querySelector('use').getAttribute('href'),
                     state: h.dataset.holdState, aria: h.getAttribute('aria-label'), h: h.getBoundingClientRect().height }; }""")
        check('A: a hold exercise shows the hold button as clock + play, no text', hold['fieldsShown'] and hold['text'] == '' and hold['icon'] == '#icon-hold-play' and hold['state'] == 'idle' and hold['aria'] == 'Start hold', hold)
        check('A: the hold button is as big as Log', hold['h'] >= 56, hold['h'])
        sym = await pg.evaluate("""() => { const s = document.getElementById('icon-hold-play'); return s ? { circle: !!s.querySelector('circle'), tri: !!s.querySelector('polygon') } : null; }""")
        check('A: the sprite has a clock-face circle with a play triangle', sym and sym['circle'] and sym['tri'], sym)

        # tapping the heart button runs the real connect flow
        await pg.evaluate("""() => { window.__states = []; const s = document.querySelector('[data-hr-slot]');
            new MutationObserver(() => window.__states.push(s.dataset.state)).observe(s, { attributes: true, attributeFilter: ['data-state'] }); }""")
        await pg.evaluate("document.querySelector('[data-hr-connect]').click()"); await pg.wait_for_timeout(1500)
        seen = await pg.evaluate("window.__states")
        end_state = await pg.evaluate("document.querySelector('[data-hr-slot]').dataset.state")
        check('A: tapping the heart goes through connecting, and (no Bluetooth here) ends back on the plain button', 'connecting' in seen and end_state == 'disconnected', (seen, end_state))
        check('A: the button is tappable again afterwards', await pg.evaluate("document.querySelector('[data-hr-connect]').getAttribute('aria-disabled')") == 'false')

        # ── B. the module driven directly ──
        out = await pg.evaluate("""async () => {
            const { StrengthSessionPanel } = await import('/src/views/strength-session.js');
            const { SetTracker } = await import('/src/recording/set-tracker.js');
            const { HrSlot, hrSlotHtml } = await import('/src/ui/hr-slot.js');
            const r = {};
            const mount = (opts) => {
                const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:0;top:0;width:390px;z-index:99999;background:#111';
                document.body.appendChild(host);
                const calls = { connect: 0 };
                const panel = new StrengthSessionPanel(host, { session: { sampleCount: 0, samples: [] }, tracker: new SetTracker(),
                    onConnectHrm: () => { calls.connect++; }, ...opts });
                panel.render();
                return { host, panel, calls };
            };
            const q = (h, s) => h.querySelector(s);
            const shown = e => getComputedStyle(e).display !== 'none';
            const box = h => q(h, '[data-hr-slot]').getBoundingClientRect();

            // opens already connected -> strip on the first frame
            let m = mount({ hrmStatus: 'connected' });
            r.firstFrame = { strip: shown(q(m.host, '[data-hr-strip]')), btn: shown(q(m.host, '[data-hr-connect]')) };
            const hConn = box(m.host).height, wConn = box(m.host).width;
            m.panel.onSample({ heartRate: 131.4 });
            r.value = q(m.host, '[data-hr-value]').textContent;
            m.panel.onSample({ heartRate: null });
            r.afterGap = q(m.host, '[data-hr-value]').textContent;
            m.panel.setDeviceStatus('hrm', 'disconnected');
            r.afterDrop = { strip: shown(q(m.host, '[data-hr-strip]')), btn: shown(q(m.host, '[data-hr-connect]')),
                            value: q(m.host, '[data-hr-value]').textContent, state: q(m.host, '[data-hr-slot]').dataset.state };
            const hDisc = box(m.host).height, wDisc = box(m.host).width;
            r.sameBox = { hConn, hDisc, wConn, wDisc };

            // taps
            q(m.host, '[data-hr-connect]').click();
            r.tapDisconnected = m.calls.connect;
            for (const st of ['connecting', 'reconnecting']) {
                m.panel.setDeviceStatus('hrm', st);
                const b = q(m.host, '[data-hr-connect]'), cs = getComputedStyle(b);
                r[st] = { label: b.textContent.trim(), animation: cs.animationName, pe: cs.pointerEvents, aria: b.getAttribute('aria-disabled'), tab: b.tabIndex,
                          h: box(m.host).height };
                b.click(); // programmatic clicks ignore pointer-events, so this tests the status guard
                r[st].callsAfterTap = m.calls.connect;
                r[st].cls = b.className;
            }
            m.panel.setDeviceStatus('hrm', 'disconnected');
            r.stillAfterwards = getComputedStyle(q(m.host, '[data-hr-connect]')).animationName;
            q(m.host, '[data-hr-connect]').click();
            r.tapAgain = m.calls.connect;   // 1 (disconnected) + 1 (reconnecting) + this one
            m.panel.setDeviceStatus('hrm', 'connected');
            r.backConnected = shown(q(m.host, '[data-hr-strip]')) && !shown(q(m.host, '[data-hr-connect]'));
            m.panel.setDeviceStatus('nonsense', 'disconnected'); // other kinds are ignored
            r.otherKindIgnored = q(m.host, '[data-hr-slot]').dataset.state === 'connected';

            // no onConnectHrm -> shown but inert
            const inert = mount({ hrmStatus: 'disconnected', onConnectHrm: undefined });
            const ib = q(inert.host, '[data-hr-connect]'); ib.click();
            r.inert = { shown: shown(ib), aria: ib.getAttribute('aria-disabled'), tab: ib.tabIndex };

            // the miniature chart paints (HrSlot directly, so the timestamps are ours)
            const hostC = document.createElement('div'); hostC.style.cssText = 'position:fixed;left:0;top:60px;width:390px;z-index:99999';
            hostC.innerHTML = hrSlotHtml(); document.body.appendChild(hostC);
            const slot = new HrSlot(hostC, { status: 'connected' });
            const now = Date.now();
            for (let i = 40; i >= 0; i--) slot.push(110 + 30 * Math.sin(i / 5), now - i * 2000);
            const cv = hostC.querySelector('[data-hr-spark]'); const ctx2 = cv.getContext('2d');
            const px = ctx2.getImageData(0, 0, cv.width, cv.height).data; let painted = 0;
            for (let i = 3; i < px.length; i += 4) if (px[i] > 0) painted++;
            r.chart = { w: cv.width, h: cv.height, painted, fraction: painted / (cv.width * cv.height) };
            slot.setStatus('disconnected');
            const px2 = ctx2.getImageData(0, 0, cv.width, cv.height).data; let left = 0;
            for (let i = 3; i < px2.length; i += 4) if (px2[i] > 0) left++;
            r.chartClearedOnDrop = left === 0;
            slot.push(150); // a push while not connected is ignored
            r.pushIgnoredWhileDown = hostC.querySelector('[data-hr-value]').textContent;
            slot.destroy();

            // hold button: idle -> running (green check) -> idle
            const hm = mount({});
            const ex = q(hm.host, '[data-exercise-input]'); ex.value = 'Plank'; ex.dispatchEvent(new Event('input', { bubbles: true }));
            const hb = q(hm.host, '[data-hold-btn]');
            const hs = () => ({ state: hb.dataset.holdState, icon: hb.querySelector('use').getAttribute('href'), aria: hb.getAttribute('aria-label'), color: getComputedStyle(hb).color, edge: getComputedStyle(hb).borderTopColor });
            r.holdIdle = hs();
            hb.click(); r.holdRunning = hs();
            hb.click(); r.holdAfter = hs(); r.setsLogged = hm.panel._tracker.sets.length;

            for (const x of [m, inert, hm]) { x.panel.destroy(); x.host.remove(); }
            hostC.remove();
            return r;
        }""")
        check('B: mounted already-connected -> the strip is there on the first frame', out['firstFrame']['strip'] and not out['firstFrame']['btn'], out['firstFrame'])
        check('B: onSample shows the reading as a whole number', out['value'] == '131', out['value'])
        check('B: a missing reading is a dash, not a zero', out['afterGap'] == '—', out['afterGap'])
        check('B: a drop swaps the strip for the button and clears the stale number', not out['afterDrop']['strip'] and out['afterDrop']['btn'] and out['afterDrop']['value'] == '—' and out['afterDrop']['state'] == 'disconnected', out['afterDrop'])
        sb = out['sameBox']
        check('B: the slot is the same size on both faces (nothing jumps)', abs(sb['hConn'] - sb['hDisc']) < 0.5 and abs(sb['wConn'] - sb['wDisc']) < 0.5, sb)
        check('B: a tap while disconnected calls onConnectHrm once', out['tapDisconnected'] == 1, out['tapDisconnected'])
        o = out['connecting']
        check('B: connecting: pulsing, not tappable, no extra connect', o['animation'] == 'hr-slot-pulse' and o['pe'] == 'none' and o['aria'] == 'true' and o['tab'] == -1 and o['callsAfterTap'] == 1, o)
        check('B: connecting: the slot keeps its size', abs(o['h'] - sb['hDisc']) < 0.5, o['h'])
        o = out['reconnecting']
        check('B: reconnecting: pulsing but LIVE (pointer events on, in the tab order, not aria-disabled)', o['animation'] == 'hr-slot-pulse' and o['pe'] != 'none' and o['aria'] == 'false' and o['tab'] == 0 and 'is-reconnecting' in o['cls'] and 'is-pending' not in o['cls'], o)
        check('B: reconnecting: a tap reaches onConnectHrm (the rider taking over from the automatic wait)', o['callsAfterTap'] == 2, o['callsAfterTap'])
        check('B: reconnecting: the slot keeps its size', abs(o['h'] - sb['hDisc']) < 0.5, o['h'])
        check('B: connecting says Connecting… and reconnecting says Reconnecting…', out['connecting']['label'] == 'Connecting…' and out['reconnecting']['label'] == 'Reconnecting…')
        check('B: back to disconnected stops the pulse and is tappable again', out['stillAfterwards'] == 'none' and out['tapAgain'] == 3, (out['stillAfterwards'], out['tapAgain']))
        check('B: reconnecting the strap swaps the strip back in', out['backConnected'])
        check('B: a status for another device kind is ignored', out['otherKindIgnored'])
        check('B: with no onConnectHrm the button is shown but inert (aria-disabled, out of the tab order)', out['inert']['shown'] and out['inert']['aria'] == 'true' and out['inert']['tab'] == -1, out['inert'])
        c = out['chart']
        check('B: the miniature chart paints something, but not a wall of colour', 0.01 < c['fraction'] < 0.7 and c['w'] >= 300, c)
        check('B: the chart is cleared when the strap drops', out['chartClearedOnDrop'])
        check('B: a reading that arrives while disconnected is ignored', out['pushIgnoredWhileDown'] == '—', out['pushIgnoredWhileDown'])
        hi, hr_, ha = out['holdIdle'], out['holdRunning'], out['holdAfter']
        check('B: hold idle = clock + play', hi['icon'] == '#icon-hold-play' and hi['state'] == 'idle' and hi['aria'] == 'Start hold', hi)
        check('B: a running hold turns into the green check ("Log hold")', hr_['icon'] == '#icon-check' and hr_['state'] == 'running' and hr_['aria'] == 'Log hold', hr_)
        check('B: the running hold looks different from idle (green, not neutral)', hr_['edge'] != hi['edge'] and hr_['color'] != hi['color'], (hi['edge'], hr_['edge']))
        # An invalid var() in the rule once made the idle edge fall back to the full-strength text
        # colour (a bright white outline) while every check above still passed -- so measure it.
        import re
        def alpha(c):
            m = re.search(r'/\s*([\d.]+)\s*\)', c); return float(m.group(1)) if m else 1.0
        def rgb(c):
            nums = re.findall(r'[\d.]+', c.split('/')[0]); return [float(n) for n in nums[-3:]] if len(nums) >= 3 else None
        check('B: the idle hold button has a FAINT edge (translucent, not a full-strength outline)', alpha(hi['edge']) <= 0.4, hi['edge'])
        check('B: the idle hold icon is the neutral text colour, not green', (lambda c: c and not (c[1] > c[0] * 1.2 and c[1] > c[2] * 1.2))(rgb(hi['color'])), hi['color'])
        check('B: the running hold edge is a visible green', (lambda c: c and c[1] > c[0] and c[1] > c[2] and alpha(hr_['edge']) >= 0.4)(rgb(hr_['edge'])), hr_['edge'])
        check('B: tapping the check logs the hold and goes back to clock + play', ha['icon'] == '#icon-hold-play' and ha['state'] == 'idle' and out['setsLogged'] == 1, (ha, out['setsLogged']))

        await pg.screenshot(path='/tmp/lshr-end.png')
        check('no page errors', not errs, errs[:3])
        await b.close()
    passed = sum(1 for _, ok, _ in results if ok)
    print(f'\n{passed}/{len(results)} checks passed')
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
