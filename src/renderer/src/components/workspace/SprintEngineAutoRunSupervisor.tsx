import { useEffect, useRef, type MutableRefObject } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentCli,
  CliRuntimeSettings,
  McpSettings,
  SprintEngineArtifact,
  SprintEngineAutoPendingSpawn,
  SprintEngineAutoState,
  SprintEngineRole,
  SprintEngineState,
  SprintEngineTask,
  Workspace,
} from '../../types/workspace'
import { buildSprintEngineStartupPrompt, getSprintEngineStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
import {
  buildSprintEngineAgentRosterForState,
  buildSprintEngineRosterCommandArgs,
  getSprintEngineArtifactAutoApprovalEligibility,
  getSprintEngineTaskBoardColumn,
  sprintEngineRoleLabels,
} from '../../utils/sprintengine'
import { parseSprintEngineStateFile } from '../../utils/sprintengineStateFile'
import { publishDiagnostic } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { MULTICODE_DISABLE_SPRINTENGINE_AUTORUN } from '../../utils/runtimeFlags'
import { sendArtifactApprovalToTerminal } from '../../utils/terminalApproval'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'

const AUTO_RUN_POLL_MS = 2000
const INACTIVE_AUTO_RUN_POLL_MS = 15000
const AUTO_RUN_STARTUP_SPAWN_DELAY_MS = 10000
const AUTO_RUN_PENDING_SPAWN_GRACE_MS = 60000
const AUTO_RUN_ROLE_CONTINUATION_GRACE_MS = 30000
const AUTO_RUN_ROLE_CONTINUATION_RETRY_MS = 60000
const ARTIFACT_AUTO_APPROVAL_RETRY_MS = 60000
const AUTO_APPROVAL_DIAGNOSTIC_COOLDOWN_MS = 30000
const TERMINAL_IPC_TIMEOUT_MS = 3000
const BACKGROUND_TERMINAL_COLS = 100
const BACKGROUND_TERMINAL_ROWS = 30
const NEEDS_INPUT_AUTO_APPROVAL_STATUSES = new Set<SprintEngineArtifact['status']>([
  'draft',
  'ready_for_review',
  'changes_requested',
])
type AutoRunCandidate = {
  agentId: string
  label: string
  role: SprintEngineRole
  taskId: string
}

type RoleContinuationGrace = {
  startedAt: number
}

type RunningContinuationCapacity = {
  capacityByRole: Map<SprintEngineRole, number>
  agentIds: Set<string>
}

type RoleContinuationMessage = {
  sentAt: number
}

const DEFAULT_AUTO_STATE: SprintEngineAutoState = {
  enabled: false,
  autoApproveArtifacts: false,
  keepDoneAgentTerminals: false,
  cliPermissionPreset: 'default',
  maxConcurrentAgents: 3,
  pendingSpawns: [],
}

function getSprintEngineAutoState(workspace: Workspace | null | undefined): SprintEngineAutoState {
  return workspace?.sprintEngineAutoState ?? DEFAULT_AUTO_STATE
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

async function listTerminalSessionsForAutoRun(
  workspace: Workspace,
  cause: string
): Promise<TerminalSessionSnapshot[]> {
  const startedAt = performance.now()
  logPerfEvent('SprintEngineAutoRun', 'terminal-list-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    cause,
    timeoutMs: TERMINAL_IPC_TIMEOUT_MS,
  })

  try {
    const sessions = await withTimeout(
      window.api.terminalList(),
      TERMINAL_IPC_TIMEOUT_MS,
      `Timed out waiting for terminal sessions after ${TERMINAL_IPC_TIMEOUT_MS}ms.`
    )
    logPerfEvent('SprintEngineAutoRun', 'terminal-list-end', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      sessionCount: sessions.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    })
    return sessions
  } catch (error) {
    logPerfEvent('SprintEngineAutoRun', 'terminal-list-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      elapsedMs: Math.round(performance.now() - startedAt),
      message: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

function isMatchingWorkspaceAgentSession(
  session: TerminalSessionSnapshot,
  workspace: Workspace,
  agentId: string
): boolean {
  if (
    !session.running
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
  if (!workspace.folderPath || !workspace.sprintEngineState || !workspace.sprintEngineContext) {
    return null
  }

  const stateFilePath = workspace.sprintEngineContext.statePath

  try {
    const startedAt = performance.now()
    const content = await window.api.readfile(stateFilePath)
    if (!options.force && lastContentByWorkspace.current.get(workspace.id) === content) {
      logPerfEvent('SprintEngineAutoRun', 'refresh-state', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        changed: false,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
      return workspace.sprintEngineState
    }

    lastContentByWorkspace.current.set(workspace.id, content)
    const parsedState = parseSprintEngineStateFile(content, workspace.sprintEngineContext.teamSlug)
    useWorkspaceStore.getState().setSprintEngineState(workspace.id, parsedState)
    logPerfEvent('SprintEngineAutoRun', 'refresh-state', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      changed: true,
      elapsedMs: Math.round(performance.now() - startedAt),
      taskCount: parsedState.tasks.length,
      artifactCount: parsedState.artifacts.length,
    })
    return parsedState
  } catch (error) {
    logPerfEvent('SprintEngineAutoRun', 'refresh-state-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      message: error instanceof Error ? error.message : String(error),
    })
    // Auto mode can be enabled before the agent-managed state file exists.
    return null
  }
}

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

  await publishDiagnostic({
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

function artifactApprovalMessageKey(workspace: Workspace, artifact: SprintEngineArtifact): string {
  return [
    workspace.id,
    artifact.id,
    artifact.fingerprint ?? '',
    artifact.updatedAt ?? '',
  ].join(':')
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
  await publishDiagnostic({
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

function describeNeedsInputAutoApprovalState(sprintEngineState: SprintEngineState): string[] {
  const needsInputTasks = sprintEngineState.tasks
    .filter((task) => task.status === 'needs_input')
    .map((task) => `${task.id} (${task.role}) owner=${task.ownerAgentId ?? 'none'}`)
  const readyArtifacts = sprintEngineState.artifacts
    .filter((artifact) => artifact.status === 'ready_for_review')
    .map((artifact) => `${artifact.id} kind=${artifact.kind} task=${artifact.taskId || 'none'} createdBy=${artifact.createdBy || 'none'} path=${artifact.path || 'none'}`)

  return [
    `Needs-input tasks: ${needsInputTasks.join(', ') || 'none'}`,
    `Ready artifacts: ${readyArtifacts.join(', ') || 'none'}`,
  ]
}

function getAutoApprovalIntentArtifacts(sprintEngineState: SprintEngineState): SprintEngineArtifact[] {
  const tasksById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))
  const hasNeedsInputTask = sprintEngineState.tasks.some((task) => task.status === 'needs_input')
  return sprintEngineState.artifacts.filter((artifact) => {
    const task = tasksById.get(artifact.taskId)
    if (!task) return false
    if (!artifact.createdBy.trim() && !task.ownerAgentId?.trim()) return false
    if (getSprintEngineArtifactAutoApprovalEligibility(artifact).eligible) return true
    if (!hasNeedsInputTask) return false
    if (!NEEDS_INPUT_AUTO_APPROVAL_STATUSES.has(artifact.status)) return false
    return Boolean(artifact.path.trim())
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

  useWorkspaceStore.getState().updateAgent(workspace.id, agentId, {
    cliSessionId: runningSession.sessionId,
    cliStartRequested: true,
    cliHasLaunched: true,
    cliResumeAvailable: (runningSession.cli ?? agent?.cli ?? 'codex') === 'codex',
    cli: runningSession.cli ?? agent?.cli ?? 'codex',
    kind: 'sprintengine',
  })
  return runningSession
}

async function sendApprovalToNextEligibleArtifactProducer(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  sentArtifactApprovalMessages: MutableRefObject<Map<string, number>>,
  autoApprovalDiagnostics: MutableRefObject<Map<string, number>>
): Promise<'sent' | 'failed' | 'none'> {
  const autoState = getSprintEngineAutoState(workspace)
  if (!autoState.enabled || !autoState.autoApproveArtifacts || !workspace.sprintEngineContext) {
    return 'none'
  }

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
  try {
    const task = sprintEngineState.tasks.find((candidate) => candidate.id === artifact.taskId)
    const responsibleAgentId = artifact.createdBy.trim() || task?.ownerAgentId?.trim() || ''
    if (!responsibleAgentId) {
      sentArtifactApprovalMessages.current.set(approvalKey, Date.now())
      await publishArtifactApprovalWarning(
        workspace,
        artifact,
        'Cannot communicate auto-approval intent: no responsible agent is recorded.'
      )
      return 'none'
    }

    const agentSession = await findRunningAgentSession(workspace, responsibleAgentId)
    if (!agentSession) {
      sentArtifactApprovalMessages.current.set(approvalKey, Date.now())
      await publishArtifactApprovalWarning(
        workspace,
        artifact,
        'Cannot communicate auto-approval intent: the responsible agent terminal is not running.',
        [`Responsible agent: ${responsibleAgentId}`]
      )
      return 'none'
    }

    await sendArtifactApprovalToTerminal(agentSession.sessionId)

    sentArtifactApprovalMessages.current.set(approvalKey, Date.now())
    await publishAutoApprovalDiagnostic(
      workspace,
      autoApprovalDiagnostics,
      `${approvalKey}:sent`,
      {
        level: 'info',
        title: 'Artifact approval intent sent',
        message: 'Sent the user approval intent to the responsible agent terminal.',
        details: [
          `Artifact: ${artifact.id} - ${artifact.title}`,
          `Task: ${artifact.taskId}`,
          `Responsible agent: ${responsibleAgentId}`,
          `Terminal session: ${agentSession.sessionId}`,
        ],
        agentId: responsibleAgentId,
        sessionId: agentSession.sessionId,
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
    sentArtifactApprovalMessages.current.set(approvalKey, Date.now())
    await publishArtifactApprovalWarning(
      workspace,
      artifact,
      error instanceof Error ? error.message : 'Approval failed. Review manually or retry.'
    )
    return 'none'
  }
}

function pickNextAutoRuns(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  options: {
    limit: number
    pendingSpawns: SprintEngineAutoPendingSpawn[]
    runningAgentIds: Set<string>
    inFlightSpawns: Set<string>
    continuationCapacityByRole: Map<SprintEngineRole, number>
    continuationGraceByTask: Map<string, RoleContinuationGrace>
  }
): AutoRunCandidate[] {
  if (options.limit <= 0) return []

  const startedAt = performance.now()
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    limit: options.limit,
    taskCount: sprintEngineState.tasks.length,
    agentCount: Object.keys(sprintEngineState.sprintEngineAgents).length,
    pendingSpawnCount: options.pendingSpawns.length,
    runningAgentCount: options.runningAgentIds.size,
    inFlightSpawnCount: options.inFlightSpawns.size,
    continuationCapacity: Object.fromEntries(options.continuationCapacityByRole),
  })
  const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-roster', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    rosterCount: roster.length,
  })
  const rosterById = Object.fromEntries(roster.map((agent) => [agent.id, agent]))
  const pendingTaskIds = new Set(options.pendingSpawns.map((pending) => pending.taskId))
  const pendingAgentIds = new Set(options.pendingSpawns.map((pending) => pending.agentId))
  const selectedTaskIds = new Set<string>()
  const selectedAgentIds = new Set<string>()
  const candidates: AutoRunCandidate[] = []

  const hasInFlightSpawn = (agentId: string) =>
    options.inFlightSpawns.has(`${workspace.id}:${agentId}`)

  const findReusableRoleAgent = (role: SprintEngineRole): AutoRunCandidate['agentId'] | null => {
    const agent = roster.find((candidate) => {
      const runtime = sprintEngineState.sprintEngineAgents[candidate.id]
      return candidate.role === role
        && runtime?.status === 'idle'
        && !runtime.currentTaskId
        && !pendingAgentIds.has(candidate.id)
        && !selectedAgentIds.has(candidate.id)
        && !options.runningAgentIds.has(candidate.id)
        && !hasInFlightSpawn(candidate.id)
    })

    return agent?.id ?? null
  }

  const addCandidate = (task: SprintEngineTask, agentId: string, fallbackLabel: string) => {
    if (candidates.length >= options.limit) return false
    if (pendingTaskIds.has(task.id) || selectedTaskIds.has(task.id)) return false
    if (
      pendingAgentIds.has(agentId)
      || selectedAgentIds.has(agentId)
      || options.runningAgentIds.has(agentId)
      || hasInFlightSpawn(agentId)
    ) {
      return false
    }

    candidates.push({
      agentId,
      label: workspace.agents[agentId]?.name ?? fallbackLabel,
      role: task.role,
      taskId: task.id,
    })
    selectedTaskIds.add(task.id)
    selectedAgentIds.add(agentId)
    return true
  }

  const activeTasks = sprintEngineState.tasks.filter((task) =>
    task.status === 'in_progress' && Boolean(task.ownerAgentId)
  )
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-active-tasks', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    activeTaskCount: activeTasks.length,
  })

  for (const task of activeTasks) {
    if (candidates.length >= options.limit) break
    const ownerAgentId = task.ownerAgentId
    if (!ownerAgentId) continue
    const agentId = ownerAgentId
    const rosterAgent = rosterById[agentId]
    addCandidate(task, agentId, workspace.agents[agentId]?.name ?? rosterAgent?.label ?? agentId)
  }

  const recoverableNeedsInputTasks = sprintEngineState.tasks.filter((task) =>
    task.status === 'needs_input'
    && (!task.ownerAgentId || !options.runningAgentIds.has(task.ownerAgentId))
  )
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-recoverable-needs-input-tasks', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    taskCount: recoverableNeedsInputTasks.length,
  })

  for (const task of recoverableNeedsInputTasks) {
    if (candidates.length >= options.limit) break
    const agentId = task.ownerAgentId ?? findReusableRoleAgent(task.role)
    if (!agentId) continue
    addCandidate(task, agentId, workspace.agents[agentId]?.name ?? rosterById[agentId]?.label ?? agentId)
  }

  const readyTasks = sprintEngineState.tasks.filter((task) =>
    getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks) === 'ready'
    && !task.ownerAgentId
  )
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-tasks', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    readyTaskCount: readyTasks.length,
  })
  const continuationKeyForTask = (taskId: string) =>
    [
      workspace.id,
      workspace.sprintEngineContext?.statePath ?? '',
      taskId,
    ].join(':')
  const readyTaskKeys = new Set(readyTasks.map((task) => continuationKeyForTask(task.id)))
  for (const taskKey of options.continuationGraceByTask.keys()) {
    if (taskKey.startsWith(`${workspace.id}:`) && !readyTaskKeys.has(taskKey)) {
      options.continuationGraceByTask.delete(taskKey)
    }
  }
  const reservedContinuationByRole = new Map<SprintEngineRole, number>()

  for (const task of readyTasks) {
    if (candidates.length >= options.limit) break
    const continuationCapacity = options.continuationCapacityByRole.get(task.role) ?? 0
    const reservedForRole = reservedContinuationByRole.get(task.role) ?? 0
    if (reservedForRole < continuationCapacity) {
      const taskKey = continuationKeyForTask(task.id)
      const grace = options.continuationGraceByTask.get(taskKey) ?? { startedAt: Date.now() }
      options.continuationGraceByTask.set(taskKey, grace)
      const elapsedMs = Date.now() - grace.startedAt
      if (elapsedMs < AUTO_RUN_ROLE_CONTINUATION_GRACE_MS) {
        reservedContinuationByRole.set(task.role, reservedForRole + 1)
        logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-task-reserved-for-continuation', {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          taskId: task.id,
          role: task.role,
          elapsedMs,
          graceMs: AUTO_RUN_ROLE_CONTINUATION_GRACE_MS,
        })
        continue
      }
    }

    logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-task', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: task.id,
      role: task.role,
      ownerAgentId: task.ownerAgentId ?? null,
      dependsOnCount: task.dependsOn.length,
    })

    const reusableAgentId = findReusableRoleAgent(task.role)
    if (!reusableAgentId) {
      logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-task-waiting-for-roster-agent', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        role: task.role,
      })
      continue
    }

    const agent = rosterById[reusableAgentId] ?? { id: reusableAgentId, label: reusableAgentId, role: task.role }

    addCandidate(task, agent.id, agent.label)
    logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-task-result', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: task.id,
      selectedAgentId: agent.id,
      selectedAgentRole: agent.role,
      candidateCount: candidates.length,
    })
  }

  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    candidateCount: candidates.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  })
  return candidates
}

