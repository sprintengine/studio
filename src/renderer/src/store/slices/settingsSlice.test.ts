import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import { useWorkspaceStore } from '../workspaceStore'
import {
  createSettingsSlice,
  defaultAppSettings,
  defaultKeybindingSettings,
  normalizeAppSettings,
  normalizeCliModelSelections,
  normalizeCliPermissionPreset,
  normalizeKeybindingSettings,
  normalizeModuleSettings,
  normalizeSprintEngineRunSettings,
  moduleSettingsNamespace,
  normalizeRecentWorkspaceFolders,
  normalizeNewChatAgentChoice,
  normalizeSearchExcludes,
  normalizeSpecialistOrder,
  sprintEngineRunSettingsKey,
} from './settingsSlice'
import {
  buildSpecialistSoulStartupPrompt,
  getSpecialistAction,
  orderSpecialistActions,
} from '../../specialists/specialistActions'
import { createInitialSprintEngineState } from '../../utils/sprintengine'

const workspaceWithMemoryRoot = {
  folderPath: '/Users/example/project',
  memory: {
    relativeRoot: 'knowledge',
  },
} as Workspace

function standardLayoutForSettingsTest(): Workspace['layoutModel'] {
  return {
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
  }
}

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
assert.equal(normalized.cliRuntimes['claude-code'].command, defaultAppSettings().cliRuntimes['claude-code'].command)
assert.equal(normalized.cliRuntimes.claude, undefined)
assert.equal(normalized.lastSelectedCli, 'claude-code')
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
assert.deepEqual(normalized.keybindings, defaultKeybindingSettings())

// --- Keybinding settings --------------------------------------------------
assert.deepEqual(
  normalizeAppSettings({}, []).keybindings,
  { overrides: {}, disabled: {} },
  'missing keybindings migrate to safe empty deltas',
)

const normalizedKeybindings = normalizeAppSettings(
  {
    keybindings: {
      overrides: {
        'commandPalette.open': [' CmdOrCtrl + K ', 'Primary+K', 'Ctrl + +', 'Hyper+Nope'],
        'app.settings.open': ['Primary+,'],
        'unknown.command': ['Primary+L'],
        'editor.save': 'Primary+S' as never,
      },
      disabled: {
        'voice.toggle': true,
        'app.settings.open': false,
        'unknown.command': true,
        'terminal.new': 'yes' as never,
      },
    },
  },
  [],
)
assert.deepEqual(
  normalizedKeybindings.keybindings.overrides,
  {
    'commandPalette.open': ['primary+k', 'ctrl++'],
    'app.settings.open': ['primary+,'],
    // Ids outside the static shell registry are kept on purpose: module
    // command deltas are stored by id and filtered at consumption, so they
    // survive module disable/enable (and uninstall/reinstall) cycles.
    'unknown.command': ['primary+l'],
  },
  'normalization keeps valid overrides (including unregistered ids), collapses duplicates, and drops malformed entries',
)
assert.deepEqual(
  normalizedKeybindings.keybindings.disabled,
  { 'voice.toggle': true, 'unknown.command': true },
  'normalization keeps true disabled flags by id; non-true and malformed flags are dropped',
)

assert.deepEqual(
  normalizeKeybindingSettings({
    overrides: { 'commandPalette.open': ['Primary+K', 'Primary+K', 'Ctrl+K then Ctrl+S then Ctrl+P'] },
    disabled: { 'commandPalette.open': true },
  }),
  {
    overrides: { 'commandPalette.open': ['primary+k'] },
    disabled: { 'commandPalette.open': true },
  },
  'standalone keybinding normalization rejects duplicates and invalid chords',
)

assert.equal(normalizeCliPermissionPreset('auto_workspace'), 'auto_workspace')
assert.equal(normalizeCliPermissionPreset('bypass_all'), 'bypass_all')
assert.equal(normalizeCliPermissionPreset('bad' as never), 'default')

