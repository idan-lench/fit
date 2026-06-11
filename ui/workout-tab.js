import { state, save } from '../data/state.js';
import { todayISO, formatDate } from '../core/time.js';
import { escapeHtml, blobToDataUrl, parseJSONResponse } from '../core/format.js';
import { toast, hideToast, autoResizeTA } from '../core/dom.js';
import { PLAN, WEEKLY_PLAN, getPlanKeyForDate } from '../domain/plan.js';
import { EXERCISE_LIBRARY, lastSetsFor } from '../domain/exercises.js';
import { CARDIO_TYPES, formatCardioActivitiesForAI } from '../domain/cardio.js';
import { renderMuscleHeatmapSvg } from '../domain/muscle-map.js';
import { isCurrentFresh, autoAnalyzeSession, updateWorkoutHistory, buildWorkoutHistoryContext } from '../domain/workouts.js';
import { runTrainer } from '../agents/trainer.js';
import { getGeminiKey, geminiGenerate } from '../integrations/gemini.js';
import { downscale } from './shared/image.js';
import { openHeatmap } from './shared/heatmap.js';
import { attachFilesTo, renderAttachPreview } from './shared/chat-input.js';
import { PROMPTS } from '../prompts/index.js';

// ---------- MODULE STATE ----------
let currentDay = 'tue';
let workoutViewDate = null; // null = today
let currentSetCtx = null;
let currentReps = 8;
let _timerInterval = null;
let _attachingTimerId = null;
let _pendingSessionRefine = null;
let _refiningSessionAt = null;
let _sessionChatHistory = [];
let _cardioPhotoIdx = null; // null = idle, 'note' = main cardio note, number = activity index
let _sessionAttachedImages = [];
let _cardioImages = {}; // { [activityId]: [{dataUrl, mimeType}] } — attached, analyzed on save (not persisted)
let _cachedHistoryContext = null;

// Ensure a cardio activity has a stable id for keying its attached images.
function _cardioId(a) {
  if (!a.id) a.id = 'c' + Date.now() + Math.random().toString(36).slice(2, 7);
  return a.id;
}

export const getCurrentDay = () => currentDay;

export function updateEffortDisplay() {
  const slider = document.getElementById('effortInput');
  if (!slider) return;
  const pos = parseInt(slider.value, 10);
  const activeIdx = Math.floor((pos - 1) / 2);
  const emojiRow = document.getElementById('effortEmojiRow');
  if (!emojiRow) return;
  [...emojiRow.children].forEach((el, i) => {
    el.style.opacity = i === activeIdx ? '1' : '0.4';
    el.style.transform = i === activeIdx ? 'scale(1.25)' : 'scale(1)';
    el.style.transition = 'opacity 0.15s, transform 0.15s';
  });
}

// ---------- DATE HELPERS ----------
export function workoutCurrentDate() {
  return workoutViewDate || todayISO();
}

