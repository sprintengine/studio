import type { ElectronApi } from '../../../shared/electron-api'
import type {
  WindowPlacement,
  WorkspaceSyncCommand,
  WorkspaceSyncCommandResult,
  WorkspaceSyncEvent,
} from '../../../shared/workspace-sync'
import type { AgentCli, AgentId, Workspace, WorkspaceId, WorkspaceWindowId } from '../types/workspace'

// Defined locally (matching WorkspaceManager/workspacesSlice) so this adapter
// does not import a store slice, keeping the module dependency graph acyclic.
const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'

// Renderer-side adapter for the main-mediated workspace sync bus (see
// future-plans/2026-05-31-event-based-multi-window-sync.md). It keeps
// WorkspaceManager and the store free of IPC mechanics: it dispatches scoped
// commands (active selection, workspace move, window close, placement), applies
// the accepted/broadcast events to the local store, and tracks the last applied
// sequence so duplicate or older events are ignored.
//
// Storage-event sync (workspaceStore.syncWorkspaceRegistryAcrossWindows) stays
// in place as the functional rollback path during this phase. Until a later
// task seeds the main service with workspace/window membership, dispatches will
// be rejected; that rejection is a safe no-op here because the local store
// already applied the change optimistically.

// The narrow slice of window.api this client depends on, so tests can inject a
// fake transport without constructing the full ElectronApi surface.
export type WorkspaceSyncClientApi = Pick<
  ElectronApi,
  'workspaceSyncDispatch' | 'workspaceSyncGetSnapshot' | 'workspaceSyncGetEventsAfter' | 'onWorkspaceSyncEvent'
>

// Local application of an active_changed event. `isCurrentWindow` is true only
// for the renderer that owns `windowId`; remote windows update the targeted
// window's record without claiming global active selection.
export type WorkspaceActiveChangedApply = {
  windowId: WorkspaceWindowId
  workspaceId: WorkspaceId | null
  createdAt: number
  isCurrentWindow: boolean
}

// Local application of a moved_to_window event. `isCurrentWindowTarget` is true
// only for the renderer that owns the destination window; only that renderer
// adopts the moved workspace as its global active selection.
export type WorkspaceMovedApply = {
  workspaceId: WorkspaceId
  fromWindowId: WorkspaceWindowId | null
  toWindowId: WorkspaceWindowId
  makeActive: boolean
  createdAt: number
  isCurrentWindowTarget: boolean
}

// Local application of a window-closed event. The fallback window inherits the
// recorded `movedWorkspaceIds`; receiving renderers route these without needing
// the closing window's full record.
export type WorkspaceClosedApply = {
  windowId: WorkspaceWindowId
  fallbackWindowId: WorkspaceWindowId
  movedWorkspaceIds: WorkspaceId[]
  createdAt: number
}

// Local application of a placement_updated event. Touches only the target
// window's placement fields, never workspace objects or membership.
export type WorkspacePlacementApply = WindowPlacement & {
  windowId: WorkspaceWindowId
  createdAt: number
}

// Local application of a workspace.created event. The workspace is inserted at
// its folder head and assigned to the target window; only the renderer that owns
// the target window claims the moved-in workspace as its global active.
export type WorkspaceCreatedApply = {
  workspace: Workspace
  windowId: WorkspaceWindowId
  folderPath: string | null
  createdAt: number
  isCurrentWindowTarget: boolean
}

export type AgentTerminalSessionApply = {
  workspaceId: WorkspaceId
  agentId: AgentId
  sessionId: string
  cli: AgentCli
}

export type AgentTerminalLaunchStateApply = {
  workspaceId: WorkspaceId
  agentId: AgentId
  cliSessionId?: string | null
  cliStartRequested?: boolean
  cliHasLaunched?: boolean
  cliOnboardingPromptSent?: boolean
  cliResumeAvailable?: boolean
}

export type WorkspaceSyncDiagnostic = {
  phase: 'dispatch' | 'snapshot' | 'listener' | 'replay'
  reason: string
  message: string
}

