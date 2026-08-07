import { useEffect, useRef } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import type { Workspace } from '../../types/workspace'
import {
  canStopPollingCompletedSprintEngineProjection,
  refreshSprintEngineWorkspaceProjection,
} from '../../utils/sprintengineProjectionRefresh'

// The window's display subscriber for run state main changed on its own (MC-2155).
//
// `SprintEngineProjectionSupervisor` re-reads a sprint workspace's projection on a
// 4s/15s cadence, but it QUIESCES on a terminal, torn-down run
// (`canStopPollingCompletedSprintEngineProjection`) — that run "won't change
// again". A pull request breaks that assumption: it merges on GitHub hours after
// the run finished, and main's merge poller
// (`main/sprintengine-pr-merge-poller.ts`, the single owner of the probe since the
// renderer supervisor was retired) rewrites the projection with nobody in this
// window reading it. Without this the sidebar glyph stays "Ready for review" green
// until the app is restarted.
//
// So: on main's runs-changed broadcast, force ONE projection refresh for the
// matching workspace — and only for the workspaces whose poll has quiesced. Every
// other sprint workspace is already being read on its own cadence, and refreshing
// those here would just duplicate a read that is about to happen anyway.
export function collectQuiescedSprintWorkspaces(
  workspaces: readonly Workspace[],
  workspaceIds: ReadonlySet<string>,
  statePath: string,
): Workspace[] {
  return workspaces.filter(
    (workspace) =>
      workspaceIds.has(workspace.id)
      && (workspace.mode === 'sprintengine' || Boolean(workspace.sprintEngineContext))
      && workspace.sprintEngineContext?.statePath === statePath
      && canStopPollingCompletedSprintEngineProjection(workspace),
  )
}

type Props = {
  workspaceIds: string[]
}

export default function SprintEngineRunChangeSubscriber({ workspaceIds }: Props) {
  // Read the window's workspace set reactively without re-running the mount
  // effect, which would drop and re-open the IPC subscription on every change.
  const workspaceIdsRef = useRef(workspaceIds)
  workspaceIdsRef.current = workspaceIds

  useEffect(() => {
    let disposed = false
    // Forced reads, so a fresh token map here is not a second source of truth for
    // the supervisor's; it only means the first refresh after mount pays a read.
    const tokens = new Map<string, string>()

    const unsubscribe = window.api.onSprintRunsChanged(({ statePath }) => {
      if (disposed || !statePath) return
      const targets = collectQuiescedSprintWorkspaces(
        useWorkspaceStore.getState().workspaces,
        new Set(workspaceIdsRef.current),
        statePath,
      )
      for (const workspace of targets) {
        void refreshSprintEngineWorkspaceProjection({
          workspace,
          tokens,
          cause: 'supervisor',
          force: true,
        }).catch(() => {
          // Best-effort display refresh: the run's on-disk state is already
          // correct, and the next event (or a reopen) retries.
        })
      }
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return null
}
