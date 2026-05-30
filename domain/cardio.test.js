import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDIO_TYPES, formatCardioActivitiesForAI } from './cardio.js';

test('CARDIO_TYPES has at least one entry with required fields', () => {
  assert.ok(CARDIO_TYPES.length > 0);
  for (const c of CARDIO_TYPES) {
    assert.equal(typeof c.key, 'string');
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.showDist, 'boolean');
    assert.equal(typeof c.showDur, 'boolean');
  }
});

test('formatCardioActivitiesForAI returns (none) for empty input', () => {
  assert.equal(formatCardioActivitiesForAI([]), '  (none)');
  assert.equal(formatCardioActivitiesForAI(null), '  (none)');
});

test('formatCardioActivitiesForAI includes label, distance, duration, notes', () => {
  const out = formatCardioActivitiesForAI([
    { type: 'long-run', distance: '8 km', duration: '45 min', notes: 'easy pace' }
  ]);
  assert.match(out, /Long run/);
  assert.match(out, /8 km/);
  assert.match(out, /45 min/);
  assert.match(out, /easy pace/);
});

test('formatCardioActivitiesForAI falls back to last type for unknown key', () => {
  const out = formatCardioActivitiesForAI([{ type: 'unknown-key', distance: '', duration: '', notes: '' }]);
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});
