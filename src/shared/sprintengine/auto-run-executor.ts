/**
 * Sprint Engine auto-run executor, shared by the renderer and the main
 * process.
 *
 * Companion of the auto-run planner (`./auto-run.ts`). The planner answers
 * "what should we do next?" as pure values; the executor carries those
 * decisions out against the live environment — terminals, the Sprint Engine
 * MCP CLI bridge, the workspace store, diagnostics, and the terminal-reveal
 * policy.
 *
 * Every external side effect goes through `SprintEngineAutoRunExecutorPorts`,
 * a small port surface that the React supervisor wires to the real
 * `window.api` / Zustand store / diagnostics module via
 * `createDefaultSprintEngineAutoRunExecutorPorts` (which stays in the renderer
 * shim `src/renderer/src/utils/sprintengineAutoRunExecutor.ts` — it binds
 * renderer-only singletons). Unit tests construct fake ports and call the
 * helpers directly, so the executor can be exercised without mocking
 * `window.api` or mounting the supervisor.
 *
 * Relocated from `src/renderer/src/utils/sprintengineAutoRunExecutor.ts`
 * (sprint-runtime-ownership Phase 2: the main process drives the auto-run
 * cycle), following the established shim pattern
 * (`sprintengineAutomationLifecycle.ts`). The renderer file remains a
 * re-export shim plus the default-ports factory. Pure with respect to the
 * environment: no `window.api`, React, or store access may be added here —
 * every effect arrives through the ports argument.
 */

import type {
  AgentCli,
  CliRuntimeSettings,
  DiagnosticLogEntry,
  DiagnosticLogInput,
  MemoryRootStatus,
  SprintEngineArtifactCommandResult,
  SprintEngineProjectionReadResult,
  TerminalSessionSnapshot,
  TerminalSpawnMetadata,
  TerminalSpawnResult,
} from '../electron-api'
import type { AgentExecution, AgentState } from './agent-state'
import type { AgentId, SprintEngineState, SprintEngineWorkspaceView } from './run-types'
import type { SprintEngineAutoPendingSpawn, SprintEngineAutomationMode } from './automation-types'
import { withTimeout } from './auto-run'

type WorkspaceId = string

export const TERMINAL_IPC_TIMEOUT_MS = 3000
export const TERMINAL_LIST_IPC_NOTICE_COOLDOWN_MS = 30000
const BRACKETED_PROMPT_SUBMIT_DELAY_MS = 50

// How an auto-run terminal is surfaced to the user when it starts or receives
// a prompt. Mirrors the renderer `modelRegistry` union structurally — this
// module is shared with the main process, so it cannot import the registry.
export type AgentTerminalRevealPolicy = 'background' | 'focus-if-open' | 'reveal'

// Why an automation was stopped. Canonical union for the executor's
// `applyAutomationStopReason` port; the renderer's
// `sprintengineSupervisorNotifications` re-exports it so the store-bound
// notification path and this port can never drift.
export type SprintEngineAutoRunDisableReason =
  | 'user_manual_toggle'
  | 'folder_missing'
  | 'blocked_on_external_input'
  | 'all_tasks_done'
  | 'workspace_removed'
  | 'agent_terminal_closed'
  | 'agent_spawn_failed'

export type TerminalSpawnArgs = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  resume?: boolean
  sprintEngineStatePath?: string
  cli?: AgentCli
  initialPrompt?: string
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  shellOnly?: boolean
  metadata?: TerminalSpawnMetadata
}

export type AgentUpdate = Partial<AgentState>

export interface SprintEngineAutoRunExecutorPorts {
  // Terminal IPC ---------------------------------------------------------
  terminalList(): Promise<TerminalSessionSnapshot[]>
  terminalWrite(sessionId: string, data: string): Promise<void>
  terminalKill(sessionId: string): Promise<void>
  terminalStatus(sessionId: string): Promise<{ processAlive: boolean }>
  terminalSpawn(args: TerminalSpawnArgs): Promise<TerminalSpawnResult>

  // Sprint Engine + filesystem IPC --------------------------------------
  pathExists(path: string): Promise<boolean>
  readSprintEngineProjection(statePath: string): Promise<SprintEngineProjectionReadResult>
  autoApproveSprintEngineArtifact(
    statePath: string,
    artifactId: string
  ): Promise<SprintEngineArtifactCommandResult>
  replenishSprintEngineRoster(input: {
    statePath: string
  }): Promise<SprintEngineArtifactCommandResult>
  memoryResolveRoot(input: {
    workspaceRoot: string | null
    relativeRoot: string | null
  }): Promise<MemoryRootStatus>

