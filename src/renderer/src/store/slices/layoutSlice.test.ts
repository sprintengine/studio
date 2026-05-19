import assert from 'node:assert/strict'

import type { IJsonModel } from 'flexlayout-react'
import type { LayoutTemplate, Workspace } from '../../types/workspace'
import { createInitialSprintEngineState } from '../../utils/sprintengine'
import { useWorkspaceStore } from '../workspaceStore'
import {
  createLayoutSlice,
  ensureMultiloopLayoutModel,
  hideSprintEngineBoardTabStrip,
  isLegacySprintEngineLayout,
  markSwitchboardAnchorTabsSticky,
  migrateSprintEngineLayout,
  modelContainsComponent,
  multiloopTabsLayoutModel,
  sprintEngineTabsLayoutModel,
  stripSettingsTabsFromLayout,
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
})

const sprintLayout = sprintEngineTabsLayoutModel(sprintEngineState, {}, { includeAgentTabs: false })
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine'), true)
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine-inbox'), false)
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine-roster'), false)
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine-tasks'), false)
assert.equal(modelContainsComponent(sprintLayout, 'agent'), false)

const sprintLayoutWithAgents = sprintEngineTabsLayoutModel(sprintEngineState, {})
assert.equal(modelContainsComponent(sprintLayoutWithAgents, 'agent'), true)

const multiloopLayout = multiloopTabsLayoutModel()
assert.equal(modelContainsComponent(multiloopLayout, 'multiloop-board'), true)
assert.deepEqual(ensureMultiloopLayoutModel(multiloopLayout), multiloopLayout)
assert.equal(modelContainsComponent(ensureMultiloopLayoutModel(standardTemplate.layout), 'multiloop-board'), true)

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
assert.equal(modelContainsComponent(migratedFromThreeTab.layoutModel, 'sprintengine'), true)
assert.equal(modelContainsComponent(migratedFromThreeTab.layoutModel, 'sprintengine-inbox'), false)
assert.equal(modelContainsComponent(migratedFromThreeTab.layoutModel, 'sprintengine-roster'), false)
assert.equal(modelContainsComponent(migratedFromThreeTab.layoutModel, 'sprintengine-tasks'), false)

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
          { type: 'tab', name: 'Sprint Engine', component: 'sprintengine', enableClose: false },
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

const switchboardLegacyLayout: IJsonModel = {
  global: {},
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        children: [
          { type: 'tab', name: 'Watchtower', component: 'watchtower-panel' },
          { type: 'tab', name: 'Switchboard', component: 'switchboard-board' },
          { type: 'tab', name: 'Notes', component: 'editor' },
        ],
      },
    ],
  },
}
const stickySwitchboardLayout = markSwitchboardAnchorTabsSticky(switchboardLegacyLayout)
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
const stickyWatchtower = findTab(stickySwitchboardLayout, 'watchtower-panel')!
const stickyBoard = findTab(stickySwitchboardLayout, 'switchboard-board')!
const untouchedEditor = findTab(stickySwitchboardLayout, 'editor')!
assert.equal(stickyWatchtower.enableClose, false)
assert.equal(stickyWatchtower.enableDrag, false)
assert.equal(stickyBoard.enableClose, false)
assert.equal(stickyBoard.enableDrag, false)
assert.equal(untouchedEditor.enableClose, undefined)
assert.equal(untouchedEditor.enableDrag, undefined)

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

const carrier = {
  workspaces: [
    {
      id: 'carrier-workspace',
      layoutModel: standardTemplate.layout,
    } as Workspace,
  ],
}
const layoutSlice = createLayoutSlice((mutator) => mutator(carrier))
layoutSlice.updateLayout('carrier-workspace', multiloopLayout)
assert.deepEqual(carrier.workspaces[0].layoutModel, multiloopLayout)

const workspaceId = useWorkspaceStore.getState().addWorkspace(standardTemplate, { name: 'Layout Workspace' })
useWorkspaceStore.getState().updateLayout(workspaceId, multiloopLayout)
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.layoutModel,
  multiloopLayout,
)

console.log('layoutSlice.test.ts: ok')
