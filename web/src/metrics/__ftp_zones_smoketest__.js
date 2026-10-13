// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// FTP fallback: metrics/ftp-zones.js resolveFtp(). Pure, no DOM or IndexedDB.
// Run with: node src/metrics/__ftp_zones_smoketest__.js

import { DEFAULT_FTP_WATTS, resolveFtp, zonesForFtp } from './ftp-zones.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

console.log('resolveFtp');
check('the fallback is a typical 200 W', DEFAULT_FTP_WATTS === 200);
check('a rider\u2019s own FTP is used as-is', resolveFtp(285) === 285);
check('no FTP entered (null) falls back', resolveFtp(null) === DEFAULT_FTP_WATTS);
check('undefined falls back', resolveFtp(undefined) === DEFAULT_FTP_WATTS);
check('zero and negative values fall back', resolveFtp(0) === DEFAULT_FTP_WATTS && resolveFtp(-50) === DEFAULT_FTP_WATTS);
check('NaN falls back', resolveFtp(NaN) === DEFAULT_FTP_WATTS);
check('zones built from an unset FTP are the 200 W zones, not 0\u20130 W',
  zonesForFtp(resolveFtp(null))[3].low === 180 && zonesForFtp(resolveFtp(null))[3].high === 210);

if (failures) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll FTP fallback checks passed.');
