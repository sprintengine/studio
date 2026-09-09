import assert from 'node:assert/strict'

import type { AgentState, LayoutTemplate, Workspace } from '../types/workspace'
import type { WorkspaceBackupPayload } from '../../../shared/electron-api'
import { defaultAuthState } from './slices/authSlice'
import { defaultAgent } from './slices/agentsSlice'
import { normalizeWorkspaceForPartialize } from './slices/normalizers'
import { normalizeWorkspaceForRegistry } from '../../../shared/workspace-registry'
import { workspaceProjectRoot } from '../utils/workspaceWorktree'

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
  WORKSPACE_STORE_VERSION,
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

// The registry key is FROZEN (MC-2158): main owns the registry, so a workspace
// mutation no longer rewrites multicode-workspaces. The key keeps its last
// written value for one release as the rollback artifact, and the release after
// this deletes it.
const frozenRegistryRaw = stored['multicode-workspaces']
useWorkspaceStore.getState().renameWorkspace(persistedWorkspace.id, 'Retained Workspace')
await new Promise<void>((resolve) => setTimeout(resolve, 50))
assert.equal(
  stored['multicode-workspaces'],
  frozenRegistryRaw,
  'a workspace rename does not write the legacy registry key: main persists the registry now',
)
assert.equal(
  useWorkspaceStore.getState().workspaces[0]?.name,
  'Retained Workspace',
  'the rename still lands in memory and is asked of main through the sync bus',
)

// ── CASE 2 ──────────────────────────────────────────────────────────────────
// The split still holds, in the direction that is left: the renderer owns the
// SETTINGS key and still writes it, while the registry key is never written at
// all. Both halves are asserted, because "nothing is written" would also be
// satisfied by a persistence layer that had stopped working entirely.
const settingsRawBefore = stored['multicode-app-settings']
useWorkspaceStore.getState().setSidebarCollapsed(false)
await new Promise<void>((resolve) => setTimeout(resolve, 50))
assert.notEqual(
  stored['multicode-app-settings'],
  settingsRawBefore,
  'a settings change still writes the app-settings key: the renderer owns settings',
)
assert.equal(
  stored['multicode-workspaces'],
  frozenRegistryRaw,
  'and it still does not touch the frozen registry key',
)

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
// Durable resume identity is main's to persist now, so it is asserted against
// the normalized record main receives rather than the frozen localStorage key.
// The strip rules are unchanged — `normalizeWorkspaceForRegistry` mirrors
// `normalizeWorkspaceForPartialize` field for field, which is why cliSessionId
// survives and cliRestartNonce does not.
const durableAgent = normalizeWorkspaceForRegistry(
  useWorkspaceStore.getState().workspaces[0]!,
).agents['agent-1'] as Partial<AgentState> | undefined
assert.equal(durableAgent?.cliStartRequested, true)
assert.equal(durableAgent?.cliHasLaunched, true)
assert.equal(durableAgent?.cliSessionId, 'session-stale')
assert.equal(durableAgent?.cliResumeAvailable, true)
assert.equal(durableAgent?.cliRestartNonce, 0)

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

const durableAgentAfterReconcile = normalizeWorkspaceForRegistry(
  useWorkspaceStore.getState().workspaces[0]!,
).agents['agent-1'] as Partial<AgentState> | undefined
assert.equal(durableAgentAfterReconcile?.cliStartRequested, true)
assert.equal(durableAgentAfterReconcile?.cliHasLaunched, true)
assert.equal(durableAgentAfterReconcile?.cliSessionId, 'session-stale')
assert.equal(durableAgentAfterReconcile?.cliResumeAvailable, true)

