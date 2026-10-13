// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// ble/scale-constants.js
//
// GATT constants for smart-scale support — the Body Composition / Weight
// Scale Service counterpart to ftms-constants.js's FTMS block. Split into
// its own file rather than folded into ftms-constants.js because none of
// this is FTMS (that file is specifically "Bluetooth SIG Fitness Machine
// Service constants" per its own header) — a scale isn't a fitness
// machine, it's its own GATT service family, same reasoning that keeps
// HRS_SERVICE/HRS_MEASUREMENT sitting alongside FTMS today more by
// convenience than by relation. DIET_PANEL_DESIGN.md §7 called this "or a
// new constants block" — this is that block.
//
// Two families of constant live here:
//   1. STANDARD, Bluetooth SIG-registered services (Body Composition,
//      Weight Scale) — ble/scale-device.js's ScaleDevice targets these.
//      Bit layouts below are transcribed from the GATT Specification
//      Supplement's Body Composition Measurement / Weight Scale
//      Measurement characteristic definitions. Not yet exercised against
//      real SIG-compliant hardware in this project (the one physical
//      scale captured so far — see FITDAYS_SERVICE below — doesn't
//      implement this service at all), so treat the parsing as
//      spec-correct-by-transcription rather than hardware-confirmed.
//   2. VENDOR-SPECIFIC — the Fitdays/ICOMON FI2001B-E scale actually
//      reverse-engineered for this project (see
//      smart_scale_ble_cheatsheet.md). ble/fitdays-device.js targets
//      these. Same "fake-standard-looking short UUID, fully proprietary
//      payload" pattern ble/merach-device.js already documents for the
//      Merach bike, just with a vendor-squatted 16-bit UUID instead of a
//      squatted *standard* one — 0xffb0 was never SIG-assigned to this
//      vendor, it's just from the same base-UUID-template shorthand
//      range budget BLE peripherals commonly reuse (cf. the cheatsheet's
//      §6 "prior art" — sibling scales in the same UUID family).

// ─── Standard GATT (Bluetooth SIG) ─────────────────────────────────────────

export const BODY_COMPOSITION_SERVICE     = 0x181b;
export const BODY_COMPOSITION_MEASUREMENT = 0x2a9c; // weight + body-fat%, optionally muscle/bone/water/BMR/impedance/height — see flag bits below

export const WEIGHT_SCALE_SERVICE   = 0x181d;
export const WEIGHT_MEASUREMENT     = 0x2a9d; // weight-only fallback, optionally BMI+height

/**
 * Body Composition Measurement (0x2A9C) flags — bit position within the
 * little-endian uint16 Flags field. Presence bits gate which optional
 * fields follow Body Fat Percentage in the payload, in this fixed order:
 * Timestamp → User ID → BMR → Muscle % → Muscle Mass → Fat Free Mass →
 * Soft Lean Mass → Body Water Mass → Impedance → Weight → Height.
 */
export const BODY_COMPOSITION_FLAGS = {
  IMPERIAL_UNITS:  0x0001, // 0 = SI (kg/m), 1 = Imperial (lb/in) — applies to every mass/length field below
  TIMESTAMP:       0x0002,
  USER_ID:         0x0004,
  BMR:             0x0008,
  MUSCLE_PCT:      0x0010,
  MUSCLE_MASS:     0x0020,
  FAT_FREE_MASS:   0x0040,
  SOFT_LEAN_MASS:  0x0080,
  BODY_WATER_MASS: 0x0100,
  IMPEDANCE:       0x0200,
  WEIGHT:          0x0400,
  HEIGHT:          0x0800,
  MULTI_PACKET:    0x1000, // more data follows in a second notification — not handled (see scale-device.js note)
};

/** Weight Scale Measurement (0x2A9D) flags — single-byte Flags field. */
export const WEIGHT_SCALE_FLAGS = {
  IMPERIAL_UNITS: 0x01, // 0 = SI (kg/m), 1 = Imperial (lb/in)
  TIMESTAMP:      0x02,
  USER_ID:        0x04,
  BMI_AND_HEIGHT: 0x08,
};

