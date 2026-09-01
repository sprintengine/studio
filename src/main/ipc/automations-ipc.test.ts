import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationsDefinitionResult,
  AutomationsDeleteResult,
  AutomationsEngineStatusResult,
  AutomationsInstanceListResult,
  AutomationsListResult,
  AutomationsProvidersResult,
  AutomationsRunEvent,
  AutomationsRunNowResult,
  AutomationsRunsListResult,
} from '../../shared/automations/contracts'
import {
  AUTOMATIONS_CREATE_CHANNEL,
  AUTOMATIONS_DELETE_CHANNEL,
  AUTOMATIONS_ENGINE_STATUS_CHANNEL,
  AUTOMATIONS_GET_CHANNEL,
  AUTOMATIONS_INSTANCE_LIST_CHANNEL,
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_PROVIDERS_LIST_CHANNEL,
  AUTOMATIONS_RUN_NOW_CHANNEL,
  AUTOMATIONS_RUNS_LIST_CHANNEL,
  AUTOMATIONS_UPDATE_CHANNEL,
} from '../../shared/automations/contracts'
import { createAutomationsEngine } from '../automations/engine'
import { SPRINT_ENGINE_RUN_ACTION_KIND } from '../automations/actions/sprint-engine'
import {
  SWITCHBOARD_AUTOMATION_INTEGRATION_ID,
  SWITCHBOARD_RUNNER_TICK_ACTION_KIND,
  WATCHTOWER_AUTOMATION_INTEGRATION_ID,
  WATCHTOWER_REVIEW_ACTION_KIND,
} from '../automations/actions/switchboard'
import { createBuiltInAutomationProviderRegistry } from '../automations/provider-registry'
import { REPO_EVENT_TRIGGER_KIND } from '../automations/triggers/repo-event'
import { WEBHOOK_TRIGGER_KIND } from '../automations/triggers/webhook'
import { AutomationsStore } from '../automations/store'
import type { IpcInvokeHandler } from '../module-host/main-host'
import { registerAutomationsIpc } from './automations-ipc'

type HandlerMap = Map<string, IpcInvokeHandler>

function createFakeHost(options: {
  onDefinitionsChanged?: (workspaceRoot: string) => void | Promise<void>
  onRunEvent?: (event: AutomationsRunEvent) => void
  workspaceRoots?: string[]
} = {}): HandlerMap {
  const handlers: HandlerMap = new Map()
  registerAutomationsIpc(
    {
      registerIpc(channel, handler) {
        handlers.set(channel, handler)
      },
    },
    testDeps(options)
  )
  return handlers
}

let currentNow = Date.parse('2026-06-18T00:00:00.000Z')
let runCount = 0

function testDeps(options: {
  onDefinitionsChanged?: (workspaceRoot: string) => void | Promise<void>
  onRunEvent?: (event: AutomationsRunEvent) => void
  workspaceRoots?: string[]
} = {}) {
  const workspaceRoots = options.workspaceRoots ?? []
  const providerRegistry = createBuiltInAutomationProviderRegistry()
  const engine = createAutomationsEngine({
    createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
    getProjectFolders: () => workspaceRoots.map((folderPath, index) => ({ workspaceId: `ws-${index + 1}`, folderPath })),
    runAutomation: async () => {
      runCount += 1
      return { status: 'completed', summary: 'Manual run completed.' }
    },
    now: () => currentNow,
    createRunId: ({ automationId, dueAt }) => `${automationId}-${Date.parse(dueAt)}`,
    onRunEvent: options.onRunEvent,
  })
  return {
    engine,
    triggerProviders: providerRegistry.listTriggerProviders(),
    actionProviders: providerRegistry.listActionProviders(),
    getWorkspaceSyncSnapshot: () => workspaceSnapshot(workspaceRoots),
    onDefinitionsChanged: options.onDefinitionsChanged,
    now: () => currentNow,
  }
}

async function invoke<T>(handlers: HandlerMap, channel: string, input?: unknown): Promise<T> {
  const handler = handlers.get(channel)
  assert.ok(handler, `expected handler for ${channel}`)
  return await handler({} as never, input) as T
}

async function withWorkspaceRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'multicode-automations-ipc-'))
}

