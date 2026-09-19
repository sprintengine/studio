/**
 * Renderer shim over the shared backlog scan.
 *
 * Relocated to `src/shared/backlog/scan.ts` (main composes agent
 * creation, and a plan-sourced launch resolves its epic children and selection
 * bundle from a backlog scan). The scan already took a filesystem adapter, so
 * main drives it with node fs; existing renderer import sites keep working
 * unchanged.
 */
export * from '../../../shared/backlog/scan'
