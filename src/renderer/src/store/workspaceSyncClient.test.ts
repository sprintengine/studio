import assert from 'node:assert/strict'

import { createWorkspaceSyncService } from '../../../main/workspace-sync-service'
import { createWorkspaceRegistryService } from '../../../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../../../main/workspace-registry-store'
import { emptyWorkspaceRegistryFile, toWorkspaceRegistryRecord } from '../../../shared/workspace-registry'
import {
  createWorkspaceSyncClient,
  type WorkspaceActiveChangedApply,
  type WorkspaceClosedApply,
  type WorkspaceCreatedApply,
  type WorkspaceMovedApply,
  type WorkspacePlacementApply,
  type AgentTerminalLaunchStateApply,
  type AgentTerminalSessionApply,
  type WorkspaceSyncClientApi,
  type WorkspaceSyncClientDependencies,
  type WorkspaceSyncDiagnostic,
} from './workspaceSyncClient'
import type {
  WorkspaceSyncCommand,
  WorkspaceSyncEvent,
  WorkspaceSyncSnapshot,
} from '../../../shared/workspace-sync'
import type { AgentState, Workspace, WorkspaceId, WorkspaceWindowState } from '../types/workspace'

// A fake renderer store: it holds the per-window routing this renderer knows
// about plus the single global active workspace id, and applies events with the
// same window-scoped semantics as workspacesSlice's apply* actions.
function createFakeStore(windows: WorkspaceWindowState[], activeWorkspaceId: WorkspaceId | null) {
  const state = {
    workspaces: seedSnapshot().state.workspaces.map((workspace) => ({
      ...workspace,
      agents: { ...workspace.agents },
    })),
    workspaceWindows: windows.map((window) => ({ ...window, workspaceIds: [...window.workspaceIds] })),
    activeWorkspaceId,
  }
  const findWindow = (windowId: string) => state.workspaceWindows.find((window) => window.id === windowId)
  const ensureWindow = (windowId: string) => {
    const existing = findWindow(windowId)
    if (existing) return existing
    const created: WorkspaceWindowState = windowState(windowId, [], null)
    state.workspaceWindows.push(created)
    return created
  }
  return {
    state,
    windowActive(windowId: string): WorkspaceId | null {
      return findWindow(windowId)?.activeWorkspaceId ?? null
    },
    windowWorkspaceIds(windowId: string): WorkspaceId[] | null {
      return findWindow(windowId)?.workspaceIds ?? null
    },
    windowBounds(windowId: string): WorkspaceWindowState['bounds'] | undefined {
      return findWindow(windowId)?.bounds
    },
    hasWindow(windowId: string): boolean {
      return Boolean(findWindow(windowId))
    },
    agent(workspaceId: string, agentId: string) {
      return state.workspaces.find((workspace) => workspace.id === workspaceId)?.agents[agentId]
    },
    apply({ windowId, workspaceId, createdAt, isCurrentWindow }: WorkspaceActiveChangedApply): void {
      const windowState = findWindow(windowId)
      if (!windowState) return
      if (workspaceId !== null && !windowState.workspaceIds.includes(workspaceId)) return
      windowState.activeWorkspaceId = workspaceId
      if (Number.isFinite(createdAt)) windowState.lastFocusedAt = createdAt
      if (isCurrentWindow && workspaceId) state.activeWorkspaceId = workspaceId
    },
    applyMoved({ workspaceId, fromWindowId, toWindowId, makeActive, createdAt, isCurrentWindowTarget }: WorkspaceMovedApply): void {
      const target = ensureWindow(toWindowId)
      for (const windowState of state.workspaceWindows) {
        if (windowState.id === toWindowId) continue
        windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== workspaceId)
        if (windowState.activeWorkspaceId === workspaceId) {
          windowState.activeWorkspaceId = windowState.workspaceIds[0] ?? null
        }
      }
      if (!target.workspaceIds.includes(workspaceId)) target.workspaceIds.push(workspaceId)
      if (makeActive) {
        target.activeWorkspaceId = workspaceId
        if (Number.isFinite(createdAt)) target.lastFocusedAt = createdAt
        if (isCurrentWindowTarget) state.activeWorkspaceId = workspaceId
      } else if (!target.activeWorkspaceId) {
        target.activeWorkspaceId = target.workspaceIds[0] ?? null
      }
      if (fromWindowId && fromWindowId !== toWindowId) {
        const source = findWindow(fromWindowId)
        if (source && source.activeWorkspaceId === workspaceId) {
          source.activeWorkspaceId = source.workspaceIds[0] ?? null
        }
      }
    },
    applyClosed({ windowId, fallbackWindowId, movedWorkspaceIds, createdAt }: WorkspaceClosedApply): void {
      const closing = findWindow(windowId)
      const routed = movedWorkspaceIds.length > 0 ? movedWorkspaceIds : closing?.workspaceIds ?? []
      if (!closing && routed.length === 0) return
      const fallback = ensureWindow(fallbackWindowId)
      for (const id of routed) {
        if (!fallback.workspaceIds.includes(id)) fallback.workspaceIds.push(id)
      }
      if (!fallback.activeWorkspaceId && fallback.workspaceIds.length > 0) {
        fallback.activeWorkspaceId = closing?.activeWorkspaceId && fallback.workspaceIds.includes(closing.activeWorkspaceId)
          ? closing.activeWorkspaceId
          : fallback.workspaceIds[0] ?? null
      }
      if (Number.isFinite(createdAt)) fallback.lastFocusedAt = createdAt
      if (closing) {
        state.workspaceWindows = state.workspaceWindows.filter((windowState) => windowState.id !== windowId)
      }
    },
    applyPlacement({ windowId, bounds, isMaximized, displayId, createdAt }: WorkspacePlacementApply): void {
      const windowState = ensureWindow(windowId)
      windowState.bounds = bounds ? { ...bounds } : null
      windowState.isMaximized = isMaximized === true
      windowState.displayId = typeof displayId === 'number' ? displayId : null
      if (Number.isFinite(createdAt)) windowState.lastFocusedAt = createdAt
    },
    applyCreated({ workspace, windowId, createdAt, isCurrentWindowTarget }: WorkspaceCreatedApply): void {
      if (!state.workspaces.some((candidate) => candidate.id === workspace.id)) {
        state.workspaces.push({ ...workspace, agents: { ...workspace.agents } })
      }
      for (const windowState of state.workspaceWindows) {
        windowState.workspaceIds = windowState.workspaceIds.filter((id) => id !== workspace.id)
      }
      const target = ensureWindow(windowId)
      target.workspaceIds = [workspace.id, ...target.workspaceIds]
      target.activeWorkspaceId = workspace.id
      if (Number.isFinite(createdAt)) target.lastFocusedAt = createdAt
      if (isCurrentWindowTarget) state.activeWorkspaceId = workspace.id
    },
    applyTerminalSession({ workspaceId, agentId, sessionId, cli, cliResumeAvailable, cliUsesStableSessionId }: AgentTerminalSessionApply): void {
      const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
      if (!workspace) return
      workspace.agents[agentId] = {
        ...workspace.agents[agentId],
        id: agentId,
        name: agentId,
        status: 'idle',
        messages: [],
        streamBuffer: '',
        execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
        cliSessionId: sessionId,
        cli,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeAvailable,
        cliUsesStableSessionId,
      } as AgentState
    },
    applyTerminalLaunchState({ workspaceId, agentId, ...update }: AgentTerminalLaunchStateApply): void {
      const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
      if (!workspace) return
      const current = workspace.agents[agentId] ?? {
        id: agentId,
        name: agentId,
        status: 'idle',
        messages: [],
        streamBuffer: '',
        execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
      }
      workspace.agents[agentId] = {
        ...current,
        ...(update.cliSessionId !== undefined ? { cliSessionId: update.cliSessionId ?? undefined } : {}),
        ...(update.cliStartRequested !== undefined ? { cliStartRequested: update.cliStartRequested } : {}),
        ...(update.cliHasLaunched !== undefined ? { cliHasLaunched: update.cliHasLaunched } : {}),
        ...(update.cliOnboardingPromptSent !== undefined ? { cliOnboardingPromptSent: update.cliOnboardingPromptSent } : {}),
        ...(update.cliResumeAvailable !== undefined ? { cliResumeAvailable: update.cliResumeAvailable } : {}),
      } as AgentState
    },
  }
}

