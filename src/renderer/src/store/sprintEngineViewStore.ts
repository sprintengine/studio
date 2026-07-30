import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

// `summary` is only reachable when the run is complete (the board adds the tab
// and routes to it); a persisted `summary` for an incomplete run falls back.
// `repos` exists only where a host offers the Repositories tab (the Sprints
// door, MC-1838); a persisted `repos` elsewhere falls back the same way. `epic`
// exists only on a run seeded from a backlog epic (item 2028) and falls back the
// same way on a goal-seeded run.
export type SprintEngineView = 'inbox' | 'roster' | 'tasks' | 'summary' | 'repos' | 'epic'

const SPRINT_ENGINE_VIEW_STORAGE_KEY = 'multicode-sprintengine-view'

const DEFAULT_VIEW: SprintEngineView = 'inbox'

// Run view state is keyed by run identity — the `statePath` — not by workspace.
// A run opened from its resident workspace and from the Sprints door (a bare
// statePath, no workspace) therefore reads ONE shared record, so the active view
// does not diverge between the two mounts (mirrors backlogViewStore's
// project-key normalization). The caller passes the run key; a pre-init sprint
// workspace with no statePath yet falls back to a `ws:<id>` key upstream.
interface SprintEngineViewStore {
  viewByRun: Record<string, SprintEngineView>
  setView: (runKey: string, view: SprintEngineView) => void
}

// Normalize the run key the same way the run store keys its records, so a
// statePath and its workspace-mount equivalent collapse to one entry.
function runViewKey(runKey: string): string {
  return runKey.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

export const useSprintEngineViewStore = create<SprintEngineViewStore>()(
  persist(
    immer((set) => ({
      viewByRun: {},
      setView: (runKey, view) =>
        set((state) => {
          const key = runViewKey(runKey)
          if (!key) return
          state.viewByRun[key] = view
        }),
    })),
    {
      name: SPRINT_ENGINE_VIEW_STORAGE_KEY,
      // v2: re-keyed from workspaceId to run identity (statePath). Legacy v1
      // per-workspace entries are dropped rather than migrated — the active view
      // is a transient reading preference that resets to the default.
      version: 2,
      migrate: () => ({ viewByRun: {} }),
    },
  ),
)

export function selectSprintEngineView(
  state: SprintEngineViewStore,
  runKey: string,
): SprintEngineView {
  const view = state.viewByRun[runViewKey(runKey)]
  // `summary` is only valid when the run is complete; the board coerces a stale
  // `summary` to a default view in that case (see `effectiveView`).
  return view === 'inbox'
    || view === 'roster'
    || view === 'tasks'
    || view === 'summary'
    || view === 'repos'
    || view === 'epic'
    ? view
    : DEFAULT_VIEW
}
