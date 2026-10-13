// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/transport/index.js
 *
 * Resolves which BLE backend is live and exposes it as `bleTransport` — the
 * one thing every device wrapper (merach-device.js, ftms-device.js,
 * hr-device.js, moxy.js, core-temp.js, reconnect.js) and app.js's
 * connectController() import instead of touching navigator.bluetooth
 * directly. See the project's dual-transport guide for the full design.
 *
 * Resolution order:
 *   1. A native bridge injected by a wrapping C#/.NET MAUI shell
 *      (window.__ergnovaNativeBLE) — required on iOS, optional elsewhere.
 *   2. Real Web Bluetooth (navigator.bluetooth) — the fallback, and the
 *      only thing that runs when this is loaded as a plain PWA in a
 *      browser (today's setup, unchanged). Reachable on Android and
 *      Windows; there's nothing to fall back to on iOS.
 *   3. Neither present -> bleTransport.isAvailable is false and
 *      requestDevice() rejects with a clear error instead of a raw
 *      "navigator.bluetooth is undefined" crash surfacing deep inside a
 *      device wrapper.
 *
 * Resolved once at module load — the shell is expected to inject
 * window.__ergnovaNativeBLE before this page's scripts run, not partway
 * through a session.
 */
import { webBluetoothBackend } from './web-bluetooth-backend.js';
import { NativeBridgeBackend } from './native-bridge-backend.js';

function resolveBackend() {
  if (typeof window !== 'undefined' && window.__ergnovaNativeBLE) {
    return new NativeBridgeBackend(window.__ergnovaNativeBLE);
  }
  if (webBluetoothBackend.isAvailable) {
    return webBluetoothBackend;
  }
  return null;
}

const _backend = resolveBackend();

export const bleTransport = {
  /** 'native-bridge' | 'web-bluetooth' | null — which backend resolved. */
  get backendName() {
    return _backend?.backendName ?? null;
  },

  /** True if either backend can actually be used right now. */
  get isAvailable() {
    return _backend != null;
  },

  /** Same options shape as navigator.bluetooth.requestDevice({ filters, optionalServices }). */
  requestDevice(options) {
    if (!_backend) {
      return Promise.reject(new Error(
        'Bluetooth is not available: no native bridge is present and this browser has no Web Bluetooth support.'
      ));
    }
    return _backend.requestDevice(options);
  },

  /** Previously-granted/bonded devices, for auto-reconnect (ble/reconnect.js). Empty array if unsupported. */
  getDevices() {
    if (!_backend) return Promise.resolve([]);
    return _backend.getDevices();
  },
};

export default bleTransport;