export function shiftWorkoutDate(delta) {
  const [y, m, d] = workoutCurrentDate().split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  const shifted = [dt.getFullYear(), String(dt.getMonth()+1).padStart(2,'0'), String(dt.getDate()).padStart(2,'0')].join('-');
  workoutViewDate = shifted === todayISO() ? null : shifted;
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

// ---------- DAY SELECTION ----------
export function selectDay(day = currentDay) {
  const safeKey = PLAN[day] ? day : 'custom';
  currentDay = safeKey;
  document.querySelectorAll('[data-day]').forEach(c => c.classList.toggle('on', c.dataset.day === safeKey));
  if (!state.current && PLAN[safeKey]) {
    // Don't auto-create — let the user tap Add workout / Load plan
  } else if (state.current && state.current.day !== safeKey && PLAN[safeKey]) {
    state.current = { day: safeKey, date: workoutCurrentDate(), cardio: PLAN[safeKey].cardio, entries: [] };
  }
  renderWorkout();
}

// ---------- PLAN & SESSION INIT ----------
export function loadWorkoutPlan() {
  const date = workoutCurrentDate();
  const planKey = getPlanKeyForDate(date);
  if (!planKey) return;
  startWorkout(planKey);
}

export function startWorkout(dayKey) {
  const date = workoutCurrentDate();
  const safeKey = PLAN[dayKey] ? dayKey : 'custom';
  currentDay = safeKey;
  state.current = { day: safeKey, date, cardio: PLAN[safeKey].cardio, entries: [] };
  save();
  renderWorkout();
}

// ---------- TIMER ----------
// ---------- MULTI-TIMER HELPERS ----------

function _timerElapsedMs(t) {
  const paused = t.pausedAt ? (Date.now() - new Date(t.pausedAt).getTime()) : 0;
  const end = t.stoppedAt ? new Date(t.stoppedAt).getTime() : Date.now();
  return end - new Date(t.startedAt).getTime() - (t.pausedMs || 0) - paused;
}

function _fmtTimer(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}

function _tickTimers() {
  for (const t of (state.current?.timers || [])) {
    if (t.stoppedAt || t.pausedAt) continue;
    const el = document.getElementById(`td_${t.id}`);
    if (el) el.textContent = _fmtTimer(_timerElapsedMs(t));
  }
}

function renderTimers() {
  const timers = state.current?.timers || [];
  const container = document.getElementById('timersContainer');
  if (!container) return;
  container.innerHTML = timers.map((t, i) => {
    const sep = i < timers.length - 1 ? 'border-bottom:1px solid var(--line);' : '';
    if (t.stoppedAt) {
      const display = _fmtTimer(_timerElapsedMs(t));
      return `<div class="row between" style="align-items:center; padding:8px 0; ${sep}">
        <div><div class="muted small">Stopped</div><div style="font-size:20px; font-weight:700; font-variant-numeric:tabular-nums;">${display}</div></div>
        <div class="row" style="gap:6px;">
          <button class="ghost" style="padding:6px 12px;" onclick="discardTimer(${t.id})">Discard</button>
          <button class="primary" style="padding:6px 14px;" onclick="attachTimer(${t.id})">Attach</button>
        </div>
      </div>`;
    }
    const isPaused = !!t.pausedAt;
    const btns = isPaused
      ? `<button class="ghost" style="padding:6px 12px;" onclick="resumeTimer(${t.id})">Resume</button>
         <button class="primary" style="padding:6px 14px;" onclick="stopTimer(${t.id})">Stop</button>`
      : `<button class="ghost" style="padding:6px 12px;" onclick="pauseTimer(${t.id})">Pause</button>
         <button class="primary" style="padding:6px 14px;" onclick="stopTimer(${t.id})">Stop</button>`;
    return `<div class="row between" style="align-items:center; padding:8px 0; ${sep}">
      <div style="font-size:22px; font-weight:700; font-variant-numeric:tabular-nums;" id="td_${t.id}">${_fmtTimer(_timerElapsedMs(t))}</div>
      <div class="row" style="gap:6px;">${btns}</div>
    </div>`;
  }).join('');
  const anyRunning = timers.some(t => !t.stoppedAt && !t.pausedAt);
  if (anyRunning && !_timerInterval) {
    _timerInterval = setInterval(_tickTimers, 1000);
  } else if (!anyRunning && _timerInterval) {
    clearInterval(_timerInterval);
    _timerInterval = null;
  }
}

export function addTimer() {
  if (!state.current) return;
  if (!state.current.timers) state.current.timers = [];
  state.current.timers.push({ id: Date.now(), startedAt: new Date().toISOString(), stoppedAt: null, pausedAt: null, pausedMs: 0, durationMin: null });
  save();
  renderTimers();
}

export function pauseTimer(id) {
  const t = state.current?.timers?.find(t => t.id === id);
  if (!t || t.stoppedAt || t.pausedAt) return;
  t.pausedAt = new Date().toISOString();
  save();
  renderTimers();
}

export function resumeTimer(id) {
  const t = state.current?.timers?.find(t => t.id === id);
  if (!t || !t.pausedAt) return;
  t.pausedMs = (t.pausedMs || 0) + (Date.now() - new Date(t.pausedAt).getTime());
  t.pausedAt = null;
  save();
  renderTimers();
}

export function stopTimer(id) {
  const t = state.current?.timers?.find(t => t.id === id);
  if (!t || t.stoppedAt) return;
  if (t.pausedAt) {
    t.pausedMs = (t.pausedMs || 0) + (Date.now() - new Date(t.pausedAt).getTime());
    t.pausedAt = null;
  }
  t.stoppedAt = new Date().toISOString();
  t.durationSec = Math.max(1, Math.round((new Date(t.stoppedAt) - new Date(t.startedAt) - (t.pausedMs || 0)) / 1000));
  save();
  renderTimers();
}

export function discardTimer(id) {
  if (!state.current?.timers) return;
  state.current.timers = state.current.timers.filter(t => t.id !== id);
  save();
  renderTimers();
}

function _showDurationPrompt(missingCardios) {
  const list = document.getElementById('durationPromptList');
  if (!list) return;
  const stoppedTimers = (state.current?.timers || []).filter(t => t.stoppedAt && t.durationSec);
  list.innerHTML = missingCardios.map(a => {
    const idx = state.current.cardioActivities.indexOf(a);
    const def = CARDIO_TYPES.find(c => c.key === a.type) || CARDIO_TYPES[CARDIO_TYPES.length - 1];
    const timerPills = stoppedTimers.length
      ? `<div data-timer-pills style="position:absolute; right:7px; top:7px; bottom:7px; display:flex; align-items:center; gap:6px;">
          ${stoppedTimers.map(t => `<button type="button" class="set-pill" style="display:inline-flex; align-items:center; height:100%; padding:0 11px; font-size:13px; background:var(--card); color:var(--accent2); border:1.5px solid var(--accent2); gap:4px; cursor:pointer;" onclick="useTimerForDuration(${idx}, ${t.durationSec})">⏱ ${_fmtTimer(t.durationSec * 1000)} · add</button>`).join('')}
        </div>`
      : '';
    return `<div style="margin-bottom: 12px;">
      <label class="muted small" style="display:block; margin-bottom: 4px;">${def.icon} ${def.label}</label>
      <div style="position:relative;">
        <input type="text" data-cardio-idx="${idx}" placeholder="e.g. 45:00 or 30 min" style="width:100%; padding-right:${stoppedTimers.length ? '110px' : ''};" oninput="onDurationInput(this)">
        ${timerPills}
      </div>
    </div>`;
  }).join('');
  document.getElementById('durationPromptModal').classList.add('show');
}

export function useTimerForDuration(cardioIdx, durationSec) {
  const input = document.querySelector(`#durationPromptList [data-cardio-idx="${cardioIdx}"]`);
  if (input) {
    input.value = _fmtTimer(durationSec * 1000);
    input.style.paddingRight = '';
    // Remove the green timer pill(s) for this field once added
    input.parentElement?.querySelector('[data-timer-pills]')?.remove();
  }
}

// Hide the "use timer" pill while the user is typing a duration manually;
// bring it back (and re-pad the input) if they clear the field again.
export function onDurationInput(input) {
  const pills = input.parentElement?.querySelector('[data-timer-pills]');
  if (!pills) return;
  const typed = !!input.value.trim();
  pills.style.display = typed ? 'none' : 'flex';
  input.style.paddingRight = typed ? '' : '110px';
}

export function closeDurationPrompt() {
  // Persist any durations the user already typed before closing, so partial
  // input isn't lost (the still-empty ones just stay empty).
  const list = document.getElementById('durationPromptList');
  [...(list?.querySelectorAll('[data-cardio-idx]') || [])].forEach(input => {
    const v = input.value.trim();
    if (!v) return;
    const a = state.current?.cardioActivities?.[parseInt(input.dataset.cardioIdx)];
    if (a) a.duration = v;
  });
  save();
  renderCardioActivities();
  document.getElementById('durationPromptModal').classList.remove('show');
}

export function saveDurations() {
  const list = document.getElementById('durationPromptList');
  const inputs = [...(list?.querySelectorAll('[data-cardio-idx]') || [])];
  if (inputs.some(i => !i.value.trim())) return toast('Fill in all durations to continue');
  inputs.forEach(input => {
    const idx = parseInt(input.dataset.cardioIdx);
    const a = state.current?.cardioActivities?.[idx];
    if (a) a.duration = input.value.trim();
  });
  document.getElementById('durationPromptModal').classList.remove('show');
  // Re-run finishSession; its check re-validates. Anything still missing
  // (e.g. a cardio not shown in this prompt) re-triggers the prompt rather
  // than slipping through to a 0-min save.
  finishSession();
}

export function clearExerciseDuration(idx) {
  const e = state.current?.entries?.[idx];
  if (!e) return;
  delete e.durationMin;
  save();
  renderWorkout();
}

export function clearCardioDuration(idx) {
  const a = state.current?.cardioActivities?.[idx];
  if (!a) return;
  a.duration = '';
  save();
  renderCardioActivities();
}

export function attachTimer(id) {
  const t = state.current?.timers?.find(t => t.id === id);
  if (!t?.durationSec) return;
  _attachingTimerId = id;
  openTimerAttachPicker(t.durationSec);
}

export function openTimerAttachPicker(durationSec) {
  if (!state.current) return;
  const cardios = state.current.cardioActivities || [];
  const entries = state.current.entries || [];
  if (cardios.length === 0 && entries.length === 0) return;
  const fmtDur = _fmtTimer(durationSec * 1000);
  document.getElementById('timerAttachDurLabel').textContent = fmtDur;
  const items = [];
  cardios.forEach((a, i) => {
    const def = CARDIO_TYPES.find(c => c.key === a.type) || CARDIO_TYPES[CARDIO_TYPES.length - 1];
    const attached = !!a.duration;
    const badge = attached ? `<span style="margin-left:6px; color:var(--accent2); font-weight:600;">✓ ${escapeHtml(a.duration)}</span>` : '';
    const bg = attached ? 'background: rgba(52,199,89,0.08); border: 1px solid var(--accent2);' : 'background: var(--panel); border: 1px solid transparent;';
    const action = attached ? `detachTimerFrom('cardio', ${i})` : `attachTimerTo('cardio', ${i}, ${durationSec})`;
    items.push(`<button class="card" style="display:block; width:100%; padding: 10px 12px; margin-bottom: 6px; ${bg} border-radius: 10px; text-align: left; cursor: pointer;" onclick="${action}">${def.icon} <b>${def.label}</b>${badge}</button>`);
  });
  entries.forEach((e, i) => {
    if (!e.sets || e.sets.length === 0) return;
    const attached = !!e.durationMin;
    const badge = attached ? `<span style="margin-left:6px; color:var(--accent2); font-weight:600;">✓ ${_fmtTimer(e.durationMin * 60000)}</span>` : `<span class="muted small" style="margin-left:4px;">(${e.sets.length} set${e.sets.length>1?'s':''})</span>`;
    const bg = attached ? 'background: rgba(52,199,89,0.08); border: 1px solid var(--accent2);' : 'background: var(--panel); border: 1px solid transparent;';
    const action = attached ? `detachTimerFrom('exercise', ${i})` : `attachTimerTo('exercise', ${i}, ${durationSec})`;
    items.push(`<button class="card" style="display:block; width:100%; padding: 10px 12px; margin-bottom: 6px; ${bg} border-radius: 10px; text-align: left; cursor: pointer;" onclick="${action}">💪 <b>${escapeHtml(e.name)}</b>${badge}</button>`);
  });
  document.getElementById('timerAttachList').innerHTML = items.join('') || '<div class="empty">No activities to attach to.</div>';
  const allBtn = document.getElementById('attachToAllBtn');
  if (allBtn) {
    const hasExercises = entries.some(e => e.sets?.length > 0);
    allBtn.style.display = hasExercises ? 'block' : 'none';
    allBtn.onclick = () => attachTimerToAll(durationSec);
  }
  document.getElementById('timerAttachModal').classList.add('show');
}

export function attachTimerToAll(durationSec) {
  if (!state.current) return;
  for (const e of (state.current.entries || [])) {
    if (e.sets?.length > 0) e.durationMin = durationSec / 60;
  }
  save();
  renderWorkout();
  openTimerAttachPicker(durationSec);
  toast('Attached to all exercises ✓');
}

export function closeTimerAttach() {
  document.getElementById('timerAttachModal').classList.remove('show');
}

export function attachTimerTo(kind, idx, durationSec) {
  if (!state.current) return;
  if (kind === 'cardio') {
    const a = state.current.cardioActivities?.[idx];
    if (a) a.duration = _fmtTimer(durationSec * 1000);
  } else if (kind === 'exercise') {
    const e = state.current.entries?.[idx];
    if (e) e.durationMin = durationSec / 60;
  }
  save();
  renderWorkout();
  openTimerAttachPicker(durationSec);
  toast('Attached ✓');
}

export function detachTimerFrom(kind, idx) {
  if (!state.current) return;
  if (kind === 'cardio') {
    const a = state.current.cardioActivities?.[idx];
    if (a) a.duration = '';
  } else if (kind === 'exercise') {
    const e = state.current.entries?.[idx];
    if (e) delete e.durationMin;
  }
  save();
  renderWorkout();
  const t = state.current.timers?.find(t => t.id === _attachingTimerId);
  if (t) openTimerAttachPicker(t.durationSec);
  toast('Detached');
}


// ---------- SET MODAL ----------
function getPrevSets(name) { return lastSetsFor(state.sessions, name); }

function _openSetModal({ exerciseIdx, setIdx = null }) {
  currentSetCtx = { exerciseIdx, setIdx };
  const entry = state.current.entries[exerciseIdx];
  const isEdit = setIdx !== null;
  currentReps = isEdit ? entry.sets[setIdx].reps : (entry.sets.slice(-1)[0]?.reps ?? getPrevSets(entry.name)?.[0] ?? 8);
  const isTime = /plank|hold|sec|hang/i.test(entry.name);
  document.getElementById('setRepsVal').value = currentReps;
  document.getElementById('setModalTitle').textContent = entry.name;
  document.getElementById('setModalLabel').textContent = isTime ? 'Seconds' : 'Reps';
  document.getElementById('confirmSetBtn').textContent = isEdit ? 'Save' : 'Add set';
  document.getElementById('deleteSetBtn').style.display = isEdit ? '' : 'none';
  document.getElementById('setModal').classList.add('show');
}

export function openSet(exerciseIdx) {
  _openSetModal({ exerciseIdx });
}

export function editSet(exerciseIdx, setIdx) {
  _openSetModal({ exerciseIdx, setIdx });
}

export function closeSet() {
  document.getElementById('setModal').classList.remove('show');
  currentSetCtx = null;
}

export function bumpReps(d) {
  const input = document.getElementById('setRepsVal');
  currentReps = Math.max(0, (parseInt(input.value, 10) || 0) + d);
  input.value = currentReps;
}

export function confirmSet() {
  if (!currentSetCtx) return;
  currentReps = Math.max(0, parseInt(document.getElementById('setRepsVal').value, 10) || 0);
  const { exerciseIdx, setIdx } = currentSetCtx;
  if (setIdx !== null) {
    state.current.entries[exerciseIdx].sets[setIdx].reps = currentReps;
  } else {
    state.current.entries[exerciseIdx].sets.push({ reps: currentReps });
  }
  save();
  closeSet();
  renderWorkout();
}

export function deleteCurrentSet() {
  if (!currentSetCtx || currentSetCtx.setIdx === null) return;
  state.current.entries[currentSetCtx.exerciseIdx].sets.splice(currentSetCtx.setIdx, 1);
  save();
  closeSet();
  renderWorkout();
}

export function removeSet(exIdx, setIdx) {
  state.current.entries[exIdx].sets.splice(setIdx, 1);
  save();
  renderWorkout();
}

export function removeExercise(idx) {
  state.current.entries.splice(idx, 1);
  save();
  renderWorkout();
}

export function updateExerciseNote(idx, value) {
  if (state.current?.entries?.[idx]) {
    state.current.entries[idx].note = value;
    save();
  }
}

// ---------- CARDIO ----------
export function removeCardio() {
  if (!state.current) return;
  if (state.current.cardioNote && !confirm('Remove cardio from this session? Your note will be lost.')) return;
  state.current.cardioRemoved = true;
  state.current.cardioNote = '';
  save();
  renderWorkout();
}

export function addCardioPlan() {
  const planCardioType = PLAN[state.current?.day]?.cardioType;
  if (planCardioType) {
    addCardioActivity(planCardioType);
  } else {
    openCardioPicker();
  }
}

export function openCardioPicker() {
  const list = document.getElementById('cardioPickerList');
  list.innerHTML = CARDIO_TYPES.map(c => `
    <button class="card" style="display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px; margin-bottom: 6px; border: none; background: var(--panel); cursor: pointer; text-align: left;" onclick="addCardioActivity('${c.key}')">
      <span style="font-size: 22px;">${c.icon}</span>
      <span style="font-weight: 600;">${c.label}</span>
    </button>
  `).join('');
  document.getElementById('cardioPickerModal').classList.add('show');
}

export function closeCardioPicker() {
  document.getElementById('cardioPickerModal').classList.remove('show');
}

export function addCardioActivity(typeKey) {
  if (!state.current) startWorkout('custom');
  state.current.cardioActivities = state.current.cardioActivities || [];
  state.current.cardioActivities.push({ id: 'c' + Date.now() + Math.random().toString(36).slice(2, 7), type: typeKey, distance: '', duration: '', notes: '' });
  save();
  closeCardioPicker();
  renderWorkout();
}

export function removeCardioActivity(idx) {
  if (!state.current) return;
  if (!confirm('Remove this cardio activity?')) return;
  state.current.cardioActivities.splice(idx, 1);
  save();
  renderWorkout();
}

export function updateCardioField(idx, field, value) {
  if (!state.current || !state.current.cardioActivities?.[idx]) return;
  state.current.cardioActivities[idx][field] = value;
  save();
}

export function openCardioPhotoAnalyze(idx) {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  _cardioPhotoIdx = idx; // number = activity card
  document.getElementById('cardioPhotoInput').click();
}

export function openCardioNotePhotoAnalyze() {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  _cardioPhotoIdx = 'note';
  document.getElementById('cardioPhotoInput').click();
}

export function openExercisePhotoAnalyze(idx) {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  _cardioPhotoIdx = { exercise: idx };
  document.getElementById('cardioPhotoInput').click();
}

// Format pace (seconds per km) → "m:ss".
function _fmtPace(secPerKm) {
  if (!secPerKm) return '';
  const m = Math.floor(secPerKm / 60);
  return `${m}:${String(Math.round(secPerKm % 60)).padStart(2, '0')}`;
}

// Human-readable summary of an interval segments[] array for the cardio card.
function _intervalSummary(segs) {
  const work = segs.filter(s => s.kind === 'work');
  const rec = segs.filter(s => s.kind === 'recovery');
  const warm = segs.find(s => s.kind === 'warmup');
  const cool = segs.find(s => s.kind === 'cooldown');
  const totalSec = segs.reduce((s, x) => s + (x.durationSec || 0), 0);
  const paces = work.map(w => w.paceSecPerKm).filter(Boolean);
  const paceNote = paces.length
    ? ` @ ${_fmtPace(Math.min(...paces))}${Math.max(...paces) !== Math.min(...paces) ? `–${_fmtPace(Math.max(...paces))}` : ''}/km`
    : '';
  const recPace = rec.find(r => r.paceSecPerKm)?.paceSecPerKm;
  const parts = [];
  if (warm) parts.push(`warmup ${_fmtTimer((warm.durationSec || 0) * 1000)}`);
  if (work.length) parts.push(`${work.length}× ${_fmtTimer((work[0].durationSec || 0) * 1000)} work${paceNote}`);
  if (rec.length) parts.push(`${rec.length}× ${_fmtTimer((rec[0].durationSec || 0) * 1000)} recovery${recPace ? ` @ ${_fmtPace(recPace)}/km` : ' (jog, 60% MET)'}`);
  if (cool) parts.push(`cooldown ${_fmtTimer((cool.durationSec || 0) * 1000)}`);
  return `${escapeHtml(parts.join(' · '))} · <b>${_fmtTimer(totalSec * 1000)} total</b>`;
}

// Turn the AI-extracted interval structure into an ordered segments[] array.
// One recovery follows EACH work rep (including the last, before the cooldown),
// so #recoveries == #intervals. Recovery duration: use the screenshot's recovery
// laps if present; else infer from total duration minus known laps; else default
// 1:1 with work. Recovery pace is left null when unknown — the engine then uses
// 60% of work MET.
function buildIntervalSegments(p) {
  if (!p || !Array.isArray(p.work)) return null;
  const work = p.work.filter(w => w && w.durationSec > 0);
  if (!work.length) return null;

  const recoveries = work.length; // one after each interval, including the last
  const workDur = work[0].durationSec;
  let recDur = null, recPace = null;
  if (p.recovery?.durationSec > 0) {
    recDur = p.recovery.durationSec;
    recPace = p.recovery.paceSecPerKm || null;
  } else if (p.totalDurationSec > 0) {
    const known = (p.warmup?.durationSec || 0) + (p.cooldown?.durationSec || 0)
      + work.reduce((s, w) => s + (w.durationSec || 0), 0);
    const per = (p.totalDurationSec - known) / recoveries;
    // Only trust the total when it implies a plausible recovery (>= half the work
    // interval). Many watches report MOVING time, which excludes recovery jogs and
    // makes this ~0 — in that case fall through to the 1:1 default below.
    if (per >= 0.5 * workDur) recDur = Math.round(per);
  }
  if (recDur == null) recDur = workDur; // fall back to 1:1 with work

  const segs = [];
  if (p.warmup?.durationSec > 0) {
    segs.push({ kind: 'warmup', durationSec: p.warmup.durationSec, paceSecPerKm: p.warmup.paceSecPerKm || null, distanceM: p.warmup.distanceM || null });
  }
  work.forEach((w) => {
    segs.push({ kind: 'work', durationSec: w.durationSec, paceSecPerKm: w.paceSecPerKm || null, distanceM: w.distanceM || null });
    segs.push({ kind: 'recovery', durationSec: recDur, paceSecPerKm: recPace });
  });
  if (p.cooldown?.durationSec > 0) {
    segs.push({ kind: 'cooldown', durationSec: p.cooldown.durationSec, paceSecPerKm: p.cooldown.paceSecPerKm || null, distanceM: p.cooldown.distanceM || null });
  }
  return segs;
}

// Store segments on the activity + derive display fields (total duration/distance,
// a human note). The engine reads a.segments; these fields are only for display.
function applyIntervalSegments(a, segs) {
  a.segments = segs;
  const totalSec = segs.reduce((s, x) => s + (x.durationSec || 0), 0);
  const totalKm = segs.reduce((s, x) => s + ((x.distanceM || 0) / 1000), 0);
  a.duration = _fmtTimer(totalSec * 1000);
  if (totalKm > 0) a.distance = `${Math.round(totalKm * 100) / 100} km`;
  const work = segs.filter(s => s.kind === 'work');
  const rec = segs.filter(s => s.kind === 'recovery').length;
  a.notes = `${work.length}× intervals + ${rec}× recovery (auto-detected)`;
}

export function clearIntervalSegments(idx) {
  const a = state.current?.cardioActivities?.[idx];
  if (!a) return;
  delete a.segments;
  a.notes = '';
  save();
  renderWorkout();
}

// Open the image picker for a cardio activity (attach mode — analyzed on save).
export function openCardioImageAttach(idx) {
  const a = state.current?.cardioActivities?.[idx];
  if (!a) return;
  _cardioPhotoIdx = { attachId: _cardioId(a) };
  document.getElementById('cardioPhotoInput').click();
}

export function removeCardioImage(activityId, i) {
  (_cardioImages[activityId] || []).splice(i, 1);
  renderCardioActivities();
}

export async function onCardioPhotoSelected(e) {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length || _cardioPhotoIdx === null) return;
  const mode = _cardioPhotoIdx;
  _cardioPhotoIdx = null;

  // Cardio activity attach: store image thumbnails now, analyze on save.
  if (mode && mode.attachId !== undefined) {
    const id = mode.attachId;
    _cardioImages[id] = _cardioImages[id] || [];
    for (const file of files) {
      const blob = await downscale(file, 1280);
      _cardioImages[id].push({ dataUrl: await blobToDataUrl(blob), mimeType: blob.type || 'image/jpeg' });
    }
    renderCardioActivities();
    return;
  }

  // Exercise / cardio-note photos still analyze immediately (single image).
  const file = files[0];
  toast('Analyzing…', { persistent: true });
  try {
    const blob = await downscale(file, 1280);
    const base64 = (await blobToDataUrl(blob)).split(',')[1];
    const isExercise = typeof mode === 'object' && mode.exercise !== undefined;
    const promptText = isExercise ? PROMPTS.exercisePhoto : PROMPTS.cardioPhoto;
    const reply = await geminiGenerate({
      contents: [{ role: 'user', parts: [
        { text: promptText },
        { inline_data: { mime_type: blob.type || 'image/jpeg', data: base64 } }
      ]}]
    });
    const parsed = parseJSONResponse(reply);
    hideToast();
    if (!parsed) { toast('Could not read photo'); return; }

    if (isExercise) {
      const entry = state.current?.entries?.[mode.exercise];
      if (!entry) return;
      if (parsed.notes) { entry.note = parsed.notes; save(); renderWorkout(); toast('Filled in ✓'); }
      else toast('Nothing detected in photo');
    } else if (mode === 'note') {
      const parts = [parsed.distance, parsed.duration, parsed.notes].filter(Boolean);
      if (parts.length) { if (state.current) state.current.cardioNote = parts.join(' · '); save(); renderWorkout(); toast('Filled in ✓'); }
      else toast('Nothing detected in photo');
    }
  } catch (err) {
    hideToast();
    toast('Failed: ' + (err.message || 'unknown'));
  }
}

