import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import {
  mapMigrationWorkspaces,
  normalizeWorkspaceForPartialize,
  preserveNewerSprintEngineAutomationState,
} from './normalizers'

const baseWorkspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-1',
  name: 'Test',
  folderPath: '/Users/example/project',
  folderMissing: false,
  mode: 'standard',
  layoutModel: undefined as unknown as Workspace['layoutModel'],
  agents: {},
  sprintEngineState: null,
  sprintEngineContext: null,
  multiloopState: null,
  multiloopContext: null,
  sprintEngineAutoState: undefined,
  multiloopAutoState: undefined,
  guidedBriefState: null,
  sprintEngineRoleCliDefaults: undefined,
  memory: undefined,
  worktreeState: undefined,
  editorState: { openFiles: [], activeFilePath: null },
  highlight: undefined,
  lastTerminalOutputAt: undefined,
  ...overrides,
} as unknown as Workspace)

// mapMigrationWorkspaces mutates the carrier in place, mapping each workspace.
const carrier = { workspaces: [baseWorkspace({ id: 'a' }), baseWorkspace({ id: 'b' })] }
mapMigrationWorkspaces(carrier, (ws) => ({ ...ws, name: `${ws.id}-renamed` }))
assert.deepEqual(
  carrier.workspaces.map((w) => w.name),
  ['a-renamed', 'b-renamed'],
)
assert.equal(carrier.workspaces.length, 2)

// normalizeWorkspaceForPartialize strips file content while keeping the file list.
const dirty = baseWorkspace({
  editorState: {
    openFiles: [
      { path: '/a.ts', name: 'a.ts', content: 'should be stripped', isDirty: true },
      { path: '/b.ts', name: 'b.ts', content: 'also stripped', isDirty: true },
    ],
    activeFilePath: '/a.ts',
  } as unknown as Workspace['editorState'],
})
const cleaned = normalizeWorkspaceForPartialize(dirty)
const cleanedFiles = cleaned.editorState?.openFiles ?? []
assert.equal(cleanedFiles.length, 2)
for (const file of cleanedFiles) {
  assert.equal(file.isDirty, false)
  assert.equal((file as unknown as { content?: string }).content, undefined)
}
assert.equal(cleaned.editorState?.activeFilePath, '/a.ts')

const autoRunCleaned = normalizeWorkspaceForPartialize(baseWorkspace({
  sprintEngineAutoState: {
    desiredMode: 'run_agents_and_approve_artifacts',
    runtimeState: 'running',
    keepDoneAgentTerminals: true,
    cliPermissionPreset: 'bypass_all',
    maxConcurrentAgents: 4,
    pendingSpawns: [{ taskId: 'T1', agentId: 'developer-1', startedAt: 1 }],
    deliveredAgentNotificationEventKeys: ['EVT-1'],
  },
}))
assert.equal(autoRunCleaned.sprintEngineAutoState.desiredMode, 'run_agents_and_approve_artifacts')
assert.equal(autoRunCleaned.sprintEngineAutoState.runtimeState, 'running')
assert.deepEqual(autoRunCleaned.sprintEngineAutoState.pendingSpawns, [])
assert.equal(autoRunCleaned.sprintEngineAutoState.maxConcurrentAgents, 4)

// Creation "start now" launch intent is session-only: persisting it would
// replay the initial spawns on the next app start.
const initialSpawnCleaned = normalizeWorkspaceForPartialize(baseWorkspace({
  sprintEngineInitialSpawnAgentIds: ['frontend'],
}))
assert.equal(initialSpawnCleaned.sprintEngineInitialSpawnAgentIds, undefined)

// The Sprint Engine projection is a disk-backed cache (projection.json), so it
// is dropped from the persisted registry to avoid the 4s projection-poll write
// storm. Durable identity (mode) is still derived from the live state before it
// is stripped, so a Sprint Engine workspace stays classified as 'sprintengine'.
const projectionCleaned = normalizeWorkspaceForPartialize(baseWorkspace({
  mode: 'sprintengine',
  sprintEngineContext: { statePath: '/p/.sprintengine/state', teamSlug: 'core' } as unknown as Workspace['sprintEngineContext'],
  sprintEngineState: {
    goal: 'Ship it',
    tasks: [{ id: 'T1', status: 'done' }],
    artifacts: [{ id: 'A1' }],
  } as unknown as Workspace['sprintEngineState'],
}))
assert.equal(projectionCleaned.sprintEngineState, null)
assert.equal(projectionCleaned.mode, 'sprintengine')
assert.notEqual(projectionCleaned.sprintEngineContext, null)

