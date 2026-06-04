// IndexedDB connection — holds four object stores: photos, meals, templates, daily-notes.
// (Database name 'fit-photos' is historical from when only photos lived here.)
// All store modules in data/ go through openDB() and the idbGet/idbWrite
// helpers below.

const DB_NAME = 'fit-photos';
const DB_VERSION = 4;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('photos'))      db.createObjectStore('photos',      { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('meals'))       db.createObjectStore('meals',       { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('templates'))   db.createObjectStore('templates',   { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('daily-notes')) db.createObjectStore('daily-notes', { keyPath: 'date' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// One-shot read transaction. `op` receives the object store and must return
// a single IDBRequest; its `result` resolves the promise.
export async function idbGet(storeName, op) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = op(db.transaction(storeName).objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// One-shot write transaction. `op` receives the object store and must return
// an IDBRequest (e.g. .add / .put / .delete / .clear).
export async function idbWrite(storeName, op) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = op(db.transaction(storeName, 'readwrite').objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
