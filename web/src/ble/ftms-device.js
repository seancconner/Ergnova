// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

import { FTMS_SERVICE, CHAR, OP, RESULT, MACHINE_TYPE } from './ftms-constants.js';
import { roles, ROLES } from './roles.js';
import { reconnect } from './reconnect.js';
import { bleTransport } from './transport/index.js';

/**
 * Wraps a single FTMS-capable device (indoor bike trainer, smart rower, or
 * cross trainer/elliptical). Machine type is auto-detected from which data
 * characteristic the device exposes, so the rest of the app can stay
 * machine-agnostic and just read `device.machineType` + `device.metrics`.
 *
 * Same connect(onData) / connectDevice(device, onData) shape as the other
 * ble/*-device.js wrappers (moxy.js, core-temp.js, merach-device.js), so it
 * plugs into ble/reconnect.js auto-reconnect and registers ble/roles.js
 * roles on connect/disconnect like the rest of the fleet.
 *
 * Method names / range properties (setErgTarget, setResistanceTarget,
 * powerRange, resistanceRange, setSimulationGrade) match the device
 * interface control/mode-switch.js duck-types against — see that file's
 * capability-detection docs. powerRange/resistanceRange come from FTMS's
 * optional Supported Power Range (0x2AD8) / Supported Resistance Level
 * Range (0x2AD6) characteristics, read once at connect time; either can end
 * up null on a trainer that doesn't expose it, in which case mode-switch.js
 * simply won't offer the mode that needs it — same graceful-degradation
 * path a resistance-only device (e.g. ble/merach-device.js) already takes.
 */
export class FtmsDevice extends EventTarget {
  constructor() {
    super();
    this.id = null;
    this.name = null;
    this.gattServer = null;
    this.service = null;
    this.controlPoint = null;
    this.machineType = null;
    this.dataChar = null;
    this.metrics = { power: null, cadence: null, speed: null, heartRate: null, strokeRate: null, distance: null, elapsed: 0 };
    this.powerRange = null;      // { min, max, step } in watts, or null if unsupported — see _readRange()
    this.resistanceRange = null; // { min, max, step } in the same units setResistanceTarget() writes
    this._controlRequested = false;
    this._pendingOp = null; // resolves the indication for the last written op
    this._onData = null;

    // Many trainers derive power/speed from the time between crank-magnet
    // pulses, and briefly report 0 whenever that gap exceeds their own
    // "still pedaling" timeout — typically noticeable below ~60-70rpm, as a
    // flicker to 0 and back every couple of seconds even though the rider
    // never stopped. We hold the last non-zero reading for a short window so
    // a single dropped notification doesn't flash zero in the UI/recording;
    // a genuine stop still reads 0 once the hold window elapses.
    this._lastNonZeroAt = { power: 0, speed: 0 };
    this._zeroHoldMs = 6000;
  }

