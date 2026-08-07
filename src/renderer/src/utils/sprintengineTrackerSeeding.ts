/**
 * Renderer shim over the shared tracker-proxy seeding helpers.
 *
 * Relocated to `src/shared/sprintengine/tracker-seeding.ts` (MC-2160): a
 * headless plan-sourced launch derives its goal from the source heading with
 * `derivePlanSourcedGoal`. The module was already pure; existing renderer import
 * sites keep working unchanged.
 */
export * from '../../../shared/sprintengine/tracker-seeding'
