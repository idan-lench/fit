import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekStartFor, weekDates, yesterdayISO } from './analysis.js';

test('weekStartFor returns the Sunday of the given week', () => {
  // 2026-05-31 is a Sunday — already the start
  assert.equal(weekStartFor('2026-05-31'), '2026-05-31');
  // 2026-06-02 is a Tuesday — week starts 2026-05-31
  assert.equal(weekStartFor('2026-06-02'), '2026-05-31');
  // 2026-06-06 is a Saturday — week starts 2026-05-31
  assert.equal(weekStartFor('2026-06-06'), '2026-05-31');
});

test('weekStartFor handles month boundaries', () => {
  // 2026-06-01 is Monday — week started 2026-05-31 (Sunday)
  assert.equal(weekStartFor('2026-06-01'), '2026-05-31');
});

test('weekDates returns 7 consecutive dates from the week start', () => {
  const dates = weekDates('2026-05-31');
  assert.equal(dates.length, 7);
  assert.equal(dates[0], '2026-05-31');
  assert.equal(dates[6], '2026-06-06');
});

test('weekDates handles month boundary correctly', () => {
  const dates = weekDates('2026-05-31');
  assert.ok(dates.includes('2026-06-01'));
  assert.ok(dates.includes('2026-06-06'));
});

test('yesterdayISO returns a date in YYYY-MM-DD format', () => {
  const y = yesterdayISO();
  assert.match(y, /^\d{4}-\d{2}-\d{2}$/);
});

test('yesterdayISO is one day before today', () => {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const expected = yesterday.getFullYear() + '-' +
    String(yesterday.getMonth() + 1).padStart(2, '0') + '-' +
    String(yesterday.getDate()).padStart(2, '0');
  assert.equal(yesterdayISO(), expected);
});
