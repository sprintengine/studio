import assert from 'node:assert/strict'

import {
  createSprintPullRequestMergePoller,
  isStaleForBootScan,
  PR_MERGE_POLL_BACKOFF,
  PR_MERGE_POLL_BOOT_SCAN_MAX_AGE_MS,
} from './sprintengine-pr-merge-poller'
import type { SprintRunSummary } from '../shared/sprintengine/runSummary'
import type { SprintEngineVcs, SprintEngineVcsRepo } from '../shared/sprintengine/run-types'

// Every case here runs with ZERO windows and zero Electron: the poller is a plain
// main-process object driven by an injected clock and faked ports, which is the
// point — nothing about a merge probe may depend on a window existing.

const MIN = 60_000

function repo(id: string, overrides: Partial<SprintEngineVcsRepo> = {}): SprintEngineVcsRepo {
  return {
    id,
    root: id === 'primary' ? '.' : `../${id}`,
    worktreePath: `.sprintengine/sprintengine/alpha/worktree${id === 'primary' ? '' : `-${id}`}`,
    branchName: 'sprintengine/alpha',
    pullRequestState: 'open',
    pullRequestUrl: 'https://pr',
    ...overrides,
  }
}

function vcs(repos: SprintEngineVcsRepo[]): SprintEngineVcs {
  return {
    mode: 'run_worktree',
    worktreePath: repos[0].worktreePath,
    branchName: repos[0].branchName,
    repos,
  }
}

function runSummary(statePath: string, updatedAt: string | null = '2026-08-06T00:00:00.000Z'): SprintRunSummary {
  return {
    statePath,
    teamSlug: 'alpha',
    teamName: 'Alpha',
    projectRoot: '/projects/alpha',
    projectName: 'alpha',
    runtimeState: 'completed',
    taskCounts: { total: 1, done: 1, inProgress: 0, waiting: 0 },
    repoRollup: { declared: 1, merged: 0, open: 1 },
    needsInputCount: 0,
    branchName: null,
    worktreePath: null,
    startedAt: null,
    updatedAt,
    finishedAt: null,
    sourceLabel: null,
  }
}

// A hand-driven clock: registered timers fire only when the test advances to
// them, so the whole backoff schedule is exercised synchronously.
function makeClock() {
  let seq = 1
  const pending = new Map<number, { handler: () => void; dueAt: number }>()
  let nowMs = 0
  return {
    setTimeout: (handler: () => void, ms: number): unknown => {
      const id = seq++
      pending.set(id, { handler, dueAt: nowMs + ms })
      return id
    },
    clearTimeout: (handle: unknown): void => {
      pending.delete(handle as number)
    },
    // Fire the single earliest-due timer, as real time advancing to it would.
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
    nowMs: () => nowMs,
  }
}

// Let queued microtasks (the probe promise chain) settle between clock ticks.
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// The headline acceptance: with zero windows, a PR that merges is reflected in
// the run's state within one backoff step.
// ---------------------------------------------------------------------------
{
  const clock = makeClock()
  const statePath = '/projects/alpha/.sprintengine/sprintengine/alpha/run.yaml'
  // The faked PR-status port: the probe is what flips the stored state to merged,
  // exactly as `sprintengine vcs pr-status` rewrites the projection.
  let stored = vcs([repo('primary')])
  let probes = 0

  const poller = createSprintPullRequestMergePoller({
    listRuns: async () => [runSummary(statePath)],
    readRunVcs: async () => stored,
    probe: async () => {
      probes += 1
      stored = vcs([repo('primary', { pullRequestState: 'merged' })])
      return { ok: true }
    },
    timers: clock,
    now: () => Date.parse('2026-08-06T01:00:00.000Z'),
    // No jitter in tests: the schedule under assertion is the pure one.
    jitterRatio: 0,
  })

  const report = await poller.start({ listWorkspaceRoots: () => ['/projects/alpha'] })
  assert.deepEqual(report.watching, [statePath], 'the open-PR run is armed with no window open')
  assert.equal(report.discovered, 1)
  assert.equal(probes, 0, 'arming does not probe')

  assert.equal(clock.tick(), PR_MERGE_POLL_BACKOFF.baseMs, 'first probe lands one base delay in')
  await settle()

  assert.equal(probes, 1)
  assert.equal(stored.repos[0].pullRequestState, 'merged', 'the run state self-healed')
  // Merged is terminal: the poller tears its timer down and the app returns to
  // holding none — no steady-state polling once nothing has an open PR.
  assert.deepEqual(poller.watchedStatePaths(), [])
  assert.equal(clock.pendingCount(), 0)
  poller.dispose()
}

