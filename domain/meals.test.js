import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mealBlobs, recomputeMealTotals } from './meals.js';

// mealBlobs backwards-compat
test('mealBlobs returns blobs array for new-style records', () => {
  const blobs = [new Blob(['a']), new Blob(['b'])];
  assert.deepEqual(mealBlobs({ blobs }), blobs);
});

test('mealBlobs wraps single blob for old-style records', () => {
  const blob = new Blob(['x']);
  assert.deepEqual(mealBlobs({ blob }), [blob]);
});

test('mealBlobs returns empty array when no photos', () => {
  assert.deepEqual(mealBlobs({}), []);
  assert.deepEqual(mealBlobs({ description: 'pizza' }), []);
});

// recomputeMealTotals
test('recomputeMealTotals sums calories and protein', () => {
  const items = [
    { name: 'bread', calories: 80, protein: 3 },
    { name: 'egg', calories: 70, protein: 6 },
  ];
  const result = recomputeMealTotals(items);
  assert.equal(result.total, 150);
  assert.equal(result.protein, 9);
});

test('recomputeMealTotals returns null when items have no calories', () => {
  const items = [{ name: 'water' }];
  const result = recomputeMealTotals(items);
  assert.equal(result.total, null);
  assert.equal(result.protein, null);
});

test('recomputeMealTotals handles mixed items — only counts numeric values', () => {
  const items = [
    { name: 'a', calories: 100, protein: 10 },
    { name: 'b', calories: null },
    { name: 'c', protein: 5 },
  ];
  const result = recomputeMealTotals(items);
  assert.equal(result.total, 100);
  assert.equal(result.protein, 15);
});

test('recomputeMealTotals rounds to integers', () => {
  const items = [{ calories: 100.4, protein: 9.6 }];
  const result = recomputeMealTotals(items);
  assert.equal(result.total, 100);
  assert.equal(result.protein, 10);
});

test('recomputeMealTotals returns null totals for non-array input', () => {
  assert.deepEqual(recomputeMealTotals(null), { total: null, protein: null });
  assert.deepEqual(recomputeMealTotals(undefined), { total: null, protein: null });
  assert.deepEqual(recomputeMealTotals('bad'), { total: null, protein: null });
});
