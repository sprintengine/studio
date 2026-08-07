/**
 * Renderer shim over the shared backlog selection source-plan builder.
 *
 * Relocated to `src/shared/sprintengine/selection-source-plan.ts` (MC-2160) so
 * a headless multi-selection launch builds the byte-identical bundle the
 * Backlog door's multi-select does. Existing renderer import sites keep working
 * unchanged.
 */
export * from '../../../../shared/sprintengine/selection-source-plan'
