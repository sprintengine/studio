import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { dropDeletedSprintRunDebris, noteSprintRunDeleted } from './sprintRunTombstones'

// Deleting a run trashes its directory; a writer that outlived the run can put a
// partial one back at the same path, and the index — which reads disk — lists it
// again as an `unknown`-state row for a run that no longer exists (item 1812).

const DELETED = '/work/multicode/.multi-code/sprintengine/july-hardening/run.yaml'
const KEPT = '/work/multicode/.multi-code/sprintengine/august-audit/run.yaml'

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
    startedAt: null,
    updatedAt: null,
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

// The door's delete is the only writer of tombstones, and it records one only
// after the trash move succeeded — a failed delete leaves the run listing.
const canvas = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/globalSurface/sprints/SprintsCanvas.tsx'),
  'utf8',
)
const deleteBody = canvas.slice(
  canvas.indexOf('const deleteRun = useCallback('),
  canvas.indexOf('} catch (error) {', canvas.indexOf('const deleteRun = useCallback(')),
)
assert.ok(
  deleteBody.indexOf('await requestCloseSprintWorkspace(') <
    deleteBody.indexOf('await window.api.deletePath('),
  'the workspace teardown is awaited before the run directory is trashed',
)
assert.ok(
  deleteBody.indexOf('await window.api.deletePath(') < deleteBody.indexOf('noteSprintRunDeleted('),
  'the tombstone is recorded only after the delete succeeded',
)
assert.match(
  deleteBody,
  /if \(model\.residentWorkspaceId\) await requestCloseSprintWorkspace/,
  'a run with no resident workspace waits for no teardown',
)

console.log('sprintRunTombstones tests passed')
