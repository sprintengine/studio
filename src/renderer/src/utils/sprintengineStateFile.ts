/**
 * Renderer shim over the shared Sprint Engine state-file paths.
 *
 * Relocated to `src/shared/sprintengine/state-file.ts` (MC-2160), alongside the
 * generic run path rules it wraps. Existing renderer import sites keep working
 * unchanged.
 */
export * from '../../../shared/sprintengine/state-file'
