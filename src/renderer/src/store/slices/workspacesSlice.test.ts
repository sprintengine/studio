import assert from 'node:assert/strict'

import type { GuidedBriefRuntimeState, LayoutTemplate, Workspace, WorkspaceWindowState } from '../../types/workspace'
import { createGuidedBriefTemplate } from '../../modules/sprint-engine-workspace-types'
import { getEditorBuffer } from '../../utils/editorBuffers'
import { createInitialSprintEngineState } from '../../utils/sprintengine'
import { useWorkspaceStore } from '../workspaceStore'
import { applySoloChatSeed, normalizeWorkspaceMode, workspaceFolderKey } from './workspacesSlice'

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
const legacyPersistedWorkspace = {
  id: 'workspace-with-plugin-mode',
  mode: 'future-plugin-mode',
}
assert.equal(normalizeWorkspaceMode(legacyPersistedWorkspace.mode), 'future-plugin-mode')
assert.equal(normalizeWorkspaceMode('  future-plugin-mode  '), '  future-plugin-mode  ')
assert.equal(normalizeWorkspaceMode('switchboard'), 'switchboard')
assert.equal(normalizeWorkspaceMode(''), 'standard')
assert.equal(normalizeWorkspaceMode('   '), 'standard')
assert.equal(normalizeWorkspaceMode(null), 'standard')
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
assert.deepEqual(
  state.workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState,
  { expandedPaths: [], selectedPath: null },
  'new workspaces start with empty File Explorer expansion state',
)
assert.deepEqual(state.appSettings.recentWorkspaceFolders, [
  '/Users/example/solo-dev',
  '/Users/example/other',
  '/Users/example/project',
])
assert.equal(state.workspaces.find((workspace) => workspace.id === soloDevId)?.agents['agent-1']?.cli, 'claude-code')
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

useWorkspaceStore.getState().setFileExplorerExpandedPaths(firstId, ['/Users/example/project/src', '/Users/example/project/src', ''])
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState,
  { expandedPaths: ['/Users/example/project/src'], selectedPath: null },
  'File Explorer expansion paths are normalized and stored per workspace',
)

// setFileExplorerSelectedPath records the focused selection without clobbering
// the expanded set, and setFileExplorerExpandedPaths preserves the selection.
useWorkspaceStore.getState().setFileExplorerSelectedPath(firstId, '/Users/example/project/src/index.ts')
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState,
  { expandedPaths: ['/Users/example/project/src'], selectedPath: '/Users/example/project/src/index.ts' },
  'Selecting a file keeps the expanded set',
)
useWorkspaceStore.getState().setFileExplorerExpandedPaths(firstId, ['/Users/example/project/src', '/Users/example/project/lib'])
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState?.selectedPath,
  '/Users/example/project/src/index.ts',
  'Toggling folders preserves the persisted selection',
)
useWorkspaceStore.getState().setFileExplorerSelectedPath(firstId, null)
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState?.selectedPath,
  null,
  'Clearing selection persists null',
)

// Backlog view state merges partial patches and coerces invalid enums.
useWorkspaceStore.getState().setBacklogViewState(firstId, { view: 'quick_wins', sort: 'priority' })
useWorkspaceStore.getState().setBacklogViewState(firstId, { selectedRelativePath: 'backlog/x.md', search: 'auth' })
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.backlogState,
  { selectedRelativePath: 'backlog/x.md', view: 'quick_wins', sort: 'priority', group: 'none', search: 'auth' },
  'Backlog view state accumulates partial patches',
)
useWorkspaceStore.getState().setBacklogViewState(firstId, { view: 'bogus' as never })
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.backlogState?.view,
  'all',
  'An unknown lens is coerced to all',
)

