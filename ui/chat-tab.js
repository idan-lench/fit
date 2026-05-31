import { state } from '../data/state.js';
import { todayISO } from '../core/time.js';
import { escapeHtml } from '../core/format.js';
import { autoResizeTA } from '../core/dom.js';
import { calcBMR } from '../core/profile.js';
import { getAllMeals } from '../data/meals-store.js';
import { getGeminiKey, setGeminiKey, geminiGenerate } from '../integrations/gemini.js';
import { attachFilesTo, renderAttachPreview } from './shared/chat-input.js';

// ---------- MODULE STATE ----------
let _aiAttachedImages = []; // [{dataUrl, mimeType}]

// Thin wrapper over setGeminiKey: trims pasted input (UI concern).
export function saveGeminiKey(v) { setGeminiKey((v || '').trim()); }

function aiHistory() {
  try { return JSON.parse(localStorage.getItem('fit.aiHistory') || '[]'); } catch { return []; }
}
function saveAiHistory(h) { localStorage.setItem('fit.aiHistory', JSON.stringify(h.slice(-30))); }

async function buildAIContext() {
  const p = state.profile;
  const meals = await getAllMeals();
  const mealSummary = meals.slice(0, 30).map(m => ({
    date: m.date, time: m.time,
    description: m.description || '(no description)',
    calories: m.calories || null
  }));
  const ctx = {
    user: {
      age: 44, sex: 'male', height_cm: 168, weight_kg: 58,
      bmr: calcBMR(p), dailyCalGoal: p?.goals?.dailyCalories, waistGoal: p?.goals?.waistCm,
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

async function callGemini(messages) {
  const PROMPTS = window.PROMPTS || {};
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

export function renderAI() {
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

export function aiAttachFiles(input) { attachFilesTo(_aiAttachedImages, input, renderAiAttachPreview); }
export function _removeAiAttach(i) { _aiAttachedImages.splice(i, 1); renderAiAttachPreview(); }
export function renderAiAttachPreview() { renderAttachPreview('aiAttachPreview', _aiAttachedImages, '_removeAiAttach'); }

export async function sendAIMessage() {
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

export function askAI(prompt) {
  const el = document.getElementById('aiInput');
  el.value = prompt;
  autoResizeTA(el);
  sendAIMessage();
}
