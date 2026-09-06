import type { SidebarNavEntryRenderProps } from '../../../../modules/renderer-host'
import { RunDoorNavEntry } from './RunDoorNavEntry'
import { WORKFLOWS_DOOR } from './runDoorCopy'

// The Workflows drawer row (item 2470), sitting beside Sprints. Same row
// component, the other door definition: the runs it counts and the surface it
// opens are the Workflows half of the partition, and nothing else about it
// differs.
export function WorkflowsNavEntry(props: SidebarNavEntryRenderProps) {
  return <RunDoorNavEntry {...props} door={WORKFLOWS_DOOR} />
}
