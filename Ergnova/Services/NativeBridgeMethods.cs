// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using System.Collections.Concurrent;
using System.Reactive.Subjects;
using System.Text.Json;
using System.Text.Json.Serialization;
using CommunityToolkit.Maui.Storage;
using Microsoft.Maui.Devices;
using Shiny;
using Shiny.BluetoothLE;

namespace Ergnova.Services;

/// <summary>
/// The single object registered via <c>hybridWebView.SetInvokeJavaScriptTarget(this)</c>
/// (see MainPage.xaml.cs) — every public method here is callable from JS as
/// <c>window.HybridWebView.InvokeDotNet('MethodName', [args])</c>. Method
/// names and parameter order are load-bearing: they must match exactly what
/// web/public/native-shell-bridge.js calls. See that file's header comment
/// for the full contract this implements, which in turn matches what
/// web/src/ble/transport/native-bridge-backend.js expects on the JS side.
///
/// ── Honesty note on the Shiny.BluetoothLE calls below ───────────────────
/// I still can't compile or run this against a live SDK in the environment
/// that produced it (no .NET/MAUI/Shiny installed, no device to test
/// against, and NuGet is unreachable here). This was originally checked
/// against Shiny v3's docs; it's since been re-checked against the current
/// v5.x docs at shinylib.net/ble/{manager,peripheral,gatt} after
/// Ergnova.csproj's package pin moved from Version="3.*" to Version="5.*"
/// (that bump was to fix Windows BLE — see the csproj comment). Most of
/// this file's API usage turned out unchanged between v3 and v5 despite
/// the docs' own framing ("all GATT operations are performed directly on
/// IPeripheral... no need to dig through nested GATT objects") — that
/// shape is what this file already did. The concrete things that *did*
/// change or get corrected in that pass: Scan() calls now branch between
/// the parameterless open-scan form and Scan(new ScanConfig(uuid)) instead
/// of passing a possibly-null ScanConfig through one call (no confirmed
/// nullable-accepting overload in current docs); BleIsGattConnected now
/// compares peripheral.Status == ConnectionState.Connected instead of
/// calling a peripheral.IsConnected() extension method the current docs
/// never mention; and the redundant peripheral.Uuid.ToString() calls are
/// gone now that Uuid is confirmed to already be a string. Remaining
/// `// VERIFY:` / uncertainty notes mark spots only checked against docs,
/// not a real restore+build — confirm those on first restore. The *shape*
/// of this bridge (method names, the deviceId/charId scheme, the push-event
/// channel) is the part that's load-bearing and shouldn't need to change;
/// only the innards of each method calling into Shiny might.
///
/// Later pass: BleRequestDevice/MatchesAnyFilter and BleGattDisconnect were
/// revisited against the current shinylib.net/ble/manager and
/// shinylib.net/ble/peripheral pages — same "checked against docs, not a
/// real restore+build" caveat applies. Two things that page confirms which
/// the code previously treated as unknown/unavailable: ScanResult exposes
/// AdvertisementData.ServiceUuids (now used to actually verify a
/// serviceUuid filter client-side, see MatchesAnyFilter), and ScanConfig's
/// single-UUID constructor has no confirmed overload for more than one —
/// still no way to OS-filter a scan by two different service UUIDs at
/// once, hence BleRequestDevice now only takes that OS-filtered path when
/// every parsed filter agrees on one single UUID and falls back to an open
/// scan otherwise.
///
/// Still later pass: that AdvertisementData.ServiceUuids check turned out to
/// regress HR-strap discovery on-device (reported as the HR monitor no
/// longer showing up to connect at all) — see MatchesAnyFilter's and the new
/// NormalizeUuid()'s own VERIFY notes for the suspected mechanism (a
/// short-form-vs-128-bit-form mismatch between filter.ServiceUuid and
/// whatever a given platform's Shiny binding actually returns) and the fix.
/// Confirmed-on-a-real-device status: not yet — this is the leading theory,
/// reasoned from the two platforms' known UUID conventions, not a
/// reproduced-and-fixed report.
///
/// One more pass: an actual on-device stack trace came back showing the real
/// break was elsewhere — System.InvalidOperationException, "There is already
/// an active scan", thrown synchronously out of _ble.Scan().Subscribe(...) at
/// what's now BleRequestDevice's own scan-start line, every single time,
/// regardless of device type. Root cause: Shiny's BleManager only tolerates
/// one active Scan() subscription app-wide, and BleWatchAdvertisements
/// already has one running (_watchScan) for every remembered device from the
/// moment ble/reconnect.js's reconnect.start() fires on app launch — so
/// BleRequestDevice's own _ble.Scan() call was always going to collide with
/// it once there was anything remembered at all, independent of the
/// NormalizeUuid theory above (that theory isn't necessarily wrong, just
/// untestable until this crash stopped masking it — confirm HRM discovery
/// separately now that this is fixed). Fix: BleRequestDevice now disposes
/// _watchScan before starting its own scan and hands the slot back via the
/// new EnsureWatchScanRunning() in its finally block — see that method and
/// BleRequestDevice's own comment at the dispose call. Still unconfirmed
/// against a live build beyond the log excerpt that motivated it.</summary>
public sealed class NativeBridgeMethods
{
    private readonly IBleManager _ble;
    private readonly Action<string> _sendRawMessage;
    private readonly IBleDevicePicker _devicePicker;
    private readonly IBackgroundSessionService _backgroundSession;
    private readonly IPrintService _printService;
    private readonly HybridWebView _webView;

    private readonly Dictionary<string, IPeripheral> _peripheralsByDeviceId = new();
    private readonly Dictionary<string, (string DeviceId, string ServiceUuid, string CharUuid)> _charsByCharId = new();
    private readonly Dictionary<string, IDisposable> _notifySubscriptions = new();
    private readonly Dictionary<string, IDisposable> _connectionWatchers = new();
    private IDisposable? _activeScan;

