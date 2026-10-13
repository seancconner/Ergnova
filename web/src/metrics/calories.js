// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/calories.js
 *
 * Estimates calories burned from power output, for devices that don't
 * report their own calorie counter (most FTMS trainers).
 *
 * Converts mechanical work (watts × seconds → joules → kcal) into an
 * estimated *metabolic* burn by dividing by an assumed human mechanical
 * efficiency — this is why a rider burns noticeably more calories than
 * their power meter's wattage alone represents as pure work output.
 *
 * Same constants (4184 J/kcal, ~24% efficiency) as ble/merach-device.js's
 * own on-device estimate, so this app-side estimate for any other trainer
 * lands in the same ballpark as a Merach's self-reported total.
 *
 * Usage:
 *   import { caloriesFromPower } from './metrics/calories.js';
 *   totalKcal += caloriesFromPower(220, 1);  // 220 W held for 1 second
 */

const JOULES_PER_KCAL       = 4184;
const MECHANICAL_EFFICIENCY = 0.24; // ~20-25% is typical for cycling

/**
 * @param {number} watts        Power output (instantaneous or average), in watts.
 * @param {number} seconds      Duration this power was sustained for.
 * @param {number} [efficiency] Fraction of mechanical work converted from
 *                               metabolic energy. Defaults to 0.24.
 * @returns {number}            Estimated kcal burned over that interval (>= 0).
 */
export function caloriesFromPower(watts, seconds, efficiency = MECHANICAL_EFFICIENCY) {
  if (!watts || watts <= 0 || !seconds || seconds <= 0) return 0;
  const joules = watts * seconds;
  return (joules / JOULES_PER_KCAL) / efficiency;
}

export default { caloriesFromPower };
