// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ux/fit-text.js
 *
 * Shrinks text down to fit its box instead of truncating it with an
 * ellipsis — used anywhere a long workout name or a wide stat (e.g.
 * "1,284 kcal") used to get cut off mid-word: history cards (History tab
 * + Overview's Recent Sessions), the workout editor's step rows, and the
 * live session HUD's title/step-name.
 *
 * Usage: call fitText(container, selector) once right after new content
 * is rendered into `container`, while it's actually visible/laid out —
 * nothing measurable happens on a display:none panel. The call also
 * registers (container, selector) so a later window resize re-fits it
 * automatically, which covers rotating a phone or resizing the window
 * without every call site needing its own resize handling. For content
 * that's first rendered while its panel is hidden (e.g. at app startup,
 * before that tab has ever been shown), re-call fitText from whatever
 * "this panel just became visible" hook that view already has — same
 * idea as re-measuring a canvas once it's actually on screen.
 *
 * Each element is always re-measured from its natural (CSS-defined)
 * font-size rather than shrinking further from whatever size a previous
 * call left it at, so it grows back if the text or the box changes.
 * Below a legibility floor it just stops shrinking and lets the
 * existing `overflow: hidden` clip it cleanly — no "…" is ever added.
 */

const MIN_PX = 9;    // legibility floor — never shrink smaller than this
const STEP   = 0.5;  // px removed per iteration

function _shrinkOne(el) {
  el.style.fontSize = '';
  const natural = parseFloat(getComputedStyle(el).fontSize);
  if (!natural) return;
  let size = natural;
  while (el.scrollWidth > el.clientWidth + 0.5 && size > MIN_PX) {
    size -= STEP;
    el.style.fontSize = size + 'px';
  }
}

// (container, selector) pairs seen so far, so the resize listener below
// can re-fit them all without every call site wiring up its own handler.
// Keyed by reference/string so re-rendering the same panel over and over
// (e.g. every history list refresh) doesn't grow this list.
const _watchers = [];

export function fitText(container, selector) {
  if (!container) return;
  container.querySelectorAll(selector).forEach(_shrinkOne);
  if (!_watchers.some(w => w.container === container && w.selector === selector)) {
    _watchers.push({ container, selector });
  }
}

let _resizePending = false;
window.addEventListener('resize', () => {
  if (_resizePending) return;
  _resizePending = true;
  requestAnimationFrame(() => {
    _resizePending = false;
    for (const { container, selector } of _watchers) {
      // Skip panels that are currently hidden (display:none collapses
      // clientWidth to 0) — they'll get a correct measurement whenever
      // they're next shown and fitText() is called again.
      if (container.isConnected && container.clientWidth > 0) {
        container.querySelectorAll(selector).forEach(_shrinkOne);
      }
    }
  });
});
