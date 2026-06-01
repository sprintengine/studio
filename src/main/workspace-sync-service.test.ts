import assert from 'node:assert/strict'

import { createWorkspaceSyncService } from './workspace-sync-service'
import type { Workspace } from '../renderer/src/types/workspace'
import type { WorkspaceSyncCommand, WorkspaceSyncSnapshot } from '../shared/workspace-sync'

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
      supervisorEnabled: false,
      enabled: false,
      autoApproveArtifacts: false,
      keepDoneAgentTerminals: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 0,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
    multiloopAutoState: {
      enabled: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 0,
      pendingSpawns: [],
    },
    createdAt: 1,
  }
}

function snapshot(): WorkspaceSyncSnapshot {
  return {
    sequence: 10,
    state: {
      workspaces: [workspace('ws-one'), workspace('ws-two')],
      activeWorkspaceId: 'ws-one',
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [
        {
          id: 'primary',
          kind: 'primary',
          workspaceIds: ['ws-one'],
          activeWorkspaceId: 'ws-one',
          bounds: null,
          isMaximized: false,
          displayId: null,
          createdAt: 1,
          lastFocusedAt: 1,
        },
        {
          id: 'detached-a',
          kind: 'detached',
          workspaceIds: ['ws-two'],
          activeWorkspaceId: 'ws-two',
          bounds: null,
          isMaximized: false,
          displayId: null,
          createdAt: 1,
          lastFocusedAt: 1,
        },
      ],
    },
  }
}

function main(): void {
  const service = createWorkspaceSyncService({ initialSnapshot: snapshot(), maxReplayEvents: 2, now: () => 1234 })

  function assertRejectedWithoutMutation(
    command: unknown,
    reason: string,
    sourceWindowId = 'primary',
    expectedSequence = 10
  ): void {
    const before = service.getSnapshot()
    const result = service.dispatch({ sourceWindowId, command })
    assert.equal(result.ok, false)
    assert.equal(result.reason, reason)
    assert.deepEqual(service.getSnapshot(), before, `${reason} should not mutate the service snapshot`)
    assert.equal(service.getSnapshot().sequence, expectedSequence, `${reason} should not advance the service sequence`)
    assert.deepEqual(service.getEventsAfter(expectedSequence), [], `${reason} should not append replay events`)
  }

  assertRejectedWithoutMutation(
    {
      type: 'workspace_window.set_active',
      payload: { windowId: 'detached-a', workspaceId: 'ws-two' },
    },
    'window_authority_mismatch',
  )
  assertRejectedWithoutMutation(
    {
      type: 'workspace.move_to_window',
      payload: {
        workspaceId: 'ws-two',
        fromWindowId: 'detached-a',
        toWindowId: 'primary',
        makeActive: true,
      },
    },
    'window_authority_mismatch',
  )
  assertRejectedWithoutMutation(
    {
      type: 'workspace_window.update_placement',
      payload: {
        windowId: 'detached-a',
        bounds: { x: 1, y: 2, width: 900, height: 700 },
        isMaximized: true,
        displayId: 9,
      },
    },
    'window_authority_mismatch',
  )
  assertRejectedWithoutMutation(
    {
      type: 'workspace_window.close',
      payload: { windowId: 'detached-a', fallbackWindowId: 'primary' },
    },
    'window_authority_mismatch',
  )
  assertRejectedWithoutMutation(
    {
      type: 'workspace.created',
      payload: {
        workspace: workspace('cross-window-created'),
        windowId: 'detached-a',
        insert: { kind: 'folder_head', folderPath: null },
      },
    },
    'window_authority_mismatch',
  )

  const invalidMove = service.dispatch({
    sourceWindowId: 'primary',
    command: {
      type: 'workspace.move_to_window',
      payload: {
        workspaceId: 'ws-two',
        fromWindowId: 'primary',
        toWindowId: 'detached-a',
        makeActive: true,
      },
    },
  })
  assert.equal(invalidMove.ok, false)
  assert.equal(invalidMove.reason, 'workspace_not_in_source_window')
  assert.equal(service.getSnapshot().sequence, 10, 'invalid commands do not advance the service sequence')
  assert.deepEqual(
    service.getSnapshot().state.workspaceWindows.map((windowState) => windowState.workspaceIds),
    [['ws-one'], ['ws-two']],
    'invalid commands do not mutate the service snapshot',
  )

  const activeCommand: WorkspaceSyncCommand = {
    type: 'workspace_window.set_active',
    payload: { windowId: 'primary', workspaceId: 'ws-one' },
  }
  const active = service.dispatch({ sourceWindowId: 'primary', command: activeCommand })
  assert.equal(active.ok, true)
  assert.equal(active.event.sequence, 11)
  assert.equal(active.event.id, 'workspace-sync-11')
  assert.equal(active.event.createdAt, 1234)
  assert.equal(active.event.type, 'workspace_window.active_changed')

  const placement = service.dispatch({
    sourceWindowId: 'detached-a',
    command: {
      type: 'workspace_window.update_placement',
      payload: {
        windowId: 'detached-a',
        bounds: { x: 1, y: 2, width: 900, height: 700 },
        isMaximized: true,
        displayId: 9,
      },
    },
  })
  assert.equal(placement.ok, true)
  assert.equal(placement.event.sequence, 12)

  const session = service.dispatch({
    sourceWindowId: 'primary',
    command: {
      type: 'agent_terminal.assign_session',
      payload: { workspaceId: 'ws-one', agentId: 'agent-one', sessionId: 'session-one', cli: 'codex' },
    },
  })
  assert.equal(session.ok, true)
  assert.equal(session.event.sequence, 13)

  assert.deepEqual(
    service.getEventsAfter(10).map((event) => event.sequence),
    [12, 13],
    'replay is bounded to the retained event window',
  )
  assert.deepEqual(
    service.getEventsAfter(12).map((event) => event.sequence),
    [13],
    'replay returns deterministic events after the requested sequence',
  )

  const terminalFromWrongWindow = service.dispatch({
    sourceWindowId: 'detached-a',
    command: {
      type: 'agent_terminal.update_launch_state',
      payload: { workspaceId: 'ws-one', agentId: 'agent-one', cliHasLaunched: false },
    },
  })
  assert.equal(terminalFromWrongWindow.ok, false)
  assert.equal(terminalFromWrongWindow.reason, 'workspace_not_in_source_window')
  assert.equal(service.getSnapshot().sequence, 13)

  const transfer = service.dispatch({
    sourceWindowId: 'primary',
    command: {
      type: 'workspace.move_to_window',
      payload: {
        workspaceId: 'ws-one',
        fromWindowId: 'primary',
        toWindowId: 'detached-a',
        makeActive: true,
      },
    },
  })
  assert.equal(transfer.ok, true, 'source window can transfer a workspace it owns to another window')
  assert.equal(transfer.event.sequence, 14)

  console.log('workspace-sync-service.test.ts: ok')
}

main()
