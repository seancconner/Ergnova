// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * native-shell-bridge.js  (checklist §5 / §7 / §8)
 *
 * IMPORTANT — this file is deliberately a plain classic script, NOT an ES
 * module, and lives in /public (copied to dist/ root untouched by Vite,
 * unprocessed). Two reasons:
 *
 *   1. src/ble/transport/index.js resolves which BLE backend to use once,
 *      synchronously, at *module load time*:
 *
 *          if (window.__ergnovaNativeBLE) return new NativeBridgeBackend(...)
 *
 *      That means window.__ergnovaNativeBLE must already exist before
 *      app.js's module graph starts executing. `<script type="module">`
 *      tags are always deferred until after the document is parsed and run
 *      in a separate graph from classic scripts; a plain `<script src="...">`
 *      with no `defer`/`async`/`type="module"` runs immediately, in
 *      document order, which is the only ordering guarantee that actually
 *      works here. See index.html — this tag sits right after
 *      `_framework/hybridwebview.js` and before the `app.js` module tag.
 *   2. It has to run (and no-op cleanly) in a plain browser tab too, since
 *      the exact same built bundle is also served as the regular PWA. On
 *      the web, `_framework/hybridwebview.js` 404s, `window.HybridWebView`
 *      is never defined, and everything below becomes a no-op — the app
 *      falls through to web-bluetooth-backend.js, the browser's own
 *      Screen Wake Lock API, and the `<a download>` fallback exactly as it
 *      does today.
 *
 * Native contract implemented here (see
 * src/ble/transport/native-bridge-backend.js's doc comment for the
 * consumer side of window.__ergnovaNativeBLE — that file was written
 * against exactly this contract and needed no changes):
 *
 *   window.__ergnovaNativeBLE .......... BLE bridge (checklist §5)
 *   window.electronWakeLock ............ screen wake lock (checklist §8) —
 *     deliberately reuses the *existing* Electron-shaped contract
 *     ({ acquire(): Promise, release(): Promise }) that src/ux/wake-lock.js
 *     already checks for first, so that file needed zero changes.
 *   window.__ergnovaNativeFile .......... file save/export bridge (§7)
 *   window.__ergnovaNativeBackground .... background workout session bridge —
 *     backs src/platform/background-session.js; see that file's header
 *     comment for the full sync(snapshot)-driven contract this implements.
 *     Only Android answers `getInfo()`/`start()` with supported: true (see
 *     Services/IBackgroundSessionService.cs's own doc comment for why) —
 *     on iOS/Mac Catalyst/Windows this bridge still exists (the object
 *     itself is always defined inside the MAUI shell), it just reports
 *     unsupported, which background-session.js already treats the same as
 *     no bridge at all. It is also the one bridge with a native -> JS
 *     control path: a tap on the tray notification's Pause / Play button
 *     arrives as a `background` push message and is handed to the handler
 *     background-session.js registers through setActionHandler().
 *   window.__ergnovaNativePrint ......... print bridge — backs
 *     src/platform/print.js. Prints whatever the page is currently showing
 *     through the platform's own print flow (window.print() is a no-op in
 *     the Android/WKWebView shells); see Services/PrintService.cs.
 *
 * All of these talk to C# via window.HybridWebView.InvokeDotNet(name, args),
 * which round-trips through the methods on app/Ergnova's
 * NativeBridgeMethods (see Services/NativeBridgeMethods.cs), registered
 * with hybridWebView.SetInvokeJavaScriptTarget(...) in MainPage.xaml.cs.
 * Native -> JS push events (BLE notify/disconnect callbacks) arrive the
 * other way, as HybridWebView "raw" messages — see the
 * HybridWebViewMessageReceived listener at the bottom of this file.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || !window.HybridWebView) {
    // Not running inside the MAUI shell (plain browser/PWA, or the
    // `_framework/hybridwebview.js` tag above this one 404'd) — leave every
    // bridge global undefined so each subsystem's existing web fallback
    // takes over exactly as it does today. Nothing else to do here.
    return;
  }

  var rawInvoke = window.HybridWebView.InvokeDotNet;

  function invoke(methodName, args) {
    return args === undefined ? rawInvoke(methodName) : rawInvoke(methodName, args);
  }

  // Bluetooth SIG 16-bit UUIDs cross the *-device.js files as raw numbers
  // (ftms-constants.js's FTMS_SERVICE = 0x1826, HRS_SERVICE = 0x180d, etc. —
  // real Web Bluetooth accepts those numbers directly, so ble/*-device.js
  // was never written to stringify them itself). Shiny's UUID args are
  // plain strings that accept that same short form directly ("1826", "180d"
  // — see shinylib.net/ble/gatt's own examples), but String(0x1826) instead
  // produces the *decimal* string "6182", which matches no real UUID.
  // Already-string 128-bit UUIDs (Moxy, ProForm) pass through unchanged.
  function normalizeUuid(uuid) {
    return typeof uuid === 'number' ? uuid.toString(16).padStart(4, '0') : String(uuid);
  }

  // Applies normalizeUuid to every service UUID in a requestDevice() options
  // object (filters[].services and optionalServices) before it's JSON-
  // stringified for the bridge — same reasoning as normalizeUuid above,
  // just for the nested shape requestDevice's options come in.
  function normalizeRequestOptions(options) {
    var out = Object.assign({}, options);
    if (Array.isArray(options.filters)) {
      out.filters = options.filters.map(function (f) {
        var filter = Object.assign({}, f);
        if (Array.isArray(f.services)) filter.services = f.services.map(normalizeUuid);
        return filter;
      });
    }
    if (Array.isArray(options.optionalServices)) {
      out.optionalServices = options.optionalServices.map(normalizeUuid);
    }
    return out;
  }

  // ── BLE bridge (§5) ───────────────────────────────────────────────────
  //
  // `isGattConnected` is called *synchronously* (no await) by
  // native-bridge-backend.js's `NativeGattServer#connected` getter, to
  // mirror the real BluetoothRemoteGATTServer#connected property. A round
  // trip through InvokeDotNet is always a Promise, so it can't answer that
  // synchronously — instead this tracks connected device IDs locally,
  // updated from gattConnect()'s resolution and from the
  // 'gattserverdisconnected' push event, and isGattConnected just reads
  // that local set. NativeBridgeMethods.BleIsGattConnected still exists on
  // the C# side (useful for its own diagnostics/BLE bridge internals) but
  // nothing on the JS side calls it remotely.
  var connectedDeviceIds = new Set();

  window.__ergnovaNativeBLE = {
    // BleRequestDevice resolves with null when the person backs out of the
    // native chooser (it deliberately doesn't throw — see that method's own
    // <remarks> in NativeBridgeMethods.cs). Real Web Bluetooth rejects with a
    // NotFoundError in that situation, and every caller of
    // bleTransport.requestDevice() is written against that, so restore it
    // here rather than letting a null reach native-bridge-backend.js's
    // _wrapDevice().
    requestDevice: function (options) {
      return invoke('BleRequestDevice', [JSON.stringify(normalizeRequestOptions(options || {}))])
        .then(function (info) {
          if (!info) {
            var cancelled = new Error('User cancelled the requestDevice() chooser.');
            cancelled.name = 'NotFoundError';
            throw cancelled;
          }
          return info;
        });
    },

    getDevices: function () {
      return invoke('BleGetDevices');
    },

    gattConnect: function (deviceId) {
      return invoke('BleGattConnect', [deviceId]).then(function (result) {
        connectedDeviceIds.add(deviceId);
        return result;
      });
    },

    gattDisconnect: function (deviceId) {
      connectedDeviceIds.delete(deviceId);
      // Fire-and-forget, matching native-bridge-backend.js's synchronous call site.
      invoke('BleGattDisconnect', [deviceId]).catch(function (err) {
        console.warn('[native-ble-bridge] gattDisconnect failed', err);
      });
    },

    isGattConnected: function (deviceId) {
      return connectedDeviceIds.has(deviceId);
    },

    getPrimaryService: function (deviceId, serviceUuid) {
      return invoke('BleGetPrimaryService', [deviceId, normalizeUuid(serviceUuid)]);
    },

    getCharacteristic: function (deviceId, serviceId, charUuid) {
      return invoke('BleGetCharacteristic', [deviceId, serviceId, normalizeUuid(charUuid)]);
    },

    writeValue: function (deviceId, charId, bytes, withResponse) {
      return invoke('BleWriteValue', [deviceId, charId, Array.from(bytes), !!withResponse]);
    },

    readValue: function (deviceId, charId) {
      return invoke('BleReadValue', [deviceId, charId]);
    },

    startNotifications: function (deviceId, charId) {
      return invoke('BleStartNotifications', [deviceId, charId]);
    },

    watchAdvertisements: function (deviceId) {
      return invoke('BleWatchAdvertisements', [deviceId]);
    },

    stopWatchingAdvertisements: function (deviceId) {
      invoke('BleStopWatchingAdvertisements', [deviceId]).catch(function (err) {
        console.warn('[native-ble-bridge] stopWatchingAdvertisements failed', err);
      });
    },

    // Called by this file's HybridWebViewMessageReceived listener below —
    // native-bridge-backend.js's constructor chains onto whatever was here
    // before it, so set this up first and let it take over cleanly.
    _dispatch: function (type, detail) {
      if (type === 'gattserverdisconnected' && detail && detail.deviceId) {
        connectedDeviceIds.delete(detail.deviceId);
      }
    },
  };

  // ── Screen wake lock (§8) ──────────────────────────────────────────────
  //
  // Reuses ux/wake-lock.js's existing `window.electronWakeLock` contract
  // (checked *before* the browser Screen Wake Lock API — see that file) so
  // no changes were needed there at all. Backed by
  // Microsoft.Maui.Devices.DeviceDisplay.Current.KeepScreenOn on the C#
  // side. Known platform gap: MAUI's KeepScreenOn has an open issue on Mac
  // Catalyst where it's silently ignored (dotnet/maui#26059) — worth a
  // real-device check on that target specifically (checklist §11).
  window.electronWakeLock = {
    acquire: function () {
      return invoke('WakeLockAcquire');
    },
    release: function () {
      return invoke('WakeLockRelease');
    },
  };

  // ── File save/export + pick/import bridge (§7) ─────────────────────────
  //
  // saveBlob is the *export* direction (blob -> native save/share sheet).
  // pickText is the import direction for the one flow that needs it —
  // History's Import (src/platform/pick-file.js): a native document picker
  // via MAUI's FilePicker, returning the chosen file's text. It exists
  // because the Android shell replaces the WebView's WebChromeClient
  // (ErgnovaWebChromeClient, for alert()/confirm()), and without a
  // file-chooser callback there an `<input type="file">` opens nothing.
  // The workout-file import in editor/workout-editor.js still uses a plain
  // `<input type="file">`; if it turns out to do nothing on Android too, it
  // can move onto pickText the same way.
  window.__ergnovaNativeFile = {
    /**
     * @param {string} filename  suggested filename, extension included
     * @param {Blob}   blob
     * @returns {Promise<void>}
     */
    saveBlob: function (filename, blob) {
      return blobToBase64(blob).then(function (base64) {
        return invoke('FileSaveBlob', [filename, base64, blob.type || 'application/octet-stream']);
      });
    },

    /**
     * Opens the platform's file picker (any file type).
     * @returns {Promise<{name: string, text: string}|null>}  The chosen
     *   file's name and its contents read as UTF-8 text, or null if the
     *   person cancelled (or the pick failed on the native side).
     */
    pickText: function () {
      return invoke('FilePickText').then(function (picked) {
        return picked || null;
      });
    },
  };

  // ── Print bridge ──────────────────────────────────────────────────────
  //
  // Backs src/platform/print.js. window.print() does nothing inside the
  // Android WebView / WKWebView shells, so print goes native instead.
  // PrintCurrentPage takes an optional standalone HTML document (see
  // src/platform/print-document.js): Android and iOS / Mac Catalyst print
  // *that* document — white paper, black ink — rather than the live,
  // dark-themed app page, which those print engines don't reliably lay out
  // with @media print (it came out as an empty page in app colors). With no
  // html, and always on Windows (WebView2's print UI does apply @media print),
  // the live page goes to the platform's print flow instead — see style.css's
  // "Printable recipe sheet" block for what that isolates.
  //
  // Both arguments are always sent (html as '' when absent): HybridWebView's
  // InvokeDotNet matches the JSON args array to the C# parameter list by
  // count, so PrintCurrentPage(string jobName, string html) needs exactly two.
  window.__ergnovaNativePrint = {
    /**
     * @param {string} [jobName]  print-job / spooler title
     * @param {string} [html]     complete standalone HTML document to print
     * @returns {Promise<boolean>} true once the platform print UI was launched;
     *   false if this platform can't print or the UI couldn't be shown
     */
    printPage: function (jobName, html) {
      return invoke('PrintCurrentPage', [jobName || 'Ergnova', html || '']);
    },
  };

  // ── Background workout session bridge ──────────────────────────────────
  //
  // Snapshot objects cross as a JSON string (invoke('BackgroundStart',
  // [JSON.stringify(snapshot)])), same reasoning as requestDevice()'s
  // options object above — see NativeBridgeMethods.cs's BackgroundStart/
  // BackgroundUpdate for the C# side. background-session.js never calls
  // start()/update() with anything but its own snapshot shape (title,
  // status, elapsedSec, text, expanded — see that file's header comment),
  // so no normalization is needed here the way requestDevice()'s UUIDs
  // need normalizeRequestOptions().
  var backgroundActionHandler = null;

  window.__ergnovaNativeBackground = {
    getInfo: function () {
      return invoke('BackgroundGetInfo');
    },
    ensurePermissions: function () {
      return invoke('BackgroundEnsurePermissions');
    },
    start: function (snapshot) {
      return invoke('BackgroundStart', [JSON.stringify(snapshot)]);
    },
    update: function (snapshot) {
      return invoke('BackgroundUpdate', [JSON.stringify(snapshot)]);
    },
    stop: function () {
      return invoke('BackgroundStop');
    },
    openNotificationSettings: function () {
      return invoke('BackgroundOpenNotificationSettings');
    },

    // Registered by background-session.js. Receives 'pause' | 'play' when the
    // rider taps the notification's action button. Deliberately not buffered
    // while nothing is registered: a tap that lands during a page reload is
    // dropped rather than replayed later, when it could pause a workout the
    // rider has since resumed by hand.
    setActionHandler: function (handler) {
      backgroundActionHandler = typeof handler === 'function' ? handler : null;
    },

    // Called by this file's HybridWebViewMessageReceived listener below.
    _dispatch: function (type, detail) {
      if (type !== 'action' || !detail || !backgroundActionHandler) return;
      try {
        backgroundActionHandler(detail.action);
      } catch (err) {
        console.warn('[native-background-bridge] action handler failed', err);
      }
    },
  };

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () {
        // reader.result is "data:<mime>;base64,<data>" — strip the prefix.
        var commaIndex = reader.result.indexOf(',');
        resolve(reader.result.slice(commaIndex + 1));
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ── Native -> JS push events ─────────────────────────────────────────
  //
  // C# pushes BLE notify/disconnect/advertisement events via
  // hybridWebView.SendRawMessage(JSON.stringify({ channel, type, detail })),
  // which HybridWebView's own framework script re-dispatches as a
  // "HybridWebViewMessageReceived" DOM event (see _framework/
  // hybridwebview.js — not this file). "channel" leaves room for future
  // non-BLE push messages to share this one raw-message pipe without
  // guessing at each other's payload shape.
  window.addEventListener('HybridWebViewMessageReceived', function (e) {
    var payload;
    try {
      payload = JSON.parse(e.detail.message);
    } catch (err) {
      return; // not one of ours
    }
    if (!payload) return;
    if (payload.channel === 'ble' && window.__ergnovaNativeBLE) {
      window.__ergnovaNativeBLE._dispatch(payload.type, payload.detail);
    } else if (payload.channel === 'background' && window.__ergnovaNativeBackground) {
      window.__ergnovaNativeBackground._dispatch(payload.type, payload.detail);
    }
  });
})();