    // Devices currently being watched for BleWatchAdvertisements, and the
    // single shared scan subscription serving all of them — see that
    // method's own doc comment.
    private readonly HashSet<string> _watchedDeviceIds = new();
    private IDisposable? _watchScan;

    public NativeBridgeMethods(IBleManager ble, Action<string> sendRawMessage, IBleDevicePicker devicePicker, IBackgroundSessionService backgroundSession, IPrintService printService, HybridWebView webView)
    {
        _ble = ble;
        _sendRawMessage = sendRawMessage;
        _devicePicker = devicePicker;
        _backgroundSession = backgroundSession;
        _printService = printService;
        _webView = webView;

        // Notification Pause / Play taps travel the other way from every
        // Background* method below: the OS calls into C#, and this pushes it up
        // to JS (see DispatchBackgroundAction). Latest registration wins, so a
        // recreated MainPage replaces this one's handler rather than stacking.
        _backgroundSession.SetActionHandler(DispatchBackgroundAction);
    }

    // ── BLE ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Shows a real, cross-platform device-chooser (Controls/BleDevicePickerPage,
    /// via the injected IBleDevicePicker — see that interface's and
    /// BleDevicePicker's own doc comments for why it's a modal page rather
    /// than a CommunityToolkit.Maui Popup) so the user picks among live scan
    /// results, standing in for Web Bluetooth's own native device-chooser
    /// dialog. This used to silently auto-pick whichever matching device
    /// turned up first — fine only as long as at most one matching device
    /// was ever in range at a time, which stops being true the moment
    /// there's more than one of the same trainer/HR-strap/scale nearby (a
    /// shared gym, a house with two riders, etc).
    ///
    /// Note on "I only see a chooser dialog on Windows": that dialog is
    /// real Web Bluetooth's own OS-native chooser, shown by an actual
    /// browser tab (e.g. `npm run dev` opened in Edge/Chrome) — see
    /// ble/transport/index.js's resolution-order comment. Every *packaged*
    /// MAUI build — Windows included — goes through this bridge method
    /// instead, because window.__ergnovaNativeBLE is injected identically
    /// on all four MAUI targets (native-shell-bridge.js's own header
    /// comment: it fires whenever window.HybridWebView exists, which is
    /// true for the Windows app just as much as Android/iOS/Mac Catalyst).
    /// There was no dialog at all on any packaged target before this
    /// method changed — not "every platform but Windows had one".
    /// </summary>
    /// <remarks>Returns null — rather than throwing — when the person backs
    /// out of the picker. HybridWebView doesn't marshal a thrown C# exception
    /// back to the JS caller as a rejected promise (dotnet/maui#27096); on
    /// Windows it escapes into the generated App.g.i.cs unhandled-exception
    /// hook instead, i.e. a debugger break rather than a catchable error.
    /// native-shell-bridge.js's requestDevice() turns this null back into the
    /// NotFoundError rejection real Web Bluetooth raises on cancel, so the
    /// Promise&lt;{id, name}&gt; contract the JS side is written against is
    /// unchanged.</remarks>
    public async Task<BleDeviceInfo?> BleRequestDevice(string optionsJson)
    {
        // Was missing entirely. On Android 12+, declaring BLUETOOTH_SCAN/
        // BLUETOOTH_CONNECT in AndroidManifest.xml only lets the app request
        // them — it does NOT itself trigger the runtime permission prompt.
        // RequestAccessAsync() is the call that actually shows that system
        // dialog (and checks the adapter is on) — see "Requesting Access" at
        // https://shinylib.net/ble/manager. Without it, Android silently
        // denies Scan()/ConnectAsync() with no prompt ever appearing, which
        // is indistinguishable from the device just not being found.
        var access = await _ble.RequestAccessAsync();
        if (access != AccessState.Available)
        {
            throw new InvalidOperationException(
                $"Bluetooth isn't available (status: {access}). Make sure Bluetooth is turned " +
                "on and this app has the Nearby Devices permission in Android Settings, then try again.");
        }

        var filters = ParseFilters(optionsJson);

        // Only usable as an OS-level ScanConfig narrowing when EVERY filter
        // is that exact same single service UUID with no namePrefix
        // attached — ScanConfig(uuid) (confirmed against shinylib.net/
        // ble/manager's "Filtered Scan" section) only ever narrows by one
        // UUID, and the OS/radio-level filtering it does happens *before*
        // MatchesAnyFilter ever sees a result, so any filter this scan
        // config doesn't itself satisfy would silently never reach the
        // picker at all — not just go unverified client-side.
        //
        // This used to just take filters[0]'s service UUID
        // (filters.FirstOrDefault(f => f.ServiceUuid != null)?.ServiceUuid)
        // and scope the whole scan to it, which quietly broke two callers
        // that OR multiple criteria together: scale-device.js's chooser
        // offers Body Composition Service (0x181B) OR Weight Scale Service
        // (0x181D) for scales that only implement one of the two — scoping
        // the scan to 0x181B alone meant a weight-only scale (0x181D, no
        // composition service) never appeared in results, full stop,
        // regardless of MatchesAnyFilter's own logic below. app.js's
        // connectController() has the same shape the other way around —
        // FTMS_SERVICE OR'd with two namePrefix-only filters (Merach,
        // Proform) — where scoping to FTMS_SERVICE alone meant neither of
        // those bikes, identified purely by name and not FTMS, could ever
        // show up either.
        var distinctServiceUuids = filters
            .Where(f => f.ServiceUuid != null)
            .Select(f => f.ServiceUuid!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        bool canUseOsFilter = distinctServiceUuids.Count == 1 && filters.All(f => f.ServiceUuid != null && f.NamePrefix is null);
        // Confirmed against shinylib.net/ble/manager: there's a parameterless
        // Scan() for an open scan and a Scan(new ScanConfig(uuid)) for a
        // filtered one — no confirmed Scan(ScanConfig?) overload taking null
        // for "open", so branch rather than pass a possibly-null ScanConfig
        // through a single call.
        var scanConfig = canUseOsFilter ? new ScanConfig(distinctServiceUuids[0]) : null;

        // ConcurrentDictionary: written from whatever thread Shiny's scan
        // callback runs on, read from the UI thread once the picker
        // resolves — plain Dictionary isn't safe across that hand-off.
        var seenPeripherals = new ConcurrentDictionary<string, IPeripheral>();
        var discovered = new Subject<BleDeviceInfo>();

        // Shiny's BleManager only tolerates one active Scan() subscription at
        // a time — a second concurrent Scan() call throws synchronously
        // ("There is already an active scan") rather than queuing or
        // merging with the first. ble/reconnect.js's reconnect.start() calls
        // BleWatchAdvertisements for every remembered device on every app
        // launch (see that method's own doc comment), so _watchScan is
        // already running by the time the person opens ANY connect picker —
        // deterministically, regardless of which device type they're adding,
        // which is exactly the "breaks right when I click connect, for any
        // device" symptom this was reported as. Pausing the watch-scan for
        // the duration of this picker session (and restarting it in the
        // finally block below, via EnsureWatchScanRunning — see that
        // method) frees up the one scan slot Shiny allows without
        // permanently losing remembered-device auto-reconnect; a rider
        // mid-pairing isn't relying on background auto-reconnect anyway.
        _watchScan?.Dispose();
        _watchScan = null;

        var scan = scanConfig is null ? _ble.Scan() : _ble.Scan(scanConfig);
        _activeScan = scan.Subscribe(scanResult =>
        {
            try
            {
                var peripheral = scanResult.Peripheral;
                var id = peripheral.Uuid; // confirmed string on IPeripheral, shinylib.net/ble/peripheral
                if (seenPeripherals.ContainsKey(id)) return; // already offered this one — Scan() re-fires per advertisement
                // AdvertisementData.ServiceUuids is confirmed exposed on ScanResult
                // (shinylib.net/ble/manager's own Open Scan example reads it) —
                // the previous "can't verify a serviceUuid filter client-side"
                // limitation MatchesAnyFilter's doc comment used to note no
                // longer holds; see that method for how this is used now.
                // VERIFY: the docs example doesn't pin the property's exact element
                // type — assumed string (matching IPeripheral.Uuid's own confirmed
                // string type and what ScanConfig's constructor and this class's
                // deviceId/charId scheme already take everywhere else). If it
                // resolves as a Guid collection instead, this needs a .ToString()
                // (or equivalent) added when reading it here.
                if (!MatchesAnyFilter(peripheral, scanResult.AdvertisementData?.ServiceUuids, filters)) return;

                seenPeripherals[id] = peripheral;
                discovered.OnNext(new BleDeviceInfo { Id = id, Name = peripheral.Name });
            }
            catch (Exception ex)
            {
                // A single malformed/unexpected advertisement — from ANY nearby
                // peripheral, not just the one the user is trying to connect,
                // since this callback fires for everything Scan() sees — must
                // not take the whole picker session down with it. This was
                // previously safe by omission (MatchesAnyFilter never actually
                // touched ServiceUuids' contents, just assumed a service-only
                // filter satisfied), so nothing here was ever exercised against
                // real, messy advertisement data before now. Defensive guard
                // only — the actual "breaks for every device type" report
                // turned out to be the separate already-active-scan bug fixed
                // above, not this; kept anyway since real nearby BLE traffic
                // can still be malformed in ways worth not crashing over.
                System.Diagnostics.Debug.WriteLine($"[BLE] Skipping unparseable scan result: {ex.Message}");
            }
        });

        try
        {
            // Deliberately no fixed timeout here (the old 15-second one made
            // sense for a silent "grab the first match" wait, not for an
            // interactive chooser the user should be able to leave open as
            // long as they need — same as Web Bluetooth's own real chooser).
            // cancellationToken.None is fine: the picker page itself is what
            // lets the user back out via its Cancel button.
            var pickedId = await _devicePicker.PickDeviceAsync(discovered, CancellationToken.None);
            if (pickedId is null || !seenPeripherals.TryGetValue(pickedId, out var picked))
            {
                return null; // see this method's <remarks> — JS turns this into a NotFoundError
            }
            return RegisterPeripheral(picked);
        }
        finally
        {
            _activeScan?.Dispose();
            _activeScan = null;
            discovered.OnCompleted();
            // Hand the one scan slot back to remembered-device auto-reconnect
            // now that this picker session is over — see this method's own
            // comment above on why it was paused. A no-op if nothing's
            // remembered/watched right now (EnsureWatchScanRunning checks
            // _watchedDeviceIds.Count itself).
            EnsureWatchScanRunning();
        }
    }

    /// <summary>
    /// Union of this session's already-known peripherals
    /// (_peripheralsByDeviceId — populated by BleRequestDevice and
    /// BleWatchAdvertisements) and every device PairedDeviceStore has
    /// persisted from a past successful BleGattConnect (see that method),
    /// so ble/reconnect.js's reconnect.start() has something to call
    /// watchAdvertisements() on right after a cold start too — not just
    /// within whatever session first paired the device, which was this
    /// method's previous (documented) limitation. A device known only from
    /// the persisted store — nothing seen yet this session — is still
    /// returned with just an id/name; it has no live IPeripheral behind it
    /// until a scan actually turns it up again, which is exactly what
    /// BleWatchAdvertisements does next.
    /// </summary>
    public Task<BleDeviceInfo[]> BleGetDevices()
    {
        var byId = new Dictionary<string, BleDeviceInfo>();

        foreach (var (id, name) in PairedDeviceStore.Load())
        {
            byId[id] = new BleDeviceInfo { Id = id, Name = name };
        }

        // Session-known peripherals win on name if both exist — a live
        // IPeripheral.Name reading is more current than whatever was
        // persisted at last connect.
        foreach (var (id, peripheral) in _peripheralsByDeviceId)
        {
            byId[id] = new BleDeviceInfo { Id = id, Name = peripheral.Name };
        }

        return Task.FromResult(byId.Values.ToArray());
    }

    public async Task BleGattConnect(string deviceId)
    {
        var peripheral = RequirePeripheral(deviceId);
        // Confirmed against shinylib.net/ble/peripheral: ConnectAsync(cancelToken:, timeout:),
        // both optional, so the zero-arg call is fine.
        await peripheral.ConnectAsync();

        // Persist so a cold-started app's BleGetDevices()/BleWatchAdvertisements
        // (see those methods) can still offer and re-find this device next
        // launch — see PairedDeviceStore's own doc comment for why this
        // needed adding. A successful GATT connect is this bridge's
        // equivalent of Web Bluetooth's implicit "user granted persistent
        // permission to this device" moment.
        PairedDeviceStore.Remember(deviceId, peripheral.Name);

        if (!_connectionWatchers.ContainsKey(deviceId))
        {
            // Confirmed against shinylib.net/ble/peripheral: WhenStatusChanged()
            // emits ConnectionState.{Connecting,Connected,Disconnecting,Disconnected}.
            _connectionWatchers[deviceId] = peripheral.WhenStatusChanged().Subscribe(status =>
            {
                if (status == ConnectionState.Disconnected || status == ConnectionState.Disconnecting)
                {
                    DispatchBle("gattserverdisconnected", new { deviceId });
                }
            });
        }
    }

    /// <summary>
    /// A real disconnect needs to also drop this device's own NotifyCharacteristic
    /// subscriptions, not just cancel the connection — BleStartNotifications's own
    /// doc comment notes that observable "auto-reconnects across drops as long as
    /// the subscription stays hooked", which is precisely what a *manual* disconnect
    /// must not leave happening. Left unhandled, this was why a rider disconnecting,
    /// say, the HR strap or trainer from the app's own UI could still see it quietly
    /// reconnect moments later: CancelConnection() drops the GATT link, but Shiny
    /// treats that exactly like any other drop a still-subscribed notify observable
    /// exists to recover from, and reconnects underneath the app with no JS-visible
    /// event. Disposing the subscriptions here first means CancelConnection() is
    /// actually final — the device only comes back when something (the reconnect.js
    /// watch, or a fresh BleGattConnect) explicitly reconnects it, which is what
    /// ble/reconnect.js's pause()/resume() (see that file) now relies on to keep a
    /// manually-disconnected device from hooking back on its own.
    /// </summary>
    public Task BleGattDisconnect(string deviceId)
    {
        var peripheral = RequirePeripheral(deviceId);
        if (_connectionWatchers.Remove(deviceId, out var watcher)) watcher.Dispose();

        // _charsByCharId is keyed by a composite "deviceId|serviceUuid|charUuid"
        // id (see BleGetCharacteristic) with the real deviceId stored alongside
        // it in the tuple — filtering by that rather than parsing the composite
        // key string back apart.
        foreach (var charId in _charsByCharId
            .Where(kv => kv.Value.DeviceId == deviceId)
            .Select(kv => kv.Key)
            .ToList()) // snapshot first — disposing below doesn't mutate this dictionary, but ToList keeps the intent explicit and safe against future changes
        {
            if (_notifySubscriptions.Remove(charId, out var sub)) sub.Dispose();
        }

        peripheral.CancelConnection(); // confirmed against shinylib.net/ble/peripheral's "Disconnecting" section
        return Task.CompletedTask;
    }

    /// <summary>Exists for parity/diagnostics — the JS side deliberately does NOT call this remotely (a round
    /// trip is always async; native-bridge-backend.js's `connected` getter needs a synchronous answer, so
    /// native-shell-bridge.js tracks connected-device IDs locally instead). See that file's comment.
    ///
    /// shinylib.net/ble/peripheral's IPeripheral property table lists Status (ConnectionState), not an
    /// IsConnected() method — the docs never mention that name, so this compares Status directly instead
    /// of gambling on an extension method that may not exist.</summary>
    public Task<bool> BleIsGattConnected(string deviceId) =>
        Task.FromResult(_peripheralsByDeviceId.TryGetValue(deviceId, out var p) && p.Status == ConnectionState.Connected);

    /// <summary>Shiny's GetCharacteristic/ReadCharacteristic/WriteCharacteristic calls take the service UUID
    /// directly — there's no separate "fetch the service object first" round trip the way raw GATT has one.
    /// So this is a validating passthrough (deviceId must be known, serviceUuid is just handed back) rather than
    /// a real native call, existing only so this bridge's shape matches native-bridge-backend.js's
    /// Device -> gatt -> Service -> Characteristic chain without that file needing to know Shiny collapses two
    /// of those steps into one.</summary>
    public Task<BleServiceInfo> BleGetPrimaryService(string deviceId, string serviceUuid)
    {
        RequirePeripheral(deviceId); // throws if unknown, same failure mode a real lookup would have
        return Task.FromResult(new BleServiceInfo { ServiceId = serviceUuid });
    }

    public async Task<BleCharacteristicInfo> BleGetCharacteristic(string deviceId, string serviceId, string charUuid)
    {
        var peripheral = RequirePeripheral(deviceId);
        // Confirmed against shinylib.net/ble/gatt ("Checking Characteristic Properties"):
        // GetCharacteristicAsync(serviceUuid, characteristicUuid) -> Task<BleCharacteristicInfo>, unchanged
        // from the v3 shape this was originally written against.
        await peripheral.GetCharacteristicAsync(serviceId, charUuid);

        var charId = $"{deviceId}|{serviceId}|{charUuid}";
        _charsByCharId[charId] = (deviceId, serviceId, charUuid);
        return new BleCharacteristicInfo { CharId = charId };
    }

    public async Task BleWriteValue(string deviceId, string charId, int[] bytes, bool withResponse)
    {
        var (_, serviceUuid, charUuid) = RequireChar(charId);
        var peripheral = RequirePeripheral(deviceId);
        var payload = bytes.Select(b => (byte)b).ToArray();
        // Confirmed against shinylib.net/ble/gatt ("Writing"): the reactive WriteCharacteristic overload takes
        // withResponse as a plain named bool, and the docs' own WriteCharacteristicAsync example omits it only
        // because it's relying on the same parameter defaulting to true — still not restore+build-verified that
        // WriteCharacteristicAsync's positional order matches this call exactly (see this file's header note).
        await peripheral.WriteCharacteristicAsync(serviceUuid, charUuid, payload, withResponse);
    }

    public async Task<int[]> BleReadValue(string deviceId, string charId)
    {
        var (_, serviceUuid, charUuid) = RequireChar(charId);
        var peripheral = RequirePeripheral(deviceId);
        var result = await peripheral.ReadCharacteristicAsync(serviceUuid, charUuid);
        // Confirmed byte-payload property name: BleCharacteristicResult.Data, still nullable
        // (per shinylib.net/ble/gatt's "Reading" section), hence the `?? []` guard.
        return (result.Data ?? []).Select(b => (int)b).ToArray();
    }

    public Task BleStartNotifications(string deviceId, string charId)
    {
        if (_notifySubscriptions.ContainsKey(charId)) return Task.CompletedTask; // already subscribed

        var (_, serviceUuid, charUuid) = RequireChar(charId);
        var peripheral = RequirePeripheral(deviceId);
        // Confirmed against shinylib.net/ble/gatt ("Notifications"): NotifyCharacteristic(serviceUuid, charUuid)
        // returns a long-lived IObservable that fires on every value change and auto-reconnects across drops
        // as long as the subscription stays hooked — this stays reactive (.Subscribe) rather than the XxxAsync
        // one-shot methods used above, since there's no single result to await here.
        _notifySubscriptions[charId] = peripheral.NotifyCharacteristic(serviceUuid, charUuid).Subscribe(result =>
        {
            DispatchBle("characteristicvaluechanged", new
            {
                deviceId,
                charId,
                value = (result.Data ?? []).Select(b => (int)b).ToArray(),
            });
        });
        return Task.CompletedTask;
    }

    /// <summary>
    /// Real implementation — previously a documented no-op (this app's own
    /// *-device.js wrappers don't call it directly, but ble/reconnect.js's
    /// reconnect.start() does, for every remembered device, on every app
    /// launch; a no-op here silently broke that whole auto-reconnect flow
    /// on native builds, which is the other half of "on first connect the
    /// user can pick, but when it's paired, it can auto connect" alongside
    /// BleRequestDevice's new picker).
    ///
    /// Starts (or joins, if another device is already being watched) a
    /// single shared open scan via EnsureWatchScanRunning() — see that
    /// method for the actual scan/subscription logic, split out so
    /// BleRequestDevice can also call it to resume watching after it
    /// borrows the radio's one scan slot for its own picker session.
    /// </summary>
    public Task BleWatchAdvertisements(string deviceId)
    {
        _watchedDeviceIds.Add(deviceId);
        EnsureWatchScanRunning();
        return Task.CompletedTask;
    }

    public Task BleStopWatchingAdvertisements(string deviceId)
    {
        _watchedDeviceIds.Remove(deviceId);
        if (_watchedDeviceIds.Count == 0)
        {
            _watchScan?.Dispose();
            _watchScan = null;
        }
        return Task.CompletedTask;
    }

    /// <summary>
    /// (Re)starts the shared watch-scan for every currently-watched device id, if it isn't
    /// already running. Idempotent — a no-op when _watchScan is already active, or when
    /// there's nothing in _watchedDeviceIds to watch (e.g. right after BleRequestDevice's
    /// finally block resumes watching but nothing was ever remembered). Called from
    /// BleWatchAdvertisements when a new device is added to watch, and from
    /// BleRequestDevice's finally block to hand the radio's one scan slot back once a
    /// picker session ends (see that method's own comment on why it takes the slot away
    /// in the first place — Shiny only tolerates one active Scan() at a time).
    /// </summary>
    private void EnsureWatchScanRunning()
    {
        if (_watchScan is not null || _watchedDeviceIds.Count == 0) return;

        // Captured into a local first, then assigned to _watchScan after
        // Subscribe returns — if a scan result arrived synchronously (it
        // won't, in practice, for BLE scanning, but this avoids depending
        // on that), the callback below could otherwise see _watchScan as
        // still null on its very first run.
        IDisposable? subscription = null;
        // Open/unfiltered scan — confirmed against shinylib.net/ble/manager's
        // "Open Scan" section as the parameterless Scan() form (see
        // BleRequestDevice's own scan call for why this doesn't pass a
        // null ScanConfig instead). No single service UUID to narrow by
        // here anyway: watched devices can be for entirely different
        // services (a trainer + a HR strap + a scale, all remembered at
        // once).
        subscription = _ble.Scan().Subscribe(scanResult =>
        {
            var peripheral = scanResult.Peripheral;
            var id = peripheral.Uuid; // confirmed string on IPeripheral, shinylib.net/ble/peripheral
            if (!_watchedDeviceIds.Remove(id)) return; // not one we're watching; Remove doubles as "is it, and stop watching it if so"

            _peripheralsByDeviceId[id] = peripheral; // so the JS side's immediately-following gatt.connect() -> BleGattConnect(id) resolves
            DispatchBle("advertisementreceived", new { deviceId = id });

            if (_watchedDeviceIds.Count == 0)
            {
                subscription?.Dispose();
                _watchScan = null;
            }
        });
        _watchScan = subscription;
    }

    private void DispatchBle(string type, object detail)
    {
        var envelope = JsonSerializer.Serialize(new { channel = "ble", type, detail });
        _sendRawMessage(envelope);
    }

    /// <summary>Pushes a notification button tap ("pause" | "play" — see
    /// BackgroundActions) up to JS on the same raw-message pipe DispatchBle
    /// uses, on its own "background" channel; native-shell-bridge.js routes it
    /// to background-session.js. The workout lives in the page, so the page
    /// decides what the tap does — nothing is toggled natively.</summary>
    private void DispatchBackgroundAction(string action)
    {
        var envelope = JsonSerializer.Serialize(new { channel = "background", type = "action", detail = new { action } });
        _sendRawMessage(envelope);
    }

    private BleDeviceInfo RegisterPeripheral(IPeripheral peripheral)
    {
        var id = peripheral.Uuid; // confirmed string on IPeripheral, shinylib.net/ble/peripheral
        _peripheralsByDeviceId[id] = peripheral;
        return new BleDeviceInfo { Id = id, Name = peripheral.Name };
    }

    private IPeripheral RequirePeripheral(string deviceId) =>
        _peripheralsByDeviceId.TryGetValue(deviceId, out var p)
            ? p
            : throw new InvalidOperationException($"Unknown BLE device id '{deviceId}' — was BleRequestDevice called first?");

    private (string DeviceId, string ServiceUuid, string CharUuid) RequireChar(string charId) =>
        _charsByCharId.TryGetValue(charId, out var c)
            ? c
            : throw new InvalidOperationException($"Unknown BLE characteristic id '{charId}' — was BleGetCharacteristic called first?");

    /// <summary>One entry from `options.filters[]` (navigator.bluetooth.requestDevice's options shape) —
    /// either or both of its service-UUID and name-prefix criteria, whichever were present.</summary>
    private sealed record RequestFilter(string? ServiceUuid, string? NamePrefix);

    /// <summary>Best-effort extraction of every entry in `options.filters[]` from the JSON options object
    /// requestDevice() was called with. Replaces the old ExtractFirstServiceUuid, which only ever looked at
    /// filters[0].services[0] — that undersold what BleRequestDevice's new picker can actually narrow by, since
    /// several *-device.js wrappers (merach-device.js, proform-device.js, fitdays-device.js) filter by
    /// `namePrefix`, not `services`, and scale-device.js supplies two separate services filters (OR'd). Falls
    /// back to an empty list (open scan, unfiltered picker) for any shape it doesn't recognize rather than
    /// throwing, matching the old method's own fallback behavior.</summary>
    private static List<RequestFilter> ParseFilters(string optionsJson)
    {
        var filters = new List<RequestFilter>();
        try
        {
            using var doc = JsonDocument.Parse(optionsJson);
            if (doc.RootElement.TryGetProperty("filters", out var filtersEl) && filtersEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in filtersEl.EnumerateArray())
                {
                    string? serviceUuid = null;
                    if (entry.TryGetProperty("services", out var services) &&
                        services.ValueKind == JsonValueKind.Array && services.GetArrayLength() > 0)
                    {
                        var uuid = services[0];
                        // The *-device.js files declare 16-bit service UUIDs as raw
                        // numbers (ftms-constants.js's FTMS_SERVICE = 0x1826, etc.).
                        // native-shell-bridge.js is supposed to convert those to
                        // Shiny's expected 4-hex-digit short form ("1826") before
                        // JSON.stringify ever produces this payload — but handling
                        // Number here too, rather than assuming every caller does
                        // that and calling the String-only GetString() unconditionally,
                        // means a value that slips through un-normalized degrades to
                        // an unfiltered entry instead of throwing.
                        serviceUuid = uuid.ValueKind switch
                        {
                            JsonValueKind.String => uuid.GetString(),
                            JsonValueKind.Number => uuid.GetUInt32().ToString("x4"),
                            _ => null,
                        };
                    }

                    string? namePrefix = entry.TryGetProperty("namePrefix", out var np) && np.ValueKind == JsonValueKind.String
                        ? np.GetString()
                        : null;

                    if (serviceUuid != null || namePrefix != null)
                    {
                        filters.Add(new RequestFilter(serviceUuid, namePrefix));
                    }
                }
            }
        }
        catch (JsonException)
        {
            // fall through to an empty filter list — open scan, unfiltered picker
        }
        return filters;
    }

