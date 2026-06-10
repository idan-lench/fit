import { state, save } from '../data/state.js';
import { todayISO, formatDate, _isoDate } from '../core/time.js';
import { escapeHtml, blobToDataUrl } from '../core/format.js';
import { toast, hideToast } from '../core/dom.js';
import { putPhoto, getAllPhotos, deletePhoto } from '../data/photo-store.js';
import { getGeminiKey, geminiGenerate } from '../integrations/gemini.js';
import { photoSizeKey } from '../integrations/drive-sync.js';
import { upsertStep, removeStep } from '../domain/steps.js';
import { upsertMeasurement, removeMeasurement, upsertWeight, removeWeight, latestWeightKg } from '../domain/body.js';
import { drawChart, drawStepsChart } from './shared/chart.js';
import { downscale } from './shared/image.js';
import { getTrendMode } from './insights-tab.js';
import { renderWorkout, workoutCurrentDate } from './workout-tab.js';

// ---------- MODULE STATE ----------
let selectedForCompare = [];

// ---------- BODY / WAIST ----------
export function renderBody() {
  const waistGoal = state.profile?.goals?.waistCm || 75;
  renderCompareHistory();
  const dateInput = document.getElementById('weightDate');
  if (dateInput && !dateInput.value) dateInput.value = todayISO();
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
    dEl.textContent = ' ';
    dEl.className = 'delta';
  }

  const goalEl = document.getElementById('waistToGoal');
  const goalDeltaEl = document.getElementById('waistGoalDelta');
  if (last) {
    const toGoal = last.cm - waistGoal;
    if (toGoal <= 0) {
      goalEl.textContent = '✓';
      goalEl.style.color = 'var(--accent2)';
      goalDeltaEl.textContent = `${waistGoal} cm ✓`;
      goalDeltaEl.className = 'delta down';
    } else {
      goalEl.textContent = toGoal.toFixed(1) + ' cm';
      goalEl.style.color = '';
      goalDeltaEl.textContent = `to ${waistGoal} cm`;
      goalDeltaEl.className = 'delta muted';
    }
  } else {
    goalEl.textContent = '—';
    goalDeltaEl.textContent = ' ';
  }

  drawChart(document.getElementById('waistChart'), ms);
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

  renderWeight();
  renderSteps();
}

export function toggleWaistEdit() {
  const list = document.getElementById('waistList');
  const btn = document.getElementById('waistEditBtn');
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  btn.textContent = open ? '✏ Edit' : '✓ Done';
}

export function addWaist() {
  const v = parseFloat(document.getElementById('waistInput').value);
  const d = document.getElementById('weightDate').value || todayISO();
  if (isNaN(v) || v <= 0) return toast('Enter a number');
  state.measurements = upsertMeasurement(state.measurements, d, v);
  save();
  document.getElementById('waistInput').value = '';
  renderBody();
  toast('Saved ✓');
}