// normalizeWorkspaceForPartialize zeros the in-memory stream buffer + status on agents
// that survive a save so they cold-load idle instead of streaming.
const withAgent = baseWorkspace({
  agents: {
    'agent-1': {
      id: 'agent-1',
      name: 'Specialist',
      kind: 'specialist',
      specialistId: 'architect',
      status: 'streaming',
      streamBuffer: 'partial chunk',
      cliOnboardingPromptSent: false,
      cliStartupPrompt: 'kept',
    },
  } as unknown as Workspace['agents'],
})
const withAgentCleaned = normalizeWorkspaceForPartialize(withAgent)
const persistedAgent = (withAgentCleaned.agents as Record<string, { status: string; streamBuffer: string; cliStartupPrompt?: string }>)['agent-1']
assert.equal(persistedAgent.status, 'idle')
assert.equal(persistedAgent.streamBuffer, '')
// Specialist agents that have not yet sent their onboarding prompt keep cliStartupPrompt.
assert.equal(persistedAgent.cliStartupPrompt, 'kept')

const withAgentAlreadyOnboarded = baseWorkspace({
  agents: {
    'agent-2': {
      id: 'agent-2',
      name: 'Specialist',
      kind: 'specialist',
      specialistId: 'architect',
      status: 'idle',
      streamBuffer: '',
      cliOnboardingPromptSent: true,
      cliStartupPrompt: 'should be dropped',
    },
  } as unknown as Workspace['agents'],
})
const onboardedCleaned = normalizeWorkspaceForPartialize(withAgentAlreadyOnboarded)
const onboardedAgent = (onboardedCleaned.agents as Record<string, { cliStartupPrompt?: string }>)['agent-2']
assert.equal(onboardedAgent.cliStartupPrompt, undefined)

const newerLocalAutomation = preserveNewerSprintEngineAutomationState(
  baseWorkspace({
    id: 'ws-sync',
    sprintEngineAutoState: {
      desiredMode: 'manual',
      runtimeState: 'idle',
      changedAt: 100,
    } as Workspace['sprintEngineAutoState'],
  }),
  baseWorkspace({
    id: 'ws-sync',
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'blocked',
      reason: 'blocked_on_input',
      reasonTaskId: 'T3',
      reasonMessage: 'Task T3 is waiting on input.',
      changedAt: 200,
    } as Workspace['sprintEngineAutoState'],
  }),
)
assert.equal(newerLocalAutomation.sprintEngineAutoState?.desiredMode, 'run_agents')
assert.equal(newerLocalAutomation.sprintEngineAutoState?.runtimeState, 'blocked')
assert.equal(newerLocalAutomation.sprintEngineAutoState?.reasonTaskId, 'T3')

const newerIncomingAutomation = preserveNewerSprintEngineAutomationState(
  baseWorkspace({
    id: 'ws-sync',
    sprintEngineAutoState: {
      desiredMode: 'run_agents_and_approve_artifacts',
      runtimeState: 'running',
      changedAt: 300,
    } as Workspace['sprintEngineAutoState'],
  }),
  baseWorkspace({
    id: 'ws-sync',
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'blocked',
      changedAt: 200,
    } as Workspace['sprintEngineAutoState'],
  }),
)
assert.equal(newerIncomingAutomation.sprintEngineAutoState?.desiredMode, 'run_agents_and_approve_artifacts')
assert.equal(newerIncomingAutomation.sprintEngineAutoState?.runtimeState, 'running')

// Backlog + Git panel view state survives partialize, with malformed fields
// coerced rather than dropped, and absent state stays undefined (no per-workspace
// bloat).
const viewStateClean = normalizeWorkspaceForPartialize(baseWorkspace({
  backlogState: {
    selectedRelativePath: 'backlog/a.md',
    view: 'quick_wins',
    sort: 'priority',
    search: 'auth',
  },
  gitPanelState: {
    activeView: 'log',
    activeScopeId: 'worktree-x',
    commitDraftsByScopeId: { 'worktree-x': 'WIP', main: '   ' },
  },
} as unknown as Partial<Workspace>) as unknown as Workspace)
assert.deepEqual(viewStateClean.backlogState, {
  selectedRelativePath: 'backlog/a.md',
  view: 'quick_wins',
  sort: 'priority',
  search: 'auth',
})
// The blank `main` draft is dropped; the real one is kept.
assert.deepEqual(viewStateClean.gitPanelState, {
  activeView: 'log',
  activeScopeId: 'worktree-x',
  commitDraftsByScopeId: { 'worktree-x': 'WIP' },
})

const malformedViewState = normalizeWorkspaceForPartialize(baseWorkspace({
  backlogState: { view: 'nope', sort: 'nope', search: 5, selectedRelativePath: '  ' },
  gitPanelState: { activeView: 'nope', activeScopeId: '', commitDraftsByScopeId: 'oops' },
} as unknown as Partial<Workspace>) as unknown as Workspace)
assert.deepEqual(malformedViewState.backlogState, {
  selectedRelativePath: null,
  view: 'all',
  sort: 'recent',
  search: '',
})
assert.deepEqual(malformedViewState.gitPanelState, {
  activeView: 'changes',
  activeScopeId: 'main',
  commitDraftsByScopeId: {},
})

const noViewState = normalizeWorkspaceForPartialize(baseWorkspace())
assert.equal(noViewState.backlogState, undefined, 'absent backlog state stays undefined')
assert.equal(noViewState.gitPanelState, undefined, 'absent git panel state stays undefined')

console.log('normalizers.test.ts: ok')
