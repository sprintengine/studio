import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { AutomationDefinition } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { Workspace } from '../../renderer/src/types/workspace'
import { AutomationsEngine } from './engine'
import { createLocalAutomationExecutor } from './executor-local'
import { AutomationsStore } from './store'

// Every path that can start an automation run — the scheduler's due-run tick,
// "Run now", and a fired trigger event — must launch its agent on the same
// permission preset, because they all resolve it in the same place (the
// spawn-agent config parse). These drive the REAL engine into the REAL executor
// and read the preset off the agent.launch request that reaches the renderer.

function workspace(id: string, folderPath: string | null, mode: Workspace['mode']): Workspace {
  return {
    id,
    name: id,
    mode,
    folderPath,
    templateId: 'standard-test',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    sprintEngineState: null,
    sprintEngineAutoState: {
      desiredMode: 'manual',
      runtimeState: 'idle',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 0,
      deliveredAgentNotificationEventKeys: [],
    },
    createdAt: 1,
  } as Workspace
}

function snapshot(workspaces: Workspace[]): WorkspaceSyncSnapshot {
  return {
    sequence: 1,
    state: {
      workspaces,
      activeWorkspaceId: workspaces[0]?.id ?? null,
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [
        {
          id: 'primary',
          kind: 'primary',
          workspaceIds: workspaces.map((entry) => entry.id),
          activeWorkspaceId: workspaces[0]?.id ?? null,
          bounds: null,
          isMaximized: false,
          displayId: null,
          createdAt: 0,
          lastFocusedAt: 0,
        },
      ],
    },
  }
}

// Engine + executor wired together, with the renderer stubbed at the delegate
// boundary so the launch request is observable.
function harness(root: string, options: { triggerKind?: string } = {}) {
  const workspaces: Workspace[] = []
  const launches: Array<Extract<AutomationRendererRequest, { kind: 'agent.launch' }>> = []
  const delegateToRenderer = async (request: AutomationRendererRequest): Promise<AutomationRendererResponse> => {
    if (request.kind === 'workspace.create') {
      // Honor the mode the executor asks for: the default launch route resolves
      // an `automations-host` workspace, and a 'standard' stand-in would never
      // satisfy it.
      const created = workspace('ws-host', request.folderPath ?? null, request.mode ?? 'standard')
      workspaces.push(created)
      return { ok: true, workspaceId: created.id }
    }
    if (request.kind === 'agent.launch') {
      launches.push(request)
      const target = workspaces.find((candidate) => candidate.id === request.workspaceId)
      if (!target) return { ok: false, code: 'unknown_workspace', message: 'unknown workspace' }
      const agentId = `agent-${launches.length}`
      target.agents[agentId] = { id: agentId, name: request.name ?? agentId, cli: request.cli ?? 'codex' } as Workspace['agents'][string]
      return { ok: true, workspaceId: request.workspaceId, agentId }
    }
    return { ok: false, code: 'unsupported', message: 'unsupported request' }
  }

  const executor = createLocalAutomationExecutor({
    delegateToRenderer,
    getWorkspaceSyncSnapshot: () => snapshot(workspaces),
    sleep: async () => undefined,
    // Hermetic: no real `git worktree` subprocess, and the run falls back to the
    // workspace checkout exactly as it does for a non-Git folder.
    createRunWorktree: async () => null,
  })

  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-host', folderPath: root }],
    now: () => Date.parse('2026-07-30T02:00:00.000Z'),
    createRunId: () => `run-${launches.length}`,
    runAutomation: executor,
    ...(options.triggerKind
      ? { triggerProviders: [{ kind: options.triggerKind, configSchema: {}, subscribe: () => () => undefined }] }
      : {}),
  })

  return { engine, launches }
}

function scheduledDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'nightly-sweep',
    name: 'Nightly sweep',
    status: 'enabled',
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' } },
    action: { kind: 'spawn-agent', config: { prompt: 'Sweep the repo.' } },
    nextRunAt: '2026-07-30T01:00:00.000Z',
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-07-29T09:00:00.000Z',
    updatedAt: '2026-07-29T09:00:00.000Z',
    ...overrides,
  } as AutomationDefinition
}

async function withStore(definition: AutomationDefinition): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-unattended-'))
  const store = new AutomationsStore(root)
  const config = definition.action.config as Record<string, unknown>
  const created = await store.createDefinition({
    ...definition,
    action: { ...definition.action, config: { ...config, folderPath: root } },
  })
  assert.equal(created.ok, true, 'the definition is written to the store')
  return root
}

async function assertScheduleDueRunLaunchesUnattended(): Promise<void> {
  const root = await withStore(scheduledDefinition())
  const { engine, launches } = harness(root)
  await engine.tick()
  assert.equal(launches.length, 1, 'the due schedule fires one launch')
  assert.equal(launches[0]?.permissionPreset, 'bypass_all', 'a due-run launches unattended')
  await rm(root, { recursive: true, force: true })
}

async function assertRunNowLaunchesUnattended(): Promise<void> {
  const root = await withStore(scheduledDefinition({ nextRunAt: '2026-07-31T01:00:00.000Z' }))
  const { engine, launches } = harness(root)
  const result = await engine.runNow({ workspaceRoot: root, automationId: 'nightly-sweep' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(launches.length, 1, 'run now fires one launch')
  assert.equal(launches[0]?.permissionPreset, 'bypass_all', 'a "Run now" launches unattended')
  await rm(root, { recursive: true, force: true })
}

async function assertTriggerEventLaunchesUnattended(): Promise<void> {
  const definition = scheduledDefinition({ trigger: { kind: 'test-event', config: {} }, nextRunAt: null })
  const root = await withStore(definition)
  const { engine, launches } = harness(root, { triggerKind: 'test-event' })
  const delivered = await engine.deliverTriggerEvent({
    workspaceRoot: root,
    automationId: 'nightly-sweep',
    workspaceId: 'ws-host',
    event: { id: 'event-1', occurredAt: '2026-07-30T02:00:00.000Z', payload: {} },
  })
  assert.equal(delivered.ok, true, JSON.stringify(delivered))
  assert.equal(launches.length, 1, 'the delivered event fires one launch')
  assert.equal(launches[0]?.permissionPreset, 'bypass_all', 'a trigger-fired run launches unattended')
  await rm(root, { recursive: true, force: true })
}

// The default is a default, not an override: a definition that names a preset
// gets exactly it, on the same path.
async function assertExplicitPresetSurvivesTheStartPath(): Promise<void> {
  for (const preset of ['default', 'auto_workspace'] as const) {
    const definition = scheduledDefinition({
      action: { kind: 'spawn-agent', config: { prompt: 'Sweep the repo.', permissionPreset: preset } },
    })
    const root = await withStore(definition)
    const { engine, launches } = harness(root)
    await engine.tick()
    assert.equal(launches.length, 1, `the "${preset}" automation fires`)
    assert.equal(launches[0]?.permissionPreset, preset, `an explicit "${preset}" reaches the launch verbatim`)
    await rm(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await assertScheduleDueRunLaunchesUnattended()
  await assertRunNowLaunchesUnattended()
  await assertTriggerEventLaunchesUnattended()
  await assertExplicitPresetSurvivesTheStartPath()
  console.log('automations unattended permission tests passed')
}

void main()