// Git panel: per-scope drafts set/clear independently and never bleed.
useWorkspaceStore.getState().setGitPanelState(firstId, { activeView: 'log', activeScopeId: 'worktree-a' })
useWorkspaceStore.getState().setGitCommitDraft(firstId, 'worktree-a', 'WIP a')
useWorkspaceStore.getState().setGitCommitDraft(firstId, 'main', 'WIP main')
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.gitPanelState,
  { activeView: 'log', activeScopeId: 'worktree-a', commitDraftsByScopeId: { 'worktree-a': 'WIP a', main: 'WIP main' } },
  'Git panel keeps a draft per scope alongside the active view/scope',
)
useWorkspaceStore.getState().setGitCommitDraft(firstId, 'worktree-a', '   ')
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.gitPanelState?.commitDraftsByScopeId,
  { main: 'WIP main' },
  'A blank draft is dropped, leaving other scopes untouched',
)
useWorkspaceStore.getState().clearGitCommitDraft(firstId, 'main')
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.gitPanelState?.commitDraftsByScopeId,
  {},
  'Clearing a draft on commit removes it',
)
// setGitPanelState must not disturb existing drafts.
useWorkspaceStore.getState().setGitCommitDraft(firstId, 'main', 'keep me')
useWorkspaceStore.getState().setGitPanelState(firstId, { activeView: 'changes' })
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === firstId)?.gitPanelState?.commitDraftsByScopeId,
  { main: 'keep me' },
  'Changing the active view preserves per-scope drafts',
)

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
assert.deepEqual(
  state.workspaces.find((workspace) => workspace.id === firstId)?.fileExplorerState,
  { expandedPaths: [], selectedPath: null },
  'changing the workspace folder clears stale File Explorer expansion state',
)
assert.equal(
  state.workspaces.find((workspace) => workspace.id === firstId)?.backlogState,
  undefined,
  'changing the workspace folder clears the folder-scoped Backlog selection',
)
assert.equal(
  state.workspaces.find((workspace) => workspace.id === firstId)?.gitPanelState,
  undefined,
  'changing the workspace folder clears the repo-scoped Git panel state',
)
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
// Moving the active workspace (firstId) out of the primary window above fell the
// store's global active back to the primary window's remaining workspace
// (secondId) — a cross-window move no longer leaves global active pointing at a
// workspace that now lives in another window. Removing that fallback active
// (secondId) then reassigns to the last remaining workspace (soloDevId).
assert.equal(state.activeWorkspaceId, soloDevId)

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
  guidedRoleCliDefaults: { product: 'codex', architect: 'codex', frontend: 'claude-code' },
  buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 1, security: 0 },
  buildRoleCliDefaults: { architect: 'codex', product: 'codex', frontend: 'claude-code', developer: 'codex', code_reviewer: 'codex', spec_reviewer: 'codex', performance: 'codex', cross_platform: 'codex', tester: 'codex', security: 'codex' },
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
    architect: 'claude-code',
    developer: 'claude-code',
  },
  sprintEngineAgentCliOverrides: {
    'developer-1': 'codex',
    'developer-2': 'claude-code',
  },
})
state = useWorkspaceStore.getState()
const sprintEngineWorkspace = state.workspaces.find((workspace) => workspace.id === sprintEngineId)
assert.equal(sprintEngineWorkspace?.agents.architect?.cli, 'claude-code')
assert.equal(sprintEngineWorkspace?.agents['developer-1']?.cli, 'codex')
assert.equal(sprintEngineWorkspace?.agents['developer-2']?.cli, 'claude-code')
assert.equal(
  sprintEngineWorkspace?.sprintEngineInitialSpawnAgentIds,
  undefined,
  'no launch intent is recorded when no roles are marked spawn-at-start',
)

// Per-role model overrides and spawn-at-start launch intent from the wizard:
// explicit model id wins, explicit null means the CLI default (no model), and
// marked roles queue session-only initial spawn intent for the board.
const launchIntentState = createInitialSprintEngineState({
  name: 'Launch Intent Team',
  goal: 'Preserve roster launch intent.',
  roleCounts: { architect: 1, developer: 1, frontend: 1 },
})
const launchIntentId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Launch Intent Team',
  folderPath: '/Users/example/launch-intent',
  sprintEngineState: launchIntentState,
  sprintEngineRoleCliDefaults: {
    architect: 'claude-code',
    developer: 'claude-code',
    frontend: 'codex',
  },
  sprintEngineRoleModelOverrides: {
    developer: 'sonnet-test-model',
    frontend: null,
  },
  sprintEngineInitialSpawnRoles: ['frontend'],
})
state = useWorkspaceStore.getState()
const launchIntentWorkspace = state.workspaces.find((workspace) => workspace.id === launchIntentId)
assert.equal(launchIntentWorkspace?.agents['developer-1']?.cliModel, 'sonnet-test-model')
assert.equal(
  launchIntentWorkspace?.agents.frontend?.cliModel,
  undefined,
  'an explicit null override means the CLI default and suppresses remembered model defaults',
)
assert.deepEqual(launchIntentWorkspace?.sprintEngineInitialSpawnAgentIds, ['frontend'])

