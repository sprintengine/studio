import { isAbsolute } from 'node:path'
import { isRecord } from '../../shared/records'

// What a process that starts a Studio server hands it, what the server says
// back, and the exit codes that tell the starter whether to try again.
//
// The desktop's shell posts the envelope to its utility process as the first
// message on the control channel; a WSL distribution, an SSH host or a CI job
// writes it as the first line on the server's stdin. Either way the server
// reads one envelope, checks it here, and answers `ready` once its gateway is
// listening, or exits with one of the codes below.
//
// It lives beside the server rather than in a published protocol package: both
// ends are this app's own processes, built from one commit (the build stamp is
// checked), so it is not a surface another program codes against, and keeping
// it private keeps it free to change with the app.

/** The envelope's own version; a server refuses one it does not know (exit 64). */
export const SERVER_BOOTSTRAP_VERSION = 1

/**
 * Exit codes, from sysexits where one fits. The supervisor reads them to
 * decide whether starting again can help.
 */
export const SERVER_EXIT = {
  /** A clean shutdown. */
  ok: 0,
  /** The envelope was missing or invalid, or the command line was. */
  usage: 64,
  /** The data directory is missing, not writable, or owned by someone else. */
  dataDirUnusable: 65,
  /** Another live server holds the data directory's run lock. */
  dataDirBusy: 66,
  /** The shell and the server were built from different commits (a dev rebuild). */
  mismatch: 67,
  /** An uncaught error. */
  failed: 70,
  /** A failure that may pass: a listener's bind raced, too many open files. */
  temporary: 75,
} as const

export type ServerExitCode = (typeof SERVER_EXIT)[keyof typeof SERVER_EXIT]

/**
 * Whether a server that exited this way may be started again. A signal (a
 * crash, a kill) is retried; a code that says the directory, the envelope or
 * the build is wrong is not, because the next start would meet the same.
 */
export function serverExitRetryable(exit: { code: number | null; signal?: string | null }): boolean {
  if (exit.code === null) return true
  switch (exit.code) {
    case SERVER_EXIT.ok:
    case SERVER_EXIT.usage:
    case SERVER_EXIT.dataDirUnusable:
    case SERVER_EXIT.dataDirBusy:
    case SERVER_EXIT.mismatch:
      return false
    default:
      return true
  }
}

/** How the server seals what it keeps at rest (secrets section of the phase 6 spec). */
export type ServerSecretsMode =
  /**
   * The desktop shell is the cipher: `safeStorage` behind the control
   * channel, so every sealed file stays byte-identical to what an
   * in-process build writes. `available` is the shell's answer at fork time.
   */
  | { kind: 'shell'; available: boolean }
  /** An owner-only key file in `<dataDir>/run/` (0600 in a 0700 directory), for a server with no shell. */
  | { kind: 'key-file' }

export type ServerBootstrapEnvelope = {
  v: typeof SERVER_BOOTSTRAP_VERSION
  /** `desktop-local`: the app's own server, one per profile, gone when the app goes. */
  role: 'desktop-local' | 'headless'
  /** The app's userData on the desktop, unchanged, so no file moves when the server leaves main. */
  dataDir: string
  logsDir: string
  /** `<dataDir>/run`, created 0700: the run lock, sockets, the key file. */
  runDir: string
  tempDir: string
  paths: {
    resourcesDir: string | null
    appPath: string | null
    isPackaged: boolean
    /** The app binary: what the launcher pointer and the MCP fallback entry name. */
    appExecPath: string
    /** What `process.execPath` is inside a utility process (the Helper on macOS). */
    helperExecPath?: string
  }
  app: { version: string; buildStamp: string; channel: 'latest' | 'nightly' }
  /** Headless only: the hash of the owner token a first client presents. The desktop needs none. */
  owner: { tokenHash?: string }
  listeners: {
    gateway: boolean
    tailnet: 'from-settings' | 'off'
    /**
     * A WSL distribution's server (phase 7): open the front door's two doors,
     * loopback TCP when `loopback` and the stdio bridge's socket always, both
     * behind the mutual proof keyed by `owner.tokenHash`. Headless only, and
     * never beside a tailnet listener.
     */
    frontDoor?: { loopback: boolean }
  }
  secrets: ServerSecretsMode
  /** Set for a server inside a WSL distribution: which one, as the Windows side names it. */
  wsl?: { distro: string }
  /**
   * Set for a server that outlives whoever started it (an SSH machine's
   * managed server, phase 8): its starter's stdin ending is not its parent
   * gone, so it keeps running, and stops when a signal asks or when it has
   * been idle `idleMs` (no front-door connection and no chat working; null
   * keeps it running). It writes `run/server.json` for the next client to
   * find, and removes it when it stops.
   */
  detached?: {
    idleMs: number | null
    /** `bootstrap`: started by a desktop, which may upgrade it. Anything else is external and never replaced. */
    origin: 'bootstrap' | 'cli' | 'systemd' | 'launchd'
    /** The client that started it, as "Studio on dev-macbook-air", for Settings. */
    startedBy: string
  }
  /** `SPRINTENGINE_*` switches the server would otherwise read from its own environment. */
  flags: Record<string, boolean>
}

