import type {
  AgentCli,
  AgentId,
  AgentState,
  Workspace,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWindowState,
} from '../renderer/src/types/workspace'

export type WindowPlacement = Pick<WorkspaceWindowState, 'bounds' | 'isMaximized' | 'displayId'>

export type WorkspaceSyncCommand =
  | {
      type: 'workspace_window.set_active'
      payload: { windowId: WorkspaceWindowId; workspaceId: WorkspaceId | null }
    }
  | {
      type: 'workspace.move_to_window'
      payload: {
        workspaceId: WorkspaceId
        fromWindowId: WorkspaceWindowId | null
        toWindowId: WorkspaceWindowId
        makeActive: boolean
      }
    }
  | {
      type: 'workspace_window.update_placement'
      payload: WindowPlacement & { windowId: WorkspaceWindowId }
    }
  | {
      type: 'workspace_window.close'
      payload: { windowId: WorkspaceWindowId; fallbackWindowId: WorkspaceWindowId }
    }
  | {
      type: 'workspace.created'
      payload: {
        workspace: Workspace
        windowId: WorkspaceWindowId
        insert: { kind: 'folder_head'; folderPath: string | null }
      }
    }
  | {
      type: 'agent_terminal.assign_session'
      payload: {
        workspaceId: WorkspaceId
        agentId: AgentId
        sessionId: string
        cli: AgentCli
      }
    }
  | {
      type: 'agent_terminal.update_launch_state'
      payload: {
        workspaceId: WorkspaceId
        agentId: AgentId
        cliSessionId?: string | null
        cliStartRequested?: boolean
        cliHasLaunched?: boolean
        cliOnboardingPromptSent?: boolean
        cliResumeAvailable?: boolean
      }
    }

export type WorkspaceSyncEventType =
  | 'workspace_window.active_changed'
  | 'workspace.moved_to_window'
  | 'workspace_window.placement_updated'
  | 'workspace_window.closed'
  | 'workspace.created'
  | 'agent_terminal.session_assigned'
  | 'agent_terminal.launch_state_updated'

// The closed event extends the close command payload with the ids the service
// actually routed to the fallback window. The source renderer already knows the
// closing window's membership, but receiving renderers do not necessarily have
// the closing window's full record, so the moved ids travel with the event.
export type WorkspaceWindowClosedEventPayload = Extract<
  WorkspaceSyncCommand,
  { type: 'workspace_window.close' }
>['payload'] & { movedWorkspaceIds: WorkspaceId[] }

// The broadcast session_assigned event extends the command with resume
// capabilities the main process resolves from the plugin registry (the
// authoritative manifest source). The applier stores these instead of
// re-deriving resume behavior from `cli`, so a new CLI resumes purely by
// declaring its manifest capabilities. See agent-cli-resume.ts.
export type AgentTerminalSessionAssignedEventPayload = Extract<
  WorkspaceSyncCommand,
  { type: 'agent_terminal.assign_session' }
>['payload'] & { cliResumeAvailable: boolean; cliUsesStableSessionId: boolean }

export type WorkspaceSyncEvent =
  | WorkspaceSyncBaseEvent<'workspace_window.active_changed', Extract<WorkspaceSyncCommand, { type: 'workspace_window.set_active' }>['payload']>
  | WorkspaceSyncBaseEvent<'workspace.moved_to_window', Extract<WorkspaceSyncCommand, { type: 'workspace.move_to_window' }>['payload']>
  | WorkspaceSyncBaseEvent<'workspace_window.placement_updated', Extract<WorkspaceSyncCommand, { type: 'workspace_window.update_placement' }>['payload']>
  | WorkspaceSyncBaseEvent<'workspace_window.closed', WorkspaceWindowClosedEventPayload>
  | WorkspaceSyncBaseEvent<'workspace.created', Extract<WorkspaceSyncCommand, { type: 'workspace.created' }>['payload']>
  | WorkspaceSyncBaseEvent<'agent_terminal.session_assigned', AgentTerminalSessionAssignedEventPayload>
  | WorkspaceSyncBaseEvent<'agent_terminal.launch_state_updated', Extract<WorkspaceSyncCommand, { type: 'agent_terminal.update_launch_state' }>['payload']>

