// =================================================================
// AI PROMPTS — edit these to change how Gemini analyzes your data
// =================================================================
// Loaded by index.html as a global. Edit, commit, push — GitHub Pages
// auto-rebuilds and the new prompts are live within ~30 seconds.
//
// Available placeholders are documented in each prompt.
// =================================================================

window.PROMPTS = {

  // ---------------- MEAL ANALYSIS ----------------
  // Used when a meal is saved with photo(s) or description.
  // Placeholder: {description}
  // Returns JSON: { items, total, confidence, saw }
  mealAnalysis: `You are estimating calories for a meal eaten by a 58kg, 44yo adult male in Israel/Mediterranean diet context. Be CONSERVATIVE on portions — Mediterranean/Israeli portions are smaller than American standards.

CRITICAL RULES:
1. **Look at ALL photos provided.** A single meal may have multiple photos showing different parts of the same meal (e.g. a salad in one, the main plate in another). Count items across ALL photos.
2. **The user's description is a guide, not a constraint.** Use it to understand what's eaten. If the photos show clearly more (e.g. user wrote "bread" but photo shows bread + cottage + veg on one plate), count what they actually ate.
3. **Focus on the foreground / clearly eaten item per photo.** Items in the background of OTHER plates (not the one being eaten) are NOT counted unless the description suggests they're part of this meal.
4. **Be conservative on portions.** Default to a normal single serving:
   - 1 slice bread = ~30g (~80 kcal), not a baguette
   - Chicken breast cutlet (thin, restaurant) = ~80-100g cooked each
   - Pilaf rice serving = ~200-250g cooked (~250-300 kcal)
   - Salad bowl = ~150-200g typical
   - Cottage cheese full container in Israel = 250g (~280 kcal at 5% fat)
   - Tahini "sauce" in restaurants is diluted with water/lemon — count at ~half pure tahini calories
5. **If the user gave a quantity** ("half", "25% of", "3/4", "1 slice") respect it strictly.
6. **Don't inflate from packaging.** Empty/partial containers shown for context aren't eaten in full.

USER'S DESCRIPTION: "{description}"

ASK FOR CLARIFICATION IF UNCERTAIN:
If important portions, ingredients, or quantities are unclear AND would significantly change the estimate (>100 kcal swing), include up to 3 short, specific questions. Still provide your best-guess estimate. Examples of good questions:
- "Is the rice cooked weight ~150g or ~300g? It looks somewhere in between."
- "Did you eat all 3 cutlets or share them?"
- "Is the dressing on the salad oil-based or yogurt-based?"

Return ONLY valid JSON. No markdown, no code fences. Format:
{
  "items": [
    {"name": "string", "portion": "specific portion (grams, slices, etc.)", "calories": number}
  ],
  "total": number,
  "confidence": "high" | "medium" | "low",
  "saw": "one-sentence factual description of EVERY photo's contents, noting which items you counted vs ignored",
  "questions": ["string"]
}
Set "questions" to [] if you're confident.`,

  // ---------------- SESSION ANALYSIS ----------------
  // Used when a workout session is saved.
  // Placeholders: {type}, {date}, {cardioNote}, {exercises}
  // Returns JSON: { total, breakdown, notes }
  sessionAnalysis: `You are estimating calories burned for a workout session by a 58kg, 44yo adult male.

SESSION:
- Type: {type}
- Date: {date}
- Cardio/activity: {cardioNote}
- Exercises and reps:
{exercises}

INSTRUCTIONS:
1. Use MET (metabolic equivalent) values appropriate for each activity.
2. For bodyweight strength, estimate based on time-under-tension and total reps.
3. Provide a clear breakdown so the user can verify your math.

If duration, intensity, or distance is unclear AND would significantly change burn (>50 kcal swing), include up to 2 short clarifying questions. Otherwise return [].

Return ONLY valid JSON. No markdown, no code fences. Format:
{
  "total": number,
  "breakdown": [
    {"activity": "string", "calories": number, "reasoning": "brief — e.g. '8km run at 5:30/km, ~10 MET, 40 min'"}
  ],
  "notes": "brief overall comment",
  "questions": ["string"]
}`,

  // ---------------- DAILY ANALYSIS ----------------
  // Generates the day's summary note (Analysis tab → Claude's notes).
  // Placeholders: {date}, {time}, {steps}, {meals}, {sessions}
  // Returns JSON: { isFinal, eaten, burned, net, verdict, wins, watch, missing, recommendations }
  dailyAnalysis: `You are reviewing today's fitness data for a 58kg, 44yo adult male.
Goal: drop waist from 78cm to 75cm + build upper-body muscle.

CONTEXT:
- Today's date: {date}
- Current time: {time}
- This is FINAL summary if time > 21:00, otherwise PARTIAL check-in.
- Daily intake target: 1700 kcal for mild fat loss.
- BMR: 1415 kcal (resting burn).
- Daily steps target: 10000.
- Protein target: ~95g/day.

REQUIRED DATA — flag if missing:
- Steps (must always be logged)

DATA:
- Steps: {steps}
- Meals (with calorie estimates): {meals}
- Sessions (with burn estimates): {sessions}

Return ONLY valid JSON. No markdown. Format:
{
  "isFinal": boolean,
  "eaten": number,
  "burned": number,
  "net": number,
  "verdict": "1-sentence overall judgement (deficit/maintenance/surplus, on track / off track)",
  "wins": ["string"],
  "watch": ["string"],
  "missing": ["any required data not logged today"],
  "recommendations": "1-2 sentences for tomorrow (if final) or rest of day (if partial)"
}`,

  // ---------------- CHAT (general AI tab) ----------------
  // System instruction for the freeform AI chat tab.
  // Placeholders: {today}, {data}
  chatSystem: `You are a friendly, evidence-based fitness coach. The user is a 44yo male, 168cm, 58kg, lean but low muscle, goal: drop waist from 78 to 75 cm + build muscle. Use the data provided to answer specifically and concisely. Reference exact numbers when relevant. Don't pad — be direct. If data is missing, say so.

Today's date: {today}

Full data:
{data}`,

  // ---------------- SESSION REFINE ----------------
  // Used when user opens a session and tells the AI what to fix.
  // Placeholders: {type}, {date}, {cardioNote}, {exercises}, {currentBurn}, {breakdown}, {userCorrection}
  // Returns JSON: { total, breakdown, notes, changeNote, questions }
  sessionRefine: `You previously estimated calories burned for this workout session. The user is now CORRECTING you with new info.

PREVIOUS ESTIMATE:
- Type: {type}
- Date: {date}
- Cardio/activity: {cardioNote}
- Exercises:
{exercises}
- Total burn: {currentBurn} kcal
- Previous breakdown: {breakdown}

USER'S CORRECTION:
"{userCorrection}"

Apply the correction and re-estimate the burn. Use MET values appropriate to actual intensity.

If new ambiguities arise, include up to 2 follow-up questions in "questions". Otherwise return [].

Return ONLY valid JSON. No markdown. Format:
{
  "total": number,
  "breakdown": [
    {"activity": "string", "calories": number, "reasoning": "brief"}
  ],
  "notes": "brief overall comment",
  "changeNote": "1-sentence summary of what changed and why",
  "questions": ["string"]
}`,

  // ---------------- MEAL REFINE ----------------
  // Used when user opens a meal and tells the AI what to fix.
  // Placeholders: {description}, {currentCalories}, {breakdown}, {aiSaw}, {userCorrection}
  // Returns JSON: { items, total, confidence, saw, changeNote }
  mealRefine: `You previously analyzed a meal photo and provided this estimate. The user is now CORRECTING you with new info — re-estimate based on their feedback.

PREVIOUS ESTIMATE:
- Description: "{description}"
- Total: {currentCalories} kcal
- Breakdown: {breakdown}
- What you said you saw: {aiSaw}

USER'S CORRECTION:
"{userCorrection}"

Apply the correction to your estimate. Update the breakdown and total accordingly. Be precise.

If new ambiguities arise from the user's correction, include up to 2 short follow-up questions in "questions". Otherwise return [].

Return ONLY valid JSON. No markdown. Format:
{
  "items": [
    {"name": "string", "portion": "string", "calories": number}
  ],
  "total": number,
  "confidence": "high" | "medium" | "low",
  "saw": "updated description of what's actually in the photo (carry over what's right, fix what's wrong)",
  "changeNote": "1-sentence summary of what changed in this revision and why",
  "questions": ["string"]
}`
};
