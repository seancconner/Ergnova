// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ux/info-tooltip.js
 *
 * The Settings page's old loose `.settings-sub` caption paragraphs (age/sex
 * note, VO2max methodology, FTP test protocols, power-zone note) are now
 * small `<button class="info-btn" data-tip="...">` icons instead. This
 * module drives all of them — and any other `[data-tip]` element, button or
 * not (e.g. strength-session-flow.js's "+N more" sequence-card chip) — from a
 * single delegated click listener on `document`, so a new one just works
 * without needing to be wired up individually.
 *
 * One floating `.info-popover` div (see .info-popover in style.css) is
 * created lazily, appended to <body>, and repositioned against whichever
 * button is currently open — clamped to the viewport, flipped above the
 * button if it would overflow the bottom edge.
 *
 * Usage:
 *   import { infoTooltips } from './ux/info-tooltip.js';
 *   infoTooltips.init();        // once, in app init()
 *   infoTooltips.closeAll();    // e.g. before switching tabs
 */

const VIEWPORT_MARGIN = 8; // min gap kept between the popover and the screen edge
const GAP             = 6; // gap between the trigger button and the popover

let _popover  = null;   // the single floating .info-popover div, lazily created
let _openBtn  = null;   // the .info-btn currently showing its tip, or null
let _initDone = false;

function _ensurePopover() {
  if (_popover) return _popover;
  _popover = document.createElement('div');
  _popover.className = 'info-popover';
  _popover.setAttribute('role', 'tooltip');
  document.body.appendChild(_popover);
  return _popover;
}

// Positions the (already-visible, already-filled-in) popover against `btn`,
// clamped to the viewport on every side. Assumes the popover's real size is
// measurable — call after its text/visible state is set, not before.
function _position(btn) {
  const pop = _popover;
  const btnRect = btn.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = btnRect.left;
  left = Math.min(left, vw - popRect.width - VIEWPORT_MARGIN);
  left = Math.max(left, VIEWPORT_MARGIN);

  let top = btnRect.bottom + GAP;
  if (top + popRect.height + VIEWPORT_MARGIN > vh) {
    // Doesn't fit below — flip above the button instead.
    top = btnRect.top - popRect.height - GAP;
  }
  top = Math.max(VIEWPORT_MARGIN, top);

  pop.style.left = `${left}px`;
  pop.style.top  = `${top}px`;
}

function _open(btn) {
  const pop = _ensurePopover();
  pop.textContent = btn.dataset.tip || '';
  pop.classList.add('visible');
  _openBtn = btn;
  btn.classList.add('active');
  btn.setAttribute('aria-expanded', 'true');
  _position(btn);
}

function _close() {
  if (!_openBtn) return;
  _openBtn.classList.remove('active');
  _openBtn.setAttribute('aria-expanded', 'false');
  _openBtn = null;
  _popover?.classList.remove('visible');
}

function _onDocClick(e) {
  const btn = e.target.closest?.('[data-tip]');
  if (btn) {
    // Don't let this reach the outside-click branch below, and don't let
    // it bubble into whatever else might be listening for document clicks
    // (trainer menu / fab menu dismissal, etc.).
    e.stopPropagation();
    if (_openBtn === btn) _close();
    else _open(btn);
    return;
  }
  // Click landed anywhere else — including on the popover itself, which
  // has no interactive content of its own — so close if one is open.
  if (_openBtn) _close();
}

function _onKeydown(e) {
  if (e.key === 'Escape' && _openBtn) _close();
}

let _flashHideTimer = null;

export const infoTooltips = {
  init() {
    if (_initDone) return;
    _initDone = true;
    document.addEventListener('click', _onDocClick);
    document.addEventListener('keydown', _onKeydown);
    // Scroll doesn't bubble from an arbitrary scrolled ancestor (e.g. the
    // settings .panel itself), so this has to run in the capture phase to
    // ever see it. The popover is position:fixed against the trigger's
    // on-screen rect, so once that scrolls the tip is just wrong — close
    // rather than try to keep it glued to a button that's moving.
    window.addEventListener('scroll', () => { if (_openBtn) _close(); }, true);
    window.addEventListener('resize', () => { if (_openBtn) _close(); });
  },

  closeAll() {
    _close();
  },

  // A one-off, auto-dismissing popover — same look as the persistent
  // info-btn tooltip above, positioned against whatever element is passed
  // in rather than a specific .info-btn, and with no open/close toggle
  // state of its own (repeated calls just reposition + restart the timer).
  // So far the only caller is app.js's screen-lock reminder ("tap anything
  // but the unlock button while locked").
  flash(nearEl, text, { durationMs = 1600 } = {}) {
    if (!nearEl) return;
    const pop = _ensurePopover();
    pop.textContent = text;
    pop.classList.add('visible');
    _position(nearEl);
    clearTimeout(_flashHideTimer);
    _flashHideTimer = setTimeout(() => {
      // Don't stomp on a real info-btn tooltip that opened after this call
      // — extremely unlikely in practice (locking and Settings aren't the
      // same view) but cheap to guard against.
      if (_openBtn) return;
      pop.classList.remove('visible');
    }, durationMs);
  },
};

export default infoTooltips;
