import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationsRunEvent,
  AutomationTriggerProvider,
  AutomationActionProvider,
} from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { parseDefinitionDraft, prepareDefinitionForWrite } from './definition-write'
import { scheduleTriggerProvider } from './schedule'
import { createModuleAutomationsRegistry, type ModuleAutomationsRegistry } from './module-service'
import { allowAutomationProvider, type RegisteredAutomationProvider } from './provider-registry'
import { AutomationsStore } from './store'

const FIXTURE_TRIGGER: AutomationTriggerProvider = {
  kind: 'fixture-trigger',
  configSchema: { type: 'object' },
  subscribe: () => () => undefined,
}

const FIXTURE_ACTION: AutomationActionProvider = {
  kind: 'fixture-action',
  configSchema: { type: 'object' },
  run: async () => ({ status: 'completed' }),
}

function registration<T extends AutomationTriggerProvider | AutomationActionProvider>(
  providerType: 'trigger' | 'action',
  provider: T
): RegisteredAutomationProvider<T> {
  return {
    providerId: provider.kind,
    moduleId: 'automations',
    providerType,
    kind: provider.kind,
    configSchema: provider.configSchema,
    requiredIntegrations: [],
    provider,
  } as RegisteredAutomationProvider<T>
}

function draft(overrides: Partial<AutomationDefinitionDraft> = {}): AutomationDefinitionDraft {
  return {
    name: 'Fixture automation',
    status: 'paused',
    trigger: { kind: 'fixture-trigger', config: {} },
    action: { kind: 'fixture-action', config: {} },
    ...overrides,
  }
}

function definitionRecord(id: string, ownerModuleId?: string): AutomationDefinition {
  return {
    id,
    name: 'Automation record',
    status: 'paused',
    trigger: { kind: 'fixture-trigger', config: {} },
    action: { kind: 'fixture-action', config: {} },
    ...(ownerModuleId === undefined ? {} : { ownerModuleId }),
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

type Fixture = {
  registry: ModuleAutomationsRegistry
  workspaceRoot: string
  definitionsChanged: string[]
}

async function createFixture(options: { failDefinitionsChanged?: boolean } = {}): Promise<Fixture> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'automations-module-service-'))
  const definitionsChanged: string[] = []
  const snapshot = {
    state: { workspaces: [{ id: 'ws-1', folderPath: workspaceRoot }] },
  } as unknown as WorkspaceSyncSnapshot
  const registry = createModuleAutomationsRegistry({
    createStore: (root) => new AutomationsStore(root),
    getTriggerProviderRegistrations: () => [registration('trigger', FIXTURE_TRIGGER)],
    getActionProviderRegistrations: () => [registration('action', FIXTURE_ACTION)],
    checkProviderPermission: allowAutomationProvider,
    now: () => 1_700_000_000_000,
    onDefinitionsChanged: (root) => {
      definitionsChanged.push(root)
      if (options.failDefinitionsChanged) throw new Error('simulated webhook receiver failure')
    },
    getWorkspaceSyncSnapshot: () => snapshot,
  })
  return { registry, workspaceRoot, definitionsChanged }
}

function runEvent(automationId: string): AutomationsRunEvent {
  return {
    automationId,
    runId: 'run-1',
    workspaceId: 'ws-1',
    definitionName: 'Fixture automation',
    status: 'completed',
    trigger: 'timer',
  }
}

async function ownedIds(registry: ModuleAutomationsRegistry, moduleId: string, workspaceRoot: string): Promise<string[]> {
  const listed = await registry.list(moduleId, { workspaceRoot })
  assert.equal(listed.ok, true, listed.ok ? '' : listed.message)
  return listed.ok ? listed.automations.map((definition) => definition.id).sort() : []
}

async function testCreateStampsOwnerAndListFilters(): Promise<void> {
  const { registry, workspaceRoot, definitionsChanged } = await createFixture()

  const created = await registry.create('weather-deck', { workspaceRoot, draft: draft({ id: 'owned-1' }) })
  assert.equal(created.ok, true, created.ok ? '' : created.message)
  if (created.ok) {
    assert.equal(created.automation.ownerModuleId, 'weather-deck', 'ownership is stamped from the scoped module')
  }
  assert.deepEqual(definitionsChanged, [workspaceRoot], 'the definitions-changed hook fires on create')

  const sameOwner = await registry.create('weather-deck', {
    workspaceRoot,
    draft: draft({ id: 'owned-2', ownerModuleId: 'weather-deck' }),
  })
  assert.equal(sameOwner.ok, true, 'a draft echoing the calling module id is accepted')

  const other = await registry.create('other-module', { workspaceRoot, draft: draft({ id: 'other-1' }) })
  assert.equal(other.ok, true)

  assert.deepEqual(
    await ownedIds(registry, 'weather-deck', workspaceRoot),
    ['owned-1', 'owned-2'],
    'list returns only the calling module\'s automations'
  )
}

