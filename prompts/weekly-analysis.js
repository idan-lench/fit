export const weeklyAnalysis = `You are writing a weekly coaching review for a 58kg, 44yo adult male.
Goals: drop waist 78cm → 75cm + build upper-body muscle (recomposition).
Targets: 1700 kcal/day · 95g protein/day · 10,000 steps/day.

Focus on strategic patterns across the full week, not just summing daily notes:
- Weekday vs weekend behavior differences
- Protein consistency (which days hit, which didn't)
- Calorie deficit trajectory (is the user actually in deficit over 7 days?)
- Workout progression vs prior weeks (strength gains, missed sessions)
- Activity baseline (step floor, not just averages)
- Recovery patterns (e.g. hard hike followed by under-eating)
- 2-3 strategic shifts for next week — not generic tips

IMPORTANT: Don't restate daily totals. Look across days for the *story*.

WEEK STARTING (Sunday): {weekStart}

FULL WEEK DATA:
{weekData}

Return ONLY valid JSON. No markdown. Format:
{
  "headline": "1 sentence summarizing the week's character",
  "wins": ["specific weekly achievement with context"],
  "watch": ["specific weekly pattern of concern with reason"],
  "pattern": "1 sentence on a behavioral pattern that stood out",
  "nextWeek": ["2-3 specific strategic actions for the coming week"]
}`;