// The launch intent is consumed atomically — exactly one consumer spawn pass.
const consumedSpawns = useWorkspaceStore.getState().consumeSprintEngineInitialSpawns(launchIntentId)
assert.deepEqual(consumedSpawns, ['frontend'])
assert.deepEqual(useWorkspaceStore.getState().consumeSprintEngineInitialSpawns(launchIntentId), [])
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === launchIntentId)
    ?.sprintEngineInitialSpawnAgentIds,
  undefined,
)

const partialLaunchIntentState = createInitialSprintEngineState({
  name: 'Partial Launch Intent Team',
  goal: 'Launch safe roles first.',
  roleCounts: { architect: 1, developer: 1, tester: 1 },
})
const partialLaunchIntentId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Partial Launch Intent Team',
  folderPath: '/Users/example/partial-launch-intent',
  sprintEngineState: partialLaunchIntentState,
  sprintEngineRoleCliDefaults: {
    architect: 'claude-code',
    developer: 'claude-code',
    tester: 'claude-code',
  },
  sprintEngineInitialSpawnRoles: ['architect', 'developer', 'tester'],
})
const partialConsumed = useWorkspaceStore
  .getState()
  .consumeSprintEngineInitialSpawns(partialLaunchIntentId, ['architect'])
assert.deepEqual(partialConsumed, ['architect'])
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === partialLaunchIntentId)
    ?.sprintEngineInitialSpawnAgentIds,
  ['developer-1', 'tester'],
  'partial consumption preserves initial spawn intent for roles not safe to launch yet',
)
assert.deepEqual(
  useWorkspaceStore.getState().consumeSprintEngineInitialSpawns(partialLaunchIntentId),
  ['developer-1', 'tester'],
  'unfiltered consumption still clears all remaining launch intent for legacy callers',
)

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

// Regression: a workspace_window.closed event can reach a renderer that never
// held the closing window record (routing drift). The movedWorkspaceIds payload
// must still route those workspaces to the fallback window, and a foreign-window
// close must not flip this renderer's global active workspace.
const driftWorkspace = (id: string, folderPath: string | null = null): Workspace =>
  ({ id, name: id, folderPath, agents: {} }) as unknown as Workspace
const driftWindow = (id: string, workspaceIds: string[], active: string | null): WorkspaceWindowState => ({
  id,
  kind: id === 'A' ? 'primary' : 'detached',
  workspaceIds,
  activeWorkspaceId: active,
  bounds: null,
  isMaximized: false,
  displayId: null,
  createdAt: 1,
  lastFocusedAt: 1,
})
useWorkspaceStore.setState({
  workspaces: [driftWorkspace('drift-a'), driftWorkspace('drift-b')],
  activeWorkspaceId: 'drift-a',
  primaryWorkspaceWindowId: 'A',
  // This renderer only knows window A; the closing window 'B' is absent locally.
  workspaceWindows: [driftWindow('A', ['drift-a'], 'drift-a')],
  workspaceRegistryEmptyState: null,
})
useWorkspaceStore.getState().applyWorkspaceClosedEvent({
  windowId: 'B',
  fallbackWindowId: 'A',
  movedWorkspaceIds: ['drift-b'],
  createdAt: 2000,
})
state = useWorkspaceStore.getState()
assert.deepEqual(
  state.workspaceWindows.find((windowState) => windowState.id === 'A')?.workspaceIds,
  ['drift-a', 'drift-b'],
  'movedWorkspaceIds route to the fallback window even when the closing window record is absent locally',
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'A')?.activeWorkspaceId,
  'drift-a',
  'a foreign-window close does not flip the fallback window active workspace',
)
assert.equal(state.activeWorkspaceId, 'drift-a', 'a foreign-window close does not flip the global active workspace')

