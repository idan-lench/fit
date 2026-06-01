// Boot smoke test: load index.html into jsdom and assert nothing throws.
// Catches the class of bugs we've hit before (e.g. PLAN.sat crash that
// halted the whole script on Saturdays).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, ResourceLoader } from 'jsdom';
import { indexedDB, IDBKeyRange, IDBDatabase, IDBObjectStore, IDBTransaction, IDBRequest, IDBCursor, IDBIndex } from 'fake-indexeddb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// We don't want jsdom to actually fetch GIS / body-muscles / qrserver etc.
// during the test — block external network entirely.
class LocalOnlyLoader extends ResourceLoader {
  fetch(url, options) {
    if (url.startsWith('file://')) return super.fetch(url, options);
    // Pretend external resources don't exist; jsdom will continue.
    return Promise.resolve(Buffer.from(''));
  }
}

// Pseudo-bundle: resolve `import { X, Y } from './path.js'` by inlining the
// target module's contents (with `export` keywords stripped) and removing the
// import statement. Just enough to flatten a small dependency tree into one
// classic-script blob jsdom can execute. Recursively follows imports.
function flattenModules(entryPath) {
  const visited = new Set();
  const chunks = [];
  function visit(absPath) {
    if (visited.has(absPath)) return;
    visited.add(absPath);
    let src = readFileSync(absPath, 'utf8');
    const importRe = /^\s*import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
    const deps = [];
    src = src.replace(importRe, (_, _names, rel) => {
      deps.push(join(dirname(absPath), rel));
      return '';
    });
    src = src
      .replace(/^\s*export\s+(async\s+function|function|class|const|let|var)\s+/gm, '$1 ')
      .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
    for (const d of deps) visit(d);
    chunks.push(`// ---- inlined: ${absPath.replace(repoRoot + '/', '')} ----\n${src}`);
  }
  visit(entryPath);
  return chunks.join('\n');
}

async function bootApp() {
  let html = readFileSync(join(repoRoot, 'index.html'), 'utf8');

  // jsdom doesn't fetch `<script type="module" src="...">` via our loader.
  // Flatten the app's module graph into a single classic-script blob for the
  // test. External scripts (GIS, body-muscles) stay blocked by LocalOnlyLoader.
  const appBundle = flattenModules(join(repoRoot, 'app.js'));
  html = html
    .replace('<script type="module" src="./app.js"></script>', `<script>\n${appBundle}\n</script>`);

  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    resources: new LocalOnlyLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      window.addEventListener('error', (e) => {
        errors.push({ message: e.message, source: e.filename, line: e.lineno });
      });
      window.indexedDB = indexedDB;
      window.IDBKeyRange = IDBKeyRange;
      window.IDBDatabase = IDBDatabase;
      window.IDBObjectStore = IDBObjectStore;
      window.IDBTransaction = IDBTransaction;
      window.IDBRequest = IDBRequest;
      window.IDBCursor = IDBCursor;
      window.IDBIndex = IDBIndex;
      window.matchMedia = window.matchMedia || (() => ({
        matches: false, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}
      }));
      window.fetch = window.fetch || (async () => new Response('{}'));
    },
  });

  await new Promise((r) => setTimeout(r, 250));
  return { dom, errors };
}

test('index.html boots in jsdom without throwing', async () => {
  const { dom, errors } = await bootApp();

  const appErrors = errors.filter((e) => {
    const src = (e.source || '').toLowerCase();
    if (src.includes('googleapis.com')) return false;
    if (src.includes('unpkg.com')) return false;
    if (src.includes('accounts.google.com')) return false;
    return true;
  });

  if (appErrors.length) {
    console.error('App threw errors on boot:', appErrors);
  }
  assert.equal(appErrors.length, 0, 'app should boot without throwing');

  const navButtons = dom.window.document.querySelectorAll('nav button');
  assert.ok(navButtons.length >= 4, 'expected at least 4 nav tab buttons');

  dom.window.close();
});

test('click bindings: settings modal opens and closes', async () => {
  const { dom } = await bootApp();
  const doc = dom.window.document;

  // Settings button opens the modal
  const settingsBtn = doc.getElementById('headerSettingsBtn');
  assert.ok(settingsBtn, 'headerSettingsBtn should exist');
  settingsBtn.click();
  await new Promise(r => setTimeout(r, 50));
  const modal = doc.getElementById('settingsModal');
  assert.ok(modal.classList.contains('show'), 'settings modal should open after clicking settings button');

  // Close button hides the modal
  const closeBtn = doc.getElementById('closeSettingsBtn');
  assert.ok(closeBtn, 'closeSettingsBtn should exist');
  closeBtn.click();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!modal.classList.contains('show'), 'settings modal should close after clicking close button');

  dom.window.close();
});

test('click bindings: nav tabs switch active section', async () => {
  const { dom } = await bootApp();
  const doc = dom.window.document;

  // Click the Workout nav tab
  const workoutBtn = doc.querySelector('nav button[data-tab="workout"]');
  assert.ok(workoutBtn, 'workout nav button should exist');
  workoutBtn.click();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(doc.getElementById('tab-workout').classList.contains('active'), 'workout tab should be active');
  assert.ok(!doc.getElementById('tab-analysis').classList.contains('active'), 'analysis tab should be inactive');

  // Click the Meals nav tab
  const mealsBtn = doc.querySelector('nav button[data-tab="meals"]');
  mealsBtn.click();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(doc.getElementById('tab-meals').classList.contains('active'), 'meals tab should be active');

  dom.window.close();
});
