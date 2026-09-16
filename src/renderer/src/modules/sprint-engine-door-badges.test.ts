import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createRendererHost } from './renderer-host'
import { registerSprintEngineDoorBadges } from './sprint-engine-door-badges'
import { isSprintRun } from './sprint-engine-sprints-partition'
import { isWorkflowRun } from '../components/workspace/globalSurface/workflows/runPartition'
import { resetSprintRunIndexForTests } from '../components/workspace/globalSurface/sprints/sprintRunIndexStore'

const host = createRendererHost()
registerSprintEngineDoorBadges(host.hostFor('sprint-engine'))
const badges = host.getDoorBadges()
assert.deepEqual(
  badges.map((badge) => badge.rowId).sort(),
  ['sprints', 'workflows'],
  'the module contributes a waiting count for each run door',
)
assert.equal(badges.find((badge) => badge.rowId === 'sprints')?.notificationSource, 'sprintengine')
assert.equal(badges.find((badge) => badge.rowId === 'workflows')?.notificationSource, undefined)

resetSprintRunIndexForTests()
assert.equal(
  badges.find((badge) => badge.rowId === 'sprints')?.getWaitingCount(),
  0,
  'an empty index is no waiting count, not a guess',
)

// The partition split: Workflows claims a named seat; Sprints is the fallback.
assert.equal(isWorkflowRun({ coordinatorSeat: { role: 'architect' } as never }), true)
assert.equal(isSprintRun({ coordinatorSeat: { role: 'architect' } as never }), false)
assert.equal(isWorkflowRun({ coordinatorSeat: null }), false)
assert.equal(isSprintRun({ coordinatorSeat: null }), true)

const hookSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/useExtensionsRowBadges.ts'),
  'utf8',
)
assert.ok(
  !hookSource.includes('runDoors'),
  'the badge hook no longer imports the run-door partition',
)
assert.ok(
  !hookSource.includes('useSprintRunIndex'),
  'the badge hook no longer imports the sprint run index',
)
assert.ok(hookSource.includes('useDoorBadgeWaitingCounts'))

const railSource = readFileSync(join(process.cwd(), 'src/renderer/src/utils/railBadges.ts'), 'utf8')
assert.ok(!railSource.includes('runDoors'), 'railBadges does not import run-door helpers')
assert.ok(
  !railSource.includes("case 'sprintengine'"),
  'railBadges no longer switches on sprintengine to pick a drawer row',
)

console.log('sprint-engine-door-badges.test.ts: ok')
