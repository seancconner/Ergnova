// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/one-rep-max.js
 *
 * Estimates a one-rep max (1RM) from a logged set's weight and rep count,
 * for tracking strength progression without the rider needing to actually
 * attempt a true 1RM lift. Same small-pure-function shape as
 * calories.js/vo2max.js — no state, just formulas.
 *
 * Two well-established formulas, since they diverge more at higher rep
 * counts (Brzycki degrades past ~10 reps; Epley is the more common
 * general-purpose default):
 *   Epley:   1RM = weight × (1 + reps / 30)
 *   Brzycki: 1RM = weight × 36 / (37 - reps)
 *
 * Usage:
 *   import { estimatedOneRepMax, bestOneRepMax } from './metrics/one-rep-max.js';
 *   estimatedOneRepMax(100, 5);              // Epley by default -> 117
 *   estimatedOneRepMax(100, 5, 'brzycki');
 *   bestOneRepMax(setsForOneExercise);       // best estimate across a set of logged sets
 */

/**
 * @param {number} weight   kilograms
 * @param {number} reps
 * @param {'epley'|'brzycki'} [formula='epley']
 * @returns {number|null}   Estimated 1RM in the same unit as `weight`, or
 *                           null for missing/invalid input.
 */
export function estimatedOneRepMax(weight, reps, formula = 'epley') {
  if (!weight || weight <= 0 || !reps || reps <= 0) return null;
  if (reps === 1) return Math.round(weight);

  if (formula === 'brzycki') {
    if (reps >= 37) return null; // formula inverts/goes negative past this point
    return Math.round(weight * 36 / (37 - reps));
  }
  return Math.round(weight * (1 + reps / 30));
}

/**
 * Best estimated 1RM across a list of logged StrengthSets (see
 * core/strength-model.js) for one exercise — the heaviest *estimated* max,
 * not just the heaviest logged weight, so a lighter high-rep set can still
 * win over a heavier low-rep one. Ignores HOLD-mode sets and any set
 * missing weight/reps.
 *
 * @param {import('../core/strength-model.js').StrengthSet[]} sets
 * @param {'epley'|'brzycki'} [formula='epley']
 * @returns {number|null}
 */
export function bestOneRepMax(sets, formula = 'epley') {
  const estimates = (sets ?? [])
    .filter(s => s.mode === 'reps' && s.weight != null && s.reps != null)
    .map(s => estimatedOneRepMax(s.weight, s.reps, formula))
    .filter(v => v !== null);
  return estimates.length ? Math.max(...estimates) : null;
}

export default { estimatedOneRepMax, bestOneRepMax };
