// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * formats/zwo.js
 *
 * Parser and writer for Zwift .ZWO workout files (XML).
 *
 * Supported block types:
 *   Warmup, Cooldown, SteadyState, Ramp, FreeRide, IntervalsT
 *
 * Power targets are expressed as FTP fractions (0.0–2.0) in ZWO files,
 * which maps directly to WorkoutModel's targetLow/targetHigh.
 *
 * Slope-based ZWO workouts (grade targets) use the "slope" attribute
 * instead of "Power" — handled transparently.
 */

import { createWorkout, createStep, STEP_TYPES, TARGET_TYPES } from '../core/cardio-model.js';
import registry from './format-registry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function attr(el, name, fallback = null) {
  const v = el.getAttribute(name);
  return v !== null ? parseFloat(v) : fallback;
}

function strAttr(el, name, fallback = '') {
  return el.getAttribute(name) ?? fallback;
}

/** Map a ZWO element tag to a WorkoutModel step type. */
function tagToType(tag) {
  switch (tag.toLowerCase()) {
    case 'warmup':      return STEP_TYPES.WARMUP;
    case 'cooldown':    return STEP_TYPES.COOLDOWN;
    case 'steadystate': return STEP_TYPES.STEADY;
    case 'ramp':        return STEP_TYPES.RAMP;
    case 'freeride':    return STEP_TYPES.FREE_RIDE;
    case 'intervalst':  return STEP_TYPES.INTERVAL;
    default:            return STEP_TYPES.STEADY;
  }
}

function stepTypeToTag(type) {
  switch (type) {
    case STEP_TYPES.WARMUP:    return 'Warmup';
    case STEP_TYPES.COOLDOWN:  return 'Cooldown';
    case STEP_TYPES.STEADY:    return 'SteadyState';
    case STEP_TYPES.RAMP:      return 'Ramp';
    case STEP_TYPES.FREE_RIDE: return 'FreeRide';
    case STEP_TYPES.INTERVAL:  return 'IntervalsT';
    default:                   return 'SteadyState';
  }
}

// ─── Parse ────────────────────────────────────────────────────────────────────

function parseElement(el) {
  const tag  = el.tagName;
  const type = tagToType(tag);

  // Determine target type: slope if 'grade' attr present, else power
  const hasGrade = el.hasAttribute('grade');
  const targetType = hasGrade ? TARGET_TYPES.SLOPE : TARGET_TYPES.POWER;

  if (type === STEP_TYPES.INTERVAL) {
    // IntervalsT: Repeat, OnDuration, OffDuration, PowerOnHigh/Low, PowerOffHigh/Low
    const repeat     = Math.round(attr(el, 'Repeat', 1));
    const onDuration = Math.round(attr(el, 'OnDuration', 60));
    const offDuration= Math.round(attr(el, 'OffDuration', 60));

    const onHigh  = attr(el, 'PowerOnHigh',  attr(el, 'PowerOnLow', 1.0));
    const onLow   = attr(el, 'PowerOnLow',   onHigh);
    const offHigh = attr(el, 'PowerOffHigh', attr(el, 'PowerOffLow', 0.5));
    const offLow  = attr(el, 'PowerOffLow',  offHigh);

    const onStep  = createStep({ type: STEP_TYPES.STEADY, duration: onDuration,  targetType, targetLow: onLow,  targetHigh: onLow  === onHigh  ? null : onHigh  });
    const offStep = createStep({ type: STEP_TYPES.REST,   duration: offDuration, targetType, targetLow: offLow, targetHigh: offLow === offHigh ? null : offHigh });

    return createStep({ type, targetType, repeat, onStep, offStep,
      duration: (onDuration + offDuration) * repeat });
  }

  const duration = Math.round(attr(el, 'Duration', 60));
  const cadence  = attr(el, 'Cadence', null);

  if (type === STEP_TYPES.FREE_RIDE) {
    return createStep({ type, duration, targetType: TARGET_TYPES.NONE,
      cadenceTarget: cadence });
  }

  // Warmup / Cooldown / Ramp: PowerLow + PowerHigh define the ramp range
  // SteadyState: Power (single value)
  let targetLow, targetHigh;

  if (hasGrade) {
    targetLow  = attr(el, 'grade', 0);
    targetHigh = attr(el, 'gradeEnd', targetLow);
  } else if (type === STEP_TYPES.STEADY) {
    targetLow  = attr(el, 'Power', 1.0);
    targetHigh = null;
  } else {
    targetLow  = attr(el, 'PowerLow',  0.5);
    targetHigh = attr(el, 'PowerHigh', 1.0);
  }

  return createStep({ type, duration, targetType, targetLow, targetHigh,
    cadenceTarget: cadence });
}

