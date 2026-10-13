// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

namespace Ergnova.Services;

/// <summary>
/// Registered for every target that isn't Android (see MauiProgram.cs).
/// Real background execution with a persistent, OS-guaranteed notification
/// is specifically an Android mechanism:
///
///   - iOS/Mac Catalyst background execution is governed by a fixed set of
///     declared UIBackgroundModes (audio, location, bluetooth-central,
///     etc.) plus a short (roughly 30s, not user-configurable) expiring
///     grace period via UIApplication.BeginBackgroundTask for anything
///     else — there's no "show a persistent tray notification and keep
///     running indefinitely" mode a fitness app can opt into the way
///     Android's foreground-service contract provides. Building a
///     correct, honest version of this for iOS (background audio session
///     trick, silent-audio keep-alive, etc.) is a materially different
///     and riskier feature than what was asked for here, and not
///     something to fake with a service that quietly stops working after
///     ~30 seconds while still claiming Supported = true.
///   - Windows and Mac Catalyst desktop apps aren't backgrounded/suspended
///     by the OS the way a phone app is in the first place (closing the
///     window ends the process; minimizing does not stop JS execution),
///     so there's nothing this bridge needs to do differently from the
///     plain in-page pause+snapshot-on-hide path background-session.js
///     already has.
///
/// background-session.js's own header comment already documents this
/// exact split ("native (MAUI) shell only... Android answers this with a
/// foreground service... Everywhere else... no bridge (or the bridge
/// reports supported: false)") — this class is what makes that true for
/// iOS/Mac Catalyst/Windows specifically, as opposed to no bridge being
/// registered at all.
/// </summary>
public sealed class UnsupportedBackgroundSessionService : IBackgroundSessionService
{
    public Task<BackgroundInfo> GetInfoAsync() => Task.FromResult(Info());

    public Task<BackgroundInfo> EnsurePermissionsAsync() => Task.FromResult(Info());

    public Task<BackgroundInfo> StartAsync(BackgroundSnapshot snapshot) => Task.FromResult(Info());

    public Task UpdateAsync(BackgroundSnapshot snapshot) => Task.CompletedTask;

    public Task StopAsync() => Task.CompletedTask;

    public Task OpenNotificationSettingsAsync() => Task.CompletedTask;

    /// <summary>Never shows a notification, so there is nothing to tap.</summary>
    public void SetActionHandler(Action<string>? handler) { }

    private static BackgroundInfo Info() => new()
    {
        Supported = false, // see this class's header comment for why, per platform
        Platform = OperatingSystem.IsIOS() ? "ios" : OperatingSystem.IsMacCatalyst() ? "maccatalyst" : OperatingSystem.IsWindows() ? "windows" : "unknown",
        NotificationsAllowed = true, // never actually shows one, so never the reason a rider's workout would stop
        Running = false,
    };
}
