import { BrowserWindow, type WebContents } from 'electron'
import * as pty from 'node-pty'
import type {
  AgentCli,
  AgentExecutionMode,
  AgentSessionIdentity,
  AgentSessionMetadata,
  McpSettings,
  SessionActivity,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { SwitchboardAgentSpawnDescriptor } from '../shared/switchboard'
import { createAgentStreamWatcher } from './agent-stream-watcher'
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
import { getPluginRegistryUserRoot, getPluginSprintEngineRegistryRoots } from './plugin-registry-instance'
import {
  appendTerminalOutput,
  clearTerminalIdleTimer,
  createFailedTerminalSession,
  createInitialTerminalActivity,
  getTerminalLastSeenAt,
  getTerminalSize,
  getTerminalSnapshot,
  getTerminalIdleTimeoutMs,
  isTerminalProcessAlive,
  isTerminalSessionStale,
  materializeTerminalReplay,
  recordTerminalInput,
  recordTerminalVisibility,
  transitionTerminalActivity,
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
  syncMcpConfig?(input: {
    workspaceRoot: string
    settings: McpSettings
    clients: AgentCli[]
    managedSprintEngine?: {
      statePath: string
      workspaceRoot?: string
      allowedRoots?: string[]
      registryRoots?: string[]
      userRoot?: string
      actorId?: string
      workspaceId?: string
      agentId?: string
      role?: string
      cli?: AgentCli
      http?: {
        url: string
        authTokenEnvVar?: string
        headers?: Record<string, string>
      }
    }
  }): Promise<{ ok: true; managedSprintEngineRunId?: string; runTokenEnv?: Record<string, string> } | { ok: false; message: string }>
  releaseManagedSprintEngineRun?(input: {
    runId: string
    workspaceRoot: string
    clients: AgentCli[]
    cleanupMcpConfig: boolean
  }): Promise<void> | void
  callManagedSprintEngineTool?(input: {
    runId: string
    toolName: string
    arguments?: Record<string, unknown>
  }): Promise<unknown>
}

type TerminalIpcHandlers = {
  spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  getTerminalStatus(sessionId: string): { processAlive: boolean }
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
    mcpSettings?: McpSettings
  }): Promise<TerminalSpawnResult>
}

let requireAuthenticatedUser = (_message: string): void => {}
let terminalDiagnostics = createTerminalDiagnostics({
  enabled: false,
  logMainPerfEvent: () => {},
})
let logMainPerfEvent: TerminalRuntimeOptions['logMainPerfEvent'] = () => {}
let onAgentSessionExit: TerminalRuntimeOptions['onAgentSessionExit']
let syncMcpConfig: TerminalRuntimeOptions['syncMcpConfig']
let releaseManagedSprintEngineRun: TerminalRuntimeOptions['releaseManagedSprintEngineRun']
let callManagedSprintEngineTool: TerminalRuntimeOptions['callManagedSprintEngineTool']
const sprintEngineMcpRunRefCounts = new Map<string, number>()
const sprintEngineMcpWorkspaceRefCounts = new Map<string, number>()
const pendingSprintEngineMcpRunReleases = new Set<Promise<void>>()
const sprintEngineAgentHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
const pendingSprintEngineLifecycleCalls = new Set<Promise<void>>()
const pendingSprintEngineTerminalTeardowns = new Map<string, { session: TerminalSession; promise: Promise<void> }>()

export const SPRINTENGINE_AGENT_HEARTBEAT_INTERVAL_MS = 60 * 1000

export function buildManagedSprintEngineSyncInputForLaunch(
  statePath: string,
  workspaceRoot: string,
  launch?: {
    workspaceId?: string
    agentId?: string
    role?: string
    cli?: AgentCli
  }
): NonNullable<Parameters<NonNullable<TerminalRuntimeOptions['syncMcpConfig']>>[0]['managedSprintEngine']> {
  return {
    statePath,
    workspaceRoot,
    allowedRoots: [workspaceRoot],
    registryRoots: sprintEngineRegistryRootsForLaunch(),
    userRoot: getPluginRegistryUserRoot(),
    actorId: 'multicode-app',
    workspaceId: launch?.workspaceId,
    agentId: launch?.agentId,
    role: launch?.role,
    cli: launch?.cli,
  }
}

function sprintEngineRegistryRootsForLaunch(): string[] {
  try {
    return getPluginSprintEngineRegistryRoots().map((root) => root.root)
  } catch {
    return []
  }
}

function sprintEngineRoleForLaunch(role: string | undefined, agentId: string | undefined): string | undefined {
  if (role?.trim()) return role.trim()
  const normalizedAgentId = agentId?.trim()
  if (!normalizedAgentId) return undefined
  const indexedRoleMatch = normalizedAgentId.match(/^(.+)-\d+$/)
  return indexedRoleMatch?.[1]
}

