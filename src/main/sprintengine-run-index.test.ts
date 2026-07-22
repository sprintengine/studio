import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  discoverSprintEngineRunStatePaths,
  invalidateSprintRunSummary,
  listSprintRuns,
  readSprintRunSummary,
} from './sprintengine-run-index'
import { SPRINT_ENGINE_RUN_SCHEMA_VERSION } from '../shared/sprintengine/store-schema'

void main()

async function main(): Promise<void> {
  await assertStatesAcrossRootsAndTeams()
  await assertCompletedButUnmergedRollup()
  await assertDeletedTeamDisappearsCorruptShowsUnknown()
  await assertUnsupportedSchemaRejected()
  await assertMemoKeyedOnMtimeAndSize()
  await assertDedupeAndSortAcrossRoots()
}

// --- Fixtures ----------------------------------------------------------------

type RunOptions = {
  projection?: unknown
  /** Write projection.json as this raw string instead of JSON.stringify(projection). */
  rawProjection?: string
  /** Omit projection.json entirely. */
  noProjection?: boolean
  /** Seconds offset used for the run.yaml + projection.json mtime (sort key). */
  mtimeOffsetSeconds?: number
}

function writeRun(root: string, teamName: string, options: RunOptions = {}): { statePath: string; teamDirectory: string } {
  const teamDirectory = join(root, '.multi-code', 'sprintengine', teamName)
  mkdirSync(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
  const projectionPath = join(teamDirectory, 'projection.json')
  writeFileSync(statePath, 'sprintengine: {}\n', 'utf8')
  if (!options.noProjection) {
    const body = options.rawProjection ?? JSON.stringify(options.projection ?? {}, null, 2)
    writeFileSync(projectionPath, `${body}\n`, 'utf8')
  }
  if (options.mtimeOffsetSeconds !== undefined) {
    touch(statePath, options.mtimeOffsetSeconds)
    if (!options.noProjection) touch(projectionPath, options.mtimeOffsetSeconds)
  }
  return { statePath, teamDirectory }
}

function touch(path: string, offsetSeconds: number): void {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSeconds))
  utimesSync(path, timestamp, timestamp)
}

function projectionWith(run: Record<string, unknown>, tasks: unknown[]): Record<string, unknown> {
  return { run: { schemaVersion: SPRINT_ENGINE_RUN_SCHEMA_VERSION, name: 'A Run', goal: 'g', ...run }, tasks }
}

const worktreeVcs = (repos: Array<{ id: string; pr: 'merged' | 'open' | null }>): Record<string, unknown> => ({
  mode: 'run_worktree',
  worktreePath: '/wt/primary',
  branchName: 'run/branch',
  pullRequestState: repos[0]?.pr ?? null,
  lastCommitSha: 'primarysha',
  declaredRepoCount: repos.length,
  repos: repos.map((repo, index) => ({
    id: repo.id,
    root: index === 0 ? '.' : `../${repo.id}`,
    worktreePath: `/wt/${repo.id}`,
    branchName: `run/${repo.id}`,
    lastCommitSha: `${repo.id}sha`,
    pullRequestState: repo.pr,
  })),
})

function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-run-index-'))
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

function summaryFor(summaries: Awaited<ReturnType<typeof listSprintRuns>>, teamSlug: string) {
  const found = summaries.find((summary) => summary.teamSlug === teamSlug)
  assert.ok(found, `expected a summary for team ${teamSlug}`)
  return found
}

// --- Assertions --------------------------------------------------------------

async function assertStatesAcrossRootsAndTeams(): Promise<void> {
  await withRoot(async (rootA) => {
    await withRoot(async (rootB) => {
      writeRun(rootA, 'running-run', {
        projection: projectionWith({}, [
          { id: 'T1', status: 'done' },
          { id: 'T2', status: 'in_progress' },
        ]),
      })
      writeRun(rootA, 'needs-input-run', {
        projection: projectionWith({}, [
          { id: 'T1', status: 'needs_input', needsInput: { kind: 'user', question: 'Which color?' } },
          { id: 'T2', status: 'in_progress' },
        ]),
      })
      writeRun(rootB, 'completed-run', {
        projection: projectionWith({ creation: { createdAt: '2026-01-01T00:00:00Z' } }, [
          { id: 'T1', status: 'done' },
          { id: 'T2', status: 'done' },
        ]),
      })
      writeRun(rootB, 'canceled-run', {
        projection: projectionWith({ status: 'canceled' }, [
          { id: 'T1', status: 'canceled' },
          { id: 'T2', status: 'done' },
        ]),
      })

      const summaries = await listSprintRuns([rootA, rootB])
      assert.equal(summaries.length, 4)

      const running = summaryFor(summaries, 'running-run')
      assert.equal(running.runtimeState, 'running')
      assert.deepEqual(running.taskCounts, { total: 2, done: 1, inProgress: 1, waiting: 0 })
      assert.equal(running.projectName, basename(rootA))
      assert.equal(running.projectRoot, rootA)

      const needsInput = summaryFor(summaries, 'needs-input-run')
      // needs_input outranks the concurrently in_progress task.
      assert.equal(needsInput.runtimeState, 'needs_input')
      assert.equal(needsInput.needsInputCount, 1)

      const completed = summaryFor(summaries, 'completed-run')
      assert.equal(completed.runtimeState, 'completed')
      assert.equal(completed.startedAt, '2026-01-01T00:00:00Z')
      // No worktree → all-zero rollup, one rendered shape.
      assert.deepEqual(completed.repoRollup, { declared: 0, merged: 0, open: 0 })

      const canceled = summaryFor(summaries, 'canceled-run')
      // A canceled run's non-done tasks are all `canceled`; cancellation wins.
      assert.equal(canceled.runtimeState, 'canceled')
    })
  })
}

