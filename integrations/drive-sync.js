// Google Drive backup/restore via an Apps Script webhook.
// The Apps Script acts as a thin "save/load JSON to your Drive" proxy.
// No Google Drive API credentials needed — auth is a shared SECRET string.
//
// CI gate: no other file may call state.sync.webhookUrl directly via fetch —
// see scripts/check-duplication.js.

import { todayISO } from '../core/time.js';
import { toast } from '../core/dom.js';
import { blobToDataUrl } from '../core/format.js';
import { state, save } from '../data/state.js';
import { getAllMeals, putMeal, clearMeals } from '../data/meals-store.js';
import { getAllPhotos, putPhoto, clearPhotos } from '../data/photo-store.js';
import { getAllTemplates, putTemplate } from '../data/template-store.js';

// Returns the shared secret, generating one if not set yet.
export function ensureSecret() {
  if (!state.sync) state.sync = {};
  if (!state.sync.secret) {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    state.sync.secret = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    save();
  }
  return state.sync.secret;
}

// POST payload to Drive via the Apps Script webhook.
export async function uploadToDrive(payload, filename) {
  const url = state.sync?.webhookUrl;
  const secret = state.sync?.secret;
  if (!url || !secret) return { ok: false, skipped: true };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret, filename, payload }),
      redirect: 'follow',
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { ok: res.ok, raw: text }; }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Ping webhook — returns { ok, pong } or { ok: false, error }.
export async function pingSync() {
  const url = state.sync?.webhookUrl;
  const secret = state.sync?.secret;
  if (!url || !secret) return { ok: false, error: 'not configured' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret, ping: true }),
      redirect: 'follow',
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: 'bad response: ' + text.slice(0, 80) }; }
  } catch (err) { return { ok: false, error: err.message }; }
}

// Pull latest backup from Drive and apply it locally.
// opts.silent: skip UI toasts/confirms and only apply if Drive is newer.
export async function pullFromDrive(opts = {}) {
  const url = state.sync?.webhookUrl;
  const secret = state.sync?.secret;
  if (!url || !secret) return { ok: false, skipped: true };
  const pullBtn = document.getElementById('syncPullBtn');
  const originalLabel = pullBtn?.textContent;
  if (!opts.silent) {
    if (typeof toast === 'function') toast('Pulling from Drive…', { persistent: true });
    if (pullBtn) { pullBtn.disabled = true; pullBtn.textContent = '⟳ Pulling…'; }
  }
  try {
    const res = await fetch(url + '?secret=' + encodeURIComponent(secret), {
      method: 'GET', redirect: 'follow',
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, error: 'bad response' }; }
    if (!data.ok) return data;
    const driveExportTime = data.payload?.exportedAt ? new Date(data.payload.exportedAt).getTime() : 0;
    const localExportTime = state.exportedAt ? new Date(state.exportedAt).getTime() : 0;
    if (opts.silent) {
      const driveTime = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
      const localSyncTime = state.lastSyncAt ? new Date(state.lastSyncAt).getTime() : 0;
      if (driveTime <= localSyncTime + 2000) return { ok: true, upToDate: true };
      if (driveExportTime <= localExportTime) {
        state.lastSyncAt = data.updatedAt;
        save();
        return { ok: true, noNewerData: true };
      }
    }
    if (!opts.silent && !confirm('Pull latest from Drive? This will replace local sessions, measurements, and steps.')) {
      return { ok: false, declined: true };
    }
    await applyDrivePayload(data.payload, data.updatedAt);
    if (!opts.silent) {
      if (typeof hideToast === 'function') hideToast();
      if (typeof toast === 'function') toast('Synced ✓');
    }
    return { ok: true, applied: true };
  } catch (err) {
    if (!opts.silent) {
      if (typeof hideToast === 'function') hideToast();
      if (typeof toast === 'function') toast('Pull failed: ' + err.message);
    }
    return { ok: false, error: err.message };
  } finally {
    if (!opts.silent && pullBtn) {
      pullBtn.disabled = false;
      pullBtn.textContent = originalLabel || '⬇ Pull latest from Drive';
    }
  }
}

// Stable dedup key for body photos: date + blob byte-size.
export function photoSizeKey(date, size) { return `${date}|${size}`; }