// Analyze a cardio activity's attached screenshots (interval → segments via the
// interval prompt; other cardio → distance/duration/notes). Sends all attached
// images in one call so a lap table split across screenshots is read together.
async function analyzeCardioImages(a) {
  const imgs = _cardioImages[a.id] || [];
  if (!imgs.length) return;
  const isInterval = a.type === 'interval';
  const promptText = isInterval ? PROMPTS.intervalPhoto : PROMPTS.cardioPhoto;
  const parts = [{ text: promptText }, ...imgs.map(img => ({
    inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.dataUrl.split(',')[1] }
  }))];
  const reply = await geminiGenerate({ contents: [{ role: 'user', parts }] });
  const parsed = parseJSONResponse(reply);
  if (!parsed) return;
  if (isInterval) {
    const segs = buildIntervalSegments(parsed);
    if (segs) applyIntervalSegments(a, segs);
  } else {
    if (parsed.distance) a.distance = parsed.distance;
    if (parsed.duration) a.duration = parsed.duration;
    if (parsed.notes)    a.notes    = parsed.notes;
  }
  delete _cardioImages[a.id]; // consumed
}

function renderCardioActivities() {
  const list = document.getElementById('cardioList');
  const btn = document.getElementById('addCardioBtn');
  if (!list) return;
  if (!state.current) { list.innerHTML = ''; if (btn) btn.style.display = 'none'; return; }
  if (btn) btn.style.display = 'block';
  const activities = state.current.cardioActivities || [];
  list.innerHTML = activities.map((a, i) => {
    const def = CARDIO_TYPES.find(c => c.key === a.type) || CARDIO_TYPES[CARDIO_TYPES.length - 1];
    const id = _cardioId(a);
    const imgs = _cardioImages[id] || [];
    const thumbs = imgs.length ? `
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; align-items:center;">
          ${imgs.map((img, k) => `<div style="position:relative; display:inline-block;">
            <img src="${img.dataUrl}" style="height:60px; width:60px; object-fit:cover; border-radius:8px; border:1px solid var(--line);">
            <button onclick="removeCardioImage('${id}', ${k})" style="position:absolute;top:-6px;right:-6px;background:var(--danger);color:#fff;border:none;border-radius:50%;width:18px;height:18px;font-size:11px;padding:0;cursor:pointer;line-height:18px;">✕</button>
          </div>`).join('')}
          <span class="muted small">Analyzed on save</span>
        </div>` : '';
    return `
      <div class="ex" style="position: relative; padding: 12px 14px;">
        <div class="row between">
          <div class="grow"><b>${def.icon} ${def.label}</b></div>
          <button class="icon ghost" onclick="removeCardioActivity(${i})" aria-label="Remove">✕</button>
        </div>
        ${Array.isArray(a.segments) && a.segments.length ? `
        <div style="margin-top: 8px; padding: 8px 10px; background: var(--bg); border-radius: 8px; border-left: 3px solid var(--accent2);">
          <div class="row between" style="align-items: center;">
            <div class="muted small" style="font-weight: 500;">Detected intervals</div>
            <button class="ghost" onclick="clearIntervalSegments(${i})" style="padding: 2px 8px; font-size: 12px;">Clear</button>
          </div>
          <div class="small" style="margin-top: 4px;">${_intervalSummary(a.segments)}</div>
        </div>` : ''}
        <div class="row" style="gap: 8px; margin-top: 8px; flex-wrap: wrap;">
          ${def.showDist ? `<div style="flex: 1; min-width: 100px;"><label class="muted small">Distance</label><input type="text" placeholder="e.g. 8 km" value="${escapeHtml(a.distance || '')}" oninput="updateCardioField(${i}, 'distance', this.value)"></div>` : ''}
          ${def.showDur ? `<div style="flex: 1; min-width: 130px;"><label class="muted small">Duration</label>${a.duration
            ? `<div style="margin-top: 6px;"><span class="set-pill" style="display:inline-flex; align-items:center; white-space:nowrap; max-width:100%; background:transparent; color:var(--accent2); border:1.5px solid var(--accent2); gap:4px;">⏱ ${escapeHtml(a.duration)} <button onclick="clearCardioDuration(${i})" style="background:none;border:none;cursor:pointer;padding:0;font-size:15px;color:var(--muted);line-height:1;" aria-label="Clear duration">×</button></span></div>`
            : `<input type="text" placeholder="e.g. 45 min" value="" oninput="updateCardioField(${i}, 'duration', this.value)">`
          }</div>` : ''}
        </div>
        <div style="margin-top: 8px;">
          <label class="muted small" style="display: block; margin-bottom: 4px;">Notes</label>
          <div class="row" style="gap: 6px; align-items: stretch;">
            <button class="chat-icon-btn" onclick="openCardioImageAttach(${i})" aria-label="Attach screenshot" title="Attach screenshot(s) — analyzed when you save"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></button>
            <textarea placeholder="pace, RPE, terrain…" rows="1" enterkeyhint="enter" oninput="updateCardioField(${i}, 'notes', this.value); autoResizeTA(this)" style="flex: 1; resize: none; overflow-y: auto; max-height: 140px; min-height: 36px; line-height: 1.4;">${escapeHtml(a.notes || '')}</textarea>
          </div>
          ${thumbs}
        </div>
      </div>
    `;
  }).join('');
}

