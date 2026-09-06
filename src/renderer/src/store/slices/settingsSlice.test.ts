import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import { useWorkspaceStore } from '../workspaceStore'
import type { SettingsOverlayState } from './settingsSlice'
import {
  createSettingsSlice,
  defaultAppearanceSettings,
  defaultAppSettings,
  defaultKeybindingSettings,
  normalizeAppearanceSettings,
  normalizeAppSettings,
  normalizeCliModelCatalogs,
  normalizeSelectedCli,
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
  normalizeSpecialistPacks,
  sprintEngineRunSettingsKey,
} from './settingsSlice'
import {
  buildSpecialistSoulStartupPrompt,
  getSpecialistAction,
  orderSpecialistActions,
} from '../../specialists/specialistActions'
import { createInitialSprintEngineState } from '../../utils/sprintengine'
import { EXTENSIONS_BROWSE_DEEPLINK } from '../../components/settings/extensionsRoute'
import { consumePendingExtensionsSurfaceTarget } from '../../components/workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { guidedBriefTransportForCli } from '../../components/workspace/guidedBrief/types'

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
assert.equal(normalized.lastAgentSpawnPermissionPreset, 'manual')
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

assert.equal(normalizeCliPermissionPreset('auto'), 'auto')
assert.equal(normalizeCliPermissionPreset('bypass'), 'bypass')
// Corruption floors to `manual`, which MC-2210 moved from `default`: no flag
// is no longer the conservative answer now that Claude Code reads it as auto.
assert.equal(normalizeCliPermissionPreset('bad' as never), 'manual')
// A recognised legacy spelling is not corruption — it maps, it does not floor.
assert.equal(normalizeCliPermissionPreset('default' as never), 'manual')
assert.equal(normalizeCliPermissionPreset('auto_workspace' as never), 'auto')
assert.equal(normalizeCliPermissionPreset('bypass_all' as never), 'bypass')

// MC-2210 acceptance: migration must NEVER escalate. Ordered least → most
// permissive, `none` sits outside the order because what it grants depends on
// the CLI (no flag now means auto mode on Claude Code), so it is checked
// separately: nothing may migrate INTO it, since that would hand the decision
// to a CLI whose default the user never chose.
{
  const rank: Record<string, number> = { manual: 0, auto: 1, bypass: 2 }
  const legacyRank: Record<string, number> = { default: 0, auto_workspace: 1, bypass_all: 2 }
  for (const [legacy, before] of Object.entries(legacyRank)) {
    const after = normalizeCliPermissionPreset(legacy as never)
    assert.notEqual(after, 'none', `${legacy} must not migrate into the CLI's own default`)
    assert.ok(
      rank[after] <= before,
      `${legacy} migrated UP the ladder to ${after} — migration may never grant more`,
    )
  }
  // Corruption floors, and the floor is the least permissive rung.
  assert.equal(rank[normalizeCliPermissionPreset('nonsense' as never)], 0)
}