// Merge a Drive backup payload into local state + IDB stores.
export async function applyDrivePayload(payload, updatedAt) {
  state.sessions    = payload.sessions    || [];
  state.measurements = payload.measurements || [];
  state.steps       = payload.steps       || [];
  state.dailyNotes  = payload.dailyNotes  || [];
  if (payload.current !== undefined) state.current = payload.current;
  state.exportedAt  = payload.exportedAt;
  state.lastSyncAt  = updatedAt || new Date().toISOString();
  save();

  if (Array.isArray(payload.meals)) {
    const localMeals = await getAllMeals();
    const localByKey = new Map(localMeals.map(m => [`${m.date}|${m.time}|${m.created}`, m]));
    await clearMeals();
    for (const m of payload.meals) {
      const local = localByKey.get(`${m.date}|${m.time}|${m.created}`);
      let blobs = [];
      if (Array.isArray(m.dataUrls) && m.dataUrls.length) {
        blobs = await Promise.all(m.dataUrls.map(async u => (await fetch(u)).blob()));
      } else if (local) {
        blobs = Array.isArray(local.blobs) ? local.blobs : [];
      }
      await putMeal({
        date: m.date, time: m.time, created: m.created,
        description: m.description, calories: m.calories,
        protein: m.protein ?? null,
        breakdown: m.breakdown || [], confidence: m.confidence || null,
        aiSaw: m.aiSaw || null, questions: m.questions || [],
        blobs,
      });
    }
  }

  if (Array.isArray(payload.templates)) {
    const localTpls = await getAllTemplates();
    const localKeys = new Set(localTpls.map(t => `${t.name}|${t.created}`));
    for (const t of payload.templates) {
      if (localKeys.has(`${t.name}|${t.created}`)) continue;
      await putTemplate({
        name: t.name, description: t.description || '',
        calories: t.calories ?? null, protein: t.protein ?? null,
        breakdown: t.breakdown || [], confidence: t.confidence || null,
        aiSaw: t.aiSaw || null, dataUrls: t.dataUrls || [],
        created: t.created, lastUsed: t.lastUsed || null,
      });
    }
  }

  if (Array.isArray(payload.photos) && payload.photos.length) {
    const localPhotos = await getAllPhotos();
    const localKeys  = new Set(localPhotos.map(p => `${p.date}|${p.created}`));
    const remoteKeys = new Set(payload.photos.map(p => `${p.date}|${p.created}`));
    const inSync = [...localKeys].every(k => remoteKeys.has(k)) && [...remoteKeys].every(k => localKeys.has(k));
    if (!inSync) {
      await clearPhotos();
      for (const p of payload.photos) {
        if (p.dataUrl) {
          const blob = await (await fetch(p.dataUrl)).blob();
          await putPhoto(blob, p.date);
        }
      }
    }
  }
}

// Build + upload (or local-download) a full data export.
export async function exportData(opts = {}) {
  const { cloud = false, local = false, includePhotos = false } = opts;
  if (!cloud && !local) return;

  let payload = { ...state, exportedAt: new Date().toISOString() };
  const allMeals = await getAllMeals();
  const mealMeta = m => ({
    date: m.date, time: m.time, description: m.description,
    calories: m.calories, protein: m.protein ?? null, created: m.created,
    breakdown: m.breakdown || [], confidence: m.confidence || null,
    aiSaw: m.aiSaw || null, questions: m.questions || [],
  });

  payload.meals = allMeals.map(m => ({ ...mealMeta(m), dataUrls: [] }));

  const allTemplates = await getAllTemplates();
  payload.templates = allTemplates.map(t => ({
    name: t.name, description: t.description || '',
    calories: t.calories ?? null, protein: t.protein ?? null,
    breakdown: t.breakdown || [], confidence: t.confidence || null,
    aiSaw: t.aiSaw || null, dataUrls: t.dataUrls || [],
    created: t.created, lastUsed: t.lastUsed || null,
  }));

  if (includePhotos) {
    const photos = await getAllPhotos();
    payload.photos = await Promise.all(photos.map(async p => ({
      date: p.date, created: p.created, dataUrl: await blobToDataUrl(p.blob),
    })));
    payload.meals = await Promise.all(allMeals.map(async m => {
      const blobs = Array.isArray(m.blobs) ? m.blobs : [];
      return {
        ...mealMeta(m),
        dataUrls: await Promise.all(blobs.map(b => blobToDataUrl(b))),
      };
    }));
  }

  const filename = includePhotos ? `fit-full-${todayISO()}.json` : `fit-data-${todayISO()}.json`;

  if (local) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  if (cloud) {
    if (!state.sync?.webhookUrl) {
      if (typeof toast === 'function') toast('Set up Drive sync first');
      return;
    }
    if (typeof toast === 'function') toast('Uploading…');
    const res = await uploadToDrive(payload, filename);
    if (res.ok) { if (typeof toast === 'function') toast(local ? 'Saved + uploaded ✓' : 'Uploaded ✓'); }
    else { if (typeof toast === 'function') toast('Upload failed: ' + (res.error || 'unknown')); }
  } else if (local) {
    if (typeof toast === 'function') toast('Saved ✓');
  }
}

