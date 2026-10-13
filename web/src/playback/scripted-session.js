// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * playback/scripted-session.js
 *
 * Scripted workout playback engine.
 * Extends the Session recording layer with automatic step advancement:
 * loads a WorkoutModel, ticks through its steps on a timer, and calls the
 * active ModeSwitch with the correct target for each step.
 *
 * Emits step-change events so the UI can show "current step" context.
 * Supports pause/resume: freezes both step advancement and the underlying
 * recording session (elapsed time, sample collection) — delegates the
 * latter to Session#pause()/resume() so a paused scripted workout behaves
 * the same as a paused free ride.
 *
 * Usage:
 *   import { ScriptedSession } from './playback/scripted-session.js';
 *
 *   const scripted = new ScriptedSession({
 *     workout:    workoutModel,
 *     modeSwitch, // ModeSwitch instance
 *     ftp:        280,
 *     onSample:   (sample, buffer) => chart.push(sample),
 *     onStep:     (stepInfo) => updateStepUI(stepInfo),
 *     onComplete: ()         => flagWorkoutComplete(), // fires once, only when every
 *                                                       // step finishes on its own —
 *                                                       // see _advanceStep() below.
 *                                                       // Not called for a manual stop.
 *     onEnd:      (record)   => handleSave(record),
 *   });
 *
 *   await scripted.start();
 *   scripted.pause();
 *   scripted.resume();
 *   await scripted.stop();   // ends + saves
 *
 *   // Survive an app kill (see recording/session-persistence.js):
 *   const snapshot = scripted.toSnapshot();
 *   const restored  = ScriptedSession.fromSnapshot(snapshot, { modeSwitch, ftp, onSample, onStep, onEnd });
 *   // restored comes back running-but-paused; call restored.resume() when ready.
 *   // If modeSwitch wasn't available yet (controller not reconnected), call
 *   // restored.setModeSwitch(modeSwitch) once it is.
 */

import { Session }                  from '../recording/session.js';
import { flattenWorkout, resolveWatts, resolveRampTarget, heartRateZone, STEP_TYPES, TARGET_TYPES } from '../core/cardio-model.js';
import { MODES }                    from '../control/mode-switch.js';
import { audioCues }                from '../ux/audio-cues.js';

// Minimum gap between repeated audio nudges for the *same* out-of-range
// direction during a Heart Rate step — long enough not to nag every single
// second while genuinely out of the zone, short enough to still be a useful
// reminder. A fresh excursion (or the direction flipping from high to low
// or back) always nudges immediately regardless of this cooldown — see
// _checkHeartRateZone() below.
const HR_NUDGE_COOLDOWN_MS = 20000;

