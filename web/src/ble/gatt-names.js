// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/gatt-names.js
 *
 * Static lookup tables the GATT explorer (ble/gatt-explorer.js +
 * ui/ble-debug-flow.js) uses to label services/characteristics the same
 * way a native tool like nRF Connect would — resolved name if it's a
 * Bluetooth SIG assigned number or one of this app's own known devices,
 * "Unknown Service"/"Unknown Characteristic" otherwise. Purely data: no
 * BLE/DOM code lives here.
 *
 * Only covers the subset of the SIG registry a fitness/health device is
 * actually likely to expose (Generic Access/Attribute, Device Information,
 * Battery, HRS, FTMS, CPS/CSCS/RSCS legacy sport services, Health
 * Thermometer). Anything else still displays fine — just as "Unknown
 * Service 0x1234" / the full 128-bit UUID — this table is a labeling aid,
 * never a requirement for the explorer to work.
 */

import { FTMS_SERVICE, CHAR as FTMS_CHAR, HRS_SERVICE, HRS_MEASUREMENT } from './ftms-constants.js';
import { PROFORM_SERVICE } from './proform-device.js';

/** Every 16-bit Bluetooth SIG UUID normalizes to this base. */
const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/**
 * Normalizes any UUID shape web bluetooth hands back (a number like
 * 0x2ad9, or a full 128-bit string) into a canonical lowercase 128-bit
 * string, plus — when it's a standard 16-bit UUID wearing the SIG base —
 * a short '0x2ad9' form for display and table lookups.
 * @param {number|string} uuid
 * @returns {{ full: string, short: string|null }}
 */
export function normalizeUuid(uuid) {
  if (typeof uuid === 'number') {
    const hex = uuid.toString(16).padStart(4, '0');
    return { full: `0000${hex}${BASE_SUFFIX}`, short: `0x${hex}` };
  }
  const full = String(uuid).toLowerCase();
  const m = /^0000([0-9a-f]{4})0000-1000-8000-00805f9b34fb$/.exec(full) // defensive, in case of odd spacing
    || /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(full);
  return { full, short: m ? `0x${m[1]}` : null };
}

// ── Services ────────────────────────────────────────────────────────────
const SERVICE_NAMES = {
  '0x1800': 'Generic Access',
  '0x1801': 'Generic Attribute',
  '0x1804': 'Tx Power',
  '0x1805': 'Current Time Service',
  '0x180a': 'Device Information',
  '0x180d': 'Heart Rate',
  '0x180f': 'Battery Service',
  '0x1809': 'Health Thermometer',
  '0x1816': 'Cycling Speed and Cadence',
  '0x1818': 'Cycling Power',
  '0x1814': 'Running Speed and Cadence',
  '0x1826': 'Fitness Machine',
  '0x181c': 'User Data',
  '0x181d': 'Weight Scale',
  '0x1812': 'Human Interface Device',
  '0xfe59': 'Nordic DFU',
};

// ── Characteristics ─────────────────────────────────────────────────────
const CHARACTERISTIC_NAMES = {
  '0x2a00': 'Device Name',
  '0x2a01': 'Appearance',
  '0x2a04': 'Peripheral Preferred Connection Parameters',
  '0x2a05': 'Service Changed',
  '0x2a19': 'Battery Level',
  '0x2a23': 'System ID',
  '0x2a24': 'Model Number String',
  '0x2a25': 'Serial Number String',
  '0x2a26': 'Firmware Revision String',
  '0x2a27': 'Hardware Revision String',
  '0x2a28': 'Software Revision String',
  '0x2a29': 'Manufacturer Name String',
  '0x2a37': 'Heart Rate Measurement',
  '0x2a38': 'Body Sensor Location',
  '0x2a1c': 'Temperature Measurement',
  '0x2a1e': 'Intermediate Temperature',
  '0x2a5b': 'CSC Measurement',
  '0x2a5c': 'CSC Feature',
  '0x2a63': 'Cycling Power Measurement',
  '0x2a65': 'Cycling Power Feature',
  '0x2a53': 'RSC Measurement',
  '0x2a54': 'RSC Feature',
  '0x2a9d': 'Weight Measurement',
  '0x2acc': 'Fitness Machine Feature',
  '0x2ad2': 'Indoor Bike Data',
  '0x2ad1': 'Rower Data',
  '0x2ace': 'Cross Trainer Data',
  '0x2ad3': 'Training Status',
  '0x2ad6': 'Supported Resistance Level Range',
  '0x2ad8': 'Supported Power Range',
  '0x2ad9': 'Fitness Machine Control Point',
  '0x2ada': 'Fitness Machine Status',
};

