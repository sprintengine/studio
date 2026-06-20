# T4 Nuclear Review

Verdict: approved

## Blocking

- None.

## Important

- Prior nuclear finding C3 is fixed. `modules:set-enablement` now calls the
  active main kernel live applier, and the implementation keeps live mutation
  scoped to `automations` instead of introducing a broad generic hot-reload path.
- `MainKernel.unregisterModule` removes module-owned shutdown/startup hooks,
  sidecars, IPC handlers, and services before re-registration. The same-kernel
  regression test verifies OFF stops the scheduler and removes `automations:*`;
  ON creates a new engine instance, restarts it, and restores the IPC surface.
- No structural blocker found in the Automations module wrapper, IPC controller,
  or module-host extension. The added live path is localized and avoids
  launch-time/test-only semantics.

## Evidence

- Read the active T4 gate prompt, `knowledge/README.md`,
  `knowledge/multicode/automations.md`, and the committed T4 source paths.
- Reviewed `src/main/index.ts`, `src/main/register-core-ipc.ts`,
  `src/main/ipc/module-enablement-ipc.ts`,
  `src/main/module-host/load-modules.ts`,
  `src/main/module-host/main-host.ts`,
  `src/main/modules/automations-module.ts`,
  `src/main/ipc/automations-ipc.ts`, and
  `src/main/modules/automations-module.test.ts`.
- `npm run test:main:automations-module`: passed.
- `npm run test:main:automations-ipc`: passed.
- `npm run test:renderer:bundled-ids`: passed with existing `import.meta` CJS
  warnings only.
- `npm run typecheck`: passed.
- `git diff --check HEAD`: passed.

## Residual Risk

- I did not launch the full Electron Settings UI; review confidence comes from
  source inspection plus same-kernel main-process tests for the live toggle
  contract.
