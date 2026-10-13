# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser check for the History session detail's chart backing: the chart in the
detail sheet sits on the same hero-tier glass as the live chart's panel (#chart-container), and its canvases paint no
background of their own, so the lines and grid are drawn on that glass rather than on a solid dark box.

Not part of `npm test`; run by hand against a running dev server:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/history-detail-chart-glass.py

Needs `pip install playwright` and a Chromium. Seeds four rides into the app's own IndexedDB (the same seed as
detail-sheet.py), opens the first one's detail sheet and compares the chart panel with the live one. Screenshot: /tmp/hdc-glass.png.
"""
import os, asyncio, sys
from playwright.async_api import async_playwright

BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
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
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

PANEL = """(sel) => { const e = document.querySelector(sel), cs = getComputedStyle(e);
  return { bg: cs.backgroundColor, filter: cs.backdropFilter || cs.webkitBackdropFilter || 'none', radius: cs.borderTopLeftRadius }; }"""
PIXELS = """() => [...document.querySelectorAll('.history-detail-chart canvas')].filter(c => c.width > 0).map(c => {
  const x = c.getContext('2d', { willReadFrequently: true }), w = c.width, h = c.height;
  // a few spots well away from the axes, the grid and the line: the corners and the middle of the top strip
  const at = (px, py) => x.getImageData(px, py, 1, 1).data[3];
  return { w, h, alphas: [at(1, 1), at(w - 2, 1), at(Math.round(w / 2), 1), at(w - 2, h - 2)] };
})"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errs.append('console: ' + m.text))
        await pg.goto(BASE, wait_until='load'); await pg.wait_for_timeout(1500)
        await pg.evaluate(SEED); await pg.reload(wait_until='load'); await pg.wait_for_timeout(2500)
        await pg.evaluate("document.querySelector('[data-tab=\"history\"]').click()"); await pg.wait_for_timeout(800)
        await pg.locator('.panel[data-panel="history"] .md-cat.active .history-poster').first.click(); await pg.wait_for_timeout(900)

        live = await pg.evaluate(PANEL, '#chart-container')
        det = await pg.evaluate(PANEL, '.history-detail-chart')
        check('the detail chart panel has the same translucent glass tint as the live chart panel', det['bg'] == live['bg'] and det['bg'] not in ('rgba(0, 0, 0, 0)', 'transparent'), (det['bg'], live['bg']))
        check('...the same backdrop blur', det['filter'] == live['filter'] and 'blur' in det['filter'], (det['filter'], live['filter']))
        check('...and the same corner radius', det['radius'] == live['radius'] and det['radius'] not in ('0px', ''), (det['radius'], live['radius']))

        for idx, name in [(0, 'All page'), (1, 'first metric page')]:
            await pg.evaluate("(i) => { const t = document.querySelector('.history-detail-chart .chart-track'); t.scrollTo({ left: t.clientWidth * i, behavior: 'instant' }); }", idx)
            await pg.wait_for_timeout(700)
            px = await pg.evaluate(PIXELS)
            check(f'{name}: the canvas paints no background (corners and the top strip are fully transparent)', px and all(a == 0 for c in px for a in c['alphas']), px[:2])
        await pg.screenshot(path='/tmp/hdc-glass.png')
        check('the chart still draws (the carousel has pages and a painted line)', await pg.evaluate("""() => { const c = document.querySelector('.history-detail-chart canvas'); if (!c) return false;
            const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n > 500; }"""))
        check('no page errors', not errs, errs[:3])
        await b.close()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
