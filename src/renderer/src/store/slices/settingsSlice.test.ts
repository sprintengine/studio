import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import { useWorkspaceStore } from '../workspaceStore'
import type { ChatListView, DiffViewMode, SettingsOverlayState, SidebarSection } from './settingsSlice'
import {
  createSettingsSlice,
  DEFAULT_DIFF_OPENS_IN_WINDOW,
  DEFAULT_DIFF_VIEW,
  defaultAppearanceSettings,
  defaultAppSettings,
  defaultKeybindingSettings,
  normalizeAppearanceSettings,
  normalizeAppSettings,
  normalizeCliModelCatalogs,
  normalizeSelectedCli,
  normalizeCliModelSelections,
  normalizeCliPermissionPreset,
  normalizeDesignSystemSeen,
  normalizeKeybindingSettings,
  normalizeModuleSettings,
  normalizeSprintEngineRunSettings,
  moduleSettingsNamespace,
  normalizeRecentWorkspaceFolders,
  normalizeNewChatAgentChoice,
  normalizeProjectColors,
  normalizeSpecialistOrder,
  normalizeSpecialistPacks,
  normalizeTextGenerationSettings,
  sprintEngineRunSettingsKey,
} from './settingsSlice'
import {
  buildSpecialistSoulStartupPrompt,
  getSpecialistAction,
  orderSpecialistActions,
} from '../../specialists/specialistActions'
import { createInitialSprintEngineState } from '../../utils/sprintengine'
import { PROJECT_COLORS, projectColorKeys, type ProjectColorSetting } from '../../utils/projectColor'
import { EXTENSIONS_BROWSE_DEEPLINK } from '../../components/settings/extensionsRoute'
import { consumePendingExtensionsSurfaceTarget } from '../../components/workspace/globalSurface/extensions/extensionsSurfaceTarget'

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
    projectKnowledgeRoots: {
      '/Users/example/project/': ' docs/knowledge ',
      '/Users/example/bad': '/absolute',
    },
    recentWorkspaceFolders: [' /Users/example/project ', '/Users/example/project/', '', '/Users/example/other'],
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
assert.deepEqual(normalized.projectKnowledgeRoots, {
  '/Users/example/project': 'docs/knowledge',
})
assert.deepEqual(normalized.recentWorkspaceFolders, [
  '/Users/example/project',
  '/Users/example/other',
])
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
  activeGlobalSurface: null as string | null,
  activeModalSurface: null as string | null,
  sidebarSection: 'home' as SidebarSection,
  chatListView: 'projects' as ChatListView,
  sidebarCollapsed: false,
  sidebarWidth: 280,
  workspacePaneWidth: 420,
  workspacePaneMaximised: false,
  openFilesInExternalWindow: true,
  diffOpensInWindow: true,
  diffView: 'side-by-side' as DiffViewMode,
  checkCliVersions: true,
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

// Where a diff opens (git-commit-window T3). The window is the out-of-the-box
// answer, and the flip is a
// plain setter, because the two band buttons that write it are the whole UI.
assert.equal(DEFAULT_DIFF_OPENS_IN_WINDOW, true, 'a diff opens in its own window until the person says otherwise')
assert.equal(slice.diffOpensInWindow, true, 'the slice starts on the default')
slice.setDiffOpensInWindow(false)
assert.equal(carrier.diffOpensInWindow, false, '"Show in the app" flips the diff home to the pane tab')
slice.setDiffOpensInWindow(true)
assert.equal(carrier.diffOpensInWindow, true, 'and "Open in separate window" flips it back')

