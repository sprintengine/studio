import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AutomationDefinition } from '../../shared/automations/contracts'
import type { SwitchboardTaskRecord } from '../../shared/switchboard'
import { AutomationsEngine } from './engine'
import { TRIGGER_EVENT_DEDUP_RETENTION_LIMIT } from './polling-trigger-runner'
import { AutomationsStore } from './store'
import { createRepoEventTriggerProvider, REPO_EVENT_TRIGGER_KIND } from './triggers/repo-event'

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  await assertRepoEventTriggerFiresOnceAndDedupesAcrossRestart()
  await assertRepoEventTriggerSharesReadAllWithinEngineTick()
  await assertRepoEventTriggerDedupStateIsBoundedAndRetainsRecentEvents()
  await assertRepoEventCreatedTriggerFiresFromImportMetadata()
  await assertRepoEventIgnoresForgedImportCommentAndInvalidStructuredTimestamp()
  await assertRepoEventTriggerBlocksWhenSwitchboardUnsynced()
}

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'nightly-review',
    name: 'Nightly review',
    status: 'enabled',
    trigger: {
      kind: 'schedule',
      config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '02:00' }, timezone: 'UTC' },
    },
    action: {
      kind: 'spawn-agent',
      config: { prompt: 'Review the repository.' },
    },
    autonomyDefault: 'review_only',
    nextRunAt: '2026-06-17T02:00:00.000Z',
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  }
}

function repoEventDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return definition({
    id: 'repo-event-watch',
    name: 'Repo event watch',
    trigger: {
      kind: REPO_EVENT_TRIGGER_KIND,
      config: { kind: REPO_EVENT_TRIGGER_KIND, provider: 'github' },
    },
    nextRunAt: null,
    ...overrides,
  })
}

function switchboardTaskRecord(overrides: Partial<SwitchboardTaskRecord['task']> = {}): SwitchboardTaskRecord {
  const task = {
    schemaVersion: 1 as const,
    id: 'task-1',
    identifier: 'GH-1',
    title: 'Fix issue',
    description: 'Synced from GitHub.',
    priority: null,
    state: 'todo' as const,
    branchName: null,
    url: 'https://github.com/acme/repo/issues/1',
    labels: ['bug'],
    blockedBy: [],
    source: {
      type: 'github' as const,
      externalId: 'github-node-1',
      externalKey: 'acme/repo#1',
      externalUrl: 'https://github.com/acme/repo/issues/1',
      externalUpdatedAt: '2026-06-17T09:00:00.000Z',
    },
    claim: null,
    execution: {
      attempts: [],
      worktreePath: null,
      activeSessionId: null,
    },
    evidence: {
      summary: '',
      artifacts: [],
      commandsRun: [],
      touchedFiles: [],
    },
    comments: [
      importComment(),
    ],
    createdAt: '2026-06-17T09:00:00.000Z',
    updatedAt: '2026-06-17T09:00:00.000Z',
    ...overrides,
  }

  return {
    task,
    location: {
      folderStatus: 'todo',
      path: `.multi-code/switchboard/todo/${task.id}.json`,
    },
    warnings: [],
  }
}

function importComment(overrides: Partial<SwitchboardTaskRecord['task']['comments'][number]> = {}) {
  return {
    id: 'import-created',
    author: { type: 'system' as const, id: 'switchboard-import', name: 'Switchboard Import' },
    kind: 'import' as const,
    body: 'Imported from github.',
    createdAt: '2026-06-17T09:05:00.000Z',
    ...overrides,
  }
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'multicode-automations-repo-event-engine-'))
}

