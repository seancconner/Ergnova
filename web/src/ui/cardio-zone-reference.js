// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/cardio-zone-reference.js
 *
 * "Open reference" button at the bottom of Settings → Display, just below
 * the Power zones / Heart rate zones strips (index.html). Opens the
 * standalone Cardio Zone Reference page — a deeper look at the same zones
 * shown above, plus interval lengths, steady-state-vs-intervals tradeoffs
 * by goal, sample weekly structures, and fat-loss/maintenance plans — in
 * the shared detail sheet (ui/detail-sheet.js) at full height and wide width,
 * with a "Edit FTP & heart rate" button in its header that closes the sheet and
 * lands on those fields in Settings → Profile (the `onOpenSettings` option).
 *
 * The reference page is a separate, self-contained static asset
 * (public/reference/) with its own four inputs (FTP, resting HR, max HR,
 * weight) and its own zone math, built to be dropped into any app
 * unmodified. Rather than re-implement that math here, this just embeds
 * the page in a same-origin iframe and, once it has loaded, writes the
 * rider's current Settings values into its inputs and fires the same
 * 'input' event the page's own fields fire on every keystroke — the
 * page's existing listener re-runs its computation and re-renders every
 * table from there, so this file never touches its zone logic at all.
 * Weight is converted to lb (the reference page's only unit) regardless
 * of the app's own units setting, since that page has no unit toggle of
 * its own. A value the app doesn't have (no FTP entered, no age or max HR
 * on file, no weight logged) is simply left alone — the reference page's
 * own built-in default takes over, same "don't invent a number" rule
 * Settings itself follows for these fields.
 *
 * Two files ship two layouts of the same content, not two feature sets:
 * cardio-zone-reference.html (tabbed panels, wide grid) for wider windows,
 * cardio-zone-reference-mobile.html (stacked accordion) for narrow ones —
 * split at the same 680px width the desktop file's own internal @media
 * rule uses to collapse its grid. Picked when the sheet opens and
 * re-picked live if the window crosses that width while it's still open
 * (rotating a tablet, resizing a desktop window), so the embed always
 * matches the layout its own markup was sized for rather than a wide
 * table getting crushed into a phone-width frame or vice versa. Settings
 * values are re-applied after every such swap, same as on first open.
 *
 * Usage:
 *   cardioZoneReferenceSheet = new CardioZoneReferenceSheet({
 *     profile, resolvedFtp: _resolvedFtp, resolvedMaxHr: _resolvedMaxHr,
 *     onOpenSettings: () => { ... },   // the header button (omit for none)
 *   });
 *   cardioZoneReferenceSheet.open();
 */

import { detailSheet } from './detail-sheet.js';

const DESKTOP_SRC = '/reference/cardio-zone-reference.html';
const MOBILE_SRC = '/reference/cardio-zone-reference-mobile.html';
const MOBILE_BREAKPOINT = '(max-width: 680px)';
const KG_TO_LB = 2.20462;

export class CardioZoneReferenceSheet {
  /**
   * @param {Object} opts
   * @param {Object} opts.profile  Live profile object — read fresh on every
   *   open() (and every responsive swap while open), same as every other
   *   ui/*.js flow that takes `profile`. Only .restingHr and .riderWeight
   *   (kg) are read directly; FTP/max HR go through the resolvers below so
   *   this picks up the same Tanaka-estimate/200W-default fallbacks the
   *   Settings zone strips themselves use.
   * @param {() => number} opts.resolvedFtp        app.js's _resolvedFtp()
   * @param {() => number|null} opts.resolvedMaxHr app.js's _resolvedMaxHr()
   * @param {() => void} [opts.onOpenSettings] the sheet's header button (which should close the sheet
   *   and go to the Profile fields the reference reads from)
   */
  constructor({ profile, resolvedFtp, resolvedMaxHr, onOpenSettings } = {}) {
    this._profile = profile;
    this._resolvedFtp = resolvedFtp;
    this._resolvedMaxHr = resolvedMaxHr;
    this._onOpenSettings = onOpenSettings ?? null;
    this._mql = window.matchMedia(MOBILE_BREAKPOINT);
    this._onMqlChange = () => this._syncSrc();
    this._handle = null;   // the open detail-sheet handle, or null
    this._frame = null;    // the iframe inside it
  }

  get isOpen() { return !!this._handle?.isOpen; }

  open() {
    const actions = this._onOpenSettings
      ? [{ id: 'open-settings', label: 'Edit FTP & heart rate', icon: 'icon-settings', showLabel: true,
           onClick: () => this._onOpenSettings() }]
      : [];
    this._handle = detailSheet.open({
      title: 'Cardio Zone Reference',
      size: 'full',
      width: 'wide',
      flush: true,                                   // the iframe fills the body and scrolls itself
      actions,
      content: (body) => this._build(body),
      onClose: () => {
        this._mql.removeEventListener('change', this._onMqlChange);
        this._frame = null;
        this._handle = null;
      },
    });
    this._mql.addEventListener('change', this._onMqlChange);
    this._syncSrc();
  }

  close() {
    this._handle?.close();
  }

  /** A fresh iframe each time the sheet opens (the sheet empties its body when it closes). */
  _build(host) {
    const frame = document.createElement('iframe');
    frame.className = 'czr-frame';
    frame.title = 'Cardio Zone Reference';
    frame.addEventListener('load', () => {
      this._fillFromSettings();
      // Same-origin: forward Esc from inside the page, where the sheet's own key handler can't see it.
      try {
        frame.contentDocument?.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') this._handle?.requestClose?.() ?? this.close();
        });
      } catch { /* a cross-origin frame can't be reached; the sheet's other ways out still work */ }
    });
    host.appendChild(frame);
    this._frame = frame;
  }

  /** Points the iframe at whichever layout matches the current window
   *  width. A no-op if that layout is already loaded (so a resize that
   *  doesn't cross the breakpoint never reloads/reflashes the frame). */
  _syncSrc() {
    if (!this._frame) return;
    const src = this._mql.matches ? MOBILE_SRC : DESKTOP_SRC;
    if (this._frame.dataset.src === src) return;
    this._frame.dataset.src = src;
    this._frame.src = src;
  }

  /** Writes the rider's saved FTP/resting HR/max HR/weight into the
   *  reference page's four inputs and fires 'input' on each — see the
   *  module doc comment for why this never re-derives the zone math
   *  itself. Runs on every load, including the responsive swap in
   *  _syncSrc(), so the embed always reflects current Settings rather
   *  than whatever the reference page's own localStorage last held. */
  _fillFromSettings() {
    const doc = this._frame?.contentDocument;
    if (!doc) return;

    const ftp = this._resolvedFtp?.();
    const maxHr = this._resolvedMaxHr?.();
    const restingHr = this._profile?.restingHr;
    const weightKg = this._profile?.riderWeight;
    const weightLb = weightKg != null ? Math.round(weightKg * KG_TO_LB) : null;

    this._setField(doc, 'inFtp', ftp);
    this._setField(doc, 'inRhr', restingHr);
    this._setField(doc, 'inMhr', maxHr);
    this._setField(doc, 'inWt', weightLb);
  }

  _setField(doc, id, value) {
    if (value == null || !isFinite(value)) return; // leave the page's own default in place
    const el = doc.getElementById(id);
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

export default CardioZoneReferenceSheet;
