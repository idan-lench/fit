// ---------- IMPORTS (core/) ----------
import { todayISO } from './core/time.js';
import { autoResizeTA, toast, hideToast } from './core/dom.js';
import { DEFAULT_PROFILE, calcBMR, calcStepsPerKcal } from './core/profile.js';
import { state, save, load } from './data/state.js';
import { getAllMeals } from './data/meals-store.js';
import { getGeminiKey } from './integrations/gemini.js';
import { loadCachedGfitToken, autoSilentFitSync } from './integrations/google-fit.js';
import {
  pullFromDrive, pullFromDriveForce, exportData,
  restorePhotosFromDrive, checkSyncImportFromUrl,
} from './integrations/drive-sync.js';
import { PLAN, WEEKLY_PLAN, getPlanKeyForDate, suggestedDay } from './domain/plan.js';
import { EXERCISE_LIBRARY } from './domain/exercises.js';
import { CARDIO_TYPES, formatCardioActivitiesForAI } from './domain/cardio.js';
import { MUSCLE_MAP, computeMuscleHeatmap, renderMuscleHeatmapSvg } from './domain/muscle-map.js';
import { autoAnalyzeMeal } from './domain/meals.js';
import { isCurrentFresh, autoAnalyzeSession } from './domain/workouts.js';
import { weekStartFor, dayFingerprint, runDailyAnalysis, maybeGenerateWeekly, autoGenerateMissingSummaries } from './domain/analysis.js';
import { openHeatmap, closeHeatmap } from './ui/shared/heatmap.js';
import { renderAnalysis, setTrendMode, setAnalysisMode, shiftAnalysisDate, generateWeeklyAnalysis } from './ui/insights-tab.js';
import { saveGeminiKey, renderAI, aiAttachFiles, _removeAiAttach, renderAiAttachPreview, sendAIMessage, askAI } from './ui/chat-tab.js';
import {
  openSettings, closeSettings, openSyncSetup, closeSyncSetup, closeSyncQR, showSyncQR,
  copySecret, copyScript, saveAndTestSync, testSync, importData, wipeAll, syncGoogleFit,
} from './ui/settings.js';
import {
  renderBody, renderSteps, renderPhotos, renderCompareByDate,
  saveWorkoutSteps, removeSteps, editStepsEntry, toggleStepsEdit,
  toggleWaistEdit, addWaist, removeWaist, editWaist,
  onPhotoPicked, analyzePhotoComparison, deleteCompareAnalysis, removePhoto, dedupePhotos,
} from './ui/body-tab.js';
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



// ---------- UTIL ----------

// ---------- INIT ----------

// Auto-import sync config from URL hash (#sync=…) — run before first render.
setTimeout(checkSyncImportFromUrl, 100);

document.getElementById('todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
selectDay(state.current?.day || suggestedDay());

// ─── Google Fit Integration ───────────────────────────────────────────────
// Load any cached token on startup so silentSync works before the user taps Sync.
loadCachedGfitToken();





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
  renderAiAttachPreview, renderAnalysis, renderCompareByDate, renderExerciseList, renderSteps,
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