  // Diagnostics ---------------------------------------------------------
  publishDiagnostic(input: DiagnosticLogInput): Promise<DiagnosticLogEntry | void>

  // Terminal reveal -----------------------------------------------------
  applyTerminalRevealPolicy(
    workspaceId: string,
    agentId: string,
    name: string,
    policy: AgentTerminalRevealPolicy,
    config?: Record<string, unknown>
  ): void

  // Workspace store -----------------------------------------------------
  getWorkspace(workspaceId: WorkspaceId): SprintEngineWorkspaceView | undefined
  setSprintEngineState(workspaceId: WorkspaceId, state: SprintEngineState | null): void
  setSprintEngineAutoPendingSpawns(
    workspaceId: WorkspaceId,
    pendingSpawns: SprintEngineAutoPendingSpawn[]
  ): void
  setSprintEngineAutomationMode(
    workspaceId: WorkspaceId,
    mode: SprintEngineAutomationMode
  ): void
  setFolderMissing(workspaceId: WorkspaceId, missing: boolean): void
  updateAgent(workspaceId: WorkspaceId, agentId: AgentId, update: AgentUpdate): void
  markSprintEngineAgentNotificationDelivered(
    workspaceId: WorkspaceId,
    eventKey: string
  ): void

  // Automation lifecycle stops ------------------------------------------
  applyAutomationStopReason(
    workspaceId: WorkspaceId,
    reason: SprintEngineAutoRunDisableReason,
    context?: { taskId?: string; agentId?: string; message?: string; details?: string }
  ): void
}

export class TerminalListIpcError extends Error {
  readonly cause: unknown
  readonly workspaceId: string
  readonly workspaceName: string
  readonly intent: string

  constructor(input: {
    workspaceId: string
    workspaceName: string
    intent: string
    cause: unknown
  }) {
    const causeMessage = input.cause instanceof Error ? input.cause.message : String(input.cause)
    super(
      `Terminal-list IPC failed while ${input.intent} for workspace ${input.workspaceName}: ${causeMessage}`
    )
    this.name = 'TerminalListIpcError'
    this.cause = input.cause
    this.workspaceId = input.workspaceId
    this.workspaceName = input.workspaceName
    this.intent = input.intent
  }
}

export type TerminalListNoticeCooldown = Map<string, number>

export async function listTerminalSessionsForAutoRun(
  ports: SprintEngineAutoRunExecutorPorts,
  workspace: SprintEngineWorkspaceView,
  cause: string
): Promise<TerminalSessionSnapshot[]> {
  try {
    return await withTimeout(
      ports.terminalList(),
      TERMINAL_IPC_TIMEOUT_MS,
      `Timed out waiting for terminal sessions after ${TERMINAL_IPC_TIMEOUT_MS}ms.`
    )
  } catch (error) {
    throw new TerminalListIpcError({
      workspaceId: workspace.id,
      workspaceName: workspace.name ?? '',
      intent: cause,
      cause: error,
    })
  }
}

export async function publishTerminalListIpcFailureNotice(
  ports: SprintEngineAutoRunExecutorPorts,
  workspace: SprintEngineWorkspaceView,
  error: TerminalListIpcError,
  phase: 'reconcile' | 'supervise',
  cooldownState: TerminalListNoticeCooldown,
  now: number = Date.now()
): Promise<void> {
  const previousAt = cooldownState.get(workspace.id)
  if (previousAt !== undefined && now - previousAt < TERMINAL_LIST_IPC_NOTICE_COOLDOWN_MS) return
  cooldownState.set(workspace.id, now)

  const causeMessage = error.cause instanceof Error ? error.cause.message : String(error.cause)
  await ports.publishDiagnostic({
    level: 'warning',
    source: 'sprintengine',
    title: 'Auto-run paused: terminal IPC unavailable',
    message:
      'Could not list running terminals. Auto-run skipped this tick to avoid spawning duplicate agents.',
    details: [
      `Workspace: ${workspace.name}`,
      `Operation: ${error.intent}`,
      `Phase: ${phase}`,
      `Error: ${causeMessage}`,
      'Auto-run will retry on the next tick.',
    ].join('\n'),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  })
}

