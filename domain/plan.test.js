import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, WEEKLY_PLAN, getPlanKeyForDate, suggestedDay } from './plan.js';

test('PLAN has the expected workout keys', () => {
  for (const key of ['tue', 'wed', 'thu', 'sun', 'custom']) {
    assert.ok(key in PLAN, `PLAN missing key: ${key}`);
    assert.equal(typeof PLAN[key].label, 'string');
  }
});

test('WEEKLY_PLAN covers all 7 days', () => {
  assert.equal(WEEKLY_PLAN.length, 7);
  const days = WEEKLY_PLAN.map(d => d.day);
  assert.ok(days.includes('Monday'));
  assert.ok(days.includes('Sunday'));
  assert.ok(days.includes('Saturday'));
});

test('getPlanKeyForDate returns correct key for known days', () => {
  // 2026-05-31 is a Sunday → 'sun'
  assert.equal(getPlanKeyForDate('2026-05-31'), 'sun');
  // 2026-06-02 is a Tuesday → 'tue'
  assert.equal(getPlanKeyForDate('2026-06-02'), 'tue');
  // 2026-06-03 is a Wednesday → 'wed'
  assert.equal(getPlanKeyForDate('2026-06-03'), 'wed');
  // 2026-06-04 is a Thursday → 'thu'
  assert.equal(getPlanKeyForDate('2026-06-04'), 'thu');
});

test('getPlanKeyForDate returns null for rest days', () => {
  // 2026-06-01 is a Monday → rest
  assert.equal(getPlanKeyForDate('2026-06-01'), null);
  // 2026-06-06 is a Saturday → rest
  assert.equal(getPlanKeyForDate('2026-06-06'), null);
});

test('suggestedDay returns a valid PLAN key or custom', () => {
  const result = suggestedDay();
  assert.ok(result === 'custom' || result in PLAN, `unexpected suggestedDay: ${result}`);
});
