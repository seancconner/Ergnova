// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/moxy.js
 *
 * BLE wrapper for the Moxy Muscle Oxygen Monitor.
 * Reports SmO2 (muscle oxygen saturation %) and tHb (total haemoglobin g/dL).
 *
 * Moxy uses a proprietary GATT service. The service and characteristic UUIDs
 * below match the publicly documented Moxy BLE profile.
 *
 * Same pattern as ftms-device.js: registers roles and updates capabilities
 * on connect/disconnect.
 *
 * Usage:
 *   import { MoxyDevice } from './ble/moxy.js';
 *   const moxy = new MoxyDevice();
 *   await moxy.connect(({ smo2, thb }) => console.log(smo2, thb));
 *   moxy.disconnect();
 */

import { roles, ROLES } from './roles.js';
import { reconnect } from './reconnect.js';
import { bleTransport } from './transport/index.js';

// Moxy BLE profile UUIDs
const MOXY_SERVICE           = '3ab10100-f831-4395-b29d-570977d5bf94';
const MOXY_DATA_CHARACTERISTIC = '3ab10101-f831-4395-b29d-570977d5bf94';

export class MoxyDevice {
  constructor() {
    this.id    = null;
    this.name  = null;
    this._device = null;
    this._onData = null;
  }

  /**
   * Open BLE chooser for a Moxy device and connect.
   * @param {Function} onData  Receives { smo2: number, thb: number }
   */
  async connect(onData) {
    this._onData = onData;

    const device = await bleTransport.requestDevice({
      filters: [{ services: [MOXY_SERVICE] }],
    });

    await this._connectDevice(device);
    reconnect.remember(device, 'smo2');
  }

  /**
   * Connect to a specific BluetoothDevice (used by auto-reconnect).
   * @param {BluetoothDevice} device
   * @param {Function} [onData]
   */
  async connectDevice(device, onData) {
    if (onData) this._onData = onData;
    await this._connectDevice(device);
  }

  async _connectDevice(device) {
    this._device = device;
    this.id   = device.id;
    this.name = device.name ?? 'Moxy';

    device.addEventListener('gattserverdisconnected', () => this._onDisconnect());

    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(MOXY_SERVICE);
    const char    = await service.getCharacteristic(MOXY_DATA_CHARACTERISTIC);

    await char.startNotifications();
    char.addEventListener('characteristicvaluechanged', (e) =>
      this._parse(e.target.value)
    );

    roles.register(this.id, [ROLES.SMO2_MONITOR]);
    console.info('[moxy] Connected:', this.name);
  }

  /**
   * Parse a Moxy data notification.
   * The Moxy protocol encodes SmO2 and tHb as little-endian uint16 values,
   * scaled by 0.1 and 0.01 respectively.
   */
  _parse(dataView) {
    if (dataView.byteLength < 4) return;

    // Byte layout (confirmed from Moxy documentation):
    //   0-1: tHb  (uint16 LE) × 0.1  → g/dL
    //   2-3: SmO2 (uint16 LE) × 0.1  → %
    const thb  = dataView.getUint16(0, true) * 0.1;
    const smo2 = dataView.getUint16(2, true) * 0.1;

    if (this._onData) {
      this._onData({ thb, smo2 });
    }
  }

  _onDisconnect() {
    roles.unregister(this.id);
    console.info('[moxy] Disconnected:', this.name);
  }

  disconnect() {
    this._device?.gatt?.disconnect();
  }

  get isConnected() {
    return this._device?.gatt?.connected ?? false;
  }
}

export default MoxyDevice;
