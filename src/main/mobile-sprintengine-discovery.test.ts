import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { discoverMobileSprintEngineStatePaths } from './mobile-sprintengine-discovery'

void main()

async function main(): Promise<void> {
  await assertDiscoveryReturnsNewestRuns()
  await assertDiscoveryUsesProjectionMtimeWhenPresent()
}

async function assertDiscoveryReturnsNewestRuns(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-mobile-discovery-'))
  const runCount = 15

  try {
    for (let index = 0; index < runCount; index += 1) {
      writeRun(root, `run-${String(index).padStart(2, '0')}`, index)
    }

    const statePaths = await discoverMobileSprintEngineStatePaths([root, root])

    assert.equal(statePaths.length, runCount)
    assert.deepEqual(
      statePaths.map((statePath) => basename(join(statePath, '..'))),
      Array.from({ length: runCount }, (_, index) =>
        `run-${String(runCount - 1 - index).padStart(2, '0')}`
      ),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function assertDiscoveryUsesProjectionMtimeWhenPresent(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-mobile-discovery-projection-'))

  try {
    const olderRun = writeRun(root, 'older-run-new-projection', 1)
    const newerRun = writeRun(root, 'newer-run-old-projection', 2)
    writeFileSync(olderRun.projectionPath, '{}\n', 'utf8')
    writeFileSync(newerRun.projectionPath, '{}\n', 'utf8')
    touch(olderRun.projectionPath, 30)
    touch(newerRun.projectionPath, 10)

    const statePaths = await discoverMobileSprintEngineStatePaths([root])

    assert.equal(basename(join(statePaths[0], '..')), 'older-run-new-projection')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeRun(root: string, teamName: string, timestampOffsetSeconds: number): { statePath: string; projectionPath: string } {
  const teamDirectory = join(root, '.multi-code', 'sprintengine', teamName)
  mkdirSync(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
  const projectionPath = join(teamDirectory, 'projection.json')
  writeFileSync(statePath, '{}\n', 'utf8')
  touch(statePath, timestampOffsetSeconds)
  return { statePath, projectionPath }
}

function touch(path: string, timestampOffsetSeconds: number): void {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, timestampOffsetSeconds))
  utimesSync(path, timestamp, timestamp)
}
