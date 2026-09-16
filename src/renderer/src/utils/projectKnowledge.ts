/**
 * Renderer shim over the shared Project Knowledge root resolution helpers.
 *
 * The implementations relocated to `src/shared/project-knowledge.ts`
 * (MC-2160: the main process shares the pure
 * Engine corpus), following the established shim pattern
 * path resolution). Existing renderer import sites and
 * tests keep working unchanged.
 */
export * from '../../../shared/project-knowledge'
