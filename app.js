// ---------- IMPORTS (core/) ----------
import { _isoDate, todayISO, formatDate } from './core/time.js';
import { escapeHtml, blobToDataUrl, parseJSONResponse } from './core/format.js';
import { autoResizeTA, toast, hideToast } from './core/dom.js';
import { DEFAULT_PROFILE, calcBMR, calcStepsPerKcal } from './core/profile.js';
import { state, save, load } from './data/state.js';
import { putPhoto, getAllPhotos, deletePhoto, clearPhotos } from './data/photo-store.js';
import { putMeal, getAllMeals, clearMeals } from './data/meals-store.js';
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
import { EXERCISE_LIBRARY } from './domain/exercises.js';
import { CARDIO_TYPES, formatCardioActivitiesForAI } from './domain/cardio.js';
import { MUSCLE_MAP, computeMuscleHeatmap, renderMuscleHeatmapSvg } from './domain/muscle-map.js';
import { autoAnalyzeMeal } from './domain/meals.js';
import { isCurrentFresh, autoAnalyzeSession } from './domain/workouts.js';
import { upsertStep, removeStep } from './domain/steps.js';
import { upsertMeasurement, removeMeasurement } from './domain/body.js';
import { computeDailyEnergy, weekStartFor, weekDates, yesterdayISO, dayFingerprint, weeklyFingerprint, runDailyAnalysis, runWeeklyAnalysis, maybeGenerateWeekly, autoGenerateMissingSummaries } from './domain/analysis.js';
import { drawChart, drawStepsChart } from './ui/shared/chart.js';
import { attachFilesTo, renderAttachPreview } from './ui/shared/chat-input.js';
import { openHeatmap, closeHeatmap } from './ui/shared/heatmap.js';
import { downscale } from './ui/shared/image.js';
import {
  openMealModal, closeMealModal, saveMeal, renderMeals, removeMeal,
  quickSaveMealAsTemplate, saveCurrentMealAsTemplate,
  openTemplatePicker, closeTemplatePicker, confirmDeleteTemplate, openTemplateEdit, closeTemplateEdit, saveTemplateEdit, useTemplate,
  removePendingMealPhoto, onMealPhotoSelected,
  reanalyzeMeal, reanalyzeMealInPlace,
  refineMealEstimate, requestMealEstimateUpdate, renderMealRefineChat, applyRefineResult, discardMealRefine,
  mealAttachFiles, renderMealAttachPreview, _removeMealAttach,
} from './ui/meals-tab.js';
import {
  selectDay, getCurrentDay, renderWorkout, renderHistory, workoutCurrentDate,
  shiftWorkoutDate, loadWorkoutPlan, startWorkout,
  startWorkoutTimer, finishWorkoutTimer, openTimerAttachPicker, closeTimerAttach, attachTimerTo, resetWorkoutTimer,
  openSet, closeSet, bumpReps, confirmSet, removeSet, removeExercise, updateExerciseNote,
  removeCardio, openCardioPicker, closeCardioPicker, addCardioActivity, removeCardioActivity, updateCardioField,
  renderExerciseList, addPlanExercise, addCustomExercise, closeExercisePicker, pickExercise, addCustomExerciseText,
  finishSession, cancelSession, editSession, setSessionTime, deleteSession, updateSessionDate, updateSessionTime,
  openSessionRefine, closeSessionRefine, refineSessionEstimate, requestSessionEstimateUpdate, applySessionRefine, discardSessionRefine, renderSessionRefineChat,
  sessionAttachFiles, renderSessionAttachPreview, _removeSessionAttach,
  openPlanModal, closePlanModal,
} from './ui/workout-tab.js';

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
let analysisViewDate = null; // null = today

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
    selectDay();
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
  selectDay();
  renderBody();
  renderPhotos();
  renderMeals();
  toast('All data erased');
}

// ---------- UTIL ----------

// ---------- INIT ----------

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
  try { if (typeof renderWorkout === 'function') { selectDay(); } } catch {}
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
  deleteCompareAnalysis, deleteSession, discardMealRefine, discardSessionRefine, editSession, editStepsEntry, editWaist,
  exportData, finishSession, finishWorkoutTimer, generateWeeklyAnalysis,
  importData, loadWorkoutPlan, mealAttachFiles, onMealPhotoSelected,
  onPhotoPicked, openCardioPicker, openMealModal, openPlanModal,
  openSessionRefine, openSet, openSettings, openSyncSetup, openTemplateEdit,
  openTemplatePicker, pickExercise, pullFromDrive, quickSaveMealAsTemplate,
  reanalyzeMeal, reanalyzeMealInPlace, refineMealEstimate, refineSessionEstimate,
  removeCardio, removeCardioActivity, removeExercise, removeMeal,
  removePendingMealPhoto, removePhoto, removeSet, removeSteps, removeWaist,
  renderAiAttachPreview, renderAnalysis, renderCompareByDate, renderExerciseList,
  renderMeals, renderMealRefineChat, renderSessionRefineChat, requestMealEstimateUpdate,
  requestSessionEstimateUpdate, resetWorkoutTimer, restorePhotosFromDrive,
  saveAndTestSync, saveCurrentMealAsTemplate, saveGeminiKey, saveMeal,
  saveTemplateEdit, saveWorkoutSteps, sendAIMessage, sessionAttachFiles,
  setAnalysisMode, setSessionTime, setTrendMode, shiftAnalysisDate,
  shiftWorkoutDate, showSyncQR, smartUpdateSummaries, startWorkout,
  startWorkoutTimer, switchTab, syncGoogleFit, testSync, toggleStepsEdit,
  toggleWaistEdit, updateCardioField, updateExerciseNote, updateSessionDate,
  updateSessionTime, useTemplate, wipeAll,
});
