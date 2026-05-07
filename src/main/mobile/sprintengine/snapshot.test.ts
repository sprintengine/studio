import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  MobileSwarmSnapshotService,
  readSwarmSnapshot,
} from './snapshot'

const generatedAt = '2026-04-28T19:30:00.000Z'

void main()

async function main(): Promise<void> {
  await assertFixtureSnapshotMatchesDesktopBoardCounts()
  await assertSnapshotOmitsNonMobileStatePayloads()
  await assertSnapshotSkipsMalformedStateFiles()
  await assertPublishingIsThrottled()
}

async function assertFixtureSnapshotMatchesDesktopBoardCounts(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: {
      name: 'mobile-sprintengine-companion-integration',
      updatedAt: '2026-04-28T19:29:00.000Z',
    },
    tasks: [
      task('T1', 'done', []),
      task('T2', 'todo', ['T1']),
      task('T3', 'todo', ['T9']),
      task('T4', 'in_progress', ['T1']),
      task('T5', 'needs_input', ['T1']),
      task('T6', 'done', ['T1']),
    ],
    artifacts: [
      artifact('A1', 'requirements', 'approved', 'T1'),
      artifact('A2', 'architect_plan', 'ready_for_review', 'T5'),
      artifact('A3', 'code_review', 'superseded', 'T2'),
    ],
  })

  const snapshot = await readSwarmSnapshot(statePath)

  assert.deepEqual(snapshot.board, {
    todo: 1,
    ready: 1,
    inProgress: 1,
    needsInput: 1,
    blocked: 0,
    done: 2,
  })
  assert.equal(snapshot.tasks.find((candidate) => candidate.taskId === 'T2')?.status, 'ready')
  assert.equal(snapshot.tasks.find((candidate) => candidate.taskId === 'T3')?.status, 'todo')
  assert.deepEqual(snapshot.artifacts.map((candidate) => candidate.artifactId), ['A1', 'A2'])
}

async function assertSnapshotOmitsNonMobileStatePayloads(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: {
      name: 'Sanitized Snapshot',
      updatedAt: '2026-04-28T19:31:00.000Z',
    },
    tasks: [
      {
        ...task('T1', 'done', []),
        description: 'Long source-sensitive task brief',
        evidence: {
          summary: 'Implementation details',
          touchedFiles: ['src/private.ts'],
          commandsRan: ['cat src/private.ts'],
          results: ['private source output'],
        },
        notes: ['terminal stream should not leave desktop'],
      },
    ],
    events: [
      {
        id: 'EVT-1',
        timestamp: generatedAt,
        type: 'terminal_output',
        actor: 'developer-1',
        message: 'raw terminal stream',
      },
    ],
    artifacts: [
      {
        ...artifact('A1', 'requirements', 'approved', 'T1'),
        reviewHistory: [{ action: 'approved', actor: 'user', timestamp: generatedAt }],
        fingerprint: 'secret-ish-hash',
      },
    ],
  })

  const snapshot = await readSwarmSnapshot(statePath)
  const serialized = JSON.stringify(snapshot)

  assert.equal(serialized.includes('raw terminal stream'), false)
  assert.equal(serialized.includes('private source output'), false)
  assert.equal(serialized.includes('secret-ish-hash'), false)
  assert.equal(snapshot.artifacts[0].path, '.multi-code/sprintengine/team/product-requirements.md')
}

async function assertPublishingIsThrottled(): Promise<void> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'Throttle Fixture', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const service = new MobileSwarmSnapshotService({ publishThrottleMs: 60 })
  const published: string[] = []
  service.subscribe((snapshot) => {
    published.push(snapshot.generatedAt)
  })

  const first = await service.publishSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [statePath],
    generatedAt,
  })
  const second = await service.publishSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [statePath],
    generatedAt: '2026-04-28T19:30:01.000Z',
  })
  const flushed = await service.flushPendingSnapshot()

  assert.equal(first?.generatedAt, generatedAt)
  assert.equal(second, null)
  assert.equal(flushed?.generatedAt, '2026-04-28T19:30:01.000Z')
  assert.deepEqual(published, [generatedAt, '2026-04-28T19:30:01.000Z'])
  service.shutdown()
}

async function assertSnapshotSkipsMalformedStateFiles(): Promise<void> {
  const validStatePath = await writeStateFixture({
    sprintengine: { name: 'Valid Snapshot', updatedAt: generatedAt },
    tasks: [task('T1', 'done', [])],
    artifacts: [],
  })
  const malformedStatePath = await writeStateText(
    `${String.raw`{"sprintengine":{"name":"Bad"},"tasks":[{"evidence":{"commandsRan":[".multi-code\sprintengine\state.yaml"]}}]}`}\n`
  )
  const service = new MobileSwarmSnapshotService()

  const snapshot = await service.readSnapshot({
    desktopSessionId: 'desktop_1',
    statePaths: [malformedStatePath, validStatePath],
    generatedAt,
  })

  assert.deepEqual(snapshot.swarms.map((swarm) => swarm.name), ['Valid Snapshot'])
  service.shutdown()
}

async function writeStateFixture(state: Record<string, unknown>): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-snapshot-'))
  const teamDirectory = join(workspacePath, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'state.yaml')
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return statePath
}

async function writeStateText(content: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-snapshot-'))
  const teamDirectory = join(workspacePath, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'state.yaml')
  await writeFile(statePath, content, 'utf8')
  return statePath
}

function task(id: string, status: string, dependsOn: string[]): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    role: 'developer',
    status,
    ownerAgentId: status === 'in_progress' ? 'developer-1' : null,
    dependsOn,
  }
}

function artifact(id: string, kind: string, status: string, taskId: string): Record<string, unknown> {
  return {
    id,
    kind,
    title: `Artifact ${id}`,
    path: '.multi-code/sprintengine/team/product-requirements.md',
    status,
    createdBy: 'product',
    taskId,
  }
}
