import assert from 'node:assert/strict'

import type { AgentState, Workspace } from '../types/workspace'
import type { WorkspaceBackupPayload } from '../../../shared/electron-api'
import { defaultAuthState } from './slices/authSlice'

type RegistryRecord = {
  state: {
    workspaces: Workspace[]
    activeWorkspaceId: string | null
    workspaceRegistryEmptyState: { reason: 'user_removed_all'; updatedAt: string } | null
  }
  version: number
}

type SettingsRecord = {
  state: {
    appSettings?: unknown
    sidebarCollapsed?: boolean
  }
  version: number
}

const persistedWorkspace = {
  id: 'ws-retained',
  name: 'Retained Workspace',
  folderPath: '/Users/example/project',
  agents: {
    'agent-1': {
      id: 'agent-1',
      name: 'Test Agent',
      kind: 'general',
      status: 'idle',
      streamBuffer: '',
      cliSessionId: undefined,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliResumeAvailable: false,
      cliRestartNonce: 0,
      cliOnboardingPromptSent: false,
    },
  },
} as unknown as Workspace

// Seed the v44 single-key envelope to verify the legacy split on cold-load.
// The custom storage adapter must read this, split out the settings portion
// to multicode-app-settings, leave multicode-workspaces as registry-only, and
// surface a hydrated store with both halves.
const stored: Record<string, string> = {
  'multicode-workspaces': JSON.stringify({
    state: {
      appSettings: {},
      sidebarCollapsed: true,
      workspaces: [persistedWorkspace],
      activeWorkspaceId: persistedWorkspace.id,
    },
    version: 44,
  }),
}

const localStorageMock = {
  getItem: (key: string) => stored[key] ?? null,
  setItem: (key: string, value: string) => {
    stored[key] = value
  },
  removeItem: (key: string) => {
    delete stored[key]
  },
}

type WorkspaceBackupApi = {
  workspaceBackupRead: () => Promise<
    | { ok: true; payload: WorkspaceBackupPayload }
    | { ok: false; reason: 'missing' | 'unreadable' | 'parse_error'; message?: string }
  >
  workspaceBackupWrite: (payload: WorkspaceBackupPayload) => Promise<{ ok: boolean; message?: string }>
}

const backupWriteCalls: WorkspaceBackupPayload[] = []
let backupReadResponse: Awaited<ReturnType<WorkspaceBackupApi['workspaceBackupRead']>> = {
  ok: false,
  reason: 'missing',
}

const workspaceBackupApi: WorkspaceBackupApi = {
  workspaceBackupRead: async () => backupReadResponse,
  workspaceBackupWrite: async (payload) => {
    backupWriteCalls.push(payload)
    return { ok: true }
  },
}

type DiagnosticEntry = { message: string; payload: unknown }
const diagnosticLog: DiagnosticEntry[] = []
const originalInfo = console.info.bind(console)
console.info = ((...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0] === '[workspaceStore] hydration') {
    diagnosticLog.push({ message: args[0], payload: args[1] })
  }
  originalInfo(...(args as Parameters<typeof originalInfo>))
}) as typeof console.info

Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: localStorageMock,
    api: workspaceBackupApi,
  },
  configurable: true,
})
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
})

const {
  useWorkspaceStore,
  __workspaceStoreBackupRecoveryPromise,
  __workspaceStoreRunBackupRecoveryForTests,
} = await import('./workspaceStore')

await __workspaceStoreBackupRecoveryPromise

// ── CASE 1 ──────────────────────────────────────────────────────────────────
// Legacy v44 split + cold-load. The seeded envelope has appSettings AND
// workspaces in one key; the custom storage adapter must split them.
// localStorage 'multicode-app-settings' is now seeded; 'multicode-workspaces'
// still contains the legacy shape until the next setItem rewrites it.
assert.ok(stored['multicode-app-settings'], 'legacy split extracted settings to its own key')
const splitSettings = JSON.parse(stored['multicode-app-settings']) as SettingsRecord
assert.equal(splitSettings.state.sidebarCollapsed, true, 'legacy sidebarCollapsed migrated to app-settings key')

