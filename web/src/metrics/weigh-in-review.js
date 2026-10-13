// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/weigh-in-review.js
 *
 * The logic behind the weigh-in editor (ui/weigh-in-manager.js): which stored
 * weigh-ins look wrong and why, and how an edit form turns back into a valid
 * BodyMeasurement. Pure functions only — no DOM, no IndexedDB — same split as
 * metrics/body-history.js, so all of it is smoke-tested in plain node
 * (__weigh_in_review_smoketest__.js).
 *
 * Why this exists: weigh-ins arrive from a Bluetooth scale (app.js's
 * _recordScaleMeasurement()) the moment a reading settles, with no review step,
 * and metrics/body-history.js's chart only insists a value is positive. So one
 * misread — a pet on the plate, a scale that reports 0.0 or 6553.5, a wrong
 * device clock — becomes a permanent point on the Weight & Composition chart
 * and stretches its axis until the real trend is a flat line. This module is
 * how the rider finds those points and fixes or removes them.
 *
 * "Possibly invalid" is deliberately a *hint*, not a verdict: flagWeighIns()
 * never changes anything, and a real 4 kg swing after a long trip gets flagged
 * the same as a misread. It only says "look at this one".
 *
 * What gets flagged (see FLAG):
 *   - values that cannot be right on their own — a body weight outside
 *     WEIGHT_KG_RANGE, body fat outside BODY_FAT_PCT_RANGE, a muscle/bone/water
 *     mass larger than the person, a date in the future, an entry with nothing
 *     in it;
 *   - values that are out of line with the readings around them — a weight (or
 *     body-fat %) far from the median of its nearest neighbours within
 *     JUMP_WINDOW_DAYS. This is the check that catches the everyday misread
 *     (80 kg -> 92 kg -> 80 kg), which no fixed range can. It needs at least
 *     two neighbours to compare against, so it stays quiet on a rider's first
 *     few weigh-ins rather than guessing;
 *   - the same reading recorded twice within a couple of minutes (a scale that
 *     re-sent, or a reconnect that logged it again). The later one is flagged.
 *
 * Editing: the form works in whatever unit system the rider has selected
 * (Settings → Units), but records are always stored in kg — same rule as the
 * Profile form. weighInDraft() renders a record as form strings and
 * parseWeighInDraft() reverses it; a field the rider didn't touch keeps its
 * stored value exactly, so opening an imperial rider's weigh-in and only fixing
 * the date doesn't nudge the weight by a rounding error on the way through
 * lb -> kg.
 */

import { UNITS, kgToLb, lbToKg, weightUnitLabel } from './units.js';
import { deriveLeanBodyMassKg } from '../core/nutrition-model.js';

const DAY = 24 * 60 * 60 * 1000;

// ─── Thresholds ─────────────────────────────────────────────────────────────

/** Plausible adult body weight. Generous on purpose — this is "could a person
 *  weigh this", not "is this a healthy weight". */
export const WEIGHT_KG_RANGE = Object.freeze({ min: 20, max: 350 });
/** Same bounds as Settings' body-fat input (min 1, max 70). */
export const BODY_FAT_PCT_RANGE = Object.freeze({ min: 1, max: 70 });
/** core/nutrition-model.js's BodyMeasurement doc: "typically ~1-59". */
export const VISCERAL_FAT_RANGE = Object.freeze({ min: 1, max: 59 });
export const BMR_KCAL_RANGE = Object.freeze({ min: 300, max: 6000 });

/** How far either side of a reading counts as "the readings around it". */
export const JUMP_WINDOW_DAYS = 21;
const JUMP_NEIGHBOURS_PER_SIDE = 2;
const JUMP_MIN_NEIGHBOURS = 2;
/** A weight is out of line when it sits further from its neighbours' median
 *  than the larger of these: day-to-day water weight is a kilo or two, so
 *  3 kg (or 6 % for a heavier rider) is well past ordinary variation. */
const WEIGHT_JUMP_MIN_KG = 3;
const WEIGHT_JUMP_FRACTION = 0.06;
/** Percentage points. Bioimpedance body fat wanders a few points with hydration. */
const BODY_FAT_JUMP_POINTS = 6;

const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const DUPLICATE_WEIGHT_KG = 0.05;
const DUPLICATE_BODY_FAT_PTS = 0.1;
/** A device clock a day or so ahead (timezones) isn't worth flagging. */
const FUTURE_SLACK_MS = DAY;

