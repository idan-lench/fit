import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

// Recursively list files under `dir`, filtered by `accept(name, fullPath)`.
// Skips node_modules, .git, .github by default.
const SKIP = new Set(['node_modules', '.git', '.github']);
export function walk(dir, accept, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, accept, out);
    else if (accept(name, p)) out.push(p);
  }
  return out;
}

export const isJs = name => extname(name) === '.js';
export const isJsNotTest = name => isJs(name) && !name.endsWith('.test.js');
export const SCAN_EXT = new Set(['.js', '.html', '.css', '.md', '.json']);
export const isScannable = name => SCAN_EXT.has(extname(name));
