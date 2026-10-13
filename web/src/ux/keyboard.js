// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ux/keyboard.js
 *
 * Centralised keyboard shortcut handler for a live session.
 * Decoupled from app.js so shortcuts can be unit-tested and the binding
 * can be enabled/disabled without touching the rest of the app.
 *
 * Shortcuts:
 *   Space       — Start / Stop session
 *   L           — Mark lap
 *   ↑ / ↓       — Nudge current target up / down
 *   E           — Switch to ERG mode
 *   R           — Switch to Resistance mode
 *   S           — Switch to Slope mode
 *   V           — Switch to Virtual Gear mode
 *   ← / →       — Shift gear down / up (Virtual Gear mode only)
 *   Escape      — Cancel / deactivate all modes
 *
 * Usage:
 *   import { KeyboardController } from './ux/keyboard.js';
 *   const kb = new KeyboardController({
 *     onStart, onStop, onLap, onNudge, onModeSwitch, onShift,
 *   });
 *   kb.enable();
 *   kb.disable(); // e.g. when a modal is open
 */

export const SHORTCUT_MAP = Object.freeze({
  ' ':          'startStop',
  'l': 'lap', 'L': 'lap',
  'ArrowUp':    'nudgeUp',
  'ArrowDown':  'nudgeDown',
  'ArrowLeft':  'shiftDown',
  'ArrowRight': 'shiftUp',
  'e': 'modeErg',       'E': 'modeErg',
  'r': 'modeResistance','R': 'modeResistance',
  's': 'modeSlope',     'S': 'modeSlope',
  'v': 'modeGear',      'V': 'modeGear',
  'Escape': 'cancel',
});

export class KeyboardController {
  /**
   * @param {Object} handlers
   * @param {Function} [handlers.onStart]       () => void
   * @param {Function} [handlers.onStop]        () => void
   * @param {Function} [handlers.onLap]         () => void
   * @param {Function} [handlers.onNudge]       (direction: +1|-1) => void
   * @param {Function} [handlers.onModeSwitch]  (mode: string) => void
   * @param {Function} [handlers.onShift]       (direction: 'up'|'down') => void
   * @param {Function} [handlers.onCancel]      () => void
   * @param {Function} [handlers.isRunning]     () => boolean — if provided, used to toggle start/stop
   */
  constructor(handlers = {}) {
    this._handlers = handlers;
    this._enabled  = false;
    this._listener = this._onKey.bind(this);
  }

  /** Attach to window.document. */
  enable() {
    if (this._enabled) return;
    this._enabled = true;
    document.addEventListener('keydown', this._listener);
  }

  /** Detach from window.document. */
  disable() {
    this._enabled = false;
    document.removeEventListener('keydown', this._listener);
  }

  _onKey(e) {
    // A widget that already handled this key (a card or tile that opens on Enter/Space, say)
    // has called preventDefault(): leave it alone. Without this, Space on a focused tile both
    // opened its sheet and fired the Start/Stop shortcut, which switched tabs and closed it.
    if (e.defaultPrevented) return;

    // Never intercept when the user is typing in a text field
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const action = SHORTCUT_MAP[e.key];
    if (!action) return;

    // Prevent default scroll/space behavior
    e.preventDefault();

    const h = this._handlers;
    switch (action) {
      case 'startStop': {
        const running = h.isRunning?.() ?? false;
        running ? h.onStop?.() : h.onStart?.();
        break;
      }
      case 'lap':           h.onLap?.();                   break;
      case 'nudgeUp':       h.onNudge?.(+1);               break;
      case 'nudgeDown':     h.onNudge?.(-1);               break;
      case 'shiftUp':       h.onShift?.('up');             break;
      case 'shiftDown':     h.onShift?.('down');           break;
      case 'modeErg':       h.onModeSwitch?.('erg');       break;
      case 'modeResistance':h.onModeSwitch?.('resistance');break;
      case 'modeSlope':     h.onModeSwitch?.('slope');     break;
      case 'modeGear':      h.onModeSwitch?.('virtualGear');break;
      case 'cancel':        h.onCancel?.();                break;
    }
  }
}

export default KeyboardController;
