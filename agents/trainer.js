// Trainer agent — analyzes a workout session and returns calorie estimate + feedback.
// Called by the coach orchestrator (agents/coach.js, TBD) or directly after session save.

import { geminiGenerate } from '../integrations/gemini.js';
import { parseJSONResponse } from '../core/format.js';
import { PROMPTS } from '../prompts/index.js';
import { state } from '../data/state.js';
import { CARDIO_TYPES } from '../domain/cardio.js';
import { calculateSessionCalories } from '../domain/calories.js';
import { latestWeightKg } from '../domain/body.js';

const SIMILAR_SESSION_LIMIT = 10;

// ---------- CONTEXT BUILDERS ----------

function buildSessionSummary(session) {
  const exercises = (session.entries || []).map(e =>
    `${e.name}: ${e.sets.map(s => s.reps).join(', ')} reps${e.note ? ` (${e.note})` : ''}`
  ).join('\n');

  const cardio = (session.cardioActivities || []).map(a => {
    const def = CARDIO_TYPES.find(c => c.key === a.type) || { label: a.type };
    return `${def.label}: ${[a.distance, a.duration, a.notes].filter(Boolean).join(', ')}`;
  }).join('\n');

  return [
    exercises && `Exercises:\n${exercises}`,
    cardio    && `Cardio:\n${cardio}`,
    session.cardioNote && `Cardio note: ${session.cardioNote}`,
  ].filter(Boolean).join('\n\n');
}

export function getSimilarSessions(session) {
  const allSessions = (state.sessions || []).filter(s => s.savedAt !== session.savedAt);
  const result = {};

  // Per exercise: last N sessions that contain this exercise
  for (const entry of (session.entries || [])) {
    if (!entry?.name) continue;
    const name = entry.name.toLowerCase();
    const matches = allSessions
      .filter(s => (s.entries || []).some(e => e?.name?.toLowerCase() === name))
      .slice(-SIMILAR_SESSION_LIMIT)
      .map(s => {
        const e = s.entries.find(e => e?.name?.toLowerCase() === name);
        if (!e) return null;
        return { date: s.date, sets: e.sets, note: e.note, rpe: s.rpe, feel: s.feel, caloriesBurned: s.caloriesBurned };
      })
      .filter(Boolean);
    if (matches.length) result[entry.name] = matches;
  }

  // Per cardio type: last N sessions with the same type
  for (const activity of (session.cardioActivities || [])) {
    if (!activity?.type) continue;
    const key = activity.type;
    const matches = allSessions
      .filter(s => (s.cardioActivities || []).some(a => a?.type === key))
      .slice(-SIMILAR_SESSION_LIMIT)
      .map(s => {
        const a = s.cardioActivities.find(a => a?.type === key);
        if (!a) return null;
        return { date: s.date, distance: a.distance, duration: a.duration, notes: a.notes, rpe: s.rpe, feel: s.feel, caloriesBurned: s.caloriesBurned };
      })
      .filter(Boolean);
    if (matches.length) {
      const def = CARDIO_TYPES.find(c => c.key === key) || { label: key };
      result[def.label] = matches;
    }
  }

  return result;
}

function buildUserMessage({ session, rpe, calories }) {
  const parts = [
    `Session date: ${session.date}, time: ${session.time || 'unknown'}`,
    `Duration: ${session.durationMin ? session.durationMin + ' min' : 'unknown'}`,
    `RPE: ${rpe}/10`,
  ];

  if (calories) {
    parts.push(`Pre-calculated burn: ${calories.caloriesBurned} kcal (EPOC: +${calories.epocToday} kcal today, +${calories.epocTomorrow} kcal tomorrow)`);
  }

  parts.push('', '--- Session ---', buildSessionSummary(session));

  const similar = getSimilarSessions(session);
  if (Object.keys(similar).length) {
    parts.push('', '--- Last similar sessions ---');
    for (const [name, sessions] of Object.entries(similar)) {
      parts.push(`\n${name}:`);
      sessions.forEach(s => {
        const detail = s.sets
          ? s.sets.map(x => x.reps).join(', ') + ' reps'
          : [s.distance, s.duration].filter(Boolean).join(', ');
        parts.push(`  ${s.date}: ${detail}${s.note ? ` — ${s.note}` : ''}${s.notes ? ` — ${s.notes}` : ''}`);
      });
    }
  }

  return parts.join('\n');
}

// ---------- MAIN ENTRY ----------

/**
 * Deterministic calorie recompute for a session using the current profile/weight.
 * No LLM — pure formula engine. Shared by runTrainer and the session-refine flow
 * so both resolve weight/swim level identically.
 * @param {object} session - the session object
 * @param {number} rpe     - effort 2–10
 * @returns {object} calculateSessionCalories result ({ caloriesBurned, breakdown, ... })
 */
export function computeSessionCalories(session, rpe) {
  const weightKg = latestWeightKg(state.weights) ?? state.profile?.weightKg ?? 58;
  const swimLevel = state.profile?.swimLevel || 'intermediate';
  // Build a map of exercise name → last resolved note from previous sessions,
  // so the engine can infer weight type (lever vs dumbbell) without asking again.
  const exerciseHistory = {};
  for (const s of (state.sessions || [])) {
    if (s.savedAt === session.savedAt) continue;
    for (const e of (s.entries || [])) {
      if (e.name && e.note) exerciseHistory[e.name] = e.note;
    }
  }
  return calculateSessionCalories(session, { rpe, weightKg, swimLevel, exerciseHistory });
}

/**
 * Run the trainer agent on a completed session.
 * @param {object} session - the session object from state.sessions
 * @param {object} inputs  - { rpe: number }
 * @returns {object|null}  - parsed trainer result or null on failure
 */
export async function runTrainer(session, inputs) {
  const { rpe } = inputs;

  // The calorie numbers are ALWAYS the deterministic engine's. The LLM only
  // adds feedback/consistency — so if the LLM call fails, we keep the engine
  // numbers and return without feedback. We never let an LLM set a kcal value.
  const calories = computeSessionCalories(session, rpe);

  let llm = null;
  try {
    const userMessage = buildUserMessage({ session, rpe, calories });
    const reply = await geminiGenerate({
      systemInstruction: PROMPTS.trainerSystem,
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      temperature: 0,
    });
    llm = parseJSONResponse(reply);
  } catch {
    llm = null; // LLM feedback unavailable — numbers stand on their own.
  }

  return {
    ...calories,
    consistency: llm?.consistency || 'insufficient_data',
    feedback:    llm?.feedback    || '',
    adjustPlan:  llm?.adjustPlan  || false,
    planNote:    llm?.planNote    || '',
  };
}
