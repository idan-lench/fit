import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDIO_TYPES, formatCardioActivitiesForAI, cardioLabel, sessionActivityLabel } from './cardio.js';

test('CARDIO_TYPES has at least one entry with required fields', () => {
  assert.ok(CARDIO_TYPES.length > 0);
  for (const c of CARDIO_TYPES) {
    assert.equal(typeof c.key, 'string');
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.showDist, 'boolean');
    assert.equal(typeof c.showDur, 'boolean');
  }
});

test('formatCardioActivitiesForAI returns (none) for empty input', () => {
  assert.equal(formatCardioActivitiesForAI([]), '  (none)');
  assert.equal(formatCardioActivitiesForAI(null), '  (none)');
});

test('formatCardioActivitiesForAI includes label, distance, duration, notes', () => {
  const out = formatCardioActivitiesForAI([
    { type: 'long-run', distance: '8 km', duration: '45 min', notes: 'easy pace' }
  ]);
  assert.match(out, /Long run/);
  assert.match(out, /8 km/);
  assert.match(out, /45 min/);
  assert.match(out, /easy pace/);
});

test('formatCardioActivitiesForAI falls back to last type for unknown key', () => {
  const out = formatCardioActivitiesForAI([{ type: 'unknown-key', distance: '', duration: '', notes: '' }]);
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('cardioLabel maps known + legacy types with an emoji', () => {
  assert.equal(cardioLabel('interval'), '⚡ Speed / interval');
  assert.equal(cardioLabel('long-run'), '🏃 Long run');
  assert.equal(cardioLabel('run'), '🏃 Run');        // legacy alias
  assert.equal(cardioLabel('treadmill_walk'), '🚶 Walk'); // legacy alias
  assert.equal(cardioLabel('mystery'), '🏃 Cardio');  // unknown → generic
});

test('sessionActivityLabel reflects what was actually done', () => {
  const strength = { entries: [{ name: 'Squats', sets: [{ reps: 8 }] }], cardioActivities: [] };
  assert.equal(sessionActivityLabel(strength), '🏋️ Strength workout');

  const run = { entries: [], cardioActivities: [{ type: 'long-run' }] };
  assert.equal(sessionActivityLabel(run), '🏃 Long run');

  const mix = { entries: [{ name: 'Pull-ups', sets: [{ reps: 5 }] }], cardioActivities: [{ type: 'interval' }] };
  assert.equal(sessionActivityLabel(mix), '🏋️🏃 Cardio + strength');

  const multiCardio = { entries: [], cardioActivities: [{ type: 'long-run' }, { type: 'bike' }] };
  assert.equal(sessionActivityLabel(multiCardio), '🏃 Cardio');

  assert.equal(sessionActivityLabel({ entries: [], cardioActivities: [] }), null); // nothing → caller falls back
});
