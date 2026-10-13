// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

namespace Ergnova.Services;

/// <summary>
/// Shows a real device-chooser UI and resolves once the user taps a device
/// or cancels. Exists as a seam so <see cref="NativeBridgeMethods"/> (deliberately
/// UI-framework-agnostic — see its own header comment) doesn't need a direct
/// dependency on any MAUI Page/Popup type; <see cref="BleDevicePicker"/> is the
/// concrete implementation that actually shows one, constructed once in
/// MainPage's constructor (which has a Page to show it on) and handed down.
/// </summary>
public interface IBleDevicePicker
{
    /// <summary>
    /// Displays the picker and starts forwarding <paramref name="foundDevices"/>
    /// into it as they arrive from whatever scan the caller is running. Resolves
    /// with the selected device's id, or <c>null</c> if the user dismissed/cancelled
    /// the picker (or <paramref name="cancellationToken"/> fired first).
    ///
    /// The caller (BleRequestDevice) owns the underlying scan subscription that
    /// feeds <paramref name="foundDevices"/> — this method and its UI never start
    /// or stop scanning themselves, only display what they're given.
    /// </summary>
    Task<string?> PickDeviceAsync(IObservable<BleDeviceInfo> foundDevices, CancellationToken cancellationToken);
}
