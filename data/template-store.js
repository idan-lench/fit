// SEAM: swap implementation here when moving to a cloud backend (Supabase,
// Firestore, etc.). Same exported names. Records: meal templates with a
// "lastUsed" timestamp used for recency ordering.

import { idbGet, idbWrite } from './db.js';

export const putTemplate = r =>
  idbWrite('templates', s => s.put(r.id ? r : { ...r, created: r.created || Date.now() }));

export const getAllTemplates = () =>
  idbGet('templates', s => s.getAll())
    .then(rows => (rows || []).sort((a, b) => (b.lastUsed || b.created || 0) - (a.lastUsed || a.created || 0)));

export const getTemplate = id => idbGet('templates', s => s.get(id));

export const deleteTemplate = id => idbWrite('templates', s => s.delete(id));
