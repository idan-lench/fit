// Generic SVG chart helpers. Each function takes a DOM element directly —
// callers own the getElementById lookup so these stay testable and reusable.

export function drawChart(el, ms) {
  const w = 600, h = 200, pad = 28;
  if (ms.length === 0) {
    el.innerHTML = `<div class="empty">Add a measurement to see the trend.</div>`;
    return;
  }
  const xs = ms.map(m => +new Date(m.date));
  const ys = ms.map(m => m.cm);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys) - 1, yMax = Math.max(...ys) + 1;
  const xScale = x => pad + ((x - xMin) / Math.max(1, xMax - xMin)) * (w - pad*2);
  const yScale = y => h - pad - ((y - yMin) / Math.max(0.01, yMax - yMin)) * (h - pad*2);
  const pts = ms.map(m => `${xScale(+new Date(m.date)).toFixed(1)},${yScale(m.cm).toFixed(1)}`).join(' ');
  const dots = ms.map(m => `<circle cx="${xScale(+new Date(m.date))}" cy="${yScale(m.cm)}" r="4" fill="var(--accent)"/>`).join('');
  const yTicks = [yMin, (yMin+yMax)/2, yMax].map(y => `
    <line x1="${pad}" y1="${yScale(y)}" x2="${w-pad}" y2="${yScale(y)}" stroke="var(--line)" stroke-dasharray="2,4"/>
    <text x="${pad-6}" y="${yScale(y)+4}" fill="var(--muted)" font-size="11" text-anchor="end">${y.toFixed(1)}</text>
  `).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:200px;">
      ${yTicks}
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/>
      ${dots}
    </svg>
  `;
}

export function drawStepsChart(el, ss, stepsGoal) {
  if (!el) return;
  if (ss.length === 0) {
    el.innerHTML = `<div class="empty">Add entries to see the trend.</div>`;
    return;
  }
  const rotate = ss.length > 10;
  const w = 600, h = 240, pad = 36, padBottom = rotate ? 50 : 30;
  const chartH = h - padBottom;
  const xs = ss.map(s => +new Date(s.date));
  const validYs = ss.filter(s => typeof s.count === 'number').map(s => s.count);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMax = Math.max(stepsGoal * 1.15, ...validYs);
  const yMin = 0;
  const xScale = x => pad + ((x - xMin) / Math.max(1, xMax - xMin)) * (w - pad*2);
  const yScale = y => chartH - 6 - ((y - yMin) / Math.max(0.01, yMax - yMin)) * (chartH - pad);
  const pts = ss.filter(s => typeof s.count === 'number').map(s => `${xScale(+new Date(s.date)).toFixed(1)},${yScale(s.count).toFixed(1)}`).join(' ');
  const dots = ss.filter(s => typeof s.count === 'number').map(s => `<circle cx="${xScale(+new Date(s.date))}" cy="${yScale(s.count)}" r="4" fill="${s.count >= stepsGoal ? 'var(--accent2)' : 'var(--accent)'}"/>`).join('');
  const goalY = yScale(stepsGoal);
  const tickVals = [0, Math.round(yMax/2/1000)*1000, Math.round(yMax/1000)*1000];
  const yTicks = tickVals.map(v => `
    <line x1="${pad}" y1="${yScale(v)}" x2="${w-pad}" y2="${yScale(v)}" stroke="var(--line)" stroke-dasharray="2,4" opacity="0.6"/>
    <text x="${pad-6}" y="${yScale(v)+4}" fill="var(--muted)" font-size="11" text-anchor="end">${(v/1000).toFixed(v >= 1000 ? 0 : 1)}k</text>
  `).join('');
  const fmt = ts => { const d = new Date(ts); return d.getDate() + '/' + (d.getMonth()+1); };
  const fontSize = rotate ? 9 : 11;
  const xLabels = ss.map(s => {
    const x = xScale(+new Date(s.date));
    const y = chartH + (rotate ? 14 : 18);
    return rotate
      ? `<text x="${x}" y="${y}" fill="var(--muted)" font-size="${fontSize}" text-anchor="end" transform="rotate(-45 ${x} ${y})">${fmt(+new Date(s.date))}</text>`
      : `<text x="${x}" y="${y}" fill="var(--muted)" font-size="${fontSize}" text-anchor="middle">${fmt(+new Date(s.date))}</text>`;
  }).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:240px; width: 100%;">
      ${yTicks}
      <line x1="${pad}" y1="${goalY}" x2="${w-pad}" y2="${goalY}" stroke="var(--accent2)" stroke-dasharray="4,4" opacity="0.6"/>
      <text x="${w-pad}" y="${goalY-4}" fill="var(--accent2)" font-size="11" text-anchor="end">${(stepsGoal/1000)}k goal</text>
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/>
      ${dots}
      ${xLabels}
    </svg>
  `;
}
