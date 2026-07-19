// Data hooks for the roadmap steering board (MC-1620 / T7). Two reads compose the
// board: the orchestrator's per-lane runtime (`readRoadmapStates`) and the roadmap
// markdown files themselves (for the lane entries the runtime view omits), joined
// against the shared backlog scan for live item status + PR links. A third read
// pulls a lane's running sprint projection on demand, for the pull-request surface.
//
// The board reconciles against disk: every refresh re-derives the model from the
// roadmap files + backlog + orchestrator sidecar, so a kill/restart renders the
// identical board. Commands (approve/pause/resume/merge/skip) write state and then
// call `reload()` — there is no imperative in-memory board state to drift.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { parseRoadmap, type Roadmap } from '../../../../../shared/backlog/roadmap'
import {
  buildRoadmapBoardModel,
  deriveRepoMergeBlockers,
  type RepoMergeBlockers,
  type RoadmapBoardItemInfo,
  type RoadmapBoardLane,
  type RoadmapBoardResolver,
  type RoadmapLaneStateView,
  type RoadmapStateView,
} from '../../../../../shared/sprintengine/roadmap-surface'
import { normalizeSprintEngineProjection } from '../../../../../shared/sprintengine/state'
import { sprintEnginePullRequestLinkOf } from '../../../../../shared/backlog/sprintengine-links'
import type { SprintEngineTask, SprintEngineVcs } from '../../../../../shared/sprintengine/run-types'
import { useSharedBacklogScan } from '../../../hooks/useSharedBacklogScan'
import { joinFilePath } from '../../../utils/paths'
import type { BacklogItem } from '../../../utils/backlog'

// One roadmap ready to render: its state view, the parsed file, and the derived
// per-lane board model.
export type LoadedRoadmap = {
  roadmapRef: string
  title: string
  path: string
  roadmap: Roadmap
  lanes: RoadmapBoardLane[]
  stateView: RoadmapStateView
}

export type RoadmapBoardData = {
  roadmaps: LoadedRoadmap[]
  loading: boolean
  error: string | null
  /** Re-read orchestrator state + roadmap files from disk. */
  reload: () => void
}

// The board refreshes on mount, when the backlog scan changes, after any command,
// and on this quiet cadence while the panel is open — no background supervisor, so
// it stops the moment the panel unmounts.
const ROADMAP_BOARD_REFRESH_MS = 12_000

