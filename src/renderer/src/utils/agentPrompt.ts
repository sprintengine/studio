/**
 * Renderer shim over the shared Sprint Engine agent prompt builders.
 *
 * The implementations relocated to `src/shared/sprintengine/agent-prompt.ts`
 * (sprint-runtime-ownership Phase 2: the main process runs the auto-run
 * planner, which composes these prompts), following the established shim
 * pattern (`sprintengineAutomationLifecycle.ts`). Existing renderer import
 * sites and tests keep working unchanged.
 */
export * from '../../../shared/sprintengine/agent-prompt'
