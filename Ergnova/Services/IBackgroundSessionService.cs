// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using System.Text.Json.Serialization;

namespace Ergnova.Services;

/// <summary>
/// Platform seam behind window.__ergnovaNativeBackground (see
/// web/src/platform/background-session.js's header comment for the full
/// contract this exists to satisfy, and web/public/native-shell-bridge.js
/// for the JS-side glue that calls into NativeBridgeMethods' Background*
/// methods below, which just delegate to whichever implementation of this
/// interface MauiProgram.cs registered for the current target).
///
/// Only Android gets a real implementation
/// (Platforms/Android/AndroidBackgroundSessionService.cs) — a persistent
/// foreground-service notification with an OS-guaranteed "keep running"
/// grant is specifically an Android mechanism. iOS, Mac Catalyst, and
/// Windows all get UnsupportedBackgroundSessionService, which always
/// reports Supported = false; background-session.js already treats that
/// identically to "no bridge at all" and falls back to its documented
/// pause+snapshot-on-hide behavior, so nothing further is needed for
/// those three targets.
/// </summary>
public interface IBackgroundSessionService
{
    Task<BackgroundInfo> GetInfoAsync();

    /// <summary>Prompts for whatever this platform's "can I show a
    /// notification" permission is (Android 13+'s POST_NOTIFICATIONS;
    /// older Android versions and every unsupported platform have nothing
    /// to prompt for and just return the current info). Safe to call
    /// whether or not a session is currently running.</summary>
    Task<BackgroundInfo> EnsurePermissionsAsync();

    /// <summary>Starts (or, if already running, is a no-op that just
    /// answers with current state for) the platform's keep-alive
    /// mechanism, showing `snapshot` right away. Resolves once the
    /// platform has actually confirmed it's up (or definitively failed) —
    /// see AndroidBackgroundSessionService's own doc comment on why a
    /// fire-and-forget StartForegroundService() call can't just be
    /// reported as running without that confirmation.</summary>
    Task<BackgroundInfo> StartAsync(BackgroundSnapshot snapshot);

    /// <summary>Updates the already-showing notification/indicator in
    /// place. A no-op if nothing is currently running (mirrors
    /// background-session.js's own _sendUpdate(), which never calls this
    /// unless _running is already true).</summary>
    Task UpdateAsync(BackgroundSnapshot snapshot);

    /// <summary>Stops the keep-alive mechanism. A no-op if nothing is running.</summary>
    Task StopAsync();

    /// <summary>Deep-links into this app's OS-level notification settings —
    /// the only way back once a "don't ask again" notification denial has
    /// happened. A no-op on platforms with no such settings screen /
    /// concept (everything but Android).</summary>
    Task OpenNotificationSettingsAsync();

    /// <summary>Registers who hears about the rider tapping a control on the
    /// ongoing notification — one of <see cref="BackgroundActions"/>'s
    /// values (Pause while the workout is running, Play while it's paused or
    /// still waiting for the first pedal stroke). NativeBridgeMethods
    /// registers itself and forwards each action up to JS, which owns the
    /// workout and decides what actually changes; this interface only
    /// reports the tap. Latest registration wins (passing null clears it), so
    /// a MainPage that's recreated simply takes over from the old one instead
    /// of leaving a dead handler subscribed. The handler can be invoked on
    /// any thread. A no-op on platforms that never show a notification.</summary>
    void SetActionHandler(Action<string>? handler);
}

/// <summary>The action ids that cross the native -> JS boundary when a
/// notification control is tapped. Kept as plain strings because they travel
/// as-is inside the JSON push message and are matched by name in
/// background-session.js's own _handleNativeAction() — change one here and
/// that has to change with it.</summary>
public static class BackgroundActions
{
    public const string Pause = "pause";
    public const string Play = "play";
}