    /// <summary>Client-side accept test for a scan result against every parsed filter (OR'd, same as Web
    /// Bluetooth's own filters[] semantics: each filter's own criteria are AND'd together, and a peripheral
    /// need only satisfy one filter in the array) — used by BleRequestDevice to decide whether to offer a
    /// given peripheral in the picker at all.
    ///
    /// A namePrefix criterion is checked against the peripheral's advertised name. A serviceUuid criterion is
    /// checked against this scan result's own advertised service UUIDs (confirmed exposed via
    /// ScanResult.AdvertisementData.ServiceUuids — see BleRequestDevice's own comment; this used to be
    /// unverifiable and was treated as satisfied by definition, which is no longer necessary or correct now
    /// that it's confirmed available). A filter that specifies both criteria needs both to hold — same
    /// AND-within-a-filter semantics real Web Bluetooth's filters[] has.
    ///
    /// VERIFY: the service-UUID comparison goes through NormalizeUuid() rather than a raw string compare —
    /// filter.ServiceUuid is always the short 4-hex form (see ParseFilters), but which form a given platform's
    /// Shiny binding puts in AdvertisementData.ServiceUuids isn't confirmed and may not be consistent: iOS's
    /// CBUUID.UUIDString gives the short form back for 16/32-bit UUIDs, while Android's ParcelUuid.ToString()
    /// expands them to the full 128-bit Bluetooth Base UUID. A raw string.Equals() between those two shapes
    /// silently fails and drops the peripheral from the picker — this is suspected to be exactly what broke
    /// HR-strap discovery specifically, since HrDevice's filter is service-only with no namePrefix to fall
    /// back on. Normalizing both sides to the long form first should make this equality format-agnostic
    /// regardless of which shape a given platform actually returns; I don't have a device or compiler here to
    /// confirm this against a real scan result, so treat this as the leading theory rather than a confirmed fix.</summary>
    private static bool MatchesAnyFilter(IPeripheral peripheral, IReadOnlyList<string>? advertisedServiceUuids, List<RequestFilter> filters)
    {
        if (filters.Count == 0) return true;

        foreach (var filter in filters)
        {
            bool nameOk = filter.NamePrefix is null ||
                (peripheral.Name?.StartsWith(filter.NamePrefix, StringComparison.OrdinalIgnoreCase) ?? false);
            bool serviceOk;
            if (filter.ServiceUuid is null)
            {
                serviceOk = true;
            }
            else
            {
                // Guard against NormalizeUuid's null/blank input both mapping to
                // "" (see its own doc comment) — that must never itself count as
                // a match, or a malformed advertised entry would spuriously
                // satisfy a real filter.
                var normalizedFilterUuid = NormalizeUuid(filter.ServiceUuid);
                serviceOk = normalizedFilterUuid.Length > 0 &&
                    (advertisedServiceUuids?.Any(u => NormalizeUuid(u) == normalizedFilterUuid) ?? false);
            }
            if (nameOk && serviceOk) return true;
        }
        return false;
    }

