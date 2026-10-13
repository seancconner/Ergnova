// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Weigh-in review/edit logic: metrics/weigh-in-review.js. Pure, no DOM or IndexedDB.
// Run with: node src/metrics/__weigh_in_review_smoketest__.js

import {
  FLAG, WEIGH_IN_FIELDS, flagWeighIns, describeFlag, isCertainlyWrong,
  weighInDraft, parseWeighInDraft, weighInHeadline, toLocalDateTimeInput,
} from './weigh-in-review.js';
import { deriveLeanBodyMassKg } from '../core/nutrition-model.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Local-time constructor throughout: the edit form's date field is local time,
// so nothing here may depend on the machine's timezone.

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 20, 12, 0).getTime();
const day = (n, hour = 7) => new Date(2026, 8, 20 - n, hour, 0).getTime(); // n days before "today"

let nextId = 1;
const wi = (measuredAt, weightKg, extra = {}) => ({
  id: nextId++, measuredAt, source: 'ble-scale', weightKg,
  bodyFatPct: null, leanBodyMassKg: null, muscleMassKg: null, boneMassKg: null,
  bodyWaterKg: null, visceralFatRating: null, basalMetabolicRateKcal: null, ...extra,
});
const codes = (flags, id) => (flags.get(id) ?? []).map(f => f.code);

// Ten ordinary mornings, 74.6-75.6 kg
const steady = [75.1, 74.8, 75.3, 74.9, 75.0, 75.6, 74.7, 75.2, 74.9, 75.0].map((w, i) => wi(day(10 - i), w));

console.log('ordinary data');
check('a normal series raises no flags at all', flagWeighIns(steady, { now: NOW }).size === 0);
check('an empty / missing list is fine', flagWeighIns([], { now: NOW }).size === 0 && flagWeighIns(undefined).size === 0);

console.log('out of line with its neighbours');
{
  const spike = wi(day(5, 9), 92.3);
  const rows = [...steady, spike];
  const flags = flagWeighIns(rows, { now: NOW });
  check('a misread in the middle of a run is flagged as a jump', codes(flags, spike.id).join() === FLAG.WEIGHT_JUMP);
  check('...and only that one \u2014 its neighbours are not dragged in', flags.size === 1);
  const jump = flags.get(spike.id)[0];
  check('the flag carries the neighbours\u2019 median and the distance from it',
    Math.abs(jump.medianKg - 75) < 0.6 && Math.abs(jump.deviationKg - (92.3 - jump.medianKg)) < 1e-9);
}
{
  const a = wi(day(3), 75), b = wi(day(2), 75.4), c = wi(day(1), 90);
  check('with only one neighbour there is nothing to compare against', flagWeighIns([a, c], { now: NOW }).size === 0);
  check('two neighbours are enough', codes(flagWeighIns([a, b, c], { now: NOW }), c.id).join() === FLAG.WEIGHT_JUMP);
}
{
  const far = wi(day(0), 95);
  const flags = flagWeighIns([...steady.slice(0, 5).map(m => ({ ...m, measuredAt: m.measuredAt - 60 * DAY })), far], { now: NOW });
  check('neighbours more than three weeks away don\u2019t count (a real change over months is not a jump)', flags.size === 0);
}
{
  const light = [50, 50.4, 49.8].map((w, i) => wi(day(5 - i), w));
  const off = wi(day(1), 53.4); // +3.4 kg on a 50 kg rider
  check('a lighter rider\u2019s threshold is the 3 kg floor, not 6 %', codes(flagWeighIns([...light, off], { now: NOW }), off.id).join() === FLAG.WEIGHT_JUMP);
  const heavy = [120, 120.5, 119.6].map((w, i) => wi(day(5 - i), w));
  const wobble = wi(day(1), 125); // +5 kg but under 6 % of 120
  check('a heavier rider\u2019s threshold scales with weight', flagWeighIns([...heavy, wobble], { now: NOW }).size === 0);
}

