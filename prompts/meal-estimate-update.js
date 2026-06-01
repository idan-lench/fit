export const mealEstimateUpdate = `Based on our conversation above, produce your FINAL revised calorie estimate for this meal. Use the photos and everything the user has told you.

ORIGINAL MEAL:
- Description: "{description}"
- Initial estimate: {currentCalories} kcal
- Initial breakdown: {breakdown}
- Initial saw: "{aiSaw}"

Return ONLY valid JSON, no markdown, no code fences:
{
  "items": [{"name": "string", "portion": "string", "calories": number, "protein": number}],
  "total": number,
  "totalProtein": number,
  "confidence": "high" | "medium" | "low",
  "saw": "your final understanding of what's in the photo",
  "changeNote": "1-sentence summary of what changed from initial"
}`;