/** Flag codes — the `code` of every flag flagWeighIns() returns. */
export const FLAG = Object.freeze({
  EMPTY: 'empty',
  FUTURE: 'future-dated',
  WEIGHT_RANGE: 'weight-out-of-range',
  BODY_FAT_RANGE: 'body-fat-out-of-range',
  VALUE_RANGE: 'value-out-of-range',
  MASS_EXCEEDS_WEIGHT: 'mass-exceeds-weight',
  WEIGHT_JUMP: 'weight-jump',
  BODY_FAT_JUMP: 'body-fat-jump',
  DUPLICATE: 'duplicate',
});

// ─── The editable fields ────────────────────────────────────────────────────
// One table drives the edit form's markup, its parsing and its validation, so
// adding a field later is a one-line addition here. `kind` decides the unit
// handling: 'mass' is stored in kg and shown in the rider's weight unit.

/**
 * @typedef {Object} WeighInField
 * @property {string} key      BodyMeasurement field
 * @property {string} label
 * @property {'mass'|'percent'|'index'|'kcal'} kind
 * @property {{min:number,max:number}|null} range   stored units (kg/%/index/kcal); null = just "positive, and not more than body weight" for masses
 */
export const WEIGH_IN_FIELDS = Object.freeze([
  { key: 'weightKg',               label: 'Weight',              kind: 'mass',    range: WEIGHT_KG_RANGE },
  { key: 'bodyFatPct',             label: 'Body fat',            kind: 'percent', range: BODY_FAT_PCT_RANGE },
  { key: 'muscleMassKg',           label: 'Muscle mass',         kind: 'mass',    range: null },
  { key: 'boneMassKg',             label: 'Bone mass',           kind: 'mass',    range: null },
  { key: 'bodyWaterKg',            label: 'Body water',          kind: 'mass',    range: null },
  { key: 'visceralFatRating',      label: 'Visceral fat rating', kind: 'index',   range: VISCERAL_FAT_RANGE },
  { key: 'basalMetabolicRateKcal', label: 'BMR',                 kind: 'kcal',    range: BMR_KCAL_RANGE },
]);

const _FIELD_LABELS = Object.freeze({
  ...Object.fromEntries(WEIGH_IN_FIELDS.map(f => [f.key, f.label])),
  leanBodyMassKg: 'Lean mass',
});

// Masses that can't exceed the person they're a part of.
const _PART_OF_WEIGHT = ['muscleMassKg', 'boneMassKg', 'bodyWaterKg', 'leanBodyMassKg'];

// ─── Small helpers ──────────────────────────────────────────────────────────

const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const _round = (v, decimals) => { const p = 10 ** decimals; return Math.round(v * p) / p; };
const _inRange = (v, r) => v >= r.min && v <= r.max;

function _median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The median of the readings nearest to `rows[index]` in time — up to
 * JUMP_NEIGHBOURS_PER_SIDE either side, none further than the window — or null
 * when there are fewer than JUMP_MIN_NEIGHBOURS to compare with. `pool` is
 * ascending by measuredAt and holds only rows that have a usable value.
 */
function _neighbourMedian(pool, at, valueOf) {
  const window = JUMP_WINDOW_DAYS * DAY;
  const neighbours = [];
  for (let i = at - 1, taken = 0; i >= 0 && taken < JUMP_NEIGHBOURS_PER_SIDE; i--, taken++) {
    if (pool[at].measuredAt - pool[i].measuredAt > window) break;
    neighbours.push(valueOf(pool[i]));
  }
  for (let i = at + 1, taken = 0; i < pool.length && taken < JUMP_NEIGHBOURS_PER_SIDE; i++, taken++) {
    if (pool[i].measuredAt - pool[at].measuredAt > window) break;
    neighbours.push(valueOf(pool[i]));
  }
  return neighbours.length >= JUMP_MIN_NEIGHBOURS ? _median(neighbours) : null;
}

// ─── Flagging ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WeighInFlag
 * @property {string} code                one of FLAG
 * @property {string} [field]             the BodyMeasurement field involved (VALUE_RANGE, MASS_EXCEEDS_WEIGHT)
 * @property {number} [value]             the offending value (kg / % / index / kcal)
 * @property {number} [medianKg]          WEIGHT_JUMP: the neighbours' median weight
 * @property {number} [deviationKg]       WEIGHT_JUMP: how far this reading is from it
 * @property {number} [medianPct]         BODY_FAT_JUMP: the neighbours' median body fat
 * @property {number} [deviationPts]      BODY_FAT_JUMP: how far this reading is from it
 * @property {number} [duplicateOfId]     DUPLICATE: the earlier reading it repeats
 */