// Regression: a user move of the active workspace from the current/source window
// ('primary' — the id the slice derives for this renderer in the test env) to
// another window transfers exactly one-window membership and falls this
// renderer's global active back to its own window's remaining workspace, so
// global active never points at a workspace that now lives in another window.
useWorkspaceStore.setState({
  workspaces: [driftWorkspace('move-1'), driftWorkspace('move-2')],
  activeWorkspaceId: 'move-1',
  primaryWorkspaceWindowId: 'primary',
  workspaceWindows: [driftWindow('primary', ['move-1', 'move-2'], 'move-1')],
  workspaceRegistryEmptyState: null,
})
useWorkspaceStore.getState().moveWorkspaceToWindow('move-1', 'detached-b', 'primary')
state = useWorkspaceStore.getState()
assert.deepEqual(
  state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.workspaceIds,
  ['move-2'],
  'source window keeps only its remaining workspace after the move',
)
assert.deepEqual(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-b')?.workspaceIds,
  ['move-1'],
  'target window owns exactly the moved workspace (one-window membership)',
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.activeWorkspaceId,
  'move-2',
  'source window active falls back deterministically',
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-b')?.activeWorkspaceId,
  'move-1',
  'target window focuses the moved workspace',
)
assert.equal(
  state.activeWorkspaceId,
  'move-2',
  'global active follows this renderer window fallback, not the moved-away workspace',
)
// The source renderer applying its own accepted moved event (target is the other
// window, not this renderer's window) stays idempotent and must not flip global
// active back to the moved-away workspace.
useWorkspaceStore.getState().applyWorkspaceMovedEvent({
  workspaceId: 'move-1',
  fromWindowId: 'primary',
  toWindowId: 'detached-b',
  makeActive: true,
  createdAt: 3000,
  isCurrentWindowTarget: false,
})
state = useWorkspaceStore.getState()
assert.deepEqual(
  state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.workspaceIds,
  ['move-2'],
  'accepted event re-application is idempotent for source membership',
)
assert.equal(
  state.activeWorkspaceId,
  'move-2',
  'an accepted move event for another window does not flip the source renderer global active',
)

// Regression: the failed createWorkspaceWindow rollback path moves the workspace
// back INTO the current window ('primary') using the failed target ('detached-b')
// as sourceWindowId. Because the move target is this renderer's own window, the
// restored workspace must be refocused as the global active, while real move-out
// operations (above) keep the source-window fallback.
useWorkspaceStore.getState().moveWorkspaceToWindow('move-1', 'primary', 'detached-b')
state = useWorkspaceStore.getState()
assert.deepEqual(
  state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.workspaceIds,
  ['move-1', 'move-2'],
  'the restored workspace returns to the current window (one-window membership)',
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-b'),
  undefined,
  'the emptied target window is dropped after the rollback move',
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.activeWorkspaceId,
  'move-1',
  'the current window refocuses the restored workspace',
)
assert.equal(
  state.activeWorkspaceId,
  'move-1',
  'the rollback restores global active to the returned workspace',
)

