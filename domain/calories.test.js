import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSessionCalories } from './calories.js';

// A movement-class activity uses the table MET (5.0) unless the user overrides it.
function movementSession(metOverride) {
  return {
    entries: [],
    cardioActivities: [{ type: 'movement', duration: '30', ...(metOverride ? { metOverride } : {}) }],
  };
}

test('movement cardio uses table MET (5.0) with no override', () => {
  const r = calculateSessionCalories(movementSession(), { rpe: 5, weightKg: 58 });
  // 5.0 × 3.5 × 58 / 200 × 30 = 152.25
  assert.equal(r.caloriesBurned, 152);
});

test('user MET override (3) lowers the movement burn deterministically', () => {
  const r = calculateSessionCalories(movementSession(3), { rpe: 5, weightKg: 58 });
  // 3.0 × 3.5 × 58 / 200 × 30 = 91.35
  assert.equal(r.caloriesBurned, 91);
});

test('override is surfaced in the breakdown as "(you set)"', () => {
  const r = calculateSessionCalories(movementSession(3), { rpe: 5, weightKg: 58 });
  const row = (r.breakdown || []).find(b => b.activity === 'movement');
  assert.ok(row, 'movement row present');
  assert.match(row.reasoning, /MET 3 \(you set\)/);
});

test('a zero/invalid override is ignored (falls back to table MET)', () => {
  const r = calculateSessionCalories(movementSession(0), { rpe: 5, weightKg: 58 });
  assert.equal(r.caloriesBurned, 152);
});
