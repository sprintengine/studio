# T28 Spec Review - Automations Engine Overlap Guard

Verdict: changes_requested

Sources reviewed:
- T28 task card, acceptance criteria, implementation notes, and implementation summary C1.
- Architect plan: `.multi-code/sprintengine/2026-06-17-automations-platform/plan.md`.
- Source review context: `.multi-code/sprintengine/2026-06-17-automations-platform/reviews/performance-review-1.md`, `.multi-code/sprintengine/2026-06-17-automations-platform/reviews/final-review-1.md`.
- Knowledge notes: `knowledge/README.md`, `knowledge/multicode/automations.md`.
- Code/tests: `src/main/automations/engine.ts`, `src/main/automations/engine.test.ts`, `src/main/automations/store.ts`, `src/main/automations/store.test.ts`.

Verification run during review:
- `npm run test:main` - passed.
- `npm run typecheck` - passed.

Requirements covered:
- F1 store scan removal: met in current source. `recordRun` validates, writes, then calls `pruneRunHistory`; no discarded `existingRuns`/`listRuns` scan remains. `pruneRunHistory` remains the single run-dir scan for pruning, and existing store tests cover the 50-run bound.
- F3 timer overlap guard: met. `tick()` serializes timer evaluations through `timerEvaluation` and returns an empty evaluation result while a timer evaluation is in flight.
- Slow automation regression: met. `engine.test.ts` starts a slow scheduled run, verifies the overlapping tick is skipped, verifies `runNow` still sees the per-definition `in_flight` guard, then verifies one completed run and next-run cache update.
- Existing single-flight and stop behavior: code-level risk acceptable. The per-definition `inFlight` path is preserved; module stop behavior is untouched and still covered by existing main tests.
- Required commands: met. `npm run test:main` and `npm run typecheck` passed locally.

Findings:

[MEDIUM] KG: Timer overlap guard is not documented in the Automations knowledge note

Requirement:
- Spec-review role rule: when `MULTICODE_KNOWLEDGE_ROOT` is configured and a reviewed change touches a behavior documented in the Knowledge Graph, absence of a corresponding KG note update is blocking.

Location:
- `knowledge/multicode/automations.md:27`
- `src/main/automations/engine.ts:139`

What I found:
- The KG note documents `src/main/automations/engine.ts` scheduling behavior and per-definition in-flight behavior, but T28 adds a durable timer-evaluation guard that skips overlapping timer ticks and prevents concurrent state-cache writes.
- The implementation did not update the KG note to record this behavior.

Why it matters:
- Later engine work will use the KG note for durable scheduler context. Without the update, agents can miss that timer evaluations are process-local serialized separately from per-definition `inFlight`.

Recommended fix:
- Update `knowledge/multicode/automations.md` engine-service bullet to state that timer ticks are non-overlapping: a tick that fires while a previous timer evaluation is in flight is skipped/coalesced, while per-definition `inFlight` still guards manual/timer duplicate runs.

Verification:
- Re-run `npm run typecheck` if only the KG note changes are made; no code test rerun is required for a documentation-only fix unless source changes are included.
