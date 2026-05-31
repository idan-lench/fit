// ---------- IMPORTS (core/) ----------
import { _isoDate, todayISO, formatDate } from './core/time.js';
import { escapeHtml, blobToDataUrl, parseJSONResponse } from './core/format.js';
import { autoResizeTA, toast, hideToast } from './core/dom.js';
import { DEFAULT_PROFILE, calcBMR, calcStepsPerKcal } from './core/profile.js';
import { state, save, load } from './data/state.js';
import { putPhoto, getAllPhotos, deletePhoto, clearPhotos } from './data/photo-store.js';
import { putMeal, getMeal, getAllMeals, deleteMeal, clearMeals } from './data/meals-store.js';
import { putTemplate, getAllTemplates, getTemplate, deleteTemplate } from './data/template-store.js';
import {
  getGeminiKey, setGeminiKey, geminiGenerate, callGeminiAnalysis,
} from './integrations/gemini.js';
import {
  loadCachedGfitToken, gfitGetToken, gfitDateRange,
  gfitAggregate, gfitExtractInt, gfitExtractFloat,
  silentSyncGoogleFit, autoSilentFitSync, clearCachedGfitToken,
} from './integrations/google-fit.js';
import {
  ensureSecret, pullFromDrive, pullFromDriveForce, applyDrivePayload, exportData,
  restorePhotosFromDrive, buildAppsScript, checkSyncImportFromUrl,
  pingSync, uploadToDrive, photoSizeKey as _photoSizeKey,
} from './integrations/drive-sync.js';
import { PLAN, WEEKLY_PLAN, getPlanKeyForDate, suggestedDay } from './domain/plan.js';
import { EXERCISE_LIBRARY, getPrevSets as getPrevSetsInSessions } from './domain/exercises.js';
import { CARDIO_TYPES, formatCardioActivitiesForAI } from './domain/cardio.js';
import { MUSCLE_MAP, computeMuscleHeatmap, renderMuscleHeatmapSvg } from './domain/muscle-map.js';
import { mealBlobs, recomputeMealTotals, reconcileMealTotals, autoAnalyzeMeal } from './domain/meals.js';
import { applyTemplateDelta } from './domain/templates.js';
import { isCurrentFresh, autoAnalyzeSession } from './domain/workouts.js';
import { upsertStep, removeStep } from './domain/steps.js';
import { upsertMeasurement, removeMeasurement } from './domain/body.js';
import { computeDailyEnergy, weekStartFor, weekDates, yesterdayISO, dayFingerprint, weeklyFingerprint, runDailyAnalysis, runWeeklyAnalysis, maybeGenerateWeekly, autoGenerateMissingSummaries } from './domain/analysis.js';
import { drawChart, drawStepsChart } from './ui/shared/chart.js';
import { attachFilesTo, renderAttachPreview } from './ui/shared/chat-input.js';
import { openHeatmap, closeHeatmap } from './ui/shared/heatmap.js';

// ---------- DATA ----------



// Personal parameters live on state.profile. Eventually written by the
// Coach/Trainer/Dietitian agents (see AGENT_PLAN.md); seeded from defaults
// on first load.
state.profile = state.profile || JSON.parse(JSON.stringify(DEFAULT_PROFILE));

// Local handles derived from state.profile. Existing call sites read these
// names directly; when an agent updates state.profile, call refreshProfile()
// to re-derive. They are `let` (not `const`) for that reason.
let STEPS_GOAL, WAIST_GOAL, BMR, DAILY_CAL_GOAL, DAILY_PROTEIN_GOAL, STEPS_PER_KCAL;
function refreshProfile() {
  const p = state.profile;
  STEPS_GOAL          = p.goals.steps;
  WAIST_GOAL          = p.goals.waistCm;
  DAILY_CAL_GOAL      = p.goals.dailyCalories;
  DAILY_PROTEIN_GOAL  = p.goals.dailyProteinG;
  BMR                 = calcBMR(p);
  STEPS_PER_KCAL      = calcStepsPerKcal(p);
}
refreshProfile();
window.refreshProfile = refreshProfile; // agents/tools will call this after writes


// AI PROMPTS — defined in prompts.js (separate file in repo for easy review).
// Fallback to embedded copy if prompts.js fails to load.
const PROMPTS = window.PROMPTS || {
  mealAnalysis: `You are estimating calories for a meal eaten by a 58kg, 44yo adult male in Israel/Mediterranean diet context. Be CONSERVATIVE on portions — Mediterranean/Israeli portions are smaller than American standards.

CRITICAL RULES:
1. **The user's description is your primary guide.** If they wrote "bread", they ate the bread, not everything in the photo.
2. **Focus on the FOREGROUND / clearly eaten item.** Items in the background or other plates/containers are NOT what was eaten unless the description says so.
3. **Be conservative on portions.** Default to a normal single serving:
   - 1 slice bread = ~30g (~80 kcal), not a baguette
   - Salad bowl = ~150-200g typical, not 400g
   - Cottage cheese full container in Israel = 250g (~280 kcal at 5% fat)
   - Tahini "sauce" in restaurants is diluted with water/lemon — count at ~half pure tahini calories
4. **If the user gave a quantity** ("half", "25% of", "3/4", "1 slice") respect it strictly.
5. **Don't inflate from packaging.** Empty/partial containers shown for context aren't eaten in full.
6. **Don't double-count** — if ingredients in the photo seem typical of multiple separate meal logs (e.g. cottage + bread + veg on one plate), only count what the description says.

USER'S DESCRIPTION: "{description}"

Return ONLY valid JSON. No markdown, no code fences. Format:
{
  "items": [
    {"name": "string", "portion": "specific portion (grams, slices, etc.)", "calories": number, "protein": number}
  ],
  "total": number,
  "totalProtein": number,
  "confidence": "high" | "medium" | "low",
  "saw": "one-sentence factual description of what's in the photo, including items NOT counted (e.g. 'I see X and Y in foreground, plus Z in background which I ignored per the rules')"
}`,

  sessionAnalysis: `You are estimating calories burned for a workout session by a 58kg, 44yo adult male.

SESSION:
- Type: {type}
- Date: {date}
- Cardio/activity: {cardioNote}
- Exercises and reps:
{exercises}

INSTRUCTIONS:
1. Use MET (metabolic equivalent) values appropriate for each activity.
2. For bodyweight strength, estimate based on time-under-tension and total reps.
3. Provide a clear breakdown so the user can verify your math.

Return ONLY valid JSON. No markdown, no code fences. Format:
{
  "total": number,
  "breakdown": [
    {"activity": "string", "calories": number, "reasoning": "brief — e.g. '8km run at 5:30/km, ~10 MET, 40 min'"}
  ],
  "notes": "brief overall comment"
}`,

  dailyAnalysis: `You are reviewing today's fitness data for a 58kg, 44yo adult male.
Goal: drop waist from 78cm to 75cm + build upper-body muscle.

CONTEXT:
- Today's date: {date}
- Current time: {time}
- This is FINAL summary if time > 21:00, otherwise PARTIAL check-in.
- Daily intake target: 1700 kcal for mild fat loss.
- BMR: 1415 kcal (resting burn).
- Daily steps target: 10000.
- Protein target: ~95g/day.

REQUIRED DATA — flag if missing:
- Steps (must always be logged)

DATA:
- Steps: {steps}
- Meals (with calorie estimates): {meals}
- Sessions (with burn estimates): {sessions}

Return ONLY valid JSON. No markdown. Format:
{
  "isFinal": boolean,
  "eaten": number,
  "burned": number,
  "net": number,
  "verdict": "1-sentence overall judgement (deficit/maintenance/surplus, on track / off track)",
  "wins": ["string"],
  "watch": ["string"],
  "missing": ["any required data not logged today"],
  "recommendations": "1-2 sentences for tomorrow (if final) or rest of day (if partial)"
}`,

  chatSystem: `You are a friendly, evidence-based fitness coach. The user is a 44yo male, 168cm, 58kg, lean but low muscle, goal: drop waist from 78 to 75 cm + build muscle. Use the data provided to answer specifically and concisely. Reference exact numbers when relevant. Don't pad — be direct. If data is missing, say so.

Today's date: {today}

Full data:
{data}`
};
let currentDay = 'tue';
let analysisViewDate = null; // null = today
let currentSetCtx = null; // {exerciseIdx}
let currentReps = 8;


// ---------- TABS ----------
function switchTab(name) {
  document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  const titles = { workout: 'Workout', meals: 'Meals', analysis: 'Insights', body: 'Body', ai: 'Chat' };
  const titleEl = document.getElementById('pageTitle');
  if (titleEl && titles[name]) titleEl.textContent = titles[name];
  if (name === 'workout') renderWorkout();
  if (name === 'body') { renderBody(); renderPhotos(); }
  if (name === 'meals') renderMeals();
  if (name === 'analysis') renderAnalysis();
  if (name === 'ai') renderAI();
}

// ---------- WORKOUT ----------
let workoutViewDate = null; // null = today

function workoutCurrentDate() {
  return workoutViewDate || todayISO();
}

function shiftWorkoutDate(delta) {
  const base = workoutCurrentDate();
  const [y, m, d] = base.split('-').map(Number);
  const date = new Date(y, m - 1, d + delta);
  const shifted = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
  workoutViewDate = shifted === todayISO() ? null : shifted;
  renderWorkout();
}


function loadWorkoutPlan() {
  const date = workoutCurrentDate();
  const planKey = getPlanKeyForDate(date);
  if (!planKey) return;
  startWorkout(planKey);
}

function startWorkout(dayKey) {
  const date = workoutCurrentDate();
  // Fallback to 'custom' if the requested key isn't in PLAN
  const safeKey = PLAN[dayKey] ? dayKey : 'custom';
  currentDay = safeKey;
  state.current = {
    day: safeKey,
    date,
    cardio: PLAN[safeKey].cardio,
    // Empty — user picks exercises from the daily plan chips, or adds custom
    entries: []
  };
  save();
  renderWorkout();
}

// --- Workout timer ---
let _timerInterval = null;

function startWorkoutTimer() {
  if (!state.current) return;
  state.current.startedAt = new Date().toISOString();
  // Auto-fill session time with start time if not already set
  if (!state.current.time) {
    const now = new Date();
    state.current.time = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  }
  save();
  renderWorkout();
}

function finishWorkoutTimer() {
  if (!state.current || !state.current.startedAt) return;
  state.current.endedAt = new Date().toISOString();
  const ms = new Date(state.current.endedAt) - new Date(state.current.startedAt);
  state.current.durationMin = Math.max(1, Math.round(ms / 60000));
  save();
  renderWorkout();
  // Open attach-to picker so user can apply the duration to a specific item
  openTimerAttachPicker(state.current.durationMin);
}

function openTimerAttachPicker(minutes) {
  if (!state.current) return;
  const cardios = state.current.cardioActivities || [];
  const entries = state.current.entries || [];
  if (cardios.length === 0 && entries.length === 0) return; // nothing to attach to
  document.getElementById('timerAttachDurLabel').textContent = minutes + ' min';
  const items = [];
  cardios.forEach((a, i) => {
    const def = CARDIO_TYPES.find(c => c.key === a.type) || CARDIO_TYPES[CARDIO_TYPES.length - 1];
    const existing = a.duration ? ` <span class="muted small">(already: ${escapeHtml(a.duration)})</span>` : '';
    items.push(`<button class="card" style="display:block; width:100%; padding: 10px 12px; margin-bottom: 6px; background: var(--panel); border: none; text-align: left; cursor: pointer;" onclick="attachTimerTo('cardio', ${i}, ${minutes})">${def.icon} ${def.label}${existing}</button>`);
  });
  entries.forEach((e, i) => {
    if (!e.sets || e.sets.length === 0) return; // skip empty exercises
    items.push(`<button class="card" style="display:block; width:100%; padding: 10px 12px; margin-bottom: 6px; background: var(--panel); border: none; text-align: left; cursor: pointer;" onclick="attachTimerTo('exercise', ${i}, ${minutes})">💪 ${escapeHtml(e.name)} <span class="muted small">(${e.sets.length} set${e.sets.length>1?'s':''})</span></button>`);
  });
  document.getElementById('timerAttachList').innerHTML = items.join('') || '<div class="empty">No activities to attach to.</div>';
  document.getElementById('timerAttachModal').classList.add('show');
}

function closeTimerAttach() {
  document.getElementById('timerAttachModal').classList.remove('show');
}

function attachTimerTo(kind, idx, minutes) {
  if (!state.current) return;
  if (kind === 'cardio') {
    const a = state.current.cardioActivities?.[idx];
    if (a) a.duration = minutes + ' min';
  } else if (kind === 'exercise') {
    const e = state.current.entries?.[idx];
    if (e) e.durationMin = minutes;
  }
  save();
  closeTimerAttach();
  renderWorkout();
  toast('Duration attached ✓');
}

function resetWorkoutTimer() {
  if (!state.current) return;
  if (!confirm('Reset the timer? You can start it again.')) return;
  delete state.current.startedAt;
  delete state.current.endedAt;
  delete state.current.durationMin;
  save();
  renderWorkout();
}

function tickTimer() {
  const el = document.getElementById('timerElapsed');
  if (!el || !state.current?.startedAt || state.current?.endedAt) {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    return;
  }
  const ms = Date.now() - new Date(state.current.startedAt).getTime();
  const totalMin = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    el.textContent = `${h}h ${m}m`;
  } else {
    el.textContent = `${totalMin}:${String(sec).padStart(2,'0')}`;
  }
}


function selectDay(day) {
  // selectDay is also called at startup with a default day. Don't auto-create
  // a phantom session — only set up state.current if explicitly starting a
  // session AND the day exists in PLAN.
  const safeKey = PLAN[day] ? day : 'custom';
  currentDay = safeKey;
  document.querySelectorAll('[data-day]').forEach(c => c.classList.toggle('on', c.dataset.day === safeKey));
  if (!state.current && PLAN[safeKey]) {
    // Don't auto-create — let the user tap Add workout / Load plan
  } else if (state.current && state.current.day !== safeKey && PLAN[safeKey]) {
    // User explicitly switched day — sync
    state.current = {
      day: safeKey,
      date: workoutCurrentDate(),
      cardio: PLAN[safeKey].cardio,
      entries: []
    };
  }
  renderWorkout();
}

function formatWorkoutDateLabel(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = todayISO();
  const ydaY = (() => { const t = new Date(); t.setDate(t.getDate()-1); return [t.getFullYear(), String(t.getMonth()+1).padStart(2,'0'), String(t.getDate()).padStart(2,'0')].join('-'); })();
  if (dateISO === today) return 'Today, ' + date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (dateISO === ydaY) return 'Yesterday, ' + date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}




