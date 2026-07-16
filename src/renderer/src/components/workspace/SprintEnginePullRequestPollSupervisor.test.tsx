import assert from 'node:assert/strict'

import {
  collectWatchablePullRequestTargets,
  createPullRequestPollController,
  isPullRequestWatchable,
  isRunPullRequestWatchable,
  PR_MERGE_POLL_BACKOFF,
  type PullRequestPollTarget,
} from './SprintEnginePullRequestPollSupervisor'
import type { SprintEngineVcsRepo } from '../../../../shared/sprintengine/run-types'
import type { Workspace } from '../../types/workspace'

// ---------------------------------------------------------------------------
// isPullRequestWatchable
// ---------------------------------------------------------------------------
assert.equal(isPullRequestWatchable({ hasVcs: true, prState: 'open', hasPrUrl: true }), true)
// State not yet known but a PR exists → watch it.
assert.equal(isPullRequestWatchable({ hasVcs: true, prState: null, hasPrUrl: true }), true)
// Null state with no PR yet → nothing to watch.
assert.equal(isPullRequestWatchable({ hasVcs: true, prState: null, hasPrUrl: false }), false)
// Terminal states → done.
assert.equal(isPullRequestWatchable({ hasVcs: true, prState: 'merged', hasPrUrl: true }), false)
assert.equal(isPullRequestWatchable({ hasVcs: true, prState: 'closed', hasPrUrl: true }), false)
// No vcs → no branch/PR.
assert.equal(isPullRequestWatchable({ hasVcs: false, prState: 'open', hasPrUrl: true }), false)

// ---------------------------------------------------------------------------
// isRunPullRequestWatchable — the run's projects, not just the primary (MC-1612)
// ---------------------------------------------------------------------------
function repo(id: string, overrides: Partial<SprintEngineVcsRepo> = {}): SprintEngineVcsRepo {
  return {
    id,
    root: id === 'primary' ? '.' : `../${id}`,
    worktreePath: `.multi-code/sprintengine/alpha/worktree${id === 'primary' ? '' : `-${id}`}`,
    branchName: 'sprintengine/alpha',
    pullRequestState: 'open',
    pullRequestUrl: 'https://pr',
    ...overrides,
  }
}

// `normalizeSprintEngineVcs` always fills `repos` — a run stored before the list
// existed reads back as its one-entry primary — so this only ever sees the list.
function vcs(repos: SprintEngineVcsRepo[]): Workspace['sprintEngineState'] {
  return { vcs: { mode: 'run_worktree', worktreePath: repos[0].worktreePath, branchName: repos[0].branchName, repos } } as Workspace['sprintEngineState']
}

assert.equal(isRunPullRequestWatchable(undefined), false)
assert.equal(isRunPullRequestWatchable(vcs([repo('primary')])!.vcs), true)
// Every project terminal → the whole run is settled.
assert.equal(
  isRunPullRequestWatchable(vcs([repo('primary', { pullRequestState: 'merged' }), repo('mobile', { pullRequestState: 'closed' })])!.vcs),
  false,
)
// The failure this closes: the desktop PR merged, but the mobile one is still open.
// Watching the primary alone would stop polling here and freeze mobile's state.
assert.equal(
  isRunPullRequestWatchable(vcs([repo('primary', { pullRequestState: 'merged' }), repo('mobile', { pullRequestState: 'open' })])!.vcs),
  true,
)
// A project the run never delivered (no PR, no state) keeps nothing alive.
assert.equal(
  isRunPullRequestWatchable(vcs([
    repo('primary', { pullRequestState: 'merged' }),
    repo('mobile', { pullRequestState: null, pullRequestUrl: null }),
  ])!.vcs),
  false,
)

// ---------------------------------------------------------------------------
// collectWatchablePullRequestTargets
// ---------------------------------------------------------------------------
function workspace(overrides: Partial<Workspace> & { id: string }): Workspace {
  return {
    id: overrides.id,
    mode: 'sprintengine',
    sprintEngineContext: { statePath: `/runs/${overrides.id}.yaml` },
    sprintEngineState: vcs([repo('primary')]),
    ...overrides,
  } as unknown as Workspace
}

{
  const workspaces = [
    workspace({ id: 'a' }),
    workspace({
      id: 'b',
      sprintEngineState: vcs([repo('primary', { pullRequestState: 'merged' })]),
    } as Partial<Workspace> & { id: string }),
    workspace({ id: 'c', sprintEngineContext: undefined } as Partial<Workspace> & { id: string }),
    workspace({ id: 'not-in-window' }),
    { id: 'plain', mode: 'terminal' } as unknown as Workspace,
    // A two-project run whose desktop PR has merged: still watchable, because the
    // mobile PR has not.
    workspace({
      id: 'multi',
      sprintEngineState: vcs([repo('primary', { pullRequestState: 'merged' }), repo('mobile')]),
    } as Partial<Workspace> & { id: string }),
  ]
  const targets = collectWatchablePullRequestTargets(workspaces, new Set(['a', 'b', 'c', 'plain', 'multi']))
  // 'a' and 'multi' qualify: 'b' merged, 'c' has no statePath, 'not-in-window'
  // excluded by id set, 'plain' is not a sprint workspace.
  assert.deepEqual(targets, [
    { workspaceId: 'a', statePath: '/runs/a.yaml' },
    { workspaceId: 'multi', statePath: '/runs/multi.yaml' },
  ])
}

