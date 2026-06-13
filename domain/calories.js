// Deterministic calorie engine — Compendium of Physical Activities MET values.
// The LLM never touches calorie numbers; it only assesses consistency and feedback.
// Formula (ACSM): MET × 3.5 × weight_kg ÷ 200 × time_min
// Baseline = active_sec + (num_sets × 60s rest), so density always cancels.

// Compendium MET values (session-averaged, active phase)
const EXERCISE_MET = {
  'pull-ups': 10.0,
  'wide pull-ups': 10.5,        // wider grip, harder leverage, more lat
  'chin-ups': 10.0,
  'hammer pull-ups': 10.0,      // neutral grip, strong position
  'wide hammer pull-ups': 10.5, // wide neutral grip
  'dips': 6.5,
  'parallel bars': 6.5,
  'push-ups': 8.0,
  'ring push-ups': 9.0,
  'decline push-ups': 8.5,
  'diamond push-ups': 8.5,
  'archer push-ups': 9.0,
  'pike push-ups': 7.0,
  'inverted rows': 5.0,
  'trx low row': 5.0,
  'bench press': 5.0,
  'incline bench press': 5.0,
  'overhead press': 5.0,
  'barbell rows': 5.0,
  'front raises': 4.0,
  'shoulder press machine': 5.0,
  'handstand (sec)': 8.0,
  'squats': 5.0,
  'lunges (each leg)': 5.0,
  'bulgarian split squats': 6.0,
  'glute bridges': 4.0,
  'single-leg glute bridges': 4.0,
  'calf raises': 3.5,
  'wall sit (sec)': 3.5,
  'step-ups': 5.0,
  'leg press': 5.0,
  'plank (sec)': 4.0,
  'side plank (sec)': 4.0,
  'hanging leg raises': 5.0,
  'hanging knee tucks': 5.0,
  'hanging knee to leg extension': 5.5,
  'hollow hold (sec)': 4.0,
  'crunches': 5.0,
  'bicycle crunches': 5.5,
  'russian twists': 4.0,
  'dead bug': 3.5,
  'mountain climbers': 8.0,
  'bird dog': 3.5,
};

// Seconds per rep (typical concentric+eccentric cadence)
const SECS_PER_REP = {
  'pull-ups': 2.0,
  'wide pull-ups': 2.0,
  'chin-ups': 2.0,
  'hammer pull-ups': 2.0,
  'wide hammer pull-ups': 2.0,
  'dips': 2.0,
  'parallel bars': 2.0,
  'push-ups': 2.0,
  'ring push-ups': 2.0,
  'decline push-ups': 2.0,
  'diamond push-ups': 2.0,
  'archer push-ups': 2.5,
  'pike push-ups': 2.0,
  'inverted rows': 2.5,
  'trx low row': 2.5,
  'bench press': 3.0,
  'incline bench press': 3.0,
  'overhead press': 2.5,
  'barbell rows': 2.5,
  'front raises': 2.0,
  'shoulder press machine': 2.5,
  'handstand (sec)': 1.0,  // reps = seconds held
  'squats': 2.5,
  'lunges (each leg)': 2.0,
  'bulgarian split squats': 2.5,
  'glute bridges': 2.0,
  'single-leg glute bridges': 2.5,
  'calf raises': 1.5,
  'wall sit (sec)': 1.0,  // reps = seconds held
  'step-ups': 2.0,
  'leg press': 2.5,
  'plank (sec)': 1.0,     // reps = seconds held
  'side plank (sec)': 1.0,
  'hollow hold (sec)': 1.0,
  'hanging leg raises': 2.5,
  'hanging knee tucks': 2.5,
  'hanging knee to leg extension': 3.0,
  'crunches': 1.5,
  'bicycle crunches': 1.5,
  'russian twists': 1.5,
  'dead bug': 3.0,
  'mountain climbers': 0.5,
  'bird dog': 3.0,
};

// Per-leg exercises: logged reps are per leg → multiply active time by 2
const PER_LEG = new Set([
  'lunges (each leg)',
  'bulgarian split squats',
  'single-leg glute bridges',
  'step-ups',
]);

const CARDIO_MET = {
  walk: 3.5,
  cycle: 7.5,
  bike: 7.5,       // same as cycle
  swim: 8.0,             // legacy key — freestyle moderate fallback
  swim_freestyle: 8.0,   // front crawl moderate (Compendium 2011: 8.0)
  swim_butterfly: 13.8,  // most demanding stroke (Compendium: 13.8)
  swim_breaststroke: 6.5, // continuous lap swimming (Compendium general 5.3, raised for sustained pace)
  swim_backstroke: 6.0,   // continuous lap swimming (Compendium general 4.8, raised for sustained pace)
  hike: 6.0,
  movement: 5.0,   // movement/flexibility class
  treadmill_walk: 3.5,
  elliptical: 5.5,
  rowing: 7.0,
  jump_rope: 11.0,
};

