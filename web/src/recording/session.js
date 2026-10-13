// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * recording/session.js
 *
 * Live session controller.
 * - Collects samples from BLE device callbacks into a buffer
 * - Computes rolling metrics (3s power, elapsed time, distance)
 * - Tracks elapsed time and lap markers
 * - Auto-saves to IndexedDB when session ends
 * - Notifies UI subscribers on every new sample
 *
 * Usage:
 *   import { Session } from './recording/session.js';
 *   const session = new Session({ onSample, onEnd });
 *   session.start();
 *   session.pushData({ power: 245, cadence: 89 });  // from BLE callback
 *   session.clearData(['power', 'cadence']);        // that device disconnected
 *   session.markLap();
 *   session.pause();   // freezes elapsed time + stops recording new samples
 *   session.resume();  // picks back up where it left off
 *   await session.stop();  // auto-saves
 *
 *   // Survive an app kill (see recording/session-persistence.js):
 *   const snapshot = session.toSnapshot();       // JSON-safe, paused or not
 *   const restored  = Session.fromSnapshot(snapshot, { onSample, onEnd });
 *   // restored comes back running-but-paused; call restored.resume() when ready.
 */

import { createSample, rolling3sPower, rolling30sPower } from '../core/sample.js';
import { caloriesFromPower } from '../metrics/calories.js';
import { LapTracker } from './laps.js';
import { db } from '../storage/db.js';

const SAMPLE_INTERVAL_MS = 1000; // collect one sample per second

// Upper bound on how many missed seconds a single _tick() will backfill at once
// (see _tick()'s header comment). A hidden page's throttled timer still fires
// at least about once a minute (Chromium's "intensive throttling" caps the
// delay there, it doesn't suspend the timer outright), so a real background
// stretch should only ever need to backfill on that order — this cap is many
// times that, purely to stop a truly pathological gap (a stale snapshot
// restored hours later, an OS-level freeze) from turning one catch-up tick
// into an unbounded, main-thread-blocking burst of sample creation. A gap
// longer than this only backfills its most recent MAX_BACKFILL_SAMPLES
// seconds, same as today's un-backfilled behavior for whatever's earlier
// than that.
const MAX_BACKFILL_SAMPLES = 30 * 60; // 30 minutes

// How recently *any* reading (or sensor-disconnect) must have reached the page,
// measured back from a second being backfilled, for that second to count as
// genuinely measured. Seconds inside this window of a known reading are
// reconstructed from the reading journal and treated as real; seconds further
// out than this have no evidence behind them at all — the page wasn't hearing
// from the sensors — so they're flagged `backfilled` and the chart draws them
// as a held-over gray line. Comfortably above the slowest sensor's notify
// period (Moxy/core temp are ~1 per 1-2 s), well below a real outage.
const BACKFILL_LIVE_WINDOW_MS = 5000;

// Hard cap on the reading journal (see Session#_journal). It's emptied on
// every tick, so in the foreground it holds about a second of readings; a
// hidden page's throttled timer can leave it filling for up to about a minute
// (a few Hz × a few sensors — hundreds of entries). This only exists to bound
// a pathological case (timer dead, readings still arriving); overflow is
// folded into the baseline state instead of dropped, so nothing goes wrong,
// the oldest sub-second detail just stops being replayable.
const MAX_JOURNAL_ENTRIES = 20_000;

/** Applies one journal entry (a set of readings, or a set of cleared fields)
 *  to a plain state object. Shared by the replay in _tick() and overflow
 *  folding in _journalAppend(). */
function applyJournalEntry(state, entry) {
  if (entry.set) Object.assign(state, entry.set);
  if (entry.clear) for (const key of entry.clear) delete state[key];
}