export type WorkspaceSyncClientDependencies = {
  getApi: () => WorkspaceSyncClientApi | null
  getWindowId: () => WorkspaceWindowId
  applyActiveChanged: (apply: WorkspaceActiveChangedApply) => void
  applyWorkspaceMoved: (apply: WorkspaceMovedApply) => void
  applyWorkspaceClosed: (apply: WorkspaceClosedApply) => void
  applyWorkspacePlacement: (apply: WorkspacePlacementApply) => void
  applyWorkspaceCreated: (apply: WorkspaceCreatedApply) => void
  applyAgentTerminalSession: (apply: AgentTerminalSessionApply) => void
  applyAgentTerminalLaunchState: (apply: AgentTerminalLaunchStateApply) => void
  logDiagnostic?: (diagnostic: WorkspaceSyncDiagnostic) => void
}

export type WorkspaceSyncClient = {
  /** Subscribe to broadcasts and seed the sequence baseline. Returns cleanup. */
  start: () => () => void
  /** Dispatch a user-initiated active workspace selection through main. */
  dispatchSetActiveWorkspace: (windowId: WorkspaceWindowId, workspaceId: WorkspaceId) => Promise<void>
  /** Dispatch an ownership transfer of a workspace to another window. */
  dispatchMoveWorkspaceToWindow: (
    workspaceId: WorkspaceId,
    fromWindowId: WorkspaceWindowId | null,
    toWindowId: WorkspaceWindowId,
    makeActive: boolean
  ) => Promise<void>
  /** Dispatch a detached-window close with its fallback window. */
  dispatchCloseWorkspaceWindow: (
    windowId: WorkspaceWindowId,
    fallbackWindowId: WorkspaceWindowId
  ) => Promise<void>
  /** Dispatch a (already debounced) window placement update. */
  dispatchUpdatePlacement: (placement: WindowPlacement & { windowId: WorkspaceWindowId }) => Promise<void>
  /** Dispatch a newly created workspace's window assignment. */
  dispatchCreateWorkspace: (
    workspace: Workspace,
    windowId: WorkspaceWindowId,
    folderPath: string | null
  ) => Promise<void>
  /** Dispatch a verified terminal session assignment for an agent. */
  dispatchAssignTerminalSession: (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    sessionId: string,
    cli: AgentCli
  ) => Promise<void>
  /** Dispatch verified terminal launch-state changes for an agent. */
  dispatchUpdateTerminalLaunchState: (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    update: Omit<AgentTerminalLaunchStateApply, 'workspaceId' | 'agentId'>
  ) => Promise<void>
  /** Stop listeners and reset sequence/diagnostic state (used by tests). */
  reset: () => void
}

