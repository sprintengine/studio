import { useEffect, useMemo } from 'react'
import { create } from 'zustand'

import type { SprintEngineState, SprintEngineWorkspaceContext } from '../types/workspace'
import { normalizeSprintEngineProjection } from '../utils/sprintengine'

// A run-scoped data source the board and its satellites consume instead of a
// `workspaceId`. It resolves the same four things from EITHER a resident
// workspace (today's path, unchanged) OR a bare `statePath` with no workspace,
// so the Sprints door can mount any run — including historical runs whose
// workspace no longer exists. `workspaceId` is present only for the
// workspace-resolved construction; workspace-only actions (open terminals,
// launch sessions) read it and degrade to disabled when it is absent.
export interface SprintRunHandle {
  statePath: string
  sprintEngineContext: SprintEngineWorkspaceContext | null
  sprintEngineState: SprintEngineState
  // Applies a freshly-read projection to the board's displayed state. Routes to
  // the workspace store for a workspace handle, or to this run-store slice for a
  // statePath handle, so the same board code updates through either mount.
  setSprintEngineState: (state: SprintEngineState) => void
  // Re-reads the projection for a statePath handle. Omitted for a workspace
  // handle, whose refresh runs through the workspace projection supervisor.
  refresh?: () => Promise<void>
  workspaceId?: string
}

