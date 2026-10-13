# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 seancconner

"""
Browser checks for the weigh-in editor (ui/weigh-in-manager.js) and the Cardio Zone
Reference (ui/cardio-zone-reference.js) now that both live in the shared detail sheet
(src/ui/detail-sheet.js) instead of their own standalone .setup-flow overlays.

Not part of `npm test` (the smoketests are node-only); run it by hand against a running app:

    npm run dev
    ERGNOVA_URL=http://localhost:5173/ python3 scripts/browser-checks/weigh-in-and-czr-sheets.py

Needs `pip install playwright` and a Chromium (`playwright install chromium`). Seeds three
body measurements (one with an out-of-range weight, guaranteed to flag) into the app's own
IndexedDB, then drives: opening the weigh-in editor from the Overview card, the list/edit
split, beforeClose stepping an in-progress edit back to the list instead of closing (Esc,
scrim, and a long drag-to-dismiss all go through it), the "Profile settings" header action
landing on Settings with Body composition expanded and the field highlighted, Delete, and
then the Cardio Zone Reference opening full/wide/flush with its iframe filled from Settings
and its own "Edit FTP & heart rate" action landing on the three Profile fields. Mouse drags
only — see detail-sheet.py's own docstring for why. Prints PASS/FAIL per check.
"""
import os
BASE = os.environ.get('ERGNOVA_URL', 'http://127.0.0.1:5173/')
import asyncio, sys
from playwright.async_api import async_playwright

