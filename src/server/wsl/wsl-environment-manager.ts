import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'

import type { WslListing } from '../../main/hosts/wsl-distro'
import {
  buildBridgeScript,
  buildLaunchScript,
  serverTreeName,
  tarArgs,
  type AppPayload,
  type NeedReport,
} from '../../main/hosts/wsl-install'
import type { WslRunner } from '../../main/hosts/wsl-runner'
import { WslSetupError } from '../../main/hosts/wsl-setup-error'
import type { ServerBootstrapEnvelope } from '../bootstrap/envelope'
import { connectRemoteConversationBackend, type RemoteConversationBackend } from './backend-wire'
import { connectLoopback, openBridge } from './front-door-client'
import { enterFrontDoor, ownerTokenHash, type FrontDoorPurpose } from './front-door-proof'
import { startWslServer, wslServerPaths, type RunningWslServer, type WslServerStartDeps } from './wsl-server-starter'

// The Windows side's WSL servers (phase 7 spec, 5.2): one per distribution
// that has a chat to run, started on demand, reached through its front door,
// and let go when nothing has needed it for a while.
//
// Distributions are independent: each has its own server, data directory,
// transport and failure. One that cannot run a server says why and changes
// nothing for another.
//
// What a person sees of it is a status in words (`status`), which Settings ›
// Machines shows beside the distribution, and the reason a chat could not
// start when it could not.
//
// Lifetime:
// - `connect` starts the server, or reuses the running one. The starter's
//   stdin is the lease: a ping every fifteen seconds while it runs.
// - After `idleMs` (ten minutes) with no call and no chat working there, the
//   server is drained and stopped, so the VM can idle (decision R36).
// - A server that exits on its own is told apart by asking WSL: a
//   distribution now `Stopped` was shut down on purpose (`wsl --shutdown`,
//   `wsl --terminate`), and nothing starts it again until the person acts;
//   one still running crashed, and the next call restarts it after a backoff
//   that grows with each crash in a row.
// - Quitting drains every server for up to ten seconds, then lets the leases go.

export type WslServerTransport = 'loopback' | 'stdio'
export type WslServerState = 'stopped' | 'starting' | 'ready' | 'unavailable' | 'shut-down'

export type WslServerStatus = {
  distro: string
  state: WslServerState
  /** How the Windows side reaches it, while it is ready. */
  transport?: WslServerTransport
  /** Why that transport, in words ("loopback did not answer"). */
  transportReason?: string
  /** Why it is unavailable or shut down, in words a person can act on. */
  reason?: string
  environmentId?: string
}

/** One distribution's server as the router uses it. */
export type WslServerConnection = {
  distro: string
  backend: RemoteConversationBackend
  /** Where the distribution mounts Windows drives; null when automount is off. */
  driveMountRoot: string | null
  environmentId: string
  /** A fresh, admitted connection for `purpose` (the shell role's Studio connection). */
  open(purpose: FrontDoorPurpose): Promise<Duplex>
}

export type WslEnvironmentManagerDeps = {
  runner: WslRunner
  listDistros(options: { force: boolean }): Promise<WslListing>
  app: { version: string; buildStamp: string; channel: 'latest' | 'nightly' }
  /** The Windows profile's id; `isDefault` for the installed app's own profile (`data/`, decision R68). */
  profile: { id: string; isDefault: boolean }
  /** The server tree this build ships, packed; null when it shipped none. */
  payload(): AppPayload | null
  /**
   * The build identity in that tree's `build.json`, which the server's `boot`
   * must repeat. Null (a tree from before the file) skips the check; the
   * launch script's digest check still stands.
   */
  treeBuild?(): { builtAt: string } | null
  /** The pinned Node's digests, any of which an installed Node's marker may hold. */
  nodeDigests(): string[]
  installNode(distro: string, report: NeedReport): Promise<void>
  install(
    distro: string,
    input: { kind: 'server'; digest: string; argv: (id: string) => string[]; body: () => Buffer },
  ): Promise<void>
  /** `auto` tries loopback first; `stdio` always uses the bridge (`ExecutionHostSettings.serverTransport`). */
  transportFor(distro: string): 'auto' | 'stdio'
  onStatus?(status: WslServerStatus): void
  /** A new connection to a distribution's server (a start, a reconnect), for whoever follows its events. */
  onConnected?(connection: WslServerConnection): void
  log?(message: string): void
  idleMs?: number
  pingMs?: number
  now?: () => number
  /** Overrides for the start's deadlines (tests). */
  start?: Partial<Pick<WslServerStartDeps, 'bootTimeoutMs' | 'readyTimeoutMs' | 'maxAttempts' | 'sleep'>>
}

