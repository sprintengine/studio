import { createHash, randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'path'
import {
  agentLeaseKey,
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
import { agentWorktreeLockOwner, agentWorktreeLockReason, lockAgentWorktree } from '../agent-worktree-lock'
import {
  hiddenEditPaths,
  ignoredPathsAtRisk,
  insideAny,
  isChatTranscriptPath,
  pathInside,
  pathSpellings,
} from '../agent-worktree-keep-checks'
import type { GitWorktreeEntry } from '../git'
import { pathExists } from '../git-utils'
import { parseGitWorktreePorcelain } from '../git-worktree-list'
import { GIT_NETWORK_TIMEOUT_MS } from '../git-run'
import { withWorktreeRegistryLock } from '../worktree-registry-lock'
import { MEASURE_CONCURRENCY, measureDiskUsage, type MeasureDiskUsage } from './disk-usage'
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
  type SlotLease,
  type SlotRecord,
} from './pool-store'
import {
  amongIgnored,
  cleanWouldRemove,
  clearStaleIndexLock,
  commitIsReachable,
  defaultSlotGitRunner,
  fetchBase,
  hasFile,
  hasSlotMarker,
  ignoredPaths,
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
import { errorMessage as messageOf } from '../../shared/errors'

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
 * pool itself never installs dependencies. A project that opted in
 * (Settings ▸ Worktrees) has its install run on the lease, for the chat or
 * agent that asked and before it gets the worktree, when the lockfile changed
 * (dependency-install.ts); otherwise an agent that needs them runs its own
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
/** How much of git's message a note on a slot (or a log line) keeps: its end, where the reason is. */
const NOTE_TAIL_CHARS = 200
/** `pool-01` … `pool-999`: past that a container holds something other than slots, and no name is picked. */
const SLOT_NUMBER_LIMIT = 1000
const FETCH_FRESH_MS = 60_000
/**
 * How long after a failed fetch of the base leases go ahead without trying
 * again: offline, each try would hold a new chat up for the fetch's whole
 * deadline (LEASE_FETCH_TIMEOUT_MS).
 */
const FETCH_FAILURE_BACKOFF_MS = 5 * 60_000
const HEARTBEAT_INTERVAL_MS = 5 * 60_000
/**
 * How long quitting waits for the pool's steps in flight (a lease's fetch and
 * reset, a return) before it gives the container's lock up anyway. A step cut
 * short is what crash recovery exists for; a lock given up under a step still
 * running would let another Studio take over and "recover" a slot this one is
 * moving.
 */
const SHUTDOWN_WAIT_MS = 10_000
const SLOT_NAME = /^pool-(\d{2,})$/u

export type WorktreePoolServiceDeps = {
  store: PoolStore
  git?: SlotGitRunner
  /**
   * Where live work sits — terminals and the checkouts they observe, and the
   * folders chats are working in (`liveWorkPaths`): a slot one is in is never
   * recycled.
   */
  livePaths?: () => string[] | Promise<string[]>
  onChange?: (snapshot: WorktreePoolSnapshot) => void
  log?: (line: string) => void
  now?: () => number
  instanceId?: string
  lockDeps?: InstanceLockDeps
  /** Keep the instance lock's heartbeat running. Off in tests. */
  timers?: boolean
  /** How long one fetch of the base serves every lease that asks. */
  fetchFreshMs?: number
  /** How long after a failed fetch leases fork from the ref as it stands without fetching. */
  fetchBackoffMs?: number
  /** Copies the repository's `.worktreeinclude` set into a slot (git.ts). */
  seedIncludedFiles?: (repoRoot: string, slotPath: string) => Promise<unknown>
  /** How much disk a slot takes (disk-usage.ts). */
  measure?: MeasureDiskUsage
  /**
   * The ids of every chat on record, settled ones included (the workspace
   * registry), or null when unknown. A slot holding the history of one of them
   * is never removed (agent-worktree-keep-checks.ts).
   */
  knownWorkspaceIds?: () => Iterable<string> | null
}

export type WorktreePoolLeaseInput = {
  repoRoot: string
  /** The name the branch is derived from: `agent/<slug>`. */
  name: string
  /** Who the slot's lock names: the agent's id, or the branch while there is no agent yet. */
  owner?: string | null
  /** The agent that asked for the worktree itself (MCP), which keeps it while it exists. */
  agentId?: string | null
  /** The chat that agent is in: an agent id is unique only within its chat. */
  workspaceId?: string | null
  /** The machine the worktree is for; the pool serves only this machine's own git. */
  hostId?: string | null
  /** Copy the repository's `.worktreeinclude` set in, as a fresh worktree would. */
  copyIncludedFiles?: boolean
}

/** What a lease forks from, and why it may be behind the remote (the fetch failed, or was skipped after one that did). */
export type LeaseBase = { ref: string; sha: string; note: string | null }

export type WorktreePoolLeaseResult =
  | {
      ok: true
      leaseId: string
      slotId: string
      /** The project's main checkout, as the pool and its settings name it. */
      repoRoot: string
      path: string
      branch: string
      baseRef: string
      baseSha: string
      /** Set when `baseRef` could not be fetched for this lease: it is where the ref last stood. */
      baseNote: string | null
      /** The reason of the agent worktree lock placed on it, or null when locking failed. */
      lockReason: string | null
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
      /**
       * The base the pool had already resolved (and fetched) when it gave up:
       * the caller's fresh worktree forks from it instead of fetching again.
       */
      base?: LeaseBase
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
  /**
   * The same agents with their chats (`agentLeaseKey`), which a lease that
   * records its agent's chat is matched against: a bare id is unique only
   * within a chat, so another chat's `agent-1` must not keep this one's slot.
   * Left out or null: unknown, and every such slot is kept.
   */
  agentKeys?: ReadonlySet<string> | null
  dryRun?: boolean
}

type PoolRuntime = {
  record: PoolRecord
  containerPath: string
  chain: Promise<unknown>
  busy: Set<string>
  instance: 'unknown' | 'held' | 'foreign'
  fetch: Promise<LeaseBase> | null
  /** When the base's last fetch failed, while no fetch has succeeded since. Not persisted. */
  fetchFailedAt: number | null
  /** Recovery, run once this instance holds the pool's container. */
  recovered: Promise<void> | null
  /**
   * Slots the automatic eviction last kept for their ignored files, by the
   * verdict key they were kept under (`keptKey`): not checked again until it
   * changes. Not persisted.
   */
  keptVerdicts: Map<string, string>
}

type ResolvedRepo = { repoRoot: string; commonDir: string }

function tail(text: string | null | undefined, max = NOTE_TAIL_CHARS): string | null {
  const value = (text ?? '').trim()
  if (!value) return null
  return value.length > max ? `…${value.slice(-max)}` : value
}

/** Why a step that answers `{ ok, message }` failed, or null when it did not. */
function failureOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== false) return null
  return 'message' in result && typeof result.message === 'string' ? result.message : 'no reason given'
}

