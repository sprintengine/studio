import assert from 'node:assert/strict'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import {
  deriveSprintRunCompletions,
  sprintRunClock,
  sprintRunDetailWords,
  sprintRunEmphasis,
  SPRINT_RUN_QUIET_AFTER_MS,
} from './railState'

// The rich row's read model (door-rails-premium): which clock a run wears and
// from when, what its detail line says, how loudly its title reads, and which
// runs finished unseen. Pure over the index summaries, so these are the rules
// themselves — the rail only composes what they return.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOW = Date.parse('2026-09-08T12:00:00.000Z')
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()

function summary(overrides: Partial<SprintRunSummary> & { teamSlug: string }): SprintRunSummary {
  const projectRoot = overrides.projectRoot ?? '/work/multicode'
  return {
    statePath: `${projectRoot}/.sprintengine/sprintengine/${overrides.teamSlug}/run.yaml`,
    teamName: overrides.teamSlug,
    projectRoot,
    projectName: projectRoot.slice(projectRoot.lastIndexOf('/') + 1),
    runtimeState: 'idle',
    taskCounts: { total: 0, done: 0, inProgress: 0, waiting: 0 },
    repoRollup: { declared: 0, merged: 0, open: 0 },
    needsInputCount: 0,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    branchName: null,
    worktreePath: null,
    sourceLabel: null,
    ...overrides,
  }
}

// ── The clock ────────────────────────────────────────────────────────────────

run('a running run counts up from when it started', () => {
  const clock = sprintRunClock(
    summary({ teamSlug: 'live', runtimeState: 'running', startedAt: minutesAgo(14), updatedAt: minutesAgo(1) }),
  )
  assert.deepEqual(clock, { kind: 'working', since: Date.parse(minutesAgo(14)) })
})

run('a running run with no start stamp wears no clock — the dots alone', () => {
  assert.equal(sprintRunClock(summary({ teamSlug: 'live', runtimeState: 'running', updatedAt: minutesAgo(1) })), null)
})

run('a waiting run says how long it has waited, from its last update', () => {
  const clock = sprintRunClock(
    summary({ teamSlug: 'ask', runtimeState: 'needs_input', startedAt: minutesAgo(600), updatedAt: minutesAgo(120) }),
  )
  assert.deepEqual(clock, { kind: 'waiting', since: Date.parse(minutesAgo(120)) })
})

run('a finished run counts from when it finished, and says so', () => {
  const clock = sprintRunClock(
    summary({
      teamSlug: 'done',
      runtimeState: 'completed',
      updatedAt: minutesAgo(5),
      finishedAt: minutesAgo(40),
    }),
  )
  assert.deepEqual(clock, { kind: 'rested', at: Date.parse(minutesAgo(40)), verb: 'Finished' })
})

run('a finished run without a finish stamp falls back to its last update', () => {
  const clock = sprintRunClock(summary({ teamSlug: 'done', runtimeState: 'completed', updatedAt: minutesAgo(5) }))
  assert.deepEqual(clock, { kind: 'rested', at: Date.parse(minutesAgo(5)), verb: 'Finished' })
})

run('a canceled run says Canceled; an idle or unreadable one says Updated', () => {
  assert.equal(
    sprintRunClock(summary({ teamSlug: 'x', runtimeState: 'canceled', finishedAt: minutesAgo(3) }))?.kind === 'rested'
      && (sprintRunClock(summary({ teamSlug: 'x', runtimeState: 'canceled', finishedAt: minutesAgo(3) })) as { verb: string })
        .verb,
    'Canceled',
  )
  assert.deepEqual(sprintRunClock(summary({ teamSlug: 'y', runtimeState: 'idle', updatedAt: minutesAgo(3) })), {
    kind: 'rested',
    at: Date.parse(minutesAgo(3)),
    verb: 'Updated',
  })
  assert.deepEqual(sprintRunClock(summary({ teamSlug: 'z', runtimeState: 'unknown', updatedAt: minutesAgo(3) })), {
    kind: 'rested',
    at: Date.parse(minutesAgo(3)),
    verb: 'Updated',
  })
})

run('a run with no stamp at all has no clock', () => {
  assert.equal(sprintRunClock(summary({ teamSlug: 'blank', runtimeState: 'completed' })), null)
  assert.equal(sprintRunClock(summary({ teamSlug: 'blank2', runtimeState: 'idle' })), null)
})

// ── The detail words ─────────────────────────────────────────────────────────

