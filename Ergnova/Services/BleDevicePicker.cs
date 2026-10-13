// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using Ergnova.Controls;

namespace Ergnova.Services;

/// <summary>
/// Real, cross-platform implementation of <see cref="IBleDevicePicker"/> —
/// pushes <see cref="BleDevicePickerPage"/> as a modal page on the host
/// page's navigation stack via <c>Navigation.PushModalAsync</c>/<c>PopModalAsync</c>.
///
/// Deliberately a plain MAUI modal ContentPage rather than a
/// CommunityToolkit.Maui Popup: PushModalAsync/PopModalAsync are core MAUI
/// APIs whose shape hasn't changed across MAUI versions, so this doesn't
/// depend on guessing CommunityToolkit.Maui's Popup surface (which *has*
/// changed shape across major versions) against a package this environment
/// can't restore/compile against to verify (see NativeBridgeMethods.cs's own
/// header comment for the same limitation elsewhere in this bridge). If a
/// lighter bottom-sheet look is wanted later, this class's body is the only
/// thing that needs to change — IBleDevicePicker's contract stays the same,
/// so NativeBridgeMethods needs no changes to switch.
///
/// Constructed once in MainPage's constructor (the one place in this app
/// that already has a live Page to show things on) and handed into
/// NativeBridgeMethods alongside the other bridge dependencies.
/// </summary>
public sealed class BleDevicePicker : IBleDevicePicker
{
    private readonly Page _hostPage;

    public BleDevicePicker(Page hostPage)
    {
        _hostPage = hostPage;
    }

    public Task<string?> PickDeviceAsync(IObservable<BleDeviceInfo> foundDevices, CancellationToken cancellationToken)
    {
        // MainThread hop: BleRequestDevice calls this from whatever thread
        // HybridWebView's InvokeDotNet dispatch lands on, which isn't
        // guaranteed to be the UI thread — every MAUI navigation call needs
        // to happen on it. VERIFY: InvokeOnMainThreadAsync<T>(Func<Task<T>>)
        // is the overload that both hops threads AND lets us await the
        // picker's result before returning — if the resolved MAUI version
        // doesn't expose it, fall back to InvokeOnMainThreadAsync(Func<Task>)
        // wrapping a captured TaskCompletionSource<string?> instead.
        return MainThread.InvokeOnMainThreadAsync(async () =>
        {
            var page = new BleDevicePickerPage(foundDevices);
            return await page.WaitForSelectionAsync(_hostPage, cancellationToken);
        });
    }
}
