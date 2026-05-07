import { BrowserWindow, type WebContents } from 'electron'
import * as pty from 'node-pty'
import type {
  AgentCli,
  AgentExecutionMode,
  TerminalKind,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'
import {
  cleanupTerminalStartupScript,
  getPlainShellLaunchConfig,
  getShellLaunchConfig,
  getTerminalEnv,
} from './terminal-launch'
import { getErrorMessage } from './error-message'
import { MobileSwarmCommandService } from './mobile-sprintengine-command'
import { DesktopMobileSwarmSessionOrchestrator } from './mobile-sprintengine-session'

type TerminalRuntimeOptions = {
  diagnosticsEnabled: boolean
  requireAuthenticatedUser(message: string): void
  logMainPerfEvent(scope: string, event: string, payload: Record<string, unknown>): void
}

type TerminalIpcHandlers = {
  spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  getTerminalStatus(sessionId: string): { running: boolean }
  listTerminals(): TerminalSessionSnapshot[]
  killTerminal(sessionId: string): void
}

type TerminalRuntime = {
  commandService: MobileSwarmCommandService
  ipcHandlers: TerminalIpcHandlers
}

let terminalDiagnosticsEnabled = false
let requireAuthenticatedUser = (_message: string): void => {}
let logTerminalPerfEvent = (_scope: string, _event: string, _payload: Record<string, unknown>): void => {}

export function createTerminalRuntime(options: TerminalRuntimeOptions): TerminalRuntime {
  terminalDiagnosticsEnabled = options.diagnosticsEnabled
  requireAuthenticatedUser = options.requireAuthenticatedUser
  logTerminalPerfEvent = options.logMainPerfEvent

  return {
    commandService: createMobileCommandService(),
    ipcHandlers: {
      spawnTerminal: spawnTerminalFromIpc,
      writeTerminal: writeTerminalInput,
      resizeTerminal: safeResizeTerminal,
      getTerminalStatus(sessionId) {
        const session = terminals.get(sessionId)
        return {
          running: Boolean(session && !session.hasExited && !session.isDisposed),
        }
      },
      listTerminals() {
        return [...terminals.values()]
          .filter((session) => !session.hasExited && !session.isDisposed)
          .map(getTerminalSnapshot)
      },
      killTerminal: disposeTerminal,
    },
  }
}

// ── Claude Code CLI Terminal IPC ──────────────────────────────────────────────

type TerminalSize = {
  cols: number
  rows: number
}

type TerminalSession = {
  sessionId: string
  process: pty.IPty
  sender: Electron.WebContents
  isReady: boolean
  hasExited: boolean
  isDisposed: boolean
  outputChunks: string[]
  outputChunkBytes: number[]
  outputChunkStart: number
  outputBytes: number
  outputLength: number
  kind: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  cwd?: string
  swarmStatePath?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  pendingResize?: TerminalSize
  startupScriptPath?: string
}

const TERMINAL_REPLAY_BUFFER_LIMIT = 512 * 1024
const TERMINAL_INTERACTIVE_DATA_BATCH_MS = 0
const TERMINAL_DATA_BATCH_MS = 16
const TERMINAL_RECENT_INPUT_WINDOW_MS = 250
const TERMINAL_INTERACTIVE_DATA_LIMIT = 4096
const TERMINAL_PENDING_DATA_LIMIT = 256 * 1024
const TERMINAL_REPLAY_COMPACT_THRESHOLD = 1024
const TERMINAL_BATCH_DIAGNOSTIC_INTERVAL_MS = 1_000
const terminals = new Map<string, TerminalSession>()
const pendingTerminalData = new Map<string, {
  sender: Electron.WebContents
  channel: string
  chunks: string[]
  bytes: number
  timer: NodeJS.Timeout
}>()
const terminalBatchDiagnostics = new Map<string, {
  batches: number
  chunks: number
  bytes: number
  lastLogAt: number
}>()
const TERMINAL_INPUT_DIAGNOSTIC_INTERVAL_MS = 1_000
const TERMINAL_SLOW_INPUT_WRITE_MS = 50
const terminalInputDiagnostics = new Map<string, {
  writes: number
  bytes: number
  totalMs: number
  maxMs: number
  errors: number
  lastLogAt: number
}>()
function sendTerminalEvent(
  sender: Electron.WebContents,
  channel: string,
  payload: string | number
): void {
  if (!sender.isDestroyed()) {
    sender.send(channel, payload)
  }
}

function broadcastTerminalSessionsChanged(): void {
  const snapshots = [...terminals.values()]
    .filter((session) => !session.hasExited && !session.isDisposed)
    .map(getTerminalSnapshot)

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('terminal:sessions-changed', snapshots)
    }
  }
}

