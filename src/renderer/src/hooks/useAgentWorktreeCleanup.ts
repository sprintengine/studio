import { useEffect } from 'react'

import { useWorkspaceStore } from '../store/workspaceStore'
import { isSettledWorkspace } from '../utils/workspaceSettle'
import {
  agentWorktreeCleanupPlan,
  chatsReclaimedBy,
  entriesRemovedBy,
  openWorkspaceIds,
} from '../utils/agentWorktreeCleanup'

/**
 * Runs the agent worktree cleanup unattended: once a little after launch,
 * a minute after an agent is removed (its worktree was just released) or a
 * chat in a worktree of its own settles (its folder was just offered,
 * `agentWorktreeCleanupPlan`), and every few hours. Main decides what is safe
 * to remove and keeps everything else (agent-worktree-cleanup.ts); this only
 * chooses when to ask, drops the store entries for what was removed, and
 * marks the settled chats whose worktree was given back. Owned by the primary
 * window alone, so two windows never sweep side by side (main would share the
 * run anyway).
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
// A second look after a chat settles, once main's idle rule (a worktree git
// wrote to within the hour is kept, AGENT_WORKTREE_MIN_IDLE_MS) can no longer
// be what keeps it. A chat that settles after three quiet days is long past
// that hour and goes on the first look; one that settles because its pull
// request merged usually is not — the agent pushed minutes ago — and without
// this would wait for the six-hourly sweep. One more sweep an hour after a
// settle costs a few git processes; a dependency-heavy checkout held five
// hours longer than it needs to be costs a gigabyte.
const AFTER_SETTLE_FOLLOW_UP_MS = 61 * 60_000

function agentCount(): number {
  let count = 0
  for (const workspace of useWorkspaceStore.getState().workspaces) count += Object.keys(workspace.agents ?? {}).length
  return count
}

/** The settled chats: each settle releases whatever worktree the chat held (it counts as deleted). */
function settledChatCount(): number {
  let count = 0
  for (const workspace of useWorkspaceStore.getState().workspaces) if (isSettledWorkspace(workspace)) count += 1
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
      const records = useWorkspaceStore.getState()
      const { protectedPaths, agentIds, agentKeys, keepBranches } = agentWorktreeCleanupPlan(
        records.workspaces,
        openWorkspaceIds(records),
      )
      const report = await window.api.cleanupAgentWorktrees({
        repoRoot,
        protectedPaths,
        agentIds,
        agentKeys,
        keepBranches,
        ownedOnly: true,
      })
      // Re-read the store: it may have moved while main was working.
      const store = useWorkspaceStore.getState()
      for (const [workspaceId, entryId] of entriesRemovedBy(store.workspaces, report)) {
        store.removeWorktreeEntry(workspaceId, entryId)
      }
      const reclaimedAt = Date.now()
      for (const workspaceId of chatsReclaimedBy(store.workspaces, report)) {
        store.setWorkspaceWorktreeReclaimed(workspaceId, reclaimedAt)
      }
    } catch {
      // A repository that cannot be swept now is swept next time.
    }
  }
}

/**
 * The unattended schedule, started by the primary window: `sweep` runs a
 * little after launch, a minute after an agent is removed or a worktree chat
 * settles (one pending at a time), an hour after the latest such settle, and
 * every few hours. Returns the stop.
 */
export function scheduleAgentWorktreeSweeps(sweep: () => void = () => void sweepAgentWorktrees()): () => void {
  let releaseTimer: number | null = null
  let followUpTimer: number | null = null
  const first = window.setTimeout(sweep, FIRST_SWEEP_DELAY_MS)
  const periodic = window.setInterval(sweep, SWEEP_INTERVAL_MS)
  let lastCount = agentCount()
  let lastSettled = settledChatCount()
  const unsubscribe = useWorkspaceStore.subscribe(() => {
    const count = agentCount()
    const removed = count < lastCount
    lastCount = count
    const settledCount = settledChatCount()
    const settled = settledCount > lastSettled
    lastSettled = settledCount
    if (settled) {
      // Pushed back by every settle rather than kept: the latest settle is
      // the one whose hour is not up yet, and the earlier ones are past
      // theirs by the time it runs.
      if (followUpTimer !== null) window.clearTimeout(followUpTimer)
      followUpTimer = window.setTimeout(() => {
        followUpTimer = null
        sweep()
      }, AFTER_SETTLE_FOLLOW_UP_MS)
    }
    if ((!removed && !settled) || releaseTimer !== null) return
    releaseTimer = window.setTimeout(() => {
      releaseTimer = null
      sweep()
    }, AFTER_RELEASE_DELAY_MS)
  })
  return () => {
    window.clearTimeout(first)
    window.clearInterval(periodic)
    if (releaseTimer !== null) window.clearTimeout(releaseTimer)
    if (followUpTimer !== null) window.clearTimeout(followUpTimer)
    unsubscribe()
  }
}

export function useAgentWorktreeCleanup(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !UNATTENDED_SWEEPS_ENABLED) return
    return scheduleAgentWorktreeSweeps()
  }, [enabled])
}