/// <summary>Matches background-session.js's `_info` shape exactly —
/// property names are pinned via JsonPropertyName because HybridWebView's
/// InvokeDotNet return-value serialization is plain reflection-based
/// System.Text.Json with no camelCase naming policy (see
/// NativeBridgeMethods.cs's own header note on BleDeviceInfo for the same
/// issue).</summary>
public sealed class BackgroundInfo
{
    [JsonPropertyName("supported")]
    public bool Supported { get; set; }

    [JsonPropertyName("platform")]
    public string Platform { get; set; } = "web";

    [JsonPropertyName("notificationsAllowed")]
    public bool NotificationsAllowed { get; set; } = true;

    [JsonPropertyName("running")]
    public bool Running { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}

/// <summary>Matches the `snapshot` shape background-session.js's sync(snapshot)
/// takes (see that file's header comment) — deserialized from the JSON string
/// NativeBridgeMethods.BackgroundStart/BackgroundUpdate receive (see those
/// methods' own comments for why a JSON string rather than individual
/// params, same reasoning as BleRequestDevice's optionsJson).</summary>
public sealed class BackgroundSnapshot
{
    [JsonPropertyName("title")]
    public string? Title { get; set; }

    /// <summary>'running' | 'paused' | 'waiting' — passed straight through
    /// as an opaque string; only background-session.js's own throttle
    /// logic (a status/title change bypasses it) and the native
    /// notification's own text care about its value, neither of which
    /// needs it as a typed enum on this side.</summary>
    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("elapsedSec")]
    public double ElapsedSec { get; set; }

    [JsonPropertyName("text")]
    public string? Text { get; set; }

    [JsonPropertyName("expanded")]
    public string? Expanded { get; set; }

    /// <summary>The live sensor readings, in the page's METRIC_ORDER — one per
    /// metric that currently has a value. Drives the icon chips on the
    /// collapsed notification, the icon grid on the expanded one, and the
    /// metrics the status-bar icon rotates through. `text` / `expanded` above
    /// carry the same numbers as plain text: they're what the notification
    /// falls back to if the custom layouts can't be inflated.</summary>
    [JsonPropertyName("metrics")]
    public List<BackgroundMetric>? Metrics { get; set; }

    /// <summary>Context lines for the expanded notification: the scripted
    /// workout's step and target, or a strength workout's current exercise /
    /// rest timer.</summary>
    [JsonPropertyName("notes")]
    public List<BackgroundNote>? Notes { get; set; }

    /// <summary>Running totals (calories, distance) — the row under the metric
    /// grid on the expanded notification. Same shape as a metric, but never
    /// part of the status-bar rotation.</summary>
    [JsonPropertyName("totals")]
    public List<BackgroundMetric>? Totals { get; set; }
}

/// <summary>One reading on the notification. `Key` is the page's own metric key
/// ("power", "heartRate", "calories", "sets", ...) and is what picks the icon
/// (BackgroundNotificationViews.IconFor); `Value` is the already unit-converted
/// number ("215"), `Unit` its unit ("W"), `Color` the metric's "#rrggbb" chart
/// colour, or null for a neutral tint.</summary>
public sealed class BackgroundMetric
{
    [JsonPropertyName("key")]
    public string? Key { get; set; }

    [JsonPropertyName("label")]
    public string? Label { get; set; }

    [JsonPropertyName("value")]
    public string? Value { get; set; }

    [JsonPropertyName("unit")]
    public string? Unit { get; set; }

    [JsonPropertyName("color")]
    public string? Color { get; set; }
}

/// <summary>One context line on the expanded notification: an icon (by `Key`:
/// "step", "target", "exercise", "rest"), some text, and an optional
/// right-aligned trailing value such as the time left in the step.</summary>
public sealed class BackgroundNote
{
    [JsonPropertyName("key")]
    public string? Key { get; set; }

    [JsonPropertyName("text")]
    public string? Text { get; set; }

    [JsonPropertyName("trailing")]
    public string? Trailing { get; set; }
}
