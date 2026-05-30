#!/usr/bin/env node
// Flag obvious cross-module duplication:
//
//   1. The same function NAME defined in two or more *.js files (outside
//      tests). Extracting to a module = forgetting to delete the original.
//
//   2. The IDB promise-wrapper boilerplate. After 3.1 these calls live only
//      in data/db.js; if any store re-introduces them we want to know.

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { walk, isJsNotTest } from './lib/walk.js';

const ROOT = process.cwd();
const files = walk(ROOT, isJsNotTest);
const findings = [];

// ── 1. duplicate function declarations across files ────────────────────────
const defMap = new Map(); // fnName -> [file, file, ...]
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const names = [...src.matchAll(/(?:^|\n)\s*(?:async\s+|export\s+(?:async\s+)?)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g)]
    .map(m => m[1]);
  for (const n of new Set(names)) {
    if (!defMap.has(n)) defMap.set(n, []);
    defMap.get(n).push(relative(ROOT, f));
  }
}
for (const [name, where] of defMap) {
  if (where.length > 1) {
    findings.push(`Duplicate function "${name}" in: ${where.join(', ')}`);
  }
}

// ── 2. raw IDB promise wrappers outside data/db.js ─────────────────────────
const idbPattern = /return\s+new\s+Promise\s*\(\s*\(\s*resolve\s*,\s*reject\s*\)\s*=>\s*\{\s*const\s+req\s*=/g;
for (const f of files) {
  if (relative(ROOT, f) === 'data/db.js') continue;
  const src = readFileSync(f, 'utf8');
  const hits = src.match(idbPattern);
  if (hits) {
    findings.push(`${hits.length} raw IDB promise wrapper(s) in ${relative(ROOT, f)} — use data/db.js idbGet/idbWrite`);
  }
}

// ── 3. raw Fitness API URLs outside integrations/google-fit.js ────────────
const fitPattern = /googleapis\.com\/fitness/g;
for (const f of files) {
  if (relative(ROOT, f) === 'integrations/google-fit.js') continue;
  const src = readFileSync(f, 'utf8');
  const hits = src.match(fitPattern);
  if (hits) {
    findings.push(`${hits.length} raw Fitness API URL(s) in ${relative(ROOT, f)} — use integrations/google-fit.js`);
  }
}

// ── 4. raw Gemini URLs outside integrations/gemini.js ──────────────────────
const geminiPattern = /generativelanguage\.googleapis\.com/g;
for (const f of files) {
  if (relative(ROOT, f) === 'integrations/gemini.js') continue;
  const src = readFileSync(f, 'utf8');
  const hits = src.match(geminiPattern);
  if (hits) {
    findings.push(`${hits.length} raw Gemini URL(s) in ${relative(ROOT, f)} — use integrations/gemini.js geminiGenerate / callGeminiAnalysis`);
  }
}

if (findings.length) {
  console.error(`✗ Duplication: ${findings.length} finding(s):`);
  for (const f of findings) console.error(`    ${f}`);
  process.exit(1);
}
console.log(`✓ Duplication scan clean (${files.length} files checked).`);
