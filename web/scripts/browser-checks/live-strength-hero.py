# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the live strength screen's hero (views/strength-session.js, ui/strength-live-logic.js).

Not part of `npm test`; run by hand against a running app:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/live-strength-hero.py

Needs `pip install playwright` and a Chromium. Drives the real app (a calisthenics "Foundations"
session started from the FAB menu, no strap) at 390x844 unless stated:

  - Layout: the whole set-entry card, check button included, is on screen with no scrolling at
    390x844 and at 360x640; on a screen too short for it (360x480) the check is still on screen
    with the panel scrolled to the top (it is pinned), and stays on screen as the panel scrolls.
  - Sequence strip: every pill is one line and the same height, the strip scrolls sideways, the
    current step is scrolled to the middle after a tap, a re-render does not yank the strip back
    while the rider has swiped away, and a long name does not wrap.
  - Hero: the exercise name is the (still typeable) title; "Set N" starts at 1 and is 2 when the
    sequence wraps back to the first exercise.
  - Steppers: one click is exactly one step (no double step from the pointer + click pair), minus
    stops at 0, holding repeats and releasing stops it, Enter on a focused button steps once, and
    a typed value still works and still logs. Weight steps 2.5 kg / 5 lb. Targets are at least
    40x56 and the numerals are big and tabular.
  - Ladder: three slots; the current rung opens a tooltip listing all five, one per line; a
    neighbour steps to that rung; the first and last rung keep an empty slot, not a shifted row.
  - Muscle row: always visible, also for a free-typed name (silhouette, nothing lit, no ladder).
  - Hold mode: Target hold has its own stepper (5 s steps); the reps fields hide.
  - Bodyweight: with a rider weight on file, a bodyweight move shows the breakdown row, the weight
    is the calculated total, its steppers are disabled, and added weight updates the total; a
    weighted lift gets the plain stepper back. With no rider weight it falls back to manual.
  - Keys: Space on a focused check or stepper activates it (it used to fire the app-wide Start/Stop
    shortcut and drop the panel), and a held Space does not log a pile of sets.
  - Focus: on a touch device, picking an exercise does not focus a number field (no keyboard over
    the check); on a mouse device it still does.

