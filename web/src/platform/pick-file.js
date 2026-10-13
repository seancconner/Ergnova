// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * platform/pick-file.js
 *
 * The import counterpart of platform/save-file.js: one function,
 * `pickTextFile()`, that lets the person choose a file and hands back its
 * text. Used by History's Import button (views/history-browser.js).
 *
 * Resolution order mirrors save-file.js:
 *   1. window.__ergnovaNativeFile.pickText() — present only inside the MAUI
 *      HybridWebView shell (see native-shell-bridge.js and
 *      Services/NativeBridgeMethods.cs's FilePickText). Uses MAUI's
 *      FilePicker, so it's a real native document picker on all four
 *      targets. It exists because a plain <input type="file"> can't be relied
 *      on there: the Android shell installs its own WebChromeClient
 *      (ErgnovaWebChromeClient) which doesn't implement the file-chooser
 *      callback a WebView needs to open one.
 *   2. A hidden <input type="file"> — the web/PWA behavior, and the fallback
 *      if the bridge call itself throws (e.g. an older shell build that
 *      doesn't have FilePickText yet).
 *
 * Resolves { name, text } for the chosen file, or null if the person cancelled.
 * Rejects only if a file was chosen but couldn't be read.
 */

/**
 * @param {Object} [opts]
 * @param {string} [opts.accept='.json,application/json']  Filter for the web <input>. (The native picker
 *   shows every file: MIME types for .json vary too much between Android document providers to filter on.)
 * @returns {Promise<{ name: string, text: string } | null>}
 */
export async function pickTextFile({ accept = '.json,application/json' } = {}) {
  if (typeof window !== 'undefined' && window.__ergnovaNativeFile?.pickText) {
    try {
      const picked = await window.__ergnovaNativeFile.pickText();
      return picked && typeof picked.text === 'string' ? { name: String(picked.name ?? ''), text: picked.text } : null;
    } catch (err) {
      console.warn('[pick-file] native pickText failed, falling back to <input type="file">', err);
    }
  }
  return pickViaInput(accept);
}

function pickViaInput(accept) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;

    const finish = (fn, value) => { input.remove?.(); fn(value); };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { finish(resolve, null); return; }
      try {
        finish(resolve, { name: file.name, text: await file.text() });
      } catch (err) {
        finish(reject, err);
      }
    });
    // Fires when the dialog is dismissed without a choice (Chrome 113+, Safari 16.4+). Where it doesn't,
    // the promise simply stays pending — callers must not leave the UI locked while waiting on it.
    input.addEventListener('cancel', () => finish(resolve, null));

    document.body.appendChild(input);
    input.click();
  });
}

export default pickTextFile;
