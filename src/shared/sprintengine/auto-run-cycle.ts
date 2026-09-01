/**
 * Sprint Engine auto-run DECISION CYCLE.
 *
 * Relocated from the (now retired) renderer supervisor component
 * (sprint-runtime-ownership Phases 2–3). The ONLY production driver is the
 * main-process scheduler (`src/main/sprint-runtime.ts`), which builds
 * `SprintEngineAutoRunCyclePorts` over the terminal runtime, disk
 * projections, the automation intent service, and the runtime-op broadcast
 * bridge, and drives ticks through `superviseWorkspace` /
 * `reconcileWorkspaceSessions`. The renderer keeps port bindings + bound
 * re-exports for its historical test surface and manual one-shot paths in
 * `src/renderer/src/utils/sprintengineAutoRunRendererHost.ts` — it mounts no
 * loop.
 *
 * Environment-agnostic by construction: every side effect goes through the
 * ports object (the executor ports plus the cycle-specific ports below); the
 * only ambient dependencies are `Date`, `performance`, and timers. No
 * `window`, React, or store import may be added here. Perf events flow through
 * the shared auto-run perf seam (`sprintEngineAutoRunPerfLog`), wired by each
 * host (main: main perf diagnostics; renderer shim: `logPerfEvent`).
 *
 * Cross-tick module-level state (the terminal-list notice cooldown, the
 * task-scoped retirement ledger, and the bootstrap stall-notice set) lives in
 * `SprintEngineAutoRunCycleState`,
 * created once per host via `createSprintEngineAutoRunCycleState()` (main:
 * one per registered run; renderer host module: one at module level).
 */

import type {
  AgentCli,
  CliRuntimeSettings,
  McpSettings,
  MemoryRootStatus,
  TerminalSessionSnapshot,
  TerminalSpawnMetadata,
} from '../electron-api'
import type { PluginRegistryListEntry } from '../plugin-manifest'
import type {
  SprintEngineArtifact,
  SprintEngineState,
  SprintEngineWorkspaceView,
} from './run-types'
import type {
  SprintEngineAutoState,
  SprintEngineAutomationEvent,
} from './automation-types'
import {
  buildSprintEngineStartupPrompt,
  getSprintEngineStartupCommandMode,
  prependAgentIdentifier,
} from './agent-prompt'
import {
  buildSprintEngineAgentRosterForState,
  buildSprintEngineRosterCommandArgs,
  getSprintEngineRoleLabel,
  isCanceledSprintEngineRun,
  isCompletedSprintEngineRun,
  isSprintEngineCoordinatorAgent,
  normalizeSprintEngineProjection,
  resolveSprintEngineAgentRuntime,
  sprintEngineCoordinatorSeat,
} from './state'
import {
  AUTO_RUN_ROLE_CONTINUATION_RETRY_MS,
  AUTO_RUN_RETIREMENT_COOLDOWN_MS,
  sprintEngineIdleClockKey,
  AUTO_RUN_MAX_PROMPT_RETRIES,
  architectTriageMessageKey,
  artifactApprovalMessageKey,
  buildArchitectNeedsInputTriagePrompt,
  computeSprintEngineDemand,
  planSprintEngineDispatch,
  promptRetryLimitReached,
  recordPromptRetry,
  type SprintEngineDispatchAttempt,
  type SprintEngineDispatchNotificationInput,
  getSprintEngineDispatchPlanEngagedAgentIds,
  updateSprintEngineIdleClock,
  type SprintEngineDispatchPlan,
  type SprintEngineDispatchPath,
  describeSprintEngineExternalInputAutoRunBlock,
  describeNeedsInputAutoApprovalState,
  getArchitectActionableNeedsInputTasks,
  getAutoApprovalIntentArtifacts,
  getSprintEngineAutoRunOccupiedAgentIds,
  isSprintEngineRunBlockedOnExternalInput,
  pickNextAutoRuns,
  pickSprintEngineBootstrapCandidate,
  resolveSprintEngineSessionCwd,
  sprintEngineRepoIdForSessionCwd,
  sprintEngineAutoRunPerfLog as logPerfEvent,
  type AutoRunCandidate,
} from './auto-run'
import {
  TerminalListIpcError,
  listTerminalSessionsForAutoRun,
  publishTerminalListIpcFailureNotice as executorPublishTerminalListIpcFailureNotice,
  recordSpawnFailure,
  safeTerminalKill,
  safeTerminalStatus,
  spawnTerminalSession,
  writeBracketedPrompt,
  type AgentTerminalRevealPolicy,
  type SprintEngineAutoRunExecutorPorts,
  type TerminalListNoticeCooldown,
} from './auto-run-executor'
import {
  deriveSprintEngineAutomationDesiredMode,
  normalizeSprintEngineAutomationRuntimeState,
  sprintEngineAutomationShouldRun,
} from './automation-lifecycle'
import {
  agentCliSupportsConversationResume,
  agentCliUsesStableSessionIdForResume,
  resumeCapabilitiesForCli,
} from '../agent-cli-resume'
import { pathJoin } from '../paths'
import { resolveProjectKnowledgeConfig } from '../project-knowledge'

type Workspace = SprintEngineWorkspaceView

/** Structural stand-in for React's MutableRefObject (this module cannot import React). */
type MutableRef<T> = { current: T }

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The subset of app settings the spawn path reads live from the host's settings store. */
export type SprintEngineAutoRunSpawnSettings = {
  projectKnowledgeRoots?: Record<string, string | null> | null
}

/** Mirror of the renderer sync client's terminal launch-state payload (minus ids). */
export type SprintEngineAutoRunTerminalLaunchStateUpdate = {
  cliSessionId?: string | null
  cliStartRequested?: boolean
  cliHasLaunched?: boolean
  cliOnboardingPromptSent?: boolean
  cliResumeAvailable?: boolean
}

/**
 * Structural mirror of the renderer `SprintEngineDormancyPorts`
 * (`sprintengineProjectionRefresh.ts`): the completion event applier, the
 * one-shot teardown, its marker setter, and the clock.
 */
export type SprintEngineAutoRunDormancyPorts = {
  applySprintEngineAutomationEvent?(workspaceId: string, event: SprintEngineAutomationEvent): void
  tearDownCompletedRunAgents?(workspaceId: string): Promise<unknown> | unknown
  setCompletionTeardownAt?(workspaceId: string, at: number | undefined): void
  now?(): number
}

/** Mirror of the renderer projection-refresh result the cycle consumes. */
export type SprintEngineAutoRunProjectionRefreshResult =
  | { status: 'changed'; state: SprintEngineState }
  | { status: 'unchanged'; state: SprintEngineState | null }
  | { status: 'skipped'; reason: 'missing-context' }
  | { status: 'error'; message: string }

/** Mirror of the renderer departed task-scoped worker teardown result. */
export type SprintEngineAutoRunDepartedWorkerTeardown = {
  recorded: boolean
  removedAgent: boolean
  removedTab: boolean
  closedSessionId: string | null
}

/**
 * Everything the decision cycle touches beyond the executor ports. The
 * renderer binds these to `workspaceSyncClient` / `modelRegistry` /
 * `refreshSprintEngineWorkspaceProjection` / `enterSprintEngineDormancy` /
 * `tearDownDepartedTaskScopedWorker` / the store / `crypto`; a main-process
 * host later provides its own implementations (e.g. `isAgentTabVisible: () =>
 * false`, no-op session-identity mirroring).
 */
export type SprintEngineAutoRunCyclePorts = SprintEngineAutoRunExecutorPorts & {
  // Store touchpoints that bypass the executor ports -----------------------
  /** Plugin catalog snapshot for resume-capability stamping (`resumeCapabilitiesForCli`). */
  getPluginCatalogEntries(): readonly PluginRegistryListEntry[]
  /** Live app-settings inputs the spawn path reads at spawn time (not per tick). */
  getSpawnSettings(): SprintEngineAutoRunSpawnSettings

  // Session-identity mirroring (renderer: workspaceSyncClient; main later: no-op or own impl)
  dispatchAssignTerminalSession(
    workspaceId: string,
    agentId: string,
    sessionId: string,
    cli: AgentCli
  ): Promise<void> | void
  dispatchUpdateTerminalLaunchState(
    workspaceId: string,
    agentId: string,
    update: SprintEngineAutoRunTerminalLaunchStateUpdate
  ): Promise<void> | void

  // Projection refresh + dormancy + teardown --------------------------------
  /**
   * Wraps `refreshSprintEngineWorkspaceProjection`. The renderer impl passes
   * only the read/set sub-ports (no diagnostics/backlog/teardown), matching
   * the supervisor's historical auto-run refresh exactly.
   */
  refreshWorkspaceProjection(input: {
    workspace: SprintEngineWorkspaceView
    tokens: Map<string, string>
    cause: 'auto-run'
    force?: boolean
  }): Promise<SprintEngineAutoRunProjectionRefreshResult>
  /**
   * Wraps `enterSprintEngineDormancy`. When `dormancyPorts` is omitted the
   * host supplies its default completion-transition ports (the renderer's
   * store-bound `supervisorDormancyPorts`).
   */
  enterDormancy(
    workspace: Pick<SprintEngineWorkspaceView, 'id' | 'sprintEngineAutoState'>,
    dormancyPorts?: SprintEngineAutoRunDormancyPorts
  ): void
  /** Departed task-scoped worker teardown (renderer: record + remove panel; main later: sessions-only). */
  tearDownDepartedTaskScopedWorker(
    workspaceId: string,
    agentId: string,
    preloadedSessions?: TerminalSessionSnapshot[]
  ): Promise<SprintEngineAutoRunDepartedWorkerTeardown>

  // Host environment ---------------------------------------------------------
  /** Whether the agent's terminal tab is the visible one (main later: () => false). */
  isAgentTabVisible(workspaceId: string, agentId: string): boolean
  randomUUID(): string
}

// ---------------------------------------------------------------------------
// Cross-cycle mutable state
// ---------------------------------------------------------------------------

export type SprintEngineAutoRunCycleState = {
  /** Per-workspace cooldown for the terminal-list IPC failure notice. */
  terminalListIpcLastNoticeAt: TerminalListNoticeCooldown
  /**
   * Task id of each agent's last task-scoped retirement, keyed by the
   * idle-clock key. The planner reads this to bound the retire→respawn loop: a
   * repeat task-scoped retirement for the SAME done task falls back to the slow
   * idle-window cadence (see planSprintEngineDispatch.taskScopedRetirementTaskIds).
   * Cross-cycle, in-memory, bounded by roster size.
   */
  taskScopedRetirementTaskByClockKey: Map<string, string>
  /**
   * One stall notice per run store, so a bootstrap stall (no architect, or the
   * architect terminal exited before planning) surfaces once instead of every
   * supervision tick. Cleared when a bootstrap spawn later succeeds.
   */
  bootstrapStallNoticeKeys: Set<string>
  /**
   * One "missing CLI selection" diagnostic per (workspace, agent, task), so a
   * role whose runtime never resolves a CLI surfaces the notice once instead of
   * on every ~4s supervision tick. Cleared when that candidate later spawns with
   * a resolved CLI (a fixed config re-arms the notice). Mirrors
   * `bootstrapStallNoticeKeys`.
   */
  missingCliNoticeKeys: Set<string>
}

export function createSprintEngineAutoRunCycleState(): SprintEngineAutoRunCycleState {
  return {
    terminalListIpcLastNoticeAt: new Map(),
    taskScopedRetirementTaskByClockKey: new Map(),
    bootstrapStallNoticeKeys: new Set(),
    missingCliNoticeKeys: new Set(),
  }
}

// ---------------------------------------------------------------------------
// Constants + small pure helpers
// ---------------------------------------------------------------------------

const ARTIFACT_AUTO_APPROVAL_RETRY_MS = 60000
const AUTO_APPROVAL_DIAGNOSTIC_COOLDOWN_MS = 30000
export const BACKGROUND_TERMINAL_COLS = 100
export const BACKGROUND_TERMINAL_ROWS = 30

type RoleContinuationMessage = SprintEngineDispatchAttempt

export type ArchitectTriageMessage = {
  sentAt: number
  attempts?: number
}

export const DEFAULT_AUTO_STATE: SprintEngineAutoState = {
  desiredMode: 'manual',
  runtimeState: 'idle',
  cliPermissionPreset: 'manual',
  maxConcurrentAgents: 3,
  deliveredAgentNotificationEventKeys: [],
}

export function sprintEngineArtifactApprovalDesired(
  autoState: Partial<SprintEngineAutoState> | null | undefined
): boolean {
  return deriveSprintEngineAutomationDesiredMode(autoState) === 'run_agents_and_approve_artifacts'
}

export function getSprintEngineAutoState(workspace: Workspace | null | undefined): SprintEngineAutoState {
  return workspace?.sprintEngineAutoState ?? DEFAULT_AUTO_STATE
}

export function isSprintEngineRunnerActive(workspace: Workspace | null | undefined): boolean {
  return sprintEngineAutomationShouldRun(getSprintEngineAutoState(workspace))
}

// The renderer wrapper `deriveSprintEngineAutomationMode(autoState, runnerPolicy?)`
// deliberately ignores its runnerPolicy argument (see sprintengineAutomation.ts);
// the desired-mode derivation is the whole implementation, so the cycle calls
// the shared lifecycle function directly.
function deriveAutomationMode(
  autoState: Partial<SprintEngineAutoState> | null | undefined
): ReturnType<typeof deriveSprintEngineAutomationDesiredMode> {
  return deriveSprintEngineAutomationDesiredMode(autoState)
}

