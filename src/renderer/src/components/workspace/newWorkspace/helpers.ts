/**
 * Renderer shim over the shared source-path helpers.
 *
 * The implementations relocated to `src/shared/source-paths.ts` (MC-2160: main
 * resolves plan sources and derives names with these). They were already pure — `basename` from `shared/paths` was the
 * only dependency — so nothing renderer-specific stayed behind, and existing
 * renderer import sites keep working unchanged.
 */
export * from '../../../../../shared/source-paths'
