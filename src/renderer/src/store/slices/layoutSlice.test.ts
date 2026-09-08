import assert from 'node:assert/strict'

import type { IJsonModel } from 'flexlayout-react'
import type { LayoutTemplate, Workspace } from '../../types/workspace'
import { createInitialSprintEngineState } from '../../utils/sprintengine'
import { useWorkspaceStore } from '../workspaceStore'
import {
  createLayoutSlice,
  healRetiredRailLayout,
  stripRetiredModuleTabsFromLayout,
  hideNavRailTabStrip,
  hideSprintEngineBoardTabStrip,
  isLegacySprintEngineLayout,
  migrateSprintEngineLayout,
  modelContainsComponent,
  sprintEngineTabsLayoutModel,
  stripRetiredRailTabsFromLayout,
  stripSettingsTabsFromLayout,
  stripSprintEnginesNavFromLayout,
} from './layoutSlice'

const standardTemplate: LayoutTemplate = {
  id: 'layout-test',
  name: 'Layout Test',
  description: 'Layout test template',
  previewSlots: [],
  layout: {
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
  },
}

const sprintEngineState = createInitialSprintEngineState({
  goal: 'Ship layout slice',
  name: 'Layout Team',
  roleCounts: {},
})

const sprintLayout = sprintEngineTabsLayoutModel(sprintEngineState, {}, { includeAgentTabs: false })
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine'), true)
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine-inbox'), false)
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine-roster'), false)
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine-tasks'), false)
assert.equal(modelContainsComponent(sprintLayout, 'agent'), false)

const sprintLayoutWithAgents = sprintEngineTabsLayoutModel(sprintEngineState, {})
assert.equal(modelContainsComponent(sprintLayoutWithAgents, 'agent'), true)

// The retired 3-tab Inbox / Roster / Tasks shape must migrate forward to the
// single board tab — internal segmented chrome now handles the view switching.
const legacyThreeTabLayout: IJsonModel = {
  global: {},
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        children: [
          { type: 'tab', name: 'Inbox', component: 'sprintengine-inbox' },
          { type: 'tab', name: 'Roster', component: 'sprintengine-roster' },
          { type: 'tab', name: 'Tasks', component: 'sprintengine-tasks' },
        ],
      },
    ],
  },
}
assert.equal(isLegacySprintEngineLayout(legacyThreeTabLayout), true)
const migratedFromThreeTab = migrateSprintEngineLayout({
  id: 'workspace-three-tab',
  mode: 'sprintengine',
  layoutModel: legacyThreeTabLayout,
  sprintEngineState,
  agents: {},
} as Workspace)
assert.equal(modelContainsComponent(migratedFromThreeTab.layoutModel!, 'sprintengine'), true)
assert.equal(modelContainsComponent(migratedFromThreeTab.layoutModel!, 'sprintengine-inbox'), false)
assert.equal(modelContainsComponent(migratedFromThreeTab.layoutModel!, 'sprintengine-roster'), false)
assert.equal(modelContainsComponent(migratedFromThreeTab.layoutModel!, 'sprintengine-tasks'), false)

// A layout that already has the canonical single 'sprintengine' tab is left alone.
const canonicalLayout = sprintEngineTabsLayoutModel(sprintEngineState, {})
assert.equal(isLegacySprintEngineLayout(canonicalLayout), false)
const noopMigration = migrateSprintEngineLayout({
  id: 'workspace-canonical',
  mode: 'sprintengine',
  layoutModel: canonicalLayout,
  sprintEngineState,
  agents: {},
} as Workspace)
assert.equal(noopMigration.layoutModel, canonicalLayout)

