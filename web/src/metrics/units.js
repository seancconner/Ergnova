// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/units.js
 *
 * Shared conversion helpers for the Metric/Imperial units preference.
 * Canonical storage stays metric everywhere it matters for physics or
 * portability — session samples (km/h, meters), rider/bike weight (kg) in
 * profile/IndexedDB, and every file export (FIT/TCX/GPX all expect metric).
 * These helpers only convert values at the display boundary: Settings
 * inputs, chart labels/axes, and History cards.
 *
 * Usage:
 *   import { formatDistance, kmhToDisplaySpeed, formatPace } from './metrics/units.js';
 *   formatDistance(12345, 'imperial');   // "7.7 mi"
 *   kmhToDisplaySpeed(30, 'imperial');   // 18.6 (mph)
 *   formatPace(12345, 3600, 'imperial'); // "7:47 /mi"
 */

export const UNITS = { METRIC: 'metric', IMPERIAL: 'imperial' };

/** The specific display units mlToDisplayVolume()/displayVolumeToMl() pick
 *  between, grouped by system — metric is a fixed ml/l pair (SI, no
 *  cooking-measure ambiguity); imperial is the tsp/tbsp/fl_oz/cup ladder
 *  US recipes actually use, same "which specific unit isn't fixed"
 *  situation formatPace()'s mm:ss carry logic solves for time. */
export const VOLUME_UNITS = { metric: ['ml', 'l'], imperial: ['tsp', 'tbsp', 'fl_oz', 'cup'] };

/** Display labels for every unit VOLUME_UNITS can name, keyed the same way
 *  smallWeightUnitLabel()'s 'g'/'oz' are — one shared lookup so any flow
 *  that renders a mlToDisplayVolume() result (a manual unit picker like the
 *  diary quick-add's, or an auto-selected one like the recipe editor's)
 *  labels it the same way. */
export const VOLUME_UNIT_LABELS = { ml: 'mL', l: 'L', tsp: 'tsp', tbsp: 'tbsp', fl_oz: 'fl oz', cup: 'cup' };

const KMH_TO_MPH = 0.621371;
const M_TO_MI    = 0.000621371;
const KG_TO_LB   = 2.20462;
const G_TO_OZ    = 0.03527396;
const CM_TO_IN   = 0.393701;

// US cooking-measure conversions, each defined against the next size down
// (tsp is the base unit) so the ladder in mlToDisplayVolume()'s thresholds
// below reads the same order as VOLUME_UNITS.imperial.
const TSP_TO_ML   = 4.92892;
const TBSP_TO_ML  = TSP_TO_ML * 3;    // 1 tbsp = 3 tsp
const FL_OZ_TO_ML = TBSP_TO_ML * 2;   // 1 fl oz = 2 tbsp
const CUP_TO_ML   = FL_OZ_TO_ML * 8;  // 1 cup = 8 fl oz
const ML_PER_VOLUME_UNIT = {
  ml: 1, l: 1000,
  tsp: TSP_TO_ML, tbsp: TBSP_TO_ML, fl_oz: FL_OZ_TO_ML, cup: CUP_TO_ML,
};

/** Converts a km/h value to the display unit's speed (identity if metric). */
export function kmhToDisplaySpeed(kmh, units) {
  return units === UNITS.IMPERIAL ? kmh * KMH_TO_MPH : kmh;
}

/** 'mph' or 'km/h' — for chart/stat-row labels. */
export function speedUnitLabel(units) {
  return units === UNITS.IMPERIAL ? 'mph' : 'km/h';
}

/**
 * Formats a cumulative meters value for display, honoring units.
 * @param {number|null} meters
 * @param {string}      units
 * @param {number}      [decimals=1]
 * @returns {string}   e.g. "12.3 km" / "7.6 mi" / "—" when meters is null
 */
export function formatDistance(meters, units, decimals = 1) {
  if (meters == null) return '—';
  return `${formatDistanceValue(meters, units, decimals)} ${distanceUnitLabel(units)}`;
}

/**
 * Same conversion as formatDistance() but without the unit suffix, for
 * stat chips that carry their unit in the label instead (e.g. "DIST (KM)")
 * rather than repeating it in every value. Pair with distanceUnitLabel().
 * @returns {string}   e.g. "12.3" / "7.6" / "—" when meters is null
 */
