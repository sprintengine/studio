import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

import type { BacklogGroup, BacklogSort, BacklogView } from '../types/workspace'
import { normalizeProjectRootKey } from '../utils/projectKnowledge'
import { normalizeWorkspaceBacklogState } from './slices/workspacesSlice'

// The Backlog "presentation" of a project — the lens, sort, and grouping — lives
// here, keyed by project path rather than per-workspace. Two workspaces open on
// the same project therefore read (and live-update) ONE shared record, so the
// backlog reads as one list per project instead of diverging per window. Which
// item is selected stays per-workspace (a navigation position), and the search
// query is ephemeral (never persisted); both are handled in BacklogPanel.
const STORAGE_KEY = 'multicode-backlog-project-view'

export interface BacklogProjectView {
  view: BacklogView
  sort: BacklogSort
  group: BacklogGroup
}

export const DEFAULT_BACKLOG_PROJECT_VIEW: BacklogProjectView = {
  view: 'active',
  sort: 'recent',
  group: 'none',
}

// The SAME identity useSharedBacklogScan uses for its subscription key
// (normalizeProjectRootKey lowercased), so the shared scan and the shared view
// agree on which project two workspaces belong to. A null/blank path has no key
// (the panel handles a missing folder separately).
function projectKey(folderPath: string | null | undefined): string | null {
  if (!folderPath) return null
  return normalizeProjectRootKey(folderPath)?.toLowerCase() ?? folderPath
}

// Coerce a stored/seed record to the valid enum set, reusing the workspace
// backlog normalizer so the lens/sort/group value guards live in exactly one
// place (workspacesSlice). A non-object or unknown-enum value falls back to the
// default for that field.
function coerceProjectView(input: unknown): BacklogProjectView {
  const normalized = normalizeWorkspaceBacklogState(input && typeof input === 'object' ? input : {})
  return {
    view: normalized?.view ?? DEFAULT_BACKLOG_PROJECT_VIEW.view,
    sort: normalized?.sort ?? DEFAULT_BACKLOG_PROJECT_VIEW.sort,
    group: normalized?.group ?? DEFAULT_BACKLOG_PROJECT_VIEW.group,
  }
}

function isDefaultProjectView(value: BacklogProjectView): boolean {
  return (
    value.view === DEFAULT_BACKLOG_PROJECT_VIEW.view &&
    value.sort === DEFAULT_BACKLOG_PROJECT_VIEW.sort &&
    value.group === DEFAULT_BACKLOG_PROJECT_VIEW.group
  )
}

interface BacklogViewStore {
  viewByProject: Record<string, BacklogProjectView>
  setProjectView: (folderPath: string | null | undefined, patch: Partial<BacklogProjectView>) => void
  // One-time migration hook: seed the shared record from a workspace's legacy
  // per-workspace backlog state the first time a panel on the project mounts, so
  // existing lens/sort/group preferences carry over. A no-op once an entry
  // exists, and skips a pure-default seed so the store stays sparse.
  seedProjectViewIfAbsent: (folderPath: string | null | undefined, seed: unknown) => void
}

export const useBacklogViewStore = create<BacklogViewStore>()(
  persist(
    immer((set) => ({
      viewByProject: {},
      setProjectView: (folderPath, patch) =>
        set((state) => {
          const key = projectKey(folderPath)
          if (!key) return
          const current = state.viewByProject[key] ?? DEFAULT_BACKLOG_PROJECT_VIEW
          state.viewByProject[key] = coerceProjectView({ ...current, ...patch })
        }),
      seedProjectViewIfAbsent: (folderPath, seed) =>
        set((state) => {
          const key = projectKey(folderPath)
          if (!key || state.viewByProject[key]) return
          const seeded = coerceProjectView(seed)
          if (isDefaultProjectView(seeded)) return
          state.viewByProject[key] = seeded
        }),
    })),
    {
      name: STORAGE_KEY,
      version: 1,
    },
  ),
)

// Selector: the shared presentation for a project, defaults for an absent entry.
// Returns a fresh object, so pair with useShallow in components to avoid a
// re-render when the fields are unchanged.
export function selectBacklogProjectView(
  state: BacklogViewStore,
  folderPath: string | null | undefined,
): BacklogProjectView {
  const key = projectKey(folderPath)
  const entry = key ? state.viewByProject[key] : undefined
  return entry ? coerceProjectView(entry) : DEFAULT_BACKLOG_PROJECT_VIEW
}
