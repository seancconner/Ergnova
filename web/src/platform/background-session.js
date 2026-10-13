// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * platform/background-session.js
 *
 * Keeps a running workout alive while the rider switches apps or locks the
 * phone — native (MAUI) shell only. On Android the shell answers this with a
 * foreground service plus an ongoing notification-tray entry that shows the
 * workout's live stats and a system-rendered elapsed timer (see
 * Ergnova/Platforms/Android/ErgnovaSessionService.cs). Everywhere else —
 * a plain browser/PWA tab, Windows, Mac Catalyst, iOS — there's no
 * bridge (or the bridge reports `supported: false`), every call below
 * no-ops, and the app keeps its old behavior of pausing + snapshotting the
 * session the moment the page is hidden (see app.js's visibilitychange
 * handler and recording/session-persistence.js).
 *
 * The app never talks to the bridge directly — it just tells this module what
 * SHOULD be showing right now via sync(snapshot), where snapshot is either
 * null (no session in progress) or:
 *
 *   {
 *     title:      'Free Ride',
 *     status:     'running' | 'paused' | 'waiting',
 *     elapsedSec: 754.2,               // excludes paused time, same as Session#elapsedSec
 *     text:       '215 W · 148 bpm',   // collapsed notification line, already unit-formatted
 *     expanded:   'multi\nline text',  // optional; shown when the notification is expanded
 *     metrics:    [{ key: 'power', label: 'Power', value: '215', unit: 'W', color: '#f97316' }, ...],
 *     notes:      [{ key: 'step', text: 'Step 2/5 · Interval', trailing: '1:30 left' }, ...],
 *     totals:     [{ key: 'calories', label: 'Calories', value: '121', unit: 'kcal', color: null }, ...],
 *   }
 *
 * `text` / `expanded` are the plain-text rendering; `metrics` / `notes` /
 * `totals` are the same readings in structured form, which the Android shell
 * draws as icon layouts at three levels of detail: a status-bar icon that
 * rotates through `metrics`, a collapsed row of icon chips, and an expanded
 * grid with context lines and totals. See background-snapshot.js for how they
 * are built and BackgroundNotificationViews.cs for how they are drawn. This
 * module treats the whole snapshot as opaque: it only reads `status`, `title`,
 * `text` and `expanded` to decide when something changed, and `expanded` is
 * derived from every structured field, so a change to any of them still shows
 * up there.
 *
 * and this module decides when to start the native service, when to push an
 * update (throttled to ~1/s), and when to stop it — including when the rider
 * turns the "Background workout notification" setting off mid-session.
 *
 * Because Android requires a visible notification for any app that keeps
 * running in the background, "notification off" and "keep running in the
 * background off" are the same switch: setEnabled(false) stops the service.
 *
 * The notification is also a remote control. Its action button follows
 * snapshot.status — Pause while 'running', Play while 'paused', "Start now"
 * while 'waiting' — and a tap on it comes back the other way as a native
 * push: the bridge calls the handler this module registers with it, which
 * calls whatever app.js passed to onAction(cb) as cb('pause' | 'play').
 * The page stays the single source of truth for workout state: the native
 * side never flips its own button, it just asks, and the notification
 * changes when the next snapshot says the workout actually changed.
 */

const MIN_UPDATE_INTERVAL_MS = 1000;
// After a failed start, don't hammer the bridge on every 1 Hz sample — wait
// this long before trying again (a new session / toggling the setting resets it).
const START_RETRY_BACKOFF_MS = 30_000;

function _bridge() {
  return typeof window !== 'undefined' ? window.__ergnovaNativeBackground : undefined;
}

