import { useEffect } from 'react'

import { useWorkspaceStore } from '../store/workspaceStore'
import { agentWorktreeCleanupPlan, entriesRemovedBy } from '../utils/agentWorktreeCleanup'

/**
 * Runs the agent worktree cleanup unattended: once a little after launch,
 * a minute after an agent is removed (its worktree was just released), and
 * every few hours. Main decides what is safe to remove and keeps everything
 * else (agent-worktree-cleanup.ts); this only chooses when to ask, and drops
 * the store entries for what was removed. Owned by the primary window alone,
 * so two windows never sweep side by side (main would share the run anyway).
 */
// Unattended sweeps run again now that what the cleanup relies on is on disk,
// not only in this process's memory: every agent worktree is locked with
// `git worktree lock` as it is created, so another Studio profile never takes
// one it does not own; a worktree git touched within the last hour is kept; a
// protected path matches however it is spelled (symlinks resolved, case folded
// on macOS and Windows); and ignored files that may be work (an edited `.env`,
// notes in an ignored folder) and edits hidden with `--skip-worktree` or
// `--assume-unchanged` keep a worktree (agent-worktree-cleanup.ts). Unattended,
// it takes only worktrees this profile locked (`ownedOnly`): an unlocked one may
// belong to another profile on an older build. Set this to
// false to leave the Worktree manager's "Clean up merged agent worktrees"
// action, which a person runs and reads the report of, as the only way in.
const UNATTENDED_SWEEPS_ENABLED = true

const FIRST_SWEEP_DELAY_MS = 2 * 60_000
const AFTER_RELEASE_DELAY_MS = 60_000
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000

function agentCount(): number {
  let count = 0
  for (const workspace of useWorkspaceStore.getState().workspaces) count += Object.keys(workspace.agents ?? {}).length
  return count
}

export async function sweepAgentWorktrees(): Promise<void> {
  if (typeof window.api?.cleanupAgentWorktrees !== 'function') return
  const { repoRoots } = agentWorktreeCleanupPlan(useWorkspaceStore.getState().workspaces)
  for (const repoRoot of repoRoots) {
    try {
      // Read per repository, just before main lists it: a sweep over several
      // repositories can take a while, and a worktree created during it must be
      // protected by the records as they are when its repository is listed.
      const { protectedPaths } = agentWorktreeCleanupPlan(useWorkspaceStore.getState().workspaces)
      const report = await window.api.cleanupAgentWorktrees({ repoRoot, protectedPaths, ownedOnly: true })
      // Re-read the store: it may have moved while main was working.
      const store = useWorkspaceStore.getState()
      for (const [workspaceId, entryId] of entriesRemovedBy(store.workspaces, report)) {
        store.removeWorktreeEntry(workspaceId, entryId)
      }
    } catch {
      // A repository that cannot be swept now is swept next time.
    }
  }
}

export function useAgentWorktreeCleanup(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !UNATTENDED_SWEEPS_ENABLED) return
    let releaseTimer: number | null = null
    const first = window.setTimeout(() => void sweepAgentWorktrees(), FIRST_SWEEP_DELAY_MS)
    const periodic = window.setInterval(() => void sweepAgentWorktrees(), SWEEP_INTERVAL_MS)
    let lastCount = agentCount()
    const unsubscribe = useWorkspaceStore.subscribe(() => {
      const count = agentCount()
      const removed = count < lastCount
      lastCount = count
      if (!removed || releaseTimer !== null) return
      releaseTimer = window.setTimeout(() => {
        releaseTimer = null
        void sweepAgentWorktrees()
      }, AFTER_RELEASE_DELAY_MS)
    })
    return () => {
      window.clearTimeout(first)
      window.clearInterval(periodic)
      if (releaseTimer !== null) window.clearTimeout(releaseTimer)
      unsubscribe()
    }
  }, [enabled])
}
