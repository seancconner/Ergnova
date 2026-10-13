// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * metrics/nutrition.js
 *
 * BMR (Basal Metabolic Rate) and calorie-balance math for the Diet panel —
 * calories.js's counterpart on the "energy in" side of the ledger, built
 * the same best-available-formula way this app already handles cardio
 * fitness estimates: whichever formula the profile has enough data for
 * wins, and it degrades to `null` (never a guess dressed up as a number)
 * when nothing does yet — same empty-until-filled-in pattern
 * metrics/vo2max.js's estimateVo2Max() and metrics/hr-zones.js's Tanaka
 * fallback already use, so the UI can prompt the rider to fill in Rider
 * Profile exactly like _pwrCard()/_vo2MaxCard() in overview.js already do
 * for a missing FTP/VO2max.
 *
 * Katch-McArdle — used whenever `leanBodyMassKg` is known (a
 * body-composition scale reading, or a manually entered body-fat %):
 *   BMR = 370 + 21.6 × lean body mass (kg)
 * The commonly cited lean-mass form (Katch FI, McArdle WD — Exercise
 * Physiology: Nutrition, Energy, and Human Performance). More accurate
 * once actual lean mass is known, and it needs nothing else — no
 * age/sex/height terms to get wrong.
 *
 * Mifflin-St Jeor — fallback used when age/sex/height are on file but lean
 * mass isn't:
 *   Mifflin MD, St Jeor ST, Hill LA, Scott BJ, Daugherty SA, Koh YO.
 *   "A new predictive equation for resting energy expenditure in healthy
 *   individuals." Am J Clin Nutr. 1990;51(2):241-247.
 *   Men:   BMR = 10 × weight(kg) + 6.25 × height(cm) − 5 × age + 5
 *   Women: BMR = 10 × weight(kg) + 6.25 × height(cm) − 5 × age − 161
 * Same tier of estimate as the Tanaka max-HR (hr-zones.js) and Storer-Davis
 * VO2max (vo2max.js) formulas already in the app — a solid field estimate,
 * not a lab substitute.
 *
 * Usage:
 *   import { estimateBmr, dailyCalorieBalance, ACTIVITY_LEVELS, activityMultiplierBudget }
 *     from './metrics/nutrition.js';
 *   const bmr = estimateBmr(profile); // kcal/day, or null until age+sex+height (or lean mass) are on file
 *   const { budgetKcal, balanceKcal } = dailyCalorieBalance({ bmr, sessions, diaryEntries });
 *   const fallbackBudget = activityMultiplierBudget(bmr, ACTIVITY_LEVELS[2].multiplier); // secondary estimate, no-session days
 */

/**
 * Estimates Basal Metabolic Rate in kcal/day. Katch-McArdle wins whenever
 * `leanBodyMassKg` is known; otherwise falls back to Mifflin-St Jeor if
 * age/sex/height/weight are all on file; otherwise `null`.
 *
 * @param {Object}                profile
 * @param {number|null}           profile.leanBodyMassKg  Derived once a body-fat % is known (scale or manual entry).
 * @param {number|null}           profile.age
 * @param {'male'|'female'|null}  profile.sex
 * @param {number|null}           profile.heightCm
 * @param {number|null}           profile.riderWeight     Body weight, kg (canonical — the same field FTP/VO2max already read).
 * @returns {number|null}         Estimated BMR, kcal/day — null if neither formula has enough data yet.
 */
export function estimateBmr(profile) {
  if (!profile) return null;

  // A directly-reported BMR (lab-measured, or read off a scale's own
  // display and entered by hand in Settings → Rider Profile) beats either
  // formula below — it's the rider's actual number, not this app's guess
  // at it. See app.js's profile.basalMetabolicRateKcal doc comment.
  if (profile.basalMetabolicRateKcal != null) {
    return profile.basalMetabolicRateKcal;
  }

  if (profile.leanBodyMassKg != null) {
    return 370 + 21.6 * profile.leanBodyMassKg;
  }

  if (
    profile.age != null &&
    (profile.sex === 'male' || profile.sex === 'female') &&
    profile.heightCm != null &&
    profile.riderWeight != null
  ) {
    return profile.sex === 'male'
      ? 10 * profile.riderWeight + 6.25 * profile.heightCm - 5 * profile.age + 5
      : 10 * profile.riderWeight + 6.25 * profile.heightCm - 5 * profile.age - 161;
  }

  return null;
}

