import { basename, dirname, isAbsolute, resolve } from 'path'
import type { GitWorktreeEntry } from '../../shared/ipc/git'
import type {
  WorktreeDiskUsage,
  WorktreeInventory,
  WorktreeInventoryEntry,
  WorktreeInventoryInput,
  WorktreeInventoryProject,
  WorktreePoolActionResult,
} from '../../shared/ipc/worktree-pool'
import { mapWithLimit } from '../../shared/concurrency'
import { hostIdForFolder, isWslHostId } from '../../shared/execution-host'
import { comparablePath } from '../../shared/host-paths'
import { changesAlreadyIn } from '../agent-worktree-cleanup'
import {
  hiddenEditPaths,
  ignoredPathsAtRisk,
  insideAny,
  isChatTranscriptPath,
  pathSpellings,
  worktreeLastUsedAt,
} from '../agent-worktree-keep-checks'
import { listGitWorktrees } from '../git-worktree-list'
import { pathExists } from '../git-utils'
import { MEASURE_CONCURRENCY, measureDiskUsage, type MeasureDiskUsage } from './disk-usage'
import { isNetworkSharePath } from './pool-store'
import {
  commitIsReachable,
  defaultSlotGitRunner,
  readSlotStatus,
  resolvePoolBaseRef,
  type SlotGitRunner,
} from './slot-git'
import type { WorktreePoolService } from './worktree-pool-service'

/**
 * Every worktree of every project, for Settings ▸ Worktrees: the pool's slots
 * with their leases, and the worktrees the pool does not own (made by hand,
 * by an agent before the pool, or kept out of it), each with whether its work
 * is on the default branch, whether it holds changes, and what it takes on
 * disk. Removing one goes through the pool (a slot) or `removeOther`
 * (anything else), each of which checks it again.
 *
 * Only this machine's own repositories: a WSL distribution's or a network
 * share's worktrees are made by other git, and measuring across that boundary
 * would cost minutes.
 */

const MAX_CHANGES_LISTED = 12
const CONCURRENCY = 8

export type WorktreeInventoryDeps = {
  pool: Pick<WorktreePoolService, 'load' | 'measure' | 'snapshots' | 'ownsPath'> | null
  git?: SlotGitRunner
  measure?: MeasureDiskUsage
  listWorktrees?: (repoRoot: string) => Promise<GitWorktreeEntry[] | null>
  now?: () => number
  /** Where live work sits (terminals, chats working now): a worktree one is in is never removed. */
  livePaths?: () => string[] | Promise<string[]>
  /** The ids of every chat on record, or null when unknown: a worktree holding one's history is kept. */
  knownWorkspaceIds?: () => Iterable<string> | null
  /** The removal itself, once every check passed (git.ts `removeGitWorktree`, which checks status again). */
  removeWorktree?: (input: { repoRoot: string; path: string }) => Promise<{ ok: boolean; message: string | null }>
}

/** `git status --porcelain=v1 -z` → entries, a rename's source path folded into its entry. */
function parsePorcelainZ(stdout: string): Array<{ code: string; path: string }> {
  const tokens = stdout.split('\0')
  const out: Array<{ code: string; path: string }> = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.length < 4) continue
    const code = token.slice(0, 2)
    out.push({ code: code.trim() || code, path: token.slice(3) })
    if (code[0] === 'R' || code[0] === 'C') index += 1
  }
  return out
}

