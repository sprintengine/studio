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
// Unattended sweeps are paused. The cleanup's only sign that a worktree is in
// use is this process's memory, so it can remove a worktree another Studio
// profile (or a terminal outside the app) is working in, and it counts ignored
// files and index-hidden edits as disposable. Until both are guarded on disk,
// the Worktree manager's "Clean up merged agent worktrees" action, which a
// person runs and reads the report of, is the only way it runs.
const UNATTENDED_SWEEPS_ENABLED = false

const FIRST_SWEEP_DELAY_MS = 2 * 60_000
const AFTER_RELEASE_DELAY_MS = 60_000
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000

function agentCount(): number {
  let count = 0
  for (const workspace of useWorkspaceStore.getState().workspaces) count += Object.keys(workspace.agents ?? {}).length
  return count
}

async function sweepAgentWorktrees(): Promise<void> {
  if (typeof window.api?.cleanupAgentWorktrees !== 'function') return
  const plan = agentWorktreeCleanupPlan(useWorkspaceStore.getState().workspaces)
  for (const repoRoot of plan.repoRoots) {
    try {
      const report = await window.api.cleanupAgentWorktrees({ repoRoot, protectedPaths: plan.protectedPaths })
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