export function bracketedTerminalPaste(text: string): string {
  return `\x1b[200~${text.replace(/\r?\n/g, '\n')}\x1b[201~`
}

export async function writeBracketedPrompt(
  ports: SprintEngineAutoRunExecutorPorts,
  sessionId: string,
  text: string,
  submitDelayMs = BRACKETED_PROMPT_SUBMIT_DELAY_MS,
): Promise<void> {
  await ports.terminalWrite(sessionId, bracketedTerminalPaste(text))
  if (submitDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, submitDelayMs))
  }
  await ports.terminalWrite(sessionId, '\r')
}

export async function safeTerminalStatus(
  ports: SprintEngineAutoRunExecutorPorts,
  sessionId: string
): Promise<{ processAlive: boolean }> {
  try {
    return await ports.terminalStatus(sessionId)
  } catch {
    return { processAlive: false }
  }
}

export async function safeTerminalKill(
  ports: SprintEngineAutoRunExecutorPorts,
  sessionId: string
): Promise<void> {
  try {
    await withTimeout(
      ports.terminalKill(sessionId),
      TERMINAL_IPC_TIMEOUT_MS,
      `Timed out killing terminal session ${sessionId}.`
    )
  } catch {
    // Best-effort cleanup; the next reconcile pass will catch leftover sessions.
  }
}

export async function spawnTerminalSession(
  ports: SprintEngineAutoRunExecutorPorts,
  args: TerminalSpawnArgs
): Promise<TerminalSpawnResult> {
  try {
    return await ports.terminalSpawn(args)
  } catch (error) {
    return {
      ok: false,
      sessionId: args.sessionId,
      message: error instanceof Error ? error.message : 'Failed to start terminal.',
      exitCode: 1,
    }
  }
}

export type RecordSpawnFailureInput = {
  workspaceId: WorkspaceId
  workspaceName: string
  agentId: AgentId
  agentLabel: string
  selectedCli: AgentCli
  cliPermissionPreset: string
  taskId: string
  sessionId: string
  executionCwd: string
  sprintEngineStatePath: string
  spawnMessage: string
}

/**
 * Reset CLI state and publish a terminal-error diagnostic when a Sprint Engine
 * auto-run spawn fails. The same path covers MCP-config-failure surfacing —
 * the IPC layer returns the MCP message inside `spawnMessage` and the
 * diagnostic carries it through to the user.
 */
export async function recordSpawnFailure(
  ports: SprintEngineAutoRunExecutorPorts,
  input: RecordSpawnFailureInput
): Promise<void> {
  ports.applyAutomationStopReason(input.workspaceId, 'agent_spawn_failed', {
    agentId: input.agentId,
    taskId: input.taskId,
    message: `${input.agentLabel} could not be started for task ${input.taskId}.`,
    details: [
      `Spawn error: ${input.spawnMessage}`,
      `CLI: ${input.selectedCli}`,
      `CLI permissions: ${input.cliPermissionPreset}`,
      `Session: ${input.sessionId}`,
    ].join('\n'),
  })
  ports.setSprintEngineAutoPendingSpawns(input.workspaceId, [])
  ports.updateAgent(input.workspaceId, input.agentId, {
    cliSessionId: undefined,
    cliStartRequested: false,
    cliHasLaunched: false,
    cliOnboardingPromptSent: false,
    cliResumeAvailable: false,
  })
  await ports.publishDiagnostic({
    level: 'error',
    source: 'terminal',
    title: `${input.agentLabel} was not started`,
    message: input.spawnMessage,
    details: [
      `Workspace: ${input.workspaceName}`,
      `CLI: ${input.selectedCli}`,
      `CLI permissions: ${input.cliPermissionPreset}`,
      `Task: ${input.taskId}`,
      `Session: ${input.sessionId}`,
      `Cwd: ${input.executionCwd}`,
      `Sprint state: ${input.sprintEngineStatePath}`,
    ]
      .filter(Boolean)
      .join('\n'),
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    agentId: input.agentId,
    taskId: input.taskId,
    sessionId: input.sessionId,
  })
}

export type AgentExecutionUpdate = Partial<AgentExecution>