export class Session {
  /**
   * @param {Object}   opts
   * @param {Function} opts.onSample   Called with the latest Sample after each merge
   * @param {Function} [opts.onEnd]    Called with the SessionRecord after save
   * @param {string}   [opts.workoutName]
   * @param {Object}   [opts.meta]     Arbitrary caller metadata carried through
   *                                   into the saved SessionRecord (e.g. tagging
   *                                   a session as a fitness test). Opaque to
   *                                   Session itself — see also setMeta().
   */
  constructor({ onSample, onEnd, workoutName, meta } = {}) {
    this._onSample     = onSample ?? (() => {});
    this._onEnd        = onEnd    ?? (() => {});
    this._workoutName  = workoutName ?? null;
    this._meta         = { ...(meta ?? {}) };

    this.samples       = [];
    this.laps          = new LapTracker();

    this._running      = false;
    this._startTime    = null;
    this._timer        = null;
    this._latestData   = {};   // merged partial data from BLE callbacks

    // Timestamped log of everything pushData()/clearData() did since the last
    // tick committed, oldest first — what lets _tick() rebuild what each
    // *second* of a late catch-up actually looked like, instead of only what
    // the sensors happen to say right now. _latestData above is a
    // last-write-wins accumulator: once a newer reading lands, the older one
    // is gone. When the page is hidden and this class's 1 Hz timer is
    // throttled (see _tick()), that would throw away every reading between
    // two ticks. Entries are { t, set } or { t, clear } — see pushData() /
    // clearData(). _committedState is _latestData as it stood when the last
    // tick committed (the replay's starting point), and _lastEventAt is when
    // the last journaled event before that happened (the "is the page still
    // hearing from the sensors" clock — see BACKFILL_LIVE_WINDOW_MS).
    this._journal        = [];
    this._committedState = {};
    this._lastEventAt    = null;

    this._paused         = false;
    this._pauseStartedAt = null; // timestamp the current pause began, or null when not paused

    // Cumulative distance, derived from speed × elapsed time rather than
    // relying on any device reporting its own distance counter (most FTMS
    // trainers don't expose one, and indoor "distance" is virtual anyway).
    // Stays null until the first speed reading arrives, so machines with no
    // speed source (e.g. weights/HR-only) correctly show no distance at all.
    this._distanceMeters = 0;
    this._hasDistance    = false;
    this._lastTickTime   = null;

    // Cumulative calories burned, mirroring the distance accumulator above:
    // uses a device-reported running total when one is available (e.g. some
    // smart bikes), otherwise estimates from power output via
    // metrics/calories.js. Stays null (via _hasCalories) until the first
    // relevant reading arrives, so power-less sessions (HR-only, etc.)
    // correctly show no calorie data at all.
    this._calories    = 0;
    this._hasCalories = false;
  }

  get isRunning()   { return this._running; }
  get isPaused()    { return this._paused; }
  get workoutName() { return this._workoutName; }
  /** Caller-supplied metadata (e.g. a fitness test's testType — see the
   *  constructor's opts.meta doc and setMeta()), read live rather than only
   *  at snapshot/record time — lets a caller check e.g. "is this session a
   *  Resting HR Test" while it's still running. Returns the live object,
   *  not a copy, matching the `samples`/`latestData` getters above. */
  get meta()        { return this._meta; }

  // While paused, the clock end-point is frozen at the moment pause() was
  // called instead of ticking forward with Date.now() — that's what keeps
  // elapsed time (and, in turn, the recorded duration) from counting up
  // idle/paused time. resume() then shifts _startTime forward by however
  // long the pause lasted, so time picks back up exactly where it left off.
  get elapsedSec() {
    if (!this._startTime) return 0;
    const end = this._paused && this._pauseStartedAt ? this._pauseStartedAt : Date.now();
    return (end - this._startTime) / 1000;
  }

  get sampleCount() { return this.samples.length; }

  /** The rolling partial-data accumulator fed by pushData(), ahead of the
   *  next 1Hz sample snapshot — e.g. so a caller can read "heart rate right
   *  now" (ScriptedSession's Heart Rate zone check) without waiting on the
   *  next committed sample. Returns the live object, not a copy, matching
   *  the `samples` getter above. */
  get latestData() { return this._latestData; }

