import type { WorktreePoolService } from './worktree-pool-service'

/**
 * The worktree pool this process leases agent worktrees from, if it has one.
 *
 * Only the desktop's main process keeps a pool: its records live in that
 * profile's user data, and two processes driving the same slots would race.
 * Anything else that creates an agent worktree through `createGitWorktree`
 * (the out-of-process server, a remote machine) finds none here and creates a
 * fresh worktree from the same default branch instead.
 */
let active: WorktreePoolService | null = null

export function installWorktreePool(pool: WorktreePoolService | null): void {
  active = pool
}

export function activeWorktreePool(): WorktreePoolService | null {
  return active
}