export function formatDistanceValue(meters, units, decimals = 1) {
  if (meters == null) return '—';
  return units === UNITS.IMPERIAL
    ? (meters * M_TO_MI).toFixed(decimals)
    : (meters / 1000).toFixed(decimals);
}

/** 'mi' or 'km' — for a DIST chip's label, paired with formatDistanceValue(). */
export function distanceUnitLabel(units) {
  return units === UNITS.IMPERIAL ? 'mi' : 'km';
}

/**
 * Formats a pace (time per unit distance) for display, honoring units.
 * Pace is derived from the same cumulative distance/elapsedTime fields as
 * Distance, so it tracks live during a session and needs no extra sensor.
 *
 * @param {number|null} meters    Cumulative distance travelled.
 * @param {number|null} seconds   Cumulative elapsed time.
 * @param {string}      units
 * @returns {string}   e.g. "5:18 /km" / "8:32 /mi" / "—" when not computable
 */
export function formatPace(meters, seconds, units) {
  if (meters == null || seconds == null || meters <= 0 || seconds <= 0) return '—';

  const distanceInUnit = units === UNITS.IMPERIAL ? meters * M_TO_MI : meters / 1000;
  if (!isFinite(distanceInUnit) || distanceInUnit <= 0) return '—';

  let secPerUnit = seconds / distanceInUnit;
  if (!isFinite(secPerUnit) || secPerUnit <= 0) return '—';

  let mins = Math.floor(secPerUnit / 60);
  let secs = Math.round(secPerUnit % 60);
  if (secs === 60) { mins += 1; secs = 0; } // rounding carry

  const paceUnitLabel = units === UNITS.IMPERIAL ? '/mi' : '/km';
  return `${mins}:${String(secs).padStart(2, '0')} ${paceUnitLabel}`;
}

/**
 * Average speed derived from the same cumulative distance/elapsedTime
 * fields as Distance and Pace above — no separate speed-sensor average
 * needed. Always returns km/h; convert at the display boundary with
 * kmhToDisplaySpeed(), same as any other speed value.
 * @param {number|null} meters   Cumulative distance travelled.
 * @param {number|null} seconds  Cumulative elapsed time.
 * @returns {number|null}  km/h, or null when not computable.
 */
export function avgSpeedKmh(meters, seconds) {
  if (meters == null || seconds == null || seconds <= 0) return null;
  return (meters / 1000) / (seconds / 3600);
}

export function kgToLb(kg) { return kg * KG_TO_LB; }
export function lbToKg(lb) { return lb / KG_TO_LB; }

/** 'lb' or 'kg' — for the rider/bike weight field labels. */
export function weightUnitLabel(units) {
  return units === UNITS.IMPERIAL ? 'lb' : 'kg';
}

// Same rider/bike-weight-scale precision as kgToLb()/lbToKg() above — used
// for the Profile's height field and the smart-scale body-composition
// fields (muscle/bone/water mass reuse kgToLb()/lbToKg() directly instead;
// this pair is specifically for the one length field in that group).
export function cmToIn(cm) { return cm * CM_TO_IN; }
export function inToCm(inches) { return inches / CM_TO_IN; }

/** 'in' or 'cm' — for the Profile height field label. */
export function heightUnitLabel(units) {
  return units === UNITS.IMPERIAL ? 'in' : 'cm';
}

/**
 * Converts a gram value to the display unit's small-weight scale (g or oz)
 * — the Diet panel's counterpart to kgToLb()/lbToKg() above, but at food-
 * portion precision rather than rider/bike-weight precision. Unlike
 * kgToLb() (a raw factor the caller branches on), this takes `units`
 * directly and does the branch itself, matching kmhToDisplaySpeed()'s
 * shape — the amount field just calls it, no per-call-site ternary.
 * No rounding here (display formatting, if any, happens above this layer,
 * same as kgToLb() staying unrounded).
 * @param {number|null} g
 * @param {string}      units
 * @returns {number|null}  grams (metric) or ounces (imperial); null if g is null
 */
export function gToDisplayWeight(g, units) {
  if (g == null) return null;
  return units === UNITS.IMPERIAL ? g * G_TO_OZ : g;
}

/**
 * Input-side inverse of gToDisplayWeight() — for the diary/recipe amount
 * field, converting whatever the rider typed (g or oz, per `units`) back
 * to canonical grams before it's written into a DiaryEntry/Recipe line.
 * @param {number|null} value  A g or oz amount, per `units`.
 * @param {string}      units
 * @returns {number|null}  grams; null if value is null
 */
