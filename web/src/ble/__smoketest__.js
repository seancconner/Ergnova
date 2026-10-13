// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// ble/ smoke test — validates MerachDevice + Proform750rDevice packet
// parsing, sensor calibration, and the GATT debug explorer's pure
// name-lookup/decode helpers (gatt-names.js, value-decode.js — the classes
// that actually touch navigator.bluetooth, gatt-explorer.js and
// ui/ble-debug-flow.js, need a real browser and aren't covered here).
// Run with: npm run test:ble
// No real Bluetooth — _handlePacket called directly, _now() overridden.

import { CalibrationStore, proportionalSolver } from './sensor-calibration.js';
import {
  MerachDevice, MERACH_S09_DEVICE_TYPE, registerMerachS09CalibrationProfile,
} from './merach-device.js';
import {
  Proform750rDevice, PROFORM_750R_DEVICE_TYPE, registerProform750rCalibrationProfile,
} from './proform-device.js';
import { normalizeUuid, labelFor, DEFAULT_OPTIONAL_SERVICES } from './gatt-names.js';
import { toHex, toAscii, decodeValue } from './value-decode.js';
import { FitdaysScaleDevice, __internal as fitdaysInternal } from './fitdays-device.js';
import { FITDAYS_COMPOSITION_TAG, FITDAYS_COMPOSITION_PART } from './scale-constants.js';
import { ReconnectCushion } from './reconnect-cushion.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}
function closeTo(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

console.log('sensor-calibration.js (generic CalibrationStore)');
{
  const store = new CalibrationStore();
  store.registerDeviceType('widget', { params: { gain: { value: 2 } } });

  const defaults = await store.load('widget');
  check('load() resolves defaults', defaults.gain === 2);

  const after = await store.calibrate('widget', 'gain', { computed: 10, reference: 20 });
  check('proportional solver (direct) doubles gain when reference = 2× computed', closeTo(after.gain, 4));

  const store2 = new CalibrationStore();
  store2.registerDeviceType('inv', {
    params: { divisor: { value: 10 } },
    solvers: { thing: proportionalSolver('divisor', { inverse: true }) },
  });
  await store2.load('inv');
  const afterInv = await store2.calibrate('inv', 'thing', { computed: 9.565, reference: 10 });
  check('proportional solver (inverse) reduces divisor when computed < reference', afterInv.divisor < 10);

  const reset = await store2.reset('inv');
  check('reset() restores default', reset.divisor === 10);
}

console.log('merach-device.js (packet parsing)');
{
  const calStore = new CalibrationStore();
  registerMerachS09CalibrationProfile(calStore);
  const device = new MerachDevice(calStore);
  device._params = await calStore.load(MERACH_S09_DEVICE_TYPE);
  let fakeNow = 1_000_000;
  device._now = () => fakeNow;

  // Timer packet (type 0) before init
  const timerPkt = new Uint8Array(12);
  timerPkt[0] = 0; timerPkt[4] = 10; timerPkt[10] = 42;
  device._handlePacket(timerPkt);
  check('timer packet sets elapsedSeconds', device.metrics.elapsedSeconds === 42);
  check('timer packet seeds calories from bikeIntegerCal when not yet initialized', device.metrics.calories === 10);

  // First telemetry packet (type 117) — initialization only, no metrics set
  const initPkt = new Uint8Array(12);
  initPkt[0] = 117; initPkt[2] = 200; initPkt[3] = 0;
  initPkt[4] = 244; initPkt[5] = 1; initPkt[7] = 5;
  device._handlePacket(initPkt);
  check('first telemetry packet does not set power (init-only)', device.metrics.power === null);

  // Second telemetry packet — real delta, within 5s pedaling window
  fakeNow += 1000;
  const telePkt = new Uint8Array(12);
  telePkt[0] = 117; telePkt[2] = 210; telePkt[3] = 0;
  telePkt[4] = 8; telePkt[5] = 2; telePkt[7] = 5; // ticks=520
  device._handlePacket(telePkt);

  check('cadence = pulse / 2', device.metrics.cadence === 105);
  check('speed > 0 when cadence > 0', device.metrics.speed > 0);
  check('power > 0 when pedaling at resistance 5', device.metrics.power > 0);
  check('isManned true while pedaling', device.metrics.isManned === true);
  check('distance accumulates', device.metrics.distanceMiles > 0);
  check('resistance reflects packet byte', device.metrics.resistance === 5);

  // toPartialData() bridges to session.pushData()
  const partial = device.toPartialData();
  check('toPartialData includes power', typeof partial.power === 'number');
  check('toPartialData converts speed to km/h (> mph value)', partial.speed > device.metrics.speed);

  // Stale: no tick change → isManned should drop after >5s
  fakeNow += 6000;
  const stalePkt = new Uint8Array(12);
  stalePkt[0] = 117; stalePkt[2] = 210; stalePkt[3] = 0;
  stalePkt[4] = 8; stalePkt[5] = 2; stalePkt[7] = 5; // same ticks → deltaTicks = 0
  device._handlePacket(stalePkt);
  check('power zeroes out when no pedal motion for >5s', device.metrics.power === 0);
}

console.log('merach-device.js (16-bit calorie + timer counters, decoded from a real ride log)');
{
  // Type-0 packets carry two little-endian 16-bit counters: calories = d[4] + 256*d[5] and
  // timer seconds = d[10] + 256*d[11]. In a captured 26-minute ride d[5] ticked 0 -> 1 exactly
  // when d[4] rolled 255 -> 0, and d[11] ticked at every d[10] rollover (every 256 s of bike time).
  const calStore = new CalibrationStore();
  registerMerachS09CalibrationProfile(calStore);
  const device = new MerachDevice(calStore);
  device._params = await calStore.load(MERACH_S09_DEVICE_TYPE);
  let fakeNow = 1_000_000;
  device._now = () => fakeNow;

  const timerPkt = (calLo, calHi, tLo, tHi) => {
    const p = new Uint8Array(12);
    p[0] = 0; p[4] = calLo; p[5] = calHi; p[10] = tLo; p[11] = tHi;
    return p;
  };
  let ticks = 1000;
  const telemetryPkt = () => {           // pedaling: the tick counter advances every packet
    ticks += 25;
    const p = new Uint8Array(11);
    p[0] = 117; p[2] = 200; p[3] = 0;    // pulse 200 -> 100 rpm
    p[4] = ticks & 255; p[5] = ticks >> 8; p[7] = 5;
    return p;
  };
  const ride = () => { fakeNow += 1000; device._handlePacket(telemetryPkt()); };

  device._handlePacket(timerPkt(250, 0, 3, 0));
  check('calories seed from the 16-bit counter', device.metrics.calories === 250);
  device._handlePacket(telemetryPkt());  // first telemetry packet: init only
  for (let cal = 251; cal <= 255; cal++) { device._handlePacket(timerPkt(cal, 0, cal - 247, 0)); ride(); }
  check('just below the rollover the total follows the bike (255)',
    device.metrics.calories >= 254.5 && device.metrics.calories <= 255.49);

  device._handlePacket(timerPkt(0, 1, 9, 0)); ride();   // d[4] rolls 255 -> 0 while d[5] ticks 0 -> 1
  check('calorie rollover (d[4] 255->0, d[5] 0->1) keeps counting at 256, not back at 0',
    device.metrics.calories >= 255.5 && device.metrics.calories <= 256.49);
  check('calories never drop across the rollover', device.metrics.calories > 255);

  device._handlePacket(timerPkt(110, 1, 227, 0)); ride();
  check('calories above 255 stay tethered to the bike (110 + 256 = 366)',
    device.metrics.calories >= 365.5 && device.metrics.calories <= 366.49);

  device._handlePacket(timerPkt(110, 1, 227, 5));
  check('timer is 16-bit: d[10]=227, d[11]=5 -> 1507 s', device.metrics.elapsedSeconds === 1507);
  device._handlePacket(timerPkt(110, 1, 255, 0));
  const before = device.metrics.elapsedSeconds;
  device._handlePacket(timerPkt(110, 1, 0, 1));
  check('timer rolls 255 -> 256 instead of back to 0', before === 255 && device.metrics.elapsedSeconds === 256);
  device._handlePacket(timerPkt(110, 1, 3, 1));
  check('timer keeps counting past the rollover (259 s)', device.metrics.elapsedSeconds === 259);

  const short = new Uint8Array(11); short[0] = 0; short[4] = 7; short[10] = 9;  // no d[11]: low bytes only, no NaN
  device._handlePacket(short);
  check('a short type-0 packet still decodes from its low bytes', device.metrics.elapsedSeconds === 9);
}

console.log('merach-device.js (calibration solvers)');
{
  const calStore = new CalibrationStore();
  registerMerachS09CalibrationProfile(calStore);
  await calStore.load(MERACH_S09_DEVICE_TYPE);

  const afterSpeed = await calStore.calibrate(MERACH_S09_DEVICE_TYPE, 'speed',
    { computed: 19.565, reference: 20 });
  check('speed calibration reduces ticksPerMile (inverse relationship)', afterSpeed.ticksPerMile < 966);

  const afterPower = await calStore.calibrate(MERACH_S09_DEVICE_TYPE, 'power',
    { reference: 350, speedMph: 19.565, resistance: 5 });
  check('power calibration solves wattsPerResistance', afterPower.wattsPerResistance > 13.5);

  let threw = false;
  try { await calStore.calibrate(MERACH_S09_DEVICE_TYPE, 'power', { reference: 100, speedMph: 10, resistance: 0 }); }
  catch { threw = true; }
  check('power calibration rejects resistance=0', threw);

  const afterZero = await calStore.calibrate(MERACH_S09_DEVICE_TYPE, 'powerZeroResistance',
    { reference: 40, speedMph: 15 });
  check('powerZeroResistance solves baseDragCoeff', closeTo(afterZero.baseDragCoeff, 40 / Math.pow(15, 1.8), 1e-9));
}

console.log('proform-device.js (packet parsing)');
{
  const calStore = new CalibrationStore();
  registerProform750rCalibrationProfile(calStore);
  const device = new Proform750rDevice(calStore);
  device._params = await calStore.load(PROFORM_750R_DEVICE_TYPE);

  // Main telemetry frame (0x00 0x12 ...) — power, resistance, distance.
  const telePkt = new Uint8Array(20);
  telePkt[0] = 0x00; telePkt[1] = 0x12;
  telePkt[2] = 0x01; telePkt[3] = 0x04; telePkt[4] = 0x02; telePkt[5] = 0x2e; // known subtype
  telePkt[11] = 0x08;                          // raw resistance code -> level 5
  telePkt[12] = 0xb4; telePkt[13] = 0x00;      // power = 180 (LE u16)
  telePkt[14] = 0xf4; telePkt[15] = 0x01;      // raw distance = 500 (LE u16)
  device._handlePacket(telePkt);

  check('telemetry frame decodes power', device.metrics.power === 180);
  check('telemetry frame decodes resistance via code lookup', device.metrics.resistance === 5);
  check('telemetry frame applies default 1 m/unit distance coefficient', device.metrics.distanceMeters === 500);

  // A run of 0xFF across bytes 12-19 means "nothing to report yet" — must
  // be ignored rather than read as power=65535 etc.
  const placeholderDevice = new Proform750rDevice(calStore);
  const placeholderPkt = new Uint8Array(20);
  placeholderPkt.set(telePkt.subarray(0, 12));
  placeholderPkt.fill(0xff, 12, 20);
  placeholderDevice._handlePacket(placeholderPkt);
  check('placeholder telemetry frame (0xFF tail) leaves power unset', placeholderDevice.metrics.power === null);

  // Stroke-rate frame (0xff 0x11 ...) — bytes 2-9 must be zero for this shape.
  const strokePkt = new Uint8Array(20);
  strokePkt[0] = 0xff; strokePkt[1] = 0x11;
  strokePkt[12] = 22; // stroke rate
  device._handlePacket(strokePkt);
  check('stroke frame sets strokeRate', device.metrics.strokeRate === 22);

  // Stale/transitional stroke frame: rate 0 but a nonzero leftover period
  // means "don't update" rather than dropping cadence to 0 mid-stroke.
  const staleStrokePkt = new Uint8Array(20);
  staleStrokePkt[0] = 0xff; staleStrokePkt[1] = 0x11;
  staleStrokePkt[12] = 0; staleStrokePkt[13] = 10; // strokeRate=0, strokePeriod=10
  device._handlePacket(staleStrokePkt);
  check('stale stroke frame (rate 0, nonzero period) leaves strokeRate unchanged', device.metrics.strokeRate === 22);

  // Unknown raw resistance codes fall back to level 1 rather than throwing/undefined.
  const unknownResistancePkt = telePkt.slice();
  unknownResistancePkt[11] = 0x02; // not in RESISTANCE_CODE_TO_LEVEL
  device._handlePacket(unknownResistancePkt);
  check('unknown resistance code falls back to level 1', device.metrics.resistance === 1);

  // toPartialData() bridges to session.pushData() — same shape as MerachDevice's.
  const partial = device.toPartialData();
  check('toPartialData includes power', typeof partial.power === 'number');
  check('toPartialData maps strokeRate to cadence', partial.cadence === device.metrics.strokeRate);
  // Speed isn't a native field in this protocol, but it is derived from the distance counter
  // (see _handleTelemetryFrame), so it is null until that can be computed and a real,
  // non-negative number after — and toPartialData passes it straight through.
  check('toPartialData passes through the speed derived from the distance counter',
    partial.speed === (device.metrics.speed ?? null) && (partial.speed === null || (Number.isFinite(partial.speed) && partial.speed >= 0)));
}

console.log('proform-device.js (calibration solvers)');
{
  const calStore = new CalibrationStore();
  registerProform750rCalibrationProfile(calStore);
  await calStore.load(PROFORM_750R_DEVICE_TYPE);

  const after = await calStore.calibrate(PROFORM_750R_DEVICE_TYPE, 'distance',
    { computed: 500, reference: 550 });
  check('distance calibration scales distanceMetersPerRawUnit toward reference',
    closeTo(after.distanceMetersPerRawUnit, 1.1));
}

console.log('fitdays-device.js (weight decode + composition-record pairing)');
{
  const KG_TO_LB = 1 / 0.45359237;

  // Ground truth from smart_scale_ble_cheatsheet.md §2.1/§2.3/§3.1 — the
  // 237.0 lb reading (162001_full), the richest of the two decoded anchors.
  // Building the test packets from these exact bytes (rather than made-up
  // ones) means a failure here means a real decode regression, not a test
  // that just checks its own assumptions.
  const notify = new Uint8Array([
    0x46, 0x07, 0x00, 0xa2, 0x03, 0x19, 0x01, // counter, 07 00 a2 XX(=settled) 19 YY
    0xa3, 0xf6,                               // byte7 (weight=163), byte8 (246)
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,              // bytes 9-18, always 0
    0x38,                                      // byte19 (56)
  ]);
  // The 32-byte composition record (§3.1's table), split into its two
  // 16-byte indicate-channel halves the way _handleIndicateValue() expects.
  const record32 = new Uint8Array([
    0xa3, 0x19, 0x01, 0xa3, 0xf6, 0x00, 0x00, 0xfa,       // header + weight/byte8 echo + unknowns
    0x0a, 0x9b, 0x09, 0xd3, 0x06, 0x40, 0x06, 0xa4,       // 20kHz: L-arm, R-arm, L-leg, R-leg
    0x00, 0xf0, 0x09, 0x33, 0x08, 0x89, 0x05, 0x69, 0x05, 0xb9, // unknown gap + 100kHz limbs
    0, 0, 0, 0, 0, 0,                                      // padding
  ]);
  const wrapIndicate = part => {
    const d = new Uint8Array(20);
    d[0] = 0x99; // indicate channel's own counter namespace — just needs to match between the two halves
    d[1] = FITDAYS_COMPOSITION_TAG;
    d[2] = part;
    d.set(record32.slice(part === FITDAYS_COMPOSITION_PART.A ? 0 : 16, part === FITDAYS_COMPOSITION_PART.A ? 16 : 32), 3);
    return d;
  };

  // Case 1: handle held + height on file (the fix this pass made possible —
  // connectFitdaysScale() now actually passes profile.heightCm through).
  {
    const device = new FitdaysScaleDevice();
    device._heightCm = 162.6; // 5'4" — the cheatsheet's calibration subject
    const received = [];
    device._onData = r => received.push(r);

    const reading = device._decodePacket(notify);
    check('decodes the 237.0 lb ground-truth byte within 0.5 lb', Math.abs(reading.weightKg * KG_TO_LB - 237.0) < 0.5);
    check('XX=0x03 decodes as settled', reading.settled === true);

    device._emitSettledWeight(reading);
    check('settled weight waits for a possible composition record rather than emitting immediately', received.length === 0);

    device._handleIndicateValue(wrapIndicate(FITDAYS_COMPOSITION_PART.A));
    check('one indicate half is not enough to resolve the pair', received.length === 0);
    device._handleIndicateValue(wrapIndicate(FITDAYS_COMPOSITION_PART.B));

    check('matching composition record emits exactly one merged reading', received.length === 1);
    const merged = received[0] ?? {};
    check('compositionEstimated is true once impedance + height are both present', merged.compositionEstimated === true);
    check('bodyFatPct filled in', typeof merged.bodyFatPct === 'number');
    check('muscleMassKg filled in', typeof merged.muscleMassKg === 'number');
    check('boneMassKg filled in', typeof merged.boneMassKg === 'number');
    check('bodyWaterKg filled in', typeof merged.bodyWaterKg === 'number');
    check('visceralFatRating filled in', typeof merged.visceralFatRating === 'number');
    check('basalMetabolicRateKcal filled in', typeof merged.basalMetabolicRateKcal === 'number');
    check('decoded raw Left Arm 20kHz matches the cheatsheet\'s 271.5\u03a9', closeTo(merged.raw?.impedance20kHzOhm?.leftArm, 271.5, 0.05));
    check('decoded raw Right Leg 100kHz matches the cheatsheet\'s 146.5\u03a9', closeTo(merged.raw?.impedance100kHzOhm?.rightLeg, 146.5, 0.05));
  }

  // Case 2: handle held but NO height on file — the exact bug this pass
  // fixed in app.js (connectFitdaysScale() previously never passed
  // profile.heightCm at all, so this path was unreachable in practice even
  // though every byte on the wire was already being decoded correctly).
  // Guards against that regressing silently again.
  {
    const device = new FitdaysScaleDevice();
    // device._heightCm left at its constructor default (null).
    const received = [];
    device._onData = r => received.push(r);

    device._emitSettledWeight(device._decodePacket(notify));
    device._handleIndicateValue(wrapIndicate(FITDAYS_COMPOSITION_PART.A));
    device._handleIndicateValue(wrapIndicate(FITDAYS_COMPOSITION_PART.B));

    check('composition record still correlates without height...', received.length === 1);
    const merged = received[0] ?? {};
    check('...but compositionEstimated is false when heightCm is missing', merged.compositionEstimated === false);
    check('bodyFatPct stays null without height', merged.bodyFatPct == null);
    check('boneMassKg stays null without height', merged.boneMassKg == null);
    check('visceralFatRating stays null without height', merged.visceralFatRating == null);
    check('basalMetabolicRateKcal stays null without height', merged.basalMetabolicRateKcal == null);
  }

  // Case 3: a composition record whose weight/byte8 echo doesn't match the
  // pending settled reading is dropped rather than misapplied — guards the
  // correlation itself, not just the happy path.
  {
    const device = new FitdaysScaleDevice();
    device._heightCm = 162.6;
    const received = [];
    device._onData = r => received.push(r);

    const otherNotify = notify.slice();
    otherNotify[7] = 0x90; // a different weight byte (144 -> ~81.4 lb, per §2.1)
    device._emitSettledWeight(device._decodePacket(otherNotify));
    device._handleIndicateValue(wrapIndicate(FITDAYS_COMPOSITION_PART.A)); // still the 237.0 lb record
    device._handleIndicateValue(wrapIndicate(FITDAYS_COMPOSITION_PART.B));

    check('a composition record for a different weight is not applied to the pending reading', received.length === 0);
  }

  // _decodeWeightByte()'s wraparound (cheatsheet §2.1) — spot-check a
  // low-end and a high-end point against __internal directly.
  const { _decodeWeightByte } = fitdaysInternal;
  const hintKg81 = 81.4 * 0.45359237;
  check('wraparound: byte 144 near an 81lb hint decodes to ~81.4 lb', closeTo(_decodeWeightByte(144, hintKg81) * KG_TO_LB, 81.35, 0.5));
}

console.log('gatt-names.js (UUID normalization + labeling)');
{
  const battery = normalizeUuid(0x180f);
  check('normalizeUuid() expands a 16-bit number to the SIG base UUID', battery.full === '0000180f-0000-1000-8000-00805f9b34fb');
  check('normalizeUuid() also returns the short 0x form', battery.short === '0x180f');

  check('labelFor() resolves a known service name + short UUID', labelFor(0x180f, 'service') === 'Battery Service (0x180f)');
  check('labelFor() falls back to "Unknown X (uuid)" for an unrecognized 16-bit UUID', labelFor(0x1234, 'service') === 'Unknown Service (0x1234)');
  check('labelFor() resolves a known descriptor (CCCD)', labelFor(0x2902, 'descriptor') === 'Client Characteristic Configuration (0x2902)');

  check('DEFAULT_OPTIONAL_SERVICES includes Battery Service', DEFAULT_OPTIONAL_SERVICES.includes(0x180f));
}

console.log('value-decode.js (generic decode + BLE Debug Console descriptor decoders)');
{
  const bytes = (...b) => new DataView(new Uint8Array(b).buffer);

  check('toHex() renders space-separated uppercase pairs', toHex(bytes(0x01, 0xab)) === '01 AB');
  check('toAscii() prints printable bytes and dots the rest', toAscii(bytes(0x41, 0x00, 0x42)) === 'A\u00b7B');

  const battery = decodeValue(bytes(0x4b), 0x2a19);
  check('decodeValue() applies the known Battery Level (0x2a19) decoder', battery.known === '75%');

  // Client Characteristic Configuration (0x2902) — the descriptor the
  // debug console's per-characteristic "Read" button under a subscribed
  // characteristic is really for: confirming Notify/Stop actually landed.
  const cccdOff = decodeValue(bytes(0x00, 0x00), 0x2902);
  check('CCCD decodes 0x0000 as both off', cccdOff.known === 'notifications off, indications off');
  const cccdNotify = decodeValue(bytes(0x01, 0x00), 0x2902);
  check('CCCD decodes bit 0 as notifications on', cccdNotify.known === 'notifications on');
  const cccdBoth = decodeValue(bytes(0x03, 0x00), 0x2902);
  check('CCCD decodes bits 0+1 as notifications + indications on', cccdBoth.known === 'notifications on, indications on');

  // Characteristic User Description (0x2901) — plain UTF-8 string.
  const userDesc = decodeValue(new DataView(new TextEncoder().encode('Cadence').buffer), 0x2901);
  check('User Description (0x2901) decodes as UTF-8 text', userDesc.known === 'Cadence');

  const unknownUuid = decodeValue(bytes(0x01), 0x9999);
  check('decodeValue() falls back to null known-decode for an unrecognized UUID', unknownUuid.known === null);
}

console.log('reconnect-cushion.js (post-(re)connect grace period for BLE devices — see app.js#onAuxData/onTrainerData)');
{
  let fakeNow = 1_000_000;
  const cushion = new ReconnectCushion(2500, () => fakeNow);

  check('a device never marked connected is never settling', cushion.isSettling('never-seen') === false);

  cushion.markConnected('hr-monitor');
  check('settling immediately after markConnected()', cushion.isSettling('hr-monitor') === true);

  fakeNow += 1000; // 1s into the 2.5s window
  check('still settling partway through the cushion', cushion.isSettling('hr-monitor') === true);
  check('a different device sharing no state is unaffected', cushion.isSettling('other-device') === false);

  fakeNow += 1499; // 2.499s total — just under the boundary
  check('still settling one tick before the cushion ends', cushion.isSettling('hr-monitor') === true);

  fakeNow += 2; // 2.501s total — now past it
  check('no longer settling once the cushion elapses', cushion.isSettling('hr-monitor') === false);

  // Reconnecting mid-cushion (or any time) restarts the window from now,
  // not from the original markConnected() call.
  cushion.markConnected('hr-monitor');
  fakeNow += 2000;
  check('still settling 2s into a freshly-restarted window', cushion.isSettling('hr-monitor') === true);
  cushion.markConnected('hr-monitor'); // restart again before the first finishes
  fakeNow += 2000;
  check('restarting mid-cushion pushes the deadline out again', cushion.isSettling('hr-monitor') === true);

  cushion.clear('hr-monitor');
  check('clear() ends a running cushion immediately', cushion.isSettling('hr-monitor') === false);
  cushion.clear('never-seen'); // must not throw for a device with no cushion running
  check('clear() on an unknown device is a harmless no-op', cushion.isSettling('never-seen') === false);
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
else console.log('All BLE + Merach + Proform checks passed.');
