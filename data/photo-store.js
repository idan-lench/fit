// SEAM: swap implementation here when moving to a cloud backend (Supabase
// Storage, S3, etc.). Same exported names, same shape: each photo is
// { id, blob, date, created }.

import { openDB } from './db.js';

export async function putPhoto(blob, date) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    const req = tx.objectStore('photos').add({ blob, date, created: Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllPhotos() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('photos').objectStore('photos').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.created - b.created));
    req.onerror = () => reject(req.error);
  });
}

export async function deletePhoto(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('photos', 'readwrite').objectStore('photos').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearPhotos() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('photos', 'readwrite').objectStore('photos').clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
