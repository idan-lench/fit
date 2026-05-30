import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXERCISE_LIBRARY, lastSetsFor } from './exercises.js';

test('EXERCISE_LIBRARY has Upper, Lower, Core groups', () => {
  for (const group of ['Upper', 'Lower', 'Core']) {
    assert.ok(Array.isArray(EXERCISE_LIBRARY[group]), `missing group: ${group}`);
    assert.ok(EXERCISE_LIBRARY[group].length > 0);
  }
});

test('lastSetsFor returns reps from most recent session with that exercise', () => {
  const sessions = [
    { entries: [{ name: 'Push-ups', sets: [{ reps: 10 }, { reps: 8 }] }] },
    { entries: [{ name: 'Pull-ups', sets: [{ reps: 6 }] }] },
    { entries: [{ name: 'Push-ups', sets: [{ reps: 12 }, { reps: 10 }] }] },
  ];
  assert.deepEqual(lastSetsFor(sessions, 'Push-ups'), [12, 10]);
  assert.deepEqual(lastSetsFor(sessions, 'Pull-ups'), [6]);
});

test('lastSetsFor returns null when exercise not found', () => {
  assert.equal(lastSetsFor([], 'Push-ups'), null);
  assert.equal(lastSetsFor([{ entries: [{ name: 'Squats', sets: [{ reps: 10 }] }] }], 'Push-ups'), null);
});
