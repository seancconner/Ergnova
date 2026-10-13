# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks that the live metric cards and the chart's corner badges share the stat chip's
readout look.

Not part of `npm test`; run it by hand against a running app:

    npm run dev                                  # or: npx vite preview
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/readout-look.py

Needs `pip install playwright` and a Chromium. Starts a free-ride Cardio Session from the FAB menu
with no sensors, fakes sensor data the way the app sees it (capabilities.set plus
deviceManager.update / session.pushData, via the dev-only window.__debug hooks — same as
live-cardio-hero.py), then compares computed styles of the live Current/Average/Peak cards and the
Zone/Calories/Distance/Pace badges against a probe .stat-chip of the same metric:

  - the rule is a real 2px border-left at the same colour/alpha (no ::before bar), straight on the
    left and soft on the right; no drop shadow; the Metric wash is the same gradient;
  - the digits are --text-primary, never the metric colour;
  - the Zone badge's rule follows the rider's zone (its colour is set per sample);
  - a readout with no metric takes the chip's neutral (--text-secondary);
  - retuning --metric-rule-alpha / --metric-wash-alpha in :root moves the chip, the cards and the
    badges together (they share one recipe, not four copies of it);
  - at 390x844 and 320x640 the badge row stays inside the chart panel with no sideways overflow, and
    nothing changes the page's scroll width.
