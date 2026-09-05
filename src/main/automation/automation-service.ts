import { createHash } from 'crypto'
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AutomationServerStatus } from '../../shared/automation'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../../shared/product-identity'
import type {
  TailnetDeviceOrigin,
  TailnetLiveState,
  TailnetPairingOfferView,
  TailnetPushPayload,
  TailnetRemoteStatus,
} from '../../shared/tailnet'
import type { FleetEvent } from '../../shared/tailnet-fleet'
import type { TailnetApprovePairRequestResult } from './tailnet/tailnet-service'
import type { TailnetPeerScan } from '../../shared/tailnet-peers'
import { readAutomationSettings, writeAutomationSettings } from './automation-settings'
import { createGatewayAuditStore, type GatewayAuditStore } from './gateway-audit'
import { createMcpSocketServer } from './mcp-socket-server'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { createTailnetFleetService, type TailnetFleetService } from './tailnet/tailnet-fleet-service'
import { createTailnetRemoteService, type TailnetRemoteService } from './tailnet/tailnet-service'
import type { TerminalRemoteHost } from '../terminal-remote-attach'

// Owns the always-on Studio MCP gateway lifecycle, local socket endpoint, and
// discovery files external clients read to find it. The old enabled setting is
// retained only as a compatibility API; it can no longer stop the gateway.
//
// It also owns the OPT-IN tailnet listener (MC-2162), which serves the same
// tool surface to paired devices on the Tailscale network. The two are
// deliberately asymmetric: the socket is infrastructure and always on; the
// tailnet listener is off until a person enables it, and stopping it never
// touches the socket.

export const AUTOMATION_SERVER_INFO_FILENAME = 'automation-server-info.json'
export const STUDIO_MCP_SERVER_INFO_FILENAME = 'sprintengine-studio-mcp-info.json'

// POSIX sun_path is ~104 bytes; long dev userData paths fall back to the
// per-user temp dir with a hash tying the socket to this profile.
const MAX_POSIX_SOCKET_PATH = 90

