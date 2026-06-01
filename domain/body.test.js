import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertMeasurement, removeMeasurement } from './body.js';

test('upsertMeasurement adds a new entry', () => {
  const result = upsertMeasurement([], '2026-05-31', 78.5);
  assert.deepEqual(result, [{ date: '2026-05-31', cm: 78.5 }]);
});

test('upsertMeasurement replaces existing entry for same date', () => {
  const ms = [{ date: '2026-05-31', cm: 78.0 }];
  const result = upsertMeasurement(ms, '2026-05-31', 77.5);
  assert.equal(result.length, 1);
  assert.equal(result[0].cm, 77.5);
});

test('upsertMeasurement preserves other dates', () => {
  const ms = [{ date: '2026-05-01', cm: 79.0 }];
  const result = upsertMeasurement(ms, '2026-05-31', 78.0);
  assert.equal(result.length, 2);
});

test('upsertMeasurement handles null/undefined array', () => {
  assert.deepEqual(upsertMeasurement(null, '2026-05-31', 78.0), [{ date: '2026-05-31', cm: 78.0 }]);
});

test('removeMeasurement removes the matching date', () => {
  const ms = [{ date: '2026-05-31', cm: 78.0 }, { date: '2026-05-01', cm: 79.0 }];
  const result = removeMeasurement(ms, '2026-05-31');
  assert.equal(result.length, 1);
  assert.equal(result[0].date, '2026-05-01');
});

test('removeMeasurement is a no-op when date not found', () => {
  const ms = [{ date: '2026-05-01', cm: 79.0 }];
  assert.equal(removeMeasurement(ms, '2026-05-31').length, 1);
});
