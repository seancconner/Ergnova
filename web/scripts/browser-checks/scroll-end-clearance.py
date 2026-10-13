# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser check: at the end of its scroll, nothing on any page sits under the rail or the tab bar
.

Not part of `npm test`; run it by hand against a running app:

    npm run dev                                  # or: npx vite preview
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/scroll-end-clearance.py

Needs `pip install playwright` and a Chromium. Seeds a few rides, a profile and diary entries
into the app's own IndexedDB (and also runs the empty profile), then for every tab and rail
category at 390x844 and 320x640: scrolls the page to its end, finds the lowest piece of visible
text on it (text nodes, not container boxes: a container's own bottom padding is the very
clearance being tested, so it would pass by construction) and checks that its bottom is above
the tab bar, and above the rail when the text reaches as far left as the rail does.
It also prints each page's "blank band" (the empty height between that lowest text and the tab bar)
as information only; no threshold is asserted for it. Screenshots of every page at scroll end go to /tmp/end-<state>-<tab>-<cat>-<width>.png.
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
# Scrolls the tab's panel to its end, then reports where the lowest visible text is. Text nodes
# only count when they are actually on screen (not display:none / visibility:hidden / zero-size).
MEASURE = """(tab) => {
  const panel = document.querySelector(`.panel[data-panel="${tab}"]`);
  const sc = [panel, document.scrollingElement].find(e => e && e.scrollHeight > e.clientHeight + 2) || document.scrollingElement;
  sc.scrollTop = sc.scrollHeight;
  const tabBar = document.querySelector('.tab-bar').getBoundingClientRect();
  const rail = document.querySelector(`.md-rail[data-rail-for="${tab}"]`);
  const rr = rail && !rail.classList.contains('hidden') ? rail.getBoundingClientRect() : null;
  // The rail's lowest *visible* item is what text must clear; the rail box has its own padding.
  const items = rail ? [...rail.querySelectorAll('button, .md-rail-fab-slot')].filter(e => e.offsetParent) : [];
  const railTop = items.length ? Math.min(...items.map(e => e.getBoundingClientRect().top)) : null;
  const railRight = items.length ? Math.max(...items.map(e => e.getBoundingClientRect().right)) : null;
  // The whole panel, not just the active category: Settings' Keyboard Shortcuts and the autosave hint
  // are siblings of the categories (shown under every one), and a check rooted at the category was blind
  // to them — it kept passing after Keyboard Shortcuts became always-visible and pushed them to the
  // very end of the page. Inactive categories are display:none, so they have no rects and are skipped.
  const root = panel;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let best = null, n;
  while ((n = walker.nextNode())) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement, cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('.hidden, [hidden]')) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      if (!best || r.bottom > best.bottom) best = { bottom: r.bottom, left: r.left, text: n.textContent.trim().slice(0, 30) };
    }
  }
  return { scrollable: sc.scrollHeight - sc.clientHeight, tabBarTop: tabBar.top, railTop, railRight, best };
}"""

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

PAGES = [('overview', [None]), ('history', ['all', 'ride', 'str', 'test']),
         ('diet', ['today', 'recipes', 'ingredients', 'history']), ('settings', ['general', 'profile', 'display'])]

async def sweep(pg, state, width):
    for tab, cats in PAGES:
        await pg.evaluate(f"document.querySelector('.tab-btn[data-tab=\"{tab}\"]').click()"); await pg.wait_for_timeout(600)
        for c in cats:
            if c:
                await pg.evaluate(f"document.querySelector('.md-rail[data-rail-for=\"{tab}\"] .md-rail-item[data-cat=\"{c}\"]').click()"); await pg.wait_for_timeout(450)
            m = await pg.evaluate(MEASURE, tab); await pg.wait_for_timeout(250)
            await pg.screenshot(path=f'/tmp/end-{state}-{tab}-{c}-{width}.png')
            name = f'{state} {width}px {tab}/{c or "page"}'
            b = m['best']
            if not b:
                check(name + ': has visible text to measure', False, m); continue
            # Informational, no pass/fail: how much of the screen above the tab bar is empty below the
            # lowest text (the "no page ends in blank space" item has no agreed threshold yet).
            gap = m['tabBarTop'] - b['bottom']
            print(f"  blank band {name}: {gap:.0f}px = {gap / m['tabBarTop'] * 100:.0f}% of the screen above the tab bar")
            above_tabbar = b['bottom'] <= m['tabBarTop'] - 2
            # Under the rail only if the text reaches as far left as the rail's right edge.
            under_rail = m['railTop'] is not None and b['left'] < m['railRight'] and b['bottom'] > m['railTop'] - 2
            check(name + ': lowest text clears tab bar and rail', above_tabbar and not under_rail,
                  f"text '{b['text']}' bottom {b['bottom']:.0f}, tab bar top {m['tabBarTop']:.0f}, rail top {m['railTop']}")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for width, height in [(390, 844), (320, 640)]:
            ctx = await b.new_context(viewport={"width": width, "height": height}, device_scale_factor=1.5)
            pg = await ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(BASE, wait_until="load"); await pg.wait_for_timeout(1200)
            for state, seed in [('empty', False), ('seeded', True)]:
                await pg.evaluate(CLEAR)
                if seed: await pg.evaluate(SEED)
                await pg.reload(wait_until="load"); await pg.wait_for_timeout(2200)
                await sweep(pg, state, width)
            check(f'{width}px: no page errors', not errs, errs[:3])
            await ctx.close()
        await b.close()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
