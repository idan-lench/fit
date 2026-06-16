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
  { maxPaceMinKm: 3.33, met: 18.0 },  // < 3:20/km  (>18 km/h) — max sprint
  { maxPaceMinKm: 4.0,  met: 15.0 },  // 3:20–4:00/km (15–18 km/h) — sprint
  { maxPaceMinKm: 4.5,  met: 13.5 },  // 4:00–4:30/km (13–15 km/h) — fast/interval
  { maxPaceMinKm: 5.0,  met: 12.0 },  // 4:30–5:00/km (12–13 km/h) — threshold
  { maxPaceMinKm: 5.5,  met: 11.5 },  // 5:00–5:30/km (11–12 km/h) — tempo
  { maxPaceMinKm: 6.0,  met: 10.5 },  // 5:30–6:00/km (10–11 km/h) — moderate
  { maxPaceMinKm: 6.5,  met: 9.5  },  // 6:00–6:30/km (9–10 km/h) — moderate-easy
  { maxPaceMinKm: 8.0,  met: 8.5  },  // 6:30–8:00/km (7.5–9 km/h) — easy/long run
  { maxPaceMinKm: Infinity, met: 7.5 }, // > 8:00/km — slow jog
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
// Swim MET depends on BOTH the swimmer's level and how hard the pace was for that
// level. A given pace is "easy/moderate/hard" relative to the level (SWIM_PACE),
// and the MET for that category also scales with level — a beginner's "moderate"
// (a slow ~4:00/100m cruise) is genuinely lighter than an advanced swimmer's
// "moderate" (a fast ~2:00/100m effort). This avoids over-crediting a slow swim
// just because the swimmer self-identifies at a higher level.
// Stroke offsets vs freestyle: backstroke −0.5, breaststroke +0.5; butterfly has
// its own (much higher) scale since even a slow fly is metabolically expensive.
const SWIM_MET = {
  beginner: {
    freestyle:    { easy: 5.5, moderate: 6.5, hard: 7.5  },
    backstroke:   { easy: 5.0, moderate: 6.0, hard: 7.0  },
    breaststroke: { easy: 6.0, moderate: 7.0, hard: 8.0  },
    butterfly:    { easy: 8.0, moderate: 9.5, hard: 11.0 },
  },
  intermediate: {
    freestyle:    { easy: 6.5, moderate: 7.0,  hard: 9.0  },
    backstroke:   { easy: 6.0, moderate: 6.5,  hard: 8.5  },
    breaststroke: { easy: 7.0, moderate: 7.5,  hard: 9.5  },
    butterfly:    { easy: 9.5, moderate: 11.0, hard: 13.0 },
  },
  advanced: {
    freestyle:    { easy: 8.0,  moderate: 10.0, hard: 12.5 },
    backstroke:   { easy: 7.5,  moderate: 9.5,  hard: 12.0 },
    breaststroke: { easy: 8.5,  moderate: 10.5, hard: 13.0 },
    butterfly:    { easy: 11.0, moderate: 13.0, hard: 15.0 },
  },
};

