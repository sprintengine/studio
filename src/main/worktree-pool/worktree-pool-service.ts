import { randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'path'
import {
  type WorktreePoolActionInput,
  type WorktreePoolActionResult,
  type WorktreePoolHeldReason,
  type WorktreePoolSettings,
  type WorktreePoolSnapshot,
} from '../../shared/ipc/worktree-pool'
import { comparablePath } from '../../shared/host-paths'
import { hostIdForFolder, isWslHostId, LOCAL_HOST_ID, normalizeExecutionHostId } from '../../shared/execution-host'
import { pathJoin } from '../../shared/paths'
import { slugifyWorktreeName, worktreeContainerPath } from '../../shared/worktree-paths'
import { lockAgentWorktree } from '../agent-worktree-lock'
import { hiddenEditPaths, insideAny, pathSpellings } from '../agent-worktree-keep-checks'
import { pathExists } from '../git-utils'
import { withWorktreeRegistryLock } from '../worktree-registry-lock'
import { measureDiskUsage, type MeasureDiskUsage } from './disk-usage'
import {
  acquireInstanceLock,
  heartbeatInstanceLock,
  isNetworkSharePath,
  normalizePoolSettings,
  POOL_RECORD_VERSION,
  poolIdFor,
  releaseInstanceLock,
  UNCLAIMED_LEASE_MS,
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
  hasSlotMarker,
  ignoredFilesInTheWay,
  isPerAgentFile,
  operationInProgress,
  pathsBetween,
  readSlotGitDir,
  readSlotStatus,
  removePerAgentFiles,
  removeSlotMarker,
  resolvePoolBaseRef,
  revParseCommit,
  usesLfs,
  writeSlotMarker,
  type SlotGitRunner,
} from './slot-git'

/**
 * The pool of reusable agent worktrees.
 *
 * A fresh worktree costs a checkout and, far more, whatever the agent then
 * spends rebuilding the ignored files a tree needs before its tests pass
 * (`node_modules`, a virtual environment, build caches). The pool keeps the
 * worktrees agents are done with instead of deleting them, and hands one to the
 * next agent after moving it to the default branch. The ignored files survive
 * the move, so the next agent's install is an incremental one, or none.
 *
 * ## What it costs while nobody uses it
 *
 * Nothing but disk (owner ruling 2026-09-24). No refresh, no fetch and no
 * install runs in the background. Every git step happens because someone asked
 * for a worktree (a lease) or a sweep found one nobody uses (a return), and a
 * slot's size is measured only when Settings ▸ Worktrees asks or, with a disk
 * limit set, when the slot comes back. The
 * pool never installs dependencies; an agent that needs them runs its own
 * install, which on a reused slot finds most of the work already done.
 *
 * ## Life of a slot
 *
 *   creating → leasing → leased                         (no idle slot to reuse)
 *   idle → leasing → leased                             (fetch, reset to base, branch)
 *   leased → returning → idle                           (clean return)
 *   leased → returning → held                           (work left in it)
 *   idle → evicting → gone                              (over the idle, slot or disk limit)
 *
 * A lease always forks from `origin/<default>` as fetched at that moment (at
 * most once a minute per repository, and never waiting longer than
 * LEASE_FETCH_TIMEOUT_MS: offline, it forks from what the ref already says).
 *
 * A slot lives at `<repo-parent>/.sprintengine-worktrees/<repo>/pool-NN` and
 * keeps that path for its whole life: virtual environments and build caches
 * record absolute paths and do not survive a move. A leased slot is on
 * `agent/<slug>` and locked with the agent worktree lock
 * (agent-worktree-lock.ts), so git's own `prune` and `remove`, another Studio
 * profile's cleanup and the Worktree manager all leave it alone.
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
 *   its commits stay (the agent worktree cleanup deletes the branch once its
 *   work is on the default branch). A detached HEAD holding commits no ref
 *   reaches is first given a branch of its own.
 * - It never recycles a slot mid-merge, mid-rebase or mid-cherry-pick.
 * - It never runs `clean -x`: ignored files (installed dependencies, build
 *   caches, a copied `.env`) are what makes a reused slot worth having. An
 *   ignored file where the new base adds a tracked one holds the slot instead
 *   of being overwritten.
 *
 * ## Concurrency
 *
 * Each pool has one mutex, held only across a state transition and its
 * persistence, never across a git step. A slot in a transitional state is not
 * leasable, so two leases never get one slot, and a lease never gets a slot
 * that is being returned or evicted. A second Studio is kept off the same slots
 * by a lock file in the container (pool-store.ts). The worktree registry itself
 * is changed under worktree-registry-lock.ts.
 *
 * ## Crash recovery
 *
 * A slot's `op` is persisted before each git step and cleared after it. When a
 * pool is first used after a start, a slot found with an `op` is finished or
 * held, per step (see `recoverPool`), and a `pool-NN` worktree with no record is
 * adopted as held, never reset.
 */

/**
 * The most slots a pool may ever have, leased ones included, whatever the
 * `maxSlots` setting says; past the setting a lease falls back to a plain
 * worktree.
 */
export const POOL_MAX_SLOTS = 32
/** Slots measured at once: each is a `du` over a tree of many thousand files. */
const MEASURE_CONCURRENCY = 3
const FETCH_FRESH_MS = 60_000
const HEARTBEAT_INTERVAL_MS = 5 * 60_000
const SLOT_NAME = /^pool-(\d{2,})$/u

export type WorktreePoolServiceDeps = {
  store: PoolStore
  git?: SlotGitRunner
  /** Working directories of live terminal sessions: a slot one sits in is never recycled. */
  livePaths?: () => string[]
  onChange?: (snapshot: WorktreePoolSnapshot) => void
  log?: (line: string) => void
  now?: () => number
  instanceId?: string
  lockDeps?: InstanceLockDeps
  /** Keep the instance lock's heartbeat running. Off in tests. */
  timers?: boolean
  /** How long one fetch of the base serves every lease that asks. */
  fetchFreshMs?: number
  /** Copies the repository's `.worktreeinclude` set into a slot (git.ts). */
  seedIncludedFiles?: (repoRoot: string, slotPath: string) => Promise<unknown>
  /** How much disk a slot takes (disk-usage.ts). */
  measure?: MeasureDiskUsage
}

export type WorktreePoolLeaseInput = {
  repoRoot: string
  /** The name the branch is derived from: `agent/<slug>`. */
  name: string
  /** Who the slot's lock names: the agent's id, or the branch while there is no agent yet. */
  owner?: string | null
  /** The agent that asked for the worktree itself (MCP), which keeps it while it exists. */
  agentId?: string | null
  /** The machine the worktree is for; the pool serves only this machine's own git. */
  hostId?: string | null
  /** Copy the repository's `.worktreeinclude` set in, as a fresh worktree would. */
  copyIncludedFiles?: boolean
}

export type WorktreePoolLeaseResult =
  | {
      ok: true
      leaseId: string
      slotId: string
      path: string
      branch: string
      baseRef: string
      baseSha: string
      /** The slot was made for this lease; nothing was reused. */
      created: boolean
      elapsedMs: number
    }
  | {
      ok: false
      /**
       * Why no slot was handed out. `branch-exists` and `invalid-name` are the
       * caller's to report (a plain worktree would fail the same way); every
       * other reason means the caller creates a worktree the old way.
       */
      reason:
        | 'disabled'
        | 'unsupported'
        | 'other-instance'
        | 'not-a-repo'
        | 'no-base'
        | 'full'
        | 'invalid-name'
        | 'branch-exists'
        | 'error'
      message: string
    }

/** What a return sweep did with each leased slot of a repository (merged into the cleanup report). */
export type WorktreePoolSweepEntry = {
  path: string
  branch: string | null
  verdict: 'in-use' | 'unclaimed' | 'returned' | 'held' | 'postponed'
  detail?: string
}

export type WorktreePoolReturnInput = {
  repoRoot: string
  /** Paths the app's records still use: a slot any of them sits in is kept. */
  protectedPaths: readonly string[]
  /**
   * Agents the app's records still hold; a slot one of them leased through MCP
   * is kept. Left out or null: unknown, and every such slot is kept.
   */
  agentIds?: ReadonlySet<string> | null
  dryRun?: boolean
}

type PoolRuntime = {
  record: PoolRecord
  containerPath: string
  chain: Promise<unknown>
  busy: Set<string>
  instance: 'unknown' | 'held' | 'foreign'
  fetch: Promise<{ ref: string; sha: string } | null> | null
  /** Recovery, run once this instance holds the pool's container. */
  recovered: Promise<void> | null
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type WorktreePoolService = ReturnType<typeof createWorktreePoolService>

export function createWorktreePoolService(deps: WorktreePoolServiceDeps) {
  const git = deps.git ?? defaultSlotGitRunner
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.info(`[worktree-pool] ${line}`))
  const instanceId = deps.instanceId ?? randomUUID()
  const fetchFreshMs = deps.fetchFreshMs ?? FETCH_FRESH_MS
  const measureSize = deps.measure ?? measureDiskUsage
  const pools = new Map<string, PoolRuntime>()
  const resolvedRepos = new Map<string, Promise<ResolvedRepo | null>>()
  let settings: WorktreePoolSettings | null = null
  let loaded: Promise<void> | null = null
  let stopped = false
  let heartbeat: NodeJS.Timeout | null = null

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

  /**
   * Why a repository's worktree cannot come from a pool on this machine, or
   * null when it can. Any WSL machine is declined — its worktrees are made by
   * its own git (`withGitHost`) — and so is a network share.
   */
  function unsupportedHost(repoRoot: string, named: string | null | undefined): string | null {
    if (isWslHostId(normalizeExecutionHostId(named)) || isWslHostId(hostIdForFolder(repoRoot))) {
      return 'Worktrees on a WSL machine are made by that machine’s git; it has no pool.'
    }
    if (isNetworkSharePath(repoRoot)) return 'Repositories on a network share do not have a worktree pool.'
    return null
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
        recovered: null,
      }
      pools.set(record.poolId, pool)
    }
    return pool
  }

  async function poolFor(repoRoot: string, create: boolean): Promise<PoolRuntime | null> {
    await load()
    const repo = await resolveRepo(repoRoot)
    if (!repo) return null
    const poolId = poolIdFor(repo.commonDir, LOCAL_HOST_ID)
    const existing = pools.get(poolId)
    if (existing) return existing
    if (!create) return null
    const record: PoolRecord = {
      version: POOL_RECORD_VERSION,
      poolId,
      repoRoot: repo.repoRoot,
      commonDir: repo.commonDir,
      hostId: LOCAL_HOST_ID,
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
    // Held means held NOW: the lock file is read (and touched) on every use, so
    // an instance that lost it — deleted by hand, taken over by a Studio that
    // judged it stale — stops driving the pool at its next step instead of
    // acting on slots someone else now owns. Recovery runs again if it wins the
    // lock back, since the other holder may have moved every slot meanwhile.
    if (pool.instance === 'held') {
      const beat = await heartbeatInstanceLock(pool.containerPath, instanceId).catch(() => 'unknown' as const)
      if (beat !== 'lost') return true
      log(`${pool.record.repoRoot}: lost the pool's lock`)
      pool.instance = 'unknown'
      pool.recovered = null
    }
    const result = await acquireInstanceLock(pool.containerPath, instanceId, deps.lockDeps).catch(() => ({
      ok: false as const,
      holder: 'unreadable lock',
    }))
    pool.instance = result.ok ? 'held' : 'foreign'
    if (!result.ok) log(`${pool.record.repoRoot}: pool held by another Studio (${result.holder})`)
    else startHeartbeat()
    return result.ok
  }

  /**
   * Whether this instance may drive the pool: it holds the container's lock,
   * and the pool has been recovered. Recovery runs only under the lock — a
   * second Studio must never "recover" slots the first one is using.
   */
  async function ready(pool: PoolRuntime): Promise<boolean> {
    if (stopped) return false
    if (!(await holdInstance(pool))) return false
    pool.recovered ??= recoverPool(pool).catch((error: unknown) =>
      log(`${pool.record.repoRoot}: recovery failed: ${messageOf(error)}`),
    )
    await pool.recovered
    return true
  }

  /**
   * The instance lock's heartbeat: one touch of one file every few minutes
   * while this instance holds a pool, so a Studio on another machine sharing
   * the container never judges it stale. No git runs on it.
   */
  function startHeartbeat(): void {
    if (heartbeat || stopped || deps.timers === false) return
    heartbeat = setInterval(() => {
      for (const pool of pools.values()) {
        if (pool.instance === 'held') void holdInstance(pool)
      }
    }, HEARTBEAT_INTERVAL_MS)
    heartbeat.unref?.()
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  function snapshotOf(pool: PoolRuntime): WorktreePoolSnapshot {
    const record = pool.record
    return {
      poolId: record.poolId,
      repoRoot: record.repoRoot,
      containerPath: pool.containerPath,
      heldByOtherInstance: pool.instance === 'foreign',
      defaultRef: record.defaultRef,
      lastFetchAt: record.lastFetchAt,
      slots: record.slots.map((slot) => ({
        id: slot.id,
        path: slot.path,
        state: slot.state,
        baseRef: slot.baseRef,
        baseSha: slot.baseSha,
        error: slot.error,
        lease: slot.lease
          ? {
              leaseId: slot.lease.leaseId,
              branch: slot.lease.branch,
              owner: slot.lease.owner,
              agentId: slot.lease.agentId,
              leasedAt: slot.lease.leasedAt,
            }
          : null,
        held: slot.held ? { ...slot.held } : null,
        lastUsedAt: slot.lastUsedAt,
        uses: slot.uses,
        lastBranch: slot.lastBranch,
        size: slot.size,
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
   * The commit a lease forks from: `origin/<default>` after at most one fetch
   * per pool per minute, shared by every lease that asks meanwhile. A failed
   * or slow fetch (offline, no credentials) falls back to what
   * `origin/<default>` already says, which is still the default branch.
   */
  function ensureBase(pool: PoolRuntime): Promise<{ ref: string; sha: string } | null> {
    if (pool.fetch) return pool.fetch
    const run = (async () => {
      const record = pool.record
      const ref = (await resolvePoolBaseRef(git, record.repoRoot)) ?? record.defaultRef
      if (!ref) return null
      if (ref.includes('/') && (!record.lastFetchAt || now() - record.lastFetchAt >= fetchFreshMs)) {
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

  // ── Resetting ────────────────────────────────────────────────────────────

  /**
   * Move a clean, detached slot to `target`. The reset is the one destructive
   * step in the pool, so it is fenced three ways: the slot must read clean and
   * detached immediately before it; HEAD is moved with a compare-and-swap
   * against the commit that read saw (`update-ref <new> <old>`), so anything
   * that moved HEAD in between makes it fail; and only then are the index and
   * tree brought along (`read-tree --reset -u`) and the untracked leftovers of
   * the old tree removed (`clean -fd`, never `-x`).
   *
   * True when the slot now sits at `target`; false when it was held instead.
   * The caller has marked the slot busy.
   */
  async function resetSlot(pool: PoolRuntime, slot: SlotRecord, target: string): Promise<boolean> {
    const gitDir = await readSlotGitDir(git, slot.path)
    if (!gitDir) {
      await hold(pool, slot, 'error', 'the slot is no longer a git worktree')
      return false
    }
    // A reset op still on the slot is a previous run's, cut short (recovery
    // leaves it for exactly this): the `index.lock` in the slot is that dead
    // run's own, whatever its age.
    const resumingOwnReset = slot.op?.kind === 'reset'
    const lockVerdict = await clearStaleIndexLock(gitDir, !somethingRunsIn(slot.path), now(), resumingOwnReset)
    if (lockVerdict === 'busy') {
      await hold(pool, slot, 'error', 'git is busy in this worktree (index.lock)')
      return false
    }
    const operation = await operationInProgress(gitDir)
    if (operation) {
      await hold(pool, slot, 'operation', `a ${operation} is in progress`)
      return false
    }
    const status = await readSlotStatus(git, slot.path)
    if (!status.ok) {
      await hold(pool, slot, 'error', `status failed: ${status.message}`)
      return false
    }
    const { oid, branch, changedPaths, trackedPaths, untracked } = status.status
    if (branch !== null) {
      await hold(pool, slot, 'unexpected-head', `an idle slot is on ${branch}`, { branch })
      return false
    }
    // A reset the previous run of the app started and did not finish leaves
    // the tree half-moved, which reads as dirty. That dirt is the pool's own,
    // and only then, with HEAD at one end of that very reset, is the reset
    // re-run over it…
    const previous = resumingOwnReset ? slot.op : null
    let resuming =
      previous !== null &&
      Boolean(previous?.toSha && previous?.fromSha) &&
      oid !== null &&
      (oid === previous?.toSha || oid === previous?.fromSha)
    // …and only when every change in the tree is one that reset makes: no
    // untracked file (a reset leaves none behind until `clean`), and no tracked
    // path outside the two commits' difference. Anything else was written by
    // someone while the app was down.
    if (resuming && changedPaths > 0) {
      const between = await pathsBetween(git, slot.path, previous!.fromSha!, previous!.toSha!)
      resuming = untracked === 0 && between !== null && trackedPaths.every((path) => between.has(path))
    }
    if (changedPaths > 0 && !resuming) {
      await hold(pool, slot, 'dirty', 'changes appeared in an idle slot', { changedPaths })
      return false
    }
    if (!resuming && slot.baseSha && oid !== slot.baseSha) {
      await hold(pool, slot, 'unexpected-head', 'an idle slot moved off the commit it was left at')
      return false
    }
    // Tracked files hidden from `status` (`--assume-unchanged`,
    // `--skip-worktree`) are overwritten by the reset without a word.
    const hidden = await hiddenEditPaths(slot.path, git)
    if (!hidden.ok || hidden.paths.length > 0) {
      await hold(
        pool,
        slot,
        'dirty',
        hidden.ok ? `edits hidden from git status: ${hidden.paths.slice(0, 5).join(', ')}` : hidden.message,
        { changedPaths: hidden.ok ? hidden.paths.length : null },
      )
      return false
    }
    const from = resuming && previous?.fromSha ? previous.fromSha : oid
    if (oid === target && !resuming) return true
    if (from !== target && from !== null) {
      // Ignored files where the new base adds tracked ones would be
      // overwritten silently by the reset; they are nobody's to lose.
      const inTheWay = await ignoredFilesInTheWay(git, slot.path, from, target)
      if (inTheWay === null || inTheWay.length > 0) {
        await hold(
          pool,
          slot,
          'dirty',
          inTheWay === null
            ? 'could not check for ignored files the reset would overwrite'
            : `ignored files the reset would overwrite: ${inTheWay.slice(0, 5).join(', ')}`,
          { changedPaths: inTheWay?.length ?? null },
        )
        return false
      }
    }
    await withPool(pool, async () => {
      slot.op = { kind: 'reset', startedAt: now(), pid: process.pid, fromSha: from, toSha: target }
      await persist(pool)
    })
    if (oid !== target) {
      const moved = await git(slot.path, [
        'update-ref',
        '--no-deref',
        '-m',
        'worktree pool: reset',
        'HEAD',
        target,
        oid ?? '',
      ])
      if (!moved.ok) {
        await hold(pool, slot, 'unexpected-head', `HEAD moved during the reset: ${tail(moved.message, 200)}`)
        return false
      }
    }
    const reset = await git(slot.path, ['read-tree', '--reset', '-u', 'HEAD'])
    if (!reset.ok) {
      await hold(pool, slot, 'error', `reset failed: ${tail(reset.message, 200)}`)
      return false
    }
    const cleaned = await git(slot.path, ['clean', '-fd', '--quiet'])
    if (!cleaned.ok) {
      await hold(pool, slot, 'error', `clean failed: ${tail(cleaned.message, 200)}`)
      return false
    }
    return true
  }

  // ── Leasing ──────────────────────────────────────────────────────────────

  async function nextSlotPath(pool: PoolRuntime): Promise<{ id: string; path: string } | null> {
    const taken = new Set(pool.record.slots.map((slot) => slot.id))
    const released = new Set(pool.record.releasedPaths.map(comparablePath))
    for (let n = 1; n < 1000; n += 1) {
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

  /** A new slot, made for a lease that found no idle one: detached at the base, marked, busy. */
  async function createSlot(
    pool: PoolRuntime,
    base: { ref: string; sha: string },
  ): Promise<SlotRecord | 'full' | 'error'> {
    // The name is picked under the pool's mutex, in the same step that records
    // it: two leases creating at once must never both pick `pool-01`.
    const { maxSlots } = await getSettings()
    const slot = await withPool(pool, async () => {
      if (pool.record.slots.length >= Math.min(maxSlots, POOL_MAX_SLOTS)) return null
      const target = await nextSlotPath(pool)
      if (!target) return null
      const created: SlotRecord = {
        id: target.id,
        path: target.path,
        state: 'creating',
        baseRef: base.ref,
        baseSha: base.sha,
        error: null,
        lease: null,
        held: null,
        lastUsedAt: null,
        createdAt: now(),
        op: { kind: 'create', startedAt: now(), pid: process.pid },
        uses: 0,
        lastBranch: null,
        size: null,
      }
      pool.record.slots.push(created)
      pool.busy.add(created.id)
      await persist(pool)
      return created
    })
    if (!slot) return 'full'
    const result = await withWorktreeRegistryLock(pool.record.repoRoot, () =>
      git(pool.record.repoRoot, ['worktree', 'add', '--quiet', '--detach', slot.path, base.sha]),
    )
    if (!result.ok) {
      log(`${slot.path}: worktree add failed (${tail(result.message, 300)})`)
      await withPool(pool, async () => {
        pool.record.slots = pool.record.slots.filter((candidate) => candidate !== slot)
        await persist(pool)
      })
      pool.busy.delete(slot.id)
      return 'error'
    }
    await writeSlotMarker(git, slot.path).catch(() => {})
    await withPool(pool, async () => {
      slot.state = 'leasing'
      slot.op = { kind: 'lease', startedAt: now(), pid: process.pid }
      await persist(pool)
    })
    return slot
  }

  async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
    const result = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return result.ok && result.stdout.trim().length > 0
  }

  async function lease(input: WorktreePoolLeaseInput): Promise<WorktreePoolLeaseResult> {
    const started = now()
    if (stopped) return { ok: false, reason: 'disabled', message: 'The worktree pool is shutting down.' }
    if (!(await getSettings()).enabled) return { ok: false, reason: 'disabled', message: 'The worktree pool is off.' }
    const slug = slugifyWorktreeName(input.name)
    if (!slug) {
      return { ok: false, reason: 'invalid-name', message: `"${input.name}" does not reduce to a usable branch name.` }
    }
    const repo = await resolveRepo(input.repoRoot)
    if (!repo) return { ok: false, reason: 'not-a-repo', message: 'Not a git repository with a main checkout.' }
    const unsupported = unsupportedHost(repo.repoRoot, input.hostId)
    if (unsupported) return { ok: false, reason: 'unsupported', message: unsupported }
    const pool = await poolFor(repo.repoRoot, true)
    if (!pool) return { ok: false, reason: 'not-a-repo', message: 'Not a git repository.' }
    if (!(await ready(pool))) {
      return { ok: false, reason: 'other-instance', message: 'Another Studio is using this repository’s pool.' }
    }
    const branch = `agent/${slug}`
    const format = await git(pool.record.repoRoot, ['check-ref-format', '--branch', branch])
    if (!format.ok) return { ok: false, reason: 'invalid-name', message: `"${branch}" is not a valid branch name.` }
    if (await branchExists(pool.record.repoRoot, branch)) {
      return {
        ok: false,
        reason: 'branch-exists',
        message: `Branch "${branch}" already exists. Choose a different worktree name.`,
      }
    }
    await forgetSlotsGoneFromDisk(pool)
    const base = await ensureBase(pool)
    if (!base) return { ok: false, reason: 'no-base', message: 'This repository has no default branch to fork from.' }
    const owner = input.owner?.trim() || branch

    // Idle slots, the least recently used first: the slot a settled chat gave
    // back most recently is the last to go to someone else, so reopening that
    // chat finds its worktree still free to reclaim (`reclaim`).
    for (let attempt = 0; attempt <= POOL_MAX_SLOTS; attempt += 1) {
      let created = false
      let slot: SlotRecord | null = await withPool(pool, async () => {
        const picked = pool.record.slots
          .filter((candidate) => candidate.state === 'idle' && !pool.busy.has(candidate.id))
          .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))[0]
        if (!picked) return null
        picked.state = 'leasing'
        pool.busy.add(picked.id)
        await persist(pool)
        return picked
      })
      if (!slot) {
        const made = await createSlot(pool, base)
        if (made === 'full') {
          const { maxSlots } = await getSettings()
          return { ok: false, reason: 'full', message: `The pool already has ${maxSlots} worktrees.` }
        }
        if (made === 'error') return { ok: false, reason: 'error', message: 'Could not create a pool worktree.' }
        slot = made
        created = true
      }
      try {
        if (!created) {
          if (somethingRunsIn(slot.path)) {
            // Someone opened a terminal in an idle slot; it is not reset under them.
            await withPool(pool, async () => {
              slot!.state = 'idle'
              await persist(pool)
            })
            continue
          }
          if (!(await resetSlot(pool, slot, base.sha))) continue
          await withPool(pool, async () => {
            slot!.op = { kind: 'lease', startedAt: now(), pid: process.pid }
            await persist(pool)
          })
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
        // `.worktreeinclude` names ignored files (an `.env`) the tree needs; a
        // reused slot still has the last copy, but the checkout's may have
        // changed since.
        if (input.copyIncludedFiles) await deps.seedIncludedFiles?.(pool.record.repoRoot, slot.path)?.catch(() => null)
        // Locked BEFORE the branch exists: from the moment the slot is on an
        // `agent/` branch, nothing else may remove it.
        const locked = await lockAgentWorktree(pool.record.repoRoot, slot.path, owner, git)
        if (!locked.ok) log(`${slot.path}: could not lock (${tail(locked.message, 200)}); leasing anyway`)
        const switched = await git(slot.path, ['switch', '--quiet', '-c', branch])
        if (!switched.ok) {
          await git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
          await withPool(pool, async () => {
            slot!.state = 'idle'
            slot!.op = null
            slot!.baseRef = base.ref
            slot!.baseSha = base.sha
            await persist(pool)
          })
          const exists = await branchExists(pool.record.repoRoot, branch)
          return {
            ok: false,
            reason: exists ? 'branch-exists' : 'error',
            message: switched.message ?? `Could not create ${branch}.`,
          }
        }
        const leaseId = randomUUID()
        await withPool(pool, async () => {
          slot!.state = 'leased'
          slot!.op = null
          slot!.held = null
          slot!.error = notes.length ? notes.join('; ') : null
          slot!.baseRef = base.ref
          slot!.baseSha = base.sha
          slot!.lease = { leaseId, branch, owner, agentId: input.agentId ?? null, leasedAt: now(), claimed: false }
          slot!.lastUsedAt = now()
          slot!.uses += 1
          pool.record.lastLeaseAt = now()
          await persist(pool)
        })
        log(`${slot.path}: leased to ${owner} on ${branch} at ${base.ref} (${created ? 'new' : 'reused'})`)
        return {
          ok: true,
          leaseId,
          slotId: slot.id,
          path: slot.path,
          branch,
          baseRef: base.ref,
          baseSha: base.sha,
          created,
          elapsedMs: now() - started,
        }
      } catch (error) {
        await hold(pool, slot, 'error', messageOf(error))
        if (created) return { ok: false, reason: 'error', message: messageOf(error) }
      } finally {
        pool.busy.delete(slot.id)
      }
    }
    return { ok: false, reason: 'error', message: 'No pool worktree passed its checks.' }
  }

  /**
   * Name the owner of a lease taken before its owner existed (a launch makes
   * its worktree before it mints the agent's id).
   */
  async function bind(leaseId: string, owner: string): Promise<boolean> {
    const found = findLease(leaseId)
    if (!found || !found.slot.lease) return false
    await lockAgentWorktree(found.pool.record.repoRoot, found.slot.path, owner, git).catch(() => null)
    await withPool(found.pool, async () => {
      if (!found.slot.lease) return
      found.slot.lease.owner = owner
      await persist(found.pool)
    })
    return true
  }

  /**
   * Give a returned slot back to the chat it was returned from, on the
   * chat's own branch, at the path the chat records: a settled chat reopened
   * after the cleanup handed its worktree back (git.ts `restoreGitWorktree`).
   * The slot is still on disk with everything the chat left in it, ignored
   * files included, so only the branch is checked out again.
   *
   * Only an idle slot can be reclaimed. One leased to another agent since, or
   * held with someone's changes, is refused with the reason; a branch that no
   * longer exists is refused for good.
   */
  async function reclaim(input: {
    path: string
    branch: string
    owner: string
  }): Promise<{ ok: true } | { ok: false; message: string; definitive?: true } | null> {
    await load()
    const pool = [...pools.values()].find((candidate) =>
      candidate.record.slots.some((slot) => comparablePath(slot.path) === comparablePath(input.path)),
    )
    if (!pool) return null
    if (!(await ready(pool))) {
      return { ok: false, message: 'Another SprintEngine Studio is using this repository’s worktree pool.' }
    }
    const branch = input.branch
    const began = await withPool(pool, async () => {
      const slot = pool.record.slots.find((candidate) => comparablePath(candidate.path) === comparablePath(input.path))
      if (!slot) return { kind: 'gone' as const }
      if (slot.state === 'leased' && slot.lease?.branch === branch) return { kind: 'done' as const }
      if (slot.state !== 'idle' || pool.busy.has(slot.id)) return { kind: 'refused' as const, other: slot }
      pool.busy.add(slot.id)
      slot.state = 'leasing'
      slot.op = { kind: 'lease', startedAt: now(), pid: process.pid }
      await persist(pool)
      return { kind: 'began' as const, slot }
    })
    if (began.kind === 'gone') return null
    if (began.kind === 'done') return { ok: true }
    if (began.kind === 'refused') {
      const other = began.other
      return {
        ok: false,
        message:
          other.state === 'held'
            ? `The worktree this chat used is held in the worktree pool with changes in it. Commit, stash or discard them in the Worktree manager, then open the chat again.`
            : `The worktree this chat used at ${input.path} has since been given to another agent${other.lease ? ` (${other.lease.branch})` : ''}.`,
      }
    }
    const slot = began.slot
    const putBack = async (): Promise<void> => {
      await withPool(pool, async () => {
        slot.state = 'idle'
        slot.op = null
        await persist(pool)
      })
    }
    try {
      if (!(await branchExists(pool.record.repoRoot, branch))) {
        await putBack()
        return {
          ok: false,
          definitive: true,
          message: `Branch "${branch}" no longer exists, so the worktree cannot be recreated.`,
        }
      }
      const gitDir = await readSlotGitDir(git, slot.path)
      const operation = gitDir ? await operationInProgress(gitDir) : null
      const status = await readSlotStatus(git, slot.path)
      if (!gitDir || operation || !status.ok || status.status.changedPaths > 0 || status.status.branch !== null) {
        await hold(
          pool,
          slot,
          !status.ok || !gitDir
            ? 'error'
            : operation
              ? 'operation'
              : status.status.branch
                ? 'unexpected-head'
                : 'dirty',
          'found while giving it back to its chat',
          status.ok ? { changedPaths: status.status.changedPaths, branch: status.status.branch } : {},
        )
        return {
          ok: false,
          message: 'The worktree this chat used changed while it was in the pool; it is held in the Worktree manager.',
        }
      }
      const locked = await lockAgentWorktree(pool.record.repoRoot, slot.path, input.owner, git)
      if (!locked.ok) log(`${slot.path}: could not lock (${tail(locked.message, 200)}); reclaiming anyway`)
      const switched = await git(slot.path, ['switch', '--quiet', branch])
      if (!switched.ok) {
        await git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
        await putBack()
        return { ok: false, message: switched.message ?? `Could not check out ${branch} again.` }
      }
      await withPool(pool, async () => {
        slot.state = 'leased'
        slot.op = null
        slot.lease = {
          leaseId: randomUUID(),
          branch,
          owner: input.owner,
          agentId: null,
          leasedAt: now(),
          claimed: false,
        }
        slot.lastUsedAt = now()
        await persist(pool)
      })
      log(`${slot.path}: given back to its chat on ${branch}`)
      return { ok: true }
    } catch (error) {
      await hold(pool, slot, 'error', messageOf(error))
      return { ok: false, message: messageOf(error) }
    } finally {
      pool.busy.delete(slot.id)
    }
  }

  function findLease(leaseId: string): { pool: PoolRuntime; slot: SlotRecord } | null {
    for (const pool of pools.values()) {
      const slot = pool.record.slots.find((candidate) => candidate.lease?.leaseId === leaseId)
      if (slot) return { pool, slot }
    }
    return null
  }

  // ── Returning ────────────────────────────────────────────────────────────

  /**
   * Take a slot back from its owner (or re-check a held one). Clean: detached,
   * unlocked, idle again — it is moved to the default branch by the next lease,
   * not now. Anything else: held. The result says which.
   */
  async function returnSlot(
    pool: PoolRuntime,
    slot: SlotRecord,
    recovering = false,
  ): Promise<'returned' | 'held' | 'postponed' | 'skipped'> {
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
    if (!began) return 'skipped'
    const branch = began.lease?.branch ?? began.held?.branch ?? null
    try {
      if (somethingRunsIn(slot.path)) {
        // The agent's terminal (or anyone's) is still in there: put it back as
        // it was, and the next sweep asks again.
        await withPool(pool, async () => {
          slot.state = began.from === 'leasing' ? 'returning' : began.from
          slot.op = null
          await persist(pool)
        })
        return 'postponed'
      }
      const gitDir = await readSlotGitDir(git, slot.path)
      if (!gitDir) {
        await hold(pool, slot, 'error', 'the slot is no longer a git worktree', { branch })
        return 'held'
      }
      const operation = await operationInProgress(gitDir)
      if (operation) {
        await hold(pool, slot, 'operation', `a ${operation} is in progress`, { branch })
        return 'held'
      }
      if ((await clearStaleIndexLock(gitDir, true, now())) === 'busy') {
        await withPool(pool, async () => {
          slot.state = began.from === 'leasing' ? 'returning' : began.from
          slot.op = null
          await persist(pool)
        })
        return 'postponed'
      }
      const status = await readSlotStatus(git, slot.path)
      if (!status.ok) {
        await hold(pool, slot, 'error', `status failed: ${status.message}`, { branch })
        return 'held'
      }
      // The MCP config every agent launch writes into its worktree is the
      // app's, not the agent's work, and is removed below; nothing else counts
      // as clean.
      const ownFiles = status.status.untrackedPaths.filter(isPerAgentFile).length
      const agentChanges = status.status.changedPaths - ownFiles
      if (agentChanges > 0) {
        await hold(pool, slot, 'dirty', null, { changedPaths: agentChanges, branch: status.status.branch ?? branch })
        return 'held'
      }
      const oid = status.status.oid
      // Detaching is free when HEAD is on a branch (the branch keeps it) or at
      // a commit some ref already reaches. A detached HEAD with commits of its
      // own gets a branch first, or those commits would be reachable only from
      // the reflog once the slot is reset.
      if (status.status.branch === null && oid && oid !== slot.baseSha) {
        if (!(await commitIsReachable(git, slot.path, oid))) {
          const rescue = `${branch ?? `agent/${slot.id}`}-rescued-${oid.slice(0, 7)}`
          const created = await git(slot.path, ['branch', rescue, oid])
          if (!created.ok) {
            await hold(pool, slot, 'error', `could not keep detached commits: ${tail(created.message, 200)}`, {
              branch,
            })
            return 'held'
          }
          log(`${slot.path}: kept detached commit ${oid.slice(0, 7)} on ${rescue}`)
        }
      }
      if (status.status.branch !== null) {
        const detached = await git(slot.path, ['switch', '--quiet', '--detach'])
        if (!detached.ok) {
          await hold(pool, slot, 'error', `could not detach: ${tail(detached.message, 200)}`, { branch })
          return 'held'
        }
      }
      const cleared = await removePerAgentFiles(git, slot.path)
      if (cleared.length > 0) log(`${slot.path}: removed the last agent's ${cleared.join(', ')}`)
      await git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
      await withPool(pool, async () => {
        slot.state = 'idle'
        // Where the slot is now: the next lease holds it if anything moves it.
        slot.baseSha = oid
        if (branch) slot.lastBranch = branch
        slot.lease = null
        slot.held = null
        slot.op = null
        slot.error = null
        slot.lastUsedAt = now()
        await persist(pool)
      })
      log(`${slot.path}: returned clean${branch ? ` (${branch} kept)` : ''}`)
    } catch (error) {
      await hold(pool, slot, 'error', messageOf(error), { branch })
      return 'held'
    } finally {
      pool.busy.delete(slot.id)
    }
    await evictOverLimit(pool)
    // A slot comes back bigger than it left (the agent installed, built); with
    // a disk limit set, that is when the pool learns it went over.
    if ((await getSettings()).diskLimitGb !== null && pool.record.slots.includes(slot)) {
      await measureSlot(pool, slot)
      await enforceDiskLimit()
    }
    return 'returned'
  }

  /**
   * Return every leased slot of a repository that nothing uses any more. Asked
   * by the agent worktree cleanup, which already knows every path the app's
   * records use; the pool has no sweep of its own.
   *
   * A slot is in use while a protected path or a live terminal sits in it, or
   * while the agent that leased it through MCP still exists. A lease never seen
   * in use is left alone for {@link UNCLAIMED_LEASE_MS}: the chat it was made
   * for may not be recorded yet.
   */
  async function returnUnused(input: WorktreePoolReturnInput): Promise<WorktreePoolSweepEntry[]> {
    const pool = await poolFor(input.repoRoot, false)
    if (!pool || !(await ready(pool))) return []
    await forgetSlotsGoneFromDisk(pool)
    const protectedSpellings = await Promise.all(
      [...input.protectedPaths, ...(deps.livePaths?.() ?? [])].filter(Boolean).map((path) => pathSpellings(path)),
    )
    const entries: WorktreePoolSweepEntry[] = []
    for (const slot of [...pool.record.slots]) {
      if (slot.state === 'returning' && !pool.busy.has(slot.id)) {
        // A return a previous sweep postponed, or the app stopped in.
        const outcome = await returnSlot(pool, slot, true)
        if (outcome !== 'skipped') entries.push({ path: slot.path, branch: null, verdict: outcome })
        continue
      }
      if (slot.state !== 'leased' || !slot.lease) continue
      const lease = slot.lease
      const base = { path: slot.path, branch: lease.branch }
      const slotSpellings = await pathSpellings(slot.path)
      const inUse =
        protectedSpellings.some((spellings) => insideAny(spellings, slotSpellings)) ||
        (lease.agentId !== null && (input.agentIds == null || input.agentIds.has(lease.agentId)))
      if (inUse) {
        if (!lease.claimed && !input.dryRun) {
          await withPool(pool, async () => {
            if (slot.lease === lease) lease.claimed = true
            await persist(pool)
          })
        }
        entries.push({ ...base, verdict: 'in-use' })
        continue
      }
      if (!lease.claimed && now() - lease.leasedAt < UNCLAIMED_LEASE_MS) {
        entries.push({ ...base, verdict: 'unclaimed', detail: 'leased recently; not recorded in use yet' })
        continue
      }
      if (input.dryRun) {
        entries.push({ ...base, verdict: 'returned' })
        continue
      }
      const outcome = await returnSlot(pool, slot)
      if (outcome === 'skipped') continue
      const after = slotById(pool, slot.id)
      entries.push({
        ...base,
        verdict: outcome,
        detail: outcome === 'held' ? (after?.held?.detail ?? after?.held?.reason) : undefined,
      })
    }
    return entries
  }

  // ── Evicting ─────────────────────────────────────────────────────────────

  async function evictSlot(pool: PoolRuntime, slot: SlotRecord, why: string): Promise<boolean> {
    const began = await withPool(pool, async () => {
      if (pool.busy.has(slot.id) || (slot.state !== 'idle' && slot.state !== 'evicting')) return false
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
          slot.state = 'idle'
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
        // Only a tree with submodules, which plain `remove` always refuses, is
        // forced — and only after the status above read it clean.
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

  /**
   * Remove the least recently used idle slots beyond the kept number, and
   * beyond what `maxSlots` leaves room for beside the slots in use.
   */
  async function evictOverLimit(pool: PoolRuntime): Promise<void> {
    const { keepIdle, enabled, maxSlots } = await getSettings()
    const idle = pool.record.slots
      .filter((slot) => slot.state === 'idle' && !pool.busy.has(slot.id))
      .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt))
    const others = pool.record.slots.length - idle.length
    const limit = enabled ? Math.min(keepIdle, Math.max(0, maxSlots - others)) : 0
    for (const slot of idle.slice(limit)) await evictSlot(pool, slot, 'over the idle limit')
  }

  // ── Disk ─────────────────────────────────────────────────────────────────

  async function measureSlot(pool: PoolRuntime, slot: SlotRecord): Promise<void> {
    if (!(await pathExists(slot.path))) return
    const size = await measureSize(slot.path).catch(() => null)
    if (!size) return
    await withPool(pool, async () => {
      if (!pool.record.slots.includes(slot)) return
      slot.size = size
      await persist(pool)
    })
  }

  /**
   * Measure every slot of every pool this instance drives (or of one
   * repository's), a few at a time, then hold the pools to the disk limit.
   * Settings ▸ Worktrees asks; nothing else measures in bulk.
   */
  async function measure(repoRoot?: string): Promise<void> {
    await load()
    const target = repoRoot ? await poolFor(repoRoot, false) : null
    const targets = repoRoot ? (target ? [target] : []) : [...pools.values()]
    const queue: Array<{ pool: PoolRuntime; slot: SlotRecord }> = []
    for (const pool of targets) {
      if (!(await ready(pool))) continue
      for (const slot of pool.record.slots) {
        if (slot.state !== 'creating' && slot.state !== 'evicting') queue.push({ pool, slot })
      }
    }
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) await measureSlot(next.pool, next.slot)
    }
    await Promise.all(Array.from({ length: Math.min(MEASURE_CONCURRENCY, queue.length) }, worker))
    await enforceDiskLimit()
  }

  /**
   * Remove idle slots, least recently used first across every pool, while all
   * of them together take more than the disk limit. Leased and held slots are
   * counted but never removed, so the pools may stay over the limit. A slot
   * never measured counts as nothing: the limit acts on what is known.
   */
  async function enforceDiskLimit(): Promise<void> {
    const { diskLimitGb } = await getSettings()
    if (diskLimitGb === null) return
    const limit = diskLimitGb * 1024 ** 3
    const driven = [...pools.values()].filter((pool) => pool.instance === 'held')
    let total = driven.reduce(
      (sum, pool) => sum + pool.record.slots.reduce((poolSum, slot) => poolSum + (slot.size?.bytes ?? 0), 0),
      0,
    )
    if (total <= limit) return
    const idle = driven
      .flatMap((pool) => pool.record.slots.map((slot) => ({ pool, slot })))
      .filter(({ pool, slot }) => slot.state === 'idle' && !pool.busy.has(slot.id))
      .sort((a, b) => (a.slot.lastUsedAt ?? a.slot.createdAt) - (b.slot.lastUsedAt ?? b.slot.createdAt))
    for (const { pool, slot } of idle) {
      if (total <= limit) break
      const bytes = slot.size?.bytes ?? 0
      if (await evictSlot(pool, slot, 'over the disk limit')) total -= bytes
    }
  }

  /**
   * Delete an idle slot's ignored files (`git clean -fdX`): installed
   * dependencies, build output, caches. The slot stays in the pool, clean and
   * on its commit; the next agent in it installs from nothing.
   */
  async function clearIgnored(pool: PoolRuntime, slot: SlotRecord): Promise<WorktreePoolActionResult> {
    if (somethingRunsIn(slot.path)) {
      return { ok: false, message: 'A terminal is open in that worktree. Close it first.' }
    }
    const began = await withPool(pool, async () => {
      if (pool.busy.has(slot.id) || slot.state !== 'idle') return false
      pool.busy.add(slot.id)
      return true
    })
    if (!began) return { ok: false, message: 'Only a worktree that is ready to reuse can be cleared.' }
    try {
      const cleaned = await git(slot.path, ['clean', '-fdX', '--quiet'])
      if (!cleaned.ok) return { ok: false, message: cleaned.message ?? 'git clean failed.' }
      log(`${slot.path}: ignored files cleared`)
    } finally {
      pool.busy.delete(slot.id)
    }
    await measureSlot(pool, slot)
    return { ok: true, message: 'Cleared. The next agent in it runs the install from the start.' }
  }

  /**
   * Forget idle and held slots someone deleted from outside (a file manager,
   * `git worktree remove` in a terminal), and prune git's record of them. A
   * leased one's absence is its owner's business.
   */
  async function forgetSlotsGoneFromDisk(pool: PoolRuntime): Promise<void> {
    const gone: SlotRecord[] = []
    for (const slot of pool.record.slots) {
      if ((slot.state === 'idle' || slot.state === 'held') && !pool.busy.has(slot.id)) {
        if (!(await pathExists(slot.path))) gone.push(slot)
      }
    }
    if (gone.length === 0) return
    // A held slot is locked, and git never prunes a locked worktree.
    for (const slot of gone) {
      if (slot.state === 'held') await git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
    }
    await withWorktreeRegistryLock(pool.record.repoRoot, () => git(pool.record.repoRoot, ['worktree', 'prune']))
    await withPool(pool, async () => {
      pool.record.slots = pool.record.slots.filter((slot) => !gone.includes(slot))
      await persist(pool)
    })
    for (const slot of gone) log(`${slot.path}: gone from disk; dropped from the pool`)
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  /**
   * Put a pool loaded from disk back into a state the service can drive. The
   * rule for each interrupted step is the least destructive one that finishes
   * it: a lease or a return is redone as a return (which only ever detaches a
   * clean tree), a reset is resumed only over its own half-done work by the
   * next lease, and anything the pool cannot account for is held.
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
    const toReturn: SlotRecord[] = []
    const toEvict: SlotRecord[] = []
    for (const slot of record.slots) {
      // Recovery can run again after this process lost and regained the lock;
      // a slot it is itself working on right now is not a dead run's.
      if (pool.busy.has(slot.id)) {
        survivors.push(slot)
        continue
      }
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
      // (every entry point goes through `ready`), so any op here is a previous
      // run's.
      const op = slot.op
      if (op) {
        switch (op.kind) {
          case 'reset':
            // Left on the slot: the next lease's reset resumes over its own
            // half-done work and nothing else (resetSlot).
            slot.state = 'idle'
            break
          case 'create':
          case 'lease':
          case 'return':
            slot.state = 'returning'
            slot.op = null
            toReturn.push(slot)
            break
          case 'evict':
            slot.state = 'evicting'
            slot.op = null
            toEvict.push(slot)
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
      if (slot.state === 'creating' || slot.state === 'leasing' || slot.state === 'returning') {
        slot.state = 'returning'
        toReturn.push(slot)
      } else if (slot.state === 'evicting') {
        toEvict.push(slot)
      }
    }
    if (pruneNeeded) {
      await withWorktreeRegistryLock(record.repoRoot, () => git(record.repoRoot, ['worktree', 'prune']))
    }

    // `pool-NN` worktrees in our container with no record: the record was lost.
    // A leased-looking one is adopted as leased (the next sweep decides), and
    // anything else as held. None is ever reset on this evidence alone.
    const known = new Set(survivors.map((slot) => comparablePath(slot.path)))
    const released = new Set(record.releasedPaths.map(comparablePath))
    for (const [key, entry] of registered) {
      if (known.has(key) || released.has(key)) continue
      if (comparablePath(dirname(entry.path)) !== comparablePath(pool.containerPath)) continue
      const name = basename(entry.path)
      if (!SLOT_NAME.test(name)) continue
      // A worktree merely NAMED like a slot (an agent or a person called it
      // `pool-01`) is not the pool's to adopt: only one the pool marked is.
      if (!(await hasSlotMarker(git, entry.path))) continue
      const leased = entry.branch !== null && entry.locked !== null && !entry.locked.startsWith('held: ')
      survivors.push({
        id: name,
        path: entry.path,
        state: leased ? 'leased' : 'held',
        baseRef: null,
        baseSha: null,
        error: null,
        lease: leased
          ? {
              leaseId: randomUUID(),
              branch: entry.branch!,
              owner: entry.branch!,
              agentId: null,
              leasedAt: now(),
              claimed: false,
            }
          : null,
        held: leased
          ? null
          : {
              reason: 'recovery',
              detail: 'found in the pool container without a record',
              changedPaths: null,
              branch: entry.branch,
              since: now(),
            },
        lastUsedAt: null,
        createdAt: now(),
        op: null,
        uses: 0,
        lastBranch: null,
        size: null,
      })
      log(`${entry.path}: adopted into the pool (${leased ? 'leased' : 'held'})`)
    }
    await withPool(pool, async () => {
      record.slots = survivors
      await persist(pool)
    })
    // Finished in the background: a lease waiting on recovery needs the
    // records settled, not these slots.
    void (async () => {
      for (const slot of toReturn) await returnSlot(pool, slot, true)
      for (const slot of toEvict) await evictSlot(pool, slot, 'resumed')
    })().catch((error: unknown) => log(`${record.repoRoot}: resuming after recovery failed: ${messageOf(error)}`))
  }

  // ── Held-slot actions ────────────────────────────────────────────────────

  async function heldAction(
    pool: PoolRuntime,
    slot: SlotRecord,
    action: 'commit' | 'stash' | 'discard' | 'keep',
    message: string | undefined,
  ): Promise<WorktreePoolActionResult> {
    if (slot.state !== 'held') return { ok: false, message: 'That worktree is not held.' }
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
    if (!began) return { ok: false, message: 'That worktree is busy.' }
    let outcome: WorktreePoolActionResult = { ok: true, message: null }
    try {
      const gitDir = await readSlotGitDir(git, slot.path)
      const operation = gitDir ? await operationInProgress(gitDir) : null
      if (action === 'keep') {
        await git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
        // No longer the pool's: nothing may ever adopt it back.
        await removeSlotMarker(git, slot.path).catch(() => {})
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
      const returned = await returnSlot(pool, slot)
      if (returned !== 'returned') {
        const after = slotById(pool, slot.id)
        return { ok: true, message: `Done, but the worktree is still held (${after?.held?.reason ?? returned}).` }
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

  async function snapshot(repoRoot: string): Promise<WorktreePoolSnapshot | null> {
    const pool = await poolFor(repoRoot, false)
    return pool ? snapshotOf(pool) : null
  }

  async function action(input: WorktreePoolActionInput): Promise<WorktreePoolActionResult> {
    const pool = await poolFor(input.repoRoot, false)
    if (!pool) return { ok: false, message: 'This repository has no worktree pool.' }
    if (!(await ready(pool))) return { ok: false, message: 'Another Studio is using this pool.' }
    const slot = slotById(pool, input.slotId)
    if (!slot) return { ok: false, message: 'No such worktree in the pool.' }
    if (input.kind === 'evict') {
      return (await evictSlot(pool, slot, 'by request'))
        ? { ok: true, message: 'Removed.' }
        : { ok: false, message: 'Only an idle, clean worktree can be removed.' }
    }
    if (input.kind === 'clear-ignored') return clearIgnored(pool, slot)
    return heldAction(pool, slot, input.action, input.message)
  }

  /**
   * Give a lease back at once: a launch that failed after its lease, or an
   * agent done with its worktree. `postponed`: something still runs in it, and
   * the cleanup returns it later; `busy`: another step holds the slot.
   */
  async function release(leaseId: string): Promise<'returned' | 'held' | 'postponed' | 'busy' | 'not-found'> {
    const found = findLease(leaseId)
    if (!found) return 'not-found'
    const outcome = await returnSlot(found.pool, found.slot)
    return outcome === 'skipped' ? 'busy' : outcome
  }

  /** The lease an agent took through MCP, by the slot path it was given. */
  function leaseAt(path: string): { leaseId: string; agentId: string | null; branch: string } | null {
    for (const pool of pools.values()) {
      const slot = pool.record.slots.find((candidate) => comparablePath(candidate.path) === comparablePath(path))
      if (slot?.lease) return { leaseId: slot.lease.leaseId, agentId: slot.lease.agentId, branch: slot.lease.branch }
    }
    return null
  }

  async function updateSettings(patch: Partial<WorktreePoolSettings>): Promise<WorktreePoolSettings> {
    const next = normalizePoolSettings({ ...(await getSettings()), ...patch })
    settings = next
    await deps.store.writeSettings(next)
    // A lower limit takes effect now, and the caller (Settings) sees the pools
    // it leaves behind.
    for (const pool of pools.values()) {
      if (pool.instance === 'held') await evictOverLimit(pool)
    }
    await enforceDiskLimit()
    return next
  }

  /** Whether a path is one of the pool's slots (the agent worktree cleanup hands those to the pool). */
  function ownsPath(path: string): boolean {
    for (const pool of pools.values()) {
      if (pool.record.slots.some((slot) => comparablePath(slot.path) === comparablePath(path))) return true
    }
    return false
  }

  async function shutdown(): Promise<void> {
    stopped = true
    if (heartbeat) clearInterval(heartbeat)
    for (const pool of pools.values()) {
      await pool.chain.catch(() => {})
      if (pool.instance === 'held') await releaseInstanceLock(pool.containerPath, instanceId)
    }
  }

  return {
    /** Read the records. Recovery waits for each pool's first use: nothing runs at start. */
    load,
    lease,
    bind,
    reclaim,
    release,
    returnUnused,
    leaseAt,
    action,
    snapshot,
    snapshots: async () => {
      await load()
      return [...pools.values()].map(snapshotOf)
    },
    getSettings,
    updateSettings,
    measure,
    ownsPath,
    shutdown,
  }
}
