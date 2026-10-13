// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/setup-tiles.js
 *
 * The icon tiles the two setup flows (ui/cardio-session-flow.js, ui/strength-session-flow.js)
 * share. Pure HTML-string builders plus one small DOM patch, so
 * both flows draw a choice (Indoor / Outdoor, Free / Steady / Sequence, a strength Style) and a
 * Bluetooth device the same way.
 *
 *   tileGroupHtml(tiles, { attr, selected })
 *     A row of icon tiles. `tiles` is [{ value, label, icon, blurb? }]; each one is a button
 *     carrying `${attr}="${value}"` (e.g. data-location="indoor"), so the flows' own click
 *     handlers keep finding them by the same data attributes they always used. The selected one
 *     gets `.selected` and aria-pressed.
 *
 *   deviceTileHtml({ prefix, kind, label, icon, status })
 *     One device: the whole tile is the Connect button (`#${prefix}-connect-${kind}`), with a
 *     status ring around its icon (`#${prefix}-dot-${kind}`) and the status in words under the
 *     label, so the state never rests on colour alone. Disabled unless disconnected.
 *
 *   patchDeviceTile(root, prefix, kind, status)
 *     Updates an on-screen device tile in place (a no-op when it isn't rendered).
 *
 *   cardStripHtml({ id, label, cards })  /  bindCardStrip(root, id, { align })
 *     A swipeable strip of cards (the strength flow's Resistance Sequence). `cards` is
 *     [{ html, selected }] — each `html` is a card's own markup (the strip only wraps and
 *     snaps it). The strip is a native scroll-snap track, so a swipe, a trackpad drag and the
 *     arrow keys all work with no pointer code; the next card peeks in at the edge to say
 *     there is more, and a dot row under it follows the scroll. `bindCardStrip` wires the dots
 *     and returns { index, scrollTo(i, smooth) }; `align` ('selected' | a scrollLeft number)
 *     says where the strip starts — a flow re-renders its whole body on every tap, so it hands
 *     the previous scrollLeft back in to keep the strip where the rider left it.
 *     `activeStripIndex()` is the pure part (which card the scroll position is on).
 */

export const DEVICE_STATUS_TEXT = Object.freeze({
  disconnected: 'Connect',
  connecting: 'Connecting…',
  connected: 'Connected',
});

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function _status(status) {
  return status in DEVICE_STATUS_TEXT ? status : 'disconnected';
}

function _icon(id) {
  return `<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#${esc(id)}"/></svg>`;
}

export function tileGroupHtml(tiles, { attr, selected } = {}) {
  const list = tiles ?? [];
  return `
    <div class="sf-tile-group" style="--cols:${Math.max(1, list.length)}">
      ${list.map(t => `
        <button type="button" class="sf-tile${t.value === selected ? ' selected' : ''}" ${attr}="${esc(t.value)}"
          aria-pressed="${t.value === selected}"${t.blurb ? ` title="${esc(t.blurb)}"` : ''}>
          ${t.icon ? _icon(t.icon) : ''}
          <span class="sf-tile-label">${esc(t.label)}</span>
        </button>`).join('')}
    </div>`;
}

export function deviceTileHtml({ prefix, kind, label, icon, status } = {}) {
  const st = _status(status);
  return `
    <button type="button" class="sf-device-tile${st === 'connected' ? ' connected' : ''}"
      id="${esc(prefix)}-connect-${esc(kind)}" ${st !== 'disconnected' ? 'disabled' : ''}>
      <span class="sf-device-ring status-${st}" id="${esc(prefix)}-dot-${esc(kind)}">${_icon(icon)}</span>
      <span class="sf-device-tile-label">${esc(label)}</span>
      <span class="sf-device-tile-status">${DEVICE_STATUS_TEXT[st]}</span>
    </button>`;
}

export function patchDeviceTile(root, prefix, kind, status) {
  const ring = root?.querySelector(`#${prefix}-dot-${kind}`);
  const btn = root?.querySelector(`#${prefix}-connect-${kind}`);
  if (!ring || !btn) return;
  const st = _status(status);
  ring.className = `sf-device-ring status-${st}`;
  btn.disabled = st !== 'disconnected';
  btn.classList.toggle('connected', st === 'connected');
  const text = btn.querySelector('.sf-device-tile-status');
  if (text) text.textContent = DEVICE_STATUS_TEXT[st];
}

// ─── Card strip ───────────────────────────────────────────────────────────

export function cardStripHtml({ id, label, cards } = {}) {
  const list = cards ?? [];
  return `
    <div class="sf-strip" id="${esc(id)}">
      <div class="sf-strip-track" role="listbox" aria-label="${esc(label)}">
        ${list.map(c => `<div class="sf-strip-item${c.selected ? ' selected' : ''}">${c.html}</div>`).join('')}
      </div>
      ${list.length > 1 ? `
        <div class="sf-strip-dots" aria-hidden="true">
          ${list.map((c, i) => `<span class="sf-strip-dot${i === 0 ? ' active' : ''}"></span>`).join('')}
        </div>` : ''}
    </div>`;
}

/**
 * Which card a strip is on. `offsets` are each card's left edge (px, from the track's left),
 * `scrollLeft` the track's scroll position, `maxScroll` the furthest it can scroll. The last
 * card usually can't reach `scrollLeft === its offset` (the track runs out first), so being at
 * the far end counts as being on the last card.
 */
export function activeStripIndex(offsets, scrollLeft, maxScroll) {
  const list = offsets ?? [];
  if (!list.length) return 0;
  if (maxScroll > 0 && scrollLeft >= maxScroll - 1) return list.length - 1;
  let best = 0;
  let bestDist = Infinity;
  list.forEach((o, i) => {
    const d = Math.abs(o - scrollLeft);
    if (d < bestDist) { best = i; bestDist = d; }
  });
  return best;
}

export function bindCardStrip(root, id, { align = 'selected' } = {}) {
  const strip = root?.querySelector(`#${id}`);
  const track = strip?.querySelector('.sf-strip-track');
  if (!track) return null;
  const items = [...track.children];
  const dots = [...strip.querySelectorAll('.sf-strip-dot')];

  const index = () => activeStripIndex(items.map(el => el.offsetLeft - track.offsetLeft), track.scrollLeft, track.scrollWidth - track.clientWidth);
  const paint = () => { const i = index(); dots.forEach((d, n) => d.classList.toggle('active', n === i)); return i; };
  const scrollTo = (i, smooth = false) => {
    const el = items[Math.max(0, Math.min(items.length - 1, i))];
    if (el) track.scrollTo({ left: el.offsetLeft - track.offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
  };

  if (typeof align === 'number') track.scrollLeft = align;
  else { const sel = items.findIndex(el => el.classList.contains('selected')); if (sel > 0) scrollTo(sel); }

  let frame = 0;
  track.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; paint(); });
  }, { passive: true });
  paint();
  return { get index() { return index(); }, scrollTo };
}
