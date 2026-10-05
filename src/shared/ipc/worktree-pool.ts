// Part of the IPC contract: the pool of reusable agent worktrees.
// ../electron-api.ts re-exports everything here.
//
// Main owns every pool (src/main/worktree-pool/). A window only ever sees the
// snapshots below and asks for a held-slot action; it never runs a git command
// against a slot itself. Leases are not asked for here: an agent worktree
// created with `fromPool` (GitWorktreeCreateInput) comes from the pool.

/**
 * Where a slot is in its life:
 *
 * - `creating`: `worktree add` is running for it.
 * - `idle`: detached, clean, unlocked, ready to lease. It sits at whatever base
 *   it was last leased at; the lease brings it up to date.
 * - `leasing`: being fetched up, reset and handed to an agent (a moment).
 * - `leased`: an agent owns it, on `agent/<slug>`, locked.
 * - `returning`: its owner is gone and it is being checked for work.
 * - `held`: it holds work (or could not be checked) and waits for a person.
 * - `evicting`: being removed from disk.
 */
export type WorktreePoolSlotState = 'creating' | 'idle' | 'leasing' | 'leased' | 'returning' | 'held' | 'evicting'

/**
 * Why a slot is held:
 * - `dirty`: uncommitted or untracked changes.
 * - `operation`: a merge, rebase, cherry-pick, revert or bisect is in progress.
 * - `unexpected-head`: an idle slot is on a branch, or moved off its base.
 * - `recovery`: the app stopped in the middle of an operation that cannot be
 *   safely re-run, or found a slot it had no record of.
 * - `error`: a git step failed; the detail says which.
 */
export type WorktreePoolHeldReason = 'dirty' | 'operation' | 'unexpected-head' | 'recovery' | 'error'

export type WorktreePoolSettings = {
  /** Agent worktrees come from the pool. Off: every one is created fresh and removed by the cleanup. */
  enabled: boolean
  /** Idle worktrees each repository keeps for reuse; a return beyond this removes the oldest. */
  keepIdle: number
}

export const WORKTREE_POOL_KEEP_IDLE_MAX = 6
export const DEFAULT_WORKTREE_POOL_SETTINGS: WorktreePoolSettings = {
  enabled: true,
  keepIdle: 3,
}

export type WorktreePoolSlotView = {
  id: string
  path: string
  state: WorktreePoolSlotState
  baseRef: string | null
  baseSha: string | null
  /** The tail of a failed git step. */
  error: string | null
  lease: {
    leaseId: string
    branch: string
    owner: string
    leasedAt: number
  } | null
  held: {
    reason: WorktreePoolHeldReason
    detail: string | null
    changedPaths: number | null
    branch: string | null
    since: number
  } | null
  lastUsedAt: number | null
}

export type WorktreePoolSnapshot = {
  poolId: string
  repoRoot: string
  /** Where the slots live: `<repo-parent>/.sprintengine-worktrees/<repo>`. */
  containerPath: string
  /** Another Studio holds this pool; this one creates worktrees fresh. */
  heldByOtherInstance: boolean
  defaultRef: string | null
  lastFetchAt: number | null
  slots: WorktreePoolSlotView[]
}

export type WorktreePoolHeldAction = 'commit' | 'stash' | 'discard' | 'keep'

export type WorktreePoolActionInput =
  | { kind: 'held'; repoRoot: string; slotId: string; action: WorktreePoolHeldAction; message?: string }
  | { kind: 'evict'; repoRoot: string; slotId: string }

export type WorktreePoolActionResult = { ok: true; message: string | null } | { ok: false; message: string }
