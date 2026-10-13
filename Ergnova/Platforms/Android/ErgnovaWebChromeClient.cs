// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using Android.Webkit;
using AAlertDialog = Android.App.AlertDialog;
using AndroidWebView = Android.Webkit.WebView;

namespace Ergnova.Platforms.Android;

/// <summary>
/// MAUI's HybridWebView never sets a WebChromeClient on the underlying
/// Android WebView it wraps. Per WebChromeClient.OnJsConfirm's own docs:
/// "if the WebChromeClient is set to be null, or if WebChromeClient is not
/// set at all, the default dialog will be suppressed and the default value
/// of false will be returned to the JavaScript code immediately." That
/// means every `window.confirm(...)` call in app.js — disconnectTrainer's
/// and disconnectAuxSensor's "Disconnect X?" prompts among them — resolves
/// to false before the person ever sees a dialog, so tapping "Disconnect"
/// on Android silently does nothing: gattDisconnect() never fires because
/// the confirm() gate in front of it never opens.
///
/// Installed via MainPage's Hybrid.HandlerChanged hook (Android side of the
/// same pattern already used there for Windows/WebView2's debug logging).
/// </summary>
public sealed class ErgnovaWebChromeClient : WebChromeClient
{
    public override bool OnJsAlert(AndroidWebView? view, string? url, string? message, JsResult? result)
    {
        if (view?.Context is null)
        {
            result?.Cancel();
            return true;
        }

        new AAlertDialog.Builder(view.Context)
            .SetMessage(message)
            .SetPositiveButton(global::Android.Resource.String.Ok, (_, _) => result?.Confirm())
            .SetCancelable(false)
            .Show();
        return true;
    }

    public override bool OnJsConfirm(AndroidWebView? view, string? url, string? message, JsResult? result)
    {
        if (view?.Context is null)
        {
            result?.Cancel();
            return true;
        }

        new AAlertDialog.Builder(view.Context)
            .SetMessage(message)
            .SetPositiveButton(global::Android.Resource.String.Ok, (_, _) => result?.Confirm())
            .SetNegativeButton(global::Android.Resource.String.Cancel, (_, _) => result?.Cancel())
            .SetCancelable(false)
            .Show();
        return true;
    }
}
