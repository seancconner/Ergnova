// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using UIKit;
using WebKit;

namespace Ergnova.Platforms.iOS;

/// <summary>
/// WKWebView (what HybridWebView wraps on iOS/MacCatalyst) has no built-in
/// UI for window.confirm(). Apple's own WKUIDelegate docs spell out the
/// asymmetry: for runJavaScriptAlertPanel, "if you do not implement this
/// method, the web view will behave as if the user selected the OK
/// button" — but no such fallback is documented for
/// runJavaScriptConfirmPanel. Without a UIDelegate implementing it, the
/// confirm() call's completion handler is simply never invoked, so
/// app.js's "Disconnect X?" prompts (disconnectTrainer/disconnectAuxSensor)
/// would hang rather than resolve to a default value. Same root problem as
/// Android's missing WebChromeClient (see ErgnovaWebChromeClient in
/// Platforms/Android) — different platform API for the same gap.
///
/// Installed via MainPage's Hybrid.HandlerChanged hook, alongside the
/// existing Android/Windows platform hooks there.
///
/// window.prompt() isn't used anywhere in web/src today, so
/// RunJavaScriptTextInputPanel is intentionally left unimplemented — add it
/// here the same way if that changes.
/// </summary>
public sealed class ErgnovaWKUIDelegate : WKUIDelegate
{
    public override void RunJavaScriptAlertPanel(WKWebView webView, string message, WKFrameInfo frame, Action completionHandler)
    {
        var presenter = TopViewController(webView);
        if (presenter is null)
        {
            completionHandler();
            return;
        }

        var alert = UIAlertController.Create(null, message, UIAlertControllerStyle.Alert);
        alert.AddAction(UIAlertAction.Create("OK", UIAlertActionStyle.Default, _ => completionHandler()));
        presenter.PresentViewController(alert, true, null);
    }

    public override void RunJavaScriptConfirmPanel(WKWebView webView, string message, WKFrameInfo frame, Action<bool> completionHandler)
    {
        var presenter = TopViewController(webView);
        if (presenter is null)
        {
            completionHandler(false);
            return;
        }

        var alert = UIAlertController.Create(null, message, UIAlertControllerStyle.Alert);
        alert.AddAction(UIAlertAction.Create("Cancel", UIAlertActionStyle.Cancel, _ => completionHandler(false)));
        alert.AddAction(UIAlertAction.Create("OK", UIAlertActionStyle.Default, _ => completionHandler(true)));
        presenter.PresentViewController(alert, true, null);
    }

    /// <summary>
    /// UIKit throws if you present on a view controller that already has
    /// something presented, so walk to whatever's actually on top rather
    /// than assuming the window's root is free.
    /// </summary>
    private static UIViewController? TopViewController(WKWebView webView)
    {
        // Prefer the window the web view actually lives in: it's scene-correct
        // (UIApplication.KeyWindow is obsolete since iOS 13 / Mac Catalyst 13
        // because it can return a window from the wrong scene). Fall back to
        // the key window of any connected window scene if the web view has
        // been detached.
        var window = webView.Window
            ?? UIApplication.SharedApplication.ConnectedScenes
                .OfType<UIWindowScene>()
                .SelectMany(scene => scene.Windows)
                .FirstOrDefault(w => w.IsKeyWindow);

        var root = window?.RootViewController;
        while (root?.PresentedViewController is { } presented) root = presented;
        return root;
    }
}