export function createWorkspaceSyncClient(deps: WorkspaceSyncClientDependencies): WorkspaceSyncClient {
  let lastAppliedSequence = 0
  let unsubscribe: (() => void) | null = null
  let started = false
  let eventQueue: Promise<void> = Promise.resolve()
  const reportedDiagnostics = new Set<string>()

  const log = (diagnostic: WorkspaceSyncDiagnostic): void => {
    // Dedup by phase+reason so an unseeded main service (which rejects every
    // selection during incremental migration) cannot spam the console on each
    // workspace switch while still surfacing the condition once.
    const key = `${diagnostic.phase}:${diagnostic.reason}`
    if (reportedDiagnostics.has(key)) return
    reportedDiagnostics.add(key)
    if (deps.logDiagnostic) {
      deps.logDiagnostic(diagnostic)
      return
    }
    console.warn('[workspaceSync] ' + diagnostic.message, {
      phase: diagnostic.phase,
      reason: diagnostic.reason,
    })
  }

  const applyContiguousEvent = (event: WorkspaceSyncEvent): boolean => {
    if (!Number.isFinite(event.sequence) || event.sequence !== lastAppliedSequence + 1) return false
    const createdAt = Number.isFinite(event.createdAt) ? event.createdAt : Date.now()
    const currentWindowId = deps.getWindowId()
    switch (event.type) {
      case 'workspace_window.active_changed':
        deps.applyActiveChanged({
          windowId: event.payload.windowId,
          workspaceId: event.payload.workspaceId,
          createdAt,
          isCurrentWindow: event.payload.windowId === currentWindowId,
        })
        break
      case 'workspace.moved_to_window':
        deps.applyWorkspaceMoved({
          workspaceId: event.payload.workspaceId,
          fromWindowId: event.payload.fromWindowId,
          toWindowId: event.payload.toWindowId,
          makeActive: event.payload.makeActive,
          createdAt,
          isCurrentWindowTarget: event.payload.toWindowId === currentWindowId,
        })
        break
      case 'workspace_window.placement_updated':
        deps.applyWorkspacePlacement({
          windowId: event.payload.windowId,
          bounds: event.payload.bounds,
          isMaximized: event.payload.isMaximized,
          displayId: event.payload.displayId,
          createdAt,
        })
        break
      case 'workspace_window.closed':
        deps.applyWorkspaceClosed({
          windowId: event.payload.windowId,
          fallbackWindowId: event.payload.fallbackWindowId,
          movedWorkspaceIds: event.payload.movedWorkspaceIds,
          createdAt,
        })
        break
      case 'workspace.created':
        deps.applyWorkspaceCreated({
          workspace: event.payload.workspace,
          windowId: event.payload.windowId,
          folderPath: event.payload.insert.folderPath,
          createdAt,
          isCurrentWindowTarget: event.payload.windowId === currentWindowId,
        })
        break
      case 'agent_terminal.session_assigned':
        deps.applyAgentTerminalSession(event.payload)
        break
      case 'agent_terminal.launch_state_updated':
        deps.applyAgentTerminalLaunchState(event.payload)
        break
    }
    lastAppliedSequence = event.sequence
    return true
  }

  const recoverSequenceGap = async (api: WorkspaceSyncClientApi, event: WorkspaceSyncEvent): Promise<void> => {
    const previousSequence = lastAppliedSequence
    let replayed: WorkspaceSyncEvent[]
    try {
      replayed = await api.workspaceSyncGetEventsAfter(lastAppliedSequence)
    } catch {
      log({ phase: 'replay', reason: 'replay_failed', message: 'Failed to replay missed workspace sync events after a sequence gap.' })
      await recoverSnapshotBaseline(api)
      return
    }

    const orderedReplay = replayed
      .filter((candidate) => Number.isFinite(candidate.sequence) && candidate.sequence > lastAppliedSequence)
      .sort((a, b) => a.sequence - b.sequence)
    for (const candidate of orderedReplay) {
      if (candidate.sequence <= lastAppliedSequence) continue
      if (candidate.sequence !== lastAppliedSequence + 1) break
      applyContiguousEvent(candidate)
    }

    if (lastAppliedSequence >= event.sequence) return
    if (event.sequence === lastAppliedSequence + 1) {
      applyContiguousEvent(event)
      return
    }

    log({
      phase: 'replay',
      reason: 'incomplete_replay',
      message: `Workspace sync replay after sequence ${previousSequence} did not include a contiguous path to event ${event.sequence}.`,
    })
    await recoverSnapshotBaseline(api)
  }

  const recoverSnapshotBaseline = async (api: WorkspaceSyncClientApi): Promise<void> => {
    try {
      const snapshot = await api.workspaceSyncGetSnapshot()
      if (Number.isFinite(snapshot?.sequence) && snapshot.sequence > lastAppliedSequence) {
        lastAppliedSequence = snapshot.sequence
      }
    } catch {
      log({ phase: 'snapshot', reason: 'snapshot_failed', message: 'Failed to read the workspace sync snapshot after replay recovery.' })
    }
  }

  const processEvent = async (event: WorkspaceSyncEvent): Promise<void> => {
    if (!Number.isFinite(event.sequence) || event.sequence <= lastAppliedSequence) return
    if (event.sequence === lastAppliedSequence + 1) {
      applyContiguousEvent(event)
      return
    }
    const api = deps.getApi()
    if (!api) {
      log({ phase: 'replay', reason: 'api_unavailable', message: 'Workspace sync API is unavailable; skipped noncontiguous workspace sync event.' })
      return
    }
    await recoverSequenceGap(api, event)
  }

  const enqueueEvent = (event: WorkspaceSyncEvent): Promise<void> => {
    eventQueue = eventQueue.then(() => processEvent(event)).catch(() => {
      log({ phase: 'listener', reason: 'event_apply_failed', message: 'Workspace sync event application failed.' })
    })
    return eventQueue
  }

  const start = (): (() => void) => {
    if (started) return () => stop()
    started = true
    const api = deps.getApi()
    if (!api) {
      log({ phase: 'listener', reason: 'api_unavailable', message: 'Workspace sync API is unavailable; multi-window selection events are disabled.' })
      return () => stop()
    }

    try {
      unsubscribe = api.onWorkspaceSyncEvent((event) => {
        void enqueueEvent(event)
      })
    } catch (error) {
      log({ phase: 'listener', reason: 'subscribe_failed', message: 'Failed to subscribe to workspace sync events.' })
      unsubscribe = null
    }

    // Seed the sequence baseline from the current main snapshot so events at or
    // below it are treated as already applied. We deliberately do not import the
    // snapshot's routing into the local store here: storage-event sync still
    // owns workspace/window membership during this phase.
    void api
      .workspaceSyncGetSnapshot()
      .then((snapshot) => {
        if (Number.isFinite(snapshot?.sequence) && snapshot.sequence > lastAppliedSequence) {
          lastAppliedSequence = snapshot.sequence
        }
      })
      .catch(() => {
        log({ phase: 'snapshot', reason: 'snapshot_failed', message: 'Failed to read the workspace sync snapshot.' })
      })

    return () => stop()
  }

  const stop = (): void => {
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {
        // Listener removal is best-effort.
      }
      unsubscribe = null
    }
    started = false
  }

  // Every user-initiated command flows through here. The local store already
  // applied the change optimistically, so a rejection is a logged no-op and an
  // acceptance only re-applies the accepted event idempotently (advancing the
  // sequence baseline). Failures are never thrown.
  const dispatchCommand = async (command: WorkspaceSyncCommand): Promise<void> => {
    const api = deps.getApi()
    if (!api) {
      log({ phase: 'dispatch', reason: 'api_unavailable', message: `Workspace sync API is unavailable; ${command.type} stays local-only.` })
      return
    }
    let result: WorkspaceSyncCommandResult
    try {
      result = await api.workspaceSyncDispatch(command)
    } catch (error) {
      log({
        phase: 'dispatch',
        reason: 'dispatch_threw',
        message: `Workspace sync dispatch threw: ${error instanceof Error ? error.message : 'unknown error'}.`,
      })
      return
    }
    if (!result.ok) {
      log({
        phase: 'dispatch',
        reason: result.reason,
        message: `Workspace sync rejected ${command.type} (${result.reason}): ${result.message}`,
      })
      return
    }
    await enqueueEvent(result.event)
  }

  const dispatchSetActiveWorkspace = (
    windowId: WorkspaceWindowId,
    workspaceId: WorkspaceId
  ): Promise<void> =>
    dispatchCommand({ type: 'workspace_window.set_active', payload: { windowId, workspaceId } })

  const dispatchMoveWorkspaceToWindow = (
    workspaceId: WorkspaceId,
    fromWindowId: WorkspaceWindowId | null,
    toWindowId: WorkspaceWindowId,
    makeActive: boolean
  ): Promise<void> =>
    dispatchCommand({
      type: 'workspace.move_to_window',
      payload: { workspaceId, fromWindowId, toWindowId, makeActive },
    })

  const dispatchCloseWorkspaceWindow = (
    windowId: WorkspaceWindowId,
    fallbackWindowId: WorkspaceWindowId
  ): Promise<void> =>
    dispatchCommand({ type: 'workspace_window.close', payload: { windowId, fallbackWindowId } })

  const dispatchUpdatePlacement = (
    placement: WindowPlacement & { windowId: WorkspaceWindowId }
  ): Promise<void> =>
    dispatchCommand({ type: 'workspace_window.update_placement', payload: placement })

  const dispatchCreateWorkspace = (
    workspace: Workspace,
    windowId: WorkspaceWindowId,
    folderPath: string | null
  ): Promise<void> =>
    dispatchCommand({
      type: 'workspace.created',
      payload: { workspace, windowId, insert: { kind: 'folder_head', folderPath } },
    })

  const dispatchAssignTerminalSession = (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    sessionId: string,
    cli: AgentCli
  ): Promise<void> =>
    dispatchCommand({
      type: 'agent_terminal.assign_session',
      payload: { workspaceId, agentId, sessionId, cli },
    })

  const dispatchUpdateTerminalLaunchState = (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    update: Omit<AgentTerminalLaunchStateApply, 'workspaceId' | 'agentId'>
  ): Promise<void> =>
    dispatchCommand({
      type: 'agent_terminal.update_launch_state',
      payload: { workspaceId, agentId, ...update },
    })

  const reset = (): void => {
    stop()
    lastAppliedSequence = 0
    eventQueue = Promise.resolve()
    reportedDiagnostics.clear()
  }

  return {
    start,
    dispatchSetActiveWorkspace,
    dispatchMoveWorkspaceToWindow,
    dispatchCloseWorkspaceWindow,
    dispatchUpdatePlacement,
    dispatchCreateWorkspace,
    dispatchAssignTerminalSession,
    dispatchUpdateTerminalLaunchState,
    reset,
  }
}

function defaultGetApi(): WorkspaceSyncClientApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api
  if (
    !api
    || typeof api.workspaceSyncDispatch !== 'function'
    || typeof api.workspaceSyncGetSnapshot !== 'function'
    || typeof api.workspaceSyncGetEventsAfter !== 'function'
    || typeof api.onWorkspaceSyncEvent !== 'function'
  ) {
    return null
  }
  return api
}

function defaultGetWindowId(): WorkspaceWindowId {
  if (typeof window === 'undefined') return PRIMARY_WORKSPACE_WINDOW_ID
  try {
    return new URL(window.location.href).searchParams.get('windowId')?.trim() || PRIMARY_WORKSPACE_WINDOW_ID
  } catch {
    return PRIMARY_WORKSPACE_WINDOW_ID
  }
}

// The apply callbacks are injected by workspaceStore.ts after the store is
// created, avoiding an import cycle (store → slice → client → store). Each
// handler runs under the store's persist-suppression so an imported event never
// re-emits a command or echoes back through the storage rollback path.
export type WorkspaceSyncEventHandlers = {
  applyActiveChanged: (apply: WorkspaceActiveChangedApply) => void
  applyWorkspaceMoved: (apply: WorkspaceMovedApply) => void
  applyWorkspaceClosed: (apply: WorkspaceClosedApply) => void
  applyWorkspacePlacement: (apply: WorkspacePlacementApply) => void
  applyWorkspaceCreated: (apply: WorkspaceCreatedApply) => void
  applyAgentTerminalSession: (apply: AgentTerminalSessionApply) => void
  applyAgentTerminalLaunchState: (apply: AgentTerminalLaunchStateApply) => void
}

let configuredHandlers: WorkspaceSyncEventHandlers | null = null

export function configureWorkspaceSyncClient(handlers: WorkspaceSyncEventHandlers): void {
  configuredHandlers = handlers
}

export const workspaceSyncClient = createWorkspaceSyncClient({
  getApi: defaultGetApi,
  getWindowId: defaultGetWindowId,
  applyActiveChanged: (apply) => configuredHandlers?.applyActiveChanged(apply),
  applyWorkspaceMoved: (apply) => configuredHandlers?.applyWorkspaceMoved(apply),
  applyWorkspaceClosed: (apply) => configuredHandlers?.applyWorkspaceClosed(apply),
  applyWorkspacePlacement: (apply) => configuredHandlers?.applyWorkspacePlacement(apply),
  applyWorkspaceCreated: (apply) => configuredHandlers?.applyWorkspaceCreated(apply),
  applyAgentTerminalSession: (apply) => configuredHandlers?.applyAgentTerminalSession(apply),
  applyAgentTerminalLaunchState: (apply) => configuredHandlers?.applyAgentTerminalLaunchState(apply),
})
