// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// A project-wide `using Shiny;` also brings in Shiny.Permissions, which makes
// the bare name `Permissions` ambiguous (CS0104). The alias takes precedence
// over both imported namespaces, so it resolves to MAUI's.
using Permissions = Microsoft.Maui.ApplicationModel.Permissions;

namespace Ergnova.Services;

/// <summary>
/// Microsoft.Maui.ApplicationModel.Permissions ships built-in wrappers for
/// the common ones (Camera, LocationWhenInUse, Bluetooth, ...); this one
/// follows the documented "Custom Permissions" pattern
/// (learn.microsoft.com/dotnet/maui/platform-integration/appmodel/permissions#custom-permissions)
/// so the runtime prompt for POST_NOTIFICATIONS is under this app's control:
/// a single class deriving from Permissions.BasePlatformPermission, with the
/// Android-specific RequiredPermissions override behind #if ANDROID. On
/// every other platform the base class's own default (an empty permission
/// list, i.e. "nothing to request, always granted") applies, which is
/// correct here since AndroidBackgroundSessionService is the only caller
/// and it's never constructed on a non-Android target (see MauiProgram.cs).
///
/// POST_NOTIFICATIONS only exists as a runtime permission on Android 13
/// (API 33)+. Below that the string isn't a permission the OS knows, so
/// asking about it would report a meaningless "denied" — the override
/// returns an empty list there (= always granted) instead of relying on
/// the platform to answer sensibly for an unknown permission name. The
/// caller (AndroidBackgroundSessionService.EnsurePermissionsAsync) also
/// skips the request entirely below API 33.
///
/// VERIFY: Manifest.Permission.PostNotifications is the expected binding
/// name for android.permission.POST_NOTIFICATIONS in a recent Android SDK
/// binding; not confirmed against a live build. If it doesn't resolve, the
/// literal string "android.permission.POST_NOTIFICATIONS" works identically.
/// </summary>
public class PostNotificationsPermission : Permissions.BasePlatformPermission
{
#if ANDROID
    public override (string androidPermission, bool isRuntime)[] RequiredPermissions =>
        OperatingSystem.IsAndroidVersionAtLeast(33)
            ? new[] { (global::Android.Manifest.Permission.PostNotifications, true) }
            : Array.Empty<(string androidPermission, bool isRuntime)>();
#endif
}