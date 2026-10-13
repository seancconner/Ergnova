// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Run with: node src/views/__overview_detail_smoketest__.js
//
// Covers views/overview-detail.js: the model behind each Overview card's detail sheet. Pure,
// so it is checked against hand-built inputs shaped like what views/overview.js hands it.

import { overviewDetail, DETAIL_IDS, fmtDuration } from './overview-detail.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` (${detail})` : ''}`); }
}
const row = (m, label) => m.rows.find(r => r.label === label);

const months = Array.from({ length: 12 }, (_, i) => ({
  name: ['October', 'November', 'December', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September'][i],
  label: ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'][i],
  year: i < 3 ? 2025 : 2026, seconds: i === 5 ? 0 : 3600 * (i + 1), level: 2, current: i === 11,
}));
const d = {
  units: 'metric',
  week: { count: 3, duration: 9000, distance: 42000, calories: 1250, avgPower: 180 },
  prev: { count: 2, duration: 5400, distance: 0, calories: 800, avgPower: null },
  yearMap: { months, totalSessions: 41, totalSeconds: 234000 },
  trend: [{ minutes: 0, label: '-2w' }, { minutes: 90, label: '-1w' }, { minutes: 150, label: 'Now' }],
  nutrition: { daysLogged: 4, avgKcal: 2310.4, targetKcal: 2500, split: { proteinKcal: 400, carbsKcal: 800, fatKcal: 800 } },
  zoneDist: [{ zone: 1, name: 'Active Recovery', pct: 40, seconds: 3600, color: '#aaa' }, { zone: 2, name: 'Endurance', pct: 0, seconds: 0, color: '#bbb' }],
  hrZoneDist: [{ zone: 1, name: 'Recovery', pct: 100, seconds: 7200, color: '#ccc' }],
  profile: { units: 'metric', ftp: 230, riderWeight: 78, restingHr: 54, maxHr: null, vo2Max: 48, vo2MaxDate: new Date(2026, 8, 12).getTime() },
  estimatedMaxHr: 184, ratio: 230 / 78, tier: 'Intermediate',
  bests: { peakPower: 612.4, peakPowerDate: new Date(2026, 8, 2).getTime(), bestNp: 251, bestNpDate: new Date(2026, 8, 3).getTime(),
           longest: 5430, longestDate: new Date(2026, 7, 20).getTime(), furthest: 61000, furthestDate: new Date(2026, 7, 21).getTime() },
};

console.log('every card id has a model');
for (const id of DETAIL_IDS) {
  const m = overviewDetail(id, d);
  check(`${id}: title, subtitle, about and rows`, !!(m && m.title && m.subtitle && m.about && m.rows.length > 0), JSON.stringify(m)?.slice(0, 80));
}
check('an id with no sheet gives null', overviewDetail('recent', d) === null && overviewDetail('body', d) === null);

console.log('\nduration format');
check('0 is a dash', fmtDuration(0) === '\u2014');
check('minutes only', fmtDuration(2520) === '42m');
check('hours and minutes', fmtDuration(13500) === '3h 45m');

console.log('\nthis week');
const wk = overviewDetail('week', d);
check('sessions shows this week with last week as the note', row(wk, 'Sessions').value === '3' && row(wk, 'Sessions').note === 'Last week: 2');
check('time against last week', row(wk, 'Time').value === '2h 30m' && row(wk, 'Time').note === 'Last week: 1h 30m');
check('a week with no distance last week says none', row(wk, 'Distance').note === 'Last week: none');
check('average power appears when this week has it', row(wk, 'Average power').value === '180 W' && row(wk, 'Average power').note === 'Last week: none');
check('average power is left out when there is none', !row(overviewDetail('week', { ...d, week: { ...d.week, avgPower: null } }), 'Average power'));

console.log('\npast 12 months');
const yr = overviewDetail('year', d);
check('subtitle names the range with years', yr.subtitle === 'Oct 2025 \u2013 Sep 2026', yr.subtitle);
check('a total row plus twelve months', yr.rows.length === 13 && yr.rows[0].label === 'Total');
check('the total counts sessions', yr.rows[0].note === '41 sessions' && yr.rows[0].value === '65h 0m', `${yr.rows[0].note} / ${yr.rows[0].value}`);
check('this month is marked as still filling', yr.rows[12].label === 'September 2026 (so far)');
check('a month with no training says so', row(yr, 'March 2026').value === '\u2014' && row(yr, 'March 2026').note === 'No training');

console.log('\nweekly volume');
const vol = overviewDetail('volume', d);
check('newest first, with plain names', vol.rows.map(r => r.label).join('|') === 'This week|Last week|2 weeks ago', vol.rows.map(r => r.label).join('|'));
check('minutes become a duration', vol.rows[0].value === '2h 30m' && vol.rows[1].value === '1h 30m');
check('an empty week is a dash with a note', vol.rows[2].value === '\u2014' && vol.rows[2].note === 'No training');

console.log('\nnutrition');
const nu = overviewDetail('nutrition', d);
check('average and days logged', row(nu, 'Average per day').value === '2310 kcal' && row(nu, 'Days logged').value === '4 of 7');
check('the target row only shows when there is one', !!row(nu, 'Daily target') && !row(overviewDetail('nutrition', { ...d, nutrition: { ...d.nutrition, targetKcal: null } }), 'Daily target'));
check('macro percentages add to 100 and carry kcal', row(nu, 'Protein').value === '20%' && row(nu, 'Carbs').value === '40%' && row(nu, 'Fat').value === '40%' && row(nu, 'Carbs').note === '800 kcal');
check('without a target the about line says how to get one', /Settings/.test(overviewDetail('nutrition', { ...d, nutrition: { ...d.nutrition, targetKcal: null } }).about));

console.log('\nzones');
const pz = overviewDetail('zones', d);
check('power zones list every zone with its name and share', pz.rows[0].label === 'Z1 Active Recovery' && pz.rows[0].value === '40%' && pz.rows[0].note === '1h 0m');
check('a zone with under a minute says so rather than "0m"', overviewDetail('zones', { ...d, zoneDist: [{ zone: 1, name: 'X', pct: 1, seconds: 20, color: '#111' }] }).rows[0].note === '<1m');
check('a zone with no time says so and still has a colour', pz.rows[1].note === 'No time' && pz.rows[1].color === '#bbb');
const hz = overviewDetail('hrzones', d);
check('heart-rate zones read the heart-rate distribution', hz.title === 'Heart Rate Zones' && hz.rows.length === 1 && hz.rows[0].value === '100%');

console.log('\nheart, ftp, power-to-weight, vo2 max');
const ht = overviewDetail('heart', d);
check('an estimated max says it is an estimate', row(ht, 'Max').value === '184 bpm' && /age/.test(row(ht, 'Max').note));
check('a measured max says so', /Measured/.test(row(overviewDetail('heart', { ...d, profile: { ...d.profile, maxHr: 190 } }), 'Max').note) && row(overviewDetail('heart', { ...d, profile: { ...d.profile, maxHr: 190 } }), 'Max').value === '190 bpm');
check('heart offers a jump to both heart-rate fields', ht.settings.ids.join() === 'pref-resting-hr,pref-max-hr');
const pw = overviewDetail('pwr', d);
check('power-to-weight shows ratio, tier, FTP and weight', row(pw, 'Power-to-weight').value === '2.95 W/kg' && row(pw, 'Power-to-weight').note === 'Intermediate' && row(pw, 'FTP').value === '230 W' && /^78 /.test(row(pw, 'Weight').value), row(pw, 'Weight').value);
check('imperial weight is converted', /^172 /.test(row(overviewDetail('pwr', { ...d, profile: { ...d.profile, units: 'imperial' } }), 'Weight').value), row(overviewDetail('pwr', { ...d, profile: { ...d.profile, units: 'imperial' } }), 'Weight').value);
check('ftp offers a jump to its field', overviewDetail('ftp', d).settings.ids.join() === 'pref-ftp');
const vo = overviewDetail('vo2max', d);
check('vo2 max shows the value and when it was tested', row(vo, 'VO2 max').value === '48 mL/kg/min' && vo.subtitle === 'Tested Sep 12', vo.subtitle);
check('vo2 max without a date still has a subtitle', !!overviewDetail('vo2max', { ...d, profile: { ...d.profile, vo2MaxDate: null } }).subtitle);
check('vo2 max has no settings jump (it comes from a test)', !vo.settings);

console.log('\nbests');
const bs = overviewDetail('bests', d);
check('four bests, each with its date', bs.rows.length === 4 && bs.rows.every(r => r.note));
check('peak power rounds and uses the power colour', row(bs, 'Peak power').value === '612 W' && row(bs, 'Peak power').metric === 'power' && row(bs, 'Peak power').note === 'Sep 2');
check('longest session keeps its seconds', row(bs, 'Longest session').value === '1h 30m 30s', row(bs, 'Longest session').value);
check('a best with no data is a dash', row(overviewDetail('bests', { ...d, bests: { ...d.bests, furthest: null, furthestDate: null } }), 'Furthest').value === '\u2014');

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll overview detail checks passed.');