// New-chat agent choice: terminal and known specialists round-trip; unknown
// specialist ids, malformed shapes, and missing values fall back to general.
assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'terminal' }), { kind: 'terminal' })
assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'specialist', specialistId: 'frontend-design-review' }), {
  kind: 'specialist',
  specialistId: 'frontend-design-review',
})
assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'specialist', specialistId: 'no-such-agent' }), {
  kind: 'general',
})
assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'specialist' }), { kind: 'general' })
assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'bogus' }), { kind: 'general' })
assert.deepEqual(normalizeNewChatAgentChoice(undefined), { kind: 'general' })
assert.deepEqual(normalizeNewChatAgentChoice('terminal'), { kind: 'general' })
assert.deepEqual(defaultAppSettings().lastNewChatAgent, { kind: 'general' })
assert.equal(
  sprintEngineRunSettingsKey('/Users/example/Project/.multi-code\\sprintengine/run.yaml/'),
  '/users/example/project/.multi-code/sprintengine/run.yaml',
)
assert.deepEqual(
  normalizeSprintEngineRunSettings({
    ' /Users/example/Project/.multi-code\\sprintengine/run.yaml/ ': {
      cliPermissionPreset: 'bypass_all',
      keepDoneAgentTerminals: true,
      maxConcurrentAgents: 99,
    },
    '/Users/example/bad/run.yaml': { maxConcurrentAgents: 'many' },
    '': { cliPermissionPreset: 'bypass_all' },
  }),
  {
    '/users/example/project/.multi-code/sprintengine/run.yaml': {
      cliPermissionPreset: 'bypass_all',
      keepDoneAgentTerminals: true,
      maxConcurrentAgents: 10,
    },
  },
)
assert.deepEqual(
  normalizeAppSettings(
    {
      sprintEngineRunSettings: {
        '/Users/example/Project/.multi-code/sprintengine/run.yaml': {
          cliPermissionPreset: 'auto_workspace',
        },
      },
    },
    [],
  ).sprintEngineRunSettings,
  {
    '/users/example/project/.multi-code/sprintengine/run.yaml': {
      cliPermissionPreset: 'auto_workspace',
    },
  },
)

// Per-surface model overrides keep only well-formed { cli, model } pairs.
assert.deepEqual(
  normalizeCliModelSelections({
    architect: { cli: 'claude-code', model: ' opus ' },
    developer: { cli: '', model: 'opus' },
    tester: { cli: 'codex' } as never,
  }),
  { architect: { cli: 'claude-code', model: 'opus' } },
)
const modelNormalized = normalizeAppSettings(
  {
    cliRuntimes: {
      codex: { command: 'codex', useWsl: false, models: [' gpt-5-codex ', '', 'gpt-5-codex', 'o4-mini'] },
    },
    specialistModelDefaults: { architect: { cli: 'claude-code', model: 'opus' } },
    multiloopRoleModelDefaults: { coordinator: { cli: 'codex', model: '' } as never },
  },
  [],
)
assert.deepEqual(modelNormalized.cliRuntimes.codex.models, ['gpt-5-codex', 'o4-mini'])
assert.equal(modelNormalized.cliRuntimes['claude-code'].models, undefined)
assert.equal('cliModelDefaults' in modelNormalized, false)
assert.deepEqual(modelNormalized.specialistModelDefaults, { architect: { cli: 'claude-code', model: 'opus' } })
assert.deepEqual(modelNormalized.multiloopRoleModelDefaults, {})
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
  sprintEnginesAsideOpen: false,
  openFilesInExternalWindow: true,
}
const slice = createSettingsSlice((mutator) => mutator(carrier))
slice.openSettingsOverlay({ initialTab: 'integrations', checkForUpdates: true })
assert.equal(carrier.settingsOverlay.open, true)
assert.equal(carrier.settingsOverlay.initialTab, 'integrations')
assert.equal(typeof carrier.settingsOverlay.checkForUpdatesRequestId, 'number')
slice.closeSettingsOverlay()
assert.deepEqual(carrier.settingsOverlay, { open: false, initialTab: null, checkForUpdatesRequestId: null })

