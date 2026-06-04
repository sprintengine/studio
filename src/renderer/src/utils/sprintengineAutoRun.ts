import type {
  AgentState,
  SprintEngineArtifact,
  SprintEngineAutoPendingSpawn,
  SprintEngineCurrentDispatch,
  SprintEngineEvent,
  SprintEngineQualityGate,
  SprintEngineRoleId,
  SprintEngineState,
  SprintEngineTask,
  Workspace,
} from '../types/workspace'
import {
  buildSprintEngineAgentRosterForState,
  getOpenSprintEngineQualityGates,
  getSprintEngineArtifactAutoApprovalEligibility,
  getSprintEngineTaskBoardColumn,
  isSprintEngineTaskLaunchable,
} from './sprintengine'
import { logPerfEvent } from './perfDiagnostics'

export const AUTO_RUN_ROLE_CONTINUATION_GRACE_MS = 30000

export const NEEDS_INPUT_AUTO_APPROVAL_STATUSES = new Set<SprintEngineArtifact['status']>([
  'draft',
  'ready_for_review',
  'changes_requested',
])

export type AutoRunCandidate = {
  agentId: string
  label: string
  role: SprintEngineRoleId
  taskId: string
  gateId?: string
  startupPromptOverride?: string
}

export type RoleContinuationGrace = {
  startedAt: number
}

export type SprintEngineExitedAgentLike = Pick<
  AgentState,
  'kind' | 'cliLastExitedAt' | 'cliStartRequested' | 'cliHasLaunched'
>

export type SprintEngineAutoRunActiveGateClaim = {
  gate: SprintEngineQualityGate
  claimedBy: string
}

export function sprintEngineAutoRunWorkKey(input: { taskId: string; gateId?: string | null }): string {
  return input.gateId ? `gate:${input.taskId}:${input.gateId}` : `task:${input.taskId}`
}

export function getClaimableSprintEngineAutoRunGates(
  task: SprintEngineTask,
  tasks: SprintEngineTask[]
): SprintEngineQualityGate[] {
  const taskColumn = getSprintEngineTaskBoardColumn(task, tasks)
  return getOpenSprintEngineQualityGates(task).filter(
    (gate) => gate.status === 'pending' && gate.phase === taskColumn
  )
}

export function getActiveSprintEngineAutoRunGateClaims(
  task: SprintEngineTask,
  tasks: SprintEngineTask[]
): SprintEngineAutoRunActiveGateClaim[] {
  const taskColumn = getSprintEngineTaskBoardColumn(task, tasks)
  return getOpenSprintEngineQualityGates(task).flatMap((gate) => {
    if (gate.status !== 'in_progress' || gate.phase !== taskColumn) return []
    const attempt = [...gate.attempts].reverse().find((candidate) =>
      candidate.status === 'in_progress' && typeof candidate.claimedBy === 'string' && candidate.claimedBy
    )
    return attempt?.claimedBy ? [{ gate, claimedBy: attempt.claimedBy }] : []
  })
}

