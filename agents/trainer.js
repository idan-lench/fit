// Trainer agent — analyzes a workout session and returns calorie estimate + feedback.
// Called by the coach orchestrator (agents/coach.js, TBD) or directly after session save.

import { geminiGenerate } from '../integrations/gemini.js';
import { parseJSONResponse } from '../core/format.js';
import { PROMPTS } from '../prompts/index.js';
import { state } from '../data/state.js';
import { CARDIO_TYPES } from '../domain/cardio.js';
import { calculateSessionCalories } from '../domain/calories.js';

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

function buildUserMessage({ session, rpe, feel, outdoor, weather, calories }) {
  const parts = [
    `Session date: ${session.date}, time: ${session.time || 'unknown'}`,
    `Duration: ${session.durationMin ? session.durationMin + ' min' : 'unknown'}`,
    `RPE: ${rpe}/10`,
    `Feel: ${feel}`,
    `Location: ${outdoor ? 'outdoor' : 'indoor'}`,
  ];

  if (outdoor && weather) {
    parts.push(`Weather: ${weather.tempC}°C, humidity ${weather.humidity}%, ${weather.conditions}`);
  }

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

// ---------- WEATHER ----------

async function fetchWeather({ lat, lon, date, time }) {
  try {
    const hour = time ? parseInt(time.split(':')[0], 10) : 12;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relativehumidity_2m,weathercode&start_date=${date}&end_date=${date}&timezone=auto`;
    const res = await fetch(url);
    const data = await res.json();
    const tempC    = data.hourly?.temperature_2m?.[hour] ?? null;
    const humidity = data.hourly?.relativehumidity_2m?.[hour] ?? null;
    const code     = data.hourly?.weathercode?.[hour] ?? null;
    const conditions = weatherCodeLabel(code);
    return { tempC, humidity, conditions };
  } catch {
    return null;
  }
}

function weatherCodeLabel(code) {
  if (code === null) return 'unknown';
  if (code === 0) return 'clear sky';
  if (code <= 3) return 'partly cloudy';
  if (code <= 48) return 'foggy';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'rain showers';
  return 'thunderstorm';
}

async function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => resolve(null),
      { timeout: 5000 }
    );
  });
}

// ---------- MAIN ENTRY ----------

/**
 * Run the trainer agent on a completed session.
 * @param {object} session - the session object from state.sessions
 * @param {object} inputs  - { rpe: number, feel: string, outdoor: boolean }
 * @returns {object|null}  - parsed trainer result or null on failure
 */
export async function runTrainer(session, inputs) {
  const { rpe, feel, outdoor } = inputs;

  let weather = null;
  if (outdoor) {
    const loc = await getLocation();
    if (loc) weather = await fetchWeather({ ...loc, date: session.date, time: session.time });
  }

  const calories = calculateSessionCalories(session, { rpe, feel, outdoor, weather });

  const userMessage = buildUserMessage({ session, rpe, feel, outdoor, weather, calories });

  const reply = await geminiGenerate({
    systemInstruction: PROMPTS.trainerSystem,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    temperature: 0,
  });

  const llm = parseJSONResponse(reply);

  return {
    ...calories,
    consistency: llm?.consistency || 'insufficient_data',
    feedback:    llm?.feedback    || '',
    adjustPlan:  llm?.adjustPlan  || false,
    planNote:    llm?.planNote    || '',
  };
}
