import { useEffect, useMemo, useRef } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { Workspace } from '../../types/workspace'
import {
  canStopPollingCompletedSprintEngineProjection,
  refreshSprintEngineWorkspaceProjection,
} from '../../utils/sprintengineProjectionRefresh'
import { registerTimer, type TimerHandle } from '../../utils/diagnostics/timerRegistry'
import { sprintEngineRunContext } from '../../store/slices/workspaceModuleState'

function isSprintEngineSyncDisabled(): boolean {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  return env?.VITE_SPRINTENGINE_SAFE_MODE === '1' || env?.VITE_SPRINTENGINE_DISABLE_SYNC === '1'
}


// Paired with the auto-run cadence. The reader now short-circuits via a cheap
// mtime:size token, so an unchanged projection costs a single stat() with no
// read/parse/IPC payload; only changed projections pay the full read+normalize.
// 4s active / 15s inactive keeps the board fresh without busy work on idle runs.
const SPRINT_ENGINE_PROJECTION_ACTIVE_POLL_MS = 4000
const SPRINT_ENGINE_PROJECTION_INACTIVE_POLL_MS = 15000

const PROJECTION_POLL_TIMER_LABEL = 'SprintEngine projection poll'
const FALLBACK_WINDOW_ID = 'primary'

function workspaceWindowIdFromLocation(): string {
  try {
    const value = new URL(window.location.href).searchParams.get('windowId')?.trim()
    return value || FALLBACK_WINDOW_ID
  } catch {
    return FALLBACK_WINDOW_ID
  }
}

function windowWorkspaceIds(
  workspaceWindows: { id: string; workspaceIds: string[] }[],
  primaryWorkspaceWindowId: string,
  windowId: string,
): string[] | null {
  const current = workspaceWindows.find((entry) => entry.id === windowId)
    ?? workspaceWindows.find((entry) => entry.id === primaryWorkspaceWindowId)
  return current?.workspaceIds ?? null
}

function windowActiveWorkspaceId(
  workspaceWindows: { id: string; activeWorkspaceId: string | null }[],
  primaryWorkspaceWindowId: string,
  windowId: string,
): string | null {
  const current = workspaceWindows.find((entry) => entry.id === windowId)
    ?? workspaceWindows.find((entry) => entry.id === primaryWorkspaceWindowId)
  return current?.activeWorkspaceId ?? null
}

// Whether any sprint workspace in this window still needs the projection poll.
// A finished run drops out once it is skippable (dormant + hydrated + torn down,
// per `canStopPollingCompletedSprintEngineProjection`). When this returns false
// for every sprint workspace, the poll interval can be torn down entirely; it is
// re-derived on every store transition, so a new/resumed run — or a cold-restart
// dormant run that has not been hydrated yet — flips it back to true and re-arms.
export function sprintEngineWorkspacesNeedProjectionPolling(
  workspaces: readonly Workspace[],
  workspaceIds: ReadonlySet<string>,
): boolean {
  return workspaces.some(
    (workspace) =>
      workspaceIds.has(workspace.id)
      && (workspace.mode === 'sprintengine' || Boolean(sprintEngineRunContext(workspace)))
      && !canStopPollingCompletedSprintEngineProjection(workspace),
  )
}

export type ProjectionPollLoop = {
  // Arm the interval when polling is needed, tear it down (including the timer
  // registration) when not. Idempotent: repeat calls with the same need no-op.
  sync(needsPolling: boolean): void
  dispose(): void
}

// Owns the setInterval + timer-registry lifecycle so the interval exists ONLY
// while polling is needed. Arming fires one tick immediately (to hydrate a
// cold-restart board) before the interval starts; disarming unregisters the
// timer so it disappears from `getTimerRegistrations()` — the verifiable
// quiescence signal. setInterval/clearInterval are injectable for tests.
export function createProjectionPollLoop(deps: {
  cadenceMs: number
  runTick: () => void | Promise<void>
  setInterval?: (handler: () => void, ms: number) => number
  clearInterval?: (id: number) => void
}): ProjectionPollLoop {
  const setIntervalImpl = deps.setInterval ?? ((handler, ms) => window.setInterval(handler, ms))
  const clearIntervalImpl = deps.clearInterval ?? ((id) => window.clearInterval(id))
  let interval: number | null = null
  let timer: TimerHandle | null = null

  const arm = (): void => {
    if (interval !== null) return
    timer = registerTimer(PROJECTION_POLL_TIMER_LABEL, deps.cadenceMs)
    const fire = (): void => {
      const startedAt = performance.now()
      void Promise.resolve(deps.runTick()).finally(() => timer?.recordTick(performance.now() - startedAt))
    }
    fire()
    interval = setIntervalImpl(fire, deps.cadenceMs)
  }

  const disarm = (): void => {
    if (timer) {
      timer.unregister()
      timer = null
    }
    if (interval !== null) {
      clearIntervalImpl(interval)
      interval = null
    }
  }

  return {
    sync: (needsPolling) => (needsPolling ? arm() : disarm()),
    dispose: disarm,
  }
}

