# Fit Tracker — AI Agent Architecture Plan

Parked for after the code refactor.

---

## Goal

Move from "one giant Gemini prompt per feature" to a multi-agent system with shared memory, tools, and a deterministic backbone for calculations. The LLM does interpretation and coaching; code does arithmetic.

## The 3 Agents

### 1. Coach (main user-facing)
- **Role**: the only agent the user talks to directly. Routes to specialists. Maintains long-term memory of the user.
- **System prompt** focuses on: empathy, motivation, knowing the user's goals/profile/history, deciding when to call specialists vs answer directly.
- **Tools** (function-calling):
  - `askDietitian({ question, context })` → invokes Dietitian agent
  - `askTrainer({ question, context })` → invokes Trainer agent
  - `getRecentMeals({ days })`
  - `getRecentWorkouts({ days })`
  - `getBodyProgress({ from, to })` — waist, photos, weight if tracked
  - `addMemory({ type, text })` — saves a long-term fact about the user
  - `updateMemory({ id, text })`
  - `forgetMemory({ id })`

### 2. Dietitian
- **Role**: build/adjust menus, analyze meals, give nutritional feedback. Recomposition-aware.
- **System prompt**: full knowledge of user's targets (currently 1700 kcal · 95 g protein · Mediterranean context), formulas for macro splits, meal planning principles.
- **Tools**:
  - `getNutritionDB({ foodName, grams })` → deterministic kcal/protein from a local table
  - `getRecentMeals({ days })`
  - `computeDailyTotals({ date })`
  - `proposeMenu({ targetKcal, targetProtein, mealCount })` — code-assisted output

### 3. Trainer
- **Role**: build/adjust workout plans, evaluate progress from photos/measurements.
- **System prompt**: knows current weekly plan, principles of recomposition, exercise progressions, MET values.
- **Tools**:
  - `getMETValue({ exerciseName })` → deterministic table lookup
  - `computeBurn({ met, weightKg, hours })` → deterministic formula
  - `getRecentWorkouts({ days })`
  - `getBodyProgress({ from, to })`
  - `proposeWorkout({ day, focus, recentVolume })` — code-assisted output

---

## Determinism Strategy

LLMs are stochastic. To get **same workout → same burn**, math must be in code:

- **`MET_TABLE`** — hard-coded mapping `{ 'pull-ups': 8.0, 'push-ups': 7.0, 'squats': 5.0, ... }`
- **`NUTRITION_DB`** — `{ 'cottage cheese 5%': { kcalPer100g: 112, proteinPer100g: 11 }, ... }`
- **Formulas in JS**: `burn = met × weightKg × hours`, `protein% = (proteinG × 4 / totalKcal) × 100`
- Agent calls these via tools — no arithmetic in LLM output. LLM only chooses which exercise / which food, then code does the math.

Fallback only when no table match → LLM estimates a MET, but flags `confidence: 'low'`.

---

## Memory Model

LLM has zero persistent memory. We simulate it.

- **Storage**: `state.coachMemory[]` (localStorage + Drive backup)
- **Schema**: `{ id, type: 'preference' | 'goal' | 'constraint' | 'observation' | 'fact', text, createdAt, lastReferenced }`
- **Injection**: every Coach call's system prompt prepends:
  ```
  MEMORY about this user:
  - {text 1}
  - {text 2}
  ...
  ```
- **Tools**: `addMemory`, `updateMemory`, `forgetMemory` (Coach decides when to use them based on system-prompt instructions)
- **Capacity**: cap at ~100. Drop oldest unused, or run a "memory consolidation" pass that merges/summarizes.
- **Scoped injection** (later): tag memories by topic so Dietitian only sees nutrition memories, Trainer only sees training memories.

---

## Function Calling (Gemini specifics)

API shape:
```js
{
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
  contents: [...history],
  tools: [{
    functionDeclarations: [
      { name, description, parameters: { type: 'object', properties, required } },
      ...
    ]
  }]
}
```

Response may include `parts[].functionCall`. When present:
1. Look up the function in `LOCAL_TOOLS[name]`
2. Run it (your JS code) → get result
3. Send result back as `{ role: 'user', parts: [{ functionResponse: { name, response: result } }] }`
4. Repeat until response is text only.

Loop usually 1–3 iterations. Set a hard cap (e.g., max 5 iterations) to prevent infinite loops.

---

## Phased Build

### Phase 1 — Coach with data + memory tools (ship-able)
- New `agents.js` (or extend `prompts.js`) with `COACH_SYSTEM` prompt
- Implement `LOCAL_TOOLS`: `getRecentMeals`, `getRecentWorkouts`, `getBodyProgress`, `addMemory`, `updateMemory`, `forgetMemory`
- `state.coachMemory[]` storage
- Replace the existing Chat tab's logic with the Coach agent + function-calling loop
- Cost: ~3–5 hrs work

### Phase 2 — Specialist agents
- Add `DIETITIAN_SYSTEM`, `TRAINER_SYSTEM` prompts
- Add `askDietitian`, `askTrainer` tools (each fires an LLM call with the specialist's system prompt)
- Coach's prompt updated to know when to invoke specialists
- Cost: +2–3 hrs

### Phase 3 — Deterministic math
- Build `MET_TABLE` (covering all exercises in `EXERCISE_LIBRARY`)
- Build `NUTRITION_DB` (top ~100 foods in user's diet)
- Specialists get `getMETValue`, `computeBurn`, `getNutritionDB`, `computeDailyTotals` tools
- Refactor `autoAnalyzeMeal` and `autoAnalyzeSession` to route through specialists (with deterministic math when possible)
- Cost: +4–6 hrs

### Phase 4 — Replace existing prompts
- Migrate `mealAnalysis`, `sessionAnalysis`, `dailyAnalysis`, `weeklyAnalysis`, `chatSystem` to invoke the agents internally
- Consolidate `prompts.js` → just the agent system prompts; everything else lives in code

---

## Open Questions

- Should Coach be on the existing Chat tab or a new tab? (Probably: replace existing Chat tab.)
- How chatty should specialists be back to Coach? (Suggestion: structured JSON responses, Coach paraphrases for the user.)
- Memory: per-conversation summary at the top, or full memory list every time? (Start with full list, optimize later.)
- Token budget: full memory + recent data + tools could push past Gemini's context window if user has lots of history. Add chunking/summarization when needed.

---

## Key Files (when implemented)

- `prompts.js` → split into `COACH_SYSTEM`, `DIETITIAN_SYSTEM`, `TRAINER_SYSTEM`
- `agents.js` (new) → tool declarations + `LOCAL_TOOLS` dispatcher + function-calling loop
- `met_table.js` (new) → exercise → MET map
- `nutrition_db.js` (new) → food → kcal/protein map (or fetch from a public CDN, e.g. USDA FoodData Central if license allows)
- `index.html` → Chat tab wired to Coach agent
