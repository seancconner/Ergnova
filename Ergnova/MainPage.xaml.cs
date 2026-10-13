// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using Ergnova.Services;
using Microsoft.Maui.ApplicationModel;
using Shiny.BluetoothLE;
#if WINDOWS
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
#endif
#if ANDROID
using Android.App;
using Ergnova.Platforms.Android;
#endif
#if IOS
using Ergnova.Platforms.iOS;
#endif
#if MACCATALYST
using Ergnova.Platforms.MacCatalyst;
#endif

namespace Ergnova
{
    public partial class MainPage : ContentPage
    {
        private readonly NativeBridgeMethods _bridgeMethods;

        /// <summary>
        /// IBleManager is resolved via constructor DI — MAUI Shell resolves
        /// page types referenced from a ContentTemplate (see AppShell.xaml's
        /// `ContentTemplate="{DataTemplate local:MainPage}"`) through the
        /// app's IServiceProvider, so any constructor parameter that's been
        /// registered (Shiny's builder.UseShiny() + AddBluetoothLE() in
        /// MauiProgram.cs registers IBleManager) gets injected automatically
        /// here — no explicit `builder.Services.AddTransient&lt;MainPage&gt;()`
        /// needed. If DI resolution doesn't fire for some reason (e.g. an
        /// older MAUI/Shiny combination), the documented fallback is
        /// `Shiny.Hosting.Host.GetService&lt;IBleManager&gt;()`, called directly
        /// in place of the constructor parameter — see
        /// https://shinylib.net's getting-started sample, which uses exactly
        /// that pattern from inside a page.
        /// </summary>
        public MainPage(IBleManager bleManager, IBackgroundSessionService backgroundSession, IPrintService printService)
        {
            InitializeComponent();

            // NativeBridgeMethods' push-event channel (BLE notify/disconnect)
            // goes back to JS via HybridWebView.SendRawMessage — see that
            // class's DispatchBle() and native-shell-bridge.js's
            // 'HybridWebViewMessageReceived' listener on the other end.
            // MainThread.BeginInvokeOnMainThread here is load-bearing, not
            // decorative: DispatchBle's callers (BleStartNotifications'
            // NotifyCharacteristic subscription, the connection-state
            // watcher in BleGattConnect, BleWatchAdvertisements' scan
            // subscription) all fire synchronously on whatever thread the
            // native BLE stack calls back on — a Binder thread on Android,
            // not the UI thread. WebView (and therefore HybridWebView)
            // requires every call to originate on the main thread; calling
            // Hybrid.SendRawMessage directly from a notify callback throws
            // "A WebView method was called on thread ..." from inside
            // Android's own GATT callback dispatch, which in turn appears to
            // get the OS to drop the characteristic's notification
            // subscription — i.e. without this hop, a heart-rate strap's
            // very first sample kills the stream instead of just the first
            // relay attempt failing loudly.
            // The BleDevicePicker is what BleRequestDevice shows a real
            // chooser dialog through — see its own doc comment for why it's
            // constructed here (this is the one place in the app that
            // already has a live Page to show a modal on) rather than
            // resolved via DI like IBleManager above.
            _bridgeMethods = new NativeBridgeMethods(
                bleManager,
                message => MainThread.BeginInvokeOnMainThread(() => Hybrid.SendRawMessage(message)),
                new BleDevicePicker(this),
                backgroundSession,
                printService,
                Hybrid);

            // Registers _bridgeMethods as the target object for every
            // `window.HybridWebView.InvokeDotNet('MethodName', [...])` call
            // native-shell-bridge.js makes — method names/signatures must
            // match exactly (see that file's header comment for the full
            // contract).
            Hybrid.SetInvokeJavaScriptTarget(_bridgeMethods);

            #if WINDOWS
                // Debugging aid for the wwwroot-packaging issue — logs every request
                // the HybridWebView virtual host (https://0.0.0.1/) serves, with its
                // status code, to the Debug Output window. Safe to leave in past that:
                // it's Windows-only and just observes traffic, doesn't alter it.
                Hybrid.HandlerChanged += OnHybridHandlerChanged;
            #endif
            #if ANDROID
                // Without this, window.confirm()/alert() in app.js are silently
                // suppressed on Android — see ErgnovaWebChromeClient's own doc
                // comment for why "Disconnect X?" prompts were doing nothing.
                Hybrid.HandlerChanged += OnHybridHandlerChangedAndroid;
            #endif
            #if IOS || MACCATALYST
                // Same problem as the Android hook above, WKWebView's flavor of
                // it — see ErgnovaWKUIDelegate's doc comment. Windows needs no
                // equivalent: WebView2's AreDefaultScriptDialogsEnabled is true
                // by default, so alert()/confirm() already show a real dialog
                // there without any code here.
                Hybrid.HandlerChanged += OnHybridHandlerChangedAppleWebKit;
            #endif
                    }

#if IOS || MACCATALYST
            private void OnHybridHandlerChangedAppleWebKit(object? sender, EventArgs e)
            {
                if (Hybrid.Handler?.PlatformView is not WebKit.WKWebView webKitWebView) return;
                webKitWebView.UIDelegate = new ErgnovaWKUIDelegate();
            }
#endif

#if ANDROID
            private void OnHybridHandlerChangedAndroid(object? sender, EventArgs e)
            {
                if (Hybrid.Handler?.PlatformView is not global::Android.Webkit.WebView androidWebView) return;
                androidWebView.SetWebChromeClient(new ErgnovaWebChromeClient());
            }
#endif

#if WINDOWS
            private void OnHybridHandlerChanged(object? sender, EventArgs e)
            {
            if (Hybrid.Handler?.PlatformView is not Microsoft.UI.Xaml.Controls.WebView2 webView2) return;

            webView2.CoreWebView2Initialized += (_, __) =>
            {
                var core = webView2.CoreWebView2;
                core.AddWebResourceRequestedFilter("*", Microsoft.Web.WebView2.Core.CoreWebView2WebResourceContext.All);
                core.WebResourceResponseReceived += (_, args) =>
                {
                    var contentType = args.Response.Headers
                        .FirstOrDefault(h => string.Equals(h.Key, "Content-Type", StringComparison.OrdinalIgnoreCase))
                        .Value ?? "(none)";
                    System.Diagnostics.Debug.WriteLine(
                    $"[wwwroot] {args.Response.StatusCode} {contentType} — {args.Request.Uri}");
                };
            };
        }
#endif