// ── CASE 2b (retired) ───────────────────────────────────────────────────────
// The cross-window `storage`-event import this case covered is deleted
// (MC-2158): it was the rollback path for a localStorage registry that no
// longer exists. Cross-window reconciliation is now main's, and its cases are
// asserted end-to-end in `src/main/workspace-registry-reconciliation.test.ts`.

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
// workspaceRegistryEmptyState record. That record is the ONE signal that tells
// main's hydration an empty registry is intent rather than a fault — without
// it, hydration refuses to seed and retries on the next boot. It is asserted in
// memory now, because the frozen registry key is no longer written.
const backupCallsBeforeClear = backupWriteCalls.length
const frozenBeforeClear = stored['multicode-workspaces']
useWorkspaceStore.getState().removeWorkspace(persistedWorkspace.id)
await new Promise<void>((resolve) => setTimeout(resolve, 350))

const afterClear = useWorkspaceStore.getState()
assert.equal(afterClear.workspaces.length, 0)
assert.equal(afterClear.activeWorkspaceId, null)
assert.ok(afterClear.workspaceRegistryEmptyState, 'explicit empty intent record was recorded')
assert.equal(afterClear.workspaceRegistryEmptyState!.reason, 'user_removed_all')
assert.ok(
  typeof afterClear.workspaceRegistryEmptyState!.updatedAt === 'string'
    && afterClear.workspaceRegistryEmptyState!.updatedAt.length > 0,
  'updatedAt timestamp present',
)
assert.equal(
  stored['multicode-workspaces'],
  frozenBeforeClear,
  'removing the last workspace does not write the frozen registry key',
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

const afterForget = useWorkspaceStore.getState()
assert.equal(afterForget.workspaces.length, 0)
assert.ok(
  afterForget.workspaceRegistryEmptyState,
  'forgetFolder on the last workspace records the intent record too',
)
assert.equal(afterForget.workspaceRegistryEmptyState!.reason, 'user_removed_all')

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
  workspaceRegistryEmptyState: afterForget.workspaceRegistryEmptyState,
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
// mcp record.
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
    'claude-code': { command: 'claude' },
  },
  lastSelectedCli: 'claude-code',
  lastSelectedSpecialist: 'architect',
  lastAgentSpawnPermissionPreset: 'default',
  specialistCliDefaults: {},
  projectKnowledgeRoots: {
    '/Users/dev/workspace/multicode': 'knowledge',
    '/Users/dev/workspace/multicode-mobile': '../multicode/knowledge',
    '/Users/dev/workspace/docs-site': '../multicode/knowledge',
    '/Users/dev/workspace/marketing-site': '../multicode/knowledge',
  },
  recentWorkspaceFolders: [
    '/Users/dev/workspace/multicode',
    '/Users/dev/workspace/multicode-mobile',
  ],
  mcp: { syncEnabled: true, servers: {} },
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