type FakeStore = ReturnType<typeof createFakeStore>

// Builds the full handler set from a fake store so each test wires all four
// event types the client now applies.
function storeDeps(
  store: FakeStore,
  windowId: string,
  api: WorkspaceSyncClientApi | null,
  logDiagnostic: (diagnostic: WorkspaceSyncDiagnostic) => void = () => {}
): WorkspaceSyncClientDependencies {
  return {
    getApi: () => api,
    getWindowId: () => windowId,
    applyActiveChanged: store.apply,
    applyWorkspaceMoved: store.applyMoved,
    applyWorkspaceClosed: store.applyClosed,
    applyWorkspacePlacement: store.applyPlacement,
    applyWorkspaceCreated: store.applyCreated,
    applyAgentTerminalSession: store.applyTerminalSession,
    applyAgentTerminalLaunchState: store.applyTerminalLaunchState,
    // Registry-domain applies (MC-2158) are not what these tests exercise —
    // they assert sequencing, replay, and no-echo — so they are inert here and
    // covered by the reconciliation suite instead.
    ...inertRegistryApplies(),
    logDiagnostic,
  }
}

// The registry-domain apply handlers, as no-ops. Declared once so adding an
// event type does not mean editing every dependency literal in this file.
function inertRegistryApplies(): Pick<
  WorkspaceSyncClientDependencies,
  | 'applyWorkspaceRenamed'
  | 'applyWorkspaceLayoutUpdated'
  | 'applyWorkspaceFieldsUpdated'
  | 'applyWorkspaceAgentUpdated'
  | 'applyWorkspaceRemoved'
  | 'applyRegistrySnapshot'
> {
  const noop = () => {}
  return {
    applyWorkspaceRenamed: noop,
    applyWorkspaceLayoutUpdated: noop,
    applyWorkspaceFieldsUpdated: noop,
    applyWorkspaceAgentUpdated: noop,
    applyWorkspaceRemoved: noop,
    applyRegistrySnapshot: noop,
  }
}

