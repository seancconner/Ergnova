// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * formats/pwx.js
 *
 * Parser and writer for TrainingPeaks PWX workout files (.pwx).
 *
 * PWX is an XML format. Workout files use a <workout> root with <segment>
 * children. Each segment has a <duration> (seconds) and a <pwr> (power)
 * target block. Power targets are expressed as absolute watts — this
 * parser normalises them to FTP fractions using suggestedFtp (or 200 as
 * the fallback) so they survive round-trips through the WorkoutModel.
 *
 * Supported segment types:
 *   Steady   — single <pwr><low> value (low === high, or only one present)
 *   Ramp     — <pwr><low> ≠ <pwr><high>
 *   Free     — no <pwr> block → FREE_RIDE
 *
 * PWX does not have a native "interval block" concept — intervals are just
 * repeated segments in the file. We import them as individual STEADY steps
 * rather than trying to collapse them back into an INTERVAL wrapper (the
 * round-trip would be lossy anyway since PWX doesn't express repeat counts).
 *
 * Warmup/cooldown are inferred from segment names matching /warm/i or /cool/i.
 *
 * Usage (auto-registered via format-registry):
 *   import './formats/pwx.js';
 *   const model = registry.parse(text, '.pwx');
 *   const xml   = registry.write(model, '.pwx');
 */

import {
  createWorkout, createStep, STEP_TYPES, TARGET_TYPES,
} from '../core/cardio-model.js';
import registry from './format-registry.js';

// ─── XML helpers ──────────────────────────────────────────────────────────────

function textContent(el, tag) {
  return el?.querySelector(tag)?.textContent?.trim() ?? null;
}

function numContent(el, tag, fallback = null) {
  const v = parseFloat(textContent(el, tag));
  return isNaN(v) ? fallback : v;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Parse ────────────────────────────────────────────────────────────────────

function parse(text) {
  // PWX uses DOMParser in browser; in Node tests we skip this format's
  // XML path (the smoke test exercises it via a pre-built string).
  const parser = new DOMParser();
  const doc    = parser.parseFromString(text, 'application/xml');

  const workoutEl = doc.querySelector('workout');
  if (!workoutEl) throw new Error('[pwx] No <workout> element found');

  // Metadata from <sportType> and any enclosing <workout> attributes
  const name    = textContent(workoutEl, 'title')       ?? 'Imported PWX';
  const desc    = textContent(workoutEl, 'description') ?? '';
  const ftpRaw  = numContent(workoutEl, 'ftp');
  const ftp     = ftpRaw > 0 ? ftpRaw : null;

  const segments = Array.from(workoutEl.querySelectorAll('segment'));
  if (segments.length === 0) throw new Error('[pwx] No <segment> elements found');

  const steps = segments.map(seg => _parseSegment(seg, ftp ?? 200));

  return createWorkout({ name, description: desc, sourceFormat: 'pwx', steps, suggestedFtp: ftp });
}

function _parseSegment(seg, ftp) {
  const duration  = Math.round(numContent(seg, 'duration') ?? 60);
  const segName   = textContent(seg, 'name') ?? '';

  // Infer step type from name
  let stepType = STEP_TYPES.STEADY;
  if (/warm/i.test(segName))   stepType = STEP_TYPES.WARMUP;
  if (/cool/i.test(segName))   stepType = STEP_TYPES.COOLDOWN;
  if (/rest|recov/i.test(segName)) stepType = STEP_TYPES.REST;

  const pwrEl = seg.querySelector('pwr');
  if (!pwrEl) {
    return createStep({ type: STEP_TYPES.FREE_RIDE, duration, name: segName, targetType: TARGET_TYPES.NONE });
  }

  // Power targets are absolute watts in PWX → convert to FTP fraction
  const loW = numContent(pwrEl, 'low')  ?? numContent(pwrEl, 'watts') ?? 0;
  const hiW = numContent(pwrEl, 'high') ?? loW;
  const lo  = Math.round((loW / ftp) * 1000) / 1000;
  const hi  = Math.round((hiW / ftp) * 1000) / 1000;

  const isRamp = Math.abs(hi - lo) > 0.005;
  if (isRamp) stepType = STEP_TYPES.RAMP;

  return createStep({
    type:       stepType,
    duration,
    targetType: TARGET_TYPES.POWER,
    targetLow:  lo,
    targetHigh: isRamp ? hi : null,
    name:       segName,
  });
}

// ─── Write ────────────────────────────────────────────────────────────────────

function write(model) {
  const ftp = model.suggestedFtp ?? 200;

  const segments = _flattenForExport(model).map((step, i) => {
    const loW = Math.round((step.targetLow  ?? 0.5) * ftp);
    const hiW = Math.round((step.targetHigh ?? step.targetLow ?? 0.5) * ftp);
    const isRamp = step.targetHigh != null && Math.abs(hiW - loW) > 1;

    const pwrXml = step.targetType === TARGET_TYPES.NONE
      ? ''
      : `\n      <pwr><low>${loW}</low>${isRamp ? `<high>${hiW}</high>` : ''}</pwr>`;

    return `  <segment>
    <name>${esc(step.name || _stepLabel(step.type, i + 1))}</name>
    <duration>${Math.round(step.duration ?? 60)}</duration>${pwrXml}
  </segment>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<pwx xmlns="http://www.trainingpeaks.com/PWX/1/0">
  <workout>
    <sportType>Bike</sportType>
    <title>${esc(model.name)}</title>
    <description>${esc(model.description ?? '')}</description>
    ${model.suggestedFtp ? `<ftp>${model.suggestedFtp}</ftp>` : ''}
${segments.join('\n')}
  </workout>
</pwx>`;
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

function _stepLabel(type, n) {
  const labels = {
    [STEP_TYPES.WARMUP]: 'Warm-up', [STEP_TYPES.COOLDOWN]: 'Cooldown',
    [STEP_TYPES.STEADY]: 'Steady',  [STEP_TYPES.RAMP]: 'Ramp',
    [STEP_TYPES.REST]: 'Rest',      [STEP_TYPES.FREE_RIDE]: 'Free Ride',
  };
  return `${labels[type] ?? 'Step'} ${n}`;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const EXTENSIONS = ['.pwx'];
export const MIME_TYPES  = ['application/xml', 'text/xml'];
export { parse, write };

registry.register('pwx', { parse, write, EXTENSIONS, MIME_TYPES });

export default { parse, write, EXTENSIONS, MIME_TYPES };
