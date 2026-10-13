// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * platform/save-file.js
 *
 * File *export* bridge (checklist §7 / native-shell-bridge.js's
 * `window.__ergnovaNativeFile`). One function, `saveFile(filename, blob)`,
 * and it is the ONLY place in the app that turns a Blob into a file the
 * person can keep. Every export goes through it — workout export
 * (ZWO/FIT/TCX/PWX/GPX via editor/workout-editor.js), activity export
 * (recording/activity-formats.js's downloadActivity(), which backs the
 * history list's download menu and every completion banner),
 * recording/fit-activity.js's downloadFit(), and the BLE Debug Console's
 * log/service-tree export (ui/ble-debug-flow.js).
 *
 * Do NOT reintroduce a bare `<a download>` click at a call site: inside the
 * MAUI HybridWebView shell the embedded WebViews have no download handler
 * wired up, so it can't be relied on to produce a file (on Android and
 * iOS/Mac Catalyst it does nothing) — which is exactly how exports went
 * dead once: the bridge below existed but nothing called it. The
 * platform/__native_file_print_smoketest__.js source scan fails if a call
 * site does this again.
 *
 * Resolution order mirrors ble/transport/index.js's pattern:
 *   1. window.__ergnovaNativeFile.saveBlob(filename, blob) — present only
 *      inside the MAUI HybridWebView shell (see native-shell-bridge.js and
 *      Services/NativeBridgeMethods.cs's FileSaveBlob). Routes through
 *      CommunityToolkit.Maui's FileSaver for a real native save/share-sheet
 *      flow on all four targets.
 *   2. A plain `<a download>` + object-URL click — the original web/PWA
 *      behavior (unchanged), used whenever the native bridge isn't present.
 *
 * Callers may ignore the returned Promise (none of them currently need
 * confirmation — export is "best effort, then move on"). It resolves
 * `true` when the file was written/handed to the platform, and `false`
 * when the native side reported a cancel/failure or the bridge call threw;
 * it never rejects. A person cancelling the native save dialog is
 * indistinguishable from a failure here, and shouldn't be treated as one.
 */

/**
 * @param {string} filename  suggested filename, extension included
 * @param {Blob}   blob
 * @returns {Promise<boolean>}
 */
export function saveFile(filename, blob) {
  if (typeof window !== 'undefined' && window.__ergnovaNativeFile) {
    return window.__ergnovaNativeFile.saveBlob(filename, blob).then(
      (saved) => saved !== false,
      (err) => {
        console.warn('[save-file] native saveBlob failed', err);
        return false;
      },
    );
  }

  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return Promise.resolve(true);
}

export default saveFile;
