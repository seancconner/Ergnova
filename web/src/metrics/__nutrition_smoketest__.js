// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// metrics/nutrition.js smoke test. Run with:
//   node src/metrics/__nutrition_smoketest__.js
//
// Covers estimateBmr()'s three tiers (directly-reported BMR,
// Katch-McArdle, Mifflin-St Jeor) plus its null-until-filled-in empty
// state, dailyCalorieBalance()'s today-filtering/exercise-vs-logged math,
// and activityMultiplierBudget()'s fallback multiplier. Pure math — no
// DOM/BLE/IndexedDB involved, same scope as metrics/__smoketest__.js's
// vo2max.js coverage, so this runs directly.

import { estimateBmr, dailyCalorieBalance, ACTIVITY_LEVELS, activityMultiplierBudget }
  from './nutrition.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}
function closeTo(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

console.log('nutrition.js (estimateBmr — directly-reported BMR, top priority)');
{
  const reportedOnly = estimateBmr({ basalMetabolicRateKcal: 1478, leanBodyMassKg: null, age: null, sex: null, heightCm: null, riderWeight: null });
  check('basalMetabolicRateKcal alone is enough (no other inputs needed)', closeTo(reportedOnly, 1478));

  const reportedWinsOverLean = estimateBmr({ basalMetabolicRateKcal: 1478, leanBodyMassKg: 60, age: 40, sex: 'male', heightCm: 180, riderWeight: 80 });
  check('basalMetabolicRateKcal takes priority even when Katch-McArdle and Mifflin-St Jeor inputs are also present', closeTo(reportedWinsOverLean, 1478));
}

console.log('nutrition.js (estimateBmr — Katch-McArdle branch)');
{
  // 370 + 21.6 * 60 = 1666 — wins outright whenever leanBodyMassKg is known,
  // regardless of what else is (or isn't) on the profile.
  const leanOnly = estimateBmr({ leanBodyMassKg: 60, age: null, sex: null, heightCm: null, riderWeight: null });
  check('leanBodyMassKg alone is enough (no age/sex/height needed)', closeTo(leanOnly, 1666));

  const leanWinsOverMifflin = estimateBmr({ leanBodyMassKg: 60, age: 40, sex: 'male', heightCm: 180, riderWeight: 80 });
  check('leanBodyMassKg takes priority even when Mifflin-St Jeor inputs are also present', closeTo(leanWinsOverMifflin, 1666));
}

console.log('nutrition.js (estimateBmr — Mifflin-St Jeor branch)');
{
  // Men: 10*80 + 6.25*180 - 5*40 + 5 = 800 + 1125 - 200 + 5 = 1730
  const male = estimateBmr({ leanBodyMassKg: null, age: 40, sex: 'male', heightCm: 180, riderWeight: 80 });
  check('male branch matches Mifflin-St Jeor equation', closeTo(male, 1730));

  // Women: 10*60 + 6.25*165 - 5*30 - 161 = 600 + 1031.25 - 150 - 161 = 1320.25
  const female = estimateBmr({ leanBodyMassKg: null, age: 30, sex: 'female', heightCm: 165, riderWeight: 60 });
  check('female branch matches Mifflin-St Jeor equation', closeTo(female, 1320.25));

  const crossCheck = estimateBmr({ leanBodyMassKg: null, age: 35, sex: 'male', heightCm: 175, riderWeight: 75 });
  const crossCheckF = estimateBmr({ leanBodyMassKg: null, age: 35, sex: 'female', heightCm: 175, riderWeight: 75 });
  check('male and female branches diverge for identical inputs', crossCheck !== crossCheckF);
}

console.log('nutrition.js (estimateBmr — null-until-filled-in empty state)');
{
  check('returns null for an empty profile', estimateBmr({}) === null);
  check('returns null when profile itself is null', estimateBmr(null) === null);
  check('returns null when age is missing', estimateBmr({ age: null, sex: 'male', heightCm: 180, riderWeight: 80 }) === null);
  check('returns null when sex is missing', estimateBmr({ age: 40, sex: null, heightCm: 180, riderWeight: 80 }) === null);
  check('returns null for an unrecognized sex value', estimateBmr({ age: 40, sex: 'other', heightCm: 180, riderWeight: 80 }) === null);
  check('returns null when heightCm is missing', estimateBmr({ age: 40, sex: 'male', heightCm: null, riderWeight: 80 }) === null);
  check('returns null when riderWeight is missing', estimateBmr({ age: 40, sex: 'male', heightCm: 180, riderWeight: null }) === null);
}

console.log('nutrition.js (dailyCalorieBalance)');
{
  const now = Date.now();
  const todayMorning = new Date(); todayMorning.setHours(8, 0, 0, 0);
  const yesterday = now - 26 * 60 * 60 * 1000;

  const sessions = [
    { startTime: todayMorning.getTime(), summary: { totalCalories: 450 } },
    { startTime: yesterday, summary: { totalCalories: 900 } }, // filtered out — not today
  ];
  const diaryEntries = [
    { loggedAt: now, nutrients: { calories: 600 } },
    { loggedAt: now, nutrients: { calories: 200 } },
    { loggedAt: yesterday, nutrients: { calories: 1500 } }, // filtered out — not today
  ];

  const withBmr = dailyCalorieBalance({ bmr: 1700, sessions, diaryEntries });
  check('exerciseKcal only sums today\'s sessions', withBmr.exerciseKcal === 450);
  check('loggedKcal only sums today\'s diary entries', withBmr.loggedKcal === 800);
  check('budgetKcal = bmr + exerciseKcal', withBmr.budgetKcal === 2150);
  check('balanceKcal = budgetKcal - loggedKcal', withBmr.balanceKcal === 1350);

  const noBmr = dailyCalorieBalance({ bmr: null, sessions, diaryEntries });
  check('bmr null propagates to budgetKcal', noBmr.budgetKcal === null);
  check('bmr null propagates to balanceKcal', noBmr.balanceKcal === null);
  check('exerciseKcal/loggedKcal stay real numbers even without a bmr (empty-state degrades gracefully)',
    noBmr.exerciseKcal === 450 && noBmr.loggedKcal === 800);

  const empty = dailyCalorieBalance({ bmr: 1700 });
  check('missing sessions/diaryEntries default to empty arrays rather than throwing', empty.exerciseKcal === 0 && empty.loggedKcal === 0);
  check('with no logged food, balanceKcal equals the full budget', empty.balanceKcal === empty.budgetKcal);
}

console.log('nutrition.js (activityMultiplierBudget / ACTIVITY_LEVELS)');
{
  check('ACTIVITY_LEVELS spans sedentary (1.2x) to extra_active (1.9x)',
    ACTIVITY_LEVELS[0].multiplier === 1.2 && ACTIVITY_LEVELS[ACTIVITY_LEVELS.length - 1].multiplier === 1.9);
  check('moderate multiplier applies directly to bmr', activityMultiplierBudget(1700, 1.55) === 1700 * 1.55);
  check('returns null when bmr is missing', activityMultiplierBudget(null, 1.55) === null);
  check('returns null when multiplier is missing', activityMultiplierBudget(1700, null) === null);
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
else console.log('All nutrition.js checks passed.');