function renderWorkout() {
  const viewDate = workoutCurrentDate();
  const dateLabel = document.getElementById('workoutDateLabel');
  if (dateLabel) dateLabel.textContent = formatWorkoutDateLabel(viewDate);
  const nextBtn = document.getElementById('workoutNextBtn');
  if (nextBtn) nextBtn.style.visibility = viewDate >= todayISO() ? 'hidden' : 'visible';

  // Populate steps slot for the viewed date
  const stepsRec = (state.steps || []).find(s => s.date === viewDate);
  const stepsVal = document.getElementById('workoutStepsValue');
  const stepsProg = document.getElementById('workoutStepsProgress');
  const stepsInput = document.getElementById('workoutStepsInput');
  if (stepsVal) stepsVal.textContent = stepsRec ? stepsRec.count.toLocaleString() : '—';
  if (stepsProg) {
    if (stepsRec) {
      const pct = Math.round((stepsRec.count / STEPS_GOAL) * 100);
      const hit = stepsRec.count >= STEPS_GOAL;
      stepsProg.innerHTML = `<span style="color: ${hit ? 'var(--accent2)' : 'var(--muted)'};">${pct}% of ${STEPS_GOAL.toLocaleString()}${hit ? ' ✓' : ''}</span>`;
    } else {
      stepsProg.innerHTML = '<span class="muted">Not logged yet</span>';
    }
  }
  if (stepsInput) stepsInput.value = stepsRec ? stepsRec.count : '';

  const banner = document.getElementById('workoutPlanBanner');
  const empty = document.getElementById('workoutEmptyState');
  const list = document.getElementById('exerciseList');
  const metaRow = document.getElementById('sessionMetaRow');
  const headerRow = document.getElementById('sessionHeaderRow');
  const title = document.getElementById('workoutTitle');
  const cancelBtn = document.getElementById('workoutCancelBtn');
  const saveRow = document.getElementById('saveRow');

  const hasCurrentForViewDate = state.current && state.current.date === viewDate;

  if (!hasCurrentForViewDate) {
    // No active session for this date — show banner if planned, else empty state
    if (banner) banner.style.display = 'none';
    if (empty) empty.style.display = 'none';
    if (metaRow) metaRow.style.display = 'none';
    if (headerRow) headerRow.style.display = 'none';
    if (saveRow) saveRow.style.display = 'none';
    const timerCard = document.getElementById('sessionTimerCard');
    if (timerCard) timerCard.style.display = 'none';
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (list) list.innerHTML = '';
    // Hide cardio section when no session
    const cardioList = document.getElementById('cardioList');
    const addCardioBtn = document.getElementById('addCardioBtn');
    if (cardioList) cardioList.innerHTML = '';
    if (addCardioBtn) addCardioBtn.style.display = 'none';

    // If a session was already saved for this date, don't show the plan banner
    // or empty state — just history. User can tap "+ Add another workout" to add more.
    const alreadyLogged = (state.sessions || []).some(s => s.date === viewDate);
    const planKey = getPlanKeyForDate(viewDate);
    let addAnotherBtn = document.getElementById('addAnotherWorkoutBtn');
    if (alreadyLogged) {
      if (!addAnotherBtn) {
        addAnotherBtn = document.createElement('button');
        addAnotherBtn.id = 'addAnotherWorkoutBtn';
        addAnotherBtn.className = 'ghost';
        addAnotherBtn.style.cssText = 'width: 100%; margin-top: 8px; border-style: dashed; padding: 10px;';
        addAnotherBtn.textContent = '+ Add another workout';
        list.parentNode.insertBefore(addAnotherBtn, list);
      }
      addAnotherBtn.onclick = () => {
        if (planKey) loadWorkoutPlan();
        else startWorkout('custom');
      };
      addAnotherBtn.style.display = 'block';
    } else {
      if (addAnotherBtn) addAnotherBtn.style.display = 'none';
      if (planKey && PLAN[planKey] && banner) {
        document.getElementById('workoutPlanLabel').textContent = PLAN[planKey].label;
        banner.style.display = 'block';
      } else if (empty) {
        empty.style.display = 'block';
      }
    }
    renderHistory();
    return;
  }
  // Active session — hide the "add another" button
  const addAnotherBtnActive = document.getElementById('addAnotherWorkoutBtn');
  if (addAnotherBtnActive) addAnotherBtnActive.style.display = 'none';

  // Active session exists for this date
  if (banner) banner.style.display = 'none';
  if (empty) empty.style.display = 'none';
  // Show date/time as soon as there's any content (exercise OR cardio activity)
  const hasContent = (state.current.entries || []).length > 0
                  || (state.current.cardioActivities || []).length > 0;
  if (metaRow) metaRow.style.display = hasContent ? 'flex' : 'none';
  if (headerRow) headerRow.style.display = 'flex';
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';

  // Timer card
  const timerCard = document.getElementById('sessionTimerCard');
  const timerNotStarted = document.getElementById('timerNotStarted');
  const timerInProgress = document.getElementById('timerInProgress');
  const timerFinished = document.getElementById('timerFinished');
  if (timerCard) {
    timerCard.style.display = 'block';
    timerNotStarted.style.display = !state.current.startedAt ? 'block' : 'none';
    timerInProgress.style.display = (state.current.startedAt && !state.current.endedAt) ? 'block' : 'none';
    timerFinished.style.display = state.current.endedAt ? 'block' : 'none';
    if (state.current.startedAt) {
      const startDt = new Date(state.current.startedAt);
      document.getElementById('timerStartLabel').textContent = 'started ' + String(startDt.getHours()).padStart(2,'0') + ':' + String(startDt.getMinutes()).padStart(2,'0');
    }
    if (state.current.endedAt) {
      const mins = state.current.durationMin || Math.max(1, Math.round((new Date(state.current.endedAt) - new Date(state.current.startedAt)) / 60000));
      document.getElementById('timerFinishedLabel').textContent = mins >= 60 ? `${Math.floor(mins/60)}h ${mins%60}m` : `${mins} min`;
    }
    // Live tick
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (state.current.startedAt && !state.current.endedAt) {
      tickTimer();
      _timerInterval = setInterval(tickTimer, 1000);
    }
  }

  const editing = !!state.current?._editingId;
  if (title) {
    if (state.current.day === 'custom' && !editing) {
      title.style.display = 'none';
    } else {
      title.style.display = '';
      title.textContent = (editing ? 'Editing — ' : '') + PLAN[state.current.day].label;
    }
  }
  const timeInput = document.getElementById('sessionTime');
  if (timeInput && state.current) timeInput.value = state.current.time || '';
  const dateInput = document.getElementById('sessionDate');
  if (dateInput && state.current) dateInput.value = state.current.date || todayISO();
  if (saveRow) saveRow.style.display = (editing || !isCurrentFresh(state.current)) ? 'flex' : 'none';
  list.innerHTML = '';
  currentDay = state.current.day; // sync

  if (PLAN[currentDay].cardio && !state.current.cardioRemoved) {
    const c = document.createElement('div');
    c.className = 'ex';
    c.innerHTML = `
      <div class="row between">
        <div class="grow">
          <div class="name">Cardio</div>
          <div class="target">${PLAN[currentDay].cardio}</div>
        </div>
        <button class="icon ghost" onclick="removeCardio()" aria-label="Remove cardio">✕</button>
      </div>
      <div class="row" style="margin-top: 10px; gap: 6px; align-items: stretch;">
        <textarea id="cardioNote" placeholder="${escapeHtml(PLAN[currentDay].cardioPlaceholder || 'Distance / time / notes')}" rows="1" enterkeyhint="enter" oninput="autoResizeTA(this)" style="flex: 1; resize: none; overflow-y: auto; max-height: 140px; min-height: 36px; line-height: 1.4;">${escapeHtml(state.current?.cardioNote || '')}</textarea>
        <button class="ghost" onclick="syncGoogleFit()" title="Auto-fill distance from Google Fit" style="padding: 6px 10px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.1; min-width: 56px;">
          <span style="font-size: 16px;">🏃</span>
          <span style="font-size: 10px; color: var(--accent); font-weight: 600;">Sync Fit</span>
        </button>
      </div>
    `;
    list.appendChild(c);
    setTimeout(() => {
      const inp = document.getElementById('cardioNote');
      if (inp) inp.addEventListener('input', e => {
        state.current.cardioNote = e.target.value;
        save();
        const sr = document.getElementById('saveRow');
        if (sr) sr.style.display = isCurrentFresh(state.current) ? 'none' : 'flex';
      });
    }, 0);
  }

  // Daily plan chip menu — items not yet added to entries
  const planExercises = (PLAN[state.current.day]?.exercises || []);
  const pickedNames = new Set(state.current.entries.map(e => e.name.toLowerCase()));
  const remainingPlan = planExercises.filter(name => !pickedNames.has(name.toLowerCase()));
  if (remainingPlan.length > 0) {
    const planMenu = document.createElement('div');
    planMenu.style.cssText = 'margin: 8px 0; padding: 10px 12px; background: var(--panel2); border-radius: 10px;';
    planMenu.innerHTML = `<div class="muted small" style="margin-bottom: 8px; font-weight: 500;">Today's plan — tap to add</div>
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">
        ${remainingPlan.map(name => `<button class="chip" onclick="addPlanExercise('${name.replace(/'/g, "\\'")}')" style="padding: 6px 12px; border-radius: 999px; background: var(--bg); border: 1px solid var(--line); cursor: pointer; font-size: 13px;">+ ${escapeHtml(name)}</button>`).join('')}
      </div>`;
    list.appendChild(planMenu);
  }

  state.current.entries.forEach((e, idx) => {
    const last = getPrevSets(e.name);
    const isTime = /plank|hold|sec|hang/i.test(e.name);
    const ex = document.createElement('div');
    ex.className = 'ex';
    ex.innerHTML = `
      <div class="row between">
        <div class="grow">
          <div class="name">${escapeHtml(e.name)}</div>
          <div class="target">${last ? 'Last: ' + last.join(' · ') : (isTime ? 'New — log seconds held per set' : 'New — log reps per set, pick a count you can finish with good form')}</div>
        </div>
        <button class="icon ghost" onclick="removeExercise(${idx})" aria-label="Remove">✕</button>
        <button class="icon" onclick="openSet(${idx})">+</button>
      </div>
      <div class="sets">
        ${e.sets.length === 0 ? '<span class="set-pill empty">No sets yet</span>' : e.sets.map((s, si) => `<span class="set-pill" onclick="removeSet(${idx},${si})">${s.reps}</span>`).join('')}
      </div>
      <textarea placeholder="Notes (weight, form, RPE…)" rows="1" enterkeyhint="enter" oninput="updateExerciseNote(${idx}, this.value); autoResizeTA(this)" style="margin-top: 8px; background: var(--panel2); font-size: 13px; padding: 8px 10px; resize: none; overflow-y: auto; max-height: 140px; min-height: 36px; line-height: 1.4;">${escapeHtml(e.note || '')}</textarea>
    `;
    list.appendChild(ex);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'ghost';
  addBtn.style.cssText = 'width:100%; margin-top: 4px; border-style: dashed;';
  addBtn.textContent = '+ Add exercise';
  addBtn.onclick = addCustomExercise;
  list.appendChild(addBtn);

  renderCardioActivities();
  renderHistory();
}

// Thin wrapper so existing call sites don't need to pass state.sessions.
function getPrevSets(name) { return getPrevSetsInSessions(state.sessions, name); }

function openSet(exerciseIdx) {
  currentSetCtx = { exerciseIdx };
  const last = state.current.entries[exerciseIdx].sets.slice(-1)[0];
  currentReps = last ? last.reps : (getPrevSets(state.current.entries[exerciseIdx].name)?.[0] || 8);
  document.getElementById('setRepsVal').textContent = currentReps;
  document.getElementById('setModalTitle').textContent = state.current.entries[exerciseIdx].name;
  document.getElementById('setModal').classList.add('show');
}
function closeSet() { document.getElementById('setModal').classList.remove('show'); currentSetCtx = null; }
function bumpReps(d) {
  currentReps = Math.max(0, currentReps + d);
  document.getElementById('setRepsVal').textContent = currentReps;
}
function confirmSet() {
  if (!currentSetCtx) return;
  state.current.entries[currentSetCtx.exerciseIdx].sets.push({ reps: currentReps });
  save();
  closeSet();
  renderWorkout();
}
function removeSet(exIdx, setIdx) {
  if (!confirm('Remove this set?')) return;
  state.current.entries[exIdx].sets.splice(setIdx, 1);
  save();
  renderWorkout();
}

function removeExercise(idx) {
  const name = state.current.entries[idx].name;
  if (!confirm(`Remove "${name}" from this session?`)) return;
  state.current.entries.splice(idx, 1);
  save();
  renderWorkout();
}

function updateExerciseNote(idx, value) {
  if (!state.current || !state.current.entries[idx]) return;
  state.current.entries[idx].note = value;
  save();
}


function removeCardio() {
  if (!state.current) return;
  if (state.current.cardioNote && !confirm('Remove cardio from this session? Your note will be lost.')) return;
  state.current.cardioRemoved = true;
  state.current.cardioNote = '';
  save();
  renderWorkout();
}

// ─── Muscle Heatmap ──────────────────────────────────────────────────────────
// Map exercise name → muscles it works, with weights (1.0 = primary, 0.3 = light)



// ─── Cardio activity types ─────────────────────────────────────────────────

function openCardioPicker() {
  const list = document.getElementById('cardioPickerList');
  list.innerHTML = CARDIO_TYPES.map(c => `
    <button class="card" style="display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px; margin-bottom: 6px; border: none; background: var(--panel); cursor: pointer; text-align: left;" onclick="addCardioActivity('${c.key}')">
      <span style="font-size: 22px;">${c.icon}</span>
      <span style="font-weight: 600;">${c.label}</span>
    </button>
  `).join('');
  document.getElementById('cardioPickerModal').classList.add('show');
}

function closeCardioPicker() {
  document.getElementById('cardioPickerModal').classList.remove('show');
}

function addCardioActivity(typeKey) {
  if (!state.current) {
    // No active session — create one (custom workout)
    startWorkout('custom');
  }
  state.current.cardioActivities = state.current.cardioActivities || [];
  state.current.cardioActivities.push({ type: typeKey, distance: '', duration: '', notes: '' });
  save();
  closeCardioPicker();
  renderWorkout();
}

function removeCardioActivity(idx) {
  if (!state.current) return;
  if (!confirm('Remove this cardio activity?')) return;
  state.current.cardioActivities.splice(idx, 1);
  save();
  renderWorkout();
}

function updateCardioField(idx, field, value) {
  if (!state.current || !state.current.cardioActivities?.[idx]) return;
  state.current.cardioActivities[idx][field] = value;
  save();
}


function renderCardioActivities() {
  const list = document.getElementById('cardioList');
  const btn = document.getElementById('addCardioBtn');
  if (!list) return;
  if (!state.current) {
    list.innerHTML = '';
    if (btn) btn.style.display = 'none';
    return;
  }
  if (btn) btn.style.display = 'block';
  const activities = state.current.cardioActivities || [];
  list.innerHTML = activities.map((a, i) => {
    const def = CARDIO_TYPES.find(c => c.key === a.type) || CARDIO_TYPES[CARDIO_TYPES.length - 1];
    return `
      <div class="ex" style="position: relative; padding: 12px 14px;">
        <div class="row between">
          <div class="grow"><b>${def.icon} ${def.label}</b></div>
          <button class="icon ghost" onclick="removeCardioActivity(${i})" aria-label="Remove">✕</button>
        </div>
        <div class="row" style="gap: 8px; margin-top: 8px; flex-wrap: wrap;">
          ${def.showDist ? `<div style="flex: 1; min-width: 100px;"><label class="muted small">Distance</label><input type="text" placeholder="e.g. 8 km" value="${escapeHtml(a.distance || '')}" oninput="updateCardioField(${i}, 'distance', this.value)"></div>` : ''}
          ${def.showDur ? `<div style="flex: 1; min-width: 100px;"><label class="muted small">Duration</label><input type="text" placeholder="e.g. 45 min" value="${escapeHtml(a.duration || '')}" oninput="updateCardioField(${i}, 'duration', this.value)"></div>` : ''}
        </div>
        <div style="margin-top: 8px;">
          <label class="muted small">Notes</label>
          <textarea placeholder="pace, RPE, terrain…" rows="1" enterkeyhint="enter" oninput="updateCardioField(${i}, 'notes', this.value); autoResizeTA(this)" style="resize: none; overflow-y: auto; max-height: 140px; min-height: 36px; line-height: 1.4;">${escapeHtml(a.notes || '')}</textarea>
        </div>
      </div>
    `;
  }).join('');
}


function getPreviouslyUsedExercises() {
  const libNames = new Set();
  for (const items of Object.values(EXERCISE_LIBRARY)) {
    for (const n of items) libNames.add(n.toLowerCase());
  }
  const customs = new Set();
  for (const s of state.sessions || []) {
    for (const e of s.entries || []) {
      if (e.name && !libNames.has(e.name.toLowerCase())) customs.add(e.name);
    }
  }
  return [...customs].sort((a, b) => a.localeCompare(b));
}

function renderExerciseList(filter = '') {
  const body = document.getElementById('exerciseListBody');
  const existing = new Set(state.current.entries.map(e => e.name.toLowerCase()));
  const f = filter.trim().toLowerCase();

  const sections = {};
  const previouslyUsed = getPreviouslyUsedExercises();
  if (previouslyUsed.length) sections['Previously used'] = previouslyUsed;
  Object.assign(sections, EXERCISE_LIBRARY);

  let html = '';
  let total = 0;
  for (const [cat, items] of Object.entries(sections)) {
    const filtered = f ? items.filter(n => n.toLowerCase().includes(f)) : items;
    if (filtered.length === 0) continue;
    total += filtered.length;
    html += `<div style="margin-bottom: 10px;">
      <div class="muted small" style="text-transform: uppercase; letter-spacing: 0.6px; margin: 8px 4px 6px;">${cat}</div>
      ${filtered.map(name => {
        const taken = existing.has(name.toLowerCase());
        const safe = name.replace(/'/g, "\\'");
        return `<button class="${taken ? 'ghost' : ''}" style="width:100%; text-align:left; margin-bottom:4px; ${taken ? 'opacity: 0.5;' : ''}" ${taken ? 'disabled' : ''} onclick="pickExercise('${safe}')">${name}${taken ? ' · added' : ''}</button>`;
      }).join('')}
    </div>`;
  }
  if (total === 0) html = `<div class="empty">No matches. Use "+ Custom name…" below to add it.</div>`;
  body.innerHTML = html;
}

function addPlanExercise(name) {
  if (!state.current) return;
  state.current.entries.push({ name, sets: [] });
  save();
  renderWorkout();
}

function addCustomExercise() {
  const search = document.getElementById('exerciseSearch');
  if (search) search.value = '';
  renderExerciseList();
  document.getElementById('exerciseModal').classList.add('show');
  setTimeout(() => { if (search) search.focus(); }, 100);
}
function closeExercisePicker() { document.getElementById('exerciseModal').classList.remove('show'); }
function pickExercise(name) {
  state.current.entries.push({ name, sets: [] });
  save();
  closeExercisePicker();
  renderWorkout();
}
function addCustomExerciseText() {
  closeExercisePicker();
  const name = prompt('Exercise name');
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (state.current.entries.some(e => e.name.toLowerCase() === trimmed.toLowerCase())) {
    return toast('Already added');
  }
  state.current.entries.push({ name: trimmed, sets: [] });
  save();
  renderWorkout();
}

function finishSession() {
  if (!state.current) return toast('Nothing to save');
  const hasAny = state.current.entries.some(e => e.sets.length) || state.current.cardioNote || (state.current.cardioActivities || []).length > 0;
  if (!hasAny) return toast('Log at least one set');
  let savedAt;
  if (state.current._editingId) {
    const idx = state.sessions.findIndex(s => s.savedAt === state.current._editingId);
    if (idx >= 0) {
      const editingId = state.current._editingId;
      const previous = state.sessions[idx];
      const updated = { ...state.current, savedAt: editingId };
      delete updated._editingId;
      // Preserve previous burn estimate / chat / breakdown — user may have refined them
      if (previous.caloriesBurned != null) updated.caloriesBurned = previous.caloriesBurned;
      if (previous.burnBreakdown) updated.burnBreakdown = previous.burnBreakdown;
      if (previous.burnNotes) updated.burnNotes = previous.burnNotes;
      if (previous.chatHistory) updated.chatHistory = previous.chatHistory;
      state.sessions[idx] = updated;
      savedAt = editingId;
    }
    state.current = null;
    save();
    renderWorkout();
    toast('Updated ✓');
  } else {
    savedAt = Date.now();
    const savedSession = { ...state.current, savedAt };
    state.sessions.push(savedSession);
    state.current = null;
    save();
    selectDay(currentDay);
    toast('Saved ✓');
    // Show muscle heatmap if there's at least one logged set
    if ((savedSession.entries || []).some(e => e.sets && e.sets.length > 0)) {
      setTimeout(() => openHeatmap(savedSession), 500);
    }
  }
  // Only auto-analyze if no estimate exists yet
  if (getGeminiKey() && savedAt) {
    const s = state.sessions.find(x => x.savedAt === savedAt);
    if (s && s.caloriesBurned == null) setTimeout(async () => { const ok = await autoAnalyzeSession(savedAt); if (ok) renderHistory(); }, 800);
  }
}
function cancelSession() {
  if (!state.current) return;
  const wasEditing = !!state.current._editingId;
  const isFresh = isCurrentFresh(state.current);
  if (!isFresh) {
    const msg = wasEditing
      ? 'Discard your edits? The original saved session is unchanged.'
      : 'Cancel this session? Logged sets will be lost.';
    if (!confirm(msg)) return;
  }
  state.current = null;
  save();
  renderWorkout();
  if (wasEditing) toast('Edits discarded');
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (!state.sessions.length) { list.innerHTML = '<div class="empty">No sessions yet.</div>'; return; }

  // Group sessions by date
  const byDate = {};
  for (const s of state.sessions) {
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  }
  const dates = Object.keys(byDate).sort().reverse().slice(0, 14);

  const formatDayLabel = iso => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: 'long' }) + ' — ' + dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const renderSession = s => {
    const cardio = s.cardioNote ? escapeHtml(s.cardioNote) : '';
    const cardioActivitiesHtml = (s.cardioActivities || []).map(a => {
      const def = CARDIO_TYPES.find(c => c.key === a.type) || CARDIO_TYPES[CARDIO_TYPES.length - 1];
      const parts = [];
      if (a.distance) parts.push(escapeHtml(a.distance));
      if (a.duration) parts.push(escapeHtml(a.duration));
      if (a.notes) parts.push('<i>' + escapeHtml(a.notes) + '</i>');
      return `<div class="small" style="margin-top: 4px;"><b>${def.icon} ${def.label}</b>${parts.length ? ' — ' + parts.join(' · ') : ''}</div>`;
    }).join('');
    const notes = s.notes ? escapeHtml(s.notes) : '';
    const burnQs = s.burnQuestions || [];
    const timeHtml = s.time
      ? `<span class="muted small" style="margin-left: 6px; font-weight: 500;">· ${s.time}</span>`
      : `<button class="ghost" style="margin-left: 4px; padding: 2px 8px; font-size: 12px; color: var(--accent);" onclick="setSessionTime(${s.savedAt})">+ Add time</button>`;
    const durationHtml = s.durationMin
      ? `<span class="muted small" style="margin-left: 6px; font-weight: 500;">· ${s.durationMin} min</span>`
      : '';
    const burnHtml = typeof s.caloriesBurned === 'number'
      ? `<span class="muted small" style="margin-left: 6px; font-weight: 500;">· ~${s.caloriesBurned} kcal</span>`
      : '';
    return `
      <div data-saved-at="${s.savedAt}" style="padding: 12px 0; border-top: 1px solid var(--line);">
        <div style="font-weight: 600;">${PLAN[s.day]?.label || s.day}${timeHtml}${durationHtml}${burnHtml}</div>
        ${cardio ? `<div class="small" style="margin-top: 4px; color: var(--muted);">${cardio}</div>` : ''}
        ${cardioActivitiesHtml}
        ${s.entries.filter(e => e.sets.length).map(e => `
          <div class="small" style="margin-top: 4px;"><b>${escapeHtml(e.name)}</b>: ${e.sets.map(x=>x.reps).join(' · ')}${e.durationMin ? ` <span class="muted">· ${e.durationMin} min</span>` : ''}${e.note ? ` <span class="muted" style="font-style: italic;">— ${escapeHtml(e.note)}</span>` : ''}</div>
        `).join('')}
        ${s.entries.some(e => e.sets.length) ? `<details style="margin-top: 10px;"><summary class="muted small" style="cursor: pointer;">▸ Muscle heatmap</summary>${renderMuscleHeatmapSvg(s)}</details>` : ''}
        ${s.burnBreakdown && s.burnBreakdown.length ? `<div style="margin-top: 8px; padding: 10px 12px; background: var(--bg); border-radius: 10px;">
          <div class="muted small" style="margin-bottom: 4px; font-weight: 500;">Burn breakdown</div>
          ${s.burnBreakdown.map(b => `<div class="small" style="margin-top: 4px;"><b>${escapeHtml(b.activity)}</b>: ${b.calories} kcal <span class="muted">— ${escapeHtml(b.reasoning || '')}</span></div>`).join('')}
          ${s.burnNotes ? `<div class="small muted" style="margin-top: 6px; font-style: italic;">${escapeHtml(s.burnNotes)}</div>` : ''}
        </div>` : ''}
        ${burnQs.length ? `<div class="small" style="margin-top: 6px; color: var(--warn);">❓ ${burnQs.length} question${burnQs.length > 1 ? 's' : ''}: ${burnQs.map(escapeHtml).join(' · ')}</div>` : ''}
        ${notes ? `<div style="margin-top: 8px; padding: 8px 10px; background: var(--bg); border-radius: 8px; border-left: 3px solid var(--accent);"><div class="muted small">Notes / Analysis</div><div style="white-space: pre-wrap;">${notes}</div></div>` : ''}
        <div class="row" style="margin-top: 10px; gap: 6px; flex-wrap: wrap;">
          <button class="ghost" style="padding: 4px 10px; font-size: 13px;" onclick="editSession(${s.savedAt})">Edit</button>
          <button class="ghost" style="padding: 4px 10px; font-size: 13px;" onclick="openSessionRefine(${s.savedAt})">💬 Chat</button>
          <button class="ghost danger" style="padding: 4px 10px; font-size: 13px;" onclick="deleteSession(${s.savedAt})">Delete</button>
        </div>
      </div>
    `;
  };

  list.innerHTML = dates.map(date => {
    const sessions = byDate[date].slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const dayLabel = formatDayLabel(date);
    const totalBurn = sessions.reduce((sum, s) => sum + (s.caloriesBurned || 0), 0);
    const summaryRight = totalBurn > 0
      ? `<span style="color: var(--accent); font-weight: 600;">${totalBurn} kcal</span>`
      : '';
    return `
      <details style="margin-top: 8px;">
        <summary class="muted small" style="margin-bottom: 8px; font-weight: 500; display: flex; justify-content: space-between; align-items: baseline; cursor: pointer; list-style: none;">
          <span>▸ ${dayLabel}</span>${summaryRight}
        </summary>
        <div style="margin-top: 6px;">
          ${sessions.map(renderSession).join('')}
        </div>
      </details>
    `;
  }).join('');
}


function editSession(savedAt) {
  const s = state.sessions.find(x => x.savedAt === savedAt);
  if (!s) return;
  if (state.current && state.current.entries.some(e => e.sets.length)) {
    if (!confirm('You have unsaved sets in the current session. Discard them and edit this past session?')) return;
  }
  state.current = JSON.parse(JSON.stringify(s));
  state.current._editingId = savedAt;
  currentDay = state.current.day;
  document.querySelectorAll('[data-day]').forEach(c => c.classList.toggle('on', c.dataset.day === currentDay));
  renderWorkout();
  toast('Editing past session');
  switchTab('workout');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setSessionTime(savedAt) {
  const s = state.sessions.find(x => x.savedAt === savedAt);
  if (!s) return;
  const newTime = prompt('Enter time (HH:MM, 24h):', s.time || '');
  if (!newTime) return;
  if (!/^\d{1,2}:\d{2}$/.test(newTime.trim())) return toast('Invalid time format');
  s.time = newTime.trim();
  save();
  renderHistory();
}

function deleteSession(savedAt) {
  if (!confirm('Delete this session permanently?')) return;
  state.sessions = state.sessions.filter(s => s.savedAt !== savedAt);
  save();
  renderHistory();
  toast('Session deleted');
}

// ---------- BODY / WAIST ----------
function renderBody() {
  renderCompareHistory();
  document.getElementById('waistDate').value = todayISO();
  const ms = state.measurements.slice().sort((a,b) => a.date.localeCompare(b.date));
  const last = ms[ms.length - 1];
  const first = ms[0];
  document.getElementById('waistNow').textContent = last ? last.cm.toFixed(1) + ' cm' : '—';
  const dEl = document.getElementById('waistDelta');
  if (last && first && first !== last) {
    const d = last.cm - first.cm;
    dEl.textContent = (d >= 0 ? '+' : '') + d.toFixed(1) + ' cm vs start';
    dEl.className = 'delta ' + (d < 0 ? 'down' : 'up');
  } else {
    dEl.textContent = ' ';
    dEl.className = 'delta';
  }

  const goalEl = document.getElementById('waistToGoal');
  const goalDeltaEl = document.getElementById('waistGoalDelta');
  if (last) {
    const toGoal = last.cm - WAIST_GOAL;
    if (toGoal <= 0) {
      goalEl.textContent = '✓';
      goalEl.style.color = 'var(--accent2)';
      goalDeltaEl.textContent = 'Goal reached!';
      goalDeltaEl.className = 'delta down';
    } else {
      goalEl.textContent = toGoal.toFixed(1);
      goalEl.style.color = '';
      goalDeltaEl.textContent = 'cm to go';
      goalDeltaEl.className = 'delta muted';
    }
  } else {
    goalEl.textContent = '—';
    goalDeltaEl.textContent = ' ';
  }

  drawChart(document.getElementById('waistChart'), ms);
  renderSteps();
  document.getElementById('waistList').innerHTML = ms.length === 0
    ? '<div class="muted small">No measurements yet.</div>'
    : ms.slice().reverse().map((m) => `
        <div class="row between" style="padding:6px 2px; border-bottom:1px solid var(--line);">
          <span class="small">${formatDate(m.date)}</span>
          <span class="row" style="gap:6px;">
            <b style="font-variant-numeric: tabular-nums; margin-right: 4px;">${m.cm.toFixed(1)} cm</b>
            <button class="icon ghost" onclick="editWaist('${m.date}')" aria-label="Edit">✏</button>
            <button class="icon ghost" onclick="removeWaist('${m.date}')" aria-label="Remove">✕</button>
          </span>
        </div>
      `).join('');
}

// ---------- STEPS ----------
function saveWorkoutSteps() {
  const v = parseInt(document.getElementById('workoutStepsInput').value, 10);
  const d = workoutCurrentDate();
  if (isNaN(v) || v <= 0) return toast('Enter a number');
  state.steps = upsertStep(state.steps, d, v);
  save();
  renderWorkout();
  toast('Steps saved ✓');
}
function removeSteps(date) {
  if (!confirm('Remove this entry?')) return;
  state.steps = removeStep(state.steps, date);
  save();
  renderBody();
}
function editStepsEntry(date) {
  const s = state.steps.find(x => x.date === date);
  if (!s) return;
  document.getElementById('stepsInput').value = s.count;
  document.getElementById('stepsDate').value = s.date;
  document.getElementById('stepsInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('stepsInput').focus();
}

function renderSteps() {
  state.steps = state.steps || [];
  const ss = state.steps.slice().sort((a,b) => a.date.localeCompare(b.date));
  const today = todayISO();
  const dateInput = document.getElementById('stepsDate');
  if (dateInput && !dateInput.value) dateInput.value = today;

  const todayEntry = ss.find(s => s.date === today);
  const todayEl = document.getElementById('stepsTodayValue');
  const progEl = document.getElementById('stepsTodayProgress');
  if (!todayEl || !progEl) return;
  if (todayEntry) {
    todayEl.textContent = todayEntry.count.toLocaleString();
    const pct = Math.round((todayEntry.count / STEPS_GOAL) * 100);
    const hit = todayEntry.count >= STEPS_GOAL;
    progEl.innerHTML = `<span style="color: ${hit ? 'var(--accent2)' : 'var(--muted)'};">${pct}% of ${STEPS_GOAL.toLocaleString()}${hit ? ' ✓' : ''}</span>`;
  } else {
    todayEl.textContent = '—';
    progEl.innerHTML = '<span class="muted">No entry yet</span>';
  }

  const recent = ss.slice(-7);
  const avgEl = document.getElementById('stepsAvgValue');
  if (recent.length > 0) {
    const avg = Math.round(recent.reduce((sum, s) => sum + s.count, 0) / recent.length);
    avgEl.textContent = avg.toLocaleString();
  } else {
    avgEl.textContent = '—';
  }

  // Steps chart follows the Trend chart's Day/Week/Month toggle.
  // (Daily mode doesn't make sense for steps → fall back to week.)
  const days = trendMode === 'month' ? 30 : 7;
  const todayDt = new Date();
  let rangeSS = [];
  const byDate = new Map(ss.map(s => [s.date, s]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayDt); d.setDate(todayDt.getDate() - i);
    const iso = _isoDate(d);
    rangeSS.push(byDate.get(iso) || { date: iso, count: null });
  }
  // Trim leading days without data so the chart starts at first entry
  const firstIdx = rangeSS.findIndex(s => typeof s.count === 'number');
  if (firstIdx > 0) rangeSS = rangeSS.slice(firstIdx);
  drawStepsChart(document.getElementById('stepsChart'), rangeSS, STEPS_GOAL);

  const list = document.getElementById('stepsList');
  list.innerHTML = ss.length === 0
    ? '<div class="muted small">No step entries yet.</div>'
    : ss.slice().reverse().slice(0, 14).map(s => `
        <div class="row between" style="padding:6px 2px; border-bottom:1px solid var(--line);">
          <span class="small">${formatDate(s.date)}</span>
          <span class="row" style="gap: 6px;">
            <b style="font-variant-numeric: tabular-nums; margin-right: 4px; ${s.count >= STEPS_GOAL ? 'color: var(--accent2);' : ''}">${s.count.toLocaleString()}</b>
            <button class="icon ghost" onclick="editStepsEntry('${s.date}')" aria-label="Edit">✏</button>
            <button class="icon ghost" onclick="removeSteps('${s.date}')" aria-label="Remove">✕</button>
          </span>
        </div>
      `).join('');
}


function toggleStepsEdit() {
  const list = document.getElementById('stepsList');
  const btn = document.getElementById('stepsEditBtn');
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  btn.textContent = open ? '✏ Edit' : '✓ Done';
}

function toggleWaistEdit() {
  const list = document.getElementById('waistList');
  const btn = document.getElementById('waistEditBtn');
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  btn.textContent = open ? '✏ Edit' : '✓ Done';
}

function addWaist() {
  const v = parseFloat(document.getElementById('waistInput').value);
  const d = document.getElementById('waistDate').value || todayISO();
  if (isNaN(v) || v <= 0) return toast('Enter a number');
  state.measurements = upsertMeasurement(state.measurements, d, v);
  save();
  document.getElementById('waistInput').value = '';
  renderBody();
  toast('Saved ✓');
}
function removeWaist(date) {
  if (!confirm('Remove this measurement?')) return;
  state.measurements = removeMeasurement(state.measurements, date);
  save();
  renderBody();
}
function editWaist(date) {
  const m = state.measurements.find(x => x.date === date);
  if (!m) return;
  document.getElementById('waistInput').value = m.cm;
  document.getElementById('waistDate').value = m.date;
  document.getElementById('waistInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('waistInput').focus();
}


// ---------- PHOTOS ----------
let selectedForCompare = [];

async function onPhotoPicked(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  for (const file of files) {
    const blob = await downscale(file, 1280);
    await putPhoto(blob, todayISO());
  }
  e.target.value = '';
  toast(files.length > 1 ? `${files.length} photos saved ✓` : 'Photo saved ✓');
  renderPhotos();
}

function downscale(file, maxDim) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(b => b ? resolve(b) : reject(new Error('blob fail')), 'image/jpeg', 0.85);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function renderPhotos() {
  const photos = await getAllPhotos();
  const grid = document.getElementById('photoGrid');
  const empty = document.getElementById('photoEmpty');
  empty.style.display = photos.length ? 'none' : 'block';
  grid.innerHTML = '';
  for (const p of photos) {
    const url = URL.createObjectURL(p.blob);
    const cell = document.createElement('div');
    cell.className = 'photoCell';
    cell.innerHTML = `
      <img src="${url}" alt="">
      <span class="label">${formatDate(p.date)}</span>
      <span class="x" onclick="event.stopPropagation(); removePhoto(${p.id});">✕</span>
    `;
    grid.appendChild(cell);
  }
  // Default-pick the two most-distant dates with photos
  const dates = [...new Set(photos.map(p => p.date))].sort();
  const dateA = document.getElementById('compareDateA');
  const dateB = document.getElementById('compareDateB');
  if (dateA && dateB && dates.length >= 1) {
    if (!dateA.value) dateA.value = dates[0];
    if (!dateB.value) dateB.value = dates[dates.length - 1];
  }
  renderCompareByDate();
}

async function renderCompareByDate() {
  const dateA = document.getElementById('compareDateA')?.value;
  const dateB = document.getElementById('compareDateB')?.value;
  const grid = document.getElementById('compareGrid');
  const hint = document.getElementById('compareHint');
  const btn = document.getElementById('compareAnalyzeBtn');
  if (!grid) return;
  if (!dateA || !dateB) {
    grid.style.display = 'none';
    hint.style.display = 'block';
    hint.textContent = 'Pick two dates to load all photos from each.';
    if (btn) btn.style.display = 'none';
    return;
  }
  const photos = await getAllPhotos();
  const a = photos.filter(p => p.date === dateA);
  const b = photos.filter(p => p.date === dateB);
  if (a.length === 0 && b.length === 0) {
    grid.style.display = 'none';
    hint.style.display = 'block';
    hint.textContent = 'No photos on those dates.';
    if (btn) btn.style.display = 'none';
    return;
  }
  hint.style.display = 'none';
  grid.style.display = 'block';
  const block = (label, list) => `
    <div style="margin-top: 8px;">
      <div class="muted small" style="margin-bottom: 4px;">${label} · ${list.length} photo${list.length !== 1 ? 's' : ''}</div>
      <div class="photoGrid">${list.map(p => `
        <div class="photoCell">
          <img src="${URL.createObjectURL(p.blob)}">
          <span class="x" onclick="event.stopPropagation(); removePhoto(${p.id});">✕</span>
        </div>
      `).join('') || '<div class="muted small">(no photos)</div>'}</div>
    </div>`;
  grid.innerHTML = block(formatDate(dateA), a) + block(formatDate(dateB), b);
  if (btn) btn.style.display = (a.length && b.length && getGeminiKey()) ? 'block' : 'none';
}

async function analyzePhotoComparison() {
  const dateA = document.getElementById('compareDateA')?.value;
  const dateB = document.getElementById('compareDateB')?.value;
  if (!dateA || !dateB) return;
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const photos = await getAllPhotos();
  let a = photos.filter(p => p.date === dateA);
  let b = photos.filter(p => p.date === dateB);
  if (a.length === 0 || b.length === 0) return toast('Need at least one photo on each date');
  // Older first
  const earlierIsA = dateA <= dateB;
  const earlier = { date: earlierIsA ? dateA : dateB, photos: earlierIsA ? a : b };
  const later   = { date: earlierIsA ? dateB : dateA, photos: earlierIsA ? b : a };
  const btn = document.getElementById('compareAnalyzeBtn');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Analyzing…';
  toast('AI is comparing your photos…', { persistent: true });
  try {
    const earlierParts = await Promise.all(earlier.photos.map(p => blobToDataUrl(p.blob)));
    const laterParts = await Promise.all(later.photos.map(p => blobToDataUrl(p.blob)));
    const prompt = `You are an objective fitness analyst. Compare TWO SETS of body photos of the same person taken on different dates.

EARLIER set (${earlier.date}): ${earlier.photos.length} photo(s) — shown first.
LATER set (${later.date}): ${later.photos.length} photo(s) — shown after.

Goal: short, focused, honest comparison. The user is a 44yo male, 168cm, ~58kg, lean but low muscle. Goal: build upper body muscle + reduce waist/midsection fat.

Be HONEST. If no real change is visible, say so. If pose/lighting differ in ways that affect comparison, mention briefly in the verdict.

ONLY focus on these 3 areas:
1. **Upper body** (chest, shoulders, arms, back) — muscle size & definition
2. **Core** (abs, obliques) — definition & midsection tightness
3. **Fat / waist** — visible waistline, midsection bulk, overall leanness

Then add ONE forward-looking recommendation grounded in what you observed.

Format (PLAIN TEXT, markdown bold for headings, no bullets unless tight):
**Verdict**: one phrase — improvement / no clear change / regression — plus 1 short reason
**Upper body**: 1-2 sentences
**Core**: 1-2 sentences
**Fat / waist**: 1-2 sentences
**Recommendation**: 1 sentence — what to focus on next

Keep under 130 words total. Do NOT mention skin tone or facial features.`;
    const parts = [{ text: prompt }];
    earlierParts.forEach((d, i) => parts.push({ inline_data: { mime_type: earlier.photos[i].blob.type || 'image/jpeg', data: d.split(',')[1] } }));
    laterParts.forEach((d, i) => parts.push({ inline_data: { mime_type: later.photos[i].blob.type || 'image/jpeg', data: d.split(',')[1] } }));
    const text = await geminiGenerate({ contents: [{ parts }] });
    // Persist — newest first; only the newest is auto-expanded
    state.compareAnalyses = state.compareAnalyses || [];
    state.compareAnalyses.unshift({
      id: Date.now(),
      earlierDate: earlier.date,
      laterDate: later.date,
      earlierCount: earlier.photos.length,
      laterCount: later.photos.length,
      text,
      createdAt: new Date().toISOString()
    });
    state.compareAnalyses = state.compareAnalyses.slice(0, 50);
    save();
    renderCompareHistory();
    hideToast();
    toast('Analysis complete ✓');
  } catch (e) {
    hideToast();
    toast('Analysis failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function renderCompareHistory() {
  const list = document.getElementById('compareHistoryList');
  const title = document.getElementById('compareHistoryTitle');
  const items = (state.compareAnalyses || []);
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = '';
    if (title) title.style.display = 'none';
    return;
  }
  if (title) title.style.display = '';
  list.innerHTML = items.map((a, idx) => {
    const formatted = (a.text || '')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\n/g, '<br>');
    const created = new Date(a.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const open = idx === 0 ? 'open' : '';
    return `<details ${open} style="margin-top: 8px;">
      <summary class="muted small" style="font-weight: 500; cursor: pointer; list-style: none; padding: 8px 10px; background: var(--panel); border-radius: 10px; display: flex; justify-content: space-between; align-items: center;">
        <span>▸ ${formatDate(a.earlierDate)} → ${formatDate(a.laterDate)}</span>
        <span style="font-size: 11px;">${created}</span>
      </summary>
      <div style="padding: 12px 14px; background: var(--panel2); border-radius: 10px; margin-top: 6px; line-height: 1.5;">
        ${formatted}
        <div style="margin-top: 12px;">
          <button class="ghost" style="padding: 4px 10px; font-size: 12px; color: var(--danger);" onclick="deleteCompareAnalysis(${a.id})">Delete</button>
        </div>
      </div>
    </details>`;
  }).join('');
}

function deleteCompareAnalysis(id) {
  if (!confirm('Delete this comparison?')) return;
  state.compareAnalyses = (state.compareAnalyses || []).filter(a => a.id !== id);
  save();
  renderCompareHistory();
}

async function removePhoto(id) {
  if (!confirm('Delete this photo?')) return;
  await deletePhoto(id);
  selectedForCompare = selectedForCompare.filter(x => x !== id);
  renderPhotos();
}

// ---------- MEALS ----------
let pendingMealBlobs = [];
let editingMealId = null;

async function openMealModal(mealId = null, triggerReanalyze = false) {
  pendingMealBlobs = [];
  editingMealId = null;
  if (mealId) {
    const m = await getMeal(mealId);
    if (m) {
      editingMealId = mealId;
      pendingMealBlobs = mealBlobs(m).slice();
      document.getElementById('mealDescInput').value = m.description || '';
      autoResizeTA(document.getElementById('mealDescInput'));
      document.getElementById('mealDateInput').value = m.date || todayISO();
      document.getElementById('mealTimeInput').value = m.time || '';
      document.getElementById('mealCalInput').value = m.calories || '';
      document.getElementById('mealProteinInput').value = m.protein || '';
    }
  } else {
    document.getElementById('mealDescInput').value = '';
    autoResizeTA(document.getElementById('mealDescInput'));
    document.getElementById('mealDateInput').value = todayISO();
    const now = new Date();
    document.getElementById('mealTimeInput').value = now.toTimeString().slice(0, 5);
    document.getElementById('mealCalInput').value = '';
    document.getElementById('mealProteinInput').value = '';
  }
  document.querySelector('#mealModal h2').textContent = editingMealId ? 'Edit meal' : 'New meal';
  document.getElementById('refineSection').style.display = (editingMealId && getGeminiKey()) ? 'block' : 'none';
  document.getElementById('reanalyzeMealBtn').style.display = (editingMealId && getGeminiKey()) ? 'block' : 'none';
  // Show delta input for ANY edit on a meal that already has a breakdown (tweak existing)
  const deltaSec = document.getElementById('templateDeltaSection');
  if (deltaSec) {
    const deltaInput = document.getElementById('templateDeltaInput');
    if (deltaInput) deltaInput.value = '';
    if (editingMealId && getGeminiKey()) {
      getMeal(editingMealId).then(m => {
        const hasBreakdown = m && Array.isArray(m.breakdown) && m.breakdown.length > 0;
        deltaSec.style.display = hasBreakdown ? 'block' : 'none';
      });
    } else {
      // Hide by default; useTemplate() will reveal it for new-meal-from-template flow
      deltaSec.style.display = 'none';
    }
  }
  // Save-as-template button visible whenever editing a saved meal
  const tplBtn = document.getElementById('saveAsTemplateBtn');
  if (tplBtn) {
    if (editingMealId) {
      tplBtn.style.display = 'block';
      getMeal(editingMealId).then(m => {
        if (m && m.templateId) {
          tplBtn.textContent = '✓ Already saved as template';
          tplBtn.disabled = true;
          tplBtn.style.opacity = '0.6';
        } else {
          tplBtn.textContent = '💾 Save as template';
          tplBtn.disabled = false;
          tplBtn.style.opacity = '';
        }
      });
    } else {
      tplBtn.style.display = 'none';
    }
  }
  // Reset chat if opening a different meal, then restore from persisted history
  if (_mealChatId !== editingMealId) {
    resetMealChat();
    if (mealId && getGeminiKey()) {
      getMeal(mealId).then(m => {
        if (!m) return;
        _mealChatId = mealId;
        // Restore prior chat — strip model messages that falsely claimed to update values
        if (m.chatHistory && m.chatHistory.length) {
          const updateClaims = /\b(i('ve| have) (updated|adjusted|set|changed|saved)|it'?s (already |now )?set to|done[,.]?\s*i('ve| have))/i;
          _mealChatHistory = m.chatHistory.filter(msg =>
            msg.role !== 'model' || !updateClaims.test(msg.text)
          );
        } else if (m.questions && m.questions.length) {
          // First time opening — seed with the AI's questions
          const questionText = "I had a few things I wasn't sure about:\n\n" + m.questions.map((q, i) => `${i + 1}. ${q}`).join('\n') + '\n\nCan you clarify?';
          _mealChatHistory.push({ role: 'model', text: questionText });
        }
        if (_mealChatHistory.length) {
          renderMealRefineChat();
          document.getElementById('updateMealEstimateBtn').style.display = 'block';
        }
      });
    }
  }
  renderMealPreview();
  document.getElementById('mealModal').classList.add('show');
  if (triggerReanalyze && editingMealId) setTimeout(() => reanalyzeMeal(), 100);
}
function closeMealModal() {
  document.getElementById('mealModal').classList.remove('show');
  pendingMealBlobs = [];
  editingMealId = null;
  _pendingTemplate = null;
  const delta = document.getElementById('templateDeltaSection');
  if (delta) delta.style.display = 'none';
}

// ── Meal templates: save / pick / apply ───────────────────────────────────
async function quickSaveMealAsTemplate(mealId) {
  const meal = await getMeal(mealId);
  if (!meal) return toast('Meal not found');
  return _doSaveAsTemplate(meal);
}

async function saveCurrentMealAsTemplate() {
  if (!editingMealId) return toast('Save the meal first');
  const meal = await getMeal(editingMealId);
  if (!meal) return toast('Meal not found');
  return _doSaveAsTemplate(meal);
}

async function _doSaveAsTemplate(meal) {
  const defaultName = (meal.description || '').slice(0, 60) || 'My meal';
  const name = prompt('Template name:', defaultName);
  if (!name || !name.trim()) return;
  // Convert blobs to data URLs for portable storage
  const blobs = mealBlobs(meal);
  const dataUrls = await Promise.all(blobs.map(blobToDataUrl));
  const tpl = {
    name: name.trim(),
    description: meal.description || '',
    calories: meal.calories || null,
    protein: typeof meal.protein === 'number' ? meal.protein : null,
    breakdown: meal.breakdown || [],
    confidence: meal.confidence || null,
    aiSaw: meal.aiSaw || null,
    dataUrls,
    created: Date.now(),
    lastUsed: Date.now()
  };
  const tplId = await putTemplate(tpl);
  // Stamp the meal so the card knows it's templated
  meal.templateId = tplId;
  await putMeal(meal);
  renderMeals?.();
  toast('Template saved ✓');
}

async function openTemplatePicker() {
  const list = document.getElementById('templatePickerList');
  const templates = await getAllTemplates();
  if (templates.length === 0) {
    list.innerHTML = '<div class="empty">No saved templates yet. Save one from any meal first.</div>';
  } else {
    list.innerHTML = templates.map(t => {
      const thumb = (t.dataUrls && t.dataUrls[0]) ? `<img src="${t.dataUrls[0]}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 8px; flex-shrink: 0;">` : '<div style="width:60px; height:60px; background: var(--panel2); border-radius: 8px; flex-shrink: 0;"></div>';
      const calBadge = t.calories ? `<span style="color: var(--accent); font-weight: 600;">${t.calories} kcal</span>` : '';
      const protBadge = (typeof t.protein === 'number' && t.protein > 0) ? ` · <span style="color: var(--accent2);">${t.protein}g P</span>` : '';
      return `
        <div class="card" style="padding: 10px; margin-bottom: 8px; display: flex; gap: 10px; align-items: center;">
          ${thumb}
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600;">${escapeHtml(t.name)}</div>
            <div class="small" style="margin-top: 2px;">${calBadge}${protBadge}</div>
            ${t.description ? `<div class="small muted" style="margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(t.description)}</div>` : ''}
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <button class="primary" style="padding: 6px 10px; font-size: 13px;" onclick="useTemplate(${t.id})">Use</button>
            <button class="ghost" style="padding: 4px 10px; font-size: 12px;" onclick="openTemplateEdit(${t.id})">Edit</button>
            <button class="ghost" style="padding: 4px 10px; font-size: 12px; color: var(--danger);" onclick="confirmDeleteTemplate(${t.id})">Delete</button>
          </div>
        </div>`;
    }).join('');
  }
  document.getElementById('templatePickerModal').classList.add('show');
}

function closeTemplatePicker() {
  document.getElementById('templatePickerModal').classList.remove('show');
}

async function confirmDeleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  await deleteTemplate(id);
  openTemplatePicker();
}

async function openTemplateEdit(id) {
  const tpl = await getTemplate(id);
  if (!tpl) return toast('Template not found');
  document.getElementById('tplEditId').value = id;
  document.getElementById('tplEditName').value = tpl.name || '';
  document.getElementById('tplEditDescription').value = tpl.description || '';
  document.getElementById('tplEditCal').value = tpl.calories || '';
  document.getElementById('tplEditProtein').value = (typeof tpl.protein === 'number') ? tpl.protein : '';
  closeTemplatePicker();
  document.getElementById('templateEditModal').classList.add('show');
}

function closeTemplateEdit() {
  document.getElementById('templateEditModal').classList.remove('show');
  openTemplatePicker();
}

async function saveTemplateEdit() {
  const id = parseInt(document.getElementById('tplEditId').value, 10);
  if (!id) return;
  const tpl = await getTemplate(id);
  if (!tpl) return toast('Template not found');
  tpl.name = (document.getElementById('tplEditName').value || '').trim() || tpl.name;
  tpl.description = document.getElementById('tplEditDescription').value || '';
  const cal = parseInt(document.getElementById('tplEditCal').value, 10);
  tpl.calories = isNaN(cal) ? null : cal;
  const prot = parseInt(document.getElementById('tplEditProtein').value, 10);
  tpl.protein = isNaN(prot) ? null : prot;
  await putTemplate(tpl);
  document.getElementById('templateEditModal').classList.remove('show');
  toast('Template updated ✓');
  openTemplatePicker();
}

async function useTemplate(id) {
  const tpl = await getTemplate(id);
  if (!tpl) return toast('Template not found');
  closeTemplatePicker();
  // Ensure the meal modal is open (it may not be if the picker was opened from Meals tab)
  const mealModal = document.getElementById('mealModal');
  if (!mealModal.classList.contains('show')) {
    await openMealModal();
  }
  // Fill the meal modal fields from the template
  document.getElementById('mealDescInput').value = tpl.description || '';
  autoResizeTA(document.getElementById('mealDescInput'));
  document.getElementById('mealCalInput').value = tpl.calories || '';
  document.getElementById('mealProteinInput').value = (typeof tpl.protein === 'number') ? tpl.protein : '';
  // Restore photos as pending blobs
  if (Array.isArray(tpl.dataUrls) && tpl.dataUrls.length) {
    pendingMealBlobs = await Promise.all(tpl.dataUrls.map(async u => (await fetch(u)).blob()));
    renderMealPreview();
  }
  // Stash the template's full estimate so saveMeal can carry it forward
  _pendingTemplate = {
    calories: tpl.calories,
    protein: tpl.protein,
    breakdown: tpl.breakdown || [],
    confidence: tpl.confidence,
    aiSaw: tpl.aiSaw,
    sourceTemplateId: id
  };
  // Update lastUsed for sort order
  tpl.lastUsed = Date.now();
  await putTemplate(tpl);
  // Show the "any changes?" delta input
  document.getElementById('templateDeltaSection').style.display = 'block';
  document.getElementById('templateDeltaInput').value = '';
  toast(`Template "${tpl.name}" loaded — describe changes (if any) then Save`);
}

let _pendingTemplate = null;

function renderMealPreview() {
  const preview = document.getElementById('mealPreview');
  preview.innerHTML = pendingMealBlobs.map((blob, i) => {
    const url = URL.createObjectURL(blob);
    return `
      <div style="position: relative;">
        <img src="${url}" style="width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px;">
        <span onclick="removePendingMealPhoto(${i})" style="position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; background: rgba(0,0,0,0.7); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; cursor: pointer;">✕</span>
      </div>
    `;
  }).join('');
}

function removePendingMealPhoto(i) {
  pendingMealBlobs.splice(i, 1);
  renderMealPreview();
}

async function onMealPhotoSelected(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  for (const file of files) {
    const blob = await downscale(file, 1280);
    pendingMealBlobs.push(blob);
  }
  renderMealPreview();
  e.target.value = '';
}

async function saveMeal() {
  const desc = document.getElementById('mealDescInput').value.trim();
  if (!pendingMealBlobs.length && !desc) {
    return toast('Add a photo or a description');
  }
  let savedId;
  const mealDate = document.getElementById('mealDateInput').value || todayISO();
  const mealTime = document.getElementById('mealTimeInput').value || new Date().toTimeString().slice(0, 5);
  const manualCal = parseInt(document.getElementById('mealCalInput').value, 10) || null;
  const manualProtein = parseInt(document.getElementById('mealProteinInput').value, 10) || null;
  if (editingMealId) {
    const existing = await getMeal(editingMealId);
    if (existing) {
      // Check for delta input — if present, apply via AI to the existing breakdown
      const deltaText = (document.getElementById('templateDeltaInput')?.value || '').trim();
      const updates = {
        ...existing,
        blobs: [...pendingMealBlobs],
        description: desc,
        date: mealDate,
        time: mealTime,
      };
      if (manualCal !== null) updates.calories = manualCal;
      if (manualProtein !== null) updates.protein = manualProtein;
      if (deltaText && getGeminiKey() && Array.isArray(existing.breakdown) && existing.breakdown.length) {
        toast('Applying changes…', { persistent: true });
        try {
          const adjusted = await applyTemplateDelta({
            description: existing.description,
            calories: existing.calories,
            protein: existing.protein,
            breakdown: existing.breakdown
          }, deltaText);
          if (adjusted) {
            const items = adjusted.items || existing.breakdown;
            updates.breakdown = items;
            // Always recompute from items — the AI's stated total/totalProtein is unreliable
            const totals = recomputeMealTotals(items);
            if (totals.total != null) updates.calories = totals.total;
            if (totals.protein != null) updates.protein = totals.protein;
            updates.aiSaw = adjusted.changeNote ? `${existing.aiSaw || ''}\nChange: ${adjusted.changeNote}`.trim() : existing.aiSaw;
          }
          hideToast();
        } catch (e) {
          hideToast();
          toast('Delta failed — saving without AI adjustment');
        }
      }
      await putMeal(updates);
      savedId = existing.id;
    }
  } else {
    const record = {
      date: mealDate,
      time: mealTime,
      blobs: [...pendingMealBlobs],
      description: desc
    };
    // If user loaded a template, carry over its estimate
    if (_pendingTemplate) {
      const deltaText = (document.getElementById('templateDeltaInput')?.value || '').trim();
      let useBreakdown = _pendingTemplate.breakdown;
      let useCalories = _pendingTemplate.calories;
      let useProtein  = _pendingTemplate.protein;
      // Use a clear marker instead of the template's stale "AI saw…" text
      // (which would reference the original photos and confuse the user)
      let useAiSaw = 'From template — same breakdown as the saved template (no new analysis).';
      if (deltaText && getGeminiKey()) {
        toast('Applying changes…', { persistent: true });
        try {
          const adjusted = await applyTemplateDelta(_pendingTemplate, deltaText);
          if (adjusted) {
            useBreakdown = adjusted.items || useBreakdown;
            // Always recompute from items — the AI's stated total is unreliable
            const totals = recomputeMealTotals(useBreakdown);
            if (totals.total != null) useCalories = totals.total;
            if (totals.protein != null) useProtein = totals.protein;
            useAiSaw = adjusted.changeNote
              ? `From template with change: ${adjusted.changeNote}`
              : useAiSaw;
          }
          hideToast();
        } catch (e) {
          hideToast();
          toast('Delta failed — saving template as-is');
        }
      }
      record.calories = manualCal !== null ? manualCal : useCalories;
      record.protein  = manualProtein !== null ? manualProtein : useProtein;
      record.breakdown = useBreakdown;
      record.confidence = _pendingTemplate.confidence;
      record.aiSaw = useAiSaw;
      record.fromTemplate = true;
      record.sourceTemplateId = _pendingTemplate.sourceTemplateId;
    }
    savedId = await putMeal(record);
  }
  const usedTemplate = !!_pendingTemplate;
  _pendingTemplate = null;
  const wasEditing = !!editingMealId;
  closeMealModal();
  toast(wasEditing ? 'Meal updated ✓' : (usedTemplate ? 'From template ✓' : 'Meal saved ✓'));
  renderMeals();
  // Only auto-analyze if there's no estimate yet AND not from a template
  if (getGeminiKey() && savedId && !usedTemplate) {
    const meal = await getMeal(savedId);
    if (meal && !meal.calories) setTimeout(async () => { const ok = await autoAnalyzeMeal(savedId); if (ok) { renderMeals(); renderAnalysis(); } }, 800);
  }
}



let trendMode = 'week'; // 'day' | 'week' | 'month'
function setTrendMode(m) {
  trendMode = m;
  ['day','week','month'].forEach(k => {
    const b = document.getElementById('trendMode' + k.charAt(0).toUpperCase() + k.slice(1));
    if (b) b.classList.toggle('on', m === k);
  });
  drawEnergyChart('analysisChart');
  // Steps chart follows the trend mode too
  renderSteps?.();
}



// Build the dual-axis nutrition trend chart (Day = cumulative hourly; Week/Month = daily totals).
async function drawEnergyChart(elementId = 'analysisChart') {
  const el = document.getElementById(elementId);
  if (!el) return;
  const caption = document.getElementById('trendChartCaption');
  // Sync segmented buttons in case of first render
  ['day','week','month'].forEach(k => {
    const b = document.getElementById('trendMode' + k.charAt(0).toUpperCase() + k.slice(1));
    if (b) b.classList.toggle('on', trendMode === k);
  });

  if (trendMode === 'day') return drawDayTrend(el, caption);
  const days = trendMode === 'month' ? 30 : 7;
  return drawRangeTrend(el, caption, days);
}

async function drawDayTrend(el, caption) {
  const meals = (await getAllMeals()).filter(m => m.date === todayISO()).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const w = 600, h = 220, padL = 38, padR = 38, padB = 28, padT = 14;
  // Walk hours 0..24, accumulate cal & protein at each meal time
  let accCal = 0, accProt = 0;
  // Points: [hour, cumulativeCal, cumulativeProtein]
  const pts = [{ h: 0, cal: 0, p: 0 }];
  for (const m of meals) {
    if (!m.time) continue;
    const [hh, mm] = m.time.split(':').map(Number);
    const h = hh + (mm || 0) / 60;
    accCal += m.calories || 0;
    accProt += (typeof m.protein === 'number' ? m.protein : 0);
    pts.push({ h, cal: accCal, p: accProt });
  }
  const nowH = new Date().getHours() + new Date().getMinutes() / 60;
  pts.push({ h: Math.max(nowH, pts[pts.length-1].h), cal: accCal, p: accProt });

  const xMin = 0, xMax = 24;
  const calMax = Math.max(2000, accCal * 1.15);
  const protMax = Math.max(120, accProt * 1.15);
  const xScale = h => padL + (h - xMin) / (xMax - xMin) * (w - padL - padR);
  const yScaleCal = v => h - padB - (v / calMax) * (h - padB - padT);
  const yScaleProt = v => h - padB - (v / protMax) * (h - padB - padT);

  const calPath = 'M ' + pts.map(p => `${xScale(p.h).toFixed(1)},${yScaleCal(p.cal).toFixed(1)}`).join(' L ');
  const pPath   = 'M ' + pts.map(p => `${xScale(p.h).toFixed(1)},${yScaleProt(p.p).toFixed(1)}`).join(' L ');

  // Grid hours every 4h
  const hourTicks = [0, 4, 8, 12, 16, 20, 24].map(h => `<line x1="${xScale(h)}" y1="${padT}" x2="${xScale(h)}" y2="${h===0||h===24?h:h-padB}" stroke="var(--line)" stroke-dasharray="2,3" opacity="0.5"/><text x="${xScale(h)}" y="${220 - padB + 14}" fill="var(--muted)" font-size="10" text-anchor="middle">${String(h).padStart(2,'0')}:00</text>`).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height: 220px; width: 100%;">
      ${hourTicks}
      <!-- Cal Y axis labels (left) -->
      ${[0, calMax/2, calMax].map(v => `<text x="${padL-4}" y="${yScaleCal(v)+3}" fill="var(--accent)" font-size="10" text-anchor="end">${Math.round(v)}</text>`).join('')}
      <!-- Protein Y axis labels (right) -->
      ${[0, protMax/2, protMax].map(v => `<text x="${w-padR+4}" y="${yScaleProt(v)+3}" fill="var(--accent2)" font-size="10" text-anchor="start">${Math.round(v)}g</text>`).join('')}
      <!-- Target lines -->
      <line x1="${padL}" y1="${yScaleCal(DAILY_CAL_GOAL)}" x2="${w-padR}" y2="${yScaleCal(DAILY_CAL_GOAL)}" stroke="var(--accent)" stroke-dasharray="3,3" opacity="0.4"/>
      <line x1="${padL}" y1="${yScaleProt(DAILY_PROTEIN_GOAL)}" x2="${w-padR}" y2="${yScaleProt(DAILY_PROTEIN_GOAL)}" stroke="var(--accent2)" stroke-dasharray="3,3" opacity="0.4"/>
      <!-- Lines -->
      <path d="${calPath}" stroke="var(--accent)" stroke-width="2.5" fill="none"/>
      <path d="${pPath}" stroke="var(--accent2)" stroke-width="2.5" fill="none"/>
      <!-- Now marker -->
      <line x1="${xScale(nowH)}" y1="${padT}" x2="${xScale(nowH)}" y2="${h-padB}" stroke="var(--muted)" stroke-dasharray="4,4" opacity="0.4"/>
    </svg>`;
  if (caption) caption.innerHTML = `<span style="color: var(--accent);">● ${Math.round(accCal)} kcal</span> &nbsp;·&nbsp; <span style="color: var(--accent2);">● ${Math.round(accProt)}g protein</span> — today, cumulative`;
}

// Week/Month: original Net bar chart style, restored
async function drawRangeTrend(el, caption, days) {
  const today = new Date();
  let data = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const iso = _isoDate(d);
    const e = await computeDailyEnergy(iso);
    data.push({
      iso,
      label: days <= 7
        ? d.toLocaleDateString(undefined, { weekday: 'short' })
        : d.getDate() + '/' + (d.getMonth() + 1),
      net: e.eaten ? Math.round(e.eaten - e.burned) : null
    });
  }
  // Trim leading empty days (no data) so the chart starts at first day with data
  const firstIdx = data.findIndex(d => d.net !== null);
  if (firstIdx > 0) data = data.slice(firstIdx);
  if (data.length === 0) {
    el.innerHTML = '<div class="empty">No data yet for this range.</div>';
    if (caption) caption.textContent = '';
    return;
  }
  // Match steps chart axis settings: pad, rotate labels when >10 points
  const rotate = data.length > 10;
  const w = 600, h = 240, pad = 36, padBottom = rotate ? 50 : 30;
  const chartH = h - padBottom;
  const validNet = data.filter(d => d.net !== null).map(d => d.net);
  const maxAbs = Math.max(800, ...validNet.map(Math.abs));
  const midY = padBottom/2 + (chartH)/2;
  const yScale = y => midY - (y / maxAbs) * (chartH/2 - pad/2);
  const slotW = (w - pad*2) / data.length;
  const barW = slotW * 0.7;
  const gap  = slotW * 0.3;
  const labelFontSize = rotate ? 9 : 10;
  const valueFontSize = rotate ? 9 : 10;

  const bars = data.map((d, i) => {
    const x = pad + i * slotW + gap/2;
    const cx = x + barW/2;
    const labelY = chartH + (rotate ? 14 : 18);
    const labelHTML = rotate
      ? `<text x="${cx}" y="${labelY}" fill="var(--muted)" font-size="${labelFontSize}" text-anchor="end" transform="rotate(-45 ${cx} ${labelY})">${d.label}</text>`
      : `<text x="${cx}" y="${labelY}" fill="var(--muted)" font-size="${labelFontSize}" text-anchor="middle">${d.label}</text>`;
    if (d.net === null) {
      return `<text x="${cx}" y="${midY + 4}" fill="var(--muted)" font-size="11" text-anchor="middle">—</text>${labelHTML}`;
    }
    const yTop = d.net >= 0 ? yScale(d.net) : yScale(0);
    const barH = Math.abs(yScale(d.net) - yScale(0));
    const color = d.net < 0 ? 'var(--accent2)' : 'var(--danger)';
    return `
      <rect x="${x}" y="${yTop}" width="${barW}" height="${barH}" fill="${color}" rx="2"/>
      <text x="${cx}" y="${d.net >= 0 ? yTop - 3 : yTop + barH + 10}" fill="var(--text)" font-size="${valueFontSize}" text-anchor="middle" font-weight="600">${d.net > 0 ? '+' : ''}${d.net}</text>
      ${labelHTML}
    `;
  }).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height: 240px; width: 100%;">
      <line x1="${pad}" y1="${midY}" x2="${w-pad}" y2="${midY}" stroke="var(--line)"/>
      <text x="${pad-4}" y="${midY+3}" fill="var(--muted)" font-size="10" text-anchor="end">0</text>
      <line x1="${pad}" y1="${yScale(-300)}" x2="${w-pad}" y2="${yScale(-300)}" stroke="var(--accent2)" stroke-dasharray="3,3" opacity="0.4"/>
      <text x="${w-pad}" y="${yScale(-300)-3}" fill="var(--accent2)" font-size="9" text-anchor="end">−300 fat-loss target</text>
      ${bars}
    </svg>`;
  if (caption) caption.textContent = `Net = eaten − burned. Bars below 0 = deficit ✓ — last ${days} days`;
}

let analysisMode = 'day'; // 'day' or 'week'

function setAnalysisMode(mode) {
  analysisMode = mode;
  document.getElementById('analysisModeDay').classList.toggle('on', mode === 'day');
  document.getElementById('analysisModeWeek').classList.toggle('on', mode === 'week');
  document.getElementById('analysisDayView').style.display = mode === 'day' ? 'block' : 'none';
  document.getElementById('analysisWeekView').style.display = mode === 'week' ? 'block' : 'none';
  renderAnalysis();
}

function shiftAnalysisDate(delta) {
  const base = analysisViewDate || todayISO();
  const step = analysisMode === 'week' ? 7 : 1;
  const [y, m, d] = base.split('-').map(Number);
  const date = new Date(y, m - 1, d + delta * step);
  const shifted = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
  if (shifted > todayISO()) return;
  analysisViewDate = shifted === todayISO() ? null : shifted;
  renderAnalysis();
}

// Returns the Sunday-anchored week start ISO for a given date

async function renderWeekView() {
  const viewDate = analysisViewDate || todayISO();
  const weekStart = weekStartFor(viewDate);
  const days = weekDates(weekStart);

  const labelEl = document.getElementById('analysisDateLabel');
  const startDate = new Date(...weekStart.split('-').map((v,i) => i===1 ? Number(v)-1 : Number(v)));
  const endDate = new Date(...days[6].split('-').map((v,i) => i===1 ? Number(v)-1 : Number(v)));
  if (labelEl) labelEl.textContent = startDate.toLocaleDateString(undefined, {month:'short', day:'numeric'}) + ' – ' + endDate.toLocaleDateString(undefined, {month:'short', day:'numeric'});
  const nextBtn = document.getElementById('analysisNextBtn');
  if (nextBtn) nextBtn.style.opacity = weekStart >= weekStartFor(todayISO()) ? '0.3' : '1';

  let totalNet = 0, totalSteps = 0, proteinHits = 0, workouts = 0, daysWithData = 0;
  for (const d of days) {
    const e = await computeDailyEnergy(d);
    if (e.mealCount > 0 || e.sessionBurn > 0) daysWithData++;
    totalNet += (e.eaten - e.burned);
    const stepRec = (state.steps || []).find(s => s.date === d);
    if (stepRec) totalSteps += stepRec.count;
    if (e.protein >= 95) proteinHits++;
    workouts += (state.sessions || []).filter(s => s.date === d).length;
  }
  const avgNet = daysWithData ? Math.round(totalNet / daysWithData) : 0;
  const avgSteps = Math.round(totalSteps / 7);
  document.getElementById('weekAvgNet').textContent = (avgNet >= 0 ? '+' : '') + avgNet;
  document.getElementById('weekProteinHits').textContent = proteinHits + ' / 7';
  document.getElementById('weekAvgSteps').textContent = avgSteps.toLocaleString();
  document.getElementById('weekWorkouts').textContent = workouts;

  // Show weekly note for this week
  const weeklyNote = (state.weeklyNotes || []).find(n => n.weekStart === weekStart);
  const notesEl = document.getElementById('weeklyNotes');
  if (notesEl) {
    if (weeklyNote) notesEl.innerHTML = '<div style="white-space: pre-wrap; line-height: 1.5;">' + escapeHtml(weeklyNote.note) + '</div>';
    else notesEl.innerHTML = '<div class="muted small">No weekly analysis yet. Tap the button above to generate one.</div>';
  }
}

async function renderAnalysis() {
  if (analysisMode === 'week') {
    return renderWeekView();
  }
  // Update steps section (lives in analysis tab now)
  renderSteps();
  const today = todayISO();
  const viewDate = analysisViewDate || today;
  const isToday = viewDate === today;

  // Update nav UI
  const labelEl = document.getElementById('analysisDateLabel');
  if (labelEl) labelEl.textContent = isToday ? 'Today' : formatDate(viewDate);
  const nextBtn = document.getElementById('analysisNextBtn');
  if (nextBtn) nextBtn.style.opacity = isToday ? '0.3' : '1';
  const titleEl = document.getElementById('analysisEnergyTitle');
  if (titleEl) titleEl.textContent = isToday ? "Today's energy" : formatDate(viewDate) + ' energy';

  const e = await computeDailyEnergy(viewDate);
  document.getElementById('analysisEaten').textContent = e.eaten ? e.eaten.toLocaleString() : '—';
  document.getElementById('analysisEatenSub').textContent = e.mealCount === 0
    ? 'No meals logged'
    : (e.estimatedCount === e.mealCount
        ? `${e.mealCount} meal${e.mealCount > 1 ? 's' : ''} · ${DAILY_CAL_GOAL} goal`
        : `${e.estimatedCount} of ${e.mealCount} estimated`);
  document.getElementById('analysisBurned').textContent = e.burned.toLocaleString();
  document.getElementById('analysisBurnedSub').textContent =
    `BMR ${e.bmr}` +
    (e.stepsBurn ? ` · steps +${e.stepsBurn}` : '') +
    (e.sessionBurn ? ` · activity +${e.sessionBurn}` : '');

  const status = document.getElementById('analysisStatus');
  if (e.eaten === 0) {
    status.style.background = 'var(--panel2)';
    status.innerHTML = '<span class="muted small">Log meals to see your daily picture</span>';
  } else {
    const net = Math.round(e.eaten - e.burned);
    let bg, text;
    if (net < -800) { bg = 'rgba(255, 149, 0, 0.15)'; text = `<b>Net: ${net} cal</b> · big deficit. Eat more — especially protein.`; }
    else if (net < -200) { bg = 'rgba(16, 185, 129, 0.18)'; text = `<b>Net: ${net} cal</b> · ✓ on track for fat loss`; }
    else if (net < 200) { bg = 'rgba(59, 130, 246, 0.15)'; text = `<b>Net: ${net >= 0 ? '+' : ''}${net} cal</b> · maintenance`; }
    else { bg = 'rgba(255, 59, 48, 0.15)'; text = `<b>Net: +${net} cal</b> · surplus`; }
    status.style.background = bg;
    status.innerHTML = text;
  }

  // Protein progress in Analysis card
  const proteinEl = document.getElementById('analysisProtein');
  if (proteinEl) {
    if (e.protein > 0) {
      const pct = Math.min(100, Math.round(e.protein / DAILY_PROTEIN_GOAL * 100));
      const remaining = DAILY_PROTEIN_GOAL - e.protein;
      const fillColor = pct >= 100 ? 'var(--accent2)' : pct >= 70 ? '#7ad1c3' : 'var(--accent)';
      proteinEl.innerHTML = `
        <div class="row between" style="margin-bottom: 5px;">
          <span class="muted small" style="text-transform: uppercase; letter-spacing: 0.5px;">Protein</span>
          <span class="small" style="font-weight: 600; color: var(--accent2);">${e.protein}g / ${DAILY_PROTEIN_GOAL}g</span>
        </div>
        <div style="height: 7px; background: var(--panel2); border-radius: 4px; overflow: hidden;">
          <div style="height: 100%; width: ${pct}%; border-radius: 4px; background: ${fillColor}; transition: width 0.4s ease;"></div>
        </div>
        <div class="small muted" style="margin-top: 3px;">${remaining > 0 ? `${remaining}g more to reach goal` : `✓ Goal hit (+${-remaining}g)`}</div>
      `;
    } else {
      proteinEl.innerHTML = '<div class="muted small" style="margin-top: 6px;">Protein tracked once AI estimates your meals.</div>';
    }
  }

  // Detailed breakdown
  const meals = await getAllMeals();
  const todayMeals = meals.filter(m => m.date === viewDate).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const todaySessions = (state.sessions || []).filter(s => s.date === viewDate).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const stepsToday = (state.steps || []).find(s => s.date === viewDate);
  const breakdown = document.getElementById('analysisBreakdown');
  let html = '<div class="muted small" style="text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Eaten</div>';
  if (todayMeals.length === 0) {
    html += '<div class="muted small" style="margin-bottom: 12px;">No meals logged</div>';
  } else {
    for (const m of todayMeals) {
      const pStr = typeof m.protein === 'number' && m.protein > 0 ? ` · <span style="color:var(--accent2)">${m.protein}g P</span>` : '';
      html += `<div class="row between" style="padding: 4px 0; border-bottom: 1px solid var(--line);">
        <span class="small">${m.time ? m.time + ' · ' : ''}${escapeHtml(m.description) || '(no description)'}</span>
        <span class="small" style="font-weight: 600; color: ${m.calories ? 'var(--accent)' : 'var(--muted)'};">${m.calories ? m.calories + ' kcal' : '—'}${pStr}</span>
      </div>`;
    }
    html += `<div class="row between" style="padding: 6px 0 12px; font-weight: 700;">
      <span>Total eaten</span>
      <span>${e.eaten.toLocaleString()} kcal</span>
    </div>`;
  }
  html += '<div class="muted small" style="text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Burned</div>';
  html += `<div class="row between" style="padding: 4px 0; border-bottom: 1px solid var(--line);"><span class="small">BMR (resting)</span><span class="small">${e.bmr.toLocaleString()} kcal</span></div>`;
  if (stepsToday) html += `<div class="row between" style="padding: 4px 0; border-bottom: 1px solid var(--line);"><span class="small">Steps (${stepsToday.count.toLocaleString()})</span><span class="small">+${e.stepsBurn} kcal</span></div>`;
  for (const s of todaySessions) {
    if (s.caloriesBurned) {
      const label = (PLAN[s.day]?.label || s.day) + (s.cardioNote ? ' · ' + s.cardioNote.slice(0, 30) + (s.cardioNote.length > 30 ? '…' : '') : '');
      html += `<div class="row between" style="padding: 4px 0; border-bottom: 1px solid var(--line);"><span class="small">${escapeHtml(label)}</span><span class="small">+${s.caloriesBurned} kcal</span></div>`;
    }
  }
  html += `<div class="row between" style="padding: 6px 0 0; font-weight: 700;"><span>Total burned</span><span>${e.burned.toLocaleString()} kcal</span></div>`;
  breakdown.innerHTML = html;

  await drawEnergyChart('analysisChart');

  // Update button label based on viewed date
  const notesArr = state.dailyNotes || [];
  const viewNote = notesArr.find(n => n.date === viewDate);
  const isPartial = viewNote && viewNote.note.includes('(Partial');

  // Show note for the viewed date
  const notesEl = document.getElementById('analysisNotes');
  if (viewNote) {
    notesEl.innerHTML = `<div style="white-space: pre-wrap; line-height: 1.6;">${escapeHtml(viewNote.note)}</div>`;
  } else {
    notesEl.innerHTML = `<div class="muted small">No summary for ${isToday ? 'today' : formatDate(viewDate)} yet. Tap the button above to generate one.</div>`;
  }
}


async function renderMeals() {
  await reconcileMealTotals();
  const meals = await getAllMeals();
  const list = document.getElementById('mealList');
  const empty = document.getElementById('mealEmpty');
  empty.style.display = meals.length ? 'none' : 'block';
  list.innerHTML = '';

  // Update protein bar
  const today = todayISO();
  const todayMeals = meals.filter(m => m.date === today);
  const proteinToday = todayMeals.reduce((sum, m) => sum + (typeof m.protein === 'number' ? m.protein : 0), 0);
  const mealsWithProtein = todayMeals.filter(m => typeof m.protein === 'number' && m.protein > 0).length;
  const proteinBarEl = document.getElementById('proteinBar');
  if (proteinBarEl) {
    if (mealsWithProtein > 0) {
      proteinBarEl.style.display = 'block';
      const pct = Math.min(100, Math.round(proteinToday / DAILY_PROTEIN_GOAL * 100));
      const remaining = DAILY_PROTEIN_GOAL - proteinToday;
      document.getElementById('proteinBarLabel').textContent = `${proteinToday}g / ${DAILY_PROTEIN_GOAL}g`;
      document.getElementById('proteinBarFill').style.width = pct + '%';
      document.getElementById('proteinBarFill').style.background = pct >= 100 ? 'var(--accent2)' : pct >= 70 ? '#7ad1c3' : 'var(--accent)';
      document.getElementById('proteinBarSub').textContent = remaining > 0
        ? `${remaining}g more to hit your daily goal`
        : `Goal reached! +${-remaining}g over`;
    } else {
      proteinBarEl.style.display = todayMeals.length > 0 ? 'block' : 'none';
      if (todayMeals.length > 0) {
        document.getElementById('proteinBarLabel').textContent = '—';
        document.getElementById('proteinBarFill').style.width = '0%';
        document.getElementById('proteinBarSub').textContent = 'Protein estimated when AI analyzes your meals';
      }
    }
  }

  // Group meals by date (descending)
  const groups = {};
  for (const m of meals) {
    if (!groups[m.date]) groups[m.date] = [];
    groups[m.date].push(m);
  }
  const sortedDates = Object.keys(groups).sort().reverse();

  for (const date of sortedDates) {
    const dayMeals = groups[date];
    const totalCal = dayMeals.reduce((sum, m) => sum + (m.calories || 0), 0);
    const estimated = dayMeals.filter(m => typeof m.calories === 'number' && m.calories > 0).length;
    const isToday = date === today;
    const summaryRight = `<span style="color: ${totalCal > 0 ? 'var(--accent)' : 'var(--muted)'}; font-weight: 600;">${totalCal > 0 ? `${totalCal.toLocaleString()} kcal` : '—'} · ${dayMeals.length} meal${dayMeals.length > 1 ? 's' : ''}${estimated < dayMeals.length ? ` (${estimated}/${dayMeals.length})` : ''}</span>`;

    let dayGroup, mealsHost;
    if (isToday) {
      dayGroup = document.createElement('div');
      dayGroup.style.cssText = 'margin-top: 18px;';
      const header = document.createElement('div');
      header.className = 'muted small';
      header.style.cssText = 'margin-bottom: 8px; font-weight: 500; display: flex; justify-content: space-between; align-items: baseline;';
      header.innerHTML = `<span>Today</span>${summaryRight}`;
      dayGroup.appendChild(header);
      mealsHost = dayGroup;
    } else {
      dayGroup = document.createElement('details');
      dayGroup.style.cssText = 'margin-top: 18px;';
      const summary = document.createElement('summary');
      summary.className = 'muted small';
      summary.style.cssText = 'margin-bottom: 8px; font-weight: 500; display: flex; justify-content: space-between; align-items: baseline; cursor: pointer; list-style: none;';
      const [yy, mm, dd] = date.split('-').map(Number);
      const dt = new Date(yy, mm - 1, dd);
      const dashLabel = dt.toLocaleDateString(undefined, { weekday: 'long' }) + ' — ' + dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      summary.innerHTML = `<span>▸ ${dashLabel}</span>${summaryRight}`;
      dayGroup.appendChild(summary);
      mealsHost = dayGroup;
    }
    list.appendChild(dayGroup);

    for (const m of dayMeals) {
    const blobs = mealBlobs(m);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '12px 14px';
    card.style.cursor = 'pointer';
    card.style.marginBottom = '8px';
    const thumbs = blobs.length
      ? `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 6px; margin-top: 8px;">
          ${blobs.map(b => `<img src="${URL.createObjectURL(b)}" style="width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px;">`).join('')}
        </div>`
      : '';
    const calBadge = (typeof m.calories === 'number' && m.calories > 0)
      ? `<span style="display:inline-block; background: var(--accent); color: white; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-left: 6px;">~${m.calories} kcal</span>`
      : '';
    const proteinBadge = (typeof m.protein === 'number' && m.protein > 0)
      ? `<span style="display:inline-block; background: var(--accent2); color: #0b1220; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-left: 4px;">${m.protein}g protein</span>`
      : '';
    const breakdownHtml = (m.breakdown && m.breakdown.length)
      ? `<details style="margin-top: 8px;" onclick="event.stopPropagation()"><summary class="muted small">Breakdown ${m.confidence ? '· ' + m.confidence + ' confidence' : ''}</summary>
          ${m.aiSaw ? `<div class="small muted" style="margin-top: 4px; font-style: italic;">AI saw: ${escapeHtml(m.aiSaw)}</div>` : ''}
          ${m.breakdown.map(b => `<div class="row between" style="padding: 3px 0; font-size: 13px;"><span>${escapeHtml(b.name)} <span class="muted">${escapeHtml(b.portion || '')}</span></span><span style="font-weight: 600;">${b.calories} kcal${b.protein ? ` · <span style="color:var(--accent2)">${b.protein}g P</span>` : ''}</span></div>`).join('')}
        </details>`
      : '';
    const questionsHtml = (m.questions && m.questions.length)
      ? `<div style="margin-top: 6px; padding: 8px 10px; background: rgba(255, 149, 0, 0.12); border-left: 3px solid var(--warn); border-radius: 6px;">
          <div class="small" style="font-weight: 600; color: var(--warn);">❓ AI has ${m.questions.length} question${m.questions.length > 1 ? 's' : ''}:</div>
          ${m.questions.map(q => `<div class="small" style="margin-top: 4px;">• ${escapeHtml(q)}</div>`).join('')}
          <div class="small muted" style="margin-top: 6px;">Tap the meal to answer via "Refine".</div>
        </div>`
      : '';
    const reanalyzeBtn = getGeminiKey()
      ? `<button class="ghost" id="reanalyzeCard-${m.id}" style="padding: 4px 10px; font-size: 12px;" onclick="event.stopPropagation(); reanalyzeMealInPlace(${m.id})">Re-analyze</button>`
      : '';
    const isTemplated = !!m.templateId;
    const tplBtn = `<button class="ghost" style="padding: 4px 10px; font-size: 12px; ${isTemplated ? 'color: var(--accent2);' : ''}" onclick="event.stopPropagation(); ${isTemplated ? 'openTemplatePicker()' : `quickSaveMealAsTemplate(${m.id})`}" title="${isTemplated ? 'Saved as template' : 'Save as template'}">${isTemplated ? '✓ Templated' : '💾 Save template'}</button>`;
    const chatBtn = getGeminiKey()
      ? `<button class="ghost" style="padding: 4px 10px; font-size: 12px;" onclick="event.stopPropagation(); openMealModal(${m.id}); setTimeout(() => document.getElementById('refineInput')?.focus(), 300);" title="Chat about this meal">💬 Chat</button>`
      : '';
    const cardActions = (chatBtn || reanalyzeBtn || tplBtn)
      ? `<div class="row" style="gap: 6px; flex-wrap: wrap; margin-top: 8px;">${chatBtn}${reanalyzeBtn}${tplBtn}</div>`
      : '';
    card.innerHTML = `
      <div class="row between" style="align-items: flex-start;">
        <div class="grow" style="min-width: 0; word-wrap: break-word; line-height: 1.6;">
          ${m.time ? `<span class="muted small">${m.time}</span> · ` : ''}${escapeHtml(m.description) || '<span class="muted small">(tap to add description)</span>'}${blobs.length > 1 ? `<span class="muted small"> · ${blobs.length} photos</span>` : ''}${calBadge}${proteinBadge}
        </div>
        <button class="icon ghost" onclick="event.stopPropagation(); removeMeal(${m.id})" aria-label="Delete">✕</button>
      </div>
      ${thumbs}
      ${questionsHtml}
      ${breakdownHtml}
      ${cardActions}
    `;
    card.addEventListener('click', () => openMealModal(m.id));
    dayGroup.appendChild(card);
  }
  }
}

async function removeMeal(id) {
  if (!confirm('Delete this meal?')) return;
  await deleteMeal(id);
  renderMeals();
}

// ---------- AI / GEMINI ----------
// Thin wrapper over setGeminiKey: trims pasted input (UI concern).
function saveGeminiKey(v) { setGeminiKey((v || '').trim()); }

function aiHistory() {
  try { return JSON.parse(localStorage.getItem('fit.aiHistory') || '[]'); } catch { return []; }
}
function saveAiHistory(h) { localStorage.setItem('fit.aiHistory', JSON.stringify(h.slice(-30))); }

async function buildAIContext() {
  const meals = await getAllMeals();
  const mealSummary = meals.slice(0, 30).map(m => ({
    date: m.date, time: m.time,
    description: m.description || '(no description)',
    calories: m.calories || null
  }));
  const ctx = {
    user: {
      age: 44, sex: 'male', height_cm: 168, weight_kg: 58,
      bmr: BMR, dailyCalGoal: DAILY_CAL_GOAL, waistGoal: WAIST_GOAL,
      trainingPlan: 'Tue: 8k run + upper · Wed: movement 1hr · Thu: intervals + upper · Sat: legs · Sun/Mon/Fri: rest'
    },
    measurements: state.measurements || [],
    steps: state.steps || [],
    sessions: (state.sessions || []).slice(-20).map(s => ({
      date: s.date, type: s.day,
      cardio: s.cardioNote || null,
      caloriesBurned: s.caloriesBurned || null,
      exercises: (s.entries || []).filter(e => e.sets?.length).map(e => `${e.name}: ${e.sets.map(x=>x.reps).join(',')}${e.durationMin ? ' (' + e.durationMin + ' min)' : ''}${e.note ? ' — note: ' + e.note : ''}`),
      notes: s.notes || null
    })),
    meals: mealSummary,
    recentNotes: (state.dailyNotes || []).slice(-7),
    today: todayISO()
  };
  return ctx;
}

async function reanalyzeMeal() {
  if (!editingMealId) return;
  const btn = document.getElementById('reanalyzeMealBtn');
  btn.disabled = true;
  btn.textContent = '⟳ Analyzing…';
  const ok = await autoAnalyzeMeal(editingMealId, { force: true });
  btn.disabled = false;
  btn.textContent = 'Re-analyze (calories + protein)';
  if (ok) {
    const m = await getMeal(editingMealId);
    if (m) toast(`Updated: ~${m.calories} kcal${m.protein ? ' · ' + m.protein + 'g protein' : ''}`);
    renderMeals();
    renderAnalysis();
  }
}

// In-place re-analyze from meal card — no modal opens
async function reanalyzeMealInPlace(mealId) {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const before = await getMeal(mealId);
  if (!before) return;
  const oldCal = before.calories || 0;
  const oldProt = before.protein || 0;

  const btn = document.getElementById(`reanalyzeCard-${mealId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Analyzing…'; }
  const ok = await autoAnalyzeMeal(mealId, { silent: true, force: true });
  if (btn) { btn.disabled = false; btn.textContent = '🔄 Re-analyze'; }
  if (!ok) return toast('Re-analyze failed');

  const after = await getMeal(mealId);
  const newCal = after.calories || 0;
  const newProt = after.protein || 0;
  const calDelta = `${oldCal} → ${newCal} kcal`;
  const protDelta = newProt ? ` · ${oldProt}g → ${newProt}g protein` : '';
  toast(calDelta + protDelta);
  renderMeals();
  renderAnalysis();
}


let _pendingRefine = null;
let _mealChatHistory = []; // [{role: 'user'|'model', text}]
let _mealChatId = null;

function resetMealChat() {
  _pendingRefine = null;
  _mealChatHistory = [];
  _mealChatId = null;
  _mealAttachedImages = [];
  renderMealAttachPreview();
  const r = document.getElementById('refineResult');
  if (r) { r.style.display = 'none'; r.innerHTML = ''; }
  const i = document.getElementById('refineInput');
  if (i) i.value = '';
}

async function refineMealEstimate() {
  const text = document.getElementById('refineInput').value.trim();
  if (!text && _mealAttachedImages.length === 0) return toast('Type a message first');
  if (!editingMealId) return toast('Open a meal first');
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const meal = await getMeal(editingMealId);
  if (!meal) return;

  // Direct number override: "update to 450", "set 400 cal", "450", "450 kcal", etc.
  const directMatch = text.match(/^(?:(?:update|set|change|make|use|apply)(?:\s+(?:it|calories?|kcal|to|at))?\s+(?:to\s+)?)?(\d{2,4})\s*(?:kcal|cal(?:ories?)?)?$/i);
  if (directMatch) {
    const cal = parseInt(directMatch[1], 10);
    if (cal >= 50 && cal <= 5000) {
      document.getElementById('refineInput').value = '';
      _pendingRefine = { total: cal, items: meal.breakdown || [], saw: meal.aiSaw, confidence: meal.confidence, changeNote: `Manually set to ${cal} kcal` };
      if (_mealChatId !== editingMealId) { _mealChatHistory = []; _mealChatId = editingMealId; }
      _mealChatHistory.push({ role: 'user', text });
      _mealChatHistory.push({ role: 'model', text: `Got it — I'll set this to ${cal} kcal. Tap "Apply ${cal} kcal" below to save.` });
      renderMealRefineChat();
      return;
    }
  }

  if (_mealChatId !== editingMealId) {
    _mealChatHistory = [];
    _mealChatId = editingMealId;
  }

  // User engaged with the questions — clear the banner. AI still has them in chat history.
  if (meal.questions && meal.questions.length) {
    meal.questions = [];
    await putMeal(meal);
    renderMeals();
  }

  const userImages = _mealAttachedImages.splice(0);
  _mealChatHistory.push({ role: 'user', text, images: userImages.length ? userImages : undefined });
  document.getElementById('refineInput').value = '';
  autoResizeTA(document.getElementById('refineInput'));
  renderMealAttachPreview();
  renderMealRefineChat();
  toast('Thinking…', { persistent: true });

  try {
    const blobs = mealBlobs(meal);
    const systemInstruction = PROMPTS.mealChatSystem
      .replace('{description}', meal.description || '(none)')
      .replace('{currentCalories}', String(meal.calories || 'unknown'))
      .replace('{breakdown}', JSON.stringify(meal.breakdown || []))
      .replace('{aiSaw}', meal.aiSaw || '(none)');

    // Build contents — attach photos to EVERY user message so AI can re-verify
    const contents = [];
    let isLastUserMsg = true;
    for (let i = _mealChatHistory.length - 1; i >= 0; i--) {
      const m = _mealChatHistory[i];
      const parts = [{ text: m.text || '' }];
      if (m.role === 'user') {
        // Meal photos on every user msg (so AI can re-verify)
        if (blobs.length) {
          for (const blob of blobs) {
            const dataUrl = await blobToDataUrl(blob);
            parts.push({ inline_data: { mime_type: blob.type || 'image/jpeg', data: dataUrl.split(',')[1] } });
          }
        }
        // Per-message user-attached images
        if (m.images) {
          for (const img of m.images) {
            parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.dataUrl.split(',')[1] } });
          }
        }
      }
      contents.unshift({ role: m.role === 'user' ? 'user' : 'model', parts });
    }

    const reply = await geminiGenerate({ systemInstruction, contents });
    _mealChatHistory.push({ role: 'model', text: reply });

    // Persist chat history on the meal so it survives across modal opens / device sync
    const fresh = await getMeal(editingMealId);
    if (fresh) {
      const updateClaims = /\b(i('ve| have) (updated|adjusted|set|changed|saved)|it'?s (already |now )?set to|done[,.]?\s*i('ve| have))/i;
      fresh.chatHistory = _mealChatHistory.filter(msg => msg.role !== 'model' || !updateClaims.test(msg.text)).slice(-40);
      await putMeal(fresh);
    }

    hideToast();
    renderMealRefineChat();
    document.getElementById('updateMealEstimateBtn').style.display = 'block';
  } catch (e) {
    hideToast();
    toast('Failed: ' + (e.message || 'unknown'));
  }
}

async function requestMealEstimateUpdate() {
  if (!editingMealId) return;
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  if (_mealChatHistory.length === 0) return toast('Chat with AI first to provide context');
  const meal = await getMeal(editingMealId);
  if (!meal) return;

  toast('Generating proposal…', { persistent: true });
  try {
    const blobs = mealBlobs(meal);
    const systemInstruction = PROMPTS.mealChatSystem
      .replace('{description}', meal.description || '(none)')
      .replace('{currentCalories}', String(meal.calories || 'unknown'))
      .replace('{breakdown}', JSON.stringify(meal.breakdown || []))
      .replace('{aiSaw}', meal.aiSaw || '(none)');

    const updatePrompt = PROMPTS.mealEstimateUpdate
      .replace('{description}', meal.description || '(none)')
      .replace('{currentCalories}', String(meal.calories || 'unknown'))
      .replace('{breakdown}', JSON.stringify(meal.breakdown || []))
      .replace('{aiSaw}', meal.aiSaw || '(none)');

    const contents = [];
    for (const m of _mealChatHistory) {
      const parts = [{ text: m.text }];
      if (m.role === 'user' && blobs.length) {
        for (const blob of blobs) {
          const dataUrl = await blobToDataUrl(blob);
          const base64 = dataUrl.split(',')[1];
          parts.push({ inline_data: { mime_type: blob.type || 'image/jpeg', data: base64 } });
        }
      }
      contents.push({ role: m.role === 'user' ? 'user' : 'model', parts });
    }
    const updateParts = [{ text: updatePrompt }];
    if (blobs.length) {
      for (const blob of blobs) {
        const dataUrl = await blobToDataUrl(blob);
        const base64 = dataUrl.split(',')[1];
        updateParts.push({ inline_data: { mime_type: blob.type || 'image/jpeg', data: base64 } });
      }
    }
    contents.push({ role: 'user', parts: updateParts });

    const reply = await geminiGenerate({ systemInstruction, contents });
    const parsed = parseJSONResponse(reply);
    hideToast();
    if (!parsed || typeof parsed.total !== 'number') { toast('Could not parse proposal'); return; }
    // Override AI's claimed total/totalProtein with the sum of items so the
    // displayed proposal always equals the breakdown (no math mismatch).
    const totals = recomputeMealTotals(parsed.items);
    if (totals.total != null) parsed.total = totals.total;
    if (totals.protein != null) parsed.totalProtein = totals.protein;
    _pendingRefine = parsed;
    renderMealRefineChat();
  } catch (e) {
    hideToast();
    toast('Failed: ' + (e.message || 'unknown'));
  }
}

function renderMealRefineChat() {
  const div = document.getElementById('refineResult');
  div.style.display = 'block';
  let html = '<div style="max-height: 50vh; overflow-y: auto;">';
  for (const m of _mealChatHistory) {
    if (m.role === 'user') {
      const imgs = (m.images || []).map(img => `<img src="${img.dataUrl}" style="max-width:140px; max-height:100px; border-radius:8px; display:block; margin-bottom:4px;">`).join('');
      const txt = m.text ? `<div style="white-space: pre-wrap;">${escapeHtml(m.text)}</div>` : '';
      html += `<div style="display: flex; justify-content: flex-end; margin: 6px 0;">
        <div style="max-width: 88%; padding: 8px 12px; border-radius: 14px 14px 4px 14px; background: var(--accent); color: white; font-size: 14px;">${imgs}${txt}</div>
      </div>`;
    } else {
      // Plain text reply now (no JSON expected)
      html += `<div style="margin: 6px 0; padding: 10px 12px; border-radius: 14px 14px 14px 4px; background: var(--panel); border: 1px solid var(--line); max-width: 95%; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(m.text)}</div>`;
    }
  }
  html += '</div>';
  // Show estimate update preview only when Update Estimate button has been used and parsed JSON exists
  if (_pendingRefine && typeof _pendingRefine.total === 'number') {
    html += `<div style="margin-top: 12px; padding: 12px; background: rgba(16, 185, 129, 0.12); border-left: 3px solid var(--accent2); border-radius: 8px;">
      <div class="muted small" style="text-transform: uppercase; letter-spacing: 0.5px;">Proposed estimate</div>
      <div style="font-size: 22px; font-weight: 700; margin: 4px 0;">${_pendingRefine.total} kcal${_pendingRefine.totalProtein != null ? ` · <span style="color: var(--accent2)">${_pendingRefine.totalProtein}g protein</span>` : ''}</div>
      ${_pendingRefine.changeNote ? `<div class="small" style="font-style: italic; margin-bottom: 6px;">${escapeHtml(_pendingRefine.changeNote)}</div>` : ''}
      ${(_pendingRefine.items || []).map(i => `<div class="small" style="padding: 1px 0;">• ${escapeHtml(i.name)} (${escapeHtml(i.portion || '')}): ${i.calories} kcal${i.protein != null ? ` · ${i.protein}g` : ''}</div>`).join('')}
      <div class="row" style="margin-top: 10px; gap: 6px;">
        <button class="primary grow" onclick="applyRefineResult()">Apply ${_pendingRefine.total} kcal${_pendingRefine.totalProtein != null ? ` / ${_pendingRefine.totalProtein}g` : ''}</button>
        <button class="ghost" onclick="_pendingRefine=null;renderMealRefineChat();">Discard</button>
      </div>
    </div>`;
  }
  div.innerHTML = html;
  // Scroll the inner chat list to bottom (it has max-height + overflow-y)
  const inner = div.querySelector('div[style*="max-height"]');
  if (inner) inner.scrollTop = inner.scrollHeight;
  // Also scroll the modal itself so the proposal/input is visible
  const modal = document.getElementById('mealModal');
  if (modal) setTimeout(() => modal.scrollTop = modal.scrollHeight, 50);
}

async function applyRefineResult() {
  if (!_pendingRefine || !editingMealId) return;
  const meal = await getMeal(editingMealId);
  if (!meal) return;
  meal.calories = _pendingRefine.total;
  if (_pendingRefine.totalProtein != null) meal.protein = _pendingRefine.totalProtein;
  meal.breakdown = _pendingRefine.items || [];
  meal.aiSaw = _pendingRefine.saw || meal.aiSaw;
  meal.confidence = _pendingRefine.confidence || meal.confidence;
  // User explicitly approved this estimate — clear any stale AI questions
  meal.questions = [];
  await putMeal(meal);
  // Sync the modal's input fields so a subsequent Save won't overwrite our change
  const calInput = document.getElementById('mealCalInput');
  const protInput = document.getElementById('mealProteinInput');
  if (calInput) calInput.value = meal.calories ?? '';
  if (protInput) protInput.value = meal.protein ?? '';
  toast('Updated ✓');
  // Don't reset chat — keep history so user can continue refining later
  _pendingRefine = null;
  renderMealRefineChat();
  if (typeof renderMeals === 'function') renderMeals();
}

let _pendingSessionRefine = null;
let _refiningSessionAt = null;
let _sessionChatHistory = [];


function openSessionRefine(savedAt) {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const session = state.sessions.find(s => s.savedAt === savedAt);
  if (!session) return;
  if (_refiningSessionAt !== savedAt) {
    _sessionChatHistory = [];
    _pendingSessionRefine = null;
    // Restore prior chat, or seed with open questions
    if (session.chatHistory && session.chatHistory.length) {
      _sessionChatHistory = session.chatHistory.slice();
    } else if (session.burnQuestions && session.burnQuestions.length) {
      const questionText = "A few things I wasn't sure about for this workout:\n\n" + session.burnQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n') + '\n\nCan you clarify?';
      _sessionChatHistory.push({ role: 'model', text: questionText });
    }
  }
  _refiningSessionAt = savedAt;
  _sessionAttachedImages = [];
  renderSessionAttachPreview();
  document.getElementById('sessionRefineTitle').textContent = (PLAN[session.day]?.label || session.day) + ' · ' + formatDate(session.date);
  document.getElementById('sessionRefineCurrent').textContent = `Current burn: ${session.caloriesBurned != null ? session.caloriesBurned + ' kcal' : 'not estimated yet'}`;
  document.getElementById('sessionRefineInput').value = '';
  if (_sessionChatHistory.length) {
    renderSessionRefineChat();
    document.getElementById('updateSessionEstimateBtn').style.display = 'block';
  } else {
    document.getElementById('sessionRefineResult').style.display = 'none';
    document.getElementById('updateSessionEstimateBtn').style.display = 'none';
  }
  document.getElementById('sessionRefineModal').classList.add('show');
  setTimeout(() => document.getElementById('sessionRefineInput').focus(), 100);
}

function closeSessionRefine() {
  document.getElementById('sessionRefineModal').classList.remove('show');
}

function buildSessionSystemInstruction(session) {
  const exLines = (session.entries || []).filter(e => e.sets?.length).map(e => `  - ${e.name}: ${e.sets.map(x => x.reps).join(',')}${e.durationMin ? ' (' + e.durationMin + ' min)' : ''}${e.note ? ' — note: ' + e.note : ''}`).join('\n') || '  (none)';
  return PROMPTS.sessionChatSystem
    .replace('{type}', PLAN[session.day]?.label || session.day)
    .replace('{date}', session.date)
    .replace('{cardioNote}', session.cardioNote || '(none)').replace('{cardioActivities}', formatCardioActivitiesForAI(session.cardioActivities))
    .replace('{exercises}', exLines)
    .replace('{currentBurn}', String(session.caloriesBurned ?? 'unknown'))
    .replace('{breakdown}', JSON.stringify(session.burnBreakdown || []));
}

async function refineSessionEstimate() {
  const text = document.getElementById('sessionRefineInput').value.trim();
  if (!text && _sessionAttachedImages.length === 0) return toast('Type a message first');
  if (_refiningSessionAt == null) return toast('No session selected');
  const session = state.sessions.find(s => s.savedAt === _refiningSessionAt);
  if (!session) return;

  // User engaged with the questions — clear the banner.
  if (session.burnQuestions && session.burnQuestions.length) {
    session.burnQuestions = [];
    save();
    renderHistory();
  }

  const userImages = _sessionAttachedImages.splice(0);
  _sessionChatHistory.push({ role: 'user', text, images: userImages.length ? userImages : undefined });
  document.getElementById('sessionRefineInput').value = '';
  autoResizeTA(document.getElementById('sessionRefineInput'));
  renderSessionAttachPreview();
  renderSessionRefineChat();
  toast('Thinking…', { persistent: true });

  try {
    const systemInstruction = buildSessionSystemInstruction(session);
    const contents = _sessionChatHistory.map(m => {
      const parts = [{ text: m.text || '' }];
      if (m.role === 'user' && m.images) {
        for (const img of m.images) {
          parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.dataUrl.split(',')[1] } });
        }
      }
      return { role: m.role === 'user' ? 'user' : 'model', parts };
    });

    const reply = await geminiGenerate({ systemInstruction, contents });
    _sessionChatHistory.push({ role: 'model', text: reply });

    // Persist chat history on the session
    const idx = state.sessions.findIndex(s => s.savedAt === _refiningSessionAt);
    if (idx >= 0) {
      state.sessions[idx].chatHistory = _sessionChatHistory.slice(-40);
      save();
    }

    hideToast();
    renderSessionRefineChat();
    document.getElementById('updateSessionEstimateBtn').style.display = 'block';
  } catch (e) {
    hideToast();
    toast('Failed: ' + (e.message || 'unknown'));
  }
}

