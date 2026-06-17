// Pure state transformers for step entries.
// Callers (app.js / ui/) own state mutation, save(), and re-renders.

export function upsertStep(steps, date, count, source) {
  const entry = source ? { date, count, source } : { date, count };
  return [...(steps || []).filter(s => s.date !== date), entry];
}

export function removeStep(steps, date) {
  return (steps || []).filter(s => s.date !== date);
}

// Merge several {date, count} entries (e.g. the multi-day server Fit payload),
// replacing any existing entry for those dates. Zero/blank counts are skipped.
// Returns { steps, changed } so callers can decide whether to save/re-render.
export function mergeSteps(steps, days, source) {
  let out = steps || [];
  let changed = false;
  for (const d of (days || [])) {
    const count = Number(d?.count);
    if (!d?.date || !(count > 0)) continue;
    const prev = out.find(s => s.date === d.date);
    if (prev && prev.count === count) continue;
    out = upsertStep(out, d.date, count, source);
    changed = true;
  }
  return { steps: out, changed };
}