console.log('impossible on its own');
{
  const huge = wi(day(4, 8), 750);
  const flags = flagWeighIns([...steady, huge], { now: NOW });
  check('750 kg is out of range', codes(flags, huge.id).join() === FLAG.WEIGHT_RANGE);
  check('...and does not make its neighbours look wrong', flags.size === 1);
  check('a scale sentinel like 6553.5 is caught', codes(flagWeighIns([wi(day(1), 6553.5)], { now: NOW }), nextId - 1).includes(FLAG.WEIGHT_RANGE));
  check('0 kg is out of range', flagWeighIns([wi(day(1), 0)], { now: NOW }).size === 1);
}
{
  const fat0 = wi(day(2), 75, { bodyFatPct: 0.4 });
  const fat85 = wi(day(1), 75, { bodyFatPct: 85 });
  const flags = flagWeighIns([fat0, fat85], { now: NOW });
  check('body fat outside 1-70 % is flagged', codes(flags, fat0.id).includes(FLAG.BODY_FAT_RANGE) && codes(flags, fat85.id).includes(FLAG.BODY_FAT_RANGE));
}
{
  const muscle = wi(day(3), 75, { muscleMassKg: 90 });
  const lean = wi(day(2), 75, { leanBodyMassKg: 80 });
  const fine = wi(day(1), 75, { muscleMassKg: 34, boneMassKg: 3, bodyWaterKg: 42 });
  const flags = flagWeighIns([muscle, lean, fine], { now: NOW });
  check('a muscle mass bigger than the person is flagged, naming the field',
    flags.get(muscle.id)?.[0].code === FLAG.MASS_EXCEEDS_WEIGHT && flags.get(muscle.id)[0].field === 'muscleMassKg');
  check('so is a lean mass bigger than the person', flags.get(lean.id)?.[0].field === 'leanBodyMassKg');
  check('sensible composition figures are left alone', !flags.has(fine.id));
  const odd = wi(day(1), 75, { visceralFatRating: 80, basalMetabolicRateKcal: 90 });
  const oddCodes = flagWeighIns([odd], { now: NOW }).get(odd.id).map(f => `${f.code}:${f.field}`).join();
  check('visceral fat and BMR out of range are flagged by field', oddCodes === `${FLAG.VALUE_RANGE}:visceralFatRating,${FLAG.VALUE_RANGE}:basalMetabolicRateKcal`);
}
{
  const empty = wi(day(2), null);
  const future = wi(NOW + 3 * DAY, 75);
  const tz = wi(NOW + 2 * 60 * 60 * 1000, 75);
  const flags = flagWeighIns([empty, future, tz], { now: NOW });
  check('an entry with nothing in it is flagged', codes(flags, empty.id).join() === FLAG.EMPTY);
  check('a date days in the future is flagged', codes(flags, future.id).join() === FLAG.FUTURE);
  check('a clock a couple of hours ahead is not', !flags.has(tz.id));
}

console.log('recorded twice');
{
  const first = wi(day(1, 7), 75.2, { bodyFatPct: 18.1 });
  const again = wi(day(1, 7) + 30 * 1000, 75.2, { bodyFatPct: 18.1 });
  const later = wi(day(1, 7) + 10 * 60 * 1000, 75.2, { bodyFatPct: 18.1 });
  const flags = flagWeighIns([first, again, later], { now: NOW });
  check('an identical reading seconds later is a duplicate (the later one)', codes(flags, again.id).join() === FLAG.DUPLICATE && flags.get(again.id)[0].duplicateOfId === first.id);
  check('the original is not flagged', !flags.has(first.id));
  check('the same numbers ten minutes on are a separate weigh-in', !flags.has(later.id));
  const different = wi(day(1, 7) + 20 * 1000, 76.4);
  check('a different weight seconds later is not a duplicate', !flagWeighIns([first, different], { now: NOW }).has(different.id));
}

console.log('flag behaviour');
{
  const rows = [wi(day(1), 75, { id: 900 }), wi(day(2), 750)].map((m, i) => (i === 0 ? { ...m, id: 900 } : m));
  const copy = JSON.stringify(rows);
  const flags = flagWeighIns(rows, { now: NOW });
  check('the input is not mutated or reordered', JSON.stringify(rows) === copy);
  check('rows without an id are ignored rather than crashing', flagWeighIns([{ measuredAt: day(1), weightKg: 750 }], { now: NOW }).size === 0);
  check('flags are keyed by the row\u2019s own id', flags.has(rows[1].id) && !flags.has(900));
  const shuffled = flagWeighIns([...steady, wi(day(5, 9), 92)].reverse(), { now: NOW });
  check('input order does not matter', shuffled.size === 1);
  check('isCertainlyWrong separates impossible values from "worth a look"',
    isCertainlyWrong([{ code: FLAG.WEIGHT_RANGE }]) && isCertainlyWrong([{ code: FLAG.EMPTY }])
    && !isCertainlyWrong([{ code: FLAG.WEIGHT_JUMP }]) && !isCertainlyWrong([{ code: FLAG.DUPLICATE }]) && !isCertainlyWrong(undefined));
}

