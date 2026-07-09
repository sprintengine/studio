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
import type {
  AgentSessionExitListener,
  AgentSpawnDescriptor,
  LiveAgentExecution,
} from '../shared/agent-runtime'
import { createAgentStreamWatcher } from './agent-stream-watcher'
import { deriveActivityFromPhase, evaluateAgentStall, isAtRestAgentPhase, isAuthoritativeWorkingPhase, selectAgentStateTarget, type AgentStateFrame } from './agent-state'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'
import {
  cleanupTerminalStartupScript,
  applyAgentIdentityEnv,
  getPlainShellLaunchConfig,
  getShellLaunchConfig,
  getTerminalEnv,
} from './terminal-launch'
import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { getSharedCredentialStore } from './secret-store'
import { getErrorMessage } from './error-message'
import { getTerminalErrorMessage } from './terminal-error'
import { MobileSprintEngineCommandService } from './mobile/sprintengine/command'
import { getPluginById, getPluginRegistryUserRoot, getPluginSprintEngineRegistryRoots } from './plugin-registry-instance'
import { cliCredentialLaunchBlock, pluginIdForCli } from './agent-launch-render'
import { defaultUserRoleRegistryRoot } from './sprintengine-role-registry'
import {
  appendTerminalOutput,
  clearAgentStallTimer,
  clearTerminalIdleTimer,
  createFailedTerminalSession,
  createInitialTerminalActivity,
  createSuspendedPlaceholderSession,
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
import { buildReplaySnapshot } from './terminal-replay-snapshot'
import {
  recordSprintSessionForTokenLedger,
  sampleSprintSessionTokenUsage,
} from './sprintengine-token-sampling'
import { probeSubtreesForLiveWork, type SubtreeProbeDeps } from './terminal-subtree-probe'
import type { TerminalSnapshotSidecarStore } from './terminal-snapshot-sidecar'
import { createTerminalDiagnostics } from './terminal-diagnostics'
import { createTerminalOutputBuffer } from './terminal-output-buffer'
import { createTerminalMobileCommandService } from './terminal-mobile-command-service'
import {
  explainSessionReapDecision,
  selectReapableSessions,
  clampSuspendIdleAfterMs,
  clampKeepRecentTerminalsAlive,
  DEFAULT_SUSPEND_IDLE_AFTER_MS,
  DEFAULT_KEEP_RECENT_TERMINALS_ALIVE,
  type ReapCandidate,
} from './terminal-reap-policy'
import { recordReapEvent } from './terminal-reap-log'
import type { TerminalRootInfo } from './workspace-memory'

type TerminalRuntimeOptions = {
  diagnosticsEnabled: boolean
  requireAuthenticatedUser(message: string): void
  logMainPerfEvent(scope: string, event: string, payload: Record<string, unknown>): void
  syncMcpConfig?(input: {
    workspaceRoot: string
    settings: McpSettings
    clients: AgentCli[]
    pruneUnlistedServers?: boolean
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
  // Ensures a built-in skill is installed into the workspace before an agent
  // launches. Debug Mode uses this to guarantee the `debug` skill is present in
  // the session CLI's native skill dir so the injected invocation resolves to a
  // real skill. Best-effort: the caller swallows failures and falls back to the
  // always-present inline directive.
  ensureBuiltinSkillInstalled?(workspaceRoot: string, skillId: string): Promise<void>
  // Keeps the generated managed MCP config (`.mcp.json` / `.codex/config.toml`)
  // out of a connector chat's worktree git by appending them to the worktree's
  // info/exclude. Invoked at a connector spawn (connectorLaunch set) after the
  // per-spawn MCP sync writes those files. Best-effort: the caller swallows
  // failures so an exclude write never blocks a launch. Absent in tests (no-op).
  excludeWorktreeMcpConfig?(worktreePath: string): Promise<void>
  // Installs the authoritative-agent-state reporter hook into the workspace
  // before a supported agent (Claude Code / Codex) launches, so the agent's
  // lifecycle hooks report its true phase over the agent-state socket. The
  // installer dispatches on `cli`. Strictly best-effort: the implementation
  // swallows its own failures, so awaiting it never blocks or fails a launch.
  // Absent in tests / when the feature is unwired (no-op).
  prepareAgentStateHook?(workspaceRoot: string, cli: string): Promise<void>
  // Durable freeze-the-view: per-terminal snapshot sidecars on disk, so a
  // suspended terminal reopens painted-and-paused after an app restart. Absent
  // when unwired (tests): suspend/quit skip persistence and rehydration never
  // finds anything — in-process behavior is unchanged.
  snapshotSidecars?: TerminalSnapshotSidecarStore
  // Persists reaper decisions to the daily diagnostics JSONL: every reap
  // action, plus rate-limited "parked past threshold by gate X" skips. The
  // in-memory ring buffer (terminal-reap-log) dies with the process; the
  // 2026-07-07 parked-agents incident was only diagnosable via timer-alignment
  // forensics because no durable decision trail existed. Best-effort and
  // absent in tests (no-op).
  logDiagnostic?(input: {
    level: 'info' | 'warning'
    title: string
    message: string
    details?: string
    workspaceId?: string
    agentId?: string
    sessionId?: string
  }): void
}

type TerminalIpcHandlers = {
  spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  getTerminalStatus(
    sessionId: string,
    sender?: WebContents
  ): Promise<{ processAlive: boolean; suspended: boolean }>
  listTerminals(): TerminalSessionSnapshot[]
  setTerminalVisible(sessionId: string, visible: boolean, sender?: WebContents): void
  suspendTerminal(sessionId: string): void
  resumeTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  killTerminal(sessionId: string): void
  setIdleSuspendThresholdMs(value: unknown): void
  setKeepRecentTerminalsAlive(value: unknown): void
  setTerminalReapExempt(sessionId: string, exempt: boolean): void
  setActiveSprintRunStatePaths(value: unknown): void
}

type TerminalRuntime = {
  commandService: MobileSprintEngineCommandService
  ipcHandlers: TerminalIpcHandlers
  shutdown(): Promise<void>
  getLiveAgentExecutionIds(): LiveAgentExecution[]
  resolveAgentExecutionId(input: { workspaceId: string; agentId: string }): string | undefined
  registerAgentSessionExitListener(listener: AgentSessionExitListener): () => void
  killAgentSession(input: {
    workspaceRoot: string
    executionId: string
  }): void
  spawnAgentSession(input: {
    workspaceId?: string
    workspaceRoot: string
    descriptor: AgentSpawnDescriptor
    mcpSettings?: McpSettings
  }): Promise<TerminalSpawnResult>
  // Applies an authoritative agent-state frame (from the lifecycle-hook reporter
  // socket) to the matching live session. Validated upstream by the service.
  ingestAgentStateFrame(frame: AgentStateFrame): void
}

let requireAuthenticatedUser = (_message: string): void => {}
let terminalDiagnostics = createTerminalDiagnostics({
  enabled: false,
  logMainPerfEvent: () => {},
})
let logMainPerfEvent: TerminalRuntimeOptions['logMainPerfEvent'] = () => {}
const agentSessionExitListeners = new Set<AgentSessionExitListener>()
let syncMcpConfig: TerminalRuntimeOptions['syncMcpConfig']
let releaseManagedSprintEngineRun: TerminalRuntimeOptions['releaseManagedSprintEngineRun']
let callManagedSprintEngineTool: TerminalRuntimeOptions['callManagedSprintEngineTool']
let ensureBuiltinSkillInstalled: TerminalRuntimeOptions['ensureBuiltinSkillInstalled']
let excludeWorktreeMcpConfig: TerminalRuntimeOptions['excludeWorktreeMcpConfig']
let prepareAgentStateHook: TerminalRuntimeOptions['prepareAgentStateHook']
let snapshotSidecars: TerminalRuntimeOptions['snapshotSidecars']
let logReapDiagnostic: TerminalRuntimeOptions['logDiagnostic']

// CLIs the agent-state reporter can install into. Claude Code, Codex, and Grok
// Build share a stdin-filter reporter (the same hook payload contract —
// snake_case for Claude/Codex, camelCase for Grok, both read by one script;
// only the install target differs). OpenCode has no command hooks, so it gets
// an in-process plugin reporter instead — it still emits the same socket frame,
// so runtime ingestion is identical. All install differences are handled in the
// service; this gate and the service's installer dispatch MUST list the same
// CLIs or the install path is silently dead for the missing one.
function agentStateSupportsCli(cli: string | undefined): cli is string {
  if (cli === 'claude-code' || cli === 'codex' || cli === 'opencode' || cli === 'grok') return true
  if (!cli) return false
  // Any other CLI that runs on the Claude harness (e.g. zai: the same
  // `claude` binary against a redirected endpoint) uses the same
  // settings-hook reporter as claude-code, so install it for those too.
  return getPluginById(pluginIdForCli(cli))?.manifest.skillIntegration?.harnessId === 'claude'
}

// Reads a CLI's conversation-resume capabilities from the plugin registry (the
// authoritative manifest source; cli id == plugin id). The main process stamps
// these onto the agent-terminal sync payload so renderer stores never re-derive
// resume behavior from a hardcoded cli-id allowlist. Absent plugin → both false.
export function cliResumeCapabilities(
  cli: string | undefined
): { resumeSession: boolean; sessionIdFromCaller: boolean } {
  const caps = cli ? getPluginById(pluginIdForCli(cli))?.manifest.capabilities : undefined
  return {
    resumeSession: caps?.resumeSession ?? false,
    sessionIdFromCaller: caps?.sessionIdFromCaller ?? false,
  }
}

// True when the CLI resumes using the session id WE mint and pass at launch
// (`sessionIdFromCaller`) — so our terminal key equals its resume id (Claude).
// For these it is safe to resume against the terminal key when no harness id was
// captured. CLIs that mint their own id (Codex) must NOT fall back to our key —
// a bare `resume` (last session) is the correct default instead.
function cliResumesWithCallerSessionId(cli: string | undefined): boolean {
  return cliResumeCapabilities(cli).sessionIdFromCaller
}
const sprintEngineMcpRunRefCounts = new Map<string, number>()
const sprintEngineMcpWorkspaceRefCounts = new Map<string, number>()
const pendingSprintEngineMcpRunReleases = new Set<Promise<void>>()
const sprintEngineAgentHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
const pendingSprintEngineLifecycleCalls = new Set<Promise<void>>()
const pendingSprintEngineTerminalTeardowns = new Map<string, { session: TerminalSession; promise: Promise<void> }>()

export const SPRINTENGINE_AGENT_HEARTBEAT_INTERVAL_MS = 60 * 1000

function mcpSettingsForManagedSprintEngineLaunch(settings: McpSettings | undefined): McpSettings {
  const servers: McpSettings['servers'] = {}
  for (const [key, server] of Object.entries(settings?.servers ?? {})) {
    servers[key] = {
      ...server,
      enabled: false,
    }
  }
  return {
    syncEnabled: false,
    servers,
  }
}

/**
 * Run registration must authorize the run store, not just the terminal cwd:
 * worktree-mode agents launch in
 * `<root>/.multi-code/sprintengine/<run>/worktree` while `run.yaml` lives in
 * that directory's parent, so registering the launch cwd as the workspace
 * root rejects the statePath (HTTP 400 invalid_run_registration: statePath
 * is outside allowedRoots). Mirror the MCP server's own
 * `_default_workspace_root` derivation: the project root is the parent of
 * the `.multi-code` segment the state path lives under, falling back to the
 * launch cwd for non-standard layouts.
 */
export function deriveSprintEngineRegistrationRoot(statePath: string, launchCwd: string): string {
  let current = dirname(statePath)
  while (true) {
    if (basename(current) === '.multi-code') return dirname(current)
    const parent = dirname(current)
    if (parent === current) return launchCwd
    current = parent
  }
}

export function buildManagedSprintEngineSyncInputForLaunch(
  statePath: string,
  launchCwd: string,
  launch?: {
    workspaceId?: string
    agentId?: string
    role?: string
    cli?: AgentCli
  }
): NonNullable<Parameters<NonNullable<TerminalRuntimeOptions['syncMcpConfig']>>[0]['managedSprintEngine']> {
  const registrationRoot = deriveSprintEngineRegistrationRoot(statePath, launchCwd)
  return {
    statePath,
    workspaceRoot: registrationRoot,
    allowedRoots: [registrationRoot],
    registryRoots: sprintEngineRegistryRootsForLaunch(),
    userRoot: getPluginRegistryUserRoot(),
    actorId: 'multicode-app',
    workspaceId: launch?.workspaceId,
    agentId: launch?.agentId,
    role: launch?.role,
    cli: launch?.cli,
  }
}

export function sprintEngineRegistryRootsForLaunch(): string[] {
  try {
    const roots = getPluginSprintEngineRegistryRoots().map((root) => root.root)
    // Mirror sprintEngineRegistryRootsForRead (src/main/sprintengine-artifacts.ts):
    // user-authored roles live under defaultUserRoleRegistryRoot() with the same
    // { roles/, skills/ } shape, so adding the root lets managed agent.join resolve
    // them at spawn. Only when the directory exists, so absent-dir launches are
    // unaffected.
    const userRoot = defaultUserRoleRegistryRoot()
    if (existsSync(userRoot)) roots.push(userRoot)
    return roots
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
  agentSessionExitListeners.clear()
  syncMcpConfig = options.syncMcpConfig
  releaseManagedSprintEngineRun = options.releaseManagedSprintEngineRun
  callManagedSprintEngineTool = options.callManagedSprintEngineTool
  ensureBuiltinSkillInstalled = options.ensureBuiltinSkillInstalled
  excludeWorktreeMcpConfig = options.excludeWorktreeMcpConfig
  prepareAgentStateHook = options.prepareAgentStateHook
  snapshotSidecars = options.snapshotSidecars
  logReapDiagnostic = options.logDiagnostic
  reapSkipLogState.clear()
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
    resolveAgentExecutionId,
    registerAgentSessionExitListener,
    killAgentSession: killAgentSessionByExecutionId,
    spawnAgentSession: spawnAgentSessionFromDescriptor,
    ingestAgentStateFrame,
    ipcHandlers: {
      spawnTerminal: spawnTerminalFromIpc,
      writeTerminal: writeTerminalInput,
      resizeTerminal: safeResizeTerminal,
      async getTerminalStatus(sessionId, sender) {
        const session =
          terminals.get(sessionId)
          ?? (await rehydrateSuspendedTerminalFromSidecar(sessionId, sender))
        return {
          processAlive: Boolean(session && isTerminalProcessAlive(session)),
          suspended: Boolean(session?.suspended && !session.isDisposed),
        }
      },
      listTerminals() {
        return [...terminals.values()]
          .filter((session) => !session.isDisposed)
          .map(getTerminalSnapshot)
      },
      setTerminalVisible: setTerminalVisible,
      suspendTerminal: suspendTerminal,
      resumeTerminal: resumeTerminal,
      killTerminal: disposeTerminal,
      setIdleSuspendThresholdMs: setIdleSuspendThresholdMs,
      setKeepRecentTerminalsAlive: setKeepRecentTerminalsAlive,
      setTerminalReapExempt: setTerminalReapExempt,
      setActiveSprintRunStatePaths: setActiveSprintRunStatePaths,
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
  descriptor: AgentSpawnDescriptor,
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

function setTerminalVisible(sessionId: string, visible: boolean, sender?: WebContents): void {
  const session = terminals.get(sessionId)
  if (!session || session.isDisposed) return
  // A suspended session has no live pty routing output anywhere, and its
  // recorded sender can be a dead window (or the noop sender of a placeholder
  // rehydrated from a snapshot sidecar). Adopt the revealing window so the
  // replay below actually reaches the view being painted.
  if (sender && session.suspended && session.sender !== sender) {
    session.sender = sender
  }
  // While a terminal is hidden the agent keeps running and we keep appending to
  // the retained replay buffer, but we stop forwarding output to its (frozen)
  // renderer xterm (see terminal-output-buffer flush gate). On becoming visible
  // again the xterm is stale, so re-send the retained window and let the renderer
  // reset + replay to resync. This is the cold-layer reveal path; warm/active
  // layers never go hidden so they never pay this.
  const becameVisible = visible && session.visible === false
  // A suspended session's reveal must be IDEMPOTENT, not edge-triggered: a
  // renderer window reload or a TerminalView remount that never delivered its
  // unmount hide leaves `session.visible === true` in main, so the fresh xterm's
  // reveal misses the hidden→visible edge and — with a dead pty that will never
  // repaint — stays blank forever under the Paused footer. Resending the replay
  // to a suspended session is cheap (no live output to duplicate) and the
  // renderer replay gate resets before applying, so repeats are safe.
  const shouldReplay = becameVisible || (visible && session.suspended === true)
  if (becameVisible) {
    // Drop any batch buffered-but-not-forwarded while hidden: it is already in
    // the retained replay we are about to send, so forwarding it after the
    // replay would duplicate the tail.
    terminalOutput.flush(sessionId, 'visibility')
  }
  recordTerminalVisibility(session, visible)
  if (shouldReplay) {
    // A suspended session prefers its faithful screen snapshot (alt-screen TUIs
    // don't reconstruct from the raw stream); live sessions have none and fall
    // back to the retained scrollback.
    const replay = session.replaySnapshot ?? materializeTerminalReplay(session)
    if (replay) {
      sendTerminalEvent(session.sender, `terminal:replay:${sessionId}`, replay)
      logMainPerfEvent('TerminalRuntime', 'terminal-replay-sent', {
        sessionId,
        workspaceId: session.workspaceId,
        agentId: session.agentId,
        terminalId: session.terminalId,
        kind: session.kind,
        replayChars: replay.length,
        replayBytes: Buffer.byteLength(replay, 'utf8'),
        cause: 'revisible',
      })
    }
  }
  broadcastTerminalSessionsChanged()
}

// How long after a pty resize to treat incoming output as a repaint (alt-screen
// redraw) rather than agent activity. A few hundred ms covers the redraw burst;
// real agent output that follows lands outside the window and counts normally.
const REPAINT_GRACE_MS = 400

function safeResizeTerminal(sessionId: string, cols: number, rows: number): void {
  const session = terminals.get(sessionId)
  if (!session || !isTerminalProcessAlive(session)) return

  const size = getTerminalSize(cols, rows)
  if (process.platform === 'win32' && !session.isReady) {
    session.pendingResize = size
    return
  }

  // Dedupe: a reveal / tab-switch re-fits to the SAME dimensions. Resizing the
  // pty then makes the alt-screen TUI (Claude/Codex) repaint, and that repaint
  // flows through onData as spurious output — bumping lastOutputAt and flipping
  // activity to "working". Skip when the size is unchanged so liveness/recency
  // reflect real agent output, not repaints.
  if (session.appliedCols === size.cols && session.appliedRows === size.rows) return

  try {
    session.process.resize(size.cols, size.rows)
    session.appliedCols = size.cols
    session.appliedRows = size.rows
    // Output in the brief window after a resize is the TUI repainting, not the
    // agent working — buffer it but don't count it toward liveness/recency.
    session.repaintGraceUntil = Date.now() + REPAINT_GRACE_MS
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

// Freeze-the-view: kill the agent process to reclaim its RAM but KEEP the
// session (painted scrollback + --resume launch flags) so it can be resumed on
// the next keystroke. Unlike disposeTerminal this does not remove the session,
// does not fire `terminal:exit` (the view stays painted), and does not tear down
// the agent's SprintEngine run. The pty `onExit` handler finalizes the suspend
// (sets `suspended`, broadcasts) by branching on the `suspending` flag set here.
export function suspendTerminal(sessionId: string): void {
  const session = terminals.get(sessionId)
  if (!session || session.isDisposed || session.suspended || session.suspending) return
  if (!isTerminalProcessAlive(session)) return
  session.suspending = true
  // Capture any pending output before the process dies, but keep the buffer so
  // the scrollback can be replayed for the painted view.
  terminalOutput.flush(sessionId, 'dispose')
  clearTerminalIdleTimer(session)
  // A suspend kills the pty without going through the exited/failed activity
  // transition (the onExit branch returns early), so clear the stall timer here
  // too or it lingers armed against a dead process until it self-expires.
  clearAgentStallTimer(session)
  // Snapshot the painted screen for a faithful blank-free reopen. Read the size
  // and materialize the retained stream BEFORE the kill, then render+serialize
  // off-thread (best-effort): a failure just leaves the raw replay in place.
  const snapshotCols = session.process.cols
  const snapshotRows = session.process.rows
  const snapshotSource = materializeTerminalReplay(session)
  try {
    session.process.kill()
  } catch {
    // If the process already died, the onExit path has run; the guards above
    // keep this from double-finalizing.
  }
  void buildReplaySnapshot(snapshotSource, snapshotCols, snapshotRows).then((snapshot) => {
    // Only attach if this exact session is still the suspended one (not disposed,
    // resumed, or replaced) — otherwise a stale snapshot could shadow live output.
    // Accept `suspending` too: it is set synchronously before the kill, while
    // `suspended` only flips in the async pty `onExit` — and this render usually
    // resolves first, so gating on `suspended` alone would discard most snapshots.
    // A resume/dispose removes the session from the map (so `current === session`
    // fails) and sets `isDisposed`, keeping this safe against a stale shadow.
    const current = terminals.get(sessionId)
    if (current === session && (session.suspending || session.suspended) && !session.isDisposed) {
      if (snapshot) session.replaySnapshot = snapshot
      // Durable freeze-the-view: give the snapshot a disk lifecycle so this
      // terminal reopens painted-and-paused after an app restart too. A failed
      // render (timeout, serialize error) persists the raw stream instead so
      // the sidecar is never silently skipped; rehydration re-renders it.
      writeTerminalSnapshotSidecar(session, {
        snapshot: snapshot ?? undefined,
        rawReplay: snapshot ? undefined : snapshotSource,
        cols: snapshotCols,
        rows: snapshotRows,
      })
    }
  })
}

function writeTerminalSnapshotSidecar(
  session: TerminalSession,
  payload: { snapshot?: string; rawReplay?: string; cols: number; rows: number }
): void {
  if (!snapshotSidecars) return
  // Painted-pause is an agent-terminal promise (the paused footer, resume-on-
  // click); plain shells respawn fresh on reopen as they always have.
  if (session.kind !== 'agent') return
  if (!payload.snapshot && !payload.rawReplay) return
  // A dead/mock pty can report undefined dimensions; clamp so the sidecar
  // always validates on read (buildReplaySnapshot applies the same defaults).
  const size = getTerminalSize(payload.cols, payload.rows)
  snapshotSidecars.write({
    version: 1,
    sessionId: session.sessionId,
    savedAt: Date.now(),
    cols: size.cols,
    rows: size.rows,
    kind: session.kind,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    terminalId: session.terminalId,
    cli: session.cli,
    cliSessionId: session.cliSessionId,
    cwd: session.cwd,
    executionMode: session.executionMode,
    worktreeId: session.worktreeId,
    worktreePath: session.worktreePath,
    snapshot: payload.snapshot,
    rawReplay: payload.rawReplay,
  })
}

// Durable freeze-the-view, read side: no live session for this id, but a
// snapshot sidecar survives from a previous app run — materialize a suspended
// placeholder so the renderer's existing pause-instead-of-launch flow fires:
// status reports suspended, reveal replays the painted screen, and resume
// disposes the placeholder (deleting the sidecar) and re-spawns with --resume.
// Quit-path sidecars carry the raw stream; render it to a faithful snapshot
// here (alt-screen TUIs do not reconstruct from raw replay), falling back to
// seeding the raw buffer when the render fails.
async function rehydrateSuspendedTerminalFromSidecar(
  sessionId: string,
  sender?: WebContents
): Promise<TerminalSession | undefined> {
  if (!snapshotSidecars) return undefined
  const sidecar = snapshotSidecars.read(sessionId)
  if (!sidecar) return undefined
  let snapshot = sidecar.snapshot
  if (!snapshot && sidecar.rawReplay) {
    snapshot = (await buildReplaySnapshot(sidecar.rawReplay, sidecar.cols, sidecar.rows)) ?? undefined
  }
  // The render awaited above can race a concurrent spawn/rehydrate for the same
  // id; an existing live record wins.
  const existing = terminals.get(sessionId)
  if (existing && !existing.isDisposed) return existing
  const session = createSuspendedPlaceholderSession({
    sessionId,
    sender,
    savedAt: sidecar.savedAt,
    kind: sidecar.kind,
    workspaceId: sidecar.workspaceId,
    agentId: sidecar.agentId,
    terminalId: sidecar.terminalId,
    cli: sidecar.cli,
    cliSessionId: sidecar.cliSessionId,
    cwd: sidecar.cwd,
    executionMode: sidecar.executionMode,
    worktreeId: sidecar.worktreeId,
    worktreePath: sidecar.worktreePath,
    replaySnapshot: snapshot,
    rawReplay: snapshot ? undefined : sidecar.rawReplay,
  })
  terminals.set(sessionId, session)
  logMainPerfEvent('TerminalRuntime', 'terminal-suspended-rehydrated', {
    sessionId,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    terminalId: session.terminalId,
    cli: session.cli,
    kind: session.kind,
    savedAt: sidecar.savedAt,
    snapshotSource: sidecar.snapshot ? 'sidecar-snapshot' : snapshot ? 'rendered-raw' : 'raw-fallback',
  })
  broadcastTerminalSessionsChanged()
  return session
}

// Freeze-the-view: relaunch a suspended agent under the SAME session id with
// --resume, triggered by the renderer on the first keystroke. The suspended
// session's pty is already dead, so we dispose the stale record and re-spawn with
// `resume: true` — the existing launch path renders `--resume <sessionId>` for
// Claude and attaches a fresh pty. A non-suspended session falls through to the
// normal spawn/reattach path unchanged (no-op relaunch).
async function resumeTerminal(
  sender: WebContents,
  payload: TerminalSpawnPayload
): Promise<TerminalSpawnResult> {
  const existing = terminals.get(payload.sessionId)
  // Carry the agent's captured harness session id forward from the suspended
  // session before it is disposed, so an in-session resume still targets the
  // right conversation even if the renderer's payload lacks it (e.g. a resume
  // thunk closed over the agent before the lifecycle hook reported the id). An
  // explicit payload value still wins.
  const cliSessionId = payload.cliSessionId ?? existing?.cliSessionId
  if (existing && existing.suspended) {
    disposeTerminal(payload.sessionId)
  }
  return spawnTerminalFromIpc(sender, { ...payload, resume: true, cliSessionId })
}

function disposeTerminal(sessionId: string): void {
  const session = terminals.get(sessionId)
  if (!session) return

  // Dispose means gone — never rehydrated or repainted. Covers resume (the
  // sidecar is consumed), fresh spawn, agent deletion, and the reap sweeps.
  // App-quit teardown deliberately does NOT run through here (disposeAllTerminals
  // inlines its own loop), so quit never erases the sidecars it just wrote.
  snapshotSidecars?.remove(sessionId)
  // Token accounting: dispose is the single choke point every sprint terminal
  // passes through (single-owner teardown, run completion, reap, resume) — the
  // last chance to snapshot this session's cumulative usage into the run's
  // durable ledger. Fire-and-forget; a mid-session dispose (resume relaunch)
  // just writes an interim sample that a later one supersedes.
  void sampleSprintSessionTokenUsage(session, 'teardown')
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
  // A suspended session's pty has already exited (we killed it); its `onExit`
  // already fired, so waiting for another would block the full timeout on
  // shutdown. Treat it as already-exited.
  if (session.hasExited || session.isDisposed || session.suspended) return true
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

// Cadence of the idle-agent reap sweep. Kept well under the idle-suspend
// threshold (default 15m) so a freshly-dormant agent is suspended soon after it
// crosses the threshold rather than up to a sweep-interval later.
export const STALE_TERMINAL_SWEEP_INTERVAL_MS = 3 * 60 * 1000

// User-configurable idle-suspend threshold (ms), set from the renderer's
// "Pause idle terminals after" setting. Defaults to the policy default until the
// renderer syncs its persisted value on startup.
let configuredSuspendIdleAfterMs = DEFAULT_SUSPEND_IDLE_AFTER_MS

export function setIdleSuspendThresholdMs(value: unknown): void {
  configuredSuspendIdleAfterMs = clampSuspendIdleAfterMs(value)
}

export function getIdleSuspendThresholdMs(): number {
  return configuredSuspendIdleAfterMs
}

// User-configurable recency floor ("Always keep running"), set from the
// renderer's setting. The idle sweep never suspends/disposes below this many
// live agent terminals — the most recently used survive even once idle past
// the threshold. Defaults until the renderer syncs its persisted value.
let configuredKeepRecentAliveCount = DEFAULT_KEEP_RECENT_TERMINALS_ALIVE

export function setKeepRecentTerminalsAlive(value: unknown): void {
  configuredKeepRecentAliveCount = clampKeepRecentTerminalsAlive(value)
}

export function getKeepRecentTerminalsAlive(): number {
  return configuredKeepRecentAliveCount
}

// Per-terminal user lock: while set, both reap sweeps skip this session. The
// broadcast keeps every view's lock control in sync with the session snapshot.
export function setTerminalReapExempt(sessionId: string, exempt: boolean): void {
  const session = terminals.get(sessionId)
  if (!session || session.isDisposed) return
  const next = exempt === true
  if ((session.reapExempt === true) === next) return
  session.reapExempt = next
  logMainPerfEvent('TerminalRuntime', 'terminal-reap-exempt-changed', {
    sessionId,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    kind: session.kind,
    reapExempt: next,
  })
  broadcastTerminalSessionsChanged()
}

// SprintEngine run.yaml statePaths whose dispatch loop is currently ACTIVELY
// running (pushed from the renderer, which owns run-active state). The idle
// reaper protects sprint agents belonging to these — an active run's idle agents
// are owned by the claim-aware 5-min AutoRun retirement, and disposing them from
// here would race the dispatch (flapping / lost in-flight claims). A sprint agent
// whose run is NOT in this set (completed, stopped, or manual) is reclaimable —
// that is the parked-until-teardown gap this sweep exists to close. Empty until
// the renderer first syncs (so before sync, all sprint agents look inactive and
// only an authoritatively-idle one is reaped, which is the safe default).
let activeSprintRunStatePaths = new Set<string>()

export function setActiveSprintRunStatePaths(value: unknown): void {
  activeSprintRunStatePaths = new Set(
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  )
}

let staleTerminalSweepTimer: ReturnType<typeof setInterval> | undefined

function startStaleTerminalSweep(): void {
  if (staleTerminalSweepTimer) clearInterval(staleTerminalSweepTimer)
  staleTerminalSweepTimer = setInterval(() => {
    // 24h coarse backstop (catches anything ancient), then the recency policy
    // sweep that suspends idle agent terminals (hook-state-driven) within a
    // session. Guarded: sessions whose pty subtree holds live work (background
    // shells, dev servers, busy builds) or whose agent has a pending
    // self-scheduled wakeup are held — killing the CLI would abort that work.
    void runGuardedTerminalReapSweeps().catch(() => undefined)
    // Reclaim snapshot sidecars past their TTL (painted history nobody
    // reopened). Piggybacked here rather than owning another timer.
    snapshotSidecars?.sweepExpired()
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
// `guardHolds` (sessionId → hold reason, built by the guarded sweep) names
// sessions that must NOT be reaped this pass because killing the CLI would
// abort live work under it; absent (legacy/test callers) means unguarded.
export function reapStaleTerminals(
  now = Date.now(),
  guardHolds?: ReadonlyMap<string, string>,
  probedSessionIds?: ReadonlySet<string>
): string[] {
  const staleSessionIds = [...terminals.values()]
    .filter((session) => isTerminalSessionStale(session, now))
    // The user lock is absolute: a locked terminal survives even the coarse
    // 24h backstop — "do not reap" means dispose too, not just suspend.
    .filter((session) => session.reapExempt !== true)
    // Guarded sweep: only act on sessions that went through the live-work
    // probe. A session that became eligible during the probe await (e.g. its
    // lock was released) was never probed; defer it to the next sweep.
    .filter((session) => !probedSessionIds || probedSessionIds.has(session.sessionId))
    .filter((session) => !recordGuardHoldSkip(session.sessionId, guardHolds, now, 'stale backstop'))
    .map((session) => session.sessionId)

  for (const sessionId of staleSessionIds) {
    const session = terminals.get(sessionId)
    if (!session) continue
    const unseenMs = now - getTerminalLastSeenAt(session)
    logMainPerfEvent('TerminalRuntime', 'terminal-stale-reaped', {
      sessionId,
      kind: session.kind,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      terminalId: session.terminalId,
      cli: session.cli,
      processAlive: isTerminalProcessAlive(session),
      lastSeenAt: getTerminalLastSeenAt(session),
      unseenMs,
    })
    recordReapEvent({
      reapedAt: now,
      reason: 'stale-dispose',
      sessionId,
      workspaceId: session.workspaceId ?? null,
      agentId: session.agentId ?? null,
      terminalId: session.terminalId ?? null,
      cli: session.cli ?? null,
      kind: session.kind,
      unseenMs,
    })
    logReapDiagnostic?.({
      level: 'info',
      title: 'Terminal reaper',
      message: 'Stale backstop disposed a terminal',
      details: [
        `Unseen for ${Math.round(unseenMs / 3_600_000)}h`,
        `Kind: ${session.kind}; CLI: ${session.cli ?? 'unknown'}`,
      ].join('\n'),
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(session.agentId ? { agentId: session.agentId } : {}),
      sessionId,
    })
    disposeTerminal(sessionId)
  }
  return staleSessionIds
}

// In-session reaper: suspend idle agent terminals that have fallen out of the
// recency hot set — or that have sat idle past the absolute ceiling even while
// nominally "hot" (so a session left untouched for days after the user walks
// away is still reclaimed) — so a long session doesn't accumulate dozens of idle
// agents holding GBs. Driven ONLY by repaint-immune signals — real user input
// (lastInputAt), visibility, and run-state — so revealing a workspace (which
// makes its TUIs repaint) can't reset the idle clock or look like activity. The
// decision lives in the pure policy (terminal-reap-policy); this maps live
// sessions to candidates and SUSPENDS what it clears via `suspendTerminal`
// (freeze-the-view): the pty is killed to reclaim its RAM but the session and
// its painted scrollback are retained with `suspended = true`. Reopening the
// workspace then replays the frozen history and resumes the agent (`--resume`
// where the cli supports it) only on the first keystroke, pane click, or the paused footer —
// it never auto-respawns. Disposing instead (the old behavior) dropped the
// session and scrollback, so reopen fell through to the renderer's resume-spawn
// and the agent silently relaunched. The 24h `reapStaleTerminals` backstop still
// disposes, reclaiming the retained buffer once the history is no longer worth
// keeping.
// Rate limit for persisted "parked past threshold by gate X" skip entries: one
// per session per hour, re-logged sooner only when the holding gate CHANGES.
// Bounds volume (a working agent on a long autonomous run legitimately parks
// past the keystroke threshold for hours) while keeping the forensic trail the
// 2026-07-07 incident lacked. Entries for sessions that left the terminals map
// are pruned each sweep.
const REAP_SKIP_LOG_INTERVAL_MS = 60 * 60 * 1000
const reapSkipLogState = new Map<string, { hold: string; loggedAt: number }>()

// True when `guardHolds` names this session, meaning the caller must skip it
// this pass. Logs the skip (rate-limited like the gate audit above) so a
// session parked by live work leaves the forensic trail the 2026-07-07
// incident lacked.
function recordGuardHoldSkip(
  sessionId: string,
  guardHolds: ReadonlyMap<string, string> | undefined,
  now: number,
  sweep: string
): boolean {
  const hold = guardHolds?.get(sessionId)
  if (hold === undefined) return false
  const previous = reapSkipLogState.get(sessionId)
  if (!previous || previous.hold !== hold || now - previous.loggedAt >= REAP_SKIP_LOG_INTERVAL_MS) {
    reapSkipLogState.set(sessionId, { hold, loggedAt: now })
    const session = terminals.get(sessionId)
    logMainPerfEvent('TerminalRuntime', 'terminal-reap-held', {
      sessionId,
      hold,
      sweep,
      cli: session?.cli ?? null,
      workspaceId: session?.workspaceId ?? null,
    })
    logReapDiagnostic?.({
      level: 'info',
      title: 'Terminal reaper',
      message: `Reap held: ${hold}`,
      details: [
        `Sweep: ${sweep}`,
        `CLI: ${session?.cli ?? 'unknown'}`,
        'Killing the CLI would abort live work under it; re-evaluated next sweep.',
      ].join('\n'),
      ...(session?.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(session?.agentId ? { agentId: session.agentId } : {}),
      sessionId,
    })
  }
  return true
}

function terminalLastInteractionAt(session: TerminalSession): number {
  return Math.max(session.startedAt, session.lastInputAt ?? 0)
}

// Maps live sessions to pure reap-policy candidates. Shared by the sync sweep
// and the guarded wrapper (which needs the would-reap set BEFORE probing).
function buildReapCandidates(): ReapCandidate[] {
  return [...terminals.values()].map((session) => ({
    sessionId: session.sessionId,
    workspaceId: session.workspaceId ?? null,
    kind: session.kind,
    cli: session.cli ?? null,
    processAlive: isTerminalProcessAlive(session),
    // Authoritative hook/stall phase ONLY (never the snapshot's inferred
    // output-timing fallback): inferred 'working' flips on every alt-screen
    // repaint, so feeding it to the reaper would reintroduce the repaint
    // masquerade this policy is built to avoid. When no authoritative phase
    // exists (hookless CLI, or before the first frame), agentPhase stays null and
    // the keystroke-recency floor decides. At-rest phases — 'idle', and
    // 'stalled' after its own full rest threshold — are reapable;
    // working/awaiting_input are protected.
    agentPhase: session.agentState?.phase ?? null,
    lastInteractionAt: terminalLastInteractionAt(session),
    // When the agent went to rest — keeps a just-finished (or just-stalled)
    // agent alive until it has actually rested past the threshold.
    idleSince: isAtRestAgentPhase(session.agentState?.phase) ? (session.agentState?.since ?? null) : null,
    // A SprintEngine agent is protected from this sweep when EITHER its run's
    // dispatch loop is actively running (the claim-aware 5-min AutoRun retirement
    // owns those — disposing from here would race the dispatch: flapping, or
    // dropping an in-flight claim + `--resume` conversation) OR its rest is not
    // AUTHORITATIVELY known. `agentState.phase` comes from a lifecycle hook; a
    // hookless/BYO sprint CLI (or the pre-first-frame window) has `phase === null`,
    // which the policy's phase gate skips, falling to the keystroke floor — and a
    // sprint agent on a long autonomous turn has no keystrokes, so that floor would
    // dispose it mid-work. So we only reap a sprint agent that is BOTH in an
    // inactive run AND authoritatively at rest: 'idle', or 'stalled' — a worker
    // whose Stop frame was lost lands in 'stalled', and it must expire like idle
    // or it parks until app quit (the 2026-07-07 incident). Those we DISPOSE
    // (branch below) → `agent.leave` (→ `left`) → the dispatch revival path
    // respawns them when work returns. This closes the parked-until-teardown gap
    // for completed/stopped/manual runs without touching active ones. (Empty set
    // before the renderer first syncs ⇒ runs look inactive ⇒ only
    // authoritatively-at-rest agents reap, the safe default.)
    inActiveRun:
      Boolean(session.sprintEngineStatePath)
      && (activeSprintRunStatePaths.has(session.sprintEngineStatePath ?? '')
        || !isAtRestAgentPhase(session.agentState?.phase)),
    sprintManaged: Boolean(session.sprintEngineStatePath),
    reapExempt: session.reapExempt === true,
    // Hook-reported self-scheduled wakeup (see ingestAgentStateFrame): a future
    // wake time holds the session in the pure policy.
    pendingWakeupAt: session.pendingWakeupAt ?? null,
  }))
}

export function runIdleAgentReapSweep(
  now = Date.now(),
  guardHolds?: ReadonlyMap<string, string>,
  probedSessionIds?: ReadonlySet<string>
): string[] {
  const candidates = buildReapCandidates()
  const decision = selectReapableSessions(candidates, {
    now,
    idleThresholdMs: configuredSuspendIdleAfterMs,
    keepRecentAliveCount: configuredKeepRecentAliveCount,
  })

  // Skip audit: persist which gate is holding an agent that has otherwise
  // rested past the threshold ("would have been reaped but for X"). Routine
  // "not idle long enough yet" skips are noise and never logged. Rate-limited
  // per session (see REAP_SKIP_LOG_INTERVAL_MS); state pruned for sessions
  // that left the map so it cannot grow unbounded.
  for (const staleKey of reapSkipLogState.keys()) {
    if (!terminals.has(staleKey)) reapSkipLogState.delete(staleKey)
  }
  if (logReapDiagnostic) {
    for (const candidate of candidates) {
      if (candidate.kind !== 'agent') continue
      const explanation = explainSessionReapDecision(candidate, {
        now,
        idleThresholdMs: configuredSuspendIdleAfterMs,
      })
      if (explanation.verdict !== 'held') continue
      if (explanation.hold === 'resting_recently' || explanation.hold === 'dead_process') continue
      if (explanation.restingForMs <= configuredSuspendIdleAfterMs) continue
      const previous = reapSkipLogState.get(candidate.sessionId)
      if (previous && previous.hold === explanation.hold && now - previous.loggedAt < REAP_SKIP_LOG_INTERVAL_MS) {
        continue
      }
      reapSkipLogState.set(candidate.sessionId, { hold: explanation.hold, loggedAt: now })
      logReapDiagnostic({
        level: 'info',
        title: 'Terminal reaper',
        message: `Idle sweep kept a rested agent: ${explanation.hold}`,
        details: [
          `Resting for ${Math.round(explanation.restingForMs / 60_000)}m (threshold ${Math.round(configuredSuspendIdleAfterMs / 60_000)}m)`,
          `Phase: ${candidate.agentPhase ?? 'none (hookless)'}`,
          `CLI: ${candidate.cli ?? 'unknown'}`,
        ].join('\n'),
        ...(candidate.workspaceId ? { workspaceId: candidate.workspaceId } : {}),
        sessionId: candidate.sessionId,
      })
    }
  }

  // Recency-floor audit: these passed every per-session gate but sit inside the
  // "always keep running" count. Same rate limit as the gate audit above.
  if (logReapDiagnostic) {
    for (const sessionId of decision.heldByRecencyFloorSessionIds) {
      const session = terminals.get(sessionId)
      if (!session) continue
      const previous = reapSkipLogState.get(sessionId)
      if (previous && previous.hold === 'recency_floor' && now - previous.loggedAt < REAP_SKIP_LOG_INTERVAL_MS) {
        continue
      }
      reapSkipLogState.set(sessionId, { hold: 'recency_floor', loggedAt: now })
      logReapDiagnostic({
        level: 'info',
        title: 'Terminal reaper',
        message: 'Idle sweep kept a rested agent: recency_floor',
        details: [
          `Among the ${configuredKeepRecentAliveCount} most recently used live agents`,
          `CLI: ${session.cli ?? 'unknown'}`,
        ].join('\n'),
        ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
        sessionId,
      })
    }
  }

  // Guard holds (live subtree work / pending wakeup) trump the pure decision:
  // killing the CLI would abort real work, so the session waits for a sweep
  // where the work has finished. On the guarded path, additionally act ONLY on
  // sessions the probe actually covered: the decision is recomputed after the
  // probe await, and state changes during it (a keystroke, a phase frame, a
  // released lock) can promote a previously floor-held or ineligible session
  // into the reap slice — reaping it un-probed is exactly the live-work kill
  // the guard exists to prevent. Deferred sessions are re-selected and probed
  // on the next 3-minute sweep.
  const actionableSessionIds = decision.reapableSessionIds
    .filter((sessionId) => !probedSessionIds || probedSessionIds.has(sessionId))
    .filter((sessionId) => !recordGuardHoldSkip(sessionId, guardHolds, now, 'idle sweep'))

  for (const sessionId of actionableSessionIds) {
    const session = terminals.get(sessionId)
    if (!session || session.isDisposed) continue
    const idleMs = now - terminalLastInteractionAt(session)
    // SprintEngine agents are orchestrator-driven (no user keystroke to resume on),
    // so freeze-the-view suspend is the wrong reclaim action for them: it would
    // keep the dead session around without marking the agent `left`, breaking the
    // dispatch (a duplicate fresh terminal, no revival). Disposing instead fires
    // `agent.leave` (→ `left`), which the dispatch's revival path turns back into a
    // respawn when the role next has claimable work. Plain (non-sprint) agent
    // terminals keep the user-facing freeze-the-view suspend.
    const reclaimByDispose = Boolean(session.sprintEngineStatePath)
    logMainPerfEvent('TerminalRuntime', 'terminal-idle-reaped', {
      sessionId,
      kind: session.kind,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      cli: session.cli,
      lastInteractionAt: terminalLastInteractionAt(session),
      agentPhase: session.agentState?.phase ?? null,
      idleMs,
      action: reclaimByDispose ? 'dispose' : 'suspend',
    })
    recordReapEvent({
      reapedAt: now,
      reason: reclaimByDispose ? 'idle-dispose' : 'idle-suspend',
      sessionId,
      workspaceId: session.workspaceId ?? null,
      agentId: session.agentId ?? null,
      terminalId: session.terminalId ?? null,
      cli: session.cli ?? null,
      kind: session.kind,
      idleMs,
    })
    logReapDiagnostic?.({
      level: 'info',
      title: 'Terminal reaper',
      message: reclaimByDispose ? 'Idle sweep disposed a sprint agent' : 'Idle sweep suspended an agent',
      details: [
        `Idle for ${Math.round(idleMs / 60_000)}m (threshold ${Math.round(configuredSuspendIdleAfterMs / 60_000)}m)`,
        `Phase: ${session.agentState?.phase ?? 'none (hookless)'}`,
        `CLI: ${session.cli ?? 'unknown'}`,
      ].join('\n'),
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(session.agentId ? { agentId: session.agentId } : {}),
      sessionId,
    })
    if (reclaimByDispose) disposeTerminal(sessionId)
    else suspendTerminal(sessionId)
  }
  return actionableSessionIds
}

// One guarded pass of both reap sweeps — the production path (the 3-minute
// interval). The pure sweeps above stay synchronous and unguarded for direct
// callers/tests; here, every session a sweep WOULD act on is first probed for
// live work the phase gates cannot see: a `run_in_background` shell idling
// toward a result, a dev server holding a port, a busy build. The agent's hook
// phase is 'idle' while these run (its turn ended), but killing the CLI kills
// them and the resumed session reports "No completion record was found…".
// (Self-scheduled wakeups need no probe: they arrive as hook frames and hold
// inside the pure policy — see ReapCandidate.pendingWakeupAt.)
// Held sessions are skipped this pass and re-evaluated next sweep, so they
// reap normally once the work completes. Fail-safe: an undetermined subtree
// probe (ps/lsof failure) holds the session rather than risking live work.
export async function runGuardedTerminalReapSweeps(
  now = Date.now(),
  deps: { subtree?: SubtreeProbeDeps } = {}
): Promise<{ staleReaped: string[]; idleReaped: string[] }> {
  const staleTargets = [...terminals.values()]
    .filter((session) => isTerminalSessionStale(session, now) && session.reapExempt !== true)
    .map((session) => session.sessionId)
  const idleDecision = selectReapableSessions(buildReapCandidates(), {
    now,
    idleThresholdMs: configuredSuspendIdleAfterMs,
    keepRecentAliveCount: configuredKeepRecentAliveCount,
  })
  const targets = new Set([...staleTargets, ...idleDecision.reapableSessionIds])
  const guardHolds = await buildReapGuardHolds(targets, deps)
  // Pass the probed target set: the sweeps recompute their decisions after the
  // await above, and any session that entered the reap set during it must be
  // deferred to the next sweep (it was never probed for live subtree work).
  return {
    staleReaped: reapStaleTerminals(now, guardHolds, targets),
    idleReaped: runIdleAgentReapSweep(now, guardHolds, targets),
  }
}

// Probes the would-reap set and names every session that must be held. Only a
// LIVE pty can hold live work: suspended placeholders and exited sessions have
// nothing left to kill, and the stale backstop must stay free to reclaim their
// retained buffers.
async function buildReapGuardHolds(
  targetSessionIds: ReadonlySet<string>,
  deps: { subtree?: SubtreeProbeDeps }
): Promise<Map<string, string>> {
  const holds = new Map<string, string>()
  const subtreeTargets: { sessionId: string; pid: number }[] = []
  for (const sessionId of targetSessionIds) {
    const session = terminals.get(sessionId)
    if (!session || session.isDisposed || !isTerminalProcessAlive(session)) continue
    const pid = session.process.pid
    if (typeof pid === 'number' && pid > 0) subtreeTargets.push({ sessionId, pid })
  }
  if (subtreeTargets.length > 0) {
    const verdicts = await probeSubtreesForLiveWork(
      subtreeTargets.map((target) => target.pid),
      deps.subtree
    )
    for (const target of subtreeTargets) {
      const reason = verdicts.get(target.pid)
      if (reason === undefined) holds.set(target.sessionId, 'subtree_undetermined')
      else if (reason !== null) holds.set(target.sessionId, `live_subtree_${reason}`)
    }
  }
  return holds
}

// Live terminal sessions reduced to what per-workspace memory attribution needs:
// the pty root pid (for subtree RSS walking) plus the metadata the diagnostics
// panel shows. The session snapshot deliberately omits pids, so this main-only
// accessor exposes them to the workspace-memory sampler.
export function listTerminalRoots(): TerminalRootInfo[] {
  return [...terminals.values()]
    // A placeholder rehydrated from a snapshot sidecar has an inert process
    // with no pid — there is no subtree to attribute, so it has no root entry.
    .filter((session) => !session.isDisposed && typeof session.process.pid === 'number')
    .map((session) => ({
      sessionId: session.sessionId,
      rootPid: session.process.pid,
      workspaceId: session.workspaceId ?? null,
      agentId: session.agentId ?? null,
      terminalId: session.terminalId ?? null,
      kind: session.kind,
      cli: session.cli ?? null,
      activityKind: session.activity.kind,
      processAlive: isTerminalProcessAlive(session),
      startedAt: session.startedAt,
    }))
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
    // Token accounting: app quit bypasses disposeTerminal (deliberately, so
    // sidecars survive), so snapshot each sprint session's cumulative usage
    // here — awaited below, the last durable write before transcripts can be
    // pruned and the only one an OpenCode-style server-backed source gets.
    teardownPromises.push(sampleSprintSessionTokenUsage(session, 'teardown'))
    cleanupTerminalStartupScript(session.startupScriptPath)
    terminalOutput.flush(session.sessionId, 'dispose')
    terminalDiagnostics.clear(session.sessionId)
    clearTerminalIdleTimer(session)
    // Durable freeze-the-view, quit path: persist each agent terminal's painted
    // content before its process dies, so reopening the workspace after relaunch
    // shows it painted-and-paused instead of black. A suspended session's
    // already-built snapshot is preferred; live sessions get the cheap raw byte
    // dump (no headless render on the quit path) and rehydration renders it.
    writeTerminalSnapshotSidecar(session, {
      snapshot: session.replaySnapshot,
      rawReplay: session.replaySnapshot ? undefined : materializeTerminalReplay(session),
      cols: session.appliedCols ?? 80,
      rows: session.appliedRows ?? 24,
    })
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

function getLiveAgentExecutionIds(): LiveAgentExecution[] {
  return [...terminals.values()]
    .filter((session) => isTerminalProcessAlive(session) && Boolean(session.agentSession?.executionId))
    .map((session) => ({
      system: session.agentSession!.system,
      executionId: session.agentSession!.executionId,
    }))
}

// Resolve the executionId of the live agent session matching a (workspaceId,
// agentId) pair. Used at automation launch-confirm time to record the run's
// correlation key. Returns undefined when no live session matches — the caller
// must treat a miss as best-effort and not fail the launch.
function resolveAgentExecutionId(input: { workspaceId: string; agentId: string }): string | undefined {
  for (const session of terminals.values()) {
    if (
      isTerminalProcessAlive(session)
      && session.agentId === input.agentId
      && session.agentSession?.workspaceId === input.workspaceId
      && session.agentSession.executionId
    ) {
      return session.agentSession.executionId
    }
  }
  return undefined
}

function registerAgentSessionExitListener(listener: AgentSessionExitListener): () => void {
  agentSessionExitListeners.add(listener)
  return () => {
    agentSessionExitListeners.delete(listener)
  }
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
    // Heuristic cutover: when an authoritative hook says the agent is mid-work,
    // the output idle-timer must not override it to idle — the Stop hook reports
    // the real idle, and scheduleAgentStallCheck catches a genuine hang. Without
    // this, a silent-but-working tool call flickers to idle every few seconds.
    if (isAuthoritativeWorkingPhase(session.agentState)) return
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

// Disposed sessions are excluded here; the alive check happens in the caller so
// a late frame for a process that has exited is dropped. Matching + workspace
// disambiguation + most-recent tie-break live in the pure `selectAgentStateTarget`.
function resolveSessionForAgentStateFrame(frame: AgentStateFrame): TerminalSession | undefined {
  const candidates = [...terminals.values()]
    .filter((session) => !session.isDisposed && session.kind === 'agent')
    .map((session) => ({
      value: session,
      agentId: session.agentId,
      executionId: session.agentSession?.executionId,
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      startedAt: session.startedAt,
    }))
  return selectAgentStateTarget(candidates, frame)
}

// A hook-reported working agent (starting/thinking/tool_use) silent for this
// long — no follow-up frame and no terminal output — is flagged as (inferred)
// stalled. Conservative: long but silent legitimate tools (a quiet build) are
// rare, and the flag is a soft, inference-sourced hint, not an authoritative
// state. Stalled is also the reaper's expiry path for sessions whose final
// frame was lost: it rides the full idle threshold again before reclaim.
const AGENT_STALL_THRESHOLD_MS = 90_000

function scheduleAgentStallCheck(session: TerminalSession): void {
  clearAgentStallTimer(session)
  if (!isTerminalProcessAlive(session)) return
  const state = session.agentState
  // Only arm for a hook-driven working phase; idle/awaiting/terminal/inferred
  // phases are not "stuck mid-work". 'starting' is armed too: a resumed session
  // that never receives a prompt has SessionStart as its ONLY frame (no Stop
  // ever follows), so without conversion to 'stalled' it would read as working
  // — and be protected from the idle reaper — forever.
  if (!state || state.source !== 'hook') return
  if (state.phase !== 'starting' && state.phase !== 'thinking' && state.phase !== 'tool_use') return
  session.agentStallTimer = setTimeout(() => runAgentStallCheck(session), AGENT_STALL_THRESHOLD_MS)
}

function runAgentStallCheck(session: TerminalSession): void {
  session.agentStallTimer = undefined
  if (!isTerminalProcessAlive(session) || !session.agentState) return
  const decision = evaluateAgentStall({
    phase: session.agentState.phase,
    source: session.agentState.source,
    phaseSince: session.agentState.since,
    lastOutputAt: session.lastOutputAt,
    now: Date.now(),
    thresholdMs: AGENT_STALL_THRESHOLD_MS,
  })
  if (decision.action === 'recheck') {
    // Output advanced since arming (a streaming tool): keep watching.
    session.agentStallTimer = setTimeout(() => runAgentStallCheck(session), decision.afterMs)
    return
  }
  if (decision.action !== 'stalled') return

  session.agentState = { phase: 'stalled', since: Date.now(), source: 'inferred' }
  // stalled bridges to idle activity; suppress its broadcast and emit once.
  const derived = deriveActivityFromPhase('stalled', session.agentState.since)
  if (derived) setTerminalActivity(session, derived, { broadcast: false })
  if (terminals.get(session.sessionId) === session) broadcastTerminalSessionsChanged()
}

function ingestAgentStateFrame(frame: AgentStateFrame): void {
  const session = resolveSessionForAgentStateFrame(frame)
  if (!session) return

  // Token accounting flush: SessionEnd fires while the CLI shuts down and can
  // race the pty exit (and the stale-frame guard below), so snapshot the
  // session's cumulative usage BEFORE the liveness/ordering guards — this is
  // the warm-source moment and must never be dropped. Fire-and-forget.
  if (session.sprintEngineStatePath && frame.event === 'SessionEnd') {
    void sampleSprintSessionTokenUsage(session, 'session-end')
  }

  if (!isTerminalProcessAlive(session)) return

  // A stale frame (older than the phase we already recorded) is ignored so
  // out-of-order socket delivery can't roll the phase backward.
  if (session.agentState && session.agentState.since > frame.ts) return

  const previousPhase = session.agentState?.phase
  session.agentState = { phase: frame.phase, since: frame.ts, source: 'hook' }

  // Self-scheduled wakeup bookkeeping: a schedule frame arms the reap hold, a
  // stop frame disarms it, and SessionStart clears — a fresh or resumed CLI
  // process carries no timer from its previous life, so a stale hold would
  // park the session for nothing. Expiry needs no handling here: the policy
  // compares pendingWakeupAt against `now`.
  if (frame.event === 'SessionStart') session.pendingWakeupAt = null
  if (frame.wakeup) {
    session.pendingWakeupAt = 'stop' in frame.wakeup ? null : frame.ts + frame.wakeup.delaySeconds * 1000
  }

  // Capture the agent's own session id within its CLI/harness (Claude's equals
  // our terminal id since we mint and pass it; Codex/others mint their own and
  // we only learn it here). This is the id used to resume the conversation, so
  // persist it the first time the hook reports one. The frame is already routed
  // to the right session by the per-terminal MULTICODE_AGENT_ID, so concurrent
  // spawns can't cross-assign it.
  const cliSessionIdChanged =
    !!frame.sessionId && frame.sessionId !== session.cliSessionId
  if (cliSessionIdChanged) session.cliSessionId = frame.sessionId ?? session.cliSessionId

  // Token accounting (sprint-managed agents only): every captured session id
  // is appended to the run's durable token ledger — a resume mints a new id
  // whose cumulative counter restarts at zero, so all ids must be kept. The
  // SessionStart trigger covers resume-seeded sessions whose id was already
  // known at spawn (cliSessionIdChanged never fires for those); the reader
  // folds repeated records. Fire-and-forget, never affects the transition.
  if (
    session.sprintEngineStatePath
    && (cliSessionIdChanged || frame.event === 'SessionStart')
  ) {
    recordSprintSessionForTokenLedger(session)
  }

  // Bridge to the legacy activity field so existing consumers (sidebar bolding,
  // reaping, diagnostics) reflect the authoritative phase. Suppress its own
  // broadcast; we decide below whether a broadcast is warranted.
  //
  // Within-"working" churn (thinking ↔ tool_use) must NOT re-broadcast: keep the
  // existing working `since` so the bridged activity compares equal and only a
  // genuine working↔idle flip (or the awaiting_input boundary below) triggers a
  // snapshot IPC. Without this every frame bumps `since`, so the activity always
  // reads "changed" and broadcasts per frame — a storm — and the displayed
  // "working since" never accumulates. Mirrors the output path, which likewise
  // never bumps `since` while already working.
  const derived = deriveActivityFromPhase(frame.phase, frame.ts)
  const bridged =
    derived && derived.kind === 'working' && session.activity.kind === 'working'
      ? { kind: 'working' as const, since: session.activity.since }
      : derived
  const activityChanged = bridged ? setTerminalActivity(session, bridged, { broadcast: false }) : false

  // Arm/refresh/clear the stall watch for the new phase: a fresh working frame
  // resets the clock; a non-working phase disarms it.
  scheduleAgentStallCheck(session)

  // Only broadcast when something a consumer actually renders changed: the
  // bridged activity flipped (working ↔ idle), or the attention state crossed
  // the awaiting_input boundary. The frequent thinking ↔ tool_use churn within
  // "working" updates `agentState` in place but does not re-broadcast — matching
  // the renderer's dedupe signature and avoiding a snapshot IPC per tool call.
  const attentionChanged = (previousPhase === 'awaiting_input') !== (frame.phase === 'awaiting_input')
  if (
    (activityChanged || attentionChanged || cliSessionIdChanged)
    && terminals.get(session.sessionId) === session
  ) {
    broadcastTerminalSessionsChanged()
  }
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
    const now = Date.now()
    // Output right after a resize is the TUI repainting, not agent activity:
    // keep the painted scrollback complete but don't advance liveness/recency or
    // flip to "working" — otherwise revealing a workspace makes its idle agents
    // look active and reorders the sidebar.
    const isRepaint = now < (terminalSession.repaintGraceUntil ?? 0)
    appendTerminalOutput(terminalSession, data, now, !isRepaint)
    if (!isRepaint) {
      // For hook-reporting agents the hooks are the SOLE driver of activity:
      // output must not flip to "working" here, or the prompt/result text that an
      // authoritative awaiting_input/idle phase prints would override it back to
      // working (a transient spinner-vs-needs-input fight). This mirrors the idle
      // guard in scheduleTerminalIdleTransition, making hook agents fully
      // hook-driven in BOTH directions. lastOutputAt was already advanced by
      // appendTerminalOutput above and still feeds stall detection, so output
      // stays a liveness co-signal without owning activity. Non-hook/inferred
      // sessions keep the output-driven behavior verbatim.
      if (
        terminalSession.activity.kind !== 'working'
        && terminalSession.agentState?.source !== 'hook'
      ) {
        setTerminalActivity(
          terminalSession,
          { kind: 'working', since: terminalSession.lastOutputAt ?? now }
        )
      }
      scheduleTerminalIdleTransition(terminalSession)
    }
    terminalOutput.send(terminalSession, data)
  })

  terminalSession.process.onExit((event) => {
    // Freeze-the-view: a suspend-kill is NOT a real exit. Finalize the suspended
    // state and keep the session + painted scrollback; do not tear down the
    // SprintEngine run, mark the session exited, or fire `terminal:exit` (which
    // would unmount the view). Resume relaunches under the same session id.
    if (terminalSession.suspending || terminalSession.suspended) {
      terminalSession.suspending = false
      terminalSession.suspended = true
      if (terminals.get(sessionId) === terminalSession) {
        broadcastTerminalSessionsChanged()
      }
      return
    }
    void queueSprintEngineTerminalTeardown(terminalSession, `terminal exited with code ${event.exitCode}`)
    cleanupTerminalStartupScript(terminalSession.startupScriptPath)
    terminalOutput.flush(sessionId, 'exit')
    terminalDiagnostics.clear(sessionId)
    // Clear the hook phase so a stale `awaiting_input` (or any working phase) does
    // not outlive the process — the snapshot then infers `exited` from activity.
    // Only on a real exit: the suspend branch above returns early so a frozen,
    // resumable view keeps its phase.
    terminalSession.agentState = undefined
    setTerminalActivity(terminalSession, { kind: 'exited', at: Date.now(), exitCode: event.exitCode })
    const agentSession = terminalSession.agentSession
    if (agentSession?.executionId && agentSessionExitListeners.size > 0) {
      const exitEvent = {
        system: agentSession.system,
        workspaceRoot: agentSession.workspaceRoot,
        workspaceId: agentSession.workspaceId,
        executionId: agentSession.executionId,
        exitCode: event.exitCode,
      }
      for (const listener of agentSessionExitListeners) {
        const exitRecord = Promise.resolve(listener(exitEvent)).catch(() => {})
        pendingAgentSessionExitRecords.add(exitRecord)
        void exitRecord.finally(() => {
          pendingAgentSessionExitRecords.delete(exitRecord)
        })
      }
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
  descriptor: AgentSpawnDescriptor
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
    // Inject the agent's durable identity so the agent-state reporter's hook
    // frames map back to this session (MULTICODE_AGENT_ID === executionId ===
    // session.agentId below), and strip any stale id the app process inherited.
    // Descriptor env wins over the base, identity wins over both.
    const descriptorEnv = applyAgentIdentityEnv(
      { ...getTerminalEnv(), ...(input.descriptor.env ?? {}) },
      {
        workspaceId: input.workspaceId,
        agentId: input.descriptor.executionId,
        agentName: input.descriptor.displayName,
      }
    )
    // Install the reporter before launching a supported agent so its hooks
    // report phase from the first event. Best-effort; never blocks/fails launch.
    if (agentStateSupportsCli(input.descriptor.cli)) {
      await prepareAgentStateHook?.(input.descriptor.cwd || input.workspaceRoot, input.descriptor.cli)
    }
    const termProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: input.descriptor.cwd,
      env: descriptorEnv,
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
    requireAuthenticatedUser('Sign in to launch sprint workflows from the app.')
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

    // Resolve a CLI auth token (only CLIs whose manifest declares `auth`, e.g.
    // Z.AI, return one) from the shared credential store, so the manifest's
    // `launch.env` `{{secret}}` resolves into the spawned process env.
    const mobileAuthSecret = await getSharedCredentialStore().resolveSecret(input.cli)
    const mobileCliAuthToken = mobileAuthSecret.ok ? mobileAuthSecret.value : undefined
    // Block launch when the CLI requires an API key that isn't configured, rather
    // than starting it into an auth error (mirrors the desktop spawn guard).
    const mobileAuthPlugin = getPluginById(input.cli)
    const mobileBlock = cliCredentialLaunchBlock({
      displayName: mobileAuthPlugin?.manifest.displayName ?? input.cli,
      auth: mobileAuthPlugin?.manifest.auth,
      secretConfigured: mobileAuthSecret.ok,
    })
    if (mobileBlock) return { ok: false, message: mobileBlock.message }
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
      sprintEngineMcpEnv,
      false,
      mobileCliAuthToken
    )
    // Expose the agent's identity (=== session.agentId below) so the agent-state
    // reporter resolves its hook frames, and strip any stale inherited id.
    const mobileEnv = applyAgentIdentityEnv(env ?? getTerminalEnv(), { agentId: input.agentId })
    if (agentStateSupportsCli(input.cli)) {
      await prepareAgentStateHook?.(launchCwd ?? input.cwd, input.cli)
    }
    const initialSize = getTerminalSize(120, 30)
    const termProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: launchCwd ?? input.cwd,
      env: mobileEnv,
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
    cliSessionId,
    kind,
    workspaceId,
    agentId,
    agentName,
    terminalId,
    executionMode,
    worktreeId,
    worktreePath,
    cliPermissionPreset = 'default',
    debugMode = false,
    cliModel,
    memoryRootPath,
    memoryRelativeRoot,
    agentSession,
    visible = true,
    mcpSettings,
    connectorLaunch,
    connectorSkillId,
    spawnSkillId,
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
      // Only resize a live pty. A suspended session (pty killed, view kept
      // painted) is being re-viewed here, not relaunched — resume happens via
      // `resumeTerminal` on keystroke. Resizing its dead pty would be a no-op at
      // best, so guard on liveness rather than `!hasExited`.
      if (isTerminalProcessAlive(existingSession)) {
        safeResizeTerminal(sessionId, cols, rows)
      }
      // Prefer a suspended session's faithful screen snapshot over the raw stream.
      const replay = existingSession.replaySnapshot ?? materializeTerminalReplay(existingSession)
      if (replay) {
        sendTerminalEvent(sender, `terminal:replay:${sessionId}`, replay)
        logMainPerfEvent('TerminalRuntime', 'terminal-replay-sent', {
          sessionId,
          workspaceId: workspaceId ?? existingSession.workspaceId,
          agentId: agentId ?? existingSession.agentId,
          terminalId: terminalId ?? existingSession.terminalId,
          kind: kind ?? existingSession.kind,
          replayChars: replay.length,
          replayBytes: Buffer.byteLength(replay, 'utf8'),
        })
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
          requireAuthenticatedUser('Sign in to launch sprint workflows from the app.')
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
          settings: sprintEngineStatePath
            ? mcpSettingsForManagedSprintEngineLaunch(mcpSettings)
            : mcpSettings ?? { syncEnabled: false, servers: {} },
          clients: [cli],
          // A connector launch (connectorLaunch set, paired with the
          // single-server connectorMcpSettings) writes an isolated worktree
          // config that must contain only the connector — prune any MCP server
          // the base repo committed into the worktree, never merge it in.
          // connectorLaunch is the ONLY isolation signal: connectorSkillId is
          // the orthogonal skill-install concern and must never imply pruning
          // (a skill-only spawn would otherwise wipe the workspace's MCP
          // config).
          pruneUnlistedServers: connectorLaunch === true,
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

      // Debug Mode delivers the `debug` skill's full state-machine contract by
      // ensuring it is installed into the session CLI's native skill dir before
      // launch, so the injected /debug invocation resolves to a present skill.
      // Best-effort: a failure falls back to the always-present inline directive
      // rather than blocking the spawn.
      if (debugMode && !shellOnly && ensureBuiltinSkillInstalled) {
        try {
          await ensureBuiltinSkillInstalled(workingDirectory, 'debug')
        } catch (error) {
          logMainPerfEvent('TerminalRuntime', 'debug-skill-install-failed', {
            sessionId,
            cli,
            message: getErrorMessage(error),
          })
        }
      }

      // Skill-at-spawn: install the named builtin skill into the working
      // directory so the seeded/prefilled invocation resolves to a present
      // skill. connectorSkillId (connector chats) and spawnSkillId (the
      // composer's "+ Skill" attachment) share the install; only connector
      // launches also get the MCP-config exclusion below. Best-effort like the
      // debug install — a failure is logged and never blocks the spawn.
      const skillIdToInstall = connectorSkillId ?? spawnSkillId
      if (skillIdToInstall && !shellOnly) {
        if (ensureBuiltinSkillInstalled) {
          try {
            await ensureBuiltinSkillInstalled(workingDirectory, skillIdToInstall)
          } catch (error) {
            logMainPerfEvent('TerminalRuntime', 'connector-skill-install-failed', {
              sessionId,
              cli,
              connectorSkillId: skillIdToInstall,
              message: getErrorMessage(error),
            })
          }
        }
      }
      if (connectorLaunch && !shellOnly) {
        if (excludeWorktreeMcpConfig) {
          try {
            await excludeWorktreeMcpConfig(workingDirectory)
          } catch (error) {
            logMainPerfEvent('TerminalRuntime', 'connector-mcp-exclude-failed', {
              sessionId,
              cli,
              message: getErrorMessage(error),
            })
          }
        }
      }

      // The launch command's session id is the agent's own CLI/harness id when
      // resuming — `claude --resume <id>` / `codex resume <id>`. Prefer the
      // renderer-supplied (persisted) id, then any id captured on the session
      // being relaunched, then fall back to our terminal key ONLY for CLIs that
      // resume with the id we minted (Claude). For a self-id CLI (Codex) with no
      // captured id, pass empty so the manifest renders a bare `resume` (last
      // session) rather than `resume <terminal-key>`. Fresh launch: terminal key.
      const launchSessionId =
        resume
          ? (cliSessionId
            ?? existingSession?.cliSessionId
            ?? (cliResumesWithCallerSessionId(cli) ? sessionId : ''))
          : sessionId
      // Resolve a CLI auth token (only CLIs whose manifest declares `auth`, e.g.
      // Z.AI, return one) from the shared credential store so the manifest's
      // `launch.env` `{{secret}}` resolves into the spawned process env. Skipped
      // for plain shells (no agent CLI to authenticate).
      const cliAuthSecret = shellOnly ? null : await getSharedCredentialStore().resolveSecret(cli)
      const cliAuthToken = cliAuthSecret?.ok ? cliAuthSecret.value : undefined
      // If this CLI requires an API key (declares `auth`, e.g. Z.AI) and none is
      // configured, don't launch it into an auth error — return a clear,
      // actionable message. The renderer surfaces it and leaves the terminal
      // unstarted (see TerminalView spawn-failure handling).
      if (!shellOnly && cliAuthSecret) {
        const authPlugin = getPluginById(cli)
        const block = cliCredentialLaunchBlock({
          displayName: authPlugin?.manifest.displayName ?? cli,
          auth: authPlugin?.manifest.auth,
          secretConfigured: cliAuthSecret.ok,
        })
        if (block) return { ok: false, sessionId, message: block.message, exitCode: 1 }
      }
      const { command, args, cwd: launchCwd, pathStyle, initialInput, env, startupScriptPath } = shellOnly
        ? getPlainShellLaunchConfig(workingDirectory, sprintEngineStatePath, sessionId)
        : getShellLaunchConfig(
          workingDirectory,
          launchSessionId,
          resume,
          sprintEngineStatePath,
          cli,
          initialPrompt,
          cliRuntimes,
          cliPermissionPreset,
          cliModel,
          memoryRootPath,
          memoryRelativeRoot,
          sprintEngineMcpEnv,
          debugMode,
          cliAuthToken
        )
      // Install the authoritative-agent-state reporter into the workspace before
      // launching a supported agent, so its lifecycle hooks report phase the
      // moment it starts. Awaited so the hooks exist when the CLI reads its
      // settings; best-effort inside (never throws), so it cannot fail a launch.
      if (!shellOnly && agentStateSupportsCli(cli)) {
        await prepareAgentStateHook?.(launchCwd ?? workingDirectory, cli)
      }

      const initialSize = getTerminalSize(cols, rows)
      const termProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: initialSize.cols,
        rows: initialSize.rows,
        cwd: launchCwd ?? workingDirectory,
        // Expose this agent's identity so a typed Backlog handoff can record the
        // item ↔ agent link. Strips any inherited identity first, so plain
        // terminals carry none and a moved/relaunched session never keeps a
        // stale id.
        env: applyAgentIdentityEnv(env ?? getTerminalEnv(), { workspaceId, agentId, agentName }),
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
        // Seed the harness session id from the resume payload so it is known
        // (and snapshotted) immediately; the lifecycle hook refreshes it once
        // the relaunched agent reports its own id.
        cliSessionId: cliSessionId ?? undefined,
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
