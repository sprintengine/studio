import {
  applyWorkspaceSyncEvent,
  type WorkspaceSyncCommand,
  type WorkspaceSyncCommandResult,
  type WorkspaceSyncEvent,
  type WorkspaceSyncEventType,
  type WorkspaceSyncSnapshot,
  type WorkspaceSyncState,
} from '../shared/workspace-sync'
import type { Workspace } from '../renderer/src/types/workspace'

const DEFAULT_PRIMARY_WINDOW_ID = 'primary'
const MAX_REPLAY_EVENTS = 500

type DispatchInput = {
  command: unknown
  sourceWindowId: string
}

type WorkspaceSyncServiceOptions = {
  initialSnapshot?: WorkspaceSyncSnapshot
  maxReplayEvents?: number
  now?: () => number
}

export type WorkspaceSyncService = ReturnType<typeof createWorkspaceSyncService>

export function createWorkspaceSyncService(options: WorkspaceSyncServiceOptions = {}) {
  const maxReplayEvents = Math.max(1, Math.floor(options.maxReplayEvents ?? MAX_REPLAY_EVENTS))
  const now = options.now ?? Date.now
  const initialSequence = options.initialSnapshot?.sequence ?? 0
  let state: WorkspaceSyncState = options.initialSnapshot
    ? snapshotToState(options.initialSnapshot)
    : createEmptyState(initialSequence)
  let nextSequence = initialSequence + 1
  const events: WorkspaceSyncEvent[] = []

  function getSnapshot(): WorkspaceSyncSnapshot {
    return stateToSnapshot(state)
  }

  function getEventsAfter(sequence: unknown): WorkspaceSyncEvent[] {
    if (!Number.isInteger(sequence) || typeof sequence !== 'number' || sequence < 0) return []
    return events.filter((event) => event.sequence > sequence).slice(-maxReplayEvents).map(clone)
  }

  function dispatch(input: DispatchInput): WorkspaceSyncCommandResult {
    const sourceWindowId = normalizeId(input.sourceWindowId)
    if (!sourceWindowId) {
      return failure('invalid_source_window', 'Workspace sync dispatch requires a source window id.')
    }

    const validation = validateCommand(input.command, state, sourceWindowId)
    if (!validation.ok) {
      return failure(validation.reason, validation.message)
    }

    const event: WorkspaceSyncEvent = {
      id: `workspace-sync-${nextSequence}`,
      type: eventTypeForCommand(validation.command),
      sourceWindowId,
      sequence: nextSequence,
      createdAt: now(),
      payload: clone(validation.command.payload),
    } as WorkspaceSyncEvent

    const applied = applyWorkspaceSyncEvent(state, event)
    if (applied.status !== 'applied') {
      return failure('event_apply_failed', 'Workspace sync command could not be applied to the service snapshot.')
    }

    nextSequence += 1
    state = applied.state
    events.push(event)
    if (events.length > maxReplayEvents) events.splice(0, events.length - maxReplayEvents)
    return { ok: true, event: clone(event) }
  }

  return {
    dispatch,
    getEventsAfter,
    getSnapshot,
  }
}

function failure(reason: string, message: string): WorkspaceSyncCommandResult {
  return { ok: false, reason, message }
}

function createEmptyState(sequence: number): WorkspaceSyncState {
  return {
    activeWorkspaceId: null,
    lastAppliedWorkspaceSyncSequence: sequence,
    primaryWorkspaceWindowId: DEFAULT_PRIMARY_WINDOW_ID,
    workspaces: [],
    workspaceWindows: [
      {
        id: DEFAULT_PRIMARY_WINDOW_ID,
        kind: 'primary',
        workspaceIds: [],
        activeWorkspaceId: null,
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: 0,
        lastFocusedAt: 0,
      },
    ],
  }
}

function snapshotToState(snapshot: WorkspaceSyncSnapshot): WorkspaceSyncState {
  return {
    ...clone(snapshot.state),
    lastAppliedWorkspaceSyncSequence: snapshot.sequence,
  }
}

