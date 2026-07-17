import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND,
  SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND,
  type AutomationTriggerPollContext,
} from '../../../shared/automations/contracts'
import type { SprintEngineProjectionReadResult } from '../../../shared/electron-api'
import {
  createSprintEngineRunCompletedTriggerProvider,
  createSprintEngineRunNeedsInputTriggerProvider,
  sprintEngineRunFingerprint,
  validateSprintEngineRunCompletedTriggerConfig,
  validateSprintEngineRunNeedsInputTriggerConfig,
} from './sprint-engine-run-events'

// Declared before main() runs: the bundle downlevels `const` to `var`, so a
// constant defined below the entry call reads as undefined inside main's
// synchronous prologue instead of throwing.
const WORKSPACE_ROOT = '/repo'
const TEAM = 'team-a'
const STATE_PATH = join(WORKSPACE_ROOT, '.multi-code', 'sprintengine', TEAM, 'run.yaml')

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  assertConfigValidation()
  assertFingerprintBranches()
  await assertCompletedRunFiresOnceAndDedupes()
  await assertIncompleteRunNeverCompletes()
  await assertEmptyTaskGraphNeverCompletes()
  await assertCanceledRunNeverCompletes()
  await assertRecreatedRunCompletesAgain()
  await assertNeedsInputFiresPerBlockedTask()
  await assertArchitectRoutedNeedsInputNeverFires()
  await assertNeedsInputSkippedWhenRunCanceledOrCompleted()
  await assertNeedsInputReblockGetsNewId()
  await assertNeedsInputMissingReportedAtUsesUnreportedToken()
  await assertUnreadableProjectionBlocksPoll()
  await assertMalformedProjectionBlocksPoll()
  await assertProjectionReadSharedAcrossTriggersInOneTick()
}

type TaskFixture = {
  id?: string
  title?: string
  status: string
  needsInput?: Record<string, unknown>
}

type ProjectionOverrides = {
  tasks?: TaskFixture[]
  runStatus?: string
  createdAt?: string
  goal?: string
  name?: string
}

function projection(overrides: ProjectionOverrides = {}): unknown {
  const tasks = overrides.tasks ?? [{ status: 'done' }, { status: 'done' }]
  return {
    run: {
      name: overrides.name ?? TEAM,
      goal: overrides.goal ?? 'Ship the thing',
      ...(overrides.runStatus ? { status: overrides.runStatus } : {}),
      ...(overrides.createdAt ? { creation: { createdAt: overrides.createdAt } } : {}),
    },
    roster: {},
    tasks: tasks.map((task, index) => ({
      id: task.id ?? `T${index + 1}`,
      title: task.title ?? `Task ${index + 1}`,
      role: 'developer',
      status: task.status,
      dependsOn: [],
      ...(task.needsInput ? { needsInput: task.needsInput } : {}),
    })),
    artifacts: [],
    activity: [],
  }
}

function completedProvider(readProjection: () => Promise<SprintEngineProjectionReadResult>) {
  return createSprintEngineRunCompletedTriggerProvider({ readProjection })
}

function needsInputProvider(readProjection: () => Promise<SprintEngineProjectionReadResult>) {
  return createSprintEngineRunNeedsInputTriggerProvider({ readProjection })
}

function poll(
  provider: ReturnType<typeof completedProvider>,
  kind: string,
  now: () => number,
  context?: AutomationTriggerPollContext,
) {
  const run = provider.poll
  assert.ok(run, 'the run-event trigger polls')
  return (team = TEAM) => run({
    config: { kind, team },
    workspaceRoot: WORKSPACE_ROOT,
    now,
    context,
  })
}

