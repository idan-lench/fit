import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _isoDate, todayISO, formatDate } from './time.js';

test('_isoDate formats YYYY-MM-DD with zero-padding', () => {
  assert.equal(_isoDate(new Date(2026, 0, 5)), '2026-01-05');  // Jan = 0
  assert.equal(_isoDate(new Date(2026, 11, 31)), '2026-12-31');
  assert.equal(_isoDate(new Date(2026, 4, 1)), '2026-05-01');
});

test('todayISO returns today in YYYY-MM-DD', () => {
  const s = todayISO();
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(s, _isoDate(new Date()));
});

test('formatDate returns human-readable short form', () => {
  // Locale-dependent, just check it returns a non-empty string with a digit
  const out = formatDate('2026-05-28');
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
  assert.match(out, /\d/);
});