async function requestSessionEstimateUpdate() {
  if (_refiningSessionAt == null) return;
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  if (_sessionChatHistory.length === 0) return toast('Chat with AI first');
  const session = state.sessions.find(s => s.savedAt === _refiningSessionAt);
  if (!session) return;

  toast('Updating estimate…', { persistent: true });
  try {
    const systemInstruction = buildSessionSystemInstruction(session);
    const exLines = (session.entries || []).filter(e => e.sets?.length).map(e => `  - ${e.name}: ${e.sets.map(x => x.reps).join(',')}${e.durationMin ? ' (' + e.durationMin + ' min)' : ''}${e.note ? ' — note: ' + e.note : ''}`).join('\n') || '  (none)';
    const updatePrompt = PROMPTS.sessionEstimateUpdate
      .replace('{type}', PLAN[session.day]?.label || session.day)
      .replace('{date}', session.date)
      .replace('{cardioNote}', session.cardioNote || '(none)').replace('{cardioActivities}', formatCardioActivitiesForAI(session.cardioActivities))
      .replace('{exercises}', exLines)
      .replace('{currentBurn}', String(session.caloriesBurned ?? 'unknown'))
      .replace('{breakdown}', JSON.stringify(session.burnBreakdown || []));

    const contents = _sessionChatHistory.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }]
    }));
    contents.push({ role: 'user', parts: [{ text: updatePrompt }] });

    const reply = await geminiGenerate({ systemInstruction, contents });
    const parsed = parseJSONResponse(reply);
    hideToast();
    if (!parsed || typeof parsed.total !== 'number') {
      toast('Could not parse update');
      return;
    }
    _pendingSessionRefine = parsed;
    renderSessionRefineChat();
  } catch (e) {
    hideToast();
    toast('Failed: ' + (e.message || 'unknown'));
  }
}