export type WorkspaceSyncBaseEvent<
  Type extends WorkspaceSyncEventType,
  Payload,
> = {
  id: string
  type: Type
  sourceWindowId: WorkspaceWindowId
  sequence: number
  createdAt: number
  payload: Payload
}

export type WorkspaceSyncState = {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceWindows: WorkspaceWindowState[]
  primaryWorkspaceWindowId: WorkspaceWindowId
  lastAppliedWorkspaceSyncSequence: number
}

export type WorkspaceSyncSnapshot = {
  sequence: number
  state: Omit<WorkspaceSyncState, 'lastAppliedWorkspaceSyncSequence'>
}

export type WorkspaceSyncRoutingSnapshot = {
  sequence: number
  workspaceWindows: WorkspaceWindowState[]
  primaryWorkspaceWindowId: WorkspaceWindowId
  // Display names by workspace id, captured at persist time. The routing
  // snapshot otherwise only knows window->workspaceId routing, so a workspace
  // restored from it but never re-hydrated by the renderer this session would
  // surface its raw id (e.g. in the diagnostics Workspaces panel). Optional and
  // best-effort: a missing entry falls back to the id.
  workspaceNames?: Record<string, string>
  // Folder paths by workspace id, captured at persist time. Without this, a
  // workspace restored from the routing snapshot but not yet re-hydrated by the
  // renderer this session comes back folder-less in main's snapshot, so
  // folder-gated features (e.g. the Automations trust check,
  // projectFoldersFromWorkspaceSyncSnapshot) can't match it. Optional and
  // best-effort, mirroring workspaceNames; a missing entry restores folder-less.
  workspaceFolderPaths?: Record<string, string>
  // Non-standard workspace modes by workspace id, captured at persist time.
  // Without this, every workspace restored from the routing snapshot rehydrates
  // as a 'standard' placeholder, so mode-gated resolution (the automation
  // executor's per-project 'automations-host' lookup) can never match a restored
  // workspace and mints a duplicate host after each app restart. Optional and
  // best-effort, mirroring workspaceNames; a missing entry restores 'standard'.
  workspaceModes?: Record<string, Workspace['mode']>
}

export type WorkspaceSyncCommandResult =
  | { ok: true; event: WorkspaceSyncEvent; snapshot?: WorkspaceSyncSnapshot }
  | { ok: false; reason: string; message: string; snapshot?: WorkspaceSyncSnapshot }

export type WorkspaceSyncApplyResult =
  | { status: 'applied'; state: WorkspaceSyncState; event: WorkspaceSyncEvent }
  | { status: 'ignored'; state: WorkspaceSyncState; event: WorkspaceSyncEvent; reason: 'duplicate_or_stale' }
  | {
      status: 'sequence_gap'
      state: WorkspaceSyncState
      event: WorkspaceSyncEvent
      expectedSequence: number
      receivedSequence: number
    }

export function applyWorkspaceSyncEvent(
  state: WorkspaceSyncState,
  event: WorkspaceSyncEvent
): WorkspaceSyncApplyResult {
  const expectedSequence = state.lastAppliedWorkspaceSyncSequence + 1
  if (event.sequence <= state.lastAppliedWorkspaceSyncSequence) {
    return { status: 'ignored', state, event, reason: 'duplicate_or_stale' }
  }
  if (event.sequence !== expectedSequence) {
    return {
      status: 'sequence_gap',
      state,
      event,
      expectedSequence,
      receivedSequence: event.sequence,
    }
  }

  const next = cloneSyncState(state)
  applyWorkspaceSyncEventInPlace(next, event)
  next.lastAppliedWorkspaceSyncSequence = event.sequence
  return { status: 'applied', state: next, event }
}

