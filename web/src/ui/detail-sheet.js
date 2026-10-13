// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/detail-sheet.js
 *
 * The one detail sheet: a glass panel that rises over the
 * page on a scrim, built once and reused wherever something wants more room than
 * its tile has — History's session detail first, then the weigh-in review and the
 * Cardio Zone Reference, and (next) the setup flows (§6). It is the panel tier of
 * the material system (`--tier-hero-*`) over the shared `--glass-scrim`.
 *
 * Closing: drag the header down, tap the scrim, press Esc, or the close button.
 * While it is open, Tab stays inside it, and focus goes back to whatever opened
 * it when it closes. Only the grab area (the pill and header) starts a drag — the
 * body is left alone so a chart inside it can keep its own pan and zoom.
 *
 * There is one sheet at a time. Opening a second while one is showing replaces it
 * (the first one's `onClose` runs, and focus still returns to whatever opened the
 * first) rather than stacking them.
 *
 * Usage:
 *   import { detailSheet } from './ui/detail-sheet.js';
 *   const sheet = detailSheet.open({
 *     title: 'Sweet Spot 3x12',
 *     subtitle: 'Sep 30, 2026, 02:14 PM',
 *     size: 'tall',                       // 'auto' (content height) | 'tall' | 'full'
 *     actions: [{ id: 'delete', label: 'Delete', icon: 'icon-trash', onClick: (btn, sheet) => … }],
 *     content: '<p>html string</p>',      // or a Node, or (body, sheet) => void
 *     onClose: () => { … },               // once, after the sheet has gone — tear down charts here
 *   });
 *   sheet.body       // the scrolling content element, for anything that must be built after open
 *   sheet.close()
 *
 * The drag/dismiss/focus arithmetic is in ui/detail-sheet-logic.js (pure, and
 * covered by __detail_sheet_smoketest__.js); this file is the DOM around it.
 */

import {
  dragOffset, dragProgress, flickVelocity, shouldDismiss, nextTabStop, FOCUSABLE_SELECTOR,
} from './detail-sheet-logic.js';

/** If `transitionend` never arrives (a hidden tab, a missing transition), finish closing anyway. */
const CLOSE_FALLBACK_MS = 450;
/** The scrim never fades below this share of full while a drag is in progress. */
const SCRIM_DRAG_FLOOR = 0.4;
/** Transient popups that live outside the sheet (appended to <body>) but belong to it:
 *  Esc closes them first, and focus moving into them is not "straying out". */
// A popup that is *open*. The info popover (ux/info-tooltip.js) is one element created on the first
// tooltip and kept for good, toggling `.visible` — so a bare `.info-popover` matched forever after
// any (i) had been tapped, and Esc never closed the sheet again. The Download menu is built on open and
// removed on close, so it needs no such guard.
const POPUP_SELECTOR = '.format-menu, .info-popover.visible';