function sessionBelongsToWorkspaceSprintEngine(
  session: TerminalSessionSnapshot,
  workspace: Workspace
): boolean {
  return Boolean(
    session.running
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
      useWorkspaceStore.getState().updateAgent(workspace.id, session.agentId, {
        cliSessionId: session.sessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeAvailable: (session.cli ?? agent?.cli ?? 'codex') === 'codex',
        cli: session.cli ?? agent?.cli ?? 'codex',
        kind: 'sprintengine',
      })
    }
  }

  return runningAgentIds
}

async function getRunningContinuationCapacityByRole(
  workspace: Workspace,
  sprintEngineState: SprintEngineState
): Promise<RunningContinuationCapacity> {
  const capacityByRole = new Map<SprintEngineRole, number>()
  const countedAgentIds = new Set<string>()
  const sessions = await listTerminalSessionsForAutoRun(workspace, 'role-continuation-capacity')

  for (const session of sessions) {
    if (!session.agentId || countedAgentIds.has(session.agentId)) continue
    if (!sessionBelongsToWorkspaceSprintEngine(session, workspace)) continue

    const runtimeAgent = sprintEngineState.sprintEngineAgents[session.agentId]
    if (!runtimeAgent || runtimeAgent.status === 'needs_input') continue

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

function bracketedTerminalPaste(text: string): string {
  return `\x1b[200~${text.replace(/\r?\n/g, '\n')}\x1b[201~\r`
}

function continuationMessageKey(workspace: Workspace, taskId: string, agentId: string): string {
  return [
    workspace.id,
    workspace.sprintEngineContext?.statePath ?? '',
    taskId,
    agentId,
  ].join(':')
}

function buildSprintEngineContinuationPrompt(task: SprintEngineTask, agentId: string): string {
  return [
    `Sprint Engine roster runner found a ready ${task.role} task for this idle terminal.`,
    `Task: ${task.id} - ${task.title}`,
    `Run \`sprintengine join --role ${task.role} --id ${agentId}\` to receive the current directive, then claim and work the next ready ${task.role} task with this same agent id. If no task is returned, wait briefly and keep polling while this Sprint Engine roster session remains active.`,
  ].join('\n')
}

async function sendContinuationPromptsToIdleAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<void> {
  if (continuationCapacity.agentIds.size === 0) return

  const readyTasks = sprintEngineState.tasks.filter((task) =>
    getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks) === 'ready'
    && !task.ownerAgentId
  )
  if (readyTasks.length === 0) return

  const now = Date.now()
  const readyTaskIds = new Set(readyTasks.map((task) => task.id))
  sentContinuationMessages.current.forEach((_, key) => {
    if (!key.startsWith(`${workspace.id}:`)) return
    const keyParts = key.split(':')
    const taskId = keyParts[keyParts.length - 2]
    if (taskId && !readyTaskIds.has(taskId)) sentContinuationMessages.current.delete(key)
  })

  const claimedTaskIds = new Set<string>()
  for (const agentId of continuationCapacity.agentIds) {
    const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
    if (!runtimeAgent) continue

    const task = readyTasks.find((candidate) =>
      candidate.role === runtimeAgent.role && !claimedTaskIds.has(candidate.id)
    )
    if (!task) continue

    const key = continuationMessageKey(workspace, task.id, agentId)
    const previous = sentContinuationMessages.current.get(key)
    if (previous && now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) {
      claimedTaskIds.add(task.id)
      continue
    }

    const session = await findRunningAgentSession(workspace, agentId)
    if (!session) continue

    await window.api.terminalWrite(session.sessionId, bracketedTerminalPaste(
      buildSprintEngineContinuationPrompt(task, agentId)
    ))
    sentContinuationMessages.current.set(key, { sentAt: now })
    claimedTaskIds.add(task.id)
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
        .map((session) => withTimeout(
          window.api.terminalKill(session.sessionId),
          TERMINAL_IPC_TIMEOUT_MS,
          `Timed out killing terminal session ${session.sessionId}.`
        ).catch(() => {}))
    )

    const agent = workspace.agents[agentId]
    if (agent?.cliSessionId !== preferredSession.sessionId || !agent?.cliStartRequested) {
      useWorkspaceStore.getState().updateAgent(workspace.id, agentId, {
        cliSessionId: preferredSession.sessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeAvailable: (preferredSession.cli ?? agent?.cli ?? 'codex') === 'codex',
        cli: preferredSession.cli ?? agent?.cli ?? 'codex',
        kind: 'sprintengine',
      })
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
      ? getSprintEngineTaskBoardColumn(pendingTask, sprintEngineState.tasks) === 'ready' && !pendingTask.ownerAgentId
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
    }
  }

  if (changed) setAutoRunPendingSpawns(workspace.id, activePendingSpawns)
  return activePendingSpawns
}

