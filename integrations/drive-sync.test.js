import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

// Stub browser globals before module import.
const ls = new Map();
globalThis.localStorage = {
  getItem: k => ls.has(k) ? ls.get(k) : null,
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: k => ls.delete(k),
  clear: () => ls.clear(),
};
let lastFetch = null, nextFetch = null;
globalThis.fetch = async (url, init) => { lastFetch = { url, init }; return nextFetch; };
Object.defineProperty(globalThis, 'crypto', {
  value: { getRandomValues: arr => { arr.fill(0xab); return arr; } },
  writable: true, configurable: true,
});
globalThis.confirm = () => true;
globalThis.document = { getElementById: () => null };
globalThis.location = { hash: '', pathname: '/', search: '' };
globalThis.history = { replaceState: () => {} };
globalThis.toast = undefined;
globalThis.hideToast = undefined;

const { ensureSecret, pingSync, uploadToDrive, buildAppsScript, applyDrivePayload } =
  await import('./drive-sync.js');

// Reset state between tests
const { state, save } = await import('../data/state.js');
const { clearMeals, getAllMeals } = await import('../data/meals-store.js');
const { clearPhotos, getAllPhotos } = await import('../data/photo-store.js');
const { getAllTemplates } = await import('../data/template-store.js');

beforeEach(() => {
  ls.clear();
  lastFetch = null; nextFetch = null;
  state.sync = { webhookUrl: 'https://script.google.com/exec', secret: 'abc123' };
  state.sessions = []; state.measurements = []; state.steps = []; state.dailyNotes = [];
  state.exportedAt = null; state.lastSyncAt = null;
});

// ── ensureSecret ─────────────────────────────────────────────────────────────

test('ensureSecret generates a hex secret when none exists', () => {
  state.sync = {};
  const s = ensureSecret();
  assert.equal(typeof s, 'string');
  assert.ok(s.length >= 16);
  assert.match(s, /^[0-9a-f]+$/);
});

test('ensureSecret is idempotent', () => {
  state.sync = {};
  assert.equal(ensureSecret(), ensureSecret());
});

// ── uploadToDrive ─────────────────────────────────────────────────────────────

test('uploadToDrive posts payload to webhookUrl with secret in body', async () => {
  nextFetch = { ok: true, text: async () => '{"ok":true}' };
  await uploadToDrive({ foo: 'bar' }, 'fit-data.json');
  assert.equal(lastFetch.url, 'https://script.google.com/exec');
  assert.equal(lastFetch.init.method, 'POST');
  const body = JSON.parse(lastFetch.init.body);
  assert.equal(body.secret, 'abc123');
  assert.equal(body.filename, 'fit-data.json');
  assert.deepEqual(body.payload, { foo: 'bar' });
});

test('uploadToDrive returns skipped when not configured', async () => {
  state.sync = {};
  const r = await uploadToDrive({}, 'f.json');
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
});

// ── pingSync ──────────────────────────────────────────────────────────────────

test('pingSync sends {secret, ping:true} and parses response', async () => {
  nextFetch = { ok: true, text: async () => '{"ok":true,"pong":true}' };
  const r = await pingSync();
  assert.equal(r.ok, true);
  assert.equal(r.pong, true);
  const body = JSON.parse(lastFetch.init.body);
  assert.equal(body.ping, true);
  assert.equal(body.secret, 'abc123');
});

test('pingSync returns error when not configured', async () => {
  state.sync = {};
  const r = await pingSync();
  assert.equal(r.ok, false);
  assert.match(r.error, /not configured/);
});

// ── buildAppsScript ───────────────────────────────────────────────────────────

test('buildAppsScript embeds secret and folder id', () => {
  state.sync = { folderId: 'folder123' };
  const code = buildAppsScript('mysecret');
  assert.match(code, /mysecret/);
  assert.match(code, /folder123/);
});

// ── applyDrivePayload ─────────────────────────────────────────────────────────

test('applyDrivePayload merges sessions + steps into state', async () => {
  await applyDrivePayload({
    sessions: [{ id: 1 }],
    steps: [{ date: '2026-05-30', count: 5000 }],
    measurements: [], dailyNotes: [],
    exportedAt: '2026-05-30T10:00:00Z',
  }, '2026-05-30T10:00:00Z');
  assert.equal(state.sessions.length, 1);
  assert.equal(state.steps[0].count, 5000);
  assert.equal(state.lastSyncAt, '2026-05-30T10:00:00Z');
});

test('applyDrivePayload inserts meals into IDB', async () => {
  await clearMeals();
  await applyDrivePayload({
    sessions: [], measurements: [], steps: [], dailyNotes: [],
    meals: [{ date: '2026-05-30', time: '12:00', created: 100, description: 'eggs', calories: 140, breakdown: [] }],
  }, null);
  const meals = await getAllMeals();
  assert.equal(meals.length, 1);
  assert.equal(meals[0].description, 'eggs');
});

test('applyDrivePayload skips already-present templates', async () => {
  const { putTemplate } = await import('../data/template-store.js');
  await putTemplate({ name: 'breakfast', created: 1, description: '', breakdown: [] });
  await applyDrivePayload({
    sessions: [], measurements: [], steps: [], dailyNotes: [],
    templates: [{ name: 'breakfast', created: 1, description: '', breakdown: [] }],
  }, null);
  const tpls = await getAllTemplates();
  // Should still be exactly 1 (not duplicated)
  assert.equal(tpls.filter(t => t.name === 'breakfast').length, 1);
});