function recordTerminalDataBatch(
  session: TerminalSession | undefined,
  cause: 'timer' | 'exit' | 'dispose',
  chunkCount: number,
  byteCount: number
): void {
  if (!session || chunkCount === 0) return

  const now = Date.now()
  const stats = terminalBatchDiagnostics.get(session.sessionId) ?? {
    batches: 0,
    chunks: 0,
    bytes: 0,
    lastLogAt: now,
  }

  stats.batches += 1
  stats.chunks += chunkCount
  stats.bytes += byteCount

  if (cause !== 'timer' || now - stats.lastLogAt >= TERMINAL_BATCH_DIAGNOSTIC_INTERVAL_MS) {
    logTerminalPerfEvent('Terminal', 'output-batches', {
      sessionId: session.sessionId,
      kind: session.kind,
      workspaceId: session.workspaceId,
      cause,
      batches: stats.batches,
      chunks: stats.chunks,
      bytes: stats.bytes,
      retainedOutputBytes: session.outputBytes,
    })
    stats.batches = 0
    stats.chunks = 0
    stats.bytes = 0
    stats.lastLogAt = now
  }

  terminalBatchDiagnostics.set(session.sessionId, stats)
}

function recordTerminalInputWrite(
  session: TerminalSession | undefined,
  byteCount: number,
  elapsedMs: number,
  ok: boolean
): void {
  if (!session || !terminalDiagnosticsEnabled) return

  const now = Date.now()
  const stats = terminalInputDiagnostics.get(session.sessionId) ?? {
    writes: 0,
    bytes: 0,
    totalMs: 0,
    maxMs: 0,
    errors: 0,
    lastLogAt: now,
  }

  stats.writes += 1
  stats.bytes += byteCount
  stats.totalMs += elapsedMs
  stats.maxMs = Math.max(stats.maxMs, elapsedMs)
  if (!ok) stats.errors += 1

  if (now - stats.lastLogAt >= TERMINAL_INPUT_DIAGNOSTIC_INTERVAL_MS || elapsedMs >= TERMINAL_SLOW_INPUT_WRITE_MS || !ok) {
    logTerminalPerfEvent('Terminal', 'input-writes', {
      sessionId: session.sessionId,
      kind: session.kind,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      terminalId: session.terminalId,
      writes: stats.writes,
      bytes: stats.bytes,
      avgMs: stats.writes > 0 ? Math.round((stats.totalMs / stats.writes) * 10) / 10 : 0,
      maxMs: Math.round(stats.maxMs * 10) / 10,
      errors: stats.errors,
    })
    stats.writes = 0
    stats.bytes = 0
    stats.totalMs = 0
    stats.maxMs = 0
    stats.errors = 0
    stats.lastLogAt = now
  }

  terminalInputDiagnostics.set(session.sessionId, stats)
}

function trimPendingTerminalChunks(chunks: string[], maxBytes: number): { chunks: string[]; bytes: number; dropped: boolean } {
  let bytes = 0
  const retained: string[] = []

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index] ?? ''
    const chunkBytes = Buffer.byteLength(chunk)
    if (bytes + chunkBytes <= maxBytes) {
      retained.unshift(chunk)
      bytes += chunkBytes
      continue
    }

    const remainingBytes = maxBytes - bytes
    if (remainingBytes > 0) {
      const tail = Buffer.from(chunk)
        .subarray(Math.max(0, chunkBytes - remainingBytes))
        .toString('utf8')
      retained.unshift(tail)
      bytes += Buffer.byteLength(tail)
    }
    retained.unshift('\r\n[Multicode: terminal output throttled to keep the UI responsive]\r\n')
    return {
      chunks: retained,
      bytes: retained.reduce((total, value) => total + Buffer.byteLength(value), 0),
      dropped: true,
    }
  }

  return { chunks: retained, bytes, dropped: false }
}

