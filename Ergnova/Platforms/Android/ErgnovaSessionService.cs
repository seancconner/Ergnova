// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.Content.Res;
using Android.OS;
using AndroidX.Core.App;
using AndroidX.Core.Graphics.Drawable;
using Ergnova.Services;
using System.Text.Json;

namespace Ergnova.Platforms.Android;

/// <summary>
/// The Android half of window.__ergnovaNativeBackground (see
/// Services/IBackgroundSessionService.cs and web/src/platform/
/// background-session.js's header comment for the full contract). This is
/// the actual "foreground service + ongoing notification" that Android
/// requires of any app that wants to keep doing meaningful work — BLE reads,
/// the recording clock — once the screen locks or the rider switches to
/// another app.
///
/// What it does, in order of importance:
///   1. Holds the OS-granted foreground slot via StartForeground(), which is
///      what keeps the process (and therefore the WebView and every live
///      BLE connection) from being frozen or killed in the background.
///   2. Owns the ongoing tray notification that slot requires, which shows the
///      workout at three levels of detail (the layouts and icon lookups live in
///      BackgroundNotificationViews; this class only decides what goes where):
///        * status bar — ONE icon that rotates through the live metrics
///          (power, heart rate, cadence, ...) every IconRotationMs on a native
///          timer, so it keeps turning while the page's JS is throttled. Each
///          one is composed on the fly (BackgroundNotificationViews.
///          BuildStatusIcon) as the metric's glyph plus its current value, so
///          the number itself — not just the glyph — shows up there too.
///          Paused shows the pause glyph; waiting-to-start / no readings yet
///          shows the stopwatch; either falls back to the plain glyph if a
///          composite icon ever fails to build.
///        * shade, collapsed — title plus up to three "icon 215 W" chips, in a
///          fixed order so the numbers don't jump as the status icon rotates.
///        * shade, expanded — title, context lines (scripted step / target,
///          strength exercise / rest), a grid of every live metric with its
///          icon, then a totals row (calories, distance).
///      Both shade layouts sit inside the system's own header, which carries a
///      SYSTEM-RENDERED elapsed timer (Notification chronometer). The
///      chronometer is drawn by SystemUI, not by us, so it keeps ticking
///      smoothly even if the page's JS timers are throttled while hidden — the
///      rider can always tell the workout clock is alive even when a metric
///      briefly lags. If the custom layouts ever fail to inflate, the same
///      snapshot's plain-text fields render the notification instead (see
///      CustomViewsUsable), so a layout bug degrades the tray, never the service.
///   3. Holds a PARTIAL_WAKE_LOCK for as long as the service runs, so the CPU
///      keeps servicing BLE notifications and the recording tick with the
///      screen off. (The screen itself is a separate concern — see the
///      WakeLock* bridge methods.)
///   4. Puts a Pause / Play button on that notification, so a workout can be
///      paused and resumed from the tray or lock screen without opening the
///      app. The button follows the snapshot's status: Pause while running,
///      Play while paused, "Start now" while armed and waiting for the first
///      pedal stroke. A tap fires a broadcast at ErgnovaSessionActionReceiver,
///      which hands it to AndroidBackgroundSessionService.RaiseAction and from
///      there up to JS. The button is deliberately dumb: nothing here flips
///      it or pauses anything itself. The workout lives in the page, so the
///      page pauses, and the next snapshot it sends is what changes the
///      button — the notification can never show a state the workout isn't in.
///      (Like any notification action, the button sits in the expanded view.)
///
/// Driven entirely by AndroidBackgroundSessionService (that class owns the
/// Intent-building and the "did it actually start" bookkeeping). It is NOT
/// a bound service (OnBind returns null): everything crosses via Intent
/// extras on the way in (OnStartCommand) and via the static Instance
/// reference afterwards (ApplySnapshot / RequestStop, called directly), which
/// is simpler than a Binder for a single-process, single-consumer
/// relationship like this one.
///
/// Registered via the [Service] attribute rather than a manual manifest
/// entry — same convention MainActivity.cs's [Activity] attribute uses.
/// ForegroundServiceType.ConnectedDevice matches the
/// FOREGROUND_SERVICE_CONNECTED_DEVICE manifest permission: this app's
/// whole reason for running in the background is maintaining live BLE
/// connections to a trainer/HR strap/etc. On API 34+ that type also needs
/// one qualifying permission — AndroidManifest.xml declares
/// CHANGE_NETWORK_STATE (install-time granted) for exactly that, so the
/// service can start even in a workout with no Bluetooth permission granted
/// yet (strength session, no sensors).
///
/// VERIFY: not compiled in the environment that produced this file (no
/// Android workload available) — API names below are from the .NET for
/// Android / AndroidX bindings as documented.
/// </summary>
// Fully qualified because a project-wide `using Shiny;` (this file has none of
// its own) puts Shiny.ServiceAttribute in scope next to Android.App.ServiceAttribute,
// which is CS0104. `global::` is required rather than plain `Android.App.Service`:
// inside this file's Ergnova.Platforms.Android namespace, a bare `Android`
// resolves to that namespace, not the Android SDK's.
[global::Android.App.Service(Exported = false, ForegroundServiceType = ForegroundService.TypeConnectedDevice)]
public sealed class ErgnovaSessionService : Service
{
    public const string ActionStart = "com.ergnova.app.action.START_BACKGROUND_SESSION";

