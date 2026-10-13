// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// playback/ smoke test — manual trace of the record.meta plumbing that
// metrics/vo2max.js's PPO calc depends on: ScriptedSession.stop() computes
// stepIndexAtStop/stepElapsedAtStop/stepCount and folds them into the
// underlying Session's meta (via setMeta()), which Session._buildRecord()
// then writes onto the saved SessionRecord as record.meta — see
// app.js's onSessionComplete()/_handleVo2MaxTestComplete(), which read
// record.meta.testType/rampConfig/stepIndexAtStop/stepElapsedAtStop back
// out after a real session ends.
//
// No real BLE/trainer needed — modeSwitch is omitted (ScriptedSession only
// calls into it when present) — and stage progress is poked directly onto
// the instance's fields rather than waiting on real 60s-per-stage timers,
// the same way ble/__smoketest__.js drives MerachDevice by calling
// _handlePacket() directly instead of waiting on real Bluetooth.
//
// Note: recording/session.js's stop() always tries db.saveSession() first,
// which needs a browser IndexedDB. There isn't one in plain Node, so each
// stop() below logs one expected "[session] Failed to save session:
// ReferenceError: indexedDB is not defined" to stderr — Session.stop()
// catches that internally and still builds/returns the record, which is
// exactly the record.meta shape this file is checking.
//
// Run with: node src/playback/__smoketest__.js

import { ScriptedSession } from './scripted-session.js';
import { Session } from '../recording/session.js';
import { buildRampTestWorkout, TEST_TYPE as VO2MAX_TEST_TYPE } from '../metrics/vo2max.js';
import { createWorkout, createStep, STEP_TYPES, TARGET_TYPES } from '../core/cardio-model.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

/** Builds a fresh VO2max ramp ScriptedSession, started and ready to have
 *  stage progress poked onto it before stop(). 5 stages keeps the "full
 *  completion" case below easy to reason about. */
async function startFakeVo2MaxSession() {
  const workout = buildRampTestWorkout({ ftp: 250, maxStages: 5 });
  const meta = { testType: workout.testType, rampConfig: workout.rampConfig };
  const session = new ScriptedSession({ workout, modeSwitch: null, ftp: 250, meta });
  await session.start();
  return { session, workout };
}

console.log('record.meta plumbing (ScriptedSession -> Session -> saved record) — VO2max ramp test');
{
  // ── Case 1: stopped mid-test, partway into a stage ──────────────────────
  // 2 full stages completed (index 0, 1), 33s into stage index 2.
  const { session, workout } = await startFakeVo2MaxSession();
  session._stepIdx     = 2;
  session._stepElapsed = 33;
  const record = await session.stop();

  check('record has the expected top-level SessionRecord shape',
    typeof record.startTime === 'number' && typeof record.endTime === 'number' &&
    typeof record.duration  === 'number' && Array.isArray(record.samples) &&
    Array.isArray(record.laps) && typeof record.summary === 'object' && record.summary !== null);
  check('record.workoutName carries the workout name through', record.workoutName === workout.name);
  check('record.meta exists and is an object', typeof record.meta === 'object' && record.meta !== null);
  check('record.meta.testType survived from the meta passed at construction', record.meta.testType === VO2MAX_TEST_TYPE);
  check('record.meta.rampConfig survived from the meta passed at construction', record.meta.rampConfig === workout.rampConfig);
  check('record.meta.stepIndexAtStop reflects stages fully completed', record.meta.stepIndexAtStop === 2);
  check('record.meta.stepElapsedAtStop reflects seconds into the stopped stage', record.meta.stepElapsedAtStop === 33);
  check('record.meta.stepCount reflects the flattened step count', record.meta.stepCount === 5);

  // This is the exact read app.js's _handleVo2MaxTestComplete() does off a
  // real saved record — confirms the values it needs actually round-trip.
  check('record.meta.testType gates onSessionComplete() into the VO2max path',
    record.meta?.testType === VO2MAX_TEST_TYPE);
}

