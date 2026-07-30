import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AutomationDefinition, AutomationRun } from '../../shared/automations/contracts'
import { AutomationsStore, type AutomationStoreState } from './store'

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  await assertDefinitionRoundTrip()
  await assertLegacyAutonomyDefinitionLoadsAndIsNotWrittenBack()
  await assertRunHistoryIsBounded()
  await assertRunExecutionIdRoundTrip()
  await assertMalformedDefinitionFailsClosed()
  await assertRunWriteRequiresReadableDefinition()
  await assertMalformedRunListFailsClosedButWriteSkipsBadRun()
  await assertDotSegmentIdsAreRejected()
  await assertStateRoundTrip()
  await assertMalformedStateFailsClosed()
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

function state(overrides: Partial<AutomationStoreState> = {}): AutomationStoreState {
  return {
    nextRunAtByAutomationId: {
      'nightly-review': '2026-06-18T01:00:00.000Z',
    },
    lock: {
      ownerId: 'automations-engine',
      acquiredAt: '2026-06-17T12:00:00.000Z',
      expiresAt: '2026-06-17T12:01:00.000Z',
    },
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

async function assertLegacyAutonomyDefinitionLoadsAndIsNotWrittenBack(): Promise<void> {
  // A definition written before autonomy was retired is still on users' disks.
  // It must load (the parse was strict, and a required-field check would have
  // bricked it the other way round), and a load → edit → save round trip must
  // not carry the dead key back into the file.
  const workspaceRoot = await createWorkspace()
  const definitionsDirectory = join(workspaceRoot, '.multi-code', 'automations', 'definitions')
  await mkdir(definitionsDirectory, { recursive: true })
  const path = join(definitionsDirectory, 'nightly-review.json')
  await writeFile(path, JSON.stringify({ ...definition(), autonomyDefault: 'review_only' }, null, 2), 'utf8')

  const store = new AutomationsStore(workspaceRoot)
  const loaded = await store.getDefinition('nightly-review')
  assert.equal(loaded.ok, true, 'a legacy definition still loads')
  if (!loaded.ok) return
  assert.deepEqual(loaded.value, definition(), 'the retired key is dropped on read')

  const saved = await store.updateDefinition({ ...loaded.value, name: 'Renamed', updatedAt: '2026-06-17T12:05:00.000Z' })
  assert.equal(saved.ok, true)
  const onDisk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  assert.equal(Object.hasOwn(onDisk, 'autonomyDefault'), false, 'saving does not write the retired key back')
  assert.equal(onDisk.name, 'Renamed', 'the edit itself persisted')
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

async function assertRunExecutionIdRoundTrip(): Promise<void> {
  // executionId is the agent-lifecycle correlation key; it must survive store
  // write/read so the exit trigger can match a pending run after a restart.
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition())).ok, true)

  const withExecution = run(1, { status: 'running', completedAt: null, executionId: 'exec-abc123' })
  assert.equal((await store.recordRun(withExecution)).ok, true)
  const fetched = await store.getRun('nightly-review', 'run-001')
  assert.equal(fetched.ok, true)
  assert.equal(fetched.ok && fetched.value.executionId, 'exec-abc123')

  // A run without executionId (historical / resolution miss) still reads back.
  const withoutExecution = run(2, { status: 'running', completedAt: null })
  assert.equal((await store.recordRun(withoutExecution)).ok, true)
  const fetchedBare = await store.getRun('nightly-review', 'run-002')
  assert.equal(fetchedBare.ok, true)
  assert.equal(fetchedBare.ok && fetchedBare.value.executionId, undefined)
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

async function assertMalformedRunListFailsClosedButWriteSkipsBadRun(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  assert.equal((await store.createDefinition(definition())).ok, true)
  assert.equal((await store.recordRun(run(1))).ok, true)

  const runDirectory = join(workspaceRoot, '.multi-code', 'automations', 'runs', 'nightly-review')
  await mkdir(runDirectory, { recursive: true })
  const brokenPath = join(runDirectory, 'broken-run.json')
  await writeFile(brokenPath, '{not-json', 'utf8')

  const listed = await store.listRuns('nightly-review')
  assert.equal(listed.ok, false)
  assert.equal(!listed.ok && listed.errors.length, 1)
  assert.equal(!listed.ok && listed.errors[0]?.code, 'invalid_json')
  assert.match(!listed.ok ? listed.errors[0]?.message ?? '' : '', /not valid JSON/)
  assert.equal(await readFile(brokenPath, 'utf8'), '{not-json')

  const recorded = await store.recordRun(run(2))
  assert.equal(recorded.ok, true)

  const runFiles = await readdir(runDirectory)
  assert.equal(runFiles.includes('broken-run.json'), true)
  assert.equal(runFiles.includes('run-002.json'), true)

  const fetched = await store.getRun('nightly-review', 'run-002')
  assert.equal(fetched.ok, true)
  assert.equal(fetched.ok && fetched.value.id, 'run-002')
}

async function assertDotSegmentIdsAreRejected(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)

  for (const id of ['.', '..']) {
    const created = await store.createDefinition(definition({ id }))
    assert.equal(created.ok, false)
    assert.equal(!created.ok && created.error.code, 'invalid_id')

    const runs = await store.listRuns(id)
    assert.equal(runs.ok, false)
    assert.equal(!runs.ok && runs.errors[0]?.code, 'invalid_id')
  }

  assert.equal((await store.createDefinition(definition())).ok, true)
  const unsafeRun = await store.recordRun(run(1, { automationId: '..', id: 'state' }))
  assert.equal(unsafeRun.ok, false)
  assert.equal(!unsafeRun.ok && unsafeRun.error.code, 'invalid_id')

  const escapedStatePath = join(workspaceRoot, '.multi-code', 'automations', 'state.json')
  await assert.rejects(readFile(escapedStatePath, 'utf8'), { code: 'ENOENT' })
}