// Regression: applying a broadcast workspace.created event inserts the workspace
// at its folder head (deterministic) and assigns it to the target window. When
// the target is ANOTHER window, this renderer's global active is not flipped;
// when the target is this renderer's own window, the creation is focused.
useWorkspaceStore.setState({
  workspaces: [driftWorkspace('repo-a-1', '/repo/a'), driftWorkspace('repo-b-1', '/repo/b')],
  activeWorkspaceId: 'repo-a-1',
  primaryWorkspaceWindowId: 'primary',
  workspaceWindows: [driftWindow('primary', ['repo-a-1', 'repo-b-1'], 'repo-a-1')],
  workspaceRegistryEmptyState: null,
})
useWorkspaceStore.getState().applyWorkspaceCreatedEvent({
  workspace: driftWorkspace('repo-a-2', '/repo/a'),
  windowId: 'detached-z',
  folderPath: '/repo/a',
  createdAt: 4000,
  isCurrentWindowTarget: false,
})
state = useWorkspaceStore.getState()
assert.deepEqual(
  state.workspaces.map((workspace) => workspace.id),
  ['repo-a-2', 'repo-a-1', 'repo-b-1'],
  'a created event inserts the workspace at the head of its folder block',
)
assert.deepEqual(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-z')?.workspaceIds,
  ['repo-a-2'],
  'the created workspace is assigned to the target window',
)
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'detached-z')?.activeWorkspaceId,
  'repo-a-2',
  'the target window focuses the created workspace',
)
assert.equal(
  state.activeWorkspaceId,
  'repo-a-1',
  'a creation targeting another window does not flip this renderer global active',
)
// A creation targeting THIS renderer's own window ('primary') focuses it globally.
useWorkspaceStore.getState().applyWorkspaceCreatedEvent({
  workspace: driftWorkspace('repo-a-3', '/repo/a'),
  windowId: 'primary',
  folderPath: '/repo/a',
  createdAt: 4100,
  isCurrentWindowTarget: true,
})
state = useWorkspaceStore.getState()
assert.equal(
  state.workspaceWindows.find((windowState) => windowState.id === 'primary')?.workspaceIds[0],
  'repo-a-3',
  'a creation into this window is assigned at its head',
)
assert.equal(
  state.activeWorkspaceId,
  'repo-a-3',
  'a creation into this renderer window is focused as global active',
)

// --- Open-in-new-chat seeding (addWorkspace `seedAgent`) ---------------------

type SeededTab = { component?: unknown; name?: unknown; config?: Record<string, unknown> }
const firstTab = (ws: Workspace | undefined): SeededTab | undefined => {
  let found: SeededTab | undefined
  const visit = (node: { component?: unknown; children?: unknown[] } | undefined) => {
    if (!node || found) return
    if (node.component === 'agent' || node.component === 'terminal') {
      found = node as SeededTab
      return
    }
    ;(node.children as Array<typeof node> | undefined)?.forEach(visit)
  }
  visit(ws?.layoutModel.layout as never)
  return found
}

// Specialist seed: the lone agent record is initialized as a specialist and the
// lone layout tab is renamed, all at creation time.
const specialistChatId = useWorkspaceStore.getState().addWorkspace(soloDevTemplate, {
  folderPath: '/Users/example/seed',
  templateAgentCli: 'codex',
  seedAgent: {
    tabName: 'Ada',
    agentPatch: {
      name: 'Ada',
      cli: 'codex',
      kind: 'specialist',
      specialistId: 'architect',
      cliStartupPrompt: 'SOUL_PROMPT',
    },
  },
})
state = useWorkspaceStore.getState()
const specialistChat = state.workspaces.find((workspace) => workspace.id === specialistChatId)
assert.equal(specialistChat?.agents['agent-1']?.kind, 'specialist')
assert.equal(specialistChat?.agents['agent-1']?.specialistId, 'architect')
assert.equal(specialistChat?.agents['agent-1']?.cli, 'codex')
assert.equal(specialistChat?.agents['agent-1']?.name, 'Ada')
assert.equal(specialistChat?.agents['agent-1']?.cliStartupPrompt, 'SOUL_PROMPT')
assert.equal(firstTab(specialistChat)?.component, 'agent')
assert.equal(firstTab(specialistChat)?.name, 'Ada')

// Conversation seed: runtime patch lands on the lone agent record.
const conversationChatId = useWorkspaceStore.getState().addWorkspace(soloDevTemplate, {
  folderPath: '/Users/example/seed',
  seedAgent: {
    tabName: 'GPT-5',
    agentPatch: { name: 'GPT-5', runtimeKind: 'conversation', conversation: { providerId: 'openai', modelId: 'gpt-5' } },
  },
})
state = useWorkspaceStore.getState()
const conversationChat = state.workspaces.find((workspace) => workspace.id === conversationChatId)
assert.equal(conversationChat?.agents['agent-1']?.runtimeKind, 'conversation')
assert.deepEqual(conversationChat?.agents['agent-1']?.conversation, { providerId: 'openai', modelId: 'gpt-5' })
assert.equal(firstTab(conversationChat)?.name, 'GPT-5')

