import assert from 'node:assert/strict'

import { createWorkspaceSyncService } from './workspace-sync-service'
import type { Workspace } from '../renderer/src/types/workspace'
import type { WorkspaceSyncCommand, WorkspaceSyncRoutingSnapshot, WorkspaceSyncSnapshot } from '../shared/workspace-sync'

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

async function main(): Promise<void> {
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
      payload: { workspaceId: 'ws-one', agentId: 'agent-one', cliSessionId: null, cliHasLaunched: false },
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

  // AC2: the primary window cannot be closed, even by its own renderer.
  assertRejectedWithoutMutation(
    {
      type: 'workspace_window.close',
      payload: { windowId: 'primary', fallbackWindowId: 'detached-a' },
    },
    'cannot_close_primary_window',
    'primary',
    14,
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
  assert.equal(close.event.sequence, 15)
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

  const routingSnapshot: WorkspaceSyncRoutingSnapshot = {
    sequence: 20,
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
        id: 'detached-b',
        kind: 'detached',
        workspaceIds: ['ws-two'],
        activeWorkspaceId: 'ws-two',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        isMaximized: false,
        displayId: 3,
        createdAt: 2,
        lastFocusedAt: 2,
      },
    ],
  }
  const persistedRoutingSnapshots: WorkspaceSyncRoutingSnapshot[] = []
  const hydratedService = createWorkspaceSyncService({
    initialRoutingSnapshot: routingSnapshot,
    persistDebounceMs: 60_000,
    persistRoutingSnapshot: (persisted) => {
      persistedRoutingSnapshots.push(persisted)
    },
    now: () => 2000,
  })
  assert.deepEqual(
    hydratedService.getSnapshot().state.workspaceWindows.map((windowState) => ({
      id: windowState.id,
      workspaceIds: windowState.workspaceIds,
      activeWorkspaceId: windowState.activeWorkspaceId,
    })),
    [
      { id: 'primary', workspaceIds: ['ws-one'], activeWorkspaceId: 'ws-one' },
      { id: 'detached-b', workspaceIds: ['ws-two'], activeWorkspaceId: 'ws-two' },
    ],
    'restart hydration seeds the service routing table from compact persisted fields',
  )
  const hydratedActive = hydratedService.dispatch({
    sourceWindowId: 'detached-b',
    command: {
      type: 'workspace_window.set_active',
      payload: { windowId: 'detached-b', workspaceId: 'ws-two' },
    },
  })
  assert.equal(hydratedActive.ok, true)
  assert.equal(hydratedService.getSnapshot().sequence, 21)
  assert.equal(persistedRoutingSnapshots.length, 0, 'routing snapshot writes are debounced until flushed')
  await hydratedService.flushRoutingSnapshot()
  assert.equal(persistedRoutingSnapshots.length, 1)
  const persistedRoutingSnapshot = persistedRoutingSnapshots[0]
  assert.ok(persistedRoutingSnapshot)
  assert.deepEqual(
    Object.keys(persistedRoutingSnapshot).sort(),
    ['primaryWorkspaceWindowId', 'sequence', 'workspaceWindows'],
    'persisted routing snapshot stays compact',
  )
  assert.equal(persistedRoutingSnapshot.sequence, 21)
  assert.deepEqual(
    persistedRoutingSnapshot.workspaceWindows.find((windowState) => windowState.id === 'detached-b')?.workspaceIds,
    ['ws-two'],
  )

  // Routing snapshot carries display names so a workspace restored but never
  // re-hydrated this session shows its real name instead of the raw id.
  const namedRoutingSnapshot: WorkspaceSyncRoutingSnapshot = {
    sequence: 30,
    primaryWorkspaceWindowId: 'primary',
    workspaceWindows: [
      {
        id: 'primary',
        kind: 'primary',
        workspaceIds: ['ws-keep'],
        activeWorkspaceId: 'ws-keep',
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: 1,
        lastFocusedAt: 1,
      },
    ],
    workspaceNames: { 'ws-keep': 'Keep Me' },
  }
  const namedPersisted: WorkspaceSyncRoutingSnapshot[] = []
  const namedService = createWorkspaceSyncService({
    initialRoutingSnapshot: namedRoutingSnapshot,
    persistDebounceMs: 60_000,
    persistRoutingSnapshot: (persisted) => {
      namedPersisted.push(persisted)
    },
    now: () => 3000,
  })
  assert.equal(
    namedService.getSnapshot().state.workspaces.find((ws) => ws.id === 'ws-keep')?.name,
    'Keep Me',
    'routing snapshot names hydrate onto the restored placeholder workspace',
  )

  const createNamed = namedService.dispatch({
    sourceWindowId: 'primary',
    command: {
      type: 'workspace.created',
      payload: {
        workspace: { ...workspace('ws-new'), name: 'Brand New' },
        windowId: 'primary',
        insert: { kind: 'folder_head', folderPath: null },
      },
    },
  })
  assert.equal(createNamed.ok, true)
  await namedService.flushRoutingSnapshot()
  const namedSnapshot = namedPersisted.at(-1)
  assert.ok(namedSnapshot)
  assert.deepEqual(
    namedSnapshot.workspaceNames,
    { 'ws-keep': 'Keep Me', 'ws-new': 'Brand New' },
    'persisted routing snapshot carries real display names by id',
  )

  // Routing snapshot carries folder paths so a workspace restored but never
  // re-hydrated this session still resolves its folder in main's snapshot. The
  // folder-gated Automations trust check (workspace_root_untrusted after restart)
  // depends on this — restored placeholders were previously folder-less.
  const folderRoutingSnapshot: WorkspaceSyncRoutingSnapshot = {
    sequence: 40,
    primaryWorkspaceWindowId: 'primary',
    workspaceWindows: [
      {
        id: 'primary',
        kind: 'primary',
        workspaceIds: ['ws-folder'],
        activeWorkspaceId: 'ws-folder',
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: 1,
        lastFocusedAt: 1,
      },
    ],
    workspaceFolderPaths: { 'ws-folder': '/Users/example/project' },
  }
  const folderPersisted: WorkspaceSyncRoutingSnapshot[] = []
  const folderService = createWorkspaceSyncService({
    initialRoutingSnapshot: folderRoutingSnapshot,
    persistDebounceMs: 60_000,
    persistRoutingSnapshot: (persisted) => {
      folderPersisted.push(persisted)
    },
    now: () => 4000,
  })
  assert.equal(
    folderService.getSnapshot().state.workspaces.find((ws) => ws.id === 'ws-folder')?.folderPath,
    '/Users/example/project',
    'routing snapshot folder paths hydrate onto the restored placeholder workspace',
  )

  const createFolder = folderService.dispatch({
    sourceWindowId: 'primary',
    command: {
      type: 'workspace.created',
      payload: {
        workspace: workspace('ws-new-folder', '/Users/example/other'),
        windowId: 'primary',
        insert: { kind: 'folder_head', folderPath: '/Users/example/other' },
      },
    },
  })
  assert.equal(createFolder.ok, true)
  await folderService.flushRoutingSnapshot()
  const folderSnapshot = folderPersisted.at(-1)
  assert.ok(folderSnapshot)
  assert.deepEqual(
    folderSnapshot.workspaceFolderPaths,
    { 'ws-folder': '/Users/example/project', 'ws-new-folder': '/Users/example/other' },
    'persisted routing snapshot carries folder paths by id',
  )

  // Workspace modes round-trip through the routing snapshot. Without this, every
  // restored workspace rehydrates as 'standard' and the automation executor's
  // per-project 'automations-host' folder lookup can never match after a restart
  // — the duplicate-host bug.
  const modeRoutingSnapshot: WorkspaceSyncRoutingSnapshot = {
    sequence: 50,
    primaryWorkspaceWindowId: 'primary',
    workspaceWindows: [
      {
        id: 'primary',
        kind: 'primary',
        workspaceIds: ['ws-host'],
        activeWorkspaceId: 'ws-host',
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: 1,
        lastFocusedAt: 1,
      },
    ],
    workspaceFolderPaths: { 'ws-host': '/Users/example/project' },
    workspaceModes: { 'ws-host': 'automations-host' },
  }
  const modePersisted: WorkspaceSyncRoutingSnapshot[] = []
  const modeService = createWorkspaceSyncService({
    initialRoutingSnapshot: modeRoutingSnapshot,
    persistDebounceMs: 60_000,
    persistRoutingSnapshot: (persisted) => {
      modePersisted.push(persisted)
    },
    now: () => 5000,
  })
  assert.equal(
    modeService.getSnapshot().state.workspaces.find((ws) => ws.id === 'ws-host')?.mode,
    'automations-host',
    'routing snapshot modes hydrate onto the restored placeholder workspace',
  )

  const createHost = modeService.dispatch({
    sourceWindowId: 'primary',
    command: {
      type: 'workspace.created',
      payload: {
        workspace: { ...workspace('ws-new-host', '/Users/example/other'), mode: 'automations-host' as const },
        windowId: 'primary',
        insert: { kind: 'folder_head', folderPath: '/Users/example/other' },
      },
    },
  })
  assert.equal(createHost.ok, true)
  const createStandard = modeService.dispatch({
    sourceWindowId: 'primary',
    command: {
      type: 'workspace.created',
      payload: {
        workspace: workspace('ws-plain', '/Users/example/plain'),
        windowId: 'primary',
        insert: { kind: 'folder_head', folderPath: '/Users/example/plain' },
      },
    },
  })
  assert.equal(createStandard.ok, true)
  await modeService.flushRoutingSnapshot()
  const modeSnapshot = modePersisted.at(-1)
  assert.ok(modeSnapshot)
  assert.deepEqual(
    modeSnapshot.workspaceModes,
    { 'ws-host': 'automations-host', 'ws-new-host': 'automations-host' },
    'persisted routing snapshot carries non-standard modes by id; standard stays implicit',
  )

  // A same-id workspace.created against a restart-restored routing placeholder
  // is accepted as a heal (the renderer's Automations-host reuse path re-offers
  // its real record): the applier replaces the mode-less placeholder, so the
  // automation executor's mode-gated host-by-folder lookup works on the next
  // run. Once the record is real, a duplicate create rejects as before.
  const healRoutingSnapshot: WorkspaceSyncRoutingSnapshot = {
    sequence: 60,
    primaryWorkspaceWindowId: 'primary',
    workspaceWindows: [
      {
        id: 'primary',
        kind: 'primary',
        workspaceIds: ['ws-legacy-host'],
        activeWorkspaceId: 'ws-legacy-host',
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: 1,
        lastFocusedAt: 1,
      },
    ],
    workspaceFolderPaths: { 'ws-legacy-host': '/Users/example/project' },
    // No workspaceModes entry: the host predates mode persistence, so it
    // restores as a 'standard' placeholder.
  }
  const healPersisted: WorkspaceSyncRoutingSnapshot[] = []
  const healService = createWorkspaceSyncService({
    initialRoutingSnapshot: healRoutingSnapshot,
    persistDebounceMs: 60_000,
    persistRoutingSnapshot: (persisted) => {
      healPersisted.push(persisted)
    },
    now: () => 6000,
  })
  assert.equal(
    healService.getSnapshot().state.workspaces.find((ws) => ws.id === 'ws-legacy-host')?.mode,
    'standard',
    'a mode-less routing snapshot restores the host as a standard placeholder',
  )

  const healCommand: WorkspaceSyncCommand = {
    type: 'workspace.created',
    payload: {
      workspace: {
        ...workspace('ws-legacy-host', '/Users/example/project'),
        mode: 'automations-host',
        templateId: 'automations',
      },
      windowId: 'primary',
      insert: { kind: 'folder_head', folderPath: '/Users/example/project' },
    },
  }
  const heal = healService.dispatch({ sourceWindowId: 'primary', command: healCommand })
  assert.equal(heal.ok, true, 'same-id create against a routing placeholder is accepted as a heal')
  assert.equal(
    healService.getSnapshot().state.workspaces.find((ws) => ws.id === 'ws-legacy-host')?.mode,
    'automations-host',
    'the heal replaces the placeholder with the renderer-offered record',
  )
  await healService.flushRoutingSnapshot()
  assert.deepEqual(
    healPersisted.at(-1)?.workspaceModes,
    { 'ws-legacy-host': 'automations-host' },
    'the healed mode persists into the routing snapshot for the next restart',
  )

  const duplicateAfterHeal = healService.dispatch({ sourceWindowId: 'primary', command: healCommand })
  assert.equal(duplicateAfterHeal.ok, false, 'a duplicate create against a real record still rejects')
  assert.equal(duplicateAfterHeal.ok === false ? duplicateAfterHeal.reason : '', 'workspace_already_exists')

  console.log('workspace-sync-service.test.ts: ok')
}

void main()
