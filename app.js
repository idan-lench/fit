// ---------- IMPORTS (core/) ----------
import { todayISO, formatDate } from './core/time.js';
import { escapeHtml, blobToDataUrl, parseJSONResponse } from './core/format.js';
import { autoResizeTA, toast, hideToast } from './core/dom.js';
import { DEFAULT_PROFILE, calcBMR, calcStepsPerKcal } from './core/profile.js';
import { state, save, load } from './data/state.js';
import { putPhoto, clearPhotos } from './data/photo-store.js';
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
  pingSync, uploadToDrive,
} from './integrations/drive-sync.js';
import { PLAN, WEEKLY_PLAN, getPlanKeyForDate, suggestedDay } from './domain/plan.js';
import { EXERCISE_LIBRARY } from './domain/exercises.js';
import { CARDIO_TYPES, formatCardioActivitiesForAI } from './domain/cardio.js';
import { MUSCLE_MAP, computeMuscleHeatmap, renderMuscleHeatmapSvg } from './domain/muscle-map.js';
import { autoAnalyzeMeal } from './domain/meals.js';
import { isCurrentFresh, autoAnalyzeSession } from './domain/workouts.js';
import { weekStartFor, dayFingerprint, runDailyAnalysis, maybeGenerateWeekly, autoGenerateMissingSummaries } from './domain/analysis.js';
import { attachFilesTo, renderAttachPreview } from './ui/shared/chat-input.js';
import { openHeatmap, closeHeatmap } from './ui/shared/heatmap.js';
import { renderAnalysis, setTrendMode, setAnalysisMode, shiftAnalysisDate, generateWeeklyAnalysis } from './ui/insights-tab.js';
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
