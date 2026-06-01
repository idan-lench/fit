import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentFresh } from './workouts.js';

test('isCurrentFresh returns true when current is null', () => {
  assert.equal(isCurrentFresh(null), true);
});

test('isCurrentFresh returns true when entries list is empty', () => {
  assert.equal(isCurrentFresh({ entries: [], cardioNote: '', cardioActivities: [] }), true);
});

test('isCurrentFresh returns false when a set has been logged', () => {
  const current = { entries: [{ name: 'Squat', sets: [{ reps: '8' }] }], cardioActivities: [] };
  assert.equal(isCurrentFresh(current), false);
});

test('isCurrentFresh returns false when cardio note is present', () => {
  const current = { entries: [], cardioNote: '20 min run', cardioActivities: [] };
  assert.equal(isCurrentFresh(current), false);
});

test('isCurrentFresh returns false when a cardio activity was added', () => {
  const current = { entries: [], cardioNote: '', cardioActivities: [{ type: 'run' }] };
  assert.equal(isCurrentFresh(current), false);
});

test('isCurrentFresh returns false when an exercise was picked but has no sets', () => {
  const current = { entries: [{ name: 'Squat', sets: [] }], cardioNote: '', cardioActivities: [] };
  assert.equal(isCurrentFresh(current), false);
});
