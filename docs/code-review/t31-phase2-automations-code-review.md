# T31 Code Review: Phase 2 Automations Integration

Verdict: approved with one medium follow-up finding.

## Findings

- MEDIUM correctness/product quality - `src/main/automations/actions/switchboard.ts:65` exposes `preset: "custom"` in the `watchtower-review` automation schema, but the real Watchtower front door only launches presets with selected agents; `custom` has none and `switchboard_core/watchtower_runner.py:79` returns "Watchtower preset has no review agents." A schema-valid automation can therefore always fail at runtime. Owner: developer. Fix: remove `custom` from the automation action enum until custom agent/sector config is supported, or extend the action config/front door to carry real custom selections. Verification: add an executor or module test asserting every accepted `watchtower-review` preset can start, or that `custom` is rejected before save.

## Approval Notes

- Registry seam passes current Phase 2 scope: `src/main/automations/provider-registry.ts` registers built-ins under namespaced ids, rejects duplicate namespaced ids, and feeds executor/IPC from one registry instance.
- First-party actions compose module-host service-token front doors only: Switchboard/Watchtower in `src/main/modules/switchboard-module.ts`, Sprint Engine in `src/main/modules/sprint-engine-module.ts`, consumed lazily by `src/main/modules/automations-module.ts`.
- Required integrations fail closed through `requireIntegration` before front-door calls for Switchboard, Watchtower, and Sprint Engine actions.
- Repo-event trigger now uses Switchboard import comments for created/external-updated timestamps, not local task `createdAt`/`updatedAt`; provider-agnostic de-dupe state is persisted in `triggerEventDedupByAutomationId`.
- The TS/Python duplicate-import path is coherent: `switchboard_core/store/task_store.py` appends newer external update metadata, `switchboard_core/cli.py` returns `status: "updated"`, and `src/main/switchboard-operations.ts` maps that status through to import summaries.
- Knowledge Graph updates exist in `knowledge/multicode/automations.md` and `knowledge/multicode/switchboard.md` and match the reviewed contracts.

## Verification

- `npm run test:main:automations-executor` passed.
- `npm run test:main:automations-engine` passed.
- `npm run test:main:automations-store` passed.
- `npm run test:main:automations-ipc` passed.
- `npm run test:main:automations-module` passed.
- `npm run test:main` passed.
- `npm run typecheck` passed.
- `python3 -m unittest tests.switchboard_cli.test_cli.SwitchboardCliTests.test_import_task_records_new_external_updated_at_for_duplicate_source` passed.
- `python3 -m unittest tests.switchboard_cli.test_cli` passed (64 tests).
- `git diff --check` passed.

## Residual Risk

- Registry namespace ids are currently internal while renderer-facing definition kinds remain unprefixed for compatibility; Phase 3 SDK/provider work must revisit third-party kind collision behavior before exposing external providers.
- The review did not launch Electron or manually operate the schema-driven editor; coverage is through main-process provider-list/module tests and source inspection.
- No source or test edits were made by this review.
