/**
 * Runner-log writer tests (MC-1754 Phase 3). esbuild bundle -> node,
 * `node:assert/strict`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSprintEngineRunnerLog, RUNNER_LOG_MAX_BYTES } from './sprintengine-runner-log'

function tempRun(): { statePath: string; runnerFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'sprintengine-runner-log-'))
  const teamDir = join(root, '.multi-code', 'sprintengine', 'team')
  return {
    statePath: join(teamDir, 'run.yaml'),
    runnerFile: join(teamDir, 'runner', 'runner-log.jsonl'),
  }
}

function testWritesEventsToTheOwningRunsRunnerDir(): void {
  const run = tempRun()
  const log = createSprintEngineRunnerLog(
    (workspaceId) => (workspaceId === 'ws-1' ? { statePath: run.statePath } : null),
    () => '2026-07-22T18:00:00.000Z'
  )

  log.write('SprintEngineAutoRun', 'slots', { workspaceId: 'ws-1', availableSlots: 2 })
  log.write('SprintEngineAutoRun', 'unknown-workspace', { workspaceId: 'ws-other' })
  log.write('SprintEngineAutoRun', 'no-workspace', { detail: 'ignored' })

  const lines = readFileSync(run.runnerFile, 'utf-8').trim().split('\n')
  assert.equal(lines.length, 1, 'only resolvable workspace events land')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.event, 'slots')
  assert.equal(entry.availableSlots, 2)
  assert.equal(entry.at, '2026-07-22T18:00:00.000Z')
}

function testRelativeStatePathResolvesAgainstFolderPath(): void {
  const run = tempRun()
  const folder = run.statePath.slice(0, run.statePath.indexOf('/.multi-code'))
  const relative = run.statePath.slice(folder.length + 1)
  const log = createSprintEngineRunnerLog(() => ({ statePath: relative, folderPath: folder }))

  log.write('SprintEngineAutoRun', 'supervise-stop', { workspaceId: 'ws-1', reason: 'no-slots' })

  assert.ok(existsSync(run.runnerFile), 'relative statePath + folderPath resolve to the run dir')
}

function testRotatesWhenOverTheSizeCap(): void {
  const run = tempRun()
  const log = createSprintEngineRunnerLog(() => ({ statePath: run.statePath }))
  log.write('SprintEngineAutoRun', 'seed', { workspaceId: 'ws-1' })
  writeFileSync(run.runnerFile, 'x'.repeat(RUNNER_LOG_MAX_BYTES + 1))

  log.write('SprintEngineAutoRun', 'post-rotation', { workspaceId: 'ws-1' })

  assert.ok(existsSync(`${run.runnerFile}.1`), 'the oversized log rotated aside')
  const lines = readFileSync(run.runnerFile, 'utf-8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).event, 'post-rotation')
}

function testNeverThrowsOnResolverFailure(): void {
  const log = createSprintEngineRunnerLog(() => {
    throw new Error('resolver exploded')
  })
  log.write('SprintEngineAutoRun', 'any', { workspaceId: 'ws-1' })
}

function main(): void {
  testWritesEventsToTheOwningRunsRunnerDir()
  testRelativeStatePathResolvesAgainstFolderPath()
  testRotatesWhenOverTheSizeCap()
  testNeverThrowsOnResolverFailure()
  console.log('sprintengine-runner-log.test.ts: all tests passed')
}

main()
