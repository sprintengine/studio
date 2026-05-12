import { BrowserWindow, type WebContents } from 'electron'
import * as pty from 'node-pty'
import type {
  AgentCli,
  AgentExecutionMode,
  AgentSessionIdentity,
  AgentSessionMetadata,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { SwitchboardAgentSpawnDescriptor } from '../shared/switchboard'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'
import {
  cleanupTerminalStartupScript,
  getPlainShellLaunchConfig,
  getShellLaunchConfig,
  getTerminalEnv,
} from './terminal-launch'
import { getErrorMessage } from './error-message'
import { getTerminalErrorMessage } from './terminal-error'
import { MobileSprintEngineCommandService } from './mobile/sprintengine/command'
import {
  appendTerminalOutput,
  getTerminalSize,
  getTerminalSnapshot,
  materializeTerminalReplay,
  type TerminalSession,
} from './terminal-session'
import { createTerminalDiagnostics } from './terminal-diagnostics'
import { createTerminalOutputBuffer } from './terminal-output-buffer'
import { createTerminalMobileCommandService } from './terminal-mobile-command-service'

type TerminalRuntimeOptions = {
  diagnosticsEnabled: boolean
  requireAuthenticatedUser(message: string): void
  logMainPerfEvent(scope: string, event: string, payload: Record<string, unknown>): void
  onAgentSessionExit?(input: {
    workspaceRoot: string
    workspaceId?: string
    executionId: string
    exitCode: number
  }): void | Promise<void>
}

type TerminalIpcHandlers = {
  spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  getTerminalStatus(sessionId: string): { running: boolean }
  listTerminals(): TerminalSessionSnapshot[]
  setTerminalVisible(sessionId: string, visible: boolean): void
  killTerminal(sessionId: string): void
}

type TerminalRuntime = {
  commandService: MobileSprintEngineCommandService
  ipcHandlers: TerminalIpcHandlers
  shutdown(): Promise<void>
  getLiveAgentExecutionIds(): string[]
  killAgentSession(input: {
    workspaceRoot: string
    executionId: string
  }): void
  spawnAgentSession(input: {
    workspaceId?: string
    workspaceRoot: string
    descriptor: SwitchboardAgentSpawnDescriptor
  }): Promise<TerminalSpawnResult>
}

let requireAuthenticatedUser = (_message: string): void => {}
let terminalDiagnostics = createTerminalDiagnostics({
  enabled: false,
  logMainPerfEvent: () => {},
})
let onAgentSessionExit: TerminalRuntimeOptions['onAgentSessionExit']
export function createTerminalRuntime(options: TerminalRuntimeOptions): TerminalRuntime {
  requireAuthenticatedUser = options.requireAuthenticatedUser
  onAgentSessionExit = options.onAgentSessionExit
  terminalDiagnostics = createTerminalDiagnostics({
    enabled: options.diagnosticsEnabled,
    logMainPerfEvent: options.logMainPerfEvent,
  })

  return {
    commandService: createMobileCommandService(),
    shutdown: disposeAllTerminals,
    getLiveAgentExecutionIds,
    killAgentSession: killAgentSessionByExecutionId,
    spawnAgentSession: spawnAgentSessionFromDescriptor,
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
          .filter((session) => !session.isDisposed)
          .map(getTerminalSnapshot)
      },
      setTerminalVisible: setTerminalVisible,
      killTerminal: disposeTerminal,
    },
  }
}

// ── Claude Code CLI Terminal IPC ──────────────────────────────────────────────

const terminals = new Map<string, TerminalSession>()
const pendingAgentSessionExitRecords = new Set<Promise<void>>()

function descriptorPromptInput(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined
  return process.platform === 'win32' ? `${prompt}\r\n\x1a\r\n` : `${prompt}\n\x04`
}
function sendTerminalEvent(
  sender: Electron.WebContents,
  channel: string,
  payload: string | number
): void {
  if (!sender.isDestroyed()) {
    sender.send(channel, payload)
  }
}

