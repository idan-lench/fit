#!/usr/bin/env node
// Guards against a class of bug the flattened smoke test can't see: a module
// that *uses* a shared singleton but never *imports* it. (Flattening merges all
// module scopes into one, so a missing per-module import looks fine there but
// throws "X is not defined" at runtime in real ES modules.)
//
// Currently checks PROMPTS — the prompts/ split is the most import-prone seam.
// Add more shared singletons to SHARED below as needed.

import { readFileSync } from 'node:fs';
import { walk, isJsNotTest } from './lib/walk.js';

const SHARED = ['PROMPTS'];
const repoRoot = process.cwd();
// prompts/ defines PROMPTS; scripts/.claude aren't app modules.
const EXCLUDE = ['/prompts/', '/scripts/', '/.claude/'];

const files = walk(repoRoot, (name, p) => isJsNotTest(name) && !EXCLUDE.some(d => p.includes(d)));

const problems = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const name of SHARED) {
    const used = new RegExp(`\\b${name}\\s*[.[]`).test(src);
    if (!used) continue;
    const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(src);
    const declared = new RegExp(`(const|let|var)\\s+${name}\\b`).test(src);
    if (!imported && !declared) {
      problems.push(`${file.replace(repoRoot + '/', '')} uses ${name} but never imports or declares it`);
    }
  }
}

if (problems.length) {
  console.error('✗ Missing-import check failed:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`✓ Missing-import scan clean (checked: ${SHARED.join(', ')}).`);