export function useRoadmapBoard(folderPath: string | null): RoadmapBoardData {
  const { scan } = useSharedBacklogScan(folderPath)
  const [states, setStates] = useState<RoadmapStateView[] | null>(null)
  const [contentByRef, setContentByRef] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState<boolean>(Boolean(folderPath))
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    if (!folderPath) {
      setStates(null)
      setContentByRef(new Map())
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const result = await window.api.readRoadmapStates()
        if (cancelled) return
        if (!result.ok) {
          setError(result.message)
          setStates([])
          return
        }
        setError(null)
        setStates(result.roadmaps)
        // Read each roadmap file so the board can show its lane entries (the
        // state view carries only runtime, not the plan). A missing file is
        // dropped from the map — its roadmap renders with no lanes rather than
        // failing the whole board.
        const contents = new Map<string, string>()
        await Promise.all(
          result.roadmaps.map(async (view) => {
            try {
              const content = await window.api.readfile(joinFilePath(folderPath, view.roadmapRef))
              if (!cancelled) contents.set(view.roadmapRef, content)
            } catch {
              /* file unreadable — omit; roadmap shows as empty */
            }
          }),
        )
        if (!cancelled) setContentByRef(contents)
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
          setStates([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [folderPath, nonce])

  // Quiet foreground refresh; cleared on unmount. Gated on a resolved folder.
  useEffect(() => {
    if (!folderPath) return
    const timer = setInterval(reload, ROADMAP_BOARD_REFRESH_MS)
    return () => clearInterval(timer)
  }, [folderPath, reload])

  const itemResolver = useMemo(() => buildHomeResolver(scan?.items ?? []), [scan])

  const roadmaps = useMemo<LoadedRoadmap[]>(() => {
    if (!states) return []
    return states.map((view) => {
      const content = contentByRef.get(view.roadmapRef)
      const roadmap = content ? parseRoadmap(content) : EMPTY_ROADMAP
      const laneRuntime = new Map<string, RoadmapLaneStateView>(
        view.lanes.map((lane) => [lane.lane, lane]),
      )
      const lanes = buildRoadmapBoardModel(roadmap, itemResolver, laneRuntime)
      return {
        roadmapRef: view.roadmapRef,
        title: view.title ?? roadmapTitleFromRef(view.roadmapRef),
        path: view.roadmapRef,
        roadmap,
        lanes,
        stateView: view,
      }
    })
  }, [states, contentByRef, itemResolver])

  return { roadmaps, loading, error, reload }
}

const EMPTY_ROADMAP: Roadmap = {
  policy: { advance: 'approve', merge: 'manual', concurrency: 1 },
  projects: [],
  body: '',
  lanes: [],
  issues: [],
}

function roadmapTitleFromRef(ref: string): string {
  const stem = ref.split('/').filter(Boolean).at(-1) ?? ref
  return stem.replace(/\.md$/i, '')
}

// Backlog scan → the project-aware resolver the board looks up each unit through
// (title, live status, and the delivering PR url when the item recorded one).
// Keyed by lowercased relative path so a ref's casing never misses. This renderer
// path resolves the home project's scan only (projectKey null); cross-project item
// resolution rides the instance-global surface rebuild (MC-1689 / T2), so entries
// in another project render as unknown here until then.
function buildHomeResolver(items: ReadonlyArray<BacklogItem>): RoadmapBoardResolver {
  const byPath = new Map<string, RoadmapBoardItemInfo>()
  for (const item of items) {
    const prUrl = sprintEnginePullRequestLinkOf(item.links)?.target?.url
    byPath.set(item.relativePath.toLowerCase(), {
      title: item.title,
      status: item.status,
      ...(prUrl ? { prUrl } : {}),
    })
  }
  return {
    itemInfo: (projectKey, relativePath) => (projectKey === null ? byPath.get(relativePath.toLowerCase()) : undefined),
    projectName: (projectKey) => projectKey ?? 'This project',
    resolvableProjects: new Set([null]),
  }
}

// --- Lane run projection (the pull-request surface) ------------------------

export type LaneRunData = {
  vcs: SprintEngineVcs | null
  tasks: SprintEngineTask[]
  blockers: RepoMergeBlockers
  loading: boolean
  error: string | null
  reload: () => void
}

// Read the running sprint's projection for one lane, on demand. Refreshes the
// pull-request merge state once on open (the same read-only probe the run surface
// fires) so a PR merged on GitHub since the last projection write shows merged, then
// derives the proactive merge-order blockers from the run's own task graph.
export function useLaneRun(statePath: string | null): LaneRunData {
  const [vcs, setVcs] = useState<SprintEngineVcs | null>(null)
  const [tasks, setTasks] = useState<SprintEngineTask[]>([])
  const [loading, setLoading] = useState<boolean>(Boolean(statePath))
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const probedRef = useRef<string | null>(null)
  const reload = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    if (!statePath) {
      setVcs(null)
      setTasks([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        // One-shot PR-status probe per run, so merge state is fresh on open.
        if (probedRef.current !== statePath) {
          probedRef.current = statePath
          await window.api.refreshSprintEnginePullRequestStatus(statePath).catch(() => undefined)
        }
        const result = await window.api.readSprintEngineProjection(statePath)
        if (cancelled) return
        if (!result.ok) {
          setError(result.message)
          return
        }
        const state = normalizeSprintEngineProjection(result.data)
        if (cancelled) return
        setError(null)
        setVcs(state?.vcs ?? null)
        setTasks(state?.tasks ?? [])
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [statePath, nonce])

  const blockers = useMemo(
    () => deriveRepoMergeBlockers(tasks, vcs?.repos ?? []),
    [tasks, vcs],
  )

  return { vcs, tasks, blockers, loading, error, reload }
}
