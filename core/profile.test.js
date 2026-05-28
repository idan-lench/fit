import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILE, calcBMR, calcProteinGoal, calcStepsPerKcal } from './profile.js';

test('DEFAULT_PROFILE has expected shape', () => {
  assert.equal(typeof DEFAULT_PROFILE.weightKg, 'number');
  assert.equal(typeof DEFAULT_PROFILE.heightCm, 'number');
  assert.equal(typeof DEFAULT_PROFILE.ageYears, 'number');
  assert.ok(DEFAULT_PROFILE.goals);
  for (const k of ['steps', 'waistCm', 'dailyCalories', 'dailyProteinG']) {
    assert.equal(typeof DEFAULT_PROFILE.goals[k], 'number', `goals.${k} should be number`);
  }
});

test('calcBMR — Mifflin-St Jeor for the default profile yields ~1415', () => {
  // 10*58 + 6.25*168 - 5*44 + 5 = 580 + 1050 - 220 + 5 = 1415
  assert.equal(calcBMR(DEFAULT_PROFILE), 1415);
});

test('calcBMR — female branch subtracts 161 instead of adding 5', () => {
  const male = calcBMR({ weightKg: 70, heightCm: 170, ageYears: 30, sex: 'male' });
  const female = calcBMR({ weightKg: 70, heightCm: 170, ageYears: 30, sex: 'female' });
  assert.equal(male - female, 166); // (+5) - (-161) = 166
});

test('calcProteinGoal — default 1.6g/kg', () => {
  assert.equal(calcProteinGoal({ weightKg: 58 }), 93); // 58*1.6 = 92.8 → 93
  assert.equal(calcProteinGoal({ weightKg: 70 }), 112);
});

test('calcProteinGoal — custom multiplier', () => {
  assert.equal(calcProteinGoal({ weightKg: 70, multiplier: 2.0 }), 140);
});

test('calcStepsPerKcal — anchor at 58kg = 22', () => {
  assert.equal(calcStepsPerKcal({ weightKg: 58 }), 22);
});

test('calcStepsPerKcal — heavier user burns more per step (fewer steps per kcal)', () => {
  const lighter = calcStepsPerKcal({ weightKg: 50 });
  const heavier = calcStepsPerKcal({ weightKg: 90 });
  assert.ok(lighter > heavier, `${lighter} should be > ${heavier}`);
});

test('calcStepsPerKcal — defends against bad input', () => {
  assert.equal(calcStepsPerKcal({ weightKg: 0 }), 22);
  assert.equal(calcStepsPerKcal({ weightKg: -10 }), 22);
});