// ---------------------------------------------------------------------------
// createPullRequestPollController — backoff schedule, arm/disarm, re-arm
// ---------------------------------------------------------------------------

// A hand-driven clock: registered timers fire only when we advance to them, so
// the backoff schedule is exercised synchronously and deterministically.
function makeClock() {
  let seq = 1
  const pending = new Map<number, { handler: () => void; dueAt: number }>()
  let nowMs = 0
  return {
    setTimeout: (handler: () => void, ms: number): number => {
      const id = seq++
      pending.set(id, { handler, dueAt: nowMs + ms })
      return id
    },
    clearTimeout: (id: number): void => {
      pending.delete(id)
    },
    // Fire the single earliest-due pending timer (like real time advancing to it).
    tick(): number | null {
      let nextId: number | null = null
      let nextDue = Infinity
      for (const [id, entry] of pending) {
        if (entry.dueAt < nextDue) {
          nextDue = entry.dueAt
          nextId = id
        }
      }
      if (nextId === null) return null
      const entry = pending.get(nextId)!
      pending.delete(nextId)
      nowMs = entry.dueAt
      entry.handler()
      return nextDue
    },
    pendingCount: () => pending.size,
    lastDelayMs: () => nowMs,
  }
}

const MIN = 60_000
const targetA: PullRequestPollTarget = { workspaceId: 'a', statePath: '/runs/a.yaml' }

// The full backoff sequence: six probes at cumulative 1,3,7,15,31,63 min, then
// the poller exhausts and holds no more timers.
{
  const clock = makeClock()
  const probed: number[] = []
  let activeCount = -1
  const controller = createPullRequestPollController({
    backoff: PR_MERGE_POLL_BACKOFF,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    probe: async () => {
      probed.push(clock.lastDelayMs())
    },
    onActiveCountChange: (count) => {
      activeCount = count
    },
  })

  controller.sync([targetA], null)
  assert.equal(clock.pendingCount(), 1) // armed at base
  assert.equal(activeCount, 1)

  // Drive all six probes. Each tick fires the due probe (async) then re-arms.
  for (let i = 0; i < 6; i += 1) {
    clock.tick()
    // Let the probe's async .finally re-schedule before the next tick.
    await Promise.resolve()
    await Promise.resolve()
  }
  assert.deepEqual(
    probed,
    [1, 3, 7, 15, 31, 63].map((m) => m * MIN),
    'probes fire at the cumulative backoff offsets',
  )
  // Exhausted: no pending timer, active count back to zero.
  assert.equal(clock.pendingCount(), 0)
  assert.equal(activeCount, 0)

  controller.dispose()
}

// A watchable run that becomes terminal (merged) disarms immediately.
{
  const clock = makeClock()
  let probes = 0
  const controller = createPullRequestPollController({
    backoff: PR_MERGE_POLL_BACKOFF,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    probe: async () => {
      probes += 1
    },
  })
  controller.sync([targetA], null)
  assert.equal(clock.pendingCount(), 1)
  // Next store snapshot: the run merged → no longer in the target set.
  controller.sync([], null)
  assert.equal(clock.pendingCount(), 0, 'a merged run tears its timer down')
  assert.equal(probes, 0)
  controller.dispose()
}

// Re-arm on "opened again": after the schedule exhausts, activating the workspace
// starts a fresh backoff cycle; activating a still-armed one does not disturb it.
{
  const clock = makeClock()
  const controller = createPullRequestPollController({
    backoff: PR_MERGE_POLL_BACKOFF,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    probe: async () => {},
  })
  controller.sync([targetA], null)
  // Exhaust the schedule.
  for (let i = 0; i < 6; i += 1) {
    clock.tick()
    await Promise.resolve()
    await Promise.resolve()
  }
  assert.equal(clock.pendingCount(), 0)

  // Same active id repeated → not "just activated" → stays exhausted.
  controller.sync([targetA], 'a')
  assert.equal(clock.pendingCount(), 1, 'first activation re-arms')
  // Re-syncing with the same active id must not re-arm again / stack timers.
  controller.sync([targetA], 'a')
  assert.equal(clock.pendingCount(), 1, 'no duplicate timers on repeat activation')
  controller.dispose()
  assert.equal(clock.pendingCount(), 0)
}

console.log('SprintEnginePullRequestPollSupervisor: all assertions passed')