let _uid = 0;
const _reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export class DetailSheet {
  /** @param {HTMLElement} host  the `.detail-sheet-host` element; its content is built here. */
  constructor(host) {
    this._host = host;
    this._open = false;
    this._closing = false;
    this._opts = null;
    this._handle = null;
    this._prevFocus = null;
    this._drag = null;
    this._closeTimer = null;
    this._build();
  }

  get isOpen() { return this._open; }

  // ─── Shell ──────────────────────────────────────────────────────────────

  _build() {
    const n = ++_uid;
    this._host.classList.add('detail-sheet-host', 'hidden');
    this._host.setAttribute('data-no-swipe', '');   // app.js's tab-swipe ignores touches that start here
    this._host.innerHTML = `
      <div class="detail-sheet-scrim"></div>
      <div class="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="detail-sheet-title-${n}" tabindex="-1" data-size="auto">
        <div class="detail-sheet-grab">
          <span class="detail-sheet-grabber" aria-hidden="true"></span>
          <div class="detail-sheet-head">
            <div class="detail-sheet-titles">
              <h2 class="detail-sheet-title" id="detail-sheet-title-${n}"></h2>
              <p class="detail-sheet-subtitle" hidden></p>
            </div>
            <div class="detail-sheet-actions"></div>
            <button type="button" class="btn btn-ghost detail-sheet-close" aria-label="Close"><svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg></button>
          </div>
        </div>
        <div class="detail-sheet-body"></div>
      </div>
    `;
    const q = (s) => this._host.querySelector(s);
    this._scrim    = q('.detail-sheet-scrim');
    this._panel    = q('.detail-sheet');
    this._grab     = q('.detail-sheet-grab');
    this._titleEl  = q('.detail-sheet-title');
    this._subEl    = q('.detail-sheet-subtitle');
    this._actionsEl = q('.detail-sheet-actions');
    this._body     = q('.detail-sheet-body');

    this._scrim.addEventListener('click', () => this.requestClose());
    q('.detail-sheet-close').addEventListener('click', () => this.requestClose());

    // Drag to dismiss — from the grab area only (see the header comment).
    this._grab.addEventListener('pointerdown', (e) => this._onDragStart(e));
    this._grab.addEventListener('pointermove', (e) => this._onDragMove(e));
    this._grab.addEventListener('pointerup', (e) => this._onDragEnd(e, false));
    this._grab.addEventListener('pointercancel', (e) => this._onDragEnd(e, true));

    this._onKeydown = (e) => this._keydown(e);
    this._onFocusin = (e) => this._focusin(e);
  }

  // ─── Open / close ───────────────────────────────────────────────────────

  /**
   * @param {Object} opts
   * @param {string}  [opts.title]
   * @param {string}  [opts.subtitle]
   * @param {'auto'|'tall'|'full'} [opts.size='auto']
   * @param {{id:string, label:string, icon:string, showLabel?:boolean, onClick?:Function, setup?:Function}[]} [opts.actions]
   *   Icon buttons in the header, left of Close (`showLabel` adds the label as visible text). `icon` is a sprite id (`icon-trash`). `onClick(btn, sheet)`
   *   runs on tap; `setup(btn, sheet)` runs once on creation, for anything that wires its own listener
   *   (e.g. attachDownloadMenu).
   * @param {string|Node|((body:HTMLElement, sheet:Object)=>void)} [opts.content]
   * @param {'default'|'wide'} [opts.width='default']  `wide` lifts the 560px cap (the Cardio Zone Reference's
   *   desktop layout wants ~1300px); on a phone both are the full screen width
   * @param {boolean} [opts.flush=false]  no padding, gap or scroll on the body: the content fills it and
   *   manages its own scrolling (an iframe, or a layout with a pinned footer)
   * @param {(handle:Object)=>(boolean|void)} [opts.beforeClose]  asked before any *user* close (the Close
   *   button, the scrim, Esc, drag-down). Return `false` to keep the sheet open: the weigh-in editor
   *   uses it to step back from its edit form to its list. `handle.close()` and `detailSheet.close()`
   *   (a tab change, a delete) never ask.
   * @param {()=>void} [opts.onClose]  runs once, after the sheet has fully gone (or been swapped out)
   * @returns {{body:HTMLElement, isOpen:boolean, close:Function, setTitle:Function, setSubtitle:Function}}
   */
  open(opts = {}) {
    // Anything still on its way out — or already showing — is finished off first, but focus
    // is not handed back in between: it goes back to whatever opened the *first* sheet, once
    // the last one closes.
    if (this._open || this._closing) {
      const keep = this._prevFocus;
      this._teardown({ restoreFocus: false });
      this._prevFocus = keep;
    } else {
      this._prevFocus = document.activeElement;
    }

    this._opts = opts;
    const sheet = this;
    const handle = {
      get body() { return sheet._body; },
      get isOpen() { return sheet._handle === handle && sheet._open; },
      close: () => { if (sheet._handle === handle) sheet.close(); },
      setTitle: (t) => { if (sheet._handle === handle) sheet._titleEl.textContent = t ?? ''; },
      setSubtitle: (t) => { if (sheet._handle === handle) sheet._setSubtitle(t); },
    };
    this._handle = handle;

    this._panel.dataset.size = opts.size ?? 'auto';
    this._panel.dataset.width = opts.width ?? 'default';
    this._body.classList.toggle('is-flush', !!opts.flush);
    this._titleEl.textContent = opts.title ?? '';
    this._setSubtitle(opts.subtitle);
    this._renderActions(opts.actions ?? [], handle);
    this._body.scrollTop = 0;
    if (typeof opts.content === 'function') opts.content(this._body, handle);
    else if (opts.content instanceof Node) this._body.appendChild(opts.content);
    else if (opts.content != null) this._body.innerHTML = String(opts.content);

    this._open = true;
    this._closing = false;
    this._host.classList.remove('hidden');
    void this._panel.offsetHeight;                   // so the slide starts from below, not from where it was
    this._host.classList.add('is-open');
    document.addEventListener('keydown', this._onKeydown, true);
    document.addEventListener('focusin', this._onFocusin, true);
    this._panel.focus({ preventScroll: true });
    return handle;
  }

  /** True unless the caller's `beforeClose` says to stay open. */
  _canClose() {
    try { return this._opts?.beforeClose?.(this._handle) !== false; }
    catch (err) { console.error('[detail-sheet] beforeClose threw', err); return true; }
  }

  /** What every user gesture calls (Close button, scrim, Esc): close, unless `beforeClose` vetoes. */
  requestClose() {
    if (this._open && this._canClose()) this.close();
  }

  /** Slides the sheet away, then tears it down. A no-op when it isn't open. Never asks `beforeClose`. */
  close() {
    if (!this._open) return;
    this._open = false;
    this._closing = true;
    document.removeEventListener('keydown', this._onKeydown, true);
    document.removeEventListener('focusin', this._onFocusin, true);
    this._clearDragStyles();
    this._host.classList.remove('is-open');

    if (_reducedMotion()) { this._teardown(); return; }
    const onEnd = (e) => {
      if (e.target !== this._panel || e.propertyName !== 'transform') return;
      this._teardown();
    };
    this._panel.addEventListener('transitionend', onEnd);
    this._endListener = onEnd;
    this._closeTimer = setTimeout(() => this._teardown(), CLOSE_FALLBACK_MS);
  }

  /** Everything that happens once the sheet is actually gone. Safe to call twice.
   *  @param {{restoreFocus?: boolean}} [o]  false when another sheet is about to take its place */
  _teardown({ restoreFocus = true } = {}) {
    clearTimeout(this._closeTimer);
    this._closeTimer = null;
    if (this._endListener) { this._panel.removeEventListener('transitionend', this._endListener); this._endListener = null; }
    const opts = this._opts;
    const prevFocus = this._prevFocus;
    this._opts = null;
    this._handle = null;
    this._open = false;
    this._closing = false;
    this._drag = null;
    document.removeEventListener('keydown', this._onKeydown, true);
    document.removeEventListener('focusin', this._onFocusin, true);
    this._host.classList.remove('is-open');
    this._host.classList.add('hidden');
    this._clearDragStyles();
    this._body.innerHTML = '';
    this._body.classList.remove('is-flush');
    this._panel.dataset.width = 'default';
    this._actionsEl.innerHTML = '';
    this._titleEl.textContent = '';
    this._setSubtitle('');

    try { opts?.onClose?.(); } catch (err) { console.error('[detail-sheet] onClose threw', err); }
    if (restoreFocus && prevFocus?.isConnected && typeof prevFocus.focus === 'function') {
      prevFocus.focus({ preventScroll: true });
    }
    if (restoreFocus) this._prevFocus = null;
  }

  _setSubtitle(text) {
    this._subEl.textContent = text ?? '';
    this._subEl.hidden = !text;
  }

  _renderActions(actions, handle) {
    this._actionsEl.innerHTML = '';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost detail-sheet-action';
      btn.dataset.action = a.id;
      btn.title = a.label;
      btn.setAttribute('aria-label', a.label);
      btn.innerHTML = `<svg class="btn-icon" viewBox="0 0 24 24"><use href="#${a.icon}"/></svg>`;
      if (a.showLabel) {               // a text button (icon + the label), for an action that needs saying out loud
        btn.classList.add('has-label');
        const text = document.createElement('span');
        text.className = 'detail-sheet-action-label';
        text.textContent = a.label;
        btn.appendChild(text);
      }
      if (a.onClick) btn.addEventListener('click', (e) => { e.stopPropagation(); a.onClick(btn, handle); });
      this._actionsEl.appendChild(btn);
      a.setup?.(btn, handle);
    }
  }

  // ─── Keyboard + focus ───────────────────────────────────────────────────

  _keydown(e) {
    if (e.key === 'Escape') {
      if (document.querySelector(POPUP_SELECTOR)) return;   // let the open popup take its own Esc first
      e.preventDefault();
      e.stopPropagation();
      this.requestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const stops = this._focusables();
    const next = nextTabStop(stops.length, stops.indexOf(document.activeElement), e.shiftKey);
    e.preventDefault();
    if (next === -1) this._panel.focus({ preventScroll: true });
    else stops[next].focus();
  }

  _focusin(e) {
    if (this._host.contains(e.target) || e.target.closest?.(POPUP_SELECTOR)) return;
    const stops = this._focusables();
    (stops[0] ?? this._panel).focus({ preventScroll: true });
  }

  _focusables() {
    return [...this._panel.querySelectorAll(FOCUSABLE_SELECTOR)].filter(el => el.offsetParent !== null);
  }

  // ─── Drag to dismiss ────────────────────────────────────────────────────

  _onDragStart(e) {
    if (!this._open || this._drag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button, a, input, select, textarea')) return;   // a tap on Close/Download must stay a tap
    this._drag = {
      id: e.pointerId, y0: e.clientY, dy: 0,
      height: this._panel.offsetHeight,
      samples: [{ t: e.timeStamp, y: e.clientY }],
    };
    this._grab.setPointerCapture?.(e.pointerId);
    this._panel.style.transition = 'none';
    this._scrim.style.transition = 'none';
  }

  _onDragMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    d.dy = e.clientY - d.y0;
    d.samples.push({ t: e.timeStamp, y: e.clientY });
    if (d.samples.length > 12) d.samples.shift();
    const offset = dragOffset(d.dy);
    this._panel.style.transform = `translateY(${offset}px)`;
    this._scrim.style.opacity = String(1 - (1 - SCRIM_DRAG_FLOOR) * dragProgress(offset, d.height));
  }

  _onDragEnd(e, cancelled) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    this._grab.releasePointerCapture?.(e.pointerId);
    const dismiss = !cancelled && shouldDismiss({ dy: d.dy, velocity: flickVelocity(d.samples), height: d.height });
    if (dismiss && this._canClose()) { this.close(); return; }
    this._clearDragStyles();                 // springs back: the CSS transition takes it from here
  }

  /** Hands the panel and scrim back to the stylesheet. The reflow in between is what
   *  lets the transition start from the dragged position instead of jumping. */
  _clearDragStyles() {
    this._panel.style.transition = '';
    this._scrim.style.transition = '';
    void this._panel.offsetHeight;
    this._panel.style.transform = '';
    this._scrim.style.opacity = '';
  }
}

// ─── The shared instance ──────────────────────────────────────────────────
// One host element, created on first use if index.html hasn't already got one,
// so every caller shares the same sheet.

let _instance = null;

function _ensureSheet() {
  if (_instance) return _instance;
  let host = document.getElementById('detail-sheet');
  if (!host) {
    host = document.createElement('div');
    host.id = 'detail-sheet';
    (document.getElementById('app') ?? document.body).appendChild(host);
  }
  _instance = new DetailSheet(host);
  return _instance;
}

export const detailSheet = {
  /** @see DetailSheet#open */
  open: (opts) => _ensureSheet().open(opts),
  /** Closes the sheet if one is open — safe to call from anywhere, e.g. on a tab change. */
  close: () => { _instance?.close(); },
  get isOpen() { return !!_instance?.isOpen; },
};
