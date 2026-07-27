// Deleting a run, in the order that makes it stick (item 1812).
//
// The three steps are one sequence, not three independent calls: the run's agents
// write into the directory being trashed, so the workspace teardown has to have
// finished before the trash move, and the tombstone is only true once the move
// succeeded. Firing them together let a surviving writer recreate the folder and
// the door re-listed a run the operator had just deleted.
//
// The sequence lives here rather than in the canvas so it can be driven directly
// in a test; the canvas keeps what only it can do — the type-to-confirm dialog,
// the busy state, and reporting a failure.

import { requestCloseSprintWorkspace } from './sprintDoorRequests'
import { noteSprintRunDeleted } from './sprintRunTombstones'

export type SprintRunDeletionPorts = {
  /** Resolves when the workspace's terminals are dead and it is gone. */
  closeWorkspace(workspaceId: string): Promise<void>
  /** Moves the run's directory to the system trash. */
  deletePath(directory: string): Promise<void>
  noteDeleted(statePath: string): void
}

export type SprintRunDeletionTarget = {
  statePath: string
  /** The run's own directory — the folder holding `run.yaml`. */
  runDirectory: string
  /** The workspace hosting this run's terminals, or null when none is resident. */
  residentWorkspaceId: string | null
}

function defaultPorts(): SprintRunDeletionPorts {
  return {
    closeWorkspace: (workspaceId) => requestCloseSprintWorkspace(workspaceId),
    deletePath: (directory) => window.api.deletePath(directory),
    noteDeleted: (statePath) => noteSprintRunDeleted(statePath),
  }
}

/**
 * Tear down, trash, tombstone. Rejects if either step fails — the caller reports
 * it, and a run whose directory could not be trashed keeps listing, which is the
 * truth. A run with no resident workspace skips the teardown entirely rather than
 * waiting on one that will never happen.
 */
export async function deleteSprintRun(
  target: SprintRunDeletionTarget,
  ports: SprintRunDeletionPorts = defaultPorts(),
): Promise<void> {
  if (target.residentWorkspaceId) await ports.closeWorkspace(target.residentWorkspaceId)
  await ports.deletePath(target.runDirectory)
  ports.noteDeleted(target.statePath)
}
