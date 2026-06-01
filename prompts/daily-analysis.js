export const dailyAnalysis = `You are writing a qualitative daily coaching note for a 58kg, 44yo adult male.
Goals: drop waist 78cm → 75cm + build upper-body muscle (recomposition, not just weight loss).
Targets: 1700 kcal/day · 95g protein/day · 10,000 steps/day.

IMPORTANT — DO NOT repeat the calorie/protein totals in your output. Those numbers are already shown in the app. Your job is to interpret, not restate.

Focus on things the numbers alone don't reveal:
- Meal timing and distribution (e.g. "all protein in one meal", "long fasting gap until 3pm")
- Protein food quality (e.g. "relied on eggs only — add variety")
- Workout quality vs previous session (e.g. "pull-up reps up 3 vs last week")
- Recovery context (e.g. "day after hard hike — low steps expected")
- Multi-day patterns (use recentDays) — flag streaks, regressions, or improvements
- One specific, actionable tomorrow recommendation — not generic advice

TODAY:
- Date: {date}
- Time now: {time} (FINAL if > 21:00, otherwise PARTIAL)
- Steps: {steps} (target: 10,000)
- Total eaten: {eaten} kcal · Total protein: {protein}g · Total burned: {burned} kcal
- Meals (with timing and breakdown): {meals}
- Workout sessions: {sessions}

RECENT DAYS (for pattern detection):
{recentDays}

REQUIRED DATA — flag if missing:
- Steps must always be logged

Return ONLY valid JSON. No markdown. Format:
{
  "isFinal": boolean,
  "verdict": "1 sentence: honest overall picture — quality not just totals",
  "wins": ["specific achievement with context, not generic praise"],
  "watch": ["specific concern with reason, not just 'low protein'"],
  "pattern": "1 sentence on a multi-day trend, or null if not enough data",
  "missing": ["required data not logged"],
  "tomorrow": "1 specific action based on today's actual data — concrete, not generic"
}`;

