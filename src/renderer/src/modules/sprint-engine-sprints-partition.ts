import {
  isWorkflowRun,
  type RunDoorClassifiable,
} from '../components/workspace/globalSurface/workflows/runPartition'

// The Sprints half of the run-door partition (MC-2470 / MC-2577).
//
// Every run that is not a workflow lists here, including ones that cannot say
// (`coordinatorSeat: null`, a summary older than the field). That is the
// door every run in this studio has always been listed in, so a run we cannot
// classify stays where its operator last saw it instead of disappearing, and
// it is never claimed by Workflows — a door may only claim a run that
// positively declares a named seat.

export type { RunDoorClassifiable }

/** True when this run lists under Sprints — the partition's fallback. */
export function isSprintRun(run: RunDoorClassifiable): boolean {
  return !isWorkflowRun(run)
}