/**
 * Finds the weigh-ins that look wrong. Never mutates its input.
 * @param {Object[]} measurements   BodyMeasurement rows (db.getBodyMeasurements()), any order; each needs an `id`
 * @param {Object}   [opts]
 * @param {number}   [opts.now=Date.now()]
 * @returns {Map<number, WeighInFlag[]>}  measurement id -> its flags. Only flagged rows appear.
 */
export function flagWeighIns(measurements, { now = Date.now() } = {}) {
  const rows = (measurements ?? [])
    .filter(m => m && m.id != null && Number.isFinite(m.measuredAt))
    .slice()
    .sort((a, b) => a.measuredAt - b.measuredAt);
  const flags = new Map();
  const add = (m, flag) => {
    if (!flags.has(m.id)) flags.set(m.id, []);
    flags.get(m.id).push(flag);
  };

  // ── Checks that need only the row itself
  for (const m of rows) {
    const hasAnyValue = WEIGH_IN_FIELDS.some(f => _num(m[f.key]) != null);
    if (!hasAnyValue) { add(m, { code: FLAG.EMPTY }); continue; }

    if (m.measuredAt > now + FUTURE_SLACK_MS) add(m, { code: FLAG.FUTURE });

    const weight = _num(m.weightKg);
    if (weight != null && !_inRange(weight, WEIGHT_KG_RANGE)) add(m, { code: FLAG.WEIGHT_RANGE, value: weight });

    const fat = _num(m.bodyFatPct);
    if (fat != null && !_inRange(fat, BODY_FAT_PCT_RANGE)) add(m, { code: FLAG.BODY_FAT_RANGE, value: fat });

    for (const f of WEIGH_IN_FIELDS) {
      if (f.key === 'weightKg' || f.key === 'bodyFatPct') continue;
      const v = _num(m[f.key]);
      if (v == null) continue;
      if (v <= 0 || (f.range && !_inRange(v, f.range))) add(m, { code: FLAG.VALUE_RANGE, field: f.key, value: v });
    }

    if (weight != null && _inRange(weight, WEIGHT_KG_RANGE)) {
      for (const key of _PART_OF_WEIGHT) {
        const v = _num(m[key]);
        if (v != null && v > weight) add(m, { code: FLAG.MASS_EXCEEDS_WEIGHT, field: key, value: v });
      }
    }
  }

  // ── Out of line with the readings around it. Only rows whose value is
  // itself plausible take part — a 750 kg misread is already flagged above and
  // mustn't drag its neighbours' median around.
  const weighted = rows.filter(m => { const w = _num(m.weightKg); return w != null && _inRange(w, WEIGHT_KG_RANGE); });
  weighted.forEach((m, i) => {
    const median = _neighbourMedian(weighted, i, r => r.weightKg);
    if (median == null) return;
    const deviation = Math.abs(m.weightKg - median);
    if (deviation > Math.max(WEIGHT_JUMP_MIN_KG, WEIGHT_JUMP_FRACTION * median)) {
      add(m, { code: FLAG.WEIGHT_JUMP, value: m.weightKg, medianKg: median, deviationKg: deviation });
    }
  });

  const fatRows = rows.filter(m => { const f = _num(m.bodyFatPct); return f != null && _inRange(f, BODY_FAT_PCT_RANGE); });
  fatRows.forEach((m, i) => {
    const median = _neighbourMedian(fatRows, i, r => r.bodyFatPct);
    if (median == null) return;
    const deviation = Math.abs(m.bodyFatPct - median);
    if (deviation > BODY_FAT_JUMP_POINTS) {
      add(m, { code: FLAG.BODY_FAT_JUMP, value: m.bodyFatPct, medianPct: median, deviationPts: deviation });
    }
  });

  // ── The same reading twice in a row. The later of the pair is the extra one.
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const m = rows[i];
    if (m.measuredAt - prev.measuredAt > DUPLICATE_WINDOW_MS) continue;
    const w1 = _num(prev.weightKg), w2 = _num(m.weightKg);
    if (w1 == null || w2 == null || Math.abs(w1 - w2) > DUPLICATE_WEIGHT_KG) continue;
    const f1 = _num(prev.bodyFatPct), f2 = _num(m.bodyFatPct);
    const sameFat = (f1 == null && f2 == null) || (f1 != null && f2 != null && Math.abs(f1 - f2) <= DUPLICATE_BODY_FAT_PTS);
    if (sameFat) add(m, { code: FLAG.DUPLICATE, duplicateOfId: prev.id });
  }

  return flags;
}

