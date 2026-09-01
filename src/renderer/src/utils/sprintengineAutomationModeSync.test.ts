import assert from 'node:assert/strict'
import type { SprintEngineAutomationChangedEvent } from '../../../shared/electron-api'
import type { SprintEngineAutomationIntentRecord } from '../../../shared/sprintengine/automation-intent'
import type { LayoutTemplate, SprintEngineAutomationMode } from '../types/workspace'
import { createInitialSprintEngineState } from './sprintengine'

// ── Fake preload API (installed before the modules under test are imported so
// the client sees `window.api` at call time; node has no `window`).
type PushCall = {
  statePath: string
  mode: SprintEngineAutomationMode
  clientToken?: string
}

type PresetPushCall = {
  statePath: string
  preset: string
  clientToken?: string
}

type FakeApi = {
  hydrateCalls: Array<{ statePath: string; mode: SprintEngineAutomationMode }>
  pushCalls: PushCall[]
  presetPushCalls: PresetPushCall[]
  records: Map<string, SprintEngineAutomationIntentRecord>
  broadcast: (event: SprintEngineAutomationChangedEvent) => void
  failReads: boolean
  // When set, push responses are held until released — lets tests deliver the
  // broadcast echo BEFORE the push promise resolves, which is the real
  // Electron ordering (main broadcasts from inside the serialized write).
  holdPushResponses: boolean
  releaseHeldPushes: () => void
}

function record(mode: SprintEngineAutomationMode, revision: number): SprintEngineAutomationIntentRecord {
  return {
    schemaVersion: 1,
    revision,
    desiredMode: mode,
    changedAt: revision * 1000,
    lastWrite: { actor: 'system', deviceId: null, at: new Date(revision * 1000).toISOString() },
  }
}

function installFakeApi(): FakeApi {
  const heldPushResolvers: Array<() => void> = []
  const fake: FakeApi = {
    hydrateCalls: [],
    pushCalls: [],
    presetPushCalls: [],
    records: new Map(),
    broadcast: () => undefined,
    failReads: false,
    holdPushResponses: false,
    releaseHeldPushes: () => {
      for (const release of heldPushResolvers.splice(0)) release()
    },
  }
  let nextRevision = 100
  const api = {
    readSprintEngineAutomationMode: async ({ statePath }: { statePath: string }) => {
      if (fake.failReads) return { ok: false as const, message: 'team directory missing' }
      return { ok: true as const, record: fake.records.get(statePath) ?? null }
    },
    hydrateSprintEngineAutomationMode: async ({ statePath, mode }: { statePath: string; mode: SprintEngineAutomationMode }) => {
      fake.hydrateCalls.push({ statePath, mode })
      const existing = fake.records.get(statePath)
      if (existing) return { ok: true as const, record: existing, changed: false }
      const created = record(mode, 1)
      fake.records.set(statePath, created)
      return { ok: true as const, record: created, changed: true }
    },
    setSprintEngineAutomationMode: async (input: PushCall) => {
      fake.pushCalls.push(input)
      const created = record(input.mode, nextRevision++)
      fake.records.set(input.statePath, created)
      // The real service broadcasts (with the writer's token) before the IPC
      // response resolves; mirror that ordering.
      fake.broadcast({
        statePath: input.statePath,
        record: created,
        ...(input.clientToken ? { sourceClientToken: input.clientToken } : {}),
      })
      if (fake.holdPushResponses) {
        await new Promise<void>((resolvePush) => heldPushResolvers.push(resolvePush))
      }
      return { ok: true as const, record: created, changed: true }
    },
    // Main answers a same-preset write with no revision bump and no broadcast,
    // which is what makes adopting a record safe to push back.
    setSprintEngineCliPermissionPreset: async (input: PresetPushCall) => {
      fake.presetPushCalls.push(input)
      const current = fake.records.get(input.statePath)
      if (current?.cliPermissionPreset === input.preset) {
        return { ok: true as const, record: current, changed: false }
      }
      const created = {
        ...(current ?? record('manual', nextRevision)),
        revision: nextRevision++,
        cliPermissionPreset: input.preset,
      } as SprintEngineAutomationIntentRecord
      fake.records.set(input.statePath, created)
      fake.broadcast({
        statePath: input.statePath,
        record: created,
        ...(input.clientToken ? { sourceClientToken: input.clientToken } : {}),
      })
      return { ok: true as const, record: created, changed: true }
    },
    onSprintEngineAutomationChanged: (cb: (event: SprintEngineAutomationChangedEvent) => void) => {
      fake.broadcast = cb
      return () => undefined
    },
  }
  ;(globalThis as { window?: unknown }).window = { api }
  return fake
}

const fakeApi = installFakeApi()

// Imported AFTER the fake window is installed.
import { useWorkspaceStore } from '../store/workspaceStore'
import { initSprintEngineAutomationModeSync } from './sprintengineAutomationModeSync'
import { resetSprintEngineAutomationRevisions } from './sprintengineAutomationIntentClient'