async function assertCompletedButUnmergedRollup(): Promise<void> {
  await withRoot(async (root) => {
    // The post-merge-hardening shape: run complete, 1 of 3 project PRs still open.
    writeRun(root, 'unmerged-run', {
      projection: projectionWith(
        {
          vcs: worktreeVcs([
            { id: 'primary', pr: 'merged' },
            { id: 'repo-two', pr: 'merged' },
            { id: 'repo-three', pr: 'open' },
          ]),
        },
        [
          { id: 'T1', status: 'done' },
          { id: 'T2', status: 'done' },
        ],
      ),
    })

    const [summary] = await listSprintRuns([root])
    // Completion is task-based; the open PR shows only in the rollup, never a
    // dropped/altered runtimeState.
    assert.equal(summary.runtimeState, 'completed')
    assert.deepEqual(summary.repoRollup, { declared: 3, merged: 2, open: 1 })
  })
}

async function assertDeletedTeamDisappearsCorruptShowsUnknown(): Promise<void> {
  await withRoot(async (root) => {
    const doomed = writeRun(root, 'doomed-run', {
      projection: projectionWith({}, [{ id: 'T1', status: 'done' }]),
    })
    writeRun(root, 'corrupt-run', { rawProjection: '{ not json' })
    writeRun(root, 'pre-projection-run', { noProjection: true })

    const first = await listSprintRuns([root])
    assert.equal(first.length, 3)

    const corrupt = summaryFor(first, 'corrupt-run')
    assert.equal(corrupt.runtimeState, 'unknown')
    assert.match(corrupt.unknownReason ?? '', /not valid JSON/i)

    const preProjection = summaryFor(first, 'pre-projection-run')
    assert.equal(preProjection.runtimeState, 'unknown')
    assert.match(preProjection.unknownReason ?? '', /has not been written/i)

    // Delete the run's team dir; it disappears on the next list.
    rmSync(doomed.teamDirectory, { recursive: true, force: true })
    const second = await listSprintRuns([root])
    assert.equal(second.length, 2)
    assert.ok(!second.some((summary) => summary.teamSlug === 'doomed-run'))
  })
}

async function assertUnsupportedSchemaRejected(): Promise<void> {
  await withRoot(async (root) => {
    // v3 (leases-replaced-the-roster) store: rejected with the standard message.
    writeRun(root, 'v3-run', { projection: { run: { schemaVersion: 3, name: 'Old' }, tasks: [] } })

    const [summary] = await listSprintRuns([root])
    assert.equal(summary.runtimeState, 'unknown')
    assert.match(summary.unknownReason ?? '', /older version of Multicode \(run store v3/)
    assert.match(summary.unknownReason ?? '', new RegExp(`reads v${SPRINT_ENGINE_RUN_SCHEMA_VERSION}`))
  })
}

async function assertMemoKeyedOnMtimeAndSize(): Promise<void> {
  await withRoot(async (root) => {
    const run = writeRun(root, 'memo-run', {
      projection: projectionWith({}, [{ id: 'T1', status: 'in_progress' }]),
      mtimeOffsetSeconds: 10,
    })

    const first = await readSprintRunSummary(run.statePath)
    const second = await readSprintRunSummary(run.statePath)
    // Unchanged file (same mtime+size) → the exact cached object, no re-derive.
    assert.equal(first, second)
    assert.equal(first.runtimeState, 'running')

    // Rewrite with new content AND a new mtime → key changes → fresh derivation.
    writeFileSync(
      join(run.teamDirectory, 'projection.json'),
      `${JSON.stringify(projectionWith({}, [{ id: 'T1', status: 'done' }]))}\n`,
      'utf8',
    )
    touch(join(run.teamDirectory, 'projection.json'), 30)
    const third = await readSprintRunSummary(run.statePath)
    assert.notEqual(third, first)
    assert.equal(third.runtimeState, 'completed')

    // The change-notification path invalidates the memo; the next read re-derives
    // even though the file is untouched since `third`.
    invalidateSprintRunSummary(run.statePath)
    const fourth = await readSprintRunSummary(run.statePath)
    assert.notEqual(fourth, third)
    assert.equal(fourth.runtimeState, 'completed')
  })
}

async function assertDedupeAndSortAcrossRoots(): Promise<void> {
  await withRoot(async (root) => {
    writeRun(root, 'older', { projection: projectionWith({}, []), mtimeOffsetSeconds: 10 })
    writeRun(root, 'newer', { projection: projectionWith({}, []), mtimeOffsetSeconds: 40 })
    writeRun(root, 'middle', { projection: projectionWith({}, []), mtimeOffsetSeconds: 20 })

    // The same root passed twice must not double-count any run.
    const discovered = await discoverSprintEngineRunStatePaths([root, root])
    assert.equal(discovered.length, 3)

    const summaries = await listSprintRuns([root, root])
    assert.deepEqual(summaries.map((summary) => summary.teamSlug), ['newer', 'middle', 'older'])
  })
}
