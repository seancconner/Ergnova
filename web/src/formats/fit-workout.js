// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * formats/fit-workout.js
 *
 * Parser and writer for FIT workout files (.fit with workout profile).
 * This is a DIFFERENT message profile from a FIT activity file —
 * it contains Workout and WorkoutStep messages, not Record/Session messages.
 *
 * Supported step types → WorkoutModel mapping:
 *   ACTIVE   → steady / interval / warmup / cooldown (depends on intensity)
 *   REST     → rest
 *   REPEAT   → interval wrapper
 *   COOLDOWN → cooldown
 *   WARMUP   → warmup
 *
 * Power targets in FIT workouts are stored as absolute watts OR as
 * % of FTP encoded as (pct * 1000) + 1000. This parser handles both.
 *
 * Usage (via registry):
 *   import { registry } from './format-registry.js';
 *   registry.register('fit-workout', fitWorkoutModule);
 *   const model = registry.parse(fileBytes, '.fit');
 */

import {
  createWorkout, createStep, STEP_TYPES, TARGET_TYPES
} from '../core/cardio-model.js';
import registry from './format-registry.js';

// ─── FIT constants ────────────────────────────────────────────────────────────

const FIT_EPOCH = 631065600000; // ms offset between FIT and Unix epochs

// Global message numbers relevant to workout files
const MESG = {
  FILE_ID:      0,
  WORKOUT:      26,
  WORKOUT_STEP: 27,
};

// Step duration types
const DURATION_TYPE = {
  0:  'time',           // seconds
  1:  'distance',       // meters
  2:  'hr_less_than',
  3:  'hr_greater_than',
  4:  'calories',
  5:  'open',           // no fixed end
  6:  'repeat_until_steps_cmplt',
  7:  'repeat_until_time',
  8:  'repeat_until_distance',
  9:  'repeat_until_calories',
  10: 'repeat_until_hr_less_than',
  11: 'repeat_until_hr_greater_than',
  12: 'repeat_until_power_less_than',
  13: 'repeat_until_power_greater_than',
};

// Step intensity → step type mapping
const INTENSITY = {
  0: STEP_TYPES.ACTIVE,   // active → treated as steady in the model
  1: STEP_TYPES.REST,
  2: STEP_TYPES.WARMUP,
  3: STEP_TYPES.COOLDOWN,
};

// Target types (FIT field 5)
const FIT_TARGET = {
  0: 'speed',
  1: 'heart_rate',
  2: 'open',
  3: 'cadence',
  4: 'power',
  5: 'grade',
  6: 'resistance',
};

// ─── FIT binary parser ────────────────────────────────────────────────────────

/**
 * Minimal FIT binary parser — only reads Workout and WorkoutStep messages.
 * Does not attempt to be a general-purpose FIT decoder.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ workout: Object, steps: Object[] }}
 */
function parseFitBinary(buffer) {
  const view  = new DataView(buffer);
  let offset  = 0;

  // ── Header ──
  const headerSize = view.getUint8(0);
  const dataSize   = view.getUint32(4, true);
  offset = headerSize;

  // Local message definitions: localNum → { globalNum, fields: [{num, size, type}] }
  const defs   = new Map();
  const result = { workout: null, steps: [] };

  while (offset < headerSize + dataSize) {
    const header = view.getUint8(offset++);

    const isCompressedTimestamp = (header & 0x80) !== 0;
    const isDefinition          = !isCompressedTimestamp && (header & 0x40) !== 0;
    const localNum              = isCompressedTimestamp ? (header >> 5) & 0x03 : (header & 0x0F);

    if (isDefinition) {
      // Definition message
      const reserved = view.getUint8(offset++);
      const arch     = view.getUint8(offset++); // 0 = LE, 1 = BE
      const le       = arch === 0;
      const globalNum = le ? view.getUint16(offset, true) : view.getUint16(offset);
      offset += 2;
      const fieldCount = view.getUint8(offset++);
      const fields = [];
      for (let i = 0; i < fieldCount; i++) {
        const num  = view.getUint8(offset++);
        const size = view.getUint8(offset++);
        const type = view.getUint8(offset++);
        fields.push({ num, size, type });
      }
      defs.set(localNum, { globalNum, fields, le });

    } else {
      // Data message
      const def = defs.get(localNum);
      if (!def) { offset++; continue; }

      const { globalNum, fields, le } = def;
      const msg = {};

      for (const f of fields) {
        let val;
        if (f.size === 1)      val = view.getUint8(offset);
        else if (f.size === 2) val = le ? view.getUint16(offset, true) : view.getUint16(offset);
        else if (f.size === 4) val = le ? view.getUint32(offset, true) : view.getUint32(offset);
        else {
          // String or larger — read as bytes
          val = Array.from(new Uint8Array(buffer, offset, f.size));
        }
        msg[f.num] = val;
        offset += f.size;
      }

      if (globalNum === MESG.WORKOUT) {
        result.workout = msg;
      } else if (globalNum === MESG.WORKOUT_STEP) {
        result.steps.push(msg);
      }
    }
  }

  return result;
}