export function publishTerminalListIpcFailureNotice(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  workspace: Workspace,
  error: TerminalListIpcError,
  phase: 'reconcile' | 'supervise'
): Promise<void> {
  logPerfEvent('SprintEngineAutoRun', 'terminal-list-ipc-paused', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    intent: error.intent,
    phase,
    message: error.cause instanceof Error ? error.cause.message : String(error.cause),
  })
  return executorPublishTerminalListIpcFailureNotice(
    ports,
    workspace,
    error,
    phase,
    cycleState.terminalListIpcLastNoticeAt,
  )
}

/**
 * Run one supervise-cycle stage fail-soft (MC-1592). Auto-approval, notification
 * delivery, recovery, and triage each compute from the same snapshot and must
 * degrade independently: a stage that throws logs a diagnostic and is skipped,
 * so a single broken stage (an unreadable artifact, a transient engine error)
 * never aborts the tick — the later stages, crucially spawning, still run.
 *
 * `TerminalListIpcError` is deliberately NOT swallowed: it is the shared
 * "terminal list is unavailable, pause this workspace" signal the cycle caller
 * (`superviseWorkspace`) handles specially, so it re-throws to that boundary.
 */
async function runFailSoftStage<T>(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  stage: string,
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof TerminalListIpcError) throw error
    logPerfEvent('SprintEngineAutoRun', 'supervise-stage-failed', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      stage,
      message: error instanceof Error ? error.message : String(error),
    })
    await ports.publishDiagnostic({
      level: 'warning',
      source: 'sprintengine',
      title: 'Sprint supervisor stage skipped',
      message: `The ${stage} stage failed this tick and was skipped; the rest of the tick still ran.`,
      details: [
        `Workspace: ${workspace.name}`,
        `Stage: ${stage}`,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        'The roster runner remains enabled; the stage retries on the next tick.',
      ].join('\n'),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    }).catch(() => {})
    return fallback
  }
}

// Hard terminal gate. A finished run (every task done) OR a user-canceled run
// (MC-1604, the stored cancel flag) enters dormancy through the shared helper:
// fire the terminal transition once and tear its agents down once, identically
// to the projection reconcile — so a terminal state detected first by this poll
// (before the reactive reconcile marks it) still tears down exactly once, and
// the terminal `complete`/`canceled` runtime state then makes later ticks skip
// the workspace. `enterDormancy` reads the same cancel flag to fire the right
// terminal event. Catching cancellation here is defense-in-depth: it guarantees
// a canceled run stops polling even if its automation was left `running`.
// Returns true when the run was terminal so the caller skips the rest of the
// supervise cycle. Idempotent: repeat entries no-op via the reducer's
// terminal-state gate and the persisted teardown marker.
export function enterDormancyIfRunComplete(
  ports: Pick<SprintEngineAutoRunCyclePorts, 'enterDormancy'>,
  workspace: Pick<Workspace, 'id' | 'sprintEngineAutoState'>,
  sprintEngineState: Pick<SprintEngineState, 'tasks' | 'canceled'>,
  dormancyPorts?: SprintEngineAutoRunDormancyPorts,
): boolean {
  if (!isCompletedSprintEngineRun(sprintEngineState) && !isCanceledSprintEngineRun(sprintEngineState)) {
    return false
  }
  ports.enterDormancy(workspace, dormancyPorts)
  return true
}

/**
 * Does this session belong to the run/workspace under supervision?
 *
 * For a sprint workspace the RUN is the identity: `sprintEngineStatePath` is
 * unique per run, so it decides on its own. The workspace id deliberately does
 * NOT have to match — a run discovered at boot (`main/sprintengine-boot-discovery.ts`)
 * spawns under a placeholder workspace id and adopts the real one when a window
 * finally registers it, and requiring both would orphan every session that
 * hand-off crosses: an orphaned session reads as "the agent is not running" and
 * the supervisor spawns a duplicate. A non-sprint workspace has no run to key on
 * and still matches by workspace id.
 */
function sessionBelongsToWorkspaceRun(session: TerminalSessionSnapshot, workspace: Workspace): boolean {
  const statePath = workspace.sprintEngineContext?.statePath
  if (statePath) return session.sprintEngineStatePath === statePath
  return session.workspaceId === workspace.id
}

export function isMatchingWorkspaceAgentSession(
  session: TerminalSessionSnapshot,
  workspace: Workspace,
  agentId: string
): boolean {
  if (
    !session.processAlive
    || session.kind !== 'agent'
    || session.agentId !== agentId
    || !sessionBelongsToWorkspaceRun(session, workspace)
  ) {
    return false
  }

  const agentExecution = workspace.agents[agentId]?.execution
  const sessionExecution = session as TerminalSessionSnapshot & {
    executionMode?: 'current_workspace' | 'worktree'
    worktreeId?: string
    worktreePath?: string
  }

  if (agentExecution?.mode === 'worktree') {
    return sessionExecution.executionMode === 'worktree'
      && (!agentExecution.worktreeId || sessionExecution.worktreeId === agentExecution.worktreeId)
      && (!agentExecution.cwd || normalizeComparablePath(sessionExecution.worktreePath ?? session.cwd ?? '') === normalizeComparablePath(agentExecution.cwd))
  }

  return sessionExecution.executionMode !== 'worktree'
}

export async function refreshAutoWorkspaceState(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  projectionTokensByWorkspace: MutableRef<Map<string, string>>,
  options: { force?: boolean } = {}
): Promise<SprintEngineState | null> {
  const result = await ports.refreshWorkspaceProjection({
    workspace,
    tokens: projectionTokensByWorkspace.current,
    cause: 'auto-run',
    force: options.force,
  })
  if (result.status === 'changed') return result.state
  if (result.status === 'unchanged') return result.state
  // Auto Mode can be enabled before the agent-managed state file exists.
  return null
}

// Note: `ensureDurableAutoMode` was removed. It bridged local autoState into the
// run.yaml CLI-watch polling flag, but that bridge tied Multicode's UI state to
// CLI-headless polling state — two unrelated concerns. The click handler in
// SprintEngineBoardPanel writes the CLI flag directly when the user toggles
// automation. Multicode's supervisor decides whether to spawn agents from local
// autoState alone; CLI-headless polling is the CLI's own concern.

function normalizeComparablePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

async function publishArtifactApprovalWarning(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  artifact: SprintEngineArtifact,
  message: string,
  extraDetails: string[] = []
): Promise<void> {
  const task = workspace.sprintEngineState?.tasks.find((candidate) => candidate.id === artifact.taskId)

  await ports.publishDiagnostic({
    level: 'warning',
    source: 'sprintengine',
    title: 'Artifact auto-approval skipped',
    message,
    details: [
      `Workspace: ${workspace.name}`,
      `Sprint state: ${workspace.sprintEngineContext?.statePath ?? 'Unavailable'}`,
      `Artifact: ${artifact.id} - ${artifact.title}`,
      `Artifact kind: ${artifact.kind}`,
      `Artifact status: ${artifact.status}`,
      `Artifact path: ${artifact.path || 'No file path recorded'}`,
      `Task: ${artifact.taskId || 'No task'}${task ? ` - ${task.title}` : ''}`,
      'Roster runner remains enabled.',
      ...extraDetails,
    ].join('\n'),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    taskId: artifact.taskId || undefined,
    // Lets the notification's Open action deep-link to the producing task.
    navigationTarget: artifact.taskId ? { kind: 'task', ref: artifact.taskId } : undefined,
  })
}

async function publishAutoApprovalDiagnostic(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  diagnostics: MutableRef<Map<string, number>>,
  key: string,
  input: {
    level: 'info' | 'warning' | 'error'
    title: string
    message: string
    details?: string[]
    agentId?: string
    taskId?: string
    sessionId?: string
  }
): Promise<void> {
  const now = Date.now()
  const previousAt = diagnostics.current.get(key) ?? 0
  if (now - previousAt < AUTO_APPROVAL_DIAGNOSTIC_COOLDOWN_MS) return

  diagnostics.current.set(key, now)
  await ports.publishDiagnostic({
    level: input.level,
    source: 'sprintengine',
    title: input.title,
    message: input.message,
    details: [
      `Workspace: ${workspace.name}`,
      `Sprint state: ${workspace.sprintEngineContext?.statePath ?? 'Unavailable'}`,
      ...(input.details ?? []),
    ].join('\n'),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    agentId: input.agentId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    // Lets the notification's Open action deep-link to the task it is about.
    navigationTarget: input.taskId ? { kind: 'task', ref: input.taskId } : undefined,
  })
}

export async function findRunningAgentSession(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  agentId: string,
  prefetchedSessions?: TerminalSessionSnapshot[]
): Promise<TerminalSessionSnapshot | null> {
  const agent = workspace.agents[agentId]
  const sessions = prefetchedSessions
    ?? await listTerminalSessionsForAutoRun(ports, workspace, `find-running:${agentId}`)
  if (agent?.cliStartRequested && agent.cliHasLaunched && agent.cliSessionId) {
    const storedSession = sessions.find((session) => session.sessionId === agent.cliSessionId)
    if (storedSession && isMatchingWorkspaceAgentSession(storedSession, workspace, agentId)) return storedSession
  }

  const runningSession = sessions.find((session) =>
    isMatchingWorkspaceAgentSession(session, workspace, agentId)
  )

  if (!runningSession) return null

  const effectiveCli = runningSession.cli ?? agent?.cli
  if (!effectiveCli) {
    await ports.publishDiagnostic({
      level: 'error',
      source: 'terminal',
      title: 'Roster runner could not attach terminal',
      message: 'Running sprint terminal is missing its CLI selection.',
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId,
    })
    return null
  }

  ports.updateAgent(workspace.id, agentId, {
    cliSessionId: runningSession.sessionId,
    cliStartRequested: true,
    cliHasLaunched: true,
    cliResumeAvailable: false,
    cli: effectiveCli,
    kind: 'sprintengine',
  })
  void ports.dispatchAssignTerminalSession(workspace.id, agentId, runningSession.sessionId, effectiveCli)
  void ports.dispatchUpdateTerminalLaunchState(workspace.id, agentId, {
    cliResumeAvailable: false,
  })
  return runningSession
}

function applyAutoApprovalProjectionContent(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  projectionContent: unknown,
  projectionToken: unknown,
  projectionTokensByWorkspace: MutableRef<Map<string, string>>
): SprintEngineState | null {
  if (typeof projectionContent !== 'string') return null
  if (!workspace.sprintEngineContext) return null
  try {
    const projection = JSON.parse(projectionContent) as unknown
    const parsedState = normalizeSprintEngineProjection(projection, workspace.sprintEngineContext.teamSlug)
    if (!parsedState) return null
    ports.setSprintEngineState(workspace.id, parsedState)
    // We applied this projection out-of-band from the mutation result, so keep
    // the projection watcher aligned when the bridge provides the same mtime:size
    // token as readSprintEngineProjection. Older/malformed mutation payloads fall
    // back to one forced disk refresh on the next tick.
    if (typeof projectionToken === 'string' && projectionToken.trim()) {
      projectionTokensByWorkspace.current.set(workspace.id, projectionToken)
    } else {
      projectionTokensByWorkspace.current.delete(workspace.id)
    }
    return parsedState
  } catch {
    return null
  }
}

