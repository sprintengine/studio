/**
 * Renderer shim over the shared backlog epic grouping.
 *
 * Relocated to `src/shared/backlog/epics.ts` alongside the scan it
 * reads. It was already pure and DOM-free; existing renderer import sites keep
 * working unchanged.
 */
export * from '../../../shared/backlog/epics'
