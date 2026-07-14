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
import { sprintEngineRunSettingsKey } from './settingsSlice'

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
  { expandedPaths: [], selectedPath: null },
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
  workspaces: Array<{ fileExplorerState: { expandedPaths: string[]; selectedPath: string | null } }>
}
assert.deepEqual(
  migratedExplorerState.workspaces[0].fileExplorerState,
  { expandedPaths: ['/repo/src'], selectedPath: null },
  'migration normalizes persisted File Explorer expansion paths',
)

const v60SprintEnginePermissionState = {
  appSettings: {
    lastAgentSpawnPermissionPreset: 'bypass_all',
  },
  workspaces: [
    {
      id: 'ws-run-permission',
      name: 'Run Permission',
      mode: 'sprintengine',
      folderPath: '/repo',
      agents: {},
      sprintEngineContext: {
        teamName: 'run-permission',
        teamSlug: 'run-permission',
        teamDirectoryPath: '/repo/.multi-code/sprintengine/run-permission',
        statePath: '/repo/.multi-code/sprintengine/run-permission/run.yaml',
      },
      sprintEngineState: {
        name: 'run-permission',
        goal: 'Persist local run permission defaults.',
        roleCounts: { architect: 1 },
        sprintEngineAgents: {
          architect: { role: 'architect', status: 'idle', currentTaskId: null },
        },
      },
      sprintEngineAutoState: {
        desiredMode: 'manual',
        runtimeState: 'idle',
        cliPermissionPreset: 'default',
        maxConcurrentAgents: 3,
        pendingSpawns: [],
        deliveredAgentNotificationEventKeys: [],
      },
    },
  ],
}
const migratedSprintEnginePermission = migratePersistedWorkspaceState(v60SprintEnginePermissionState, 60) as {
  appSettings: {
    sprintEngineRunSettings: Record<string, { cliPermissionPreset?: string }>
  }
  workspaces: Array<{
    sprintEngineContext: { statePath: string }
    sprintEngineAutoState: { cliPermissionPreset: string }
  }>
}
const migratedSprintEnginePermissionKey = sprintEngineRunSettingsKey(
  migratedSprintEnginePermission.workspaces[0].sprintEngineContext.statePath,
)
assert.equal(
  migratedSprintEnginePermission.appSettings.sprintEngineRunSettings[migratedSprintEnginePermissionKey]
    ?.cliPermissionPreset,
  'bypass_all',
  'v61 migration seeds per-run Sprint Engine permission from the app default when the run was still factory-default',
)
assert.equal(
  migratedSprintEnginePermission.workspaces[0].sprintEngineAutoState.cliPermissionPreset,
  'bypass_all',
  'v61 migration hydrates existing Sprint Engine workspaces from the local per-run setting',
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
// The v57 migration clears the launch/resume gate so a restart never auto-resumes
// a sprint agent — but it keeps the session identity, which resolves the agent's
// painted screen on disk. Erasing it made cold load mint a fresh uuid and spawn a
// fresh CLI instead of painting paused.
assert.equal(migratedArchitect.cliSessionId, 'stale-architect-session')
assert.equal(migratedArchitect.cliOnboardingPromptSent, false)
assert.equal(migratedArchitect.cliResumeAvailable, false)
assert.equal(migratedArchitect.cliStartupPrompt, undefined)
assert.equal(migratedArchitect.cliRestartNonce, 0)
assert.equal(migratedArchitect.status, 'idle')
assert.equal(migratedArchitect.streamBuffer, '')

// v62: Automations became a global screen, not a workspace type. The migration
// drops persisted automations workspaces (their definitions/run history live on
// disk, untouched) while leaving every other workspace in place.
const v61AutomationsState = {
  workspaces: [
    { id: 'ws-standard', mode: 'standard', folderPath: '/repo/app', agents: {} },
    { id: 'ws-automations', mode: 'automations', folderPath: '/repo/app', agents: {} },
    { id: 'ws-sprint', mode: 'sprintengine', folderPath: '/repo/app', agents: {} },
  ],
  activeWorkspaceId: 'ws-automations',
}
const migratedAutomationsDrop = migratePersistedWorkspaceState(v61AutomationsState, 61) as {
  workspaces: Array<{ id: string; mode: string }>
  activeWorkspaceId: string | null
}
assert.deepEqual(
  migratedAutomationsDrop.workspaces.map((ws) => ws.id),
  ['ws-standard', 'ws-sprint'],
  'v62 drops automations workspaces and keeps the rest',
)
assert.equal(
  migratedAutomationsDrop.workspaces.some((ws) => ws.mode === 'automations'),
  false,
  'no automations workspace survives the migration',
)
// The active pointer was the dropped automations workspace — it must not dangle.
assert.equal(
  migratedAutomationsDrop.activeWorkspaceId,
  'ws-standard',
  'v62 reconciles a dangling active pointer to a surviving workspace',
)

// An account whose ONLY workspace was an automations workspace migrates to an
// empty list with a null active pointer (the dangerous-empty recovery path then
// honors that, and the backup-recovery filter keeps the on-disk copy clean).
const v61AutomationsOnly = {
  workspaces: [{ id: 'ws-automations', mode: 'automations', folderPath: '/repo/app', agents: {} }],
  activeWorkspaceId: 'ws-automations',
}
const migratedAutomationsOnly = migratePersistedWorkspaceState(v61AutomationsOnly, 61) as {
  workspaces: unknown[]
  activeWorkspaceId: string | null
}
assert.equal(migratedAutomationsOnly.workspaces.length, 0, 'automations-only account migrates to an empty list')
assert.equal(migratedAutomationsOnly.activeWorkspaceId, null, 'active pointer is cleared when nothing survives')

// v63: before the sync bus persisted workspace modes, each app restart's first
// automation run minted a duplicate per-project host. The migration keeps the
// earliest-created host per folder (normalized key: slashes, trailing slash,
// case) and drops the duplicates; hosts for other folders and non-host
// workspaces are untouched.
const v62DuplicateHostsState = {
  workspaces: [
    { id: 'ws-standard', mode: 'standard', folderPath: '/repo/app', agents: {}, createdAt: 1 },
    { id: 'ws-host-original', mode: 'automations-host', folderPath: '/repo/app', agents: {}, createdAt: 10 },
    { id: 'ws-host-dup-1', mode: 'automations-host', folderPath: '/repo/app/', agents: {}, createdAt: 20 },
    { id: 'ws-host-dup-2', mode: 'automations-host', folderPath: '/REPO/app', agents: {}, createdAt: 30 },
    { id: 'ws-host-other', mode: 'automations-host', folderPath: '/repo/other', agents: {}, createdAt: 40 },
    { id: 'ws-host-folderless', mode: 'automations-host', folderPath: null, agents: {}, createdAt: 50 },
  ],
  activeWorkspaceId: 'ws-host-dup-2',
}
const migratedHostDedup = migratePersistedWorkspaceState(v62DuplicateHostsState, 62) as {
  workspaces: Array<{ id: string; mode: string }>
  activeWorkspaceId: string | null
}
assert.deepEqual(
  migratedHostDedup.workspaces.map((ws) => ws.id),
  ['ws-standard', 'ws-host-original', 'ws-host-other', 'ws-host-folderless'],
  'v63 keeps the earliest host per folder and every non-duplicate workspace',
)
assert.equal(
  migratedHostDedup.activeWorkspaceId,
  'ws-standard',
  'v63 reconciles a dangling active pointer to a surviving workspace',
)

// v64: the v63 dedupe could be bypassed — backup recovery and cross-window
// storage sync adopt workspace lists without the migrate ladder, and the next
// persist write stamped the un-deduped state v63, so it never re-migrated.
// v64 re-runs the dedupe on state already stamped 63 and re-brands the kept
// host with the stable 'Automations' name.
const v63BypassedState = {
  workspaces: [
    { id: 'ws-host-run-a', mode: 'automations-host', name: 'Pillars of code reviewer', folderPath: '/repo/app', agents: {}, createdAt: 10 },
    { id: 'ws-host-run-b', mode: 'automations-host', name: 'Nightly performance reviewer', folderPath: '/repo/app', agents: {}, createdAt: 20 },
    { id: 'ws-host-run-c', mode: 'automations-host', name: 'fable5 calendar', folderPath: '/repo/app/', agents: {}, createdAt: 30 },
    { id: 'ws-standard', mode: 'standard', name: 'Chat', folderPath: '/repo/app', agents: {}, createdAt: 1 },
  ],
  activeWorkspaceId: 'ws-host-run-c',
}
const migratedV64 = migratePersistedWorkspaceState(v63BypassedState, 63) as {
  workspaces: Array<{ id: string; name: string }>
  activeWorkspaceId: string | null
}
assert.deepEqual(
  migratedV64.workspaces.map((ws) => ws.id),
  ['ws-host-run-a', 'ws-standard'],
  'v64 re-runs the host dedupe on state already stamped v63',
)
assert.equal(
  migratedV64.workspaces[0].name,
  'Automations',
  'v64 re-brands the surviving host with the stable surface name',
)
assert.equal(
  migratedV64.activeWorkspaceId,
  'ws-host-run-a',
  'v64 reconciles a dangling active pointer to a surviving workspace',
)

console.log('persistenceSlice.test.ts: ok')