assert.equal(diagnosticLog.length, 1, 'exactly one hydration diagnostic per cold-load')
const coldLoadDiag = diagnosticLog[0].payload as {
  storageSource: string
  classification: string
  hydratedWorkspaceCount: number
}
assert.equal(coldLoadDiag.storageSource, 'localStorage')
assert.equal(coldLoadDiag.classification, 'present')
assert.equal(coldLoadDiag.hydratedWorkspaceCount, 1)

// Trigger a workspace mutation to force the storage adapter to write the
// v45 registry-only shape into multicode-workspaces.
useWorkspaceStore.getState().renameWorkspace(persistedWorkspace.id, 'Retained Workspace')
await new Promise<void>((resolve) => setTimeout(resolve, 50))
const newRegistry = JSON.parse(stored['multicode-workspaces']) as RegistryRecord
assert.equal(newRegistry.state.workspaces.length, 1)
assert.equal((newRegistry.state as unknown as { appSettings?: unknown }).appSettings, undefined,
  'registry envelope no longer carries appSettings after migration')

// ── CASE 2 ──────────────────────────────────────────────────────────────────
// Non-workspace writes must not touch multicode-workspaces. The construction-
// time guarantee is enforced by dedup: settings-only changes produce an
// identical registry payload, so the registry localStorage key is left exactly
// as it was. Agent resume identity is durable state, so launch reconciliation
// is tested separately below and is allowed to rewrite the registry.
const settingsRawBefore = stored['multicode-app-settings']

// Pre-seed an agent into the live store so reconcileWorkspaceAgentLaunchFlags
// has something real to mutate. Durable resume fields (cliStartRequested,
// cliHasLaunched, cliSessionId, cliResumeAvailable) must reach the registry so
// app restart can resume the same agent tab/conversation. cliRestartNonce is
// still transient and is stripped by normalizeWorkspaceForPartialize.
useWorkspaceStore.setState((current) => ({
  ...current,
  workspaces: current.workspaces.map((ws) => {
    const agent = ws.agents['agent-1'] as AgentState
    return {
      ...ws,
      agents: {
        ...ws.agents,
        'agent-1': {
          ...agent,
          cliStartRequested: true,
          cliHasLaunched: true,
          cliSessionId: 'session-stale',
          cliResumeAvailable: true,
          cliRestartNonce: 7,
        },
      },
    }
  }),
}))
const registryRawBefore = stored['multicode-workspaces']
const registryWithResumeState = JSON.parse(registryRawBefore) as RegistryRecord
const persistedAgentBeforeReconcile = registryWithResumeState.state.workspaces[0]?.agents['agent-1'] as
  | Partial<AgentState>
  | undefined
assert.equal(persistedAgentBeforeReconcile?.cliStartRequested, true)
assert.equal(persistedAgentBeforeReconcile?.cliHasLaunched, true)
assert.equal(persistedAgentBeforeReconcile?.cliSessionId, 'session-stale')
assert.equal(persistedAgentBeforeReconcile?.cliResumeAvailable, true)
assert.equal(persistedAgentBeforeReconcile?.cliRestartNonce, 0)

const startupWriteSurfaces: Array<{ label: string; mutate: () => void }> = [
  {
    label: 'setSidebarCollapsed',
    mutate: () => useWorkspaceStore.getState().setSidebarCollapsed(false),
  },
  {
    label: 'setAuthState',
    mutate: () => useWorkspaceStore.getState().setAuthState({
      ...defaultAuthState(),
      status: 'signed_in',
      authenticated: true,
      message: 'startup auth refresh',
    }),
  },
  {
    label: 'markLearningTipSeen',
    mutate: () => useWorkspaceStore.getState().markLearningTipSeen('any-tip'),
  },
]

