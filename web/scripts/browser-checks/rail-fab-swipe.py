# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the rail's "+" (FAB) during a tab swipe: it glides and resizes from its box in the
outgoing rail to its box in the incoming one with the finger, lands exactly where the incoming rail holds
it (no teleport), and the incoming rail does not jump when it arrives.

Not part of `npm test`; run by hand against a running dev server:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/rail-fab-swipe.py

Needs `pip install playwright` and a Chromium. Drives the swipe with the mouse (setupSwipeNav handles
mouse drags exactly like touches) at 390x844 and records the FAB's box every animation frame through the
release and settle. Prints PASS/FAIL per check.
"""
import os, asyncio
from playwright.async_api import async_playwright

BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

FAB = """() => { const f = document.getElementById('fab-start-btn'); const r = f.getBoundingClientRect();
  const slot = f.closest('.md-rail-fab-slot'); const rail = f.closest('.md-rail');
  return { x: r.x, y: r.y, w: r.width, h: r.height, flying: !!f.closest('.fab-flight'), rail: rail && rail.dataset.railFor,
           layers: document.querySelectorAll('.fab-flight').length, inSlot: !!slot }; }"""

# Records the FAB (and the incoming rail's toggle/first item, to prove the rail itself does not jump) every frame.
REC_START = """(railFor) => { window.__rec = []; window.__recOn = true;
  const tick = () => { if (!window.__recOn) return;
    const f = document.getElementById('fab-start-btn'); const r = f.getBoundingClientRect();
    const rail = document.querySelector(`.md-rail[data-rail-for="${railFor}"]`); let it = null;
    if (rail && !rail.classList.contains('hidden')) { const e = rail.querySelector('.md-rail-toggle') || rail.querySelector('.md-rail-fab-slot'); const b = e.getBoundingClientRect(); it = { y: b.y, w: b.width }; }
    window.__rec.push({ t: performance.now(), x: r.x, y: r.y, w: r.width, h: r.height, flying: !!f.closest('.fab-flight'), rail: f.closest('.md-rail')?.dataset.railFor || null, it });
    requestAnimationFrame(tick); };
  requestAnimationFrame(tick); }"""
REC_STOP = "() => { window.__recOn = false; return window.__rec; }"

async def goto_tab(pg, t):
    await pg.evaluate(f"document.querySelector('.tab-bar [data-tab=\"{t}\"]').click()"); await pg.wait_for_timeout(500)

async def drag(pg, x0, dx, steps=6, release=True):
    await pg.mouse.move(x0, 400); await pg.mouse.down()
    await pg.mouse.move(x0 + dx, 400, steps=steps); await pg.wait_for_timeout(80)
    if release: await pg.mouse.up()

def close(a, b, tol=0.6): return abs(a - b) <= tol

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844})
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errs.append('console: ' + m.text))
        await pg.goto(BASE, wait_until='load'); await pg.wait_for_timeout(1500)

        rest = {}
        for t in ('overview', 'history', 'diet', 'settings'):
            await goto_tab(pg, t); rest[t] = await pg.evaluate(FAB)
        check('at rest the FAB sits in every tab\'s rail slot, not in flight', all(r['inSlot'] and not r['flying'] and r['layers'] == 0 for r in rest.values()), rest)
        check('premise: Overview\'s FAB (48x48, bottom) differs from the other tabs\' (60x56, above the toggle)',
              rest['overview']['w'] < rest['history']['w'] and rest['overview']['y'] > rest['history']['y'], (rest['overview'], rest['history']))

        # ── Overview -> History: committed swipe ─────────────────────────────────────
        await goto_tab(pg, 'overview')
        o, h = rest['overview'], rest['history']
        await pg.mouse.move(300, 400); await pg.mouse.down(); await pg.mouse.move(300 - 100, 400, steps=5); await pg.wait_for_timeout(80)
        mid = await pg.evaluate(FAB)
        check('mid-drag: the FAB is in the flight layer (one layer), not in a rail', mid['flying'] and mid['layers'] == 1 and mid['rail'] is None, mid)
        frac = 100 / 390
        check('mid-drag: it has moved the same share of the way to the History rail as the finger has of the screen (y)',
              close(mid['y'], o['y'] + (h['y'] - o['y']) * frac, 1.5), (mid['y'], o['y'] + (h['y'] - o['y']) * frac))
        check('mid-drag: and grown the same share (width 48 -> 60, height 48 -> 56)',
              close(mid['w'], o['w'] + (h['w'] - o['w']) * frac, 1.0) and close(mid['h'], o['h'] + (h['h'] - o['h']) * frac, 1.0), (mid['w'], mid['h']))
        await pg.mouse.move(300 - 260, 400, steps=5); await pg.wait_for_timeout(80)
        far = await pg.evaluate(FAB)
        check('further in, it is further along (y smaller, wider) -- it tracks the finger', far['y'] < mid['y'] and far['w'] > mid['w'], (mid, far))
        await pg.evaluate(REC_START, 'history')
        await pg.mouse.up(); await pg.wait_for_timeout(700)
        rec = await pg.evaluate(REC_STOP)
        fin = await pg.evaluate(FAB)
        check('after release it lands in History\'s rail slot at exactly History\'s resting box', fin['rail'] == 'history' and not fin['flying'] and fin['layers'] == 0
              and close(fin['x'], h['x']) and close(fin['y'], h['y']) and close(fin['w'], h['w']) and close(fin['h'], h['h']), fin)
        flying = [r for r in rec if r['flying']]
        landed = [r for r in rec if not r['flying'] and r['rail'] == 'history']
        check('the settle is animated (several frames in flight) and ends with the FAB in History\'s rail', len(flying) >= 4 and landed, (len(flying), len(landed)))
        jump = max((max(abs(a['y'] - c['y']), abs(a['w'] - c['w']), abs(a['h'] - c['h'])) for a, c in zip(rec, rec[1:])), default=0)
        check('no frame-to-frame jump anywhere in the settle larger than ~12px (it eases; no teleport)', jump <= 12, round(jump, 1))
        hand = None
        for a, c in zip(rec, rec[1:]):
            if a['flying'] and not c['flying']: hand = (a, c)
        check('the hand-off from the flight layer to the rail slot is seamless (same box, <= 0.6px)',
              hand is None or all(close(hand[0][k], hand[1][k]) for k in ('x', 'y', 'w', 'h')), hand)
        its = [r['it'] for r in rec if r['it']]
        check('the incoming rail does not jump when it arrives (its toggle row keeps its position through the last frames)',
              its and abs(its[-1]['y'] - its[-4]['y']) <= 0.6 and abs(its[-1]['w'] - its[-4]['w']) <= 0.6, its[-4:] if its else None)

        # ── History -> Diet: identical boxes, so the FAB must not move at all ───────
        await goto_tab(pg, 'history')
        await pg.evaluate(REC_START, 'diet')
        await drag(pg, 300, -240); await pg.wait_for_timeout(700)
        rec = await pg.evaluate(REC_STOP)
        cy = [r['y'] + r['h'] / 2 for r in rec]
        span = max(cy) - min(cy), max(r['w'] for r in rec) - min(r['w'] for r in rec), max(r['x'] for r in rec) - min(r['x'] for r in rec)
        check('History -> Diet (same box in both rails): the FAB does not slide or change width, it folds about its own centre', span[0] <= 0.6 and span[1] <= 0.6 and span[2] <= 0.6 and (await pg.evaluate(FAB))['rail'] == 'diet', span)
        fl = [r for r in rec if r['flying']]
        check('History -> Diet: its height dips through the settle (the fold) and is full again on landing', fl and min(r['h'] for r in fl) < 0.8 * h['h'] and abs(rec[-1]['h'] - h['h']) <= 0.6, (min(r['h'] for r in fl) if fl else None, rec[-1]['h']))
        its = [r['it'] for r in rec if r['it']]
        check('History -> Diet: the incoming rail\'s toggle row is settled for the last frames before it lands', len(its) > 4 and max(i['y'] for i in its[-4:]) - min(i['y'] for i in its[-4:]) <= 0.6, its[-4:])

        # ── The fold, held at fixed points of a drag (History -> Diet) ───────────────
        await goto_tab(pg, 'history')
        FOLD = "() => { const f = document.getElementById('fab-start-btn'); const l = f.closest('.fab-flight'); const r = f.getBoundingClientRect(); return { h: r.height, op: parseFloat(getComputedStyle(f).opacity), layerOp: l ? parseFloat(getComputedStyle(l).opacity) : 1, blur: getComputedStyle(f).backdropFilter, fold: !!l && l.classList.contains('fab-fold') }; }"
        await pg.mouse.move(300, 400); await pg.mouse.down()
        pts = {}
        for name, dx in (('quarter', -97), ('half', -195), ('threeq', -292)):
            await pg.mouse.move(300 + dx, 400, steps=6); await pg.wait_for_timeout(100); pts[name] = await pg.evaluate(FOLD)
        check('fold: a quarter in it is partly folded and faded; halfway it is at its smallest; three quarters in it is growing back',
              pts['quarter']['fold'] and pts['half']['h'] < pts['quarter']['h'] < h['h'] and pts['threeq']['h'] > pts['half']['h'] and pts['half']['op'] < pts['quarter']['op'] < 1 and pts['threeq']['op'] > pts['half']['op'], pts)
        check('fold: the fade is on the button, not the layer (an ancestor with opacity < 1 would drop the button\'s backdrop blur), and the blur stays set',
              all(p['layerOp'] == 1 and p['blur'] not in ('none', '') for p in pts.values()), pts)
        check('fold: halfway it is nearly gone but not quite (still the same button)', 0 < pts['half']['op'] <= 0.25 and pts['half']['h'] > 0, pts['half'])
        await pg.mouse.move(300, 400, steps=8); await pg.wait_for_timeout(100)
        back0 = await pg.evaluate(FOLD)
        check('fold: dragged back to the start it is full size and fully visible again', abs(back0['h'] - h['h']) <= 0.6 and back0['op'] >= 0.99, back0)
        await pg.mouse.up(); await pg.wait_for_timeout(600)
        # Overview -> History must still glide, not fold
        await goto_tab(pg, 'overview')
        await pg.mouse.move(300, 400); await pg.mouse.down(); await pg.mouse.move(200, 400, steps=5); await pg.wait_for_timeout(100)
        gl = await pg.evaluate(FOLD)
        check('Overview -> History still glides (different boxes): no fold, fully opaque', not gl['fold'] and gl['op'] >= 0.99, gl)
        await pg.mouse.up(); await pg.wait_for_timeout(600)

        # ── Cancelled swipe: back where it started ─────────────────────────────────
        await goto_tab(pg, 'overview')
        await drag(pg, 300, -30); await pg.wait_for_timeout(700)   # under the 40px flick distance and the commit fraction
        c = await pg.evaluate(FAB)
        check('a short drag that snaps back (30px) returns the FAB to Overview\'s rail at its own box, layer gone',
              c['rail'] == 'overview' and not c['flying'] and c['layers'] == 0 and close(c['x'], o['x']) and close(c['y'], o['y']) and close(c['w'], o['w']) and close(c['h'], o['h']), c)

        # ── Change of mind mid-drag: left toward Diet, then back past the start toward Overview ──
        await goto_tab(pg, 'history')
        await pg.mouse.move(200, 400); await pg.mouse.down()
        await pg.mouse.move(120, 400, steps=4); await pg.wait_for_timeout(60)
        left = await pg.evaluate(FAB)
        await pg.mouse.move(300, 400, steps=8); await pg.wait_for_timeout(80)
        right = await pg.evaluate(FAB)
        check('dragging past the start the other way retargets: heading to Overview\'s box (smaller, lower) while still one flight',
              right['flying'] and right['layers'] == 1 and right['w'] < h['w'] and right['y'] > h['y'], (left, right))
        await pg.mouse.move(200, 400, steps=4); await pg.wait_for_timeout(80)
        back = await pg.evaluate(FAB)
        check('and back at the start point it is exactly back at History\'s box', close(back['y'], h['y']) and close(back['w'], h['w']) and back['flying'], back)
        await pg.mouse.up(); await pg.wait_for_timeout(600)
        e = await pg.evaluate(FAB)
        check('released there, it settles in History\'s rail', e['rail'] == 'history' and not e['flying'] and e['layers'] == 0 and close(e['y'], h['y']), e)

        # ── No neighbour: the edge-resistance drag never lifts the FAB ───────────────
        await goto_tab(pg, 'overview')
        await drag(pg, 150, 120, release=False)
        edge = await pg.evaluate(FAB)
        check('dragging right on the first tab (nothing to peek): the FAB stays in its rail', not edge['flying'] and edge['layers'] == 0 and edge['rail'] == 'overview', edge)
        await pg.mouse.up(); await pg.wait_for_timeout(500)

        # ── Programmatic tab change mid-drag aborts cleanly ─────────────────────────
        await goto_tab(pg, 'overview')
        await drag(pg, 300, -150, release=False)
        await pg.evaluate("window.__debug.switchTab('settings')"); await pg.wait_for_timeout(500)
        ab = await pg.evaluate(FAB)
        check('a programmatic tab change in the middle of a drag: no layer left behind, FAB in Settings\' rail', ab['layers'] == 0 and not ab['flying'] and ab['rail'] == 'settings' and ab['inSlot'], ab)
        await pg.mouse.up(); await pg.wait_for_timeout(300)

        # ── It still works afterwards ───────────────────────────────────────────────
        await goto_tab(pg, 'history'); await drag(pg, 300, -250); await pg.wait_for_timeout(600)
        await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(400)
        opened = await pg.evaluate("!document.getElementById('fab-menu').classList.contains('hidden')")
        check('after a swipe the FAB still opens its menu', opened)
        await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)

        # ── Reduced motion: lands at once, nothing left in the air ─────────────────
        await pg.emulate_media(reduced_motion='reduce')
        await goto_tab(pg, 'overview'); await drag(pg, 300, -250); await pg.wait_for_timeout(400)
        rm = await pg.evaluate(FAB)
        check('reduced motion: the swipe lands with no flight left, FAB in History\'s rail at its box', rm['rail'] == 'history' and rm['layers'] == 0 and not rm['flying'] and close(rm['y'], h['y']) and close(rm['w'], h['w']), rm)
        await pg.emulate_media(reduced_motion='no-preference')

        # ── Narrow phone (rails are 48px everywhere) ───────────────────────────────
        await pg.set_viewport_size({'width': 340, 'height': 640}); await pg.wait_for_timeout(400)
        await goto_tab(pg, 'overview'); n0 = await pg.evaluate(FAB)
        await drag(pg, 280, -200); await pg.wait_for_timeout(600)
        n1 = await pg.evaluate(FAB)
        await goto_tab(pg, 'history'); n2 = await pg.evaluate(FAB)
        check('340px wide: the swipe lands the FAB at the same box a tap on the tab does', n1['rail'] == 'history' and n1['layers'] == 0 and close(n1['y'], n2['y']) and close(n1['w'], n2['w']) and close(n1['x'], n2['x']), (n0, n1, n2))
        await pg.screenshot(path='/tmp/rail-fab-340.png')

        # ── Tapping a tab button: the same animation, at one fixed speed ───────────────────────────────
        await pg.set_viewport_size({'width': 390, 'height': 844}); await pg.wait_for_timeout(300)
        TAPREC = """(target) => { window.__rec = []; window.__recOn = true;
          const tick = () => { if (!window.__recOn) return;
            const f = document.getElementById('fab-start-btn'); const r = f.getBoundingClientRect();
            const p = document.querySelector(`[data-panel="${target}"]`); const m = new DOMMatrix(getComputedStyle(p).transform);
            window.__rec.push({ t: performance.now(), flying: !!f.closest('.fab-flight'), y: r.y, w: r.width, tx: m.m41, hidden: p.classList.contains('hidden'), rail: f.closest('.md-rail')?.dataset.railFor || null });
            requestAnimationFrame(tick); };
          requestAnimationFrame(tick); }"""
        async def tap_record(frm, to, wait=700):
            await goto_tab(pg, frm)
            await pg.evaluate(TAPREC, to)
            await pg.click(f'.tab-bar [data-tab="{to}"]'); await pg.wait_for_timeout(wait)
            return await pg.evaluate(REC_STOP)
        def span_ms(rec, key='flying'):
            ts = [r['t'] for r in rec if r[key]]
            return (ts[-1] - ts[0]) if len(ts) > 1 else 0
        r1 = await tap_record('overview', 'history')
        d1 = span_ms(r1)
        ys = [r['y'] for r in r1 if r['flying']]
        check('tap Overview -> History: the FAB flies for a settle (about 240ms), landing in History\'s rail', 180 <= d1 <= 340 and r1[-1]['rail'] == 'history' and not r1[-1]['flying'], (round(d1), r1[-1]))
        check('tap: it glides from Overview\'s box to History\'s, frame by frame (monotonic, several frames)', len(ys) >= 6 and all(a >= b - 0.01 for a, b in zip(ys, ys[1:])) and ys[0] > 700 and ys[-1] < 690, (len(ys), ys[:2], ys[-2:]))
        txs = [r['tx'] for r in r1 if not r['hidden'] and r['tx'] > 0.5]
        check('tap: the panel slides in across the screen (not the old 18px nudge): it travels a full width in several frames', len(txs) >= 5 and max(txs) > 300, (len(txs), max(txs) if txs else None))
        r2 = await tap_record('overview', 'settings')
        d2 = span_ms(r2)
        check('tap Overview -> Settings (three tabs away): same speed as one tab away (within 60ms)', abs(d1 - d2) <= 60 and r2[-1]['rail'] == 'settings', (round(d1), round(d2)))
        r3 = await tap_record('settings', 'history')
        d3 = span_ms(r3)
        check('tap Settings -> History (going back): same speed again', abs(d1 - d3) <= 60 and r3[-1]['rail'] == 'history', (round(d1), round(d3)))
        # a second tap while the first is still landing: it lands, then the second plays; ends on the last tab, nothing left behind
        await goto_tab(pg, 'overview')
        await pg.click('.tab-bar [data-tab="settings"]'); await pg.wait_for_timeout(90)
        await pg.click('.tab-bar [data-tab="history"]'); await pg.wait_for_timeout(700)
        qq = await pg.evaluate(FAB)
        act = await pg.evaluate("document.querySelector('.tab-bar [data-tab].active').dataset.tab")
        check('two quick taps: ends on the last one, FAB in its rail, no layer left', act == 'history' and qq['rail'] == 'history' and qq['layers'] == 0 and not qq['flying'], (act, qq))
        # tapping the tab you are on does nothing
        await pg.click('.tab-bar [data-tab="history"]'); await pg.wait_for_timeout(100)
        same = await pg.evaluate(FAB)
        check('tapping the current tab starts no animation', not same['flying'] and same['layers'] == 0, same)
        # an open FAB menu is an overlay: the tap falls back to the plain instant switch
        await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
        await pg.evaluate(TAPREC, 'diet')
        await pg.evaluate("document.querySelector('.tab-bar [data-tab=\"diet\"]').click()"); await pg.wait_for_timeout(400)
        r4 = await pg.evaluate(REC_STOP)
        check('with the FAB menu open the tap is the plain switch: no flight', not any(r['flying'] for r in r4), len([r for r in r4 if r['flying']]))
        await pg.evaluate("document.getElementById('fab-menu').classList.contains('hidden') || document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
        # reduced motion: instant
        await pg.emulate_media(reduced_motion='reduce')
        r5 = await tap_record('overview', 'history', wait=400)
        check('reduced motion: a tap switches at once, nothing flies', not any(r['flying'] for r in r5) and r5[-1]['rail'] == 'history', len([r for r in r5 if r['flying']]))
        await pg.emulate_media(reduced_motion='no-preference')

        check('no page errors', not errs, errs[:3])
        await b.close()
    bad = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(bad)}/{len(results)} passed')
    raise SystemExit(1 if bad else 0)

asyncio.run(main())
