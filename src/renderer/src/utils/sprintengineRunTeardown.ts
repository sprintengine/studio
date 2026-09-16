/**
 * Completion teardown for a Sprint Engine run.
 *
 * When every task is done, the run's agent panels are removed entirely — the
 * board and run summary stay, but the (now-idle) terminal tabs do not linger and
 * cannot respawn into a removed worktree. Before removing a panel, the agent's
 * live CLI session is recorded into the durable `sprintEngineRosterSessions`
 * map so the board can later re-open that role and resume its exact conversation
 * (see `useSprintEngineBoardTerminalActions.spawnAgent`).
 *
 * This runs from the projection-refresh reconcile (which polls every sprint
 * workspace, including on reopen), so it is the single owner of completion
 * teardown regardless of automation mode.
 */

import { useWorkspaceStore } from '../store/workspaceStore'
import { removeAgentTab, removeAgentTabFromLayoutModel } from './modelRegistry'
import { publishDiagnostic } from './diagnostics'
import { logPerfEvent } from './perfDiagnostics'
import type { IJsonModel } from 'flexlayout-react'
import type {
  AgentId,
  AgentState,
  SprintEngineRosterSession,
  SprintEngineState,
  Workspace,
  WorkspaceId,
} from '../types/workspace'
import { sprintEngineRunContext, sprintEngineRunState } from '../store/slices/workspaceModuleState'

/** Roster agent ids whose panels the completion teardown should remove. */
export function selectSprintEngineTeardownAgentIds(
  agents: Record<string, AgentState>,
): AgentId[] {
  return Object.entries(agents)
    .filter(([, agent]) => agent.kind === 'sprintengine')
    .map(([id]) => id)
}

/**
 * Capture an agent's resumable session, or null when it never launched a CLI
 * session (nothing to resume). `role` comes from the run roster; the live
 * session's `cliSessionId` (the harness resume id, learned post-launch) is
 * preferred as the harness token when the agent's own copy has not caught up.
 */
export function buildRosterSessionFromAgent(
  agent: AgentState,
  role: SprintEngineState['sprintEngineAgents'][string]['role'] | undefined,
  liveHarnessSessionId: string | undefined,
  now: number,
): SprintEngineRosterSession | null {
  if (!agent.cli || !agent.cliSessionId) return null
  return {
    role,
    cli: agent.cli,
    cliSessionId: agent.cliSessionId,
    harnessSessionId: agent.harnessSessionId ?? liveHarnessSessionId,
    cliModel: agent.cliModel,
    // Only carried when the seat actually ran with a level, so a seat on the
    // CLI's own effort records exactly the session it recorded before.
    ...(agent.cliReasoning ? { cliReasoning: agent.cliReasoning } : {}),
    name: agent.name,
    recordedAt: now,
  }
}

export type SprintEngineRunTeardownPorts = {
  terminalList(): Promise<TerminalSessionSnapshot[]>
  terminalKill(sessionId: string): Promise<void>
  getWorkspace(workspaceId: WorkspaceId): Workspace | undefined
  upsertRosterSession(workspaceId: WorkspaceId, agentId: AgentId, session: SprintEngineRosterSession): void
  removeAgent(workspaceId: WorkspaceId, agentId: AgentId): void
  /** Remove the agent's tab from the live layout Model. Returns true if a live
   * model was mounted and a tab was removed (false when the workspace is not
   * currently mounted — the caller then strips the persisted layout instead). */
  removeAgentTab(workspaceId: WorkspaceId, agentId: AgentId): boolean
  /** Persisted-layout fallback for unmounted workspaces. */
  updateLayout(workspaceId: WorkspaceId, model: IJsonModel): void
  publishDiagnostic(input: Parameters<typeof publishDiagnostic>[0]): Promise<unknown> | unknown
  now(): number
}

/**
 * Ports for applying a MAIN-scheduler retirement op (`worker_retired`): the
 * scheduler already recorded (and broadcast) the roster session, so the
 * renderer applier must not re-record — exactly one writer owns the record.
 * Everything else (tab/agent removal, idempotent kill) applies normally.
 */
export function departedWorkerTeardownPortsWithoutRecord(): SprintEngineRunTeardownPorts {
  return { ...defaultPorts(), upsertRosterSession: () => undefined }
}

