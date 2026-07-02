import { useEffect, useRef, type MutableRefObject } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { workspaceSyncClient } from '../../store/workspaceSyncClient'
import type {
  AgentCli,
  CliRuntimeSettings,
  McpSettings,
  SprintEngineArtifact,
  SprintEngineAutoPendingSpawn,
  SprintEngineAutoState,
  SprintEngineRoleId,
  SprintEngineState,
  Workspace,
} from '../../types/workspace'
import { buildSprintEngineStartupPrompt, getSprintEngineStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
import {
  buildSprintEngineAgentRosterForState,
  buildSprintEngineRosterCommandArgs,
  getSprintEngineRoleLabel,
  isCompletedSprintEngineRun,
  isSprintEngineTaskLaunchable,
  normalizeSprintEngineProjection,
} from '../../utils/sprintengine'
import {
  AUTO_RUN_ROLE_CONTINUATION_RETRY_MS,
  AUTO_RUN_IDLE_RETIREMENT_MS as PLANNER_IDLE_RETIREMENT_MS,
  AUTO_RUN_RETIREMENT_COOLDOWN_MS,
  sprintEngineIdleClockKey,
  AUTO_RUN_MAX_PROMPT_RETRIES as PLANNER_MAX_PROMPT_RETRIES,
  AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES as PLANNER_MAX_WAKE_RETRIES,
  architectTriageMessageKey,
  artifactApprovalMessageKey,
  buildArchitectNeedsInputTriagePrompt,
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
  isSprintEngineAutoPendingSpawnStillRelevant,
  pickNextAutoRuns,
  pickSprintEngineBootstrapCandidate,
  type AutoRunCandidate,
  type RoleContinuationGrace,
} from '../../utils/sprintengineAutoRun'
import {
  TerminalListIpcError,
  createDefaultSprintEngineAutoRunExecutorPorts,
  listTerminalSessionsForAutoRun as executorListTerminalSessionsForAutoRun,
  publishTerminalListIpcFailureNotice as executorPublishTerminalListIpcFailureNotice,
  recordSpawnFailure,
  safeTerminalKill,
  safeTerminalStatus,
  spawnTerminalSession,
  writeBracketedPrompt,
  type SprintEngineAutoRunExecutorPorts,
  type TerminalListNoticeCooldown,
} from '../../utils/sprintengineAutoRunExecutor'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { pathJoin } from '../../utils/paths'
import { MULTICODE_DISABLE_SPRINTENGINE_AUTORUN } from '../../utils/runtimeFlags'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { isAgentTabVisible, type AgentTerminalRevealPolicy } from '../../utils/modelRegistry'
import { refreshSprintEngineWorkspaceProjection } from '../../utils/sprintengineProjectionRefresh'
import { registerTimer } from '../../utils/diagnostics/timerRegistry'
import { deriveSprintEngineAutomationMode } from '../../utils/sprintengineAutomation'
import {
  deriveSprintEngineAutomationDesiredMode,
  normalizeSprintEngineAutomationRuntimeState,
  sprintEngineAutomationShouldRun,
} from '../../utils/sprintengineAutomationLifecycle'
import {
  agentCliSupportsConversationResume,
} from '../../utils/agentCliResume'

export { TerminalListIpcError } from '../../utils/sprintengineAutoRunExecutor'

const defaultExecutorPorts: SprintEngineAutoRunExecutorPorts =
  createDefaultSprintEngineAutoRunExecutorPorts()
const terminalListIpcLastNoticeAt: TerminalListNoticeCooldown = new Map()

function sprintEngineArtifactApprovalDesired(autoState: Partial<SprintEngineAutoState> | null | undefined): boolean {
  return deriveSprintEngineAutomationDesiredMode(autoState) === 'run_agents_and_approve_artifacts'
}

export function listTerminalSessionsForAutoRun(
  workspace: Workspace,
  cause: string
): Promise<TerminalSessionSnapshot[]> {
  return executorListTerminalSessionsForAutoRun(defaultExecutorPorts, workspace, cause)
}

function publishTerminalListIpcFailureNotice(
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
    defaultExecutorPorts,
    workspace,
    error,
    phase,
    terminalListIpcLastNoticeAt,
  )
}

// SprintEngine is a background runner: agents do not need re-engagement within
// a couple of seconds, and every active tick does O(terminals) IPC plus planning
// on the renderer's main thread — the same thread that handles keystrokes and
// clicks. A 4s cadence halves that per-second cost (and the projection read it
// pairs with) for no user-visible loss in a long-running run.
const AUTO_RUN_POLL_MS = 4000
const INACTIVE_AUTO_RUN_POLL_MS = 15000
// Gentle background cadence for refreshing PR merge state on non-open workspaces.
const BACKGROUND_PR_SWEEP_MS = 600_000
const AUTO_RUN_STARTUP_SPAWN_DELAY_MS = 10000
const AUTO_RUN_PENDING_SPAWN_GRACE_MS = 60000
export const AUTO_RUN_MAX_PROMPT_RETRIES = PLANNER_MAX_PROMPT_RETRIES
export const AUTO_RUN_IDLE_RETIREMENT_MS = PLANNER_IDLE_RETIREMENT_MS
export { AUTO_RUN_RETIREMENT_COOLDOWN_MS }
export const AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES = PLANNER_MAX_WAKE_RETRIES
const ARTIFACT_AUTO_APPROVAL_RETRY_MS = 60000
const AUTO_APPROVAL_DIAGNOSTIC_COOLDOWN_MS = 30000
const BACKGROUND_TERMINAL_COLS = 100
const BACKGROUND_TERMINAL_ROWS = 30

type RunningContinuationCapacity = {
  capacityByRole: Map<SprintEngineRoleId, number>
  agentIds: Set<string>
}

type RoleContinuationMessage = SprintEngineDispatchAttempt

type ArchitectTriageMessage = {
  sentAt: number
  attempts?: number
}

const DEFAULT_AUTO_STATE: SprintEngineAutoState = {
  desiredMode: 'manual',
  runtimeState: 'idle',
  cliPermissionPreset: 'default',
  maxConcurrentAgents: 3,
  pendingSpawns: [],
  deliveredAgentNotificationEventKeys: [],
}

function getSprintEngineAutoState(workspace: Workspace | null | undefined): SprintEngineAutoState {
  return workspace?.sprintEngineAutoState ?? DEFAULT_AUTO_STATE
}

function isSprintEngineRunnerActive(workspace: Workspace | null | undefined): boolean {
  return sprintEngineAutomationShouldRun(getSprintEngineAutoState(workspace))
}

