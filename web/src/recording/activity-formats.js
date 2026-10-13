// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * recording/activity-formats.js
 *
 * Multi-format export for a completed SessionRecord — a real *recording*
 * (free ride, structured workout, or fitness test), as opposed to
 * formats/*.js, which round-trips WorkoutModel *plans*. Every session that
 * lands in history — including FTP/VO2max test rides, whose estimated
 * result is attached to record.meta.testResult by app.js's
 * _persistTestResult() — can be exported through here in whichever format
 * the rider needs downstream:
 *
 *   FIT   Binary, delegates to fit-activity.js. Garmin Connect /
 *         TrainingPeaks / Strava (manual upload).
 *   TCX   Garmin Training Center XML *activity* document — same ecosystem
 *         as FIT, plus WKO/other analysis tools that read TCX but not FIT.
 *         Distinct from formats/tcx.js, which reads/writes TCX *workout*
 *         plans, not recorded rides.
 *   CSV   One row per recorded sample, plus a commented summary/test-result
 *         header — spreadsheets and ad-hoc analysis.
 *   JSON  The SessionRecord verbatim (pretty-printed) — full-fidelity
 *         backup, or feeding a rider's own scripts.
 *
 * Usage:
 *   import { ACTIVITY_FORMATS, downloadActivity, renderDownloadControl }
 *     from './recording/activity-formats.js';
 *
 *   downloadActivity(record, 'tcx');                 // direct
 *   renderDownloadControl(containerEl, record);       // drop-in <select>
 */

import { buildFitActivity } from './fit-activity.js';
import { saveFile } from '../platform/save-file.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isoTime(unixMs) {
  return new Date(unixMs).toISOString();
}

/** Human label for a fitness-test-tagged record, or null for an ordinary ride. */
function testTypeLabel(record) {
  const labels = {
    'vo2max-ramp': 'VO2 Max Ramp Test',
    'ftp-ramp':    'FTP Ramp Test',
    'ftp-20min':   'FTP 20-Minute Test',
    'resting-hr':  'Resting Heart Rate Test',
  };
  return labels[record?.meta?.testType] ?? null;
}

/** Filesystem-safe `date_name` shared by every format's filename. */
export function activityFilenameBase(record) {
  const date = new Date(record.startTime).toISOString().slice(0, 10);
  const name = (record.workoutName ?? testTypeLabel(record) ?? 'workout').replace(/[^a-z0-9]/gi, '_');
  return `${date}_${name}`;
}

// ─── TCX activity ─────────────────────────────────────────────────────────────

/**
 * Builds a Garmin TCX *Activity* document: one <Lap> per marked lap (or a
 * single lap spanning the whole ride when none were marked) containing a
 * <Trackpoint> per recorded sample. No <Position> is written — this is
 * indoor-trainer data with no real GPS fix, and TCX's schema doesn't
 * require one.
 * @param {SessionRecord} record
 * @returns {string}
 */
export function buildTcxActivity(record) {
  const { samples = [], laps = [] } = record;
  const testName = testTypeLabel(record);

  const bounds = [0, ...laps.map(l => l.sampleIndex), samples.length];
  const lapXml = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] <= bounds[i]) continue; // skip a lap marked twice at the same sample
    lapXml.push(_tcxLap(samples, bounds[i], bounds[i + 1]));
  }
  if (lapXml.length === 0 && samples.length) lapXml.push(_tcxLap(samples, 0, samples.length));

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${isoTime(record.startTime)}</Id>
${lapXml.join('\n')}
      <Notes>${esc(testName ?? record.workoutName ?? 'Free Ride')}</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;
}

