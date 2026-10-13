// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using Android.Content;
using Android.Graphics;
using Android.Views;
using Android.Widget;
using AndroidX.Core.Content;
using AndroidX.Core.Graphics.Drawable;
using Ergnova.Services;
// This file is Android-native view/bitmap construction only, never MAUI's
// cross-platform drawing layer — but MAUI's project-wide global usings pull in
// Microsoft.Maui.Graphics, which happens to declare types of the same name
// (Paint, Color) as Android.Graphics. Aliasing them here keeps every use site
// below resolving to the Android ones without a CS0104 fully-qualifying every
// call, and without suppressing the ambiguity for the rest of the file.
using Paint = Android.Graphics.Paint;
using Color = Android.Graphics.Color;

namespace Ergnova.Platforms.Android;

/// <summary>
/// Builds the two custom layouts of the ongoing workout notification (the row
/// shown in the shade, and the one shown when the rider pulls it open) from a
/// <see cref="BackgroundSnapshot"/>, plus the icon / colour lookups that go with
/// them. Pure view construction — no notification, service or threading logic —
/// so ErgnovaSessionService can stay about lifecycle.
///
/// Why RemoteViews at all: a notification's plain text can't contain an icon,
/// and the only way to put an icon next to each metric is to supply the layout
/// ourselves (NotificationCompat.DecoratedCustomViewStyle, which keeps the
/// system's own header, elapsed timer and Pause/Play button around it). The
/// layouts are Resources/layout/notif_*.xml.
///
/// Three surfaces, three jobs:
///   * status bar   — BuildStatusIcon: the current metric's glyph stacked over
///                    its live value (top 75% / bottom 25% of the bitmap — a
///                    plain SetSmallIcon(int) can only ever show the glyph,
///                    there's no separate text slot next to it in the real
///                    system status bar). The bitmap's size is the same on
///                    every rotation frame — reserved for the widest value
///                    any metric could show, not measured per-frame — so
///                    nothing visibly resizes as the metric rotates.
///                    ErgnovaSessionService decides which metric is showing
///                    and when to rotate; this only draws whichever one it's
///                    given.
///   * collapsed    — BuildCollapsed: title, then up to MaxCollapsedChips
///                    "icon 215 W" chips in a fixed order, so the numbers don't
///                    jump around under the rider's thumb as the icon rotates.
///   * expanded     — BuildExpanded: title, context lines (scripted step /
///                    target, strength exercise / rest), a grid of every metric
///                    with its icon and label, then a totals row.
///
/// Icons are the notification-icons SVGs (tools/notification-icons/svg/),
/// converted to VectorDrawables; a metric's icon is looked up by the page's own
/// metric key. The same white drawable serves as the status-bar silhouette and,
/// tinted at runtime with setColorFilter, as each in-notification icon.
///
/// VERIFY: not compiled or run in the environment that produced this file (no
/// Android workload available) — API names are from the .NET for Android
/// bindings as documented, and the layouts stick to the classes RemoteViews
/// allows. ErgnovaSessionService dry-runs the inflate once and falls back to
/// the plain-text notification if it throws, so a mistake here degrades the
/// notification rather than killing the foreground service.
/// </summary>
internal static class BackgroundNotificationViews
{
    /// <summary>The collapsed row has room for about three "icon 215 W" chips at
    /// typical phone widths (same count the plain-text line always used). Everything
    /// else is in the expanded view and still gets its turn in the status bar.</summary>
    internal const int MaxCollapsedChips = 3;

    /// <summary>Up to this many metrics, the expanded grid is 2 columns; above it,
    /// 3 — which keeps even a full six-sensor ride to two rows, inside the
    /// expanded notification's height budget (see notif_expanded.xml).</summary>
    private const int NarrowGridMaxMetrics = 4;

    /// <summary>Icons/text without a colour of their own (totals, notes, a metric the
    /// page sent no colour for): a mid grey legible on both light and dark shades.</summary>
    private static readonly int NeutralColor = unchecked((int)0xFF9AA0A6);

    /// <summary>The app's metric colours (the chart line colours) are tuned for its
    /// dark UI; on a light notification shade they'd wash out — amber and cyan
    /// especially — so they're darkened by this factor there.</summary>
    private const float LightThemeDarken = 0.72f;

    // Built lazily, on first use, rather than in a static initializer: the
    // Resource.Drawable ids are only populated once the app has started.
    private static Dictionary<string, int>? s_iconByKey;

