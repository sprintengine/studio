// The machines this computer offers, and which one a launch runs on.
//
// `local` always exists: `PosixLocalHost` on macOS and Linux, `WindowsHost` on
// Windows. On Windows each installed WSL distribution is a host too, listed
// from `wsl.exe --list --verbose`. The list is read when it is asked for (the
// machine picker opening, Settings opening, a launch into a distribution not
// seen yet) and kept, never re-read on window focus.
//
// A host object exists for any valid `wsl:<distro>` id, listed or not: a
// workspace inside a distribution runs there whether or not the person turned
// that distribution on as a machine for new chats. "Enabled" only decides what
// the New chat picker offers.

import {
  distroOfHostId,
  LOCAL_HOST_ID,
  resolveLaunchHostId,
  wslHostId,
  type ExecutionHostId,
  type ExecutionHostSettings,
  type HostsListResult,
} from '../../shared/execution-host'
import type { ExecutionHost } from './execution-host'
import { createPosixLocalHost } from './posix-local-host'
import { createWindowsHost } from './windows-host'
import { createWslHost } from './wsl-host'
import { knownWslListing, listWslDistros, type WslListing } from './wsl-distro'
import type { WslHelperClient } from './wsl-helper-client'

export type HostRegistryDeps = {
  platform?: NodeJS.Platform
  /** The per-machine settings as they stand now (main's launch settings store). */
  readHostSettings: () => Partial<Record<ExecutionHostId, ExecutionHostSettings>>
  listDistros?: (options: { force: boolean }) => Promise<WslListing>
  knownListing?: () => WslListing | null
  /** Stands in for a distribution's helper client in tests. */
  createWslHelper?: (distro: string) => WslHelperClient
}

export type HostListing = HostsListResult

export type HostRegistry = {
  local(): ExecutionHost
  /** The host an id names. An unknown or invalid id, or any id off Windows, is `local`. */
  get(id: string | null | undefined): ExecutionHost
  /** The host a launch runs on; see `resolveLaunchHostId` for the order. */
  resolve(input: { bound?: string | null; requested?: string | null; folder?: string | null }): ExecutionHost
  /** Every machine, for Settings (`all`) or for the New chat picker (enabled ones only). */
  list(options?: { refresh?: boolean; all?: boolean }): Promise<HostListing>
  /** Tell subscribers the list may read differently (a setting moved, a refresh landed). */
  notifyChanged(): void
  subscribe(listener: () => void): () => void
  dispose(): Promise<void>
}

const WSL_NOT_INSTALLED = 'WSL is not installed on this PC, or it did not answer. Install it with `wsl --install`.'

export function createHostRegistry(deps: HostRegistryDeps): HostRegistry {
  // Read on every call rather than once: tests stand in for Windows by
  // redefining `process.platform` around a single launch, and a registry that
  // captured the platform at its first use would keep answering for it.
  const currentPlatform = (): NodeJS.Platform => deps.platform ?? process.platform
  const listDistros = deps.listDistros ?? ((options) => listWslDistros({ force: options.force }))
  const knownListing = deps.knownListing ?? knownWslListing
  const locals = new Map<NodeJS.Platform, ExecutionHost>()
  const localHost = (): ExecutionHost => {
    const platform = currentPlatform()
    let host = locals.get(platform)
    if (!host) {
      host = platform === 'win32' ? createWindowsHost() : createPosixLocalHost(platform)
      locals.set(platform, host)
    }
    return host
  }
  const wslHosts = new Map<string, ExecutionHost>()
  const listeners = new Set<() => void>()
  const readSettings = (id: ExecutionHostId) => deps.readHostSettings()[id]

  function wslHost(distro: string): ExecutionHost {
    const existing = wslHosts.get(distro)
    if (existing) return existing
    const host = createWslHost(distro, {
      readSettings,
      listed: () => knownListing()?.distros?.find((entry) => entry.name === distro),
      ...(deps.createWslHelper ? { helper: deps.createWslHelper(distro) } : {}),
    })
    wslHosts.set(distro, host)
    return host
  }

  function get(id: string | null | undefined): ExecutionHost {
    if (currentPlatform() !== 'win32') return localHost()
    const distro = distroOfHostId(id)
    return distro ? wslHost(distro) : localHost()
  }

  function notifyChanged(): void {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A subscriber's failure is its own.
      }
    }
  }

  return {
    local: localHost,
    get,
    resolve: (input) => get(resolveLaunchHostId({ ...input, platform: currentPlatform() })),
    async list(options = {}) {
      const local = localHost()
      if (currentPlatform() !== 'win32') return { hosts: [local.summary()], wsl: null }
      const listing = await listDistros({ force: options.refresh === true }).catch((): WslListing => ({
        distros: null,
        at: Date.now(),
      }))
      const settings = deps.readHostSettings()
      const ids = new Set<ExecutionHostId>()
      for (const distro of listing.distros ?? []) ids.add(wslHostId(distro.name))
      // A distribution turned on and since removed stays listed, unavailable,
      // so the person can see why and turn it off.
      for (const [id, entry] of Object.entries(settings) as Array<[ExecutionHostId, ExecutionHostSettings]>) {
        if (id !== LOCAL_HOST_ID && entry?.enabled && distroOfHostId(id)) ids.add(id)
      }
      const wsl = [...ids]
        .map((id) => get(id).summary())
        .filter((summary) => options.all || summary.enabled)
        // The default distribution first, then by name: a list that reorders
        // as distributions start and stop is one nobody can learn.
        .sort(
          (a, b) =>
            Number(b.isDefaultDistro === true) - Number(a.isDefaultDistro === true) ||
            a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
        )
      if (options.refresh) notifyChanged()
      return {
        hosts: [local.summary(), ...wsl],
        wsl: listing.distros ? { available: true } : { available: false, reason: WSL_NOT_INSTALLED },
      }
    },
    notifyChanged,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async dispose() {
      await Promise.all([...locals.values(), ...wslHosts.values()].map((host) => host.dispose().catch(() => undefined)))
      locals.clear()
      wslHosts.clear()
      listeners.clear()
    },
  }
}

// The app's one registry, installed by app-services at startup. Modules that
// run before it (or in tests) see a registry with no WSL settings, which is
// exactly what macOS and Linux have anyway.
let installed: HostRegistry | null = null

export function installHostRegistry(registry: HostRegistry | null): void {
  installed = registry
}

export function hostRegistry(): HostRegistry {
  if (!installed) installed = createHostRegistry({ readHostSettings: () => ({}) })
  return installed
}
