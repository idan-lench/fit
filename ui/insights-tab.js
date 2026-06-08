import { state } from '../data/state.js';
import { getDailyNote } from '../data/daily-notes-store.js';
import { todayISO, formatDate, _isoDate } from '../core/time.js';
import { escapeHtml } from '../core/format.js';
import { toast } from '../core/dom.js';
import { getAllMeals } from '../data/meals-store.js';
import { PLAN } from '../domain/plan.js';
import { computeDailyEnergy, weekStartFor, weekDates, weeklyFingerprint, runWeeklyAnalysis } from '../domain/analysis.js';
import { getGeminiKey } from '../integrations/gemini.js';

// Steps chart lives in the body tab (app.js for now).
const refreshSteps = () => window.renderSteps?.();

// ---------- MODULE STATE ----------
let analysisViewDate = null; // null = today
let analysisMode = 'day';    // 'day' or 'week'
let trendMode = 'week';      // 'day' | 'week' | 'month'

// The steps chart (body tab) follows this Day/Week/Month toggle.
export const getTrendMode = () => trendMode;

// ---------- TREND CHART ----------
export function setTrendMode(m) {
  trendMode = m;
  ['day','week','month'].forEach(k => {
    const b = document.getElementById('trendMode' + k.charAt(0).toUpperCase() + k.slice(1));
    if (b) b.classList.toggle('on', m === k);
  });
  drawEnergyChart('analysisChart');
  refreshSteps();
}

// Build the dual-axis nutrition trend chart (Day = cumulative hourly; Week/Month = daily totals).
async function drawEnergyChart(elementId = 'analysisChart') {
  const el = document.getElementById(elementId);
  if (!el) return;
  const caption = document.getElementById('trendChartCaption');
  ['day','week','month'].forEach(k => {
    const b = document.getElementById('trendMode' + k.charAt(0).toUpperCase() + k.slice(1));
    if (b) b.classList.toggle('on', trendMode === k);
  });
  if (trendMode === 'day') return drawDayTrend(el, caption);
  const days = trendMode === 'month' ? 30 : 7;
  return drawRangeTrend(el, caption, days);
}