function workspaceSnapshot(workspaceRoots: string[]): WorkspaceSyncSnapshot {
  return {
    sequence: 1,
    state: {
      activeWorkspaceId: workspaceRoots[0] ? 'ws-1' : null,
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [],
      workspaces: workspaceRoots.map((folderPath, index) => ({
        id: `ws-${index + 1}`,
        folderPath,
      })),
    },
  } as unknown as WorkspaceSyncSnapshot
}

function definitionDraft(overrides: Partial<AutomationDefinitionDraft> = {}): AutomationDefinitionDraft {
  return {
    id: 'nightly-review',
    name: 'Nightly Review',
    status: 'enabled',
    trigger: {
      kind: 'schedule',
      config: {
        kind: 'schedule',
        timezone: 'UTC',
        cadence: { type: 'interval', everyMinutes: 10 },
      },
    },
    action: {
      kind: 'spawn-agent',
      config: { prompt: 'Review this workspace.' },
    },
    ...overrides,
  }
}

async function testProviderList(): Promise<void> {
  const providers = await invoke<AutomationsProvidersResult>(createFakeHost(), AUTOMATIONS_PROVIDERS_LIST_CHANNEL)
  assert.equal(providers.ok, true)
  if (!providers.ok) return
  assert.equal(JSON.stringify(providers.value), JSON.stringify({
    triggers: [
      {
        kind: 'schedule',
        configSchema: {
          type: 'object',
          required: ['kind', 'cadence', 'timezone'],
          properties: {
            kind: { const: 'schedule' },
            timezone: { type: 'string', minLength: 1 },
            cadence: {
              oneOf: [
                {
                  type: 'object',
                  required: ['type', 'everyMinutes'],
                  properties: {
                    type: { const: 'interval' },
                    everyMinutes: { type: 'integer', minimum: 5 },
                  },
                },
                {
                  type: 'object',
                  required: ['type', 'timeLocal'],
                  properties: {
                    type: { const: 'daily' },
                    timeLocal: { type: 'string', pattern: '^([01]\\d|2[0-3]):([0-5]\\d)$' },
                  },
                },
                {
                  type: 'object',
                  required: ['type', 'timeLocal', 'daysOfWeek'],
                  properties: {
                    type: { const: 'weekly' },
                    timeLocal: { type: 'string', pattern: '^([01]\\d|2[0-3]):([0-5]\\d)$' },
                    daysOfWeek: {
                      type: 'array',
                      minItems: 1,
                      uniqueItems: true,
                      items: { type: 'integer', minimum: 0, maximum: 6 },
                    },
                  },
                },
                {
                  type: 'object',
                  required: ['type', 'datetime'],
                  properties: {
                    type: { const: 'at' },
                    datetime: { type: 'string', pattern: '^(\\d{4})-(\\d{2})-(\\d{2})T([01]\\d|2[0-3]):([0-5]\\d)(?::[0-5]\\d)?$' },
                  },
                },
              ],
            },
          },
        },
        requiredIntegrations: [],
        missingIntegrations: [],
      },
      {
        kind: WEBHOOK_TRIGGER_KIND,
        configSchema: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { const: WEBHOOK_TRIGGER_KIND },
            enabled: { type: 'boolean', default: false },
            port: { type: 'integer', minimum: 0, maximum: 65535 },
            path: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
            secret: { type: 'string', minLength: 16 },
            eventType: { type: 'string', minLength: 1 },
            label: { type: 'string', minLength: 1 },
          },
        },
        requiredIntegrations: [],
        missingIntegrations: [],
      },
    ],
    actions: [
      {
        kind: 'spawn-agent',
        configSchema: {
          type: 'object',
          required: ['prompt'],
          properties: {
            folderPath: { type: 'string', minLength: 1 },
            workspaceId: { type: 'string', minLength: 1 },
            cli: { type: 'string', minLength: 1 },
            cliModel: { type: 'string', minLength: 1 },
            permissionPreset: { type: 'string', enum: ['default', 'auto', 'bypass'] },
            specialistId: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            prompt: { type: 'string', minLength: 1 },
            connectorId: { type: 'string', minLength: 1 },
            spawnSkillId: { type: 'string', minLength: 1 },
            includeTriggerContext: { type: 'boolean' },
            requiredIntegrations: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
            },
          },
        },
        requiredIntegrations: [],
        missingIntegrations: [],
      },
      {
        kind: 'run-skill-loop',
        configSchema: {
          type: 'object',
          required: ['prompt'],
          properties: {
            folderPath: { type: 'string', minLength: 1 },
            workspaceId: { type: 'string', minLength: 1 },
            cli: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            prompt: { type: 'string', minLength: 1 },
            skill: { type: 'string', minLength: 1 },
            includeTriggerContext: { type: 'boolean' },
            requiredIntegrations: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
            },
          },
        },
        requiredIntegrations: [],
        missingIntegrations: [],
      },
    ],
  }))
  assert.equal(providers.value.actions.some((provider) => provider.kind === 'run-command'), false)
}

