// A workspace's kind. `'standard'` is the only mode shared contracts pin by
// name; every other mode (sprintengine, review, guided-brief, …) is renderer-
// owned and flows through shared boundaries as an open string. Lifted here from
// `renderer/src/types/workspace.ts` so shared contracts (e.g. `automation.ts`,
// the main-process automation surface) can name the type without importing the
// renderer — the `shared` layer must not depend on `renderer`. The renderer
// type module re-exports this so its existing import sites keep working.
export type WorkspaceMode = 'standard' | (string & {})
