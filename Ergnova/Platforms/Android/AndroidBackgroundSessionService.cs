// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using Android.Content;
using Android.Provider;
using AndroidX.Core.App;
using AndroidX.Core.Content;
using Ergnova.Services;
using Microsoft.Maui.ApplicationModel;
// A project-wide `using Shiny;` also brings in Shiny.Permissions (CS0104 on the
// bare name below) — the alias wins over both imported namespaces.
using Permissions = Microsoft.Maui.ApplicationModel.Permissions;

namespace Ergnova.Platforms.Android;

/// <summary>
/// Android's IBackgroundSessionService (see that interface's doc comment
/// and background-session.js's header comment for the full contract).
/// Owns the "does the OS actually think a session is running" bookkeeping
/// and talks to ErgnovaSessionService to start/update/stop it — see that
/// class's own header comment for why updates and stops go through a direct
/// call on ErgnovaSessionService.Instance rather than another Intent round
/// trip.
///
/// Registered as a singleton in MauiProgram.cs (#if ANDROID) and resolved
/// via DI into MainPage.xaml.cs alongside IBleManager, then handed to
/// NativeBridgeMethods.
/// </summary>
public sealed class AndroidBackgroundSessionService : IBackgroundSessionService
{
    /// <summary>Set by StartAsync just before firing the start Intent, completed
    /// by ErgnovaSessionService.OnStartCommand once StartForeground() has
    /// actually run (successfully or not) — see StartAsync's own comment on
    /// why a plain "the Intent was accepted" isn't itself enough to answer
    /// JS's start() promise with `running: true`. Static, matching
    /// ErgnovaSessionService.Instance's own reasoning: there's at most one
    /// pending start at a time by construction (background-session.js never
    /// calls start() again while one is already in flight — see its own
    /// _starting guard).</summary>
    internal static TaskCompletionSource<bool>? PendingStartSignal;

    private static readonly TimeSpan StartConfirmationTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Who to tell when the rider taps Pause / Play on the
    /// notification. Static for the same reason PendingStartSignal is: the
    /// tap arrives in ErgnovaSessionActionReceiver, a component Android
    /// instantiates itself with no route back to this DI singleton except
    /// through static state. Volatile because the receiver and the page's
    /// constructor can be on different threads.</summary>
    private static volatile Action<string>? s_actionHandler;

    public void SetActionHandler(Action<string>? handler) => s_actionHandler = handler;

    /// <summary>Called by ErgnovaSessionActionReceiver for a notification
    /// button tap. Never throws — an exception escaping a BroadcastReceiver
    /// takes the whole process down, and a dropped tap is a far smaller
    /// problem than that. With no handler registered (the page hasn't been
    /// built yet, or is mid-recreate) the tap is dropped.</summary>
    internal static void RaiseAction(string action)
    {
        var handler = s_actionHandler;
        if (handler is null)
        {
            System.Diagnostics.Debug.WriteLine($"[AndroidBackgroundSessionService] '{action}' tapped with no handler registered — dropped");
            return;
        }
        try
        {
            handler(action);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[AndroidBackgroundSessionService] action handler failed: {ex}");
        }
    }

    public Task<BackgroundInfo> GetInfoAsync() => Task.FromResult(BuildInfo());

    /// <summary>Prompts for POST_NOTIFICATIONS (Android 13+ only — the
    /// concept doesn't exist earlier, so there is nothing to ask and the
    /// call just reports current state). If the rider previously chose
    /// "Don't allow" twice, Android stops showing the dialog and the request
    /// returns immediately; the JS side then offers "Open settings" via
    /// OpenNotificationSettingsAsync as the only way back.</summary>
    public async Task<BackgroundInfo> EnsurePermissionsAsync()
    {
        if (OperatingSystem.IsAndroidVersionAtLeast(33))
        {
            try
            {
                // Permissions.RequestAsync must run on the main thread, and
                // the bridge doesn't promise which thread it calls in on.
                await MainThread.InvokeOnMainThreadAsync(async () =>
                {
                    var status = await Permissions.CheckStatusAsync<PostNotificationsPermission>();
                    if (status != PermissionStatus.Granted)
                        await Permissions.RequestAsync<PostNotificationsPermission>();
                });
            }
            catch (Exception ex)
            {
                // RequestAsync can throw (e.g. no foreground Activity) — fall
                // through and report whatever the current state actually is
                // rather than losing the session start over a prompt failure.
                System.Diagnostics.Debug.WriteLine($"[AndroidBackgroundSessionService] permission request failed: {ex}");
            }
        }
        return BuildInfo();
    }

