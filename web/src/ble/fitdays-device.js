// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/fitdays-device.js
 *
 * Wraps the Fitdays/ICOMON FI2001B-E ("F8") smart body-composition scale —
 * the actual physical unit this project captured and reverse-engineered
 * (see smart_scale_ble_cheatsheet.md). It advertises a vendor-squatted
 * 16-bit service UUID (0xFFB0) with a fully proprietary payload, not the
 * Bluetooth SIG Body Composition Service — the same "not actually
 * standard despite looking like it might be" situation
 * ble/merach-device.js documents for the Merach bike, just with a
 * proprietary UUID this time instead of a proprietary payload riding a
 * real standard one.
 *
 * PROTOCOL STATUS (see the cheatsheet for the full derivation):
 *   - Weight: CONFIRMED. §2/§2.1 — a single byte, a linear mapping with a
 *     mod-256 wraparound every ~144.7 lb, validated across an 0-237 lb
 *     range in btsnoop_hci3.log against 12 independently-known weigh-ins.
 *   - Live vs. settled: CONFIRMED. §2.2 — a flag byte distinguishes the
 *     converging/ramping stream (and the idle "nothing on the scale"
 *     stream) from the final locked reading.
 *   - Raw bioelectrical impedance (4 limbs × 2 frequencies): CONFIRMED,
 *     cheatsheet §3.1 — a rare tagged (0x1a) two-part message on the
 *     INDICATE characteristic (FITDAYS_CHAR.INDICATE / handle 0x0022),
 *     *not* the NOTIFY characteristic the weight stream rides. 8 of 10
 *     values (all 4 limbs at both 20kHz/100kHz) decode exactly against
 *     known ground truth; Trunk is still open (see
 *     _decodeCompositionRecord32() below). connect() now subscribes to both
 *     characteristics and correlates a settled weight with its composition
 *     record via the record's own weight-byte echo — see
 *     _emitSettledWeight()/_handleIndicateValue(). *   - Higher-level composition metrics (body fat %, muscle mass, bone
 *     mass, water, visceral fat rating, BMR): ESTIMATED, not decoded —
 *     cheatsheet §3.1/§5's working theory is that the vendor app computes
 *     these client-side from weight + impedance + the stored user profile,
 *     not something this scale streams over the air, and nothing found so
 *     far contradicts that. metrics/body-composition.js's
 *     estimateBodyComposition() is this project's own reconstruction of
 *     that computation, calibrated against the ground-truth readings in
 *     smart-scale-ref/fitdays_captures_datasheet.xlsx — see that module's
 *     doc comment for the derivation and its honestly-stated limitations.
 *     Treat these fields as a rough estimate, not a hardware-reported
 *     number the way scale-device.js's SIG-standard fields are. BMR isn't
 *     a second independent guess — body-composition.js calls app.js's same
 *     Katch-McArdle helper (metrics/nutrition.js#estimateBmr()) internally
 *     once bodyFatPct/leanBodyMassKg are known, per DIET_PANEL_CHECKLIST.md
 *     Phase 8, so there's exactly one BMR formula in this app, not two
 *     competing ones. Visceral fat rating is a from-fat-mass regression
 *     added once the ground-truth set grew enough to check it — see
 *     body-composition.js's LIMITATIONS section for its (wider) error bars.
 *
 * Same connect(onData)/disconnect() shape as hr-device.js/scale-device.js.
 * Not wired into device-manager.js/roles.js — see scale-device.js's header
 * for why a scale doesn't join that machinery.
 *
 * Usage:
 *   const scale = new FitdaysScaleDevice();
 *   await scale.connect(reading => { ... }, profile.riderWeight, profile.heightCm);
 *   // hintWeightKg disambiguates the weight-byte wraparound (_decodeWeightByte());
 *   // heightCm feeds the composition estimate (_maybeEstimateComposition()) —
 *   // composition fields simply stay null without it.
 *   // reading: { weightKg, settled, bodyFatPct, muscleMassKg, boneMassKg,
 *   //   bodyWaterKg, visceralFatRating, basalMetabolicRateKcal,
 *   //   compositionEstimated, raw: { counter, xx, yy, byte7,
 *   //   byte8, byte19, impedance20kHzOhm, impedance100kHzOhm } }
 *   scale.disconnect();
 */

import {
  FITDAYS_SERVICE, FITDAYS_CHAR, FITDAYS_COMPOSITION_TAG, FITDAYS_COMPOSITION_PART,
  FITDAYS_NAME_PREFIX,
} from './scale-constants.js';
import { estimateBodyComposition } from '../metrics/body-composition.js';
import { reconnect } from './reconnect.js';
import { bleTransport } from './transport/index.js';

const LB_TO_KG = 0.45359237;
const KG_TO_LB = 1 / LB_TO_KG;

// Linear fit from smart_scale_ble_cheatsheet.md §2.1, least-squares over 12
// known weigh-ins spanning 0-237 lb: weight_byte = round(WEIGHT_SLOPE ×
// weight_lb + WEIGHT_INTERCEPT) mod 256. Residuals were all under a
// quarter pound against that ground truth.
const WEIGHT_SLOPE     = 1.7692;  // counts per lb
const WEIGHT_INTERCEPT = -255.92;
const WRAP_PERIOD_LB   = 256 / WEIGHT_SLOPE; // ≈144.7 lb — two weights this far apart share a byte value

// Default hint when the caller doesn't have a better one (e.g. no rider
// weight on file yet — profile.riderWeight is null until the rider enters
// one) — dead center of the plausible-adult-rider band.
const DEFAULT_HINT_KG = 75;

// Search window for the wraparound integer k (weight_byte = raw mod 256,
// raw = WEIGHT_SLOPE*lb + WEIGHT_INTERCEPT + 256*k). ±2 covers roughly
// -145 to +434 lb around the hint, comfortably spanning any real adult
// rider weight without wasting cycles on implausible bands.
const K_SEARCH_RANGE = [-2, -1, 0, 1, 2];

const XX_LIVE    = 0x01;
const XX_SETTLED = 0x03;

// How long a settled weight reading waits for its composition record
// (cheatsheet §3.1) before giving up and reporting weight-only.
// "Generous" relative to the "within a second" timing the cheatsheet's
// five known indicate/notify pairs actually showed (§3.1's table), so a
// slow-but-real composition record isn't dropped, without stalling the UI
// noticeably on a weight-only scale/session where one will never arrive.
const COMPOSITION_WAIT_MS = 1200;

export class FitdaysScaleDevice extends EventTarget {
  constructor() {
    super();
    this.id = null;
    this.name = null;
    this._device = null;
    this._onData = null;
    // Running best guess for the wraparound band — seeded from whatever
    // hint connect()/connectDevice() was given, then updated to the most
    // recent settled reading so a multi-reading session (e.g. re-settling
    // after a small shift) stays locked to the same true value rather
    // than re-guessing from the stale original hint every time.
    this._hintKg = DEFAULT_HINT_KG;
    // Height hint for the composition estimate (metrics/body-composition.js
    // needs it for the resistance-index term) — unlike _hintKg, there's
    // nothing to "improve" this from a reading (the scale never reports
    // height), so it's just whatever connect()/connectDevice() was given,
    // for the life of the connection.
    this._heightCm = null;
    // The most recent settled-but-not-yet-emitted weight reading, waiting
    // out COMPOSITION_WAIT_MS for a matching composition record — see
    // _emitSettledWeight()/_handleIndicateValue(). Both null when nothing
    // is pending (idle, or already emitted).
    this._pendingSettled = null;
    this._pendingSettledTimer = null;
    // Halves of an in-progress composition record, keyed by the INDICATE
    // channel's own rolling counter (cheatsheet §3.1 — a different
    // namespace from NOTIFY's byte 0) so a stray part A with no matching
    // part B (or vice versa) can't get silently paired with the wrong one.
    this._pendingCompositionPart = null; // { counter, a: Uint8Array|null, b: Uint8Array|null }
  }

  /**
   * Opens the chooser and connects.
   * @param {Function} onData
   * @param {number|null} [hintWeightKg] Best known prior weight (kg) —
   *   pass profile.riderWeight. Only affects which ~144.7lb wraparound
   *   band an ambiguous byte value resolves to; see _decodeWeightByte().
   * @param {number|null} [heightCm] Rider height — pass profile.heightCm.
   *   Feeds the composition estimate (metrics/body-composition.js) when a
   *   composition record arrives; without it, composition fields on a
   *   reading simply stay null (weight still decodes fine either way).
   */
  async connect(onData, hintWeightKg = null, heightCm = null) {
    this._onData = onData;
    if (hintWeightKg != null) this._hintKg = hintWeightKg;
    if (heightCm != null) this._heightCm = heightCm;

    const device = await bleTransport.requestDevice({
      filters: [{ namePrefix: FITDAYS_NAME_PREFIX }],
      optionalServices: [FITDAYS_SERVICE],
    });
    await this._connectDevice(device);
    reconnect.remember(device, 'fitdays-scale');
  }

  /** Connect to a specific BluetoothDevice (used by reconnect.js auto-reconnect). */
  async connectDevice(device, onData, hintWeightKg = null, heightCm = null) {
    if (onData) this._onData = onData;
    if (hintWeightKg != null) this._hintKg = hintWeightKg;
    if (heightCm != null) this._heightCm = heightCm;
    await this._connectDevice(device);
  }

  async _connectDevice(device) {
    this._device = device;
    this.id   = device.id;
    this.name = device.name ?? 'Fitdays Smart Scale';

    device.addEventListener('gattserverdisconnected', () => {
      this._clearPendingSettled();
      this.dispatchEvent(new CustomEvent('disconnected'));
    });

    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(FITDAYS_SERVICE);

    // The write channel (FITDAYS_CHAR.WRITE) carries an undecoded
    // handshake (see scale-constants.js) — this app never writes to it.
    // Subscribing to NOTIFY is enough to receive weight data: like most of
    // these budget scales, it's the scale that decides when to stream
    // (triggered by weight landing on the plate), not something the phone
    // has to ask for. If that assumption turns out wrong for some unit (no
    // notifications ever arrive), the write channel is the next thing to
    // chase — see the cheatsheet's §8 open items.
    const notifyChar = await service.getCharacteristic(FITDAYS_CHAR.NOTIFY);
    notifyChar.addEventListener('characteristicvaluechanged', (e) => {
      const reading = this._decodePacket(new Uint8Array(e.target.value.buffer));
      if (!reading) return; // malformed/unexpected-length packet — see _decodePacket()
      if (reading.settled) {
        this._hintKg = reading.weightKg;
        this._emitSettledWeight(reading);
      } else if (this._onData) {
        this._onData(reading); // live/idle stream — no debounce, nothing to wait for
      }
    });
    await notifyChar.startNotifications();

    // INDICATE — mostly a plain heartbeat, but the rare 0x1a-tagged pair
    // carries the composition/impedance record (cheatsheet §3.1). Web
    // Bluetooth doesn't distinguish notify vs. indicate at the JS API
    // level — both surface as 'characteristicvaluechanged' after
    // startNotifications() — so this is the same subscribe shape as
    // NOTIFY above, just routed to a different decoder.
    const indicateChar = await service.getCharacteristic(FITDAYS_CHAR.INDICATE);
    indicateChar.addEventListener('characteristicvaluechanged', (e) => {
      this._handleIndicateValue(new Uint8Array(e.target.value.buffer));
    });
    await indicateChar.startNotifications();

    console.info('[fitdays] Connected:', this.name);
  }

  disconnect() {
    this._clearPendingSettled();
    this._device?.gatt?.disconnect();
  }

  get isConnected() {
    return this._device?.gatt?.connected ?? false;
  }

  /**
   * Parses one 20-byte notification per smart_scale_ble_cheatsheet.md §2:
   *   byte 0        rolling counter (resets at each live→settled transition)
   *   bytes 1-6     header, `07 00 a2 XX 19 YY` — XX is the live/settled flag (§2.2), YY an undecoded burst/session marker
   *   byte 7        weight (§2/§2.1 — see _decodeWeightByte())
   *   byte 8        undecoded (§2.3 — not weight-correlated)
   *   bytes 9-18    padding, always 0x00
   *   byte 19       undecoded (§2.3)
   * @param {Uint8Array} d
   * @returns {{weightKg: number, settled: boolean, raw: Object}|null}
   */
  _decodePacket(d) {
    if (d.length !== 20) return null; // not the packet shape the cheatsheet documents — ignore rather than guess

    const counter = d[0];
    const xx = d[4];
    const yy = d[6];
    const byte7 = d[7];
    const byte8 = d[8];
    const byte19 = d[19];

    const settled = xx === XX_SETTLED;
    // xx === XX_LIVE covers both the converging stream and the idle
    // "nothing on the scale" stream (byte7 === 0 in that case) — both are
    // forwarded as unsettled rather than filtered here, so a caller that
    // wants a live "weighing…" readout can still show one; app.js's
    // handler only acts on settled === true.
    const weightKg = _decodeWeightByte(byte7, this._hintKg);

    return { weightKg, settled, raw: { counter, xx, yy, byte7, byte8, byte19 } };
  }

  /**
   * Holds a freshly-settled weight reading for up to COMPOSITION_WAIT_MS,
   * giving the INDICATE composition record (cheatsheet §3.1) a chance to
   * arrive and get matched to it via _tryMatchComposition() before this
   * reports out as weight-only. Only one reading is ever held at a time —
   * a second settled NOTIFY arriving while one is already pending (a quick
   * re-settle) flushes the first as weight-only immediately rather than
   * losing it, since a composition record that shows up after that point
   * can no longer be assumed to belong to it anyway.
   * @param {{weightKg:number, settled:boolean, raw:Object}} reading
   */
  _emitSettledWeight(reading) {
    if (this._pendingSettled && this._onData) this._onData(this._pendingSettled);
    this._pendingSettled = reading;
    if (this._pendingSettledTimer) clearTimeout(this._pendingSettledTimer);
    this._pendingSettledTimer = setTimeout(() => {
      this._pendingSettledTimer = null;
      const flushed = this._pendingSettled;
      this._pendingSettled = null;
      if (flushed && this._onData) this._onData(flushed);
    }, COMPOSITION_WAIT_MS);
  }

  _clearPendingSettled() {
    if (this._pendingSettledTimer) clearTimeout(this._pendingSettledTimer);
    this._pendingSettledTimer = null;
    this._pendingSettled = null;
    this._pendingCompositionPart = null;
  }

  /**
   * Routes one INDICATE value. Most indications are either the plain
   * heartbeat (a lone incrementing counter, cheatsheet §3) or the
   * device-ID-shaped handshake (§3) — both silently ignored here, same as
   * before this method existed. Only a second-header byte of
   * FITDAYS_COMPOSITION_TAG (0x1a) is composition-record traffic; see
   * _decodeCompositionRecord32() for the 32-byte record itself.
   * @param {Uint8Array} d
   */
  _handleIndicateValue(d) {
    if (d.length !== 20 || d[1] !== FITDAYS_COMPOSITION_TAG) return; // heartbeat/handshake/unexpected shape — not this record

    const counter = d[0];
    const part = d[2];
    const payload16 = d.slice(3, 19); // drop the 3-byte counter+tag+subtag header and the trailing checksum-shaped byte 19 (cheatsheet §3.1)

    if (!this._pendingCompositionPart || this._pendingCompositionPart.counter !== counter) {
      // First half of a new pair, or a stray half whose partner never
      // showed (dropped BLE packet, or a session boundary) — either way,
      // start fresh under this counter rather than pairing across two
      // unrelated composition events.
      this._pendingCompositionPart = { counter, a: null, b: null };
    }
    if (part === FITDAYS_COMPOSITION_PART.A) this._pendingCompositionPart.a = payload16;
    else if (part === FITDAYS_COMPOSITION_PART.B) this._pendingCompositionPart.b = payload16;
    else return; // neither known subtag — leave the slot as-is and wait

    const { a, b } = this._pendingCompositionPart;
    if (!a || !b) return; // still waiting on the other half

    this._pendingCompositionPart = null;
    const full32 = new Uint8Array(32);
    full32.set(a, 0);
    full32.set(b, 16);
    this._tryMatchComposition(_decodeCompositionRecord32(full32));
  }

  /**
   * Matches a decoded composition record to the currently-pending settled
   * weight reading via the record's own weight-byte (and byte8) echo —
   * cheatsheet §3.1's offsets 3/4, confirmed exact echoes of NOTIFY's byte
   * 7/byte 8. This is a real protocol field, not a timing guess: it's what
   * lets this correlate the two channels correctly even if a composition
   * record from a *previous* weigh-in is still in flight when a new one
   * settles. No match (wrong echo, or nothing pending — e.g. the record
   * arrived after COMPOSITION_WAIT_MS already flushed weight-only) simply
   * drops it; the weight-only reading already went out or will shortly.
   * @param {{weightByteEcho:number, byte8Echo:number, impedance20kHzOhm:Object, impedance100kHzOhm:Object}} composition
   */
  _tryMatchComposition(composition) {
    const pending = this._pendingSettled;
    if (!pending) return;
    if (composition.weightByteEcho !== pending.raw.byte7 || composition.byte8Echo !== pending.raw.byte8) return;

    if (this._pendingSettledTimer) clearTimeout(this._pendingSettledTimer);
    this._pendingSettledTimer = null;
    this._pendingSettled = null;

    const estimate = estimateBodyComposition({
      weightKg: pending.weightKg,
      heightCm: this._heightCm,
      impedance20kHzOhm: composition.impedance20kHzOhm,
    });

    const merged = {
      ...pending,
      bodyFatPct: estimate?.bodyFatPct ?? null,
      muscleMassKg: estimate?.muscleMassKg ?? null,
      boneMassKg: estimate?.boneMassKg ?? null,
      bodyWaterKg: estimate?.bodyWaterKg ?? null,
      visceralFatRating: estimate?.visceralFatRating ?? null,
      basalMetabolicRateKcal: estimate?.basalMetabolicRateKcal ?? null,
      compositionEstimated: estimate != null, // see module doc comment — this app.js checks to caveat the sync status message
      raw: {
        ...pending.raw,
        impedance20kHzOhm: composition.impedance20kHzOhm,
        impedance100kHzOhm: composition.impedance100kHzOhm,
      },
    };

    // TEMPORARY — calibration logging for smart-scale-ref/fitdays_captures_datasheet.xlsx.
    // Prints everything needed to add this weigh-in as a new ground-truth row: weight in
    // both units (cross-check against the scale's own LCD) plus both raw impedance blocks.
    // Safe to remove once body-composition.js's calibration set no longer needs growing.
    console.info('[fitdays] composition reading for calibration:', JSON.stringify({
      weightKg: Math.round(merged.weightKg * 100) / 100,
      weightLb: Math.round(merged.weightKg * KG_TO_LB * 10) / 10,
      impedance20kHzOhm: merged.raw.impedance20kHzOhm,
      impedance100kHzOhm: merged.raw.impedance100kHzOhm,
    }, null, 2));

    if (this._onData) this._onData(merged);
  }
}

/**
 * Inverts weight_byte = round(WEIGHT_SLOPE × weight_lb + WEIGHT_INTERCEPT)
 * mod 256 — ambiguous on its own (many weights ~144.7 lb apart share a
 * byte value), so this picks whichever wraparound band (k) lands closest
 * to hintKg, exactly the "expected-user-weight profile" disambiguation
 * the cheatsheet's §2.1 flags as necessary and left open. Not a perfect
 * solution (a genuinely new rider more than ~72 lb from the hint in the
 * wrong direction could resolve to the wrong band on their very first
 * reading), but it's the best available signal without a second protocol
 * field to lean on, and self-corrects immediately after — the caller
 * updates its hint to every settled reading (see _decodePacket() above).
 * @param {number} byte7
 * @param {number} hintKg
 * @returns {number} weight in kg (canonical — see module doc comment)
 */
function _decodeWeightByte(byte7, hintKg) {
  const hintLb = hintKg * KG_TO_LB;
  let bestLb = null;
  let bestDelta = Infinity;
  for (const k of K_SEARCH_RANGE) {
    const raw = byte7 + 256 * k;
    const lb  = (raw - WEIGHT_INTERCEPT) / WEIGHT_SLOPE;
    const delta = Math.abs(lb - hintLb);
    if (delta < bestDelta) { bestDelta = delta; bestLb = lb; }
  }
  return bestLb * LB_TO_KG;
}

/**
 * Decodes the 32-byte composition record _handleIndicateValue() assembles
 * from a matched part-A/part-B pair — cheatsheet §3.1's byte-offset table,
 * confirmed exact against the 237.0 lb and 81.4 lb ground-truth readings
 * (8/8 impedance values, to the tenth of an ohm). Only the fields that
 * table actually pins down get extracted here:
 *   0-1   constant record-type tag (`a3 19`) — not returned, nothing to do with it
 *   2     unknown flag — not returned
 *   3     weight-byte echo (matches NOTIFY's byte 7 — the correlation key
 *         _tryMatchComposition() checks)
 *   4     byte8 echo (matches NOTIFY's byte 8 — the second correlation key)
 *   5-7   unknown — not returned
 *   8-15  20kHz impedance, left/right arm then left/right leg
 *   16-17 unknown gap between the two frequency blocks — not returned
 *   18-25 100kHz impedance, same limb order
 *   26-31 zero padding — not returned
 * Trunk impedance is NOT in this record at every offset/scale tried against
 * known ground truth (§3.1's "What's still open") — there is no field for
 * it here, on purpose, not an oversight.
 *
 * A weight-only reading (no hand-electrode contact) carries this exact same
 * 32-byte shape with everything from offset 5 on zeroed (confirmed directly
 * in the cheatsheet) — this still decodes it cleanly, it just comes out as
 * all-zero impedance, which estimateBodyComposition() treats as "nothing to
 * estimate from" via its own `> 0` validation on every limb.
 *
 * @param {Uint8Array} d 32-byte concatenated record (part A's 16 bytes then part B's)
 * @returns {{weightByteEcho:number, byte8Echo:number,
 *   impedance20kHzOhm:{leftArm:number,rightArm:number,leftLeg:number,rightLeg:number},
 *   impedance100kHzOhm:{leftArm:number,rightArm:number,leftLeg:number,rightLeg:number}}}
 */
function _decodeCompositionRecord32(d) {
  // Big-endian uint16, ohms × 10 (§3.1's "Encoding" note) — e.g. 0x0a9b (2715) → 271.5Ω.
  const ohmAt = offset => ((d[offset] << 8) | d[offset + 1]) / 10;

  return {
    weightByteEcho: d[3],
    byte8Echo: d[4],
    impedance20kHzOhm: {
      leftArm: ohmAt(8), rightArm: ohmAt(10), leftLeg: ohmAt(12), rightLeg: ohmAt(14),
    },
    impedance100kHzOhm: {
      leftArm: ohmAt(18), rightArm: ohmAt(20), leftLeg: ohmAt(22), rightLeg: ohmAt(24),
    },
  };
}

// Exported for the smoke test — not part of the class's public surface.
export const __internal = { _decodeWeightByte, _decodeCompositionRecord32, WRAP_PERIOD_LB };

export default FitdaysScaleDevice;