{
  // ── Case 2: stopped during the very first stage (stepIdx 0) ─────────────
  // Distinct from "no progress at all" — confirms index 0 isn't mistaken
  // for "unset" anywhere in the plumbing (0 is falsy, a classic footgun).
  const { session } = await startFakeVo2MaxSession();
  session._stepIdx     = 0;
  session._stepElapsed = 12;
  const record = await session.stop();

  check('stop during stage 0: stepIndexAtStop is 0, not skipped/defaulted', record.meta.stepIndexAtStop === 0);
  check('stop during stage 0: stepElapsedAtStop still carries through', record.meta.stepElapsedAtStop === 12);
}

{
  // ── Case 3: workout ran to full completion ───────────────────────────────
  // Mirrors _advanceStep()'s "ran off the end" path: stepIdx has advanced to
  // (one past) the last valid index. scripted-session.js documents this as
  // "every step completed, 0s into the step after" — clamped rather than
  // left out of range — so stepElapsedAtStop must come back 0 even though
  // we set it to something nonzero here.
  const { session } = await startFakeVo2MaxSession();
  session._stepIdx     = 5; // === steps.length for this 5-stage workout
  session._stepElapsed = 999;
  const record = await session.stop();

  check('full completion: stepIndexAtStop clamps to steps.length', record.meta.stepIndexAtStop === 5);
  check('full completion: stepElapsedAtStop is zeroed, not left at 999', record.meta.stepElapsedAtStop === 0);
  check('full completion: stepCount still reported', record.meta.stepCount === 5);
}

console.log('record.meta plumbing — non-fitness-test scripted workout (no meta passed)');
{
  // A normal structured workout (not a VO2max ramp test) doesn't pass a
  // `meta` object at all — this is the app.js startSession() branch where
  // `loadedWorkout.testType !== VO2MAX_TEST_TYPE`. Confirms stage-progress
  // tracking doesn't accidentally tag an unrelated session as a fitness
  // test, and that onSessionComplete()'s `record.meta?.testType === ...`
  // check safely falls through to the normal (non-VO2max) save path.
  const workout = createWorkout({
    name: 'Sweet Spot 2x20',
    steps: [
      createStep({ type: STEP_TYPES.STEADY, duration: 60, targetType: TARGET_TYPES.POWER, targetLow: 0.9 }),
      createStep({ type: STEP_TYPES.STEADY, duration: 60, targetType: TARGET_TYPES.POWER, targetLow: 0.5 }),
    ],
  });
  const session = new ScriptedSession({ workout, modeSwitch: null, ftp: 250 }); // no `meta` passed
  await session.start();
  session._stepIdx     = 1;
  session._stepElapsed = 45;
  const record = await session.stop();

  check('non-fitness-test record.meta has no testType', record.meta.testType === undefined);
  check('non-fitness-test record.meta has no rampConfig', record.meta.rampConfig === undefined);
  check('non-fitness-test record.meta still gets stage-progress fields',
    record.meta.stepIndexAtStop === 1 && record.meta.stepElapsedAtStop === 45 && record.meta.stepCount === 2);
  check('non-fitness-test record.meta.testType does not gate into the VO2max path',
    record.meta?.testType !== VO2MAX_TEST_TYPE);
}

console.log('record.meta plumbing — bare Session (free ride, no ScriptedSession/meta at all)');
{
  // app.js's free-ride branch constructs Session directly with no `meta`
  // key in its opts at all — confirms that still produces a defined (if
  // empty) meta object rather than undefined, so `record.meta?.testType`
  // downstream never throws.
  const session = new Session({});
  session.start();
  const record = await session.stop();

  check('bare Session with no meta option still yields record.meta as an object', typeof record.meta === 'object' && record.meta !== null);
  check('bare Session with no meta option yields an empty meta object', Object.keys(record.meta).length === 0);
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
else console.log('All record.meta plumbing checks passed.');