  /** Start the session clock and begin collecting samples. */
  start() {
    if (this._running) return;
    this._running   = true;
    this._startTime = Date.now();
    this.samples    = [];
    this.laps.reset();
    this._latestData = {};
    this._resetJournal(this._startTime);

    this._paused         = false;
    this._pauseStartedAt = null;

    this._distanceMeters = 0;
    this._hasDistance    = false;
    this._lastTickTime   = this._startTime;

    this._calories    = 0;
    this._hasCalories = false;

    this._timer = setInterval(() => this._tick(), SAMPLE_INTERVAL_MS);
    console.info('[session] Started');
  }

  /**
   * Pause the workout without ending it: stops the recording tick (so no
   * more samples land, and rolling averages aren't dragged down by idle
   * zeros) and freezes elapsed time at its current value. The session stays
   * "running" (isRunning stays true — it hasn't ended, just isn't actively
   * recording) so callers can still resume() or stop()/save from here.
   * No-op if not running or already paused.
   */
  pause() {
    if (!this._running || this._paused) return;
    this._paused         = true;
    this._pauseStartedAt = Date.now();
    clearInterval(this._timer);
    this._timer = null;
    console.info('[session] Paused');
  }

  /**
   * Resume a paused workout. Shifts _startTime forward by the paused
   * duration so elapsed time (and recorded duration) exclude the pause, and
   * resets the distance-integration clock so the gap isn't counted as
   * distance travelled at whatever speed was last reported.
   * No-op if not running or not currently paused.
   */
  resume() {
    if (!this._running || !this._paused) return;
    const pausedMs = Date.now() - this._pauseStartedAt;
    this._startTime      += pausedMs;
    this._lastTickTime    = Date.now();
    // Readings that arrived while paused updated _latestData but were
    // deliberately not journaled (nothing was recording them) — start the
    // replay baseline from what's true right now so the first post-resume
    // tick doesn't replay across the pause.
    this._resetJournal(Date.now());
    this._paused          = false;
    this._pauseStartedAt  = null;
    this._timer = setInterval(() => this._tick(), SAMPLE_INTERVAL_MS);
    console.info('[session] Resumed');
  }

  /**
   * Flushes any whole seconds still owed to the sample buffer, right now,
   * instead of waiting for the next timer fire. Call this the moment the
   * page becomes visible again (app.js's visibilitychange handler does):
   * a hidden page's throttled timer may not fire again for up to a minute,
   * and that lag is otherwise the last stretch the rider would see missing
   * from the chart as they come back. No-op if not recording, or if less
   * than a couple of seconds are owed (the regular timer handles that, and
   * ticking again this soon would just duplicate a second).
   */
  catchUp() {
    if (!this._running || this._paused) return;
    const last = this.samples[this.samples.length - 1];
    if (!last) return;
    if (Math.round(this.elapsedSec) - (last.elapsedTime ?? 0) < 2) return;
    this._tick();
  }

  /**
   * Drops the trailing run of "idle" samples — power, cadence, and speed
   * all reading 0 or null, the same test control/mode-switch.js#_checkActivity
   * uses to decide the rider has stopped — from the end of the buffer.
   *
   * Meant to be called right after pause() for an idleness-triggered
   * auto-pause (see app.js's autoPauseSession()): onIdle() only fires
   * IDLE_TIMEOUT (~3s) after the rider actually stopped, so by the time
   * pause() runs, the last few recorded samples are just the zeros logged
   * while that debounce was ticking down — not real ride data. Left in
   * place they drag down avgPower/avgCadence and distort the rolling-power
   * calculations in _computeSummary()/laps.js, and end up baked into every
   * exported file. This rewinds the buffer to the last sample that showed
   * actual activity, discarding everything after it.
   *
   * Also rewinds the frozen pause instant (_pauseStartedAt) to that last
   * surviving sample's timestamp, so elapsed time / duration accounting
   * excludes the discarded idle window too — the session ends up behaving
   * as though pause() had fired the instant output actually stopped,
   * rather than IDLE_TIMEOUT later.
   *
   * No-op if not currently paused, or if there's no idle tail to trim (a
   * manual pause hit mid-effort, for instance). Never trims below one
   * sample, so a session that was idle from the very first tick still
   * keeps a single sample rather than being emptied out entirely.
   */
  trimTrailingIdle() {
    if (!this._paused) return;

    let cut = this.samples.length;
    while (cut > 1) {
      const s = this.samples[cut - 1];
      const active = (s.power ?? 0) > 0 || (s.cadence ?? 0) > 0 || (s.speed ?? 0) > 0;
      if (active) break;
      cut--;
    }
    if (cut === this.samples.length) return; // nothing idle at the tail

    const removed = this.samples.splice(cut);
    this.laps.clampSampleIndices(this.samples.length);

    const lastKept = this.samples[this.samples.length - 1];
    if (lastKept) this._pauseStartedAt = lastKept.timestamp;

    console.info('[session] Trimmed', removed.length, 'idle sample(s) recorded before auto-pause fired');
  }