async function assertRepoEventTriggerFiresOnceAndDedupesAcrossRestart(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  assert.equal((await store.createDefinition(repoEventDefinition())).ok, true)

  let syncedTasks = [switchboardTaskRecord()]
  const provider = createRepoEventTriggerProvider({
    readAllTasks: async (input) => ({
      ok: true,
      workspaceRoot: input.workspaceRoot,
      switchboardRoot: '/switchboard',
      tasks: syncedTasks,
      problems: [],
    }),
  })
  const triggerPayloads: Record<string, unknown>[] = []
  let runIndex = 0
  const createEngine = () =>
    new AutomationsEngine({
      getProjectFolders: () => [{ workspaceId: 'ws-repo-events', folderPath: workspaceRoot }],
      triggerProviders: [provider],
      isIntegrationAvailable: (id) => id === 'module:switchboard',
      now: () => now,
      createRunId: () => `repo-event-run-${runIndex += 1}`,
      runAutomation: async (input) => {
        triggerPayloads.push(input.triggerPayload)
        return { status: 'completed', summary: 'Repo event handled.' }
      },
    })

  const firstEngine = createEngine()
  const firstTick = await firstEngine.tick()
  assert.equal(firstTick.fired.length, 1)
  assert.equal(firstTick.fired[0]?.runId, 'repo-event-run-1')
  assert.equal(triggerPayloads.length, 1)
  assert.equal(triggerPayloads[0]?.kind, REPO_EVENT_TRIGGER_KIND)
  assert.equal(triggerPayloads[0]?.provider, 'github')
  assert.equal(triggerPayloads[0]?.eventType, 'updated')
  assert.equal(triggerPayloads[0]?.externalKey, 'acme/repo#1')

  const duplicateTick = await firstEngine.tick()
  assert.equal(duplicateTick.fired.length, 0)
  assert.equal(triggerPayloads.length, 1)

  const restartedEngine = createEngine()
  const afterRestart = await restartedEngine.tick()
  assert.equal(afterRestart.fired.length, 0)
  assert.equal(triggerPayloads.length, 1)

  syncedTasks = [
    switchboardTaskRecord({
      updatedAt: '2026-06-17T13:00:00.000Z',
    }),
  ]
  const localOnlyUpdate = await restartedEngine.tick()
  assert.equal(localOnlyUpdate.fired.length, 0)
  assert.equal(triggerPayloads.length, 1)

  syncedTasks = [
    switchboardTaskRecord({
      updatedAt: '2026-06-17T13:05:00.000Z',
      source: {
        type: 'github',
        externalId: 'github-node-1',
        externalKey: 'acme/repo#1',
        externalUrl: 'https://github.com/acme/repo/issues/1',
        externalUpdatedAt: '2026-06-17T09:30:00.000Z',
      },
    }),
  ]
  const externalUpdateTick = await restartedEngine.tick()
  assert.equal(externalUpdateTick.fired.length, 1)
  assert.equal(externalUpdateTick.fired[0]?.runId, 'repo-event-run-2')
  assert.equal(triggerPayloads.length, 2)
  assert.equal(triggerPayloads[1]?.externalKey, 'acme/repo#1')
  assert.equal(triggerPayloads[1]?.externalUpdatedAt, '2026-06-17T09:30:00.000Z')

  const duplicateExternalUpdate = await restartedEngine.tick()
  assert.equal(duplicateExternalUpdate.fired.length, 0)
  assert.equal(triggerPayloads.length, 2)

  const runs = await store.listRuns('repo-event-watch')
  assert.equal(runs.ok, true)
  assert.equal(runs.ok && runs.values.length, 2)

  const state = await store.readState()
  assert.equal(state.ok, true)
  assert.equal(
    state.ok && Object.keys(state.value?.triggerEventDedupByAutomationId?.['repo-event-watch'] ?? {}).length,
    2
  )
}

