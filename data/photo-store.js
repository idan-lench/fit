// SEAM: swap implementation here when moving to a cloud backend (Supabase
// Storage, S3, etc.). Same exported names, same shape: each photo is
// { id, blob, date, created }.

import { idbGet, idbWrite } from './db.js';

export const putPhoto = (blob, date) =>
  idbWrite('photos', s => s.add({ blob, date, created: Date.now() }));

export const getAllPhotos = () =>
  idbGet('photos', s => s.getAll()).then(rows => rows.sort((a, b) => a.created - b.created));

export const deletePhoto = id => idbWrite('photos', s => s.delete(id));

export const clearPhotos = () => idbWrite('photos', s => s.clear());