// Handler set for tests that exercise only diagnostics/sequence behavior and do
// not need a real store apply. Each handler can be overridden.
function stubDeps(
  partial: Partial<WorkspaceSyncClientDependencies> & Pick<WorkspaceSyncClientDependencies, 'getApi' | 'getWindowId'>
): WorkspaceSyncClientDependencies {
  const noop = () => {}
  return {
    applyActiveChanged: noop,
    applyWorkspaceMoved: noop,
    applyWorkspaceClosed: noop,
    applyWorkspacePlacement: noop,
    applyWorkspaceCreated: noop,
    applyAgentTerminalSession: noop,
    applyAgentTerminalLaunchState: noop,
    ...inertRegistryApplies(),
    ...partial,
  }
}

function windowState(id: string, workspaceIds: string[], activeWorkspaceId: string | null): WorkspaceWindowState {
  return {
    id,
    kind: id === 'primary' ? 'primary' : 'detached',
    workspaceIds,
    activeWorkspaceId,
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: 0,
    lastFocusedAt: 0,
  }
}

function workspace(id: string): Workspace {
  return { id, agents: {} } as unknown as Workspace
}

// A bus that mirrors the real main IPC: dispatch goes through one shared
// service; accepted events broadcast to every window except the source sender.
function createBus(snapshot: WorkspaceSyncSnapshot) {
  // The bus reads and writes through the registry, so a seeded test bus is a
  // seeded registry — `initialSnapshot` went with the non-authoritative mirror.
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore({
      ...emptyWorkspaceRegistryFile(1),
      revision: 1,
      workspaces: snapshot.state.workspaces.map((entry) => toWorkspaceRegistryRecord(entry, 1)),
      workspaceWindows: snapshot.state.workspaceWindows,
      primaryWorkspaceWindowId: snapshot.state.primaryWorkspaceWindowId,
      activeWorkspaceId: snapshot.state.activeWorkspaceId,
    }),
    now: () => 1_000,
  })
  const service = createWorkspaceSyncService({ registry, now: () => 1_000 })
  const listeners = new Map<string, Set<(event: WorkspaceSyncEvent) => void>>()
  let dispatchCount = 0

  function makeApi(windowId: string): WorkspaceSyncClientApi {
    return {
      workspaceSyncDispatch: (command: WorkspaceSyncCommand) => {
        dispatchCount += 1
        const result = service.dispatch({ command, sourceWindowId: windowId })
        if (result.ok) {
          for (const [targetWindowId, set] of listeners) {
            if (targetWindowId === windowId) continue
            for (const cb of set) cb(result.event)
          }
        }
        return Promise.resolve(result)
      },
      workspaceSyncGetSnapshot: () => Promise.resolve(service.getSnapshot()),
      workspaceSyncGetEventsAfter: (sequence: number) => Promise.resolve(service.getEventsAfter(sequence)),
      onWorkspaceSyncEvent: (cb: (event: WorkspaceSyncEvent) => void) => {
        const set = listeners.get(windowId) ?? new Set()
        set.add(cb)
        listeners.set(windowId, set)
        return () => set.delete(cb)
      },
    }
  }

  return {
    makeApi,
    listenerCount: (windowId: string) => listeners.get(windowId)?.size ?? 0,
    get dispatchCount() {
      return dispatchCount
    },
  }
}

