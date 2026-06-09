// App state persisted in localStorage. Singleton; importers share the same
// object reference. Mutate fields, then call save() — do not reassign.
//
// SEAM: swap implementation here when moving to a cloud backend (Supabase,
// Firestore, etc.). Same exported names, same shape.

const STORE_KEY = 'fit.v1';

// Strip base64 image blobs before persisting — they belong in IndexedDB, not localStorage.
// In-memory state keeps them for display during the current session; only storage is lean.
function stripForStorage(obj) {
  if (Array.isArray(obj)) return obj.map(stripForStorage);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'dataUrl' && typeof v === 'string' && v.startsWith('data:')) {
        // drop base64 blob entirely
      } else {
        out[k] = stripForStorage(v);
      }
    }
    return out;
  }
  return obj;
}

export function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(stripForStorage(state)));
  } catch (e) {
    // QuotaExceededError name varies by browser
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22) {
      throw new Error('Storage full — please clear old data in Settings');
    }
    throw e;
  }
}

export function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
}

export const state = load() || {
  sessions: [], measurements: [], current: null, steps: [],
};
state.steps = state.steps || [];
state.weights = state.weights || [];
state.workoutHistory = state.workoutHistory || { exercises: {}, cardio: {} };
