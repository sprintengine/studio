import assert from 'node:assert/strict'

import {
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_STORE_VERSION,
  classifyPersistedWorkspaceState,
  isDangerousEmptyClassification,
  migratePersistedWorkspaceState,
  nonEmptyPersistedWorkspaceState,
  readPersistedWorkspaceState,
} from './persistenceSlice'

// classifyPersistedWorkspaceState ----------------------------------------------

assert.equal(
  classifyPersistedWorkspaceState({ rawLocalStorage: null }),
  'dangerous_empty_missing_storage',
)
assert.equal(
  classifyPersistedWorkspaceState({ rawLocalStorage: 'not json {' }),
  'dangerous_empty_unreadable',
)
assert.equal(
  classifyPersistedWorkspaceState({
    rawLocalStorage: JSON.stringify({ state: 'not an object' }),
  }),
  'dangerous_empty_unreadable',
)
assert.equal(
  classifyPersistedWorkspaceState({
    rawLocalStorage: JSON.stringify({ state: { workspaces: [{ id: 'ws-1' }] } }),
  }),
  'present',
)
// Shape-only classifier: any empty workspaces envelope is dangerous regardless
// of companion fields. Intent lives in markValidEmptyWorkspaceIntent, not in
// the persisted state shape.
assert.equal(
  classifyPersistedWorkspaceState({
    rawLocalStorage: JSON.stringify({ state: { workspaces: [] } }),
  }),
  'dangerous_empty_no_workspaces',
)
assert.equal(
  classifyPersistedWorkspaceState({
    rawLocalStorage: JSON.stringify({
      state: { workspaces: [], appSettings: {}, sidebarCollapsed: false, activeWorkspaceId: null },
    }),
  }),
  'dangerous_empty_no_workspaces',
  'companion fields must NOT promote an empty envelope to valid; intent is the only signal',
)
assert.equal(
  classifyPersistedWorkspaceState({
    rawLocalStorage: JSON.stringify({ state: { appSettings: {} } }),
  }),
  'dangerous_empty_no_workspaces',
)

// isDangerousEmptyClassification ----------------------------------------------

assert.equal(isDangerousEmptyClassification('present'), false)
assert.equal(isDangerousEmptyClassification('dangerous_empty_missing_storage'), true)
assert.equal(isDangerousEmptyClassification('dangerous_empty_unreadable'), true)
assert.equal(isDangerousEmptyClassification('dangerous_empty_no_workspaces'), true)

// Intent is no longer a module-local flag — see workspaceRegistry.ts and the
// workspaceRegistryEmptyState field on WorkspacesSliceState. The T22 helpers
// (markValidEmptyWorkspaceIntent etc.) were removed in T23 when intent moved
// onto the persisted state shape itself.

// readPersistedWorkspaceState + nonEmptyPersistedWorkspaceState ---------------

const stored: Record<string, string> = {}
const fakeLocalStorage = {
  getItem: (key: string) => stored[key] ?? null,
  setItem: (key: string, value: string) => {
    stored[key] = value
  },
  removeItem: (key: string) => {
    delete stored[key]
  },
}
Object.defineProperty(globalThis, 'window', {
  value: { localStorage: fakeLocalStorage },
  configurable: true,
})

assert.equal(readPersistedWorkspaceState(), null)
assert.equal(nonEmptyPersistedWorkspaceState(), null)

stored[WORKSPACE_STORAGE_KEY] = JSON.stringify({
  state: { workspaces: [{ id: 'ws-1' }], activeWorkspaceId: 'ws-1' },
  version: WORKSPACE_STORE_VERSION,
})
const persisted = readPersistedWorkspaceState()
assert.ok(persisted)
assert.equal(persisted?.workspaces?.length, 1)
assert.equal((nonEmptyPersistedWorkspaceState()?.workspaces ?? []).length, 1)

stored[WORKSPACE_STORAGE_KEY] = JSON.stringify({ state: { workspaces: [] } })
assert.equal(nonEmptyPersistedWorkspaceState(), null)

// migratePersistedWorkspaceState ----------------------------------------------

// Null persisted state survives the migrator (no crash, no fabricated state).
assert.equal(migratePersistedWorkspaceState(undefined, 0), undefined)

// A v0 persisted state gets folderPath/editorState defaults via the v1 migration
// (skipping ahead to the latest version is the expected legacy upgrade path).
const v0State = {
  workspaces: [
    {
      id: 'ws-legacy',
      name: 'Legacy',
      mode: undefined,
      agents: {},
    },
  ],
}
const migrated = migratePersistedWorkspaceState(v0State, 0) as {
  workspaces: Array<{ folderPath: unknown; editorState: unknown; fileExplorerState: unknown; mode: unknown }>
}
assert.equal(migrated.workspaces.length, 1)
assert.equal(migrated.workspaces[0].folderPath, null)
assert.ok(migrated.workspaces[0].editorState, 'v1 migration backfills editorState')
assert.deepEqual(
  migrated.workspaces[0].fileExplorerState,
  { expandedPaths: [] },
  'migration backfills empty File Explorer expansion state',
)
assert.equal(migrated.workspaces[0].mode, 'standard')

