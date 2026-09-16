import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'

// The Workflows half of the run-door partition (MC-2470 / MC-2577).
//
// A named coordinator seat means the run staffs a specialist who owns the
// planning job — that is a workflow. The Sprints half (the fallback for every
// other run, including unclassifiable ones) lives with the Sprint Engine
// module: `sprint-engine-sprints-partition.ts`. Nothing here names a role id;
// the seat is the rule.

/** What a summary has to carry for the partition to answer — nothing else. */
export type RunDoorClassifiable = Pick<SprintRunSummary, 'coordinatorSeat'>

/** True when this run lists under Workflows: a genuinely non-empty coordinator role. */
export function isWorkflowRun(run: RunDoorClassifiable): boolean {
  const role = run.coordinatorSeat?.role
  return typeof role === 'string' && role.trim() !== ''
}