// Restore body photos specifically from the latest Drive backup.
export async function restorePhotosFromDrive() {
  if (!state.sync?.webhookUrl || !state.sync?.secret) {
    if (typeof toast === 'function') toast('Drive sync not configured');
    return;
  }
  if (typeof toast === 'function') toast('Fetching from Drive…', { persistent: true });
  try {
    const res = await fetch(state.sync.webhookUrl + '?secret=' + encodeURIComponent(state.sync.secret));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Drive error');
    const photos = data.payload?.photos || [];
    if (photos.length === 0) {
      if (typeof hideToast === 'function') hideToast();
      if (typeof toast === 'function') toast('No photos in the latest backup');
      return { restored: 0, skipped: 0 };
    }
    const existing = await getAllPhotos();
    const haveKeys = new Set(existing.map(p => photoSizeKey(p.date, p.blob.size)));
    let restored = 0, skipped = 0;
    for (const p of photos) {
      if (!p.dataUrl) { skipped++; continue; }
      const blob = await (await fetch(p.dataUrl)).blob();
      const key = photoSizeKey(p.date, blob.size);
      if (haveKeys.has(key)) { skipped++; continue; }
      await putPhoto(blob, p.date);
      haveKeys.add(key);
      restored++;
    }
    if (typeof hideToast === 'function') hideToast();
    if (typeof toast === 'function') toast(`Restored ${restored} photos (${skipped} already present) ✓`);
    return { restored, skipped };
  } catch (e) {
    if (typeof hideToast === 'function') hideToast();
    if (typeof toast === 'function') toast('Restore failed: ' + e.message);
    return { restored: 0, skipped: 0 };
  }
}

// Force-pull from Drive bypassing all timestamp/confirm guards.
// Used when local state is empty (first load on a new device / after data clear).
export async function pullFromDriveForce() {
  const url = state.sync?.webhookUrl;
  const secret = state.sync?.secret;
  if (!url || !secret) return { ok: false, skipped: true };
  try {
    const res = await fetch(url + '?secret=' + encodeURIComponent(secret), {
      method: 'GET', redirect: 'follow',
    });
    const data = await res.json();
    if (data && data.ok && data.payload) {
      await applyDrivePayload(data.payload, data.updatedAt);
      return { ok: true, applied: true };
    }
    return { ok: false, error: data.error || 'no payload' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Generate the Apps Script source shown in the sync setup modal.
export function buildAppsScript(secret) {
  const folderId = state.sync?.folderId || 'YOUR_DRIVE_FOLDER_ID';
  return `// Fit tracker webhook — saves & loads backups to your Google Drive "Fit" folder
const SECRET = '${secret}';
const FIT_FOLDER_ID = '${folderId}';


`;
}

// Auto-import sync config when the app is opened via a QR-code URL (#sync=…).
export function checkSyncImportFromUrl() {
  const m = location.hash.match(/#sync=([^&]+)/);
  if (!m) return;
  try {
    const cfg = JSON.parse(atob(m[1]));
    if (!cfg.webhookUrl || !cfg.secret) return;
    const ok = confirm('Import sync settings from QR code?\n\nWebhook: ' + cfg.webhookUrl.slice(0, 60) + '…\n\nThis will replace any sync config on this device.');
    history.replaceState({}, '', location.pathname + location.search);
    if (!ok) return;
    state.sync = state.sync || {};
    state.sync.webhookUrl = cfg.webhookUrl;
    state.sync.secret = cfg.secret;
    if (cfg.folderId) state.sync.folderId = cfg.folderId;
    save();
    if (typeof toast === 'function') toast('Sync settings imported ✓ — testing connection…');
    setTimeout(async () => {
      const r = await pingSync();
      if (typeof toast === 'function') {
        if (r.ok && r.pong) toast('Connected ✓ — tap Pull to load your data');
        else toast('Imported but test failed: ' + (r.error || 'unknown'));
      }
    }, 600);
  } catch (e) {
    console.error('Sync import failed:', e);
  }
}
