import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { putTemplate, getAllTemplates, getTemplate, deleteTemplate } = await import('./template-store.js');

test('putTemplate + getTemplate round trip', async () => {
  const id = await putTemplate({ name: 'Israeli breakfast', items: [], total: 480 });
  const t = await getTemplate(id);
  assert.equal(t.name, 'Israeli breakfast');
  assert.equal(t.total, 480);
});

test('getAllTemplates orders by lastUsed DESC, falling back to created', async () => {
  // Reset by reading existing then deleting (no clearTemplates exported in source)
  for (const t of await getAllTemplates()) await deleteTemplate(t.id);

  await putTemplate({ name: 'oldest',  created: 100 });
  await putTemplate({ name: 'middle',  created: 200, lastUsed: 250 });
  await putTemplate({ name: 'newest',  created: 300 });
  const all = await getAllTemplates();
  // middle has lastUsed=250 (highest), then newest (created=300), then oldest (created=100)
  assert.deepEqual(all.map(t => t.name), ['newest', 'middle', 'oldest']);
});

test('deleteTemplate removes a row', async () => {
  const id = await putTemplate({ name: 'temp' });
  await deleteTemplate(id);
  assert.equal(await getTemplate(id), undefined);
});
