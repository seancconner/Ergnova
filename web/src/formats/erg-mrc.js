// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * formats/erg-mrc.js
 *
 * Parser and writer for legacy ERG and MRC plain-text trainer workout files.
 *
 * ERG format (.erg):
 *   [COURSE HEADER] section with metadata (name, description, FTP)
 *   [COURSE DATA] section: time(min)  watts pairs, one per line
 *
 * MRC format (.mrc):
 *   Identical structure but [COURSE DATA] values are % of FTP (0–100)
 *   rather than absolute watts.
 *
 * Both are converted to a WorkoutModel with STEADY steps (one per data point,
 * or merged when consecutive points share the same target).
 *
 * Usage (via registry):
 *   import { registry } from './format-registry.js';
 *   // already registered below — just import this file once at startup
 *   const model = registry.parse(text, '.erg');
 */

import {
  createWorkout, createStep, STEP_TYPES, TARGET_TYPES
} from '../core/cardio-model.js';
import registry from './format-registry.js';

// ─── Parse ────────────────────────────────────────────────────────────────────

function parse(text) {
  const lines = text.split(/\r?\n/);

  let section        = null;
  let name           = 'Imported ERG/MRC';
  let description    = '';
  let ftp            = null;
  let isPercentage   = false;  // MRC uses % FTP; ERG uses absolute watts
  const dataPoints   = [];     // { timeSec, value }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;

    // Section headers
    if (line.startsWith('[')) {
      const header = line.toLowerCase();
      if (header.includes('course header'))       section = 'header';
      else if (header.includes('course data'))    section = 'data';
      else if (header.includes('end course'))     section = null;
      else section = line;
      continue;
    }

    if (section === 'header') {
      const [key, ...rest] = line.split('=');
      const val = rest.join('=').trim();
      switch (key.trim().toUpperCase()) {
        case 'DESCRIPTION': name        = val || name;        break;
        case 'FILE NAME':   name        = val || name;        break;
        case 'WORKOUT NAME':name        = val || name;        break;
        case 'FTP':         ftp         = parseFloat(val);    break;
        case 'NOTES':       description = val;                break;
        case 'UNITS':
          // 'WATTS' for ERG; 'PERCENT' or '%FTP' for MRC
          isPercentage = val.toUpperCase().includes('PERCENT') || val.includes('%');
          break;
      }
    } else if (section === 'data') {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const timeSec = parseFloat(parts[0]) * 60; // minutes → seconds
      const value   = parseFloat(parts[1]);
      if (isNaN(timeSec) || isNaN(value)) continue;
      dataPoints.push({ timeSec, value });
    }
  }

  if (dataPoints.length === 0) {
    throw new Error('[erg-mrc] No data points found in file');
  }

  // Sort by time
  dataPoints.sort((a, b) => a.timeSec - b.timeSec);

  // Convert data points → steps
  // Each pair of consecutive data points defines a segment [t0, t1) with value v0.
  // If v0 === v1 → STEADY; otherwise → RAMP from v0 to v1.
  const steps = [];
  for (let i = 0; i < dataPoints.length - 1; i++) {
    const { timeSec: t0, value: v0 } = dataPoints[i];
    const { timeSec: t1, value: v1 } = dataPoints[i + 1];
    const duration = Math.round(t1 - t0);
    if (duration <= 0) continue;

    const isRamp = Math.abs(v1 - v0) > 0.5;
    const stepType = isRamp ? STEP_TYPES.RAMP : STEP_TYPES.STEADY;

    // Normalize values
    const normLow  = isPercentage ? v0 / 100 : (ftp ? v0 / ftp : v0 / 200);
    const normHigh = isPercentage ? v1 / 100 : (ftp ? v1 / ftp : v1 / 200);

    steps.push(createStep({
      type:       stepType,
      duration,
      targetType: TARGET_TYPES.POWER,
      targetLow:  Math.round(normLow  * 1000) / 1000,
      targetHigh: isRamp ? Math.round(normHigh * 1000) / 1000 : null,
    }));
  }

  return createWorkout({
    name,
    description,
    sourceFormat: isPercentage ? 'mrc' : 'erg',
    steps,
    suggestedFtp: ftp,
  });
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Serialize a WorkoutModel to ERG format (absolute watts with placeholder FTP 200).
 * MRC is not separately written — ERG is the more interoperable choice.
 *
 * @param {WorkoutModel} model
 * @returns {string}
 */
function write(model) {
  const ftp = model.suggestedFtp ?? 200;
  const lines = [
    '[COURSE HEADER]',
    `VERSION = 2`,
    `UNITS = WATTS`,
    `DESCRIPTION = ${model.name}`,
    `FILE NAME = ${model.name}`,
    `FTP = ${ftp}`,
    `MINUTES WATTS`,
    '[END COURSE HEADER]',
    '',
    '[COURSE DATA]',
  ];

  let timeSec = 0;
  for (const step of _flattenForExport(model)) {
    const startMin = (timeSec / 60).toFixed(3);
    const endSec   = timeSec + (step.duration ?? 60);
    const endMin   = (endSec / 60).toFixed(3);

    const wattsLow  = Math.round((step.targetLow  ?? 0.5) * ftp);
    const wattsHigh = step.targetHigh != null
      ? Math.round(step.targetHigh * ftp)
      : wattsLow;

    lines.push(`${startMin}\t${wattsLow}`);
    lines.push(`${endMin}\t${wattsHigh}`);

    timeSec = endSec;
  }

  lines.push('[END COURSE DATA]');
  return lines.join('\n');
}

function _flattenForExport(model) {
  const out = [];
  for (const step of model.steps) {
    if (step.type === STEP_TYPES.INTERVAL && step.repeat && step.onStep && step.offStep) {
      for (let i = 0; i < step.repeat; i++) {
        out.push(step.onStep, step.offStep);
      }
    } else {
      out.push(step);
    }
  }
  return out;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const EXTENSIONS = ['.erg', '.mrc'];
export const MIME_TYPES  = ['text/plain'];
export { parse, write };

registry.register('erg',     { parse, write, EXTENSIONS, MIME_TYPES });
registry.register('mrc',     { parse, write, EXTENSIONS, MIME_TYPES });
registry.register('erg-mrc', { parse, write, EXTENSIONS, MIME_TYPES });

export default { parse, write, EXTENSIONS, MIME_TYPES };