export class ScriptedSession {
  /**
   * @param {Object}       opts
   * @param {WorkoutModel} opts.workout
   * @param {ModeSwitch}   opts.modeSwitch
   * @param {number}       [opts.ftp=200]
   * @param {Function}     [opts.onSample]   (sample, buffer) => void
   * @param {Function}     [opts.onStep]     (stepInfo) => void
   * @param {Function}     [opts.onComplete] () => void  Fires once, the
   *   instant the last step's duration expires and _advanceStep() finds no
   *   step left to move to — i.e. the workout ran to completion on its own.
   *   Fires before the stop()/onEnd() that follows, and NOT for a manual
   *   Stop or an auto-ended self-paced fitness test (see stopSession()/
   *   _isSelfPacedTestInEffortSegment()), which both go straight to onEnd()
   *   without ever passing through here.
   * @param {Function}     [opts.onEnd]      (sessionRecord) => void
   * @param {Function}     [opts.onCountdown](secondsLeft: number) => void
   * @param {Object}       [opts.meta]  Forwarded to the underlying Session —
   *                                    see Session's meta/setMeta(). Stage
   *                                    progress at stop time (stepIndexAtStop/
   *                                    stepElapsedAtStop/stepCount) is added
   *                                    automatically on top of whatever's
   *                                    passed here, so any fitness-test
   *                                    session gets it for free.
   */
  constructor({
    workout,
    modeSwitch,
    ftp       = 200,
    onSample,
    onStep,
    onComplete,
    onEnd,
    onCountdown,
    workoutName,
    meta,
  }) {
    this._workout     = workout;
    this._modeSwitch  = modeSwitch;
    this._ftp         = ftp;
    this._onStep      = onStep     ?? (() => {});
    this._onComplete  = onComplete ?? (() => {});
    this._onCountdown = onCountdown ?? (() => {});

    // Flatten all steps (expand intervals into individual on/off reps)
    this._steps       = flattenWorkout(workout);
    this._stepIdx     = -1;
    this._stepElapsed = 0; // seconds spent in the current step

    // Total planned duration across every flattened step, cached once up
    // front — feeds the overall-workout progress bar/remaining-time in
    // currentStepInfo below. Cardio Session always gives its step(s) a
    // concrete duration (see buildQuickStartWorkout()), so this is a
    // real number for every workout the playback engine sees, not just
    // multi-step ones.
    this._totalDuration = this._steps.reduce((acc, s) => acc + (s.duration ?? 0), 0);
    this._paused      = false;
    this._ticker      = null;

    // Heart Rate step nudging (see _checkHeartRateZone()) — which side of
    // the zone the rider is currently outside of ('high'/'low'/null for
    // in-range-or-unknown), and when the last nudge for that direction
    // fired, so repeated nudges honor HR_NUDGE_COOLDOWN_MS instead of
    // firing every tick.
    this._hrOutOfRangeDir = null;
    this._hrLastNudgeAt   = 0;

    // Underlying recording session
    this._session = new Session({
      workoutName: workoutName ?? workout.name,
      onSample,
      onEnd,
      meta,
    });
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start the scripted workout. */
  async start() {
    this._session.start();
    this._stepIdx     = -1;
    this._stepElapsed = 0;
    this._paused      = false;

    // Advance immediately to the first step
    await this._advanceStep();

    this._startTicker();
  }

  /**
   * (Re)arms the 1s ticker that drives step progression. Shared by start()
   * and fromSnapshot() — restoring lands the session paused, and _tick()
   * below no-ops while _paused, so it's safe to have the ticker running
   * immediately rather than waiting for resume() to start it.
   */
  _startTicker() {
    clearInterval(this._ticker);
    this._ticker = setInterval(() => this._tick(), 1000);
  }

  /**
   * Re-attaches this session to a (re)connected controller — e.g. after the
   * rider's trainer drops and reconnects mid-ride, or after restoring a
   * paused workout from a snapshot (see fromSnapshot()) where no controller
   * was available yet at construction time. Safe to call at any point;
   * takes effect on the next step boundary or ramp tick.
   * @param {ModeSwitch|null} modeSwitch
   */
  setModeSwitch(modeSwitch) {
    this._modeSwitch = modeSwitch;
  }

  /**
   * Pause the workout: halts step advancement (the 1s ticker keeps running
   * but _tick() below no-ops while _paused) and freezes the underlying
   * recording session, same as a free-ride Session pause.
   */
  pause() {
    this._paused = true;
    this._session.pause();
  }

  /** Resume step advancement and recording. */
  resume() {
    this._paused = false;
    this._session.resume();
  }

  /**
   * Drops the trailing run of idle samples from the underlying recording —
   * see Session#trimTrailingIdle(). Forwarded here the same way
   * pause()/resume() are, so app.js's idleness-triggered auto-pause works
   * identically whether the running session is a free ride (a plain
   * Session) or a structured workout (this class): both end up scrapping
   * the dead samples logged while onIdle()'s debounce was ticking down.
   */
  trimTrailingIdle() {
    this._session.trimTrailingIdle();
  }

  /**
   * Feed partial BLE data into the current sample accumulator.
   * Forwards to the underlying Session — without this, live metrics never
   * reach the chart/recording during a scripted workout.
   * @param {Partial<Sample>} data
   */
  pushData(data) {
    this._session.pushData(data);
  }

  /**
   * Drops fields from the underlying Session's rolling accumulator when the
   * device supplying them disconnects — see Session#clearData(). app.js
   * calls this on `session` unconditionally (it can't tell a free Session
   * from a ScriptedSession), so it has to exist here too.
   * @param {string[]} keys
   */
  clearData(keys) {
    this._session.clearData(keys);
  }

  /** Flushes any whole seconds still owed to the sample buffer — see
   *  Session#catchUp(). Called when the page becomes visible again. */
  catchUp() {
    this._session.catchUp();
  }

  /** Lap markers so far (forwarded for chart lap-marker rendering). */
  get laps() { return this._session.laps; }

  /** Caller-supplied metadata, forwarded from the underlying Session (see
   *  Session#meta) — e.g. so app.js's idle/disconnect handlers can check
   *  this.meta.testType against a running fitness test without needing a
   *  separate reference to whichever WorkoutModel it was built from. */
  get meta() { return this._session.meta; }

  /** Skip to the next step immediately. */
  async skipStep() {
    await this._advanceStep();
  }

  /** Skip to the previous step (go back one). */
  async prevStep() {
    if (this._stepIdx <= 0) return;
    this._stepIdx    -= 2; // -2 because _advanceStep increments first
    this._stepElapsed = 0;
    await this._advanceStep();
  }

  /**
   * Stop the scripted session, save, and return the SessionRecord.
   * @returns {Promise<SessionRecord>}
   */
  async stop() {
    clearInterval(this._ticker);
    this._ticker = null;
    if (this._modeSwitch) {
      await this._modeSwitch.deactivateAll().catch(() => {});
    }

    // Record exactly how far the rider got before this session's record is
    // built, so anything keyed off step progress (e.g. a fitness-test PPO
    // calculation) can read it back from the saved record's meta rather
    // than needing a live reference to this ScriptedSession. If we've
    // already advanced past the last step (workout ran to completion
    // rather than being stopped mid-stage), that's "every step completed,
    // 0s into the step after" — clamped rather than left out of range.
    const stepIndexAtStop   = Math.min(this._stepIdx, this._steps.length);
    const stepElapsedAtStop = this._stepIdx >= this._steps.length ? 0 : this._stepElapsed;
    this._session.setMeta({ stepIndexAtStop, stepElapsedAtStop, stepCount: this._steps.length });

    return await this._session.stop();
  }

  /** Discard the workout without saving — clears the ticker and delegates to the underlying Session. */
  discard() {
    clearInterval(this._ticker);
    this._ticker = null;
    this._session.discard();
  }

  /** Mark a lap at the current sample index. */
  markLap() {
    return this._session.markLap();
  }

  get isRunning()  { return this._session.isRunning; }
  get isPaused()   { return this._paused; }
  /** Recorded sample buffer so far (forwarded from the underlying Session). */
  get samples()    { return this._session.samples; }
  /** Elapsed session time in seconds (forwarded from the underlying Session). */
  get elapsedSec() { return this._session.elapsedSec; }
  /** Workout name (forwarded from the underlying Session). */
  get workoutName() { return this._session.workoutName; }

  /** Flattened step list (forwarded for UI consumers like the HUD's
   *  workout-target timeline — see app.js's _drawWorkoutTimeline() — that
   *  need the whole plan, not just the current step). */
  get steps() { return this._steps; }

  /** Current step info for UI display. */
  get currentStepInfo() {
    const step = this._steps[this._stepIdx];
    if (!step) return null;

    // Sum of every already-completed step's duration, plus how far into
    // the current one we are — i.e. seconds elapsed across the whole
    // workout, not just this step. Recomputed each call rather than
    // tracked incrementally so skipStep()/prevStep() (which jump _stepIdx
    // around directly) can't leave it out of sync.
    const elapsedBeforeStep = this._steps
      .slice(0, this._stepIdx)
      .reduce((acc, s) => acc + (s.duration ?? 0), 0);
    const totalElapsed = elapsedBeforeStep + this._stepElapsed;

    // The single live target value right now — equal to targetLow for
    // every step type except RAMP, where it's interpolated (honoring the
    // step's curve — linear or parabolic) the same way _tick() computes
    // the value it actually sends to the trainer (see _applyTarget()
    // below), so a UI reading this stays in lockstep with what the rider
    // is actually being asked for as it climbs or falls.
    const targetNow = resolveRampTarget(step, this._stepElapsed);

    return {
      stepIndex:    this._stepIdx,
      stepCount:    this._steps.length,
      step,
      stepElapsed:  this._stepElapsed,
      stepRemaining: Math.max(0, (step.duration ?? 0) - this._stepElapsed),
      isLast:       this._stepIdx === this._steps.length - 1,
      totalDuration:  this._totalDuration,
      totalElapsed,
      totalRemaining: Math.max(0, this._totalDuration - totalElapsed),
      targetNow,
    };
  }

  /**
   * Serializes this workout to a plain JSON-safe object so it can survive
   * an app kill — see recording/session-persistence.js. Captures the
   * workout plan and exactly which step/second the rider is at, plus
   * everything the underlying Session needs (see Session#toSnapshot()).
   * @returns {Object}
   */
  toSnapshot() {
    return {
      type:        'scripted',
      workout:     this._workout,
      ftp:         this._ftp,
      stepIdx:     this._stepIdx,
      stepElapsed: this._stepElapsed,
      session:     this._session.toSnapshot(),
    };
  }

  /**
   * Rebuilds a ScriptedSession from a snapshot produced by toSnapshot(),
   * resuming at the same step and the same point within it. Comes back
   * *running but paused* — call resume() once the rider is ready to
   * continue. modeSwitch may be null (e.g. the controller hasn't
   * reconnected yet); pass it once it's available via setModeSwitch().
   * @param {Object}     snapshot
   * @param {Object}     [opts]
   * @param {ModeSwitch} [opts.modeSwitch]
   * @param {number}     [opts.ftp]           Defaults to the snapshotted FTP.
   * @param {Function}   [opts.onSample]
   * @param {Function}   [opts.onStep]
   * @param {Function}   [opts.onComplete]
   * @param {Function}   [opts.onEnd]
   * @param {Function}   [opts.onCountdown]
   * @returns {ScriptedSession}
   */
  static fromSnapshot(snapshot, { modeSwitch, ftp, onSample, onStep, onComplete, onEnd, onCountdown } = {}) {
    const instance = new ScriptedSession({
      workout: snapshot.workout,
      modeSwitch,
      ftp: ftp ?? snapshot.ftp,
      onSample,
      onStep,
      onComplete,
      onEnd,
      onCountdown,
      workoutName: snapshot.session.workoutName,
      meta:        snapshot.session.meta,
    });

    instance._session     = Session.fromSnapshot(snapshot.session, { onSample, onEnd });
    instance._stepIdx     = snapshot.stepIdx;
    instance._stepElapsed = snapshot.stepElapsed;
    instance._paused      = true;
    instance._startTicker();

    return instance;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  _tick() {
    if (this._paused) return;

    this._stepElapsed++;

    const step = this._steps[this._stepIdx];
    if (!step) return;

    const remaining   = (step.duration ?? Infinity) - this._stepElapsed;
    const willAdvance = this._stepElapsed >= (step.duration ?? 0);

    // Refresh the step panel with the ticked-down remaining time every
    // second. onStep() otherwise only fires once per step change (from
    // _advanceStep()), which left the panel's remaining-time text and
    // progress bar frozen at the step's starting value for the step's
    // entire duration instead of counting down. Skipped on the tick that
    // ends the step — _advanceStep() below fires its own onStep() for
    // whichever step comes next, so this would just be stale info flashed
    // a moment before that.
    if (!willAdvance) this._onStep(this.currentStepInfo);

    // Countdown audio cues + "5,4,3,2,1" override text: 5s before step ends.
    // Runs after the refresh above so its own onCountdown() text wins for
    // the final few seconds instead of being clobbered by it.
    if (remaining > 0 && remaining <= 5) {
      audioCues.play('tick');
      this._onCountdown(remaining);
    }

    // Apply ramp interpolation if this is a ramp step (honors curve —
    // linear or parabolic — via resolveRampTarget()). Skipped for Heart
    // Rate: it can't be sent to the trainer either way (see _applyTarget()),
    // so there's nothing here worth a call every second.
    if (step.type === STEP_TYPES.RAMP && step.targetHigh != null && this._modeSwitch
        && step.targetType !== TARGET_TYPES.HEART_RATE) {
      const current = resolveRampTarget(step, this._stepElapsed);
      this._applyTarget(step, current, current).catch(() => {});
    }

    // Heart Rate steps: nudge the rider with audio if their measured heart
    // rate has strayed outside the target zone (see _checkHeartRateZone()).
    this._checkHeartRateZone(step);

    // Advance when step duration expires
    if (willAdvance) {
      this._advanceStep().catch(() => {});
    }
  }

  /**
   * Heart Rate step monitor. Reads the rider's most recent heart-rate
   * sample (if a strap is paired) and compares it against the current
   * step's target zone — target ± HR_TOLERANCE_BPM, following the ramp
   * the same way the trainer-driven target types do (see
   * core/cardio-model.js#heartRateZone) — nudging with a distinct audio
   * cue for "too high" vs "too low".
   *
   * Nudges immediately the moment the rider goes out of range, or the
   * moment the direction flips (high -> low or back); while they stay out
   * on the same side it re-nudges only every HR_NUDGE_COOLDOWN_MS rather
   * than every tick. Going back in range resets the tracked direction so
   * the next excursion nudges right away rather than waiting out a
   * cooldown left over from the previous one.
   *
   * A no-op for every other target type, and for a Heart Rate step with no
   * HR strap paired yet (nothing to compare against).
   *
   * @param {WorkoutStep} step
   */
  _checkHeartRateZone(step) {
    if (step.targetType !== TARGET_TYPES.HEART_RATE) {
      this._hrOutOfRangeDir = null;
      return;
    }

    const hr = this._session.latestData.heartRate;
    if (hr == null) return; // no HR strap paired (yet) — leave prior state alone

    const target = resolveRampTarget(step, this._stepElapsed);
    const { low, high } = heartRateZone(target);
    const dir = hr > high ? 'high' : hr < low ? 'low' : null;

    if (dir && (dir !== this._hrOutOfRangeDir || Date.now() - this._hrLastNudgeAt >= HR_NUDGE_COOLDOWN_MS)) {
      audioCues.play(dir === 'high' ? 'hrHigh' : 'hrLow');
      this._hrLastNudgeAt = Date.now();
    }
    this._hrOutOfRangeDir = dir;
  }

  async _advanceStep() {
    this._stepIdx++;
    this._stepElapsed = 0;

    // Fresh step, fresh zone — don't carry a cooldown (or a stale
    // out-of-range direction) over from whatever the previous step was.
    this._hrOutOfRangeDir = null;
    this._hrLastNudgeAt   = 0;

    if (this._stepIdx >= this._steps.length) {
      // Workout complete
      audioCues.play('complete');
      this._onComplete();
      await this.stop();
      return;
    }

    const step = this._steps[this._stepIdx];
    audioCues.play('interval');

    // Apply the step target to the trainer
    if (this._modeSwitch && step.type !== STEP_TYPES.FREE_RIDE) {
      await this._applyTarget(step, step.targetLow, step.targetHigh ?? step.targetLow)
        .catch(err => console.warn('[scripted] applyTarget error:', err.message));
    }

    // Notify UI
    this._onStep(this.currentStepInfo);
  }

  async _applyTarget(step, valueLow, valueHigh) {
    if (!this._modeSwitch) return;

    switch (step.targetType) {
      case TARGET_TYPES.POWER: {
        const watts = resolveWatts(valueLow, this._ftp);
        if (this._modeSwitch.activeModeName !== MODES.ERG) {
          await this._modeSwitch.switchTo(MODES.ERG);
        }
        await this._modeSwitch.setTarget(watts);
        break;
      }
      case TARGET_TYPES.SLOPE: {
        if (this._modeSwitch.activeModeName !== MODES.SLOPE) {
          await this._modeSwitch.switchTo(MODES.SLOPE);
        }
        await this._modeSwitch.setTarget(valueLow);
        break;
      }
      case TARGET_TYPES.RESISTANCE: {
        if (this._modeSwitch.activeModeName !== MODES.RESISTANCE) {
          await this._modeSwitch.switchTo(MODES.RESISTANCE);
        }
        await this._modeSwitch.setTarget(valueLow);
        break;
      }
      case TARGET_TYPES.HEART_RATE:
      case TARGET_TYPES.NONE:
      default:
        // Free ride — and Heart Rate, which can't be commanded to a
        // trainer at all; it's the rider's own physiological response,
        // monitored and nudged via audio instead (see
        // _checkHeartRateZone()) — deactivate structured control so the
        // rider can freely adjust their own effort.
        await this._modeSwitch.deactivateAll();
        break;
    }
  }
}

export default ScriptedSession;