function renderSessionRefineChat() {
  const div = document.getElementById('sessionRefineResult');
  div.style.display = 'block';
  let html = '<div style="max-height: 50vh; overflow-y: auto;">';
  for (const m of _sessionChatHistory) {
    if (m.role === 'user') {
      const imgs = (m.images || []).map(img => `<img src="${img.dataUrl}" style="max-width:140px; max-height:100px; border-radius:8px; display:block; margin-bottom:4px;">`).join('');
      const txt = m.text ? `<div style="white-space: pre-wrap;">${escapeHtml(m.text)}</div>` : '';
      html += `<div style="display: flex; justify-content: flex-end; margin: 6px 0;">
        <div style="max-width: 88%; padding: 8px 12px; border-radius: 14px 14px 4px 14px; background: var(--accent); color: white; font-size: 14px;">${imgs}${txt}</div>
      </div>`;
    } else {
      html += `<div style="margin: 6px 0; padding: 10px 12px; border-radius: 14px 14px 14px 4px; background: var(--panel); border: 1px solid var(--line); max-width: 95%; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(m.text)}</div>`;
    }
  }
  html += '</div>';
  if (_pendingSessionRefine && typeof _pendingSessionRefine.total === 'number') {
    html += `<div style="margin-top: 12px; padding: 12px; background: rgba(16, 185, 129, 0.12); border-left: 3px solid var(--accent2); border-radius: 8px;">
      <div class="muted small" style="text-transform: uppercase; letter-spacing: 0.5px;">Proposed burn estimate</div>
      <div style="font-size: 22px; font-weight: 700; margin: 4px 0;">${_pendingSessionRefine.total} kcal</div>
      ${_pendingSessionRefine.changeNote ? `<div class="small" style="font-style: italic; margin-bottom: 6px;">${escapeHtml(_pendingSessionRefine.changeNote)}</div>` : ''}
      ${(_pendingSessionRefine.breakdown || []).map(b => `<div class="small" style="padding: 1px 0;">• <b>${escapeHtml(b.activity)}</b>: ${b.calories} kcal <span class="muted">— ${escapeHtml(b.reasoning || '')}</span></div>`).join('')}
      <div class="row" style="margin-top: 10px; gap: 6px;">
        <button class="primary grow" onclick="applySessionRefine()">Apply ${_pendingSessionRefine.total} kcal</button>
        <button class="ghost" onclick="_pendingSessionRefine=null;renderSessionRefineChat();">Discard</button>
      </div>
    </div>`;
  }
  div.innerHTML = html;
  div.scrollTop = div.scrollHeight;
}

