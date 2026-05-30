// Google Fit integration — OAuth token management + step/distance fetch.
//
// DOM-touching functions (syncGoogleFit) stay in app.js; this module owns
// everything that doesn't require document access.
//
// CI gate: no other file is allowed to call
// www.googleapis.com/fitness — see scripts/check-duplication.js.

import { todayISO } from '../core/time.js';
import { state, save } from '../data/state.js';

export const GFIT_CLIENT_ID = '702200125555-73etjk85h28n9a4ehsm8sio415tpivat.apps.googleusercontent.com';
export const GFIT_SCOPES = [
  'https://www.googleapis.com/auth/fitness.activity.read',
  'https://www.googleapis.com/auth/fitness.location.read',
].join(' ');

let _gfitToken = null;
let _gfitTokenExpiry = 0;

export function loadCachedGfitToken() {
  try {
    const raw = localStorage.getItem('fit.gfitToken');
    if (!raw) return;
    const { token, expiry } = JSON.parse(raw);
    if (token && expiry && Date.now() < expiry) {
      _gfitToken = token;
      _gfitTokenExpiry = expiry;
    }
  } catch {}
}

export function saveCachedGfitToken(token, expiry) {
  try { localStorage.setItem('fit.gfitToken', JSON.stringify({ token, expiry })); } catch {}
}

export function clearCachedGfitToken() {
  _gfitToken = null;
  _gfitTokenExpiry = 0;
  try { localStorage.removeItem('fit.gfitToken'); } catch {}
}

// opts.silent: resolve null instead of showing OAuth popup when no token cached
export function gfitGetToken(opts = {}) {
  const silent = !!opts.silent;
  return new Promise((resolve, reject) => {
    if (_gfitToken && Date.now() < _gfitTokenExpiry) return resolve(_gfitToken);
    if (silent) return resolve(null);
    if (typeof google === 'undefined' || !google.accounts?.oauth2)
      return reject(new Error('Google Identity not loaded'));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GFIT_CLIENT_ID,
      scope: GFIT_SCOPES,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        _gfitToken = resp.access_token;
        _gfitTokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
        saveCachedGfitToken(_gfitToken, _gfitTokenExpiry);
        resolve(_gfitToken);
      },
    });
    client.requestAccessToken();
  });
}

// Returns {startMs, endMs} spanning local midnight-to-midnight for an ISO date.
export function gfitDateRange(isoDate) {
  const start = new Date(isoDate + 'T00:00:00');
  const end   = new Date(isoDate + 'T23:59:59');
  return { startMs: start.getTime(), endMs: end.getTime() };
}

// Prefer the merged/estimated derived source — matches what Fit's own UI shows.
const GFIT_DERIVED_SOURCES = {
  'com.google.step_count.delta': 'derived:com.google.step_count.delta:com.google.android.gms:estimated_steps',
  'com.google.distance.delta':   'derived:com.google.distance.delta:com.google.android.gms:merge_distance_delta',
};

export async function gfitAggregateOnce(token, startMs, endMs, aggBy) {
  const body = {
    aggregateBy: [aggBy],
    bucketByTime: { durationMillis: endMs - startMs },
    startTimeMillis: startMs,
    endTimeMillis: endMs,
  };
  const r = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Fit API ${r.status}`);
  return r.json();
}

// Try the derived/estimated source first; fall back to raw data type if empty.
export async function gfitAggregate(token, startMs, endMs, dataTypeName) {
  const derived = GFIT_DERIVED_SOURCES[dataTypeName];
  if (derived) {
    const r1 = await gfitAggregateOnce(token, startMs, endMs, { dataTypeName, dataSourceId: derived });
    if (r1?.bucket?.[0]?.dataset?.[0]?.point?.length > 0) return r1;
  }
  return gfitAggregateOnce(token, startMs, endMs, { dataTypeName });
}

export function gfitExtractInt(data) {
  try {
    return data.bucket[0].dataset[0].point.reduce((s, p) => s + p.value[0].intVal, 0);
  } catch { return 0; }
}

export function gfitExtractFloat(data) {
  try {
    return data.bucket[0].dataset[0].point.reduce((s, p) => s + p.value[0].fpVal, 0);
  } catch { return 0; }
}

// Silently fetch steps + distance for a date; write to state if > 0. No popups.
export async function silentSyncGoogleFit(date) {
  const targetDate = date || todayISO();
  try {
    const token = await gfitGetToken({ silent: true });
    if (!token) return false;
    const { startMs, endMs } = gfitDateRange(targetDate);
    const [stepsData, distData] = await Promise.all([
      gfitAggregate(token, startMs, endMs, 'com.google.step_count.delta'),
      gfitAggregate(token, startMs, endMs, 'com.google.distance.delta'),
    ]);
    const steps = gfitExtractInt(stepsData);
    if (steps > 0) {
      state.steps = state.steps || [];
      state.steps = state.steps.filter(s => s.date !== targetDate);
      state.steps.push({ date: targetDate, count: steps, source: 'gfit' });
      save();
    }
    return steps > 0;
  } catch (e) {
    if (String(e.message || '').match(/401|invalid|expired/i)) clearCachedGfitToken();
    return false;
  }
}

// Auto-sync today + any missing days in the last 7. Silent — no popups.
export async function autoSilentFitSync() {
  const updated = [];
  const today = todayISO();
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const existing = (state.steps || []).find(s => s.date === iso);
    if (iso === today || !existing) {
      const ok = await silentSyncGoogleFit(iso);
      if (ok) updated.push(iso);
    }
  }
  return updated;
}