    private static Dictionary<string, int> IconByKey => s_iconByKey ??= new Dictionary<string, int>(StringComparer.Ordinal)
    {
        // Live sensor metrics — keys are web/src/app.js's METRIC_ORDER.
        ["power"] = Resource.Drawable.ic_stat_power,
        ["heartRate"] = Resource.Drawable.ic_stat_heart_rate,
        ["cadence"] = Resource.Drawable.ic_stat_cadence,
        ["speed"] = Resource.Drawable.ic_stat_speed,
        ["smo2"] = Resource.Drawable.ic_stat_smo2,
        ["coreTemp"] = Resource.Drawable.ic_stat_core_temp,
        // Totals.
        ["calories"] = Resource.Drawable.ic_stat_calories,
        ["distance"] = Resource.Drawable.ic_stat_distance,
        // Strength workouts.
        ["sets"] = Resource.Drawable.ic_stat_sets,
        ["exercise"] = Resource.Drawable.ic_stat_sets,
        ["rest"] = Resource.Drawable.ic_stat_timer,
        // Scripted-workout context lines.
        ["step"] = Resource.Drawable.ic_stat_step,
        ["target"] = Resource.Drawable.ic_stat_target,
    };

    /// <summary>Icon for a metric / note key; the stopwatch for anything unknown,
    /// so a metric the page adds later still gets a sensible glyph rather than none.</summary>
    internal static int IconFor(string? key) =>
        key is not null && IconByKey.TryGetValue(key, out var id) ? id : Resource.Drawable.ic_stat_timer;

    /// <summary>Status-bar icon while the workout is paused.</summary>
    internal static int PauseIcon => Resource.Drawable.ic_stat_pause;

    /// <summary>Status-bar icon while waiting to start, or with no metric to show yet.</summary>
    internal static int TimerIcon => Resource.Drawable.ic_stat_timer;