async function testProviderListIncludesFirstPartyActionsAndMissingIntegrations(): Promise<void> {
  const handlers: HandlerMap = new Map()
  const providerRegistry = createBuiltInAutomationProviderRegistry({
    switchboard: {
      readAllTasks: async () => {
        throw new Error('not used')
      },
      tickRunner: async () => {
        throw new Error('not used')
      },
      startWatchtowerReview: async () => {
        throw new Error('not used')
      },
    },
    sprintEngine: {
      setRunnerMode: async () => {
        throw new Error('not used')
      },
      readProjection: async () => {
        throw new Error('not used')
      },
      refreshPullRequestStatus: async () => {
        throw new Error('not used')
      },
      mergePullRequest: async () => {
        throw new Error('not used')
      },
    },
  })

  registerAutomationsIpc(
    {
      registerIpc(channel, handler) {
        handlers.set(channel, handler)
      },
    },
    {
      engine: {
        runNow: async () => ({
          ok: false as const,
          problem: { code: 'not_used', message: 'not used' },
        }),
        finalizeRun: async () => ({
          ok: false as const,
          problem: { code: 'not_used', message: 'not used' },
        }),
      },
      triggerProviders: providerRegistry.listTriggerProviders(),
      actionProviders: providerRegistry.listActionProviders(),
      isIntegrationAvailable: (id) => id !== WATCHTOWER_AUTOMATION_INTEGRATION_ID,
      now: () => currentNow,
    }
  )

  const providers = await invoke<AutomationsProvidersResult>(handlers, AUTOMATIONS_PROVIDERS_LIST_CHANNEL)
  assert.equal(providers.ok, true)
  if (!providers.ok) return

  const repoEvent = providers.value.triggers.find((provider) => provider.kind === REPO_EVENT_TRIGGER_KIND)
  assert.deepEqual(repoEvent?.requiredIntegrations, [SWITCHBOARD_AUTOMATION_INTEGRATION_ID])
  assert.deepEqual(repoEvent?.missingIntegrations, [])
  assert.deepEqual((repoEvent?.configSchema as { required?: unknown }).required, ['kind'])

  const switchboard = providers.value.actions.find((provider) => provider.kind === SWITCHBOARD_RUNNER_TICK_ACTION_KIND)
  assert.deepEqual(switchboard?.requiredIntegrations, ['module:switchboard'])
  assert.deepEqual(switchboard?.missingIntegrations, [])

  const watchtower = providers.value.actions.find((provider) => provider.kind === WATCHTOWER_REVIEW_ACTION_KIND)
  assert.deepEqual(watchtower?.requiredIntegrations, ['module:watchtower'])
  assert.deepEqual(watchtower?.missingIntegrations, ['module:watchtower'])
  assert.deepEqual((watchtower?.configSchema as { required?: unknown }).required, ['preset'])

  const sprintEngine = providers.value.actions.find((provider) => provider.kind === SPRINT_ENGINE_RUN_ACTION_KIND)
  assert.deepEqual(sprintEngine?.requiredIntegrations, ['module:sprint-engine'])
  assert.deepEqual(sprintEngine?.missingIntegrations, [])
  assert.deepEqual((sprintEngine?.configSchema as { required?: unknown }).required, ['team'])
}

