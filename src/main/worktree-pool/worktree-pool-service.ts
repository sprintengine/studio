import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { lstat, readdir, rm } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import {
  type WorktreePoolActionInput,
  type WorktreePoolActionResult,
  type WorktreePoolHeldReason,
  type WorktreePoolLeaseInput,
  type WorktreePoolLeaseOwner,
  type WorktreePoolLeaseResult,
  type WorktreePoolSettings,
  type WorktreePoolSnapshot,
} from '../../shared/ipc/worktree-pool'
import { comparablePath } from '../../shared/host-paths'
import { pathJoin } from '../../shared/paths'
import { slugifyWorktreeName, worktreeContainerPath } from '../../shared/worktree-paths'
import { seedWorktreeIncludedFiles } from '../git'
import { pathExists } from '../git-utils'
import { withWorktreeRegistryLock } from '../worktree-registry-lock'
import {
  defaultToolRunner,
  depsFingerprint,
  detectInstallPlan,
  INSTALL_TIMEOUT_MS,
  type DepsEnvironment,
  type ToolRunner,
} from './deps'
import {
  acquireInstanceLock,
  filesystemHostOf,
  heartbeatInstanceLock,
  normalizePoolSettings,
  POOL_RECORD_VERSION,
  poolIdFor,
  releaseInstanceLock,
  type InstanceLockDeps,
  type PoolRecord,
  type PoolStore,
  type SlotRecord,
} from './pool-store'
import {
  clearStaleIndexLock,
  commitIsReachable,
  defaultSlotGitRunner,
  fetchBase,
  hasFile,
  operationInProgress,
  readSlotGitDir,
  readSlotStatus,
  resolvePoolBaseRef,
  revParseCommit,
  usesLfs,
  type SlotGitRunner,
} from './slot-git'

/**
 * The pool of warm agent worktrees.
 *
 * Creating a worktree for an agent costs a checkout and, far more, an install:
 * a fresh tree has no dependencies, so the agent's first test run pays for
 * `npm ci` (seconds on a warm cache, minutes on a cold one or on Windows). The
 * pool keeps a few worktrees per repository checked out at `origin/<default>`
 * with their dependencies installed, and hands one to an agent in a few git
 * calls: a branch, a lock, done.
 *
 * ## Life of a slot
 *
 *   creating → refreshing → (installing) → warm → leasing → leased
 *   leased → returning → refreshing → … → warm        (clean return)
 *   leased → returning → held                          (work left in it)
 *   warm → evicting → gone                             (over target, disk, idle)
 *
 * A slot lives at `<repo-parent>/.sprintengine-worktrees/<repo>/pool-NN`, and
 * keeps that path for its whole life: virtual environments and build caches
 * record absolute paths and do not survive a move. A leased slot is on
 * `agent/<slug>` and `git worktree lock`ed, so git's own `prune` and `remove`
 * refuse it and every worktree view shows it as locked.
 *
 * ## What the pool never does
 *
 * - It never resets a tree that holds work. Every reset is preceded, in the
 *   same step, by a status read of the slot (untracked files included, ignored
 *   ones not); anything reported makes the slot `held`, and a held slot changes
 *   only when a person picks Commit, Stash, Discard or Keep.
 * - It never recycles a slot something runs in: a live terminal inside the slot
 *   postpones the return.
 * - It never deletes an agent's branch. Returning detaches HEAD; the branch and
 *   its commits stay. A detached HEAD holding commits no ref reaches is first
 *   given a branch of its own.
 * - It never recycles a slot mid-merge, mid-rebase or mid-cherry-pick.
 * - It never runs `clean -x`: ignored files (installed dependencies, build
 *   caches, a copied `.env`) are what makes a warm slot worth having.
 *
 * ## Concurrency
 *
 * Each pool has one mutex, held only across a state transition and its
 * persistence, never across a git step. A slot in a transitional state is not
 * leasable, so two leases never get one slot, and a lease never gets a slot
 * that is being refreshed or evicted. A second Studio is kept off the same
 * slots by a lock file in the container (pool-store.ts). The worktree registry
 * itself is changed under worktree-registry-lock.ts.
 *
 * ## Crash recovery
 *
 * A slot's `op` is persisted before each git step and cleared after it. At
 * start, a slot found with an `op` is finished or quarantined, per step (see
 * `recoverPool`), and a `pool-NN` worktree with no record is adopted as held,
 * never reset.
 */

export const POOL_MAX_SLOTS = 8
const UNCLAIMED_LEASE_MS = 15 * 60_000
const OWNER_MISSING_CONFIRM_MS = 20_000
const RETRY_DELAY_MS = 30_000
const FETCH_FRESH_MS = 60_000
const MAINTENANCE_INTERVAL_MS = 30 * 60_000
const SWEEP_INTERVAL_MS = 60_000
const HEARTBEAT_INTERVAL_MS = 5 * 60_000
const SIZE_STALE_MS = 6 * 60 * 60_000
const START_DELAY_MS = 60_000
const SLOT_NAME = /^pool-(\d{2,})$/u

/**
 * What the workspace registry holds right now: every agent and workspace id,
 * and every path a record points at (a workspace's folder, an agent's working
 * directory). A lease is in use while its owner exists OR any record still
 * points into its slot: a chat whose folder IS the slot keeps it, whoever
 * the lease names.
 */
export type OwnerIndex = { agents: ReadonlySet<string>; workspaces: ReadonlySet<string>; paths: readonly string[] }

/** The owner index for a list of registry workspaces (only the fields it reads). */
export function worktreePoolOwnerIndex(
  workspaces: ReadonlyArray<{
    id: string
    folderPath?: string | null
    agents?: Record<string, { execution?: { cwd?: string | null } | null } | undefined> | null
  }>,
): OwnerIndex {
  const agents = new Set<string>()
  const ids = new Set<string>()
  const paths: string[] = []
  for (const workspace of workspaces) {
    ids.add(workspace.id)
    if (workspace.folderPath) paths.push(workspace.folderPath)
    for (const [agentId, agent] of Object.entries(workspace.agents ?? {})) {
      agents.add(agentId)
      const cwd = agent?.execution?.cwd
      if (cwd) paths.push(cwd)
    }
  }
  return { agents, workspaces: ids, paths }
}

export type WorktreePoolServiceDeps = {
  store: PoolStore
  depsEnv: DepsEnvironment
  git?: SlotGitRunner
  toolRunner?: ToolRunner
  /** Working directories of live terminal sessions: a slot one sits in is never recycled. */
  livePaths?: () => string[]
  /** Every agent and workspace id in the registry, or null while it cannot be read. */
  ownerIndex?: () => OwnerIndex | null
  /** True while background work should wait: on battery, or asleep. */
  shouldDefer?: () => boolean
  onChange?: (snapshot: WorktreePoolSnapshot) => void
  log?: (line: string) => void
  now?: () => number
  instanceId?: string
  platform?: string
  arch?: string
  lockDeps?: InstanceLockDeps
  measureSize?: (path: string) => Promise<number | null>
  /** Start the background timers (sweeps, maintenance, heartbeat). Off in tests. */
  timers?: boolean
  /** How long one fetch of the base serves every slot that asks. */
  fetchFreshMs?: number
}

type PoolRuntime = {
  record: PoolRecord
  containerPath: string
  chain: Promise<unknown>
  busy: Set<string>
  instance: 'unknown' | 'held' | 'foreign'
  fetch: Promise<{ ref: string; sha: string } | null> | null
  warming: Promise<void> | null
  retry: NodeJS.Timeout | null
  /** Recovery, run once this instance holds the pool's container. */
  recovered: Promise<void> | null
  /** Slots whose return was postponed (something still ran in them). */
  pendingReturns: Set<string>
}

type ResolvedRepo = { repoRoot: string; commonDir: string }

function isInside(child: string, parent: string): boolean {
  const a = comparablePath(child)
  const b = comparablePath(parent)
  return a === b || a.startsWith(`${b}/`)
}

