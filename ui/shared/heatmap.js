import { renderMuscleHeatmapSvg } from '../../domain/muscle-map.js';

export function openHeatmap(session) {
  const body = document.getElementById('heatmapBody');
  const sub = document.getElementById('heatmapSubtitle');
  if (!body) return;
  const totalSets = (session.entries || []).reduce((n, e) => n + (e.sets?.length || 0), 0);
  const totalReps = (session.entries || []).reduce((n, e) => n + (e.sets?.reduce((r, s) => r + (s.reps || 0), 0) || 0), 0);
  sub.textContent = `${totalSets} sets · ${totalReps} reps · Muscles worked today:`;
  body.innerHTML = renderMuscleHeatmapSvg(session);
  document.getElementById('heatmapModal').classList.add('show');
}

export function closeHeatmap() {
  document.getElementById('heatmapModal').classList.remove('show');
}