    /// <summary>Expands a short 16-bit/32-bit BLE-assigned UUID ("180d") to the full 128-bit Bluetooth Base
    /// UUID form ("0000180d-0000-1000-8000-00805f9b34fb"), so MatchesAnyFilter can compare a filter's UUID
    /// against an advertised UUID without caring which of the two shapes either one happens to be in. An
    /// input that's already long-form (has dashes) is just lowercased and passed through. See MatchesAnyFilter's
    /// own VERIFY note above — this is the fix's actual mechanism, not confirmed against a real scan result.
    ///
    /// Null/empty-safe on purpose: this now runs against every advertised UUID from every nearby peripheral a
    /// scan sees (see BleRequestDevice's Subscribe callback), not just from devices the filters actually care
    /// about — real, messy nearby BLE traffic is why a bare uuid.Trim() here isn't safe to assume never sees
    /// null or garbage, which the try/catch around that callback backs up but shouldn't be the only guard.</summary>
    private static string NormalizeUuid(string? uuid)
    {
        if (string.IsNullOrWhiteSpace(uuid)) return string.Empty;
        uuid = uuid.Trim();
        bool isShortForm = uuid.Length is > 0 and <= 8 && uuid.All(Uri.IsHexDigit);
        return isShortForm
            ? $"{uuid.PadLeft(8, '0').ToLowerInvariant()}-0000-1000-8000-00805f9b34fb"
            : uuid.ToLowerInvariant();
    }

