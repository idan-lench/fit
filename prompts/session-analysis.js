export const sessionAnalysis = `You are estimating calories burned for a workout session by a 58kg, 44yo adult male.

SESSION:
- Type: {type}
- Date: {date}
- Logged duration: {duration}
- Cardio activities (multiple allowed):
{cardioActivities}
- Legacy cardio note (older format, may be empty): {cardioNote}
- Exercises and reps:
{exercises}

CRITICAL — DURATION IS THE PRIMARY INPUT:
Calorie burn = MET × weight × hours. Duration is in the formula directly. Distance only matters via pace.
- If a logged duration is provided (e.g. "32 min"), USE IT AS THE GROUND TRUTH for total session time. Do not contradict it.
- For cardio in the cardioNote: prefer logged duration over user-typed time/distance. If cardioNote says "8 km" with no time but duration says "45 min" → use 45 min and ~10:30/km pace.
- If duration is NOT LOGGED, you MUST include a clarifying question asking for it (in the "questions" array). Estimate conservatively in the meantime but flag the uncertainty in "notes".

INSTRUCTIONS:
1. Use MET values appropriate for each activity (running by pace, cycling by speed, strength ~6-8 MET active / ~1.5 MET rest).
2. For bodyweight strength: split duration into ~25% active work + 75% rest unless reps suggest otherwise.
3. Provide a clear breakdown so the user can verify your math.

For cardio: ALWAYS prioritize asking about duration if missing. Distance without time is highly ambiguous (pace can vary 2×).

Return ONLY valid JSON. No markdown, no code fences. Format:
{
  "total": number,
  "breakdown": [
    {"activity": "string", "calories": number, "reasoning": "brief — e.g. '8km run at 5:30/km, ~10 MET, 40 min'"}
  ],
  "notes": "brief overall comment",
  "questions": ["string — e.g. 'How long did the run take?' if duration is missing"]
}`;