function defaultPorts(): SprintEngineRunTeardownPorts {
  return {
    terminalList: () => window.api.terminalList(),
    terminalKill: (sessionId) => window.api.terminalKill(sessionId),
    getWorkspace: (workspaceId) =>
      useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId),
    upsertRosterSession: (workspaceId, agentId, session) =>
      useWorkspaceStore.getState().upsertSprintEngineRosterSession(workspaceId, agentId, session),
    removeAgent: (workspaceId, agentId) => useWorkspaceStore.getState().removeAgent(workspaceId, agentId),
    removeAgentTab: (workspaceId, agentId) => removeAgentTab(workspaceId, agentId),
    updateLayout: (workspaceId, model) => useWorkspaceStore.getState().updateLayout(workspaceId, model),
    publishDiagnostic: (input) => publishDiagnostic(input),
    now: () => Date.now(),
  }
}

export type SprintEngineRunTeardownResult = {
  removedAgentIds: AgentId[]
  recordedAgentIds: AgentId[]
  closedSessionIds: string[]
}

/**
 * Record + remove every sprint agent panel for a completed run. Idempotent: with
 * no sprint agents left it is a no-op, so it is safe to call on every poll.
 * Panel removal is the priority — a terminal-list IPC failure still removes the
 * panels (the missing-worktree spawn guard covers any orphaned live process).
 */
export async function tearDownCompletedSprintRunAgents(
  workspaceId: WorkspaceId,
  ports: SprintEngineRunTeardownPorts = defaultPorts(),
): Promise<SprintEngineRunTeardownResult> {
  const empty: SprintEngineRunTeardownResult = { removedAgentIds: [], recordedAgentIds: [], closedSessionIds: [] }
  const workspace = ports.getWorkspace(workspaceId)
  if (!workspace) return empty

  const agentIds = selectSprintEngineTeardownAgentIds(workspace.agents)
  if (agentIds.length === 0) return empty

  const statePath = sprintEngineRunContext(workspace)?.statePath
  let sessions: TerminalSessionSnapshot[] = []
  try {
    sessions = await ports.terminalList()
  } catch {
    // Fall through: still remove the panels even if we cannot enumerate PTYs.
    sessions = []
  }

  const liveByAgentId = buildLiveSprintSessionsByAgentId(sessions, workspaceId, statePath)
  const now = ports.now()
  const result: SprintEngineRunTeardownResult = { removedAgentIds: [], recordedAgentIds: [], closedSessionIds: [] }
  // Agents whose tab was not removed from a live Model (workspace unmounted) —
  // their tabs are stripped from the persisted layout below so a later open
  // does not render an orphan panel for a removed agent.
  const orphanTabAgentIds: AgentId[] = []
  // Tabs actually removed (live Model or persisted layout). Gates the user-facing
  // diagnostic: tearing down tab-less recreated roster records (a reopened run
  // whose panels were already removed) closes nothing the user can see.
  let removedTabCount = 0

  for (const agentId of agentIds) {
    const { removedLiveTab } = await recordAndRemoveSprintAgent(
      { workspace, liveByAgentId, now, ports, result, orphanTabAgentIds },
      agentId,
    )
    if (removedLiveTab) removedTabCount += 1
  }

  removedTabCount += flushOrphanTabsFromPersistedLayout(workspaceId, orphanTabAgentIds, ports)

  logPerfEvent('SprintEngineRunTeardown', 'completed-run-panels-removed', {
    workspaceId,
    workspaceName: workspace.name,
    removedAgentIds: result.removedAgentIds,
    recordedAgentIds: result.recordedAgentIds,
    closedSessionIds: result.closedSessionIds,
  })

  // Only toast when the user could see an effect (a killed session or a closed
  // tab). Tearing down tab-less recreated roster records — a reopened run whose
  // panels were already removed — must stay silent.
  //
  // Deliberately NO `dispatchUpdateTerminalLaunchState` mirror here: the sync
  // bus applies the accepted event back into the dispatching window's own store,
  // and `applyAgentTerminalLaunchStateEvent` used to upsert — so a launch-state
  // reset issued AFTER `removeAgent` materialized the just-removed agent again
  // as a ghost record. Removal itself is the reset: any later roster recreation
  // starts from clean defaults.
  if (result.closedSessionIds.length > 0 || removedTabCount > 0) {
    void ports.publishDiagnostic({
      level: 'info',
      source: 'sprintengine',
      title: 'Sprint complete — agent terminals closed',
      message: `All tasks are done, so ${
        result.removedAgentIds.length === 1
          ? 'the remaining agent panel was'
          : `${result.removedAgentIds.length} agent panels were`
      } closed. The sprint board and run summary stay available; re-open a role from the board to resume it.`,
      details: [
        `Workspace: ${workspace.name}`,
        `Closed panels: ${result.removedAgentIds.join(', ')}`,
        result.closedSessionIds.length > 0 ? `Killed sessions: ${result.closedSessionIds.join(', ')}` : null,
      ].filter(Boolean).join('\n'),
      workspaceId,
      workspaceName: workspace.name,
    })
  }

  return result
}

