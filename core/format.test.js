import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, parseJSONResponse } from './format.js';

test('escapeHtml encodes &, <, >, "', () => {
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
});

test("escapeHtml does NOT escape single quotes (matches app's existing behavior)", () => {
  // Intentional: existing call sites in index.html use single-quoted attributes
  // with values like `addPlanExercise('${name.replace(/'/g, ...)}')` and handle
  // apostrophes themselves. Changing escapeHtml here would double-escape.
  assert.equal(escapeHtml("a'b"), "a'b");
});

test('parseJSONResponse strips ```json fences', () => {
  assert.deepEqual(parseJSONResponse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSONResponse('```\n{"a":1}\n```'), { a: 1 });
});

test('parseJSONResponse parses bare JSON', () => {
  assert.deepEqual(parseJSONResponse('{"x":2}'), { x: 2 });
});

test('parseJSONResponse extracts JSON object embedded in prose', () => {
  assert.deepEqual(parseJSONResponse('Sure! {"k":"v"} done.'), { k: 'v' });
});

test('parseJSONResponse returns null on garbage', () => {
  assert.equal(parseJSONResponse('no json here'), null);
  assert.equal(parseJSONResponse(''), null);
});