    // ── File save/export bridge (checklist §7) ──────────────────────────

    /// <summary>Backs window.__ergnovaNativeFile.saveBlob(...) — the export-only half of §7 (see that JS
    /// file's comment for why import via &lt;input type="file"&gt; isn't bridged here). Routes through
    /// CommunityToolkit.Maui's FileSaver, which gives a real native save/share-sheet flow on all four
    /// targets instead of hand-rolling one per platform.</summary>
    /// <remarks>FileSaver shows a native save picker / share sheet, which has to be launched from the UI
    /// thread (the WinUI file picker in particular needs the window's dispatcher). InvokeDotNet doesn't
    /// promise which thread a bridge method arrives on — the same reason WakeLockAcquire below hops
    /// explicitly — so hop here rather than trusting the caller. Returns false when the person cancels or
    /// the platform save fails, so the JS side's saveFile() resolves false instead of rejecting.</remarks>
    public async Task<bool> FileSaveBlob(string filename, string base64Data, string mimeType)
    {
        var bytes = Convert.FromBase64String(base64Data);
        return await MainThread.InvokeOnMainThreadAsync(async () =>
        {
            using var stream = new MemoryStream(bytes);
            var result = await FileSaver.Default.SaveAsync(filename, stream, CancellationToken.None);
            if (!result.IsSuccessful)
                System.Diagnostics.Debug.WriteLine($"[file-save] '{filename}' was not saved: {result.Exception?.Message ?? "cancelled"}");
            return result.IsSuccessful;
        });
    }