// ---------- EXERCISE PICKER ----------
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

export function renderExerciseList(filter = '') {
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

export function addPlanExercise(name) {
  if (!state.current) return;
  if (!state.current.entries.find(e => e.name.toLowerCase() === name.toLowerCase())) {
    state.current.entries.push({ name, sets: [] });
    save();
  }
  renderWorkout();
}

export function dismissPlanExercise(name) {
  if (!state.current) return;
  state.current.dismissedPlanExercises = state.current.dismissedPlanExercises || [];
  if (!state.current.dismissedPlanExercises.includes(name)) state.current.dismissedPlanExercises.push(name);
  save();
  renderWorkout();
}

export function clearAllPlanExercises() {
  if (!state.current) return;
  state.current.dismissedPlanExercises = (PLAN[state.current.day]?.exercises || []).slice();
  state.current.cardioRemoved = true; // also clear the cardio plan chip
  save();
  renderWorkout();
}

export function addCustomExercise() {
  const search = document.getElementById('exerciseSearch');
  if (search) search.value = '';
  renderExerciseList();
  document.getElementById('exerciseModal').classList.add('show');
  setTimeout(() => { if (search) search.focus(); }, 100);
}

export function closeExercisePicker() {
  document.getElementById('exerciseModal').classList.remove('show');
}

export function pickExercise(name) {
  state.current.entries.push({ name, sets: [] });
  save();
  closeExercisePicker();
  renderWorkout();
}

export function addCustomExerciseText() {
  closeExercisePicker();
  const name = prompt('Exercise name');
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (state.current.entries.some(e => e.name.toLowerCase() === trimmed.toLowerCase())) return toast('Already added');
  state.current.entries.push({ name: trimmed, sets: [] });
  save();
  renderWorkout();
}

// ---------- SESSION LIFECYCLE ----------
export async function finishSession() {
  if (!state.current) return toast('Nothing to save');
  const hasAny = state.current.entries.some(e => e.sets.length) || state.current.cardioNote || (state.current.cardioActivities || []).length > 0;
  if (!hasAny) return toast('Log at least one set');

  // Analyze any attached cardio screenshots now (interval → segments, else
  // distance/duration), so the duration check sees the filled-in values.
  const pending = (state.current.cardioActivities || []).filter(a => (_cardioImages[a.id] || []).length);
  if (pending.length) {
    if (!getGeminiKey()) return toast('Set up Gemini API key to analyze screenshots');
    const imgCount = pending.reduce((n, a) => n + (_cardioImages[a.id] || []).length, 0);
    toast(`Analyzing ${imgCount} screenshot${imgCount > 1 ? 's' : ''}…`, { persistent: true });
    try {
      for (const a of pending) await analyzeCardioImages(a);
      hideToast();
      save();
      renderWorkout();
    } catch (err) {
      hideToast();
      return toast('Analysis failed: ' + (err.message || 'unknown'));
    }
  }

  // Mandatory: block save if any cardio activity has no duration
  const missingCardio = (state.current.cardioActivities || []).filter(a => !a.duration?.trim());
  if (missingCardio.length > 0) {
    _showDurationPrompt(missingCardio);
    return;
  }

  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  let savedAt;
  if (state.current._editingId) {
    const idx = state.sessions.findIndex(s => s.savedAt === state.current._editingId);
    if (idx >= 0) {
      const editingId = state.current._editingId;
      const previous = state.sessions[idx];
      const updated = { ...state.current, savedAt: editingId };
      delete updated._editingId;
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
    updateWorkoutHistory(savedSession);
    save();
    selectDay(currentDay);
    toast('Saved ✓');
    if ((savedSession.entries || []).some(e => e.sets && e.sets.length > 0)) {
      setTimeout(() => openHeatmap(savedSession), 500);
    }
  }
  if (getGeminiKey() && savedAt) {
    const effortPos = parseInt(document.getElementById('effortInput')?.value || '5', 10);
    const rpe = effortPos + 1; // slider 1–9 → RPE 2–10
    const s = state.sessions.find(x => x.savedAt === savedAt);
    if (s) {
      setTimeout(async () => {
        try {
          const result = await runTrainer(s, { rpe });
          if (result) {
            s.caloriesBurned  = result.caloriesBurned;
            s.epocToday       = result.epocToday;
            s.epocTomorrow    = result.epocTomorrow;
            s.stepsFromCardio = result.stepsFromCardio;
            s.consistency        = result.consistency;
            s.trainerFeedback    = result.feedback;
            s.exerciseSuggestion = result.exerciseSuggestion || '';
            s.burnBreakdown      = result.breakdown;
            s.burnNotes          = null;
            s.rpe                = rpe;
            if (result.adjustPlan && result.planNote) s.planNote = result.planNote;
            updateWorkoutHistory(s);
            save();
            renderHistory();
          }
        } catch {
          // fall back to legacy analysis
          const ok = await autoAnalyzeSession(savedAt);
          if (ok) renderHistory();
        }
      }, 800);
    }
  }
}

export function cancelSession() {
  if (!state.current) return;
  const wasEditing = !!state.current._editingId;
  const isFresh = isCurrentFresh(state.current);
  // Edit mode: original session is always intact — no confirm needed.
  // New session: confirm only if there are logged sets to lose.
  if (!wasEditing && !isFresh) {
    if (!confirm('Cancel this session? Logged sets will be lost.')) return;
  }
  state.current = null;
  // Force-hide editing UI immediately before renderWorkout runs
  ['sessionHeaderRow','saveRow','sessionFeedbackCard','sessionTimerCard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  save();
  renderWorkout();
  if (wasEditing) toast('Edits discarded');
}

// ---------- SESSION HISTORY ----------
export function renderHistory() {
  const list = document.getElementById('historyList');
  if (!state.sessions.length) { list.innerHTML = '<div class="empty">No sessions yet.</div>'; return; }
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
    const durationHtml = s.durationMin ? `<span class="muted small" style="margin-left: 6px; font-weight: 500;">· ${s.durationMin} min</span>` : '';
    const burnHtml = typeof s.caloriesBurned === 'number' ? `<span class="muted small" style="margin-left: 6px; font-weight: 500;">· ~${s.caloriesBurned} kcal</span>` : '';
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
          <div class="muted small" style="margin-bottom: 6px; font-weight: 500;">Burn breakdown${s.rpe != null ? ` · effort ${s.rpe}/10` : ''}</div>
          ${s.burnBreakdown.map(b => `<div class="small" style="margin-top: 4px;"><b>${escapeHtml(b.activity)}</b>: ${b.calories} kcal <span class="muted">— ${escapeHtml(b.reasoning || '')}</span></div>`).join('')}
          <div class="small" style="margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--line); font-weight: 600;">Total: ${s.caloriesBurned} kcal${s.epocToday > 0 ? ` <span class="muted" style="font-weight: 400;">· +${s.epocToday} kcal EPOC today</span>` : ''}${s.epocTomorrow > 0 ? ` <span class="muted" style="font-weight: 400;">· +${s.epocTomorrow} kcal carries to tomorrow</span>` : ''}</div>
          ${s.burnNotes ? `<div class="small muted" style="margin-top: 6px; font-style: italic;">${escapeHtml(s.burnNotes)}</div>` : ''}
        </div>` : ''}
        ${burnQs.length ? `<div class="small" style="margin-top: 6px; color: var(--warn);">❓ ${burnQs.length} question${burnQs.length > 1 ? 's' : ''}: ${burnQs.map(escapeHtml).join(' · ')}</div>` : ''}
        ${notes ? `<div style="margin-top: 8px; padding: 8px 10px; background: var(--bg); border-radius: 8px; border-left: 3px solid var(--accent);"><div class="muted small">Notes / Analysis</div><div style="white-space: pre-wrap;">${notes}</div></div>` : ''}
        ${s.trainerFeedback ? `<div style="margin-top: 8px; padding: 10px 12px; background: var(--bg); border-radius: 10px; border-left: 3px solid var(--accent2);">
          <div class="muted small" style="margin-bottom: 4px; font-weight: 500;">🏋️ Trainer</div>
          ${s.rpe != null ? `<div class="small muted" style="margin-bottom: 4px;">Effort ${s.rpe}/10${s.consistency ? ` · ${s.consistency}` : ''}</div>` : ''}
          <div class="small" style="white-space: pre-wrap;">${escapeHtml(s.trainerFeedback)}</div>
          ${s.exerciseSuggestion ? `<div class="small" style="margin-top: 6px; color: var(--accent);">💡 ${escapeHtml(s.exerciseSuggestion)}</div>` : ''}
          ${s.planNote ? `<div class="small" style="margin-top: 6px; color: var(--accent);">📋 ${escapeHtml(s.planNote)}</div>` : ''}
        </div>` : ''}
        <div class="row" style="margin-top: 10px; gap: 6px; flex-wrap: wrap;">
          <button class="ghost" style="padding: 4px 10px; font-size: 13px;" onclick="editSession(${s.savedAt})">Edit</button>
          <button class="ghost" style="padding: 4px 10px; font-size: 13px;" onclick="openSessionRefine(${s.savedAt})">💬 Chat</button>
          <button class="ghost" style="padding: 4px 10px; font-size: 13px;" onclick="reanalyzeSession(${s.savedAt})">↺ Re-analyze</button>
          <button class="ghost danger" style="padding: 4px 10px; font-size: 13px;" onclick="deleteSession(${s.savedAt})">Delete</button>
        </div>
      </div>
    `;
  };
  list.innerHTML = dates.map(date => {
    const sessions = byDate[date].slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const dayLabel = formatDayLabel(date);
    const totalBurn = sessions.reduce((sum, s) => sum + (s.caloriesBurned || 0), 0);
    const summaryRight = totalBurn > 0 ? `<span style="color: var(--accent); font-weight: 600;">${totalBurn} kcal</span>` : '';
    return `
      <details style="margin-top: 8px;">
        <summary class="muted small" style="margin-bottom: 8px; font-weight: 500; display: flex; justify-content: space-between; align-items: baseline; cursor: pointer; list-style: none;">
          <span>▸ ${dayLabel}</span>${summaryRight}
        </summary>
        <div style="margin-top: 6px;">${sessions.map(renderSession).join('')}</div>
      </details>
    `;
  }).join('');
}

export function editSession(savedAt) {
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
  window.switchTab?.('workout');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function setSessionTime(savedAt) {
  const s = state.sessions.find(x => x.savedAt === savedAt);
  if (!s) return;
  const newTime = prompt('Enter time (HH:MM, 24h):', s.time || '');
  if (!newTime) return;
  if (!/^\d{1,2}:\d{2}$/.test(newTime.trim())) return toast('Invalid time format');
  s.time = newTime.trim();
  save();
  renderHistory();
}

export function deleteSession(savedAt) {
  if (!confirm('Delete this session permanently?')) return;
  state.sessions = state.sessions.filter(s => s.savedAt !== savedAt);
  save();
  renderHistory();
  toast('Session deleted');
}

export async function reanalyzeSession(savedAt) {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const s = state.sessions.find(x => x.savedAt === savedAt);
  if (!s) return;
  toast('Re-analyzing…', { persistent: true });
  try {
    const rpe    = s.rpe ?? 5;
    const result = await runTrainer(s, { rpe });
    if (result) {
      s.caloriesBurned  = result.caloriesBurned;
      s.epocToday       = result.epocToday;
      s.epocTomorrow    = result.epocTomorrow;
      s.stepsFromCardio = result.stepsFromCardio;
      s.consistency        = result.consistency;
      s.trainerFeedback    = result.feedback;
      s.exerciseSuggestion = result.exerciseSuggestion || '';
      s.burnBreakdown      = result.breakdown;
      s.burnNotes          = null;
      if (result.adjustPlan && result.planNote) s.planNote = result.planNote;
      updateWorkoutHistory(s);
      save();
      renderHistory();
    }
  } catch {
    toast('Re-analysis failed');
    return;
  }
  hideToast();
  toast(`Re-analyzed: ${state.sessions.find(x => x.savedAt === savedAt)?.caloriesBurned ?? '?'} kcal ✓`);
}

export function updateSessionDate(value) {
  if (!value) return;
  if (state.current) { state.current.date = value; save(); }
}

export function updateSessionTime(value) {
  if (state.current) { state.current.time = value; save(); }
}

// ---------- SESSION REFINE / CHAT ----------
export function openSessionRefine(savedAt) {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const session = state.sessions.find(s => s.savedAt === savedAt);
  if (!session) return;
  if (_refiningSessionAt !== savedAt) {
    _sessionChatHistory = [];
    _pendingSessionRefine = null;
    if (session.chatHistory && session.chatHistory.length) {
      _sessionChatHistory = session.chatHistory.slice();
    } else if (session.burnQuestions && session.burnQuestions.length) {
      const questionText = "A few things I wasn't sure about for this workout:\n\n" + session.burnQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n') + '\n\nCan you clarify?';
      _sessionChatHistory.push({ role: 'model', text: questionText });
    }
  }
  _refiningSessionAt = savedAt;
  _cachedHistoryContext = buildWorkoutHistoryContext(30, session);
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

export function closeSessionRefine() {
  document.getElementById('sessionRefineModal').classList.remove('show');
  _cachedHistoryContext = null;
}

function buildSessionSystemInstruction(session) {
  const exLines = (session.entries || []).filter(e => e.sets?.length).map(e =>
    `  - ${e.name}: ${e.sets.map(x => x.reps).join(',')}${e.durationMin ? ' (' + e.durationMin + ' min)' : ''}${e.note ? ' — note: ' + e.note : ''}`
  ).join('\n') || '  (none)';
  return PROMPTS.sessionChatSystem
    .replace('{date}', session.date)
    .replace('{rpe}', String(session.rpe ?? '?'))
    .replace('{cardioActivities}', formatCardioActivitiesForAI(session.cardioActivities))
    .replace('{exercises}', exLines)
    .replace('{currentBurn}', String(session.caloriesBurned ?? 'unknown'))
    .replace('{consistency}', session.consistency || 'unknown')
    .replace('{trainerFeedback}', session.trainerFeedback || 'not available')
    .replace('{breakdown}', JSON.stringify(session.burnBreakdown || []))
    .replace('{history}', _cachedHistoryContext || buildWorkoutHistoryContext(30));
}

export async function refineSessionEstimate() {
  const text = document.getElementById('sessionRefineInput').value.trim();
  if (!text && _sessionAttachedImages.length === 0) return toast('Type a message first');
  if (_refiningSessionAt == null) return toast('No session selected');
  const session = state.sessions.find(s => s.savedAt === _refiningSessionAt);
  if (!session) return;
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
    const idx = state.sessions.findIndex(s => s.savedAt === _refiningSessionAt);
    if (idx >= 0) { state.sessions[idx].chatHistory = _sessionChatHistory.slice(-40); save(); }
    hideToast();
    renderSessionRefineChat();
    document.getElementById('updateSessionEstimateBtn').style.display = 'block';
  } catch (e) {
    hideToast();
    toast('Failed: ' + (e.message || 'unknown'));
  }
}

export async function requestSessionEstimateUpdate() {
  if (_refiningSessionAt == null) return;
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  if (_sessionChatHistory.length === 0) return toast('Chat with AI first');
  const session = state.sessions.find(s => s.savedAt === _refiningSessionAt);
  if (!session) return;
  toast('Updating estimate…', { persistent: true });
  try {
    const systemInstruction = buildSessionSystemInstruction(session);
    const updatePrompt = PROMPTS.sessionEstimateUpdate;
    const contents = [
      ..._sessionChatHistory.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text || '' }] })),
      { role: 'user', parts: [{ text: updatePrompt }] }
    ];
    const result = await geminiGenerate({ systemInstruction, contents });
    const text = result.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
    try {
      _pendingSessionRefine = JSON.parse(text);
    } catch { _pendingSessionRefine = null; }
    hideToast();
    renderSessionRefineChat();
  } catch (e) {
    hideToast();
    toast('Failed: ' + (e.message || 'unknown'));
  }
}

