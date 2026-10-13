// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * platform/background-snapshot.js
 *
 * Pure formatting: turns the app's live workout state into the `snapshot`
 * object platform/background-session.js's sync() takes (see that file's
 * header comment for the shape), which the native shell renders as the
 * ongoing tray notification. No DOM, no timers, no bridge — app.js gathers
 * the inputs, this decides what the words on the notification say. Kept
 * separate so it can be smoke-tested in plain node
 * (__background_snapshot_smoketest__.js).
 *
 * The snapshot carries the same information twice, for two renderers:
 *
 *   metrics / notes / totals
 *             STRUCTURED — what the Android shell draws its icon layouts from
 *             (Ergnova/Platforms/Android/BackgroundNotificationViews.cs): an
 *             icon per live metric on the collapsed row and in the expanded
 *             grid, context lines with their own icons, a totals row. `key`
 *             is what picks the icon on the native side, so it must be one of
 *             the keys that file's IconByKey knows (power, heartRate, cadence,
 *             speed, smo2, coreTemp — app.js's METRIC_ORDER — plus calories,
 *             distance, sets, exercise, rest, step, target). The metrics are
 *             also what the status-bar icon rotates through. Values are
 *             already unit-converted; `unit` is kept separate so the layout
 *             can set it smaller.
 *   text / expanded
 *             PLAIN TEXT — what the native side falls back to if it can't
 *             inflate those layouts, and what accessibility services read.
 *               text      The COLLAPSED line — at most the first three live
 *                         metrics, so it stays on one line at typical widths
 *                         ("215 W · 148 bpm · 88 rpm").
 *               expanded  The EXPANDED body. Android's BigTextStyle shows this
 *                         INSTEAD of `text` when the notification is pulled
 *                         open, so it must be a superset of the collapsed
 *                         line, not a continuation of it.
 *         Both are derived from the same readings as the structured fields
 *         below, so the two renderings can't disagree.
 *
 * `status` ('running' | 'paused' | 'waiting') is also what the native side
 * uses to pick the notification's action button — Pause while running, Play
 * while paused, "Start now" while waiting for the first pedal stroke — so it
 * is always passed through as one of those three strings.
 */

import { formatDistance, formatDistanceValue, distanceUnitLabel } from '../metrics/units.js';

const COLLAPSED_METRIC_COUNT = 3;
const SEP = ' · ';

const STATUSES = new Set(['running', 'paused', 'waiting']);

/**
 * m:ss under an hour, h:mm:ss past it. Anything that isn't a number reads as
 * an em dash; negatives clamp to 0:00.
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
export function formatClock(seconds) {
  if (seconds == null) return '—';
  const n = Number(seconds);
  if (!Number.isFinite(n)) return '—';
  const total = Math.floor(Math.max(0, n));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function _status(status) {
  return STATUSES.has(status) ? status : 'running';
}

function _elapsed(elapsedSec) {
  const n = Number(elapsedSec);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/** True for a real numeric reading. Zero counts — 0 W is a reading, null is not. */
