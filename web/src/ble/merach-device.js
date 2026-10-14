// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/merach-device.js
 *
 * Wraps a Merach MRK-S09(-family) stationary bike. The device advertises
 * using the standard FTMS service UUID (0x1826) and notifies on the standard
 * Indoor Bike Data characteristic (0x2AD2) — but the payload is a fully
 * proprietary fixed-layout packet, NOT the FTMS flags-based format. This is
 * a "fake FTMS" pattern common in budget fitness equipment.
 *
 * Protocol confirmed via github.com/seancconner/FitnessTracker (BikeTracker.py):
 *   Packet type 0   (d[0] === 0)   — timer/calorie heartbeat
 *   Packet type 117 (d[0] === 117) — cadence/ticks/resistance telemetry
 *
 * Multi-byte fields are little-endian 16-bit (low byte first):
 *   type 0   : calories = d[4] + 256*d[5]   timer (s) = d[10] + 256*d[11]
 *   type 117 : pulse    = d[2] + 256*d[3]   ticks     = d[4] + 256*d[5]
 * Read only the low byte of calories or the timer and they wrap back to 0 every
 * 256 (kcal / seconds): decoded from a ride log, d[5] ticked 0->1 exactly when d[4]
 * rolled 255->0, and d[11] ticked at every d[10] rollover.
 *
 * This device exposes a real, controllable FTMS control point — same UUID
 * and write format stock FTMS trainers use. It registers as
 * CONTROLLABLE_TRAINER + POWER_SOURCE + CADENCE_SOURCE + SPEED_SOURCE, and
 * supports start()/stop() and setResistanceTarget(level) (see the
 * control-point section below).
 *
 * Sensor coefficient calibration is handled by ble/sensor-calibration.js.
 * The CalibrationStore is injected so tests can use an isolated instance.
 */

import { FTMS_SERVICE, CHAR, OP, RESULT } from './ftms-constants.js';
import { CalibrationStore, proportionalSolver } from './sensor-calibration.js';
import { roles, ROLES } from './roles.js';
import { reconnect } from './reconnect.js';
import { bleTransport } from './transport/index.js';
import { createSample } from '../core/sample.js';

// Resistance-write retry tuning — ported from old ftms.js's setResistanceTarget(),
// which wrapped its control-point write in `control.writeWithRetry(payload, 8, 250)`.
// Only resistance writes get this treatment (same as the old code): they're the ones
// firing every ~1.5s out of control/smart-erg.js's loop, so they're the ones that see
// contention on the control-point characteristic. start()/stop() stay single-shot.
const RESISTANCE_WRITE_RETRIES    = 8;   // retry attempts after an initial failed write
const RESISTANCE_WRITE_RETRY_DELAY_MS = 250; // wait between attempts

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Debug logging (temporary) ─────────────────────────────────────────────
// For cross-checking the byte-offset assumptions above (d[2]/d[3] = pulse,
// d[4]/d[5] = ticks, d[7] = resistance in telemetry packets; d[4]/d[5] = calories,
// d[10]/d[11] = timer in heartbeat packets) against what the bike's own console
// shows. Flip DEBUG_LOG_BYTES to false (or delete this block and its two
// call sites in _handleTimerPacket/_handleTelemetryPacket) once you're done
// verifying — it's not meant to ship on. Throttled per packet type so a
// multi-minute ride doesn't flood devtools with a line per notification.
const DEBUG_LOG_BYTES   = false;
const LOG_INTERVAL_MS   = 2000; // min ms between logged lines, per packet type

// ─── Device type & calibration profile ───────────────────────────────────────

export const MERACH_S09_DEVICE_TYPE = 'merach-s09';

/**
 * Default coefficients from BikeTracker.py::MerachS09ProTracker.__init__.
 * These reflect one specific unit — use the calibrator to tune for yours.
 */
