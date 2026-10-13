// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * views/overview-detail.js
 *
 * What an Overview card's detail sheet says. Pure: it takes the
 * numbers views/overview.js has already worked out for the page and returns a plain model,
 * so it can be read, tested and changed without a DOM. overview.js draws the model into the
 * shared detail sheet (ui/detail-sheet.js).
 *
 * Why it exists: a card on the page is one number and a tiny visual. Everything that used to
 * be crammed into its (i) tooltip — what the number means, where it comes from, the window it
 * covers — and the figures behind the picture (every month, every zone, last week for
 * comparison) lives here instead, one tap away.
 *
 * Model:
 *   {
 *     title:    'Power Zones',
 *     subtitle: 'Last 30 days',                 // one short line for the sheet header
 *     about:    'Time in zone across ...',      // the old tooltip text, as a paragraph
 *     rows:     [{ label, value, note?, metric?, color? }],
 *     settings: { ids: ['pref-ftp'], label: 'Edit FTP' } | null   // a header button to the field
 *   }
 * `metric` takes the same keys as `.stat-chip[data-metric]` (power, np, heartRate, distance,
 * calories, time) so a row carries that metric's rule colour; `color` is a literal CSS colour
 * for rows that have none of their own (a zone). Nothing here escapes HTML — the renderer does.
 */

import { formatDistance, weightUnitLabel, kgToLb } from '../metrics/units.js';

const DASH = '\u2014';

