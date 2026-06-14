import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  refreshSprintEngineWorkspaceProjection,
} from '../../utils/sprintengineProjectionRefresh'

// Paired with the auto-run cadence: the active projection read does a
// main-process JSON.parse plus a renderer-side JSON.stringify of the full
// projection (large on a busy run) every tick. 4s halves that recurring cost;
// a background runner does not need its board reflected within 2s.
const SPRINT_ENGINE_PROJECTION_ACTIVE_POLL_MS = 4000
const SPRINT_ENGINE_PROJECTION_INACTIVE_POLL_MS = 15000

type Props = {
  activeWorkspaceId: string | null
  workspaceIds: string[]
}

export default function SprintEngineProjectionSupervisor({ activeWorkspaceId, workspaceIds }: Props) {
  const signaturesByWorkspace = useRef(new Map<string, string>())
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
        signaturesByWorkspace.current.forEach((_, workspaceId) => {
          if (!refreshWorkspaceIds.has(workspaceId)) signaturesByWorkspace.current.delete(workspaceId)
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
            signatures: signaturesByWorkspace.current,
            cause: 'supervisor',
          })
        }
      } finally {
        tickInProgress.current = false
      }
    }

    void tick()
    const interval = window.setInterval(() => {
      void tick()
    }, SPRINT_ENGINE_PROJECTION_ACTIVE_POLL_MS)

    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [activeWorkspaceId, workspaceKey])

  return null
}