    /// <summary>Backs window.__ergnovaNativeFile.pickText() (web/src/platform/pick-file.js) — the import
    /// direction of §7, used by History's Import. Shows MAUI's native FilePicker (every file type: MIME types
    /// for .json vary too much between Android document providers to filter on) and returns the chosen file's
    /// name and its contents as UTF-8 text, or null if the person cancels.</summary>
    /// <remarks>Same UI-thread hop as FileSaveBlob above, for the same reason. Every failure path returns null
    /// rather than throwing: exceptions from a bridge method aren't marshalled back to the JS caller
    /// (dotnet/maui#27096), so one escaping here would surface as an unhandled exception instead of the JS side
    /// treating it as a cancelled pick.</remarks>
    public async Task<PickedFileInfo?> FilePickText()
    {
        return await MainThread.InvokeOnMainThreadAsync<PickedFileInfo?>(async () =>
        {
            try
            {
                var file = await global::Microsoft.Maui.Storage.FilePicker.Default.PickAsync(
                    new global::Microsoft.Maui.Storage.PickOptions { PickerTitle = "Choose a file to import" });
                if (file is null) return null; // cancelled

                using var stream = await file.OpenReadAsync();
                using var reader = new StreamReader(stream);
                return new PickedFileInfo { Name = file.FileName, Text = await reader.ReadToEndAsync() };
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[file-pick] failed: {ex}");
                return null;
            }
        });
    }

