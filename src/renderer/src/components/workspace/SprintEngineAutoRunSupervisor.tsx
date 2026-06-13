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
  getSprintEngineTaskBoardColumn,
  isSprintEngineTaskLaunchable,
  normalizeSprintEngineProjection,
} from '../../utils/sprintengine'
import {
  agentNotificationDeliveryKey,
  architectTriageMessageKey,
  artifactApprovalMessageKey,
  buildAgentNotificationPrompt,
  buildArchitectNeedsInputTriagePrompt,
  buildSprintEngineDispatchPrompt,
  buildSprintEngineContinuationPrompt,
  buildSprintEngineGateContinuationPrompt,
  continuationMessageKey,
  describeSprintEngineExternalInputAutoRunBlock,
  describeNeedsInputAutoApprovalState,
  isAgentNotificationCompletionEvent,
  sprintEngineDispatchDeliveryKey,
  getActiveSprintEngineAutoRunGateClaims,
  getArchitectActionableNeedsInputTasks,
  getAutoApprovalIntentArtifacts,
  getSprintEngineAutoRunOccupiedAgentIds,
  getClaimableSprintEngineAutoRunGates,
  getPendingAgentNotificationEvents,
  getSprintEngineWakeCandidateTasks,
  findSprintEngineWakeCandidateTaskForAgent,
  isSprintEngineRunBlockedOnExternalInput,
  isSprintEngineAutoPendingSpawnStillRelevant,
  pickNextAutoRuns,
  pickSprintEngineBootstrapCandidate,
  type AutoRunCandidate,
  type RoleContinuationGrace,
} from '../../utils/sprintengineAutoRun'
import {
  TerminalListIpcError,
  closeSprintEngineRunAgentTerminals,
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
import { type AgentTerminalRevealPolicy } from '../../utils/modelRegistry'
import {
  refreshSprintEngineWorkspaceProjection,
  sprintEngineProjectionSignature,
} from '../../utils/sprintengineProjectionRefresh'
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

const AUTO_RUN_POLL_MS = 2000
const INACTIVE_AUTO_RUN_POLL_MS = 15000
const AUTO_RUN_STARTUP_SPAWN_DELAY_MS = 10000
const AUTO_RUN_PENDING_SPAWN_GRACE_MS = 60000
const AUTO_RUN_ROLE_CONTINUATION_RETRY_MS = 60000
const AUTO_RUN_DISPATCH_PROMPT_RETRY_MS = 300000
export const AUTO_RUN_MAX_PROMPT_RETRIES = 5
export const AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES = 3
const ARTIFACT_AUTO_APPROVAL_RETRY_MS = 60000
const AUTO_APPROVAL_DIAGNOSTIC_COOLDOWN_MS = 30000
const BACKGROUND_TERMINAL_COLS = 100
const BACKGROUND_TERMINAL_ROWS = 30
const SPAWNABLE_NOTIFICATION_KINDS = new Set([
  'task_resume_requested',
  'task_changes_requested_after_artifact_review',
])

type RunningContinuationCapacity = {
  capacityByRole: Map<SprintEngineRoleId, number>
  agentIds: Set<string>
}

type RoleContinuationMessage = {
  sentAt: number
  attempts?: number
}

type ArchitectTriageMessage = {
  sentAt: number
  attempts?: number
}

const DEFAULT_AUTO_STATE: SprintEngineAutoState = {
  desiredMode: 'manual',
  runtimeState: 'idle',
  keepDoneAgentTerminals: false,
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
  lastContentByWorkspace: MutableRefObject<Map<string, string>>,
  options: { force?: boolean } = {}
): Promise<SprintEngineState | null> {
  const result = await refreshSprintEngineWorkspaceProjection({
    workspace,
    signatures: lastContentByWorkspace.current,
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
      `Sprint Engine state: ${workspace.sprintEngineContext?.statePath ?? 'Unavailable'}`,
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
      `Sprint Engine state: ${workspace.sprintEngineContext?.statePath ?? 'Unavailable'}`,
      ...(input.details ?? []),
    ].join('\n'),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    agentId: input.agentId,
    taskId: input.taskId,
    sessionId: input.sessionId,
  })
}