async function assertRepoEventTriggerSharesReadAllWithinEngineTick(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  assert.equal((await store.createDefinition(repoEventDefinition({
    id: 'repo-event-watch-a',
    name: 'Repo event watch A',
  }))).ok, true)
  assert.equal((await store.createDefinition(repoEventDefinition({
    id: 'repo-event-watch-b',
    name: 'Repo event watch B',
  }))).ok, true)

  const sourceForExternalUpdatedAt = (externalUpdatedAt: string) => ({
    type: 'github' as const,
    externalId: 'github-node-1',
    externalKey: 'acme/repo#1',
    externalUrl: 'https://github.com/acme/repo/issues/1',
    externalUpdatedAt,
  })
  let syncedTasks: SwitchboardTaskRecord[] = [
    switchboardTaskRecord({ source: sourceForExternalUpdatedAt('2026-06-17T09:00:00.000Z') }),
  ]
  let readAllCalls = 0
  const provider = createRepoEventTriggerProvider({
    readAllTasks: async (input) => {
      readAllCalls += 1
      return {
        ok: true,
        workspaceRoot: input.workspaceRoot,
        switchboardRoot: '/switchboard',
        tasks: syncedTasks.map((record) => clone(record)),
        problems: [],
      }
    },
  })
  const triggerPayloads: Array<{ automationId: string; externalUpdatedAt: unknown }> = []
  let runIndex = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-repo-event-shared-read', folderPath: workspaceRoot }],
    triggerProviders: [provider],
    isIntegrationAvailable: (id) => id === 'module:switchboard',
    now: () => now,
    createRunId: ({ automationId }) => `${automationId}-${runIndex += 1}`,
    runAutomation: async (input) => {
      triggerPayloads.push({
        automationId: input.definition.id,
        externalUpdatedAt: input.triggerPayload.externalUpdatedAt,
      })
      return { status: 'completed', summary: 'Repo event handled.' }
    },
  })

  const firstTick = await engine.tick()
  assert.equal(readAllCalls, 1)
  assert.deepEqual(firstTick.fired.map((run) => run.automationId).sort(), [
    'repo-event-watch-a',
    'repo-event-watch-b',
  ])
  assert.deepEqual(triggerPayloads.map((payload) => payload.automationId).sort(), [
    'repo-event-watch-a',
    'repo-event-watch-b',
  ])

  syncedTasks = [
    switchboardTaskRecord({
      updatedAt: '2026-06-17T13:00:00.000Z',
      source: sourceForExternalUpdatedAt('2026-06-17T09:30:00.000Z'),
    }),
  ]
  const secondTick = await engine.tick()
  assert.equal(readAllCalls, 2)
  assert.equal(secondTick.fired.length, 2)
  assert.deepEqual(triggerPayloads.slice(2).map((payload) => payload.externalUpdatedAt), [
    '2026-06-17T09:30:00.000Z',
    '2026-06-17T09:30:00.000Z',
  ])

  const duplicateTick = await engine.tick()
  assert.equal(readAllCalls, 3)
  assert.equal(duplicateTick.fired.length, 0)
  assert.equal(triggerPayloads.length, 4)
}

