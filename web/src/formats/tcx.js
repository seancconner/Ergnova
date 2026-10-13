// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * formats/tcx.js
 *
 * Parser and writer for Garmin Training Center XML (.tcx) workout files.
 *
 * TCX workouts use a <TrainingCenterDatabase> root with a <Workouts> section
 * containing <Workout> elements. Each workout has a series of <Step> elements
 * which can be <Step xsi:type="Step_t"> (single step) or
 * <Step xsi:type="Repeat_t"> (repeat block with nested steps).
 *
 * Power targets in TCX are expressed as watts (absolute) via
 * <PowerTarget><Low><Watts> and <PowerTarget><High><Watts>.
 *
 * Supported target types → WorkoutModel:
 *   None         → FREE_RIDE
 *   Power        → POWER (absolute watts, converted to FTP fraction with
 *                  suggestedFtp or fallback 200)
 *   HeartRate    → read-only note (stored as comment, not enforced)
 *   Speed        → ignored (not a training-mode target)
 *   Cadence      → stored as cadenceTarget
 *
 * Usage (via registry — auto-registered at bottom):
 *   import { registry } from './format-registry.js';
 *   const model = registry.parse(text, '.tcx');
 *   const xml   = registry.write(model, '.tcx');
 */

import {
  createWorkout, createStep, STEP_TYPES, TARGET_TYPES,
} from '../core/cardio-model.js';
import registry from './format-registry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function text(el, tag) {
  return el?.querySelector(tag)?.textContent?.trim() ?? null;
}

function num(el, tag, fallback = null) {
  const v = parseFloat(text(el, tag));
  return isNaN(v) ? fallback : v;
}

/** Parse HH:MM:SS or PT##S (ISO 8601 duration) or bare seconds into seconds. */
function parseDuration(raw) {
  if (!raw) return 60;
  raw = raw.trim();
  // ISO 8601: PT30S, PT1M30S, PT1H2M3S
  if (raw.startsWith('P')) {
    const hMatch = raw.match(/(\d+)H/);
    const mMatch = raw.match(/(\d+)M/);
    const sMatch = raw.match(/(\d+(?:\.\d+)?)S/);
    return (parseInt(hMatch?.[1] ?? 0) * 3600) +
           (parseInt(mMatch?.[1] ?? 0) * 60) +
           (parseFloat(sMatch?.[1] ?? 0));
  }
  // HH:MM:SS
  const parts = raw.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseFloat(raw) || 60;
}

