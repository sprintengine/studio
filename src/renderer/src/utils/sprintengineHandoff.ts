/**
 * Renderer shim over the shared Sprint Engine handoff prompt builder.
 *
 * The builder relocated to `src/shared/sprintengine/handoff-prompt.ts`
 * (MC-2157: main composes the architect handoff prompt itself), following the
 * established shim pattern (`sprintengineAutomationLifecycle.ts`). The module
 * was already pure — its only dependency is `STUDIO_MCP_SERVER_ID` — so
 * nothing renderer-specific stayed behind, and existing renderer import sites
 * keep working unchanged.
 */
export * from '../../../shared/sprintengine/handoff-prompt'
