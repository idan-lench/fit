import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub localStorage for this Node test run.
const store = new Map();
globalThis.localStorage = {
  getItem(k) { return store.has(k) ? store.get(k) : null; },
  setItem(k, v) { store.set(k, String(v)); },
  removeItem(k) { store.delete(k); },
  clear() { store.clear(); },
};

const { state, save, load } = await import('./state.js');

test('state has the expected default shape', () => {
  assert.ok(Array.isArray(state.sessions));
  assert.ok(Array.isArray(state.measurements));
  assert.ok(Array.isArray(state.steps));
  assert.equal(state.current, null);
});

test('save() round-trips through load()', () => {
  state.sessions.push({ id: 1, foo: 'bar' });
  save();
  const reloaded = load();
  assert.equal(reloaded.sessions.length, 1);
  assert.equal(reloaded.sessions[0].foo, 'bar');
});

test('load() returns null on corrupted JSON', () => {
  store.set('fit.v1', 'not-json');
  assert.equal(load(), null);
});
