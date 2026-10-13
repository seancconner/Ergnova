# Ergnova

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-seancconner-ea4aaa?logo=github-sponsors)](https://github.com/sponsors/seancconner)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-seancconner-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/seancconner)

Offline-first, multi-modal fitness tracker with live Bluetooth control for
smart trainers, rowers, and ellipticals (ERG / resistance / slope targets),
strength training logs, diet & nutrition tracking, and body-composition
tracking — auto-saving every workout as it completes. No account, no
server: everything lives on-device in IndexedDB.

Ships two ways from the same codebase:

- as an installable web app (PWA), talking to devices over Web Bluetooth
- as a native app for Android, iOS, Windows, and Mac Catalyst, via a
  [.NET MAUI](https://learn.microsoft.com/dotnet/maui/) shell that wraps
  the web app in a `HybridWebView` and bridges Bluetooth through
  [Shiny.BluetoothLE](https://shinylib.net) for platforms where Web
  Bluetooth isn't available (iOS/Mac Catalyst)

## Features

- **Live device control** — connect smart trainers/rowers/ellipticals over
  Bluetooth and drive them with ERG, resistance, or slope-simulation
  targets; virtual gearing for slope mode
- **Multi-metric capture** — power, cadence, speed, heart rate, and
  muscle-oxygen (SmO2/tHb) from any combination of connected sensors,
  normalized power, VO2max estimation, and guided FTP/HR test protocols
- **Strength training** — exercise library, set tracker (reps or timed
  holds), one-rep-max estimation, and a muscle diagram
- **Workout formats** — import ERG/MRC/ZWO workout files; export completed
  activities as FIT, TCX, GPX, or PWX
- **Diet & nutrition** — ingredient and recipe database, food diary,
  macro/calorie tracking with a macro pie chart, and daily-value/label
  rounding that follows FDA-style label rules
- **Body composition** — pairs with BLE smart scales for weight and
  body-fat% readings, with manual entry as a fallback
- **Session history** — a browsable history of past sessions, plus
  scripted/simulated playback for exercising the app end-to-end without
  real hardware attached
- **Small UX details that add up** — a wake lock so the screen doesn't
  sleep mid-session, fullscreen mode, audio cues, and keyboard shortcuts

## Project layout

```
web/       Vite + vanilla JS PWA — the actual application
Ergnova/   .NET MAUI native shell (Android/iOS/Windows/Mac Catalyst)
           that wraps web/'s build output in a HybridWebView and adds
           the native BLE bridge
tools/     Source SVGs + generator script for the Android
           notification icons
```

`Ergnova.csproj` builds `web/` for you as part of its own build (see the
`BuildWebApp` MSBuild target), so the two rarely need to be touched as
separate steps — but `web/` also runs perfectly well on its own as a
plain browser-based PWA if you don't need the native shell.

## Getting started

### Web app only

Requires [Node.js](https://nodejs.org) 22+.

```sh
cd web
npm install
npm run dev
```

Web Bluetooth requires a secure context. `npm run dev` over plain HTTP is
fine for testing from the same machine (`localhost` always counts), but
testing from a phone/tablet elsewhere on your LAN needs HTTPS — use
`npm run dev:https` instead, which generates a self-signed cert
automatically on first run.

### Native app (Android / iOS / Windows / Mac Catalyst)

Requires the [.NET 10 SDK](https://dotnet.microsoft.com/download) with the
MAUI workload(s) for your target platform(s) installed, plus Node.js 22+
on `PATH` (the MAUI build invokes it to build `web/` for you).

```sh
dotnet workload install maui-android maui-windows
```

iOS and Mac Catalyst have extra requirements — see
[Building for iOS / Mac Catalyst](#building-for-ios--mac-catalyst) below.

Then open `Ergnova.slnx` in Visual Studio 2026 and hit F5, or build a
specific target from the command line:

```sh
cd Ergnova
dotnet build Ergnova.csproj -f net10.0-android -c Release
```

`.github/workflows/build.yml` compiles every target, unsigned, on each push
and pull request.

### Building for iOS / Mac Catalyst

Both targets must be built on a Mac with Xcode installed. Each .NET for
iOS / Mac Catalyst release requires one specific Xcode version, and the
build stops immediately with a "requires Xcode X" error if yours doesn't
match, so install the workload and Xcode as a pair.

CI currently uses:

| Piece | Version |
| --- | --- |
| Runner | `macos-26` |
| Xcode | 26.6 (requires macOS 26.2+) |
| .NET SDK | 10.0.4xx |
| MAUI workload set | 10.0.401 (.NET for iOS / Mac Catalyst 26.5.10318) |

```sh
dotnet workload install maui-ios maui-maccatalyst --version 10.0.401
dotnet workload --info    # confirm the installed versions
```

Pin the workload version as shown. A plain `dotnet workload install
maui-ios` installs the newest release, which can require a newer Xcode
than you have (the 27.0.x releases need Xcode 27.0 and macOS 26.6+).
These values live in the `env:` block at the top of
`.github/workflows/build.yml`. To build against
Xcode 27 instead, install it, use a matching workload set, and use
MAUI 10.0.110 or later.

Because `Ergnova.csproj` multi-targets every platform, restrict restore
to the one you're building:

```sh
cd Ergnova
dotnet build Ergnova.csproj -f net10.0-ios -p:TargetFrameworks=net10.0-ios -c Release
dotnet build Ergnova.csproj -f net10.0-maccatalyst -p:TargetFrameworks=net10.0-maccatalyst -c Release
```

> **Note:** CI compiles both targets, but only as unsigned Release
> builds — for iOS that means the simulator (`iossimulator-arm64`), not
> a physical-device build. Neither target has been run on real Apple
> hardware or a simulator — no Apple devices were available during
> development — so they are compile-verified only, not run-verified.
> Treat them as more likely to have runtime surprises (layout,
> HybridWebView quirks, the BLE bridge, IL trimming in Release) than
> Android/Windows until someone can test on an actual device.

## Testing

The `web/` app has a suite of plain node-based smoke tests (no browser,
no test framework — just `console.log`/`process.exit`) covering the pure
model/logic layers: `web/src/**/__*smoketest__.js`.

```sh
cd web
npm test
```

CI runs the same suite (`web-tests` job) ahead of the four platform build
jobs, so a broken `web/src/` change fails fast on a cheap Ubuntu runner
instead of after burning Windows/Mac build minutes.

## License

Ergnova is licensed under the [GNU AGPL v3.0 or later](LICENSE)
(`AGPL-3.0-or-later`). Third-party components and credits are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The "Ergnova" name and torch logo are not licensed for use as the name or
logo of a fork; see [BRANDING.md](BRANDING.md).

If Ergnova is useful to you, please consider
[sponsoring](https://github.com/sponsors/seancconner) or
[buying a coffee](https://ko-fi.com/seancconner).

