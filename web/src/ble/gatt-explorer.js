// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/gatt-explorer.js
 *
 * Generic "nRF Connect in the browser" device wrapper: connects to *any*
 * nearby BLE peripheral (not just the ones this app already has a wrapper
 * for) and walks every primary service -> characteristic -> descriptor it
 * can see, so ui/ble-debug-flow.js can render a live, inspectable tree and
 * let the person read/write/subscribe by hand. This is what makes adding
 * support for a new trainer/rower possible without a phone running a
 * separate nRF-Connect-style app — see src/ble/proform-ref/ for the kind
 * of raw GATT capture this replaces having to do externally.
 *
 * Deliberately talks to `navigator.bluetooth` directly rather than going
 * through ble/transport/index.js's bleTransport. That abstraction's native
 * bridge backend (transport/native-bridge-backend.js) only exposes
 * getPrimaryService(knownUuid) / getCharacteristic(knownUuid) — enough for
 * every *-device.js wrapper here, which always knows exactly which
 * service/characteristic it wants, but not enough to *enumerate*
 * everything a device exposes, which is the entire point of this module.
 * A generic explorer is therefore Web-Bluetooth-only: `isAvailable` below
 * reflects that directly instead of deferring to bleTransport.isAvailable,
 * so it correctly reports unavailable under the native-bridge shell (e.g.
 * iOS) even though the rest of the app's BLE features work fine there.
 *
 * Not part of ble/reconnect.js's auto-reconnect roster and does not call
 * ble/roles.js — this is a standalone diagnostic tool, not a data source
 * for a live session.
 */

import { DEFAULT_OPTIONAL_SERVICES, labelFor } from './gatt-names.js';

const PROP_KEYS = [
  'broadcast', 'read', 'writeWithoutResponse', 'write',
  'notify', 'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries',
];

/** @returns {string[]} the property keys this characteristic actually has, e.g. ['read','notify']. */
function activeProperties(characteristic) {
  const props = characteristic.properties ?? {};
  return PROP_KEYS.filter((k) => props[k]);
}

export class GattExplorer extends EventTarget {
  /** True only for the real browser Web Bluetooth API — see file header. */
  static get isAvailable() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  constructor() {
    super();
    this.device = null;
    this.gattServer = null;
    /** @type {Array<{uuid:string,label:string,characteristics:Array<Object>}>} populated by discover() */
    this.services = [];
    this._notifyHandlers = new Map(); // characteristic -> bound listener, so setNotify(false) can remove exactly it
  }