/** Whether any of a row's flags would, on their own, make the value impossible
 *  (as opposed to merely out of line with its neighbours). The UI uses it to
 *  order the review list: certain problems before "worth a look". */
export function isCertainlyWrong(flagList) {
  return (flagList ?? []).some(f =>
    f.code === FLAG.EMPTY || f.code === FLAG.FUTURE || f.code === FLAG.WEIGHT_RANGE
    || f.code === FLAG.BODY_FAT_RANGE || f.code === FLAG.VALUE_RANGE || f.code === FLAG.MASS_EXCEEDS_WEIGHT);
}

/**
 * One line of plain English for a flag, in the rider's units.
 * @param {WeighInFlag} flag
 * @param {'metric'|'imperial'} [units]
 */
export function describeFlag(flag, units = UNITS.METRIC) {
  const unit = weightUnitLabel(units);
  const mass = (kg) => `${_round(units === UNITS.IMPERIAL ? kgToLb(kg) : kg, 1)} ${unit}`;
  switch (flag.code) {
    case FLAG.EMPTY:
      return 'This entry has no readings in it.';
    case FLAG.FUTURE:
      return 'Dated in the future \u2014 the scale or phone clock may have been wrong.';
    case FLAG.WEIGHT_RANGE:
      return `${mass(flag.value)} isn\u2019t a plausible body weight.`;
    case FLAG.BODY_FAT_RANGE:
      return `${_round(flag.value, 1)}% body fat isn\u2019t plausible.`;
    case FLAG.VALUE_RANGE:
      return `${_FIELD_LABELS[flag.field] ?? flag.field} of ${_round(flag.value, 1)} doesn\u2019t look right.`;
    case FLAG.MASS_EXCEEDS_WEIGHT:
      return `${_FIELD_LABELS[flag.field] ?? flag.field} (${mass(flag.value)}) is more than total body weight.`;
    case FLAG.WEIGHT_JUMP:
      return `${mass(flag.deviationKg)} away from the readings around it (usually about ${mass(flag.medianKg)}).`;
    case FLAG.BODY_FAT_JUMP:
      return `Body fat is ${_round(flag.deviationPts, 1)} points away from the readings around it (usually about ${_round(flag.medianPct, 1)}%).`;
    case FLAG.DUPLICATE:
      return 'Same reading as the one just before it \u2014 probably recorded twice.';
    default:
      return 'Looks unusual.';
  }
}

// ─── Editing ────────────────────────────────────────────────────────────────

const _pad = (n) => String(n).padStart(2, '0');

/** `2026-09-20T14:30` — the local-time, minute-precision string a
 *  <input type="datetime-local"> takes and returns. */