  /**
   * Open the BLE chooser, connect, and remember the device for auto-reconnect.
   * @param {Function} [onData]  Receives `this.metrics` on each notification.
   */
  async connect(onData) {
    if (onData) this._onData = onData;

    const device = await bleTransport.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }],
      optionalServices: [0x180d] // heart rate, in case the same device also reports it
    });

    await this._connectDevice(device);
    reconnect.remember(device, 'trainer');
    return this;
  }

  /**
   * Connect to a specific, already-granted BluetoothDevice — used by
   * ble/reconnect.js auto-reconnect (no chooser dialog).
   * @param {BluetoothDevice} device
   * @param {Function} [onData]
   */
  async connectDevice(device, onData) {
    if (onData) this._onData = onData;
    await this._connectDevice(device);
    return this;
  }

  async _connectDevice(device) {
    this.id = device.id;
    this.name = device.name ?? 'Trainer';

    device.addEventListener('gattserverdisconnected', () => this._onDisconnect());

    this.gattServer = await device.gatt.connect();
    this.service = await this.gattServer.getPrimaryService(FTMS_SERVICE);
    this.controlPoint = await this.service.getCharacteristic(CHAR.CONTROL_POINT);

    await this._subscribe(this.controlPoint, (dv) => this._handleControlPointIndication(dv));
    await this._detectMachineTypeAndSubscribeData();

    // Optional FTMS characteristics — not every trainer exposes these, so a
    // missing one just leaves the corresponding range null rather than
    // failing the connection. See _readRange().
    this.powerRange      = await this._readRange(CHAR.POWER_RANGE, 1);
    this.resistanceRange = await this._readRange(CHAR.RESISTANCE_RANGE, 10);

    roles.register(this.id, this._roleList());
    this.dispatchEvent(new CustomEvent('connected', { detail: { machineType: this.machineType } }));
  }

  /**
   * Read one of FTMS's optional "Supported X Range" characteristics
   * (min/max/step, all sint16/uint16) and scale it into real-world units.
   * Returns null if the device doesn't expose the characteristic at all —
   * callers (and control/mode-switch.js's capability detection) treat that
   * the same as "this mode isn't available on this device".
   * @param {number} uuid   CHAR.POWER_RANGE or CHAR.RESISTANCE_RANGE
   * @param {number} scale  Raw units per real unit (10 for 0.1-resolution
   *                        resistance, 1 for whole-watt power)
   * @returns {Promise<{min:number,max:number,step:number}|null>}
   */
  async _readRange(uuid, scale) {
    try {
      const char = await this.service.getCharacteristic(uuid);
      const dv   = await char.readValue();
      return {
        min:  dv.getInt16(0, true) / scale,
        max:  dv.getInt16(2, true) / scale,
        step: dv.getUint16(4, true) / scale,
      };
    } catch {
      return null; // characteristic not present on this trainer
    }
  }

  /** Roles this device fills, based on which FTMS machine type it turned out to be. */
  _roleList() {
    const list = [ROLES.CONTROLLABLE_TRAINER, ROLES.POWER_SOURCE];
    if (this.machineType === MACHINE_TYPE.BIKE) {
      list.push(ROLES.CADENCE_SOURCE, ROLES.SPEED_SOURCE);
    } else if (this.machineType === MACHINE_TYPE.CROSS_TRAINER) {
      list.push(ROLES.SPEED_SOURCE);
    }
    // ROWER reports strokeRate (see parseRowerData below), not the generic
    // `cadence` metric roles.js knows about, so no CADENCE_SOURCE there.
    return list;
  }

  _onDisconnect() {
    if (this.id) roles.unregister(this.id);
    this.dispatchEvent(new CustomEvent('disconnected'));
  }

  async _detectMachineTypeAndSubscribeData() {
    const tryChar = async (uuid, type, parser) => {
      try {
        const char = await this.service.getCharacteristic(uuid);
        this.dataChar = char;
        this.machineType = type;
        await this._subscribe(char, (dv) => {
          const parsed = parser(dv);
          this._applyZeroHold(parsed);
          Object.assign(this.metrics, parsed);
          this._onData?.(this.metrics);
          this.dispatchEvent(new CustomEvent('data', { detail: this.metrics }));
        });
        return true;
      } catch {
        return false;
      }
    };

    if (await tryChar(CHAR.INDOOR_BIKE_DATA, MACHINE_TYPE.BIKE, parseIndoorBikeData)) return;
    if (await tryChar(CHAR.ROWER_DATA, MACHINE_TYPE.ROWER, parseRowerData)) return;
    if (await tryChar(CHAR.CROSS_TRAINER_DATA, MACHINE_TYPE.CROSS_TRAINER, parseCrossTrainerData)) return;

    throw new Error('Device advertises FTMS but exposes no recognized data characteristic');
  }

  /**
   * Mutates `parsed` in place: if power or speed just read 0 but was
   * nonzero within the last `_zeroHoldMs`, re-substitute the last known
   * value instead of letting the dropout through. Fields the packet didn't
   * include at all (per its flag bits) are left untouched either way.
   */
  _applyZeroHold(parsed) {
    const now = Date.now();
    for (const key of ['power', 'speed']) {
      if (!(key in parsed)) continue;
      if (parsed[key] > 0) {
        this._lastNonZeroAt[key] = now;
      } else if (now - this._lastNonZeroAt[key] < this._zeroHoldMs) {
        parsed[key] = this.metrics[key];
      }
    }
  }

  async _subscribe(characteristic, onValue) {
    characteristic.addEventListener('characteristicvaluechanged', (e) => onValue(e.target.value));
    await characteristic.startNotifications();
  }

  async _requestControlOnce() {
    if (this._controlRequested) return;
    await this._writeControlPoint([OP.REQUEST_CONTROL]);
    this._controlRequested = true;
  }

  async _writeControlPoint(bytes) {
    const buf = Uint8Array.from(bytes);
    const resultPromise = new Promise((resolve) => { this._pendingOp = resolve; });
    await this.controlPoint.writeValueWithResponse(buf);
    const result = await resultPromise;
    if (result !== RESULT.SUCCESS) {
      throw new Error(`FTMS control point op 0x${bytes[0].toString(16)} failed: result 0x${result.toString(16)}`);
    }
    return result;
  }

  _handleControlPointIndication(dv) {
    // byte0 = 0x80 (response code), byte1 = request op code, byte2 = result code
    if (dv.byteLength >= 3 && dv.getUint8(0) === OP.RESPONSE_CODE) {
      this._pendingOp?.(dv.getUint8(2));
      this._pendingOp = null;
    }
  }

  /** Start the machine reporting/accepting control (call once at workout start). */
  async start() {
    await this._requestControlOnce();
    await this._writeControlPoint([OP.START]);
  }

  async stop() {
    try { await this._writeControlPoint([OP.STOP, 0x01]); } catch { /* best effort */ }
  }

  /**
   * ERG mode: hold a fixed target power in watts regardless of cadence.
   * Named to match the device interface control/erg.js expects (see
   * control/mode-switch.js's capability-detection docs).
   */
  async setErgTarget(watts) {
    await this._requestControlOnce();
    const v = Math.round(watts);
    await this._writeControlPoint([OP.SET_TARGET_POWER, v & 0xff, (v >> 8) & 0xff]);
  }

  /**
   * Resistance mode: fixed resistance level, power varies with effort.
   * `level` is in the same units as resistanceRange (min/max/step) — not
   * necessarily 0-100; callers snap to that range first (see
   * control/calibration.js#snapToRange, used by control/resistance.js and
   * control/virtual-gear.js). Named to match the device interface those
   * modules expect.
   */
  async setResistanceTarget(level) {
    await this._requestControlOnce();
    // FTMS resistance level unit is device-defined, encoded at 0.1 resolution
    // — same encoding resistanceRange was scaled from in _readRange().
    const v = Math.round(level * 10);
    await this._writeControlPoint([OP.SET_TARGET_RESISTANCE, v & 0xff, (v >> 8) & 0xff]);
  }

  /** Slope/grade simulation mode, e.g. for outdoor-course style workouts. grade in percent, e.g. 3.5 */
  async setSimulationGrade(gradePercent, { windSpeed = 0, crr = 0.004, cw = 0.51 } = {}) {
    await this._requestControlOnce();
    const windMs = Math.round(windSpeed * 1000); // sint16, 0.001 m/s
    const gradeVal = Math.round(gradePercent * 100); // sint16, 0.01%
    const crrVal = Math.round(crr * 10000); // uint8, 0.0001 — spec allows up to 0.0255, clamp caller-side
    const cwVal = Math.round(cw * 100); // uint8, 0.01 kg/m
    const bytes = [OP.SET_SIM_PARAMS];
    pushInt16(bytes, windMs);
    pushInt16(bytes, gradeVal);
    bytes.push(crrVal & 0xff, cwVal & 0xff);
    await this._writeControlPoint(bytes);
  }

  async disconnect() {
    this.gattServer?.disconnect();
  }
}