    /// <summary>Intent actions on the notification button's PendingIntents.
    /// They're broadcast to ErgnovaSessionActionReceiver (never to this
    /// service — see BuildActionIntent for why), which is the only reader.</summary>
    public const string ActionPause = "com.ergnova.app.action.PAUSE_WORKOUT";
    public const string ActionPlay = "com.ergnova.app.action.PLAY_WORKOUT";
    private const int RequestPause = 1; // distinct request codes keep the two PendingIntents from being treated as the same one
    private const int RequestPlay = 2;

    internal const string ChannelId = "ergnova_workout_session";
    private const int NotificationId = 4200; // arbitrary, just needs to be stable and app-unique

    private const string ExtraTitle = "title";
    private const string ExtraStatus = "status";
    private const string ExtraElapsedSec = "elapsedSec";
    private const string ExtraText = "text";
    private const string ExtraExpanded = "expanded";
    private const string ExtraLive = "live"; // metrics / notes / totals, as a JSON BackgroundSnapshot — too structured for a flat extra

    /// <summary>How long each metric's icon holds the status bar before the next
    /// one takes over. Long enough to recognise at a glance, short enough that a
    /// six-sensor ride cycles in under 20 s.</summary>
    internal const long IconRotationMs = 3000;

    /// <summary>The chronometer base is only re-derived from a snapshot's
    /// elapsedSec when it disagrees with the base already showing by more
    /// than this. Every ~1 Hz update recomputes "now - elapsed", which
    /// jitters by a few tens of ms; re-basing on each one makes the
    /// system-drawn seconds visibly stutter. A real discontinuity (resume
    /// after a pause, an idle-tail trim) is far larger than this.</summary>
    private const long ChronometerResyncToleranceMs = 1500;

    /// <summary>Safety cap on the wake lock, so a bug that leaks the service
    /// can never hold the CPU awake forever. Far longer than any workout.</summary>
    private const long WakeLockTimeoutMs = 12L * 60 * 60 * 1000;

    /// <summary>Non-null only while a foreground service is genuinely up (set
    /// after StartForeground() succeeds, cleared on stop/destroy) — lets
    /// AndroidBackgroundSessionService reach the live instance directly
    /// without a Binder round trip. Static because Android owns this
    /// Service's lifecycle, not our DI container; there is at most one per
    /// process (a second StartService is redelivered to the same instance's
    /// OnStartCommand, not a new one).</summary>
    internal static ErgnovaSessionService? Instance { get; private set; }

    private readonly object _gate = new();
    private bool _isForeground;
    private long _chronometerBaseMs; // wall-clock instant the timer reads 0:00 at; 0 = not currently running a chronometer
    private PowerManager.WakeLock? _wakeLock;
    private PendingIntent? _pauseIntent; // built once, reused for every ~1 Hz rebuild of the notification — see PauseIntent()/PlayIntent()
    private PendingIntent? _playIntent;
    private NotificationCompat.Builder? _builder;               // the builder behind the notification now showing — the rotation tick re-Builds it with only the small icon changed
    private List<BackgroundMetric> _rotationMetrics = new();    // status-bar metrics currently in rotation (empty unless running with readings)
    private Handler? _rotationHandler;
    private Java.Lang.Runnable? _rotationTick;
    private static bool? s_customViewsOk;                       // result of the one-time layout dry run — see CustomViewsUsable()

