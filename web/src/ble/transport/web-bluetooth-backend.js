// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/transport/web-bluetooth-backend.js
 *
 * Thin pass-through to the real Web Bluetooth API. This is today's behavior,
 * completely unchanged — just reshaped behind the same interface
 * native-bridge-backend.js implements, so ble/transport/index.js can swap
 * between them without merach-device.js / ftms-device.js / hr-device.js /
 * moxy.js / core-temp.js / reconnect.js knowing which one is live.
 *
 * Real BluetoothDevice / BluetoothRemoteGATTServer / ...Service /
 * ...Characteristic objects already have the exact shape those files call
 * (device.gatt.connect(), server.getPrimaryService(), characteristic
 * .writeValueWithResponse(), 'characteristicvaluechanged' events, etc.), so
 * there's nothing to adapt here — requestDevice()/getDevices() are hand-offs.
 */
export const webBluetoothBackend = {
  backendName: 'web-bluetooth',

  get isAvailable() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  },

  requestDevice(options) {
    return navigator.bluetooth.requestDevice(options);
  },

  /** Persistent-permissions API (Chrome 85+) — older browsers just get []. */
  getDevices() {
    return navigator.bluetooth.getDevices
      ? navigator.bluetooth.getDevices()
      : Promise.resolve([]);
  },
};

export default webBluetoothBackend;