async function drawDayTrend(el, caption) {
  const calGoal = state.profile?.goals?.dailyCalories || 2000;
  const proteinGoal = state.profile?.goals?.dailyProteinG || 120;
  const meals = (await getAllMeals()).filter(m => m.date === todayISO()).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const w = 600, h = 220, padL = 38, padR = 38, padB = 28, padT = 14;
  let accCal = 0, accProt = 0;
  const pts = [{ h: 0, cal: 0, p: 0 }];
  for (const m of meals) {
    if (!m.time) continue;
    const [hh, mm] = m.time.split(':').map(Number);
    const hr = hh + (mm || 0) / 60;
    accCal += m.calories || 0;
    accProt += (typeof m.protein === 'number' ? m.protein : 0);
    pts.push({ h: hr, cal: accCal, p: accProt });
  }
  const nowH = new Date().getHours() + new Date().getMinutes() / 60;
  pts.push({ h: Math.max(nowH, pts[pts.length-1].h), cal: accCal, p: accProt });

  const xMin = 0, xMax = 24;
  const calMax = Math.max(2000, accCal * 1.15);
  const protMax = Math.max(120, accProt * 1.15);
  const xScale = hr => padL + (hr - xMin) / (xMax - xMin) * (w - padL - padR);
  const yScaleCal = v => h - padB - (v / calMax) * (h - padB - padT);
  const yScaleProt = v => h - padB - (v / protMax) * (h - padB - padT);

  const calPath = 'M ' + pts.map(p => `${xScale(p.h).toFixed(1)},${yScaleCal(p.cal).toFixed(1)}`).join(' L ');
  const pPath   = 'M ' + pts.map(p => `${xScale(p.h).toFixed(1)},${yScaleProt(p.p).toFixed(1)}`).join(' L ');

  const hourTicks = [0, 4, 8, 12, 16, 20, 24].map(hr => `<line x1="${xScale(hr)}" y1="${padT}" x2="${xScale(hr)}" y2="${hr===0||hr===24?hr:hr-padB}" stroke="var(--line)" stroke-dasharray="2,3" opacity="0.5"/><text x="${xScale(hr)}" y="${220 - padB + 14}" fill="var(--muted)" font-size="10" text-anchor="middle">${String(hr).padStart(2,'0')}:00</text>`).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height: 220px; width: 100%;">
      ${hourTicks}
      ${[0, calMax/2, calMax].map(v => `<text x="${padL-4}" y="${yScaleCal(v)+3}" fill="var(--accent)" font-size="10" text-anchor="end">${Math.round(v)}</text>`).join('')}
      ${[0, protMax/2, protMax].map(v => `<text x="${w-padR+4}" y="${yScaleProt(v)+3}" fill="var(--accent2)" font-size="10" text-anchor="start">${Math.round(v)}g</text>`).join('')}
      <line x1="${padL}" y1="${yScaleCal(calGoal)}" x2="${w-padR}" y2="${yScaleCal(calGoal)}" stroke="var(--accent)" stroke-dasharray="3,3" opacity="0.4"/>
      <line x1="${padL}" y1="${yScaleProt(proteinGoal)}" x2="${w-padR}" y2="${yScaleProt(proteinGoal)}" stroke="var(--accent2)" stroke-dasharray="3,3" opacity="0.4"/>
      <path d="${calPath}" stroke="var(--accent)" stroke-width="2.5" fill="none"/>
      <path d="${pPath}" stroke="var(--accent2)" stroke-width="2.5" fill="none"/>
      <line x1="${xScale(nowH)}" y1="${padT}" x2="${xScale(nowH)}" y2="${h-padB}" stroke="var(--muted)" stroke-dasharray="4,4" opacity="0.4"/>
    </svg>`;
  if (caption) caption.innerHTML = `<span style="color: var(--accent);">● ${Math.round(accCal)} kcal</span> &nbsp;·&nbsp; <span style="color: var(--accent2);">● ${Math.round(accProt)}g protein</span> — today, cumulative`;
}

// Week/Month: Net bar chart
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
  const firstIdx = data.findIndex(d => d.net !== null);
  if (firstIdx > 0) data = data.slice(firstIdx);
  if (data.length === 0) {
    el.innerHTML = '<div class="empty">No data yet for this range.</div>';
    if (caption) caption.textContent = '';
    return;
  }
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

// ---------- DAY / WEEK MODE ----------
export function setAnalysisMode(mode) {
  analysisMode = mode;
  document.getElementById('analysisModeDay').classList.toggle('on', mode === 'day');
  document.getElementById('analysisModeWeek').classList.toggle('on', mode === 'week');
  document.getElementById('analysisDayView').style.display = mode === 'day' ? 'block' : 'none';
  document.getElementById('analysisWeekView').style.display = mode === 'week' ? 'block' : 'none';
  renderAnalysis();
}

export function shiftAnalysisDate(delta) {
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

  const weeklyNote = (state.weeklyNotes || []).find(n => n.weekStart === weekStart);
  const notesEl = document.getElementById('weeklyNotes');
  if (notesEl) {
    if (weeklyNote) notesEl.innerHTML = '<div style="white-space: pre-wrap; line-height: 1.5;">' + escapeHtml(weeklyNote.note) + '</div>';
    else notesEl.innerHTML = '<div class="muted small">No weekly analysis yet. Tap the button above to generate one.</div>';
  }
}

export async function renderAnalysis() {
  if (analysisMode === 'week') {
    return renderWeekView();
  }
  const calGoal = state.profile?.goals?.dailyCalories || 2000;
  const proteinGoal = state.profile?.goals?.dailyProteinG || 120;
  refreshSteps();
  const today = todayISO();
  const viewDate = analysisViewDate || today;
  const isToday = viewDate === today;

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
        ? `${e.mealCount} meal${e.mealCount > 1 ? 's' : ''} · ${calGoal} goal`
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

  const proteinEl = document.getElementById('analysisProtein');
  if (proteinEl) {
    if (e.protein > 0) {
      const pct = Math.min(100, Math.round(e.protein / proteinGoal * 100));
      const remaining = proteinGoal - e.protein;
      const fillColor = pct >= 100 ? 'var(--accent2)' : pct >= 70 ? '#7ad1c3' : 'var(--accent)';
      proteinEl.innerHTML = `
        <div class="row between" style="margin-bottom: 5px;">
          <span class="muted small" style="text-transform: uppercase; letter-spacing: 0.5px;">Protein</span>
          <span class="small" style="font-weight: 600; color: var(--accent2);">${e.protein}g / ${proteinGoal}g</span>
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
      const epocLine = s.epocToday > 0 ? ` <span class="muted">(+${s.epocToday} EPOC)</span>` : '';
      html += `<div class="row between" style="padding: 4px 0; border-bottom: 1px solid var(--line);"><span class="small">${escapeHtml(label)}${epocLine}</span><span class="small">+${s.caloriesBurned + (s.epocToday || 0)} kcal</span></div>`;
    }
  }
  if (e.epocCarryIn > 0) {
    html += `<div class="row between" style="padding: 4px 0; border-bottom: 1px solid var(--line);"><span class="small muted">Afterburn from yesterday</span><span class="small">+${e.epocCarryIn} kcal</span></div>`;
  }
  html += `<div class="row between" style="padding: 6px 0 0; font-weight: 700;"><span>Total burned</span><span>${e.burned.toLocaleString()} kcal</span></div>`;
  breakdown.innerHTML = html;

  await drawEnergyChart('analysisChart');

  const viewNote = await getDailyNote(viewDate);

  const notesEl = document.getElementById('analysisNotes');
  if (viewNote) {
    notesEl.innerHTML = `<div style="white-space: pre-wrap; line-height: 1.6;">${escapeHtml(viewNote.note)}</div>`;
  } else {
    notesEl.innerHTML = `<div class="muted small">No summary for ${isToday ? 'today' : formatDate(viewDate)} yet. Tap the button above to generate one.</div>`;
  }
}

export async function generateWeeklyAnalysis() {
  if (!getGeminiKey()) return toast('Set up Gemini API key first');
  const viewDate = analysisViewDate || todayISO();
  const weekStart = weekStartFor(viewDate);
  const fp = await weeklyFingerprint(weekStart);
  await runWeeklyAnalysis({ weekStart, fingerprint: fp });
  renderAnalysis();
}
