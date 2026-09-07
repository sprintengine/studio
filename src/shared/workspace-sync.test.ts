import assert from 'node:assert/strict'

import {
  applyWorkspaceSyncEvent,
  applyWorkspaceSyncSnapshot,
  type WorkspaceSyncEvent,
  type WorkspaceSyncState,
} from './workspace-sync'
import type { Workspace, WorkspaceWindowState } from '../renderer/src/types/workspace'

const workspaceCompatibilityCheck: Workspace extends Extract<WorkspaceSyncEvent, { type: 'workspace.created' }>['payload']['workspace']
  ? true
  : false = true
void workspaceCompatibilityCheck

function workspace(id: string, folderPath: string | null = null): Workspace {
  return {
    id,
    name: id,
    mode: 'standard',
    folderPath,
    templateId: 'standard-test',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    sprintEngineState: null,
    sprintEngineAutoState: {
      desiredMode: 'manual',
      runtimeState: 'idle',
      cliPermissionPreset: 'manual',
      maxConcurrentAgents: 0,
      deliveredAgentNotificationEventKeys: [],
    },
    createdAt: 1,
  }
}

function windowState(
  id: string,
  workspaceIds: string[],
  activeWorkspaceId: string | null,
  kind: WorkspaceWindowState['kind'] = id === 'primary' ? 'primary' : 'detached'
): WorkspaceWindowState {
  return {
    id,
    kind,
    workspaceIds,
    activeWorkspaceId,
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: 1,
    lastFocusedAt: 1,
  }
}

function baseState(): WorkspaceSyncState {
  const wsOne = workspace('ws-one', '/repo/a')
  wsOne.agents['agent-one'] = {
    id: 'agent-one',
    name: 'Agent One',
    status: 'idle',
    execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
    cliSessionId: 'session-local',
    cliStartRequested: true,
    cliHasLaunched: true,
    cliResumeAvailable: true,
    cliOnboardingPromptSent: true,
    cli: 'codex',
  }

  return {
    workspaces: [
      workspace('ws-two', '/repo/a'),
      wsOne,
      workspace('ws-three', '/repo/b'),
    ],
    activeWorkspaceId: 'ws-one',
    workspaceWindows: [
      windowState('primary', ['ws-one', 'ws-two'], 'ws-one'),
      windowState('detached-a', ['ws-three'], 'ws-three'),
    ],
    primaryWorkspaceWindowId: 'primary',
    lastAppliedWorkspaceSyncSequence: 10,
  }
}

function event<T extends WorkspaceSyncEvent>(input: Omit<T, 'id' | 'sourceWindowId' | 'createdAt'>): T {
  return {
    id: `event-${input.sequence}`,
    sourceWindowId: 'primary',
    createdAt: input.sequence,
    ...input,
  } as T
}

const rendererWorkspacePayload: Extract<WorkspaceSyncEvent, { type: 'workspace.created' }>['payload']['workspace'] =
  workspace('compile-full-workspace')
void rendererWorkspacePayload

// @ts-expect-error workspace.created requires the full renderer-compatible workspace surface.
const incompleteWorkspacePayload: Extract<WorkspaceSyncEvent, { type: 'workspace.created' }>['payload']['workspace'] = {
  id: 'compile-incomplete',
  name: 'Incomplete',
  folderPath: null,
  agents: {},
}
void incompleteWorkspacePayload