    /// <summary>The metrics to rotate the status bar through: one per live
    /// reading that currently has a value, in the page's display order, one
    /// entry per key. The totals (calories, distance) and notes aren't part of
    /// it — the status bar answers "what is my body / the bike doing right
    /// now". ErgnovaSessionService decides WHEN to show which (and re-fetches
    /// this on every snapshot, so a rotation tick between updates still draws
    /// whatever value that metric last had); this only says what's in the
    /// rotation.</summary>
    internal static List<BackgroundMetric> RotationMetrics(BackgroundSnapshot snapshot)
    {
        var metrics = new List<BackgroundMetric>();
        if (snapshot.Metrics is null) return metrics;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var metric in snapshot.Metrics)
        {
            if (string.IsNullOrEmpty(metric.Value) || metric.Key is null) continue;
            if (seen.Add(metric.Key)) metrics.Add(metric);
        }
        return metrics;
    }

    /// <summary>The widest value any live metric's fmt() actually produces
    /// (SmO2's "100.0" — see web/src/app.js's METRIC_DEFS), with every digit
    /// swapped for '8', the widest-drawing digit in most fonts. Reserving the
    /// canvas at this width — rather than each frame's own MeasureText — is
    /// what keeps the bitmap the same size on every rotation tick; see
    /// BuildStatusIcon below.</summary>
    private const string MaxValueTemplate = "888.8";

    /// <summary>Share of the bitmap's total height given to the glyph (top);
    /// the rest, at the bottom, is the centered value. 68%, not 75% — at
    /// Roboto Bold's typical digit proportions, that's roughly the split
    /// where MaxValueTemplate's rendered width comes out equal to the glyph's
    /// own width, so the widest value spans edge-to-edge with the icon
    /// instead of sitting narrower than it. See BuildStatusIcon, which
    /// derives the total height FROM this fraction and a fixed 24dp icon
    /// size, not the other way around.</summary>
    private const float IconHeightFraction = 0.68f;

    /// <summary>Composes one status-bar icon: the metric's glyph stacked over
    /// its live value, centered underneath it. This — and not a plain
    /// SetSmallIcon(int) — is what actually gets the number into the real
    /// system status bar: that surface has room for exactly one icon and
    /// nothing else, so the only way to show "215" there at all is to draw it
    /// onto the icon's own bitmap. The system status bar still recolours every
    /// opaque pixel to a flat silhouette colour and discards the rest (the same
    /// rule a plain drawable icon follows — see the class summary), so drawing
    /// both the glyph and the digits in solid white on transparent is what
    /// makes that rule keep working here too; the actual Color.White below is
    /// never seen as "white" so much as "opaque".
    ///
    /// Returns null (never throws) for a metric with no value or an unknown
    /// icon key, so ErgnovaSessionService's caller can fall back to the plain
    /// TimerIcon — same "degrade, don't break the notification" contract as
    /// the rest of this class.</summary>
    internal static IconCompat? BuildStatusIcon(Context context, BackgroundMetric metric)
    {
        if (string.IsNullOrEmpty(metric.Value)) return null;
        var glyph = ContextCompat.GetDrawable(context, IconFor(metric.Key));
        if (glyph is null) return null;

        var density = context.Resources?.DisplayMetrics?.Density ?? 1f;
        float Dp(float dp) => dp * density;

        // Stacked layout: glyph on top, value centered underneath. The glyph
        // is pinned at 24dp — the same size the plain Pause/Waiting icons
        // render at, so those bare rotation states still match this composite
        // one — and the total height is derived FROM that, via
        // IconHeightFraction, rather than the other way around: fixing the
        // total and letting the icon fall out of the split is what made the
        // icon 24dp only by coincidence (32dp × 75%) the last time this
        // changed. Deriving it here keeps the icon pinned no matter which
        // fraction IconHeightFraction ends up being.
        var iconPx = (int)MathF.Round(Dp(24f));
        var totalPx = (int)MathF.Round(iconPx / IconHeightFraction);
        var textAreaPx = totalPx - iconPx;

        // Sized off the text band itself (with a little headroom so a tall
        // glyph-shaped digit doesn't clip the bitmap's bottom edge) rather
        // than a fixed dp, so it stays proportionate if totalPx above changes.
        var textPaint = new Paint(PaintFlags.AntiAlias) { Color = Color.White, TextSize = textAreaPx * 0.85f };
        textPaint.SetTypeface(Typeface.DefaultBold);

        // Reserved at MaxValueTemplate's width, not this frame's own value:
        // what keeps the bitmap the same size on every rotation tick instead
        // of resizing per metric (a decimal reading like "30.2" vs "215").
        var textColumnWidth = textPaint.MeasureText(MaxValueTemplate);

        var width = (int)MathF.Ceiling(MathF.Max(iconPx, textColumnWidth));
        if (width <= 0 || totalPx <= 0) return null;

        // Not disposed here: IconCompat.CreateWithBitmap keeps this bitmap as
        // the icon's own backing store, which the system reads again when the
        // notification is actually posted/parcelled, not only at the moment
        // this method returns.
        var bitmap = Bitmap.CreateBitmap(width, totalPx, Bitmap.Config.Argb8888!);
        var canvas = new Canvas(bitmap);

        // Glyph, centered horizontally, in the top IconHeightFraction band.
        var iconLeft = (int)MathF.Round((width - iconPx) / 2f);
        glyph.SetBounds(iconLeft, 0, iconLeft + iconPx, iconPx);
        glyph.Draw(canvas);

        // Value centered both horizontally and vertically within the bottom
        // band. GetFontMetrics() is bound as nullable, but a Paint's own font
        // metrics are never actually null — same "documented API, trust it"
        // call as the Bitmap.Config.Argb8888! and MainLooper! forgiving
        // operators elsewhere.
        var fm = textPaint.GetFontMetrics()!;
        var baseline = iconPx + textAreaPx / 2f - (fm.Ascent + fm.Descent) / 2f;
        var textWidth = textPaint.MeasureText(metric.Value);
        canvas.DrawText(metric.Value, (width - textWidth) / 2f, baseline, textPaint);

        return IconCompat.CreateWithBitmap(bitmap);
    }

    /// <summary>Builds and inflates both layouts once against a synthetic snapshot
    /// that touches every layout file (chips, notes, a 3-column grid with a spare
    /// slot, the totals row). Throws if a layout, id or drawable is missing or a
    /// view class isn't allowed in a RemoteViews — ErgnovaSessionService calls this
    /// once per process and, on a throw, keeps using the plain-text notification.
    /// A real snapshot can't find a new way to break: the layouts don't vary.</summary>
    internal static void DryRun(Context context)
    {
        var sample = new BackgroundSnapshot
        {
            Metrics = new List<BackgroundMetric>
            {
                new() { Key = "power",     Label = "Power",      Value = "215", Unit = "W",    Color = "#f97415" },
                new() { Key = "heartRate", Label = "Heart Rate", Value = "148", Unit = "bpm",  Color = "#f65151" },
                new() { Key = "cadence",   Label = "Cadence",    Value = "88",  Unit = "rpm",  Color = "#23c7c2" },
                new() { Key = "speed",     Label = "Speed",      Value = "30.2", Unit = "km/h", Color = "#0da6f2" },
                new() { Key = "smo2",      Label = "SmO2",       Value = "61.5", Unit = "%",   Color = "#11d45c" },
            },
            Notes = new List<BackgroundNote>
            {
                new() { Key = "step",   Text = "Step 2/5 · Interval", Trailing = "1:30 left" },
                new() { Key = "target", Text = "Target 250W" },
            },
            Totals = new List<BackgroundMetric>
            {
                new() { Key = "calories", Label = "Calories", Value = "121", Unit = "kcal" },
                new() { Key = "distance", Label = "Distance", Value = "5.2",  Unit = "km" },
            },
        };
        var parent = new FrameLayout(context);
        BuildCollapsed(context, sample, "Ergnova", "Paused · 12:34", string.Empty, night: false).Apply(context, parent);
        BuildExpanded(context, sample, "Ergnova", "Paused · 12:34", string.Empty, night: true).Apply(context, parent);
    }

    /// <summary>Parses "#rrggbb" to an opaque ARGB int, or null if it isn't one.</summary>
    internal static int? ParseColor(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex)) return null;
        var s = hex.Trim();
        if (s.StartsWith('#')) s = s.Substring(1);
        if (s.Length != 6) return null;
        if (!int.TryParse(s, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out var rgb))
            return null;
        return unchecked((int)0xFF000000) | rgb;
    }

    /// <summary>The colour a metric's in-notification icon is tinted with.</summary>
    internal static int AccentFor(BackgroundMetric metric, bool night)
    {
        var parsed = ParseColor(metric.Color);
        if (parsed is null) return NeutralColor;
        return night ? parsed.Value : Darken(parsed.Value, LightThemeDarken);
    }

    private static int Darken(int argb, float factor)
    {
        var r = (int)(((argb >> 16) & 0xFF) * factor);
        var g = (int)(((argb >> 8) & 0xFF) * factor);
        var b = (int)((argb & 0xFF) * factor);
        return unchecked((int)0xFF000000) | (r << 16) | (g << 8) | b;
    }

    // ─── The two layouts ──────────────────────────────────────────────────────

    /// <summary>The row shown in the shade: title (+ status), then metric chips —
    /// or, when there are no readings yet, a single line of message text.</summary>
    internal static RemoteViews BuildCollapsed(
        Context context, BackgroundSnapshot snapshot, string title, string statusText, string message, bool night)
    {
        var views = new RemoteViews(context.PackageName, Resource.Layout.notif_collapsed);
        SetTitle(views, title, statusText);

        var shown = 0;
        if (snapshot.Metrics is not null)
        {
            foreach (var metric in snapshot.Metrics)
            {
                if (shown == MaxCollapsedChips) break;
                if (string.IsNullOrEmpty(metric.Value)) continue;
                views.AddView(Resource.Id.notif_chips, ChipFor(context, metric, AccentFor(metric, night)));
                shown++;
            }
        }

        if (shown == 0) ShowMessage(views, message);
        return views;
    }

    /// <summary>The pulled-open notification: title (+ status), context lines, the
    /// metric grid, a divider, and the totals row.</summary>
    internal static RemoteViews BuildExpanded(
        Context context, BackgroundSnapshot snapshot, string title, string statusText, string message, bool night)
    {
        var views = new RemoteViews(context.PackageName, Resource.Layout.notif_expanded);
        SetTitle(views, title, statusText);

        var notes = 0;
        if (snapshot.Notes is not null)
        {
            foreach (var note in snapshot.Notes)
            {
                if (string.IsNullOrEmpty(note.Text) && string.IsNullOrEmpty(note.Trailing)) continue;
                views.AddView(Resource.Id.notif_notes, NoteFor(context, note));
                notes++;
            }
        }

        var metrics = new List<BackgroundMetric>();
        if (snapshot.Metrics is not null)
        {
            foreach (var metric in snapshot.Metrics)
                if (!string.IsNullOrEmpty(metric.Value)) metrics.Add(metric);
        }
        AddGrid(context, views, metrics, night);

        var totals = 0;
        if (snapshot.Totals is not null)
        {
            foreach (var total in snapshot.Totals)
            {
                if (string.IsNullOrEmpty(total.Value)) continue;
                views.AddView(Resource.Id.notif_totals, ChipFor(context, total, AccentFor(total, night)));
                totals++;
            }
        }

        if (metrics.Count > 0 && totals > 0) views.SetViewVisibility(Resource.Id.notif_divider, ViewStates.Visible);
        if (notes == 0 && metrics.Count == 0 && totals == 0) ShowMessage(views, message);
        return views;
    }

    // ─── Pieces ───────────────────────────────────────────────────────────────

    private static void SetTitle(RemoteViews views, string title, string statusText)
    {
        views.SetTextViewText(Resource.Id.notif_title, title);
        if (string.IsNullOrEmpty(statusText)) return;
        views.SetTextViewText(Resource.Id.notif_status, statusText);
        views.SetViewVisibility(Resource.Id.notif_status, ViewStates.Visible);
    }

    private static void ShowMessage(RemoteViews views, string message)
    {
        if (string.IsNullOrEmpty(message)) return;
        views.SetTextViewText(Resource.Id.notif_message, message);
        views.SetViewVisibility(Resource.Id.notif_message, ViewStates.Visible);
    }

    /// <summary>"icon  215 W" — used for the collapsed row and the totals row.</summary>
    private static RemoteViews ChipFor(Context context, BackgroundMetric metric, int tint)
    {
        var chip = new RemoteViews(context.PackageName, Resource.Layout.notif_chip);
        chip.SetImageViewResource(Resource.Id.notif_chip_icon, IconFor(metric.Key));
        chip.SetInt(Resource.Id.notif_chip_icon, "setColorFilter", tint);
        chip.SetTextViewText(Resource.Id.notif_chip_value, metric.Value ?? string.Empty);
        if (string.IsNullOrEmpty(metric.Unit))
        {
            chip.SetViewVisibility(Resource.Id.notif_chip_unit, ViewStates.Gone);
        }
        else
        {
            chip.SetTextViewText(Resource.Id.notif_chip_unit, metric.Unit);
        }
        return chip;
    }

    /// <summary>One context line: icon, text, optional right-aligned trailing value.</summary>
    private static RemoteViews NoteFor(Context context, BackgroundNote note)
    {
        var line = new RemoteViews(context.PackageName, Resource.Layout.notif_note);
        line.SetImageViewResource(Resource.Id.notif_note_icon, IconFor(note.Key));
        line.SetInt(Resource.Id.notif_note_icon, "setColorFilter", NeutralColor);
        line.SetTextViewText(Resource.Id.notif_note_text, note.Text ?? string.Empty);
        if (!string.IsNullOrEmpty(note.Trailing))
        {
            line.SetTextViewText(Resource.Id.notif_note_trailing, note.Trailing);
            line.SetViewVisibility(Resource.Id.notif_note_trailing, ViewStates.Visible);
        }
        return line;
    }

    /// <summary>Lays the metrics out in rows of 2 (up to 4 metrics) or 3 columns.
    /// A row's unused slots get an invisible cell so the columns stay aligned with
    /// the rows above rather than the last row's cells stretching wider.</summary>
    private static void AddGrid(Context context, RemoteViews views, List<BackgroundMetric> metrics, bool night)
    {
        if (metrics.Count == 0) return;

        var columns = metrics.Count <= NarrowGridMaxMetrics ? 2 : 3;
        for (var start = 0; start < metrics.Count; start += columns)
        {
            var row = new RemoteViews(context.PackageName, Resource.Layout.notif_row);
            for (var c = 0; c < columns; c++)
            {
                var cell = new RemoteViews(context.PackageName, Resource.Layout.notif_cell);
                var index = start + c;
                if (index < metrics.Count) FillCell(cell, metrics[index], night);
                else cell.SetViewVisibility(Resource.Id.notif_cell_root, ViewStates.Invisible);
                row.AddView(Resource.Id.notif_row, cell);
            }
            views.AddView(Resource.Id.notif_grid, row);
        }
    }

    private static void FillCell(RemoteViews cell, BackgroundMetric metric, bool night)
    {
        cell.SetImageViewResource(Resource.Id.notif_cell_icon, IconFor(metric.Key));
        cell.SetInt(Resource.Id.notif_cell_icon, "setColorFilter", AccentFor(metric, night));
        cell.SetTextViewText(Resource.Id.notif_cell_label, metric.Label ?? string.Empty);
        cell.SetTextViewText(Resource.Id.notif_cell_value, metric.Value ?? string.Empty);
        if (string.IsNullOrEmpty(metric.Unit)) cell.SetViewVisibility(Resource.Id.notif_cell_unit, ViewStates.Gone);
        else cell.SetTextViewText(Resource.Id.notif_cell_unit, metric.Unit);
    }
}