const template: LayoutTemplate = {
  id: 'automation-sync-standard',
  name: 'Standard',
  description: 'Automation-sync test template',
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

// `setSprintEngineState` re-derives sprintEngineContext (and therefore the
// statePath) from the run name, so read the effective statePath back rather
// than asserting on a hand-written one.
function addSprintWorkspace(name: string, folderPath: string): { workspaceId: string; statePath: string } {
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, { name, folderPath })
  useWorkspaceStore.getState().setSprintEngineState(
    workspaceId,
    createInitialSprintEngineState({
      goal: 'Validate automation-mode sync',
      name,
      roleCounts: { architect: 1 },
    })
  )
  const statePath = useWorkspaceStore.getState().workspaces
    .find((ws) => ws.id === workspaceId)?.sprintEngineContext?.statePath
  assert.ok(statePath, 'sprint workspace fixture must expose a statePath')
  return { workspaceId, statePath }
}

async function main(): Promise<void> {
  resetSprintEngineAutomationRevisions()

  const { workspaceId, statePath } = addSprintWorkspace('Automation Sync', '/repo/sync')

  const dispose = initSprintEngineAutomationModeSync()
  await settle()

  // Hydration: no sidecar yet -> seeds main with the local (default manual) mode.
  assert.equal(fakeApi.hydrateCalls.length, 1, 'one hydration per statePath per session')
  assert.deepEqual(fakeApi.hydrateCalls[0], { statePath, mode: 'manual' })
  assert.equal(fakeApi.pushCalls.length, 0, 'hydration never routes through set-mode')

  const workspace = () =>
    useWorkspaceStore.getState().workspaces.find((ws) => ws.id === workspaceId)

  // Authoritative broadcast (e.g. the phone) applies through the reducer…
  fakeApi.broadcast({ statePath, record: record('run_agents', 2) })
  assert.equal(workspace()?.sprintEngineAutoState?.desiredMode, 'run_agents')
  assert.equal(workspace()?.sprintEngineAutoState?.runtimeState, 'running')
  // …and never echoes back to main.
  await settle()
  assert.equal(fakeApi.pushCalls.length, 0, 'adopting a broadcast must not push back to main')

  // Stale + duplicate revisions are dropped.
  fakeApi.broadcast({ statePath, record: record('manual', 1) })
  fakeApi.broadcast({ statePath, record: record('manual', 2) })
  assert.equal(workspace()?.sprintEngineAutoState?.desiredMode, 'run_agents')

  // Same-mode broadcast with a newer revision must not disturb runtime state:
  // a paused run stays paused (re-applying user_set_mode would restart it).
  useWorkspaceStore.getState().applySprintEngineAutomationEvent(workspaceId, {
    type: 'runner_paused',
    reason: 'terminal_closed',
    message: 'An agent terminal was closed.',
  })
  assert.equal(workspace()?.sprintEngineAutoState?.runtimeState, 'paused')
  fakeApi.broadcast({ statePath, record: record('run_agents', 3) })
  assert.equal(workspace()?.sprintEngineAutoState?.runtimeState, 'paused',
    'same-mode broadcast is a revision-only no-op')

  // ── Echo ordering (review finding 1): the broadcast echo of a local push is
  // delivered BEFORE the push response resolves, and carries our clientToken.
  // A rapid double-toggle must not transiently revert the final mode.
  useWorkspaceStore.getState().setSprintEngineAutomationMode(workspaceId, 'manual')
  useWorkspaceStore.getState().setSprintEngineAutomationMode(workspaceId, 'run_agents')
  await settle()
  assert.equal(workspace()?.sprintEngineAutoState?.desiredMode, 'run_agents',
    'echoes of both pushes were dropped by client token; final mode is the second toggle')
  assert.equal(fakeApi.pushCalls.length, 2)
  assert.ok(fakeApi.pushCalls.every((call) => typeof call.clientToken === 'string' && call.clientToken),
    'every push carries the window client token')

  // ── Cross-writer broadcast racing an outstanding local push is deferred and
  // superseded by the push response (main serializes; ours is newer).
  fakeApi.holdPushResponses = true
  useWorkspaceStore.getState().setSprintEngineAutomationMode(workspaceId, 'manual')
  await settle()
  // A phone write's broadcast arrives while our push response is held.
  fakeApi.broadcast({ statePath, record: record('run_agents_and_approve_artifacts', 9000) })
  assert.equal(workspace()?.sprintEngineAutoState?.desiredMode, 'manual',
    'cross-writer broadcast is deferred while a local push is outstanding')
  fakeApi.holdPushResponses = false
  fakeApi.releaseHeldPushes()
  await settle()
  assert.equal(workspace()?.sprintEngineAutoState?.desiredMode, 'manual',
    'push response reconciliation keeps the locally-pushed value (it is newest)')

  // A later cross-writer broadcast with a higher revision flips the mode.
  const currentRevision = fakeApi.records.get(statePath)?.revision ?? 0
  fakeApi.broadcast({ statePath, record: record('run_agents', currentRevision + 1) })
  assert.equal(workspace()?.sprintEngineAutoState?.desiredMode, 'run_agents')
  await settle()
  assert.equal(fakeApi.pushCalls.length, 3, 'adoption still never echoes')

  // ── Late workspace (review finding 2): a broadcast for a statePath whose
  // workspace has not materialized yet must reconcile once it exists. The
  // statePath the store will derive for a name is deterministic, so a
  // broadcast can be delivered for it before the workspace is added.
  const probe = addSprintWorkspace('Late Sync', '/repo/late')
  useWorkspaceStore.getState().removeWorkspace(probe.workspaceId)
  const lateStatePath = probe.statePath
  fakeApi.records.set(lateStatePath, record('run_agents', 5))
  fakeApi.broadcast({ statePath: lateStatePath, record: record('run_agents', 5) })
  const late = addSprintWorkspace('Late Sync', '/repo/late')
  assert.equal(late.statePath, lateStatePath, 'fixture statePath is deterministic')
  await settle()
  const lateWorkspace = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === late.workspaceId)
  assert.equal(lateWorkspace?.sprintEngineAutoState?.desiredMode, 'run_agents',
    'stashed broadcast applies when the workspace materializes')

  // ── Hydration retry (review finding 3): a failed read is retried on a later
  // sweep instead of being marked hydrated forever.
  fakeApi.failReads = true
  const retry = addSprintWorkspace('Retry Sync', '/repo/retry')
  await settle()
  assert.ok(!fakeApi.hydrateCalls.some((call) => call.statePath === retry.statePath),
    'no hydrate while reads fail')
  fakeApi.failReads = false
  // Any store change re-runs the sweep.
  useWorkspaceStore.getState().setSprintEngineMaxConcurrentAgents(retry.workspaceId, 2)
  await settle()
  assert.ok(fakeApi.hydrateCalls.some((call) => call.statePath === retry.statePath),
    'hydration retried after the read succeeds')

  // ── The CLI permission preset rides the same record (MC-1799). It is written
  // by statePath — the Sprints door has no workspace to write through — but it
  // is READ at spawn from the workspace record (`buildRegistration`), so a
  // workspace attaching after a door write must pick it up or the door's control
  // sets a preset nothing ever spawns with.
  // Reads fail for the probe so its statePath is never marked hydrated — the
  // re-added workspace then takes the real first-attach path.
  fakeApi.failReads = true
  const presetRun = addSprintWorkspace('Preset Sync', '/repo/preset')
  await settle()
  useWorkspaceStore.getState().removeWorkspace(presetRun.workspaceId)
  fakeApi.failReads = false
  fakeApi.records.set(presetRun.statePath, {
    ...record('run_agents', 12),
    cliPermissionPreset: 'bypass',
  })
  const attached = addSprintWorkspace('Preset Sync', '/repo/preset')
  assert.equal(attached.statePath, presetRun.statePath, 'fixture statePath is deterministic')
  await settle()
  const attachedWorkspace = () =>
    useWorkspaceStore.getState().workspaces.find((ws) => ws.id === attached.workspaceId)
  assert.equal(attachedWorkspace()?.sprintEngineAutoState?.cliPermissionPreset, 'bypass',
    'a workspace attaching later adopts the preset the door persisted')
  assert.equal(attachedWorkspace()?.sprintEngineAutoState?.desiredMode, 'run_agents',
    'the mode on the same record still lands')

  // A preset change from another writer arrives as a same-mode broadcast — the
  // shape the mode's own early return drops — and must still be adopted.
  fakeApi.broadcast({
    statePath: attached.statePath,
    record: { ...record('run_agents', 13), cliPermissionPreset: 'auto' },
  })
  await settle()
  assert.equal(attachedWorkspace()?.sprintEngineAutoState?.cliPermissionPreset, 'auto',
    'a same-mode record that only moves the preset is still adopted')
  assert.ok(
    fakeApi.presetPushCalls.every((call) => call.statePath === attached.statePath),
    'adoption only ever writes back the run it adopted',
  )
  assert.equal(attachedWorkspace()?.sprintEngineAutoState?.cliPermissionPreset, 'auto',
    'and the echo of that write-back settles rather than ping-ponging')

  // A record with no preset (every one written before MC-1799) leaves the
  // workspace's own value alone rather than resetting it to the default.
  fakeApi.broadcast({ statePath: attached.statePath, record: record('manual', 14) })
  await settle()
  assert.equal(attachedWorkspace()?.sprintEngineAutoState?.cliPermissionPreset, 'auto',
    'an absent preset means "never set", not "default"')

  dispose()
  console.log('sprintengine automation-mode-sync tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
