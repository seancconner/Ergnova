// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using System.Collections.ObjectModel;
using Ergnova.Services;

namespace Ergnova.Controls;

/// <summary>
/// Modal page shown by <see cref="BleDevicePicker"/>. Owns no scanning
/// itself — <see cref="NativeBridgeMethods.BleRequestDevice"/> runs the
/// actual scan and feeds results in via the <see cref="IObservable{T}"/>
/// passed to the constructor; this page only displays what it's given and
/// reports back which one (if any) the user tapped.
///
/// ── Why the completion path is as convoluted as it looks ───────────────
/// Everything this page does on selection/cancel is deliberately deferred
/// to a *later* UI-thread turn (see <see cref="Complete"/>). Completing
/// synchronously from inside the CollectionView's SelectionChanged (or the
/// Cancel Button's Clicked) handler resumes WaitForSelectionAsync inline,
/// which means PopModalAsync() runs while WinUI is still dispatching that
/// very event — i.e. the ListViewBase raising SelectionChanged gets torn
/// out of the visual tree from inside its own event. On Windows that
/// surfaces as an unhandled exception (a COM/Win32 failure out of
/// Microsoft.ui.xaml.dll — cf. dotnet/maui#3572 and
/// microsoft-ui-xaml#10897, both "PopModalAsync from a modal page's own
/// event handler"), which MAUI's Windows head has nowhere to send, so it
/// lands in the generated App.g.i.cs UnhandledException hook and stops the
/// debugger on its Debugger.Break(). Don't re-inline this.
/// </summary>
public partial class BleDevicePickerPage : ContentPage
{
    /// <summary>Backs the CollectionView in the XAML. Devices are appended
    /// in first-seen order and never removed — a device already offered
    /// staying in the list even if it stops advertising mid-scan is fine
    /// (arguably better: it avoids the list visibly shrinking under someone's
    /// thumb) and matches how a real Web Bluetooth chooser behaves too.</summary>
    public ObservableCollection<BleDeviceInfo> Devices { get; } = new();

    /// <summary>True until the first device is offered — drives the
    /// "Scanning…" placeholder in the XAML. Deliberately doesn't flip back
    /// to true if Devices later empties (it won't, per the note above), so
    /// this is a one-way "have we found anything yet" flag rather than a
    /// live Devices.Count == 0 mirror.</summary>
    public bool IsEmpty => Devices.Count == 0;

    private readonly IDisposable _subscription;
    private readonly HashSet<string> _seenIds = new();

    /// <summary>RunContinuationsAsynchronously is load-bearing, not a
    /// stylistic default: without it, TrySetResult runs every awaiting
    /// continuation *inline*, on the callers's stack — see this class's own
    /// header comment for what that does to a modal page being popped from
    /// inside a WinUI event. Complete() additionally hops the TrySetResult
    /// itself onto a fresh main-thread turn, so the event handler has fully
    /// unwound before any of this resumes.</summary>
    private readonly TaskCompletionSource<string?> _selection = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>0 until the first selection/cancel/cancellation wins; set via
    /// Interlocked because cancellationToken.Register callbacks can arrive on
    /// any thread, unlike the two UI event handlers.</summary>
    private int _completed;

    public BleDevicePickerPage(IObservable<BleDeviceInfo> foundDevices)
    {
        InitializeComponent();
        BindingContext = this;

        // The scan subscription that produces foundDevices runs on whatever
        // thread Shiny's BLE callbacks land on, not necessarily the UI
        // thread — every Devices mutation has to happen on the UI thread
        // since DevicesList is bound to it.
        _subscription = foundDevices.Subscribe(device =>
        {
            MainThread.BeginInvokeOnMainThread(() =>
            {
                // A scan result can already be queued on the main thread at
                // the moment the user taps something. Adding it now would
                // mutate the CollectionView's ItemsSource while the page is
                // on its way out — the other half of the Windows teardown
                // crash described in this class's header comment.
                if (Volatile.Read(ref _completed) != 0)
                {
                    return;
                }

                if (!_seenIds.Add(device.Id))
                {
                    return; // already offered this one — Shiny's scan re-fires per advertisement, not just once per device
                }

                Devices.Add(device);
                OnPropertyChanged(nameof(IsEmpty));
            });
        });
    }

    /// <summary>
    /// Pushes this page modally onto <paramref name="hostPage"/>'s
    /// navigation stack, waits for a selection/cancellation, pops itself
    /// back off, and returns the chosen device's id (or null). The caller
    /// (BleDevicePicker) is expected to have already hopped to the UI
    /// thread before calling this, since PushModalAsync/PopModalAsync
    /// require it.
    /// </summary>
    public async Task<string?> WaitForSelectionAsync(Page hostPage, CancellationToken cancellationToken)
    {
        await hostPage.Navigation.PushModalAsync(this);

        string? result;
        using (cancellationToken.Register(() => Complete(null)))
        {
            // Resumes on a main-thread turn *after* whichever event handler
            // completed the selection has returned — see _selection's note.
            result = await _selection.Task;
        }

        _subscription.Dispose(); // idempotent — Complete() already did this

        try
        {
            // ModalStack check: the person can also dismiss a modal by
            // platform means (Esc/back on some targets), in which case this
            // page is already off the stack and PopModalAsync would pop
            // whatever is underneath it instead — or throw "modal stack is
            // currently empty" (dotnet/maui#29214).
            if (hostPage.Navigation.ModalStack.Contains(this))
            {
                await hostPage.Navigation.PopModalAsync();
            }
        }
        catch (Exception ex)
        {
            // Failing to dismiss the chooser must not become an unhandled
            // exception: this runs under BleRequestDevice, whose exceptions
            // HybridWebView does not marshal back to the JS caller
            // (dotnet/maui#27096) and which therefore end up in the same
            // WinUI unhandled-exception hook this class's header describes.
            // A stuck-open picker is recoverable; a debugger break / process
            // teardown isn't.
            System.Diagnostics.Debug.WriteLine($"[ble-picker] PopModalAsync failed: {ex}");
        }

        return result;
    }

    private void OnDeviceSelected(object? sender, SelectionChangedEventArgs e)
    {
        if (e.CurrentSelection.FirstOrDefault() is BleDeviceInfo device)
        {
            Complete(device.Id);
        }
    }

    private void OnCancelClicked(object? sender, EventArgs e) => Complete(null);

    /// <summary>Single funnel for "the picker is done" — first caller wins,
    /// every later one (a second SelectionChanged as the list unloads, a
    /// Cancel tap racing a selection, a fired cancellation token) is a
    /// no-op. Stops the scan feed immediately so nothing else touches the
    /// bound collection, then hands the result over on a fresh main-thread
    /// turn rather than on the current event's stack.</summary>
    private void Complete(string? deviceId)
    {
        if (Interlocked.Exchange(ref _completed, 1) != 0)
        {
            return;
        }

        _subscription.Dispose();
        MainThread.BeginInvokeOnMainThread(() => _selection.TrySetResult(deviceId));
    }
}
