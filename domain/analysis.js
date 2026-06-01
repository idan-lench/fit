import { getAllMeals } from '../data/meals-store.js';
import { PROMPTS } from '../prompts/index.js';
import { state, save } from '../data/state.js';
import { calcBMR, calcStepsPerKcal } from '../core/profile.js';
import { getGeminiKey, callGeminiAnalysis } from '../integrations/gemini.js';
import { silentSyncGoogleFit } from '../integrations/google-fit.js';
import { parseJSONResponse } from '../core/format.js';
import { toast, hideToast } from '../core/dom.js';
import { todayISO } from '../core/time.js';
import { PLAN } from './plan.js';

// ---------- PURE DATE HELPERS ----------

export function weekStartFor(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - date.getDay()); // back to Sunday
  return [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
}

export function weekDates(weekStartISO) {
  const [y, m, d] = weekStartISO.split('-').map(Number);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(y, m - 1, d + i);
    out.push([dt.getFullYear(), String(dt.getMonth()+1).padStart(2,'0'), String(dt.getDate()).padStart(2,'0')].join('-'));
  }
  return out;
}

export function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// ---------- ENERGY ----------

export async function computeDailyEnergy(date) {
  const BMR = calcBMR(state.profile);
  const STEPS_PER_KCAL = calcStepsPerKcal(state.profile);
  const meals = await getAllMeals();
  const todayMeals = meals.filter(m => m.date === date);
  const mealsWithCal = todayMeals.filter(m => typeof m.calories === 'number' && m.calories > 0);
  const eaten = mealsWithCal.reduce((sum, m) => sum + m.calories, 0);
  const protein = todayMeals.reduce((sum, m) => sum + (typeof m.protein === 'number' ? m.protein : 0), 0);

  let burned = BMR;
  let stepsBurn = 0;
  let sessionBurn = 0;
  const stepsEntry = (state.steps || []).find(s => s.date === date);
  if (stepsEntry) {
    stepsBurn = Math.round(stepsEntry.count / STEPS_PER_KCAL);
    burned += stepsBurn;
  }
  for (const s of (state.sessions || []).filter(s => s.date === date)) {
    if (typeof s.caloriesBurned === 'number') sessionBurn += s.caloriesBurned;
  }
  burned += sessionBurn;

  return {
    eaten, burned, protein,
    bmr: BMR, stepsBurn, sessionBurn,
    mealCount: todayMeals.length,
    estimatedCount: mealsWithCal.length
  };
}

// ---------- FINGERPRINTS ----------

export async function dayFingerprint(date) {
  const allMeals = await getAllMeals();
  const dayMeals = allMeals.filter(m => m.date === date);
  const daySessions = (state.sessions || []).filter(s => s.date === date);
  const daySteps = (state.steps || []).find(s => s.date === date);
  const mealSig = dayMeals.map(m => `${m.created}:${m.calories ?? ''}:${m.protein ?? ''}`).sort().join('|');
  const sessionSig = daySessions.map(s => `${s.savedAt}:${s.caloriesBurned ?? ''}`).sort().join('|');
  const stepSig = daySteps ? String(daySteps.count) : '';
  return [mealSig, sessionSig, stepSig].join('§');
}

export async function weeklyFingerprint(weekStartISO) {
  const days = weekDates(weekStartISO);
  const fps = [];
  for (const d of days) fps.push(await dayFingerprint(d));
  return fps.join('||');
}

// ---------- AI ANALYSIS ----------

