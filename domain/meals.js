import { getAllMeals, getMeal, putMeal } from '../data/meals-store.js';
import { getGeminiKey, callGeminiAnalysis } from '../integrations/gemini.js';
import { parseJSONResponse } from '../core/format.js';
import { toast, hideToast } from '../core/dom.js';

export function mealBlobs(m) {
  // Backwards compat: old records had `blob`, new ones have `blobs[]`
  if (Array.isArray(m.blobs)) return m.blobs;
  if (m.blob) return [m.blob];
  return [];
}

// Always trust the itemized breakdown over the AI's claimed totals — LLMs
// frequently get the addition wrong (e.g. removes an item but forgets to
// subtract its calories from the total). Returns recomputed { total, protein }.
export function recomputeMealTotals(items) {
  if (!Array.isArray(items)) return { total: null, protein: null };
  let cal = 0, prot = 0;
  let hasCal = false, hasProt = false;
  for (const it of items) {
    if (typeof it.calories === 'number') { cal += it.calories; hasCal = true; }
    if (typeof it.protein === 'number') { prot += it.protein; hasProt = true; }
  }
  return {
    total: hasCal ? Math.round(cal) : null,
    protein: hasProt ? Math.round(prot) : null
  };
}

// One-time per-load reconciliation: fix any meals where stored calories/protein
// don't match the sum of their breakdown items (legacy bug fixed in app, but
// existing records still hold the old wrong total).
let _reconciled = false;
export async function reconcileMealTotals() {
  if (_reconciled) return;
  _reconciled = true;
  const meals = await getAllMeals();
  for (const m of meals) {
    if (!Array.isArray(m.breakdown) || m.breakdown.length === 0) continue;
    const totals = recomputeMealTotals(m.breakdown);
    if (totals.total == null) continue;
    const calMismatch = typeof m.calories === 'number' && Math.abs(m.calories - totals.total) > 1;
    const protMismatch = totals.protein != null && typeof m.protein === 'number' && Math.abs(m.protein - totals.protein) > 1;
    if (calMismatch || protMismatch) {
      m.calories = totals.total;
      if (totals.protein != null) m.protein = totals.protein;
      await putMeal(m);
    }
  }
}

// Returns true on success. Callers are responsible for calling renderMeals() / renderAnalysis().
export async function autoAnalyzeMeal(mealId, opts = {}) {
  const PROMPTS = window.PROMPTS || {};
  if (!getGeminiKey()) return false;
  const meal = await getMeal(mealId);
  if (!meal) return false;
  if (!opts.silent) toast('Analyzing meal…', { persistent: true });
  try {
    const blobs = mealBlobs(meal);
    const hasPhotos = blobs && blobs.length > 0;
    const photosBlock = hasPhotos
      ? PROMPTS.mealAnalysisPhotosBlock_withPhotos
      : PROMPTS.mealAnalysisPhotosBlock_noPhotos;
    const sawInstruction = hasPhotos
      ? PROMPTS.mealAnalysisSaw_withPhotos
      : PROMPTS.mealAnalysisSaw_noPhotos;
    const prompt = PROMPTS.mealAnalysis
      .replace('{description}', meal.description || '(none)')
      .replace('{photosBlock}', photosBlock)
      .replace('{sawInstruction}', sawInstruction);
    const result = await callGeminiAnalysis(prompt, blobs);
    const parsed = parseJSONResponse(result);
    if (parsed && typeof parsed.total === 'number' && parsed.total > 0 && parsed.total < 5000) {
      const fresh = await getMeal(mealId);
      if (fresh) {
        const items = parsed.items || [];
        const totals = recomputeMealTotals(items);
        fresh.calories = totals.total != null ? totals.total : Math.round(parsed.total);
        fresh.protein  = totals.protein != null ? totals.protein
                       : (typeof parsed.totalProtein === 'number' ? Math.round(parsed.totalProtein) : null);
        fresh.breakdown = items;
        fresh.confidence = parsed.confidence || null;
        fresh.aiSaw = parsed.saw || null;
        fresh.questions = (parsed.questions || []).filter(q => q && q.trim());
        await putMeal(fresh);
      }
      const finalCal = (await getMeal(mealId))?.calories || parsed.total;
      if (!opts.silent) { hideToast(); toast(`Meal: ~${finalCal} kcal ✓`); }
      return true;
    }
    if (!opts.silent) { hideToast(); toast('Could not parse estimate'); }
    return false;
  } catch (e) {
    if (!opts.silent) { hideToast(); toast('Analysis failed'); }
    return false;
  }
}