for (const surface of startupWriteSurfaces) {
  surface.mutate()
  assert.equal(
    stored['multicode-workspaces'],
    registryRawBefore,
    `${surface.label} must NOT touch the multicode-workspaces key (by-construction guarantee)`,
  )
}

useWorkspaceStore.getState().reconcileWorkspaceAgentLaunchFlags([])

// Sanity: reconciliation preserves resumable launched agents. This is the
// durable app-restart contract for Claude's stable session id and Codex's
// `codex resume` path.
const liveAgentAfter = useWorkspaceStore.getState().workspaces[0]?.agents['agent-1'] as
  | { cliStartRequested: boolean; cliHasLaunched: boolean; cliSessionId: string | undefined; cliResumeAvailable: boolean }
  | undefined
assert.ok(liveAgentAfter, 'agent-1 should still be in the live store')
assert.equal(liveAgentAfter!.cliStartRequested, true, 'reconciliation preserved cliStartRequested in memory')
assert.equal(liveAgentAfter!.cliHasLaunched, true, 'reconciliation preserved cliHasLaunched in memory')
assert.equal(liveAgentAfter!.cliSessionId, 'session-stale', 'reconciliation preserved cliSessionId in memory')
assert.equal(liveAgentAfter!.cliResumeAvailable, true, 'reconciliation preserved cliResumeAvailable in memory')

const registryAfterReconcile = JSON.parse(stored['multicode-workspaces']) as RegistryRecord
const persistedAgentAfterReconcile = registryAfterReconcile.state.workspaces[0]?.agents['agent-1'] as
  | Partial<AgentState>
  | undefined
assert.equal(persistedAgentAfterReconcile?.cliStartRequested, true)
assert.equal(persistedAgentAfterReconcile?.cliHasLaunched, true)
assert.equal(persistedAgentAfterReconcile?.cliSessionId, 'session-stale')
assert.equal(persistedAgentAfterReconcile?.cliResumeAvailable, true)

// Settings-touching surfaces DID rewrite the settings key.
assert.notEqual(
  stored['multicode-app-settings'],
  settingsRawBefore,
  'a settings-touching surface should rewrite the multicode-app-settings key',
)

// ── CASE 3 ──────────────────────────────────────────────────────────────────
// Backup mirror fires for non-empty registry writes only.
await new Promise<void>((resolve) => setTimeout(resolve, 350))
const nonEmptyBackupCalls = backupWriteCalls.length
assert.ok(nonEmptyBackupCalls > 0, 'backup write IPC fires for non-empty registry writes')
const lastBackup = backupWriteCalls[backupWriteCalls.length - 1]
const lastBackupParsed = typeof lastBackup.data === 'string'
  ? (JSON.parse(lastBackup.data) as RegistryRecord)
  : (lastBackup.data as RegistryRecord)
assert.equal(lastBackupParsed.state.workspaces[0]?.id, persistedWorkspace.id)
assert.equal(
  (lastBackupParsed.state as unknown as { appSettings?: unknown }).appSettings,
  undefined,
  'backup payload is registry-only (no appSettings)',
)

// ── CASE 4 ──────────────────────────────────────────────────────────────────
// Explicit clear-all: removeWorkspace on the last workspace sets the
// workspaceRegistryEmptyState record and persists it. The registry key now
// contains the empty + intent record; the backup is NOT mirrored (AC4: backup
// stays out of intent decisions).
const backupCallsBeforeClear = backupWriteCalls.length
useWorkspaceStore.getState().removeWorkspace(persistedWorkspace.id)
await new Promise<void>((resolve) => setTimeout(resolve, 350))

