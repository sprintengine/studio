import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { listWslDistros } from '../../main/hosts/wsl-distro'
import { installNodeInto, installTree, wslNodeDigests, wslProfileId } from '../../main/hosts/wsl-helper-runtime'
import { streamedAppPayload, type StreamedPayload } from '../../main/hosts/wsl-install'
import { wslExeRunner } from '../../main/hosts/wsl-runner'
import {
  DEFAULT_WSL_CHAT_SERVER,
  wslHostId,
  type ExecutionHostId,
  type ExecutionHostSettings,
} from '../../shared/execution-host'
import {
  createWslEnvironmentManager,
  type WslEnvironmentManager,
  type WslServerConnection,
  type WslServerStatus,
} from './wsl-environment-manager'

// The WSL servers of a desktop on Windows, wired to the running app: where
// the server tree this build ships is, the profile its data directory is
// named for, the per-distribution switch and transport, and the one-time Node
// download. Built by the Studio core's owner (Electron main in process, the
// desktop's server process out of process), and only on Windows.

export type WslServers = {
  manager: WslEnvironmentManager
  /** Whether a distribution's chats run on its server now: the person's switch, off by default. */
  chatServerOn(distro: string): boolean
  /** Who hears a new connection (the router, to follow its events). */
  onConnected(listener: (connection: WslServerConnection) => void): void
  /** Who hears a status change (Settings › Machines). */
  onStatus(listener: (status: WslServerStatus) => void): void
}

export type DesktopWslServersOptions = {
  readHostSettings: () => Partial<Record<ExecutionHostId, ExecutionHostSettings>>
  userDataDir: string
  app: { version: string; channel: 'latest' | 'nightly' }
  /** An installed build (its resources hold the tree) or a source checkout (`out/wsl-server`). */
  packaged: boolean
  resourcesDir: string | null
  appRoot: string | null
  /** The installed app's own profile, whose data goes in `data/`; any other profile gets `data-<id>/`. */
  isDefaultProfile: boolean
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
  log?: (message: string) => void
}

/** Where this build's WSL server tree is, or null when it shipped none. */
export function wslServerTreeDir(
  options: Pick<DesktopWslServersOptions, 'packaged' | 'resourcesDir' | 'appRoot'>,
): string | null {
  const dir = options.packaged
    ? options.resourcesDir && join(options.resourcesDir, 'wsl-server')
    : options.appRoot && join(options.appRoot, 'out', 'wsl-server')
  return dir && existsSync(join(dir, 'server.cjs')) ? dir : null
}

/** The identity in a WSL tree's `build.json`, or null when it has none. */
export function readTreeBuild(dir: string): { builtAt: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')) as { builtAt?: unknown }
    return typeof parsed.builtAt === 'string' && parsed.builtAt ? { builtAt: parsed.builtAt } : null
  } catch {
    return null
  }
}

export function createDesktopWslServers(options: DesktopWslServersOptions): WslServers {
  const connectedListeners: Array<(connection: WslServerConnection) => void> = []
  const statusListeners: Array<(status: WslServerStatus) => void> = []
  let payload: StreamedPayload | null = null
  let treeBuild: { builtAt: string } | null | undefined
  const settingsOf = (distro: string) => options.readHostSettings()[wslHostId(distro)]
  const manager = createWslEnvironmentManager({
    runner: wslExeRunner,
    listDistros: ({ force }) => listWslDistros({ force }),
    app: { version: options.app.version, buildStamp: '', channel: options.app.channel },
    // The stable app's own profile is `data/`; a nightly or a pinned profile
    // has its own, so two apps never share one server's data (8.11).
    profile: {
      id: wslProfileId(options.userDataDir),
      isDefault: options.isDefaultProfile && options.app.channel === 'latest',
    },
    payload: () => {
      if (payload) return payload
      const dir = wslServerTreeDir(options)
      // Packed once per run: the digest is what the launch script checks, and
      // the tree is gzipped only for an install.
      payload = dir ? streamedAppPayload([{ dir, into: '' }]) : null
      return payload
    },
    treeBuild: () => {
      if (treeBuild !== undefined) return treeBuild
      const dir = wslServerTreeDir(options)
      treeBuild = dir ? readTreeBuild(dir) : null
      return treeBuild
    },
    nodeDigests: wslNodeDigests,
    installNode: (distro, report) =>
      installNodeInto(distro, report, {
        cacheDir: join(options.userDataDir, 'wsl-runtime'),
        appVersion: options.app.version,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.log ? { log: options.log } : {}),
      }),
    install: (distro, input) => installTree(distro, input, options.app.version),
    transportFor: (distro) => settingsOf(distro)?.serverTransport ?? 'auto',
    onConnected: (connection) => {
      for (const listener of connectedListeners) listener(connection)
    },
    onStatus: (status) => {
      for (const listener of statusListeners) listener(status)
    },
    ...(options.log ? { log: options.log } : {}),
  })
  return {
    manager,
    chatServerOn: (distro) => (settingsOf(distro)?.chatServer ?? DEFAULT_WSL_CHAT_SERVER) === 'on',
    onConnected: (listener) => void connectedListeners.push(listener),
    onStatus: (listener) => void statusListeners.push(listener),
  }
}
