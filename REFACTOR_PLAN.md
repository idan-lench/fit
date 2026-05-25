# Fit Tracker — Code Refactor Plan

Goal: split the ~5,500-line `index.html` into small, focused ES modules. No build step, no framework, GitHub Pages still serves directly.

---

## Why

- One global scope = constant collisions (Saturday crash, `today` redeclared, `addBtn` redeclared, etc.)
- Hard to grep / reason about which function touches which UI section
- Every fix risks breaking unrelated code
- Hard to add features without surgery
- **Better code design + reuse**: shared UI components (chat input, charts, heatmap) should live once and be imported in many places. Same for design patterns — once we get a clean approach for one tab, it's easy to apply across the app.

After the refactor: each file < ~300 lines, strict layering, no globals leaking, easy to extend.

---

## Tech Choice

**Native ES modules** in the browser.
- `<script type="module" src="app.js">` — that's it
- No bundler, no npm, no build step
- Each module file gets its own scope via `import` / `export`
- GitHub Pages serves them as-is

**Stay away from**: framework rewrite (overkill), TypeScript (too much overhead for a personal app), bundlers (Vite/webpack would force a build step on every push).

---

## Target Structure

```
fitness-tracker/
├── index.html               # thin: layout, mount points, <script type="module" src="app.js">
├── styles.css               # extracted from <style>
├── app.js                   # entry — wires everything, top-level init
├── body-chart.png           # (existing) — unused, can delete later
├── AGENT_PLAN.md            # (existing) future agent build
├── REFACTOR_PLAN.md         # this file
│
├── prompts/                 # one Gemini prompt per file (≤ ~1000 tokens each)
│   ├── index.js             # re-exports everything: export * from './meal-analysis.js'; …
│   ├── meal-analysis.js
│   ├── meal-analysis-photos-block.js   # photos vs no-photos sub-blocks
│   ├── meal-chat-system.js
│   ├── meal-estimate-update.js
│   ├── meal-template-delta.js
│   ├── session-analysis.js
│   ├── session-chat-system.js
│   ├── session-estimate-update.js
│   ├── daily-analysis.js
│   ├── weekly-analysis.js
│   └── chat-system.js
│
├── core/                    # pure, stateless utilities
│   ├── time.js              # todayISO, formatDate, _isoDate, dow helpers
│   ├── format.js            # escapeHtml, blobToDataUrl, parseJSONResponse
│   ├── dom.js               # $, $$, on, toast, hideToast, autoResizeTA
│   └── constants.js         # STEPS_GOAL, BMR, DAILY_CAL_GOAL, etc.
│
├── data/                    # storage layer
│   ├── state.js             # the global state object + load/save (localStorage)
│   ├── photo-db.js          # IndexedDB open/upgrade
│   ├── meals-store.js       # putMeal, getMeal, getAllMeals, deleteMeal, clearMeals
│   ├── photo-store.js       # putPhoto, getAllPhotos, deletePhoto, clearPhotos
│   └── template-store.js    # putTemplate, getAllTemplates, getTemplate, deleteTemplate
│
├── domain/                  # business logic, no DOM access
│   ├── meals.js             # _recomputeMealTotals, autoAnalyzeMeal, reconcile
│   ├── workouts.js          # session save/load, isCurrentFresh
│   ├── cardio.js            # CARDIO_TYPES, addCardioActivity helpers
│   ├── exercises.js         # EXERCISE_LIBRARY, lastSetsFor
│   ├── plan.js              # PLAN, WEEKLY_PLAN, getPlanKeyForDate, suggestedDay
│   ├── steps.js             # step entry helpers
│   ├── body.js              # waist tracking, photo compare logic
│   ├── templates.js         # save/use/apply-delta logic
│   ├── muscle-map.js        # MUSCLE_MAP, computeMuscleHeatmap
│   └── analysis.js          # daily/weekly summaries, smartUpdateSummaries
│
├── integrations/            # third-party APIs
│   ├── gemini.js            # callGemini, callGeminiAnalysis, getGeminiKey
│   ├── google-fit.js        # OAuth, gfitGetToken, silentSyncGoogleFit
│   └── drive-sync.js        # pullFromDrive, exportData, applyDrivePayload, QR
│
└── ui/                      # rendering — depends on data + domain
    ├── tabs.js              # switchTab + tab init wiring
    ├── workout-tab.js       # renderWorkout, exercise picker, timer card
    ├── meals-tab.js         # renderMeals, meal modal, refine chat
    ├── insights-tab.js      # renderAnalysis, drawEnergyChart
    ├── body-tab.js          # renderBody, renderPhotos, compare UI
    ├── chat-tab.js          # AI chat (later: Coach agent)
    ├── settings.js          # Settings modal, backup buttons, QR setup
    └── shared/              # reusable UI bits
        ├── chart.js         # generic SVG chart helpers
        ├── chat-input.js    # the chat-input-row component (used in 3 places)
        └── heatmap.js       # renderMuscleHeatmapSvg + body-muscles mount
```

