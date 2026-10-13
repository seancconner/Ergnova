// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/hr-zones.js
 *
 * Heart-rate training zone definitions — the HR-side counterpart to
 * metrics/ftp-zones.js. Same five-zone shape (Warm Up / Easy / Aerobic /
 * Threshold / Maximum) either way, but the zone *boundaries* in bpm depend
 * on which formula there's enough profile data to use:
 *
 *   KARVONEN / Heart-Rate-Reserve (HRR) — used whenever a resting HR is on
 *   file:
 *     Karvonen MJ, Kentala E, Mustala O. "The effects of training on heart
 *     rate; a longitudinal study." Ann Med Exp Biol Fenn. 1957;35(3):307-15.
 *   target = restingHR + %intensity × (maxHR − restingHR)
 *   Generally considered more individualized than a straight %-of-max
 *   table, since it accounts for the rider's own aerobic base (a lower
 *   resting HR shifts every zone's floor down with it) rather than only
 *   their ceiling.
 *
 *   %MAX-HR fallback — used when there's a maxHR but no resting HR on
 *   file: target = %intensity × maxHR. Less individualized, but a
 *   reasonable zone strip is still better than none while the rider hasn't
 *   run the Resting HR Test yet (see metrics/hr-test.js) or entered one by
 *   hand.
 *
 * maxHR itself, when the rider hasn't entered one directly, is estimated
 * from age via the Tanaka regression (an update to the older, cruder
 * "220 − age" rule of thumb still floating around):
 *   Tanaka H, Monahan KD, Seals DR. "Age-predicted maximal heart rate
 *   revisited." J Am Coll Cardiol. 2001;37(1):153-6.
 *   maxHR = 208 − 0.7 × age
 *
 * Unlike FTP, none of this ever drives a trainer command — heart rate
 * can't be commanded to a trainer at all (see core/cardio-model.js#
 * heartRateZone) — it's purely a display/analysis lens: which zone a given
 * bpm reading falls into, and time-in-zone across a ride.
 *
 * Usage:
 *   import { zoneForHr, zonesForHr, timeInZonesHr, estimateMaxHr } from './metrics/hr-zones.js';
 *
 *   const maxHr = profile.maxHr ?? estimateMaxHr(profile.age);
 *   const zone  = zoneForHr(152, { maxHr, restingHr: profile.restingHr });
 *   const strip = zonesForHr({ maxHr, restingHr: profile.restingHr });
 */

// Same five-zone convention whichever formula computes the actual bpm
// boundaries (see hrrFraction() below) — pctLow/pctHigh here are read as
// "% of heart-rate reserve" when a resting HR is on file, or "% of max HR"
// otherwise. Colors reuse the same low→high palette metrics/ftp-zones.js
// uses (grey/blue/green/amber/red) so a zone number reads as roughly the
// same intensity everywhere in the app, just with heart rate's five bands
// standing in for power's seven.
import { themeColor } from '../charts/chart-theme.js';

export const ZONES = Object.freeze([
  { zone: 1, name: 'Warm Up',   pctLow: 0,    pctHigh: 0.60, color: themeColor('--zone-recovery') },
  { zone: 2, name: 'Easy',      pctLow: 0.60, pctHigh: 0.70, color: themeColor('--zone-endurance') },
  { zone: 3, name: 'Aerobic',   pctLow: 0.70, pctHigh: 0.80, color: themeColor('--zone-tempo') },
  { zone: 4, name: 'Threshold', pctLow: 0.80, pctHigh: 0.90, color: themeColor('--zone-threshold') },
  { zone: 5, name: 'Maximum',   pctLow: 0.90, pctHigh: Infinity, color: themeColor('--zone-anaerobic') },
]);

/**
 * Estimates maximum heart rate from age via the Tanaka regression (see
 * module doc above). Used as the fallback whenever the rider hasn't
 * entered a measured/known max HR directly.
 *
 * @param {number|null} age
 * @returns {number|null}  Rounded bpm, or null if age is missing/invalid.
 */
export function estimateMaxHr(age) {
  if (!age || age <= 0) return null;
  return Math.round(208 - 0.7 * age);
}

/**
 * Whether zonesForHr()/zoneForHr() below have enough to compute the more
 * individualized Karvonen (HRR) boundaries, vs. falling back to straight
 * %-of-max-HR. Exported so UI code (the zone strip's info tip, the
 * Resting HR settings row) can say which method is actually in effect
 * rather than the rider having to infer it from the numbers.
 *
 * @param {Object} opts
 * @param {number|null} opts.maxHr
 * @param {number|null} opts.restingHr
 * @returns {boolean}
 */
