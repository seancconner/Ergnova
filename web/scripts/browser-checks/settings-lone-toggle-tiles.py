# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the two lone toggle tiles in Settings -> General: Audio cues and the Background
workout notification.

Not part of `npm test`; run it by hand against a running app:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/settings-lone-toggle-tiles.py

Needs `pip install playwright` and a Chromium. At 390x844 and 320x640: the lone tile lays out as
one full-width row (name + info button left, switch right) and is not a 2-up cell; it is grouped for
assistive tech and keeps its `pref-audio` id; tapping the tile body toggles it; tapping the info
button opens its tip and does NOT toggle it; the choice is saved (pref `audioCues`) and survives a
reload; it reaches the real consumer (ux/audio-cues.js stops/starts playing); the border is the
accent edge when on and transparent when off, and a keyboard focus ring shows without changing the
state; Space on the focused input toggles it without firing the global Start/Stop shortcut; the
tile is at least 44px tall; nothing overflows sideways. The Background tile (hidden everywhere but a
native Android shell, so the script un-hides it and fills in what app.js's
_renderBackgroundSettingsRow() would) keeps its ids; its name, info button, "Blocked" flag, status
sentence and Open settings button all fit inside one full-width tile; tapping the tile toggles
pref-background, tapping Open settings or the info button does not; and the wrapper still hides
and shows as one unit. Screenshots go to /tmp/ac-*.png.
"""
import os, asyncio, sys
from playwright.async_api import async_playwright
BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

async def goto_settings(pg, cat='general'):
    await pg.evaluate("document.querySelector('.tab-btn[data-tab=\"settings\"]').click()"); await pg.wait_for_timeout(500)
    await pg.evaluate(f"document.querySelector('.md-rail[data-rail-for=\"settings\"] .md-rail-item[data-cat=\"{cat}\"]').click()"); await pg.wait_for_timeout(500)

async def is_on(pg):
    return await pg.evaluate("document.getElementById('pref-audio').checked")

async def tile_look(pg):
    return await pg.evaluate("""() => { const t = document.getElementById('pref-audio').closest('.toggle-tile'); const s = getComputedStyle(t);
        return { border: s.borderTopColor, width: s.borderTopWidth, bg: s.backgroundImage !== 'none' }; }""")

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
            await pg.goto(BASE, wait_until="load"); await pg.wait_for_timeout(1500)
            await goto_settings(pg)

            g = await pg.evaluate("""() => {
                const input = document.getElementById('pref-audio'); const tile = input?.closest('.toggle-tile'); const grid = tile?.parentElement;
                if (!tile) return null;
                const r = tile.getBoundingClientRect(), gr = grid.getBoundingClientRect();
                const name = tile.querySelector('.toggle-tile-name').getBoundingClientRect(), sw = tile.querySelector('.switch').getBoundingClientRect();
                return { tag: tile.tagName, group: grid.getAttribute('role'), label: grid.getAttribute('aria-label'), children: grid.children.length,
                         tileW: r.width, gridW: gr.width, h: r.height, nameLeft: name.left < sw.left, sameRow: Math.abs((name.top + name.height / 2) - (sw.top + sw.height / 2)) < 6,
                         switchRight: sw.right <= r.right && sw.left > r.left + r.width / 2, overflow: document.documentElement.scrollWidth > innerWidth,
                         forAttr: tile.getAttribute('for'), oldRow: !!document.querySelector('.settings-row #pref-audio') };
            }""")
            check(f'{tag}: the tile exists as a <label for="pref-audio"> in a labelled group', g and g['tag'] == 'LABEL' and g['forAttr'] == 'pref-audio' and g['group'] == 'group' and g['label'] == 'Audio', g)
            check(f'{tag}: a lone tile spans the full row (not a half-width cell) and is no longer a plain settings-row', g and g['children'] == 1 and g['tileW'] >= g['gridW'] - 1 and not g['oldRow'], g)
            check(f'{tag}: name on the left, switch on the right, level with each other', g and g['nameLeft'] and g['sameRow'] and g['switchRight'], g)
            check(f'{tag}: at least 44px tall, no sideways overflow', g and g['h'] >= 44 and not g['overflow'], g and f"h={g['h']:.0f} overflow={g['overflow']}")

            # default is on, with the accent edge
            on_look = await tile_look(pg)
            check(f'{tag}: on by default', await is_on(pg))
            if width == 390: await pg.screenshot(path='/tmp/ac-on.png')

            # tapping the body (over the name) turns it off; the edge goes away
            await pg.locator('#pref-audio').locator('xpath=ancestor::label').locator('.toggle-tile-name').click(); await pg.wait_for_timeout(300)
            off_look = await tile_look(pg)
            check(f'{tag}: tapping the tile body turns it off', not await is_on(pg))
            check(f'{tag}: the off tile has a transparent border, the on tile an accent one',
                  off_look['border'] != on_look['border'] and off_look['border'].endswith(', 0)') and not on_look['border'].endswith(', 0)') and on_look['width'] == off_look['width'] == '1px',
                  f"on={on_look['border']} off={off_look['border']}")
            check(f'{tag}: the on tile carries the faint wash, the off tile does not', on_look['bg'] and not off_look['bg'], f"{on_look['bg']}/{off_look['bg']}")
            if width == 390: await pg.screenshot(path='/tmp/ac-off.png')

            # the info button opens its tip and leaves the state alone
            await pg.locator('.toggle-tile .info-btn').first.click(); await pg.wait_for_timeout(300)
            tip = await pg.evaluate("() => { const p = document.querySelector('.info-popover'); return p && getComputedStyle(p).display !== 'none' && p.textContent.trim().length > 20; }")
            check(f'{tag}: the info button shows its tip', tip)
            check(f'{tag}: the info button does not toggle the setting', not await is_on(pg))
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(150)

            # saved + survives reload + reaches the consumer
            await pg.wait_for_timeout(1200)
            saved = await pg.evaluate("async () => { const { db } = await import('/src/storage/db.js'); return await db.getPref('audioCues'); }")
            check(f'{tag}: off is saved as the audioCues pref', saved is False, saved)
            muted = await pg.evaluate("""async () => { const { audioCues } = await import('/src/ux/audio-cues.js'); return audioCues.isEnabled; }""")
            check(f'{tag}: the real audio module follows (isEnabled is false)', muted is False, muted)
            await pg.reload(wait_until="load"); await pg.wait_for_timeout(2000)
            await goto_settings(pg)
            check(f'{tag}: it survives a reload (still off)', not await is_on(pg))
            off_after = await tile_look(pg)
            check(f'{tag}: ...and the tile still looks off after the reload', off_after['border'] == off_look['border'], off_after['border'])

            # keyboard: focus ring without a state change; Space toggles and leaves the page alone
            await pg.evaluate("document.getElementById('pref-audio').focus()")
            ring = await pg.evaluate("() => { const t = document.getElementById('pref-audio').closest('.toggle-tile'); return getComputedStyle(t).outlineStyle !== 'none' && parseFloat(getComputedStyle(t).outlineWidth) > 0; }")
            check(f'{tag}: a focus ring appears on the tile for a focused input (keyboard)', ring)
            tab_before = await pg.evaluate("document.querySelector('.tab-btn.active')?.dataset.tab")
            sess_before = await pg.evaluate("!document.getElementById('session-panel')?.classList.contains('hidden')")
            await pg.keyboard.press('Space'); await pg.wait_for_timeout(300)
            tab_after = await pg.evaluate("document.querySelector('.tab-btn.active')?.dataset.tab")
            sess_after = await pg.evaluate("!document.getElementById('session-panel')?.classList.contains('hidden')")
            check(f'{tag}: Space on the focused input turns it on and does not start a session', await is_on(pg) and tab_before == tab_after and sess_before == sess_after == False, f'tab {tab_before}->{tab_after}, session {sess_before}->{sess_after}')
            await pg.wait_for_timeout(1200)
            saved = await pg.evaluate("async () => { const { db } = await import('/src/storage/db.js'); return await db.getPref('audioCues'); }")
            check(f'{tag}: on is saved again', saved is True, saved)
            live = await pg.evaluate("""async () => { const { audioCues } = await import('/src/ux/audio-cues.js'); return audioCues.isEnabled; }""")
            check(f'{tag}: the real audio module follows (isEnabled is true again)', live is True, live)

            # ---------------- Background workout notification tile ----------------
            await goto_settings(pg)
            hidden_by_default = await pg.evaluate("document.getElementById('background-notification-row').classList.contains('hidden')")
            check(f'{tag}: background tile stays hidden where the shell does not support it', hidden_by_default)
            async def show_bg():
                # app.js re-hides the row after a change where background mode is unsupported (as here),
                # so the script puts it back before every interaction.
                await pg.evaluate("""() => {
                    document.getElementById('background-notification-row').classList.remove('hidden');
                    document.getElementById('background-notification-warn').hidden = false;
                    document.getElementById('background-open-settings').classList.remove('hidden');
                    document.getElementById('background-notification-status').textContent =
                  'Notifications are blocked for Ergnova. The workout still keeps running in the background, but the tray entry won\u2019t show.';
                }""")
            await show_bg()
            await pg.wait_for_timeout(200)
            bg = await pg.evaluate("""() => {
                const grid = document.getElementById('background-notification-row'); const tile = grid.querySelector('.toggle-tile');
                const r = tile.getBoundingClientRect(), gr = grid.getBoundingClientRect();
                const inside = (sel) => { const e = tile.querySelector(sel).getBoundingClientRect(); return e.left >= r.left - 0.5 && e.right <= r.right + 0.5 && e.top >= r.top - 0.5 && e.bottom <= r.bottom + 0.5; };
                const sw = tile.querySelector('.switch').getBoundingClientRect(), nm = tile.querySelector('.toggle-tile-name').getBoundingClientRect();
                const btn = tile.querySelector('#background-open-settings').getBoundingClientRect(), sub = tile.querySelector('.toggle-tile-sub').getBoundingClientRect();
                return { tag: tile.tagName, forAttr: tile.getAttribute('for'), group: grid.getAttribute('role'), full: r.width >= gr.width - 1,
                         parts: ['.toggle-tile-name', '.info-btn', '#background-notification-warn', '.switch', '.toggle-tile-sub', '#background-open-settings'].map(inside),
                         switchRight: sw.right <= r.right && sw.left > r.left + r.width / 2, switchTop: sw.top < nm.bottom + 6,
                         order: sub.top >= nm.bottom - 1 && btn.top >= sub.bottom - 1, h: r.height,
                         overflow: document.documentElement.scrollWidth > innerWidth, oldRow: !!document.querySelector('.settings-row #pref-background') };
            }""")
            check(f'{tag}: background tile is one full-width <label for="pref-background"> in a labelled group', bg['tag'] == 'LABEL' and bg['forAttr'] == 'pref-background' and bg['group'] == 'group' and bg['full'] and not bg['oldRow'], bg)
            check(f'{tag}: name, info button, Blocked flag, switch, status and button all sit inside the tile', all(bg['parts']), bg['parts'])
            check(f'{tag}: switch on the right of the head row; status sentence, then the button, below it', bg['switchRight'] and bg['switchTop'] and bg['order'], bg)
            check(f'{tag}: no sideways overflow', not bg['overflow'], bg['overflow'])
            if width == 390: await pg.screenshot(path='/tmp/ac-background.png')
            was = await pg.evaluate("document.getElementById('pref-background').checked")
            await pg.evaluate("document.getElementById('background-notification-status').scrollIntoView({block:'center'})")
            await show_bg(); await pg.locator('#background-notification-status').click(); await pg.wait_for_timeout(300)
            now = await pg.evaluate("document.getElementById('pref-background').checked")
            check(f'{tag}: tapping the tile (over the status text) toggles pref-background', now != was, f'{was}->{now}')
            await show_bg(); await pg.locator('#background-open-settings').click(); await pg.wait_for_timeout(300)
            after_btn = await pg.evaluate("document.getElementById('pref-background').checked")
            check(f'{tag}: tapping Open settings does not toggle it', after_btn == now, f'{now}->{after_btn}')
            await show_bg(); await pg.locator('#background-notification-row .info-btn').click(); await pg.wait_for_timeout(300)
            after_info = await pg.evaluate("document.getElementById('pref-background').checked")
            check(f'{tag}: tapping the info button does not toggle it', after_info == now, f'{now}->{after_info}')
            await pg.keyboard.press('Escape')
            await pg.evaluate("document.getElementById('background-notification-row').classList.add('hidden')")
            gone = await pg.evaluate("getComputedStyle(document.getElementById('background-notification-row')).display")
            check(f'{tag}: adding .hidden to the wrapper hides the whole tile (what app.js relies on)', gone == 'none', gone)

            check(f'{tag}: no page errors', not errs, errs[:3])
            await ctx.close()

        n_ok = sum(1 for _, ok, _ in results if ok)
        print(f"\n{n_ok}/{len(results)} passed")
        await b.close()
        return n_ok == len(results)

ok = asyncio.run(main())
sys.exit(0 if ok else 1)