// New-chat agent choice: terminal and any non-empty specialist id round-trip
// (bundled or registry-discovered, so a plugged-in specialist can be the
// default); only malformed shapes and missing values fall back to general.
assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'terminal' }), { kind: 'terminal' })
assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'specialist', specialistId: 'frontend-design-review' }), {
  kind: 'specialist',
  specialistId: 'frontend-design-review',
})
// A registry-discovered specialist id is preserved; the roster is validated at
// spawn/render time, not dropped here.
assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'specialist', specialistId: 'marketer' }), {
  kind: 'specialist',
  specialistId: 'marketer',
})
assert.deepEqual(normalizeNewChatAgentChoice({ kind: 'specialist', specialistId: '  ' }), { kind: 'general' })
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
      cliPermissionPreset: 'bypass',
      maxConcurrentAgents: 99,
    },
    '/Users/example/bad/run.yaml': { maxConcurrentAgents: 'many' },
    '': { cliPermissionPreset: 'bypass' },
  }),
  {
    '/users/example/project/.multi-code/sprintengine/run.yaml': {
      cliPermissionPreset: 'bypass',
      maxConcurrentAgents: 10,
    },
  },
)
assert.deepEqual(
  normalizeAppSettings(
    {
      sprintEngineRunSettings: {
        '/Users/example/Project/.multi-code/sprintengine/run.yaml': {
          cliPermissionPreset: 'auto',
        },
      },
    },
    [],
  ).sprintEngineRunSettings,
  {
    '/users/example/project/.multi-code/sprintengine/run.yaml': {
      cliPermissionPreset: 'auto',
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
// The reasoning-effort level rides the same selection. A level with no model is
// a real choice ("the CLI's default model at high effort") and survives; a
// selection with neither is not an override at all.
assert.deepEqual(
  normalizeCliModelSelections({
    architect: { cli: 'claude-code', model: 'opus', reasoning: ' high ' },
    developer: { cli: 'codex', model: '', reasoning: 'xhigh' },
    tester: { cli: 'codex', model: '', reasoning: '   ' },
    reviewer: { cli: 'codex', model: 'gpt-5.5', reasoning: 42 } as never,
  }),
  {
    architect: { cli: 'claude-code', model: 'opus', reasoning: 'high' },
    developer: { cli: 'codex', model: '', reasoning: 'xhigh' },
    reviewer: { cli: 'codex', model: 'gpt-5.5' },
  },
)
const modelNormalized = normalizeAppSettings(
  {
    cliRuntimes: {
      codex: { command: 'codex', useWsl: false, models: [' gpt-5-codex ', '', 'gpt-5-codex', 'o4-mini'] },
    },
    specialistModelDefaults: { architect: { cli: 'claude-code', model: 'opus' } },
  },
  [],
)
assert.deepEqual(modelNormalized.cliRuntimes.codex.models, ['gpt-5-codex', 'o4-mini'])
assert.equal(modelNormalized.cliRuntimes['claude-code'].models, undefined)
assert.equal('cliModelDefaults' in modelNormalized, false)
assert.deepEqual(modelNormalized.specialistModelDefaults, { architect: { cli: 'claude-code', model: 'opus' } })
// cliModelCatalog: what each CLI reported about itself, app-owned and kept
// strictly apart from the user's own ids in cliRuntimes[cli].models.
assert.equal(normalizeCliModelCatalogs(undefined), undefined)
assert.equal(normalizeCliModelCatalogs('not an object'), undefined)
assert.equal(
  normalizeCliModelCatalogs({ codex: { models: [{ id: 'gpt-5.6' }], source: 'argv-probe' } }),
  undefined,
  'an entry with no fetch timestamp is dropped rather than repaired',
)
assert.equal(
  normalizeCliModelCatalogs({
    codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'guessed' },
  }),
  undefined,
  'an entry whose source is not a known probe kind is dropped',
)
assert.equal(
  normalizeCliModelCatalogs({
    codex: { models: 'gpt-5.6', fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' },
  }),
  undefined,
  'an entry whose models is not an array is dropped',
)
assert.deepEqual(
  normalizeCliModelCatalogs({
    codex: {
      models: [
        { id: ' gpt-5.6 ', displayName: ' GPT-5.6 ', contextWindow: 272000, effortLevels: ['low', '', 'high'], supportsFastMode: true },
        { id: 'gpt-5.6' },
        { id: '   ' },
        'not a model',
        { id: 'gpt-5.4', contextWindow: -1, effortLevels: [], displayName: '   ', supportsFastMode: 'yes' },
      ],
      fetchedAt: ' 2026-07-26T00:00:00Z ',
      source: 'argv-probe',
      cliVersion: ' 0.60.0 ',
    },
    '  ': { models: [], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' },
  }),
  {
    codex: {
      models: [
        { id: 'gpt-5.6', displayName: 'GPT-5.6', contextWindow: 272000, effortLevels: ['low', 'high'], supportsFastMode: true },
        { id: 'gpt-5.4' },
      ],
      fetchedAt: '2026-07-26T00:00:00Z',
      source: 'argv-probe',
      cliVersion: '0.60.0',
    },
  },
  'rows are trimmed and deduped by id; wrong-typed fields drop to absent, not to a coerced value',
)
assert.deepEqual(
  normalizeCliModelCatalogs({
    'claude-code': { models: [], fetchedAt: '2026-07-26T00:00:00Z', source: 'agent-sdk' },
  }),
  { 'claude-code': { models: [], fetchedAt: '2026-07-26T00:00:00Z', source: 'agent-sdk' } },
  'a CLI that answered with no models keeps its entry — "listed nothing" is not "never probed"',
)
const catalogNormalized = normalizeAppSettings(
  {
    cliRuntimes: { codex: { command: 'codex', useWsl: false, models: ['o4-mini'] } },
    cliModelCatalog: {
      codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' },
      grok: { models: [{ id: 'grok-4' }], source: 'argv-probe' },
    },
  } as never,
  [],
)
assert.deepEqual(
  catalogNormalized.cliModelCatalog,
  { codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' } },
  'normalizeAppSettings carries a well-formed catalog and drops a malformed one',
)
assert.deepEqual(
  catalogNormalized.cliRuntimes.codex.models,
  ['o4-mini'],
  'the discovered catalog never leaks into the user list for the same CLI',
)

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
  settingsOverlay: { initialTab: null, checkForUpdatesRequestId: null } as SettingsOverlayState,
  automationsOverlay: { open: false, projectPath: null, runTarget: null },
  runSummaryOverlay: { open: false, workspaceId: null },
  activeGlobalSurface: null as string | null,
  activeModalSurface: null as string | null,
  sidebarCollapsed: false,
  sidebarWidth: 280,
  workspacePaneWidth: 420,
  workspacePaneMaximised: false,
  openFilesInExternalWindow: true,
  sprintEngineRoleRegistry: null,
  agentConfigAdoptionResult: null,
}
const slice = createSettingsSlice((mutator) => mutator(carrier))
// Settings is a MODAL (doors→modals, 2026-09-01; a door before that): opening
// it floats the modal over whatever owns the card region, and what stays in
// `settingsOverlay` is only the REQUEST — which category, and whether an
// update check was asked for.
slice.openSettingsOverlay({ initialTab: 'integrations', checkForUpdates: true })
assert.equal(carrier.activeModalSurface, 'settings', 'settings opens as a modal')
assert.equal(carrier.activeGlobalSurface, null, 'settings never routes the card region')
assert.equal(carrier.settingsOverlay.initialTab, 'integrations')
assert.equal(typeof carrier.settingsOverlay.checkForUpdatesRequestId, 'number')
slice.closeSettingsOverlay()
assert.equal(carrier.activeModalSurface, null, 'closing settings closes the modal')
assert.deepEqual(carrier.settingsOverlay, { initialTab: null, checkForUpdatesRequestId: null })

// Closing settings never clears somebody ELSE's modal — and never touches a
// door: the two are independent layers.
carrier.activeModalSurface = 'reviews'
carrier.activeGlobalSurface = 'backlog'
slice.closeSettingsOverlay()
assert.equal(carrier.activeModalSurface, 'reviews', 'another open modal survives a settings close')
assert.equal(carrier.activeGlobalSurface, 'backlog', 'an open door survives a settings close')
carrier.activeModalSurface = null
carrier.activeGlobalSurface = null

// openExtensionsSurface opens the Plugins DOOR (Extensions drawer ruling,
// 2026-09-05; a modal from 2026-09-01 until then, the MC-1847 door before
// that); closing is closeGlobalSurface. The caller can be inside the Settings
// modal (Settings → Modules "Browse marketplace"): the door routes the region
// the modal was floating over, so the modal closes and the settings request it
// was carrying goes with it rather than surviving to re-open a category later.
// The sidebar follows: Plugins is a drawer row, so leaving it lands on the
// drawer rather than on the workspaces tree.
carrier.activeModalSurface = 'settings'
carrier.sidebarSection = 'home'
carrier.settingsOverlay = { initialTab: 'modules', checkForUpdatesRequestId: null }
slice.openExtensionsSurface()
assert.equal(carrier.activeGlobalSurface, 'extensions', 'Browse marketplace lands on the Plugins door')
assert.equal(carrier.activeModalSurface, null, 'and the Settings modal it was opened from is gone')
assert.equal(carrier.sidebarSection, 'extensions', 'with the Extensions drawer beside it')
assert.equal('connectorsSurface' in carrier, false, 'the modal-era store flag is gone')
assert.equal(carrier.settingsOverlay.initialTab, null, 'the settings request does not outlive its modal')
slice.closeGlobalSurface()
assert.equal(carrier.activeGlobalSurface, null)
assert.equal(carrier.sidebarSection, 'extensions', 'and leaving the door lands back on the drawer')

// A door underneath survives a modal's open/close round-trip: the modal is a
// float over the card region, not a routing of it.
carrier.activeGlobalSurface = 'sprints'
slice.openModalSurface('reviews')
assert.equal(carrier.activeModalSurface, 'reviews')
assert.equal(carrier.activeGlobalSurface, 'sprints', 'the door under the modal stays put')
slice.closeModalSurface()
assert.equal(carrier.activeGlobalSurface, 'sprints', 'closing the modal lands back on the door')

// The reverse is NOT symmetric: opening a door closes the modal, or a history
// step to a door would mount it invisibly behind the modal's scrim.
slice.openModalSurface('reviews')
slice.openGlobalSurface('backlog')
assert.equal(carrier.activeGlobalSurface, 'backlog')
assert.equal(carrier.activeModalSurface, null, 'a door open closes the modal over it')
slice.openModalSurface('settings')
slice.openExtensionsSurface()
assert.equal(carrier.activeModalSurface, null, 'a named door convenience closes the modal too')
slice.closeGlobalSurface()
carrier.activeGlobalSurface = null

// Which SECTION a door open moves the sidebar to is the Extensions drawer
// ruling (2026-09-05), and it is not "always Extensions" any more. A door that
// is one of the drawer's five rows flips the section, so leaving it lands back
// on the drawer that opened it; Automations stands on the RAIL, so opening it
// leaves the section exactly where the operator had it — flipping there swapped
// the sidebar into a drawer nobody asked for and lit the Extensions glyph for a
// surface that is not one of its rows.
for (const drawerDoor of ['design', 'extensions', 'extensions-home', 'sprints']) {
  carrier.sidebarSection = 'home'
  slice.openGlobalSurface(drawerDoor)
  assert.equal(carrier.sidebarSection, 'extensions', `${drawerDoor} is a drawer door and moves the section`)
}
carrier.sidebarSection = 'home'
slice.openGlobalSurface('automations')
assert.equal(carrier.sidebarSection, 'home', 'Automations leaves the section alone — it stands on the rail')
slice.closeGlobalSurface()
carrier.activeGlobalSurface = null
carrier.sidebarSection = 'home'

// The door-routed full-page surface (global-surfaces epic 1704) is a mount kind,
// not an overlay: openGlobalSurface sets the active surface id, closeGlobalSurface
// clears it. Per-window and transient (unsynced/unpersisted — see
// extractSettingsFields, which omits it), like the Connectors/Roadmap flags.
slice.openGlobalSurface('roadmap')
assert.equal(carrier.activeGlobalSurface, 'roadmap')
slice.openGlobalSurface('backlog')
assert.equal(carrier.activeGlobalSurface, 'backlog', 'opening another door replaces the active surface')
slice.closeGlobalSurface()
assert.equal(carrier.activeGlobalSurface, null)

// `openRoadmapSurface` is gone with the Roadmap door it named: a named
// convenience for a surface nothing registers any more is an action whose only
// caller is its own test. `openGlobalSurface('roadmap')` above is the whole
// mechanism, and it is what the convenience had been reduced to.
assert.equal('openRoadmapSurface' in slice, false, 'the retired door takes its named opener with it')
assert.equal('roadmapSurface' in carrier, false, 'the legacy overlay store flag is gone')

// The workspace pane column (browser-pane epic) took over the aside column
// MC-1766 left vacant: the app-level width clamps to the column bounds, the
// maximised flag is a plain transient toggle, and the retired Sprint Engines
// aside keys are gone entirely.
assert.equal('sprintsAsideView' in carrier, false, 'the retired aside view lens is gone')
assert.equal('sprintEnginesAsideOpen' in carrier, false, 'the retired aside open flag is gone')
assert.equal('workspaceAsideOpen' in carrier, false, 'open/closed is per workspace now, not app state')
slice.setWorkspacePaneMaximised(true)
assert.equal(carrier.workspacePaneMaximised, true)
slice.setWorkspacePaneMaximised(false)
assert.equal(carrier.workspacePaneMaximised, false)
slice.setWorkspacePaneWidth(10_000)
assert.equal(carrier.workspacePaneWidth, 720, 'width clamps to the column max')
slice.setWorkspacePaneWidth(10)
assert.equal(carrier.workspacePaneWidth, 240, 'width clamps to the column min')
slice.setWorkspacePaneWidth(Number.NaN)
assert.equal(carrier.workspacePaneWidth, 420, 'a non-finite width falls back to the default')

// T3: the MCPs / Skill packs / Extensions settings tabs folded into the
// connectors surface — the Plugins DOOR again since the Extensions drawer
// ruling (2026-09-05; a modal from 2026-09-01, the MC-1847 door before that). A
// deep-link that once opened one of those tabs (by tab id, or the legacy
// Extensions browse deep-link) must open the surface, not a settings overlay on
// a tab that no longer exists.
for (const foldedTab of ['mcps', 'skill-packs', 'extensions', EXTENSIONS_BROWSE_DEEPLINK]) {
  carrier.activeModalSurface = null
  carrier.activeGlobalSurface = null
  carrier.settingsOverlay = { initialTab: null, checkForUpdatesRequestId: null }
  consumePendingExtensionsSurfaceTarget()
  slice.openSettingsOverlay({ initialTab: foldedTab })
  assert.equal(carrier.activeGlobalSurface, 'extensions', `${foldedTab} routes to the Plugins door`)
  assert.equal(carrier.activeModalSurface, null, `${foldedTab} leaves no modal floating over it`)
  assert.equal(carrier.settingsOverlay.initialTab, null, `${foldedTab} leaves no dangling settings tab`)
  // MC-1936: skill packs are gone, so the tab that named them lands on Skills —
  // the surface's other deep-links land on the Plugins catalogue, which is
  // what `browse` used to mean before the views were named for themselves
  // (source-tabs ruling, 2026-09-05).
  assert.deepEqual(
    consumePendingExtensionsSurfaceTarget(),
    { view: foldedTab === 'skill-packs' ? 'skills' : 'plugins' },
    `${foldedTab} lands on the view it was asking for`,
  )
}

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
        cliPermissionPreset: 'manual',
        maxConcurrentAgents: 3,
        deliveredAgentNotificationEventKeys: [],
      },
      createdAt: 1,
    } as Workspace,
  ],
  appSettings: defaultAppSettings(),
  settingsOverlay: { open: false, initialTab: null, checkForUpdatesRequestId: null },
  automationsOverlay: { open: false, projectPath: null, runTarget: null },
  runSummaryOverlay: { open: false, workspaceId: null },
  activeGlobalSurface: null,
  activeModalSurface: null,
  sidebarCollapsed: false,
  sidebarWidth: 280,
  workspacePaneWidth: 420,
  workspacePaneMaximised: false,
  openFilesInExternalWindow: true,
  sprintEngineRoleRegistry: null,
  agentConfigAdoptionResult: null,
}
const permissionSlice = createSettingsSlice((mutator) => mutator(permissionCarrier))
permissionSlice.setLastAgentSpawnPermissionPreset('bypass')
assert.equal(permissionCarrier.appSettings.lastAgentSpawnPermissionPreset, 'bypass')
assert.equal(
  permissionCarrier.workspaces[0].sprintEngineAutoState?.cliPermissionPreset,
  'bypass',
  'app default updates Sprint Engine runs that do not have a local override',
)
permissionCarrier.appSettings.sprintEngineRunSettings = {
  [sprintEngineRunSettingsKey(sprintEngineRunPath)]: { cliPermissionPreset: 'manual' },
}
permissionCarrier.workspaces[0].sprintEngineAutoState = {
  ...permissionCarrier.workspaces[0].sprintEngineAutoState!,
  cliPermissionPreset: 'manual',
}
permissionSlice.setLastAgentSpawnPermissionPreset('auto')
assert.equal(
  permissionCarrier.workspaces[0].sprintEngineAutoState?.cliPermissionPreset,
  'manual',
  'app default does not overwrite a Sprint Engine run with a local override',
)

