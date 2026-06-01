import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub localStorage and fetch before importing the module.
const ls = new Map();
globalThis.localStorage = {
  getItem: k => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: k => ls.delete(k),
  clear: () => ls.clear(),
};

let lastRequest = null;
let nextResponse = null;
globalThis.fetch = async (url, init) => {
  lastRequest = { url, init };
  return nextResponse;
};

// jsdom-style FileReader stub — Node has Blob but no FileReader.
class FakeFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buf => {
      const b64 = Buffer.from(buf).toString('base64');
      this.result = `data:${blob.type || ''};base64,${b64}`;
      this.onload && this.onload();
    }, err => this.onerror && this.onerror(err));
  }
}
globalThis.FileReader = FakeFileReader;

const { getGeminiKey, setGeminiKey, geminiGenerate, callGeminiAnalysis } =
  await import('./gemini.js');

beforeEach(() => {
  ls.clear();
  lastRequest = null;
  nextResponse = null;
});

test('getGeminiKey returns empty string when unset', () => {
  assert.equal(getGeminiKey(), '');
});

test('setGeminiKey persists and getGeminiKey reads it back', () => {
  setGeminiKey('abc123');
  assert.equal(getGeminiKey(), 'abc123');
  setGeminiKey('');
  assert.equal(getGeminiKey(), '');
});

test('geminiGenerate throws when no API key is set', async () => {
  await assert.rejects(
    () => geminiGenerate({ contents: [{ parts: [{ text: 'hi' }] }] }),
    /API key not set/
  );
});

test('geminiGenerate posts to the correct URL with the key encoded', async () => {
  setGeminiKey('my key&plus');
  nextResponse = {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
  };
  await geminiGenerate({ contents: [{ parts: [{ text: 'hi' }] }] });
  assert.match(lastRequest.url, /generativelanguage\.googleapis\.com/);
  assert.match(lastRequest.url, /gemini-2\.5-pro:generateContent/);
  assert.match(lastRequest.url, /key=my%20key%26plus/);
  assert.equal(lastRequest.init.method, 'POST');
  assert.equal(lastRequest.init.headers['Content-Type'], 'application/json');
});

test('geminiGenerate includes systemInstruction only when provided', async () => {
  setGeminiKey('k');
  nextResponse = { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '' }] } }] }) };

  await geminiGenerate({ contents: [{ parts: [{ text: 'hi' }] }] });
  let body = JSON.parse(lastRequest.init.body);
  assert.equal(body.systemInstruction, undefined);

  await geminiGenerate({ systemInstruction: 'be brief', contents: [{ parts: [{ text: 'hi' }] }] });
  body = JSON.parse(lastRequest.init.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'be brief' }] });
});

test('geminiGenerate unwraps candidates[0].content.parts[0].text', async () => {
  setGeminiKey('k');
  nextResponse = {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'hello world' }] } }] }),
  };
  const out = await geminiGenerate({ contents: [{ parts: [{ text: 'hi' }] }] });
  assert.equal(out, 'hello world');
});

test('geminiGenerate returns empty string when response shape missing', async () => {
  setGeminiKey('k');
  nextResponse = { ok: true, json: async () => ({}) };
  const out = await geminiGenerate({ contents: [{ parts: [{ text: 'hi' }] }] });
  assert.equal(out, '');
});

test('geminiGenerate throws with status code on HTTP error', async () => {
  setGeminiKey('k');
  nextResponse = { ok: false, status: 429, text: async () => 'rate limited' };
  await assert.rejects(
    () => geminiGenerate({ contents: [{ parts: [{ text: 'hi' }] }] }),
    /Gemini 429/
  );
});

test('callGeminiAnalysis attaches inline_data parts for each blob', async () => {
  setGeminiKey('k');
  nextResponse = {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
  };
  // Tiny "fake" blob: gemini.js only needs blob.type and blobToDataUrl(blob).
  // The Node 22 Blob implementation handles both.
  const blob = new Blob(['hello'], { type: 'image/png' });
  await callGeminiAnalysis('describe', [blob]);
  const body = JSON.parse(lastRequest.init.body);
  const parts = body.contents[0].parts;
  assert.equal(parts[0].text, 'describe');
  assert.equal(parts[1].inline_data.mime_type, 'image/png');
  assert.ok(parts[1].inline_data.data.length > 0, 'base64 data attached');
});