let _info = { supported: false, platform: 'web', notificationsAllowed: true, running: false, error: null };
let _enabled = true;        // the rider's setting
let _desired = null;        // latest snapshot handed to sync(), or null when no session
let _starting = false;      // a Start call is in flight
let _running = false;       // native side confirmed the service is up
let _retryAfter = 0;        // epoch ms — no start attempts before this
let _lastShape = '';        // `${status}|${title}` of the last thing sent
let _lastContent = '';      // `${text}|${expanded}` of the last thing sent
let _lastSentAt = 0;
let _problemCb = () => {};
let _problemReportedFor = null; // which kind of problem we already told the rider about this session
let _actionCb = () => {};       // app.js's handler for notification button taps — see onAction()

function _merge(info) {
  if (info && typeof info === 'object') _info = { ..._info, ...info };
}

function _reportProblem(kind, message) {
  if (_problemReportedFor === kind) return; // once per session per kind — this runs at 1 Hz
  _problemReportedFor = kind;
  try { _problemCb(message, kind); } catch { /* UI callback must never break the workout */ }
}

/**
 * A tap on the notification's Pause / Play button, pushed up from the native
 * shell. `_lastShape` is cleared first so the update that follows the app's
 * reaction is sent immediately even if the reaction changed nothing (a stale
 * tap on a button that had already flipped): the notification always ends up
 * showing what the page says, never what the tap assumed.
 */
function _handleNativeAction(action) {
  if (action !== 'pause' && action !== 'play') return;
  _lastShape = '';
  try { _actionCb(action); } catch (err) { console.warn('[background-session] action handler failed', err); }
  _reconcile();
}

/** Idempotent — hands the bridge our handler for native-originated actions. */
function _attachActionChannel() {
  _bridge()?.setActionHandler?.(_handleNativeAction);
}

function _resetSessionState() {
  _lastShape = '';
  _lastContent = '';
  _lastSentAt = 0;
  _problemReportedFor = null;
}

async function _start() {
  const b = _bridge();
  if (!b || _starting) return;
  _starting = true;
  // Captured up front: _desired can move on to a newer snapshot while the
  // native side is still bringing the service up, and the "what did we last
  // send" bookkeeping below has to describe what Start actually carried.
  const initial = _desired;
  try {
    const info = await b.start(initial);
    _merge(info);
    _running = !!info?.running;
    if (_running) {
      _lastShape = `${initial?.status}|${initial?.title}`;
      _lastContent = `${initial?.text}|${initial?.expanded ?? ''}`;
      _lastSentAt = Date.now();
      if (info.notificationsAllowed === false) {
        _reportProblem('notifications',
          'Notifications are blocked for Ergnova — it will keep running in the background, but the workout notification won\u2019t show.');
      }
    } else {
      _retryAfter = Date.now() + START_RETRY_BACKOFF_MS;
      _reportProblem('start',
        `Couldn\u2019t keep the workout running in the background${info?.error ? ` (${info.error})` : ''}. Switching apps may pause it.`);
    }
  } catch (err) {
    console.warn('[background-session] start failed', err);
    _running = false;
    _retryAfter = Date.now() + START_RETRY_BACKOFF_MS;
    _reportProblem('start', 'Couldn\u2019t keep the workout running in the background. Switching apps may pause it.');
  } finally {
    _starting = false;
    _reconcile(); // the wanted state may have changed while we were awaiting the native side
  }
}

function _stop() {
  const b = _bridge();
  if (_starting) return; // _start()'s finally block re-reconciles once it resolves
  _resetSessionState();
  _retryAfter = 0;
  if (!_running) return;
  _running = false;
  _merge({ running: false });
  b?.stop?.().catch(err => console.warn('[background-session] stop failed', err));
}

function _sendUpdate() {
  const b = _bridge();
  const s = _desired;
  if (!b || !s) return;

  const now = Date.now();
  const shape = `${s.status}|${s.title}`;
  const content = `${s.text}|${s.expanded ?? ''}`;
  const shapeChanged = shape !== _lastShape;
  const contentChanged = content !== _lastContent;
  const due = now - _lastSentAt >= MIN_UPDATE_INTERVAL_MS;

  // A status/title change (pause, resume, ...) goes out immediately so the
  // notification never lags a button press; plain metric changes are throttled.
  if (!shapeChanged && !(due && contentChanged)) return;

  _lastShape = shape;
  _lastContent = content;
  _lastSentAt = now;
  b.update(s).catch(err => console.warn('[background-session] update failed', err));
}