export function isSprintEngineAutoPendingSpawnStillRelevant(
  pending: SprintEngineAutoPendingSpawn,
  task: SprintEngineTask | undefined,
  tasks: SprintEngineTask[]
): boolean {
  if (!task) return false
  if (!pending.gateId) return false
  const taskColumn = getSprintEngineTaskBoardColumn(task, tasks)
  return getOpenSprintEngineQualityGates(task).some((gate) =>
    gate.id === pending.gateId
      && gate.phase === taskColumn
      && (gate.status === 'pending' || gate.status === 'in_progress')
  )
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

function nextDirectivePayloadBlock(role: SprintEngineRoleId | string, agentId: string): string {
  // The managed Sprint Engine MCP server resolves run and workspace routing
  // from the HTTP run context. Agents do not pass statePath or
  // workspaceRoot in tool payloads.
  const payload: Record<string, string> = {
    role,
    agentId,
  }
  return [
    '`sprintengine.agent.next_directive`',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n')
}

export function artifactApprovalMessageKey(workspace: Workspace, artifact: SprintEngineArtifact): string {
  return [
    workspace.id,
    artifact.id,
    artifact.fingerprint ?? '',
    artifact.updatedAt ?? '',
  ].join(':')
}

export function describeNeedsInputAutoApprovalState(sprintEngineState: SprintEngineState): string[] {
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

export function getArchitectActionableNeedsInputTasks(sprintEngineState: SprintEngineState): SprintEngineTask[] {
  const architectRoutedKinds = new Set(['architect', 'artifact', 'tooling', 'verification', 'other'])
  return sprintEngineState.tasks.filter((task) =>
    task.status === 'needs_input' && architectRoutedKinds.has(task.needsInput?.kind ?? '')
  )
}

export function getAutoApprovalIntentArtifacts(sprintEngineState: SprintEngineState): SprintEngineArtifact[] {
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

export function isSprintEngineRunBlockedOnExternalInput(sprintEngineState: SprintEngineState): boolean {
  const incompleteTasks = sprintEngineState.tasks.filter((task) => task.status !== 'done')
  if (incompleteTasks.length === 0) return false

  const tasksById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))
  const externallyBlockedTaskIds = new Set(
    incompleteTasks
      .filter((task) =>
        task.status === 'needs_input'
        && (task.needsInput?.kind === 'external_validation' || task.needsInput?.kind === 'user')
      )
      .map((task) => task.id)
  )
  if (externallyBlockedTaskIds.size === 0) return false

  const hasActiveDispatch = Object.values(sprintEngineState.sprintEngineAgents).some((agent) =>
    agent.status === 'running' || Boolean(agent.currentDispatch)
  )
  if (hasActiveDispatch) return false

  const hasRunnableImplementationTask = sprintEngineState.tasks.some((task) =>
    isSprintEngineAutoRunImplementationWakeCandidate(task, sprintEngineState)
  )
  if (hasRunnableImplementationTask) return false

  const hasOpenGateWork = sprintEngineState.tasks.some((task) => {
    const taskColumn = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
    return getOpenSprintEngineQualityGates(task).some((gate) =>
      gate.phase === taskColumn && (gate.status === 'pending' || gate.status === 'in_progress')
    )
  })
  if (hasOpenGateWork) return false

  const hasReadyArtifactApproval = getAutoApprovalIntentArtifacts(sprintEngineState)
    .some((artifact) => artifact.status === 'ready_for_review')
  if (hasReadyArtifactApproval) return false

  const isBlockedByExternalInput = (taskId: string, seen = new Set<string>()): boolean => {
    if (externallyBlockedTaskIds.has(taskId)) return true
    if (seen.has(taskId)) return false
    seen.add(taskId)
    const task = tasksById.get(taskId)
    if (!task || task.status === 'done') return false
    if (task.status !== 'todo' && task.status !== 'needs_input') return false
    return task.dependsOn.some((dependencyId) => isBlockedByExternalInput(dependencyId, seen))
  }

  return incompleteTasks.every((task) => isBlockedByExternalInput(task.id))
}

export function describeSprintEngineExternalInputAutoRunBlock(
  sprintEngineState: SprintEngineState
): { message: string; details: string; taskId?: string; agentId?: string } {
  const blockedTasks = sprintEngineState.tasks.filter((task) =>
    task.status === 'needs_input'
    && (task.needsInput?.kind === 'external_validation' || task.needsInput?.kind === 'user')
  )
  const primary = blockedTasks[0]
  if (!primary) {
    return {
      message: 'A task needs user or external validation input before agents can continue.',
      details: 'No user or external-validation needs_input task was present when the notification was built.',
    }
  }

  const dependentTaskIds = sprintEngineState.tasks
    .filter((task) => task.status !== 'done' && task.dependsOn.includes(primary.id))
    .map((task) => task.id)
  const question = primary.needsInput?.question?.trim()
  const reason = primary.needsInput?.reason?.trim()
  const owner = primary.ownerAgentId?.trim()
  const details = [
    `Blocking task: ${primary.id} - ${primary.title}`,
    `Needs input from: ${primary.needsInput?.kind ?? 'unknown'}`,
    reason ? `Reason: ${reason}` : null,
    question ? `Question: ${question}` : null,
    owner ? `Owner: ${owner}` : null,
    dependentTaskIds.length > 0 ? `Blocked dependents: ${dependentTaskIds.join(', ')}` : null,
    blockedTasks.length > 1 ? `Other input-blocked tasks: ${blockedTasks.slice(1).map((task) => task.id).join(', ')}` : null,
  ].filter((line): line is string => Boolean(line))

  return {
    message: question
      ? `Waiting on ${primary.id}: ${question}`
      : `Waiting on ${primary.id} (${primary.needsInput?.kind ?? 'input'}).`,
    details: details.join('\n'),
    taskId: primary.id,
    ...(owner ? { agentId: owner } : {}),
  }
}

export function continuationMessageKey(workspace: Workspace, taskId: string, agentId: string): string {
  return [
    workspace.id,
    workspace.sprintEngineContext?.statePath ?? '',
    taskId,
    agentId,
  ].join(':')
}

export function sprintEngineDispatchDeliveryKey(
  workspace: Workspace,
  agentId: string,
  dispatch: SprintEngineCurrentDispatch | null | undefined
): string {
  const durableDispatchId = dispatch?.dispatchId?.trim()
  const fallbackTarget = [
    dispatch?.targetKind ?? 'dispatch',
    dispatch?.taskId ?? '',
    dispatch?.gateId ?? '',
    dispatch?.artifactId ?? '',
    dispatch?.attemptId ?? '',
    dispatch?.reason ?? '',
  ].join(':')
  return [
    workspace.sprintEngineContext?.statePath ?? workspace.id,
    agentId,
    durableDispatchId || fallbackTarget,
  ].join(':')
}

export function architectTriageMessageKey(workspace: Workspace, taskIds: string[], agentId: string): string {
  return [
    workspace.id,
    workspace.sprintEngineContext?.statePath ?? '',
    agentId,
    taskIds.slice().sort().join(','),
  ].join(':')
}

export function buildSprintEngineDispatchPrompt(input: {
  role: SprintEngineRoleId
  agentId: string
  dispatch: SprintEngineCurrentDispatch
}): string {
  return [
    'Sprint Engine dispatch is ready for this terminal.',
    input.dispatch.dispatchId ? `Dispatch: ${input.dispatch.dispatchId}` : null,
    input.dispatch.targetKind ? `Target: ${input.dispatch.targetKind}` : null,
    input.dispatch.taskId ? `Task: ${input.dispatch.taskId}` : null,
    input.dispatch.gateId ? `Gate: ${input.dispatch.gateId}` : null,
    input.dispatch.reason ? `Reason: ${input.dispatch.reason}` : null,
    '',
    'Call the directive tool to reconcile this dispatch and receive the next MCP tool to invoke:',
    nextDirectivePayloadBlock(input.role, input.agentId),
    'The managed Sprint Engine MCP server owns dispatch routing, task/gate claims, and completion handling. Follow the returned `nextMcpToolName` and `nextMcpArguments`.',
  ].filter((line): line is string => line !== null).join('\n')
}

export function agentNotificationDeliveryKey(workspace: Workspace, event: SprintEngineEvent): string {
  return [
    workspace.sprintEngineContext?.statePath ?? workspace.id,
    event.id,
  ].join(':')
}

export function agentOwnsOpenSprintEngineImplementationWork(
  sprintEngineState: SprintEngineState,
  agentId: string
): boolean {
  return sprintEngineState.tasks.some((task) =>
    task.ownerAgentId === agentId
    && task.status === 'in_progress'
  )
}

export function agentHasOpenSprintEngineGateWork(
  sprintEngineState: SprintEngineState,
  agentId: string,
  role: SprintEngineRoleId
): boolean {
  return sprintEngineState.tasks.some((task) => {
    const taskColumn = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
    return getOpenSprintEngineQualityGates(task).some((gate) => {
      if (gate.phase !== taskColumn || gate.role !== role) return false
      if (gate.status === 'pending') return true
      if (gate.status !== 'in_progress') return false
      return gate.attempts.some((attempt) =>
        attempt.status === 'in_progress' && attempt.claimedBy === agentId
      )
    })
  })
}

export function roleHasClaimableSprintEngineImplementationWork(
  sprintEngineState: SprintEngineState,
  role: SprintEngineRoleId
): boolean {
  return sprintEngineState.tasks.some((task) =>
    task.role === role && isSprintEngineAutoRunImplementationWakeCandidate(task, sprintEngineState)
  )
}

function isSprintEngineAutoRunImplementationWakeCandidate(
  task: SprintEngineTask,
  sprintEngineState: SprintEngineState
): boolean {
  return isSprintEngineTaskLaunchable(task, sprintEngineState)
    || (task.status === 'changes_requested' && getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks) === 'changes_requested')
}

/**
 * Tasks an idle roster agent could wake onto: launchable ready work plus
 * ownerless/own `changes_requested` rework. Shared by the continuation-prompt
 * path and the stalled-agent restart path so both agree on what counts as
 * claimable wake work for a live-idle agent.
 */
export function getSprintEngineWakeCandidateTasks(
  sprintEngineState: SprintEngineState
): SprintEngineTask[] {
  return sprintEngineState.tasks.filter((task) =>
    isSprintEngineAutoRunImplementationWakeCandidate(task, sprintEngineState)
  )
}

export function findSprintEngineWakeCandidateTaskForAgent(
  wakeTasks: SprintEngineTask[],
  role: SprintEngineRoleId,
  agentId: string,
  reservedTaskIds: ReadonlySet<string>
): SprintEngineTask | undefined {
  return wakeTasks.find((candidate) =>
    candidate.role === role
    && !reservedTaskIds.has(candidate.id)
    && (!candidate.ownerAgentId || candidate.ownerAgentId === agentId || candidate.status === 'changes_requested')
  )
}

export function shouldSkipExitedSprintEngineRosterAgent(
  currentAgent: SprintEngineExitedAgentLike | null | undefined,
  hasOpenWork: boolean
): boolean {
  return Boolean(
    currentAgent?.kind === 'sprintengine'
    && currentAgent.cliLastExitedAt
    && !currentAgent.cliStartRequested
    && !currentAgent.cliHasLaunched
    && !hasOpenWork
  )
}

export function getSprintEngineAutoRunOccupiedAgentIds(input: {
  tasks: SprintEngineTask[]
  pendingSpawns: SprintEngineAutoPendingSpawn[]
  inFlightSpawnKeys: Iterable<string>
  workspaceId: string
  runningAgentIds?: ReadonlySet<string>
}): Set<string> {
  const occupiedAgentIds = new Set<string>([
    ...input.tasks
      .filter((task) =>
        (
          task.status === 'in_progress'
          || (task.status === 'needs_input' && (!input.runningAgentIds || input.runningAgentIds.has(task.ownerAgentId ?? '')))
        )
        && Boolean(task.ownerAgentId)
      )
      .map((task) => task.ownerAgentId!),
    ...input.pendingSpawns.map((pending) => pending.agentId),
  ])
  for (const spawnKey of input.inFlightSpawnKeys) {
    if (!spawnKey.startsWith(`${input.workspaceId}:`)) continue
    occupiedAgentIds.add(spawnKey.slice(input.workspaceId.length + 1))
  }
  return occupiedAgentIds
}

export function buildSprintEngineContinuationPrompt(
  task: SprintEngineTask,
  agentId: string
): string {
  return [
    `Sprint Engine roster runner found a wake candidate for a ready ${task.role} task in this idle terminal.`,
    `Task: ${task.id} - ${task.title}`,
    'This is not a durable dispatch assignment; the Sprint Engine state will record one only after you claim or resume work through MCP.',
    'Call the directive tool to receive the current MCP-native directive:',
    nextDirectivePayloadBlock(task.role, agentId),
    'If the returned directive includes `nextMcpToolName`, invoke it once with `nextMcpArguments` (typically `sprintengine.task.next`). Multicode owns later runtime dispatch and continuation.',
  ].join('\n')
}

export function buildSprintEngineGateContinuationPrompt(
  task: SprintEngineTask,
  gate: SprintEngineQualityGate,
  agentId: string,
  claimed: boolean
): string {
  return [
    claimed
      ? 'Sprint Engine roster runner found an active quality gate already claimed by this terminal.'
      : 'Sprint Engine roster runner found a wake candidate for a quality gate in this terminal.',
    `Task: ${task.id} - ${task.title}`,
    `Gate: ${gate.id} (${gate.phase} / ${gate.role})`,
    claimed
      ? 'This claimed gate has a durable dispatch assignment that the directive tool will reconcile.'
      : 'This is not a durable gate dispatch assignment; the Sprint Engine state will record one only after you claim the gate through MCP.',
    'Call the directive tool to receive the current MCP-native directive:',
    nextDirectivePayloadBlock(gate.role, agentId),
    'The returned directive will name the next MCP tool to invoke — typically `sprintengine.gate.next` for an unclaimed gate, or context for `sprintengine.gate.verdict` / `sprintengine.gate.publish` after review. Record the verdict through MCP.',
  ].join('\n')
}

export const AGENT_COMPLETION_NOTIFICATION_KINDS = new Set<string>([
  'task_completed_after_artifact_approval',
  'task_completed_after_input_resolution',
])

export function isAgentNotificationCompletionEvent(event: SprintEngineEvent): boolean {
  return AGENT_COMPLETION_NOTIFICATION_KINDS.has(event.notificationKind ?? '')
}

export function buildAgentNotificationPrompt(
  event: SprintEngineEvent,
  options: { agentId?: string; role?: SprintEngineRoleId } = {}
): string {
  const isCompletion = isAgentNotificationCompletionEvent(event)
  const taskReadCall = !isCompletion && event.taskId
    ? `Re-read the current task card via \`sprintengine.task.get\` with \`{ taskId: "${event.taskId}" }\`, then review its feedback comments, notes, acceptance criteria, and evidence before continuing. Do not claim a new task.`
    : isCompletion
      ? 'Your Sprint Engine task is complete. Do not claim another task in this terminal unless explicitly instructed.'
      : 'Re-read the current task card via `sprintengine.task.get`, then review its feedback comments, notes, acceptance criteria, and evidence before continuing. Do not claim a new task.'
  const reconcileBlock = !isCompletion && options.agentId && options.role
    ? [
      'Then call the directive tool to reconcile this notification:',
      nextDirectivePayloadBlock(options.role, options.agentId),
      'If the returned directive includes `nextMcpToolName`, invoke it once with `nextMcpArguments`. Multicode owns later runtime dispatch and continuation.',
    ].join('\n')
    : null

  return [
    'Sprint Engine notification.',
    event.taskId ? `Task: ${event.taskId}` : null,
    event.artifactId ? `Artifact: ${event.artifactId}` : null,
    event.notificationKind ? `Type: ${event.notificationKind}` : null,
    '',
    event.message,
    '',
    taskReadCall,
    reconcileBlock,
  ].filter((line): line is string => line !== null).join('\n')
}

export function buildArchitectNeedsInputTriagePrompt(input: {
  workspaceFolderPath: string
  sprintEngineStatePath: string
  taskIds: string[]
}): string {
  // The managed Sprint Engine MCP server resolves run routing from the HTTP
  // run context.
  const triagePayload = {
    id: 'architect',
  }
  return [
    'Fetch the canonical Sprint Engine architect triage instructions from the managed Sprint Engine MCP server.',
    `Worker cwd: ${input.workspaceFolderPath}`,
    `Architect-actionable needs_input tasks detected: ${input.taskIds.join(', ')}.`,
    'Call the triage tool through MCP:',
    ['`sprintengine.triage.needs_input`', '```json', JSON.stringify(triagePayload, null, 2), '```'].join('\n'),
    'Follow the returned directive. Resolve planning or task-card blockers only; do not edit application source in this triage mode. Add task notes via `sprintengine.task.note` when the original worker can continue, then stop.',
  ].join('\n\n')
}

export function getPendingAgentNotificationEvents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  deliveredKeys: ReadonlySet<string>,
  alreadySentKeys: ReadonlySet<string>
): SprintEngineEvent[] {
  const seenKeys = new Set<string>()
  const pending: SprintEngineEvent[] = []
  for (const event of sprintEngineState.events) {
    if (event.type !== 'agent_notification_requested') continue
    if (!event.id || !event.targetAgentId) continue
    const deliveryKey = agentNotificationDeliveryKey(workspace, event)
    if (deliveredKeys.has(deliveryKey) || alreadySentKeys.has(deliveryKey)) continue
    // Duplicate event observations (same id appearing more than once in the
    // events array) collapse to a single pending delivery so the supervisor
    // never writes the same notification twice in one tick.
    if (seenKeys.has(deliveryKey)) continue
    seenKeys.add(deliveryKey)
    pending.push(event)
  }
  return pending
}