async function findRunningAgentSession(
  workspace: Workspace,
  agentId: string
): Promise<TerminalSessionSnapshot | null> {
  const agent = workspace.agents[agentId]
  const sessions = await listTerminalSessionsForAutoRun(workspace, `find-running:${agentId}`)
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
      message: 'Running Sprint Engine terminal is missing its CLI selection.',
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
  lastContentByWorkspace: MutableRefObject<Map<string, string>>
): SprintEngineState | null {
  if (typeof projectionContent !== 'string') return null
  if (!workspace.sprintEngineContext) return null
  try {
    const projection = JSON.parse(projectionContent) as unknown
    const parsedState = normalizeSprintEngineProjection(projection, workspace.sprintEngineContext.teamSlug)
    if (!parsedState) return null
    useWorkspaceStore.getState().setSprintEngineState(workspace.id, parsedState)
    // Keep the projection-watcher signature in sync so the disk reader does not
    // immediately re-apply the same state on its next tick.
    lastContentByWorkspace.current.set(workspace.id, sprintEngineProjectionSignature(projection))
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
  lastContentByWorkspace: MutableRefObject<Map<string, string>>
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
        result.message || 'Sprint Engine rejected the auto-approval.'
      )
      return 'none'
    }

    const projectionContent = (result.data as { projectionContent?: unknown } | undefined)?.projectionContent
    const appliedState = applyAutoApprovalProjectionContent(workspace, projectionContent, lastContentByWorkspace)
    if (!appliedState) {
      const refreshedState = await refreshAutoWorkspaceState(workspace, lastContentByWorkspace, { force: true })
      if (!refreshedState) {
        await publishArtifactApprovalWarning(
          workspace,
          artifact,
          'Could not refresh Sprint Engine state after auto-approving the artifact.'
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
        title: 'Artifact auto-approved through Sprint Engine',
        message: 'Sprint Engine recorded the approval and refreshed projection state.',
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
  sprintEngineState: SprintEngineState
): Promise<Set<string>> {
  const runningAgentIds = new Set<string>()
  const sessions = await listTerminalSessionsForAutoRun(workspace, 'running-agent-ids')

  for (const session of sessions) {
    if (!session.agentId || !sessionBelongsToWorkspaceSprintEngine(session, workspace)) continue
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

  return runningAgentIds
}

async function getRunningContinuationCapacityByRole(
  workspace: Workspace,
  sprintEngineState: SprintEngineState
): Promise<RunningContinuationCapacity> {
  const capacityByRole = new Map<SprintEngineRoleId, number>()
  const countedAgentIds = new Set<string>()
  const sessions = await listTerminalSessionsForAutoRun(workspace, 'role-continuation-capacity')

  for (const session of sessions) {
    if (!session.agentId || countedAgentIds.has(session.agentId)) continue
    if (!sessionBelongsToWorkspaceSprintEngine(session, workspace)) continue

    const runtimeAgent = sprintEngineState.sprintEngineAgents[session.agentId]
    if (!runtimeAgent || runtimeAgent.status === 'needs_input' || runtimeAgent.status === 'retired') continue

    const currentTask = runtimeAgent.currentTaskId
      ? sprintEngineState.tasks.find((task) => task.id === runtimeAgent.currentTaskId)
      : null
    if (currentTask && currentTask.status !== 'done') continue

    const ownedActiveTask = sprintEngineState.tasks.find((task) =>
      task.ownerAgentId === session.agentId
      && (task.status === 'in_progress' || task.status === 'needs_input')
    )
    if (ownedActiveTask) continue

    countedAgentIds.add(session.agentId)
    capacityByRole.set(runtimeAgent.role, (capacityByRole.get(runtimeAgent.role) ?? 0) + 1)
  }

  return { capacityByRole, agentIds: countedAgentIds }
}

function promptRetryLimitReached(
  message: RoleContinuationMessage | ArchitectTriageMessage | undefined,
  maxRetries = AUTO_RUN_MAX_PROMPT_RETRIES
): boolean {
  return (message?.attempts ?? 0) >= maxRetries
}

function recordPromptRetry<T extends RoleContinuationMessage | ArchitectTriageMessage>(
  messages: Map<string, T>,
  key: string,
  sentAt: number
): void {
  const previous = messages.get(key)
  messages.set(key, {
    sentAt,
    attempts: (previous?.attempts ?? 0) + 1,
  } as T)
}

function runtimeAgentAlreadyOwnsDispatchTarget(
  runtimeAgent: SprintEngineState['sprintEngineAgents'][string],
  dispatch: NonNullable<SprintEngineState['sprintEngineAgents'][string]['currentDispatch']>
): boolean {
  if (runtimeAgent.status !== 'running') return false
  if (!dispatch.taskId || runtimeAgent.currentTaskId !== dispatch.taskId) return false
  if (dispatch.targetKind === 'task') return true
  if (dispatch.targetKind !== 'gate') return false

  const currentGate = runtimeAgent.currentGate
  return Boolean(
    dispatch.gateId
    && (
      (
        currentGate
        && currentGate.taskId === dispatch.taskId
        && currentGate.gateId === dispatch.gateId
        && (!dispatch.attemptId || currentGate.attemptId === dispatch.attemptId)
      )
      || (!dispatch.attemptId && runtimeAgent.currentGateId === dispatch.gateId)
    )
  )
}

function runtimeAgentAlreadyOwnsGateClaim(
  runtimeAgent: SprintEngineState['sprintEngineAgents'][string] | undefined,
  taskId: string,
  gateId: string,
  attemptId: string | null | undefined
): boolean {
  if (!runtimeAgent || runtimeAgent.status !== 'running') return false
  if (runtimeAgent.currentTaskId !== taskId) return false

  const currentGate = runtimeAgent.currentGate
  return Boolean(
    (
      currentGate
      && currentGate.taskId === taskId
      && currentGate.gateId === gateId
      && (!attemptId || currentGate.attemptId === attemptId)
    )
    || (!currentGate && runtimeAgent.currentGateId === gateId)
  )
}

function getContinuationMessageWorkKey(workspace: Workspace, key: string): string | null {
  const prefix = `${workspace.id}:${workspace.sprintEngineContext?.statePath ?? ''}:`
  if (!key.startsWith(prefix)) return null
  const agentSeparatorIndex = key.lastIndexOf(':')
  if (agentSeparatorIndex <= prefix.length) return null
  return key.slice(prefix.length, agentSeparatorIndex)
}

export async function deliverAgentNotificationEvents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>,
  sentAgentNotificationEvents: MutableRefObject<Set<string>>
): Promise<'started' | 'failed' | 'none'> {
  const events = getPendingAgentNotificationEvents(
    workspace,
    sprintEngineState,
    new Set(getSprintEngineAutoState(workspace).deliveredAgentNotificationEventKeys),
    sentAgentNotificationEvents.current
  )
  if (events.length === 0) return 'none'

  let started = false
  const rosterById = new Map(buildSprintEngineAgentRosterForState(sprintEngineState).map((agent) => [agent.id, agent]))
  for (const event of events) {
    const targetAgentId = event.targetAgentId
    if (!targetAgentId) continue
    const deliveryKey = agentNotificationDeliveryKey(workspace, event)
    const runtimeAgent = sprintEngineState.sprintEngineAgents[targetAgentId]
    if (runtimeAgent?.status === 'retired') {
      sentAgentNotificationEvents.current.add(deliveryKey)
      useWorkspaceStore.getState().markSprintEngineAgentNotificationDelivered(workspace.id, deliveryKey)
      logPerfEvent('SprintEngineAutoRun', 'agent-notification-skipped-retired', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        eventId: event.id,
        agentId: targetAgentId,
        taskId: event.taskId ?? null,
        notificationKind: event.notificationKind ?? null,
      })
      continue
    }
    const rosterAgent = rosterById.get(targetAgentId)
    const role = rosterAgent?.role ?? runtimeAgent?.role
    const prompt = buildAgentNotificationPrompt(event, {
      agentId: targetAgentId,
      role,
    })
    const session = await findRunningAgentSession(workspace, targetAgentId)
    if (session) {
      if (event.taskId && runtimeAgent?.currentTaskId && runtimeAgent.currentTaskId !== event.taskId) {
        logPerfEvent('SprintEngineAutoRun', 'agent-notification-skipped-active-different-task', {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          eventId: event.id,
          agentId: targetAgentId,
          eventTaskId: event.taskId,
          activeTaskId: runtimeAgent.currentTaskId,
          notificationKind: event.notificationKind ?? null,
        })
        continue
      }
      await writeBracketedPrompt(defaultExecutorPorts, session.sessionId, prompt)
      if (!isAgentNotificationCompletionEvent(event)) {
        defaultExecutorPorts.applyTerminalRevealPolicy(
          workspace.id,
          targetAgentId,
          workspace.agents[targetAgentId]?.name ?? rosterAgent?.label ?? targetAgentId,
          'background',
          { sessionId: session.sessionId }
        )
      }
      sentAgentNotificationEvents.current.add(deliveryKey)
      useWorkspaceStore.getState().markSprintEngineAgentNotificationDelivered(workspace.id, deliveryKey)
      logPerfEvent('SprintEngineAutoRun', 'agent-notification-sent', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        eventId: event.id,
        agentId: targetAgentId,
        taskId: event.taskId ?? null,
        notificationKind: event.notificationKind ?? null,
        sessionId: session.sessionId,
      })
      continue
    }

    if (!sprintEngineAutomationShouldRun(getSprintEngineAutoState(workspace)) || !SPAWNABLE_NOTIFICATION_KINDS.has(event.notificationKind ?? '')) {
      logPerfEvent('SprintEngineAutoRun', 'agent-notification-pending-no-session', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        eventId: event.id,
        agentId: targetAgentId,
        taskId: event.taskId ?? null,
        notificationKind: event.notificationKind ?? null,
      })
      continue
    }

    if (!role) continue
    const result = await spawnAutoRunCandidate(
      workspace,
      sprintEngineState,
      {
        agentId: targetAgentId,
        label: workspace.agents[targetAgentId]?.name ?? rosterAgent?.label ?? targetAgentId,
        role,
        taskId: event.taskId ?? `notification-${event.id}`,
        startupPromptOverride: prompt,
      },
      cliRuntimes,
      mcpSettings,
      inFlightSpawns,
      { trackPendingSpawn: false }
    )
    if (result === 'failed') return 'failed'
    if (result === 'started') {
      started = true
      runningAgentIds.add(targetAgentId)
      sentAgentNotificationEvents.current.add(deliveryKey)
      useWorkspaceStore.getState().markSprintEngineAgentNotificationDelivered(workspace.id, deliveryKey)
    }
  }

  return started ? 'started' : 'none'
}

export async function sendContinuationPromptsToIdleAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<void> {
  if (continuationCapacity.agentIds.size === 0) return

  const readyTasks = getSprintEngineWakeCandidateTasks(sprintEngineState)
  if (readyTasks.length === 0) return

  const now = Date.now()
  const readyTaskIds = new Set(readyTasks.map((task) => task.id))
  sentContinuationMessages.current.forEach((_, key) => {
    const workKey = getContinuationMessageWorkKey(workspace, key)
    if (!workKey || workKey.includes(':')) return
    if (!readyTaskIds.has(workKey)) sentContinuationMessages.current.delete(key)
  })

  const reservedWakeCandidateTaskIds = new Set<string>()
  for (const agentId of continuationCapacity.agentIds) {
    const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
    if (!runtimeAgent) continue

    const task = findSprintEngineWakeCandidateTaskForAgent(
      readyTasks,
      runtimeAgent.role,
      agentId,
      reservedWakeCandidateTaskIds
    )
    if (!task) continue

    const key = continuationMessageKey(workspace, task.id, agentId)
    const previous = sentContinuationMessages.current.get(key)
    if (promptRetryLimitReached(previous, AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES)) {
      logPerfEvent('SprintEngineAutoRun', 'continuation-prompt-retry-limit-reached', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId,
        role: runtimeAgent.role,
        taskId: task.id,
        attempts: previous?.attempts ?? 0,
        maxRetries: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES,
      })
      continue
    }
    if (previous && now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) {
      reservedWakeCandidateTaskIds.add(task.id)
      continue
    }

    const session = await findRunningAgentSession(workspace, agentId)
    if (!session) continue

    await writeBracketedPrompt(
      defaultExecutorPorts,
      session.sessionId,
      buildSprintEngineContinuationPrompt(task, agentId),
    )
    recordPromptRetry(sentContinuationMessages.current, key, now)
    reservedWakeCandidateTaskIds.add(task.id)
    logPerfEvent('SprintEngineAutoRun', 'continuation-prompt-sent', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId,
      role: runtimeAgent.role,
      taskId: task.id,
      sessionId: session.sessionId,
    })
  }
}

