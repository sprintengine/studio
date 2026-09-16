import assert from 'node:assert/strict'
import type { PluginRegistryListEntry } from '../../../shared/plugin-manifest'
import type {
  SprintRuntimeOp,
  SprintRuntimeRunRegistration,
  SprintRuntimeStopReasonPush,
} from '../../../shared/sprintengine/runtime-bridge'
import type { LayoutTemplate } from '../types/workspace'
import { createInitialSprintEngineState } from './sprintengine'
import { sprintEngineRunContext } from '../store/slices/workspaceModuleState'

// ── Fake preload API, installed before the modules under test are imported so
// the bridge sees `window.api` at init time (node has no `window`). Mirrors
// the sprintengineAutomationModeSync.test.ts harness.
type FakeApi = {
  registerCalls: SprintRuntimeRunRegistration[]
  unregisterCalls: string[]
  stopReasonPushes: SprintRuntimeStopReasonPush[]
  broadcastOp: (op: SprintRuntimeOp) => void
}

function installFakeApi(): FakeApi {
  const fake: FakeApi = {
    registerCalls: [],
    unregisterCalls: [],
    stopReasonPushes: [],
    broadcastOp: () => undefined,
  }
  const api = {
    registerSprintRuntimeRun: async (input: SprintRuntimeRunRegistration) => {
      fake.registerCalls.push(input)
      return { ok: true as const }
    },
    unregisterSprintRuntimeRun: async ({ statePath }: { statePath: string }) => {
      fake.unregisterCalls.push(statePath)
      return { ok: true as const }
    },
    pushSprintRuntimeStopReason: async (input: SprintRuntimeStopReasonPush) => {
      fake.stopReasonPushes.push(input)
      return { ok: true as const }
    },
    onSprintRuntimeOp: (cb: (op: SprintRuntimeOp) => void) => {
      fake.broadcastOp = cb
      return () => undefined
    },
    setSprintEngineAutomationMode: async () => ({ ok: true as const, record: { schemaVersion: 1, revision: 1, desiredMode: 'manual', changedAt: 1, lastWrite: { actor: 'system', deviceId: null, at: '' } }, changed: false }),
  }
  ;(globalThis as { window?: unknown }).window = { api }
  bindSprintEngineIpc(api as never)
  return fake
}

const fakeApi = installFakeApi()

// Imported AFTER the fake window is installed.
import { useWorkspaceStore } from '../store/workspaceStore'
import { useSprintEngineRunStore } from '../modules/sprint-engine-run-store'
import { useNotificationStore } from '../store/notificationStore'
import { initSprintEngineRuntimeBridge } from './sprintengineRuntimeBridge'
import { bindSprintEngineIpc } from '../modules/sprint-engine-ipc'

const template: LayoutTemplate = {
  id: 'runtime-bridge-standard',
  name: 'Standard',
  description: 'Runtime-bridge test template',
  previewSlots: [],
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: false },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          children: [{ type: 'tab', name: 'Editor', component: 'editor' }],
        },
      ],
    },
  },
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// `setSprintEngineState` re-derives sprintEngineContext (and the statePath)
// from the run name, so read the effective statePath back.
function addSprintWorkspace(name: string, folderPath: string): { workspaceId: string; statePath: string } {
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, { name, folderPath })
  useSprintEngineRunStore.getState().setSprintEngineState(
    workspaceId,
    createInitialSprintEngineState({
      goal: 'Validate the runtime bridge',
      name,
      roleCounts: { architect: 1 },
    })
  )
  const found = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === workspaceId)
  const statePath = found ? sprintEngineRunContext(found)?.statePath : undefined
  assert.ok(statePath, 'sprint workspace fixture must expose a statePath')
  return { workspaceId, statePath }
}