export type SprintEngineDepartedWorkerTeardownResult = {
  recorded: boolean
  removedAgent: boolean
  /** A tab was removed from a live Model or the persisted layout (i.e. a panel
   * the user could see went away). Gates the caller's user-facing toast. */
  removedTab: boolean
  closedSessionId: string | null
}

/**
 * Mid-run teardown of a single departed task-scoped worker (MC-1444 B4).
 *
 * Under per-task roster ids a worker becomes permanently departed the moment
 * its owned task is terminal (`done`): new tasks always go to fresh sessions,
 * so its terminal has nothing left to return for. The kill-only task-scoped
 * retirement left the panel behind, and a mounted `TerminalView` respawned the
 * PTY off `cliStartRequested` before the reaper's next tick — an idle
 * reap ↔ auto-respawn ping-pong that also lost the resume token.
 *
 * This applies the same record + remove flow as `tearDownCompletedSprintRun-
 * Agents`, scoped to one worker: record the resumable session into
 * `sprintEngineRosterSessions`, dispose the live/suspended PTY, then
 * `removeAgentTab` + `removeAgent`. Removing the panel unmounts its
 * `TerminalView` (nothing left to respawn); the roster record recreated by the
 * next projection read is tab-less with cleared launch flags. Re-opening the
 * role from its group resumes the recorded conversation.
 *
 * Idempotent: a worker with no live session and no tab (an already-torn-down,
 * recreated roster record) records nothing and closes nothing, so the caller
 * suppresses the toast. `preloadedSessions` reuses the executor's shared
 * terminal-list snapshot; omit it to have the teardown enumerate PTYs itself.
 */
export async function tearDownDepartedTaskScopedWorker(
  workspaceId: WorkspaceId,
  agentId: AgentId,
  ports: SprintEngineRunTeardownPorts = defaultPorts(),
  preloadedSessions?: TerminalSessionSnapshot[],
): Promise<SprintEngineDepartedWorkerTeardownResult> {
  const miss: SprintEngineDepartedWorkerTeardownResult = {
    recorded: false,
    removedAgent: false,
    removedTab: false,
    closedSessionId: null,
  }
  const workspace = ports.getWorkspace(workspaceId)
  const agent = workspace?.agents[agentId]
  if (!workspace || !agent || agent.kind !== 'sprintengine') return miss

  const statePath = sprintEngineRunContext(workspace)?.statePath
  let sessions = preloadedSessions
  if (!sessions) {
    try {
      sessions = await ports.terminalList()
    } catch {
      // Fall through: still remove the panel even if we cannot enumerate PTYs.
      sessions = []
    }
  }
  const liveByAgentId = buildLiveSprintSessionsByAgentId(sessions, workspaceId, statePath)

  const now = ports.now()
  const result: SprintEngineRunTeardownResult = { removedAgentIds: [], recordedAgentIds: [], closedSessionIds: [] }
  const orphanTabAgentIds: AgentId[] = []
  const { removedLiveTab } = await recordAndRemoveSprintAgent(
    { workspace, liveByAgentId, now, ports, result, orphanTabAgentIds },
    agentId,
  )
  const persistedTabsRemoved = flushOrphanTabsFromPersistedLayout(workspaceId, orphanTabAgentIds, ports)

  logPerfEvent('SprintEngineRunTeardown', 'departed-worker-panel-removed', {
    workspaceId,
    workspaceName: workspace.name,
    agentId,
    recorded: result.recordedAgentIds.length > 0,
    closedSessionIds: result.closedSessionIds,
  })

  return {
    recorded: result.recordedAgentIds.length > 0,
    removedAgent: result.removedAgentIds.length > 0,
    removedTab: removedLiveTab || persistedTabsRemoved > 0,
    closedSessionId: result.closedSessionIds[0] ?? null,
  }
}