/**
 * Last-resort re-engagement for a roster agent whose CLI is alive but idle and
 * has stopped responding to wake-candidate prompts while it still has claimable
 * role work (e.g. a `changes_requested` task its reviewers handed back). Because
 * a live terminal makes the agent count as "running", `pickNextAutoRuns` will
 * not replace it, and the capped continuation prompts are the only other path —
 * so once that budget is exhausted the run stalls silently. Here we restart the
 * stalled terminal: killing it leaves the agent projection-idle with claimable
 * role work, so `pickNextAutoRuns` spawns a fresh terminal next tick that
 * claims the work through `sprintengine.agent.join`.
 *
 * Role-agnostic: applies to any role with a claimable wake task (implementer,
 * frontend, tester rework, …), not just frontend. Quality-gate stalls keep the
 * CLI-verdict completion route and are out of scope here.
 */
export async function escalateStalledLiveIdleAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<'restarted' | 'none'> {
  if (continuationCapacity.agentIds.size === 0) return 'none'
  const wakeTasks = getSprintEngineWakeCandidateTasks(sprintEngineState)
  if (wakeTasks.length === 0) return 'none'

  const now = Date.now()
  let restarted = false
  for (const agentId of continuationCapacity.agentIds) {
    const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
    if (!runtimeAgent) continue
    // Only a genuinely idle agent — no claimed task, no active dispatch. If it
    // had acted on a wake prompt it would already own the task and be excluded
    // from the continuation capacity set.
    if (runtimeAgent.status !== 'idle' || runtimeAgent.currentTaskId || runtimeAgent.currentDispatch) continue

    const task = findSprintEngineWakeCandidateTaskForAgent(wakeTasks, runtimeAgent.role, agentId, new Set())
    if (!task) continue

    const key = continuationMessageKey(workspace, task.id, agentId)
    const previous = sentContinuationMessages.current.get(key)
    // Escalate only after the wake-candidate budget is exhausted AND the final
    // prompt has had a full retry interval to land, so we never kill an agent
    // that is about to wake and claim.
    if (!previous || (previous.attempts ?? 0) < AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES) continue
    if (now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) continue

    const session = await findRunningAgentSession(workspace, agentId)
    if (!session) continue

    await safeTerminalKill(defaultExecutorPorts, session.sessionId)
    // Reset the wake budget for this task/agent. The fresh terminal that
    // `pickNextAutoRuns` spawns next tick claims via join on startup;
    // clearing the counter also guarantees we never kill-loop the replacement
    // before it has a chance to claim.
    sentContinuationMessages.current.delete(key)
    restarted = true

    await defaultExecutorPorts.publishDiagnostic({
      level: 'warning',
      source: 'sprintengine',
      title: 'Restarted a stalled Sprint Engine agent',
      message: `${runtimeAgent.role} had ready work on ${task.id} but its terminal stayed idle and stopped responding to wake prompts. Restarting it so the work can be claimed.`,
      details: [
        `Workspace: ${workspace.name}`,
        `Agent: ${agentId} (${runtimeAgent.role})`,
        `Task: ${task.id} - ${task.title}`,
        `Wake prompts attempted before restart: ${previous.attempts ?? 0}`,
      ].join('\n'),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: task.id,
      agentId,
      sessionId: session.sessionId,
    })
    logPerfEvent('SprintEngineAutoRun', 'stalled-agent-restarted', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId,
      role: runtimeAgent.role,
      taskId: task.id,
      sessionId: session.sessionId,
      attempts: previous.attempts ?? 0,
    })
  }
  return restarted ? 'restarted' : 'none'
}

export async function sendGateContinuationPromptsToAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<void> {
  const now = Date.now()
  const usedIdleAgentIds = new Set<string>()
  const gatedPhaseTasks = sprintEngineState.tasks.filter((task) => {
    const column = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
    return column === 'review' || column === 'testing' || column === 'product'
  })

  for (const task of gatedPhaseTasks) {
    for (const claim of getActiveSprintEngineAutoRunGateClaims(task, sprintEngineState.tasks)) {
      const agentId = claim.claimedBy
      if (!runningAgentIds.has(agentId)) continue
      const key = continuationMessageKey(workspace, `${task.id}:${claim.gate.id}`, agentId)
      const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
      const attemptId = claim.gate.attempts.find((attempt) =>
        attempt.status === 'in_progress' && attempt.claimedBy === agentId
      )?.id
      const dispatch = runtimeAgent?.currentDispatch
      if (
        (
          dispatch?.targetKind === 'gate'
          && dispatch.taskId === task.id
          && dispatch.gateId === claim.gate.id
        )
        || runtimeAgentAlreadyOwnsGateClaim(runtimeAgent, task.id, claim.gate.id, attemptId)
      ) {
        sentContinuationMessages.current.delete(key)
        logPerfEvent('SprintEngineAutoRun', 'gate-continuation-prompt-skipped', {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          agentId,
          role: claim.gate.role,
          taskId: task.id,
          gateId: claim.gate.id,
          claimed: true,
          reason: 'matching-current-dispatch',
        })
        continue
      }
      const previous = sentContinuationMessages.current.get(key)
      if (promptRetryLimitReached(previous)) {
        logPerfEvent('SprintEngineAutoRun', 'gate-continuation-prompt-retry-limit-reached', {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          agentId,
          role: claim.gate.role,
          taskId: task.id,
          gateId: claim.gate.id,
          claimed: true,
          attempts: previous?.attempts ?? 0,
          maxRetries: AUTO_RUN_MAX_PROMPT_RETRIES,
        })
        continue
      }
      if (previous && now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) continue
      const session = await findRunningAgentSession(workspace, agentId)
      if (!session) continue
      await writeBracketedPrompt(
        defaultExecutorPorts,
        session.sessionId,
        buildSprintEngineGateContinuationPrompt(task, claim.gate, agentId, true),
      )
      recordPromptRetry(sentContinuationMessages.current, key, now)
      logPerfEvent('SprintEngineAutoRun', 'gate-continuation-prompt-sent', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId,
        role: claim.gate.role,
        taskId: task.id,
        gateId: claim.gate.id,
        claimed: true,
        sessionId: session.sessionId,
      })
    }

    for (const gate of getClaimableSprintEngineAutoRunGates(task, sprintEngineState.tasks)) {
      const agentId = [...continuationCapacity.agentIds].find((candidateId) => {
        if (usedIdleAgentIds.has(candidateId)) return false
        const runtimeAgent = sprintEngineState.sprintEngineAgents[candidateId]
        return runtimeAgent?.role === gate.role
      })
      if (!agentId) continue
      const key = continuationMessageKey(workspace, `${task.id}:${gate.id}`, agentId)
      const previous = sentContinuationMessages.current.get(key)
      if (promptRetryLimitReached(previous, AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES)) {
        logPerfEvent('SprintEngineAutoRun', 'gate-continuation-prompt-retry-limit-reached', {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          agentId,
          role: gate.role,
          taskId: task.id,
          gateId: gate.id,
          claimed: false,
          attempts: previous?.attempts ?? 0,
          maxRetries: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES,
        })
        continue
      }
      if (previous && now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) {
        usedIdleAgentIds.add(agentId)
        continue
      }
      const session = await findRunningAgentSession(workspace, agentId)
      if (!session) continue
      await writeBracketedPrompt(
        defaultExecutorPorts,
        session.sessionId,
        buildSprintEngineGateContinuationPrompt(task, gate, agentId, false),
      )
      recordPromptRetry(sentContinuationMessages.current, key, now)
      usedIdleAgentIds.add(agentId)
      logPerfEvent('SprintEngineAutoRun', 'gate-continuation-prompt-sent', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId,
        role: gate.role,
        taskId: task.id,
        gateId: gate.id,
        claimed: false,
        sessionId: session.sessionId,
      })
    }
  }
}

export async function sendDispatchPromptsToRunningAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  sentDispatchMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<void> {
  const now = Date.now()
  const activeKeys = new Set<string>()

  for (const [agentId, runtimeAgent] of Object.entries(sprintEngineState.sprintEngineAgents)) {
    const dispatch = runtimeAgent.currentDispatch
    if (!dispatch || runtimeAgent.status === 'retired') continue
    const key = sprintEngineDispatchDeliveryKey(workspace, agentId, dispatch)
    activeKeys.add(key)
    if (runtimeAgent.status === 'needs_input') {
      sentDispatchMessages.current.delete(key)
      logPerfEvent('SprintEngineAutoRun', 'dispatch-prompt-skipped-needs-input', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId,
        dispatchId: dispatch.dispatchId ?? null,
        targetKind: dispatch.targetKind ?? null,
        taskId: dispatch.taskId ?? null,
        gateId: dispatch.gateId ?? null,
      })
      continue
    }
    if (!runningAgentIds.has(agentId)) continue
    const previous = sentDispatchMessages.current.get(key)
    if (promptRetryLimitReached(previous)) {
      logPerfEvent('SprintEngineAutoRun', 'dispatch-prompt-retry-limit-reached', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId,
        role: dispatch.role ?? runtimeAgent.role,
        dispatchId: dispatch.dispatchId ?? null,
        targetKind: dispatch.targetKind ?? null,
        taskId: dispatch.taskId ?? null,
        gateId: dispatch.gateId ?? null,
        attempts: previous?.attempts ?? 0,
        maxRetries: AUTO_RUN_MAX_PROMPT_RETRIES,
      })
      continue
    }
    if (previous && now - previous.sentAt < AUTO_RUN_DISPATCH_PROMPT_RETRY_MS) continue
    if (dispatch.taskId && runtimeAgent.currentTaskId && runtimeAgent.currentTaskId !== dispatch.taskId) {
      logPerfEvent('SprintEngineAutoRun', 'dispatch-prompt-skipped-active-different-task', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId,
        dispatchId: dispatch.dispatchId ?? null,
        dispatchTaskId: dispatch.taskId,
        activeTaskId: runtimeAgent.currentTaskId,
        targetKind: dispatch.targetKind ?? null,
      })
      continue
    }
    if (runtimeAgentAlreadyOwnsDispatchTarget(runtimeAgent, dispatch)) {
      sentDispatchMessages.current.delete(key)
      logPerfEvent('SprintEngineAutoRun', 'dispatch-prompt-skipped-active-target', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId,
        role: dispatch.role ?? runtimeAgent.role,
        dispatchId: dispatch.dispatchId ?? null,
        targetKind: dispatch.targetKind ?? null,
        taskId: dispatch.taskId ?? null,
        gateId: dispatch.gateId ?? null,
      })
      continue
    }

    const session = await findRunningAgentSession(workspace, agentId)
    if (!session) continue
    await writeBracketedPrompt(
      defaultExecutorPorts,
      session.sessionId,
      buildSprintEngineDispatchPrompt({
        role: dispatch.role ?? runtimeAgent.role,
        agentId,
        dispatch,
      }),
    )
    recordPromptRetry(sentDispatchMessages.current, key, now)
    logPerfEvent('SprintEngineAutoRun', 'dispatch-prompt-sent', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId,
      role: dispatch.role ?? runtimeAgent.role,
      dispatchId: dispatch.dispatchId ?? null,
      targetKind: dispatch.targetKind ?? null,
      taskId: dispatch.taskId ?? null,
      gateId: dispatch.gateId ?? null,
      sessionId: session.sessionId,
    })
  }

  sentDispatchMessages.current.forEach((_, key) => {
    if (!key.startsWith(`${workspace.sprintEngineContext?.statePath ?? workspace.id}:`)) return
    if (!activeKeys.has(key)) sentDispatchMessages.current.delete(key)
  })
}