// ---------------------------------------------------------------------------
// The schedule: 1 → 2 → 4 → 8 → 16 → 32 min, then HOLDING at 32 (the deliberate
// difference from the retired renderer supervisor, which halted at the cap).
// ---------------------------------------------------------------------------
{
  const clock = makeClock()
  const statePath = '/runs/open.yaml'
  const probedAt: number[] = []
  const poller = createSprintPullRequestMergePoller({
    listRuns: async () => [runSummary(statePath)],
    // Never merges: the PR is still open every time we look.
    readRunVcs: async () => vcs([repo('primary')]),
    probe: async () => {
      probedAt.push(clock.nowMs())
      return { ok: true }
    },
    timers: clock,
    now: () => Date.parse('2026-08-06T01:00:00.000Z'),
    jitterRatio: 0,
  })
  await poller.start({ listWorkspaceRoots: () => ['/projects/alpha'] })

  for (let i = 0; i < 8; i += 1) {
    clock.tick()
    await settle()
  }
  assert.deepEqual(
    probedAt.map((at) => at / MIN),
    [1, 3, 7, 15, 31, 63, 95, 127],
    'delays double to the 32 min cap and then hold there',
  )
  assert.equal(clock.pendingCount(), 1, 'an open PR keeps exactly one armed timer')
  poller.dispose()
  assert.equal(clock.pendingCount(), 0, 'dispose tears every timer down')
}

// ---------------------------------------------------------------------------
// Nothing to watch → nothing armed. A run whose PRs are all terminal, and a run
// with commits but no PR at all, must not buy a `gh` subprocess.
// ---------------------------------------------------------------------------
{
  const clock = makeClock()
  const byPath: Record<string, SprintEngineVcs | null> = {
    '/runs/merged.yaml': vcs([repo('primary', { pullRequestState: 'merged' })]),
    '/runs/no-pr.yaml': vcs([
      repo('primary', { pullRequestState: null, pullRequestUrl: null, lastCommitSha: 'abc123' }),
    ]),
    '/runs/no-worktree.yaml': null,
  }
  let probes = 0
  const poller = createSprintPullRequestMergePoller({
    listRuns: async () => Object.keys(byPath).map((statePath) => runSummary(statePath)),
    readRunVcs: async (statePath) => byPath[statePath] ?? null,
    probe: async () => {
      probes += 1
      return { ok: true }
    },
    timers: clock,
    now: () => Date.parse('2026-08-06T01:00:00.000Z'),
  })
  const report = await poller.start({ listWorkspaceRoots: () => ['/projects/alpha'] })
  assert.deepEqual(report.watching, [])
  assert.equal(clock.pendingCount(), 0, 'no run has an open PR → no timers at all')
  assert.equal(probes, 0)
  poller.dispose()
}

// ---------------------------------------------------------------------------
// A run that opens a pull request AFTER the scan is armed by the runs-changed
// funnel — the headless path for a sprint that finishes with no window open.
// ---------------------------------------------------------------------------
{
  const clock = makeClock()
  const statePath = '/runs/late-pr.yaml'
  let stored: SprintEngineVcs | null = null
  const poller = createSprintPullRequestMergePoller({
    listRuns: async () => [runSummary(statePath)],
    readRunVcs: async () => stored,
    probe: async () => ({ ok: true }),
    timers: clock,
    now: () => Date.parse('2026-08-06T01:00:00.000Z'),
    jitterRatio: 0,
    // Coalescing is exercised on its own below; here every notification reads.
    changeCoalesceMs: 0,
  })
  await poller.start({ listWorkspaceRoots: () => ['/projects/alpha'] })
  assert.equal(clock.pendingCount(), 0, 'nothing to watch at scan time')

  // The agent opens the PR over MCP; the engine rewrites the projection; the run
  // index's directory watch reports it.
  stored = vcs([repo('primary')])
  poller.noteRunChanged(statePath)
  await settle()
  assert.deepEqual(poller.watchedStatePaths(), [statePath], 'a newly-opened PR arms without a window')

  // A second notification for a run already under watch must NOT restart its
  // schedule — our own probe rewrites the projection, so that would pin it to the
  // base delay forever.
  clock.tick()
  await settle()
  const armedAfterFirstProbe = clock.pendingCount()
  poller.noteRunChanged(statePath)
  await settle()
  assert.equal(clock.pendingCount(), armedAfterFirstProbe, 'no duplicate timers from a change notification')
  assert.equal(clock.tick(), 3 * MIN, 'the schedule advanced rather than restarting at the base delay')

  // The user merges on GitHub; the next notification disarms the run.
  stored = vcs([repo('primary', { pullRequestState: 'merged' })])
  poller.noteRunChanged(statePath)
  await settle()
  assert.deepEqual(poller.watchedStatePaths(), [], 'a merged run stops being watched')
  poller.dispose()
}

