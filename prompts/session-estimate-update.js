export const sessionEstimateUpdate = `Based on our conversation above, extract any RESISTANCE or added-weight details that were established for the exercises in this session, so the app's deterministic formula engine can recompute the burn. Do NOT calculate calories yourself — the engine does that.

CRITICAL: If anywhere in the conversation a real load was determined for an exercise (the user told you, or you read it from a machine photo / model number), you MUST emit a noteUpdate for it. Do not put the number only in changeNote.

For each exercise with a known resistance, return STRUCTURED fields (the app builds the note text itself, so you don't need to format strings):
- Hydraulic machine: { "kind": "hydraulic", "level": <1-16> }  (treat "max" as level 16)
- Any weight where you know the REAL physical load in kg: { "kind": "actual", "kg": <number> }
  • This includes outdoor gym / kettlebell machines where you read the actual load from the model number in a photo — use the REAL load, not the face label. E.g. model KTB-14 with face label "7 KG" → { "kind": "actual", "kg": 14 }.
  • Regular dumbbell / barbell whose marked weight IS the real load → also { "kind": "actual", "kg": <marked kg> }.
Only emit once you know the actual kg (or hydraulic level). If it is still genuinely unknown, leave noteUpdates empty and ask in changeNote.

Return ONLY valid JSON, no markdown:
{
  "noteUpdates": [{"exercise": "<exact exercise name from the session>", "kind": "actual"|"hydraulic", "kg": <number, for actual>, "level": <1-16, for hydraulic>}],
  "changeNote": "<one short sentence: what resistance you applied>"
}
If no resistance was established, return:
{"noteUpdates": [], "changeNote": "No resistance details to apply."}`;
