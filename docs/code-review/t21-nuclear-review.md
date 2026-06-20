# T21 Nuclear Re-Review

Verdict: changes requested.

## Blocking

- `src/main/automations/triggers/repo-event.ts:46` and `src/main/automations/triggers/repo-event.ts:113` accept `eventTypes:['created']`, but `recordToRepoEvent` always emits `eventType:'updated'` at `src/main/automations/triggers/repo-event.ts:164`. The provider exposes a dead config mode: a valid "created" repo-event trigger will never match any Switchboard sync record. Fix by either deriving/marking first-seen imported records as `created` with regression coverage, or removing `created` from schema/validation/docs until Switchboard has a real source-of-truth timestamp for it.

## Fixed Since C2

- `src/main/automations/engine.ts` is back under the nuclear threshold at 753 lines.
- Polling-trigger run orchestration is extracted to `src/main/automations/polling-trigger-runner.ts`.
- Durable trigger de-dupe state is now provider-agnostic as `triggerEventDedupByAutomationId`, with a legacy `repoEventDedupByAutomationId` read migration in `src/main/automations/store.ts`.
- `knowledge/multicode/automations.md` documents the generic polling runner and provider-agnostic state name.

## Evidence Checked

- Read the active T21 task card, latest implementation response C4, prior nuclear feedback C2, and code-review feedback C3.
- Reviewed `src/main/automations/engine.ts`, `src/main/automations/polling-trigger-runner.ts`, `src/main/automations/store.ts`, `src/main/automations/triggers/repo-event.ts`, `src/main/ipc/automations-ipc.ts`, `src/main/modules/automations-module.ts`, `src/shared/automations/contracts.ts`, `knowledge/multicode/automations.md`, and the active sprint plan.
- Ran `git diff --check`: passed.
- Ran `npm run test:main:automations-engine`: passed.
- Ran `npm run test:main:automations-store`: passed.
- Ran `npm run typecheck`: passed.
- Ran a precise source search for generated `created` repo events; only `recordToRepoEvent` references were found, and it emits `updated`.

## Residual Risk

- This gate focused on structural maintainability and provider contract coherence. Full product behavior remains for the code-review/tester/product gates.