function _tcxLap(samples, startIdx, endIdx) {
  const slice = samples.slice(startIdx, endIdx);
  const start = slice[0];
  const end   = slice[slice.length - 1];
  const durSec = Math.max(0, (end.timestamp - start.timestamp) / 1000);

  const powers = slice.map(s => s.power).filter(v => v != null);
  const hrs    = slice.map(s => s.heartRate).filter(v => v != null);
  const avgHr  = hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null;
  const maxHr  = hrs.length ? Math.max(...hrs) : null;
  const avgPow = powers.length ? Math.round(powers.reduce((a, b) => a + b, 0) / powers.length) : null;
  const maxPow = powers.length ? Math.max(...powers) : null;

  // distance/calories in a Sample are cumulative-since-session-start, so a
  // lap's own contribution is the delta from the last sample of the
  // previous lap (0 for the first lap).
  const prevDist = startIdx > 0 ? (samples[startIdx - 1].distance ?? 0) : 0;
  const prevCal  = startIdx > 0 ? (samples[startIdx - 1].calories ?? 0) : 0;
  const distCovered = end.distance != null ? Math.max(0, end.distance - prevDist) : 0;
  const calCovered  = end.calories != null ? Math.max(0, Math.round(end.calories - prevCal)) : 0;

  const trackpoints = slice.map(_tcxTrackpoint).join('\n');
  const powerExt = avgPow != null
    ? `\n        <Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">${maxPow != null ? `<MaxWatts>${maxPow}</MaxWatts>` : ''}<AvgWatts>${avgPow}</AvgWatts></TPX></Extensions>`
    : '';

  return `      <Lap StartTime="${isoTime(start.timestamp)}">
        <TotalTimeSeconds>${durSec.toFixed(1)}</TotalTimeSeconds>
        <DistanceMeters>${distCovered.toFixed(1)}</DistanceMeters>
        <Calories>${calCovered}</Calories>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>${avgHr != null ? `\n        <AverageHeartRateBpm><Value>${avgHr}</Value></AverageHeartRateBpm>` : ''}${maxHr != null ? `\n        <MaximumHeartRateBpm><Value>${maxHr}</Value></MaximumHeartRateBpm>` : ''}
        <Track>
${trackpoints}
        </Track>${powerExt}
      </Lap>`;
}

