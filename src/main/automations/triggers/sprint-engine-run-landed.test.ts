import assert from 'node:assert/strict'
import { join } from 'node:path'

import type { SprintEngineProjectionReadResult } from '../../../shared/electron-api'
import {
  LANDED_CONFIRMATION_MS,
  SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND,
  createSprintEngineRunLandedTriggerProvider,
  validateSprintEngineRunLandedTriggerConfig,
} from './sprint-engine-run-landed'

// Declared before main() is invoked: the bundle downlevels `const` to `var`,
// so a constant defined below the entry call would read as undefined inside
// main's synchronous prologue instead of throwing.
const WORKSPACE_ROOT = '/repo'
const TEAM = 'team-a'
const STATE_PATH = join(WORKSPACE_ROOT, '.multi-code', 'sprintengine', TEAM, 'run.yaml')
// One step past the confirmation window, used to advance the clock between the
// baseline poll and the confirming poll.
const CONFIRM_STEP_MS = LANDED_CONFIRMATION_MS + 1_000

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  assertConfigValidation()
  await assertNonWorktreeRunLandsAfterConfirmationWindow()
  await assertTransientCompletionNeverFiresAndCannotBurnTheRealLanding()
  await assertIncompleteRunNeverFires()
  await assertCanceledRunNeverFires()
  await assertWorktreeRunLandsOnlyWhenEveryRepoMerged()
  await assertPullRequestRefreshIsThrottledPerTeam()
  await assertPullRequestRefreshFailureBlocksPoll()
  await assertUnreadableProjectionBlocksPoll()
  await assertRecreatedTeamDirFiresAgain()
}

type ProjectionOverrides = {
  taskStatuses?: string[]
  runStatus?: string
  vcs?: unknown
  firstEventId?: string
  firstEventTimestamp?: string
}

function projection(overrides: ProjectionOverrides = {}): unknown {
  const taskStatuses = overrides.taskStatuses ?? ['done', 'done']
  return {
    run: {
      name: TEAM,
      goal: 'Ship the thing',
      ...(overrides.runStatus ? { status: overrides.runStatus } : {}),
      ...(overrides.vcs !== undefined ? { vcs: overrides.vcs } : {}),
    },
    roster: {},
    tasks: taskStatuses.map((status, index) => ({
      id: `T${index + 1}`,
      title: `Task ${index + 1}`,
      role: 'developer',
      status,
      dependsOn: [],
    })),
    artifacts: [],
    activity: [{
      id: overrides.firstEventId ?? 'evt-1',
      timestamp: overrides.firstEventTimestamp ?? '2026-07-01T00:00:00Z',
      type: 'run_created',
      actor: 'sprintengine',
      message: 'Run created.',
    }],
  }
}

function worktreeVcs(pullRequestStates: Array<string | null>): unknown {
  return {
    mode: 'run_worktree',
    worktreePath: '.multi-code/sprintengine/team-a/worktree',
    branchName: 'sprintengine/team-a',
    baseRef: 'main',
    repos: pullRequestStates.map((state, index) => ({
      id: index === 0 ? 'primary' : `sibling-${index}`,
      root: index === 0 ? '.' : `../sibling-${index}`,
      worktreePath: index === 0
        ? '.multi-code/sprintengine/team-a/worktree'
        : `.multi-code/sprintengine/team-a/worktree-sibling-${index}`,
      branchName: 'sprintengine/team-a',
      lastCommitSha: null,
      pullRequestUrl: `https://github.com/acme/repo-${index}/pull/1`,
      pullRequestError: null,
      ...(state ? { pullRequestState: state } : {}),
    })),
  }
}

function provider(reads: {
  readProjection: (input: { statePath: string }) => Promise<SprintEngineProjectionReadResult>
  refreshPullRequestStatus?: () => Promise<{ ok: true; data?: unknown } | { ok: false; message: string }>
}) {
  return createSprintEngineRunLandedTriggerProvider({
    readProjection: reads.readProjection,
    refreshPullRequestStatus: async () =>
      (reads.refreshPullRequestStatus ? reads.refreshPullRequestStatus() : { ok: true }) as never,
  })
}

function pollInput(trigger: ReturnType<typeof provider>, now: () => number) {
  const poll = trigger.poll
  assert.ok(poll, 'the sprint-landed trigger polls')
  return (overrides: Partial<{ team: string }> = {}) => poll({
    config: { kind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND, team: overrides.team ?? TEAM },
    workspaceRoot: WORKSPACE_ROOT,
    now,
  })
}

function assertConfigValidation(): void {
  assert.equal(validateSprintEngineRunLandedTriggerConfig({ kind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND, team: TEAM }).ok, true)
  assert.equal(validateSprintEngineRunLandedTriggerConfig({ kind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND, team: '' }).ok, false)
  assert.equal(validateSprintEngineRunLandedTriggerConfig({ kind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND, team: '../escape' }).ok, false)
  assert.equal(validateSprintEngineRunLandedTriggerConfig({ kind: 'schedule', team: TEAM }).ok, false)
  assert.equal(validateSprintEngineRunLandedTriggerConfig(null).ok, false)
}