function seedSnapshot(): WorkspaceSyncSnapshot {
  return {
    sequence: 0,
    state: {
      workspaces: [workspace('wsA1'), workspace('wsA2'), workspace('wsB1')],
      activeWorkspaceId: 'wsA1',
      primaryWorkspaceWindowId: 'A',
      workspaceWindows: [
        windowState('A', ['wsA1', 'wsA2'], 'wsA1'),
        windowState('B', ['wsB1'], 'wsB1'),
      ],
    },
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

// AC6: active selection in Window A must not flip Window B.
async function twoWindowSelectionDoesNotFlipOther(): Promise<void> {
  const bus = createBus(seedSnapshot())

  const storeA = createFakeStore(
    [windowState('A', ['wsA1', 'wsA2'], 'wsA1'), windowState('B', ['wsB1'], 'wsB1')],
    'wsA1'
  )
  const storeB = createFakeStore(
    [windowState('A', ['wsA1', 'wsA2'], 'wsA1'), windowState('B', ['wsB1'], 'wsB1')],
    'wsB1'
  )

  const clientA = createWorkspaceSyncClient(storeDeps(storeA, 'A', bus.makeApi('A')))
  const clientB = createWorkspaceSyncClient(storeDeps(storeB, 'B', bus.makeApi('B')))
  // Each client subscribes under its own window id; broadcasts route to every
  // window except the dispatch source.
  const stopA = clientA.start()
  const stopB = clientB.start()
  await flush()

  // User selects wsA2 in window A: local store applies first, then dispatch.
  storeA.apply({ windowId: 'A', workspaceId: 'wsA2', createdAt: 1, isCurrentWindow: true })
  await clientA.dispatchSetActiveWorkspace('A', 'wsA2')
  await flush()

  assert.equal(storeA.windowActive('A'), 'wsA2', 'window A reflects its own selection')
  assert.equal(storeB.windowActive('B'), 'wsB1', "window B's active workspace is unchanged")
  assert.equal(storeB.windowActive('A'), 'wsA2', "window B mirrors window A's routing record")
  assert.equal(storeB.state.activeWorkspaceId, 'wsB1', "window B does not adopt window A's global active")

  stopA()
  stopB()
  console.log('workspaceSyncClient.test.ts: two-window selection does not flip other — ok')
}

// AC3: duplicate and older sequences are ignored; only the targeted window changes.
async function ignoresDuplicateAndStaleEvents(): Promise<void> {
  const applied: WorkspaceActiveChangedApply[] = []
  const listenerRef: { emit?: (event: WorkspaceSyncEvent) => void } = {}
  const api: WorkspaceSyncClientApi = {
    workspaceSyncDispatch: () => Promise.resolve({ ok: false, reason: 'unused', message: 'unused' }),
    workspaceSyncGetSnapshot: () =>
      Promise.resolve({ sequence: 0, state: seedSnapshot().state }),
    workspaceSyncGetEventsAfter: () => Promise.resolve([]),
    onWorkspaceSyncEvent: (cb) => {
      listenerRef.emit = cb
      return () => {
        listenerRef.emit = undefined
      }
    },
  }
  const client = createWorkspaceSyncClient(stubDeps({
    getApi: () => api,
    getWindowId: () => 'B',
    applyActiveChanged: (apply) => applied.push(apply),
  }))
  const stop = client.start()
  await flush()
  const emit = listenerRef.emit
  assert.ok(emit, 'client subscribed to broadcasts')

  const event = (sequence: number, workspaceId: string | null): WorkspaceSyncEvent => ({
    id: `workspace-sync-${sequence}`,
    type: 'workspace_window.active_changed',
    sourceWindowId: 'A',
    sequence,
    createdAt: 10,
    payload: { windowId: 'A', workspaceId },
  })

  emit(event(1, 'wsA1'))
  emit(event(1, 'wsA2')) // duplicate sequence — ignored
  emit(event(0, 'wsA2')) // older sequence — ignored
  emit(event(2, 'wsA2')) // newer — applied
  await flush()

  assert.equal(applied.length, 2, 'only the first and the newer event apply')
  assert.deepEqual(
    applied.map((a) => a.workspaceId),
    ['wsA1', 'wsA2'],
    'duplicate and stale sequences are dropped'
  )
  assert.equal(applied[0].isCurrentWindow, false, 'events targeting another window are not current-window')

  stop()
  console.log('workspaceSyncClient.test.ts: duplicate/stale sequences ignored — ok')
}

async function recoversSequenceGapThroughReplay(): Promise<void> {
  const applied: WorkspaceActiveChangedApply[] = []
  const listenerRef: { emit?: (event: WorkspaceSyncEvent) => void } = {}
  const replayRequests: number[] = []
  const event = (sequence: number, workspaceId: string): WorkspaceSyncEvent => ({
    id: `workspace-sync-${sequence}`,
    type: 'workspace_window.active_changed',
    sourceWindowId: 'A',
    sequence,
    createdAt: 10 + sequence,
    payload: { windowId: 'A', workspaceId },
  })
  const api: WorkspaceSyncClientApi = {
    workspaceSyncDispatch: () => Promise.resolve({ ok: false, reason: 'unused', message: 'unused' }),
    workspaceSyncGetSnapshot: () => Promise.resolve({ sequence: 0, state: seedSnapshot().state }),
    workspaceSyncGetEventsAfter: (sequence) => {
      replayRequests.push(sequence)
      return Promise.resolve([event(1, 'wsA1'), event(2, 'wsA2')])
    },
    onWorkspaceSyncEvent: (cb) => {
      listenerRef.emit = cb
      return () => {
        listenerRef.emit = undefined
      }
    },
  }
  const client = createWorkspaceSyncClient(stubDeps({
    getApi: () => api,
    getWindowId: () => 'A',
    applyActiveChanged: (apply) => applied.push(apply),
  }))
  const stop = client.start()
  await flush()
  assert.ok(listenerRef.emit)

  listenerRef.emit(event(3, 'wsA1'))
  await flush()

  assert.deepEqual(replayRequests, [0], 'gap recovery requests replay from the last applied sequence')
  assert.deepEqual(
    applied.map((apply) => apply.workspaceId),
    ['wsA1', 'wsA2', 'wsA1'],
    'missing replay events apply contiguously before the original future event',
  )

  stop()
  console.log('workspaceSyncClient.test.ts: sequence gap recovers through replay — ok')
}

async function incompleteReplayFallsBackToSnapshotBaseline(): Promise<void> {
  const applied: WorkspaceActiveChangedApply[] = []
  const diagnostics: WorkspaceSyncDiagnostic[] = []
  const listenerRef: { emit?: (event: WorkspaceSyncEvent) => void } = {}
  let snapshotCalls = 0
  const event = (sequence: number, workspaceId: string): WorkspaceSyncEvent => ({
    id: `workspace-sync-${sequence}`,
    type: 'workspace_window.active_changed',
    sourceWindowId: 'A',
    sequence,
    createdAt: 10 + sequence,
    payload: { windowId: 'A', workspaceId },
  })
  const api: WorkspaceSyncClientApi = {
    workspaceSyncDispatch: () => Promise.resolve({ ok: false, reason: 'unused', message: 'unused' }),
    workspaceSyncGetSnapshot: () => {
      snapshotCalls += 1
      return Promise.resolve({ sequence: snapshotCalls === 1 ? 0 : 3, state: seedSnapshot().state })
    },
    workspaceSyncGetEventsAfter: () => Promise.resolve([event(1, 'wsA1')]),
    onWorkspaceSyncEvent: (cb) => {
      listenerRef.emit = cb
      return () => {
        listenerRef.emit = undefined
      }
    },
  }
  const client = createWorkspaceSyncClient(stubDeps({
    getApi: () => api,
    getWindowId: () => 'A',
    applyActiveChanged: (apply) => applied.push(apply),
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  }))
  const stop = client.start()
  await flush()
  assert.ok(listenerRef.emit)

  listenerRef.emit(event(3, 'wsA2'))
  await flush()

  assert.deepEqual(
    applied.map((apply) => apply.workspaceId),
    ['wsA1'],
    'incomplete replay applies only contiguous recovered events and skips the future gap event',
  )
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.phase === 'replay' && diagnostic.reason === 'incomplete_replay'),
    'incomplete replay is observable',
  )

  listenerRef.emit(event(3, 'wsA2'))
  await flush()
  assert.deepEqual(
    applied.map((apply) => apply.workspaceId),
    ['wsA1'],
    'snapshot fallback advances the baseline so the skipped gap event is not later applied stale',
  )

  stop()
  console.log('workspaceSyncClient.test.ts: incomplete replay falls back to snapshot baseline — ok')
}

