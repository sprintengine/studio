import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  refreshSprintEngineWorkspaceProjection,
} from '../../utils/sprintengineProjectionRefresh'
import { registerTimer } from '../../utils/diagnostics/timerRegistry'

// Paired with the auto-run cadence. The reader now short-circuits via a cheap
// mtime:size token, so an unchanged projection costs a single stat() with no
// read/parse/IPC payload; only changed projections pay the full read+normalize.
// 4s active / 15s inactive keeps the board fresh without busy work on idle runs.
const SPRINT_ENGINE_PROJECTION_ACTIVE_POLL_MS = 4000
const SPRINT_ENGINE_PROJECTION_INACTIVE_POLL_MS = 15000

type Props = {
  activeWorkspaceId: string | null
  workspaceIds: string[]
}

export default function SprintEngineProjectionSupervisor({ activeWorkspaceId, workspaceIds }: Props) {
  const tokensByWorkspace = useRef(new Map<string, string>())
  const lastInactiveRefreshByWorkspace = useRef(new Map<string, number>())
  const tickInProgress = useRef(false)
  const workspaceKey = workspaceIds.join('\n')

  useEffect(() => {
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

        const now = Date.now()
        const { workspaces } = useWorkspaceStore.getState()
        const sprintEngineWorkspaces = workspaces.filter((workspace) =>
          refreshWorkspaceIds.has(workspace.id)
          && (workspace.mode === 'sprintengine' || Boolean(workspace.sprintEngineContext))
        )

        for (const workspace of sprintEngineWorkspaces) {
          if (disposed) return
          if (workspace.id !== activeWorkspaceId) {
            const lastRefresh = lastInactiveRefreshByWorkspace.current.get(workspace.id) ?? 0
            if (now - lastRefresh < SPRINT_ENGINE_PROJECTION_INACTIVE_POLL_MS) continue
            lastInactiveRefreshByWorkspace.current.set(workspace.id, now)
          }

          await refreshSprintEngineWorkspaceProjection({
            workspace,
            tokens: tokensByWorkspace.current,
            cause: 'supervisor',
          })
        }
      } finally {
        tickInProgress.current = false
      }
    }

    const timer = registerTimer('SprintEngine projection poll', SPRINT_ENGINE_PROJECTION_ACTIVE_POLL_MS)
    const runTick = () => {
      const startedAt = performance.now()
      void Promise.resolve(tick()).finally(() => timer.recordTick(performance.now() - startedAt))
    }
    runTick()
    const interval = window.setInterval(runTick, SPRINT_ENGINE_PROJECTION_ACTIVE_POLL_MS)

    return () => {
      disposed = true
      timer.unregister()
      window.clearInterval(interval)
    }
  }, [activeWorkspaceId, workspaceKey])

  return null
}