async function testDefinitionRoundTripAndRunNow(): Promise<void> {
  currentNow = Date.parse('2026-06-18T00:00:00.000Z')
  runCount = 0
  const workspaceRoot = await withWorkspaceRoot()
  const runEvents: AutomationsRunEvent[] = []
  const handlers = createFakeHost({ onRunEvent: (event) => runEvents.push(event), workspaceRoots: [workspaceRoot] })

  const created = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_CREATE_CHANNEL, {
    workspaceRoot,
    definition: definitionDraft(),
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.value.nextRunAt, '2026-06-18T00:10:00.000Z')

  const listed = await invoke<AutomationsListResult>(handlers, AUTOMATIONS_LIST_CHANNEL, { workspaceRoot })
  assert.equal(listed.ok, true)
  if (!listed.ok) return
  assert.deepEqual(listed.value.map((definition) => definition.id), ['nightly-review'])

  const fetched = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_GET_CHANNEL, {
    workspaceRoot,
    automationId: 'nightly-review',
  })
  assert.equal(fetched.ok, true)
  if (!fetched.ok) return
  assert.equal(fetched.value.name, 'Nightly Review')

  const updated = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_UPDATE_CHANNEL, {
    workspaceRoot,
    automationId: 'nightly-review',
    patch: {
      trigger: {
        kind: 'schedule',
        config: {
          kind: 'schedule',
          timezone: 'UTC',
          cadence: { type: 'interval', everyMinutes: 20 },
        },
      },
    },
  })
  assert.equal(updated.ok, true)
  if (!updated.ok) return
  assert.equal(updated.value.nextRunAt, '2026-06-18T00:20:00.000Z')

  const initialRuns = await invoke<AutomationsRunsListResult>(handlers, AUTOMATIONS_RUNS_LIST_CHANNEL, {
    workspaceRoot,
    automationId: 'nightly-review',
  })
  assert.equal(initialRuns.ok, true)
  if (!initialRuns.ok) return
  assert.deepEqual(initialRuns.value, [])

  currentNow = Date.parse('2026-06-18T00:05:00.000Z')
  const runNow = await invoke<AutomationsRunNowResult>(handlers, AUTOMATIONS_RUN_NOW_CHANNEL, {
    workspaceRoot,
    workspaceId: 'ws-automations',
    automationId: 'nightly-review',
  })
  assert.equal(runNow.ok, true)
  if (!runNow.ok) return
  assert.equal(runCount, 1)
  assert.equal(runNow.value.run.status, 'completed')
  assert.equal(runNow.value.definition.lastRunId, runNow.value.run.id)
  assert.equal(runNow.value.definition.nextRunAt, '2026-06-18T00:25:00.000Z')
  assert.deepEqual(runEvents, [
    {
      automationId: 'nightly-review',
      runId: runNow.value.run.id,
      workspaceId: 'ws-automations',
      definitionName: 'Nightly Review',
      status: 'completed',
      trigger: 'manual',
    },
  ])

  const runs = await invoke<AutomationsRunsListResult>(handlers, AUTOMATIONS_RUNS_LIST_CHANNEL, {
    workspaceRoot,
    automationId: 'nightly-review',
  })
  assert.equal(runs.ok, true)
  if (!runs.ok) return
  assert.deepEqual(runs.value.map((run) => run.status), ['completed'])

  const store = new AutomationsStore(workspaceRoot)
  const stateBeforeDelete = await store.readState()
  assert.equal(stateBeforeDelete.ok, true)
  if (!stateBeforeDelete.ok) return
  const seededState = await store.writeState({
    ...(stateBeforeDelete.value ?? { nextRunAtByAutomationId: {}, lock: null }),
    triggerEventDedupByAutomationId: {
      ...(stateBeforeDelete.value?.triggerEventDedupByAutomationId ?? {}),
      'nightly-review': {
        'repo-event:github:acme/repo#1:updated:2026-06-17T09:00:00.000Z': '2026-06-18T00:06:00.000Z',
      },
      'other-automation': {
        'repo-event:github:acme/repo#2:updated:2026-06-17T09:00:00.000Z': '2026-06-18T00:06:00.000Z',
      },
    },
    triggerBlockedReasonByAutomationId: {
      ...(stateBeforeDelete.value?.triggerBlockedReasonByAutomationId ?? {}),
      'nightly-review': 'Blocked before delete.',
      'other-automation': 'Still blocked.',
    },
  })
  assert.equal(seededState.ok, true)

  const deleted = await invoke<AutomationsDeleteResult>(handlers, AUTOMATIONS_DELETE_CHANNEL, {
    workspaceRoot,
    automationId: 'nightly-review',
  })
  assert.equal(deleted.ok, true)

  const stateAfterDelete = await store.readState()
  assert.equal(stateAfterDelete.ok, true)
  if (!stateAfterDelete.ok) return
  assert.equal(stateAfterDelete.value?.nextRunAtByAutomationId['nightly-review'], undefined)
  assert.equal(stateAfterDelete.value?.triggerEventDedupByAutomationId?.['nightly-review'], undefined)
  assert.equal(stateAfterDelete.value?.triggerBlockedReasonByAutomationId?.['nightly-review'], undefined)
  assert.deepEqual(stateAfterDelete.value?.triggerEventDedupByAutomationId?.['other-automation'], {
    'repo-event:github:acme/repo#2:updated:2026-06-17T09:00:00.000Z': '2026-06-18T00:06:00.000Z',
  })
  assert.equal(stateAfterDelete.value?.triggerBlockedReasonByAutomationId?.['other-automation'], 'Still blocked.')

  const afterDelete = await invoke<AutomationsListResult>(handlers, AUTOMATIONS_LIST_CHANNEL, { workspaceRoot })
  assert.equal(afterDelete.ok, true)
  if (!afterDelete.ok) return
  assert.deepEqual(afterDelete.value, [])
}