export type WorktreePoolService = ReturnType<typeof createWorktreePoolService>

export function createWorktreePoolService(deps: WorktreePoolServiceDeps) {
  const git = deps.git ?? defaultSlotGitRunner
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.info(`[worktree-pool] ${line}`))
  const instanceId = deps.instanceId ?? randomUUID()
  const fetchFreshMs = deps.fetchFreshMs ?? FETCH_FRESH_MS
  const fetchBackoffMs = deps.fetchBackoffMs ?? FETCH_FAILURE_BACKOFF_MS
  const measureSize = deps.measure ?? measureDiskUsage
  const pools = new Map<string, PoolRuntime>()
  const resolvedRepos = new Map<string, Promise<ResolvedRepo | null>>()
  let settings: WorktreePoolSettings | null = null
  let loaded: Promise<void> | null = null
  let stopped = false
  /** Aborts a disk measurement in progress when quitting begins. */
  const stopping = new AbortController()
  let heartbeat: NodeJS.Timeout | null = null
  /** Every public step still running, which quitting waits for (`shutdown`). */
  const inFlight = new Set<Promise<unknown>>()

  function track<T>(step: Promise<T>): Promise<T> {
    inFlight.add(step)
    void step.then(
      () => inFlight.delete(step),
      () => inFlight.delete(step),
    )
    return step
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  function withPool<T>(pool: PoolRuntime, work: () => Promise<T> | T): Promise<T> {
    const run = pool.chain.catch(() => {}).then(work)
    pool.chain = run.catch(() => {})
    return run
  }

  /**
   * Write the record, and tell the windows. `sizeOnly`: a measurement, which
   * the window that asked for it reads in its answer; announcing each one
   * would have an open Settings ▸ Worktrees re-read every worktree per slot.
   */
  async function persist(pool: PoolRuntime, options: { sizeOnly?: boolean } = {}): Promise<void> {
    await deps.store.write(pool.record)
    if (!options.sizeOnly) deps.onChange?.(snapshotOf(pool))
  }

  function slotById(pool: PoolRuntime, slotId: string): SlotRecord | undefined {
    return pool.record.slots.find((slot) => slot.id === slotId)
  }

  /**
   * Whether a live terminal or chat works inside `path`. Compared under every
   * spelling (agent-worktree-keep-checks.ts): a terminal opened through a
   * symlink to the container is still in the slot.
   */
  async function somethingRunsIn(path: string): Promise<boolean> {
    const live = ((await deps.livePaths?.()) ?? []).filter(Boolean)
    if (live.length === 0) return false
    const slotSpellings = await pathSpellings(path)
    for (const each of live) if (insideAny(await pathSpellings(each), slotSpellings)) return true
    return false
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
        fetchFailedAt: null,
        recovered: null,
        keptVerdicts: new Map(),
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
    if (!pool.recovered) {
      const recovering: Promise<void> = recoverPool(pool).catch((error: unknown) => {
        log(`${pool.record.repoRoot}: recovery failed: ${messageOf(error)}; it is tried again at the next use`)
        // Not remembered as done: a dead run's slots would stay as it left them.
        if (pool.recovered === recovering) pool.recovered = null
      })
      pool.recovered = recovering
    }
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
              workspaceId: slot.lease.workspaceId,
              leasedAt: slot.lease.leasedAt,
            }
          : null,
        held: slot.held ? { ...slot.held } : null,
        lastUsedAt: slot.lastUsedAt,
        uses: slot.uses,
        lastBranch: slot.lastBranch,
        size: slot.size,
        kept: slot.kept,
      })),
    }
  }

  // ── Holding a slot ────────────────────────────────────────────────────────

  /**
   * The lock git has on a worktree: its reason (empty when none was given),
   * null when it is not locked, undefined when the listing could not be read.
   */
  async function lockReasonOf(pool: PoolRuntime, path: string): Promise<string | null | undefined> {
    const listed = await git(pool.record.repoRoot, ['worktree', 'list', '--porcelain', '-z'])
    if (!listed.ok) return undefined
    const entry = parseGitWorktreePorcelain(listed.stdout).find(
      (candidate) => comparablePath(candidate.path) === comparablePath(path),
    )
    return entry?.locked ? (entry.lockedReason ?? '') : null
  }

  /**
   * Whether a lock is this pool's to lift: its own hold, or this profile's
   * agent lock. Slots live in a container every Studio profile shares, and
   * another profile's agent lock (or a person's) means someone else is using
   * the worktree, whatever this profile's record says.
   */
  function isOurLock(reason: string): boolean {
    return reason.startsWith('held: ') || agentWorktreeLockOwner(reason) === 'this-profile'
  }

  /** Lift a slot's lock when it is ours ({@link isOurLock}); anyone else's stays. */
  async function unlockIfOurs(pool: PoolRuntime, path: string): Promise<void> {
    const lock = await lockReasonOf(pool, path)
    if (lock !== null && lock !== undefined && isOurLock(lock)) {
      await git(pool.record.repoRoot, ['worktree', 'unlock', path])
    }
  }

  /**
   * Park a slot for a person to decide. The slot is (re)locked with the reason,
   * so the Worktree manager, the Git pane and git itself all see it is not to
   * be touched, and the agent worktree cleanup skips it. A lock that is not
   * ours (another profile's, a person's) is left as it is.
   */
  async function hold(
    pool: PoolRuntime,
    slot: SlotRecord,
    reason: WorktreePoolHeldReason,
    detail: string | null,
    extra: { changedPaths?: number | null; branch?: string | null } = {},
  ): Promise<void> {
    const branch = extra.branch ?? slot.lease?.branch ?? slot.held?.branch ?? null
    const lock = await lockReasonOf(pool, slot.path)
    if (lock === null || (lock !== undefined && isOurLock(lock))) {
      if (lock !== null) await git(pool.record.repoRoot, ['worktree', 'unlock', slot.path])
      await git(pool.record.repoRoot, ['worktree', 'lock', '--reason', `held: ${reason}`, slot.path])
    }
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

  /**
   * {@link hold} from a `catch`: a step already failed, and a hold that fails
   * too (its record could not be written) is logged rather than thrown over
   * the failure being handled.
   */
  async function holdAfterFailure(
    pool: PoolRuntime,
    slot: SlotRecord,
    detail: string,
    extra: { branch?: string | null } = {},
  ): Promise<void> {
    await hold(pool, slot, 'error', detail, extra).catch((error: unknown) =>
      log(`${slot.path}: could not hold after "${detail}": ${messageOf(error)}`),
    )
  }

  // ── Fetching the base ────────────────────────────────────────────────────

  /**
   * The commit a lease forks from: `origin/<default>` after at most one fetch
   * per pool per minute, shared by every lease that asks meanwhile. A failed
   * or slow fetch (offline, no credentials) falls back to what
   * `origin/<default>` already says, which is still the default branch, and
   * is not tried again for {@link FETCH_FAILURE_BACKOFF_MS}: offline, every
   * new chat would otherwise wait out the fetch's whole deadline. The base
   * then carries a note saying it may be behind the remote.
   *
   * `local` is where the ref stands before the fetch ({@link localBase}): a
   * lease prepares its slot there while the fetch runs. Never rejects: a fetch
   * that throws is a base at `local`, with the reason as its note.
   */
  function ensureBase(pool: PoolRuntime, local: { ref: string; sha: string }): Promise<LeaseBase> {
    if (pool.fetch) return pool.fetch
    const run = (async (): Promise<LeaseBase> => {
      const record = pool.record
      const ref = local.ref
      let note: string | null = null
      const stale = !record.lastFetchAt || now() - record.lastFetchAt >= fetchFreshMs
      const backingOff = pool.fetchFailedAt !== null && now() - pool.fetchFailedAt < fetchBackoffMs
      if (ref.includes('/') && stale && backingOff) {
        note = `${ref} was not fetched (the last fetch failed); forked from where it last stood`
      } else if (ref.includes('/') && stale) {
        const fetched = await fetchBase(git, record.repoRoot, ref)
        if (!fetched.ok) {
          log(`${record.repoRoot}: fetch of ${ref} failed (${tail(fetched.message)}); using the ref as it is`)
          note = `${ref} could not be fetched (${tail(fetched.message) ?? 'no reason given'}); forked from where it last stood`
        }
        pool.fetchFailedAt = fetched.ok ? null : now()
        await withPool(pool, async () => {
          if (fetched.ok) record.lastFetchAt = now()
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
      return sha ? { ref, sha, note } : { ...local, note: note ?? `${ref} could not be read after the fetch` }
    })().catch((error: unknown): LeaseBase => ({
      ...local,
      note: `${local.ref} could not be fetched (${messageOf(error)}); forked from where it last stood`,
    }))
    pool.fetch = run
    void run.then(() => {
      if (pool.fetch === run) pool.fetch = null
    })
    return run
  }

  /** `origin/<default>` (else the local default branch) and the commit it names now, before any fetch. */
  async function localBase(pool: PoolRuntime): Promise<{ ref: string; sha: string } | null> {
    const ref = (await resolvePoolBaseRef(git, pool.record.repoRoot)) ?? pool.record.defaultRef
    if (!ref) return null
    const sha = await revParseCommit(git, pool.record.repoRoot, ref)
    return sha ? { ref, sha } : null
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
    const lockVerdict = await clearStaleIndexLock(gitDir, !(await somethingRunsIn(slot.path)), now(), resumingOwnReset)
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
    // The ignored files as the tree stands before the move. A file whose
    // ignore rule the new base drops (an `.env.local` the old `.gitignore`
    // named) turns untracked with the move, and `clean -fd` below would
    // delete it as if it were the old tree's leftovers.
    const ignoredBefore = await ignoredPaths(git, slot.path)
    if (ignoredBefore === null) {
      await hold(pool, slot, 'error', 'could not list its ignored files before the reset')
      return false
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
        await hold(pool, slot, 'unexpected-head', `HEAD moved during the reset: ${tail(moved.message)}`)
        return false
      }
    }
    const reset = await git(slot.path, ['read-tree', '--reset', '-u', 'HEAD'])
    if (!reset.ok) {
      await hold(pool, slot, 'error', `reset failed: ${tail(reset.message)}`)
      return false
    }
    const removable = await cleanWouldRemove(git, slot.path)
    const wasIgnored = removable?.filter((path) => amongIgnored(path, ignoredBefore)) ?? null
    if (wasIgnored === null || wasIgnored.length > 0) {
      await hold(
        pool,
        slot,
        'dirty',
        wasIgnored === null
          ? 'could not check what cleaning up after the reset would remove'
          : `files the new base no longer ignores, which cleaning up would delete: ${wasIgnored.slice(0, 5).join(', ')}`,
        { changedPaths: wasIgnored?.length ?? null },
      )
      return false
    }
    const cleaned = await git(slot.path, ['clean', '-fd', '--quiet'])
    if (!cleaned.ok) {
      await hold(pool, slot, 'error', `clean failed: ${tail(cleaned.message)}`)
      return false
    }
    return true
  }

  /**
   * {@link resetSlot} for a lease in progress: the slot is recorded at
   * `target` once it is there, so a second move (the fetch moved the ref on)
   * checks it against where it now is, and its op is the lease's again.
   */
  async function moveSlot(pool: PoolRuntime, slot: SlotRecord, target: string): Promise<boolean> {
    if (!(await resetSlot(pool, slot, target))) return false
    await withPool(pool, async () => {
      slot.baseSha = target
      slot.op = { kind: 'lease', startedAt: now(), pid: process.pid }
      await persist(pool)
    })
    return true
  }

  // ── Leasing ──────────────────────────────────────────────────────────────

  async function nextSlotPath(pool: PoolRuntime): Promise<{ id: string; path: string } | null> {
    const taken = new Set(pool.record.slots.map((slot) => slot.id))
    const released = new Set(pool.record.releasedPaths.map(comparablePath))
    for (let n = 1; n < SLOT_NUMBER_LIMIT; n += 1) {
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
        kept: null,
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
    await writeSlotMarker(git, slot.path).catch((error: unknown) =>
      log(
        `${slot.path}: could not mark it as a slot (${messageOf(error)}); it is not adopted back if its record is lost`,
      ),
    )
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
    // Declined before any git runs: under a WSL machine's scope even the
    // repository lookup is that machine's git, and its answer (`/mnt/c/…`)
    // would be remembered for this computer's own leases of the folder.
    const declined = unsupportedHost(input.repoRoot, input.hostId)
    if (declined) return { ok: false, reason: 'unsupported', message: declined }
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
    const local = await localBase(pool)
    if (!local) return { ok: false, reason: 'no-base', message: 'This repository has no default branch to fork from.' }
    // The fetch and the slot's preparation overlap: the slot is made (or
    // reset) at where `origin/<default>` stands now while the fetch runs, and
    // moved on to the fetched commit only if the fetch moved the ref. A new
    // chat waits for the slower of the two, not for both.
    const fetching = ensureBase(pool, local)
    const owner = input.owner?.trim() || branch

    // Idle slots, the least recently used first: the slot a settled chat gave
    // back most recently is the last to go to someone else, so reopening that
    // chat finds its worktree still free to reclaim (`reclaim`).
    // Idle slots passed over for this lease (a terminal sits in one): it stays
    // idle, and picking it again would never get past it.
    const passedOver = new Set<string>()
    for (let attempt = 0; attempt <= POOL_MAX_SLOTS; attempt += 1) {
      let created = false
      let slot: SlotRecord | null = await withPool(pool, async () => {
        const picked = pool.record.slots
          .filter(
            (candidate) => candidate.state === 'idle' && !pool.busy.has(candidate.id) && !passedOver.has(candidate.id),
          )
          .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))[0]
        if (!picked) return null
        picked.state = 'leasing'
        pool.busy.add(picked.id)
        await persist(pool)
        return picked
      })
      if (!slot) {
        const made = await createSlot(pool, local)
        if (made === 'full') {
          const { maxSlots } = await getSettings()
          return {
            ok: false,
            reason: 'full',
            message: `The pool already has ${maxSlots} worktrees.`,
            base: await fetching,
          }
        }
        if (made === 'error') {
          return { ok: false, reason: 'error', message: 'Could not create a pool worktree.', base: await fetching }
        }
        slot = made
        created = true
      }

      try {
        if (!created) {
          if (await somethingRunsIn(slot.path)) {
            // Someone opened a terminal in an idle slot; it is not reset under them.
            passedOver.add(slot.id)
            await withPool(pool, async () => {
              slot!.state = 'idle'
              await persist(pool)
            })
            continue
          }
          if (!(await moveSlot(pool, slot, local.sha))) continue
        }
        const base = await fetching
        // The fetch moved the ref past where the slot was prepared: brought
        // along, with the same checks, so the fork is the freshly fetched
        // default branch.
        if (base.sha !== slot.baseSha && !(await moveSlot(pool, slot, base.sha))) {
          if (created) return { ok: false, reason: 'error', message: 'Could not move a new pool worktree.', base }
          continue
        }
        // Both talk to a remote, and the new chat waits on them: each has the
        // network deadline, and one that runs out is a note on the slot (the
        // agent can run it again), not a failed lease.
        const notes: string[] = []
        if (await hasFile(slot.path, '.gitmodules')) {
          const modules = await git(slot.path, ['submodule', 'update', '--init', '--recursive'], {
            timeoutMs: GIT_NETWORK_TIMEOUT_MS,
          })
          if (!modules.ok) notes.push(`submodules: ${tail(modules.message)}`)
        }
        if (await usesLfs(slot.path)) {
          const lfs = await git(slot.path, ['lfs', 'pull'], { timeoutMs: GIT_NETWORK_TIMEOUT_MS })
          if (!lfs.ok) notes.push(`lfs: ${tail(lfs.message)}`)
        }
        // `.worktreeinclude` names ignored files (an `.env`) the tree needs; a
        // reused slot still has the last copy, but the checkout's may have
        // changed since.
        if (input.copyIncludedFiles && deps.seedIncludedFiles) {
          const seeded = await deps.seedIncludedFiles(pool.record.repoRoot, slot.path).then(
            (result) => failureOf(result),
            (error: unknown) => messageOf(error),
          )
          if (seeded !== null)
            log(`${slot.path}: could not copy the .worktreeinclude files (${tail(seeded)}); leasing anyway`)
        }
        // Locked BEFORE the branch exists: from the moment the slot is on an
        // `agent/` branch, nothing else may remove it.
        const locked = await lockAgentWorktree(pool.record.repoRoot, slot.path, owner, git)
        if (!locked.ok) log(`${slot.path}: could not lock (${tail(locked.message)}); leasing anyway`)
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
          slot!.lease = {
            leaseId,
            branch,
            owner,
            agentId: input.agentId ?? null,
            workspaceId: input.agentId ? (input.workspaceId ?? null) : null,
            leasedAt: now(),
            claimed: false,
          }
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
          repoRoot: pool.record.repoRoot,
          path: slot.path,
          branch,
          baseRef: base.ref,
          baseSha: base.sha,
          baseNote: base.note,
          lockReason: locked.ok ? agentWorktreeLockReason(owner) : null,
          created,
          elapsedMs: now() - started,
        }
      } catch (error) {
        await holdAfterFailure(pool, slot, messageOf(error))
        if (created) return { ok: false, reason: 'error', message: messageOf(error), base: await fetching }
      } finally {
        pool.busy.delete(slot.id)
      }
    }
    return { ok: false, reason: 'error', message: 'No pool worktree passed its checks.', base: await fetching }
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
      if (slot.state === 'leased' && slot.lease?.branch === branch) return { kind: 'done' as const, slot }
      if (slot.state !== 'idle' || pool.busy.has(slot.id)) return { kind: 'refused' as const, other: slot }
      pool.busy.add(slot.id)
      slot.state = 'leasing'
      slot.op = { kind: 'lease', startedAt: now(), pid: process.pid }
      await persist(pool)
      return { kind: 'began' as const, slot }
    })
    if (began.kind === 'gone') return null
    if (began.kind === 'done') {
      // The record says it is already this chat's; the tree is asked too. A
      // record can be stale (another profile shares the container, a person
      // switched branches in it), and a chat opened on a worktree on some
      // other branch would work on someone else's checkout.
      const status = await readSlotStatus(git, began.slot.path)
      if (status.ok && status.status.branch === branch) return { ok: true }
      return {
        ok: false,
        message: status.ok
          ? `The worktree this chat used at ${input.path} is on ${status.status.branch ?? 'a detached HEAD'} now, not ${branch}.`
          : `Could not read the worktree this chat used at ${input.path}: ${status.message}`,
      }
    }
    if (began.kind === 'refused') {
      const other = began.other
      // Held with the chat's own branch still checked out (a return that found
      // its work uncommitted): that is this chat's worktree, as it left it, and
      // the chat opens on it so the work can be committed or discarded there.
      // It is leased to the chat again, so the Worktree manager no longer offers
      // to discard or return a folder the open chat works in, and the chat's
      // own return later holds it again if the work is still uncommitted.
      if (other.state === 'held' && other.held?.branch === branch) {
        const taken = await withPool(pool, async () => {
          if (other.state !== 'held' || other.held?.branch !== branch || pool.busy.has(other.id)) return false
          pool.busy.add(other.id)
          return true
        })
        if (taken) {
          try {
            const status = await readSlotStatus(git, other.path)
            if (status.ok && status.status.branch === branch) {
              await git(pool.record.repoRoot, ['worktree', 'unlock', other.path])
              const locked = await lockAgentWorktree(pool.record.repoRoot, other.path, input.owner, git)
              if (!locked.ok) log(`${other.path}: could not lock (${tail(locked.message)}); reclaiming anyway`)
              await withPool(pool, async () => {
                other.state = 'leased'
                other.op = null
                other.held = null
                other.error = null
                other.lease = {
                  leaseId: randomUUID(),
                  branch,
                  owner: input.owner,
                  agentId: null,
                  workspaceId: null,
                  leasedAt: now(),
                  claimed: false,
                }
                other.lastUsedAt = now()
                await persist(pool)
              })
              log(`${other.path}: held work given back to its chat on ${branch}`)
              return { ok: true }
            }
          } finally {
            pool.busy.delete(other.id)
          }
        }
      }
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
      // Commits made on the idle slot's detached HEAD since the pool left it
      // are on no branch: switching away would leave them to the reflog, which
      // the slot's eventual removal takes with it. Held, as eviction holds them.
      const from = status.status.oid
      if (from && slot.baseSha && from !== slot.baseSha && !(await commitIsReachable(git, slot.path, from))) {
        await hold(pool, slot, 'unexpected-head', 'found while giving it back to its chat: commits no branch has')
        return {
          ok: false,
          message: 'The worktree this chat used changed while it was in the pool; it is held in the Worktree manager.',
        }
      }
      // Another agent may have used the slot since, and left ignored files
      // (its build output, an `.env`) where the chat's branch tracks a file:
      // `switch` would overwrite them without a word, as a reset would.
      const tip = await revParseCommit(git, pool.record.repoRoot, `refs/heads/${branch}`)
      if (from && tip && from !== tip) {
        const inTheWay = await ignoredFilesInTheWay(git, slot.path, from, tip)
        if (inTheWay === null || inTheWay.length > 0) {
          await putBack()
          return {
            ok: false,
            message:
              inTheWay === null
                ? 'Could not check the worktree this chat used for ignored files its branch would overwrite.'
                : `The worktree this chat used has ignored files its branch would overwrite (${inTheWay.slice(0, 3).join(', ')}). Clear its ignored files in Settings ▸ Worktrees, then open the chat again.`,
          }
        }
      }
      const locked = await lockAgentWorktree(pool.record.repoRoot, slot.path, input.owner, git)
      if (!locked.ok) log(`${slot.path}: could not lock (${tail(locked.message)}); reclaiming anyway`)
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
          workspaceId: null,
          leasedAt: now(),
          claimed: false,
        }
        slot.lastUsedAt = now()
        await persist(pool)
      })
      log(`${slot.path}: given back to its chat on ${branch}`)
      return { ok: true }
    } catch (error) {
      await holdAfterFailure(pool, slot, messageOf(error))
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
    const putBack = async (): Promise<'postponed'> => {
      await withPool(pool, async () => {
        slot.state = began.from === 'leasing' ? 'returning' : began.from
        slot.op = null
        await persist(pool)
      })
      return 'postponed'
    }
    try {
      // The agent's terminal (or anyone's) is still in there: put it back as
      // it was, and the next sweep asks again.
      if (await somethingRunsIn(slot.path)) return await putBack()
      // Locked by another Studio profile (which adopted or leased it) or by a
      // person: theirs, whatever this profile's record says. Held for a person
      // to sort out, with their lock left on it; unreadable, asked again later.
      const lock = await lockReasonOf(pool, slot.path)
      if (lock === undefined) return await putBack()
      if (lock !== null && !isOurLock(lock)) {
        await hold(pool, slot, 'error', `locked by someone else (${lock || 'no reason given'})`, { branch })
        return 'held'
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
            await hold(pool, slot, 'error', `could not keep detached commits: ${tail(created.message)}`, {
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
          await hold(pool, slot, 'error', `could not detach: ${tail(detached.message)}`, { branch })
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
        slot.kept = null
        slot.lastUsedAt = now()
        await persist(pool)
      })
      log(`${slot.path}: returned clean${branch ? ` (${branch} kept)` : ''}`)
    } catch (error) {
      await holdAfterFailure(pool, slot, messageOf(error), { branch })
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

  /** Whether the agent that leased a slot through MCP is still in the app's records. */
  function agentStillHeld(lease: SlotLease, input: WorktreePoolReturnInput): boolean {
    if (lease.agentId === null) return false
    if (lease.workspaceId !== null) {
      return input.agentKeys == null || input.agentKeys.has(agentLeaseKey(lease.workspaceId, lease.agentId))
    }
    // A lease recorded before leases named their chat: the id alone.
    return input.agentIds == null || input.agentIds.has(lease.agentId)
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
      [...input.protectedPaths, ...((await deps.livePaths?.()) ?? [])]
        .filter(Boolean)
        .map((path) => pathSpellings(path)),
    )
    const entries: WorktreePoolSweepEntry[] = []
    for (const slot of [...pool.record.slots]) {
      // Quitting: the slots not reached yet are the next start's sweep's.
      if (stopped) break
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
        protectedSpellings.some((spellings) => insideAny(spellings, slotSpellings)) || agentStillHeld(lease, input)
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

  /**
   * Remove an idle slot from disk and from the pool. True when it is gone;
   * otherwise why not, worded for the person who asked (Settings): the slot is
   * left idle, or held when it turned out to hold work.
   *
   * `keptKey`: an automatic eviction's verdict key for the slot; a slot kept
   * for its ignored files is remembered under it (`keptVerdicts`).
   */
  async function evictSlot(
    pool: PoolRuntime,
    slot: SlotRecord,
    why: string,
    keptKey: string | null = null,
  ): Promise<true | string> {
    const putBack = async (kept: string | null = slot.kept): Promise<void> => {
      await withPool(pool, async () => {
        slot.state = 'idle'
        slot.op = null
        slot.kept = kept
        await persist(pool)
      })
    }
    const began = await withPool(pool, async () => {
      if (pool.busy.has(slot.id) || (slot.state !== 'idle' && slot.state !== 'evicting')) return false
      pool.busy.add(slot.id)
      slot.state = 'evicting'
      slot.op = { kind: 'evict', startedAt: now(), pid: process.pid }
      await persist(pool)
      return true
    })
    if (!began) return 'Only a worktree that is ready to reuse can be removed.'
    try {
      if (await somethingRunsIn(slot.path)) {
        await putBack()
        return 'A terminal is open in it. Close it first.'
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
          return 'It changed since it came back to the pool, and is held there now.'
        }
        // Commits made on the idle slot's detached HEAD (a person in a
        // terminal there) are on no branch, and removing the worktree takes
        // its HEAD reflog with it: they would be lost. Where the pool left
        // it is the pool's to drop; anywhere else, unreachable, is held.
        const oid = status.status.oid
        if (oid && oid !== slot.baseSha && !(await commitIsReachable(git, slot.path, oid))) {
          await hold(pool, slot, 'unexpected-head', 'found while evicting: commits no branch has')
          return 'It holds commits no branch has, and is held in the pool now.'
        }
        // Tracked files hidden from `status` (`--assume-unchanged`,
        // `--skip-worktree`): neither the read above nor git's own check at
        // removal sees their edits, which would go with the folder.
        const hidden = await hiddenEditPaths(slot.path, git)
        if (!hidden.ok || hidden.paths.length > 0) {
          await hold(
            pool,
            slot,
            'dirty',
            hidden.ok ? `edits hidden from git status: ${hidden.paths.slice(0, 5).join(', ')}` : hidden.message,
            { changedPaths: hidden.ok ? hidden.paths.length : null },
          )
          return 'It has edits git status does not show, and is held in the pool now.'
        }
        // Removing deletes the ignored files too, and the ones that may be
        // someone's work are kept as the agent worktree cleanup keeps them:
        // an edited `.env`, notes in an ignored folder (agent-worktree-keep-
        // checks.ts). The slot stays idle; clearing its ignored files, which a
        // person confirms, is the way to let them go.
        // What the app and the agent CLIs wrote there themselves (transcripts,
        // installed skills, the MCP config) and a linked `node_modules` are
        // not: Settings ▸ Worktrees shows why a slot stays.
        // A settled chat's slot is given back while the chat stays, and its
        // history lives in the slot's sidecar: such a slot waits for the chat
        // to be reopened (reclaimed) or deleted.
        const ignored = await ignoredPathsAtRisk(pool.record.repoRoot, slot.path, git, {
          knownWorkspaceIds: deps.knownWorkspaceIds ?? null,
        })
        if (!ignored.ok || ignored.paths.length > 0) {
          if (!ignored.ok) {
            await putBack('could not check its ignored files')
            log(`${slot.path}: kept (could not check its ignored files: ${ignored.message})`)
            return 'Could not check its ignored files, so it is kept.'
          }
          const chats = ignored.paths.filter(isChatTranscriptPath).length
          const files = ignored.paths.filter((path) => !isChatTranscriptPath(path))
          const more = files.length > 3 ? ` and ${files.length - 3} more` : ''
          const listedPaths = `${files.slice(0, 3).join(', ')}${more}`
          const reasons = [
            chats > 0 ? `holds the history of ${chats === 1 ? 'a chat' : `${chats} chats`} still on record` : null,
            files.length > 0 ? `has ignored files that may be someone’s work: ${listedPaths}` : null,
          ].filter((reason): reason is string => reason !== null)
          await putBack(reasons.join('; '))
          if (keptKey !== null) pool.keptVerdicts.set(slot.id, keptKey)
          log(`${slot.path}: kept (${reasons.join('; ')})`)
          return files.length > 0
            ? `It has ignored files that may be someone’s work (${listedPaths}). Clear its ignored files first if they can go.`
            : 'It holds the history of a chat still on record, which comes back to it when the chat is reopened. Delete the chat to let it go.'
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
          await hold(pool, slot, 'error', `could not remove: ${tail(removed.message)}`)
          return `Git could not remove it: ${tail(removed.message) ?? 'unknown error'}`
        }
      } else {
        await forgetRegistration(pool, slot.path)
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
    const chats = chatsKey()
    for (const slot of idle.slice(limit)) {
      if (stopped) return
      // Kept last time for the same reasons: every return and every settings
      // change would otherwise re-read each such slot's ignored files.
      const key = keptKey(slot, chats)
      if (pool.keptVerdicts.get(slot.id) === key) continue
      await evictSlot(pool, slot, 'over the idle limit', key)
    }
  }

  /** The chats on record, as one comparable string; a slot kept for one's history waits on this changing. */
  function chatsKey(): string {
    const ids = deps.knownWorkspaceIds?.()
    if (!ids) return 'unknown'
    return createHash('sha256')
      .update([...ids].sort().join('\0'))
      .digest('hex')
  }

  /**
   * What an automatic eviction's "kept" verdict on a slot rests on: when it
   * was last used (a lease and its return change what is in it) and which
   * chats are on record (one deleted lets its history go). Clearing the
   * slot's ignored files forgets the verdict outright.
   */
  function keptKey(slot: SlotRecord, chats: string): string {
    return `${slot.lastUsedAt ?? slot.createdAt}\0${chats}`
  }

  // ── Disk ─────────────────────────────────────────────────────────────────

  async function measureSlot(pool: PoolRuntime, slot: SlotRecord): Promise<void> {
    if (!(await pathExists(slot.path))) return
    if (stopped) return
    const size = await measureSize(slot.path, stopping.signal).catch(() => null)
    if (!size || stopped) return
    await withPool(pool, async () => {
      if (!pool.record.slots.includes(slot)) return
      slot.size = size
      await persist(pool, { sizeOnly: true })
    })
  }

  /**
   * Measure every slot of every pool this instance drives (or of one
   * repository's), a few at a time, then hold the pools to the disk limit.
   * Settings ▸ Worktrees asks; nothing else measures in bulk.
   *
   * Only pools this instance already holds: opening Settings must not take
   * every repository's container lock (and with it, until quit, every other
   * Studio's use of those pools) just to read sizes. The rest show the sizes
   * their records last stored.
   */
  async function measure(repoRoot?: string): Promise<void> {
    await load()
    const target = repoRoot ? await poolFor(repoRoot, false) : null
    const targets = repoRoot ? (target ? [target] : []) : [...pools.values()]
    const queue: Array<{ pool: PoolRuntime; slot: SlotRecord }> = []
    for (const pool of targets) {
      if (pool.instance !== 'held' || !(await ready(pool))) continue
      for (const slot of pool.record.slots) {
        if (slot.state !== 'creating' && slot.state !== 'evicting') queue.push({ pool, slot })
      }
    }
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next && !stopped; next = queue.shift()) await measureSlot(next.pool, next.slot)
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
    if (diskLimitGb === null || stopped) return
    const limit = diskLimitGb * 1024 ** 3
    const driven: PoolRuntime[] = []
    // Confirmed, not remembered: a pool whose lock went to another Studio is
    // that Studio's to evict from.
    for (const pool of pools.values()) if (pool.instance === 'held' && (await ready(pool))) driven.push(pool)
    let total = driven.reduce(
      (sum, pool) => sum + pool.record.slots.reduce((poolSum, slot) => poolSum + (slot.size?.bytes ?? 0), 0),
      0,
    )
    if (total <= limit) return
    const idle = driven
      .flatMap((pool) => pool.record.slots.map((slot) => ({ pool, slot })))
      .filter(({ pool, slot }) => slot.state === 'idle' && !pool.busy.has(slot.id))
      .sort((a, b) => (a.slot.lastUsedAt ?? a.slot.createdAt) - (b.slot.lastUsedAt ?? b.slot.createdAt))
    const chats = chatsKey()
    for (const { pool, slot } of idle) {
      if (total <= limit || stopped) break
      const bytes = slot.size?.bytes ?? 0
      const key = keptKey(slot, chats)
      if (pool.keptVerdicts.get(slot.id) === key) continue
      if ((await evictSlot(pool, slot, 'over the disk limit', key)) === true) total -= bytes
    }
  }

  /**
   * Delete an idle slot's ignored files (`git clean -fdX`): installed
   * dependencies, build output, caches. The slot stays in the pool, clean and
   * on its commit; the next agent in it installs from nothing.
   */
  async function clearIgnored(pool: PoolRuntime, slot: SlotRecord): Promise<WorktreePoolActionResult> {
    if (await somethingRunsIn(slot.path)) {
      return { ok: false, message: 'A terminal is open in that worktree. Close it first.' }
    }
    const began = await withPool(pool, async () => {
      if (pool.busy.has(slot.id) || slot.state !== 'idle') return false
      pool.busy.add(slot.id)
      return true
    })
    if (!began) return { ok: false, message: 'Only a worktree that is ready to reuse can be cleared.' }
    try {
      // Never the app's sidecar: it holds the history of chats that ran here,
      // which a settled chat reopened on this slot reads again. `-e` with a
      // negation takes the folder out of the ignored set for this run (a
      // pathspec exclusion does not stop `clean` removing an ignored folder).
      const cleaned = await git(slot.path, ['clean', '-fdX', '--quiet', '-e', '!/.sprintengine/'])
      if (!cleaned.ok) return { ok: false, message: cleaned.message ?? 'git clean failed.' }
      log(`${slot.path}: ignored files cleared`)
      await withPool(pool, async () => {
        slot.kept = null
        pool.keptVerdicts.delete(slot.id)
        await persist(pool)
      })
    } finally {
      pool.busy.delete(slot.id)
    }
    await measureSlot(pool, slot)
    return { ok: true, message: 'Cleared. The next agent in it runs the install from the start.' }
  }

  /**
   * Clear git's record of one slot whose folder is gone. `remove --force`
   * takes a registered worktree with no folder, and only that one: a `prune`
   * would forget every missing worktree of the repository, a person's own
   * on an unmounted volume included. A locked entry is refused, as `prune`
   * refuses it.
   */
  function forgetRegistration(pool: PoolRuntime, path: string): Promise<unknown> {
    return withWorktreeRegistryLock(pool.record.repoRoot, () =>
      git(pool.record.repoRoot, ['worktree', 'remove', '--force', path]),
    )
  }

  /**
   * Forget idle and held slots someone deleted from outside (a file manager,
   * `git worktree remove` in a terminal), and git's record of them. A leased
   * one's absence is its owner's business.
   */
  async function forgetSlotsGoneFromDisk(pool: PoolRuntime): Promise<void> {
    const gone: SlotRecord[] = []
    for (const slot of pool.record.slots) {
      if ((slot.state === 'idle' || slot.state === 'held') && !pool.busy.has(slot.id)) {
        if (!(await pathExists(slot.path))) gone.push(slot)
      }
    }
    if (gone.length === 0) return
    for (const slot of gone) {
      // A held slot is locked by the pool itself, and git never removes a locked worktree.
      if (slot.state === 'held') await unlockIfOurs(pool, slot.path)
      await forgetRegistration(pool, slot.path)
    }
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
    const listed = await git(record.repoRoot, ['worktree', 'list', '--porcelain', '-z'])
    if (!listed.ok) throw new Error(`git worktree list failed: ${tail(listed.message) ?? 'no reason given'}`)
    const registered = new Map<string, GitWorktreeEntry>()
    for (const entry of parseGitWorktreePorcelain(listed.stdout)) registered.set(comparablePath(entry.path), entry)

    const goneFromDisk: string[] = []
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
        if (slot.op?.kind === 'create' && onDisk && !entry && pathInside(slot.path, pool.containerPath)) {
          await rm(slot.path, { recursive: true, force: true }).catch(() => {})
        }
        if (entry && !onDisk) goneFromDisk.push(slot.path)
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
    for (const path of goneFromDisk) await forgetRegistration(pool, path)

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
      // Another Studio profile's lease: the container is shared, the records
      // are not. Adopting it would have this profile return (detach, unlock)
      // a worktree a chat of that profile is working in.
      if (entry.agentLock === 'other-profile') continue
      const leased = entry.branch !== null && entry.locked && !(entry.lockedReason ?? '').startsWith('held: ')
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
              workspaceId: null,
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
        kept: null,
      })
      log(`${entry.path}: adopted into the pool (${leased ? 'leased' : 'held'})`)
    }
    await withPool(pool, async () => {
      record.slots = survivors
      await persist(pool)
    })
    // Finished in the background: a lease waiting on recovery needs the
    // records settled, not these slots.
    void track(
      (async () => {
        // Quitting stops between slots: the rest stay as recorded, and the
        // next start's recovery resumes them.
        for (const slot of toReturn) if (!stopped) await returnSlot(pool, slot, true)
        for (const slot of toEvict) if (!stopped) await evictSlot(pool, slot, 'resumed')
      })(),
    ).catch((error: unknown) => log(`${record.repoRoot}: resuming after recovery failed: ${messageOf(error)}`))
  }

  // ── Held-slot actions ────────────────────────────────────────────────────

  async function heldAction(
    pool: PoolRuntime,
    slot: SlotRecord,
    action: 'commit' | 'stash' | 'discard' | 'keep',
    message: string | undefined,
  ): Promise<WorktreePoolActionResult> {
    if (slot.state !== 'held') return { ok: false, message: 'That worktree is not held.' }
    if (await somethingRunsIn(slot.path)) {
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
        await unlockIfOurs(pool, slot.path)
        // No longer the pool's: nothing may ever adopt it back.
        await removeSlotMarker(git, slot.path).catch((error: unknown) =>
          log(`${slot.path}: could not remove its slot mark (${messageOf(error)})`),
        )
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
      const evicted = await evictSlot(pool, slot, 'by request')
      return evicted === true ? { ok: true, message: 'Removed.' } : { ok: false, message: evicted }
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
    // Only while this instance still holds the pool: one that lost the lock
    // (another Studio judged it stale) must not move a slot that is now
    // someone else's.
    if (!(await ready(found.pool))) return 'busy'
    const outcome = await returnSlot(found.pool, found.slot)
    return outcome === 'skipped' ? 'busy' : outcome
  }

  /** The lease an agent took through MCP, by the slot path it was given. */
  function leaseAt(
    path: string,
  ): { leaseId: string; agentId: string | null; workspaceId: string | null; branch: string } | null {
    for (const pool of pools.values()) {
      const slot = pool.record.slots.find((candidate) => comparablePath(candidate.path) === comparablePath(path))
      if (slot?.lease) {
        const { leaseId, agentId, workspaceId, branch } = slot.lease
        return { leaseId, agentId, workspaceId, branch }
      }
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
      if (pool.instance === 'held' && (await ready(pool))) await evictOverLimit(pool)
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

  /**
   * Stop, wait up to `waitMs` (ten seconds unless the caller is short of time)
   * for the steps in flight, and give each pool's lock up.
   */
  async function shutdown(options: { waitMs?: number } = {}): Promise<void> {
    stopped = true
    stopping.abort()
    if (heartbeat) clearInterval(heartbeat)
    // Nothing new starts now (`ready` refuses); what already runs is waited
    // for, briefly, before the lock that keeps another Studio off it goes.
    // Until none is left, not just the ones running now: a recovery already
    // under way when quitting began still schedules its slot moves (`track`).
    if (inFlight.size > 0) {
      let timer: NodeJS.Timeout | null = null
      let timedOut = false
      const deadline = new Promise<void>((resolveWait) => {
        timer = setTimeout(() => {
          timedOut = true
          resolveWait()
        }, options.waitMs ?? SHUTDOWN_WAIT_MS)
        timer.unref?.()
      })
      while (inFlight.size > 0 && !timedOut) await Promise.race([Promise.allSettled([...inFlight]), deadline])
      if (timer) clearTimeout(timer)
    }
    for (const pool of pools.values()) {
      await pool.chain.catch(() => {})
      if (pool.instance === 'held') await releaseInstanceLock(pool.containerPath, instanceId)
    }
  }

  return {
    /** Read the records. Recovery waits for each pool's first use: nothing runs at start. */
    load,
    lease: (input: WorktreePoolLeaseInput) => track(lease(input)),
    reclaim: (input: Parameters<typeof reclaim>[0]) => track(reclaim(input)),
    release: (leaseId: string) => track(release(leaseId)),
    returnUnused: (input: WorktreePoolReturnInput) => track(returnUnused(input)),
    leaseAt,
    action: (input: WorktreePoolActionInput) => track(action(input)),
    snapshot,
    snapshots: async () => {
      await load()
      return [...pools.values()].map(snapshotOf)
    },
    getSettings,
    updateSettings: (patch: Partial<WorktreePoolSettings>) => track(updateSettings(patch)),
    measure: (repoRoot?: string) => track(measure(repoRoot)),
    ownsPath,
    shutdown,
  }
}
