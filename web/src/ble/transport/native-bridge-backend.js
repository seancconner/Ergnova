// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/transport/native-bridge-backend.js
 *
 * Adapter for the *other* half of the dual-transport guide: a wrapping
 * C#/.NET MAUI shell (Android, Windows, or iOS — iOS has no other option,
 * since no iOS browser implements Web Bluetooth) injects
 * `window.__ergnovaNativeBLE` into the WebView before this page loads. This
 * module doesn't implement any Bluetooth itself — it wraps that native
 * contract in the same Device -> device.gatt -> Service -> Characteristic
 * shape the real Web Bluetooth API has, so nothing in merach-device.js /
 * ftms-device.js / hr-device.js / moxy.js / core-temp.js / reconnect.js
 * needs to know which backend is live. See ble/transport/index.js for the
 * resolution order.
 *
 * ── The native contract this backend expects on window.__ergnovaNativeBLE ──
 *
 *   requestDevice(options)                          -> Promise<{id, name}>
 *   getDevices()                                     -> Promise<Array<{id, name}>>
 *   gattConnect(deviceId)                            -> Promise<void>
 *   gattDisconnect(deviceId)                         -> void
 *   isGattConnected(deviceId)                        -> boolean
 *   getPrimaryService(deviceId, serviceUuid)         -> Promise<{serviceId}>
 *   getCharacteristic(deviceId, serviceId, charUuid) -> Promise<{charId}>
 *   writeValue(deviceId, charId, bytes, withResponse)-> Promise<void>
 *   readValue(deviceId, charId)                      -> Promise<number[]>
 *   startNotifications(deviceId, charId)             -> Promise<void>
 *   watchAdvertisements(deviceId)                    -> Promise<void>
 *   stopWatchingAdvertisements(deviceId)             -> void
 *
 *   // Native -> JS events all funnel through one entry point, so the
 *   // native side only ever needs to know a single function name:
 *   _dispatch(type, detail)
 *     type: 'characteristicvaluechanged' | 'gattserverdisconnected'
 *         | 'advertisementreceived'
 *     detail: { deviceId, charId?, value?: number[] }
 *
 * `bytes` / `value` cross the bridge as plain arrays of 0-255 ints — the
 * simplest shape any native JS-bridge mechanism (Android's
 * addJavascriptInterface, iOS's WKScriptMessageHandler, WebView2's
 * AddHostObjectToScript) can pass without a custom serializer. UUIDs pass
 * through exactly as the *-device.js files already write them (numbers like
 * 0x2ad9 or strings like the Moxy service's 128-bit UUID) — native-side
 * GATT lookup normalizes either.
 */

function toDataView(byteArray) {
  return new DataView(new Uint8Array(byteArray ?? []).buffer);
}

class NativeCharacteristic extends EventTarget {
  constructor(backend, deviceId, charId) {
    super();
    this._backend = backend;
    this._deviceId = deviceId;
    this._charId = charId;
    this.value = undefined; // set on each 'characteristicvaluechanged', matches real API
  }

  async writeValueWithResponse(bytes) {
    await this._backend._bridge.writeValue(this._deviceId, this._charId, Array.from(bytes), true);
  }

  async writeValueWithoutResponse(bytes) {
    await this._backend._bridge.writeValue(this._deviceId, this._charId, Array.from(bytes), false);
  }

  async readValue() {
    const bytes = await this._backend._bridge.readValue(this._deviceId, this._charId);
    return toDataView(bytes);
  }

  async startNotifications() {
    await this._backend._bridge.startNotifications(this._deviceId, this._charId);
    return this;
  }
}

class NativeService {
  constructor(backend, deviceId, serviceId) {
    this._backend = backend;
    this._deviceId = deviceId;
    this._serviceId = serviceId;
  }

  async getCharacteristic(uuid) {
    const { charId } = await this._backend._bridge.getCharacteristic(this._deviceId, this._serviceId, uuid);
    return this._backend._wrapCharacteristic(this._deviceId, charId);
  }
}

class NativeGattServer {
  constructor(backend, deviceId) {
    this._backend = backend;
    this._deviceId = deviceId;
  }

  get connected() {
    return this._backend._bridge.isGattConnected(this._deviceId);
  }

  async connect() {
    await this._backend._bridge.gattConnect(this._deviceId);
    return this;
  }

  disconnect() {
    this._backend._bridge.gattDisconnect(this._deviceId);
  }

  async getPrimaryService(uuid) {
    const { serviceId } = await this._backend._bridge.getPrimaryService(this._deviceId, uuid);
    return new NativeService(this._backend, this._deviceId, serviceId);
  }
}

class NativeDevice extends EventTarget {
  constructor(backend, { id, name }) {
    super();
    this._backend = backend;
    this.id = id;
    this.name = name;
    this.gatt = new NativeGattServer(backend, id);
  }

  /** Mirrors real BluetoothDevice#watchAdvertisements — honors an AbortSignal the same way. */
  async watchAdvertisements({ signal } = {}) {
    await this._backend._bridge.watchAdvertisements(this.id);
    signal?.addEventListener('abort', () => this._backend._bridge.stopWatchingAdvertisements(this.id));
  }
}

export class NativeBridgeBackend {
  backendName = 'native-bridge';
  isAvailable = true;

  constructor(bridge) {
    this._bridge = bridge;
    this._devices = new Map();        // deviceId -> NativeDevice
    this._characteristics = new Map(); // charId -> NativeCharacteristic

    // Chain onto any dispatch hook the shell may already have set, so this
    // backend can be constructed without stomping on other bridge consumers.
    const prevDispatch = typeof bridge._dispatch === 'function' ? bridge._dispatch.bind(bridge) : null;
    bridge._dispatch = (type, detail) => {
      prevDispatch?.(type, detail);
      this._handleEvent(type, detail);
    };
  }

  async requestDevice(options) {
    const info = await this._bridge.requestDevice(options ?? {});
    return this._wrapDevice(info);
  }

  async getDevices() {
    const list = await this._bridge.getDevices();
    return list.map((info) => this._wrapDevice(info));
  }

  _wrapDevice(info) {
    let device = this._devices.get(info.id);
    if (!device) {
      device = new NativeDevice(this, info);
      this._devices.set(info.id, device);
    }
    return device;
  }

  _wrapCharacteristic(deviceId, charId) {
    let char = this._characteristics.get(charId);
    if (!char) {
      char = new NativeCharacteristic(this, deviceId, charId);
      this._characteristics.set(charId, char);
    }
    return char;
  }

  _handleEvent(type, detail) {
    if (type === 'characteristicvaluechanged') {
      const char = this._characteristics.get(detail.charId);
      if (char) {
        char.value = toDataView(detail.value);
        char.dispatchEvent(new Event('characteristicvaluechanged'));
      }
      return;
    }
    const device = this._devices.get(detail.deviceId);
    if (!device) return;
    if (type === 'gattserverdisconnected') device.dispatchEvent(new Event('gattserverdisconnected'));
    else if (type === 'advertisementreceived') device.dispatchEvent(new Event('advertisementreceived'));
  }
}

export default NativeBridgeBackend;