// Terminal seed: the lone agent tab is swapped for a terminal tab and no agent
// record is created.
const terminalChatId = useWorkspaceStore.getState().addWorkspace(soloDevTemplate, {
  folderPath: '/Users/example/seed',
  seedAgent: { terminal: { terminalId: 'terminal-seed-1' }, tabName: 'Terminal' },
})
state = useWorkspaceStore.getState()
const terminalChat = state.workspaces.find((workspace) => workspace.id === terminalChatId)
assert.deepEqual(terminalChat?.agents, {})
const terminalTab = firstTab(terminalChat)
assert.equal(terminalTab?.component, 'terminal')
assert.equal(terminalTab?.name, 'Terminal')
assert.deepEqual(terminalTab?.config, { terminalId: 'terminal-seed-1' })

// applySoloChatSeed is pure: it clones, never mutating the source template.
const seedSource = {
  global: {},
  borders: [],
  layout: { type: 'row', children: [{ type: 'tabset', children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'agent-1' } }] }] },
} as never
const renamed = applySoloChatSeed(seedSource, { tabName: 'Renamed' })
assert.notEqual(renamed, seedSource)
assert.equal(firstTab({ layoutModel: renamed } as never)?.name, 'Renamed')
assert.equal(firstTab({ layoutModel: seedSource } as never)?.name, 'Agent')
const swapped = applySoloChatSeed(seedSource, { terminal: { terminalId: 't-9' }, tabName: 'Terminal' })
assert.equal(firstTab({ layoutModel: swapped } as never)?.component, 'terminal')
assert.equal(firstTab({ layoutModel: seedSource } as never)?.component, 'agent')

// Regression: a Sprint Engine roster role missing from the CLI-defaults map
// must NOT throw in addWorkspace. addWorkspace runs AFTER
// initializeSprintEngineState has already written run.yaml and (in worktree
// mode) created the git worktree+branch, so a throw orphaned a real on-disk run
// with no workspace — observed with plans whose roster included nuclear_reviewer
// (which was absent from the defaults map). nuclear_reviewer now resolves from
// the completed map; an open-ended/custom role (SprintEngineRoleId is `string`)
// falls back to the team's architect CLI instead of aborting creation.
const openRoleState = createInitialSprintEngineState({
  name: 'Open Role Team',
  goal: 'Roster includes roles outside the CLI-defaults map.',
  roleCounts: { architect: 1, nuclear_reviewer: 1, qa_lead: 1 },
})
let openRoleId: string | undefined
assert.doesNotThrow(() => {
  openRoleId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
    name: 'Open Role Team',
    folderPath: '/Users/example/open-role',
    sprintEngineState: openRoleState,
    // Deliberately supply only the architect default; nuclear_reviewer and the
    // custom qa_lead role are left to the completed map / fallback respectively.
    sprintEngineRoleCliDefaults: { architect: 'codex' },
  })
}, 'a roster role missing from the CLI-defaults map never throws in addWorkspace')
state = useWorkspaceStore.getState()
const openRoleWorkspace = state.workspaces.find((workspace) => workspace.id === openRoleId)
assert.ok(openRoleWorkspace, 'the workspace is created despite an unmapped roster role')
assert.equal(
  openRoleWorkspace?.agents.nuclear_reviewer?.cli,
  'claude-code',
  'nuclear_reviewer resolves from the completed default CLI map',
)
assert.equal(
  openRoleWorkspace?.agents.qa_lead?.cli,
  'codex',
  'an open-ended/custom role falls back to the team architect CLI',
)

// --- Explicit automations-host mode (T2) ------------------------------------
// An explicit non-standard `mode` is honored at creation so the automations
// executor can create the hidden background host.
const automationsHostId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Automations Host',
  folderPath: '/Users/example/project',
  mode: 'automations-host',
})
state = useWorkspaceStore.getState()
assert.equal(
  state.workspaces.find((workspace) => workspace.id === automationsHostId)?.mode,
  'automations-host',
  'an explicit automations-host mode wins over standard-derivation',
)

// Omitting mode behaves exactly as today: standard-derivation is unchanged.
const derivedStandardId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Plain Standard',
  folderPath: '/Users/example/project',
})
state = useWorkspaceStore.getState()
assert.equal(
  state.workspaces.find((workspace) => workspace.id === derivedStandardId)?.mode,
  'standard',
  'an omitted mode still derives standard',
)

console.log('workspacesSlice.test.ts: ok')
