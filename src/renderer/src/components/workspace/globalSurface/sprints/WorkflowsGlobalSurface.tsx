import { RunDoorSurface } from './RunDoorSurface'
import { WORKFLOWS_DOOR } from './runDoorCopy'

// The Workflows door (item 2470) — a SIBLING of Sprints, not a second one.
//
// "Sprint" named two jobs that have nothing to do with each other: turning a
// goal into a plan, and running a plan that already exists. This is the first of
// those, and it is the same surface Sprints is, mounted with the other door
// definition. The runs it lists are the ones whose coordinator seat is named —
// see `runDoors.ts`, which is where that judgement is made and the only place it
// is made.
export default function WorkflowsGlobalSurface(): JSX.Element {
  return <RunDoorSurface door={WORKFLOWS_DOOR} />
}