export async function applySessionRefine() {
  if (!_pendingSessionRefine || _refiningSessionAt == null) return;
  const idx = state.sessions.findIndex(s => s.savedAt === _refiningSessionAt);
  if (idx < 0) return;
  state.sessions[idx].caloriesBurned = _pendingSessionRefine.total;
  state.sessions[idx].burnBreakdown = _pendingSessionRefine.breakdown || [];
  state.sessions[idx].burnNotes = _pendingSessionRefine.notes || state.sessions[idx].burnNotes;
  state.sessions[idx].burnQuestions = [];
  _pendingSessionRefine = null;
  renderSessionRefineChat();
  renderHistory();
  try {
    save();
    toast('Updated ✓');
  } catch (e) {
    console.error('applySessionRefine save failed:', e);
    toast('Applied (save failed: ' + (e.message || 'storage full?') + ')');
  }
}

export function discardSessionRefine() {
  _pendingSessionRefine = null;
  renderSessionRefineChat();
}

export function renderSessionRefineChat() {
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
        <button class="ghost" onclick="discardSessionRefine()">Discard</button>
      </div>
    </div>`;
  }
  div.innerHTML = html;
  div.scrollTop = div.scrollHeight;
}

// ---------- ATTACHMENTS ----------
export function sessionAttachFiles(input) { attachFilesTo(_sessionAttachedImages, input, renderSessionAttachPreview); }
export function renderSessionAttachPreview() { renderAttachPreview('sessionAttachPreview', _sessionAttachedImages, '_removeSessionAttach'); }
export function _removeSessionAttach(i) { _sessionAttachedImages.splice(i, 1); renderSessionAttachPreview(); }

// ---------- PLAN MODAL ----------
export function openPlanModal() {
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

export function closePlanModal() {
  document.getElementById('planModal').classList.remove('show');
}

// ---------- MAIN RENDER ----------
export function renderWorkout() {
  const viewDate = workoutCurrentDate();
  const stepsGoal = state.profile?.goals?.steps || 10000;
  const dateLabel = document.getElementById('workoutDateLabel');
  if (dateLabel) dateLabel.textContent = formatWorkoutDateLabel(viewDate);
  const nextBtn = document.getElementById('workoutNextBtn');
  if (nextBtn) nextBtn.style.visibility = viewDate >= todayISO() ? 'hidden' : 'visible';

  const stepsRec = (state.steps || []).find(s => s.date === viewDate);
  const stepsVal = document.getElementById('workoutStepsValue');
  const stepsProg = document.getElementById('workoutStepsProgress');
  const stepsInput = document.getElementById('workoutStepsInput');
  if (stepsVal) stepsVal.textContent = stepsRec ? stepsRec.count.toLocaleString() : '—';
  if (stepsProg) {
    if (stepsRec) {
      const pct = Math.round((stepsRec.count / stepsGoal) * 100);
      const hit = stepsRec.count >= stepsGoal;
      stepsProg.innerHTML = `<span style="color: ${hit ? 'var(--accent2)' : 'var(--muted)'};">${pct}% of ${stepsGoal.toLocaleString()}${hit ? ' ✓' : ''}</span>`;
    } else {
      stepsProg.innerHTML = '<span class="muted">Not logged yet</span>';
    }
  }
  if (stepsInput) stepsInput.value = stepsRec ? stepsRec.count : '';

  const banner = document.getElementById('workoutPlanBanner');
  const empty = document.getElementById('workoutEmptyState');
  const list = document.getElementById('exerciseList');
  const planChips = document.getElementById('planChips');
  const metaRow = document.getElementById('sessionMetaRow');
  const headerRow = document.getElementById('sessionHeaderRow');
  const title = document.getElementById('workoutTitle');
  const cancelBtn = document.getElementById('workoutCancelBtn');
  const saveRow = document.getElementById('saveRow');
  const feedbackCard = document.getElementById('sessionFeedbackCard');
  const hasCurrentForViewDate = state.current && state.current.date === viewDate;

  if (!hasCurrentForViewDate) {
    if (banner) banner.style.display = 'none';
    if (empty) empty.style.display = 'none';
    if (metaRow) metaRow.style.display = 'none';
    if (headerRow) headerRow.style.display = 'none';
    if (saveRow) saveRow.style.display = 'none';
    if (feedbackCard) feedbackCard.style.display = 'none';
    const timerCard = document.getElementById('sessionTimerCard');
    if (timerCard) timerCard.style.display = 'none';
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (list) list.innerHTML = '';
    if (planChips) planChips.innerHTML = '';
    const cardioList = document.getElementById('cardioList');
    const addCardioBtn = document.getElementById('addCardioBtn');
    if (cardioList) cardioList.innerHTML = '';
    if (addCardioBtn) addCardioBtn.style.display = 'none';
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
      addAnotherBtn.onclick = () => { if (planKey) loadWorkoutPlan(); else startWorkout('custom'); };
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

  const addAnotherBtnActive = document.getElementById('addAnotherWorkoutBtn');
  if (addAnotherBtnActive) addAnotherBtnActive.style.display = 'none';
  if (banner) banner.style.display = 'none';
  if (empty) empty.style.display = 'none';
  const hasContent = (state.current.entries || []).length > 0 || (state.current.cardioActivities || []).length > 0;
  if (metaRow) metaRow.style.display = hasContent ? 'flex' : 'none';
  if (headerRow) headerRow.style.display = 'flex';
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';

  const timerCard = document.getElementById('sessionTimerCard');
  if (timerCard) {
    timerCard.style.display = 'block';
    if (!state.current.timers) state.current.timers = [];
    renderTimers();
  }

  const editing = !!state.current?._editingId;
  if (title) {
    if (state.current.day === 'custom' && !editing) { title.style.display = 'none'; }
    else { title.style.display = ''; title.textContent = (editing ? 'Editing — ' : '') + PLAN[state.current.day].label; }
  }
  const timeInput = document.getElementById('sessionTime');
  if (timeInput && state.current) timeInput.value = state.current.time || '';
  const dateInput = document.getElementById('sessionDate');
  if (dateInput && state.current) dateInput.value = state.current.date || todayISO();
  const showSave = editing || !isCurrentFresh(state.current);
  if (saveRow) saveRow.style.display = showSave ? 'flex' : 'none';
  if (feedbackCard) {
    feedbackCard.style.display = (showSave && hasContent) ? 'block' : 'none';
    // Pre-populate effort slider from stored session when editing
    if (showSave && editing && hasContent) {
      const stored = state.sessions.find(s => s.savedAt === state.current._editingId);
      if (stored) {
        const effortEl = document.getElementById('effortInput');
        if (effortEl && stored.rpe != null) {
          effortEl.value = Math.max(1, Math.min(9, stored.rpe - 1)); // RPE 2–10 → slider 1–9
          updateEffortDisplay();
        }
      }
    }
  }
  list.innerHTML = '';
  currentDay = state.current.day;

  if (PLAN[currentDay].cardio && state.current.cardioNote && !state.current.cardioRemoved) {
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
        <button class="chat-icon-btn" onclick="openCardioNotePhotoAnalyze()" aria-label="Attach photo" title="Attach a screenshot to auto-fill fields"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></button>
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

  const planExercises = (PLAN[state.current.day]?.exercises || []);
  const sessionDate = state.current.date || todayISO();
  const doneTodayNames = (state.sessions || [])
    .filter(s => s.date === sessionDate)
    .flatMap(s => (s.entries || []).map(e => e.name.toLowerCase()));
  const pickedNames = new Set([
    ...state.current.entries.map(e => e.name.toLowerCase()),
    ...doneTodayNames,
  ]);
  const dismissedNames = new Set((state.current.dismissedPlanExercises || []).map(n => n.toLowerCase()));
  const remainingPlan = planExercises.filter(name => !pickedNames.has(name.toLowerCase()) && !dismissedNames.has(name.toLowerCase()));
  const showCardioChip = !!(PLAN[currentDay]?.cardio && !state.current.cardioNote && !(state.current.cardioActivities?.length) && !state.current.cardioRemoved);
  if (planChips) planChips.innerHTML = '';
  if ((remainingPlan.length > 0 || showCardioChip) && planChips) {
    const planMenu = document.createElement('div');
    planMenu.style.cssText = 'margin: 8px 0; padding: 10px 12px; background: var(--panel2); border-radius: 10px;';
    planMenu.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <div class="muted small" style="font-weight: 500;">Today's plan — tap to add</div>
        <button class="ghost" onclick="clearAllPlanExercises()" style="padding: 2px 8px; font-size: 12px; color: var(--muted);">✕ Clear all</button>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">
        ${showCardioChip ? (() => {
          const cardioIcon = (CARDIO_TYPES.find(c => c.key === PLAN[currentDay].cardioType) || {}).icon || '🏃';
          return `<span style="display: inline-flex; align-items: center; border-radius: 999px; background: var(--bg); border: 1px solid var(--line); font-size: 13px; overflow: hidden;">
            <button onclick="addCardioPlan()" style="padding: 6px 6px 6px 12px; border: none; background: transparent; cursor: pointer;">${cardioIcon} + Cardio <span style="color: var(--muted); font-size: 11px;">${escapeHtml(PLAN[currentDay].cardio)}</span></button>
            <button onclick="removeCardio()" style="padding: 6px 10px 6px 4px; border: none; background: transparent; cursor: pointer; color: var(--muted); font-size: 15px; line-height: 1;">×</button>
          </span>`;
        })() : ''}
        ${remainingPlan.map(name => {
          const safe = name.replace(/'/g, "\\'");
          return `<span style="display: inline-flex; align-items: center; border-radius: 999px; background: var(--bg); border: 1px solid var(--line); font-size: 13px; overflow: hidden;">
            <button onclick="addPlanExercise('${safe}')" style="padding: 6px 6px 6px 12px; border: none; background: transparent; cursor: pointer;">+ ${escapeHtml(name)}</button>
            <button onclick="dismissPlanExercise('${safe}')" style="padding: 6px 10px 6px 4px; border: none; background: transparent; cursor: pointer; color: var(--muted); font-size: 15px; line-height: 1;">×</button>
          </span>`;
        }).join('')}
      </div>`;
    planChips.appendChild(planMenu);
  }

  state.current.entries.forEach((e, idx) => {
    const last = getPrevSets(e.name);
    const isTime = /plank|hold|sec|hang/i.test(e.name);
    const ex = document.createElement('div');
    ex.className = 'ex';
    ex.innerHTML = `
      <div class="row between" style="align-items: flex-start;">
        <div class="grow">
          <div class="name">${escapeHtml(e.name)}</div>
          <div class="target">${last ? 'Last: ' + last.join(' · ') : (isTime ? 'New — log seconds held per set' : 'New — log reps per set, pick a count you can finish with good form')}</div>
        </div>
        ${e.durationMin ? `<span class="set-pill" style="background: var(--panel2); color: var(--accent2); border: 1px solid var(--accent2); gap: 4px; align-self: center; margin-right: 4px;">⏱ ${_fmtTimer(e.durationMin * 60000)} <button onclick="clearExerciseDuration(${idx})" style="background:none;border:none;cursor:pointer;padding:0;font-size:13px;color:var(--muted);line-height:1;">×</button></span>` : ''}
        <button class="icon ghost" onclick="removeExercise(${idx})" aria-label="Remove">✕</button>
        <button class="icon" onclick="openSet(${idx})">+</button>
      </div>
      <div class="sets">
        ${e.sets.length === 0 ? '<span class="set-pill empty">No sets yet</span>' : e.sets.map((s, si) => `<span class="set-pill" onclick="editSet(${idx},${si})">${s.reps}</span>`).join('')}
      </div>
      <div class="row" style="gap: 6px; align-items: stretch; margin-top: 8px;">
        <button class="chat-icon-btn" onclick="openExercisePhotoAnalyze(${idx})" aria-label="Attach photo" title="Attach a screenshot to auto-fill notes"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></button>
        <textarea placeholder="Notes (weight, form, RPE…)" rows="1" enterkeyhint="enter" oninput="updateExerciseNote(${idx}, this.value); autoResizeTA(this)" style="flex: 1; background: var(--panel2); font-size: 13px; padding: 8px 10px; resize: none; overflow-y: auto; max-height: 140px; min-height: 36px; line-height: 1.4;">${escapeHtml(e.note || '')}</textarea>
      </div>
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
