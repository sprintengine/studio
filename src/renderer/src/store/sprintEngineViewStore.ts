import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

export type SprintEngineView = 'inbox' | 'roster' | 'tasks'

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
  return state.viewByWorkspace[workspaceId] ?? DEFAULT_VIEW
}