Prints PASS/FAIL per check; screenshots go to /tmp/lsh-*.png.
"""
import os, asyncio, sys
from playwright.async_api import async_playwright

BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

SEED_PROFILE = """
async (p) => {
  const { db } = await import('/src/storage/db.js');
  if (p.riderWeight != null) await db.setPref('riderWeight', p.riderWeight);
  if (p.units) await db.setPref('units', p.units);
}
"""

async def new_page(browser, w=390, h=844, touch=False, profile=None):
    ctx = await browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2,
                                    has_touch=touch, is_mobile=touch)
    pg = await ctx.new_page()
    pg.errs = []
    pg.on("pageerror", lambda e: pg.errs.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and 'Failed to load resource' not in m.text and pg.errs.append("console: " + m.text))
    await pg.goto(BASE, wait_until="load"); await pg.wait_for_timeout(1500)
    if profile:
        await pg.evaluate(SEED_PROFILE, profile); await pg.reload(wait_until="load"); await pg.wait_for_timeout(2000)
    return pg

async def start_session(pg, style='calisthenics'):
    await pg.evaluate("document.getElementById('fab-start-btn').click()"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.getElementById('fab-menu-strength').click()"); await pg.wait_for_timeout(700)
    await pg.evaluate(f"document.querySelector('.detail-sheet [data-style={style}]').click()"); await pg.wait_for_timeout(300)
    await pg.evaluate("document.getElementById('ss-sequence-trigger').click(); document.querySelector('.detail-sheet .sf-sequence-panel .sf-sequence-card').click()"); await pg.wait_for_timeout(400)
    await pg.evaluate("document.getElementById('ss-finish').click()"); await pg.wait_for_timeout(1200)

def val(pg, sel): return pg.evaluate(f"document.querySelector('{sel}').value")
async def rect(pg, sel):
    return await pg.evaluate("""(sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect();
        return {x:r.x, y:r.y, w:r.width, h:r.height, top:r.top, bottom:r.bottom, left:r.left, right:r.right, cx:r.x+r.width/2, cy:r.y+r.height/2}; }""", sel)
async def click_btn(pg, sel):  # a real pointer press at the centre
    r = await rect(pg, sel); await pg.mouse.click(r['cx'], r['cy'])
async def type_exercise(pg, name):
    await pg.fill('[data-exercise-input]', name); await pg.wait_for_timeout(150)

REPS_PLUS, REPS_MINUS = '[data-step="reps"][data-dir="1"]', '[data-step="reps"][data-dir="-1"]'
W_PLUS, W_MINUS = '[data-step="weight"][data-dir="1"]', '[data-step="weight"][data-dir="-1"]'
H_PLUS, H_MINUS = '[data-step="hold"][data-dir="1"]', '[data-step="hold"][data-dir="-1"]'

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()

        # ── A. Layout, strip, hero, steppers, ladder, muscle row, hold ───────────────────────
        pg = await new_page(b)
        await start_session(pg)
        await pg.screenshot(path='/tmp/lsh-hero-390.png')

        lay = await pg.evaluate("""() => { const q = s => document.querySelector(s).getBoundingClientRect();
            const hero = q('.strength-hero'), chk = q('[data-log-reps-btn]'), panel = document.getElementById('strength-panel');
            return {heroTop: hero.top, chkBottom: chk.bottom, chkH: chk.height, vh: innerHeight, scroll: panel.scrollTop, sh: panel.scrollHeight, ch: panel.clientHeight,
                    oldLogTitle: !![...document.querySelectorAll('.settings-title')].find(e => e.textContent.trim() === 'Log a Set'),
                    oldName: !!document.querySelector('[data-muscle-exercise-name]'), oldRows: document.querySelectorAll('.strength-hero .settings-row').length}; }""")
        check('390x844: the check is on screen with no scrolling', lay['chkBottom'] <= lay['vh'] and lay['scroll'] == 0, lay)
        check('390x844: the whole screen needs no scroll at all', lay['sh'] <= lay['ch'] + 1, f"{lay['sh']} vs {lay['ch']}")
        check('the check is still the 56px green check', lay['chkH'] >= 56, lay['chkH'])
        check('the old "Log a Set" title, settings rows and muscle name line are gone', not lay['oldLogTitle'] and not lay['oldName'] and lay['oldRows'] == 0, lay)

        # strip
        strip = await pg.evaluate("""() => { const rail = document.querySelector('[data-sequence-rail]'); const pills = [...rail.children];
            const hs = pills.map(p => Math.round(p.getBoundingClientRect().height)); const names = pills.map(p => p.querySelector('.strength-sequence-step-name'));
            const lh = parseFloat(getComputedStyle(names[0]).lineHeight);
            return {n: pills.length, hs, oneLine: names.every(n => n.getBoundingClientRect().height <= lh * 1.5), nowrap: getComputedStyle(pills[0]).whiteSpace,
                    scrolls: rail.scrollWidth > rail.clientWidth, text0: pills[0].textContent.replace(/\\s+/g,' ').trim(), cur: pills.findIndex(p => p.classList.contains('current')), snap: getComputedStyle(rail).scrollSnapType}; }""")
        check('five single-line pills of the same height', strip['n'] == 5 and strip['oneLine'] and len(set(strip['hs'])) == 1 and strip['hs'][0] <= 48, strip)
        check('the pill reads "1 · Chest Dip 0/3" and is not allowed to wrap', strip['text0'].startswith('1 \u00b7 Chest Dip') and strip['text0'].endswith('0/3') and strip['nowrap'] == 'nowrap', strip['text0'])
        check('the strip scrolls sideways and snaps', strip['scrolls'] and 'x' in strip['snap'], strip['snap'])
        check('step 1 is the current pill', strip['cur'] == 0)

        # hero basics
        hero = await pg.evaluate("""() => ({name: document.querySelector('[data-exercise-input]').value, tag: document.querySelector('[data-exercise-input]').tagName,
            fs: parseFloat(getComputedStyle(document.querySelector('[data-exercise-input]')).fontSize), set: document.querySelector('[data-set-number]').textContent.trim(),
            setLabel: document.querySelector('.strength-hero-head').textContent.replace(/\\s+/g,' ').trim()})""")
        check('the exercise name is the title, still a text field', hero['name'] == 'Chest Dip' and hero['tag'] == 'INPUT' and hero['fs'] >= 20, hero)
        check('"Set 1" to start', hero['set'] == '1' and hero['setLabel'].startswith('Set 1'), hero['setLabel'])

        # tap target sizes + numerals
        sz = await pg.evaluate("""() => { const b = document.querySelector('[data-step=\\"reps\\"][data-dir=\\"1\\"]').getBoundingClientRect(), i = getComputedStyle(document.querySelector('[data-reps-input]'));
            return {w: b.width, h: b.height, fs: parseFloat(i.fontSize), tab: i.fontVariantNumeric}; }""")
        check('steppers are at least 40x56 with big tabular numerals', sz['w'] >= 40 and sz['h'] >= 56 and sz['fs'] >= 24 and 'tabular' in sz['tab'], sz)
        labels = await pg.evaluate("""() => [...document.querySelectorAll('[data-step]')].map(b => b.getAttribute('aria-label'))""")
        # (The ::-webkit-*-spin-button pseudo-elements cannot be read with getComputedStyle, so this only guards the
        # rule being present; that the spinner is really gone was checked by eye with the mouse hovering the field.)
        spin = await pg.evaluate("getComputedStyle(document.querySelector('[data-reps-input]')).appearance")
        check('stepper inputs opt out of the native number spinner (appearance: textfield)', spin == 'textfield', spin)
        check('every step button is named for a screen reader', len(labels) == 6 and all(labels), labels)

        # steppers
        check('reps start empty', await val(pg, '[data-reps-input]') == '')
        await click_btn(pg, REPS_PLUS)
        check('one click is exactly one step (no double step)', await val(pg, '[data-reps-input]') == '1', await val(pg, '[data-reps-input]'))
        await click_btn(pg, REPS_PLUS); await click_btn(pg, REPS_PLUS)
        check('three clicks make 3', await val(pg, '[data-reps-input]') == '3')
        await click_btn(pg, REPS_MINUS)
        check('minus takes one off', await val(pg, '[data-reps-input]') == '2')
        for _ in range(4): await click_btn(pg, REPS_MINUS)
        check('minus stops at 0', await val(pg, '[data-reps-input]') == '0', await val(pg, '[data-reps-input]'))
        await pg.fill('[data-reps-input]', '7')
        await click_btn(pg, REPS_PLUS)
        check('a typed value is the starting point for the next step', await val(pg, '[data-reps-input]') == '8')
        await pg.fill('[data-reps-input]', '0')
        r = await rect(pg, REPS_PLUS)
        await pg.mouse.move(r['cx'], r['cy']); await pg.mouse.down(); await pg.wait_for_timeout(1100)
        mid = int(await val(pg, '[data-reps-input]')); await pg.mouse.up()
        check('holding repeats after a short wait', mid >= 5, mid)
        await pg.wait_for_timeout(120); a = int(await val(pg, '[data-reps-input]')); await pg.wait_for_timeout(500); c = int(await val(pg, '[data-reps-input]'))
        check('releasing stops it', a == c, f'{a} -> {c}')
        await pg.fill('[data-reps-input]', '0')
        await pg.evaluate("document.querySelector('[data-step=\"reps\"][data-dir=\"1\"]').focus()")
        await pg.keyboard.press('Enter')
        check('Enter on a focused button steps once', await val(pg, '[data-reps-input]') == '1', await val(pg, '[data-reps-input]'))
        await pg.keyboard.press('Space')
        check('Space steps once too', await val(pg, '[data-reps-input]') == '2', await val(pg, '[data-reps-input]'))
        await pg.fill('[data-weight-input]', '0')
        await click_btn(pg, W_PLUS)
        check('weight steps by 2.5 kg', await val(pg, '[data-weight-input]') == '2.5', await val(pg, '[data-weight-input]'))
        await click_btn(pg, W_PLUS); await click_btn(pg, W_MINUS)
        check('...and back by 2.5', await val(pg, '[data-weight-input]') == '2.5')

        # log -> set count, advance
        await pg.fill('[data-reps-input]', '0'); await click_btn(pg, REPS_PLUS)
        await click_btn(pg, '[data-log-reps-btn]'); await pg.wait_for_timeout(400)
        st = await pg.evaluate("""() => ({rows: document.querySelectorAll('.strength-set-row').length, name: document.querySelector('[data-exercise-input]').value, set: document.querySelector('[data-set-number]').textContent.trim(),
            reps: document.querySelector('[data-reps-input]').value, cur: [...document.querySelector('[data-sequence-rail]').children].findIndex(p => p.classList.contains('current')),
            b0: document.querySelector('[data-sequence-rail]').children[0].textContent.replace(/\\s+/g,' ').trim()})""")
        check('the check logs the stepped set, and the sequence moves on', st['rows'] == 1 and st['name'] == 'Push-Up' and st['cur'] == 1 and st['reps'] == '' and st['b0'].endswith('1/3'), st)
        check('"Set N" is for the new exercise (1)', st['set'] == '1', st['set'])
        # the rest of the pass: steps 2-5 are Push-Up, Pseudo Planche Push-Up, Adv Tuck Planche (a HOLD) and Chin-Up
        for _ in range(4):
            is_hold = await pg.evaluate("!document.querySelector('[data-hold-fields]').classList.contains('hidden')")
            if is_hold:
                await click_btn(pg, '[data-hold-btn]'); await pg.wait_for_timeout(1100)       # start, run ~1s ...
                run = await pg.evaluate("document.querySelector('[data-hold-btn]').getAttribute('aria-label')")
                check('a running hold turns the button into the green check ("Log hold")', run == 'Log hold', run)
                await click_btn(pg, '[data-hold-btn]'); await pg.wait_for_timeout(250)        # ... then log it
            else:
                await click_btn(pg, REPS_PLUS); await click_btn(pg, '[data-log-reps-btn]'); await pg.wait_for_timeout(250)
        wrap = await pg.evaluate("""() => ({name: document.querySelector('[data-exercise-input]').value, set: document.querySelector('[data-set-number]').textContent.trim(), rows: document.querySelectorAll('.strength-set-row').length})""")
        check('after one full pass it wraps to exercise 1 and says "Set 2"', wrap['name'] == 'Chest Dip' and wrap['set'] == '2' and wrap['rows'] == 5, wrap)
        await pg.screenshot(path='/tmp/lsh-after-pass.png')

        # strip centring
        await pg.locator('[data-step-index="2"]').click(); await pg.wait_for_timeout(900)   # (a locator click scrolls the pill into view first, as a swipe would; pill 3 straddles the strip's right edge)
        cen = await pg.evaluate("""() => { const rail = document.querySelector('[data-sequence-rail]'), cur = rail.querySelector('.current'); const rr = rail.getBoundingClientRect(), cr = cur.getBoundingClientRect();
            return {name: cur.textContent.replace(/\\s+/g,' ').trim(), off: Math.round((cr.left + cr.width/2) - (rr.left + rr.width/2)), sl: rail.scrollLeft}; }""")
        check('tapping step 3 makes it current and scrolls it to the middle', cen['name'].startswith('3 \u00b7') and abs(cen['off']) <= 14, cen)
        await pg.evaluate("document.querySelector('[data-sequence-rail]').scrollLeft = 0"); await pg.wait_for_timeout(300)
        await pg.evaluate("document.querySelector('[data-exercise-input]').dispatchEvent(new Event('input', {bubbles:true}))"); await pg.wait_for_timeout(500)
        check('a re-render does not yank the strip back while the rider has swiped away', await pg.evaluate("document.querySelector('[data-sequence-rail]').scrollLeft") == 0)
        await pg.screenshot(path='/tmp/lsh-strip.png')

        # ladder
        await type_exercise(pg, 'Chest Dip')
        lad = await pg.evaluate("""() => { const kids = [...document.querySelector('[data-progression-rungs]').children];
            return {n: kids.length, names: kids.map(k => k.querySelector('.strength-progression-rung-name')?.textContent ?? null), label: document.querySelector('[data-progression-label]').textContent.trim(),
                    cur: kids[1].classList.contains('current'), tip: kids[1].dataset.tip, hidden: document.querySelector('[data-progression-row]').classList.contains('hidden')}; }""")
        check('the ladder is three slots: previous, current, next', lad['n'] == 3 and lad['names'] == ['Bar Support Hold', 'Chest Dip', 'Ring Dip'] and lad['cur'], lad)
        check('it says where in the line you are', '3 of 5' in lad['label'] and lad['label'].lower().startswith('dip'), lad['label'])
        check('the current rung carries a tip listing all five, one per line', lad['tip'] and lad['tip'].count('\n') == 5 and all(n in lad['tip'] for n in ['Tricep Dip (Bench)', 'Bar Support Hold', 'Chest Dip', 'Ring Dip', 'One-Arm Dip']), repr(lad['tip']))
        await click_btn(pg, '.strength-progression-rung.current'); await pg.wait_for_timeout(400)
        pop = await pg.evaluate("""() => { const p = document.querySelector('.info-popover.visible'); if (!p) return null; const r = p.getBoundingClientRect();
            return {text: p.textContent, ws: getComputedStyle(p).whiteSpace, h: r.height, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight}; }""")
        check('tapping the current rung opens a tooltip with every rung on its own line', pop and pop['ws'] == 'pre-line' and pop['h'] > 90 and 'One-Arm Dip' in pop['text'] and '\u2190 you' in pop['text'], pop)
        check('the tooltip stays on screen', pop and pop['inView'], pop)
        await pg.screenshot(path='/tmp/lsh-ladder-tip.png')
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
        await click_btn(pg, '.strength-progression-rung.next'); await pg.wait_for_timeout(300)
        nxt = await pg.evaluate("""() => ({name: document.querySelector('[data-exercise-input]').value, kids: [...document.querySelector('[data-progression-rungs]').children].map(k => k.querySelector('.strength-progression-rung-name')?.textContent ?? '(empty)'), label: document.querySelector('[data-progression-label]').textContent})""")
        check('tapping a neighbour steps to that rung and re-centres the ladder', nxt['name'] == 'Ring Dip' and nxt['kids'] == ['Chest Dip', 'Ring Dip', 'One-Arm Dip'] and '4 of 5' in nxt['label'], nxt)
        await click_btn(pg, '.strength-progression-rung.next'); await pg.wait_for_timeout(300)
        end = await pg.evaluate("""() => { const kids = [...document.querySelector('[data-progression-rungs]').children]; return {kids: kids.map(k => k.querySelector('.strength-progression-rung-name')?.textContent ?? '(empty)'), emptyHidden: kids[2].getAttribute('aria-hidden'), w: kids.map(k => Math.round(k.getBoundingClientRect().width))}; }""")
        check('the last rung keeps an empty slot, so the current rung does not shift', end['kids'] == ['Ring Dip', 'One-Arm Dip', '(empty)'] and end['emptyHidden'] == 'true' and end['w'][1] > end['w'][0], end)
        await type_exercise(pg, 'Tricep Dip (Bench)')
        first = await pg.evaluate("""() => [...document.querySelector('[data-progression-rungs]').children].map(k => k.querySelector('.strength-progression-rung-name')?.textContent ?? '(empty)')""")
        check('the first rung keeps an empty slot on the left', first == ['(empty)', 'Tricep Dip (Bench)', 'Bar Support Hold'], first)

        # muscle row always visible
        await type_exercise(pg, 'Zercher Carry')
        mus = await pg.evaluate("""() => { const row = document.querySelector('[data-muscle-row]'); const r = row.getBoundingClientRect();
            return {shown: getComputedStyle(row).display !== 'none' && r.height > 40, svgs: row.querySelectorAll('svg').length, lit: row.querySelectorAll('.md-region-active').length,
                    ladderHidden: document.querySelector('[data-progression-row]').classList.contains('hidden'), text: row.querySelector('[data-muscle-list]').textContent}; }""")
        check('the muscle row stays for a free-typed name: silhouette, nothing lit, no ladder', mus['shown'] and mus['svgs'] >= 2 and mus['lit'] == 0 and mus['ladderHidden'], mus)
        await type_exercise(pg, 'Barbell Bench Press')
        mus2 = await pg.evaluate("document.querySelectorAll('[data-muscle-row] .md-region-active').length")
        check('a catalog name lights its muscles', mus2 > 0, mus2)

        # hold mode
        await type_exercise(pg, 'Tuck Planche')
        hold = await pg.evaluate("""() => ({repsHidden: document.querySelector('[data-reps-fields]').classList.contains('hidden'), holdShown: !document.querySelector('[data-hold-fields]').classList.contains('hidden'),
            btn: document.querySelector('[data-hold-btn]').getAttribute('aria-label')})""")
        check('a hold exercise swaps to the hold fields', hold['repsHidden'] and hold['holdShown'] and hold['btn'] == 'Start hold', hold)
        await pg.fill('[data-target-hold-input]', '')
        await click_btn(pg, H_PLUS); await click_btn(pg, H_PLUS)
        check('Target hold steps by 5 seconds', await val(pg, '[data-target-hold-input]') == '10', await val(pg, '[data-target-hold-input]'))
        await click_btn(pg, H_MINUS); await click_btn(pg, H_MINUS); await click_btn(pg, H_MINUS)
        check('...and stops at 0', await val(pg, '[data-target-hold-input]') == '0')
        hb = await rect(pg, '[data-hold-btn]')
        check('the hold button is on screen and 56px tall', hb['bottom'] <= 844 and hb['h'] >= 56, hb)
        await pg.screenshot(path='/tmp/lsh-hold.png')

        # Browse picker inside the hero
        await type_exercise(pg, 'Chest Dip')
        await click_btn(pg, '[data-browse-btn]'); await pg.wait_for_timeout(300)
        opened = await pg.evaluate("!document.querySelector('[data-exercise-picker]').classList.contains('hidden')")
        check('Browse opens the picker under the name', opened)
        await pg.evaluate("document.querySelector('[data-picker-groups] [data-exercise-id=\"push-up\"]')?.click()"); await pg.wait_for_timeout(300)
        picked = await pg.evaluate("({name: document.querySelector('[data-exercise-input]').value, closed: document.querySelector('[data-exercise-picker]').classList.contains('hidden')})")
        check('picking from it fills the name and closes it', picked['name'] == 'Push-Up' and picked['closed'], picked)
        # mouse device: picking focuses a number field
        act = await pg.evaluate("({tag: document.activeElement.tagName, attr: document.activeElement.getAttribute('data-weight-input') !== null || document.activeElement.getAttribute('data-reps-input') !== null})")
        check('with a mouse, picking still jumps focus into Weight/Reps', act['tag'] == 'INPUT' and act['attr'], act)
        check('no page errors (A)', not pg.errs, pg.errs)
        await pg.context.close()

        # ── B. the check stays reachable on short screens ────────────────────────────────────
        pg = await new_page(b, 360, 640); await start_session(pg)
        r = await pg.evaluate("document.querySelector('[data-log-reps-btn]').getBoundingClientRect().bottom")
        check('360x640: the check is on screen with the panel at the top', r <= 640, r)
        await pg.screenshot(path='/tmp/lsh-hero-360x640.png'); await pg.context.close()

        pg = await new_page(b, 360, 480); await start_session(pg)
        info = await pg.evaluate("""() => { const p = document.getElementById('strength-panel'), c = document.querySelector('[data-log-reps-btn]').getBoundingClientRect(); return {sh: p.scrollHeight, ch: p.clientHeight, bottom: c.bottom, vh: innerHeight}; }""")
        check('360x480: the card does not fit (so this really tests pinning)', info['sh'] > info['ch'] + 20, info)
        check('360x480: ...yet the check is on screen without scrolling (pinned)', info['bottom'] <= info['vh'], info)
        await pg.evaluate("document.getElementById('strength-panel').scrollTop = 60"); await pg.wait_for_timeout(200)
        b2 = await pg.evaluate("document.querySelector('[data-log-reps-btn]').getBoundingClientRect().bottom")
        check('360x480: ...and stays on screen as the panel scrolls', b2 <= 480, b2)
        await pg.screenshot(path='/tmp/lsh-hero-360x480.png'); await pg.context.close()

        # ── C. bodyweight with a rider weight on file ────────────────────────────────────────
        pg = await new_page(b, profile={'riderWeight': 80}); await start_session(pg)
        await type_exercise(pg, 'Chest Dip')
        bw = await pg.evaluate("""() => ({calc: !document.querySelector('[data-bw-calc]').classList.contains('hidden'), dis: document.querySelector('[data-weight-input]').disabled, w: document.querySelector('[data-weight-input]').value,
            box: document.querySelector('[data-bodyweight-box]').value, pct: document.querySelector('[data-bodyweight-pct]').textContent, stepDis: [...document.querySelectorAll('[data-step=\\"weight\\"]')].map(x => x.disabled)})""")
        check('a bodyweight move shows the breakdown, the calculated total, and dead weight steppers', bw['calc'] and bw['dis'] and bw['w'] == '76' and bw['box'] == '80' and '95%' in bw['pct'] and bw['stepDis'] == [True, True], bw)
        await pg.fill('[data-added-weight-input]', '10'); await pg.wait_for_timeout(150)
        check('adding a vest updates the total ((80+10) x 95% = 85.5)', await val(pg, '[data-weight-input]') == '85.5', await val(pg, '[data-weight-input]'))
        await click_btn(pg, W_PLUS)
        check('a disabled weight stepper does nothing', await val(pg, '[data-weight-input]') == '85.5')
        await pg.fill('[data-reps-input]', '0'); await click_btn(pg, REPS_PLUS)
        await pg.screenshot(path='/tmp/lsh-bodyweight.png')
        await type_exercise(pg, 'Barbell Bench Press')
        wt = await pg.evaluate("""() => ({calc: !document.querySelector('[data-bw-calc]').classList.contains('hidden'), dis: document.querySelector('[data-weight-input]').disabled, stepDis: [...document.querySelectorAll('[data-step=\\"weight\\"]')].map(x => x.disabled)})""")
        check('a weighted lift gets the plain weight stepper back', not wt['calc'] and not wt['dis'] and wt['stepDis'] == [False, False], wt)
        check('no page errors (C)', not pg.errs, pg.errs)
        await pg.context.close()

        pg = await new_page(b); await start_session(pg); await type_exercise(pg, 'Chest Dip')
        nobw = await pg.evaluate("({calc: !document.querySelector('[data-bw-calc]').classList.contains('hidden'), dis: document.querySelector('[data-weight-input]').disabled})")
        check('with no rider weight on file it falls back to the manual weight stepper', not nobw['calc'] and not nobw['dis'], nobw)
        await pg.context.close()

        # ── D. imperial ──────────────────────────────────────────────────────────────────────
        pg = await new_page(b, profile={'riderWeight': 80, 'units': 'imperial'}); await start_session(pg)
        await type_exercise(pg, 'Barbell Bench Press')
        unit = await pg.evaluate("document.querySelector('[data-weight-unit]').textContent.trim()")
        await pg.fill('[data-weight-input]', '0'); await click_btn(pg, W_PLUS)
        check('imperial: the unit is lb and weight steps by 5', unit == 'lb' and await val(pg, '[data-weight-input]') == '5', f"{unit} {await val(pg, '[data-weight-input]')}")
        check('no page errors (D)', not pg.errs, pg.errs)
        await pg.context.close()

        # ── E. touch device: no keyboard over the check ─────────────────────────────────────
        pg = await new_page(b, touch=True); await start_session(pg)
        await pg.evaluate("document.querySelector('[data-step-index=\"1\"]').click()"); await pg.wait_for_timeout(300)
        t1 = await pg.evaluate("({tag: document.activeElement.tagName, name: document.querySelector('[data-exercise-input]').value, coarse: matchMedia('(pointer: coarse)').matches})")
        check('on a touch device, tapping a step does not focus a number field', t1['coarse'] and t1['name'] == 'Push-Up' and t1['tag'] != 'INPUT', t1)
        await pg.evaluate("document.querySelector('[data-browse-btn]').click()"); await pg.wait_for_timeout(200)
        await pg.evaluate("document.querySelector('[data-picker-groups] [data-exercise-id=\"chest-dip\"]')?.click()"); await pg.wait_for_timeout(300)
        t2 = await pg.evaluate("({tag: document.activeElement.tagName, name: document.querySelector('[data-exercise-input]').value})")
        check('...nor does picking from Browse', t2['name'] == 'Chest Dip' and t2['tag'] != 'INPUT', t2)
        # a finger press on a stepper: pointer + the synthetic click is still one step
        r = await rect(pg, REPS_PLUS)
        await pg.touchscreen.tap(r['cx'], r['cy']); await pg.wait_for_timeout(200)
        check('a finger tap is one step', await val(pg, '[data-reps-input]') == '1', await val(pg, '[data-reps-input]'))
        check('no page errors (E)', not pg.errs, pg.errs)
        await pg.context.close()

        # ── F. Space on the buttons (it used to fire the global Start/Stop shortcut and drop the panel) ──
        pg = await new_page(b); await start_session(pg)
        await pg.fill('[data-reps-input]', '0'); await click_btn(pg, REPS_PLUS)
        await pg.evaluate("document.querySelector('[data-log-reps-btn]').focus()")
        await pg.keyboard.press('Space'); await pg.wait_for_timeout(500)
        sp = await pg.evaluate("({rows: document.querySelectorAll('.strength-set-row').length, shown: document.getElementById('strength-panel').getBoundingClientRect().height > 0, name: document.querySelector('[data-exercise-input]').value})")
        check('Space on the focused check logs one set and the panel stays', sp['rows'] == 1 and sp['shown'] and sp['name'] == 'Push-Up', sp)
        await pg.fill('[data-reps-input]', '4')
        await pg.evaluate("document.querySelector('[data-log-reps-btn]').focus()")
        for _ in range(6): await pg.keyboard.down('Space')
        await pg.keyboard.up('Space'); await pg.wait_for_timeout(500)
        rows = await pg.evaluate("document.querySelectorAll('.strength-set-row').length")
        check('a held Space logs one set at most, not a pile', rows == 2, rows)
        check('no page errors (F)', not pg.errs, pg.errs)
        await pg.context.close()

        await b.close()

    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
    sys.exit(1 if bad else 0)

asyncio.run(main())
