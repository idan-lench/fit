// App state persisted in localStorage. Singleton; importers share the same
// object reference. Mutate fields, then call save() — do not reassign.
//
// SEAM: swap implementation here when moving to a cloud backend (Supabase,
// Firestore, etc.). Same exported names, same shape.

const STORE_KEY = 'fit.v1';

export function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

export function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
}

export const state = load() || {
  sessions: [], measurements: [], current: null, steps: [], dailyNotes: [],
};
state.steps = state.steps || [];
state.dailyNotes = state.dailyNotes || [];