const sprintEngineRunPath = '/Users/example/project/.multi-code/sprintengine/run/run.yaml'
const permissionCarrier = {
  workspaces: [
    {
      id: 'ws-sprint-permission',
      name: 'Sprint Permission',
      mode: 'sprintengine',
      folderPath: '/Users/example/project',
      templateId: 'sprintengine-mode',
      agents: {},
      layoutModel: standardLayoutForSettingsTest(),
      worktreeState: { containerPath: null, entries: {}, updatedAt: null },
      memory: { relativeRoot: null },
      editorState: { openFiles: [], activeFilePath: null },
      sprintEngineContext: {
        teamName: 'run',
        teamSlug: 'run',
        teamDirectoryPath: '/Users/example/project/.multi-code/sprintengine/run',
        statePath: sprintEngineRunPath,
      },
      sprintEngineState: createInitialSprintEngineState({
        name: 'run',
        goal: 'Test permission propagation',
        roleCounts: { architect: 1 },
      }),
      sprintEngineAutoState: {
        desiredMode: 'manual',
        runtimeState: 'idle',
        keepDoneAgentTerminals: false,
        cliPermissionPreset: 'default',
        maxConcurrentAgents: 3,
        pendingSpawns: [],
        deliveredAgentNotificationEventKeys: [],
      },
      multiloopState: null,
      multiloopAutoState: {
        enabled: false,
        cliPermissionPreset: 'default',
        maxConcurrentAgents: 1,
        coordinatorAutoSpawnKey: null,
        pendingSpawns: [],
      },
      createdAt: 1,
    } as Workspace,
  ],
  appSettings: defaultAppSettings(),
  settingsOverlay: { open: false, initialTab: null, checkForUpdatesRequestId: null },
  runSummaryOverlay: { open: false, workspaceId: null },
  sidebarCollapsed: false,
  sprintEnginesAsideOpen: false,
  openFilesInExternalWindow: true,
}
const permissionSlice = createSettingsSlice((mutator) => mutator(permissionCarrier))
permissionSlice.setLastAgentSpawnPermissionPreset('bypass_all')
assert.equal(permissionCarrier.appSettings.lastAgentSpawnPermissionPreset, 'bypass_all')
assert.equal(
  permissionCarrier.workspaces[0].sprintEngineAutoState?.cliPermissionPreset,
  'bypass_all',
  'app default updates Sprint Engine runs that do not have a local override',
)
permissionCarrier.appSettings.sprintEngineRunSettings = {
  [sprintEngineRunSettingsKey(sprintEngineRunPath)]: { cliPermissionPreset: 'default' },
}
permissionCarrier.workspaces[0].sprintEngineAutoState = {
  ...permissionCarrier.workspaces[0].sprintEngineAutoState!,
  cliPermissionPreset: 'default',
}
permissionSlice.setLastAgentSpawnPermissionPreset('auto_workspace')
assert.equal(
  permissionCarrier.workspaces[0].sprintEngineAutoState?.cliPermissionPreset,
  'default',
  'app default does not overwrite a Sprint Engine run with a local override',
)

const store = useWorkspaceStore.getState()
store.setSearchExcludes([' dist ', '!coverage', 'dist'])
assert.deepEqual(useWorkspaceStore.getState().appSettings.searchExcludes, ['dist', 'coverage'])
store.setLastSelectedCli('codex')
assert.equal(useWorkspaceStore.getState().appSettings.lastSelectedCli, 'codex')

store.setSpecialistModelDefault('architect', { cli: 'claude-code', model: 'opus' })
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.specialistModelDefaults,
  { architect: { cli: 'claude-code', model: 'opus' } },
)
store.setSpecialistModelDefault('architect', null)
assert.deepEqual(useWorkspaceStore.getState().appSettings.specialistModelDefaults, {})
store.setMultiloopRoleModelDefault('coordinator', { cli: 'codex', model: 'gpt-5-codex' })
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.multiloopRoleModelDefaults,
  { coordinator: { cli: 'codex', model: 'gpt-5-codex' } },
)
store.setMultiloopRoleModelDefault('coordinator', null)
assert.deepEqual(useWorkspaceStore.getState().appSettings.multiloopRoleModelDefaults, {})

