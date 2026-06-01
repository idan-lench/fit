#!/usr/bin/env node
// Scan app.js for top-level `function NAME(...)` definitions whose name is
// not referenced anywhere in the repo. Exits non-zero on any finding.
//
// Limitations:
// - Only checks function declarations (not const x = () => {} arrow exports).
//   The monolith uses `function` declarations; extracted modules use exports.
// - Treats any whole-word match outside the definition itself as "alive".
//   Lax on purpose: better to miss a true dead than delete a live handler
//   referenced from an HTML template literal.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk, isScannable } from './lib/walk.js';

const ROOT = process.cwd();

const repoText = walk(ROOT, isScannable)
  .filter(p => !p.endsWith('app.js'))
  .map(p => readFileSync(p, 'utf8'))
  .join('\n');

const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
const defs = [...app.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g)]
  .map(m => m[1]);

const dead = [];
for (const fn of new Set(defs)) {
  const defRe = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${fn}\\s*\\(`);
  const appMinusDef = app.replace(defRe, '\n');
  const inApp = new RegExp(`\\b${fn}\\b`).test(appMinusDef);
  const inRepo = new RegExp(`\\b${fn}\\b`).test(repoText);
  if (!inApp && !inRepo) dead.push(fn);
}

if (dead.length) {
  console.error(`✗ Dead code: ${dead.length} function(s) in app.js have no references anywhere:`);
  for (const fn of dead) console.error(`    ${fn}`);
  console.error('\nDelete them, or add a real caller.');
  process.exit(1);
}
console.log(`✓ Dead-code scan clean (${defs.length} function declarations checked).`);
