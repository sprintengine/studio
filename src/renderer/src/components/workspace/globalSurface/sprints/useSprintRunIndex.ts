import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { listAutomationProjectFolders } from '../../../../utils/automationsEntry'
import {
  getSprintRunIndexSnapshot,
  refreshSprintRunIndex,
  setSprintRunIndexRoots,
  subscribeSprintRunIndex,
  type SprintRunIndexLoadState,
  type SprintRunIndexSnapshot,
} from './sprintRunIndexStore'

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
//
// The fetching itself lives in `sprintRunIndexStore`: one subscription and one
// coalesced scan for the whole window, however many components read the index.
// This hook is the React view of that store — see the store's header for why
// per-consumer fetching was worth removing.

export type { SprintRunIndexLoadState }

export type SprintRunIndex = {
  runs: SprintRunSummary[]
  loadState: SprintRunIndexLoadState
  /** Raw failure text, shown only behind the error card's "Show details". */
  error: string | null
  reload: () => void
}

// What a consumer reports before its own read has landed. Stable by identity so
// it never itself causes a re-render.
const PENDING: SprintRunIndexSnapshot = { runs: [], loadState: 'loading', error: null }

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

  const stored = useSyncExternalStore(
    subscribeSprintRunIndex,
    getSprintRunIndexSnapshot,
    getSprintRunIndexSnapshot,
  )

  // The store outlives any single mount, so a consumer can mount onto rows that
  // were read for an earlier one. Those rows are shared DATA, but they are not
  // this consumer's READ: reporting them as `ready` tells the surface a decision
  // is safe to make when it is not. `SprintsGlobalSurface` opens on `rows[0]` the
  // moment it sees `ready`, so a door opened from a Backlog "Open Sprint" link
  // would resolve the handed-over path against the previous mount's rows, miss,
  // and select the wrong run — item 1803's bug, reintroduced by warm state.
  //
  // So each consumer reports `loading` until a publish lands after IT mounted.
  // Mounting always requests a read and every read publishes, so this always
  // resolves — and it is exactly what a per-consumer fetch used to give. The
  // sharing that matters (one subscription, one coalesced scan per burst) is
  // unaffected; only the first frame differs.
  const mountSnapshot = useRef<SprintRunIndexSnapshot | null>(null)
  if (mountSnapshot.current === null) mountSnapshot.current = stored
  const snapshot = stored === mountSnapshot.current ? PENDING : stored

  useEffect(() => {
    // Point the shared index at this window's roots (a no-op when unchanged),
    // then read: the index is re-read on mount so a run created moments ago is
    // already listed by the time the rows resolve. Neither call waits out the
    // coalescing window — that is for bursts — and both collapse against an
    // in-flight scan, so mounting the sidebar entry and the surface together
    // still costs one scan.
    setSprintRunIndexRoots(rootsKey)
    refreshSprintRunIndex()
  }, [rootsKey])

  return {
    runs: snapshot.runs,
    loadState: snapshot.loadState,
    error: snapshot.error,
    // The explicit retry reads now — see the store.
    reload: refreshSprintRunIndex,
  }
}