// ---------------------------------------------------------------------------
// Module gating and disposal: notifications before start (a disabled Sprint
// Engine module) and after dispose (app quit) arm nothing.
// ---------------------------------------------------------------------------
{
  const clock = makeClock()
  const poller = createSprintPullRequestMergePoller({
    listRuns: async () => [runSummary('/runs/a.yaml')],
    readRunVcs: async () => vcs([repo('primary')]),
    probe: async () => ({ ok: true }),
    timers: clock,
    now: () => Date.parse('2026-08-06T01:00:00.000Z'),
    changeCoalesceMs: 0,
  })
  poller.noteRunChanged('/runs/a.yaml')
  await settle()
  assert.equal(clock.pendingCount(), 0, 'a poller that was never started never probes')

  await poller.start({ listWorkspaceRoots: () => ['/projects/alpha'] })
  assert.equal(clock.pendingCount(), 1)
  poller.dispose()
  poller.noteRunChanged('/runs/a.yaml')
  await settle()
  assert.equal(clock.pendingCount(), 0, 'a disposed poller ignores later notifications')
}

// ---------------------------------------------------------------------------
// A failing probe retries on the next backoff step rather than giving up (a
// transient `gh`/network failure is not evidence the PR is settled).
// ---------------------------------------------------------------------------
{
  const clock = makeClock()
  let probes = 0
  const poller = createSprintPullRequestMergePoller({
    listRuns: async () => [runSummary('/runs/flaky.yaml')],
    readRunVcs: async () => vcs([repo('primary')]),
    probe: async () => {
      probes += 1
      throw new Error('gh: could not resolve host')
    },
    timers: clock,
    now: () => Date.parse('2026-08-06T01:00:00.000Z'),
    jitterRatio: 0,
  })
  await poller.start({ listWorkspaceRoots: () => ['/projects/alpha'] })
  clock.tick()
  await settle()
  assert.equal(probes, 1)
  assert.equal(clock.tick(), 3 * MIN, 'a thrown probe still advances the schedule')
  await settle()
  assert.equal(probes, 2)
  poller.dispose()
}

// ---------------------------------------------------------------------------
// Jitter spreads simultaneously-armed runs instead of firing them in lockstep.
// ---------------------------------------------------------------------------
{
  const clock = makeClock()
  const paths = ['/runs/one.yaml', '/runs/two.yaml', '/runs/three.yaml']
  const randoms = [0, 0.5, 1]
  let randomIndex = 0
  const poller = createSprintPullRequestMergePoller({
    listRuns: async () => paths.map((statePath) => runSummary(statePath)),
    readRunVcs: async () => vcs([repo('primary')]),
    probe: async () => ({ ok: true }),
    timers: clock,
    now: () => Date.parse('2026-08-06T01:00:00.000Z'),
    random: () => randoms[randomIndex++ % randoms.length],
    jitterRatio: 0.2,
  })
  await poller.start({ listWorkspaceRoots: () => ['/projects/alpha'] })
  // random 0 → −20%, 0.5 → unchanged, 1 → +20% of the 1 min base delay.
  assert.equal(clock.tick(), 0.8 * MIN)
  assert.equal(clock.tick(), 1.0 * MIN)
  assert.equal(clock.tick(), 1.2 * MIN)
  poller.dispose()
}