function pushInt16(arr, val) {
  arr.push(val & 0xff, (val >> 8) & 0xff);
}

// --- Data parsers -----------------------------------------------------
// Each FTMS data characteristic starts with a 2-byte "flags" field that
// determines which optional fields follow. We only decode the fields the
// UI actually uses; extend here if you add more stats.

function parseIndoorBikeData(dv) {
  const flags = dv.getUint16(0, true);
  let offset = 2;
  const out = {};
  // bit0 set = "more data" (instant speed NOT present) — per spec bit0=1 means speed absent
  if (!(flags & 0x0001)) { out.speed = dv.getUint16(offset, true) / 100; offset += 2; }
  if (flags & 0x0002) { offset += 2; } // avg speed, skip
  if (flags & 0x0004) { out.cadence = dv.getUint16(offset, true) / 2; offset += 2; }
  if (flags & 0x0008) { offset += 2; } // avg cadence, skip
  if (flags & 0x0010) { offset += 3; } // total distance (uint24), skip
  if (flags & 0x0020) { offset += 2; } // resistance level, skip
  if (flags & 0x0040) { out.power = dv.getInt16(offset, true); offset += 2; }
  if (flags & 0x0080) { offset += 2; } // avg power, skip
  if (flags & 0x0400) { out.heartRate = dv.getUint8(offset); offset += 1; }
  return out;
}

function parseRowerData(dv) {
  const flags = dv.getUint16(0, true);
  let offset = 2;
  const out = {};
  if (!(flags & 0x0001)) { out.strokeRate = dv.getUint8(offset) / 2; offset += 1; offset += 2; } // stroke rate + stroke count
  if (flags & 0x0002) { offset += 2; } // avg stroke rate, skip
  if (flags & 0x0004) { offset += 3; } // total distance, skip
  if (flags & 0x0008) { offset += 2; } // instant pace, skip
  if (flags & 0x0010) { offset += 2; } // avg pace, skip
  if (flags & 0x0020) { out.power = dv.getInt16(offset, true); offset += 2; }
  if (flags & 0x0040) { offset += 2; } // avg power, skip
  if (flags & 0x0200) { out.heartRate = dv.getUint8(offset); offset += 1; }
  return out;
}

function parseCrossTrainerData(dv) {
  const flags = dv.getUint16(0, true);
  let offset = 2;
  const out = {};
  if (!(flags & 0x0001)) { out.speed = dv.getUint16(offset, true) / 100; offset += 2; }
  if (flags & 0x0002) { offset += 2; } // avg speed, skip
  if (flags & 0x0004) { offset += 3; } // distance, skip
  if (flags & 0x0008) { offset += 2; } // step/stride cadence-ish, skip
  if (flags & 0x0010) { offset += 2; } // avg, skip
  if (flags & 0x0020) { offset += 3; } // pos/neg elevation, skip
  if (flags & 0x0080) { out.power = dv.getInt16(offset, true); offset += 2; }
  if (flags & 0x0100) { offset += 2; } // avg power, skip
  if (flags & 0x0400) { out.heartRate = dv.getUint8(offset); offset += 1; }
  return out;
}
