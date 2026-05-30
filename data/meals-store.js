// SEAM: swap implementation here when moving to a cloud backend (Supabase,
// Firestore, etc.). Same exported names. Records: { id, items, total, ... }.

import { idbGet, idbWrite } from './db.js';

export const putMeal = r =>
  idbWrite('meals', s => s.put(r.id ? r : { ...r, created: r.created || Date.now() }));

export const getMeal = id => idbGet('meals', s => s.get(id));

export const getAllMeals = () =>
  idbGet('meals', s => s.getAll()).then(rows => rows.sort((a, b) => b.created - a.created));

export const deleteMeal = id => idbWrite('meals', s => s.delete(id));

export const clearMeals = () => idbWrite('meals', s => s.clear());