const afterClear = JSON.parse(stored['multicode-workspaces']) as RegistryRecord
assert.equal(afterClear.state.workspaces.length, 0)
assert.equal(afterClear.state.activeWorkspaceId, null)
assert.ok(afterClear.state.workspaceRegistryEmptyState, 'explicit empty intent record was persisted')
assert.equal(afterClear.state.workspaceRegistryEmptyState!.reason, 'user_removed_all')
assert.ok(
  typeof afterClear.state.workspaceRegistryEmptyState!.updatedAt === 'string'
    && afterClear.state.workspaceRegistryEmptyState!.updatedAt.length > 0,
  'updatedAt timestamp present',
)
assert.equal(
  backupWriteCalls.length,
  backupCallsBeforeClear,
  'backup is NOT mirrored on intentional-empty writes (AC4 — non-empty mirror only)',
)

// ── CASE 4b ─────────────────────────────────────────────────────────────────
// forgetFolder is the second explicit removal path that can leave workspaces=[].
// It must record the same intent record as removeWorkspace and must not be
// resurrected by recovery on reload.
useWorkspaceStore.setState({
  workspaces: [persistedWorkspace],
  activeWorkspaceId: persistedWorkspace.id,
  workspaceRegistryEmptyState: null,
})
await new Promise<void>((resolve) => setTimeout(resolve, 50))
useWorkspaceStore.getState().forgetFolder(persistedWorkspace.folderPath!)
await new Promise<void>((resolve) => setTimeout(resolve, 50))

const afterForget = JSON.parse(stored['multicode-workspaces']) as RegistryRecord
assert.equal(afterForget.state.workspaces.length, 0)
assert.ok(
  afterForget.state.workspaceRegistryEmptyState,
  'forgetFolder on the last workspace persists the intent record',
)
assert.equal(afterForget.state.workspaceRegistryEmptyState!.reason, 'user_removed_all')

// Reload simulation with the forgetFolder intent on disk: the recovery
// short-circuit must honor it just like the removeWorkspace path.
diagnosticLog.length = 0
backupReadResponse = {
  ok: true,
  payload: {
    version: 45,
    writtenAt: new Date().toISOString(),
    data: JSON.stringify({
      state: {
        workspaces: [persistedWorkspace],
        activeWorkspaceId: persistedWorkspace.id,
        workspaceRegistryEmptyState: null,
      },
      version: 45,
    } satisfies RegistryRecord),
  },
}
useWorkspaceStore.setState({
  workspaces: [],
  activeWorkspaceId: null,
  workspaceRegistryEmptyState: afterForget.state.workspaceRegistryEmptyState,
})
await __workspaceStoreRunBackupRecoveryForTests()
assert.equal(
  useWorkspaceStore.getState().workspaces.length,
  0,
  'forgetFolder intent survives reload — backup cannot resurrect',
)
assert.ok(
  useWorkspaceStore.getState().workspaceRegistryEmptyState,
  'forgetFolder intent record retained after reload',
)

// ── CASE 5 ──────────────────────────────────────────────────────────────────
// Intentional-empty registry survives a simulated reload. The recovery
// function sees workspaces=[] AND a non-null emptyState record; per the AC,
// recovery is gated on dangerous classifications only, so it stays a no-op.
diagnosticLog.length = 0
backupReadResponse = {
  ok: true,
  payload: {
    version: 45,
    writtenAt: new Date().toISOString(),
    data: JSON.stringify({
      state: {
        workspaces: [persistedWorkspace],
        activeWorkspaceId: persistedWorkspace.id,
        workspaceRegistryEmptyState: null,
      },
      version: 45,
    } satisfies RegistryRecord),
  },
}
useWorkspaceStore.setState({
  workspaces: [],
  activeWorkspaceId: null,
  workspaceRegistryEmptyState: { reason: 'user_removed_all', updatedAt: new Date().toISOString() },
})
await __workspaceStoreRunBackupRecoveryForTests()
assert.equal(
  useWorkspaceStore.getState().workspaces.length,
  0,
  'intentional empty is not resurrected from backup',
)
assert.ok(useWorkspaceStore.getState().workspaceRegistryEmptyState, 'intent record retained')
assert.equal(diagnosticLog.length, 1, 'exactly one diagnostic on the simulated reload')
const intentDiag = diagnosticLog[0].payload as { storageSource: string; classification: string }
// The persistenceSlice classifier still considers workspaces=[] dangerous;
// the intent record lives in the store state, not the localStorage shape.
// What matters for the AC is that recovery did not overwrite the intent
// state — verified above.
assert.ok(intentDiag.storageSource === 'fresh' || intentDiag.storageSource === 'localStorage')

