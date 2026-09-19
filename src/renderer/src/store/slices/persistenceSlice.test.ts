import assert from 'node:assert/strict'

import type { AppSettings } from '../../types/workspace'
import {
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_STORE_VERSION,
  classifyPersistedWorkspaceState,
  isDangerousEmptyClassification,
  migratePersistedWorkspaceState,
  nonEmptyPersistedWorkspaceState,
  readPersistedWorkspaceState,
} from './persistenceSlice'
import { normalizeWorkspaceForPartialize } from './normalizers'
import { normalizeAppSettings } from './settingsSlice'
import type { Workspace } from '../../types/workspace'
import { test } from 'vitest'

test('persistenceSlice', async () => {
  // classifyPersistedWorkspaceState ----------------------------------------------

  assert.equal(classifyPersistedWorkspaceState({ rawLocalStorage: null }), 'dangerous_empty_missing_storage')
  assert.equal(classifyPersistedWorkspaceState({ rawLocalStorage: 'not json {' }), 'dangerous_empty_unreadable')
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

  // v62: Automations became a global screen, not a workspace type. The migration
  // drops persisted automations workspaces (their definitions/run history live on
  // disk, untouched) while leaving every other workspace in place.
  const v61AutomationsState = {
    workspaces: [
      { id: 'ws-standard', mode: 'standard', folderPath: '/repo/app', agents: {} },
      { id: 'ws-automations', mode: 'automations', folderPath: '/repo/app', agents: {} },
      { id: 'ws-other', mode: 'standard', folderPath: '/repo/lib', agents: {} },
    ],
    activeWorkspaceId: 'ws-automations',
  }
  const migratedAutomationsDrop = migratePersistedWorkspaceState(v61AutomationsState, 61) as {
    workspaces: Array<{ id: string; mode: string }>
    activeWorkspaceId: string | null
  }
  assert.deepEqual(
    migratedAutomationsDrop.workspaces.map((ws) => ws.id),
    ['ws-standard', 'ws-other'],
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
      {
        id: 'ws-host-run-a',
        mode: 'automations-host',
        name: 'Pillars of code reviewer',
        folderPath: '/repo/app',
        agents: {},
        createdAt: 10,
      },
      {
        id: 'ws-host-run-b',
        mode: 'automations-host',
        name: 'Nightly performance reviewer',
        folderPath: '/repo/app',
        agents: {},
        createdAt: 20,
      },
      {
        id: 'ws-host-run-c',
        mode: 'automations-host',
        name: 'fable5 calendar',
        folderPath: '/repo/app/',
        agents: {},
        createdAt: 30,
      },
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

  // v65: the `roadmap` workspace mode retired (MC-1692) — Roadmap is an
  // instance-global sidebar surface now, not a per-project workspace. The migration
  // drops any roadmap-mode row and reconciles a dangling active pointer, mirroring
  // the v62 automations-mode drop. The roadmap plan on disk is untouched.
  const v64RoadmapState = {
    workspaces: [
      { id: 'ws-standard', mode: 'standard', folderPath: '/repo/app', agents: {} },
      { id: 'ws-roadmap', mode: 'roadmap', folderPath: '/repo/app', agents: {} },
      { id: 'ws-other', mode: 'standard', folderPath: '/repo/lib', agents: {} },
    ],
    activeWorkspaceId: 'ws-roadmap',
  }
  const migratedRoadmapDrop = migratePersistedWorkspaceState(v64RoadmapState, 64) as {
    workspaces: Array<{ id: string; mode: string }>
    activeWorkspaceId: string | null
  }
  assert.deepEqual(
    migratedRoadmapDrop.workspaces.map((ws) => ws.id),
    ['ws-standard', 'ws-other'],
    'v65 drops the retired roadmap-mode workspace and keeps the rest',
  )
  assert.equal(
    migratedRoadmapDrop.workspaces.some((ws) => ws.mode === 'roadmap'),
    false,
    'no roadmap-mode workspace survives the migration',
  )
  assert.equal(
    migratedRoadmapDrop.activeWorkspaceId,
    'ws-standard',
    'v65 reconciles a dangling active pointer to a surviving workspace',
  )

  // An account whose ONLY workspace was a roadmap-mode workspace migrates to an
  // empty list with a null active pointer (the dangerous-empty recovery path then
  // honors that, and the merge/recovery filters keep the on-disk copy clean).
  const v64RoadmapOnly = {
    workspaces: [{ id: 'ws-roadmap', mode: 'roadmap', folderPath: '/repo/app', agents: {} }],
    activeWorkspaceId: 'ws-roadmap',
  }
  const migratedRoadmapOnly = migratePersistedWorkspaceState(v64RoadmapOnly, 64) as {
    workspaces: unknown[]
    activeWorkspaceId: string | null
  }
  assert.equal(migratedRoadmapOnly.workspaces.length, 0, 'roadmap-only account migrates to an empty list')
  assert.equal(migratedRoadmapOnly.activeWorkspaceId, null, 'active pointer is cleared when nothing survives')

  // v67 reset a Design Wizard conversation-transport opt-in whose pre-flip
  // default had been written to every profile. The Design Wizard was deleted
  // 2026-09-08 and the setting with it, so the rung now only re-runs
  // normalizeAppSettings — which drops the stale key like every other retired
  // one and leaves the rest of the blob alone.
  const v66StaleTransportKey = {
    workspaces: [{ id: 'ws-standard', mode: 'standard', folderPath: '/repo/app', agents: {} }],
    activeWorkspaceId: 'ws-standard',
    appSettings: { guidedBriefConversationSessions: true, lastSelectedCli: 'codex' },
  }
  const migratedTransportReset = migratePersistedWorkspaceState(v66StaleTransportKey, 66) as {
    appSettings: AppSettings
  }
  assert.equal(
    'guidedBriefConversationSessions' in migratedTransportReset.appSettings,
    false,
    'the retired Design Wizard transport key is dropped, not carried forward',
  )
  assert.equal(migratedTransportReset.appSettings.lastSelectedCli, 'codex', 'v67 leaves other persisted settings alone')

  assert.equal(WORKSPACE_STORE_VERSION, 76, 'the Reviews extraction is the newest step, at store v76')

  // v74: the workspace Backlog left the FlexLayout rail for the pane. A v73
  // envelope — which already carries a pane record — still docking `backlog`
  // adopts it as a pane tab and loses the rail tab; a v72 envelope passing both
  // rungs is migrated once (the heal is idempotent).
  {
    const railLayout = {
      global: {},
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', enableTabStrip: false, children: [{ type: 'tab', name: 'Backlog', component: 'backlog' }] },
          {
            type: 'tabset',
            children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'a-1' } }],
          },
        ],
      },
    }
    const v73WithBacklogRail = {
      workspaces: [
        {
          id: 'ws-backlog',
          mode: 'standard',
          folderPath: '/repo/app',
          agents: {},
          layoutModel: railLayout,
          paneState: { open: false, activeTabId: 'g', tabs: [{ id: 'g', kind: 'git' }] },
        },
      ],
      activeWorkspaceId: 'ws-backlog',
      appSettings: {},
    }
    const migratedBacklog = migratePersistedWorkspaceState(v73WithBacklogRail, 73) as {
      workspaces: Array<{
        layoutModel: unknown
        paneState?: { open: boolean; activeTabId: string | null; tabs: Array<{ id: string; kind: string }> }
      }>
    }
    const migratedWs = migratedBacklog.workspaces[0]
    assert.equal(
      JSON.stringify(migratedWs.layoutModel).includes('"component":"backlog"'),
      false,
      'v74 strips the backlog rail tab',
    )
    assert.deepEqual(
      migratedWs.paneState?.tabs.map((tab) => tab.kind),
      ['git', 'backlog'],
      'v74 adopts the backlog into the existing pane record',
    )
    assert.equal(migratedWs.paneState?.open, true)
    assert.equal(
      migratedWs.paneState?.activeTabId,
      migratedWs.paneState?.tabs[1].id,
      'a closed pane opens on the backlog the rail was showing',
    )
    const migratedTwice = migratePersistedWorkspaceState(v73WithBacklogRail, 72) as typeof migratedBacklog
    assert.deepEqual(
      migratedTwice.workspaces[0].paneState?.tabs.map((tab) => tab.kind),
      ['git', 'backlog'],
      'a v72 profile passing both rungs adopts it once',
    )
  }

  // v69: `cliModelCatalog` arrives — what each CLI reported about its own models,
  // stored apart from the user's own ids so a re-probe cannot clobber them. The
  // rung normalizes an upgraded profile; the shape rules are enforced on every
  // hydration, not only here.
  const v68WithDiscoveredModels = {
    workspaces: [{ id: 'ws-standard', mode: 'standard', folderPath: '/repo/app', agents: {} }],
    activeWorkspaceId: 'ws-standard',
    appSettings: {
      cliRuntimes: { codex: { command: 'codex', useWsl: false, models: ['o4-mini'] } },
      cliModelCatalog: {
        codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' },
        grok: { models: [{ id: 'grok-4' }], source: 'argv-probe' },
      },
    },
  }
  const migratedDiscoveredModels = migratePersistedWorkspaceState(v68WithDiscoveredModels, 68) as {
    appSettings: AppSettings
  }
  assert.deepEqual(
    migratedDiscoveredModels.appSettings.cliModelCatalog,
    { codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' } },
    'v69 keeps a well-formed discovered catalog and drops an entry that is missing its fetch timestamp',
  )
  assert.deepEqual(
    migratedDiscoveredModels.appSettings.cliRuntimes.codex.models,
    ['o4-mini'],
    'v69 leaves the user model list alone — the two lists are siblings, never one store',
  )
  // Same split as v68 above: the rung is the clean-upgrade half, and
  // normalizeAppSettings (which persist merge() runs on every hydration) is the
  // enforcement half, so a malformed catalog cannot ride into the pickers inside
  // a current-version envelope the ladder never revisits.
  assert.equal(
    normalizeAppSettings(
      { cliModelCatalog: { grok: { models: [{ id: 'grok-4' }], source: 'argv-probe' } } } as never,
      [],
    ).cliModelCatalog,
    undefined,
    'normalizeAppSettings drops a malformed discovered catalog regardless of store version',
  )

  // v70: the per-CLI reasoning-effort level arrives on AgentCliModelSelection. The
  // rung normalizes an upgraded profile; a stored selection may now carry an empty
  // model (the CLI's own default model at a chosen effort) and must keep its level,
  // while a selection with neither a model nor a level is no override at all.
  const v69WithEffort = {
    workspaces: [{ id: 'ws-standard', mode: 'standard', folderPath: '/repo/app', agents: {} }],
    activeWorkspaceId: 'ws-standard',
    appSettings: {
      // Written by the previous build (store v69), so it carries MC-1865's
      // discovered catalog as well: this rung must not disturb it.
      cliModelCatalog: {
        codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' },
      },
      lastSelectedAgentModel: { cli: 'codex', model: '', reasoning: 'xhigh' },
    },
  }
  const migratedEffort = migratePersistedWorkspaceState(v69WithEffort, 69) as { appSettings: AppSettings }
  assert.deepEqual(
    migratedEffort.appSettings.lastSelectedAgentModel,
    { cli: 'codex', model: '', reasoning: 'xhigh' },
    "v70 keeps a level chosen without a model — the CLI's own default model at that effort",
  )
  assert.deepEqual(
    migratedEffort.appSettings.cliModelCatalog,
    { codex: { models: [{ id: 'gpt-5.6' }], fetchedAt: '2026-07-26T00:00:00Z', source: 'argv-probe' } },
    'v70 leaves the v69 discovered catalog intact — the two rungs are independent',
  )
  // Enforcement half, same split as v68/v69: persist merge() runs
  // normalizeAppSettings on every hydration, so a blank or malformed level cannot
  // ride into a launch inside a current-version envelope the ladder never revisits.
  assert.deepEqual(
    normalizeAppSettings({ lastSelectedAgentModel: { cli: 'codex', model: 'gpt-5.5', reasoning: '   ' } } as never, [])
      .lastSelectedAgentModel,
    { cli: 'codex', model: 'gpt-5.5' },
    'normalizeAppSettings drops a blank level regardless of store version',
  )
  assert.equal(
    normalizeAppSettings({ lastSelectedAgentModel: { cli: '', model: '', reasoning: 'high' } } as never, [])
      .lastSelectedAgentModel,
    null,
    'and drops a selection naming no CLI entirely',
  )

  // The per-module workspace-state bag (MC-1573): a module's durable entry rides
  // the ladder untouched, whatever version the envelope was written at.
  const v70WithModuleBag = {
    workspaces: [
      {
        id: 'ws-module-bag',
        mode: 'standard',
        folderPath: '/repo/app',
        agents: {},
        moduleState: { 'weather-deck': { lastCity: 'Dublin' } },
      },
    ],
    activeWorkspaceId: 'ws-module-bag',
  }
  const migratedBag = migratePersistedWorkspaceState(v70WithModuleBag, 70) as { workspaces: Workspace[] }
  assert.deepEqual(
    migratedBag.workspaces[0].moduleState?.['weather-deck'],
    { lastCity: 'Dublin' },
    "another module's bag entry rides the ladder untouched",
  )
  // And the next write keeps it: the bag persists verbatim.
  assert.deepEqual(
    normalizeWorkspaceForPartialize(migratedBag.workspaces[0]).moduleState,
    { 'weather-deck': { lastCity: 'Dublin' } },
    'the bag persists verbatim through partialize',
  )
  // An empty bag persists as absent rather than as `{}` on every workspace.
  assert.equal(
    normalizeWorkspaceForPartialize({
      id: 'ws-empty-bag',
      mode: 'standard',
      folderPath: '/repo/app',
      agents: {},
      moduleState: {},
    } as never as Workspace).moduleState,
    undefined,
    'an empty bag is omitted from the persisted registry',
  )

  console.log('persistenceSlice.test.ts: ok')
})
