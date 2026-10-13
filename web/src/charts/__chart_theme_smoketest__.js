// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// charts/chart-theme.js + style.css :root palette guard — pure node, no DOM.
// Run with: node src/charts/__chart_theme_smoketest__.js
//
// Two jobs:
//   1. TOKEN_FALLBACKS (the static hex the charts fall back to) must equal the
//      colours style.css actually defines, so the canvas charts, metric cards
//      and Android notification chips can't drift apart again.
//   2. The background ladder must stay coherent (each rung lighter than the
//      one below, none so close it stops reading as a step) and every text
//      tier / accent / chart line must keep its contrast on every surface it
//      can land on.
//
//   The ladder is the theme lab's: bg-app < bg-deep < bg-surface < bg-raised <
//   bg-scrim (card / input / hover / button are aliases of those rungs). It
//   used to put the "recessed wells" (scrim, input, deep) *below* bg-app;
//   the lab's export flipped scrim/input/hover to the lightest rung, so the
//   checks below follow the ladder as it is now rather than the old one.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOKEN_FALLBACKS, withAlpha } from './chart-theme.js';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}${detail ? '  ' + detail : ''}`); }
}

// ── read :root out of style.css ───────────────────────────────────────
const css = readFileSync(fileURLToPath(new URL('../style.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const rootBody = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
const tokens = {};
for (const m of rootBody.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();

// ── tiny colour helpers (hsl() / var() aliases only; color-mix is skipped) ──
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
function splitTop(str) {
  const out = []; let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
// Resolves opaque hsl(), var() aliases and `color-mix(in srgb, A p%, B [q%])`.
function resolveValue(v, depth = 0) {
  if (v == null || depth > 8) return null;
  v = v.trim();
  let m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m) return resolveValue(tokens[m[1]], depth + 1);
  m = /^hsl\(\s*([\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(v);
  if (m) return hslToRgb(+m[1], +m[2], +m[3]);
  m = /^color-mix\(in srgb,(.*)\)$/.exec(v);
  if (m) {
    const [a, b] = splitTop(m[1]);
    const part = (x) => { const q = /^(.*?)\s+([\d.]+)%$/.exec(x); return q ? [q[1], +q[2]] : [x, null]; };
    let [ca, pa] = part(a); let [cb, pb] = part(b);
    if (pa == null && pb == null) pa = pb = 50; else if (pa == null) pa = 100 - pb; else if (pb == null) pb = 100 - pa;
    const A = resolveValue(ca, depth + 1), B = resolveValue(cb, depth + 1);
    if (!A || !B) return null;
    const t = pa + pb;
    return A.map((c, i) => Math.round((c * pa + B[i] * pb) / t));
  }
  return null;
}
const resolve = (name) => resolveValue(tokens[name]);
const hex = ([r, g, b]) => '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const Lstar = (rgb) => { const y = lum(rgb); return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y; };

console.log('chart-theme.js');

// ── 1. fallbacks vs style.css ─────────────────────────────────────────
for (const [name, fallback] of Object.entries(TOKEN_FALLBACKS)) {
  check(`${name} is defined in style.css :root`, name in tokens);
  const rgb = resolve(name);
  check(`${name} resolves to a colour`, !!rgb);
  if (!rgb) continue;
  const want = hex(rgb);
  const close = [1, 3, 5].every((i) => Math.abs(parseInt(want.slice(i, i + 2), 16) - parseInt(fallback.slice(i, i + 2), 16)) <= 1);
  check(`${name} fallback ${fallback} matches style.css (${want})`, close);
}
check('withAlpha builds an rgba() string', withAlpha('#f97415', 0.5) === 'rgba(249, 116, 21, 0.5)');
check('withAlpha passes non-hex input through untouched', withAlpha('red', 0.5) === 'red');

// ── 2. background ladder ──────────────────────────────────────────────
const L = (n) => Lstar(resolve(n));
const ladder = ['--bg-app', '--bg-deep', '--bg-surface', '--bg-raised', '--bg-scrim'];
const aliases = { '--bg-card': '--bg-surface', '--bg-input': '--bg-scrim', '--bg-hover': '--bg-scrim' };
check('card / input / hover still sit on the rung they alias',
  Object.entries(aliases).every(([a, rung]) => Math.abs(L(a) - L(rung)) < 0.01));
check('each elevation step is lighter than the one below', ladder.every((n, i) => i === 0 || L(n) > L(ladder[i - 1])));
const steps = ladder.slice(1).map((n, i) => L(n) - L(ladder[i]));
check('no elevation step is fainter than 2.5 L*', steps.every((d) => d >= 2.5), steps.map((d) => d.toFixed(2)).join(', '));
// The old hand-tuned ladder grew each step a little (2.9 → 4.5 L*). The lab's export
// spaces the rungs evenly in HSL lightness instead, which lands within a few tenths of
// an L* of even; what this guards against is one rung wobbling out of line.
check('ladder steps are even (largest step within 25% of the smallest)', Math.max(...steps) / Math.min(...steps) <= 1.25, steps.map((d) => d.toFixed(2)).join(', '));

// ── 3. contrast on every surface ──────────────────────────────────────
// Hover now shares the scrim rung with inputs and buttons, so there is no longer a
// separate transient surface to exclude: every rung counts as a resting surface.
const surfaces = ladder;
const restingSurfaces = surfaces;
// Neutral text tiers and red-as-text must hold on every surface, hover included.
for (const t of ['--text-primary', '--text-secondary', '--text-muted', '--danger-text']) {
  const fg = resolve(t);
  const worst = Math.min(...surfaces.map((s) => contrast(fg, resolve(s))));
  check(`${t} text is >= 4.5:1 on every surface`, worst >= 4.5, `worst ${worst.toFixed(2)}`);
}
// Metric / accent colours are readouts on resting surfaces (chips, cards, rows).
// --color-hr has a lower floor of its own: it was deliberately set to the punchier #ff4040 in place of the
// earlier washed pink (#f76b6b), which costs contrast (about 3.8:1 on the darkest surface). It is the hero's
// caption colour, the chips' rule and wash and the chart line; the numerals themselves are --text-primary.
// 3.5 keeps it where it is: a darker red than this would fail.
const METRIC_TEXT_FLOOR = { '--color-hr': 3.5 };
for (const t of ['--accent', '--indigo', '--success', '--warning', '--color-hr', '--color-cadence', '--color-speed']) {
  const fg = resolve(t);
  const floor = METRIC_TEXT_FLOOR[t] ?? 4.5;
  const worst = Math.min(...restingSurfaces.map((s) => contrast(fg, resolve(s))));
  check(`${t} text is >= ${floor}:1 on every resting surface`, worst >= floor, `worst ${worst.toFixed(2)}`);
}
// --border / --border-mid are `1px solid transparent` shorthands now (the glass
// styling draws edges with --glass-edge-*), so there is no border *colour* to
// hold to 3:1. What still needs a real colour is the canvas chart lines, which
// mix from --chart-line-base: it must be visible on the chart canvas, and
// grid < lap < step must get progressively stronger against it.
check('--chart-line-base is >= 3:1 on the chart canvas (bg-deep)', contrast(resolve('--chart-line-base'), resolve('--bg-deep')) >= 3,
  `got ${contrast(resolve('--chart-line-base'), resolve('--bg-deep')).toFixed(2)}`);
const lineSteps = ['--chart-grid', '--chart-lap', '--chart-step'].map((n) => contrast(resolve(n), resolve('--chart-bg')));
check('chart grid < lap < step lines get progressively stronger', lineSteps[0] < lineSteps[1] && lineSteps[1] < lineSteps[2], lineSteps.map((c) => c.toFixed(2)).join(', '));
check('even the faintest chart grid line is visible against the canvas (>= 1.15:1)', lineSteps[0] >= 1.15, `got ${lineSteps[0].toFixed(2)}`);
// Nothing sets *text* on a solid --danger fill today: it backs the "×" glyph on the open
// + button and small status dots, which are graphical objects (WCAG 3:1). ink-strong on
// the lab's 44% red is ~3.8:1, so that is the floor checked here. If text is ever set on
// it, this must go back to 4.5:1 — which needs --danger at roughly 49% lightness or more.
check('ink-strong is >= 3:1 on the danger fill (glyph/dot only; no text on it)', contrast(resolve('--ink-strong'), resolve('--danger')) >= 3,
  `got ${contrast(resolve('--ink-strong'), resolve('--danger')).toFixed(2)}`);

// ── 3b. text on the wash ──────────────────────
// The page backdrop is --wash-base with the teal wash over it (style.css's
// Material layer: two radial blobs at --wash-a-strong / --wash-a-soft), and text sits
// either straight on that or on a glass tier (hero / tile / inset) laid over it. Nothing
// else in this file can see that stack, because every colour above resolves to an opaque
// hsl(); these need alpha, so they get their own small RGBA resolver instead of growing
// resolveValue() above. Brightest point of a wash is one blob's peak (its strength, at
// its centre) — unless the two blobs overlap, in which case they stack (1-(1-a)(1-b)). The
// geometry is read out of .wash-layer below rather than assumed, so moving a blob until it
// touches the other one flips this to the stricter number instead of quietly passing.
function resolveRGBA(v, depth = 0) {
  if (v == null || depth > 8) return null;
  v = v.trim();
  if (v === 'transparent') return [0, 0, 0, 0];
  let m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m) return resolveRGBA(tokens[m[1]], depth + 1);
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
  const rgb = resolveValue(v, depth + 1);            // opaque hsl() / hsl-only color-mix
  if (rgb && !/transparent/.test(v)) return [...rgb, 1];
  m = /^color-mix\(in srgb,(.*)\)$/.exec(v);
  if (!m) return null;
  const [a, b] = splitTop(m[1]);
  // A mix percentage can itself be a token (--glass-alpha-panel and friends), so resolve
  // `var(--x)` in that position to its own "NN%" before reading it.
  const pct = (s) => { const t = /^var\((--[\w-]+)\)$/.exec(s); return parseFloat(t ? tokens[t[1]] : s); };
  const part = (x) => { const q = /^(.*?)\s+(var\(--[\w-]+\)|[\d.]+%)$/.exec(x); return q ? [q[1], pct(q[2])] : [x, null]; };
  let [ca, pa] = part(a); let [cb, pb] = part(b);
  if (pa == null && pb == null) pa = pb = 50; else if (pa == null) pa = 100 - pb; else if (pb == null) pb = 100 - pa;
  const A = resolveRGBA(ca, depth + 1), B = resolveRGBA(cb, depth + 1);
  if (!A || !B) return null;
  const sum = pa + pb, wa = (pa / sum) * A[3], wb = (pb / sum) * B[3];   // premultiplied weights
  const alpha = wa + wb;
  if (alpha === 0) return [0, 0, 0, 0];
  const mixc = (i) => Math.round((A[i] * wa + B[i] * wb) / alpha);
  return [mixc(0), mixc(1), mixc(2), alpha * Math.min(1, sum / 100)];
}
const over = ([r, g, b, a], under) => [r, g, b].map((c, i) => Math.round(c * a + under[i] * (1 - a)));
const rgba = (name) => resolveRGBA(`var(${name})`);
const washNames = ['--wash-teal'];
const aStrong = parseFloat(tokens['--wash-a-strong']) / 100;
const aSoft = parseFloat(tokens['--wash-a-soft']) / 100;
check('wash tokens, the base fill and both blob strengths all resolve',
  washNames.every((n) => rgba(n)) && resolve('--wash-base') && aStrong > 0 && aSoft > 0 && aStrong < 1 && aSoft < 1);
check('the wash base is darker than --bg-app (the darks of the gradient)',
  Lstar(resolve('--wash-base')) < Lstar(resolve('--bg-app')),
  `base L* ${Lstar(resolve('--wash-base')).toFixed(1)} vs bg-app ${Lstar(resolve('--bg-app')).toFixed(1)}`);
// Each blob is `radial-gradient(W% H% at X% Y%, <colour>, transparent Z%)`: vertically it
// reaches H% * Z% either side of Y%. Two blobs whose vertical spans don't meet can't stack.
const washBg = /\.wash-layer\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const blobs = [...washBg.matchAll(/radial-gradient\(\s*[\d.]+%\s+([\d.]+)%\s+at\s+[\d.]+%\s+([\d.]+)%[\s\S]*?transparent\s+([\d.]+)%\)/g)]
  .map((m) => { const c = +m[2], reach = (+m[1] * +m[3]) / 100; return [c - reach, c + reach]; });
check('.wash-layer has two blobs whose geometry could be read', blobs.length === 2, `found ${blobs.length}`);
// The live cardio page mirrors the layer top-to-bottom and turns the soft blob off (a transform
// and one custom property, not a second gradient), so the blob geometry read above is still the
// whole story: a flip keeps their overlap, and muting a blob can only lower the worst case. This
// pins the rule itself, and that it only applies while that page is the visible one.
const liveRule = /body:has\(#session-panel\.session-active:not\(\.hidden\)\)\s+\.wash-layer\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
check('the live cardio page mirrors the wash while it is showing', /transform:\s*scaleY\(-1\)/.test(liveRule));
check('...and drops the soft blob, so the top of that page is plain black', /--wash-a-soft-live:\s*0%/.test(liveRule)
  && /var\(--wash-a-soft-live,\s*var\(--wash-a-soft\)\)/.test(washBg));
const blobsOverlap = blobs.length !== 2 || (blobs[0][0] < blobs[1][1] && blobs[1][0] < blobs[0][1]);
const aBoth = blobsOverlap ? 1 - (1 - aStrong) * (1 - aSoft) : Math.max(aStrong, aSoft);
const tiers = { bare: null, hero: '--tier-hero-bg', tile: '--tier-tile-bg', inset: '--tier-inset-bg' };
for (const t of ['--text-primary', '--text-secondary', '--text-muted']) {
  const fg = resolve(t);
  let worst = Infinity, where = '';
  for (const w of washNames) {
    const wc = rgba(w);
    const backdrop = over([wc[0], wc[1], wc[2], aBoth], resolve('--wash-base'));
    for (const [tier, tok] of Object.entries(tiers)) {
      const surface = tok ? over(rgba(tok), backdrop) : backdrop;
      const c = contrast(fg, surface);
      if (c < worst) { worst = c; where = `${w.replace('--wash-', '')} / ${tier}`; }
    }
  }
  check(`${t} text is >= 4.5:1 on the wash, bare or under a glass tier`, worst >= 4.5,
    `worst ${worst.toFixed(2)} (${where})`);
}

// ── 4. zone / step palette ────────────────────────────────────────────
const zoneTokens = Object.keys(TOKEN_FALLBACKS).filter((n) => /^--(zone|step)-/.test(n));
check('zone + step tokens are all covered by the fallback table', zoneTokens.length >= 15, `${zoneTokens.length} found`);
const worstZone = Math.min(...zoneTokens.map((n) => contrast(resolve(n), resolve('--bg-card'))));
check('every zone / step colour is >= 3:1 on bg-card', worstZone >= 3, `worst ${worstZone.toFixed(2)}`);
// The warm end of the effort ramp must stay separable by lightness (yellow > orange > red),
// so it doesn't collapse into one colour for red-green colour-blind riders.
const Lz = (n) => Lstar(resolve(n));
check('threshold > vo2 > anaerobic in lightness (warm end separable without hue)',
  Lz('--zone-threshold') - Lz('--zone-vo2') >= 10 && Lz('--zone-vo2') - Lz('--zone-anaerobic') >= 10,
  `${Lz('--zone-threshold').toFixed(0)} / ${Lz('--zone-vo2').toFixed(0)} / ${Lz('--zone-anaerobic').toFixed(0)}`);

// ── 5. text tiers share the surfaces' hue family ──────────────────────
const hueOf = (name) => { const m = /hsl\(\s*([\d.]+)/.exec(tokens[name] ?? ''); return m ? +m[1] : NaN; };
check('text-primary / secondary / muted all share the surfaces\' hue',
  ['--text-primary', '--text-secondary', '--text-muted', '--bg-surface', '--bg-raised'].every((n) => hueOf(n) === hueOf('--bg-app')),
  ['--bg-app', '--text-primary', '--text-secondary', '--text-muted'].map((n) => `${n}=${hueOf(n)}`).join(' '));

if (failures) {
  console.log(`\n${failures} chart-theme check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll chart-theme checks passed.');