async function testWebhookSecretIsRedactedFromDefinitionIpcReads(): Promise<void> {
  const workspaceRoot = await withWorkspaceRoot()
  const secret = 'test-webhook-secret-redacted'
  const store = new AutomationsStore(workspaceRoot)
  const definition: AutomationDefinition = {
    id: 'webhook-secret',
    name: 'Webhook Secret',
    status: 'enabled',
    trigger: {
      kind: WEBHOOK_TRIGGER_KIND,
      config: {
        kind: WEBHOOK_TRIGGER_KIND,
        enabled: true,
        port: 0,
        path: 'incoming-review',
        secret,
        eventType: 'push',
      },
    },
    action: {
      kind: 'spawn-agent',
      config: { prompt: 'Handle the webhook.' },
    },
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  }
  assert.equal((await store.createDefinition(definition)).ok, true)

  const handlers = createFakeHost({ workspaceRoots: [workspaceRoot] })
  const listed = await invoke<AutomationsListResult>(handlers, AUTOMATIONS_LIST_CHANNEL, { workspaceRoot })
  assert.equal(listed.ok, true)
  if (!listed.ok) return
  assertRedactedWebhookDefinition(listed.value[0])

  const fetched = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_GET_CHANNEL, {
    workspaceRoot,
    automationId: 'webhook-secret',
  })
  assert.equal(fetched.ok, true)
  if (!fetched.ok) return
  assertRedactedWebhookDefinition(fetched.value)

  const updated = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_UPDATE_CHANNEL, {
    workspaceRoot,
    automationId: 'webhook-secret',
    patch: { status: 'paused' },
  })
  assert.equal(updated.ok, true)
  if (!updated.ok) return
  assertRedactedWebhookDefinition(updated.value)

  const raw = await store.getDefinition('webhook-secret')
  assert.equal(raw.ok, true)
  if (!raw.ok) return
  assert.equal((raw.value.trigger.config as Record<string, unknown>).secret, secret)
}

function assertRedactedWebhookDefinition(definition: AutomationDefinition | undefined): void {
  assert.ok(definition)
  const config = definition.trigger.config as Record<string, unknown>
  assert.equal(config.secret, undefined)
  assert.equal(config.hasSecret, true)
  assert.equal(config.path, 'incoming-review')
}

async function testDefinitionWritesNotifyRefreshHook(): Promise<void> {
  currentNow = Date.parse('2026-06-18T00:00:00.000Z')
  const workspaceRoot = await withWorkspaceRoot()
  const refreshRoots: string[] = []
  const handlers = createFakeHost({
    workspaceRoots: [workspaceRoot],
    onDefinitionsChanged: (changedRoot) => {
      refreshRoots.push(changedRoot)
    },
  })

  const created = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_CREATE_CHANNEL, {
    workspaceRoot,
    definition: definitionDraft({ id: 'webhook-refresh-hook' }),
  })
  assert.equal(created.ok, true)

  const updated = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_UPDATE_CHANNEL, {
    workspaceRoot,
    automationId: 'webhook-refresh-hook',
    patch: { status: 'paused' },
  })
  assert.equal(updated.ok, true)

  const deleted = await invoke<AutomationsDeleteResult>(handlers, AUTOMATIONS_DELETE_CHANNEL, {
    workspaceRoot,
    automationId: 'webhook-refresh-hook',
  })
  assert.equal(deleted.ok, true)

  assert.deepEqual(refreshRoots, [workspaceRoot, workspaceRoot, workspaceRoot])
}

