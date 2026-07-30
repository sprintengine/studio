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

// The containment an unattended (`bypass_all`) automation run is supposed to
// have — a per-run worktree, a per-run branch, and a pull request nobody merges
// automatically — is a property of the run, not of the permission preset. These
// drive the REAL engine into the REAL executor and read the agent's working
// directory off the launch request plus the PR opener's call log, on each of the
// three start paths (schedule due-run, "Run now", trigger event) and on both
// ways a run can end up with no worktree.

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

type PullRequestCall = { worktreePath: string; branch: string }

// Engine + executor wired together. `worktree` chooses how the run's isolation
// resolves: 'created' is the happy path, 'failed' is the non-Git folder /
// worktree-failure fallback the executor swallows.
function harness(
  root: string,
  options: { triggerKind?: string; worktree?: 'created' | 'failed' } = {}
) {
  const workspaces: Workspace[] = []
  const launches: Array<Extract<AutomationRendererRequest, { kind: 'agent.launch' }>> = []
  const pullRequests: PullRequestCall[] = []
  const delegateToRenderer = async (request: AutomationRendererRequest): Promise<AutomationRendererResponse> => {
    if (request.kind === 'workspace.create') {
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
    createRunWorktree: async (input) => {
      if (options.worktree === 'failed') throw new Error('not a git repository')
      return { worktreePath: join(root, '.multi-code/automations/worktrees', input.runId), branch: `automations/${input.runId}` }
    },
  })

  const engine = new AutomationsEngine({
    getProjectFolders: () => [{ workspaceId: 'ws-host', folderPath: root }],
    now: () => Date.parse('2026-07-30T02:00:00.000Z'),
    createRunId: () => 'run-1',
    runAutomation: executor,
    openRunPullRequest: async (input) => {
      pullRequests.push({ worktreePath: input.worktreePath, branch: input.branch })
      return { ok: true, url: 'https://example.invalid/pr/1', created: true }
    },
    ...(options.triggerKind
      ? { triggerProviders: [{ kind: options.triggerKind, configSchema: {}, subscribe: () => () => undefined }] }
      : {}),
  })

  return { engine, launches, pullRequests }
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
  const root = await mkdtemp(join(tmpdir(), 'multicode-containment-'))
  const store = new AutomationsStore(root)
  const config = definition.action.config as Record<string, unknown>
  const created = await store.createDefinition({
    ...definition,
    action: { ...definition.action, config: { ...config, folderPath: root } },
  })
  assert.equal(created.ok, true, 'the definition is written to the store')
  return root
}