    public async Task<BackgroundInfo> StartAsync(BackgroundSnapshot snapshot)
    {
        if (ErgnovaSessionService.Instance is not null)
        {
            // Already running (e.g. sync() fired twice before the first
            // start's promise resolved, or a new page load re-attaching to a
            // service that outlived the old one) — just push the latest
            // content and report current state, rather than racing a second
            // StartForegroundService() against this one.
            ErgnovaSessionService.Instance.ApplySnapshot(snapshot);
            return BuildInfo();
        }

        var context = global::Android.App.Application.Context;
        var tcs = new TaskCompletionSource<bool>();
        PendingStartSignal = tcs;
        try
        {
            var intent = ErgnovaSessionService.BuildStartIntent(context, snapshot);
            // ContextCompat.StartForegroundService (rather than plain
            // StartService) is required on API 26+: a service that's going to
            // call StartForeground() soon after starting must be launched
            // this way. ContextCompat falls back to plain StartService on
            // older APIs where the distinction doesn't exist.
            ContextCompat.StartForegroundService(context, intent);

            // StartForegroundService() returning doesn't mean StartForeground()
            // has actually run yet — OnStartCommand is dispatched
            // asynchronously by the OS. background-session.js's start()
            // contract expects a definite running: true/false answer, so wait
            // for ErgnovaSessionService to confirm it, with a timeout as a
            // safety net so a stall still resolves the JS promise.
            using var cts = new CancellationTokenSource(StartConfirmationTimeout);
            var timeoutTask = Task.Delay(Timeout.Infinite, cts.Token);
            var completed = await Task.WhenAny(tcs.Task, timeoutTask);
            if (completed != tcs.Task)
            {
                return BuildInfo(running: false, error: "background service did not confirm startup in time");
            }
            var started = await tcs.Task;
            return BuildInfo(running: started, error: started ? null : "the native background service failed to start");
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[AndroidBackgroundSessionService] start failed: {ex}");
            return BuildInfo(running: false, error: ex.Message);
        }
        finally
        {
            if (ReferenceEquals(PendingStartSignal, tcs)) PendingStartSignal = null;
        }
    }

    public Task UpdateAsync(BackgroundSnapshot snapshot)
    {
        ErgnovaSessionService.Instance?.ApplySnapshot(snapshot);
        return Task.CompletedTask;
    }

    /// <summary>A no-op when nothing is running. Deliberately does not send a
    /// "stop" Intent — see ErgnovaSessionService.RequestStop for why that
    /// can crash the app when the service isn't already up.</summary>
    public Task StopAsync()
    {
        ErgnovaSessionService.RequestStop();
        return Task.CompletedTask;
    }

    public Task OpenNotificationSettingsAsync()
    {
        var context = global::Android.App.Application.Context;
        var intent = new Intent();
        if (OperatingSystem.IsAndroidVersionAtLeast(26))
        {
            intent.SetAction(Settings.ActionAppNotificationSettings);
            intent.PutExtra(Settings.ExtraAppPackage, context.PackageName);
        }
        else
        {
            intent.SetAction(Settings.ActionApplicationDetailsSettings);
            intent.SetData(global::Android.Net.Uri.Parse("package:" + context.PackageName));
        }
        intent.AddFlags(ActivityFlags.NewTask); // starting an Activity from outside an Activity context requires this
        context.StartActivity(intent);
        return Task.CompletedTask;
    }

    private static BackgroundInfo BuildInfo(bool? running = null, string? error = null) => new()
    {
        Supported = true,
        Platform = "android",
        NotificationsAllowed = AreNotificationsEnabled(),
        Running = running ?? ErgnovaSessionService.Instance is not null,
        Error = error,
    };

    private static bool AreNotificationsEnabled()
    {
        var context = global::Android.App.Application.Context;
        // The OS-level "notifications for this app" switch — false until
        // POST_NOTIFICATIONS is granted on Android 13+, and false if the rider
        // turned Ergnova's notifications off in system Settings on any version.
        if (NotificationManagerCompat.From(context)?.AreNotificationsEnabled() == false) return false;

        // The rider can also silence just this one channel ("Workout in
        // progress") while leaving the app's other notifications on — the
        // app-level check above still says yes in that case, but nothing
        // would ever show in the tray.
        if (OperatingSystem.IsAndroidVersionAtLeast(26))
        {
            var manager = context.GetSystemService(Context.NotificationService) as global::Android.App.NotificationManager;
            var channel = manager?.GetNotificationChannel(ErgnovaSessionService.ChannelId);
            if (channel is not null && channel.Importance == global::Android.App.NotificationImportance.None) return false;
        }
        return true;
    }
}