function assertConfigValidation(): void {
  for (const [validate, kind] of [
    [validateSprintEngineRunCompletedTriggerConfig, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND],
    [validateSprintEngineRunNeedsInputTriggerConfig, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND],
  ] as const) {
    assert.equal(validate({ kind, team: TEAM }).ok, true, `${kind} accepts a safe team`)
    assert.equal(validate({ kind, team: TEAM, label: 'Watcher' }).ok, true, `${kind} accepts an optional label`)
    assert.equal(validate({ kind, team: '' }).ok, false, `${kind} rejects an empty team`)
    assert.equal(validate({ kind, team: '../escape' }).ok, false, `${kind} rejects path traversal`)
    assert.equal(validate({ kind, team: '..' }).ok, false, `${kind} rejects a bare ..`)
    assert.equal(validate({ kind, team: '.' }).ok, false, `${kind} rejects a bare .`)
    assert.equal(validate({ kind, team: TEAM, label: '' }).ok, false, `${kind} rejects an empty label`)
    assert.equal(validate({ kind: 'schedule', team: TEAM }).ok, false, `${kind} rejects the wrong kind`)
    assert.equal(validate(null).ok, false, `${kind} rejects null`)
    assert.equal(validate(['team-a']).ok, false, `${kind} rejects an array`)
  }
}

// Fingerprint identity: the createdAt branch and the name+goal fallback both
// derive a stable id, task updates do not perturb it, and a recreated run (new
// createdAt) fingerprints differently.
function assertFingerprintBranches(): void {
  const withCreatedAt = sprintEngineRunFingerprint({
    creation: { createdAt: '2026-07-01T00:00:00Z' },
    name: TEAM,
    goal: 'Ship the thing',
  })
  assert.match(withCreatedAt, /^[0-9a-f]{16}$/u)
  // Task set / name changes must not move a createdAt-anchored fingerprint.
  assert.equal(
    sprintEngineRunFingerprint({ creation: { createdAt: '2026-07-01T00:00:00Z' }, name: 'renamed', goal: 'changed' }),
    withCreatedAt,
    'createdAt anchors the fingerprint across run mutations',
  )

  const fallbackA = sprintEngineRunFingerprint({ creation: undefined, name: TEAM, goal: 'Ship the thing' })
  assert.match(fallbackA, /^[0-9a-f]{16}$/u)
  assert.notEqual(fallbackA, withCreatedAt, 'the two branches derive different ids')
  assert.notEqual(
    fallbackA,
    sprintEngineRunFingerprint({ creation: undefined, name: TEAM, goal: 'Ship something else' }),
    'the fallback distinguishes different goals',
  )
  assert.equal(
    fallbackA,
    sprintEngineRunFingerprint({ creation: { source: 'wizard' }, name: TEAM, goal: 'Ship the thing' }),
    'a creation block without createdAt still uses the name+goal fallback',
  )
}

async function assertCompletedRunFiresOnceAndDedupes(): Promise<void> {
  const now = () => Date.parse('2026-07-17T10:00:00Z')
  const trigger = completedProvider(async () => ({ ok: true, data: projection({ createdAt: '2026-07-01T00:00:00Z' }) }))
  const run = poll(trigger, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, now)

  const first = await run()
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.events.length, 1, 'a finished run fires once')
  const event = first.events[0]
  assert.match(event.id, new RegExp(`^sprint-completed:${TEAM}:[0-9a-f]{16}$`))
  assert.equal(event.payload.team, TEAM)
  assert.equal(event.payload.goal, 'Ship the thing')
  assert.equal(event.payload.taskCount, 2)

  const again = await run()
  assert.equal(again.ok, true)
  if (again.ok) assert.equal(again.events[0]?.id, event.id, 'the same finished run keeps the same dedupe id')
}

async function assertIncompleteRunNeverCompletes(): Promise<void> {
  const trigger = completedProvider(async () => ({
    ok: true,
    data: projection({ tasks: [{ status: 'done' }, { status: 'in_progress' }] }),
  }))
  const result = await poll(trigger, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, () => 0)()
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.events, [], 'an unfinished run never completes')
}

// isCompletedSprintEngineRun requires ≥1 task — a plan-ready race where the graph
// is momentarily empty must not read as "complete".
async function assertEmptyTaskGraphNeverCompletes(): Promise<void> {
  const trigger = completedProvider(async () => ({ ok: true, data: projection({ tasks: [] }) }))
  const result = await poll(trigger, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, () => 0)()
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.events, [], 'an empty task graph never completes')
}

// A canceled run's tasks are `canceled`; even a fully-done store with a canceled
// run status must not fire — completion is not cancellation.
async function assertCanceledRunNeverCompletes(): Promise<void> {
  const trigger = completedProvider(async () => ({ ok: true, data: projection({ runStatus: 'canceled' }) }))
  const result = await poll(trigger, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, () => 0)()
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.events, [], 'a canceled run never completes')
}

