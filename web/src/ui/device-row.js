// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/device-row.js
 *
 * The live cardio chart's device row: a short strip of glass buttons over the chart's top-right corner,
 * one per piece of hardware that was connected when the session started and is not connected now, plus
 * an X to dismiss them. What shows and when is decided in ui/device-row-logic.js (read its doc comment
 * for the rules); this class only holds the state and draws it.
 *
 * Usage (app.js):
 *   const row = new DeviceRow(document.getElementById('chart-container'), {
 *     onConnect: (kind) => ...,          // the same connect handlers the setup flow's tiles use
 *   });
 *   row.begin({ controller: 'connected', hrm: 'disconnected', ... });   // session starts: who was there
 *   row.setStatus('hrm', 'connected');  // every status change app.js reports (full 4-state status)
 *   row.end();                          // session over: forget everything, hide
 *
 * Where it sits: the chart panel is [badge bar][chart track][dots]. The row's anchor is a zero-height
 * block inserted right after the badge bar, and the row is absolutely positioned inside it — so it
 * floats over the top-right of the chart track without being part of the swipeable page (swiping the
 * chart never moves it, and a tap on it never reaches the chart's gesture handlers) and without
 * needing to know how tall the badge bar is.
 */

import {
  rowButtons, offeredKinds, dismissShowing, buttonLabel, isRowKind, normalizeStatus,
} from './device-row-logic.js';

const _esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const _icon = (id) => `<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#${id}"/></svg>`;

export class DeviceRow {
  /**
   * @param {HTMLElement} container  the chart panel
   * @param {{ onConnect?: (kind: string) => void }} [opts]
   */
  constructor(container, { onConnect } = {}) {
    this._onConnect = onConnect ?? (() => {});
    this._active = false;          // between begin() and end()
    this._offered = new Set();     // kinds connected at session start
    this._dismissed = new Set();   // kinds the rider closed
    this._statuses = {};           // kind -> latest status, tracked even while inactive

    this._anchor = document.createElement('div');
    this._anchor.className = 'device-row-anchor';

    this._el = document.createElement('div');
    this._el.className = 'device-row hidden';
    this._el.setAttribute('role', 'group');
    this._el.setAttribute('aria-label', 'Reconnect devices');
    this._anchor.appendChild(this._el);

    // Right after the badge bar if it is there, else first in the panel (the bar prepends itself, so
    // either order of construction ends up bar -> anchor -> track).
    const bar = container.querySelector(':scope > .chart-badge-bar');
    if (bar) bar.after(this._anchor); else container.prepend(this._anchor);

    this._el.addEventListener('click', (e) => this._onClick(e));
  }

  get element() { return this._el; }

  /** The session is starting: remember which devices are here right now. Clears any earlier dismissal. */
  begin(statuses = {}) {
    for (const [kind, status] of Object.entries(statuses)) if (isRowKind(kind)) this._statuses[kind] = normalizeStatus(status);
    this._offered = new Set(offeredKinds(this._statuses));
    this._dismissed = new Set();
    this._active = true;
    this._render();
  }

  /** The session is over (or never started): forget the offer and hide. */
  end() {
    this._active = false;
    this._offered = new Set();
    this._dismissed = new Set();
    this._render();
  }

  /** A device's status changed. Safe at any time; only draws while a session is active. */
  setStatus(kind, status) {
    if (!isRowKind(kind)) return;
    this._statuses[kind] = normalizeStatus(status);
    if (this._active) this._render();
  }

  /** The buttons currently shown, for tests: [{ kind, status, tappable }]. */
  get shown() {
    return this._active ? rowButtons(this._state()).map(({ kind, status, tappable }) => ({ kind, status, tappable })) : [];
  }

  _state() { return { offered: this._offered, dismissed: this._dismissed, statuses: this._statuses }; }

  _onClick(e) {
    if (e.target.closest('[data-device-row-dismiss]')) {
      this._dismissed = new Set(dismissShowing({ ...this._state(), dismissed: [...this._dismissed] }));
      this._render();
      return;
    }
    const btn = e.target.closest('[data-device-row-kind]');
    if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
    this._onConnect(btn.dataset.deviceRowKind);
  }

  _render() {
    const buttons = this._active ? rowButtons(this._state()) : [];
    this._el.classList.toggle('hidden', buttons.length === 0);
    if (buttons.length === 0) { this._el.innerHTML = ''; return; }
    this._el.innerHTML = buttons.map(b => `
      <button type="button" class="device-row-btn${b.animating ? ` is-${b.status}` : ''}"
        data-device-row-kind="${_esc(b.kind)}" style="--device-color:${b.color}"
        aria-label="${_esc(buttonLabel(b))}" title="${_esc(buttonLabel(b))}"${b.tappable ? '' : ' aria-disabled="true"'}>
        ${_icon(b.icon)}
      </button>`).join('') + `
      <button type="button" class="device-row-btn device-row-close" data-device-row-dismiss
        aria-label="Dismiss these device buttons" title="Dismiss these device buttons">${_icon('icon-x')}</button>`;
  }
}
