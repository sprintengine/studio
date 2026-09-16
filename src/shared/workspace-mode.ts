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

// Workspace-mode strings whose features were retired. Kept as plain literals
// rather than live `WorkspaceMode` constants precisely because nothing may mint
// them again: they are legacy values with no producer left, named here only so
// persisted state written by an older build can be filtered. One list for both
// processes: main drops these rows when it loads its registry (so its own
// consumers — the gateway's `workspace_list`, the phone snapshot — never see
// them) and refuses to adopt one, and the renderer drops them on every
// list-entry path (`dropRetiredModeWorkspaces`) and on registry adoption.
//
//   `roadmap`   — store v65: the per-project Roadmap workspace became an
//                 instance-global sidebar surface, and that surface was itself
//                 deleted on 2026-09-05. The plans on disk (the home project's
//                 `backlog/roadmaps/`) are untouched files.
//   `multiloop` — store v66: the feature was removed outright. Any loop state on
//                 disk under the project folder is untouched.
//   `guided-brief` — 2026-09-08: the Design Wizard was deleted outright. The
//                 files it wrote into the project (product/, architecture/,
//                 mockups/, design-system/) are untouched; only the workspace
//                 row, which nothing can render any more, is dropped.
//   `reviews-host` — 2026-09-10: Reviews left the app for an installable module,
//                 which spawns its guide into the workspace the door was opened
//                 from, so the per-project background host has no producer left.
//                 The row and the guide-terminal agent records nested in it go;
//                 the review data on disk (`.sprintengine/review/`) is untouched.
//   `sprintengine` — 2026-09-16: the in-tree sprint engine was deleted outright.
//                 Nothing registers the workspace type any more, so the row has
//                 no surface to render; the run's own files under the project's
//                 `.sprintengine/` sidecar are untouched.
export const RETIRED_WORKSPACE_MODES: readonly string[] = [
  'roadmap',
  'multiloop',
  'guided-brief',
  'reviews-host',
  'sprintengine',
]

export function isRetiredWorkspaceMode(mode: unknown): boolean {
  return typeof mode === 'string' && RETIRED_WORKSPACE_MODES.includes(mode)
}