  /**
   * Feed partial BLE data into the current sample accumulator.
   * Call this from every device's onData callback. Safe to call while
   * paused — it just won't be snapshotted into a sample until resume().
   * @param {Partial<Sample>} data
   */
  pushData(data) {
    // Merge into the rolling "latest" state — the next tick snapshot it
    Object.assign(this._latestData, data);
    // ...and log it with its arrival time, so a late tick can still tell what
    // each second in between looked like (see _journal in the constructor).
    // Not while paused: nothing is recording then, and a long pause would
    // otherwise just grow the journal for nothing (resume() re-baselines).
    if (this._running && !this._paused) this._journalAppend({ t: Date.now(), set: { ...data } });
  }

  /**
   * Drop one or more fields from the rolling "latest" accumulator — call
   * this the moment the device supplying them disconnects. Without it,
   * pushData()'s merge is permanent: a field set once stays in
   * `_latestData` forever, so every tick after a disconnect would keep
   * silently repeating whatever value arrived last, as if the reading were
   * still live.
   *
   * After this call, the next tick (and every one after, until pushData()
   * supplies the field again) snapshots it as null — createSample()'s own
   * default, meaning "no data" (see core/sample.js) — instead of a stale
   * number. That's what lets a live chart tell "no longer reporting" apart
   * from "still reporting the same value," e.g. drawing a flat gray line
   * at the last known value until the field starts arriving again.
   * @param {string[]} keys
   */
  clearData(keys) {
    for (const key of keys) delete this._latestData[key];
    // Journaled too, so a backfilled stretch shows the field going null at the
    // moment the device actually dropped, not at the end of the catch-up.
    if (this._running && !this._paused) this._journalAppend({ t: Date.now(), clear: [...keys] });
  }

  /**
   * Merge additional fields into this session's metadata after construction
   * — e.g. ScriptedSession recording exactly which stage a fitness test
   * ended on right before the record is built. Safe to call any time before
   * stop(); has no effect on an already-saved record.
   * @param {Object} patch
   */
  setMeta(patch) {
    Object.assign(this._meta, patch);
  }

  /** Mark a lap at the current sample. */
  markLap() {
    const lapNum = this.laps.mark(this.samples.length - 1);
    // Tag the most recent sample with this lap marker
    if (this.samples.length > 0) {
      this.samples[this.samples.length - 1].lap = lapNum;
    }
    return lapNum;
  }

  /**
   * Stop the session, compute summary, save to IndexedDB, and notify.
   * Returns the saved SessionRecord.
   */
  async stop() {
    if (!this._running) return null;

    clearInterval(this._timer);
    this._timer = null;

    // Final tick to catch any data that arrived in the last interval — but
    // skip it if we're stopping mid-pause, since no new sample should land
    // after recording was already frozen.
    if (!this._paused) this._tick();

    // Read elapsed time before clearing _paused/_running — the getter above
    // needs _paused still set to correctly exclude a pause that was still
    // active right up to this stop() call.
    const durationSec = Math.round(this.elapsedSec);

    this._running        = false;
    this._paused          = false;
    this._pauseStartedAt = null;

    const endTime = Date.now();
    const record  = this._buildRecord(endTime, durationSec);

    try {
      const id = await db.saveSession(record);
      record.id = id;
      console.info('[session] Saved session id:', id);
    } catch (err) {
      console.error('[session] Failed to save session:', err);
    }

    this._onEnd(record);
    return record;
  }

