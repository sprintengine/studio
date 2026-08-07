/**
 * Renderer shim over the shared chained-sprint team-name resolver.
 *
 * Relocated to `src/shared/sprintengine/chained-team-name.ts` (MC-2160): the
 * self-trigger guard and collision numbering run in main now. It was already
 * pure and dependency-free; existing renderer import sites keep working
 * unchanged.
 */
export * from '../../../shared/sprintengine/chained-team-name'
