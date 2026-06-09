// Pure state transformers for body measurements.
// Callers (app.js / ui/) own state mutation, save(), and re-renders.

export function upsertMeasurement(measurements, date, cm) {
  return [...(measurements || []).filter(m => m.date !== date), { date, cm }];
}

export function removeMeasurement(measurements, date) {
  return (measurements || []).filter(m => m.date !== date);
}

export function upsertWeight(weights, date, kg) {
  return [...(weights || []).filter(w => w.date !== date), { date, kg }];
}

export function removeWeight(weights, date) {
  return (weights || []).filter(w => w.date !== date);
}

export function latestWeightKg(weights) {
  if (!weights || weights.length === 0) return null;
  const sorted = weights.slice().sort((a, b) => a.date.localeCompare(b.date));
  return sorted[sorted.length - 1].kg;
}
