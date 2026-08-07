/**
 * Renderer shim over the shared run state-file path rules.
 *
 * Relocated to `src/shared/sprintengine/run-state-file.ts` (MC-2160: main
 * derives a new run's directory and `run.yaml` path when it composes sprint
 * creation headlessly). Existing renderer import sites keep working unchanged.
 */
export * from '../../../shared/sprintengine/run-state-file'
