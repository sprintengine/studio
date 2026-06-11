<what-to-do>

# Production Reality Gate

Production work defaults to real implementation. Do not treat `MVP`, `first pass`, `local`, or `works in UI` as permission to ship sample data, generated demo entities, fake API responses, mocked transports, stubbed commands, placeholder persistence, disconnected local-only UI state, or controls that only simulate success.

Mocks, fakes, fixtures, and generated sample data are allowed in tests, explicit prototypes, design mockups, or temporary scaffolding only when the task names that deliverable. They are not completion evidence for product behavior.

Before marking implementation or review work done, identify the real source of truth, real mutation path, and real verification evidence for the user-visible behavior. Evidence must exercise the owned application module, IPC/API/CLI contract, file, database, service, command, device, or external integration that the product actually depends on.

If the real dependency is unavailable, blocked, physically unverified, missing from the codebase, or outside the current task, do not claim the product behavior is done. Record a blocker or follow-up, and make the remaining real integration explicit.

Architecture plans and acceptance criteria must fail when the feature only works through hardcoded samples, disconnected UI state, fake success paths, mocks, stubs, or documentation of unverified limits.

</what-to-do>