let state = baseState()
const moveEvent = event<Extract<WorkspaceSyncEvent, { type: 'workspace.moved_to_window' }>>({
  type: 'workspace.moved_to_window',
  sequence: 11,
  payload: {
    workspaceId: 'ws-one',
    fromWindowId: 'primary',
    toWindowId: 'detached-a',
    makeActive: true,
  },
})
const moved = applyWorkspaceSyncEvent(state, moveEvent)
assert.equal(moved.status, 'applied')
assert.deepEqual(
  moved.state.workspaceWindows.find((candidate) => candidate.id === 'primary')?.workspaceIds,
  ['ws-two'],
)
assert.equal(
  moved.state.workspaceWindows.find((candidate) => candidate.id === 'primary')?.activeWorkspaceId,
  'ws-two',
)
assert.deepEqual(
  moved.state.workspaceWindows.find((candidate) => candidate.id === 'detached-a')?.workspaceIds,
  ['ws-three', 'ws-one'],
)
assert.equal(
  moved.state.workspaceWindows.find((candidate) => candidate.id === 'detached-a')?.activeWorkspaceId,
  'ws-one',
)
assert.equal(
  moved.state.workspaceWindows.find((candidate) => candidate.id === 'detached-a')?.lastFocusedAt,
  11,
)
state = moved.state

const duplicate = applyWorkspaceSyncEvent(state, moveEvent)
assert.equal(duplicate.status, 'ignored')
assert.equal(duplicate.state, state, 'duplicate events leave state identity unchanged')

const stale = applyWorkspaceSyncEvent(state, { ...moveEvent, sequence: 9, id: 'event-9' })
assert.equal(stale.status, 'ignored')
assert.equal(stale.state, state, 'older events leave state identity unchanged')

const gap = applyWorkspaceSyncEvent(
  state,
  event<Extract<WorkspaceSyncEvent, { type: 'workspace_window.active_changed' }>>({
    type: 'workspace_window.active_changed',
    sequence: 13,
    payload: { windowId: 'primary', workspaceId: 'ws-two' },
  })
)
assert.equal(gap.status, 'sequence_gap')
assert.equal(gap.expectedSequence, 12)
assert.equal(gap.receivedSequence, 13)
assert.equal(gap.state, state, 'sequence gaps do not partially apply events')

const placement = applyWorkspaceSyncEvent(
  state,
  event<Extract<WorkspaceSyncEvent, { type: 'workspace_window.placement_updated' }>>({
    type: 'workspace_window.placement_updated',
    sequence: 12,
    payload: {
      windowId: 'detached-a',
      bounds: { x: 10, y: 20, width: 900, height: 700 },
      isMaximized: true,
      displayId: 2,
    },
  })
)
assert.equal(placement.status, 'applied')
assert.deepEqual(
  placement.state.workspaceWindows.find((candidate) => candidate.id === 'detached-a')?.bounds,
  { x: 10, y: 20, width: 900, height: 700 },
)
assert.equal(
  placement.state.workspaceWindows.find((candidate) => candidate.id === 'detached-a')?.lastFocusedAt,
  12,
)
assert.deepEqual(
  placement.state.workspaces.map((candidate) => candidate.id),
  ['ws-two', 'ws-one', 'ws-three'],
  'placement updates do not rewrite workspace objects or ordering',
)
state = placement.state

const close = applyWorkspaceSyncEvent(
  state,
  event<Extract<WorkspaceSyncEvent, { type: 'workspace_window.closed' }>>({
    type: 'workspace_window.closed',
    sequence: 13,
    payload: { windowId: 'detached-a', fallbackWindowId: 'primary', movedWorkspaceIds: ['ws-three', 'ws-one'] },
  })
)
assert.equal(close.status, 'applied')
assert.equal(close.state.workspaceWindows.find((candidate) => candidate.id === 'detached-a'), undefined)
assert.deepEqual(close.state.workspaceWindows[0]?.workspaceIds, ['ws-two', 'ws-three', 'ws-one'])
assert.equal(close.state.workspaceWindows[0]?.activeWorkspaceId, 'ws-one')
state = close.state

