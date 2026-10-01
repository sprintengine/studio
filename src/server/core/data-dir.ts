import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'

import { isDataKeySealed } from '../platform/secret-cipher'

// One core per data directory, and a record of whose cipher seals its secrets.
//
// Two cores on one data directory would be two writers of every store in it,
// and the second gateway would unlink the first one's socket as it started
// (mcp-socket-server.ts assumes nobody else is listening). The desktop's own
// single-instance lock never covered that: it knows nothing of a server started
// from a shell. So every core takes `<dataDir>/run/studio.lock` before it
// builds a store, and a server started against a directory the app has open
// refuses instead of starting.
//
// The desktop seals secrets with the OS keychain; a standalone server with a
// data key of its own. Neither can open the other's ciphertext, and a server
// that sealed a secret into the desktop's files would leave the desktop unable
// to read it. So a directory remembers which kind sealed it, and a server
// shown a desktop's directory either refuses or runs with its secrets switched
// off, never opening or overwriting them.

export type StudioRole = 'desktop' | 'server'

export type DataDirHolder = {
  role: StudioRole
  pid: number
  hostname: string
  startedAt: string
}

export type DataDirLock = {
  readonly path: string
  /** Remove the lock if it is still this one's. Safe to call more than once. */
  release(): void
}

export type DataDirLockResult = { ok: true; lock: DataDirLock } | { ok: false; holder: DataDirHolder; message: string }

export type DataDirLockDeps = {
  pid?: number
  hostname?: string
  now?: () => Date
  /** Whether a process with this id is running on this machine. */
  isRunning?: (pid: number) => boolean
}

export const DATA_DIR_LOCK_FILE = join('run', 'studio.lock')

// A lock file that cannot be parsed is most likely one being written this
// instant. It is only treated as abandoned once it has been unreadable for
// longer than any write takes.
const UNREADABLE_LOCK_GRACE_MS = 10_000

type LockBody = DataDirHolder & { token: string }

/**
 * Take the data directory's run lock for this process.
 *
 * A lock left by a process that is no longer running (a crash, a force quit)
 * is taken over. One whose process is running, or that names another machine
 * (a data directory on a shared disk, where nothing here can tell), is not.
 * A server also refuses a directory whose Electron profile lock names a
 * running app: an app older than this lock holds only that one.
 */