async function testDefinitionWriteSurfacesRefreshHookFailure(): Promise<void> {
  currentNow = Date.parse('2026-06-18T00:00:00.000Z')
  const workspaceRoot = await withWorkspaceRoot()
  const handlers = createFakeHost({
    workspaceRoots: [workspaceRoot],
    onDefinitionsChanged: () => {
      throw new Error('receiver failed closed')
    },
  })

  const created = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_CREATE_CHANNEL, {
    workspaceRoot,
    definition: definitionDraft({ id: 'webhook-refresh-failure' }),
  })
  assert.equal(created.ok, false)
  assert.equal(created.ok ? '' : created.code, 'webhook_receiver_refresh_failed')
  assert.match(created.ok ? '' : created.message, /receiver failed closed/u)
}

// The marketplace shelf is a global door and the store is per-project, so the
// install path's one job at this boundary is to refuse to guess: a wrong-project
// install is invisible, and one with no project at all is worse.
async function testCatalogueInstallTargetsOnlyAnOpenProject(): Promise<void> {
  const knownRoot = await withWorkspaceRoot()
  const outsideRoot = await mkdtemp(join(tmpdir(), 'multicode-automations-ipc-outside-'))
  const frontDoor = registerAutomationsIpc(
    { registerIpc: () => undefined },
    testDeps({ workspaceRoots: [knownRoot] })
  )
  const payload = {
    name: 'Nightly dependency sweep',
    trigger: { kind: 'schedule', config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'interval', everyMinutes: 10 } } },
    action: { kind: 'spawn-agent', config: { prompt: 'Check for outdated dependencies.' } },
  }

  const noProject = await frontDoor.installCatalogueDefinition({
    definition: payload,
    sourceCatalogueId: 'multicode.nightly-sweep',
  })
  assert.equal(noProject.ok, false)
  if (!noProject.ok) assert.equal(noProject.code, 'invalid_input', 'an install with no project refuses rather than picking one')

  const wrongProject = await frontDoor.installCatalogueDefinition({
    workspaceRoot: outsideRoot,
    definition: payload,
    sourceCatalogueId: 'multicode.nightly-sweep',
  })
  assert.equal(wrongProject.ok, false)
  if (!wrongProject.ok) assert.equal(wrongProject.code, 'workspace_root_untrusted')
  const outsideDefinitions = await new AutomationsStore(outsideRoot).listDefinitions()
  assert.equal(outsideDefinitions.ok && outsideDefinitions.values.length, 0, 'a project the app does not have open is never written to')

  const added = await frontDoor.installCatalogueDefinition({
    workspaceRoot: knownRoot,
    definition: payload,
    sourceCatalogueId: 'multicode.nightly-sweep',
    sourcePublisher: 'Multicode Labs',
  })
  assert.equal(added.ok, true, added.ok ? '' : added.message)
  if (!added.ok) return
  assert.equal(added.value.alreadyAdded, false)
  assert.equal(added.value.workspaceRoot, knownRoot, 'the result names the project it used')
  assert.equal(added.value.definition.sourceCatalogueId, 'multicode.nightly-sweep')
}

