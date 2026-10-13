// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/recipe-print.js
 *
 * Single-page printable recipe sheet — the Recipes tab's "Print" action
 * (views/diet.js's _recipeCard()) and the recipe editor's own "Print"
 * button (ui/recipe-editor.js's footer, printing the in-progress draft
 * before it's even saved). The actual rider workflow this exists for:
 * print the recipe, cook from the paper copy at the stove instead of a
 * phone screen, then come back and log the meal through the Recipes
 * tab's ordinary "Log" flow (views/diet.js's _recipeLogPanel()) — this
 * sheet only produces the paper copy, it never itself writes a
 * DiaryEntry.
 *
 * Same full-screen overlay shell as every other ui/*.js flow (a
 * `.setup-flow`-classed host, hidden by default, built once in the
 * constructor, toggled via open-on-print/close()) — see
 * ui/recipe-editor.js's own doc comment for the pattern. The on-screen
 * preview reuses .setup-flow-head/-body/-foot verbatim; only the actual
 * "paper" (.rp-page) gets its own always-white/black styling, in
 * style.css's "Recipe print sheet" block, since a printed page should
 * look like paper regardless of the app's own dark cockpit theme.
 *
 * That same style.css block's `@media print` rule is what actually
 * isolates .rp-page for the physical page — collapsing the modal chrome
 * (backdrop, header, footer) and setting every *other* element on the
 * page to `visibility:hidden` for the duration, the standard "one
 * element survives @media print" technique for a single-page app. A
 * real `window.open()` popup window was the other option; skipped
 * because that's one more thing for a popup blocker to eat and doesn't
 * inherit this page's fonts/CSS custom properties for free.
 *
 * Ingredient amounts are re-derived here rather than imported from
 * ui/recipe-editor.js's _rowDisplay() — that method is entangled with
 * the editor's own live interactive state (this._rowSizeOptionId,
 * mid-render <select> wiring). This is a plain, read-only "what unit
 * would a rider actually shop/measure this in" pass over a finished
 * Recipe, so it's its own small function (_lineDisplay() below) instead
 * — same three-way priority either way (volume via densityGPerMl > a
 * sizeOptions count > plain weight), per metrics/units.js's modular
 * measurement display.
 *
 * The Print button goes through platform/print.js, not a bare
 * window.print(): that call is a silent no-op inside the MAUI shell on
 * Android and iOS/Mac Catalyst, so there it prints natively instead (see
 * Services/PrintService.cs). What gets printed there is NOT this preview:
 * _printNow() builds a separate standalone document (platform/
 * print-document.js — white paper, black ink, no app theme) from the same
 * model the preview renders and hands that to the native side. Printing the
 * live dark-themed page instead came out as an empty page in app colors
 * (and would have burned a page of ink if it had worked). Only Windows,
 * whose WebView2 print UI applies @media print correctly, still prints the
 * live page — so the preview stays on screen until the person closes it,
 * and the native paths never fire `afterprint`, which is why the auto-close
 * below only covers the browser/PWA path.
 *
 * The preview follows whatever will actually print. Where the standalone
 * document is what comes out (Android, iOS / Mac Catalyst — see
 * printUsesStandaloneDocument()), the preview is that same document in an
 * iframe laid out at real paper width (PAPER_W x PAPER_H below) and scaled to
 * fit the modal, so the on-screen page is a true miniature of the sheet:
 * same wrapping, same proportions, same column layout. Elsewhere (Windows,
 * browser) the live .rp-page below is both the preview and the print.
 *
 * Usage:
 *   const recipePrintSheet = new RecipePrintSheet($('recipe-print-sheet'), { profile });
 *   recipePrintSheet.print(recipe);                                // resolves ingredients via ingredientRepository
 *   recipePrintSheet.print(draft, { lookup: id => ingredientCache.get(id) }); // recipe-editor.js's in-memory cache instead
 */

import { ingredientRepository } from '../nutrition/ingredient-repository.js';
import { printPage, printDocumentSupportsColumns, printUsesStandaloneDocument } from '../platform/print.js';
import { buildPrintDocument } from '../platform/print-document.js';
import { macroCalorieSplit } from '../core/nutrition-model.js';
import { formatSmallWeight, mlToDisplayVolume, mlToUnit, VOLUME_UNITS, VOLUME_UNIT_LABELS,
         pluralizeUnit } from '../metrics/units.js';

export class RecipePrintSheet {
  /**
   * @param {HTMLElement} container
   * @param {Object} opts
   * @param {Object} opts.profile  Live profile object (for units.g/oz display) — same
   *   role it plays in ui/recipe-editor.js's constructor.
   */
  constructor(container, { profile } = {}) {
    this._container = container;
    this._profile = profile;
    this._jobName = 'Recipe';
    this._model = null;
    this._paper = null;        // { wrap, frame, height, observer } while the paper preview is showing
    this._printing = false;
    this._renderShell();
  }

  // ─── Shell (built once) ─────────────────────────────────────────────────

  _renderShell() {
    this._container.classList.add('setup-flow', 'hidden');
    this._container.innerHTML = `
      <div class="setup-flow-card rp-card">
        <div class="setup-flow-head">
          <span class="setup-flow-head-title">Print Recipe</span>
          <button class="setup-flow-close" id="rp-close" title="Close" aria-label="Close">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg>
          </button>
        </div>
        <div class="setup-flow-body" id="rp-body"></div>
        <div class="setup-flow-foot">
          <button class="btn btn-ghost" id="rp-cancel">Close</button>
          <button class="btn btn-primary" id="rp-print-now">Print</button>
        </div>
      </div>
    `;

    this._container.querySelector('#rp-close').addEventListener('click', () => this.close());
    this._container.querySelector('#rp-cancel').addEventListener('click', () => this.close());
    this._container.querySelector('#rp-print-now').addEventListener('click', () => this._printNow());
    this._container.addEventListener('click', e => {
      if (e.target === this._container) this.close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this._container.classList.contains('hidden')) this.close();
    });
    // The browser's print dialog's own Cancel (or an actual completed print)
    // both fire this — closing the preview after either one, same as a
    // setup-flow overlay closing itself once its job is done, rather than
    // leaving a stale preview open behind the print dialog. The native
    // shell's print flow never fires it (see the module doc comment), so
    // there the preview simply stays until the person taps Close.
    window.addEventListener('afterprint', () => this.close());
  }

  /** Hands the sheet to the platform print flow as a standalone document
   *  (see the module doc comment for why not the live page). Guarded so a
   *  double-tap can't stack two print requests — the native side would
   *  reject or crash on a second one while the first is still showing. */
  async _printNow() {
    if (this._printing || !this._model) return;
    this._printing = true;
    try {
      // Same two-column sheet as the preview where the native engine can paginate it
      // safely (Android); stacked on iOS / Mac Catalyst — see printDocumentSupportsColumns().
      const columns = printDocumentSupportsColumns() ? 2 : 1;
      await printPage(this._jobName, { html: buildPrintDocument(this._model, { columns }) });
    } finally {
      this._printing = false;
    }
  }

  close() {
    this._container.classList.add('hidden');
    this._disposePaper();
  }

  /**
   * @param {Recipe} recipe
   * @param {Object} [opts]
   * @param {(id: string) => Ingredient|null} [opts.lookup]  Sync lookup, e.g. the
   *   recipe editor's in-memory ingredient cache. Omit to resolve every
   *   ingredient line through ingredientRepository.get() instead — the
   *   Recipes tab's own saved recipes/presets don't keep a cache of their
   *   own lying around the way an in-progress editor draft does.
   */
  async print(recipe, { lookup } = {}) {
    this._jobName = recipe.name || 'Recipe';
    const ingredientLookup = lookup ?? await this._resolveViaRepository(recipe);
    this._model = this._buildModel(recipe, ingredientLookup);
    // Unhide first: the paper preview scales itself to the modal's width, which is 0
    // while the overlay is display:none.
    this._container.classList.remove('hidden');
    this._showPreview();
  }

  /** Native shells that print the standalone document get a paper-sized
   *  miniature of it; everything else gets the live sheet. */
  _showPreview() {
    this._disposePaper();
    const body = this._container.querySelector('#rp-body');
    if (!printUsesStandaloneDocument()) {
      body.innerHTML = this._renderPage(this._model);
      return;
    }

    body.innerHTML = '<div class="rp-paper-wrap"><iframe class="rp-paper-frame" title="Print preview" '
      + 'tabindex="-1" scrolling="no" sandbox="allow-same-origin"></iframe></div>';
    const wrap = body.firstElementChild;
    const frame = wrap.firstElementChild;
    const paper = { wrap, frame, height: PAPER_H, observer: null };
    this._paper = paper;

    frame.style.width = `${PAPER_W}px`;
    frame.style.height = `${PAPER_H}px`;
    frame.addEventListener('load', () => {
      // A recipe longer than one sheet just makes the sheet taller; never shorter than one page.
      const doc = frame.contentDocument;
      if (doc?.documentElement) paper.height = Math.max(PAPER_H, doc.documentElement.scrollHeight);
      frame.style.height = `${paper.height}px`;
      this._layoutPaper();
    });
    // srcdoc via the property, not an attribute string — the document is full of quotes and &#...; references.
    frame.srcdoc = buildPrintDocument(this._model, {
      columns: printDocumentSupportsColumns() ? 2 : 1,
      preview: true,
    });

    if (typeof ResizeObserver !== 'undefined') {
      paper.observer = new ResizeObserver(() => this._layoutPaper());
      paper.observer.observe(wrap);
    }
    this._layoutPaper();
  }

  /** Scales the fixed-width paper down to the modal's width (never up — a wide
   *  desktop modal shows it at 100%). transform doesn't change layout size, so
   *  the wrapper's height is set to the scaled height explicitly. */
  _layoutPaper() {
    const paper = this._paper;
    if (!paper) return;
    const available = paper.wrap.clientWidth;
    if (!available) return;
    const scale = Math.min(1, available / PAPER_W);
    paper.frame.style.transform = `scale(${scale})`;
    paper.wrap.style.height = `${Math.ceil(paper.height * scale)}px`;
  }

  _disposePaper() {
    this._paper?.observer?.disconnect();
    this._paper = null;
  }

  async _resolveViaRepository(recipe) {
    const ids = [...new Set((recipe.ingredients ?? []).map(line => line.ingredientId))];
    const pairs = await Promise.all(ids.map(async id => [id, await ingredientRepository.get(id)]));
    const map = new Map(pairs);
    return id => map.get(id) ?? null;
  }

  /** Same volume > size > weight priority as ui/recipe-editor.js's
   *  _rowDisplay(), just read-only — a size line is expressed against
   *  whichever sizeOptionId it was authored/edited with (falling back to
   *  the ingredient's first option only if that id is missing/stale),
   *  never a rider's in-session choice, since there's no interactive
   *  <select> here to choose a different one from. Likewise, a line
   *  authored/edited with an explicit unitMode (see ui/recipe-editor.js's
   *  per-row Weight/Volume/Size toggle) prints in that mode instead of
   *  falling through the density-then-sizeOptions auto-pick — a rider who
   *  forced "Weight" on a cocoa-powder line specifically because the
   *  auto-picked volume unit read oddly for it shouldn't see that same
   *  odd unit reappear the moment they print the recipe. A stale
   *  unitMode/volumeUnit (naming something the line's current ingredient
   *  no longer supports) is discarded and falls back to the auto-pick,
   *  same "never a hard error" treatment ui/recipe-editor.js's
   *  _rowDisplay() gives it.
   *
   *  Cooking-measure volume (tsp/tbsp/fl_oz/cup) and whole-item size
   *  counts ("medium onion") print as quarter-fractions via _fmtQuarter()
   *  — that's the actual resolution a rider measures either of those in
   *  at the stove (a ¼-cup scoop, half an onion). Metric volume (ml/l)
   *  stays decimal for the same reason in reverse — nobody reaches for a
   *  "¼ ml" measure. Plain weight goes through formatSmallWeight()
   *  instead: whole ounces, carrying into "X lb Y oz" once it reaches a
   *  pound, rather than a single decimal-ounce figure. */
  _lineDisplay(line, ingredient) {
    const units = this._profile?.units;
    const hasDensity = ingredient?.densityGPerMl != null;
    const hasSizes = ingredient?.sizeOptions?.length > 0;

    let mode = line.unitMode ?? null;
    if (mode === 'volume' && !hasDensity) mode = null;
    if (mode === 'size' && !hasSizes) mode = null;
    if (mode == null) mode = hasDensity ? 'volume' : (hasSizes ? 'size' : 'weight');

    if (mode === 'volume') {
      const ml = line.amountG / ingredient.densityGPerMl;
      const volumeUnits = VOLUME_UNITS[units];
      const unit = (line.volumeUnit && volumeUnits.includes(line.volumeUnit))
        ? line.volumeUnit
        : mlToDisplayVolume(ml, units)?.unit;
      if (unit) {
        const label = VOLUME_UNIT_LABELS[unit] ?? unit;
        const rawValue = mlToUnit(ml, unit);
        const isQuarter = QUARTER_MEASURE_UNITS.has(unit);
        const value = isQuarter ? _fmtQuarter(rawValue) : _fmt(rawValue);
        // Pluralize off the *rounded* value each formatter actually
        // displays, not the raw one — a raw 1.05 cups that _fmtQuarter()
        // rounds down to a bare "1" must read "1 cup", not "1 cups".
        const rounded = isQuarter ? _quarterRounded(rawValue) : _decimalRounded(rawValue);
        return `${value} ${pluralizeUnit(label, rounded)}`;
      }
    }
    if (mode === 'size') {
      const options = ingredient.sizeOptions;
      const option = options.find(o => o.id === line.sizeOptionId) ?? options[0];
      const qty = line.amountG / option.grams;
      return `${_fmtQuarter(qty)} ${pluralizeUnit(option.label, _quarterRounded(qty))}`;
    }
    return formatSmallWeight(line.amountG, units);
  }

  /** Everything the sheet shows, as plain data — shared by the on-screen
   *  preview (_renderPage) and the standalone print document, so the two can
   *  never drift apart. */
  _buildModel(recipe, lookup) {
    const split = macroCalorieSplit(recipe.perServing);
    const kcal = Math.round(split.proteinKcal + split.carbsKcal + split.fatKcal);
    const protein = Math.round(split.proteinKcal / 4);
    const carbs = Math.round(split.carbsKcal / 4);
    const fat = Math.round(split.fatKcal / 9);
    const servingsLabel = `${recipe.servings} serving${recipe.servings === 1 ? '' : 's'}`;

    return {
      title: recipe.name || 'Untitled Recipe',
      meta: [
        recipe.cuisine ? _titleCase(recipe.cuisine) : '',
        servingsLabel,
        `${kcal} kcal/serving \u00b7 P ${protein}g \u00b7 C ${carbs}g \u00b7 F ${fat}g`,
      ].filter(Boolean),
      ingredients: (recipe.ingredients ?? []).map(line => {
        const ingredient = lookup(line.ingredientId);
        return {
          amount: this._lineDisplay(line, ingredient),
          name: ingredient?.name ?? 'Removed ingredient',
        };
      }),
      steps: (recipe.steps ?? []).filter(s => s.trim()),
    };
  }

  _renderPage(model) {
    const ingredientItems = model.ingredients.map(i => `
        <li>
          <span class="rp-ing-amount">${_esc(i.amount)}</span>
          <span class="rp-ing-name">${_esc(i.name)}</span>
        </li>
      `).join('');

    const stepItems = model.steps.map(step => `<li>${_esc(step)}</li>`).join('');

    return `
      <div class="rp-page">
        <header class="rp-head">
          <h1 class="rp-title">${_esc(model.title)}</h1>
          <div class="rp-head-meta">
            ${model.meta.map(m => `<span>${_esc(m)}</span>`).join('')}
          </div>
        </header>
        <div class="rp-body">
          <section class="rp-ingredients">
            <h2>Ingredients</h2>
            <ul>${ingredientItems || '<li class="rp-empty">No ingredients listed.</li>'}</ul>
          </section>
          <section class="rp-method">
            <h2>Method</h2>
            ${stepItems ? `<ol>${stepItems}</ol>` : '<p class="rp-empty">No steps recorded \u2014 cook to taste.</p>'}
          </section>
        </div>
      </div>
    `;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** US Letter at 96 CSS px/inch — the paper the preview is laid out on. A4
 *  (794 x 1123) is close enough that the wrapping barely differs; the real
 *  paper size is whatever the person picks in the print dialog. */
const PAPER_W = 816;
const PAPER_H = 1056;

/** Trims a rounded display value down to at most 1 decimal, without a
 *  trailing ".0" on whole numbers — e.g. 4 (not "4.0"), 1.5. */
function _fmt(v) {
  if (v == null || !isFinite(v)) return '0';
  const rounded = Math.round(v * 10) / 10;
  return String(rounded);
}

/** Same rounding _fmt() applies to derive its display text, just handed
 *  back as a plain number instead of a string — feeds pluralizeUnit()'s
 *  `value` check without re-deriving the rounding rule at the call site,
 *  and without parsing back out of whatever _fmt() already stringified. */
function _decimalRounded(v) {
  if (v == null || !isFinite(v)) return 0;
  return Math.round(v * 10) / 10;
}

/** Same rounding _fmtQuarter() applies — see _decimalRounded()'s doc
 *  comment, just against quarter-units instead of tenths. */
function _quarterRounded(v) {
  if (v == null || !isFinite(v)) return 0;
  return Math.round(v * 4) / 4;
}

/** Cooking-measure volume units a rider actually owns quarter-marked
 *  scoops/spoons for — see _fmtQuarter()'s doc comment. Metric ml/l are
 *  deliberately excluded (nobody measures ml in quarters). */
const QUARTER_MEASURE_UNITS = new Set(['tsp', 'tbsp', 'fl_oz', 'cup']);

/** Rounds a measuring-cup/spoon amount or whole-item count to the nearest
 *  quarter-unit and renders it as a fraction — "¼", "½", "1¾" — instead of
 *  _fmt()'s decimal (which reads oddly here: 0.25 rounds to "0.3" at one
 *  decimal place, not the clean quarter it actually is). Whole numbers
 *  print bare (no trailing fraction) same as _fmt()'s no-trailing-".0"
 *  behavior. */
const QUARTER_GLYPHS = { 1: '\u00bc', 2: '\u00bd', 3: '\u00be' }; // ¼ ½ ¾
function _fmtQuarter(v) {
  if (v == null || !isFinite(v)) return '0';
  const quarters = Math.round(v * 4);
  const whole = Math.floor(quarters / 4);
  const rem = quarters % 4;
  if (rem === 0) return String(whole);
  return whole > 0 ? `${whole}${QUARTER_GLYPHS[rem]}` : QUARTER_GLYPHS[rem];
}

function _titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function _esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export default RecipePrintSheet;