/**
 * Today's calorie budget vs. what's been logged — the reason this feature
 * belongs in a training app rather than being a bolt-on food diary: it
 * already has *real* logged exercise calories for the day
 * (session.summary.totalCalories), so the headline number is
 *   budget = BMR + today's exercise calories
 *   balance = budget − today's logged food calories   (positive = deficit, negative = surplus)
 * instead of a generic "sedentary/active" activity-multiplier guess.
 * "Today" is the calendar day, same `.toDateString()` comparison
 * overview.js's `_streak()` uses — not a rolling 24h window.
 *
 * @param {Object}   opts
 * @param {number|null} opts.bmr             From estimateBmr() — null propagates to budgetKcal/balanceKcal below.
 * @param {Object[]} [opts.sessions=[]]      All sessions (any date; filtered to today internally), each with `startTime` + `summary.totalCalories`.
 * @param {Object[]} [opts.diaryEntries=[]]  All diary entries (any date; filtered to today internally), each with `loggedAt` + `nutrients.calories`.
 * @returns {{ exerciseKcal: number, loggedKcal: number, budgetKcal: number|null, balanceKcal: number|null }}
 *   budgetKcal/balanceKcal are null only when bmr is null (not enough
 *   Profile data yet) — exerciseKcal/loggedKcal are always real
 *   numbers so the UI can still show "logged so far" without a target
 *   line, same empty-state-degrades-gracefully approach as
 *   _pwrCard()/_vo2MaxCard() in overview.js.
 */
export function dailyCalorieBalance({ bmr, sessions = [], diaryEntries = [] }) {
  const todayStr = new Date().toDateString();
  const isToday = (timestamp) => timestamp != null && new Date(timestamp).toDateString() === todayStr;

  const exerciseKcal = sessions
    .filter(s => isToday(s.startTime))
    .reduce((sum, s) => sum + (s.summary?.totalCalories ?? 0), 0);

  const loggedKcal = diaryEntries
    .filter(e => isToday(e.loggedAt))
    .reduce((sum, e) => sum + (e.nutrients?.calories ?? 0), 0);

  if (bmr == null) {
    return { exerciseKcal, loggedKcal, budgetKcal: null, balanceKcal: null };
  }

  const budgetKcal = bmr + exerciseKcal;
  return { exerciseKcal, loggedKcal, budgetKcal, balanceKcal: budgetKcal - loggedKcal };
}

/**
 * The standard Harris-Benedict/Mifflin-style TDEE activity-multiplier
 * scale — sedentary through extra-active, spanning the 1.2x-1.9x range —
 * offered as a *secondary* option for days with no logged session.
 * dailyCalorieBalance() above is the headline number whenever there's real
 * session data to use instead of a guess; this exists purely for "haven't
 * ridden today, still want a ballpark" days, and it's never blended into
 * dailyCalorieBalance() automatically — the UI presents it as an explicit
 * alternative the rider picks, same array-of-named-levels shape
 * metrics/ftp-zones.js's ZONES / metrics/hr-zones.js's ZONES already use.
 */
export const ACTIVITY_LEVELS = Object.freeze([
  { key: 'sedentary',    label: 'Sedentary',         description: 'Little or no exercise',                       multiplier: 1.2 },
  { key: 'light',        label: 'Lightly active',    description: 'Light exercise 1-3 days/week',                multiplier: 1.375 },
  { key: 'moderate',     label: 'Moderately active', description: 'Moderate exercise 3-5 days/week',             multiplier: 1.55 },
  { key: 'active',       label: 'Very active',       description: 'Hard exercise 6-7 days/week',                 multiplier: 1.725 },
  { key: 'extra_active', label: 'Extra active',      description: 'Very hard exercise, physical job, or 2x/day', multiplier: 1.9 },
]);

/**
 * @param {number|null} bmr
 * @param {number|null} multiplier  One of ACTIVITY_LEVELS[i].multiplier.
 * @returns {number|null}  Estimated daily calorie budget; null if bmr or multiplier is missing.
 */
export function activityMultiplierBudget(bmr, multiplier) {
  if (bmr == null || multiplier == null) return null;
  return bmr * multiplier;
}

export default { estimateBmr, dailyCalorieBalance, ACTIVITY_LEVELS, activityMultiplierBudget };