export function acquireDataDirLock(dataDir: string, role: StudioRole, deps: DataDirLockDeps = {}): DataDirLockResult {
  const pid = deps.pid ?? process.pid
  const host = deps.hostname ?? osHostname()
  const isRunning = deps.isRunning ?? processIsRunning
  const path = join(dataDir, DATA_DIR_LOCK_FILE)

  if (role === 'server') {
    const app = runningElectronProfile(dataDir, host, isRunning)
    if (app) return refused(app, path)
  }

  mkdirSync(join(dataDir, 'run'), { recursive: true, mode: 0o700 })
  const body: LockBody = {
    role,
    pid,
    hostname: host,
    startedAt: (deps.now?.() ?? new Date()).toISOString(),
    token: randomUUID(),
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${JSON.stringify(body)}\n`, { flag: 'wx', mode: 0o600 })
      return { ok: true, lock: heldLock(path, body.token) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const existing = readLock(path)
    if (existing === 'unreadable') {
      if (!unreadableForLong(path)) return refused({ role: 'server', pid: 0, hostname: host, startedAt: '' }, path)
    } else if (existing && !isAbandoned(existing, { pid, host, isRunning })) {
      return refused(existing, path)
    }
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const holder = readLock(path)
  return refused(
    holder && holder !== 'unreadable' ? holder : { role: 'server', pid: 0, hostname: host, startedAt: '' },
    path,
  )
}

function heldLock(path: string, token: string): DataDirLock {
  let released = false
  return {
    path,
    release() {
      if (released) return
      released = true
      const current = readLock(path)
      // Never another process's: a lock this one lost (removed by hand, then
      // taken by someone else) stays theirs.
      if (!current || current === 'unreadable' || current.token !== token) return
      try {
        unlinkSync(path)
      } catch {
        // Gone already, or the directory went with it.
      }
    },
  }
}

function readLock(path: string): LockBody | 'unreadable' | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return 'unreadable'
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockBody>
    if (
      (parsed.role === 'desktop' || parsed.role === 'server') &&
      typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' &&
      typeof parsed.token === 'string'
    ) {
      return {
        role: parsed.role,
        pid: parsed.pid,
        hostname: parsed.hostname,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        token: parsed.token,
      }
    }
  } catch {
    // Falls through to unreadable.
  }
  return 'unreadable'
}

function unreadableForLong(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > UNREADABLE_LOCK_GRACE_MS
  } catch {
    return true
  }
}

function isAbandoned(
  holder: DataDirHolder,
  self: { pid: number; host: string; isRunning: (pid: number) => boolean },
): boolean {
  // Another machine's process cannot be asked about from here.
  if (holder.hostname !== self.host) return false
  // This process's own id: a crashed run whose id came round again, which in a
  // container that restarts its one process is every run.
  if (holder.pid === self.pid) return true
  return !self.isRunning(holder.pid)
}

/**
 * Electron's own profile lock, `SingletonLock`: a symbolic link to
 * `<hostname>-<pid>` that a running app keeps in its user data directory (on
 * macOS and Linux; Windows uses a named mutex and leaves no file).
 */
function runningElectronProfile(
  dataDir: string,
  host: string,
  isRunning: (pid: number) => boolean,
): DataDirHolder | null {
  let target: string
  try {
    target = readlinkSync(join(dataDir, 'SingletonLock'))
  } catch {
    return null
  }
  const separator = target.lastIndexOf('-')
  const pid = Number(target.slice(separator + 1))
  const lockHost = target.slice(0, separator)
  if (separator <= 0 || !Number.isInteger(pid) || pid <= 0) return null
  if (lockHost !== host || !isRunning(pid)) return null
  return { role: 'desktop', pid, hostname: lockHost, startedAt: '' }
}

function refused(holder: DataDirHolder, path: string): DataDirLockResult {
  const who =
    holder.pid > 0
      ? `${holder.role === 'desktop' ? 'SprintEngine Studio' : 'A Studio server'} (pid ${holder.pid}${holder.hostname ? ` on ${holder.hostname}` : ''})`
      : 'Another Studio process'
  return {
    ok: false,
    holder,
    message:
      `${who} has this data directory open. One Studio runs against a data directory at a time. ` +
      `If none is running, remove ${path} and start again.`,
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ── Whose cipher seals the directory's secrets ───────────────────────────────

/** `desktop-keychain`: Electron's `safeStorage`. `server-key`: a server's own data key. */
export type DataDirSecrets = 'desktop-keychain' | 'server-key'

export const DATA_DIR_RECORD_FILE = 'studio-data-dir.json'

/** Sealed files every desktop profile may hold, looked at when a directory carries no record. */
const SEALED_FILES = ['github-token.bin']
const SEALED_DIRECTORIES = ['provider-secrets', 'module-secrets']

/**
 * Which cipher seals this directory's secrets: its record, else what it holds.
 * A directory no build has recorded is a desktop's when Chromium has written
 * its profile files into it, or when any secret in it was sealed by something
 * other than a data key; otherwise nothing has sealed anything here yet.
 */
export function readDataDirSecrets(dataDir: string): DataDirSecrets | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, DATA_DIR_RECORD_FILE), 'utf8')) as { secrets?: unknown }
    if (parsed.secrets === 'desktop-keychain' || parsed.secrets === 'server-key') return parsed.secrets
  } catch {
    // No record, or one this build cannot read: look at what is there.
  }
  if (existsSync(join(dataDir, 'Local State'))) return 'desktop-keychain'
  const sealed = [
    ...SEALED_FILES.map((name) => join(dataDir, name)),
    ...SEALED_DIRECTORIES.flatMap((name) => {
      try {
        return readdirSync(join(dataDir, name))
          .filter((file) => file.endsWith('.bin'))
          .map((file) => join(dataDir, name, file))
      } catch {
        return []
      }
    }),
  ]
  for (const file of sealed) {
    try {
      if (!isDataKeySealed(readFileSync(file))) return 'desktop-keychain'
    } catch {
      // Not there, or not readable: says nothing either way.
    }
  }
  return null
}

/** Record which cipher seals this directory, unless one is recorded already. */
export function recordDataDirSecrets(dataDir: string, secrets: DataDirSecrets): void {
  const path = join(dataDir, DATA_DIR_RECORD_FILE)
  try {
    writeFileSync(path, `${JSON.stringify({ version: 1, secrets }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}
