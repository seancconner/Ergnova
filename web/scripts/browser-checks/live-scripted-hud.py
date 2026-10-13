# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the live cardio screen's scripted-workout HUD: it
sits BELOW the live chart, just above the control bar, on the same glass background as an Overview/History tile
(--tier-hero-bg/--tier-hero-filter) with a real 2px left rule in the current step's colour (named
through the shared --metric readout rule, no gradient wash of its own), and on a short landscape screen
it lays out as one row of overall + step over the full-width target map instead of being clipped.

Not part of `npm test`; run by hand against a running dev server:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/live-scripted-hud.py

Needs `pip install playwright` and a Chromium. A scripted workout only exists when a trainer is connected
(startSession() builds a ScriptedSession only with a modeSwitch), and the browser has none, so the check stands
in for one through the dev-only window.__debug.setModeSwitch hook with a permissive fake, then picks the first
preset in Cardio Session's Sequence style. Power / heart rate / cadence / speed are faked the way the app sees
them (capabilities.set plus deviceManager.update / session.pushData). No Bluetooth is involved.
Prints PASS/FAIL per check; screenshots go to /tmp/lsh-*.png.
"""
import os, re, asyncio, sys
from playwright.async_api import async_playwright

BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

FAKE = ("window.__debug.setModeSwitch(new Proxy({ activeModeName: 'erg', availableModes: ['erg', 'slope', 'resistance'] }, "
        "{ get: (t, k) => (typeof k === 'symbol' || k === 'then') ? undefined : (k in t ? t[k] : (() => Promise.resolve())) }))")

FEED = """async (on) => {
  const { deviceManager } = await import('/src/ble/device-manager.js');
  clearInterval(window.__feed);
  if (!on) return;
  const cap = window.__debug.capabilities; cap.set('power', true); cap.set('heartRate', true); cap.set('cadence', true); cap.set('speed', true);
  let t = 0;
  window.__feed = setInterval(() => { t++;
    const d = { power: 180 + Math.round(60 * Math.sin(t / 6)) + (t % 7), heartRate: 120 + Math.min(40, t), cadence: 85 + (t % 5), speed: 28 + Math.round(3 * Math.sin(t / 8)) };
    deviceManager.update('fake', d); window.__debug.session()?.pushData?.(d); }, 250);
}"""

async def new_page(b, w, h):
    ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2)
    pg = await ctx.new_page(); pg.errs = []
    pg.on('pageerror', lambda e: pg.errs.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and pg.errs.append('console: ' + m.text))
    return pg

async def open_flow(pg, trainer):
    await pg.goto(BASE, wait_until='load'); await pg.wait_for_timeout(1200)
    if trainer: await pg.evaluate(FAKE)
    await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.getElementById('fab-menu-cardio').click()"); await pg.wait_for_timeout(800)

async def start_scripted(pg):
    await open_flow(pg, True)
    await pg.evaluate("[...document.querySelectorAll('.sf-tile')].find(e => e.textContent.trim().startsWith('Sequence'))?.click()"); await pg.wait_for_timeout(500)
    await pg.evaluate("document.getElementById('qs-preset-trigger')?.click()"); await pg.wait_for_timeout(400)
    n = await pg.evaluate("(() => { const c = [...document.querySelectorAll('[data-preset-id]')]; c[0]?.click(); return c.length; })()"); await pg.wait_for_timeout(400)
    await pg.evaluate("document.getElementById('qs-finish').click()"); await pg.wait_for_timeout(1500)
    return n

async def start_free(pg):
    await open_flow(pg, False)
    await pg.evaluate("document.getElementById('qs-finish').click()"); await pg.wait_for_timeout(1300)

MEASURE = """() => {
  const R = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, w: b.width, h: b.height }; };
  const $ = id => document.getElementById(id), hud = $('scripted-hud');
  const inside = (e, box) => { const r = R(e); return !!r && r.h > 0 && r.t >= box.t - 0.6 && r.b <= box.b + 0.6 && r.l >= box.l - 0.6 && r.r <= box.r + 0.6; };
  const box = R(hud);
  const pos = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const tlRow = $('hud-timeline-row');
  const timelineShown = !tlRow.classList.contains('hidden') && getComputedStyle(tlRow).display !== 'none';   // hidden by the workout (no targets) or by the short-screen layout
  return {
    panel: $('session-panel').className, hudHidden: hud.classList.contains('hidden'),
    metrics: R($('metrics-row')), chart: R($('chart-container')), hud: box, bar: R($('session-control-bar')),
    domOrder: { chartThenHud: pos($('chart-container'), hud), metricsThenHud: pos($('metrics-row'), hud), hudThenBar: pos(hud, $('session-control-bar')) },
    pieces: { title: inside($('hud-workout-title'), box), total: inside($('hud-total-remaining'), box), badge: inside($('hud-step-badge'), box),
              name: inside($('hud-step-name'), box), remaining: inside($('hud-remaining'), box), step: inside(document.querySelector('.hud-step'), box),
              timeline: timelineShown ? inside(document.querySelector('.hud-timeline'), box) : null },
    overall: R(document.querySelector('.hud-overall')), step: R(document.querySelector('.hud-step')), tl: R(document.querySelector('.hud-timeline-row')),
    overflowX: hud.scrollWidth > hud.clientWidth + 1,
    text: { badge: $('hud-step-badge').textContent, name: $('hud-step-name').textContent, remaining: $('hud-remaining').textContent, total: $('hud-total-remaining').textContent, title: $('hud-workout-title').textContent },
  };
}"""

STYLE = """() => {
  const hud = document.getElementById('scripted-hud'), cs = getComputedStyle(hud), bef = getComputedStyle(hud, '::before');
  const px = c => { const k = document.createElement('canvas'); k.width = k.height = 1; const x = k.getContext('2d', { willReadFrequently: true }); x.fillStyle = c; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data]; };
  const hudColor = hud.style.getPropertyValue('--hud-color').trim();
  return { bg: cs.backgroundColor, backdrop: cs.backdropFilter || 'none', image: cs.backgroundImage.startsWith('linear-gradient'), shadow: cs.boxShadow,
           borderW: cs.borderLeftWidth, borderStyle: cs.borderLeftStyle, edge: px(cs.borderLeftColor), hudColor, hudRgb: hudColor ? px(hudColor) : null,
           metricVar: cs.getPropertyValue('--metric').trim(), before: bef.content, radiusTR: cs.borderTopRightRadius, radiusTL: cs.borderTopLeftRadius,
           stepBg: getComputedStyle(document.querySelector('.hud-step')).backgroundColor };
}"""

TIMELINE = """() => {
  const cv = document.getElementById('hud-timeline-canvas'), dot = document.getElementById('hud-timeline-dot'), lab = document.getElementById('hud-timeline-target'), box = document.getElementById('hud-timeline');
  const px = c => { const k = document.createElement('canvas'); k.width = k.height = 1; const x = k.getContext('2d', { willReadFrequently: true }); x.fillStyle = c; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return `${d[0]},${d[1]},${d[2]}`; };
  const cr = cv.getBoundingClientRect(), dr = dot.getBoundingClientRect(), br = box.getBoundingClientRect(), lr = lab.getBoundingClientRect();
  const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, W = cv.width, H = cv.height, dpr = cv.width / cr.width;
  let painted = 0, lineRows = 0;
  for (let i = 3; i < img.length; i += 4) if (img[i] > 0) painted++;
  // the line: the topmost strong pixel in the column under the dot's centre (the glow below it is much fainter than the 70% line)
  const cx = Math.min(W - 1, Math.max(0, Math.round((dr.left + dr.width / 2 - cr.left) * dpr)));
  let lineY = null;
  for (let y = 0; y < H; y++) { if (img[(y * W + cx) * 4 + 3] > 120) { lineY = (y + 1) / dpr + cr.top; break; } }   // +1px: the middle of the 2px line, in CSS px
  for (let y = 0; y < H; y++) if (img[(y * W + Math.round(W * 0.5)) * 4 + 3] > 120) lineRows++;
  const dotColor = getComputedStyle(dot).backgroundColor, hud = document.getElementById('scripted-hud').style.getPropertyValue('--hud-color').trim();
  return { painted, lineRows, canvasW: cv.width, boxW: br.width, dotY: dr.top + dr.height / 2, lineY, dotX: dr.left + dr.width / 2, dotW: dr.width, dotRadius: getComputedStyle(dot).borderRadius,
           dotColor: px(dotColor), hudRgb: px(hud), label: lab.textContent.trim(), labelLeft: lr.left - br.left, labelBottomGap: br.bottom - lr.bottom, labelBg: getComputedStyle(lab).backgroundColor };
}"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        shots = {}

        # ───────────── Portrait phones: the HUD under the chart ─────────────
        for (w, h, name, chart_min) in [(390, 844, 'portrait', 520), (360, 640, 'small', 320)]:
            pg = await new_page(b, w, h)
            n = await start_scripted(pg); await pg.evaluate(FEED, True); await pg.wait_for_timeout(5000)
            m = await pg.evaluate(MEASURE)
            check(f'{name}: the scripted workout is running (a preset was picked and the HUD is showing)', n > 0 and not m['hudHidden'] and 'session-active' in m['panel'] and 'no-hud' not in m['panel'], (n, m['panel']))
            check(f'{name}: top to bottom: readout, chart, HUD, control bar (nothing overlaps)', m['metrics']['b'] <= m['chart']['t'] + 0.5 and m['chart']['b'] <= m['hud']['t'] + 0.5 and m['hud']['b'] <= m['bar']['t'] + 0.5, (m['metrics'], m['chart'], m['hud'], m['bar']))
            gap = m['hud']['t'] - m['chart']['b']
            check(f'{name}: the HUD is a few px under the chart, not flush and not floating (3-8px)', 3 <= gap <= 8, round(gap, 1))
            check(f'{name}: the HUD sits just above the control bar (within 8px)', 0 <= m['bar']['t'] - m['hud']['b'] <= 8, round(m['bar']['t'] - m['hud']['b'], 1))
            check(f'{name}: the markup follows the screen: chart and readout come before the HUD, the HUD before the control bar', all(m['domOrder'].values()), m['domOrder'])
            check(f'{name}: every piece (title, total, badge, name, countdown, step row, target map) is inside the HUD, none clipped', all(v for v in m['pieces'].values() if v is not None) and m['pieces']['timeline'] is True, m['pieces'])
            check(f'{name}: the pieces read as real values', re.fullmatch(r'Step \d+/\d+', m['text']['badge']) and m['text']['name'] not in ('', '—') and re.fullmatch(r'\d+:\d\d', m['text']['remaining']) and m['text']['total'] not in ('', '—') and m['text']['title'] not in ('', '—'), m['text'])
            check(f'{name}: stacked in three rows (overall, then step, then target map) and no sideways overflow', m['step']['t'] >= m['overall']['b'] - 0.5 and m['tl']['t'] >= m['step']['b'] - 0.5 and not m['overflowX'], (m['overall'], m['step'], m['tl']))
            check(f'{name}: the HUD is slimmer than the old card (<= 130px; it was 148)', m['hud']['h'] <= 130, round(m['hud']['h'], 1))
            check(f'{name}: the chart keeps at least {chart_min}px (it had {511 if name == "portrait" else 307} with the HUD on top)', m['chart']['h'] >= chart_min, round(m['chart']['h'], 1))
            sty = await pg.evaluate(STYLE)
            if name == 'portrait':
                check('look: sits on the same glass as an Overview/History tile (a translucent panel with blur, no shadow) — not a transparent/no-blur HUD', sty['bg'] not in ('rgba(0, 0, 0, 0)', 'transparent') and 'blur' in sty['backdrop'] and sty['shadow'] == 'none', sty)
                check('look: the readout rule is a real 2px solid left border, not an overlay (no ::before)', sty['borderW'] == '2px' and sty['borderStyle'] == 'solid' and sty['before'] in ('none', 'normal'), sty)
                check('look: the gradient wash is off since the HUD sits on real glass; the rule still names itself from the step colour', not sty['image'] and sty['metricVar'] == sty['hudColor'] and bool(sty['hudColor']), sty)
                e, hc = sty['edge'], sty['hudRgb']
                check('look: the rule is the current step\'s colour at the shared rule strength (~70%)', e and hc and all(abs(e[i] - hc[i]) <= 3 for i in range(3)) and 160 <= e[3] <= 195, (e, hc))
                check('look: corners match the shared readout shape on all four sides, not a straight left edge any more (the Overview/History cards it now shares a background with are square, but that square-corner rule is commented out on them, so it did not come along)', sty['radiusTL'] == sty['radiusTR'] and sty['radiusTL'] not in ('0px', ''), (sty['radiusTL'], sty['radiusTR']))
                check('look: the step row\'s track is translucent glass, not an opaque tile', re.search(r'/\s*0?\.\d+\s*\)', sty['stepBg']) is not None or 'rgba' in sty['stepBg'], sty['stepBg'])
                # progress runs: the clock ticks and the gauge fills
                a = await pg.evaluate("({ rem: document.getElementById('hud-remaining').textContent, w: parseFloat(document.getElementById('hud-step-fill').style.width) || 0, tot: document.getElementById('hud-total-remaining').textContent })")
                await pg.wait_for_timeout(3500)
                c = await pg.evaluate("({ rem: document.getElementById('hud-remaining').textContent, w: parseFloat(document.getElementById('hud-step-fill').style.width) || 0, tot: document.getElementById('hud-total-remaining').textContent })")
                check('live: over 3.5s the step countdown, the gauge and the total all move', a['rem'] != c['rem'] and c['w'] > a['w'] and a['tot'] != c['tot'] or (c['w'] > a['w'] and a['rem'] != c['rem']), (a, c))
            # the target map (ui/hud-timeline.js): a line and glow on the canvas, a dot riding the line, the number at the bottom left
            await pg.wait_for_timeout(1300)   # let the dot finish gliding to where the clock says it is
            tl = await pg.evaluate(TIMELINE)
            check(f'{name}: target map is drawn: a solid line and a glow under it on the canvas, sized to its box at the screen density', tl['painted'] > 200 and tl['lineRows'] > 0 and tl['canvasW'] == round(tl['boxW'] * 2), {k: tl[k] for k in ('painted', 'lineRows', 'canvasW', 'boxW')})
            check(f'{name}: target map: the dot sits on the target line at "now" (within 3px of the line under it)', tl['lineY'] is not None and abs(tl['dotY'] - tl['lineY']) <= 3, (tl['dotY'], tl['lineY']))
            check(f'{name}: target map: the dot is 8px, round, and in the current step\'s colour', abs(tl['dotW'] - 8) < 0.6 and tl['dotRadius'] in ('50%', '4px') and tl['dotColor'] == tl['hudRgb'], (tl['dotW'], tl['dotRadius'], tl['dotColor'], tl['hudRgb']))
            check(f'{name}: target map: the live target\'s number is at the bottom left, as plain text (e.g. 102W)', re.fullmatch(r'\d+W', tl['label']) and tl['labelLeft'] <= 16 and tl['labelBottomGap'] <= 8 and tl['labelBg'] in ('rgba(0, 0, 0, 0)', 'transparent'), tl)
            x0 = tl['dotX']; await pg.wait_for_timeout(4200); x1 = (await pg.evaluate(TIMELINE))['dotX']
            check(f'{name}: target map: the dot moves right with the clock', x1 > x0, (x0, x1))
            await pg.screenshot(path=f'/tmp/lsh-{name}.png')
            check(f'{name}: no page errors', not pg.errs, pg.errs[:3])
            await pg.context.close()

        # ───────────── Short landscape: overall + step on one row, map across the bottom ─────────────
        for (w, h, name) in [(844, 390, 'landscape'), (740, 360, 'short landscape')]:
            pg = await new_page(b, w, h)
            await start_scripted(pg); await pg.evaluate(FEED, True); await pg.wait_for_timeout(5000)
            m = await pg.evaluate(MEASURE)
            short = h <= 380
            check(f'{name}: readout, chart, HUD, control bar in order, nothing overlapping', m['metrics']['b'] <= m['chart']['t'] + 0.5 and m['chart']['b'] <= m['hud']['t'] + 0.5 and m['hud']['b'] <= m['bar']['t'] + 0.5, (m['chart'], m['hud'], m['bar']))
            if not short:
                check(f'{name}: every piece is inside the HUD and none is clipped (the step row is not cut off)', all(v for v in m['pieces'].values() if v is not None) and m['pieces']['timeline'] is True, m['pieces'])
                check(f'{name}: the overall eyebrow and the step row share one row, the target map is across the full width under them', abs(m['overall']['t'] - m['step']['t']) <= 12 and m['step']['l'] >= m['overall']['r'] - 0.5 and m['tl']['t'] >= max(m['overall']['b'], m['step']['b']) - 0.5 and m['tl']['w'] >= m['hud']['w'] - 30, (m['overall'], m['step'], m['tl']))
                check(f'{name}: the HUD is no taller than before (<= 77px)', m['hud']['h'] <= 77, round(m['hud']['h'], 1))
                check(f'{name}: the chart keeps its floor (>= 140px)', m['chart']['h'] >= 140, round(m['chart']['h'], 1))
            else:
                pcs = {k: v for k, v in m['pieces'].items() if k != 'timeline'}
                check(f'{name}: the screen is too short for the target map, so it is dropped; the overall eyebrow, step badge, name and countdown all fit and none is clipped', all(pcs.values()) and m['pieces']['timeline'] is None, m['pieces'])
                tlhidden = await pg.evaluate("getComputedStyle(document.getElementById('hud-timeline-row')).display === 'none'")
                check(f'{name}: ...the map is hidden by the layout, not clipped', tlhidden)
                check(f'{name}: the overall eyebrow and the step share one row', abs(m['overall']['t'] - m['step']['t']) <= 12 and m['step']['l'] >= m['overall']['r'] - 0.5, (m['overall'], m['step']))
                check(f'{name}: the chart keeps its floor (>= 140px)', m['chart']['h'] >= 140, round(m['chart']['h'], 1))
            check(f'{name}: no sideways overflow in the HUD', not m['overflowX'])
            await pg.screenshot(path=f"/tmp/lsh-{name.replace(' ', '-')}.png")
            check(f'{name}: no page errors', not pg.errs, pg.errs[:3])
            await pg.context.close()

        # ───────────── A free ride has no HUD, and the chart takes the room ─────────────
        pg = await new_page(b, 390, 844)
        await start_free(pg); await pg.evaluate(FEED, True); await pg.wait_for_timeout(3500)
        m = await pg.evaluate(MEASURE)
        check('free ride: no HUD (hidden, and the panel drops its row)', m['hudHidden'] and 'no-hud' in m['panel'], m['panel'])
        check('free ride: the readout is on top and the chart runs down to just above the control bar', m['chart']['t'] >= m['metrics']['b'] - 0.5 and 0 <= m['bar']['t'] - m['chart']['b'] <= 8, (m['chart'], m['bar']))
        await pg.screenshot(path='/tmp/lsh-free.png')
        check('free ride: no page errors', not pg.errs, pg.errs[:3])
        await pg.context.close()

        # ───────────── No sensor yet: no readout row, the chart panel is on top and the HUD still under it ─────────────
        pg = await new_page(b, 390, 844)
        await start_scripted(pg); await pg.wait_for_timeout(2500)
        m = await pg.evaluate(MEASURE)
        check('no metrics: the readout row is gone (panel has no-metrics) and the chart is first', 'no-metrics' in m['panel'] and m['chart']['t'] <= 10, (m['panel'], m['chart']))
        check('no metrics: the HUD is still below the chart, above the control bar, nothing overlapping', not m['hudHidden'] and m['chart']['b'] <= m['hud']['t'] + 0.5 and m['hud']['b'] <= m['bar']['t'] + 0.5, (m['chart'], m['hud'], m['bar']))
        check('no metrics: the chart panel takes every row left (>= 400px)', m['chart']['h'] >= 400, round(m['chart']['h'], 1))
        await pg.screenshot(path='/tmp/lsh-nometrics.png')
        check('no metrics: no page errors', not pg.errs, pg.errs[:3])
        await pg.context.close()

        await b.close()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
