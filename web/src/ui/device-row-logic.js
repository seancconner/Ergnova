// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/device-row-logic.js
 *
 * What the live chart's device row (ui/device-row.js) shows, as pure functions so the rules can be
 * read and tested without a DOM.
 *
 * The row is a short strip of buttons over the live chart's top-right corner, one per piece of
 * hardware the rider had connected when the cardio session started. Its rules:
 *
 *   - A kind is OFFERED only if it was connected at session start (`offered`). A device that wasn't
 *     there during setup never gets a button — not when it connects later and drops, not ever, this
 *     session. That is what makes the row a "get it back" prompt rather than a generic connect panel.
 *   - An offered kind shows a button while it is NOT connected, and none while it is. Connected ->
 *     the button goes; dropped -> it comes back.
 *   - The X on the row dismisses the buttons showing right now. Those kinds stay dismissed for the
 *     rest of the session (the rider said they aren't using them), but a kind that was connected at
 *     that moment is not dismissed: if it drops later, its button still appears. A blanket "hide the
 *     row" would silently hide the one prompt that matters, say a trainer dropping mid-ride after
 *     the rider closed the row because the heart-rate strap died.
 *
 * Kinds and statuses are the ones app.js's _setDeviceStatus() already reports to the setup flows:
 * 'controller' | 'hrm' | 'smo2' | 'coreTemp', and 'connected' | 'connecting' | 'reconnecting' |
 * 'disconnected'.
 */

/** Display order, and what each kind looks like. Same four as the setup flow's device tiles. */
export const DEVICE_ROW_KINDS = Object.freeze([
  { kind: 'controller', label: 'trainer',                 icon: 'icon-bike',        color: 'var(--color-power)' },
  { kind: 'hrm',        label: 'heart rate monitor',      icon: 'icon-heart',       color: 'var(--color-hr)' },
  { kind: 'smo2',       label: 'muscle oxygen sensor',    icon: 'icon-droplet',     color: 'var(--color-smo2)' },
  { kind: 'coreTemp',   label: 'core temperature sensor', icon: 'icon-thermometer', color: 'var(--color-temp)' },
]);

export const DEVICE_ROW_STATUSES = ['connected', 'connecting', 'reconnecting', 'disconnected'];

const _KNOWN = new Set(DEVICE_ROW_KINDS.map(k => k.kind));

/** An unrecognised status reads as 'disconnected' — the face that lets the rider fix things. */
export function normalizeStatus(status) {
  return DEVICE_ROW_STATUSES.includes(status) ? status : 'disconnected';
}

/**
 * Which kinds the row will ever offer this session: the ones connected right now. Called once, as
 * the session starts.
 * @param {Object<string,string>} statuses  kind -> status
 * @returns {string[]}
 */
export function offeredKinds(statuses = {}) {
  return DEVICE_ROW_KINDS.map(k => k.kind).filter(kind => statuses[kind] === 'connected');
}

/**
 * The buttons to draw, in display order.
 * @param {{ offered: Iterable<string>, dismissed?: Iterable<string>, statuses?: Object<string,string> }} state
 * @returns {{ kind:string, label:string, icon:string, color:string, status:string, tappable:boolean, animating:boolean }[]}
 */
export function rowButtons({ offered = [], dismissed = [], statuses = {} } = {}) {
  const offeredSet = new Set(offered);
  const dismissedSet = new Set(dismissed);
  const out = [];
  for (const def of DEVICE_ROW_KINDS) {
    if (!offeredSet.has(def.kind) || dismissedSet.has(def.kind)) continue;
    const status = normalizeStatus(statuses[def.kind]);
    if (status === 'connected') continue;
    out.push({
      ...def,
      status,
      // 'connecting' is an attempt already in flight — a second tap can't queue up behind it.
      // 'reconnecting' stays tappable: the app is quietly listening for the device to return, and a
      // tap is how the rider says "stop waiting, I'll pick one myself" (same as ui/hr-slot.js).
      tappable: status !== 'connecting',
      animating: status === 'connecting' || status === 'reconnecting',
    });
  }
  return out;
}

/**
 * What the X dismisses: everything already dismissed, plus the buttons showing right now.
 * @returns {string[]}
 */
export function dismissShowing({ offered = [], dismissed = [], statuses = {} } = {}) {
  const showing = rowButtons({ offered, dismissed, statuses }).map(b => b.kind);
  return [...new Set([...dismissed, ...showing])];
}

/** True for a kind the row knows about (app.js reports others, e.g. nothing today, that it ignores). */
export function isRowKind(kind) { return _KNOWN.has(kind); }

/** The accessible name for a button: what it does, and what state it is in. */
export function buttonLabel(button) {
  if (button.status === 'connecting')   return `Connecting ${button.label}`;
  if (button.status === 'reconnecting') return `Reconnecting ${button.label} \u2014 tap to pick a device instead`;
  return `Connect ${button.label}`;
}
