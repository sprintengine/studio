import type { SidebarNavEntryRenderProps } from '../../../../modules/renderer-host'
import { RunDoorNavEntry } from './RunDoorNavEntry'
import { SPRINTS_DOOR } from './runDoorCopy'

// The Sprints drawer row (item 1763). That row used to toggle the Sprint Engines
// aside — a survey panel floating over whichever project happened to be open,
// listing only runs whose workspace was still around. It opens the
// instance-global Sprints surface instead: every run of its kind, every project,
// live and historical.
//
// The row itself is `RunDoorNavEntry`, which Workflows wears too (item 2470);
// this is the door's identity, kept as its own component because the registry
// registers one entry per door.
export function SprintsNavEntry(props: SidebarNavEntryRenderProps) {
  return <RunDoorNavEntry {...props} door={SPRINTS_DOOR} />
}
