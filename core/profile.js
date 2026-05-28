// User profile: personal parameters (body metrics + goals).
// Eventual writers: the Coach / Trainer / Dietitian agents (see AGENT_PLAN.md).
// For now, DEFAULT_PROFILE seeds state.profile on first load.

export const DEFAULT_PROFILE = {
  weightKg: 58,
  heightCm: 168,
  ageYears: 44,
  sex: 'male',
  goals: {
    steps: 10000,
    waistCm: 75,
    dailyCalories: 1700,
    dailyProteinG: 95,
  },
};

// Mifflin-St Jeor (1990) — modern standard for BMR estimation.
// male:   10W + 6.25H - 5A + 5
// female: 10W + 6.25H - 5A - 161
export function calcBMR({ weightKg, heightCm, ageYears, sex }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return Math.round(base + (sex === 'female' ? -161 : 5));
}

// Protein target for recomposition: ~1.6g per kg bodyweight is the common
// guideline; the multiplier can later be agent-tuned per training intensity.
export function calcProteinGoal({ weightKg, multiplier = 1.6 }) {
  return Math.round(weightKg * multiplier);
}

// Approximate kcal cost per step is inversely correlated with body weight.
// Anchor: 58 kg ≈ 22 steps/kcal. Linear scale by weight ratio.
export function calcStepsPerKcal({ weightKg }) {
  if (!weightKg || weightKg <= 0) return 22;
  return Math.round(22 * (58 / weightKg));
}
