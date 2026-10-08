import { basename, dirname, isAbsolute, resolve } from 'path'
import type { GitWorktreeEntry } from '../../shared/ipc/git'
import type {
  WorktreeDiskUsage,
  WorktreeInventory,
  WorktreeInventoryEntry,
  WorktreeInventoryInput,
  WorktreeInventoryProject,
} from '../../shared/ipc/worktree-pool'
import { hostIdForFolder, isWslHostId } from '../../shared/execution-host'
import { comparablePath } from '../../shared/host-paths'
import { changesAlreadyIn } from '../agent-worktree-cleanup'
import { listGitWorktrees } from '../git-worktree-list'
import { pathExists } from '../git-utils'
import { MEASURE_CONCURRENCY, measureDiskUsage, type MeasureDiskUsage } from './disk-usage'
import { isNetworkSharePath } from './pool-store'
import { defaultSlotGitRunner, resolvePoolBaseRef, type SlotGitRunner } from './slot-git'
import type { WorktreePoolService } from './worktree-pool-service'

/**
 * Every worktree of every project, for Settings ▸ Worktrees: the pool's slots
 * with their leases, and the worktrees the pool does not own (made by hand,
 * by an agent before the pool, or kept out of it), each with whether its work
 * is on the default branch, whether it holds changes, and what it takes on
 * disk. Read-only: removing one goes through the pool (a slot) or
 * `removeGitWorktree` (anything else), which check again.
 *
 * Only this machine's own repositories: a WSL distribution's or a network
 * share's worktrees are made by other git, and measuring across that boundary
 * would cost minutes.
 */

const MAX_CHANGES_LISTED = 12
const CONCURRENCY = 4

export type WorktreeInventoryDeps = {
  pool: Pick<WorktreePoolService, 'load' | 'measure' | 'snapshots'> | null
  git?: SlotGitRunner
  measure?: MeasureDiskUsage
  listWorktrees?: (repoRoot: string) => Promise<GitWorktreeEntry[] | null>
  now?: () => number
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

async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>, concurrency = CONCURRENCY): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      out[index] = await work(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
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
    slotId: string | null,
    slotSize: WorktreeDiskUsage | null,
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
    }
    if (missing) return described
    const status = await git(entry.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (status.ok) {
      const changes = parsePorcelainZ(status.stdout)
      described.changedPaths = changes.length
      described.changes = changes.slice(0, MAX_CHANGES_LISTED)
    }
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
    for (const root of await inBatches(folders, mainCheckout)) {
      if (root && !roots.has(comparablePath(root))) roots.set(comparablePath(root), root)
    }
    const projects = await inBatches([...roots.values()], async (repoRoot): Promise<WorktreeInventoryProject> => {
      const pool = snapshots.find((snapshot) => comparablePath(snapshot.repoRoot) === comparablePath(repoRoot)) ?? null
      const listed = await listWorktrees(repoRoot)
      if (!listed) {
        return { repoRoot, defaultRef: null, pool, worktrees: [], error: 'git could not list its worktrees.' }
      }
      const defaultRef = await resolvePoolBaseRef(git, repoRoot)
      const others = listed.filter((entry) => !entry.bare && comparablePath(entry.path) !== comparablePath(repoRoot))
      const worktrees = await inBatches(others, (entry) => {
        const slot = pool?.slots.find((candidate) => comparablePath(candidate.path) === comparablePath(entry.path))
        return describe(entry, defaultRef, slot?.id ?? null, slot?.size ?? null)
      })
      return { repoRoot, defaultRef, pool, worktrees, error: null }
    })
    if (measure) {
      const unmeasured = projects.flatMap((project) =>
        project.worktrees.filter((entry) => !entry.slotId && !entry.missing),
      )
      await inBatches(
        unmeasured,
        async (entry) => {
          const size = await measureSize(entry.path).catch(() => null)
          if (!size) return
          sizes.set(comparablePath(entry.path), size)
          entry.size = size
        },
        MEASURE_CONCURRENCY,
      )
      measuredAt = now()
    }
    return {
      // A project with no worktree but its own checkout has nothing to show.
      projects: projects.filter((project) => project.worktrees.length > 0 || project.error),
      measuredAt,
    }
  }

  return { read }
}

export type WorktreeInventoryService = ReturnType<typeof createWorktreeInventory>
