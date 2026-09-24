import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import type { GitCommandResult } from './git'
import { runGitCommand } from './git-utils'

/**
 * The on-disk "an agent is using this" mark on an agent worktree.
 *
 * The agent worktree cleanup (agent-worktree-cleanup.ts) used to judge a
 * worktree unused from this process's memory alone. That is blind to every
 * other Studio profile sharing the same `.sprintengine-worktrees` container (a
 * second dev build runs on its own profile), and to a worktree created between
 * the moment a sweep read the app's records and the moment it listed the
 * repository. So every agent worktree is locked with `git worktree lock` as soon
 * as it exists, and the cleanup never removes a locked worktree that is not its
 * own to release.
 *
 * The reason names the owner and the profile that placed it:
 *
 *     agent <owner> (SprintEngine Studio profile <tag>)
 *
 * `<tag>` is a short hash of the profile's user-data directory, so two profiles
 * on one machine never mistake each other's locks for their own, and no path
 * is written into the repository's metadata. A lock this profile placed is
 * released by this profile once its records no longer use the worktree (the
 * cleanup unlocks it right before removing it, the Worktree manager right
 * before a person removes it). A lock from another profile, or one a person
 * placed by hand, is never touched.
 */

const LOCK_REASON = /^agent (\S+) \(SprintEngine Studio profile ([0-9a-f]{6,})\)$/

let profileTag: string | null = null

/** Names this process's profile. Called once at startup with the user-data directory. */
export function setAgentWorktreeLockProfile(userDataDir: string | null): void {
  profileTag = userDataDir ? createHash('sha256').update(resolve(userDataDir)).digest('hex').slice(0, 12) : null
}

function currentProfileTag(): string {
  // A process that never named its profile still locks (so another profile
  // keeps its hands off), but with a tag no profile owns: it is never released
  // automatically, which errs towards keeping.
  return profileTag ?? '000000000000'
}

export function agentWorktreeLockReason(owner: string): string {
  const safeOwner = owner.trim().replace(/\s+/g, '-') || 'unnamed'
  return `agent ${safeOwner} (SprintEngine Studio profile ${currentProfileTag()})`
}

export type AgentWorktreeLockOwner = 'this-profile' | 'other-profile'

/**
 * Whose lock a `git worktree list` reason is: this profile's agent lock, another
 * profile's, or (null) not an agent lock at all — a person's, or none.
 */
export function agentWorktreeLockOwner(reason: string | null | undefined): AgentWorktreeLockOwner | null {
  const match = reason ? LOCK_REASON.exec(reason.trim()) : null
  if (!match) return null
  return profileTag !== null && match[2] === profileTag ? 'this-profile' : 'other-profile'
}

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>

const defaultRunGit: RunGit = (cwd, args) => runGitCommand(cwd, args)

export function lockAgentWorktree(
  repoRoot: string,
  worktreePath: string,
  owner: string,
  runGit: RunGit = defaultRunGit,
): Promise<GitCommandResult> {
  return runGit(repoRoot, ['worktree', 'lock', '--reason', agentWorktreeLockReason(owner), worktreePath])
}

/** Puts a lock back exactly as it was, reason and all (after a removal that did not go through). */
export function relockWorktree(
  repoRoot: string,
  worktreePath: string,
  reason: string | null,
  runGit: RunGit = defaultRunGit,
): Promise<GitCommandResult> {
  return runGit(repoRoot, ['worktree', 'lock', ...(reason ? ['--reason', reason] : []), worktreePath])
}

export function unlockWorktree(
  repoRoot: string,
  worktreePath: string,
  runGit: RunGit = defaultRunGit,
): Promise<GitCommandResult> {
  return runGit(repoRoot, ['worktree', 'unlock', worktreePath])
}
