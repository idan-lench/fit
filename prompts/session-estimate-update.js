export const sessionEstimateUpdate = `Based on our conversation above, produce your FINAL revised burn estimate for this workout.

ORIGINAL SESSION:
- Type: {type}
- Date: {date}
- Cardio/activity: {cardioNote}
- Exercises:
{exercises}
- Initial total burn: {currentBurn} kcal
- Initial breakdown: {breakdown}

Return ONLY valid JSON, no markdown:
{
  "total": number,
  "breakdown": [{"activity": "string", "calories": number, "reasoning": "brief"}],
  "notes": "brief overall comment",
  "changeNote": "1-sentence summary of what changed from initial"
}`;