    // ── Print bridge (window.__ergnovaNativePrint) ───────────────────────

    /// <summary>Backs window.__ergnovaNativePrint.printPage(jobName, html) (web/src/platform/print.js). With
    /// a non-empty <paramref name="html"/> — a complete standalone document from web/src/platform/
    /// print-document.js — Android and iOS / Mac Catalyst print that document rather than the live,
    /// dark-themed page (which printed as an empty page in app colors there). With empty html, and always
    /// on Windows, the HybridWebView's live page goes to the platform print flow. See IPrintService for the
    /// full picture and what "true" promises. Both parameters are always sent by native-shell-bridge.js
    /// (html as "" when absent): InvokeDotNet matches the JSON args array to this parameter list by count.</summary>
    public Task<bool> PrintCurrentPage(string jobName, string html) => _printService.PrintAsync(_webView, jobName, html);

    // ── Background session bridge (window.__ergnovaNativeBackground) ────
    //
    // Thin passthrough to whichever IBackgroundSessionService MauiProgram.cs
    // registered for this platform (AndroidBackgroundSessionService, or
    // UnsupportedBackgroundSessionService everywhere else — see that
    // interface's own doc comment). Snapshot objects cross as a JSON string
    // rather than individual params, same reasoning as BleRequestDevice's
    // optionsJson above: BackgroundSnapshot has five fields and native-shell-
    // bridge.js already has the object in hand from background-session.js's
    // sync() call, so JSON.stringify-ing it once is simpler than a five-
    // positional-argument InvokeDotNet call on the JS side.

