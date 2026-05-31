import assert from 'node:assert/strict'
import {
  clearSwitchboardRefreshCoordinatorForTests,
  rememberSwitchboardRefreshValue,
  runSwitchboardRefresh,
  switchboardRefreshMinIntervalMs,
} from './switchboardRefreshCoordinator'

async function testConcurrentRequestsShareOneLoad(): Promise<void> {
  clearSwitchboardRefreshCoordinatorForTests()
  let calls = 0
  let release!: (value: string) => void
  const load = () => {
    calls += 1
    return new Promise<string>((resolve) => {
      release = resolve
    })
  }

  const first = runSwitchboardRefresh('tasks:/repo', load, { force: true })
  const second = runSwitchboardRefresh('tasks:/repo', load, { force: true })
  release('loaded')

  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(firstResult.kind, 'loaded')
  assert.equal(secondResult.kind, 'loaded')
  assert.equal(secondResult.shared, true)
  assert.equal(firstResult.value, 'loaded')
  assert.equal(secondResult.value, 'loaded')
}

async function testRecentNonForcedRequestUsesCache(): Promise<void> {
  clearSwitchboardRefreshCoordinatorForTests()
  let now = 1_000
  let calls = 0

  const first = await runSwitchboardRefresh(
    'tasks:/repo',
    async () => {
      calls += 1
      return 'initial'
    },
    { force: false, now: () => now }
  )
  assert.equal(first.kind, 'loaded')

  now += switchboardRefreshMinIntervalMs(false) - 1
  const second = await runSwitchboardRefresh(
    'tasks:/repo',
    async () => {
      calls += 1
      return 'unexpected'
    },
    { force: false, now: () => now, isHidden: () => false }
  )

  assert.equal(calls, 1)
  assert.equal(second.kind, 'cached')
  assert.equal(second.value, 'initial')
}

async function testHiddenRefreshWaitsLonger(): Promise<void> {
  clearSwitchboardRefreshCoordinatorForTests()
  let now = 5_000
  let calls = 0

  await runSwitchboardRefresh(
    'runner:/repo',
    async () => {
      calls += 1
      return 'visible'
    },
    { force: false, now: () => now }
  )

  now += switchboardRefreshMinIntervalMs(false) + 1
  const hidden = await runSwitchboardRefresh(
    'runner:/repo',
    async () => {
      calls += 1
      return 'hidden'
    },
    { force: false, now: () => now, isHidden: () => true }
  )

  assert.equal(calls, 1)
  assert.equal(hidden.kind, 'cached')
  assert.equal(hidden.value, 'visible')

  now = 5_000 + switchboardRefreshMinIntervalMs(true) + 1
  const stale = await runSwitchboardRefresh(
    'runner:/repo',
    async () => {
      calls += 1
      return 'refreshed'
    },
    { force: false, now: () => now, isHidden: () => true }
  )

  assert.equal(calls, 2)
  assert.equal(stale.kind, 'loaded')
  assert.equal(stale.value, 'refreshed')
}

async function testRememberedMutationResultPreventsStaleCache(): Promise<void> {
  clearSwitchboardRefreshCoordinatorForTests()
  let calls = 0
  await runSwitchboardRefresh(
    'runner:/repo',
    async () => {
      calls += 1
      return 'stopped'
    },
    { force: false, now: () => 1_000 }
  )
  rememberSwitchboardRefreshValue('runner:/repo', 'running', { now: () => 2_000 })

  const result = await runSwitchboardRefresh(
    'runner:/repo',
    async () => {
      calls += 1
      return 'unexpected'
    },
    { force: false, now: () => 2_100 }
  )

  assert.equal(calls, 1)
  assert.equal(result.kind, 'cached')
  assert.equal(result.value, 'running')
}

async function testInFlightRefreshDoesNotOverwriteRememberedMutation(): Promise<void> {
  clearSwitchboardRefreshCoordinatorForTests()
  let release!: (value: string) => void
  const refresh = runSwitchboardRefresh(
    'runner:/repo',
    () => new Promise<string>((resolve) => {
      release = resolve
    }),
    { force: true, now: () => 1_000 }
  )

  rememberSwitchboardRefreshValue('runner:/repo', 'started', { now: () => 1_100 })
  release('stale')

  const refreshResult = await refresh
  assert.equal(refreshResult.kind, 'cached')
  assert.equal(refreshResult.value, 'started')

  const next = await runSwitchboardRefresh(
    'runner:/repo',
    async () => 'unexpected',
    { force: false, now: () => 1_200 }
  )
  assert.equal(next.kind, 'cached')
  assert.equal(next.value, 'started')
}

async function main(): Promise<void> {
  await testConcurrentRequestsShareOneLoad()
  await testRecentNonForcedRequestUsesCache()
  await testHiddenRefreshWaitsLonger()
  await testRememberedMutationResultPreventsStaleCache()
  await testInFlightRefreshDoesNotOverwriteRememberedMutation()
}

void main()
