// Part of the IPC contract: the pool of warm agent worktrees.
// ../electron-api.ts re-exports everything here.
//
// Main owns every pool (src/main/worktree-pool/). A window only ever sees the
// snapshots below and asks for a lease, a return or a held-slot action; it
// never runs a git command against a slot itself.

/**
 * Where a slot is in its life:
 *
 * - `creating`: `worktree add` is running for it.
 * - `refreshing`: being reset to the pool's base (`origin/<default>`).
 * - `installing`: the dependency install is running after a refresh.
 * - `warm`: detached at the base, clean, unlocked, ready to lease.
 * - `leasing`: being handed to an agent (a moment).
 * - `leased`: an agent owns it, on `agent/<slug>`, locked.
 * - `returning`: its owner is gone and it is being checked for work.
 * - `held`: it holds work (or could not be checked) and waits for a person.
 * - `evicting`: being removed from disk.
 */
export type WorktreePoolSlotState =
  'creating' | 'refreshing' | 'installing' | 'warm' | 'leasing' | 'leased' | 'returning' | 'held' | 'evicting'

/** Dependencies in a slot: `none` means the repo has no lockfile the pool installs from. */
export type WorktreePoolDepsState = 'none' | 'ok' | 'stale' | 'installing' | 'failed'

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
  /** Pools warm up and agents lease from them. Off: every worktree is created fresh. */
  enabled: boolean
  /** Warm slots each active pool keeps ready (0–3). */
  warmTarget: number
  /** Disk all pools together may use before idle slots are evicted, in GB. */
  diskCapGb: number
  /** A pool not leased from for this many days gives its idle slots back. */
  idleEvictionDays: number
}

export const WORKTREE_POOL_WARM_TARGET_MAX = 3
export const DEFAULT_WORKTREE_POOL_SETTINGS: WorktreePoolSettings = {
  enabled: true,
  warmTarget: 2,
  diskCapGb: 20,
  idleEvictionDays: 7,
}

export type WorktreePoolLeaseOwner = {
  agentId: string | null
  workspaceId: string | null
}

export type WorktreePoolSlotView = {
  id: string
  path: string
  state: WorktreePoolSlotState
  baseRef: string | null
  baseSha: string | null
  refreshedAt: number | null
  depsState: WorktreePoolDepsState
  /** The install command the pool ran (or would run), e.g. `npm ci`. */
  installCommand: string | null
  /** The tail of a failed install or git step. */
  error: string | null
  lease: {
    leaseId: string
    branch: string
    owner: WorktreePoolLeaseOwner
    leasedAt: number
  } | null
  held: {
    reason: WorktreePoolHeldReason
    detail: string | null
    changedPaths: number | null
    branch: string | null
    since: number
  } | null
  sizeBytes: number | null
  lastUsedAt: number | null
}

export type WorktreePoolSnapshot = {
  poolId: string
  repoRoot: string
  /** Where the slots live: `<repo-parent>/.sprintengine-worktrees/<repo>`. */
  containerPath: string
  /** The filesystem the repo is on: `local`, `wsl:<distro>`, `unc:<server>`. */
  fsHost: string
  /** The platform the slots' dependencies are built for. */
  platform: string
  /** Turned off for this repository in the Worktree manager. */
  disabled: boolean
  /** Another Studio holds this pool; this one creates worktrees fresh. */
  heldByOtherInstance: boolean
  defaultRef: string | null
  lastFetchAt: number | null
  lastLeaseAt: number | null
  slots: WorktreePoolSlotView[]
}

export type WorktreePoolLeaseInput = {
  repoRoot: string
  /** The name the branch and slug are derived from: `agent/<slug>`. */
  name: string
  owner: WorktreePoolLeaseOwner
  /** The platform the agent runs on. Only native agents lease today. */
  runtime: 'native' | 'wsl'
}

export type WorktreePoolLeaseResult =
  | {
      ok: true
      leaseId: string
      slotId: string
      path: string
      branch: string
      baseRef: string | null
      depsState: WorktreePoolDepsState
      installCommand: string | null
      /** How long the lease took inside main, for the caller's own timing. */
      elapsedMs: number
    }
  | {
      ok: false
      /** Why no slot was handed out; the caller creates a worktree the old way. */
      reason: 'disabled' | 'unsupported' | 'no-warm-slot' | 'other-instance' | 'not-a-repo' | 'error'
      message: string
    }

export type WorktreePoolHeldAction = 'commit' | 'stash' | 'discard' | 'keep'

export type WorktreePoolActionInput =
  | { kind: 'held'; repoRoot: string; slotId: string; action: WorktreePoolHeldAction; message?: string }
  | { kind: 'refresh' | 'evict' | 'release'; repoRoot: string; slotId: string }
  | { kind: 'warm-up'; repoRoot: string }
  | { kind: 'set-disabled'; repoRoot: string; disabled: boolean }

export type WorktreePoolActionResult = { ok: true; message: string | null } | { ok: false; message: string }