// ---------------------------------------------------------------------------
// The startup freshness bound: an abandoned run is left alone by the scan but is
// still picked up the moment it actually changes.
// ---------------------------------------------------------------------------
{
  const nowMs = Date.parse('2026-08-06T00:00:00.000Z')
  assert.equal(isStaleForBootScan({ updatedAt: '2026-08-05T00:00:00.000Z' }, nowMs, PR_MERGE_POLL_BOOT_SCAN_MAX_AGE_MS), false)
  assert.equal(isStaleForBootScan({ updatedAt: '2026-01-01T00:00:00.000Z' }, nowMs, PR_MERGE_POLL_BOOT_SCAN_MAX_AGE_MS), true)
  // A run reporting no (or an unparseable) timestamp is never withheld on
  // freshness grounds — the budget bound must not be why an open PR goes unwatched.
  assert.equal(isStaleForBootScan({ updatedAt: null }, nowMs, PR_MERGE_POLL_BOOT_SCAN_MAX_AGE_MS), false)
  assert.equal(isStaleForBootScan({ updatedAt: 'whenever' }, nowMs, PR_MERGE_POLL_BOOT_SCAN_MAX_AGE_MS), false)

  const clock = makeClock()
  const statePath = '/runs/abandoned.yaml'
  const poller = createSprintPullRequestMergePoller({
    listRuns: async () => [runSummary(statePath, '2026-01-01T00:00:00.000Z')],
    readRunVcs: async () => vcs([repo('primary')]),
    probe: async () => ({ ok: true }),
    timers: clock,
    now: () => nowMs,
    changeCoalesceMs: 0,
  })
  const report = await poller.start({ listWorkspaceRoots: () => ['/projects/alpha'] })
  assert.deepEqual(report.watching, [])
  assert.deepEqual(report.skippedStale, [statePath], 'a run untouched for months is not scanned into the budget')

  poller.noteRunChanged(statePath)
  await settle()
  assert.deepEqual(poller.watchedStatePaths(), [statePath], 'but any real change puts it back under watch')
  poller.dispose()
}

// ---------------------------------------------------------------------------
// Change notifications coalesce. `notifySprintRunsChanged` fires on every runtime
// op and drops the run's summary memo first, so an uncoalesced evaluation would
// re-read and re-normalize the projection several times a minute per live run.
// ---------------------------------------------------------------------------
{
  const clock = makeClock()
  const statePath = '/runs/chatty.yaml'
  let reads = 0
  let stored: SprintEngineVcs | null = null
  const poller = createSprintPullRequestMergePoller({
    listRuns: async () => [runSummary(statePath)],
    readRunVcs: async () => {
      reads += 1
      return stored
    },
    probe: async () => ({ ok: true }),
    timers: clock,
    // The fake clock's own cursor, so the coalescing window advances with it.
    now: () => clock.nowMs(),
    changeCoalesceMs: 30_000,
    jitterRatio: 0,
  })
  await poller.start({ listWorkspaceRoots: () => ['/projects/alpha'] })
  assert.equal(reads, 1, 'the scan read once')

  poller.noteRunChanged(statePath)
  await settle()
  assert.equal(reads, 2, 'the first notification reads immediately')

  // A burst inside the window collapses to ONE trailing read, and it still sees
  // the PR that was opened during the burst.
  for (let i = 0; i < 10; i += 1) poller.noteRunChanged(statePath)
  await settle()
  assert.equal(reads, 2, 'the burst is held, not read ten times over')
  stored = vcs([repo('primary')])
  assert.equal(clock.tick(), 30 * 1000, 'one trailing read is armed at the end of the window')
  await settle()
  assert.equal(reads, 3)
  assert.deepEqual(poller.watchedStatePaths(), [statePath], 'the coalesced read still arms the new PR')
  poller.dispose()
  assert.equal(clock.pendingCount(), 0, 'dispose clears a pending trailing read too')
}

// ---------------------------------------------------------------------------
// No known project roots (a fresh install) → no scan, no timers.
// ---------------------------------------------------------------------------
{
  const clock = makeClock()
  let listed = 0
  const poller = createSprintPullRequestMergePoller({
    listRuns: async () => {
      listed += 1
      return []
    },
    readRunVcs: async () => null,
    probe: async () => ({ ok: true }),
    timers: clock,
    now: () => Date.parse('2026-08-06T01:00:00.000Z'),
  })
  const report = await poller.start({ listWorkspaceRoots: () => [] })
  assert.equal(listed, 0, 'no roots means no disk scan at all')
  assert.deepEqual(report.watching, [])
  assert.equal(clock.pendingCount(), 0)
  poller.dispose()
}

console.log('sprintengine-pr-merge-poller: all assertions passed')