async function applySessionRefine() {
  if (!_pendingSessionRefine || _refiningSessionAt == null) return;
  const idx = state.sessions.findIndex(s => s.savedAt === _refiningSessionAt);
  if (idx < 0) return;
  state.sessions[idx].caloriesBurned = _pendingSessionRefine.total;
  state.sessions[idx].burnBreakdown = _pendingSessionRefine.breakdown || [];
  state.sessions[idx].burnNotes = _pendingSessionRefine.notes || state.sessions[idx].burnNotes;
  state.sessions[idx].burnQuestions = []; // user approved — clear stale questions
  save();
  toast('Updated ✓');
  _pendingSessionRefine = null;
  renderSessionRefineChat();
  renderHistory();
}


// ---------- DAILY AUTO-GEN ----------


async function smartUpdateSummaries() {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const btn = document.getElementById('smartUpdateBtn');

  // Step 1: analyze meals/sessions missing estimates (skip template-derived meals)
  const meals = await getAllMeals();
  const mealsToAnalyze = meals.filter(m => !m.fromTemplate && (!m.calories || !(typeof m.protein === 'number' && m.protein > 0)));
  const missingSessions = (state.sessions || []).filter(s => !s.caloriesBurned);
  const totalItems = mealsToAnalyze.length + missingSessions.length;
  let done = 0;
  for (const m of mealsToAnalyze) {
    if (btn) btn.textContent = `Analyzing meals… ${++done}/${totalItems}`;
    await autoAnalyzeMeal(m.id, { silent: true });
  }
  if (mealsToAnalyze.length) { renderMeals(); renderAnalysis(); }
  for (const s of missingSessions) {
    if (btn) btn.textContent = `Analyzing sessions… ${++done}/${totalItems}`;
    await autoAnalyzeSession(s.savedAt, { silent: true });
  }
  if (missingSessions.length) renderHistory();

  // Step 2: re-generate daily summaries for days that changed
  const today = todayISO();
  const daysToCheck = [];
  for (let i = 0; i <= 14; i++) {
    const [y, m, d] = today.split('-').map(Number);
    const dt = new Date(y, m - 1, d - i);
    daysToCheck.push([dt.getFullYear(), String(dt.getMonth()+1).padStart(2,'0'), String(dt.getDate()).padStart(2,'0')].join('-'));
  }

  const notesArr = state.dailyNotes || [];
  const currentHour = new Date().getHours();
  const daysNeedingUpdate = [];
  for (const date of daysToCheck) {
    // Skip today unless it's after 21:00 — let midnight script handle the final note
    if (date === today && currentHour < 21) continue;
    const fp = await dayFingerprint(date);
    const isEmpty = fp === '§§'; // no meals, sessions, or steps
    if (isEmpty) continue;
    const existing = notesArr.find(n => n.date === date);
    if (!existing || existing.fingerprint !== fp) {
      daysNeedingUpdate.push({ date, fp });
    }
  }

  if (daysNeedingUpdate.length === 0 && totalItems === 0) {
    toast('Everything up to date ✓');
    return;
  }

  let summaryDone = 0;
  for (const { date, fp } of daysNeedingUpdate) {
    if (btn) btn.textContent = `Summaries ${++summaryDone}/${daysNeedingUpdate.length}…`;
    await runDailyAnalysis({ date, silent: true, fingerprint: fp });
  }

  if (btn) btn.textContent = 'Generate Daily Analysis';
  const total = totalItems + daysNeedingUpdate.length;
  toast(`Updated ${total} item${total !== 1 ? 's' : ''} ✓`);
  renderMeals();
  renderAnalysis();
}


