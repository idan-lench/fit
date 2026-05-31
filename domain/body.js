// Pure state transformers for body measurements.
// Callers (app.js / ui/) own state mutation, save(), and re-renders.

export function upsertMeasurement(measurements, date, cm) {
  return [...(measurements || []).filter(m => m.date !== date), { date, cm }];
}

export function removeMeasurement(measurements, date) {
  return (measurements || []).filter(m => m.date !== date);
}
