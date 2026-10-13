// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/core-temp.js
 *
 * BLE wrapper for a core body temperature sensor.
 * Uses the standard Bluetooth Health Thermometer Service (0x1809)
 * and Temperature Measurement characteristic (0x2A1C).
 *
 * Compatible with the Greenfield / CORE sensor and any device that
 * implements the standard Health Thermometer GATT profile.
 *
 * Same pattern as ftms-device.js and moxy.js.
 *
 * Usage:
 *   import { CoreTempDevice } from './ble/core-temp.js';
 *   const sensor = new CoreTempDevice();
 *   await sensor.connect(({ coreTemp }) => console.log(coreTemp));
 *   sensor.disconnect();
 */

import { roles, ROLES } from './roles.js';
import { reconnect } from './reconnect.js';
import { bleTransport } from './transport/index.js';

const HEALTH_THERMOMETER_SERVICE = 0x1809;
const TEMPERATURE_MEASUREMENT    = 0x2A1C;

// Flag bits for Temperature Measurement characteristic
const FLAG_FAHRENHEIT = 0x01;
const FLAG_TIMESTAMP  = 0x02;

export class CoreTempDevice {
  constructor() {
    this.id      = null;
    this.name    = null;
    this._device = null;
    this._onData = null;
  }

  /**
   * Open BLE chooser for a core-temp sensor.
   * @param {Function} onData  Receives { coreTemp: number } in °C
   */
  async connect(onData) {
    this._onData = onData;

    const device = await bleTransport.requestDevice({
      filters: [{ services: [HEALTH_THERMOMETER_SERVICE] }],
    });

    await this._connectDevice(device);
    reconnect.remember(device, 'coreTemp');
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
    this.name = device.name ?? 'Core Temp';

    device.addEventListener('gattserverdisconnected', () => this._onDisconnect());

    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(HEALTH_THERMOMETER_SERVICE);
    const char    = await service.getCharacteristic(TEMPERATURE_MEASUREMENT);

    await char.startNotifications();
    char.addEventListener('characteristicvaluechanged', (e) =>
      this._parse(e.target.value)
    );

    roles.register(this.id, [ROLES.CORE_TEMP_MONITOR]);
    console.info('[core-temp] Connected:', this.name);
  }

  /**
   * Parse a Temperature Measurement notification.
   *
   * Byte layout:
   *   0:     Flags
   *   1–4:   Temperature Measurement Value (FLOAT, IEEE-11073)
   *   5–11:  Time Stamp (optional, 7 bytes) — present if flag bit 1 is set
   *
   * IEEE-11073 FLOAT: mantissa (int24 LE) + exponent (int8)
   * value = mantissa × 10^exponent
   */
  _parse(dataView) {
    const flags     = dataView.getUint8(0);
    const isFahrenheit = flags & FLAG_FAHRENHEIT;

    // Read IEEE-11073 FLOAT (bytes 1–4, little-endian)
    const rawLo  = dataView.getUint8(1);
    const rawMid = dataView.getUint8(2);
    const rawHi  = dataView.getUint8(3);
    const exp    = dataView.getInt8(4);   // signed exponent

    let mantissa = rawLo | (rawMid << 8) | (rawHi << 16);
    // Sign-extend the 24-bit mantissa
    if (mantissa & 0x800000) mantissa |= 0xFF000000;

    let temp = mantissa * Math.pow(10, exp);

    // Convert to Celsius if the sensor reports Fahrenheit
    if (isFahrenheit) temp = (temp - 32) * (5 / 9);

    temp = Math.round(temp * 10) / 10; // 1 decimal place

    if (this._onData) {
      this._onData({ coreTemp: temp });
    }
  }

  _onDisconnect() {
    roles.unregister(this.id);
    console.info('[core-temp] Disconnected:', this.name);
  }

  disconnect() {
    this._device?.gatt?.disconnect();
  }

  get isConnected() {
    return this._device?.gatt?.connected ?? false;
  }
}

export default CoreTempDevice;