/** "3h 45m" / "42m" / "—" for nothing. Overview's own duration format. */
export function fmtDuration(sec) {
  if (!sec) return DASH;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const _plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const _shortDate = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function _longDuration(sec) {
  if (!sec) return DASH;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** A week's totals against the week before, as the "last week" note under a row. */
const _vs = (prev, text) => (prev ? `Last week: ${text}` : 'Last week: none');

function _week(d) {
  const { week, prev, units } = d;
  const dist = (v) => (v ? formatDistance(v, units) : DASH);
  return {
    title: 'This Week',
    subtitle: 'Last 7 days',
    about: 'Sessions, time, distance and calories for the last 7 days, compared with the week before.',
    rows: [
      { label: 'Sessions', value: String(week.count), note: _vs(prev.count, String(prev.count)) },
      { label: 'Time', value: fmtDuration(week.duration), note: _vs(prev.duration, fmtDuration(prev.duration)), metric: 'time' },
      { label: 'Distance', value: dist(week.distance), note: _vs(prev.distance, dist(prev.distance)), metric: 'distance' },
      { label: 'Calories', value: week.calories ? `${Math.round(week.calories)} kcal` : DASH,
        note: _vs(prev.calories, `${Math.round(prev.calories)} kcal`), metric: 'calories' },
      ...(week.avgPower != null ? [{ label: 'Average power', value: `${week.avgPower} W`,
        note: _vs(prev.avgPower != null, `${prev.avgPower} W`), metric: 'power' }] : []),
    ],
  };
}

function _year(d) {
  const y = d.yearMap;
  const first = y.months[0];
  const last = y.months[y.months.length - 1];
  return {
    title: 'Past 12 Months',
    subtitle: `${first.label} ${first.year} \u2013 ${last.label} ${last.year}`,
    about: 'Time trained in each of the past 12 months, oldest first, so this month is the last square '
      + 'on the card. Each square is shaded against your busiest month of the twelve.',
    rows: [
      { label: 'Total', value: fmtDuration(y.totalSeconds), note: _plural(y.totalSessions, 'session'), metric: 'time' },
      ...y.months.map(m => ({
        label: `${m.name} ${m.year}${m.current ? ' (so far)' : ''}`,
        value: m.seconds ? fmtDuration(m.seconds) : DASH,
        note: m.seconds ? null : 'No training',
      })),
    ],
  };
}

function _volume(d) {
  const weeks = d.trend;
  const rows = weeks.map((w, i) => {
    const ago = weeks.length - 1 - i;
    return {
      label: ago === 0 ? 'This week' : ago === 1 ? 'Last week' : `${ago} weeks ago`,
      value: w.minutes ? fmtDuration(Math.round(w.minutes * 60)) : DASH,
      note: w.minutes ? null : 'No training',
    };
  }).reverse();
  return {
    title: 'Weekly Volume',
    subtitle: `Last ${weeks.length} weeks`,
    about: `Minutes trained in each of the last ${weeks.length} weeks, newest first. A week here is a rolling `
      + 'seven days counted back from now, not a calendar week.',
    rows,
  };
}

function _nutrition(d) {
  const { daysLogged, avgKcal, targetKcal, split } = d.nutrition;
  const total = split.proteinKcal + split.carbsKcal + split.fatKcal;
  const macro = (label, kcal, color) => ({
    label, color,
    value: total > 0 ? `${Math.round((kcal / total) * 100)}%` : DASH,
    note: `${Math.round(kcal)} kcal`,
  });
  return {
    title: 'Weekly Nutrition',
    subtitle: 'Last 7 days',
    about: (targetKcal != null
      ? `Averaging ${Math.round(targetKcal)} kcal/day target (BMR + logged exercise). `
      : 'Set age/sex/height (or body-fat %) in Settings \u2192 Profile to see a daily target. ')
      + 'Last 7 days, from the Diet tab.',
    rows: [
      { label: 'Average per day', value: `${Math.round(avgKcal)} kcal`, note: `Over the ${_plural(daysLogged, 'day')} you logged`, metric: 'calories' },
      ...(targetKcal != null ? [{ label: 'Daily target', value: `${Math.round(targetKcal)} kcal` }] : []),
      { label: 'Days logged', value: `${daysLogged} of 7` },
      macro('Protein', split.proteinKcal, 'var(--color-protein)'),
      macro('Carbs', split.carbsKcal, 'var(--color-carbs)'),
      macro('Fat', split.fatKcal, 'var(--color-fat)'),
    ],
  };
}

function _zones(d, { key, title, about }) {
  const zoneDist = d[key];
  return {
    title,
    subtitle: 'Last 30 days',
    about,
    rows: zoneDist.map(z => ({
      label: `Z${z.zone} ${z.name}`,
      value: `${z.pct}%`,
      note: !z.seconds ? 'No time' : z.seconds < 60 ? '<1m' : fmtDuration(z.seconds),
      color: z.color,
    })),
  };
}

function _heart(d) {
  const { profile, estimatedMaxHr } = d;
  const maxIsMeasured = profile.maxHr != null;
  return {
    title: 'Heart',
    subtitle: 'Today\u2019s values',
    about: 'Your current resting and max heart rate, from Settings \u2192 Testing. A daily trend isn\u2019t tracked yet.',
    rows: [
      { label: 'Resting', value: profile.restingHr != null ? `${profile.restingHr} bpm` : DASH, metric: 'heartRate' },
      { label: 'Max', value: (maxIsMeasured ? profile.maxHr : estimatedMaxHr) != null
          ? `${maxIsMeasured ? profile.maxHr : estimatedMaxHr} bpm` : DASH,
        note: maxIsMeasured ? 'Measured or entered' : 'Estimated from your age', metric: 'heartRate' },
    ],
    settings: { ids: ['pref-resting-hr', 'pref-max-hr'], label: 'Edit heart rate' },
  };
}

function _pwr(d) {
  const { profile, ratio, tier } = d;
  const wUnit = weightUnitLabel(profile.units);
  const weight = profile.units === 'imperial' ? Math.round(kgToLb(profile.riderWeight)) : Math.round(profile.riderWeight);
  return {
    title: 'Power-to-Weight',
    subtitle: 'FTP \u00f7 body weight',
    about: `FTP ${profile.ftp} W \u00f7 ${weight} ${wUnit} weight. A rough guide, not a lab test.`,
    rows: [
      { label: 'Power-to-weight', value: `${ratio.toFixed(2)} W/kg`, note: tier, metric: 'power' },
      { label: 'FTP', value: `${profile.ftp} W`, metric: 'power' },
      { label: 'Weight', value: `${weight} ${wUnit}` },
    ],
    settings: { ids: ['pref-ftp', 'pref-weight'], label: 'Edit FTP & weight' },
  };
}

function _vo2(d) {
  const { profile } = d;
  return {
    title: 'VO2 Max',
    subtitle: profile.vo2MaxDate ? `Tested ${_shortDate(profile.vo2MaxDate)}` : 'From your last ramp test',
    about: 'Estimated from ramp-test peak power output (Storer-Davis) \u2014 a field estimate, not a lab test.',
    rows: [
      { label: 'VO2 max', value: `${profile.vo2Max} mL/kg/min` },
      ...(profile.vo2MaxDate ? [{ label: 'Last tested', value: _shortDate(profile.vo2MaxDate) }] : []),
    ],
  };
}

function _ftp(d) {
  return {
    title: 'FTP',
    subtitle: 'Functional Threshold Power',
    about: 'Your saved Functional Threshold Power, from Settings \u2192 Testing. Your power zones are built from it.',
    rows: [{ label: 'FTP', value: `${d.profile.ftp} W`, metric: 'power' }],
    settings: { ids: ['pref-ftp'], label: 'Edit FTP' },
  };
}

function _bests(d) {
  const { bests, units } = d;
  const row = (label, value, ts, metric) => ({
    label, value: value ?? DASH, note: ts ? _shortDate(ts) : null, metric,
  });
  return {
    title: 'Personal Bests',
    subtitle: 'Across all sessions',
    about: 'Peak power, best normalized power, longest session and furthest distance across all your sessions.',
    rows: [
      row('Peak power', bests.peakPower != null ? `${Math.round(bests.peakPower)} W` : null, bests.peakPowerDate, 'power'),
      row('Best normalized power', bests.bestNp != null ? `${Math.round(bests.bestNp)} W` : null, bests.bestNpDate, 'np'),
      row('Longest session', bests.longest != null ? _longDuration(bests.longest) : null, bests.longestDate, 'time'),
      row('Furthest', bests.furthest != null ? formatDistance(bests.furthest, units) : null, bests.furthestDate, 'distance'),
    ],
  };
}

const _ZONE_ABOUT = {
  zones: {
    key: 'zoneDist', title: 'Power Zones',
    about: 'Time in zone across all sessions with power data in the last 30 days, based on your saved FTP.',
  },
  hrzones: {
    key: 'hrZoneDist', title: 'Heart Rate Zones',
    about: 'Time in zone across all sessions with heart-rate data in the last 30 days, based on your saved max/resting HR.',
  },
};

/** The card ids that have a detail sheet. (Recent opens History; the weight card has its own controls.) */
export const DETAIL_IDS = ['week', 'year', 'volume', 'nutrition', 'heart', 'zones', 'hrzones', 'pwr', 'vo2max', 'ftp', 'bests'];

/**
 * @param {string} id  a card id (see DETAIL_IDS)
 * @param {Object} d   what overview.js computed: { units, week, prev, yearMap, trend, nutrition,
 *                     zoneDist, hrZoneDist, profile, estimatedMaxHr, ratio, tier, bests }
 * @returns {Object|null}  the model, or null for an id with no sheet
 */
export function overviewDetail(id, d) {
  switch (id) {
    case 'week':      return _week(d);
    case 'year':      return _year(d);
    case 'volume':    return _volume(d);
    case 'nutrition': return _nutrition(d);
    case 'heart':     return _heart(d);
    case 'zones':
    case 'hrzones':   return _zones(d, _ZONE_ABOUT[id]);
    case 'pwr':       return _pwr(d);
    case 'vo2max':    return _vo2(d);
    case 'ftp':       return _ftp(d);
    case 'bests':     return _bests(d);
    default:          return null;
  }
}