        /// <summary>
        /// JS -> C# "raw" messages (as opposed to the structured
        /// InvokeDotNet method calls NativeBridgeMethods handles) would
        /// arrive here, via `window.HybridWebView.SendRawMessage(...)` on
        /// the JS side. Nothing in native-shell-bridge.js currently sends
        /// one — every JS -> C# call in this app goes through InvokeDotNet
        /// instead, and the only raw-message traffic today is C# -> JS
        /// (NativeBridgeMethods.DispatchBle). Wired up per checklist §4
        /// anyway, as a documented no-op, so a future JS-initiated push
        /// (e.g. a JS-side error-reporting hook) has somewhere to plug in
        /// without touching the XAML again.
        /// </summary>
        private void OnRawMessageReceived(object? sender, HybridWebViewRawMessageReceivedEventArgs e)
        {
            // Intentionally empty — see doc comment above.
        }

        /// <summary>
        /// Checklist §9: map the Android hardware back button into the web
        /// app's own navigation (close a panel, go back a tab) instead of
        /// letting it exit the app mid-session. `OnBackButtonPressed()` is
        /// the standard cross-platform MAUI hook for this, but there have
        /// been reports of it not firing reliably from *inside* an embedded
        /// WebView-hosting page on some MAUI versions (the same class of
        /// issue documented for BlazorWebView in dotnet/maui#9804) — if
        /// that turns out to be true here too, move this same
        /// EvaluateJavaScriptAsync call into
        /// Platforms/Android/MainActivity.cs's OnBackPressedDispatcher
        /// callback instead (already stubbed there with a VERIFY note) and
        /// delete this override. Worth confirming on a real Android device
        /// early — this is exactly the kind of thing that's easy to miss
        /// until someone actually presses back mid-workout.
        /// </summary>
        protected override bool OnBackButtonPressed()
        {
            _ = HandleBackButtonAsync();
            // Always report "handled" — HandleBackButtonAsync decides
            // asynchronously whether the web app had something to close,
            // and falls back to minimizing (not killing) the app itself
            // when it didn't. Returning false here would let MAUI/Android's
            // default action (typically finishing the Activity) race ahead
            // of that async decision.
            return true;
        }

        private async Task HandleBackButtonAsync()
        {
            try
            {
                // web/src/app.js exposes window.__ergnovaBackButton(): closes
                // the top-most open panel/menu and returns true, or switches
                // to the Overview tab and returns true, or returns false if
                // already at the app's "home" state with nothing left to
                // back out of. See that file for the exact logic.
                var result = await Hybrid.EvaluateJavaScriptAsync(
                    "(window.__ergnovaBackButton ? window.__ergnovaBackButton() : false)");

                if (string.Equals(result, "true", StringComparison.OrdinalIgnoreCase))
                {
                    return; // the web app closed something — nothing more to do
                }
            }
            catch
            {
                // If the JS call fails for any reason, don't strand the
                // person unable to leave the app — fall through to the
                // platform-default handling below.
            }

#if ANDROID
            // Nothing left for the web app to close — mirror normal Android
            // back-button etiquette (minimize to background, don't kill the
            // process) rather than exiting outright, which would drop an
            // active BLE session. MoveTaskToBack is the standard way to do
            // this from an Activity; Platform.CurrentActivity is the MAUI
            // Essentials accessor for "whichever Activity is current".
            // VERIFY: confirm Platform.CurrentActivity is non-null at this
            // point on every Android version this app targets (API 23+, per
            // Ergnova.csproj's SupportedOSPlatformVersion) — it's populated
            // by MAUI's own Activity lifecycle hooks and should be, but
            // wasn't confirmed against a live device/emulator here.
            (Platform.CurrentActivity as Activity)?.MoveTaskToBack(true);
#endif
            // iOS/Mac Catalyst/Windows: OnBackButtonPressed has no real
            // hardware-back-button equivalent to suppress on these
            // platforms (see checklist §9's own framing — this whole
            // override is Android-centric), so there's nothing platform-
            // specific to fall back to here.
        }
    }
}
