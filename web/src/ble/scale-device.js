// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/scale-device.js
 *
 * Wraps a Bluetooth SIG-compliant smart scale — the Body Composition
 * Service (0x181B) when available, falling back to the plain Weight Scale
 * Service (0x181D) for weight-only scales that don't expose composition
 * data. See DIET_PANEL_DESIGN.md §7.
 *
 * Same connect(onData)/disconnect() shape as hr-device.js (the closest
 * analogue — one service, one notifying characteristic, no control point),
 * NOT wired into ble/device-manager.js's live-session merge or
 * ble/roles.js's role set — a scale isn't a continuous-stream session
 * sensor, it produces one measurement per weigh-in. app.js gives it its
 * own "Sync Scale" pairing entry point in Settings → Profile instead
 * (see connectSmartScale() there), same as this file's sibling
 * ble/fitdays-device.js.
 *
 * CAVEAT (flagged in the design doc, worth repeating here): a lot of
 * consumer scales — Renpho, Eufy, the actual Fitdays unit this project
 * captured — don't implement this standard service at all and require
 * reverse-engineered proprietary GATT instead (see ble/fitdays-device.js).
 * This class covers the subset of scales that *are* SIG-compliant; it has
 * not been exercised against real hardware in this project for that
 * reason — the parsing below is transcribed carefully from the GATT
 * Specification Supplement (see ble/scale-constants.js's header) but
 * should be treated as unconfirmed until it's actually met a compliant
 * scale, the same "confirmed via X" vs. speculative distinction
 * merach-device.js draws throughout its own comments.
 *
 * Usage:
 *   const scale = new ScaleDevice();
 *   await scale.connect(reading => { ... }); // reading: see _parseBodyComposition()/_parseWeightScale() below
 *   scale.disconnect();
 */

import {
  BODY_COMPOSITION_SERVICE, BODY_COMPOSITION_MEASUREMENT, BODY_COMPOSITION_FLAGS,
  WEIGHT_SCALE_SERVICE, WEIGHT_MEASUREMENT, WEIGHT_SCALE_FLAGS,
  SI_MASS_RESOLUTION_KG, IMPERIAL_MASS_RESOLUTION_LB,
  SI_HEIGHT_RESOLUTION_M, IMPERIAL_HEIGHT_RESOLUTION_IN,
} from './scale-constants.js';
import { reconnect } from './reconnect.js';
import { bleTransport } from './transport/index.js';

const LB_TO_KG = 0.45359237;
const IN_TO_M  = 0.0254;

export class ScaleDevice extends EventTarget {
  constructor() {
    super();
    this.id = null;
    this.name = null;
    this._device = null;
    this._onData = null;
    /** Which service this particular unit turned out to implement — set
     *  once connect() resolves, purely informational (e.g. for a debug
     *  log or a "your scale only reports weight" hint in the UI). */
    this.serviceUsed = null; // 'body-composition' | 'weight-scale'
  }

  /** Opens the chooser and connects. */
  async connect(onData) {
    this._onData = onData;
    const device = await bleTransport.requestDevice({
      filters: [
        { services: [BODY_COMPOSITION_SERVICE] },
        { services: [WEIGHT_SCALE_SERVICE] },
      ],
      optionalServices: [BODY_COMPOSITION_SERVICE, WEIGHT_SCALE_SERVICE],
    });
    await this._connectDevice(device);
    reconnect.remember(device, 'scale');
  }

  /** Connect to a specific BluetoothDevice (used by reconnect.js auto-reconnect). */
  async connectDevice(device, onData) {
    if (onData) this._onData = onData;
    await this._connectDevice(device);
  }

  async _connectDevice(device) {
    this._device = device;
    this.id   = device.id;
    this.name = device.name ?? 'Smart Scale';

    device.addEventListener('gattserverdisconnected', () => {
      this.dispatchEvent(new CustomEvent('disconnected'));
    });

    const server = await device.gatt.connect();

    // Body Composition Service first — it's a strict superset of what
    // Weight Scale Service offers (weight is always present in both
    // payloads), so a scale that has it is never worth falling back away
    // from.
    let service = null;
    try {
      service = await server.getPrimaryService(BODY_COMPOSITION_SERVICE);
      this.serviceUsed = 'body-composition';
    } catch {
      service = await server.getPrimaryService(WEIGHT_SCALE_SERVICE);
      this.serviceUsed = 'weight-scale';
    }

    const charUuid = this.serviceUsed === 'body-composition'
      ? BODY_COMPOSITION_MEASUREMENT
      : WEIGHT_MEASUREMENT;
    const parse = this.serviceUsed === 'body-composition'
      ? _parseBodyComposition
      : _parseWeightScale;

    const char = await service.getCharacteristic(charUuid);
    char.addEventListener('characteristicvaluechanged', (e) => {
      const reading = parse(e.target.value);
      if (this._onData) this._onData(reading);
    });
    await char.startNotifications();

    console.info('[scale]', this.serviceUsed, 'connected:', this.name);
  }

  disconnect() {
    this._device?.gatt?.disconnect();
  }

  get isConnected() {
    return this._device?.gatt?.connected ?? false;
  }
}

// ─── Body Composition Measurement (0x2A9C) ─────────────────────────────────
// Field order after Flags is fixed by spec: Body Fat % (always present),
// then whichever optional fields their presence bits declare, strictly in
// the order Timestamp → User ID → BMR → Muscle % → Muscle Mass →
// Fat Free Mass → Soft Lean Mass → Body Water Mass → Impedance → Weight →
// Height. Every mass/length field shares the Flags' unit bit — there's no
// per-field unit choice — and everything is converted to canonical
// kg/kcal/unitless here so the rest of the app never sees a raw imperial
// count (same "convert only at the boundary" rule metrics/units.js's own
// doc comment states; this characteristic-parse boundary counts, same as
// a display boundary would).
function _parseBodyComposition(dv) {
  let offset = 0;
  const flags = dv.getUint16(offset, true); offset += 2;
  const imperial = !!(flags & BODY_COMPOSITION_FLAGS.IMPERIAL_UNITS);

  const massKg = (raw) => imperial
    ? raw * IMPERIAL_MASS_RESOLUTION_LB * LB_TO_KG
    : raw * SI_MASS_RESOLUTION_KG;
  const heightM = (raw) => imperial
    ? raw * IMPERIAL_HEIGHT_RESOLUTION_IN * IN_TO_M
    : raw * SI_HEIGHT_RESOLUTION_M;

  const bodyFatPct = dv.getUint16(offset, true) * 0.1; offset += 2;

  const reading = {
    weightKg: null, bodyFatPct, basalMetabolicRateKcal: null,
    musclePct: null, muscleMassKg: null, fatFreeMassKg: null,
    softLeanMassKg: null, bodyWaterKg: null, impedanceOhm: null, heightCm: null,
  };

  if (flags & BODY_COMPOSITION_FLAGS.TIMESTAMP) offset += 7; // year(2)+month+day+hour+min+sec — not surfaced, device clock isn't trusted over Date.now()
  if (flags & BODY_COMPOSITION_FLAGS.USER_ID) offset += 1;
  if (flags & BODY_COMPOSITION_FLAGS.BMR) {
    reading.basalMetabolicRateKcal = dv.getUint16(offset, true); offset += 2; // kcal/day, resolution 1 — no scaling
  }
  if (flags & BODY_COMPOSITION_FLAGS.MUSCLE_PCT) {
    reading.musclePct = dv.getUint16(offset, true) * 0.1; offset += 2;
  }
  if (flags & BODY_COMPOSITION_FLAGS.MUSCLE_MASS) {
    reading.muscleMassKg = massKg(dv.getUint16(offset, true)); offset += 2;
  }
  if (flags & BODY_COMPOSITION_FLAGS.FAT_FREE_MASS) {
    reading.fatFreeMassKg = massKg(dv.getUint16(offset, true)); offset += 2;
  }
  if (flags & BODY_COMPOSITION_FLAGS.SOFT_LEAN_MASS) {
    reading.softLeanMassKg = massKg(dv.getUint16(offset, true)); offset += 2;
  }
  if (flags & BODY_COMPOSITION_FLAGS.BODY_WATER_MASS) {
    reading.bodyWaterKg = massKg(dv.getUint16(offset, true)); offset += 2;
  }
  if (flags & BODY_COMPOSITION_FLAGS.IMPEDANCE) {
    reading.impedanceOhm = dv.getUint16(offset, true) * 0.1; offset += 2;
  }
  if (flags & BODY_COMPOSITION_FLAGS.WEIGHT) {
    reading.weightKg = massKg(dv.getUint16(offset, true)); offset += 2;
  }
  if (flags & BODY_COMPOSITION_FLAGS.HEIGHT) {
    reading.heightCm = heightM(dv.getUint16(offset, true)) * 100; offset += 2;
  }

  return reading;
}

// ─── Weight Scale Measurement (0x2A9D) — weight-only fallback ─────────────
function _parseWeightScale(dv) {
  let offset = 0;
  const flags = dv.getUint8(offset); offset += 1;
  const imperial = !!(flags & WEIGHT_SCALE_FLAGS.IMPERIAL_UNITS);

  const weightRaw = dv.getUint16(offset, true); offset += 2;
  const weightKg = imperial
    ? weightRaw * IMPERIAL_MASS_RESOLUTION_LB * LB_TO_KG
    : weightRaw * SI_MASS_RESOLUTION_KG;

  const reading = { weightKg, bodyFatPct: null, heightCm: null };

  if (flags & WEIGHT_SCALE_FLAGS.TIMESTAMP) offset += 7;
  if (flags & WEIGHT_SCALE_FLAGS.USER_ID) offset += 1;
  if (flags & WEIGHT_SCALE_FLAGS.BMI_AND_HEIGHT) {
    offset += 2; // BMI (0.1 resolution) — not surfaced, the app already computes its own BMI from weight/height where needed
    const heightRaw = dv.getUint16(offset, true); offset += 2;
    reading.heightCm = imperial
      ? heightRaw * IMPERIAL_HEIGHT_RESOLUTION_IN * IN_TO_M * 100
      : heightRaw * SI_HEIGHT_RESOLUTION_M * 100;
  }

  return reading;
}

export default ScaleDevice;
