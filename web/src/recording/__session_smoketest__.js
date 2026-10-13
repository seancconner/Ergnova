// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// recording/session.js smoke test — exercises Session's tick/backfill logic
// with a faked clock. No real timers, no IndexedDB (stop()/db.saveSession is
// never exercised here, so db.js's lazy indexedDB.open() is never reached).
// Run with: node src/recording/__session_smoketest__.js

import { Session } from './session.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

console.log('recording/session.js');

// ── Fake clock ──────────────────────────────────────────────────────────────
const realNow = Date.now;
let fakeNow = 1_700_000_000_000; // arbitrary fixed epoch
Date.now = () => fakeNow;
function advance(ms) { fakeNow += ms; }

function freshSession() {
  const session = new Session({ workoutName: 'Test Ride' });
  session.start();
  // start() kicks off a real setInterval on the real wall clock, not the
  // faked one above. Irrelevant to what's under test here (every case below
  // drives _tick() directly — exactly what that interval would have called),
  // but left running it would eventually fire for real mid-test and
  // double-count a tick, so stop it immediately.
  clearInterval(session._timer);
  session._timer = null;
  return session;
}

// ── Normal case: unaffected ──────────────────────────────────────────────────
{
  const session = freshSession();
  session.pushData({ power: 200, cadence: 80 });
  advance(1000);
  session._tick();
  advance(1000);
  session.pushData({ power: 210 });
  session._tick();

  check('normal ticks: one sample per tick', session.samples.length === 2);
  check('normal ticks: elapsedTime increments by 1', session.samples[1].elapsedTime - session.samples[0].elapsedTime === 1);
  check('normal ticks: latest reading is recorded', session.samples[1].power === 210);
}

// ── Backgrounded gap, sensors streaming: replayed from the journal ────────────
// The case that matters in practice: the page is hidden so this class's 1 Hz
// timer is throttled, but the native foreground service keeps delivering BLE
// notifications to pushData() the whole time. Every second of the catch-up
// should carry what was really reported at that second — not the final
// reading smeared backwards, and not flagged as a guess.
{
  const session = freshSession();
  session.pushData({ power: 200, heartRate: 120, speed: 30 });
  advance(1000);
  session._tick(); // elapsedTime 1, normal

  for (let i = 1; i <= 30; i++) {
    advance(1000);
    session.pushData({ power: 200 + 3 * i, heartRate: 120 + i, speed: 36 });
  }
  session._tick(); // the throttled timer finally fires, 30s late

  const gap = session.samples.slice(1);
  check('streaming gap: one sample per missed second', gap.length === 30);
  check(
    'streaming gap: every second carries the reading that was current at that second',
    gap.every((s, i) => s.power === 200 + 3 * (i + 1) && s.heartRate === 120 + (i + 1)),
  );
  check('streaming gap: nothing is flagged backfilled', gap.every(s => s.backfilled === false));
  check(
    'streaming gap: 3s rolling power follows the ramp instead of being flat',
    gap.every((s, i) => i === 0 || s.power3s >= gap[i - 1].power3s) && gap[29].power3s > gap[0].power3s,
  );
  // 30 s at a steady 36 km/h (10 m/s) is 300 m, on top of the ~8 m before the gap.
  check(
    'streaming gap: distance integrates the real per-second speed',
    Math.abs(session.samples[session.samples.length - 1].distance - 308) <= 1,
  );
}

// ── Backgrounded gap, a sensor drops mid-gap: null lands at the right second ───
{
  const session = freshSession();
  session.pushData({ power: 200, heartRate: 120 });
  advance(1000);
  session._tick();

  for (let i = 1; i <= 30; i++) {
    advance(1000);
    if (i < 20) session.pushData({ power: 200 + i, heartRate: 120 + i });
    else {
      if (i === 20) session.clearData(['heartRate']); // HR strap disconnects
      session.pushData({ power: 200 + i });
    }
  }
  session._tick();

  const gap = session.samples.slice(1);
  check('sensor drop mid-gap: HR is real right up until the drop', gap[18].heartRate === 139);
  check('sensor drop mid-gap: HR goes null at the second the strap dropped, not at catch-up time', gap[19].heartRate === null);
  check('sensor drop mid-gap: HR stays null afterwards', gap.slice(19).every(s => s.heartRate === null));
  check('sensor drop mid-gap: power (still connected) is unaffected', gap.every((s, i) => s.power === 200 + (i + 1)));
}

