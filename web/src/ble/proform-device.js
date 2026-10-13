// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ble/proform-device.js
 *
 * Wraps a ProForm 750R rower (PFRW58118.0). Unlike ble/merach-device.js,
 * this console does NOT advertise a "fake FTMS" service — ICON/iFit
 * deliberately restricts the 750R's Bluetooth stack to their own iFit app
 * and to paired heart-rate straps (confirmed in the product manual: "Other
 * Bluetooth connections are not supported"). Instead it exposes a single
 * 128-bit vendor-specific GATT service with one write characteristic and
 * one notify characteristic, and expects a steady stream of small command
 * packets to keep telemetry flowing at all — closer to a serial link
 * wrapped in BLE than to a "real" fitness-equipment profile.
 *
 * Protocol confirmed via github.com/cagnulein/qdomyos-zwift
 * (src/devices/proformrower/{proformrower.cpp,proformrower.h}) — the
 * open-source cross-platform trainer bridge that already drives this exact
 * rower over direct BLE, including the 750R-specific resistance branch.
 * That project ships under GPL-3.0. What's below is NOT a port of its
 * source: the service/characteristic UUIDs, the advertised name prefix,
 * and the raw command/telemetry byte values are treated as facts about the
 * physical device (there's only one set of bytes the 750R's firmware will
 * actually respond to — nothing about them is this app's or that
 * project's creative expression), and are transcribed as plain constant
 * tables below. Everything that uses them — class shape, calibration
 * hookup, packet decoding, the poll loop, resistance queuing — is written
 * fresh for this codebase's own conventions, not copied from their .cpp.
 *
 * ✅ CROSS-CHECKED AGAINST A REAL 750R CAPTURE (btsnoop_hci.log — an Android
 * HCI snoop of the stock iFit app driving an actual unit). This confirms,
 * byte-for-byte, against live GATT traffic rather than just the reference
 * project's source:
 *   - PROFORM_SERVICE and both CHAR UUIDs, at the exact handles the real
 *     console assigns, with properties DATA = Read+Notify and
 *     CONTROL = Read+Write — critically, no write-without-response bit
 *     (see the write-mode note in _pollTick() below).
 *   - The advertised local name is exactly "I_RW" (AD type 0x09, Complete
 *     Local Name, 675/675 advertising reports from the unit) — the
 *     case-fold worry noted below turned out moot.
 *   - All 6 POLL_FRAMES_750R entries and UNLOCK_RESISTANCE_FRAME, byte-
 *     for-byte.
  *   - 3 of the 24 RESISTANCE_LEVEL_FRAMES entries. Levels 2 and 3 round-
 *     tripped in the original btsnoop_hci.log capture: right after each
 *     write, the console's own telemetry — decoded by the
 *     _handleTelemetryFrame/decodeResistanceLevel logic below, unmodified —
 *     reported resistance stepping 1→2, then 2→3. Level 5 round-tripped
 *     separately, live, via this file's own debug logging (this.debug =
 *     true): a genuine 3→5 transition was observed in a real app session
 *     (not just an unchanged value echoed back). Levels 1, 4, and 6–24 are
 *     still only the reference project's numbers, unexercised against real
 *     hardware; they're the same field layout and same kind of trailing
 *     checksum byte as the three confirmed entries, so nothing suggests
 *     the table's construction is level-dependent in a way that hasn't
 *     been exercised.
 *
 * ✅ PHYSICAL RESISTANCE CHANGE CONFIRMED on a real unit — someone has now
 * actually felt/watched the mechanism engage when setResistanceTarget() is
 * called, closing the gap the packet capture and telemetry round-trip
 * alone couldn't: those only showed the console accepting and echoing back
 * a level change, not that it was physically applied. That confirmation is
 * why ROLES.CONTROLLABLE_TRAINER is now registered (once the unlock
 * handshake completes — see _runInitThenPoll()) and ERG is wired into
 * ModeSwitch the same way it is for
 * ble/merach-device.js (via the software SmartErgMode loop — this unit has
 * no direct power-target op either, just resistance levels).
 *
 * Per-level provenance is unchanged from the capture (see above): only
 * levels 2, 3, 5, and 8 have been individually round-tripped against real
 * hardware (2 and 3 via the original capture; 5 and 8 via later live debug
 * sessions — see RESISTANCE_LEVEL_FRAMES below). Levels 1, 4, 6–7, and
 * 9–24 are still just the reference project's byte tables, unexercised on
 * their own — the physical-movement confirmation establishes that the
 * mechanism responds to these frames in general, not that every one of
 * the 24 entries has been individually checked.
 *
 * ⛔→✅ FROZEN-TELEMETRY BUG FOUND AND FIXED (2026-09-02) — sessions using
 * the full 28-frame handshake would intermittently connect into a state
 * where the console kept sending notifications (confirmed via
 * this.notifyCount climbing normally) but every field in every frame was
 * byte-for-byte identical for the whole session, live rowing included — a
 * frozen snapshot, not real telemetry, and both the app and the console's
 * own physical display would show stuck zeros. A live capture with
 * this.debug = true, cross-checked against an independent btsnoop capture
 * of the same phenomenon, showed the console's own real Frame B
 * notifications always carry byte2 = 0x01, never 0x02 — but five of the
 * handshake's own writes (INIT_FRAME_GROUPS 6–10) are shaped exactly like
 * a Frame B notification WITH byte2 = 0x02, a value the console's
 * telemetry never organically produces. Bisecting those five in isolation
 * (window.__PROFORM_INIT_GROUP_COUNT / __PROFORM_INIT_EXCLUDE_GROUPS, see
 * below) pinned the trigger down to group 7 specifically (frames 16–18)
 * — groups 6, 8, 9, and 10 all carry the same suspect frame shape but
 * running them (with only group 7 excluded) kept telemetry live and
 * varying through an entire real rowing session, correctly round-tripping
 * two separate resistance changes throughout. Group 7 is now excluded by
 * default (KNOWN_BAD_GROUPS below) — no window flag needs to be set for
 * normal use; the diagnostic overrides remain in place for anyone who
 * wants to re-test group 7's inclusion or isolate group 9 (which shares
 * group 7's exact 4-byte command frame `fe 02 19 03`).
 */

import { CalibrationStore, proportionalSolver } from './sensor-calibration.js';
import { roles, ROLES } from './roles.js';
import { reconnect } from './reconnect.js';
import { bleTransport } from './transport/index.js';

// ─── Protocol constants — confirmed via qdomyos-zwift, see file header ──────

// The 750R's advertised BLE local name. The reference driver matches this
// case-insensitively (`name.toUpper().startsWith("I_RW")`), which had
// raised a worry that the console might not always advertise it in this
// exact case — Web Bluetooth's `namePrefix` filter is case-sensitive with
// no fold option. A real capture settles it: 675/675 advertising reports
// from a physical 750R carried the AD Local Name field as exactly "I_RW"
// (see file header), so this constant's case is confirmed, not assumed.
//
// Exported (alongside PROFORM_SERVICE below) so app.js can fold the 750R
// into the same single "Controller" chooser it already uses for FTMS
// trainers and Merach bikes — same reasoning as MERACH_NAME_PREFIX in
// ble/merach-device.js. Both need to be in that shared requestDevice()
// call's filters/optionalServices, not just this file's own connect(),
// since Web Bluetooth only grants a device access to services it declared
// up front.
export const PROFORM_NAME_PREFIX = 'I_RW';
const NAME_PREFIX = PROFORM_NAME_PREFIX;

// Vendor-specific 128-bit service — not a standard SIG UUID, so there's
// nothing to look up; this is simply what the console exposes.
export const PROFORM_SERVICE = '00001533-1412-efde-1523-785feabcd123';

const CHAR = Object.freeze({
  DATA:    '00001535-1412-efde-1523-785feabcd123', // notify — telemetry frames
  CONTROL: '00001534-1412-efde-1523-785feabcd123', // write (with response) — poll heartbeat + resistance commands
});

// One-time handshake the console requires on the CONTROL characteristic
// before it will honor ANY subsequent write as a real command — telemetry
// notifications flow without it, but resistance (and presumably every
// other control write) is silently ignored until this runs. Missing this
// entirely is why an earlier version of this file could poll and decode
// telemetry fine while setResistanceTarget() had no physical effect.
//
// ✅ CONFIRMED: all 28 of these frames match a real 750R capture
// (btsnoop_hci.log) byte-for-byte, in exact order, as the very first
// control-handle writes in the session — before a single poll-cycle frame
// appears. (Frame 8 originally transcribed here landed one byte off from
// the reference project's own listing — a transcription slip in their
// source, not a real device difference — and has been corrected against
// the capture: the checksum byte sits one position later than the
// reference project has it.)
//
// Frames 29-40 from the reference project are NOT included here: this
// capture shows the console interleaving a couple of extra queries to a
// different subsystem tag (0x0c/0x10) around where those frames would go
// — a separate polling channel that also recurs periodically later in the
// session, outside POLL_FRAMES_750R's 6-frame cycle, not part of this
// unlock sequence. Rather than replay 12 more frames unverified against a
// channel this capture shows isn't part of the unlock, they're dropped;
// the 28 frames above are enough to unlock control writes on their own
// (confirmed by the resistance-level round-trips noted in the file
// header).
//
// Spacing: the reference project sleeps 400ms after every write, but this
// capture's actual inter-write gaps run ~55-90ms (averaging well under
// 100ms) — the extra margin doesn't reflect anything the real console
// needs, just how the reference project's own driver loop happened to be
// timed. 75ms tracks the real capture with a little headroom.
const INIT_FRAME_DELAY_MS = 75;

const INIT_FRAMES_750R = [
  [0xfe, 0x02, 0x08, 0x02],
  [0xff, 0x08, 0x02, 0x04, 0x02, 0x04, 0x02, 0x04, 0x81, 0x87,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x08, 0x02],
  [0xff, 0x08, 0x02, 0x04, 0x02, 0x04, 0x14, 0x04, 0x80, 0x98,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x08, 0x02],
  [0xff, 0x08, 0x02, 0x04, 0x02, 0x04, 0x14, 0x04, 0x88, 0xa0,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x0b, 0x02],
  [0xff, 0x0b, 0x02, 0x04, 0x02, 0x07, 0x02, 0x07, 0x82, 0x00,
   0x00, 0x00, 0x8b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x0a, 0x02],
  [0xff, 0x0a, 0x02, 0x04, 0x02, 0x06, 0x02, 0x06, 0x84, 0x00,
   0x00, 0x8c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x08, 0x02],
  [0xff, 0x08, 0x02, 0x04, 0x02, 0x04, 0x02, 0x04, 0x95, 0x9b,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x2c, 0x04],
  [0x00, 0x12, 0x02, 0x04, 0x02, 0x28, 0x14, 0x28, 0x90, 0x07,
   0x01, 0x1b, 0x20, 0x37, 0x44, 0x53, 0x60, 0x77, 0x9c, 0xbb],
  [0x01, 0x12, 0xc0, 0xe7, 0x04, 0x23, 0x40, 0x67, 0x8c, 0xdb,
   0xe0, 0x37, 0x44, 0x93, 0xa0, 0xf7, 0x3c, 0x7b, 0x80, 0xc7],
  [0xff, 0x08, 0x04, 0x43, 0x80, 0x98, 0x02, 0x00, 0x00, 0xcb,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x19, 0x03],
  [0x00, 0x12, 0x02, 0x04, 0x02, 0x15, 0x14, 0x15, 0x02, 0x0e,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xff, 0x07, 0x00, 0x00, 0x00, 0x10, 0x01, 0x00, 0x4a, 0x00,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x17, 0x03],
  [0x00, 0x12, 0x02, 0x04, 0x02, 0x13, 0x14, 0x13, 0x02, 0x0c,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xff, 0x05, 0x00, 0x80, 0x01, 0x00, 0xb6, 0x00, 0x00, 0x00,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x19, 0x03],
  [0x00, 0x12, 0x02, 0x04, 0x02, 0x15, 0x14, 0x15, 0x02, 0x00,
   0x0f, 0x00, 0x10, 0x00, 0xc0, 0x1c, 0x4c, 0x00, 0x00, 0xe0],
  [0xff, 0x07, 0x00, 0x00, 0x00, 0x10, 0x00, 0x08, 0x6a, 0x00,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x18, 0x03],
  [0x00, 0x12, 0x02, 0x04, 0x02, 0x14, 0x14, 0x14, 0x02, 0x00,
   0x0e, 0x1c, 0x96, 0x31, 0x00, 0x10, 0x40, 0x40, 0x00, 0x80],
  [0xff, 0x06, 0x00, 0x00, 0x00, 0x81, 0x60, 0x0c, 0x00, 0x00,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  // Frames 29-40 (present in the reference project) end here: not part of
  // the unlock sequence in this capture — see the note above.
];

// ⚠️ DIAGNOSTIC BUILD — groups the 28 handshake frames into their natural
// request/response "exchanges" (one fe-02 command frame plus however many
// payload frames actually answer it — 1, 2, or 3 depending on the
// exchange, per the raw array above), so a bisection can stop between
// exchanges rather than mid-exchange. Groups 6–10 all contain a 20-byte
// payload starting `00 12 02 04 02 ...` — the shape that looks like a live
// main-metrics notification echoed back at the console (see
// _handleTelemetryFrame() below and the file header's byte2 finding).
// Groups 0–5 contain no such frame.
//
// ⛔ CONFIRMED (2026-09-02, live on real hardware, two independent
// bisections): group 7 specifically — `fe 02 19 03` / `00 12 02 04 02 15
// 14 15 02 0e 00...` / `ff 07 00 00 00 10 01 00 4a 00...` — is the trigger
// for the frozen-telemetry state, not the group 6–10 block as a whole.
// Running groups 0–6 + 8–10 (every group EXCEPT 7 — see KNOWN_BAD_GROUPS
// below) kept telemetry live and varying through an entire real rowing
// session, and correctly round-tripped two separate resistance changes
// (level 8, then level 5) through decoded telemetry throughout — so
// groups 6, 8, 9, and 10 are cleared despite carrying the same suspect
// frame shape; something specific to group 7's exchange is what the
// console's firmware actually reacts to. Group 9 shares group 7's exact
// 4-byte command frame (`fe 02 19 03`) — worth testing in isolation if
// group 7 is ever re-included, since that's the one open thread this
// doesn't rule out.
const INIT_FRAME_GROUPS = [
  [0, 1],           // group 0 — fe 02 08 02 / ff 08 ...81 87 (plain)
  [2, 3],           // group 1 — fe 02 08 02 / ff 08 ...80 98 (plain)
  [4, 5],           // group 2 — fe 02 08 02 / ff 08 ...88 a0 (plain)
  [6, 7],           // group 3 — fe 02 0b 02 / ff 0b ...82.. (plain)
  [8, 9],           // group 4 — fe 02 0a 02 / ff 0a ...84.. (plain)
  [10, 11],         // group 5 — fe 02 08 02 / ff 08 ...95 9b (plain)
  [12, 13, 14, 15], // group 6 — fe 02 2c 04 / 00 12 02.. / 01 12.. / ff 08.. — cleared
  [16, 17, 18],     // group 7 — fe 02 19 03 / 00 12 02.. / ff 07.. — ⛔ CONFIRMED TRIGGER, excluded by default
  [19, 20, 21],     // group 8 — fe 02 17 03 / 00 12 02.. / ff 05.. — cleared
  [22, 23, 24],     // group 9 — fe 02 19 03 / 00 12 02.. / ff 07.. — cleared (same command frame as group 7, payload differs)
  [25, 26, 27],     // group 10 — fe 02 18 03 / 00 12 02.. / ff 06.. — cleared
];

// Groups excluded from the handshake by default — see the ⛔ CONFIRMED note
// above INIT_FRAME_GROUPS. This is now the normal/shipped behavior, not a
// diagnostic-only path; window.__PROFORM_INIT_EXCLUDE_GROUPS (below) can
// still override it (e.g. set to [] to force group 7 back in for a future
// comparison, or to something else entirely) but doing so is an explicit
// diagnostic choice, not what a normal connect does.
const KNOWN_BAD_GROUPS = [7];

/**
 * How many leading exchange-groups to run before starting the poll loop.
 * Set from the devtools console BEFORE clicking connect, e.g.:
 *   window.__PROFORM_INIT_GROUP_COUNT = 6
 * Unset (or not an integer 0–11) runs all 11 groups (minus KNOWN_BAD_GROUPS
 * — see _diagExcludedGroups() below) — normal behavior, nothing changes
 * unless you explicitly set this.
 */
function _diagGroupCount() {
  const n = typeof window !== 'undefined' ? window.__PROFORM_INIT_GROUP_COUNT : undefined;
  return Number.isInteger(n) && n >= 0 && n <= INIT_FRAME_GROUPS.length ? n : INIT_FRAME_GROUPS.length;
}

/**
 * Individual group indexes to drop from the handshake, applied AFTER the
 * count-based prefix above — lets a specific group be isolated (e.g. "run
 * everything except group 7") instead of only ever testing a leading
 * prefix. Set from the devtools console BEFORE clicking connect, e.g.:
 *   window.__PROFORM_INIT_EXCLUDE_GROUPS = [7]        // (this is now the default anyway)
 *   window.__PROFORM_INIT_EXCLUDE_GROUPS = []          // force group 7 back in, exclude nothing
 *   window.__PROFORM_INIT_EXCLUDE_GROUPS = [7, 9]      // e.g. also test dropping group 9
 * Unset (or not an array) defaults to KNOWN_BAD_GROUPS, i.e. [7] — the
 * confirmed-good default, not "exclude nothing". Pass an explicit array
 * (including []) to override that for a diagnostic run. Composes with
 * __PROFORM_INIT_GROUP_COUNT: count trims the tail first, then this drops
 * indexes out of whatever's left.
 */
function _diagExcludedGroups() {
  const arr = typeof window !== 'undefined' ? window.__PROFORM_INIT_EXCLUDE_GROUPS : undefined;
  return Array.isArray(arr) ? new Set(arr.filter((n) => Number.isInteger(n))) : new Set(KNOWN_BAD_GROUPS);
}

// The console appears to stop notifying telemetry unless it keeps
// receiving this 6-packet cycle roughly every 200ms — a short 4-byte
// "ping" alternating with two 20-byte frames, twice. None of the six
// carries anything this wrapper needs to read; they exist purely to keep
// the link alive, so they're just replayed byte-for-byte rather than
// modeled field-by-field. A resistance change is queued to go out right
// after the last frame in the cycle (see _pollTick()).
const POLL_INTERVAL_MS = 200;

// Ceiling for _waitForNextNotify() — see that method and its two call
// sites in _pollTick() (poll step 5) and _writeResistanceTarget() (the
// level write). Per proform-750r-ble-legend.md sections 4–5, both of
// those writes need the console's actual follow-up notification, not
// just the ATT Write Response ack writeValueWithResponse() itself
// resolves on. This bounds how long a tick can stall if that notify
// genuinely never arrives (e.g. mid-disconnect), rather than hanging the
// poll chain forever — chosen as ~2x POLL_INTERVAL_MS, comfortably above
// the real notify latency seen in the btsnoop captures but still short
// enough that a stuck tick surfaces quickly instead of silently eating
// the session.
const NOTIFY_WAIT_TIMEOUT_MS = 400;

// If bytes[2..9]=covered stroke-rate frames stop reporting a *confirmed*
// nonzero reading for this long, metrics.strokeRate is forced to 0 — see
// the staleness fallback in _handleTelemetryFrame() and the note on
// _handleStrokeFrame()'s "stale/transitional frame" skip. Matches the
// idle timeouts already used elsewhere in this codebase for the same kind
// of "few seconds of no activity" judgment (control/mode-switch.js's
// IDLE_TIMEOUT, control/smart-erg.js's IDLE_TIMEOUT).
const STROKE_IDLE_TIMEOUT_MS = 3000;

// Floor for the time delta _handleStrokeCountFrame() divides by. Two
// notifications landing only a couple ms apart (e.g. queued frames
// flushing back-to-back right after a reconnect, before the poll cycle
// settles into its normal ~1.2s-per-ff0e-frame cadence) would otherwise
// turn a real deltaCount of 1 into a five-figure spm reading — technically
// "not division by zero" but just as nonsensical for anything downstream
// (chart, session average) to receive. ff,0x0e frames arrive roughly once
// per full 6-frame poll cycle in normal operation (~1.2s), so this floor
// is well below any real inter-frame gap and only screens out the
// pathological case, not genuine fast rowing.
const MIN_STROKE_COUNT_INTERVAL_MS = 200;

// Ceiling on the rate _handleStrokeCountFrame() computes, in strokes/min.
// The time floor above only protects against a small denominator — it does
// nothing about a large deltaCount arriving over a short-but-not-tiny
// window, which is exactly what real captures show happening (confirmed
// against two recorded sessions: every cadence sample above 100spm
// coincided with power===0, i.e. the rower sitting idle, not rowing fast —
// so those specific spikes were spurious jumps in the raw count, not real
// strokes). The first attempt at this ceiling used 60, reasoning from
// generic "rowing tops out around 45-50spm" — but a live test deliberately
// pushing toward 66-84spm showed that's a real, reachable range on this
// machine, not just a theoretical one, and 60 would have discarded every
// legitimate reading in that stretch. 150 keeps the four- and five-figure
// garbage (1200+, 4000+) out while giving real headroom above any rate a
// person can physically sustain — if a genuine sprint ever needs more than
// this, that's a sign to raise the number again with real data, not a sign
// the approach is wrong. A reading over this ceiling is discarded rather
// than clamped to the max — an implausible reading carries no information
// about the real rate, so holding the last good value (by simply not
// overwriting it) is more honest than substituting a guessed number, and
// STROKE_IDLE_TIMEOUT_MS above still zeroes it out if the rider has
// genuinely stopped.
const MAX_PLAUSIBLE_STROKE_RATE_SPM = 150;

const POLL_FRAMES_750R = [
  [0xfe, 0x02, 0x18, 0x03],
  [0x00, 0x12, 0x02, 0x04, 0x02, 0x14, 0x14, 0x14, 0x02, 0x00,
   0x0e, 0x1c, 0x96, 0x31, 0x00, 0x10, 0x40, 0x40, 0x00, 0x80],
  [0xff, 0x06, 0x00, 0x00, 0x00, 0x81, 0x60, 0x0c, 0x00, 0x00,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xfe, 0x02, 0x19, 0x03],
  [0x00, 0x12, 0x02, 0x04, 0x02, 0x15, 0x14, 0x15, 0x02, 0x00,
   0x0f, 0x80, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0xff, 0x07, 0x00, 0x00, 0x00, 0x10, 0x80, 0x11, 0x9b, 0x00,
   0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
];

// Every resistance write is preceded by this 4-byte "unlock" frame, then
// followed by one 20-byte frame selecting the level (below). Levels 1–24;
// index 0 of RESISTANCE_LEVEL_FRAMES is level 1. This unlock frame and
// levels 2–3 below are confirmed byte-for-byte against a real 750R
// capture (see file header); the rest of the table is carried over from
// the reference project unverified.
const UNLOCK_RESISTANCE_FRAME = [0xfe, 0x02, 0x0d, 0x02];

const RESISTANCE_LEVEL_FRAMES = [
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x9f, 0x01, 0x00, 0xc4, 0x00, 0x00, 0x00, 0x00, 0x00], // level 1
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x3f, 0x03, 0x00, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00], // level 2 — confirmed via real-device capture, round-tripped through telemetry
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0xdf, 0x04, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00], // level 3 — confirmed via real-device capture, round-tripped through telemetry
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x7f, 0x06, 0x00, 0xa9, 0x00, 0x00, 0x00, 0x00, 0x00], // level 4
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x1f, 0x08, 0x00, 0x4b, 0x00, 0x00, 0x00, 0x00, 0x00], // level 5 — confirmed via real-device debug session, telemetry showed a genuine 3→5 transition
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0xbf, 0x09, 0x00, 0xec, 0x00, 0x00, 0x00, 0x00, 0x00], // level 6
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x5f, 0x0b, 0x00, 0x8e, 0x00, 0x00, 0x00, 0x00, 0x00], // level 7
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0xff, 0x0c, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00, 0x00], // level 8 — confirmed via real-device debug session, telemetry held steady at resistance code 0x0c across many notify cycles
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x9f, 0x0e, 0x00, 0xd1, 0x00, 0x00, 0x00, 0x00, 0x00], // level 9
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x3f, 0x10, 0x00, 0x73, 0x00, 0x00, 0x00, 0x00, 0x00], // level 10
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0xdf, 0x11, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00], // level 11
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x7f, 0x13, 0x00, 0xb6, 0x00, 0x00, 0x00, 0x00, 0x00], // level 12
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x1f, 0x15, 0x00, 0x58, 0x00, 0x00, 0x00, 0x00, 0x00], // level 13
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0xbf, 0x16, 0x00, 0xf9, 0x00, 0x00, 0x00, 0x00, 0x00], // level 14
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x5f, 0x18, 0x00, 0x9b, 0x00, 0x00, 0x00, 0x00, 0x00], // level 15
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0xff, 0x19, 0x00, 0x3c, 0x00, 0x00, 0x00, 0x00, 0x00], // level 16
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x9f, 0x1b, 0x00, 0xde, 0x00, 0x00, 0x00, 0x00, 0x00], // level 17
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x3f, 0x1d, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00], // level 18
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0xdf, 0x1e, 0x00, 0x21, 0x00, 0x00, 0x00, 0x00, 0x00], // level 19
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x7f, 0x20, 0x00, 0xc3, 0x00, 0x00, 0x00, 0x00, 0x00], // level 20
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x1f, 0x22, 0x00, 0x65, 0x00, 0x00, 0x00, 0x00, 0x00], // level 21
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0xbf, 0x23, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00], // level 22
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0x5f, 0x25, 0x00, 0xa8, 0x00, 0x00, 0x00, 0x00, 0x00], // level 23
  [0xff, 0x0d, 0x02, 0x04, 0x02, 0x09, 0x14, 0x09, 0x02, 0x01, 0x04, 0xff, 0x26, 0x00, 0x49, 0x00, 0x00, 0x00, 0x00, 0x00], // level 24
];