store.setCommandKeybindings('commandPalette.open', ['Primary+Shift+P', 'CmdOrCtrl+Shift+P', 'Ctrl + +', 'bad-key'])
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.keybindings.overrides['commandPalette.open'],
  ['primary+shift+p', 'ctrl++'],
  'setCommandKeybindings normalizes and deduplicates overrides',
)
store.setCommandKeybindingDisabled('commandPalette.open', true)
assert.equal(
  useWorkspaceStore.getState().appSettings.keybindings.disabled['commandPalette.open'],
  true,
  'setCommandKeybindingDisabled persists true flags',
)
store.setCommandKeybindingDisabled('commandPalette.open', false)
assert.equal(
  useWorkspaceStore.getState().appSettings.keybindings.disabled['commandPalette.open'],
  undefined,
  're-enabling deletes the disabled flag',
)
store.setCommandKeybindingDisabled('voice.toggle', true)
store.resetCommandKeybindings('commandPalette.open')
assert.equal(
  useWorkspaceStore.getState().appSettings.keybindings.overrides['commandPalette.open'],
  undefined,
  'resetCommandKeybindings removes one command override',
)
assert.equal(
  useWorkspaceStore.getState().appSettings.keybindings.disabled['voice.toggle'],
  true,
  'resetCommandKeybindings leaves other command disabled flags alone',
)
store.resetAllKeybindings()
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.keybindings,
  { overrides: {}, disabled: {} },
  'resetAllKeybindings clears all persisted keybinding deltas',
)

// setCliRuntime on a plugin-id key (no bundled default) must NOT pin the command
// to the plugin id when only the WSL flag is toggled; a blank command resolves
// to the manifest binary at launch (T4 AC3).
store.setCliRuntime('opencode', { useWsl: true })
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.cliRuntimes.opencode,
  { command: '', useWsl: true },
  'plugin-id row defaults to a blank command, not the plugin id',
)
// A bundled key keeps its existing command default behavior.
store.setCliRuntime('codex', { command: 'codex-x' })
assert.equal(useWorkspaceStore.getState().appSettings.cliRuntimes.codex.command, 'codex-x')

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

const normalizedSavedRoster = normalizeAppSettings(
  {
    sprintEngineRoleSettings: {
      enabled: {},
      savedRoster: {
        roleCounts: { architect: 0, frontend: 3, tester: -4, developer: 'bad' as never },
        roleCliDefaults: { architect: ' codex ', frontend: '', tester: 'opencode' },
      },
    },
  },
  [],
)
assert.deepEqual(
  normalizedSavedRoster.sprintEngineRoleSettings.savedRoster?.roleCounts,
  { architect: 1, frontend: 3, tester: 0 },
  'saved roster normalization clamps counts and keeps architect present',
)
assert.deepEqual(
  normalizedSavedRoster.sprintEngineRoleSettings.savedRoster?.roleCliDefaults,
  { architect: 'codex', tester: 'opencode' },
  'saved roster normalization trims CLI defaults and drops blank values',
)

// A legacy single saved roster migrates into a selectable named team so users
// keep their saved config when teams ship.
assert.equal(
  normalizedSavedRoster.sprintEngineRoleSettings.savedTeams?.length,
  1,
  'legacy savedRoster migrates into one named team',
)
assert.equal(
  normalizedSavedRoster.sprintEngineRoleSettings.savedTeams?.[0]?.name,
  'Saved roster',
  'migrated team gets a default name',
)
assert.equal(
  normalizedSavedRoster.sprintEngineRoleSettings.lastSelectedTeamId,
  normalizedSavedRoster.sprintEngineRoleSettings.savedTeams?.[0]?.id,
  'the migrated team is pre-selected so legacy users open on their roster',
)

// Once a savedTeams key exists (even empty), the legacy roster must NOT be
// re-migrated — otherwise a user who deletes their last team would see it
// resurrected on the next normalize/reload.
const normalizedAfterDeleteAll = normalizeAppSettings(
  {
    sprintEngineRoleSettings: {
      enabled: {},
      savedTeams: [],
      savedRoster: { roleCounts: { architect: 1 }, roleCliDefaults: { architect: 'codex' } },
    },
  },
  [],
)
assert.equal(
  normalizedAfterDeleteAll.sprintEngineRoleSettings.savedTeams?.length,
  0,
  'an explicit empty savedTeams list is not re-migrated from the legacy roster',
)

