import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../../shared/modules/mcp-tools'
import {
  normalizeTailnetScopes,
  TAILNET_STRUCTURED_SCOPES,
  type TailnetPairingOfferView,
  type TailnetRemoteStatus,
  type TailnetScope,
} from '../../../shared/tailnet'
import type { TailnetPeerScan } from '../../../shared/tailnet-peers'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import { resolveTailnetInterface } from './tailnet-interface'
import { createTailnetPeerResolver, type TailnetPeerResolver } from './tailnet-peer-identity'
import { createTailnetPeerScanner, type TailnetPeerScanner } from './tailnet-peers'
import { readTailnetSettings, writeTailnetSettings, type TailnetSettings } from './tailnet-settings'
import type { TerminalRemoteHost } from '../../terminal-remote-attach'

// Lifecycle for tailnet remote control: settings, paired devices, and the
// listener itself.
//
// Off is the resting state and the only state a build ships in. `initialize`
// starts the listener ONLY when a persisted setting says a person turned it on
// AND this machine actually has a Tailscale interface — no tailnet, no
// listener, and the reason is reported rather than silently swallowed.

export type TailnetRemoteService = {
  /** Start the listener if, and only if, it is enabled and a tailnet exists. */
  initialize(): Promise<TailnetRemoteStatus>
  getStatus(): TailnetRemoteStatus
  setEnabled(enabled: boolean): Promise<TailnetRemoteStatus>
  /** Mint a one-time pairing code. The token is returned once and never re-readable. */
  offerPairing(input?: { scopes?: unknown }): TailnetPairingOfferView
  cancelPairing(): TailnetRemoteStatus
  revokeDevice(deviceId: string): TailnetRemoteStatus
  /**
   * Machines on this tailnet, and which of them answer as a Studio.
   *
   * Independent of this machine's own listener: discovering somewhere to
   * connect TO does not require having enabled being connected to.
   */
  listPeers(): Promise<TailnetPeerScan>
  /**
   * Tailscale's name for a tailnet address, or null.
   *
   * Shared with the Fleet client (MC-2167) so a machine this Studio pairs WITH
   * is labelled by the same resolver — and the same ~5-minute cache — that names
   * the peers driving this one. Two resolvers would mean two `whois` spawns for
   * one question.
   */
  resolvePeerName(address: string): Promise<string | null>
  notifyToolsListChanged(): void
  shutdown(): Promise<void>
}

export type TailnetRemoteServiceOptions = {
  resolveUserDataDir: () => string
  serverName: string
  serverVersion: string
  resolveTools: () => McpToolRegistration[]
  isMutation: (toolName: string) => boolean
  onToolCall?: (event: {
    context: McpConnectionContext
    tool: string
    args: Record<string, unknown>
    durationMs: number
    result?: McpToolResult
    error?: unknown
  }) => void
  /**
   * Watch-and-type access to this machine's terminals (MC-2165), for the
   * listener's terminal WebSocket. Absent (tests, an unwired build) leaves that
   * route refusing with a stated reason; nothing else about the listener changes.
   */
  terminals?: TerminalRemoteHost
  /** Injected in tests. Production reads this machine's real interfaces. */
  resolveBindAddress?: () => string | null
  createPeerScanner?: () => TailnetPeerScanner
  createDeviceStore?: (options: { resolveUserDataDir: () => string; log?: (message: string) => void }) => TailnetDeviceStore
  createPeerResolver?: () => TailnetPeerResolver
  log?: (message: string) => void
}