// Run MET derived from pace (min/km). Compendium values.
// Used for 'run' and 'treadmill_run' when both distance and duration are available.
// Compendium of Physical Activities 2011 + Gemini cross-reference:
// 15 km/h=13.3, 16 km/h=14.5, 18 km/h=16.0 | 9.7 km/h=10.0, 10.8=11.0, 12.1=11.8
const RUN_PACE_BRACKETS = [
  { maxPaceMinKm: 3.33, met: 18.0 },  // < 3:20/km  (>18 km/h) — max sprint (Compendium ~19 at 19 km/h)
  { maxPaceMinKm: 4.0,  met: 15.0 },  // 3:20–4:00/km (15–18 km/h) — sprint
  { maxPaceMinKm: 4.5,  met: 13.5 },  // 4:00–4:30/km (13–15 km/h) — fast/interval
  { maxPaceMinKm: 5.5,  met: 11.5 },  // 4:30–5:30/km (11–13 km/h) — tempo
  { maxPaceMinKm: 6.5,  met: 10.5 },  // 5:30–6:30/km (9–11 km/h) — moderate
  { maxPaceMinKm: 8.0,  met: 8.5  },  // 6:30–8:00/km (7.5–9 km/h) — easy/long run
  { maxPaceMinKm: Infinity, met: 7.0 }, // > 8:00/km — slow jog
];

function metForPace(paceMinKm) {
  for (const { maxPaceMinKm, met } of RUN_PACE_BRACKETS) {
    if (paceMinKm < maxPaceMinKm) return met;
  }
  return 10.0; // fallback: ~6:00/km moderate pace
}

function runMet(durationMin, km) {
  if (km > 0 && durationMin > 0) return metForPace(durationMin / km);
  return 10.0;
}

// ---------- SWIM ----------
// Swim MET = constant stroke×effort matrix (absolute physiology, level-independent)
// resolved by a level-dependent pace table. Pace is sec per 100m; the swimmer's
// level decides whether that pace counts as easy / moderate / hard.
const SWIM_MET = {
  freestyle:    { easy: 7.5,  moderate: 9.0,  hard: 10.5 },
  backstroke:   { easy: 7.0,  moderate: 8.5,  hard: 10.0 },
  breaststroke: { easy: 8.0,  moderate: 9.5,  hard: 11.0 },
  butterfly:    { easy: 11.0, moderate: 13.0, hard: 15.0 }, // even "easy" fly is hard
};

// Pace thresholds in sec/100m. pace > easyAbove → easy; pace < hardBelow → hard;
// between → moderate. (Slower = bigger number = easier.)
const SWIM_PACE = {
  beginner: {
    freestyle:    { easyAbove: 165, hardBelow: 135 }, // >2:45 / <2:15
    backstroke:   { easyAbove: 180, hardBelow: 150 }, // >3:00 / <2:30
    breaststroke: { easyAbove: 180, hardBelow: 140 }, // >3:00 / <2:20
    butterfly:    { easyAbove: 210, hardBelow: 165 }, // >3:30 / <2:45
  },
  intermediate: {
    freestyle:    { easyAbove: 140, hardBelow: 105 }, // >2:20 / <1:45
    backstroke:   { easyAbove: 150, hardBelow: 115 }, // >2:30 / <1:55
    breaststroke: { easyAbove: 155, hardBelow: 115 }, // >2:35 / <1:55
    butterfly:    { easyAbove: 165, hardBelow: 120 }, // >2:45 / <2:00
  },
  advanced: {
    freestyle:    { easyAbove: 110, hardBelow: 85 },  // >1:50 / <1:25
    backstroke:   { easyAbove: 120, hardBelow: 95 },  // >2:00 / <1:35
    breaststroke: { easyAbove: 125, hardBelow: 95 },  // >2:05 / <1:35
    butterfly:    { easyAbove: 130, hardBelow: 90 },  // >2:10 / <1:30
  },
};

// Swim activity types map swim_<stroke>; legacy 'swim' → freestyle.
function swimStroke(type) {
  if (type === 'swim') return 'freestyle';
  return type.replace('swim_', '');
}