    public Task<BackgroundInfo> BackgroundGetInfo() => _backgroundSession.GetInfoAsync();

    public Task<BackgroundInfo> BackgroundEnsurePermissions() => _backgroundSession.EnsurePermissionsAsync();

    public Task<BackgroundInfo> BackgroundStart(string snapshotJson) =>
        _backgroundSession.StartAsync(ParseSnapshot(snapshotJson));

    public Task BackgroundUpdate(string snapshotJson) =>
        _backgroundSession.UpdateAsync(ParseSnapshot(snapshotJson));

    public Task BackgroundStop() => _backgroundSession.StopAsync();

    public Task BackgroundOpenNotificationSettings() => _backgroundSession.OpenNotificationSettingsAsync();

    /// <summary>Plain deserialize, with no fallback beyond an empty
    /// snapshot on failure — JS controls this payload's shape completely
    /// (it's always exactly what background-session.js's sync() builds,
    /// see that file's header comment), unlike BleRequestDevice's
    /// optionsJson, which has several real-world callers with slightly
    /// different shapes and so needs ParseFilters' more defensive
    /// hand-parsing.</summary>
    private static BackgroundSnapshot ParseSnapshot(string snapshotJson)
    {
        try
        {
            return JsonSerializer.Deserialize<BackgroundSnapshot>(snapshotJson) ?? new BackgroundSnapshot();
        }
        catch (JsonException)
        {
            return new BackgroundSnapshot(); // malformed payload — surface as an empty/blank notification rather than throwing across the bridge
        }
    }

    // ── Wake lock bridge (checklist §8) ─────────────────────────────────

    /// <summary>Backs window.electronWakeLock.acquire() (see native-shell-bridge.js). Known gap: MAUI's
    /// KeepScreenOn has an open issue where it's silently ignored on Mac Catalyst (dotnet/maui#26059) —
    /// worth a real-device check on that target during §11.</summary>
    public Task WakeLockAcquire()
    {
        return MainThread.InvokeOnMainThreadAsync(() => DeviceDisplay.Current.KeepScreenOn = true);
    }

    public Task WakeLockRelease()
    {
        return MainThread.InvokeOnMainThreadAsync(() => DeviceDisplay.Current.KeepScreenOn = false);
    }
}

/// <summary>What FilePickText returns to JS: the chosen file's name and its text contents.</summary>
public sealed class PickedFileInfo
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("text")]
    public string Text { get; init; } = "";
}

public sealed class BleDeviceInfo
{
    // HybridWebView's InvokeDotNet return-value serialization is plain
    // reflection-based System.Text.Json with no camelCase naming policy —
    // property names cross as-declared. native-bridge-backend.js's
    // NativeDevice/_wrapDevice destructure lowercase { id, name } (matching
    // this bridge's own documented Promise<{id, name}> contract), so these
    // need pinning explicitly or they'd cross as "Id"/"Name" and silently
    // become `undefined` on the JS side.
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("name")]
    public string? Name { get; set; }
}

public sealed class BleServiceInfo
{
    [JsonPropertyName("serviceId")]
    public string ServiceId { get; set; } = "";
}

public sealed class BleCharacteristicInfo
{
    [JsonPropertyName("charId")]
    public string CharId { get; set; } = "";
}