console.log('describing a flag');
{
  const jump = { code: FLAG.WEIGHT_JUMP, value: 92.3, medianKg: 75, deviationKg: 17.3 };
  check('metric wording', describeFlag(jump, 'metric') === '17.3 kg away from the readings around it (usually about 75 kg).');
  check('imperial wording converts to lb', /lb away from the readings around it \(usually about 165\.3 lb\)/.test(describeFlag(jump, 'imperial')));
  check('a range flag names the value', describeFlag({ code: FLAG.WEIGHT_RANGE, value: 750 }, 'metric') === '750 kg isn\u2019t a plausible body weight.');
  check('a field flag uses the field\u2019s label', /^Muscle mass \(90 kg\) is more than total body weight\.$/.test(describeFlag({ code: FLAG.MASS_EXCEEDS_WEIGHT, field: 'muscleMassKg', value: 90 })));
  check('every flag code has its own sentence', new Set(Object.values(FLAG).map(code => describeFlag({ code, value: 1, medianKg: 1, deviationKg: 1, medianPct: 1, deviationPts: 1, field: 'boneMassKg' }))).size === Object.values(FLAG).length);
  check('an unknown code degrades to a generic line', describeFlag({ code: 'from-the-future' }) === 'Looks unusual.');
}

console.log('the edit form: rendering a record');
const stored = wi(new Date(2026, 8, 14, 7, 5, 42, 123).getTime(), 74.98, {
  bodyFatPct: 18.24, leanBodyMassKg: deriveLeanBodyMassKg(74.98, 18.24), muscleMassKg: 33.61, visceralFatRating: 8, basalMetabolicRateKcal: 1712,
});
{
  const m = weighInDraft(stored, 'metric');
  check('the date is local, minute precision', m.measuredAt === '2026-09-14T07:05');
  check('metric values are shown to one decimal, blanks stay blank',
    m.weightKg === '75' && m.bodyFatPct === '18.2' && m.muscleMassKg === '33.6' && m.boneMassKg === '' && m.bodyWaterKg === '');
  check('index and kcal fields are whole numbers', m.visceralFatRating === '8' && m.basalMetabolicRateKcal === '1712');
  const i = weighInDraft(stored, 'imperial');
  check('imperial masses convert to lb; percent, index and kcal don\u2019t', i.weightKg === '165.3' && i.muscleMassKg === '74.1' && i.bodyFatPct === '18.2' && i.basalMetabolicRateKcal === '1712');
  check('toLocalDateTimeInput round-trips a local time', toLocalDateTimeInput(new Date(2026, 0, 2, 3, 4).getTime()) === '2026-01-02T03:04');
}

console.log('the edit form: saving');
{
  const untouched = parseWeighInDraft(weighInDraft(stored, 'metric'), stored, { units: 'metric', now: NOW });
  check('saving without changing anything gives back exactly what was stored',
    untouched.ok && JSON.stringify(untouched.value) === JSON.stringify(stored));
  const untouchedLb = parseWeighInDraft(weighInDraft(stored, 'imperial'), stored, { units: 'imperial', now: NOW });
  check('...even in pounds: untouched fields never pick up lb <-> kg rounding',
    untouchedLb.ok && untouchedLb.value.weightKg === 74.98 && untouchedLb.value.muscleMassKg === 33.61 && untouchedLb.value.measuredAt === stored.measuredAt);
}
{
  const draft = { ...weighInDraft(stored, 'metric'), weightKg: '73.4' };
  const r = parseWeighInDraft(draft, stored, { units: 'metric', now: NOW });
  check('changing the weight changes only the weight (and what derives from it)',
    r.ok && r.value.weightKg === 73.4 && r.value.bodyFatPct === 18.24 && r.value.muscleMassKg === 33.61 && r.value.id === stored.id && r.value.source === 'ble-scale');
  check('lean mass is re-derived from the new weight and the body fat', r.ok && Math.abs(r.value.leanBodyMassKg - deriveLeanBodyMassKg(73.4, 18.24)) < 1e-9);
}
{
  const draft = { ...weighInDraft(stored, 'imperial'), weightKg: '165' };
  const r = parseWeighInDraft(draft, stored, { units: 'imperial', now: NOW });
  check('a typed imperial weight is stored in kg', r.ok && r.value.weightKg === 74.84);
}
{
  const draft = { ...weighInDraft(stored, 'metric'), measuredAt: '2026-09-13T21:30' };
  const r = parseWeighInDraft(draft, stored, { units: 'metric', now: NOW });
  check('a changed date is parsed as local time', r.ok && r.value.measuredAt === new Date(2026, 8, 13, 21, 30).getTime());
  const cleared = parseWeighInDraft({ ...weighInDraft(stored, 'metric'), bodyFatPct: '', muscleMassKg: '' }, stored, { units: 'metric', now: NOW });
  check('clearing a field removes the value; with no body fat, lean mass goes too',
    cleared.ok && cleared.value.bodyFatPct === null && cleared.value.muscleMassKg === null && cleared.value.leanBodyMassKg === null);
}
{
  const leanOnly = wi(day(3), 70, { leanBodyMassKg: 58 });
  const kept = parseWeighInDraft({ ...weighInDraft(leanOnly, 'metric'), measuredAt: '2026-09-10T08:00' }, leanOnly, { units: 'metric', now: NOW });
  check('a lean mass that can\u2019t be derived survives an edit that doesn\u2019t touch weight or body fat', kept.ok && kept.value.leanBodyMassKg === 58);
  const dropped = parseWeighInDraft({ ...weighInDraft(leanOnly, 'metric'), weightKg: '71' }, leanOnly, { units: 'metric', now: NOW });
  check('...but not one that the edit has made stale', dropped.ok && dropped.value.leanBodyMassKg === null);
}

