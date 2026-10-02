import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
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
  /** Whether the file still names this lock: false once another process has taken it over. */
  isHeld(): boolean
  /** Remove the lock if it is still this one's. Safe to call more than once. */
  release(): void
}

export type DataDirLockResult =
  | {
      ok: true
      lock: DataDirLock
      /** A holder that was still running, or could not be asked, and was displaced (`takeOver`). */
      displaced: DataDirHolder | null
    }
  | { ok: false; holder: DataDirHolder; message: string }

/** The file operations the lock makes, so a suite can fail one the way a full or locked disk does. */
export type DataDirLockFs = {
  mkdirSync: typeof mkdirSync
  writeFileSync: typeof writeFileSync
  linkSync: typeof linkSync
  renameSync: typeof renameSync
  unlinkSync: typeof unlinkSync
}

export type DataDirLockDeps = {
  pid?: number
  hostname?: string
  now?: () => Date
  /** Whether a process with this id is running on this machine. */
  isRunning?: (pid: number) => boolean
  /**
   * Whether to displace a holder that would otherwise refuse this process: one
   * still running, one on another machine, or one whose file cannot be read.
   */
  takeOver?: (holder: DataDirHolder) => boolean
  fs?: Partial<DataDirLockFs>
}

export const DATA_DIR_LOCK_FILE = join('run', 'studio.lock')

// A lock file that cannot be parsed was damaged (this build never leaves a
// partial one: it is written whole under another name, then linked into
// place). It is still only treated as abandoned once it has been unreadable
// for longer than any write takes, in case an older writer is mid-write.
const UNREADABLE_LOCK_GRACE_MS = 10_000

/** Who an unreadable lock file is, as far as anyone can tell. */
const UNKNOWN_HOLDER: DataDirHolder = { role: 'server', pid: 0, hostname: '', startedAt: '' }

type LockBody = DataDirHolder & { token: string }

/**
 * Take the data directory's run lock for this process.
 *
 * A lock left by a process that is no longer running (a crash, a force quit)
 * is taken over. One whose process is running, or that names another machine
 * (a data directory on a shared disk, where nothing here can tell), is not,
 * unless `takeOver` says so. A server also refuses a directory whose Electron
 * profile lock names a running app: an app older than this lock holds only
 * that one.
 *
 * The lock is written whole to a file of its own and then linked into place,
 * so a disk that fills mid-write leaves no half-written lock behind to refuse
 * every later start. File errors other than "already there" are thrown.
 */
export function acquireDataDirLock(dataDir: string, role: StudioRole, deps: DataDirLockDeps = {}): DataDirLockResult {
  const pid = deps.pid ?? process.pid
  const host = deps.hostname ?? osHostname()
  const isRunning = deps.isRunning ?? processIsRunning
  const fs: DataDirLockFs = { mkdirSync, writeFileSync, linkSync, renameSync, unlinkSync, ...deps.fs }
  const path = join(dataDir, DATA_DIR_LOCK_FILE)

  if (role === 'server') {
    const app = runningElectronProfile(dataDir, host, isRunning)
    if (app) return refused(app, path)
  }

  fs.mkdirSync(join(dataDir, 'run'), { recursive: true, mode: 0o700 })
  const body: LockBody = {
    role,
    pid,
    hostname: host,
    startedAt: (deps.now?.() ?? new Date()).toISOString(),
    token: randomUUID(),
  }
  const staged = `${path}.${body.token}`
  try {
    fs.writeFileSync(staged, `${JSON.stringify(body)}\n`, { flag: 'wx', mode: 0o600 })
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(staged, path)
        return { ok: true, lock: heldLock(path, body.token, fs), displaced: null }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const existing = readLock(path)
      const holder = existing === 'unreadable' ? UNKNOWN_HOLDER : existing
      const abandoned =
        existing === null ||
        (existing === 'unreadable' ? unreadableForLong(path) : isAbandoned(existing, { pid, host, isRunning }))
      if (holder && !abandoned) {
        if (!deps.takeOver?.(holder)) return refused(holder, path)
        // Displaced in one step: the file never goes missing in between, so a
        // third process cannot slip in.
        fs.renameSync(staged, path)
        return { ok: true, lock: heldLock(path, body.token, fs), displaced: holder }
      }
      try {
        fs.unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const holder = readLock(path)
    return refused(holder && holder !== 'unreadable' ? holder : UNKNOWN_HOLDER, path)
  } finally {
    try {
      fs.unlinkSync(staged)
    } catch {
      // Renamed into place, or never written. A staged copy cut short by a
      // full disk goes here too.
    }
  }
}

function heldLock(path: string, token: string, fs: Pick<DataDirLockFs, 'unlinkSync'>): DataDirLock {
  let released = false
  const isHeld = (): boolean => {
    const current = readLock(path)
    return current !== null && current !== 'unreadable' && current.token === token
  }
  return {
    path,
    isHeld,
    release() {
      if (released) return
      released = true
      // Never another process's: a lock this one lost (taken over by the
      // desktop, or removed by hand and taken by someone else) stays theirs.
      if (!isHeld()) return
      try {
        fs.unlinkSync(path)
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
  const recorded = readRecord(join(dataDir, DATA_DIR_RECORD_FILE))
  if (recorded) return recorded
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

/** What the record file says, or null when it is missing or damaged. */
function readRecord(path: string): DataDirSecrets | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { secrets?: unknown }
    if (parsed.secrets === 'desktop-keychain' || parsed.secrets === 'server-key') return parsed.secrets
  } catch {
    // Missing, cut short, or not ours.
  }
  return null
}

/**
 * Record which cipher seals this directory, unless one is recorded already.
 * Written whole under another name and renamed into place, so a crash or a
 * full disk never leaves half a record; a record that is there but damaged
 * (from a build before that) is written again.
 */
export function recordDataDirSecrets(dataDir: string, secrets: DataDirSecrets): void {
  const path = join(dataDir, DATA_DIR_RECORD_FILE)
  if (readRecord(path)) return
  const staged = `${path}.${randomUUID()}`
  try {
    writeFileSync(staged, `${JSON.stringify({ version: 1, secrets }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(staged, path)
  } finally {
    try {
      unlinkSync(staged)
    } catch {
      // Renamed into place.
    }
  }
}

/**
 * Make the data directory its owner's alone (0700). Created that way, but a
 * directory that already existed keeps whatever mode it had; this narrows it.
 * Answers false where it could not (another owner, a file system without
 * modes), for the caller to warn about. A no-op on Windows, where the
 * directory's ACL is inherited from the profile.
 */
export function restrictDataDir(dataDir: string): boolean {
  if (process.platform === 'win32') return true
  try {
    if ((statSync(dataDir).mode & 0o077) !== 0) chmodSync(dataDir, 0o700)
    return (statSync(dataDir).mode & 0o077) === 0
  } catch {
    return false
  }
}
