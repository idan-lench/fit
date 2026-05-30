import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { putMeal, getMeal, getAllMeals, deleteMeal, clearMeals } = await import('./meals-store.js');

test('putMeal assigns an id and getMeal reads it back', async () => {
  await clearMeals();
  const id = await putMeal({ items: [{ name: 'eggs', calories: 140 }], total: 140 });
  assert.equal(typeof id, 'number');
  const m = await getMeal(id);
  assert.equal(m.total, 140);
  assert.equal(m.items[0].name, 'eggs');
  assert.ok(m.created, 'created timestamp set on insert');
});

test('putMeal with explicit id updates in place', async () => {
  await clearMeals();
  const id = await putMeal({ items: [], total: 0 });
  await putMeal({ id, items: [{ name: 'rice' }], total: 250, created: 123 });
  const m = await getMeal(id);
  assert.equal(m.total, 250);
  assert.equal(m.created, 123, 'preserves explicit created');
});

test('getAllMeals returns most-recent-first', async () => {
  await clearMeals();
  // Use explicit created so ordering is deterministic
  await putMeal({ created: 100, total: 1 });
  await putMeal({ created: 300, total: 3 });
  await putMeal({ created: 200, total: 2 });
  const all = await getAllMeals();
  assert.deepEqual(all.map(m => m.total), [3, 2, 1]);
});

test('deleteMeal removes the row', async () => {
  await clearMeals();
  const id = await putMeal({ total: 99 });
  await deleteMeal(id);
  const m = await getMeal(id);
  assert.equal(m, undefined);
});

test('clearMeals empties the store', async () => {
  await putMeal({ total: 1 });
  await putMeal({ total: 2 });
  await clearMeals();
  assert.equal((await getAllMeals()).length, 0);
});