const created = workspace('ws-new', '/repo/a')
const createResult = applyWorkspaceSyncEvent(
  state,
  event<Extract<WorkspaceSyncEvent, { type: 'workspace.created' }>>({
    type: 'workspace.created',
    sequence: 14,
    payload: {
      workspace: created,
      windowId: 'primary',
      insert: { kind: 'folder_head', folderPath: '/repo/a' },
    },
  })
)
assert.equal(createResult.status, 'applied')
assert.deepEqual(
  createResult.state.workspaces.map((candidate) => candidate.id),
  ['ws-new', 'ws-two', 'ws-one', 'ws-three'],
  'created workspaces insert at the head of their folder block',
)
assert.deepEqual(createResult.state.workspaceWindows[0]?.workspaceIds, [
  'ws-new',
  'ws-two',
  'ws-three',
  'ws-one',
])
assert.equal(createResult.state.workspaceWindows[0]?.activeWorkspaceId, 'ws-new')
assert.equal(createResult.state.workspaceWindows[0]?.lastFocusedAt, 14)
state = createResult.state

// A worktree chat's folderPath is the worktree, but the block it joins is the
// project it was cut from — otherwise it unshifts to the registry head and, on
// the next restart, drags its parent's whole group to the top of the sidebar.
const worktreeCreated: Workspace = {
  ...workspace('ws-worktree', '/repo/.multicode-worktrees/b/chat-a1b2'),
  worktree: { branch: 'agent/chat-a1b2', repoRoot: '/repo/b' },
}
const worktreeCreateResult = applyWorkspaceSyncEvent(
  state,
  event<Extract<WorkspaceSyncEvent, { type: 'workspace.created' }>>({
    type: 'workspace.created',
    sequence: 15,
    payload: {
      workspace: worktreeCreated,
      windowId: 'primary',
      insert: { kind: 'folder_head', folderPath: '/repo/.multicode-worktrees/b/chat-a1b2' },
    },
  })
)
assert.equal(worktreeCreateResult.status, 'applied')
assert.deepEqual(
  worktreeCreateResult.state.workspaces.map((candidate) => candidate.id),
  ['ws-new', 'ws-two', 'ws-one', 'ws-worktree', 'ws-three'],
  'a created worktree chat inserts at the head of the project it was cut from',
)

const activeScoped = applyWorkspaceSyncEvent(
  state,
  event<Extract<WorkspaceSyncEvent, { type: 'workspace_window.active_changed' }>>({
    type: 'workspace_window.active_changed',
    sequence: 15,
    payload: { windowId: 'missing-window', workspaceId: 'ws-three' },
  })
)
assert.equal(activeScoped.status, 'applied')
assert.equal(activeScoped.state.activeWorkspaceId, 'ws-new')
assert.equal(activeScoped.state.workspaceWindows[0]?.activeWorkspaceId, 'ws-new')

const assignSession = applyWorkspaceSyncEvent(
  activeScoped.state,
  event<Extract<WorkspaceSyncEvent, { type: 'agent_terminal.session_assigned' }>>({
    type: 'agent_terminal.session_assigned',
    sequence: 16,
    payload: {
      workspaceId: 'ws-one',
      agentId: 'agent-one',
      sessionId: 'session-from-event',
      cli: 'claude-code',
      // Capabilities are stamped main-side onto the event; the applier stores
      // them verbatim rather than re-deriving resume behavior from `cli`.
      cliResumeAvailable: true,
      cliUsesStableSessionId: true,
    },
  })
)
assert.equal(assignSession.status, 'applied')
const assignedAgent = assignSession.state.workspaces.find((candidate) => candidate.id === 'ws-one')?.agents['agent-one']
assert.equal(assignedAgent?.cliSessionId, 'session-from-event')
assert.equal(assignedAgent?.cli, 'claude-code')
assert.equal(assignedAgent?.cliStartRequested, true)
assert.equal(assignedAgent?.cliHasLaunched, true)
assert.equal(assignedAgent?.cliResumeAvailable, true)
assert.equal(assignedAgent?.cliUsesStableSessionId, true)

