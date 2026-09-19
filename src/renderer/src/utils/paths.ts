/**
 * Renderer shim over the shared canonical path helpers.
 *
 * The implementations relocated to `src/shared/paths.ts`
 * (the main process shares the pure
 * Engine corpus, which reads these helpers), following the established shim
 * path resolution). Existing renderer import
 * sites and tests keep working unchanged.
 */
export * from '../../../shared/paths'
