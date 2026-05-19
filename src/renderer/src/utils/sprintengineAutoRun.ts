import type {
  AgentState,
  SprintEngineArtifact,
  SprintEngineAutoPendingSpawn,
  SprintEngineEvent,
  SprintEngineQualityGate,
  SprintEngineRole,
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
  role: SprintEngineRole
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

export function quoteShellArg(value: string): string {
  return JSON.stringify(value)
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

export function continuationMessageKey(workspace: Workspace, taskId: string, agentId: string): string {
  return [
    workspace.id,
    workspace.sprintEngineContext?.statePath ?? '',
    taskId,
    agentId,
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
    && (task.status === 'in_progress' || task.status === 'changes_requested')
  )
}

export function shouldSkipExitedSprintEngineRosterAgent(
  currentAgent: SprintEngineExitedAgentLike | null | undefined,
  ownsOpenImplementationWork: boolean
): boolean {
  return Boolean(
    currentAgent?.kind === 'sprintengine'
    && currentAgent.cliLastExitedAt
    && !currentAgent.cliStartRequested
    && !currentAgent.cliHasLaunched
    && !ownsOpenImplementationWork
  )
}

export function getSprintEngineAutoRunOccupiedAgentIds(input: {
  tasks: SprintEngineTask[]
  pendingSpawns: SprintEngineAutoPendingSpawn[]
  inFlightSpawnKeys: Iterable<string>
  workspaceId: string
}): Set<string> {
  const occupiedAgentIds = new Set<string>([
    ...input.tasks
      .filter((task) =>
        (task.status === 'in_progress' || task.status === 'changes_requested' || task.status === 'needs_input')
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

export function buildSprintEngineContinuationPrompt(task: SprintEngineTask, agentId: string): string {
  return [
    `Sprint Engine roster runner found a ready ${task.role} task for this idle terminal.`,
    `Task: ${task.id} - ${task.title}`,
    `Run \`sprintengine join --role ${task.role} --id ${agentId} --watch\` to receive the current directive. The CLI owns polling and backoff; do not create your own retry loop.`,
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
      : 'Sprint Engine roster runner found a quality gate ready for this terminal.',
    `Task: ${task.id} - ${task.title}`,
    `Gate: ${gate.id} (${gate.phase} / ${gate.role})`,
    `Run \`sprintengine join --role ${gate.role} --id ${agentId} --watch\` to receive the current directive. The CLI will tell you whether to resume or claim the gate, and what to do after the verdict.`,
  ].join('\n')
}

export function buildAgentNotificationPrompt(event: SprintEngineEvent): string {
  return [
    'Sprint Engine notification.',
    event.taskId ? `Task: ${event.taskId}` : null,
    event.artifactId ? `Artifact: ${event.artifactId}` : null,
    event.notificationKind ? `Type: ${event.notificationKind}` : null,
    '',
    event.message,
    '',
    event.notificationKind === 'task_completed_after_artifact_approval' || event.notificationKind === 'task_completed_after_input_resolution'
      ? 'Your Sprint Engine task is complete. Do not claim another task in this terminal unless explicitly instructed.'
      : 'Re-read the current task card, notes, acceptance criteria, and evidence before continuing. Do not claim a new task.',
  ].filter((line): line is string => line !== null).join('\n')
}

export function buildArchitectNeedsInputTriagePrompt(input: {
  workspaceFolderPath: string
  sprintEngineStatePath: string
  taskIds: string[]
}): string {
  const command = `sprintengine --state ${quoteShellArg(input.sprintEngineStatePath)} triage needs-input --id architect`
  return [
    'Fetch the canonical Sprint Engine architect triage instructions from the Python tool.',
    `Worker cwd: ${input.workspaceFolderPath}`,
    `Shared Sprint Engine state: ${input.sprintEngineStatePath}`,
    `Architect-actionable needs_input tasks detected: ${input.taskIds.join(', ')}.`,
    'Run:',
    `\`\`\`bash\n${command}\n\`\`\``,
    'Follow the returned prompt. Resolve planning or task-card blockers only; do not edit application source in this triage mode. When the original worker can continue, add a clear task note and stop.',
  ].join('\n\n')
}

export function getPendingAgentNotificationEvents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  deliveredKeys: ReadonlySet<string>,
  alreadySentKeys: ReadonlySet<string>
): SprintEngineEvent[] {
  return sprintEngineState.events.filter((event) =>
    event.type === 'agent_notification_requested'
    && Boolean(event.id)
    && Boolean(event.targetAgentId)
    && !deliveredKeys.has(agentNotificationDeliveryKey(workspace, event))
    && !alreadySentKeys.has(agentNotificationDeliveryKey(workspace, event))
  )
}

export type PickNextAutoRunsOptions = {
  limit: number
  pendingSpawns: SprintEngineAutoPendingSpawn[]
  runningAgentIds: ReadonlySet<string>
  inFlightSpawns: ReadonlySet<string>
  continuationCapacityByRole: ReadonlyMap<SprintEngineRole, number>
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

  const addCandidate = (
    task: SprintEngineTask,
    agentId: string,
    fallbackLabel: string,
    addOptions: { allowSharedTask?: boolean; agentRole?: SprintEngineRole; gateId?: string } = {}
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
    (task.status === 'in_progress' || task.status === 'changes_requested') && Boolean(task.ownerAgentId)
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
    addCandidate(task, agentId, rosterById[agentId]?.label ?? agentId)
  }

  const readyTasks = sprintEngineState.tasks.filter((task) =>
    isSprintEngineTaskLaunchable(task, sprintEngineState)
    || (task.status === 'changes_requested' && Boolean(task.ownerAgentId))
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

  // Lifecycle phase tasks (review/testing/product) keep auto-run running even
  // when no implementation task is ready: each pending required gate maps to
  // a reviewer/tester/product role, and we spawn an idle roster agent for that
  // role so the spawned terminal's `sprintengine join` can decide whether a
  // gate or other ready task is the next claim. We never claim the gate from
  // the renderer — that stays a CLI-only mutation (`task gate next/claim`).
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