export async function sendApprovalToNextEligibleArtifactProducer(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  sentArtifactApprovalMessages: MutableRef<Map<string, number>>,
  autoApprovalDiagnostics: MutableRef<Map<string, number>>,
  projectionTokensByWorkspace: MutableRef<Map<string, string>>
): Promise<'sent' | 'failed' | 'none'> {
  const autoState = getSprintEngineAutoState(workspace)
  if (!sprintEngineArtifactApprovalDesired(autoState) || !workspace.sprintEngineContext) {
    return 'none'
  }

  const statePath = workspace.sprintEngineContext.statePath
  const now = Date.now()
  const eligibleArtifacts = getAutoApprovalIntentArtifacts(sprintEngineState)
  const artifact = eligibleArtifacts.find((candidate) =>
    now - (sentArtifactApprovalMessages.current.get(artifactApprovalMessageKey(workspace, candidate)) ?? 0)
      >= ARTIFACT_AUTO_APPROVAL_RETRY_MS
  )
  logPerfEvent('SprintEngineAutoRun', 'auto-approval-check', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    eligibleArtifactCount: eligibleArtifacts.length,
    selectedArtifactId: artifact?.id ?? null,
    selectedArtifactKind: artifact?.kind ?? null,
    selectedArtifactTaskId: artifact?.taskId ?? null,
  })
  if (!artifact) {
    if (eligibleArtifacts.length > 0) {
      const nextRetryAt = Math.min(
        ...eligibleArtifacts.map((candidate) =>
          (sentArtifactApprovalMessages.current.get(artifactApprovalMessageKey(workspace, candidate)) ?? 0)
            + ARTIFACT_AUTO_APPROVAL_RETRY_MS
        )
      )
      void publishAutoApprovalDiagnostic(
        ports,
        workspace,
        autoApprovalDiagnostics,
        `${workspace.id}:auto-approval-retry-wait`,
        {
          level: 'info',
          title: 'Artifact auto-approval waiting to retry',
          message: 'An artifact is still waiting for approval, but the retry cooldown has not elapsed.',
          details: [
            `Eligible artifacts: ${eligibleArtifacts.map((candidate) => candidate.id).join(', ')}`,
            `Next retry in: ${Math.max(0, Math.ceil((nextRetryAt - now) / 1000))}s`,
            ...describeNeedsInputAutoApprovalState(sprintEngineState),
          ],
        }
      )
    }
    logPerfEvent('SprintEngineAutoRun', 'auto-approval-none', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      eligibleArtifactCount: eligibleArtifacts.length,
      needsInputTaskCount: sprintEngineState.tasks.filter((task) => task.status === 'needs_input').length,
    })
    return 'none'
  }

  const approvalKey = artifactApprovalMessageKey(workspace, artifact)
  // Reserve the cooldown slot before the IPC call so a slow projection refresh
  // or a transient error cannot cause the supervisor to re-issue the same
  // approval mid-flight.
  sentArtifactApprovalMessages.current.set(approvalKey, Date.now())
  try {
    const result = await ports.autoApproveSprintEngineArtifact(statePath, artifact.id)
    if (!result.ok) {
      await publishArtifactApprovalWarning(
        ports,
        workspace,
        artifact,
        result.message || 'The sprint rejected the auto-approval.'
      )
      return 'none'
    }

    const projectionContent = (result.data as { projectionContent?: unknown } | undefined)?.projectionContent
    const projectionToken = (result.data as { projectionToken?: unknown } | undefined)?.projectionToken
    const appliedState = applyAutoApprovalProjectionContent(ports, workspace, projectionContent, projectionToken, projectionTokensByWorkspace)
    if (!appliedState) {
      const refreshedState = await refreshAutoWorkspaceState(ports, workspace, projectionTokensByWorkspace, { force: true })
      if (!refreshedState) {
        await publishArtifactApprovalWarning(
          ports,
          workspace,
          artifact,
          'Could not refresh sprint state after auto-approving the artifact.'
        )
        return 'failed'
      }
    }

    await publishAutoApprovalDiagnostic(
      ports,
      workspace,
      autoApprovalDiagnostics,
      `${approvalKey}:approved`,
      {
        level: 'info',
        title: 'Artifact auto-approved through the sprint',
        message: 'The sprint recorded the approval and refreshed projection state.',
        details: [
          `Artifact: ${artifact.id} - ${artifact.title}`,
          `Task: ${artifact.taskId}`,
          appliedState
            ? 'State applied from auto-approval mutation projection.'
            : 'Mutation projection was missing or malformed; state refreshed from projection.json.',
        ],
        taskId: artifact.taskId,
      }
    )
    return 'sent'
  } catch (error) {
    logPerfEvent('SprintEngineAutoRun', 'auto-approval-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      artifactId: artifact.id,
      message: error instanceof Error ? error.message : String(error),
    })
    await publishArtifactApprovalWarning(
      ports,
      workspace,
      artifact,
      error instanceof Error ? error.message : 'Approval failed. Review manually or retry.'
    )
    return 'none'
  }
}


function sessionBelongsToWorkspaceSprintEngine(
  session: TerminalSessionSnapshot,
  workspace: Workspace
): boolean {
  return Boolean(
    session.processAlive
    && session.kind === 'agent'
    && sessionBelongsToWorkspaceRun(session, workspace)
  )
}

export async function getRunningAutoRunAgentIds(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  sessionsSnapshot?: TerminalSessionSnapshot[]
): Promise<{ running: Set<string>; live: Set<string> }> {
  const runningAgentIds = new Set<string>()
  // Every agent with a live session, including `done` runtime agents that
  // `running` excludes — completion notifications still paste into those.
  const liveAgentIds = new Set<string>()
  const sessions = sessionsSnapshot
    ?? await listTerminalSessionsForAutoRun(ports, workspace, 'running-agent-ids')

  for (const session of sessions) {
    if (!session.agentId || !sessionBelongsToWorkspaceSprintEngine(session, workspace)) continue
    liveAgentIds.add(session.agentId)
    const runtimeAgent = sprintEngineState.sprintEngineAgents[session.agentId]
    if (runtimeAgent?.status === 'done') continue
    runningAgentIds.add(session.agentId)
    const agent = workspace.agents[session.agentId]
    if (!agent?.cliStartRequested || agent.cliSessionId !== session.sessionId) {
      const effectiveCli = session.cli ?? agent?.cli
      if (!effectiveCli) continue
      const resumeCaps = resumeCapabilitiesForCli(effectiveCli, ports.getPluginCatalogEntries())
      ports.updateAgent(workspace.id, session.agentId, {
        cliSessionId: session.sessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeAvailable: agentCliSupportsConversationResume(resumeCaps),
        cliUsesStableSessionId: agentCliUsesStableSessionIdForResume(resumeCaps),
        cli: effectiveCli,
        kind: 'sprintengine',
      })
      void ports.dispatchAssignTerminalSession(workspace.id, session.agentId, session.sessionId, effectiveCli)
    }
  }

  return { running: runningAgentIds, live: liveAgentIds }
}

/**
 * The planner's idle-agent universe: every live session whose runtime agent is
 * not actively working (no non-done current task, no owned active task, not
 * needs_input/retired). This set feeds own-task wakes, stalled restarts, and
 * idle retirement. It is NOT spawn capacity: under leases (MC-1591/MC-1592)
 * ready unowned work is covered by the desired-pool pass minting fresh
 * sessions, never by reserving slots against idle terminals.
 */
export async function getIdleAutoRunAgentIds(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  sessionsSnapshot?: TerminalSessionSnapshot[]
): Promise<Set<string>> {
  const idleAgentIds = new Set<string>()
  const sessions = sessionsSnapshot
    ?? await listTerminalSessionsForAutoRun(ports, workspace, 'idle-agent-ids')

  // Index tasks once so each session's checks are O(1) — O(sessions + tasks)
  // overall instead of O(sessions × tasks).
  const taskById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))
  const agentIdsOwningActiveTask = new Set<string>()
  for (const task of sprintEngineState.tasks) {
    if (task.ownerAgentId && (task.status === 'in_progress' || task.status === 'needs_input')) {
      agentIdsOwningActiveTask.add(task.ownerAgentId)
    }
  }

  for (const session of sessions) {
    if (!session.agentId || idleAgentIds.has(session.agentId)) continue
    if (!sessionBelongsToWorkspaceSprintEngine(session, workspace)) continue

    const runtimeAgent = sprintEngineState.sprintEngineAgents[session.agentId]
    if (!runtimeAgent) {
      // Ghost candidate (MC-1750): a live session the engine never bound
      // (spawned, never joined/claimed). It enters the idle universe so the
      // idle clock ages it and the ghost reaper can retire it; every other
      // dispatch path guards on the runtime record itself and skips it.
      idleAgentIds.add(session.agentId)
      continue
    }
    if (runtimeAgent.status === 'needs_input' || runtimeAgent.status === 'retired') continue

    const currentTask = runtimeAgent.currentTaskId
      ? taskById.get(runtimeAgent.currentTaskId)
      : null
    if (currentTask && currentTask.status !== 'done') continue

    if (agentIdsOwningActiveTask.has(session.agentId)) continue

    idleAgentIds.add(session.agentId)
  }

  return idleAgentIds
}

/**
 * Test-surface shim over the planner's notification path. Note the contract
 * at this surface: `runningAgentIds` doubles as the live-session set, so a
 * done-status agent's completion paste only happens when the caller includes
 * it here. The production cycle instead passes the broader `live` session set
 * so completion notifications reach done agents' terminals.
 */
export async function deliverAgentNotificationEvents(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRef<Set<string>>,
  sentAgentNotificationEvents: MutableRef<Set<string>>
): Promise<'started' | 'failed' | 'none'> {
  const result = await runSprintEngineDispatchPaths(ports, cycleState, {
    workspace,
    sprintEngineState,
    paths: ['notification'],
    runningAgentIds,
    idleAgentIds: new Set(),
    ledgers: { continuation: null, dispatch: null },
    notifications: {
      deliveredKeys: new Set(getSprintEngineAutoState(workspace).deliveredAgentNotificationEventKeys),
      sentKeys: sentAgentNotificationEvents.current,
      liveSessionAgentIds: runningAgentIds,
      canSpawnTargets: sprintEngineAutomationShouldRun(getSprintEngineAutoState(workspace)),
    },
    spawnContext: {
      sprintEngineState,
      cliRuntimes,
      mcpSettings,
      inFlightSpawns,
      sentNotificationKeys: sentAgentNotificationEvents,
      onAgentSpawned: (agentId) => runningAgentIds.add(agentId),
    },
  })
  if (result.notificationSpawnFailed) return 'failed'
  return result.notificationSpawned ? 'started' : 'none'
}

export type SprintEngineDispatchLedgers = {
  continuation: MutableRef<Map<string, RoleContinuationMessage>> | null
  dispatch: MutableRef<Map<string, RoleContinuationMessage>> | null
}

/**
 * Spawn dependencies for executing planned spawn actions (dead-claimant
 * respawns and notification-target spawns). The paste and restart paths do
 * not spawn, so this context stays optional for them.
 */
export type SprintEngineDispatchSpawnContext = {
  sprintEngineState: SprintEngineState
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>
  mcpSettings: McpSettings
  inFlightSpawns: MutableRef<Set<string>>
  /** Session-scoped delivered-notification cache; required to execute notification actions. */
  sentNotificationKeys?: MutableRef<Set<string>>
  /** Lets the caller fold freshly spawned agents into its running-agent view for the rest of the tick. */
  onAgentSpawned?: (agentId: string) => void
}

export type SprintEngineDispatchExecution = {
  restarted: boolean
  notificationSpawned: boolean
  notificationSpawnFailed: boolean
  /** Agents the plan engaged this pass; later non-planner paths (architect triage) must not engage them again this tick. */
  engagedAgentIds: ReadonlySet<string>
}

function dispatchPlanLedger(
  ledger: 'continuation' | 'dispatch',
  ledgers: SprintEngineDispatchLedgers
): Map<string, RoleContinuationMessage> | null {
  return (ledger === 'dispatch' ? ledgers.dispatch : ledgers.continuation)?.current ?? null
}