/**
 * The first thing a server started over stdio says, before it reads a byte:
 * the `sh` that exec'd it can no longer swallow the envelope as script, and
 * the starter learns where the server runs (its home and its own files) to
 * build an envelope with that machine's paths.
 */
export type ServerBoot = {
  t: 'boot'
  pid: number
  version: string
  buildStamp: string | null
  /** When this bundle was built: with `buildStamp`, which build it is (a WSL tree's `build.json` says the same). */
  builtAt: string | null
  /** `$HOME`, which a WSL starter's data directory is under. */
  home: string
  uid: number | null
  /** The Node this server runs on: what an agent's MCP bridge entry names. */
  execPath: string
  /** The directory the server's own bundle sits in. */
  appDir: string
}

/** Where a WSL server's front door listens, and what the edge needs to know about its paths. */
export type FrontDoorReady = {
  /** The loopback port on 127.0.0.1, or null when that door is off or did not open. */
  port: number | null
  /** The bridge's Unix socket, or null when it did not open. */
  socketPath: string | null
  /** Where the distribution mounts Windows drives (`/mnt/`), or null when automount is off. */
  driveMountRoot: string | null
}

/** The server's answer once its gateway is listening. */
export type ServerReady = {
  t: 'ready'
  pid: number
  environmentId: string
  version: string
  buildStamp: string
  gateway: { socketPath: string | null }
  tailnet: { bound: string | null }
  bootMs: number
  /** A WSL server's front door, when the envelope asked for one. */
  frontDoor?: FrontDoorReady
}

/** What the server says to whoever started it, beyond the requests and answers of the control RPC. */
export type ServerToSupervisor =
  | ServerBoot
  | ServerReady
  | { t: 'pong'; seq: number; loopLagMs: number; rssMb: number }
  | { t: 'shutdown-progress'; leg: string; done: number; total: number; durationMs: number; failed: boolean }
  | { t: 'fatal'; code: ServerExitCode; message: string }

/** What the supervisor says to the server, beyond the requests and answers of the control RPC. */
export type SupervisorToServer =
  | { t: 'envelope'; envelope: ServerBootstrapEnvelope }
  | { t: 'ping'; seq: number }
  | { t: 'shutdown'; drain: boolean; budgetMs: number }
  /** A client's port is transferred with this message: a window's, or the shell's own session. */
  | {
      t: 'attach-client'
      clientId: string
      windowId: string | null
      /**
       * A window's IPC tunnel; a chat view's Studio protocol connection (its
       * ticket follows as the answer to `studio.connect`); the shell's own
       * session, which offers its toolsets; or a stream on an SSH machine's
       * relay, which main holds (phase 8).
       */
      kind: 'desktop-window' | 'studio-connection' | 'shell' | 'ssh-stream'
      /** A workspace window (not Diagnostics or an aux view): the `workspace-windows` push target. */
      workspaceWindow?: boolean
    }
  | { t: 'detach-client'; clientId: string }

export type EnvelopeParseResult = { ok: true; envelope: ServerBootstrapEnvelope } | { ok: false; message: string }

const ROLES = new Set(['desktop-local', 'headless'])
const CHANNELS = new Set(['latest', 'nightly'])

/**
 * Check an envelope as it arrives. Paths must be absolute: a relative one
 * would resolve against whatever directory the server was started in, which
 * on a remote host is nobody's choice. Unknown fields are ignored, so a newer
 * shell can add one an older server does not read.
 */