    public override IBinder? OnBind(Intent? intent) => null; // not a bound service — see class header

    public override StartCommandResult OnStartCommand(Intent? intent, StartCommandFlags flags, int startId)
    {
        try
        {
            EnsureChannel();
            var snapshot = ReadSnapshot(intent);
            Notification notification;
            lock (_gate) notification = BuildNotification(snapshot);

            if (!_isForeground)
            {
                // The 3-arg overload (which names the foreground service type)
                // only exists on API 29+, and is required outright on API 34+.
                // This app's minimum is API 23, so calling it unguarded throws
                // NoSuchMethodError on Android 6-9 — use the 2-arg form there
                // (the manifest-declared type is ignored below API 29 anyway).
                if (OperatingSystem.IsAndroidVersionAtLeast(29))
                    StartForeground(NotificationId, notification, ForegroundService.TypeConnectedDevice);
                else
                    StartForeground(NotificationId, notification);

                _isForeground = true;
                Instance = this;
                AcquireWakeLock();
                StartIconRotation();
            }
            else
            {
                // Already foreground from an earlier OnStartCommand — just
                // refresh the notification rather than re-declaring foreground.
                NotificationManagerCompat.From(this).Notify(NotificationId, notification);
            }

            // Tell AndroidBackgroundSessionService.StartAsync (if it's still
            // waiting) that the service is genuinely up.
            AndroidBackgroundSessionService.PendingStartSignal?.TrySetResult(true);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[ErgnovaSessionService] startForeground failed: {ex}");
            AndroidBackgroundSessionService.PendingStartSignal?.TrySetResult(false);
            ReleaseWakeLock();
            if (Instance == this) Instance = null;
            StopSelf();
            return StartCommandResult.NotSticky;
        }

        // NotSticky: if Android kills this process under memory pressure, the
        // whole HybridWebView (and the in-page workout state that's the actual
        // source of truth) is gone with it — there is nothing meaningful to
        // resurrect this service into. Reopening the app after that is exactly
        // what recording/session-persistence.js's crash-recovery snapshot
        // (kept fresh by app.js's background checkpoint timer) is for.
        return StartCommandResult.NotSticky;
    }

