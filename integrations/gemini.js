// Gemini integration. Single source of truth for the model name, the API
// URL, request shape, and response unwrapping.
//
// CI gate: no other file in the repo is allowed to call
// generativelanguage.googleapis.com — see scripts/check-duplication.js.

import { blobToDataUrl } from '../core/format.js';

const MODEL = 'gemini-2.5-pro';
const KEY_STORAGE = 'fit.geminiKey';

export function getGeminiKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}

export function setGeminiKey(v) {
  if (v) localStorage.setItem(KEY_STORAGE, v);
  else localStorage.removeItem(KEY_STORAGE);
}

// Low-level: takes the Gemini request body (systemInstruction optional,
// contents required), returns the model's text reply. Throws on HTTP error.
export async function geminiGenerate({ systemInstruction, contents, temperature }) {
  const key = getGeminiKey();
  if (!key) throw new Error('Gemini API key not set');
  const body = { contents };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (temperature !== undefined) body.generationConfig = { temperature };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Convenience: single-turn prompt with optional image blobs (mime-typed).
export async function callGeminiAnalysis(prompt, imageBlobs = []) {
  const parts = [{ text: prompt }];
  for (const blob of imageBlobs) {
    const dataUrl = await blobToDataUrl(blob);
    parts.push({
      inline_data: { mime_type: blob.type || 'image/jpeg', data: dataUrl.split(',')[1] },
    });
  }
  return geminiGenerate({ contents: [{ parts }] });
}
