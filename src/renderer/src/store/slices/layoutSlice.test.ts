import assert from 'node:assert/strict'

import type { IJsonModel } from 'flexlayout-react'
import type { LayoutTemplate, Workspace } from '../../types/workspace'
import { createInitialSprintEngineState } from '../../utils/sprintengine'
import { useWorkspaceStore } from '../workspaceStore'
import {
  createLayoutSlice,
  ensureMultiloopLayoutModel,
  isLegacySprintEngineLayout,
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
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine-inbox'), true)
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine-roster'), true)
assert.equal(modelContainsComponent(sprintLayout, 'sprintengine-tasks'), true)
assert.equal(modelContainsComponent(sprintLayout, 'agent'), false)

const sprintLayoutWithAgents = sprintEngineTabsLayoutModel(sprintEngineState, {})
assert.equal(modelContainsComponent(sprintLayoutWithAgents, 'agent'), true)

const multiloopLayout = multiloopTabsLayoutModel()
assert.equal(modelContainsComponent(multiloopLayout, 'multiloop-board'), true)
assert.deepEqual(ensureMultiloopLayoutModel(multiloopLayout), multiloopLayout)
assert.equal(modelContainsComponent(ensureMultiloopLayoutModel(standardTemplate.layout), 'multiloop-board'), true)

const legacySprintLayout: IJsonModel = {
  global: {},
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        children: [{ type: 'tab', name: 'Sprint', component: 'sprintengine' }],
      },
    ],
  },
}
assert.equal(isLegacySprintEngineLayout(legacySprintLayout), true)
const migratedWorkspace = migrateSprintEngineLayout({
  id: 'workspace-legacy',
  mode: 'sprintengine',
  layoutModel: legacySprintLayout,
  sprintEngineState,
  agents: {},
} as Workspace)
assert.equal(modelContainsComponent(migratedWorkspace.layoutModel, 'sprintengine-inbox'), true)
assert.equal(modelContainsComponent(migratedWorkspace.layoutModel, 'sprintengine'), false)

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