const assignClaudeCodeSession = applyWorkspaceSyncEvent(
  assignSession.state,
  event<Extract<WorkspaceSyncEvent, { type: 'agent_terminal.session_assigned' }>>({
    type: 'agent_terminal.session_assigned',
    sequence: 17,
    payload: {
      workspaceId: 'ws-one',
      agentId: 'agent-claude-code',
      sessionId: 'session-from-claude-code-event',
      cli: 'claude-code',
      cliResumeAvailable: true,
      cliUsesStableSessionId: true,
    },
  })
)
assert.equal(assignClaudeCodeSession.status, 'applied')
const assignedClaudeCodeAgent = assignClaudeCodeSession.state.workspaces.find((candidate) => candidate.id === 'ws-one')?.agents['agent-claude-code']
assert.equal(assignedClaudeCodeAgent?.cliResumeAvailable, true)
assert.equal(assignedClaudeCodeAgent?.cliUsesStableSessionId, true)

const assignZaiSession = applyWorkspaceSyncEvent(
  assignClaudeCodeSession.state,
  event<Extract<WorkspaceSyncEvent, { type: 'agent_terminal.session_assigned' }>>({
    type: 'agent_terminal.session_assigned',
    sequence: 18,
    payload: {
      workspaceId: 'ws-one',
      agentId: 'agent-zai',
      sessionId: 'session-from-zai-event',
      cli: 'zai',
      cliResumeAvailable: true,
      cliUsesStableSessionId: true,
    },
  })
)
assert.equal(assignZaiSession.status, 'applied')
const assignedZaiAgent = assignZaiSession.state.workspaces.find((candidate) => candidate.id === 'ws-one')?.agents['agent-zai']
assert.equal(assignedZaiAgent?.cliResumeAvailable, true)
assert.equal(assignedZaiAgent?.cliUsesStableSessionId, true)

// The applier stores exactly what the payload carries — it must NOT re-derive
// from `cli`. A codex-shaped payload (resume yes, stable-session no) and a
// generic-shell-shaped payload (both off) prove the seam is manifest-driven.
const assignCodexSession = applyWorkspaceSyncEvent(
  assignZaiSession.state,
  event<Extract<WorkspaceSyncEvent, { type: 'agent_terminal.session_assigned' }>>({
    type: 'agent_terminal.session_assigned',
    sequence: 19,
    payload: {
      workspaceId: 'ws-one',
      agentId: 'agent-codex',
      sessionId: 'session-from-codex-event',
      cli: 'codex',
      cliResumeAvailable: true,
      cliUsesStableSessionId: false,
    },
  })
)
assert.equal(assignCodexSession.status, 'applied')
const assignedCodexAgent = assignCodexSession.state.workspaces.find((candidate) => candidate.id === 'ws-one')?.agents['agent-codex']
assert.equal(assignedCodexAgent?.cliResumeAvailable, true)
assert.equal(assignedCodexAgent?.cliUsesStableSessionId, false)

const assignShellSession = applyWorkspaceSyncEvent(
  assignCodexSession.state,
  event<Extract<WorkspaceSyncEvent, { type: 'agent_terminal.session_assigned' }>>({
    type: 'agent_terminal.session_assigned',
    sequence: 20,
    payload: {
      workspaceId: 'ws-one',
      agentId: 'agent-shell',
      sessionId: 'session-from-shell-event',
      cli: 'generic-shell',
      cliResumeAvailable: false,
      cliUsesStableSessionId: false,
    },
  })
)
assert.equal(assignShellSession.status, 'applied')
const assignedShellAgent = assignShellSession.state.workspaces.find((candidate) => candidate.id === 'ws-one')?.agents['agent-shell']
assert.equal(assignedShellAgent?.cliResumeAvailable, false)
assert.equal(assignedShellAgent?.cliUsesStableSessionId, false)

