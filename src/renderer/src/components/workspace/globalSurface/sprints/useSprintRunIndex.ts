import { useCallback, useEffect, useMemo, useState } from 'react'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { listAutomationProjectFolders } from '../../../../utils/automationsEntry'
import { dropDeletedSprintRunDebris } from './sprintRunTombstones'

// The Sprints door's data source (item 1763): every run across every known
// project, from the run index (T1). Shared by the surface (its rail and canvas)
// and the sidebar door (its aggregate dot), so the door's signal stays live while
// the surface is closed and the two never disagree about what is running.
//
// Runs are discovered by scanning each known project root's
// `.multi-code/sprintengine/` tree, so a run whose sprint workspace was closed
// long ago still lists — the index reads disk, not the workspace rail. Main
// pushes a change event per run projection write — from its own runtime ops, and
// from the run index's per-run directory watch for the writes the Python engine
// makes on its own (MC-1801) — so this refetches on the event rather than
// polling.

export type SprintRunIndexLoadState = 'loading' | 'ready' | 'error'

export type SprintRunIndex = {
  runs: SprintRunSummary[]
  loadState: SprintRunIndexLoadState
  /** Raw failure text, shown only behind the error card's "Show details". */
  error: string | null
  reload: () => void
}

export function useSprintRunIndex(): SprintRunIndex {
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  // The project roots collapse to one scalar so the fetch identity changes only
  // when the set of folders actually changes — not on every unrelated workspace
  // store write (a rename, a terminal stamp, an active-workspace switch). Encoded
  // rather than delimiter-joined, so no character is illegal in a folder name.
  const rootsKey = useMemo(
    () => JSON.stringify(listAutomationProjectFolders(workspaces).map((folder) => folder.folderPath)),
    [workspaces],
  )
  const roots = useMemo(() => JSON.parse(rootsKey) as string[], [rootsKey])

  const [runs, setRuns] = useState<SprintRunSummary[]>([])
  const [loadState, setLoadState] = useState<SprintRunIndexLoadState>('loading')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const listed = await window.api.listSprintRuns(roots)
      // A run the operator deleted can be recreated on disk by a writer that
      // outlived it; that folder is debris, not a run (item 1812).
      setRuns(dropDeletedSprintRunDebris(listed))
      setError(null)
      setLoadState('ready')
    } catch (cause) {
      // An unreadable index is an error state with a retry, never an empty rail
      // pretending there are no sprints.
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoadState('error')
    }
  }, [roots])

  useEffect(() => {
    void load()
  }, [load])

  // Refetch when any run's projection changes. A refresh never returns the
  // surface to `loading` — populated content must not blink back to a spinner.
  useEffect(() => window.api.onSprintRunsChanged(() => void load()), [load])

  const reload = useCallback(() => void load(), [load])
  return { runs, loadState, error, reload }
}