function flushTerminalData(sessionId: string, cause: 'timer' | 'exit' | 'dispose' = 'timer'): void {
  const pending = pendingTerminalData.get(sessionId)
  if (!pending) return

  pendingTerminalData.delete(sessionId)
  clearTimeout(pending.timer)
  const data = pending.chunks.join('')
  sendTerminalEvent(pending.sender, pending.channel, data)
  recordTerminalDataBatch(
    terminals.get(sessionId),
    cause,
    pending.chunks.length,
    Buffer.byteLength(data)
  )
}

function sendTerminalData(session: TerminalSession, data: string): void {
  const channel = `terminal:data:${session.sessionId}`
  const pending = pendingTerminalData.get(session.sessionId)
  if (pending) {
    pending.sender = session.sender
    pending.channel = channel
    pending.chunks.push(data)
    pending.bytes += Buffer.byteLength(data)
    if (pending.bytes > TERMINAL_PENDING_DATA_LIMIT) {
      const trimmed = trimPendingTerminalChunks(pending.chunks, TERMINAL_PENDING_DATA_LIMIT)
      pending.chunks = trimmed.chunks
      pending.bytes = trimmed.bytes
    }
    return
  }

  const delayMs = getTerminalDataBatchDelay(session, data)
  const timer = setTimeout(() => {
    flushTerminalData(session.sessionId, 'timer')
  }, delayMs)
  pendingTerminalData.set(session.sessionId, {
    sender: session.sender,
    channel,
    chunks: [data],
    bytes: Buffer.byteLength(data),
    timer,
  })
}

function getTerminalDataBatchDelay(session: TerminalSession, data: string): number {
  const recentInput = session.lastInputAt !== null
    && Date.now() - session.lastInputAt <= TERMINAL_RECENT_INPUT_WINDOW_MS
  const smallOutput = Buffer.byteLength(data) <= TERMINAL_INTERACTIVE_DATA_LIMIT

  return recentInput && smallOutput
    ? TERMINAL_INTERACTIVE_DATA_BATCH_MS
    : TERMINAL_DATA_BATCH_MS
}

function getTerminalErrorMessage(error: unknown): string {
  if (error instanceof Error && /enoent/i.test(error.message)) {
    return process.platform === 'win32'
      ? 'WSL could not be started. Make sure your default WSL distro is installed and available.'
      : 'Agent CLI shell could not be started. Make sure your login shell is available.'
  }

  return error instanceof Error ? error.message : String(error)
}

function getTerminalSize(cols: number, rows: number): TerminalSize {
  return {
    cols: Math.max(Number.isFinite(cols) ? Math.floor(cols) : 80, 20),
    rows: Math.max(Number.isFinite(rows) ? Math.floor(rows) : 24, 8),
  }
}

function safeResizeTerminal(sessionId: string, cols: number, rows: number): void {
  const session = terminals.get(sessionId)
  if (!session || session.hasExited || session.isDisposed) return

  const size = getTerminalSize(cols, rows)
  if (process.platform === 'win32' && !session.isReady) {
    session.pendingResize = size
    return
  }

  try {
    session.process.resize(size.cols, size.rows)
  } catch {
    // node-pty can report resize-after-exit races before its exit event is delivered.
    session.hasExited = true
  }
}

function flushPendingTerminalResize(sessionId: string, session: TerminalSession): void {
  const pendingResize = session.pendingResize
  if (!pendingResize) return

  session.pendingResize = undefined
  safeResizeTerminal(sessionId, pendingResize.cols, pendingResize.rows)
}

function trimTerminalChunkToReplayLimit(data: string): { data: string; bytes: number } {
  const bytes = Buffer.byteLength(data)
  if (bytes <= TERMINAL_REPLAY_BUFFER_LIMIT) return { data, bytes }

  const trimmed = Buffer.from(data)
    .subarray(bytes - TERMINAL_REPLAY_BUFFER_LIMIT)
    .toString('utf8')

  return {
    data: trimmed,
    bytes: Buffer.byteLength(trimmed),
  }
}

