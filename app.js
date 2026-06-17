// ---------- IMPORTS (core/) ----------
import { todayISO } from './core/time.js';
import { autoResizeTA, toast, hideToast } from './core/dom.js';
import { DEFAULT_PROFILE, calcBMR, calcStepsPerKcal } from './core/profile.js';
import { state, save, load } from './data/state.js';
import { getDailyNote, upsertDailyNote } from './data/daily-notes-store.js';
import { getAllMeals } from './data/meals-store.js';
import { getGeminiKey } from './integrations/gemini.js';
import { loadCachedGfitToken } from './integrations/google-fit.js';
import {
  pullFromDrive, pullFromDriveForce, exportData, pullFitStepsFromServer,
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
import { _setup } from './ui/bindings.js';
import { renderAnalysis, setTrendMode, setAnalysisMode, shiftAnalysisDate, generateWeeklyAnalysis } from './ui/insights-tab.js';
import { saveGeminiKey, renderAI, aiAttachFiles, _removeAiAttach, sendAIMessage, askAI } from './ui/chat-tab.js';
import {
  openSettings, closeSettings, openSyncSetup, closeSyncSetup, closeSyncQR, showSyncQR,
  copySecret, copyScript, saveAndTestSync, testSync, importData, wipeAll, syncGoogleFit, fullBackup,
} from './ui/settings.js';
import {
  renderBody, renderSteps, renderPhotos,
  saveWorkoutSteps, removeSteps, editStepsEntry, toggleStepsEdit,
  toggleWaistEdit, addWaist, removeWaist, editWaist,
  addWeight, toggleWeightEdit, removeWeightEntry, editWeight, renderWeight,
  onPhotoPicked, analyzePhotoComparison, deleteCompareAnalysis, removePhoto, dedupePhotos,
} from './ui/body-tab.js';
import {
  openMealModal, closeMealModal, saveMeal, renderMeals, removeMeal,
  quickSaveMealAsTemplate, saveCurrentMealAsTemplate,
  openTemplatePicker, closeTemplatePicker, confirmDeleteTemplate, openTemplateEdit, closeTemplateEdit, saveTemplateEdit, useTemplate,
  removePendingMealPhoto, onMealPhotoSelected,
  reanalyzeMeal, reanalyzeMealInPlace,
  refineMealEstimate, requestMealEstimateUpdate, applyRefineResult, discardMealRefine,
  mealAttachFiles, renderMealAttachPreview, _removeMealAttach,
} from './ui/meals-tab.js';
import {
  selectDay, getCurrentDay, renderWorkout, renderHistory, workoutCurrentDate,
  shiftWorkoutDate, loadWorkoutPlan, startWorkout, addCardioPlan,
  closeTimerAttach, attachTimerTo, detachTimerFrom, attachTimerToAll,
  pauseTimer, resumeTimer, stopTimer, discardTimer, attachTimer,
  clearExerciseDuration, clearCardioDuration, useTimerForDuration, clearIntervalSegments, onDurationInput, setSwimLevel, openSwimLevelModal,
  openSet, editSet, closeSet, bumpReps, confirmSet, deleteCurrentSet, removeSet, removeExercise, updateExerciseNote, openExercisePhotoAnalyze,
  removeCardio, openCardioPicker, closeCardioPicker, addCardioActivity, removeCardioActivity, updateCardioField,
  renderExerciseList, addPlanExercise, dismissPlanExercise, clearAllPlanExercises, addCustomExercise, closeExercisePicker, pickExercise, addCustomExerciseText,
  openCardioPhotoAnalyze, openCardioImageAttach, removeCardioImage,
  finishSession, cancelSession, editSession, setSessionTime, deleteSession, reanalyzeSession, updateSessionDate, updateSessionTime,
  openSessionRefine, closeSessionRefine, refineSessionEstimate, requestSessionEstimateUpdate, applySessionRefine, discardSessionRefine,
  sessionAttachFiles, renderSessionAttachPreview, _removeSessionAttach,
  openPlanModal, closePlanModal, refreshFitSyncLabels,
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

// One-time migration: move dailyNotes out of localStorage into IndexedDB.
// Runs silently on first boot after this update; no-op on subsequent boots.
if (Array.isArray(state.dailyNotes) && state.dailyNotes.length > 0) {
  Promise.all(state.dailyNotes.map(n => upsertDailyNote(n))).then(() => {
    delete state.dailyNotes;
    save();
  });
}


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
  // Remember the last tab + when, so reopening can restore it (see restoreLastTab)
  state.lastTab = name;
  state.lastTabAt = Date.now();
  save();
}

// On boot, resume the last tab if it's still "fresh" — same calendar day and
// within 4 hours. Otherwise (morning, long gap, or first run) open Insights so
// you land on your summary rather than a stale view.
function restoreLastTab() {
  const VALID = ['workout', 'meals', 'analysis', 'body', 'ai'];
  const tab = state.lastTab;
  const at = state.lastTabAt || 0;
  const fresh = VALID.includes(tab) && at
    && (Date.now() - at) < 4 * 60 * 60 * 1000
    && new Date(at).toDateString() === new Date().toDateString();
  switchTab(fresh ? tab : 'analysis');
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

  const currentHour = new Date().getHours();
  const daysNeedingUpdate = [];
  for (const date of daysToCheck) {
    // Skip today unless it's after 21:00 — let midnight script handle the final note
    if (date === today && currentHour < 21) continue;
    const fp = await dayFingerprint(date);
    const isEmpty = fp === '§§'; // no meals, sessions, or steps
    if (isEmpty) continue;
    const existing = await getDailyNote(date);
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
        const existing = await getDailyNote(today);
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





// Single auto step-sync path: pull server-side Fit steps (fetched hourly by the
// Apps Script) and re-render if anything changed. Replaces the old GIS silent
// sync, which browsers block once the ~1h token expires. The manual 🏃 Sync
// (interactive OAuth) stays as the on-demand fallback.
async function autoFitSync() {
  const r = await pullFitStepsFromServer();
  if (r?.ok && r.updated) { renderWorkout?.(); renderBody?.(); renderAnalysis?.(); }
  refreshFitSyncLabels();
}

// Auto-pull from Drive on startup, then Fit step sync, then auto-gen summaries.
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
    await autoFitSync();
    autoGenerateMissingSummaries();
  }, 1500);
} else {
  setTimeout(autoGenerateMissingSummaries, 1500);
}