// A non-worktree run's work is already on the checkout branch, so completion IS
// landed — after it holds across the confirmation window. The same finished run
// then keeps deduping on the same event id.
async function assertNonWorktreeRunLandsAfterConfirmationWindow(): Promise<void> {
  let now = Date.parse('2026-07-17T10:00:00Z')
  const trigger = provider({
    readProjection: async (input) => {
      assert.equal(input.statePath, STATE_PATH, 'the poll reads the watched team run store')
      return { ok: true, data: projection() }
    },
  })
  const poll = pollInput(trigger, () => now)

  const baseline = await poll()
  assert.equal(baseline.ok, true)
  if (baseline.ok) {
    assert.deepEqual(baseline.events, [], 'the first landed observation only arms the confirmation window')
  }

  now += CONFIRM_STEP_MS
  const confirmed = await poll()
  assert.equal(confirmed.ok, true)
  if (!confirmed.ok) return
  assert.equal(confirmed.events.length, 1, 'a landing that held across the window fires')
  const event = confirmed.events[0]
  assert.match(event.id, new RegExp(`^sprint-landed:${TEAM}:[0-9a-f]{16}$`))
  assert.equal(event.payload.team, TEAM)
  assert.equal(event.payload.statePath, STATE_PATH)

  now += 60_000
  const repoll = await poll()
  assert.equal(repoll.ok, true)
  if (repoll.ok) {
    assert.equal(repoll.events[0]?.id, event.id, 'the same finished run keeps the same dedupe id')
  }
}

// The transient all-done window (task 1 done before task 2 exists) must not fire
// — a not-landed observation resets the confirmation window. And because the
// fingerprint covers the task set, even a hypothetical premature fire could not
// dedupe-mask the real landing: the finished run's id differs.
async function assertTransientCompletionNeverFiresAndCannotBurnTheRealLanding(): Promise<void> {
  let now = Date.parse('2026-07-17T10:00:00Z')
  let taskStatuses = ['done']
  const trigger = provider({
    readProjection: async () => ({ ok: true, data: projection({ taskStatuses }) }),
  })
  const poll = pollInput(trigger, () => now)

  const transient = await poll()
  assert.equal(transient.ok, true)
  if (transient.ok) assert.deepEqual(transient.events, [], 'a transient all-done graph only arms the window')

  // The architect adds task 2 before the window elapses: the landing resets.
  now += 60_000
  taskStatuses = ['done', 'in_progress']
  const reopened = await poll()
  assert.equal(reopened.ok, true)
  if (reopened.ok) assert.deepEqual(reopened.events, [], 'an open task means not landed')

  // The run truly finishes: new baseline, then a confirmed fire.
  now += 60_000
  taskStatuses = ['done', 'done']
  const rebaseline = await poll()
  assert.equal(rebaseline.ok, true)
  if (rebaseline.ok) assert.deepEqual(rebaseline.events, [], 'the real landing re-arms the window')
  now += CONFIRM_STEP_MS
  const confirmed = await poll()
  assert.equal(confirmed.ok, true)
  if (!confirmed.ok) return
  assert.equal(confirmed.events.length, 1, 'the real landing fires after holding')

  // The one-task and two-task landings fingerprint differently, so a premature
  // one-task event id could never have masked this one.
  taskStatuses = ['done']
  const oneTaskBaseline = await poll()
  now += CONFIRM_STEP_MS
  const oneTaskConfirmed = await poll()
  assert.equal(oneTaskBaseline.ok, true)
  assert.equal(oneTaskConfirmed.ok, true)
  if (oneTaskConfirmed.ok && confirmed.ok) {
    assert.notEqual(
      oneTaskConfirmed.events[0]?.id,
      confirmed.events[0]?.id,
      'a different task set is a different landing id',
    )
  }
}

async function assertIncompleteRunNeverFires(): Promise<void> {
  const trigger = provider({
    readProjection: async () => ({ ok: true, data: projection({ taskStatuses: ['done', 'in_progress'] }) }),
  })
  const result = await pollInput(trigger, () => 0)()
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.events, [], 'an unfinished run never fires')
}

async function assertCanceledRunNeverFires(): Promise<void> {
  // A canceled run's tasks are `canceled`, not `done` — and even a fully-done
  // store with a canceled run status must not chain, however long it holds.
  let now = Date.parse('2026-07-17T10:00:00Z')
  const trigger = provider({
    readProjection: async () => ({ ok: true, data: projection({ runStatus: 'canceled' }) }),
  })
  const poll = pollInput(trigger, () => now)
  const first = await poll()
  now += CONFIRM_STEP_MS
  const second = await poll()
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (second.ok) assert.deepEqual(second.events, [], 'a canceled run never fires')
}