Prints PASS/FAIL per check; screenshots go to /tmp/readout-*.png.
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
    const d = { power: window.__power ?? (180 + Math.round(60 * Math.sin(t / 6)) + (t % 7)), heartRate: 120 + Math.min(40, t), cadence: 85 + (t % 5), speed: 28 + (t % 3) };
    deviceManager.update('fake', d); window.__debug.session()?.pushData?.(d); }, 250);
}"""

# The look of one element, as the browser resolved it. `probe` builds a temporary .stat-chip.
LOOK = """(sel) => { const e = document.querySelector(sel); if (!e) return null; const cs = getComputedStyle(e);
  return { blw: cs.borderLeftWidth, bls: cs.borderLeftStyle, blc: cs.borderLeftColor,
           tl: cs.borderTopLeftRadius, bl: cs.borderBottomLeftRadius, tr: cs.borderTopRightRadius,
           shadow: cs.boxShadow, bgimg: cs.backgroundImage, before: getComputedStyle(e, '::before').content } }"""
PROBE = """(attrs) => { document.querySelectorAll('.__probe').forEach(n => n.remove());
  const e = document.createElement('div'); e.className = 'stat-chip __probe'; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.innerHTML = '<span class="stat-val">1</span><span class="stat-lbl">x</span>'; e.style.cssText = 'position:fixed;left:0;top:0;opacity:.01;pointer-events:none';
  document.body.appendChild(e); return true; }"""

async def start_live(pg):
    await pg.goto(BASE, wait_until='load'); await pg.wait_for_timeout(1500)
    await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.getElementById('fab-menu-cardio').click()"); await pg.wait_for_timeout(800)
    await pg.evaluate("document.getElementById('qs-finish').click()"); await pg.wait_for_timeout(1300)
    await pg.evaluate(FEED, True); await pg.wait_for_timeout(5000)

def same_look(a, b, ignore=()):
    keys = [k for k in ('blw', 'bls', 'blc', 'tl', 'bl', 'shadow', 'bgimg', 'before') if k not in ignore]
    return all(a[k] == b[k] for k in keys), {k: (a[k], b[k]) for k in keys if a[k] != b[k]}

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for width, height in [(390, 844), (320, 640)]:
            ctx = await b.new_context(viewport={"width": width, "height": height}, device_scale_factor=2)
            pg = await ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: m.type == "error" and 'Failed to load resource' not in m.text and errs.append("console: " + m.text))
            tag = f'{width}px'
            await start_live(pg)
            await pg.screenshot(path=f'/tmp/readout-{width}.png')
            sw0 = await pg.evaluate("document.documentElement.scrollWidth")

            # ---- metric cards vs a power chip
            await pg.evaluate(PROBE, {'data-metric': 'power'})
            chip = await pg.evaluate(LOOK, '.__probe')
            hero = await pg.evaluate(LOOK, '#metrics-row .metric-card-hero')
            pair = await pg.evaluate(LOOK, '#metrics-row .metric-card-pair')
            for name, el in (('hero (Current)', hero), ('pair (Average/Peak)', pair)):
                ok, diff = same_look(el, chip)
                check(f'{tag}: {name} card has the chip\'s rule, wash and no shadow/::before', ok, diff)
            check(f'{tag}: cards share the readout\'s soft corner on every side (the same non-zero radius on the left and the right; they are no longer straight on the left)', hero['tl'] == hero['bl'] == hero['tr'] == pair['tl'] == pair['tr'] and hero['tl'] not in ('0px', ''), (hero['tl'], hero['tr'], pair['tr']))
            check(f'{tag}: the rule is a real 2px border at the shared alpha', chip['blw'] == '2px' and chip['bls'] == 'solid' and '/ 0.7' in chip['blc'], chip['blc'])
            dig = await pg.evaluate("""() => { const pc = getComputedStyle(document.body).color; const c = s => getComputedStyle(document.querySelector(s)).color;
               return { primary: pc, hero: c('#stat-current-value'), avg: c('#stat-average-value'), peak: c('#stat-peak-value') } }""")
            check(f'{tag}: card digits are --text-primary, not the metric colour', dig['hero'] == dig['primary'] == dig['avg'] == dig['peak'], dig)

            # ---- badges vs chips of the same metric
            badges = await pg.evaluate("[...document.querySelectorAll('.chart-badge-item')].filter(e => e.offsetParent).map(e => e.dataset.badge)")
            check(f'{tag}: the four corner badges are on screen', set(['zone', 'calories', 'distance', 'pace']) <= set(badges), badges)
            for key, metric in (('calories', 'calories'), ('distance', 'distance'), ('pace', 'distance')):
                await pg.evaluate(PROBE, {'data-metric': metric})
                chip = await pg.evaluate(LOOK, '.__probe')
                bl = await pg.evaluate(LOOK, f'.chart-badge-item[data-badge="{key}"]')
                ok, diff = same_look(bl, chip)
                check(f'{tag}: {key} badge has the {metric} chip\'s rule, wash and no shadow/::before', ok, diff)
            bv = await pg.evaluate("""() => [...document.querySelectorAll('.chart-badge-item')].filter(e => e.offsetParent).map(e => getComputedStyle(e.querySelector('.chart-badge-value')).color)""")
            pc = await pg.evaluate("getComputedStyle(document.body).color")
            check(f'{tag}: badge digits are --text-primary', bv and all(c == pc for c in bv), bv)
            back = await pg.evaluate("(() => { const cs = getComputedStyle(document.querySelector('.chart-badge-item')); return { bg: cs.backgroundColor, blur: cs.backdropFilter }; })()")
            # The badge has no backing panel -- the wash is the only fill, so it
            # can fade to nothing like a stat chip's. A scrim or blur here would bring the dark box back.
            check(f'{tag}: a badge has no backing fill or blur, so its wash fades out completely', back['bg'] in ('rgba(0, 0, 0, 0)', 'transparent') and back['blur'] in ('none', ''), back)
            # Same for the live cards (hero + Average/Peak): they used to sit on an opaque --bg-raised tile,
            # then a glass tile with blur, and either one left a visible panel at the card's far edge.
            cards_back = await pg.evaluate("""() => [...document.querySelectorAll('#metrics-row .metric-card')].map(e => { const cs = getComputedStyle(e);
                return { cls: e.className, bg: cs.backgroundColor, blur: cs.backdropFilter || cs.webkitBackdropFilter || 'none' }; })""")
            check(f'{tag}: the live cards have no backing fill or blur either (hero and both pair cards)', len(cards_back) == 3 and all(c['bg'] in ('rgba(0, 0, 0, 0)', 'transparent') and c['blur'] in ('none', '') for c in cards_back), cards_back)

            # ---- Zone follows the rider's zone
            z1 = await pg.evaluate(LOOK, '.chart-badge-item[data-badge="zone"]')
            await pg.evaluate("window.__power = 420"); await pg.wait_for_timeout(1500)
            z2 = await pg.evaluate(LOOK, '.chart-badge-item[data-badge="zone"]')
            await pg.evaluate("window.__power = null")
            check(f'{tag}: the Zone badge\'s rule changes colour with the rider\'s zone', z1['blc'] != z2['blc'] and z1['blw'] == z2['blw'] == '2px', (z1['blc'], z2['blc']))

            # ---- one recipe, not four copies: retune the token and everything moves together
            await pg.evaluate(PROBE, {'data-metric': 'power'})
            before = await pg.evaluate("""() => [ '.__probe', '#metrics-row .metric-card-hero', '.chart-badge-item[data-badge="calories"]' ].map(s => getComputedStyle(document.querySelector(s)).borderLeftColor)""")
            await pg.evaluate("document.documentElement.style.setProperty('--metric-rule-alpha', '30%'); document.documentElement.style.setProperty('--metric-wash-alpha', '50%')")
            await pg.wait_for_timeout(200)
            after = await pg.evaluate("""() => [ '.__probe', '#metrics-row .metric-card-hero', '.chart-badge-item[data-badge="calories"]' ].map(s => getComputedStyle(document.querySelector(s)).borderLeftColor)""")
            washes = await pg.evaluate("""() => [ '.__probe', '#metrics-row .metric-card-hero', '.chart-badge-item[data-badge="calories"]' ].map(s => getComputedStyle(document.querySelector(s)).backgroundImage)""")
            check(f'{tag}: lowering --metric-rule-alpha lowers the rule on the chip, the card and the badge', all('/ 0.3' in a and a != bf for a, bf in zip(after, before)), after)
            check(f'{tag}: raising --metric-wash-alpha strengthens all three washes', all('0.5)' in w for w in washes), [w[:90] for w in washes])
            await pg.evaluate("document.documentElement.style.removeProperty('--metric-rule-alpha'); document.documentElement.style.removeProperty('--metric-wash-alpha')")

            # ---- layout: badges stay inside the chart panel, nothing overflows sideways
            lay = await pg.evaluate("""() => { const c = document.querySelector('#chart-container').getBoundingClientRect();
               // The carousel keeps every chart page laid out side by side, so badges of the pages swiped
               // off to the right have boxes too; only the ones overlapping the panel can be seen.
               const bs = [...document.querySelectorAll('.chart-badge-item')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect())
                 .filter(r => r.left < c.right && r.right > c.left);
               return { n: bs.length, inside: bs.length >= 4 && bs.every(r => r.left >= c.left - 1 && r.right <= c.right + 1), minLeft: Math.min(...bs.map(r => r.left)) - c.left, sw: document.documentElement.scrollWidth, vw: innerWidth } }""")
            check(f'{tag}: the four visible badges stay inside the chart panel', lay['inside'], lay)
            check(f'{tag}: the page does not scroll sideways, and nothing widened it', lay['sw'] <= lay['vw'] and lay['sw'] == sw0, (sw0, lay['sw'], lay['vw']))

            # ---- strength rest badge: no metric -> the chip's neutral
            await pg.evaluate("document.querySelectorAll('.__probe').forEach(n => n.remove())")
            await pg.evaluate(PROBE, {})
            neutral = await pg.evaluate(LOOK, '.__probe')
            await pg.evaluate("""() => { const e = document.createElement('div'); e.className = 'chart-badge-item __rest'; e.innerHTML = '<span class="chart-badge-value">0:00</span><span class="chart-badge-label">Rest</span>'; e.style.cssText = 'position:fixed;left:0;top:60px;opacity:.01'; document.body.appendChild(e); }""")
            rest = await pg.evaluate(LOOK, '.__rest')
            ok, diff = same_look(rest, neutral)
            check(f'{tag}: a badge with no metric (Rest) takes the chip\'s neutral rule', ok, diff)

            check(f'{tag}: no page errors', not errs, errs[:3])
            await ctx.close()
        await b.close()
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