  /**
   * Serializes this session to a plain JSON-safe object so it can survive
   * an app kill and later be handed to fromSnapshot() — see
   * recording/session-persistence.js. Captures elapsed time as of right
   * now (or as of when pause() was called, if already paused — the
   * elapsedSec getter above already accounts for that); the persistence
   * service always pauses before calling this so the frozen instant is
   * predictable.
   * @returns {Object}
   */
  toSnapshot() {
    return {
      type:           'free',
      workoutName:    this._workoutName,
      meta:           { ...this._meta },
      samples:        [...this.samples],
      laps:           this.laps.marks,
      elapsedSec:     this.elapsedSec,
      distanceMeters: this._distanceMeters,
      hasDistance:    this._hasDistance,
      calories:       this._calories,
      hasCalories:    this._hasCalories,
    };
  }

  /**
   * Rebuilds a Session from a snapshot produced by toSnapshot(), picking up
   * exactly where it left off — same samples/laps/distance, and the clock
   * frozen at the snapshotted elapsed time. The restored session comes
   * back *running but paused* (isRunning true, isPaused true), same
   * resting state as calling pause() mid-ride: call resume() once the
   * rider is ready to continue, which shifts the clock forward from "now"
   * exactly like resuming from any other pause, so the time spent away
   * from the app is excluded the same way idle pause time always is.
   * @param {Object}   snapshot
   * @param {Object}   [opts]
   * @param {Function} [opts.onSample]
   * @param {Function} [opts.onEnd]
   * @returns {Session}
   */
  static fromSnapshot(snapshot, { onSample, onEnd } = {}) {
    const session = new Session({
      onSample,
      onEnd,
      workoutName: snapshot.workoutName,
      meta:        snapshot.meta,
    });

    session.samples         = snapshot.samples ?? [];
    session.laps.restore(snapshot.laps);
    session._distanceMeters = snapshot.distanceMeters ?? 0;
    session._hasDistance    = snapshot.hasDistance ?? false;
    session._calories       = snapshot.calories ?? 0;
    session._hasCalories    = snapshot.hasCalories ?? false;

    session._running        = true;
    session._paused         = true;
    session._pauseStartedAt = Date.now();
    session._startTime      = Date.now() - Math.round((snapshot.elapsedSec ?? 0) * 1000);

    return session;
  }

