// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/normalized-power.js
 * metrics/intensity-factor.js
 * metrics/tss.js
 *
 * All three in one file — they're small and always used together.
 *
 * Algorithms follow the Coggan/TrainingPeaks definitions:
 *
 *   NP  = 4th root of the mean of (30-second rolling average power)^4
 *   IF  = NP / FTP
 *   TSS = (duration_seconds × NP × IF) / (FTP × 3600) × 100
 *
 * Usage:
 *   import { normalizedPower, intensityFactor, tss } from './metrics/normalized-power.js';
 *
 *   const np  = normalizedPower(samples);        // watts
 *   const IF  = intensityFactor(np, 280);        // e.g. 0.88
 *   const TSS = tss(3600, np, IF);               // e.g. 75
 */

/**
 * Compute Normalized Power from a sample array.
 * Requires at least 30 samples (30 seconds) of power data.
 * Returns null if there is insufficient data.
 *
 * @param {Sample[]} samples   Full session sample buffer (1 Hz assumed)
 * @returns {number|null}      NP in watts, or null
 */
export function normalizedPower(samples) {
  const powers = samples.map(s => s.power).filter(v => v !== null);
  if (powers.length < 30) return null;

  // 30-second rolling average at each point
  const rolling = [];
  for (let i = 0; i < powers.length; i++) {
    const window = powers.slice(Math.max(0, i - 29), i + 1);
    const avg    = window.reduce((a, b) => a + b, 0) / window.length;
    rolling.push(avg);
  }

  // Mean of fourth powers, then fourth root
  const meanFourth = rolling.reduce((a, v) => a + Math.pow(v, 4), 0) / rolling.length;
  return Math.round(Math.pow(meanFourth, 0.25));
}

/**
 * Compute Intensity Factor.
 *
 * @param {number}      np   Normalized power (watts)
 * @param {number}      ftp  FTP (watts)
 * @returns {number}         IF (0.0 – ~1.5+), rounded to 2 decimal places
 */
export function intensityFactor(np, ftp) {
  if (!ftp || ftp <= 0 || np == null) return null;
  return Math.round((np / ftp) * 100) / 100;
}

/**
 * Compute Training Stress Score.
 *
 * @param {number} durationSec  Session duration in seconds
 * @param {number} np           Normalized power (watts)
 * @param {number} IF           Intensity Factor (from intensityFactor())
 * @param {number} ftp          FTP (watts)
 * @returns {number}            TSS (integer), or null if inputs are missing
 */
export function tss(durationSec, np, IF, ftp) {
  if (!durationSec || np == null || IF == null || !ftp || ftp <= 0) return null;
  return Math.round((durationSec * np * IF) / (ftp * 3600) * 100);
}

/**
 * Compute all three metrics in one call.
 * Convenience wrapper for the post-session summary panel.
 *
 * @param {Sample[]} samples
 * @param {number}   ftp
 * @returns {{ np: number|null, if: number|null, tss: number|null }}
 */
export function computeMetrics(samples, ftp) {
  const np  = normalizedPower(samples);
  const IF  = intensityFactor(np, ftp);
  const dur = samples.length > 0
    ? ((samples[samples.length - 1].timestamp - samples[0].timestamp) / 1000)
    : 0;
  const TSS = tss(dur, np, IF, ftp);
  return { np, if: IF, tss: TSS };
}

export default { normalizedPower, intensityFactor, tss, computeMetrics };