export async function executeSprintEngineDispatchPlan(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  workspace: Workspace,
  plan: SprintEngineDispatchPlan,
  ledgers: SprintEngineDispatchLedgers,
  spawnContext?: SprintEngineDispatchSpawnContext,
  /** Records the time each agent is retired so the planner can enforce the re-retirement cooldown across ticks. */
  retirementCooldown?: Map<string, number>,
  /** Reuse the caller's per-cycle terminal snapshot instead of fetching a fresh one for session lookups. */
  sharedSessionsSnapshot?: TerminalSessionSnapshot[]
): Promise<SprintEngineDispatchExecution> {
  const base = { workspaceId: workspace.id, workspaceName: workspace.name }
  for (const entry of plan.ledgerDeletes) {
    dispatchPlanLedger(entry.ledger, ledgers)?.delete(entry.key)
  }
  for (const skip of plan.skips) {
    logPerfEvent('SprintEngineAutoRun', skip.event, { ...base, ...skip.data })
  }
  for (const diagnostic of plan.diagnostics) {
    const ledger = diagnostic.ledger && diagnostic.key
      ? dispatchPlanLedger(diagnostic.ledger, ledgers)
      : undefined
    const previous = diagnostic.key ? ledger?.get(diagnostic.key) : undefined
    if (diagnostic.markExhausted && diagnostic.key && ledger) {
      const exhaustedAt = Date.now()
      ledger.set(diagnostic.key, {
        sentAt: previous?.sentAt ?? exhaustedAt,
        attempts: previous?.attempts ?? 0,
        exhaustedAt,
      })
    }
    await ports.publishDiagnostic({
      level: diagnostic.diagnostic.level,
      source: 'sprintengine',
      title: diagnostic.diagnostic.title,
      message: diagnostic.diagnostic.message,
      details: diagnostic.diagnostic.details,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId: diagnostic.agentId,
      taskId: diagnostic.diagnostic.taskId,
      navigationTarget: diagnostic.diagnostic.taskId
        ? { kind: 'task', ref: diagnostic.diagnostic.taskId }
        : undefined,
    })
    logPerfEvent('SprintEngineAutoRun', diagnostic.event, { ...base, ...diagnostic.data })
  }
  const markNotificationDelivered = (deliveryKey: string): void => {
    spawnContext?.sentNotificationKeys?.current.add(deliveryKey)
    ports.markSprintEngineAgentNotificationDelivered(workspace.id, deliveryKey)
  }
  for (const resolution of plan.notificationResolutions) {
    markNotificationDelivered(resolution.deliveryKey)
    logPerfEvent('SprintEngineAutoRun', resolution.event, { ...base, ...resolution.data })
  }
  const engagedAgentIds = getSprintEngineDispatchPlanEngagedAgentIds(plan)
  // One terminal-list snapshot serves every session lookup in this execution;
  // per-agent dedup guarantees at most one action per agent, so the snapshot
  // cannot go stale for an agent this pass acts on.
  const needsSessions = plan.pastes.length > 0
    || plan.restarts.length > 0
    || plan.retirements.length > 0
    || plan.notificationDeliveries.some((delivery) => delivery.kind === 'paste')
  const sessionsSnapshot = sharedSessionsSnapshot
    ?? (needsSessions
      ? await listTerminalSessionsForAutoRun(ports, workspace, 'execute-dispatch-plan')
      : undefined)
  let notificationSpawned = false
  let notificationSpawnFailed = false
  for (const delivery of plan.notificationDeliveries) {
    if (delivery.kind === 'paste') {
      const session = await findRunningAgentSession(ports, workspace, delivery.agentId, sessionsSnapshot)
      if (!session) {
        logPerfEvent('SprintEngineAutoRun', 'agent-notification-pending-no-session', { ...base, ...delivery.data })
        continue
      }
      await writeBracketedPrompt(ports, session.sessionId, delivery.prompt)
      if (!delivery.completion) {
        ports.applyTerminalRevealPolicy(
          workspace.id,
          delivery.agentId,
          delivery.label,
          'background',
          { sessionId: session.sessionId }
        )
      }
      markNotificationDelivered(delivery.deliveryKey)
      logPerfEvent('SprintEngineAutoRun', 'agent-notification-sent', { ...base, ...delivery.data, sessionId: session.sessionId })
      continue
    }
    if (!spawnContext || !delivery.role) {
      logPerfEvent('SprintEngineAutoRun', 'agent-notification-spawn-skipped-no-context', { ...base, ...delivery.data })
      continue
    }
    const result = await spawnAutoRunCandidate(
      ports,
      workspace,
      spawnContext.sprintEngineState,
      {
        agentId: delivery.agentId,
        label: delivery.label,
        role: delivery.role,
        taskId: delivery.taskId,
        startupPromptOverride: delivery.prompt,
      },
      spawnContext.cliRuntimes,
      spawnContext.mcpSettings,
      spawnContext.inFlightSpawns,
      { missingCliNoticeKeys: cycleState.missingCliNoticeKeys },
    )
    if (result === 'failed') {
      notificationSpawnFailed = true
      break
    }
    if (result === 'started') {
      notificationSpawned = true
      spawnContext.onAgentSpawned?.(delivery.agentId)
      markNotificationDelivered(delivery.deliveryKey)
      logPerfEvent('SprintEngineAutoRun', 'agent-notification-spawned', { ...base, ...delivery.data })
    }
    // 'skipped'/'missing_cli' leave the event pending; it retries next tick. The
    // decision layer dedupes the missing-CLI notice, so a CLI-less target no
    // longer re-publishes the diagnostic every ~4s.
  }
  // A failed spawn is a failure boundary: recordSpawnFailure has stopped the
  // automation, so executing the remaining pastes, restarts, respawns, or
  // retirements would launch agent work past a stop condition. Undelivered
  // actions are replanned by the next active tick.
  if (notificationSpawnFailed) {
    logPerfEvent('SprintEngineAutoRun', 'dispatch-plan-aborted-spawn-failure', {
      ...base,
      remainingPastes: plan.pastes.length,
      remainingRestarts: plan.restarts.length,
      remainingRespawns: plan.respawns.length,
      remainingRetirements: plan.retirements.length,
    })
    return { restarted: false, notificationSpawned, notificationSpawnFailed, engagedAgentIds }
  }
  for (const paste of plan.pastes) {
    const session = await findRunningAgentSession(ports, workspace, paste.agentId, sessionsSnapshot)
    if (!session) continue
    await writeBracketedPrompt(ports, session.sessionId, paste.prompt)
    const pasteLedger = dispatchPlanLedger(paste.ledger, ledgers)
    if (pasteLedger) recordPromptRetry(pasteLedger, paste.key, Date.now())
    logPerfEvent('SprintEngineAutoRun', paste.event, { ...base, ...paste.data, sessionId: session.sessionId })
  }
  let restarted = false
  for (const restart of plan.restarts) {
    const session = await findRunningAgentSession(ports, workspace, restart.agentId, sessionsSnapshot)
    if (!session) continue
    await safeTerminalKill(ports, session.sessionId)
    // Reset the wake budget so the replacement terminal is never kill-looped
    // before it has a chance to claim.
    ledgers.continuation?.current.delete(restart.key)
    restarted = true
    await ports.publishDiagnostic({
      level: 'warning',
      source: 'sprintengine',
      title: restart.diagnostic.title,
      message: restart.diagnostic.message,
      details: restart.diagnostic.details,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: restart.diagnostic.taskId,
      agentId: restart.agentId,
      sessionId: session.sessionId,
    })
    logPerfEvent('SprintEngineAutoRun', 'stalled-agent-restarted', { ...base, ...restart.data, sessionId: session.sessionId })
  }
  for (const respawn of plan.respawns) {
    if (!spawnContext) {
      logPerfEvent('SprintEngineAutoRun', 'respawn-skipped-no-context', { ...base, ...respawn.data })
      continue
    }
    const result = await spawnAutoRunCandidate(
      ports,
      workspace,
      spawnContext.sprintEngineState,
      {
        agentId: respawn.agentId,
        label: respawn.label,
        role: respawn.role,
        taskId: respawn.taskId,
      },
      spawnContext.cliRuntimes,
      spawnContext.mcpSettings,
      spawnContext.inFlightSpawns,
      { missingCliNoticeKeys: cycleState.missingCliNoticeKeys },
    )
    // 'skipped' means a live session or in-flight spawn already covers this
    // agent — no budget consumed, so it must NOT count a retry. Started, failed,
    // AND missing-CLI attempts all count against the respawn cap: a missing CLI
    // is an unresolvable config error, and counting it is what bounds the loop.
    // Skipping the retry there (the pre-fix bug, when missing-CLI returned the
    // same opaque 'skipped') re-planned a cli:null respawn every ~4s forever.
    if (result === 'skipped') {
      logPerfEvent('SprintEngineAutoRun', 'dead-claimant-respawn-skipped', { ...base, ...respawn.data })
      continue
    }
    const respawnLedger = ledgers.continuation?.current
    if (respawnLedger) recordPromptRetry(respawnLedger, respawn.key, Date.now())
    if (result === 'missing_cli') {
      logPerfEvent('SprintEngineAutoRun', 'dead-claimant-respawn-missing-cli', { ...base, ...respawn.data })
      continue
    }
    if (result === 'failed') {
      logPerfEvent('SprintEngineAutoRun', 'dead-claimant-respawn-failed', { ...base, ...respawn.data })
      continue
    }
    await ports.publishDiagnostic({
      level: 'warning',
      source: 'sprintengine',
      title: respawn.diagnostic.title,
      message: respawn.diagnostic.message,
      details: respawn.diagnostic.details,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: respawn.diagnostic.taskId,
      agentId: respawn.agentId,
    })
    logPerfEvent('SprintEngineAutoRun', 'dead-claimant-respawned', { ...base, ...respawn.data })
  }
  for (const retirement of plan.retirements) {
    // Never close the terminal the operator is currently looking at; the
    // clock keeps running and the retirement retries once the tab is no
    // longer the visible one. Visibility alone is the guard: the main-process
    // host has no notion of an "active workspace" across windows, and a
    // visible live session/tab already means an open, watched terminal.
    if (ports.isAgentTabVisible(workspace.id, retirement.agentId)) {
      logPerfEvent('SprintEngineAutoRun', 'idle-retirement-skipped-visible-tab', { ...base, ...retirement.data })
      continue
    }
    if (retirement.teardown) {
      // Departed task-scoped worker (task done): record + remove its panel so
      // there is nothing to auto-respawn, killing the idle reap ↔ respawn loop.
      // The recorded session lets a re-open from the role group resume. No
      // `dispatchUpdateTerminalLaunchState` mirror: removal is the flag reset,
      // and a post-removal reset would re-materialize the removed agent.
      const teardown = await ports.tearDownDepartedTaskScopedWorker(
        workspace.id,
        retirement.agentId,
        sessionsSnapshot,
      )
      // Only toast when the user could see the panel close; a recreated,
      // already-torn-down roster record closes nothing visible.
      if (teardown.closedSessionId || teardown.removedTab) {
        await ports.publishDiagnostic({
          level: 'info',
          source: 'sprintengine',
          title: retirement.diagnostic.title,
          message: retirement.diagnostic.message,
          details: retirement.diagnostic.details,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          agentId: retirement.agentId,
          ...(teardown.closedSessionId ? { sessionId: teardown.closedSessionId } : {}),
        })
      }
      logPerfEvent('SprintEngineAutoRun', 'task-scoped-worker-torn-down', { ...base, ...retirement.data, ...teardown })
      // Storm bound: a recreated record observed idle for a tick before Python
      // marks the id `left` must not re-tear-down until the short cooldown
      // elapses. Mirrors the kill-only path's cooldown bookkeeping.
      if (typeof retirement.data.taskId === 'string') {
        cycleState.taskScopedRetirementTaskByClockKey.set(
          sprintEngineIdleClockKey(workspace, retirement.agentId),
          retirement.data.taskId
        )
      }
      if (retirementCooldown) {
        const retiredAt = Date.now()
        retirementCooldown.set(sprintEngineIdleClockKey(workspace, retirement.agentId), retiredAt)
        for (const [key, ts] of retirementCooldown) {
          if (retiredAt - ts >= AUTO_RUN_RETIREMENT_COOLDOWN_MS) retirementCooldown.delete(key)
        }
      }
      continue
    }
    const session = await findRunningAgentSession(ports, workspace, retirement.agentId, sessionsSnapshot)
    if (!session) continue
    await safeTerminalKill(ports, session.sessionId)
    // Clear the agent's launch flags after the kill. The kill alone is not
    // enough: a mounted-but-unfocused AgentPanel keeps
    // `hasStarted` true off `cliStartRequested`, so its TerminalView respawns
    // the PTY before the next tick — the clock never sees a gap and the agent
    // is retired again every tick (an idle-retirement storm).
    //
    // Window disposal (MC-1444 Phase 2): when the planner marked the
    // retirement retainResumeState (the agent still holds its own task, which
    // under single-owner tasks spans review, needs_input, and a re-opened
    // in_progress), keep a resume token in cliSessionId so a later respawn
    // resumes the original conversation. The token
    // is the harness id the session captured, falling back to the terminal
    // key only for CLIs whose resume id IS our minted key (claude-code). No
    // token → fall through to the full clear (fresh-brief respawn).
    // Post-launch consumer: read the resume capabilities already stamped on the
    // retiring agent (from session assign) rather than re-resolving from the
    // catalog, which may not be loaded in this background path.
    const retiringAgent = workspace.agents[retirement.agentId]
    const resumeToken = retirement.retainResumeState
      ? (session.cliSessionId
        ?? (retiringAgent?.cliUsesStableSessionId ? session.sessionId : undefined))
      : undefined
    const retainedResume = Boolean(resumeToken && retiringAgent?.cliResumeAvailable)
    ports.updateAgent(workspace.id, retirement.agentId, {
      cliSessionId: retainedResume ? resumeToken : undefined,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: retainedResume,
    })
    void ports.dispatchUpdateTerminalLaunchState(workspace.id, retirement.agentId, {
      cliSessionId: retainedResume ? (resumeToken as string) : null,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: retainedResume,
    })
    await ports.publishDiagnostic({
      level: 'info',
      source: 'sprintengine',
      title: retirement.diagnostic.title,
      message: retirement.diagnostic.message,
      details: retirement.diagnostic.details,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId: retirement.agentId,
      sessionId: session.sessionId,
    })
    logPerfEvent('SprintEngineAutoRun', 'idle-terminal-retired', { ...base, ...retirement.data, sessionId: session.sessionId })
    if (retirement.data.reason === 'task_scoped_terminal_state' && typeof retirement.data.taskId === 'string') {
      cycleState.taskScopedRetirementTaskByClockKey.set(
        sprintEngineIdleClockKey(workspace, retirement.agentId),
        retirement.data.taskId
      )
    }
    if (retirementCooldown) {
      const retiredAt = Date.now()
      retirementCooldown.set(sprintEngineIdleClockKey(workspace, retirement.agentId), retiredAt)
      // Keep the cooldown map bounded to agents retired within the live window;
      // expired entries can be forgotten without changing planner decisions.
      for (const [key, ts] of retirementCooldown) {
        if (retiredAt - ts >= AUTO_RUN_RETIREMENT_COOLDOWN_MS) retirementCooldown.delete(key)
      }
    }
  }
  return { restarted, notificationSpawned, notificationSpawnFailed, engagedAgentIds }
}

async function runSprintEngineDispatchPaths(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  input: {
    workspace: Workspace
    sprintEngineState: SprintEngineState
    paths: SprintEngineDispatchPath[]
    runningAgentIds: ReadonlySet<string>
    idleAgentIds: ReadonlySet<string>
    ledgers: SprintEngineDispatchLedgers
    spawnContext?: SprintEngineDispatchSpawnContext
    notifications?: SprintEngineDispatchNotificationInput
    idleClock?: ReadonlyMap<string, number>
    retirementCooldown?: MutableRef<Map<string, number>>
    /** Shared per-cycle terminal snapshot; reused for the executor's session lookups so the cycle issues one terminalList instead of several. */
    sessionsSnapshot?: TerminalSessionSnapshot[]
  }
): Promise<SprintEngineDispatchExecution> {
  const plan = planSprintEngineDispatch({
    workspace: input.workspace,
    sprintEngineState: input.sprintEngineState,
    now: Date.now(),
    runningAgentIds: input.runningAgentIds,
    idleAgentIds: input.idleAgentIds,
    continuationLedger: input.ledgers.continuation?.current ?? new Map(),
    dispatchLedger: input.ledgers.dispatch?.current ?? new Map(),
    paths: new Set(input.paths),
    notifications: input.notifications,
    idleClock: input.idleClock,
    retirementCooldown: input.retirementCooldown?.current,
    taskScopedRetirementTaskIds: cycleState.taskScopedRetirementTaskByClockKey,
  })
  return executeSprintEngineDispatchPlan(
    ports,
    cycleState,
    input.workspace,
    plan,
    input.ledgers,
    input.spawnContext,
    input.retirementCooldown?.current,
    input.sessionsSnapshot
  )
}