function fmtDurationISO(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  let out = 'PT';
  if (h) out += h + 'H';
  if (m) out += m + 'M';
  if (s || (!h && !m)) out += s + 'S';
  return out;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Step parser ──────────────────────────────────────────────────────────────

function parseStep(el, fallbackFtp) {
  const type = el.getAttribute('xsi:type') ?? el.tagName;

  // Repeat block
  if (type === 'Repeat_t' || type.toLowerCase().includes('repeat')) {
    const repeatCount = parseInt(text(el, 'Repetitions') ?? '1');
    const childEls    = Array.from(el.querySelectorAll(':scope > Child > Step, :scope > Step'));
    const childSteps  = childEls.map(c => parseStep(c, fallbackFtp));

    const onStep  = childSteps[0] ?? createStep({ type: STEP_TYPES.STEADY, duration: 60 });
    const offStep = childSteps[1] ?? createStep({ type: STEP_TYPES.REST,   duration: 60 });

    return createStep({
      type:       STEP_TYPES.INTERVAL,
      repeat:     repeatCount,
      onStep,
      offStep,
      duration:   (onStep.duration + offStep.duration) * repeatCount,
      targetType: onStep.targetType,
    });
  }

  // Duration
  const durType = text(el, 'DurationType');
  const durValue = text(el, 'DurationValue');
  let duration = 60;
  if (durType === 'Time') {
    duration = parseDuration(durValue);
  }

  // Intensity → step type
  const intensity = text(el, 'Intensity') ?? 'Active';
  let stepType = STEP_TYPES.STEADY;
  if (intensity === 'Resting') stepType = STEP_TYPES.REST;
  // TCX doesn't distinguish warmup/cooldown by tag; use name heuristics
  const name = text(el, 'Name') ?? '';
  if (/warm/i.test(name))   stepType = STEP_TYPES.WARMUP;
  if (/cool/i.test(name))   stepType = STEP_TYPES.COOLDOWN;

  // Target
  const targetType = text(el, 'TargetType');
  let modelTarget = TARGET_TYPES.NONE;
  let targetLow   = 0;
  let targetHigh  = null;
  let cadence     = null;

  if (targetType === 'Power') {
    modelTarget = TARGET_TYPES.POWER;
    const loW = num(el, 'Low > Watts') ?? num(el, 'PowerLow') ?? 0;
    const hiW = num(el, 'High > Watts') ?? num(el, 'PowerHigh') ?? loW;
    const ftp = fallbackFtp || 200;
    targetLow  = Math.round((loW / ftp) * 1000) / 1000;
    targetHigh = hiW !== loW ? Math.round((hiW / ftp) * 1000) / 1000 : null;
  } else if (targetType === 'Cadence') {
    modelTarget = TARGET_TYPES.NONE;
    cadence = num(el, 'Low') ?? null;
  }

  return createStep({
    type:          stepType,
    duration,
    targetType:    modelTarget,
    targetLow,
    targetHigh,
    cadenceTarget: cadence,
    name,
  });
}

// ─── Parse ────────────────────────────────────────────────────────────────────

function parse(text_) {
  const parser   = new DOMParser();
  const doc      = parser.parseFromString(text_, 'application/xml');

  const workoutEl = doc.querySelector('Workout');
  if (!workoutEl) throw new Error('[tcx] No <Workout> element found');

  const name        = workoutEl.querySelector('Name')?.textContent?.trim() ?? 'Imported TCX';
  const description = workoutEl.querySelector('Description')?.textContent?.trim() ?? '';
  const ftpEl       = workoutEl.querySelector('OverridingFTP');
  const ftp         = ftpEl ? parseFloat(ftpEl.textContent) || null : null;

  const stepEls = Array.from(workoutEl.querySelectorAll(':scope > Step'));
  const steps   = stepEls.map(el => parseStep(el, ftp ?? 200));

  return createWorkout({
    name, description,
    sourceFormat: 'tcx',
    steps,
    suggestedFtp: ftp,
  });
}

// ─── Write ────────────────────────────────────────────────────────────────────

function writeStep(step, ftp, idx) {
  if (step.type === STEP_TYPES.INTERVAL && step.repeat && step.onStep && step.offStep) {
    const onXml  = writeStep(step.onStep,  ftp, idx * 100);
    const offXml = writeStep(step.offStep, ftp, idx * 100 + 1);
    return `
    <Step xsi:type="Repeat_t">
      <Repetitions>${step.repeat}</Repetitions>
      <Child><Step>${onXml}</Step></Child>
      <Child><Step>${offXml}</Step></Child>
    </Step>`;
  }

  const intensityMap = {
    [STEP_TYPES.WARMUP]:   'Active',
    [STEP_TYPES.COOLDOWN]: 'Active',
    [STEP_TYPES.REST]:     'Resting',
    [STEP_TYPES.STEADY]:   'Active',
    [STEP_TYPES.RAMP]:     'Active',
    [STEP_TYPES.FREE_RIDE]:'Active',
  };
  const intensity = intensityMap[step.type] ?? 'Active';
  const dur       = Math.round(step.duration ?? 60);

  let targetXml = '<TargetType>None</TargetType>';
  if (step.targetType === TARGET_TYPES.POWER) {
    const loW = Math.round((step.targetLow  ?? 0) * ftp);
    const hiW = Math.round((step.targetHigh ?? step.targetLow ?? 0) * ftp);
    targetXml = `
        <TargetType>Power</TargetType>
        <Low><Watts>${loW}</Watts></Low>
        <High><Watts>${hiW || loW}</Watts></High>`;
  } else if (step.cadenceTarget) {
    targetXml = `
        <TargetType>Cadence</TargetType>
        <Low>${step.cadenceTarget}</Low>
        <High>${step.cadenceTarget}</High>`;
  }

  return `
    <Step xsi:type="Step_t">
      <StepId>${idx + 1}</StepId>
      <Name>${esc(step.name || STEP_TYPES[step.type] || '')}</Name>
      <DurationType>Time</DurationType>
      <DurationValue>${fmtDurationISO(dur)}</DurationValue>
      <Intensity>${intensity}</Intensity>
      ${targetXml}
    </Step>`;
}

function write(model) {
  const ftp   = model.suggestedFtp ?? 200;
  const steps = model.steps.map((s, i) => writeStep(s, ftp, i)).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase
  xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2
    http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Workouts>
    <Workout Sport="Biking">
      <Name>${esc(model.name)}</Name>
      <Description>${esc(model.description ?? '')}</Description>
      ${model.suggestedFtp ? `<OverridingFTP>${model.suggestedFtp}</OverridingFTP>` : ''}
      ${steps}
      <ScheduledOn/>
    </Workout>
  </Workouts>
</TrainingCenterDatabase>`;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const EXTENSIONS = ['.tcx'];
export const MIME_TYPES  = ['application/vnd.garmin.tcx+xml', 'application/xml', 'text/xml'];
export { parse, write };

registry.register('tcx', { parse, write, EXTENSIONS, MIME_TYPES });

export default { parse, write, EXTENSIONS, MIME_TYPES };