// Distance for swims is in meters (entered as "1500", "1500 m" or "1.5 km").
function parseDistanceMeters(str) {
  if (!str) return 0;
  const s = String(str).toLowerCase();
  const n = parseFloat(s) || 0;
  if (s.includes('km')) return n * 1000;
  if (/\bm\b|meter/.test(s)) return n;
  return n < 20 ? n * 1000 : n; // bare "1.5" → 1500m, "1500" → 1500m
}

// Resolve a swim's MET: pace (sec/100m) → category via the level table → matrix.
// Missing pace (no distance or duration) falls back to Moderate.
function swimMet(stroke, paceSecPer100, level) {
  const matrix = SWIM_MET[stroke] || SWIM_MET.freestyle;
  const t = (SWIM_PACE[level] || SWIM_PACE.intermediate)[stroke];
  let category = 'moderate';
  if (t && paceSecPer100 > 0) {
    if (paceSecPer100 > t.easyAbove) category = 'easy';
    else if (paceSecPer100 < t.hardBelow) category = 'hard';
  }
  return { met: matrix[category], category };
}

// ---------- INTERVAL SEGMENTS ----------
// An interval run can carry an ordered segments[] array, each segment a phase
// of the run: { kind: 'warmup'|'work'|'recovery'|'cooldown', durationSec,
// distanceM?, paceSecPerKm? }. Each segment's MET comes from its own pace.
// Recovery segments with NO logged pace fall back to 60% of the average work
// MET — the rule agreed for interval recoveries (active jog/walk between reps).
const RECOVERY_MET_FACTOR = 0.6;

function segPaceMinKm(seg) {
  if (seg.paceSecPerKm > 0) return seg.paceSecPerKm / 60;
  if (seg.distanceM > 0 && seg.durationSec > 0) return (seg.durationSec / 60) / (seg.distanceM / 1000);
  return null;
}

function segMet(seg, avgWorkMet) {
  const pace = segPaceMinKm(seg);
  if (pace != null) return metForPace(pace);
  if (seg.kind === 'recovery') return Math.round(RECOVERY_MET_FACTOR * avgWorkMet * 10) / 10;
  return 10.0; // warmup/cooldown/work with no pace data → moderate run
}

function calcIntervalSegments(segments, WEIGHT_KG) {
  // Average work MET first, so recoveries without a pace can derive from it.
  const workMets = segments
    .filter(s => s.kind === 'work')
    .map(s => { const p = segPaceMinKm(s); return p != null ? metForPace(p) : null; })
    .filter(m => m != null);
  const avgWorkMet = workMets.length ? workMets.reduce((a, b) => a + b, 0) / workMets.length : 10.0;

  let total = 0, totalSec = 0, totalKm = 0;
  // Per-phase aggregates so the breakdown can show one row per phase.
  const phases = {}; // kind -> { kcal, sec, count }
  for (const s of segments) {
    const met = segMet(s, avgWorkMet);
    const cal = met * 3.5 * WEIGHT_KG / 200 * ((s.durationSec || 0) / 60);
    total += cal;
    totalSec += s.durationSec || 0;
    if (s.distanceM > 0) totalKm += s.distanceM / 1000;
    const ph = phases[s.kind] || (phases[s.kind] = { kcal: 0, sec: 0, count: 0 });
    ph.kcal += cal; ph.sec += s.durationSec || 0; ph.count++;
  }
  return { total, totalMin: totalSec / 60, totalKm, avgWorkMet, phases };
}

const CARDIO_STEPS_PER_KM = {
  run: 1300,
  'long-run': 1300,
  interval: 1300,
  walk: 1400,
  treadmill_run: 1300,
  treadmill_walk: 1400,
  hike: 1400,
};

// ---------- MODIFIER HELPERS ----------

// Linear scale: 0.85 at RPE 1, 1.00 at RPE 5, 1.20 at RPE 10
export function rpeMultiplier(rpe) {
  return 0.85 + (rpe - 1) * (0.35 / 9);
}

// EPOC afterburn rate + today/tomorrow split.
// Strength is RPE-only. Runs/intervals take the HIGHER of an intensity-based
// rate (from work MET) and the RPE-based rate — so a hard session earns its
// afterburn even if rated low, and an easy one rated high still gets it.
//   runMet = peak run/interval MET in the session (0 if no running).
function epocSplit(rpe, sessionHour, runMet = 0) {
  let rate;
  if (runMet > 0) {
    // MET >= 13.5 (≤4:30/km) → 15%; MET >= 11.5 (≤5:30/km) → 12%
    const metRate = runMet >= 13.5 ? 0.15 : runMet >= 11.5 ? 0.12 : 0;
    const rpeRate = rpe >= 9 ? 0.15 : rpe >= 7 ? 0.12 : 0;
    rate = Math.max(metRate, rpeRate);
  } else {
    rate = rpe >= 9 ? 0.12 : rpe >= 7 ? 0.08 : 0;
  }
  if (rate === 0) return { rate: 0, todayFraction: 1 };
  let todayFraction;
  if (sessionHour < 14)      todayFraction = 0.9;
  else if (sessionHour < 18) todayFraction = 0.7;
  else                       todayFraction = rpe >= 8 ? 0.3 : 0.5;
  return { rate, todayFraction };
}