// SI-unit resolutions per spec (used regardless of which units bit the
// device sent — see scale-device.js's canonical-kg conversion).
export const SI_MASS_RESOLUTION_KG      = 0.005;  // Weight/Muscle Mass/Fat Free Mass/Soft Lean Mass/Body Water Mass
export const IMPERIAL_MASS_RESOLUTION_LB = 0.01;
export const SI_HEIGHT_RESOLUTION_M      = 0.001;
export const IMPERIAL_HEIGHT_RESOLUTION_IN = 0.1;

// ─── Vendor: Fitdays / ICOMON FI2001B-E ("F8") ─────────────────────────────
// See smart_scale_ble_cheatsheet.md for the full derivation. Handles are
// stable across sessions/reconnects (reconfirmed in btsnoop_hci3.log), so
// hardcoding them here (rather than resolving purely by characteristic
// UUID) is safe, but this project resolves by UUID anyway — the handle
// numbers are only mentioned in the cheatsheet as an artifact of the
// specific captures, not something the code depends on.

export const FITDAYS_SERVICE = 0xffb0;
export const FITDAYS_CHAR = {
  WRITE:    0xffb1, // handle 0x001d in the captures — undecoded device-ID-shaped handshake, see cheatsheet §3. Not written to by this app (see fitdays-device.js).
  NOTIFY:   0xffb2, // handle 0x001f — weight stream, decoded (cheatsheet §2)
  INDICATE: 0xffb3, // handle 0x0022 — mostly a plain heartbeat counter, but a rare tagged (0x1a) message pair carries a composition/impedance record: 8 of 10 raw bioelectrical-impedance values (all 4 limbs × 2 frequencies) decoded exactly, Trunk still open — see cheatsheet §3.1. Subscribed to by fitdays-device.js alongside NOTIFY; see that file's PROTOCOL STATUS note for what's built on top of the decode.
};

// Indicate-channel composition record (cheatsheet §3.1) — a rare tagged
// message *pair* on FITDAYS_CHAR.INDICATE, distinct from both the plain
// heartbeat (a lone incrementing counter byte) and the device-ID-shaped
// handshake shape that channel otherwise carries. Each part is a full
// 20-byte indication: byte 0 is an outer rolling counter shared by both
// parts of one pair (not the same counter namespace as NOTIFY's byte 0),
// byte 1 is FITDAYS_COMPOSITION_TAG, byte 2 is which part it is, bytes
// 3-18 (16 bytes) are that part's share of the 32-byte composition record,
// and byte 19 is a checksum-shaped trailing byte the cheatsheet never
// solved either (same undecoded role as NOTIFY's own byte 19). Concatenate
// part A's 16 bytes then part B's 16 bytes to get the record fitdays-
// device.js's _decodeCompositionRecord() parses.
export const FITDAYS_COMPOSITION_TAG = 0x1a;
export const FITDAYS_COMPOSITION_PART = { A: 0x00, B: 0x01 };

/** Advertised local-name prefix for this scale — short (2 chars), so a
 *  false-positive match against some unrelated device is plausible if one
 *  happens to advertise a name starting the same way. Tighten this if that
 *  turns out to matter in practice; it's exactly what the captures show
 *  today (see smart_scale_ble_cheatsheet.md §0's device identification). */
export const FITDAYS_NAME_PREFIX = 'F8';

export default {
  BODY_COMPOSITION_SERVICE, BODY_COMPOSITION_MEASUREMENT, BODY_COMPOSITION_FLAGS,
  WEIGHT_SCALE_SERVICE, WEIGHT_MEASUREMENT, WEIGHT_SCALE_FLAGS,
  SI_MASS_RESOLUTION_KG, IMPERIAL_MASS_RESOLUTION_LB,
  SI_HEIGHT_RESOLUTION_M, IMPERIAL_HEIGHT_RESOLUTION_IN,
  FITDAYS_SERVICE, FITDAYS_CHAR, FITDAYS_COMPOSITION_TAG, FITDAYS_COMPOSITION_PART,
  FITDAYS_NAME_PREFIX,
};
