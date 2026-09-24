import { createHash, randomUUID } from 'crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'fs/promises'
import { hostname } from 'os'
import { join } from 'path'
import {
  DEFAULT_WORKTREE_POOL_SETTINGS,
  WORKTREE_POOL_WARM_TARGET_MAX,
  type WorktreePoolDepsState,
  type WorktreePoolHeldReason,
  type WorktreePoolLeaseOwner,
  type WorktreePoolSettings,
  type WorktreePoolSlotState,
} from '../../shared/ipc/worktree-pool'
import { comparablePath, distroOfUncPath } from '../../shared/host-paths'

/**
 * The pool's durable records: one JSON file per pool under
 * `userData/worktree-pool/`, the settings beside them, and a lock file in each
 * pool's slot container that keeps a second Studio off the same slots.
 *
 * Every record is written whole, to a temporary file that is then renamed over
 * the old one, so a crash leaves either the previous record or the new one and
 * never half of each. A slot's `op` is written BEFORE the git step it names
 * starts and cleared after it ends, which is what lets startup tell a slot
 * that was mid-operation from one that was at rest (worktree-pool-service's
 * recovery).
 */

export const POOL_RECORD_VERSION = 2

export type SlotOp = {
  kind: 'create' | 'lease' | 'return' | 'refresh' | 'install' | 'evict' | 'held-action'
  startedAt: number
  pid: number
  /** For `refresh`: HEAD before the reset, and the commit it is being moved to. */
  fromSha?: string | null
  toSha?: string | null
}

export type SlotLease = {
  leaseId: string
  branch: string
  owner: WorktreePoolLeaseOwner
  leasedAt: number
  /**
   * Whether the owner has been seen in the workspace registry since the lease.
   * An owner that was never seen may simply not have been written yet (a window
   * records the agent after the lease returns), so only a lease whose owner was
   * seen and then vanished — or one never claimed for a long time — is
   * returned by the owner sweep.
   */
  ownerSeen: boolean
}

export type SlotHeld = {
  reason: WorktreePoolHeldReason
  detail: string | null
  changedPaths: number | null
  branch: string | null
  since: number
}

export type SlotRecord = {
  id: string
  path: string
  state: WorktreePoolSlotState
  baseRef: string | null
  baseSha: string | null
  refreshedAt: number | null
  depsFingerprint: string | null
  depsState: WorktreePoolDepsState
  installCommand: string | null
  error: string | null
  lease: SlotLease | null
  held: SlotHeld | null
  sizeBytes: number | null
  sizeMeasuredAt: number | null
  lastUsedAt: number | null
  createdAt: number
  op: SlotOp | null
}

export type PoolRecord = {
  version: number
  poolId: string
  repoRoot: string
  commonDir: string
  /** The execution host (shared/execution-host.ts) whose git and toolchain the slots belong to. */
  hostId: string
  disabled: boolean
  defaultRef: string | null
  lastFetchAt: number | null
  lastLeaseAt: number | null
  createdAt: number
  slots: SlotRecord[]
  /** Slot paths the person chose to keep as ordinary worktrees; never adopted back. */
  releasedPaths: string[]
}

/**
 * A folder on a network share (`\\\\server\\share\\…`) that is not a WSL
 * distribution: its git is slow and its locks unreliable, and the pool keeps
 * no slots there.
 */
export function isNetworkSharePath(repoRoot: string): boolean {
  return /^[\\/]{2}[^\\/]+[\\/]/u.test(repoRoot) && distroOfUncPath(repoRoot) === null
}

/**
 * One pool per (repository, execution host). The repository is its git common
 * dir, so every checkout of one repository shares a pool and two clones never
 * do; the host is the machine whose git makes the slots and whose toolchain
 * installs into them (`local`, or `wsl:<distro>` on Windows), so a Windows
 * pool and a WSL pool never share a slot or its native dependencies.
 */