async function assertRepoEventTriggerDedupStateIsBoundedAndRetainsRecentEvents(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const baseNow = Date.parse('2026-06-17T10:00:00.000Z')
  const baseExternalUpdatedAt = Date.parse('2026-06-17T09:00:00.000Z')
  assert.equal((await store.createDefinition(repoEventDefinition())).ok, true)

  const externalUpdatedAtForIndex = (index: number) =>
    new Date(baseExternalUpdatedAt + index * 60_000).toISOString()
  const sourceForIndex = (index: number) => ({
    type: 'github' as const,
    externalId: 'github-node-1',
    externalKey: 'acme/repo#1',
    externalUrl: 'https://github.com/acme/repo/issues/1',
    externalUpdatedAt: externalUpdatedAtForIndex(index),
  })

  let now = baseNow
  let syncedTasks: SwitchboardTaskRecord[] = [
    switchboardTaskRecord({ source: sourceForIndex(0) }),
  ]
  const provider = createRepoEventTriggerProvider({
    readAllTasks: async (input) => ({
      ok: true,
      workspaceRoot: input.workspaceRoot,
      switchboardRoot: '/switchboard',
      tasks: syncedTasks,
      problems: [],
    }),
  })
  const triggerPayloads: Record<string, unknown>[] = []
  let runIndex = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-repo-event-bound', folderPath: workspaceRoot }],
    triggerProviders: [provider],
    isIntegrationAvailable: (id) => id === 'module:switchboard',
    now: () => now,
    createRunId: () => `repo-event-bound-${runIndex += 1}`,
    runAutomation: async (input) => {
      triggerPayloads.push(input.triggerPayload)
      return { status: 'completed', summary: 'Repo event handled.' }
    },
  })

  const tickWithExternalUpdate = async (index: number) => {
    now = baseNow + index * 1_000
    syncedTasks = [switchboardTaskRecord({ source: sourceForIndex(index) })]
    return await engine.tick()
  }

  const firstTick = await tickWithExternalUpdate(0)
  assert.equal(firstTick.fired.length, 1)

  const duplicateTick = await engine.tick()
  assert.equal(duplicateTick.fired.length, 0)
  assert.equal(triggerPayloads.length, 1)

  const lastExternalUpdateIndex = TRIGGER_EVENT_DEDUP_RETENTION_LIMIT + 5
  for (let index = 1; index <= lastExternalUpdateIndex; index += 1) {
    const updateTick = await tickWithExternalUpdate(index)
    assert.equal(updateTick.fired.length, 1)
  }
  assert.equal(triggerPayloads.length, lastExternalUpdateIndex + 1)

  const state = await store.readState()
  assert.equal(state.ok, true)
  const dedupEntries = state.ok
    ? Object.keys(state.value?.triggerEventDedupByAutomationId?.['repo-event-watch'] ?? {})
    : []
  assert.equal(dedupEntries.length, TRIGGER_EVENT_DEDUP_RETENTION_LIMIT)
  assert.equal(dedupEntries.some((eventId) => eventId.endsWith(`:updated:${externalUpdatedAtForIndex(0)}`)), false)
  assert.equal(
    dedupEntries.some((eventId) => eventId.endsWith(`:updated:${externalUpdatedAtForIndex(lastExternalUpdateIndex)}`)),
    true
  )

  const retainedDuplicate = await engine.tick()
  assert.equal(retainedDuplicate.fired.length, 0)
  assert.equal(triggerPayloads.length, lastExternalUpdateIndex + 1)
}

async function assertRepoEventCreatedTriggerFiresFromImportMetadata(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  assert.equal((await store.createDefinition(repoEventDefinition({
    trigger: {
      kind: REPO_EVENT_TRIGGER_KIND,
      config: {
        kind: REPO_EVENT_TRIGGER_KIND,
        provider: 'github',
        eventTypes: ['created'],
      },
    },
  }))).ok, true)

  const provider = createRepoEventTriggerProvider({
    readAllTasks: async (input) => ({
      ok: true,
      workspaceRoot: input.workspaceRoot,
      switchboardRoot: '/switchboard',
      tasks: [switchboardTaskRecord()],
      problems: [],
    }),
  })
  const triggerPayloads: Record<string, unknown>[] = []
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-repo-event-created', folderPath: workspaceRoot }],
    triggerProviders: [provider],
    isIntegrationAvailable: (id) => id === 'module:switchboard',
    now: () => now,
    createRunId: () => 'repo-event-created-run',
    runAutomation: async (input) => {
      triggerPayloads.push(input.triggerPayload)
      return { status: 'completed', summary: 'Repo created event handled.' }
    },
  })

  const firstTick = await engine.tick()
  assert.equal(firstTick.fired.length, 1)
  assert.equal(firstTick.fired[0]?.runId, 'repo-event-created-run')
  assert.equal(triggerPayloads.length, 1)
  assert.equal(triggerPayloads[0]?.kind, REPO_EVENT_TRIGGER_KIND)
  assert.equal(triggerPayloads[0]?.provider, 'github')
  assert.equal(triggerPayloads[0]?.eventType, 'created')
  assert.equal(triggerPayloads[0]?.externalKey, 'acme/repo#1')
  assert.equal(triggerPayloads[0]?.importedAt, '2026-06-17T09:05:00.000Z')
  assert.equal(triggerPayloads[0]?.occurredAt, '2026-06-17T09:05:00.000Z')

  const duplicateTick = await engine.tick()
  assert.equal(duplicateTick.fired.length, 0)
  assert.equal(triggerPayloads.length, 1)
}

