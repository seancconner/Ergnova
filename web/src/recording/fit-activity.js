// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * recording/fit-activity.js
 *
 * Binary .FIT activity file writer.
 * Produces a valid FIT file from a session's sample array that can be opened
 * by Garmin Connect, TrainingPeaks, Strava (manual upload), and most other
 * platforms.
 *
 * Supports:
 *   - File ID, Session, Lap, and Record messages
 *   - Power, cadence, heart rate, speed, distance fields
 *   - Raw RR interval HRV records when rrInterval data is present
 *
 * FIT binary format primer:
 *   Each message is preceded by a 1-byte header. Definition messages describe
 *   the fields in the next data message of that type. All multi-byte integers
 *   are little-endian. Timestamps are seconds since 1989-12-31 00:00:00 UTC
 *   (the "FIT epoch").
 *
 * Usage:
 *   import { buildFitActivity, downloadFit } from './recording/fit-activity.js';
 *   const bytes = buildFitActivity(sessionRecord, { ftp: 280 });
 *   // or just:
 *   downloadFit(sessionRecord, { ftp: 280 });
 */

// ─── FIT epoch offset ─────────────────────────────────────────────────────────
const FIT_EPOCH_OFFSET = 631065600;
function toFitTime(unixMs) {
  return Math.round(unixMs / 1000) - FIT_EPOCH_OFFSET;
}

