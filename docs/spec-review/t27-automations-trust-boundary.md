# T27 Spec Review - Automations Trust Boundary

Verdict: approved

Sources reviewed:
- T27 task card, acceptance criteria, implementation notes, and implementation summary C1.
- Architect plan: `.multi-code/sprintengine/2026-06-17-automations-platform/plan.md`.
- Knowledge notes: `knowledge/README.md`, `knowledge/multicode/automations.md`.
- Code/tests: `src/main/automations/actions/spawn-agent.ts`, `src/main/automations/executor-local.ts`, `src/main/automations/store.ts`, `src/main/ipc/automations-ipc.ts`, `src/main/modules/automations-module.ts`, and matching main-process tests.

Verification run during review:
- `npm run test:main` - passed.
- `npm run typecheck` - passed.

Requirement checklist:
- `review_only` clean-baseline enforcement: met. `spawn-agent` blocks both `review_only` and `allow_changes` before launch when `runtime.isWorkspaceDirty` reports dirty; regression covers a scheduled review-only prompt that asks to write a file and confirms launch is blocked with no renderer delegation.
- `allow_changes` non-git handling: met. `defaultWorkspaceDirtyCheck` treats missing Git repo root as dirty/not reviewable; regression covers a non-git target and confirms launch is blocked.
- IPC `workspaceRoot` trust boundary: met. IPC parses `workspaceRoot` through workspace-sync known folders before store creation or `runNow`; regression rejects an out-of-workspace path and confirms neither store nor engine path is invoked.
- Corrupt individual run file on write path: met. Strict `listRuns` remains fail-closed, while `recordRun` prunes from readable runs only; regression keeps the corrupt file in place and confirms a new run is recorded.
- Real module dirty-check wiring: met. `automations-module.ts` constructs the executor with `defaultWorkspaceDirtyCheck`; module regression captures the real run executor and confirms a non-git launch is blocked before renderer delegation.
- Required validation and KG update: met. `npm run test:main` and `npm run typecheck` pass locally; `knowledge/multicode/automations.md` documents review-only/allow-changes clean-baseline blocking, non-git blocking, IPC root validation, and corrupt-run write-path behavior.

Residual risk:
- Review-only still relies on clean-baseline gating plus prompt policy rather than a hard read-only agent runtime mode. That matches the task's accepted fallback path and leaves post-launch write prevention to normal Git reviewability, not runtime sandboxing.
