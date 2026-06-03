import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import { useWorkspaceStore } from '../workspaceStore'
import {
  createSettingsSlice,
  defaultAppSettings,
  normalizeAppSettings,
  normalizeCliPermissionPreset,
  normalizeRecentWorkspaceFolders,
  normalizeSearchExcludes,
} from './settingsSlice'

const workspaceWithMemoryRoot = {
  folderPath: '/Users/example/project',
  memory: {
    relativeRoot: 'knowledge',
  },
} as Workspace

const normalized = normalizeAppSettings(
  {
    cliRuntimes: {
      codex: { command: 'codex-next', useWsl: true },
    },
    mcp: {
      syncEnabled: true,
      servers: {
        valid: {
          id: ' Valid Server ',
          name: ' Valid Server ',
          transport: 'stdio',
          command: ' npx ',
          args: [' package ', '', 123 as unknown as string],
          enabled: true,
          clients: ['codex', 'opencode', 'bad cli!'],
          scope: 'user',
          source: 'custom',
          riskLevel: 'secrets',
        },
        invalid: {
          id: 'broken',
          name: 'Broken',
          transport: 'stdio',
          clients: ['codex'],
          enabled: true,
        } as never,
      },
    },
    lastSelectedCli: ' ',
    lastAgentSpawnPermissionPreset: 'unsafe' as never,
    specialistCliDefaults: {
      architect: 'codex',
      tester: 'invalid',
    } as never,
    searchExcludes: [' node_modules ', '!dist', 'src\\generated', 'node_modules', ''],
    projectKnowledgeRoots: {
      '/Users/example/project/': ' docs/knowledge ',
      '/Users/example/bad': '/absolute',
    },
    recentWorkspaceFolders: [' /Users/example/project ', '/Users/example/project/', '', '/Users/example/other'],
    usageTelemetry: {
      sendUsageData: true,
      localDevExportEnabled: false,
      lastExportAt: 42 as unknown as string,
      exportDiagnostics: false,
    },
    learning: {
      showTipsOnStartup: false,
      lastShownTipId: ' tip-intro ',
      seenTipIds: [' tip-intro ', 'tip-intro', '', 'tip-next'],
      completedLessonIds: [' lesson-a ', 'lesson-a'],
    },
  },
  [workspaceWithMemoryRoot],
)

assert.equal(normalized.cliRuntimes.codex.command, 'codex-next')
assert.equal(normalized.cliRuntimes.claude.command, defaultAppSettings().cliRuntimes.claude.command)
assert.equal(normalized.lastSelectedCli, 'claude')
assert.equal(normalized.mcp.syncEnabled, true)
assert.deepEqual(Object.keys(normalized.mcp.servers), ['valid-server'])
assert.deepEqual(normalized.mcp.servers['valid-server'].args, ['package'])
assert.deepEqual(normalized.mcp.servers['valid-server'].clients, ['codex', 'opencode', 'bad-cli'])
assert.equal(normalized.lastAgentSpawnPermissionPreset, 'default')
assert.deepEqual(normalized.specialistCliDefaults, { architect: 'codex', tester: 'invalid' })
assert.deepEqual(normalized.searchExcludes, ['node_modules', 'dist', 'src/generated'])
assert.deepEqual(normalized.projectKnowledgeRoots, {
  '/Users/example/project': 'docs/knowledge',
})
assert.deepEqual(normalized.recentWorkspaceFolders, [
  '/Users/example/project',
  '/Users/example/other',
])
assert.deepEqual(normalized.usageTelemetry, {
  sendUsageData: true,
  localDevExportEnabled: false,
  lastExportAt: null,
  exportDiagnostics: false,
})
assert.deepEqual(normalized.learning, {
  showTipsOnStartup: false,
  lastShownTipId: 'tip-intro',
  seenTipIds: ['tip-intro', 'tip-next'],
  completedLessonIds: ['lesson-a'],
  dismissedVersion: undefined,
})

assert.equal(normalizeCliPermissionPreset('auto_workspace'), 'auto_workspace')
assert.equal(normalizeCliPermissionPreset('bypass_all'), 'bypass_all')
assert.equal(normalizeCliPermissionPreset('bad' as never), 'default')
assert.deepEqual(normalizeSearchExcludes(['!build', 'build', 'src\\gen']), ['build', 'src/gen'])
assert.deepEqual(
  normalizeRecentWorkspaceFolders(['/A', '/a/', '/B'], ['/C', '/b']),
  ['/A', '/B', '/C'],
)

const carrier = {
  workspaces: [
    {
      folderPath: '/Users/example/project',
      memory: {
        relativeRoot: 'knowledge',
      },
    } as Workspace,
  ],
  appSettings: defaultAppSettings(),
  settingsOverlay: { open: false, initialTab: null, checkForUpdatesRequestId: null },
  runSummaryOverlay: { open: false, workspaceId: null },
  sidebarCollapsed: false,
}
const slice = createSettingsSlice((mutator) => mutator(carrier))
slice.openSettingsOverlay({ initialTab: 'integrations', checkForUpdates: true })
assert.equal(carrier.settingsOverlay.open, true)
assert.equal(carrier.settingsOverlay.initialTab, 'integrations')
assert.equal(typeof carrier.settingsOverlay.checkForUpdatesRequestId, 'number')
slice.closeSettingsOverlay()
assert.deepEqual(carrier.settingsOverlay, { open: false, initialTab: null, checkForUpdatesRequestId: null })

const store = useWorkspaceStore.getState()
store.setSearchExcludes([' dist ', '!coverage', 'dist'])
assert.deepEqual(useWorkspaceStore.getState().appSettings.searchExcludes, ['dist', 'coverage'])
store.setLastSelectedCli('codex')
assert.equal(useWorkspaceStore.getState().appSettings.lastSelectedCli, 'codex')
store.setSidebarCollapsed(true)
assert.equal(useWorkspaceStore.getState().sidebarCollapsed, true)

// --- Sprint Engine role enablement (T3) -----------------------------------
// Bundled non-architect role can be toggled off; the change persists in
// settings so future workspace and guided-brief roster construction can
// filter it out.
store.setSprintEngineRoleEnabled('frontend', false)
assert.equal(
  useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.enabled.frontend,
  false,
  'bundled frontend disablement persists',
)

// Custom registry roles are accepted and stored under their registry id.
store.setSprintEngineRoleEnabled('marketer', false)
assert.equal(
  useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.enabled.marketer,
  false,
  'custom marketer disablement persists',
)

// Re-enabling a previously disabled role flips the flag back on.
store.setSprintEngineRoleEnabled('frontend', true)
assert.equal(
  useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.enabled.frontend,
  true,
  'role enablement can flip back to true',
)

// Architect cannot be disabled. The setter ignores a `false` write so
// Sprint Engine planning can never be stranded by a stale setting.
store.setSprintEngineRoleEnabled('architect', false)
assert.notEqual(
  useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.enabled.architect,
  false,
  'architect cannot be disabled through the setter',
)

// Normalization also drops architect:false from any persisted payload (a
// stale user settings file from before this protection should not silently
// disable the planner).
const normalizedWithArchitectFalse = normalizeAppSettings(
  { sprintEngineRoleSettings: { enabled: { architect: false, developer: false } } },
  [],
)
assert.equal(
  normalizedWithArchitectFalse.sprintEngineRoleSettings.enabled.architect,
  undefined,
  'normalization strips architect:false',
)
assert.equal(
  normalizedWithArchitectFalse.sprintEngineRoleSettings.enabled.developer,
  false,
  'normalization preserves other disabled roles',
)

console.log('settingsSlice.test.ts: ok')