export const MERACH_S09_DEFAULT_PARAMS = Object.freeze({
  ticksPerMile:      { value: 966,  unit: 'ticks/mi',  description: 'Distance sensor ticks per mile' },
  cadenceCoeff:      { value: 3.0,  unit: 'unitless',   description: 'Speed-per-cadence scaling factor' },
  wattsPerResistance:{ value: 13.5, unit: 'W/level',    description: 'Watts added per resistance level' },
  baseDragCoeff:     { value: 1.25, unit: 'unitless',   description: 'Aero/rolling drag coefficient' },
  // The per-tick calorie formula (power x seconds-per-rev / 4184 / 0.24) runs about 4.2x faster than
  // this bike's own calorie counter, but tracks its SHAPE closely (the ratio held 4.17-4.25x across a
  // 26-minute ride log). This is the factor that brings it onto the bike's counter. It's only the
  // starting value: MerachDevice re-learns it from the bike's own whole-kcal steps while you ride and
  // saves the result here (see _learnCalorieScale).
  calorieScale:      { value: 0.237, unit: 'unitless',   description: 'Bike kcal per kcal of the raw power-based calorie model (learned from the bike)' },
});

/**
 * Register the S09 calibration profile onto a CalibrationStore.
 * Called automatically for the shared store on module load.
 * @param {CalibrationStore} store
 */
export function registerMerachS09CalibrationProfile(store) {
  store.registerDeviceType(MERACH_S09_DEVICE_TYPE, {
    params: MERACH_S09_DEFAULT_PARAMS,
    solvers: {
      // speed ∝ cadence * cadenceCoeff / ticksPerMile (inverse denominator)
      speed:    proportionalSolver('ticksPerMile', { inverse: true }),
      distance: proportionalSolver('ticksPerMile', { inverse: true }),

      // power = baseDragCoeff * speed^1.8 + resistance * wattsPerResistance
      // Solve for wattsPerResistance given a reference power reading at a
      // known speed and resistance level. Requires ctx.speedMph + ctx.resistance.
      power: (params, ctx) => {
        if (!(ctx.resistance > 0)) throw new Error(
          'power calibration requires ctx.resistance > 0 — use powerZeroResistance at resistance 0'
        );
        const aeroWatts = params.baseDragCoeff * (ctx.speedMph ** 1.8);
        return { ...params, wattsPerResistance: (ctx.reference - aeroWatts) / ctx.resistance };
      },

      // Fit the calorie model to the bike's own counter: ctx.computed = kcal the raw (unscaled) model
      // accumulated over a stretch, ctx.reference = kcal the bike's counter gained over the same stretch.
      calories: (params, ctx) => {
        if (!(ctx.computed > 0) || !(ctx.reference > 0)) throw new Error('calories calibration requires ctx.computed > 0 and ctx.reference > 0');
        return { ...params, calorieScale: ctx.reference / ctx.computed };
      },

      // Isolate the drag coefficient with a coast at resistance 0.
      powerZeroResistance: (params, ctx) => {
        if (!(ctx.speedMph > 0)) throw new Error('powerZeroResistance requires ctx.speedMph > 0');
        return { ...params, baseDragCoeff: ctx.reference / (ctx.speedMph ** 1.8) };
      },
    },
  });
}

// Shared singleton store — same pattern as the rest of the app's singletons.
export const merachCalibrationStore = new CalibrationStore();
registerMerachS09CalibrationProfile(merachCalibrationStore);

// ─── MerachDevice ─────────────────────────────────────────────────────────────

// Exported so app.js can fold Merach into the single "Controller" chooser —
// Merach bikes are a controller, just one identified by name instead of by
// exposing a real (non-"fake") FTMS control point.
export const MERACH_NAME_PREFIX = 'MRK-S09';
const NAME_PREFIX = MERACH_NAME_PREFIX;

