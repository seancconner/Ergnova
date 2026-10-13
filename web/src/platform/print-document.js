// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * platform/print-document.js
 *
 * Builds a complete, self-contained HTML document for a printable recipe —
 * its own <style>, no external CSS, fonts, scripts or app theme tokens. The
 * native shell hands this string straight to the platform's print machinery
 * (Android: an off-screen WebView; iOS / Mac Catalyst: UIMarkupTextPrintFormatter
 * — see Services/PrintService.cs) instead of asking the OS to print the live,
 * dark-themed app page.
 *
 * Why not just print the live page with @media print rules: that only works
 * where the platform's print engine actually lays the page out with print
 * media, ignores the app's own `html, body { background: var(--bg-app) }`
 * near-black fill, and can paginate a `position: fixed` overlay inside an
 * `overflow: hidden` cockpit layout. Where any of those don't hold, the
 * output is an empty page painted in app colors. A dedicated document has no
 * dependence on any of it: white paper, black ink, ordinary document flow.
 *
 * Deliberately conservative markup/CSS, because one of the consumers
 * (UIMarkupTextPrintFormatter) is an older WebKit text renderer, not a full
 * browser:
 *   - two layouts, picked by the caller (`columns` option). Stacked single
 *     column (the default) is plain normal flow, so a long recipe always
 *     paginates instead of being clipped at the end of the first page —
 *     that's the one iOS / Mac Catalyst gets. Two columns (ingredients left,
 *     method right, like the on-screen preview) is a plain <table>, never
 *     grid/flex, and is only for engines known to split a tall table row
 *     across pages — Android's Chromium WebView. See
 *     platform/print.js's printDocumentSupportsColumns().
 *   - only white background and black/grey ink, no filled areas at all
 *     (ink-saving is the whole point); `print-color-adjust: economy` asks
 *     browser-style engines not to force backgrounds even if one slips in
 *   - system font stack — nothing to download at print time
 *   - pure-ASCII output: every non-ASCII character (the ¼ ½ ¾ fractions, the
 *     · separators, the — dash, accented ingredient names) is written as a
 *     numeric character reference. The document crosses a JS -> JSON ->
 *     C# -> platform-print-engine hop, and any step of it that guesses the
 *     wrong text encoding turns those characters into "?" in a diamond
 *     (U+FFFD). Entities have no encoding to guess wrong.
 *
 * Pure function, no imports, no DOM access.
 */

/**
 * @typedef {Object} PrintModel
 * @property {string}   title
 * @property {string[]} [meta]         short header chips, joined with " · "
 * @property {{amount: string, name: string}[]} [ingredients]
 * @property {string[]} [steps]
 * @property {string}   [emptyIngredients]
 * @property {string}   [emptySteps]
 */

const PRINT_CSS = `
  @page { margin: 14mm; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #000;
    -webkit-print-color-adjust: economy;
    print-color-adjust: economy;
  }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.4;
  }
  h1 { font-size: 20pt; font-weight: 800; margin: 0 0 4pt; }
  .meta {
    font-size: 10pt;
    margin: 0 0 12pt;
    padding-bottom: 8pt;
    border-bottom: 1.5pt solid #000;
  }
  h2 {
    font-size: 10pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .05em;
    margin: 14pt 0 6pt;
    padding-bottom: 3pt;
    border-bottom: .75pt solid #000;
    page-break-after: avoid;
  }
  ul.ing { list-style: none; margin: 0; padding: 0; }
  ul.ing li { margin: 0 0 4pt; page-break-inside: avoid; }
  ul.ing b { font-weight: 700; }
  ol.steps { margin: 0; padding-left: 20pt; }
  ol.steps li { margin: 0 0 8pt; padding-left: 2pt; page-break-inside: avoid; }
  .empty { font-style: italic; margin: 0; }

  /* Two-column layout (columns: 2). A table, not grid: rows may break across
     pages, and the ratio matches the preview's 1fr : 1.6fr. */
  table.cols { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.cols, table.cols tr, table.cols td { page-break-inside: auto; }
  table.cols td { vertical-align: top; padding: 0; }
  table.cols td.c-ing { width: 38%; padding-right: 16pt; }
  table.cols td.c-method { width: 62%; }
  table.cols h2 { margin-top: 0; }
`;

/* On-screen preview only: @page margins don't apply outside real printing, so
   the same 14mm becomes body padding to make the frame read as a sheet of paper. */
const PREVIEW_CSS = `
  body { padding: 14mm; }
`;

/**
 * @param {PrintModel} model
 * @param {Object} [opts]
 * @param {1|2} [opts.columns=1]  2 = ingredients and method side by side (see the
 *   doc comment above for who may ask for that); anything else = stacked
 * @param {boolean} [opts.preview=false]  for showing the page on screen (ui/recipe-print.js
 *   puts it in an iframe): adds the page margin as body padding, since @page margins
 *   only apply when actually printing. Never set for the document that gets printed.
 * @returns {string} a full HTML document (ASCII only)
 */
export function buildPrintDocument(model, { columns = 1, preview = false } = {}) {
  const title = model.title || 'Recipe';
  const meta = (model.meta ?? []).filter(Boolean);
  const ingredients = model.ingredients ?? [];
  const steps = (model.steps ?? []).filter(s => String(s ?? '').trim());

  const ingredientList = ingredients.length
    ? `<ul class="ing">${ingredients.map(i =>
        `<li><b>${_esc(i.amount)}</b> ${_esc(i.name)}</li>`).join('')}</ul>`
    : `<p class="empty">${_esc(model.emptyIngredients ?? 'No ingredients listed.')}</p>`;

  const stepList = steps.length
    ? `<ol class="steps">${steps.map(s => `<li>${_esc(s)}</li>`).join('')}</ol>`
    : `<p class="empty">${_esc(model.emptySteps ?? 'No steps recorded \u2014 cook to taste.')}</p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${_esc(title)}</title>
<style>${PRINT_CSS}${preview ? PREVIEW_CSS : ''}</style>
</head>
<body>
<h1>${_esc(title)}</h1>
${meta.length ? `<p class="meta">${meta.map(_esc).join(' \u00b7 ')}</p>` : ''}
${columns === 2
    ? `<table class="cols"><tr>
<td class="c-ing"><h2>Ingredients</h2>${ingredientList}</td>
<td class="c-method"><h2>Method</h2>${stepList}</td>
</tr></table>`
    : `<h2>Ingredients</h2>
${ingredientList}
<h2>Method</h2>
${stepList}`}
</body>
</html>`;
  return _asciiOnly(html);
}

/** Every character above plain ASCII becomes a numeric character reference —
 *  see the doc comment for why. Safe to run over the whole document: tags and
 *  CSS are ASCII already, so only text content and the title can be touched. */
function _asciiOnly(html) {
  let out = '';
  for (const ch of html) {                 // iterates code points, not UTF-16 units
    const cp = ch.codePointAt(0);
    if (cp < 127) out += ch;
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '&#65533;';   // lone surrogate
    else out += `&#${cp};`;
  }
  return out;
}

function _esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export default buildPrintDocument;
