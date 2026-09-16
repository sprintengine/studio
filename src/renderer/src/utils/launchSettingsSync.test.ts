/**
 * MC-2154 — the renderer half of the main-owned launch settings store: the
 * push must carry every input main composes a launch from, and a settings
 * change must reach main without a restart.
 */
import assert from 'node:assert/strict'
import type { AgentLaunchSettings } from '../../../shared/launch-settings'

type FakeApi = {
  hydrateCalls: AgentLaunchSettings[]
  pushCalls: AgentLaunchSettings[]
}

function installFakeApi(): FakeApi {
  const fake: FakeApi = { hydrateCalls: [], pushCalls: [] }
  let revision = 0
  const ack = (settings: AgentLaunchSettings): Promise<unknown> => Promise.resolve({
    ok: true as const,
    record: {
      schemaVersion: 1 as const,
      revision: ++revision,
      settings,
      changedAt: revision,
      lastWrite: { actor: 'ui' as const, at: '' },
    },
    changed: true,
  })
  const api = {
    hydrateAgentLaunchSettings: (settings: AgentLaunchSettings) => {
      fake.hydrateCalls.push(settings)
      return ack(settings)
    },
    syncAgentLaunchSettings: (settings: AgentLaunchSettings) => {
      fake.pushCalls.push(settings)
      return ack(settings)
    },
  }
  ;(globalThis as { window?: unknown }).window = { api }
  return fake
}

const fakeApi = installFakeApi()

// Imported AFTER the fake window is installed.
import { useWorkspaceStore } from '../store/workspaceStore'
import { initLaunchSettingsSync } from './launchSettingsSync'

function main(): void {
  const dispose = initLaunchSettingsSync()
  try {
    assertMountSeedsAndPushesEveryLaunchInput()
    assertSettingsChangesReachMainWithoutRestart()
    assertUnchangedStoreWritesDoNotPush()
  } finally {
    dispose()
  }
  console.log('launch-settings-sync tests passed')
}

// (1) Mount seeds main's store once and pushes the whole launch surface — a
// field missing here is a field main has to guess at with no window open.
function assertMountSeedsAndPushesEveryLaunchInput(): void {
  assert.equal(fakeApi.hydrateCalls.length, 1, 'the store is seeded exactly once per mount')
  assert.equal(fakeApi.pushCalls.length, 1)
  const pushed = fakeApi.pushCalls[0]
  assert.ok(pushed)
  assert.deepEqual(
    Object.keys(pushed).sort(),
    [
      'cliRuntimes',
      'lastAgentSpawnPermissionPreset',
      'lastSelectedCli',
      'mcp',
      'projectKnowledgeRoots',
    ],
  )
}

// (2) The acceptance case: a setting changed in the UI is in main's next read,
// no restart involved.
function assertSettingsChangesReachMainWithoutRestart(): void {
  useWorkspaceStore.getState().setLastSelectedCli('codex')
  const latest = fakeApi.pushCalls.at(-1)
  assert.equal(fakeApi.pushCalls.length, 2)
  assert.equal(latest?.lastSelectedCli, 'codex')

  useWorkspaceStore.getState().setLastAgentSpawnPermissionPreset('manual')
  assert.equal(fakeApi.pushCalls.length, 3)
  assert.equal(fakeApi.pushCalls.at(-1)?.lastAgentSpawnPermissionPreset, 'manual')
}

// (3) The store notifies on every change; only launch-relevant ones push, or
// main's file would churn (and bump revisions) on unrelated UI state.
function assertUnchangedStoreWritesDoNotPush(): void {
  const before = fakeApi.pushCalls.length
  useWorkspaceStore.getState().setLastSelectedCli('codex')
  useWorkspaceStore.getState().setSidebarCollapsed(true)
  assert.equal(fakeApi.pushCalls.length, before, 'an unchanged launch surface is not re-pushed')
}

main()
