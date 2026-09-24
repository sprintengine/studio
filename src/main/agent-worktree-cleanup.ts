import type {
  AgentWorktreeCleanupEntry,
  AgentWorktreeCleanupInput,
  AgentWorktreeCleanupReport,
} from '../shared/ipc/git'
import { repoRootFromWorktreePath } from '../shared/worktree-paths'
import type { GitCommandResult, GitWorktreeEntry } from './git'
import { normalizeComparablePath, pathExists, runGitCommand } from './git-utils'
import { listGitWorktrees } from './git-worktree-list'
import { resolveRepoRoot } from './git-worktree-validation'
import { withWorktreeRegistryLock } from './worktree-registry-lock'

/**
 * Removes the agent worktrees nobody needs any more, and nothing else.
 *
 * Agent worktrees used to be created and never removed: every agent spawned
 * "with a worktree" left a checkout (and usually a gigabyte of dependencies)
 * behind for good. This is the sweep that reclaims them, and it is built to be
 * safe to run unattended, which means every rule below errs towards keeping.
 *
 * A worktree is removed only when ALL of these hold:
 *
 * 1. **It is an agent worktree.** Its branch is `agent/<slug>` and it lives in
 *    the app's own worktree container (`.sprintengine-worktrees`). A worktree
 *    the person made in the Worktree manager (`sprintengine/<slug>`), one made
 *    outside the app, and the automation runs' worktrees (removed by their own
 *    finalize step) are never candidates.
 * 2. **Nothing uses it.** No path the caller protects — every workspace's
 *    folder and worktree, every agent still holding one — and no live terminal
 *    session sits in it.
 * 3. **It is registered, present and unlocked.** A missing or prunable one is
 *    reported and left for `worktree prune`, which the person runs; a locked
 *    one is locked on purpose.
 * 4. **It is clean.** `git status` reports nothing, untracked files included.
 * 5. **Its work is on the default branch** (`origin/HEAD`, else `origin/main`
 *    or `origin/master`; with no remote, the local `main` or `master`). Either
 *    its HEAD has no commit the default branch lacks (a branch that never got
 *    a commit has none by definition), or — for a squash-merged branch, whose
 *    commits are not on the trunk by hash — merging it into the default
 *    branch would produce the default branch's own tree, so its changes are
 *    already there (`changesAlreadyIn`). On a git too old for that test the
 *    ancestry rule alone decides, and a squash-merged branch is kept.
 *
 * The removal itself is `git worktree remove` WITHOUT `--force`, so git checks
 * cleanliness again at the moment of removal: anything written between the
 * check above and the removal makes git refuse, and the sweep reports the
 * refusal. Ignored files (installed dependencies, a copied `.env`) go with the
 * worktree; they are reproducible or copies. The branch itself is kept.
 *
 * Every decision is logged, removals and keeps alike.
 */

export type AgentWorktreeCleanupDeps = {
  runGit?: (cwd: string, args: string[]) => Promise<GitCommandResult>
  listWorktrees?: (repoRoot: string) => Promise<GitWorktreeEntry[] | null>
  resolveRoot?: (repoRoot: string) => Promise<string | null>
  exists?: (path: string) => Promise<boolean>
  /** Working directories of the live terminal sessions, which are never removed from under. */
  livePaths?: () => string[]
  /**
   * Whether the worktree pool owns a path. A pool slot is on an `agent/` branch
   * only while it is leased, and the pool alone decides what happens to it:
   * it returns a slot to the pool, it never deletes one with its branch on it.
   */
  poolOwns?: (path: string) => boolean
  log?: (line: string) => void
}

const AGENT_BRANCH_PREFIX = 'agent/'
const DEFAULT_REF_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master']

function isInside(child: string, parent: string): boolean {
  const a = normalizeComparablePath(child)
  const b = normalizeComparablePath(parent)
  return a === b || a.startsWith(`${b}/`)
}