type AutomationServiceOptions = {
  resolveUserDataDir: () => string
  appVersion: string
  /**
   * The gateway's current tool set (core + module-contributed), evaluated per
   * request. Injected as a lazy resolver because the gateway is constructed at
   * startup module scope, BEFORE `loadMainModules` populates the module-host
   * tool registry — a captured array here could never see module tools, and
   * module enablement must be honored live (MC-1855).
   */
  resolveGatewayTools: () => McpToolRegistration[]
  /**
   * Watch-and-type access to this machine's terminals, for the tailnet
   * listener's terminal WebSocket (MC-2165). The LOCAL socket never gets it:
   * a local client already has the machine, and the terminal stream exists to
   * cross a network. Absent leaves that route refusing with a stated reason.
   */
  resolveTerminalHost?: () => TerminalRemoteHost
  /** Absolute path of the shipped stdio bridge script, when the app knows it. */
  resolveBridgeScriptPath?: () => string | null
  /**
   * The live-state push (remote-sessions-ux): tailnet listener/pairing/socket
   * changes and fleet lifecycle, for broadcast to every window. Wired by the
   * app shell; absent in tests and headless embeddings, where nothing listens.
   */
  onTailnetEvent?: (payload: TailnetPushPayload) => void
  /** Whether a window is open: the fleet's reachability timer only runs while one is. */
  hasWindow?: () => boolean
  onFleetEvent?: (event: FleetEvent) => void
  logDiagnostic?: (diagnostic: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export type AutomationService = ReturnType<typeof createAutomationService>

export function createAutomationService(options: AutomationServiceOptions) {
  let lastError: string | null = null
  let server: ReturnType<typeof createMcpSocketServer> | null = null
  let socketPath: string | null = null
  let enabled = true
  let settingsLoaded = false
  // Both transports write the SAME audit file, so a mutation is one record
  // whichever door it came through — the connection identity is what differs.
  let audit: GatewayAuditStore | null = null
  let tailnet: TailnetRemoteService | null = null
  // The outbound half (MC-2167). Independent of the listener above: driving
  // another machine does not require having opened your own door, and a build
  // with remote control off can still be a Fleet client.
  let fleet: TailnetFleetService | null = null

  function loadSettings(): void {
    if (settingsLoaded) return
    settingsLoaded = true
    const read = readAutomationSettings(options.resolveUserDataDir())
    // MC-1743: the compatibility setting is read only for diagnostics. The
    // Studio gateway is infrastructure and is always enabled.
    enabled = true
    if (read.error) {
      lastError = read.error
      warn('Automation settings unreadable', read.error)
    }
  }

  function getStatus(): AutomationServerStatus {
    loadSettings()
    return {
      enabled,
      running: server?.isRunning() ?? false,
      socketPath: server?.isRunning() ? socketPath : null,
      lastError,
      bridgeScriptPath: options.resolveBridgeScriptPath?.() ?? null,
    }
  }

  /** Start the instance-global Studio MCP gateway with the app. */
  async function initialize(): Promise<AutomationServerStatus> {
    loadSettings()
    await startServer()
    // Opt-in and independent: a tailnet listener that cannot start reports why
    // in its own status and never blocks the socket gateway the app depends on.
    await tailnetService().initialize()
    // Reachability (phase 4): every paired machine is checked once at start
    // and on a timer from here on, so the chrome knows which machines answer
    // without a pane having to be opened on one.
    fleetService().start()
    return getStatus()
  }

  async function setEnabled(_next: boolean): Promise<AutomationServerStatus> {
    loadSettings()
    enabled = true
    try {
      // Compatibility API: old renderers may still call this toggle. Persist
      // the new invariant and keep the gateway running instead of allowing a
      // stale UI to disable every Studio agent's MCP contract.
      writeAutomationSettings(options.resolveUserDataDir(), { enabled: true })
    } catch (error) {
      lastError = `Could not persist the automation setting: ${message(error)}`
      warn('Automation setting write failed', lastError)
    }
    await startServer()
    return getStatus()
  }

  function auditStore(): GatewayAuditStore {
    audit ??= createGatewayAuditStore({
      resolveUserDataDir: options.resolveUserDataDir,
      log: (text) => warn('Studio MCP audit', text),
    })
    return audit
  }

  function tailnetService(): TailnetRemoteService {
    tailnet ??= createTailnetRemoteService({
      resolveUserDataDir: options.resolveUserDataDir,
      serverName: STUDIO_MCP_SERVER_ID,
      serverVersion: options.appVersion,
      resolveTools: options.resolveGatewayTools,
      isMutation: isStudioGatewayMutation,
      terminals: options.resolveTerminalHost?.(),
      onToolCall: ({ context, tool, args, durationMs, result, error }) => {
        if (!isStudioGatewayMutation(tool)) return
        auditStore().record({ connection: context.metadata, tool, args, durationMs, result, error })
      },
      onEvent: options.onTailnetEvent,
      // The reverse half of a both-ways pairing lands in the fleet: the
      // machine that just asked to drive this one can now be driven back.
      onReverseGrant: (input) => {
        fleetService().adoptReverseGrant(input)
      },
      log: (text) => warn('Tailnet remote control', text),
    })
    return tailnet
  }

  function fleetService(): TailnetFleetService {
    fleet ??= createTailnetFleetService({
      resolveUserDataDir: options.resolveUserDataDir,
      resolvePeerName: (address) => tailnetService().resolvePeerName(address),
      // Both-ways pairing (phase 6): the device this machine grants the one
      // it is asking to drive is minted on the listener's own store, so it is
      // listed, revocable, and audited like every other device here.
      mintReverseDevice: (input) => tailnetService().grantReverseDevice(input),
      revokeReverseDevice: (deviceId) => {
        tailnetService().revokeDevice(deviceId)
      },
      hasWindow: options.hasWindow,
      onEvent: options.onFleetEvent,
      log: (text) => warn('Tailnet fleet', text),
    })
    return fleet
  }

  async function startServer(): Promise<void> {
    if (server?.isRunning()) return
    const userDataDir = options.resolveUserDataDir()
    socketPath = resolveSocketPath(userDataDir)
    const audit = auditStore()
    const next = createMcpSocketServer({
      socketPath,
      serverName: STUDIO_MCP_SERVER_ID,
      serverVersion: options.appVersion,
      resolveTools: options.resolveGatewayTools,
      onToolCall: ({ context, tool, args, durationMs, result, error }) => {
        if (!isStudioGatewayMutation(tool)) return
        audit.record({ connection: context.metadata, tool, args, durationMs, result, error })
      },
      log: (text) => warn('Automation server', text),
    })
    try {
      await next.start()
      writeServerInfo(userDataDir, socketPath, options.appVersion)
      server = next
      lastError = null
    } catch (error) {
      // A discovery write is part of startup: agents cannot use an
      // undiscoverable listener. Tear it down so retries do not leak a live
      // socket while status incorrectly reports stopped.
      await next.stop().catch(() => {})
      removeServerInfo(userDataDir)
      lastError = `Automation server failed to start: ${message(error)}`
      warn('Automation server start failed', lastError)
    }
  }

  async function stopServer(): Promise<void> {
    const current = server
    server = null
    if (current) {
      try {
        await current.stop()
      } catch (error) {
        lastError = `Automation server failed to stop cleanly: ${message(error)}`
        warn('Automation server stop failed', lastError)
      }
    }
    removeServerInfo(options.resolveUserDataDir())
  }

  async function shutdown(): Promise<void> {
    // Outbound sockets first: they are attachments on OTHER machines' ptys, and
    // closing them politely is what stops a remote runtime narrating to a
    // viewer that has quit.
    fleet?.shutdown()
    await tailnet?.shutdown()
    await stopServer()
  }

  function warn(title: string, details: string): void {
    options.logDiagnostic?.({ level: 'warning', title, message: title, details })
  }

  /** A module enable/disable changed tool availability; tell connected clients. */
  function notifyToolsListChanged(): void {
    server?.notifyToolsListChanged()
    tailnet?.notifyToolsListChanged()
  }

  return {
    initialize,
    getStatus,
    setEnabled,
    shutdown,
    notifyToolsListChanged,
    getTailnetStatus: (): TailnetRemoteStatus => tailnetService().getStatus(),
    getTailnetLiveState: (): TailnetLiveState => tailnetService().getLiveState(),
    setTailnetEnabled: (next: boolean): Promise<TailnetRemoteStatus> => tailnetService().setEnabled(next),
    offerTailnetPairing: (input?: { scopes?: unknown; origin?: TailnetDeviceOrigin }): TailnetPairingOfferView =>
      tailnetService().offerPairing(input),
    setTailnetNotifications: (enabled: boolean): TailnetRemoteStatus => tailnetService().setNotifications(enabled),
    cancelTailnetPairing: (): TailnetRemoteStatus => tailnetService().cancelPairing(),
    revokeTailnetDevice: (deviceId: string): TailnetRemoteStatus => tailnetService().revokeDevice(deviceId),
    approveTailnetPairRequest: (input: {
      id: string
      scopes?: unknown
      code?: unknown
      via?: 'ipc' | 'tool'
    }): TailnetApprovePairRequestResult => tailnetService().approvePairRequest(input),
    denyTailnetPairRequest: (id: string, via?: 'ipc' | 'tool'): TailnetRemoteStatus =>
      tailnetService().denyPairRequest(id, via),
    listTailnetPeers: (): Promise<TailnetPeerScan> => tailnetService().listPeers(),
    /** The Fleet client: the machines this Studio drives (MC-2167). */
    fleet: (): TailnetFleetService => fleetService(),
  }
}

export function resolveSocketPath(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
  temporaryDir: string = tmpdir()
): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\multicode-automation-${profileHash(userDataDir)}`
  }
  const direct = join(userDataDir, 'automation.sock')
  if (direct.length <= MAX_POSIX_SOCKET_PATH) return direct
  return join(temporaryDir, `multicode-automation-${profileHash(userDataDir)}.sock`)
}

function profileHash(userDataDir: string): string {
  return createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)
}

function writeServerInfo(userDataDir: string, socketPath: string, appVersion: string): void {
  const body = `${JSON.stringify(
    {
      serverId: STUDIO_MCP_SERVER_ID,
      serverName: STUDIO_MCP_SERVER_NAME,
      socketPath,
      transport: process.platform === 'win32' ? 'named-pipe' : 'unix-socket',
      protocol: 'mcp-jsonrpc-ndjson',
      pid: process.pid,
      appVersion,
      startedAt: new Date().toISOString(),
    },
    null,
    2
  )}\n`
  // Canonical discovery plus the legacy filename for existing bridge clients.
  for (const filename of [STUDIO_MCP_SERVER_INFO_FILENAME, AUTOMATION_SERVER_INFO_FILENAME]) {
    const path = join(userDataDir, filename)
    writeFileSync(path, body, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }
}

function removeServerInfo(userDataDir: string): void {
  for (const filename of [STUDIO_MCP_SERVER_INFO_FILENAME, AUTOMATION_SERVER_INFO_FILENAME]) {
    const infoPath = join(userDataDir, filename)
    if (!existsSync(infoPath)) continue
    try {
      unlinkSync(infoPath)
    } catch {
      // Best-effort: a stale info file is detectable via its recorded pid.
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
