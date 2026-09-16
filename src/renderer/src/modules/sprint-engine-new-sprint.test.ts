import assert from 'node:assert/strict'

import {
  clearNewSprintRequest,
  noteNewSprintRequest,
  readNewSprintRequest,
} from './sprint-engine-new-sprint'

clearNewSprintRequest()
assert.deepEqual(
  readNewSprintRequest(),
  { folderPath: null, source: null },
  'an empty latch reads as no pending source',
)

noteNewSprintRequest({
  folderPath: '/Users/dev/app',
  source: {
    folderPath: '/Users/dev/app',
    sourcePath: '/Users/dev/app/backlog/plan.md',
    sourceRelativePath: 'backlog/plan.md',
    sourceContent: '# Plan',
    sourcePlanKind: 'architect_plan',
    teamName: 'plan',
    goal: 'Plan',
  },
})
const pending = readNewSprintRequest()
assert.equal(pending.folderPath, '/Users/dev/app')
assert.equal(pending.source?.sourceRelativePath, 'backlog/plan.md')
assert.equal(
  readNewSprintRequest().source?.sourceRelativePath,
  'backlog/plan.md',
  'the latch is readable for the whole visit, not consumed on first read',
)
clearNewSprintRequest()
assert.equal(readNewSprintRequest().source, null, 'clearing drops the pending source')
