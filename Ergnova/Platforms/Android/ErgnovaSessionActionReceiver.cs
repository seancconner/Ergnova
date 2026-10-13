// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using Android.Content;
using Ergnova.Services;

namespace Ergnova.Platforms.Android;

/// <summary>
/// Receives the tap on the workout notification's Pause / Play button (the
/// PendingIntents ErgnovaSessionService.BuildActionIntent builds) and hands it
/// to AndroidBackgroundSessionService.RaiseAction, which passes it up to the
/// page — see ErgnovaSessionService's class header for why the page, not this
/// receiver, is the one that actually pauses anything.
///
/// Registered through the [BroadcastReceiver] attribute (the same
/// convention ErgnovaSessionService's [Service] and MainActivity's [Activity]
/// use), so it needs no AndroidManifest.xml entry. Exported = false: the
/// PendingIntents that reach it are explicit and issued by this app, and no
/// other app has any business sending it a pause.
///
/// OnReceive runs on the main thread and must return quickly; RaiseAction is a
/// non-blocking delegate call (the JS push it triggers is queued to the main
/// thread again by MainPage), and never throws — an exception out of a
/// receiver would take the process down.
///
/// VERIFY: not compiled in the environment that produced this file (no
/// Android workload available).
/// </summary>
[BroadcastReceiver(Enabled = true, Exported = false)]
public sealed class ErgnovaSessionActionReceiver : BroadcastReceiver
{
    public override void OnReceive(Context? context, Intent? intent)
    {
        var action = intent?.Action switch
        {
            ErgnovaSessionService.ActionPause => BackgroundActions.Pause,
            ErgnovaSessionService.ActionPlay => BackgroundActions.Play,
            _ => null,
        };
        if (action is null) return;

        AndroidBackgroundSessionService.RaiseAction(action);
    }
}