function stateToSnapshot(state: WorkspaceSyncState): WorkspaceSyncSnapshot {
  const { lastAppliedWorkspaceSyncSequence: sequence, ...snapshotState } = state
  return {
    sequence,
    state: clone(snapshotState),
  }
}

type ValidationResult =
  | { ok: true; command: WorkspaceSyncCommand }
  | { ok: false; reason: string; message: string }

function validateCommand(input: unknown, state: WorkspaceSyncState, sourceWindowId: string): ValidationResult {
  if (!isRecord(input) || typeof input.type !== 'string' || !isRecord(input.payload)) {
    return reject('invalid_command', 'Workspace sync command must include a type and payload.')
  }

  switch (input.type) {
    case 'workspace_window.set_active':
      return validateSetActive(input.payload, state, sourceWindowId)
    case 'workspace.move_to_window':
      return validateMoveToWindow(input.payload, state, sourceWindowId)
    case 'workspace_window.update_placement':
      return validatePlacement(input.payload, sourceWindowId)
    case 'workspace_window.close':
      return validateWindowClose(input.payload, state, sourceWindowId)
    case 'workspace.created':
      return validateWorkspaceCreated(input.payload, state, sourceWindowId)
    case 'agent_terminal.assign_session':
      return validateAssignSession(input.payload, state, sourceWindowId)
    case 'agent_terminal.update_launch_state':
      return validateLaunchState(input.payload, state, sourceWindowId)
    default:
      return reject('unknown_command_type', `Workspace sync command type "${input.type}" is not supported.`)
  }
}

function validateSetActive(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string
): ValidationResult {
  const windowId = normalizeId(payload.windowId)
  if (!windowId) return reject('invalid_window_id', 'Active workspace commands require a window id.')
  if (windowId !== sourceWindowId) {
    return reject('window_authority_mismatch', `Window "${sourceWindowId}" cannot change active workspace for window "${windowId}".`)
  }
  const windowState = state.workspaceWindows.find((candidate) => candidate.id === windowId)
  if (!windowState) return reject('unknown_window', `Window "${windowId}" is not known to workspace sync.`)
  const workspaceId = payload.workspaceId === null ? null : normalizeId(payload.workspaceId)
  if (payload.workspaceId !== null && !workspaceId) {
    return reject('invalid_workspace_id', 'Active workspace commands require a workspace id or null.')
  }
  if (workspaceId && !windowState.workspaceIds.includes(workspaceId)) {
    return reject('workspace_not_in_window', `Workspace "${workspaceId}" is not assigned to window "${windowId}".`)
  }
  return { ok: true, command: { type: 'workspace_window.set_active', payload: { windowId, workspaceId } } }
}

function validateMoveToWindow(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string
): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  const toWindowId = normalizeId(payload.toWindowId)
  const fromWindowId = payload.fromWindowId === null ? null : normalizeId(payload.fromWindowId)
  if (!workspaceId || !toWindowId || (payload.fromWindowId !== null && !fromWindowId)) {
    return reject('invalid_move_payload', 'Move commands require workspace, source, and target window ids.')
  }
  if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return reject('unknown_workspace', `Workspace "${workspaceId}" is not known to workspace sync.`)
  }
  const sourceWindow = state.workspaceWindows.find((windowState) => windowState.id === sourceWindowId)
  if (!sourceWindow) return reject('unknown_source_window', `Source window "${sourceWindowId}" is not known to workspace sync.`)
  if (fromWindowId && fromWindowId !== sourceWindowId) {
    return reject('window_authority_mismatch', `Window "${sourceWindowId}" cannot move workspace from window "${fromWindowId}".`)
  }
  if (!sourceWindow.workspaceIds.includes(workspaceId)) {
    return reject('workspace_not_in_source_window', `Workspace "${workspaceId}" is not assigned to source window "${sourceWindowId}".`)
  }
  if (fromWindowId) {
    const source = state.workspaceWindows.find((windowState) => windowState.id === fromWindowId)
    if (!source) return reject('unknown_source_window', `Source window "${fromWindowId}" is not known to workspace sync.`)
    if (!source.workspaceIds.includes(workspaceId)) {
      return reject('workspace_not_in_source_window', `Workspace "${workspaceId}" is not assigned to source window "${fromWindowId}".`)
    }
  }
  return {
    ok: true,
    command: {
      type: 'workspace.move_to_window',
      payload: { workspaceId, fromWindowId, toWindowId, makeActive: payload.makeActive === true },
    },
  }
}

