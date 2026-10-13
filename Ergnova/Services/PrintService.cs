// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

namespace Ergnova.Services;

/// <summary>
/// The one IPrintService implementation, branching per target inside the file (unlike
/// IBackgroundSessionService, which is Android-only and so needs an "unsupported" twin):
/// all four targets have a native print flow, and iOS / Mac Catalyst share identical code,
/// so four registrations would just be four places to keep in sync.
///
/// When the caller supplies a standalone HTML document (see IPrintService for why), Android
/// and iOS / Mac Catalyst print that document and never touch the live app page. Windows
/// always prints the live page: WebView2's print UI lays it out with @media print correctly,
/// and there is no cheap off-screen WebView2 to print from.
///
/// Everything runs on the UI thread: InvokeDotNet doesn't promise which thread a bridge
/// method arrives on (MainPage.xaml.cs documents the same trap for SendRawMessage), and
/// WebView objects and print UIs must be touched from the main thread.
///
/// Verification status: written against the Android, WebView2 and UIKit print APIs without
/// a .NET SDK or a device available in the environment that produced it — not compiled, not
/// run. The Android off-screen-WebView pattern is Google's documented "print an HTML
/// document" recipe, and UIMarkupTextPrintFormatter is UIKit's purpose-built HTML printer,
/// but both want a look on real hardware. Two things worth checking on a device: that the
/// printed page is plain white with black text (and, on iOS, that a long recipe paginates
/// instead of being cut off), and that the Android print preview shows the recipe rather
/// than a blank page (which would mean the document was handed over before it finished
/// loading).
/// </summary>
public sealed class PrintService : IPrintService
{
    public Task<bool> PrintAsync(HybridWebView webView, string jobName, string? html = null)
    {
        var name = CleanJobName(jobName);
        var document = string.IsNullOrWhiteSpace(html) ? null : html;
        return Microsoft.Maui.ApplicationModel.MainThread.InvokeOnMainThreadAsync(async () =>
        {
            try
            {
                return await PrintOnMainThreadAsync(webView, name, document);
            }
            catch (Exception ex)
            {
                // A print failure must never propagate across the bridge as an exception:
                // print.js treats false as "fall back to window.print()", which is exactly
                // the right recovery.
                System.Diagnostics.Debug.WriteLine($"[print] failed to launch print flow: {ex}");
                return false;
            }
        });
    }

    private static string CleanJobName(string? jobName)
    {
        var name = string.IsNullOrWhiteSpace(jobName) ? "Ergnova" : jobName.Trim();
        return name.Length > 80 ? name[..80] : name;
    }

#if ANDROID
    // How long to wait for the throwaway WebView to finish loading the document before
    // giving up (JS then falls back to window.print(), a no-op here — the person just sees
    // nothing happen, same as any other failed print launch).
    private static readonly TimeSpan HtmlLoadTimeout = TimeSpan.FromSeconds(10);

    // Held in a static so the throwaway WebView isn't collected while the print system is
    // still laying it out — Android's docs call this out explicitly. Replaced (not disposed)
    // by the next print job; only one print UI can be up at a time.
    private static global::Android.Webkit.WebView? s_printWebView;

    // PrintManager hands the job to the system print UI and returns immediately; the adapter
    // then lays the WebView out for the chosen paper size each time the person changes a
    // print option.
    private static async Task<bool> PrintOnMainThreadAsync(HybridWebView hybrid, string jobName, string? html)
    {
        var activity = Microsoft.Maui.ApplicationModel.Platform.CurrentActivity;
        var printManager = activity?.GetSystemService(global::Android.Content.Context.PrintService)
            as global::Android.Print.PrintManager;
        if (activity is null || printManager is null)
            return false;

        if (html is null)
        {
            // Live-page path: the adapter applies the page's own @media print rules.
            if (hybrid.Handler?.PlatformView is not global::Android.Webkit.WebView liveWebView)
                return false;

            var liveAdapter = liveWebView.CreatePrintDocumentAdapter(jobName);
            printManager.Print(jobName, liveAdapter, new global::Android.Print.PrintAttributes.Builder().Build()!);
            return true;
        }

        // Standalone-document path: a throwaway WebView that has never seen the app's CSS.
        // Printing has to wait for the load to finish or the adapter lays out a blank page.
        var launched = new TaskCompletionSource<bool>();
        var printWebView = new global::Android.Webkit.WebView(activity);
        printWebView.Settings.JavaScriptEnabled = false; // static document — nothing to run
        printWebView.SetWebViewClient(new PrintHtmlClient(jobName, printManager, launched));
        s_printWebView = printWebView;
        printWebView.LoadDataWithBaseURL(null, html, "text/html", "UTF-8", null);

        var finished = await Task.WhenAny(launched.Task, Task.Delay(HtmlLoadTimeout));
        return finished == launched.Task && launched.Task.Result;
    }

