export const mealTemplateDelta = `The user is logging a meal that is almost identical to a saved template. Apply ONLY the change they described — keep everything else IDENTICAL.

ORIGINAL TEMPLATE:
- Description: "{originalDescription}"
- Total: {originalTotalCal} kcal · {originalTotalProtein}g protein
- Breakdown:
{originalBreakdown}

USER'S CHANGE: "{userChange}"

CRITICAL RULES:
1. Items NOT mentioned by the user MUST be returned EXACTLY as in the original (same name, portion, calories, protein).
2. If the user adds something → include it as a new item with realistic kcal/protein.
3. If the user removes something → drop only that item.
4. If the user swaps/changes a portion → adjust that item only.
5. Recompute total and totalProtein from the new items.

Return ONLY valid JSON. No markdown, no code fences:
{
  "items": [{"name": "string", "portion": "string", "calories": number, "protein": number}],
  "total": number,
  "totalProtein": number,
  "changeNote": "1-sentence description of what changed vs the template (e.g. 'Added one boiled egg.')"
}`;