// The same normalization the mounted-run link uses (backslashes → forward
// slashes, no trailing slash, lowercased), so a run opened by workspace and by
// statePath resolves to ONE store record and shares its view state.
export function normalizeStatePathKey(statePath: string): string {
  return statePath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function runDirectoryOf(statePath: string): string {
  return statePath.replace(/[\\/]+run\.ya?ml$/iu, '')
}

function teamSlugFromStatePath(statePath: string): string {
  const dir = runDirectoryOf(statePath).replace(/\\/g, '/').replace(/\/+$/u, '')
  const segment = dir.slice(dir.lastIndexOf('/') + 1)
  return segment || dir
}

export type SprintRunEntry = {
  statePath: string
  teamSlug: string
  state: SprintEngineState | null
  context: SprintEngineWorkspaceContext | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  // The projection's cheap change fingerprint (mtime:size). Passed back as
  // `knownToken` so an unchanged projection is not re-parsed on refresh.
  token?: string
}

interface SprintRunStore {
  runsByStatePath: Record<string, SprintRunEntry>
  // Reads a run's projection once and holds it; a no-op while a read is in
  // flight or the run is already resident, so mounting the same run twice does
  // not stack reads. The live refresh DRIVER for a running handle-only run is
  // owned by the Sprints door (a single statePath-keyed driver), not here — this
  // slice never polls.
  openRun: (statePath: string, teamSlug?: string) => Promise<void>
  refreshRun: (statePath: string) => Promise<void>
  setRunState: (statePath: string, state: SprintEngineState) => void
  closeRun: (statePath: string) => void
}

export const useSprintRunStore = create<SprintRunStore>()((set, get) => ({
  runsByStatePath: {},
  openRun: async (statePath, teamSlug) => {
    if (!statePath) return
    const key = normalizeStatePathKey(statePath)
    const existing = get().runsByStatePath[key]
    if (existing && (existing.status === 'loading' || existing.status === 'ready')) return
    const slug = teamSlug ?? existing?.teamSlug ?? teamSlugFromStatePath(statePath)
    set((state) => ({
      runsByStatePath: {
        ...state.runsByStatePath,
        [key]: {
          statePath,
          teamSlug: slug,
          state: existing?.state ?? null,
          context: existing?.context ?? null,
          status: 'loading',
          error: null,
          token: existing?.token,
        },
      },
    }))
    await get().refreshRun(statePath)
  },
  refreshRun: async (statePath) => {
    if (!statePath) return
    const key = normalizeStatePathKey(statePath)
    const prev = get().runsByStatePath[key]
    const slug = prev?.teamSlug ?? teamSlugFromStatePath(statePath)
    const patch = (entry: Partial<SprintRunEntry>): void =>
      set((state) => {
        const base = state.runsByStatePath[key] ?? {
          statePath,
          teamSlug: slug,
          state: null,
          context: null,
          status: 'idle',
          error: null,
        }
        return { runsByStatePath: { ...state.runsByStatePath, [key]: { ...base, ...entry } } }
      })

    const result = await window.api.readSprintEngineProjection(statePath, prev?.token)
    if (!result.ok) {
      // Missing/corrupt projection surfaces as an error entry WITH a reason,
      // never a thrown read or a silently dropped run (fallback discipline).
      patch({ status: 'error', error: result.message })
      return
    }
    if (result.unchanged) {
      patch({ status: 'ready' })
      return
    }
    const state = normalizeSprintEngineProjection(result.data, slug)
    if (!state) {
      patch({ status: 'error', error: 'Sprint projection is malformed.' })
      return
    }
    const context: SprintEngineWorkspaceContext = {
      teamName: state.name.trim() || slug,
      teamSlug: slug,
      teamDirectoryPath: runDirectoryOf(statePath),
      statePath,
    }
    patch({ state, context, status: 'ready', error: null, token: result.token })
  },
  setRunState: (statePath, state) =>
    set((store) => {
      const key = normalizeStatePathKey(statePath)
      const prev = store.runsByStatePath[key]
      if (!prev) return store
      return {
        runsByStatePath: {
          ...store.runsByStatePath,
          [key]: { ...prev, state, status: 'ready', error: null },
        },
      }
    }),
  closeRun: (statePath) =>
    set((store) => {
      const key = normalizeStatePathKey(statePath)
      if (!store.runsByStatePath[key]) return store
      const next = { ...store.runsByStatePath }
      delete next[key]
      return { runsByStatePath: next }
    }),
}))

// Build a handle FROM a resident workspace — today's board mount, unchanged.
// Returns null when the workspace carries no sprint state so the caller can
// render its own "data is missing" fallback.
export function sprintRunHandleFromWorkspace(
  workspace: {
    id: string
    sprintEngineContext?: SprintEngineWorkspaceContext | null
    sprintEngineState?: SprintEngineState | null
  },
  applyState: (workspaceId: string, state: SprintEngineState | null) => void,
): SprintRunHandle | null {
  const state = workspace.sprintEngineState
  if (!state) return null
  const context = workspace.sprintEngineContext ?? null
  return {
    statePath: context?.statePath ?? '',
    sprintEngineContext: context,
    sprintEngineState: state,
    setSprintEngineState: (next) => applyState(workspace.id, next),
    workspaceId: workspace.id,
  }
}

// Read a run-store entry (state, status, error) for a statePath. The Sprints
// door reads this to render loading/error/degraded states around the board.
export function useSprintRunEntry(statePath: string | null | undefined): SprintRunEntry | null {
  return useSprintRunStore((store) =>
    statePath ? store.runsByStatePath[normalizeStatePathKey(statePath)] ?? null : null,
  )
}

// Build a handle FROM a bare statePath with no resident workspace — the Sprints
// door mount. Opens the run on first use and returns null until the projection
// has been read, so the caller renders a loading/error state from
// `useSprintRunEntry` in the meantime.
export function useSprintRunHandleFromStatePath(
  statePath: string | null | undefined,
  teamSlug?: string,
): SprintRunHandle | null {
  const openRun = useSprintRunStore((store) => store.openRun)
  const refreshRun = useSprintRunStore((store) => store.refreshRun)
  const setRunState = useSprintRunStore((store) => store.setRunState)
  const entry = useSprintRunEntry(statePath)

  useEffect(() => {
    if (statePath) void openRun(statePath, teamSlug)
  }, [statePath, teamSlug, openRun])

  return useMemo(() => {
    if (!statePath || !entry?.state) return null
    const resolvedStatePath = entry.statePath
    return {
      statePath: resolvedStatePath,
      sprintEngineContext: entry.context,
      sprintEngineState: entry.state,
      setSprintEngineState: (next) => setRunState(resolvedStatePath, next),
      refresh: () => refreshRun(resolvedStatePath),
      workspaceId: undefined,
    }
  }, [statePath, entry, setRunState, refreshRun])
}
