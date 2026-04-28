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
  getAutoApprovableReadySwarmArtifacts,
  getNextSwarmAgentId,
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
import { sendArtifactApprovalToTerminal } from '../../utils/terminalApproval'

const AUTO_RUN_POLL_MS = 2000
const AUTO_RUN_MAX_CONCURRENT_AGENTS = 2
const AUTO_RUN_PENDING_SPAWN_GRACE_MS = 60000
const DONE_AGENT_TERMINAL_CLOSE_DELAY_MS = 5 * 60 * 1000
const BACKGROUND_TERMINAL_COLS = 100
const BACKGROUND_TERMINAL_ROWS = 30

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
    const content = await window.api.readfile(stateFilePath)
    if (!options.force && lastContentByWorkspace.current.get(workspace.id) === content) {
      return workspace.swarmState
    }

    lastContentByWorkspace.current.set(workspace.id, content)
    const parsedState = parseSwarmStateFile(content, workspace.swarmContext.teamSlug)
    useWorkspaceStore.getState().setSwarmState(workspace.id, parsedState)
    return parsedState
  } catch {
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

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

function normalizeComparablePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const parent = normalizeComparablePath(parentPath)
  const target = normalizeComparablePath(targetPath)
  return target === parent || target.startsWith(`${parent}/`)
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

function resolveArtifactPathForAutoApproval(workspace: Workspace, artifact: SwarmArtifact): string {
  const artifactPath = artifact.path.trim()
  if (!artifactPath) throw new Error('Artifact path is missing.')
  if (/^https?:\/\//i.test(artifactPath)) throw new Error('Remote artifact links cannot be auto-approved.')
  if (artifactPath.split(/[\\/]+/).includes('..')) {
    throw new Error('Artifact path must stay inside the swarm team directory.')
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(artifactPath) && !isAbsoluteFilePath(artifactPath)) {
    throw new Error('Only workspace artifact file paths can be auto-approved.')
  }

  const teamDirectory = workspace.swarmContext?.teamDirectoryPath
    ?? getParentDirectoryPath(workspace.swarmContext?.statePath ?? '')
  const workspaceRoot = workspace.folderPath || getParentDirectoryPath(getParentDirectoryPath(teamDirectory))
  const targetPath = isAbsoluteFilePath(artifactPath)
    ? artifactPath
    : [
        joinFilePath(workspaceRoot, artifactPath),
        joinFilePath(teamDirectory, artifactPath),
      ].find((candidate) => isPathInsideOrEqual(teamDirectory, candidate))
        ?? joinFilePath(workspaceRoot, artifactPath)

  if (!isPathInsideOrEqual(teamDirectory, targetPath)) {
    throw new Error('Artifact path must stay inside the swarm team directory.')
  }

  return targetPath
}

async function pauseAutoRunForArtifactApprovalFailure(
  workspace: Workspace,
  artifact: SwarmArtifact,
  message: string,
  extraDetails: string[] = []
): Promise<void> {
  const task = workspace.swarmState?.tasks.find((candidate) => candidate.id === artifact.taskId)
  const state = useWorkspaceStore.getState()
  state.setSwarmAutoEnabled(workspace.id, false)
  state.setSwarmAutoPendingSpawns(workspace.id, [])

  await publishDiagnostic({
    level: 'error',
    source: 'swarm',
    title: 'Artifact auto-approval stopped',
    message,
    details: [
      `Workspace: ${workspace.name}`,
      `Swarm state: ${workspace.swarmContext?.statePath ?? 'Unavailable'}`,
      `Artifact: ${artifact.id} - ${artifact.title}`,
      `Artifact kind: ${artifact.kind}`,
      `Artifact status: ${artifact.status}`,
      `Artifact path: ${artifact.path || 'No file path recorded'}`,
      `Task: ${artifact.taskId || 'No task'}${task ? ` - ${task.title}` : ''}`,
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

function resolveArtifactProducerAgentId(
  workspace: Workspace,
  swarmState: SwarmState,
  artifact: SwarmArtifact
): string | null {
  const roster = buildSwarmAgentRosterForState(swarmState)
  const rosterById = Object.fromEntries(roster.map((agent) => [agent.id, agent]))
  const task = swarmState.tasks.find((candidate) => candidate.id === artifact.taskId)
  const createdBy = artifact.createdBy.trim()

  if (createdBy && (rosterById[createdBy] || workspace.agents[createdBy] || swarmState.swarmAgents[createdBy])) {
    return createdBy
  }

  if (task?.ownerAgentId) return task.ownerAgentId

  if (task) {
    const runningRoleAgents = roster.filter((agent) =>
      agent.role === task.role && Boolean(workspace.agents[agent.id]?.cliStartRequested)
    )
    if (runningRoleAgents.length === 1) return runningRoleAgents[0].id
  }

  return null
}

function artifactApprovalMessageKey(workspace: Workspace, artifact: SwarmArtifact): string {
  return [
    workspace.id,
    artifact.id,
    artifact.fingerprint ?? '',
    artifact.updatedAt ?? '',
  ].join(':')
}

async function findRunningAgentSession(
  workspace: Workspace,
  agentId: string
): Promise<TerminalSessionSnapshot | null> {
  const agent = workspace.agents[agentId]
  const sessions = await window.api.terminalList()
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
  })
  revealAutoRunAgentTerminal(workspace.id, agentId, agent?.name ?? agentId)
  return runningSession
}

async function sendApprovalToNextEligibleArtifactProducer(
  workspace: Workspace,
  swarmState: SwarmState,
  sentArtifactApprovalMessages: MutableRefObject<Set<string>>
): Promise<'sent' | 'failed' | 'none'> {
  if (!workspace.swarmAutoState.enabled || !workspace.swarmAutoState.autoApproveArtifacts || !workspace.swarmContext) {
    return 'none'
  }

  const artifact = getAutoApprovableReadySwarmArtifacts(swarmState).find((candidate) =>
    !sentArtifactApprovalMessages.current.has(artifactApprovalMessageKey(workspace, candidate))
  )
  if (!artifact) return 'none'

  const approvalKey = artifactApprovalMessageKey(workspace, artifact)
  try {
    const artifactPath = resolveArtifactPathForAutoApproval(workspace, artifact)
    if (!(await window.api.pathExists(artifactPath))) {
      await pauseAutoRunForArtifactApprovalFailure(
        workspace,
        artifact,
        'Cannot approve: artifact file is missing.',
        [`Resolved path: ${artifactPath}`]
      )
      return 'failed'
    }

    try {
      await window.api.readfile(artifactPath)
    } catch (error) {
      await pauseAutoRunForArtifactApprovalFailure(
        workspace,
        artifact,
        'Cannot approve: artifact file is unreadable.',
        [
          `Resolved path: ${artifactPath}`,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        ]
      )
      return 'failed'
    }

    const producerAgentId = resolveArtifactProducerAgentId(workspace, swarmState, artifact)
    if (!producerAgentId) {
      await pauseAutoRunForArtifactApprovalFailure(
        workspace,
        artifact,
        'Cannot approve: no producer terminal is linked to this artifact.'
      )
      return 'failed'
    }

    const producerSession = await findRunningAgentSession(workspace, producerAgentId)
    if (!producerSession) {
      await pauseAutoRunForArtifactApprovalFailure(
        workspace,
        artifact,
        'Cannot approve: the producer CLI is not running.',
        [`Producer agent: ${producerAgentId}`]
      )
      return 'failed'
    }

    await sendArtifactApprovalToTerminal(producerSession.sessionId)
    sentArtifactApprovalMessages.current.add(approvalKey)
    return 'sent'
  } catch (error) {
    await pauseAutoRunForArtifactApprovalFailure(
      workspace,
      artifact,
      error instanceof Error ? error.message : 'Approval failed. Review manually or retry.'
    )
    return 'failed'
  }
}

function getNextAvailableSwarmAgentId(
  role: SwarmRole,
  swarmAgents: SwarmState['swarmAgents'],
  usedAgentIds: Set<string>
): string {
  const syntheticAgents = { ...swarmAgents }
  let agentId = getNextSwarmAgentId(role, syntheticAgents)

  while (usedAgentIds.has(agentId)) {
    syntheticAgents[agentId] = { role, status: 'idle', currentTaskId: null }
    agentId = getNextSwarmAgentId(role, syntheticAgents)
  }

  return agentId
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

  const roster = buildSwarmAgentRosterForState(swarmState)
  const rosterById = Object.fromEntries(roster.map((agent) => [agent.id, agent]))
  const runtimeAgentById = Object.fromEntries(
    roster.map((agent) => [
      agent.id,
      {
        role: swarmState.swarmAgents[agent.id]?.role ?? agent.role,
        status: swarmState.swarmAgents[agent.id]?.status ?? 'idle',
      },
    ])
  )
  const pendingTaskIds = new Set(options.pendingSpawns.map((pending) => pending.taskId))
  const pendingAgentIds = new Set(options.pendingSpawns.map((pending) => pending.agentId))
  const usedAgentIds = new Set<string>([
    ...Object.keys(swarmState.swarmAgents),
    ...Object.keys(workspace.agents),
    ...pendingAgentIds,
    ...options.runningAgentIds,
  ])
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
    usedAgentIds.add(agentId)
    return true
  }

  const activeTasks = swarmState.tasks.filter((task) =>
    task.status === 'in_progress' && Boolean(task.ownerAgentId)
  )

  for (const task of activeTasks) {
    if (candidates.length >= options.limit) break
    const agentId = task.ownerAgentId
    if (!agentId) continue
    const rosterAgent = rosterById[agentId]
    addCandidate(task, agentId, workspace.agents[agentId]?.name ?? rosterAgent?.label ?? agentId)
  }

  const readyTasks = swarmState.tasks.filter((task) =>
    getSwarmTaskBoardColumn(task, swarmState.tasks) === 'ready' && !task.ownerAgentId
  )

  for (const task of readyTasks) {
    if (candidates.length >= options.limit) break

    const existingAgent = roster.find((agent) =>
      agent.role === task.role
      && runtimeAgentById[agent.id]?.status !== 'done'
      && !workspace.agents[agent.id]?.cliStartRequested
      && !pendingAgentIds.has(agent.id)
      && !selectedAgentIds.has(agent.id)
      && !options.runningAgentIds.has(agent.id)
      && !hasInFlightSpawn(agent.id)
    )
    const agent = existingAgent ?? {
      id: getNextAvailableSwarmAgentId(task.role, swarmState.swarmAgents, usedAgentIds),
      label: swarmRoleLabels[task.role],
      role: task.role,
    }

    addCandidate(task, agent.id, agent.label)
  }

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
  const sessions = await window.api.terminalList().catch(() => [])
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
      await window.api.terminalKill(session.sessionId)
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
  const sessions = await window.api.terminalList().catch(() => [])

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
      })
    }
  }

  return runningAgentIds
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
  sentArtifactApprovalMessages: MutableRefObject<Set<string>>,
  lastContentByWorkspace: MutableRefObject<Map<string, string>>
): Promise<void> {
  let swarmState = workspace.swarmState
  if (!workspace.swarmAutoState.enabled || !workspace.folderPath || !swarmState || !workspace.swarmContext) return

  while (workspace.swarmAutoState.enabled && workspace.swarmAutoState.autoApproveArtifacts) {
    const approvalResult = await sendApprovalToNextEligibleArtifactProducer(
      workspace,
      swarmState,
      sentArtifactApprovalMessages
    )
    if (approvalResult === 'none') break
    if (approvalResult === 'failed') return

    const refreshedSwarmState = await refreshAutoWorkspaceState(workspace, lastContentByWorkspace, { force: true })
    if (!refreshedSwarmState) {
      const messageSentArtifactIds = new Set(
        getAutoApprovableReadySwarmArtifacts(swarmState).map((artifact) => artifact.id)
      )
      const artifact = swarmState.artifacts.find((candidate) => messageSentArtifactIds.has(candidate.id))
      if (artifact) {
        await pauseAutoRunForArtifactApprovalFailure(
          workspace,
          artifact,
          'Could not refresh swarm state. Auto has paused.'
        )
      } else {
        useWorkspaceStore.getState().setSwarmAutoEnabled(workspace.id, false)
      }
      return
    }

    const refreshedWorkspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
    if (!refreshedWorkspace) return
    workspace = refreshedWorkspace
    swarmState = refreshedWorkspace.swarmState ?? refreshedSwarmState
  }

  const pendingSpawns = await reconcileAutoRunPendingSpawns(workspace, swarmState)

  const runtimeAgents = Object.values(swarmState.swarmAgents)
  if (runtimeAgents.some((agent) => agent.status === 'needs_input')) {
    return
  }

  if (swarmState.tasks.some((task) => task.status === 'needs_input')) {
    return
  }

  if (swarmState.tasks.length > 0 && swarmState.tasks.every((task) => task.status === 'done')) {
    useWorkspaceStore.getState().setSwarmAutoEnabled(workspace.id, false)
    return
  }

  const runningAgentIds = await getRunningAutoRunAgentIds(workspace, swarmState)
  const occupiedAgentIds = new Set<string>([
    ...runningAgentIds,
    ...pendingSpawns.map((pending) => pending.agentId),
  ])
  for (const spawnKey of inFlightSpawns.current) {
    if (!spawnKey.startsWith(`${workspace.id}:`)) continue
    occupiedAgentIds.add(spawnKey.slice(workspace.id.length + 1))
  }
  const availableSlots = AUTO_RUN_MAX_CONCURRENT_AGENTS - occupiedAgentIds.size
  if (availableSlots <= 0) return

  const nextRuns = pickNextAutoRuns(workspace, swarmState, {
    limit: availableSlots,
    pendingSpawns,
    runningAgentIds,
    inFlightSpawns: inFlightSpawns.current,
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
  const sentArtifactApprovalMessages = useRef(new Set<string>())
  const lastContentByWorkspace = useRef(new Map<string, string>())
  const doneAgentTerminalObservations = useRef(new Map<string, DoneAgentTerminalObservation>())
  const tickInProgress = useRef(false)

  useEffect(() => {
    let disposed = false

    const tick = async () => {
      if (tickInProgress.current) return
      tickInProgress.current = true

      try {
        const { workspaces, appSettings } = useWorkspaceStore.getState()
        const autoWorkspaces = workspaces.filter((workspace) =>
          workspace.swarmAutoState.enabled || shouldCloseDoneAgentTerminals(workspace)
        )

        for (const workspace of autoWorkspaces) {
          if (disposed) return
          await refreshAutoWorkspaceState(workspace, lastContentByWorkspace)
        }

        const refreshedState = useWorkspaceStore.getState()
        for (const workspace of refreshedState.workspaces) {
          if (disposed) return
          await reconcileWorkspaceSessions(workspace)
        }

        const reconciledState = useWorkspaceStore.getState()
        for (const workspace of reconciledState.workspaces) {
          if (disposed) return
          const swarmState = workspace.swarmState
          if (!swarmState) continue
          await closeDoneAgentSessions(workspace, swarmState, doneAgentTerminalObservations)
        }

        const cleanedState = useWorkspaceStore.getState()
        for (const workspace of cleanedState.workspaces) {
          if (disposed) return
          await superviseWorkspace(
            workspace,
            appSettings.cliRuntimes,
            inFlightSpawns,
            sentArtifactApprovalMessages,
            lastContentByWorkspace
          )
        }
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
