// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

namespace Ergnova.Services;

/// <summary>
/// Platform seam behind window.__ergnovaNativePrint (see web/src/platform/print.js
/// for the JS-side contract, and web/public/native-shell-bridge.js for the glue that
/// reaches NativeBridgeMethods.PrintCurrentPage, which just delegates here).
///
/// Why a native print path exists at all: window.print() is a silent no-op inside the
/// Android WebView and WKWebView (iOS / Mac Catalyst) that HybridWebView wraps, so the
/// recipe sheet's Print button did nothing there.
///
/// Two ways to print, chosen by whether the caller supplies <c>html</c>:
/// <list type="bullet">
/// <item><b>A standalone HTML document</b> (web/src/platform/print-document.js builds it:
/// white background, black ink, no app CSS). Android prints it from a throwaway off-screen
/// WebView, iOS / Mac Catalyst through UIMarkupTextPrintFormatter. This is the path the
/// recipe sheet uses. It exists because handing the *live* dark-themed app page to those
/// print engines produced an empty page in app colors — they don't reliably apply the
/// page's @media print rules, and the cockpit layout's fixed overlay / overflow:hidden
/// shell doesn't paginate — and because a white document costs no ink.</item>
/// <item><b>The live page</b> (no html, and always on Windows): whatever the HybridWebView
/// is currently showing goes to the platform print flow, which applies the page's own
/// @media print CSS (web/src/style.css's "Printable recipe sheet" block). WebView2's print
/// UI does that correctly. On this path the web side has to keep the printable content on
/// screen until the person is done.</item>
/// </list>
/// </summary>
public interface IPrintService
{
    /// <summary>Launches the platform print flow. Returns true once the print UI was
    /// launched; false if this platform can't print or the UI couldn't be shown (the JS
    /// side then falls back to window.print()). "Launched" is deliberately all this
    /// promises — Android and Windows hand the job to the OS and return immediately; iOS /
    /// Mac Catalyst return when the print sheet is dismissed. Never throws for a
    /// can't-print condition.</summary>
    /// <param name="webView">The app's HybridWebView — used only by the live-page path.</param>
    /// <param name="jobName">Title for the print job / spooler entry, where the platform
    /// shows one.</param>
    /// <param name="html">A complete standalone HTML document to print instead of the live
    /// page, or null/empty to print the live page. Ignored on Windows.</param>
    Task<bool> PrintAsync(HybridWebView webView, string jobName, string? html = null);
}