async function replayFailureFallsBackToSnapshotBaseline(): Promise<void> {
  const applied: WorkspaceActiveChangedApply[] = []
  const diagnostics: WorkspaceSyncDiagnostic[] = []
  const listenerRef: { emit?: (event: WorkspaceSyncEvent) => void } = {}
  let snapshotCalls = 0
  const event: WorkspaceSyncEvent = {
    id: 'workspace-sync-2',
    type: 'workspace_window.active_changed',
    sourceWindowId: 'A',
    sequence: 2,
    createdAt: 20,
    payload: { windowId: 'A', workspaceId: 'wsA2' },
  }
  const api: WorkspaceSyncClientApi = {
    workspaceSyncDispatch: () => Promise.resolve({ ok: false, reason: 'unused', message: 'unused' }),
    workspaceSyncGetSnapshot: () => {
      snapshotCalls += 1
      return Promise.resolve({ sequence: snapshotCalls === 1 ? 0 : 2, state: seedSnapshot().state })
    },
    workspaceSyncGetEventsAfter: () => Promise.reject(new Error('replay unavailable')),
    onWorkspaceSyncEvent: (cb) => {
      listenerRef.emit = cb
      return () => {
        listenerRef.emit = undefined
      }
    },
  }
  const client = createWorkspaceSyncClient(stubDeps({
    getApi: () => api,
    getWindowId: () => 'A',
    applyActiveChanged: (apply) => applied.push(apply),
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  }))
  const stop = client.start()
  await flush()
  assert.ok(listenerRef.emit)

  listenerRef.emit(event)
  await flush()

  assert.equal(applied.length, 0, 'failed replay never applies the noncontiguous event against stale state')
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.phase === 'replay' && diagnostic.reason === 'replay_failed'),
    'replay failure is observable',
  )

  stop()
  console.log('workspaceSyncClient.test.ts: replay failure falls back to snapshot baseline — ok')
}

// AC4: dispatch rejection surfaces a single deduped diagnostic and never throws.
async function rejectedDispatchLogsOnce(): Promise<void> {
  const diagnostics: WorkspaceSyncDiagnostic[] = []
  const api: WorkspaceSyncClientApi = {
    workspaceSyncDispatch: () =>
      Promise.resolve({ ok: false, reason: 'workspace_not_in_window', message: 'not seeded yet' }),
    workspaceSyncGetSnapshot: () => Promise.resolve({ sequence: 0, state: seedSnapshot().state }),
    workspaceSyncGetEventsAfter: () => Promise.resolve([]),
    onWorkspaceSyncEvent: () => () => {},
  }
  const client = createWorkspaceSyncClient(stubDeps({
    getApi: () => api,
    getWindowId: () => 'A',
    applyActiveChanged: () => {
      throw new Error('apply must not run on a rejected dispatch')
    },
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  }))

  await client.dispatchSetActiveWorkspace('A', 'wsA1')
  await client.dispatchSetActiveWorkspace('A', 'wsA1')

  assert.equal(diagnostics.length, 1, 'repeated identical rejections are deduped to one diagnostic')
  assert.equal(diagnostics[0].phase, 'dispatch')
  assert.equal(diagnostics[0].reason, 'workspace_not_in_window')
  console.log('workspaceSyncClient.test.ts: rejected dispatch logs once — ok')
}

