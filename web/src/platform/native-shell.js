// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * platform/native-shell.js
 *
 * One place to answer "am I running inside the MAUI HybridWebView shell, or
 * a plain browser/PWA tab?" Two signals, checked in order:
 *
 *   1. __EG_NATIVE_SHELL_BUILD__ — a build-time constant (see
 *      vite.config.js's "maui" mode) baked into the bundle produced by
 *      `npm run build:maui`. True whenever this bundle was built to be
 *      copied into app/Ergnova/Resources/Raw/wwwroot.
 *   2. window.HybridWebView — set at runtime by the `_framework/
 *      hybridwebview.js` script MAUI injects into the page (see
 *      index.html). This is the more reliable signal for "is a native
 *      bridge actually present right now", since in principle someone
 *      could open the same maui-mode build in a plain desktop browser
 *      (e.g. while iterating on styling) where HybridWebView won't exist.
 *
 * Nothing here decides *which* bridge (BLE, file save, wake lock, ...) is
 * live — each of those still resolves independently and falls back to its
 * own web implementation when the native side isn't there (see
 * ble/transport/index.js for the pattern this follows). This module is
 * only for the handful of "shell chrome" decisions that don't have a
 * meaningful web fallback at all, e.g. hiding the PWA install prompt (§9)
 * or greying out the BLE Debug Console entry (Web-Bluetooth-only, see its
 * Settings tooltip).
 */

// Replaced at build time by Vite's `define` when mode === 'maui'; false
// (not just falsy-undefined) for every other build, including plain `npm
// run dev`/`npm run build`.
const BUILT_FOR_NATIVE_SHELL =
  typeof __EG_NATIVE_SHELL_BUILD__ !== 'undefined' && __EG_NATIVE_SHELL_BUILD__;

export const nativeShell = {
  /** True only once app/Ergnova's HybridWebView has actually injected its bridge script. */
  get isActive() {
    return typeof window !== 'undefined' && !!window.HybridWebView;
  },

  /** True if this bundle was built via `npm run build:maui`, regardless of where it's currently running. */
  get isNativeBuild() {
    return BUILT_FOR_NATIVE_SHELL;
  },
};

export default nativeShell;