async function testOutOfWorkspaceRootIsRejectedBeforeStoreOrRunNow(): Promise<void> {
  const knownRoot = await withWorkspaceRoot()
  const outsideRoot = await mkdtemp(join(tmpdir(), 'multicode-automations-ipc-outside-'))
  const handlers: HandlerMap = new Map()
  let storeCreated = 0
  let runNowCalled = 0
  const providerRegistry = createBuiltInAutomationProviderRegistry()

  registerAutomationsIpc(
    {
      registerIpc(channel, handler) {
        handlers.set(channel, handler)
      },
    },
    {
      engine: {
        runNow: async () => {
          runNowCalled += 1
          return {
            ok: false as const,
            problem: { code: 'should_not_run', message: 'should not run' },
          }
        },
        finalizeRun: async () => ({
          ok: false as const,
          problem: { code: 'should_not_run', message: 'should not run' },
        }),
      },
      createStore: (workspaceRoot) => {
        storeCreated += 1
        return new AutomationsStore(workspaceRoot)
      },
      triggerProviders: providerRegistry.listTriggerProviders(),
      actionProviders: providerRegistry.listActionProviders(),
      getWorkspaceSyncSnapshot: () => workspaceSnapshot([knownRoot]),
      now: () => currentNow,
    }
  )

  const listed = await invoke<AutomationsListResult>(handlers, AUTOMATIONS_LIST_CHANNEL, { workspaceRoot: outsideRoot })
  assert.equal(listed.ok, false)
  assert.equal(listed.ok ? '' : listed.code, 'workspace_root_untrusted')
  assert.equal(storeCreated, 0)

  const runNow = await invoke<AutomationsRunNowResult>(handlers, AUTOMATIONS_RUN_NOW_CHANNEL, {
    workspaceRoot: outsideRoot,
    automationId: 'nightly-review',
  })
  assert.equal(runNow.ok, false)
  assert.equal(runNow.ok ? '' : runNow.code, 'workspace_root_untrusted')
  assert.equal(runNowCalled, 0)
}

async function testEngineStatusChannelReflectsSidecar(): Promise<void> {
  const engineStatusHandlers = (status: (() => { id: string; moduleId: string; kind: string; state: string; error?: string } | undefined)): HandlerMap => {
    const handlers: HandlerMap = new Map()
    registerAutomationsIpc(
      {
        registerIpc(channel, handler) {
          handlers.set(channel, handler)
        },
      },
      {
        engine: {
          runNow: async () => ({ ok: false as const, problem: { code: 'not_used', message: 'not used' } }),
          finalizeRun: async () => ({ ok: false as const, problem: { code: 'not_used', message: 'not used' } }),
        },
        getEngineSidecarStatus: status as never,
        now: () => currentNow,
      }
    )
    return handlers
  }

  const running = await invoke<AutomationsEngineStatusResult>(
    engineStatusHandlers(() => ({ id: 'automations-engine', moduleId: 'automations', kind: 'scheduler', state: 'running' })),
    AUTOMATIONS_ENGINE_STATUS_CHANNEL
  )
  assert.equal(running.ok, true)
  if (!running.ok) return
  assert.deepEqual(running.value, { state: 'running' })

  const failed = await invoke<AutomationsEngineStatusResult>(
    engineStatusHandlers(() => ({
      id: 'automations-engine',
      moduleId: 'automations',
      kind: 'scheduler',
      state: 'failed',
      error: 'Webhook receiver: port 8787 already in use',
    })),
    AUTOMATIONS_ENGINE_STATUS_CHANNEL
  )
  assert.equal(failed.ok, true)
  if (!failed.ok) return
  assert.deepEqual(failed.value, { state: 'failed', error: 'Webhook receiver: port 8787 already in use' })

  const absent = await invoke<AutomationsEngineStatusResult>(
    engineStatusHandlers(() => undefined),
    AUTOMATIONS_ENGINE_STATUS_CHANNEL
  )
  assert.equal(absent.ok, true)
  if (!absent.ok) return
  assert.deepEqual(absent.value, { state: 'unavailable' })
}

