# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for Settings' always-visible Keyboard Shortcuts and the Supported target types
toggle tiles.

Not part of `npm test`; run it by hand against a running app:

    npm run dev                                  # or: npx vite preview
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/settings-toggle-tiles.py

Needs `pip install playwright` and a Chromium. Checks, at 390x844 and 320x640: Keyboard Shortcuts
is a plain section (not a <details>), its table is visible with no tap, and it is the same under
every rail category; the four target types are a 2x2 grid of tiles whose ids are unchanged;
tapping a tile's *body* (not its switch) toggles it; the choice is saved and survives a reload;
the tiles reach the app's real consumer (the saved profile's enabledTargetTypes); each tile is a
comfortable tap target; keyboard Space toggles a focused tile without also firing the global
Start/Stop shortcut; and the "on" look follows the state. Screenshots go to /tmp/st-*.png.
"""
import os, asyncio, sys
from playwright.async_api import async_playwright
BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
IDS = ['pref-target-power', 'pref-target-slope', 'pref-target-resistance', 'pref-target-heartRate']
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

async def goto_settings(pg, cat='general'):
    await pg.evaluate("document.querySelector('.tab-btn[data-tab=\"settings\"]').click()"); await pg.wait_for_timeout(500)
    await pg.evaluate(f"document.querySelector('.md-rail[data-rail-for=\"settings\"] .md-rail-item[data-cat=\"{cat}\"]').click()"); await pg.wait_for_timeout(500)

async def checked(pg):
    return await pg.evaluate("(ids) => ids.map(i => document.getElementById(i).checked)", IDS)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for width, height in [(390, 844), (320, 640)]:
            ctx = await b.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
            pg = await ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: m.type == "error" and 'Failed to load resource' not in m.text and errs.append("console: " + m.text))
            await pg.goto(BASE, wait_until="load"); await pg.wait_for_timeout(1500)
            await pg.evaluate("async () => { const { db } = await import('/src/storage/db.js'); await db.setPref('enabledTargetTypes', null); }")
            await pg.reload(wait_until="load"); await pg.wait_for_timeout(1800)
            tag = f'{width}px'

            # ---- Keyboard Shortcuts
            await goto_settings(pg, 'general')
            ks = await pg.evaluate("""() => { const s = document.getElementById('keyboard-shortcuts'); const t = s?.querySelector('.shortcuts-table'); const r = t?.getBoundingClientRect();
              return { exists: !!s, tag: s?.tagName, insideDetails: !!s?.closest('details'), hasSummary: !!s?.querySelector('summary'), chevron: !!s?.querySelector('.settings-details-chevron'),
                       rows: t?.querySelectorAll('tr').length, tableVisible: !!r && r.width > 0 && r.height > 0 } }""")
            check(f'{tag}: Keyboard Shortcuts is a plain section with no <details>, summary or chevron', ks['exists'] and ks['tag'] == 'SECTION' and not ks['insideDetails'] and not ks['hasSummary'] and not ks['chevron'], ks)
            check(f'{tag}: its table is visible without a tap, all 9 shortcuts', ks['tableVisible'] and ks['rows'] == 9, ks)
            for cat in ['profile', 'display']:
                await goto_settings(pg, cat)
                vis = await pg.evaluate("(() => { const r = document.querySelector('#keyboard-shortcuts .shortcuts-table').getBoundingClientRect(); return r.width > 0 && r.height > 0; })()")
                check(f'{tag}: Keyboard Shortcuts is still there under {cat}', vis)
            await goto_settings(pg, 'general')

            # ---- the tile grid
            g = await pg.evaluate("""(ids) => { const grid = document.querySelector('.settings-toggle-grid[aria-label="Supported target types"]'); const tiles = [...grid.querySelectorAll('.toggle-tile')];
              const rects = tiles.map(t => t.getBoundingClientRect());
              const cols = new Set(rects.map(r => Math.round(r.left))).size, rows = new Set(rects.map(r => Math.round(r.top))).size;
              return { n: tiles.length, cols, rows, ids: tiles.map(t => t.querySelector('input')?.id), names: tiles.map(t => t.querySelector('.toggle-tile-name').textContent),
                       minH: Math.min(...rects.map(r => r.height)), minW: Math.min(...rects.map(r => r.width)), group: grid.getAttribute('role'), label: grid.getAttribute('aria-label'),
                       oldList: !!document.querySelector('#pref-target-power')?.closest('.settings-trigger-list'),
                       overflow: grid.scrollWidth > grid.clientWidth + 1 } }""", IDS)
            check(f'{tag}: four tiles in a 2x2, in the old order, with the same input ids', g['n'] == 4 and g['cols'] == 2 and g['rows'] == 2 and g['ids'] == IDS and g['names'] == ['Power', 'Slope', 'Resistance', 'Heart Rate'], g)
            check(f'{tag}: grouped for assistive tech, no longer in the old row list, no sideways overflow', g['group'] == 'group' and g['label'] == 'Supported target types' and not g['oldList'] and not g['overflow'], g)
            check(f'{tag}: each tile is at least 44px tall and 100px wide', g['minH'] >= 44 and g['minW'] >= 100, f"{g['minH']:.0f} x {g['minW']:.0f}")
            if width == 390: await pg.screenshot(path='/tmp/st-general.png')

            check(f'{tag}: all four start on (default)', await checked(pg) == [True, True, True, True], await checked(pg))

            # ---- tapping the tile body toggles (not just the switch)
            tile = pg.locator('.toggle-tile', has_text='Slope')
            box = await tile.bounding_box()
            await pg.mouse.click(box['x'] + 12, box['y'] + 10)   # top-left: over the name, far from the switch
            await pg.wait_for_timeout(300)
            c = await checked(pg)
            check(f'{tag}: tapping the tile body (over the name) turns Slope off, the others stay', c == [True, False, True, True], c)
            on_look = await pg.evaluate("""() => [...document.querySelectorAll('.settings-toggle-grid[aria-label="Supported target types"] .toggle-tile')].map(t => getComputedStyle(t).borderTopColor)""")
            check(f'{tag}: the off tile has no accent edge, the on tiles do', on_look[1] != on_look[0] and on_look[0] == on_look[2] == on_look[3], on_look)
            await pg.locator('.toggle-tile', has_text='Resistance').locator('.switch').click(); await pg.wait_for_timeout(300)
            c = await checked(pg)
            check(f'{tag}: tapping the switch itself toggles too (and only once)', c == [True, False, False, True], c)
            if width == 390: await pg.screenshot(path='/tmp/st-general-two-off.png')

            # ---- saved, and reaches the app's real consumer
            await pg.wait_for_timeout(1200)
            saved = await pg.evaluate("async () => { const { db } = await import('/src/storage/db.js'); return await db.getPref('enabledTargetTypes'); }")
            check(f'{tag}: the choice is saved to the profile as exactly the two that are on', sorted(saved or []) == ['heartRate', 'power'], saved)
            await pg.reload(wait_until="load"); await pg.wait_for_timeout(2000)
            await goto_settings(pg, 'general')
            c = await checked(pg)
            check(f'{tag}: it survives a reload', c == [True, False, False, True], c)

            # ---- keyboard: Space on a focused tile toggles it and does NOT start a session
            await pg.evaluate("document.getElementById('pref-target-slope').focus()")
            tab_before = await pg.evaluate("document.querySelector('.tab-btn.active')?.dataset.tab")
            await pg.keyboard.press('Space'); await pg.wait_for_timeout(500)
            c = await checked(pg); tab_after = await pg.evaluate("document.querySelector('.tab-btn.active')?.dataset.tab")
            check(f'{tag}: Space on the focused Slope input toggles it and leaves the page alone', c == [True, True, False, True] and tab_before == tab_after == 'settings', f'{c} {tab_before}->{tab_after}')

            # ---- turning every one off is still survivable (existing floor: falls back to Power)
            for i in IDS:
                if await pg.evaluate("(i) => document.getElementById(i).checked", i):
                    await pg.locator(f'label.toggle-tile:has(#{i})').click()
            await pg.wait_for_timeout(1400)
            saved = await pg.evaluate("async () => { const { db } = await import('/src/storage/db.js'); return await db.getPref('enabledTargetTypes'); }")
            check(f'{tag}: all four off still saves a non-empty list (the existing Power floor)', bool(saved) and len(saved) >= 1, saved)

            check(f'{tag}: no page errors', not errs, errs[:3])
            await ctx.close()
        await b.close()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