// ---------- WEIGHT ----------
export function renderWeight() {
  const ws = (state.weights || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const last  = ws[ws.length - 1];
  const first = ws[0];

  document.getElementById('weightNow').textContent = last ? last.kg.toFixed(1) + ' kg' : '—';
  const dEl = document.getElementById('weightDelta');
  if (last && first && first !== last) {
    const d = last.kg - first.kg;
    dEl.textContent = (d >= 0 ? '+' : '') + d.toFixed(1) + ' kg vs start';
    dEl.className = 'delta ' + (d < 0 ? 'down' : 'up');
  } else {
    dEl.textContent = ' ';
    dEl.className = 'delta';
  }

  drawChart(document.getElementById('weightChart'), ws, w => w.kg);
  document.getElementById('weightList').innerHTML = ws.length === 0
    ? '<div class="muted small">No entries yet.</div>'
    : ws.slice().reverse().map(w => `
        <div class="row between" style="padding:6px 2px; border-bottom:1px solid var(--line);">
          <span class="small">${formatDate(w.date)}</span>
          <span class="row" style="gap:6px;">
            <b style="font-variant-numeric: tabular-nums; margin-right: 4px;">${w.kg.toFixed(1)} kg</b>
            <button class="icon ghost" onclick="editWeight('${w.date}')" aria-label="Edit">✏</button>
            <button class="icon ghost" onclick="removeWeightEntry('${w.date}')" aria-label="Remove">✕</button>
          </span>
        </div>
      `).join('');
}

export function addWeight() {
  const v = parseFloat(document.getElementById('weightInput').value);
  const d = document.getElementById('weightDate').value || todayISO();
  if (isNaN(v) || v <= 0) return toast('Enter a number');
  state.weights = upsertWeight(state.weights, d, v);
  // keep profile in sync so calorie engine always has latest
  if (!state.profile) state.profile = {};
  state.profile.weightKg = latestWeightKg(state.weights);
  save();
  document.getElementById('weightInput').value = '';
  renderWeight();
  toast('Saved ✓');
}

export function removeWeightEntry(date) {
  if (!confirm('Remove this entry?')) return;
  state.weights = removeWeight(state.weights, date);
  const latest = latestWeightKg(state.weights);
  if (state.profile) state.profile.weightKg = latest ?? state.profile.weightKg;
  save();
  renderWeight();
}

export function editWeight(date) {
  const w = (state.weights || []).find(x => x.date === date);
  if (!w) return;
  document.getElementById('weightInput').value = w.kg;
  document.getElementById('weightDate').value = w.date;
  document.getElementById('weightInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('weightInput').focus();
}

export function toggleWeightEdit() {
  const list = document.getElementById('weightList');
  const btn  = document.getElementById('weightEditBtn');
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  btn.textContent = open ? '✏ Edit' : '✓ Done';
}

export function removeWaist(date) {
  if (!confirm('Remove this measurement?')) return;
  state.measurements = removeMeasurement(state.measurements, date);
  save();
  renderBody();
}

export function editWaist(date) {
  const m = state.measurements.find(x => x.date === date);
  if (!m) return;
  document.getElementById('waistInput').value = m.cm;
  document.getElementById('weightDate').value = m.date;
  document.getElementById('waistInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('waistInput').focus();
}

// ---------- STEPS ----------
export function saveWorkoutSteps() {
  const v = parseInt(document.getElementById('workoutStepsInput').value, 10);
  const d = workoutCurrentDate();
  if (isNaN(v) || v <= 0) return toast('Enter a number');
  state.steps = upsertStep(state.steps, d, v);
  save();
  renderWorkout();
  toast('Steps saved ✓');
}

export function removeSteps(date) {
  if (!confirm('Remove this entry?')) return;
  state.steps = removeStep(state.steps, date);
  save();
  renderBody();
}

export function editStepsEntry(date) {
  const s = state.steps.find(x => x.date === date);
  if (!s) return;
  document.getElementById('stepsInput').value = s.count;
  document.getElementById('stepsDate').value = s.date;
  document.getElementById('stepsInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('stepsInput').focus();
}

export function renderSteps() {
  const stepsGoal = state.profile?.goals?.steps || 10000;
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
    const pct = Math.round((todayEntry.count / stepsGoal) * 100);
    const hit = todayEntry.count >= stepsGoal;
    progEl.innerHTML = `<span style="color: ${hit ? 'var(--accent2)' : 'var(--muted)'};">${pct}% of ${stepsGoal.toLocaleString()}${hit ? ' ✓' : ''}</span>`;
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
  const days = getTrendMode() === 'month' ? 30 : 7;
  const todayDt = new Date();
  let rangeSS = [];
  const byDate = new Map(ss.map(s => [s.date, s]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayDt); d.setDate(todayDt.getDate() - i);
    const iso = _isoDate(d);
    rangeSS.push(byDate.get(iso) || { date: iso, count: null });
  }
  const firstIdx = rangeSS.findIndex(s => typeof s.count === 'number');
  if (firstIdx > 0) rangeSS = rangeSS.slice(firstIdx);
  drawStepsChart(document.getElementById('stepsChart'), rangeSS, stepsGoal);

  const list = document.getElementById('stepsList');
  list.innerHTML = ss.length === 0
    ? '<div class="muted small">No step entries yet.</div>'
    : ss.slice().reverse().slice(0, 14).map(s => `
        <div class="row between" style="padding:6px 2px; border-bottom:1px solid var(--line);">
          <span class="small">${formatDate(s.date)}</span>
          <span class="row" style="gap: 6px;">
            <b style="font-variant-numeric: tabular-nums; margin-right: 4px; ${s.count >= stepsGoal ? 'color: var(--accent2);' : ''}">${s.count.toLocaleString()}</b>
            <button class="icon ghost" onclick="editStepsEntry('${s.date}')" aria-label="Edit">✏</button>
            <button class="icon ghost" onclick="removeSteps('${s.date}')" aria-label="Remove">✕</button>
          </span>
        </div>
      `).join('');
}

export function toggleStepsEdit() {
  const list = document.getElementById('stepsList');
  const btn = document.getElementById('stepsEditBtn');
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  btn.textContent = open ? '✏ Edit' : '✓ Done';
}

// ---------- PHOTOS ----------
export async function onPhotoPicked(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  toast('Saving…', { persistent: true });
  try {
    for (const file of files) {
      const blob = await downscale(file, 1280);
      await putPhoto(blob, todayISO());
    }
    e.target.value = '';
    hideToast();
    toast(files.length > 1 ? `${files.length} photos saved ✓` : 'Photo saved ✓');
    renderPhotos();
  } catch (err) {
    hideToast();
    toast('Upload failed: ' + (err.message || 'unknown error'));
  }
}

export async function renderPhotos() {
  const photos = await getAllPhotos();
  const grid = document.getElementById('photoGrid');
  const empty = document.getElementById('photoEmpty');
  grid.style.display = photos.length ? '' : 'none';
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
  const dates = [...new Set(photos.map(p => p.date))].sort();
  const btn = document.getElementById('compareAnalyzeBtn');
  if (btn) btn.style.display = (dates.length >= 2 && getGeminiKey()) ? 'block' : 'none';
  const hint = document.getElementById('compareHint');
  if (hint) {
    if (dates.length < 2) {
      hint.textContent = dates.length === 0 ? 'Add photos to track your progress.' : 'Add photos on another date to enable comparison.';
      hint.style.display = 'block';
    } else {
      hint.textContent = `${dates.length} dates — comparing ${formatDate(dates[0])} vs ${formatDate(dates[dates.length - 1])}`;
      hint.style.display = 'block';
    }
  }
}


export async function analyzePhotoComparison() {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const photos = await getAllPhotos();
  const dates = [...new Set(photos.map(p => p.date))].sort();
  if (dates.length < 2) return toast('Need photos on at least 2 different dates');
  const earlier = { date: dates[0],               photos: photos.filter(p => p.date === dates[0]) };
  const later   = { date: dates[dates.length - 1], photos: photos.filter(p => p.date === dates[dates.length - 1]) };
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

export function deleteCompareAnalysis(id) {
  if (!confirm('Delete this comparison?')) return;
  state.compareAnalyses = (state.compareAnalyses || []).filter(a => a.id !== id);
  save();
  renderCompareHistory();
}

export async function removePhoto(id) {
  if (!confirm('Delete this photo?')) return;
  await deletePhoto(id);
  selectedForCompare = selectedForCompare.filter(x => x !== id);
  renderPhotos();
}

export async function dedupePhotos() {
  const all = await getAllPhotos();
  if (all.length === 0) return toast('No photos to clean up');
  const seen = new Map();
  const toDelete = [];
  for (const p of all) {
    const key = photoSizeKey(p.date, p.blob.size);
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
  renderPhotos();
}