// The exported per-path functions below are test-surface shims: production
// runs one all-paths `runSprintEngineDispatchPaths` call per supervise cycle,
// so cross-path per-agent dedup applies. The shims exercise a single planner
// path each, with the same planner and executor underneath.

export async function respawnDeadSprintEngineClaimants(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: ReadonlySet<string>,
  idleAgentIds: ReadonlySet<string>,
  sentContinuationMessages: MutableRef<Map<string, RoleContinuationMessage>>,
  spawnDeps: {
    cliRuntimes: Record<AgentCli, CliRuntimeSettings>
    mcpSettings: McpSettings
    inFlightSpawns: MutableRef<Set<string>>
  }
): Promise<void> {
  await runSprintEngineDispatchPaths(ports, cycleState, {
    workspace,
    sprintEngineState,
    paths: ['respawn'],
    runningAgentIds,
    idleAgentIds,
    ledgers: { continuation: sentContinuationMessages, dispatch: null },
    spawnContext: { sprintEngineState, ...spawnDeps },
  })
}

export async function sendContinuationPromptsToIdleAgents(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  idleAgentIds: ReadonlySet<string>,
  sentContinuationMessages: MutableRef<Map<string, RoleContinuationMessage>>
): Promise<void> {
  await runSprintEngineDispatchPaths(ports, cycleState, {
    workspace,
    sprintEngineState,
    paths: ['task_wake'],
    runningAgentIds: new Set(),
    idleAgentIds,
    ledgers: { continuation: sentContinuationMessages, dispatch: null },
  })
}

export async function escalateStalledLiveIdleAgents(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  idleAgentIds: ReadonlySet<string>,
  sentContinuationMessages: MutableRef<Map<string, RoleContinuationMessage>>
): Promise<'restarted' | 'none'> {
  const result = await runSprintEngineDispatchPaths(ports, cycleState, {
    workspace,
    sprintEngineState,
    paths: ['restart'],
    runningAgentIds: new Set(),
    idleAgentIds,
    ledgers: { continuation: sentContinuationMessages, dispatch: null },
  })
  return result.restarted ? 'restarted' : 'none'
}

export async function sendDispatchPromptsToRunningAgents(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  sentDispatchMessages: MutableRef<Map<string, RoleContinuationMessage>>
): Promise<void> {
  await runSprintEngineDispatchPaths(ports, cycleState, {
    workspace,
    sprintEngineState,
    paths: ['dispatch'],
    runningAgentIds,
    idleAgentIds: new Set(),
    ledgers: { continuation: null, dispatch: sentDispatchMessages },
  })
}

async function reconcileDuplicateAgentSessions(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace
): Promise<TerminalSessionSnapshot[]> {
  const sessions = await listTerminalSessionsForAutoRun(ports, workspace, 'reconcile-duplicates')
  const sessionsByAgentId = new Map<string, TerminalSessionSnapshot[]>()

  sessions.forEach((session) => {
    if (!session.agentId || !sessionBelongsToWorkspaceSprintEngine(session, workspace)) return
    sessionsByAgentId.set(session.agentId, [
      ...(sessionsByAgentId.get(session.agentId) ?? []),
      session,
    ])
  })

  for (const [agentId, agentSessions] of sessionsByAgentId) {
    if (agentSessions.length <= 1) continue

    const storedSessionId = workspace.agents[agentId]?.cliSessionId
    const preferredSession =
      agentSessions.find((session) => session.sessionId === storedSessionId)
      ?? [...agentSessions].sort((a, b) => b.startedAt - a.startedAt)[0]

    await Promise.all(
      agentSessions
        .filter((session) => session.sessionId !== preferredSession.sessionId)
        .map((session) => safeTerminalKill(ports, session.sessionId))
    )

    const agent = workspace.agents[agentId]
    if (agent?.cliSessionId !== preferredSession.sessionId || !agent?.cliStartRequested) {
      const effectiveCli = preferredSession.cli ?? agent?.cli
      if (!effectiveCli) continue
      const resumeCaps = resumeCapabilitiesForCli(effectiveCli, ports.getPluginCatalogEntries())
      ports.updateAgent(workspace.id, agentId, {
        cliSessionId: preferredSession.sessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeAvailable: agentCliSupportsConversationResume(resumeCaps),
        cliUsesStableSessionId: agentCliUsesStableSessionIdForResume(resumeCaps),
        cli: effectiveCli,
        kind: 'sprintengine',
      })
      void ports.dispatchAssignTerminalSession(workspace.id, agentId, preferredSession.sessionId, effectiveCli)
    }
  }

  return sessions
}

/**
 * Spawn outcomes. `skipped` and `missing_cli` are BOTH "no spawn this tick", but
 * they are not the same: `skipped` means a live session or in-flight spawn
 * already covers the agent (a free no-op), while `missing_cli` means the role's
 * runtime resolved no CLI — a real, unresolvable attempt. Callers that cap
 * retries must count `missing_cli` (it re-plans every tick until config is
 * fixed) but not `skipped` (nothing to bound). The decision layer distinguishes
 * them so no call site has to guess from an opaque `skipped`.
 */
export type SpawnAutoRunCandidateResult = 'started' | 'failed' | 'skipped' | 'missing_cli'

/**
 * Stand up the task's own worktree so the spawn can cwd into it (MC-2136), and
 * return its project-root-relative path. Null on every run that shares one
 * worktree — the overwhelmingly common case, and the only one where this costs
 * nothing, because it never runs.
 *
 * A failure here is reported and then survived: the caller falls back to the run
 * worktree rather than losing the spawn. That is a degraded cwd, not a silent
 * one — the diagnostic says the agent is about to work outside its task's tree.
 */
async function ensureTaskWorktreeForSpawn(
  ports: SprintEngineAutoRunCyclePorts,
  input: {
    sprintEngineState: SprintEngineState
    sprintEngineStatePath: string
    taskId: string
    workspace: Workspace
    agentId: string
  }
): Promise<string | null> {
  if (input.sprintEngineState.vcs?.taskIsolation !== true || !input.taskId) return null
  const result = await ports
    .ensureSprintEngineTaskWorktree({ statePath: input.sprintEngineStatePath, taskId: input.taskId })
    .catch((error: unknown) => ({
      ok: false,
      isolated: true,
      worktreePath: null,
      message: error instanceof Error ? error.message : String(error),
    }))
  if (result.ok && result.worktreePath) return result.worktreePath
  await ports.publishDiagnostic({
    level: 'error',
    source: 'filesystem',
    title: 'Task worktree could not be prepared',
    message:
      'This sprint gives every task its own worktree, but one could not be prepared. '
      + 'The agent starts in the shared run worktree, where its changes may not be committed.',
    details: [
      `Workspace: ${input.workspace.name}`,
      `Agent: ${input.agentId}`,
      `Task: ${input.taskId}`,
      result.message ?? 'No reason reported.',
    ].join('\n'),
    workspaceId: input.workspace.id,
    workspaceName: input.workspace.name,
    agentId: input.agentId,
    taskId: input.taskId,
  })
  return null
}