export function poolIdFor(commonDir: string, hostId: string): string {
  return createHash('sha256')
    .update(`${comparablePath(commonDir)}\0${hostId}`)
    .digest('hex')
    .slice(0, 16)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SLOT_STATES = new Set<WorktreePoolSlotState>([
  'creating',
  'refreshing',
  'installing',
  'warm',
  'leasing',
  'leased',
  'returning',
  'held',
  'evicting',
])
const DEPS_STATES = new Set<WorktreePoolDepsState>(['none', 'ok', 'stale', 'installing', 'failed'])

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function parseSlot(value: unknown): SlotRecord | null {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const path = str(value.path)
  const state = value.state as WorktreePoolSlotState
  if (!id || !path || !SLOT_STATES.has(state)) return null
  const lease = isRecord(value.lease) ? value.lease : null
  const owner = lease && isRecord(lease.owner) ? lease.owner : null
  const held = isRecord(value.held) ? value.held : null
  const op = isRecord(value.op) ? value.op : null
  return {
    id,
    path,
    state,
    baseRef: str(value.baseRef),
    baseSha: str(value.baseSha),
    refreshedAt: num(value.refreshedAt),
    depsFingerprint: str(value.depsFingerprint),
    depsState: DEPS_STATES.has(value.depsState as WorktreePoolDepsState)
      ? (value.depsState as WorktreePoolDepsState)
      : 'stale',
    installCommand: str(value.installCommand),
    error: str(value.error),
    lease:
      lease && str(lease.leaseId) && str(lease.branch)
        ? {
            leaseId: str(lease.leaseId)!,
            branch: str(lease.branch)!,
            owner: { agentId: str(owner?.agentId), workspaceId: str(owner?.workspaceId) },
            leasedAt: num(lease.leasedAt) ?? Date.now(),
            ownerSeen: lease.ownerSeen === true,
          }
        : null,
    held: held
      ? {
          reason: (str(held.reason) as WorktreePoolHeldReason | null) ?? 'recovery',
          detail: str(held.detail),
          changedPaths: num(held.changedPaths),
          branch: str(held.branch),
          since: num(held.since) ?? Date.now(),
        }
      : null,
    sizeBytes: num(value.sizeBytes),
    sizeMeasuredAt: num(value.sizeMeasuredAt),
    lastUsedAt: num(value.lastUsedAt),
    createdAt: num(value.createdAt) ?? Date.now(),
    op:
      op && str(op.kind)
        ? {
            kind: op.kind as SlotOp['kind'],
            startedAt: num(op.startedAt) ?? 0,
            pid: num(op.pid) ?? 0,
            fromSha: str(op.fromSha),
            toSha: str(op.toSha),
          }
        : null,
  }
}

/** A pool record from disk, or null when the file is missing, unreadable or not one of ours. */
export function parsePoolRecord(text: string): PoolRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== POOL_RECORD_VERSION) return null
  const poolId = str(value.poolId)
  const repoRoot = str(value.repoRoot)
  const commonDir = str(value.commonDir)
  if (!poolId || !repoRoot || !commonDir || !Array.isArray(value.slots)) return null
  return {
    version: POOL_RECORD_VERSION,
    poolId,
    repoRoot,
    commonDir,
    hostId: str(value.hostId) ?? 'local',
    disabled: value.disabled === true,
    defaultRef: str(value.defaultRef),
    lastFetchAt: num(value.lastFetchAt),
    lastLeaseAt: num(value.lastLeaseAt),
    createdAt: num(value.createdAt) ?? Date.now(),
    slots: value.slots.map(parseSlot).filter((slot): slot is SlotRecord => slot !== null),
    releasedPaths: Array.isArray(value.releasedPaths)
      ? value.releasedPaths.filter((path): path is string => typeof path === 'string')
      : [],
  }
}

/** Write a file so a crash leaves the old content or the new, never a torn mix. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(temporary, content, 'utf8')
  // On Windows a rename over a file another process has open (a virus scanner,
  // an indexer) fails for a moment with EPERM or EBUSY; it is retried briefly.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < 4 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50 * (attempt + 1)))
        continue
      }
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
}

export type PoolStore = {
  dir: string
  readAll(): Promise<Array<{ poolId: string; record: PoolRecord | null }>>
  write(record: PoolRecord): Promise<void>
  readSettings(): Promise<WorktreePoolSettings>
  writeSettings(settings: WorktreePoolSettings): Promise<void>
}

export function normalizePoolSettings(input: Partial<WorktreePoolSettings> | null | undefined): WorktreePoolSettings {
  const base = DEFAULT_WORKTREE_POOL_SETTINGS
  const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback
  return {
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : base.enabled,
    warmTarget: clamp(input?.warmTarget, 0, WORKTREE_POOL_WARM_TARGET_MAX, base.warmTarget),
    diskCapGb: clamp(input?.diskCapGb, 1, 2000, base.diskCapGb),
    idleEvictionDays: clamp(input?.idleEvictionDays, 1, 365, base.idleEvictionDays),
  }
}

export function createPoolStore(userDataDir: string): PoolStore {
  const dir = join(userDataDir, 'worktree-pool')
  const settingsPath = join(dir, 'settings.json')
  // One write chain per file: two transitions of one pool in quick succession
  // land in order, and the later always wins.
  const chains = new Map<string, Promise<void>>()

  const chained = (path: string, content: string): Promise<void> => {
    const previous = chains.get(path) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        await mkdir(dir, { recursive: true })
        await writeFileAtomic(path, content)
      })
    chains.set(path, next)
    void next.finally(() => {
      if (chains.get(path) === next) chains.delete(path)
    })
    return next
  }

  return {
    dir,
    async readAll() {
      let names: string[] = []
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      const out: Array<{ poolId: string; record: PoolRecord | null }> = []
      for (const name of names) {
        const match = /^pool-([0-9a-f]{16})\.json$/u.exec(name)
        if (!match) continue
        const text = await readFile(join(dir, name), 'utf8').catch(() => null)
        out.push({ poolId: match[1], record: text === null ? null : parsePoolRecord(text) })
      }
      return out
    },
    write(record) {
      return chained(join(dir, `pool-${record.poolId}.json`), `${JSON.stringify(record, null, 2)}\n`)
    },
    async readSettings() {
      const text = await readFile(settingsPath, 'utf8').catch(() => null)
      if (text === null) return normalizePoolSettings(null)
      try {
        return normalizePoolSettings(JSON.parse(text) as Partial<WorktreePoolSettings>)
      } catch {
        return normalizePoolSettings(null)
      }
    },
    writeSettings(settings) {
      return chained(settingsPath, `${JSON.stringify(normalizePoolSettings(settings), null, 2)}\n`)
    },
  }
}

// ── The instance lock ────────────────────────────────────────────────────────
//
// Two Studios can open one repository: a second profile, a dev build beside the
// installed app. Their pool records live in their own userData, but their slots
// would live in the SAME container, and two services leasing `pool-01` at once
// is exactly the race the pool exists not to have. So the container carries a
// lock file, created with O_EXCL, naming the holder. A holder whose process is
// gone (same machine), or whose heartbeat stopped long ago, is stale and the
// lock is taken over.

export const POOL_LOCK_FILE = '.pool.lock'
export const POOL_LOCK_STALE_MS = 15 * 60_000
export const POOL_LOCK_PID_REUSE_MS = 24 * 60 * 60_000

type LockBody = { pid: number; host: string; instanceId: string; startedAt: number }

export type InstanceLockDeps = {
  pidAlive?: (pid: number) => boolean
  now?: () => number
  host?: string
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it is simply not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type InstanceLockResult = { ok: true } | { ok: false; holder: string }

/**
 * Take (or confirm) this instance's hold on a pool container. Idempotent for
 * the holder: a second call by the same instance succeeds and refreshes the
 * heartbeat.
 */
