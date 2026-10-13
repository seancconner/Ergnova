// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * ui/ble-debug-flow.js
 *
 * Full-screen "BLE Debug Console" overlay — an nRF-Connect-style GATT
 * browser built on ble/gatt-explorer.js. Opened from the Settings tab's
 * Developer section (see app.js). Lets a person:
 *   - scan for and connect to *any* BLE peripheral (not just ones this
 *     app already has a wrapper for),
 *   - browse its full service/characteristic/descriptor tree with names
 *     resolved where possible (ble/gatt-names.js), and copy that whole
 *     tree to the clipboard as plain text regardless of what's expanded
 *     on screen — handy for pasting into an issue/handoff,
 *   - read a characteristic once, subscribe to its notifications, write
 *     raw hex bytes to it, or read one of its descriptors (e.g. checking
 *     the CCCD to confirm a subscription actually took), and
 *   - watch one chronological activity log across every characteristic
 *     (and descriptor read) happening at once, exportable as text.
 *
 * This is the same kind of raw-capture workflow ble/proform-ref/'s
 * btsnoop_hci*_full_summary.txt files represent, just run from inside the
 * app instead of a separate phone tool — meant to make figuring out a new
 * trainer/rower/sensor's protocol (before writing a dedicated ble/*.js
 * wrapper for it) possible without any other software.
 *
 * Same overlay shape as ui/cardio-session-flow.js / ui/strength-session-flow.js
 * (a #container.setup-flow host, hidden by default, populated once in the
 * constructor and toggled via open()/close()) — but unlike those, the
 * underlying GattExplorer connection is intentionally left alive across
 * close()/open(): closing the console is just hiding it, not tearing down
 * an in-progress capture. Only an explicit Disconnect (or the device
 * dropping on its own) ends the BLE session.
 *
 * Usage:
 *   const bleDebugFlow = new BleDebugFlow($('ble-debug-flow'));
 *   openDeveloperConsoleBtn.addEventListener('click', () => bleDebugFlow.open());
 */

import { GattExplorer } from '../ble/gatt-explorer.js';
import { decodeValue } from '../ble/value-decode.js';
import { saveFile } from '../platform/save-file.js';

const MAX_LOG_ENTRIES = 500;

const PROP_ABBR = {
  read: 'READ',
  write: 'WRITE',
  writeWithoutResponse: 'WRITE-NR',
  notify: 'NOTIFY',
  indicate: 'INDICATE',
  broadcast: 'BROADCAST',
  authenticatedSignedWrites: 'SIGNED-WR',
  reliableWrite: 'RELIABLE-WR',
  writableAuxiliaries: 'AUX-WRITE',
};