export function displayWeightToG(value, units) {
  if (value == null) return null;
  return units === UNITS.IMPERIAL ? value / G_TO_OZ : value;
}

/**
 * 'oz' or 'g' — for food-portion amount fields (Diet panel quick-add,
 * recipe editor, ingredient editor). Distinct from weightUnitLabel()'s
 * 'lb'/'kg', which is rider/bike-weight scale, not food-portion scale.
 */
export function smallWeightUnitLabel(units) {
  return units === UNITS.IMPERIAL ? 'oz' : 'g';
}

/**
 * Formats a food-portion weight as one ready-to-render string — the
 * combined sibling of gToDisplayWeight()/smallWeightUnitLabel() above,
 * for read-only contexts (the recipe print sheet's ingredient list, hint
 * captions) that just want a finished string rather than the split
 * value+label pair an editable amount field needs to keep separately
 * editable/relabelable.
 *
 * Metric stays a single value+label, same rounding gToDisplayWeight()
 * already implied. Imperial rounds to the nearest whole ounce and, once
 * that reaches a pound (16 oz), carries the excess into an "X lb Y oz"
 * pair — the way a kitchen scale set to lb:oz mode actually reads out,
 * rather than a single ounce figure with a decimal that's awkward to
 * eyeball against a scale.
 * @param {number|null} g
 * @param {string}      units
 * @returns {string}  e.g. "1 lb 5 oz" / "9 oz" / "150 g"; "—" if g is null
 */
export function formatSmallWeight(g, units) {
  if (g == null) return '—';
  if (units === UNITS.IMPERIAL) {
    const totalOz = Math.round(g * G_TO_OZ);
    const lb = Math.floor(totalOz / 16);
    const oz = totalOz % 16;
    if (lb === 0) return `${oz} oz`;
    return oz === 0 ? `${lb} lb` : `${lb} lb ${oz} oz`;
  }
  const rounded = Math.round(g * 10) / 10;
  return `${rounded} g`;
}

/**
 * Converts a mL amount to a magnitude-appropriate display unit — imperial
 * cooking measures aren't one fixed unit the way oz/lb are, so this picks
 * the largest unit from VOLUME_UNITS[units] that the amount reaches at
 * least 1 of, same carry-to-the-right-granularity idea formatPace() uses
 * to decide minutes vs. seconds. Only offered for ingredients that set
 * densityGPerMl (see nutrition-model.js) — solids never call this.
 * @param {number|null} ml
 * @param {string}      units
 * @returns {{value: number, unit: string}|null}  unit is one of
 *   VOLUME_UNITS[units]; null if ml is null
 */
export function mlToDisplayVolume(ml, units) {
  if (ml == null) return null;
  if (units === UNITS.IMPERIAL) {
    if (ml < TBSP_TO_ML)  return { value: ml / TSP_TO_ML,   unit: 'tsp' };
    if (ml < FL_OZ_TO_ML) return { value: ml / TBSP_TO_ML,  unit: 'tbsp' };
    if (ml < CUP_TO_ML)   return { value: ml / FL_OZ_TO_ML, unit: 'fl_oz' };
    return { value: ml / CUP_TO_ML, unit: 'cup' };
  }
  return ml < 1000 ? { value: ml, unit: 'ml' } : { value: ml / 1000, unit: 'l' };
}

/**
 * Input-side inverse of mlToDisplayVolume() — for the diary/recipe amount
 * field, converting a typed amount back to canonical mL once density
 * resolves it to grams. Unlike displayWeightToG(), `unit` is the specific
 * unit the rider is entering in (e.g. 'tbsp'), not the metric/imperial
 * system — the amount field's unit picker offers VOLUME_UNITS[units] and
 * passes whichever one is selected straight through here.
 * @param {number|null} value
 * @param {string}      unit   One of the strings in VOLUME_UNITS.metric/imperial.
 * @returns {number|null}  mL; null if value is null or unit is unrecognized
 */
export function displayVolumeToMl(value, unit) {
  if (value == null) return null;
  const mlPerUnit = ML_PER_VOLUME_UNIT[unit];
  return mlPerUnit != null ? value * mlPerUnit : null;
}