// Drive one start path to a launch, then finalize the run as the agent-state
// frames would. Returns what the run actually got.
async function runToFinalize(
  path: 'schedule' | 'run-now' | 'trigger',
  definition: AutomationDefinition,
  worktree: 'created' | 'failed'
): Promise<{ root: string; launch: Extract<AutomationRendererRequest, { kind: 'agent.launch' }>; pullRequests: PullRequestCall[]; branch?: string }> {
  const shaped = path === 'trigger'
    ? { ...definition, trigger: { kind: 'test-event', config: {} }, nextRunAt: null } as AutomationDefinition
    : path === 'run-now'
      ? { ...definition, nextRunAt: '2026-07-31T01:00:00.000Z' } as AutomationDefinition
      : definition
  const root = await withStore(shaped)
  const { engine, launches, pullRequests } = harness(root, {
    worktree,
    ...(path === 'trigger' ? { triggerKind: 'test-event' } : {}),
  })

  if (path === 'schedule') await engine.tick()
  if (path === 'run-now') {
    const result = await engine.runNow({ workspaceRoot: root, automationId: 'nightly-sweep' })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  if (path === 'trigger') {
    const delivered = await engine.deliverTriggerEvent({
      workspaceRoot: root,
      automationId: 'nightly-sweep',
      workspaceId: 'ws-host',
      event: { id: 'event-1', occurredAt: '2026-07-30T02:00:00.000Z', payload: {} },
    })
    assert.equal(delivered.ok, true, JSON.stringify(delivered))
  }

  assert.equal(launches.length, 1, `the ${path} path fires exactly one launch`)
  const finalized = await engine.finalizeRun({
    workspaceRoot: root,
    automationId: 'nightly-sweep',
    runId: 'run-1',
    outcome: 'completed',
    workspaceId: 'ws-host',
  })
  assert.equal(finalized.ok, true, JSON.stringify(finalized))
  const branch = finalized.ok ? finalized.run.branch : undefined
  return { root, launch: launches[0]!, pullRequests, branch }
}

// The claimed containment, on every start path: the agent's cwd is the run's own
// worktree (never the user's checkout), the run carries its own branch, and the
// finalize opens a PR from that branch.
async function assertContainmentHoldsWhenTheWorktreeIsCreated(): Promise<void> {
  for (const path of ['schedule', 'run-now', 'trigger'] as const) {
    const { root, launch, pullRequests, branch } = await runToFinalize(path, scheduledDefinition(), 'created')
    assert.equal(launch.permissionPreset, 'bypass_all', `${path}: launches unattended`)
    assert.equal(
      launch.worktreePath,
      join(root, '.multi-code/automations/worktrees', 'run-1'),
      `${path}: the agent runs in the run's own worktree, not the user's checkout`
    )
    assert.equal(branch, 'automations/run-1', `${path}: the run carries its own branch`)
    assert.deepEqual(
      pullRequests,
      [{ worktreePath: join(root, '.multi-code/automations/worktrees', 'run-1'), branch: 'automations/run-1' }],
      `${path}: the finalize opens a PR from the run's branch`
    )
    await rm(root, { recursive: true, force: true })
  }
}

// A definition that opts out of isolation (`runInWorktree: false`, a switch the
// Automations editor offers) still launches on the unattended default: the agent
// runs with permissions bypassed directly in the user's checkout, the run has no
// branch, and the finalize opens no PR — so none of the three claimed
// containments applies to it. Same on every start path.
async function assertNoContainmentWhenTheDefinitionOptsOut(): Promise<void> {
  for (const path of ['schedule', 'run-now', 'trigger'] as const) {
    const { root, launch, pullRequests, branch } = await runToFinalize(
      path,
      scheduledDefinition({ runInWorktree: false }),
      'created'
    )
    assert.equal(launch.permissionPreset, 'bypass_all', `${path}: opting out still launches unattended`)
    assert.equal(launch.worktreePath, undefined, `${path}: the agent runs in the user's checkout`)
    assert.equal(branch, undefined, `${path}: the run has no branch of its own`)
    assert.deepEqual(pullRequests, [], `${path}: the finalize opens no pull request`)
    await rm(root, { recursive: true, force: true })
  }
}

// The same total loss of containment, without anyone opting out: worktree
// creation is best-effort, so a non-Git folder (or any worktree failure) is
// swallowed and the run falls back to the user's checkout — unattended, with no
// branch and no PR, and nothing in the run record says isolation was lost.
async function assertNoContainmentWhenTheWorktreeCannotBeCreated(): Promise<void> {
  for (const path of ['schedule', 'run-now', 'trigger'] as const) {
    const { root, launch, pullRequests, branch } = await runToFinalize(path, scheduledDefinition(), 'failed')
    assert.equal(launch.permissionPreset, 'bypass_all', `${path}: the fallback still launches unattended`)
    assert.equal(launch.worktreePath, undefined, `${path}: the fallback runs in the user's checkout`)
    assert.equal(branch, undefined, `${path}: the fallback run has no branch`)
    assert.deepEqual(pullRequests, [], `${path}: the fallback opens no pull request`)
    await rm(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await assertContainmentHoldsWhenTheWorktreeIsCreated()
  await assertNoContainmentWhenTheDefinitionOptsOut()
  await assertNoContainmentWhenTheWorktreeCannotBeCreated()
  console.log('automations unattended containment tests passed')
}

void main()
