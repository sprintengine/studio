import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

export type SwitchboardWorkspaceView = 'watchtower' | 'switchboard'

const SWITCHBOARD_VIEW_STORAGE_KEY = 'multicode-switchboard-view'

const DEFAULT_VIEW: SwitchboardWorkspaceView = 'watchtower'

interface SwitchboardViewStore {
  viewByWorkspace: Record<string, SwitchboardWorkspaceView>
  setView: (workspaceId: string, view: SwitchboardWorkspaceView) => void
}

export const useSwitchboardViewStore = create<SwitchboardViewStore>()(
  persist(
    immer((set) => ({
      viewByWorkspace: {},
      setView: (workspaceId, view) =>
        set((state) => {
          state.viewByWorkspace[workspaceId] = view
        }),
    })),
    {
      name: SWITCHBOARD_VIEW_STORAGE_KEY,
      version: 1,
    },
  ),
)

export function selectSwitchboardView(
  state: SwitchboardViewStore,
  workspaceId: string,
): SwitchboardWorkspaceView {
  return state.viewByWorkspace[workspaceId] ?? DEFAULT_VIEW
}