SEED = """
async () => {
  const { db } = await import('/src/storage/db.js');
  const now = Date.now(), day = 86400000;
  await db.addBodyMeasurements([
    { measuredAt: now - 20*day, source: 'manual', weightKg: 74.8, bodyFatPct: 18.2, leanBodyMassKg: 61.2,
      muscleMassKg: null, boneMassKg: null, bodyWaterKg: null, visceralFatRating: null, basalMetabolicRateKcal: null },
    { measuredAt: now - 10*day, source: 'manual', weightKg: 75.1, bodyFatPct: 18.0, leanBodyMassKg: 61.6,
      muscleMassKg: null, boneMassKg: null, bodyWaterKg: null, visceralFatRating: null, basalMetabolicRateKcal: null },
    // Way outside WEIGHT_KG_RANGE -- guaranteed FLAG.WEIGHT_RANGE, independent of the swing heuristic.
    { measuredAt: now - 1*day, source: 'manual', weightKg: 999, bodyFatPct: 18.1, leanBodyMassKg: null,
      muscleMassKg: null, boneMassKg: null, bodyWaterKg: null, visceralFatRating: null, basalMetabolicRateKcal: null },
  ]);
}
"""

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ')+name+(f'  [{detail}]' if detail else ''))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=False)
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and 'Failed to load resource' not in m.text and errs.append("console: " + m.text))
        dialogs = []
        async def on_dialog(d): dialogs.append(d.message); await d.accept()
        pg.on("dialog", lambda d: asyncio.ensure_future(on_dialog(d)))

        await pg.goto(BASE, wait_until="load"); await pg.wait_for_timeout(1200)
        await pg.evaluate(SEED); await pg.reload(wait_until="load"); await pg.wait_for_timeout(1500)

        async def sheet_state():
            return await pg.evaluate("""() => {
                const h = document.querySelector('.detail-sheet-host'), s = document.querySelector('.detail-sheet');
                if (!h || !s) return null;
                const r = s.getBoundingClientRect();
                return { hidden: h.classList.contains('hidden'), open: h.classList.contains('is-open'),
                         size: s.dataset.size, width: s.dataset.width,
                         flush: !!document.querySelector('.detail-sheet-body.is-flush'),
                         title: document.querySelector('.detail-sheet-title')?.textContent };
            }""")

        # ───────────────────────── Weigh-in editor ─────────────────────────
        await pg.evaluate("document.querySelector('[data-tab=\"overview\"]').click()"); await pg.wait_for_timeout(500)
        opened = await pg.evaluate("""() => {
            const btn = [...document.querySelectorAll('button, [role="button"], a')]
              .find(el => /review|weigh-in/i.test(el.textContent||'') && el.offsetParent);
            if (btn) { btn.click(); return 'card'; }
            return null;
        }""")
        if not opened:
            # Fallback: Settings → Profile → Body composition → Weigh-in history button.
            await pg.evaluate("document.querySelector('[data-tab=\"settings\"]').click()"); await pg.wait_for_timeout(500)
            await pg.evaluate("document.getElementById('weigh-in-history-btn')?.click()")
            opened = 'settings-button'
        await pg.wait_for_timeout(700)
        st = await sheet_state()
        check('weigh-in sheet opens', st and not st['hidden'] and st['open'] and st['size'] == 'tall' and st['flush'], f'via {opened}: {st}')
        check('title is Weigh-ins', st and st['title'] == 'Weigh-ins', st and st['title'])

        rows = await pg.locator('.wi-sheet-body [data-id]').count()
        check('seeded rows visible', rows >= 1, rows)
        has_flag_tab = await pg.locator('[data-wi-filter]').count() >= 2
        check('filter tabs present (All / Needs review)', has_flag_tab)

        settings_action = pg.locator('.detail-sheet-action.has-label', has_text='Profile settings')
        check('Profile settings header action present', await settings_action.count() == 1)

        # Open the flagged (999kg) row's editor.
        edit_btn = pg.locator('.wi-sheet-body [data-id] .wi-edit').first
        await edit_btn.click(); await pg.wait_for_timeout(400)
        st = await sheet_state()
        foot_visible = await pg.evaluate("() => !document.getElementById('wi-foot').classList.contains('hidden')")
        check('edit form opens, title changes, foot shown', st['title'] == 'Edit weigh-in' and foot_visible, st['title'])

        # Esc while editing: beforeClose should step back to the list, not close the sheet.
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(400)
        st = await sheet_state()
        check('Esc while editing steps back to the list (sheet stays open)', st and not st['hidden'] and st['title'] == 'Weigh-ins', st and st['title'])

        # Re-enter the edit form, then a long drag-to-dismiss should also just back out, not close.
        await edit_btn.click(); await pg.wait_for_timeout(400)
        panel = pg.locator('.detail-sheet')
        box = await panel.bounding_box()
        await pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + 10)
        await pg.mouse.down()
        for dy in range(0, 420, 20):
            await pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + 10 + dy); await pg.wait_for_timeout(5)
        await pg.mouse.up(); await pg.wait_for_timeout(500)
        st = await sheet_state()
        check('long drag while editing backs out to the list, sheet stays open (beforeClose honored)',
              st and not st['hidden'] and st['title'] == 'Weigh-ins', st and st)

        # A long drag on the LIST (nothing to veto) should actually close it.
        box = await panel.bounding_box()
        await pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + 10)
        await pg.mouse.down()
        for dy in range(0, 420, 20):
            await pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + 10 + dy); await pg.wait_for_timeout(5)
        await pg.mouse.up(); await pg.wait_for_timeout(500)
        st = await sheet_state()
        check('long drag on the list actually closes the sheet', st is None or st['hidden'])

        # Re-open, edit the flagged row, delete it via the foot button.
        await pg.evaluate("document.querySelector('[data-tab=\"overview\"]').click()"); await pg.wait_for_timeout(300)
        await pg.evaluate("document.querySelector('[data-tab=\"settings\"]').click()"); await pg.wait_for_timeout(300)
        await pg.evaluate("document.getElementById('weigh-in-history-btn')?.click()"); await pg.wait_for_timeout(600)
        rows_before = await pg.locator('.wi-sheet-body [data-id]').count()
        await pg.locator('.wi-sheet-body [data-id] .wi-edit').first.click(); await pg.wait_for_timeout(300)
        await pg.click('#wi-delete-edit'); await pg.wait_for_timeout(500)
        rows_after = await pg.locator('.wi-sheet-body [data-id]').count()
        check('Delete (from the foot) removes one row', dialogs and rows_after == rows_before - 1, f'{rows_before}->{rows_after} dialogs={dialogs}')

        # The "Profile settings" header action: closes the sheet, lands on Settings with Body
        # composition expanded, and highlights the toggle.
        await settings_action.click(); await pg.wait_for_timeout(500)
        st = await sheet_state()
        on_settings = await pg.evaluate("() => document.querySelector('[data-tab=\"settings\"]').classList.contains('active')")
        panel_expanded = await pg.evaluate("() => !document.getElementById('body-comp-panel')?.classList.contains('hidden')")
        highlighted = await pg.evaluate("() => document.getElementById('body-comp-toggle')?.closest('.settings-row, label, div')?.className.includes('highlight') || !!document.querySelector('.field-highlight, [class*=highlight]')")
        check('sheet closes + lands on Settings via Profile settings action', (st is None or st['hidden']) and on_settings, f'sheet={st} onSettings={on_settings}')
        check('Body composition panel expanded by the jump', panel_expanded)
        check('something on the page carries a highlight class after the jump', highlighted)

        # ───────────────────────── Cardio Zone Reference ─────────────────────────
        await pg.wait_for_timeout(300)
        # The jump above left Settings on its Profile category; the reference button lives under Display.
        await pg.evaluate("document.getElementById('md-rail-tab-display')?.click()")
        await pg.wait_for_timeout(300)
        czr_btn = pg.locator('#open-cardio-zone-reference')
        if await czr_btn.count() == 0:
            czr_btn = pg.locator('button, [role=button]', has_text='Open reference')
        if await czr_btn.count() == 0:
            czr_btn = pg.locator('[id*=czr], [id*=cardio-zone]')
        await czr_btn.first.scroll_into_view_if_needed()
        await czr_btn.first.click(); await pg.wait_for_timeout(900)
        st = await sheet_state()
        check('Cardio Zone Reference opens full/wide/flush', st and not st['hidden'] and st['size'] == 'full' and st['width'] == 'wide' and st['flush'], st)
        iframe_present = await pg.locator('.detail-sheet .czr-frame').count() == 1
        check('iframe fills the sheet body', iframe_present)
        edit_action = pg.locator('.detail-sheet-action.has-label', has_text='Edit FTP & heart rate')
        check('Edit FTP & heart rate header action present', await edit_action.count() == 1)

        # Values actually landed inside the iframe (confirms _fillFromSettings still runs post-move).
        frame = pg.frame_locator('.detail-sheet .czr-frame')
        ftp_val = None
        try:
            ftp_val = await frame.locator('#inFtp').input_value(timeout=3000)
        except Exception as e:
            ftp_val = f'ERR: {e}'
        check('iframe FTP field got a value from Settings', ftp_val not in (None, '', '0'), ftp_val)

        await edit_action.click(); await pg.wait_for_timeout(500)
        st = await sheet_state()
        on_settings = await pg.evaluate("() => document.querySelector('[data-tab=\"settings\"]').classList.contains('active')")
        check('Edit FTP & heart rate closes the sheet and lands on Settings', (st is None or st['hidden']) and on_settings, f'sheet={st}')

        check('no page errors', not errs, errs[:3])

        n_ok = sum(1 for _, ok, _ in results if ok)
        print(f"\n{n_ok}/{len(results)} passed")
        await b.close()
        return n_ok == len(results)

ok = asyncio.run(main())
sys.exit(0 if ok else 1)
