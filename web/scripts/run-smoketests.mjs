#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// web/scripts/run-smoketests.mjs
//
// Finds every __*smoketest__.js file under src/ and runs it in its own
// `node` process — each one is already a standalone script (see the
// "Run with: node <path>" comment at the top of each file) that exits
// non-zero if any of its own checks fail. This runner just saves having
// to remember/type the full list of paths by hand, and gives `npm test` /
// CI a single pass/fail signal across all of them.
//
// There's no browser-based test runner in this project (no jsdom or
// happy-dom, no vitest/jest) — the smoke tests are deliberately plain,
// dependency-free node scripts that exercise the pure model/logic layer.
// stdout/stderr from each file is inherited so failures are visible
// inline rather than swallowed and re-summarized.

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(webRoot, 'src');
const SMOKETEST_RE = /^__.*smoketest__\.js$/i;

function findSmokeTests(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) found.push(...findSmokeTests(full));
    else if (SMOKETEST_RE.test(entry)) found.push(full);
  }
  return found;
}

const files = findSmokeTests(srcRoot).sort();

if (files.length === 0) {
  console.error('No __*smoketest__.js files found under src/.');
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const label = relative(webRoot, file);
  console.log(`\n\u25b6 ${label}`);
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: webRoot });
  if (result.status !== 0) {
    failures++;
    console.error(`\u2717 ${label} exited with code ${result.status}`);
  }
}

console.log(`\n${files.length - failures}/${files.length} smoke test files passed.`);
process.exit(failures === 0 ? 0 : 1);