// How a diff is DRAWN (git-commit-window T4). Two panes is the default; the diff window's icon-only toggle is the only writer, and it is
// app-wide because it is how this person reads a diff rather than a property of
// one file.
assert.equal(DEFAULT_DIFF_VIEW, 'side-by-side', 'a diff opens side by side until the person says otherwise')
assert.equal(slice.diffView, 'side-by-side', 'the slice starts on the default')
slice.setDiffView('unified')
assert.equal(carrier.diffView, 'unified', 'the toggle persists the unified reading')
slice.setDiffView('side-by-side')
assert.equal(carrier.diffView, 'side-by-side', 'and back')

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
// extractSettingsFields, which omits it), like the other per-window flags.
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
  activeGlobalSurface: null,
  activeModalSurface: null,
  sidebarSection: 'home' as SidebarSection,
  chatListView: 'projects' as ChatListView,
  sidebarCollapsed: false,
  sidebarWidth: 280,
  workspacePaneWidth: 420,
  workspacePaneMaximised: false,
  openFilesInExternalWindow: true,
  diffOpensInWindow: true,
  diffView: 'side-by-side' as DiffViewMode,
  checkCliVersions: true,
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
store.setCommandKeybindingDisabled('voice.toggle', true)
store.setCommandKeybindingDisabled('voice-dictation.toggle', false)
assert.equal(
  useWorkspaceStore.getState().appSettings.keybindings.disabled['voice.toggle'],
  undefined,
  're-enabling under the current id clears a legacy-id disabled flag',
)
store.setCommandKeybindings('voice.toggle', ['Primary+R'])
store.setCommandKeybindings('voice-dictation.toggle', ['Primary+Shift+R'])
assert.equal(
  useWorkspaceStore.getState().appSettings.keybindings.overrides['voice.toggle'],
  undefined,
  'overriding under the current id drops the legacy-id override',
)
store.setCommandKeybindings('voice-dictation.toggle', [])
assert.equal(
  useWorkspaceStore.getState().appSettings.keybindings.overrides['voice-dictation.toggle'],
  undefined,
  'clearing under the current id removes its override',
)
store.setCommandKeybindings('voice.toggle', ['Primary+R'])
store.setCommandKeybindingDisabled('voice.toggle', true)
store.resetCommandKeybindings('voice-dictation.toggle')
assert.deepEqual(
  [
    useWorkspaceStore.getState().appSettings.keybindings.overrides['voice.toggle'],
    useWorkspaceStore.getState().appSettings.keybindings.disabled['voice.toggle'],
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
// settings so future workspace and sprint roster construction can filter it
// out.
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
  'the migrated roster keeps its id, so a plan or automation naming it still resolves',
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

// --- Retired Design Wizard transport setting --------------------------------
// The Design Wizard was deleted 2026-09-08 and its `guidedBriefConversationSessions`
// opt-in went with it. A profile written by an older build still carries the key;
// normalizeAppSettings rebuilds the blob from known fields, so it is dropped
// rather than carried forward — the same treatment every other retired key gets.
const staleTransportProfile = normalizeAppSettings(
  { guidedBriefConversationSessions: true, guidedBriefConversationSessionsOptInReset: true } as never,
  [],
)
assert.equal(
  'guidedBriefConversationSessions' in staleTransportProfile,
  false,
  'the retired Design Wizard transport opt-in is dropped at hydration',
)
assert.equal(
  'guidedBriefConversationSessionsOptInReset' in staleTransportProfile,
  false,
  'its one-time reset stamp is dropped with it',
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

// Model-written chat titles (MC-2484). The setting is on by default — the
// heuristic title is the fallback for a person with this off or with no
// supported CLI installed, so nothing is lost by starting it on — and the
// engine choice is a separate axis that survives an off.
{
  assert.deepEqual(normalizeTextGenerationSettings(undefined), { enabled: true, engine: null })
  assert.deepEqual(normalizeTextGenerationSettings(null), { enabled: true, engine: null })
  assert.deepEqual(normalizeTextGenerationSettings({}), { enabled: true, engine: null })
  assert.deepEqual(
    normalizeTextGenerationSettings({ enabled: false }),
    { enabled: false, engine: null },
    'an explicit off is kept — only a missing value defaults to on',
  )
  assert.equal(
    normalizeTextGenerationSettings({ enabled: false, engine: { cli: 'codex', model: 'gpt-5.6-luna' } }).enabled,
    false,
  )

  // An engine with no CLI is nothing: a stray level or model without the CLI
  // that would run it cannot name an engine.
  assert.equal(normalizeTextGenerationSettings({ engine: { cli: '   ', model: 'gpt-5.6-luna' } }).engine, null)
  assert.equal(normalizeTextGenerationSettings({ engine: { model: 'gpt-5.6-luna' } as never }).engine, null)
  assert.equal(normalizeTextGenerationSettings({ engine: 'codex' as never }).engine, null)

  // A CLI with an empty model is a real setting: that CLI at its default model.
  assert.deepEqual(normalizeTextGenerationSettings({ engine: { cli: 'codex', model: '' } }).engine, {
    cli: 'codex',
    model: '',
  })

  assert.deepEqual(
    normalizeTextGenerationSettings({
      engine: { cli: '  codex  ', model: '  gpt-5.6-luna  ', reasoning: '  low  ' },
    }).engine,
    { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' },
    'every field is trimmed',
  )

  // Reasoning is optional, and an empty level is absent rather than stored as
  // an empty string — an empty string would be forwarded as a flag with no value.
  assert.deepEqual(
    normalizeTextGenerationSettings({ engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: '   ' } }).engine,
    { cli: 'codex', model: 'gpt-5.6-luna' },
  )
  assert.equal(
    'reasoning' in
      (normalizeTextGenerationSettings({ engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: '' } }).engine ??
        {}),
    false,
  )

  // And the key is always present after the whole-settings normalizer, so a
  // profile persisted before this shipped reads as "on, nothing chosen".
  assert.deepEqual(defaultAppSettings().textGeneration, { enabled: true, engine: null })
  assert.deepEqual(normalizeAppSettings(undefined, []).textGeneration, { enabled: true, engine: null })
  assert.deepEqual(normalizeAppSettings({}, []).textGeneration, { enabled: true, engine: null })
  assert.deepEqual(
    normalizeAppSettings({ textGeneration: { enabled: false, engine: { cli: 'codex', model: '' } } } as never, [])
      .textGeneration,
    { enabled: false, engine: { cli: 'codex', model: '' } },
  )

  // --- the two writers -----------------------------------------------------

  const textGeneration = (): ReturnType<typeof defaultAppSettings>['textGeneration'] =>
    useWorkspaceStore.getState().appSettings.textGeneration

  useWorkspaceStore.getState().setTextGenerationEngine({ cli: 'codex', model: '  gpt-5.6-luna  ', reasoning: 'high' })
  assert.deepEqual(textGeneration()?.engine, { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' })

  // Turning titles off must not make them pick their CLI again when they
  // turn it back on.
  useWorkspaceStore.getState().setTextGenerationEnabled(false)
  assert.equal(textGeneration()?.enabled, false)
  assert.deepEqual(textGeneration()?.engine, { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' })
  useWorkspaceStore.getState().setTextGenerationEnabled(true)
  assert.equal(textGeneration()?.enabled, true)
  assert.deepEqual(
    textGeneration()?.engine,
    { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' },
    'the engine survives the round trip through off',
  )

  // The same effort rule as setSpecialistModelDefault: a level outlives a model
  // change inside the CLI...
  useWorkspaceStore.getState().setTextGenerationEngine({ cli: 'codex', model: 'gpt-5.1-codex-mini' })
  assert.deepEqual(textGeneration()?.engine, { cli: 'codex', model: 'gpt-5.1-codex-mini', reasoning: 'high' })

  // ...and is dropped when the CLI changes, because levels do not carry across.
  useWorkspaceStore.getState().setTextGenerationEngine({ cli: 'claude-code', model: 'claude-haiku-4-5' })
  assert.deepEqual(textGeneration()?.engine, { cli: 'claude-code', model: 'claude-haiku-4-5' })

  // An explicit level always wins over whatever was stored.
  useWorkspaceStore
    .getState()
    .setTextGenerationEngine({ cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'low' })
  assert.deepEqual(textGeneration()?.engine, { cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'low' })
  useWorkspaceStore
    .getState()
    .setTextGenerationEngine({ cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'medium' })
  assert.deepEqual(textGeneration()?.engine, { cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'medium' })

  // null is "whichever supported CLI is installed, at its default" — not off.
  useWorkspaceStore.getState().setTextGenerationEngine(null)
  assert.deepEqual(textGeneration(), { enabled: true, engine: null })
  useWorkspaceStore.getState().setTextGenerationEnabled(false)
  useWorkspaceStore.getState().setTextGenerationEngine(null)
  assert.deepEqual(textGeneration(), { enabled: false, engine: null }, 'clearing the engine leaves enabled alone')
  useWorkspaceStore.getState().setTextGenerationEnabled(true)
}

// ── The Design door's per-bundle visit stamps ───────────────────────────────
//
// `designSystemSeen` is what the door's "New" marker is measured against, so
// every way this map can go wrong deletes or fabricates a marker the person
// cannot check against anything.
{
  // Absent, and every non-map shape, reads as "nothing opened yet" rather than
  // throwing or carrying a shape the door would index into.
  assert.deepEqual(defaultAppSettings().designSystemSeen, {})
  assert.deepEqual(normalizeAppSettings(undefined, []).designSystemSeen, {})
  assert.deepEqual(normalizeAppSettings({}, []).designSystemSeen, {})
  assert.deepEqual(normalizeDesignSystemSeen(undefined), {})
  assert.deepEqual(normalizeDesignSystemSeen(null), {})
  assert.deepEqual(normalizeDesignSystemSeen('2026-09-08T00:00:00.000Z'), {})
  assert.deepEqual(normalizeDesignSystemSeen([['lib:/a', '2026-09-08T00:00:00.000Z']]), {})

  // A stamp that is not a parseable date is DROPPED, not carried. Carrying it
  // would read as "seen at an unknown time", and the rule's fallback for an
  // unreadable stamp is "never seen" — which re-announces a whole system.
  assert.deepEqual(
    normalizeDesignSystemSeen({
      'lib:/work/brand': '2026-09-08T10:00:00.000Z',
      'lib:/work/broken': 'last Tuesday',
      'lib:/work/wrong-type': 1757000000000,
      '': '2026-09-08T10:00:00.000Z',
      '   ': '2026-09-08T10:00:00.000Z',
    }),
    { 'lib:/work/brand': '2026-09-08T10:00:00.000Z' },
  )

  // The map is bounded, and it is the OLDEST visits that go: the bundle nobody
  // has opened in years is the one whose stamp costs least to lose.
  const many: Record<string, string> = {}
  for (let index = 0; index < 260; index += 1) {
    many[`lib:/work/system-${index}`] = new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString()
  }
  const trimmed = normalizeDesignSystemSeen(many)
  assert.equal(Object.keys(trimmed).length, 200, 'trimmed to the cap')
  assert.ok(trimmed['lib:/work/system-259'], 'the most recent visit survives')
  assert.equal(trimmed['lib:/work/system-0'], undefined, 'the oldest went first')
  assert.equal(Object.keys(normalizeAppSettings({ designSystemSeen: many }, []).designSystemSeen).length, 200)

  // --- the writer ----------------------------------------------------------

  const seen = (): Record<string, string> => useWorkspaceStore.getState().appSettings.designSystemSeen

  useWorkspaceStore.getState().markDesignSystemSeen('lib:/work/brand', '2026-09-08T10:00:00.000Z')
  assert.equal(seen()['lib:/work/brand'], '2026-09-08T10:00:00.000Z')

  // Re-visiting moves the stamp forward; it never accumulates a second key.
  useWorkspaceStore.getState().markDesignSystemSeen('lib:/work/brand', '2026-09-09T10:00:00.000Z')
  assert.deepEqual(seen(), { 'lib:/work/brand': '2026-09-09T10:00:00.000Z' })

  // No stamp given means now, and a bad one is treated the same rather than
  // being written through as an unreadable value.
  useWorkspaceStore.getState().markDesignSystemSeen('lib:/work/other')
  assert.ok(Date.now() - Date.parse(seen()['lib:/work/other']) < 60_000)
  useWorkspaceStore.getState().markDesignSystemSeen('lib:/work/other', 'whenever')
  assert.ok(Date.now() - Date.parse(seen()['lib:/work/other']) < 60_000)

  // An empty id is not a bundle, so it writes nothing at all.
  const before = seen()
  useWorkspaceStore.getState().markDesignSystemSeen('   ')
  assert.deepEqual(seen(), before)
}


// ── One colour per project ─────────────────────────────────────────────────
//
// `projectColors` answers "which project is this row?" before the name is read,
// so the two ways it can go wrong are a map that comes back wrong from disk and
// an allocator that hands two projects on screen the same hue.
{
  // --- the reader -----------------------------------------------------------

  // A profile that predates the setting has no colours, not a crash and not a
  // shape the glyph would index into.
  assert.deepEqual(defaultAppSettings().projectColors, {})
  assert.deepEqual(normalizeAppSettings(undefined, []).projectColors, {})
  assert.deepEqual(normalizeAppSettings({}, []).projectColors, {})
  assert.deepEqual(normalizeProjectColors(undefined), {})
  assert.deepEqual(normalizeProjectColors(null), {})
  assert.deepEqual(normalizeProjectColors('blue'), {})
  assert.deepEqual(normalizeProjectColors([['repo:a', 'blue']]), {})

  // Every value that is not one of the six hues or `'none'` is DROPPED rather
  // than carried: 'green' and gold are the finished and waiting row tints and
  // were never in this palette, and a number or a null would reach the glyph as
  // a class name that resolves to nothing.
  const corrupt = {
    'repo:green': 'green',
    'repo:gold': 'yellow',
    'repo:number': 7,
    'repo:null': null,
    'repo:array': ['blue'],
    'repo:object': { color: 'blue' },
    '': 'blue',
    '   ': 'teal',
    'repo:kept': 'blue',
    'repo:declined': 'none',
  }
  assert.deepEqual(normalizeProjectColors(corrupt), { 'repo:kept': 'blue', 'repo:declined': 'none' })
  assert.deepEqual(normalizeAppSettings({ projectColors: corrupt as never }, []).projectColors, {
    'repo:kept': 'blue',
    'repo:declined': 'none',
  })

  // Unlike the knowledge roots beside it, the map is NOT pruned against the open
  // workspaces: a project's colour has to survive closing every chat in it.
  assert.deepEqual(normalizeAppSettings({ projectColors: { 'repo:closed': 'violet' } }, []).projectColors, {
    'repo:closed': 'violet',
  })

  // --- the writer -----------------------------------------------------------

  const colors = (): Record<string, ProjectColorSetting> =>
    useWorkspaceStore.getState().appSettings.projectColors

  // Six projects opened at once get six DIFFERENT hues. This is the acceptance:
  // two open projects never receive the same colour automatically.
  const six = PROJECT_COLORS.map((_, index) => `repo:first-${index}`)
  useWorkspaceStore.getState().assignProjectColors(six)
  const handedOut = six.map((key) => colors()[key])
  assert.equal(new Set(handedOut).size, 6, 'six projects, six hues')
  assert.deepEqual([...handedOut].sort(), [...PROJECT_COLORS].sort(), 'and all six of the palette')

  // Calling again with the same set writes NOTHING — not an equal object, the
  // same one. This is what makes it safe in an effect that runs on every render
  // of the sidebar: a write would notify every subscriber and re-run the effect.
  const before = colors()
  useWorkspaceStore.getState().assignProjectColors(six)
  assert.equal(colors(), before, 'nothing missing means no write at all')
  useWorkspaceStore.getState().assignProjectColors([])
  assert.equal(colors(), before, 'and an empty ask is not a write either')

  // A project the person set to "No colour" is SEEN, so it is left alone — and
  // it is not using a hue, so it does not constrain the project beside it.
  useWorkspaceStore.getState().setProjectColor('repo:logo', 'none')
  useWorkspaceStore.getState().assignProjectColors(['repo:logo', 'repo:beside-logo'])
  assert.equal(colors()['repo:logo'], 'none', "'none' survives the next allocation pass")
  assert.equal(colors()['repo:beside-logo'], 'blue', "'none' is not a hue in use")

  // Allocation is scoped to the projects ON SCREEN, not to everything ever
  // opened. Twelve historical projects wear all six hues twice over; the two
  // open ones wear blue and teal; the third to open must take a hue neither of
  // THEM has, not the least-used across a year of history.
  PROJECT_COLORS.forEach((color, index) => {
    useWorkspaceStore.getState().setProjectColor(`repo:history-${index}-a`, color)
    useWorkspaceStore.getState().setProjectColor(`repo:history-${index}-b`, color)
  })
  useWorkspaceStore.getState().setProjectColor('repo:open-1', 'blue')
  useWorkspaceStore.getState().setProjectColor('repo:open-2', 'teal')
  useWorkspaceStore.getState().assignProjectColors(['repo:open-1', 'repo:open-2', 'repo:open-3'])
  assert.equal(colors()['repo:open-3'], 'cyan', 'the first hue free among the projects on screen')

  // The allocation a project gets does not depend on where the sidebar happened
  // to draw it. The action takes the order it is handed — it is `projectColorKeys`,
  // which every caller goes through, that sorts the set, and this asserts the
  // two together rather than trusting one of them.
  useWorkspaceStore.getState().assignProjectColors(projectColorKeys(['repo:ordered-b', 'repo:ordered-a']))
  const orderedFirst = { a: colors()['repo:ordered-a'], b: colors()['repo:ordered-b'] }
  useWorkspaceStore.getState().setProjectColor('repo:ordered-a', null)
  useWorkspaceStore.getState().setProjectColor('repo:ordered-b', null)
  useWorkspaceStore.getState().assignProjectColors(projectColorKeys(['repo:ordered-a', 'repo:ordered-b']))
  assert.deepEqual({ a: colors()['repo:ordered-a'], b: colors()['repo:ordered-b'] }, orderedFirst)

  // The person changing a colour writes it through; null deletes the entry
  // entirely, which returns the project to never-seen rather than to "none".
  useWorkspaceStore.getState().setProjectColor('repo:picked', 'red')
  assert.equal(colors()['repo:picked'], 'red')
  useWorkspaceStore.getState().setProjectColor('repo:picked', null)
  assert.equal(Object.hasOwn(colors(), 'repo:picked'), false, 'null deletes rather than storing none')
  useWorkspaceStore.getState().assignProjectColors(['repo:picked'])
  assert.ok(PROJECT_COLORS.includes(colors()['repo:picked'] as never), 'a deleted key is allocated again')

  // An empty key is not a project, and deleting one that was never there is not
  // a write.
  const settled = colors()
  useWorkspaceStore.getState().setProjectColor('   ', 'blue')
  useWorkspaceStore.getState().setProjectColor('repo:never-seen', null)
  assert.equal(colors(), settled)
}

console.log('settingsSlice.test.ts: ok')