// The telemetry frame reports resistance as an opaque byte, not a level
// number 1–24 directly, and the mapping isn't a formula — it's a handful
// of raw codes per level (e.g. both 0x07 and 0x08 mean level 5), so this
// has to be a lookup table rather than something computed. Built by
// pairing each raw code up with the level whose RESISTANCE_LEVEL_FRAMES
// entry produced it, cross-checked against the reference driver's own
// (differently-shaped, but numerically identical) table.
const RESISTANCE_CODE_TO_LEVEL = new Map([
  [0x01, 1], [0x03, 2], [0x04, 3], [0x06, 4], [0x07, 5], [0x08, 5],
  [0x09, 6], [0x0b, 7], [0x0c, 8], [0x0d, 8], [0x0e, 9], [0x10, 10],
  [0x11, 11], [0x13, 12], [0x14, 13], [0x15, 13], [0x16, 14], [0x18, 15],
  [0x19, 16], [0x1a, 16], [0x1b, 17], [0x1d, 18], [0x1e, 19], [0x20, 20],
  [0x22, 21], [0x23, 22], [0x25, 23], [0x26, 24], [0x27, 24],
]);

function decodeResistanceLevel(code) {
  return RESISTANCE_CODE_TO_LEVEL.get(code) ?? 1;
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const PROFORM_750R_DEVICE_TYPE = 'proform-750r';

// Power, stroke rate, resistance level, and cumulative distance all come
// straight off the wire (unlike Merach's "fake FTMS" packet, nothing here
// needs to be derived from sensor ticks) — so there's only one real
// unknown left to calibrate: what unit the raw 16-bit distance field is
// actually in. The reference driver divides it by 1000 and calls the
// result kilometres, which implies the raw units are metres — that's the
// assumption baked into the default value below, but it's inferred, not
// read off a real console, so it's wired through the calibration store in
// case a real ride shows otherwise.
export const PROFORM_750R_DEFAULT_PARAMS = Object.freeze({
  distanceMetersPerRawUnit: {
    value: 1,
    unit: 'm/unit',
    description: 'Scale from the raw 16-bit distance field to meters — inferred, not yet confirmed against a real console readout.',
  },
});

export function registerProform750rCalibrationProfile(store) {
  store.registerDeviceType(PROFORM_750R_DEVICE_TYPE, {
    params: PROFORM_750R_DEFAULT_PARAMS,
    solvers: {
      distance: proportionalSolver('distanceMetersPerRawUnit'),
    },
  });
}

export const proform750rCalibrationStore = new CalibrationStore();
registerProform750rCalibrationProfile(proform750rCalibrationStore);

// ─── Proform750rDevice ──────────────────────────────────────────────────────

export class Proform750rDevice extends EventTarget {
  /** @param {CalibrationStore} [calibrationStore] */
  constructor(calibrationStore = proform750rCalibrationStore) {
    super();
    this._calibration = calibrationStore;
    this._params = null;

    this.id = null;
    this.name = null;
    this._device = null;
    this._onData = null;
    this.controlPoint = null;

    // ✅ CONFIRMED: this unit's real resistance range is 1–24, matching
    // RESISTANCE_LEVEL_FRAMES.length above. Read by control/smart-erg.js's
    // SmartErgMode (via ergResistanceRange, NOT resistanceRange — see that
    // constructor's comment for why the two are kept separate: this device
    // deliberately doesn't declare resistanceRange, since that property is
    // also what mode-switch.js's capability detection uses to decide
    // whether to offer real ResistanceMode/VirtualGearMode, which aren't
    // wired up for this device) to clamp the ERG loop's resistance ceiling
    // to what this hardware actually supports, instead of the generic
    // 20-level default that was silently capping it 4 levels short.
    this.ergResistanceRange = { min: 1, max: RESISTANCE_LEVEL_FRAMES.length };

    this._pollTimer = null;
    this._pollStopped = false;
    this._pollIndex = 0;
    this._pendingResistanceLevel = null;

    // Resolver callbacks from any in-flight _waitForNextNotify() calls —
    // see that method below. A Set rather than a single slot because nothing
    // stops two waiters overlapping in principle, even though today's two
    // call sites (poll step 5, the resistance level write) never actually
    // run concurrently with each other.
    this._notifyWaiters = new Set();

    // Unconditional running count of every notification received on the
    // DATA characteristic since connecting, regardless of content —
    // increments even for frame shapes _handlePacket() doesn't recognize.
    // Not gated behind this.debug: the point is to be checkable mid-session
    // without needing to have debug on beforehand. Check with
    // `window.__debug.trainer().notifyCount` during a frozen session — if
    // it's stuck at 0 (or stops climbing), the console has genuinely gone
    // quiet on the wire; if it keeps climbing, notifications are arriving
    // and the freeze is downstream of that (decode/state, not transport).
    this.notifyCount = 0;

    // Bumped on every _connectDevice() call and captured by the background
    // init/poll chain kicked off there (see _connectDevice() and
    // _runInitThenPoll() below) — lets a stale chain from a previous
    // connection attempt recognize it's been superseded and stop applying
    // its results (registering roles, starting the poll loop) against a
    // connection that isn't current anymore. Needed now that the handshake
    // runs in the background instead of being awaited inline.
    this._connectionToken = 0;

    // Instance-level debug flag — flip from devtools with
    // `window.__debug.trainer().debug = true` to log resistance
    // queue/write events and raw telemetry bytes without editing source.
    // No-op until explicitly set true.
    this.debug = false;

    // Last time EITHER _handleStrokeFrame() (0xff,0x11) or
    // _handleStrokeCountFrame() (0xff,0x0e) accepted a CONFIRMED nonzero
    // stroke reading — see the staleness fallback in _handleTelemetryFrame()
    // and STROKE_IDLE_TIMEOUT_MS above. Both frames feed this same clock now
    // that strokeCount is wired into cadence too (see _handleStrokeCountFrame()).
    this._lastStrokeRateTime = 0;

    // Seed state for computing a stroke rate out of strokeCount's running
    // total — see _handleStrokeCountFrame(). null until the first such
    // frame arrives (a rate needs two points), and reset on disconnect (see
    // _onDisconnect()) so a reconnect doesn't diff against a stale count
    // from a previous session.
    this._lastStrokeCount = null;
    this._lastStrokeCountTime = 0;

    // Seed state for deriving speed from the telemetry frame's raw
    // distance counter — see _handleTelemetryFrame(). _lastRawDistance
    // also doubles as the "was there a real reading before this" guard
    // for the idle-reset hold (only treat power===0 && rawDistance===0
    // as "the console just zeroed the field on idle" if a nonzero raw
    // reading actually preceded it — see that method). Reset on
    // disconnect (see _onDisconnect()) for the same reason strokeCount's
    // diff state is: don't diff/time across a reconnect gap.
    this._lastRawDistance = 0;
    this._lastDistanceTime = null;

    // Elapsed-ms-since-previous-notification, purely for the debug log
    // (see the notify listener in _connectDevice()) — this._lastStrokeCount
    // etc. above already track their own timing for the actual math; this
    // is just so a future debug capture carries real inter-frame gaps
    // instead of having to be inferred after the fact from frame position,
    // the way this round's ff,0x0e/byte3 analysis had to.
    this._lastNotifyLogTime = null;

    // Logged once, unconditionally, the first time ANY nonzero power or
    // stroke rate is decoded after connecting — see the note in
    // _handleTelemetryFrame()/_handleStrokeFrame(). Distinguishes "telemetry
    // is flowing but every real reading happens to be 0 right now" from
    // "every notification so far has been a frozen/idle snapshot" — the
    // btsnoop analysis that flagged this (2026-09-01: 77s of confirmed real
    // rowing, zero byte variation in any notification) couldn't tell those
    // apart from outside the app, but this can, live, in the browser console.
    this._sawLiveReading = false;

    this.metrics = {
      power: null, strokeRate: null, resistance: null,
      distanceMeters: 0, calories: null, elapsedSeconds: null,
      strokeCount: null, speed: null,
    };
  }

  /** Logs only when this.debug is true — see the constructor. */
  _log(...args) {
    if (this.debug) console.info('[proform-750r:debug]', ...args);
  }

  /**
   * Logs once, unconditionally, the first time a real nonzero reading comes
   * through — see the this._sawLiveReading note in the constructor.
   * @param {string} metric  'power' or 'stroke rate'
   * @param {number} value
   */
  _noteLiveReading(metric, value) {
    if (this._sawLiveReading) return;
    this._sawLiveReading = true;
    console.info(`[proform-750r] First live nonzero reading since connecting: ${metric} = ${value}`);
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  /**
   * Open the BLE chooser and connect.
   * @param {Function} onData  Receives the metrics object on each packet.
   */
  async connect(onData) {
    this._onData = onData;

    const device = await bleTransport.requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }],
      optionalServices: [PROFORM_SERVICE],
    });

    await this._connectDevice(device);
    reconnect.remember(device, 'proform-750r');
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
    this._params = await this._calibration.load(PROFORM_750R_DEVICE_TYPE);

    this._device = device;
    this.id = device.id;
    this.name = device.name ?? 'ProForm 750R';

    device.addEventListener('gattserverdisconnected', () => this._onDisconnect());

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(PROFORM_SERVICE);

    const dataChar = await service.getCharacteristic(CHAR.DATA);
    await dataChar.startNotifications();
    dataChar.addEventListener('characteristicvaluechanged', (e) => {
      const bytes = new Uint8Array(e.target.value.buffer);
      this.notifyCount++;
      const now = Date.now();
      const dtMs = this._lastNotifyLogTime === null ? '—' : now - this._lastNotifyLogTime;
      this._lastNotifyLogTime = now;
      this._log(`notify raw (+${dtMs}ms) —`, Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '));
      this._handlePacket(bytes);
      if (this._onData) this._onData({ ...this.metrics });

      // Wake any _waitForNextNotify() callers — see that method. Snapshot
      // to an array first: each resolver removes itself from the Set (see
      // _waitForNextNotify()), which would skip entries if iterated live.
      for (const resolveWaiter of [...this._notifyWaiters]) resolveWaiter();
    });

    this.controlPoint = await service.getCharacteristic(CHAR.CONTROL);

    // Telemetry (this._onData) is already live at this point — notifications
    // were subscribed above, and the console emits them independent of the
    // control-write handshake (see INIT_FRAMES_750R's header note). Register
    // the metric roles now rather than after the handshake below, and —
    // critically — RETURN from connect()/connectDevice() now too, instead of
    // making the caller await the ~2s handshake first.
    //
    // Why this matters: app.js's connectProformRower() doesn't build a fresh
    // ModeSwitch (and re-subscribe onIdle()/onActive()) until this promise
    // resolves. While modeSwitch is unset, onTrainerData() drops every
    // incoming sample on the floor for activity-tracking purposes
    // (`if (modeSwitch && data.power != null)`), even though this._onData is
    // actively pushing them and session.pushData() is recording them.
    // Blocking this method on the full handshake previously stretched that
    // modeSwitch-less window from a normal GATT-connect gap (tens of ms) out
    // to 2+ seconds on every single reconnect — during which the app can't
    // recognize the rider is already pedaling again, so auto-resume stalls
    // and the recorded session shows a gap for however long the handshake
    // takes. Running the handshake in the background (_runInitThenPoll()
    // below) instead fixes that without changing anything about the
    // handshake's own required framing/order on the wire.
    roles.register(this.id, [ROLES.POWER_SOURCE, ROLES.CADENCE_SOURCE, ROLES.SPEED_SOURCE]);

    const token = ++this._connectionToken;
    this._runInitThenPoll(token);

    console.info('[proform-750r] Connected:', this.name);
  }

  /**
   * Runs the one-time unlock handshake, then starts the poll loop — in the
   * background, NOT awaited by _connectDevice() (see the note there). Still
   * fully serialized on the wire exactly as before: the 28 INIT_FRAMES_750R
   * go out first, in order, and _schedulePoll() below only starts once
   * they're done, so the hardware sees the identical sequence/timing this
   * capture confirmed — only the app's own await chain changed, not
   * anything sent over BLE.
   *
   * `token` is this._connectionToken as of the connect() call that kicked
   * this off. Checked after the (possibly disconnect-interrupted) handshake
   * and before touching shared state, so a stale chain from an old
   * connection attempt — e.g. a disconnect/reconnect that happened while an
   * earlier handshake was still in flight — can't register roles or start a
   * poll loop for a connection that isn't current anymore.
   * @param {number} token
   */
  async _runInitThenPoll(token) {
    // Must run before the poll loop starts — see INIT_FRAMES_750R above.
    // Without this, telemetry still flows but the console silently
    // ignores every subsequent control write, resistance included.
    //
    // These two log lines are unconditional (not gated behind this.debug)
    // — same tier as the "Connected"/"Disconnected" lines below — because
    // whether/when this handshake actually finishes turned out to matter
    // for diagnosing more than just resistance writes: a system-level BLE
    // snoop capture can miss the start of a session (buffer rollover) or
    // simply be too tedious to dig through, but this always shows up in
    // the browser console in real time.
    console.info('[proform-750r] Running unlock handshake (DIAG BUILD — group count set via window.__PROFORM_INIT_GROUP_COUNT)...');
    await this._runInitHandshake();

    if (token !== this._connectionToken || !this.isConnected) {
      console.info('[proform-750r] Unlock handshake finished but this connection is no longer current — not starting the poll loop.');
      return;
    }
    console.info('[proform-750r] Unlock handshake complete — control writes should now be honored, starting poll loop.');

    // Reseed the stroke-count diff baseline here rather than leaving
    // whatever _handleStrokeCountFrame() picked up during the handshake.
    // 0xff,0x0e notifications aren't gated by the handshake — they can
    // (and did, per the "First live nonzero reading" log firing before
    // "Unlock handshake complete" above) arrive throughout that transitional
    // window, and MAX_PLAUSIBLE_STROKE_RATE_SPM's ceiling is the fix for bad
    // rates in general, not a reason to skip this: starting the real diff
    // chain from a clean point once steady-state polling begins is cheap
    // and removes the handshake window as a source of them entirely, on
    // top of the ceiling catching whatever's left.
    this._lastStrokeCount = null;
    this._lastStrokeCountTime = 0;

    // Telemetry only keeps flowing for as long as this keeps running — see
    // POLL_FRAMES_750R above. Self-rescheduling rather than setInterval:
    // the real console only ever has one GATT operation in flight at a
    // time (confirmed by the "GATT operation already in progress" errors
    // a naive setInterval produces the moment a single write takes longer
    // than POLL_INTERVAL_MS), so the next tick must not be queued until
    // this tick's write — and, on the last frame, a queued resistance
    // write — has fully settled. Matches the reference driver's own
    // model: every writeCharacteristic() call there blocks (a nested
    // QEventLoop::exec() with a 300ms timeout) before the next line runs,
    // so nothing is ever issued concurrently.
    this._pollIndex = 0;
    this._pollStopped = false;
    this._schedulePoll(0);

    // setResistanceTarget() is implemented below, cross-checked against a
    // real 750R btsnoop capture (unlock frame + levels 2-3, round-tripped
    // through telemetry — see file header), AND now confirmed to
    // physically move the resistance mechanism on a real unit (see file
    // header) — so CONTROLLABLE_TRAINER is registered here, once the
    // handshake that actually makes control writes work has completed
    // (the metric-source roles were already registered synchronously in
    // _connectDevice() — see the note there).
    roles.register(this.id, [ROLES.CONTROLLABLE_TRAINER]);
  }

  _onDisconnect() {
    this._pollStopped = true;
    // Invalidate any _runInitThenPoll() chain still in flight for this
    // connection so it can't register roles or start a poll loop after
    // we've already torn down — see that method's docstring.
    this._connectionToken++;
    this._sawLiveReading = false; // fresh diagnostic state for the next connection
    this._lastStrokeCount = null; // see the constructor note — don't diff across a reconnect
    this._lastRawDistance = 0; // see the constructor note — don't hold-guard across a reconnect
    this._lastDistanceTime = null; // don't compute speed across a bogus reconnect-spanning gap
    this._lastNotifyLogTime = null; // don't log a bogus +Nms gap spanning the disconnect
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    roles.unregister(this.id);
    console.info('[proform-750r] Disconnected:', this.name);
    this.dispatchEvent(new CustomEvent('disconnected'));
  }

  disconnect() {
    this._device?.gatt?.disconnect();
  }

  get isConnected() {
    return this._device?.gatt?.connected ?? false;
  }

  /**
   * Resolves the next time a notification arrives on the DATA
   * characteristic, or after NOTIFY_WAIT_TIMEOUT_MS if none arrives first
   * — whichever comes first, never rejects. See
   * proform-750r-ble-legend.md sections 4 (poll step 5) and 5 (resistance
   * write): both call for waiting on the console's actual follow-up
   * notify, which is a distinct event from — and, per the btsnoop
   * captures, arrives measurably after — the ATT Write Response that
   * writeValueWithResponse()'s own promise resolves on. Deliberately
   * timeout-and-continue rather than timeout-and-reject: a missing notify
   * here (e.g. a disconnect landing mid-wait) is already surfaced
   * separately by the write that preceded it throwing, or by
   * this.isConnected going false on the next tick — this helper's job is
   * only to not stall the poll chain forever, not to be the source of
   * truth on whether the round-trip succeeded.
   * @param {string} label  Identifies the call site in the timeout log
   *   below — 'poll-step5' or 'resistance-write' today.
   * @returns {Promise<void>}
   */
  _waitForNextNotify(label) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (timedOut) => {
        if (settled) return;
        settled = true;
        this._notifyWaiters.delete(finish);
        if (timedOut) {
          // Unconditional, not gated behind this.debug — same reasoning as
          // notifyCount above: this needs to be visible after the fact,
          // not only if debug logging happened to be on in advance.
          console.warn(`[proform-750r] _waitForNextNotify(${label}) timed out after ${NOTIFY_WAIT_TIMEOUT_MS}ms — no notification arrived`);
        }
        resolve();
      };
      this._notifyWaiters.add(finish);
      setTimeout(() => finish(true), NOTIFY_WAIT_TIMEOUT_MS);
    });
  }

  // ─── Init handshake ─────────────────────────────────────────────────────────

  /**
   * One-time sequence the console requires on CONTROL before it will honor
   * ANY later write as a real command — see INIT_FRAMES_750R above. Each
   * write is awaited to completion (or failure) before the next is sent,
   * with the same ~400ms spacing observed in the reference driver, so this
   * can never overlap the poll loop (which only starts once this resolves)
   * or itself.
   */
  async _runInitHandshake() {
    // Runs all 11 exchange-groups except KNOWN_BAD_GROUPS by default (the
    // confirmed-good handshake — see the note above INIT_FRAME_GROUPS).
    // window.__PROFORM_INIT_GROUP_COUNT / __PROFORM_INIT_EXCLUDE_GROUPS
    // (see _diagGroupCount()/_diagExcludedGroups() above) can still force a
    // different subset for further diagnostics.
    const groupCount = _diagGroupCount();
    const excluded = _diagExcludedGroups();
    const includedGroupNumbers = [];
    const frameIndexes = [];
    for (let g = 0; g < groupCount; g++) {
      if (excluded.has(g)) continue;
      includedGroupNumbers.push(g);
      frameIndexes.push(...INIT_FRAME_GROUPS[g]);
    }
    const frames = frameIndexes.map((i) => INIT_FRAMES_750R[i]);

    const isDefaultExclusion = excluded.size === KNOWN_BAD_GROUPS.length
      && KNOWN_BAD_GROUPS.every((g) => excluded.has(g));
    const isConfirmedGoodHandshake = groupCount === INIT_FRAME_GROUPS.length && isDefaultExclusion;
    const isDiagnosticRun = groupCount < INIT_FRAME_GROUPS.length || !isDefaultExclusion;

    const partialNote = isDiagnosticRun
      ? ' Resistance may not work with a partial/non-default handshake — expected for this diagnostic run.'
      : ' (confirmed-good default handshake — group 7 excluded, see file header)';
    const excludeNote = excluded.size > 0
      ? ` (excluding group${excluded.size > 1 ? 's' : ''} ${[...excluded].sort((a, b) => a - b).join(', ')})`
      : '';
    console.info(
      `[proform-750r] ${isConfirmedGoodHandshake ? 'Running' : 'DIAG BUILD: running'} `
      + `${includedGroupNumbers.length}/${INIT_FRAME_GROUPS.length} handshake groups`
      + `${excludeNote} (${frames.length}/${INIT_FRAMES_750R.length} raw frames).${partialNote}`
    );
    for (const frame of frames) {
      if (!this.isConnected) break;
      try {
        await this.controlPoint.writeValueWithResponse(Uint8Array.from(frame));
      } catch (err) {
        console.warn('[proform-750r] init write failed:', err.message);
      }
      // A write failure above is often the disconnect itself arriving
      // mid-handshake — bail immediately rather than sleeping and then
      // burning through the rest of the frame list against a dead GATT
      // connection (each one throwing the same failure and logging it).
      if (!this.isConnected) break;
      await sleep(INIT_FRAME_DELAY_MS);
    }
  }

  // ─── Poll loop ──────────────────────────────────────────────────────────────

  /**
   * Schedule the next _pollTick() after `delayMs`, then re-schedule itself
   * once that tick's write(s) have fully settled. Deliberately NOT
   * setInterval: setInterval fires on a fixed wall-clock cadence no matter
   * how long the previous tick's GATT write is still taking, and a real
   * 750R write can exceed POLL_INTERVAL_MS — that overlap is exactly what
   * throws "GATT operation already in progress" (only one GATT operation
   * may be in flight per device at a time). Chaining setTimeout after
   * await guarantees the next write is never issued until this one is
   * done, mirroring the reference driver's blocking writeCharacteristic().
   */
  _schedulePoll(delayMs) {
    this._pollTimer = setTimeout(async () => {
      if (this._pollStopped || !this.isConnected || !this.controlPoint) return;
      await this._pollTick();
      if (!this._pollStopped) this._schedulePoll(POLL_INTERVAL_MS);
    }, delayMs);
  }

  async _pollTick() {
    if (!this.isConnected || !this.controlPoint) return;

    // Write WITH response — the real console's CONTROL characteristic
    // properties are Read+Write only (confirmed via btsnoop capture, see
    // file header), with no write-without-response bit, so
    // writeValueWithoutResponse() would throw NotSupportedError against
    // real hardware. Matches the writeValueWithResponse() convention
    // already used in ble/ftms-device.js and ble/merach-device.js.
    const frame = POLL_FRAMES_750R[this._pollIndex];
    const isLastStep = this._pollIndex === POLL_FRAMES_750R.length - 1;
    try {
      await this.controlPoint.writeValueWithResponse(Uint8Array.from(frame));
      // Step 5 specifically — see proform-750r-ble-legend.md section 4 —
      // needs the console's actual notify, not just the write ack above.
      // Steps 0-4 stay ack-only, matching the legend.
      if (isLastStep) await this._waitForNextNotify('poll-step5');
    } catch (err) {
      console.warn('[proform-750r] poll write failed:', err.message);
    }

    // A queued resistance change goes out right after the last frame in
    // the cycle — matches the cadence the reference driver uses. Awaited
    // in-line (not fire-and-forgotten) so _schedulePoll() can't queue the
    // next poll write until this two-part sequence has settled — the same
    // ordering forceResistance() gets for free in the reference driver by
    // being called only after poll6's writeCharacteristic() has returned.
    if (isLastStep && this._pendingResistanceLevel != null) {
      const level = this._pendingResistanceLevel;
      this._pendingResistanceLevel = null;
      this._log(`writing queued resistance level ${level}`);
      try {
        await this._writeResistanceTarget(level);
        this._log(`resistance level ${level} write completed (no ATT error) — check the next few notify frames' decoded resistance to confirm the console actually applied it`);
      } catch (err) {
        console.warn('[proform-750r] resistance write failed:', err.message);
      }
    }

    this._pollIndex = (this._pollIndex + 1) % POLL_FRAMES_750R.length;
  }

  // ─── Resistance control ─────────────────────────────────────────────────────

  /**
   * Queue a resistance-level change (1–24) to go out on the next poll cycle.
   * Takes effect on the console within one poll cycle (~1.2s worst case) —
   * check metrics.resistance a beat later, not immediately after calling.
   * Named to match the device interface control/mode-switch.js's
   * capability detection expects (same as ble/ftms-device.js and
   * ble/merach-device.js) — this is what lets ModeSwitch pick this device
   * up for ERG (via the software SmartErgMode loop, same as Merach) with
   * no changes to mode-switch.js itself.
   *
   * VERIFIED, with per-level provenance unchanged from before: a btsnoop
   * capture of the stock iFit app driving a real 750R confirms the unlock
   * frame and levels 2 & 3 byte-for-byte, with the console's own telemetry
   * round-tripping the change (1→2, then 2→3) right after each write — see
   * the file header. Level 5 was confirmed separately, live, using this
   * file's own debug logging (`instance.debug = true` from devtools) — a
   * genuine 3→5 transition, not just an unchanged value read back. Levels
   * 1, 4, and 6–24 are still only the reference project's numbers,
   * unexercised individually against real hardware. On top of that,
   * physically watching/feeling the resistance mechanism engage on a real
   * unit is now also confirmed (see file header) — that's what's newly
   * different from before, and why this is now wired into ModeSwitch and
   * registers ROLES.CONTROLLABLE_TRAINER once unlocked (see
   * _runInitThenPoll()).
   * @param {number} level  1–24
   * @returns {Promise<void>}  Resolves once the level is queued — NOT once
   *   the poll loop has actually written it to the console (~1.2s later,
   *   worst case; see _pollTick()). This device's control protocol has no
   *   per-write acknowledgment exposed at this layer the way Merach's
   *   control-point indication does, and any write failure that happens
   *   later, when the poll loop actually sends the frame, is already
   *   caught and logged there (see _pollTick()) rather than propagated —
   *   there's no caller left holding this promise by that point to reject.
   *   Still needs to return a real Promise, though: SmartErgMode's
   *   _applyResistance() calls `.catch().finally()` on the return value
   *   unconditionally (same contract ble/ftms-device.js and
   *   ble/merach-device.js's async setResistanceTarget() satisfy) — a bare
   *   synchronous return crashed with "Cannot read properties of
   *   undefined (reading 'catch')" the moment ERG mode tried to use it.
   *   Deliberately NOT made `async`, though: that would turn the
   *   validation throw above into a rejected promise instead of a
   *   synchronous throw, breaking direct callers like
   *   `window.__debug.trainer().setResistanceLevel(99)` in a synchronous
   *   try/catch.
   */
  setResistanceTarget(level) {
    if (!Number.isInteger(level) || level < 1 || level > RESISTANCE_LEVEL_FRAMES.length) {
      throw new Error(`setResistanceTarget: level must be an integer 1–${RESISTANCE_LEVEL_FRAMES.length}, got ${level}`);
    }
    this._log(`queued resistance level ${level}`, [2, 3, 5, 8].includes(level)
      ? '(hardware-confirmed frame)'
      : '(⚠️ frame not individually hardware-confirmed — see RESISTANCE_LEVEL_FRAMES header)');
    this._pendingResistanceLevel = level;
    return Promise.resolve();
  }

  /**
   * Back-compat alias for setResistanceTarget() — this method was named
   * setResistanceLevel() before ERG mode was wired in (see git history /
   * the previous version of this file). Kept as a thin delegate, not a
   * second implementation, so devtools one-liners like
   * `window.__debug.trainer().setResistanceLevel(3)` keep working without
   * needing every call site updated to the new name. setResistanceTarget()
   * is still the one mode-switch.js's capability detection looks for
   * (matching ble/ftms-device.js / ble/merach-device.js) — this alias
   * exists purely for external/manual callers, not for anything internal
   * to this class or ModeSwitch.
   * @param {number} level  1–24
   */
  setResistanceLevel(level) {
    this.setResistanceTarget(level);
  }

  async _writeResistanceTarget(level) {
    // Write WITH response — see the note in _pollTick(). Per legend
    // section 5: the unlock frame is fire-and-forget, but the level frame
    // that follows needs the actual notify awaited before this resolves
    // — same rationale as the step-5 wait in _pollTick(), see
    // _waitForNextNotify().
    await this.controlPoint.writeValueWithResponse(Uint8Array.from(UNLOCK_RESISTANCE_FRAME));
    await this.controlPoint.writeValueWithResponse(Uint8Array.from(RESISTANCE_LEVEL_FRAMES[level - 1]));
    await this._waitForNextNotify('resistance-write');
  }

  // ─── Packet handling ────────────────────────────────────────────────────────

  /**
   * Decode one notification packet into this.metrics. The 750R multiplexes
   * (at least) two different 20-byte frame shapes onto the same
   * characteristic, distinguished by their first two bytes.
   * @param {Uint8Array} bytes
   */
  _handlePacket(bytes) {
    if (bytes.length !== 20) return;

    if (bytes[0] === 0xff && bytes[1] === 0x11) {
      this._handleStrokeFrame(bytes);
      return;
    }

    if (bytes[0] === 0x00 && bytes[1] === 0x12) {
      this._handleTelemetryFrame(bytes);
      return;
    }

    if (bytes[0] === 0xff && bytes[1] === 0x0e) {
      this._handleStrokeCountFrame(bytes);
      return;
    }

    // Other 20-byte shapes show up on this channel too (e.g. the write
    // characteristic's own frames briefly echoing back, including the
    // 0xfe,0x02,0x21,0x03 mirror of the 0xff,0x0e frame just above — same
    // payload from byte 4 on, so nothing is lost by leaving the echo
    // itself unhandled) — nothing this wrapper currently surfaces lives
    // in the rest of them, so they're left unhandled.
  }

  /**
   * Stroke-rate frame — bytes 2–9 are zero on the variant that carries it.
   *
   * The "stale/transitional frame" skip below (strokeRate===0 with a
   * nonzero strokePeriod still in the payload) means a genuine stop isn't
   * always confirmable from this frame shape alone — on real consoles the
   * period field can hold its last value indefinitely once strokes stop,
   * rather than itself resetting to 0. Left alone, that's the same failure
   * mode ble/merach-device.js documents and fixes for its own cadence
   * field: a stuck nonzero reading permanently satisfies ModeSwitch's
   * `cadence > 0 || watts > 0` activity check, so onIdle()/auto-pause can
   * never fire on rider idleness once one of these frames has been skipped
   * at the wrong moment. Unlike Merach, this device has no tick/pulse
   * signal to gate on directly — see the timeout-based fallback in
   * _handleTelemetryFrame() instead, which forces strokeRate back to 0 if
   * this method hasn't confirmed a real nonzero reading in a while.
   */
  _handleStrokeFrame(bytes) {
    for (let i = 2; i <= 9; i++) {
      if (bytes[i] !== 0) return;
    }

    const strokeRate = bytes[12];
    // Bytes 13–14 carry a raw stroke-cycle period the reference driver
    // turns into a speed figure — left undecoded here. Not just a ROLES
    // gap: this whole frame shape (0xff,0x11, byte0/byte1) never once
    // appeared across three captured real sessions (1061 notifications,
    // zero occurrences) — it's a qdomyos-zwift-derived guess that doesn't
    // match this console's actual traffic, not something to wire up as-is
    // even now that SPEED_SOURCE is registered (see toPartialData() —
    // speed there is derived from the distance counter in
    // _handleTelemetryFrame() instead, which does appear on the wire).
    const strokePeriod = readUint16LE(bytes, 13);

    if (strokeRate === 0 && strokePeriod > 0) return; // stale/transitional frame

    this.metrics.strokeRate = strokeRate;
    if (strokeRate > 0) {
      this._lastStrokeRateTime = Date.now();
      this._noteLiveReading('stroke rate', strokeRate);
    }
  }

  /**
   * Cumulative stroke count — bytes[0..1] = 0xff,0x0e, a frame shape
   * distinct from both _handleStrokeFrame()'s 0xff,0x11 (instantaneous
   * stroke rate) and _handleTelemetryFrame()'s 0x00,0x12 (power/
   * resistance/distance); byte[12] here is a running total for the
   * session, not a rate.
   *
   * Provenance: read as 0x20 (32) across every instance of this frame in
   * a debug capture taken while the console's own physical display was
   * watched ticking from 31 to 32 strokes over that same window — one
   * real confirmation, not yet round-tripped across a full session the
   * way e.g. RESISTANCE_LEVEL_FRAMES has been. The rest of the frame
   * (bytes 2–11, 13–19) is undecoded; nothing else in it has been
   * correlated against a known value yet.
   *
   * Cadence wiring: unlike _handleStrokeFrame()'s byte 12 (the console's
   * own already-computed instantaneous figure, with no independent check
   * against a known value), this running total is a genuine stroke-
   * completion event count — the same kind of signal a standard cycling
   * cadence sensor's cumulative crank-revolution count is. The time
   * between two counts advancing is therefore a real stroke-rate
   * measurement, computed below and written into the same
   * this.metrics.strokeRate field _handleStrokeFrame() writes (and
   * toPartialData() already reads for `cadence`) rather than a separate
   * metric — both frames report the same underlying quantity from two
   * vantage points, and downstream code only expects one. Whichever
   * frame arrives most recently with a confirmed reading wins, the same
   * "last writer" merging _handleTelemetryFrame() already does for
   * power/resistance/distance.
   *
   * The count is a single byte (0-255) and wraps — handled below. A
   * count that hasn't advanced since the last frame is NOT treated as
   * "stopped": rowing strokes take on the order of a couple of seconds
   * each, so most frames in between two real strokes will legitimately
   * show a zero delta, and forcing cadence to 0 on every one of those
   * would make it flicker off between strokes instead of holding a
   * steady reading. The actual "rider stopped" case is still caught by
   * the STROKE_IDLE_TIMEOUT_MS fallback in _handleTelemetryFrame(), which
   * this method feeds via _lastStrokeRateTime whenever it confirms a real
   * (nonzero-delta) reading — the same clock _handleStrokeFrame() feeds,
   * so either frame source can keep that fallback from firing. This also
   * updates the note on _handleStrokeFrame(): this device now does have
   * a tick-like signal to gate genuine stops on, it just arrives on a
   * separate frame shape from the one that carries the console's own
   * instantaneous figure.
   *
   * Like distanceMeters, the raw running total itself is left out of
   * toPartialData() — nothing downstream expects a strokeCount field —
   * but it's on this.metrics for anything that wants the device's own
   * count directly.
   */
  _handleStrokeCountFrame(bytes) {
    const count = bytes[12];
    this.metrics.strokeCount = count;
    const now = Date.now();

    // Confirmed against two independent real captures (idle tails of two
    // separate sessions, ~80 and ~72 ff,0x0e frames each): bytes[13,14]
    // never touch zero while a stroke has happened recently, and pin to
    // 0 the instant the console itself flags idle — a device-reported
    // idle signal, not something this wrapper has to infer from
    // STROKE_IDLE_TIMEOUT_MS's wall-clock fallback in
    // _handleTelemetryFrame(). Checked before the delta math below so a
    // stale nonzero rate can't survive to the end of a recording if the
    // rider stops in the last few seconds of a session (the fallback's
    // 3-second window may never get to fire before recording stops).
    if (bytes[13] === 0 && bytes[14] === 0) {
      if (this.metrics.strokeRate !== 0) {
        this.metrics.strokeRate = 0;
        this._lastStrokeRateTime = now;
      }
      this._lastStrokeCount = count;
      this._lastStrokeCountTime = now;
      return;
    }

    if (this._lastStrokeCount === null) {
      this._lastStrokeCount = count;
      this._lastStrokeCountTime = now;
      return;
    }

    let deltaCount = count - this._lastStrokeCount;
    if (deltaCount < 0) deltaCount += 256;

    if (deltaCount === 0) return; // don't touch _lastStrokeCountTime — let time accumulate

    const deltaTimeMs = now - this._lastStrokeCountTime;
    this._lastStrokeCount = count;
    this._lastStrokeCountTime = now;

    if (deltaTimeMs < MIN_STROKE_COUNT_INTERVAL_MS) return;

    const strokeRate = (deltaCount / deltaTimeMs) * 60000;
    this.metrics.strokeRate = strokeRate;
    this._lastStrokeRateTime = now;
    this._noteLiveReading('stroke rate', strokeRate);
  }

  /** Main telemetry frame — power, resistance, cumulative distance. */
  _handleTelemetryFrame(bytes) {
    if (bytes[2] !== 0x01 || bytes[3] !== 0x04 || bytes[4] !== 0x02) return;

    const knownSubtype = bytes[5] === 0x2e || bytes[5] === 0x30 || bytes[5] === 0x31;
    if (!knownSubtype) return;

    // A run of 0xFF in the payload tail shows up before the console has
    // real numbers to report (e.g. right after connecting) — treat as
    // "nothing to update" rather than as power=65535.
    let isPlaceholder = true;
    for (let i = 12; i <= 19; i++) {
      if (bytes[i] !== 0xff) { isPlaceholder = false; break; }
    }
    if (isPlaceholder) return;

    this.metrics.power = readUint16LE(bytes, 12);
    this.metrics.resistance = decodeResistanceLevel(bytes[11]);
    if (this.metrics.power > 0) this._noteLiveReading('power', this.metrics.power);

    const rawDistance = readUint16LE(bytes, 14);

    // Confirmed via real capture: the console zeroes power AND this raw
    // distance counter the instant it flags idle, while its own physical
    // display keeps the real cumulative total counting (cross-checked
    // against the console readout: raw counter read 271 alongside a
    // manually-transcribed "Dist: 167mi", i.e. 268.8m — within ~1% —
    // then two poll cycles later power/distance both read 0 while the
    // console's own odometer had advanced to "Dist: 169mi", not reset).
    // Treat that specific pattern as "hold the last real value", not as
    // "distance is genuinely 0" — otherwise a rider's recorded distance
    // visibly erases itself on every pause.
    const isIdleReset = this.metrics.power === 0 && rawDistance === 0 && this._lastRawDistance > 0;

    if (!isIdleReset) {
      const distanceMeters = rawDistance * this._params.distanceMetersPerRawUnit;
      const now = Date.now();
      if (this._lastDistanceTime != null) {
        const deltaSec = (now - this._lastDistanceTime) / 1000;
        if (deltaSec > 0) {
          this.metrics.speed = Math.max(0, ((distanceMeters - this.metrics.distanceMeters) / deltaSec) * 3.6);
        }
      }
      this.metrics.distanceMeters = distanceMeters;
      this._lastDistanceTime = now;
      // Only move the hold-guard forward on a reading we actually accepted
      // as real. If this ran unconditionally (every frame, including held
      // ones), the first idle frame would correctly hold at the last real
      // value but then overwrite _lastRawDistance with 0 — which unarms
      // the `_lastRawDistance > 0` check above and lets the very next idle
      // frame fall through as if it were a genuine reading, erasing the
      // held distance right back to 0. An idle period is normally many
      // frames long (confirmed: dozens of ff,0x0e frames per pause in both
      // captured sessions), so this isn't an edge case — it would have
      // undone the fix for every pause after its first poll cycle.
      this._lastRawDistance = rawDistance;
    } else {
      this.metrics.speed = 0;
    }

    // Staleness fallback for strokeRate — see _handleStrokeFrame()'s
    // docstring. This frame arrives reliably every poll cycle (it's what
    // the six-packet keep-alive keeps flowing), so it's a good steady
    // clock to check "have we confirmed real stroking recently?" against,
    // independent of whether stroke frames themselves keep showing up.
    if (this.metrics.strokeRate > 0 && Date.now() - this._lastStrokeRateTime > STROKE_IDLE_TIMEOUT_MS) {
      this.metrics.strokeRate = 0;
    }
  }

  // ─── Calibration ────────────────────────────────────────────────────────────

  /**
   * Run calibration for a metric and hot-reload the new params (no reconnect needed).
   * @param {'distance'} metricName
   * @param {Object} ctx  { computed, reference }
   */
  async calibrate(metricName, ctx) {
    this._params = await this._calibration.calibrate(PROFORM_750R_DEVICE_TYPE, metricName, ctx);
    return { ...this._params };
  }

  /** Current calibration coefficients in effect. */
  calibrationParams() { return { ...this._params }; }

  // ─── Sample bridge ──────────────────────────────────────────────────────────

  /**
   * Shape session.js / app.js expect from any connected controller (same
   * fields FtmsDevice and MerachDevice produce). Speed is derived in
   * _handleTelemetryFrame() from the delta of the console's own raw
   * distance counter (km/h, matching core/sample.js's documented unit for
   * this field) — there's no native speed field in this firmware's real
   * traffic (legend.md's Frame A / 0xff,0x11 "cadence/speed" frame, ported
   * from the qdomyos-zwift reference, never once appeared across 1061 real
   * notifications in three captured sessions), so this is derived rather
   * than decoded directly. Calories stays `null` — not confirmed decodable
   * from this protocol (see the file header on why it was left out rather
   * than guessed at). metrics.distanceMeters (the console's own odometer)
   * isn't included here because session.js integrates distance from
   * `.speed` itself (recording/session.js#_tick) rather than reading a
   * device total — it's still available directly off the device instance
   * if that's ever worth wiring in, the way session.js already prefers a
   * device's own calories over its power-based estimate when present.
   */
  toPartialData() {
    return {
      power: this.metrics.power ?? null,
      cadence: this.metrics.strokeRate ?? null,
      speed: this.metrics.speed ?? null,
      resistance: this.metrics.resistance ?? null,
      calories: this.metrics.calories ?? null,
    };
  }
}

export default Proform750rDevice;