run('the detail line says the progress, or the leg that remains — never the state enum', () => {
  const counts = { total: 9, done: 4, inProgress: 1, waiting: 4 }
  assert.equal(sprintRunDetailWords(summary({ teamSlug: 'a', runtimeState: 'running', taskCounts: counts })), '4 of 9 tasks')
  assert.equal(sprintRunDetailWords(summary({ teamSlug: 'b', runtimeState: 'running' })), 'running')
  assert.equal(sprintRunDetailWords(summary({ teamSlug: 'c', runtimeState: 'needs_input', taskCounts: counts })), '4 of 9 tasks')
  assert.equal(sprintRunDetailWords(summary({ teamSlug: 'd', runtimeState: 'needs_input' })), 'needs your input')
  assert.equal(
    sprintRunDetailWords(summary({ teamSlug: 'e', runtimeState: 'completed', repoRollup: { declared: 3, merged: 2, open: 1 } })),
    '1 merge left',
  )
  assert.equal(
    sprintRunDetailWords(summary({ teamSlug: 'f', runtimeState: 'completed', repoRollup: { declared: 3, merged: 1, open: 2 } })),
    '2 merges left',
  )
  assert.equal(
    sprintRunDetailWords(summary({ teamSlug: 'g', runtimeState: 'completed', repoRollup: { declared: 1, merged: 1, open: 0 } })),
    'merged',
  )
  assert.equal(sprintRunDetailWords(summary({ teamSlug: 'h', runtimeState: 'completed' })), 'complete')
  assert.equal(
    sprintRunDetailWords(summary({ teamSlug: 'i', runtimeState: 'canceled', taskCounts: { ...counts, total: 6, done: 2 } })),
    'canceled · 2 of 6 tasks',
  )
  assert.equal(sprintRunDetailWords(summary({ teamSlug: 'j', runtimeState: 'canceled' })), 'canceled')
  assert.equal(sprintRunDetailWords(summary({ teamSlug: 'k', runtimeState: 'idle' })), 'not started yet')
  assert.equal(sprintRunDetailWords(summary({ teamSlug: 'l', runtimeState: 'unknown' })), 'details unavailable')
})

// ── Emphasis ─────────────────────────────────────────────────────────────────

run('the selected row, a run at work and a run that wants you are always active', () => {
  assert.equal(sprintRunEmphasis(summary({ teamSlug: 'old', runtimeState: 'completed', finishedAt: minutesAgo(10_000) }), true, NOW), 'active')
  assert.equal(sprintRunEmphasis(summary({ teamSlug: 'live', runtimeState: 'running', startedAt: minutesAgo(10_000) }), false, NOW), 'active')
  assert.equal(sprintRunEmphasis(summary({ teamSlug: 'ask', runtimeState: 'needs_input', updatedAt: minutesAgo(10_000) }), false, NOW), 'active')
})

run('a run that rested within the hour keeps the foreground; older recedes; no clock recedes', () => {
  const justLanded = summary({ teamSlug: 'j', runtimeState: 'completed', finishedAt: minutesAgo(59) })
  const lastWeek = summary({ teamSlug: 'w', runtimeState: 'completed', finishedAt: minutesAgo(60 * 24 * 7) })
  const onTheHour = summary({
    teamSlug: 'h',
    runtimeState: 'completed',
    finishedAt: new Date(NOW - SPRINT_RUN_QUIET_AFTER_MS).toISOString(),
  })
  assert.equal(sprintRunEmphasis(justLanded, false, NOW), 'active')
  assert.equal(sprintRunEmphasis(lastWeek, false, NOW), 'quiet')
  assert.equal(sprintRunEmphasis(onTheHour, false, NOW), 'quiet')
  assert.equal(sprintRunEmphasis(summary({ teamSlug: 'blank', runtimeState: 'idle' }), false, NOW), 'quiet')
})

// ── Unseen completions ───────────────────────────────────────────────────────

run('a run watched going from anything else to completed is announced; history is not', () => {
  const before = new Map<string, SprintRunSummary['runtimeState']>([
    ['/a/run.yaml', 'running'],
    ['/b/run.yaml', 'completed'],
    ['/c/run.yaml', 'needs_input'],
  ])
  const after = [
    summary({ teamSlug: 'a', statePath: '/a/run.yaml', runtimeState: 'completed' }),
    summary({ teamSlug: 'b', statePath: '/b/run.yaml', runtimeState: 'completed' }),
    summary({ teamSlug: 'c', statePath: '/c/run.yaml', runtimeState: 'needs_input' }),
    // First sighting, already complete: nothing to announce.
    summary({ teamSlug: 'd', statePath: '/d/run.yaml', runtimeState: 'completed' }),
  ]
  assert.deepEqual(deriveSprintRunCompletions(before, after), ['/a/run.yaml'])
  assert.deepEqual(deriveSprintRunCompletions(new Map(), after), [])
})
