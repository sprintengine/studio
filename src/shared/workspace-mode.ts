// A workspace's kind. `'standard'` is the only mode shared contracts pin by
// name; every other mode (sprintengine, automations-host, …) is renderer-
// owned and flows through shared boundaries as an open string. Lifted here from
// `renderer/src/types/workspace.ts` so shared contracts (e.g. `automation.ts`,
// the main-process automation surface) can name the type without importing the
// renderer — the `shared` layer must not depend on `renderer`. The renderer
// type module re-exports this so its existing import sites keep working.
export type WorkspaceMode = 'standard' | (string & {})

// Background host workspace for per-project Automations (item 1707).
export const AUTOMATIONS_HOST_WORKSPACE_MODE = 'automations-host'
// Execution residency for a Sprint Engine run's agent terminals (item 1767).
export const SPRINT_ENGINE_WORKSPACE_MODE = 'sprintengine'
// True when a workspace of this mode must not appear in the normal workspace
// rail: an instance-level door surface took over finding and steering it, so
// listing it again under one project would claim it belongs there. Hidden means
// hidden from DISCOVERY — the workspace stays in the store, in window
// assignments, and explicitly activatable.
//
// It lives in `shared` because both processes need the same answer and main
// cannot import the renderer: the renderer's `isHiddenFromRail` delegates here,
// and main-side workspace resolution consults it to keep background work out of
// every hidden workspace.
export function isModeHiddenFromRail(mode: WorkspaceMode): boolean {
  return (
    mode === AUTOMATIONS_HOST_WORKSPACE_MODE
    || mode === SPRINT_ENGINE_WORKSPACE_MODE
  )
}
