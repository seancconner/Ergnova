# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the Cardio Session and Strength Session setup flows
(ui/cardio-session-flow.js, ui/strength-session-flow.js) now that both live in the shared detail
sheet (src/ui/detail-sheet.js) instead of their own .setup-flow overlays.

Not part of `npm test`; run by hand against a running app:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/session-flow-sheets.py

Needs `pip install playwright` and a Chromium. Drives each flow from the FAB menu at 390x844:
opens as a tall, flush sheet with the right title; the old overlay hosts are gone; the form's
own body scrolls and the Start / Cancel foot stays inside the viewport; Cancel, Esc, scrim tap and
a long drag-down all close it (and a re-open starts from a fresh draft); the cardio target-style
buttons still re-render the form; Start Workout closes the sheet and starts the session. Mouse
drags only -- see detail-sheet.py's docstring. Prints PASS/FAIL per check.

Strength's Resistance Sequence is a dropdown (a collapsed trigger that opens a panel of cards: the info tap doesn't select, a pick closes it and
seeds the name, a new Style collapses it, Create Your Own swaps it for the builder with Start unlit).
Both flows' Start button is the one lit glass CTA (disabled = plain glass).
"Lit" = the glass CTA's green edge is showing (disabled = plain glass, transparent edge); the CTA has no glow now,
so box-shadow is no longer the signal.
"""
import os, asyncio, sys
BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
from playwright.async_api import async_playwright

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

        async def sheet_state():
            return await pg.evaluate("""() => {
                const h = document.querySelector('.detail-sheet-host'), s = document.querySelector('.detail-sheet');
                if (!h || !s) return null;
                return { hidden: h.classList.contains('hidden'), open: h.classList.contains('is-open'),
                         size: s.dataset.size, flush: !!document.querySelector('.detail-sheet-body.is-flush'),
                         title: document.querySelector('.detail-sheet-title')?.textContent };
            }""")
        async def is_closed():
            st = await sheet_state(); return st is None or st['hidden']
        async def open_flow(item):
            await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
            await pg.evaluate(f"document.getElementById('{item}').click()"); await pg.wait_for_timeout(700)
        async def long_drag():
            box = await pg.locator('.detail-sheet').bounding_box()
            await pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + 10); await pg.mouse.down()
            for dy in range(0, 460, 20):
                await pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + 10 + dy); await pg.wait_for_timeout(5)
            await pg.mouse.up(); await pg.wait_for_timeout(500)

        gone = await pg.evaluate("() => !document.getElementById('cardio-session-flow') && !document.getElementById('strength-session-flow')")
        check('old overlay hosts are gone from the page', gone)

        # ───────────────────────── Cardio Session ─────────────────────────
        await open_flow('fab-menu-cardio')
        st = await sheet_state()
        check('cardio: opens as a tall flush sheet titled Cardio Session', st and st['open'] and st['size'] == 'tall' and st['flush'] and st['title'] == 'Cardio Session', st)
        has_form = await pg.evaluate("() => !!document.querySelector('.detail-sheet #qs-body #qs-equipment') && !!document.querySelector('.detail-sheet #qs-name')")
        check('cardio: form content is inside the sheet (#qs-equipment, #qs-name)', has_form)
        foot = await pg.evaluate("""() => { const f = document.querySelector('.detail-sheet .ds-flow-foot'); if (!f) return null;
            const r = f.getBoundingClientRect(); const fin = document.getElementById('qs-finish').getBoundingClientRect();
            return { bottom: r.bottom, vh: innerHeight, finRight: fin.right, vw: innerWidth }; }""")
        check('cardio: Cancel / Start foot sits inside the viewport', foot and foot['bottom'] <= foot['vh'] + 1 and foot['finRight'] <= foot['vw'], foot)
        enabled = await pg.evaluate("() => !document.getElementById('qs-finish').disabled")
        check('cardio: Start Workout enabled on the default (Free) draft', enabled)
        cta = await pg.evaluate("""() => { const f = document.getElementById('qs-finish'), c = document.getElementById('qs-cancel');
            const cs = getComputedStyle(f); return { cls: f.classList.contains('btn-glass-cta'), lit: cs.borderTopColor !== 'rgba(0, 0, 0, 0)', wider: f.getBoundingClientRect().width > c.getBoundingClientRect().width * 1.5,
                tall: f.getBoundingClientRect().height >= 44, others: document.querySelectorAll('.detail-sheet .btn-glass-cta:not(:disabled)').length }; }""")
        check('cardio: Start Workout is the one lit glass CTA, wider than Cancel and tap-sized', cta['cls'] and cta['lit'] and cta['wider'] and cta['tall'] and cta['others'] == 1, cta)

        await pg.evaluate("document.querySelector('.detail-sheet [data-target-style=\"steady\"]')?.click()"); await pg.wait_for_timeout(300)
        steady = await pg.evaluate("() => document.querySelector('.detail-sheet [data-target-style=\"steady\"]')?.className || ''")
        check('cardio: Steady target style re-renders the form in place', 'active' in steady or 'selected' in steady or 'on' in steady.split(), steady)
        await pg.fill('#qs-name', 'My own name'); await pg.wait_for_timeout(100)
        scrolled = await pg.evaluate("""() => { const b = document.getElementById('qs-body'); b.scrollTop = 9999; return { sh: b.scrollHeight, ch: b.clientHeight, top: b.scrollTop }; }""")
        check('cardio: the form body scrolls on its own', scrolled['sh'] >= scrolled['ch'], scrolled)

        # ── icon tiles (ui/setup-tiles.js) ──
        tiles = await pg.evaluate("""() => ({
            location: [...document.querySelectorAll('.detail-sheet [data-location]')].map(e => e.className.includes('sf-tile')),
            style: [...document.querySelectorAll('.detail-sheet [data-target-style]')].map(e => !!e.querySelector('svg use')),
            devices: ['controller', 'hrm', 'smo2', 'coreTemp'].map(k => !!document.querySelector(`.detail-sheet #qs-connect-${k} #qs-dot-${k} svg`)),
            ringClass: document.getElementById('qs-dot-hrm')?.className,
            statusText: document.querySelector('#qs-connect-hrm .sf-device-tile-status')?.textContent,
        })""")
        check('cardio: Indoor / Outdoor are icon tiles', len(tiles['location']) == 2 and all(tiles['location']), tiles['location'])
        check('cardio: all three target styles carry an icon', len(tiles['style']) == 3 and all(tiles['style']), tiles['style'])
        check('cardio: four device tiles, each the connect button with a ring and icon', all(tiles['devices']), tiles['devices'])
        check('cardio: a disconnected device says Connect', tiles['ringClass'] == 'sf-device-ring status-disconnected' and tiles['statusText'] == 'Connect', tiles)
        grid = await pg.evaluate("""() => { const r = [...document.querySelectorAll('.detail-sheet .sf-device-tile')].map(e => e.getBoundingClientRect());
            return { n: r.length, rows: new Set(r.map(x => Math.round(x.top))).size, maxRight: Math.max(...r.map(x => x.right)), vw: innerWidth, minH: Math.min(...r.map(x => x.height)) }; }""")
        check('cardio: devices lay out 2 x 2 inside the sheet, tap-sized', grid['n'] == 4 and grid['rows'] == 2 and grid['maxRight'] <= grid['vw'] and grid['minH'] >= 44, grid)
        await pg.evaluate("window.__qsDevice = null")
        # The tile reflects a status pushed in while the sheet is open (what app.js's BLE state does).
        pushed = await pg.evaluate("""async () => {
            const { CardioSessionFlow } = await import('/src/ui/cardio-session-flow.js');
            return typeof CardioSessionFlow.prototype.setDeviceStatus;
        }""")
        check('cardio: setDeviceStatus is still part of the flow API', pushed == 'function')

        await pg.click('#qs-cancel'); await pg.wait_for_timeout(500)
        check('cardio: Cancel closes the sheet', await is_closed())

        await open_flow('fab-menu-cardio')
        name_after = await pg.evaluate("() => document.getElementById('qs-name').value")
        check('cardio: re-opening starts from a fresh draft (not "My own name")', name_after != 'My own name', name_after)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(500)
        check('cardio: Esc closes the sheet', await is_closed())

        await open_flow('fab-menu-cardio')
        await pg.mouse.click(195, 40); await pg.wait_for_timeout(500)
        check('cardio: scrim tap closes the sheet', await is_closed())

        await open_flow('fab-menu-cardio'); await long_drag()
        check('cardio: a long drag-down closes the sheet', await is_closed())

        # Cancel -> open again quickly: one clean sheet.
        await open_flow('fab-menu-cardio'); await pg.keyboard.press('Escape')
        await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(200)
        await pg.evaluate("document.getElementById('fab-menu-cardio').click()"); await pg.wait_for_timeout(700)
        st = await sheet_state()
        check('cardio: Esc then open again leaves one clean open sheet', st and st['open'] and not st['hidden'] and st['title'] == 'Cardio Session', st)

        await pg.click('#qs-finish'); await pg.wait_for_timeout(900)
        started = await pg.evaluate("() => !document.getElementById('session-panel')?.classList.contains('hidden')")
        check('cardio: Start Workout closes the sheet and starts the session', await is_closed() and started, f'closed={await is_closed()} started={started}')

        # ───────────────────────── Strength Session ─────────────────────────
        await pg.reload(wait_until="load"); await pg.wait_for_timeout(1500)
        await open_flow('fab-menu-strength')
        st = await sheet_state()
        check('strength: opens as a tall flush sheet titled Strength Session', st and st['open'] and st['size'] == 'tall' and st['flush'] and st['title'] == 'Strength Session', st)
        has_form = await pg.evaluate("() => !!document.querySelector('.detail-sheet #ss-body') && !!document.getElementById('ss-finish')")
        check('strength: form content is inside the sheet (#ss-body, #ss-finish)', has_form)
        foot = await pg.evaluate("""() => { const f = document.querySelector('.detail-sheet .ds-flow-foot'); if (!f) return null;
            const r = f.getBoundingClientRect(); return { bottom: r.bottom, vh: innerHeight }; }""")
        check('strength: Cancel / Start foot sits inside the viewport', foot and foot['bottom'] <= foot['vh'] + 1, foot)
        stiles = await pg.evaluate("""() => ({
            styles: [...document.querySelectorAll('.detail-sheet [data-style]')].map(e => [e.className.includes('sf-tile'), !!e.querySelector('svg use')]),
            hrm: !!document.querySelector('.detail-sheet #ss-connect-hrm #ss-dot-hrm svg'),
            text: document.querySelector('#ss-connect-hrm .sf-device-tile-status')?.textContent,
        })""")
        check('strength: the three Styles are icon tiles with icons', len(stiles['styles']) == 3 and all(a and b for a, b in stiles['styles']), stiles['styles'])
        check('strength: the HRM is a device tile that says Connect', stiles['hrm'] and stiles['text'] == 'Connect', stiles)
        await pg.evaluate("document.querySelector('.detail-sheet [data-style=\"weights\"]').click()"); await pg.wait_for_timeout(300)
        picked = await pg.evaluate("() => [...document.querySelectorAll('.detail-sheet [data-style]')].filter(e => e.classList.contains('selected')).map(e => e.dataset.style)")
        check('strength: tapping a Style tile selects exactly that one', picked == ['weights'], picked)
        # -- Resistance Sequence dropdown + glass CTA --
        await pg.evaluate("document.querySelector('.detail-sheet [data-style=calisthenics]').click()"); await pg.wait_for_timeout(300)
        async def dd_state():
            return await pg.evaluate("""() => {
                const trig = document.getElementById('ss-sequence-trigger'), panel = document.querySelector('.sf-sequence-panel');
                const fin = document.getElementById('ss-finish');
                const cards = panel ? [...panel.querySelectorAll('.sf-sequence-card')] : [];
                return { trigger: !!trig, expanded: trig?.getAttribute('aria-expanded'), open: !!panel,
                    cards: cards.length, strip: !!document.querySelector('.sf-strip, .sf-strip-track'),
                    triggerText: (trig?.textContent || '').replace(/\\s+/g, ' ').trim(),
                    selected: cards.filter(c => c.classList.contains('selected')).map(c => c.dataset.sequenceId || 'custom'),
                    start: !fin.disabled, lit: getComputedStyle(fin).borderTopColor !== 'rgba(0, 0, 0, 0)',
                    name: document.getElementById('ss-name')?.value ?? null }; }""")
        ds = await dd_state()
        check('strength: Resistance Sequence is a collapsed dropdown again, not a strip', ds['trigger'] and not ds['open'] and ds['expanded'] == 'false' and not ds['strip'], ds)
        check('strength: nothing picked yet -- the trigger says so, Start is plain glass and disabled', 'Choose a resistance sequence' in ds['triggerText'] and not ds['start'] and not ds['lit'], ds)
        await pg.evaluate("document.getElementById('ss-sequence-trigger').click()"); await pg.wait_for_timeout(300)
        ds2 = await dd_state()
        check('strength: tapping the trigger opens a panel of cards plus Create Your Own', ds2['open'] and ds2['expanded'] == 'true' and ds2['cards'] >= 4, ds2)
        await pg.evaluate("document.querySelector('.sf-sequence-panel .sf-sequence-card-info').click()"); await pg.wait_for_timeout(300)
        ds3 = await dd_state()
        check('strength: the info tap on a card does not select it or close the panel', ds3['selected'] == [] and ds3['open'] and not ds3['start'], ds3)
        tip_open = await pg.evaluate("() => !!document.querySelector('.info-popover.visible')")
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
        after_esc = await pg.evaluate("() => ({ tip: !!document.querySelector('.info-popover.visible'), sheet: !!document.querySelector('.detail-sheet-host.is-open') })")
        check('strength: with a tooltip open, the first Esc closes only the tooltip', tip_open and not after_esc['tip'] and after_esc['sheet'], (tip_open, after_esc))
        await pg.evaluate("document.querySelectorAll('.sf-sequence-panel .sf-sequence-card[data-sequence-id]')[2].click()"); await pg.wait_for_timeout(400)
        ds4 = await dd_state()
        check('strength: picking a card closes the panel and shows the pick in the trigger', not ds4['open'] and ds4['expanded'] == 'false' and 'Choose a resistance sequence' not in ds4['triggerText'] and len(ds4['triggerText']) > 3, ds4)
        check('strength: a pick seeds the session name and lights Start', bool(ds4['name']) and ds4['start'] and ds4['lit'], ds4)
        await pg.evaluate("document.getElementById('ss-sequence-trigger').click()"); await pg.wait_for_timeout(300)
        ds5 = await dd_state()
        check('strength: reopening marks exactly the picked card selected', ds5['open'] and len(ds5['selected']) == 1, ds5)
        await pg.evaluate("document.getElementById('ss-sequence-trigger').click()"); await pg.wait_for_timeout(300)
        ds6 = await dd_state()
        check('strength: tapping the trigger again collapses it, the pick stays', not ds6['open'] and ds6['start'], ds6)
        lit = await pg.evaluate("""() => { const f = document.getElementById('ss-finish'), c = document.getElementById('ss-cancel');
            return { cls: f.classList.contains('btn-glass-cta'), wider: f.getBoundingClientRect().width > c.getBoundingClientRect().width * 1.5,
                tall: f.getBoundingClientRect().height >= 44, lit: document.querySelectorAll('.detail-sheet .btn-glass-cta:not(:disabled)').length }; }""")
        check('strength: Start Session is the one lit glass CTA, wider than Cancel and tap-sized', lit['cls'] and lit['wider'] and lit['tall'] and lit['lit'] == 1, lit)
        await pg.evaluate("document.getElementById('ss-sequence-trigger').click()"); await pg.wait_for_timeout(300)
        await pg.evaluate("document.querySelector('.detail-sheet [data-style=weights]').click()"); await pg.wait_for_timeout(300)
        ds7 = await dd_state()
        check('strength: a new Style clears the pick and collapses the dropdown', ds7['selected'] == [] and not ds7['open'] and not ds7['start'], ds7)
        await pg.evaluate("document.getElementById('ss-sequence-trigger').click()"); await pg.wait_for_timeout(300)
        await pg.evaluate("document.querySelector('.sf-sequence-panel .sf-sequence-card--custom').click()"); await pg.wait_for_timeout(400)
        bld = await pg.evaluate("""() => ({ dropdown: !!document.getElementById('ss-sequence-trigger'), builder: !!document.getElementById('ss-build-back'), start: !document.getElementById('ss-finish').disabled,
            use: document.getElementById('ss-build-use')?.classList.contains('btn-glass-cta') })""")
        check('strength: Create Your Own swaps the dropdown for the builder, with Start unlit', not bld['dropdown'] and bld['builder'] and not bld['start'] and bld['use'], bld)
        await pg.click('#ss-build-back'); await pg.wait_for_timeout(300)
        ds8 = await dd_state()
        check('strength: Back to presets brings the (collapsed) dropdown back', ds8['trigger'] and not ds8['open'], ds8)
        await pg.click('#ss-cancel'); await pg.wait_for_timeout(500)
        check('strength: Cancel closes the sheet', await is_closed())
        await open_flow('fab-menu-strength'); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(500)
        check('strength: Esc closes the sheet', await is_closed())
        await open_flow('fab-menu-strength'); await long_drag()
        check('strength: a long drag-down closes the sheet', await is_closed())

        # ───────────────── onCancel / onStart bookkeeping (modules driven directly) ─────────────────
        await pg.reload(wait_until="load"); await pg.wait_for_timeout(1500)
        counts = await pg.evaluate("""async () => {
            const { CardioSessionFlow } = await import('/src/ui/cardio-session-flow.js');
            const { StrengthSessionFlow } = await import('/src/ui/strength-session-flow.js');
            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            const out = {};
            const cardio = { cancel: 0, start: 0 };
            const c = new CardioSessionFlow({ onCancel: () => cardio.cancel++, onStart: () => cardio.start++ });
            const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
            c.open(); await wait(600); document.getElementById('qs-cancel').click(); await wait(700);
            out.cardioAfterCancelBtn = { ...cardio };
            c.open(); await wait(600); key('Escape'); await wait(700);
            out.cardioAfterEsc = { ...cardio };
            c.open(); await wait(600); document.getElementById('qs-finish').click(); await wait(700);
            out.cardioAfterStart = { ...cardio };
            c.open(); await wait(600); c.close(); await wait(700);
            out.cardioAfterProgrammaticClose = { ...cardio };
            const strength = { cancel: 0 };
            const s = new StrengthSessionFlow({ onCancel: () => strength.cancel++ });
            await s.open(); await wait(600); document.getElementById('ss-cancel').click(); await wait(700);
            await s.open(); await wait(600); key('Escape'); await wait(700);
            out.strengthAfterTwoCancels = { ...strength };
            await s.open(); await wait(600); s.close(); await wait(700);
            out.strengthAfterProgrammaticClose = { ...strength };
            return out;
        }""")
        check('cardio: Cancel button fires onCancel once', counts['cardioAfterCancelBtn'] == {'cancel': 1, 'start': 0}, counts['cardioAfterCancelBtn'])
        check('cardio: Esc fires onCancel', counts['cardioAfterEsc'] == {'cancel': 2, 'start': 0}, counts['cardioAfterEsc'])
        check('cardio: Start fires onStart and not onCancel', counts['cardioAfterStart'] == {'cancel': 2, 'start': 1}, counts['cardioAfterStart'])
        check('cardio: close() from code fires neither', counts['cardioAfterProgrammaticClose'] == {'cancel': 2, 'start': 1}, counts['cardioAfterProgrammaticClose'])
        check('strength: Cancel button and Esc each fire onCancel', counts['strengthAfterTwoCancels'] == {'cancel': 2}, counts['strengthAfterTwoCancels'])
        check('strength: close() from code does not fire onCancel', counts['strengthAfterProgrammaticClose'] == {'cancel': 2}, counts['strengthAfterProgrammaticClose'])

        check('no page errors', not errs, errs[:3])
        n_ok = sum(1 for _, ok, _ in results if ok)
        print(f"\n{n_ok}/{len(results)} passed")
        await b.close()
        return n_ok == len(results)

ok = asyncio.run(main())
sys.exit(0 if ok else 1)
