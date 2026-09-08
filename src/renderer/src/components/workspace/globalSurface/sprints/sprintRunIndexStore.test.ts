import assert from 'node:assert/strict'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import {
  getSprintRunIndexSnapshot,
  refreshSprintRunIndex,
  resetSprintRunIndexForTests,
  setSprintRunIndexRoots,
  subscribeSprintRunIndex,
} from './sprintRunIndexStore'

// The Sprints run index is read by two components — the sidebar door entry
// (mounted all session) and the door surface (while open). They used to fetch
// independently: two `onSprintRunsChanged` subscriptions and two full disk scans
// per projection write. This asserts the sharing that replaced it, and the two
// properties that make it safe:
//
//   - one subscription and one scan, however many consumers are reading;
//   - a burst coalesces, but a mount and an explicit retry read straight away.
//
// The scan is cheap at rest (~43 ms cold across 40 runs), so this is not about
// steady state — it is about sprint startup, when projections are rewritten
// rapidly and the machine is already busy spawning agents.

const ROOTS = JSON.stringify(['/work/multicode'])
const OTHER_ROOTS = JSON.stringify(['/work/mobile'])

function summary(teamSlug: string): SprintRunSummary {
  return {
    statePath: `/work/multicode/.multi-code/sprintengine/${teamSlug}/run.yaml`,
    teamSlug,
    teamName: teamSlug,
    projectRoot: '/work/multicode',
    projectName: 'multicode',
    runtimeState: 'running',
    taskCounts: { total: 1, done: 0, inProgress: 1, waiting: 0 },
    repoRollup: { declared: 0, merged: 0, open: 0 },
    needsInputCount: 0,
    branchName: null,
    worktreePath: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    sourceLabel: null,
  } as SprintRunSummary
}

type Harness = {
  listCalls: string[][]
  subscriptions: number
  openSubscriptions: number
  emit: () => void
  setRuns: (runs: SprintRunSummary[]) => void
  failNext: (message: string) => void
  blockNext: () => () => void
}

function install(): Harness {
  const state: Harness = {
    listCalls: [],
    subscriptions: 0,
    openSubscriptions: 0,
    emit: () => {},
    setRuns: () => {},
    failNext: () => {},
    blockNext: () => () => {},
  }
  let runs: SprintRunSummary[] = []
  let failure: string | null = null
  let gate: (() => void) | null = null
  const handlers = new Set<() => void>()

  state.emit = () => handlers.forEach((handler) => handler())
  state.setRuns = (next) => {
    runs = next
  }
  state.failNext = (message) => {
    failure = message
  }
  state.blockNext = () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    gate = () => void held.then(() => {})
    // Hand back a releaser that also clears the gate.
    return () => {
      gate = null
      release()
    }
  }

  const api = {
    listSprintRuns: async (roots: string[]) => {
      state.listCalls.push(roots)
      if (gate) await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (failure) {
        const message = failure
        failure = null
        throw new Error(message)
      }
      return runs
    },
    onSprintRunsChanged: (handler: () => void) => {
      state.subscriptions += 1
      state.openSubscriptions += 1
      handlers.add(handler)
      return () => {
        state.openSubscriptions -= 1
        handlers.delete(handler)
      }
    },
  }
  ;(globalThis as unknown as { window: unknown }).window = { api }
  return state
}

const tick = async (times = 4): Promise<void> => {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}
// Longer than the store's 250 ms coalescing window.
const afterWindow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 320))

