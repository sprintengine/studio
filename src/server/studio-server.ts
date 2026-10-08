import { mkdirSync } from 'node:fs'

import { isWslHostId } from '../shared/execution-host'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../shared/product-identity'
import { resolveSocketPath } from '../main/automation/automation-service'
import {
  createStudioCore,
  StudioDataDirBusyError,
  StudioDataDirUnusableError,
  studioBridgeScriptPath,
  type StudioCore,
} from './core/studio-core'
import { createStudioGateway, type StudioGateway } from './core/studio-gateway'
import { createStudioRpc } from './core/studio-rpc'
import type { StudioRpcService } from '../main/studio-rpc/studio-rpc-service'
import { readDataDirSecrets, restrictDataDir } from './core/data-dir'
import { createNodeStudioPlatform, type NodeStudioPlatform } from './platform/platform'
import { createUnavailableSecretCipher } from './platform/secret-cipher'
import { SERVER_EXIT } from './bootstrap/envelope'
import { runShutdownLegs, type ShutdownLegProgress } from './bootstrap/serve'
import { readStudioEnvironmentId } from '../main/studio-rpc/studio-rpc-service'
import type { WebFrontDoor, WebFrontDoorOptions } from './web/web-front-door'

// A Studio server under plain Node: the core and its gateway, with nothing of
// Electron. The `studio-server` entry (main.ts) runs it from a shell; a later
// phase's desktop spawns it with the same options handed over on stdin.
//
// Startup is: the data directory exists → whose cipher seals it is settled →
// the platform is built and installed → the core takes the run lock and builds
// its stores → the gateway binds its socket and writes its discovery files →
// the Studio RPC binds the owner socket → ready. Shutdown is the reverse: the
// RPC first (it audits into the gateway's log), then the gateway, so no call
// starts on a core that is closing, then the core.

export type StudioServerOptions = {
  dataDir: string
  logsDir: string
  version: string
  /**
   * Whether this is an installed build. Required: an installed build trusts
   * only what it shipped, so a guess of "source checkout" would fail open.
   */
  packaged: boolean
  resourcesDir?: string | null
  appRoot?: string | null
  /**
   * Run against a data directory the desktop's keychain sealed, with the
   * server's own secrets off: provider keys and tokens saved there read as not
   * set, and a key set here lasts until the server stops. Without it such a
   * directory is refused.
   */
  shareDesktopDataDir?: boolean
  /**
   * The data directory's lock was taken from this server: the desktop app
   * opened the directory, and wins it. The server stops itself; this says so.
   */
  onDataDirLost?: () => void
  /** Where a warning that does not stop the server goes (the entry: stderr). */
  log?: (message: string) => void
  /**
   * Open the gateway's socket and the owner socket. Off for a server started
   * only to be driven over its control channel (the seam tests); default on.
   */
  listen?: boolean
  /**
   * Serve the web client on a loopback port (phase 9). Off unless given: a
   * server nobody opened a browser to answers no HTTP.
   */
  web?: WebFrontDoorOptions | null
  /**
   * Where this Studio runs, as its owner socket's welcome says: a server in a
   * WSL distribution, or one an SSH machine runs detached. `local` when not said.
   */
  hostKind?: 'local' | 'wsl' | 'ssh'
}

export type StudioServerReady = {
  pid: number
  version: string
  dataDir: string
  /** The gateway's socket (a named pipe on Windows), or null when it could not start. */
  gatewaySocket: string | null
  /** The Studio RPC's owner socket, or null when it could not start (its status says why). */
  rpcSocket: string | null
  /** False when the data directory's secrets cannot be opened here (a shared desktop directory). */
  secrets: boolean
  /** The web listener's loopback URL, when it was asked for and started. */
  web: string | null
}

export type StudioServer = {
  core: StudioCore
  gateway: StudioGateway
  rpc: StudioRpcService
  platform: NodeStudioPlatform
  /** The web listener, when `web` was given. */
  web: WebFrontDoor | null
  ready: StudioServerReady
  /**
   * Stop the RPC, the gateway, then the core, saying each leg as it ends.
   * Safe to call more than once; later calls wait on the first.
   */
  stop(onLeg?: (progress: ShutdownLegProgress) => void): Promise<void>
}

