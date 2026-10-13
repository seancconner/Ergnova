// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

/**
 * formats/gpx.js
 *
 * Parser for GPX route files (.gpx).
 *
 * GPX is fundamentally different from the other workout formats: it contains
 * a GPS route (lat/lon/elevation over distance), not a time-based sequence of
 * power targets. It feeds playback/route-session.js (Phase 4), which converts
 * the elevation profile into a real-time slope target as the rider "moves"
 * along the route.
 *
 * Because of this the `parse()` function returns a RouteModel (see typedef
 * below), NOT a WorkoutModel. The `write()` function serialises a RouteModel
 * back to GPX. The format-registry still manages the extension mapping so the
 * workout editor's file-picker can detect a .gpx file and hand it to the right
 * handler rather than trying to load it as a step-based workout.
 *
 * RouteModel shape:
 *   {
 *     name:        string,
 *     description: string,
 *     totalDistanceM: number,    // metres
 *     points: [
 *       { distanceM: number, elevationM: number, lat?: number, lon?: number }
 *     ]
 *   }
 *
 * Gradient helpers (used by route-session.js):
 *   gradeAtDistance(route, distanceM) → grade in percent
 *   elevationProfile(route, buckets)  → array of { distanceM, elevationM }
 *
 * Usage:
 *   import { parseGpx, gradeAtDistance } from './formats/gpx.js';
 *   const route = parseGpx(gpxText);
 *   const grade = gradeAtDistance(route, 5000); // grade % 5 km in
 */

import registry from './format-registry.js';

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse a GPX file into a RouteModel.
 * Handles both <trk>/<trkseg>/<trkpt> (track) and <rte>/<rtept> (route) elements.
 * Elevation from <ele> child element; haversine formula for distance.
 *
 * @param {string} text
 * @returns {RouteModel}
 */
export function parseGpx(text) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(text, 'application/xml');

  const name = doc.querySelector('name')?.textContent?.trim()
    ?? doc.querySelector('trk > name')?.textContent?.trim()
    ?? 'Imported GPX Route';
  const desc = doc.querySelector('desc')?.textContent?.trim()
    ?? doc.querySelector('trk > desc')?.textContent?.trim()
    ?? '';

  // Collect all track/route points in document order
  const ptEls = [
    ...Array.from(doc.querySelectorAll('trkpt')),
    ...Array.from(doc.querySelectorAll('rtept')),
  ];

  if (ptEls.length < 2) {
    throw new Error('[gpx] Need at least 2 track/route points to compute a route');
  }

  // Build raw points with lat/lon/elevation
  const raw = ptEls.map(el => ({
    lat: parseFloat(el.getAttribute('lat')),
    lon: parseFloat(el.getAttribute('lon')),
    ele: parseFloat(el.querySelector('ele')?.textContent ?? '0') || 0,
  })).filter(p => !isNaN(p.lat) && !isNaN(p.lon));

  // Accumulate cumulative distance using haversine
  const points = [];
  let totalDist = 0;
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) {
      totalDist += _haversineM(raw[i - 1].lat, raw[i - 1].lon, raw[i].lat, raw[i].lon);
    }
    points.push({
      distanceM:   Math.round(totalDist * 10) / 10,
      elevationM:  Math.round(raw[i].ele * 10) / 10,
      lat:         raw[i].lat,
      lon:         raw[i].lon,
    });
  }

  return { name, description: desc, totalDistanceM: totalDist, points };
}

// ─── Grade helpers ────────────────────────────────────────────────────────────

/**
 * Returns the road gradient (percent) at a given distance into the route.
 * Uses linear interpolation between the two surrounding data points.
 * Returns 0 at or beyond the route end.
 *
 * @param {RouteModel} route
 * @param {number}     distanceM  Metres from the route start.
 * @returns {number}              Grade in percent (positive = uphill).
 */