async function spawnAutoRunCandidate(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  nextRun: AutoRunCandidate,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>,
  options: { trackPendingSpawn?: boolean } = {}
): Promise<'started' | 'failed' | 'skipped'> {
  const currentState = useWorkspaceStore.getState()
  const currentWorkspace = currentState.workspaces.find((candidate) => candidate.id === workspace.id)
  const currentAgent = currentWorkspace?.agents[nextRun.agentId]
  const selectedCli: AgentCli = currentAgent?.cli ?? 'codex'
  const sessionId = crypto.randomUUID()
  const spawnKey = `${workspace.id}:${nextRun.agentId}`
  if (inFlightSpawns.current.has(spawnKey)) return 'skipped'

  if (!workspace.folderPath || !workspace.sprintEngineContext) return 'skipped'
  const workspaceFolderPath = workspace.folderPath
  const sprintEngineStatePath = workspace.sprintEngineContext.statePath
  const pendingSpawn = {
    taskId: nextRun.taskId,
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
    const folderExists = await window.api.pathExists(workspaceFolderPath)
    if (!folderExists) {
      currentState.setFolderMissing(workspace.id, true)
      setAutoRunPendingSpawns(workspace.id, [])
      currentState.setSprintEngineAutoEnabled(workspace.id, false)
      await publishDiagnostic({
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
      const status = await window.api.terminalStatus(latestAgent.cliSessionId).catch(() => ({ running: false }))
      if (status.running) return 'skipped'
      latestStateBeforeSpawn.updateAgent(workspace.id, nextRun.agentId, {
        cliSessionId: undefined,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: (latestAgent.cli ?? 'codex') === 'codex' ? latestAgent.cliResumeAvailable ?? true : false,
      })
    } else if (latestAgent?.cliStartRequested) {
      latestStateBeforeSpawn.updateAgent(workspace.id, nextRun.agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: (latestAgent.cli ?? 'codex') === 'codex' ? latestAgent.cliResumeAvailable ?? true : false,
      })
    }

    let executionCwd = workspaceFolderPath
    let executionMode: 'current_workspace' | 'worktree' = 'current_workspace'

    const memoryConfig = resolveProjectKnowledgeConfig(
      workspaceFolderPath,
      useWorkspaceStore.getState().appSettings.projectKnowledgeRoots,
      workspace.memory.relativeRoot
    )
    const memoryRelativeRoot = memoryConfig?.relativeRoot ?? null
    const memoryStatus = memoryRelativeRoot
      ? await window.api.memoryResolveRoot({
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
      }),
      nextRun.label,
      sprintEngineRoleLabels[nextRun.role]
    )
    const startupPrompt = [
      storedStartupPrompt || generatedStartupPrompt,
      memoryPrompt,
    ].filter(Boolean).join('\n\n')

    if (options.trackPendingSpawn !== false) addAutoRunPendingSpawn(workspace.id, pendingSpawn)
    currentState.updateAgent(workspace.id, nextRun.agentId, {
      name: nextRun.label,
      execution: {
        mode: executionMode,
        worktreeId: null,
        cwd: null,
      },
      cliStartRequested: true,
      cliSessionId: sessionId,
      cliHasLaunched: true,
      cliOnboardingPromptSent: true,
      cliResumeAvailable: selectedCli === 'codex',
      cliLastExitCode: undefined,
      cliLastExitedAt: undefined,
      cli: selectedCli,
      cliStartupPrompt: storedStartupPrompt ? latestAgent?.cliStartupPrompt : undefined,
      kind: 'sprintengine',
    })

    const terminalMetadata = {
      kind: 'agent',
      workspaceId: workspace.id,
      agentId: nextRun.agentId,
      executionMode,
      cliPermissionPreset: getSprintEngineAutoState(workspace).cliPermissionPreset,
      memoryRootPath: memoryStatus?.ok ? memoryStatus.rootPath : undefined,
      memoryRelativeRoot: memoryRelativeRoot ?? undefined,
      mcpSettings,
      visible: false,
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
    }

    const spawnResult = await window.api.terminalSpawn(
      sessionId,
      BACKGROUND_TERMINAL_COLS,
      BACKGROUND_TERMINAL_ROWS,
      executionCwd,
      false,
      sprintEngineStatePath,
      selectedCli,
      startupPrompt,
      cliRuntimes,
      false,
      terminalMetadata
    ).catch((error): TerminalSpawnResult => ({
      ok: false,
      sessionId,
      message: error instanceof Error ? error.message : 'Failed to start terminal.',
      exitCode: 1,
    }))
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
      const latestState = useWorkspaceStore.getState()
      latestState.setSprintEngineAutoEnabled(workspace.id, false)
      setAutoRunPendingSpawns(workspace.id, [])
      latestState.updateAgent(workspace.id, nextRun.agentId, {
        cliSessionId: undefined,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      await publishDiagnostic({
        level: 'error',
        source: 'terminal',
        title: `${nextRun.label} was not started`,
        message: spawnResult.message,
        details: [
          `Workspace: ${workspace.name}`,
          `CLI: ${selectedCli}`,
          `CLI permissions: ${getSprintEngineAutoState(workspace).cliPermissionPreset}`,
          `Task: ${nextRun.taskId}`,
          `Session: ${sessionId}`,
          `Cwd: ${executionCwd}`,
          `Sprint Engine state: ${sprintEngineStatePath}`,
        ].filter(Boolean).join('\n'),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: nextRun.agentId,
        taskId: nextRun.taskId,
        sessionId,
      })
      return 'failed'
    }

    currentState.updateAgent(workspace.id, nextRun.agentId, {
      cliStartupPrompt: undefined,
    })
    return 'started'
  } finally {
    inFlightSpawns.current.delete(spawnKey)
  }
}

async function startMissingRosterAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>
): Promise<'started' | 'failed' | 'none'> {
  if (!getSprintEngineAutoState(workspace).enabled || !workspace.sprintEngineContext) return 'none'

  const stateFileExists = await window.api.pathExists(workspace.sprintEngineContext.statePath).catch(() => false)
  const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
  let started = false

  for (const agent of roster) {
    if (!stateFileExists) {
      logPerfEvent('SprintEngineAutoRun', 'roster-spawn-before-state', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: agent.id,
        role: agent.role,
      })
    }
    if (runningAgentIds.has(agent.id)) continue
    if (inFlightSpawns.current.has(`${workspace.id}:${agent.id}`)) continue

    const currentAgent = workspace.agents[agent.id]
    if (
      currentAgent?.kind === 'sprintengine'
      && currentAgent.cliLastExitedAt
      && !currentAgent.cliStartRequested
      && !currentAgent.cliHasLaunched
    ) {
      logPerfEvent('SprintEngineAutoRun', 'roster-spawn-skipped-exited', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: agent.id,
        role: agent.role,
        lastExitedAt: currentAgent.cliLastExitedAt,
      })
      continue
    }
    const status = currentAgent?.cliSessionId
      ? await window.api.terminalStatus(currentAgent.cliSessionId).catch(() => ({ running: false }))
      : { running: false }
    if (status.running) continue

    const result = await spawnAutoRunCandidate(
      workspace,
      sprintEngineState,
      {
        agentId: agent.id,
        label: currentAgent?.name ?? agent.label,
        role: agent.role,
        taskId: `roster-${agent.id}`,
      },
      cliRuntimes,
      mcpSettings,
      inFlightSpawns,
      { trackPendingSpawn: false }
    )
    if (result === 'failed') return 'failed'
    if (result === 'started') {
      started = true
      runningAgentIds.add(agent.id)
    }
  }

  return started ? 'started' : 'none'
}