/** Why a server could not start, and the process exit code that says so (sysexits, as the supervisor reads them). */
export class StudioServerStartError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message)
    this.name = 'StudioServerStartError'
  }
}

// The codes the bootstrap envelope documents (bootstrap/envelope.ts), under
// the names this file and the entry have always used.
export const EXIT_USAGE = SERVER_EXIT.usage
export const EXIT_DATA_DIR_UNUSABLE = SERVER_EXIT.dataDirUnusable
export const EXIT_DATA_DIR_BUSY = SERVER_EXIT.dataDirBusy
export const EXIT_FAILED = SERVER_EXIT.failed

// How often a server checks that the data directory's lock is still its own.
// The desktop that took it waits for this server to exit, so this is most of
// how long the app's gateway waits at its start.
const LOCK_WATCH_MS = 500

// What the bundle loads from node_modules on the first chat rather than at
// start (build:server leaves dependencies out of it): Claude Code's chats and
// every ACP agent's. Looked for at start, so a bundle copied away from the
// checkout or app it was built in fails there, by name, and not at a chat.
const RUNTIME_PACKAGES = ['@anthropic-ai/claude-agent-sdk', '@agentclientprotocol/sdk']

/**
 * Baked in by scripts/build-server.mjs: true for the WSL tree, which inlines
 * every dependency, the runtime packages included, so there is nothing to
 * look for beside it.
 */
declare const __STUDIO_SERVER_SELF_CONTAINED__: boolean | undefined

/** The runtime packages this process cannot resolve from where its code is. */
export function missingRuntimePackages(resolve: (name: string) => unknown = require.resolve): string[] {
  if (typeof __STUDIO_SERVER_SELF_CONTAINED__ !== 'undefined' && __STUDIO_SERVER_SELF_CONTAINED__) return []
  return RUNTIME_PACKAGES.filter((name) => {
    try {
      resolve(name)
      return false
    } catch {
      return true
    }
  })
}

