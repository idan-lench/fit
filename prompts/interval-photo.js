export const intervalPhoto = `Look at this running-watch / interval-workout screenshot (a lap or split table).
Extract the STRUCTURE of an interval run so a calorie engine can compute each phase.

A typical table has: one warmup lap, several short fast repeated "work" interval laps
(similar short duration + fast pace), and one cooldown lap. Recovery jogs BETWEEN the
work intervals are often NOT shown as their own laps.

Return ONLY valid JSON, no markdown:
{
  "warmup":   { "durationSec": number, "paceSecPerKm": number, "distanceM": number } | null,
  "work":     [ { "durationSec": number, "paceSecPerKm": number, "distanceM": number } ],
  "recovery": { "durationSec": number, "paceSecPerKm": number } | null,
  "cooldown": { "durationSec": number, "paceSecPerKm": number, "distanceM": number } | null,
  "totalDurationSec": number | null
}

Rules:
- durationSec: lap time in seconds. "0:59" → 59, "6:00" → 360.
- paceSecPerKm: pace in seconds per km. "4:15" /km → 255, "7:01" → 421. If the screen shows
  min/mile, convert to per-km (per-km = per-mile ÷ 1.609).
- distanceM: lap distance in meters. "228 m" → 228, "0.23 km" → 230.
- "work" = the repeated fast intervals ONLY, one object per rep, in order. Never put warmup
  or cooldown in "work".
- "warmup" = the first slower/longer lap before the intervals (null if none).
- "cooldown" = the last slower/longer lap after the intervals (null if none).
- "recovery" = the rest jog/walk between work intervals, ONLY if it appears as its own laps;
  otherwise null.
- "totalDurationSec" = total workout / elapsed time if shown anywhere, else null.
- Use null when a value is not visible. Never invent paces or times you cannot read.`;
