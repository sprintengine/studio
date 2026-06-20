# T38 Spec Review: Shared Switchboard Read-All

Verdict: approved

## Sources Reviewed

- Task `T38` description, acceptance criteria, implementation notes, C1 implementation summary, and diff evidence.
- Gate-provided plan context for the Phase 2 repo-event trigger transport and verification strategy.
- Current implementation in `src/main/automations/engine.ts`, `src/main/automations/polling-trigger-runner.ts`, `src/main/automations/triggers/repo-event.ts`, and `src/shared/automations/contracts.ts`.
- Regression coverage in `src/main/automations/engine.test.ts`.
- Knowledge update in `knowledge/multicode/automations.md`.

## Requirement Checklist

- K>1 repo-event automations in one project use exactly one Switchboard read per engine tick: met. `engine.ts` creates one poll context per `evaluate()` pass, `polling-trigger-runner.ts` passes it to providers, and `repo-event.ts` memoizes `readAllTasks` with a `workspaceRoot` key.
- Per-automation diff and de-dupe behavior unchanged: met. Event derivation/filtering remains per provider config and polling-runner de-dupe remains keyed by automation id; the new regression verifies both automations fire from the shared read and later duplicate events do not fire.
- Shared read is scoped to one evaluate pass and not reused across ticks: met. The shared-value map is local to `createTriggerPollContext()` inside `evaluate()`, and the regression verifies fresh reads on the second and third ticks.
- Do not add speculative Switchboard/Python filtered-read surface: met. The implementation still calls the existing `readAllTasks` front door.
- Required verification passes, including spawn/read-count regression: met. Locally reran `npm run test:main:automations-engine`, `npm run test:main`, and `npm run typecheck`; all passed.
- Knowledge Graph update for documented automations behavior: met. `knowledge/multicode/automations.md` records the per-evaluation polling context and repo-event shared-read behavior.

## Findings

- None.

## Residual Risk

- The regression counts the Switchboard automation front door rather than the Python spawn function. That matches the task's stated verification method and the implementation leaves the spawn chain behind `readAllTasks` unchanged.
