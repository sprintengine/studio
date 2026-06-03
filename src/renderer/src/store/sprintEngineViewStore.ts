import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

// `summary` is only reachable when the run is complete (the board adds the tab
// and routes to it); a persisted `summary` for an incomplete run falls back.
export type SprintEngineView = 'inbox' | 'roster' | 'tasks' | 'summary'

const SPRINT_ENGINE_VIEW_STORAGE_KEY = 'multicode-sprintengine-view'

const DEFAULT_VIEW: SprintEngineView = 'inbox'

interface SprintEngineViewStore {
  viewByWorkspace: Record<string, SprintEngineView>
  setView: (workspaceId: string, view: SprintEngineView) => void
}

export const useSprintEngineViewStore = create<SprintEngineViewStore>()(
  persist(
    immer((set) => ({
      viewByWorkspace: {},
      setView: (workspaceId, view) =>
        set((state) => {
          state.viewByWorkspace[workspaceId] = view
        }),
    })),
    {
      name: SPRINT_ENGINE_VIEW_STORAGE_KEY,
      version: 1,
    },
  ),
)

export function selectSprintEngineView(
  state: SprintEngineViewStore,
  workspaceId: string,
): SprintEngineView {
  const view = state.viewByWorkspace[workspaceId]
  // `summary` is only valid when the run is complete; the board coerces a stale
  // `summary` to a default view in that case (see `effectiveView`).
  return view === 'inbox' || view === 'roster' || view === 'tasks' || view === 'summary'
    ? view
    : DEFAULT_VIEW
}
