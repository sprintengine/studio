import assert from 'node:assert/strict'

import { createWorkspaceSyncService } from './workspace-sync-service'
import { createWorkspaceRegistryService } from './workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from './workspace-registry-store'
import { emptyWorkspaceRegistryFile, toWorkspaceRegistryRecord } from '../shared/workspace-registry'
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
      desiredMode: 'manual',
      runtimeState: 'idle',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 0,
      deliveredAgentNotificationEventKeys: [],
    },
    createdAt: 1,
  }
}

function snapshot(): WorkspaceSyncSnapshot {
  return {
    // The bus sequence restarts at 0 each boot (the replay log is in-memory), so
    // a seeded registry starts the run at 0 and a reconnecting window takes a
    // full snapshot rather than replaying across the restart boundary.
    sequence: 0,
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

async function main(): Promise<void> {
  // The bus reads and writes through the registry now, so a seeded test
  // service is a seeded registry. `initialSnapshot` is gone with the
  // non-authoritative mirror it used to seed.
  const seeded = snapshot()
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore({
      ...emptyWorkspaceRegistryFile(1),
      revision: 1,
      workspaces: seeded.state.workspaces.map((entry) => toWorkspaceRegistryRecord(entry, 1)),
      workspaceWindows: seeded.state.workspaceWindows,
      primaryWorkspaceWindowId: seeded.state.primaryWorkspaceWindowId,
      activeWorkspaceId: seeded.state.activeWorkspaceId,
    }),
    now: () => 1234,
  })
  const service = createWorkspaceSyncService({ registry, maxReplayEvents: 2, now: () => 1234 })

  function assertRejectedWithoutMutation(
    command: unknown,
    reason: string,
    sourceWindowId = 'primary',
    expectedSequence = 0
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
      type: 'workspace_window.update_placement',
      payload: {
        windowId: 'unknown-window',
        bounds: { x: 1, y: 2, width: 900, height: 700 },
        isMaximized: true,
        displayId: 9,
      },
    },
    'unknown_window',
    'unknown-window',
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
  assertRejectedWithoutMutation(
    {
      type: 'workspace.created',
      payload: {
        workspace: workspace('unknown-window-created'),
        windowId: 'unknown-window',
        insert: { kind: 'folder_head', folderPath: null },
      },
    },
    'unknown_window',
    'unknown-window',
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
  assert.equal(service.getSnapshot().sequence, 0, 'invalid commands do not advance the service sequence')
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
  assert.equal(active.event.sequence, 1)
  assert.equal(active.event.id, 'workspace-sync-1')
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
  assert.equal(placement.event.sequence, 2)

  const session = service.dispatch({
    sourceWindowId: 'primary',
    command: {
      type: 'agent_terminal.assign_session',
      payload: { workspaceId: 'ws-one', agentId: 'agent-one', sessionId: 'session-one', cli: 'codex' },
    },
  })
  assert.equal(session.ok, true)
  assert.equal(session.event.sequence, 3)

  assert.deepEqual(
    service.getEventsAfter(0).map((event) => event.sequence),
    [2, 3],
    'replay is bounded to the retained event window',
  )
  assert.deepEqual(
    service.getEventsAfter(2).map((event) => event.sequence),
    [3],
    'replay returns deterministic events after the requested sequence',
  )

  const terminalFromWrongWindow = service.dispatch({
    sourceWindowId: 'detached-a',
    command: {
      type: 'agent_terminal.update_launch_state',
      payload: { workspaceId: 'ws-one', agentId: 'agent-one', cliSessionId: null, cliHasLaunched: false },
    },
  })
  assert.equal(terminalFromWrongWindow.ok, false)
  assert.equal(terminalFromWrongWindow.reason, 'workspace_not_in_source_window')
  assert.equal(service.getSnapshot().sequence, 3)

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
  assert.equal(transfer.event.sequence, 4)

  // AC2: the primary window cannot be closed, even by its own renderer.
  assertRejectedWithoutMutation(
    {
      type: 'workspace_window.close',
      payload: { windowId: 'primary', fallbackWindowId: 'detached-a' },
    },
    'cannot_close_primary_window',
    'primary',
    4,
  )

  // AC5: a successful detached-window close records the workspace ids the
  // fallback window inherits in the event payload. After the transfer above,
  // detached-a owns ws-two (seeded) plus ws-one (moved in), in that order.
  const close = service.dispatch({
    sourceWindowId: 'detached-a',
    command: {
      type: 'workspace_window.close',
      payload: { windowId: 'detached-a', fallbackWindowId: 'primary' },
    },
  })
  assert.equal(close.ok, true, 'a detached window can close itself with a known fallback')
  assert.equal(close.event.sequence, 5)
  assert.equal(close.event.type, 'workspace_window.closed')
  assert.ok('movedWorkspaceIds' in close.event.payload, 'closed event payload records the moved workspace ids')
  assert.deepEqual(
    (close.event.payload as { movedWorkspaceIds: string[] }).movedWorkspaceIds,
    ['ws-two', 'ws-one'],
    'closed event records every closing-window workspace routed to the fallback',
  )
  assert.equal(
    service.getSnapshot().state.workspaceWindows.find((windowState) => windowState.id === 'detached-a'),
    undefined,
    'the closed window is dropped from the service snapshot',
  )

  console.log('workspace-sync-service.test.ts: ok')
}

void main()