// Returns the parsed result or null. Callers are responsible for renderAnalysis().
export async function runDailyAnalysis(opts = {}) {
  if (!getGeminiKey()) return null;
  const targetDate = opts.date || todayISO();
  const isToday = targetDate === todayISO();
  await silentSyncGoogleFit(targetDate);
  const e = await computeDailyEnergy(targetDate);
  const meals = await getAllMeals();
  const dayMeals = meals.filter(m => m.date === targetDate).map(m => ({
    time: m.time,
    description: m.description || '(none)',
    calories: m.calories || null,
    protein: m.protein || null,
    breakdown: (m.breakdown || []).map(b => `${b.name} ${b.portion || ''}: ${b.calories}kcal ${b.protein ? b.protein + 'g P' : ''}`.trim())
  }));
  const daySessions = (state.sessions || []).filter(s => s.date === targetDate).map(s => ({
    type: PLAN[s.day]?.label || s.day,
    cardio: s.cardioNote || null,
    burn: s.caloriesBurned || null,
    exercises: (s.entries || []).filter(en => en.sets?.length).map(en => `${en.name}: ${en.sets.map(x => x.reps).join(',')}`)
  }));
  const stepsDay = (state.steps || []).find(s => s.date === targetDate);
  const time = isToday
    ? (() => { const n = new Date(); return String(n.getHours()).padStart(2,'0') + ':' + String(n.getMinutes()).padStart(2,'0'); })()
    : '23:59';

  const recentContext = [];
  for (let i = 1; i <= 7; i++) {
    const [y, m, d] = targetDate.split('-').map(Number);
    const dt = new Date(y, m - 1, d - i);
    const pastDate = [dt.getFullYear(), String(dt.getMonth()+1).padStart(2,'0'), String(dt.getDate()).padStart(2,'0')].join('-');
    const pastNote = (state.dailyNotes || []).find(n => n.date === pastDate);
    const pastE = await computeDailyEnergy(pastDate);
    recentContext.push({
      date: pastDate,
      eaten: pastE.eaten, burned: pastE.burned, protein: pastE.protein,
      steps: ((state.steps || []).find(s => s.date === pastDate) || {}).count || 0,
      verdict: pastNote ? pastNote.note.split('\n')[0] : null
    });
  }

  const prompt = PROMPTS.dailyAnalysis
    .replace('{date}', targetDate)
    .replace('{time}', time)
    .replace('{steps}', stepsDay ? String(stepsDay.count) : 'NOT LOGGED')
    .replace('{eaten}', String(e.eaten))
    .replace('{burned}', String(e.burned))
    .replace('{protein}', String(e.protein))
    .replace('{meals}', JSON.stringify(dayMeals))
    .replace('{sessions}', JSON.stringify(daySessions))
    .replace('{recentDays}', JSON.stringify(recentContext));

  if (!opts.silent) toast('Generating daily analysis…', { persistent: true });
  try {
    const result = await callGeminiAnalysis(prompt);
    const parsed = parseJSONResponse(result);
    if (!parsed) {
      if (!opts.silent) { hideToast(); toast('Daily analysis failed'); }
      return null;
    }
    state.dailyNotes = (state.dailyNotes || []).filter(n => n.date !== targetDate);
    const noteText = `${parsed.verdict || ''}

${(parsed.wins || []).length ? '💪 Wins\n' + parsed.wins.map(w => '• ' + w).join('\n') + '\n\n' : ''}${(parsed.watch || []).length ? '⚠️ Watch\n' + parsed.watch.map(w => '• ' + w).join('\n') + '\n\n' : ''}${parsed.pattern ? '📈 ' + parsed.pattern + '\n\n' : ''}${(parsed.missing || []).length ? '❗ Missing: ' + parsed.missing.join(', ') + '\n\n' : ''}${parsed.tomorrow ? '📝 ' + parsed.tomorrow : ''}

${parsed.isFinal ? '(Final summary)' : '(Partial — day in progress)'} · Generated ${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;
    state.dailyNotes.push({
      date: targetDate,
      note: noteText.trim(),
      fingerprint: opts.fingerprint || null,
      addedAt: new Date().toISOString()
    });
    save();
    if (!opts.silent) { hideToast(); toast('Daily analysis updated ✓'); }
    return parsed;
  } catch (err) {
    if (!opts.silent) { hideToast(); toast('Daily analysis failed'); }
    return null;
  }
}

// Returns the parsed result or null. Callers are responsible for renderAnalysis().
export async function runWeeklyAnalysis(opts = {}) {
  if (!getGeminiKey()) return null;
  const weekStart = opts.weekStart || weekStartFor(todayISO());
  const days = weekDates(weekStart);
  const allMeals = await getAllMeals();
  const weekData = [];
  for (const d of days) {
    const dayMeals = allMeals.filter(m => m.date === d).map(m => ({
      time: m.time, description: m.description || '(none)',
      calories: m.calories || null, protein: m.protein || null
    }));
    const daySessions = (state.sessions || []).filter(s => s.date === d).map(s => ({
      type: PLAN[s.day]?.label || s.day,
      cardio: s.cardioNote || null,
      burn: s.caloriesBurned || null,
      exercises: (s.entries || []).filter(en => en.sets?.length).map(en => `${en.name}: ${en.sets.map(x => x.reps).join(',')}`)
    }));
    const e = await computeDailyEnergy(d);
    const stepsRec = (state.steps || []).find(s => s.date === d);
    weekData.push({
      date: d,
      dayName: new Date(...d.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v))).toLocaleDateString(undefined, { weekday: 'long' }),
      eaten: e.eaten, burned: e.burned, protein: e.protein,
      steps: stepsRec?.count || 0,
      meals: dayMeals, sessions: daySessions
    });
  }

  const prompt = (PROMPTS.weeklyAnalysis || '').replace('{weekStart}', weekStart).replace('{weekData}', JSON.stringify(weekData, null, 2));
  if (!prompt) return null;

  if (!opts.silent) toast('Generating weekly analysis…', { persistent: true });
  try {
    const result = await callGeminiAnalysis(prompt);
    const parsed = parseJSONResponse(result);
    if (!parsed) {
      if (!opts.silent) { hideToast(); toast('Weekly analysis failed'); }
      return null;
    }
    state.weeklyNotes = (state.weeklyNotes || []).filter(n => n.weekStart !== weekStart);
    const noteText = `${parsed.headline || ''}

${(parsed.wins || []).length ? '💪 Wins\n' + parsed.wins.map(w => '• ' + w).join('\n') + '\n\n' : ''}${(parsed.watch || []).length ? '⚠️ Watch\n' + parsed.watch.map(w => '• ' + w).join('\n') + '\n\n' : ''}${parsed.pattern ? '📈 ' + parsed.pattern + '\n\n' : ''}${(parsed.nextWeek || []).length ? '📝 Next week\n' + parsed.nextWeek.map(r => '• ' + r).join('\n') : ''}

Generated ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    state.weeklyNotes.push({
      weekStart,
      note: noteText.trim(),
      fingerprint: opts.fingerprint || null,
      addedAt: new Date().toISOString()
    });
    save();
    if (!opts.silent) { hideToast(); toast('Weekly analysis ✓'); }
    return parsed;
  } catch (err) {
    if (!opts.silent) { hideToast(); toast('Weekly analysis failed'); }
    return null;
  }
}

export async function maybeGenerateWeekly(weekStartISO) {
  const fp = await weeklyFingerprint(weekStartISO);
  const existing = (state.weeklyNotes || []).find(n => n.weekStart === weekStartISO);
  if (existing && existing.fingerprint === fp) return;
  await runWeeklyAnalysis({ weekStart: weekStartISO, fingerprint: fp, silent: true });
}

export async function autoGenerateMissingSummaries() {
  if (!getGeminiKey()) return;
  const today = todayISO();
  const yesterday = yesterdayISO();
  const notes = state.dailyNotes || [];

  const hasYesterday = notes.some(n => n.date === yesterday);
  const stepsYesterday = (state.steps || []).find(s => s.date === yesterday);
  if (!hasYesterday && stepsYesterday) {
    await runDailyAnalysis({ date: yesterday, silent: true });
  }

  const hour = new Date().getHours();
  if (hour >= 21) {
    const hasToday = notes.some(n => n.date === today);
    const stepsToday = (state.steps || []).find(s => s.date === today);
    if (!hasToday && stepsToday) {
      await runDailyAnalysis({ date: today, silent: true });
    }
  }
}
