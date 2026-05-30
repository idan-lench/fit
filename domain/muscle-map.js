// Muscle activation map + heatmap rendering via the body-muscles UMD library.
// computeMuscleHeatmap is pure; renderMuscleHeatmapSvg writes DOM nodes via
// the external BodyMuscles global (loaded from unpkg CDN in index.html).

export const MUSCLE_MAP = {
  // Upper push
  'push-ups':            { chest: 1.0, triceps: 0.6, delts_front: 0.4, abs: 0.2 },
  'ring push-ups':       { chest: 1.0, triceps: 0.7, delts_front: 0.5, abs: 0.4 },
  'decline push-ups':    { chest: 1.0, delts_front: 0.6, triceps: 0.5 },
  'diamond push-ups':    { triceps: 1.0, chest: 0.6, delts_front: 0.3 },
  'archer push-ups':     { chest: 1.0, triceps: 0.7, delts_front: 0.4, abs: 0.4 },
  'pike push-ups':       { delts_front: 1.0, triceps: 0.7, chest: 0.3 },
  'bench press':         { chest: 1.0, triceps: 0.6, delts_front: 0.5 },
  'incline bench press': { chest: 0.9, delts_front: 0.7, triceps: 0.5 },
  'overhead press':      { delts_front: 1.0, triceps: 0.6, traps: 0.4 },
  'front raises':        { delts_front: 1.0 },
  'dips':                { triceps: 1.0, chest: 0.7, delts_front: 0.4 },
  'parallel bars':       { triceps: 1.0, chest: 0.7, delts_front: 0.5 },
  // Upper pull
  'pull-ups':            { lats: 1.0, biceps: 0.7, traps: 0.4, forearms: 0.4 },
  'chin-ups':            { biceps: 1.0, lats: 0.8, forearms: 0.4 },
  'inverted rows':       { lats: 0.8, traps: 0.7, biceps: 0.6, delts_rear: 0.5 },
  'trx low row':         { lats: 0.7, traps: 0.7, biceps: 0.6, delts_rear: 0.5 },
  'barbell rows':        { lats: 0.9, traps: 0.7, biceps: 0.5, delts_rear: 0.5 },
  // Lower
  'squats':              { quads: 1.0, glutes: 0.7, hamstrings: 0.4, calves: 0.3 },
  'lunges (each leg)':   { quads: 1.0, glutes: 0.7, hamstrings: 0.4 },
  'bulgarian split squats': { quads: 1.0, glutes: 0.8, hamstrings: 0.4 },
  'glute bridges':       { glutes: 1.0, hamstrings: 0.6 },
  'single-leg glute bridges': { glutes: 1.0, hamstrings: 0.7 },
  'calf raises':         { calves: 1.0 },
  'wall sit (sec)':      { quads: 1.0, glutes: 0.4 },
  'step-ups':            { quads: 1.0, glutes: 0.7, hamstrings: 0.4 },
  'leg press':           { quads: 1.0, glutes: 0.6, hamstrings: 0.4 },
  // Core
  'plank (sec)':         { abs: 1.0, delts_front: 0.3 },
  'side plank (sec)':    { obliques: 1.0, abs: 0.5 },
  'hanging leg raises':  { abs: 1.0, forearms: 0.4 },
  'hanging knee tucks':  { abs: 0.9, forearms: 0.4 },
  'hanging knee to leg extension': { abs: 1.0, hip_flexor: 0.6, forearms: 0.4, quads: 0.3 },
  'hollow hold (sec)':   { abs: 1.0 },
  'crunches':            { abs: 1.0 },
  'bicycle crunches':    { abs: 1.0, obliques: 0.7 },
  'russian twists':      { obliques: 1.0, abs: 0.6 },
  'dead bug':            { abs: 1.0 },
  'mountain climbers':   { abs: 0.8, delts_front: 0.4 },
  'bird dog':            { abs: 0.6, glutes: 0.4, lower_back: 0.5 }
};

// Maps our generic muscle keys to body-muscles library IDs.
const _BODY_MUSCLE_IDS = {
  chest:       ['chest-upper-left', 'chest-upper-right', 'chest-lower-left', 'chest-lower-right'],
  delts_front: ['shoulder-front-left', 'shoulder-front-right', 'shoulder-side-left', 'shoulder-side-right'],
  delts_rear:  ['deltoid-rear-left', 'deltoid-rear-right'],
  biceps:      ['biceps-left', 'biceps-right'],
  triceps:     ['triceps-long-left', 'triceps-long-right', 'triceps-lateral-left', 'triceps-lateral-right'],
  forearms:    ['forearm-left', 'forearm-right', 'forearm-extensors-left', 'forearm-extensors-right', 'forearm-flexors-left', 'forearm-flexors-right'],
  abs:         ['abs-upper-left', 'abs-upper-right', 'abs-lower-left', 'abs-lower-right'],
  obliques:    ['obliques-left', 'obliques-right'],
  traps:       ['traps-upper-left', 'traps-upper-right', 'traps-mid-left', 'traps-mid-right'],
  lats:        ['lats-upper-left', 'lats-upper-right', 'lats-mid-left', 'lats-mid-right', 'lats-lower-left', 'lats-lower-right'],
  lower_back:  ['lower-back-erectors-left', 'lower-back-erectors-right', 'lower-back-ql-left', 'lower-back-ql-right'],
  glutes:      ['gluteus-maximus-left', 'gluteus-maximus-right'],
  quads:       ['quads-left', 'quads-right'],
  hamstrings:  ['hamstrings-lateral-left', 'hamstrings-lateral-right', 'hamstrings-medial-left', 'hamstrings-medial-right'],
  calves:      ['calves-gastroc-lateral-left', 'calves-gastroc-lateral-right', 'calves-gastroc-medial-left', 'calves-gastroc-medial-right', 'tibialis-anterior-left', 'tibialis-anterior-right']
};

