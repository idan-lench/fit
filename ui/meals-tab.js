import { state } from '../data/state.js';
import { todayISO } from '../core/time.js';
import { escapeHtml, blobToDataUrl, parseJSONResponse } from '../core/format.js';
import { toast, hideToast, autoResizeTA } from '../core/dom.js';
import { getMeal, getAllMeals, putMeal, deleteMeal } from '../data/meals-store.js';
import { putTemplate, getAllTemplates, getTemplate, deleteTemplate } from '../data/template-store.js';
import { mealBlobs, recomputeMealTotals, reconcileMealTotals, autoAnalyzeMeal } from '../domain/meals.js';
import { applyTemplateDelta } from '../domain/templates.js';
import { getGeminiKey, geminiGenerate } from '../integrations/gemini.js';
import { downscale } from './shared/image.js';
import { attachFilesTo, renderAttachPreview } from './shared/chat-input.js';
import { PROMPTS } from '../prompts/index.js';

// Cross-tab render (insights tab lives in app.js for now).
const refreshInsights = () => window.renderAnalysis?.();

// ---------- MODULE STATE ----------
let pendingMealBlobs = [];
let editingMealId = null;
let _pendingTemplate = null;
let _pendingRefine = null;
let _mealChatHistory = []; // [{role: 'user'|'model', text}]
let _mealChatId = null;
let _mealAttachedImages = [];

