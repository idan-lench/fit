import { geminiGenerate } from '../integrations/gemini.js';
import { PROMPTS } from '../prompts/index.js';

export async function applyTemplateDelta(template, userChange) {
  const breakdownLines = (template.breakdown || []).map(b =>
    `  - ${b.name} (${b.portion || ''}): ${b.calories} kcal${b.protein != null ? `, ${b.protein}g protein` : ''}`
  ).join('\n') || '  (no items)';
  const prompt = PROMPTS.mealTemplateDelta
    .replace('{originalDescription}', template.description || template.name || '')
    .replace('{originalBreakdown}', breakdownLines)
    .replace('{originalTotalCal}', String(template.calories || 0))
    .replace('{originalTotalProtein}', String(template.protein || 0))
    .replace('{userChange}', userChange);
  let text = await geminiGenerate({ contents: [{ parts: [{ text: prompt }] }] });
  text = text.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(text); } catch { return null; }
}