export function applyWorkspaceSyncSnapshot(
  state: WorkspaceSyncState,
  snapshot: WorkspaceSyncSnapshot
): WorkspaceSyncState {
  if (snapshot.sequence <= state.lastAppliedWorkspaceSyncSequence) return state
  return {
    ...cloneSyncState({
      ...snapshot.state,
      lastAppliedWorkspaceSyncSequence: snapshot.sequence,
    }),
  }
}

function applyWorkspaceSyncEventInPlace(state: WorkspaceSyncState, event: WorkspaceSyncEvent): void {
  switch (event.type) {
    case 'workspace_window.active_changed':
      setActiveWorkspaceForWindow(state, event.payload.windowId, event.payload.workspaceId, event.createdAt)
      break
    case 'workspace.moved_to_window':
      moveWorkspaceToWindow(state, event.payload, event.createdAt)
      break
    case 'workspace_window.placement_updated':
      updateWorkspaceWindowPlacement(state, event.payload, event.createdAt)
      break
    case 'workspace_window.closed':
      closeWorkspaceWindow(state, event.payload.windowId, event.payload.fallbackWindowId, event.createdAt)
      break
    case 'workspace.created':
      addCreatedWorkspace(
        state,
        event.payload.workspace,
        event.payload.windowId,
        event.payload.insert.folderPath,
        event.createdAt
      )
      break
    case 'agent_terminal.session_assigned':
      assignAgentTerminalSession(state, event.payload)
      break
    case 'agent_terminal.launch_state_updated':
      updateAgentTerminalLaunchState(state, event.payload)
      break
  }
}

function cloneSyncState(state: WorkspaceSyncState): WorkspaceSyncState {
  return {
    ...state,
    workspaces: state.workspaces.map(cloneWorkspace),
    workspaceWindows: state.workspaceWindows.map((windowState) => ({
      ...windowState,
      workspaceIds: [...windowState.workspaceIds],
      bounds: windowState.bounds ? { ...windowState.bounds } : null,
    })),
  }
}

function cloneWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    agents: Object.fromEntries(
      Object.entries(workspace.agents).map(([agentId, agent]) => [agentId, { ...agent }])
    ),
  }
}

function ensureWorkspaceWindow(
  state: WorkspaceSyncState,
  windowId: WorkspaceWindowId,
  kind: WorkspaceWindowState['kind'] = windowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
  timestamp = 0
): WorkspaceWindowState {
  const existing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
  if (existing) return existing

  const windowState: WorkspaceWindowState = {
    id: windowId,
    kind,
    workspaceIds: [],
    activeWorkspaceId: null,
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: timestamp,
    lastFocusedAt: timestamp,
  }
  state.workspaceWindows.push(windowState)
  return windowState
}

function workspaceFolderKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() : null
}

function normalizeWorkspaceAssignments(state: WorkspaceSyncState, timestamp: number): void {
  const validWorkspaceIds = new Set(state.workspaces.map((workspace) => workspace.id))
  const assignedWorkspaceIds = new Set<WorkspaceId>()
  const primaryWindow = ensureWorkspaceWindow(state, state.primaryWorkspaceWindowId, 'primary', timestamp)
  primaryWindow.kind = 'primary'

  for (const windowState of state.workspaceWindows) {
    const nextWorkspaceIds: WorkspaceId[] = []
    for (const workspaceId of windowState.workspaceIds) {
      if (!validWorkspaceIds.has(workspaceId) || assignedWorkspaceIds.has(workspaceId)) continue
      nextWorkspaceIds.push(workspaceId)
      assignedWorkspaceIds.add(workspaceId)
    }
    windowState.workspaceIds = nextWorkspaceIds
    if (windowState.activeWorkspaceId && !nextWorkspaceIds.includes(windowState.activeWorkspaceId)) {
      windowState.activeWorkspaceId = nextWorkspaceIds[0] ?? null
    }
  }

  for (const workspace of state.workspaces) {
    if (assignedWorkspaceIds.has(workspace.id)) continue
    primaryWindow.workspaceIds.push(workspace.id)
    assignedWorkspaceIds.add(workspace.id)
  }
  if (primaryWindow.activeWorkspaceId && !primaryWindow.workspaceIds.includes(primaryWindow.activeWorkspaceId)) {
    primaryWindow.activeWorkspaceId = primaryWindow.workspaceIds[0] ?? null
  }
  state.workspaceWindows = state.workspaceWindows.filter((windowState) =>
    windowState.kind === 'primary' || windowState.workspaceIds.length > 0
  )
}