// --- Named roster teams --------------------------------------------------
const teamStore = useWorkspaceStore.getState()
const lightweightId = teamStore.saveSprintEngineRosterTeam({
  name: 'Lightweight',
  roleCounts: { architect: 1, developer: 1 },
  roleCliDefaults: { architect: 'claude-code', developer: 'codex' },
})
assert.ok(lightweightId, 'saving a team returns an id')
const afterSave = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
const teamCountAfterSave = afterSave.savedTeams?.length ?? 0
assert.equal(afterSave.lastSelectedTeamId, lightweightId, 'saving selects the new team')
const savedLightweight = afterSave.savedTeams?.find((team) => team.id === lightweightId)
assert.equal(savedLightweight?.name, 'Lightweight', 'team name persists')
// savedRoster mirrors the active team so the run-mount CLI-default fallback stays meaningful.
assert.deepEqual(
  afterSave.savedRoster?.roleCliDefaults,
  { architect: 'claude-code', developer: 'codex' },
  'saving a team mirrors its CLI defaults into savedRoster',
)

// Saving with the same id updates the team in place rather than adding a new one.
teamStore.saveSprintEngineRosterTeam({
  id: lightweightId,
  name: 'Lightweight v2',
  roleCounts: { architect: 1, developer: 2 },
  roleCliDefaults: { architect: 'claude-code' },
})
const afterUpdate = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
assert.equal(afterUpdate.savedTeams?.length, teamCountAfterSave, 'updating a team does not add a duplicate')
const updatedLightweight = afterUpdate.savedTeams?.find((team) => team.id === lightweightId)
assert.equal(updatedLightweight?.name, 'Lightweight v2', 'team name updates in place')
assert.deepEqual(
  updatedLightweight?.roleCounts,
  { architect: 1, developer: 2 },
  'team role counts update in place',
)

// A blank name is rejected.
assert.equal(
  teamStore.saveSprintEngineRosterTeam({
    name: '   ',
    roleCounts: { architect: 1 },
    roleCliDefaults: {},
  }),
  '',
  'a blank team name is rejected',
)

// Renaming changes only the name, leaving the saved roster untouched.
teamStore.renameSprintEngineRosterTeam(lightweightId, '  Featherweight  ')
const afterRename = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
const renamedTeam = afterRename.savedTeams?.find((team) => team.id === lightweightId)
assert.equal(renamedTeam?.name, 'Featherweight', 'rename trims and applies the new name')
assert.deepEqual(
  renamedTeam?.roleCounts,
  { architect: 1, developer: 2 },
  'rename leaves the saved roster counts intact',
)
// A blank rename and an unknown id are no-ops rather than throwing or clearing.
teamStore.renameSprintEngineRosterTeam(lightweightId, '   ')
assert.equal(
  useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.savedTeams
    ?.find((team) => team.id === lightweightId)?.name,
  'Featherweight',
  'a blank rename is ignored',
)
teamStore.renameSprintEngineRosterTeam('does-not-exist', 'Ghost')
assert.ok(
  !useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.savedTeams
    ?.some((team) => team.name === 'Ghost'),
  'renaming an unknown id is a no-op',
)

// Deleting the selected team clears the selection.
teamStore.deleteSprintEngineRosterTeam(lightweightId)
const afterDelete = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
assert.ok(
  !afterDelete.savedTeams?.some((team) => team.id === lightweightId),
  'deleting removes the team',
)
assert.equal(afterDelete.lastSelectedTeamId, null, 'deleting the selected team clears selection')

// --- Specialist menu ordering --------------------------------------------
// Normalization keeps only known specialist ids, drops duplicates, and ignores
// junk so a stale or hand-edited settings file is always safe to load.
assert.deepEqual(
  normalizeSpecialistOrder(['developer', 'architect', 'developer', 'not-a-real-id', 42, '']),
  ['developer', 'architect'],
  'normalizeSpecialistOrder keeps known unique ids in order',
)
assert.deepEqual(normalizeSpecialistOrder(undefined), [], 'missing order normalizes to empty')

