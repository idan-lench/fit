import { state, save } from '../data/state.js';
import { PROMPTS } from '../prompts/index.js';
import { getGeminiKey, callGeminiAnalysis } from '../integrations/gemini.js';
import { parseJSONResponse } from '../core/format.js';
import { toast, hideToast } from '../core/dom.js';
import { PLAN } from './plan.js';
import { CARDIO_TYPES, formatCardioActivitiesForAI } from './cardio.js';

// Returns true when state.current has no meaningful data logged yet
// (no sets, no cardio note, no cardio activities, no picked exercises).
export function isCurrentFresh(current) {
  if (!current) return true;
  if (current.entries.some(e => e.sets.length)) return false;
  if (current.cardioNote && current.cardioNote.trim()) return false;
  if ((current.cardioActivities || []).length > 0) return false;
  if (current.entries.length > 0) return false;
  return true;
}

// Returns true on success. Callers are responsible for calling renderHistory().
export async function autoAnalyzeSession(savedAt, opts = {}) {
  if (!getGeminiKey()) return false;
  const session = state.sessions.find(s => s.savedAt === savedAt);
  if (!session) return false;
  if (!opts.silent) toast('Analyzing workout…', { persistent: true });
  try {
    const exLines = (session.entries || []).filter(e => e.sets?.length).map(e =>
      `  - ${e.name}: ${e.sets.map(x => x.reps).join(',')}${e.durationMin ? ' (' + e.durationMin + ' min)' : ''}${e.note ? ' — note: ' + e.note : ''}`
    ).join('\n') || '  (none)';
    const duration = session.durationMin ? `${session.durationMin} min` : '(NOT LOGGED — must ask user)';
    const prompt = PROMPTS.sessionAnalysis
      .replace('{type}', PLAN[session.day]?.label || session.day)
      .replace('{date}', session.date)
      .replace('{cardioNote}', session.cardioNote || '(none)')
      .replace('{cardioActivities}', formatCardioActivitiesForAI(session.cardioActivities))
      .replace('{exercises}', exLines)
      .replace('{duration}', duration);
    const result = await callGeminiAnalysis(prompt);
    const parsed = parseJSONResponse(result);
    if (parsed && typeof parsed.total === 'number' && parsed.total > 0 && parsed.total < 5000) {
      session.caloriesBurned = Math.round(parsed.total);
      session.burnBreakdown = parsed.breakdown || [];
      session.burnNotes = parsed.notes || null;
      session.burnQuestions = (parsed.questions || []).filter(q => q && q.trim());
      save();
      if (!opts.silent) { hideToast(); toast(`Workout: ~${Math.round(parsed.total)} kcal ✓`); }
      return true;
    }
    if (!opts.silent) hideToast();
    return false;
  } catch (e) {
    if (!opts.silent) { hideToast(); toast('Analysis failed'); }
    return false;
  }
}

// ---------- WORKOUT HISTORY INDEX ----------

function _updateInPlace(session) {
  const wh = state.workoutHistory;
  for (const entry of (session.entries || [])) {
    if (!entry?.name || !entry.sets?.length) continue;
    wh.exercises[entry.name] = (wh.exercises[entry.name] || [])
      .filter(h => h.savedAt !== session.savedAt);
    wh.exercises[entry.name].push({
      date: session.date,
      savedAt: session.savedAt,
      sets: entry.sets.filter(Boolean).map(s => ({ reps: s.reps })),
      rpe: session.rpe,
      feel: session.feel,
      sessionKcal: session.caloriesBurned,
    });
    wh.exercises[entry.name].sort((a, b) => a.date.localeCompare(b.date));
  }
  for (const activity of (session.cardioActivities || [])) {
    if (!activity?.type) continue;
    const def = CARDIO_TYPES.find(c => c.key === activity.type) || { label: activity.type };
    const label = def.label;
    wh.cardio[label] = (wh.cardio[label] || [])
      .filter(h => h.savedAt !== session.savedAt);
    wh.cardio[label].push({
      date: session.date,
      savedAt: session.savedAt,
      distance: activity.distance,
      duration: activity.duration,
      notes: activity.notes,
      rpe: session.rpe,
      feel: session.feel,
      outdoor: session.outdoor,
      sessionKcal: session.caloriesBurned,
    });
    wh.cardio[label].sort((a, b) => a.date.localeCompare(b.date));
  }
}

// One-time migration: builds the index from all sessions if it's empty.
function ensureWorkoutHistory() {
  const wh = state.workoutHistory;
  const isEmpty = !Object.keys(wh.exercises).length && !Object.keys(wh.cardio).length;
  if (isEmpty && (state.sessions || []).length > 0) {
    for (const s of state.sessions) _updateInPlace(s);
    save();
  }
}

// Called after each session save (including after trainer result arrives).
export function updateWorkoutHistory(session) {
  _updateInPlace(session);
}

// Returns a compact formatted string of all exercises/cardio in the last daysBack days.
// Computed once per modal open and cached by the caller.
export function buildWorkoutHistoryContext(daysBack = 30) {
  ensureWorkoutHistory();
  const wh = state.workoutHistory;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffISO = cutoff.toISOString().split('T')[0];
  const lines = [];

  for (const [name, entries] of Object.entries(wh.exercises)) {
    const recent = entries.filter(e => e.date >= cutoffISO);
    if (!recent.length) continue;
    lines.push(`${name}:`);
    [...recent].reverse().forEach(e => {
      const sets = (e.sets || []).filter(Boolean).map(s => s.reps ?? '?').join(',');
      lines.push(`  ${e.date}: ${sets} reps${e.rpe ? ` · RPE ${e.rpe}` : ''}${e.feel ? ` · ${e.feel}` : ''}${e.sessionKcal ? ` · ${e.sessionKcal} kcal session` : ''}`);
    });
  }

  for (const [label, entries] of Object.entries(wh.cardio)) {
    const recent = entries.filter(e => e.date >= cutoffISO);
    if (!recent.length) continue;
    lines.push(`${label}:`);
    [...recent].reverse().forEach(e => {
      const detail = [e.distance, e.duration].filter(Boolean).join(', ');
      lines.push(`  ${e.date}: ${detail || '—'}${e.rpe ? ` · RPE ${e.rpe}` : ''}${e.feel ? ` · ${e.feel}` : ''}${e.outdoor ? ' · outdoor' : ''}${e.sessionKcal ? ` · ${e.sessionKcal} kcal session` : ''}`);
    });
  }

  return lines.join('\n') || `(no workout history in the last ${daysBack} days)`;
}
