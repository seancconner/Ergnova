// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ux/audio-cues.js
 *
 * Synthesised audio cues for session events using the Web Audio API.
 * No external audio files needed — all sounds are generated programmatically.
 *
 * Cue types:
 *   beep       — short, neutral (target reached, lap marked)
 *   interval   — rising two-tone (interval start)
 *   warning    — descending tone (5 seconds before interval ends)
 *   complete   — rising three-tone fanfare (session / workout complete)
 *   hrHigh     — gentle descending triangle-wave tone (heart rate above the
 *                target zone during a Heart Rate step — ease off)
 *   hrLow      — gentle ascending triangle-wave tone (heart rate below the
 *                target zone during a Heart Rate step — pick it up)
 *
 * Usage:
 *   import { audioCues } from './ux/audio-cues.js';
 *   audioCues.enable();
 *   audioCues.play('interval');
 *   audioCues.play('beep');
 *   audioCues.disable();
 */

let _ctx     = null;
let _enabled = false;

function _getCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

/**
 * Play a synthesized tone.
 * @param {number}   freq      Hz
 * @param {number}   duration  seconds
 * @param {number}   startAt   AudioContext time (ctx.currentTime + offset)
 * @param {number}   [gain=0.3]
 * @param {'sine'|'square'|'triangle'} [type='sine']
 */
function _tone(freq, duration, startAt, gain = 0.3, type = 'sine') {
  const ctx  = _getCtx();
  const osc  = ctx.createOscillator();
  const vol  = ctx.createGain();

  osc.type      = type;
  osc.frequency.setValueAtTime(freq, startAt);

  vol.gain.setValueAtTime(0, startAt);
  vol.gain.linearRampToValueAtTime(gain, startAt + 0.01);
  vol.gain.linearRampToValueAtTime(0,    startAt + duration - 0.01);

  osc.connect(vol);
  vol.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

const CUES = {
  /** Short neutral beep — lap, target set */
  beep() {
    const ctx = _getCtx();
    const t   = ctx.currentTime;
    _tone(880, 0.12, t, 0.25);
  },

  /** Rising two-tone — interval start */
  interval() {
    const ctx = _getCtx();
    const t   = ctx.currentTime;
    _tone(660, 0.15, t,        0.3);
    _tone(880, 0.20, t + 0.18, 0.3);
  },

  /** Descending tone — approaching interval end (5 s warning) */
  warning() {
    const ctx = _getCtx();
    const t   = ctx.currentTime;
    _tone(880, 0.12, t,        0.25);
    _tone(660, 0.12, t + 0.15, 0.25);
  },

  /** Rising three-tone fanfare — session complete */
  complete() {
    const ctx = _getCtx();
    const t   = ctx.currentTime;
    _tone(523, 0.18, t,        0.3);
    _tone(659, 0.18, t + 0.22, 0.3);
    _tone(784, 0.35, t + 0.46, 0.35);
  },

  /** Countdown tick (1 s before interval boundary) */
  tick() {
    const ctx = _getCtx();
    _tone(1046, 0.06, ctx.currentTime, 0.18, 'square');
  },

  /** Heart rate above the target zone (Heart Rate step) — ease off.
   *  A soft descending pair on a triangle wave — distinct in timbre from
   *  the sine-wave `warning` cue (which means something different: an
   *  interval ending) even though the shape is similarly "downward". */
  hrHigh() {
    const ctx = _getCtx();
    const t   = ctx.currentTime;
    _tone(660, 0.16, t,        0.22, 'triangle');
    _tone(440, 0.22, t + 0.17, 0.22, 'triangle');
  },

  /** Heart rate below the target zone (Heart Rate step) — pick it up.
   *  Mirror image of hrHigh — ascending instead of descending — so the
   *  two are easy to tell apart by ear while still clearly related. */
  hrLow() {
    const ctx = _getCtx();
    const t   = ctx.currentTime;
    _tone(440, 0.16, t,        0.22, 'triangle');
    _tone(660, 0.22, t + 0.17, 0.22, 'triangle');
  },
};

export const audioCues = {
  /** Enable audio cues. */
  enable() { _enabled = true; },

  /** Disable audio cues (calls are silently ignored). */
  disable() { _enabled = false; },

  get isEnabled() { return _enabled; },

  /**
   * Play a named cue.
   * @param {'beep'|'interval'|'warning'|'complete'|'tick'|'hrHigh'|'hrLow'} name
   */
  play(name) {
    if (!_enabled) return;
    if (!CUES[name]) { console.warn('[audio-cues] Unknown cue:', name); return; }
    // Resume AudioContext if suspended (autoplay policy)
    const ctx = _getCtx();
    const doPlay = () => CUES[name]();
    if (ctx.state === 'suspended') {
      ctx.resume().then(doPlay).catch(() => {});
    } else {
      doPlay();
    }
  },

  /**
   * Schedule a countdown sequence ending at `secondsFromNow`.
   * Plays tick sounds at 5, 4, 3, 2, 1 seconds before the boundary,
   * then plays the `interval` cue at 0.
   *
   * @param {number} secondsFromNow
   */
  scheduleCountdown(secondsFromNow) {
    for (let i = 5; i >= 1; i--) {
      const delay = (secondsFromNow - i) * 1000;
      if (delay < 0) continue;
      setTimeout(() => this.play('tick'), delay);
    }
    setTimeout(() => this.play('interval'), secondsFromNow * 1000);
  },
};

export default audioCues;