export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const missing = missingRuntimePackages()
  if (missing.length > 0) {
    throw new StudioServerStartError(
      `${missing.join(' and ')} cannot be found from ${__dirname}. The server loads its dependencies from the ` +
        'node_modules beside the checkout or app it was built in; run it from there (or point NODE_PATH at one).',
      EXIT_FAILED,
    )
  }
  try {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
    mkdirSync(options.logsDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new StudioServerStartError(
      `The data directory ${options.dataDir} cannot be used: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_DATA_DIR_UNUSABLE,
    )
  }
  // Created owner-only, but a directory that was already there keeps its
  // mode; it holds sealed secrets and the owner socket's parent, so it is
  // narrowed, and said out loud where it cannot be.
  if (!restrictDataDir(options.dataDir)) {
    options.log?.(`${options.dataDir} could not be made readable by its owner only; check who else can open it.`)
  }

  const desktopSealed = readDataDirSecrets(options.dataDir) === 'desktop-keychain'
  if (desktopSealed && !options.shareDesktopDataDir) {
    throw new StudioServerStartError(
      `${options.dataDir} is the desktop app's data directory, whose secrets its keychain sealed and a server cannot open. ` +
        'Give the server a directory of its own, or pass --share-desktop-data-dir to run here with saved keys switched off.',
      EXIT_DATA_DIR_UNUSABLE,
    )
  }

  const platform = createNodeStudioPlatform({
    dataDir: options.dataDir,
    logsDir: options.logsDir,
    version: options.version,
    packaged: options.packaged,
    resourcesDir: options.resourcesDir ?? null,
    appRoot: options.appRoot ?? null,
    ...(desktopSealed
      ? {
          secrets: createUnavailableSecretCipher(
            "This data directory's secrets are sealed by the desktop app's keychain, which a server cannot open.",
          ),
        }
      : {}),
  })

  let gateway: StudioGateway | null = null
  let core: StudioCore
  try {
    core = createStudioCore(platform, {
      role: 'server',
      // A chat's agent (Claude Code, Codex, an ACP agent) is handed this
      // server's gateway: the stdio bridge, run by the Node this server runs
      // on. A WSL machine is not this server's to reach; a server runs inside
      // the distribution instead (phase 7).
      resolveStudioMcpServer: async ({ hostId }) => {
        if (isWslHostId(hostId)) return null
        await gateway?.whenGatewayReady()
        return {
          id: STUDIO_MCP_SERVER_ID,
          name: STUDIO_MCP_SERVER_NAME,
          transport: 'stdio',
          command: process.execPath,
          args: [studioBridgeScriptPath(platform.paths)],
          env: {
            SPRINTENGINE_USER_DATA_DIR: platform.paths.dataDir(),
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          },
        }
      },
    })
  } catch (error) {
    if (error instanceof StudioDataDirBusyError) {
      throw new StudioServerStartError(error.message, EXIT_DATA_DIR_BUSY)
    }
    // `run/` that cannot be made, a lock or record that cannot be written:
    // the directory, not the server, is what has to change.
    if (error instanceof StudioDataDirUnusableError) {
      throw new StudioServerStartError(error.message, EXIT_DATA_DIR_UNUSABLE)
    }
    throw error
  }

  const started = createStudioGateway(core)
  gateway = started
  const rpc = createStudioRpc(core, started, options.hostKind ? { hostKind: options.hostKind } : {})
  let status: Awaited<ReturnType<StudioGateway['initialize']>>
  try {
    if (options.listen === false) {
      status = started.getStatus()
    } else {
      status = await started.initialize()
      // Not fatal when it cannot bind, as in the desktop: its status says why,
      // and the gateway and chats do not depend on it.
      await rpc.start().catch(() => undefined)
    }
  } catch (error) {
    await rpc.stop().catch(() => undefined)
    await started.shutdown().catch(() => undefined)
    await core.shutdown()
    throw error
  }

  let web: WebFrontDoor | null = null
  if (options.web && options.listen !== false) {
    try {
      // Loaded only when asked for: a server with no web listener loads none of it.
      const { startWebFrontDoor } = await import('./web/web-front-door')
      web = await startWebFrontDoor({
        core,
        gateway: started,
        rpc,
        clients: platform.clients,
        environmentId: readStudioEnvironmentId(options.dataDir),
        version: options.version,
        options: options.web,
        log: options.log,
      })
    } catch (error) {
      await rpc.stop().catch(() => undefined)
      await started.shutdown().catch(() => undefined)
      await core.shutdown()
      throw new StudioServerStartError(
        `The web listener did not start: ${error instanceof Error ? error.message : String(error)}`,
        EXIT_FAILED,
      )
    }
  }

  let stopping: Promise<void> | null = null
  const stop = (onLeg?: (progress: ShutdownLegProgress) => void): Promise<void> => {
    clearInterval(lockWatch)
    stopping ??= runShutdownLegs(
      [
        ...(web ? ([['web', () => web?.stop()]] as const) : []),
        ['studio-rpc', () => rpc.stop()],
        ['gateway', () => started.shutdown()],
        ['core', () => core.shutdown()],
      ],
      onLeg,
    )
    return stopping
  }
  // The desktop wins a data directory it opens: it takes the lock over, then
  // waits for this process to exit before opening its own sockets. So a lock
  // this server no longer holds means stop now, and not linger as a second
  // writer of every store.
  const lockWatch = setInterval(() => {
    if (core.dataDirLock?.isHeld() !== false) return
    clearInterval(lockWatch)
    options.onDataDirLost?.()
    void stop()
  }, LOCK_WATCH_MS)
  lockWatch.unref()

  return {
    core,
    gateway: started,
    rpc,
    platform,
    web,
    ready: {
      pid: process.pid,
      version: options.version,
      dataDir: options.dataDir,
      gatewaySocket: status.running ? (status.socketPath ?? resolveSocketPath(options.dataDir)) : null,
      rpcSocket: rpc.getStatus().running ? rpc.getStatus().socketPath : null,
      secrets: platform.secrets.available(),
      web: web?.url ?? null,
    },
    stop,
  }
}