const v58ExplorerState = {
  workspaces: [
    {
      id: 'ws-explorer',
      name: 'Explorer',
      mode: 'standard',
      folderPath: '/repo',
      agents: {},
      fileExplorerState: {
        expandedPaths: ['/repo/src', '/repo/src', '', 42],
      },
    },
  ],
}
const migratedExplorerState = migratePersistedWorkspaceState(v58ExplorerState, 58) as {
  workspaces: Array<{ fileExplorerState: { expandedPaths: string[] } }>
}
assert.deepEqual(
  migratedExplorerState.workspaces[0].fileExplorerState,
  { expandedPaths: ['/repo/src'] },
  'migration normalizes persisted File Explorer expansion paths',
)

const v52AutoRunState = {
  workspaces: [
    {
      id: 'ws-auto',
      name: 'Auto Run',
      mode: 'sprintengine',
      folderPath: '/repo',
      agents: {},
      sprintEngineAutoState: {
        supervisorEnabled: true,
        enabled: true,
        autoApproveArtifacts: true,
        keepDoneAgentTerminals: true,
        cliPermissionPreset: 'bypass_all',
        maxConcurrentAgents: 4,
        pendingSpawns: [{ taskId: 'T1', agentId: 'developer-1', startedAt: 1 }],
        deliveredAgentNotificationEventKeys: ['EVT-1'],
      },
    },
  ],
}
const migratedAutoRun = migratePersistedWorkspaceState(v52AutoRunState, 52) as {
  workspaces: Array<{
    sprintEngineAutoState: {
      desiredMode: string
      runtimeState: string
      keepDoneAgentTerminals: boolean
      cliPermissionPreset: string
      maxConcurrentAgents: number
      pendingSpawns: unknown[]
      deliveredAgentNotificationEventKeys: string[]
    }
  }>
}
assert.equal(
  'supervisorEnabled' in migratedAutoRun.workspaces[0].sprintEngineAutoState,
  false,
)
assert.equal('enabled' in migratedAutoRun.workspaces[0].sprintEngineAutoState, false)
assert.equal(
  'autoApproveArtifacts' in migratedAutoRun.workspaces[0].sprintEngineAutoState,
  false,
)
assert.equal(migratedAutoRun.workspaces[0].sprintEngineAutoState.desiredMode, 'run_agents_and_approve_artifacts')
assert.equal(migratedAutoRun.workspaces[0].sprintEngineAutoState.runtimeState, 'running')
assert.deepEqual(migratedAutoRun.workspaces[0].sprintEngineAutoState.pendingSpawns, [])
assert.equal(migratedAutoRun.workspaces[0].sprintEngineAutoState.keepDoneAgentTerminals, true)
assert.equal(migratedAutoRun.workspaces[0].sprintEngineAutoState.cliPermissionPreset, 'bypass_all')
assert.equal(migratedAutoRun.workspaces[0].sprintEngineAutoState.maxConcurrentAgents, 4)
assert.deepEqual(migratedAutoRun.workspaces[0].sprintEngineAutoState.deliveredAgentNotificationEventKeys, ['EVT-1'])

const v56SprintEngineLaunchState = {
  workspaces: [
    {
      id: 'ws-sprintengine-launch',
      name: 'Sprint Engine Launch',
      mode: 'sprintengine',
      folderPath: '/repo',
      agents: {
        architect: {
          id: 'architect',
          name: 'Architect',
          kind: 'sprintengine',
          cli: 'claude-code',
          cliStartRequested: true,
          cliHasLaunched: true,
          cliSessionId: 'stale-architect-session',
          cliOnboardingPromptSent: true,
          cliResumeAvailable: true,
          cliStartupPrompt: 'stale prompt',
          cliRestartNonce: 3,
          status: 'streaming',
          streamBuffer: 'stale output',
        },
      },
      sprintEngineState: {
        sprintEngineAgents: {
          architect: { role: 'architect', status: 'idle', currentTaskId: null },
        },
      },
    },
  ],
}
const migratedSprintEngineLaunch = migratePersistedWorkspaceState(v56SprintEngineLaunchState, 56) as {
  workspaces: Array<{
    agents: Record<string, {
      kind: string
      cliStartRequested: boolean
      cliHasLaunched: boolean
      cliSessionId?: string
      cliOnboardingPromptSent: boolean
      cliResumeAvailable: boolean
      cliStartupPrompt?: string
      cliRestartNonce: number
      status: string
      streamBuffer: string
    }>
    sprintEngineState: { sprintEngineAgents: Record<string, unknown> }
  }>
}
const migratedArchitect = migratedSprintEngineLaunch.workspaces[0].agents.architect
assert.ok(migratedSprintEngineLaunch.workspaces[0].sprintEngineState.sprintEngineAgents.architect)
assert.equal(migratedArchitect.kind, 'sprintengine')
assert.equal(migratedArchitect.cliStartRequested, false)
assert.equal(migratedArchitect.cliHasLaunched, false)
assert.equal(migratedArchitect.cliSessionId, undefined)
assert.equal(migratedArchitect.cliOnboardingPromptSent, false)
assert.equal(migratedArchitect.cliResumeAvailable, false)
assert.equal(migratedArchitect.cliStartupPrompt, undefined)
assert.equal(migratedArchitect.cliRestartNonce, 0)
assert.equal(migratedArchitect.status, 'idle')
assert.equal(migratedArchitect.streamBuffer, '')

console.log('persistenceSlice.test.ts: ok')