export function gradeAtDistance(route, distanceM) {
  const pts = route.points;
  if (!pts || pts.length < 2) return 0;
  if (distanceM <= 0) return 0;
  if (distanceM >= route.totalDistanceM) return 0;

  // Binary search for the surrounding pair
  let lo = 0, hi = pts.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].distanceM <= distanceM) lo = mid;
    else hi = mid;
  }

  const a = pts[lo], b = pts[hi];
  const dDist = b.distanceM - a.distanceM;
  if (dDist === 0) return 0;

  const dEle = b.elevationM - a.elevationM;
  return (dEle / dDist) * 100; // rise/run * 100 = percent grade
}

/**
 * Downsample the route to a fixed number of equally-spaced distance buckets.
 * Useful for chart rendering and overview displays.
 *
 * @param {RouteModel} route
 * @param {number}     buckets   Number of output points (default 200).
 * @returns {{ distanceM: number, elevationM: number }[]}
 */
export function elevationProfile(route, buckets = 200) {
  const step = route.totalDistanceM / buckets;
  const out  = [];
  for (let i = 0; i <= buckets; i++) {
    const d   = i * step;
    const ele = _elevationAt(route.points, d);
    out.push({ distanceM: Math.round(d), elevationM: Math.round(ele * 10) / 10 });
  }
  return out;
}

function _elevationAt(pts, distanceM) {
  if (!pts.length) return 0;
  if (distanceM <= pts[0].distanceM) return pts[0].elevationM;
  if (distanceM >= pts[pts.length - 1].distanceM) return pts[pts.length - 1].elevationM;

  let lo = 0, hi = pts.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].distanceM <= distanceM) lo = mid;
    else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const t = (distanceM - a.distanceM) / (b.distanceM - a.distanceM);
  return a.elevationM + t * (b.elevationM - a.elevationM);
}

// ─── Haversine distance ───────────────────────────────────────────────────────

function _haversineM(lat1, lon1, lat2, lon2) {
  const R  = 6_371_000; // Earth radius in metres
  const f1 = lat1 * Math.PI / 180;
  const f2 = lat2 * Math.PI / 180;
  const df = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Serialise a RouteModel back to GPX.
 * @param {RouteModel} route
 * @returns {string}
 */
export function writeGpx(route) {
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const trkpts = route.points.map(p =>
    `    <trkpt lat="${p.lat?.toFixed(7) ?? 0}" lon="${p.lon?.toFixed(7) ?? 0}">` +
    `<ele>${p.elevationM.toFixed(1)}</ele></trkpt>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ergnova"
  xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(route.name)}</name>
    <desc>${esc(route.description ?? '')}</desc>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

// ─── Registry adapter ─────────────────────────────────────────────────────────
// GPX doesn't produce a WorkoutModel, so the registry parse/write adapters
// wrap the RouteModel in an object that carries enough info for the editor to
// detect it and route it to route-session.js instead of the step editor.

function parse(text) {
  const route = parseGpx(text);
  // Tag it so app.js / WorkoutEditor can distinguish it from a WorkoutModel.
  return { _type: 'route', ...route };
}

function write(model) {
  // Accept either a tagged route or a plain RouteModel.
  return writeGpx(model);
}

export const EXTENSIONS = ['.gpx'];
export const MIME_TYPES  = ['application/gpx+xml', 'application/xml', 'text/xml'];
export { parse, write };

registry.register('gpx', { parse, write, EXTENSIONS, MIME_TYPES });

export default { parse, write, parseGpx, writeGpx, gradeAtDistance, elevationProfile, EXTENSIONS, MIME_TYPES };

// ─── Type documentation ───────────────────────────────────────────────────────

/**
 * @typedef {Object} RoutePoint
 * @property {number}  distanceM   Cumulative metres from route start
 * @property {number}  elevationM  Metres above sea level
 * @property {number}  [lat]
 * @property {number}  [lon]
 */

/**
 * @typedef {Object} RouteModel
 * @property {string}       name
 * @property {string}       description
 * @property {number}       totalDistanceM
 * @property {RoutePoint[]} points
 */