async function testRunInWorktreeRoundTripAndValidation(): Promise<void> {
  const workspaceRoot = await withWorkspaceRoot()
  const handlers = createFakeHost({ workspaceRoots: [workspaceRoot] })

  // Opt out at create: the boolean round-trips onto the stored definition.
  const created = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_CREATE_CHANNEL, {
    workspaceRoot,
    definition: definitionDraft({ runInWorktree: false }),
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.value.runInWorktree, false, 'create persists runInWorktree=false')

  // Flip it back on via patch.
  const updated = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_UPDATE_CHANNEL, {
    workspaceRoot,
    automationId: 'nightly-review',
    patch: { runInWorktree: true },
  })
  assert.equal(updated.ok, true)
  if (!updated.ok) return
  assert.equal(updated.value.runInWorktree, true, 'patch updates runInWorktree')

  // Flip back OFF via patch (the user's edit-screen on→off flow), then re-fetch
  // from the store to prove `false` actually persists — not just echoed back.
  const off = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_UPDATE_CHANNEL, {
    workspaceRoot,
    automationId: 'nightly-review',
    patch: { runInWorktree: false },
  })
  assert.equal(off.ok, true)
  if (!off.ok) return
  assert.equal(off.value.runInWorktree, false, 'patch updates runInWorktree to false')
  const refetched = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_GET_CHANNEL, {
    workspaceRoot,
    automationId: 'nightly-review',
  })
  assert.equal(refetched.ok, true)
  if (!refetched.ok) return
  assert.equal(refetched.value.runInWorktree, false, 'runInWorktree=false persists across a fresh fetch')

  // Absent at create stays absent on the stored definition; consumers default it
  // to true (existing automations keep their per-run worktree).
  const createdDefault = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_CREATE_CHANNEL, {
    workspaceRoot,
    definition: definitionDraft({ id: 'other-review' }),
  })
  assert.equal(createdDefault.ok, true)
  if (!createdDefault.ok) return
  assert.equal(createdDefault.value.runInWorktree, undefined, 'absent runInWorktree stays absent (defaulted at use)')

  // A non-boolean runInWorktree is rejected at the IPC boundary.
  const invalid = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_CREATE_CHANNEL, {
    workspaceRoot,
    definition: { ...definitionDraft({ id: 'bad-review' }), runInWorktree: 'yes' } as unknown,
  })
  assert.equal(invalid.ok, false, 'non-boolean runInWorktree is rejected as invalid_input')

  console.log('automations-ipc runInWorktree round-trip tests passed')
}

// The instance channel enumerates every automation across the snapshot's roots
// (no workspaceRoot argument), redacts webhook secrets like the per-project list,
// and carries the workspaceRoot each entry's recent-runs read needs.
async function testInstanceListEnumeratesAcrossRootsAndRedacts(): Promise<void> {
  const rootA = await withWorkspaceRoot()
  const rootB = await withWorkspaceRoot()
  const handlers = createFakeHost({ workspaceRoots: [rootA, rootB] })

  const createdA = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_CREATE_CHANNEL, {
    workspaceRoot: rootA,
    definition: definitionDraft({ id: 'nightly', name: 'Nightly' }),
  })
  assert.equal(createdA.ok, true)
  const createdB = await invoke<AutomationsDefinitionResult>(handlers, AUTOMATIONS_CREATE_CHANNEL, {
    workspaceRoot: rootB,
    definition: definitionDraft({
      id: 'hooked',
      name: 'Hooked',
      trigger: { kind: 'webhook', config: { kind: 'webhook', path: 'incoming', secret: 'super-secret-1234567' } },
    }),
  })
  assert.equal(createdB.ok, true)

  const index = await invoke<AutomationsInstanceListResult>(handlers, AUTOMATIONS_INSTANCE_LIST_CHANNEL)
  assert.equal(index.ok, true)
  if (!index.ok) return
  assert.equal(index.value.problems.length, 0)
  const byId = new Map(index.value.entries.map((entry) => [entry.definition.id, entry]))
  assert.deepEqual([...byId.keys()].sort(), ['hooked', 'nightly'])
  assert.equal(byId.get('nightly')?.workspaceRoot, rootA, 'entry carries its project root for the runs read')
  assert.equal(byId.get('nightly')?.lastRun, null, 'no runs yet')
  assert.equal(byId.get('nightly')?.isRunningNow, false)
  const hookedConfig = byId.get('hooked')?.definition.trigger.config as Record<string, unknown>
  assert.equal('secret' in hookedConfig, false, 'webhook secret redacted in the instance index')
  assert.equal(hookedConfig.hasSecret, true)
}

async function main(): Promise<void> {
  await testProviderList()
  await testRunInWorktreeRoundTripAndValidation()
  await testProviderListIncludesFirstPartyActionsAndMissingIntegrations()
  await testDefinitionRoundTripAndRunNow()
  await testWebhookSecretIsRedactedFromDefinitionIpcReads()
  await testDefinitionWritesNotifyRefreshHook()
  await testDefinitionWriteSurfacesRefreshHookFailure()
  await testOutOfWorkspaceRootIsRejectedBeforeStoreOrRunNow()
  await testCatalogueInstallTargetsOnlyAnOpenProject()
  await testEngineStatusChannelReflectsSidecar()
  await testInstanceListEnumeratesAcrossRootsAndRedacts()
  console.log('automations-ipc tests passed')
}

void main()