async function superviseWorkspace(
  workspace: Workspace,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>,
  sentArtifactApprovalMessages: MutableRefObject<Map<string, number>>,
  autoApprovalDiagnostics: MutableRefObject<Map<string, number>>,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>,
  continuationGraceByTask: MutableRefObject<Map<string, RoleContinuationGrace>>,
  lastContentByWorkspace: MutableRefObject<Map<string, string>>
): Promise<void> {
  const superviseStartedAt = performance.now()
  let sprintEngineState = workspace.sprintEngineState
  const autoState = getSprintEngineAutoState(workspace)
  if (!autoState.enabled || !workspace.folderPath || !sprintEngineState || !workspace.sprintEngineContext) return

  logPerfEvent('SprintEngineAutoRun', 'supervise-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    taskCount: sprintEngineState.tasks.length,
    agentCount: Object.keys(sprintEngineState.sprintEngineAgents).length,
    autoApproveArtifacts: autoState.autoApproveArtifacts,
  })

  if (autoState.enabled && autoState.autoApproveArtifacts) {
    const approvalResult = await sendApprovalToNextEligibleArtifactProducer(
      workspace,
      sprintEngineState,
      sentArtifactApprovalMessages,
      autoApprovalDiagnostics
    )
    if (approvalResult === 'failed') return
    if (approvalResult === 'sent') {
      const refreshedSprintEngineState = await refreshAutoWorkspaceState(workspace, lastContentByWorkspace, { force: true })
      if (!refreshedSprintEngineState) {
        const messageSentArtifactIds = new Set(
          getAutoApprovalIntentArtifacts(sprintEngineState).map((artifact) => artifact.id)
        )
        const artifact = sprintEngineState.artifacts.find((candidate) => messageSentArtifactIds.has(candidate.id))
        if (artifact) {
          await publishArtifactApprovalWarning(
            workspace,
            artifact,
            'Could not refresh Sprint Engine state after sending approval intent.'
          )
        }
        return
      }

      const refreshedWorkspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
      if (!refreshedWorkspace) return
      workspace = refreshedWorkspace
      sprintEngineState = refreshedWorkspace.sprintEngineState ?? refreshedSprintEngineState
      logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        reason: 'auto-approval-sent',
        elapsedMs: Math.round(performance.now() - superviseStartedAt),
      })
      return
    }
  }

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

  const runningNeedsInputAgentIds = Object.entries(sprintEngineState.sprintEngineAgents)
    .filter(([, agent]) => agent.status === 'needs_input')
    .map(([agentId]) => agentId)
    .filter((agentId) => runningAgentIds.has(agentId))
  if (runningNeedsInputAgentIds.length > 0) {
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'agent-needs-input',
      agentIds: runningNeedsInputAgentIds,
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  const runningNeedsInputTaskIds = sprintEngineState.tasks
    .filter((task) =>
      task.status === 'needs_input'
      && Boolean(task.ownerAgentId)
      && runningAgentIds.has(task.ownerAgentId!)
    )
    .map((task) => task.id)
  if (runningNeedsInputTaskIds.length > 0) {
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'task-needs-input',
      taskIds: runningNeedsInputTaskIds,
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  const rosterStartResult = await startMissingRosterAgents(
    workspace,
    sprintEngineState,
    runningAgentIds,
    cliRuntimes,
    mcpSettings,
    inFlightSpawns
  )
  if (rosterStartResult === 'failed') return

  await sendContinuationPromptsToIdleAgents(
    workspace,
    sprintEngineState,
    continuationCapacity,
    sentContinuationMessages
  )

  if (sprintEngineState.tasks.length > 0 && sprintEngineState.tasks.every((task) => task.status === 'done')) {
    useWorkspaceStore.getState().setSprintEngineAutoEnabled(workspace.id, false)
    logPerfEvent('SprintEngineAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'all-tasks-done',
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  const occupiedAgentIds = new Set<string>([
    ...sprintEngineState.tasks
      .filter((task) =>
        (task.status === 'in_progress' || task.status === 'needs_input')
        && Boolean(task.ownerAgentId)
      )
      .map((task) => task.ownerAgentId!),
    ...pendingSpawns.map((pending) => pending.agentId),
  ])
  for (const spawnKey of inFlightSpawns.current) {
    if (!spawnKey.startsWith(`${workspace.id}:`)) continue
    occupiedAgentIds.add(spawnKey.slice(workspace.id.length + 1))
  }
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
    await publishDiagnostic({
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
  for (const nextRun of nextRuns) {
    const latestWorkspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
    if (!latestWorkspace || !getSprintEngineAutoState(latestWorkspace).enabled) return
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
  await reconcileDuplicateAgentSessions(workspace)

  for (const agent of Object.values(workspace.agents)) {
    if (!agent.cliStartRequested) continue

    if (!agent.cliSessionId) {
      if (agent.kind !== 'sprintengine') continue
      useWorkspaceStore.getState().updateAgent(workspace.id, agent.id, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: (agent.cli ?? 'codex') === 'codex' ? agent.cliResumeAvailable ?? true : false,
      })
      continue
    }

    const status = await window.api.terminalStatus(agent.cliSessionId)
    if (status.running) continue

    useWorkspaceStore.getState().updateAgent(workspace.id, agent.id, {
      cliSessionId: undefined,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliLastExitCode: null,
      cliLastExitedAt: Date.now(),
      cliResumeAvailable: (agent.cli ?? 'codex') === 'codex' ? agent.cliResumeAvailable ?? true : false,
    })
  }
}

export default function SprintEngineAutoRunSupervisor() {
  const inFlightSpawns = useRef(new Set<string>())
  const sentArtifactApprovalMessages = useRef(new Map<string, number>())
  const autoApprovalDiagnostics = useRef(new Map<string, number>())
  const sentContinuationMessages = useRef(new Map<string, RoleContinuationMessage>())
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
          getSprintEngineAutoState(workspace).enabled
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
            enabled: getSprintEngineAutoState(workspace).enabled,
            keepDoneAgentTerminals: getSprintEngineAutoState(workspace).keepDoneAgentTerminals,
          })),
        })

        for (const workspace of autoWorkspaces) {
          if (disposed) return
          await refreshAutoWorkspaceState(workspace, lastContentByWorkspace)
        }

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
