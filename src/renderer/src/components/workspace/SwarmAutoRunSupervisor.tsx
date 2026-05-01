import { useEffect, useRef, type MutableRefObject } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentCli,
  CliRuntimeSettings,
  SwarmArtifact,
  SwarmAutoPendingSpawn,
  SwarmRole,
  SwarmState,
  SwarmTask,
  Workspace,
} from '../../types/workspace'
import { buildSwarmStartupPrompt, getSwarmStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
import {
  buildSwarmAgentRosterForState,
  getSwarmArtifactAutoApprovalEligibility,
  getSwarmTaskBoardColumn,
  swarmRoleLabels,
} from '../../utils/swarm'
import { parseSwarmStateFile } from '../../utils/swarmStateFile'
import {
  ensureAgentTabInLayoutModel,
  focusOrAddAgentTab,
  removeAgentTab,
  removeAgentTabFromLayoutModel,
} from '../../utils/modelRegistry'
import { publishDiagnostic } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { MULTICODE_DISABLE_SWARM_AUTORUN } from '../../utils/runtimeFlags'
import { sendArtifactApprovalToTerminal } from '../../utils/terminalApproval'

const AUTO_RUN_POLL_MS = 2000
const INACTIVE_AUTO_RUN_POLL_MS = 15000
const AUTO_RUN_STARTUP_SPAWN_DELAY_MS = 10000
const AUTO_RUN_MAX_CONCURRENT_AGENTS = 2
const AUTO_RUN_PENDING_SPAWN_GRACE_MS = 60000
const ARTIFACT_AUTO_APPROVAL_RETRY_MS = 60000
const AUTO_APPROVAL_DIAGNOSTIC_COOLDOWN_MS = 30000
const TERMINAL_IPC_TIMEOUT_MS = 3000
const DONE_AGENT_TERMINAL_CLOSE_DELAY_MS = 5 * 60 * 1000
const BACKGROUND_TERMINAL_COLS = 100
const BACKGROUND_TERMINAL_ROWS = 30
const NEEDS_INPUT_AUTO_APPROVAL_STATUSES = new Set<SwarmArtifact['status']>([
  'draft',
  'ready_for_review',
  'changes_requested',
])
type AutoRunCandidate = {
  agentId: string
  label: string
  role: SwarmRole
  taskId: string
}

type AutoRunWorktreeSpec = {
  id: string
  name: string
  branch: string
  containerPath: string
  destinationPath: string
}

type AutoRunWorktreeResult =
  | { ok: true; spec: AutoRunWorktreeSpec; path: string; branch: string | null }
  | { ok: false; spec: AutoRunWorktreeSpec; message: string; details?: string[] }

type SwarmAutoStateWithWorktreeIsolation = Workspace['swarmAutoState'] & {
  isolateWorkersInWorktrees?: boolean
}

type DoneAgentTerminalObservation = {
  firstSeenAt: number
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
  logPerfEvent('SwarmAutoRun', 'terminal-list-start', {
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
    logPerfEvent('SwarmAutoRun', 'terminal-list-end', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      sessionCount: sessions.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    })
    return sessions
  } catch (error) {
    logPerfEvent('SwarmAutoRun', 'terminal-list-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      elapsedMs: Math.round(performance.now() - startedAt),
      message: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

function revealAutoRunAgentTerminal(workspaceId: string, agentId: string, label: string): void {
  if (focusOrAddAgentTab(workspaceId, agentId, label)) return

  const state = useWorkspaceStore.getState()
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!workspace) return

  try {
    state.updateLayout(
      workspaceId,
      ensureAgentTabInLayoutModel(workspace.layoutModel, agentId, label)
    )
  } catch {
    // The running session remains available in the session manager if the
    // serialized layout cannot be adjusted before the workspace mounts.
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
    || (workspace.swarmContext && session.swarmStatePath !== workspace.swarmContext.statePath)
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
): Promise<SwarmState | null> {
  if (!workspace.folderPath || !workspace.swarmState || !workspace.swarmContext) {
    return null
  }

  const stateFilePath = workspace.swarmContext.statePath

  try {
    const startedAt = performance.now()
    const content = await window.api.readfile(stateFilePath)
    if (!options.force && lastContentByWorkspace.current.get(workspace.id) === content) {
      logPerfEvent('SwarmAutoRun', 'refresh-state', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        changed: false,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
      return workspace.swarmState
    }

    lastContentByWorkspace.current.set(workspace.id, content)
    const parsedState = parseSwarmStateFile(content, workspace.swarmContext.teamSlug)
    useWorkspaceStore.getState().setSwarmState(workspace.id, parsedState)
    logPerfEvent('SwarmAutoRun', 'refresh-state', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      changed: true,
      elapsedMs: Math.round(performance.now() - startedAt),
      taskCount: parsedState.tasks.length,
      artifactCount: parsedState.artifacts.length,
    })
    return parsedState
  } catch (error) {
    logPerfEvent('SwarmAutoRun', 'refresh-state-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      message: error instanceof Error ? error.message : String(error),
    })
    // Auto mode can be enabled before the agent-managed state file exists.
    return null
  }
}

function getParentDirectoryPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : trimmed
}

function getBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed
}

function joinFilePath(basePath: string, childPath: string): string {
  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${childPath.replace(/^[\\/]+/, '')}`
}

function defaultWorktreeContainerPath(repoRoot: string): string {
  return joinFilePath(
    joinFilePath(getParentDirectoryPath(repoRoot), '.multicode-worktrees'),
    getBaseName(repoRoot)
  )
}

function slugifyWorktreeToken(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')

  return slug || fallback
}

function normalizeComparablePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

function sameFilePath(firstPath: string, secondPath: string): boolean {
  return normalizeComparablePath(firstPath) === normalizeComparablePath(secondPath)
}

function isSwarmWorktreeIsolationEnabled(workspace: Workspace): boolean {
  return Boolean((workspace.swarmAutoState as SwarmAutoStateWithWorktreeIsolation).isolateWorkersInWorktrees)
}

function shouldCloseDoneAgentTerminals(workspace: Workspace): boolean {
  return workspace.mode === 'swarm'
    && Boolean(workspace.swarmState)
    && !workspace.swarmAutoState.keepDoneAgentTerminals
}

function buildAutoRunWorktreeSpec(
  workspace: Workspace,
  nextRun: { agentId: string; taskId: string }
): AutoRunWorktreeSpec {
  if (!workspace.folderPath || !workspace.swarmContext) {
    throw new Error('Workspace folder and swarm context are required.')
  }

  const teamSlug = slugifyWorktreeToken(workspace.swarmContext.teamSlug, 'swarm')
  const taskSlug = slugifyWorktreeToken(nextRun.taskId, 'task')
  const agentSlug = slugifyWorktreeToken(nextRun.agentId, 'agent')
  const name = `${taskSlug}-${agentSlug}`
  const containerPath = workspace.worktreeState?.containerPath
    ?? defaultWorktreeContainerPath(workspace.folderPath)

  return {
    id: `swarm-${teamSlug}-${name}`,
    name,
    branch: `multicode/${teamSlug}/${name}`,
    containerPath,
    destinationPath: joinFilePath(containerPath, name),
  }
}

async function publishArtifactApprovalWarning(
  workspace: Workspace,
  artifact: SwarmArtifact,
  message: string,
  extraDetails: string[] = []
): Promise<void> {
  const task = workspace.swarmState?.tasks.find((candidate) => candidate.id === artifact.taskId)

  await publishDiagnostic({
    level: 'warning',
    source: 'swarm',
    title: 'Artifact auto-approval skipped',
    message,
    details: [
      `Workspace: ${workspace.name}`,
      `Swarm state: ${workspace.swarmContext?.statePath ?? 'Unavailable'}`,
      `Artifact: ${artifact.id} - ${artifact.title}`,
      `Artifact kind: ${artifact.kind}`,
      `Artifact status: ${artifact.status}`,
      `Artifact path: ${artifact.path || 'No file path recorded'}`,
      `Task: ${artifact.taskId || 'No task'}${task ? ` - ${task.title}` : ''}`,
      'Auto-run remains enabled.',
      ...extraDetails,
    ].join('\n'),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    taskId: artifact.taskId || undefined,
  })
}

async function pauseAutoRunForWorktreeFailure(
  workspace: Workspace,
  nextRun: { agentId: string; label: string; taskId: string },
  result: Extract<AutoRunWorktreeResult, { ok: false }>
): Promise<void> {
  const state = useWorkspaceStore.getState()
  state.setSwarmAutoEnabled(workspace.id, false)
  state.setSwarmAutoPendingSpawns(workspace.id, [])
  state.updateAgent(workspace.id, nextRun.agentId, {
    cliStartRequested: false,
    cliHasLaunched: false,
    cliOnboardingPromptSent: false,
  })

  await publishDiagnostic({
    level: 'error',
    source: 'git',
    title: `${nextRun.label} was not started`,
    message: result.message,
    details: [
      `Workspace: ${workspace.name}`,
      `Agent: ${nextRun.agentId}`,
      `Task: ${nextRun.taskId}`,
      `Worktree id: ${result.spec.id}`,
      `Worktree path: ${result.spec.destinationPath}`,
      `Branch: ${result.spec.branch}`,
      ...(result.details ?? []),
    ].join('\n'),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    agentId: nextRun.agentId,
    taskId: nextRun.taskId,
  })
}

async function ensureAutoRunWorktree(
  workspace: Workspace,
  nextRun: { agentId: string; taskId: string }
): Promise<AutoRunWorktreeResult> {
  const spec = buildAutoRunWorktreeSpec(workspace, nextRun)
  const repoRoot = workspace.folderPath
  if (!repoRoot) {
    return { ok: false, spec, message: 'Workspace folder is not available.' }
  }

  const state = useWorkspaceStore.getState()
  state.setWorkspaceWorktreeState(workspace.id, { containerPath: spec.containerPath })

  const listedResult = await window.api.listGitWorktrees(repoRoot)
  if (!listedResult.ok) {
    return {
      ok: false,
      spec,
      message: listedResult.message,
      details: [
        listedResult.stderr ? `stderr: ${listedResult.stderr}` : '',
        listedResult.stdout ? `stdout: ${listedResult.stdout}` : '',
      ].filter(Boolean),
    }
  }

  const listedWorktree = listedResult.data.worktrees.find((worktree) =>
    sameFilePath(worktree.path, spec.destinationPath) || worktree.branch === spec.branch
  )

  if (listedWorktree) {
    const worktreeExists = await window.api.pathExists(listedWorktree.path).catch(() => false)
    const now = Date.now()
    if (!worktreeExists) {
      state.upsertWorktreeEntry(workspace.id, {
        id: spec.id,
        path: listedWorktree.path,
        branch: listedWorktree.branch,
        ownerAgentId: nextRun.agentId,
        status: 'missing',
        createdAt: now,
        updatedAt: now,
        missingAt: now,
      })
      return {
        ok: false,
        spec,
        message: `Worktree path is missing: ${listedWorktree.path}. Run worktree prune or remove the stale worktree before retrying auto-run.`,
      }
    }

    state.upsertWorktreeEntry(workspace.id, {
      id: spec.id,
      path: listedWorktree.path,
      branch: listedWorktree.branch,
      ownerAgentId: nextRun.agentId,
      status: 'assigned',
      createdAt: now,
      updatedAt: now,
      missingAt: null,
    })
    return { ok: true, spec, path: listedWorktree.path, branch: listedWorktree.branch }
  }

  const destinationExists = await window.api.pathExists(spec.destinationPath).catch(() => false)
  if (destinationExists) {
    return {
      ok: false,
      spec,
      message: `Worktree destination already exists but is not registered with Git: ${spec.destinationPath}`,
    }
  }

  const createResult = await window.api.createGitWorktree({
    repoRoot,
    containerPath: spec.containerPath,
    destinationPath: spec.destinationPath,
    branchName: spec.branch,
    baseRef: 'HEAD',
    copyIncludedFiles: true,
  })

  if (!createResult.ok) {
    return {
      ok: false,
      spec,
      message: createResult.message,
      details: [
        createResult.stderr ? `stderr: ${createResult.stderr}` : '',
        createResult.stdout ? `stdout: ${createResult.stdout}` : '',
      ].filter(Boolean),
    }
  }

  const now = Date.now()
  state.upsertWorktreeEntry(workspace.id, {
    id: spec.id,
    path: createResult.data.path,
    branch: createResult.data.branch,
    ownerAgentId: nextRun.agentId,
    status: 'assigned',
    createdAt: now,
    updatedAt: now,
    missingAt: null,
  })

  return { ok: true, spec, path: createResult.data.path, branch: createResult.data.branch }
}

function artifactApprovalMessageKey(workspace: Workspace, artifact: SwarmArtifact): string {
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
    source: 'swarm',
    title: input.title,
    message: input.message,
    details: [
      `Workspace: ${workspace.name}`,
      `Swarm state: ${workspace.swarmContext?.statePath ?? 'Unavailable'}`,
      ...(input.details ?? []),
    ].join('\n'),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    agentId: input.agentId,
    taskId: input.taskId,
    sessionId: input.sessionId,
  })
}

function describeNeedsInputAutoApprovalState(swarmState: SwarmState): string[] {
  const needsInputTasks = swarmState.tasks
    .filter((task) => task.status === 'needs_input')
    .map((task) => `${task.id} (${task.role}) owner=${task.ownerAgentId ?? 'none'}`)
  const readyArtifacts = swarmState.artifacts
    .filter((artifact) => artifact.status === 'ready_for_review')
    .map((artifact) => `${artifact.id} kind=${artifact.kind} task=${artifact.taskId || 'none'} createdBy=${artifact.createdBy || 'none'} path=${artifact.path || 'none'}`)

  return [
    `Needs-input tasks: ${needsInputTasks.join(', ') || 'none'}`,
    `Ready artifacts: ${readyArtifacts.join(', ') || 'none'}`,
  ]
}

function getAutoApprovalIntentArtifacts(swarmState: SwarmState): SwarmArtifact[] {
  const tasksById = new Map(swarmState.tasks.map((task) => [task.id, task]))
  const hasNeedsInputTask = swarmState.tasks.some((task) => task.status === 'needs_input')
  return swarmState.artifacts.filter((artifact) => {
    const task = tasksById.get(artifact.taskId)
    if (!task) return false
    if (!artifact.createdBy.trim() && !task.ownerAgentId?.trim()) return false
    if (getSwarmArtifactAutoApprovalEligibility(artifact).eligible) return true
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
    cli: runningSession.cli ?? agent?.cli ?? 'codex',
    kind: 'swarm',
  })
  revealAutoRunAgentTerminal(workspace.id, agentId, agent?.name ?? agentId)
  return runningSession
}

async function sendApprovalToNextEligibleArtifactProducer(
  workspace: Workspace,
  swarmState: SwarmState,
  sentArtifactApprovalMessages: MutableRefObject<Map<string, number>>,
  autoApprovalDiagnostics: MutableRefObject<Map<string, number>>
): Promise<'sent' | 'failed' | 'none'> {
  if (!workspace.swarmAutoState.enabled || !workspace.swarmAutoState.autoApproveArtifacts || !workspace.swarmContext) {
    return 'none'
  }

  const now = Date.now()
  const eligibleArtifacts = getAutoApprovalIntentArtifacts(swarmState)
  const artifact = eligibleArtifacts.find((candidate) =>
    now - (sentArtifactApprovalMessages.current.get(artifactApprovalMessageKey(workspace, candidate)) ?? 0)
      >= ARTIFACT_AUTO_APPROVAL_RETRY_MS
  )
  logPerfEvent('SwarmAutoRun', 'auto-approval-check', {
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
            ...describeNeedsInputAutoApprovalState(swarmState),
          ],
        }
      )
    }
    logPerfEvent('SwarmAutoRun', 'auto-approval-none', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      eligibleArtifactCount: eligibleArtifacts.length,
      needsInputTaskCount: swarmState.tasks.filter((task) => task.status === 'needs_input').length,
    })
    return 'none'
  }

  const approvalKey = artifactApprovalMessageKey(workspace, artifact)
  try {
    const task = swarmState.tasks.find((candidate) => candidate.id === artifact.taskId)
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
    logPerfEvent('SwarmAutoRun', 'auto-approval-error', {
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

function buildAutoRunAgentId(role: SwarmRole, taskId: string): string {
  return `${role}-${slugifyWorktreeToken(taskId, 'task')}`
}

function pickNextAutoRuns(
  workspace: Workspace,
  swarmState: SwarmState,
  options: {
    limit: number
    pendingSpawns: SwarmAutoPendingSpawn[]
    runningAgentIds: Set<string>
    inFlightSpawns: Set<string>
  }
): AutoRunCandidate[] {
  if (options.limit <= 0) return []

  const startedAt = performance.now()
  logPerfEvent('SwarmAutoRun', 'candidate-pick-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    limit: options.limit,
    taskCount: swarmState.tasks.length,
    agentCount: Object.keys(swarmState.swarmAgents).length,
    pendingSpawnCount: options.pendingSpawns.length,
    runningAgentCount: options.runningAgentIds.size,
    inFlightSpawnCount: options.inFlightSpawns.size,
  })
  const roster = buildSwarmAgentRosterForState(swarmState)
  logPerfEvent('SwarmAutoRun', 'candidate-pick-roster', {
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

  const addCandidate = (task: SwarmTask, agentId: string, fallbackLabel: string) => {
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

  const activeTasks = swarmState.tasks.filter((task) =>
    task.status === 'in_progress' && Boolean(task.ownerAgentId)
  )
  logPerfEvent('SwarmAutoRun', 'candidate-pick-active-tasks', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    activeTaskCount: activeTasks.length,
  })

  for (const task of activeTasks) {
    if (candidates.length >= options.limit) break
    const ownerAgentId = task.ownerAgentId
    if (!ownerAgentId) continue
    const agentId = options.runningAgentIds.has(ownerAgentId)
      ? ownerAgentId
      : buildAutoRunAgentId(task.role, task.id)
    const rosterAgent = rosterById[agentId]
    addCandidate(task, agentId, workspace.agents[agentId]?.name ?? rosterAgent?.label ?? agentId)
  }

  const recoverableNeedsInputTasks = swarmState.tasks.filter((task) =>
    task.status === 'needs_input'
    && (!task.ownerAgentId || !options.runningAgentIds.has(task.ownerAgentId))
  )
  logPerfEvent('SwarmAutoRun', 'candidate-pick-recoverable-needs-input-tasks', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    taskCount: recoverableNeedsInputTasks.length,
  })

  for (const task of recoverableNeedsInputTasks) {
    if (candidates.length >= options.limit) break
    const agentId = buildAutoRunAgentId(task.role, task.id)
    addCandidate(task, agentId, agentId)
  }

  const doneTaskIds = new Set(
    swarmState.tasks
      .filter((task) => task.status === 'done')
      .map((task) => task.id)
  )
  const readyTasks = swarmState.tasks.filter((task) =>
    task.status !== 'in_progress'
    && task.status !== 'needs_input'
    && task.status !== 'done'
    && !task.ownerAgentId
    && task.dependsOn.every((dependencyId) => doneTaskIds.has(dependencyId))
  )
  logPerfEvent('SwarmAutoRun', 'candidate-pick-ready-tasks', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    readyTaskCount: readyTasks.length,
  })

  for (const task of readyTasks) {
    if (candidates.length >= options.limit) break
    logPerfEvent('SwarmAutoRun', 'candidate-pick-ready-task', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: task.id,
      role: task.role,
      ownerAgentId: task.ownerAgentId ?? null,
      dependsOnCount: task.dependsOn.length,
    })

    const agent = {
      id: buildAutoRunAgentId(task.role, task.id),
      label: buildAutoRunAgentId(task.role, task.id),
      role: task.role,
    }

    addCandidate(task, agent.id, agent.label)
    logPerfEvent('SwarmAutoRun', 'candidate-pick-ready-task-result', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: task.id,
      selectedAgentId: agent.id,
      selectedAgentRole: agent.role,
      candidateCount: candidates.length,
    })
  }

  logPerfEvent('SwarmAutoRun', 'candidate-pick-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    candidateCount: candidates.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  })
  return candidates
}

function sessionBelongsToWorkspaceSwarm(
  session: TerminalSessionSnapshot,
  workspace: Workspace
): boolean {
  return Boolean(
    session.running
    && session.kind === 'agent'
    && session.workspaceId === workspace.id
    && (!workspace.swarmContext || session.swarmStatePath === workspace.swarmContext.statePath)
  )
}

function doneTerminalObservationKey(workspace: Workspace, agentId: string): string {
  return [
    workspace.id,
    workspace.swarmContext?.statePath ?? '',
    agentId,
  ].join(':')
}

function agentIsDoneForTerminalCleanup(
  swarmState: SwarmState,
  agentId: string
): boolean {
  const runtimeAgent = swarmState.swarmAgents[agentId]
  if (runtimeAgent?.status === 'needs_input') return false

  const ownedTasks = swarmState.tasks.filter((task) => task.ownerAgentId === agentId)
  if (ownedTasks.some((task) => task.status === 'needs_input' || task.status === 'in_progress')) {
    return false
  }

  if (runtimeAgent?.currentTaskId) {
    const currentTask = swarmState.tasks.find((task) => task.id === runtimeAgent.currentTaskId)
    if (currentTask && currentTask.status !== 'done') return false
  }

  if (runtimeAgent?.status === 'done') return true

  return ownedTasks.length > 0 && ownedTasks.every((task) => task.status === 'done')
}

function getDoneAgentIdsForTerminalCleanup(swarmState: SwarmState): string[] {
  const agentIds = new Set<string>(Object.keys(swarmState.swarmAgents))
  swarmState.tasks.forEach((task) => {
    if (task.ownerAgentId) agentIds.add(task.ownerAgentId)
  })
  return [...agentIds].filter((agentId) => agentIsDoneForTerminalCleanup(swarmState, agentId))
}

function clearDoneTerminalObservationsForWorkspace(
  workspace: Workspace,
  doneAgentTerminalObservations: MutableRefObject<Map<string, DoneAgentTerminalObservation>>
): void {
  for (const key of doneAgentTerminalObservations.current.keys()) {
    if (key.startsWith(`${workspace.id}:`)) doneAgentTerminalObservations.current.delete(key)
  }
}

async function closeDoneAgentSessions(
  workspace: Workspace,
  swarmState: SwarmState,
  doneAgentTerminalObservations: MutableRefObject<Map<string, DoneAgentTerminalObservation>>
): Promise<void> {
  if (!shouldCloseDoneAgentTerminals(workspace)) {
    clearDoneTerminalObservationsForWorkspace(workspace, doneAgentTerminalObservations)
    return
  }

  const now = Date.now()
  const sessions = await listTerminalSessionsForAutoRun(workspace, 'close-done')
  const eligibleKeys = new Set<string>()

  for (const agentId of getDoneAgentIdsForTerminalCleanup(swarmState)) {
    const observationKey = doneTerminalObservationKey(workspace, agentId)
    eligibleKeys.add(observationKey)
    const observation = doneAgentTerminalObservations.current.get(observationKey)
    if (!observation) {
      doneAgentTerminalObservations.current.set(observationKey, { firstSeenAt: now })
      continue
    }
    if (now - observation.firstSeenAt < DONE_AGENT_TERMINAL_CLOSE_DELAY_MS) continue

    const agentSessions = sessions.filter((session) =>
      session.agentId === agentId && sessionBelongsToWorkspaceSwarm(session, workspace)
    )
    for (const session of agentSessions) {
      await withTimeout(
        window.api.terminalKill(session.sessionId),
        TERMINAL_IPC_TIMEOUT_MS,
        `Timed out killing terminal session ${session.sessionId}.`
      ).catch(() => {})
    }
    const state = useWorkspaceStore.getState()
    const latestWorkspace = state.workspaces.find((candidate) => candidate.id === workspace.id) ?? workspace
    const hadAgent = Boolean(latestWorkspace.agents[agentId])
    if (hadAgent || agentSessions.length > 0) {
      state.updateAgent(workspace.id, agentId, {
        cliSessionId: undefined,
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliStartupPrompt: undefined,
      })
    }
    if (!removeAgentTab(workspace.id, agentId)) {
      const result = removeAgentTabFromLayoutModel(latestWorkspace.layoutModel, agentId)
      if (result.removed) state.updateLayout(workspace.id, result.layoutModel)
    }
    doneAgentTerminalObservations.current.delete(observationKey)
  }

  for (const key of doneAgentTerminalObservations.current.keys()) {
    if (key.startsWith(`${workspace.id}:`) && !eligibleKeys.has(key)) {
      doneAgentTerminalObservations.current.delete(key)
    }
  }
}

async function agentHasRunningProcess(workspace: Workspace, agentId: string): Promise<boolean> {
  return Boolean(await findRunningAgentSession(workspace, agentId))
}

async function getRunningAutoRunAgentIds(
  workspace: Workspace,
  swarmState: SwarmState
): Promise<Set<string>> {
  const runningAgentIds = new Set<string>()
  const sessions = await listTerminalSessionsForAutoRun(workspace, 'running-agent-ids')

  for (const session of sessions) {
    if (!session.agentId || !sessionBelongsToWorkspaceSwarm(session, workspace)) continue
    const runtimeAgent = swarmState.swarmAgents[session.agentId]
    if (runtimeAgent?.status === 'done') continue
    runningAgentIds.add(session.agentId)
    const agent = workspace.agents[session.agentId]
    if (!agent?.cliStartRequested || agent.cliSessionId !== session.sessionId) {
      useWorkspaceStore.getState().updateAgent(workspace.id, session.agentId, {
        cliSessionId: session.sessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cli: session.cli ?? agent?.cli ?? 'codex',
        kind: 'swarm',
      })
    }
  }

  return runningAgentIds
}

async function reconcileDuplicateAgentSessions(workspace: Workspace): Promise<void> {
  const sessions = await listTerminalSessionsForAutoRun(workspace, 'reconcile-duplicates')
  const sessionsByAgentId = new Map<string, TerminalSessionSnapshot[]>()

  sessions.forEach((session) => {
    if (!session.agentId || !sessionBelongsToWorkspaceSwarm(session, workspace)) return
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
        cli: preferredSession.cli ?? agent?.cli ?? 'codex',
        kind: 'swarm',
      })
    }
  }
}

function setAutoRunPendingSpawns(workspaceId: string, pendingSpawns: SwarmAutoPendingSpawn[]): void {
  useWorkspaceStore.getState().setSwarmAutoPendingSpawns(workspaceId, pendingSpawns)
}

function addAutoRunPendingSpawn(workspaceId: string, pending: SwarmAutoPendingSpawn): void {
  const state = useWorkspaceStore.getState()
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
  const current = workspace?.swarmAutoState.pendingSpawns ?? []
  state.setSwarmAutoPendingSpawns(workspaceId, [
    ...current.filter((candidate) =>
      candidate.taskId !== pending.taskId && candidate.agentId !== pending.agentId
    ),
    pending,
  ])
}

async function reconcileAutoRunPendingSpawns(
  workspace: Workspace,
  swarmState: SwarmState
): Promise<SwarmAutoPendingSpawn[]> {
  const pendingSpawns = workspace.swarmAutoState.pendingSpawns
  if (pendingSpawns.length === 0) return []

  const activePendingSpawns: SwarmAutoPendingSpawn[] = []
  let changed = false

  for (const pending of pendingSpawns) {
    const pendingTask = swarmState.tasks.find((task) => task.id === pending.taskId)
    const pendingTaskStillReady = pendingTask
      ? getSwarmTaskBoardColumn(pendingTask, swarmState.tasks) === 'ready' && !pendingTask.ownerAgentId
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
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
      })
    }
  }

  if (changed) setAutoRunPendingSpawns(workspace.id, activePendingSpawns)
  return activePendingSpawns
}

async function spawnAutoRunCandidate(
  workspace: Workspace,
  swarmState: SwarmState,
  nextRun: AutoRunCandidate,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  inFlightSpawns: MutableRefObject<Set<string>>
): Promise<'started' | 'failed' | 'skipped'> {
  const currentState = useWorkspaceStore.getState()
  const currentWorkspace = currentState.workspaces.find((candidate) => candidate.id === workspace.id)
  const currentAgent = currentWorkspace?.agents[nextRun.agentId]
  const selectedCli: AgentCli = currentAgent?.cli ?? 'codex'
  const sessionId = crypto.randomUUID()
  const spawnKey = `${workspace.id}:${nextRun.agentId}`
  if (inFlightSpawns.current.has(spawnKey)) return 'skipped'

  if (!workspace.folderPath || !workspace.swarmContext) return 'skipped'
  const workspaceFolderPath = workspace.folderPath
  const swarmStatePath = workspace.swarmContext.statePath
  const pendingSpawn = {
    taskId: nextRun.taskId,
    agentId: nextRun.agentId,
    startedAt: Date.now(),
  }
  inFlightSpawns.current.add(spawnKey)

  try {
    const startedAt = performance.now()
    logPerfEvent('SwarmAutoRun', 'spawn-start', {
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
      currentState.setSwarmAutoEnabled(workspace.id, false)
      await publishDiagnostic({
        level: 'error',
        source: 'filesystem',
        title: 'Auto-run stopped',
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

    const latestAgent = useWorkspaceStore
      .getState()
      .workspaces.find((candidate) => candidate.id === workspace.id)
      ?.agents[nextRun.agentId]
    if (latestAgent?.cliStartRequested || latestAgent?.cliSessionId) {
      return 'skipped'
    }

    let executionCwd = workspaceFolderPath
    let executionMode: 'current_workspace' | 'worktree' = 'current_workspace'
    let worktreeId: string | undefined
    let worktreePath: string | undefined

    if (isSwarmWorktreeIsolationEnabled(workspace)) {
      const worktreeResult = await ensureAutoRunWorktree(workspace, nextRun)
      if (!worktreeResult.ok) {
        await pauseAutoRunForWorktreeFailure(workspace, nextRun, worktreeResult)
        return 'failed'
      }

      executionCwd = worktreeResult.path
      executionMode = 'worktree'
      worktreeId = worktreeResult.spec.id
      worktreePath = worktreeResult.path
    }

    const startupPrompt = prependAgentIdentifier(
      buildSwarmStartupPrompt(nextRun.role, nextRun.agentId, swarmState.goal, {
        executionCwd,
        swarmStatePath,
        commandMode: getSwarmStartupCommandMode(nextRun.role, nextRun.agentId, swarmState),
        useWorktreesForSwarms: workspace.swarmAutoState.useWorktreesForSwarms,
      }),
      nextRun.label,
      swarmRoleLabels[nextRun.role]
    )

    addAutoRunPendingSpawn(workspace.id, pendingSpawn)
    currentState.updateAgent(workspace.id, nextRun.agentId, {
      name: nextRun.label,
      execution: {
        mode: executionMode,
        worktreeId: worktreeId ?? null,
        cwd: executionMode === 'worktree' ? executionCwd : null,
      },
      cliStartRequested: true,
      cliSessionId: sessionId,
      cliHasLaunched: true,
      cliOnboardingPromptSent: true,
      cli: selectedCli,
      cliStartupPrompt: undefined,
      kind: 'swarm',
    })

    const terminalMetadata = {
      kind: 'agent',
      workspaceId: workspace.id,
      agentId: nextRun.agentId,
      executionMode,
      worktreeId,
      worktreePath,
      cliPermissionPreset: workspace.swarmAutoState.cliPermissionPreset,
    } as TerminalSpawnMetadata & {
      executionMode: 'current_workspace' | 'worktree'
      worktreeId?: string
      worktreePath?: string
    }

    const spawnResult = await window.api.terminalSpawn(
      sessionId,
      BACKGROUND_TERMINAL_COLS,
      BACKGROUND_TERMINAL_ROWS,
      executionCwd,
      false,
      swarmStatePath,
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
    logPerfEvent('SwarmAutoRun', 'spawn-result', {
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
      latestState.setSwarmAutoEnabled(workspace.id, false)
      setAutoRunPendingSpawns(workspace.id, [])
      latestState.updateAgent(workspace.id, nextRun.agentId, {
        cliStartRequested: true,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
      })
      await publishDiagnostic({
        level: 'error',
        source: 'terminal',
        title: `${nextRun.label} was not started`,
        message: spawnResult.message,
        details: [
          `Workspace: ${workspace.name}`,
          `CLI: ${selectedCli}`,
          `CLI permissions: ${workspace.swarmAutoState.cliPermissionPreset}`,
          `Task: ${nextRun.taskId}`,
          `Session: ${sessionId}`,
          `Cwd: ${executionCwd}`,
          executionMode === 'worktree' ? `Worktree: ${worktreePath ?? 'Unavailable'}` : null,
          `Swarm state: ${swarmStatePath}`,
        ].filter(Boolean).join('\n'),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: nextRun.agentId,
        taskId: nextRun.taskId,
        sessionId,
      })
      revealAutoRunAgentTerminal(workspace.id, nextRun.agentId, nextRun.label)
      return 'failed'
    }

    revealAutoRunAgentTerminal(workspace.id, nextRun.agentId, nextRun.label)
    return 'started'
  } finally {
    inFlightSpawns.current.delete(spawnKey)
  }
}

async function superviseWorkspace(
  workspace: Workspace,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  inFlightSpawns: MutableRefObject<Set<string>>,
  sentArtifactApprovalMessages: MutableRefObject<Map<string, number>>,
  autoApprovalDiagnostics: MutableRefObject<Map<string, number>>,
  lastContentByWorkspace: MutableRefObject<Map<string, string>>
): Promise<void> {
  const superviseStartedAt = performance.now()
  let swarmState = workspace.swarmState
  if (!workspace.swarmAutoState.enabled || !workspace.folderPath || !swarmState || !workspace.swarmContext) return

  logPerfEvent('SwarmAutoRun', 'supervise-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    taskCount: swarmState.tasks.length,
    agentCount: Object.keys(swarmState.swarmAgents).length,
    autoApproveArtifacts: workspace.swarmAutoState.autoApproveArtifacts,
  })

  if (workspace.swarmAutoState.enabled && workspace.swarmAutoState.autoApproveArtifacts) {
    const approvalResult = await sendApprovalToNextEligibleArtifactProducer(
      workspace,
      swarmState,
      sentArtifactApprovalMessages,
      autoApprovalDiagnostics
    )
    if (approvalResult === 'failed') return
    if (approvalResult === 'sent') {
      const refreshedSwarmState = await refreshAutoWorkspaceState(workspace, lastContentByWorkspace, { force: true })
      if (!refreshedSwarmState) {
        const messageSentArtifactIds = new Set(
          getAutoApprovalIntentArtifacts(swarmState).map((artifact) => artifact.id)
        )
        const artifact = swarmState.artifacts.find((candidate) => messageSentArtifactIds.has(candidate.id))
        if (artifact) {
          await publishArtifactApprovalWarning(
            workspace,
            artifact,
            'Could not refresh swarm state after sending approval intent.'
          )
        }
        return
      }

      const refreshedWorkspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
      if (!refreshedWorkspace) return
      workspace = refreshedWorkspace
      swarmState = refreshedWorkspace.swarmState ?? refreshedSwarmState
      logPerfEvent('SwarmAutoRun', 'supervise-stop', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        reason: 'auto-approval-sent',
        elapsedMs: Math.round(performance.now() - superviseStartedAt),
      })
      return
    }
  }

  logPerfEvent('SwarmAutoRun', 'reconcile-pending-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    pendingSpawnCount: workspace.swarmAutoState.pendingSpawns.length,
  })
  const pendingSpawns = await reconcileAutoRunPendingSpawns(workspace, swarmState)
  logPerfEvent('SwarmAutoRun', 'reconcile-pending-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    pendingSpawnCount: pendingSpawns.length,
  })

  logPerfEvent('SwarmAutoRun', 'running-agents-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  })
  const runningAgentIds = await getRunningAutoRunAgentIds(workspace, swarmState)
  logPerfEvent('SwarmAutoRun', 'running-agents-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    runningAgentCount: runningAgentIds.size,
  })

  const runningNeedsInputAgentIds = Object.entries(swarmState.swarmAgents)
    .filter(([, agent]) => agent.status === 'needs_input')
    .map(([agentId]) => agentId)
    .filter((agentId) => runningAgentIds.has(agentId))
  if (runningNeedsInputAgentIds.length > 0) {
    logPerfEvent('SwarmAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'agent-needs-input',
      agentIds: runningNeedsInputAgentIds,
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  const runningNeedsInputTaskIds = swarmState.tasks
    .filter((task) =>
      task.status === 'needs_input'
      && Boolean(task.ownerAgentId)
      && runningAgentIds.has(task.ownerAgentId!)
    )
    .map((task) => task.id)
  if (runningNeedsInputTaskIds.length > 0) {
    logPerfEvent('SwarmAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'task-needs-input',
      taskIds: runningNeedsInputTaskIds,
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  if (swarmState.tasks.length > 0 && swarmState.tasks.every((task) => task.status === 'done')) {
    useWorkspaceStore.getState().setSwarmAutoEnabled(workspace.id, false)
    logPerfEvent('SwarmAutoRun', 'supervise-stop', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: 'all-tasks-done',
      elapsedMs: Math.round(performance.now() - superviseStartedAt),
    })
    return
  }

  const occupiedAgentIds = new Set<string>([
    ...runningAgentIds,
    ...pendingSpawns.map((pending) => pending.agentId),
  ])
  for (const spawnKey of inFlightSpawns.current) {
    if (!spawnKey.startsWith(`${workspace.id}:`)) continue
    occupiedAgentIds.add(spawnKey.slice(workspace.id.length + 1))
  }
  const availableSlots = AUTO_RUN_MAX_CONCURRENT_AGENTS - occupiedAgentIds.size
  logPerfEvent('SwarmAutoRun', 'slots', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    availableSlots,
    occupiedAgentCount: occupiedAgentIds.size,
  })
  if (availableSlots <= 0) {
    logPerfEvent('SwarmAutoRun', 'supervise-stop', {
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
    nextRuns = pickNextAutoRuns(workspace, swarmState, {
      limit: availableSlots,
      pendingSpawns,
      runningAgentIds,
      inFlightSpawns: inFlightSpawns.current,
    })
  } catch (error) {
    logPerfEvent('SwarmAutoRun', 'candidate-pick-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      message: error instanceof Error ? error.message : String(error),
    })
    await publishDiagnostic({
      level: 'warning',
      source: 'swarm',
      title: 'Auto-run skipped this tick',
      message: 'Could not choose the next swarm task to run.',
      details: [
        `Workspace: ${workspace.name}`,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        'Auto-run remains enabled.',
      ].join('\n'),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    })
    return
  }
  logPerfEvent('SwarmAutoRun', 'candidates', {
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
    if (!latestWorkspace?.swarmAutoState.enabled) return
    const spawnResult = await spawnAutoRunCandidate(
      latestWorkspace,
      swarmState,
      nextRun,
      cliRuntimes,
      inFlightSpawns
    )
    if (spawnResult === 'failed') return
  }
}

async function reconcileWorkspaceSessions(workspace: Workspace): Promise<void> {
  await reconcileDuplicateAgentSessions(workspace)

  for (const agent of Object.values(workspace.agents)) {
    if (!agent.cliStartRequested || !agent.cliHasLaunched || !agent.cliSessionId) continue

    const status = await window.api.terminalStatus(agent.cliSessionId)
    if (status.running) continue

    useWorkspaceStore.getState().updateAgent(workspace.id, agent.id, {
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
    })
  }
}

export default function SwarmAutoRunSupervisor() {
  const inFlightSpawns = useRef(new Set<string>())
  const sentArtifactApprovalMessages = useRef(new Map<string, number>())
  const autoApprovalDiagnostics = useRef(new Map<string, number>())
  const lastContentByWorkspace = useRef(new Map<string, string>())
  const lastInactiveTickByWorkspace = useRef(new Map<string, number>())
  const doneAgentTerminalObservations = useRef(new Map<string, DoneAgentTerminalObservation>())
  const startedAt = useRef(Date.now())
  const tickInProgress = useRef(false)

  useEffect(() => {
    if (MULTICODE_DISABLE_SWARM_AUTORUN) {
      console.info('[SwarmAutoRun] disabled by runtime flag')
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
          workspace.swarmAutoState.enabled || shouldCloseDoneAgentTerminals(workspace)
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
        logPerfEvent('SwarmAutoRun', 'tick-start', {
          activeWorkspaceId,
          autoWorkspaceCount: autoWorkspaces.length,
          autoWorkspaces: autoWorkspaces.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            enabled: workspace.swarmAutoState.enabled,
            keepDoneAgentTerminals: workspace.swarmAutoState.keepDoneAgentTerminals,
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

        const reconciledState = useWorkspaceStore.getState()
        for (const workspace of reconciledState.workspaces.filter((candidate) => eligibleWorkspaceIds.has(candidate.id))) {
          if (disposed) return
          const swarmState = workspace.swarmState
          if (!swarmState) continue
          await closeDoneAgentSessions(workspace, swarmState, doneAgentTerminalObservations)
        }

        const cleanedState = useWorkspaceStore.getState()
        const startupSpawnDelayElapsed = Date.now() - startedAt.current >= AUTO_RUN_STARTUP_SPAWN_DELAY_MS
        for (const workspace of cleanedState.workspaces.filter((candidate) => eligibleWorkspaceIds.has(candidate.id))) {
          if (disposed) return
          if (!startupSpawnDelayElapsed) continue
          await superviseWorkspace(
            workspace,
            appSettings.cliRuntimes,
            inFlightSpawns,
            sentArtifactApprovalMessages,
            autoApprovalDiagnostics,
            lastContentByWorkspace
          )
        }
        logPerfEvent('SwarmAutoRun', 'tick-end', {
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