// The salvage lands in the settings key and in memory; it never writes the
// frozen registry key, which main owns the successor to (MC-2158).
assert.ok(
  (JSON.parse(stored['multicode-app-settings']) as SettingsRecord).state.appSettings,
  'the salvage is committed to the settings key, which the renderer still owns',
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
  fileExplorerState: { expandedPaths: ['/Users/example/project/src', '/Users/example/project/docs'] },
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
assert.deepEqual(
  partializedRuntime.fileExplorerState,
  { expandedPaths: ['/Users/example/project/src', '/Users/example/project/docs'], selectedPath: null },
  'partialize + storage round-trip preserves File Explorer expanded folders without file contents',
)

// MC-1416: the worktree marker (set when a worktree is opened as a workspace)
// must survive the full persist normalization + JSON storage round-trip so the
// Git view + tab glyph still resolve a worktree-backed workspace after a restart.
const partializedWorktree = JSON.parse(
  JSON.stringify(normalizeWorkspaceForPartialize({
    ...runtimeBaseWorkspace,
    worktree: { branch: 'spike/parser', baseRef: 'main' },
  })),
) as Workspace
assert.deepEqual(
  partializedWorktree.worktree,
  { branch: 'spike/parser', baseRef: 'main' },
  'partialize + storage round-trip preserves the worktree marker',
)
const partializedNoWorktree = JSON.parse(
  JSON.stringify(normalizeWorkspaceForPartialize({ ...runtimeBaseWorkspace, worktree: null })),
) as Workspace
assert.equal(
  partializedNoWorktree.worktree ?? undefined,
  undefined,
  'a workspace without a worktree marker stays without one (no-op for existing workspaces)',
)

// The marker's `repoRoot` (the project a worktree was cut from) rides along, and
// a row written before that field existed still loads with the marker intact —
// its project is derived from the container path instead.
const partializedWorktreeRepoRoot = JSON.parse(
  JSON.stringify(normalizeWorkspaceForPartialize({
    ...runtimeBaseWorkspace,
    worktree: { branch: 'agent/chat-a1b2', baseRef: 'HEAD', repoRoot: '/Users/example/project' },
  })),
) as Workspace
assert.deepEqual(
  partializedWorktreeRepoRoot.worktree,
  { branch: 'agent/chat-a1b2', baseRef: 'HEAD', repoRoot: '/Users/example/project' },
  'partialize + storage round-trip preserves the worktree marker repoRoot',
)
const partializedLegacyWorktree = JSON.parse(
  JSON.stringify(normalizeWorkspaceForPartialize({
    ...runtimeBaseWorkspace,
    worktree: { branch: 'spike/parser' },
  })),
) as Workspace
assert.deepEqual(
  partializedLegacyWorktree.worktree,
  { branch: 'spike/parser' },
  'a persisted worktree marker without repoRoot still loads unchanged',
)
assert.equal(
  workspaceProjectRoot({
    folderPath: '/Users/example/.multicode-worktrees/project/chat-a1b2',
    worktree: partializedLegacyWorktree.worktree,
  }),
  '/Users/example/project',
  'a legacy marker derives its project from the container path',
)

// ── Duplicate Automations hosts in a CURRENT-version envelope ───────────────
// The v63/v64 dedupe migrations only run on a version mismatch, but a dev-HMR
// module swap (or any writer holding un-migrated state) can stamp the current
// WORKSPACE_STORE_VERSION onto a registry that still carries one host per
// automation run — the migrate ladder then never looks at it again. merge()
// must therefore enforce the one-host-per-folder invariant on EVERY hydration:
// earliest host survives, gets the stable 'Automations' name, and a dangling
// active pointer falls back to a surviving workspace.
{
  const hostWorkspace = (id: string, name: string, createdAt: number): Workspace => ({
    ...persistedWorkspace,
    id,
    name,
    mode: 'automations-host',
    folderPath: '/Users/example/project',
    createdAt,
    agents: {},
  } as unknown as Workspace)
  // Stamp the CURRENT store version explicitly. The key is frozen at whatever
  // shape it last held (MC-2158), so reading its version back would run the
  // migrate ladder instead — and this case is specifically about the ladder
  // never looking at the registry again.
  stored['multicode-workspaces'] = JSON.stringify({
    state: {
      workspaces: [
        { ...persistedWorkspace },
        hostWorkspace('ws-host-early', 'Pillars of code reviewer', 100),
        hostWorkspace('ws-host-late', 'fable5 calendar', 200),
      ],
      activeWorkspaceId: 'ws-host-late',
      workspaceRegistryEmptyState: null,
    },
    version: WORKSPACE_STORE_VERSION,
  })
  await useWorkspaceStore.persist.rehydrate()
  const rehydrated = useWorkspaceStore.getState()
  const hosts = rehydrated.workspaces.filter((ws) => ws.mode === 'automations-host')
  assert.equal(hosts.length, 1, 'merge dedupes duplicate hosts even at the current store version')
  assert.equal(hosts[0].id, 'ws-host-early', 'the earliest-created host survives')
  assert.equal(hosts[0].name, 'Automations', 'the surviving host is re-branded with the stable name')
  assert.notEqual(
    rehydrated.activeWorkspaceId,
    'ws-host-late',
    'the active pointer does not dangle at a deduped host',
  )
}

// ── A retired Design Wizard setting in a CURRENT-version envelope ───────────
// The Design Wizard was deleted 2026-09-08 and its `guidedBriefConversationSessions`
// opt-in went with it. A profile written by an older build still carries the
// key, and its envelope is stamped with the CURRENT version, so the migrate
// ladder never revisits it — merge()'s normalizeAppSettings is what has to drop
// it, exactly as it does for every other retired key.
{
  const { WORKSPACE_STORE_VERSION } = await import('./slices/persistenceSlice')
  const settingsEnvelope = JSON.parse(stored['multicode-app-settings']) as {
    state: { appSettings?: Record<string, unknown> }
    version: number
  }
  const persistedAppSettings = (settingsEnvelope.state.appSettings ?? {}) as Record<string, unknown>
  stored['multicode-app-settings'] = JSON.stringify({
    state: {
      ...settingsEnvelope.state,
      appSettings: {
        ...persistedAppSettings,
        guidedBriefConversationSessions: true,
        guidedBriefConversationSessionsOptInReset: true,
      },
    },
    version: WORKSPACE_STORE_VERSION,
  })
  await useWorkspaceStore.persist.rehydrate()
  const settings = useWorkspaceStore.getState().appSettings as Record<string, unknown>
  assert.equal(
    'guidedBriefConversationSessions' in settings,
    false,
    'merge drops the retired Design Wizard transport opt-in',
  )
  assert.equal(
    'guidedBriefConversationSessionsOptInReset' in settings,
    false,
    'merge drops its one-time reset stamp with it',
  )
  assert.equal(
    settings.lastSelectedCli,
    persistedAppSettings.lastSelectedCli,
    'no other persisted setting changes as a side effect',
  )
}

// ── A malformed cliModelCatalog in a CURRENT-version envelope ───────────────
// Store v69 adds `cliModelCatalog`. Its shape rules cannot live only in the
// migrate ladder: a dev-HMR module swap (or any writer holding un-migrated
// state) stamps the current version onto a profile the ladder then never looks
// at again — exactly how the v63 dedupe was bypassed in the wild. The envelope
// below is stamped CURRENT, so the v69 rung never runs and merge() alone has to
// hold the line: an entry that does not carry the recorded shape is dropped
// rather than fed to the pickers, and the user's own model ids are untouched
// either way.
{
  const { WORKSPACE_STORE_VERSION } = await import('./slices/persistenceSlice')
  const settingsEnvelope = JSON.parse(stored['multicode-app-settings']) as SettingsRecord
  assert.equal(
    settingsEnvelope.version,
    WORKSPACE_STORE_VERSION,
    'the seeded settings envelope is at the current store version, so this exercises merge and not migrate',
  )
  const persistedAppSettings = (settingsEnvelope.state.appSettings ?? {}) as Record<string, unknown>
  const seedCatalog = (cliModelCatalog: unknown): void => {
    stored['multicode-app-settings'] = JSON.stringify({
      state: {
        ...settingsEnvelope.state,
        appSettings: {
          ...persistedAppSettings,
          cliRuntimes: { codex: { command: 'codex', useWsl: false, models: ['o4-mini'] } },
          cliModelCatalog,
        },
      },
      version: WORKSPACE_STORE_VERSION,
    })
  }

  seedCatalog({ codex: { models: [{ id: 'gpt-5.6' }], source: 'argv-probe' } })
  await useWorkspaceStore.persist.rehydrate()
  const afterMalformed = useWorkspaceStore.getState().appSettings
  assert.equal(
    afterMalformed.cliModelCatalog,
    undefined,
    'merge drops a malformed discovered catalog even at the current store version',
  )
  assert.deepEqual(
    afterMalformed.cliRuntimes.codex.models,
    ['o4-mini'],
    'dropping the discovered catalog never touches the user model list',
  )

  seedCatalog({
    codex: { models: [{ id: 'gpt-5.6' }, { id: '  ' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' },
  })
  await useWorkspaceStore.persist.rehydrate()
  assert.deepEqual(
    useWorkspaceStore.getState().appSettings.cliModelCatalog,
    { codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' } },
    'a well-formed catalog hydrates through merge with its unusable rows removed',
  )
}

// Module-contributed workspace types: an explicit non-shell mode survives
// addWorkspace (it used to be silently dropped to 'standard', stripping every
// mode-derived surface — panel scopes, run glyphs, the not-installed state).
{
  const moduleModeId = useWorkspaceStore.getState().addWorkspace(
    { ...raceTemplate, id: 'calendar-mode' },
    { name: 'Module Mode Workspace', mode: 'calendar' },
  )
  assert.equal(
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === moduleModeId)?.mode,
    'calendar',
    'explicit module mode is persisted, not coerced to standard',
  )
}

// ── MC-1573: per-module state bag in a CURRENT-version envelope ─────────────
// The v71 rung reconciles bag and mirror on upgrade, but a dev-HMR module swap
// stamps the current version onto un-migrated state — so merge() must enforce
// the lockstep invariant (moduleState.sprintengine === sprintEngineState) on
// EVERY hydration. Existing persisted rows (null run state, no bag) must load
// unchanged, and a third-party module's bag entry must survive verbatim.
{
  const { WORKSPACE_STORE_VERSION } = await import('./slices/persistenceSlice')
  const { createInitialSprintEngineState } = await import('../utils/sprintengine')
  const sprintState = createInitialSprintEngineState({
    goal: 'Validate bag merge',
    name: 'Bag Merge Team',
    roleCounts: { frontend: 1 },
  })
  const currentEnvelope = JSON.parse(stored['multicode-workspaces']) as RegistryRecord
  stored['multicode-workspaces'] = JSON.stringify({
    state: {
      ...currentEnvelope.state,
      workspaces: [
        // The normal persisted shape: null run state, no bag.
        { ...persistedWorkspace, id: 'ws-plain', sprintEngineState: null },
        // Ancient pre-strip shape: populated legacy field, no bag.
        {
          ...persistedWorkspace,
          id: 'ws-mirror-only',
          mode: 'sprintengine',
          sprintEngineState: sprintState,
        },
        // Bag-only shape plus a third-party entry that must ride untouched.
        {
          ...persistedWorkspace,
          id: 'ws-bag-only',
          mode: 'sprintengine',
          sprintEngineState: null,
          moduleState: { sprintengine: sprintState, 'weather-deck': { lastCity: 'Dublin' } },
        },
      ],
      activeWorkspaceId: 'ws-plain',
    },
    version: WORKSPACE_STORE_VERSION,
  })
  await useWorkspaceStore.persist.rehydrate()
  const hydrated = useWorkspaceStore.getState().workspaces
  const plain = hydrated.find((ws) => ws.id === 'ws-plain')
  assert.ok(plain, 'the normal-shape row hydrates')
  assert.equal(plain!.sprintEngineState, null, 'a null run state stays null through merge')
  assert.equal(
    Boolean(plain!.moduleState && 'sprintengine' in plain!.moduleState),
    false,
    'merge never mints a sprintengine bag entry for a null run state',
  )
  const mirrorOnly = hydrated.find((ws) => ws.id === 'ws-mirror-only')
  assert.ok(mirrorOnly?.sprintEngineState, 'a populated legacy field survives merge')
  assert.equal(
    mirrorOnly!.moduleState?.sprintengine,
    mirrorOnly!.sprintEngineState,
    'merge adopts the legacy field into the bag — both homes hold the same state',
  )
  const bagOnly = hydrated.find((ws) => ws.id === 'ws-bag-only')
  assert.ok(bagOnly?.sprintEngineState, 'merge hoists a bag-only entry onto the mirror')
  assert.equal(
    bagOnly!.moduleState?.sprintengine,
    bagOnly!.sprintEngineState,
    'the hoisted mirror and the bag entry are the same state',
  )
  assert.deepEqual(
    bagOnly!.moduleState?.['weather-deck'],
    { lastCity: 'Dublin' },
    'a third-party module bag entry hydrates verbatim',
  )

  // Partialize: the sprintengine entry is a projection cache and is stripped
  // from BOTH homes at persist; other modules' entries persist verbatim.
  const partialized = normalizeWorkspaceForPartialize(bagOnly!)
  assert.equal(partialized.sprintEngineState, null, 'partialize nulls the legacy mirror')
  assert.equal(
    Boolean(partialized.moduleState && 'sprintengine' in partialized.moduleState),
    false,
    'partialize strips the sprintengine bag entry',
  )
  assert.deepEqual(
    partialized.moduleState,
    { 'weather-deck': { lastCity: 'Dublin' } },
    'partialize keeps other modules\' durable entries',
  )
  const plainPartialized = normalizeWorkspaceForPartialize(plain!)
  assert.equal(
    plainPartialized.moduleState,
    undefined,
    'a workspace with no module state persists with no bag at all',
  )

  // Workspace-sync round-trip: the bag rides Workspace whole-object sync like
  // any sibling field — a created-workspace event delivers it intact.
  const { applyWorkspaceSyncEvent } = await import('../../../shared/workspace-sync')
  const syncResult = applyWorkspaceSyncEvent(
    {
      workspaces: [],
      activeWorkspaceId: null,
      workspaceWindows: [],
      primaryWorkspaceWindowId: 'primary',
      lastAppliedWorkspaceSyncSequence: 0,
    },
    {
      id: 'evt-bag-1',
      type: 'workspace.created',
      sourceWindowId: 'primary',
      sequence: 1,
      createdAt: Date.now(),
      payload: {
        workspace: bagOnly!,
        windowId: 'primary',
        insert: { kind: 'folder_head', folderPath: bagOnly!.folderPath },
      },
    },
  )
  assert.equal(syncResult.status, 'applied', 'the created-workspace sync event applies')
  const syncedWorkspace = syncResult.state.workspaces.find((ws) => ws.id === 'ws-bag-only')
  assert.deepEqual(
    syncedWorkspace?.moduleState,
    bagOnly!.moduleState,
    'workspace-sync round-trips the module-state bag intact',
  )
  assert.equal(
    syncedWorkspace?.sprintEngineState,
    bagOnly!.sprintEngineState,
    'workspace-sync round-trips the legacy mirror alongside the bag',
  )
}

// ── MC-1573: the store's generic module-state writer ────────────────────────
// setWorkspaceModuleState is the SDK setter's backing action: entries write
// into the bag, null removes, unknown workspaces and the reserved sprintengine
// key report false (that entry's single writer stays setSprintEngineState).
{
  const targetId = useWorkspaceStore.getState().addWorkspace(
    { ...raceTemplate, id: 'bag-writer' },
    { name: 'Bag Writer Workspace' },
  )
  const store = useWorkspaceStore.getState()
  assert.equal(
    store.setWorkspaceModuleState(targetId, 'weather-deck', { lastCity: 'Cork' }),
    true,
    'a module entry write on a known workspace reports stored',
  )
  assert.deepEqual(
    useWorkspaceStore.getState().workspaces.find((ws) => ws.id === targetId)?.moduleState,
    { 'weather-deck': { lastCity: 'Cork' } },
    'the entry lands in the workspace bag',
  )
  assert.equal(
    store.setWorkspaceModuleState(targetId, 'weather-deck', null),
    true,
    'a null write removes the entry and reports stored',
  )
  assert.equal(
    useWorkspaceStore.getState().workspaces.find((ws) => ws.id === targetId)?.moduleState,
    undefined,
    'removing the last entry drops the bag entirely',
  )
  assert.equal(
    store.setWorkspaceModuleState('ws-does-not-exist', 'weather-deck', {}),
    false,
    'an unknown workspace reports not-stored',
  )
  assert.equal(
    store.setWorkspaceModuleState(targetId, 'sprintengine', {}),
    false,
    'the reserved sprintengine key is refused — its single writer is setSprintEngineState',
  )
}

console.info = originalInfo
console.log('workspaceStore.persistence.test.ts: ok')