export function toLocalDateTimeInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}T${_pad(d.getHours())}:${_pad(d.getMinutes())}`;
}

function _displayString(field, stored, units) {
  const v = _num(stored);
  if (v == null) return '';
  if (field.kind === 'mass') return String(_round(units === UNITS.IMPERIAL ? kgToLb(v) : v, 1));
  if (field.kind === 'percent') return String(_round(v, 1));
  return String(Math.round(v));
}

/**
 * A stored weigh-in as the strings the edit form shows, in the rider's units.
 * @returns {Object<string,string>}  `measuredAt` plus one entry per WEIGH_IN_FIELDS key ('' for no value)
 */
export function weighInDraft(measurement, units = UNITS.METRIC) {
  const draft = { measuredAt: toLocalDateTimeInput(measurement.measuredAt) };
  for (const f of WEIGH_IN_FIELDS) draft[f.key] = _displayString(f, measurement[f.key], units);
  return draft;
}

/** "between 44 and 772 lb" — a stored-unit range in the rider's units. */
function _rangeText(field, range, units) {
  if (field.kind === 'mass') {
    const conv = (kg) => Math.round(units === UNITS.IMPERIAL ? kgToLb(kg) : kg);
    return `between ${conv(range.min)} and ${conv(range.max)} ${weightUnitLabel(units)}`;
  }
  return `between ${range.min} and ${range.max}${field.kind === 'percent' ? ' %' : field.kind === 'kcal' ? ' kcal' : ''}`;
}

/**
 * Turns the edit form back into a record.
 *
 * @param {Object<string,string>} draft   the form's current strings (same keys as weighInDraft())
 * @param {Object} original               the stored row being edited — its id, source and any field the form
 *                                        doesn't carry are kept as they were
 * @param {Object} [opts]
 * @param {'metric'|'imperial'} [opts.units]
 * @param {number} [opts.now=Date.now()]
 * @returns {{ ok: true, value: Object } | { ok: false, errors: Object<string,string> }}
 *   `errors` is keyed by field (or `measuredAt`, or `form` for a whole-form problem) with a sentence for each.
 *   `value` is a full BodyMeasurement, ready for db.updateBodyMeasurement().
 */
export function parseWeighInDraft(draft, original, { units = UNITS.METRIC, now = Date.now() } = {}) {
  const errors = {};
  const value = { ...original };
  const untouched = weighInDraft(original, units);

  // ── When
  const whenText = String(draft.measuredAt ?? '').trim();
  if (whenText === untouched.measuredAt) {
    value.measuredAt = original.measuredAt; // keep the seconds/ms — this is also the import's duplicate key
  } else {
    const t = new Date(whenText).getTime();
    if (!whenText || !Number.isFinite(t) || t <= 0) errors.measuredAt = 'Enter a valid date and time.';
    else if (t > now + FUTURE_SLACK_MS) errors.measuredAt = 'That date is in the future.';
    else value.measuredAt = t;
  }

  // ── Readings
  for (const f of WEIGH_IN_FIELDS) {
    const text = String(draft[f.key] ?? '').trim();
    if (text === untouched[f.key]) { value[f.key] = _num(original[f.key]); continue; } // untouched: exact stored value
    if (text === '') { value[f.key] = null; continue; }
    const n = Number(text);
    if (!Number.isFinite(n)) { errors[f.key] = `${f.label} must be a number.`; continue; }
    if (f.kind === 'mass') value[f.key] = _round(units === UNITS.IMPERIAL ? lbToKg(n) : n, 2);
    else if (f.kind === 'percent') value[f.key] = _round(n, 1);
    else value[f.key] = Math.round(n);
  }

  // ── Are the resulting values possible? (Checked on the final values, not
  // just the edited ones: fixing the date of a 750 kg entry shouldn't save it.)
  for (const f of WEIGH_IN_FIELDS) {
    if (errors[f.key]) continue;
    const v = _num(value[f.key]);
    if (v == null) continue;
    if (f.range) {
      if (!_inRange(v, f.range)) errors[f.key] = `${f.label} must be ${_rangeText(f, f.range, units)}.`;
    } else if (v <= 0) {
      errors[f.key] = `${f.label} must be more than zero.`;
    }
  }
  const weight = _num(value.weightKg);
  if (weight != null && !errors.weightKg) {
    for (const key of ['muscleMassKg', 'boneMassKg', 'bodyWaterKg']) {
      const v = _num(value[key]);
      if (v != null && !errors[key] && v > weight) errors[key] = `${_FIELD_LABELS[key]} can\u2019t be more than body weight.`;
    }
  }

  if (!WEIGH_IN_FIELDS.some(f => _num(value[f.key]) != null)) {
    errors.form = 'Enter at least one value \u2014 or delete this weigh-in instead.';
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  // ── Lean mass is derived, never typed (see core/nutrition-model.js's
  // deriveLeanBodyMassKg()). With no weight/body-fat pair to derive it from, an
  // existing value only survives if neither of the two changed.
  const derived = deriveLeanBodyMassKg(_num(value.weightKg), _num(value.bodyFatPct));
  if (derived != null) {
    value.leanBodyMassKg = derived;
  } else {
    const inputsUnchanged = draft.weightKg === untouched.weightKg && draft.bodyFatPct === untouched.bodyFatPct;
    value.leanBodyMassKg = inputsUnchanged ? _num(original.leanBodyMassKg) : null;
  }

  return { ok: true, value };
}

/**
 * The one-line reading shown in the review list: "72.4 kg · 18.2% fat".
 * @param {Object} m
 * @param {'metric'|'imperial'} [units]
 */
export function weighInHeadline(m, units = UNITS.METRIC) {
  const parts = [];
  const w = _num(m.weightKg);
  if (w != null) parts.push(`${_round(units === UNITS.IMPERIAL ? kgToLb(w) : w, 1)} ${weightUnitLabel(units)}`);
  const fat = _num(m.bodyFatPct);
  if (fat != null) parts.push(`${_round(fat, 1)}% fat`);
  if (!parts.length) {
    const extras = WEIGH_IN_FIELDS.filter(f => _num(m[f.key]) != null);
    return extras.length ? extras.map(f => f.label.toLowerCase()).join(', ') : 'No readings';
  }
  return parts.join(' \u00B7 ');
}

export default { flagWeighIns, describeFlag, isCertainlyWrong, weighInDraft, parseWeighInDraft, weighInHeadline, WEIGH_IN_FIELDS, FLAG };
