// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/master-detail.js
 *
 * The rail + 2-column tile grid layout, styled by style.css's "Master-detail"
 * block. Settings, Overview, History and Diet are all built on it, so this class
 * takes no Settings-specific knowledge at all — it just wires up whatever
 * `.md-shell` it's given.
 *
 * Markup contract (see index.html's settings panel for the real example):
 *
 *   <div class="md-shell" id="…">
 *     <nav class="md-rail"></nav>               -- starts empty; this class fills it in
 *     <div class="md-pane">
 *       <section class="md-cat" data-cat="general" data-label="General" data-icon="icon-settings">
 *         <div class="settings-card settings-list"> … </div>
 *       </section>
 *       … one <section class="md-cat" data-cat="…" data-label="…" data-icon="…"> per category …
 *     </div>
 *   </div>
 *
 * Categories are discovered from the DOM (every `.md-cat[data-cat]` inside
 * the shell's `.md-pane`), in document order — there's no separate JS list
 * to keep in sync. `data-label` is what the rail button shows (and its
 * accessible name); `data-icon` is the id of a `#icon-*` <symbol> in
 * index.html's sprite. Both are only read once, at construction — a
 * category can't be renamed or re-iconed after the fact, same as a real
 * settings row's label can't today.
 *
 * One rail item is selected at a time: selecting one shows its `.md-cat`
 * (`.active`, per style.css) and hides the rest — no page transition, no
 * re-navigating, per the design plan's Interaction principles. A trailing
 * "rail-toggle" button (always last) collapses the rail to icons-only
 * regardless of width; style.css's own `@media` breakpoint additionally
 * forces icons-only on a narrow viewport no matter what this class's state
 * is.
 *
 * The rail floats over the pane's content, bottom-anchored above the global
 * tab bar (style.css: position: fixed, same tier as .tab-bar) — plain CSS,
 * no scroll-position tracking. That's a deliberate change from an earlier
 * version of this file, which pinned the rail near the *top* of .md-shell
 * and re-computed its position on every scroll/resize to fake
 * `position: sticky` by hand; besides being needless complexity, a rail
 * that trails the top of the content is also the rail sitting right on top
 * of whatever you scrolled to the top *to look at*. Bottom-anchored, it's
 * never between the rider and the content at either scroll extreme — see
 * .md-pane's own padding-bottom in style.css, which reserves exactly the
 * rail's rendered height (kept current by _measureRailHeight() below) so
 * the last tile in a category clears it too, not just the ones in the
 * middle of a scroll.
 *
 * The constructor also moves the rendered <nav> itself out of .md-shell (and
 * so out of its tab's [data-panel]) to be a direct child of #app — a sibling
 * of .tab-bar, at the very end of the constructor, once the rail has
 * everything it needs from shellEl. A `position: fixed` element is normally
 * anchored to the viewport, but any ancestor with an active CSS `transform`
 * becomes its containing block instead (per spec) — and app.js's swipe nav
 * and panel-enter animations both apply `transform` directly to .panel while
 * a tab is being switched to or dragged between. Left nested, the "fixed"
 * rail would ride along with its panel's slide and snap back to its true
 * position the instant the transform cleared — jumping on every tab switch,
 * and, worse, forcing the rail's own layer (backdrop-filter + overflow-y:
 * auto) to be re-composited against a shifting containing block on every
 * drag frame, which is what actually stalled and restarted the swipe
 * animation itself, not just the rail's own visible position. .tab-bar
 * never has this problem for the same reason: it was never nested inside a
 * .panel to begin with. Moving the rail up next to it removes the bug
 * structurally instead of chasing its symptoms. index.html's markup and
 * every view's own _render() are untouched — .md-shell still declares
 * `<nav class="md-rail">` exactly where the contract above says to, this
 * constructor is just the one place that then relocates the live node.
 * app.js's switchTab() shows/hides the relocated rail in step with its
 * panel via the `data-rail-for` attribute set below (mirroring how it
 * already toggles `.hidden` on every `[data-panel]`) — see its own comment.
 *
 * Exception: a rail built with `alwaysCollapsed` (Overview) is pinned collapsed
 * and sits outside this shared state entirely — see that option.
 *
 * The collapse toggle is one shared control, not four independent ones that
 * happen to look alike: collapsing the rail on any tab collapses it on all of
 * them, immediately, via the _instances/_sharedCollapsed module state below —
 * so switching tabs after collapsing Settings' rail doesn't land on a Diet
 * that's still expanded. It's in-memory only, not persisted across a reload;
 * add a localStorage read/write in _sharedCollapsed's getter/setter if that's
 * ever wanted too.
 *
 * The collapse toggle does nothing to a tab's header. The page-title banner
 * is one size on every tab, expanded, and stays that way whatever the rail is
 * doing; it is also sticky, so it follows the page as it scrolls (both in
 * style.css, on `.history-header`). Nothing in this class touches it.
 */
const _instances = new Set();
let _sharedCollapsed = false;

export class MasterDetailRail {
  /** @param {HTMLElement|null} shellEl  the `.md-shell` element, or null if
   *    the markup isn't there (e.g. renamed id) — every method below is
   *    then a harmless no-op instead of a crash, same defensive spirit as
   *    the rest of the app's `$('…')?.` lookups.
   *  @param {Object}   [opts]
   *  @param {boolean} [opts.fabOnly]  Build a rail that is nothing but the "+" start
   *    button's slot — no category tabs, no collapse toggle. Overview uses this: it
   *    is one compact page rather than a set of categories, so the rail has nothing
   *    to switch between. On its own it joins the shared collapsed state (the "+"
   *    shrinks) and sits exactly where the other tabs' "+" does;
   *    Overview additionally passes `alwaysCollapsed` (below) to pin it collapsed.
   *    The shell's single `.md-cat` is simply kept open.
   *  @param {boolean} [opts.alwaysCollapsed]  Keep this rail
   *    permanently collapsed, independent of the shared toggle: it never joins
   *    _instances, so collapsing/expanding the rail on another tab doesn't touch
   *    it. Overview uses this together with `fabOnly`.
   *  @param {(catId: string) => void} [opts.onSelect]  Called after every
   *    successful select() (including the initial one this constructor
   *    triggers), with the newly-active category id. Optional — Settings
   *    has no cross-category state to reset and passes nothing. A tab
   *    whose tiles carry their own open/expanded state that shouldn't
   *    survive a category switch (History's expanded session card) uses
   *    this to close it instead of teaching this class about that state
   *    itself. */
  constructor(shellEl, { onSelect, fabOnly = false, alwaysCollapsed = false } = {}) {
    this._shell = shellEl ?? null;
    this._rail  = shellEl?.querySelector('.md-rail') ?? null;
    this._cats  = shellEl ? [...shellEl.querySelectorAll('.md-pane > .md-cat[data-cat]')] : [];
    this._current = null;
    this._onSelect = onSelect ?? null;
    this._fabOnly = Boolean(fabOnly);

    if (!this._shell || !this._rail || this._cats.length === 0) return;

    if (!this._fabOnly) this._rail.setAttribute('role', 'tablist');
    this._cats.forEach((section, i) => {
      const id = section.dataset.cat;
      section.id = section.id || `md-cat-${id}`;
      // A fab-only rail has no tabs, so the pane is plain content, not a tabpanel.
      if (!this._fabOnly) {
        section.setAttribute('role', 'tabpanel');
        section.setAttribute('aria-labelledby', `md-rail-tab-${id}`);
      }
      section.classList.remove('active'); // starts closed; select() below (or the caller) opens one
      if (i === 0) this._current = id; // sensible fallback if the caller never calls select()
    });

    this._rail.innerHTML = (this._fabOnly ? '' : this._cats.map((section) => this._renderTab(section)).join(''))
      // Slot the floating "+" start button relocates into (app.js's
      // _placeFabInRail(), called from switchTab() and once at init) — an
      // empty placeholder here, not rendered content of this class's own,
      // since the FAB is one shared element moved between whichever rail
      // is currently on screen, the same relocate-on-the-fly pattern this
      // constructor already uses to move the rail itself to be a sibling
      // of .tab-bar (see the class doc comment). Always second-to-last,
      // directly above the toggle below, on every rail this class builds.
      + `<div class="md-rail-fab-slot"></div>`
      + (this._fabOnly ? '' : `<button type="button" class="md-rail-item md-rail-toggle" aria-label="Collapse sidebar" aria-expanded="true">
           <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-chevron-right"/></svg>
         </button>`);

    this._rail.classList.toggle('md-rail-fab-only', this._fabOnly);
    this._rail.addEventListener('click', this._onRailClick);
    if (this._current) this.select(this._current);

    // Escape the swipeable .panel entirely, to a sibling of .tab-bar — see
    // the class doc comment for why. Falls back to leaving it nested (old
    // behavior, transform glitch and all) if this tab's markup doesn't
    // follow the usual [data-panel] contract, same defensive spirit as the
    // guard clause above.
    const ownerPanel = shellEl.closest('[data-panel]');
    const app = document.getElementById('app');
    if (ownerPanel && app) {
      this._rail.dataset.railFor = ownerPanel.dataset.panel;
      // Mirrors whatever the panel's own hidden state already is right now
      // (set by index.html for a tab that isn't the initial one, or by a
      // previous switchTab() call) — app.js's switchTab() keeps the two in
      // sync from here on (see its own comment), but nothing else runs
      // between this constructor and the first paint to establish it.
      this._rail.classList.toggle('hidden', ownerPanel.classList.contains('hidden'));
      app.appendChild(this._rail);
    }

    // Join the shared collapse state (see the class doc comment) — applied
    // instantly, no animation, so a rail built *after* the others were
    // already collapsed (Settings/History/Diet all construct during
    // app.js's init(), in whatever order it calls them) opens in the same
    // state as the rest instead of animating into sync the first time
    // something touches it.
    //
    // An `alwaysCollapsed` rail (Overview) opts out: it is pinned collapsed and
    // is deliberately *not* registered in _instances, so the shared toggle on
    // the other tabs never expands it.
    if (alwaysCollapsed) {
      this._applyCollapsed(true);
    } else {
      _instances.add(this);
      this._applyCollapsed(_sharedCollapsed);
    }
  }

  _renderTab(section) {
    const id = section.dataset.cat;
    const label = section.dataset.label ?? id;
    const icon = section.dataset.icon ?? 'icon-settings';
    return `<button type="button" class="md-rail-item" id="md-rail-tab-${id}" data-cat="${id}"
              role="tab" aria-selected="false" aria-controls="${section.id}" title="${label}">
              <svg class="btn-icon" viewBox="0 0 24 24"><use href="#${icon}"/></svg>
              <span class="md-rail-label">${label}</span>
            </button>`;
  }

  _onRailClick = (e) => {
    const toggle = e.target.closest('.md-rail-toggle');
    if (toggle) { this._toggleCollapsed(); return; }
    const tab = e.target.closest('.md-rail-item[data-cat]');
    if (tab) this.select(tab.dataset.cat);
  };

  /** Flips the one shared collapsed state (see the class doc comment) and
   *  applies it to every rail currently on screen, not just this one —
   *  that's the whole point of it being shared rather than local to
   *  `this._rail`. */
  _toggleCollapsed() {
    _sharedCollapsed = !_sharedCollapsed;
    for (const instance of _instances) instance._applyCollapsed(_sharedCollapsed);
  }

  /** Puts this rail into the given collapsed state.
   *  Called on every registered instance by _toggleCollapsed() above, and
   *  once on `this` alone at construction time to join whatever state the
   *  other tabs are already in.
   *  @param {boolean} collapsed */
  _applyCollapsed(collapsed) {
    this._rail.classList.toggle('collapsed', collapsed);
    // The rail is fixed and lives outside the shell, so the pane can't see its
    // state with a sibling selector; style.css's rail inset keys off this.
    this._shell.classList.toggle('md-rail-collapsed', collapsed);
    const toggle = this._rail.querySelector('.md-rail-toggle');
    toggle?.setAttribute('aria-expanded', String(!collapsed));
    toggle?.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    this._measureRailHeight();
  }

  /** Keeps --rail-h (style.css's .md-pane padding-bottom reads it) current
   *  with this rail's actual rendered height, so the last tile in a
   *  category clears the rail the same way every tile already clears the
   *  tab bar — see the class doc comment. Called after anything that can
   *  change that height: construction, every collapse toggle (collapsed is
   *  shorter), and setCategoryHidden() (one more or fewer item). A no-op while
   *  this._shell's panel is `display: none` — offsetHeight reads 0 on a
   *  hidden ancestor — so app.js's switchTab() calls this again the moment
   *  a tab is actually shown (see refreshPosition() below), the same
   *  hidden-panel problem an earlier version of this file had for its own
   *  scroll-position math. */
  _measureRailHeight() {
    const h = this._rail.offsetHeight;
    if (h > 0) this._shell.style.setProperty('--rail-h', `${h}px`);
  }

  /** Re-measures this rail's height — see _measureRailHeight()'s doc
   *  comment for why a hidden panel needs this called again once it's
   *  actually shown. Kept as its own public method (rather than folding
   *  the call into select()) since app.js's switchTab() is the one place
   *  that reliably knows a panel just became visible; every other caller
   *  of select() (this class's own click handler) already has an
   *  on-screen, correctly-measured rail. */
  refreshPosition() {
    this._measureRailHeight();
  }

  /** Shows one category's pane and hides the rest. No-ops for an unknown
   *  id (a typo, or a category not present in this shell) rather than
   *  blanking every pane. @param {string} catId */
  select(catId) {
    if (!this._cats.some((s) => s.dataset.cat === catId)) return;
    this._current = catId;
    this._cats.forEach((section) => {
      const active = section.dataset.cat === catId;
      section.classList.toggle('active', active);
      section.setAttribute('aria-selected', String(active)); // harmless on a tabpanel; kept for symmetry with its tab
      const tab = this._rail.querySelector(`.md-rail-item[data-cat="${section.dataset.cat}"]`);
      tab?.classList.toggle('active', active);
      tab?.setAttribute('aria-selected', String(active));
    });
    this._onSelect?.(catId);
  }

  /** Hides (or restores) one category's rail item, for a category that only
   *  applies in some configurations. Nothing calls it today. Doesn't touch whatever's
   *  currently selected; callers that hide the active category are expected
   *  to select() somewhere else themselves. Re-measures the rail's height
   *  afterward — one more or fewer item changes it, same as a collapse
   *  toggle does (_measureRailHeight()'s own doc comment).
   *  @param {string} catId @param {boolean} hidden */
  setCategoryHidden(catId, hidden) {
    this._rail?.querySelector(`.md-rail-item[data-cat="${catId}"]`)?.classList.toggle('hidden', hidden);
    this._measureRailHeight();
  }
}
