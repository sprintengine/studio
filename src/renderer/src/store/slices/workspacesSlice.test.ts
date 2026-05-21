import assert from 'node:assert/strict'

import type { LayoutTemplate } from '../../types/workspace'
import { getEditorBuffer } from '../../utils/editorBuffers'
import { useWorkspaceStore } from '../workspaceStore'
import { normalizeWorkspaceMode, workspaceFolderKey } from './workspacesSlice'

const standardTemplate: LayoutTemplate = {
  id: 'standard-test',
  name: 'Standard',
  description: 'Standard workspace test template',
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

const switchboardTemplate: LayoutTemplate = {
  ...standardTemplate,
  id: 'switchboard-mode',
  name: 'Switchboard',
}

const soloDevTemplate: LayoutTemplate = {
  ...standardTemplate,
  id: 'solo-dev-test',
  name: 'Solo Dev',
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'agent-1' } }],
        },
      ],
    },
  },
}

assert.equal(workspaceFolderKey(' /Users/example/project/ '), '/users/example/project')
assert.equal(normalizeWorkspaceMode('unknown'), 'standard')
assert.equal(normalizeWorkspaceMode('switchboard'), 'switchboard')
assert.equal(normalizeWorkspaceMode('standard', { goal: 'ship' } as never), 'sprintengine')
assert.equal(normalizeWorkspaceMode('standard', null, { goal: 'loop' } as never), 'multiloop')

const store = useWorkspaceStore.getState()
const firstId = store.addWorkspace(standardTemplate, {
  name: ' First Workspace ',
  folderPath: '/Users/example/project',
})
const secondId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Second Workspace',
  folderPath: '/Users/example/other',
})
const soloDevId = useWorkspaceStore.getState().addWorkspace(soloDevTemplate, {
  name: 'Solo Dev Workspace',
  folderPath: '/Users/example/solo-dev',
})

let state = useWorkspaceStore.getState()
assert.equal(state.activeWorkspaceId, soloDevId)
assert.deepEqual(
  state.workspaces.map((workspace) => workspace.id),
  [firstId, secondId, soloDevId],
)
assert.equal(state.workspaces[0].name, 'First Workspace')
assert.deepEqual(state.appSettings.recentWorkspaceFolders, [
  '/Users/example/solo-dev',
  '/Users/example/other',
  '/Users/example/project',
])
assert.equal(state.workspaces.find((workspace) => workspace.id === soloDevId)?.agents['agent-1']?.cli, 'claude')
assert.equal(state.workspaces.find((workspace) => workspace.id === soloDevId)?.agents['agent-1']?.name, 'Agent')

state.reorderWorkspaces([secondId, 'missing', firstId, soloDevId])
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id),
  [secondId, firstId, soloDevId],
)

useWorkspaceStore.getState().renameWorkspace(firstId, ' Renamed Workspace ')
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.name,
  'Renamed Workspace',
)
useWorkspaceStore.getState().renameWorkspace(firstId, '   ')
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.name,
  'Renamed Workspace',
)

useWorkspaceStore.getState().setWorkspaceHighlight(firstId, { starred: true, color: 'blue' })
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.highlight,
  { starred: true, color: 'blue' },
)
useWorkspaceStore.getState().clearWorkspaceHighlight(firstId)
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.highlight,
  undefined,
)

useWorkspaceStore.getState().setActiveWorkspace(firstId)
assert.equal(useWorkspaceStore.getState().activeWorkspaceId, firstId)
useWorkspaceStore.getState().setFolderPath(firstId, '/Users/example/renamed')
state = useWorkspaceStore.getState()
assert.equal(state.workspaces.find((workspace) => workspace.id === firstId)?.folderPath, '/Users/example/renamed')
assert.deepEqual(state.appSettings.recentWorkspaceFolders.slice(0, 2), [
  '/Users/example/renamed',
  '/Users/example/solo-dev',
])

useWorkspaceStore.getState().updateAgent(firstId, 'agent-1', { name: 'Agent One' })
useWorkspaceStore.getState().moveAgentToWorkspace(firstId, secondId, 'agent-1')
state = useWorkspaceStore.getState()
assert.equal(state.workspaces.find((workspace) => workspace.id === firstId)?.agents['agent-1'], undefined)
assert.equal(state.workspaces.find((workspace) => workspace.id === secondId)?.agents['agent-1']?.name, 'Agent One')

useWorkspaceStore.getState().openFile(firstId, '/tmp/example.ts', 'example.ts', 'const value = 1')
useWorkspaceStore.getState().openFile(firstId, '/tmp/other.ts', 'other.ts', 'const other = 2')
useWorkspaceStore.getState().moveOpenFileToWorkspace(firstId, secondId, '/tmp/example.ts')
state = useWorkspaceStore.getState()
const firstEditor = state.workspaces.find((workspace) => workspace.id === firstId)?.editorState
const secondEditor = state.workspaces.find((workspace) => workspace.id === secondId)?.editorState
assert.deepEqual(firstEditor?.openFiles.map((file) => file.path), ['/tmp/other.ts'])
assert.equal(firstEditor?.activeFilePath, '/tmp/other.ts')
assert.deepEqual(secondEditor?.openFiles.map((file) => file.path), ['/tmp/example.ts'])
assert.equal(secondEditor?.activeFilePath, '/tmp/example.ts')
assert.equal(getEditorBuffer(secondId, '/tmp/example.ts'), 'const value = 1')

useWorkspaceStore.getState().removeWorkspace(secondId)
state = useWorkspaceStore.getState()
assert.deepEqual(state.workspaces.map((workspace) => workspace.id), [firstId, soloDevId])
assert.equal(state.activeWorkspaceId, firstId)

const switchboardId = useWorkspaceStore.getState().addWorkspace(switchboardTemplate, {
  folderPath: '/Users/example/switchboard',
})
useWorkspaceStore.getState().setFolderMissing(switchboardId, true)
const reusedSwitchboardId = useWorkspaceStore.getState().addWorkspace(switchboardTemplate, {
  folderPath: '/Users/example/switchboard/',
})
state = useWorkspaceStore.getState()
assert.equal(reusedSwitchboardId, switchboardId)
assert.equal(state.workspaces.filter((workspace) => workspace.mode === 'switchboard').length, 1)
assert.equal(state.workspaces.find((workspace) => workspace.id === switchboardId)?.folderMissing, false)
assert.equal(state.activeWorkspaceId, switchboardId)

useWorkspaceStore.getState().forgetFolder('/Users/example/switchboard')
state = useWorkspaceStore.getState()
assert.equal(state.workspaces.find((workspace) => workspace.id === switchboardId), undefined)
assert.equal(
  state.appSettings.recentWorkspaceFolders.some((folder) => folder.includes('switchboard')),
  false,
)

console.log('workspacesSlice.test.ts: ok')
