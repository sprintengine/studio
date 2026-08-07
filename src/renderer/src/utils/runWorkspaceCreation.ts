/**
 * Renderer shim over the shared run-workspace creation context.
 *
 * Relocated to `src/shared/sprintengine/run-workspace-creation.ts` (MC-2160):
 * main builds the same context when it composes sprint creation headlessly.
 * Existing renderer import sites keep working unchanged.
 */
export * from '../../../shared/sprintengine/run-workspace-creation'
