// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * core/sample.js
 *
 * Canonical shape for a single time-stamped data point in a workout recording.
 * All fields except `timestamp` are optional — only fields the connected
 * devices can provide will be populated.
 *
 * Used by:
 *   - Live streaming buffer (populated per BLE notification)
 *   - History storage (saved to IndexedDB)
 *   - Every file exporter (FIT, TCX, GPX)
 *   - Chart engine (consumed as-is)
 *
 * Usage:
 *   import { createSample, mergeSample } from './core/sample.js';
 *
 *   const s = createSample({ power: 250, cadence: 88 });
 *   const updated = mergeSample(s, { heartRate: 142 });
 */

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a new sample with the current timestamp.
 * All numeric fields default to null (not 0) so consumers can distinguish
 * "no data" from "zero watts / zero rpm."
 *
 * @param {Partial<Sample>} fields   Any subset of sample fields to pre-fill.
 * @returns {Sample}
 */
export function createSample(fields = {}) {
  return {
    // ── Identity ────────────────────────────────────────────────────────────
    /** Unix epoch milliseconds — always set. */
    timestamp: Date.now(),

    // ── Power ───────────────────────────────────────────────────────────────
    /** Instantaneous power in watts. From trainer or dedicated power meter. */
    power: null,

    /** 3-second rolling average power (watts). Computed live if power is present. */
    power3s: null,

    // ── Cadence & Speed ─────────────────────────────────────────────────────
    /** Pedalling cadence in RPM. */
    cadence: null,

    /** Speed in km/h. Derived or reported by trainer. */
    speed: null,

    /** Cumulative distance in meters since session start. */
    distance: null,

    // ── Energy ──────────────────────────────────────────────────────────────
    /**
     * Cumulative calories burned (kcal) since session start. Either a
     * device-reported running total (e.g. some smart bikes) or an estimate
     * derived from power output — see metrics/calories.js.
     */
    calories: null,

    // ── Heart rate ──────────────────────────────────────────────────────────
    /** Heart rate in BPM. */
    heartRate: null,

    /**
     * Raw RR interval in milliseconds (time between successive R-peaks).
     * Only populated when the HR strap provides native RR data.
     * Used for HRV analysis and FIT file HRV records.
     */
    rrInterval: null,

    // ── Muscle oxygenation (Moxy / BSX) ────────────────────────────────────
    /** SmO₂: muscle oxygen saturation as a percentage (0–100). */
    smo2: null,

    /** tHb: total haemoglobin in g/dL. */
    thb: null,

    // ── Core temperature ────────────────────────────────────────────────────
    /** Core body temperature in °C. */
    coreTemp: null,

    // ── Trainer state ───────────────────────────────────────────────────────
    /** Resistance level as a percentage (0–100). Used in resistance mode. */
    resistance: null,

    /** The target value that was active at this moment (watts, %, or grade). */
    targetValue: null,

    /**
     * The control mode active at this moment.
     * One of: 'erg' | 'resistance' | 'slope' | 'virtualGear' | null
     */
    targetMode: null,

    // ── Session structure ───────────────────────────────────────────────────
    /** Elapsed seconds since the session started. */
    elapsedTime: null,

    /**
     * Lap marker. null = not a lap boundary, integer = lap number that
     * started at this sample. Lap 1 starts at index 0.
     */
    lap: null,

    /**
     * True when this sample fills a stretch where nothing at all reached the
     * page from the sensors (see recording/session.js#_tick()) — the
     * WebView was frozen, the link was dead, etc. — so its readings are just
     * the most-recently-known reading held forward, not something measured
     * at this specific second. Consumers that treat "real value" and
     * "carried-forward value" differently — chart-engine.js's live/stale
     * series rendering, average/NP stat calculations — should check this the
     * same way they already check for null (see
     * recording/session.js#clearData) rather than take these readings at
     * face value.
     *
     * NOT set for a second that was merely recorded late: when the page is
     * backgrounded and its 1 Hz timer is throttled, readings keep arriving
     * and Session replays them from its journal, so those catch-up samples
     * carry what the sensors really reported at each second and are
     * indistinguishable from on-time ones. False for every such sample.
     */
    backfilled: false,

    // Spread any caller-supplied fields last so they override defaults.
    ...fields,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a new sample with the given fields merged in.
 * Does not mutate the original. Keeps the original timestamp unless overridden.
 *
 * @param {Sample}            base
 * @param {Partial<Sample>}   fields
 * @returns {Sample}
 */
export function mergeSample(base, fields) {
  return { ...base, ...fields };
}

/**
 * Returns only the non-null fields from a sample as a plain object.
 * Useful for storage and serialisation where sparse data is preferable.
 *
 * @param {Sample} sample
 * @returns {Object}
 */
export function sparseSample(sample) {
  return Object.fromEntries(
    Object.entries(sample).filter(([, v]) => v !== null)
  );
}

/**
 * Returns true if this sample has at least one data field populated
 * (i.e. it is not just a timestamp stub).
 *
 * @param {Sample} sample
 * @returns {boolean}
 */
export function hasSampleData(sample) {
  const { timestamp, ...rest } = sample;
  return Object.values(rest).some(v => v !== null);
}

/**
 * Computes a 3-second rolling average power from a sample buffer.
 * Call this after appending each new sample if power is available.
 *
 * @param {Sample[]} buffer  The full sample buffer for this session.
 * @returns {number|null}    Averaged watts, or null if no power data.
 */
export function rolling3sPower(buffer) {
  if (!buffer || buffer.length === 0) return null;

  const now   = buffer[buffer.length - 1].timestamp;
  const cutoff = now - 3000; // 3 seconds in ms
  const window = buffer.filter(s => s.timestamp >= cutoff && s.power !== null);

  if (window.length === 0) return null;
  const sum = window.reduce((acc, s) => acc + s.power, 0);
  return Math.round(sum / window.length);
}

/**
 * Computes a 30-second rolling average power from a sample buffer.
 * Required for Normalized Power (NP) calculation.
 *
 * @param {Sample[]} buffer
 * @returns {number|null}
 */
export function rolling30sPower(buffer) {
  if (!buffer || buffer.length === 0) return null;

  const now    = buffer[buffer.length - 1].timestamp;
  const cutoff = now - 30_000;
  const window = buffer.filter(s => s.timestamp >= cutoff && s.power !== null);

  if (window.length === 0) return null;
  const sum = window.reduce((acc, s) => acc + s.power, 0);
  return Math.round(sum / window.length);
}

// ─── Type documentation (JSDoc typedef) ───────────────────────────────────────

/**
 * @typedef {Object} Sample
 * @property {number}       timestamp   - Unix epoch ms (required)
 * @property {number|null}  power       - Watts
 * @property {number|null}  power3s     - 3-sec rolling average watts
 * @property {number|null}  cadence     - RPM
 * @property {number|null}  speed       - km/h
 * @property {number|null}  distance    - Cumulative meters
 * @property {number|null}  calories    - Cumulative kcal burned
 * @property {number|null}  heartRate   - BPM
 * @property {number|null}  rrInterval  - ms between R-peaks
 * @property {number|null}  smo2        - Muscle O₂ saturation %
 * @property {number|null}  thb         - Total haemoglobin g/dL
 * @property {number|null}  coreTemp    - °C
 * @property {number|null}  resistance  - 0–100%
 * @property {number|null}  targetValue - Active target (mode-dependent units)
 * @property {string|null}  targetMode  - 'erg'|'resistance'|'slope'|'virtualGear'
 * @property {number|null}  elapsedTime - Seconds since session start
 * @property {number|null}  lap         - Lap number (set only on lap boundaries)
 */
