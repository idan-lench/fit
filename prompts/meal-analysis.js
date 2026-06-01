export const mealAnalysis = `You are estimating calories AND protein for a meal eaten by a 58kg, 44yo adult male in Israel/Mediterranean diet context. Be CONSERVATIVE on portions — Mediterranean/Israeli portions are smaller than American standards.

{photosBlock}

CRITICAL RULES:
1. Be conservative on portions:
   - 1 slice bread = ~30g (~80 kcal)
   - Chicken breast cutlet (thin, restaurant) = ~80-100g cooked each
   - Pilaf rice serving = ~200-250g cooked (~250-300 kcal)
   - Salad bowl = ~150-200g typical
   - Cottage cheese full container in Israel = 250g (~280 kcal at 5% fat)
   - Tahini "sauce" in restaurants is diluted — count at ~half pure tahini calories
2. If the user gave a quantity ("half", "25% of", "3/4", "1 slice") respect it strictly.

USER'S DESCRIPTION: "{description}"

ASK FOR CLARIFICATION IF UNCERTAIN:
If important portions, ingredients, or quantities are unclear AND would significantly change the estimate (>100 kcal swing), include up to 3 short specific questions. Still provide your best-guess estimate.

Return ONLY valid JSON. No markdown, no code fences. Format:
{
  "items": [{"name": "string", "portion": "specific portion", "calories": number, "protein": number}],
  "total": number,
  "totalProtein": number,
  "confidence": "high" | "medium" | "low",
  "saw": "{sawInstruction}",
  "questions": ["string"]
}
Set "questions" to [] if confident.`;

export const mealAnalysisPhotosBlock_withPhotos = `PHOTOS ATTACHED:
1. Look at ALL photos provided. A single meal may have multiple photos showing different parts (e.g. salad in one, main plate in another). Count items across ALL photos.
2. The user's description is a guide. If photos show clearly more food (e.g. user wrote "bread" but photo shows bread + cottage + veg on one plate), count what they actually ate.
3. Focus on the foreground / clearly eaten item per photo. Items in the background of OTHER plates (not the one being eaten) are NOT counted.`;

export const mealAnalysisPhotosBlock_noPhotos = `NO PHOTOS PROVIDED — analyze from the description text only.
Do NOT pretend to see photos. Do NOT invent visual details. Base the estimate strictly on the user's written description.`;

export const mealAnalysisSaw_withPhotos = `factual description of EVERY photo's contents, noting items counted vs ignored`;

export const mealAnalysisSaw_noPhotos = `(no photos — analyzed from description only)`;

