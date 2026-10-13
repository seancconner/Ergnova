// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * recording/laps.js
 *
 * Lap marking during a live session.
 * Tracks lap boundaries in the sample stream and computes per-lap summaries.
 *
 * Usage:
 *   import { LapTracker } from './recording/laps.js';
 *   const laps = new LapTracker();
 *   laps.start(samples);      // called each time a new sample arrives
 *   laps.mark();              // user presses lap button
 *   const summary = laps.currentLapSummary(samples);
 *   const all = laps.allLaps(samples);
 */

export class LapTracker {
  constructor() {
    /** Array of { lapNumber, sampleIndex, timestamp } */
    this._marks = [];
    this._lapCount = 0;
  }

  /** Reset for a new session. */
  reset() {
    this._marks = [];
    this._lapCount = 0;
  }

  /**
   * Restore lap marks from a previously saved array — used when rehydrating
   * a Session from a snapshot after an app restart (see
   * recording/session.js#fromSnapshot). Replaces whatever marks this
   * tracker currently has.
   * @param {LapMark[]} marks
   */
  restore(marks) {
    this._marks    = (marks ?? []).map(m => ({ ...m }));
    this._lapCount = this._marks.reduce((max, m) => Math.max(max, m.lapNumber), 0);
  }

  /**
   * Mark a lap boundary at the current sample index.
   * @param {number} sampleIndex  Index of the current (most recent) sample.
   * @param {number} timestamp    Unix ms of the mark.
   */
  mark(sampleIndex, timestamp = Date.now()) {
    this._lapCount++;
    this._marks.push({
      lapNumber:   this._lapCount,
      sampleIndex,
      timestamp,
    });
    console.debug(`[laps] Lap ${this._lapCount} marked at sample ${sampleIndex}`);
    return this._lapCount;
  }

  /** Returns all lap mark objects. */
  get marks() { return [...this._marks]; }

  /**
   * Clamps every mark's sampleIndex down to maxIndex. Used by
   * Session#trimTrailingIdle() after it splices trailing idle samples off
   * the buffer: a lap marked inside that now-discarded tail would
   * otherwise point past the end of the array, so pull it back to the new
   * end instead of leaving a dangling index (it resolves to an empty
   * trailing segment in allLaps() rather than being dropped).
   * @param {number} maxIndex
   */
  clampSampleIndices(maxIndex) {
    for (const m of this._marks) {
      if (m.sampleIndex > maxIndex) m.sampleIndex = maxIndex;
    }
  }

  /** Current lap number (0 = before first manual lap). */
  get currentLap() { return this._lapCount; }

  /**
   * Returns the start index of the current (most recent) lap segment.
   * @returns {number}
   */
  currentLapStartIndex() {
    if (this._marks.length === 0) return 0;
    return this._marks[this._marks.length - 1].sampleIndex;
  }

  /**
   * Compute a summary object for a slice of the samples array.
   * @param {Sample[]} samples
   * @param {number}   startIdx
   * @param {number}   endIdx
   * @returns {LapSummary}
   */
  _summarize(samples, startIdx, endIdx) {
    const slice = samples.slice(startIdx, endIdx);
    if (slice.length === 0) return _emptySummary();

    const powers    = slice.map(s => s.power).filter(v => v !== null);
    const hrs       = slice.map(s => s.heartRate).filter(v => v !== null);
    const cadences  = slice.map(s => s.cadence).filter(v => v !== null);

    const startTime = slice[0].timestamp;
    const endTime   = slice[slice.length - 1].timestamp;

    return {
      duration:     Math.round((endTime - startTime) / 1000),
      avgPower:     powers.length   ? Math.round(_avg(powers))   : null,
      maxPower:     powers.length   ? Math.max(...powers)         : null,
      avgHr:        hrs.length      ? Math.round(_avg(hrs))       : null,
      maxHr:        hrs.length      ? Math.max(...hrs)            : null,
      avgCadence:   cadences.length ? Math.round(_avg(cadences))  : null,
      distance:     _totalDistance(slice),
    };
  }

  /**
   * Returns the summary for the current (ongoing) lap.
   * @param {Sample[]} samples  Full session sample buffer.
   * @returns {LapSummary}
   */
  currentLapSummary(samples) {
    const startIdx = this.currentLapStartIndex();
    return this._summarize(samples, startIdx, samples.length);
  }

  /**
   * Returns an array of summaries for all completed laps plus the current one.
   * @param {Sample[]} samples
   * @returns {{ lapNumber: number, summary: LapSummary }[]}
   */
  allLaps(samples) {
    if (samples.length === 0) return [];

    const boundaries = [
      { lapNumber: 0, sampleIndex: 0 },
      ...this._marks,
      { lapNumber: this._lapCount + 1, sampleIndex: samples.length },
    ];

    const out = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i];
      const end   = boundaries[i + 1];
      out.push({
        lapNumber: i + 1,
        summary:   this._summarize(samples, start.sampleIndex, end.sampleIndex),
      });
    }
    return out;
  }
}

function _avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function _totalDistance(slice) {
  const last = slice[slice.length - 1];
  const first = slice[0];
  if (last?.distance !== null && first?.distance !== null) {
    return Math.round(last.distance - first.distance);
  }
  return null;
}

function _emptySummary() {
  return { duration: 0, avgPower: null, maxPower: null, avgHr: null,
           maxHr: null, avgCadence: null, distance: null };
}

export default LapTracker;

/**
 * @typedef {Object} LapMark
 * @property {number} lapNumber
 * @property {number} sampleIndex
 * @property {number} timestamp
 */

/**
 * @typedef {Object} LapSummary
 * @property {number}      duration   seconds
 * @property {number|null} avgPower
 * @property {number|null} maxPower
 * @property {number|null} avgHr
 * @property {number|null} maxHr
 * @property {number|null} avgCadence
 * @property {number|null} distance   meters
 */