    private sealed class PrintHtmlClient : global::Android.Webkit.WebViewClient
    {
        private readonly string _jobName;
        private readonly global::Android.Print.PrintManager _printManager;
        private readonly TaskCompletionSource<bool> _launched;
        private bool _started;

        public PrintHtmlClient(string jobName, global::Android.Print.PrintManager printManager,
            TaskCompletionSource<bool> launched)
        {
            _jobName = jobName;
            _printManager = printManager;
            _launched = launched;
        }

        public override void OnPageFinished(global::Android.Webkit.WebView? view, string? url)
        {
            base.OnPageFinished(view, url);
            if (_started || view is null)
                return; // can fire more than once for a data: load
            _started = true;

            try
            {
                var adapter = view.CreatePrintDocumentAdapter(_jobName);
                _printManager.Print(_jobName, adapter, new global::Android.Print.PrintAttributes.Builder().Build()!);
                _launched.TrySetResult(true);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[print] failed to hand document to PrintManager: {ex}");
                _launched.TrySetResult(false);
            }
        }
    }
#elif WINDOWS
    // WebView2's own print UI (Edge's print preview). It prints the current document with
    // @media print applied — the live page, always; `html` is deliberately ignored here (see
    // the class doc comment). HybridWebView's PlatformView is the WinUI WebView2 control;
    // CoreWebView2 is null until it has finished initialising, which it always has by the
    // time a person can tap Print.
    private static Task<bool> PrintOnMainThreadAsync(HybridWebView hybrid, string jobName, string? html)
    {
        if (hybrid.Handler?.PlatformView is not Microsoft.UI.Xaml.Controls.WebView2 webView2
            || webView2.CoreWebView2 is null)
            return Task.FromResult(false);

        webView2.CoreWebView2.ShowPrintUI(Microsoft.Web.WebView2.Core.CoreWebView2PrintDialogKind.Browser);
        return Task.FromResult(true);
    }
#elif IOS || MACCATALYST
    // UIPrintInteractionController. The completion handler fires when the print sheet is
    // dismissed (printed or cancelled); a non-null error means it couldn't print at all.
    private static Task<bool> PrintOnMainThreadAsync(HybridWebView hybrid, string jobName, string? html)
    {
        var info = global::UIKit.UIPrintInfo.PrintInfo;
        info.JobName = jobName;

        var controller = global::UIKit.UIPrintInteractionController.SharedPrintController;

        if (html is not null)
        {
            // Standalone-document path: UIMarkupTextPrintFormatter renders the HTML string
            // itself and paginates it, with no web view (and so none of the app's dark
            // theme, fixed overlay or overflow:hidden shell) involved. Grayscale output is
            // the print-sheet equivalent of the white background: text only, no color ink.
            info.OutputType = global::UIKit.UIPrintInfoOutputType.Grayscale;
            controller.PrintInfo = info;
            controller.PrintFormatter = new global::UIKit.UIMarkupTextPrintFormatter(html)
            {
                // 0.5 inch on every side (points).
                PerPageContentInsets = new global::UIKit.UIEdgeInsets(36, 36, 36, 36),
            };
        }
        else
        {
            // Live-page path. Load-bearing (and unverified) assumption: WebKit's print
            // formatter lays the page out with @media print rules. Known to be unreliable —
            // it's why the html path above exists.
            if (hybrid.Handler?.PlatformView is not global::WebKit.WKWebView webKitWebView)
                return Task.FromResult(false);

            info.OutputType = global::UIKit.UIPrintInfoOutputType.General;
            controller.PrintInfo = info;
            controller.PrintFormatter = webKitWebView.ViewPrintFormatter;
        }

        var done = new TaskCompletionSource<bool>();
        var presented = controller.Present(true, (_, _, error) => done.TrySetResult(error is null));
        if (!presented)
            done.TrySetResult(false);
        return done.Task;
    }
#else
    private static Task<bool> PrintOnMainThreadAsync(HybridWebView hybrid, string jobName, string? html)
        => Task.FromResult(false);
#endif
}
