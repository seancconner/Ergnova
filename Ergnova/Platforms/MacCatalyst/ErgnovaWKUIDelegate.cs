// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using UIKit;
using WebKit;

namespace Ergnova.Platforms.MacCatalyst;

/// <summary>
/// Mac Catalyst copy of Platforms/iOS/ErgnovaWKUIDelegate.cs — same
/// WebKit/UIKit APIs on this platform, just compiled into the
/// net10.0-maccatalyst target instead of net10.0-ios (the SDK's per-
/// platform Platforms/&lt;name&gt; folders don't share a build, so this can't
/// just be a link without extra csproj plumbing; see that file's doc
/// comment for the actual explanation of why this class exists).
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