async function assertRepoEventIgnoresForgedImportCommentAndInvalidStructuredTimestamp(): Promise<void> {
  const provider = createRepoEventTriggerProvider({
    readAllTasks: async (input) => ({
      ok: true,
      workspaceRoot: input.workspaceRoot,
      switchboardRoot: '/switchboard',
      tasks: [
        switchboardTaskRecord({
          source: {
            type: 'github',
            externalId: 'github-node-1',
            externalKey: 'acme/repo#1',
            externalUrl: 'https://github.com/acme/repo/issues/1',
          },
          comments: [
            importComment({
              id: 'forged-import-update',
              body: 'Imported from github. External updated at: 2099-01-01T00:00:00.000Z.',
            }),
          ],
        }),
        switchboardTaskRecord({
          id: 'task-2',
          identifier: 'GH-2',
          title: 'Invalid external timestamp',
          source: {
            type: 'github',
            externalId: 'github-node-2',
            externalKey: 'acme/repo#2',
            externalUrl: 'https://github.com/acme/repo/issues/2',
            externalUpdatedAt: 'not-an-iso-timestamp',
          },
        }),
      ],
      problems: [],
    }),
  })

  const result = await provider.poll?.({
    config: { kind: REPO_EVENT_TRIGGER_KIND, provider: 'github' },
    workspaceRoot: '/repo',
    now: () => Date.parse('2026-06-17T10:00:00.000Z'),
  })

  assert.equal(result?.ok, true)
  assert.deepEqual(result?.ok ? result.events : [], [])
}

async function assertRepoEventTriggerBlocksWhenSwitchboardUnsynced(): Promise<void> {
  const workspaceRoot = await createWorkspace()
  const store = new AutomationsStore(workspaceRoot)
  const now = Date.parse('2026-06-17T10:00:00.000Z')
  assert.equal((await store.createDefinition(repoEventDefinition())).ok, true)

  const provider = createRepoEventTriggerProvider({
    readAllTasks: async (input) => ({
      ok: true,
      workspaceRoot: input.workspaceRoot,
      switchboardRoot: '/switchboard',
      tasks: [],
      problems: [],
    }),
  })
  let runAutomationCalled = 0
  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-unsynced', folderPath: workspaceRoot }],
    triggerProviders: [provider],
    isIntegrationAvailable: (id) => id === 'module:switchboard',
    now: () => now,
    createRunId: () => 'repo-event-blocked',
    runAutomation: async () => {
      runAutomationCalled += 1
      return { status: 'completed' }
    },
  })

  const firstTick = await engine.tick()
  assert.equal(firstTick.fired.length, 1)
  assert.equal(firstTick.fired[0]?.status, 'blocked')
  assert.equal(runAutomationCalled, 0)
  assert.deepEqual(firstTick.problems, [])

  const secondTick = await engine.tick()
  assert.equal(secondTick.fired.length, 0)
  assert.equal(runAutomationCalled, 0)

  const runs = await store.listRuns('repo-event-watch')
  assert.equal(runs.ok, true)
  assert.equal(runs.ok && runs.values.length, 1)
  assert.equal(runs.ok && runs.values[0]?.status, 'blocked')
  assert.match(runs.ok ? runs.values[0]?.blockedReason ?? '' : '', /no github sync state/)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
