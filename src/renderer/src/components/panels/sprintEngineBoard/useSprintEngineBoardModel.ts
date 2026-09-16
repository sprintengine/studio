import { useMemo } from 'react'
import {
  buildSprintEngineAgentRosterForState,
  getReviewableSprintEngineArtifacts,
  getSprintEngineArtifactDependencyBlockers,
  getSprintEngineArtifactsByTaskId,
  getSprintEngineTaskBoardColumn,
  isSprintEngineTaskLaunchable,
  orderSprintEngineBoardColumnTasks,
  sprintEngineTaskBoardColumns,
  type SprintEngineAgentRosterItem,
} from '../../../utils/sprintengine'
import {
  buildSprintEngineAddMemberOptions,
  type SprintEngineAddMemberOption,
} from '../../../utils/sprintengineRoleOptions'
import { getSprintEngineInboxBadgeCount, type RuntimeAgentView } from '../sprintEngineInspector'
import type {
  AgentState,
  SprintEngineArtifact,
  SprintEngineRoleId,
  SprintEngineRoleRegistry,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineTaskBoardColumn,
} from '../../../types/workspace'

type SprintEngineBoardColumn = {
  key: SprintEngineTaskBoardColumn
  label: string
  cards: SprintEngineTask[]
}

export type SprintEngineBoardModel = {
  roster: SprintEngineAgentRosterItem[]
  rosterById: Record<string, SprintEngineAgentRosterItem | undefined>
  runtimeAgents: RuntimeAgentView[]
  runtimeAgentById: Record<string, RuntimeAgentView | undefined>
  readyTasks: SprintEngineTask[]
  boardColumns: SprintEngineBoardColumn[]
  reviewArtifacts: SprintEngineArtifact[]
  artifactsByTaskId: Record<string, SprintEngineArtifact[]>
  artifactBlockersByTaskId: Record<
    string,
    ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
  >
  tasksById: Record<string, SprintEngineTask>
  inboxArtifactCount: number
  addMemberOptions: SprintEngineAddMemberOption[]
}

/**
 * Derived view model for the Sprint Engine board. Centralizes the roster,
 * runtime-agent, board-column, artifact, and inbox derivations so the
 * orchestrator stays focused on state/IO coordination. The hook treats the
 * inputs as the source of truth — it never mutates Sprint Engine state and
 * never reaches into projection or artifact folders directly.
 */
export type SprintEngineBoardModelInput = {
  sprintEngineState: SprintEngineState | null
  agents: Record<string, AgentState>
  roleRegistry?: SprintEngineRoleRegistry | null
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null
}

export function useSprintEngineBoardModel(input: SprintEngineBoardModelInput): SprintEngineBoardModel {
  const { sprintEngineState, agents, roleRegistry = null, disabledRoleIds = null } = input

  const roster = useMemo(
    () => buildSprintEngineAgentRosterForState(sprintEngineState),
    [sprintEngineState],
  )

  const rosterById = useMemo(
    () => Object.fromEntries(roster.map((agent) => [agent.id, agent])) as Record<
      string,
      SprintEngineAgentRosterItem | undefined
    >,
    [roster],
  )

  const sprintEngineTasks = sprintEngineState?.tasks ?? []

  // Registry-authoritative add-member options. The Sprint Engine role registry
  // for the workspace is the source of addable specialist roles; user-disabled
  // roles are filtered out. Post un-ship, a role that the registry cannot
  // resolve is never offered, so with no pack installed NO role renders here —
  // which is a roleless run, not a broken picker (MC-2057).
  const addMemberOptions = useMemo<SprintEngineAddMemberOption[]>(
    () =>
      buildSprintEngineAddMemberOptions({
        registry: roleRegistry,
        disabledRoleIds,
        roster,
        tasks: sprintEngineTasks,
      }),
    [roleRegistry, disabledRoleIds, roster, sprintEngineTasks],
  )

  const runtimeAgents = useMemo<RuntimeAgentView[]>(
    () =>
      roster.map((agent) => {
        const runtime = sprintEngineState?.sprintEngineAgents[agent.id]
        const localAgent = agents[agent.id]
        const localExited = Boolean(
          localAgent?.cliLastExitedAt
            && !localAgent.cliStartRequested
            && !localAgent.cliHasLaunched,
        )
        return {
          agentId: agent.id,
          label: agent.label,
          role: runtime?.role ?? agent.role,
          status: localExited ? 'exited' : runtime?.status ?? 'idle',
          currentTaskId: runtime?.currentTaskId ?? null,
        }
      }),
    [agents, roster, sprintEngineState?.sprintEngineAgents],
  )

  const runtimeAgentById = useMemo(
    () =>
      Object.fromEntries(runtimeAgents.map((agent) => [agent.agentId, agent])) as Record<
        string,
        RuntimeAgentView | undefined
      >,
    [runtimeAgents],
  )

  const readyTasks = useMemo(
    () =>
      sprintEngineState?.tasks.filter((task) =>
        isSprintEngineTaskLaunchable(task, sprintEngineState),
      ) ?? [],
    [sprintEngineState],
  )

  const boardColumns = useMemo<SprintEngineBoardColumn[]>(() => {
    if (!sprintEngineState) return []
    return sprintEngineTaskBoardColumns.map((column) => ({
      ...column,
      cards: orderSprintEngineBoardColumnTasks(
        column.key,
        sprintEngineState.tasks.filter(
          (task) => getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks) === column.key,
        ),
      ),
    }))
  }, [sprintEngineState])

  const reviewArtifacts = useMemo(
    () => getReviewableSprintEngineArtifacts(sprintEngineState?.artifacts ?? []),
    [sprintEngineState?.artifacts],
  )

  const artifactsByTaskId = useMemo(
    () => getSprintEngineArtifactsByTaskId(reviewArtifacts),
    [reviewArtifacts],
  )

  const artifactBlockersByTaskId = useMemo(() => {
    if (!sprintEngineState) return {}
    return Object.fromEntries(
      sprintEngineState.tasks.map((task) => [
        task.id,
        getSprintEngineArtifactDependencyBlockers(task, sprintEngineState.tasks, reviewArtifacts),
      ]),
    )
  }, [reviewArtifacts, sprintEngineState])

  const tasksById = useMemo(
    () =>
      Object.fromEntries((sprintEngineState?.tasks ?? []).map((task) => [task.id, task])) as Record<
        string,
        SprintEngineTask
      >,
    [sprintEngineState?.tasks],
  )

  const inboxArtifactCount = useMemo(
    () => getSprintEngineInboxBadgeCount(reviewArtifacts),
    [reviewArtifacts],
  )

  return {
    roster,
    rosterById,
    runtimeAgents,
    runtimeAgentById,
    readyTasks,
    boardColumns,
    reviewArtifacts,
    artifactsByTaskId,
    artifactBlockersByTaskId,
    tasksById,
    inboxArtifactCount,
    addMemberOptions,
  }
}
