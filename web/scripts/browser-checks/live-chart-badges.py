# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the live chart's fixed badge bar: one row at the top of the
chart panel, separate from the swipeable chart carousel and not moving while it scrolls: Zone / Calories /
a single rotating badge / Distance / Pace. The rotating badge cycles through whichever of Power, Heart rate,
Cadence and Speed is not the metric already on screen as the hero (on the All page, where the hero itself
rotates, it is instead the hero's partner — the metric half a turn away — changing in the same tick), it
stands still while the chart is held with a long-press, and the Scripted HUD no longer has a rotating chip
of its own.

Not part of `npm test` (the pure logic is: src/ui/__chart_badge_smoketest__.js); run by hand against a
running dev server:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/live-chart-badges.py

Needs `pip install playwright` and a Chromium. Starts a free-ride Cardio Session from the FAB menu with no
sensors, then fakes power / heart rate / cadence / speed the way the app sees it (capabilities.set plus
deviceManager.update / session.pushData, via the dev-only window.__debug hooks), so no Bluetooth is
involved. Prints PASS/FAIL per check.
"""
import os, re, asyncio, sys
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

async def start_free_ride(pg, seed_prefs=None):
    await pg.goto(BASE, wait_until='load'); await pg.wait_for_timeout(1200)
    if seed_prefs:
        await pg.evaluate("async (p) => { const { db } = await import('/src/storage/db.js'); for (const [k, v] of Object.entries(p)) await db.setPref(k, v); }", seed_prefs)
        await pg.reload(wait_until='load'); await pg.wait_for_timeout(1500)
    await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.getElementById('fab-menu-cardio').click()"); await pg.wait_for_timeout(800)
    await pg.evaluate("document.getElementById('qs-finish').click()"); await pg.wait_for_timeout(1300)

async def new_page(b, w=390, h=844, **kw):
    ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, **kw)
    pg = await ctx.new_page(); pg.errs = []
    pg.on('pageerror', lambda e: pg.errs.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and pg.errs.append('console: ' + m.text))
    return pg

# Page "slots", as these checks have always numbered them: 0 = All, 1 = Power, 2 = Heart rate, 3 = Cadence,
# 4 = Speed. The dots run Heart rate, Power, Cadence, Speed (charts/chart-order.js), so a slot is looked up by
# its metric key in the carousel's own page list rather than taken as a position; where that metric has no
# page (a rig with only some sensors) the number falls back to a plain position.
GO = "(i) => { const c = window.__debug.chartCarousel(); const key = ['__overview__', 'power', 'heartRate', 'cadence', 'speed'][i]; const at = key ? c.pageKeys.indexOf(key) : -1; const t = document.querySelector('.chart-track'); t.scrollTo({ left: t.clientWidth * (at < 0 ? i : at), behavior: 'instant' }); }"
STATE = """() => {
  const bar = document.querySelector('.chart-badge-bar'), r = e => { const b = e.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const items = [...bar.querySelectorAll('.chart-badge-item')].map(e => ({ k: e.dataset.badge, label: e.querySelector('.chart-badge-label').textContent, v: e.querySelector('.chart-badge-value').textContent,
                                                                          x: e.getBoundingClientRect().x, w: e.getBoundingClientRect().width, color: e.style.getPropertyValue('--chip-color'), cls: e.className }));
  return { active: window.__debug.chartCarousel()._activeKey, bar: r(bar), track: r(document.querySelector('.chart-track')), items };
}"""
LABELS = "() => [...document.querySelectorAll('.chart-badge-bar .chart-badge-item')].map(e => e.dataset.badge === 'rotator' ? 'rotator:' + e.querySelector('.chart-badge-label').textContent : e.dataset.badge)"
ROT = "() => document.querySelector('.chart-badge-bar [data-badge=\"rotator\"] .chart-badge-label')?.textContent ?? null"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()

        # ───────────────────────── Structure ─────────────────────────
        pg = await new_page(b)
        await start_free_ride(pg); await pg.evaluate(FEED, True); await pg.wait_for_timeout(4500)
        s = await pg.evaluate("""() => { const bar = document.querySelector('.chart-badge-bar'), cont = document.getElementById('chart-container'), track = document.querySelector('.chart-track');
            return { child: bar.parentElement === cont, first: cont.firstElementChild === bar, beforeTrack: !!(bar.compareDocumentPosition(track) & Node.DOCUMENT_POSITION_FOLLOWING),
                     inTrack: track.contains(bar), oldInPages: document.querySelectorAll('.chart-page .chart-badges, .chart-badge-pair').length,
                     rotators: bar.querySelectorAll('[data-badge="rotator"]').length }; }""")
        check('the bar is the first child of the chart panel, before the track and outside every page', s['child'] and s['first'] and s['beforeTrack'] and not s['inTrack'], s)
        check('the old per-page corner badges are gone', s['oldInPages'] == 0, s['oldInPages'])
        check('exactly one rotating badge', s['rotators'] == 1, s['rotators'])

        await pg.evaluate(GO, 1); await pg.wait_for_timeout(900)
        a = await pg.evaluate(STATE)
        keys = [i['k'] for i in a['items']]
        check('one row, left to right: Zone / Calories / rotating badge / Distance / Pace (the rotating badge is between calories and distance)', keys == ['zone', 'calories', 'rotator', 'distance', 'pace'], keys)
        ys = await pg.evaluate("[...new Set([...document.querySelectorAll('.chart-badge-bar .chart-badge-item')].map(e => Math.round(e.getBoundingClientRect().top)))].length")
        check('they sit on a single line', ys == 1, ys)
        check('the badges share the row equally', max(i['w'] for i in a['items']) - min(i['w'] for i in a['items']) < 1, [round(i['w'], 1) for i in a['items']])
        rot = next(i for i in a['items'] if i['k'] == 'rotator')
        check('on the Power page the rotating badge is not Power (the hero is already reading it out)', rot['label'] != 'Power', rot['label'])
        check('the rotating badge shows a live reading with its unit', re.fullmatch(r'(\d+ bpm|\d+ rpm|[\d.]+ km/h)', rot['v']), rot['v'])
        check('Zone / Calories / Distance / Pace are all there', {'zone', 'calories', 'distance', 'pace'} <= set(keys), keys)
        await pg.screenshot(path='/tmp/lcb-power.png')

        # ───────────────────────── Stays in place while scrolling ─────────────────────────
        boxes = []
        for frac in (0, .25, .5, .75, 1, 2, 3, 4, 0):
            await pg.evaluate("(f) => { const t = document.querySelector('.chart-track'); t.scrollTo({ left: t.clientWidth * f, behavior: 'instant' }); }", frac)
            await pg.wait_for_timeout(60)
            boxes.append(await pg.evaluate("(() => { const b = document.querySelector('.chart-badge-bar').getBoundingClientRect(); return [b.x, b.y, b.width].map(n => +n.toFixed(1)); })()"))
        check('the bar does not move through a scroll across every page (9 scroll positions, same x / y / width)', len({tuple(x) for x in boxes}) == 1, boxes[:3])
        trk = []
        for i in range(0, 5):
            await pg.evaluate(GO, i); await pg.wait_for_timeout(800)
            st = await pg.evaluate(STATE); trk.append((st['track']['y'], st['bar']['h']))
        check('the chart starts at the same height on every page (the bar is the same height on each)', len(set(trk)) == 1, trk)

        # ───────────────────────── The rotation: skips the metric on screen, cycles through the rest ─────────────────────────
        EXPECT = {1: ('power', {'Heart Rate', 'Cadence', 'Speed'}), 2: ('heartRate', {'Power', 'Cadence', 'Speed'}),
                  3: ('cadence', {'Power', 'Heart Rate', 'Speed'}), 4: ('speed', {'Power', 'Heart Rate', 'Cadence'})}
        for idx, (key, want) in EXPECT.items():
            await pg.evaluate(GO, idx); await pg.wait_for_timeout(700)
            seen = []
            for _ in range(14):    # 14 x 0.5s = 7s, two dwells of 3.5s
                seen.append(await pg.evaluate(ROT)); await pg.wait_for_timeout(500)
            check(f'{key} page: over 7s the rotating badge visits others but never {key}', (await pg.evaluate(STATE))['active'] == key and set(seen) <= want and len(set(seen)) >= 2, sorted(set(seen), key=str))
        # a full lap visits all three, in row order
        await pg.evaluate(GO, 1); await pg.wait_for_timeout(700)
        lap = []
        for _ in range(44):    # ~11s, more than three dwells
            cur = await pg.evaluate(ROT)
            if not lap or lap[-1] != cur: lap.append(cur)
            await pg.wait_for_timeout(250)
        check('on the Power page a lap goes Heart Rate, Cadence, Speed (row order) and round again', lap[:4] == ['Heart Rate', 'Cadence', 'Speed', 'Heart Rate'], lap)
        # dwell
        await pg.evaluate(GO, 2); await pg.wait_for_timeout(700)
        stamps = []; cur = await pg.evaluate(ROT)
        for _ in range(160):
            await pg.wait_for_timeout(100)
            nxt = await pg.evaluate(ROT)
            if nxt != cur: stamps.append(await pg.evaluate("performance.now()")); cur = nxt
            if len(stamps) == 3: break
        gaps = [round(stamps[i + 1] - stamps[i]) for i in range(len(stamps) - 1)]
        check('it holds each metric for about 3.5 seconds before turning over', len(gaps) == 2 and all(3200 <= g <= 3900 for g in gaps), gaps)
        # fade-in replays on turnover
        saw = False
        for _ in range(60):
            if await pg.evaluate("document.querySelector('[data-badge=\"rotator\"]').classList.contains('rotator-in')"): saw = True; break
            await pg.wait_for_timeout(100)
        check('the turn-over replays the fade-in (rotator-in)', saw)
        # colour follows the metric
        cols = {}
        for _ in range(30):
            st = await pg.evaluate(STATE); r_ = next(i for i in st['items'] if i['k'] == 'rotator'); cols[r_['label']] = r_['color']; await pg.wait_for_timeout(400)
            if len(cols) >= 3: break
        check('the rotating badge takes each metric\'s own colour', len(cols) >= 2 and len(set(cols.values())) == len(cols) and all(cols.values()), cols)

        # ───────────────────────── All page: the badge is the hero's partner, in step with it ─────────────────────────
        # The hero steps through Power / Heart Rate / Cadence / Speed on its 3.5s timer. The badge has no timer of its
        # own there: it is the metric half a turn away from the hero, changing in the very tick the hero does.
        PARTNER = {'Heart Rate': 'Cadence', 'Power': 'Speed', 'Cadence': 'Heart Rate', 'Speed': 'Power'}   # half a turn round the dots' order: Heart rate, Power, Cadence, Speed
        HERO = "document.getElementById('stat-metric-name').textContent"
        SNAP = ("() => { const b = document.querySelector('.chart-badge-bar [data-badge=\"rotator\"]'), row = document.getElementById('metrics-row'); "
                "return { nm: " + HERO + ", rot: b?.querySelector('.chart-badge-label')?.textContent ?? null, locked: window.__debug.chartCarousel().locked, "
                "badgeFade: !!b && b.getAnimations().length > 0, rowFade: row.getAnimations().length > 0, "
                "keys: [...document.querySelectorAll('.chart-badge-bar .chart-badge-item')].map(e => e.dataset.badge) }; }")
        await pg.evaluate(GO, 1); await pg.wait_for_timeout(700); await pg.evaluate(GO, 0); await pg.wait_for_timeout(900)
        bad = []; heroes = []; fades = []
        for _ in range(150):    # 150 x ~100ms = 15s, more than four hero steps
            snap = await pg.evaluate(SNAP)
            if not heroes or heroes[-1] != snap['nm']: heroes.append(snap['nm']); fades.append((snap['badgeFade'], snap['rowFade']))
            if PARTNER.get(snap['nm']) != snap['rot'] or snap['keys'] != ['zone', 'calories', 'rotator', 'distance', 'pace']: bad.append(snap)
            await pg.wait_for_timeout(100)
        check('All page: for 15s the rotating badge is always the hero\'s partner (Heart Rate|Cadence, Power|Speed, Cadence|Heart Rate, Speed|Power) — never out of step, never the hero\'s own', not bad and len(heroes) >= 4 and len(set(heroes)) == 4, (heroes, bad[:2]))
        check('...and it fades in with the hero: at each hero step the badge and the readout are both mid-fade', len(fades) >= 4 and all(x and y for x, y in fades[1:]), fades)

        # ───────────────────────── A held chart stops the badge as it stops the hero ─────────────────────────
        box = await pg.evaluate("(() => { const r = document.querySelector('.chart-track').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()")
        async def hold_chart():    # a real press-and-hold (the focus-lock fires after 450ms), not a call into the carousel
            await pg.mouse.move(box['x'], box['y']); await pg.mouse.down(); await pg.wait_for_timeout(700); await pg.mouse.up(); await pg.wait_for_timeout(200)
        await hold_chart()
        s0 = await pg.evaluate(SNAP); moved = []
        for _ in range(80):    # 8s: more than two dwells, so both timers would have fired
            s_ = await pg.evaluate(SNAP)
            if (s_['nm'], s_['rot']) != (s0['nm'], s0['rot']): moved.append(s_)
            await pg.wait_for_timeout(100)
        check('All page, held (a real 700ms press): the chart locks, and for 8s the hero and the badge both hold, still a pair', s0['locked'] and not moved and PARTNER.get(s0['nm']) == s0['rot'], (s0, moved[:2]))
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(150)
        seen = []; bad = []
        for _ in range(60):    # 6s: at least one hero step after release
            s_ = await pg.evaluate(SNAP)
            if not seen or seen[-1] != s_['nm']: seen.append(s_['nm'])
            if PARTNER.get(s_['nm']) != s_['rot']: bad.append(s_)
            await pg.wait_for_timeout(100)
        check('All page, released: the rotation carries on, the badge stepping with the hero every time', not (await pg.evaluate(SNAP))['locked'] and len(seen) >= 2 and not bad, (seen, bad[:2]))

        await pg.evaluate(GO, 1); await pg.wait_for_timeout(900)    # Power page: the badge turns over on its own timer here
        await hold_chart()
        s0 = await pg.evaluate(SNAP); frozen = set()
        for _ in range(90):    # 9s: the badge's own timer would have fired twice
            frozen.add((await pg.evaluate(SNAP))['rot']); await pg.wait_for_timeout(100)
        check('Power page, held: the rotating badge holds on one metric for 9s (it would have turned over twice)', s0['locked'] and len(frozen) == 1 and 'Power' not in frozen, (s0['locked'], frozen))
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(150)
        seen = set()
        for _ in range(60): seen.add((await pg.evaluate(SNAP))['rot']); await pg.wait_for_timeout(100)
        check('Power page, released: it turns over again, and still never lands on Power', len(seen) >= 2 and 'Power' not in seen, seen)

        # ───────────────────────── Dots tap and errors ─────────────────────────
        await pg.evaluate("[...document.querySelectorAll('.chart-dot')].find(d => d.title === 'Heart Rate').click()"); await pg.wait_for_timeout(1000)
        st = await pg.evaluate(STATE)
        check('a dot tap that smooth-scrolls to Heart rate: the rotating badge skips Heart Rate', st['active'] == 'heartRate' and next(i for i in st['items'] if i['k'] == 'rotator')['label'] != 'Heart Rate', st['active'])
        check('no page errors', not pg.errs, pg.errs[:3])
        await pg.context.close()

        # ───────────────────────── Scripted HUD has no rotating chip ─────────────────────────
        pg = await new_page(b)
        await pg.goto(BASE, wait_until='load'); await pg.wait_for_timeout(1200)
        gone = await pg.evaluate("({ chip: !!document.getElementById('hud-rotator'), val: !!document.getElementById('hud-rotator-value'), cls: document.querySelectorAll('.hud-rotator').length })")
        check('the Scripted HUD no longer has its own rotating metric chip', not any(gone.values()), gone)
        await pg.context.close()

        # ───────────────────────── Zone follows the page; units follow the setting ─────────────────────────
        pg = await new_page(b)
        await start_free_ride(pg, {'maxHr': 190}); await pg.evaluate(FEED, True); await pg.wait_for_timeout(4500)
        await pg.evaluate(GO, 1); await pg.wait_for_timeout(900); pz = await pg.evaluate(STATE)
        await pg.evaluate(GO, 2); await pg.wait_for_timeout(900); hz = await pg.evaluate(STATE)
        zone = lambda s_: next(x for x in s_['items'] if x['k'] == 'zone')
        check('Zone is the power zone on the power page and the heart-rate zone on the heart-rate page', re.fullmatch(r'Z\d', zone(pz)['v']) and re.fullmatch(r'Z\d', zone(hz)['v']) and zone(pz)['color'] and zone(hz)['color'], (zone(pz), zone(hz)))
        await pg.evaluate("document.querySelector('[data-tab=\"settings\"]').click()"); await pg.wait_for_timeout(500)
        await pg.evaluate("document.querySelector('#pref-units .segmented-btn[data-value=\"imperial\"]').click()"); await pg.wait_for_timeout(500)
        await pg.evaluate("document.querySelector('[data-tab=\"session\"]')?.click()"); await pg.wait_for_timeout(500)
        # on the Power page the rotator will land on speed within a lap; wait for it
        await pg.evaluate(GO, 1); await pg.wait_for_timeout(700)
        spd = None
        for _ in range(60):
            st = await pg.evaluate(STATE); r_ = next(i for i in st['items'] if i['k'] == 'rotator')
            if r_['label'] == 'Speed': spd = r_['v']; break
            await pg.wait_for_timeout(300)
        dist = next(x for x in st['items'] if x['k'] == 'distance')['v']; pace = next(x for x in st['items'] if x['k'] == 'pace')['v']
        check('switching to imperial updates Distance and Pace, and the rotating badge\'s Speed (mph)', spd and 'mph' in spd and ' mi' in dist and '/mi' in pace, (spd, dist, pace))
        check('no page errors (zone / units)', not pg.errs, pg.errs[:3])
        await pg.context.close()

        # ───────────────────────── Fewer metrics ─────────────────────────
        pg = await new_page(b)
        await start_free_ride(pg)
        await pg.evaluate("""async () => { const { deviceManager } = await import('/src/ble/device-manager.js'); const cap = window.__debug.capabilities;
            cap.set('power', true); cap.set('heartRate', true); const d = { power: 200, heartRate: 140 }; clearInterval(window.__feed);
            window.__feed = setInterval(() => { deviceManager.update('fake', d); window.__debug.session()?.pushData?.(d); }, 250); }""")
        await pg.wait_for_timeout(3500)
        await pg.evaluate(GO, 1); await pg.wait_for_timeout(700)
        seen = set()
        for _ in range(16): seen.add(await pg.evaluate(ROT)); await pg.wait_for_timeout(500)
        check('two metrics (power + heart rate): on Power the rotating badge just holds on Heart Rate (no cycling, no animation)', seen == {'Heart Rate'}, seen)
        await pg.evaluate(GO, 0); await pg.wait_for_timeout(900)
        keys = (await pg.evaluate(LABELS))
        check('the row still reads Zone / Calories / rotator / Distance / Pace', [k.split(':')[0] for k in keys] == ['zone', 'calories', 'rotator', 'distance', 'pace'], keys)
        await pg.context.close()
        pg = await new_page(b)
        await start_free_ride(pg)
        await pg.evaluate("""async () => { const { deviceManager } = await import('/src/ble/device-manager.js'); const cap = window.__debug.capabilities;
            cap.set('power', true); const d = { power: 200 }; clearInterval(window.__feed);
            window.__feed = setInterval(() => { deviceManager.update('fake', d); window.__debug.session()?.pushData?.(d); }, 250); }""")
        await pg.wait_for_timeout(3500)
        await pg.evaluate(GO, 1); await pg.wait_for_timeout(900)
        st = await pg.evaluate(STATE)
        check('one metric, on its own page: no rotating badge (nothing to rotate), the other four stay', st['active'] == 'power' and [i['k'] for i in st['items']] == ['zone', 'calories', 'distance', 'pace'], (st['active'], [i['k'] for i in st['items']]))
        await pg.evaluate(GO, 0); await pg.wait_for_timeout(900)
        st = await pg.evaluate(STATE)
        check('and on the All page the hero is on Power too, so still none', [i['k'] for i in st['items']] == ['zone', 'calories', 'distance', 'pace'], [i['k'] for i in st['items']])
        check('no page errors (fewer metrics)', not pg.errs, pg.errs[:3])
        await pg.context.close()

        # ───────────────────────── A metric with no badge (SmO2) ─────────────────────────
        pg = await new_page(b)
        await start_free_ride(pg)
        await pg.evaluate("""async () => { const { deviceManager } = await import('/src/ble/device-manager.js'); const cap = window.__debug.capabilities;
            cap.set('power', true); cap.set('smo2', true); const d = { power: 200, smo2: 61.5 }; clearInterval(window.__feed);
            window.__feed = setInterval(() => { deviceManager.update('fake', d); window.__debug.session()?.pushData?.(d); }, 250); }""")
        await pg.wait_for_timeout(3500)
        await pg.evaluate(GO, 2); await pg.wait_for_timeout(900)
        st = await pg.evaluate(STATE)
        check('SmO2 has a chart but no badge: on its page the one badge metric (Power) rotates in', st['active'] == 'smo2' and next((i['label'] for i in st['items'] if i['k'] == 'rotator'), None) == 'Power', (st['active'], [i['k'] for i in st['items']]))
        await pg.context.close()

        # ───────────────────────── Empty (no sensor): no bar ─────────────────────────
        pg = await new_page(b)
        await start_free_ride(pg)
        e = await pg.evaluate("(() => { const b = document.querySelector('.chart-badge-bar'); return { exists: !!b, hidden: b ? getComputedStyle(b).display === 'none' : null }; })()")
        check('no sensor: the bar exists but is hidden, so the Connect tile keeps the room', e['exists'] and e['hidden'], e)
        await pg.context.close()

        # ───────────────────────── Other sizes ─────────────────────────
        for (w_, h_, name) in [(1280, 860, 'desktop'), (844, 390, 'landscape'), (740, 360, 'short landscape'), (360, 640, 'small')]:
            pg = await new_page(b, w_, h_)
            await start_free_ride(pg); await pg.evaluate(FEED, True); await pg.wait_for_timeout(4000)
            await pg.evaluate(GO, 1); await pg.wait_for_timeout(900)
            m = await pg.evaluate("""() => { const bar = document.querySelector('.chart-badge-bar'), br = bar.getBoundingClientRect(), tr = document.querySelector('.chart-track').getBoundingClientRect(), cont = document.getElementById('chart-container').getBoundingClientRect();
                const vis = [...bar.querySelectorAll('.chart-badge-item')].map(e => e.getBoundingClientRect());
                const vals = [...bar.querySelectorAll('.chart-badge-value')].map(e => e.scrollWidth > e.clientWidth + 1);
                const dots = document.querySelector('.chart-dots').getBoundingClientRect();
                return { barH: Math.round(br.height), tracksH: Math.round(tr.height), fits: dots.bottom <= cont.bottom + 1 && tr.bottom <= cont.bottom + 1, tops: [...new Set(vis.map(r => Math.round(r.top)))].length, overflowX: bar.scrollWidth > bar.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth,
                         inside: vis.every(r => r.left >= cont.left - 1 && r.right <= cont.right + 1), count: vis.length, clipped: vals.filter(Boolean).length }; }""")
            check(f'{name}: one line of five badges, inside the panel, nothing overflowing sideways', m['tops'] == 1 and m['count'] == 5 and m['inside'] and not m['overflowX'], m)
            check(f'{name}: no value is clipped inside its badge', m['clipped'] == 0, m['clipped'])
            if 'landscape' in name: check(f'{name}: the bar is slim (captions dropped) so the plot keeps its room', m['barH'] < 40 and m['tracksH'] >= 112, (m['barH'], m['tracksH']))
            else: check(f'{name}: the chart keeps a usable height under the bar (>= 140px)', m['tracksH'] >= 140, m['tracksH'])
            check(f'{name}: the plot and the dot strip both fit inside the chart panel (nothing clipped)', m['fits'], m)
            await pg.screenshot(path=f"/tmp/lcb-{name.replace(' ', '-')}.png"); check(f'{name}: no page errors', not pg.errs, pg.errs[:3])
            await pg.context.close()

        # ───────────────────────── Reduced motion ─────────────────────────
        pg = await new_page(b, reduced_motion='reduce')
        await start_free_ride(pg); await pg.evaluate(FEED, True); await pg.wait_for_timeout(4000)
        await pg.evaluate(GO, 1); await pg.wait_for_timeout(700)
        flagged = False; seen = set()
        for _ in range(18):
            seen.add(await pg.evaluate(ROT))
            if await pg.evaluate("document.querySelector('[data-badge=\"rotator\"]').classList.contains('rotator-in')"): flagged = True
            await pg.wait_for_timeout(300)
        check('reduced motion: it still rotates, but without the fade-in', len(seen) >= 2 and not flagged, (seen, flagged))
        await pg.context.close()
        await b.close()

    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
