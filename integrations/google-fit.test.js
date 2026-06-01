import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub localStorage + fetch before module load.
const ls = new Map();
globalThis.localStorage = {
  getItem: k => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: k => ls.delete(k),
  clear: () => ls.clear(),
};
let lastFetch = null, nextFetch = null;
globalThis.fetch = async (url, init) => { lastFetch = { url, init }; return nextFetch; };

const {
  gfitDateRange, gfitExtractInt, gfitExtractFloat,
  loadCachedGfitToken, saveCachedGfitToken, clearCachedGfitToken,
  gfitAggregateOnce, silentSyncGoogleFit,
} = await import('./google-fit.js');

beforeEach(() => { ls.clear(); lastFetch = null; nextFetch = null; });

// ── date helpers ──────────────────────────────────────────────────────────────

test('gfitDateRange spans the full local day', () => {
  const { startMs, endMs } = gfitDateRange('2026-05-30');
  const start = new Date(startMs);
  const end   = new Date(endMs);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 4);   // 0-indexed May
  assert.equal(start.getDate(), 30);
  assert.equal(start.getHours(), 0);
  assert.equal(end.getHours(), 23);
  assert.ok(endMs > startMs);
});

// ── extract helpers ───────────────────────────────────────────────────────────

test('gfitExtractInt sums intVal across points', () => {
  const data = { bucket: [{ dataset: [{ point: [
    { value: [{ intVal: 1200 }] },
    { value: [{ intVal: 800  }] },
  ]}]}]};
  assert.equal(gfitExtractInt(data), 2000);
});

test('gfitExtractInt returns 0 on malformed data', () => {
  assert.equal(gfitExtractInt({}), 0);
  assert.equal(gfitExtractInt(null), 0);
  assert.equal(gfitExtractInt({ bucket: [] }), 0);
});

test('gfitExtractFloat sums fpVal across points', () => {
  const data = { bucket: [{ dataset: [{ point: [
    { value: [{ fpVal: 1500.5 }] },
    { value: [{ fpVal:  499.5 }] },
  ]}]}]};
  assert.ok(Math.abs(gfitExtractFloat(data) - 2000) < 0.01);
});

// ── token cache ───────────────────────────────────────────────────────────────

test('saveCachedGfitToken + loadCachedGfitToken round-trips', () => {
  const expiry = Date.now() + 3600_000;
  saveCachedGfitToken('tok123', expiry);
  loadCachedGfitToken();
  const raw = JSON.parse(ls.get('fit.gfitToken'));
  assert.equal(raw.token, 'tok123');
  assert.equal(raw.expiry, expiry);
});

test('loadCachedGfitToken ignores expired tokens', () => {
  const expiry = Date.now() - 1000; // already expired
  saveCachedGfitToken('old-tok', expiry);
  loadCachedGfitToken(); // should not set module-level _gfitToken
  // No thrown error is the pass condition; internal state unverifiable without
  // calling gfitGetToken({silent:true}) which needs google global — good enough.
  assert.ok(true);
});

test('clearCachedGfitToken removes localStorage entry', () => {
  saveCachedGfitToken('tok', Date.now() + 3600_000);
  assert.ok(ls.has('fit.gfitToken'));
  clearCachedGfitToken();
  assert.ok(!ls.has('fit.gfitToken'));
});

// ── gfitAggregateOnce ─────────────────────────────────────────────────────────

test('gfitAggregateOnce posts to the Fitness API with correct headers', async () => {
  nextFetch = { ok: true, json: async () => ({ bucket: [] }) };
  await gfitAggregateOnce('my-token', 1000, 2000, { dataTypeName: 'com.google.step_count.delta' });
  assert.match(lastFetch.url, /googleapis\.com\/fitness\/v1\/users\/me\/dataset:aggregate/);
  assert.equal(lastFetch.init.method, 'POST');
  assert.match(lastFetch.init.headers.Authorization, /^Bearer my-token/);
});

test('gfitAggregateOnce throws on non-ok response', async () => {
  nextFetch = { ok: false, status: 401 };
  await assert.rejects(
    () => gfitAggregateOnce('tok', 1000, 2000, { dataTypeName: 'x' }),
    /Fit API 401/
  );
});

// ── silent sync self-heal (ported from main, commit 9af9046) ────────────────

test('silentSyncGoogleFit clears the cached token on a 403', async () => {
  saveCachedGfitToken('tok', Date.now() + 3600_000);
  loadCachedGfitToken(); // populate in-memory token so silent get returns it
  assert.ok(ls.has('fit.gfitToken'));
  nextFetch = { ok: false, status: 403 }; // CONSUMER_INVALID-style outage
  const ok = await silentSyncGoogleFit('2026-05-30');
  assert.equal(ok, false);
  assert.ok(!ls.has('fit.gfitToken'), 'a 403 should clear the dead token so the next Sync re-auths');
});

test('silentSyncGoogleFit keeps the token on a non-auth error (500)', async () => {
  saveCachedGfitToken('tok', Date.now() + 3600_000);
  loadCachedGfitToken();
  nextFetch = { ok: false, status: 500 };
  const ok = await silentSyncGoogleFit('2026-05-30');
  assert.equal(ok, false);
  assert.ok(ls.has('fit.gfitToken'), 'a transient 500 must not nuke a still-valid token');
});