function tail(text: string | null | undefined, max = 600): string | null {
  const value = (text ?? '').trim()
  if (!value) return null
  return value.length > max ? `…${value.slice(-max)}` : value
}

async function defaultMeasureSize(path: string): Promise<number | null> {
  if (process.platform !== 'win32') {
    return new Promise((resolvePromise) => {
      execFile('du', ['-sk', path], { timeout: 120_000, windowsHide: true }, (error, stdout) => {
        const kb = Number.parseInt(String(stdout).trim().split(/\s+/u)[0] ?? '', 10)
        resolvePromise(!error && Number.isFinite(kb) ? kb * 1024 : null)
      })
    })
  }
  // No `du` on Windows: walk the tree, yielding between directories.
  let total = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 64) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile()) total += (await lstat(full).catch(() => null))?.size ?? 0
    }
  }
  await walk(path, 0)
  return total
}

export type WorktreePoolService = ReturnType<typeof createWorktreePoolService>

export function createWorktreePoolService(deps: WorktreePoolServiceDeps) {
  const git = deps.git ?? defaultSlotGitRunner
  const toolRunner = deps.toolRunner ?? defaultToolRunner
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.info(`[worktree-pool] ${line}`))
  const instanceId = deps.instanceId ?? randomUUID()
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const measureSize = deps.measureSize ?? defaultMeasureSize
  const fetchFreshMs = deps.fetchFreshMs ?? FETCH_FRESH_MS
  const pools = new Map<string, PoolRuntime>()
  const resolvedRepos = new Map<string, Promise<ResolvedRepo | null>>()
  const missingSince = new Map<string, number>()
  const installAbort = new AbortController()
  let settings: WorktreePoolSettings | null = null
  let loaded: Promise<void> | null = null
  let stopped = false
  let installChain: Promise<unknown> = Promise.resolve()
  const timers: NodeJS.Timeout[] = []
  let sweepTimer: NodeJS.Timeout | null = null

  // ── Plumbing ──────────────────────────────────────────────────────────────

  function withPool<T>(pool: PoolRuntime, work: () => Promise<T> | T): Promise<T> {
    const run = pool.chain.catch(() => {}).then(work)
    pool.chain = run.catch(() => {})
    return run
  }

  async function persist(pool: PoolRuntime): Promise<void> {
    await deps.store.write(pool.record)
    deps.onChange?.(snapshotOf(pool))
  }

  function slotById(pool: PoolRuntime, slotId: string): SlotRecord | undefined {
    return pool.record.slots.find((slot) => slot.id === slotId)
  }

  function somethingRunsIn(path: string): boolean {
    return (deps.livePaths?.() ?? []).some((live) => live && isInside(live, path))
  }

  async function getSettings(): Promise<WorktreePoolSettings> {
    settings ??= await deps.store.readSettings()
    return settings
  }

  async function resolveRepo(repoRoot: string): Promise<ResolvedRepo | null> {
    const key = comparablePath(repoRoot)
    let pending = resolvedRepos.get(key)
    if (!pending) {
      pending = (async () => {
        const result = await git(repoRoot, [
          'rev-parse',
          '--path-format=absolute',
          '--show-toplevel',
          '--git-common-dir',
        ])
        if (!result.ok) return null
        const [toplevel, common] = result.stdout.split(/\r?\n/u).map((line) => line.trim())
        if (!toplevel || !common) return null
        const commonDir = isAbsolute(common) ? common : resolve(toplevel, common)
        // The main checkout is the one whose `.git` IS the common dir. A bare
        // repository has no main checkout to hang a container off.
        if (basename(commonDir) !== '.git') return null
        return { repoRoot: dirname(commonDir), commonDir }
      })()
      resolvedRepos.set(key, pending)
      void pending.then((value) => {
        if (!value) resolvedRepos.delete(key)
      })
    }
    return pending
  }

  function runtimeFor(record: PoolRecord): PoolRuntime {
    let pool = pools.get(record.poolId)
    if (!pool) {
      pool = {
        record,
        containerPath: worktreeContainerPath(record.repoRoot),
        chain: Promise.resolve(),
        busy: new Set(),
        instance: 'unknown',
        fetch: null,
        warming: null,
        retry: null,
        recovered: null,
        pendingReturns: new Set(),
      }
      pools.set(record.poolId, pool)
    }
    return pool
  }

  async function poolFor(repoRoot: string, create: boolean): Promise<PoolRuntime | null> {
    await load()
    const repo = await resolveRepo(repoRoot)
    if (!repo) return null
    const fsHost = filesystemHostOf(repo.repoRoot)
    const poolId = poolIdFor(repo.commonDir, fsHost, platform)
    const existing = pools.get(poolId)
    if (existing) return existing
    if (!create) return null
    const record: PoolRecord = {
      version: POOL_RECORD_VERSION,
      poolId,
      repoRoot: repo.repoRoot,
      commonDir: repo.commonDir,
      fsHost,
      platform,
      disabled: false,
      defaultRef: null,
      lastFetchAt: null,
      lastLeaseAt: null,
      createdAt: now(),
      slots: [],
      releasedPaths: [],
    }
    const pool = runtimeFor(record)
    await persist(pool)
    return pool
  }

  async function holdInstance(pool: PoolRuntime): Promise<boolean> {
    if (pool.instance === 'held') return true
    const result = await acquireInstanceLock(pool.containerPath, instanceId, deps.lockDeps).catch(() => ({
      ok: false as const,
      holder: 'unreadable lock',
    }))
    pool.instance = result.ok ? 'held' : 'foreign'
    if (!result.ok) log(`${pool.record.repoRoot}: pool held by another Studio (${result.holder})`)
    return result.ok
  }

  /**
   * Whether this instance may drive the pool: it holds the container's lock,
   * and the pool has been recovered. Recovery runs only under the lock — a
   * second Studio must never "recover" slots the first one is using.
   */
  async function ready(pool: PoolRuntime): Promise<boolean> {
    if (!(await holdInstance(pool))) return false
    pool.recovered ??= recoverPool(pool).catch((error: unknown) =>
      log(`${pool.record.repoRoot}: recovery failed: ${error instanceof Error ? error.message : String(error)}`),
    )
    await pool.recovered
    return true
  }

  function scheduleRetry(pool: PoolRuntime, delayMs = RETRY_DELAY_MS): void {
    if (stopped || pool.retry) return
    pool.retry = setTimeout(() => {
      pool.retry = null
      void tend(pool)
    }, delayMs)
    pool.retry.unref?.()
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  function snapshotOf(pool: PoolRuntime): WorktreePoolSnapshot {
    const record = pool.record
    return {
      poolId: record.poolId,
      repoRoot: record.repoRoot,
      containerPath: pool.containerPath,
      fsHost: record.fsHost,
      platform: record.platform,
      disabled: record.disabled,
      heldByOtherInstance: pool.instance === 'foreign',
      defaultRef: record.defaultRef,
      lastFetchAt: record.lastFetchAt,
      lastLeaseAt: record.lastLeaseAt,
      slots: record.slots.map((slot) => ({
        id: slot.id,
        path: slot.path,
        state: slot.state,
        baseRef: slot.baseRef,
        baseSha: slot.baseSha,
        refreshedAt: slot.refreshedAt,
        depsState: slot.depsState,
        installCommand: slot.installCommand,
        error: slot.error,
        lease: slot.lease
          ? {
              leaseId: slot.lease.leaseId,
              branch: slot.lease.branch,
              owner: { ...slot.lease.owner },
              leasedAt: slot.lease.leasedAt,
            }
          : null,
        held: slot.held ? { ...slot.held } : null,
        sizeBytes: slot.sizeBytes,
        lastUsedAt: slot.lastUsedAt,
      })),
    }
  }

  // ── Holding a slot ────────────────────────────────────────────────────────

  /**
   * Park a slot for a person to decide. The slot is (re)locked with the reason,
   * so the Worktree manager, the Git pane and git itself all see it is not to
   * be touched, and the agent worktree cleanup skips it.
   */
  async function hold(
    pool: PoolRuntime,
    slot: SlotRecord,
    reason: WorktreePoolHeldReason,
    detail: string | null,
    extra: { changedPaths?: number | null; branch?: string | null } = {},
  ): Promise<void> {
    const branch = extra.branch ?? slot.lease?.branch ?? slot.held?.branch ?? null
    await git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
    await git(pool.record.repoRoot, ['worktree', 'lock', '--reason', `held: ${reason}`, slot.path])
    await withPool(pool, async () => {
      slot.state = 'held'
      slot.held = { reason, detail, changedPaths: extra.changedPaths ?? null, branch, since: now() }
      slot.lease = null
      slot.op = null
      if (reason === 'error' || reason === 'recovery') slot.error = detail
      await persist(pool)
    })
    log(`${slot.path}: held (${reason}${detail ? `: ${detail}` : ''})`)
  }

  // ── Fetching the base ────────────────────────────────────────────────────

  /**
   * The commit warm slots sit at: `origin/<default>` after at most one fetch per
   * pool per minute, shared by every slot that asks meanwhile. A failed fetch
   * (offline, no credentials) falls back to what `origin/<default>` already
   * says, which is still a fine base.
   */
  function ensureBase(pool: PoolRuntime, force = false): Promise<{ ref: string; sha: string } | null> {
    if (pool.fetch) return pool.fetch
    const run = (async () => {
      const record = pool.record
      const ref = record.defaultRef ?? (await resolvePoolBaseRef(git, record.repoRoot))
      if (!ref) return null
      if (ref.includes('/') && (force || !record.lastFetchAt || now() - record.lastFetchAt >= fetchFreshMs)) {
        const fetched = await fetchBase(git, record.repoRoot, ref)
        if (!fetched.ok)
          log(`${record.repoRoot}: fetch of ${ref} failed (${tail(fetched.message, 200)}); using the ref as it is`)
        await withPool(pool, async () => {
          record.lastFetchAt = now()
          record.defaultRef = ref
          await persist(pool)
        })
      } else if (record.defaultRef !== ref) {
        await withPool(pool, async () => {
          record.defaultRef = ref
          await persist(pool)
        })
      }
      const sha = await revParseCommit(git, record.repoRoot, ref)
      return sha ? { ref, sha } : null
    })()
    pool.fetch = run
    void run.finally(() => {
      if (pool.fetch === run) pool.fetch = null
    })
    return run
  }

  // ── Leasing ──────────────────────────────────────────────────────────────

  async function lease(input: WorktreePoolLeaseInput): Promise<WorktreePoolLeaseResult> {
    const started = now()
    if (stopped) return { ok: false, reason: 'disabled', message: 'The worktree pool is shutting down.' }
    if (input.runtime !== 'native') {
      return { ok: false, reason: 'unsupported', message: 'Agents running in WSL do not lease pooled worktrees yet.' }
    }
    const current = await getSettings()
    if (!current.enabled) return { ok: false, reason: 'disabled', message: 'The worktree pool is turned off.' }
    const slug = slugifyWorktreeName(input.name)
    if (!slug)
      return { ok: false, reason: 'error', message: `"${input.name}" does not reduce to a usable branch name.` }
    const repo = await resolveRepo(input.repoRoot)
    if (!repo) return { ok: false, reason: 'not-a-repo', message: 'Not a git repository with a main checkout.' }
    if (filesystemHostOf(repo.repoRoot) !== 'local') {
      return {
        ok: false,
        reason: 'unsupported',
        message: 'Repositories on a WSL or network filesystem do not have a worktree pool yet.',
      }
    }
    const pool = await poolFor(repo.repoRoot, true)
    if (!pool) return { ok: false, reason: 'not-a-repo', message: 'Not a git repository.' }
    if (!(await ready(pool))) {
      return { ok: false, reason: 'other-instance', message: 'Another Studio is using this repository’s pool.' }
    }
    if (pool.record.disabled) return { ok: false, reason: 'disabled', message: 'The pool is off for this repository.' }
    // Asked for, so the pool is wanted: an idle pool wakes up here.
    await withPool(pool, async () => {
      pool.record.lastLeaseAt = now()
      await persist(pool)
    })

    const branch = `agent/${slug}`
    const ownerLabel = input.owner.agentId ?? input.owner.workspaceId ?? 'pending'
    for (let attempt = 0; attempt < POOL_MAX_SLOTS; attempt += 1) {
      const slot = await withPool(pool, async () => {
        const candidates = pool.record.slots
          .filter((candidate) => candidate.state === 'warm' && !pool.busy.has(candidate.id))
          .sort(
            (a, b) =>
              Number(a.depsState === 'failed') - Number(b.depsState === 'failed') ||
              (b.refreshedAt ?? 0) - (a.refreshedAt ?? 0),
          )
        const picked = candidates[0]
        if (!picked) return null
        picked.state = 'leasing'
        picked.op = { kind: 'lease', startedAt: now(), pid: process.pid }
        pool.busy.add(picked.id)
        await persist(pool)
        return picked
      })
      if (!slot) {
        void tend(pool)
        return { ok: false, reason: 'no-warm-slot', message: 'No warm worktree is ready yet.' }
      }
      try {
        // The slot was checked at refresh; it is checked again now, because
        // anyone can open a terminal in a warm slot between the two.
        const status = await readSlotStatus(git, slot.path)
        if (!status.ok) {
          await hold(pool, slot, 'error', `status failed: ${status.message}`)
          continue
        }
        if (status.status.changedPaths > 0) {
          await hold(pool, slot, 'dirty', 'changes appeared in an idle slot', {
            changedPaths: status.status.changedPaths,
            branch: status.status.branch,
          })
          continue
        }
        if (status.status.branch !== null || (slot.baseSha && status.status.oid !== slot.baseSha)) {
          await hold(pool, slot, 'unexpected-head', 'an idle slot moved off its base', {
            branch: status.status.branch,
          })
          continue
        }
        // Locked BEFORE the branch exists: from the moment the slot is on an
        // `agent/` branch, nothing else may remove it.
        const locked = await git(pool.record.repoRoot, [
          'worktree',
          'lock',
          '--reason',
          `leased: ${ownerLabel}`,
          slot.path,
        ])
        if (!locked.ok) log(`${slot.path}: could not lock (${tail(locked.message, 200)}); leasing anyway`)
        const switched = await git(slot.path, ['switch', '--quiet', '-c', branch])
        if (!switched.ok) {
          await git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
          await withPool(pool, async () => {
            slot.state = 'warm'
            slot.op = null
            await persist(pool)
          })
          return { ok: false, reason: 'error', message: switched.message ?? `Could not create ${branch}.` }
        }
        const leaseId = randomUUID()
        await withPool(pool, async () => {
          slot.state = 'leased'
          slot.op = null
          slot.held = null
          slot.lease = { leaseId, branch, owner: { ...input.owner }, leasedAt: now(), ownerSeen: false }
          slot.lastUsedAt = now()
          await persist(pool)
        })
        log(`${slot.path}: leased to ${ownerLabel} on ${branch}`)
        // Replace what was taken, and catch the base up if origin moved.
        void tend(pool)
        return {
          ok: true,
          leaseId,
          slotId: slot.id,
          path: slot.path,
          branch,
          baseRef: slot.baseRef,
          depsState: slot.depsState,
          installCommand: slot.installCommand,
          elapsedMs: now() - started,
        }
      } catch (error) {
        await hold(pool, slot, 'error', error instanceof Error ? error.message : String(error))
      } finally {
        pool.busy.delete(slot.id)
      }
    }
    return { ok: false, reason: 'no-warm-slot', message: 'No warm worktree passed its checks.' }
  }

  function findLease(leaseId: string): { pool: PoolRuntime; slot: SlotRecord } | null {
    for (const pool of pools.values()) {
      const slot = pool.record.slots.find((candidate) => candidate.lease?.leaseId === leaseId)
      if (slot) return { pool, slot }
    }
    return null
  }

  /** Name the owner of a lease taken before its owner existed (an MCP launch, a new chat). */
  async function bind(leaseId: string, owner: WorktreePoolLeaseOwner): Promise<boolean> {
    const found = findLease(leaseId)
    if (!found) return false
    await withPool(found.pool, async () => {
      if (!found.slot.lease) return
      found.slot.lease.owner = {
        agentId: owner.agentId ?? found.slot.lease.owner.agentId,
        workspaceId: owner.workspaceId ?? found.slot.lease.owner.workspaceId,
      }
      found.slot.lease.ownerSeen = false
      await persist(found.pool)
    })
    return true
  }

  // ── Returning ────────────────────────────────────────────────────────────

  /**
   * Take a slot back from its owner (or re-check a held one). Clean: detached,
   * unlocked, refreshed, warm again. Anything else: held. See the file comment
   * for what "anything else" covers.
   */
  async function returnSlot(pool: PoolRuntime, slot: SlotRecord, recovering = false): Promise<void> {
    const began = await withPool(pool, async () => {
      if (pool.busy.has(slot.id)) return null
      const from = slot.state
      if (!(from === 'leased' || from === 'held' || from === 'returning' || (recovering && from === 'leasing'))) {
        return null
      }
      pool.busy.add(slot.id)
      slot.state = 'returning'
      slot.op = { kind: 'return', startedAt: now(), pid: process.pid }
      await persist(pool)
      return { from, lease: slot.lease, held: slot.held }
    })
    if (!began) return
    const restore = async (): Promise<void> => {
      pool.pendingReturns.add(slot.id)
      await withPool(pool, async () => {
        slot.state = began.from === 'leasing' ? 'returning' : began.from
        slot.op = null
        await persist(pool)
      })
    }
    const branch = began.lease?.branch ?? began.held?.branch ?? null
    pool.pendingReturns.delete(slot.id)
    try {
      if (somethingRunsIn(slot.path)) {
        // The agent's terminal (or anyone's) is still in there. Try later.
        await restore()
        scheduleRetry(pool)
        return
      }
      const gitDir = await readSlotGitDir(git, slot.path)
      if (!gitDir) {
        await hold(pool, slot, 'error', 'the slot is no longer a git worktree', { branch })
        return
      }
      const operation = await operationInProgress(gitDir)
      if (operation) {
        await hold(pool, slot, 'operation', `a ${operation} is in progress`, { branch })
        return
      }
      const lockVerdict = await clearStaleIndexLock(gitDir, true, now())
      if (lockVerdict === 'busy') {
        await restore()
        scheduleRetry(pool)
        return
      }
      const status = await readSlotStatus(git, slot.path)
      if (!status.ok) {
        await hold(pool, slot, 'error', `status failed: ${status.message}`, { branch })
        return
      }
      if (status.status.changedPaths > 0) {
        await hold(pool, slot, 'dirty', null, {
          changedPaths: status.status.changedPaths,
          branch: status.status.branch ?? branch,
        })
        return
      }
      const oid = status.status.oid
      // Detaching is free when HEAD is on a branch (the branch keeps it) or at
      // a commit some ref already reaches. A detached HEAD with commits of its
      // own gets a branch first, or those commits would be reachable only
      // from the reflog once the slot is reset.
      if (status.status.branch === null && oid && oid !== slot.baseSha) {
        if (!(await commitIsReachable(git, slot.path, oid))) {
          const rescue = `${branch ?? `agent/${slot.id}`}-rescued-${oid.slice(0, 7)}`
          const created = await git(slot.path, ['branch', rescue, oid])
          if (!created.ok) {
            await hold(pool, slot, 'error', `could not keep detached commits: ${tail(created.message, 200)}`, {
              branch,
            })
            return
          }
          log(`${slot.path}: kept detached commit ${oid.slice(0, 7)} on ${rescue}`)
        }
      }
      if (status.status.branch !== null) {
        const detached = await git(slot.path, ['switch', '--quiet', '--detach'])
        if (!detached.ok) {
          await hold(pool, slot, 'error', `could not detach: ${tail(detached.message, 200)}`, { branch })
          return
        }
      }
      await git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
      await withPool(pool, async () => {
        slot.state = 'refreshing'
        slot.lease = null
        slot.held = null
        slot.op = null
        slot.error = null
        slot.lastUsedAt = now()
        await persist(pool)
      })
      log(`${slot.path}: returned clean${branch ? ` (${branch} kept)` : ''}`)
    } catch (error) {
      await hold(pool, slot, 'error', error instanceof Error ? error.message : String(error), { branch })
      return
    } finally {
      pool.busy.delete(slot.id)
    }
    void tend(pool)
  }

  // ── Refreshing ───────────────────────────────────────────────────────────

  /**
   * Move a clean, detached slot to the pool's base and make its dependencies
   * match. The reset is the one destructive step in the pool, so it is fenced
   * three ways: the slot must read clean and detached immediately before it;
   * HEAD is moved with a compare-and-swap against the commit that read saw
   * (`update-ref <new> <old>`), so anything that moved HEAD in between makes it
   * fail; and only then are the index and tree brought along
   * (`read-tree --reset -u`) and the untracked leftovers of the old tree
   * removed (`clean -fd`, never `-x`).
   */
  async function refreshSlot(pool: PoolRuntime, slot: SlotRecord, options: { forceInstall?: boolean } = {}) {
    const began = await withPool(pool, async () => {
      if (pool.busy.has(slot.id)) return false
      if (!(slot.state === 'refreshing' || slot.state === 'warm' || slot.state === 'creating')) return false
      pool.busy.add(slot.id)
      slot.state = 'refreshing'
      await persist(pool)
      return true
    })
    if (!began) return
    try {
      const base = await ensureBase(pool)
      if (!base) {
        await withPool(pool, async () => {
          slot.error = 'No default branch to refresh to.'
          slot.state = slot.baseSha ? 'warm' : 'refreshing'
          await persist(pool)
        })
        if (!slot.baseSha) scheduleRetry(pool, 5 * 60_000)
        return
      }
      if (somethingRunsIn(slot.path)) {
        scheduleRetry(pool)
        return
      }
      const gitDir = await readSlotGitDir(git, slot.path)
      if (!gitDir) {
        await hold(pool, slot, 'error', 'the slot is no longer a git worktree')
        return
      }
      // Only recovery leaves a slot in `refreshing` with a refresh op still on
      // it: this function clears its own op on every way out. Then the
      // `index.lock` in the slot is the dead run's own, whatever its age.
      const recoveringOwnReset = slot.op?.kind === 'refresh'
      if ((await clearStaleIndexLock(gitDir, true, now(), recoveringOwnReset)) === 'busy') {
        scheduleRetry(pool, 2 * 60_000)
        return
      }
      const status = await readSlotStatus(git, slot.path)
      if (!status.ok) {
        await hold(pool, slot, 'error', `status failed: ${status.message}`)
        return
      }
      const { oid, branch, changedPaths } = status.status
      if (branch !== null) {
        await hold(pool, slot, 'unexpected-head', `an idle slot is on ${branch}`, { branch })
        return
      }
      // A refresh the previous run of the app started and did not finish
      // leaves the tree half-moved, which reads as dirty. That dirt is the
      // pool's own, and only then, with HEAD at one end of that very reset, is
      // the reset re-run over it.
      const resuming =
        recoveringOwnReset && slot.op?.toSha && oid !== null && (oid === slot.op.toSha || oid === slot.op.fromSha)
      if (changedPaths > 0 && !resuming) {
        await hold(pool, slot, 'dirty', 'changes appeared in an idle slot', { changedPaths })
        return
      }
      const target = resuming && slot.op?.toSha ? slot.op.toSha : base.sha
      if (oid !== target || resuming) {
        await withPool(pool, async () => {
          slot.op = { kind: 'refresh', startedAt: now(), pid: process.pid, fromSha: oid, toSha: target }
          await persist(pool)
        })
        if (oid !== target) {
          const moved = await git(slot.path, [
            'update-ref',
            '--no-deref',
            '-m',
            'worktree pool: refresh',
            'HEAD',
            target,
            oid ?? '',
          ])
          if (!moved.ok) {
            await hold(pool, slot, 'unexpected-head', `HEAD moved during refresh: ${tail(moved.message, 200)}`)
            return
          }
        }
        const reset = await git(slot.path, ['read-tree', '--reset', '-u', 'HEAD'])
        if (!reset.ok) {
          await hold(pool, slot, 'error', `reset failed: ${tail(reset.message, 200)}`)
          return
        }
        const cleaned = await git(slot.path, ['clean', '-fd', '--quiet'])
        if (!cleaned.ok) {
          await hold(pool, slot, 'error', `clean failed: ${tail(cleaned.message, 200)}`)
          return
        }
      }
      const notes: string[] = []
      if (await hasFile(slot.path, '.gitmodules')) {
        const modules = await git(slot.path, ['submodule', 'update', '--init', '--recursive'])
        if (!modules.ok) notes.push(`submodules: ${tail(modules.message, 200)}`)
      }
      if (await usesLfs(slot.path)) {
        const lfs = await git(slot.path, ['lfs', 'pull'])
        if (!lfs.ok) notes.push(`lfs: ${tail(lfs.message, 200)}`)
      }
      // `.worktreeinclude` names ignored files (an `.env`) the tree needs; they
      // survive the reset, but the checkout's copy may have changed since.
      await seedWorktreeIncludedFiles(pool.record.repoRoot, slot.path).catch(() => null)
      await withPool(pool, async () => {
        slot.baseRef = base.ref
        slot.baseSha = target
        slot.refreshedAt = now()
        slot.op = null
        slot.error = notes.length ? notes.join('; ') : null
        await persist(pool)
      })
      await installIfNeeded(pool, slot, options.forceInstall === true)
    } catch (error) {
      await hold(pool, slot, 'error', error instanceof Error ? error.message : String(error))
    } finally {
      pool.busy.delete(slot.id)
    }
  }

  /** One install at a time across every pool: they are CPU- and disk-heavy, and nobody is waiting. */
  function serialInstall<T>(work: () => Promise<T>): Promise<T> {
    const run = installChain.catch(() => {}).then(work)
    installChain = run.catch(() => {})
    return run
  }

  async function installIfNeeded(pool: PoolRuntime, slot: SlotRecord, force: boolean): Promise<void> {
    const detected = await detectInstallPlan(slot.path)
    if (!detected) {
      await withPool(pool, async () => {
        slot.depsState = 'none'
        slot.installCommand = null
        slot.depsFingerprint = null
        slot.state = 'warm'
        await persist(pool)
      })
      return
    }
    const [managerVersion, nodeVersion] = await Promise.all([
      deps.depsEnv.version(detected.plan.versionOf),
      deps.depsEnv.version('node'),
    ])
    const fingerprint = depsFingerprint({
      lockfile: detected.lockfile,
      plan: detected.plan,
      managerVersion,
      nodeVersion,
      platform,
      arch,
    })
    // Already installed for exactly this — or already failed for exactly this,
    // which an unattended retry would only repeat. A person's Refresh forces it.
    const upToDate =
      slot.depsFingerprint === fingerprint && (slot.depsState === 'ok' || (slot.depsState === 'failed' && !force))
    if (upToDate) {
      await withPool(pool, async () => {
        slot.installCommand = detected.plan.display
        slot.state = 'warm'
        await persist(pool)
      })
      return
    }
    await withPool(pool, async () => {
      slot.state = 'installing'
      slot.depsState = 'installing'
      slot.installCommand = detected.plan.display
      slot.op = { kind: 'install', startedAt: now(), pid: process.pid }
      await persist(pool)
    })
    const result = await serialInstall(async () => {
      if (stopped) return { code: null, output: 'The app quit before the install ran.', timedOut: false }
      log(`${slot.path}: ${detected.plan.display}`)
      return toolRunner({
        command: detected.plan.command,
        args: detected.plan.args,
        cwd: slot.path,
        env: await deps.depsEnv.env(),
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal: installAbort.signal,
      })
    })
    if (stopped) return // `op: install` stays on disk, so the next start runs it again.
    const ok = result.code === 0 && !result.timedOut
    await withPool(pool, async () => {
      slot.depsState = ok ? 'ok' : 'failed'
      slot.depsFingerprint = fingerprint
      slot.error = ok
        ? slot.error
        : (tail(result.timedOut ? `timed out. ${result.output}` : result.output) ?? 'The install failed.')
      slot.state = 'warm'
      slot.op = null
      await persist(pool)
    })
    log(`${slot.path}: ${detected.plan.display} ${ok ? 'finished' : 'failed'}`)
    void measure(pool, slot)
  }

  // ── Creating and evicting ───────────────────────────────────────────────

  async function nextSlotPath(pool: PoolRuntime): Promise<{ id: string; path: string } | null> {
    const taken = new Set(pool.record.slots.map((slot) => slot.id))
    const released = new Set(pool.record.releasedPaths.map(comparablePath))
    for (let n = 1; n < 100; n += 1) {
      const id = `pool-${String(n).padStart(2, '0')}`
      // Joined in the container's own spelling (git's, forward slashes even on
      // Windows), so the slot's path compares equal to what `worktree list` says.
      const path = pathJoin(pool.containerPath, id)
      if (taken.has(id) || released.has(comparablePath(path))) continue
      if (await pathExists(path)) continue
      return { id, path }
    }
    return null
  }

  async function createSlot(pool: PoolRuntime): Promise<boolean> {
    const base = await ensureBase(pool)
    if (!base) return false
    const target = await nextSlotPath(pool)
    if (!target) return false
    const slot = await withPool(pool, async () => {
      if (pool.record.slots.length >= POOL_MAX_SLOTS) return null
      if (pool.record.slots.some((existing) => existing.id === target.id)) return null
      const created: SlotRecord = {
        id: target.id,
        path: target.path,
        state: 'creating',
        baseRef: base.ref,
        baseSha: base.sha,
        refreshedAt: null,
        depsFingerprint: null,
        depsState: 'stale',
        installCommand: null,
        error: null,
        lease: null,
        held: null,
        sizeBytes: null,
        sizeMeasuredAt: null,
        lastUsedAt: null,
        createdAt: now(),
        op: { kind: 'create', startedAt: now(), pid: process.pid },
      }
      pool.record.slots.push(created)
      pool.busy.add(created.id)
      await persist(pool)
      return created
    })
    if (!slot) return false
    let added = false
    try {
      const result = await withWorktreeRegistryLock(pool.record.repoRoot, () =>
        git(pool.record.repoRoot, ['worktree', 'add', '--quiet', '--detach', slot.path, base.sha]),
      )
      if (!result.ok) {
        log(`${slot.path}: worktree add failed (${tail(result.message, 300)})`)
        await withPool(pool, async () => {
          pool.record.slots = pool.record.slots.filter((candidate) => candidate !== slot)
          await persist(pool)
        })
        return false
      }
      added = true
      await withPool(pool, async () => {
        slot.state = 'refreshing'
        slot.op = null
        await persist(pool)
      })
    } finally {
      pool.busy.delete(slot.id)
    }
    if (added) await refreshSlot(pool, slot)
    return added
  }

  async function evictSlot(pool: PoolRuntime, slot: SlotRecord, why: string): Promise<boolean> {
    const began = await withPool(pool, async () => {
      if (pool.busy.has(slot.id) || (slot.state !== 'warm' && slot.state !== 'evicting')) return false
      pool.busy.add(slot.id)
      slot.state = 'evicting'
      slot.op = { kind: 'evict', startedAt: now(), pid: process.pid }
      await persist(pool)
      return true
    })
    if (!began) return false
    try {
      if (somethingRunsIn(slot.path)) {
        await withPool(pool, async () => {
          slot.state = 'warm'
          slot.op = null
          await persist(pool)
        })
        return false
      }
      if (await pathExists(slot.path)) {
        const status = await readSlotStatus(git, slot.path)
        if (!status.ok || status.status.changedPaths > 0 || status.status.branch !== null) {
          await hold(
            pool,
            slot,
            status.ok && status.status.changedPaths > 0 ? 'dirty' : 'unexpected-head',
            'found while evicting',
            status.ok ? { changedPaths: status.status.changedPaths, branch: status.status.branch } : {},
          )
          return false
        }
        // No --force: git checks cleanliness again at the moment of removal.
        // Only a tree with submodules, which plain `remove` always refuses,
        // is forced — and only after the status above read it clean.
        let removed = await withWorktreeRegistryLock(pool.record.repoRoot, () =>
          git(pool.record.repoRoot, ['worktree', 'remove', slot.path]),
        )
        if (!removed.ok && /submodule/iu.test(removed.message ?? '')) {
          removed = await withWorktreeRegistryLock(pool.record.repoRoot, () =>
            git(pool.record.repoRoot, ['worktree', 'remove', '--force', slot.path]),
          )
        }
        if (!removed.ok) {
          await hold(pool, slot, 'error', `could not remove: ${tail(removed.message, 200)}`)
          return false
        }
      } else {
        await withWorktreeRegistryLock(pool.record.repoRoot, () => git(pool.record.repoRoot, ['worktree', 'prune']))
      }
      await withPool(pool, async () => {
        pool.record.slots = pool.record.slots.filter((candidate) => candidate !== slot)
        await persist(pool)
      })
      log(`${slot.path}: evicted (${why})`)
      return true
    } finally {
      pool.busy.delete(slot.id)
    }
  }

  async function measure(pool: PoolRuntime, slot: SlotRecord): Promise<void> {
    if (slot.sizeMeasuredAt && now() - slot.sizeMeasuredAt < SIZE_STALE_MS && slot.op === null) return
    const size = await measureSize(slot.path).catch(() => null)
    await withPool(pool, async () => {
      if (!pool.record.slots.includes(slot)) return
      slot.sizeBytes = size
      slot.sizeMeasuredAt = now()
      await persist(pool)
    })
  }

  // ── Keeping a pool at its target ─────────────────────────────────────────

  function isDormant(pool: PoolRuntime, current: WorktreePoolSettings): boolean {
    const last = pool.record.lastLeaseAt ?? pool.record.createdAt
    return now() - last > current.idleEvictionDays * 24 * 60 * 60_000
  }

  function totalBytes(): number {
    let total = 0
    for (const pool of pools.values()) for (const slot of pool.record.slots) total += slot.sizeBytes ?? 0
    return total
  }

  const WARMISH = new Set(['warm', 'refreshing', 'installing', 'creating'])

  /**
   * Do whatever the pool needs next: resume slots that were interrupted,
   * refresh the ones that came back, evict what is over target, over the disk
   * cap or idle, and create slots up to the warm target. One at a time per
   * pool; a second call while one runs joins it.
   */
  function tend(pool: PoolRuntime): Promise<void> {
    if (pool.warming) return pool.warming
    const run = (async () => {
      if (stopped) return
      if (!(await ready(pool))) return
      const current = await getSettings()
      // Returns that were interrupted, or postponed because a terminal was
      // still inside, try again.
      for (const slot of pool.record.slots.filter(
        (candidate) => candidate.state === 'returning' || pool.pendingReturns.has(candidate.id),
      )) {
        await returnSlot(pool, slot, true)
      }
      for (const slot of pool.record.slots.filter((candidate) => candidate.state === 'refreshing')) {
        await refreshSlot(pool, slot)
      }
      for (const slot of pool.record.slots.filter((candidate) => candidate.state === 'evicting')) {
        await evictSlot(pool, slot, 'resumed')
      }
      const off = !current.enabled || pool.record.disabled
      const dormant = isDormant(pool, current)
      const warm = () =>
        pool.record.slots
          .filter((slot) => slot.state === 'warm' && !pool.busy.has(slot.id))
          .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))
      const target = off || dormant ? 0 : current.warmTarget
      // Over target (or off, or idle for days): the least recently used go.
      let warmish = pool.record.slots.filter((slot) => WARMISH.has(slot.state)).length
      for (const slot of warm()) {
        if (warmish <= target) break
        if (await evictSlot(pool, slot, off ? 'pool off' : dormant ? 'idle' : 'over warm target')) warmish -= 1
      }
      // Over the disk cap: warm slots go, least recently used first, even
      // below target. Leased and held slots are never touched.
      const capBytes = current.diskCapGb * 1024 ** 3
      for (const slot of warm()) {
        if (totalBytes() <= capBytes) break
        await evictSlot(pool, slot, 'over disk cap')
      }
      warmish = pool.record.slots.filter((slot) => WARMISH.has(slot.state)).length
      while (!stopped && warmish < target && pool.record.slots.length < POOL_MAX_SLOTS && totalBytes() <= capBytes) {
        if (!(await createSlot(pool))) break
        warmish += 1
      }
      // A base that moved since the warm slots were refreshed: bring them along.
      if (!off && !dormant) {
        const base = await ensureBase(pool)
        if (base) {
          for (const slot of warm()) {
            if (slot.baseSha !== base.sha) await refreshSlot(pool, slot)
          }
        }
      }
      for (const slot of pool.record.slots) {
        if (slot.state === 'warm' || slot.state === 'held') void measure(pool, slot)
      }
    })()
      .catch((error: unknown) =>
        log(`${pool.record.repoRoot}: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        if (pool.warming === run) pool.warming = null
      })
    pool.warming = run
    return run
  }

  // ── Owners ───────────────────────────────────────────────────────────────

  /**
   * Return every lease whose owner is gone from the workspace registry. An
   * owner must be missing on two sweeps at least {@link OWNER_MISSING_CONFIRM_MS}
   * apart, so one odd read of the registry never recycles a live agent's slot;
   * and a lease whose owner was never seen is left alone for
   * {@link UNCLAIMED_LEASE_MS}, the time a launch has to record its agent.
   */
  async function sweepOwners(): Promise<void> {
    const index = deps.ownerIndex?.()
    if (!index) return
    for (const pool of pools.values()) {
      if (pool.instance !== 'held' || !pool.recovered) continue
      await pool.recovered
      for (const slot of pool.record.slots) {
        if (slot.state !== 'leased' || !slot.lease) continue
        const leaseKey = slot.lease.leaseId
        const { agentId, workspaceId } = slot.lease.owner
        const ownerPresent = agentId
          ? index.agents.has(agentId)
          : workspaceId
            ? index.workspaces.has(workspaceId)
            : false
        const present = ownerPresent || index.paths.some((path) => path && isInside(path, slot.path))
        if (present) {
          missingSince.delete(leaseKey)
          if (!slot.lease.ownerSeen) {
            await withPool(pool, async () => {
              if (slot.lease) slot.lease.ownerSeen = true
              await persist(pool)
            })
          }
          continue
        }
        if (!slot.lease.ownerSeen && now() - slot.lease.leasedAt < UNCLAIMED_LEASE_MS) continue
        const first = missingSince.get(leaseKey)
        if (first === undefined) {
          missingSince.set(leaseKey, now())
          continue
        }
        if (now() - first < OWNER_MISSING_CONFIRM_MS) continue
        missingSince.delete(leaseKey)
        log(`${slot.path}: owner ${agentId ?? workspaceId ?? 'unknown'} is gone; returning`)
        void returnSlot(pool, slot)
      }
    }
  }

  function noteRegistryChanged(): void {
    if (stopped || sweepTimer) return
    sweepTimer = setTimeout(() => {
      sweepTimer = null
      void sweepOwners()
      // A second look after the confirmation window, so a removal is acted on
      // without waiting for the periodic sweep.
      const again = setTimeout(() => void sweepOwners(), OWNER_MISSING_CONFIRM_MS + 1_000)
      again.unref?.()
    }, 2_000)
    sweepTimer.unref?.()
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  /**
   * Put a pool loaded from disk back into a state the service can drive. The
   * rule for each interrupted step is the least destructive one that finishes
   * it: a return or a lease is redone as a return (which only ever detaches a
   * clean tree), a refresh is resumed only over its own half-done reset, and
   * anything the pool cannot account for is held.
   */
  async function recoverPool(pool: PoolRuntime): Promise<void> {
    const record = pool.record
    const listed = await git(record.repoRoot, ['worktree', 'list', '--porcelain'])
    if (!listed.ok) return
    const registered = new Map<string, { path: string; locked: string | null; branch: string | null }>()
    let current: { path: string; locked: string | null; branch: string | null } | null = null
    for (const line of listed.stdout.split(/\r?\n/u)) {
      if (line.startsWith('worktree ')) {
        current = { path: line.slice('worktree '.length), locked: null, branch: null }
        registered.set(comparablePath(current.path), current)
      } else if (current && line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '')
      } else if (current && (line === 'locked' || line.startsWith('locked '))) {
        current.locked = line.slice('locked'.length).trim()
      }
    }

    let pruneNeeded = false
    const survivors: SlotRecord[] = []
    for (const slot of record.slots) {
      const entry = registered.get(comparablePath(slot.path))
      const onDisk = await pathExists(slot.path)
      if (!entry || !onDisk) {
        // Gone from git or from disk. A half-made slot of our own is cleared
        // away; anything else was removed by someone, and is forgotten.
        if (slot.op?.kind === 'create' && onDisk && !entry && isInside(slot.path, pool.containerPath)) {
          await rm(slot.path, { recursive: true, force: true }).catch(() => {})
        }
        if (entry && !onDisk) pruneNeeded = true
        log(`${slot.path}: dropped from the pool (${entry ? 'missing on disk' : 'not a registered worktree'})`)
        continue
      }
      if (slot.op?.kind === 'create') {
        // `worktree add` was cut short. The slot was never leased, so nothing in
        // it is anyone's work, and a half-checked-out tree would otherwise read
        // as dirty and be held for ever. It is removed and made again later.
        const removed = await withWorktreeRegistryLock(record.repoRoot, () =>
          git(record.repoRoot, ['worktree', 'remove', '--force', slot.path]),
        )
        if (removed.ok) {
          log(`${slot.path}: removed a slot whose creation was interrupted`)
          continue
        }
      }
      survivors.push(slot)
      // Recovery finishes before this process starts any step of its own
      // (every entry point goes through `ready`), so any op here is a
      // previous run's.
      const op = slot.op
      if (op) {
        switch (op.kind) {
          case 'create':
          case 'refresh':
          case 'install':
            // Refreshing re-reads the slot first; a refresh that was cut short
            // is resumed only over its own reset (refreshSlot).
            slot.state = 'refreshing'
            if (op.kind === 'install') slot.depsFingerprint = null
            if (op.kind !== 'refresh') slot.op = null
            break
          case 'lease':
          case 'return':
            slot.state = 'returning'
            slot.op = null
            break
          case 'evict':
            slot.state = 'evicting'
            slot.op = null
            break
          default:
            slot.state = 'held'
            slot.held = {
              reason: 'recovery',
              detail: 'the app stopped during an action on this slot',
              changedPaths: null,
              branch: entry.branch,
              since: now(),
            }
            slot.op = null
        }
        continue
      }
      if (slot.state === 'creating' || slot.state === 'installing') slot.state = 'refreshing'
      if (slot.state === 'leasing') slot.state = 'returning'
    }
    if (pruneNeeded) {
      await withWorktreeRegistryLock(record.repoRoot, () => git(record.repoRoot, ['worktree', 'prune']))
    }

    // `pool-NN` worktrees in our container with no record: the record was lost.
    // A leased-looking one is adopted as leased (its owner sweep decides), and
    // anything else as held. None is ever reset on this evidence alone.
    const known = new Set(survivors.map((slot) => comparablePath(slot.path)))
    const released = new Set(record.releasedPaths.map(comparablePath))
    for (const [key, entry] of registered) {
      if (known.has(key) || released.has(key)) continue
      if (comparablePath(dirname(entry.path)) !== comparablePath(pool.containerPath)) continue
      const name = basename(entry.path)
      if (!SLOT_NAME.test(name)) continue
      const leasedTo = entry.locked?.startsWith('leased: ') ? entry.locked.slice('leased: '.length).trim() : null
      survivors.push({
        id: name,
        path: entry.path,
        state: leasedTo && entry.branch ? 'leased' : 'held',
        baseRef: null,
        baseSha: null,
        refreshedAt: null,
        depsFingerprint: null,
        depsState: 'stale',
        installCommand: null,
        error: null,
        lease:
          leasedTo && entry.branch
            ? {
                leaseId: randomUUID(),
                branch: entry.branch,
                owner: { agentId: leasedTo.startsWith('agent-') ? leasedTo : null, workspaceId: null },
                leasedAt: now(),
                ownerSeen: false,
              }
            : null,
        held:
          leasedTo && entry.branch
            ? null
            : {
                reason: 'recovery',
                detail: 'found in the pool container without a record',
                changedPaths: null,
                branch: entry.branch,
                since: now(),
              },
        sizeBytes: null,
        sizeMeasuredAt: null,
        lastUsedAt: null,
        createdAt: now(),
        op: null,
      })
      log(`${entry.path}: adopted into the pool (${leasedTo ? 'leased' : 'held'})`)
    }
    await withPool(pool, async () => {
      record.slots = survivors
      await persist(pool)
    })
  }

  // ── Held-slot actions ────────────────────────────────────────────────────

  async function heldAction(
    pool: PoolRuntime,
    slot: SlotRecord,
    action: 'commit' | 'stash' | 'discard' | 'keep',
    message: string | undefined,
  ): Promise<WorktreePoolActionResult> {
    if (slot.state !== 'held') return { ok: false, message: 'That slot is not held.' }
    if (somethingRunsIn(slot.path)) {
      return { ok: false, message: 'A terminal is still open in that worktree. Close it first.' }
    }
    const began = await withPool(pool, async () => {
      if (pool.busy.has(slot.id) || slot.state !== 'held') return false
      pool.busy.add(slot.id)
      slot.op = { kind: 'held-action', startedAt: now(), pid: process.pid }
      await persist(pool)
      return true
    })
    if (!began) return { ok: false, message: 'That slot is busy.' }
    let outcome: WorktreePoolActionResult = { ok: true, message: null }
    try {
      const gitDir = await readSlotGitDir(git, slot.path)
      const operation = gitDir ? await operationInProgress(gitDir) : null
      if (action === 'keep') {
        await git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
        await withPool(pool, async () => {
          pool.record.slots = pool.record.slots.filter((candidate) => candidate !== slot)
          pool.record.releasedPaths.push(slot.path)
          await persist(pool)
        })
        log(`${slot.path}: kept as an ordinary worktree`)
        return { ok: true, message: 'Kept as an ordinary worktree. It is no longer part of the pool.' }
      }
      if (action === 'commit' || action === 'stash') {
        if (operation) {
          outcome = { ok: false, message: `A ${operation} is in progress. Finish it in a terminal, or discard.` }
          return outcome
        }
        const status = await readSlotStatus(git, slot.path)
        if (!status.ok) return (outcome = { ok: false, message: status.message })
        if (action === 'commit') {
          if (status.status.branch === null && status.status.oid) {
            const name = `${slot.held?.branch ?? `agent/${slot.id}`}-held-${status.status.oid.slice(0, 7)}`
            const onBranch = await git(slot.path, ['switch', '--quiet', '-c', name])
            if (!onBranch.ok)
              return (outcome = { ok: false, message: onBranch.message ?? 'Could not create a branch.' })
          }
          const added = await git(slot.path, ['add', '--all'])
          if (!added.ok) return (outcome = { ok: false, message: added.message ?? 'git add failed.' })
          const committed = await git(slot.path, [
            'commit',
            '--quiet',
            '-m',
            message?.trim() || 'Work left in a pooled worktree',
          ])
          if (!committed.ok) return (outcome = { ok: false, message: committed.message ?? 'git commit failed.' })
        } else {
          const stashed = await git(slot.path, [
            'stash',
            'push',
            '--include-untracked',
            '-m',
            `worktree pool ${slot.id}: ${slot.held?.branch ?? 'held changes'}`,
          ])
          if (!stashed.ok) return (outcome = { ok: false, message: stashed.message ?? 'git stash failed.' })
        }
      } else if (action === 'discard') {
        if (operation) {
          const abort =
            operation === 'bisect' ? ['bisect', 'reset'] : [operation === 'revert' ? 'revert' : operation, '--abort']
          const aborted = await git(slot.path, abort)
          if (!aborted.ok)
            return (outcome = { ok: false, message: aborted.message ?? `Could not abort the ${operation}.` })
        }
        const reset = await git(slot.path, ['reset', '--hard', '--quiet', 'HEAD'])
        if (!reset.ok) return (outcome = { ok: false, message: reset.message ?? 'git reset failed.' })
        const cleaned = await git(slot.path, ['clean', '-fd', '--quiet'])
        if (!cleaned.ok) return (outcome = { ok: false, message: cleaned.message ?? 'git clean failed.' })
      }
    } finally {
      await withPool(pool, async () => {
        if (pool.record.slots.includes(slot)) {
          slot.op = null
          await persist(pool)
        }
      })
      pool.busy.delete(slot.id)
    }
    if (outcome.ok && pool.record.slots.includes(slot)) {
      await returnSlot(pool, slot)
      const after = slotById(pool, slot.id)
      if (after?.state === 'held') {
        return { ok: true, message: `Done, but the worktree is still held (${after.held?.reason ?? 'unknown'}).` }
      }
      return { ok: true, message: 'Returned to the pool.' }
    }
    return outcome
  }

  // ── Public surface ───────────────────────────────────────────────────────

  function load(): Promise<void> {
    loaded ??= (async () => {
      for (const { poolId, record } of await deps.store.readAll()) {
        if (!record || record.poolId !== poolId) {
          log(`pool ${poolId}: record unreadable; its slots are adopted as held on next use`)
          continue
        }
        runtimeFor(record)
      }
    })()
    return loaded
  }

  async function start(): Promise<void> {
    await load()
    for (const pool of pools.values()) await ready(pool)
    if (deps.timers === false) return
    const every = (ms: number, work: () => void): void => {
      const timer = setInterval(work, ms)
      timer.unref?.()
      timers.push(timer)
    }
    every(SWEEP_INTERVAL_MS, () => void sweepOwners())
    every(HEARTBEAT_INTERVAL_MS, () => {
      for (const pool of pools.values()) {
        if (pool.instance === 'held') void heartbeatInstanceLock(pool.containerPath, instanceId)
      }
    })
    every(MAINTENANCE_INTERVAL_MS, () => {
      if (deps.shouldDefer?.()) return
      for (const pool of pools.values()) {
        if (pool.instance === 'foreign') pool.instance = 'unknown'
        void ensureBase(pool, true).then(() => tend(pool))
      }
    })
    const first = setTimeout(() => {
      void sweepOwners()
      for (const pool of pools.values()) void tend(pool)
    }, START_DELAY_MS)
    first.unref?.()
    timers.push(first)
  }

  async function snapshot(repoRoot: string): Promise<WorktreePoolSnapshot | null> {
    const pool = await poolFor(repoRoot, false)
    return pool ? snapshotOf(pool) : null
  }

  async function action(input: WorktreePoolActionInput): Promise<WorktreePoolActionResult> {
    const create = input.kind === 'warm-up'
    const pool = await poolFor(input.repoRoot, create)
    if (!pool) return { ok: false, message: 'This repository has no worktree pool.' }
    if (filesystemHostOf(pool.record.repoRoot) !== 'local') {
      return { ok: false, message: 'Repositories on a WSL or network filesystem do not have a pool yet.' }
    }
    if (!(await ready(pool))) return { ok: false, message: 'Another Studio is using this pool.' }
    switch (input.kind) {
      case 'warm-up': {
        await withPool(pool, async () => {
          pool.record.lastLeaseAt = now()
          await persist(pool)
        })
        void tend(pool)
        return { ok: true, message: 'Warming up.' }
      }
      case 'set-disabled': {
        await withPool(pool, async () => {
          pool.record.disabled = input.disabled
          await persist(pool)
        })
        void tend(pool)
        return { ok: true, message: input.disabled ? 'Pool turned off for this repository.' : 'Pool turned on.' }
      }
      default:
        break
    }
    const slot = slotById(pool, input.slotId)
    if (!slot) return { ok: false, message: 'No such slot.' }
    switch (input.kind) {
      case 'refresh':
        if (slot.state === 'held') {
          await returnSlot(pool, slot)
          return { ok: true, message: slotById(pool, slot.id)?.state === 'held' ? 'Still held.' : 'Returned.' }
        }
        if (slot.state !== 'warm') return { ok: false, message: `A ${slot.state} slot cannot be refreshed.` }
        void ensureBase(pool, true).then(() => refreshSlot(pool, slot, { forceInstall: true }))
        return { ok: true, message: 'Refreshing.' }
      case 'evict':
        return (await evictSlot(pool, slot, 'by request'))
          ? { ok: true, message: 'Removed.' }
          : { ok: false, message: 'Only an idle, clean slot can be removed.' }
      case 'release':
        if (slot.state !== 'leased') return { ok: false, message: 'That slot is not leased.' }
        await returnSlot(pool, slot)
        return { ok: true, message: null }
      case 'held':
        return heldAction(pool, slot, input.action, input.message)
    }
  }

  async function release(leaseId: string): Promise<boolean> {
    const found = findLease(leaseId)
    if (!found) return false
    await returnSlot(found.pool, found.slot)
    return true
  }

  async function updateSettings(patch: Partial<WorktreePoolSettings>): Promise<WorktreePoolSettings> {
    const next = normalizePoolSettings({ ...(await getSettings()), ...patch })
    settings = next
    await deps.store.writeSettings(next)
    for (const pool of pools.values()) void tend(pool)
    return next
  }

  /** Whether a path is one of the pool's slots (the agent worktree cleanup leaves those alone). */
  function ownsPath(path: string): boolean {
    for (const pool of pools.values()) {
      if (pool.record.slots.some((slot) => comparablePath(slot.path) === comparablePath(path))) return true
    }
    return false
  }

  async function shutdown(): Promise<void> {
    stopped = true
    installAbort.abort()
    for (const timer of timers) clearTimeout(timer)
    if (sweepTimer) clearTimeout(sweepTimer)
    for (const pool of pools.values()) {
      if (pool.retry) clearTimeout(pool.retry)
      await pool.chain.catch(() => {})
      if (pool.instance === 'held') await releaseInstanceLock(pool.containerPath, instanceId)
    }
  }

  return {
    start,
    lease,
    bind,
    release,
    action,
    snapshot,
    snapshots: async () => {
      await load()
      return [...pools.values()].map(snapshotOf)
    },
    getSettings,
    updateSettings,
    ownsPath,
    noteRegistryChanged,
    sweepOwners,
    shutdown,
    /** Test seam: run a pool's pending work to completion. */
    tendAll: async () => {
      for (const pool of pools.values()) await tend(pool)
    },
  }
}
