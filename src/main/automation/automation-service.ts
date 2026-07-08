import { createHash } from 'crypto'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AutomationServerStatus } from '../../shared/automation'
import { readAutomationSettings, writeAutomationSettings } from './automation-settings'
import { createMcpSocketServer, type McpToolRegistration } from './mcp-socket-server'

// Owns the automation server lifecycle: the persisted off-by-default setting,
// the local socket endpoint, and the discovery info file external clients read
// to find the socket. Start/stop failures are recorded on the status (and
// logged) instead of silently leaving the server off.

export const AUTOMATION_SERVER_INFO_FILENAME = 'automation-server-info.json'

// POSIX sun_path is ~104 bytes; long dev userData paths fall back to the
// per-user temp dir with a hash tying the socket to this profile.
const MAX_POSIX_SOCKET_PATH = 90

type AutomationServiceOptions = {
  resolveUserDataDir: () => string
  appVersion: string
  tools: McpToolRegistration[]
  /** Absolute path of the shipped stdio bridge script, when the app knows it. */
  resolveBridgeScriptPath?: () => string | null
  logDiagnostic?: (diagnostic: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export type AutomationService = ReturnType<typeof createAutomationService>

export function createAutomationService(options: AutomationServiceOptions) {
  let lastError: string | null = null
  let server: ReturnType<typeof createMcpSocketServer> | null = null
  let socketPath: string | null = null
  let enabled = false
  let settingsLoaded = false

  function loadSettings(): void {
    if (settingsLoaded) return
    settingsLoaded = true
    const read = readAutomationSettings(options.resolveUserDataDir())
    enabled = read.settings.enabled
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

  /** Start the server if (and only if) the persisted setting enables it. */
  async function initialize(): Promise<AutomationServerStatus> {
    loadSettings()
    if (enabled) await startServer()
    return getStatus()
  }

  async function setEnabled(next: boolean): Promise<AutomationServerStatus> {
    loadSettings()
    enabled = next
    try {
      writeAutomationSettings(options.resolveUserDataDir(), { enabled: next })
    } catch (error) {
      lastError = `Could not persist the automation setting: ${message(error)}`
      warn('Automation setting write failed', lastError)
    }
    if (next) {
      await startServer()
    } else {
      await stopServer()
    }
    return getStatus()
  }

  async function startServer(): Promise<void> {
    if (server?.isRunning()) return
    const userDataDir = options.resolveUserDataDir()
    socketPath = resolveSocketPath(userDataDir)
    const next = createMcpSocketServer({
      socketPath,
      serverName: 'multicode-automation',
      serverVersion: options.appVersion,
      tools: options.tools,
      log: (text) => warn('Automation server', text),
    })
    try {
      await next.start()
      writeServerInfo(userDataDir, socketPath, options.appVersion)
      server = next
      lastError = null
    } catch (error) {
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
    await stopServer()
  }

  function warn(title: string, details: string): void {
    options.logDiagnostic?.({ level: 'warning', title, message: title, details })
  }

  return { initialize, getStatus, setEnabled, shutdown }
}

export function resolveSocketPath(userDataDir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\multicode-automation-${profileHash(userDataDir)}`
  }
  const direct = join(userDataDir, 'automation.sock')
  if (direct.length <= MAX_POSIX_SOCKET_PATH) return direct
  return join(tmpdir(), `multicode-automation-${profileHash(userDataDir)}.sock`)
}

function profileHash(userDataDir: string): string {
  return createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)
}

function writeServerInfo(userDataDir: string, socketPath: string, appVersion: string): void {
  const infoPath = join(userDataDir, AUTOMATION_SERVER_INFO_FILENAME)
  writeFileSync(
    infoPath,
    `${JSON.stringify(
      {
        socketPath,
        transport: process.platform === 'win32' ? 'named-pipe' : 'unix-socket',
        protocol: 'mcp-jsonrpc-ndjson',
        pid: process.pid,
        appVersion,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
}

function removeServerInfo(userDataDir: string): void {
  const infoPath = join(userDataDir, AUTOMATION_SERVER_INFO_FILENAME)
  if (!existsSync(infoPath)) return
  try {
    unlinkSync(infoPath)
  } catch {
    // Best-effort: a stale info file is detectable via its recorded pid.
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