// Existing SE layouts that still carry a visible Sprint Engine tab strip
// migrate to enableTabStrip: false on the tabset that hosts the board, while
// other tabsets keep their tab handles intact.
const sprintEngineLayoutForStripMigration: IJsonModel = {
  global: {},
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        weight: 58,
        children: [
          { type: 'tab', name: 'Sprint', component: 'sprintengine', enableClose: false },
        ],
      },
      {
        type: 'tabset',
        weight: 42,
        children: [
          { type: 'tab', name: 'Agent 1', component: 'agent', config: { agentId: 'a-1' } },
        ],
      },
    ],
  },
}
const stripHidden = hideSprintEngineBoardTabStrip(sprintEngineLayoutForStripMigration) as IJsonModel
function findTabset(model: IJsonModel, predicate: (record: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null
  const walk = (node: unknown) => {
    if (found || !node || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (record.type === 'tabset' && predicate(record)) {
      found = record
      return
    }
    if (Array.isArray(record.children)) record.children.forEach(walk)
  }
  walk(model.layout)
  return found
}
const seTabset = findTabset(stripHidden, (record) => {
  const children = Array.isArray(record.children) ? record.children : []
  return children.some((child) => (child as Record<string, unknown>)?.component === 'sprintengine')
})!
const agentTabset = findTabset(stripHidden, (record) => {
  const children = Array.isArray(record.children) ? record.children : []
  return children.some((child) => (child as Record<string, unknown>)?.component === 'agent')
})!
assert.equal(seTabset.enableTabStrip, false)
assert.equal(agentTabset.enableTabStrip, undefined)

const canonicalSprintLayout = sprintEngineTabsLayoutModel(sprintEngineState, {})
const canonicalSeTabset = findTabset(canonicalSprintLayout, (record) => {
  const children = Array.isArray(record.children) ? record.children : []
  return children.some((child) => (child as Record<string, unknown>)?.component === 'sprintengine')
})!
assert.equal(canonicalSeTabset.enableTabStrip, false)

// Layout tabs whose owning module was retired are stripped on hydration, the
// same way the rail-to-pane move strips its tabs: the model registry no longer
// resolves the component, so a surviving tab would render an empty surface.
const retiredModuleLayout: IJsonModel = {
  global: {},
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        children: [
          { type: 'tab', name: 'Board', component: 'switchboard-workspace' },
          { type: 'tab', name: 'Design Wizard', component: 'guided-brief' },
          { type: 'tab', name: 'Notes', component: 'editor' },
        ],
      },
    ],
  },
}
function findTab(model: IJsonModel, component: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (record.type === 'tab' && record.component === component) {
      found = record
      return
    }
    if (Array.isArray(record.children)) record.children.forEach(walk)
  }
  walk(model.layout)
  return found
}
const strippedRetired = stripRetiredModuleTabsFromLayout(retiredModuleLayout) as IJsonModel
assert.equal(modelContainsComponent(strippedRetired, 'switchboard-workspace'), false)
assert.equal(modelContainsComponent(strippedRetired, 'watchtower-panel'), false)
// The Design Wizard was deleted 2026-09-08; a profile that dragged its tab into
// another workspace's layout would otherwise render an unresolvable surface.
assert.equal(modelContainsComponent(strippedRetired, 'guided-brief'), false)
assert.ok(findTab(strippedRetired, 'editor'), 'the rest of the layout survives the strip')
// Nothing to strip is a no-op by reference, so it is safe on every hydration.
assert.equal(stripRetiredModuleTabsFromLayout(canonicalLayout), canonicalLayout)

// Nav-rail strip migration: a tabset holding only the Knowledge Graph switch
// loses its strip; a tabset mixing a nav switch with the editor keeps its
// strip (so the editor's file tabs survive) and self-heals later. (Backlog
// was the other nav switch until store v74 moved it into the workspace pane.)
const navRailLayoutForStripMigration: IJsonModel = {
  global: {},
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        weight: 18,
        children: [
          { type: 'tab', name: 'Knowledge Graph', component: 'memory-graph' },
        ],
      },
      {
        type: 'tabset',
        weight: 52,
        children: [
          { type: 'tab', name: 'Knowledge Graph', component: 'memory-graph' },
          { type: 'tab', name: 'Editor', component: 'editor' },
        ],
      },
      {
        type: 'tabset',
        weight: 30,
        children: [
          { type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'a-1' } },
        ],
      },
    ],
  },
}
const navStripHidden = hideNavRailTabStrip(navRailLayoutForStripMigration) as IJsonModel
const navOnlyTabset = findTabset(navStripHidden, (record) => {
  const children = Array.isArray(record.children) ? record.children : []
  return children.length === 1 && (children[0] as Record<string, unknown>)?.component === 'memory-graph'
})!
const mixedEditorTabset = findTabset(navStripHidden, (record) => {
  const children = Array.isArray(record.children) ? record.children : []
  return children.some((child) => (child as Record<string, unknown>)?.component === 'editor')
})!
const agentOnlyTabset = findTabset(navStripHidden, (record) => {
  const children = Array.isArray(record.children) ? record.children : []
  return children.some((child) => (child as Record<string, unknown>)?.component === 'agent')
})!
assert.equal(navOnlyTabset.enableTabStrip, false)
// Mixed nav+editor and pure-agent tabsets keep their strips.
assert.equal(mixedEditorTabset.enableTabStrip, undefined)
assert.equal(agentOnlyTabset.enableTabStrip, undefined)

const stripped = stripSettingsTabsFromLayout({
  global: {},
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        selected: 1,
        children: [
          { type: 'tab', name: 'Settings', component: 'settings' },
          { type: 'tab', name: 'Editor', component: 'editor' },
        ],
      },
    ],
  },
}) as IJsonModel
assert.equal(modelContainsComponent(stripped, 'settings'), false)
assert.equal(modelContainsComponent(stripped, 'editor'), true)