  /**
   * Opens the browser's chooser for *any* BLE device (not filtered to
   * services this app recognizes) and connects.
   * @param {string[]} [extraServiceUuids]  Extra 16-/128-bit service UUIDs
   *   to add to optionalServices for this scan, on top of
   *   gatt-names.js's DEFAULT_OPTIONAL_SERVICES — e.g. a custom UUID
   *   found in the target device's own documentation or a prior OS-level
   *   scan, so it shows up post-connect instead of being silently hidden
   *   by Web Bluetooth's allow-list (see gatt-names.js's doc comment).
   */
  async requestAndConnect(extraServiceUuids = []) {
    if (!GattExplorer.isAvailable) {
      throw new Error('Web Bluetooth is not available in this browser/shell.');
    }
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [...DEFAULT_OPTIONAL_SERVICES, ...extraServiceUuids],
    });
    this.device.addEventListener('gattserverdisconnected', () => this._handleDisconnect());
    this.gattServer = await this.device.gatt.connect();
    await this.discover();
    this.dispatchEvent(new CustomEvent('connected', { detail: { name: this.device.name, id: this.device.id } }));
    return this;
  }

  /**
   * Reconnects to the same device after a disconnect, without reopening
   * the browser's chooser — Web Bluetooth allows this as long as the page
   * still holds the original BluetoothDevice object (this.device), which
   * disconnecting never clears. Throws if requestAndConnect() was never
   * called first (nothing to reconnect to).
   */
  async reconnect() {
    if (!this.device) throw new Error('No previously connected device to reconnect to — scan first.');
    this.gattServer = await this.device.gatt.connect();
    await this.discover();
    this.dispatchEvent(new CustomEvent('connected', { detail: { name: this.device.name, id: this.device.id } }));
    return this;
  }

  /**
   * (Re)walks every primary service/characteristic/descriptor the browser
   * will show for this connection and rebuilds `this.services`. Safe to
   * call again later (e.g. a "Rediscover" button) — a fresh connection
   * isn't required.
   */
  async discover() {
    const services = await this.gattServer.getPrimaryServices();
    const out = [];
    for (const service of services) {
      const characteristics = await service.getCharacteristics();
      const charInfos = [];
      for (const characteristic of characteristics) {
        let descriptors = [];
        try {
          descriptors = (await characteristic.getDescriptors()).map((d) => ({
            uuid: d.uuid,
            label: labelFor(d.uuid, 'descriptor'),
            descriptor: d,
          }));
        } catch {
          descriptors = []; // many peripherals expose none, or refuse the request — fine either way
        }
        charInfos.push({
          uuid: characteristic.uuid,
          label: labelFor(characteristic.uuid, 'characteristic'),
          properties: activeProperties(characteristic),
          characteristic,
          descriptors,
          notifying: false,
        });
      }
      out.push({
        uuid: service.uuid,
        label: labelFor(service.uuid, 'service'),
        service,
        characteristics: charInfos,
      });
    }
    this.services = out;
    this.dispatchEvent(new CustomEvent('discovered', { detail: { services: this.services } }));
    return this.services;
  }

  /**
   * Reads a characteristic once. Fires a 'value' event the same shape as a
   * notification (source: 'read' instead of 'notify') so
   * ui/ble-debug-flow.js can share one rendering path for both.
   * @param {Object} charInfo  an entry from this.services[i].characteristics
   */
  async read(charInfo) {
    const dataView = await charInfo.characteristic.readValue();
    this.dispatchEvent(new CustomEvent('value', {
      detail: { charInfo, dataView, source: 'read', timestamp: Date.now() },
    }));
    return dataView;
  }

  /**
   * Writes raw bytes to a characteristic.
   * @param {Object} charInfo
   * @param {Uint8Array} bytes
   * @param {boolean} [withResponse]  Defaults to true when the
   *   characteristic supports it, since a response confirms the write
   *   actually landed — falls back to writeValueWithoutResponse only when
   *   `write` isn't in charInfo.properties.
   */
  async write(charInfo, bytes, withResponse) {
    const useResponse = withResponse ?? charInfo.properties.includes('write');
    if (useResponse) {
      await charInfo.characteristic.writeValueWithResponse(bytes);
    } else {
      await charInfo.characteristic.writeValueWithoutResponse(bytes);
    }
    this.dispatchEvent(new CustomEvent('write', {
      detail: { charInfo, bytes, withResponse: useResponse, timestamp: Date.now() },
    }));
  }

  /**
   * Subscribes/unsubscribes to a characteristic's notifications/indications.
   * Each incoming value fires the same 'value' event `read()` does
   * (source: 'notify'), so the debug console's log is one unified,
   * chronological feed across every characteristic being watched at once —
   * exactly the cross-characteristic correlation a hand capture (like
   * ble/proform-ref/btsnoop_hci*_full_summary.txt) is normally needed for.
   * @param {Object} charInfo
   * @param {boolean} enabled
   */
  async setNotify(charInfo, enabled) {
    if (enabled === charInfo.notifying) return;
    if (enabled) {
      const handler = (e) => {
        this.dispatchEvent(new CustomEvent('value', {
          detail: { charInfo, dataView: e.target.value, source: 'notify', timestamp: Date.now() },
        }));
      };
      charInfo.characteristic.addEventListener('characteristicvaluechanged', handler);
      this._notifyHandlers.set(charInfo.characteristic, handler);
      await charInfo.characteristic.startNotifications();
    } else {
      await charInfo.characteristic.stopNotifications().catch(() => {}); // already gone if the device dropped
      const handler = this._notifyHandlers.get(charInfo.characteristic);
      if (handler) charInfo.characteristic.removeEventListener('characteristicvaluechanged', handler);
      this._notifyHandlers.delete(charInfo.characteristic);
    }
    charInfo.notifying = enabled;
  }

  /** Reads one descriptor (e.g. the CCCD or a User Description string). */
  async readDescriptor(descInfo) {
    return descInfo.descriptor.readValue();
  }

  disconnect() {
    this.gattServer?.disconnect(); // fires 'gattserverdisconnected' -> _handleDisconnect()
  }

  _handleDisconnect() {
    this._notifyHandlers.clear(); // the characteristic objects go stale on disconnect either way
    this.services = [];
    this.dispatchEvent(new CustomEvent('disconnected'));
  }
}

export default GattExplorer;
