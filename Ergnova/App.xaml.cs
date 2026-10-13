// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

using Microsoft.Extensions.DependencyInjection;

namespace Ergnova
{
    public partial class App : Application
    {
        public App()
        {
            InitializeComponent();
        }

        /// <summary>
        /// Checklist §9: the responsive web CSS inside HybridWebView has no
        /// say over the *native window's* initial size on the two desktop
        /// targets (Windows, Mac Catalyst) — left alone, a MAUI window
        /// launches at a MAUI-chosen default that has nothing to do with
        /// this app's own layout. Width/Height only set the *initial* size
        /// (the person can still resize freely afterward); Minimum{Width,
        /// Height} stop them shrinking it down to something the tab bar /
        /// live-session chart can't lay out in. Values are a starting
        /// guess sized around the app's phone-first layout at roughly a
        /// tablet's aspect ratio — not measured against the actual CSS
        /// breakpoints in web/src/style.css, so treat as a first pass to
        /// tune once you're actually looking at the desktop window.
        /// Android and iOS ignore these properties entirely (no windowed
        /// mode), so no platform guard is needed here.
        /// </summary>
        protected override Window CreateWindow(IActivationState? activationState)
        {
            var window = new Window(new AppShell());

            window.Width = 480;
            window.Height = 860;
            window.MinimumWidth = 380;
            window.MinimumHeight = 640;

            return window;
        }
    }
}