// ── CASE 6 ──────────────────────────────────────────────────────────────────
// Backup recovery for truly dangerous empty (corrupt localStorage with no
// intent record): recovery rehydrates from backup and emits one final
// diagnostic with storageSource='backup'.
diagnosticLog.length = 0
useWorkspaceStore.setState({
  workspaces: [],
  activeWorkspaceId: null,
  workspaceRegistryEmptyState: null,
})
stored['multicode-workspaces'] = 'unreadable garbage {{{'
backupReadResponse = {
  ok: true,
  payload: {
    version: 45,
    writtenAt: new Date().toISOString(),
    data: JSON.stringify({
      state: {
        workspaces: [{
          id: 'ws-from-backup',
          name: 'Recovered',
          folderPath: '/Users/example/recovered',
          agents: {},
        } as Workspace],
        activeWorkspaceId: 'ws-from-backup',
        workspaceRegistryEmptyState: null,
      },
      version: 45,
    } satisfies RegistryRecord),
  },
}
await __workspaceStoreRunBackupRecoveryForTests()

const recoveredState = useWorkspaceStore.getState()
assert.equal(recoveredState.workspaces.length, 1)
assert.equal(recoveredState.workspaces[0]?.id, 'ws-from-backup')
assert.equal(recoveredState.activeWorkspaceId, 'ws-from-backup')
assert.equal(recoveredState.workspaceRegistryEmptyState, null,
  'recovery clears any stale intent record')
assert.equal(diagnosticLog.length, 1)
const recoveryDiag = diagnosticLog[0].payload as { storageSource: string; classification: string; hydratedWorkspaceCount: number }
assert.equal(recoveryDiag.storageSource, 'backup')
assert.equal(recoveryDiag.classification, 'dangerous_empty_unreadable')
assert.equal(recoveryDiag.hydratedWorkspaceCount, 1)

// ── CASE 7 ──────────────────────────────────────────────────────────────────
// Legacy T22-era backup salvage. Pre-T23 backups mirrored the full envelope
// including appSettings (projectKnowledgeRoots, recentWorkspaceFolders,
// learning, CLI/MCP, etc.). On a dangerous-empty cold-load that triggers
// recovery, the salvage path must carry those fields through to
// multicode-app-settings instead of letting the next persist write commit
// the current empty defaults over them.
//
// Evidence shape mirrors the production incident: 4 projectKnowledgeRoots
// keyed by absolute paths + non-empty recentWorkspaceFolders + a populated
// learning record.
diagnosticLog.length = 0
useWorkspaceStore.setState({
  workspaces: [],
  activeWorkspaceId: null,
  workspaceRegistryEmptyState: null,
  appSettings: {
    ...useWorkspaceStore.getState().appSettings,
    projectKnowledgeRoots: {},
    recentWorkspaceFolders: [],
  },
})
stored['multicode-workspaces'] = 'unreadable garbage {{{'