---

## Layering Rules

Strict import direction. Lower layers never import from higher layers.

```
core    ← imported by everything
data    ← imports core
domain  ← imports core, data
integrations ← imports core, data
ui      ← imports core, data, domain, integrations
app.js  ← imports ui (entry orchestrator)
prompts/ ← imported by integrations + domain (no imports of its own)
```

Each module:
- ~300 lines is a checkpoint, NOT a hard limit. When a file crosses 300, we pause and evaluate: is it doing one focused thing (keep) or multiple unrelated tasks (split)? A 350-line file doing one job is fine; a 200-line file doing three jobs should split.
- One module = one well-defined responsibility
- Exports only what's needed
- No `window.foo = ...` except where unavoidable for legacy onclick handlers

For onclick handlers in HTML, until they're migrated to `addEventListener`, attach the needed functions to `window` from `app.js`:
```js
import { saveMeal, openMealModal } from './ui/meals-tab.js';
window.saveMeal = saveMeal;
window.openMealModal = openMealModal;
```

---

## Testing & CI

Added as part of the refactor — the current monolithic `index.html` is untestable, but extracted modules will be trivial to cover.

### Tooling

- **`node:test`** — Node's built-in test runner (Node 20+), no npm install needed. `node --test` runs everything.
- **`fake-indexeddb`** (npm) — drop-in IndexedDB mock for tests that touch the storage layer.
- **jsdom** (npm) — minimal DOM simulation for boot-smoke tests.
- Switch to **Vitest** later only if `node:test` feels limited.

### Test layout

Every extracted module gets a sibling test file:
```
domain/
├── meals.js
├── meals.test.js
├── muscle-map.js
├── muscle-map.test.js
└── …
```

What to test (priority order):
1. **Pure functions** in `core/` and `domain/` — math, formatters, helpers. Highest value, lowest cost. (Would have caught the meal-total mismatch and the Saturday `PLAN.sat` crash.)
2. **Storage layer** in `data/` — with `fake-indexeddb`, verify CRUD round-trips.
3. **Integrations** in `integrations/` — mock `fetch`, verify request shape + response handling.
4. **UI render functions** — assert returned HTML strings contain expected fragments (not full DOM testing).
5. **Boot smoke test** — load the app in jsdom, assert no console errors.

### CI workflow (`.github/workflows/ci.yml`)

Runs on every push and PR:
1. `node --check **/*.js` — syntax-check every JS file.
2. `node --test` — run all `*.test.js`.
3. Boot smoke test (a single test file that imports `app.js` into jsdom and asserts no thrown errors).

Goal: turn red on any regression before it reaches `main`.

### Browser-level tests (deferred)

Playwright clicking through real UI flows (add meal, log workout, etc.) is the next step after unit tests if we still hit UI regressions. Out of refactor scope; revisit later.

---

## Migration Steps (incremental)

Each step is its own commit, app stays working after each commit, can roll back.
**During refactor steps that extract a module: also add a sibling `<module>.test.js` covering its pure functions.**

| # | Step | Risk | Effort |
|---|------|------|--------|
| 0 | Set up CI: GitHub Actions workflow with (a) `node --check` syntax check on all `.js` files, (b) jsdom boot smoke test. Adds `package.json`, `.github/workflows/ci.yml`. | Low | 30 min |
| 1 | Convert `index.html` JS into a single `app.js`, load as `<script type="module">`. App works identical to today. | Low | 30 min |
| 2 | Extract `core/` (pure utilities). Imports update in `app.js`. | Low | 1 hr |
| 3 | Extract `data/` storage layer (IndexedDB + localStorage). | Low | 1 hr |
| 4 | Extract `integrations/gemini.js`. | Low | 30 min |
| 5 | Extract `integrations/google-fit.js`. | Low | 30 min |
| 6 | Extract `integrations/drive-sync.js`. | Low | 1 hr |
| 7 | Extract `domain/plan.js`, `exercises.js`, `cardio.js`, `muscle-map.js` (constants + pure functions). | Low | 1.5 hr |
| 8 | Extract `domain/meals.js`, `templates.js`. | Medium | 1.5 hr |
| 9 | Extract `domain/workouts.js`, `steps.js`, `body.js`. | Medium | 1.5 hr |
| 10 | Extract `domain/analysis.js`. | Medium | 1 hr |
| 11 | Extract `ui/shared/` (chart, chat-input, heatmap). | Low | 1 hr |
| 12 | Extract `ui/workout-tab.js`. | High | 1.5 hr |
| 13 | Extract `ui/meals-tab.js`. | High | 1.5 hr |
| 14 | Extract `ui/insights-tab.js`. | High | 1.5 hr |
| 15 | Extract `ui/body-tab.js`. | High | 1 hr |
| 16 | Extract `ui/chat-tab.js`. | Medium | 30 min |
| 17 | Extract `ui/settings.js`. | Medium | 30 min |
| 18 | Extract `<style>` to `styles.css`. | Low | 30 min |
| 19 | Cleanup: remove dead globals, prune `window.*` legacy exports where possible. | Low | 1 hr |
| 20 | Convert `prompts.js` → `prompts/` directory, one file per prompt; verify each ≤ ~1000 tokens; update all imports. | Low | 1 hr |

