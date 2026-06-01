import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { putPhoto, getAllPhotos, deletePhoto, clearPhotos } = await import('./photo-store.js');

// Fake-indexeddb has no native Blob support; use a plain object as a stand-in.
const fakeBlob = (label) => ({ __blob: true, label, size: label.length });

test('putPhoto stores blob + date and returns an id', async () => {
  await clearPhotos();
  const id = await putPhoto(fakeBlob('photo-a'), '2026-05-28');
  assert.equal(typeof id, 'number');
  const all = await getAllPhotos();
  assert.equal(all.length, 1);
  assert.equal(all[0].date, '2026-05-28');
  assert.ok(all[0].created);
});

test('getAllPhotos sorts ASC by created (oldest first)', async () => {
  await clearPhotos();
  await putPhoto(fakeBlob('a'), '2026-01-01');
  await new Promise(r => setTimeout(r, 2));
  await putPhoto(fakeBlob('b'), '2026-01-02');
  const all = await getAllPhotos();
  assert.equal(all[0].date, '2026-01-01');
  assert.equal(all[1].date, '2026-01-02');
});

test('deletePhoto removes one row by id', async () => {
  await clearPhotos();
  const id = await putPhoto(fakeBlob('x'), '2026-01-01');
  await putPhoto(fakeBlob('y'), '2026-01-02');
  await deletePhoto(id);
  const all = await getAllPhotos();
  assert.equal(all.length, 1);
  assert.equal(all[0].date, '2026-01-02');
});