// ---------- MEAL MODAL ----------
export async function openMealModal(mealId = null, triggerReanalyze = false) {
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
      deltaSec.style.display = 'none';
    }
  }
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
  if (_mealChatId !== editingMealId) {
    resetMealChat();
    if (mealId && getGeminiKey()) {
      getMeal(mealId).then(m => {
        if (!m) return;
        _mealChatId = mealId;
        if (m.chatHistory && m.chatHistory.length) {
          const updateClaims = /\b(i('ve| have) (updated|adjusted|set|changed|saved)|it'?s (already |now )?set to|done[,.]?\s*i('ve| have))/i;
          _mealChatHistory = m.chatHistory.filter(msg =>
            msg.role !== 'model' || !updateClaims.test(msg.text)
          );
        } else if (m.questions && m.questions.length) {
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

export function closeMealModal() {
  document.getElementById('mealModal').classList.remove('show');
  pendingMealBlobs = [];
  editingMealId = null;
  _pendingTemplate = null;
  const delta = document.getElementById('templateDeltaSection');
  if (delta) delta.style.display = 'none';
}

// ---------- TEMPLATES ----------
export async function quickSaveMealAsTemplate(mealId) {
  const meal = await getMeal(mealId);
  if (!meal) return toast('Meal not found');
  return _doSaveAsTemplate(meal);
}

export async function saveCurrentMealAsTemplate() {
  if (!editingMealId) return toast('Save the meal first');
  const meal = await getMeal(editingMealId);
  if (!meal) return toast('Meal not found');
  return _doSaveAsTemplate(meal);
}

async function _doSaveAsTemplate(meal) {
  const defaultName = (meal.description || '').slice(0, 60) || 'My meal';
  const name = prompt('Template name:', defaultName);
  if (!name || !name.trim()) return;
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
  meal.templateId = tplId;
  await putMeal(meal);
  renderMeals();
  toast('Template saved ✓');
}

export async function openTemplatePicker() {
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

export function closeTemplatePicker() {
  document.getElementById('templatePickerModal').classList.remove('show');
}

export async function confirmDeleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  await deleteTemplate(id);
  openTemplatePicker();
}

export async function openTemplateEdit(id) {
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

export function closeTemplateEdit() {
  document.getElementById('templateEditModal').classList.remove('show');
  openTemplatePicker();
}

export async function saveTemplateEdit() {
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

export async function useTemplate(id) {
  const tpl = await getTemplate(id);
  if (!tpl) return toast('Template not found');
  closeTemplatePicker();
  const mealModal = document.getElementById('mealModal');
  if (!mealModal.classList.contains('show')) {
    await openMealModal();
  }
  document.getElementById('mealDescInput').value = tpl.description || '';
  autoResizeTA(document.getElementById('mealDescInput'));
  document.getElementById('mealCalInput').value = tpl.calories || '';
  document.getElementById('mealProteinInput').value = (typeof tpl.protein === 'number') ? tpl.protein : '';
  if (Array.isArray(tpl.dataUrls) && tpl.dataUrls.length) {
    pendingMealBlobs = await Promise.all(tpl.dataUrls.map(async u => (await fetch(u)).blob()));
    renderMealPreview();
  }
  _pendingTemplate = {
    calories: tpl.calories,
    protein: tpl.protein,
    breakdown: tpl.breakdown || [],
    confidence: tpl.confidence,
    aiSaw: tpl.aiSaw,
    sourceTemplateId: id
  };
  tpl.lastUsed = Date.now();
  await putTemplate(tpl);
  document.getElementById('templateDeltaSection').style.display = 'block';
  document.getElementById('templateDeltaInput').value = '';
  toast(`Template "${tpl.name}" loaded — describe changes (if any) then Save`);
}

// ---------- PHOTO PREVIEW ----------
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

export function removePendingMealPhoto(i) {
  pendingMealBlobs.splice(i, 1);
  renderMealPreview();
}

export async function onMealPhotoSelected(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  for (const file of files) {
    const blob = await downscale(file, 1280);
    pendingMealBlobs.push(blob);
  }
  renderMealPreview();
  e.target.value = '';
}

// ---------- SAVE ----------
export async function saveMeal() {
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
    if (_pendingTemplate) {
      const deltaText = (document.getElementById('templateDeltaInput')?.value || '').trim();
      let useBreakdown = _pendingTemplate.breakdown;
      let useCalories = _pendingTemplate.calories;
      let useProtein  = _pendingTemplate.protein;
      let useAiSaw = 'From template — same breakdown as the saved template (no new analysis).';
      if (deltaText && getGeminiKey()) {
        toast('Applying changes…', { persistent: true });
        try {
          const adjusted = await applyTemplateDelta(_pendingTemplate, deltaText);
          if (adjusted) {
            useBreakdown = adjusted.items || useBreakdown;
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
  if (getGeminiKey() && savedId && !usedTemplate) {
    const meal = await getMeal(savedId);
    if (meal && !meal.calories) setTimeout(async () => { const ok = await autoAnalyzeMeal(savedId); if (ok) { renderMeals(); refreshInsights(); } }, 800);
  }
}

// ---------- MEAL LIST ----------
export async function renderMeals() {
  await reconcileMealTotals();
  const meals = await getAllMeals();
  const proteinGoal = state.profile?.goals?.dailyProteinG || 120;
  const list = document.getElementById('mealList');
  const empty = document.getElementById('mealEmpty');
  empty.style.display = meals.length ? 'none' : 'block';
  list.innerHTML = '';

  const today = todayISO();
  const todayMeals = meals.filter(m => m.date === today);
  const proteinToday = todayMeals.reduce((sum, m) => sum + (typeof m.protein === 'number' ? m.protein : 0), 0);
  const mealsWithProtein = todayMeals.filter(m => typeof m.protein === 'number' && m.protein > 0).length;
  const proteinBarEl = document.getElementById('proteinBar');
  if (proteinBarEl) {
    if (mealsWithProtein > 0) {
      proteinBarEl.style.display = 'block';
      const pct = Math.min(100, Math.round(proteinToday / proteinGoal * 100));
      const remaining = proteinGoal - proteinToday;
      document.getElementById('proteinBarLabel').textContent = `${proteinToday}g / ${proteinGoal}g`;
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

    let dayGroup;
    if (isToday) {
      dayGroup = document.createElement('div');
      dayGroup.style.cssText = 'margin-top: 18px;';
      const header = document.createElement('div');
      header.className = 'muted small';
      header.style.cssText = 'margin-bottom: 8px; font-weight: 500; display: flex; justify-content: space-between; align-items: baseline;';
      header.innerHTML = `<span>Today</span>${summaryRight}`;
      dayGroup.appendChild(header);
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

export async function removeMeal(id) {
  if (!confirm('Delete this meal?')) return;
  await deleteMeal(id);
  renderMeals();
}

// ---------- RE-ANALYZE ----------
export async function reanalyzeMeal() {
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
    refreshInsights();
  }
}

export async function reanalyzeMealInPlace(mealId) {
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
  refreshInsights();
}

// ---------- MEAL REFINE CHAT ----------
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

export async function refineMealEstimate() {
  const text = document.getElementById('refineInput').value.trim();
  if (!text && _mealAttachedImages.length === 0) return toast('Type a message first');
  if (!editingMealId) return toast('Open a meal first');
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const meal = await getMeal(editingMealId);
  if (!meal) return;

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

    const contents = [];
    for (let i = _mealChatHistory.length - 1; i >= 0; i--) {
      const m = _mealChatHistory[i];
      const parts = [{ text: m.text || '' }];
      if (m.role === 'user') {
        if (blobs.length) {
          for (const blob of blobs) {
            const dataUrl = await blobToDataUrl(blob);
            parts.push({ inline_data: { mime_type: blob.type || 'image/jpeg', data: dataUrl.split(',')[1] } });
          }
        }
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

export async function requestMealEstimateUpdate() {
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

export function renderMealRefineChat() {
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
      html += `<div style="margin: 6px 0; padding: 10px 12px; border-radius: 14px 14px 14px 4px; background: var(--panel); border: 1px solid var(--line); max-width: 95%; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(m.text)}</div>`;
    }
  }
  html += '</div>';
  if (_pendingRefine && typeof _pendingRefine.total === 'number') {
    html += `<div style="margin-top: 12px; padding: 12px; background: rgba(16, 185, 129, 0.12); border-left: 3px solid var(--accent2); border-radius: 8px;">
      <div class="muted small" style="text-transform: uppercase; letter-spacing: 0.5px;">Proposed estimate</div>
      <div style="font-size: 22px; font-weight: 700; margin: 4px 0;">${_pendingRefine.total} kcal${_pendingRefine.totalProtein != null ? ` · <span style="color: var(--accent2)">${_pendingRefine.totalProtein}g protein</span>` : ''}</div>
      ${_pendingRefine.changeNote ? `<div class="small" style="font-style: italic; margin-bottom: 6px;">${escapeHtml(_pendingRefine.changeNote)}</div>` : ''}
      ${(_pendingRefine.items || []).map(i => `<div class="small" style="padding: 1px 0;">• ${escapeHtml(i.name)} (${escapeHtml(i.portion || '')}): ${i.calories} kcal${i.protein != null ? ` · ${i.protein}g` : ''}</div>`).join('')}
      <div class="row" style="margin-top: 10px; gap: 6px;">
        <button class="primary grow" onclick="applyRefineResult()">Apply ${_pendingRefine.total} kcal${_pendingRefine.totalProtein != null ? ` / ${_pendingRefine.totalProtein}g` : ''}</button>
        <button class="ghost" onclick="discardMealRefine()">Discard</button>
      </div>
    </div>`;
  }
  div.innerHTML = html;
  const inner = div.querySelector('div[style*="max-height"]');
  if (inner) inner.scrollTop = inner.scrollHeight;
  const modal = document.getElementById('mealModal');
  if (modal) setTimeout(() => modal.scrollTop = modal.scrollHeight, 50);
}

export function discardMealRefine() {
  _pendingRefine = null;
  renderMealRefineChat();
}

export async function applyRefineResult() {
  if (!_pendingRefine || !editingMealId) return;
  const meal = await getMeal(editingMealId);
  if (!meal) return;
  meal.calories = _pendingRefine.total;
  if (_pendingRefine.totalProtein != null) meal.protein = _pendingRefine.totalProtein;
  meal.breakdown = _pendingRefine.items || [];
  meal.aiSaw = _pendingRefine.saw || meal.aiSaw;
  meal.confidence = _pendingRefine.confidence || meal.confidence;
  meal.questions = [];
  await putMeal(meal);
  const calInput = document.getElementById('mealCalInput');
  const protInput = document.getElementById('mealProteinInput');
  if (calInput) calInput.value = meal.calories ?? '';
  if (protInput) protInput.value = meal.protein ?? '';
  toast('Updated ✓');
  _pendingRefine = null;
  renderMealRefineChat();
  renderMeals();
}

// ---------- ATTACHMENTS ----------
export function mealAttachFiles(input) { attachFilesTo(_mealAttachedImages, input, renderMealAttachPreview); }
export function renderMealAttachPreview() { renderAttachPreview('mealAttachPreview', _mealAttachedImages, '_removeMealAttach'); }
export function _removeMealAttach(i) { _mealAttachedImages.splice(i, 1); renderMealAttachPreview(); }