export async function acquireInstanceLock(
  containerPath: string,
  instanceId: string,
  deps: InstanceLockDeps = {},
): Promise<InstanceLockResult> {
  const pidAlive = deps.pidAlive ?? defaultPidAlive
  const now = deps.now ?? Date.now
  const host = deps.host ?? hostname()
  const lockPath = join(containerPath, POOL_LOCK_FILE)
  await mkdir(containerPath, { recursive: true })
  const body: LockBody = { pid: process.pid, host, instanceId, startedAt: now() }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify(body))
      } finally {
        await handle.close()
      }
      return { ok: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const text = await readFile(lockPath, 'utf8').catch(() => null)
    const info = await stat(lockPath).catch(() => null)
    let holder: Partial<LockBody> = {}
    try {
      holder = text ? (JSON.parse(text) as Partial<LockBody>) : {}
    } catch {
      holder = {}
    }
    if (holder.instanceId === instanceId) {
      await utimes(lockPath, new Date(), new Date()).catch(() => {})
      return { ok: true }
    }
    const age = info ? now() - info.mtimeMs : Number.POSITIVE_INFINITY
    const sameHost = holder.host === host && typeof holder.pid === 'number'
    const deadHere = sameHost && !pidAlive(holder.pid as number)
    // On this machine the holder's process is the whole truth: a live one keeps
    // the lock however old its heartbeat is (a laptop asleep for an hour stops
    // every timer, the holder's included). Age decides only for a holder on
    // another machine, whose process cannot be asked, and for a lock file too
    // torn to name anyone; an unreadable fresh one may be a holder mid-write.
    // A live pid on this machine whose heartbeat stopped a day ago is not a
    // sleeping Studio but a dead one whose pid was reused.
    const reusedPid = sameHost && age > POOL_LOCK_PID_REUSE_MS
    if (deadHere || reusedPid || (!sameHost && age > POOL_LOCK_STALE_MS)) {
      await rm(lockPath, { force: true })
      continue
    }
    return { ok: false, holder: `${holder.host ?? 'unknown host'} (pid ${holder.pid ?? '?'})` }
  }
  return { ok: false, holder: 'unknown' }
}

/**
 * Touch the lock so the other instance keeps seeing a live holder, and say
 * whether it is still ours. A holder that finds the lock gone or naming
 * someone else has lost the pool and must stop driving it (the caller steps
 * down to "held by another Studio").
 */
export async function heartbeatInstanceLock(
  containerPath: string,
  instanceId: string,
): Promise<'ours' | 'lost' | 'unknown'> {
  const lockPath = join(containerPath, POOL_LOCK_FILE)
  let text: string
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    // Gone is lost; a read that failed for any other reason (a scanner
    // holding the file on Windows) says nothing either way.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'lost' : 'unknown'
  }
  let holder: Partial<LockBody>
  try {
    holder = JSON.parse(text) as Partial<LockBody>
  } catch {
    return 'unknown'
  }
  if (holder.instanceId !== instanceId) return 'lost'
  await utimes(lockPath, new Date(), new Date()).catch(() => {})
  return 'ours'
}

export async function releaseInstanceLock(containerPath: string, instanceId: string): Promise<void> {
  const lockPath = join(containerPath, POOL_LOCK_FILE)
  const text = await readFile(lockPath, 'utf8').catch(() => null)
  if (!text) return
  try {
    if ((JSON.parse(text) as Partial<LockBody>).instanceId !== instanceId) return
  } catch {
    return
  }
  await rm(lockPath, { force: true }).catch(() => {})
}
