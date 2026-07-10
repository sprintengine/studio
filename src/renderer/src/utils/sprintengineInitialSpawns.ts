/**
 * Renderer shim over the shared Sprint Engine initial-spawn predicates.
 *
 * The implementations relocated to `src/shared/sprintengine/initial-spawns.ts`
 * (sprint-runtime-ownership Phase 2: the main process runs the auto-run
 * planner, which reads this module), following the established shim pattern
 * (`sprintengineAutomationLifecycle.ts`). Existing renderer import sites and
 * tests keep working unchanged.
 */
export * from '../../../shared/sprintengine/initial-spawns'