const terminalOutput = createTerminalOutputBuffer({
  getSession: (sessionId) => terminals.get(sessionId),
  sendTerminalEvent,
  recordDataBatch: (session, cause, chunkCount, byteCount) => {
    terminalDiagnostics.recordDataBatch(session, cause, chunkCount, byteCount)
  },
})

function broadcastTerminalSessionsChanged(): void {
  const snapshots = [...terminals.values()]
    .filter((session) => !session.isDisposed)
    .map(getTerminalSnapshot)

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('terminal:sessions-changed', snapshots)
    }
  }
}

function setTerminalVisible(sessionId: string, visible: boolean): void {
  const session = terminals.get(sessionId)
  if (!session || session.hasExited || session.isDisposed) return
  session.visible = visible
  broadcastTerminalSessionsChanged()
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

function disposeTerminal(sessionId: string): void {
  const session = terminals.get(sessionId)
  if (!session) return

  cleanupTerminalStartupScript(session.startupScriptPath)
  terminalOutput.flush(sessionId, 'dispose')
  terminalDiagnostics.clear(sessionId)
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

async function waitForTerminalExit(session: TerminalSession, timeoutMs: number): Promise<boolean> {
  if (session.hasExited || session.isDisposed) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose()
      resolve(false)
    }, timeoutMs)
    const disposable = session.process.onExit(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function disposeAllTerminals(): Promise<void> {
  const sessions = [...terminals.values()].filter((session) => !session.isDisposed)
  for (const session of sessions) {
    cleanupTerminalStartupScript(session.startupScriptPath)
    terminalOutput.flush(session.sessionId, 'dispose')
    terminalDiagnostics.clear(session.sessionId)
    try {
      session.process.kill()
    } catch {
      // ignore kill errors if process died first
    }
  }

  const settled = await Promise.all(sessions.map((session) => waitForTerminalExit(session, 1_500)))
  sessions.forEach((session, index) => {
    if (!settled[index] && !session.hasExited && !session.isDisposed) {
      try {
        session.process.kill('SIGKILL')
      } catch {
        // node-pty kill is best-effort during app shutdown.
      }
    }
  })
  await Promise.all(sessions.map((session) => waitForTerminalExit(session, 500)))
  await Promise.allSettled([...pendingAgentSessionExitRecords])

  for (const session of sessions) {
    if (terminals.get(session.sessionId) === session) {
      session.isDisposed = true
      session.hasExited = true
      terminals.delete(session.sessionId)
    }
  }
  broadcastTerminalSessionsChanged()
}

function getLiveAgentExecutionIds(): string[] {
  return [...terminals.values()]
    .filter((session) => (
      !session.hasExited
      && !session.isDisposed
      && (session.agentSession?.system === 'switchboard' || session.agentSession?.system === 'watchtower')
    ))
    .map((session) => session.agentSession?.executionId)
    .filter((executionId): executionId is string => Boolean(executionId))
}

function killAgentSessionByExecutionId(input: { workspaceRoot: string; executionId: string }): void {
  const workspaceRoot = input.workspaceRoot
  const executionId = input.executionId
  const matchingSessionIds = [...terminals.values()]
    .filter((session) => (
      !session.hasExited
      && !session.isDisposed
      && session.agentSession?.workspaceRoot === workspaceRoot
      && session.agentSession.executionId === executionId
    ))
    .map((session) => session.sessionId)

  matchingSessionIds.forEach(disposeTerminal)
}

function disposeOtherAgentSessions(
  sessionId: string,
  workspaceId: string | undefined,
  agentId: string | undefined,
  sprintEngineStatePath: string | undefined
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
      && (!sprintEngineStatePath || !session.sprintEngineStatePath || session.sprintEngineStatePath === sprintEngineStatePath)
    ))
    .map((session) => session.sessionId)

  duplicateSessionIds.forEach(disposeTerminal)
}

function materializeAgentSessionIdentity(
  sessionId: string,
  workspaceId: string | undefined,
  agentSession: AgentSessionMetadata | undefined
): AgentSessionIdentity | undefined {
  if (!agentSession) return undefined

  return {
    sessionId: agentSession.sessionId ?? sessionId,
    executionId: agentSession.executionId,
    system: agentSession.system,
    workspaceId: agentSession.workspaceId || workspaceId || '',
    workspaceRoot: agentSession.workspaceRoot,
    workId: agentSession.workId,
    role: agentSession.role,
    displayName: agentSession.displayName,
  }
}

