// SEAM: swap implementation here when moving to a cloud backend (Supabase,
// Firestore, etc.). Same exported names. Records: meal templates with a
// "lastUsed" timestamp used for recency ordering.

import { openDB } from './db.js';

export async function putTemplate(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const value = record.id ? record : { ...record, created: record.created || Date.now() };
    const req = db.transaction('templates', 'readwrite').objectStore('templates').put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllTemplates() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('templates').objectStore('templates').getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => (b.lastUsed || b.created || 0) - (a.lastUsed || a.created || 0)));
    req.onerror = () => reject(req.error);
  });
}

export async function getTemplate(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('templates').objectStore('templates').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteTemplate(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('templates', 'readwrite').objectStore('templates').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