async function main(): Promise<void> {
  // A resume-capable claude entry so assign_session stamps caps from the catalog.
  useWorkspaceStore.setState({
    pluginCatalogEntries: [
      { id: 'claude', resumeSession: true, sessionIdFromCaller: true } as PluginRegistryListEntry,
    ],
  })

  const { workspaceId, statePath } = addSprintWorkspace('Runtime Bridge', '/repo/bridge')
  const workspace = () =>
    useWorkspaceStore.getState().workspaces.find((ws) => ws.id === workspaceId)

  const dispose = initSprintEngineRuntimeBridge()
  await settle()

  // ── Registration: pushed once with the full payload.
  assert.equal(fakeApi.registerCalls.length, 1, 'one registration per sprint workspace')
  const registered = fakeApi.registerCalls[0]
  assert.equal(registered.statePath, statePath)
  assert.equal(registered.workspaceId, workspaceId)
  assert.equal(registered.workspaceName, 'Runtime Bridge')
  assert.equal(registered.folderPath, '/repo/bridge')
  assert.equal(registered.memoryRelativeRoot, workspace()?.memory?.relativeRoot ?? null)
  assert.equal(registered.cliPermissionPreset, workspace()?.sprintEngineAutoState?.cliPermissionPreset)
  assert.equal(registered.maxConcurrentAgents, 3)
  assert.deepEqual(registered.deliveredAgentNotificationEventKeys, [])
  assert.deepEqual(registered.rosterSessions, {})
  assert.deepEqual(registered.agents, workspace()?.agents ?? {})
  assert.equal(registered.runtimeState, 'idle', 'the persisted lifecycle rides the registration')

  // ── Agents-only churn must NOT re-register (runtime residue is main-owned
  // after the first registration).
  useWorkspaceStore.getState().updateAgent(workspaceId, 'architect-1', { streamBuffer: 'noise' })
  await settle()
  assert.equal(fakeApi.registerCalls.length, 1, 'agent churn does not re-register')

  // ── A config change (maxConcurrentAgents) re-registers.
  useSprintEngineRunStore.getState().setSprintEngineMaxConcurrentAgents(workspaceId, 5)
  await settle()
  assert.equal(fakeApi.registerCalls.length, 2, 'config change re-registers')
  assert.equal(fakeApi.registerCalls[1].maxConcurrentAgents, 5)

  // ── Op application ───────────────────────────────────────────────────────
  fakeApi.broadcastOp({
    kind: 'agent_updated',
    statePath,
    agentId: 'architect-1',
    update: { cliHasLaunched: true, name: 'Ada' },
  })
  assert.equal(workspace()?.agents['architect-1']?.cliHasLaunched, true)
  assert.equal(workspace()?.agents['architect-1']?.name, 'Ada')

  fakeApi.broadcastOp({
    kind: 'assign_session',
    statePath,
    agentId: 'architect-1',
    sessionId: 'sess-1',
    cli: 'claude',
  })
  const assigned = workspace()?.agents['architect-1']
  assert.equal(assigned?.cliSessionId, 'sess-1')
  assert.equal(assigned?.cli, 'claude')
  assert.equal(assigned?.cliResumeAvailable, true, 'resume caps stamped from the local plugin catalog')
  assert.equal(assigned?.cliUsesStableSessionId, true)

  fakeApi.broadcastOp({
    kind: 'launch_state',
    statePath,
    agentId: 'architect-1',
    update: { cliOnboardingPromptSent: true },
  })
  assert.equal(workspace()?.agents['architect-1']?.cliOnboardingPromptSent, true)

  // stop_reason: same transitions as a renderer stop, and NO push-back echo.
  useSprintEngineRunStore.getState().setSprintEngineAutomationMode(workspaceId, 'run_agents')
  assert.equal(workspace()?.sprintEngineAutoState?.runtimeState, 'running')
  fakeApi.broadcastOp({
    kind: 'stop_reason',
    statePath,
    reason: 'blocked_on_external_input',
    context: { taskId: 'T1', message: 'Waiting on the user.' },
  })
  assert.equal(workspace()?.sprintEngineAutoState?.runtimeState, 'blocked')
  assert.equal(workspace()?.sprintEngineAutoState?.reasonTaskId, 'T1')
  await settle()
  assert.equal(fakeApi.stopReasonPushes.length, 0, 'a main-originated stop reason is never pushed back to main')

  fakeApi.broadcastOp({
    kind: 'roster_session_recorded',
    statePath,
    agentId: 'architect-1',
    session: { role: 'architect', cli: 'claude', cliSessionId: 'sess-1', recordedAt: 42 },
  })
  assert.deepEqual(
    workspace()?.sprintEngineRosterSessions?.['architect-1'],
    { role: 'architect', cli: 'claude', cliSessionId: 'sess-1', recordedAt: 42 },
  )

  fakeApi.broadcastOp({ kind: 'completion_teardown_at', statePath, at: 123 })
  assert.equal(workspace()?.sprintEngineAutoState?.completionTeardownAt, 123)

  // Runtime-residue ops never re-registered the run.
  await settle()
  assert.equal(fakeApi.registerCalls.length, 2, 'op application does not re-register')

  // ── Lifecycle rides re-registrations: the blocked state above is visible to
  // the scheduler the next time identity/config re-registers.
  useSprintEngineRunStore.getState().setSprintEngineMaxConcurrentAgents(workspaceId, 4)
  await settle()
  assert.equal(fakeApi.registerCalls.length, 3, 'config change re-registers')
  assert.equal(fakeApi.registerCalls[2].runtimeState, 'blocked', 'persisted lifecycle rides the registration')
  assert.equal(fakeApi.registerCalls[2].reasonTaskId, 'T1')

  // automation_resumed: main resumed the blocked run itself (a needs_input
  // resolution lifted the blocker) — the same runner_started transition as
  // the board's Resume control, and (like stop_reason) never pushed back.
  fakeApi.broadcastOp({ kind: 'automation_resumed', statePath })
  assert.equal(workspace()?.sprintEngineAutoState?.runtimeState, 'running', 'the blocked run re-enters running')
  assert.equal(workspace()?.sprintEngineAutoState?.reason, undefined, 'the block reason is cleared')
  await settle()
  assert.equal(fakeApi.stopReasonPushes.length, 0, 'a main-originated resume is never pushed back to main')

  // ── Agent configs: a config-field edit on a roster agent re-registers with
  // null tombstones for unset fields (roster membership marks the agent managed).
  useWorkspaceStore.getState().updateAgent(workspaceId, 'architect', {
    cliStartupPrompt: 'ship it',
  })
  await settle()
  assert.equal(fakeApi.registerCalls.length, 4, 'a config edit re-registers configs')
  const seededConfig = fakeApi.registerCalls[3].agentConfigs['architect']
  assert.ok(seededConfig, 'sprintengine agents always carry a config entry')
  assert.equal(seededConfig.cliRuntimeOverride, null, 'unset override is an explicit tombstone')
  assert.equal(seededConfig.cliStartupPrompt, 'ship it', 'the edited startup prompt is registered')

  // …and a user config edit is stamped so main's merge is last-write-wins.
  useWorkspaceStore.getState().updateAgent(workspaceId, 'architect', {
    cliRuntimeOverride: { cli: 'codex', model: null },
  })
  await settle()
  assert.equal(fakeApi.registerCalls.length, 5, 'a config edit re-registers')
  const editedConfig = fakeApi.registerCalls[4].agentConfigs['architect']
  assert.deepEqual(editedConfig?.cliRuntimeOverride, { cli: 'codex', model: null })
  assert.ok(typeof editedConfig?.configEditedAt === 'number', 'the edit is stamped for last-write-wins')
  assert.equal(
    workspace()?.agents['architect']?.configEditedAt,
    editedConfig.configEditedAt,
    'the stamp lives on the agent record',
  )

  // ── diagnostic op: the entry lands in the notification store (main already
  // wrote the JSONL).
  fakeApi.broadcastOp({
    kind: 'diagnostic',
    statePath,
    entry: {
      id: 'diag-1',
      timestamp: new Date(0).toISOString(),
      level: 'warning',
      source: 'sprintengine',
      title: 'Artifact auto-approval skipped',
      message: 'Review manually or retry.',
    },
  })
  const notifications = useNotificationStore.getState().notifications
  assert.ok(
    notifications.some((notification) => notification.title === 'Artifact auto-approval skipped'),
    'the diagnostic entry surfaces as an in-app notification',
  )

  // ── reveal_policy op: tab maintenance is a no-op without a layout model for
  // the workspace (node fixture), but the op must apply cleanly.
  fakeApi.broadcastOp({
    kind: 'reveal_policy',
    statePath,
    agentId: 'architect-1',
    name: 'T2: Ship the fixture',
    revealPolicy: 'background',
    sessionId: 'sess-2',
  })

  // ── Stashed op: delivered before the workspace materializes, applied when
  // it does. The store derives a deterministic statePath from the run name.
  const probe = addSprintWorkspace('Late Bridge', '/repo/late')
  useWorkspaceStore.getState().removeWorkspace(probe.workspaceId)
  await settle()
  const lateStatePath = probe.statePath
  fakeApi.broadcastOp({
    kind: 'agent_updated',
    statePath: lateStatePath,
    agentId: 'architect-1',
    update: { cliStartRequested: true },
  })
  const late = addSprintWorkspace('Late Bridge', '/repo/late')
  assert.equal(late.statePath, lateStatePath, 'fixture statePath is deterministic')
  await settle()
  const lateWorkspace = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === late.workspaceId)
  assert.equal(
    lateWorkspace?.agents['architect-1']?.cliStartRequested,
    true,
    'stashed op applied when the workspace materialized',
  )

  // ── Unregister on workspace removal.
  useWorkspaceStore.getState().removeWorkspace(workspaceId)
  await settle()
  assert.ok(fakeApi.unregisterCalls.includes(statePath), 'removed workspace unregisters its run')

  dispose()
  console.log('sprintengine runtime-bridge tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
