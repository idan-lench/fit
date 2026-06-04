export const cardioPhoto = `Look at this fitness/activity screenshot and extract the workout stats.

Return ONLY valid JSON, no markdown:
{
  "distance": "string — e.g. '8.2 km' or '5.1 mi' or '' if not visible",
  "duration": "string — e.g. '42 min' or '1h 05min' or '' if not visible",
  "notes": "string — pace, avg HR, elevation, or other useful stats visible in the image, comma-separated. '' if nothing extra."
}`;
