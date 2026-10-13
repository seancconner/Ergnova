// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/value-decode.js
 *
 * Turns a raw characteristic DataView into the same kind of "every
 * plausible interpretation at once" readout nRF Connect shows: hex, ASCII,
 * and a handful of common numeric encodings, plus a best-effort structured
 * decode for a handful of standard Bluetooth SIG characteristics (Battery
 * Level, Heart Rate Measurement, the Device Information strings, ...).
 * Pure functions — no BLE/DOM here, so ble/gatt-explorer.js and
 * ui/ble-debug-flow.js can both use these, and ble/__smoketest__.js can
 * cover them without any real hardware or DataView polyfilling beyond
 * plain Node's built-in DataView.
 *
 * This intentionally does NOT special-case this app's own FTMS/Merach/
 * ProForm parsers (ftms-device.js, merach-device.js, proform-device.js) —
 * those already assume a specific machine and would misdecode any other
 * device's frames on the same standard UUID. The point of this module is
 * the opposite: decode *something* useful for a device the app doesn't
 * have a wrapper for yet.
 */

import { normalizeUuid } from './gatt-names.js';

/** @returns {string} space-separated uppercase hex, e.g. "01 04 4B" ("" for empty). */
export function toHex(dataView) {
  const bytes = [];
  for (let i = 0; i < dataView.byteLength; i++) {
    bytes.push(dataView.getUint8(i).toString(16).padStart(2, '0'));
  }
  return bytes.join(' ').toUpperCase();
}

/** @returns {string} printable ASCII, with a middle dot standing in for anything outside 0x20-0x7e. */
export function toAscii(dataView) {
  let out = '';
  for (let i = 0; i < dataView.byteLength; i++) {
    const b = dataView.getUint8(i);
    out += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '\u00b7';
  }
  return out;
}

/** @returns {string} UTF-8 decode of the raw bytes, for characteristics that are plainly text (Device Name, DIS strings, ...). */
export function toUtf8(dataView) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(dataView.buffer.slice(dataView.byteOffset, dataView.byteOffset + dataView.byteLength));
  } catch {
    return null; // not valid UTF-8 — caller falls back to hex/ASCII
  }
}

/**
 * Every fixed-width numeric interpretation that fits in the available
 * bytes, little- and big-endian where the two differ. Longer ints/floats
 * are simply omitted when the value is too short for them, rather than
 * throwing — a 1-byte Battery Level shouldn't produce four "RangeError"
 * rows below its uint8 reading.
 * @returns {Array<{label: string, value: string}>}
 */
export function numericInterpretations(dataView) {
  const rows = [];
  const len = dataView.byteLength;
  const push = (label, value) => rows.push({ label, value: String(value) });

  if (len >= 1) {
    push('uint8',  dataView.getUint8(0));
    push('int8',   dataView.getInt8(0));
  }
  if (len >= 2) {
    push('uint16 LE', dataView.getUint16(0, true));
    push('uint16 BE', dataView.getUint16(0, false));
    push('int16 LE',  dataView.getInt16(0, true));
  }
  if (len >= 4) {
    push('uint32 LE', dataView.getUint32(0, true));
    push('int32 LE',  dataView.getInt32(0, true));
    push('float32 LE', roundDisplay(dataView.getFloat32(0, true)));
  }
  if (len >= 8) {
    push('float64 LE', roundDisplay(dataView.getFloat64(0, true)));
  }
  return rows;
}

function roundDisplay(n) {
  // Raw float32/float64 reinterpretation of arbitrary bytes is usually
  // either a sensible small number or nonsense floating garbage; round for
  // readability either way, and cap the useless case at 6 sig figs so a
  // garbage decode doesn't fill the row with 15 digits.
  if (!Number.isFinite(n)) return n;
  return Number(n.toPrecision(6));
}

