import assert from 'node:assert/strict'
import type { SprintEngineAutomationChangedEvent } from '../../../shared/electron-api'
import type { SprintEngineAutomationIntentRecord } from '../../../shared/sprintengine/automation-intent'
import type { LayoutTemplate, SprintEngineAutomationMode } from '../types/workspace'
import { createInitialSprintEngineState } from './sprintengine'

// ── Fake preload API (installed before the modules under test are imported so
// the client sees `window.api` at call time; node has no `window`).
type FakeApi = {
  hydrateCalls: Array<{ statePath: string; mode: SprintEngineAutomationMode }>
  pushCalls: Array<{ statePath: string; mode: SprintEngineAutomationMode }>
  records: Map<string, SprintEngineAutomationIntentRecord>
  broadcast: (event: SprintEngineAutomationChangedEvent) => void
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
  const fake: FakeApi = {
    hydrateCalls: [],
    pushCalls: [],
    records: new Map(),
    broadcast: () => undefined,
  }
  let nextRevision = 100
  const api = {
    readSprintEngineAutomationMode: async ({ statePath }: { statePath: string }) => ({
      ok: true as const,
      record: fake.records.get(statePath) ?? null,
    }),
    hydrateSprintEngineAutomationMode: async ({ statePath, mode }: { statePath: string; mode: SprintEngineAutomationMode }) => {
      fake.hydrateCalls.push({ statePath, mode })
      const existing = fake.records.get(statePath)
      if (existing) return { ok: true as const, record: existing, changed: false }
      const created = record(mode, 1)
      fake.records.set(statePath, created)
      return { ok: true as const, record: created, changed: true }
    },
    setSprintEngineAutomationMode: async ({ statePath, mode }: { statePath: string; mode: SprintEngineAutomationMode }) => {
      fake.pushCalls.push({ statePath, mode })
      const created = record(mode, nextRevision++)
      fake.records.set(statePath, created)
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

// Imported AFTER the fake window is installed (module init reads nothing, but
// keep the ordering obvious).
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

async function main(): Promise<void> {
  resetSprintEngineAutomationRevisions()

  const statePath = '/repo/sync/.multi-code/sprintengine/sync-team/run.yaml'
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, {
    name: 'Automation Sync',
    folderPath: '/repo/sync',
  })
  useWorkspaceStore.getState().setSprintEngineContext(workspaceId, {
    teamName: 'Sync Team',
    teamSlug: 'sync-team',
    teamDirectoryPath: '/repo/sync/.multi-code/sprintengine/sync-team',
    statePath,
  })
  useWorkspaceStore.getState().setSprintEngineState(
    workspaceId,
    createInitialSprintEngineState({
      goal: 'Validate automation-mode sync',
      name: 'Sync Team',
      roleCounts: { architect: 1 },
    })
  )

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

  // A local user write still pushes to main exactly once.
  useWorkspaceStore.getState().setSprintEngineAutomationMode(workspaceId, 'run_agents_and_approve_artifacts')
  await settle()
  assert.deepEqual(fakeApi.pushCalls, [{ statePath, mode: 'run_agents_and_approve_artifacts' }])

  // The echo of that push (broadcast with the same revision main returned) is
  // dropped by the revision guard.
  const pushedRevision = fakeApi.records.get(statePath)?.revision ?? 0
  fakeApi.broadcast({ statePath, record: record('run_agents_and_approve_artifacts', pushedRevision) })
  assert.equal(workspace()?.sprintEngineAutoState?.desiredMode, 'run_agents_and_approve_artifacts')
  assert.equal(fakeApi.pushCalls.length, 1)

  // A cross-writer broadcast with a higher revision flips the mode.
  fakeApi.broadcast({ statePath, record: record('manual', pushedRevision + 1) })
  assert.equal(workspace()?.sprintEngineAutoState?.desiredMode, 'manual')
  assert.equal(workspace()?.sprintEngineAutoState?.runtimeState, 'idle')
  await settle()
  assert.equal(fakeApi.pushCalls.length, 1, 'adoption still never echoes')

  dispose()
  console.log('sprintengine automation-mode-sync tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