// The Sprint Engines survey moved to the app-level right aside; the v60
// migration strips its retired nav tab and drops the tabset it emptied,
// leaving the rest of the layout untouched.
const sprintEnginesStripped = stripSprintEnginesNavFromLayout({
  global: {},
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        enableTabStrip: false,
        children: [
          { type: 'tab', name: 'Sprint Engines', component: 'sprint-engines' },
        ],
      },
      {
        type: 'tabset',
        children: [
          { type: 'tab', name: 'Agent', component: 'agent' },
        ],
      },
    ],
  },
}) as IJsonModel
assert.equal(modelContainsComponent(sprintEnginesStripped, 'sprint-engines'), false)
assert.equal(modelContainsComponent(sprintEnginesStripped, 'agent'), true)
assert.equal((sprintEnginesStripped.layout as { children?: unknown[] }).children?.length, 1)

// A layout that held ONLY the retired nav tab falls back to an empty root row
// (WorkspaceLayout's zero-tab empty state), never the original layout with the
// stale tab restored.
const sprintEnginesOnlyStripped = stripSprintEnginesNavFromLayout({
  global: {},
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        enableTabStrip: false,
        children: [
          { type: 'tab', name: 'Sprint Engines', component: 'sprint-engines' },
        ],
      },
    ],
  },
}) as IJsonModel
assert.equal(modelContainsComponent(sprintEnginesOnlyStripped, 'sprint-engines'), false)
assert.deepEqual(sprintEnginesOnlyStripped.layout, { type: 'row', children: [] })

const carrier = {
  workspaces: [
    {
      id: 'carrier-workspace',
      layoutModel: standardTemplate.layout,
    } as Workspace,
  ],
}
const layoutSlice = createLayoutSlice((mutator) => mutator(carrier))
layoutSlice.updateLayout('carrier-workspace', sprintLayout)
assert.deepEqual(carrier.workspaces[0].layoutModel, sprintLayout)

const workspaceId = useWorkspaceStore.getState().addWorkspace(standardTemplate, { name: 'Layout Workspace' })
useWorkspaceStore.getState().updateLayout(workspaceId, sprintLayout)
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.layoutModel,
  sprintLayout,
)

// The rail-to-pane heal (store v73 Files/Git, v74 Backlog): a persisted layout
// that still docks a retired rail tab loses it, and the surface comes back as
// a pane tab — adopted into a record that already has a pane.
{
  const railLayout: IJsonModel = {
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [
        { type: 'tabset', weight: 18, enableTabStrip: false, children: [{ type: 'tab', name: 'Backlog', component: 'backlog' }] },
        { type: 'tabset', weight: 82, children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'a-1' } }] },
      ],
    },
  }
  const withPane = {
    id: 'heal-ws',
    layoutModel: railLayout,
    paneState: { open: false, activeTabId: 'f', tabs: [{ id: 'f', kind: 'files' }] },
  } as unknown as Workspace
  const healed = healRetiredRailLayout(withPane)
  assert.notEqual(healed, withPane)
  assert.equal(modelContainsComponent(healed.layoutModel, 'backlog'), false, 'the rail tab is stripped')
  assert.equal(modelContainsComponent(healed.layoutModel, 'agent'), true, 'the rest of the layout survives')
  assert.deepEqual(healed.paneState?.tabs.map((tab) => tab.kind), ['files', 'backlog'])
  assert.equal(healed.paneState?.open, true)
  assert.equal(healed.paneState?.activeTabId, healed.paneState?.tabs[1].id)
  assert.equal(healRetiredRailLayout(healed), healed, 'idempotent and reference-preserving once healed')

  const paneless = { id: 'heal-ws-2', layoutModel: railLayout } as unknown as Workspace
  const seeded = healRetiredRailLayout(paneless)
  assert.deepEqual(seeded.paneState?.tabs.map((tab) => tab.kind), ['backlog'])
  assert.equal(modelContainsComponent(seeded.layoutModel, 'backlog'), false)

  const stripped = stripRetiredRailTabsFromLayout(railLayout) as IJsonModel
  assert.equal(modelContainsComponent(stripped, 'backlog'), false)

  // An empty root tabset — what FlexLayout persists after the last tab closes —
  // was never stripped, so the heal hands the same record back; otherwise every
  // registry snapshot would write the layout back to main again.
  const emptyTabset = { id: 'heal-ws-3', layoutModel: { global: {}, borders: [], layout: { type: 'tabset', children: [] } } } as unknown as Workspace
  assert.equal(healRetiredRailLayout(emptyTabset), emptyTabset)
  assert.equal(stripRetiredRailTabsFromLayout(emptyTabset.layoutModel), emptyTabset.layoutModel)
}

console.log('layoutSlice.test.ts: ok')