function _reconcile() {
  const b = _bridge();
  if (!b || !_info.supported) return;

  if (!_enabled || !_desired) {
    _stop();
    return;
  }
  if (_running) {
    _sendUpdate();
  } else if (!_starting && Date.now() >= _retryAfter) {
    _start();
  }
}

export const backgroundSession = {
  /** Reads what the native side supports (platform, notification permission
   *  state). Safe to call repeatedly; resolves to the info object either way. */
  async init() {
    const b = _bridge();
    if (!b) return _info;
    _attachActionChannel();
    try { _merge(await b.getInfo()); } catch (err) { console.warn('[background-session] getInfo failed', err); }
    // The native service can outlive the page (a WebView reload or renderer
    // crash resets every variable above but not the foreground service, whose
    // notification can't be swiped away). Adopt it, so reconcile either keeps
    // feeding it (a session is in progress) or stops it (nothing is).
    if (_info.supported && _info.running && !_running && !_starting) {
      _running = true;
      _reconcile();
    }
    return _info;
  },

  /** Re-reads permission state — call when the app returns to the foreground,
   *  since the rider may have flipped it in system settings meanwhile. */
  refresh() { return this.init(); },

  /** True only inside a native shell that can actually keep the app running. */
  get isSupported() { return !!_bridge() && _info.supported === true; },

  /** True while the native keep-alive service is confirmed running — app.js
   *  uses this to decide whether hiding the page should pause the session. */
  get isKeepingAlive() { return _running; },

  /** False when the OS is blocking Ergnova's notifications (the service can
   *  still run without them; only the tray entry is missing). */
  get notificationsAllowed() { return _info.notificationsAllowed !== false; },

  get isEnabled() { return _enabled; },

  /** The rider's setting. Turning it off stops the service immediately;
   *  turning it on starts one right away if a session is already running. */
  setEnabled(enabled) {
    const next = !!enabled;
    if (next === _enabled) return;
    _enabled = next;
    _retryAfter = 0;
    _reconcile();
  },

  /** Asks the OS for the notification permission (Android 13+ shows a system
   *  dialog; older versions resolve immediately). Resolves to the fresh info. */
  async requestPermissions() {
    const b = _bridge();
    if (!b || !_info.supported) return _info;
    try { _merge(await b.ensurePermissions()); } catch (err) { console.warn('[background-session] permission request failed', err); }
    return _info;
  },

  /** Jumps to the system's notification settings for this app — the only way
   *  back once the permission was denied with "don't ask again". */
  openNotificationSettings() {
    _bridge()?.openNotificationSettings?.().catch(() => {});
  },

  /** Registers a callback that receives a human-readable message when the
   *  service can't start or notifications are blocked. Called as
   *  cb(message, kind) where kind is 'start' | 'notifications'. */
  onProblem(cb) { _problemCb = typeof cb === 'function' ? cb : () => {}; },

  /** Registers the handler for the notification's Pause / Play button.
   *  Called as cb('pause' | 'play'). Actions are requests, not commands —
   *  the callback should apply them only if they still make sense (a tap on
   *  "Pause" after the workout already paused itself is a no-op) and then
   *  re-sync; this module re-sends the notification either way. */
  onAction(cb) {
    _actionCb = typeof cb === 'function' ? cb : () => {};
    _attachActionChannel();
  },

  /** Tells this module what should be showing right now — see the header. */
  sync(snapshot) {
    const wasNone = _desired == null;
    _desired = snapshot ?? null;
    if (wasNone && _desired) { _problemReportedFor = null; _retryAfter = 0; } // a new session gets a clean slate
    _reconcile();
  },
};

export default backgroundSession;