    /// <summary>Called directly by AndroidBackgroundSessionService.UpdateAsync
    /// on the already-running instance (see class header for why that's a
    /// plain method call).</summary>
    internal void ApplySnapshot(BackgroundSnapshot snapshot)
    {
        if (!_isForeground) return;
        try
        {
            // Notify inside the lock: the icon-rotation tick also posts this
            // notification, and two posts must not land out of order.
            lock (_gate)
            {
                var notification = BuildNotification(snapshot);
                NotificationManagerCompat.From(this).Notify(NotificationId, notification);
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[ErgnovaSessionService] notification update failed: {ex}");
        }
    }

    /// <summary>Stops the running service (if any) from the same process — no
    /// Intent involved. Deliberately NOT done by sending a "stop" Intent via
    /// StartForegroundService(): if the service isn't already running that
    /// would start it fresh, and Android then requires StartForeground() to
    /// be called within seconds or it kills the app with "did not then call
    /// Service.startForeground()". Going through the live instance can't hit
    /// that. Marshalled to the main thread because the bridge can call in on
    /// any thread.</summary>
    internal static void RequestStop()
    {
        var instance = Instance;
        if (instance is null) return;
        Instance = null; // a Start racing this Stop must build a fresh service, not talk to the dying one
        new Handler(Looper.MainLooper!).Post(() => instance.StopForegroundAndSelf());
    }

    /// <summary>The rider swiped the app out of the recents list. The
    /// Activity (and with it the WebView, and the workout state that only
    /// lives in it) is gone, but a foreground service would otherwise keep
    /// running with a non-dismissable notification that nothing will ever
    /// update again. Whatever was recorded is recoverable from the last
    /// checkpoint snapshot on next launch.</summary>
    public override void OnTaskRemoved(Intent? rootIntent)
    {
        StopForegroundAndSelf();
        base.OnTaskRemoved(rootIntent);
    }

    public override void OnDestroy()
    {
        StopIconRotation();
        ReleaseWakeLock();
        if (Instance == this) Instance = null;
        _isForeground = false;
        base.OnDestroy();
    }

    private void StopForegroundAndSelf()
    {
        if (Instance == this) Instance = null;
        _isForeground = false;
        StopIconRotation();
        ReleaseWakeLock();
        // StopForegroundFlags.Remove: also dismiss the notification immediately
        // rather than leaving a dead one lingering in the tray.
        StopForeground(StopForegroundFlags.Remove);
        StopSelf();
    }

    private void AcquireWakeLock()
    {
        try
        {
            if (_wakeLock?.IsHeld == true) return;
            var power = (PowerManager?)GetSystemService(PowerService);
            _wakeLock = power?.NewWakeLock(WakeLockFlags.Partial, "Ergnova:WorkoutSession");
            _wakeLock?.SetReferenceCounted(false);
            _wakeLock?.Acquire(WakeLockTimeoutMs);
        }
        catch (Exception ex)
        {
            // Best-effort: the foreground slot alone still keeps the process
            // alive; the wake lock only keeps the CPU from idling with the
            // screen off. Never fail the whole start over it.
            System.Diagnostics.Debug.WriteLine($"[ErgnovaSessionService] wake lock failed: {ex}");
        }
    }

    private void ReleaseWakeLock()
    {
        try
        {
            if (_wakeLock?.IsHeld == true) _wakeLock.Release();
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[ErgnovaSessionService] wake lock release failed: {ex}");
        }
        _wakeLock = null;
    }

    private void EnsureChannel()
    {
        // NotificationChannel is API 26+ only; below that, notifications need
        // no channel and the builder's channel id argument is simply ignored.
        if (!OperatingSystem.IsAndroidVersionAtLeast(26)) return;

        var manager = (NotificationManager?)GetSystemService(NotificationService);
        if (manager?.GetNotificationChannel(ChannelId) is not null) return;

        var channel = new NotificationChannel(
            ChannelId,
            "Workout in progress",
            NotificationImportance.Low) // Low: shows in the tray with no sound/heads-up interruption — a status indicator, not an alert
        {
            Description = "Shows your live workout time and stats while Ergnova is in the background.",
        };
        channel.SetShowBadge(false);
        manager?.CreateNotificationChannel(channel);
    }

    private static BackgroundSnapshot ReadSnapshot(Intent? intent)
    {
        var snapshot = new BackgroundSnapshot
        {
            Title = intent?.GetStringExtra(ExtraTitle),
            Status = intent?.GetStringExtra(ExtraStatus),
            ElapsedSec = intent?.GetDoubleExtra(ExtraElapsedSec, 0d) ?? 0d,
            Text = intent?.GetStringExtra(ExtraText),
            Expanded = intent?.GetStringExtra(ExtraExpanded),
        };

        var live = intent?.GetStringExtra(ExtraLive);
        if (!string.IsNullOrEmpty(live))
        {
            try
            {
                var parsed = JsonSerializer.Deserialize<BackgroundSnapshot>(live);
                snapshot.Metrics = parsed?.Metrics;
                snapshot.Notes = parsed?.Notes;
                snapshot.Totals = parsed?.Totals;
            }
            catch (JsonException)
            {
                // Malformed: show the plain-text fields above and let the next update fill the rest in.
            }
        }
        return snapshot;
    }

    /// <summary>Callers hold _gate — the chronometer base is mutable state.</summary>
    private Notification BuildNotification(BackgroundSnapshot snapshot)
    {
        var title = string.IsNullOrWhiteSpace(snapshot.Title) ? "Ergnova" : snapshot.Title!;
        var status = snapshot.Status ?? "running";
        var isRunning = status == "running";
        var elapsedMs = (long)(Math.Max(0d, snapshot.ElapsedSec) * 1000d);

        // The collapsed line. Live metrics come from JS already unit-formatted
        // ("215 W · 148 bpm"); this only adds the state the notification
        // itself is responsible for showing.
        var contentText = status switch
        {
            "paused" => string.IsNullOrEmpty(snapshot.Text)
                ? $"Paused at {FormatClock(snapshot.ElapsedSec)}"
                : $"Paused at {FormatClock(snapshot.ElapsedSec)} · {snapshot.Text}",
            "waiting" => string.IsNullOrEmpty(snapshot.Text) ? "Waiting to start…" : snapshot.Text!,
            _ => string.IsNullOrEmpty(snapshot.Text) ? "Recording…" : snapshot.Text!,
        };

        // Status bar (stage 1): one icon, with the live value baked into it.
        // The real system status bar has no separate text slot next to an
        // app's icon — a bare SetSmallIcon(int) could only ever show the
        // glyph — so BuildStatusIcon composes the metric's glyph and its
        // current number into one bitmap; Android still draws SmallIcon as a
        // plain white silhouette on API 21+ regardless of what's drawn into
        // it, which is why that bitmap (like the plain notification-icons
        // VectorDrawables) is plain white, not the full-colour launcher icon.
        // While the workout is live it rotates through whichever metrics
        // currently have a reading; StartIconRotation's timer re-posts the
        // notification each time the slot changes, and every ~1 Hz rebuild
        // lands on the same slot (PickRotationMetric is a pure function of the
        // clock), so the two never fight — they just redraw the same metric's
        // freshest value.
        var live = status != "paused" && status != "waiting";
        _rotationMetrics = live ? BackgroundNotificationViews.RotationMetrics(snapshot) : new List<BackgroundMetric>();
        var fallbackIcon = status == "paused" ? BackgroundNotificationViews.PauseIcon : BackgroundNotificationViews.TimerIcon;
        IconCompat? liveIcon = null;
        if (live && _rotationMetrics.Count > 0)
        {
            try
            {
                liveIcon = BackgroundNotificationViews.BuildStatusIcon(this, PickRotationMetric(_rotationMetrics));
            }
            catch (Exception ex)
            {
                // Falls back to the plain stopwatch below — a bad composite icon
                // degrades the status bar; it must never break the notification.
                System.Diagnostics.Debug.WriteLine($"[ErgnovaSessionService] status icon build failed: {ex}");
            }
        }

        var builder = new NotificationCompat.Builder(this, ChannelId);
        if (liveIcon is not null) builder.SetSmallIcon(liveIcon);
        else builder.SetSmallIcon(fallbackIcon);
        builder
            // Title/text are still set even though the custom layouts below replace
            // them on screen: they're what accessibility services, the lock screen's
            // redacted view and the plain-text fallback read.
            .SetContentTitle(title)
            .SetContentText(contentText)
            .SetOngoing(true) // not swipe-dismissable — this notification IS the "still running" indicator
            .SetOnlyAlertOnce(true) // ~1/s content updates must never re-alert/re-heads-up
            .SetCategory(NotificationCompat.CategoryWorkout)
            .SetPriority((int)NotificationPriority.Low)
            .SetVisibility(NotificationCompat.VisibilityPublic);

        if (isRunning)
        {
            // System-rendered elapsed timer. "When" is the wall-clock instant
            // the timer reads 0:00 at, i.e. now minus the workout's elapsed
            // time (which already excludes paused time — same number
            // Session#elapsedSec reports). Kept stable between updates unless
            // it genuinely disagrees — see ChronometerResyncToleranceMs.
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var wantedBase = nowMs - elapsedMs;
            if (_chronometerBaseMs == 0 || Math.Abs(wantedBase - _chronometerBaseMs) > ChronometerResyncToleranceMs)
                _chronometerBaseMs = wantedBase;

            builder.SetShowWhen(true).SetWhen(_chronometerBaseMs).SetUsesChronometer(true);
        }
        else
        {
            // A notification chronometer can't be paused, only stopped — and a
            // stopped one would just vanish. While paused/waiting the elapsed
            // time is instead printed (frozen) into the content line above,
            // and the next running update re-bases a fresh chronometer.
            _chronometerBaseMs = 0;
            builder.SetShowWhen(false).SetUsesChronometer(false);
        }

        // The remote control. Exactly one button, chosen by status the same way
        // contentText above is: "running" (and anything unrecognized) offers
        // Pause; a paused workout offers Play; one that's armed and waiting on
        // the first pedal stroke offers "Start now" (the same "Play means start
        // now" the in-app button has in that state). The icons are the platform's
        // own media glyphs — most versions draw action buttons as text only, and
        // this avoids shipping two drawables for the ones that don't.
        switch (status)
        {
            case "paused":
                builder.AddAction(global::Android.Resource.Drawable.IcMediaPlay, "Play", PlayIntent());
                break;
            case "waiting":
                builder.AddAction(global::Android.Resource.Drawable.IcMediaPlay, "Start now", PlayIntent());
                break;
            default:
                builder.AddAction(global::Android.Resource.Drawable.IcMediaPause, "Pause", PauseIntent());
                break;
        }

        // Stages 2 and 3: the collapsed row and the pulled-open view, each built
        // from the snapshot's structured metrics so every reading gets its own icon.
        // DecoratedCustomViewStyle keeps the system's header (app name, chronometer)
        // and the Pause/Play button around our layouts.
        var customViewsBuilt = false;
        if (CustomViewsUsable())
        {
            try
            {
                var night = (Resources?.Configuration?.UiMode & UiMode.NightMask) == UiMode.NightYes;
                var hasReadings = snapshot.Metrics?.Any(m => !string.IsNullOrEmpty(m.Value)) == true;
                var statusText = status switch
                {
                    // The chronometer is stopped while paused, so the frozen time goes here instead.
                    "paused" => $"Paused · {FormatClock(snapshot.ElapsedSec)}",
                    // With no readings the message line below already says "waiting" — don't say it twice.
                    "waiting" => hasReadings ? "Waiting to start" : string.Empty,
                    _ => string.Empty,
                };
                var message = snapshot.Text ?? string.Empty;
                builder
                    .SetStyle(new NotificationCompat.DecoratedCustomViewStyle())
                    .SetCustomContentView(BackgroundNotificationViews.BuildCollapsed(this, snapshot, title, statusText, message, night))
                    .SetCustomBigContentView(BackgroundNotificationViews.BuildExpanded(this, snapshot, title, statusText, message, night));
                customViewsBuilt = true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[ErgnovaSessionService] custom notification views failed: {ex}");
            }
        }

        if (!customViewsBuilt && !string.IsNullOrEmpty(snapshot.Expanded))
        {
            builder.SetStyle(new NotificationCompat.BigTextStyle().BigText(snapshot.Expanded));
        }

        // Tapping the notification returns to the app instead of sitting
        // there inert — PendingIntent.FlagImmutable is required on API 31+ for
        // any PendingIntent that doesn't need to be filled in later (this one
        // doesn't), and harmless to set unconditionally below that.
        var launchIntent = PackageManager?.GetLaunchIntentForPackage(PackageName ?? string.Empty);
        if (launchIntent is not null)
        {
            var flags = PendingIntentFlags.UpdateCurrent | PendingIntentFlags.Immutable;
            var contentIntent = PendingIntent.GetActivity(this, 0, launchIntent, flags);
            builder.SetContentIntent(contentIntent);
        }

        _builder = builder;
        return builder.Build();
    }

    // ─── Status-bar icon rotation ─────────────────────────────────────────────

    /// <summary>Which of <paramref name="metrics"/> owns the status bar right
    /// now. A pure function of the monotonic clock, so the timer tick and the
    /// ~1 Hz snapshot rebuilds always agree about the current slot.</summary>
    private static BackgroundMetric PickRotationMetric(List<BackgroundMetric> metrics) =>
        metrics[(int)(SystemClock.ElapsedRealtime() / IconRotationMs % metrics.Count)];

    /// <summary>Arms the native tick that swaps the status-bar icon. Deliberately a
    /// main-thread Handler rather than anything driven by the page: the page's JS
    /// timers are throttled once the app is backgrounded, and this is exactly the
    /// situation the status bar exists for.</summary>
    private void StartIconRotation()
    {
        _rotationHandler ??= new Handler(Looper.MainLooper!);
        _rotationTick ??= new Java.Lang.Runnable(OnIconRotationTick);
        ScheduleIconRotation();
    }

    private void StopIconRotation()
    {
        if (_rotationTick is not null) _rotationHandler?.RemoveCallbacks(_rotationTick);
    }

    /// <summary>One-shot, aimed at the next slot boundary (plus a small margin so
    /// the clock is safely past it); the tick re-arms itself.</summary>
    private void ScheduleIconRotation()
    {
        if (_rotationHandler is null || _rotationTick is null) return;
        _rotationHandler.RemoveCallbacks(_rotationTick);
        var untilNextSlot = IconRotationMs - SystemClock.ElapsedRealtime() % IconRotationMs;
        _rotationHandler.PostDelayed(_rotationTick, untilNextSlot + 50);
    }

    private void OnIconRotationTick()
    {
        if (!_isForeground) return; // stopped in the meantime — don't re-arm
        try
        {
            lock (_gate)
            {
                // Re-Build the notification that's already showing with only its small
                // icon swapped: everything else (chronometer base, layouts, button) stays
                // exactly as the last snapshot left it, and nothing has to wait for the page.
                // The composed icon carries whatever value that metric had as of the last
                // snapshot (up to ~1s stale, same throttling the rest of the notification
                // already runs under) — BuildStatusIcon returning null (an unlikely glyph
                // lookup failure) just skips this tick's repost; the outer catch below
                // covers anything it throws.
                if (_builder is not null && _rotationMetrics.Count > 1)
                {
                    var icon = BackgroundNotificationViews.BuildStatusIcon(this, PickRotationMetric(_rotationMetrics));
                    if (icon is not null)
                    {
                        _builder.SetSmallIcon(icon);
                        NotificationManagerCompat.From(this).Notify(NotificationId, _builder.Build());
                    }
                }
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[ErgnovaSessionService] icon rotation failed: {ex}");
        }
        ScheduleIconRotation();
    }

    /// <summary>Whether the custom layouts can be used at all — decided once per
    /// process by inflating them against a synthetic snapshot
    /// (BackgroundNotificationViews.DryRun). Runs the first time a notification is
    /// built, i.e. inside OnStartCommand on the main thread, where inflating views
    /// is safe. A failure is permanent for the process: the layouts are static, so
    /// retrying every second would only repeat the exception.</summary>
    private bool CustomViewsUsable()
    {
        if (s_customViewsOk is bool known) return known;
        try
        {
            BackgroundNotificationViews.DryRun(this);
            s_customViewsOk = true;
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[ErgnovaSessionService] custom notification layouts unusable, using plain text: {ex}");
            s_customViewsOk = false;
        }
        return s_customViewsOk.Value;
    }

    /// <summary>Callers hold _gate (via BuildNotification).</summary>
    private PendingIntent PauseIntent() => _pauseIntent ??= BuildActionIntent(ActionPause, RequestPause);

    /// <summary>Callers hold _gate (via BuildNotification).</summary>
    private PendingIntent PlayIntent() => _playIntent ??= BuildActionIntent(ActionPlay, RequestPlay);

    /// <summary>A broadcast at ErgnovaSessionActionReceiver rather than a
    /// service Intent back at this class, for the same reason StopAsync never
    /// sends one: a service Intent that arrives when the service isn't running
    /// (a stale tap after the workout ended, a service that was just torn down)
    /// would START it, and a service started without calling StartForeground()
    /// soon after gets the whole app killed. A receiver has no such trap, and
    /// the tap needs the page, not this service. Explicit (component-targeted)
    /// and Immutable, so nothing else can hijack or fill in the Intent.</summary>
    private PendingIntent BuildActionIntent(string action, int requestCode)
    {
        var intent = new Intent(this, typeof(ErgnovaSessionActionReceiver));
        intent.SetAction(action);
        return PendingIntent.GetBroadcast(this, requestCode, intent, PendingIntentFlags.UpdateCurrent | PendingIntentFlags.Immutable)!;
    }

    private static string FormatClock(double seconds)
    {
        var total = (long)Math.Floor(Math.Max(0d, seconds));
        var h = total / 3600;
        var m = total % 3600 / 60;
        var s = total % 60;
        return h > 0 ? $"{h}:{m:00}:{s:00}" : $"{m}:{s:00}";
    }

    /// <summary>Used by AndroidBackgroundSessionService.StartAsync to build the
    /// Intent it hands to ContextCompat.StartForegroundService — kept here,
    /// next to the Extra* keys, so the two classes can't drift apart.</summary>
    internal static Intent BuildStartIntent(Context context, BackgroundSnapshot snapshot)
    {
        var intent = new Intent(context, typeof(ErgnovaSessionService));
        intent.SetAction(ActionStart);
        intent.PutExtra(ExtraTitle, snapshot.Title ?? "");
        intent.PutExtra(ExtraStatus, snapshot.Status ?? "");
        intent.PutExtra(ExtraElapsedSec, snapshot.ElapsedSec);
        intent.PutExtra(ExtraText, snapshot.Text ?? "");
        intent.PutExtra(ExtraExpanded, snapshot.Expanded ?? "");
        intent.PutExtra(ExtraLive, JsonSerializer.Serialize(new BackgroundSnapshot
        {
            Metrics = snapshot.Metrics,
            Notes = snapshot.Notes,
            Totals = snapshot.Totals,
        }));
        return intent;
    }
}