// AC4: missing sync API is a safe, logged no-op.
async function unavailableApiIsSafe(): Promise<void> {
  const diagnostics: WorkspaceSyncDiagnostic[] = []
  const client = createWorkspaceSyncClient(stubDeps({
    getApi: () => null,
    getWindowId: () => 'A',
    applyActiveChanged: () => {
      throw new Error('apply must not run when the api is unavailable')
    },
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  }))
  const stop = client.start()
  await client.dispatchSetActiveWorkspace('A', 'wsA1')
  stop()
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.reason === 'api_unavailable'),
    'an explicit diagnostic is surfaced when the sync api is unavailable'
  )
  console.log('workspaceSyncClient.test.ts: unavailable api is safe — ok')
}

// AC1: start subscribes and the returned cleanup removes the listener; reset
// clears the sequence baseline so a fresh run re-applies from scratch.
async function startCleansUpAndResets(): Promise<void> {
  let activeListeners = 0
  const listenerRef: { emit?: (event: WorkspaceSyncEvent) => void } = {}
  const api: WorkspaceSyncClientApi = {
    workspaceSyncDispatch: () => Promise.resolve({ ok: false, reason: 'unused', message: 'unused' }),
    workspaceSyncGetSnapshot: () => Promise.resolve({ sequence: 5, state: seedSnapshot().state }),
    workspaceSyncGetEventsAfter: () => Promise.resolve([]),
    onWorkspaceSyncEvent: (cb) => {
      activeListeners += 1
      listenerRef.emit = cb
      return () => {
        activeListeners -= 1
      }
    },
  }
  const applied: WorkspaceActiveChangedApply[] = []
  const client = createWorkspaceSyncClient(stubDeps({
    getApi: () => api,
    getWindowId: () => 'A',
    applyActiveChanged: (apply) => applied.push(apply),
  }))

  const stop = client.start()
  await flush()
  assert.equal(activeListeners, 1, 'start subscribes exactly one listener')
  const emit = listenerRef.emit
  assert.ok(emit, 'start subscribed a listener')

  // Snapshot sequence was 5, so an event at sequence 4 is below the baseline.
  emit({
    id: 'workspace-sync-4',
    type: 'workspace_window.active_changed',
    sourceWindowId: 'A',
    sequence: 4,
    createdAt: 1,
    payload: { windowId: 'A', workspaceId: 'wsA1' },
  })
  assert.equal(applied.length, 0, 'events at or below the seeded snapshot sequence are ignored')

  stop()
  assert.equal(activeListeners, 0, 'cleanup removes the listener')

  client.reset()
  const stop2 = client.start()
  await flush()
  assert.equal(activeListeners, 1, 'client can restart after reset')
  stop2()
  console.log('workspaceSyncClient.test.ts: start cleanup + reset — ok')
}

// Shared two-window rig: one real main service plus two fake renderer stores
// wired through the bus, exactly like the IPC layer. Storage-event sync remains
// the renderer's separate rollback path; these tests exercise the event path.
function makeTwoWindowSetup() {
  const bus = createBus(seedSnapshot())
  const layout = (): WorkspaceWindowState[] => [
    windowState('A', ['wsA1', 'wsA2'], 'wsA1'),
    windowState('B', ['wsB1'], 'wsB1'),
  ]
  const storeA = createFakeStore(layout(), 'wsA1')
  const storeB = createFakeStore(layout(), 'wsB1')
  const clientA = createWorkspaceSyncClient(storeDeps(storeA, 'A', bus.makeApi('A')))
  const clientB = createWorkspaceSyncClient(storeDeps(storeB, 'B', bus.makeApi('B')))
  const stopA = clientA.start()
  const stopB = clientB.start()
  return {
    bus,
    storeA,
    storeB,
    clientA,
    clientB,
    stop: (): void => {
      stopA()
      stopB()
    },
  }
}

// AC1/AC3: a move dispatched in window A transfers one-window membership; the
// destination window focuses the moved workspace, and only the renderer that
// owns the destination adopts it as its global active selection.
async function moveTransfersMembershipAcrossWindows(): Promise<void> {
  const { storeA, storeB, clientA, stop } = makeTwoWindowSetup()
  await flush()

  await clientA.dispatchMoveWorkspaceToWindow('wsA2', 'A', 'B', true)
  await flush()

  assert.deepEqual(storeA.windowWorkspaceIds('A'), ['wsA1'], 'source window loses the moved workspace')
  assert.deepEqual(storeA.windowWorkspaceIds('B'), ['wsB1', 'wsA2'], 'target window gains the moved workspace')
  assert.deepEqual(storeB.windowWorkspaceIds('A'), ['wsA1'], 'the other window mirrors the source membership')
  assert.deepEqual(storeB.windowWorkspaceIds('B'), ['wsB1', 'wsA2'], 'the other window mirrors the target membership')
  assert.equal(storeA.windowActive('B'), 'wsA2', 'the destination window focuses the moved workspace')
  assert.equal(storeB.windowActive('B'), 'wsA2')
  assert.equal(storeB.state.activeWorkspaceId, 'wsA2', 'the window that now owns the moved workspace adopts it as global active')
  assert.equal(storeA.state.activeWorkspaceId, 'wsA1', 'a move into another window does not flip this renderer global active')

  stop()
  console.log('workspaceSyncClient.test.ts: move transfers one-window membership — ok')
}