export function createTerminalRuntime(options: TerminalRuntimeOptions): TerminalRuntime {
  requireAuthenticatedUser = options.requireAuthenticatedUser
  onAgentSessionExit = options.onAgentSessionExit
  syncMcpConfig = options.syncMcpConfig
  releaseManagedSprintEngineRun = options.releaseManagedSprintEngineRun
  callManagedSprintEngineTool = options.callManagedSprintEngineTool
  sprintEngineMcpRunRefCounts.clear()
  sprintEngineMcpWorkspaceRefCounts.clear()
  pendingSprintEngineMcpRunReleases.clear()
  pendingSprintEngineLifecycleCalls.clear()
  pendingSprintEngineTerminalTeardowns.clear()
  logMainPerfEvent = options.logMainPerfEvent
  terminalDiagnostics = createTerminalDiagnostics({
    enabled: options.diagnosticsEnabled,
    logMainPerfEvent: options.logMainPerfEvent,
  })
  startStaleTerminalSweep()

  return {
    commandService: createMobileCommandService(),
    shutdown: shutdownTerminalRuntime,
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
          processAlive: Boolean(session && isTerminalProcessAlive(session)),
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

function descriptorPromptKeystrokes(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined
  // Without an EOF, the agent reads the prompt as user input and waits for
  // more (interactive subscription-billed mode). The trailing newline acts
  // as the Enter key the agent's REPL expects.
  return process.platform === 'win32' ? `${prompt}\r\n` : `${prompt}\n`
}

function installAgentLifecycleWatcher(
  terminalSession: TerminalSession,
  descriptor: SwitchboardAgentSpawnDescriptor,
  injectionMode: 'positional-arg' | 'stdin-pipe' | 'send-after-ready'
): void {
  const completionMode = descriptor.completion?.mode ?? 'process-exit'
  const needsReadinessWatch = injectionMode === 'send-after-ready'
  const needsCompletionWatch = completionMode === 'output-sentinel'
  if (!needsReadinessWatch && !needsCompletionWatch) return

  let readinessPattern: RegExp | undefined
  if (needsReadinessWatch && descriptor.injection?.readiness) {
    try {
      readinessPattern = new RegExp(descriptor.injection.readiness.pattern, 'm')
    } catch (err) {
      console.error(
        `Invalid readiness regex from agent descriptor ${descriptor.executionId}: ${String(err)}`
      )
    }
  }

  const watcher = createAgentStreamWatcher({
    readinessPattern,
    completionSentinel:
      completionMode === 'output-sentinel' ? descriptor.completion?.sentinel : undefined,
  })

  let readinessTimer: NodeJS.Timeout | null = null
  if (needsReadinessWatch && descriptor.injection?.readiness?.timeoutMs) {
    readinessTimer = setTimeout(() => {
      // If readiness never fires, fall back to writing the prompt anyway so
      // the autonomous runner does not stall forever on a quiet pty. The
      // worst case is the prompt arrives before the agent's REPL is ready
      // and the agent ignores it — which still beats a stuck session.
      if (!terminalSession.isDisposed) {
        const fallback = descriptorPromptKeystrokes(descriptor.prompt)
        if (fallback) terminalSession.process.write(fallback)
      }
    }, descriptor.injection.readiness.timeoutMs)
  }

  terminalSession.process.onData((data: string) => {
    const result = watcher.ingest(data)
    if (result.readyMatched && needsReadinessWatch) {
      if (readinessTimer) {
        clearTimeout(readinessTimer)
        readinessTimer = null
      }
      const keystrokes = descriptorPromptKeystrokes(descriptor.prompt)
      if (keystrokes && !terminalSession.isDisposed) {
        terminalSession.process.write(keystrokes)
      }
    }
    if (result.completionMatched && needsCompletionWatch) {
      // The agent has signalled it is done. Killing the pty triggers the
      // existing onExit pathway, which records the agent session exit and
      // tears the session down. We do not write an interactive /exit because
      // the agent should already be quiescent at this point.
      if (!terminalSession.isDisposed) {
        try {
          terminalSession.process.kill()
        } catch {
          // Best-effort: node-pty can race with the underlying process.
        }
      }
    }
  })
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
  if (!session || session.isDisposed) return
  recordTerminalVisibility(session, visible)
  broadcastTerminalSessionsChanged()
}

function safeResizeTerminal(sessionId: string, cols: number, rows: number): void {
  const session = terminals.get(sessionId)
  if (!session || !isTerminalProcessAlive(session)) return

  const size = getTerminalSize(cols, rows)
  if (process.platform === 'win32' && !session.isReady) {
    session.pendingResize = size
    return
  }

  try {
    session.process.resize(size.cols, size.rows)
  } catch {
    // node-pty can report resize-after-exit races before its exit event is delivered.
    setTerminalActivity(session, { kind: 'exited', at: Date.now(), exitCode: session.exitCode ?? 0 })
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

  void queueSprintEngineTerminalTeardown(session, 'terminal disposed')
  cleanupTerminalStartupScript(session.startupScriptPath)
  terminalOutput.flush(sessionId, 'dispose')
  terminalDiagnostics.clear(sessionId)
  session.isDisposed = true
  setTerminalActivity(session, { kind: 'exited', at: Date.now(), exitCode: session.exitCode ?? 0 }, { broadcast: false })
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

export const STALE_TERMINAL_SWEEP_INTERVAL_MS = 15 * 60 * 1000

let staleTerminalSweepTimer: ReturnType<typeof setInterval> | undefined

function startStaleTerminalSweep(): void {
  if (staleTerminalSweepTimer) clearInterval(staleTerminalSweepTimer)
  staleTerminalSweepTimer = setInterval(() => {
    reapStaleTerminals()
  }, STALE_TERMINAL_SWEEP_INTERVAL_MS)
  staleTerminalSweepTimer.unref?.()
}

function stopStaleTerminalSweep(): void {
  if (!staleTerminalSweepTimer) return
  clearInterval(staleTerminalSweepTimer)
  staleTerminalSweepTimer = undefined
}

// Reap terminals nobody has looked at for the stale window: no mounted view,
// no user input, and no process output. Disposing through `disposeTerminal`
// deliberately skips the renderer `terminal:exit` event, so agent launch flags
// stay intact and reopening the workspace re-launches the CLI with resume.
export function reapStaleTerminals(now = Date.now()): string[] {
  const staleSessionIds = [...terminals.values()]
    .filter((session) => isTerminalSessionStale(session, now))
    .map((session) => session.sessionId)

  for (const sessionId of staleSessionIds) {
    const session = terminals.get(sessionId)
    if (!session) continue
    logMainPerfEvent('TerminalRuntime', 'terminal-stale-reaped', {
      sessionId,
      kind: session.kind,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      terminalId: session.terminalId,
      cli: session.cli,
      processAlive: isTerminalProcessAlive(session),
      lastSeenAt: getTerminalLastSeenAt(session),
      unseenMs: now - getTerminalLastSeenAt(session),
    })
    disposeTerminal(sessionId)
  }
  return staleSessionIds
}

async function shutdownTerminalRuntime(): Promise<void> {
  stopStaleTerminalSweep()
  await disposeAllTerminals()
  await Promise.allSettled([...pendingSprintEngineTerminalTeardowns.values()].map((entry) => entry.promise))
  await Promise.allSettled([...pendingSprintEngineLifecycleCalls])
  await Promise.allSettled([...pendingSprintEngineMcpRunReleases])
}

async function disposeAllTerminals(): Promise<void> {
  const sessions = [...terminals.values()].filter((session) => !session.isDisposed)
  const teardownPromises: Promise<void>[] = []
  for (const session of sessions) {
    teardownPromises.push(queueSprintEngineTerminalTeardown(session, 'terminal runtime shutdown'))
    cleanupTerminalStartupScript(session.startupScriptPath)
    terminalOutput.flush(session.sessionId, 'dispose')
    terminalDiagnostics.clear(session.sessionId)
    clearTerminalIdleTimer(session)
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
  await Promise.allSettled(teardownPromises)
  await Promise.allSettled([...pendingSprintEngineTerminalTeardowns.values()].map((entry) => entry.promise))
  await Promise.allSettled([...pendingSprintEngineMcpRunReleases])

  for (const session of sessions) {
    if (terminals.get(session.sessionId) === session) {
      session.isDisposed = true
      setTerminalActivity(session, { kind: 'exited', at: Date.now(), exitCode: session.exitCode ?? 0 }, { broadcast: false })
      terminals.delete(session.sessionId)
    }
  }
  broadcastTerminalSessionsChanged()
  sprintEngineMcpRunRefCounts.clear()
}

function getLiveAgentExecutionIds(): string[] {
  return [...terminals.values()]
    .filter((session) => (
      isTerminalProcessAlive(session)
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
      isTerminalProcessAlive(session)
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
      && isTerminalProcessAlive(session)
      && session.kind === 'agent'
      && session.workspaceId === workspaceId
      && session.agentId === agentId
      && (!sprintEngineStatePath || !session.sprintEngineStatePath || session.sprintEngineStatePath === sprintEngineStatePath)
    ))
    .map((session) => session.sessionId)

  duplicateSessionIds.forEach(disposeTerminal)
}

function scheduleTerminalIdleTransition(session: TerminalSession): void {
  clearTerminalIdleTimer(session)
  if (!isTerminalProcessAlive(session)) return

  session.idleTimer = setTimeout(() => {
    session.idleTimer = undefined
    setTerminalActivity(session, { kind: 'idle', since: Date.now() })
  }, getTerminalIdleTimeoutMs(session))
}

function setTerminalActivity(
  session: TerminalSession,
  nextActivity: SessionActivity,
  options: { broadcast?: boolean } = {}
): boolean {
  const previousActivity = session.activity
  const changed = transitionTerminalActivity(session, nextActivity)
  if (!changed) return false

  terminalDiagnostics.recordActivityTransition(session, previousActivity, session.activity)
  if (options.broadcast !== false && terminals.get(session.sessionId) === session) {
    broadcastTerminalSessionsChanged()
  }
  return true
}

function retainFailedTerminalSession(input: {
  sessionId: string
  sender?: WebContents
  message: string
  exitCode?: number
  kind?: TerminalSession['kind']
  pathStyle?: TerminalSession['pathStyle']
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: TerminalSession['cli']
  cwd?: string
  sprintEngineStatePath?: string
  sprintEngineMcpRunId?: string
  executionMode?: TerminalSession['executionMode']
  worktreeId?: string
  worktreePath?: string
  agentSession?: TerminalSession['agentSession']
  visible?: boolean
}): TerminalSession {
  const at = Date.now()
  if (terminals.has(input.sessionId)) {
    disposeTerminal(input.sessionId)
  }
  const session = createFailedTerminalSession({
    ...input,
    at,
    exitCode: input.exitCode ?? 1,
  })
  terminals.set(input.sessionId, session)
  terminalDiagnostics.recordActivityTransition(
    session,
    { kind: 'working', since: at },
    session.activity
  )
  broadcastTerminalSessionsChanged()
  return session
}

function releaseSprintEngineMcpRun(session: TerminalSession): void {
  const runId = session.sprintEngineMcpRunId
  if (!runId) return
  const workspaceRoot = session.cwd
  const clients = session.cli ? [session.cli] : []
  session.sprintEngineMcpRunId = undefined
  releaseSprintEngineMcpRunRef(runId, {
    workspaceRoot,
    clients,
  })
}

function retainSprintEngineMcpRunRef(runId: string | undefined, workspaceRoot?: string): void {
  if (!runId) return
  sprintEngineMcpRunRefCounts.set(runId, (sprintEngineMcpRunRefCounts.get(runId) ?? 0) + 1)
  retainSprintEngineMcpWorkspaceRef(workspaceRoot)
}

function retainSprintEngineMcpWorkspaceRef(workspaceRoot: string | undefined): void {
  const key = workspaceRoot?.trim()
  if (!key) return
  sprintEngineMcpWorkspaceRefCounts.set(key, (sprintEngineMcpWorkspaceRefCounts.get(key) ?? 0) + 1)
}

function releaseSprintEngineMcpWorkspaceRef(workspaceRoot: string | undefined): boolean {
  const key = workspaceRoot?.trim()
  if (!key) return false
  const nextCount = (sprintEngineMcpWorkspaceRefCounts.get(key) ?? 0) - 1
  if (nextCount > 0) {
    sprintEngineMcpWorkspaceRefCounts.set(key, nextCount)
    return false
  }
  sprintEngineMcpWorkspaceRefCounts.delete(key)
  return true
}

function releaseSprintEngineMcpRunRef(runId: string, context?: {
  workspaceRoot?: string
  clients?: AgentCli[]
  cleanupMcpConfig?: boolean
}): void {
  const nextCount = (sprintEngineMcpRunRefCounts.get(runId) ?? 0) - 1
  const cleanupMcpConfig = releaseSprintEngineMcpWorkspaceRef(context?.workspaceRoot)
  if (nextCount > 0) {
    sprintEngineMcpRunRefCounts.set(runId, nextCount)
    return
  }
  sprintEngineMcpRunRefCounts.delete(runId)
  queueSprintEngineMcpRunRelease(runId, { ...context, cleanupMcpConfig })
}

function releaseUnusedSprintEngineMcpRun(runId: string | undefined, context?: {
  workspaceRoot?: string
  clients?: AgentCli[]
  cleanupMcpConfig?: boolean
}): void {
  if (!runId || (sprintEngineMcpRunRefCounts.get(runId) ?? 0) > 0) return
  const workspaceRoot = context?.workspaceRoot?.trim()
  const cleanupMcpConfig = workspaceRoot ? (sprintEngineMcpWorkspaceRefCounts.get(workspaceRoot) ?? 0) === 0 : false
  queueSprintEngineMcpRunRelease(runId, { ...context, cleanupMcpConfig })
}

function queueSprintEngineMcpRunRelease(runId: string, context?: {
  workspaceRoot?: string
  clients?: AgentCli[]
  cleanupMcpConfig?: boolean
}): void {
  const workspaceRoot = context?.workspaceRoot?.trim()
  const cleanupMcpConfig = Boolean(workspaceRoot && context?.cleanupMcpConfig === true)
  const clients = cleanupMcpConfig
    ? ['codex', 'claude-code'] as AgentCli[]
    : context?.clients?.length ? context.clients : ['codex', 'claude-code'] as AgentCli[]
  const release = Promise.resolve(releaseManagedSprintEngineRun?.({
    runId,
    workspaceRoot: workspaceRoot ?? '',
    clients,
    cleanupMcpConfig,
  })).catch(() => {})
  pendingSprintEngineMcpRunReleases.add(release)
  release.finally(() => {
    pendingSprintEngineMcpRunReleases.delete(release)
  })
}

function sprintEngineLifecycleCallInput(
  session: TerminalSession,
  toolName: string,
  reason?: string
): { runId: string; toolName: string; arguments: Record<string, unknown> } | null {
  if (!session.sprintEngineMcpRunId || !session.sprintEngineStatePath || !session.agentId) return null
  return {
    runId: session.sprintEngineMcpRunId,
    toolName,
    arguments: {
      agentId: session.agentId,
      ...(session.sprintEngineRole ? { role: session.sprintEngineRole } : {}),
      ...(reason ? { reason } : {}),
    },
  }
}

function queueSprintEngineLifecycleCall(
  session: TerminalSession,
  toolName: string,
  reason?: string
): Promise<void> | null {
  const input = sprintEngineLifecycleCallInput(session, toolName, reason)
  if (!input || !callManagedSprintEngineTool) return null
  const call = Promise.resolve(callManagedSprintEngineTool(input))
    .then(() => undefined)
    .catch((error) => {
      logMainPerfEvent('TerminalRuntime', 'sprintengine-lifecycle-call-failed', {
        sessionId: session.sessionId,
        agentId: session.agentId,
        toolName,
        message: getErrorMessage(error),
      })
    })
  pendingSprintEngineLifecycleCalls.add(call)
  void call.finally(() => {
    pendingSprintEngineLifecycleCalls.delete(call)
  })
  return call
}

function startSprintEngineAgentHeartbeat(session: TerminalSession): void {
  if (sprintEngineAgentHeartbeatTimers.has(session.sessionId)) return
  if (!sprintEngineLifecycleCallInput(session, 'sprintengine.agent.heartbeat')) return
  const timer = setInterval(() => {
    if (!isTerminalProcessAlive(session)) {
      stopSprintEngineAgentHeartbeat(session.sessionId)
      return
    }
    void queueSprintEngineLifecycleCall(session, 'sprintengine.agent.heartbeat')
  }, SPRINTENGINE_AGENT_HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  sprintEngineAgentHeartbeatTimers.set(session.sessionId, timer)
}

function stopSprintEngineAgentHeartbeat(sessionId: string): void {
  const timer = sprintEngineAgentHeartbeatTimers.get(sessionId)
  if (!timer) return
  clearInterval(timer)
  sprintEngineAgentHeartbeatTimers.delete(sessionId)
}

export async function sendSprintEngineAgentHeartbeats(): Promise<string[]> {
  const sent: string[] = []
  for (const session of terminals.values()) {
    if (!isTerminalProcessAlive(session)) continue
    if (!sprintEngineLifecycleCallInput(session, 'sprintengine.agent.heartbeat')) continue
    await queueSprintEngineLifecycleCall(session, 'sprintengine.agent.heartbeat')
    if (session.agentId) sent.push(session.agentId)
  }
  return sent
}

function recordSprintEngineAgentLeave(session: TerminalSession, reason: string): Promise<void> | null {
  stopSprintEngineAgentHeartbeat(session.sessionId)
  return queueSprintEngineLifecycleCall(session, 'sprintengine.agent.leave', reason)
}

function queueSprintEngineTerminalTeardown(session: TerminalSession, reason: string): Promise<void> {
  const existing = pendingSprintEngineTerminalTeardowns.get(session.sessionId)
  if (existing?.session === session) return existing.promise
  const leave = recordSprintEngineAgentLeave(session, reason)
  if (!leave) {
    releaseSprintEngineMcpRun(session)
    return Promise.resolve()
  }
  const teardown = leave.finally(() => {
    releaseSprintEngineMcpRun(session)
  })
  pendingSprintEngineTerminalTeardowns.set(session.sessionId, { session, promise: teardown })
  void teardown.finally(() => {
    if (pendingSprintEngineTerminalTeardowns.get(session.sessionId)?.promise === teardown) {
      pendingSprintEngineTerminalTeardowns.delete(session.sessionId)
    }
  })
  return teardown
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
  startSprintEngineAgentHeartbeat(terminalSession)
  scheduleTerminalIdleTransition(terminalSession)
  broadcastTerminalSessionsChanged()

  terminalSession.process.onData((data) => {
    if (!terminalSession.isReady) {
      terminalSession.isReady = true
      flushPendingTerminalResize(sessionId, terminalSession)
    }
    appendTerminalOutput(terminalSession, data)
    if (terminalSession.activity.kind !== 'working') {
      setTerminalActivity(
        terminalSession,
        { kind: 'working', since: terminalSession.lastOutputAt ?? Date.now() }
      )
    }
    scheduleTerminalIdleTransition(terminalSession)
    terminalOutput.send(terminalSession, data)
  })

  terminalSession.process.onExit((event) => {
    void queueSprintEngineTerminalTeardown(terminalSession, `terminal exited with code ${event.exitCode}`)
    cleanupTerminalStartupScript(terminalSession.startupScriptPath)
    terminalOutput.flush(sessionId, 'exit')
    terminalDiagnostics.clear(sessionId)
    setTerminalActivity(terminalSession, { kind: 'exited', at: Date.now(), exitCode: event.exitCode })
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
    recordTerminalInput(terminalSession)
    terminalSession.process.write(initialInput)
  }
}

async function spawnAgentSessionFromDescriptor(input: {
  workspaceId?: string
  workspaceRoot: string
  descriptor: SwitchboardAgentSpawnDescriptor
  mcpSettings?: McpSettings
}): Promise<TerminalSpawnResult> {
  const sender = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())?.webContents
  if (!sender) {
    retainFailedTerminalSession({
      sessionId: input.descriptor.executionId,
      message: 'No desktop window is available to host the agent terminal.',
      kind: 'agent',
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
    })
    return {
      ok: false,
      sessionId: input.descriptor.executionId,
      message: 'No desktop window is available to host the agent terminal.',
      exitCode: 1,
    }
  }

  const [command, ...args] = input.descriptor.command
  if (!command) {
    retainFailedTerminalSession({
      sessionId: input.descriptor.executionId,
      sender,
      message: 'Agent descriptor did not include a command.',
      kind: 'agent',
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
    })
    return {
      ok: false,
      sessionId: input.descriptor.executionId,
      message: 'Agent descriptor did not include a command.',
      exitCode: 1,
    }
  }

  disposeTerminal(input.descriptor.executionId)

  try {
    if (input.mcpSettings?.syncEnabled && syncMcpConfig && input.descriptor.cli) {
      const syncResult = await syncMcpConfig({
        workspaceRoot: input.descriptor.cwd || input.workspaceRoot,
        settings: input.mcpSettings,
        clients: [input.descriptor.cli],
      })
      if (!syncResult.ok) {
        retainFailedTerminalSession({
          sessionId: input.descriptor.executionId,
          sender,
          message: syncResult.message,
          kind: 'agent',
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
        })
        return {
          ok: false,
          sessionId: input.descriptor.executionId,
          message: syncResult.message,
          exitCode: 1,
        }
      }
    }

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
    const startedAt = Date.now()
    const terminalSession: TerminalSession = {
      sessionId: input.descriptor.executionId,
      process: termProcess,
      sender,
      isReady: process.platform !== 'win32',
      hasExited: false,
      exitedAt: null,
      isDisposed: false,
      activity: createInitialTerminalActivity(startedAt),
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
      startedAt,
      lastOutputAt: startedAt,
      lastInputAt: null,
      lastVisibleAt: null,
    }

    const injectionMode = input.descriptor.injection?.mode ?? 'stdin-pipe'
    let initialInput: string | undefined
    if (injectionMode === 'stdin-pipe') {
      initialInput = descriptorPromptInput(input.descriptor.prompt)
    } else if (injectionMode === 'positional-arg') {
      // The prompt is already part of the spawned argv; nothing to inject.
      initialInput = undefined
    } else {
      // send-after-ready: we attach first, then inject once the readiness
      // pattern fires (see installAgentLifecycleWatcher below).
      initialInput = undefined
    }

    attachTerminalSession(input.descriptor.executionId, terminalSession, initialInput)
    installAgentLifecycleWatcher(terminalSession, input.descriptor, injectionMode)
    return { ok: true, sessionId: input.descriptor.executionId }
  } catch (error) {
    const message = getTerminalErrorMessage(error)
    retainFailedTerminalSession({
      sessionId: input.descriptor.executionId,
      sender,
      message,
      kind: 'agent',
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
    })
    return {
      ok: false,
      sessionId: input.descriptor.executionId,
      message,
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
      if (!session || !isTerminalProcessAlive(session)) {
        throw new Error('Desktop terminal session is no longer running.')
      }
      try {
        recordTerminalInput(session)
        session.process.write(data)
      } catch (error) {
        setTerminalActivity(session, {
          kind: 'failed',
          at: Date.now(),
          exitCode: session.exitCode ?? 1,
          message: getErrorMessage(error),
        })
        throw error
      }
    },
  })
}

async function spawnMobileAgentTerminal(input: {
  sessionId: string
  cwd: string
  sprintEngineStatePath: string
  agentId: string
  role: string
  initialPrompt: string
  cli: AgentCli
  executionMode: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
}): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const sender = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())?.webContents
  if (!sender) {
    retainFailedTerminalSession({
      sessionId: input.sessionId,
      message: 'No desktop window is available to host a mobile-started agent terminal.',
      kind: 'agent',
      agentId: input.agentId,
      cli: input.cli,
      cwd: input.cwd,
      sprintEngineStatePath: input.sprintEngineStatePath,
      executionMode: input.executionMode,
      worktreeId: input.worktreeId,
      worktreePath: input.worktreePath,
    })
    return { ok: false, message: 'No desktop window is available to host a mobile-started agent terminal.' }
  }

  try {
    requireAuthenticatedUser('Sign in to launch Sprint Engine specialist workflows from the app.')
  } catch (error) {
    const message = getErrorMessage(error)
    retainFailedTerminalSession({
      sessionId: input.sessionId,
      sender,
      message,
      kind: 'agent',
      agentId: input.agentId,
      cli: input.cli,
      cwd: input.cwd,
      sprintEngineStatePath: input.sprintEngineStatePath,
      executionMode: input.executionMode,
      worktreeId: input.worktreeId,
      worktreePath: input.worktreePath,
    })
    return { ok: false, message }
  }

  disposeTerminal(input.sessionId)

  let sprintEngineMcpRunId: string | undefined
  let sprintEngineMcpEnv: Record<string, string> | undefined
  let sprintEngineMcpRunRetained = false
  try {
    if (!syncMcpConfig) {
      const message = 'Managed Sprint Engine MCP config sync is unavailable; cannot launch a Sprint Engine agent.'
      retainFailedTerminalSession({
        sessionId: input.sessionId,
        sender,
        message,
        kind: 'agent',
        agentId: input.agentId,
        cli: input.cli,
        cwd: input.cwd,
        sprintEngineStatePath: input.sprintEngineStatePath,
        executionMode: input.executionMode,
        worktreeId: input.worktreeId,
        worktreePath: input.worktreePath,
      })
      return { ok: false, message }
    }

    const syncResult = await syncMcpConfig({
      workspaceRoot: input.cwd,
      settings: { syncEnabled: false, servers: {} },
      clients: [input.cli],
      managedSprintEngine: buildManagedSprintEngineSyncInputForLaunch(input.sprintEngineStatePath, input.cwd, {
        agentId: input.agentId,
        role: input.role,
        cli: input.cli,
      }),
    })
    if (!syncResult.ok) {
      retainFailedTerminalSession({
        sessionId: input.sessionId,
        sender,
        message: syncResult.message,
        kind: 'agent',
        agentId: input.agentId,
        cli: input.cli,
        cwd: input.cwd,
        sprintEngineStatePath: input.sprintEngineStatePath,
        executionMode: input.executionMode,
        worktreeId: input.worktreeId,
        worktreePath: input.worktreePath,
      })
      return { ok: false, message: syncResult.message }
    }
    sprintEngineMcpRunId = syncResult.managedSprintEngineRunId
    sprintEngineMcpEnv = syncResult.runTokenEnv
    retainSprintEngineMcpRunRef(sprintEngineMcpRunId, input.cwd)
    sprintEngineMcpRunRetained = Boolean(sprintEngineMcpRunId)

    const { command, args, cwd: launchCwd, pathStyle, initialInput, env, startupScriptPath } = getShellLaunchConfig(
      input.cwd,
      input.sessionId,
      false,
      input.sprintEngineStatePath,
      input.cli,
      input.initialPrompt,
      undefined,
      'auto_workspace',
      undefined,
      undefined,
      undefined,
      sprintEngineMcpEnv
    )
    const initialSize = getTerminalSize(120, 30)
    const termProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: launchCwd ?? input.cwd,
      env: env ?? getTerminalEnv(),
    })
    const startedAt = Date.now()
    const terminalSession: TerminalSession = {
      sessionId: input.sessionId,
      process: termProcess,
      sender,
      isReady: process.platform !== 'win32',
      hasExited: false,
      exitedAt: null,
      isDisposed: false,
      activity: createInitialTerminalActivity(startedAt),
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
      sprintEngineMcpRunId,
      sprintEngineRole: input.role,
      executionMode: input.executionMode,
      worktreeId: input.worktreeId,
      worktreePath: input.worktreePath,
      visible: false,
      startedAt,
      lastOutputAt: startedAt,
      lastInputAt: null,
      lastVisibleAt: null,
      startupScriptPath,
    }

    attachTerminalSession(input.sessionId, terminalSession, initialInput)

    return { ok: true, sessionId: input.sessionId }
  } catch (error) {
    const releaseContext = {
      workspaceRoot: input.cwd,
      clients: [input.cli],
    }
    if (sprintEngineMcpRunRetained && sprintEngineMcpRunId) {
      releaseSprintEngineMcpRunRef(sprintEngineMcpRunId, releaseContext)
    } else {
      releaseUnusedSprintEngineMcpRun(sprintEngineMcpRunId, releaseContext)
    }
    const message = getTerminalErrorMessage(error)
    retainFailedTerminalSession({
      sessionId: input.sessionId,
      sender,
      message,
      kind: 'agent',
      agentId: input.agentId,
      cli: input.cli,
      cwd: input.cwd,
      sprintEngineStatePath: input.sprintEngineStatePath,
      executionMode: input.executionMode,
      worktreeId: input.worktreeId,
      worktreePath: input.worktreePath,
    })
    return { ok: false, message }
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
    cliModel,
    memoryRootPath,
    memoryRelativeRoot,
    agentSession,
    visible = true,
    mcpSettings,
  }: TerminalSpawnPayload
): Promise<TerminalSpawnResult> {
    const existingSession = terminals.get(sessionId)
    if (existingSession && !existingSession.isDisposed) {
      logMainPerfEvent('TerminalRuntime', 'terminal-reattach-existing-session', {
        sessionId,
        workspaceId: workspaceId ?? existingSession.workspaceId,
        agentId: agentId ?? existingSession.agentId,
        terminalId: terminalId ?? existingSession.terminalId,
        kind: kind ?? existingSession.kind,
        processAlive: isTerminalProcessAlive(existingSession),
        resumeRequested: resume,
        visible,
      })
      existingSession.sender = sender
      existingSession.workspaceId = workspaceId ?? existingSession.workspaceId
      existingSession.agentId = agentId ?? existingSession.agentId
      existingSession.terminalId = terminalId ?? existingSession.terminalId
      existingSession.kind = kind ?? existingSession.kind
      existingSession.executionMode = executionMode ?? existingSession.executionMode
      existingSession.worktreeId = worktreeId ?? existingSession.worktreeId
      existingSession.worktreePath = worktreePath ?? existingSession.worktreePath
      existingSession.agentSession = materializeAgentSessionIdentity(sessionId, workspaceId, agentSession) ?? existingSession.agentSession
      recordTerminalVisibility(existingSession, visible)
      if (!existingSession.hasExited) {
        safeResizeTerminal(sessionId, cols, rows)
      }
      const replay = materializeTerminalReplay(existingSession)
      if (replay) {
        sendTerminalEvent(sender, `terminal:replay:${sessionId}`, replay)
      }
      if (existingSession.hasExited) {
        sendTerminalEvent(sender, `terminal:exit:${sessionId}`, existingSession.exitCode ?? 0)
      }
      broadcastTerminalSessionsChanged()
      return { ok: true, sessionId } satisfies TerminalSpawnResult
    }

    disposeTerminal(sessionId)
    logMainPerfEvent('TerminalRuntime', 'terminal-spawn-fresh', {
      sessionId,
      workspaceId,
      agentId,
      terminalId,
      kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
      resumeRequested: resume,
      visible,
    })

    let sprintEngineMcpRunId: string | undefined
    let sprintEngineMcpEnv: Record<string, string> | undefined
    let sprintEngineMcpRunRetained = false
    const workingDirectory = cwd || process.cwd()
    try {
      if (sprintEngineStatePath && (kind ?? (shellOnly ? 'terminal' : 'agent')) === 'agent') {
        try {
          requireAuthenticatedUser('Sign in to launch Sprint Engine specialist workflows from the app.')
        } catch (error) {
          const message = getErrorMessage(error)
          retainFailedTerminalSession({
            sessionId,
            sender,
            message,
            kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
            workspaceId,
            agentId,
            terminalId,
            cli: shellOnly ? undefined : cli,
            cwd: workingDirectory,
            sprintEngineStatePath,
            executionMode,
            worktreeId,
            worktreePath,
            agentSession: materializeAgentSessionIdentity(sessionId, workspaceId, agentSession),
            visible,
          })
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

      if (!shellOnly && sprintEngineStatePath && !syncMcpConfig) {
        const message = 'Managed Sprint Engine MCP config sync is unavailable; cannot launch a Sprint Engine agent.'
        retainFailedTerminalSession({
          sessionId,
          sender,
          message,
          kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
          workspaceId,
          agentId,
          terminalId,
          cli: shellOnly ? undefined : cli,
          cwd: workingDirectory,
          sprintEngineStatePath,
          executionMode,
          worktreeId,
          worktreePath,
          agentSession: materializeAgentSessionIdentity(sessionId, workspaceId, agentSession),
          visible,
        })
        sendTerminalEvent(sender, `terminal:error:${sessionId}`, message)
        sendTerminalEvent(sender, `terminal:exit:${sessionId}`, 1)
        return {
          ok: false,
          sessionId,
          message,
          exitCode: 1,
        } satisfies TerminalSpawnResult
      }

      if (!shellOnly && syncMcpConfig && (mcpSettings?.syncEnabled || sprintEngineStatePath)) {
        const syncResult = await syncMcpConfig({
          workspaceRoot: workingDirectory,
          settings: mcpSettings ?? { syncEnabled: false, servers: {} },
          clients: [cli],
          managedSprintEngine: sprintEngineStatePath
            ? buildManagedSprintEngineSyncInputForLaunch(sprintEngineStatePath, workingDirectory, {
                workspaceId,
                agentId: agentId || sessionId,
                role: sprintEngineRoleForLaunch(agentSession?.role, agentId),
                cli,
              })
            : undefined,
        })
        if (!syncResult.ok) {
          retainFailedTerminalSession({
            sessionId,
            sender,
            message: syncResult.message,
            kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
            workspaceId,
            agentId,
            terminalId,
            cli: shellOnly ? undefined : cli,
            cwd: workingDirectory,
            sprintEngineStatePath,
            executionMode,
            worktreeId,
            worktreePath,
            agentSession: materializeAgentSessionIdentity(sessionId, workspaceId, agentSession),
            visible,
          })
          sendTerminalEvent(sender, `terminal:error:${sessionId}`, syncResult.message)
          sendTerminalEvent(sender, `terminal:exit:${sessionId}`, 1)
          return {
            ok: false,
            sessionId,
            message: syncResult.message,
            exitCode: 1,
          } satisfies TerminalSpawnResult
        }
        sprintEngineMcpRunId = syncResult.managedSprintEngineRunId
        sprintEngineMcpEnv = syncResult.runTokenEnv
        retainSprintEngineMcpRunRef(sprintEngineMcpRunId, workingDirectory)
        sprintEngineMcpRunRetained = Boolean(sprintEngineMcpRunId)
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
          cliModel,
          memoryRootPath,
          memoryRelativeRoot,
          sprintEngineMcpEnv
        )
      const initialSize = getTerminalSize(cols, rows)
      const termProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: initialSize.cols,
        rows: initialSize.rows,
        cwd: launchCwd ?? workingDirectory,
        env: env ?? getTerminalEnv(),
      })
      const startedAt = Date.now()
      const terminalSession: TerminalSession = {
        sessionId,
        process: termProcess,
        sender,
        isReady: process.platform !== 'win32',
        hasExited: false,
        exitedAt: null,
        isDisposed: false,
        activity: createInitialTerminalActivity(startedAt),
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
        sprintEngineMcpRunId,
        sprintEngineRole: sprintEngineRoleForLaunch(agentSession?.role, agentId),
        executionMode,
        worktreeId,
        worktreePath,
        agentSession: materializeAgentSessionIdentity(sessionId, workspaceId, agentSession),
        visible,
        startedAt,
        lastOutputAt: startedAt,
        lastInputAt: null,
        lastVisibleAt: visible ? startedAt : null,
        startupScriptPath,
      }

      attachTerminalSession(sessionId, terminalSession, initialInput)

      return { ok: true, sessionId } satisfies TerminalSpawnResult
    } catch (error) {
      const releaseContext = {
        workspaceRoot: workingDirectory,
        clients: cli ? [cli] : [],
      }
      if (sprintEngineMcpRunRetained && sprintEngineMcpRunId) {
        releaseSprintEngineMcpRunRef(sprintEngineMcpRunId, releaseContext)
      } else {
        releaseUnusedSprintEngineMcpRun(sprintEngineMcpRunId, releaseContext)
      }
      const message = getTerminalErrorMessage(error)
      retainFailedTerminalSession({
        sessionId,
        sender,
        message,
        kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
        workspaceId,
        agentId,
        terminalId,
        cli: shellOnly ? undefined : cli,
        cwd: cwd || process.cwd(),
        sprintEngineStatePath,
        executionMode,
        worktreeId,
        worktreePath,
        agentSession: materializeAgentSessionIdentity(sessionId, workspaceId, agentSession),
        visible,
      })
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
  if (!session || !isTerminalProcessAlive(session)) return

  try {
    recordTerminalInput(session, startedAt)
    session.process.write(data)
    terminalDiagnostics.recordInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, true)
  } catch (error) {
    setTerminalActivity(session, {
      kind: 'failed',
      at: Date.now(),
      exitCode: session.exitCode ?? 1,
      message: getErrorMessage(error),
    })
    terminalDiagnostics.recordInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, false)
  }
}