// A deleted-and-recreated run gets a new createdAt, so its fingerprint — and its
// dedupe id — differ, and completion fires for the new instance.
async function assertRecreatedRunCompletesAgain(): Promise<void> {
  let createdAt = '2026-07-01T00:00:00Z'
  const trigger = completedProvider(async () => ({ ok: true, data: projection({ createdAt }) }))
  const run = poll(trigger, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, () => 0)

  const original = await run()
  createdAt = '2026-07-16T12:00:00Z'
  const recreated = await run()
  assert.equal(original.ok, true)
  assert.equal(recreated.ok, true)
  if (original.ok && recreated.ok) {
    assert.notEqual(original.events[0]?.id, recreated.events[0]?.id, 'a recreated run gets a fresh dedupe id')
  }
}

async function assertNeedsInputFiresPerBlockedTask(): Promise<void> {
  const now = () => Date.parse('2026-07-17T10:00:00Z')
  const trigger = needsInputProvider(async () => ({
    ok: true,
    data: projection({
      createdAt: '2026-07-01T00:00:00Z',
      tasks: [
        { id: 'T1', status: 'in_progress' },
        {
          id: 'T2',
          title: 'Pick a database',
          status: 'needs_input',
          needsInput: {
            kind: 'user',
            question: 'Postgres or SQLite?',
            reason: 'product_decision',
            suggestedResolution: 'Postgres',
            reportedAt: '2026-07-17T09:00:00Z',
          },
        },
        {
          id: 'T3',
          title: 'Confirm the domain',
          status: 'needs_input',
          needsInput: { kind: 'user', question: 'Which domain?', reportedAt: '2026-07-17T09:30:00Z' },
        },
      ],
    }),
  }))
  const result = await poll(trigger, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND, now)()
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.events.length, 2, 'one event per human-blocked task')
  const [first, second] = result.events
  assert.match(first.id, new RegExp(`^sprint-needs-input:${TEAM}:[0-9a-f]{16}:T2:2026-07-17T09:00:00Z$`))
  assert.equal(first.payload.taskId, 'T2')
  assert.equal(first.payload.taskTitle, 'Pick a database')
  assert.equal(first.payload.question, 'Postgres or SQLite?')
  assert.equal(first.payload.reason, 'product_decision')
  assert.equal(first.payload.suggestedResolution, 'Postgres')
  assert.equal(first.payload.goal, 'Ship the thing')
  // The projection normalizer defaults a user-routed task's reason to
  // 'product_decision' when none is stored, so the payload always carries a
  // reason; an absent suggestedResolution is genuinely omitted rather than nulled.
  assert.equal(second.payload.reason, 'product_decision', 'a stored-reason-less user task defaults to product_decision')
  assert.equal('suggestedResolution' in second.payload, false, 'absent suggestion is omitted, not null')
}

async function assertArchitectRoutedNeedsInputNeverFires(): Promise<void> {
  const trigger = needsInputProvider(async () => ({
    ok: true,
    data: projection({
      tasks: [
        { id: 'T1', status: 'in_progress' },
        {
          id: 'T2',
          status: 'needs_input',
          needsInput: { kind: 'architect', question: 'Is the plan still valid?', reportedAt: '2026-07-17T09:00:00Z' },
        },
      ],
    }),
  }))
  const result = await poll(trigger, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND, () => 0)()
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.events, [], 'architect-routed needs_input never fires the human trigger')
}

async function assertNeedsInputSkippedWhenRunCanceledOrCompleted(): Promise<void> {
  const blockedTask: TaskFixture = {
    id: 'T1',
    status: 'needs_input',
    needsInput: { kind: 'user', question: 'Still there?', reportedAt: '2026-07-17T09:00:00Z' },
  }
  const canceled = needsInputProvider(async () => ({
    ok: true,
    data: projection({ runStatus: 'canceled', tasks: [blockedTask] }),
  }))
  const canceledResult = await poll(canceled, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND, () => 0)()
  assert.equal(canceledResult.ok, true)
  if (canceledResult.ok) assert.deepEqual(canceledResult.events, [], 'a canceled run never asks for input')

  // A completed run (every task done) can carry no blocked task; a defensive
  // completed-run guard still short-circuits before the per-task scan.
  const completed = needsInputProvider(async () => ({
    ok: true,
    data: projection({ tasks: [{ id: 'T1', status: 'done' }] }),
  }))
  const completedResult = await poll(completed, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND, () => 0)()
  assert.equal(completedResult.ok, true)
  if (completedResult.ok) assert.deepEqual(completedResult.events, [], 'a completed run never asks for input')
}

