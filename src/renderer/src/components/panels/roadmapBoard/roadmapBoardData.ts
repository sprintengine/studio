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
import { useShallow } from 'zustand/react/shallow'

import { flattenLaneUnits, isRoadmapContent, parseRoadmap, type ProjectKey, type Roadmap } from '../../../../../shared/backlog/roadmap'
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
import { subscribeBacklogScan } from '../../../hooks/useSharedBacklogScan'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { basename, joinFilePath } from '../../../utils/paths'
import { normalizeProjectRootKey } from '../../../utils/projectKnowledge'
import { normalizeRelativePath, type BacklogItem, type BacklogItemStatus } from '../../../utils/backlog'

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

// One roadmap file as the rail lists it (T2): its stable ref + display title,
// the scan-minted backlog id (drafts sort by it), and a lite plan preview (track
// titles + step counts) parsed from the scan's own `sourceContent` — no second
// read. Powers the rail rows and the read-only draft canvas.
export type RoadmapFileSummary = {
  roadmapRef: string
  title: string
  numericId?: number
  // The file's backlog status. Activation (T2) demotes every OTHER active-status
  // roadmap to keep exactly one Active, so the rail carries status per file.
  status: BacklogItemStatus
  tracks: { title: string; steps: number }[]
  totalSteps: number
}

// The backlog statuses under which the orchestrator treats a roadmap as active
// (mirrors roadmap-orchestrator's ACTIVE_ROADMAP_STATUSES). A file outside this
// set is a draft; "Make active" promotes one into it and demotes the rest.
export const ACTIVE_ROADMAP_STATUSES: ReadonlySet<BacklogItemStatus> = new Set<BacklogItemStatus>([
  'ready',
  'in_progress',
  'needs_input',
])

export type RoadmapBoardData = {
  roadmaps: LoadedRoadmap[]
  /** Every roadmap file in the home project (active + drafts), for the rail (T2). */
  roadmapFiles: RoadmapFileSummary[]
  /** The single orchestrated roadmap's ref (readRoadmapStates' one entry), or null. */
  activeRef: string | null
  /** True only until the first read resolves (states === null). A background
   *  refresh never re-enters loading, so populated content never blinks back to a
   *  spinner on the quiet cadence. */
  loading: boolean
  /** A background re-read is in flight while content is already on screen — drives
   *  a quiet header pulse, never a content blink. */
  refreshing: boolean
  error: string | null
  /** The home project holding the instance roadmap (D1), or null when unset. The
   *  surface builds absolute paths (skip edits, file reads) against it. */
  homePath: string | null
  /** Re-read orchestrator state + roadmap files from disk. */
  reload: () => void
}

// The board refreshes on mount, when a backlog scan changes, after any command,
// and on this quiet cadence while the surface is open — no background supervisor, so
// it stops the moment the surface unmounts.
const ROADMAP_BOARD_REFRESH_MS = 12_000