// Initial render — ensure all main sections populate from existing local state
// (Drive pull happens async at 1.5s and will re-render when it lands)
function _initialRender() {
  try { if (typeof renderAnalysis === 'function') renderAnalysis(); } catch {}
  try { if (typeof renderWorkout === 'function') { selectDay(); } } catch {}
  try { if (typeof renderMeals === 'function') renderMeals(); } catch {}
  try { if (typeof renderBody === 'function') renderBody(); } catch {}
  try { restoreLastTab(); } catch {}
}
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  _initialRender();
} else {
  document.addEventListener('DOMContentLoaded', _initialRender);
}

// Schedule daily 23:55 generation
scheduleMidnightGen();

// Auto-pull + auto-gen when user returns to the tab.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  if (state.sync?.webhookUrl) {
    const r = await pullFromDrive({ silent: true });
    if (r.applied) toast('Auto-synced ✓');
  }
  await autoFitSync();
  autoGenerateMissingSummaries();
});

// Periodic Fit step sync every 30 min while the tab is open. Skips when the tab
// is hidden (the visibilitychange handler above already syncs on return).
const FIT_SYNC_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => { if (!document.hidden) autoFitSync(); }, FIT_SYNC_INTERVAL_MS);

// Tick the "synced Xm ago" labels every minute so the relative time stays
// current between syncs (otherwise "just now" would never advance).
setInterval(() => { if (!document.hidden) refreshFitSyncLabels(); }, 60 * 1000);

// ---------- window bridge for dynamic handlers ----------
// Functions called from innerHTML onClick strings in render functions (workout/meals/body tabs)
// or cross-module window.X?.() calls cannot use direct imports — they need to be on window.
// Static index.html handlers are wired by ui/bindings.js and do NOT appear here.
Object.assign(window, {
  // Dynamic innerHTML handlers (workout-tab.js render functions)
  addCardioActivity, addCardioPlan, addPlanExercise, dismissPlanExercise, clearAllPlanExercises, openCardioPhotoAnalyze, openCardioImageAttach, removeCardioImage, applySessionRefine,
  attachTimerTo, detachTimerFrom, attachTimerToAll, attachTimer, pauseTimer, resumeTimer, stopTimer, discardTimer,
  clearExerciseDuration, clearCardioDuration, useTimerForDuration, clearIntervalSegments, onDurationInput, setSwimLevel, openSwimLevelModal, autoResizeTA,
  deleteSession, reanalyzeSession, discardSessionRefine,
  editSession, editStepsEntry, editWaist,
  openSet, editSet, deleteCurrentSet, openSessionRefine, openTemplateEdit,
  pickExercise,
  openExercisePhotoAnalyze, removeCardio, removeCardioActivity, removeExercise, removeSet,
  removeSteps, removeWaist, setSessionTime,
  syncGoogleFit, updateCardioField, updateExerciseNote,

  // Dynamic innerHTML handlers (meals-tab.js render functions)
  applyRefineResult, confirmDeleteTemplate, discardMealRefine,
  openMealModal, openTemplatePicker,
  quickSaveMealAsTemplate, reanalyzeMealInPlace,
  removeMeal, removePendingMealPhoto,
  useTemplate,

  // Dynamic innerHTML handlers (body-tab.js render functions)
  deleteCompareAnalysis, removePhoto, editWeight, removeWeightEntry,

  // Dynamic innerHTML handlers (chat-input.js)
  _removeAiAttach, _removeMealAttach, _removeSessionAttach,

  // Cross-module window.X?.() calls (avoid circular imports)
  renderAnalysis, renderSteps, switchTab, smartUpdateSummaries,
});
