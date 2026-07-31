/**
 * Sprint Engine initial-spawn launch predicates, shared by the renderer and
 * the main process.
 *
 * Relocated verbatim from `src/renderer/src/utils/sprintengineInitialSpawns.ts`
 * (sprint-runtime-ownership Phase 2: the main process runs the auto-run
 * planner, which reads this module), following the established shim pattern
 * (`sprintengineAutomationLifecycle.ts`). The renderer file remains as a
 * re-export shim, so every existing import site and test keeps working
 * unchanged.
 */
import type { SprintEngineState } from './run-types'
import type { SprintEngineAgentRosterItem } from './state'
import { isSprintEngineCoordinatorAgent, isSprintEngineTaskLaunchable } from './state'

// `isSprintEnginePlanningRole` lived here and answered "may this agent start the
// run?" by comparing a role to `architect` (and, before MC-2057, to `general`).
// It is gone: coordination is a seat, not a role, so bootstrap, dispatch, wake,
// revival, and the launch gate below all ask `isSprintEngineCoordinatorAgent`
// instead — a roleless run's coordinator has no role for a predicate like that
// to match on, and MC-2050 is the last of its call sites.

export function canLaunchSprintEngineInitialSpawn(
  // The roster row, not its role: the agent that may start before any claimable
  // work exists is the COORDINATOR SEAT, which a roleless run identifies by id.
  agent: Pick<SprintEngineAgentRosterItem, 'id' | 'role'>,
  sprintEngineState: SprintEngineState,
): boolean {
  if (isSprintEngineCoordinatorAgent(agent.id, sprintEngineState)) return true

  // Single-owner tasks (MC-1542): a role only has launchable work when a task
  // assigned to it is claimable. There is no second, reviewer-shaped source of
  // work any more — the task's own owner walks its review phase.
  return sprintEngineState.tasks.some((task) =>
    task.role === agent.role && isSprintEngineTaskLaunchable(task, sprintEngineState)
  )
}