function attachTerminalSession(
  sessionId: string,
  terminalSession: TerminalSession,
  initialInput: string | undefined
): void {
  terminals.set(sessionId, terminalSession)
  broadcastTerminalSessionsChanged()

  terminalSession.process.onData((data) => {
    if (!terminalSession.isReady) {
      terminalSession.isReady = true
      flushPendingTerminalResize(sessionId, terminalSession)
    }
    appendTerminalOutput(terminalSession, data)
    terminalOutput.send(terminalSession, data)
  })

  terminalSession.process.onExit((event) => {
    cleanupTerminalStartupScript(terminalSession.startupScriptPath)
    terminalOutput.flush(sessionId, 'exit')
    terminalDiagnostics.clear(sessionId)
    terminalSession.hasExited = true
    terminalSession.exitCode = event.exitCode
    if (terminalSession.agentSession?.system === 'switchboard' || terminalSession.agentSession?.system === 'watchtower') {
      const exitRecord = Promise.resolve(onAgentSessionExit?.({
        workspaceRoot: terminalSession.agentSession.workspaceRoot,
        workspaceId: terminalSession.agentSession.workspaceId,
        executionId: terminalSession.agentSession.executionId,
        exitCode: event.exitCode,
      })).catch(() => {})
      pendingAgentSessionExitRecords.add(exitRecord)
      void exitRecord.finally(() => {
        pendingAgentSessionExitRecords.delete(exitRecord)
      })
    }
    if (terminals.get(sessionId) === terminalSession) {
      broadcastTerminalSessionsChanged()
    }
    if (!terminalSession.isDisposed) {
      sendTerminalEvent(terminalSession.sender, `terminal:exit:${sessionId}`, event.exitCode)
    }
  })

  if (initialInput) {
    terminalSession.process.write(initialInput)
  }
}

async function spawnAgentSessionFromDescriptor(input: {
  workspaceId?: string
  workspaceRoot: string
  descriptor: SwitchboardAgentSpawnDescriptor
}): Promise<TerminalSpawnResult> {
  const sender = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())?.webContents
  if (!sender) {
    return {
      ok: false,
      sessionId: input.descriptor.executionId,
      message: 'No desktop window is available to host the agent terminal.',
      exitCode: 1,
    }
  }

  const [command, ...args] = input.descriptor.command
  if (!command) {
    return {
      ok: false,
      sessionId: input.descriptor.executionId,
      message: 'Agent descriptor did not include a command.',
      exitCode: 1,
    }
  }

  disposeTerminal(input.descriptor.executionId)

  try {
    const initialSize = getTerminalSize(120, 30)
    const termProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: input.descriptor.cwd,
      env: {
        ...getTerminalEnv(),
        ...(input.descriptor.env ?? {}),
      },
    })
    const terminalSession: TerminalSession = {
      sessionId: input.descriptor.executionId,
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
      pathStyle: process.platform === 'win32' ? 'windows' : 'posix',
      workspaceId: input.workspaceId,
      agentId: input.descriptor.executionId,
      cli: input.descriptor.cli,
      cwd: input.descriptor.cwd,
      agentSession: {
        sessionId: input.descriptor.executionId,
        executionId: input.descriptor.executionId,
        system: input.descriptor.system,
        workspaceId: input.workspaceId ?? '',
        workspaceRoot: input.workspaceRoot,
        workId: input.descriptor.workId,
        role: input.descriptor.role,
        displayName: input.descriptor.displayName,
      },
      visible: false,
      startedAt: Date.now(),
      lastOutputAt: null,
      lastInputAt: null,
    }

    attachTerminalSession(input.descriptor.executionId, terminalSession, descriptorPromptInput(input.descriptor.prompt))
    return { ok: true, sessionId: input.descriptor.executionId }
  } catch (error) {
    return {
      ok: false,
      sessionId: input.descriptor.executionId,
      message: getTerminalErrorMessage(error),
      exitCode: 1,
    }
  }
}