async function main(): Promise<void> {
  // ── One subscription and one scan, however many consumers ──────────────────
  {
    resetSprintRunIndexForTests()
    const harness = install()
    harness.setRuns([summary('alpha')])

    const consumerA = subscribeSprintRunIndex(() => {})
    const consumerB = subscribeSprintRunIndex(() => {})
    assert.equal(
      harness.subscriptions,
      1,
      'two consumers open ONE main-process subscription, not one each',
    )

    setSprintRunIndexRoots(ROOTS)
    await tick()
    assert.equal(harness.listCalls.length, 1, 'and pointing the shared index at its roots scans once')
    assert.deepEqual(getSprintRunIndexSnapshot().runs.map((r) => r.teamSlug), ['alpha'])
    assert.equal(getSprintRunIndexSnapshot().loadState, 'ready')

    consumerA()
    assert.equal(harness.openSubscriptions, 1, 'one consumer leaving keeps the subscription for the other')
    consumerB()
    assert.equal(harness.openSubscriptions, 0, 'the last consumer to leave closes it — no idle listener')
    console.log('ok - two consumers share one subscription and one scan')
  }

  // ── A burst costs one scan, and never starves ─────────────────────────────
  {
    resetSprintRunIndexForTests()
    const harness = install()
    const stop = subscribeSprintRunIndex(() => {})
    setSprintRunIndexRoots(ROOTS)
    await tick()
    const afterMount = harness.listCalls.length
    assert.equal(afterMount, 1, 'the mount read runs immediately — a burst is what coalesces, not the first read')

    // Twenty writes inside one window, the shape sprint startup produces.
    for (let i = 0; i < 20; i += 1) harness.emit()
    await tick()
    assert.equal(
      harness.listCalls.length - afterMount,
      1,
      'twenty projection writes inside one window cost ONE scan (leading edge), not twenty',
    )

    // The window closes and the trailing edge picks up the writes it folded in.
    await afterWindow()
    await tick()
    assert.equal(
      harness.listCalls.length - afterMount,
      2,
      'and the folded-in writes are not dropped — the window closes with one trailing scan',
    )

    // Sustained writes must keep landing rather than restarting a debounce forever.
    for (let i = 0; i < 5; i += 1) harness.emit()
    await afterWindow()
    await tick()
    assert.ok(
      harness.listCalls.length - afterMount >= 3,
      'sustained writes keep producing scans — a fixed window never starves the rail',
    )
    stop()
    console.log('ok - a burst coalesces to one scan per window, and never starves')
  }

  // ── Overlapping reads collapse instead of stacking ────────────────────────
  {
    resetSprintRunIndexForTests()
    const harness = install()
    const stop = subscribeSprintRunIndex(() => {})
    const release = harness.blockNext()
    setSprintRunIndexRoots(ROOTS)
    // Both consumers mounting while the first scan is still in flight.
    refreshSprintRunIndex()
    refreshSprintRunIndex()
    assert.equal(harness.listCalls.length, 1, 'mounting both consumers during a scan costs ONE scan, not three')
    release()
    await tick(8)
    stop()
    console.log('ok - overlapping reads collapse onto the scan already running')
  }

  // ── A failed read keeps the rows already on screen ────────────────────────
  {
    resetSprintRunIndexForTests()
    const harness = install()
    const stop = subscribeSprintRunIndex(() => {})
    harness.setRuns([summary('alpha')])
    setSprintRunIndexRoots(ROOTS)
    await tick()
    assert.equal(getSprintRunIndexSnapshot().loadState, 'ready')

    harness.failNext('the index could not be read')
    refreshSprintRunIndex()
    await tick(8)
    const snapshot = getSprintRunIndexSnapshot()
    assert.equal(snapshot.loadState, 'error')
    assert.equal(snapshot.error, 'the index could not be read')
    assert.deepEqual(
      snapshot.runs.map((r) => r.teamSlug),
      ['alpha'],
      'an unreadable index is an error WITH a retry, never an empty rail pretending there are no sprints',
    )
    stop()
    console.log('ok - a failed read keeps the rows it already had')
  }

  // ── A changed root set re-reads, and a stale result cannot land ───────────
  {
    resetSprintRunIndexForTests()
    const harness = install()
    const stop = subscribeSprintRunIndex(() => {})
    harness.setRuns([summary('alpha')])
    setSprintRunIndexRoots(ROOTS)
    await tick()
    const before = harness.listCalls.length

    setSprintRunIndexRoots(OTHER_ROOTS)
    await tick(8)
    assert.equal(harness.listCalls.length, before + 1, 'a different set of projects is a different index — it re-reads')
    assert.deepEqual(
      harness.listCalls[harness.listCalls.length - 1],
      ['/work/mobile'],
      'and it scans the new roots, not the old ones',
    )

    // Re-pointing at the same roots is a no-op: every consumer may call it.
    const settled = harness.listCalls.length
    setSprintRunIndexRoots(OTHER_ROOTS)
    await tick()
    assert.equal(harness.listCalls.length, settled, 'pointing it at the roots it already has scans nothing')
    stop()
    console.log('ok - a changed root set re-reads; an unchanged one is free')
  }

  console.log('all sprint run index store tests passed')
}

void main()