function appendTerminalOutput(session: TerminalSession, data: string): void {
  const chunk = trimTerminalChunkToReplayLimit(data)
  session.outputChunks.push(chunk.data)
  session.outputChunkBytes.push(chunk.bytes)
  session.outputBytes += chunk.bytes
  session.outputLength += chunk.data.length
  session.lastOutputAt = Date.now()

  while (
    session.outputBytes > TERMINAL_REPLAY_BUFFER_LIMIT
    && session.outputChunkStart < session.outputChunks.length
  ) {
    const removed = session.outputChunks[session.outputChunkStart]
    const removedBytes = session.outputChunkBytes[session.outputChunkStart] ?? 0
    session.outputChunkStart += 1
    session.outputBytes -= removedBytes
    session.outputLength -= removed?.length ?? 0
  }

  if (
    session.outputChunkStart >= TERMINAL_REPLAY_COMPACT_THRESHOLD
    && session.outputChunkStart > session.outputChunks.length / 2
  ) {
    session.outputChunks.splice(0, session.outputChunkStart)
    session.outputChunkBytes.splice(0, session.outputChunkStart)
    session.outputChunkStart = 0
  }
}

function materializeTerminalReplay(session: TerminalSession): string {
  return session.outputChunks.slice(session.outputChunkStart).join('')
}

function getTerminalSnapshot(session: TerminalSession): TerminalSessionSnapshot {
  return {
    sessionId: session.sessionId,
    running: !session.hasExited && !session.isDisposed,
    kind: session.kind,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    terminalId: session.terminalId,
    cli: session.cli,
    cwd: session.cwd,
    swarmStatePath: session.swarmStatePath,
    executionMode: session.executionMode,
    worktreeId: session.worktreeId,
    worktreePath: session.worktreePath,
    startedAt: session.startedAt,
    lastOutputAt: session.lastOutputAt,
    outputBufferLength: session.outputLength,
    retainedOutputBytes: session.outputBytes,
  }
}

function disposeTerminal(sessionId: string): void {
  const session = terminals.get(sessionId)
  if (!session) return

  cleanupTerminalStartupScript(session.startupScriptPath)
  flushTerminalData(sessionId, 'dispose')
  terminalBatchDiagnostics.delete(sessionId)
  terminalInputDiagnostics.delete(sessionId)
  session.isDisposed = true
  session.hasExited = true
  terminals.delete(sessionId)
  broadcastTerminalSessionsChanged()

  try {
    session.process.kill()
  } catch {
    // ignore kill errors if process died first
  }
}

function disposeOtherAgentSessions(
  sessionId: string,
  workspaceId: string | undefined,
  agentId: string | undefined,
  swarmStatePath: string | undefined
): void {
  if (!workspaceId || !agentId) return

  const duplicateSessionIds = [...terminals.values()]
    .filter((session) => (
      session.sessionId !== sessionId
      && !session.hasExited
      && !session.isDisposed
      && session.kind === 'agent'
      && session.workspaceId === workspaceId
      && session.agentId === agentId
      && (!swarmStatePath || !session.swarmStatePath || session.swarmStatePath === swarmStatePath)
    ))
    .map((session) => session.sessionId)

  duplicateSessionIds.forEach(disposeTerminal)
}

function createMobileCommandService(): MobileSwarmCommandService {
  const orchestrator = new DesktopMobileSwarmSessionOrchestrator({
    adapters: {
      listTerminals: async () => {
        return [...terminals.values()].map(getTerminalSnapshot)
      },
      spawnAgentTerminal: spawnMobileAgentTerminal,
      writeTerminal: (sessionId, data) => {
        const session = terminals.get(sessionId)
        if (!session || session.hasExited || session.isDisposed) {
          throw new Error('Desktop terminal session is no longer running.')
        }
        session.process.write(data)
      },
    },
  })

  return new MobileSwarmCommandService({
    workspaceRoot: process.cwd(),
    sessionOrchestrator: orchestrator,
  })
}