export type PickNextAutoRunsOptions = {
  limit: number
  pendingSpawns: SprintEngineAutoPendingSpawn[]
  runningAgentIds: ReadonlySet<string>
  inFlightSpawns: ReadonlySet<string>
  continuationCapacityByRole: ReadonlyMap<SprintEngineRoleId, number>
  continuationGraceByTask: Map<string, RoleContinuationGrace>
  /** Read-only access to existing agent name overrides; defaults to label fallback when absent. */
  agentLabelById?: (agentId: string) => string | undefined
}

export function pickNextAutoRuns(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  options: PickNextAutoRunsOptions
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
  const labelFor = (agentId: string, fallback: string): string =>
    options.agentLabelById?.(agentId) ?? workspace.agents[agentId]?.name ?? fallback
  const workKeyForCandidate = (task: SprintEngineTask, gateId?: string) =>
    sprintEngineAutoRunWorkKey({ taskId: task.id, gateId })
  const pendingWorkKeys = new Set(options.pendingSpawns.map((pending) => sprintEngineAutoRunWorkKey(pending)))
  const pendingAgentIds = new Set(options.pendingSpawns.map((pending) => pending.agentId))
  const selectedTaskIds = new Set<string>()
  const selectedWorkKeys = new Set<string>()
  const selectedAgentIds = new Set<string>()
  const candidates: AutoRunCandidate[] = []

  const hasInFlightSpawn = (agentId: string) =>
    options.inFlightSpawns.has(`${workspace.id}:${agentId}`)

  const findReusableRoleAgent = (role: SprintEngineRoleId): AutoRunCandidate['agentId'] | null => {
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

  const addCandidate = (
    task: SprintEngineTask,
    agentId: string,
    fallbackLabel: string,
    addOptions: { allowSharedTask?: boolean; agentRole?: SprintEngineRoleId; gateId?: string } = {}
  ) => {
    if (candidates.length >= options.limit) return false
    const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
    if (runtimeAgent?.status === 'retired') return false
    const workKey = workKeyForCandidate(task, addOptions.gateId)
    if (pendingWorkKeys.has(workKey) || selectedWorkKeys.has(workKey)) return false
    if (!addOptions.allowSharedTask && selectedTaskIds.has(task.id)) return false
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
      label: labelFor(agentId, fallbackLabel),
      role: addOptions.agentRole ?? task.role,
      taskId: task.id,
      ...(addOptions.gateId ? { gateId: addOptions.gateId } : {}),
    })
    selectedTaskIds.add(task.id)
    selectedWorkKeys.add(workKey)
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
    addCandidate(task, agentId, rosterAgent?.label ?? agentId)
  }

  const readyTasks = sprintEngineState.tasks.filter((task) =>
    isSprintEngineAutoRunImplementationWakeCandidate(task, sprintEngineState)
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
  const reservedContinuationByRole = new Map<SprintEngineRoleId, number>()

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

  // Lifecycle phase tasks (review/testing/product) keep auto-run running even
  // when no implementation task is ready: each pending required gate maps to
  // a reviewer/tester/product role, and we spawn an idle roster agent for that
  // role so the spawned terminal's `sprintengine.agent.next_directive` MCP call
  // can decide whether a gate or other ready task is the next claim. We never
  // claim the gate from the renderer — that stays an MCP mutation through
  // `sprintengine.gate.next` / `sprintengine.gate.claim`.
  const gatedPhaseTasks = sprintEngineState.tasks.filter((task) => {
    const column = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
    return column === 'review' || column === 'testing' || column === 'product'
  })
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-gated-tasks', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    gatedTaskCount: gatedPhaseTasks.length,
  })

  for (const task of gatedPhaseTasks) {
    if (candidates.length >= options.limit) break
    const activeGateClaims = getActiveSprintEngineAutoRunGateClaims(task, sprintEngineState.tasks)
    for (const claim of activeGateClaims) {
      if (candidates.length >= options.limit) break
      const reviewerAgent = rosterById[claim.claimedBy] ?? {
        id: claim.claimedBy,
        label: claim.claimedBy,
        role: claim.gate.role,
      }
      addCandidate(task, reviewerAgent.id, reviewerAgent.label, {
        allowSharedTask: true,
        agentRole: claim.gate.role,
        gateId: claim.gate.id,
      })
      logPerfEvent('SprintEngineAutoRun', 'candidate-pick-gated-resume-result', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        gateId: claim.gate.id,
        gateRole: claim.gate.role,
        selectedAgentId: reviewerAgent.id,
      })
    }

    const claimableGates = getClaimableSprintEngineAutoRunGates(task, sprintEngineState.tasks)
    for (const gate of claimableGates) {
      if (candidates.length >= options.limit) break
      const reviewerAgentId = findReusableRoleAgent(gate.role)
      // Missing roster roles do not create dead launch queues — we simply skip
      // the gate and the CLI verdict path stays the only completion route.
      if (!reviewerAgentId) {
        logPerfEvent('SprintEngineAutoRun', 'candidate-pick-gated-no-roster-agent', {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          taskId: task.id,
          gateId: gate.id,
          gateRole: gate.role,
        })
        continue
      }
      const reviewerAgent = rosterById[reviewerAgentId] ?? {
        id: reviewerAgentId,
        label: reviewerAgentId,
        role: gate.role,
      }
      addCandidate(task, reviewerAgent.id, reviewerAgent.label, {
        allowSharedTask: true,
        agentRole: gate.role,
        gateId: gate.id,
      })
      logPerfEvent('SprintEngineAutoRun', 'candidate-pick-gated-result', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        gateId: gate.id,
        gateRole: gate.role,
        selectedAgentId: reviewerAgent.id,
      })
    }
  }

  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    candidateCount: candidates.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  })
  return candidates
}