const store = useWorkspaceStore.getState()
store.setSearchExcludes([' dist ', '!coverage', 'dist'])
assert.deepEqual(useWorkspaceStore.getState().appSettings.searchExcludes, ['dist', 'coverage'])
store.setLastSelectedCli('codex')
assert.equal(useWorkspaceStore.getState().appSettings.lastSelectedCli, 'codex')

store.setCliRuntime('codex', { command: 'codex', useWsl: false, models: ['o4-mini'] })
store.setCliModelCatalog('codex', {
  models: [{ id: 'gpt-5.6' }, { id: 'gpt-5.4' }],
  fetchedAt: '2026-07-26T00:00:00Z',
  source: 'argv-probe',
})
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.cliModelCatalog?.codex?.models,
  [{ id: 'gpt-5.6' }, { id: 'gpt-5.4' }],
  'setCliModelCatalog records what the CLI reported',
)
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.cliRuntimes.codex.models,
  ['o4-mini'],
  'writing the discovered catalog leaves the user list for that CLI untouched',
)
store.setCliModelCatalog('codex', {
  models: [{ id: 'gpt-5.6' }],
  fetchedAt: '2026-07-27T00:00:00Z',
  source: 'argv-probe',
})
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.cliModelCatalog?.codex?.models,
  [{ id: 'gpt-5.6' }],
  'a second probe replaces that CLI entry wholesale — a model it stopped listing is gone',
)
store.setCliModelCatalog('codex', { models: [{ id: 'gpt-5.6' }], fetchedAt: '', source: 'argv-probe' })
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.cliModelCatalog?.codex?.models,
  [{ id: 'gpt-5.6' }],
  'an unusable payload leaves the last good catalog in place instead of wiping it',
)
store.setCliModelCatalog('codex', null)
assert.equal(
  useWorkspaceStore.getState().appSettings.cliModelCatalog,
  undefined,
  'clearing the only entry leaves no empty catalog behind',
)

store.setSpecialistModelDefault('architect', { cli: 'claude-code', model: 'opus' })
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.specialistModelDefaults,
  { architect: { cli: 'claude-code', model: 'opus' } },
)
store.setSpecialistModelDefault('architect', null)
assert.deepEqual(useWorkspaceStore.getState().appSettings.specialistModelDefaults, {})