function validatePlacement(payload: Record<string, unknown>, sourceWindowId: string): ValidationResult {
  const windowId = normalizeId(payload.windowId)
  if (!windowId) return reject('invalid_window_id', 'Placement commands require a window id.')
  if (windowId !== sourceWindowId) {
    return reject('window_authority_mismatch', `Window "${sourceWindowId}" cannot update placement for window "${windowId}".`)
  }
  const bounds = payload.bounds
  if (bounds !== null && !isBounds(bounds)) {
    return reject('invalid_bounds', 'Placement commands require finite bounds or null.')
  }
  if (payload.displayId !== null && payload.displayId !== undefined && !isFiniteNumber(payload.displayId)) {
    return reject('invalid_display_id', 'Placement display id must be a finite number or null.')
  }
  return {
    ok: true,
    command: {
      type: 'workspace_window.update_placement',
      payload: {
        windowId,
        bounds: bounds ? { ...bounds } : null,
        isMaximized: payload.isMaximized === true,
        displayId: isFiniteNumber(payload.displayId) ? payload.displayId : null,
      },
    },
  }
}

function validateWindowClose(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string
): ValidationResult {
  const windowId = normalizeId(payload.windowId)
  const fallbackWindowId = normalizeId(payload.fallbackWindowId)
  if (!windowId || !fallbackWindowId) {
    return reject('invalid_close_payload', 'Close commands require a window id and fallback window id.')
  }
  if (windowId !== sourceWindowId) {
    return reject('window_authority_mismatch', `Window "${sourceWindowId}" cannot close window "${windowId}".`)
  }
  if (windowId === state.primaryWorkspaceWindowId) {
    return reject('cannot_close_primary_window', 'Workspace sync cannot close the primary window.')
  }
  if (!state.workspaceWindows.some((candidate) => candidate.id === windowId)) {
    return reject('unknown_window', `Window "${windowId}" is not known to workspace sync.`)
  }
  if (!state.workspaceWindows.some((candidate) => candidate.id === fallbackWindowId)) {
    return reject('unknown_fallback_window', `Fallback window "${fallbackWindowId}" is not known to workspace sync.`)
  }
  return { ok: true, command: { type: 'workspace_window.close', payload: { windowId, fallbackWindowId } } }
}

function validateWorkspaceCreated(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string
): ValidationResult {
  if (!isRecord(payload.workspace)) {
    return reject('invalid_workspace', 'Workspace creation commands require a workspace object.')
  }
  const workspaceId = normalizeId(payload.workspace.id)
  const windowId = normalizeId(payload.windowId)
  if (!workspaceId || !windowId) {
    return reject('invalid_workspace_created_payload', 'Workspace creation commands require workspace and window ids.')
  }
  if (windowId !== sourceWindowId) {
    return reject('window_authority_mismatch', `Window "${sourceWindowId}" cannot create a workspace in window "${windowId}".`)
  }
  if (state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return reject('workspace_already_exists', `Workspace "${workspaceId}" already exists.`)
  }
  if (!isRecord(payload.workspace.agents)) {
    return reject('invalid_workspace', 'Workspace creation commands require a renderer-compatible workspace payload.')
  }
  if (!isRecord(payload.insert) || payload.insert.kind !== 'folder_head') {
    return reject('invalid_insert', 'Workspace creation commands require a folder_head insert descriptor.')
  }
  if (payload.insert.folderPath !== null && payload.insert.folderPath !== undefined && typeof payload.insert.folderPath !== 'string') {
    return reject('invalid_insert', 'Workspace creation folder path must be a string or null.')
  }
  const folderPath = payload.insert.folderPath === null ? null : normalizeOptionalString(payload.insert.folderPath)
  return {
    ok: true,
    command: {
      type: 'workspace.created',
      payload: {
        workspace: clone(payload.workspace) as Workspace,
        windowId,
        insert: { kind: 'folder_head', folderPath },
      },
    },
  }
}