let _midnightTimer = null;
function scheduleMidnightGen() {
  if (_midnightTimer) clearTimeout(_midnightTimer);
  const now = new Date();
  const target = new Date();
  target.setHours(23, 55, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1); // tomorrow
  const ms = target - now;
  _midnightTimer = setTimeout(async () => {
    if (getGeminiKey()) {
      const today = todayISO();
      const stepsToday = (state.steps || []).find(s => s.date === today);
      if (stepsToday) {
        const fp = await dayFingerprint(today);
        const existing = (state.dailyNotes || []).find(n => n.date === today);
        if (!existing || existing.fingerprint !== fp) {
          await runDailyAnalysis({ date: today, silent: true, fingerprint: fp });
        }
      }
      // Saturday night: also generate weekly analysis for the just-finished week (Sun→Sat)
      const dow = new Date().getDay();
      if (dow === 6) { // Saturday
        await maybeGenerateWeekly(weekStartFor(today));
      }
    }
    scheduleMidnightGen(); // schedule next day
  }, ms);
}

async function generateWeeklyAnalysis() {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const viewDate = analysisViewDate || todayISO();
  const weekStart = weekStartFor(viewDate);
  const fp = await weeklyFingerprint(weekStart);
  await runWeeklyAnalysis({ weekStart, fingerprint: fp });
  renderAnalysis();
}