export function usesHrr({ maxHr, restingHr } = {}) {
  return maxHr != null && restingHr != null && restingHr > 0 && restingHr < maxHr;
}

/**
 * Fraction of heart-rate-reserve (or, without a resting HR, of max HR)
 * that a given bpm reading represents. Shared by zoneForHr() and
 * zonesForHr() so the two can't drift on which formula is "in effect".
 * @returns {number|null}  null if maxHr is missing (nothing to divide by).
 */
function _hrFraction(bpm, { maxHr, restingHr } = {}) {
  if (!maxHr) return null;
  if (usesHrr({ maxHr, restingHr })) {
    return (bpm - restingHr) / (maxHr - restingHr);
  }
  return bpm / maxHr;
}

/**
 * Returns the zone definition for a given heart rate.
 *
 * @param {number}      bpm
 * @param {Object}      opts
 * @param {number|null} opts.maxHr      Required — see estimateMaxHr() for
 *                                      an age-based fallback.
 * @param {number|null} [opts.restingHr] Optional — enables the more
 *                                      individualized Karvonen/HRR method
 *                                      when present (see usesHrr()).
 * @returns {Object|null}  Zone definition, or null if maxHr is missing.
 */
export function zoneForHr(bpm, { maxHr, restingHr } = {}) {
  const pct = _hrFraction(bpm, { maxHr, restingHr });
  if (pct == null) return null;
  const found = ZONES.find(z => pct >= z.pctLow && pct < z.pctHigh);
  if (found) return found;
  // Below Zone 1's floor (e.g. a genuinely resting reading, or noise from
  // a strap settling) floors at Zone 1 rather than wrapping to Zone 5 —
  // unlike zoneForPower()'s equivalent fallback in ftp-zones.js, which
  // only ever needs to handle the "no FTP on file" case, a heart-rate
  // reading legitimately sits below the lowest zone's floor all the time
  // (any time the rider is at genuine rest), so this has to be handled
  // correctly rather than defaulting to whichever edge is more common.
  return pct < ZONES[0].pctLow ? ZONES[0] : ZONES[ZONES.length - 1];
}

/**
 * Returns all zone definitions with absolute bpm boundaries.
 *
 * @param {Object}      opts
 * @param {number|null} opts.maxHr
 * @param {number|null} [opts.restingHr]
 * @returns {{ zone, name, color, low, high, label, method }[]}
 *          Empty array if maxHr is missing — nothing to compute a strip
 *          from yet (mirrors zonesForFtp() returning meaningless output
 *          for a missing FTP, except this actively avoids that rather than
 *          producing bogus zero-based boundaries).
 */
export function zonesForHr({ maxHr, restingHr } = {}) {
  if (!maxHr) return [];
  const hrr    = usesHrr({ maxHr, restingHr });
  const method = hrr ? 'hrr' : '%max';
  const toBpm  = (pct) => hrr ? restingHr + pct * (maxHr - restingHr) : pct * maxHr;

  return ZONES.map(z => ({
    zone:   z.zone,
    name:   z.name,
    color:  z.color,
    method,
    low:    Math.round(toBpm(z.pctLow)),
    high:   z.pctHigh === Infinity ? null : Math.round(toBpm(z.pctHigh)),
    label:  z.pctHigh === Infinity
      ? `>${Math.round(z.pctLow * 100)}% ${hrr ? 'HRR' : 'max'}`
      : `${Math.round(z.pctLow * 100)}–${Math.round(z.pctHigh * 100)}% ${hrr ? 'HRR' : 'max'}`,
  }));
}

/**
 * Computes time-in-zone breakdown for a sample array, same shape as
 * metrics/ftp-zones.js#timeInZones.
 *
 * @param {Sample[]}    samples
 * @param {Object}      opts
 * @param {number|null} opts.maxHr
 * @param {number|null} [opts.restingHr]
 * @returns {{ zone, name, color, seconds, pct }[]}
 */
export function timeInZonesHr(samples, { maxHr, restingHr } = {}) {
  const counts = new Array(ZONES.length).fill(0);
  if (!maxHr) {
    return ZONES.map(z => ({ zone: z.zone, name: z.name, color: z.color, seconds: 0, pct: 0 }));
  }

  for (const s of samples) {
    if (s.heartRate == null) continue;
    const z = zoneForHr(s.heartRate, { maxHr, restingHr });
    if (z) counts[z.zone - 1]++;
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

export default { ZONES, estimateMaxHr, usesHrr, zoneForHr, zonesForHr, timeInZonesHr };
