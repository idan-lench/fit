import { state, save } from '../data/state.js';
import { getGeminiKey, callGeminiAnalysis } from '../integrations/gemini.js';
import { parseJSONResponse } from '../core/format.js';
import { toast, hideToast } from '../core/dom.js';
import { PLAN } from './plan.js';
import { formatCardioActivitiesForAI } from './cardio.js';

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
  const PROMPTS = window.PROMPTS || {};
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
