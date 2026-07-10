/**
 * Renderer shim over the shared Sprint Engine pure state helpers.
 *
 * The implementations relocated to `src/shared/sprintengine/state.ts`
 * (sprint-runtime-ownership Phase 2: the main process runs the auto-run
 * planner, which reads this module), following the established shim pattern
 * (`sprintengineAutomationLifecycle.ts`). Existing renderer import sites and
 * tests keep working unchanged; new renderer code may import from either
 * path.
 */
export * from '../../../shared/sprintengine/state'
