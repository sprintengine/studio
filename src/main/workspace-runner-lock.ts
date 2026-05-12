import { randomUUID } from 'crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'

type RunnerLockOwner = {
  pid: number
  workspaceRoot: string
  appInstanceId: string
  createdAt: string
  heartbeatAt: string
}

type HeldRunnerLock = {
  workspaceRoot: string
  lockDir: string
  ownerPath: string
  owner: RunnerLockOwner
  heartbeat: NodeJS.Timeout | null
}

type RunnerLockAcquireResult =
  | { ok: true; lock: HeldRunnerLock }
  | { ok: false; message: string }

const APP_INSTANCE_ID = randomUUID()
const HEARTBEAT_MS = 5_000
const STALE_HEARTBEAT_MS = 20_000

const heldLocks = new Map<string, HeldRunnerLock>()

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot)
}

function lockDirForWorkspace(workspaceRoot: string): string {
  return join(normalizeWorkspaceRoot(workspaceRoot), '.multi-code', 'runtime', 'runner.lock')
}

function ownerPathForLock(lockDir: string): string {
  return join(lockDir, 'owner.json')
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    return code === 'EPERM'
  }
}

async function readOwner(ownerPath: string): Promise<RunnerLockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(ownerPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const owner = parsed as Partial<RunnerLockOwner>
    if (
      typeof owner.pid !== 'number'
      || typeof owner.workspaceRoot !== 'string'
      || typeof owner.appInstanceId !== 'string'
      || typeof owner.createdAt !== 'string'
      || typeof owner.heartbeatAt !== 'string'
    ) {
      return null
    }
    return owner as RunnerLockOwner
  } catch {
    return null
  }
}

async function isStaleLock(lockDir: string, ownerPath: string): Promise<boolean> {
  const owner = await readOwner(ownerPath)
  if (!owner) return true
  if (!isPidAlive(owner.pid)) return true

  const heartbeatMs = Date.parse(owner.heartbeatAt)
  if (Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs > STALE_HEARTBEAT_MS) {
    return true
  }

  try {
    const lockStats = await stat(lockDir)
    return Date.now() - lockStats.mtimeMs > STALE_HEARTBEAT_MS
  } catch {
    return true
  }
}

async function writeOwner(ownerPath: string, owner: RunnerLockOwner): Promise<void> {
  await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, 'utf8')
}

async function removeLockDir(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true })
}

function startHeartbeat(lock: HeldRunnerLock): void {
  lock.heartbeat = setInterval(() => {
    lock.owner.heartbeatAt = new Date().toISOString()
    void writeOwner(lock.ownerPath, lock.owner).catch(() => {})
  }, HEARTBEAT_MS)
  lock.heartbeat.unref()
}

export async function acquireWorkspaceRunnerLock(workspaceRoot: string): Promise<RunnerLockAcquireResult> {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot)
  const existing = heldLocks.get(normalizedRoot)
  if (existing) return { ok: true, lock: existing }

  const lockDir = lockDirForWorkspace(normalizedRoot)
  const ownerPath = ownerPathForLock(lockDir)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(dirname(lockDir), { recursive: true })
      await mkdir(lockDir, { recursive: false })
      const now = new Date().toISOString()
      const lock: HeldRunnerLock = {
        workspaceRoot: normalizedRoot,
        lockDir,
        ownerPath,
        owner: {
          pid: process.pid,
          workspaceRoot: normalizedRoot,
          appInstanceId: APP_INSTANCE_ID,
          createdAt: now,
          heartbeatAt: now,
        },
        heartbeat: null,
      }
      await writeOwner(ownerPath, lock.owner)
      startHeartbeat(lock)
      heldLocks.set(normalizedRoot, lock)
      return { ok: true, lock }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
      if (code !== 'EEXIST') {
        return { ok: false, message: error instanceof Error ? error.message : 'Unable to acquire runner lock.' }
      }
      if (await isStaleLock(lockDir, ownerPath)) {
        await removeLockDir(lockDir)
        continue
      }
      const owner = await readOwner(ownerPath)
      const ownerText = owner ? `pid ${owner.pid}` : 'another process'
      return { ok: false, message: `Switchboard runner is already owned by ${ownerText}.` }
    }
  }

  return { ok: false, message: 'Unable to acquire Switchboard runner lock.' }
}

export async function releaseWorkspaceRunnerLock(workspaceRoot: string): Promise<void> {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot)
  const lock = heldLocks.get(normalizedRoot)
  if (!lock) return

  heldLocks.delete(normalizedRoot)
  if (lock.heartbeat) clearInterval(lock.heartbeat)
  await removeLockDir(lock.lockDir)
}

export async function releaseAllWorkspaceRunnerLocks(): Promise<void> {
  const locks = [...heldLocks.values()]
  heldLocks.clear()
  await Promise.all(locks.map(async (lock) => {
    if (lock.heartbeat) clearInterval(lock.heartbeat)
    await removeLockDir(lock.lockDir)
  }))
}
