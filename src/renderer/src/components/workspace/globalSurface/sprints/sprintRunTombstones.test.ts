import assert from 'node:assert/strict'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { deleteSprintRun } from './sprintRunDeletion'
import { dropDeletedSprintRunDebris, noteSprintRunDeleted } from './sprintRunTombstones'

// Deleting a run, and what can be left behind by it (item 1812). Two modules,
// one story: `sprintRunDeletion` owns the order the delete happens in, and
// `sprintRunTombstones` owns what the index does about a directory that comes
// back — a writer that outlived the run can put a partial one at the same path,
// and the index, which reads disk, lists it again as an `unknown`-state row for
// a run that no longer exists.

const DELETED = '/work/multicode/.sprintengine/sprintengine/july-hardening/run.yaml'
const KEPT = '/work/multicode/.sprintengine/sprintengine/august-audit/run.yaml'

function run(statePath: string, runtimeState: SprintRunSummary['runtimeState']): SprintRunSummary {
  return {
    statePath,
    teamSlug: statePath.split('/').slice(-2, -1)[0] ?? '',
    teamName: 'Run',
    projectRoot: '/work/multicode',
    projectName: 'multicode',
    runtimeState,
    taskCounts: { total: 0, done: 0, inProgress: 0, waiting: 0 },
    repoRollup: { declared: 0, merged: 0, open: 0 },
    needsInputCount: 0,
    branchName: null,
    worktreePath: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    sourceLabel: null,
    ...(runtimeState === 'unknown' ? { unknownReason: 'Run projection has not been written yet.' } : {}),
  }
}

// Nothing deleted: an unreadable projection is a real run in trouble, and saying
// so is the whole point of the unknown row. It must keep listing.
assert.deepEqual(
  dropDeletedSprintRunDebris([run(DELETED, 'unknown'), run(KEPT, 'running')]).map((row) => row.statePath),
  [DELETED, KEPT],
  'an unknown row lists until someone deletes that run',
)

noteSprintRunDeleted(DELETED)

// The folder is back, with nothing readable in it: that is the debris the delete
// raced, not a run. Other runs are untouched.
assert.deepEqual(
  dropDeletedSprintRunDebris([run(DELETED, 'unknown'), run(KEPT, 'running')]).map((row) => row.statePath),
  [KEPT],
  'a recreated directory with no readable projection is a tombstone, not a row',
)

// Deleted and gone: nothing to filter, and no crash on an index that no longer
// mentions the path at all.
assert.deepEqual(
  dropDeletedSprintRunDebris([run(KEPT, 'running')]).map((row) => row.statePath),
  [KEPT],
  'a deleted run that stays deleted needs no special case',
)

// A new sprint created under the same team slug reads as a real run. It lists,
// and the tombstone lifts — nothing stays hidden on the strength of a past delete.
assert.deepEqual(
  dropDeletedSprintRunDebris([run(DELETED, 'idle')]).map((row) => row.statePath),
  [DELETED],
  'a readable projection at that path is a run again',
)
assert.deepEqual(
  dropDeletedSprintRunDebris([run(DELETED, 'unknown')]).map((row) => row.statePath),
  [DELETED],
  'and the tombstone is spent — the new run is judged on its own',
)

// An empty path is not a tombstone: it would swallow every row whose statePath
// failed to resolve.
noteSprintRunDeleted('')
assert.deepEqual(
  dropDeletedSprintRunDebris([run('', 'unknown')]).map((row) => row.statePath),
  [''],
  'an empty state path is never tombstoned',
)

// The delete sequence itself: teardown, trash, tombstone, in that order.
void (async () => {
  const calls: string[] = []
  let finishTeardown = (): void => {}
  const ports = {
    closeWorkspace: (workspaceId: string) => {
      calls.push(`close:${workspaceId}`)
      return new Promise<void>((resolve) => {
        finishTeardown = resolve
      })
    },
    deletePath: (directory: string) => {
      calls.push(`delete:${directory}`)
      return Promise.resolve()
    },
    noteDeleted: (statePath: string) => {
      calls.push(`tombstone:${statePath}`)
    },
  }

  const target = { statePath: DELETED, runDirectory: '/work/multicode/.sprintengine/sprintengine/july-hardening', residentWorkspaceId: 'ws-run' }
  const deleting = deleteSprintRun(target, ports)
  await Promise.resolve()
  assert.deepEqual(calls, ['close:ws-run'], 'the directory is NOT trashed while the terminals are still being killed')

  finishTeardown()
  await deleting
  assert.deepEqual(
    calls,
    ['close:ws-run', `delete:${target.runDirectory}`, `tombstone:${DELETED}`],
    'teardown, then the trash move, then the tombstone',
  )

  // A run with no resident workspace has nothing to tear down: it must not stall
  // waiting for a teardown that will never happen.
  const soloCalls: string[] = []
  await deleteSprintRun(
    { statePath: KEPT, runDirectory: '/work/multicode/.sprintengine/sprintengine/august-audit', residentWorkspaceId: null },
    {
      closeWorkspace: () => {
        soloCalls.push('close')
        return new Promise<void>(() => {})
      },
      deletePath: () => {
        soloCalls.push('delete')
        return Promise.resolve()
      },
      noteDeleted: () => soloCalls.push('tombstone'),
    },
  )
  assert.deepEqual(soloCalls, ['delete', 'tombstone'], 'no workspace, no wait')

  // A failed trash move leaves no tombstone: the run is still on disk, still the
  // operator's to see, and the caller reports the failure.
  const failedCalls: string[] = []
  await assert.rejects(
    deleteSprintRun(
      { statePath: KEPT, runDirectory: '/work/locked', residentWorkspaceId: null },
      {
        closeWorkspace: () => Promise.resolve(),
        deletePath: () => Promise.reject(new Error('EPERM')),
        noteDeleted: () => failedCalls.push('tombstone'),
      },
    ),
    /EPERM/,
    'a delete that failed is reported, not swallowed',
  )
  assert.deepEqual(failedCalls, [], 'and records no tombstone')

  console.log('sprintRunTombstones tests passed')
})()