function isMatchingWorkspaceAgentSession(
  session: TerminalSessionSnapshot,
  workspace: Workspace,
  agentId: string
): boolean {
  if (
    !session.processAlive
    || session.kind !== 'agent'
    || session.workspaceId !== workspace.id
    || session.agentId !== agentId
    || (workspace.sprintEngineContext && session.sprintEngineStatePath !== workspace.sprintEngineContext.statePath)
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

async function refreshAutoWorkspaceState(
  workspace: Workspace,
  projectionTokensByWorkspace: MutableRefObject<Map<string, string>>,
  options: { force?: boolean } = {}
): Promise<SprintEngineState | null> {
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace,
    tokens: projectionTokensByWorkspace.current,
    cause: 'auto-run',
    force: options.force,
    ports: {
      readSprintEngineProjection: defaultExecutorPorts.readSprintEngineProjection,
      setSprintEngineState: defaultExecutorPorts.setSprintEngineState,
    },
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
  workspace: Workspace,
  artifact: SprintEngineArtifact,
  message: string,
  extraDetails: string[] = []
): Promise<void> {
  const task = workspace.sprintEngineState?.tasks.find((candidate) => candidate.id === artifact.taskId)

  await defaultExecutorPorts.publishDiagnostic({
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
  workspace: Workspace,
  diagnostics: MutableRefObject<Map<string, number>>,
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
  await defaultExecutorPorts.publishDiagnostic({
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

async function findRunningAgentSession(
  workspace: Workspace,
  agentId: string,
  prefetchedSessions?: TerminalSessionSnapshot[]
): Promise<TerminalSessionSnapshot | null> {
  const agent = workspace.agents[agentId]
  const sessions = prefetchedSessions
    ?? await listTerminalSessionsForAutoRun(workspace, `find-running:${agentId}`)
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
    await defaultExecutorPorts.publishDiagnostic({
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

  useWorkspaceStore.getState().updateAgent(workspace.id, agentId, {
    cliSessionId: runningSession.sessionId,
    cliStartRequested: true,
    cliHasLaunched: true,
    cliResumeAvailable: false,
    cli: effectiveCli,
    kind: 'sprintengine',
  })
  void workspaceSyncClient.dispatchAssignTerminalSession(workspace.id, agentId, runningSession.sessionId, effectiveCli)
  void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspace.id, agentId, {
    cliResumeAvailable: false,
  })
  return runningSession
}

function applyAutoApprovalProjectionContent(
  workspace: Workspace,
  projectionContent: unknown,
  projectionToken: unknown,
  projectionTokensByWorkspace: MutableRefObject<Map<string, string>>
): SprintEngineState | null {
  if (typeof projectionContent !== 'string') return null
  if (!workspace.sprintEngineContext) return null
  try {
    const projection = JSON.parse(projectionContent) as unknown
    const parsedState = normalizeSprintEngineProjection(projection, workspace.sprintEngineContext.teamSlug)
    if (!parsedState) return null
    useWorkspaceStore.getState().setSprintEngineState(workspace.id, parsedState)
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
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  sentArtifactApprovalMessages: MutableRefObject<Map<string, number>>,
  autoApprovalDiagnostics: MutableRefObject<Map<string, number>>,
  projectionTokensByWorkspace: MutableRefObject<Map<string, string>>
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
    const result = await defaultExecutorPorts.autoApproveSprintEngineArtifact(statePath, artifact.id)
    if (!result.ok) {
      await publishArtifactApprovalWarning(
        workspace,
        artifact,
        result.message || 'The sprint rejected the auto-approval.'
      )
      return 'none'
    }

    const projectionContent = (result.data as { projectionContent?: unknown } | undefined)?.projectionContent
    const projectionToken = (result.data as { projectionToken?: unknown } | undefined)?.projectionToken
    const appliedState = applyAutoApprovalProjectionContent(workspace, projectionContent, projectionToken, projectionTokensByWorkspace)
    if (!appliedState) {
      const refreshedState = await refreshAutoWorkspaceState(workspace, projectionTokensByWorkspace, { force: true })
      if (!refreshedState) {
        await publishArtifactApprovalWarning(
          workspace,
          artifact,
          'Could not refresh sprint state after auto-approving the artifact.'
        )
        return 'failed'
      }
    }

    await publishAutoApprovalDiagnostic(
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
    && session.workspaceId === workspace.id
    && (!workspace.sprintEngineContext || session.sprintEngineStatePath === workspace.sprintEngineContext.statePath)
  )
}

async function agentHasRunningProcess(workspace: Workspace, agentId: string): Promise<boolean> {
  return Boolean(await findRunningAgentSession(workspace, agentId))
}

async function getRunningAutoRunAgentIds(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  sessionsSnapshot?: TerminalSessionSnapshot[]
): Promise<{ running: Set<string>; live: Set<string> }> {
  const runningAgentIds = new Set<string>()
  // Every agent with a live session, including `done` runtime agents that
  // `running` excludes — completion notifications still paste into those.
  const liveAgentIds = new Set<string>()
  const sessions = sessionsSnapshot
    ?? await listTerminalSessionsForAutoRun(workspace, 'running-agent-ids')

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
      useWorkspaceStore.getState().updateAgent(workspace.id, session.agentId, {
        cliSessionId: session.sessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeAvailable: agentCliSupportsConversationResume(effectiveCli),
        cli: effectiveCli,
        kind: 'sprintengine',
      })
      void workspaceSyncClient.dispatchAssignTerminalSession(workspace.id, session.agentId, session.sessionId, effectiveCli)
    }
  }

  return { running: runningAgentIds, live: liveAgentIds }
}

async function getRunningContinuationCapacityByRole(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  sessionsSnapshot?: TerminalSessionSnapshot[]
): Promise<RunningContinuationCapacity> {
  const capacityByRole = new Map<SprintEngineRoleId, number>()
  const countedAgentIds = new Set<string>()
  const sessions = sessionsSnapshot
    ?? await listTerminalSessionsForAutoRun(workspace, 'role-continuation-capacity')

  // Index tasks once. The per-session loop previously ran two full
  // sprintEngineState.tasks.find() scans per session — O(sessions × tasks) — to
  // resolve the agent's current task and detect an owned active task. A by-id
  // map and an owner set make each session's checks O(1), i.e. O(sessions + tasks).
  const taskById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))
  const agentIdsOwningActiveTask = new Set<string>()
  for (const task of sprintEngineState.tasks) {
    if (task.ownerAgentId && (task.status === 'in_progress' || task.status === 'needs_input')) {
      agentIdsOwningActiveTask.add(task.ownerAgentId)
    }
  }

  for (const session of sessions) {
    if (!session.agentId || countedAgentIds.has(session.agentId)) continue
    if (!sessionBelongsToWorkspaceSprintEngine(session, workspace)) continue

    const runtimeAgent = sprintEngineState.sprintEngineAgents[session.agentId]
    if (!runtimeAgent || runtimeAgent.status === 'needs_input' || runtimeAgent.status === 'retired') continue

    const currentTask = runtimeAgent.currentTaskId
      ? taskById.get(runtimeAgent.currentTaskId)
      : null
    if (currentTask && currentTask.status !== 'done') continue

    if (agentIdsOwningActiveTask.has(session.agentId)) continue

    countedAgentIds.add(session.agentId)
    capacityByRole.set(runtimeAgent.role, (capacityByRole.get(runtimeAgent.role) ?? 0) + 1)
  }

  return { capacityByRole, agentIds: countedAgentIds }
}

/**
 * Test-surface shim over the planner's notification path. Note the contract
 * at this surface: `runningAgentIds` doubles as the live-session set, so a
 * done-status agent's completion paste only happens when the caller includes
 * it here. The production cycle instead passes the broader `live` session set
 * so completion notifications reach done agents' terminals.
 */
export async function deliverAgentNotificationEvents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>,
  sentAgentNotificationEvents: MutableRefObject<Set<string>>
): Promise<'started' | 'failed' | 'none'> {
  const result = await runSprintEngineDispatchPaths({
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
  continuation: MutableRefObject<Map<string, RoleContinuationMessage>> | null
  dispatch: MutableRefObject<Map<string, RoleContinuationMessage>> | null
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
  inFlightSpawns: MutableRefObject<Set<string>>
  /** Session-scoped delivered-notification cache; required to execute notification actions. */
  sentNotificationKeys?: MutableRefObject<Set<string>>
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
    await defaultExecutorPorts.publishDiagnostic({
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
    defaultExecutorPorts.markSprintEngineAgentNotificationDelivered(workspace.id, deliveryKey)
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
      ? await listTerminalSessionsForAutoRun(workspace, 'execute-dispatch-plan')
      : undefined)
  let notificationSpawned = false
  let notificationSpawnFailed = false
  for (const delivery of plan.notificationDeliveries) {
    if (delivery.kind === 'paste') {
      const session = await findRunningAgentSession(workspace, delivery.agentId, sessionsSnapshot)
      if (!session) {
        logPerfEvent('SprintEngineAutoRun', 'agent-notification-pending-no-session', { ...base, ...delivery.data })
        continue
      }
      await writeBracketedPrompt(defaultExecutorPorts, session.sessionId, delivery.prompt)
      if (!delivery.completion) {
        defaultExecutorPorts.applyTerminalRevealPolicy(
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
      { trackPendingSpawn: false }
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
    // 'skipped' leaves the event pending; it retries on the next tick.
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
    const session = await findRunningAgentSession(workspace, paste.agentId, sessionsSnapshot)
    if (!session) continue
    await writeBracketedPrompt(defaultExecutorPorts, session.sessionId, paste.prompt)
    const pasteLedger = dispatchPlanLedger(paste.ledger, ledgers)
    if (pasteLedger) recordPromptRetry(pasteLedger, paste.key, Date.now())
    logPerfEvent('SprintEngineAutoRun', paste.event, { ...base, ...paste.data, sessionId: session.sessionId })
  }
  let restarted = false
  for (const restart of plan.restarts) {
    const session = await findRunningAgentSession(workspace, restart.agentId, sessionsSnapshot)
    if (!session) continue
    await safeTerminalKill(defaultExecutorPorts, session.sessionId)
    // Reset the wake budget so the replacement terminal is never kill-looped
    // before it has a chance to claim.
    ledgers.continuation?.current.delete(restart.key)
    restarted = true
    await defaultExecutorPorts.publishDiagnostic({
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
      workspace,
      spawnContext.sprintEngineState,
      {
        agentId: respawn.agentId,
        label: respawn.label,
        role: respawn.role,
        taskId: respawn.taskId,
        ...(respawn.gateId ? { gateId: respawn.gateId } : {}),
      },
      spawnContext.cliRuntimes,
      spawnContext.mcpSettings,
      spawnContext.inFlightSpawns,
      { trackPendingSpawn: false }
    )
    // 'skipped' means a live session or in-flight spawn already covers this
    // agent — no budget consumed. Started and failed attempts both count
    // against the respawn cap so a broken CLI cannot spawn/exit loop.
    if (result === 'skipped') {
      logPerfEvent('SprintEngineAutoRun', 'dead-claimant-respawn-skipped', { ...base, ...respawn.data })
      continue
    }
    const respawnLedger = ledgers.continuation?.current
    if (respawnLedger) recordPromptRetry(respawnLedger, respawn.key, Date.now())
    if (result === 'failed') {
      logPerfEvent('SprintEngineAutoRun', 'dead-claimant-respawn-failed', { ...base, ...respawn.data })
      continue
    }
    await defaultExecutorPorts.publishDiagnostic({
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
    // longer the visible one.
    if (
      useWorkspaceStore.getState().activeWorkspaceId === workspace.id
      && isAgentTabVisible(workspace.id, retirement.agentId)
    ) {
      logPerfEvent('SprintEngineAutoRun', 'idle-retirement-skipped-visible-tab', { ...base, ...retirement.data })
      continue
    }
    const session = await findRunningAgentSession(workspace, retirement.agentId, sessionsSnapshot)
    if (!session) continue
    await safeTerminalKill(defaultExecutorPorts, session.sessionId)
    // Clear the agent's launch flags after the kill. The kill alone is not
    // enough: a mounted-but-unfocused AgentPanel keeps
    // `hasStarted` true off `cliStartRequested`, so its TerminalView respawns
    // the PTY before the next tick — the clock never sees a gap and the agent
    // is retired again every tick (an idle-retirement storm).
    defaultExecutorPorts.updateAgent(workspace.id, retirement.agentId, {
      cliSessionId: undefined,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
    })
    void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspace.id, retirement.agentId, {
      cliSessionId: null,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
    })
    await defaultExecutorPorts.publishDiagnostic({
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

async function runSprintEngineDispatchPaths(input: {
  workspace: Workspace
  sprintEngineState: SprintEngineState
  paths: SprintEngineDispatchPath[]
  runningAgentIds: ReadonlySet<string>
  idleAgentIds: ReadonlySet<string>
  ledgers: SprintEngineDispatchLedgers
  spawnContext?: SprintEngineDispatchSpawnContext
  notifications?: SprintEngineDispatchNotificationInput
  idleClock?: ReadonlyMap<string, number>
  retirementCooldown?: MutableRefObject<Map<string, number>>
  /** Shared per-cycle terminal snapshot; reused for the executor's session lookups so the cycle issues one terminalList instead of several. */
  sessionsSnapshot?: TerminalSessionSnapshot[]
}): Promise<SprintEngineDispatchExecution> {
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
  })
  return executeSprintEngineDispatchPlan(
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
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: ReadonlySet<string>,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>,
  spawnDeps: {
    cliRuntimes: Record<AgentCli, CliRuntimeSettings>
    mcpSettings: McpSettings
    inFlightSpawns: MutableRefObject<Set<string>>
  }
): Promise<void> {
  await runSprintEngineDispatchPaths({
    workspace,
    sprintEngineState,
    paths: ['respawn'],
    runningAgentIds,
    idleAgentIds: continuationCapacity.agentIds,
    ledgers: { continuation: sentContinuationMessages, dispatch: null },
    spawnContext: { sprintEngineState, ...spawnDeps },
  })
}

export async function sendContinuationPromptsToIdleAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<void> {
  await runSprintEngineDispatchPaths({
    workspace,
    sprintEngineState,
    paths: ['task_wake'],
    runningAgentIds: new Set(),
    idleAgentIds: continuationCapacity.agentIds,
    ledgers: { continuation: sentContinuationMessages, dispatch: null },
  })
}

export async function escalateStalledLiveIdleAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<'restarted' | 'none'> {
  const result = await runSprintEngineDispatchPaths({
    workspace,
    sprintEngineState,
    paths: ['restart'],
    runningAgentIds: new Set(),
    idleAgentIds: continuationCapacity.agentIds,
    ledgers: { continuation: sentContinuationMessages, dispatch: null },
  })
  return result.restarted ? 'restarted' : 'none'
}

export async function sendGateContinuationPromptsToAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<void> {
  await runSprintEngineDispatchPaths({
    workspace,
    sprintEngineState,
    paths: ['gate'],
    runningAgentIds,
    idleAgentIds: continuationCapacity.agentIds,
    ledgers: { continuation: sentContinuationMessages, dispatch: null },
  })
}

export async function sendDispatchPromptsToRunningAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  sentDispatchMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<void> {
  await runSprintEngineDispatchPaths({
    workspace,
    sprintEngineState,
    paths: ['dispatch'],
    runningAgentIds,
    idleAgentIds: new Set(),
    ledgers: { continuation: null, dispatch: sentDispatchMessages },
  })
}

async function reconcileDuplicateAgentSessions(workspace: Workspace): Promise<TerminalSessionSnapshot[]> {
  const sessions = await listTerminalSessionsForAutoRun(workspace, 'reconcile-duplicates')
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
        .map((session) => safeTerminalKill(defaultExecutorPorts, session.sessionId))
    )

    const agent = workspace.agents[agentId]
    if (agent?.cliSessionId !== preferredSession.sessionId || !agent?.cliStartRequested) {
      const effectiveCli = preferredSession.cli ?? agent?.cli
      if (!effectiveCli) continue
      useWorkspaceStore.getState().updateAgent(workspace.id, agentId, {
        cliSessionId: preferredSession.sessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeAvailable: agentCliSupportsConversationResume(effectiveCli),
        cli: effectiveCli,
        kind: 'sprintengine',
      })
      void workspaceSyncClient.dispatchAssignTerminalSession(workspace.id, agentId, preferredSession.sessionId, effectiveCli)
    }
  }

  return sessions
}

function setAutoRunPendingSpawns(workspaceId: string, pendingSpawns: SprintEngineAutoPendingSpawn[]): void {
  useWorkspaceStore.getState().setSprintEngineAutoPendingSpawns(workspaceId, pendingSpawns)
}

function addAutoRunPendingSpawn(workspaceId: string, pending: SprintEngineAutoPendingSpawn): void {
  const state = useWorkspaceStore.getState()
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
  const current = getSprintEngineAutoState(workspace).pendingSpawns
  state.setSprintEngineAutoPendingSpawns(workspaceId, [
    ...current.filter((candidate) =>
      candidate.taskId !== pending.taskId && candidate.agentId !== pending.agentId
    ),
    pending,
  ])
}

async function reconcileAutoRunPendingSpawns(
  workspace: Workspace,
  sprintEngineState: SprintEngineState
): Promise<SprintEngineAutoPendingSpawn[]> {
  const pendingSpawns = getSprintEngineAutoState(workspace).pendingSpawns
  if (pendingSpawns.length === 0) return []

  const activePendingSpawns: SprintEngineAutoPendingSpawn[] = []
  let changed = false

  for (const pending of pendingSpawns) {
    const pendingTask = sprintEngineState.tasks.find((task) => task.id === pending.taskId)
    const pendingTaskStillReady = pendingTask
      ? pending.gateId
        ? isSprintEngineAutoPendingSpawnStillRelevant(pending, pendingTask, sprintEngineState.tasks)
        : isSprintEngineTaskLaunchable(pendingTask, sprintEngineState)
      : false
    const pendingAgent = workspace.agents[pending.agentId]
    const pendingAgentHasProcess = await agentHasRunningProcess(workspace, pending.agentId)
    const pendingStartedAt = pending.startedAt ?? 0
    const pendingStillInGrace = Date.now() - pendingStartedAt < AUTO_RUN_PENDING_SPAWN_GRACE_MS

    if (pendingTaskStillReady && (pendingAgentHasProcess || pendingStillInGrace)) {
      activePendingSpawns.push(pending)
      continue
    }

    changed = true
    if (pendingAgent && pendingAgent.cliStartRequested && !pendingAgentHasProcess) {
      useWorkspaceStore.getState().updateAgent(workspace.id, pending.agentId, {
        cliSessionId: undefined,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspace.id, pending.agentId, {
        cliSessionId: null,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
    }
  }

  if (changed) setAutoRunPendingSpawns(workspace.id, activePendingSpawns)
  return activePendingSpawns
}

export async function spawnAutoRunCandidate(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  nextRun: AutoRunCandidate,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>,
  options: { trackPendingSpawn?: boolean; revealPolicy?: AgentTerminalRevealPolicy } = {}
): Promise<'started' | 'failed' | 'skipped'> {
  const currentState = useWorkspaceStore.getState()
  const currentWorkspace = currentState.workspaces.find((candidate) => candidate.id === workspace.id)
  const currentAgent = currentWorkspace?.agents[nextRun.agentId]
  const selectedCli = currentAgent?.cli
  const sessionId = crypto.randomUUID()
  const spawnKey = `${workspace.id}:${nextRun.agentId}`
  if (inFlightSpawns.current.has(spawnKey)) return 'skipped'

  if (!workspace.folderPath || !workspace.sprintEngineContext) return 'skipped'
  if (!selectedCli) {
    await defaultExecutorPorts.publishDiagnostic({
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
    return 'failed'
  }
  const workspaceFolderPath = workspace.folderPath
  const sprintEngineStatePath = workspace.sprintEngineContext.statePath
  const pendingSpawn = {
    taskId: nextRun.taskId,
    ...(nextRun.gateId ? { gateId: nextRun.gateId } : {}),
    agentId: nextRun.agentId,
    startedAt: Date.now(),
  }
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
    })
    const folderExists = await defaultExecutorPorts.pathExists(workspaceFolderPath)
    if (!folderExists) {
      currentState.setFolderMissing(workspace.id, true)
      setAutoRunPendingSpawns(workspace.id, [])
      defaultExecutorPorts.applyAutomationStopReason(workspace.id, 'folder_missing', {
        agentId: nextRun.agentId,
        taskId: nextRun.taskId,
      })
      await defaultExecutorPorts.publishDiagnostic({
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

    const latestStateBeforeSpawn = useWorkspaceStore.getState()
    const latestAgent = latestStateBeforeSpawn
      .workspaces.find((candidate) => candidate.id === workspace.id)
      ?.agents[nextRun.agentId]
    if (latestAgent?.cliSessionId) {
      const status = await safeTerminalStatus(defaultExecutorPorts, latestAgent.cliSessionId)
      if (status.processAlive) return 'skipped'
      latestStateBeforeSpawn.updateAgent(workspace.id, nextRun.agentId, {
        cliSessionId: undefined,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspace.id, nextRun.agentId, {
        cliSessionId: null,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
    } else if (latestAgent?.cliStartRequested) {
      latestStateBeforeSpawn.updateAgent(workspace.id, nextRun.agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspace.id, nextRun.agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
    }

    let executionCwd = workspaceFolderPath
    let executionMode: 'current_workspace' | 'worktree' = 'current_workspace'
    // Worktree mode: route every agent terminal into the one shared run
    // worktree so all agents work and commit in the same isolated checkout.
    const runWorktree = sprintEngineState.vcs
    if (runWorktree?.mode === 'run_worktree' && runWorktree.worktreePath) {
      executionCwd = pathJoin(workspaceFolderPath, runWorktree.worktreePath)
      executionMode = 'worktree'
    }
    const autoState = getSprintEngineAutoState(workspace)

    const memoryConfig = resolveProjectKnowledgeConfig(
      workspaceFolderPath,
      useWorkspaceStore.getState().appSettings.projectKnowledgeRoots,
      workspace.memory.relativeRoot
    )
    const memoryRelativeRoot = memoryConfig?.relativeRoot ?? null
    const memoryStatus = memoryRelativeRoot
      ? await defaultExecutorPorts.memoryResolveRoot({
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
        commandMode: getSprintEngineStartupCommandMode(nextRun.role, nextRun.agentId, sprintEngineState),
        autonomousPlanningOverride: nextRun.role === 'architect' && sprintEngineArtifactApprovalDesired(autoState),
        useWorktrees: sprintEngineState.useWorktrees === true,
        claimTool: nextRun.gateId ? 'sprintengine.gate.next' : 'sprintengine.task.next',
      }),
      nextRun.label,
      getSprintEngineRoleLabel(nextRun.role)
    )
    const startupPrompt = [
      nextRun.startupPromptOverride ?? storedStartupPrompt ?? generatedStartupPrompt,
      memoryPrompt,
    ].filter(Boolean).join('\n\n')

    if (options.trackPendingSpawn !== false) addAutoRunPendingSpawn(workspace.id, pendingSpawn)
    currentState.updateAgent(workspace.id, nextRun.agentId, {
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
      executionMode,
      ...(executionMode === 'worktree' ? { worktreePath: executionCwd } : {}),
      cliPermissionPreset: getSprintEngineAutoState(workspace).cliPermissionPreset,
      cliModel: currentAgent?.cliModel,
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

    const spawnResult = await spawnTerminalSession(defaultExecutorPorts, {
      sessionId,
      cols: BACKGROUND_TERMINAL_COLS,
      rows: BACKGROUND_TERMINAL_ROWS,
      cwd: executionCwd,
      resume: false,
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
      await recordSpawnFailure(defaultExecutorPorts, {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
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
      void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspace.id, nextRun.agentId, {
        cliSessionId: null,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      return 'failed'
    }

    currentState.updateAgent(workspace.id, nextRun.agentId, {
      cliStartupPrompt: undefined,
    })
    void workspaceSyncClient.dispatchAssignTerminalSession(workspace.id, nextRun.agentId, sessionId, selectedCli)
    void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspace.id, nextRun.agentId, {
      cliOnboardingPromptSent: true,
      cliResumeAvailable: false,
    })
    defaultExecutorPorts.applyTerminalRevealPolicy(
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

// One stall notice per run store, so a bootstrap stall (no architect, or the
// architect terminal exited before planning) surfaces once instead of every
// supervision tick. Cleared when a bootstrap spawn later succeeds.
const bootstrapStallNoticeKeys = new Set<string>()

/**
 * Run-start bootstrap. The decision of *whether* anything needs a bootstrap
 * spawn is pure planner logic in `pickSprintEngineBootstrapCandidate`; this
 * wrapper owns the IPC side effects (terminal liveness check, diagnostics,
 * the actual spawn). All other spawning is work-driven and capped: ready
 * tasks, rework, and quality gates through `pickNextAutoRuns`, notification
 * targets through `deliverAgentNotificationEvents`, and needs-input triage
 * through `signalArchitectForNeedsInputTriage`.
 */
async function ensureSprintEngineBootstrapAgent(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>
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
    if (!bootstrapStallNoticeKeys.has(stallNoticeKey)) {
      bootstrapStallNoticeKeys.add(stallNoticeKey)
      await defaultExecutorPorts.publishDiagnostic({
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
    const status = await safeTerminalStatus(defaultExecutorPorts, currentAgent.cliSessionId)
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
    workspace,
    sprintEngineState,
    decision.candidate,
    cliRuntimes,
    mcpSettings,
    inFlightSpawns,
    { trackPendingSpawn: false }
  )
  if (result === 'failed') return 'failed'
  if (result === 'started') {
    bootstrapStallNoticeKeys.delete(stallNoticeKey)
    runningAgentIds.add(decision.candidate.agentId)
    return 'started'
  }
  return 'none'
}

async function replenishRetiredRosterCapacity(
  workspace: Workspace,
  sprintEngineState: SprintEngineState
): Promise<
  | { status: 'changed'; workspace: Workspace; sprintEngineState: SprintEngineState }
  | { status: 'failed' | 'none' }
> {
  // Roster replenishment is supervisor work — it should run based on local
  // automation state, not the headless CLI watch-polling flag in run.yaml.
  if (!workspace.sprintEngineContext) return { status: 'none' }
  if (deriveSprintEngineAutomationMode(getSprintEngineAutoState(workspace)) === 'manual') return { status: 'none' }
  const hasRetiredAgent = Object.values(sprintEngineState.sprintEngineAgents)
    .some((agent) => agent.status === 'retired')
  if (!hasRetiredAgent) return { status: 'none' }

  const result = await defaultExecutorPorts.replenishSprintEngineRoster({
    statePath: workspace.sprintEngineContext.statePath,
  })
  if (!result.ok) {
    await defaultExecutorPorts.publishDiagnostic({
      level: 'warning',
      source: 'sprintengine',
      title: 'Roster replenishment failed',
      message: result.message,
      details: result.stderr || result.stdout,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    })
    return { status: 'failed' }
  }

  const projectionContent = (result.data as { projectionContent?: unknown } | undefined)?.projectionContent
  if (typeof projectionContent !== 'string') return { status: 'none' }
  const projection = JSON.parse(projectionContent) as unknown
  const parsedState = normalizeSprintEngineProjection(projection, workspace.sprintEngineContext.teamSlug)
  if (!parsedState) return { status: 'none' }
  useWorkspaceStore.getState().setSprintEngineState(workspace.id, parsedState)
  const updatedWorkspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
  const created = ((result.data as { tool?: { created?: unknown[] } } | undefined)?.tool?.created ?? []).length
  logPerfEvent('SprintEngineAutoRun', 'roster-replenish', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    created,
  })
  if (created <= 0 || !updatedWorkspace?.sprintEngineState) return { status: 'none' }
  return { status: 'changed', workspace: updatedWorkspace, sprintEngineState: updatedWorkspace.sprintEngineState }
}

async function signalArchitectForNeedsInputTriage(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  pendingSpawns: SprintEngineAutoPendingSpawn[],
  runningAgentIds: Set<string>,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>,
  sentArchitectTriageMessages: MutableRefObject<Map<string, ArchitectTriageMessage>>,
  engagedThisPass: ReadonlySet<string>
): Promise<'started' | 'sent' | 'failed' | 'none'> {
  if (!workspace.folderPath || !workspace.sprintEngineContext) return 'none'

  const architectBlockers = getArchitectActionableNeedsInputTasks(sprintEngineState)
  if (architectBlockers.length === 0) return 'none'

  const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
  const architect = roster.find((candidate) => candidate.role === 'architect')
  if (!architect) return 'none'

  // Triage lives outside the reconcile plan, so it must honour the plan's
  // per-agent dedup itself: an architect the plan engaged this pass (wake,
  // dispatch, notification, …) gets no triage prompt this tick, or the same
  // terminal would receive two contradictory instructions back to back.
  if (engagedThisPass.has(architect.id)) {
    logPerfEvent('SprintEngineAutoRun', 'architect-triage-deferred-engaged-architect', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId: architect.id,
      taskIds: architectBlockers.map((task) => task.id),
    })
    return 'none'
  }

  const spawnKey = `${workspace.id}:${architect.id}`
  const architectPending = pendingSpawns.some((pending) => pending.agentId === architect.id)
  const taskIds = architectBlockers.map((task) => task.id)
  const triagePrompt = buildArchitectNeedsInputTriagePrompt({
    workspaceFolderPath: workspace.folderPath,
    sprintEngineStatePath: workspace.sprintEngineContext.statePath,
    taskIds,
  })
  const messageKey = architectTriageMessageKey(workspace, taskIds, architect.id)
  const previous = sentArchitectTriageMessages.current.get(messageKey)
  const retryPending = previous && Date.now() - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS
  const retryLimitReached = promptRetryLimitReached(previous)

  if (runningAgentIds.has(architect.id)) {
    defaultExecutorPorts.applyTerminalRevealPolicy(
      workspace.id,
      architect.id,
      workspace.agents[architect.id]?.name ?? architect.label,
      'background'
    )
    if (retryLimitReached) {
      logPerfEvent('SprintEngineAutoRun', 'architect-triage-prompt-retry-limit-reached', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: architect.id,
        taskIds,
        attempts: previous?.attempts ?? 0,
        maxRetries: AUTO_RUN_MAX_PROMPT_RETRIES,
      })
      return 'none'
    }
    if (retryPending) return 'none'

    const session = await findRunningAgentSession(workspace, architect.id)
    if (!session) return 'none'

    await writeBracketedPrompt(defaultExecutorPorts, session.sessionId, triagePrompt)
    recordPromptRetry(sentArchitectTriageMessages.current, messageKey, Date.now())
    logPerfEvent('SprintEngineAutoRun', 'architect-triage-prompt-sent', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId: architect.id,
      taskIds,
      sessionId: session.sessionId,
    })
    return 'sent'
  }

  if (architectPending || inFlightSpawns.current.has(spawnKey)) return 'none'

  const result = await spawnAutoRunCandidate(
    workspace,
    sprintEngineState,
    {
      agentId: architect.id,
      label: workspace.agents[architect.id]?.name ?? architect.label,
      role: 'architect',
      taskId: architectBlockers[0].id,
      startupPromptOverride: triagePrompt,
    },
    cliRuntimes,
    mcpSettings,
    inFlightSpawns,
    { trackPendingSpawn: false }
  )
  if (result === 'failed') return 'failed'
  if (result === 'started') {
    runningAgentIds.add(architect.id)
    return 'started'
  }
  return 'none'
}

async function superviseWorkspace(
  workspace: Workspace,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>,
  sentArtifactApprovalMessages: MutableRefObject<Map<string, number>>,
  autoApprovalDiagnostics: MutableRefObject<Map<string, number>>,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>,
  sentDispatchMessages: MutableRefObject<Map<string, RoleContinuationMessage>>,
  sentArchitectTriageMessages: MutableRefObject<Map<string, ArchitectTriageMessage>>,
  sentAgentNotificationEvents: MutableRefObject<Set<string>>,
  continuationGraceByTask: MutableRefObject<Map<string, RoleContinuationGrace>>,
  projectionTokensByWorkspace: MutableRefObject<Map<string, string>>,
  idleClockByAgent: MutableRefObject<Map<string, number>>,
  retirementCooldownByAgent: MutableRefObject<Map<string, number>>
): Promise<void> {
  const superviseStartedAt = performance.now()
  let sprintEngineState = workspace.sprintEngineState
  const autoState = getSprintEngineAutoState(workspace)
  const automationMode = deriveSprintEngineAutomationMode(autoState, sprintEngineState?.runner)
  const runtimeState = normalizeSprintEngineAutomationRuntimeState(autoState.runtimeState, automationMode)
  const runnerActive = automationMode !== 'manual' && runtimeState === 'running'
  const approvalActive = automationMode === 'run_agents_and_approve_artifacts' && runtimeState === 'running'
  if ((!runnerActive && !approvalActive) || !workspace.folderPath || !sprintEngineState || !workspace.sprintEngineContext) return

  // Hard completion gate. A finished run (every task done) must never auto-spawn
  // agents — even when it was last left in an automation mode and the persisted
  // runtimeState defaulted back to 'running' on reopen. Deriving completion from
  // the live state here (rather than relying solely on the reactive projection
  // reconcile) closes the race where this 4s poll fires before
  // refreshSprintEngineWorkspaceProjection marks the run complete. We also fire
  // `runner_complete` so the runtime flips to the terminal 'complete' state
  // (leaving desiredMode untouched — no swap to manual), which makes subsequent
  // ticks skip the workspace entirely (isSprintEngineRunnerActive then returns
  // false), so this fires at most once. Manual, user-initiated agent spawns go
  // through a separate path and are unaffected by this gate. We only reach here
  // with runtimeState === 'running' (the early return above guarantees it).
  if (isCompletedSprintEngineRun(sprintEngineState)) {
    useWorkspaceStore.getState().applySprintEngineAutomationEvent(workspace.id, {
      type: 'runner_complete',
      message: 'All tasks are complete.',
    })
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
    const approvalResult = await sendApprovalToNextEligibleArtifactProducer(
      workspace,
      sprintEngineState,
      sentArtifactApprovalMessages,
      autoApprovalDiagnostics,
      projectionTokensByWorkspace
    )
    if (approvalResult === 'failed') return
    if (approvalResult === 'sent') {
      // sendApprovalToNextEligibleArtifactProducer applied the mutation projection
      // (or refreshed from disk when projection content was missing/malformed) and
      // updated the workspace store before returning. Pick up the fresh state.
      const refreshedWorkspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
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
    defaultExecutorPorts.applyAutomationStopReason(workspace.id, 'blocked_on_external_input', blockReason)
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
    await superviseRunnerActiveCycle({
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
      continuationGraceByTask,
      idleClockByAgent,
      retirementCooldownByAgent,
    })
  } catch (error) {
    if (error instanceof TerminalListIpcError) {
      await publishTerminalListIpcFailureNotice(workspace, error, 'supervise')
      return
    }
    throw error
  }
}

type RunnerActiveCycleInput = {
  workspace: Workspace
  sprintEngineState: SprintEngineState
  autoState: SprintEngineAutoState
  superviseStartedAt: number
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>
  mcpSettings: McpSettings
  inFlightSpawns: MutableRefObject<Set<string>>
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
  sentDispatchMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
  sentArchitectTriageMessages: MutableRefObject<Map<string, ArchitectTriageMessage>>
  sentAgentNotificationEvents: MutableRefObject<Set<string>>
  continuationGraceByTask: MutableRefObject<Map<string, RoleContinuationGrace>>
  /** Cross-tick idle observations for the idle_retire path; must persist across ticks or retirement never reaches its window. */
  idleClockByAgent: MutableRefObject<Map<string, number>>
  /**
   * Cross-tick record of recent retirements; must persist across ticks to
   * suppress the kill/respawn storm. Optional so single-path test shims can omit
   * it (no cooldown then); the production tick always threads the ref.
   */
  retirementCooldownByAgent?: MutableRefObject<Map<string, number>>
}

export async function superviseRunnerActiveCycle(input: RunnerActiveCycleInput): Promise<void> {
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
    continuationGraceByTask,
  } = input

  logPerfEvent('SprintEngineAutoRun', 'reconcile-pending-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    pendingSpawnCount: autoState.pendingSpawns.length,
  })
  const pendingSpawns = await reconcileAutoRunPendingSpawns(workspace, sprintEngineState)
  logPerfEvent('SprintEngineAutoRun', 'reconcile-pending-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    pendingSpawnCount: pendingSpawns.length,
  })

  logPerfEvent('SprintEngineAutoRun', 'running-agents-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  })
  // One terminal-list snapshot for the whole supervise cycle: the running-id
  // scan, the continuation-capacity scan, and the dispatch executor's session
  // lookups all read the same set. Taken after pending-spawn reconciliation so
  // it reflects terminals spawned this tick; nothing between here and the
  // executor spawns or kills a terminal, so it cannot go stale for an agent the
  // cycle acts on (the executor's own spawns take their session from the spawn
  // result, not this snapshot).
  const cycleSessions = await listTerminalSessionsForAutoRun(workspace, 'supervise-cycle')
  const agentSessions = await getRunningAutoRunAgentIds(workspace, sprintEngineState, cycleSessions)
  const runningAgentIds = agentSessions.running
  const continuationCapacity = await getRunningContinuationCapacityByRole(workspace, sprintEngineState, cycleSessions)
  logPerfEvent('SprintEngineAutoRun', 'running-agents-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    runningAgentCount: runningAgentIds.size,
    continuationCapacity: Object.fromEntries(continuationCapacity.capacityByRole),
  })

  const idleClock = input.idleClockByAgent.current
  updateSprintEngineIdleClock({
    workspace,
    sprintEngineState,
    idleAgentIds: continuationCapacity.agentIds,
    now: Date.now(),
    clock: idleClock,
  })

  // One reconcile pass for every re-engagement decision and recovery action:
  // notification deliveries (paste or spawn), durable-dispatch prompts,
  // ready-task wakes, gate continuations, active-assignment rescues, stalled
  // restarts, and dead-claimant respawns come from a single plan with
  // per-agent dedup (a terminal never gets two instructions — or a paste and
  // a kill — in one pass). It runs
  // before any path that can early-return the cycle, and before slot
  // accounting — dead in-progress owners consume the very slots spawn-side
  // recovery would need.
  const dispatchResult = await runSprintEngineDispatchPaths({
    workspace,
    sprintEngineState,
    paths: ['notification', 'dispatch', 'task_wake', 'gate', 'active_assignment', 'restart', 'respawn', 'idle_retire'],
    runningAgentIds,
    idleAgentIds: continuationCapacity.agentIds,
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
  })
  if (dispatchResult.notificationSpawnFailed) return

  const architectTriageSignal = await signalArchitectForNeedsInputTriage(
    workspace,
    sprintEngineState,
    pendingSpawns,
    runningAgentIds,
    cliRuntimes,
    mcpSettings,
    inFlightSpawns,
    sentArchitectTriageMessages,
    dispatchResult.engagedAgentIds
  )
  if (architectTriageSignal === 'failed') return
  if (architectTriageSignal === 'started' || architectTriageSignal === 'sent') {
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: architectTriageSignal === 'started'
        ? 'architect-needs-input-triage-started'
        : 'architect-needs-input-triage-sent',
      taskIds: getArchitectActionableNeedsInputTasks(sprintEngineState).map((task) => task.id),
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  const replenishResult = await replenishRetiredRosterCapacity(workspace, sprintEngineState)
  if (replenishResult.status === 'failed') return
  if (replenishResult.status === 'changed') {
    workspace = replenishResult.workspace
    sprintEngineState = replenishResult.sprintEngineState
    logPerfEvent('SprintEngineAutoRun', 'roster-replenished-continuing', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentCount: Object.keys(sprintEngineState.sprintEngineAgents).length,
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
  }

  const bootstrapResult = await ensureSprintEngineBootstrapAgent(
    workspace,
    sprintEngineState,
    runningAgentIds,
    cliRuntimes,
    mcpSettings,
    inFlightSpawns
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
    defaultExecutorPorts.applyAutomationStopReason(workspace.id, 'all_tasks_done')
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'all-tasks-done',
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  const occupiedAgentIds = getSprintEngineAutoRunOccupiedAgentIds({
    tasks: sprintEngineState.tasks,
    pendingSpawns,
    inFlightSpawnKeys: inFlightSpawns.current,
    workspaceId: workspace.id,
    runningAgentIds,
  })
  const maxConcurrentAgents = Math.max(1, Math.min(10, autoState.maxConcurrentAgents ?? 3))
  const availableSlots = maxConcurrentAgents - occupiedAgentIds.size
  logPerfEvent('SprintEngineAutoRun', 'slots', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    maxConcurrentAgents,
    availableSlots,
    occupiedAgentCount: occupiedAgentIds.size,
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
      pendingSpawns,
      runningAgentIds,
      inFlightSpawns: inFlightSpawns.current,
      continuationCapacityByRole: continuationCapacity.capacityByRole,
      continuationGraceByTask: continuationGraceByTask.current,
    })
  } catch (error) {
    logPerfEvent('SprintEngineAutoRun', 'candidate-pick-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      message: error instanceof Error ? error.message : String(error),
    })
    await defaultExecutorPorts.publishDiagnostic({
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
    const latestWorkspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
    if (
      !latestWorkspace
      || !sprintEngineAutomationShouldRun(getSprintEngineAutoState(latestWorkspace))
    ) return
    const spawnResult = await spawnAutoRunCandidate(
      latestWorkspace,
      sprintEngineState,
      nextRun,
      cliRuntimes,
      mcpSettings,
      inFlightSpawns
    )
    if (spawnResult === 'failed') return
  }
}

async function reconcileWorkspaceSessions(workspace: Workspace): Promise<void> {
  let sessions: TerminalSessionSnapshot[]
  try {
    // The duplicate-session reconcile already lists every live terminal once.
    // Reuse that single snapshot for the per-agent liveness check below instead
    // of issuing one terminalStatus IPC round-trip per agent (N serial calls per
    // tick at scale). A session absent from the snapshot — or present with
    // processAlive false — is dead, matching terminalStatus for a missing/exited
    // session.
    sessions = await reconcileDuplicateAgentSessions(workspace)
  } catch (error) {
    if (error instanceof TerminalListIpcError) {
      await publishTerminalListIpcFailureNotice(workspace, error, 'reconcile')
      return
    }
    throw error
  }

  const processAliveBySessionId = new Map(sessions.map((session) => [session.sessionId, session.processAlive]))

  for (const agent of Object.values(workspace.agents)) {
    if (!agent.cliStartRequested) continue

    if (!agent.cliSessionId) {
      if (agent.kind !== 'sprintengine') continue
      useWorkspaceStore.getState().updateAgent(workspace.id, agent.id, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspace.id, agent.id, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      continue
    }

    if (processAliveBySessionId.get(agent.cliSessionId)) continue

    useWorkspaceStore.getState().updateAgent(workspace.id, agent.id, {
      cliSessionId: undefined,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliLastExitCode: null,
      cliLastExitedAt: Date.now(),
      cliResumeAvailable: false,
    })
    void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspace.id, agent.id, {
      cliSessionId: null,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
    })
  }
}

export default function SprintEngineAutoRunSupervisor() {
  const inFlightSpawns = useRef(new Set<string>())
  const sentArtifactApprovalMessages = useRef(new Map<string, number>())
  const autoApprovalDiagnostics = useRef(new Map<string, number>())
  const sentContinuationMessages = useRef(new Map<string, RoleContinuationMessage>())
  const sentDispatchMessages = useRef(new Map<string, RoleContinuationMessage>())
  const sentArchitectTriageMessages = useRef(new Map<string, ArchitectTriageMessage>())
  const sentAgentNotificationEvents = useRef(new Set<string>())
  const continuationGraceByTask = useRef(new Map<string, RoleContinuationGrace>())
  const idleClockByAgent = useRef(new Map<string, number>())
  const retirementCooldownByAgent = useRef(new Map<string, number>())
  const projectionTokensByWorkspace = useRef(new Map<string, string>())
  const lastInactiveTickByWorkspace = useRef(new Map<string, number>())
  const startedAt = useRef(Date.now())
  const tickInProgress = useRef(false)

  useEffect(() => {
    if (MULTICODE_DISABLE_SPRINTENGINE_AUTORUN) {
      console.info('[SprintEngineAutoRun] disabled by runtime flag')
      return
    }

    let disposed = false

    const tick = async () => {
      if (tickInProgress.current) return
      tickInProgress.current = true

      try {
        const tickStartedAt = performance.now()
        const { workspaces, appSettings, activeWorkspaceId } = useWorkspaceStore.getState()
        const now = Date.now()
        const autoWorkspaces = workspaces.filter((workspace) =>
          isSprintEngineRunnerActive(workspace)
        ).filter((workspace) => {
          if (workspace.id === activeWorkspaceId) return true

          const lastTick = lastInactiveTickByWorkspace.current.get(workspace.id) ?? 0
          if (now - lastTick < INACTIVE_AUTO_RUN_POLL_MS) return false
          lastInactiveTickByWorkspace.current.set(workspace.id, now)
          return true
        })

        lastInactiveTickByWorkspace.current.forEach((_, workspaceId) => {
          if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
            lastInactiveTickByWorkspace.current.delete(workspaceId)
          }
        })
        logPerfEvent('SprintEngineAutoRun', 'tick-start', {
          activeWorkspaceId,
          autoWorkspaceCount: autoWorkspaces.length,
          autoWorkspaces: autoWorkspaces.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            enabled: isSprintEngineRunnerActive(workspace),
            automationMode: deriveSprintEngineAutomationMode(getSprintEngineAutoState(workspace), workspace.sprintEngineState?.runner),
            runnerCliWatchPolling: workspace.sprintEngineState?.runner?.cliWatchPolling ?? null,
            runtimeState: getSprintEngineAutoState(workspace).runtimeState ?? null,
            artifactApprovalDesired: sprintEngineArtifactApprovalDesired(getSprintEngineAutoState(workspace)),
          })),
        })

        const eligibleWorkspaceIds = new Set(autoWorkspaces.map((workspace) => workspace.id))
        const refreshedState = useWorkspaceStore.getState()
        for (const workspace of refreshedState.workspaces.filter((candidate) => eligibleWorkspaceIds.has(candidate.id))) {
          if (disposed) return
          await reconcileWorkspaceSessions(workspace)
        }

        const cleanedState = useWorkspaceStore.getState()
        const startupSpawnDelayElapsed = Date.now() - startedAt.current >= AUTO_RUN_STARTUP_SPAWN_DELAY_MS
        for (const workspace of cleanedState.workspaces.filter((candidate) => eligibleWorkspaceIds.has(candidate.id))) {
          if (disposed) return
          if (!startupSpawnDelayElapsed) continue
          await superviseWorkspace(
            workspace,
            appSettings.cliRuntimes,
            appSettings.mcp,
            inFlightSpawns,
            sentArtifactApprovalMessages,
            autoApprovalDiagnostics,
            sentContinuationMessages,
            sentDispatchMessages,
            sentArchitectTriageMessages,
            sentAgentNotificationEvents,
            continuationGraceByTask,
            projectionTokensByWorkspace,
            idleClockByAgent,
            retirementCooldownByAgent
          )
        }
        logPerfEvent('SprintEngineAutoRun', 'tick-end', {
          elapsedMs: Math.round(performance.now() - tickStartedAt),
          autoWorkspaceCount: autoWorkspaces.length,
        })
      } finally {
        tickInProgress.current = false
      }
    }

    const timer = registerTimer('SprintEngine auto-run poll', AUTO_RUN_POLL_MS)
    const runTick = () => {
      const startedAt = performance.now()
      void Promise.resolve(tick()).finally(() => timer.recordTick(performance.now() - startedAt))
    }
    runTick()
    const interval = window.setInterval(runTick, AUTO_RUN_POLL_MS)

    return () => {
      disposed = true
      timer.unregister()
      window.clearInterval(interval)
    }
  }, [])

  // Background pull-request merge sweep. The open run-summary polls the active
  // workspace every 30s; this gentle 10-minute sweep keeps the sidebar run glyph
  // (outline = not merged, filled = merged) honest for runs whose summary isn't
  // open. It only touches completed worktree runs with a non-terminal PR, skips
  // the active workspace (already polled), and stops once a run is merged/closed.
  useEffect(() => {
    let disposed = false
    const sweep = async () => {
      const store = useWorkspaceStore.getState()
      const activeId = store.activeWorkspaceId
      for (const workspace of store.workspaces) {
        if (disposed) return
        if (workspace.id === activeId) continue
        if (workspace.mode !== 'sprintengine') continue
        const statePath = workspace.sprintEngineContext?.statePath
        const vcs = workspace.sprintEngineState?.vcs
        if (!statePath || !vcs) continue
        if (vcs.pullRequestState === 'merged' || vcs.pullRequestState === 'closed') continue
        const tasks = workspace.sprintEngineState?.tasks ?? []
        const completed = tasks.length > 0 && tasks.every((task) => task.status === 'done')
        if (!completed && !vcs.pullRequestUrl) continue
        try {
          const result = await window.api.refreshSprintEnginePullRequestStatus(statePath)
          if (disposed || !result.ok) continue
          await refreshSprintEngineWorkspaceProjection({
            workspace,
            tokens: new Map(),
            cause: 'manual',
            force: true,
          })
        } catch {
          // Best-effort: a transient gh/git failure just retries next sweep.
        }
      }
    }
    void sweep()
    const interval = window.setInterval(() => void sweep(), BACKGROUND_PR_SWEEP_MS)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [])

  return null
}
