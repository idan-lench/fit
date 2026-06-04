import { idbGet, idbWrite } from './db.js';

const STORE = 'daily-notes';

export function getDailyNote(date) {
  return idbGet(STORE, s => s.get(date));
}

export function upsertDailyNote(note) {
  return idbWrite(STORE, s => s.put(note));
}

export function getAllDailyNotes() {
  return idbGet(STORE, s => s.getAll());
}

export async function getRecentDailyNotes(n) {
  const all = await getAllDailyNotes();
  return all.sort((a, b) => a.date.localeCompare(b.date)).slice(-n);
}

export function clearDailyNotes() {
  return idbWrite(STORE, s => s.clear());
}