console.log('the edit form: rejecting bad input');
{
  const base = weighInDraft(stored, 'metric');
  const bad = (over, units = 'metric') => parseWeighInDraft({ ...weighInDraft(stored, units), ...over }, stored, { units, now: NOW });
  check('text in a number field', bad({ weightKg: 'heavy' }).errors?.weightKg === 'Weight must be a number.');
  check('a weight out of range names the range in metric', bad({ weightKg: '750' }).errors?.weightKg === 'Weight must be between 20 and 350 kg.');
  check('...and in pounds', bad({ weightKg: '1000' }, 'imperial').errors?.weightKg === 'Weight must be between 44 and 772 lb.');
  check('body fat out of range', bad({ bodyFatPct: '85' }).errors?.bodyFatPct === 'Body fat must be between 1 and 70 %.');
  check('a mass bigger than the person', bad({ boneMassKg: '90' }).errors?.boneMassKg === 'Bone mass can\u2019t be more than body weight.');
  check('a zero mass', bad({ bodyWaterKg: '0' }).errors?.bodyWaterKg === 'Body water must be more than zero.');
  check('an unreadable date', bad({ measuredAt: '' }).errors?.measuredAt === 'Enter a valid date and time.' && bad({ measuredAt: 'soon' }).errors?.measuredAt === 'Enter a valid date and time.');
  check('a date in the future', bad({ measuredAt: '2030-01-01T00:00' }).errors?.measuredAt === 'That date is in the future.');
  const blank = Object.fromEntries(Object.keys(base).map(k => [k, k === 'measuredAt' ? base.measuredAt : '']));
  check('a form with every reading cleared is rejected as a whole', parseWeighInDraft(blank, stored, { units: 'metric', now: NOW }).errors?.form === 'Enter at least one value \u2014 or delete this weigh-in instead.');
  const everything = parseWeighInDraft({ ...base, weightKg: '9x', bodyFatPct: '99' }, stored, { units: 'metric', now: NOW });
  check('every problem is reported at once, not just the first', !everything.ok && Object.keys(everything.errors).sort().join() === 'bodyFatPct,weightKg');
  const impossible = wi(day(2), 750);
  const fixDateOnly = parseWeighInDraft({ ...weighInDraft(impossible, 'metric'), measuredAt: '2026-09-01T08:00' }, impossible, { units: 'metric', now: NOW });
  check('an untouched impossible value still blocks the save (fix the value, not just the date)', !fixDateOnly.ok && !!fixDateOnly.errors.weightKg);
}

console.log('list headline');
check('weight and body fat', weighInHeadline(stored, 'metric') === '75 kg \u00B7 18.2% fat');
check('imperial', weighInHeadline(stored, 'imperial') === '165.3 lb \u00B7 18.2% fat');
check('composition only', weighInHeadline(wi(day(1), null, { muscleMassKg: 30, bodyWaterKg: 40 })) === 'muscle mass, body water');
check('nothing at all', weighInHeadline(wi(day(1), null)) === 'No readings');
check('WEIGH_IN_FIELDS covers every field the model stores except the derived lean mass',
  WEIGH_IN_FIELDS.map(f => f.key).sort().join() === ['basalMetabolicRateKcal', 'bodyFatPct', 'bodyWaterKg', 'boneMassKg', 'muscleMassKg', 'visceralFatRating', 'weightKg'].sort().join());

if (failures) {
  console.log(`\n${failures} weigh-in review check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll weigh-in review checks passed.');