// A worktree run has landed only when EVERY declared repo's pull request merged
// (MC-1613 rollup) — one merged repo of two is not landed.
async function assertWorktreeRunLandsOnlyWhenEveryRepoMerged(): Promise<void> {
  let now = Date.parse('2026-07-17T10:00:00Z')
  let merged: Array<string | null> = ['merged', 'open']
  let refreshes = 0
  const trigger = provider({
    readProjection: async () => ({ ok: true, data: projection({ vcs: worktreeVcs(merged) }) }),
    refreshPullRequestStatus: async () => {
      refreshes += 1
      return { ok: true }
    },
  })
  const poll = pollInput(trigger, () => now)

  const partial = await poll()
  assert.equal(partial.ok, true)
  if (partial.ok) assert.deepEqual(partial.events, [], 'one of two merged repos is not landed')
  assert.equal(refreshes, 1, 'a complete-but-unmerged run asks GitHub once')

  now += 6 * 60_000
  merged = ['merged', 'merged']
  const baseline = await poll()
  assert.equal(baseline.ok, true)
  if (baseline.ok) assert.deepEqual(baseline.events, [], 'the all-merged observation arms the window')

  now += CONFIRM_STEP_MS
  const landed = await poll()
  assert.equal(landed.ok, true)
  if (landed.ok) assert.equal(landed.events.length, 1, 'all repos merged means landed')
}

async function assertPullRequestRefreshIsThrottledPerTeam(): Promise<void> {
  let now = Date.parse('2026-07-17T10:00:00Z')
  let refreshes = 0
  const trigger = provider({
    readProjection: async () => ({ ok: true, data: projection({ vcs: worktreeVcs(['open']) }) }),
    refreshPullRequestStatus: async () => {
      refreshes += 1
      return { ok: true }
    },
  })
  const poll = pollInput(trigger, () => now)

  await poll()
  assert.equal(refreshes, 1)
  now += 60_000
  const inWindow = await poll()
  assert.equal(refreshes, 1, 'a second poll inside the throttle window does not ask GitHub again')
  assert.equal(inWindow.ok, true)
  if (inWindow.ok) assert.deepEqual(inWindow.events, [], 'and reports nothing landed')
  now += 5 * 60_000
  await poll()
  assert.equal(refreshes, 2, 'the throttle window reopens after ~5 minutes')
}

// A failing PR-status refresh (gh missing/unauthenticated, network down) must
// surface as a blocked poll, not a silent "nothing landed" — and the throttle
// still rate-limits retries against a broken gh.
async function assertPullRequestRefreshFailureBlocksPoll(): Promise<void> {
  let now = Date.parse('2026-07-17T10:00:00Z')
  let refreshes = 0
  const trigger = provider({
    readProjection: async () => ({ ok: true, data: projection({ vcs: worktreeVcs(['open']) }) }),
    refreshPullRequestStatus: async () => {
      refreshes += 1
      return { ok: false, message: 'gh: not logged in' }
    },
  })
  const poll = pollInput(trigger, () => now)

  const blocked = await poll()
  assert.equal(blocked.ok, false, 'a failed refresh blocks the poll')
  if (!blocked.ok) assert.match(blocked.blockedReason, /status refresh failed.*not logged in/u)

  now += 60_000
  const throttled = await poll()
  assert.equal(refreshes, 1, 'the failure is not retried inside the throttle window')
  assert.equal(throttled.ok, true, 'inside the window the poll degrades to the stale projection')

  now += 5 * 60_000
  const retried = await poll()
  assert.equal(refreshes, 2, 'the refresh is retried once the window reopens')
  assert.equal(retried.ok, false)
}

async function assertUnreadableProjectionBlocksPoll(): Promise<void> {
  const trigger = provider({
    readProjection: async () => ({ ok: false, message: 'run store v3, this build reads v4', permanent: true }),
  })
  const result = await pollInput(trigger, () => 0)()
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.blockedReason, /unreadable.*v3/u)
}

// A deleted-and-recreated team dir starts a new event log, so its fingerprint —
// and therefore its dedupe id — differs and the chain fires for the new run.
async function assertRecreatedTeamDirFiresAgain(): Promise<void> {
  let now = Date.parse('2026-07-17T10:00:00Z')
  let firstEventTimestamp = '2026-07-01T00:00:00Z'
  const trigger = provider({
    readProjection: async () => ({ ok: true, data: projection({ firstEventTimestamp }) }),
  })
  const poll = pollInput(trigger, () => now)

  await poll()
  now += CONFIRM_STEP_MS
  const original = await poll()

  // Recreated store: new first event → new baseline, then a new id.
  firstEventTimestamp = '2026-07-16T12:00:00Z'
  now += 60_000
  const recreatedBaseline = await poll()
  assert.equal(recreatedBaseline.ok, true)
  if (recreatedBaseline.ok) {
    assert.deepEqual(recreatedBaseline.events, [], 'a new run identity re-arms the confirmation window')
  }
  now += CONFIRM_STEP_MS
  const recreated = await poll()

  assert.equal(original.ok, true)
  assert.equal(recreated.ok, true)
  if (original.ok && recreated.ok) {
    assert.notEqual(original.events[0]?.id, recreated.events[0]?.id, 'a recreated team dir gets a fresh dedupe id')
  }
}