async function spawnMobileAgentTerminal(input: {
  sessionId: string
  cwd: string
  swarmStatePath: string
  agentId: string
  initialPrompt: string
  cli: AgentCli
  executionMode: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
}): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const sender = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())?.webContents
  if (!sender) {
    return { ok: false, message: 'No desktop window is available to host a mobile-started agent terminal.' }
  }

  try {
    requireAuthenticatedUser('Sign in to launch Sprint Engine specialist workflows from the app.')
  } catch (error) {
    return { ok: false, message: getErrorMessage(error) }
  }

  disposeTerminal(input.sessionId)

  try {
    const { command, args, cwd: launchCwd, initialInput, env, startupScriptPath } = getShellLaunchConfig(
      input.cwd,
      input.sessionId,
      false,
      input.swarmStatePath,
      input.cli,
      input.initialPrompt,
      undefined,
      'auto_workspace'
    )
    const initialSize = getTerminalSize(120, 30)
    const termProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: launchCwd ?? input.cwd,
      env: env ?? getTerminalEnv(),
    })
    const terminalSession: TerminalSession = {
      sessionId: input.sessionId,
      process: termProcess,
      sender,
      isReady: process.platform !== 'win32',
      hasExited: false,
      isDisposed: false,
      outputChunks: [],
      outputChunkBytes: [],
      outputChunkStart: 0,
      outputBytes: 0,
      outputLength: 0,
      kind: 'agent',
      agentId: input.agentId,
      cli: input.cli,
      cwd: launchCwd ?? input.cwd,
      swarmStatePath: input.swarmStatePath,
      executionMode: input.executionMode,
      worktreeId: input.worktreeId,
      worktreePath: input.worktreePath,
      startedAt: Date.now(),
      lastOutputAt: null,
      lastInputAt: null,
      startupScriptPath,
    }

    terminals.set(input.sessionId, terminalSession)
    broadcastTerminalSessionsChanged()
    termProcess.onData((data) => {
      if (!terminalSession.isReady) {
        terminalSession.isReady = true
        flushPendingTerminalResize(input.sessionId, terminalSession)
      }
      appendTerminalOutput(terminalSession, data)
      sendTerminalData(terminalSession, data)
    })
    termProcess.onExit((event) => {
      cleanupTerminalStartupScript(terminalSession.startupScriptPath)
      flushTerminalData(input.sessionId, 'exit')
      terminalBatchDiagnostics.delete(input.sessionId)
      terminalInputDiagnostics.delete(input.sessionId)
      terminalSession.hasExited = true
      if (terminals.get(input.sessionId) === terminalSession) {
        terminals.delete(input.sessionId)
        broadcastTerminalSessionsChanged()
      }
      if (!terminalSession.isDisposed) {
        sendTerminalEvent(terminalSession.sender, `terminal:exit:${input.sessionId}`, event.exitCode)
      }
    })
    if (initialInput) {
      termProcess.write(initialInput)
    }

    return { ok: true, sessionId: input.sessionId }
  } catch (error) {
    return { ok: false, message: getTerminalErrorMessage(error) }
  }
}