export type WslEnvironmentManager = {
  /** The distribution's server, started if it is not running. Throws a `WslSetupError` in words. */
  connect(distro: string): Promise<WslServerConnection>
  /** The running connection, or null; never starts anything. */
  current(distro: string): WslServerConnection | null
  status(distro: string): WslServerStatus
  statuses(): WslServerStatus[]
  /** Something used this distribution's chats: the idle clock starts again. */
  touch(distro: string): void
  /** Drain and stop one server (a setting moved), or all of them (quit). */
  stop(distro: string, options?: { budgetMs?: number }): Promise<void>
  shutdown(options?: { budgetMs?: number }): Promise<void>
}

const DEFAULT_IDLE_MS = 10 * 60_000
const DEFAULT_PING_MS = 15_000
const QUIT_DRAIN_MS = 10_000
const CRASH_BACKOFF_BASE_MS = 2_000
const CRASH_BACKOFF_MAX_MS = 30_000

/** The refusal a WSL 1 distribution gets (decision R70). */
export function wsl1Refusal(distro: string): string {
  return (
    `WSL: ${distro} runs on WSL 1, and chats there need WSL 2. ` +
    `Convert it with "wsl --set-version ${distro} 2" in a Windows terminal, then try again.`
  )
}

type Handle = {
  distro: string
  status: WslServerStatus
  server: RunningWslServer | null
  connection: WslServerConnection | null
  starting: Promise<WslServerConnection> | null
  /** The background reconnect after a lost wire, while it is `starting`. */
  reconnecting: Promise<WslServerConnection> | null
  token: string | null
  crashes: number
  retryAt: number
  idleTimer: ReturnType<typeof setTimeout> | null
  pingTimer: ReturnType<typeof setInterval> | null
  stopping: boolean
}

