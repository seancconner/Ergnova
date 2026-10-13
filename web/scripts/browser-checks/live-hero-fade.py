# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the live cardio readout's change-of-metric animation:
when the metric on show changes -- by swiping the chart to another page, or by a step of the All page's
rotation -- the readout (name, numeral, Average, Peak) fades in instead of snapping, and the swipe's fade is
the *same animation* as the rotation's (same keyframes, duration and easing: both go through
_replayHeroFade() in app.js and `.metrics-row-in` in style.css).

Not part of `npm test`; run by hand against a running dev server:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/live-hero-fade.py

Needs `pip install playwright` and a Chromium. Starts a free-ride Cardio Session from the FAB menu with no
sensors, then fakes power / heart rate / cadence / speed the way the app sees it (capabilities.set plus
deviceManager.update / session.pushData, via the dev-only window.__debug hooks), so no Bluetooth is involved.
Pages: 0 All, 1 Power, 2 Heart rate, 3 Cadence, 4 Speed. Prints PASS/FAIL per check.
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
  const cap = window.__debug.capabilities; cap.set('power', true); cap.set('heartRate', true); cap.set('cadence', true); cap.set('speed', true);
  let t = 0;
  window.__feed = setInterval(() => { t++;
    const d = { power: 180 + Math.round(60 * Math.sin(t / 6)) + (t % 7), heartRate: 120 + Math.min(40, t), cadence: 85 + (t % 5), speed: 28 + Math.round(3 * Math.sin(t / 8)) };
    deviceManager.update('fake', d); window.__debug.session()?.pushData?.(d); }, 250);
}"""

# Logs every animation the readout row starts, with what the readout said at that moment.
WATCH = """() => {
  const row = document.getElementById('metrics-row'); window.__fades = [];
  if (window.__fadeWatch) row.removeEventListener('animationstart', window.__fadeWatch);
  window.__fadeWatch = (e) => {
    const an = row.getAnimations().find(a => a.animationName === e.animationName), t = an && an.effect.getTiming(), cs = getComputedStyle(row);
    window.__fades.push({ anim: e.animationName, dur: t && t.duration, ease: cs.animationTimingFunction, kfEase: an && an.effect.getKeyframes().map(k => k.easing).join('|'), fill: t && t.fill,
      name: document.getElementById('stat-metric-name').textContent, value: document.getElementById('stat-current-value').textContent,
      at: Math.round(performance.now()) });
  };
  row.addEventListener('animationstart', window.__fadeWatch);
}"""
FADES = "() => window.__fades.slice()"
ROW = """() => { const row = document.getElementById('metrics-row'), r = row.getBoundingClientRect(), c = document.getElementById('chart-container').getBoundingClientRect();
  return { op: +getComputedStyle(row).opacity, anims: row.getAnimations().map(a => a.animationName), h: Math.round(r.height), y: Math.round(r.y), chartY: Math.round(c.y),
           name: document.getElementById('stat-metric-name').textContent, cls: row.className }; }"""
# Page "slots", as these checks have always numbered them: 0 = All, 1 = Power, 2 = Heart rate, 3 = Cadence,
# 4 = Speed. The dots run Heart rate, Power, Cadence, Speed (charts/chart-order.js), so a slot is looked up by
# its metric key in the carousel's own page list rather than taken as a position; where that metric has no
# page (a rig with only some sensors) the number falls back to a plain position.
GO = "(i) => { const c = window.__debug.chartCarousel(); const key = ['__overview__', 'power', 'heartRate', 'cadence', 'speed'][i]; const at = key ? c.pageKeys.indexOf(key) : -1; const t = document.querySelector('.chart-track'); t.scrollTo({ left: t.clientWidth * (at < 0 ? i : at), behavior: 'instant' }); }"

async def start_free_ride(pg):
    await pg.goto(BASE, wait_until='load'); await pg.wait_for_timeout(1500)
    await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.getElementById('fab-menu-cardio').click()"); await pg.wait_for_timeout(800)
    await pg.evaluate("document.getElementById('qs-finish').click()"); await pg.wait_for_timeout(1300)

async def new_page(b, **kw):
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, **kw)
    pg = await ctx.new_page(); pg.errs = []
    pg.on('pageerror', lambda e: pg.errs.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and pg.errs.append('console: ' + m.text))
    return pg

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()

        # ───────────────────────── A swipe to another chart fades the readout in ─────────────────────────
        pg = await new_page(b)
        await start_free_ride(pg); await pg.evaluate(FEED, True); await pg.wait_for_timeout(4500)
        await pg.evaluate(GO, 2); await pg.wait_for_timeout(1000)          # Heart rate page, settled
        await pg.evaluate(WATCH)
        steady0 = await pg.evaluate(ROW)
        check('settled on a page: no animation is running on the readout', steady0['anims'] == [] and steady0['op'] == 1, steady0)

        base = await pg.evaluate(ROW)
        await pg.evaluate(GO, 3); await pg.wait_for_timeout(110)           # Heart rate -> Cadence
        mid = await pg.evaluate(ROW); await pg.wait_for_timeout(700); end = await pg.evaluate(ROW)
        f1 = await pg.evaluate(FADES)
        check('swiping to the next chart plays one fade on the readout', len(f1) == 1 and f1[0]['anim'] == 'fadeIn', f1)
        check('the fade is .35s ease (opacity 0 to 1)', f1 and f1[0]['dur'] == 350 and f1[0]['ease'] == 'ease', f1)
        check('the readout already says the new metric when the fade starts (it fades in, not out and back)', f1 and f1[0]['name'] == 'Cadence', f1)
        check('part-way through, the readout is part-faded; afterwards it is solid and nothing is running',
              0 < mid['op'] < 1 and end['op'] == 1 and end['anims'] == [], (mid['op'], end['op'], end['anims']))
        check('the animation is opacity only: the readout and the chart do not move (same height and y, chart y)',
              (base['h'], base['y'], base['chartY']) == (mid['h'], mid['y'], mid['chartY']) == (end['h'], end['y'], end['chartY']), (base, mid, end))

        # swipe back, and on to the ends
        await pg.evaluate(GO, 2); await pg.wait_for_timeout(900)
        await pg.evaluate(GO, 1); await pg.wait_for_timeout(900)
        await pg.evaluate(GO, 4); await pg.wait_for_timeout(900)
        f2 = await pg.evaluate(FADES)
        check('every swipe to a different chart fades once (Cadence, Heart Rate, Power, Speed)',
              [f['name'] for f in f2] == ['Cadence', 'Heart Rate', 'Power', 'Speed'] and all(f['anim'] == 'fadeIn' and f['dur'] == 350 and f['ease'] == 'ease' for f in f2),
              [(f['name'], f['anim'], f['dur']) for f in f2])

        # value ticks alone do not animate
        n = len(await pg.evaluate(FADES)); await pg.wait_for_timeout(1600)
        idle = await pg.evaluate(ROW)
        check('live value ticks on the same chart do not replay the fade', len(await pg.evaluate(FADES)) == n and idle['anims'] == [], (n, idle['anims']))

        # ───────────────────────── The All page's rotation uses the very same animation ─────────────────────────
        await pg.evaluate(GO, 0); await pg.wait_for_timeout(500)          # Speed -> All: the hero opens on Heart rate, so it changes
        arrive = await pg.evaluate(FADES)
        await pg.wait_for_timeout(4200)                                    # one rotation step (3.5s)
        allf = await pg.evaluate(FADES)
        rot = allf[len(arrive):]
        check('arriving on the All page from another chart fades (the hero opens on Heart Rate, which differs from Speed)', arrive and arrive[-1]['name'] == 'Heart Rate' and arrive[-1]['anim'] == 'fadeIn', arrive[-2:])
        check('a rotation step on the All page fades too', len(rot) >= 1 and rot[0]['anim'] == 'fadeIn' and rot[0]['name'] == 'Power', rot)
        swipe_sig = (f2[0]['anim'], f2[0]['dur'], f2[0]['ease'], f2[0]['kfEase'], f2[0]['fill']); rot_sig = (rot[0]['anim'], rot[0]['dur'], rot[0]['ease'], rot[0]['kfEase'], rot[0]['fill']) if rot else None
        check('the rotation\'s animation and the swipe\'s are identical (same keyframes, duration, easing, fill)', swipe_sig == rot_sig, (swipe_sig, rot_sig))
        css = await pg.evaluate("""() => { const kf = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } }).filter(r => r.type === CSSRule.KEYFRAMES_RULE && r.name === 'fadeIn');
                                          return { count: kf.length, text: kf[0] && kf[0].cssText.replace(/\\s+/g, ' ') }; }""")
        check('both use the one fadeIn keyframes rule', css['count'] == 1, css)

        # arriving on the All page when the hero is already on the same metric changes nothing, so nothing fades
        await pg.evaluate(GO, 2); await pg.wait_for_timeout(900)           # -> Heart rate
        before = len(await pg.evaluate(FADES))
        await pg.evaluate(GO, 0); await pg.wait_for_timeout(700)           # -> All: the hero opens on Heart rate: same metric
        check('Heart Rate -> All shows Heart Rate either way, so nothing fades', len(await pg.evaluate(FADES)) == before, (before, len(await pg.evaluate(FADES))))

        # a quick double swipe lands on the last one and does not break anything
        await pg.evaluate(GO, 2); await pg.wait_for_timeout(60); await pg.evaluate(GO, 3); await pg.wait_for_timeout(900)
        quick = await pg.evaluate(ROW)
        check('two quick swipes end on the last chart, readout solid, no animation left running', quick['name'] == 'Cadence' and quick['op'] == 1 and quick['anims'] == [], quick)
        check('no page errors', not pg.errs, pg.errs[:3])
        await pg.context.close()

        # ───────────────────────── Reduced motion: no animation, same final readout ─────────────────────────
        pg = await new_page(b)
        await pg.emulate_media(reduced_motion='reduce')
        await start_free_ride(pg); await pg.evaluate(FEED, True); await pg.wait_for_timeout(4500)
        await pg.evaluate(GO, 1); await pg.wait_for_timeout(900); await pg.evaluate(WATCH)
        await pg.evaluate(GO, 2); await pg.wait_for_timeout(100)
        rm = await pg.evaluate(ROW)
        check('reduced motion: switching charts changes the readout with no animation at all', rm['name'] == 'Heart Rate' and rm['anims'] == [] and rm['op'] == 1, rm)
        check('no page errors (reduced motion)', not pg.errs, pg.errs[:3])
        await pg.context.close()

        await b.close()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
