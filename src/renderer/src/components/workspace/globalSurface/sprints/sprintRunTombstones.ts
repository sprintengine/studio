// Runs the operator deleted, and the debris that can outlive them (item 1812).
//
// Deleting a run moves its directory to the trash after its workspace has been
// torn down, but a process that outlives its pty can still land a write into the
// path it was given — recreating the folder, often with nothing but a partial
// `run.yaml`. The index scans disk, so that folder lists again as an
// `unknown`-state row ("Run projection has not been written yet") for a run the
// operator just deleted, and there is no second delete to press: the record it
// described is already gone.
//
// A tombstone marks the path as deleted, and rows for a tombstoned path are
// dropped while they carry no readable projection — that is debris, not a run.
// A path that lists with a projection that parses IS a run again (the operator
// created a new sprint under the same team slug), so the tombstone lifts and the
// row shows. Nothing hides indefinitely on the strength of a past deletion.
//
// Scope is this window's session, which is where the race lives — the writes
// that resurrect a folder come from processes the delete just killed. A tombstone
// does not survive a reload, and does not need to: by then the debris is either
// gone or is the only record of that path, and hiding it would be hiding the
// truth on disk.

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'

const deletedStatePaths = new Set<string>()

/** Record that this run's directory was deleted from disk. */
export function noteSprintRunDeleted(statePath: string): void {
  if (statePath) deletedStatePaths.add(statePath)
}

/**
 * The index rows worth showing: everything except debris left behind at a path
 * the operator deleted. Clears the tombstone for any path that reads as a real
 * run again, so a new sprint at the same path lists normally.
 */
export function dropDeletedSprintRunDebris(runs: SprintRunSummary[]): SprintRunSummary[] {
  if (deletedStatePaths.size === 0) return runs
  return runs.filter((run) => {
    if (!deletedStatePaths.has(run.statePath)) return true
    if (run.runtimeState === 'unknown') return false
    deletedStatePaths.delete(run.statePath)
    return true
  })
}
