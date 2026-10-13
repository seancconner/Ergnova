// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

import { HRS_SERVICE, HRS_MEASUREMENT, MACHINE_TYPE } from './ftms-constants.js';
import { bleTransport } from './transport/index.js';
import { reconnect } from './reconnect.js';

/**
 * For weight training / anything without an FTMS machine: just a chest/wrist HR strap.
 *
 * Two ways in, same as ble/moxy.js: connect() opens the chooser (and remembers the strap so
 * ble/reconnect.js can find it again), connectDevice(device) takes a handle reconnect.js already
 * has — the auto-reconnect path, no chooser.
 */
export class HrDevice extends EventTarget {
  constructor() {
    super();
    this.machineType = MACHINE_TYPE.HR_ONLY;
    this.metrics = { heartRate: null, elapsed: 0 };
    this.gattServer = null;
    this.name = null;
    /** BLE device id — what reconnect.js remembers and pauses by. Null until connected. */
    this.id = null;
    this._device = null;
    this._char = null;
    this._onGattDisconnect = null;
    this._onValue = null;
  }

  /** Opens the chooser, connects, and remembers the strap for auto-reconnect. */
  async connect() {
    const device = await bleTransport.requestDevice({
      filters: [{ services: [HRS_SERVICE] }]
    });
    await this._connectDevice(device);
    reconnect.remember(device, 'hr');
    return this;
  }

  /** Connects to a handle reconnect.js found — no chooser. @param {BluetoothDevice} device */
  async connectDevice(device) {
    await this._connectDevice(device);
    return this;
  }

  async _connectDevice(device) {
    this._device = device;
    this.id = device.id ?? null;
    this.name = device.name ?? 'Heart Rate Monitor';

    // The transport hands back the *same* device (and characteristic) objects on every
    // reconnect, so listeners from an earlier HrDevice would pile up and answer for this one.
    // Each connection removes its own on the way out (_detach()).
    this._onGattDisconnect = () => {
      this._detach();
      this.dispatchEvent(new CustomEvent('disconnected'));
    };
    device.addEventListener('gattserverdisconnected', this._onGattDisconnect);

    try {
      this.gattServer = await device.gatt.connect();
      const service = await this.gattServer.getPrimaryService(HRS_SERVICE);
      const char = await service.getCharacteristic(HRS_MEASUREMENT);
      this._char = char;
      this._onValue = (e) => {
        this.metrics.heartRate = parseHeartRate(e.target.value);
        this.dispatchEvent(new CustomEvent('data', { detail: this.metrics }));
      };
      char.addEventListener('characteristicvaluechanged', this._onValue);
      await char.startNotifications();
    } catch (err) {
      // A failed attempt must not leave its listeners behind for the next try.
      this._detach();
      throw err;
    }
    this.dispatchEvent(new CustomEvent('connected', { detail: { machineType: this.machineType } }));
  }

  _detach() {
    if (this._device && this._onGattDisconnect) {
      this._device.removeEventListener('gattserverdisconnected', this._onGattDisconnect);
    }
    if (this._char && this._onValue) {
      this._char.removeEventListener('characteristicvaluechanged', this._onValue);
    }
    this._onGattDisconnect = null;
    this._onValue = null;
    this._char = null;
  }

  async start() {}
  async stop() {}
  async disconnect() {
    // A deliberate disconnect: drop our own listeners first so the 'gattserverdisconnected' it
    // causes (if the transport relays one at all — see app.js's _resetHrmState()) can't be
    // mistaken for the strap dropping on its own.
    this._detach();
    this.gattServer?.disconnect();
  }
}

function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  const is16bit = flags & 0x1;
  return is16bit ? dv.getUint16(1, true) : dv.getUint8(1);
}
