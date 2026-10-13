# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser check for History's session-detail chart rotating its All page: like the
live chart's All page it draws ONE metric's chart at a time and steps to the next on a timer (3.5s), instead of overlaying
every metric. The page's dot takes the colour of the metric on show, which is what this reads.

Not part of `npm test`; run by hand against a running dev server:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/history-detail-rotation.py

Needs `pip install playwright` and a Chromium. Seeds four rides (the same seed as detail-sheet.py) and opens the first one's
detail sheet. Screenshot: /tmp/hdr-all.png.
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

DOT0 = "() => getComputedStyle(document.querySelector('.history-detail-chart .chart-dots').children[0]).getPropertyValue('--dot-color').trim()"
DOTS = "() => document.querySelectorAll('.history-detail-chart .chart-dots').length ? document.querySelector('.history-detail-chart .chart-dots').children.length : 0"
GO = "(i) => { const t = document.querySelector('.history-detail-chart .chart-track'); t.scrollTo({ left: t.clientWidth * i, behavior: 'instant' }); }"

async def sample(pg, n, every):
    out = []
    for _ in range(n):
        out.append(await pg.evaluate(DOT0)); await pg.wait_for_timeout(every)
    return out

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

        pages = await pg.evaluate(DOTS)
        check('the detail chart has an All page plus a page per metric', pages >= 3, pages)
        seq = await sample(pg, 56, 300)   # ~17s: a lap of four metrics (14s) and a little more
        changes = [seq[0]] + [c for i, c in enumerate(seq[1:], 1) if c != seq[i - 1]]
        check('on the All page the dot steps through different metric colours, one after another', len(changes) >= 3 and len(set(changes[:3])) == 3, changes)
        metrics = pages - 1
        check('...and wraps round to the first colour again after a lap of every metric', len(changes) > metrics and changes[metrics] == changes[0], (metrics, changes))
        # one chart at a time: only one series on the All page, so its Y axis is one metric's (a single numeric axis, no overlay legend)
        await pg.screenshot(path='/tmp/hdr-all.png')
        # the dwell
        stamps = []; cur = await pg.evaluate(DOT0)
        for _ in range(140):
            await pg.wait_for_timeout(100)
            nxt = await pg.evaluate(DOT0)
            if nxt != cur: stamps.append(await pg.evaluate('performance.now()')); cur = nxt
            if len(stamps) == 3: break
        gaps = [round(stamps[i + 1] - stamps[i]) for i in range(len(stamps) - 1)]
        check('it holds each metric for about 3.5 seconds', len(gaps) == 2 and all(3200 <= g <= 3900 for g in gaps), gaps)
        # the chart fades in on each step
        saw = False
        for _ in range(50):
            if await pg.evaluate("[...document.querySelectorAll('.history-detail-chart .live-chart')].some(c => c.classList.contains('chart-swap'))"): saw = True; break
            await pg.wait_for_timeout(100)
        check('each step fades the chart in (chart-swap)', saw)

        # leaving the All page stops the rotation
        await pg.evaluate(GO, 1); await pg.wait_for_timeout(900)
        a = await sample(pg, 16, 300)
        check('on a metric page the rotation has stopped (the All page\'s dot colour no longer changes over 5s)', len(set(a)) == 1, sorted(set(a)))
        # coming back restarts it from the first metric
        await pg.evaluate(GO, 0); await pg.wait_for_timeout(500)
        first = await pg.evaluate(DOT0)
        check('coming back to the All page starts again from the first metric', first == changes[0], (first, changes[0]))
        await pg.wait_for_timeout(4200)
        check('...and it is moving again', await pg.evaluate(DOT0) != first)

        # closing the sheet stops the timer: no errors from a destroyed carousel
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(1200)
        await pg.wait_for_timeout(4500)
        check('no page errors, including after the sheet is closed and the timer would have fired', not errs, errs[:3])
        await b.close()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
