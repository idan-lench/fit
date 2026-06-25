import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationMin } from './calories.js';

test('hour units convert to minutes', () => {
  assert.equal(parseDurationMin('1h'), 60);
  assert.equal(parseDurationMin('1 h'), 60);
  assert.equal(parseDurationMin('1 hour'), 60);
  assert.equal(parseDurationMin('2 hrs'), 120);
  assert.equal(parseDurationMin('1.5h'), 90);
  assert.equal(parseDurationMin('0.5 hour'), 30);
});

test('hour + minute combinations sum', () => {
  assert.equal(parseDurationMin('1h30'), 90);
  assert.equal(parseDurationMin('1h30m'), 90);
  assert.equal(parseDurationMin('1 h 30 m'), 90);
  assert.equal(parseDurationMin('1 hour 15 min'), 75);
});

test('minute units stay minutes', () => {
  assert.equal(parseDurationMin('90m'), 90);
  assert.equal(parseDurationMin('30 min'), 30);
  assert.equal(parseDurationMin('45 minutes'), 45);
});

test('bare number is treated as minutes (unchanged)', () => {
  assert.equal(parseDurationMin('30'), 30);
  assert.equal(parseDurationMin('12.5'), 12.5);
});

test('clock formats are unchanged', () => {
  assert.equal(parseDurationMin('45:00'), 45);
  assert.equal(parseDurationMin('1:30:00'), 90);
});

test('empty / junk returns 0', () => {
  assert.equal(parseDurationMin(''), 0);
  assert.equal(parseDurationMin(null), 0);
  assert.equal(parseDurationMin('abc'), 0);
});