export async function spawnAutoRunCandidate(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  nextRun: AutoRunCandidate,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRef<Set<string>>,
  options: { revealPolicy?: AgentTerminalRevealPolicy; missingCliNoticeKeys?: Set<string> } = {}
): Promise<SpawnAutoRunCandidateResult> {
  const currentWorkspace = ports.getWorkspace(workspace.id)
  const currentAgent = currentWorkspace?.agents[nextRun.agentId]
  // Defensive belt over the reconcile-stamped record (MC-1450): re-resolve
  // the full runtime hierarchy (per-agent override > role `roleRuntimes`
  // config > record) at the moment of spawn, so a mint path that bypassed
  // reconcile can never substitute the CLI's default model.
  const resolvedRuntime = resolveSprintEngineAgentRuntime(
    sprintEngineState.roleRuntimes,
    nextRun.role,
    currentAgent,
  )
  const selectedCli = resolvedRuntime.cli
  const selectedCliModel = resolvedRuntime.cliModel
  const selectedCliReasoning = resolvedRuntime.cliReasoning
  const sessionId = ports.randomUUID()
  const spawnKey = `${workspace.id}:${nextRun.agentId}`
  if (inFlightSpawns.current.has(spawnKey)) return 'skipped'

  if (!workspace.folderPath || !workspace.sprintEngineContext) return 'skipped'
  const missingCliNoticeKey = `${workspace.id}:${nextRun.agentId}:${nextRun.taskId}`
  if (!selectedCli) {
    // A missing CLI is a per-role CONFIG error, not a spawn failure. Return
    // 'missing_cli' (NOT 'failed') so the supervise tick moves on to the sibling
    // candidates instead of aborting on the first misconfigured role — one role
    // without a resolved CLI must never freeze every ready task queued behind it
    // (the 2026-07-19 stall: a CLI-less nuclear_reviewer froze its sibling
    // spec_reviewer task too). Distinct from a coverage 'skipped' so a retry-
    // capped caller (dead-claimant respawn) counts it instead of re-planning it
    // every ~4s unbounded. Surface the diagnostic ONCE per (workspace, agent,
    // task) via the runner's notice set (mirrors bootstrapStallNoticeKeys) rather
    // than re-publishing on every ~4s supervision tick.
    const noticeKeys = options.missingCliNoticeKeys
    if (!noticeKeys || !noticeKeys.has(missingCliNoticeKey)) {
      noticeKeys?.add(missingCliNoticeKey)
      await ports.publishDiagnostic({
        level: 'error',
        source: 'terminal',
        title: 'Roster runner skipped agent',
        message: 'Sprint agent is missing its CLI selection.',
        details: [
          `Workspace: ${workspace.name}`,
          `Agent: ${nextRun.agentId}`,
          `Task: ${nextRun.taskId}`,
        ].join('\n'),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: nextRun.agentId,
        taskId: nextRun.taskId,
      })
    }
    return 'missing_cli'
  }
  // CLI resolved: clear any stale missing-CLI notice so a later re-break re-warns.
  options.missingCliNoticeKeys?.delete(missingCliNoticeKey)
  // Resume-aware owner respawn (MC-1444 Phase 2): spawning the previous
  // owner back onto its OWN task after a window disposal relaunches the
  // original conversation (`--resume <token>`) instead of a fresh brief, so the
  // resumed session gets back the diff context its task feedback references.
  // Deliberately narrow: the retained-resume state is only ever shaped by the
  // window-disposal retirement (cliResumeAvailable + cliSessionId with
  // cliHasLaunched/cliStartRequested cleared); every other spawn — new task,
  // crashed live session — stays a fresh conversation. Resume failure
  // in the CLI degrades to a new session on the same startup text — a fresh brief.
  const resumeToken =
    sprintEngineState.sprintEngineAgents[nextRun.agentId]?.lastOwnedTaskId === nextRun.taskId
    && currentAgent?.cliResumeAvailable
    && currentAgent.cliSessionId
    && !currentAgent.cliHasLaunched
    && !currentAgent.cliStartRequested
      ? currentAgent.cliSessionId
      : undefined
  const workspaceFolderPath = workspace.folderPath
  const sprintEngineStatePath = workspace.sprintEngineContext.statePath
  // In-flight spawns are tracked in-memory only (MC-1592): a spawn either
  // produces a session this tick or the desired-pool pass covers the work next
  // tick — there is no persisted pending-spawn ledger to reconcile.
  inFlightSpawns.current.add(spawnKey)

  try {
    const startedAt = performance.now()
    logPerfEvent('SprintEngineAutoRun', 'spawn-start', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId: nextRun.agentId,
      role: nextRun.role,
      taskId: nextRun.taskId,
      sessionId,
      resumedConversation: Boolean(resumeToken),
    })
    const folderExists = await ports.pathExists(workspaceFolderPath)
    if (!folderExists) {
      ports.setFolderMissing(workspace.id, true)
      ports.applyAutomationStopReason(workspace.id, 'folder_missing', {
        agentId: nextRun.agentId,
        taskId: nextRun.taskId,
      })
      await ports.publishDiagnostic({
        level: 'error',
        source: 'filesystem',
        title: 'Roster runner stopped',
        message: `Workspace folder could not be found: ${workspaceFolderPath}`,
        details: [
          `Workspace: ${workspace.name}`,
          `Agent: ${nextRun.agentId}`,
          `Task: ${nextRun.taskId}`,
        ].join('\n'),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: nextRun.agentId,
        taskId: nextRun.taskId,
      })
      return 'failed'
    }

    const latestAgent = ports.getWorkspace(workspace.id)?.agents[nextRun.agentId]
    if (latestAgent?.cliSessionId) {
      const status = await safeTerminalStatus(ports, latestAgent.cliSessionId)
      if (status.processAlive) return 'skipped'
      ports.updateAgent(workspace.id, nextRun.agentId, {
        cliSessionId: undefined,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      void ports.dispatchUpdateTerminalLaunchState(workspace.id, nextRun.agentId, {
        cliSessionId: null,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
    } else if (latestAgent?.cliStartRequested) {
      ports.updateAgent(workspace.id, nextRun.agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      void ports.dispatchUpdateTerminalLaunchState(workspace.id, nextRun.agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
    }

    // MC-1615 single cwd choke point: every session cwd resolves through
    // resolveSprintEngineSessionCwd, so the spawn path never reads
    // vcs.worktreePath directly. Worktree mode routes the terminal into the run
    // worktree of the repo its task targets (MC-1610), so every agent working a
    // given repo shares that repo's isolated checkout and commits in it. The
    // routing exemplar task id is the key; a bound owner's respawn carries its
    // own task id here, which is what lands a resumed owner back in the tree it
    // was working in.
    //
    // Under per-task isolation (MC-2136) the tree is the TASK's own, and it is
    // provisioned right here, before the terminal exists: claim provisions
    // lazily, and by then the session's cwd is already fixed. Provisioning
    // failure is not a spawn failure — the session falls back to the run
    // worktree, exactly where it would have gone before isolation existed, and
    // the engine's own claim-time provisioning still stands the tree up.
    const provisionedTaskWorktreePath = await ensureTaskWorktreeForSpawn(ports, {
      sprintEngineState,
      sprintEngineStatePath,
      taskId: nextRun.taskId,
      workspace,
      agentId: nextRun.agentId,
    })
    const sessionCwd = resolveSprintEngineSessionCwd(sprintEngineState, nextRun.taskId, {
      provisionedTaskWorktreePath,
    })
    const executionMode = sessionCwd.executionMode
    const executionCwd = sessionCwd.worktreeRelativePath
      ? pathJoin(workspaceFolderPath, sessionCwd.worktreeRelativePath)
      : workspaceFolderPath
    const autoState = getSprintEngineAutoState(workspace)

    const memoryConfig = resolveProjectKnowledgeConfig(
      workspaceFolderPath,
      ports.getSpawnSettings().projectKnowledgeRoots,
      workspace.memory?.relativeRoot
    )
    const memoryRelativeRoot = memoryConfig?.relativeRoot ?? null
    const memoryStatus = memoryRelativeRoot
      ? await ports.memoryResolveRoot({
        workspaceRoot: memoryConfig?.projectRoot ?? workspaceFolderPath,
        relativeRoot: memoryRelativeRoot,
      }).catch((): MemoryRootStatus => ({
        ok: false,
        status: 'inaccessible',
        relativeRoot: memoryRelativeRoot,
        message: 'Unable to resolve workspace knowledge.',
      }))
      : null
    const memoryPrompt = memoryStatus
      ? memoryStatus.ok
        ? [
          `Knowledge Graph is configured at ${memoryStatus.relativeRoot}.`,
          'This is a repo-local Markdown knowledge graph for product, architecture, brand, and ecosystem context.',
          'Inspect it when relevant instead of assuming project context.',
          'Use the workspace-knowledge skill if it is installed in .agents/skills.',
        ].join(' ')
        : `Knowledge Graph is configured at ${memoryRelativeRoot}, but the folder is currently missing or inaccessible. Do not guess another knowledge folder.`
      : null
    const storedStartupPrompt = latestAgent?.cliStartupPrompt?.trim()
    const generatedStartupPrompt = prependAgentIdentifier(
      buildSprintEngineStartupPrompt(nextRun.role, nextRun.agentId, sprintEngineState.goal, {
        executionCwd,
        workspaceRoot: workspaceFolderPath,
        sprintEngineStatePath,
        rosterArgs: buildSprintEngineRosterCommandArgs(sprintEngineState),
        configuredRoles: sprintEngineState.configuredRoles,
        commandMode: getSprintEngineStartupCommandMode(nextRun.role, nextRun.agentId, sprintEngineState),
        // Asked of the SEAT, not the role name (MC-2057): the override tells the
        // agent that plans this run to proceed with conservative defaults under
        // artifact-approval automation. Gated on `role === 'architect'`, a
        // roleless coordinator — the planning seat of the default sprint kind —
        // never received it and stopped on exactly the questions that mode
        // exists to suppress. A named seat still answers for `architect-2`.
        autonomousPlanningOverride:
          isSprintEngineCoordinatorAgent(nextRun.agentId, sprintEngineState)
          && sprintEngineArtifactApprovalDesired(autoState),
        useWorktrees: sprintEngineState.useWorktrees === true,
      }),
      nextRun.label,
      getSprintEngineRoleLabel(nextRun.role)
    )
    const startupPrompt = [
      nextRun.startupPromptOverride ?? storedStartupPrompt ?? generatedStartupPrompt,
      memoryPrompt,
    ].filter(Boolean).join('\n\n')

    ports.updateAgent(workspace.id, nextRun.agentId, {
      name: nextRun.label,
      execution: {
        mode: executionMode,
        worktreeId: null,
        cwd: executionMode === 'worktree' ? executionCwd : null,
      },
      cliStartRequested: true,
      cliSessionId: sessionId,
      cliHasLaunched: true,
      cliOnboardingPromptSent: true,
      cliResumeAvailable: false,
      cliLastExitCode: undefined,
      cliLastExitedAt: undefined,
      cli: selectedCli,
      cliStartupPrompt: nextRun.startupPromptOverride || storedStartupPrompt ? latestAgent?.cliStartupPrompt : undefined,
      kind: 'sprintengine',
    })

    const terminalMetadata = {
      kind: 'agent',
      workspaceId: workspace.id,
      agentId: nextRun.agentId,
      // The retained conversation id from the window disposal; main renders
      // `--resume <cliSessionId>` when `resume` is set (works for captured
      // harness ids too, e.g. codex).
      ...(resumeToken ? { cliSessionId: resumeToken } : {}),
      executionMode,
      ...(executionMode === 'worktree' ? { worktreePath: executionCwd } : {}),
      cliPermissionPreset: getSprintEngineAutoState(workspace).cliPermissionPreset,
      cliModel: selectedCliModel,
      // The seat's reasoning-effort level (MC-1885), resolved from the same
      // runtime hierarchy as the model. Undefined renders no effort flag, so a
      // seat with no level spawns byte-identical argv to before.
      cliReasoning: selectedCliReasoning,
      memoryRootPath: memoryStatus?.ok ? memoryStatus.rootPath : undefined,
      memoryRelativeRoot: memoryRelativeRoot ?? undefined,
      mcpSettings,
      visible: options.revealPolicy === 'reveal',
      agentSession: {
        executionId: sessionId,
        system: 'sprintengine',
        workspaceId: workspace.id,
        workspaceRoot: workspace.folderPath,
        workId: nextRun.taskId,
        role: nextRun.role,
        displayName: latestAgent?.name ?? nextRun.label,
      },
    } as TerminalSpawnMetadata & {
      executionMode: 'current_workspace' | 'worktree'
      worktreePath?: string
    }

    const spawnResult = await spawnTerminalSession(ports, {
      sessionId,
      cols: BACKGROUND_TERMINAL_COLS,
      rows: BACKGROUND_TERMINAL_ROWS,
      cwd: executionCwd,
      resume: Boolean(resumeToken),
      sprintEngineStatePath,
      cli: selectedCli,
      initialPrompt: startupPrompt,
      cliRuntimes,
      shellOnly: false,
      metadata: terminalMetadata,
    })
    logPerfEvent('SprintEngineAutoRun', 'spawn-result', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId: nextRun.agentId,
      role: nextRun.role,
      taskId: nextRun.taskId,
      sessionId,
      ok: spawnResult.ok,
      elapsedMs: Math.round(performance.now() - startedAt),
      message: spawnResult.ok ? null : spawnResult.message,
    })
    if (!spawnResult.ok) {
      await recordSpawnFailure(ports, {
        workspaceId: workspace.id,
        workspaceName: workspace.name ?? '',
        agentId: nextRun.agentId,
        agentLabel: nextRun.label,
        selectedCli,
        cliPermissionPreset: getSprintEngineAutoState(workspace).cliPermissionPreset,
        taskId: nextRun.taskId,
        sessionId,
        executionCwd,
        sprintEngineStatePath,
        spawnMessage: spawnResult.message,
      })
      void ports.dispatchUpdateTerminalLaunchState(workspace.id, nextRun.agentId, {
        cliSessionId: null,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      return 'failed'
    }

    ports.updateAgent(workspace.id, nextRun.agentId, {
      cliStartupPrompt: undefined,
    })
    void ports.dispatchAssignTerminalSession(workspace.id, nextRun.agentId, sessionId, selectedCli)
    void ports.dispatchUpdateTerminalLaunchState(workspace.id, nextRun.agentId, {
      cliOnboardingPromptSent: true,
      cliResumeAvailable: false,
    })
    ports.applyTerminalRevealPolicy(
      workspace.id,
      nextRun.agentId,
      nextRun.label,
      options.revealPolicy ?? 'background',
      { sessionId },
    )
    return 'started'
  } finally {
    inFlightSpawns.current.delete(spawnKey)
  }
}

/**
 * Run-start bootstrap. The decision of *whether* anything needs a bootstrap
 * spawn is pure planner logic in `pickSprintEngineBootstrapCandidate`; this
 * wrapper owns the IPC side effects (terminal liveness check, diagnostics,
 * the actual spawn). All other spawning is work-driven and capped: ready
 * tasks through `pickNextAutoRuns`, notification
 * targets through `deliverAgentNotificationEvents`, and needs-input triage
 * through the planner-preference path (`signalPlannerForNeedsInputTriage`).
 */
async function ensureSprintEngineBootstrapAgent(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRef<Set<string>>
): Promise<'started' | 'failed' | 'none'> {
  if (!isSprintEngineRunnerActive(workspace) || !workspace.sprintEngineContext) return 'none'

  const decision = pickSprintEngineBootstrapCandidate(workspace, sprintEngineState, {
    runningAgentIds,
    inFlightSpawnKeys: inFlightSpawns.current,
  })
  const stallNoticeKey = `${workspace.id}:${workspace.sprintEngineContext.statePath}`

  if (decision.kind === 'stall') {
    logPerfEvent('SprintEngineAutoRun', 'bootstrap-stalled', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: decision.reason,
    })
    if (!cycleState.bootstrapStallNoticeKeys.has(stallNoticeKey)) {
      cycleState.bootstrapStallNoticeKeys.add(stallNoticeKey)
      await ports.publishDiagnostic({
        level: 'warning',
        source: 'sprintengine',
        title: decision.reason === 'no_planner'
          ? 'Automation has nothing to start'
          : 'Planner terminal exited before planning finished',
        message: decision.reason === 'no_planner'
          ? 'This run has no tasks yet and no planning agent (an architect, or a General) on the roster, so automation cannot create a plan.'
          : 'The run has no tasks yet and the planner terminal already exited. Automation does not respawn it automatically; spawn the planner from the board to continue planning.',
        details: [
          `Workspace: ${workspace.name}`,
          decision.reason === 'no_planner'
            ? 'Add an architect or a General to the roster, or create tasks, before enabling automation.'
            : 'Once the planner records tasks, agents spawn on their own when work becomes claimable.',
        ].join('\n'),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      })
    }
    return 'none'
  }
  if (decision.kind === 'none') return 'none'

  const currentAgent = workspace.agents[decision.candidate.agentId]
  if (currentAgent?.cliSessionId) {
    const status = await safeTerminalStatus(ports, currentAgent.cliSessionId)
    if (status.processAlive) return 'none'
  }

  logPerfEvent('SprintEngineAutoRun', 'bootstrap-spawn', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    agentId: decision.candidate.agentId,
    role: decision.candidate.role,
    taskCount: sprintEngineState.tasks.length,
  })
  const result = await spawnAutoRunCandidate(
    ports,
    workspace,
    sprintEngineState,
    decision.candidate,
    cliRuntimes,
    mcpSettings,
    inFlightSpawns,
    { missingCliNoticeKeys: cycleState.missingCliNoticeKeys },
  )
  if (result === 'failed') return 'failed'
  if (result === 'started') {
    cycleState.bootstrapStallNoticeKeys.delete(stallNoticeKey)
    runningAgentIds.add(decision.candidate.agentId)
    return 'started'
  }
  return 'none'
}

/**
 * Clear stale retained-resume state (MC-1444 review finding): a window
 * disposal keeps a resume token on the agent record while the owner still holds
 * its task, but once that task reaches `done` the agent is never respawned —
 * the stale token would leak into unrelated consumers of cliSessionId
 * (completed-run teardown records it as a resumable roster session, so a
 * board reopen would resume the finished task's conversation). Once the
 * bound task is done and no live session exists, the token is purposeless:
 * clear it so every later spawn is fresh.
 */
function clearStaleRetainedResumeState(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  liveAgentIds: ReadonlySet<string>
): void {
  for (const [agentId, agent] of Object.entries(workspace.agents)) {
    if (agent.kind !== 'sprintengine') continue
    if (!agent.cliResumeAvailable || !agent.cliSessionId || agent.cliStartRequested || agent.cliHasLaunched) continue
    if (liveAgentIds.has(agentId)) continue
    const lastOwnedTaskId = sprintEngineState.sprintEngineAgents[agentId]?.lastOwnedTaskId
    if (!lastOwnedTaskId) continue
    const lastOwned = sprintEngineState.tasks.find((candidate) => candidate.id === lastOwnedTaskId)
    if (!lastOwned || lastOwned.status !== 'done') continue
    ports.updateAgent(workspace.id, agentId, {
      cliSessionId: undefined,
      cliResumeAvailable: false,
    })
    void ports.dispatchUpdateTerminalLaunchState(workspace.id, agentId, {
      cliSessionId: null,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
    })
    logPerfEvent('SprintEngineAutoRun', 'stale-resume-retention-cleared', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId,
      taskId: lastOwnedTaskId,
    })
  }
}

/**
 * Planner preference (MC-1592): when planner-routed work exists (needs_input
 * triage), prefer re-engaging the most recent planning session — paste the
 * triage prompt into a live planner terminal, or resume/spawn the planner id —
 * before the pool pass spawns anything fresh. A scheduling preference, not a
 * pipeline stage: whatever this returns, the tick continues to the pool
 * reconcile, so triage can never suppress spawning.
 */
async function signalPlannerForNeedsInputTriage(
  ports: SprintEngineAutoRunCyclePorts,
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRef<Set<string>>,
  sentArchitectTriageMessages: MutableRef<Map<string, ArchitectTriageMessage>>,
  engagedThisPass: ReadonlySet<string>,
  missingCliNoticeKeys: Set<string>
): Promise<'started' | 'sent' | 'failed' | 'none'> {
  if (!workspace.folderPath || !workspace.sprintEngineContext) return 'none'

  const architectBlockers = getArchitectActionableNeedsInputTasks(sprintEngineState)
  if (architectBlockers.length === 0) return 'none'

  const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
  // The SEAT, not the role name (MC-2057). This lookup used to be
  // `candidate.role === 'architect'`, which a roleless roster can never satisfy
  // — so `architect`-KIND blockers on a roleless run were never triaged, and
  // because a needs_input task carries an owner, no dispatch/wake/revival path
  // re-engaged anyone either. Same two-step lookup the bootstrap path uses: the
  // deterministic seat id first, then any id the seat answers for, which is how
  // an older roster's `architect-2` still matches while a minted roleless
  // worker (`agent-1`) does not.
  const seat = sprintEngineCoordinatorSeat(sprintEngineState)
  const coordinator =
    roster.find((candidate) => candidate.id === seat.agentId)
    ?? roster.find((candidate) => isSprintEngineCoordinatorAgent(candidate.id, sprintEngineState))
  if (!coordinator) return 'none'

  // Triage lives outside the reconcile plan, so it must honour the plan's
  // per-agent dedup itself: a coordinator the plan engaged this pass (wake,
  // dispatch, notification, …) gets no triage prompt this tick, or the same
  // terminal would receive two contradictory instructions back to back.
  if (engagedThisPass.has(coordinator.id)) {
    logPerfEvent('SprintEngineAutoRun', 'architect-triage-deferred-engaged-coordinator', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId: coordinator.id,
      taskIds: architectBlockers.map((task) => task.id),
    })
    return 'none'
  }

  const spawnKey = `${workspace.id}:${coordinator.id}`
  const taskIds = architectBlockers.map((task) => task.id)
  // `architect` in these names and payloads is the needs_input KIND — a wire
  // value this epic deliberately does not rename — never the agent's role.
  const triagePrompt = buildArchitectNeedsInputTriagePrompt({
    workspaceFolderPath: workspace.folderPath,
    sprintEngineStatePath: workspace.sprintEngineContext.statePath,
    agentId: coordinator.id,
    taskIds,
  })
  const messageKey = architectTriageMessageKey(workspace, taskIds, coordinator.id)
  const previous = sentArchitectTriageMessages.current.get(messageKey)
  const retryPending = previous && Date.now() - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS
  const retryLimitReached = promptRetryLimitReached(previous)

  if (runningAgentIds.has(coordinator.id)) {
    ports.applyTerminalRevealPolicy(
      workspace.id,
      coordinator.id,
      workspace.agents[coordinator.id]?.name ?? coordinator.label,
      'background'
    )
    if (retryLimitReached) {
      logPerfEvent('SprintEngineAutoRun', 'architect-triage-prompt-retry-limit-reached', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: coordinator.id,
        taskIds,
        attempts: previous?.attempts ?? 0,
        maxRetries: AUTO_RUN_MAX_PROMPT_RETRIES,
      })
      return 'none'
    }
    if (retryPending) return 'none'

    const session = await findRunningAgentSession(ports, workspace, coordinator.id)
    if (!session) return 'none'

    await writeBracketedPrompt(ports, session.sessionId, triagePrompt)
    recordPromptRetry(sentArchitectTriageMessages.current, messageKey, Date.now())
    logPerfEvent('SprintEngineAutoRun', 'architect-triage-prompt-sent', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId: coordinator.id,
      taskIds,
      sessionId: session.sessionId,
    })
    return 'sent'
  }

  if (inFlightSpawns.current.has(spawnKey)) return 'none'

  const result = await spawnAutoRunCandidate(
    ports,
    workspace,
    sprintEngineState,
    {
      agentId: coordinator.id,
      label: workspace.agents[coordinator.id]?.name ?? coordinator.label,
      // The seat's role, absent on a roleless run — never the literal, which
      // spawned a roleless coordinator wearing a role it does not have.
      role: seat.role,
      taskId: architectBlockers[0].id,
      startupPromptOverride: triagePrompt,
    },
    cliRuntimes,
    mcpSettings,
    inFlightSpawns,
    { missingCliNoticeKeys },
  )
  if (result === 'failed') return 'failed'
  if (result === 'started') {
    runningAgentIds.add(coordinator.id)
    return 'started'
  }
  // 'skipped'/'missing_cli' → 'none': the tick re-attempts next pass, and the
  // decision layer dedupes the missing-CLI notice so a CLI-less planner no
  // longer re-publishes the diagnostic every ~4s.
  return 'none'
}

