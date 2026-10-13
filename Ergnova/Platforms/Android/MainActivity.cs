// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using Android.App;
using Android.Content.PM;
using Android.OS;

namespace Ergnova
{
    [Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop, ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode | ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
    public class MainActivity : MauiAppCompatActivity
    {
        // Checklist §9 / MainPage.xaml.cs's OnBackButtonPressed doc comment:
        // MainPage.OnBackButtonPressed() is the primary hook for routing the
        // hardware back button into the web app's own navigation. It's
        // expected to fire reliably from a HybridWebView-hosting ContentPage
        // on current MAUI, but BlazorWebView has a documented history of the
        // equivalent override NOT firing reliably from inside an embedded
        // WebView on some MAUI versions (dotnet/maui#9804) — HybridWebView
        // wasn't confirmed clean of the same class of issue in the
        // environment that produced this file.
        //
        // VERIFY on a real Android device early (checklist §11): press back
        // while a panel/menu is open in the web app. If MainPage's override
        // already closes it correctly, nothing further is needed and this
        // comment can be deleted. If back instead falls through to the
        // default Activity behavior (finishing the Activity, dropping a live
        // BLE session), uncomment the block below — it re-implements the
        // same "ask the web app first, minimize instead of finish if it had
        // nothing to close" logic at the Activity level via
        // OnBackPressedDispatcher, which callback-based back handling is
        // guaranteed to intercept regardless of what's happening inside the
        // hosted WebView. Only one of the two (MainPage's override, or this)
        // should be active at a time — leaving both in would double-handle
        // the same press.
        //
        // protected override void OnCreate(Bundle? savedInstanceState)
        // {
        //     base.OnCreate(savedInstanceState);
        //     OnBackPressedDispatcher.AddCallback(this, new AndroidX.Activity.OnBackPressedCallback(true)
        //     {
        //         HandleOnBackPressedImpl = () =>
        //         {
        //             // Mirror MainPage.HandleBackButtonAsync()'s logic here if
        //             // that override turns out not to fire reliably — see the
        //             // comment above.
        //         }
        //     });
        // }
    }
}
