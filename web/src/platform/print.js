// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * platform/print.js
 *
 * Print bridge (native-shell-bridge.js's `window.__ergnovaNativePrint`).
 * One function, `printPage(jobName, { html })`, used by anything that needs
 * the platform's print flow — today that's ui/recipe-print.js's Print button.
 *
 * Why this exists: `window.print()` is a silent no-op inside the MAUI
 * HybridWebView shell on Android and on iOS/Mac Catalyst (WKWebView) — the
 * embedded WebView has no print handler unless the native side wires one
 * up — so a bare `window.print()` "does nothing" there. Resolution order
 * mirrors platform/save-file.js:
 *   1. window.__ergnovaNativePrint.printPage(jobName, html) — present only
 *      inside the MAUI shell (see Services/NativeBridgeMethods.cs's
 *      PrintCurrentPage / Services/PrintService.cs).
 *        - With `html` (a complete standalone document, see
 *          platform/print-document.js) Android and iOS / Mac Catalyst print
 *          *that document* — white paper, black ink — and never touch the
 *          live app page, which is dark-themed and not safe to hand to a
 *          print engine (it printed as an empty page in app colors).
 *        - Without `html`, or on Windows (whose WebView2 print UI applies
 *          the page's `@media print` rules correctly), it prints *whatever
 *          the page is showing right now* — so in that case the caller must
 *          leave its printable content on screen until the person is done
 *          (ui/recipe-print.js does).
 *   2. window.print() — the normal web/PWA behavior, also used as the
 *      fallback if the native side says it couldn't launch a print flow.
 *
 * Resolves `true` once a print flow was launched (native or browser) and
 * `false` only if neither path could run. It never rejects. Note the native
 * path does NOT fire `afterprint` in the page, so a caller that closes its
 * preview from that event must not assume it will arrive. The window.print()
 * fallback always prints the live page (style.css's `@media print` block).
 */

/**
 * @param {string} [jobName]  shown by the OS print UI / spooler where the platform supports it
 * @param {Object} [opts]
 * @param {string} [opts.html]  complete standalone HTML document for the native
 *   shell to print instead of the live page (see platform/print-document.js)
 * @returns {Promise<boolean>}
 */
export async function printPage(jobName = 'Ergnova', { html = '' } = {}) {
  if (typeof window === 'undefined') return false;

  const native = window.__ergnovaNativePrint;
  if (native) {
    try {
      if (await native.printPage(jobName, html)) return true;
      console.warn('[print] native print unavailable — falling back to window.print()');
    } catch (err) {
      console.warn('[print] native printPage failed — falling back to window.print()', err);
    }
  }

  try {
    window.print();
    return true;
  } catch (err) {
    console.warn('[print] window.print() failed', err);
    return false;
  }
}

/**
 * Whether the native print engine that will receive the standalone document can
 * lay it out as two side-by-side columns without risking a long recipe being
 * clipped at the end of page one. Today that's Android only (Chromium's WebView
 * splits a tall table row across pages); iOS / Mac Catalyst print through
 * UIMarkupTextPrintFormatter, an older text renderer, so they get the stacked
 * single-column layout. Windows and the browser print the live page and never
 * use the standalone document, so the answer doesn't matter there.
 *
 * @returns {boolean}
 */
export function printDocumentSupportsColumns() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return !!window.__ergnovaNativePrint && /Android/i.test(navigator.userAgent || '');
}

/**
 * Whether the native shell prints the standalone document (platform/
 * print-document.js) rather than the live page — i.e. Android and iOS / Mac
 * Catalyst. Windows' WebView2 print UI and the plain browser print the live
 * page, so the standalone document is never what comes out there. The recipe
 * preview uses this to show the page that will actually print.
 *
 * @returns {boolean}
 */
export function printUsesStandaloneDocument() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return !!window.__ergnovaNativePrint && !/Windows/i.test(navigator.userAgent || '');
}

export default printPage;
