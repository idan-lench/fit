import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertStep, removeStep, mergeSteps } from './steps.js';

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

test('upsertStep tags the source when provided', () => {
  assert.deepEqual(upsertStep([], '2026-05-31', 5000, 'gfit-server'),
    [{ date: '2026-05-31', count: 5000, source: 'gfit-server' }]);
});

test('mergeSteps upserts multiple days and reports changed', () => {
  const { steps, changed } = mergeSteps(
    [{ date: '2026-06-15', count: 3000 }],
    [{ date: '2026-06-16', count: 5000 }, { date: '2026-06-17', count: 1500 }],
    'gfit-server'
  );
  assert.equal(changed, true);
  assert.equal(steps.length, 3);
  assert.equal(steps.find(s => s.date === '2026-06-17').source, 'gfit-server');
});

test('mergeSteps skips zero/blank counts and is a no-op when unchanged', () => {
  const start = [{ date: '2026-06-16', count: 5000, source: 'gfit-server' }];
  const { steps, changed } = mergeSteps(start, [
    { date: '2026-06-16', count: 5000 }, // same → no change
    { date: '2026-06-17', count: 0 },    // zero → skipped
  ], 'gfit-server');
  assert.equal(changed, false);
  assert.equal(steps.length, 1);
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