// ─── FIT power target decoding ────────────────────────────────────────────────

/**
 * Decode a FIT power target value.
 * Values ≥ 1000 are FTP-relative: (value - 1000) / 1000 = FTP fraction.
 * Values < 1000 are absolute watts.
 *
 * @param {number} raw
 * @returns {{ isPercent: boolean, value: number }}
 */
function decodePowerTarget(raw) {
  if (raw == null || raw === 0xFFFF || raw === 0xFFFFFFFF) {
    return { isPercent: true, value: 0 };
  }
  if (raw >= 1000) {
    return { isPercent: true, value: (raw - 1000) / 1000 };
  }
  return { isPercent: false, value: raw };
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse a FIT workout file (as ArrayBuffer or Uint8Array) into a WorkoutModel.
 * The format-registry calls parse(text), but FIT is binary —
 * we accept both a string (base64-decoded via atob) and ArrayBuffer.
 *
 * @param {string|ArrayBuffer} input
 * @returns {WorkoutModel}
 */
function parse(input) {
  let buffer;
  if (typeof input === 'string') {
    // Assume raw binary string (from FileReader readAsBinaryString)
    buffer = new ArrayBuffer(input.length);
    const u8 = new Uint8Array(buffer);
    for (let i = 0; i < input.length; i++) u8[i] = input.charCodeAt(i) & 0xff;
  } else if (input instanceof Uint8Array) {
    buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  } else {
    buffer = input;
  }

  const { workout, steps } = parseFitBinary(buffer);

  // Workout name from field 8 (string array / byte array)
  let name = 'Imported FIT Workout';
  if (workout?.[8]) {
    try {
      name = String.fromCharCode(...(workout[8]).filter(b => b > 0)) || name;
    } catch { /* ignore */ }
  }

  const modelSteps = [];
  let   i = 0;

  while (i < steps.length) {
    const s = steps[i];

    // Field 5 = duration_type, field 6 = duration_value
    // Field 7 = target_type, field 8 = target_value_low, field 9 = target_value_high
    // Field 11 = intensity
    const durationType  = s[5] ?? 0;
    const durationVal   = s[6] ?? 0;
    const targetType    = s[7] ?? 2; // 2 = open
    const targetLowRaw  = s[8] ?? 0;
    const targetHighRaw = s[9] ?? 0;
    const intensity     = s[11] ?? 0;

    // Repeat step: duration_type 6–13 = repeat_until_*
    // FIT encodes repeats as a step with duration_type = 6 (steps_cmplt)
    // and duration_value = (steps_to_repeat + 1) << 16 | steps_back
    if (durationType === 6) {
      // This is a repeat marker — collect the previous N steps into an interval
      const stepsBack    = (durationVal & 0xFFFF);
      const repeatCount  = (durationVal >> 16) & 0xFFFF;
      const subSteps     = modelSteps.splice(modelSteps.length - stepsBack);

      // Simplification: treat first sub-step as ON, second as OFF
      const onStep  = subSteps[0] ?? createStep({ type: STEP_TYPES.STEADY, duration: 60 });
      const offStep = subSteps[1] ?? createStep({ type: STEP_TYPES.REST,   duration: 60 });

      modelSteps.push(createStep({
        type:     STEP_TYPES.INTERVAL,
        repeat:   repeatCount,
        onStep,
        offStep,
        duration: (onStep.duration + offStep.duration) * repeatCount,
        targetType: onStep.targetType,
      }));
      i++;
      continue;
    }

    const duration = durationType === 0 ? durationVal : 60; // fallback for non-time durations
    const stepType = INTENSITY[intensity] ?? STEP_TYPES.STEADY;

    let modelTargetType = TARGET_TYPES.NONE;
    let targetLow = 0, targetHigh = null;

    const fitTargetKey = FIT_TARGET[targetType];
    if (fitTargetKey === 'power') {
      modelTargetType = TARGET_TYPES.POWER;
      const lo = decodePowerTarget(targetLowRaw);
      const hi = decodePowerTarget(targetHighRaw);
      // Normalise: if absolute watts, convert to FTP fraction with placeholder FTP=200
      targetLow  = lo.isPercent ? lo.value : lo.value / 200;
      targetHigh = hi.isPercent ? hi.value : hi.value / 200;
      if (targetHigh === targetLow) targetHigh = null;
    } else if (fitTargetKey === 'grade') {
      modelTargetType = TARGET_TYPES.SLOPE;
      targetLow  = targetLowRaw  / 100;
      targetHigh = targetHighRaw / 100;
      if (targetHigh === targetLow) targetHigh = null;
    } else if (fitTargetKey === 'resistance') {
      modelTargetType = TARGET_TYPES.RESISTANCE;
      targetLow  = targetLowRaw;
      targetHigh = targetHighRaw !== targetLowRaw ? targetHighRaw : null;
    }

    modelSteps.push(createStep({
      type:       stepType,
      duration,
      targetType: modelTargetType,
      targetLow,
      targetHigh,
    }));
    i++;
  }

  return createWorkout({ name, sourceFormat: 'fit-workout', steps: modelSteps });
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Serialize a WorkoutModel to a FIT workout binary.
 * Returns a Uint8Array.
 *
 * Power targets expressed as FTP fractions are stored as
 * pct * 1000 + 1000 per the FIT spec.
 *
 * @param {WorkoutModel} model
 * @returns {Uint8Array}
 */
function write(model) {
  // Use the same FitWriter from fit-activity (reimplemented inline for isolation)
  const chunks = [];
  let totalSize = 0;

  function push(bytes) { chunks.push(bytes); totalSize += bytes.length; }
  function u8(v)  { push(new Uint8Array([v & 0xFF])); }
  function u16(v) { const b=new Uint8Array(2); new DataView(b.buffer).setUint16(0,v,true); push(b); }
  function u32(v) { const b=new Uint8Array(4); new DataView(b.buffer).setUint32(0,v,true); push(b); }
  function str(s, len) {
    const b = new Uint8Array(len).fill(0);
    for (let i = 0; i < Math.min(s.length, len - 1); i++) b[i] = s.charCodeAt(i) & 0x7F;
    push(b);
  }
  function assemble() {
    const out = new Uint8Array(totalSize);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // Definition helper
  function def(localNum, globalNum, fields) {
    u8(0x40 | localNum);
    u8(0); u8(0); u16(globalNum); u8(fields.length);
    for (const [n, sz, t] of fields) { u8(n); u8(sz); u8(t); }
  }
  function dh(localNum) { u8(localNum & 0x0F); }

  // CRC
  const CRC_TABLE = (() => {
    const t = new Uint16Array(16);
    for (let i=0;i<16;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB8^(c>>>1)):(c>>>1);t[i]=c;}
    return t;
  })();
  function crc(data) {
    let c=0;
    for(const b of data){c=(CRC_TABLE[(c&0xF)^(b&0xF)]^(c>>>4));c=(CRC_TABLE[(c&0xF)^(b>>>4)]^(c>>>4));}
    return c&0xFFFF;
  }

  // Flatten intervals back out
  const flatSteps = [];
  for (const step of model.steps) {
    if (step.type === STEP_TYPES.INTERVAL && step.repeat && step.onStep && step.offStep) {
      for (let r = 0; r < step.repeat; r++) {
        flatSteps.push(step.onStep);
        flatSteps.push(step.offStep);
      }
      // Repeat marker (simplified — no FIT repeat_steps encoding for now)
    } else {
      flatSteps.push(step);
    }
  }

  // ── File ID (local 0, global 0) ───────────────────────────────────────────
  def(0, 0, [[0,1,0x00],[1,2,0x84],[2,2,0x84],[4,4,0x86]]);
  dh(0); u8(5); u16(255); u16(0); u32(Math.round(Date.now()/1000) - 631065600);

  // ── Workout (local 1, global 26) ──────────────────────────────────────────
  def(1, 26, [[4,16,0x07],[6,2,0x84],[8,1,0x00]]);
  dh(1);
  str(model.name || 'Ergnova Workout', 16);
  u16(flatSteps.length);
  u8(2); // sport: cycling

  // ── WorkoutStep (local 2, global 27) ─────────────────────────────────────
  def(2, 27, [
    [0,4,0x86], // step_name (index)
    [2,4,0x86], // duration_value
    [4,4,0x86], // target_value (low)
    [5,4,0x86], // target_value_high
    [3,1,0x00], // intensity
    [1,1,0x00], // duration_type
    [6,1,0x00], // target_type
  ]);

  for (let idx = 0; idx < flatSteps.length; idx++) {
    const step = flatSteps[idx];
    dh(2);
    u32(idx); // step name index

    // Duration
    u32(step.duration ?? 60); // type = time (0)

    // Power target encoding
    let targetLowOut = 0, targetHighOut = 0, fitTargetType = 2; // 2 = open
    if (step.targetType === TARGET_TYPES.POWER) {
      fitTargetType = 4;
      targetLowOut  = Math.round((step.targetLow  ?? 0) * 1000) + 1000;
      targetHighOut = step.targetHigh
        ? Math.round(step.targetHigh * 1000) + 1000
        : targetLowOut;
    } else if (step.targetType === TARGET_TYPES.SLOPE) {
      fitTargetType = 5;
      targetLowOut  = Math.round((step.targetLow  ?? 0) * 100);
      targetHighOut = Math.round((step.targetHigh ?? step.targetLow ?? 0) * 100);
    } else if (step.targetType === TARGET_TYPES.RESISTANCE) {
      fitTargetType = 6;
      targetLowOut  = Math.round(step.targetLow  ?? 0);
      targetHighOut = Math.round(step.targetHigh ?? step.targetLow ?? 0);
    }

    u32(targetLowOut);
    u32(targetHighOut);

    // Intensity
    const intensityMap = {
      [STEP_TYPES.WARMUP]:  2,
      [STEP_TYPES.COOLDOWN]:3,
      [STEP_TYPES.REST]:    1,
    };
    u8(intensityMap[step.type] ?? 0);
    u8(0); // duration_type = time
    u8(fitTargetType);
  }

  // ── Assemble with header + CRC ────────────────────────────────────────────
  const dataBytes = assemble();
  const dataLen   = dataBytes.length;

  const header = new Uint8Array(14);
  header[0]=14; header[1]=16; header[2]=7; header[3]=1;
  header[4]=0x2E; header[5]=0x46; header[6]=0x49; header[7]=0x54;
  header[8]=dataLen&0xFF; header[9]=(dataLen>>8)&0xFF;
  header[10]=(dataLen>>16)&0xFF; header[11]=(dataLen>>24)&0xFF;
  const hCrc=crc(header.slice(0,12));
  header[12]=hCrc&0xFF; header[13]=(hCrc>>8)&0xFF;

  const combined = new Uint8Array(header.length + dataBytes.length);
  combined.set(header,0); combined.set(dataBytes,header.length);
  const fCrc = crc(combined);
  const out = new Uint8Array(combined.length + 2);
  out.set(combined,0);
  out[out.length-2]=fCrc&0xFF; out[out.length-1]=(fCrc>>8)&0xFF;
  return out;
}

// ─── Registry entry ───────────────────────────────────────────────────────────

export const EXTENSIONS = ['.fit'];
export const MIME_TYPES  = ['application/octet-stream', 'application/vnd.ant.fit'];
export { parse, write };

registry.register('fit-workout', { parse, write, EXTENSIONS, MIME_TYPES });

export default { parse, write, EXTENSIONS, MIME_TYPES };
