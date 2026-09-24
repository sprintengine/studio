import { readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import type { GitCommandResult } from '../git'
import { runGitCommand } from '../git-run'

/**
 * The git a pool slot needs, and nothing a slot does not. Every call goes
 * through the shared runner (git-run.ts): reads carry a deadline and never take
 * `index.lock`, writes carry none and are never killed part-way, and nothing
 * can prompt.
 */

export type SlotGitRunner = (cwd: string, args: string[]) => Promise<GitCommandResult>

export const defaultSlotGitRunner: SlotGitRunner = (cwd, args) => runGitCommand(cwd, args)

export type SlotStatus = {
  /** The commit HEAD names; null for a repository with no commits yet. */
  oid: string | null
  /** The branch checked out, or null when HEAD is detached. */
  branch: string | null
  /** Changed, staged, unmerged and untracked paths. Ignored files never count. */
  changedPaths: number
}

/**
 * Parse `git status --porcelain=v2 --branch -z`. One process answers the three
 * questions every pool step asks — which commit, which branch, is it clean —
 * where separate `rev-parse`, `symbolic-ref` and `status` calls would be three.
 */
export function parseSlotStatus(stdout: string): SlotStatus {
  const records = stdout.split('\0')
  let oid: string | null = null
  let branch: string | null = null
  let changedPaths = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length).trim()
      oid = /^[0-9a-f]{40,64}$/iu.test(value) ? value : null
      continue
    }
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length).trim()
      branch = value === '(detached)' ? null : value
      continue
    }
    if (record.startsWith('#')) continue
    const kind = record[0]
    if (kind === '1' || kind === 'u' || kind === '?') changedPaths += 1
    else if (kind === '2') {
      changedPaths += 1
      // A rename or copy carries its original path as the next record.
      index += 1
    }
  }
  return { oid, branch, changedPaths }
}

export async function readSlotStatus(
  run: SlotGitRunner,
  slotPath: string,
): Promise<{ ok: true; status: SlotStatus } | { ok: false; message: string }> {
  const result = await run(slotPath, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  if (!result.ok) return { ok: false, message: result.message ?? 'git status failed' }
  return { ok: true, status: parseSlotStatus(result.stdout) }
}

/** The slot's own gitdir (`<common>/worktrees/<name>`), where its HEAD, index and locks live. */
export async function readSlotGitDir(run: SlotGitRunner, slotPath: string): Promise<string | null> {
  const result = await run(slotPath, ['rev-parse', '--absolute-git-dir'])
  const value = result.ok ? result.stdout.trim() : ''
  return value || null
}

const OPERATION_MARKERS: Array<[string, string]> = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
]

/** The multi-step operation parked in a slot, if any. A slot mid-rebase is never recycled. */
export async function operationInProgress(gitDir: string): Promise<string | null> {
  for (const [marker, name] of OPERATION_MARKERS) {
    if (
      await stat(join(gitDir, marker)).then(
        () => true,
        () => false,
      )
    )
      return name
  }
  return null
}

/** Minutes after which an `index.lock` nobody is using is treated as debris. */
export const STALE_INDEX_LOCK_MS = 10 * 60_000

export type IndexLockVerdict = 'none' | 'removed' | 'busy'

/**
 * A slot's `index.lock` is left behind when git is killed mid-write. It blocks
 * every later write in that slot until someone deletes it. The pool deletes one
 * only when BOTH hold: it is older than {@link STALE_INDEX_LOCK_MS}, and the
 * caller has established that nothing of ours runs in the slot (no live
 * terminal, no operation of our own in flight). A younger one is `busy`: some
 * git is probably mid-write right now, and the step is retried later.
 */
export async function clearStaleIndexLock(
  gitDir: string,
  nothingRunsHere: boolean,
  now: number = Date.now(),
  /** The lock is known to be a dead run's own (crash recovery): its age does not matter. */
  ownedByDeadRun = false,
): Promise<IndexLockVerdict> {
  const lockPath = join(gitDir, 'index.lock')
  const info = await stat(lockPath).catch(() => null)
  if (!info) return 'none'
  if (!nothingRunsHere) return 'busy'
  if (!ownedByDeadRun && now - info.mtimeMs < STALE_INDEX_LOCK_MS) return 'busy'
  await rm(lockPath, { force: true })
  return 'removed'
}

/**
 * The branch the pool refreshes to: `origin/HEAD`'s target, else `origin/main`
 * or `origin/master`, else a local `main` or `master`. Null when none exists,
 * and then the pool cannot refresh anything.
 */
export async function resolvePoolBaseRef(run: SlotGitRunner, repoRoot: string): Promise<string | null> {
  const originHead = await run(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  const named = originHead.ok ? originHead.stdout.trim().replace(/^refs\/remotes\//u, '') : ''
  const candidates = [...(named ? [named] : []), 'origin/main', 'origin/master', 'main', 'master']
  for (const candidate of candidates) {
    const verified = await run(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    if (verified.ok && verified.stdout.trim()) return candidate
  }
  return null
}

export async function revParseCommit(run: SlotGitRunner, cwd: string, ref: string): Promise<string | null> {
  const result = await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  const value = result.ok ? result.stdout.trim() : ''
  return /^[0-9a-f]{40,64}$/iu.test(value) ? value : null
}

/**
 * Bring `origin/<branch>` up to date, once. Only the one branch the pool bases
 * on is fetched, without tags: this is a background refresh, not a pull.
 */
export async function fetchBase(run: SlotGitRunner, repoRoot: string, baseRef: string): Promise<GitCommandResult> {
  const match = /^([^/]+)\/(.+)$/u.exec(baseRef)
  if (!match) return { ok: true, stdout: '', stderr: '', message: null }
  const [, remote, branch] = match
  return run(repoRoot, [
    'fetch',
    '--no-tags',
    '--quiet',
    remote,
    `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
  ])
}

/** Whether `oid` is on some local branch or remote-tracking ref (so detaching from it loses nothing). */
export async function commitIsReachable(run: SlotGitRunner, cwd: string, oid: string): Promise<boolean> {
  const result = await run(cwd, [
    'for-each-ref',
    '--count=1',
    '--format=%(refname)',
    `--contains=${oid}`,
    'refs/heads',
    'refs/remotes',
  ])
  // Unreadable is "not reachable": the caller then keeps the commit on a branch.
  return result.ok && result.stdout.trim().length > 0
}

export async function hasFile(slotPath: string, name: string): Promise<boolean> {
  return stat(join(slotPath, name)).then(
    () => true,
    () => false,
  )
}

/** Whether the tree at `slotPath` routes any file through LFS. */
export async function usesLfs(slotPath: string): Promise<boolean> {
  const text = await readFile(join(slotPath, '.gitattributes'), 'utf8').catch(() => '')
  return /filter=lfs\b/u.test(text)
}