export async function superviseWorkspace(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  workspace: Workspace,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRef<Set<string>>,
  sentArtifactApprovalMessages: MutableRef<Map<string, number>>,
  autoApprovalDiagnostics: MutableRef<Map<string, number>>,
  sentContinuationMessages: MutableRef<Map<string, RoleContinuationMessage>>,
  sentDispatchMessages: MutableRef<Map<string, RoleContinuationMessage>>,
  sentArchitectTriageMessages: MutableRef<Map<string, ArchitectTriageMessage>>,
  sentAgentNotificationEvents: MutableRef<Set<string>>,
  projectionTokensByWorkspace: MutableRef<Map<string, string>>,
  idleClockByAgent: MutableRef<Map<string, number>>,
  retirementCooldownByAgent: MutableRef<Map<string, number>>
): Promise<void> {
  const superviseStartedAt = performance.now()
  let sprintEngineState = workspace.sprintEngineState
  const autoState = getSprintEngineAutoState(workspace)
  const automationMode = deriveAutomationMode(autoState)
  const runtimeState = normalizeSprintEngineAutomationRuntimeState(autoState.runtimeState, automationMode)
  const runnerActive = automationMode !== 'manual' && runtimeState === 'running'
  const approvalActive = automationMode === 'run_agents_and_approve_artifacts' && runtimeState === 'running'
  if ((!runnerActive && !approvalActive) || !workspace.folderPath || !sprintEngineState || !workspace.sprintEngineContext) return

  // Hard completion gate. A finished run (every task done) must never auto-spawn
  // agents — even when it was last left in an automation mode and the persisted
  // runtimeState defaulted back to 'running' on reopen. Deriving completion from
  // the live state here (rather than relying solely on the reactive projection
  // reconcile) closes the race where this 4s poll fires before
  // refreshSprintEngineWorkspaceProjection marks the run complete. Entering
  // dormancy flips the runtime to the terminal 'complete' state (leaving
  // desiredMode untouched — no swap to manual), so subsequent ticks skip the
  // workspace entirely (isSprintEngineRunnerActive then returns false), and tears
  // the run's agents down once — bound to this transition, not a follow-up poll,
  // because completion also stops the poller. Manual, user-initiated spawns go
  // through a separate path and are unaffected. We only reach here with
  // runtimeState === 'running' (the early return above guarantees it).
  if (enterDormancyIfRunComplete(ports, workspace, sprintEngineState)) {
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'run-complete',
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  logPerfEvent('SprintEngineAutoRun', 'supervise-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    taskCount: sprintEngineState.tasks.length,
    agentCount: Object.keys(sprintEngineState.sprintEngineAgents).length,
    automationMode,
    runtimeState,
    artifactApprovalDesired: sprintEngineArtifactApprovalDesired(autoState),
  })

  // The supervisor used to bridge local autoState into the run.yaml CLI-watch
  // polling flag here. That bridge was removed: local autoState is enough to
  // decide whether to spawn agents, and the CLI flag is the CLI's concern.

  if (approvalActive) {
    // Fail-soft (MC-1592): a broken auto-approval (e.g. an unreadable artifact)
    // logs a diagnostic and is skipped, so it never blocks agent dispatch this
    // tick — the runner stage below still runs against the same snapshot. Bind
    // the narrowed state to a const so the deferred closure keeps the non-null
    // type (the outer `let` is reassigned after a successful approval below).
    const approvalState = sprintEngineState
    const approvalResult = await runFailSoftStage(
      ports,
      workspace,
      'auto-approval',
      () => sendApprovalToNextEligibleArtifactProducer(
        ports,
        workspace,
        approvalState,
        sentArtifactApprovalMessages,
        autoApprovalDiagnostics,
        projectionTokensByWorkspace
      ),
      'none' as const
    )
    if (approvalResult === 'failed') return
    if (approvalResult === 'sent') {
      // sendApprovalToNextEligibleArtifactProducer applied the mutation projection
      // (or refreshed from disk when projection content was missing/malformed) and
      // updated the workspace store before returning. Pick up the fresh state.
      const refreshedWorkspace = ports.getWorkspace(workspace.id)
      if (!refreshedWorkspace || !refreshedWorkspace.sprintEngineState) return
      workspace = refreshedWorkspace
      sprintEngineState = refreshedWorkspace.sprintEngineState
      logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        reason: 'auto-approval-sent',
        elapsedMs: Math.round(performance.now() - superviseStartedAt),
      })
      return
    }
  }

  if (isSprintEngineRunBlockedOnExternalInput(sprintEngineState)) {
    const blockReason = describeSprintEngineExternalInputAutoRunBlock(sprintEngineState)
    ports.applyAutomationStopReason(workspace.id, 'blocked_on_external_input', blockReason)
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'blocked-on-external-input',
      blockedTaskIds: sprintEngineState.tasks
        .filter((task) => task.status === 'needs_input')
        .map((task) => task.id),
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  if (!runnerActive) {
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'artifact-approval-only',
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  try {
    await superviseRunnerActiveCycle(ports, cycleState, {
      workspace,
      sprintEngineState,
      autoState,
      superviseStartedAt,
      cliRuntimes,
      mcpSettings,
      inFlightSpawns,
      sentContinuationMessages,
      sentDispatchMessages,
      sentArchitectTriageMessages,
      sentAgentNotificationEvents,
      idleClockByAgent,
      retirementCooldownByAgent,
    })
  } catch (error) {
    if (error instanceof TerminalListIpcError) {
      await publishTerminalListIpcFailureNotice(ports, cycleState, workspace, error, 'supervise')
      return
    }
    throw error
  }
}

export type SprintEngineRunnerActiveCycleInput = {
  workspace: Workspace
  sprintEngineState: SprintEngineState
  autoState: SprintEngineAutoState
  superviseStartedAt: number
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>
  mcpSettings: McpSettings
  inFlightSpawns: MutableRef<Set<string>>
  sentContinuationMessages: MutableRef<Map<string, RoleContinuationMessage>>
  sentDispatchMessages: MutableRef<Map<string, RoleContinuationMessage>>
  sentArchitectTriageMessages: MutableRef<Map<string, ArchitectTriageMessage>>
  sentAgentNotificationEvents: MutableRef<Set<string>>
  /** Cross-tick idle observations for the idle_retire path; must persist across ticks or retirement never reaches its window. */
  idleClockByAgent: MutableRef<Map<string, number>>
  /**
   * Cross-tick record of recent retirements; must persist across ticks to
   * suppress the kill/respawn storm. Optional so single-path test shims can omit
   * it (no cooldown then); the production tick always threads the ref.
   */
  retirementCooldownByAgent?: MutableRef<Map<string, number>>
}

export async function superviseRunnerActiveCycle(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  input: SprintEngineRunnerActiveCycleInput
): Promise<void> {
  let {
    workspace,
    sprintEngineState,
    autoState,
    superviseStartedAt,
    cliRuntimes,
    mcpSettings,
    inFlightSpawns,
    sentContinuationMessages,
    sentDispatchMessages,
    sentArchitectTriageMessages,
    sentAgentNotificationEvents,
  } = input

  logPerfEvent('SprintEngineAutoRun', 'running-agents-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  })
  // One terminal-list snapshot for the whole supervise cycle: the running-id
  // scan, the idle-agent scan, and the dispatch executor's session
  // lookups all read the same set. Nothing between here and the
  // executor spawns or kills a terminal, so it cannot go stale for an agent the
  // cycle acts on (the executor's own spawns take their session from the spawn
  // result, not this snapshot).
  const cycleSessions = await listTerminalSessionsForAutoRun(ports, workspace, 'supervise-cycle')
  const agentSessions = await getRunningAutoRunAgentIds(ports, workspace, sprintEngineState, cycleSessions)
  const runningAgentIds = agentSessions.running
  const idleAgentIds = await getIdleAutoRunAgentIds(ports, workspace, sprintEngineState, cycleSessions)
  logPerfEvent('SprintEngineAutoRun', 'running-agents-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    runningAgentCount: runningAgentIds.size,
    idleAgentCount: idleAgentIds.size,
  })

  const idleClock = input.idleClockByAgent.current
  updateSprintEngineIdleClock({
    workspace,
    sprintEngineState,
    idleAgentIds,
    now: Date.now(),
    clock: idleClock,
  })

  // One reconcile pass for every re-engagement decision and recovery action:
  // notification deliveries (paste or spawn), durable-dispatch prompts,
  // ready-task wakes, active-assignment rescues, stalled
  // restarts, and dead-claimant respawns come from a single plan with
  // per-agent dedup (a terminal never gets two instructions — or a paste and
  // a kill — in one pass). It runs
  // before any path that can early-return the cycle, and before slot
  // accounting — dead in-progress owners consume the very slots spawn-side
  // recovery would need.
  const dispatchResult = await runFailSoftStage(
    ports,
    workspace,
    'recovery-and-dispatch',
    () => runSprintEngineDispatchPaths(ports, cycleState, {
      workspace,
      sprintEngineState,
      paths: ['notification', 'dispatch', 'task_wake', 'active_assignment', 'restart', 'respawn', 'idle_retire'],
      runningAgentIds,
      idleAgentIds,
      ledgers: { continuation: sentContinuationMessages, dispatch: sentDispatchMessages },
      notifications: {
        deliveredKeys: new Set(getSprintEngineAutoState(workspace).deliveredAgentNotificationEventKeys),
        sentKeys: sentAgentNotificationEvents.current,
        liveSessionAgentIds: agentSessions.live,
        canSpawnTargets: sprintEngineAutomationShouldRun(autoState),
      },
      spawnContext: {
        sprintEngineState,
        cliRuntimes,
        mcpSettings,
        inFlightSpawns,
        sentNotificationKeys: sentAgentNotificationEvents,
        onAgentSpawned: (agentId) => runningAgentIds.add(agentId),
      },
      idleClock,
      retirementCooldown: input.retirementCooldownByAgent,
      sessionsSnapshot: cycleSessions,
    }),
    { restarted: false, notificationSpawned: false, notificationSpawnFailed: false, engagedAgentIds: new Set<string>() as ReadonlySet<string> }
  )
  if (dispatchResult.notificationSpawnFailed) return

  // Planner preference (MC-1592): triage is a scheduling preference, not a
  // pipeline stage — whatever it did (pasted, spawned, failed, nothing), the
  // tick continues to the pool reconcile below. A failed triage spawn already
  // stopped the automation via recordSpawnFailure, which the per-spawn
  // automation re-check in the pool loop honours; nothing here may suppress
  // spawning for the rest of the tick.
  const plannerTriageSignal = await runFailSoftStage(
    ports,
    workspace,
    'planner-triage',
    () => signalPlannerForNeedsInputTriage(
      ports,
      workspace,
      sprintEngineState,
      runningAgentIds,
      cliRuntimes,
      mcpSettings,
      inFlightSpawns,
      sentArchitectTriageMessages,
      dispatchResult.engagedAgentIds,
      cycleState.missingCliNoticeKeys
    ),
    'none' as 'started' | 'sent' | 'failed' | 'none'
  )
  if (plannerTriageSignal !== 'none') {
    logPerfEvent('SprintEngineAutoRun', 'planner-triage-signal', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      signal: plannerTriageSignal,
      taskIds: getArchitectActionableNeedsInputTasks(sprintEngineState).map((task) => task.id),
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
  }

  clearStaleRetainedResumeState(ports, workspace, sprintEngineState, agentSessions.live)

  // Task-scoped worker capacity is no longer pre-minted by the engine (MC-1591
  // leases): the candidate picker below mints a fresh worker id for each
  // uncovered ready task and the engine binds it at claim, so there is no
  // roster-replenish round-trip to run before bootstrap and candidate picking.
  const bootstrapResult = await runFailSoftStage(
    ports,
    workspace,
    'bootstrap',
    () => ensureSprintEngineBootstrapAgent(
      ports,
      cycleState,
      workspace,
      sprintEngineState,
      runningAgentIds,
      cliRuntimes,
      mcpSettings,
      inFlightSpawns
    ),
    'none' as 'started' | 'failed' | 'none'
  )
  if (bootstrapResult === 'failed') return

  const hasArchitectOnRoster = buildSprintEngineAgentRosterForState(sprintEngineState)
    .some((candidate) => candidate.role === 'architect')
  const architectActionableNeedsInputOwnerIds = new Set(
    hasArchitectOnRoster
      ? getArchitectActionableNeedsInputTasks(sprintEngineState)
        .map((task) => task.ownerAgentId)
        .filter(Boolean) as string[]
      : []
  )

  const runningNeedsInputAgentIds = Object.entries(sprintEngineState.sprintEngineAgents)
    .filter(([, agent]) => agent.status === 'needs_input')
    .map(([agentId]) => agentId)
    .filter((agentId) => runningAgentIds.has(agentId))
    .filter((agentId) => !architectActionableNeedsInputOwnerIds.has(agentId))
  if (runningNeedsInputAgentIds.length > 0) {
    logPerfEvent('SprintEngineAutoRun', 'needs-input-agents-ignored-for-unrelated-work', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentIds: runningNeedsInputAgentIds,
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
  }

  const runningNeedsInputTaskIds = sprintEngineState.tasks
    .filter((task) =>
      task.status === 'needs_input'
      && Boolean(task.ownerAgentId)
      && runningAgentIds.has(task.ownerAgentId!)
      && (!hasArchitectOnRoster || !getArchitectActionableNeedsInputTasks(sprintEngineState).some((candidate) => candidate.id === task.id))
    )
    .map((task) => task.id)
  if (runningNeedsInputTaskIds.length > 0) {
    logPerfEvent('SprintEngineAutoRun', 'needs-input-tasks-ignored-for-unrelated-work', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskIds: runningNeedsInputTaskIds,
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
  }

  if (isCompletedSprintEngineRun(sprintEngineState)) {
    // Completion teardown (recording each resumable session, then removing the
    // run's agent panels) is owned by the projection-refresh reconcile, which
    // fires for every automation mode and on reopen. Here we only stop the
    // runner so this workspace is skipped on subsequent ticks.
    ports.applyAutomationStopReason(workspace.id, 'all_tasks_done')
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'all-tasks-done',
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  // Desired-pool demand (MC-1592/MC-1615): the reconciler's model of what work
  // wants sessions — ready, unowned, launchable tasks grouped by the demand key
  // ((role, repo) since MC-1610). Occupied sessions and
  // the concurrency cap are subtracted below; the picker fills the remainder,
  // grouping by the same key. Occupied = active leases (task owners) +
  // in-flight spawns (in-memory only) + live sessions folded in via
  // runningAgentIds.
  const demandByKey = computeSprintEngineDemand(sprintEngineState)

  // Booting pool workers: live sessions whose worker id the engine has not
  // bound yet (no runtime record before the first claim). The picker counts
  // them as per-key supply — the in-memory replacement for the retired
  // persisted pending-spawn ledger — and (MC-1750) they occupy concurrency
  // slots below: a spawned-but-unclaimed session is a real terminal, and not
  // counting it is what let a cap of 3 spawn 17 agents in tick-sized batches.
  const unboundLiveWorkers = cycleSessions
    .filter((session): session is TerminalSessionSnapshot & { agentId: string } =>
      Boolean(session.agentId)
      && sessionBelongsToWorkspaceSprintEngine(session, workspace)
      && !sprintEngineState.sprintEngineAgents[session.agentId!]
    )
    .map((session) => ({
      agentId: session.agentId,
      role: session.agentSession?.role ?? '',
      taskId: session.agentSession?.workId ?? null,
      // The repo this session was spawned into (MC-1610), recovered from its
      // worktree cwd. It keys the worker's group when its exemplar task is
      // gone, so a sibling-repo session is never counted as primary supply.
      repo: sprintEngineRepoIdForSessionCwd(sprintEngineState, workspace.folderPath, session.worktreePath),
    }))
  // Joined-but-never-claimed sessions (a runtime record exists from
  // `agent.join`, but no task was ever owned): also booting, also a slot.
  // A worker that HAS owned a task is deliberately excluded — a finished idle
  // terminal awaiting retirement must not starve fresh work of its slot.
  const joinedUnclaimedLiveAgentIds = cycleSessions
    .filter((session) => {
      if (!session.agentId || !sessionBelongsToWorkspaceSprintEngine(session, workspace)) return false
      const runtimeAgent = sprintEngineState.sprintEngineAgents[session.agentId]
      return Boolean(runtimeAgent) && !runtimeAgent.lastOwnedTaskId && !runtimeAgent.currentTaskId
    })
    .map((session) => session.agentId!)
  const occupiedAgentIds = getSprintEngineAutoRunOccupiedAgentIds({
    tasks: sprintEngineState.tasks,
    inFlightSpawnKeys: inFlightSpawns.current,
    workspaceId: workspace.id,
    runningAgentIds,
    bootingAgentIds: [
      ...unboundLiveWorkers.map((worker) => worker.agentId),
      ...joinedUnclaimedLiveAgentIds,
    ],
  })
  const maxConcurrentAgents = Math.max(1, Math.min(10, autoState.maxConcurrentAgents ?? 3))
  const availableSlots = maxConcurrentAgents - occupiedAgentIds.size
  logPerfEvent('SprintEngineAutoRun', 'slots', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    maxConcurrentAgents,
    availableSlots,
    occupiedAgentCount: occupiedAgentIds.size,
    bootingAgentCount: unboundLiveWorkers.length + joinedUnclaimedLiveAgentIds.length,
    demandGroups: demandByKey.size,
    demandByKey: Object.fromEntries([...demandByKey].map(([key, tasks]) => [key, tasks.length])),
  })
  if (availableSlots <= 0) {
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'no-slots',
      occupiedAgentCount: occupiedAgentIds.size,
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  let nextRuns: AutoRunCandidate[] = []
  try {
    nextRuns = pickNextAutoRuns(workspace, sprintEngineState, {
      limit: availableSlots,
      runningAgentIds,
      inFlightSpawns: inFlightSpawns.current,
      unboundLiveWorkers,
    })
  } catch (error) {
    logPerfEvent('SprintEngineAutoRun', 'candidate-pick-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      message: error instanceof Error ? error.message : String(error),
    })
    await ports.publishDiagnostic({
      level: 'warning',
      source: 'sprintengine',
      title: 'Roster runner skipped this tick',
      message: 'Could not choose the next sprintengine task to run.',
      details: [
        `Workspace: ${workspace.name}`,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        'Roster runner remains enabled.',
      ].join('\n'),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    })
    return
  }
  logPerfEvent('SprintEngineAutoRun', 'candidates', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    availableSlots,
    candidateCount: nextRuns.length,
    candidates: nextRuns.map((run) => ({
      agentId: run.agentId,
      role: run.role,
      taskId: run.taskId,
    })),
  })
  if (nextRuns.length === 0) {
    // superviseRunnerActiveCycle is only entered when the local automation is
    // on, so an empty candidate list means there's nothing to spawn this tick.
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'runtime-dispatch-no-spawn-candidates',
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  for (const nextRun of nextRuns) {
    const latestWorkspace = ports.getWorkspace(workspace.id)
    if (
      !latestWorkspace
      || !sprintEngineAutomationShouldRun(getSprintEngineAutoState(latestWorkspace))
    ) return
    const spawnResult = await spawnAutoRunCandidate(
      ports,
      latestWorkspace,
      sprintEngineState,
      nextRun,
      cliRuntimes,
      mcpSettings,
      inFlightSpawns,
      { missingCliNoticeKeys: cycleState.missingCliNoticeKeys }
    )
    if (spawnResult === 'failed') return
  }
}

export async function reconcileWorkspaceSessions(
  ports: SprintEngineAutoRunCyclePorts,
  cycleState: SprintEngineAutoRunCycleState,
  workspace: Workspace
): Promise<void> {
  let sessions: TerminalSessionSnapshot[]
  try {
    // The duplicate-session reconcile already lists every live terminal once.
    // Reuse that single snapshot for the per-agent liveness check below instead
    // of issuing one terminalStatus IPC round-trip per agent (N serial calls per
    // tick at scale). A session absent from the snapshot — or present with
    // processAlive false — is dead, matching terminalStatus for a missing/exited
    // session.
    sessions = await reconcileDuplicateAgentSessions(ports, workspace)
  } catch (error) {
    if (error instanceof TerminalListIpcError) {
      await publishTerminalListIpcFailureNotice(ports, cycleState, workspace, error, 'reconcile')
      return
    }
    throw error
  }

  const processAliveBySessionId = new Map(sessions.map((session) => [session.sessionId, session.processAlive]))

  for (const agent of Object.values(workspace.agents)) {
    if (!agent.cliStartRequested) continue

    if (!agent.cliSessionId) {
      if (agent.kind !== 'sprintengine') continue
      ports.updateAgent(workspace.id, agent.id, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      void ports.dispatchUpdateTerminalLaunchState(workspace.id, agent.id, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      continue
    }

    if (processAliveBySessionId.get(agent.cliSessionId)) continue

    ports.updateAgent(workspace.id, agent.id, {
      cliSessionId: undefined,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliLastExitCode: null,
      cliLastExitedAt: Date.now(),
      cliResumeAvailable: false,
    })
    void ports.dispatchUpdateTerminalLaunchState(workspace.id, agent.id, {
      cliSessionId: null,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
    })
  }
}