// orderSpecialistActions honors the saved order first, then appends any
// specialists missing from it (e.g. a newly shipped role) without dropping them.
const reordered = orderSpecialistActions(['developer', 'architect'])
assert.equal(reordered[0].id, 'developer', 'saved order leads the roster')
assert.equal(reordered[1].id, 'architect', 'saved order is respected in sequence')
assert.equal(
  new Set(reordered.map((action) => action.id)).size,
  reordered.length,
  'ordered roster has no duplicates',
)
assert.equal(
  reordered.length,
  orderSpecialistActions([]).length,
  'reordering never adds or drops specialists vs the canonical roster',
)
assert.ok(
  orderSpecialistActions([]).some((action) => action.id === 'nuclear-review'),
  'Nuclear Reviewer appears in the canonical specialist roster',
)
{
  const codeReviewPrompt = buildSpecialistSoulStartupPrompt(getSpecialistAction('code-review'))
  const specReviewPrompt = buildSpecialistSoulStartupPrompt(getSpecialistAction('spec-review'))
  const nuclearReviewPrompt = buildSpecialistSoulStartupPrompt(getSpecialistAction('nuclear-review'))
  assert.equal(codeReviewPrompt.includes('souls get code_reviewer'), true)
  assert.equal(specReviewPrompt.includes('souls get spec_reviewer'), true)
  assert.equal(nuclearReviewPrompt.includes('souls get nuclear_reviewer'), true)
  assert.equal(
    nuclearReviewPrompt.includes('wait for the user to give you a task or question'),
    true,
    'manual specialist launch waits for an explicit user task after loading the Soul',
  )
  assert.equal(nuclearReviewPrompt.includes('git diff'), false, 'manual Nuclear Reviewer launch does not auto-review diffs')
  assert.equal(
    nuclearReviewPrompt.replace('souls get nuclear_reviewer', 'souls get code_reviewer'),
    codeReviewPrompt,
    'Nuclear Reviewer startup prompt matches Slop Cop aside from the Soul role',
  )
}

// The persisted setter normalizes whatever the drag handler hands it.
store.setSpecialistOrder(['developer', 'developer', 'frontend-design-review', 'bogus' as never])
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.specialistOrder,
  ['developer', 'frontend-design-review'],
  'setSpecialistOrder persists a normalized id sequence',
)

// --- Module settings namespace (contributed settings sections) --------------
// Values live under `module:<id>` in appSettings.moduleSettings: real
// persistence through the existing app-settings path, keyed so module values
// can never collide with shell settings keys.
assert.equal(moduleSettingsNamespace('demo-module'), 'module:demo-module')
assert.deepEqual(
  normalizeModuleSettings({
    'module:demo-module': { greeting: 'hello', count: 2 },
    'module:': { dropped: true },
    'not-namespaced': { dropped: true },
    'module:bad-entry': 'not-an-object',
    'module:array-entry': ['dropped'],
  }),
  { 'module:demo-module': { greeting: 'hello', count: 2 } },
  'normalization keeps only namespaced object entries',
)

store.setModuleSettingValue('demo-module', 'greeting', 'hello')
store.setModuleSettingValue('demo-module', 'count', 2)
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.moduleSettings['module:demo-module'],
  { greeting: 'hello', count: 2 },
  'setModuleSettingValue writes into the module namespace',
)
store.setModuleSettingValue('demo-module', 'greeting', undefined)
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.moduleSettings['module:demo-module'],
  { count: 2 },
  'undefined deletes the key',
)
// Module enablement is orthogonal to the namespace: disabling and re-enabling
// the module never touches stored values, so they survive the cycle.
store.setModuleEnabled('demo-module', false)
store.setModuleEnabled('demo-module', true)
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.moduleSettings['module:demo-module'],
  { count: 2 },
  'module settings survive a disable/enable cycle',
)
// Round-trip through the persistence normalizer (what app restart replays).
assert.deepEqual(
  normalizeAppSettings(
    { moduleSettings: useWorkspaceStore.getState().appSettings.moduleSettings },
    [],
  ).moduleSettings,
  { 'module:demo-module': { count: 2 } },
  'module settings survive the persisted-settings normalization round trip',
)

console.log('settingsSlice.test.ts: ok')