const launchUpdate = applyWorkspaceSyncEvent(
  assignSession.state,
  event<Extract<WorkspaceSyncEvent, { type: 'agent_terminal.launch_state_updated' }>>({
    type: 'agent_terminal.launch_state_updated',
    sequence: 17,
    payload: {
      workspaceId: 'ws-one',
      agentId: 'agent-one',
      cliSessionId: null,
      cliStartRequested: false,
      cliOnboardingPromptSent: false,
    },
  })
)
assert.equal(launchUpdate.status, 'applied')
const launchAgent = launchUpdate.state.workspaces.find((candidate) => candidate.id === 'ws-one')?.agents['agent-one']
assert.equal(launchAgent?.cliSessionId, undefined, 'launch state events can clear a stale session id')
assert.equal(launchAgent?.cliStartRequested, false)
assert.equal(launchAgent?.cliHasLaunched, true, 'omitted launch fields remain unchanged')
assert.equal(launchAgent?.cliOnboardingPromptSent, false)

const staleSnapshotState = applyWorkspaceSyncSnapshot(launchUpdate.state, {
  sequence: 16,
  state: {
    workspaces: [
      {
        ...workspace('ws-one', '/repo/a'),
        agents: {
          'agent-one': {
            id: 'agent-one',
            name: 'Agent One',
            status: 'idle',
            execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
            messages: [],
            streamBuffer: '',
          },
        },
      },
    ],
    activeWorkspaceId: 'ws-one',
    workspaceWindows: [windowState('primary', ['ws-one'], 'ws-one')],
    primaryWorkspaceWindowId: 'primary',
  },
})
assert.equal(staleSnapshotState, launchUpdate.state, 'stale snapshots cannot erase local terminal fields')

const refreshedSnapshotState = applyWorkspaceSyncSnapshot(launchUpdate.state, {
  sequence: 18,
  state: {
    workspaces: [workspace('ws-snapshot', '/repo/c')],
    activeWorkspaceId: 'ws-snapshot',
    workspaceWindows: [windowState('primary', ['ws-snapshot'], 'ws-snapshot')],
    primaryWorkspaceWindowId: 'primary',
  },
})
assert.equal(refreshedSnapshotState.lastAppliedWorkspaceSyncSequence, 18)
assert.equal(refreshedSnapshotState.activeWorkspaceId, 'ws-snapshot')

// Conversation runtime fields survive a workspace sync snapshot round-trip
// (T5 AC #5) and terminal agents are left untouched.
const runtimeSnapshotState = applyWorkspaceSyncSnapshot(refreshedSnapshotState, {
  sequence: 20,
  state: {
    workspaces: [
      {
        ...workspace('ws-runtime', '/repo/d'),
        agents: {
          'conv-agent': {
            id: 'conv-agent',
            name: 'Conversation Agent',
            status: 'idle',
            execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
            messages: [],
            streamBuffer: '',
            runtimeKind: 'conversation',
            conversation: { providerId: 'openai-compatible', modelId: 'gpt-4o' },
          },
          'term-agent': {
            id: 'term-agent',
            name: 'Terminal Agent',
            status: 'idle',
            execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
            messages: [],
            streamBuffer: '',
            runtimeKind: 'terminal',
            cli: 'codex',
          },
        },
      },
    ],
    activeWorkspaceId: 'ws-runtime',
    workspaceWindows: [windowState('primary', ['ws-runtime'], 'ws-runtime')],
    primaryWorkspaceWindowId: 'primary',
  },
})
const runtimeWs = runtimeSnapshotState.workspaces.find((candidate) => candidate.id === 'ws-runtime')
assert.equal(
  runtimeWs?.agents['conv-agent']?.runtimeKind,
  'conversation',
  'sync snapshot preserves conversation runtime kind',
)
assert.deepEqual(
  runtimeWs?.agents['conv-agent']?.conversation,
  { providerId: 'openai-compatible', modelId: 'gpt-4o' },
  'sync snapshot preserves the provider/model selection',
)
assert.equal(
  runtimeWs?.agents['term-agent']?.runtimeKind,
  'terminal',
  'sync snapshot keeps terminal agents terminal',
)
assert.equal(
  runtimeWs?.agents['term-agent']?.conversation,
  undefined,
  'terminal agents carry no conversation payload through sync',
)

console.log('workspace-sync.test.ts: ok')