function parseDurationMin(str) {
  if (!str) return 0;
  const s = String(str).trim();
  const hms = s.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (hms) return parseInt(hms[1]) * 60 + parseInt(hms[2]) + parseInt(hms[3]) / 60;
  const ms = s.match(/^(\d+):(\d{2})$/);
  if (ms) return parseInt(ms[1]) + parseInt(ms[2]) / 60;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// ---------- MAIN ----------

/**
 * Deterministic session calorie calculation.
 *
 * @param {object} session  - session with entries[], cardioActivities[], time
 * @param {object} opts     - { rpe, weightKg }
 * @returns {{ caloriesBurned, epocToday, epocTomorrow, stepsFromCardio, breakdown }}
 */
export function calculateSessionCalories(session, { rpe = 5, weightKg = 58, swimLevel = 'intermediate' } = {}) {
  const WEIGHT_KG = weightKg;

  // --- Strength ---
  // Active: exercise MET × active time
  // Rest:   exercise MET × 0.45 × 1 min per set (first minute only, after that uncounted)
  let strengthBase = 0;
  const exCalcs = [];

  for (const entry of (session.entries || [])) {
    if (!entry?.name || !entry.sets?.length) continue;
    const key = entry.name.toLowerCase();
    const met = EXERCISE_MET[key] ?? 5.0;
    const secsPerRep = SECS_PER_REP[key] ?? 2.0;
    const legFactor = PER_LEG.has(key) ? 2 : 1;
    let reps = 0, sets = 0;
    for (const s of entry.sets) {
      const r = Number(s?.reps) || 0;
      if (r > 0) { reps += r; sets++; }
    }
    const activeSec = reps * secsPerRep * legFactor;
    const activeCal = met * 3.5 * WEIGHT_KG / 200 * (activeSec / 60);
    const restCal   = met * 0.45 * 3.5 * WEIGHT_KG / 200 * sets; // 1 min/set at 45% of exercise MET
    strengthBase += activeCal + restCal;
    exCalcs.push({ name: entry.name, met, activeSec, sets, legFactor, activeCal, restCal });
  }

  // --- Cardio ---
  let cardioBase = 0;
  let stepsFromCardio = 0;
  const cardioCalcs = [];

  for (const a of (session.cardioActivities || [])) {
    if (!a?.type) continue;
    // Interval run with structured segments → sum each phase (recovery without
    // a logged pace falls back to 60% of work MET inside calcIntervalSegments).
    if (a.type === 'interval' && Array.isArray(a.segments) && a.segments.length) {
      const r = calcIntervalSegments(a.segments, WEIGHT_KG);
      cardioBase += r.total;
      stepsFromCardio += r.totalKm * (CARDIO_STEPS_PER_KM[a.type] ?? 1300);
      cardioCalcs.push({ type: a.type, segmented: true, rawCal: r.total, ...r });
      continue;
    }
    const durationMin = parseDurationMin(a.duration);
    const km = parseFloat(a.distance) || 0;
    const isRun = a.type === 'run' || a.type === 'treadmill_run' || a.type === 'interval' || a.type === 'long-run';

    // Swim: MET from pace (sec/100m) resolved through the swimmer's level.
    if (a.type === 'swim' || a.type.startsWith('swim_')) {
      const stroke = swimStroke(a.type);
      const distM = parseDistanceMeters(a.distance);
      const paceSecPer100 = (distM > 0 && durationMin > 0) ? (durationMin * 6000 / distM) : 0;
      const { met, category } = swimMet(stroke, paceSecPer100, swimLevel);
      const rawCal = met * 3.5 * WEIGHT_KG / 200 * durationMin;
      cardioBase += rawCal;
      cardioCalcs.push({ type: a.type, met, durationMin, km, rawCal, swim: { stroke, level: swimLevel, category, paceSecPer100: Math.round(paceSecPer100) } });
      continue;
    }

    const met = isRun ? runMet(durationMin, km) : (CARDIO_MET[a.type] ?? 6.0);
    const rawCal = met * 3.5 * WEIGHT_KG / 200 * durationMin;
    cardioBase += rawCal;
    stepsFromCardio += km * (CARDIO_STEPS_PER_KM[a.type] ?? 0);
    cardioCalcs.push({ type: a.type, met, durationMin, km, rawCal });
  }

  const adjusted = strengthBase + cardioBase;

  // --- EPOC ---
  const hour = session.time ? parseInt(session.time.split(':')[0], 10) : 12;
  // Peak run/interval intensity drives the intensity-based afterburn. For a
  // segmented interval that's the average work MET; for a plain run it's the
  // pace-derived MET.
  let maxRunMet = 0;
  for (const c of cardioCalcs) {
    const isRun = c.type === 'run' || c.type === 'treadmill_run' || c.type === 'interval' || c.type === 'long-run';
    if (!isRun) continue;
    const m = c.segmented ? c.avgWorkMet : c.met;
    if (m > maxRunMet) maxRunMet = m;
  }
  const { rate: epocRate, todayFraction } = epocSplit(rpe, hour, maxRunMet);
  const epocTotal = adjusted * epocRate;
  const epocToday    = Math.round(epocTotal * todayFraction);
  const epocTomorrow = Math.round(epocTotal * (1 - todayFraction));

  // --- Breakdown (pro-rata share of adjusted total) ---
  const breakdown = [];
  let breakdownSum = 0;

  for (const { name, met, activeSec, sets, legFactor, activeCal, restCal } of exCalcs) {
    const finalCal = Math.round(activeCal + restCal);
    const legNote = legFactor === 2 ? ' (per-leg ×2)' : '';
    const restMet = (met * 0.45).toFixed(1);
    breakdownSum += finalCal;
    breakdown.push({
      activity: name,
      calories: finalCal,
      reasoning: `MET ${met} × ${Math.round(activeSec / 60 * 10) / 10}min active${legNote} + ${sets} × 1min rest at MET ${restMet} = ${finalCal} kcal`,
    });
  }
  for (const c of cardioCalcs) {
    const finalCal = Math.round(c.rawCal);
    breakdownSum += finalCal;

    if (c.segmented) {
      // One breakdown row per phase (warm-up / work / recovery / cool-down).
      const k = 3.5 * WEIGHT_KG / 200;
      const order = [['warmup', 'Warm-up'], ['work', 'Intervals (work)'], ['recovery', 'Recovery'], ['cooldown', 'Cool-down']];
      for (const [kind, label] of order) {
        const ph = c.phases[kind];
        if (!ph || ph.sec === 0) continue;
        const cal = Math.round(ph.kcal);
        const min = ph.sec / 60;
        const met = Math.round(ph.kcal / (k * min) * 10) / 10; // effective (blended) MET
        const countNote = ph.count > 1 ? `${ph.count}× ` : '';
        const recNote = kind === 'recovery' ? ' (60% of work MET)' : '';
        breakdown.push({
          activity: label,
          calories: cal,
          reasoning: `${countNote}MET ${met} × ${Math.round(min * 10) / 10} min${recNote} = ${cal} kcal`,
        });
      }
      continue;
    }

    if (c.swim) {
      // State the level each time so the user can see it and ask to change it.
      const { stroke, level, category, paceSecPer100 } = c.swim;
      const paceStr = paceSecPer100 > 0
        ? `${Math.floor(paceSecPer100 / 60)}:${String(paceSecPer100 % 60).padStart(2, '0')}/100m`
        : 'pace n/a';
      breakdown.push({
        activity: c.type,
        calories: finalCal,
        reasoning: `${level} swimmer · ${stroke} @ ${paceStr} → ${category} · MET ${c.met} × ${c.durationMin} min = ${finalCal} kcal`,
      });
      continue;
    }

    const { type, met, durationMin, km } = c;
    const isRun = type === 'run' || type === 'treadmill_run' || type === 'interval' || type === 'long-run';
    const paceNote = isRun && km > 0 && durationMin > 0
      ? ` at ${Math.floor(durationMin / km)}:${String(Math.round((durationMin / km % 1) * 60)).padStart(2, '0')}/km`
      : '';
    const kmNote = km ? ` · ${km} km${paceNote}` : '';
    breakdown.push({
      activity: type,
      calories: finalCal,
      reasoning: `MET ${met} × 3.5 × ${WEIGHT_KG}kg ÷ 200 × ${durationMin} min${kmNote} = ${finalCal} kcal`,
    });
  }

  return {
    caloriesBurned: Math.round(adjusted),
    epocToday,
    epocTomorrow,
    stepsFromCardio: Math.round(stepsFromCardio),
    breakdown,
  };
}
