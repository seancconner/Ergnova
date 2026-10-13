# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the live cardio screen: the hero
numeral with Average over Peak stacked on its right (one row; on the All page the same row steps through the metrics on a timer), the chart on a hero-tier glass panel, and the Connect
tile that replaces the empty chart's one line of text.

Not part of `npm test`; run by hand against a running dev server:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/live-cardio-hero.py

Needs `pip install playwright` and a Chromium. Starts a free-ride Cardio Session from the FAB menu
at 390x844 with no sensors, then fakes sensor data the way the app sees it (capabilities.set plus
deviceManager.update / session.pushData, via the dev-only window.__debug hooks), so no Bluetooth is
involved. Prints PASS/FAIL per check.
"""
import os, asyncio, sys
from playwright.async_api import async_playwright

BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

FEED = """async (on) => {
  const { deviceManager } = await import('/src/ble/device-manager.js');
  clearInterval(window.__feed);
  if (!on) return;
  const cap = window.__debug.capabilities; cap.set('power', true); cap.set('heartRate', true); cap.set('cadence', true);
  let t = 0;
  window.__feed = setInterval(() => { t++;
    const d = { power: window.__power ?? (180 + Math.round(60 * Math.sin(t / 6)) + (t % 7)), heartRate: 120 + Math.min(40, t), cadence: 85 + (t % 5) };
    deviceManager.update('fake', d); window.__debug.session()?.pushData?.(d); }, 250);
}"""

async def start_free_ride(pg):
    await pg.goto(BASE, wait_until='load'); await pg.wait_for_timeout(1500)
    await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.getElementById('fab-menu-cardio').click()"); await pg.wait_for_timeout(800)
    await pg.evaluate("document.getElementById('qs-finish').click()"); await pg.wait_for_timeout(1300)

async def box(pg, sel):
    return await pg.evaluate("""(s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, display: getComputedStyle(e).display }; }""", sel)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errs.append('console: ' + m.text))

        # ───────────────────────── Empty: no sensor connected ─────────────────────────
        await start_free_ride(pg)
        row = await box(pg, '#metrics-row')
        panel = await pg.evaluate("document.getElementById('session-panel').className")
        chart = await box(pg, '#chart-container')
        check('empty: the readout row is gone, not a row of dashes', row and row['display'] == 'none' and 'no-metrics' in panel, (row, panel))
        check('empty: the chart panel takes the freed height (>= 700px at 390x844)', chart and chart['h'] >= 700, chart)
        tile = await pg.evaluate("""() => { const t = document.querySelector('.chart-empty-tile'); if (!t) return null;
            const btn = t.querySelector('.chart-empty-btn'), br = btn.getBoundingClientRect();
            return { title: t.querySelector('.chart-empty-title')?.textContent, sub: t.querySelector('.chart-empty-sub')?.textContent, icon: !!t.querySelector('.chart-empty-icon svg use'),
                     btn: btn.textContent.trim(), cta: btn.classList.contains('btn-glass-cta'), h: br.height, w: br.width, plainLine: !!document.querySelector('.chart-empty:not(.chart-empty--tile)') }; }""")
        check('empty: a real tile -- icon, heading, one muted line and a Connect button', tile and tile['icon'] and tile['title'] and tile['sub'] and tile['btn'] == 'Connect' and not tile['plainLine'], tile)
        check('empty: the Connect button is the lit glass CTA and tap-sized', tile and tile['cta'] and tile['h'] >= 44, tile)
        glass = await pg.evaluate("""() => { const cs = getComputedStyle(document.getElementById('chart-container'));
            const m = cs.backgroundColor.match(/[\\d.]+/g) || []; const a = m.length > 3 ? parseFloat(m[3]) : 1;
            return { alpha: a, filter: cs.backdropFilter || cs.webkitBackdropFilter, radius: cs.borderTopLeftRadius }; }""")
        check('chart panel is hero-tier glass: translucent fill, backdrop blur, rounded', glass['alpha'] < 1 and glass['filter'] not in ('', 'none') and glass['radius'] not in ('0px', ''), glass)
        await pg.click('.chart-empty-btn'); await pg.wait_for_timeout(300)
        opened = await pg.evaluate("() => !document.getElementById('trainer-menu').classList.contains('hidden')")
        await pg.evaluate("document.querySelector('.chart-empty-btn').click()"); await pg.wait_for_timeout(300)
        still = await pg.evaluate("() => !document.getElementById('trainer-menu').classList.contains('hidden')")
        check('empty: Connect opens the sensor menu, and a second tap does not close it', opened and still, (opened, still))
        await pg.screenshot(path='/tmp/lch-empty.png')
        await pg.evaluate("document.getElementById('trainer-menu-btn').click()"); await pg.wait_for_timeout(200)

        # ───────────────────────── Live: a power reading ─────────────────────────
        await pg.evaluate(FEED, True); await pg.wait_for_timeout(5000)
        await pg.evaluate("() => { const t = document.querySelector('.chart-track'); const pg = document.querySelector('.chart-page[data-metric=\"power\"]') ?? [...document.querySelectorAll('.chart-page')][1]; t.scrollTo({ left: pg.offsetLeft }); }")
        await pg.wait_for_timeout(700)
        s = await pg.evaluate("""() => { const g = id => document.getElementById(id), r = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
            const val = g('stat-current-value'), row = g('metrics-row');
            return { key: window.__debug.chartCarousel()._activeKey, name: g('stat-metric-name').textContent, cur: val.textContent, unit: g('stat-current-unit').textContent,
              fs: parseFloat(getComputedStyle(val).fontSize), clip: val.scrollWidth > val.clientWidth + 1, avg: g('stat-average-value').textContent, peak: g('stat-peak-value').textContent,
              row: r(row), hero: r(document.querySelector('.metric-card-hero')), pairs: [...document.querySelectorAll('.metric-card-pair')].map(r),
              panel: document.getElementById('session-panel').className, isEmpty: row.classList.contains('is-empty'),
              wash: getComputedStyle(document.querySelector('.metric-card-hero')).backgroundImage.includes('linear-gradient') }; }""")
        check('live: the readout is back and the panel row is restored', not s['isEmpty'] and 'no-metrics' not in s['panel'], s['panel'])
        check('live: the hero names the metric and shows the current value with its unit beside it', s['name'] == 'Power' and s['cur'].isdigit() and s['unit'] == 'W', s)
        check('live: the numeral is giant (>= 44px) and not clipped', s['fs'] >= 44 and not s['clip'], (s['fs'], s['clip']))
        check('live: Average and Peak carry their own values and units', 'W' in s['avg'] and 'W' in s['peak'] and s['avg'][0].isdigit() and s['peak'][0].isdigit(), (s['avg'], s['peak']))
        check('live: one row -- the hero on the left, Average over Peak stacked on its right, no chevron', len(s['pairs']) == 2 and abs(s['pairs'][0]['x'] - s['pairs'][1]['x']) < 2 and s['pairs'][0]['x'] >= s['hero']['x'] + s['hero']['w'] - 1 and s['pairs'][1]['y'] >= s['pairs'][0]['y'] + s['pairs'][0]['h'] - 1 and abs(s['pairs'][0]['y'] - s['hero']['y']) < 2 and abs((s['pairs'][1]['y'] + s['pairs'][1]['h']) - (s['hero']['y'] + s['hero']['h'])) < 2 and await pg.evaluate("() => !document.getElementById('stats-collapse-btn')"), s)
        check("live: the hero carries the metric's wash (a gradient) over its glass", s['wash'])
        canvas = await pg.evaluate("""() => { const c = document.querySelector('.chart-page canvas'); const ctx = c.getContext('2d'); const d = ctx.getImageData(2, 2, 1, 1).data; return { a: d[3] }; }""")
        check('live: the chart canvas paints no background of its own (corner pixel is transparent)', canvas['a'] == 0, canvas)
        await pg.screenshot(path='/tmp/lch-live.png')

        # ── fit-to-width: a reading too wide for its box shrinks instead of clipping ──
        natural = s['fs']
        await pg.evaluate("document.getElementById('metrics-row').style.width = '150px'; window.__power = 98765")
        await pg.wait_for_timeout(2500)
        f = await pg.evaluate("""() => { const v = document.getElementById('stat-current-value'); return { text: v.textContent, fs: parseFloat(getComputedStyle(v).fontSize), clip: v.scrollWidth > v.clientWidth + 1 }; }""")
        check('fit: a too-wide reading shrinks to fit rather than clipping', f['fs'] < natural and not f['clip'] and f['text'].isdigit() and len(f['text']) >= 4, (natural, f))
        # (the readout re-fits when its text next changes, which is the next stats render -- about once a second)
        await pg.evaluate("document.getElementById('metrics-row').style.width = ''; window.__power = undefined"); await pg.wait_for_timeout(2500)
        back = await pg.evaluate("parseFloat(getComputedStyle(document.getElementById('stat-current-value')).fontSize)")
        check('fit: and grows back when the box and the reading allow', back >= natural - 1, (natural, back))

        # -- the All page reuses this same hero row, stepping through the metrics on a timer --
        single = await pg.evaluate("""() => ({ row: document.getElementById('metrics-row').getBoundingClientRect().height, chart: document.getElementById('chart-container').getBoundingClientRect().top })""")
        await pg.screenshot(path='/tmp/lch-single.png')

        # ───────────────────────── The All page (several metrics) ─────────────────────────
        await start_free_ride(pg)
        await pg.evaluate(FEED, True); await pg.wait_for_timeout(4500)
        await pg.evaluate("document.querySelector('.chart-track').scrollTo({ left: 0 })"); await pg.wait_for_timeout(700)
        HERO = """() => ({ key: window.__debug.chartCarousel()._activeKey, hidden: document.getElementById('metrics-row').classList.contains('hidden'),
            empty: document.getElementById('metrics-row').classList.contains('is-empty'), name: document.getElementById('stat-metric-name').textContent,
            metric: document.getElementById('metrics-row').dataset.metric, cur: document.getElementById('stat-current-value').textContent,
            unit: document.getElementById('stat-current-unit').textContent, avg: document.getElementById('stat-average-value').textContent,
            peak: document.getElementById('stat-peak-value').textContent })"""
        a = await pg.evaluate(HERO)
        check('All page: the 12-card stat grid is gone from the page', await pg.evaluate("() => !document.getElementById('chart-split-stats') && !document.querySelector('.chart-split-stat-col')"))
        check('All page: the same hero row is reused -- shown, not empty, named for one of the overview metrics', a['key'] == '__overview__' and not a['hidden'] and not a['empty'] and a['name'] in ('Power', 'Heart Rate', 'Cadence'), a)
        check('All page: the hero reads out live data -- a number with its unit, and Average / Peak beside it', a['cur'].isdigit() and a['unit'] and a['avg'][0].isdigit() and a['peak'][0].isdigit(), a)
        allp = await pg.evaluate("""() => ({ row: document.getElementById('metrics-row').getBoundingClientRect().height, chart: document.getElementById('chart-container').getBoundingClientRect().top })""")
        check('All page vs single chart: the hero row is the same height and the chart sits at the same place, so swiping never moves it', abs(allp['row'] - single['row']) < 0.5 and abs(allp['chart'] - single['chart']) < 0.5, (allp, single))

        ring = ['Heart Rate', 'Power', 'Cadence']
        seq = [a['name']]; ok_vals = True
        for _ in range(9):
            await pg.wait_for_timeout(1000)
            h = await pg.evaluate(HERO)
            if h['name'] != seq[-1]: seq.append(h['name'])
            ok_vals = ok_vals and h['cur'] not in ('', '\u2014') and h['unit'] != ''
        steps_ok = all(ring[(ring.index(x) + 1) % 3] == y for x, y in zip(seq, seq[1:]))
        check('All page: left alone for ~9s the hero steps through the metrics on its own, in chart order, wrapping round', len(seq) >= 3 and steps_ok, seq)
        check('All page: every metric it lands on shows a live value and unit (no dashes)', ok_vals)
        h = await pg.evaluate(HERO)
        check('All page: the row is tinted for the metric on show (data-metric follows the name)', {'Power': 'power', 'Heart Rate': 'heartRate', 'Cadence': 'cadence'}[h['name']] == h['metric'], h)

        # -- the All page draws the hero's metric only, and its dot takes that metric's colour --
        check('All page: no split toggle (one metric at a time, nothing to split)', await pg.evaluate("() => !document.querySelector('.chart-split-toggle')"))
        STATE = """() => { const c = window.__debug.chartCarousel(), p = c._pages.get('__overview__');
            const dot = document.querySelectorAll('.chart-dot')[0], inactive = [...document.querySelectorAll('.chart-dot:not(.active)')];
            const probe = document.createElement('i'); probe.style.background = 'var(--bg-hover)'; document.body.appendChild(probe);
            const hover = getComputedStyle(probe).backgroundColor; probe.remove();
            const series = [...p.engine._series.entries()].map(([k, v]) => [k, v.color]);
            return { series, metric: document.getElementById('metrics-row').dataset.metric, dotActive: dot.classList.contains('active'),
                     dotColor: dot.style.getPropertyValue('--dot-color'), dotBg: getComputedStyle(dot).backgroundColor,
                     inactiveBgs: inactive.map(d => getComputedStyle(d).backgroundColor), hover }; }"""
        s0 = await pg.evaluate(STATE)
        check('All page: the chart carries exactly one series, the hero\'s metric', len(s0['series']) == 1 and s0['series'][0][0] == s0['metric'], s0)
        check('All page: its dot is active and takes that metric\'s colour', s0['dotActive'] and s0['dotColor'] == s0['series'][0][1], s0)
        check('chart dots: every inactive dot is --bg-hover', s0['inactiveBgs'] and all(c == s0['hover'] for c in s0['inactiveBgs']), s0)
        seen_keys, seen_colors, in_step = set(), set(), True
        for _ in range(10):
            await pg.wait_for_timeout(1000)
            s = await pg.evaluate(STATE)
            in_step = in_step and len(s['series']) == 1 and s['series'][0][0] == s['metric'] and s['dotColor'] == s['series'][0][1]
            seen_keys.add(s['metric']); seen_colors.add(s['dotColor'])
        check('All page: over ~10s the chart and the dot follow the hero through every metric, never out of step', in_step and seen_keys == {'power', 'heartRate', 'cadence'} and len(seen_colors) == 3, (seen_keys, seen_colors))
        await pg.screenshot(path='/tmp/lch-all-follow.png')
        # a held crosshair (focus-lock) keeps its metric: the rotation waits until it is released
        await pg.evaluate("() => window.__debug.chartCarousel()._engageLock('__overview__')")
        k0 = (await pg.evaluate(STATE))['series'][0][0]; n0 = (await pg.evaluate(HERO))['name']
        await pg.wait_for_timeout(4500)
        k1 = (await pg.evaluate(STATE))['series'][0][0]; n1 = (await pg.evaluate(HERO))['name']
        check('All page: while focus-locked the chart and hero stay put', k0 == k1 and n0 == n1, (k0, k1, n0, n1))
        await pg.evaluate("() => window.__debug.chartCarousel()._disengageLock()")
        await pg.wait_for_timeout(4500)
        k2 = (await pg.evaluate(STATE))['series'][0][0]
        check('All page: and the rotation resumes once released', k2 != k1, (k1, k2))

        await pg.evaluate("""() => { const t = document.querySelector('.chart-track'); t.scrollTo({ left: document.querySelector('.chart-page[data-metric="power"]').offsetLeft, behavior: 'instant' }); }"""); await pg.wait_for_timeout(900)
        l1 = await pg.evaluate(HERO); await pg.wait_for_timeout(4500); l2 = await pg.evaluate(HERO)
        check("leaving the All page: the rotation stops and the hero holds that chart's own metric", l1['key'] == 'power' and l1['name'] == 'Power' and l2['name'] == 'Power', (l1['name'], l2['name']))
        await pg.evaluate("() => { const t = document.querySelector('.chart-track'); t.scrollTo({ left: 0, behavior: 'instant' }); }"); await pg.wait_for_timeout(900)
        r1 = await pg.evaluate(HERO)
        check('coming back to the All page: it starts again from the first metric (Heart Rate)', r1['key'] == '__overview__' and r1['name'] == 'Heart Rate', r1)
        await pg.evaluate(FEED, False)

        # ───────────────────────── Short landscape phone ─────────────────────────
        await pg.set_viewport_size({'width': 844, 'height': 390}); await pg.wait_for_timeout(500)
        await pg.evaluate("document.querySelector('.chart-track').scrollTo({ left: document.querySelectorAll('.chart-page')[1].offsetLeft })"); await pg.wait_for_timeout(600)
        l = await pg.evaluate("""() => { const r = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
            return { hero: r(document.querySelector('.metric-card-hero')), pairs: [...document.querySelectorAll('.metric-card-pair')].map(r), chart: r(document.getElementById('chart-container')),
                     row: r(document.getElementById('metrics-row')), vh: innerHeight, vw: innerWidth }; }""")
        stacked = (len(l['pairs']) == 2 and abs(l['hero']['y'] - l['pairs'][0]['y']) < 2 and abs(l['pairs'][0]['x'] - l['pairs'][1]['x']) < 2
                   and l['pairs'][1]['y'] > l['pairs'][0]['y'] and abs(l['row']['h'] - l['hero']['h']) < 2)
        check('landscape (844x390): hero on the left, Average over Peak stacked on its right, same row height', stacked, l)
        check('landscape: the chart keeps >= 190px of height and nothing spills off the screen', l['chart']['h'] >= 190 and l['chart']['y'] + l['chart']['h'] <= l['vh'] + 1 and l['row']['x'] + l['row']['w'] <= l['vw'] + 1, l)
        await pg.screenshot(path='/tmp/lch-landscape.png')

        check('no page errors', not errs, errs[:3])
        n_ok = sum(1 for _, ok, _ in results if ok)
        print(f'\n{n_ok}/{len(results)} passed')
        await b.close()
        return n_ok == len(results)

ok = asyncio.run(main())
sys.exit(0 if ok else 1)
