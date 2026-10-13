// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import mkcert from 'vite-plugin-mkcert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const configDir = path.dirname(fileURLToPath(import.meta.url));

// Web Bluetooth requires a secure context: 192.168.0.202 is fine for dev over
// plain HTTP, but real device testing off a phone/tablet on the LAN needs
// HTTPS. `npm run dev:https` (mode "https") turns this on via a plugin that
// generates a self-signed cert automatically on first run — no manual
// OpenSSL/mkcert setup. Your phone's browser will show a one-time "not
// secure" warning to click through for the self-signed cert; that's
// expected, and the page is still a secure context to Web Bluetooth once
// accepted. See README.
//
// The mode check below (`mode === 'https'`) is what actually turns the
// plugin on, and it's keyed off Vite's `mode`, not the command — so this
// applies just as much to `vite preview` as to `vite dev`. Plain
// `npm run preview` runs in mode "production" and gets plain HTTP, same
// gap as plain `npm run dev`: fine from the same machine (localhost is
// always a secure context), but `navigator.bluetooth` will be undefined
// on any other device that opens it over the LAN IP. Use
// `npm run preview:https` for that — same mkcert plugin, same self-signed
// cert, just applied to the preview server's `https` option too.

// "maui" is a build-only mode (see package.json's "build:maui" script — not
// used for `npm run dev`) whose whole job is telling this config it's building
// the bundle that gets copied into the MAUI project's Resources/Raw/wwwroot
// (see app/Ergnova/Ergnova.csproj's BuildWebApp target). Two things change:
//   1. vite-plugin-pwa (service worker + install-prompt) is skipped entirely
//      — see checklist §4: "a service worker fighting the native shell for
//      cache control is a classic footgun", and the PWA install prompt is
//      redundant once the app is natively packaged (§9).
//   2. __EG_NATIVE_SHELL_BUILD__ is defined true, so
//      src/platform/native-shell.js can tell (at build time, no runtime
//      sniffing needed) that this bundle is destined for the HybridWebView
//      shell rather than a plain browser tab.
// Everything else (root-relative asset paths, output layout) is unchanged,
// so `web/dist` from `npm run build` (plain web/PWA) and from
// `npm run build:maui` differ only in those two respects.

export default defineConfig(({ mode }) => {
    const isMauiBuild = mode === 'maui';

    return {
        define: {
            __EG_NATIVE_SHELL_BUILD__: isMauiBuild,
        },
        server: {
            host: true,
            port: 5173
        },
        build: {
            chunkSizeWarningLimit: 1000
        },
        plugins: [
            mode === 'https' && mkcert({
                hosts: ['192.168.0.202', '127.0.0.1', '192.168.0.202'],
                savePath: './certs',
                // force: true   // remove this after one run, once regenerated
            }),
            !isMauiBuild && VitePWA({
                registerType: 'autoUpdate',
                // Also precache the favicon — it isn't a manifest icon (browser tab /
                // bookmark icon, not "add to home screen"), so it has to be listed
                // separately or generateSW's default globPatterns would skip it.
                includeAssets: ['favicon.ico'],
                // generateSW's default globPatterns (js, css, html) don't include
                // fonts. Without woff2 here the self-hosted fonts in public/fonts/
                // wouldn't be precached, and a first offline launch after install
                // would fall back to system fonts.
                workbox: {
                    globPatterns: ['**/*.{js,css,html,woff2}']
                },
                manifest: {
                    name: 'Ergnova',
                    short_name: 'Ergnova',
                    description: 'Live trainer/rower/elliptical control with auto-saved workouts',
                    theme_color: '#111318',
                    background_color: '#111318',
                    display: 'standalone',
                    // Explicit rather than relying on VitePWA's default (which derives
                    // both from Vite's `base` config — unset here, so it would already
                    // resolve to '/'). Because these are relative paths, not absolute
                    // URLs, they resolve against wherever the manifest itself was
                    // served from: https://192.168.0.202:5173/ during normal dev,
                    // https://<lan-ip>:5173/ under `npm run dev:https` from a phone —
                    // same '/' either way, so there's no 192.168.0.202-only assumption
                    // baked in here. Sanity-checked against the vite-plugin-pwa docs
                    // (start_url/scope are always base-relative, never host-bound);
                    // still worth confirming once in a real "Add to Home Screen" off a
                    // phone on the LAN, since that's the one thing reading the config
                    // can't fully substitute for.
                    start_url: '/',
                    scope: '/',
                    // Icons — two sets, deliberately kept separate (see web.dev's
                    // "maskable icons": never mix `any` and `maskable` in one entry):
                    //
                    // 1. purpose "any" -> /icons/transparent/: the mark only, cropped to its
                    //    own bounds on a transparent background. This is what desktop
                    //    Chrome/Edge use for the installed app's Windows icon (taskbar,
                    //    Start, Alt+Tab, Task Manager). Chromium uses an exact-size image
                    //    as-is but otherwise shrinks the closest larger one, which is what
                    //    made the taskbar icon soft — so this is Microsoft's recommended
                    //    size set for Windows PWAs (44/55/66/88/176 app-icon scale sizes,
                    //    16..96 + 256 target sizes, plus 128/192/512). Regenerate with
                    //    `python scripts/build-pwa-icons.py`.
                    // 2. purpose "maskable" -> the opaque dark-tile 192/512: Android masks
                    //    these into its adaptive-icon shape. A transparent icon would land
                    //    inside a white circle there. The tile keeps the mark well inside
                    //    the 40%-radius safe zone.
                    icons: [
                        ...[
                            16, 20, 24, 30, 32, 36, 40, 44, 48, 55, 60, 64, 66, 72, 80, 88,
                            96, 128, 176, 192, 256, 512
                        ].map((size) => ({
                            src: `/icons/transparent/icon-${size}.png`,
                            sizes: `${size}x${size}`,
                            type: 'image/png',
                            purpose: 'any'
                        })),
                        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
                        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
                    ]
                }
            }),
            isMauiBuild && {
                name: 'copy-maui-dist',
                closeBundle() {
                    const srcDir = path.resolve(configDir, 'dist');
                    const targetDir = path.resolve(configDir, '../Ergnova/Resources/Raw/wwwroot');

                    // HybridWebView serves the app from a local virtual-host
                    // scheme (https://0.0.0.1/) rather than a real HTTP
                    // origin, so its responses never carry an
                    // Access-Control-Allow-Origin header. Vite's default
                    // `crossorigin` attribute on the entry <script
                    // type="module"> and <link rel="stylesheet"> tags forces
                    // those two specific requests into CORS mode, which the
                    // WebView then rejects for lacking that header — while
                    // index.html itself (a top-level navigation, not
                    // CORS-checked) and the non-crossorigin icon <link> tags
                    // load fine. Net effect: raw unstyled HTML, no JS. Safe
                    // to strip — same-origin requests never needed it.
                    const indexPath = path.join(srcDir, 'index.html');
                    const html = fs.readFileSync(indexPath, 'utf-8')
                        .replace(/ crossorigin(="[^"]*")?/g, '');
                    fs.writeFileSync(indexPath, html);

                    fs.cpSync(srcDir, targetDir, { recursive: true, force: true });
                }
            }
        ].filter(Boolean)
    };
});