// Deterministic calorie engine — Compendium of Physical Activities MET values.
// The LLM never touches calorie numbers; it only assesses consistency and feedback.
// Formula: weighted_MET × weight × baseline_duration × modifiers
// Baseline = active_sec + (num_sets × 60s rest), so density always cancels.

const WEIGHT_KG = 58;

// Compendium MET values (session-averaged, active phase)
const EXERCISE_MET = {
  'pull-ups': 8.0,
  'chin-ups': 8.0,
  'dips': 5.0,
  'parallel bars': 6.0,
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
  'bulgarian split squats': 5.0,
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
  'chin-ups': 2.0,
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
  swim: 7.0,
  hike: 6.0,
  treadmill_walk: 3.5,
  elliptical: 5.5,
  rowing: 7.0,
  jump_rope: 11.0,
};

// Run MET derived from pace (min/km). Compendium values.
// Used for 'run' and 'treadmill_run' when both distance and duration are available.
const RUN_PACE_BRACKETS = [
  { maxPaceMinKm: 4.5,  met: 14.0 },  // < 4:30/km  (>13.3 km/h) — fast/interval
  { maxPaceMinKm: 5.5,  met: 11.0 },  // 4:30–5:30/km (11–13 km/h) — tempo
  { maxPaceMinKm: 6.5,  met: 10.0 },  // 5:30–6:30/km (9–11 km/h) — moderate
  { maxPaceMinKm: 8.0,  met: 8.5  },  // 6:30–8:00/km (7.5–9 km/h) — easy/long run
  { maxPaceMinKm: Infinity, met: 7.0 }, // > 8:00/km — slow jog
];

function runMet(durationMin, km) {
  if (km > 0 && durationMin > 0) {
    const paceMinKm = durationMin / km;
    for (const { maxPaceMinKm, met } of RUN_PACE_BRACKETS) {
      if (paceMinKm < maxPaceMinKm) return met;
    }
  }
  return 10.0; // fallback: ~6:00/km moderate pace
}

const CARDIO_STEPS_PER_KM = {
  run: 1300,
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

export function feelModifier(feel) {
  if (feel === 'easy') return 0.95;
  if (feel === 'exhausted') return 1.10;
  return 1.00;
}

function weatherModifier(outdoor, weather) {
  if (!outdoor || !weather) return 1.00;
  const { tempC, humidity } = weather;
  if (tempC > 28 && humidity > 70) return 1.12;
  if (tempC > 28) return 1.08;
  if (tempC < 5) return 1.05;
  return 1.00;
}

// EPOC: rate and today/tomorrow split based on session hour
function epocSplit(rpe, sessionHour) {
  const rate = rpe >= 9 ? 0.12 : rpe >= 7 ? 0.08 : 0;
  if (rate === 0) return { rate: 0, todayFraction: 1 };
  let todayFraction;
  if (sessionHour < 14)      todayFraction = 0.9;
  else if (sessionHour < 18) todayFraction = 0.7;
  else                       todayFraction = rpe >= 8 ? 0.3 : 0.5;
  return { rate, todayFraction };
}

function parseDurationMin(str) {
  if (!str) return 0;
  const m = String(str).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// ---------- MAIN ----------

/**
 * Deterministic session calorie calculation.
 *
 * @param {object} session  - session with entries[], cardioActivities[], time
 * @param {object} opts     - { rpe, feel, outdoor, weather }
 * @returns {{ caloriesBurned, epocToday, epocTomorrow, stepsFromCardio, breakdown }}
 */
export function calculateSessionCalories(session, { rpe = 5, feel = 'normal', outdoor = false, weather = null } = {}) {
  const rpeMult   = rpeMultiplier(rpe);
  const feelMod   = feelModifier(feel);
  const weatherMod = weatherModifier(outdoor, weather);
  const modifier  = rpeMult * feelMod * weatherMod;

  // --- Strength ---
  let totalActiveSec = 0;
  let totalSets = 0;
  let weightedMetNum = 0;
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
    totalActiveSec += activeSec;
    totalSets += sets;
    weightedMetNum += activeSec * met;
    exCalcs.push({ name: entry.name, met, activeSec, sets, legFactor });
  }

  const weightedMet = totalActiveSec > 0 ? weightedMetNum / totalActiveSec : 0;
  const baselineSec = totalActiveSec + totalSets * 60;
  const strengthBase = weightedMet * WEIGHT_KG * (baselineSec / 3600);

  // --- Cardio ---
  let cardioBase = 0;
  let stepsFromCardio = 0;
  const cardioCalcs = [];

  for (const a of (session.cardioActivities || [])) {
    if (!a?.type) continue;
    const durationMin = parseDurationMin(a.duration);
    const km = parseFloat(a.distance) || 0;
    const isRun = a.type === 'run' || a.type === 'treadmill_run';
    const met = isRun ? runMet(durationMin, km) : (CARDIO_MET[a.type] ?? 6.0);
    const rawCal = met * WEIGHT_KG * (durationMin / 60);
    cardioBase += rawCal;
    stepsFromCardio += km * (CARDIO_STEPS_PER_KM[a.type] ?? 0);
    cardioCalcs.push({ type: a.type, met, durationMin, km, rawCal });
  }

  const base = strengthBase + cardioBase;
  const adjusted = base * modifier;

  // --- EPOC ---
  const hour = session.time ? parseInt(session.time.split(':')[0], 10) : 12;
  const { rate: epocRate, todayFraction } = epocSplit(rpe, hour);
  const epocTotal = adjusted * epocRate;
  const epocToday    = Math.round(epocTotal * todayFraction);
  const epocTomorrow = Math.round(epocTotal * (1 - todayFraction));

  // --- Breakdown (pro-rata share of adjusted total) ---
  const breakdown = [];
  for (const { name, met, activeSec, sets, legFactor } of exCalcs) {
    const rawShare = base > 0 ? (met * WEIGHT_KG * (activeSec / 3600)) / base : 0;
    breakdown.push({
      activity: name,
      calories: Math.round(adjusted * rawShare),
      reasoning: `MET ${met}, ${Math.round(activeSec)}s active${legFactor === 2 ? ' (per leg ×2)' : ''}, ${sets} sets`,
    });
  }
  for (const { type, met, durationMin, km, rawCal } of cardioCalcs) {
    const rawShare = base > 0 ? rawCal / base : 0;
    const isRun = type === 'run' || type === 'treadmill_run';
    const paceNote = isRun && km > 0 && durationMin > 0
      ? `, ${Math.floor(durationMin / km)}:${String(Math.round((durationMin / km % 1) * 60)).padStart(2, '0')}/km`
      : '';
    breakdown.push({
      activity: type,
      calories: Math.round(adjusted * rawShare),
      reasoning: `MET ${met}, ${durationMin} min${km ? `, ${km} km${paceNote}` : ''}`,
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