async function callGemini(messages) {
  const ctx = await buildAIContext();
  const systemInstruction = PROMPTS.chatSystem
    .replace('{today}', ctx.today)
    .replace('{data}', JSON.stringify(ctx, null, 2));

  const contents = messages.map(m => {
    const parts = [{ text: m.text }];
    if (m.images) {
      for (const img of m.images) {
        const base64 = img.dataUrl.split(',')[1];
        parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: base64 } });
      }
    }
    return { role: m.role === 'user' ? 'user' : 'model', parts };
  });

  const reply = await geminiGenerate({ systemInstruction, contents });
  if (!reply) throw new Error('Empty reply from Gemini');
  return reply;
}

function renderAI() {
  const hasKey = !!getGeminiKey();
  document.getElementById('aiSetup').style.display = hasKey ? 'none' : 'block';
  document.getElementById('aiReady').style.display = hasKey ? 'block' : 'none';
  if (hasKey) renderAIMessages();
}

function renderAIMessages() {
  const list = document.getElementById('aiMessages');
  const history = aiHistory();
  if (history.length === 0) {
    list.innerHTML = '<div class="empty">Ask anything about your meals, workouts, progress…</div>';
    return;
  }
  list.innerHTML = history.map(m => {
    const isUser = m.role === 'user';
    const imgs = (m.images || []).map(img =>
      `<img src="${img.dataUrl}" style="max-width:160px; max-height:120px; border-radius:8px; display:block; margin-bottom:4px;">`
    ).join('');
    const textHtml = m.text && m.text !== '(image)' ? `<div style="white-space: pre-wrap;">${escapeHtml(m.text)}</div>` : '';
    return `<div style="display: flex; ${isUser ? 'justify-content: flex-end' : 'justify-content: flex-start'}; margin-bottom: 10px;">
      <div style="max-width: 85%; padding: 10px 14px; border-radius: 16px; ${isUser ? 'background: var(--accent); color: white; border-bottom-right-radius: 4px;' : 'background: var(--panel); border: 1px solid var(--line); border-bottom-left-radius: 4px;'} line-height: 1.45;">${imgs}${textHtml}</div>
    </div>`;
  }).join('');
  const last = list.lastElementChild;
  if (last) setTimeout(() => last.scrollIntoView({ behavior: 'smooth', block: 'end' }), 50);
}

let _aiAttachedImages = []; // [{dataUrl, mimeType}]
let _mealAttachedImages = [];
let _sessionAttachedImages = [];