export class MerachDevice extends EventTarget {
  /** @param {CalibrationStore} [calibrationStore] */
  constructor(calibrationStore = merachCalibrationStore) {
    super();
    this._calibration = calibrationStore;
    this._params      = null; // loaded during connect()

    this.id      = null;
    this.name    = null;
    this._device = null;
    this._onData = null;
    this.controlPoint = null; // acquired in _connectDevice() — see ble/ftms-device.js for the write/notify pattern
    this._controlRequested = false;
    this._pendingOp = null; // resolves the indication for the last written control-point op

    // ✅ CONFIRMED: this unit's real resistance range is 1–16, not the
    // generic "1–20, confirm against yours" placeholder setResistanceTarget()
    // used to carry. Read by control/smart-erg.js's SmartErgMode (via
    // ergResistanceRange, NOT resistanceRange — see that constructor's
    // comment for why the two are kept separate) to clamp the ERG loop's
    // resistance ceiling to what this hardware actually supports.
    this.ergResistanceRange = { min: 1, max: 16 };

    // Published metric surface (matches the shape other device wrappers use)
    this.metrics = {
      power: null, cadence: null, speed: null, resistance: null,
      distanceMiles: 0, calories: 0, elapsedSeconds: 0, isManned: false,
    };

    // Internal state — ported from BikeTracker.py::MerachS09ProTracker
    this._initialized    = false;
    this._lastTotalTicks = 0;
    this._lastPulse      = 0;
    this._resistance     = 0;
    this._totalDistanceMiles = 0;
    this._totalCalories  = 0;
    this._bikeIntegerCal = 0;
    this._lastBikeCal    = 0;  // previous packet's bike counter — a drop means the bike cleared itself
    this._calOffset      = 0;  // kcal earned before the bike's last self-reset; see _handleTimerPacket
    // Learning the calorie scale from the bike's own counter — see _learnCalorieScale().
    this._learnBikeBase  = null; // bike counter when the current learning window began (null = not started)
    this._learnRaw       = 0;    // raw (unscaled) model kcal accumulated over that window
    this._learnedScale   = null; // scale fitted this ride; null until the bike has counted enough kcal
    this._lastPersistGain = 0;   // bike kcal gain at the last time the scale was saved
    this._rawTimer       = 0;
    this._lastPedalTime  = 0;
    this._lastInputTime  = 0;
    this._lastPacketTime = 0;
    this._speedHistory   = []; // max 30 entries

    this._lastLogAt = { timer: 0, telemetry: 0 }; // see DEBUG_LOG_BYTES above
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  /**
   * Open the BLE chooser and connect.
   * @param {Function} onData  Receives the metrics object on each packet.
   */
  async connect(onData) {
    this._onData = onData;

    const device = await bleTransport.requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }],
      optionalServices: [FTMS_SERVICE],
    });

    await this._connectDevice(device);
    reconnect.remember(device, 'merach');
  }

  /**
   * Connect to a specific BluetoothDevice (used by reconnect.js auto-reconnect).
   * @param {BluetoothDevice} device
   * @param {Function} [onData]
   */
  async connectDevice(device, onData) {
    if (onData) this._onData = onData;
    await this._connectDevice(device);
  }

  async _connectDevice(device) {
    this._params = await this._calibration.load(MERACH_S09_DEVICE_TYPE);

    this._device = device;
    this.id      = device.id;
    this.name    = device.name ?? 'Merach S09';

    device.addEventListener('gattserverdisconnected', () => this._onDisconnect());

    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(FTMS_SERVICE);

    // Same control-point UUID stock FTMS trainers use — the write format is
    // standard, not a hack. Acquired here so it's available once control
    // (setResistanceTarget(), etc.) is wired up on top of it.
    this.controlPoint = await service.getCharacteristic(CHAR.CONTROL_POINT);
    await this.controlPoint.startNotifications();
    this.controlPoint.addEventListener('characteristicvaluechanged', (e) =>
      this._handleControlPointIndication(e.target.value));

    // Same UUID as FTMS Indoor Bike Data — proprietary payload, not FTMS format.
    const char    = await service.getCharacteristic(CHAR.INDOOR_BIKE_DATA);

    await char.startNotifications();
    char.addEventListener('characteristicvaluechanged', (e) => {
      this._handlePacket(new Uint8Array(e.target.value.buffer));
      if (this._onData) this._onData({ ...this.metrics });
    });

    // Register roles — same pattern as FtmsDevice and MoxyDevice
    roles.register(this.id, [
      ROLES.CONTROLLABLE_TRAINER,
      ROLES.POWER_SOURCE,
      ROLES.CADENCE_SOURCE,
      ROLES.SPEED_SOURCE,
    ]);

    console.info('[merach] Connected:', this.name);
  }

  _onDisconnect() {
    roles.unregister(this.id);
    console.info('[merach] Disconnected:', this.name);
    this.dispatchEvent(new CustomEvent('disconnected'));
  }

  // ─── Control-point writes ───────────────────────────────────────────────────
  // Same UUID + op codes as stock FTMS (ble/ftms-device.js) — this unit's
  // write format was confirmed standard, not a proprietary hack.

  async _requestControlOnce() {
    if (this._controlRequested) return;
    await this._writeControlPoint([OP.REQUEST_CONTROL]);
    this._controlRequested = true;
  }

  async _writeControlPoint(bytes) {
    const buf = Uint8Array.from(bytes);
    const resultPromise = new Promise((resolve) => { this._pendingOp = resolve; });
    await this.controlPoint.writeValueWithResponse(buf);
    const result = await resultPromise;
    if (result !== RESULT.SUCCESS) {
      throw new Error(`Merach control point op 0x${bytes[0].toString(16)} failed: result 0x${result.toString(16)}`);
    }
    return result;
  }

  /**
   * Same as _writeControlPoint(), but retries on failure — either
   * writeValueWithResponse() itself rejecting (e.g. "GATT operation already
   * in progress" when a write lands while another characteristic is mid-
   * notify) or the device indicating a non-SUCCESS result.
   * REF: old-version/reference-files/src/ble/ftms/ftms.js — setResistanceTarget() writeWithRetry call
   * @param {number[]} bytes
   * @param {number} retries  max retry attempts after the first failure
   * @param {number} delayMs  wait between attempts
   */
  async _writeControlPointWithRetry(bytes, retries, delayMs) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this._writeControlPoint(bytes);
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          console.warn(
            `[merach] control-point write failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delayMs}ms:`,
            err.message,
          );
          await wait(delayMs);
        }
      }
    }
    throw lastErr;
  }

  _handleControlPointIndication(dv) {
    // byte0 = 0x80 (response code), byte1 = request op code, byte2 = result code
    if (dv.byteLength >= 3 && dv.getUint8(0) === OP.RESPONSE_CODE) {
      this._pendingOp?.(dv.getUint8(2));
      this._pendingOp = null;
    }
  }

  async start() {
    await this._requestControlOnce();
    await this._writeControlPoint([OP.START]);
  }

  async stop() {
    try { await this._writeControlPoint([OP.STOP, 0x01]); } catch { /* best effort */ }
  }

  /**
   * Set the trainer's target resistance level (1–16 — see
   * this.ergResistanceRange, confirmed against real hardware). Encoded at
   * FTMS's standard 0.1-unit precision, same as
   * ble/ftms-device.js#setResistanceTarget().
   *
   * Retries up to RESISTANCE_WRITE_RETRIES times, RESISTANCE_WRITE_RETRY_DELAY_MS
   * apart, on failure — same 8-retries/250ms tuning as old ftms.js's
   * setResistanceTarget(), which needed it to keep up with resistance writes
   * firing every ~1.5s out of the smart-erg loop.
   * @param {number} level
   */
  async setResistanceTarget(level) {
    await this._requestControlOnce();
    const v = Math.round(level * 10);
    const bytes = [OP.SET_TARGET_RESISTANCE, v & 0xff, (v >> 8) & 0xff];
    await this._writeControlPointWithRetry(bytes, RESISTANCE_WRITE_RETRIES, RESISTANCE_WRITE_RETRY_DELAY_MS);
  }

  disconnect() {
    this._device?.gatt?.disconnect();
  }

  get isConnected() {
    return this._device?.gatt?.connected ?? false;
  }

  // ─── Calibration ─────────────────────────────────────────────────────────────

  /**
   * Run calibration for a metric and hot-reload the new params (no reconnect needed).
   * @param {'speed'|'distance'|'power'|'powerZeroResistance'} metricName
   * @param {Object} ctx  { computed, reference, ...extra }
   */
  async calibrate(metricName, ctx) {
    this._params = await this._calibration.calibrate(MERACH_S09_DEVICE_TYPE, metricName, ctx);
    return { ...this._params };
  }

  /** Current calibration coefficients in effect. */
  calibrationParams() { return { ...this._params }; }

  // ─── Sample bridge ────────────────────────────────────────────────────────

  /**
   * Build a core/sample.js-compatible Sample from the current metrics.
   * session.js calls pushData() with partial data each BLE notification;
   * this produces the shape for the recording layer.
   */
  toPartialData() {
    return {
      power:      this.metrics.power     ?? null,
      cadence:    this.metrics.cadence   ?? null,
      speed:      this.metrics.speed != null
        ? this.metrics.speed * 1.60934   // mph → km/h for consistency with FTMS
        : null,
      resistance: this.metrics.resistance ?? null,
      // On-device running calorie total — Session prefers this over its own
      // power-based estimate when present (see recording/session.js#_tick).
      calories:   this.metrics.calories ?? null,
    };
  }

  // ─── Packet handling (ported from BikeTracker.py) ─────────────────────────

  _handlePacket(d) {
    const now = this._now();
    if      (d[0] === 0)   this._handleTimerPacket(d, now);
    else if (d[0] === 117) this._handleTelemetryPacket(d, now);
  }

  /**
   * DEBUG_LOG_BYTES helper — logs the raw packet bytes alongside whatever
   * derived fields the caller passed, throttled to LOG_INTERVAL_MS per
   * packet `kind` so it stays readable over a multi-minute ride. No-op
   * entirely when DEBUG_LOG_BYTES is false.
   * @param {'timer'|'telemetry'} kind
   * @param {Uint8Array} d
   * @param {Object} derived  Computed/assigned fields to print alongside the bytes.
   */
  _logPacket(kind, d, derived) {
    if (!DEBUG_LOG_BYTES) return;
    const now = this._now();
    if (now - this._lastLogAt[kind] < LOG_INTERVAL_MS) return;
    this._lastLogAt[kind] = now;

    const bytes = Array.from(d).map((b, i) => `[${i}]=${b}`).join(' ');
    console.info(`[merach:debug] ${kind} raw — ${bytes}`);
    console.info(`[merach:debug] ${kind} derived —`, derived);
  }

  _handleTimerPacket(d, now) {
    // Both are little-endian 16-bit (see the layout at the top of the file). `|` and `<<`
    // treat a missing byte as 0, so a short packet still decodes from its low bytes.
    this._rawTimer       = d[10] | (d[11] << 8);
    this._bikeIntegerCal = d[4]  | (d[5]  << 8);

    // The bike clears its console — calories, timer and ticks all back to 0 — about a minute
    // after the last pedal stroke (seen in a ride log: counters froze at 257 kcal / 1521 s, then
    // zeroed 62 s later with the bike still connected). Resume pedaling after a rest that long
    // and the bike counts up from 0 again. With the 16-bit decode the counter can only go DOWN
    // that way, so bank what's been earned so far and keep counting on top of it; otherwise the
    // tether below would pull the running total back to ~0 and the workout's calories reset.
    if (this._bikeIntegerCal < this._lastBikeCal) {
      this._calOffset = this._totalCalories;
      this._learnBikeBase = null; this._learnRaw = 0; this._lastPersistGain = 0;  // new learning window; keeps the scale it had
    }
    this._lastBikeCal = this._bikeIntegerCal;

    if (!this._initialized && this._bikeIntegerCal > 0) {
      this._totalCalories = this._bikeIntegerCal;
    }

    this._updateStateLogic(this._lastTotalTicks, this._resistance, now);
    this.metrics.elapsedSeconds = this._rawTimer;
    this.metrics.calories       = this._totalCalories;

    this._logPacket('timer', d, {
      'rawTimer (d[10],d[11])':      this._rawTimer,
      'bikeIntegerCal (d[4],d[5])':  this._bikeIntegerCal,
      totalCalories_computed:   this._totalCalories,
      elapsedSeconds:           this.metrics.elapsedSeconds,
    });
  }

  _handleTelemetryPacket(d, now) {
    this._resistance = d[7];

    const pulse = (d[3] * 256) + d[2];
    const ticks = (d[5] * 256) + d[4];

    if (!this._initialized) {
      this._lastTotalTicks = ticks;
      this._lastPulse      = pulse;
      this._initialized    = true;
      this._logPacket('telemetry', d, {
        'pulse (d[2],d[3])': pulse,
        'ticks (d[4],d[5])': ticks,
        'resistance (d[7])': this._resistance,
        note: 'first telemetry packet — seeding only, no metrics computed yet',
      });
      return;
    }

    this._updateStateLogic(ticks, this._resistance, now);

    const deltaTicks     = ticks - this._lastTotalTicks;
    const currentCadence = pulse / 2.0;
    const params         = this._params;
    const speedMph       = (currentCadence * params.cadenceCoeff * 60) / params.ticksPerMile;

    const pedaling = (now - this._lastPedalTime) <= 5000;
    const dialing  = (now - this._lastInputTime) <= 10000;
    const isManned = pedaling || dialing;
    this.metrics.isManned = isManned;

    // currentPower/speedMph are pure functions of currentCadence (computed
    // above from `pulse`, which is live every packet) — they do NOT depend
    // on the distance-tick counter having advanced. Gating them on
    // deltaTicks > 0 made power/speed flicker to 0 on any packet that beat
    // the next tick, which happens more often as cadence drops (fewer ticks
    // per second) even though the rider never stopped pedaling. Cadence was
    // never gated this way, which is why it always read smoothly while
    // power/speed didn't. deltaTicks > 0 still (correctly) gates
    // distance/calorie accumulation below — those genuinely shouldn't move
    // until a new tick has arrived.
    const currentPower = this._calculatePower(speedMph, this._resistance, params);

    if (isManned && deltaTicks > 0) {
      this._totalDistanceMiles += deltaTicks / params.ticksPerMile;

      if (currentCadence > 0) {
        const kcalPerTick = (currentPower * (60.0 / currentCadence)) / 4184.0 / 0.24;
        const rawKcal     = deltaTicks * kcalPerTick;           // what the power model alone says
        if (this._learnBikeBase === null) this._learnBikeBase = this._bikeIntegerCal;
        this._learnRaw      += rawKcal;
        this._totalCalories += rawKcal * this.calorieScale;     // scaled onto the bike's own counter
        this._learnCalorieScale();
      }

      // Tether fractional total to the bike's integer calorie display (plus anything
      // banked before the bike last reset itself — see _handleTimerPacket)
      const bikeTotal = this._calOffset + this._bikeIntegerCal;
      const lo = bikeTotal - 0.5;
      const hi = bikeTotal + 0.49;
      if (this._totalCalories < lo) this._totalCalories = lo;
      else if (this._totalCalories > hi) this._totalCalories = hi;

      this._speedHistory.push(speedMph);
      if (this._speedHistory.length > 30) this._speedHistory.shift();
    }

    if (isManned) {
      this.metrics.power   = currentPower;
      this.metrics.speed   = speedMph;
      this.metrics.cadence = currentCadence;
    } else {
      // Same reasoning as power/speed above: currentCadence is a raw,
      // per-packet reading off `pulse`, and this bike's firmware holds the
      // last nonzero pulse value rather than reporting 0 once the rider
      // stops — so left ungated, cadence can get stuck above 0 indefinitely.
      // That's fatal for SmartErgMode's idle detection (control/smart-erg.js
      // #onPowerSample), which treats `cadence > 0 || watts > 0` as "still
      // pedaling" — a stuck cadence alone blocks auto-rest/auto-pause from
      // ever firing even once watts correctly reaches 0. Gating cadence by
      // the same tick-derived `isManned` signal as power/speed keeps all
      // three metrics consistent and lets auto-pause work again.
      this.metrics.power   = 0;
      this.metrics.speed   = 0;
      this.metrics.cadence = 0;
    }

    this.metrics.resistance    = this._resistance;
    this.metrics.distanceMiles = this._totalDistanceMiles;
    this.metrics.calories      = this._totalCalories;

    this._lastTotalTicks = ticks;
    this._lastPulse      = pulse;

    this._logPacket('telemetry', d, {
      'pulse (d[2],d[3])':    pulse,
      'ticks (d[4],d[5])':    ticks,
      'resistance (d[7])':    this._resistance,
      cadence_rpm_computed:   currentCadence,
      speedMph_computed:      speedMph,
      power_computed:         currentPower,
      distanceMiles_total:    this._totalDistanceMiles,
      calories_total:         this._totalCalories,
      isManned,
    });
  }

  /**
   * The factor applied to the power-based per-tick calories: the scale fitted to the bike's own
   * counter this ride if there is one, else the saved/default `calorieScale` calibration param.
   */
  get calorieScale() {
    return this._learnedScale ?? this._params?.calorieScale ?? MERACH_S09_DEFAULT_PARAMS.calorieScale.value;
  }

  /**
   * Fit the calorie model to what this bike actually counts. The bike only reports whole kcal, but over
   * a stretch of riding its gain divided by the raw model's kcal over the same stretch is the exact
   * scale that makes the per-tick formula reproduce the bike's rate — so the fractional total moves
   * between the bike's whole-number steps at the bike's own pace instead of being pinned to the edge
   * of the +/-0.5 tether. Waits for 20 kcal of bike gain (whole-number rounding is at most ~1 kcal of
   * that, so ~5% worst case, ~2% typical) and keeps refining as the stretch grows. The window restarts
   * if the bike clears its counters; the scale carries over. Saved to the calibration store every
   * 50 kcal so the next ride starts from it.
   */
  _learnCalorieScale() {
    if (this._learnBikeBase === null || !(this._learnRaw > 0)) return;
    const gain = this._bikeIntegerCal - this._learnBikeBase;
    if (gain < 20) return;
    const scale = gain / this._learnRaw;
    if (!(scale >= 0.02 && scale <= 3)) return;  // not plausible for this hardware: ignore, keep the old scale
    this._learnedScale = scale;
    if (gain - this._lastPersistGain >= 50 || this._lastPersistGain === 0) {
      this._lastPersistGain = gain;
      this._persistLearnedScale(gain, this._learnRaw);
    }
  }

  async _persistLearnedScale(gain, raw) {
    try {
      const saved = await this._calibration.calibrate(MERACH_S09_DEVICE_TYPE, 'calories', { computed: raw, reference: gain });
      this._params = { ...this._params, calorieScale: saved.calorieScale };
    } catch (err) {
      console.warn('[merach] could not save the learned calorie scale:', err.message);
    }
  }

  /**
   * KNOWN QUIRK (ported faithfully from BikeTracker.py):
   * Both call sites assign `this._resistance = d[7]` before calling this
   * method with `this._resistance` as the `resistance` argument, so the
   * resistance-change branch (`resistance !== this._resistance`) can never
   * fire — dialing-state detection is dead code. Pedaling detection works
   * correctly because `ticks` is compared against the OLD `_lastTotalTicks`.
   */
  _updateStateLogic(ticks, resistance, now) {
    this._lastPacketTime = now;
    if (ticks !== this._lastTotalTicks && this._lastTotalTicks !== 0) {
      this._lastPedalTime = now;
    }
    if (resistance !== this._resistance) {
      this._lastInputTime = now; // dead branch — see docstring
    }
  }

  _calculatePower(speedMph, resistance, params) {
    if (speedMph < 0.5) return 0.0;
    return Math.max(0.0,
      (params.baseDragCoeff * (speedMph ** 1.8)) + (resistance * params.wattsPerResistance)
    );
  }

  /** Overridable in tests to avoid wall-clock dependency. */
  _now() { return Date.now(); }
}

export default MerachDevice;