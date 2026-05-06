import {
  MULTILOOP_AGENT_SOULS,
  getMultiloopAgentSoul,
} from '../specialists/specialistActions'
import type {
  MultiloopAgentSoulRole,
  MultiloopAutoPendingSpawn,
  MultiloopState,
  MultiloopTask,
  SwarmRole,
  SwarmState,
  SwarmTask,
} from '../types/workspace'
import {
  buildMultiloopLaunchContextLines,
  getActiveMultiloopBlockers,
  getActiveMultiloopMilestone,
  getMultiloopTasksForMilestone,
} from './multiloop'
import {
  buildSwarmAgentRosterForState,
  getSwarmTaskBoardColumn,
  swarmRoleLabels,
} from './sprintengine'

export type MultiloopAutoRunCandidate =
  | {
    kind: 'task'
    agentId: string
    label: string
    role: MultiloopAgentSoulRole
    taskId: string
  }
  | {
    kind: 'sprintengine-task'
    agentId: string
    label: string
    role: SwarmRole
    taskId: string
  }
  | {
    kind: 'coordinator'
    agentId: string
    label: string
    role: 'coordinator'
    taskId: null
  }

export type MultiloopAutoRunSelection = {
  candidates: MultiloopAutoRunCandidate[]
  skippedUnknownRoles: string[]
  reason:
    | 'ready'
    | 'no-active-milestone'
    | 'blocked'
    | 'needs-input'
    | 'all-done'
    | 'no-ready-tasks'
    | 'no-slots'
}

export type MultiloopAutoRunSelectionInput = {
  state: MultiloopState
  limit: number
  runningAgentIds?: Set<string>
  pendingSpawns?: MultiloopAutoPendingSpawn[]
  inFlightAgentIds?: Set<string>
  coordinatorAutoSpawnKey?: string | null
  linkedSwarmState?: SwarmState | null
}

export function autoRunReasonToLabel(reason: MultiloopAutoRunSelection['reason']): string {
  switch (reason) {
    case 'ready':
      return 'ready'
    case 'no-active-milestone':
      return 'no active milestone'
    case 'blocked':
      return 'blocked'
    case 'needs-input':
      return 'needs input'
    case 'all-done':
      return 'all done'
    case 'no-ready-tasks':
      return 'no ready tasks'
    case 'no-slots':
      return 'no slots'
  }
}

const spawnableRoles = new Set<MultiloopAgentSoulRole>(
  MULTILOOP_AGENT_SOULS.map((soul) => soul.role)
)