async function reconcileDuplicateAgentSessions(workspace: Workspace): Promise<void> {
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
      message: 'Sprint Engine agent is missing its CLI selection.',
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
        title: decision.reason === 'no_architect'
          ? 'Automation has nothing to start'
          : 'Architect terminal exited before planning finished',
        message: decision.reason === 'no_architect'
          ? 'This run has no tasks yet and no architect on the roster, so automation cannot create a plan.'
          : 'The run has no tasks yet and the architect terminal already exited. Automation does not respawn it automatically; spawn the architect from the board to continue planning.',
        details: [
          `Workspace: ${workspace.name}`,
          decision.reason === 'no_architect'
            ? 'Add an architect to the roster or create tasks before enabling automation.'
            : 'Once the architect records tasks, agents spawn on their own when work becomes claimable.',
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
  sentArchitectTriageMessages: MutableRefObject<Map<string, ArchitectTriageMessage>>
): Promise<'started' | 'sent' | 'failed' | 'none'> {
  if (!workspace.folderPath || !workspace.sprintEngineContext) return 'none'

  const architectBlockers = getArchitectActionableNeedsInputTasks(sprintEngineState)
  if (architectBlockers.length === 0) return 'none'

  const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
  const architect = roster.find((candidate) => candidate.role === 'architect')
  if (!architect) return 'none'

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
  lastContentByWorkspace: MutableRefObject<Map<string, string>>
): Promise<void> {
  const superviseStartedAt = performance.now()
  let sprintEngineState = workspace.sprintEngineState
  const autoState = getSprintEngineAutoState(workspace)
  const automationMode = deriveSprintEngineAutomationMode(autoState, sprintEngineState?.runner)
  const runtimeState = normalizeSprintEngineAutomationRuntimeState(autoState.runtimeState, automationMode)
  const runnerActive = automationMode !== 'manual' && runtimeState === 'running'
  const approvalActive = automationMode === 'run_agents_and_approve_artifacts' && runtimeState === 'running'
  if ((!runnerActive && !approvalActive) || !workspace.folderPath || !sprintEngineState || !workspace.sprintEngineContext) return

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
      lastContentByWorkspace
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
  const runningAgentIds = await getRunningAutoRunAgentIds(workspace, sprintEngineState)
  const continuationCapacity = await getRunningContinuationCapacityByRole(workspace, sprintEngineState)
  logPerfEvent('SprintEngineAutoRun', 'running-agents-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    runningAgentCount: runningAgentIds.size,
    continuationCapacity: Object.fromEntries(continuationCapacity.capacityByRole),
  })

  const notificationSignal = await deliverAgentNotificationEvents(
    workspace,
    sprintEngineState,
    runningAgentIds,
    cliRuntimes,
    mcpSettings,
    inFlightSpawns,
    sentAgentNotificationEvents
  )
  if (notificationSignal === 'failed') return

  await sendDispatchPromptsToRunningAgents(
    workspace,
    sprintEngineState,
    runningAgentIds,
    sentDispatchMessages
  )

  const architectTriageSignal = await signalArchitectForNeedsInputTriage(
    workspace,
    sprintEngineState,
    pendingSpawns,
    runningAgentIds,
    cliRuntimes,
    mcpSettings,
    inFlightSpawns,
    sentArchitectTriageMessages
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

  await sendContinuationPromptsToIdleAgents(
    workspace,
    sprintEngineState,
    continuationCapacity,
    sentContinuationMessages
  )
  await sendGateContinuationPromptsToAgents(
    workspace,
    sprintEngineState,
    runningAgentIds,
    continuationCapacity,
    sentContinuationMessages
  )
  // Re-engage any live-idle agent that exhausted its wake prompts but still has
  // claimable role work (e.g. a changes_requested task its reviewers handed
  // back): restart its terminal so the exit→respawn path claims the work.
  await escalateStalledLiveIdleAgents(
    workspace,
    sprintEngineState,
    continuationCapacity,
    sentContinuationMessages
  )

  if (sprintEngineState.tasks.length > 0 && sprintEngineState.tasks.every((task) => task.status === 'done')) {
    // Close the run's agent terminals before applying the stop reason: a
    // terminal-list IPC failure throws here, leaves the runner in `running`,
    // and the next tick retries both the close and the completion transition.
    if (!autoState.keepDoneAgentTerminals) {
      await closeCompletedRunAgentTerminals(workspace)
    }
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

// All tasks are done: the run summary lives on the Sprint Engine board, so the
// roster's CLI terminals are no longer needed. Closing them returns each agent
// tab to its Spawn placeholder; the user can re-spawn an agent manually if they
// want to talk to it about the finished run.
async function closeCompletedRunAgentTerminals(workspace: Workspace): Promise<void> {
  const result = await closeSprintEngineRunAgentTerminals(defaultExecutorPorts, workspace)
  for (const agentId of result.resetAgentIds) {
    void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspace.id, agentId, {
      cliSessionId: null,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
    })
  }
  if (result.closedSessionIds.length === 0) return

  logPerfEvent('SprintEngineAutoRun', 'run-complete-terminals-closed', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    closedSessionIds: result.closedSessionIds,
    resetAgentIds: result.resetAgentIds,
  })
  await defaultExecutorPorts.publishDiagnostic({
    level: 'info',
    source: 'sprintengine',
    title: 'Sprint complete — agent terminals closed',
    message: `All tasks are done, so ${result.closedSessionIds.length === 1 ? 'the remaining agent terminal was' : `${result.closedSessionIds.length} agent terminals were`} closed. The Sprint Engine board and run summary stay available.`,
    details: [
      `Workspace: ${workspace.name}`,
      `Closed sessions: ${result.closedSessionIds.join(', ')}`,
      'Keep terminals open after a run via the Sprint Engine "keep done agent terminals" setting.',
    ].join('\n'),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  })
}

async function reconcileWorkspaceSessions(workspace: Workspace): Promise<void> {
  try {
    await reconcileDuplicateAgentSessions(workspace)
  } catch (error) {
    if (error instanceof TerminalListIpcError) {
      await publishTerminalListIpcFailureNotice(workspace, error, 'reconcile')
      return
    }
    throw error
  }

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

    const status = await defaultExecutorPorts.terminalStatus(agent.cliSessionId)
    if (status.processAlive) continue

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
  const lastContentByWorkspace = useRef(new Map<string, string>())
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
            keepDoneAgentTerminals: getSprintEngineAutoState(workspace).keepDoneAgentTerminals,
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
            lastContentByWorkspace
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

    void tick()
    const interval = window.setInterval(() => {
      void tick()
    }, AUTO_RUN_POLL_MS)

    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [])

  return null
}