const legacyBackupAppSettings = {
  cliRuntimes: {
    codex: { command: 'codex' },
    claude: { command: 'claude' },
  },
  lastSelectedCli: 'claude',
  lastSelectedSpecialist: 'architect',
  lastSelectedMultiloopRole: 'coordinator',
  lastAgentSpawnPermissionPreset: 'default',
  specialistCliDefaults: {},
  multiloopRoleCliDefaults: {},
  searchExcludes: [],
  projectKnowledgeRoots: {
    '/Users/dev/workspace/multicode': 'knowledge',
    '/Users/dev/workspace/multicode-mobile': '../multicode/knowledge',
    '/Users/dev/workspace/multicode-website': '../multicode/knowledge',
    '/Users/dev/workspace/sprintengine-website': '../multicode/knowledge',
  },
  recentWorkspaceFolders: [
    '/Users/dev/workspace/multicode',
    '/Users/dev/workspace/multicode-mobile',
  ],
  usageTelemetry: {
    sendUsageData: false,
    localDevExportEnabled: false,
    lastExportAt: null,
    exportDiagnostics: true,
  },
  learning: {
    showTipsOnStartup: false,
    lastShownTipId: 'tip-12',
    seenTipIds: ['tip-1', 'tip-2', 'tip-12'],
    completedLessonIds: ['lesson-a'],
  },
  mcp: { syncEnabled: true, servers: {} },
  skillPacks: { installed: {} },
}

backupReadResponse = {
  ok: true,
  payload: {
    version: 44,
    writtenAt: '2026-05-18T10:00:00.000Z',
    // T22 backup shape: full envelope, no workspaceRegistryEmptyState yet.
    data: JSON.stringify({
      state: {
        workspaces: [{
          id: 'ws-multicode',
          name: 'multicode',
          folderPath: '/Users/dev/workspace/multicode',
          agents: {},
        } as Workspace],
        activeWorkspaceId: 'ws-multicode',
        appSettings: legacyBackupAppSettings,
        sidebarCollapsed: false,
      },
      version: 44,
    }),
  },
}

await __workspaceStoreRunBackupRecoveryForTests()

const salvaged = useWorkspaceStore.getState()
assert.equal(salvaged.workspaces.length, 1)
assert.equal(salvaged.workspaces[0]?.id, 'ws-multicode')

// Salvaged appSettings carry the four project-knowledge roots through normalization.
const salvagedRoots = salvaged.appSettings.projectKnowledgeRoots
assert.equal(
  Object.keys(salvagedRoots).length,
  4,
  'all four projectKnowledgeRoots survive recovery (the production regression: previously 4 → 0)',
)
assert.equal(salvagedRoots['/Users/dev/workspace/multicode'], 'knowledge')
assert.equal(salvagedRoots['/Users/dev/workspace/multicode-mobile'], '../multicode/knowledge')

// Other non-workspace app-settings survive too.
assert.equal(salvaged.appSettings.recentWorkspaceFolders.length, 2)
assert.equal(salvaged.appSettings.learning.lastShownTipId, 'tip-12')
assert.deepEqual(salvaged.appSettings.learning.seenTipIds, ['tip-1', 'tip-2', 'tip-12'])
assert.equal(salvaged.appSettings.mcp.syncEnabled, true)
assert.equal(salvaged.sidebarCollapsed, false, 'salvaged sidebarCollapsed honored')

// multicode-app-settings on disk was written immediately so the next persist
// write does not clobber the salvage with current empty defaults.
const settingsAfterSalvage = JSON.parse(stored['multicode-app-settings']) as SettingsRecord
const persistedRoots = (settingsAfterSalvage.state.appSettings as { projectKnowledgeRoots: Record<string, string> }).projectKnowledgeRoots
assert.equal(
  Object.keys(persistedRoots).length,
  4,
  'multicode-app-settings on disk also carries the four projectKnowledgeRoots after salvage',
)

const registryAfterSalvage = JSON.parse(stored['multicode-workspaces']) as RegistryRecord
assert.equal(
  (registryAfterSalvage.state as unknown as { appSettings?: unknown }).appSettings,
  undefined,
  'legacy appSettings salvage does not reintroduce appSettings into the registry key',
)
assert.equal(
  (registryAfterSalvage.state as unknown as { sidebarCollapsed?: unknown }).sidebarCollapsed,
  undefined,
  'legacy sidebarCollapsed salvage does not reintroduce sidebarCollapsed into the registry key',
)

console.info = originalInfo
console.log('workspaceStore.persistence.test.ts: ok')
