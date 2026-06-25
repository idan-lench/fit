export const sessionEstimateUpdate = `Based on our conversation above, extract any RESISTANCE or added-weight details that were established for the exercises in this session, so the app's deterministic formula engine can recompute the burn. Do NOT calculate calories yourself — the engine does that.

CRITICAL: If anywhere in the conversation a real load was determined for an exercise (the user told you, or you read it from a machine photo / model number), you MUST emit a noteUpdate for it. Do not put the number only in changeNote.

For each exercise with a known resistance, return STRUCTURED fields (the app builds the note text itself, so you don't need to format strings):
- Hydraulic machine: { "kind": "hydraulic", "level": <1-16> }  (treat "max" as level 16)
- Any weight where you know the REAL physical load in kg: { "kind": "actual", "kg": <number> }
  • This includes outdoor gym / kettlebell machines where you read the actual load from the model number in a photo — use the REAL load, not the face label. E.g. model KTB-14 with face label "7 KG" → { "kind": "actual", "kg": 14 }.
  • Regular dumbbell / barbell whose marked weight IS the real load → also { "kind": "actual", "kg": <marked kg> }.
Only emit once you know the actual kg (or hydraulic level). If it is still genuinely unknown, leave noteUpdates empty and ask in changeNote.

CARDIO MET OVERRIDE: If the USER explicitly stated a MET value for a cardio activity (e.g. "the movement class is more like MET 3", "use MET 4 for the hike"), emit a metUpdate so the engine uses their number. ONLY when the user gives an explicit MET number — never your own opinion of what the MET should be, and never for runs or swims (their MET comes from pace). Match the activity by its type or label as shown in the session.

Return ONLY valid JSON, no markdown:
{
  "noteUpdates": [{"exercise": "<exact exercise name from the session>", "kind": "actual"|"hydraulic", "kg": <number, for actual>, "level": <1-16, for hydraulic>}],
  "metUpdates": [{"activity": "<cardio type or label from the session, e.g. movement>", "met": <number the user stated>}],
  "changeNote": "<one short sentence: what you applied>"
}
If nothing was established, return:
{"noteUpdates": [], "metUpdates": [], "changeNote": "No details to apply."}`;