export function createWslEnvironmentManager(deps: WslEnvironmentManagerDeps): WslEnvironmentManager {
  const now = deps.now ?? Date.now
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS
  const pingMs = deps.pingMs ?? DEFAULT_PING_MS
  const log = deps.log ?? (() => undefined)
  const handles = new Map<string, Handle>()

  const handleOf = (distro: string): Handle => {
    let handle = handles.get(distro)
    if (!handle) {
      handle = {
        distro,
        status: { distro, state: 'stopped' },
        server: null,
        connection: null,
        starting: null,
        reconnecting: null,
        token: null,
        crashes: 0,
        retryAt: 0,
        idleTimer: null,
        pingTimer: null,
        stopping: false,
      }
      handles.set(distro, handle)
    }
    return handle
  }

  const setStatus = (handle: Handle, status: Omit<WslServerStatus, 'distro'>): void => {
    handle.status = { distro: handle.distro, ...status }
    try {
      deps.onStatus?.(handle.status)
    } catch {
      // A listener's failure is its own.
    }
  }

  const clearTimers = (handle: Handle): void => {
    if (handle.idleTimer) clearTimeout(handle.idleTimer)
    if (handle.pingTimer) clearInterval(handle.pingTimer)
    handle.idleTimer = null
    handle.pingTimer = null
  }

  const busy = (handle: Handle): boolean => {
    const listed = handle.connection?.backend.listSessions()
    if (!listed?.ok) return false
    return listed.sessions.some(
      (session) =>
        session.status === 'starting' ||
        session.status === 'active' ||
        session.status === 'awaiting_approval' ||
        session.turnStartedAt !== undefined ||
        (session.backgroundAgents ?? 0) > 0,
    )
  }

  const armIdle = (handle: Handle): void => {
    if (handle.idleTimer) clearTimeout(handle.idleTimer)
    handle.idleTimer = setTimeout(() => {
      handle.idleTimer = null
      if (!handle.server) return
      // A chat still working holds the lease; look again later.
      if (busy(handle)) {
        armIdle(handle)
        return
      }
      log(
        `Stopping the Studio server in ${handle.distro}: nothing has used it for ${Math.round(idleMs / 60_000)} minutes.`,
      )
      void stopHandle(handle, { budgetMs: QUIT_DRAIN_MS })
    }, idleMs)
    handle.idleTimer.unref?.()
  }

  async function checkDistro(distro: string): Promise<void> {
    const listing = await deps.listDistros({ force: false })
    if (!listing.distros) {
      throw new WslSetupError(
        'Couldn\'t set up WSL: WSL is not installed on this PC, or it did not answer. Install it with "wsl --install".',
        { fatal: true, code: 'wsl-missing' },
      )
    }
    const listed = listing.distros.find((entry) => entry.name === distro)
    if (!listed) {
      const fresh = await deps.listDistros({ force: true })
      if (!fresh.distros?.some((entry) => entry.name === distro))
        throw new WslSetupError(`Couldn't set up WSL: ${distro} is not installed on this PC.`, {
          fatal: true,
          code: 'distro-missing',
        })
      return checkDistro(distro)
    }
    if (listed.version === 1) throw new WslSetupError(wsl1Refusal(distro), { fatal: true, code: 'start' })
  }

  function envelopeFor(
    handle: Handle,
    token: string,
    boot: Parameters<WslServerStartDeps['envelopeFor']>[0],
  ): ServerBootstrapEnvelope {
    const paths = wslServerPaths(boot.home, deps.profile)
    const appDir = boot.appDir.replace(/\/+$/u, '')
    if (!appDir.endsWith(`/${serverTreeName(deps.app.version)}`))
      throw new Error(`it runs from ${appDir}, not this app version's server tree.`)
    // The envelope's build stamp is empty (the desktop's own stamp is not the
    // tree's), so the build is checked here instead: the launch script's digest
    // check and its exec are not one step, and another copy of the app of the
    // same version can replace the tree in between. Not fatal: the next
    // attempt's launch script sees the other digest and installs this one.
    const expected = deps.treeBuild?.() ?? null
    if (expected && boot.builtAt !== expected.builtAt)
      throw new WslSetupError(
        `The Studio server in ${handle.distro} is another build of version ${deps.app.version} (built ${boot.builtAt ?? 'at an unknown time'}, not ${expected.builtAt}); another copy of the app installed it. This build's server is installed again.`,
        { fatal: false, code: 'start' },
      )
    return {
      v: 1,
      role: 'headless',
      dataDir: paths.dataDir,
      logsDir: paths.logsDir,
      runDir: paths.runDir,
      tempDir: paths.tempDir,
      paths: {
        resourcesDir: `${appDir}/resources`,
        appPath: appDir,
        isPackaged: true,
        appExecPath: boot.execPath,
      },
      app: deps.app,
      owner: { tokenHash: ownerTokenHash(token) },
      listeners: {
        gateway: true,
        tailnet: 'off',
        frontDoor: { loopback: deps.transportFor(handle.distro) !== 'stdio' },
      },
      secrets: { kind: 'key-file' },
      flags: {},
      wsl: { distro: handle.distro },
    }
  }

  /** An admitted stream for `purpose`: loopback first when allowed, the bridge when it fails or is forced. */
  async function openDoor(
    handle: Handle,
    purpose: FrontDoorPurpose,
  ): Promise<{ stream: Duplex; transport: WslServerTransport; reason: string }> {
    const server = handle.server
    const token = handle.token
    if (!server || !token) throw new Error(`The Studio server in ${handle.distro} is not running.`)
    const door = server.ready.frontDoor
    if (!door) throw new Error(`The Studio server in ${handle.distro} opened no front door.`)
    let reason = 'the bridge is chosen in Settings'
    if (deps.transportFor(handle.distro) !== 'stdio') {
      if (door.port === null) reason = 'the loopback door did not open in the distribution'
      else {
        try {
          const socket = await connectLoopback(door.port)
          return {
            stream: await enterFrontDoor(socket, { token, purpose }),
            transport: 'loopback',
            reason: 'loopback answered',
          }
        } catch (error) {
          // A squatter's decoy fails the proof here, and gets nothing.
          reason = `loopback did not work (${error instanceof Error ? error.message : String(error)})`
          log(`The Studio server in ${handle.distro}: ${reason}; using the stdio bridge.`)
        }
      }
    }
    if (!door.socketPath) throw new Error(`The Studio server in ${handle.distro} has no bridge socket, and ${reason}.`)
    const bridged = await openBridge(
      () => deps.runner.spawnShell(handle.distro),
      buildBridgeScript(deps.app.version),
      door.socketPath,
    )
    return { stream: await enterFrontDoor(bridged, { token, purpose }), transport: 'stdio', reason }
  }

  async function connectBackend(handle: Handle): Promise<WslServerConnection> {
    const server = handle.server!
    const { stream, transport, reason } = await openDoor(handle, 'backend')
    const backend = connectRemoteConversationBackend(stream, { log })
    await backend.refresh()
    const connection: WslServerConnection = {
      distro: handle.distro,
      backend,
      driveMountRoot: server.ready.frontDoor?.driveMountRoot ?? null,
      environmentId: server.ready.environmentId,
      open: async (purpose) => (await openDoor(handle, purpose)).stream,
    }
    backend.onClose((why) => {
      if (handle.connection !== connection) return
      handle.connection = null
      if (handle.stopping || !handle.server) return
      // The server is still there but the wire went: one reconnect, then the
      // server is stopped and the next call starts it afresh.
      log(`The connection to the Studio server in ${handle.distro} closed (${why}); reconnecting.`)
      // Held as the start in progress, so a call meanwhile waits for this
      // reconnect instead of opening a second wire beside it.
      const reconnecting = (handle.starting ??= connectBackend(handle).finally(() => {
        if (handle.starting === reconnecting) handle.starting = null
        if (handle.reconnecting === reconnecting) handle.reconnecting = null
      }))
      handle.reconnecting = reconnecting
      void reconnecting.then(
        () => undefined,
        (error: unknown) => {
          // The server itself went meanwhile: its exit has said why.
          if (handle.server !== server) return
          setStatus(handle, {
            state: 'unavailable',
            reason: `The connection to the Studio server in ${handle.distro} was lost: ${error instanceof Error ? error.message : String(error)}`,
          })
          server.kill()
        },
      )
    })
    handle.connection = connection
    setStatus(handle, {
      state: 'ready',
      transport,
      transportReason: reason,
      environmentId: server.ready.environmentId,
    })
    try {
      deps.onConnected?.(connection)
    } catch (error) {
      log(`A WSL server listener threw: ${error instanceof Error ? error.message : String(error)}`)
    }
    return connection
  }

  async function onServerExit(
    handle: Handle,
    server: RunningWslServer,
    exit: { code: number | null; stderrTail: string; intentional: boolean },
  ): Promise<void> {
    if (handle.server !== server) return
    handle.server = null
    handle.token = null
    // A wire lost because the server died is not reconnected: the next call
    // starts a server (or is told when it will), not waits on a dead one.
    if (handle.reconnecting && handle.starting === handle.reconnecting) handle.starting = null
    handle.reconnecting = null
    const connection = handle.connection
    handle.connection = null
    clearTimers(handle)
    connection?.backend.close()
    if (exit.intentional || handle.stopping) {
      setStatus(handle, { state: 'stopped' })
      return
    }
    // Every Linux process dies at once on `wsl --shutdown`; WSL then lists
    // the distribution as stopped. That is the person's doing, and is left be.
    const listing = await deps.listDistros({ force: true }).catch(() => null)
    const state = listing?.distros?.find((entry) => entry.name === handle.distro)?.state
    if (state && /^stopped$/iu.test(state)) {
      setStatus(handle, {
        state: 'shut-down',
        reason: `WSL was shut down, so the Studio server in ${handle.distro} stopped. It starts again with the next message.`,
      })
      return
    }
    handle.crashes++
    const wait = Math.min(CRASH_BACKOFF_MAX_MS, CRASH_BACKOFF_BASE_MS * 2 ** (handle.crashes - 1))
    handle.retryAt = now() + wait
    const tail = exit.stderrTail.trim().split('\n').slice(-2).join(' ')
    setStatus(handle, {
      state: 'unavailable',
      reason: `The Studio server in ${handle.distro} stopped unexpectedly (${tail || `exit ${exit.code ?? 'unknown'}`}). It starts again with the next message.`,
    })
    log(`The Studio server in ${handle.distro} exited (code ${exit.code ?? 'none'}): ${tail}`)
  }

  async function start(handle: Handle): Promise<WslServerConnection> {
    if (handle.retryAt > now()) {
      throw new WslSetupError(
        `The Studio server in ${handle.distro} stopped a moment ago; it is tried again in ${Math.ceil((handle.retryAt - now()) / 1000)} s.`,
        { fatal: false, code: 'start' },
      )
    }
    setStatus(handle, { state: 'starting', reason: `Starting WSL: ${handle.distro}…` })
    try {
      await checkDistro(handle.distro)
      const payload = deps.payload()
      if (!payload)
        throw new WslSetupError(
          "Couldn't set up WSL: this build shipped without the Studio server for WSL (run npm run build:server:wsl in a checkout).",
          { fatal: true, code: 'install' },
        )
      const token = `seown_${randomBytes(32).toString('base64url')}`
      handle.token = token
      const server = await startWslServer({
        distro: handle.distro,
        spawnShell: () => deps.runner.spawnShell(handle.distro),
        launchScript: async () =>
          buildLaunchScript({
            appVersion: deps.app.version,
            nodeDigests: deps.nodeDigests(),
            appDigest: payload.digest,
            profile: deps.profile.id,
            entry: 'server',
          }),
        install: async (report) => {
          if (report.node) await deps.installNode(handle.distro, report)
          if (report.app)
            await deps.install(handle.distro, {
              kind: 'server',
              digest: payload.digest,
              argv: (id) => tarArgs('app', id),
              body: () => payload.tarGz,
            })
        },
        prewarm: async () => {
          await deps.runner.runScript(handle.distro, 'true', { timeoutMs: 60_000 })
        },
        envelopeFor: (boot) => envelopeFor(handle, token, boot),
        log,
        ...deps.start,
      })
      handle.server = server
      server.onExit((exit) => void onServerExit(handle, server, exit))
      handle.pingTimer = setInterval(() => server.ping(), pingMs)
      handle.pingTimer.unref?.()
      const connection = await connectBackend(handle)
      handle.crashes = 0
      armIdle(handle)
      return connection
    } catch (error) {
      const failure =
        error instanceof WslSetupError
          ? error
          : new WslSetupError(
              `The Studio server in ${handle.distro} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
              { fatal: false, code: 'start' },
            )
      const server = handle.server
      handle.server = null
      handle.token = null
      clearTimers(handle)
      server?.kill()
      setStatus(handle, { state: 'unavailable', reason: failure.message })
      throw failure
    }
  }

  async function stopHandle(handle: Handle, options: { budgetMs?: number } = {}): Promise<void> {
    await handle.starting?.catch(() => undefined)
    const server = handle.server
    if (!server) return
    handle.stopping = true
    clearTimers(handle)
    try {
      await server.stop({ drain: true, budgetMs: options.budgetMs ?? QUIT_DRAIN_MS })
    } finally {
      handle.stopping = false
      if (handle.server === server) {
        handle.server = null
        handle.connection?.backend.close()
        handle.connection = null
        handle.token = null
        setStatus(handle, { state: 'stopped' })
      }
    }
  }

  return {
    connect(distro) {
      const handle = handleOf(distro)
      if (handle.connection && handle.server) {
        armIdle(handle)
        return Promise.resolve(handle.connection)
      }
      handle.starting ??= (handle.server ? connectBackend(handle) : start(handle)).finally(() => {
        handle.starting = null
      })
      return handle.starting
    },
    current: (distro) => {
      const handle = handles.get(distro)
      return handle?.server ? handle.connection : null
    },
    status: (distro) => handles.get(distro)?.status ?? { distro, state: 'stopped' },
    statuses: () => [...handles.values()].map((handle) => handle.status),
    touch(distro) {
      const handle = handles.get(distro)
      if (handle?.server) armIdle(handle)
    },
    stop: (distro, options) => {
      const handle = handles.get(distro)
      return handle ? stopHandle(handle, options) : Promise.resolve()
    },
    async shutdown(options = {}) {
      await Promise.all([...handles.values()].map((handle) => stopHandle(handle, options).catch(() => undefined)))
    },
  }
}
