# T24 Spec Review: Third-Party Provider Trust Gate

Verdict: changes_requested

## Findings

- HIGH: confirms C2 — blocked trigger providers are not fully inert before fire.
  - Requirement: untrusted/unpermitted SDK providers are blocked/disabled with a clear reason and cannot execute silently.
  - Location: `src/main/automations/provider-registry.ts`, `src/main/automations/polling-trigger-runner.ts`.
  - What I found: the blocked trigger wrapper keeps the original provider `validateConfig` and `requiredIntegrations`. The polling runner calls `validateConfig` and checks integrations before it calls the wrapper `poll`, so a revoked/unpermitted SDK trigger can still run third-party validation code during engine evaluation and can surface a missing-integration blocked run instead of the trust/permission denial.
  - Required fix: make denied trigger registrations fully inert before every provider hook, or check provider permission before any trigger provider method/property path that can influence execution; add an engine-level regression for polling order.
  - Verification: a revoked SDK trigger should produce the trust/permission blocked reason without invoking the original trigger provider hooks.

## Requirement Coverage

- Third-party SDK providers checked before fire: partially met.
  - Implementation: `src/main/modules/automations-module.ts` injects permission-checked provider getters into engine trigger polling and local action execution; `src/main/index.ts` reuses installed-module trust plus Settings -> Modules enablement state; `src/main/automations/provider-registry.ts` turns blocked registrations into non-executing providers.
  - Gap: blocked trigger providers still preserve original `validateConfig`; engine polling calls it before the blocked poll path.
- Blocked/disabled visible reason, no silent execution or fake success: partially met.
  - Implementation: `src/main/ipc/automations-ipc.ts` adds `blockedReason` to `automations:providers:list` and rejects create/update against blocked providers; `src/renderer/src/components/panels/AutomationsPanel/AutomationEditor.tsx` disables blocked actions with the provider reason; engine/executor paths record blocked runs rather than launching.
  - Gap: a blocked trigger with missing integrations can record the integration failure before the trust/permission reason, because integration checks run before blocked `poll`.
- First-party built-ins unaffected and no parallel trust system: met.
  - Implementation: first-party provider owners are detected from `BUNDLED_MODULE_IDS`; third-party module discovery already rejects reserved built-in ids; production wiring uses `readTrustedModulesSync`, `isLoadEligible`, and `readModuleOverridesSync`.
  - Evidence: source trace across `src/shared/modules/manifest.ts`, `src/main/modules/user-module-registry.ts`, and `src/main/index.ts`.
- Required verification: met by implementation evidence, partially rerun by reviewer.
  - Implementation evidence records passing `npm run test:main`, `npm run typecheck`, and `npm run verify:app`.
  - Reviewer reran `npm run test:main:automations-module` and `npm run typecheck`; both passed.
- Knowledge Graph update: met.
  - Implementation: `knowledge/multicode/automations.md` documents the fire-time module gate, blocked reason, and no-fake-success behavior.

## Residual Risk

- Reviewer did not rerun the full `npm run test:main` or `npm run verify:app` suites; focused rerun/typecheck passed, but the blocked trigger ordering gap still requires rework.
