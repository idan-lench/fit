import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertStep, removeStep } from './steps.js';

test('upsertStep adds a new entry', () => {
  const result = upsertStep([], '2026-05-31', 8000);
  assert.deepEqual(result, [{ date: '2026-05-31', count: 8000 }]);
});

test('upsertStep replaces an existing entry for the same date', () => {
  const steps = [{ date: '2026-05-31', count: 5000 }];
  const result = upsertStep(steps, '2026-05-31', 9000);
  assert.equal(result.length, 1);
  assert.equal(result[0].count, 9000);
});

test('upsertStep preserves entries for other dates', () => {
  const steps = [{ date: '2026-05-30', count: 7000 }];
  const result = upsertStep(steps, '2026-05-31', 8000);
  assert.equal(result.length, 2);
});

test('upsertStep handles null/undefined steps array', () => {
  assert.deepEqual(upsertStep(null, '2026-05-31', 5000), [{ date: '2026-05-31', count: 5000 }]);
});

test('removeStep removes the matching date', () => {
  const steps = [{ date: '2026-05-31', count: 8000 }, { date: '2026-05-30', count: 7000 }];
  const result = removeStep(steps, '2026-05-31');
  assert.equal(result.length, 1);
  assert.equal(result[0].date, '2026-05-30');
});

test('removeStep is a no-op when date not found', () => {
  const steps = [{ date: '2026-05-30', count: 7000 }];
  const result = removeStep(steps, '2026-05-31');
  assert.equal(result.length, 1);
});