// A task that re-blocks with a NEW reportedAt fires again; the same blocker keeps
// the same id so redelivery dedupes.
async function assertNeedsInputReblockGetsNewId(): Promise<void> {
  let reportedAt = '2026-07-17T09:00:00Z'
  const trigger = needsInputProvider(async () => ({
    ok: true,
    data: projection({
      createdAt: '2026-07-01T00:00:00Z',
      tasks: [{ id: 'T1', status: 'needs_input', needsInput: { kind: 'user', question: 'Which?', reportedAt } }],
    }),
  }))
  const run = poll(trigger, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND, () => 0)

  const first = await run()
  const firstId = first.ok ? first.events[0]?.id : undefined
  const repoll = await run()
  assert.equal(repoll.ok, true)
  if (repoll.ok) assert.equal(repoll.events[0]?.id, firstId, 'the same blocker keeps the same id')

  reportedAt = '2026-07-17T11:00:00Z'
  const reblocked = await run()
  assert.equal(reblocked.ok, true)
  if (reblocked.ok) assert.notEqual(reblocked.events[0]?.id, firstId, 'a re-block with a new reportedAt fires again')
}

async function assertNeedsInputMissingReportedAtUsesUnreportedToken(): Promise<void> {
  const trigger = needsInputProvider(async () => ({
    ok: true,
    data: projection({
      createdAt: '2026-07-01T00:00:00Z',
      tasks: [{ id: 'T1', status: 'needs_input', needsInput: { kind: 'user', question: 'Which?' } }],
    }),
  }))
  const result = await poll(trigger, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND, () => 0)()
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.match(result.events[0]?.id ?? '', new RegExp(`:T1:unreported$`), 'a missing reportedAt uses the unreported token')
  }
}

async function assertUnreadableProjectionBlocksPoll(): Promise<void> {
  const trigger = completedProvider(async () => ({ ok: false, message: 'run store v3, this build reads v4', permanent: true }))
  const result = await poll(trigger, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, () => 0)()
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.blockedReason, /unreadable.*v3/u)
}

async function assertMalformedProjectionBlocksPoll(): Promise<void> {
  const trigger = completedProvider(async () => ({ ok: true, data: 'not an object' as unknown as Record<string, unknown> }))
  const result = await poll(trigger, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, () => 0)()
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.blockedReason, /malformed/u)
}

// The needs-input and completed triggers watching the same team share one disk
// read within an engine tick via the poll context's shared-value cache.
async function assertProjectionReadSharedAcrossTriggersInOneTick(): Promise<void> {
  let reads = 0
  const read = async (): Promise<SprintEngineProjectionReadResult> => {
    reads += 1
    return { ok: true, data: projection({ createdAt: '2026-07-01T00:00:00Z' }) }
  }
  const cache = new Map<string, Promise<unknown>>()
  const context: AutomationTriggerPollContext = {
    getSharedValue: <T>(key: string, factory: () => Promise<T>): Promise<T> => {
      const existing = cache.get(key)
      if (existing) return existing as Promise<T>
      const value = factory()
      cache.set(key, value)
      return value
    },
  }
  const completed = completedProvider(read)
  const needsInput = needsInputProvider(read)
  await poll(completed, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, () => 0, context)()
  await poll(needsInput, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND, () => 0, context)()
  assert.equal(reads, 1, 'both triggers share one cached projection read per tick')

  // Confirm the assertion is real: without a context each poll reads afresh.
  reads = 0
  await poll(completed, SPRINT_ENGINE_RUN_COMPLETED_TRIGGER_KIND, () => 0)()
  await poll(needsInput, SPRINT_ENGINE_RUN_NEEDS_INPUT_TRIGGER_KIND, () => 0)()
  assert.equal(reads, 2, 'without a poll context each trigger reads the projection itself')
}
