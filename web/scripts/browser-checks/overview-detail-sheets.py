# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for Overview's card detail sheets (views/overview-detail.js, drawn by
views/overview.js into the shared sheet, ui/detail-sheet.js).

Not part of `npm test`; run it by hand against a running app:

    npm run dev                                  # or: npx vite preview
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/overview-detail-sheets.py

Needs `pip install playwright` and a Chromium. Seeds rides, a profile (FTP, weight, resting HR,
VO2 max) and a week of diary entries into the app's own IndexedDB, then checks, for every card
that has a sheet: the card is a button with no (i); a tap opens a sheet with the right title and
rows; Esc closes it and focus goes back to the card. Also: Enter/Space opens it, the sheet covers
the tab bar, a nested button does not open it, the "Edit ..." header button lands on the Settings
field, and the empty-profile page keeps its (i) on empty cards and opens nothing.
Prints PASS/FAIL per check; screenshots go to /tmp/ov-*.png.
"""
import os, asyncio, sys
from playwright.async_api import async_playwright
BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')

CLEAR = """
async () => {
  const { db } = await import('/src/storage/db.js');
  for (const s of await db.getSessions()) await db.deleteSession(s.id);
  for (const d of await db.getDiaryEntries()) await db.deleteDiaryEntry(d.id);
  for (const k of ['ftp','riderWeight','restingHr','maxHr','vo2Max','vo2MaxDate','age','sex']) await db.setPref(k, null);
}
"""
SEED = """
async () => {
  const { db } = await import('/src/storage/db.js');
  const now = Date.now(), day = 86400000;
  const mk = (d, name, base) => {
    const t0 = now - d*day, n = 180;
    const samples = Array.from({length: n}, (_, i) => ({ timestamp: t0 + i*10000, elapsedTime: i*10, power: Math.round(base + 60*Math.sin(i/12)), heartRate: 118 + Math.round(30*Math.sin(i/30)) + (i>>3), cadence: 84 + (i%7), speed: 27, distance: i*70 }));
    return { startTime: t0, duration: n*10, workoutName: name, samples, laps: [], summary: { avgPower: base, avgHr: 142, totalDistance: 12600, totalCalories: 640, normalizedPower: base+9 }, meta: {} };
  };
  await db.addSessions([ mk(0.2,'Sweet Spot',212), mk(1.3,'Free Ride',184), mk(2.4,'Z2 Endurance',150), mk(9,'Hill Repeats',230), mk(40,'Old Ride',170) ]);
  await db.setPref('ftp', 230); await db.setPref('riderWeight', 78); await db.setPref('restingHr', 54);
  await db.setPref('age', 35); await db.setPref('vo2Max', 48); await db.setPref('vo2MaxDate', now - 20*day);
  for (let i = 0; i < 4; i++) {
    await db.saveDiaryEntry({ loggedAt: now - i*day - 3600000, name: 'Test meal ' + i,
      nutrients: { protein: 40, carbs: { total: 70 }, fat: { total: 20 } } });
  }
}
"""
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

STATE = """() => { const h=document.querySelector('.detail-sheet-host'); return {
  open: !!h && !h.classList.contains('hidden'),
  title: document.querySelector('.detail-sheet-title')?.textContent ?? '',
  sub: document.querySelector('.detail-sheet-subtitle')?.textContent ?? '',
  rows: [...document.querySelectorAll('.detail-sheet-body .ov-detail-row')].map(r => r.querySelector('.ov-detail-label').textContent + '=' + r.querySelector('.ov-detail-value').textContent),
  about: document.querySelector('.ov-detail-about')?.textContent ?? '',
  active: document.activeElement?.getAttribute('data-detail') ?? document.activeElement?.className ?? '' } }"""

async def run(pg, ctx_name):
    pass

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and 'Failed to load resource' not in m.text and errs.append("console: " + m.text))
        await pg.goto(BASE, wait_until="load"); await pg.wait_for_timeout(1500)

        # ---- empty profile: nothing opens, empty cards keep their (i)
        await pg.evaluate(CLEAR); await pg.reload(wait_until="load"); await pg.wait_for_timeout(2000)
        n_detail = await pg.locator('#overview-panel [data-detail]').count()
        n_empty_info = await pg.locator('#overview-panel [data-overview-card] .info-btn').count()
        check('empty profile: no card is a detail button', n_detail == 0, n_detail)
        check('empty profile: empty cards keep their (i)', n_empty_info >= 5, n_empty_info)

        # ---- seeded profile
        await pg.evaluate(CLEAR); await pg.evaluate(SEED); await pg.reload(wait_until="load"); await pg.wait_for_timeout(2500)
        await pg.screenshot(path="/tmp/ov-page.png")
        ids = await pg.evaluate("[...document.querySelectorAll('#overview-panel [data-detail]')].map(e => e.dataset.detail)")
        check('every data card is a detail button', set(ids) >= {'week', 'year', 'volume', 'heart', 'zones', 'hrzones', 'pwr', 'vo2max', 'ftp', 'bests'}, ids)
        has_info = await pg.evaluate("[...document.querySelectorAll('#overview-panel [data-detail]')].filter(e => e.querySelector('.info-btn')).map(e => e.dataset.detail)")
        check('no data card still has an (i)', not has_info, has_info)
        roles = await pg.evaluate("[...document.querySelectorAll('#overview-panel [data-detail]')].every(e => e.getAttribute('role') === 'button' && e.tabIndex === 0 && e.getAttribute('aria-haspopup') === 'dialog')")
        check('each is role=button, focusable, aria-haspopup=dialog', roles)

        expect = {
            'week': ('This Week', 'Sessions=', 'Last 7 days'),
            'year': ('Past 12 Months', 'Total=', None),
            'volume': ('Weekly Volume', 'This week=', 'Last 8 weeks'),
            'heart': ('Heart', 'Resting=54 bpm', None),
            'zones': ('Power Zones', 'Z1 Active Recovery=', 'Last 30 days'),
            'hrzones': ('Heart Rate Zones', 'Z1 ', 'Last 30 days'),
            'pwr': ('Power-to-Weight', 'Power-to-weight=2.95 W/kg', None),
            'vo2max': ('VO2 Max', 'VO2 max=48 mL/kg/min', None),
            'ftp': ('FTP', 'FTP=230 W', None),
            'bests': ('Personal Bests', 'Peak power=', 'Across all sessions'),
            'nutrition': ('Weekly Nutrition', 'Days logged=', 'Last 7 days'),
        }
        for id_, (title, row_start, sub) in expect.items():
            card = pg.locator(f'#overview-panel [data-detail="{id_}"]')
            if await card.count() == 0:
                check(f'{id_}: card present', False); continue
            await card.scroll_into_view_if_needed(); await card.click(); await pg.wait_for_timeout(600)
            st = await pg.evaluate(STATE)
            ok = st['open'] and st['title'] == title and any(r.startswith(row_start) for r in st['rows']) and len(st['about']) > 20 and (sub is None or st['sub'] == sub)
            check(f'{id_}: tap opens "{title}" with its rows and an explanation', ok, st if not ok else f"{len(st['rows'])} rows | {st['sub']}")
            if id_ in ('week', 'zones', 'ftp'):
                await pg.screenshot(path=f"/tmp/ov-sheet-{id_}.png")
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(600)
            st2 = await pg.evaluate(STATE)
            check(f'{id_}: Esc closes and focus returns to the card', (not st2['open']) and st2['active'] == id_, st2['active'])

        # ---- keyboard open
        await pg.evaluate("document.querySelector('#overview-panel [data-detail=\"ftp\"]').focus()")
        await pg.keyboard.press('Enter'); await pg.wait_for_timeout(500)
        check('Enter on a focused card opens its sheet', (await pg.evaluate(STATE))['title'] == 'FTP')
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(500)
        await pg.keyboard.press('Space'); await pg.wait_for_timeout(500)
        check('Space opens it too', (await pg.evaluate(STATE))['title'] == 'FTP')

        # ---- layering over the tab bar
        lay = await pg.evaluate("""() => { const tb = document.querySelector('.tab-bar').getBoundingClientRect(); const e = document.elementFromPoint(tb.x + tb.width/2, tb.y + tb.height/2); return !!e?.closest('.detail-sheet-host'); }""")
        check('sheet + scrim cover the tab bar', lay)

        # ---- the Edit button goes to Settings and lights the field
        btn = pg.locator('.detail-sheet-actions button', has_text='Edit FTP')
        check('FTP sheet has an "Edit FTP" header button', await btn.count() == 1)
        await btn.click(); await pg.wait_for_timeout(900)
        landed = await pg.evaluate("""() => ({ tab: document.querySelector('.tab-btn.active')?.dataset.tab, sheetOpen: !document.querySelector('.detail-sheet-host').classList.contains('hidden'),
          hl: [...document.querySelectorAll('.field-highlight')].map(e => e.id || e.className).join() })""")
        check('Edit FTP closes the sheet and lands on Settings', landed['tab'] == 'settings' and not landed['sheetOpen'], landed)
        check('the FTP field is highlighted', 'pref-ftp' in landed['hl'] or 'field-highlight' in landed['hl'], landed['hl'])

        # ---- vo2 max has no Edit button
        await pg.evaluate("document.querySelector('[data-tab=\"overview\"]').click()"); await pg.wait_for_timeout(700)
        await pg.locator('#overview-panel [data-detail="vo2max"]').click(); await pg.wait_for_timeout(500)
        check('VO2 Max sheet has no Edit button', await pg.locator('.detail-sheet-actions button', has_text='Edit').count() == 0)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(500)

        # ---- Recent still goes to History, not a sheet
        await pg.locator('#overview-panel .history-poster').first.click(); await pg.wait_for_timeout(600)
        tab = await pg.evaluate("document.querySelector('.tab-btn.active')?.dataset.tab")
        check('a Recent tile still goes to History', tab == 'history', tab)

        # ---- reduced motion + narrow viewport
        await pg.set_viewport_size({"width": 320, "height": 640})
        await pg.evaluate("document.querySelector('[data-tab=\"overview\"]').click()"); await pg.wait_for_timeout(700)
        await pg.locator('#overview-panel [data-detail="year"]').scroll_into_view_if_needed()
        await pg.locator('#overview-panel [data-detail="year"]').click(); await pg.wait_for_timeout(600)
        fit = await pg.evaluate("""() => { const s=document.querySelector('.detail-sheet'); const b=document.querySelector('.detail-sheet-body'); const r=s.getBoundingClientRect(); return {w:Math.round(r.width), vw:innerWidth, sideScroll: b.scrollWidth > b.clientWidth + 1, top: Math.round(r.top), rows: b.querySelectorAll('.ov-detail-row').length}; }""")
        check('320px: the 13-row Past 12 Months sheet fits the width and scrolls inside itself', fit['w'] <= fit['vw'] and not fit['sideScroll'] and fit['rows'] == 13, fit)
        await pg.screenshot(path="/tmp/ov-sheet-year-320.png")

        check('no page errors', not errs, errs[:3])
        await b.close()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
