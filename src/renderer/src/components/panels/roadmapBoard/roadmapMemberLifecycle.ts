// One mapping from a horizon step member's BACKLOG status to the shared lifecycle
// glyph vocabulary (MC-1902). Two surfaces render an epic step's snapshotted
// members — the Horizon board's track columns and the horizon editor's step rows —
// and they must not each invent their own reading of "done": a member showing a
// check on one surface and a hollow ring on the other is the same defect the item
// was filed on, one level down.
//
// Glyphs, never tone dots (standing ruling): the lifecycle set here is the one the
// door rails use, so a member reads the same way in a track as it does in a
// worklist. Members ride ONE sprint, so this is item-status truth, not run state.

import type { LifecycleState } from '../../ui'
import type { BacklogItemStatusPayload } from '../../../../../shared/electron-api'
import { isTerminalRoadmapStatus, type RoadmapUnitState } from '../../../../../shared/sprintengine/roadmap-surface'

// The other half of the same rule, one level up: how a STEP's board state reads
// as a lifecycle glyph. Lives beside the member mapping so the two surfaces that
// render a plan — the plan column and, until it is retired, the track column —
// cannot disagree about what a paused or unresolvable step looks like.
export const roadmapUnitLifecycle: Record<RoadmapUnitState, LifecycleState> = {
  done: 'done',
  running: 'in_progress',
  up_next: 'ready',
  queued: 'todo',
  paused: 'paused',
  unknown: 'blocked',
  unknown_project: 'blocked',
}

export function roadmapMemberLifecycle(status: BacklogItemStatusPayload | undefined): LifecycleState {
  // Terminal covers `archived` as well as `completed`: both are settled work, and
  // the board's own done-count uses the same predicate, so a count of 7/19 and the
  // seven checked rows can never disagree.
  if (isTerminalRoadmapStatus(status)) return 'done'
  switch (status) {
    case 'in_progress':
      return 'in_progress'
    case 'needs_input':
      return 'blocked'
    case 'ready':
      return 'ready'
    default:
      return 'todo'
  }
}

// How many of a step's members are settled — the "7/19" a collapsed step shows.
export function roadmapMembersDone(
  statuses: ReadonlyArray<BacklogItemStatusPayload | undefined>,
): number {
  return statuses.filter((status) => isTerminalRoadmapStatus(status)).length
}
