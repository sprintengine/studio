// A workspace's kind. `'standard'` is the only mode shared contracts pin by
// name; every other mode (automations-host, a module-registered type, …) is
// renderer-owned and flows through shared boundaries as an open string. Lifted
// here from `renderer/src/types/workspace.ts` so shared contracts (e.g.
// `automation.ts`, the main-process automation surface) can name the type
// without importing the renderer — the `shared` layer must not depend on
// `renderer`. The renderer type module re-exports this so its existing import
// sites keep working.
export type WorkspaceMode = 'standard' | (string & {})

// Background host workspace for per-project Automations (item 1707).
export const AUTOMATIONS_HOST_WORKSPACE_MODE = 'automations-host'
// True when a BUNDLED workspace mode must not appear in the normal workspace
// rail. Module-registered types that hide from the rail set
// `WorkspaceTypeDefinition.hiddenFromRail` instead; the renderer's
// `isHiddenFromRail` unions this bundled predicate with that flag.
//
// Hidden means hidden from DISCOVERY — the workspace stays in the store, in
// window assignments, and explicitly activatable. It lives in `shared` because
// both processes need the same answer for the remaining bundled host mode and
// main cannot import the renderer.
export function isModeHiddenFromRail(mode: WorkspaceMode): boolean {
  return mode === AUTOMATIONS_HOST_WORKSPACE_MODE
}
