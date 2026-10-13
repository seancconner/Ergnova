// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ux/fullscreen.js
 *
 * Wraps the Fullscreen API for the whole document. On Android this hides
 * the status bar and navigation bar (gesture pill or 3-button strip)
 * instead of reserving space for them, which matters most on the
 * training screens — see the --safe-bottom-eff / --safe-right-eff
 * workarounds in style.css for the gap this doesn't cover: the
 * pre-session screens, where there's no session yet to gate a fullscreen
 * request on, still rely on those safe-area calcs.
 *
 * startSession() no longer calls enter() automatically — starting a
 * workout should not force the whole document into fullscreen — so
 * today this is only exercised via stopSession()'s fullscreenUX.exit()
 * (a harmless no-op if fullscreen was never entered). enter() is kept
 * available for a future explicit fullscreen toggle; if one is wired up,
 * remember it must be called synchronously from a user-gesture handler
 * (a click), or the browser silently rejects it.
 *
 * Not supported everywhere (notably iOS Safari on iPhone) — every call
 * degrades to a no-op rather than throwing.
 *
 * Usage:
 *   import { fullscreenUX } from './ux/fullscreen.js';
 *   await fullscreenUX.enter();  // call synchronously from a click
 *   fullscreenUX.exit();         // call when done with fullscreen
 */

function _target() {
  return document.documentElement;
}

export const fullscreenUX = {
  get isSupported() {
    const el = _target();
    return !!(el.requestFullscreen || el.webkitRequestFullscreen);
  },

  get isActive() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  },

  async enter() {
    if (this.isActive) return;
    const el = _target();
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (el.webkitRequestFullscreen) { // older Chromium/Android WebViews
        await el.webkitRequestFullscreen();
      }
      console.debug('[fullscreen] Entered');
    } catch (err) {
      // Rejected (no user-activation, unsupported, another element already
      // fullscreen, etc.) — the app is still fully usable without it.
      console.warn('[fullscreen] Could not enter:', err.message);
    }
  },

  exit() {
    if (!this.isActive) return;
    const exitFn = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      exitFn?.call(document)?.catch?.(() => {});
    } catch { /* already exiting/exited — nothing to do */ }
  },
};

// Keep a debug trail if the rider leaves fullscreen via the OS (back
// gesture, pulling down the status bar, etc.) rather than tapping Stop.
// Nothing to actively clean up on our end — the --safe-bottom-eff /
// --safe-right-eff CSS re-applies itself once the system bars are back —
// but this is useful while that workaround is still fresh.
if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', () => {
    console.debug('[fullscreen]', fullscreenUX.isActive ? 'entered' : 'exited');
  });
}

export default fullscreenUX;