/**
 * Converts a mL amount to one specific, caller-chosen volume unit — the
 * manual-unit counterpart to mlToDisplayVolume()'s auto-selected one. Use
 * this when a rider has forced a particular unit (e.g. "always show this
 * ingredient in cups") instead of letting the largest-unit-it-reaches rule
 * pick one, same relationship displayVolumeToMl() already has to
 * mlToDisplayVolume() but in the opposite (mL-in, not mL-out) direction.
 * @param {number|null} ml
 * @param {string}      unit  One of the strings in VOLUME_UNITS.metric/imperial.
 * @returns {number|null}  value in `unit`; null if ml is null or unit is unrecognized
 */
export function mlToUnit(ml, unit) {
  if (ml == null) return null;
  const mlPerUnit = ML_PER_VOLUME_UNIT[unit];
  return mlPerUnit != null ? ml / mlPerUnit : null;
}

/** Whole-label strings that never pluralize, regardless of value — either
 *  an abbreviation a recipe writes unchanged at any count ("2 tsp",
 *  "3 tbsp", "12 fl oz", "150 g", "9 oz", the metric mL/L pair) or a bare
 *  sizeOptions adjective that modifies an implied noun rather than naming
 *  one ("3 Large" eggs, never "3 Larges"; "2 Whole" lemons, never
 *  "2 Wholes"). Checked against a label's leading word/phrase only — see
 *  pluralizeUnit()'s doc comment for how a compound sizeOptions label
 *  like "Cup, Cooked" is split before this set is consulted. */
const NON_PLURALIZING_UNITS = new Set([
  'mL', 'L', 'tsp', 'tbsp', 'fl oz', 'g', 'oz',  // this module's own labels
  'Small', 'Medium', 'Large', 'Whole',            // adjective-only sizeOptions labels
]);

/** Irregular plurals among the ingredient-unit vocabulary this app
 *  actually uses (core/nutrition-model.js's sizeOptions labels) — every
 *  other label pluralizes with the regular English suffix rules
 *  _pluralizeWord() applies below. */
const IRREGULAR_UNIT_PLURALS = { Half: 'Halves', half: 'halves' };

function _pluralizeWord(word) {
  if (IRREGULAR_UNIT_PLURALS[word]) return IRREGULAR_UNIT_PLURALS[word];
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Finds where a compound sizeOptions label's leading noun ends — the
 *  first ", " (e.g. "Cup, Cooked") or " (" (e.g. "Half (without
 *  skin/seed)"), whichever comes first. null for a bare single word/
 *  phrase label with neither, meaning the whole label is the "head". */
function _unitLabelSplitPoint(label) {
  const comma = label.indexOf(', ');
  const paren = label.indexOf(' (');
  const candidates = [comma, paren].filter(i => i >= 0);
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * Pluralizes an ingredient measurement/unit label for a given display
 * value, matching how a recipe is actually written by hand: singular
 * through 1 (including a fraction under a whole unit — "½ cup", never
 * "½ cups"), plural once the value exceeds 1 ("2 cups"). Meant for every
 * spot an amount and its unit render side by side — VOLUME_UNIT_LABELS'
 * cup/tbsp/tsp/fl-oz/mL/L pair and a Recipe/DiaryEntry line's sizeOptions
 * count alike ("2 Slices", "3 Cups, Cooked", "1½ Fillets").
 *
 * Most of VOLUME_UNIT_LABELS and smallWeightUnitLabel()'s g/oz stay fixed
 * regardless of count — see NON_PLURALIZING_UNITS' doc comment — the one
 * exception recipes actually write out longhand is "cup"/"cups". A
 * compound sizeOptions label ("Cup, Cooked", "Half (without skin/seed)")
 * only pluralizes its leading noun, leaving the ", Cooked"/" (without
 * skin/seed)" detail untouched.
 *
 * @param {string}       label
 * @param {number|null}  value  The display quantity paired with this
 *   label. null/undefined means "no specific count to check" (e.g. a
 *   `<select>` listing every unit a rider could pick, not one already-
 *   chosen amount) and returns label unchanged.
 * @returns {string}
 */
export function pluralizeUnit(label, value) {
  if (label == null || value == null || !isFinite(value) || Math.abs(value) <= 1) return label;

  const splitAt = _unitLabelSplitPoint(label);
  const head = splitAt == null ? label : label.slice(0, splitAt);
  const tail = splitAt == null ? '' : label.slice(splitAt);

  if (NON_PLURALIZING_UNITS.has(head)) return label;
  return _pluralizeWord(head) + tail;
}
