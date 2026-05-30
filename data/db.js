// IndexedDB connection — holds three object stores: photos, meals, templates.
// (Database name 'fit-photos' is historical from when only photos lived here.)
// All store modules in data/ import openDB() from this file.

const DB_NAME = 'fit-photos';
const DB_VERSION = 3;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('photos'))    db.createObjectStore('photos',    { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('meals'))     db.createObjectStore('meals',     { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('templates')) db.createObjectStore('templates', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