async function resolveDefaultRef(
  repoRoot: string,
  runGit: NonNullable<AgentWorktreeCleanupDeps['runGit']>,
): Promise<string | null> {
  const originHead = await runGit(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  const named = originHead.ok ? originHead.stdout.trim().replace(/^refs\/remotes\//, '') : ''
  for (const candidate of named ? [named, ...DEFAULT_REF_CANDIDATES] : DEFAULT_REF_CANDIDATES) {
    const verified = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    if (verified.ok && verified.stdout.trim()) return candidate
  }
  return null
}

/**
 * Whether merging `head` into `defaultRef` would change nothing — that is,
 * every change on the branch is already on the default branch, however it got
 * there (a squash merge, a rebase-and-merge, a cherry-pick).
 *
 * `git merge-tree --write-tree` performs the merge in memory and prints the
 * resulting tree without touching a ref, the index or a working tree. If that
 * tree is the default branch's own tree, removing the worktree loses nothing
 * the default branch does not already hold.
 *
 * Anything short of a clean answer is "not merged": a conflict (exit 1), an
 * unreadable result, or a git older than 2.38 that does not know
 * `--write-tree` (it fails with a usage error). The caller then keeps the
 * ancestry rule's verdict, which only ever keeps more.
 */
export async function changesAlreadyIn(
  cwd: string,
  defaultRef: string,
  head: string,
  runGit: NonNullable<AgentWorktreeCleanupDeps['runGit']>,
): Promise<boolean> {
  const merged = await runGit(cwd, ['merge-tree', '--write-tree', defaultRef, head])
  if (!merged.ok) return false
  const mergedTree = merged.stdout.split(/\r?\n/)[0]?.trim() ?? ''
  if (!/^[0-9a-f]{40,64}$/i.test(mergedTree)) return false
  const defaultTree = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${defaultRef}^{tree}`])
  if (!defaultTree.ok) return false
  return defaultTree.stdout.trim() === mergedTree
}

export async function cleanupAgentWorktrees(
  input: AgentWorktreeCleanupInput,
  deps: AgentWorktreeCleanupDeps = {},
): Promise<AgentWorktreeCleanupReport> {
  const runGit = deps.runGit ?? ((cwd: string, args: string[]) => runGitCommand(cwd, args))
  const log = deps.log ?? ((line: string) => console.info(`[worktree-cleanup] ${line}`))
  const exists = deps.exists ?? pathExists
  const dryRun = input.dryRun === true
  const empty = (repoRoot: string, defaultRef: string | null = null): AgentWorktreeCleanupReport => ({
    repoRoot,
    defaultRef,
    entries: [],
    dryRun,
  })

  const root = deps.resolveRoot
    ? await deps.resolveRoot(input.repoRoot)
    : await resolveRepoRoot(input.repoRoot).then((result) => (result.ok ? result.data : null))
  if (!root) return empty(input.repoRoot)

  const worktrees = deps.listWorktrees
    ? await deps.listWorktrees(root)
    : await listGitWorktrees(root, { resolvedRoot: true }).then((result) => (result.ok ? result.data.worktrees : null))
  if (!worktrees) return empty(root)

  const candidates = worktrees.filter(
    (worktree) =>
      !worktree.bare &&
      worktree.branch?.startsWith(AGENT_BRANCH_PREFIX) === true &&
      repoRootFromWorktreePath(worktree.path) !== null &&
      !isInside(root, worktree.path),
  )
  if (candidates.length === 0) return empty(root)

  const defaultRef = await resolveDefaultRef(root, runGit)
  const protectedPaths = [...input.protectedPaths, ...(deps.livePaths?.() ?? [])].filter(Boolean)
  const entries: AgentWorktreeCleanupEntry[] = []
  const record = (entry: AgentWorktreeCleanupEntry): void => {
    entries.push(entry)
    const facts = [
      entry.uniqueCommits !== undefined ? `${entry.uniqueCommits} commit(s) not on ${defaultRef}` : null,
      entry.changedPaths !== undefined ? `${entry.changedPaths} changed path(s)` : null,
      entry.detail ?? null,
    ].filter(Boolean)
    log(
      `${dryRun && entry.verdict === 'removed' ? 'would remove' : entry.verdict === 'removed' ? 'removed' : `kept (${entry.verdict})`} ${entry.path} [${entry.branch ?? 'detached'}]${facts.length ? ` — ${facts.join('; ')}` : ''}`,
    )
  }

  for (const worktree of candidates) {
    const base = { path: worktree.path, branch: worktree.branch }
    if (deps.poolOwns?.(worktree.path)) {
      record({ ...base, verdict: 'in-use', detail: 'worktree pool slot' })
      continue
    }
    // Something sits IN it. A protected path that merely contains it (a
    // workspace opened on a parent folder) does not use it.
    if (protectedPaths.some((path) => isInside(path, worktree.path))) {
      record({ ...base, verdict: 'in-use' })
      continue
    }
    if (worktree.locked) {
      record({ ...base, verdict: 'locked', detail: worktree.lockedReason ?? undefined })
      continue
    }
    if (worktree.prunable || !(await exists(worktree.path))) {
      record({ ...base, verdict: 'missing' })
      continue
    }
    const status = await runGit(worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!status.ok) {
      record({ ...base, verdict: 'error', detail: status.message ?? 'git status failed' })
      continue
    }
    const changedPaths = status.stdout.split('\0').filter(Boolean).length
    if (changedPaths > 0) {
      record({ ...base, verdict: 'dirty', changedPaths })
      continue
    }
    if (!defaultRef) {
      record({ ...base, verdict: 'no-default-branch' })
      continue
    }
    const head = worktree.head ?? 'HEAD'
    const unique = await runGit(worktree.path, ['rev-list', '--count', `${defaultRef}..${head}`])
    const uniqueCommits = unique.ok ? Number.parseInt(unique.stdout.trim(), 10) : Number.NaN
    if (!Number.isFinite(uniqueCommits)) {
      record({ ...base, verdict: 'error', detail: unique.message ?? 'could not count commits' })
      continue
    }
    // Commits the default branch lacks by hash may still be there by content:
    // a squash merge lands the same changes as one new commit.
    const mergedByContent = uniqueCommits > 0 && (await changesAlreadyIn(worktree.path, defaultRef, head, runGit))
    if (uniqueCommits > 0 && !mergedByContent) {
      record({ ...base, verdict: 'unmerged', uniqueCommits })
      continue
    }
    const how = mergedByContent ? 'changes already on the default branch (squash-merged)' : undefined
    if (dryRun) {
      record({ ...base, verdict: 'removed', detail: how })
      continue
    }
    // No --force: git re-checks cleanliness itself at the moment of removal.
    const removed = await withWorktreeRegistryLock(root, () => runGit(root, ['worktree', 'remove', worktree.path]))
    record(
      removed.ok
        ? { ...base, verdict: 'removed', detail: how }
        : { ...base, verdict: 'error', detail: removed.message ?? 'git worktree remove failed' },
    )
  }

  return { repoRoot: root, defaultRef, entries, dryRun }
}

/**
 * One sweep per repository at a time. Two windows asking together, or a
 * release arriving while a scheduled sweep runs, share the one in flight
 * rather than racing each other's `worktree remove`.
 */
const inFlight = new Map<string, Promise<AgentWorktreeCleanupReport>>()

export function cleanupAgentWorktreesOnce(
  input: AgentWorktreeCleanupInput,
  deps: AgentWorktreeCleanupDeps = {},
): Promise<AgentWorktreeCleanupReport> {
  const key = `${normalizeComparablePath(input.repoRoot)}\0${input.dryRun === true}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const run = cleanupAgentWorktrees(input, deps).finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}