// ── Known-characteristic structured decodes ────────────────────────────
// Keyed by the same short '0x2a19' form gatt-names.js resolves to, so the
// explorer can look a decoder up right after it already looked the name
// up. Each decoder returns a plain summary string, or null to fall back to
// the generic hex/ASCII/numeric rows above (e.g. a string char with
// invalid UTF-8, or a flags-based char this table doesn't cover yet).
const KNOWN_DECODERS = {
  '0x2a19': (dv) => dv.byteLength >= 1 ? `${dv.getUint8(0)}%` : null,
  '0x2a00': (dv) => toUtf8(dv),
  '0x2a24': (dv) => toUtf8(dv),
  '0x2a25': (dv) => toUtf8(dv),
  '0x2a26': (dv) => toUtf8(dv),
  '0x2a27': (dv) => toUtf8(dv),
  '0x2a28': (dv) => toUtf8(dv),
  '0x2a29': (dv) => toUtf8(dv),
  '0x2a01': (dv) => dv.byteLength >= 2 ? `appearance category 0x${dv.getUint16(0, true).toString(16)}` : null,
  '0x2a37': decodeHeartRateMeasurement,
  '0x2a38': (dv) => dv.byteLength >= 1 ? bodySensorLocation(dv.getUint8(0)) : null,
  // Descriptors — normalizeUuid()/the short-UUID lookup below don't care
  // whether a UUID belongs to a characteristic or a descriptor, so these
  // slot into the same table. Client Characteristic Configuration is the
  // one worth decoding by far: it's the live on/off state of the exact
  // subscription the Notify/Stop button toggles, so seeing "off" here
  // when a characteristic is supposed to be streaming is the fastest way
  // to tell a bad subscribe from a device that just isn't sending.
  '0x2902': (dv) => dv.byteLength >= 2 ? cccdFlags(dv.getUint16(0, true)) : null,
  '0x2901': (dv) => toUtf8(dv),
};

function cccdFlags(flags) {
  const notify = (flags & 0x0001) !== 0;
  const indicate = (flags & 0x0002) !== 0;
  if (!notify && !indicate) return 'notifications off, indications off';
  return [notify && 'notifications on', indicate && 'indications on'].filter(Boolean).join(', ');
}

function bodySensorLocation(code) {
  const names = ['Other', 'Chest', 'Wrist', 'Finger', 'Hand', 'Ear Lobe', 'Foot'];
  return names[code] ?? `unknown (${code})`;
}

/**
 * Bluetooth SIG Heart Rate Measurement (0x2A37) flags-based frame — the
 * one standard characteristic worth fully decoding here since every
 * chest/wrist HR strap uses the exact same layout (see ble/hr-device.js's
 * own parseHeartRate, which this mirrors but reports back as text rather
 * than mutating app metrics state).
 */
function decodeHeartRateMeasurement(dv) {
  if (dv.byteLength < 2) return null;
  const flags = dv.getUint8(0);
  const is16bit = (flags & 0x01) !== 0;
  let offset = 1;
  const bpm = is16bit ? dv.getUint16(offset, true) : dv.getUint8(offset);
  offset += is16bit ? 2 : 1;
  const parts = [`${bpm} bpm`];
  const sensorContact = (flags >> 1) & 0x03;
  if (sensorContact === 0x02) parts.push('contact: no');
  else if (sensorContact === 0x03) parts.push('contact: yes');
  if ((flags & 0x08) !== 0 && dv.byteLength >= offset + 2) {
    parts.push(`energy: ${dv.getUint16(offset, true)} kJ`);
    offset += 2;
  }
  if ((flags & 0x10) !== 0) parts.push('RR-intervals present');
  return parts.join(', ');
}

/**
 * Full decode readout for one characteristic value — everything
 * ui/ble-debug-flow.js needs to render a value row.
 * @param {DataView} dataView
 * @param {number|string} uuid  the characteristic's UUID (for known-decode lookup)
 * @returns {{ hex: string, ascii: string, known: string|null, numeric: Array<{label,value}> }}
 */
export function decodeValue(dataView, uuid) {
  const { short } = normalizeUuid(uuid);
  const decoder = short ? KNOWN_DECODERS[short] : null;
  let known = null;
  try {
    known = decoder ? decoder(dataView) : null;
  } catch {
    known = null; // malformed/short frame for this UUID — fall back to generic rows below
  }
  return {
    hex: toHex(dataView),
    ascii: toAscii(dataView),
    known,
    numeric: numericInterpretations(dataView),
  };
}