function parse(text) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(text, 'application/xml');

  const workoutEl = doc.querySelector('workout_file');
  if (!workoutEl) throw new Error('[zwo] Missing <workout_file> root element');

  const name        = doc.querySelector('name')?.textContent?.trim()        ?? 'Imported ZWO';
  const description = doc.querySelector('description')?.textContent?.trim() ?? '';
  const ftp         = parseFloat(doc.querySelector('ftpoverride')?.textContent ?? '0') || null;

  const workoutBody = doc.querySelector('workout');
  if (!workoutBody) throw new Error('[zwo] Missing <workout> element');

  const steps = [];
  for (const child of workoutBody.children) {
    try {
      steps.push(parseElement(child));
    } catch (e) {
      console.warn('[zwo] Skipped element:', child.tagName, e.message);
    }
  }

  return createWorkout({ name, description, sourceFormat: 'zwo',
    steps, suggestedFtp: ftp });
}

// ─── Write ────────────────────────────────────────────────────────────────────

function writeStep(step) {
  const tag = stepTypeToTag(step.type);

  if (step.type === STEP_TYPES.INTERVAL) {
    const on  = step.onStep;
    const off = step.offStep;
    return [
      `    <IntervalsT Repeat="${step.repeat ?? 1}"`,
      `      OnDuration="${on?.duration ?? 60}" OffDuration="${off?.duration ?? 60}"`,
      `      PowerOnLow="${(on?.targetLow  ?? 1.0).toFixed(3)}"`,
      `      PowerOnHigh="${(on?.targetHigh ?? on?.targetLow ?? 1.0).toFixed(3)}"`,
      `      PowerOffLow="${(off?.targetLow  ?? 0.5).toFixed(3)}"`,
      `      PowerOffHigh="${(off?.targetHigh ?? off?.targetLow ?? 0.5).toFixed(3)}" />`,
    ].join('\n');
  }

  if (step.type === STEP_TYPES.FREE_RIDE) {
    const cadAttr = step.cadenceTarget ? ` Cadence="${step.cadenceTarget}"` : '';
    return `    <FreeRide Duration="${step.duration}"${cadAttr} />`;
  }

  const isSlope  = step.targetType === TARGET_TYPES.SLOPE;
  const isSteady = step.type === STEP_TYPES.STEADY;
  const cadAttr  = step.cadenceTarget ? ` Cadence="${step.cadenceTarget}"` : '';

  if (isSlope) {
    const gradeEnd = step.targetHigh !== null ? ` gradeEnd="${step.targetHigh?.toFixed(2)}"` : '';
    return `    <${tag} Duration="${step.duration}" grade="${step.targetLow?.toFixed(2)}"${gradeEnd}${cadAttr} />`;
  }

  if (isSteady) {
    return `    <SteadyState Duration="${step.duration}" Power="${(step.targetLow ?? 1.0).toFixed(3)}"${cadAttr} />`;
  }

  // Warmup, Cooldown, Ramp
  return [
    `    <${tag} Duration="${step.duration}"`,
    `      PowerLow="${(step.targetLow  ?? 0.5).toFixed(3)}"`,
    `      PowerHigh="${(step.targetHigh ?? 1.0).toFixed(3)}"${cadAttr} />`,
  ].join('\n');
}

function write(model) {
  const ftpLine = model.suggestedFtp
    ? `  <ftpoverride>${model.suggestedFtp}</ftpoverride>\n` : '';

  const stepsXml = model.steps.map(writeStep).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<workout_file>',
    `  <name>${model.name}</name>`,
    `  <description>${model.description ?? ''}</description>`,
    `  <sportType>bike</sportType>`,
    ftpLine.trimEnd(),
    '  <workout>',
    stepsXml,
    '  </workout>',
    '</workout_file>',
  ].filter(Boolean).join('\n');
}

// ─── Export & register ────────────────────────────────────────────────────────

export const EXTENSIONS = ['.zwo'];
export const MIME_TYPES = ['application/xml', 'text/xml'];
export { parse, write };

registry.register('zwo', { parse, write, EXTENSIONS, MIME_TYPES });

export default { parse, write, EXTENSIONS, MIME_TYPES };
