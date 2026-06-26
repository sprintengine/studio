import { createHash } from 'crypto'
import { chmodSync, existsSync, unlinkSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentStateFrame } from './agent-state'
import { installAgentStateHook, parseAgentStateFrame } from './agent-state'

// =============================================================================
// Agent-state service — the Electron-bound half of authoritative agent state.
//
// Owns a dedicated local socket the per-workspace reporter hook writes
// newline-delimited JSON frames to, validates each frame, and hands the valid
// ones to `onFrame` (the terminal runtime, which resolves the session and
// updates its phase). Also owns installing the reporter into a workspace at
// launch — serialized per workspace and run once per workspace per app run so
// concurrent agent launches never race on .claude/settings.local.json.
//
// All Electron specifics (userData dir, bundled reporter path) are injected, so
// this module stays free of `electron` and is unit-testable over a real socket.
// =============================================================================

// POSIX sun_path is ~104 bytes; long dev userData paths fall back to the
// per-user temp dir with a hash tying the socket to this profile. Mirrors the
// automation server's resolver so both behave identically across platforms.
const MAX_POSIX_SOCKET_PATH = 90

// A reporter frame is tiny; a client that streams an unbounded line without a
// newline is dropped rather than buffered without limit.
const MAX_LINE_BYTES = 64 * 1024

export type AgentStateServiceOptions = {
  resolveUserDataDir: () => string
  // Resolves the bundled reporter script to copy into a workspace. Returns null
  // when the script is missing from the build (install then no-ops, safely).
  resolveReporterScriptPath: () => string | null
  onFrame: (frame: AgentStateFrame) => void
  logDiagnostic?: (diagnostic: { level: 'warning'; title: string; message: string; details?: string }) => void
  now?: () => number
}

export type AgentStateService = ReturnType<typeof createAgentStateService>

export function createAgentStateService(options: AgentStateServiceOptions) {
  const now = options.now ?? (() => Date.now())
  let server: Server | null = null
  const sockets = new Set<Socket>()
  let socketPath: string | null = null

  // Per-workspace install state: a serialization chain so concurrent launches
  // in the same workspace don't race the settings.local.json read-modify-write,
  // and a set so we install at most once per workspace per app run.
  const installChains = new Map<string, Promise<void>>()
  const installed = new Set<string>()

  function getSocketPath(): string {
    if (!socketPath) socketPath = resolveAgentStateSocketPath(options.resolveUserDataDir())
    return socketPath
  }

  function warn(title: string, details: string): void {
    options.logDiagnostic?.({ level: 'warning', title, message: title, details })
  }

  async function initialize(): Promise<void> {
    if (server) return
    const path = getSocketPath()
    // A stale socket file from a crashed previous run would block listen();
    // remove it. A live second instance is prevented upstream by Electron's
    // single-instance lock.
    if (process.platform !== 'win32' && existsSync(path)) {
      try {
        unlinkSync(path)
      } catch {
        // listen() will surface a real conflict below.
      }
    }
    const next = createServer((socket) => handleConnection(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          next.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          next.removeListener('error', onError)
          resolve()
        }
        next.once('error', onError)
        next.once('listening', onListening)
        next.listen(path)
      })
    } catch (error) {
      warn('Agent-state socket failed to start', message(error))
      return
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(path, 0o600)
      } catch {
        // Owner-only is best-effort hardening; a failure does not break the feed.
      }
    }
    next.on('error', (error) => warn('Agent-state socket error', error.message))
    server = next
  }

  function handleConnection(socket: Socket): void {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE_BYTES) {
        socket.destroy()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) handleLine(line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  }

  function handleLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      // Untrusted input: a malformed frame is dropped, never thrown on.
      return
    }
    const frame = parseAgentStateFrame(raw, now())
    if (!frame) return
    try {
      options.onFrame(frame)
    } catch (error) {
      warn('Agent-state frame handler threw', message(error))
    }
  }

  async function shutdown(): Promise<void> {
    const current = server
    server = null
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (current) {
      await new Promise<void>((resolve) => current.close(() => resolve()))
    }
    if (process.platform !== 'win32' && socketPath && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        // Best-effort cleanup; a stale socket is unlinked on next start.
      }
    }
  }

  // Install the reporter into a workspace before a Claude Code agent launches.
  // Serialized per workspace, run once per workspace per app run, and strictly
  // best-effort: a failure is logged and swallowed so it can never block or
  // break the agent launch that awaits it.
  async function installForWorkspace(workspaceRoot: string): Promise<void> {
    const key = workspaceRoot.trim()
    if (!key || installed.has(key)) return

    const prior = installChains.get(key) ?? Promise.resolve()
    const next = prior.then(async () => {
      if (installed.has(key)) return
      const sourceScriptPath = options.resolveReporterScriptPath()
      if (!sourceScriptPath) {
        warn('Agent-state reporter missing', 'Reporter script not found in this build; agent state falls back to inference.')
        return
      }
      const result = await installAgentStateHook(workspaceRoot, {
        sourceScriptPath,
        socketPath: getSocketPath(),
      })
      if (result.ok) {
        installed.add(key)
      } else {
        warn('Agent-state hook install failed', result.message)
      }
    })
    // Keep the chain alive even if this link rejected, so a later launch retries
    // rather than inheriting a poisoned promise.
    installChains.set(
      key,
      next.catch(() => {})
    )
    await next.catch((error) => warn('Agent-state hook install threw', message(error)))
  }

  return {
    initialize,
    shutdown,
    getSocketPath,
    installForWorkspace,
    isRunning: () => server !== null,
  }
}

export function resolveAgentStateSocketPath(userDataDir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\multicode-agent-state-${profileHash(userDataDir)}`
  }
  const direct = join(userDataDir, 'agent-state.sock')
  if (direct.length <= MAX_POSIX_SOCKET_PATH) return direct
  return join(tmpdir(), `multicode-agent-state-${profileHash(userDataDir)}.sock`)
}

function profileHash(userDataDir: string): string {
  return createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