function validateAssignSession(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string
): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  const agentId = normalizeId(payload.agentId)
  const sessionId = normalizeId(payload.sessionId)
  const cli = normalizeId(payload.cli)
  if (!workspaceId || !agentId || !sessionId || !cli) {
    return reject('invalid_terminal_session_payload', 'Terminal session commands require workspace, agent, session, and cli ids.')
  }
  const ownership = validateSourceWindowOwnsWorkspace(state, sourceWindowId, workspaceId)
  if (!ownership.ok) return ownership
  return {
    ok: true,
    command: { type: 'agent_terminal.assign_session', payload: { workspaceId, agentId, sessionId, cli } },
  }
}

function validateLaunchState(
  payload: Record<string, unknown>,
  state: WorkspaceSyncState,
  sourceWindowId: string
): ValidationResult {
  const workspaceId = normalizeId(payload.workspaceId)
  const agentId = normalizeId(payload.agentId)
  if (!workspaceId || !agentId) {
    return reject('invalid_terminal_launch_payload', 'Terminal launch state commands require workspace and agent ids.')
  }
  const ownership = validateSourceWindowOwnsWorkspace(state, sourceWindowId, workspaceId)
  if (!ownership.ok) return ownership
  const commandPayload: Extract<WorkspaceSyncCommand, { type: 'agent_terminal.update_launch_state' }>['payload'] = {
    workspaceId,
    agentId,
  }
  for (const key of ['cliStartRequested', 'cliHasLaunched', 'cliOnboardingPromptSent', 'cliResumeAvailable'] as const) {
    if (payload[key] !== undefined) {
      if (typeof payload[key] !== 'boolean') {
        return reject('invalid_terminal_launch_payload', `Terminal launch state field "${key}" must be boolean when provided.`)
      }
      commandPayload[key] = payload[key]
    }
  }
  return { ok: true, command: { type: 'agent_terminal.update_launch_state', payload: commandPayload } }
}

function validateSourceWindowOwnsWorkspace(
  state: WorkspaceSyncState,
  sourceWindowId: string,
  workspaceId: string
): ValidationResult {
  if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return reject('unknown_workspace', `Workspace "${workspaceId}" is not known to workspace sync.`)
  }
  const sourceWindow = state.workspaceWindows.find((windowState) => windowState.id === sourceWindowId)
  if (!sourceWindow) return reject('unknown_source_window', `Source window "${sourceWindowId}" is not known to workspace sync.`)
  if (!sourceWindow.workspaceIds.includes(workspaceId)) {
    return reject('workspace_not_in_source_window', `Workspace "${workspaceId}" is not assigned to source window "${sourceWindowId}".`)
  }
  return { ok: true, command: { type: 'workspace_window.set_active', payload: { windowId: sourceWindowId, workspaceId } } }
}

function eventTypeForCommand(command: WorkspaceSyncCommand): WorkspaceSyncEventType {
  switch (command.type) {
    case 'workspace_window.set_active':
      return 'workspace_window.active_changed'
    case 'workspace.move_to_window':
      return 'workspace.moved_to_window'
    case 'workspace_window.update_placement':
      return 'workspace_window.placement_updated'
    case 'workspace_window.close':
      return 'workspace_window.closed'
    case 'workspace.created':
      return 'workspace.created'
    case 'agent_terminal.assign_session':
      return 'agent_terminal.session_assigned'
    case 'agent_terminal.update_launch_state':
      return 'agent_terminal.launch_state_updated'
  }
}

function reject(reason: string, message: string): ValidationResult {
  return { ok: false, reason, message }
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBounds(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && isFiniteNumber(value.height)
}

function clone<T>(value: T): T {
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}