export function parseServerBootstrapEnvelope(value: unknown): EnvelopeParseResult {
  const fail = (message: string): EnvelopeParseResult => ({ ok: false, message: `Bootstrap envelope: ${message}` })
  if (!isRecord(value)) return fail('not an object.')
  if (value.v !== SERVER_BOOTSTRAP_VERSION)
    return fail(`version ${String(value.v)} is not ${SERVER_BOOTSTRAP_VERSION}.`)
  if (typeof value.role !== 'string' || !ROLES.has(value.role)) return fail('role is missing or unknown.')
  for (const key of ['dataDir', 'logsDir', 'runDir', 'tempDir'] as const) {
    if (!absolutePath(value[key])) return fail(`${key} must be an absolute path.`)
  }
  const paths = value.paths
  if (!isRecord(paths)) return fail('paths is missing.')
  if (typeof paths.isPackaged !== 'boolean') return fail('paths.isPackaged must be true or false.')
  if (!absolutePath(paths.appExecPath)) return fail('paths.appExecPath must be an absolute path.')
  for (const key of ['resourcesDir', 'appPath'] as const) {
    if (paths[key] !== null && !absolutePath(paths[key])) return fail(`paths.${key} must be an absolute path or null.`)
  }
  if (paths.isPackaged && paths.resourcesDir === null) return fail('an installed build names its resources directory.')
  if (paths.helperExecPath !== undefined && !absolutePath(paths.helperExecPath)) {
    return fail('paths.helperExecPath must be an absolute path.')
  }
  const app = value.app
  if (!isRecord(app) || typeof app.version !== 'string' || !app.version) return fail('app.version is missing.')
  if (typeof app.buildStamp !== 'string') return fail('app.buildStamp is missing.')
  if (typeof app.channel !== 'string' || !CHANNELS.has(app.channel)) return fail('app.channel is unknown.')
  const owner = value.owner
  if (!isRecord(owner) || (owner.tokenHash !== undefined && typeof owner.tokenHash !== 'string')) {
    return fail('owner is malformed.')
  }
  const listeners = value.listeners
  if (!isRecord(listeners) || typeof listeners.gateway !== 'boolean') return fail('listeners.gateway is missing.')
  if (listeners.tailnet !== 'from-settings' && listeners.tailnet !== 'off') return fail('listeners.tailnet is unknown.')
  if (listeners.frontDoor !== undefined) {
    const door = listeners.frontDoor
    if (!isRecord(door) || typeof door.loopback !== 'boolean') return fail('listeners.frontDoor is malformed.')
    if (value.role !== 'headless') return fail('only a headless server opens a front door.')
    if (listeners.tailnet !== 'off') return fail('a server with a front door never listens on the tailnet.')
    if (typeof owner.tokenHash !== 'string' || !/^[0-9a-f]{64}$/u.test(owner.tokenHash))
      return fail('a front door needs the owner token hash its proofs are keyed by.')
  }
  if (value.detached !== undefined) {
    const detached = value.detached
    if (!isRecord(detached)) return fail('detached is malformed.')
    if (value.role !== 'headless') return fail('only a headless server runs detached.')
    if (detached.idleMs !== null && !(typeof detached.idleMs === 'number' && detached.idleMs > 0))
      return fail('detached.idleMs must be a positive number or null.')
    if (!['bootstrap', 'cli', 'systemd', 'launchd'].includes(String(detached.origin)))
      return fail('detached.origin is unknown.')
    if (typeof detached.startedBy !== 'string' || detached.startedBy.length > 200)
      return fail('detached.startedBy must be a short label.')
  }
  if (value.wsl !== undefined) {
    if (!isRecord(value.wsl) || typeof value.wsl.distro !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(value.wsl.distro))
      return fail('wsl.distro is not a distribution name.')
  }
  const secrets = value.secrets
  if (!isRecord(secrets)) return fail('secrets is missing.')
  if (secrets.kind === 'shell') {
    if (typeof secrets.available !== 'boolean') return fail('secrets.available must be true or false.')
    // Only the desktop has a shell to seal with; a headless server keeps its key file.
    if (value.role !== 'desktop-local') return fail('only the desktop-local server seals through the shell.')
  } else if (secrets.kind !== 'key-file') return fail('secrets.kind is unknown.')
  const flags = value.flags
  if (!isRecord(flags) || Object.values(flags).some((flag) => typeof flag !== 'boolean')) {
    return fail('flags must map names to true or false.')
  }
  return { ok: true, envelope: value as unknown as ServerBootstrapEnvelope }
}

function absolutePath(value: unknown): value is string {
  // Either platform's absolute form: the envelope is built on the host it is
  // read on, but a test may check a Windows envelope on a Mac.
  return typeof value === 'string' && value.length > 0 && (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value))
}
