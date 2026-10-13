// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using Microsoft.Extensions.Logging;
using CommunityToolkit.Maui;
using Shiny;

namespace Ergnova
{
    public static class MauiProgram
    {
        public static MauiApp CreateMauiApp()
        {
            var builder = MauiApp.CreateBuilder();
            builder
                .UseMauiApp<App>()
                // Wires Shiny's lifecycle through MAUI (checklist §5) — required
                // before any Shiny module (BluetoothLE included) will resolve via
                // DI. Must come before .Services.AddBluetoothLE() below, and
                // before builder.Build() is called at the bottom of this method.
                // See https://shinylib.net/client/hosting/maui/.
                .UseShiny()
                // File save/export bridge (checklist §7) — registers
                // CommunityToolkit.Maui's services (FileSaver.Default, used by
                // Services/NativeBridgeMethods.cs's FileSaveBlob).
                .UseMauiCommunityToolkit()
                .ConfigureFonts(fonts =>
                {
                    fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                    fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
                });

            // BLE bridge (checklist §5). VERIFY: AddBluetoothLE() is shown here
            // with no generic delegate argument, since this app has no
            // background-scanning delegate to register — every BLE operation
            // here is initiated in the foreground (Services/NativeBridgeMethods.cs
            // is called on demand from JS, never via a background scan). Shiny's
            // own sample code (shinylib.net) shows the generic overload
            // `AddBluetoothLE<TDelegate>()` for apps that DO need one; if the
            // resolved Shiny version doesn't expose a parameterless overload,
            // switch to that form with a no-op delegate instead. Not verified
            // against a live SDK in the environment that produced this file.
            builder.Services.AddBluetoothLE();

            // Background keep-alive + ongoing notification (see
            // Services/IBackgroundSessionService.cs). MainPage takes this by
            // constructor injection and hands it to NativeBridgeMethods, so it
            // MUST be registered for every target or Shell fails to build
            // MainPage at startup. Only Android has a real implementation;
            // everything else gets the "unsupported" one, which background-
            // session.js treats the same as having no bridge at all. Names are
            // fully qualified because `using Shiny;` above (and a project-wide
            // one) can otherwise make short names ambiguous.
#if ANDROID
            builder.Services.AddSingleton<global::Ergnova.Services.IBackgroundSessionService, global::Ergnova.Platforms.Android.AndroidBackgroundSessionService>();
#else
            builder.Services.AddSingleton<global::Ergnova.Services.IBackgroundSessionService, global::Ergnova.Services.UnsupportedBackgroundSessionService>();
#endif

            // Native print (window.__ergnovaNativePrint — see Services/IPrintService.cs).
            // Same reasoning as IBackgroundSessionService above: MainPage takes it by
            // constructor injection, so it must be registered for every target. One
            // implementation branches per platform internally, so no #if here.
            builder.Services.AddSingleton<global::Ergnova.Services.IPrintService, global::Ergnova.Services.PrintService>();

#if DEBUG
    		builder.Logging.AddDebug();
#endif

            return builder.Build();
        }
    }
}