**Total estimate**: ~22–26 hours including tests (Step 0 + ~15 min of unit tests per module-extraction step), 21 commits, all on one branch.

---

## Branching Strategy (recommendation)

**One single branch `refactor/modules`** with many small commits.

Reasons:
- One PR/merge at the end is simpler than 19 PRs.
- Refactor commits often depend on each other — squashing into separate PRs creates coordination headaches.
- You can still roll back any single commit within the branch.
- Each commit must leave the app working — that's the safety guarantee, not the branch boundary.

**Tag stable checkpoints** with `git tag refactor-step-N` (cheap labels) so you can checkout any milestone.

Merge back to `main` only once the full refactor is done and verified.

---

## Plan Mode?

Not needed for the refactor. Plan mode is best when:
- The change is one-shot (single big edit)
- We need explicit user sign-off on what files will change

For an incremental refactor, the per-step plan is already documented here. Better to just work step-by-step and push after each verified step. If a particular step turns out riskier than expected, we can pause and discuss without invoking plan mode.

---

## Prompts — `prompts/` directory, one file per prompt

The single `prompts.js` becomes a `prompts/` directory with one file per prompt. Easier to read/diff/version each individually, no merge conflicts when editing different prompts, each file can carry its own helper if needed.

Consumers import a single named export or the bundle:
```js
import { mealAnalysis } from './prompts/meal-analysis.js';
// or
import { PROMPTS } from './prompts/index.js';
```

### Prompt size guideline: ≤ ~1000 tokens per prompt

Each prompt file should stay under **~1000 tokens** (rough heuristic: **~3000 characters** / ~750 words). Beyond that:
- The prompt is likely doing too many jobs — split into a focused prompt + sub-blocks (we already do this for `meal-analysis` with `photos-block`).
- Long prompts cost more per call, are harder to maintain, and can confuse the model.

This is enforced as part of the per-step verification (see below).

---

## Verification After Each Step

Quick smoke test after each commit:
1. `node -c` syntax check of all changed `.js` files
2. Reload the app in browser, check console for red errors
3. Click each tab once
4. Add a meal / log a workout / open settings to confirm no regressions
5. **Duplication check**: grep for any function/logic that now lives in two places. Examples:
   - Same helper duplicated across modules → move to `core/` or `domain/` and import
   - Two functions doing the same thing with different names → consolidate
   - Same HTML pattern repeated → extract to a `ui/shared/` component
   - Two AI prompts that have 80% identical text → share a sub-block in `prompts/`
   Allowed duplication: when the two pieces are deliberately independent and likely to diverge (rare — almost never the case during a refactor).
6. **Prompt-length check** (for any step touching `prompts/`): rough token count = chars / 4. Flag any prompt file over ~3000 chars (~1000 tokens) — likely needs splitting.

If anything breaks: `git revert HEAD` and try smaller.

---

## Decisions Made

- **Web Components vs pure functions for UI modules** → **Pure functions**. Returns HTML strings or DOM nodes from plain `function renderXxx(...)`. Less ceremony, easier to read and test. Revisit only if/when shipping to a wider audience or onboarding contributors; the `ui/shared/` structure makes a future migration to Web Components straightforward.
- **Class-based agents** (later, when implementing `AGENT_PLAN.md`) → **Yes** for stateful things like `CoachAgent` — but not for the rest of the codebase.
- **Service worker** → **Add as a follow-up phase right after the refactor.** Reasons:
  - Solves the "user sees stale code after deploy" issue we've already hit several times (a versioned cache + "new version available, tap to reload" prompt).
  - Enables offline support (read meals/workouts without internet).
  - Required for any future APK / TWA distribution and push notifications.
  - Not in refactor scope itself, but next logical phase.
- **Python anywhere?** → **No.** The PWA is static (GitHub Pages, no server). Pyodide-in-browser is too heavy (~6–10 MB) for a fitness tracker. If you ever need Python, run it locally over your exported JSON backups for one-off data analysis — not integrated into the app.
