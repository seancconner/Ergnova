# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the shared detail sheet (src/ui/detail-sheet.js) as History uses it.

Not part of `npm test` (the smoketests are node-only); run it by hand against a running app:

    npm run dev                                  # or: npx vite preview
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/detail-sheet.py

Needs `pip install playwright` and a Chromium (`playwright install chromium`). It seeds four
rides into the app's own IndexedDB, then drives the sheet through: open, layering over the tab
bar and rail, focus trap, Esc / scrim / drag-to-dismiss, the Download menu's Esc order, Delete,
rail and tab changes closing it, rapid re-open, and reduced motion. Prints PASS/FAIL per check.
Mouse drags only: touch drags and flicks were checked separately over CDP (see the checklist).
"""
import os
BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
import asyncio, json, sys
from playwright.async_api import async_playwright

SEED = """
async () => {
  const { db } = await import('/src/storage/db.js');
  const now = Date.now(), day = 86400000;
  const mk = (d, name, base, withLaps) => {
    const t0 = now - d*day, n = 180;
    const samples = Array.from({length: n}, (_, i) => ({ timestamp: t0 + i*1000*10, elapsedTime: i*10, power: Math.round(base + 60*Math.sin(i/12)), heartRate: 118 + Math.round(30*Math.sin(i/30)) + (i>>3), cadence: 84 + (i%7), speed: 27 + Math.sin(i/9)*3, distance: i*70 }));
    return { startTime: t0, duration: n*10, workoutName: name, samples, laps: withLaps ? [{ lapNumber: 1, sampleIndex: 60, timestamp: t0 + 600000 }, { lapNumber: 2, sampleIndex: 120, timestamp: t0 + 1200000 }] : [], summary: { avgPower: base, avgHr: 142, totalDistance: 12600, totalCalories: 640, normalizedPower: base+9 }, meta: {} };
  };
  await db.addSessions([ mk(0.2,'Sweet Spot 2x20',212,true), mk(1.3,'Free Ride',184,false), mk(2.4,'Z2 Endurance',150,false), mk(8,'Hill Repeats',230,false) ]);
}
"""
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ')+name+(f'  [{detail}]' if detail else ''))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width":390,"height":844}, device_scale_factor=2, has_touch=False)
        pg = await ctx.new_page()
        errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type=="error" and 'Failed to load resource' not in m.text and errs.append("console: "+m.text))
        dialogs=[]
        async def on_dialog(d): dialogs.append(d.message); await d.accept()
        pg.on("dialog", lambda d: asyncio.ensure_future(on_dialog(d)))
        await pg.goto(BASE, wait_until="load"); await pg.wait_for_timeout(1500)
        await pg.evaluate(SEED); await pg.reload(wait_until="load"); await pg.wait_for_timeout(2500)
        await pg.evaluate("document.querySelector('[data-tab=\"history\"]').click()"); await pg.wait_for_timeout(800)
        tiles = await pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster').count()
        check('seeded tiles visible', tiles == 4, tiles)

        # 1 open
        first = pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster').first
        await first.click(); await pg.wait_for_timeout(700)
        st = await pg.evaluate("""() => { const h=document.querySelector('.detail-sheet-host'), s=document.querySelector('.detail-sheet'); const r=s.getBoundingClientRect(); return {hidden:h.classList.contains('hidden'), open:h.classList.contains('is-open'), size:s.dataset.size, title:document.querySelector('.detail-sheet-title').textContent, sub:document.querySelector('.detail-sheet-subtitle').textContent, top:Math.round(r.top), bottom:Math.round(r.bottom), left:Math.round(r.left), right:Math.round(r.right), w:Math.round(r.width), vh:innerHeight, active: document.activeElement.className}; }""")
        check('sheet opens', not st['hidden'] and st['open'], st)
        check('title + date shown', st['title']=='Sweet Spot 2x20' and len(st['sub'])>5, st['title']+' | '+st['sub'])
        check('sheet sits at the bottom, inside the viewport', st['bottom']<=st['vh']+1 and st['top']>=0 and st['w']==390, f"top {st['top']} bottom {st['bottom']} of {st['vh']}")
        check('focus moved into the sheet', 'detail-sheet' in st['active'], st['active'])
        await pg.screenshot(path="/tmp/sheet-open.png")

        # chart is the hero
        ch = await pg.evaluate("""() => { const c=document.querySelector('.history-detail-chart'); const r=c.getBoundingClientRect(); const cv=c.querySelector('canvas'); return {h:Math.round(r.height), w:Math.round(r.width), canvas: !!cv, cw: cv?cv.width:0, chh: cv?cv.height:0}; }""")
        check('chart has a real box + canvas', ch['h']>=240 and ch['w']>300 and ch['canvas'] and ch['cw']>0, ch)
        sm = await pg.evaluate("""() => { const g=document.querySelector('.detail-summary'); const cs=getComputedStyle(g); const chips=[...g.querySelectorAll('.stat-chip')]; const tops=[...new Set(chips.map(c=>Math.round(c.getBoundingClientRect().top)))]; return {n:chips.length, rows:tops.length, cols:cs.gridTemplateColumns, laps: !!document.querySelector('.detail-laps table')}; }""")
        check('8 stat tiles in two rows', sm['n']==8 and sm['rows']==2, sm)
        check('laps table present for the session with laps', sm['laps'])

        # layering: tab bar & rail are covered by the scrim, sheet above both
        lay = await pg.evaluate("""() => { const inHost = (x,y) => { const e=document.elementFromPoint(x,y); return !!e?.closest('.detail-sheet-host'); }; const tb=document.querySelector('.tab-bar').getBoundingClientRect(); const rail=document.querySelector('.md-rail:not(.hidden)').getBoundingClientRect(); return { tabbar: inHost(tb.left+tb.width/2, tb.top+tb.height/2), rail: inHost(rail.left+rail.width/2, rail.top+rail.height/2) }; }""")
        check('sheet+scrim cover the tab bar', lay['tabbar'], lay)
        check('sheet+scrim cover the rail', lay['rail'], lay)

        # focus trap
        outside = 0
        for i in range(24):
            await pg.keyboard.press('Tab')
            inside = await pg.evaluate("!!document.activeElement.closest('.detail-sheet-host')")
            if not inside: outside += 1
        check('Tab x24 never leaves the sheet', outside==0, outside)
        outside = 0
        for i in range(12):
            await pg.keyboard.press('Shift+Tab')
            inside = await pg.evaluate("!!document.activeElement.closest('.detail-sheet-host')")
            if not inside: outside += 1
        check('Shift+Tab x12 never leaves the sheet', outside==0, outside)

        # Esc closes + focus returns
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(700)
        st = await pg.evaluate("({hidden: document.querySelector('.detail-sheet-host').classList.contains('hidden'), body: document.querySelector('.detail-sheet-body').innerHTML.length, active: document.activeElement.className})")
        check('Esc closes the sheet and empties it', st['hidden'] and st['body']==0, st)
        check('focus returns to the tile', 'history-poster' in st['active'], st['active'])

        # keyboard open
        await pg.keyboard.press('Enter'); await pg.wait_for_timeout(600)
        check('Enter on the focused tile opens it', await pg.evaluate("document.querySelector('.detail-sheet-host').classList.contains('is-open')"))
        # scrim tap
        await pg.mouse.click(195, 40); await pg.wait_for_timeout(700)
        check('scrim tap closes', await pg.evaluate("document.querySelector('.detail-sheet-host').classList.contains('hidden')"))

        # drag: small drag springs back, big drag dismisses
        await pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster').nth(1).click(); await pg.wait_for_timeout(700)
        gy = await pg.evaluate("(() => { const r=document.querySelector('.detail-sheet-grabber').getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]; })()")
        await pg.mouse.move(gy[0], gy[1]); await pg.mouse.down()
        for k in range(1,5): await pg.mouse.move(gy[0], gy[1]+k*10, steps=2)
        mid = await pg.evaluate("document.querySelector('.detail-sheet').style.transform")
        await pg.mouse.up(); await pg.wait_for_timeout(600)
        st = await pg.evaluate("({open: document.querySelector('.detail-sheet-host').classList.contains('is-open'), tf: document.querySelector('.detail-sheet').style.transform, top: Math.round(document.querySelector('.detail-sheet').getBoundingClientRect().top)})")
        check('drag follows the finger (transform applied mid-drag)', 'translateY' in mid, mid)
        check('a 40px drag springs back, sheet stays open', st['open'] and st['tf']=='', st)
        await pg.mouse.move(gy[0], gy[1]); await pg.mouse.down()
        for k in range(1,12): await pg.mouse.move(gy[0], gy[1]+k*30, steps=3)
        await pg.mouse.up(); await pg.wait_for_timeout(800)
        check('a long drag dismisses', await pg.evaluate("document.querySelector('.detail-sheet-host').classList.contains('hidden')"))

        # Download menu above the sheet; Esc order
        await pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster').nth(1).click(); await pg.wait_for_timeout(700)
        await pg.click('.detail-sheet-action[data-action="download"]'); await pg.wait_for_timeout(400)
        mn = await pg.evaluate("""() => { const m=document.querySelector('.format-menu'); if(!m) return null; const r=m.getBoundingClientRect(); const e=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return {above: !!e?.closest('.format-menu'), z: getComputedStyle(m).zIndex, w: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom)}; }""")
        check('Download menu opens and is on top of the sheet', mn and mn['above'], mn)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(500)
        st = await pg.evaluate("({menu: !!document.querySelector('.format-menu'), open: document.querySelector('.detail-sheet-host').classList.contains('is-open')})")
        check('first Esc closes the menu, sheet stays', (not st['menu']) and st['open'], st)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(700)
        check('second Esc closes the sheet', await pg.evaluate("document.querySelector('.detail-sheet-host').classList.contains('hidden')"))

        # Delete flow
        before = await pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster').count()
        await pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster').nth(2).click(); await pg.wait_for_timeout(700)
        await pg.click('.detail-sheet-action[data-action="delete"]'); await pg.wait_for_timeout(1200)
        after = await pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster').count()
        hidden = await pg.evaluate("document.querySelector('.detail-sheet-host').classList.contains('hidden')")
        check('Delete: confirm shown, sheet closes, one tile fewer', dialogs and hidden and after==before-1, f"dialogs={dialogs} {before}->{after}")

        # category change + tab switch close it
        await pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster').first.click(); await pg.wait_for_timeout(600)
        await pg.evaluate("document.querySelector('.md-rail[data-rail-for=\"history\"] .md-rail-item[data-cat=\"ride\"]').click()"); await pg.wait_for_timeout(700)
        check('rail category change closes the sheet', await pg.evaluate("document.querySelector('.detail-sheet-host').classList.contains('hidden')"))
        await pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster').first.click(); await pg.wait_for_timeout(600)
        await pg.evaluate("document.querySelector('[data-tab=\"overview\"]').click()"); await pg.wait_for_timeout(700)
        check('tab switch closes the sheet', await pg.evaluate("document.querySelector('.detail-sheet-host').classList.contains('hidden')"))
        await pg.evaluate("document.querySelector('[data-tab=\"history\"]').click()"); await pg.wait_for_timeout(500)

        # rapid open/close/open
        t = pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster')
        await t.first.click(); await pg.keyboard.press('Escape'); await t.nth(1).click(); await pg.wait_for_timeout(900)
        st = await pg.evaluate("({open: document.querySelector('.detail-sheet-host').classList.contains('is-open'), hidden: document.querySelector('.detail-sheet-host').classList.contains('hidden'), title: document.querySelector('.detail-sheet-title').textContent})")
        check('open → Esc → open again quickly leaves a clean open sheet', st['open'] and not st['hidden'] and st['title'], st)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(700)

        # reduced motion
        await pg.emulate_media(reduced_motion='reduce')
        await t.first.click(); await pg.wait_for_timeout(300)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(120)
        check('reduced motion: closes immediately', await pg.evaluate("document.querySelector('.detail-sheet-host').classList.contains('hidden')"))
        await pg.emulate_media(reduced_motion='no-preference')

        check('no page errors', not errs, errs[:4])
        await b.close()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results)-len(bad)}/{len(results)} passed")
asyncio.run(main())