// The roadmap is instance-global (MC-1689): one plan per Multicode, held in a HOME
// project (D1). The board derives that home project itself (no per-workspace
// `folderPath` scoping) and resolves each step against the project it lives in — the
// home project plus every `projects:` alias that maps to a known workspace root — so
// a cross-project step shows its real title, status, and project tag (mockup §2).
export function useRoadmapBoard(): RoadmapBoardData {
  const [homePath, setHomePath] = useState<string | null>(null)
  const [states, setStates] = useState<RoadmapStateView[] | null>(null)
  const [contentByRef, setContentByRef] = useState<Map<string, string>>(new Map())
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  // The project roots the instance knows, for alias resolvability (D2): an alias
  // whose path is not a known root parks its lane `unknown_project`, never a silent
  // drop. Selected shallow so a workspace-list churn that doesn't change the roots
  // never re-subscribes the scans.
  const knownRootKeys = useWorkspaceStore(
    useShallow((s) => {
      const keys = new Set<string>()
      for (const workspace of s.workspaces) {
        if (workspace.folderPath) keys.add(rootKey(workspace.folderPath))
      }
      return keys
    }),
  )

  useEffect(() => {
    let cancelled = false
    setRefreshing(true)
    const load = async () => {
      try {
        const home = (await window.api.getRoadmapHomeProject()).path
        if (cancelled) return
        setHomePath(home)
        const result = await window.api.readRoadmapStates()
        if (cancelled) return
        if (!result.ok) {
          setError(result.message)
          setStates([])
          setContentByRef(new Map())
          return
        }
        setError(null)
        setStates(result.roadmaps)
        // Read each roadmap file so the board can show its lane entries (the state
        // view carries only runtime, not the plan). The file lives in the home
        // project; a missing/unreadable file is dropped from the map — its roadmap
        // renders with no lanes rather than failing the whole board.
        const contents = new Map<string, string>()
        if (home) {
          await Promise.all(
            result.roadmaps.map(async (view) => {
              try {
                const content = await window.api.readfile(joinFilePath(home, view.roadmapRef))
                if (!cancelled) contents.set(view.roadmapRef, content)
              } catch {
                /* file unreadable — omit; roadmap shows as empty */
              }
            }),
          )
        }
        if (!cancelled) setContentByRef(contents)
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
          setStates([])
        }
      } finally {
        if (!cancelled) setRefreshing(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [nonce])

  // Quiet foreground refresh; cleared on unmount.
  useEffect(() => {
    const timer = setInterval(reload, ROADMAP_BOARD_REFRESH_MS)
    return () => clearInterval(timer)
  }, [reload])

  const parsedRoadmaps = useMemo(
    () =>
      (states ?? []).map((view) => ({
        view,
        roadmap: parseRoadmapContent(contentByRef.get(view.roadmapRef)),
      })),
    [states, contentByRef],
  )

  // Every project root the plan spans that the instance can resolve: the home
  // project plus each alias mapping to a known workspace root.
  const scanRoots = useMemo(() => {
    const roots: string[] = []
    if (homePath) roots.push(homePath)
    for (const { roadmap } of parsedRoadmaps) {
      for (const project of roadmap.projects) {
        if (knownRootKeys.has(rootKey(project.path))) roots.push(project.path)
      }
    }
    return Array.from(new Set(roots))
  }, [homePath, parsedRoadmaps, knownRootKeys])

  const itemsByRootKey = useMultiRootBacklogScan(scanRoots)

  const roadmaps = useMemo<LoadedRoadmap[]>(() => {
    return parsedRoadmaps.map(({ view, roadmap }) => {
      const resolver = buildInstanceResolver(roadmap, homePath, itemsByRootKey, knownRootKeys)
      const laneRuntime = new Map<string, RoadmapLaneStateView>(view.lanes.map((lane) => [lane.lane, lane]))
      const lanes = buildRoadmapBoardModel(roadmap, resolver, laneRuntime)
      return {
        roadmapRef: view.roadmapRef,
        title: view.title ?? roadmapTitleFromRef(view.roadmapRef),
        path: view.roadmapRef,
        roadmap,
        lanes,
        stateView: view,
      }
    })
  }, [parsedRoadmaps, homePath, itemsByRootKey, knownRootKeys])

  // The single orchestrated roadmap (readRoadmapStates returns exactly the active
  // one, or nothing). Its ref is the rail's "Active" identity.
  const activeRef = useMemo(() => roadmaps[0]?.roadmapRef ?? null, [roadmaps])

  // Every roadmap file in the home project (active + drafts), for the rail. Read
  // off the shared home-project scan — the home root is always a scanRoot, so its
  // items (with `sourceContent`) are already loaded; no extra IPC. The active
  // roadmap is unioned in defensively so it is always a rail citizen even on the
  // first tick before the scan has caught up with readRoadmapStates.
  const roadmapFiles = useMemo<RoadmapFileSummary[]>(() => {
    const homeItems = homePath ? (itemsByRootKey.get(rootKey(homePath)) ?? []) : []
    const summaries = homeItems
      // Archived roadmaps are retired, not activatable drafts — keep them out of
      // the rail so a stale file never clutters it as a misleading "Draft" row.
      .filter((item) => isRoadmapContent(item.relativePath, item.rawType) && item.status !== 'archived')
      .map(summarizeRoadmapFile)
    if (activeRef && !summaries.some((summary) => summary.roadmapRef === normalizeRelativePath(activeRef))) {
      summaries.push({
        roadmapRef: normalizeRelativePath(activeRef),
        title: roadmaps[0]?.title ?? roadmapTitleFromRef(activeRef),
        status: 'in_progress',
        tracks: [],
        totalSteps: 0,
      })
    }
    return summaries
  }, [homePath, itemsByRootKey, activeRef, roadmaps])

  // Loading is the first-read-only state; once states resolves (to a list or, on
  // failure, []), the board stays populated and later reads are `refreshing`.
  const loading = states === null

  return { roadmaps, roadmapFiles, activeRef, loading, refreshing, error, homePath, reload }
}

// A lane needs the human when it awaits an approval or has parked; a lane is live
// when its runtime carries a running sprint. The sidebar door reads this signal
// always-on (surface closed too), so it stays a cheap state-only poll — no roadmap
// file reads, no backlog scans.
export type RoadmapAttention = { running: boolean; waiting: boolean }

// How often the always-on nav signal re-reads orchestrator state. Quieter than the
// open board's cadence — it drives a dot, not a live surface.
const ROADMAP_ATTENTION_POLL_MS = 20_000

export function useRoadmapAttention(enabled: boolean): RoadmapAttention {
  const [attention, setAttention] = useState<RoadmapAttention>({ running: false, waiting: false })
  useEffect(() => {
    if (!enabled) {
      setAttention({ running: false, waiting: false })
      return
    }
    let cancelled = false
    const poll = async () => {
      try {
        const result = await window.api.readRoadmapStates()
        if (cancelled || !result.ok) return
        let running = false
        let waiting = false
        for (const view of result.roadmaps) {
          for (const lane of view.lanes) {
            if (lane.activeStatePath || lane.activeItemRef) running = true
            if (lane.pendingApprovalRef || lane.parked) waiting = true
          }
        }
        if (!cancelled) setAttention({ running, waiting })
      } catch {
        /* transient read failure — keep the last known signal */
      }
    }
    void poll()
    const timer = setInterval(poll, ROADMAP_ATTENTION_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled])
  return attention
}

const EMPTY_ROADMAP: Roadmap = {
  policy: { advance: 'approve', merge: 'manual', concurrency: 1 },
  projects: [],
  body: '',
  lanes: [],
  issues: [],
}

function parseRoadmapContent(content: string | undefined): Roadmap {
  return content ? parseRoadmap(content) : EMPTY_ROADMAP
}

function roadmapTitleFromRef(ref: string): string {
  const stem = ref.split('/').filter(Boolean).at(-1) ?? ref
  return stem.replace(/\.md$/i, '')
}

// A rail summary for one roadmap file, parsed from the scan's own sourceContent —
// track titles + step counts + a total. Cheap enough to run per file; the shared
// scan already holds the content, so this adds no read.
function summarizeRoadmapFile(item: BacklogItem): RoadmapFileSummary {
  const parsed = parseRoadmap(item.sourceContent)
  const tracks = parsed.lanes.map((lane) => ({ title: lane.title, steps: flattenLaneUnits(lane).length }))
  return {
    roadmapRef: normalizeRelativePath(item.relativePath),
    title: item.title,
    ...(item.numericId !== undefined ? { numericId: item.numericId } : {}),
    status: item.status,
    tracks,
    totalSteps: tracks.reduce((sum, track) => sum + track.steps, 0),
  }
}

// The normalized project-root key backlog scans are shared under (mirrors
// useSharedBacklogScan.subscriptionKey), so a roadmap's alias path and a known
// workspace root compare on the same footing.
function rootKey(path: string): string {
  return normalizeProjectRootKey(path)?.toLowerCase() ?? path
}

// Subscribe to the shared backlog scan for every project root the roadmap spans,
// aggregating each root's items keyed by its normalized root key. Reuses the shared
// subscription, so a project with an open BacklogPanel is not scanned twice.
function useMultiRootBacklogScan(rootPaths: ReadonlyArray<string>): Map<string, BacklogItem[]> {
  const [itemsByKey, setItemsByKey] = useState<Map<string, BacklogItem[]>>(new Map())
  const depKey = useMemo(() => Array.from(new Set(rootPaths)).sort().join('|'), [rootPaths])
  const rootsRef = useRef<ReadonlyArray<string>>(rootPaths)
  rootsRef.current = rootPaths

  useEffect(() => {
    const roots = Array.from(new Set(rootsRef.current))
    if (roots.length === 0) {
      setItemsByKey(new Map())
      return
    }
    const aggregate = new Map<string, BacklogItem[]>()
    const unsubscribes = roots.map((root) =>
      subscribeBacklogScan(root, ({ scan }) => {
        aggregate.set(rootKey(root), scan?.items ?? [])
        setItemsByKey(new Map(aggregate))
      }),
    )
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [depKey])

  return itemsByKey
}

// The project-aware resolver the board looks up each unit through. A unit's project
// resolves to the home project (`projectKey === null`) or a `projects:` alias; its
// live backlog facts come from that project's scan. `resolvableProjects` marks home
// plus every alias mapping to a known workspace root — an alias off that set reads
// as `unknown_project` (a re-map offer, D2), never a silent drop. `projectName`
// supplies the per-step project tag (mockup §2): the project folder's own name.
function buildInstanceResolver(
  roadmap: Roadmap,
  homePath: string | null,
  itemsByRootKey: ReadonlyMap<string, BacklogItem[]>,
  knownRootKeys: ReadonlySet<string>,
): RoadmapBoardResolver {
  const pathOf = (projectKey: ProjectKey): string | null =>
    projectKey === null ? homePath : (roadmap.projects.find((project) => project.alias === projectKey)?.path ?? null)

  const byPathCache = new Map<string, Map<string, RoadmapBoardItemInfo>>()
  const byPathFor = (projectKey: ProjectKey): Map<string, RoadmapBoardItemInfo> | null => {
    const path = pathOf(projectKey)
    if (!path) return null
    const key = rootKey(path)
    const cached = byPathCache.get(key)
    if (cached) return cached
    const items = itemsByRootKey.get(key)
    if (!items) return null
    const byPath = new Map<string, RoadmapBoardItemInfo>()
    for (const item of items) {
      const prUrl = sprintEnginePullRequestLinkOf(item.links)?.target?.url
      byPath.set(item.relativePath.toLowerCase(), {
        title: item.title,
        status: item.status,
        ...(prUrl ? { prUrl } : {}),
      })
    }
    byPathCache.set(key, byPath)
    return byPath
  }

  const resolvableProjects = new Set<ProjectKey>([null])
  for (const project of roadmap.projects) {
    if (knownRootKeys.has(rootKey(project.path))) resolvableProjects.add(project.alias)
  }

  return {
    itemInfo: (projectKey, relativePath) => byPathFor(projectKey)?.get(relativePath.toLowerCase()),
    projectName: (projectKey) => {
      const path = pathOf(projectKey)
      if (path) return basename(path)
      return projectKey ?? 'This project'
    },
    resolvableProjects,
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