export default function SprintEngineProjectionSupervisor() {
  const tokensByWorkspace = useRef(new Map<string, string>())
  const lastInactiveRefreshByWorkspace = useRef(new Map<string, number>())
  // Workspaces whose refresh failed permanently (run directory gone, or a store
  // this build cannot read), keyed by workspace id to the statePath that failed.
  // Re-polling cannot heal these, so the tick skips them for as long as the
  // statePath is unchanged; a repointed context — or an app restart — retries.
  const permanentFailureStatePaths = useRef(new Map<string, string>())
  const tickInProgress = useRef(false)
  const windowId = useMemo(() => workspaceWindowIdFromLocation(), [])
  const assignedIds = useWorkspaceStore((s) =>
    windowWorkspaceIds(s.workspaceWindows, s.primaryWorkspaceWindowId, windowId),
  )
  const windowActiveId = useWorkspaceStore((s) =>
    windowActiveWorkspaceId(s.workspaceWindows, s.primaryWorkspaceWindowId, windowId),
  )
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const workspaceIds = assignedIds ?? workspaces.map((workspace) => workspace.id)
  const activeWorkspaceId = windowActiveId && workspaceIds.includes(windowActiveId)
    ? windowActiveId
    : null
  const workspaceKey = workspaceIds.join('\n')

  useEffect(() => {
    if (isSprintEngineSyncDisabled()) return
    let disposed = false

    const tick = async () => {
      if (tickInProgress.current) return
      tickInProgress.current = true

      try {
        const refreshWorkspaceIds = new Set(workspaceIds)
        tokensByWorkspace.current.forEach((_, workspaceId) => {
          if (!refreshWorkspaceIds.has(workspaceId)) tokensByWorkspace.current.delete(workspaceId)
        })
        lastInactiveRefreshByWorkspace.current.forEach((_, workspaceId) => {
          if (!refreshWorkspaceIds.has(workspaceId)) lastInactiveRefreshByWorkspace.current.delete(workspaceId)
        })
        permanentFailureStatePaths.current.forEach((_, workspaceId) => {
          if (!refreshWorkspaceIds.has(workspaceId)) permanentFailureStatePaths.current.delete(workspaceId)
        })

        const now = Date.now()
        const { workspaces: liveWorkspaces } = useWorkspaceStore.getState()
        const sprintEngineWorkspaces = liveWorkspaces.filter((workspace) =>
          refreshWorkspaceIds.has(workspace.id)
          && (workspace.mode === 'sprintengine' || Boolean(sprintEngineRunContext(workspace)))
        )

        for (const workspace of sprintEngineWorkspaces) {
          if (disposed) return
          // A finished run is terminal — once its board/summary data is loaded,
          // stop polling it entirely (see the predicate for the two guards that
          // keep a cold or still-healing run polling until it is ready to skip).
          if (canStopPollingCompletedSprintEngineProjection(workspace)) {
            tokensByWorkspace.current.delete(workspace.id)
            lastInactiveRefreshByWorkspace.current.delete(workspace.id)
            continue
          }
          // A permanently failed workspace (run directory gone, unreadable
          // store) never recovers by re-polling: skip it while its statePath is
          // unchanged. Without this, every stale workspace re-fails on every
          // tick forever.
          const statePath = sprintEngineRunContext(workspace)?.statePath ?? null
          if (statePath && permanentFailureStatePaths.current.get(workspace.id) === statePath) continue
          if (workspace.id !== activeWorkspaceId) {
            const lastRefresh = lastInactiveRefreshByWorkspace.current.get(workspace.id) ?? 0
            if (now - lastRefresh < SPRINT_ENGINE_PROJECTION_INACTIVE_POLL_MS) continue
            lastInactiveRefreshByWorkspace.current.set(workspace.id, now)
          }

          const result = await refreshSprintEngineWorkspaceProjection({
            workspace,
            tokens: tokensByWorkspace.current,
            cause: 'supervisor',
          })
          if (result.status === 'error' && result.permanent && statePath) {
            permanentFailureStatePaths.current.set(workspace.id, statePath)
          } else if (result.status !== 'error') {
            permanentFailureStatePaths.current.delete(workspace.id)
          }
        }
      } finally {
        tickInProgress.current = false
      }
    }

    // The interval lives only while at least one sprint workspace is not
    // skippable. Re-derive that need on every store transition so a dormancy /
    // hydration change that does not alter the workspace id list still tears the
    // interval down or re-arms it — no app restart, no fixed delay.
    const loop = createProjectionPollLoop({
      cadenceMs: SPRINT_ENGINE_PROJECTION_ACTIVE_POLL_MS,
      runTick: tick,
    })
    const workspaceIdSet = new Set(workspaceIds)
    const evaluate = (): void => {
      if (disposed) return
      loop.sync(
        sprintEngineWorkspacesNeedProjectionPolling(useWorkspaceStore.getState().workspaces, workspaceIdSet),
      )
    }

    evaluate()
    const unsubscribe = useWorkspaceStore.subscribe(evaluate)

    return () => {
      disposed = true
      unsubscribe()
      loop.dispose()
    }
  }, [activeWorkspaceId, workspaceKey])

  return null
}
