import { state, save } from '../data/state.js';
import { toast } from '../core/dom.js';
import { getGeminiKey } from '../integrations/gemini.js';
import { ensureSecret, buildAppsScript, pingSync, exportData } from '../integrations/drive-sync.js';
import { gfitGetToken, gfitDateRange, gfitAggregate, gfitExtractInt, gfitExtractFloat, clearCachedGfitToken } from '../integrations/google-fit.js';
import { clearPhotos, putPhoto } from '../data/photo-store.js';
import { clearMeals, putMeal } from '../data/meals-store.js';
import { selectDay, renderWorkout, workoutCurrentDate } from './workout-tab.js';
import { renderBody, renderPhotos } from './body-tab.js';
import { renderMeals } from './meals-tab.js';

// ---------- SETTINGS MODAL ----------
export function openSettings() {
  document.getElementById('settingsModal').classList.add('show');
  refreshSyncStatus();
  const k = document.getElementById('geminiKeyInput');
  if (k) k.value = getGeminiKey();
}

export function closeSettings() {
  document.getElementById('settingsModal').classList.remove('show');
}

// Full backup (with photos): uploads to Drive if sync is configured, else
// downloads locally. Reads state here (not in the inline onclick) since state
// is module-scoped, not a global.
export function fullBackup() {
  return exportData({
    cloud: !!state.sync?.webhookUrl,
    local: !state.sync?.webhookUrl,
    includePhotos: true,
  });
}

// ---------- DRIVE SYNC (UI) ----------
// Pure sync logic lives in integrations/drive-sync.js.
export function openSyncSetup() {
  const secret = ensureSecret();
  document.getElementById('webhookUrlInput').value = state.sync?.webhookUrl || '';
  document.getElementById('folderIdInput').value = state.sync?.folderId || '';
  document.getElementById('secretInput').value = secret;
  document.getElementById('appsScriptCode').value = buildAppsScript(secret);
  document.getElementById('settingsModal').classList.remove('show');
  document.getElementById('syncModal').classList.add('show');
  document.getElementById('folderIdInput').oninput = () => {
    state.sync = state.sync || {};
    state.sync.folderId = document.getElementById('folderIdInput').value.trim();
    save();
    document.getElementById('appsScriptCode').value = buildAppsScript(secret);
  };
}

export function copySecret() {
  const v = document.getElementById('secretInput').value.trim();
  if (!v) return toast('No secret to copy');
  navigator.clipboard.writeText(v).then(
    () => toast('Secret copied ✓'),
    () => toast('Copy failed — select and copy manually')
  );
}

export function showSyncQR() {
  const url = document.getElementById('webhookUrlInput').value.trim();
  const secret = document.getElementById('secretInput').value.trim();
  const folderId = document.getElementById('folderIdInput').value.trim();
  if (!url || !secret) return toast('Fill in URL and secret first');
  const cfg = btoa(JSON.stringify({ folderId, webhookUrl: url, secret }));
  const targetUrl = location.origin + location.pathname + '#sync=' + cfg;
  const qrSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=' + encodeURIComponent(targetUrl);
  const img = document.getElementById('syncQrImg');
  img.src = qrSrc;
  document.getElementById('syncQrUrl').textContent = targetUrl.length > 80 ? targetUrl.slice(0, 80) + '…' : targetUrl;
  document.getElementById('syncQrModal').classList.add('show');
}

export function closeSyncQR() {
  document.getElementById('syncQrModal').classList.remove('show');
}

export function closeSyncSetup() {
  document.getElementById('syncModal').classList.remove('show');
  document.getElementById('settingsModal').classList.add('show');
  refreshSyncStatus();
}

export function copyScript() {
  const ta = document.getElementById('appsScriptCode');
  ta.select(); ta.setSelectionRange(0, 999999);
  navigator.clipboard.writeText(ta.value).then(
    () => toast('Code copied ✓'),
    () => { document.execCommand('copy'); toast('Code copied ✓'); }
  );
}

export async function saveAndTestSync() {
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

export async function testSync() {
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

// ---------- IMPORT / WIPE ----------
export async function importData(e) {
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

export async function wipeAll() {
  state.sessions = []; state.measurements = []; state.current = null; state.steps = [];
  save();
  await clearPhotos();
  await clearMeals();
  closeSettings();
  selectDay();
  renderBody();
  renderPhotos();
  renderMeals();
  toast('All data erased');
}

// ---------- GOOGLE FIT (UI) ----------
export async function syncGoogleFit() {
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

    if (steps > 0) {
      state.steps = state.steps || [];
      state.steps = state.steps.filter(s => s.date !== date);
      state.steps.push({ date, count: steps, source: 'gfit' });
      save();
    }

    const stepsInput = document.getElementById('workoutStepsInput');
    if (stepsInput && steps > 0) stepsInput.value = steps;
    renderWorkout();
    renderBody();

    let msg = steps > 0 ? `${steps.toLocaleString()} steps` : 'No steps data';
    if (distKm > 0) msg += ` · ${distKm} km walked/run`;
    status.textContent = `✓ Synced: ${msg}`;

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
    // Self-heal: a 401/403 means the cached token is dead (expired, revoked, or
    // project changed). Clear it so the next Sync re-runs the OAuth popup.
    if (String(e.message || '').match(/40[13]|invalid|expired|forbidden/i)) {
      clearCachedGfitToken();
      status.textContent = 'Session expired — tap Sync again to reconnect';
    } else {
      status.textContent = e.message.includes('popup') ? 'Popup blocked — allow popups for this site' : `Error: ${e.message}`;
    }
    toast('Google Fit sync failed', 3000);
  } finally {
    btn.disabled = false;
    btn.textContent = '🏃 Sync';
  }
}
