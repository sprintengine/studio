import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  applyAgentLaunchSettingsPatch,
  emptyAgentLaunchSettings,
  normalizeAgentLaunchSettings,
  normalizeAgentLaunchSettingsPatch,
} from './launch-settings'
import {
  PROJECT_USAGE_LIMIT,
  PROJECT_USE_HALF_LIFE_MS,
  normalizeProjectUsageMap,
  projectFrecency,
  projectUsageKey,
  recordProjectUse,
  sortByProjectUse,
  withProjectUse,
  type ProjectUsageMap,
} from './project-frecency'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 1)

const close = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? 'score'}: ${actual} is not ${expected}`)

test('a use weighs 1 when it happens and half that a week later', () => {
  const once = recordProjectUse(null, T0)
  assert.deepEqual(once, { score: 1, scoredAt: T0, lastUsedAt: T0, useCount: 1 })
  close(projectFrecency(once, T0), 1)
  close(projectFrecency(once, T0 + PROJECT_USE_HALF_LIFE_MS), 0.5)
  close(projectFrecency(once, T0 + 2 * PROJECT_USE_HALF_LIFE_MS), 0.25)
  assert.equal(PROJECT_USE_HALF_LIFE_MS, 7 * DAY)
})

test('the running score is the sum of every use decayed on its own', () => {
  const uses = [T0, T0 + DAY, T0 + 3 * DAY, T0 + 10 * DAY]
  let usage = null as ReturnType<typeof recordProjectUse> | null
  for (const at of uses) usage = recordProjectUse(usage, at)
  const now = T0 + 20 * DAY
  const expected = uses.reduce((sum, at) => sum + Math.pow(2, -(now - at) / PROJECT_USE_HALF_LIFE_MS), 0)
  close(projectFrecency(usage, now), expected)
  assert.equal(usage?.useCount, 4)
  assert.equal(usage?.lastUsedAt, T0 + 10 * DAY)
})

test('a use stamped before the stored score adds its own decayed weight, in either order', () => {
  const inOrder = recordProjectUse(recordProjectUse(null, T0), T0 + DAY)
  const late = recordProjectUse(recordProjectUse(null, T0 + DAY), T0)
  const now = T0 + 5 * DAY
  close(projectFrecency(late, now), projectFrecency(inOrder, now))
  assert.equal(late.lastUsedAt, T0 + DAY, 'the latest use stays the latest')
  close(projectFrecency(inOrder, T0 - DAY), projectFrecency(inOrder, T0 + DAY), 'a clock behind reads no higher')
})

test('a project used often a week ago stays above one used once today, until that one is used again', () => {
  let often: ReturnType<typeof recordProjectUse> | null = null
  for (let i = 0; i < 5; i += 1) often = recordProjectUse(often, T0 + i * 60_000)
  const usage: ProjectUsageMap = { '/w/often': often!, '/w/today': recordProjectUse(null, T0 + 7 * DAY) }
  const items = ['/w/today', '/w/often']
  // About 2.5 against 1.
  assert.deepEqual(
    sortByProjectUse(items, (p) => p, usage, T0 + 7 * DAY),
    ['/w/often', '/w/today'],
  )
  // Decay alone never swaps two projects (both halve alike); new uses do.
  assert.deepEqual(
    sortByProjectUse(items, (p) => p, usage, T0 + 70 * DAY),
    ['/w/often', '/w/today'],
  )
  usage['/w/today'] = recordProjectUse(recordProjectUse(usage['/w/today'], T0 + 8 * DAY), T0 + 9 * DAY)
  // About 2.05 against 2.73.
  assert.deepEqual(
    sortByProjectUse(items, (p) => p, usage, T0 + 9 * DAY),
    ['/w/today', '/w/often'],
  )
})

test('never-used projects keep their order, below every used one', () => {
  const usage: ProjectUsageMap = { '/w/c': recordProjectUse(null, T0) }
  const items = ['/w/a', '/w/b', '/w/c', '/w/d']
  assert.deepEqual(
    sortByProjectUse(items, (p) => p, usage, T0 + 400 * DAY),
    ['/w/c', '/w/a', '/w/b', '/w/d'],
  )
  assert.deepEqual(
    sortByProjectUse(items, (p) => p, {}, T0),
    items,
    'nothing used: the order given',
  )
  assert.deepEqual(
    sortByProjectUse(items, (p) => p, undefined, T0),
    items,
    'no usage at all: the order given',
  )
  assert.deepEqual(items, ['/w/a', '/w/b', '/w/c', '/w/d'], 'and the input is not reordered')
})

test('a tie on the score goes to the later use, then to the order given', () => {
  const at = T0 + DAY
  // Equal scores by construction: one use each, at the same moment.
  const same: ProjectUsageMap = { '/w/a': recordProjectUse(null, at), '/w/b': recordProjectUse(null, at) }
  assert.deepEqual(
    sortByProjectUse(['/w/b', '/w/a'], (p) => p, same, at),
    ['/w/b', '/w/a'],
    'a full tie keeps the order given',
  )
  const laterUse: ProjectUsageMap = {
    '/w/a': { score: 1, scoredAt: at, lastUsedAt: at - DAY, useCount: 2 },
    '/w/b': { score: 1, scoredAt: at, lastUsedAt: at, useCount: 1 },
  }
  assert.deepEqual(
    sortByProjectUse(['/w/a', '/w/b'], (p) => p, laterUse, at),
    ['/w/b', '/w/a'],
  )
})

test('a project is its folder, however the folder is spelled', () => {
  assert.equal(projectUsageKey('/Users/dev/App/'), '/users/dev/app')
  assert.equal(projectUsageKey('C:\\Users\\dev\\app'), 'c:/users/dev/app')
  assert.equal(projectUsageKey('  '), null)
  assert.equal(projectUsageKey(null), null)
  const usage = withProjectUse({}, '/Users/dev/App/', T0)
  assert.deepEqual(
    sortByProjectUse(['/users/dev/other', '/Users/dev/App'], (p) => p, usage, T0),
    ['/Users/dev/App', '/users/dev/other'],
  )
  assert.equal(withProjectUse(usage, '', T0), usage, 'no folder records nothing')
})

test('only the most-used projects are remembered', () => {
  let usage: ProjectUsageMap = {}
  for (let i = 0; i < PROJECT_USAGE_LIMIT; i += 1) usage = withProjectUse(usage, `/w/p${i}`, T0 + i * DAY)
  usage = withProjectUse(usage, '/w/newest', T0 + PROJECT_USAGE_LIMIT * DAY)
  assert.equal(Object.keys(usage).length, PROJECT_USAGE_LIMIT)
  assert.ok(usage['/w/newest'], 'the use just recorded is kept')
  assert.equal(usage['/w/p0'], undefined, 'the oldest single use is the one dropped')
})

test('at the cap, the project just used is kept even when it ties every other one', () => {
  let usage: ProjectUsageMap = {}
  // A hundred projects, each used once at the same moment: all score 1.
  for (let i = 0; i < PROJECT_USAGE_LIMIT; i += 1) usage = withProjectUse(usage, `/w/p${i}`, T0)
  usage = withProjectUse(usage, '/w/newest', T0)
  assert.equal(Object.keys(usage).length, PROJECT_USAGE_LIMIT)
  assert.ok(usage['/w/newest'], 'the use just recorded is kept')
})

test('at the cap, the project just used is kept beside scores stamped ahead of this clock', () => {
  // Another process's uses, scored a day ahead: they do not decay here, and
  // each outranks a single use made now.
  const ahead: ProjectUsageMap = {}
  for (let i = 0; i < PROJECT_USAGE_LIMIT; i += 1)
    ahead[`/w/p${i}`] = { score: 2, scoredAt: T0 + DAY, lastUsedAt: T0 + DAY, useCount: 2 }
  const usage = withProjectUse(ahead, '/w/newest', T0)
  assert.equal(Object.keys(usage).length, PROJECT_USAGE_LIMIT)
  assert.ok(usage['/w/newest'], 'the use just recorded is kept')
})

test('stored usage is read fail-soft', () => {
  assert.deepEqual(
    normalizeProjectUsageMap({
      '/w/ok': { score: 1.5, scoredAt: T0, lastUsedAt: T0, useCount: 2 },
      '/w/zero': { score: 0, scoredAt: T0, lastUsedAt: T0, useCount: 1 },
      '/w/bad': { score: 'x', scoredAt: T0, lastUsedAt: T0, useCount: 1 },
      '/w/null': null,
    }),
    { '/w/ok': { score: 1.5, scoredAt: T0, lastUsedAt: T0, useCount: 2 } },
  )
  assert.deepEqual(normalizeProjectUsageMap([1, 2]), {})
  assert.deepEqual(normalizeAgentLaunchSettings({}).projectUsage, {}, 'a record from before has none')
})

test('a `projectUse` patch adds a use to what main holds rather than replacing it', () => {
  const once = applyAgentLaunchSettingsPatch(
    emptyAgentLaunchSettings(),
    normalizeAgentLaunchSettingsPatch({ projectUse: { folderPath: '/Users/dev/app', at: T0 } }),
  )
  const twice = applyAgentLaunchSettingsPatch(
    once,
    normalizeAgentLaunchSettingsPatch({ projectUse: { folderPath: '/Users/dev/app/', at: T0 + DAY } }),
  )
  assert.equal(twice.projectUsage['/users/dev/app']?.useCount, 2)
  assert.equal(twice.projectUsage['/users/dev/app']?.lastUsedAt, T0 + DAY)
  assert.deepEqual(once.projectUsage['/users/dev/app']?.useCount, 1, 'the earlier settings are not mutated')
  for (const projectUse of [{ folderPath: '', at: T0 }, { folderPath: '/w', at: Number.NaN }, { folderPath: 3 }]) {
    assert.deepEqual(normalizeAgentLaunchSettingsPatch({ projectUse }), {}, 'a malformed use is dropped')
  }
})
