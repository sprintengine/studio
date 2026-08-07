/**
 * Renderer shim over the shared saved-roster helpers.
 *
 * Relocated to `src/shared/sprintengine/saved-rosters.ts` (MC-2160): a headless
 * `sprint.create` resolves the run's roster from main's mirrored role settings
 * through these same rules. They were already pure; existing renderer import
 * sites keep working unchanged.
 */
export * from '../../../../../shared/sprintengine/saved-rosters'