function setActiveWorkspaceForWindow(
  state: WorkspaceSyncState,
  windowId: WorkspaceWindowId,
  workspaceId: WorkspaceId | null,
  timestamp: number
): void {
  const windowState = state.workspaceWindows.find((candidate) => candidate.id === windowId)
  if (!windowState) return
  if (workspaceId !== null && !windowState.workspaceIds.includes(workspaceId)) return
  windowState.activeWorkspaceId = workspaceId
  windowState.lastFocusedAt = timestamp
  if (workspaceId) state.activeWorkspaceId = workspaceId
}

function moveWorkspaceToWindow(
  state: WorkspaceSyncState,
  payload: Extract<WorkspaceSyncCommand, { type: 'workspace.move_to_window' }>['payload'],
  timestamp: number
): void {
  if (!state.workspaces.some((workspace) => workspace.id === payload.workspaceId)) return
  const target = ensureWorkspaceWindow(
    state,
    payload.toWindowId,
    payload.toWindowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
    timestamp
  )
  for (const windowState of state.workspaceWindows) {
    if (windowState.id === payload.toWindowId) continue
    windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== payload.workspaceId)
    if (windowState.activeWorkspaceId === payload.workspaceId) {
      windowState.activeWorkspaceId = windowState.workspaceIds[0] ?? null
    }
  }
  target.workspaceIds = [
    ...target.workspaceIds.filter((workspaceId) => workspaceId !== payload.workspaceId),
    payload.workspaceId,
  ]
  if (payload.makeActive) {
    target.activeWorkspaceId = payload.workspaceId
    target.lastFocusedAt = timestamp
    state.activeWorkspaceId = payload.workspaceId
  } else if (!target.activeWorkspaceId) {
    target.activeWorkspaceId = target.workspaceIds[0] ?? null
  }
  if (payload.fromWindowId && payload.fromWindowId !== payload.toWindowId) {
    const source = state.workspaceWindows.find((windowState) => windowState.id === payload.fromWindowId)
    if (source?.activeWorkspaceId === payload.workspaceId) {
      source.activeWorkspaceId = source.workspaceIds[0] ?? null
    }
  }
  normalizeWorkspaceAssignments(state, timestamp)
}

function updateWorkspaceWindowPlacement(
  state: WorkspaceSyncState,
  placement: Extract<WorkspaceSyncCommand, { type: 'workspace_window.update_placement' }>['payload'],
  timestamp: number
): void {
  const windowState = ensureWorkspaceWindow(state, placement.windowId, undefined, timestamp)
  windowState.bounds = placement.bounds ? { ...placement.bounds } : null
  windowState.isMaximized = placement.isMaximized === true
  windowState.displayId = typeof placement.displayId === 'number' ? placement.displayId : null
  windowState.lastFocusedAt = timestamp
}