function _tcxTrackpoint(s) {
  const lines = [`        <Trackpoint>`, `          <Time>${isoTime(s.timestamp)}</Time>`];
  if (s.distance  != null) lines.push(`          <DistanceMeters>${s.distance.toFixed(1)}</DistanceMeters>`);
  if (s.heartRate != null) lines.push(`          <HeartRateBpm><Value>${Math.round(s.heartRate)}</Value></HeartRateBpm>`);
  if (s.cadence   != null) lines.push(`          <Cadence>${Math.round(s.cadence)}</Cadence>`);
  if (s.speed != null || s.power != null) {
    lines.push(`          <Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">`);
    if (s.speed != null) lines.push(`            <Speed>${(s.speed / 3.6).toFixed(3)}</Speed>`);
    if (s.power != null) lines.push(`            <Watts>${Math.round(s.power)}</Watts>`);
    lines.push(`          </TPX></Extensions>`);
  }
  lines.push(`        </Trackpoint>`);
  return lines.join('\n');
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = ['elapsedTime', 'timestamp', 'power', 'heartRate', 'cadence', 'speed', 'distance', 'calories'];

/**
 * One row per recorded sample, prefixed with a commented block of
 * summary/test-result info (so the file is self-describing when opened
 * outside a spreadsheet too). Comment lines start with `#`, which every
 * common CSV/spreadsheet importer treats as a normal (if slightly odd)
 * text row rather than failing to parse — the data table itself starts
 * clean after a blank line.
 * @param {SessionRecord} record
 * @returns {string}
 */
export function buildCsvActivity(record) {
  const { samples = [], summary = {}, meta = {} } = record;
  const label = testTypeLabel(record);

  const headerLines = [
    `# Workout: ${record.workoutName ?? label ?? 'Free Ride'}`,
    `# Date: ${isoTime(record.startTime)}`,
    `# Duration (s): ${record.duration ?? ''}`,
    label ? `# Test type: ${label}` : null,
    summary.avgPower        != null ? `# Avg power (W): ${summary.avgPower}` : null,
    summary.normalizedPower != null ? `# Normalized power (W): ${summary.normalizedPower}` : null,
    summary.avgHr           != null ? `# Avg HR (bpm): ${summary.avgHr}` : null,
    summary.avgCadence      != null ? `# Avg cadence (rpm): ${summary.avgCadence}` : null,
    summary.totalDistance   != null ? `# Distance (m): ${summary.totalDistance}` : null,
    summary.totalCalories   != null ? `# Calories (kcal): ${Math.round(summary.totalCalories)}` : null,
    meta.testResult ? `# Test result: ${_formatTestResult(meta.testResult)}` : null,
  ].filter(Boolean);

  const rows = samples.map(s => CSV_COLUMNS.map(col => {
    if (col === 'timestamp') return isoTime(s.timestamp);
    const v = s[col];
    return v == null ? '' : v;
  }).join(','));

  return [...headerLines, '', CSV_COLUMNS.join(','), ...rows].join('\n');
}

function _formatTestResult(testResult) {
  const parts = Object.entries(testResult?.metrics ?? {}).map(([k, v]) => `${k}=${v}`);
  return [testResult?.label, parts.join(', ')].filter(Boolean).join(' — ');
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

/**
 * The SessionRecord verbatim, pretty-printed — full fidelity (every
 * sample field, laps, meta, summary, and any attached testResult), meant
 * for backup or for a rider's own analysis scripts rather than import
 * into another fitness platform.
 * @param {SessionRecord} record
 * @returns {string}
 */
export function buildJsonActivity(record) {
  return JSON.stringify(record, null, 2);
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const ACTIVITY_FORMATS = {
  fit:  { id: 'fit',  label: 'FIT',  ext: '.fit',  mime: 'application/octet-stream', binary: true,  build: (r) => buildFitActivity(r) },
  tcx:  { id: 'tcx',  label: 'TCX',  ext: '.tcx',  mime: 'application/xml',          binary: false, build: buildTcxActivity },
  csv:  { id: 'csv',  label: 'CSV',  ext: '.csv',  mime: 'text/csv',                 binary: false, build: buildCsvActivity },
  json: { id: 'json', label: 'JSON', ext: '.json', mime: 'application/json',         binary: false, build: buildJsonActivity },
};

/**
 * Builds the given format and saves it — a browser download on the web/PWA,
 * the native save/share sheet inside the MAUI shell (platform/save-file.js).
 * @param {SessionRecord} record
 * @param {'fit'|'tcx'|'csv'|'json'} formatId
 */
export function downloadActivity(record, formatId) {
  const fmt = ACTIVITY_FORMATS[formatId];
  if (!fmt) throw new Error(`[activity-formats] Unknown format: ${formatId}`);

  const built = fmt.build(record);
  const blob  = new Blob([built], { type: fmt.binary ? fmt.mime : `${fmt.mime};charset=utf-8` });
  const name  = `${activityFilenameBase(record)}${fmt.ext}`;

  saveFile(name, blob);
}

/**
 * Drops a single "Download…" <select> into `container`, populated with
 * every format in ACTIVITY_FORMATS, wired to call downloadActivity() with
 * `record` and immediately reset to the placeholder — same
 * pick-and-go combo used by the workout editor's Export select
 * (editor/workout-editor.js's #we-export-select), so download UI looks
 * and behaves the same everywhere it appears (completion banners, history
 * list, history detail). Overwrites whatever `container` currently holds;
 * safe to call repeatedly (e.g. history-browser.js re-rendering a list) or
 * on several containers for different records at once — each <select> is
 * independent.
 * @param {HTMLElement} container
 * @param {SessionRecord} record
 * @param {{ placeholder?: string, selectClass?: string }} [opts]
 */
export function renderDownloadControl(container, record, opts = {}) {
  const { placeholder = 'Select a download format', selectClass = 'input download-select' } = opts;

  container.innerHTML = `
    <select class="${selectClass}" aria-label="Download format">
      <option value="" selected>${esc(placeholder)}</option>
      ${Object.values(ACTIVITY_FORMATS).map(f => `<option value="${f.id}">${esc(f.label)}</option>`).join('')}
    </select>
  `;

  container.querySelector('select').addEventListener('change', (e) => {
    const formatId = e.target.value;
    e.target.value = '';
    if (formatId) downloadActivity(record, formatId);
  });
}

// ─── Format picker popup (history-list download button) ───────────────────────
//
// A native <select> (renderDownloadControl above) is fine where there's a
// visible control to style, but the History tab's download button is a
// small icon with nothing to hang a <select>'s browser-drawn dropdown from
// in a chosen direction. attachDownloadMenu() instead pops a small custom
// menu listing every ACTIVITY_FORMATS entry, positioned from the button's
// actual on-screen position so it can be forced to open from the button's
// LEFT side — these buttons sit at a card's right edge (.history-card-actions),
// where a menu growing rightward would run off the edge of the screen.

let _openMenu = null; // { el, buttonEl, onOutside, onKeydown } — one at a time

/** Closes any open format-picker popup, if one exists. Exported so a view
 *  can clean up before it tears down/replaces the button a menu might be
 *  anchored to (e.g. history-browser.js re-rendering its list) — normal
 *  clicks already close the menu via the outside-pointerdown listener
 *  below, but a re-render triggered some other way (a refresh call, a
 *  units change) wouldn't otherwise get a chance to. */
export function closeDownloadMenu() {
  _closeDownloadMenu();
}

function _closeDownloadMenu() {
  if (!_openMenu) return;
  const { el, buttonEl, onOutside, onKeydown } = _openMenu;
  el.remove();
  buttonEl.classList.remove('menu-open');
  buttonEl.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', _closeDownloadMenu);
  window.removeEventListener('scroll', _closeDownloadMenu, true);
  _openMenu = null;
}

/** Right-aligns `menu` to `anchor`'s right edge (opening to the left) and
 *  hangs it just below the button, flipping above if there isn't room
 *  below — same "measure the real rect, then clamp" approach as
 *  .trainer-menu's JS-computed position, since a card in a scrolling list
 *  can sit anywhere on screen. */
function _positionDownloadMenu(menu, anchor) {
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const margin = 8;

  let left = a.right - m.width;
  left = Math.min(Math.max(left, margin), window.innerWidth - m.width - margin);

  let top = a.bottom + 6;
  if (top + m.height > window.innerHeight - margin) top = a.top - m.height - 6;

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top  = `${Math.round(top)}px`;
}

function _toggleDownloadMenu(buttonEl, record) {
  // Clicking the button that's already open just closes it.
  if (_openMenu?.buttonEl === buttonEl) { _closeDownloadMenu(); return; }
  _closeDownloadMenu();

  const menu = document.createElement('div');
  menu.className = 'format-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = Object.values(ACTIVITY_FORMATS).map(f =>
    `<button type="button" class="format-menu-item" role="menuitem" data-format="${f.id}">${esc(f.label)}</button>`
  ).join('');
  document.body.appendChild(menu);
  _positionDownloadMenu(menu, buttonEl);

  menu.querySelectorAll('.format-menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadActivity(record, item.dataset.format);
      _closeDownloadMenu();
      buttonEl.focus();
    });
  });

  const onOutside = (e) => {
    if (!menu.contains(e.target) && !buttonEl.contains(e.target)) _closeDownloadMenu();
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') { _closeDownloadMenu(); buttonEl.focus(); }
  };
  // Capture phase so this fires before a click handler on the card behind
  // the button (e.g. History tab's "open detail" listener) — and so it
  // still sees the click even though downloadActivity() below stops it
  // from bubbling any further up.
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', _closeDownloadMenu);
  window.addEventListener('scroll', _closeDownloadMenu, true);

  buttonEl.classList.add('menu-open');
  buttonEl.setAttribute('aria-expanded', 'true');
  menu.querySelector('.format-menu-item')?.focus();

  _openMenu = { el: menu, buttonEl, onOutside, onKeydown };
}

/**
 * Wires an icon button (e.g. history-browser.js's per-session .history-download
 * button) so clicking it opens the format-picker popup instead of
 * downloading one hardcoded format. Safe to call once per button; each
 * button gets its own click listener but they all share the same
 * "only one menu open at a time" module state above.
 * @param {HTMLElement} buttonEl
 * @param {SessionRecord} record
 */
export function attachDownloadMenu(buttonEl, record) {
  buttonEl.setAttribute('aria-haspopup', 'menu');
  buttonEl.setAttribute('aria-expanded', 'false');
  buttonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleDownloadMenu(buttonEl, record);
  });
}

export default { ACTIVITY_FORMATS, downloadActivity, renderDownloadControl, attachDownloadMenu, closeDownloadMenu, buildTcxActivity, buildCsvActivity, buildJsonActivity, activityFilenameBase };
