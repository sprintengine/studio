import type { RendererHost } from './renderer-host'
import {
  getSprintRunIndexSnapshot,
  subscribeSprintRunIndex,
} from '../components/workspace/globalSurface/sprints/sprintRunIndexStore'
import { runsForDoor, type RunDoorId } from '../components/workspace/globalSurface/sprints/runDoors'

// Waiting-on-you counts the Sprints and Workflows drawer rows wear (MC-2577).
//
// The shell's `useExtensionsRowBadges` used to import the run index and the
// door partition. Those are this module's data; the host only stores the
// contribution and the hook reads it. Disabling the module drops both
// contributions, so the rows count nothing — they are also absent from the
// drawer.

function waitingCountForDoor(door: RunDoorId): number {
  const waiting = getSprintRunIndexSnapshot().runs.filter((run) => run.runtimeState === 'needs_input')
  return runsForDoor(waiting, door).length
}

export function registerSprintEngineDoorBadges(host: RendererHost): void {
  host.registerDoorBadge({
    rowId: 'sprints',
    notificationSource: 'sprintengine',
    getWaitingCount: () => waitingCountForDoor('sprints'),
    subscribe: subscribeSprintRunIndex,
  })
  host.registerDoorBadge({
    rowId: 'workflows',
    getWaitingCount: () => waitingCountForDoor('workflows'),
    subscribe: subscribeSprintRunIndex,
  })
}
