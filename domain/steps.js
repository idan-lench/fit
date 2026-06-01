// Pure state transformers for step entries.
// Callers (app.js / ui/) own state mutation, save(), and re-renders.

export function upsertStep(steps, date, count) {
  return [...(steps || []).filter(s => s.date !== date), { date, count }];
}

export function removeStep(steps, date) {
  return (steps || []).filter(s => s.date !== date);
}