export class BleDebugFlow {
  /** @param {HTMLElement} container  Full-screen overlay host (hidden by default). */
  constructor(container) {
    this._container = container;
    this._explorer = new GattExplorer();
    this._log = [];           // [{ timestamp, source, charInfo, decoded }]
    this._expandedServices = new Set(); // service uuids currently expanded
    this._error = null;
    this._connecting = false;

    this._explorer.addEventListener('connected',    () => { this._error = null; this._renderBody(); });
    this._explorer.addEventListener('discovered',   () => this._renderBody());
    this._explorer.addEventListener('disconnected', () => this._renderBody());
    this._explorer.addEventListener('value',        (e) => this._handleValue(e.detail));
    this._explorer.addEventListener('write',        (e) => this._handleWrite(e.detail));

    this._render();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /** Shows the overlay. Does not touch any existing BLE connection or log — see file header. */
  open() {
    this._container.classList.remove('hidden');
    this._renderBody();
  }

  /** Hides the overlay only. The connection (if any) and log keep running underneath. */
  close() {
    this._container.classList.add('hidden');
  }

  // ─── Shell (rendered once) ──────────────────────────────────────────────

  _render() {
    this._container.classList.add('setup-flow', 'hidden');
    this._container.innerHTML = `
      <div class="setup-flow-card setup-flow-card--wide">
        <div class="setup-flow-head">
          <span class="setup-flow-head-title">BLE Debug Console</span>
          <button class="setup-flow-close" id="gx-close" title="Close" aria-label="Close">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-x"/></svg>
          </button>
        </div>
        <div class="setup-flow-body gx-body" id="gx-body"></div>
        <div class="setup-flow-foot">
          <button class="btn btn-ghost" id="gx-foot-close">Close</button>
        </div>
      </div>
    `;

    this._container.querySelector('#gx-close').addEventListener('click', () => this.close());
    this._container.querySelector('#gx-foot-close').addEventListener('click', () => this.close());

    // Click on the dimmed backdrop (not the card itself) closes, same as the other setup-flow overlays.
    this._container.addEventListener('click', (e) => {
      if (e.target === this._container) this.close();
    });
    this._keydownHandler = (e) => {
      if (e.key === 'Escape' && !this._container.classList.contains('hidden')) this.close();
    };
    document.addEventListener('keydown', this._keydownHandler);

    this._renderBody();
  }

  // ─── Body routing ───────────────────────────────────────────────────────

  _renderBody() {
    const body = this._container.querySelector('#gx-body');
    if (!body) return;

    if (!GattExplorer.isAvailable) {
      body.innerHTML = this._unavailableHtml();
      return;
    }

    const connected = !!(this._explorer.device && this._explorer.gattServer?.connected);
    if (!connected) {
      body.innerHTML = this._explorer.device ? this._disconnectedHtml() : this._scanHtml();
      this._bindScanEvents();
      return;
    }

    body.innerHTML = this._connectedHtml();
    this._bindConnectedEvents();
  }

  _unavailableHtml() {
    return `
      <p class="sf-sub">This tool needs Web Bluetooth, which isn't available in this browser/shell right now.</p>
      <p class="gx-hint">On a phone/tablet running the packaged native-shell build, or in a browser without Web
        Bluetooth support (Safari, Firefox), the console can't run — try Chrome or Edge on desktop or Android
        instead. Pairing a real trainer/HRM/etc. from the Advanced setup wizard is unaffected either way.</p>
    `;
  }

  _scanHtml() {
    return `
      <p class="sf-sub">Connect to any nearby Bluetooth LE device to inspect its GATT services, characteristics,
        and live notification data — useful for figuring out a new trainer/rower/sensor's protocol before writing
        a dedicated wrapper for it.</p>
      <label class="sf-field">
        <span>Extra service UUID (optional)</span>
        <input type="text" class="input full-width" id="gx-extra-uuid"
          placeholder="e.g. 0000fff0-0000-1000-8000-00805f9b34fb" />
      </label>
      <p class="gx-hint">Web Bluetooth only shows services declared up front — the common ones are already
        included by default. Add a custom UUID here (from the device's docs, or a prior scan) if something isn't
        showing up after connecting.</p>
      ${this._error ? `<div class="gx-error">${_esc(this._error)}</div>` : ''}
      <button class="btn btn-primary full-width" id="gx-scan-btn" ${this._connecting ? 'disabled' : ''}>
        <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-bluetooth"/></svg>
        ${this._connecting ? 'Connecting…' : 'Scan for Device'}
      </button>
    `;
  }

  _disconnectedHtml() {
    return `
      <div class="gx-device-bar">
        <div class="gx-device-info">
          <span class="gx-device-name">${_esc(this._explorer.device.name || 'Unnamed device')}</span>
          <span class="gx-device-status gx-device-status-off">Disconnected</span>
        </div>
        <div class="gx-device-actions">
          <button class="btn btn-primary btn-sm" id="gx-reconnect-btn">Reconnect</button>
          <button class="btn btn-ghost btn-sm" id="gx-scan-btn">Scan for Different Device</button>
        </div>
      </div>
      ${this._error ? `<div class="gx-error">${_esc(this._error)}</div>` : ''}
      ${this._logSectionHtml()}
    `;
  }

  _connectedHtml() {
    const name = this._explorer.device?.name || 'Unnamed device';
    const id = this._explorer.device?.id || '';
    return `
      <div class="gx-device-bar">
        <div class="gx-device-info">
          <span class="gx-device-name">${_esc(name)}</span>
          <span class="gx-device-id">${_esc(id)}</span>
        </div>
        <div class="gx-device-actions">
          <button class="btn btn-ghost btn-sm" id="gx-rediscover-btn" title="Re-run service discovery">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-refresh"/></svg>
          </button>
          <button class="btn btn-danger btn-sm" id="gx-disconnect-btn">Disconnect</button>
        </div>
      </div>
      ${this._error ? `<div class="gx-error">${_esc(this._error)}</div>` : ''}
      <div class="gx-tree-toolbar">
        <span class="gx-tree-title">Services</span>
        <span class="gx-tree-count">${this._explorer.services.length}</span>
        <button type="button" class="btn btn-ghost btn-sm" id="gx-copy-tree" title="Copy the full service/characteristic/descriptor tree"
          ${this._explorer.services.length === 0 ? 'disabled' : ''}>
          <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-duplicate"/></svg>
          Copy Tree
        </button>
      </div>
      <div class="gx-tree">
        ${this._explorer.services.length === 0
          ? '<p class="gx-empty">No services discovered.</p>'
          : this._explorer.services.map((s, si) => this._serviceHtml(si, s)).join('')}
      </div>
      ${this._logSectionHtml()}
    `;
  }

  _logSectionHtml() {
    return `
      <div class="gx-log-section">
        <div class="gx-log-toolbar">
          <span class="gx-log-title">Activity Log</span>
          <span class="gx-log-count">${this._log.length}</span>
          <button class="btn btn-ghost btn-sm" id="gx-copy-log" title="Copy log">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-duplicate"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm" id="gx-download-log" title="Download log as .txt">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-download"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm" id="gx-clear-log" title="Clear log">
            <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-trash"/></svg>
          </button>
        </div>
        <div class="gx-log-list" id="gx-log-list"></div>
      </div>
    `;
  }

  // ─── Service / characteristic tree ──────────────────────────────────────

  _serviceHtml(si, s) {
    const expanded = this._expandedServices.has(s.uuid);
    return `
      <div class="gx-service" data-svc="${si}">
        <button type="button" class="gx-service-head" data-action="toggle-service">
          <svg class="btn-icon gx-chevron" viewBox="0 0 24 24"><use href="#icon-chevron-${expanded ? 'up' : 'down'}"/></svg>
          <span class="gx-service-label">${_esc(s.label)}</span>
          <span class="gx-service-count">${s.characteristics.length} characteristic${s.characteristics.length === 1 ? '' : 's'}</span>
        </button>
        <div class="gx-service-body${expanded ? '' : ' hidden'}">
          ${s.characteristics.map((c, ci) => this._charHtml(si, ci, c)).join('')}
        </div>
      </div>
    `;
  }

  _charHtml(si, ci, c) {
    const hasRead = c.properties.includes('read');
    const hasNotify = c.properties.includes('notify') || c.properties.includes('indicate');
    const hasWrite = c.properties.includes('write') || c.properties.includes('writeWithoutResponse');
    const decoded = c._lastDecoded ?? null;
    return `
      <div class="gx-char" data-svc="${si}" data-char="${ci}">
        <div class="gx-char-head">
          <span class="gx-char-label">${_esc(c.label)}</span>
          <div class="gx-char-badges">
            ${c.properties.map((p) => `<span class="gx-badge">${PROP_ABBR[p] ?? p}</span>`).join('')}
          </div>
          <div class="gx-char-actions">
            ${hasRead ? `<button type="button" class="btn btn-ghost btn-sm" data-action="read">Read</button>` : ''}
            ${hasNotify ? `<button type="button" class="btn btn-ghost btn-sm${c.notifying ? ' gx-notify-active' : ''}" data-action="notify">${c.notifying ? 'Stop' : 'Notify'}</button>` : ''}
            ${hasWrite ? `<button type="button" class="btn btn-ghost btn-sm" data-action="write-toggle">Write</button>` : ''}
            <button type="button" class="btn btn-ghost btn-sm" data-action="toggle-detail" title="Show byte-level detail">
              <svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-chevron-down"/></svg>
            </button>
          </div>
        </div>
        <div class="gx-char-value" id="gx-value-${si}-${ci}">${decoded ? this._valueLineHtml(decoded, 'read', c._lastAt) : '<span class="gx-value-empty">No value read yet.</span>'}</div>
        <div class="gx-char-detail hidden" id="gx-detail-${si}-${ci}">${decoded ? this._detailHtml(decoded) : ''}</div>
        ${c.descriptors.length ? `
          <div class="gx-desc-list">
            ${c.descriptors.map((d, di) => this._descHtml(si, ci, di, d)).join('')}
          </div>` : ''}
        ${hasWrite ? `
          <div class="gx-write-row hidden">
            <input type="text" class="input gx-write-input" placeholder="Hex bytes, e.g. 01 04 4B" />
            <label class="gx-write-resp-label">
              <input type="checkbox" class="gx-write-resp" ${c.properties.includes('write') ? 'checked' : ''} />
              With response
            </label>
            <button type="button" class="btn btn-primary btn-sm" data-action="write-send">Send</button>
          </div>` : ''}
      </div>
    `;
  }

  _descHtml(si, ci, di, d) {
    const decoded = d._lastDecoded ?? null;
    return `
      <div class="gx-desc" data-svc="${si}" data-char="${ci}" data-desc="${di}">
        <span class="gx-desc-tag" title="Descriptor">D</span>
        <span class="gx-desc-label">${_esc(d.label)}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-action="read-descriptor">Read</button>
        <span class="gx-desc-value" id="gx-desc-value-${si}-${ci}-${di}">${decoded ? this._valueLineHtml(decoded, 'read', d._lastAt) : '<span class="gx-value-empty">No value read yet.</span>'}</span>
      </div>
    `;
  }

  _valueLineHtml(decoded, source, timestamp) {
    return `
      <span class="gx-mono">${decoded.hex || '(empty)'}</span>
      ${decoded.known ? `<span class="gx-known">${_esc(decoded.known)}</span>` : ''}
      ${timestamp ? `<span class="gx-value-meta">${_esc(source)} · ${_formatClock(timestamp)}</span>` : ''}
    `;
  }

  _detailHtml(decoded) {
    const rows = [{ label: 'ASCII', value: decoded.ascii || '(empty)' }, ...decoded.numeric];
    return rows.map((r) => `
      <div class="gx-detail-row"><span>${_esc(r.label)}</span><span class="gx-mono">${_esc(r.value)}</span></div>
    `).join('');
  }

  // ─── Event binding ──────────────────────────────────────────────────────

  _bindScanEvents() {
    const $$ = (sel) => this._container.querySelector(sel);
    $$('#gx-scan-btn')?.addEventListener('click', () => this._scan());
    $$('#gx-reconnect-btn')?.addEventListener('click', () => this._reconnect());
    this._bindLogEvents();
    this._renderLog();
  }

  _bindConnectedEvents() {
    const $$ = (sel) => this._container.querySelector(sel);
    $$('#gx-disconnect-btn')?.addEventListener('click', () => this._explorer.disconnect());
    $$('#gx-rediscover-btn')?.addEventListener('click', async () => {
      try {
        await this._explorer.discover();
      } catch (err) {
        this._error = err?.message || 'Rediscovery failed.';
        this._renderBody();
      }
    });
    this._container.querySelector('.gx-tree')?.addEventListener('click', (e) => this._handleTreeClick(e));
    $$('#gx-copy-tree')?.addEventListener('click', (e) => this._copyTree(e.currentTarget));
    this._bindLogEvents();
    this._renderLog();
  }

  _bindLogEvents() {
    const $$ = (sel) => this._container.querySelector(sel);
    $$('#gx-copy-log')?.addEventListener('click', () => this._copyLog());
    $$('#gx-download-log')?.addEventListener('click', () => this._downloadLog());
    $$('#gx-clear-log')?.addEventListener('click', () => this._clearLog());
  }

  _handleTreeClick(e) {
    const serviceHead = e.target.closest('[data-action="toggle-service"]');
    if (serviceHead) {
      const si = Number(serviceHead.closest('.gx-service')?.dataset.svc);
      const uuid = this._explorer.services[si]?.uuid;
      if (uuid == null) return;
      this._expandedServices.has(uuid) ? this._expandedServices.delete(uuid) : this._expandedServices.add(uuid);
      this._renderBody();
      return;
    }

    const detailToggle = e.target.closest('[data-action="toggle-detail"]');
    if (detailToggle) {
      detailToggle.closest('.gx-char')?.querySelector('.gx-char-detail')?.classList.toggle('hidden');
      return;
    }

    const writeToggle = e.target.closest('[data-action="write-toggle"]');
    if (writeToggle) {
      writeToggle.closest('.gx-char')?.querySelector('.gx-write-row')?.classList.toggle('hidden');
      return;
    }

    const readBtn = e.target.closest('[data-action="read"]');
    if (readBtn) {
      const charInfo = this._charInfoFromEl(readBtn);
      if (charInfo) this._read(charInfo, readBtn);
      return;
    }

    const readDescBtn = e.target.closest('[data-action="read-descriptor"]');
    if (readDescBtn) {
      const info = this._descInfoFromEl(readDescBtn);
      if (info) this._readDescriptor(info, readDescBtn);
      return;
    }

    const notifyBtn = e.target.closest('[data-action="notify"]');
    if (notifyBtn) {
      const charInfo = this._charInfoFromEl(notifyBtn);
      if (charInfo) this._toggleNotify(charInfo, notifyBtn);
      return;
    }

    const sendBtn = e.target.closest('[data-action="write-send"]');
    if (sendBtn) {
      const charEl = sendBtn.closest('.gx-char');
      const charInfo = this._charInfoFromEl(sendBtn);
      const input = charEl?.querySelector('.gx-write-input');
      const withResponse = charEl?.querySelector('.gx-write-resp')?.checked;
      if (charInfo && input) this._write(charInfo, input.value, withResponse);
      return;
    }
  }

  _charInfoFromEl(el) {
    const charEl = el.closest('.gx-char');
    if (!charEl) return null;
    const si = Number(charEl.dataset.svc);
    const ci = Number(charEl.dataset.char);
    return this._explorer.services[si]?.characteristics[ci] ?? null;
  }

  /** @returns {{si:number, ci:number, di:number, charInfo:Object, descInfo:Object}|null} */
  _descInfoFromEl(el) {
    const descEl = el.closest('.gx-desc');
    if (!descEl) return null;
    const si = Number(descEl.dataset.svc);
    const ci = Number(descEl.dataset.char);
    const di = Number(descEl.dataset.desc);
    const charInfo = this._explorer.services[si]?.characteristics[ci];
    const descInfo = charInfo?.descriptors[di];
    return charInfo && descInfo ? { si, ci, di, charInfo, descInfo } : null;
  }

  _findCharIndex(charInfo) {
    for (let si = 0; si < this._explorer.services.length; si++) {
      const ci = this._explorer.services[si].characteristics.indexOf(charInfo);
      if (ci !== -1) return { si, ci };
    }
    return null;
  }

  // ─── Actions ─────────────────────────────────────────────────────────────

  async _scan() {
    const extra = this._container.querySelector('#gx-extra-uuid')?.value?.trim();
    this._connecting = true;
    this._error = null;
    this._renderBody();
    try {
      await this._explorer.requestAndConnect(extra ? [extra] : []);
    } catch (err) {
      // A cancelled chooser dialog throws NotFoundError — not a real failure to surface.
      if (err?.name !== 'NotFoundError') this._error = err?.message || 'Failed to connect.';
    } finally {
      this._connecting = false;
      this._renderBody();
    }
  }

  async _reconnect() {
    try {
      await this._explorer.reconnect();
    } catch (err) {
      this._error = err?.message || 'Reconnect failed.';
      this._renderBody();
    }
  }

  async _read(charInfo, btn) {
    btn.disabled = true;
    try {
      await this._explorer.read(charInfo);
    } catch (err) {
      this._error = err?.message || 'Read failed.';
      this._renderBody();
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async _readDescriptor({ si, ci, di, charInfo, descInfo }, btn) {
    btn.disabled = true;
    try {
      const dataView = await this._explorer.readDescriptor(descInfo);
      const decoded = decodeValue(dataView, descInfo.uuid);
      const timestamp = Date.now();
      descInfo._lastDecoded = decoded;
      descInfo._lastAt = timestamp;
      this._pushLog({ timestamp, source: 'read', charInfo, decoded, descInfo });
      const valueEl = this._container.querySelector(`#gx-desc-value-${si}-${ci}-${di}`);
      if (valueEl) valueEl.innerHTML = this._valueLineHtml(decoded, 'read', timestamp);
    } catch (err) {
      this._error = err?.message || 'Descriptor read failed.';
      this._renderBody();
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async _toggleNotify(charInfo, btn) {
    btn.disabled = true;
    try {
      await this._explorer.setNotify(charInfo, !charInfo.notifying);
      btn.textContent = charInfo.notifying ? 'Stop' : 'Notify';
      btn.classList.toggle('gx-notify-active', charInfo.notifying);
    } catch (err) {
      this._error = err?.message || 'Subscribe failed.';
      this._renderBody();
    } finally {
      btn.disabled = false;
    }
  }

  async _write(charInfo, rawText, withResponse) {
    let bytes;
    try {
      bytes = _parseHexBytes(rawText);
    } catch (err) {
      this._error = err.message;
      this._renderBody();
      return;
    }
    try {
      await this._explorer.write(charInfo, bytes, withResponse);
    } catch (err) {
      this._error = err?.message || 'Write failed.';
      this._renderBody();
    }
  }

  // ─── Live value + log updates (DOM patches, not full re-renders — see
  //     file header re: keeping a fast-notifying characteristic smooth) ────

  _handleValue({ charInfo, dataView, source, timestamp }) {
    const decoded = decodeValue(dataView, charInfo.uuid);
    charInfo._lastDecoded = decoded;
    charInfo._lastAt = timestamp;
    this._pushLog({ timestamp, source, charInfo, decoded });
    this._updateCharValueDom(charInfo, decoded, source, timestamp);
  }

  _handleWrite({ charInfo, bytes, withResponse, timestamp }) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoded = decodeValue(dv, charInfo.uuid);
    this._pushLog({ timestamp, source: withResponse ? 'write' : 'write-nr', charInfo, decoded });
  }

  _updateCharValueDom(charInfo, decoded, source, timestamp) {
    const idx = this._findCharIndex(charInfo);
    if (!idx) return;
    const valueEl = this._container.querySelector(`#gx-value-${idx.si}-${idx.ci}`);
    if (valueEl) valueEl.innerHTML = this._valueLineHtml(decoded, source, timestamp);
    const detailEl = this._container.querySelector(`#gx-detail-${idx.si}-${idx.ci}`);
    if (detailEl) detailEl.innerHTML = this._detailHtml(decoded);
  }

  _pushLog(entry) {
    this._log.push(entry);
    if (this._log.length > MAX_LOG_ENTRIES) this._log.shift();
    this._appendLogRow(entry);
  }

  _appendLogRow(entry) {
    const list = this._container.querySelector('#gx-log-list');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'gx-log-row';
    row.innerHTML = this._logRowHtml(entry);
    list.appendChild(row);
    while (list.children.length > MAX_LOG_ENTRIES) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
    const countEl = this._container.querySelector('.gx-log-count');
    if (countEl) countEl.textContent = String(this._log.length);
  }

  _renderLog() {
    const list = this._container.querySelector('#gx-log-list');
    if (!list) return;
    list.innerHTML = this._log.map((e) => `<div class="gx-log-row">${this._logRowHtml(e)}</div>`).join('');
    list.scrollTop = list.scrollHeight;
  }

  _logRowHtml({ timestamp, source, charInfo, decoded, descInfo }) {
    const path = this._logPath(charInfo, descInfo);
    return `
      <span class="gx-log-time">${_formatClock(timestamp)}</span>
      <span class="gx-log-source">${_esc(source)}</span>
      <span class="gx-log-path">${_esc(path)}</span>
      <span class="gx-mono gx-log-hex">${decoded.hex || '(empty)'}</span>
      ${decoded.known ? `<span class="gx-log-known">${_esc(decoded.known)}</span>` : ''}
    `;
  }

  /** "Service / Characteristic" or, for a descriptor read, "Service / Characteristic / Descriptor". */
  _logPath(charInfo, descInfo) {
    const idx = this._findCharIndex(charInfo);
    const svcLabel = idx ? this._explorer.services[idx.si].label : '';
    const parts = [svcLabel, charInfo.label];
    if (descInfo) parts.push(descInfo.label);
    return parts.join(' / ');
  }

  _clearLog() {
    this._log = [];
    this._renderLog();
    const countEl = this._container.querySelector('.gx-log-count');
    if (countEl) countEl.textContent = '0';
  }

  _logAsText() {
    return this._log.map(({ timestamp, source, charInfo, decoded, descInfo }) => {
      const parts = [
        `[${new Date(timestamp).toISOString()}]`,
        source.toUpperCase(),
        this._logPath(charInfo, descInfo),
        `hex=${decoded.hex || '(empty)'}`,
      ];
      if (decoded.known) parts.push(`decoded=${decoded.known}`);
      return parts.join('  ');
    }).join('\n');
  }

  async _copyLog() {
    try {
      await navigator.clipboard.writeText(this._logAsText());
    } catch {
      // Clipboard API can be unavailable/blocked depending on context —
      // fall back to a download so the capture is never just stuck on screen.
      this._downloadLog();
    }
  }

  _downloadLog() {
    const blob = new Blob([this._logAsText()], { type: 'text/plain;charset=utf-8' });
    saveFile(`ble-debug-log-${Date.now()}.txt`, blob);
  }

  // ─── Service tree export ─────────────────────────────────────────────────
  // Text form of the *entire* tree — every service, characteristic, and
  // descriptor — regardless of this._expandedServices (which only affects
  // what's visually collapsed on screen). This is the thing worth pasting
  // into a GitHub issue or handing off when reverse-engineering a device.

  _treeAsText() {
    const name = this._explorer.device?.name || 'Unnamed device';
    const id = this._explorer.device?.id || '';
    const header = `${name}${id ? ` — ${id}` : ''}`;
    if (this._explorer.services.length === 0) return `${header}\n(no services discovered)`;

    const nodes = this._explorer.services.map((s) => ({
      text: `${s.label}  [${s.uuid}]`,
      children: s.characteristics.map((c) => ({
        text: this._charTreeLine(c),
        children: c.descriptors.map((d) => ({ text: this._descTreeLine(d) })),
      })),
    }));
    return [header, ..._drawTree(nodes)].join('\n');
  }

  _charTreeLine(c) {
    const props = c.properties.length ? `  (${c.properties.map((p) => PROP_ABBR[p] ?? p).join(', ')})` : '';
    const value = c._lastDecoded ? this._treeValueSuffix(c._lastDecoded) : '';
    return `${c.label}  [${c.uuid}]${props}${value}`;
  }

  _descTreeLine(d) {
    const value = d._lastDecoded ? this._treeValueSuffix(d._lastDecoded) : '';
    return `${d.label}  [${d.uuid}]${value}`;
  }

  _treeValueSuffix(decoded) {
    return `  = ${decoded.hex || '(empty)'}${decoded.known ? ` (${decoded.known})` : ''}`;
  }

  async _copyTree(btn) {
    try {
      await navigator.clipboard.writeText(this._treeAsText());
      this._flashCopied(btn);
    } catch {
      // Same reasoning as _copyLog(): clipboard access can be blocked
      // depending on context, so fall back to a plain-text download.
      this._downloadTree();
    }
  }

  _downloadTree() {
    const blob = new Blob([this._treeAsText()], { type: 'text/plain;charset=utf-8' });
    saveFile(`ble-service-tree-${Date.now()}.txt`, blob);
  }

  _flashCopied(btn) {
    if (!btn) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<svg class="btn-icon" viewBox="0 0 24 24"><use href="#icon-check"/></svg> Copied`;
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.innerHTML = original;
      btn.disabled = false;
    }, 1500);
  }
}

// ─── Local helpers ──────────────────────────────────────────────────────────

function _formatClock(ts) {
  const d = new Date(ts);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Parses a hex-bytes write field into a Uint8Array. Accepts space/comma-
 * separated pairs with optional "0x" prefixes ("01 04 4B", "0x01,0x04") or
 * one unbroken run ("01044B") — whatever's fastest to paste while staring
 * at a spec or a packet capture.
 * @throws {Error} on anything that isn't a whole number of hex byte pairs.
 */
function _parseHexBytes(str) {
  const cleaned = String(str ?? '').trim();
  if (!cleaned) throw new Error('Enter at least one byte to write.');
  const tokens = cleaned.replace(/0x/gi, '').split(/[\s,]+/).filter(Boolean);
  const hexStr = tokens.join('');
  if (!/^[0-9a-fA-F]+$/.test(hexStr) || hexStr.length % 2 !== 0) {
    throw new Error('Bytes must be hex pairs, e.g. "01 04 4B".');
  }
  const bytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  return bytes;
}

/**
 * Renders a nested `{ text, children? }` list as `tree`-command-style lines
 * with proper box-drawing connectors/continuation bars. Used to flatten the
 * service/characteristic/descriptor tree for clipboard export regardless of
 * what's currently expanded/collapsed on screen.
 * @param {Array<{text: string, children?: Array}>} nodes
 * @param {string} [prefix]
 * @returns {string[]}
 */
function _drawTree(nodes, prefix = '') {
  const lines = [];
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;
    lines.push(`${prefix}${isLast ? '└─ ' : '├─ '}${node.text}`);
    if (node.children?.length) {
      lines.push(..._drawTree(node.children, `${prefix}${isLast ? '   ' : '│  '}`));
    }
  });
  return lines;
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export default BleDebugFlow;
