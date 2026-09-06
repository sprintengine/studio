import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'

// Which door a run belongs to (item 2470).
//
// One noun, "sprint", named two jobs that have nothing to do with each other:
// turning a goal into a plan, and running a plan that already exists. The epic
// splits them into two doors, and this module is the whole of the rule that
// decides which one a run lists under. It is pure and DOM-free on purpose: the
// partition is the part of this item that has to be right, so it is stated once,
// tested on its own, and read by both surfaces rather than re-derived in either.
//
// THE RULE IS THE COORDINATOR SEAT, NOT A ROLE NAME.
//
// Epic 2058 exists to delete `isSprintEnginePlanningRole`, which answered "does
// this run plan?" by comparing a role to the literals `architect` and `general`.
// Reproducing that comparison here would be the worst possible outcome of this
// item, so nothing below ever mentions a role id. What it reads is the run's own
// coordinator SEAT, which `sprintEngineCoordinatorSeat` resolves from the run's
// `configuredRoles` and the index summary carries verbatim:
//
//   • A seat whose `role` is NAMED — the run staffs specialists, one of whom
//     holds the coordination job. An architect works out what the work is and a
//     roster does it. That is a WORKFLOW.
//   • A seat with NO role — the run coordinates through the roleless seat, which
//     exists only to hold the coordination job, because the work was already
//     written down before the run started and every agent is equally able to
//     take it. That is a SPRINT.
//
// The asymmetry is epic 2058's own ("a named coordinator is a singleton seat
// that owns its speciality's work; an unnamed one owns only the coordination
// job"), read here for what it says about the RUN rather than about dispatch.
// Nothing in this module can change how a run executes: it sorts rows in a list.
//
// EVERY RUN LANDS IN EXACTLY ONE DOOR, INCLUDING THE ONES THAT CANNOT SAY.
//
// A run whose projection could not be read carries `coordinatorSeat: null`, and
// a summary produced by a build older than this field carries none at all. Both
// mean "this run does not state its kind". Such a run goes to SPRINTS: that is
// the door every run in this Multicode has always been listed in, so a run we
// cannot classify stays where its operator last saw it instead of disappearing,
// and it is never claimed by Workflows — a door may only claim a run that
// positively declares a named seat. Cancelled runs, completed runs and runs that
// predate the distinction are classified by exactly the same rule: cancellation
// and completion are lifecycle, not kind, and a run that predates
// `configuredRoles` resolves to the architect seat the engine still resolves for
// it, so it reads correctly under Workflows.

export type RunDoorId = 'workflows' | 'sprints'

/** Every door, in the order they sit beside each other in the rail. */
export const RUN_DOOR_IDS: readonly RunDoorId[] = ['workflows', 'sprints']

/** What a summary has to carry for the partition to answer — nothing else. */
export type RunDoorClassifiable = Pick<SprintRunSummary, 'coordinatorSeat'>

/**
 * The door this run lists under. Total: every input yields exactly one id, and
 * the fallback is Sprints (see the header — an unclassifiable run must not
 * vanish, and must not be claimed by the door that promises planning).
 */
export function runDoorFor(run: RunDoorClassifiable): RunDoorId {
  const role = run.coordinatorSeat?.role
  // A seat is named only by a genuinely non-empty role. `''` and whitespace are
  // an absent role written badly, not a specialist.
  return typeof role === 'string' && role.trim() !== '' ? 'workflows' : 'sprints'
}

/** Does this run belong to `door`? The predicate the two surfaces filter with. */
export function runBelongsToDoor(run: RunDoorClassifiable, door: RunDoorId): boolean {
  return runDoorFor(run) === door
}

/**
 * The runs `door` lists, in the order they arrived. Order is the index's, never
 * this module's — the rail's grouping and sort own that, and a partition that
 * quietly re-ordered would move rows for a reason nobody could see.
 */
export function runsForDoor<T extends RunDoorClassifiable>(
  runs: ReadonlyArray<T>,
  door: RunDoorId,
): T[] {
  return runs.filter((run) => runBelongsToDoor(run, door))
}

/**
 * Both doors' lists from one read of the index. Exhaustive by construction:
 * every run appears in exactly one of the two arrays, and the two together are
 * the input, in order.
 */
export function partitionRunsByDoor<T extends RunDoorClassifiable>(
  runs: ReadonlyArray<T>,
): Record<RunDoorId, T[]> {
  const partition: Record<RunDoorId, T[]> = { workflows: [], sprints: [] }
  for (const run of runs) partition[runDoorFor(run)].push(run)
  return partition
}