// Pace thresholds in sec/100m. pace > easyAbove → easy; pace < hardBelow → hard;
// between → moderate. (Slower = bigger number = easier.)
// Bands are anchored on each level's TYPICAL sustained pace (= the moderate centre):
// beginner ~4:00/100m, intermediate ~3:00, advanced ~2:00. Stroke offsets vs
// freestyle: backstroke +15s, breaststroke +20s, butterfly +30s (all slower).
const SWIM_PACE = {
  beginner: {
    freestyle:    { easyAbove: 280, hardBelow: 200 }, // >4:40 / <3:20
    backstroke:   { easyAbove: 295, hardBelow: 215 }, // >4:55 / <3:35
    breaststroke: { easyAbove: 300, hardBelow: 220 }, // >5:00 / <3:40
    butterfly:    { easyAbove: 310, hardBelow: 230 }, // >5:10 / <3:50
  },
  intermediate: {
    freestyle:    { easyAbove: 210, hardBelow: 150 }, // >3:30 / <2:30
    backstroke:   { easyAbove: 225, hardBelow: 165 }, // >3:45 / <2:45
    breaststroke: { easyAbove: 230, hardBelow: 170 }, // >3:50 / <2:50
    butterfly:    { easyAbove: 240, hardBelow: 180 }, // >4:00 / <3:00
  },
  advanced: {
    freestyle:    { easyAbove: 140, hardBelow: 100 }, // >2:20 / <1:40
    backstroke:   { easyAbove: 155, hardBelow: 115 }, // >2:35 / <1:55
    breaststroke: { easyAbove: 160, hardBelow: 120 }, // >2:40 / <2:00
    butterfly:    { easyAbove: 170, hardBelow: 130 }, // >2:50 / <2:10
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

// Resolve a swim's MET: pace (sec/100m) → category via the level table → the
// level×stroke MET matrix. Missing pace (no distance or duration) → Moderate.
function swimMet(stroke, paceSecPer100, level) {
  const lvl = SWIM_MET[level] ? level : 'intermediate';
  const matrix = SWIM_MET[lvl][stroke] || SWIM_MET[lvl].freestyle;
  const t = (SWIM_PACE[lvl] || SWIM_PACE.intermediate)[stroke];
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

// Steps per km — used to subtract a cardio bout's own steps from the daily step
// total so they aren't double-counted (the bout's calories are scored via MET).
// For RUNS this is only a fallback when duration is unknown; normally runs use
// cadence × time (see runStepCount). Running takes far fewer steps/km than
// walking (longer stride), so the run fallback is ~950, NOT a walking 1300.
const CARDIO_STEPS_PER_KM = {
  run: 950,
  'long-run': 950,
  interval: 950,
  walk: 1400,
  treadmill_run: 950,
  treadmill_walk: 1400,
  hike: 1400,
};

const RUN_TYPES = new Set(['run', 'long-run', 'interval', 'treadmill_run']);

// Running cadence (steps/min), gently nudged by pace: faster pace → slightly
// quicker turnover. ~160 spm easy (6:30/km) → ~178 spm fast (4:30/km), clamped
// to a realistic 150–185 band. No pace → typical 170. Cadence is the *stable*
// part of running; stride length (captured by pace/duration) does the rest.
function runCadenceSpm(paceMinKm) {
  if (!(paceMinKm > 0)) return 170;
  return Math.max(150, Math.min(185, 160 + (6.5 - paceMinKm) * 9));
}

// Steps taken during one cardio bout. Runs: cadence × duration (pace-aware,
// avoids the walking-cadence overcount) when duration is known, else the
// distance × per-km fallback. Walks/hikes: stride-based per-km.
function cardioStepCount(type, km, durationMin) {
  if (RUN_TYPES.has(type) && durationMin > 0) {
    const pace = km > 0 ? durationMin / km : 0;
    return runCadenceSpm(pace) * durationMin;
  }
  return km * (CARDIO_STEPS_PER_KM[type] ?? 0);
}

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

// Compound exercises move large muscle groups + carry bodyweight through space
// → higher load factor (0.45). Isolation exercises have lower systemic demand → 0.25.
const COMPOUND_EXERCISES = new Set([
  'pull-ups','wide pull-ups','chin-ups','hammer pull-ups','wide hammer pull-ups',
  'dips','parallel bars','push-ups','ring push-ups','decline push-ups','diamond push-ups',
  'archer push-ups','pike push-ups','inverted rows','trx low row','ring row',
  'bench press','incline bench press','overhead press','barbell rows',
  'squats','lunges (each leg)','bulgarian split squats','step-ups','leg press','deadlift',
]);

// For these exercises the added weight is literally lifted with the body →
// use (BW + addedKg) / BW instead of the general resistance formula.
const BODYWEIGHT_EXERCISES = new Set([
  'pull-ups','wide pull-ups','chin-ups','hammer pull-ups','wide hammer pull-ups',
  'dips','parallel bars',
]);

// Weight-based mult: 1 + (actualKg / BW)^0.7 × factor
// Hydraulic: fixed band tiers (not weight-based).
// lastNote: resolved note from a previous session (used when current note is ambiguous).
export function resistanceMultiplier(name, note, { weightKg = 58, lastNote = null } = {}) {
  const n = note ? String(note).toLowerCase() : '';
  const key = String(name).toLowerCase();

  // ── Hydraulic ──────────────────────────────────────────────────────────────
  const hydraulicMention = /hydraulic|piston/.test(n);
  const lvl = n.match(/(\d+)\s*\/\s*16/);
  let level = lvl ? parseInt(lvl[1], 10) : null;
  if (!level && /\bmax\b/.test(n) && hydraulicMention) level = 16;
  if (!level && hydraulicMention) { const m2 = n.match(/(\d+)/); if (m2) level = parseInt(m2[1], 10); }
  if (level != null && level >= 1 && level <= 16) {
    const pct = level / 16;
    const mult = pct > 0.70 ? 1.30 : pct > 0.35 ? 1.15 : 1.05;
    return { mult, label: `hydraulic ${level}/16` };
  }
  if (hydraulicMention) {
    return { mult: 1, label: '', needsValue: true,
      ask: `What hydraulic level did you use for ${name}? (1–16, or "Max")` };
  }

  const _kg  = s => { const m = s.match(/(\d+(?:\.\d+)?)\s*k(?:ilo|gs?)?\b/); return m ? parseFloat(m[1]) : null; };
  const _num = s => { const m = s.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : null; };

  // ── Pull-ups / dips: added weight goes on the body → use BW + addedKg ──────
  if (BODYWEIGHT_EXERCISES.has(key)) {
    const addedKg = _kg(n) ?? (/^\s*\d/.test(n) ? _num(n) : null);
    if (addedKg) return { mult: 1, addedWeightKg: addedKg, label: `+${addedKg}kg (total ${Math.round((weightKg + addedKg) * 10) / 10}kg)` };
    const mentionsExtra = n && /weight|vest|\bbelt\b|added|plate|kg|kilo/.test(n);
    if (mentionsExtra) return { mult: 1, label: '', needsValue: true,
      ask: `How much weight are you adding for ${name}? (e.g. "10kg" — weight belt, vest, or plate)` };
    // Any other note on a bodyweight exercise is irrelevant to resistance — never fall through.
    return { mult: 1, label: '' };
  }

  // ── Weight-based ───────────────────────────────────────────────────────────
  const isLeverNote  = s => /outdoor\s*gym|park\s*machine|\bkettlebell\b|urbanix/.test(s);
  const isActualNote = s => /actual|real\s*load|real\s*weight/.test(s);
  const isRegularNote= s => /dumbbell|\bdb\b|barbell|\bbar\b|regular|standard|plate/.test(s);
  const extractKg = _kg;
  const extractNum = _num;
  const mentionsWeight = n => /weight|weighted|outdoor\s*gym|lever|\bkettlebell\b|\bkb\b|dumbbell|\bdb\b|barbell|actual|loaded|added|\bkgs?\b/.test(n)
                           || /^\s*\d+(?:\.\d+)?\s*$/.test(n);

  if (!mentionsWeight(n) && !extractKg(n) && !extractNum(n.replace(/[^\d.]/g,''))) {
    return { mult: 1, label: '' };
  }

  const factor = COMPOUND_EXERCISES.has(key) ? 0.45 : 0.25;
  const applyMult = (actualKg) => {
    const ratio = Math.pow(actualKg / weightKg, 0.7);
    return Math.round((1 + ratio * factor) * 100) / 100;
  };

  // "actual 14kg" or "real load 14kg" → use directly
  if (isActualNote(n)) {
    const kg = extractKg(n) || extractNum(n);
    if (kg) return { mult: applyMult(kg), label: `actual ${kg}kg` };
  }

  // "dumbbell 7kg" / "barbell 60kg" / "regular 7kg" → marked = actual
  if (isRegularNote(n)) {
    const kg = extractKg(n) || extractNum(n);
    if (kg) return { mult: applyMult(kg), label: `${kg}kg dumbbell` };
  }

  // "outdoor gym 7kg" / "park machine 7kg" / "kettlebell 7kg" → equipment known, actual load unknown
  if (isLeverNote(n)) {
    const kg = extractKg(n) || extractNum(n);
    if (kg && lastNote) {
      // If we've resolved the actual load before, reuse it
      const ln = String(lastNote).toLowerCase();
      if (isActualNote(ln)) {
        const actualKg = extractKg(ln) || extractNum(ln);
        if (actualKg) return { mult: applyMult(actualKg), label: `actual ${actualKg}kg`, asLastTime: true };
      }
    }
    // Always ask — we can't assume the machine ratio without seeing it
    return { mult: 1, label: '', needsValue: true,
      ask: `What's the actual load for ${name}? A photo of the machine makes it easy.` };
  }

  // Bare kg / "with weight" — ambiguous. Try last session's note first.
  const kg = extractKg(n) || (/^\s*\d/.test(n) ? extractNum(n) : null);
  if (kg && lastNote) {
    const ln = String(lastNote).toLowerCase();
    if (isActualNote(ln)) {
      const actualKg = extractKg(ln) || extractNum(ln);
      if (actualKg) return { mult: applyMult(actualKg), label: `actual ${actualKg}kg`, asLastTime: true };
    }
    if (isRegularNote(ln)) {
      const lastKg = extractKg(ln) || extractNum(ln);
      if (lastKg) return { mult: applyMult(lastKg), label: `${lastKg}kg dumbbell`, asLastTime: true };
    }
  }
  if (kg) {
    return { mult: 1, label: '', needsValue: true,
      ask: `${name}: was the ${kg}kg the actual load, or the marked weight on the outdoor gym / park machine?` };
  }

  // "with weight" / generic mention, no kg
  return { mult: 1, label: '', needsValue: true,
    ask: `${name}: how much weight? And was it the actual load (dumbbell/barbell) or an outdoor gym / park machine?` };
}

// ---------- MAIN ----------

/**
 * Deterministic session calorie calculation.
 *
 * @param {object} session  - session with entries[], cardioActivities[], time
 * @param {object} opts     - { rpe, weightKg }
 * @returns {{ caloriesBurned, epocToday, epocTomorrow, stepsFromCardio, breakdown }}
 */
export function calculateSessionCalories(session, { rpe = 5, weightKg = 58, swimLevel = 'intermediate', exerciseHistory = {} } = {}) {
  const WEIGHT_KG = weightKg;

  // --- Strength ---
  // Active: exercise MET × active time
  // Rest:   flat 2.3 MET × 1 min per set (first minute only). Recovery between
  //   strength sets is passive (sitting/standing) regardless of how hard the set
  //   was, so it's ~2.3 MET — not a % of the active MET (which over-credits
  //   high-MET moves, e.g. a pull-up rest would read like moderate cycling).
  const STRENGTH_REST_MET = 2.3;
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
    // Resistance scales ACTIVE MET. lastNote from prior session resolves ambiguous bare-kg notes.
    const lastNote = exerciseHistory[entry.name] || exerciseHistory[key] || null;
    const { mult: resistMult, addedWeightKg, label: resistLabel, needsValue, ask: resistAsk, asLastTime } = resistanceMultiplier(entry.name, entry.note, { weightKg, lastNote });
    const effectiveWeight = addedWeightKg ? WEIGHT_KG + addedWeightKg : WEIGHT_KG;
    const activeMet = met * resistMult; // for bodyweight exercises resistMult=1; weight change is in effectiveWeight
    const activeCal = activeMet * 3.5 * effectiveWeight / 200 * (activeSec / 60);
    const restCal   = STRENGTH_REST_MET * 3.5 * WEIGHT_KG / 200 * sets; // 1 min/set, flat 2.3 MET
    strengthBase += activeCal + restCal;
    exCalcs.push({ name: entry.name, met, activeMet, resistMult, addedWeightKg, resistLabel, needsValue, resistAsk, asLastTime, activeSec, sets, legFactor, activeCal, restCal });
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
      stepsFromCardio += cardioStepCount(a.type, r.totalKm, r.totalMin);
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
    stepsFromCardio += cardioStepCount(a.type, km, durationMin);
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
  const questions = []; // routed to session.burnQuestions (the ❓ clarify mechanism)
  let breakdownSum = 0;

  for (const { name, met, activeMet, resistMult, addedWeightKg, resistLabel, needsValue, resistAsk, asLastTime, activeSec, sets, legFactor, activeCal, restCal } of exCalcs) {
    const finalCal = Math.round(activeCal + restCal);
    const legNote = legFactor === 2 ? ' (per-leg ×2)' : '';
    const restMet = STRENGTH_REST_MET.toFixed(1);
    const lastTimeNote = asLastTime ? ', same as last time — update note if changed' : '';
    const metNote = addedWeightKg
      ? `MET ${met} at ${Math.round((WEIGHT_KG + addedWeightKg) * 10) / 10}kg (${resistLabel}${lastTimeNote})`
      : resistMult > 1
        ? `MET ${met}×${resistMult.toFixed(2)}=${activeMet.toFixed(1)} (${resistLabel}${lastTimeNote})`
        : `MET ${met}`;
    const flag = needsValue ? ' ⚠ resistance not fully specified — add it for accuracy' : '';
    if (needsValue) questions.push(resistAsk || `What resistance did you use for ${name}? (hydraulic level 1–16/Max, or weight in kg) — I'll refine the calories.`);
    breakdownSum += finalCal;
    breakdown.push({
      activity: name,
      calories: finalCal,
      reasoning: `${metNote} × ${Math.round(activeSec / 60 * 10) / 10}min active${legNote} + ${sets} × 1min rest at MET ${restMet} = ${finalCal} kcal${flag}`,
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
    questions,
  };
}