export function createWorktreeInventory(deps: WorktreeInventoryDeps) {
  const git = deps.git ?? defaultSlotGitRunner
  const measureSize = deps.measure ?? measureDiskUsage
  const now = deps.now ?? Date.now
  const listWorktrees =
    deps.listWorktrees ??
    ((repoRoot: string) =>
      listGitWorktrees(repoRoot, { resolvedRoot: true }).then((result) => (result.ok ? result.data.worktrees : null)))
  /** Sizes of worktrees the pool does not own, as last measured; the pool keeps its own slots'. */
  const sizes = new Map<string, WorktreeDiskUsage>()
  let measuredAt: number | null = null
  /**
   * Where each worktree stands against the default branch, by its HEAD and the
   * default branch's commit: both unchanged, the answer is too. Counting and
   * the squash-merge test are most of what a read costs, and most worktrees
   * have not moved since the page last asked.
   */
  const standing = new Map<string, Pick<WorktreeInventoryEntry, 'uniqueCommits' | 'behindCommits' | 'merged'>>()

  /** The main checkout of the repository a folder is in, or null when it has none here. */
  async function mainCheckout(folder: string): Promise<string | null> {
    if (isWslHostId(hostIdForFolder(folder)) || isNetworkSharePath(folder)) return null
    if (!(await pathExists(folder))) return null
    const result = await git(folder, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
    if (!result.ok) return null
    const [toplevel, common] = result.stdout.split(/\r?\n/u).map((line) => line.trim())
    if (!toplevel || !common) return null
    const commonDir = isAbsolute(common) ? common : resolve(toplevel, common)
    return basename(commonDir) === '.git' ? dirname(commonDir) : null
  }

  async function describe(
    entry: GitWorktreeEntry,
    defaultRef: string | null,
    defaultSha: string | null,
    slotId: string | null,
    slotSize: WorktreeDiskUsage | null,
    slotUsedAt: number | null,
  ): Promise<WorktreeInventoryEntry> {
    const missing = entry.prunable || !(await pathExists(entry.path))
    const described: WorktreeInventoryEntry = {
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      slotId,
      lockedByOther:
        !slotId && entry.locked && entry.agentLock !== 'this-profile' && !entry.lockedReason?.startsWith('held: '),
      missing,
      uniqueCommits: null,
      behindCommits: null,
      merged: null,
      changedPaths: null,
      changes: [],
      size: slotId ? slotSize : (sizes.get(comparablePath(entry.path)) ?? null),
      lastUsedAt: slotUsedAt,
    }
    if (missing) return described
    const usedAt = await worktreeLastUsedAt(entry.path, git)
    if (usedAt !== null) described.lastUsedAt = Math.max(usedAt, slotUsedAt ?? 0)
    const status = await git(entry.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (status.ok) {
      const changes = parsePorcelainZ(status.stdout)
      described.changedPaths = changes.length
      described.changes = changes.slice(0, MAX_CHANGES_LISTED)
    }
    const standingKey = defaultSha && entry.head ? `${comparablePath(entry.path)}\0${entry.head}\0${defaultSha}` : null
    const known = standingKey ? standing.get(standingKey) : undefined
    if (known) return { ...described, ...known }
    if (defaultRef && entry.head) {
      const ahead = await git(entry.path, ['rev-list', '--count', `${defaultRef}..${entry.head}`])
      const behind = await git(entry.path, ['rev-list', '--count', `${entry.head}..${defaultRef}`])
      const unique = ahead.ok ? Number.parseInt(ahead.stdout.trim(), 10) : Number.NaN
      described.uniqueCommits = Number.isFinite(unique) ? unique : null
      const lacking = behind.ok ? Number.parseInt(behind.stdout.trim(), 10) : Number.NaN
      described.behindCommits = Number.isFinite(lacking) ? lacking : null
      if (described.uniqueCommits !== null) {
        described.merged =
          described.uniqueCommits === 0 || (await changesAlreadyIn(entry.path, defaultRef, entry.head, git))
      }
      if (standingKey && described.uniqueCommits !== null && described.behindCommits !== null) {
        const { uniqueCommits, behindCommits, merged } = described
        standing.set(standingKey, { uniqueCommits, behindCommits, merged })
      }
    }
    return described
  }

  async function read(input: WorktreeInventoryInput): Promise<WorktreeInventory> {
    const measure = input.measure === true
    await deps.pool?.load()
    // The pool measures its own slots, and holds itself to the disk limit once
    // it knows their sizes.
    if (measure) await deps.pool?.measure()
    const snapshots = (await deps.pool?.snapshots()) ?? []
    const folders = [...input.repoRoots, ...snapshots.map((snapshot) => snapshot.repoRoot)]
    const roots = new Map<string, string>()
    for (const root of await mapWithLimit(folders, CONCURRENCY, mainCheckout)) {
      if (root && !roots.has(comparablePath(root))) roots.set(comparablePath(root), root)
    }
    const projects = await mapWithLimit(
      [...roots.values()],
      CONCURRENCY,
      async (repoRoot): Promise<WorktreeInventoryProject> => {
        const pool =
          snapshots.find((snapshot) => comparablePath(snapshot.repoRoot) === comparablePath(repoRoot)) ?? null
        const listed = await listWorktrees(repoRoot)
        if (!listed) {
          return { repoRoot, defaultRef: null, pool, worktrees: [], error: 'git could not list its worktrees.' }
        }
        const defaultRef = await resolvePoolBaseRef(git, repoRoot)
        const resolved = defaultRef
          ? await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${defaultRef}^{commit}`])
          : null
        const defaultSha = resolved?.ok ? resolved.stdout.trim() || null : null
        const others = listed.filter((entry) => !entry.bare && comparablePath(entry.path) !== comparablePath(repoRoot))
        const worktrees = await mapWithLimit(others, CONCURRENCY, (entry) => {
          const slot = pool?.slots.find((candidate) => comparablePath(candidate.path) === comparablePath(entry.path))
          return describe(entry, defaultRef, defaultSha, slot?.id ?? null, slot?.size ?? null, slot?.lastUsedAt ?? null)
        })
        return { repoRoot, defaultRef, pool, worktrees, error: null }
      },
    )
    if (measure) {
      const unmeasured = projects.flatMap((project) =>
        project.worktrees.filter((entry) => !entry.slotId && !entry.missing),
      )
      await mapWithLimit(unmeasured, MEASURE_CONCURRENCY, async (entry) => {
        const size = await measureSize(entry.path).catch(() => null)
        if (!size) return
        sizes.set(comparablePath(entry.path), size)
        entry.size = size
      })
      measuredAt = now()
    }
    return {
      // A project with no worktree but its own checkout has nothing to show.
      projects: projects.filter((project) => project.worktrees.length > 0 || project.error),
      measuredAt,
    }
  }

  /**
   * Remove a worktree the pool does not own, for Settings ▸ Worktrees ("Remove",
   * "Free up space"), with the checks the pool's own eviction and the agent
   * worktree cleanup apply before a folder goes: nothing live works in it, no
   * uncommitted changes, no commits only its detached HEAD holds, no edits
   * hidden from `git status`, and no ignored file that may be someone's work
   * or a chat's history (agent-worktree-keep-checks.ts). The answer says why
   * it was kept, in the person's words.
   */
  async function removeOther(input: { repoRoot: string; path: string }): Promise<WorktreePoolActionResult> {
    const { repoRoot, path } = input
    await deps.pool?.load()
    if (deps.pool?.ownsPath(path)) {
      return { ok: false, message: 'It is in the worktree pool; remove it as a pool worktree.' }
    }
    const live = ((await deps.livePaths?.()) ?? []).filter(Boolean)
    const worktreeSpellings = await pathSpellings(path)
    for (const each of live) {
      if (insideAny(await pathSpellings(each), worktreeSpellings)) {
        return { ok: false, message: 'A terminal or a chat is working in it. Close it first.' }
      }
    }
    if (!(await pathExists(path))) return { ok: false, message: 'Its folder is gone already; prune it instead.' }
    const status = await readSlotStatus(git, path)
    if (!status.ok) return { ok: false, message: `Could not read its status: ${status.message}` }
    if (status.status.changedPaths > 0) {
      return { ok: false, message: 'It has uncommitted changes. Commit, stash or discard them first.' }
    }
    const oid = status.status.oid
    if (status.status.branch === null && oid && !(await commitIsReachable(git, path, oid))) {
      return { ok: false, message: 'It holds commits no branch has. Put them on a branch first.' }
    }
    const hidden = await hiddenEditPaths(path, git)
    if (!hidden.ok) return { ok: false, message: hidden.message }
    if (hidden.paths.length > 0) {
      return {
        ok: false,
        message: `It has edits git status does not show (${hidden.paths.slice(0, 3).join(', ')}), so it is kept.`,
      }
    }
    const ignored = await ignoredPathsAtRisk(repoRoot, path, git, { knownWorkspaceIds: deps.knownWorkspaceIds ?? null })
    if (!ignored.ok) return { ok: false, message: 'Could not check its ignored files, so it is kept.' }
    if (ignored.paths.length > 0) {
      const files = ignored.paths.filter((entry) => !isChatTranscriptPath(entry))
      if (files.length === 0) {
        return {
          ok: false,
          message: 'It holds the history of a chat that is not settled. Settle or delete the chat to let it go.',
        }
      }
      const more = files.length > 3 ? ` and ${files.length - 3} more` : ''
      return {
        ok: false,
        message: `It has ignored files that may be someone’s work (${files.slice(0, 3).join(', ')}${more}), so it is kept.`,
      }
    }
    if (!deps.removeWorktree) return { ok: false, message: 'Removing worktrees is not available here.' }
    const removed = await deps.removeWorktree({ repoRoot, path })
    return removed.ok
      ? { ok: true, message: null }
      : { ok: false, message: removed.message ?? 'Git did not remove it.' }
  }

  return { read, removeOther }
}
