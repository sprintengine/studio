/**
 * Renderer shim over the shared backlog mockup helpers.
 *
 * Relocated to `src/shared/backlog/mockups.ts` because the shared
 * backlog scan reads them and main now runs that scan headlessly. The module was
 * already pure; existing renderer import sites keep working unchanged.
 */
export * from '../../../shared/backlog/mockups'