function createMobileCommandService(): MobileSprintEngineCommandService {
  return createTerminalMobileCommandService({
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
  })
}

async function spawnMobileAgentTerminal(input: {
  sessionId: string
  cwd: string
  sprintEngineStatePath: string
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
    const { command, args, cwd: launchCwd, pathStyle, initialInput, env, startupScriptPath } = getShellLaunchConfig(
      input.cwd,
      input.sessionId,
      false,
      input.sprintEngineStatePath,
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
      pathStyle,
      agentId: input.agentId,
      cli: input.cli,
      cwd: launchCwd ?? input.cwd,
      sprintEngineStatePath: input.sprintEngineStatePath,
      executionMode: input.executionMode,
      worktreeId: input.worktreeId,
      worktreePath: input.worktreePath,
      visible: false,
      startedAt: Date.now(),
      lastOutputAt: null,
      lastInputAt: null,
      startupScriptPath,
    }

    attachTerminalSession(input.sessionId, terminalSession, initialInput)

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
    sprintEngineStatePath,
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
    agentSession,
    visible = true,
  }: TerminalSpawnPayload
): Promise<TerminalSpawnResult> {
    const existingSession = terminals.get(sessionId)
    if (existingSession && !existingSession.isDisposed) {
      existingSession.sender = sender
      existingSession.workspaceId = workspaceId ?? existingSession.workspaceId
      existingSession.agentId = agentId ?? existingSession.agentId
      existingSession.terminalId = terminalId ?? existingSession.terminalId
      existingSession.kind = kind ?? existingSession.kind
      existingSession.executionMode = executionMode ?? existingSession.executionMode
      existingSession.worktreeId = worktreeId ?? existingSession.worktreeId
      existingSession.worktreePath = worktreePath ?? existingSession.worktreePath
      existingSession.agentSession = materializeAgentSessionIdentity(sessionId, workspaceId, agentSession) ?? existingSession.agentSession
      existingSession.visible = visible
      if (!existingSession.hasExited) {
        safeResizeTerminal(sessionId, cols, rows)
      }
      const replay = materializeTerminalReplay(existingSession)
      if (replay) {
        sendTerminalEvent(sender, `terminal:data:${sessionId}`, replay)
      }
      if (existingSession.hasExited) {
        sendTerminalEvent(sender, `terminal:exit:${sessionId}`, existingSession.exitCode ?? 0)
      }
      broadcastTerminalSessionsChanged()
      return { ok: true, sessionId } satisfies TerminalSpawnResult
    }

    disposeTerminal(sessionId)

    try {
      const workingDirectory = cwd || process.cwd()
      if (sprintEngineStatePath && (kind ?? (shellOnly ? 'terminal' : 'agent')) === 'agent') {
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
        disposeOtherAgentSessions(sessionId, workspaceId, agentId, sprintEngineStatePath)
      }

      const { command, args, cwd: launchCwd, pathStyle, initialInput, env, startupScriptPath } = shellOnly
        ? getPlainShellLaunchConfig(workingDirectory, sprintEngineStatePath, sessionId)
        : getShellLaunchConfig(
          workingDirectory,
          sessionId,
          resume,
          sprintEngineStatePath,
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
        pathStyle,
        workspaceId,
        agentId,
        terminalId,
        cli: shellOnly ? undefined : cli,
        cwd: launchCwd ?? workingDirectory,
        sprintEngineStatePath,
        executionMode,
        worktreeId,
        worktreePath,
        agentSession: materializeAgentSessionIdentity(sessionId, workspaceId, agentSession),
        visible,
        startedAt: Date.now(),
        lastOutputAt: null,
        lastInputAt: null,
        startupScriptPath,
      }

      attachTerminalSession(sessionId, terminalSession, initialInput)

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
    terminalDiagnostics.recordInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, true)
  } catch {
    session.hasExited = true
    terminalDiagnostics.recordInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, false)
  }
}
