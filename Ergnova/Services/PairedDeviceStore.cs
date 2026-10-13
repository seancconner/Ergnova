// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using System.Text.Json;
using Microsoft.Maui.Storage;

namespace Ergnova.Services;

/// <summary>
/// Persists which BLE devices the user has successfully connected to at
/// least once, across app restarts — the native-bridge counterpart to Web
/// Bluetooth's own persistent-permissions store, which is what
/// web/src/ble/reconnect.js's own <c>ergnova_paired_devices</c> localStorage
/// entry mirrors on the JS side (see that file's header comment).
///
/// Backs <see cref="NativeBridgeMethods.BleGetDevices"/> so
/// reconnect.js's <c>reconnect.start()</c> has something to call
/// <c>watchAdvertisements()</c> on right after a cold start, not just within
/// whatever session first paired the device — before this existed,
/// BleGetDevices() only ever returned devices this same process instance
/// had already seen via BleRequestDevice, which is empty on every fresh
/// launch, silently breaking the JS side's whole auto-reconnect flow on
/// native builds (it degraded to "no previously granted devices found"
/// every single time, never actually a bug the JS side could detect since
/// an empty array is also the legitimate "never paired anything" answer).
///
/// Backed by Preferences.Default rather than a real database — this is a
/// small flat id-&gt;name map that's read/written as a whole, not data that
/// benefits from being queryable, and Preferences already round-trips
/// reliably on all four targets.
/// </summary>
internal static class PairedDeviceStore
{
    private const string Key = "ergnova_native_paired_devices";

    public static Dictionary<string, string> Load()
    {
        var json = Preferences.Default.Get(Key, "{}");
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(json) ?? new Dictionary<string, string>();
        }
        catch (JsonException)
        {
            // Corrupt/unexpected stored value (e.g. from a future format
            // change) — start fresh rather than throwing out of a bridge
            // method JS is awaiting.
            return new Dictionary<string, string>();
        }
    }

    public static void Remember(string id, string? name)
    {
        var devices = Load();
        devices[id] = name ?? "Unknown";
        Preferences.Default.Set(Key, JsonSerializer.Serialize(devices));
    }

    // Note: nothing calls this yet. ble/reconnect.js's forget() only clears
    // its own localStorage entry today — there's no bridge method for the
    // JS side to tell the native shell to forget a device too, so a
    // forgotten device stays in this native list (BleGetDevices will keep
    // offering it, and reconnect.js will simply never watch it, since its
    // own remembered-meta check already filters BleGetDevices' results
    // against its own localStorage list — see reconnect.js's start()).
    // Harmless today; worth adding a BleForgetDevice bridge method (and a
    // reconnect.forget() call to it) later if that divergence ever matters
    // in practice — e.g. a "manage paired devices" settings screen that's
    // supposed to fully unpair, not just stop auto-reconnecting.
    public static void Forget(string id)
    {
        var devices = Load();
        if (devices.Remove(id))
        {
            Preferences.Default.Set(Key, JsonSerializer.Serialize(devices));
        }
    }
}
