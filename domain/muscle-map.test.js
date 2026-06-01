import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MUSCLE_MAP, computeMuscleHeatmap } from './muscle-map.js';

test('MUSCLE_MAP has entries with values between 0 and 1', () => {
  for (const [exercise, muscles] of Object.entries(MUSCLE_MAP)) {
    for (const [muscle, weight] of Object.entries(muscles)) {
      assert.ok(weight > 0 && weight <= 1.0,
        `${exercise}.${muscle} weight ${weight} out of range`);
    }
  }
});

test('computeMuscleHeatmap returns empty for session with no entries', () => {
  assert.deepEqual(computeMuscleHeatmap({ entries: [] }), {});
  assert.deepEqual(computeMuscleHeatmap({}), {});
});

test('computeMuscleHeatmap accumulates volume correctly', () => {
  const session = {
    entries: [
      { name: 'Push-ups', sets: [{ reps: 10 }, { reps: 10 }] }, // volume=20
    ]
  };
  const result = computeMuscleHeatmap(session);
  // Push-ups: chest=1.0, triceps=0.6, delts_front=0.4, abs=0.2
  assert.ok(result.chest > 0, 'chest should be activated');
  assert.ok(result.triceps > 0, 'triceps should be activated');
  assert.ok(result.chest > result.triceps, 'chest should be primary for push-ups');
});

test('computeMuscleHeatmap sums across multiple exercises', () => {
  const session = {
    entries: [
      { name: 'Push-ups', sets: [{ reps: 10 }] },
      { name: 'Pull-ups', sets: [{ reps: 8 }]  },
    ]
  };
  const result = computeMuscleHeatmap(session);
  assert.ok(result.chest > 0);
  assert.ok(result.lats > 0);
  assert.ok(result.biceps > 0);
});

test('computeMuscleHeatmap ignores exercises not in MUSCLE_MAP', () => {
  const session = {
    entries: [{ name: 'Unknown Exercise XYZ', sets: [{ reps: 10 }] }]
  };
  assert.deepEqual(computeMuscleHeatmap(session), {});
});