// Reasoning effort is per-CLI (owner ruling 2026-07-26): it outlives a model
// change within the CLI — including a switch to the CLI's own default model —
// and is dropped when the CLI changes, because level sets do not transfer.
const specialistModelDefaults = (): Record<string, unknown> =>
  useWorkspaceStore.getState().appSettings.specialistModelDefaults as Record<string, unknown>
store.setSpecialistReasoningDefault('architect', 'codex', 'high')
assert.deepEqual(
  specialistModelDefaults(),
  { architect: { cli: 'codex', model: '', reasoning: 'high' } },
  'a level can be set before any model is chosen',
)
store.setSpecialistModelDefault('architect', { cli: 'codex', model: 'gpt-5.6-sol' })
assert.deepEqual(
  specialistModelDefaults(),
  { architect: { cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' } },
  'choosing a model within the same CLI keeps the level',
)
store.setSpecialistModelDefault('architect', { cli: 'codex', model: '' })
assert.deepEqual(
  specialistModelDefaults(),
  { architect: { cli: 'codex', model: '', reasoning: 'high' } },
  'choosing the CLI default model keeps the level',
)
store.setSpecialistModelDefault('architect', { cli: 'claude-code', model: 'claude-opus-5' })
assert.deepEqual(
  specialistModelDefaults(),
  { architect: { cli: 'claude-code', model: 'claude-opus-5' } },
  'switching CLI drops a level chosen for the previous CLI',
)
store.setSpecialistReasoningDefault('architect', 'codex', 'ultra')
assert.deepEqual(
  specialistModelDefaults(),
  { architect: { cli: 'codex', model: '', reasoning: 'ultra' } },
  'a level for another CLI starts that CLI on its own default model',
)
store.setSpecialistReasoningDefault('architect', 'codex', null)
assert.deepEqual(
  specialistModelDefaults(),
  {},
  'clearing the only remaining choice leaves no empty selection behind',
)
store.setSpecialistModelDefault('architect', { cli: 'codex', model: 'gpt-5.5' })
store.setSpecialistReasoningDefault('architect', 'codex', 'xhigh')
store.setSpecialistReasoningDefault('architect', 'codex', '   ')
assert.deepEqual(
  specialistModelDefaults(),
  { architect: { cli: 'codex', model: 'gpt-5.5' } },
  'clearing the level keeps the model',
)
store.setSpecialistReasoningDefault('architect', 'codex', 'high')
store.setSpecialistModelDefault('architect', null)
assert.deepEqual(
  specialistModelDefaults(),
  {},
  'an explicit null clears the whole selection, level included',
)
// Retiring a custom model id must retire it as a remembered launch default too:
// a surface still naming it would pass `--model <deleted id>` and the agent dies
// on a model nothing offers.
store.setSpecialistModelDefault('architect', { cli: 'claude-code', model: 'fable-5.1' })
store.setSpecialistModelDefault('__general__' as never, { cli: 'claude-code', model: 'fable-5.1' })
store.setSpecialistModelDefault('frontend-design-review', { cli: 'codex', model: 'fable-5.1' })
store.forgetCliModels('claude-code', ['fable-5.1'])
assert.deepEqual(
  specialistModelDefaults(),
  { 'frontend-design-review': { cli: 'codex', model: 'fable-5.1' } },
  'every default naming the retired id for that CLI falls back to the CLI default; another CLI is untouched',
)
store.setSpecialistModelDefault('architect', { cli: 'claude-code', model: 'fable-5.1' })
store.setSpecialistReasoningDefault('architect', 'claude-code', 'high')
store.forgetCliModels('claude-code', ['  fable-5.1  '])
assert.deepEqual(
  specialistModelDefaults()['architect'],
  { cli: 'claude-code', model: '', reasoning: 'high' },
  'the level survives — it was chosen for the CLI, not for the model that went away',
)
store.forgetCliModels('claude-code', ['', '   '])
assert.deepEqual(
  specialistModelDefaults()['architect'],
  { cli: 'claude-code', model: '', reasoning: 'high' },
  'a blank id forgets nothing',
)
store.setSpecialistModelDefault('architect', null)
store.setSpecialistModelDefault('frontend-design-review', null)
store.setSpecialistModelDefault('__general__' as never, null)

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

// Writes through a migrated command id must clear state persisted under its
// legacy id (LEGACY_COMMAND_ID_ALIASES), or the legacy-honoring read paths
// resurrect it and e.g. a pre-rename disable can never be undone (MC-1533
// re-namespacing; ported from extraction-branch commits 52d05235/0e57e36f).
store.setCommandKeybindingDisabled('watchtower.run.review', true)
store.setCommandKeybindingDisabled('switchboard.watchtower.run.review', false)
assert.equal(
  useWorkspaceStore.getState().appSettings.keybindings.disabled['watchtower.run.review'],
  undefined,
  're-enabling under the current id clears a legacy-id disabled flag',
)
store.setCommandKeybindings('watchtower.run.review', ['Primary+R'])
store.setCommandKeybindings('switchboard.watchtower.run.review', ['Primary+Shift+R'])
assert.equal(
  useWorkspaceStore.getState().appSettings.keybindings.overrides['watchtower.run.review'],
  undefined,
  'overriding under the current id drops the legacy-id override',
)
store.setCommandKeybindings('switchboard.watchtower.run.review', [])
assert.equal(
  useWorkspaceStore.getState().appSettings.keybindings.overrides['switchboard.watchtower.run.review'],
  undefined,
  'clearing under the current id removes its override',
)
store.setCommandKeybindings('watchtower.run.review', ['Primary+R'])
store.setCommandKeybindingDisabled('watchtower.run.review', true)
store.resetCommandKeybindings('switchboard.watchtower.run.review')
assert.deepEqual(
  [
    useWorkspaceStore.getState().appSettings.keybindings.overrides['watchtower.run.review'],
    useWorkspaceStore.getState().appSettings.keybindings.disabled['watchtower.run.review'],
  ],
  [undefined, undefined],
  'resetCommandKeybindings clears legacy-id override and disabled flag',
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
  { architect: 1, frontend: 1, tester: 0 },
  'saved roster counts load as an enabled set (MC-1450): legacy count > 0 collapses to 1, architect stays present',
)
assert.deepEqual(
  normalizedSavedRoster.sprintEngineRoleSettings.savedRoster?.roleCliDefaults,
  { architect: 'codex', tester: 'opencode' },
  'saved roster normalization trims CLI defaults and drops blank values',
)

// A legacy single saved roster migrates into a selectable named team so users
// keep their saved config when teams ship.
assert.equal(
  normalizedSavedRoster.sprintEngineRoleSettings.savedRosters?.length,
  1,
  'legacy savedRoster migrates into one named team',
)
assert.equal(
  normalizedSavedRoster.sprintEngineRoleSettings.savedRosters?.[0]?.name,
  'Saved roster',
  'migrated team gets a default name',
)
assert.equal(
  normalizedSavedRoster.sprintEngineRoleSettings.lastSelectedRosterId,
  normalizedSavedRoster.sprintEngineRoleSettings.savedRosters?.[0]?.id,
  'the migrated team is pre-selected so legacy users open on their roster',
)

// Once a savedRosters key exists (even empty), the legacy roster must NOT be
// re-migrated — otherwise a user who deletes their last team would see it
// resurrected on the next normalize/reload.
const normalizedAfterDeleteAll = normalizeAppSettings(
  {
    sprintEngineRoleSettings: {
      enabled: {},
      savedRosters: [],
      savedRoster: { roleCounts: { architect: 1 }, roleCliDefaults: { architect: 'codex' } },
    },
  },
  [],
)
assert.equal(
  normalizedAfterDeleteAll.sprintEngineRoleSettings.savedRosters?.length,
  0,
  'an explicit empty savedRosters list is not re-migrated from the legacy roster',
)

// --- MC-1874: one-time savedTeams -> savedRosters key migration ------------
// A settings blob written by the PREVIOUS build carries `savedTeams` /
// `lastSelectedTeamId`. It must load with its rosters intact under the new key,
// keep its selection, and — critically — a second normalize pass over the
// already-migrated output must not re-run anything.
const legacyBlob = {
  sprintEngineRoleSettings: {
    enabled: {},
    savedTeams: [
      {
        id: 'bihOkvw7kvxXoKTxOfmrD',
        name: 'opus',
        roleCounts: { architect: 1, frontend: 1, developer: 1 },
        roleCliDefaults: { architect: 'claude-code', frontend: 'claude-code' },
        roleModelOverrides: { architect: 'claude-opus-5' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
    ],
    lastSelectedTeamId: 'bihOkvw7kvxXoKTxOfmrD',
  },
}
const migrated = normalizeAppSettings(legacyBlob, []).sprintEngineRoleSettings
assert.equal(migrated.savedRosters?.length, 1, 'legacy savedTeams migrates into savedRosters')
assert.equal(migrated.savedRosters?.[0]?.name, 'opus', 'the migrated roster keeps its name')
assert.equal(
  migrated.savedRosters?.[0]?.id,
  'bihOkvw7kvxXoKTxOfmrD',
  'the migrated roster keeps its id, so a horizon or automation naming it still resolves',
)
assert.deepEqual(
  migrated.savedRosters?.[0]?.roleCounts,
  { architect: 1, frontend: 1, developer: 1 },
  'the migrated roster keeps its staffing',
)
assert.equal(
  migrated.savedRosters?.[0]?.roleModelOverrides?.architect,
  'claude-opus-5',
  'the migration is lossless for per-role model overrides',
)
assert.equal(
  migrated.lastSelectedRosterId,
  'bihOkvw7kvxXoKTxOfmrD',
  'lastSelectedTeamId carries over so the wizard opens on the same roster',
)

// Idempotence: normalizing the migrated OUTPUT (which has `savedRosters` and no
// `savedTeams`) leaves it byte-equal. This is what a second app launch does.
const reNormalized = normalizeAppSettings(
  { sprintEngineRoleSettings: migrated },
  [],
).sprintEngineRoleSettings
assert.deepEqual(reNormalized, migrated, 'a second load does not re-run the migration')

// Key ABSENCE, not emptiness, is the legacy signal — a user who deleted every
// roster on the new build must not see the pre-rename list resurrected.
// Hoisted like `legacyBlob` above: `savedTeams` is a pre-rename key that no
// longer exists on the type, so it only survives as a stored-JSON shape.
const deletedAllBlob = {
  sprintEngineRoleSettings: {
    enabled: {},
    savedRosters: [],
    savedTeams: [
      {
        id: 'ghost',
        name: 'ghost',
        roleCounts: { architect: 1 },
        roleCliDefaults: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    lastSelectedTeamId: 'ghost',
  },
}
const deletedAllAfterMigration = normalizeAppSettings(
  deletedAllBlob,
  [],
).sprintEngineRoleSettings
assert.equal(
  deletedAllAfterMigration.savedRosters?.length,
  0,
  'an explicit empty savedRosters list is never repopulated from the legacy savedTeams key',
)
assert.equal(
  deletedAllAfterMigration.lastSelectedRosterId,
  null,
  'nor does the legacy selection pointer survive once the new key exists',
)

// --- Named roster teams --------------------------------------------------
const teamStore = useWorkspaceStore.getState()
const lightweightId = teamStore.saveSprintEngineRoster({
  name: 'Lightweight',
  roleCounts: { architect: 1, developer: 1 },
  roleCliDefaults: { architect: 'claude-code', developer: 'codex' },
})
assert.ok(lightweightId, 'saving a team returns an id')
const afterSave = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
const teamCountAfterSave = afterSave.savedRosters?.length ?? 0
assert.equal(afterSave.lastSelectedRosterId, lightweightId, 'saving selects the new team')
const savedLightweight = afterSave.savedRosters?.find((team) => team.id === lightweightId)
assert.equal(savedLightweight?.name, 'Lightweight', 'team name persists')
// savedRoster mirrors the active team so the run-mount CLI-default fallback stays meaningful.
assert.deepEqual(
  afterSave.savedRoster?.roleCliDefaults,
  { architect: 'claude-code', developer: 'codex' },
  'saving a team mirrors its CLI defaults into savedRoster',
)

// Saving with the same id updates the team in place rather than adding a new one.
teamStore.saveSprintEngineRoster({
  id: lightweightId,
  name: 'Lightweight v2',
  roleCounts: { architect: 1, developer: 2 },
  roleCliDefaults: { architect: 'claude-code' },
})
const afterUpdate = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
assert.equal(afterUpdate.savedRosters?.length, teamCountAfterSave, 'updating a team does not add a duplicate')
const updatedLightweight = afterUpdate.savedRosters?.find((team) => team.id === lightweightId)
assert.equal(updatedLightweight?.name, 'Lightweight v2', 'team name updates in place')
assert.deepEqual(
  updatedLightweight?.roleCounts,
  { architect: 1, developer: 1 },
  'team role counts update in place as an enabled set (legacy count > 1 collapses, MC-1450)',
)

// A blank name is rejected.
assert.equal(
  teamStore.saveSprintEngineRoster({
    name: '   ',
    roleCounts: { architect: 1 },
    roleCliDefaults: {},
  }),
  '',
  'a blank team name is rejected',
)

// Renaming changes only the name, leaving the saved roster untouched.
teamStore.renameSprintEngineRoster(lightweightId, '  Featherweight  ')
const afterRename = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
const renamedTeam = afterRename.savedRosters?.find((team) => team.id === lightweightId)
assert.equal(renamedTeam?.name, 'Featherweight', 'rename trims and applies the new name')
assert.deepEqual(
  renamedTeam?.roleCounts,
  { architect: 1, developer: 1 },
  'rename leaves the saved roster counts intact',
)
// A blank rename and an unknown id are no-ops rather than throwing or clearing.
teamStore.renameSprintEngineRoster(lightweightId, '   ')
assert.equal(
  useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.savedRosters
    ?.find((team) => team.id === lightweightId)?.name,
  'Featherweight',
  'a blank rename is ignored',
)
teamStore.renameSprintEngineRoster('does-not-exist', 'Ghost')
assert.ok(
  !useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.savedRosters
    ?.some((team) => team.name === 'Ghost'),
  'renaming an unknown id is a no-op',
)

// Deleting the selected team clears the selection.
teamStore.deleteSprintEngineRoster(lightweightId)
const afterDelete = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
assert.ok(
  !afterDelete.savedRosters?.some((team) => team.id === lightweightId),
  'deleting removes the team',
)
assert.equal(afterDelete.lastSelectedRosterId, null, 'deleting the selected team clears selection')

// --- Per-role model overrides persist with the team ----------------------
const modelTeamId = teamStore.saveSprintEngineRoster({
  name: 'Model team',
  roleCounts: { architect: 1, developer: 1 },
  roleCliDefaults: { developer: 'codex' },
  // A null "CLI default" pick is dropped by normalization; only explicit ids persist.
  roleModelOverrides: { developer: 'opus', architect: null },
})
const afterModelSave = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
const savedModelTeam = afterModelSave.savedRosters?.find((team) => team.id === modelTeamId)
assert.deepEqual(
  savedModelTeam?.roleModelOverrides,
  { developer: 'opus' },
  'an explicit role model persists on the saved team; a null CLI-default pick is dropped',
)
assert.deepEqual(
  afterModelSave.savedRoster?.roleModelOverrides,
  { developer: 'opus' },
  'saving a team mirrors its model overrides into savedRoster',
)
// Re-saving with the models cleared drops them (explicit overwrite, not merge).
teamStore.saveSprintEngineRoster({
  id: modelTeamId,
  name: 'Model team',
  roleCounts: { architect: 1, developer: 1 },
  roleCliDefaults: { developer: 'codex' },
  roleModelOverrides: {},
})
const afterModelClear = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
  .savedRosters?.find((team) => team.id === modelTeamId)
assert.equal(
  afterModelClear?.roleModelOverrides ?? undefined,
  undefined,
  'clearing every model override drops the stale map on update',
)

// --- MC-2064: a roster is a set of roles — the `mode` formation is deleted --
// Saving stores no formation, and a `mode` key persisted by an older profile
// (any value, 'pool' included) is dropped on normalization rather than
// migrated: owner ruling, no users and no saved pools.
const rolesOnlyRosterId = teamStore.saveSprintEngineRoster({
  name: 'Pooled',
  roleCounts: { architect: 1, developer: 1 },
  roleCliDefaults: { architect: 'claude-code' },
})
const savedRolesOnly = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
  .savedRosters?.find((roster) => roster.id === rolesOnlyRosterId)
assert.ok(savedRolesOnly && !('mode' in savedRolesOnly), 'a saved roster carries no formation key')

const modeNormalized = normalizeAppSettings(
  {
    sprintEngineRoleSettings: {
      enabled: {},
      savedRosters: [
        { id: 'legacy', name: 'Legacy', roleCounts: { architect: 1 }, roleCliDefaults: {}, createdAt: 1, updatedAt: 1 },
        // A roster persisted while MC-1875's formation axis existed — the type
        // can no longer express it, it only exists as stored JSON, so the
        // legacy field arrives via a spread the excess-property check skips.
        { id: 'pooled', name: 'Pooled legacy', roleCounts: { architect: 1 }, roleCliDefaults: {}, createdAt: 1, updatedAt: 1, ...({ mode: 'pool' } as object) },
        { id: 'bogus', name: 'Bogus', roleCounts: { architect: 1 }, roleCliDefaults: {}, createdAt: 1, updatedAt: 1, ...({ mode: 'architect' } as object) },
      ],
    },
  },
  [],
).sprintEngineRoleSettings
for (const [index, what] of [
  [0, 'a roster that never had one'],
  [1, 'a persisted pool formation'],
  [2, 'an unknown formation value'],
] as const) {
  assert.ok(
    !('mode' in (modeNormalized.savedRosters?.[index] ?? {})),
    `${what} normalizes to no mode key — the formation axis is deleted, not migrated`,
  )
}

// --- MC-1876: the built-in "No roles" is synthetic and reserved ------------
// Enforced in the STORE, not just in the UI's validation — "cannot be renamed,
// edited, or deleted" has to be true of the data layer, or it is merely
// unreachable through the happy path.
{
  const before = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.savedRosters?.length ?? 0
  assert.equal(
    teamStore.saveSprintEngineRoster({
      name: 'No roles',
      roleCounts: { architect: 1 },
      roleCliDefaults: {},
    }),
    '',
    'saving a user roster named "No roles" is refused',
  )
  assert.equal(
    teamStore.saveSprintEngineRoster({
      id: 'builtin:no-roles',
      name: 'Hijack',
      roleCounts: { architect: 1 },
      roleCliDefaults: {},
    }),
    '',
    'and so is claiming the reserved id',
  )
  assert.equal(
    useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.savedRosters?.length ?? 0,
    before,
    'neither refusal wrote a roster',
  )
}

// Picking the built-in STICKS. Without this the pointer would clear (the
// built-in is not in savedRosters by design) and the next resolve would fall
// through to the legacy savedRoster mirror — silently re-staffing "No roles"
// with the last specialist roster the user touched.
{
  teamStore.setSprintEngineLastSelectedRoster('builtin:no-roles')
  assert.equal(
    useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings.lastSelectedRosterId,
    'builtin:no-roles',
    'selecting the built-in persists',
  )
  // And survives a normalize pass, which validates ids against savedRosters.
  const reloaded = normalizeAppSettings(
    { sprintEngineRoleSettings: useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings },
    [],
  ).sprintEngineRoleSettings
  assert.equal(
    reloaded.lastSelectedRosterId,
    'builtin:no-roles',
    'and is not cleared by normalization for being absent from savedRosters',
  )
}

// A hand-edited settings file cannot smuggle in a roster that shadows the
// built-in by id or by name.
{
  const shadowed = normalizeAppSettings(
    {
      sprintEngineRoleSettings: {
        enabled: {},
        savedRosters: [
          { id: 'builtin:no-roles', name: 'Impostor', roleCounts: { architect: 1 }, roleCliDefaults: {}, createdAt: 1, updatedAt: 1 },
          { id: 'x', name: 'No roles', roleCounts: { architect: 1 }, roleCliDefaults: {}, createdAt: 1, updatedAt: 1 },
          { id: 'y', name: 'Legit', roleCounts: { architect: 1 }, roleCliDefaults: {}, createdAt: 1, updatedAt: 1 },
        ],
      },
    },
    [],
  ).sprintEngineRoleSettings
  assert.deepEqual(
    shadowed.savedRosters?.map((roster) => roster.name),
    ['Legit'],
    'a persisted roster wearing the reserved id or name is dropped on load',
  )
}

// --- Specialist menu ordering --------------------------------------------
// Normalization keeps only known specialist ids, drops duplicates, and ignores
// junk so a stale or hand-edited settings file is always safe to load.
assert.deepEqual(
  normalizeSpecialistOrder(['developer', 'architect', 'developer', 'marketer', 42, '']),
  ['developer', 'architect', 'marketer'],
  'normalizeSpecialistOrder keeps unique non-empty ids (incl. registry-discovered) in order, dropping dupes and non-strings',
)
assert.deepEqual(normalizeSpecialistOrder(undefined), [], 'missing order normalizes to empty')

// orderSpecialistActions honors the saved order first, then the curated display
// order, then appends any remaining specialists without dropping them. The
// roster is registry-sourced now, so the caller supplies the actions.
const roster = ['tester', 'developer', 'architect'].map((id) => getSpecialistAction(id))
const reordered = orderSpecialistActions(['developer', 'architect'], roster)
assert.equal(reordered[0].id, 'developer', 'saved order leads the roster')
assert.equal(reordered[1].id, 'architect', 'saved order is respected in sequence')
assert.equal(
  new Set(reordered.map((action) => action.id)).size,
  reordered.length,
  'ordered roster has no duplicates',
)
assert.equal(
  reordered.length,
  orderSpecialistActions([], roster).length,
  'reordering never adds or drops specialists vs the provided roster',
)
// MC-1542: the code-review / spec-review / nuclear-review specialists were
// retired alongside their reviewer souls; their soul-startup-prompt assertions
// are removed. A surviving manual specialist still exercises the prompt path.
{
  const performancePrompt = buildSpecialistSoulStartupPrompt(getSpecialistAction('performance'))
  assert.equal(performancePrompt.includes('souls get performance'), true)
  assert.equal(
    performancePrompt.includes('wait for the user to give you a task or question'),
    true,
    'manual specialist launch waits for an explicit user task after loading the Soul',
  )
  assert.equal(performancePrompt.includes('git diff'), false, 'manual specialist launch does not auto-review diffs')
}

// The persisted setter normalizes whatever the drag handler hands it: dupes and
// non-strings are dropped, but registry-discovered ids (unknown at this layer)
// are kept so a dropped-in specialist pack's order survives.
store.setSpecialistOrder(['developer', 'developer', 'frontend-design-review', 'marketer'])
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.specialistOrder,
  ['developer', 'frontend-design-review', 'marketer'],
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

// --- MC-1587 bundled specialist-pack migration guard -------------------------

// Fresh profile: defaults skip the migration so nothing installs.
assert.equal(
  defaultAppSettings().specialistPacks.migratedBundledPack,
  true,
  'fresh profile defaults to migratedBundledPack true so the migration is a no-op',
)

// A returning profile (persisted specialistPacks without the flag) resolves to
// false so the one-time migration still evaluates it.
assert.deepEqual(
  normalizeSpecialistPacks({ disabled: ['other-pack'] }),
  { disabled: ['other-pack'], migratedBundledPack: false },
  'a persisted pack config without the flag reads as not-yet-migrated',
)
assert.deepEqual(
  normalizeSpecialistPacks({ disabled: [], migratedBundledPack: true }),
  { disabled: [], migratedBundledPack: true },
  'an explicit migrated flag round-trips',
)
assert.deepEqual(
  normalizeSpecialistPacks(undefined),
  { disabled: [], migratedBundledPack: false },
  'missing pack config reads as not-yet-migrated',
)
// A returning profile (modulesChosen persisted, or workspaces present) with no
// recorded migration → flag false so it runs once.
assert.equal(
  normalizeAppSettings({ specialistPacks: { disabled: [] } as unknown as { disabled: string[]; migratedBundledPack: boolean }, modulesChosen: true }, []).specialistPacks
    .migratedBundledPack,
  false,
  'normalizeAppSettings defaults a returning profile to not-yet-migrated',
)
// A fresh profile (no workspaces, no persisted modulesChosen) → flag true so it
// installs nothing. This is the load-bearing guard for acceptance: hydration
// always runs normalizeAppSettings, so the fresh default must resolve here.
assert.equal(
  normalizeAppSettings({ specialistPacks: { disabled: [] } as unknown as { disabled: string[]; migratedBundledPack: boolean } }, []).specialistPacks.migratedBundledPack,
  true,
  'normalizeAppSettings defaults a fresh profile to already-migrated (installs nothing)',
)
// An explicit persisted flag always wins over the fresh-vs-returning fallback.
assert.equal(
  normalizeAppSettings({ specialistPacks: { disabled: [], migratedBundledPack: false }, modulesChosen: false }, [])
    .specialistPacks.migratedBundledPack,
  false,
  'a persisted false flag is honored even for a fresh-looking profile',
)

const packStore = useWorkspaceStore.getState()
// Toggling a pack must preserve the migration guard (a later uninstall must not
// be undone by re-running the migration).
packStore.markBundledSpecialistPackMigrated()
assert.equal(
  useWorkspaceStore.getState().appSettings.specialistPacks.migratedBundledPack,
  true,
  'markBundledSpecialistPackMigrated sets the guard',
)
packStore.setSpecialistPackEnabled('multicode-specialists', false)
assert.equal(
  useWorkspaceStore.getState().appSettings.specialistPacks.migratedBundledPack,
  true,
  'toggling a pack preserves the migration guard',
)
assert.deepEqual(
  useWorkspaceStore.getState().appSettings.specialistPacks.disabled,
  ['multicode-specialists'],
  'toggling still records the disabled pack',
)

// --- Design Wizard transport default (T12) ---------------------------------
// The default profile ships opt-out: conversation sessions are off, so a Claude
// design specialist takes the terminal path. Pins the acceptance criterion end
// to end — the hydrated default feeds the transport selector.
const defaultConversationEnabled =
  normalizeAppSettings({}, []).guidedBriefConversationSessions === true
assert.equal(
  defaultConversationEnabled,
  false,
  'guidedBriefConversationSessions defaults to off (opt-out)',
)
assert.equal(
  guidedBriefTransportForCli('claude-code', {
    conversationSessionsEnabled: defaultConversationEnabled,
    hasWorkspaceId: true,
  }),
  'terminal',
  "transportForCli('claude-code') === 'terminal' at default settings",
)

// One-time reset (MC-1802, store v67): the pre-opt-in default was `true`, so
// persist wrote it to every existing profile. An un-stamped stored `true` is
// therefore indistinguishable from that old default and is cleared — the whole
// installed base returns to the terminal path until someone opts in.
const preFlipProfile = normalizeAppSettings({ guidedBriefConversationSessions: true }, [])
assert.equal(
  preFlipProfile.guidedBriefConversationSessions,
  false,
  'a persisted true written before the opt-in flip is reset',
)
assert.equal(
  preFlipProfile.guidedBriefConversationSessionsOptInReset,
  true,
  'normalizing stamps the profile so the reset runs exactly once',
)
assert.equal(
  normalizeAppSettings(preFlipProfile, []).guidedBriefConversationSessions,
  false,
  're-normalizing the reset profile leaves it off (the reset is not re-applied to a value nobody set)',
)

// Post-reset the stamp rides in the same settings object, so an opt-in recorded
// after it is explicit by construction and survives every later hydration.
assert.equal(
  normalizeAppSettings(
    { guidedBriefConversationSessions: true, guidedBriefConversationSessionsOptInReset: true },
    [],
  ).guidedBriefConversationSessions,
  true,
  'a profile that opts in after the reset keeps conversation sessions on',
)
assert.equal(
  guidedBriefTransportForCli('claude-code', { conversationSessionsEnabled: true, hasWorkspaceId: true }),
  'conversation',
  'a user who opted in gets the conversation transport for Claude',
)
for (const stored of [undefined, false, 1 as unknown as boolean, 'true' as unknown as boolean]) {
  assert.equal(
    normalizeAppSettings(
      { guidedBriefConversationSessions: stored, guidedBriefConversationSessionsOptInReset: true },
      [],
    ).guidedBriefConversationSessions,
    false,
    `a non-true stored value (${String(stored)}) resolves to off`,
  )
}
assert.equal(
  normalizeAppSettings({}, []).guidedBriefConversationSessionsOptInReset,
  true,
  'a fresh profile is stamped without ever having been on',
)

// Non-Claude CLIs and workspace-less runs never take the conversation path,
// even when the opt-in is on.
assert.equal(
  guidedBriefTransportForCli('codex', { conversationSessionsEnabled: true, hasWorkspaceId: true }),
  'terminal',
  'non-Claude CLIs always take the terminal path',
)
assert.equal(
  guidedBriefTransportForCli('claude-code', { conversationSessionsEnabled: true, hasWorkspaceId: false }),
  'terminal',
  'a workspace-less run takes the terminal path',
)

// The explicit setter records the user's choice verbatim, and stores exactly
// `true` only for an explicit enable.
const transportStore = useWorkspaceStore.getState()
transportStore.setGuidedBriefConversationSessions(true)
assert.equal(
  useWorkspaceStore.getState().appSettings.guidedBriefConversationSessions,
  true,
  'setGuidedBriefConversationSessions(true) opts in',
)
assert.equal(
  normalizeAppSettings(useWorkspaceStore.getState().appSettings, []).guidedBriefConversationSessions,
  true,
  'the opt-in survives the next hydration (the stamp travels with the setting)',
)
transportStore.setGuidedBriefConversationSessions(false)
assert.equal(
  useWorkspaceStore.getState().appSettings.guidedBriefConversationSessions,
  false,
  'setGuidedBriefConversationSessions(false) opts out',
)

// The two review keys that used to live here moved onto review's own app-level
// module state (MC-2090); their behavior is pinned in reviewAppState.test.ts.
// What stays core's job is the one-time lift of a profile that still carries
// them — core's own persisted rows, which only core can read once the field is
// gone from AppSettings. Same shape as the MC-1708 review-workspace retirement.
const liftedFromLegacy = normalizeAppSettings(
  {
    reviewGuideDefaults: { depth: 'thorough', cli: 'codex', model: 'gpt-5-codex' },
    lastSelectedReview: { reviewId: 'rv_b', workspaceRoot: '/proj/multicode' },
  } as never,
  [],
).moduleSettings
assert.deepEqual(
  liftedFromLegacy['module:review'],
  {
    'guide-defaults': { depth: 'thorough', cli: 'codex', model: 'gpt-5-codex' },
    'last-selected-review': { reviewId: 'rv_b', workspaceRoot: '/proj/multicode' },
  },
  'a profile predating the move keeps both values, in the module namespace',
)
// Values pass through untouched: the owning module normalizes what it reads, so
// core keeps no knowledge of their shape.
assert.deepEqual(
  normalizeAppSettings({ reviewGuideDefaults: { depth: 'exhaustive' } } as never, [])
    .moduleSettings['module:review'],
  { 'guide-defaults': { depth: 'exhaustive' } },
  'the lift copies verbatim — validation belongs to the module that reads it',
)
// A value the module has already written wins: the lift must never clobber a
// newer choice with the legacy one it superseded.
assert.deepEqual(
  normalizeAppSettings(
    {
      reviewGuideDefaults: { depth: 'brief', cli: null, model: null },
      moduleSettings: { 'module:review': { 'guide-defaults': { depth: 'thorough', cli: null, model: null } } },
    } as never,
    [],
  ).moduleSettings['module:review'],
  { 'guide-defaults': { depth: 'thorough', cli: null, model: null } },
  'an already-migrated value is not overwritten by the legacy key',
)
assert.equal(
  normalizeAppSettings({} as never, []).moduleSettings['module:review'],
  undefined,
  'a profile with neither key gains no namespace at all',
)

// Appearance: windowMaterial is a second axis beside theme (MC-1907).
assert.deepEqual(defaultAppearanceSettings(), { theme: 'system', windowMaterial: 'solid' })
assert.deepEqual(normalizeAppearanceSettings(undefined), defaultAppearanceSettings())
assert.deepEqual(normalizeAppearanceSettings({ theme: 'sage', windowMaterial: 'glass' }), {
  theme: 'sage',
  windowMaterial: 'glass',
})
assert.deepEqual(
  normalizeAppearanceSettings({ theme: 'sage' }),
  { theme: 'sage', windowMaterial: 'solid' },
  'a persisted appearance predating the material axis hydrates to solid',
)
assert.deepEqual(
  normalizeAppearanceSettings({ theme: 'nope', windowMaterial: 'frosted' }),
  defaultAppearanceSettings(),
  'unknown theme and material values both fall back to defaults',
)

// --- Retired onboarding wizard: the migration off `onboardingStep` -----------
// These are the acceptance guard for "an upgrade never sees the first-run card".
// The wizard's two persisted signals are read here, once, and converted into one
// boolean; getting this wrong asks a five-year user to set up their agent CLI.
{
  const someWorkspace = [{ id: 'w1' } as unknown as Workspace]

  assert.equal(
    normalizeAppSettings(undefined, []).firstRunCliCardDismissed,
    false,
    'a genuinely fresh profile has not dismissed anything',
  )
  assert.equal(
    normalizeAppSettings({}, someWorkspace).firstRunCliCardDismissed,
    true,
    'a profile with workspaces was already in use — never ask it',
  )
  assert.equal(
    normalizeAppSettings({ modulesChosen: true }, []).firstRunCliCardDismissed,
    true,
    'the legacy modulesChosen signal marks a returning profile',
  )
  assert.equal(
    normalizeAppSettings({ onboardingStep: 'complete' } as never, []).firstRunCliCardDismissed,
    true,
    'a profile that finished the wizard is a returning profile',
  )
  assert.equal(
    normalizeAppSettings({ onboardingStep: 'modules' } as never, []).firstRunCliCardDismissed,
    true,
    'a profile part-way through the wizard was already in use',
  )
  // The deliberate exception: this profile installed the app, saw the very first
  // screen, quit, and upgraded. It never used anything — it is the fresh user
  // the card exists for, and treating it as returning would hide the card from
  // exactly the person who needs it.
  assert.equal(
    normalizeAppSettings({ onboardingStep: 'welcome' } as never, []).firstRunCliCardDismissed,
    false,
    'a profile parked at welcome with no workspaces is fresh, not returning',
  )
  // An explicit persisted value always wins, in both directions.
  assert.equal(
    normalizeAppSettings({ firstRunCliCardDismissed: true }, []).firstRunCliCardDismissed,
    true,
  )
  assert.equal(
    normalizeAppSettings({ firstRunCliCardDismissed: false }, someWorkspace).firstRunCliCardDismissed,
    false,
    'a user who has not dismissed the card keeps not having dismissed it',
  )

  // Adoption is offered once. An existing install already had its chance through
  // the wizard's card, so it is never re-run against their project.
  assert.equal(normalizeAppSettings(undefined, []).hasAdoptedAgentConfig, false)
  assert.equal(normalizeAppSettings({}, someWorkspace).hasAdoptedAgentConfig, true)
  assert.equal(
    normalizeAppSettings({ hasAdoptedAgentConfig: false }, someWorkspace).hasAdoptedAgentConfig,
    false,
    'an explicit persisted value wins over the returning-profile default',
  )
}

// normalizeSelectedCli: hooks-only selectability at READ time — a persisted
// selection naming a CLI that is not agent-selectable (muse, generic-shell)
// normalizes to the fallback here, so every picker shows the real default
// before any spawn instead of a spawn-time silent swap. Unknown ids pass
// (a user plugin may be eligible; the catalog owns that question).
assert.equal(normalizeSelectedCli('claude-code'), 'claude-code')
assert.equal(normalizeSelectedCli('some-user-cli'), 'some-user-cli')
assert.equal(normalizeSelectedCli('muse'), 'claude-code', 'a non-selectable persisted CLI normalizes to the default')
assert.equal(normalizeSelectedCli('generic-shell'), 'claude-code')
assert.equal(normalizeSelectedCli('muse', 'codex'), 'codex', 'the caller fallback wins when eligible')
assert.equal(normalizeSelectedCli('muse', 'generic-shell'), 'claude-code', 'an ineligible fallback falls to the stock default')
assert.equal(normalizeSelectedCli(null), 'claude-code')

// Sync's own writer. Adding a server is a person wiring something up, and
// `upsertMcpServer` turns MCP config sync on for them; refreshing a server they
// already have is not, so pressing Sync on a source must not re-enable a
// setting they deliberately turned off
// (backlog/2026-09-06-mcp-installs-carry-source-provenance.md).
{
  const server = {
    id: 'context7',
    name: 'Context7',
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    enabled: true,
    clients: ['codex'],
    scope: 'workspace' as const,
    source: 'source' as const,
    sourceRef: { sourceId: 'github:acme/plugins', itemId: 'context7', commitSha: 'b81f77a' },
    riskLevel: 'local-command' as const,
  }
  const mcpStore = useWorkspaceStore.getState()
  mcpStore.setMcpSyncEnabled(false)
  mcpStore.refreshMcpServersFromSource([server])
  const after = useWorkspaceStore.getState().appSettings.mcp
  assert.equal(after?.syncEnabled, false, 'a refresh leaves MCP config sync exactly as they set it')
  assert.equal(after?.servers.context7?.command, 'npx')
  assert.deepEqual(after?.servers.context7?.sourceRef, server.sourceRef, 'and the provenance survives the write')

  useWorkspaceStore.getState().upsertMcpServer({ ...server, id: 'added-by-hand' })
  assert.equal(
    useWorkspaceStore.getState().appSettings.mcp?.syncEnabled,
    true,
    'while adding one still means "wire this up"',
  )
}

console.log('settingsSlice.test.ts: ok')
