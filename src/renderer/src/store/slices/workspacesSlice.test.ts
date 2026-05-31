import assert from 'node:assert/strict'

import type { GuidedBriefRuntimeState, LayoutTemplate } from '../../types/workspace'
import { createGuidedBriefTemplate } from '../../layouts/templates'
import { getEditorBuffer } from '../../utils/editorBuffers'
import { createInitialSprintEngineState } from '../../utils/sprintengine'
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
// New workspaces insert at the head of their folder block; each of these three
// lives in a distinct folder, so the newest-created sorts to the top.
assert.deepEqual(
  state.workspaces.map((workspace) => workspace.id),
  [soloDevId, secondId, firstId],
)
assert.equal(state.workspaces.find((workspace) => workspace.id === firstId)?.name, 'First Workspace')
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
state = useWorkspaceStore.getState()
assert.equal(state.workspaceWindows.length, 1)
assert.deepEqual(state.workspaceWindows[0]?.workspaceIds, [secondId, firstId, soloDevId])

useWorkspaceStore.getState().registerWorkspaceWindow('detached-test', 'detached')
useWorkspaceStore.getState().moveWorkspaceToWindow(firstId, 'detached-test', state.primaryWorkspaceWindowId)
state = useWorkspaceStore.getState()
assert.deepEqual(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-test')?.workspaceIds,
  [firstId],
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-test')?.activeWorkspaceId,
  firstId,
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === state.primaryWorkspaceWindowId)?.workspaceIds.includes(firstId),
  false,
)
useWorkspaceStore.getState().updateWorkspaceWindowPlacement('detached-test', {
  bounds: { x: 120.4, y: 80.8, width: 720, height: 540 },
  isMaximized: true,
  displayId: 3,
})
state = useWorkspaceStore.getState()
assert.deepEqual(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-test')?.bounds,
  { x: 120, y: 81, width: 800, height: 600 },
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-test')?.isMaximized,
  true,
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-test')?.displayId,
  3,
)
useWorkspaceStore.getState().moveWorkspaceToWindow(firstId, state.primaryWorkspaceWindowId, 'detached-test')
state = useWorkspaceStore.getState()
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === state.primaryWorkspaceWindowId)?.activeWorkspaceId,
  firstId,
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-test'),
  undefined,
)
useWorkspaceStore.getState().moveWorkspaceToWindow(firstId, 'detached-test', state.primaryWorkspaceWindowId)
useWorkspaceStore.getState().closeWorkspaceWindow('detached-test')
state = useWorkspaceStore.getState()
assert.equal(state.workspaceWindows.find((windowState) => windowState.id === 'detached-test'), undefined)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === state.primaryWorkspaceWindowId)?.workspaceIds.includes(firstId),
  true,
)
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

const guidedBriefState: GuidedBriefRuntimeState = {
  workspaceRoot: '/Users/example/guided',
  workspaceName: 'Guided Project',
  idea: 'Build a guided workspace regression test.',
  hasUi: 'yes',
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: true,
  wantsFrontendDiscussion: true,
  guidedRoleCliDefaults: { product: 'codex', architect: 'codex', frontend: 'claude' },
  buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 1, security: 0 },
  buildRoleCliDefaults: { architect: 'codex', product: 'codex', frontend: 'claude', developer: 'codex', code_reviewer: 'codex', spec_reviewer: 'codex', performance: 'codex', cross_platform: 'codex', tester: 'codex', security: 'codex' },
  buildCliPermissionPreset: 'default',
  buildStartRunner: false,
  buildAutoApproveArtifacts: false,
  stage: 'strategist-working',
  acceptedProductBrief: null,
  acceptedArchitecturePlan: null,
  acceptedUiDirection: null,
  acceptedMockups: [],
  activeMockupPath: null,
  strategistSessionId: null,
  architectSessionId: null,
  designerSessionId: null,
}
const guidedBriefId = useWorkspaceStore.getState().addWorkspace(createGuidedBriefTemplate(), {
  name: guidedBriefState.workspaceName,
  folderPath: guidedBriefState.workspaceRoot,
  mode: 'guided-brief',
  guidedBriefState,
})
state = useWorkspaceStore.getState()
const guidedWorkspace = state.workspaces.find((workspace) => workspace.id === guidedBriefId)
assert.ok(guidedWorkspace, 'guided brief workspace is added through the store')
assert.equal(guidedWorkspace?.mode, 'guided-brief')
assert.equal(guidedWorkspace?.guidedBriefState?.idea, guidedBriefState.idea)
assert.equal(guidedWorkspace?.folderPath, guidedBriefState.workspaceRoot)
assert.equal(state.activeWorkspaceId, guidedBriefId, 'guided brief workspace is activated')

const sprintEngineState = createInitialSprintEngineState({
  name: 'Runtime Choice Team',
  goal: 'Preserve agent runtime choices.',
  roleCounts: { architect: 1, developer: 2 },
})
const sprintEngineId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Runtime Choice Team',
  folderPath: '/Users/example/runtime-choice',
  sprintEngineState,
  sprintEngineRoleCliDefaults: {
    architect: 'claude',
    developer: 'claude',
  },
  sprintEngineAgentCliOverrides: {
    'developer-1': 'codex',
    'developer-2': 'claude',
  },
})
state = useWorkspaceStore.getState()
const sprintEngineWorkspace = state.workspaces.find((workspace) => workspace.id === sprintEngineId)
assert.equal(sprintEngineWorkspace?.agents.architect?.cli, 'claude')
assert.equal(sprintEngineWorkspace?.agents['developer-1']?.cli, 'codex')
assert.equal(sprintEngineWorkspace?.agents['developer-2']?.cli, 'claude')

// A second workspace in the same folder inserts directly above the first
// (top of that folder's block), not at the global head and not at the tail.
const blockFolder = '/Users/example/insert-order'
const olderInBlock = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Older In Block',
  folderPath: blockFolder,
})
const newerInBlock = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Newer In Block',
  folderPath: blockFolder,
})
state = useWorkspaceStore.getState()
const blockIds = state.workspaces
  .filter((workspace) => workspace.folderPath === blockFolder)
  .map((workspace) => workspace.id)
assert.deepEqual(blockIds, [newerInBlock, olderInBlock])

console.log('workspacesSlice.test.ts: ok')
