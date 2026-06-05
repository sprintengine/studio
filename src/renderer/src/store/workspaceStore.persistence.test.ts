import assert from 'node:assert/strict'

import type { AgentState, LayoutTemplate, Workspace } from '../types/workspace'
import type { WorkspaceBackupPayload } from '../../../shared/electron-api'
import { defaultAuthState } from './slices/authSlice'
import { defaultAgent } from './slices/agentsSlice'
import { normalizeWorkspaceForPartialize } from './slices/normalizers'

type RegistryRecord = {
  state: {
    workspaces: Workspace[]
    activeWorkspaceId: string | null
    workspaceWindows?: import('../types/workspace').WorkspaceWindowState[]
    primaryWorkspaceWindowId?: string
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

type BackupPair = {
  registry: string
  settings: string
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
  'multicode.workspaceStorageLiveSync': '1',
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

type StorageListener = (event: { key: string | null; newValue: string | null }) => void
const storageListeners: StorageListener[] = []

type WorkspaceBackupApi = {
  workspaceBackupRead: () => Promise<
    | { ok: true; payload: WorkspaceBackupPayload }
    | { ok: false; reason: 'missing' | 'unreadable' | 'parse_error'; message?: string }
  >
  workspaceBackupWrite: (payload: WorkspaceBackupPayload) => Promise<{ ok: boolean; message?: string }>
}
type WorkspaceBackupReadResult = Awaited<ReturnType<WorkspaceBackupApi['workspaceBackupRead']>>

const backupWriteCalls: WorkspaceBackupPayload[] = []
let backupReadResponse: WorkspaceBackupReadResult = {
  ok: false,
  reason: 'missing',
}
let backupReadDeferred: Promise<WorkspaceBackupReadResult> | null = null

const workspaceBackupApi: WorkspaceBackupApi = {
  workspaceBackupRead: async () => backupReadDeferred ?? backupReadResponse,
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
    location: { href: 'http://localhost/?windowId=primary' },
    localStorage: localStorageMock,
    api: workspaceBackupApi,
    addEventListener: (type: string, listener: StorageListener) => {
      if (type === 'storage') storageListeners.push(listener)
    },
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
// v46 registry-only shape into multicode-workspaces.
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

// ── CASE 2b ─────────────────────────────────────────────────────────────────
// Cross-window storage imports are still the temporary live-sync path during
// migration. A stale snapshot from another renderer must not erase terminal
// session identity for workspaces owned by the current window, and a newer
// foreign active selection must not replace a more recent local window-scoped
// active selection.
const locallyOwnedWorkspace = {
  ...persistedWorkspace,
  id: 'ws-local-owned',
  name: 'Local Owned',
  agents: {
    'agent-1': {
      ...(persistedWorkspace.agents['agent-1'] as AgentState),
      cliSessionId: 'session-local-owned',
      cliStartRequested: true,
      cliHasLaunched: true,
      cliResumeAvailable: true,
    },
  },
} as Workspace
const sameFolderWorkspace = {
  ...persistedWorkspace,
  id: 'ws-same-window',
  name: 'Same Window',
  agents: {},
} as Workspace
;(globalThis.window as unknown as { location: { href: string } }).location.href =
  'http://localhost/?windowId=detached-local'
useWorkspaceStore.setState({
  workspaces: [locallyOwnedWorkspace, sameFolderWorkspace],
  activeWorkspaceId: locallyOwnedWorkspace.id,
  workspaceWindows: [
    {
      id: 'primary',
      kind: 'primary',
      workspaceIds: [],
      activeWorkspaceId: null,
      bounds: null,
      isMaximized: false,
      displayId: null,
      createdAt: 1,
      lastFocusedAt: 1,
    },
    {
      id: 'detached-local',
      kind: 'detached',
      workspaceIds: [locallyOwnedWorkspace.id, sameFolderWorkspace.id],
      activeWorkspaceId: locallyOwnedWorkspace.id,
      bounds: null,
      isMaximized: false,
      displayId: null,
      createdAt: 1,
      lastFocusedAt: 50,
    },
  ],
})
const staleRegistryImport = JSON.stringify({
  state: {
    workspaces: [
      {
        ...locallyOwnedWorkspace,
        agents: {
          'agent-1': {
            ...(locallyOwnedWorkspace.agents['agent-1'] as AgentState),
            cliSessionId: undefined,
            cliStartRequested: false,
            cliHasLaunched: false,
            cliResumeAvailable: false,
          },
        },
      },
      sameFolderWorkspace,
    ],
    activeWorkspaceId: sameFolderWorkspace.id,
    primaryWorkspaceWindowId: 'primary',
    workspaceWindows: [
      {
        id: 'primary',
        kind: 'primary',
        workspaceIds: [],
        activeWorkspaceId: null,
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: 1,
        lastFocusedAt: 1,
      },
      {
        id: 'detached-local',
        kind: 'detached',
        workspaceIds: [locallyOwnedWorkspace.id, sameFolderWorkspace.id],
        activeWorkspaceId: sameFolderWorkspace.id,
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: 1,
        lastFocusedAt: 10,
      },
    ],
    workspaceRegistryEmptyState: null,
  },
  version: 46,
} satisfies RegistryRecord)
for (const listener of storageListeners) {
  listener({ key: 'multicode-workspaces', newValue: staleRegistryImport })
}
const afterStorageImport = useWorkspaceStore.getState()
const preservedAgent = afterStorageImport.workspaces.find((workspace) => workspace.id === locallyOwnedWorkspace.id)
  ?.agents['agent-1'] as Partial<AgentState> | undefined
assert.equal(
  preservedAgent?.cliSessionId,
  'session-local-owned',
  'stale storage snapshot cannot erase cliSessionId for a workspace owned by the current window',
)
assert.equal(preservedAgent?.cliStartRequested, true)
assert.equal(preservedAgent?.cliHasLaunched, true)
assert.equal(preservedAgent?.cliResumeAvailable, true)
assert.equal(
  afterStorageImport.workspaceWindows.find((windowState) => windowState.id === 'detached-local')?.activeWorkspaceId,
  locallyOwnedWorkspace.id,
  'current-window active workspace selection stays scoped when the incoming snapshot is older',
)

const foreignSpecialistWorkspace = {
  ...persistedWorkspace,
  id: 'ws-foreign-specialist',
  name: 'Foreign Specialist Workspace',
  agents: {
    'specialist-architect-1': {
      ...(persistedWorkspace.agents['agent-1'] as AgentState),
      id: 'specialist-architect-1',
      name: 'Architect',
      kind: 'specialist',
      specialistId: 'architect',
      cli: 'codex',
      cliStartupPrompt: 'architect startup prompt',
      cliStartRequested: false,
      cliHasLaunched: false,
      cliSessionId: undefined,
      cliResumeAvailable: false,
      cliOnboardingPromptSent: false,
    },
  },
} as Workspace
const specialistCreationImport = JSON.stringify({
  state: {
    workspaces: [
      {
        ...locallyOwnedWorkspace,
        agents: {
          'agent-1': {
            ...(locallyOwnedWorkspace.agents['agent-1'] as AgentState),
            cliSessionId: undefined,
            cliStartRequested: false,
            cliHasLaunched: false,
            cliResumeAvailable: false,
          },
        },
      },
      sameFolderWorkspace,
      foreignSpecialistWorkspace,
    ],
    activeWorkspaceId: foreignSpecialistWorkspace.id,
    primaryWorkspaceWindowId: 'primary',
    workspaceWindows: [
      {
        id: 'primary',
        kind: 'primary',
        workspaceIds: [foreignSpecialistWorkspace.id],
        activeWorkspaceId: foreignSpecialistWorkspace.id,
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: 1,
        lastFocusedAt: 60,
      },
      {
        id: 'detached-local',
        kind: 'detached',
        workspaceIds: [locallyOwnedWorkspace.id, sameFolderWorkspace.id],
        activeWorkspaceId: sameFolderWorkspace.id,
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: 1,
        lastFocusedAt: 10,
      },
    ],
    workspaceRegistryEmptyState: null,
  },
  version: 46,
} satisfies RegistryRecord)
for (const listener of storageListeners) {
  listener({ key: 'multicode-workspaces', newValue: specialistCreationImport })
}
const afterSpecialistCreationImport = useWorkspaceStore.getState()
const preservedAgentAfterSpecialistCreation = afterSpecialistCreationImport.workspaces.find((workspace) => workspace.id === locallyOwnedWorkspace.id)
  ?.agents['agent-1'] as Partial<AgentState> | undefined
assert.equal(
  preservedAgentAfterSpecialistCreation?.cliSessionId,
  'session-local-owned',
  'foreign specialist creation snapshot cannot erase cliSessionId for the current-window workspace',
)
assert.equal(preservedAgentAfterSpecialistCreation?.cliStartRequested, true)
assert.equal(
  afterSpecialistCreationImport.workspaces.find((workspace) => workspace.id === foreignSpecialistWorkspace.id)
    ?.agents['specialist-architect-1']?.kind,
  'specialist',
  'foreign-window specialist creation is still imported',
)
assert.equal(
  afterSpecialistCreationImport.workspaceWindows.find((windowState) => windowState.id === 'detached-local')?.activeWorkspaceId,
  locallyOwnedWorkspace.id,
  'foreign specialist creation does not replace a newer current-window active selection',
)
;(globalThis.window as unknown as { location: { href: string } }).location.href =
  'http://localhost/?windowId=primary'
useWorkspaceStore.setState({
  workspaces: [persistedWorkspace],
  activeWorkspaceId: persistedWorkspace.id,
  workspaceWindows: [
    {
      id: 'primary',
      kind: 'primary',
      workspaceIds: [persistedWorkspace.id],
      activeWorkspaceId: persistedWorkspace.id,
      bounds: null,
      isMaximized: false,
      displayId: null,
      createdAt: 1,
      lastFocusedAt: 1,
    },
  ],
  primaryWorkspaceWindowId: 'primary',
  workspaceRegistryEmptyState: null,
})

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
assert.equal(typeof lastBackup.data, 'object', 'backup payload uses split registry/settings envelopes')
const lastBackupPair = lastBackup.data as BackupPair
const lastBackupParsed = JSON.parse(lastBackupPair.registry) as RegistryRecord
const lastBackupSettings = JSON.parse(lastBackupPair.settings) as SettingsRecord
assert.equal(lastBackupParsed.state.workspaces[0]?.id, persistedWorkspace.id)
assert.equal(
  (lastBackupParsed.state as unknown as { appSettings?: unknown }).appSettings,
  undefined,
  'backup registry envelope is registry-only (no appSettings)',
)
assert.ok(
  lastBackupSettings.state.appSettings,
  'backup settings envelope carries appSettings separately',
)
assert.equal(
  (lastBackupSettings.state as unknown as { workspaces?: unknown }).workspaces,
  undefined,
  'backup settings envelope does not carry workspaces',
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
    version: 46,
    writtenAt: new Date().toISOString(),
    data: JSON.stringify({
      state: {
        workspaces: [persistedWorkspace],
        activeWorkspaceId: persistedWorkspace.id,
        workspaceRegistryEmptyState: null,
      },
      version: 46,
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
    version: 46,
    writtenAt: new Date().toISOString(),
    data: JSON.stringify({
      state: {
        workspaces: [persistedWorkspace],
        activeWorkspaceId: persistedWorkspace.id,
        workspaceRegistryEmptyState: null,
      },
      version: 46,
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
  appSettings: {
    ...useWorkspaceStore.getState().appSettings,
    projectKnowledgeRoots: {},
    recentWorkspaceFolders: [],
  },
})
stored['multicode-workspaces'] = 'unreadable garbage {{{'
backupReadResponse = {
  ok: true,
  payload: {
    version: 46,
    writtenAt: new Date().toISOString(),
    data: {
      registry: JSON.stringify({
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
        version: 46,
      } satisfies RegistryRecord),
      settings: JSON.stringify({
        state: {
          appSettings: {
            ...useWorkspaceStore.getState().appSettings,
            projectKnowledgeRoots: {
              '/Users/example/recovered': 'knowledge',
            },
            recentWorkspaceFolders: ['/Users/example/recovered'],
          },
          sidebarCollapsed: true,
        },
        version: 46,
      } satisfies SettingsRecord),
    } satisfies BackupPair,
  },
}
await __workspaceStoreRunBackupRecoveryForTests()

const recoveredState = useWorkspaceStore.getState()
assert.equal(recoveredState.workspaces.length, 1)
assert.equal(recoveredState.workspaces[0]?.id, 'ws-from-backup')
assert.equal(recoveredState.activeWorkspaceId, 'ws-from-backup')
assert.equal(recoveredState.workspaceRegistryEmptyState, null,
  'recovery clears any stale intent record')
assert.equal(
  recoveredState.appSettings.projectKnowledgeRoots['/Users/example/recovered'],
  'knowledge',
  'split backup recovery restores projectKnowledgeRoots from the settings envelope',
)
assert.deepEqual(recoveredState.appSettings.recentWorkspaceFolders, ['/Users/example/recovered'])
assert.equal(recoveredState.sidebarCollapsed, true, 'split backup recovery restores sidebarCollapsed')
assert.equal(diagnosticLog.length, 1)
const recoveryDiag = diagnosticLog[0].payload as { storageSource: string; classification: string; hydratedWorkspaceCount: number }
assert.equal(recoveryDiag.storageSource, 'backup')
assert.equal(recoveryDiag.classification, 'dangerous_empty_unreadable')
assert.equal(recoveryDiag.hydratedWorkspaceCount, 1)

// ── CASE 7 ──────────────────────────────────────────────────────────────────
// If the user creates a workspace while async backup recovery is in flight, the
// just-written registry is newer than the backup and must not be overwritten.
diagnosticLog.length = 0
stored['multicode-workspaces'] = 'unreadable garbage {{{'
useWorkspaceStore.setState({
  workspaces: [],
  activeWorkspaceId: null,
  workspaceRegistryEmptyState: null,
})

let resolveBackupRead!: (value: WorkspaceBackupReadResult) => void
backupReadDeferred = new Promise<WorkspaceBackupReadResult>((resolve) => {
  resolveBackupRead = resolve
})
const inFlightRecovery = __workspaceStoreRunBackupRecoveryForTests()
await new Promise<void>((resolve) => setTimeout(resolve, 0))

const raceTemplate: LayoutTemplate = {
  id: 'race-template',
  name: 'Race',
  description: 'Race test template',
  previewSlots: [],
  layout: { global: {}, borders: [], layout: { type: 'row', children: [] } },
}
const freshWorkspaceId = useWorkspaceStore.getState().addWorkspace(raceTemplate, {
  name: 'Fresh Workspace',
  folderPath: '/Users/example/fresh',
})
resolveBackupRead({
  ok: true,
  payload: {
    version: 46,
    writtenAt: new Date().toISOString(),
    data: {
      registry: JSON.stringify({
        state: {
          workspaces: [{
            id: 'ws-stale-backup',
            name: 'Stale backup',
            folderPath: '/Users/example/stale',
            agents: {},
          } as Workspace],
          activeWorkspaceId: 'ws-stale-backup',
          workspaceRegistryEmptyState: null,
        },
        version: 46,
      } satisfies RegistryRecord),
      settings: JSON.stringify({ state: {}, version: 46 } satisfies SettingsRecord),
    } satisfies BackupPair,
  },
})
await inFlightRecovery
backupReadDeferred = null

const raceState = useWorkspaceStore.getState()
assert.equal(raceState.activeWorkspaceId, freshWorkspaceId)
assert.equal(raceState.workspaces.length, 1)
assert.equal(raceState.workspaces[0]?.id, freshWorkspaceId)
assert.equal(
  raceState.workspaces.some((workspace) => workspace.id === 'ws-stale-backup'),
  false,
  'in-flight backup recovery must not replace a freshly-created workspace',
)

// ── CASE 8 ──────────────────────────────────────────────────────────────────
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

// ── CASE: runtime-kind round-trip through partialize + storage ───────────────
// T5 AC #5: conversation runtime fields survive the real persist normalization
// (normalizeWorkspaceForPartialize -> normalizeAgentState) plus a JSON storage
// round-trip, and a legacy agent persisted without runtimeKind normalizes to
// terminal without gaining a conversation payload.
const runtimeBaseWorkspace = useWorkspaceStore.getState().workspaces[0]
assert.ok(runtimeBaseWorkspace, 'hydrated store exposes a workspace to seed the runtime round-trip')

// Legacy agent: simulate an older persisted record with no runtime fields.
const legacyAgentSeed = (() => {
  const { runtimeKind: _runtimeKind, conversation: _conversation, ...legacy } = defaultAgent('legacy-term-agent')
  return legacy as AgentState
})()

const seededRuntimeWorkspace: Workspace = {
  ...runtimeBaseWorkspace,
  agents: {
    'conv-agent': {
      ...defaultAgent('conv-agent'),
      runtimeKind: 'conversation',
      conversation: { providerId: 'openai-compatible', modelId: 'gpt-4o' },
    },
    'legacy-term-agent': legacyAgentSeed,
  },
}

const partializedRuntime = JSON.parse(
  JSON.stringify(normalizeWorkspaceForPartialize(seededRuntimeWorkspace)),
) as Workspace
assert.equal(
  partializedRuntime.agents['conv-agent']?.runtimeKind,
  'conversation',
  'partialize + storage round-trip preserves the conversation runtime kind',
)
assert.deepEqual(
  partializedRuntime.agents['conv-agent']?.conversation,
  { providerId: 'openai-compatible', modelId: 'gpt-4o' },
  'partialize + storage round-trip preserves the provider/model selection',
)
assert.equal(
  partializedRuntime.agents['legacy-term-agent']?.runtimeKind,
  'terminal',
  'a legacy agent persisted without runtimeKind normalizes to terminal',
)
assert.equal(
  partializedRuntime.agents['legacy-term-agent']?.conversation,
  undefined,
  'terminal agents carry no conversation payload after persist normalization',
)

console.info = originalInfo
console.log('workspaceStore.persistence.test.ts: ok')