// Library intensity colors → our red-scale (1=lightest, 10=darkest).
// body-muscles uses aria-label (not id) so we remap by fill color on all <path>s.
const _libToRed = {
  '#fde047': '#ffcccc', '#facc15': '#ffb3b3', '#eab308': '#ff9999',
  '#fb923c': '#ff8080', '#f97316': '#f06060', '#ea580c': '#e04040',
  '#ef4444': '#d02828', '#dc2626': '#b01818', '#b91c1c': '#990a0a',
  '#7f1d1d': '#8b0000',
};

// Compute per-muscle activation totals from a session's exercise entries.
export function computeMuscleHeatmap(session) {
  const totals = {};
  for (const e of session.entries || []) {
    if (!e.sets || e.sets.length === 0) continue;
    const map = MUSCLE_MAP[(e.name || '').toLowerCase().trim()];
    if (!map) continue;
    const volume = e.sets.reduce((sum, s) => sum + (s.reps || 0), 0);
    for (const [muscle, weight] of Object.entries(map)) {
      totals[muscle] = (totals[muscle] || 0) + volume * weight;
    }
  }
  return totals;
}

function _buildBodyState(intensities) {
  const max = Math.max(0, ...Object.values(intensities));
  const bodyState = {};
  if (!max) return bodyState;
  for (const [ourKey, val] of Object.entries(intensities)) {
    const ids = _BODY_MUSCLE_IDS[ourKey];
    if (!ids) continue;
    const t = Math.min(1, val / max);
    const libIntensity = Math.max(1, Math.round(t * 10));
    for (const id of ids) bodyState[id] = { intensity: libIntensity, selected: false };
  }
  return bodyState;
}

function _applyRedScale(containerEl) {
  containerEl.querySelectorAll('path').forEach(p => {
    const fill = (p.getAttribute('fill') || '').toLowerCase();
    if (_libToRed[fill]) { p.setAttribute('fill', _libToRed[fill]); p.style.fill = _libToRed[fill]; }
  });
}

function _scheduleRedScale(containerEl) {
  let tries = 0;
  const apply = () => { _applyRedScale(containerEl); if (++tries < 8) setTimeout(apply, 80); };
  apply();
}

let _heatmapCounter = 0;
const _pendingHeatmaps = [];

function _tryMountHeatmaps() {
  if (typeof BodyMuscles === 'undefined' || !BodyMuscles.BodyChart) {
    setTimeout(_tryMountHeatmaps, 200); return;
  }
  for (let i = _pendingHeatmaps.length - 1; i >= 0; i--) {
    const item = _pendingHeatmaps[i];
    const container = document.getElementById(item.id);
    if (!container) continue;
    const frontEl = container.querySelector('[data-view="FRONT"]');
    const backEl  = container.querySelector('[data-view="BACK"]');
    if (frontEl && !frontEl.dataset.mounted) {
      new BodyMuscles.BodyChart(frontEl, { view: BodyMuscles.ViewSide.FRONT, bodyState: item.state, enableTransitions: false });
      _scheduleRedScale(frontEl); frontEl.dataset.mounted = '1';
    }
    if (backEl && !backEl.dataset.mounted) {
      new BodyMuscles.BodyChart(backEl, { view: BodyMuscles.ViewSide.BACK, bodyState: item.state, enableTransitions: false });
      _scheduleRedScale(backEl); backEl.dataset.mounted = '1';
    }
    _pendingHeatmaps.splice(i, 1);
  }
  if (_pendingHeatmaps.length) setTimeout(_tryMountHeatmaps, 200);
}

// Returns HTML string for a muscle heatmap widget (front + back view).
// Mounts the body-muscles library asynchronously after insertion into DOM.
export function renderMuscleHeatmapSvg(session) {
  const intensities = computeMuscleHeatmap(session);
  const bodyState = _buildBodyState(intensities);
  const id = 'heatmap-' + (++_heatmapCounter);
  _pendingHeatmaps.push({ id, state: bodyState });
  setTimeout(_tryMountHeatmaps, 0);
  return `
    <div id="${id}" style="display: flex; gap: 8px; justify-content: center; align-items: flex-start; margin: 8px 0;">
      <div data-view="FRONT" style="flex: 1; max-width: 50%; min-height: 200px;"></div>
      <div data-view="BACK"  style="flex: 1; max-width: 50%; min-height: 200px;"></div>
    </div>`;
}