async function testCreateRefusesForeignOwner(): Promise<void> {
  const { registry, workspaceRoot } = await createFixture()
  const result = await registry.create('weather-deck', {
    workspaceRoot,
    draft: draft({ ownerModuleId: 'someone-else' }),
  })
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, 'invalid_draft', 'claiming another module\'s identity is refused')
}

async function testWorkspaceRootMustBeKnown(): Promise<void> {
  const { registry } = await createFixture()
  for (const workspaceRoot of ['relative/path', '/tmp/not-an-open-workspace-folder']) {
    const created = await registry.create('weather-deck', { workspaceRoot, draft: draft() })
    assert.equal(created.ok, false, `root "${workspaceRoot}" must be refused`)
    assert.equal(!created.ok && created.code, 'invalid_workspace')

    const listed = await registry.list('weather-deck', { workspaceRoot })
    assert.equal(listed.ok, false, 'list refuses unknown roots too')
    assert.equal(!listed.ok && listed.code, 'invalid_workspace')
  }
}

async function testPostWriteHookFailureDoesNotFailModuleWrites(): Promise<void> {
  const { registry, workspaceRoot } = await createFixture({ failDefinitionsChanged: true })
  const created = await registry.create('weather-deck', { workspaceRoot, draft: draft({ id: 'persisted' }) })
  assert.equal(
    created.ok,
    true,
    'a post-write refresh failure never fails the write — the record persisted; failing would wedge idempotent retries on already_exists'
  )
  assert.deepEqual(await ownedIds(registry, 'weather-deck', workspaceRoot), ['persisted'])
}

async function testMutationsRefuseUnownedRecords(): Promise<void> {
  const { registry, workspaceRoot } = await createFixture()
  await registry.create('other-module', { workspaceRoot, draft: draft({ id: 'other-owned' }) })

  // A user-created (unowned) record — no ownerModuleId.
  const store = new AutomationsStore(workspaceRoot)
  const userRecord = await store.createDefinition(definitionRecord('user-owned'))
  assert.equal(userRecord.ok, true)

  for (const automationId of ['other-owned', 'user-owned']) {
    const updated = await registry.update('weather-deck', {
      workspaceRoot,
      automationId,
      patch: { name: 'Hijacked' },
    })
    assert.equal(updated.ok, false, `update of ${automationId} must be refused`)
    assert.equal(!updated.ok && updated.code, 'not_owner')

    const deleted = await registry.delete('weather-deck', { workspaceRoot, automationId })
    assert.equal(deleted.ok, false, `delete of ${automationId} must be refused`)
    assert.equal(!deleted.ok && deleted.code, 'not_owner')

    const runs = await registry.listRuns('weather-deck', { workspaceRoot, automationId })
    assert.equal(runs.ok, false, `listRuns of ${automationId} must be refused`)
    assert.equal(!runs.ok && runs.code, 'not_owner')
  }

  const missing = await registry.update('weather-deck', {
    workspaceRoot,
    automationId: 'does-not-exist',
    patch: { name: 'New name' },
  })
  assert.equal(missing.ok, false)
  assert.equal(!missing.ok && missing.code, 'not_found')
}

async function testOwnershipIsCheckedOnTheWriteRead(): Promise<void> {
  // The ownership guard runs as a write-core precondition against the same
  // read the write uses: a record swapped to a different owner between the
  // caller's earlier looks and the write is still refused.
  const { registry, workspaceRoot } = await createFixture()
  await registry.create('weather-deck', { workspaceRoot, draft: draft({ id: 'swapped' }) })

  // Simulate the user deleting and re-creating the id as their own record.
  const store = new AutomationsStore(workspaceRoot)
  await store.deleteDefinition('swapped')
  const recreated = await store.createDefinition(definitionRecord('swapped'))
  assert.equal(recreated.ok, true)

  const updated = await registry.update('weather-deck', {
    workspaceRoot,
    automationId: 'swapped',
    patch: { name: 'Should not land' },
  })
  assert.equal(updated.ok, false)
  assert.equal(!updated.ok && updated.code, 'not_owner')

  const stillUser = await store.getDefinition('swapped')
  assert.equal(stillUser.ok && stillUser.value.name, 'Automation record', 'the user record is untouched')
}