// ── Backgrounded gap, nothing reaches the page: held over and flagged ──────────
// No pushData() at all for 45 s (WebView frozen / link dead). There's no
// evidence about what the sensors did, so seconds beyond the live window are a
// guess: hold the last *known* reading (not the post-gap one) and flag them so
// the chart draws them as a held-over gray line.
{
  const session = freshSession();
  session.pushData({ power: 200, cadence: 80, speed: 30 });
  advance(1000);
  session._tick(); // elapsedTime 1, normal

  advance(45_000);
  session.pushData({ power: 220, cadence: 85, speed: 32 });
  session._tick();

  check('silent gap: backfills one sample per missed second', session.samples.length === 46);
  check(
    'silent gap: elapsedTime stays contiguous, no jump',
    session.samples.every((s, i) => i === 0 || s.elapsedTime - session.samples[i - 1].elapsedTime === 1),
  );
  check(
    'silent gap: held seconds carry the last reading known before the gap, not the post-gap one',
    session.samples.slice(1, -1).every(s => s.power === 200 && s.cadence === 80),
  );
  check(
    'silent gap: the final catch-up sample carries the current reading',
    session.samples[session.samples.length - 1].power === 220,
  );
  check(
    'silent gap: distance accumulates smoothly across the gap, not in one lump',
    session.samples.every((s, i) => i === 0 || s.distance >= session.samples[i - 1].distance)
      && session.samples[0].distance > 0
      && session.samples[session.samples.length - 1].distance > session.samples[0].distance,
  );
  check(
    'silent gap: timestamps are spread across the gap, not all identical',
    new Set(session.samples.map(s => s.timestamp)).size === session.samples.length,
  );
  const held = session.samples.slice(1, -1);
  check(
    'silent gap: seconds within the live window of the last reading are still trusted (unflagged)',
    held.slice(0, 4).every(s => s.backfilled === false),
  );
  check(
    'silent gap: seconds beyond the live window are flagged backfilled',
    held.slice(5).every(s => s.backfilled === true),
  );
  check(
    'silent gap: the pre-gap sample and the final catch-up sample are never flagged',
    session.samples[0].backfilled === false && session.samples[session.samples.length - 1].backfilled === false,
  );
}

// ── catchUp(): flushes what's owed on foregrounding, never duplicates ─────────
{
  const session = freshSession();
  session.pushData({ power: 100 });
  advance(1000);
  session._tick();

  session.catchUp();
  check('catchUp: no-op when the buffer is already up to date', session.samples.length === 1);

  advance(500);
  session.catchUp();
  check('catchUp: no-op when under a couple of seconds are owed (regular timer handles that)', session.samples.length === 1);

  advance(9500); // 10 whole seconds now owed
  session.catchUp();
  check(
    'catchUp: fills every owed second on the spot',
    session.samples.length === 11 && session.samples[10].elapsedTime === 11,
  );

  session.catchUp();
  check('catchUp: calling it again right away adds nothing', session.samples.length === 11);

  session.pause();
  advance(10_000);
  session.catchUp();
  check('catchUp: no-op while paused', session.samples.length === 11);
}

// ── Journal is bounded ────────────────────────────────────────────────────────
{
  const session = freshSession();
  session.pushData({ power: 1 });
  advance(1000);
  session._tick();

  for (let i = 1; i <= 25_000; i++) session.pushData({ power: i }); // timer "dead", readings still arriving
  check('journal cap: never grows past its bound', session._journal.length <= 20_000);

  advance(5000);
  session._tick();
  check(
    'journal cap: overflow is folded into the baseline, not lost — final sample is still exact',
    session.samples[session.samples.length - 1].power === 25_000,
  );
  check('journal cap: emptied again after the tick', session._journal.length === 0);
}

// ── Pathological gap: capped, doesn't hang ───────────────────────────────────
{
  const session = freshSession();
  session.pushData({ power: 150 });
  advance(1000);
  session._tick();

  advance(2 * 60 * 60 * 1000); // 2 hours — well beyond MAX_BACKFILL_SAMPLES (30 min)
  session._tick();

  check('pathological gap: backfill is capped, not one sample per second for 2h', session.samples.length <= 1 + 30 * 60);
  check(
    'pathological gap: still lands exactly on the current elapsed time',
    session.samples[session.samples.length - 1].elapsedTime === Math.round(session.elapsedSec),
  );
}

// ── Resume after a normal pause: unaffected ──────────────────────────────────
{
  const session = freshSession();
  session.pushData({ power: 100 });
  advance(1000);
  session._tick();

  session.pause();
  advance(20_000); // time away while paused shouldn't count as a gap to backfill
  session.resume();
  // resume() starts its own new real setInterval, same as start() did above —
  // stop that one too so the process can exit once the checks below are done.
  clearInterval(session._timer);
  session._timer = null;

  advance(1000);
  session._tick();

  check('pause/resume: no backfill for time spent paused', session.samples.length === 2);
  check('pause/resume: elapsedTime still contiguous across the pause', session.samples[1].elapsedTime - session.samples[0].elapsedTime === 1);
}

// ── Readings that arrive while paused aren't journaled or replayed ────────────
{
  const session = freshSession();
  session.pushData({ power: 100 });
  advance(1000);
  session._tick();

  session.pause();
  advance(20_000);
  session.pushData({ power: 999 }); // still updates the live accumulator...
  check('paused: readings are not journaled', session._journal.length === 0);
  session.resume();
  clearInterval(session._timer);
  session._timer = null;

  advance(1000);
  session._tick();
  check(
    'paused: first post-resume sample is current, with nothing replayed from the pause',
    session.samples.length === 2 && session.samples[1].power === 999 && session.samples[1].backfilled === false,
  );
}

Date.now = realNow;

if (failures) {
  console.log(`\n${failures} recording/session check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll recording/session checks passed.');