// AC3: moving a window's active workspace deterministically falls the source
// window's active back to its remaining workspace, mirrored in both stores.
async function moveActiveWorkspaceFallsBackSourceActive(): Promise<void> {
  const { storeA, storeB, clientA, stop } = makeTwoWindowSetup()
  await flush()

  await clientA.dispatchMoveWorkspaceToWindow('wsA1', 'A', 'B', true)
  await flush()

  assert.deepEqual(storeA.windowWorkspaceIds('A'), ['wsA2'])
  assert.equal(storeA.windowActive('A'), 'wsA2', "source window's active falls back to its remaining workspace")
  assert.equal(storeB.windowActive('A'), 'wsA2', 'the fallback is mirrored in the other window routing record')
  assert.equal(storeB.windowActive('B'), 'wsA1', 'the destination focuses the moved workspace')

  stop()
  console.log('workspaceSyncClient.test.ts: moving the active workspace falls back deterministically — ok')
}

// AC5: a detached-window close routes every closing-window workspace to the
// fallback window in both renderers and drops the closed window. Closing a
// foreign window must not flip the fallback window's active workspace.
async function closeRoutesWorkspacesToFallback(): Promise<void> {
  const { storeA, storeB, clientB, stop } = makeTwoWindowSetup()
  await flush()

  await clientB.dispatchCloseWorkspaceWindow('B', 'A')
  await flush()

  assert.equal(storeA.hasWindow('B'), false, 'the closed window is dropped in the fallback renderer')
  assert.equal(storeB.hasWindow('B'), false, 'the closed window is dropped in its own renderer')
  assert.deepEqual(storeA.windowWorkspaceIds('A'), ['wsA1', 'wsA2', 'wsB1'], 'closing-window workspaces route to the fallback window')
  assert.deepEqual(storeB.windowWorkspaceIds('A'), ['wsA1', 'wsA2', 'wsB1'])
  assert.equal(storeA.windowActive('A'), 'wsA1', 'closing a foreign window does not flip the fallback window active')

  stop()
  console.log('workspaceSyncClient.test.ts: detached-window close routes to fallback — ok')
}

// AC4: a placement update broadcasts the target window's placement fields to
// other renderers without rewriting workspace membership.
async function placementUpdatesPropagateWithoutTouchingMembership(): Promise<void> {
  const { storeA, storeB, clientB, stop } = makeTwoWindowSetup()
  await flush()

  const bounds = { x: 10, y: 20, width: 1024, height: 768 }
  await clientB.dispatchUpdatePlacement({ windowId: 'B', bounds, isMaximized: false, displayId: 2 })
  await flush()

  assert.deepEqual(storeA.windowBounds('B'), bounds, "window A records window B's placement from the broadcast")
  assert.deepEqual(storeB.windowBounds('B'), bounds)
  assert.deepEqual(storeA.windowWorkspaceIds('A'), ['wsA1', 'wsA2'], 'placement updates do not touch workspace membership')
  assert.deepEqual(storeA.windowWorkspaceIds('B'), ['wsB1'])

  stop()
  console.log('workspaceSyncClient.test.ts: placement updates propagate without touching membership — ok')
}

// AC2/AC3: simultaneous creations from two windows are sequenced by main and
// preserve both workspaces, each assigned to its target window with a stable
// per-window active, and only the creating renderer adopts its own creation as
// its global active selection.
async function simultaneousCreationsPreserveBothWorkspaces(): Promise<void> {
  const { storeA, storeB, clientA, clientB, stop } = makeTwoWindowSetup()
  await flush()

  await clientA.dispatchCreateWorkspace(workspace('wsA-new'), 'A', null)
  await clientB.dispatchCreateWorkspace(workspace('wsB-new'), 'B', null)
  await flush()

  for (const [label, store] of [['A', storeA], ['B', storeB]] as const) {
    assert.ok(store.windowWorkspaceIds('A')?.includes('wsA-new'), `store ${label} assigns wsA-new to window A`)
    assert.ok(store.windowWorkspaceIds('B')?.includes('wsB-new'), `store ${label} assigns wsB-new to window B`)
    assert.equal(store.windowWorkspaceIds('A')?.[0], 'wsA-new', `store ${label} inserts wsA-new at window A head`)
    assert.equal(store.windowWorkspaceIds('B')?.[0], 'wsB-new', `store ${label} inserts wsB-new at window B head`)
    assert.equal(store.windowActive('A'), 'wsA-new', `store ${label} focuses wsA-new in window A`)
    assert.equal(store.windowActive('B'), 'wsB-new', `store ${label} focuses wsB-new in window B`)
  }
  assert.equal(storeA.state.activeWorkspaceId, 'wsA-new', 'window A adopts its own creation as global active')
  assert.equal(storeB.state.activeWorkspaceId, 'wsB-new', 'window B adopts its own creation as global active, not the foreign one')

  stop()
  console.log('workspaceSyncClient.test.ts: simultaneous creations preserve both workspaces — ok')
}

