import assert from 'node:assert/strict'

import type { LayoutTemplate, Workspace, WorkspaceWorktreeState } from '../../types/workspace'
import { useWorkspaceStore } from '../workspaceStore'
import {
  createWorktreesSlice,
  defaultWorkspaceWorktreeState,
  normalizeWorktreeEntry,
  normalizeWorkspaceWorktreeState,
} from './worktreesSlice'
import { defaultWorkspaceMemoryConfig } from './memorySlice'

const standardTemplate: LayoutTemplate = {
  id: 'worktrees-slice-standard',
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

const normalizedAvailable = normalizeWorktreeEntry({
  id: ' wt-1 ',
  path: '/repo/.worktrees/feature',
  branch: ' feature/test ',
  ownerAgentId: ' agent-1 ',
  status: 'unknown' as never,
  createdAt: 10,
  updatedAt: 20,
  missingAt: 30,
})
assert.deepEqual(normalizedAvailable, {
  id: 'wt-1',
  path: '/repo/.worktrees/feature',
  branch: ' feature/test ',
  ownerAgentId: ' agent-1 ',
  status: 'available',
  createdAt: 10,
  updatedAt: 20,
  missingAt: null,
})

const normalizedMissing = normalizeWorktreeEntry({
  id: 'wt-missing',
  path: '/repo/.worktrees/missing',
  status: 'missing',
  missingAt: 50,
  createdAt: 40,
  updatedAt: 45,
})
assert.equal(normalizedMissing?.status, 'missing')
assert.equal(normalizedMissing?.missingAt, 50)
assert.equal(normalizeWorktreeEntry({ id: '', path: '/repo' }), null)
assert.equal(normalizeWorktreeEntry({ id: 'wt', path: ' ' }), null)

const normalizedState = normalizeWorkspaceWorktreeState({
  containerPath: ' /repo/.worktrees ',
  updatedAt: 100,
  entries: {
    valid: {
      id: 'valid',
      path: '/repo/.worktrees/valid',
      branch: 'valid',
      ownerAgentId: 'agent-1',
      status: 'assigned',
      createdAt: 1,
      updatedAt: 2,
    },
    invalid: {
      id: '',
      path: '/repo/.worktrees/invalid',
      status: 'assigned',
    },
  },
} as unknown as Partial<WorkspaceWorktreeState>)
assert.equal(normalizedState.containerPath, ' /repo/.worktrees ')
assert.equal(normalizedState.updatedAt, 100)
assert.deepEqual(Object.keys(normalizedState.entries), ['valid'])

const carrier: { workspaces: Workspace[] } = {
  workspaces: [
    {
      id: 'ws-direct-worktrees',
      name: 'Direct Worktrees',
      mode: 'standard',
      folderPath: null,
      templateId: 'worktrees-slice-standard',
      agents: {},
      layoutModel: standardTemplate.layout,
      memory: defaultWorkspaceMemoryConfig(),
      editorState: { openFiles: [], activeFilePath: null },
      worktreeState: defaultWorkspaceWorktreeState(),
      createdAt: 1,
    },
  ],
}
const worktreesSlice = createWorktreesSlice((mutator) => mutator(carrier))

worktreesSlice.setWorkspaceWorktreeState('ws-direct-worktrees', {
  containerPath: '/repo/.worktrees',
})
assert.equal(carrier.workspaces[0].worktreeState?.containerPath, '/repo/.worktrees')
assert.deepEqual(carrier.workspaces[0].worktreeState?.entries, {})

worktreesSlice.upsertWorktreeEntry('ws-direct-worktrees', {
  id: 'feature',
  path: '/repo/.worktrees/feature',
  branch: 'feature/test',
  ownerAgentId: 'agent-1',
  status: 'assigned',
  createdAt: 10,
  updatedAt: 20,
  missingAt: null,
})
assert.equal(carrier.workspaces[0].worktreeState?.entries.feature?.status, 'assigned')
assert.equal(carrier.workspaces[0].worktreeState?.updatedAt, 20)

worktreesSlice.setWorkspaceWorktreeState('ws-direct-worktrees', {
  containerPath: '/repo/.new-worktrees',
})
assert.equal(carrier.workspaces[0].worktreeState?.containerPath, '/repo/.new-worktrees')
assert.ok(carrier.workspaces[0].worktreeState?.entries.feature, 'partial container updates preserve entries')

worktreesSlice.markWorktreeMissing('ws-direct-worktrees', 'feature', 1234)
assert.equal(carrier.workspaces[0].worktreeState?.entries.feature?.status, 'missing')
assert.equal(carrier.workspaces[0].worktreeState?.entries.feature?.missingAt, 1234)
assert.equal(carrier.workspaces[0].worktreeState?.entries.feature?.updatedAt, 1234)
assert.equal(carrier.workspaces[0].worktreeState?.updatedAt, 1234)

worktreesSlice.removeWorktreeEntry('ws-direct-worktrees', 'feature')
assert.equal(carrier.workspaces[0].worktreeState?.entries.feature, undefined)
assert.equal(typeof carrier.workspaces[0].worktreeState?.updatedAt, 'number')

worktreesSlice.setWorkspaceWorktreeState('ws-direct-worktrees', null)
assert.deepEqual(carrier.workspaces[0].worktreeState, defaultWorkspaceWorktreeState())

const storeWorkspaceId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Worktrees Store',
})
useWorkspaceStore.getState().setWorkspaceWorktreeState(storeWorkspaceId, {
  containerPath: '/repo/store/.worktrees',
})
useWorkspaceStore.getState().upsertWorktreeEntry(storeWorkspaceId, {
  id: 'store-feature',
  path: '/repo/store/.worktrees/store-feature',
  branch: 'store-feature',
  ownerAgentId: null,
  status: 'available',
  createdAt: 200,
  updatedAt: 300,
  missingAt: null,
})
useWorkspaceStore.getState().markWorktreeMissing(storeWorkspaceId, 'store-feature', 400)
let storeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === storeWorkspaceId)
assert.equal(storeWorkspace?.worktreeState.entries['store-feature']?.status, 'missing')
assert.equal(storeWorkspace?.worktreeState.entries['store-feature']?.missingAt, 400)

useWorkspaceStore.getState().removeWorktreeEntry(storeWorkspaceId, 'store-feature')
storeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === storeWorkspaceId)
assert.equal(storeWorkspace?.worktreeState.entries['store-feature'], undefined)

console.log('worktreesSlice.test.ts: ok')