// ─── Low-level writer ─────────────────────────────────────────────────────────
class FitWriter {
  constructor() { this._chunks = []; this._size = 0; }
  u8(v)  { this._push(1, v >>> 0); }
  u16(v) { this._push(2, v >>> 0); }
  u32(v) { this._push(4, v >>> 0); }
  _push(bytes, v) {
    const buf = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) { buf[i] = v & 0xff; v >>= 8; }
    this._chunks.push(buf); this._size += bytes;
  }
  bytes() {
    const out = new Uint8Array(this._size);
    let off = 0;
    for (const c of this._chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  get size() { return this._size; }
}

// ─── CRC ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint16Array(16);
  for (let i = 0; i < 16; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB8 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function fitCrc(data) {
  let crc = 0;
  for (const b of data) {
    crc = (CRC_TABLE[(crc & 0xF) ^ (b & 0xF)] ^ (crc >>> 4));
    crc = (CRC_TABLE[(crc & 0xF) ^ (b >>> 4)]  ^ (crc >>> 4));
  }
  return crc & 0xFFFF;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function defMsg(w, localNum, globalNum, fields) {
  w.u8(0x40 | localNum);
  w.u8(0); w.u8(0); w.u16(globalNum); w.u8(fields.length);
  for (const [num, size, type] of fields) { w.u8(num); w.u8(size); w.u8(type); }
}
function dh(w, localNum) { w.u8(localNum & 0x0F); }
const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;

// ─── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build a FIT activity file from a SessionRecord.
 * @param {SessionRecord} record
 * @param {{ ftp?: number }} [opts]
 * @returns {Uint8Array}
 */
export function buildFitActivity(record, { ftp } = {}) {
  const { samples = [], laps = [], summary = {} } = record;
  const hasRR    = samples.some(s => s.rrInterval != null);
  const hasPower = samples.some(s => s.power != null);
  const hasHR    = samples.some(s => s.heartRate != null);
  const hasCad   = samples.some(s => s.cadence != null);
  const hasSpeed = samples.some(s => s.speed != null);
  const hasDist  = samples.some(s => s.distance != null);

  const d = new FitWriter(); // data section

  const startFit = toFitTime(record.startTime);
  const endFit   = toFitTime(record.endTime);
  const dur      = record.duration ?? 0;

  // ── File ID (local 0, global 0) ───────────────────────────────────────────
  defMsg(d, 0, 0, [[0,1,0x00],[1,2,0x84],[2,2,0x84],[3,4,0x86],[4,4,0x86]]);
  dh(d,0); d.u8(4); d.u16(255); d.u16(0); d.u32(0); d.u32(startFit);

  // ── Record (local 1, global 20) ───────────────────────────────────────────
  const recF = [[253,4,0x86]];
  if (hasPower) recF.push([7,2,0x84]);
  if (hasCad)   recF.push([4,1,0x00]);
  if (hasHR)    recF.push([3,1,0x00]);
  if (hasSpeed) recF.push([6,2,0x84]);
  if (hasDist)  recF.push([5,4,0x86]);
  defMsg(d, 1, 20, recF);

  for (const s of samples) {
    dh(d,1);
    d.u32(toFitTime(s.timestamp));
    if (hasPower) d.u16(s.power    != null ? Math.round(s.power)    : 0xFFFF);
    if (hasCad)   d.u8 (s.cadence  != null ? Math.round(s.cadence)  : 0xFF);
    if (hasHR)    d.u8 (s.heartRate!= null ? Math.round(s.heartRate): 0xFF);
    if (hasSpeed) d.u16(s.speed    != null ? Math.round(s.speed * 1000 / 3.6) : 0xFFFF);
    if (hasDist)  d.u32(s.distance != null ? Math.round(s.distance * 100)     : 0xFFFFFFFF);
  }

  // ── HRV records (local 2, global 78) — native RR data ────────────────────
  if (hasRR) {
    defMsg(d, 2, 78, [[0,2,0x84]]);
    for (const s of samples) {
      if (s.rrInterval == null) continue;
      dh(d,2); d.u16(Math.round(s.rrInterval));
    }
  }

  // ── Lap records (local 3, global 19) ─────────────────────────────────────
  const lapBounds = [{ sampleIndex:0 }, ...laps, { sampleIndex: samples.length }];
  defMsg(d, 3, 19, [
    [253,4,0x86],[2,4,0x86],[7,4,0x86],[8,4,0x86],
    [9,4,0x86],[20,2,0x84],[16,1,0x00],[18,1,0x00],[5,1,0x00],[6,1,0x00],
  ]);

  for (let i = 0; i < lapBounds.length - 1; i++) {
    const slice = samples.slice(lapBounds[i].sampleIndex, lapBounds[i+1].sampleIndex);
    if (!slice.length) continue;
    const lapDur  = Math.round((slice[slice.length-1].timestamp - slice[0].timestamp) / 1000);
    const lpow    = slice.map(s=>s.power).filter(v=>v!=null);
    const lhr     = slice.map(s=>s.heartRate).filter(v=>v!=null);
    const lcad    = slice.map(s=>s.cadence).filter(v=>v!=null);
    const ldist   = slice[slice.length-1]?.distance;
    dh(d,3);
    d.u32(toFitTime(slice[slice.length-1].timestamp));
    d.u32(toFitTime(slice[0].timestamp));
    d.u32(lapDur); d.u32(lapDur);
    d.u32(ldist != null ? Math.round(ldist*100) : 0xFFFFFFFF);
    d.u16(avg(lpow)  ?? 0xFFFF);
    d.u8 (avg(lhr)   ?? 0xFF);
    d.u8 (avg(lcad)  ?? 0xFF);
    d.u8(2); d.u8(58);
  }

  // ── Session (local 4, global 18) ─────────────────────────────────────────
  defMsg(d, 4, 18, [
    [253,4,0x86],[2,4,0x86],[7,4,0x86],[8,4,0x86],
    [9,4,0x86],[20,2,0x84],[29,2,0x84],[16,1,0x00],[18,1,0x00],[5,1,0x00],[6,1,0x00],
  ]);
  const lastDist = samples[samples.length-1]?.distance;
  dh(d,4);
  d.u32(endFit); d.u32(startFit); d.u32(dur); d.u32(dur);
  d.u32(lastDist != null ? Math.round(lastDist*100) : 0xFFFFFFFF);
  d.u16(summary.avgPower           ?? 0xFFFF);
  d.u16(summary.normalizedPower    ?? 0xFFFF);
  d.u8 (summary.avgHr              ?? 0xFF);
  d.u8 (summary.avgCadence         ?? 0xFF);
  d.u8(2); d.u8(58);

  // ── Activity (local 5, global 34) ────────────────────────────────────────
  defMsg(d, 5, 34, [[253,4,0x86],[0,4,0x86],[1,2,0x84],[2,1,0x00],[3,1,0x00],[4,1,0x00]]);
  dh(d,5); d.u32(endFit); d.u32(dur); d.u16(1); d.u8(0); d.u8(26); d.u8(1);

  // ── Assemble ─────────────────────────────────────────────────────────────
  const dataBytes = d.bytes();
  const dataLen   = dataBytes.length;

  const header = new Uint8Array(14);
  header[0]=14; header[1]=16; header[2]=7; header[3]=1;
  header[4]=0x2E; header[5]=0x46; header[6]=0x49; header[7]=0x54; // '.FIT'
  header[8]=dataLen&0xFF; header[9]=(dataLen>>8)&0xFF;
  header[10]=(dataLen>>16)&0xFF; header[11]=(dataLen>>24)&0xFF;
  const hCrc = fitCrc(header.slice(0,12));
  header[12]=hCrc&0xFF; header[13]=(hCrc>>8)&0xFF;

  const withHeader = new Uint8Array(header.length + dataBytes.length);
  withHeader.set(header,0); withHeader.set(dataBytes,header.length);
  const fileCrc = fitCrc(withHeader);

  const out = new Uint8Array(withHeader.length + 2);
  out.set(withHeader,0);
  out[out.length-2]=fileCrc&0xFF; out[out.length-1]=(fileCrc>>8)&0xFF;
  return out;
}

/**
 * Save the .FIT file (browser download on the web/PWA, native save/share
 * sheet inside the MAUI shell — see platform/save-file.js).
 * @param {SessionRecord} record
 * @param {{ ftp?: number }} [opts]
 */
export function downloadFit(record, opts = {}) {
  const bytes = buildFitActivity(record, opts);
  const blob  = new Blob([bytes], { type: 'application/octet-stream' });
  const date  = new Date(record.startTime).toISOString().slice(0,10);
  const name  = (record.workoutName ?? 'workout').replace(/[^a-z0-9]/gi,'_');
  saveFile(`${date}_${name}.fit`, blob);
}

export default { buildFitActivity, downloadFit };
