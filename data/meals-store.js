// SEAM: swap implementation here when moving to a cloud backend (Supabase,
// Firestore, etc.). Same exported names. Records: { id, items, total, ... }.

import { openDB } from './db.js';

export async function putMeal(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const value = record.id ? record : { ...record, created: record.created || Date.now() };
    const req = db.transaction('meals', 'readwrite').objectStore('meals').put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getMeal(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('meals').objectStore('meals').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllMeals() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('meals').objectStore('meals').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.created - a.created));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMeal(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('meals', 'readwrite').objectStore('meals').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearMeals() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('meals', 'readwrite').objectStore('meals').clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