  /** Discard the session without saving. */
  discard() {
    clearInterval(this._timer);
    this._timer           = null;
    this._running         = false;
    this._paused          = false;
    this._pauseStartedAt = null;
    this.samples  = [];
    this._resetJournal(null);
    console.info('[session] Discarded');
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Fires on SAMPLE_INTERVAL_MS via setInterval() — but that's a target, not
   * a guarantee. Browsers/WebViews throttle a hidden page's JS timers (this
   * app leans on that being true elsewhere — see
   * platform/background-session.js's header comment on why the tray
   * notification's own elapsed clock had to move to a SystemUI chronometer
   * instead of a JS timer), so while the rider has switched apps or locked
   * the phone, this can fire far less often than once a second even though
   * the Android foreground service is keeping BLE connections (and this
   * WebView) alive the whole time. onTrainerData()/onAuxData() keep pushing
   * fresh readings into pushData() as they arrive regardless — those are
   * native push events, not JS-timer-driven, so they aren't throttled.
   *
   * What *would* be lost is the readings themselves: _latestData is
   * last-write-wins, so by the time a late tick fires only the newest reading
   * survives in it, and everything that arrived in between — the actual
   * shape of the ride — would be gone. That's why pushData()/clearData() also
   * append to a timestamped journal (see the constructor). This method:
   *
   *   1. Works out how many whole seconds are owed, by the wall clock (not by
   *      how many times the timer fired), so elapsed time stays continuous.
   *   2. Replays the journal, in order, on top of the state as of the last
   *      tick: for each owed second, the readings that had arrived by that
   *      second's own timestamp are applied, and the sample is built from the
   *      result. Same "hold the latest reading" rule a correctly-timed tick
   *      would have used, so a backfilled second carries exactly what a
   *      1 Hz tick at that instant would have recorded. Distance and
   *      calories integrate over those same per-second readings, so they're
   *      right too, not just the chart.
   *   3. Flags a second `backfilled` ONLY if nothing at all reached the page
   *      within BACKFILL_LIVE_WINDOW_MS before it — i.e. the WebView really
   *      wasn't being told anything (frozen, Doze, a dead link) and holding
   *      the last known reading is a guess rather than a measurement. See
   *      Sample.backfilled in core/sample.js; chart-engine.js draws those the
   *      muted way it already does for a disconnected sensor.
   *
   * The final step (stepsFromNow === 0) always takes _latestData directly and
   * is never flagged: it's "as of now" by definition, and in the normal case
   * (tick fires ~every SAMPLE_INTERVAL_MS) it's the only step — identical to
   * the pre-journal behavior.
   */
  _tick() {
    const now = Date.now();
    const deltaSec = this._lastTickTime != null ? (now - this._lastTickTime) / 1000 : 0;
    this._lastTickTime = now;

    const currentElapsed = Math.round(this.elapsedSec);
    const lastElapsed = this.samples.length
      ? this.samples[this.samples.length - 1].elapsedTime ?? currentElapsed - 1
      : currentElapsed - 1;
    const stepsToFill = Math.min(MAX_BACKFILL_SAMPLES, Math.max(1, currentElapsed - lastElapsed));
    // Split evenly across however many seconds we're backfilling — there's
    // no finer-grained timing than "this much wall-clock time passed" to
    // divide it by.
    const stepDeltaSec = deltaSec / stepsToFill;

    // Replay state: what the sensors had reported as of each second below,
    // rebuilt by folding journal entries onto the last-committed baseline.
    const journal         = this._journal;
    const state           = { ...this._committedState };
    let   nextEntry       = 0;               // index of the first journal entry not yet folded into `state`
    let   lastEventAt     = this._lastEventAt;
    let   unmeasuredSteps = 0;

    for (let i = 0; i < stepsToFill; i++) {
      const stepsFromNow = stepsToFill - 1 - i; // 0 for the most recent (last) step
      const elapsed      = currentElapsed - stepsFromNow;
      const stepTime     = now - Math.round(stepsFromNow * stepDeltaSec * 1000);

      // Fold in every reading that had arrived by this second's own timestamp.
      while (nextEntry < journal.length && journal[nextEntry].t <= stepTime) {
        applyJournalEntry(state, journal[nextEntry]);
        lastEventAt = journal[nextEntry].t;
        nextEntry++;
      }

      // "Now" reads the live accumulator directly (never trusts the replay
      // for the one sample that must be exactly current); earlier steps read
      // the replayed state. Measured = "now", or something reached the page
      // recently enough before this second that holding it is evidence-based.
      const isNow    = stepsFromNow === 0;
      const readings = isNow ? this._latestData : state;
      const measured = isNow || (lastEventAt != null && stepTime - lastEventAt <= BACKFILL_LIVE_WINDOW_MS);
      if (!measured) unmeasuredSteps++;

      // Integrate speed (km/h) over this step's slice of the real elapsed
      // wall-clock time to build a running cumulative distance — this is
      // what powers the Distance stat on the History cards. Using actual
      // elapsed time (rather than assuming exactly SAMPLE_INTERVAL_MS) keeps
      // it accurate even when a tick fires late or is backfilling a gap.
      if (readings.speed != null) {
        this._hasDistance = true;
        this._distanceMeters += readings.speed * (1000 / 3600) * stepDeltaSec;
      }

      // Calories: a device-reported running total (e.g. MerachDevice) wins
      // when present, since it's calibrated to that specific bike. It's
      // already a cumulative reading as of that second, not a per-tick
      // delta, so it's taken as-is rather than apportioned. Otherwise fall
      // back to estimating from power output over this step's slice of the
      // real wall-clock gap, same as the distance integration above.
      if (readings.calories != null) {
        this._hasCalories = true;
        this._calories    = readings.calories;
      } else if (readings.power != null) {
        this._hasCalories = true;
        this._calories += caloriesFromPower(readings.power, stepDeltaSec);
      }

      const sample = createSample({
        ...readings,
        timestamp: stepTime,
        elapsedTime: elapsed,
        distance: this._hasDistance ? Math.round(this._distanceMeters) : null,
        calories: this._hasCalories ? Math.round(this._calories) : null,
        backfilled: !measured,
      });

      // Compute rolling power average
      sample.power3s = rolling3sPower([...this.samples, sample]);

      this.samples.push(sample);
      this._onSample(sample, this.samples);
    }

    if (stepsToFill > 1) {
      console.info(
        `[session] Caught up ${stepsToFill}s from ${journal.length} journaled event(s);`,
        `${unmeasuredSteps}s had no readings reaching the page`,
      );
    }

    // Everything journaled so far is now committed into `samples`.
    this._committedState = { ...this._latestData };
    this._lastEventAt    = lastEventAt;
    journal.length       = 0;
  }