function closeWorkspaceWindow(
  state: WorkspaceSyncState,
  windowId: WorkspaceWindowId,
  fallbackWindowId: WorkspaceWindowId,
  timestamp: number
): void {
  if (windowId === state.primaryWorkspaceWindowId) return
  const closing = state.workspaceWindows.find((windowState) => windowState.id === windowId)
  if (!closing) return
  const fallback = ensureWorkspaceWindow(
    state,
    fallbackWindowId,
    fallbackWindowId === state.primaryWorkspaceWindowId ? 'primary' : 'detached',
    timestamp
  )
  for (const workspaceId of closing.workspaceIds) {
    if (!fallback.workspaceIds.includes(workspaceId)) fallback.workspaceIds.push(workspaceId)
  }
  fallback.activeWorkspaceId = closing.activeWorkspaceId && fallback.workspaceIds.includes(closing.activeWorkspaceId)
    ? closing.activeWorkspaceId
    : fallback.workspaceIds[0] ?? null
  state.workspaceWindows = state.workspaceWindows.filter((windowState) => windowState.id !== windowId)
  if (fallback.activeWorkspaceId) state.activeWorkspaceId = fallback.activeWorkspaceId
  normalizeWorkspaceAssignments(state, timestamp)
}

function addCreatedWorkspace(
  state: WorkspaceSyncState,
  workspace: Workspace,
  windowId: WorkspaceWindowId,
  folderPath: string | null,
  timestamp: number
): void {
  state.workspaces = state.workspaces.filter((candidate) => candidate.id !== workspace.id)
  const insertFolderKey = workspaceFolderKey(folderPath)
  const blockStart = state.workspaces.findIndex(
    (candidate) => workspaceFolderKey(candidate.folderPath) === insertFolderKey
  )
  if (blockStart === -1) {
    state.workspaces.unshift(cloneWorkspace(workspace))
  } else {
    state.workspaces.splice(blockStart, 0, cloneWorkspace(workspace))
  }
  for (const windowState of state.workspaceWindows) {
    windowState.workspaceIds = windowState.workspaceIds.filter((workspaceId) => workspaceId !== workspace.id)
  }
  const target = ensureWorkspaceWindow(state, windowId, undefined, timestamp)
  target.workspaceIds = [workspace.id, ...target.workspaceIds]
  target.activeWorkspaceId = workspace.id
  target.lastFocusedAt = timestamp
  state.activeWorkspaceId = workspace.id
  normalizeWorkspaceAssignments(state, timestamp)
}

function assignAgentTerminalSession(
  state: WorkspaceSyncState,
  payload: AgentTerminalSessionAssignedEventPayload
): void {
  const agent = findOrCreateAgent(state, payload.workspaceId, payload.agentId)
  if (!agent) return
  agent.cliSessionId = payload.sessionId
  agent.cli = payload.cli
  agent.cliStartRequested = true
  agent.cliHasLaunched = true
  agent.cliResumeAvailable = payload.cliResumeAvailable
  agent.cliUsesStableSessionId = payload.cliUsesStableSessionId
}

function updateAgentTerminalLaunchState(
  state: WorkspaceSyncState,
  payload: Extract<WorkspaceSyncCommand, { type: 'agent_terminal.update_launch_state' }>['payload']
): void {
  const agent = findOrCreateAgent(state, payload.workspaceId, payload.agentId)
  if (!agent) return
  if (payload.cliSessionId !== undefined) agent.cliSessionId = payload.cliSessionId ?? undefined
  if (payload.cliStartRequested !== undefined) agent.cliStartRequested = payload.cliStartRequested
  if (payload.cliHasLaunched !== undefined) agent.cliHasLaunched = payload.cliHasLaunched
  if (payload.cliOnboardingPromptSent !== undefined) {
    agent.cliOnboardingPromptSent = payload.cliOnboardingPromptSent
  }
  if (payload.cliResumeAvailable !== undefined) agent.cliResumeAvailable = payload.cliResumeAvailable
}

function findOrCreateAgent(
  state: WorkspaceSyncState,
  workspaceId: WorkspaceId,
  agentId: AgentId
): AgentState | null {
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!workspace) return null
  if (!workspace.agents[agentId]) {
    workspace.agents[agentId] = {
      id: agentId,
      name: agentId,
      status: 'idle',
      execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
      messages: [],
      streamBuffer: '',
      // Sync-created agent skeletons exist for terminal launch/session events;
      // the conversation runtime is opted into explicitly elsewhere.
      runtimeKind: 'terminal',
    }
  }
  return workspace.agents[agentId]
}