export function toProjectRelativeMultiloopPath(
  path: string | null | undefined,
  workspaceRoot: string | null | undefined
): string {
  if (!path) return 'multiloop/<loop>/state.json'

  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = workspaceRoot?.replace(/\\/g, '/').replace(/\/+$/u, '')
  if (normalizedRoot && (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`))) {
    return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/u, '') || '.'
  }

  const multiloopIndex = normalizedPath.lastIndexOf('/multiloop/')
  if (multiloopIndex >= 0) return normalizedPath.slice(multiloopIndex + 1)
  return 'multiloop/<loop>/state.json'
}

export function buildMultiloopRoleAgentId(role: MultiloopAgentSoulRole): string {
  return `multiloop-${role}`
}

export function buildMultiloopAutoStartupPrompt({
  soulPrompt,
  role,
  state,
  statePath,
  workspaceRoot,
  agentId,
  coordinatorReviewContext = false,
}: {
  soulPrompt: string
  role: MultiloopAgentSoulRole
  state: MultiloopState
  statePath: string | null
  workspaceRoot: string | null
  agentId: string
  coordinatorReviewContext?: boolean
}): string {
  const soul = getMultiloopAgentSoul(role)
  const currentMilestone = getActiveMultiloopMilestone(state)
  const stateRelativePath = toProjectRelativeMultiloopPath(statePath, workspaceRoot)
  const readyTaskIdsForRole = currentMilestone && !currentMilestone.sprintEngine
    ? getMultiloopTasksForMilestone(state, currentMilestone.id)
      .filter((task) => task.role === role && task.status === 'ready')
      .map((task) => task.id)
    : []
  const context = buildMultiloopLaunchContextLines({
    roleLabel: soul.label,
    role,
    agentId,
    readyTaskIdsForRole,
    loopName: state.loop.displayName,
    finalGoal: state.loop.finalGoal,
    currentMilestone,
    statePath: stateRelativePath,
  })

  return [
    soulPrompt.trim(),
    ...context,
    coordinatorReviewContext
      ? 'All active milestone tasks appear done; inspect evidence and accept, block, or revise the milestone through the CLI.'
      : null,
  ].filter((line): line is string => Boolean(line)).join('\n')
}

export function selectMultiloopAutoRunCandidates({
  state,
  limit,
  runningAgentIds = new Set(),
  pendingSpawns = [],
  inFlightAgentIds = new Set(),
  coordinatorAutoSpawnKey = null,
  linkedSwarmState = null,
}: MultiloopAutoRunSelectionInput): MultiloopAutoRunSelection {
  const activeMilestone = getActiveMultiloopMilestone(state)
  if (!activeMilestone) {
    return emptySelection('no-active-milestone')
  }

  if (activeMilestone.sprintEngine) {
    if (!linkedSwarmState) return emptySelection('no-ready-tasks')
    return selectLinkedSprintEngineAutoRunCandidates({
      state,
      swarmState: linkedSwarmState,
      limit,
      runningAgentIds,
      pendingSpawns,
      inFlightAgentIds,
      coordinatorAutoSpawnKey,
    })
  }

  const activeTasks = getMultiloopTasksForMilestone(state, activeMilestone.id)
  const occupiedAgentIds = new Set([
    ...runningAgentIds,
    ...pendingSpawns.map((pending) => pending.agentId),
    ...inFlightAgentIds,
  ])
  if (limit <= 0) {
    return {
      candidates: [],
      skippedUnknownRoles: [],
      reason: 'no-slots',
    }
  }

  if (
    activeTasks.length > 0
    && activeTasks.every((task) => task.status === 'done')
    && coordinatorAutoSpawnKey !== activeMilestone.id
    && !occupiedAgentIds.has(buildMultiloopRoleAgentId('coordinator'))
  ) {
    return {
      candidates: [coordinatorCandidate()].slice(0, limit),
      skippedUnknownRoles: [],
      reason: 'all-done',
    }
  }

  const activeBlockers = getActiveMultiloopBlockers(state, activeMilestone.id)
  if (state.loop.status === 'blocked' || activeMilestone.status === 'blocked' || activeBlockers.length > 0) {
    return emptySelection('blocked')
  }
  if (activeTasks.some((task) => task.status === 'blocked')) {
    return emptySelection('blocked')
  }
  if (activeTasks.some((task) => task.status === 'needs_input')) {
    return emptySelection('needs-input')
  }

  const taskById = new Map(state.tasks.map((task) => [task.id, task]))
  const readyTasks = activeTasks.filter((task) => isClaimableOrPromotableByCli(task, taskById))
  const skippedUnknownRoles = readyTasks
    .map((task) => task.role)
    .filter((role) => !isSpawnableMultiloopRole(role))
    .filter((role, index, roles) => roles.indexOf(role) === index)

  const candidates: MultiloopAutoRunCandidate[] = []
  for (const task of readyTasks) {
    if (!isSpawnableMultiloopRole(task.role)) continue
    const agentId = buildMultiloopRoleAgentId(task.role)
    if (occupiedAgentIds.has(agentId)) continue

    candidates.push({
      kind: 'task',
      agentId,
      label: getMultiloopAgentSoul(task.role).label,
      role: task.role,
      taskId: task.id,
    })
    occupiedAgentIds.add(agentId)
    if (candidates.length >= limit) break
  }

  return {
    candidates,
    skippedUnknownRoles,
    reason: candidates.length > 0 ? 'ready' : 'no-ready-tasks',
  }
}

function selectLinkedSprintEngineAutoRunCandidates({
  state,
  swarmState,
  limit,
  runningAgentIds,
  pendingSpawns,
  inFlightAgentIds,
  coordinatorAutoSpawnKey,
}: {
  state: MultiloopState
  swarmState: SwarmState
  limit: number
  runningAgentIds: Set<string>
  pendingSpawns: MultiloopAutoPendingSpawn[]
  inFlightAgentIds: Set<string>
  coordinatorAutoSpawnKey: string | null
}): MultiloopAutoRunSelection {
  const activeMilestone = getActiveMultiloopMilestone(state)
  if (!activeMilestone) return emptySelection('no-active-milestone')

  const occupiedAgentIds = new Set([
    ...runningAgentIds,
    ...pendingSpawns.map((pending) => pending.agentId),
    ...inFlightAgentIds,
  ])
  if (limit <= 0) {
    return {
      candidates: [],
      skippedUnknownRoles: [],
      reason: 'no-slots',
    }
  }

  if (
    swarmState.tasks.length > 0
    && swarmState.tasks.every((task) => task.status === 'done')
    && coordinatorAutoSpawnKey !== activeMilestone.id
    && !occupiedAgentIds.has(buildMultiloopRoleAgentId('coordinator'))
  ) {
    return {
      candidates: [coordinatorCandidate()].slice(0, limit),
      skippedUnknownRoles: [],
      reason: 'all-done',
    }
  }

  const activeBlockers = getActiveMultiloopBlockers(state, activeMilestone.id)
  if (state.loop.status === 'blocked' || activeMilestone.status === 'blocked' || activeBlockers.length > 0) {
    return emptySelection('blocked')
  }
  if (swarmState.tasks.some((task) => task.status === 'needs_input')) {
    return emptySelection('needs-input')
  }

  const roster = buildSwarmAgentRosterForState(swarmState)
  const rosterByRole = new Map<SwarmRole, string[]>()
  for (const agent of roster) {
    rosterByRole.set(agent.role, [...(rosterByRole.get(agent.role) ?? []), agent.id])
  }

  const candidates: MultiloopAutoRunCandidate[] = []
  const readyTasks = swarmState.tasks.filter((task) => isReadySprintEngineTask(task, swarmState))
  for (const task of readyTasks) {
    const agentId = (rosterByRole.get(task.role) ?? []).find((candidateId) => !occupiedAgentIds.has(candidateId))
      ?? `${task.role}-${task.id.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-')}`
    if (occupiedAgentIds.has(agentId)) continue

    candidates.push({
      kind: 'sprintengine-task',
      agentId,
      label: swarmRoleLabels[task.role],
      role: task.role,
      taskId: task.id,
    })
    occupiedAgentIds.add(agentId)
    if (candidates.length >= limit) break
  }

  return {
    candidates,
    skippedUnknownRoles: [],
    reason: candidates.length > 0 ? 'ready' : 'no-ready-tasks',
  }
}

function isReadySprintEngineTask(task: SwarmTask, swarmState: SwarmState): boolean {
  if (task.status === 'in_progress' || task.status === 'needs_input' || task.status === 'done') return false
  if (task.ownerAgentId) return false
  return getSwarmTaskBoardColumn(task, swarmState.tasks) === 'ready'
}

function emptySelection(reason: MultiloopAutoRunSelection['reason']): MultiloopAutoRunSelection {
  return {
    candidates: [],
    skippedUnknownRoles: [],
    reason,
  }
}

function isClaimableOrPromotableByCli(task: MultiloopTask, taskById: Map<string, MultiloopTask>): boolean {
  if (task.status !== 'ready' && task.status !== 'todo') return false
  return task.dependsOn.every((dependencyId) => taskById.get(dependencyId)?.status === 'done')
}

function isSpawnableMultiloopRole(role: string): role is MultiloopAgentSoulRole {
  return spawnableRoles.has(role as MultiloopAgentSoulRole)
}

function coordinatorCandidate(): MultiloopAutoRunCandidate {
  return {
    kind: 'coordinator',
    agentId: buildMultiloopRoleAgentId('coordinator'),
    label: getMultiloopAgentSoul('coordinator').label,
    role: 'coordinator',
    taskId: null,
  }
}
