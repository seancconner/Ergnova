// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/ftp-zones.js
 *
 * FTP-based training zone definitions.
 * Matches the 7-zone model used by TrainingPeaks / Coggan.
 *
 * Usage:
 *   import { getZone, ZONES, zoneForPower, zonesForFtp } from './metrics/ftp-zones.js';
 *
 *   const zone = zoneForPower(245, 280);  // → Zone 4 (Threshold)
 *   const zones = zonesForFtp(280);       // → array of { zone, name, low, high, color }
 */

import { themeColor } from '../charts/chart-theme.js';

export const ZONES = Object.freeze([
  { zone: 1, name: 'Active Recovery', pctLow: 0,    pctHigh: 0.55, color: themeColor('--zone-recovery') },
  { zone: 2, name: 'Endurance',       pctLow: 0.55, pctHigh: 0.75, color: themeColor('--zone-endurance') },
  { zone: 3, name: 'Tempo',           pctLow: 0.75, pctHigh: 0.90, color: themeColor('--zone-tempo') },
  { zone: 4, name: 'Threshold',       pctLow: 0.90, pctHigh: 1.05, color: themeColor('--zone-threshold') },
  { zone: 5, name: 'VO2 Max',         pctLow: 1.05, pctHigh: 1.20, color: themeColor('--zone-vo2') },
  { zone: 6, name: 'Anaerobic',       pctLow: 1.20, pctHigh: 1.50, color: themeColor('--zone-anaerobic') },
  { zone: 7, name: 'Neuromuscular',   pctLow: 1.50, pctHigh: Infinity, color: themeColor('--zone-neuro') },
]);

/**
 * The FTP everything falls back to until the rider enters their own. It is a
 * working number for zones, workout targets and the fitness tests — never a
 * stored setting: profile.ftp stays null until it's typed in (or accepted from
 * an FTP test), so anything that asks "did the rider give us an FTP?" (the
 * Overview's Power-to-Weight card) reads the raw field, and anything that just
 * needs a number goes through resolveFtp().
 */
export const DEFAULT_FTP_WATTS = 200;

/**
 * The FTP to compute with: the rider's own when they have one, otherwise
 * DEFAULT_FTP_WATTS.
 *
 * @param {number|null|undefined} ftp  profile.ftp
 * @returns {number}
 */
export function resolveFtp(ftp) {
  return ftp > 0 ? ftp : DEFAULT_FTP_WATTS;
}

/**
 * Returns the zone definition for a given power and FTP.
 * Returns Zone 1 if power is 0 or below.
 *
 * @param {number} watts
 * @param {number} ftp
 * @returns {Object}  Zone definition with { zone, name, pctLow, pctHigh, color }
 */
export function zoneForPower(watts, ftp) {
  if (!ftp || ftp <= 0) return ZONES[0];
  const pct = watts / ftp;
  return ZONES.find(z => pct >= z.pctLow && pct < z.pctHigh) ?? ZONES[ZONES.length - 1];
}

/**
 * Returns all zone definitions with absolute watt boundaries for a given FTP.
 *
 * @param {number} ftp
 * @returns {{ zone, name, low, high, color }[]}
 */
export function zonesForFtp(ftp) {
  return ZONES.map(z => ({
    zone:  z.zone,
    name:  z.name,
    color: z.color,
    low:   Math.round(z.pctLow  * ftp),
    high:  z.pctHigh === Infinity ? null : Math.round(z.pctHigh * ftp),
    label: z.pctHigh === Infinity
      ? `>${Math.round(z.pctLow * 100)}% FTP`
      : `${Math.round(z.pctLow * 100)}–${Math.round(z.pctHigh * 100)}% FTP`,
  }));
}

/**
 * Computes time-in-zone breakdown for a sample array.
 *
 * @param {Sample[]} samples
 * @param {number}   ftp
 * @returns {{ zone, name, color, seconds, pct }[]}
 */
export function timeInZones(samples, ftp) {
  const counts = new Array(ZONES.length).fill(0);

  for (const s of samples) {
    if (s.power === null) continue;
    const z = zoneForPower(s.power, ftp);
    counts[z.zone - 1]++;
  }

  const total = counts.reduce((a, b) => a + b, 0) || 1;

  return ZONES.map((z, i) => ({
    zone:    z.zone,
    name:    z.name,
    color:   z.color,
    seconds: counts[i],
    pct:     Math.round((counts[i] / total) * 100),
  }));
}

export default { ZONES, DEFAULT_FTP_WATTS, resolveFtp, zoneForPower, zonesForFtp, timeInZones };
