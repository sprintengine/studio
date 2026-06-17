import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AutomationDefinition, AutomationRun } from '../../shared/automations/contracts'
import { AutomationsStore } from './store'

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  await assertDefinitionRoundTrip()
  await assertRunHistoryIsBounded()
  await assertMalformedDefinitionFailsClosed()
  await assertRunWriteRequiresReadableDefinition()
  await assertMalformedRunFailsClosed()
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'multicode-automations-'))
}

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'nightly-review',
    name: 'Nightly review',
    status: 'enabled',
    trigger: {
      kind: 'schedule',
      config: {
        kind: 'schedule',
        cadence: { type: 'daily', timeLocal: '02:00' },
        timezone: 'Europe/Dublin',
      },
    },
    action: {
      kind: 'spawn-agent',
      config: { prompt: 'Review the repository.' },
    },
    autonomyDefault: 'review_only',
    nextRunAt: '2026-06-18T01:00:00.000Z',
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-06-17T12:00:00.000Z',
    updatedAt: '2026-06-17T12:00:00.000Z',
    ...overrides,
  }
}

function run(index: number, overrides: Partial<AutomationRun> = {}): AutomationRun {
  const suffix = String(index).padStart(3, '0')
  return {
    id: `run-${suffix}`,
    automationId: 'nightly-review',
    status: 'completed',
    dueAt: `2026-06-17T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    startedAt: `2026-06-17T${String(index % 24).padStart(2, '0')}:00:01.000Z`,
    completedAt: `2026-06-17T${String(index % 24).padStart(2, '0')}:00:02.000Z`,
    workspaceId: 'workspace-1',
    agentId: `agent-${suffix}`,
    promptFingerprint: `prompt-${suffix}`,
    touchedFiles: ['src/main/example.ts'],
    commandsRan: ['npm run typecheck'],
    summary: `Completed run ${suffix}.`,
    ...overrides,
  }
}

async function assertDefinitionRoundTrip(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)

  const empty = await store.listDefinitions()
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.ok && empty.values, [])

  const created = await store.createDefinition(definition())
  assert.equal(created.ok, true)

  const listed = await store.listDefinitions()
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.ok && listed.values, [definition()])

  const updatedDefinition = definition({
    name: 'Nightly repository review',
    status: 'paused',
    updatedAt: '2026-06-17T12:05:00.000Z',
  })
  const updated = await store.updateDefinition(updatedDefinition)
  assert.equal(updated.ok, true)

  const fetched = await store.getDefinition('nightly-review')
  assert.equal(fetched.ok, true)
  assert.deepEqual(fetched.ok && fetched.value, updatedDefinition)

  const deleted = await store.deleteDefinition('nightly-review')
  assert.equal(deleted.ok, true)

  const afterDelete = await store.listDefinitions()
  assert.equal(afterDelete.ok, true)
  assert.deepEqual(afterDelete.ok && afterDelete.values, [])
}

async function assertRunHistoryIsBounded(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition())).ok, true)

  for (let index = 0; index < 55; index += 1) {
    const recorded = await store.recordRun(
      run(index, {
        dueAt: new Date(Date.UTC(2026, 5, 17, 0, index)).toISOString(),
        startedAt: new Date(Date.UTC(2026, 5, 17, 0, index, 1)).toISOString(),
        completedAt: new Date(Date.UTC(2026, 5, 17, 0, index, 2)).toISOString(),
      })
    )
    assert.equal(recorded.ok, true)
  }

  const runs = await store.listRuns('nightly-review')
  assert.equal(runs.ok, true)
  assert.equal(runs.ok && runs.values.length, 50)
  assert.equal(runs.ok && runs.values[0]?.id, 'run-054')
  assert.equal(runs.ok && runs.values.at(-1)?.id, 'run-005')

  const runFiles = await readdir(join(workspaceRoot, '.multi-code', 'automations', 'runs', 'nightly-review'))
  assert.equal(runFiles.filter((file) => file.endsWith('.json')).length, 50)
  assert.equal(runFiles.includes('run-004.json'), false)
}

async function assertMalformedDefinitionFailsClosed(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition())).ok, true)

  const brokenPath = join(workspaceRoot, '.multi-code', 'automations', 'definitions', 'broken.json')
  await writeFile(brokenPath, '{not-json', 'utf8')

  const listed = await store.listDefinitions()
  assert.equal(listed.ok, false)
  assert.equal(!listed.ok && listed.errors.length, 1)
  assert.equal(!listed.ok && listed.errors[0]?.code, 'invalid_json')
  assert.match(!listed.ok ? listed.errors[0]?.message ?? '' : '', /not valid JSON/)
  assert.equal(await readFile(brokenPath, 'utf8'), '{not-json')
}

async function assertRunWriteRequiresReadableDefinition(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition())).ok, true)

  const definitionPath = join(workspaceRoot, '.multi-code', 'automations', 'definitions', 'nightly-review.json')
  await writeFile(definitionPath, '{not-json', 'utf8')

  const recorded = await store.recordRun(run(1))
  assert.equal(recorded.ok, false)
  assert.equal(!recorded.ok && recorded.error.code, 'invalid_json')

  const runs = await store.listRuns('nightly-review')
  assert.equal(runs.ok, true)
  assert.deepEqual(runs.ok && runs.values, [])
}

async function assertMalformedRunFailsClosed(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition())).ok, true)
  assert.equal((await store.recordRun(run(1))).ok, true)

  const runDirectory = join(workspaceRoot, '.multi-code', 'automations', 'runs', 'nightly-review')
  await mkdir(runDirectory, { recursive: true })
  const brokenPath = join(runDirectory, 'broken-run.json')
  await writeFile(brokenPath, '{}', 'utf8')

  const listed = await store.listRuns('nightly-review')
  assert.equal(listed.ok, false)
  assert.equal(!listed.ok && listed.errors.length, 1)
  assert.equal(!listed.ok && listed.errors[0]?.code, 'invalid_payload')
  assert.match(!listed.ok ? listed.errors[0]?.message ?? '' : '', /payload is malformed/)
  assert.equal(await readFile(brokenPath, 'utf8'), '{}')

  const recorded = await store.recordRun(run(2))
  assert.equal(recorded.ok, false)
  assert.equal(!recorded.ok && recorded.error.code, 'invalid_payload')

  const runFiles = await readdir(runDirectory)
  assert.equal(runFiles.includes('run-002.json'), false)
}
