import { useMemo } from 'react'
import {
  buildSprintEngineAgentRosterForState,
  getReviewableSprintEngineArtifacts,
  getSprintEngineArtifactDependencyBlockers,
  getSprintEngineArtifactsByTaskId,
  getSprintEngineTaskBoardColumn,
  getSprintEngineVisibleBoardColumns,
  isSprintEngineTaskLaunchable,
  type SprintEngineAgentRosterItem,
} from '../../../utils/sprintengine'
import {
  buildSprintEngineAddMemberOptions,
  type SprintEngineAddMemberOption,
} from '../../../utils/sprintengineRoleOptions'
import { getSprintEngineInboxArtifacts, type RuntimeAgentView } from '../sprintEngineInspector'
import type {
  AgentState,
  SprintEngineArtifact,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineTaskBoardColumn,
} from '../../../types/workspace'

export type SprintEngineBoardColumn = {
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
export function useSprintEngineBoardModel(input: {
  sprintEngineState: SprintEngineState | null
  agents: Record<string, AgentState>
}): SprintEngineBoardModel {
  const { sprintEngineState, agents } = input

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

  // Registry-aware add-member options. The board does not yet read the Sprint
  // Engine role registry directly; passing `null` keeps the bundled
  // compatibility fallback (see `BUNDLED_SPRINT_ENGINE_ADDABLE_ROLES`).
  const addMemberOptions = useMemo<SprintEngineAddMemberOption[]>(
    () =>
      buildSprintEngineAddMemberOptions({
        registry: null,
        roster,
        tasks: sprintEngineTasks,
      }),
    [roster, sprintEngineTasks],
  )

  const runtimeAgents = useMemo<RuntimeAgentView[]>(
    () =>
      roster.map((agent) => {
        const runtime = sprintEngineState?.sprintEngineAgents[agent.id]
        const localAgent = agents[agent.id]
        const localExited = Boolean(
          localAgent?.kind === 'sprintengine'
            && localAgent.cliLastExitedAt
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
    return getSprintEngineVisibleBoardColumns(sprintEngineState).map((column) => ({
      ...column,
      cards: sprintEngineState.tasks.filter(
        (task) => getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks) === column.key,
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
    () => getSprintEngineInboxArtifacts(reviewArtifacts).length,
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