/**
 * Sessions to record + dispose, keyed by agent id. Suspended sessions count
 * too: the idle reaper suspends exactly the idle end-of-run agents teardown
 * targets (`processAlive` is false while suspended, but the session record —
 * and its persisted snapshot sidecar — lives on and would otherwise be orphaned
 * by the panel removal; `terminalKill` disposes both). Their captured harness
 * id is also the codex resume token we want to record.
 */
function buildLiveSprintSessionsByAgentId(
  sessions: TerminalSessionSnapshot[],
  workspaceId: WorkspaceId,
  statePath: string | undefined,
): Map<string, TerminalSessionSnapshot> {
  const liveByAgentId = new Map<string, TerminalSessionSnapshot>()
  for (const session of sessions) {
    if (
      session.kind === 'agent'
      && (session.processAlive || session.suspended)
      && session.workspaceId === workspaceId
      && session.agentId
      && (!statePath || session.sprintEngineStatePath === statePath)
    ) {
      liveByAgentId.set(session.agentId, session)
    }
  }
  return liveByAgentId
}

/**
 * The record + remove core shared by run-completion and mid-run departed-worker
 * teardown: (1) record the resumable session BEFORE anything clears it, (2)
 * dispose the live/suspended PTY, (3) remove the panel (live Model when mounted;
 * else queued into `orphanTabAgentIds` for the persisted-layout pass) and the
 * agent from the store. Returns whether a live-Model tab was removed.
 */
async function recordAndRemoveSprintAgent(
  ctx: {
    workspace: Workspace
    liveByAgentId: Map<string, TerminalSessionSnapshot>
    now: number
    ports: SprintEngineRunTeardownPorts
    result: SprintEngineRunTeardownResult
    orphanTabAgentIds: AgentId[]
  },
  agentId: AgentId,
): Promise<{ removedLiveTab: boolean }> {
  const { workspace, ports, result } = ctx
  const agent = workspace.agents[agentId]
  if (!agent) return { removedLiveTab: false }
  const role = sprintEngineRunState(workspace)?.sprintEngineAgents?.[agentId]?.role
  const live = ctx.liveByAgentId.get(agentId)

  const rosterSession = buildRosterSessionFromAgent(agent, role, live?.cliSessionId, ctx.now)
  if (rosterSession) {
    ports.upsertRosterSession(workspace.id, agentId, rosterSession)
    result.recordedAgentIds.push(agentId)
  }

  if (live) {
    await ports.terminalKill(live.sessionId).catch(() => {})
    result.closedSessionIds.push(live.sessionId)
  }

  let removedLiveTab = false
  if (ports.removeAgentTab(workspace.id, agentId)) removedLiveTab = true
  else ctx.orphanTabAgentIds.push(agentId)
  ports.removeAgent(workspace.id, agentId)
  result.removedAgentIds.push(agentId)
  return { removedLiveTab }
}

/**
 * Strip any tabs that were not removed from a live Model directly from the
 * persisted `layoutModel`, in one pass. Re-reads the layout fresh: a live
 * `removeAgentTab` syncs the layoutModel synchronously via onModelChange, so a
 * stale snapshot would re-introduce a just-removed tab. Returns the count of
 * tabs stripped; a no-op when nothing matched.
 */
function flushOrphanTabsFromPersistedLayout(
  workspaceId: WorkspaceId,
  orphanTabAgentIds: AgentId[],
  ports: SprintEngineRunTeardownPorts,
): number {
  if (orphanTabAgentIds.length === 0) return 0
  const baseLayout = ports.getWorkspace(workspaceId)?.layoutModel
  if (!baseLayout) return 0
  let layoutModel: IJsonModel = baseLayout
  let changed = false
  let removed = 0
  for (const agentId of orphanTabAgentIds) {
    const stripped = removeAgentTabFromLayoutModel(layoutModel, agentId)
    if (stripped.removed) {
      layoutModel = stripped.layoutModel
      changed = true
      removed += 1
    }
  }
  if (changed) ports.updateLayout(workspaceId, layoutModel)
  return removed
}