// T6: terminal metadata events are scoped to the source window's workspaces.
// A foreign window cannot assign or clear another window's agent session.
async function terminalMetadataEventsRespectWorkspaceOwnership(): Promise<void> {
  const { storeA, storeB, clientA, clientB, stop } = makeTwoWindowSetup()
  await flush()

  await clientA.dispatchAssignTerminalSession('wsA1', 'agent-one', 'session-a', 'codex')
  await flush()

  assert.equal(storeA.agent('wsA1', 'agent-one')?.cliSessionId, 'session-a')
  assert.equal(storeB.agent('wsA1', 'agent-one')?.cliSessionId, 'session-a')

  await clientB.dispatchAssignTerminalSession('wsA1', 'agent-one', 'session-from-wrong-window', 'claude-code')
  await clientB.dispatchUpdateTerminalLaunchState('wsA1', 'agent-one', {
    cliSessionId: null,
    cliStartRequested: false,
    cliHasLaunched: false,
  })
  await flush()

  assert.equal(
    storeA.agent('wsA1', 'agent-one')?.cliSessionId,
    'session-a',
    'foreign terminal events cannot overwrite the owning window metadata'
  )
  assert.equal(storeB.agent('wsA1', 'agent-one')?.cliSessionId, 'session-a')

  await clientA.dispatchUpdateTerminalLaunchState('wsA1', 'agent-one', {
    cliSessionId: null,
    cliStartRequested: false,
    cliHasLaunched: false,
    cliOnboardingPromptSent: false,
    cliResumeAvailable: false,
  })
  await flush()

  assert.equal(storeA.agent('wsA1', 'agent-one')?.cliSessionId, undefined)
  assert.equal(storeB.agent('wsA1', 'agent-one')?.cliSessionId, undefined)
  assert.equal(storeB.agent('wsA1', 'agent-one')?.cliStartRequested, false)

  stop()
  console.log('workspaceSyncClient.test.ts: terminal metadata events respect workspace ownership — ok')
}


// A snapshot fetch is asynchronous, so a broadcast can land and advance the
// baseline while it is in flight. Adopting the older snapshot afterwards would
// silently undo the event that beat it — the mirror would show main's state
// from before the change it just applied. Regression guard for that ordering.
async function aStaleSnapshotNeverClobbersANewerAppliedEvent(): Promise<void> {
  const adopted: number[] = []
  const applied: WorkspaceActiveChangedApply[] = []
  const listenerRef: { emit?: (event: WorkspaceSyncEvent) => void } = {}
  let releaseSnapshot: (() => void) | undefined
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve })

  const api: WorkspaceSyncClientApi = {
    workspaceSyncDispatch: () => Promise.resolve({ ok: false, reason: 'unused', message: 'unused' }),
    // Held open until the test has delivered a newer event.
    workspaceSyncGetSnapshot: async () => {
      await snapshotGate
      // Sequence 0: main's state from BEFORE the event that already applied.
      return { sequence: 0, state: seedSnapshot().state }
    },
    workspaceSyncGetEventsAfter: () => Promise.resolve([]),
    onWorkspaceSyncEvent: (cb) => {
      listenerRef.emit = cb
      return () => { listenerRef.emit = undefined }
    },
  }
  const client = createWorkspaceSyncClient(stubDeps({
    getApi: () => api,
    getWindowId: () => 'A',
    applyActiveChanged: (apply) => applied.push(apply),
    applyRegistrySnapshot: (snapshot) => adopted.push(snapshot.sequence),
  }))
  const stop = client.start()

  // Event 1 arrives and applies while the snapshot request is still open.
  assert.ok(listenerRef.emit)
  listenerRef.emit({
    id: 'workspace-sync-1',
    type: 'workspace_window.active_changed',
    sourceWindowId: 'A',
    sequence: 1,
    createdAt: 11,
    payload: { windowId: 'A', workspaceId: 'wsA2' },
  })
  await flush()
  assert.equal(applied.length, 1, 'the broadcast applied while the snapshot was in flight')

  releaseSnapshot?.()
  await flush()

  assert.deepEqual(adopted, [], 'a snapshot older than the applied sequence is not adopted over it')
  stop()
  client.reset()
  console.log('workspaceSyncClient.test.ts: a stale snapshot never clobbers a newer applied event — ok')
}

async function main(): Promise<void> {
  await twoWindowSelectionDoesNotFlipOther()
  await ignoresDuplicateAndStaleEvents()
  await recoversSequenceGapThroughReplay()
  await incompleteReplayFallsBackToSnapshotBaseline()
  await replayFailureFallsBackToSnapshotBaseline()
  await rejectedDispatchLogsOnce()
  await unavailableApiIsSafe()
  await startCleansUpAndResets()
  await moveTransfersMembershipAcrossWindows()
  await moveActiveWorkspaceFallsBackSourceActive()
  await closeRoutesWorkspacesToFallback()
  await placementUpdatesPropagateWithoutTouchingMembership()
  await simultaneousCreationsPreserveBothWorkspaces()
  await terminalMetadataEventsRespectWorkspaceOwnership()
  await aStaleSnapshotNeverClobbersANewerAppliedEvent()
  console.log('workspaceSyncClient.test.ts: ok')
}

void main()