async function testOwnerCanUpdateDeleteAndListRuns(): Promise<void> {
  const { registry, workspaceRoot } = await createFixture()
  await registry.create('weather-deck', { workspaceRoot, draft: draft({ id: 'mine' }) })

  const updated = await registry.update('weather-deck', {
    workspaceRoot,
    automationId: 'mine',
    patch: { name: 'Renamed by owner' },
  })
  assert.equal(updated.ok, true, updated.ok ? '' : updated.message)
  if (updated.ok) {
    assert.equal(updated.automation.name, 'Renamed by owner')
    assert.equal(updated.automation.ownerModuleId, 'weather-deck', 'ownership survives updates')
  }

  const runs = await registry.listRuns('weather-deck', { workspaceRoot, automationId: 'mine' })
  assert.equal(runs.ok, true)
  if (runs.ok) assert.deepEqual(runs.runs, [])

  const deleted = await registry.delete('weather-deck', { workspaceRoot, automationId: 'mine' })
  assert.equal(deleted.ok, true)
  assert.deepEqual(await ownedIds(registry, 'weather-deck', workspaceRoot), [])
}

async function testRunEventsAreOwnershipScoped(): Promise<void> {
  const { registry, workspaceRoot } = await createFixture()

  const seenByWeatherDeck: string[] = []
  const seenByOther: string[] = []
  const offWeatherDeck = registry.onRunEvent('weather-deck', (event) => seenByWeatherDeck.push(event.automationId))
  registry.onRunEvent('other-module', (event) => seenByOther.push(event.automationId))

  // The engine hands the definition through from its emit site; ownership is
  // read off it directly, never re-derived from the event's workspaceId.
  registry.deliverRunEvent(runEvent('owned-auto'), definitionRecord('owned-auto', 'weather-deck'))
  registry.deliverRunEvent(runEvent('other-auto'), definitionRecord('other-auto', 'other-module'))
  registry.deliverRunEvent(runEvent('user-auto'), definitionRecord('user-auto'))

  assert.deepEqual(seenByWeatherDeck, ['owned-auto'], 'a module sees only its own automations\' events')
  assert.deepEqual(seenByOther, ['other-auto'], 'other modules\' subscriptions are scoped the same way')

  offWeatherDeck()
  registry.deliverRunEvent(runEvent('owned-auto'), definitionRecord('owned-auto', 'weather-deck'))
  assert.deepEqual(seenByWeatherDeck, ['owned-auto'], 'unsubscribing stops delivery')

  registry.dispose()
  registry.deliverRunEvent(runEvent('other-auto'), definitionRecord('other-auto', 'other-module'))
  assert.deepEqual(seenByOther, ['other-auto'], 'dispose drops every subscriber')

  void workspaceRoot
}

function testEnabledPastAtCadenceSavesWithNoUpcomingRun(): void {
  // "A past datetime is valid and simply never fires" — the write path must
  // accept an enabled one-shot whose time already passed (also what editing an
  // already-fired one-shot looks like) and persist nextRunAt: null.
  const prepared = prepareDefinitionForWrite(
    {
      id: 'one-shot-past',
      name: 'One shot, already past',
      status: 'enabled',
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'at', datetime: '2020-01-01T09:00' } },
      },
      action: { kind: 'fixture-action', config: {} },
      nextRunAt: null,
      lastRunAt: null,
      lastRunId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    [registration('trigger', scheduleTriggerProvider)],
    [registration('action', FIXTURE_ACTION)],
    allowAutomationProvider,
    Date.parse('2026-06-17T10:00:00.000Z')
  )
  assert.equal(prepared.ok, true, prepared.ok ? '' : prepared.message)
  if (prepared.ok) assert.equal(prepared.value.nextRunAt, null, 'no upcoming run, not an error')
}

function testIpcDraftPathIgnoresOwnerModuleId(): void {
  // The parse strips a caller-supplied owner outright: ownership is stamped by
  // the host (module service) or absent (user records), never claimed.
  const parsed = parseDefinitionDraft({ ...draft(), ownerModuleId: 'weather-deck' })
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.value.ownerModuleId, undefined, 'a supplied owner never survives the parse')
  }
}

async function main(): Promise<void> {
  await testCreateStampsOwnerAndListFilters()
  await testCreateRefusesForeignOwner()
  await testWorkspaceRootMustBeKnown()
  await testPostWriteHookFailureDoesNotFailModuleWrites()
  await testMutationsRefuseUnownedRecords()
  await testOwnershipIsCheckedOnTheWriteRead()
  await testOwnerCanUpdateDeleteAndListRuns()
  await testRunEventsAreOwnershipScoped()
  testEnabledPastAtCadenceSavesWithNoUpcomingRun()
  testIpcDraftPathIgnoresOwnerModuleId()

  console.log('automations module-service tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
