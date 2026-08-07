import assert from 'node:assert/strict'

import type { SprintRunRuntimeState, SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import {
  buildSprintRailRows,
  deriveSprintProjectChips,
  sprintDoorAttention,
  sprintRunOpenFailureCopy,
  sprintRunShortDate,
  sprintRunStateLine,
  sprintRunStatusLabel,
  sprintRunTone,
  RUN_INDEX_ERROR_HINT,
  RUN_INDEX_ERROR_TITLE,
} from './railState'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// A run summary shaped like the T1 index emits, with only the fields a test cares
// about overridden.
function summary(overrides: Partial<SprintRunSummary> & { teamSlug: string }): SprintRunSummary {
  const projectRoot = overrides.projectRoot ?? '/work/multicode'
  return {
    statePath: `${projectRoot}/.multi-code/sprintengine/${overrides.teamSlug}/run.yaml`,
    teamName: overrides.teamSlug,
    projectRoot,
    projectName: projectRoot.slice(projectRoot.lastIndexOf('/') + 1),
    runtimeState: 'idle',
    taskCounts: { total: 0, done: 0, inProgress: 0, waiting: 0 },
    repoRollup: { declared: 0, merged: 0, open: 0 },
    needsInputCount: 0,
    startedAt: null,
    updatedAt: null,
    sourceLabel: null,
    ...overrides,
  }
}

// ── Tone precedence ─────────────────────────────────────────────────────────
// One dot idiom: needs-input warns, live work takes the accent, a finished run is
// good, and every quiet/decided/unreadable state is neutral.
run('tone maps each runtime state to exactly one dot tone', () => {
  const expected: Record<SprintRunRuntimeState, string> = {
    needs_input: 'warn',
    running: 'accent',
    completed: 'good',
    canceled: 'neutral',
    idle: 'neutral',
    unknown: 'neutral',
  }
  for (const [state, tone] of Object.entries(expected)) {
    assert.equal(sprintRunTone(state as SprintRunRuntimeState), tone, `${state} → ${tone}`)
  }
})

run('a completed run keeps the good tone even with a merge still open', () => {
  const row = buildSprintRailRows(
    [summary({ teamSlug: 'post-merge', runtimeState: 'completed', repoRollup: { declared: 3, merged: 2, open: 1 } })],
    null,
  )[0]
  assert.equal(row?.tone, 'good')
  assert.equal(row?.pulse, false)
})

run('only a running run pulses', () => {
  const rows = buildSprintRailRows(
    [
      summary({ teamSlug: 'live', runtimeState: 'running' }),
      summary({ teamSlug: 'waiting', runtimeState: 'needs_input' }),
    ],
    null,
    'status',
  )
  assert.deepEqual(
    rows.map((row) => [row.title, row.pulse]),
    [['waiting', false], ['live', true]],
  )
})

// ── Ordering ────────────────────────────────────────────────────────────────
run('default sort is pure recency — a just-touched run leads whatever its state', () => {
  const rows = buildSprintRailRows(
    [
      summary({ teamSlug: 'landed-old', runtimeState: 'completed', updatedAt: '2026-07-17T10:00:00Z' }),
      summary({ teamSlug: 'just-canceled', runtimeState: 'canceled', updatedAt: '2026-07-24T12:00:00Z' }),
      summary({ teamSlug: 'live', runtimeState: 'running', updatedAt: '2026-07-22T10:00:00Z' }),
    ],
    null,
  )
  assert.deepEqual(rows.map((row) => row.title), ['just-canceled', 'live', 'landed-old'])
})

run('created sort orders by start date, not last touch', () => {
  const rows = buildSprintRailRows(
    [
      summary({ teamSlug: 'old-but-busy', startedAt: '2026-07-01T10:00:00Z', updatedAt: '2026-07-24T10:00:00Z' }),
      summary({ teamSlug: 'brand-new', startedAt: '2026-07-23T10:00:00Z', updatedAt: '2026-07-23T11:00:00Z' }),
    ],
    null,
    'created',
  )
  assert.deepEqual(rows.map((row) => row.title), ['brand-new', 'old-but-busy'])
})

run('status sort orders attention-first, newest within a rank', () => {
  const rows = buildSprintRailRows(
    [
      summary({ teamSlug: 'unknown-run', runtimeState: 'unknown' }),
      summary({ teamSlug: 'canceled-run', runtimeState: 'canceled' }),
      summary({ teamSlug: 'idle-run', runtimeState: 'idle' }),
      summary({ teamSlug: 'landed-old', runtimeState: 'completed', updatedAt: '2026-07-18T10:00:00Z' }),
      summary({ teamSlug: 'landed-new', runtimeState: 'completed', updatedAt: '2026-07-22T10:00:00Z' }),
      summary({ teamSlug: 'live', runtimeState: 'running' }),
      summary({ teamSlug: 'waiting', runtimeState: 'needs_input' }),
    ],
    null,
    'status',
  )
  assert.deepEqual(
    rows.map((row) => row.title),
    ['waiting', 'live', 'landed-new', 'landed-old', 'idle-run', 'canceled-run', 'unknown-run'],
  )
})

run('status sort: a needs-input run leads even when it is the oldest run listed', () => {
  const rows = buildSprintRailRows(
    [
      summary({ teamSlug: 'fresh', runtimeState: 'running', updatedAt: '2026-07-22T12:00:00Z' }),
      summary({ teamSlug: 'stale-question', runtimeState: 'needs_input', updatedAt: '2026-01-02T09:00:00Z' }),
    ],
    null,
    'status',
  )
  assert.equal(rows[0]?.title, 'stale-question')
})

run('undated runs sort last, never ahead of dated ones', () => {
  const rows = buildSprintRailRows(
    [
      summary({ teamSlug: 'undated', runtimeState: 'idle' }),
      summary({ teamSlug: 'dated', runtimeState: 'idle', updatedAt: '2026-07-01T00:00:00Z' }),
    ],
    null,
  )
  assert.deepEqual(rows.map((row) => row.title), ['dated', 'undated'])
})

// ── Grouping: project chips ─────────────────────────────────────────────────
run('chips list one entry per project holding at least one run, alphabetically', () => {
  const chips = deriveSprintProjectChips([
    summary({ teamSlug: 'a', projectRoot: '/work/multicode' }),
    summary({ teamSlug: 'b', projectRoot: '/work/multiauth' }),
    summary({ teamSlug: 'c', projectRoot: '/work/multicode' }),
  ])
  assert.deepEqual(
    chips.map((chip) => [chip.label, chip.runCount]),
    [['multiauth', 1], ['multicode', 2]],
  )
})

run('chips key on the project root so two projects sharing a basename stay distinct', () => {
  const chips = deriveSprintProjectChips([
    summary({ teamSlug: 'a', projectRoot: '/work/one/app' }),
    summary({ teamSlug: 'b', projectRoot: '/work/two/app' }),
  ])
  assert.equal(chips.length, 2)
  assert.deepEqual(chips.map((chip) => chip.projectRoot), ['/work/one/app', '/work/two/app'])
})

run('no runs means no chips — the strip disappears rather than offering a dead filter', () => {
  assert.deepEqual(deriveSprintProjectChips([]), [])
})

// ── Filtering ───────────────────────────────────────────────────────────────
run('a project filter narrows to that project; null lists every project', () => {
  const runs = [
    summary({ teamSlug: 'app-run', projectRoot: '/work/multicode' }),
    summary({ teamSlug: 'auth-run', projectRoot: '/work/multiauth' }),
  ]
  assert.deepEqual(buildSprintRailRows(runs, null).map((row) => row.title), ['app-run', 'auth-run'])
  assert.deepEqual(buildSprintRailRows(runs, '/work/multiauth').map((row) => row.title), ['auth-run'])
})

run('a project with no runs yields no rows rather than falling back to all runs', () => {
  const runs = [summary({ teamSlug: 'app-run', projectRoot: '/work/multicode' })]
  assert.deepEqual(buildSprintRailRows(runs, '/work/gone'), [])
})

// ── Empty ───────────────────────────────────────────────────────────────────
run('an empty index yields no rows, no chips, and no attention', () => {
  assert.deepEqual(buildSprintRailRows([], null), [])
  assert.deepEqual(deriveSprintProjectChips([]), [])
  assert.deepEqual(sprintDoorAttention([]), { waiting: false, running: false })
})

// ── State lines (mockup §2 vocabulary) ──────────────────────────────────────
run('state lines read as the mockup writes them', () => {
  assert.equal(
    sprintRunStateLine(
      summary({
        teamSlug: 'wake-filter',
        runtimeState: 'running',
        taskCounts: { total: 9, done: 4, inProgress: 1, waiting: 4 },
      }),
    ),
    'multicode · running · 4 of 9 tasks',
  )
  assert.equal(
    sprintRunStateLine(
      summary({ teamSlug: 'relay', projectRoot: '/work/multicode-mobile', runtimeState: 'needs_input' }),
    ),
    'multicode-mobile · needs your input',
  )
  assert.equal(
    sprintRunStateLine(
      summary({
        teamSlug: 'post-merge',
        runtimeState: 'completed',
        repoRollup: { declared: 3, merged: 2, open: 1 },
      }),
    ),
    'multicode +2 repos · 1 merge left',
  )
  assert.equal(
    sprintRunStateLine(
      summary({ teamSlug: 'runner', runtimeState: 'completed', updatedAt: '2026-07-22T18:04:00Z' }),
    ),
    'multicode · landed Jul 22',
  )
})

run('the repo phrase is singular for one sibling and absent for a lone repo', () => {
  const twoRepos = sprintRunStateLine(
    summary({ teamSlug: 'pair', runtimeState: 'canceled', repoRollup: { declared: 2, merged: 0, open: 0 } }),
  )
  assert.equal(twoRepos, 'multicode +1 repo · canceled')
  const oneRepo = sprintRunStateLine(
    summary({ teamSlug: 'solo', runtimeState: 'canceled', repoRollup: { declared: 1, merged: 0, open: 0 } }),
  )
  assert.equal(oneRepo, 'multicode · canceled')
})

run('plural merges, and a landed run with no stamp still reads as landed', () => {
  assert.equal(
    sprintRunStateLine(
      summary({ teamSlug: 'wide', runtimeState: 'completed', repoRollup: { declared: 4, merged: 1, open: 3 } }),
    ),
    'multicode +3 repos · 3 merges left',
  )
  assert.equal(
    sprintRunStateLine(summary({ teamSlug: 'undated', runtimeState: 'completed' })),
    'multicode · landed',
  )
})

run('a bad timestamp drops the date instead of printing an invalid one', () => {
  const line = sprintRunStateLine(
    summary({ teamSlug: 'bad-stamp', runtimeState: 'completed', updatedAt: 'not-a-date' }),
  )
  assert.equal(line, 'multicode · landed')
  assert.ok(!/Invalid|NaN/u.test(line))
})

run('idle and unreadable runs stay listed with honest plain-language lines', () => {
  assert.equal(
    sprintRunStateLine(summary({ teamSlug: 'fresh', runtimeState: 'idle' })),
    'multicode · not started yet',
  )
  assert.equal(
    sprintRunStateLine(
      summary({
        teamSlug: 'quiet',
        runtimeState: 'idle',
        taskCounts: { total: 6, done: 2, inProgress: 0, waiting: 4 },
      }),
    ),
    'multicode · 2 of 6 tasks',
  )
  const unreadable = sprintRunStateLine(
    summary({ teamSlug: 'broken', runtimeState: 'unknown', unknownReason: 'Run projection is malformed.' }),
  )
  assert.equal(unreadable, 'multicode · details unavailable')
  assert.ok(!/malformed|Error|null|undefined/u.test(unreadable), 'no raw reason leaks into the rail')
})

// ── The canvas copy for a run that will not open ─────────────────────────────
run('a store this build is too old to read fails permanently, never "temporary"', () => {
  const tooOld = sprintRunOpenFailureCopy(
    summary({
      teamSlug: 'ancient',
      runtimeState: 'unknown',
      unknownReason: 'This sprint was created by an older version of Multicode…',
      unknownKind: 'unsupported_store',
    }),
  )
  assert.match(tooOld.title, /can’t be opened/u)
  assert.ok(!/temporary/u.test(tooOld.hint), 'a permanent rejection is never called temporary')
  assert.match(tooOld.hint, /[Dd]elete/u, 'the remedy is named once, in the hint')
  assert.notEqual(tooOld.retryLabel, 'Try again', 'a retry that can only fail is not "Try again"')

  const transient = sprintRunOpenFailureCopy(
    summary({ teamSlug: 'mid-write', runtimeState: 'unknown', unknownReason: 'Run projection is malformed.' }),
  )
  assert.match(transient.hint, /usually temporary/u)
  assert.equal(transient.retryLabel, 'Try again')
  // The rail line is unchanged by either: both are still "details unavailable".
  assert.match(sprintRunStateLine(summary({ teamSlug: 'ancient', runtimeState: 'unknown' })), /details unavailable/u)
})

// ── Row identity ────────────────────────────────────────────────────────────
run('a row is identified by its statePath, so a run survives losing its workspace', () => {
  const historical = summary({ teamSlug: 'gone-workspace', runtimeState: 'completed' })
  const [row] = buildSprintRailRows([historical], null)
  assert.equal(row?.id, historical.statePath)
  assert.equal(row?.title, historical.teamName)
})

// ── Door attention ──────────────────────────────────────────────────────────
run('the door dot prefers waiting over running, and reports both independently', () => {
  assert.deepEqual(
    sprintDoorAttention([summary({ teamSlug: 'a', runtimeState: 'running' })]),
    { waiting: false, running: true },
  )
  assert.deepEqual(
    sprintDoorAttention([
      summary({ teamSlug: 'a', runtimeState: 'running' }),
      summary({ teamSlug: 'b', runtimeState: 'needs_input' }),
    ]),
    { waiting: true, running: true },
  )
  assert.deepEqual(
    sprintDoorAttention([
      summary({ teamSlug: 'a', runtimeState: 'completed' }),
      summary({ teamSlug: 'b', runtimeState: 'canceled' }),
    ]),
    { waiting: false, running: false },
  )
})

// ── Bar vocabulary ──────────────────────────────────────────────────────────
run('the bar status label is plain words for every state, never the enum', () => {
  const expected: Record<SprintRunRuntimeState, string> = {
    running: 'Running',
    needs_input: 'Waiting on you',
    completed: 'Completed',
    canceled: 'Canceled',
    idle: 'Idle',
    unknown: 'Unavailable',
  }
  for (const [state, label] of Object.entries(expected)) {
    const actual = sprintRunStatusLabel(state as SprintRunRuntimeState)
    assert.equal(actual, label)
    assert.ok(!actual.includes('_'), `${state} label carries no enum underscore`)
  }
})

run('short dates read off the ISO date fields, so they never shift a day', () => {
  assert.equal(sprintRunShortDate('2026-07-22T23:50:00Z'), 'Jul 22')
  // Late-evening UTC would roll forward in a positive-offset zone if this went
  // through a local Date; it must not.
  assert.equal(sprintRunShortDate('2026-01-01T00:30:00Z'), 'Jan 1')
  assert.equal(sprintRunShortDate('2026-12-31T23:59:59Z'), 'Dec 31')
  assert.equal(sprintRunShortDate(null), null)
  assert.equal(sprintRunShortDate('sometime'), null)
  assert.equal(sprintRunShortDate('2026-13-01T00:00:00Z'), null, 'an impossible month yields no label')
})

// ── Degraded copy ───────────────────────────────────────────────────────────
run('the index-error copy is plain language and never reads as "no sprints"', () => {
  assert.ok(!/\bnull\b|undefined|Error:|ENOENT/u.test(RUN_INDEX_ERROR_TITLE + RUN_INDEX_ERROR_HINT))
  assert.ok(RUN_INDEX_ERROR_HINT.includes('still on disk'), 'reassures the runs are not lost')
})

console.log('all sprints rail-state tests passed')
