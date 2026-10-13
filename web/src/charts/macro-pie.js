// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * charts/macro-pie.js
 *
 * A small standalone SVG module — not an extension of charts/chart-engine.js
 * (canvas, time-series, pan/zoom — none of that applies here; see
 * DIET_PANEL_DESIGN.md §8 for why this stays its own file, the same way
 * charts/chart-carousel.js stays separate from chart-engine.js today).
 *
 * Each macro is drawn as its own true annulus wedge — a path with an outer
 * arc at R, an inner arc at HOLE_R, and two straight radial edges joining
 * them — rather than a solid pie slice from the shared center that gets
 * covered by a separate hole circle. That means no masking circle is
 * needed to punch the center out, and (more importantly) the gap between
 * neighboring slices is opened by shrinking each slice's own start/end
 * angle by a small, fixed amount (see GAP_DEG) instead of translating the
 * whole slice sideways along its bisector. An angular inset stays even
 * regardless of how lopsided the real proportions are; a sideways
 * translate does not — two very differently-sized slices end up shifted
 * by the same pixel amount in opposite directions, which opens a
 * lopsided-looking notch at one seam and throws the ring's apparent
 * thickness off on both sides of it (the earlier version of this file did
 * it that way, generalizing the tab-bar icon's `.diet-slice` technique,
 * which only looks right because that icon's three wedges are always
 * fixed equal thirds).
 *
 * Same three color tokens (--color-protein/--color-carbs/--color-fat) as
 * the tab-bar icon, so the icon still reads as a small preview of the
 * exact chart it opens into, even though the two no longer share a
 * wedge-drawing technique under the hood.
 *
 * Layout: the donut sits in its own grid column on the left; the legend
 * sits in the column to its right as its own mini grid (dot/label/value
 * columns shared across every row, headers and sub rows alike), so
 * everything lines up like a small table instead of wrapping
 * center-justified underneath. See .macro-pie/.macro-pie-legend in
 * style.css. The caption that used to run below the whole chart now lives
 * in views/diet.js's circled-i badge (.macro-pie-info) pinned over the
 * donut's top-left corner instead.
 *
 * The legend itself is two tiers: one header row per macro (unchanged
 * dot+label+pct/kcal styling, still driven by MACRO_DEFS/kcalByKey below)
 * plus a handful of smaller sub rows breaking that macro down further —
 * Saturated, Monounsaturated, Polyunsaturated and Trans Fat plus
 * Cholesterol under Fat; Dietary Fiber and Total Sugars under Carbs.
 * LEGEND_ORDER controls only the *legend's*
 * header ordering (Fat, Carbs, Protein — the order those same three
 * lines appear on a Nutrition Facts label); it's kept separate from
 * MACRO_DEFS's own order so the donut's wedge sweep (which macro starts
 * at 12 o'clock) doesn't change along with it.
 *
 * Every vitamin and mineral NutrientProfile tracks — Sodium (salt)
 * included, even though it's stored as its own top-level field rather
 * than under `minerals` — plus Starch, the one carb field the headers
 * above don't break out (Fat's own fields are now all covered by the
 * legend's Fat sub rows), live in a collapsed-by-default "Advanced
 * nutrition info" panel spanning the full width beneath both the donut
 * and the legend (ADVANCED_ROWS/_advancedSection() below), rather than
 * in the legend itself. Expand state is owned by the caller (views/
 * diet.js's `_macroAdvancedOpen`), not this module — see the
 * `advancedOpen` param doc below for why.
 *
 * Usage:
 *   import { renderMacroPie } from './charts/macro-pie.js';
 *   renderMacroPie(container, {
 *     proteinKcal: 240, carbsKcal: 420, fatKcal: 180, targetKcal: 2100,
 *     nutrients: sumNutrients(...), // full NutrientProfile (core/nutrition-model.js) for the sub rows; omit/null to render them as all-zero
 *     advancedOpen: false, // whether the Advanced nutrition info panel is expanded
 *   });
 */

import { NUTRIENT_REFERENCE, nutrientStatusList, focusNutrients, watchNutrients }
                                 from '../metrics/daily-values.js';

const CX = 100, CY = 100, R = 90, HOLE_R = 58;

// Total angular gap opened at each seam between two visible slices, split
// evenly across the two slices that share that seam. Only applied when
// more than one macro is actually logged — a single 100% macro (or the
// empty state) draws as one unbroken ring with nothing to separate from.
const GAP_DEG = 3;

const MACRO_DEFS = [
  { key: 'protein', label: 'Protein', colorVar: '--color-protein' },
  { key: 'carbs',   label: 'Carbs',   colorVar: '--color-carbs' },
  { key: 'fat',     label: 'Fat',     colorVar: '--color-fat' },
];

// Legend-only header order — Fat, Carbs, Protein, matching the order
// those three lines run down a Nutrition Facts label. Deliberately not
// the order MACRO_DEFS/the donut wedges use (see file docstring).
const LEGEND_ORDER = ['fat', 'carbs', 'protein'];

// Sub rows nested under each macro header, in NutrientProfile field order
// (saturated/monounsaturated/polyunsaturated/trans, per fat's own field
// order in core/nutrition-model.js) with Cholesterol tacked on at the end
// since it isn't itself a `fat` field. `get` reads off a full
// NutrientProfile; missing/null resolves to 0 the same way the header
// rows already treat an unlogged macro as 0% rather than skipping the
// row. Monounsaturated/Polyunsaturated Fat used to live down in
// ADVANCED_ROWS with the rest of the fat/carb detail the headers don't
// break out, but have moved up here so the two make-up-most-of-dietary-
// fat numbers are visible without opening Advanced nutrition info.
// Sodium used to sit here under Fat too (it runs alongside Cholesterol
// on a Nutrition Facts label) but has moved down into ADVANCED_ROWS with
// the rest of the vitamins/minerals — see that block below for why.
const SUB_ROWS_BY_MACRO = {
  fat: [
    { label: 'Saturated',       unit: 'g',  get: n => n?.fat?.saturated },
    { label: 'Monounsaturated', unit: 'g',  get: n => n?.fat?.monounsaturated },
    { label: 'Polyunsaturated', unit: 'g',  get: n => n?.fat?.polyunsaturated },
    { label: 'Trans',           unit: 'g',  get: n => n?.fat?.trans },
    { label: 'Cholesterol',         unit: 'mg', get: n => n?.cholesterolMg },
  ],
  carbs: [
    { label: 'Dietary Fiber', unit: 'g',   get: n => n?.carbs?.fiber },
    { label: 'Total Sugars',  unit: 'g',   get: n => n?.carbs?.sugar },
  ],
  protein: [],
};

// Everything else core/nutrition-model.js's NutrientProfile tracks —
// every vitamin and mineral (Sodium included, i.e. salt, even though
// it's tracked as its own top-level field rather than under `minerals`)
// plus Starch, the one carb field the Carbs header's own sub rows above
// don't break out (Fat's fields are now all covered by SUB_ROWS_BY_MACRO
// above). None of it drives the compact legend at all now; it's rendered
// only inside the collapsed-by-default "Advanced nutrition info" panel
// (see _advancedSection() below), split across two side-by-side columns
// there since the panel spans the chart's full width rather than just
// the legend's narrower column. Starch, then Sodium, then vitamins
// (A/C/D/E/K, then the B-complex, then Folate — core/nutrition-model.js's
// own vitamins-object field order), then minerals alphabetically
// (Potassium included, same reasoning as Sodium above).
//
// `key` links each row to its metrics/daily-values.js#NUTRIENT_REFERENCE
// entry — what _advancedRow() below looks up a %DV badge from. Starch is
// the one row with no key at all (`null`): same as a real Nutrition
// Facts label, it has no established Daily Value, so its badge cell
// renders empty rather than a fabricated number.
const ADVANCED_ROWS = [
  { key: null,         label: 'Starch',      unit: 'g',   get: n => n?.carbs?.starch },
  { key: 'sodium',     label: 'Sodium',      unit: 'mg',  get: n => n?.sodiumMg },
  { key: 'vitaminA',   label: 'Vitamin A',   unit: 'mcg', get: n => n?.vitamins?.aMcg },
  { key: 'vitaminC',   label: 'Vitamin C',   unit: 'mg',  get: n => n?.vitamins?.cMg },
  { key: 'vitaminD',   label: 'Vitamin D',   unit: 'mcg', get: n => n?.vitamins?.dMcg },
  { key: 'vitaminE',   label: 'Vitamin E',   unit: 'mg',  get: n => n?.vitamins?.eMg },
  { key: 'vitaminK',   label: 'Vitamin K',   unit: 'mcg', get: n => n?.vitamins?.kMcg },
  { key: 'thiamin',    label: 'Vitamin B1',  unit: 'mg',  get: n => n?.vitamins?.b1Mg },
  { key: 'riboflavin', label: 'Vitamin B2',  unit: 'mg',  get: n => n?.vitamins?.b2Mg },
  { key: 'niacin',     label: 'Vitamin B3',  unit: 'mg',  get: n => n?.vitamins?.b3Mg },
  { key: 'vitaminB6',  label: 'Vitamin B6',  unit: 'mg',  get: n => n?.vitamins?.b6Mg },
  { key: 'vitaminB12', label: 'Vitamin B12', unit: 'mcg', get: n => n?.vitamins?.b12Mcg },
  { key: 'folate',     label: 'Folate',      unit: 'mcg', get: n => n?.vitamins?.folateMcg },
  { key: 'calcium',    label: 'Calcium',     unit: 'mg',  get: n => n?.minerals?.calciumMg },
  { key: 'iron',       label: 'Iron',        unit: 'mg',  get: n => n?.minerals?.ironMg },
  { key: 'magnesium',  label: 'Magnesium',   unit: 'mg',  get: n => n?.minerals?.magnesiumMg },
  { key: 'potassium',  label: 'Potassium',   unit: 'mg',  get: n => n?.potassiumMg },
  { key: 'zinc',       label: 'Zinc',        unit: 'mg',  get: n => n?.minerals?.zincMg },
];

/**
 * Renders the macro donut into `container` (replaces its innerHTML).
 *
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {number} [opts.proteinKcal=0]
 * @param {number} [opts.carbsKcal=0]
 * @param {number} [opts.fatKcal=0]
 * @param {number|null} [opts.targetKcal=null]  From metrics/nutrition.js's
 *   dailyCalorieBalance() budgetKcal — null when BMR inputs aren't filled
 *   in yet, same empty-state-degrades-gracefully approach as
 *   _pwrCard()/_vo2MaxCard() in views/overview.js.
 * @param {import('../core/nutrition-model.js').NutrientProfile|null} [opts.nutrients=null]
 *   Full summed profile (core/nutrition-model.js's sumNutrients() output)
 *   backing the legend's sub rows — fiber, sugar, saturated/mono/poly-
 *   unsaturated/trans fat, cholesterol — and, when expanded, the Advanced
 *   nutrition info panel's vitamins/minerals/sodium and remaining starch
 *   detail. Only
 *   proteinKcal/carbsKcal/fatKcal/targetKcal drive the donut itself and
 *   the three header rows' pct/kcal; null renders every sub row as 0,
 *   the same graceful-empty-state treatment the headers already get.
 * @param {boolean} [opts.advancedOpen=false]  Whether the "Advanced
 *   nutrition info" panel (ADVANCED_ROWS) is currently expanded. Plain
 *   state owned by the caller (views/diet.js's `_macroAdvancedOpen`,
 *   toggled by its own click handler) rather than this module, the same
 *   full-re-render-loses-native-<details>-state reasoning documented on
 *   style.css's `.diet-filter-toggle` — this button is a `<button>`, not
 *   a `<summary>`, so its open/closed state has to survive the next
 *   renderMacroPie() call from outside.
 * @param {Object|null} [opts.profile=null]  Live profile object — only
 *   riderWeight/sex are read (via metrics/daily-values.js#dailyValueFor()),
 *   same two fields metrics/nutrition.js#estimateBmr() already reads off
 *   it. Missing/null degrades to the flat FDA label %DV, same as an
 *   unfilled-in Rider Profile everywhere else in this panel.
 * @param {boolean} [opts.smartFilterOn=false]  Whether the "Today's focus"
 *   overview's Log-food smart filter toggle (views/diet.js's
 *   `_smartFilterOn`) is currently on — purely reflected back into the
 *   toggle's own checked state here; the actual filtering happens in
 *   views/diet.js's _renderSearchResults(), not this module.
 */
export function renderMacroPie(container, { proteinKcal = 0, carbsKcal = 0, fatKcal = 0, targetKcal = null, nutrients = null, advancedOpen = false, profile = null, smartFilterOn = false } = {}) {
  const kcalByKey = { protein: Math.max(0, proteinKcal || 0), carbs: Math.max(0, carbsKcal || 0), fat: Math.max(0, fatKcal || 0) };
  const totalKcal = kcalByKey.protein + kcalByKey.carbs + kcalByKey.fat;

  const centerHtml = `
    <div class="macro-pie-center">
      <span class="macro-pie-total">${Math.round(totalKcal)}</span>
      <span class="macro-pie-target">${targetKcal != null ? `/ ${Math.round(targetKcal)} kcal` : 'kcal logged'}</span>
    </div>
  `;

  // Read off kcalByKey regardless of whether anything's actually been
  // logged yet — an all-zero split still names which color is which
  // macro, so a rider isn't left without that reference right when they
  // most need it (before their first entry of the day). totalKcal === 0
  // would otherwise divide-by-zero into NaN%, so pct is guarded to 0 in
  // that case instead of skipping the row. Same reasoning extends to the
  // sub rows below: _subRow() reads through a null `nutrients` as 0
  // rather than the group disappearing.
  const legendHtml = `
    <div class="macro-pie-legend">${
      LEGEND_ORDER.map(key => {
        const def = MACRO_DEFS.find(d => d.key === key);
        const kcal = kcalByKey[def.key];
        const pct = totalKcal > 0 ? Math.round((kcal / totalKcal) * 100) : 0;
        const subRows = SUB_ROWS_BY_MACRO[def.key].map(row => _subRow(row, nutrients)).join('');
        return _legendHeader(def, kcal, pct) + subRows;
      }).join('')
    }</div>
  `;

  const advancedHtml = _advancedSection(nutrients, advancedOpen, profile, targetKcal, smartFilterOn);

  if (totalKcal <= 0) {
    container.innerHTML = `
      <div class="macro-pie">
        <svg class="macro-pie-svg" viewBox="0 0 200 200" aria-hidden="true">
          <circle cx="${CX}" cy="${CY}" r="${R}" class="macro-pie-empty-ring"></circle>
        </svg>
        ${centerHtml}
        ${legendHtml}
        ${advancedHtml}
      </div>
    `;
    return;
  }

  const activeCount = MACRO_DEFS.reduce((n, def) => n + (kcalByKey[def.key] > 0 ? 1 : 0), 0);

  let angle = -90; // 12 o'clock, sweeping clockwise — same start every render so re-renders don't visually "rotate"
  const wedges = [];

  for (const def of MACRO_DEFS) {
    const kcal = kcalByKey[def.key];
    if (kcal <= 0) continue;

    const sweep = (kcal / totalKcal) * 360;
    const startAngle = angle;
    const endAngle = angle + sweep;
    angle = endAngle;

    const isFullCircle = sweep >= 359.99; // the one-macro-logged-so-far case

    const d = isFullCircle
      ? _annulusPath()
      : _wedgePath(startAngle, endAngle, activeCount);

    wedges.push(
      `<path class="macro-pie-slice" fill="var(${def.colorVar})" fill-rule="evenodd" d="${d}"></path>`
    );
  }

  container.innerHTML = `
    <div class="macro-pie">
      <svg class="macro-pie-svg" viewBox="0 0 200 200">
        ${wedges.join('')}
      </svg>
      ${centerHtml}
      ${legendHtml}
      ${advancedHtml}
    </div>
  `;
}

// Builds one slice as a true annulus wedge: outer arc at R, straight edge
// in to the inner arc at HOLE_R, inner arc back, straight edge out to
// close. `activeCount > 1` shrinks the slice's start/end by half of
// GAP_DEG each — clamped so a very thin sliver can't invert past its own
// midpoint — so every visible seam opens the same small gap no matter how
// unevenly the three macros split the circle.
function _wedgePath(startAngle, endAngle, activeCount) {
  const sweep = endAngle - startAngle;
  const inset = activeCount > 1 ? Math.min(GAP_DEG / 2, Math.max(0, sweep / 2 - 0.25)) : 0;
  const a1 = startAngle + inset;
  const a2 = endAngle - inset;
  const largeArc = (a2 - a1) > 180 ? 1 : 0;

  const [ox1, oy1] = _pointOnCircle(a1, R);
  const [ox2, oy2] = _pointOnCircle(a2, R);
  const [ix2, iy2] = _pointOnCircle(a2, HOLE_R);
  const [ix1, iy1] = _pointOnCircle(a1, HOLE_R);

  return `M ${ox1} ${oy1} A ${R} ${R} 0 ${largeArc} 1 ${ox2} ${oy2} L ${ix2} ${iy2} A ${HOLE_R} ${HOLE_R} 0 ${largeArc} 0 ${ix1} ${iy1} Z`;
}

// Full unbroken ring (one macro at 100%, or the covering shape a wedge
// would need if it ever had no neighbor) — two concentric circles with
// opposite winding, painted evenodd so the inner one punches the hole.
function _annulusPath() {
  return (
    `M ${CX + R} ${CY} A ${R} ${R} 0 1 1 ${CX - R} ${CY} A ${R} ${R} 0 1 1 ${CX + R} ${CY} Z ` +
    `M ${CX + HOLE_R} ${CY} A ${HOLE_R} ${HOLE_R} 0 1 0 ${CX - HOLE_R} ${CY} A ${HOLE_R} ${HOLE_R} 0 1 0 ${CX + HOLE_R} ${CY} Z`
  );
}

function _legendHeader(def, kcal, pct) {
  return `
    <div class="macro-pie-legend-item">
      <span class="macro-pie-legend-dot" style="background: var(${def.colorVar})"></span>
      <span class="macro-pie-legend-label">${def.label}</span>
      <span class="macro-pie-legend-value">${pct}% · ${Math.round(kcal)} kcal</span>
    </div>
  `;
}

// The "Advanced nutrition info" toggle + its two-column detail panel —
// one `<button>` (state lives in the caller, see the advancedOpen
// doc-comment above) plus, only while expanded, ADVANCED_ROWS split
// into left/right halves so all twenty rows fit in roughly the same
// height a scroll of the compact legend would otherwise take, each row
// now also carrying a %DV badge (see _advancedRow()/_dvBadge() below),
// plus the "Today's focus" overview (_focusOverview()) spanning full
// width underneath both columns. Both the toggle and the body get
// `grid-column: 1 / -1` in style.css so they run the full width of the
// chart underneath *both* the donut and the legend column, not just one
// or the other.
function _advancedSection(nutrients, open, profile, targetKcal, smartFilterOn) {
  const mid = Math.ceil(ADVANCED_ROWS.length / 2);
  const columns = [ADVANCED_ROWS.slice(0, mid), ADVANCED_ROWS.slice(mid)];
  // Only computed while expanded — same "don't do work behind a
  // collapsed panel" reasoning the row markup itself already followed
  // before this. Status covers every NUTRIENT_REFERENCE key (not just
  // the ones ADVANCED_ROWS renders a badge for), since focusNutrients()/
  // watchNutrients() below also need to weigh in protein/fiber/potassium/
  // saturated fat/cholesterol — the ones the compact legend already
  // shows a bare amount for — even though those don't get a second badge
  // rendered down here.
  const status = open ? nutrientStatusList(nutrients, { profile, targetKcal }) : [];
  return `
    <button type="button" class="macro-pie-advanced-toggle" aria-expanded="${open}" aria-controls="macro-pie-advanced-body">
      <span>Advanced nutrition info</span>
      <svg class="btn-icon macro-pie-advanced-chevron ${open ? 'open' : ''}" viewBox="0 0 24 24"><use href="#icon-chevron-down"/></svg>
    </button>
    <div class="macro-pie-advanced-body" id="macro-pie-advanced-body" ${open ? '' : 'hidden'}>
      ${open ? columns.map(col => `
        <div class="macro-pie-advanced-col">${col.map(row => _advancedRow(row, nutrients, status)).join('')}</div>
      `).join('') : ''}
      ${open ? _focusOverview(status, smartFilterOn) : ''}
    </div>
  `;
}

// One Advanced-panel row — same dot/label/value shape _subRow() draws
// for the compact legend's sub rows, plus a fourth cell carrying this
// nutrient's %DV wherever metrics/daily-values.js has one established
// for it. A dedicated function rather than reusing _subRow() because
// that fourth cell means a 4-column grid (.macro-pie-advanced-col)
// instead of _subRow()'s 3 — mixing row shapes within one
// `display: contents` grid would silently shift every following row
// over by a column.
function _advancedRow(row, nutrients, status) {
  const amount = row.get(nutrients) ?? 0;
  const stat = row.key ? status.find(s => s.key === row.key) : null;
  return `
    <div class="macro-pie-legend-item macro-pie-advanced-row">
      <span class="macro-pie-legend-subdot"></span>
      <span class="macro-pie-legend-sublabel">${row.label}</span>
      <span class="macro-pie-legend-subvalue">${_fmtAmount(amount)} ${row.unit}</span>
      ${_dvBadge(stat)}
    </div>
  `;
}

// Tone mirrors how a rider would read the number themselves off a real
// label: a get-more-of nutrient turns --good once it clears 100%
// (nothing bad happens above 100% on, say, Vitamin C); Sodium — the one
// nutrient-to-limit that lives down in this panel, see ADVANCED_ROWS
// above (Saturated Fat/Cholesterol are upperLimit too but surface up in
// the compact legend instead) — turns --warn approaching its own 100%
// and --over past it. Empty markup (not just empty text) for a row with
// no `stat` at all (Starch, which has no established DV, or the rare
// case percentDailyValue() itself returns null — see that function's own
// doc comment), so the grid cell collapses to nothing instead of an
// empty pill taking up space.
function _dvBadge(stat) {
  if (!stat || stat.pct == null) return '<span class="macro-pie-dv-badge"></span>';
  const pct = stat.pct;
  const tone = stat.upperLimit
    ? (pct >= 100 ? 'over' : pct >= 60 ? 'warn' : 'ok')
    : (pct >= 100 ? 'good' : 'ok');
  const display = pct >= 1000 ? '999+' : Math.round(pct);
  return `<span class="macro-pie-dv-badge macro-pie-dv-${tone}">${display}%</span>`;
}

// "Today's focus" mini overview — the full-width row under both Advanced
// columns. Names the nutrients focusNutrients()/watchNutrients() single
// out of the exact same `status` list _advancedRow() above just drew its
// %DV badges from, so a chip here and a row's own badge never disagree.
// Also renders the Log-food smart filter toggle — plain checkbox state
// reflected back in via `smartFilterOn`; the actual filtering/reordering
// of search results happens in views/diet.js's _renderSearchResults(),
// not here, same "this module only renders, the caller owns behavior"
// split advancedOpen itself already follows.
function _focusOverview(status, smartFilterOn) {
  const focus = focusNutrients(status, { limit: 4 });
  const watch = watchNutrients(status, { thresholdPct: 60 });

  return `
    <div class="diet-focus-overview">
      <div class="diet-focus-row">
        <svg class="btn-icon diet-focus-icon" viewBox="0 0 24 24"><use href="#icon-lightning"/></svg>
        <span class="diet-focus-label">Focus on</span>
        <div class="diet-focus-chips">${focus.map(_focusChip).join('')}</div>
      </div>
      ${watch.length ? `
        <div class="diet-focus-row diet-focus-row-watch">
          <svg class="btn-icon diet-focus-icon" viewBox="0 0 24 24"><use href="#icon-flame"/></svg>
          <span class="diet-focus-label">Watch</span>
          <div class="diet-focus-chips">${watch.map(_focusChip).join('')}</div>
        </div>
      ` : ''}
      <div class="diet-smart-filter-row">
        <div class="diet-smart-filter-text">
          <span class="diet-smart-filter-title">Smart filter</span>
          <span class="diet-smart-filter-hint">Sorts Log food matches (ingredients and recipes alike) toward what's listed above, and hides anything that would push a Watch nutrient past 100% — or that's already high enough on its own, like a recipe with sodium within 5% of the full daily limit.</span>
        </div>
        <label class="switch switch-sm">
          <input type="checkbox" class="diet-smart-filter-toggle"${smartFilterOn ? ' checked' : ''}>
          <span class="switch-track"></span>
          <span class="switch-thumb"></span>
        </label>
      </div>
    </div>
  `;
}

// One focus/watch chip — label plus %DV, with a quick fill-bar (the
// inline --pct custom property, read by style.css's ::before) standing
// in for the number so it reads at a glance rather than needing to be
// parsed. Capped at 100% width even when the real pct runs past that
// (a rider well over a limit still just gets a full bar, not an
// overflowing one).
function _focusChip(stat) {
  const pct = Math.max(0, stat.pct ?? 0);
  const barPct = Math.min(100, pct);
  return `
    <span class="diet-focus-chip" style="--pct:${barPct}%">
      <span class="diet-focus-chip-label">${stat.label}</span>
      <span class="diet-focus-chip-pct">${Math.round(pct)}%</span>
    </span>
  `;
}

// One smaller, undotted detail row — nested under a macro header in the
// compact legend, or standalone inside the Advanced nutrition info
// panel's columns — same three-column grid as _legendHeader() so its
// label/value still line up with every other row, just at
// .macro-pie-legend-sub*'s smaller size (see style.css).
function _subRow(row, nutrients) {
  const amount = row.get(nutrients) ?? 0;
  return `
    <div class="macro-pie-legend-item macro-pie-legend-subrow">
      <span class="macro-pie-legend-subdot"></span>
      <span class="macro-pie-legend-sublabel">${row.label}</span>
      <span class="macro-pie-legend-subvalue">${_fmtAmount(amount)} ${row.unit}</span>
    </div>
  `;
}

// One decimal place below 10 (of whichever unit — g/mg/mcg), otherwise a
// whole number — below 10 a whole-number round would otherwise flatten
// every small fiber/sugar/vitamin reading down to the same 0/1 handful
// of values.
function _fmtAmount(amount) {
  const value = Math.max(0, amount || 0);
  return value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
}

function _pointOnCircle(angleDeg, radius) {
  const rad = _deg2rad(angleDeg);
  return [(CX + radius * Math.cos(rad)).toFixed(3), (CY + radius * Math.sin(rad)).toFixed(3)];
}

function _deg2rad(deg) { return (deg * Math.PI) / 180; }

export default { renderMacroPie };