function mealAttachFiles(input) { attachFilesTo(_mealAttachedImages, input, renderMealAttachPreview); }
function renderMealAttachPreview() { renderAttachPreview('mealAttachPreview', _mealAttachedImages, '_removeMealAttach'); }
function _removeMealAttach(i) { _mealAttachedImages.splice(i, 1); renderMealAttachPreview(); }
function sessionAttachFiles(input) { attachFilesTo(_sessionAttachedImages, input, renderSessionAttachPreview); }
function renderSessionAttachPreview() { renderAttachPreview('sessionAttachPreview', _sessionAttachedImages, '_removeSessionAttach'); }
function _removeSessionAttach(i) { _sessionAttachedImages.splice(i, 1); renderSessionAttachPreview(); }

function aiAttachFiles(input) { attachFilesTo(_aiAttachedImages, input, renderAiAttachPreview); }
function _removeAiAttach(i) { _aiAttachedImages.splice(i, 1); renderAiAttachPreview(); }
function renderAiAttachPreview() { renderAttachPreview('aiAttachPreview', _aiAttachedImages, '_removeAiAttach'); }


async function sendAIMessage() {
  const input = document.getElementById('aiInput');
  const text = input.value.trim();
  if (!text && _aiAttachedImages.length === 0) return;
  input.value = '';
  const images = _aiAttachedImages.splice(0);
  renderAiAttachPreview();
  const history = aiHistory();
  history.push({ role: 'user', text: text || '(image)', images: images.length ? images : undefined, time: Date.now() });
  saveAiHistory(history);
  renderAIMessages();

  // Show loading
  const list = document.getElementById('aiMessages');
  const loading = document.createElement('div');
  loading.id = 'aiLoading';
  loading.style.cssText = 'display: flex; margin-bottom: 10px;';
  loading.innerHTML = '<div style="padding: 10px 14px; border-radius: 16px; background: var(--panel); border: 1px solid var(--line); color: var(--muted);">Thinking…</div>';
  list.appendChild(loading);
  setTimeout(() => loading.scrollIntoView({ behavior: 'smooth', block: 'end' }), 50);

  try {
    const reply = await callGemini(history);
    history.push({ role: 'assistant', text: reply, time: Date.now() });
    saveAiHistory(history);
  } catch (e) {
    history.push({ role: 'assistant', text: '⚠ Error: ' + e.message, time: Date.now() });
    saveAiHistory(history);
  }
  renderAIMessages();
}

function askAI(prompt) {
  const el = document.getElementById('aiInput');
  el.value = prompt;
  autoResizeTA(el);
  sendAIMessage();
}

// ---------- SETTINGS / EXPORT ----------
function openSettings() {
  document.getElementById('settingsModal').classList.add('show');
  refreshSyncStatus();
  const k = document.getElementById('geminiKeyInput');
  if (k) k.value = getGeminiKey();
}
function closeSettings() { document.getElementById('settingsModal').classList.remove('show'); }

// Stable key: date + blob size. Same image bytes → same size; different
// upload/restore timestamps don't matter.

async function dedupePhotos() {
  const all = await getAllPhotos();
  if (all.length === 0) return toast('No photos to clean up');
  const seen = new Map();
  const toDelete = [];
  for (const p of all) {
    const key = _photoSizeKey(p.date, p.blob.size);
    if (seen.has(key)) {
      toDelete.push(p.id);
    } else {
      seen.set(key, p.id);
    }
  }
  if (toDelete.length === 0) return toast('No duplicates found');
  if (!confirm(`Found ${toDelete.length} duplicate photo${toDelete.length>1?'s':''} (same date + same size). Delete them?`)) return;
  for (const id of toDelete) await deletePhoto(id);
  toast(`Removed ${toDelete.length} duplicates ✓`);
  if (typeof renderPhotos === 'function') renderPhotos();
}



// ---------- SYNC (UI) ----------
// Pure sync logic lives in integrations/drive-sync.js.


function openSyncSetup() {
  const secret = ensureSecret();
  document.getElementById('webhookUrlInput').value = state.sync?.webhookUrl || '';
  document.getElementById('folderIdInput').value = state.sync?.folderId || '';
  document.getElementById('secretInput').value = secret;
  document.getElementById('appsScriptCode').value = buildAppsScript(secret);
  document.getElementById('settingsModal').classList.remove('show');
  document.getElementById('syncModal').classList.add('show');
  // Re-render code when folder id changes
  document.getElementById('folderIdInput').oninput = () => {
    state.sync = state.sync || {};
    state.sync.folderId = document.getElementById('folderIdInput').value.trim();
    save();
    document.getElementById('appsScriptCode').value = buildAppsScript(secret);
  };
}
function copySecret() {
  const v = document.getElementById('secretInput').value.trim();
  if (!v) return toast('No secret to copy');
  navigator.clipboard.writeText(v).then(
    () => toast('Secret copied ✓'),
    () => toast('Copy failed — select and copy manually')
  );
}

function showSyncQR() {
  const url = document.getElementById('webhookUrlInput').value.trim();
  const secret = document.getElementById('secretInput').value.trim();
  const folderId = document.getElementById('folderIdInput').value.trim();
  if (!url || !secret) return toast('Fill in URL and secret first');
  const cfg = btoa(JSON.stringify({ folderId, webhookUrl: url, secret }));
  const targetUrl = location.origin + location.pathname + '#sync=' + cfg;
  // Use api.qrserver.com — no JS library needed, just an <img>
  const qrSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=' + encodeURIComponent(targetUrl);
  const img = document.getElementById('syncQrImg');
  img.src = qrSrc;
  document.getElementById('syncQrUrl').textContent = targetUrl.length > 80 ? targetUrl.slice(0, 80) + '…' : targetUrl;
  document.getElementById('syncQrModal').classList.add('show');
}

function closeSyncQR() {
  document.getElementById('syncQrModal').classList.remove('show');
}

// Auto-import sync config from URL hash (#sync=…)
// Run immediately so it fires before render
setTimeout(checkSyncImportFromUrl, 100);
function closeSyncSetup() {
  document.getElementById('syncModal').classList.remove('show');
  document.getElementById('settingsModal').classList.add('show');
  refreshSyncStatus();
}
function copyScript() {
  const ta = document.getElementById('appsScriptCode');
  ta.select(); ta.setSelectionRange(0, 999999);
  navigator.clipboard.writeText(ta.value).then(
    () => toast('Code copied ✓'),
    () => { document.execCommand('copy'); toast('Code copied ✓'); }
  );
}
async function saveAndTestSync() {
  const url = document.getElementById('webhookUrlInput').value.trim();
  const secret = document.getElementById('secretInput').value.trim();
  const folderId = document.getElementById('folderIdInput').value.trim();
  if (!url || !url.includes('/macros/s/') || !url.endsWith('/exec')) {
    return toast("That URL doesn't look right");
  }
  if (!secret || secret.length < 16) {
    return toast("Secret looks too short");
  }
  state.sync = state.sync || {};
  state.sync.webhookUrl = url;
  state.sync.secret = secret;
  if (folderId) state.sync.folderId = folderId;
  save();
  toast('Testing…');
  const res = await pingSync();
  if (res.ok && res.pong) {
    toast('Connected ✓');
    refreshSyncStatus();
    closeSyncSetup();
  } else {
    toast('Connection failed: ' + (res.error || 'unknown'));
  }
}
async function testSync() {
  toast('Testing…');
  const res = await pingSync();
  toast(res.ok && res.pong ? 'Connected ✓' : ('Failed: ' + (res.error || 'unknown')));
}
function refreshSyncStatus() {
  const configured = !!state.sync?.webhookUrl;
  const el = document.getElementById('syncStatus');
  const testBtn = document.getElementById('syncTestBtn');
  const cloudBtn = document.getElementById('cloudBackupBtn');
  const cloudHint = document.getElementById('cloudBackupHint');
  const fullHint = document.getElementById('fullBackupHint');
  if (el) el.innerHTML = configured ? '<span style="color: var(--accent2);">✓ Configured</span>' : 'Not configured';
  if (testBtn) testBtn.disabled = !configured;
  const pullBtn = document.getElementById('syncPullBtn');
  if (pullBtn) pullBtn.disabled = !configured;
  if (cloudBtn) {
    cloudBtn.disabled = !configured;
    cloudBtn.style.opacity = configured ? '1' : '0.5';
  }
  if (cloudHint) {
    cloudHint.textContent = configured
      ? 'Sessions + waist. Auto-uploads to your Drive Fit folder.'
      : 'Set up Drive sync below to enable.';
  }
  if (fullHint) {
    fullHint.textContent = configured
      ? 'Includes photos. Uploads to Drive.'
      : 'Includes photos. Downloads locally (set up Drive sync to upload).';
  }
}
async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('Replace all current data with this backup?')) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    state.sessions = data.sessions || [];
    state.measurements = data.measurements || [];
    state.current = data.current || null;
    state.steps = data.steps || [];
    state.dailyNotes = data.dailyNotes || [];
    save();
    if (data.photos?.length) {
      await clearPhotos();
      for (const p of data.photos) {
        const blob = await (await fetch(p.dataUrl)).blob();
        await putPhoto(blob, p.date);
      }
    }
    if (data.meals?.length) {
      await clearMeals();
      for (const m of data.meals) {
        let blobs = [];
        if (Array.isArray(m.dataUrls) && m.dataUrls.length) {
          blobs = await Promise.all(m.dataUrls.map(async u => (await fetch(u)).blob()));
        } else if (m.dataUrl) {
          blobs = [await (await fetch(m.dataUrl)).blob()];
        }
        await putMeal({ date: m.date, time: m.time, description: m.description, calories: m.calories, blobs });
      }
    }
    if (data.sync) state.sync = data.sync;
    save();
    e.target.value = '';
    closeSettings();
    toast('Imported ✓');
    selectDay(currentDay);
    renderBody();
    renderPhotos();
    renderMeals();
  } catch (err) {
    toast('Import failed');
  }
}
async function wipeAll() {
  state.sessions = []; state.measurements = []; state.current = null; state.steps = [];
  save();
  await clearPhotos();
  await clearMeals();
  selectedForCompare = [];
  closeSettings();
  selectDay(currentDay);
  renderBody();
  renderPhotos();
  renderMeals();
  toast('All data erased');
}

// ---------- UTIL ----------

// ---------- INIT ----------

function updateSessionDate(value) {
  if (!value) return;
  if (state.current) {
    state.current.date = value;
    save();
  }
}

function updateSessionTime(value) {
  if (state.current) {
    state.current.time = value;
    save();
  }
}

function openPlanModal() {
  const todayKey = ['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()];
  const list = document.getElementById('planList');
  list.innerHTML = WEEKLY_PLAN.map(d => `
    <div class="card" style="padding: 10px; background: var(--panel2); margin-bottom: 6px; ${d.key === todayKey ? 'border-color: var(--accent);' : ''}">
      <div class="row between">
        <div>
          <div style="font-weight: 600; ${d.rest ? 'color: var(--muted);' : ''}">
            ${d.day}${d.key === todayKey ? ' <span style="color: var(--accent); font-size: 12px; margin-left: 6px;">TODAY</span>' : ''}
          </div>
          <div class="small ${d.rest ? 'muted' : ''}" style="margin-top: 2px;">${d.plan}</div>
        </div>
      </div>
    </div>
  `).join('');
  document.getElementById('planModal').classList.add('show');
}
function closePlanModal() {
  document.getElementById('planModal').classList.remove('show');
}
document.getElementById('todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
selectDay(state.current?.day || suggestedDay());

// ─── Google Fit Integration ───────────────────────────────────────────────
// Load any cached token on startup so silentSync works before the user taps Sync.
loadCachedGfitToken();




async function syncGoogleFit() {
  const btn = document.getElementById('fitSyncBtn');
  const status = document.getElementById('fitSyncStatus');
  const date = workoutCurrentDate();

  btn.disabled = true;
  btn.textContent = '…';
  status.style.display = 'block';
  status.textContent = 'Connecting to Google Fit…';

  try {
    const token = await gfitGetToken();
    const { startMs, endMs } = gfitDateRange(date);
    status.textContent = 'Fetching data…';

    const [stepsData, distData] = await Promise.all([
      gfitAggregate(token, startMs, endMs, 'com.google.step_count.delta'),
      gfitAggregate(token, startMs, endMs, 'com.google.distance.delta')
    ]);

    const steps = gfitExtractInt(stepsData);
    const distM = gfitExtractFloat(distData);
    const distKm = Math.round(distM / 100) / 10;

    // Save steps
    if (steps > 0) {
      state.steps = state.steps || [];
      state.steps = state.steps.filter(s => s.date !== date);
      state.steps.push({ date, count: steps, source: 'gfit' });
      save();
    }

    // Update UI
    const stepsInput = document.getElementById('workoutStepsInput');
    if (stepsInput && steps > 0) stepsInput.value = steps;
    renderWorkout();
    renderBody();

    // Build status message
    let msg = steps > 0 ? `${steps.toLocaleString()} steps` : 'No steps data';
    if (distKm > 0) msg += ` · ${distKm} km walked/run`;
    status.textContent = `✓ Synced: ${msg}`;

    // If there's an active session and distance suggests cardio, offer to add to note
    if (distKm >= 1 && state.current?.date === date) {
      const cardioInput = document.getElementById('cardioNoteInput');
      if (cardioInput && !cardioInput.value.trim()) {
        cardioInput.value = `${distKm} km`;
        status.textContent += ' — distance added to cardio note';
      }
    }

    toast(`✓ ${steps.toLocaleString()} steps${distKm > 0 ? ` · ${distKm} km` : ''}`);
  } catch (e) {
    console.error('Google Fit sync error:', e);
    status.textContent = e.message.includes('popup') ? 'Popup blocked — allow popups for this site' : `Error: ${e.message}`;
    toast('Google Fit sync failed', 3000);
  } finally {
    btn.disabled = false;
    btn.textContent = '🏃 Sync';
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Silent Google Fit sync — today + missing days in last 7 (no popup; quiet if no token)

// Auto-pull from Drive on startup, then silent Fit sync, then auto-gen summaries
if (state.sync?.webhookUrl) {
  setTimeout(async () => {
    // If local looks empty (browser data wiped or fresh device), bypass the
    // timestamp guard so we always restore the latest Drive backup.
    const looksEmpty = (state.sessions || []).length === 0
      && (state.measurements || []).length === 0
      && (state.steps || []).length === 0;
    if (looksEmpty) {
      toast('Restoring from Drive…', { persistent: true });
      try {
        const r = await pullFromDriveForce();
        hideToast();
        if (r.ok) toast('Restored from Drive ✓');
      } catch (e) {
        hideToast();
        toast('Drive restore failed: ' + e.message);
      }
    } else {
      const r = await pullFromDrive({ silent: true });
      if (r.applied) toast('Auto-synced from Drive ✓');
    }
    const fitUpdated = await autoSilentFitSync();
    if (fitUpdated.length) { renderWorkout?.(); renderBody?.(); renderAnalysis?.(); }
    autoGenerateMissingSummaries();
  }, 1500);
} else {
  setTimeout(async () => {
    const fitUpdated = await autoSilentFitSync();
    if (fitUpdated.length) { renderWorkout?.(); renderBody?.(); renderAnalysis?.(); }
    autoGenerateMissingSummaries();
  }, 1500);
}

// Initial render — ensure all main sections populate from existing local state
// (Drive pull happens async at 1.5s and will re-render when it lands)
function _initialRender() {
  try { if (typeof renderAnalysis === 'function') renderAnalysis(); } catch {}
  try { if (typeof renderWorkout === 'function') { selectDay(currentDay); } } catch {}
  try { if (typeof renderMeals === 'function') renderMeals(); } catch {}
  try { if (typeof renderBody === 'function') renderBody(); } catch {}
}
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  _initialRender();
} else {
  document.addEventListener('DOMContentLoaded', _initialRender);
}

// Schedule daily 23:55 generation
scheduleMidnightGen();

// Auto-pull + auto-gen when user returns to the tab
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (state.sync?.webhookUrl) {
      pullFromDrive({ silent: true }).then(async r => {
        if (r.applied) toast('Auto-synced ✓');
        const u = await autoSilentFitSync();
        if (u.length) { renderWorkout?.(); renderBody?.(); renderAnalysis?.(); }
        autoGenerateMissingSummaries();
      });
    } else {
      autoSilentFitSync().then(u => {
        if (u.length) { renderWorkout?.(); renderBody?.(); renderAnalysis?.(); }
        autoGenerateMissingSummaries();
      });
    }
  }
});

// ---------- LEGACY: expose HTML onclick targets on window ----------
// Inline `onclick="foo()"` handlers in index.html can only see globals, but this
// file is loaded as `<script type="module">` so top-level names are NOT global.
// Bridge them onto `window` until handlers migrate to addEventListener (Step 19).
Object.assign(window, {
  addCardioActivity, addCustomExerciseText, addPlanExercise, addWaist,
  aiAttachFiles, analyzePhotoComparison, applyRefineResult, applySessionRefine,
  askAI, attachTimerTo, autoResizeTA, bumpReps, cancelSession,
  closeCardioPicker, closeExercisePicker, closeHeatmap, closeMealModal,
  closePlanModal, closeSessionRefine, closeSet, closeSettings, closeSyncQR,
  closeSyncSetup, closeTemplateEdit, closeTemplatePicker, closeTimerAttach,
  confirmDeleteTemplate, confirmSet, copyScript, copySecret, dedupePhotos,
  _removeAiAttach, _removeMealAttach, _removeSessionAttach,
  deleteCompareAnalysis, deleteSession, editSession, editStepsEntry, editWaist,
  exportData, finishSession, finishWorkoutTimer, generateWeeklyAnalysis,
  importData, loadWorkoutPlan, mealAttachFiles, onMealPhotoSelected,
  onPhotoPicked, openCardioPicker, openMealModal, openPlanModal,
  openSessionRefine, openSet, openSettings, openSyncSetup, openTemplateEdit,
  openTemplatePicker, pickExercise, pullFromDrive, quickSaveMealAsTemplate,
  reanalyzeMeal, reanalyzeMealInPlace, refineMealEstimate, refineSessionEstimate,
  removeCardio, removeCardioActivity, removeExercise, removeMeal,
  removePendingMealPhoto, removePhoto, removeSet, removeSteps, removeWaist,
  renderAiAttachPreview, renderCompareByDate, renderExerciseList,
  renderMealRefineChat, renderSessionRefineChat, requestMealEstimateUpdate,
  requestSessionEstimateUpdate, resetWorkoutTimer, restorePhotosFromDrive,
  saveAndTestSync, saveCurrentMealAsTemplate, saveGeminiKey, saveMeal,
  saveTemplateEdit, saveWorkoutSteps, sendAIMessage, sessionAttachFiles,
  setAnalysisMode, setSessionTime, setTrendMode, shiftAnalysisDate,
  shiftWorkoutDate, showSyncQR, smartUpdateSummaries, startWorkout,
  startWorkoutTimer, switchTab, syncGoogleFit, testSync, toggleStepsEdit,
  toggleWaistEdit, updateCardioField, updateExerciseNote, updateSessionDate,
  updateSessionTime, useTemplate, wipeAll,
});