export function createTailnetRemoteService(options: TailnetRemoteServiceOptions): TailnetRemoteService {
  const devices = (options.createDeviceStore ?? createTailnetDeviceStore)({
    resolveUserDataDir: options.resolveUserDataDir,
    log: options.log,
  })
  const peers = (options.createPeerResolver ?? (() => createTailnetPeerResolver({ log: options.log })))()
  const peerScanner = (options.createPeerScanner ?? (() => createTailnetPeerScanner({ log: options.log })))()
  const resolveBindAddress = options.resolveBindAddress ?? (() => resolveTailnetInterface()?.address ?? null)

  let settings: TailnetSettings | null = null
  let lastError: string | null = null
  let server: TailnetGatewayServer | null = null

  function loadSettings(): TailnetSettings {
    if (settings) return settings
    const read = readTailnetSettings(options.resolveUserDataDir())
    settings = read.settings
    if (read.error) {
      lastError = read.error
      options.log?.(read.error)
    }
    return settings
  }

  function getStatus(): TailnetRemoteStatus {
    const current = loadSettings()
    const bound = server?.address() ?? null
    return {
      enabled: current.enabled,
      running: server?.isRunning() ?? false,
      endpoint: bound ? formatEndpoint(bound.address, bound.port) : null,
      port: current.port,
      tailnetAddress: resolveBindAddress(),
      lastError,
      devices: devices.listDevices(),
      pairing: devices.getPairingState(),
    }
  }

  async function startServer(): Promise<void> {
    if (server?.isRunning()) return
    const current = loadSettings()
    if (!current.enabled) return
    const bindAddress = resolveBindAddress()
    if (!bindAddress) {
      // Explicit refusal, not a fallback to another interface: the whole point
      // of this listener is that it is reachable ONLY over the tailnet.
      lastError =
        'Tailnet remote control is enabled but no Tailscale interface was found on this machine. Start Tailscale, then re-enable it.'
      options.log?.(lastError)
      return
    }
    const next = createTailnetGatewayServer({
      bindAddress,
      port: current.port,
      serverName: options.serverName,
      serverVersion: options.serverVersion,
      resolveTools: options.resolveTools,
      isMutation: options.isMutation,
      devices,
      peers,
      terminals: options.terminals,
      onToolCall: options.onToolCall,
      log: options.log,
    })
    try {
      await next.start()
      server = next
      lastError = null
    } catch (error) {
      await next.stop().catch(() => {})
      lastError = `Tailnet remote control failed to start: ${message(error)}`
      options.log?.(lastError)
    }
  }

  async function stopServer(): Promise<void> {
    const current = server
    server = null
    if (!current) return
    try {
      await current.stop()
    } catch (error) {
      lastError = `Tailnet remote control failed to stop cleanly: ${message(error)}`
      options.log?.(lastError)
    }
  }

  return {
    async initialize(): Promise<TailnetRemoteStatus> {
      await startServer()
      return getStatus()
    },

    getStatus,

    async setEnabled(enabled): Promise<TailnetRemoteStatus> {
      const current = loadSettings()
      settings = { ...current, enabled: enabled === true }
      try {
        writeTailnetSettings(options.resolveUserDataDir(), settings)
        lastError = null
      } catch (error) {
        lastError = `Could not persist the tailnet remote setting: ${message(error)}`
        options.log?.(lastError)
      }
      if (settings.enabled) await startServer()
      else {
        // Turning it off also drops any outstanding pairing: a code minted for
        // a listener that no longer answers is a credential with no purpose.
        devices.cancelPairing()
        await stopServer()
      }
      return getStatus()
    },

    offerPairing(input): TailnetPairingOfferView {
      const requested = normalizeTailnetScopes(input?.scopes)
      // No scopes asked for means the structured-command set. The terminal tier
      // is never granted by default — it has to be asked for by name.
      const scopes = requested.length > 0 ? requested : [...TAILNET_STRUCTURED_SCOPES]
      const offer = devices.offerPairing({ scopes })
      const bound = server?.address() ?? null
      return {
        token: offer.token,
        scopes: offer.scopes,
        expiresAt: offer.expiresAt,
        // Null while the listener is down: a QR pointing at nothing is worse
        // than none, and the caller can see from the status why.
        pairingUrl: bound ? pairingUrl(bound.address, bound.port, offer.token) : null,
      }
    },

    cancelPairing(): TailnetRemoteStatus {
      devices.cancelPairing()
      return getStatus()
    },

    revokeDevice(deviceId): TailnetRemoteStatus {
      devices.revokeDevice(deviceId)
      return getStatus()
    },

    listPeers(): Promise<TailnetPeerScan> {
      // The configured port, not the bound one: discovery probes the port THIS
      // machine would use, which is the convention the other machines follow.
      // A scan works with the local listener off — you can look for somewhere
      // to connect to without having opened your own door.
      return peerScanner.scan({ port: loadSettings().port })
    },

    resolvePeerName(address): Promise<string | null> {
      return peers.resolve(address)
    },

    notifyToolsListChanged(): void {
      server?.notifyToolsListChanged()
    },

    async shutdown(): Promise<void> {
      await stopServer()
    },
  }
}

/** IPv6 literals need brackets before a port; IPv4 must not have them. */
export function formatEndpoint(address: string, port: number): string {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`
}

/**
 * One scannable string carrying everything a client needs to pair: where to
 * reach the listener, and the one-time code. A custom scheme rather than an
 * http URL so scanning it in a browser cannot accidentally spend the code.
 */
export function pairingUrl(address: string, port: number, token: string): string {
  const query = new URLSearchParams({ endpoint: formatEndpoint(address, port), token })
  return `multicode-tailnet://pair?${query.toString()}`
}

export type { TailnetScope }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
