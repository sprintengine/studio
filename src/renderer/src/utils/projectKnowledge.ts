/**
 * Renderer shim over the shared Project Knowledge root resolution helpers.
 *
 * The implementations relocated to `src/shared/project-knowledge.ts`
 * (sprint-runtime-ownership Phase 2: the main process shares the pure Sprint
 * Engine corpus), following the established shim pattern
 * (`sprintengineAutomationLifecycle.ts`). Existing renderer import sites and
 * tests keep working unchanged.
 */
export * from '../../../shared/project-knowledge'
