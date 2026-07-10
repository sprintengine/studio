/**
 * Renderer shim over the shared canonical path helpers.
 *
 * The implementations relocated to `src/shared/paths.ts`
 * (sprint-runtime-ownership Phase 2: the main process shares the pure Sprint
 * Engine corpus, which reads these helpers), following the established shim
 * pattern (`sprintengineAutomationLifecycle.ts`). Existing renderer import
 * sites and tests keep working unchanged.
 */
export * from '../../../shared/paths'