// ── Descriptors ─────────────────────────────────────────────────────────
const DESCRIPTOR_NAMES = {
  '0x2900': 'Characteristic Extended Properties',
  '0x2901': 'Characteristic User Description',
  '0x2902': 'Client Characteristic Configuration',
  '0x2903': 'Server Characteristic Configuration',
  '0x2904': 'Characteristic Presentation Format',
};

// This app's own custom (non-SIG) UUIDs — surfaced with the same device
// name app.js already knows them by, so exploring a device this app can
// already partly talk to doesn't just show "Unknown Service".
const CUSTOM_NAMES = {
  [PROFORM_SERVICE.toLowerCase()]: 'ProForm 750R (proprietary)',
};

function lookup(table, uuid, custom) {
  const { full, short } = normalizeUuid(uuid);
  if (custom?.[full]) return custom[full];
  if (short && table[short]) return table[short];
  return null;
}

export function serviceName(uuid) {
  return lookup(SERVICE_NAMES, uuid, CUSTOM_NAMES);
}

export function characteristicName(uuid) {
  return lookup(CHARACTERISTIC_NAMES, uuid);
}

export function descriptorName(uuid) {
  return lookup(DESCRIPTOR_NAMES, uuid);
}

/**
 * Display label for any GATT UUID: "Known Name (0x2ad9)" for a recognized
 * 16-bit SIG UUID, "Known Name" for a recognized custom 128-bit UUID,
 * "Unknown Service (0x1234)" / "Unknown Characteristic" otherwise, or the
 * full 128-bit UUID when there's no short form and no name at all — same
 * fallback ladder nRF Connect uses.
 * @param {number|string} uuid
 * @param {'service'|'characteristic'|'descriptor'} kind
 */
export function labelFor(uuid, kind) {
  const { full, short } = normalizeUuid(uuid);
  const name =
    kind === 'service' ? serviceName(uuid) :
    kind === 'descriptor' ? descriptorName(uuid) :
    characteristicName(uuid);
  const fallback = kind === 'service' ? 'Unknown Service' :
    kind === 'descriptor' ? 'Unknown Descriptor' : 'Unknown Characteristic';
  if (name && short) return `${name} (${short})`;
  if (name) return name;
  return short ? `${fallback} (${short})` : `${fallback} (${full})`;
}

/**
 * Broad set of standard services passed as `optionalServices` on every
 * scan. Web Bluetooth only lets a page later call getPrimaryService(s) for
 * UUIDs that were named in `filters`/`optionalServices` at requestDevice()
 * time — unlike a native scanner (real nRF Connect), the browser hides
 * anything not pre-declared, even after connecting. This list front-loads
 * every service a fitness/health/generic BLE peripheral is likely to
 * expose; ui/ble-debug-flow.js additionally lets the person type in extra
 * (e.g. a new device's own custom 128-bit) UUIDs before scanning, for
 * exactly the reverse-engineering case this table can't anticipate.
 */
export const DEFAULT_OPTIONAL_SERVICES = [
  0x1800, 0x1801, 0x1804, 0x1805, 0x180a, 0x180d, 0x180f, 0x1809,
  0x1816, 0x1818, 0x1814, 0x1826, 0x181c, 0x181d, 0x1812, 0xfe59,
  FTMS_SERVICE, HRS_SERVICE, PROFORM_SERVICE,
];

export { FTMS_CHAR, HRS_MEASUREMENT };