async function assertStateRoundTrip(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)

  const missing = await store.readState()
  assert.equal(missing.ok, true)
  assert.equal(missing.ok && missing.value, null)

  const nextState = state({
    nextRunAtByAutomationId: {
      'nightly-review': '2026-06-18T01:00:00.000Z',
      'weekly-cleanup': null,
    },
    triggerEventDedupByAutomationId: {
      'repo-event-watch': {
        'repo-event:github:acme/repo#1:updated:2026-06-17T09:00:00.000Z': '2026-06-17T10:00:00.000Z',
      },
    },
    triggerBlockedReasonByAutomationId: {
      'repo-event-watch': 'Switchboard has no GitHub sync state for this workspace.',
    },
  })
  const written = await store.writeState(nextState)
  assert.equal(written.ok, true)

  const readBack = await store.readState()
  assert.equal(readBack.ok, true)
  assert.deepEqual(readBack.ok && readBack.value, nextState)

  const stateFile = await readFile(join(workspaceRoot, '.multi-code', 'automations', 'state.json'), 'utf8')
  assert.match(stateFile, /nextRunAtByAutomationId/)

  const legacyRepoEventState = {
    nextRunAtByAutomationId: {
      'repo-event-watch': null,
    },
    repoEventDedupByAutomationId: {
      'repo-event-watch': {
        'repo-event:github:acme/repo#1:updated:2026-06-17T09:30:00.000Z': '2026-06-17T10:30:00.000Z',
      },
    },
    lock: null,
  }
  await writeFile(join(workspaceRoot, '.multi-code', 'automations', 'state.json'), JSON.stringify(legacyRepoEventState), 'utf8')
  const migratedLegacyState = await store.readState()
  assert.equal(migratedLegacyState.ok, true)
  assert.deepEqual(
    migratedLegacyState.ok && migratedLegacyState.value?.triggerEventDedupByAutomationId,
    legacyRepoEventState.repoEventDedupByAutomationId
  )
  assert.equal(
    migratedLegacyState.ok
      && Object.prototype.hasOwnProperty.call(migratedLegacyState.value ?? {}, 'repoEventDedupByAutomationId'),
    false
  )

  const invalidKey = await store.writeState(state({ nextRunAtByAutomationId: { '..': '2026-06-18T01:00:00.000Z' } }))
  assert.equal(invalidKey.ok, false)
  assert.equal(!invalidKey.ok && invalidKey.error.code, 'invalid_payload')

  const invalidTriggerEventKey = await store.writeState(state({ triggerEventDedupByAutomationId: { '..': {} } }))
  assert.equal(invalidTriggerEventKey.ok, false)
  assert.equal(!invalidTriggerEventKey.ok && invalidTriggerEventKey.error.code, 'invalid_payload')

  const invalidBlockedKey = await store.writeState(state({ triggerBlockedReasonByAutomationId: { '..': 'blocked' } }))
  assert.equal(invalidBlockedKey.ok, false)
  assert.equal(!invalidBlockedKey.ok && invalidBlockedKey.error.code, 'invalid_payload')
}

async function assertMalformedStateFailsClosed(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const statePath = join(workspaceRoot, '.multi-code', 'automations', 'state.json')

  await mkdir(join(workspaceRoot, '.multi-code', 'automations'), { recursive: true })
  await writeFile(statePath, '{not-json', 'utf8')

  const corruptJson = await store.readState()
  assert.equal(corruptJson.ok, false)
  assert.equal(!corruptJson.ok && corruptJson.error.code, 'invalid_json')
  assert.equal(await readFile(statePath, 'utf8'), '{not-json')

  await writeFile(statePath, JSON.stringify({ nextRunAtByAutomationId: [], lock: null }), 'utf8')

  const malformedPayload = await store.readState()
  assert.equal(malformedPayload.ok, false)
  assert.equal(!malformedPayload.ok && malformedPayload.error.code, 'invalid_payload')
}