async function spawnTerminalFromIpc(
  sender: WebContents,
  {
    sessionId,
    cols,
    rows,
    cwd,
    resume,
    swarmStatePath,
    cli = 'codex',
    initialPrompt,
    cliRuntimes,
    shellOnly,
    kind,
    workspaceId,
    agentId,
    terminalId,
    executionMode,
    worktreeId,
    worktreePath,
    cliPermissionPreset = 'default',
    memoryRootPath,
    memoryRelativeRoot,
  }: TerminalSpawnPayload
): Promise<TerminalSpawnResult> {
    const existingSession = terminals.get(sessionId)
    if (existingSession && !existingSession.hasExited && !existingSession.isDisposed) {
      existingSession.sender = sender
      existingSession.workspaceId = workspaceId ?? existingSession.workspaceId
      existingSession.agentId = agentId ?? existingSession.agentId
      existingSession.terminalId = terminalId ?? existingSession.terminalId
      existingSession.kind = kind ?? existingSession.kind
      existingSession.executionMode = executionMode ?? existingSession.executionMode
      existingSession.worktreeId = worktreeId ?? existingSession.worktreeId
      existingSession.worktreePath = worktreePath ?? existingSession.worktreePath
      safeResizeTerminal(sessionId, cols, rows)
      const replay = materializeTerminalReplay(existingSession)
      if (replay) {
        sendTerminalEvent(sender, `terminal:data:${sessionId}`, replay)
      }
      broadcastTerminalSessionsChanged()
      return { ok: true, sessionId } satisfies TerminalSpawnResult
    }

    disposeTerminal(sessionId)

    try {
      const workingDirectory = cwd || process.cwd()
      if (swarmStatePath && (kind ?? (shellOnly ? 'terminal' : 'agent')) === 'agent') {
        try {
          requireAuthenticatedUser('Sign in to launch Sprint Engine specialist workflows from the app.')
        } catch (error) {
          const message = getErrorMessage(error)
          sendTerminalEvent(sender, `terminal:error:${sessionId}`, message)
          sendTerminalEvent(sender, `terminal:exit:${sessionId}`, 1)
          return {
            ok: false,
            sessionId,
            message,
            exitCode: 1,
          } satisfies TerminalSpawnResult
        }
      }
      if ((kind ?? (shellOnly ? 'terminal' : 'agent')) === 'agent') {
        disposeOtherAgentSessions(sessionId, workspaceId, agentId, swarmStatePath)
      }

      const { command, args, cwd: launchCwd, initialInput, env, startupScriptPath } = shellOnly
        ? getPlainShellLaunchConfig(workingDirectory, swarmStatePath, sessionId)
        : getShellLaunchConfig(
          workingDirectory,
          sessionId,
          resume,
          swarmStatePath,
          cli,
          initialPrompt,
          cliRuntimes,
          cliPermissionPreset,
          memoryRootPath,
          memoryRelativeRoot
        )
      const initialSize = getTerminalSize(cols, rows)
      const termProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: initialSize.cols,
        rows: initialSize.rows,
        cwd: launchCwd ?? workingDirectory,
        env: env ?? getTerminalEnv(),
      })
      const terminalSession: TerminalSession = {
        sessionId,
        process: termProcess,
        sender,
        isReady: process.platform !== 'win32',
        hasExited: false,
        isDisposed: false,
        outputChunks: [],
        outputChunkBytes: [],
        outputChunkStart: 0,
        outputBytes: 0,
        outputLength: 0,
        kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
        workspaceId,
        agentId,
        terminalId,
        cli: shellOnly ? undefined : cli,
        cwd: launchCwd ?? workingDirectory,
        swarmStatePath,
        executionMode,
        worktreeId,
        worktreePath,
        startedAt: Date.now(),
        lastOutputAt: null,
        lastInputAt: null,
        startupScriptPath,
      }

      terminals.set(sessionId, terminalSession)
      broadcastTerminalSessionsChanged()

      termProcess.onData((data) => {
        if (!terminalSession.isReady) {
          terminalSession.isReady = true
          flushPendingTerminalResize(sessionId, terminalSession)
        }
        appendTerminalOutput(terminalSession, data)
        sendTerminalData(terminalSession, data)
      })

      termProcess.onExit((e) => {
        cleanupTerminalStartupScript(terminalSession.startupScriptPath)
        flushTerminalData(sessionId, 'exit')
        terminalBatchDiagnostics.delete(sessionId)
        terminalInputDiagnostics.delete(sessionId)
        terminalSession.hasExited = true
        if (terminals.get(sessionId) === terminalSession) {
          terminals.delete(sessionId)
          broadcastTerminalSessionsChanged()
        }
        if (!terminalSession.isDisposed) {
          sendTerminalEvent(terminalSession.sender, `terminal:exit:${sessionId}`, e.exitCode)
        }
      })

      if (initialInput) {
        // Start the selected agent CLI inside the interactive shell so the user can keep using the terminal afterward.
        termProcess.write(initialInput)
      }

      return { ok: true, sessionId } satisfies TerminalSpawnResult
    } catch (error) {
      const message = getTerminalErrorMessage(error)
      sendTerminalEvent(sender, `terminal:error:${sessionId}`, message)
      sendTerminalEvent(sender, `terminal:exit:${sessionId}`, 1)
      return {
        ok: false,
        sessionId,
        message,
        exitCode: 1,
      } satisfies TerminalSpawnResult
    }
}

function writeTerminalInput(sessionId: string, data: string): void {
  const startedAt = Date.now()
  const session = terminals.get(sessionId)
  if (!session || session.hasExited || session.isDisposed) return

  try {
    session.lastInputAt = Date.now()
    session.process.write(data)
    recordTerminalInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, true)
  } catch {
    session.hasExited = true
    recordTerminalInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, false)
  }
}

