import assert from 'node:assert/strict'

import { deriveSprintRunSummary } from './runSummary'
import { normalizeSprintEngineProjection } from './state'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const projectRoot = '/work/multicode'
const teamSlug = 'july-hardening'
const statePath = `${projectRoot}/.sprintengine/sprintengine/${teamSlug}/run.yaml`

// A projection as `sprintengine:projection:read` hands it back, normalized the
// same way the run index normalizes one before it derives a summary — so these
// tests exercise the shape that actually reaches the rail, not a hand-built state.
function stateOf(projection: Record<string, unknown>) {
  const state = normalizeSprintEngineProjection(projection)
  assert.ok(state, 'projection should normalize')
  return state
}

function summaryOf(projection: Record<string, unknown>) {
  return deriveSprintRunSummary({
    statePath,
    teamSlug,
    projectRoot,
    projectName: 'multicode',
    state: stateOf(projection),
  })
}

function task(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `Task ${id}`, role: 'developer', status: 'done', repo: 'primary', dependsOn: [], ...over }
}

const vcs = {
  mode: 'run_worktree',
  worktreePath: '.sprintengine/worktrees/july-hardening',
  branchName: 'sprintengine/july-hardening',
  baseRef: 'main',
  repos: [
    {
      id: 'primary',
      root: '.',
      worktreePath: '.sprintengine/worktrees/july-hardening',
      branchName: 'sprintengine/july-hardening',
    },
  ],
  declaredRepoCount: 1,
}

// ── Branch chip ─────────────────────────────────────────────────────────────
run('the branch and worktree come off the run vcs block, worktree left relative', () => {
  const summary = summaryOf({
    run: { name: 'July hardening', goal: 'harden', vcs },
    tasks: [task('T1', { status: 'in_progress' })],
  })
  assert.equal(summary.branchName, 'sprintengine/july-hardening')
  // Project-root-RELATIVE, exactly as recorded — never joined onto projectRoot,
  // which would make this module reach for node's path.
  assert.equal(summary.worktreePath, '.sprintengine/worktrees/july-hardening')
  assert.ok(!summary.worktreePath?.startsWith(projectRoot), 'worktree stays relative')
})

run('a run with no worktree has no branch and no worktree path', () => {
  const summary = summaryOf({
    run: { name: 'July hardening', goal: 'harden' },
    tasks: [task('T1', { status: 'in_progress' })],
  })
  assert.equal(summary.branchName, null)
  assert.equal(summary.worktreePath, null)
})

// ── "Since it finished" clock ───────────────────────────────────────────────
run('a completed run finished when its LAST task did', () => {
  const summary = summaryOf({
    run: { name: 'July hardening', goal: 'harden', updatedAt: '2026-07-22T08:00:00.000Z' },
    tasks: [
      task('T1', { completedAt: '2026-07-22T09:00:00.000Z' }),
      task('T3', { completedAt: '2026-07-22T11:30:00.000Z' }),
      task('T2', { completedAt: '2026-07-22T10:00:00.000Z' }),
      // An unparseable stamp is ignored rather than allowed to win.
      task('T4', { completedAt: 'sometime last week' }),
    ],
  })
  assert.equal(summary.runtimeState, 'completed')
  assert.equal(summary.finishedAt, '2026-07-22T11:30:00.000Z')
})

run('a completed run whose tasks carry no completion stamp falls back to updatedAt', () => {
  const summary = summaryOf({
    run: { name: 'July hardening', goal: 'harden', updatedAt: '2026-07-22T12:00:00.000Z' },
    tasks: [task('T1'), task('T2')],
  })
  assert.equal(summary.runtimeState, 'completed')
  assert.equal(summary.finishedAt, '2026-07-22T12:00:00.000Z')
})

run('a canceled run stopped when it was last updated', () => {
  const summary = summaryOf({
    run: { name: 'July hardening', goal: 'harden', status: 'canceled', updatedAt: '2026-07-22T13:00:00.000Z' },
    tasks: [task('T1', { status: 'canceled' })],
  })
  assert.equal(summary.runtimeState, 'canceled')
  assert.equal(summary.finishedAt, '2026-07-22T13:00:00.000Z')
})

run('a run still in play has not finished, however recently it was updated', () => {
  const inPlay: Array<[Record<string, unknown>, string]> = [
    [{ status: 'in_progress' }, 'running'],
    [{ status: 'needs_input', needsInput: { kind: 'user', question: 'Which base?' } }, 'needs_input'],
    [{ status: 'todo' }, 'idle'],
  ]
  for (const [over, runtimeState] of inPlay) {
    const summary = summaryOf({
      run: { name: 'July hardening', goal: 'harden', updatedAt: '2026-07-22T14:00:00.000Z' },
      tasks: [task('T1', { completedAt: '2026-07-22T09:00:00.000Z', ...over })],
    })
    assert.equal(summary.runtimeState, runtimeState, `${String(over.status)} → ${runtimeState}`)
    assert.equal(summary.finishedAt, null, `${runtimeState} run has no finish instant`)
  }
})

// ── Unreadable projection ───────────────────────────────────────────────────
run('an unreadable projection states none of the three', () => {
  const summary = deriveSprintRunSummary({
    statePath,
    teamSlug,
    projectRoot,
    projectName: 'multicode',
    state: null,
    updatedAtFallback: '2026-07-22T15:00:00.000Z',
    unknownReason: 'Run projection could not be read.',
  })
  assert.equal(summary.runtimeState, 'unknown')
  assert.equal(summary.branchName, null)
  assert.equal(summary.worktreePath, null)
  // The fallback mtime still dates the row, but it is not a claim the run STOPPED.
  assert.equal(summary.updatedAt, '2026-07-22T15:00:00.000Z')
  assert.equal(summary.finishedAt, null)
})

console.log('all run-summary derivation tests passed')