  /** Appends to the reading journal, folding the oldest entry into the
   *  baseline instead of dropping it if the (pathological) cap is reached —
   *  see MAX_JOURNAL_ENTRIES. */
  _journalAppend(entry) {
    if (this._journal.length >= MAX_JOURNAL_ENTRIES) {
      const oldest = this._journal.shift();
      applyJournalEntry(this._committedState, oldest);
      this._lastEventAt = oldest.t;
    }
    this._journal.push(entry);
  }

  /** Re-baselines the journal to "what's true right now" — see start() and
   *  resume(). `at` is the wall-clock instant to treat as the last time the
   *  page heard from the sensors (or null for none, e.g. after discard()). */
  _resetJournal(at) {
    this._journal        = [];
    this._committedState = { ...this._latestData };
    this._lastEventAt    = at;
  }

  _buildRecord(endTime, durationSec) {
    const summary = this._computeSummary();
    return {
      startTime:    this._startTime,
      endTime,
      duration:     durationSec,
      samples:      this.samples,
      laps:         this.laps.marks,
      workoutName:  this._workoutName,
      meta:         this._meta,
      summary,
    };
  }

  _computeSummary() {
    const powers   = this.samples.map(s => s.power).filter(v => v !== null);
    const hrs      = this.samples.map(s => s.heartRate).filter(v => v !== null);
    const cadences = this.samples.map(s => s.cadence).filter(v => v !== null);

    const lastSample    = this.samples[this.samples.length - 1];
    const totalDist     = lastSample?.distance ?? null;
    const totalCalories = lastSample?.calories ?? null;

    // Normalized Power (NP): 4th root of mean of (30s rolling power)^4
    let normalizedPower = null;
    if (powers.length >= 30) {
      const rolling30s = [];
      for (let i = 0; i < this.samples.length; i++) {
        const slice = this.samples.slice(Math.max(0, i - 29), i + 1);
        const pw    = slice.map(s => s.power).filter(v => v !== null);
        if (pw.length > 0) {
          rolling30s.push(pw.reduce((a, b) => a + b, 0) / pw.length);
        }
      }
      if (rolling30s.length > 0) {
        const fourthPowerMean = rolling30s.reduce((a, v) => a + Math.pow(v, 4), 0) / rolling30s.length;
        normalizedPower = Math.round(Math.pow(fourthPowerMean, 0.25));
      }
    }

    return {
      avgPower:        powers.length   ? Math.round(powers.reduce((a, b) => a + b) / powers.length)   : null,
      avgHr:           hrs.length      ? Math.round(hrs.reduce((a, b) => a + b) / hrs.length)          : null,
      avgCadence:      cadences.length ? Math.round(cadences.reduce((a, b) => a + b) / cadences.length): null,
      totalDistance:   totalDist,
      totalCalories,
      normalizedPower,
    };
  }
}

export default Session;