function _isReading(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The live readings present in `sample`, in `metricOrder`, each already
 * unit-formatted through the metric's own fmt() — so imperial speed etc.
 * matches what the in-app HUD shows.
 * @returns {{key: string, label: string, num: string, unit: string, color: string|null, value: string}[]}
 *          num is the formatted number ("215"), unit its unit ("W"), and value
 *          the two joined ("215 W") for the plain-text lines
 */
function _readings(sample, metricDefs, metricOrder) {
  const out = [];
  if (!sample || !metricDefs) return out;
  for (const key of metricOrder ?? []) {
    const def = metricDefs[key];
    const raw = sample[key];
    if (!def || !_isReading(raw)) continue;
    let shown;
    try { shown = def.fmt ? def.fmt(raw) : String(raw); } catch { continue; }
    const num = `${shown}`;
    const unit = def.unit ?? '';
    out.push({
      key,
      label: def.label ?? key,
      num,
      unit,
      color: typeof def.color === 'string' ? def.color : null,
      value: unit ? `${num} ${unit}` : num,
    });
  }
  return out;
}

/** A reading in the shape the native layouts take. `color` is the metric's own chart colour. */
function _metricEntry(r) {
  return { key: r.key, label: r.label, value: r.num, unit: r.unit, color: r.color };
}

/**
 * @param {Object}   o
 * @param {string}   [o.title]        workout name; blank falls back to "Free Ride"
 * @param {string}   o.status         'running' | 'paused' | 'waiting'
 * @param {number}   o.elapsedSec     excludes paused time, same as Session#elapsedSec
 * @param {Object|null} [o.sample]    latest recorded Sample
 * @param {Object}   o.metricDefs     app.js's METRIC_DEFS (label / unit / fmt)
 * @param {string[]} o.metricOrder    app.js's METRIC_ORDER
 * @param {string}   [o.units]        'metric' | 'imperial' (distance formatting)
 * @param {{index:number,count:number,label:string,remainingSec:number,targetLabel:string|null}|null} [o.step]
 *        scripted workouts only
 * @returns {{title:string,status:string,elapsedSec:number,text:string,expanded:string,
 *            metrics:Object[],notes:Object[],totals:Object[]}}
 */
export function buildCardioSnapshot({ title, status, elapsedSec, sample, metricDefs, metricOrder, units, step }) {
  const st = _status(status);
  const readings = _readings(sample, metricDefs, metricOrder);

  let text;
  if (st === 'waiting') text = 'Waiting for you to start pedaling';
  else if (readings.length) text = readings.slice(0, COLLAPSED_METRIC_COUNT).map(r => r.value).join(SEP);
  else text = st === 'paused' ? '' : 'Waiting for sensor data'; // the native side prefixes "Paused at m:ss" itself

  const lines = [];
  const notes = [];

  if (step && st !== 'waiting') {
    const where = step.count > 1 ? `Step ${step.index + 1}/${step.count}${SEP}${step.label}` : step.label;
    const left = `${formatClock(step.remainingSec)} left`;
    lines.push(`${where}${SEP}${left}`);
    notes.push({ key: 'step', text: where, trailing: left });
    if (step.targetLabel) {
      lines.push(`Target ${step.targetLabel}`);
      notes.push({ key: 'target', text: `Target ${step.targetLabel}`, trailing: null });
    }
  }

  // Two metrics per line — one per line makes a six-sensor ride a tall notification.
  for (let i = 0; i < readings.length; i += 2) {
    lines.push(readings.slice(i, i + 2).map(r => `${r.label} ${r.value}`).join(SEP));
  }

  const totals = [];
  const totalEntries = [];
  if (_isReading(sample?.calories)) {
    const kcal = Math.round(sample.calories);
    totals.push(`Calories ${kcal} kcal`);
    totalEntries.push({ key: 'calories', label: 'Calories', value: String(kcal), unit: 'kcal', color: null });
  }
  if (_isReading(sample?.distance)) {
    totals.push(`Distance ${formatDistance(sample.distance, units)}`);
    totalEntries.push({
      key: 'distance', label: 'Distance',
      value: formatDistanceValue(sample.distance, units), unit: distanceUnitLabel(units), color: null,
    });
  }
  if (totals.length) lines.push(totals.join(SEP));

  return {
    title: String(title ?? '').trim() || 'Free Ride',
    status: st,
    elapsedSec: _elapsed(elapsedSec),
    text,
    expanded: lines.join('\n'),
    metrics: readings.map(_metricEntry),
    notes,
    totals: totalEntries,
  };
}

/**
 * @param {Object}   o
 * @param {string}   [o.title]           blank falls back to "Strength"
 * @param {string}   o.status            'running' | 'paused'
 * @param {number}   o.elapsedSec
 * @param {Object|null} [o.sample]       latest recorded Sample (heart rate, when a strap is connected)
 * @param {number}   [o.setCount]        sets logged so far
 * @param {string|null} [o.activeExercise]  exercise of the set/hold currently in progress
 * @param {number|null} [o.restSec]      seconds since the last set finished, when none is in progress
 * @param {Object}   [o.metricDefs]      app.js's METRIC_DEFS — only heartRate's label and colour are read, so the
 *                                       strap's icon matches the cardio notification's
 * @returns {{title:string,status:string,elapsedSec:number,text:string,expanded:string,
 *            metrics:Object[],notes:Object[],totals:Object[]}}
 */
export function buildStrengthSnapshot({ title, status, elapsedSec, sample, setCount, activeExercise, restSec, metricDefs }) {
  const n = Number.isFinite(Number(setCount)) ? Math.max(0, Math.floor(Number(setCount))) : 0;
  const parts = [`${n} ${n === 1 ? 'set' : 'sets'}`];
  if (_isReading(sample?.heartRate)) parts.push(`${Math.round(sample.heartRate)} bpm`);
  const text = parts.join(SEP);

  // BigTextStyle replaces the collapsed line when expanded, so repeat it here.
  const lines = [text];
  const notes = [];
  if (activeExercise) {
    lines.push(`Now ${activeExercise}`);
    notes.push({ key: 'exercise', text: String(activeExercise), trailing: null });
  } else if (_isReading(restSec) && restSec >= 0) {
    lines.push(`Resting ${formatClock(restSec)}`);
    notes.push({ key: 'rest', text: 'Resting', trailing: formatClock(restSec) });
  }

  // What the status-bar icon rotates through: the set count (always), then the strap's heart rate.
  const metrics = [{ key: 'sets', label: 'Sets', value: String(n), unit: n === 1 ? 'set' : 'sets', color: null }];
  if (_isReading(sample?.heartRate)) {
    const hr = metricDefs?.heartRate;
    metrics.push({
      key: 'heartRate', label: hr?.label ?? 'Heart Rate', value: String(Math.round(sample.heartRate)),
      unit: hr?.unit ?? 'bpm', color: typeof hr?.color === 'string' ? hr.color : null,
    });
  }

  return {
    title: String(title ?? '').trim() || 'Strength',
    status: _status(status),
    elapsedSec: _elapsed(elapsedSec),
    text,
    expanded: lines.join('\n'),
    metrics,
    notes,
    totals: [],
  };
}
