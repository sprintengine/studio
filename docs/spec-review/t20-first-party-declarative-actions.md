# T20 Spec Review: First-Party Declarative Actions

Verdict: approved

## Findings

- None.

## Specification Sources Reviewed

- Task card `T20`
- Active run plan `../plan.md`
- Implementation evidence comment `C1`
- Knowledge Graph note `knowledge/multicode/automations.md`
- Changed implementation and tests in the T20 commit

## Requirement Checklist

| Requirement | Implementation Evidence | Verification | Status |
| --- | --- | --- | --- |
| Register at least one declarative action each for Switchboard, Watchtower, and Sprint Engine through the T19 registry with JSON schema and `requiredIntegrations`. | `src/main/automations/provider-registry.ts`; `src/main/automations/actions/switchboard.ts`; `src/main/automations/actions/sprint-engine.ts` | `src/main/automations/executor-local.test.ts`; `src/main/ipc/automations-ipc.test.ts`; rerun focused tests | Met |
| Invoke each module's existing front-door entry point without duplicated runners or absorbed module logic. | Module-host services in `src/main/modules/switchboard-module.ts`, `src/main/modules/sprint-engine-module.ts`, consumed by `src/main/modules/automations-module.ts`; actions call service-backed front doors only. | Source trace plus `assertFirstPartyActionsInvokeFrontDoors` in `src/main/automations/executor-local.test.ts` | Met |
| Missing/unavailable integration yields a blocked run through `requireIntegration`, with no fake success, verified by tests. | `src/main/automations/executor-local.ts` `requireIntegration`; provider `ctx.requireIntegration(...)` calls before front-door invocation; module resolver in `src/main/modules/automations-module.ts`. | `assertFirstPartyMissingIntegrationBlocksBeforeFrontDoor` in `src/main/automations/executor-local.test.ts` | Met |
| `providers:list` surfaces the new actions in the schema-driven editor without frontend changes; `npm run test:main` and `npm run typecheck` pass. | `src/main/ipc/automations-ipc.ts` maps action providers to schema/required/missing integration views; no renderer changes in T20 commit. | `testProviderListIncludesFirstPartyActionsAndMissingIntegrations`; `testModuleRegistersFirstPartyActionProviders`; reran `npm run test:main` and `npm run typecheck` | Met |
| Update KG with the new built-in first-party actions. | `knowledge/multicode/automations.md` documents Switchboard, Watchtower, Sprint Engine action kinds and required integrations. | Source read of `knowledge/multicode/automations.md` | Met |

## Verification Commands

- `npm run test:main:automations-executor` passed.
- `npm run test:main:automations-ipc` passed.
- `npm run test:main:automations-module` passed.
- `npm run typecheck` passed.
- `npm run test:main` passed.

## Residual Risk

- Review did not run the Electron UI; spec-critical editor coverage is via `automations:providers:list` tests because the task explicitly required no frontend change.
