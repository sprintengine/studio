/**
 * SprintRuntime — the main-process owner of sprint auto-run scheduling
 * (sprint-runtime-ownership Phase 2).
 *
 * The decision loop that used to live in the renderer supervisor now runs
 * here, driving the exact same shared cycle (`src/shared/sprintengine/
 * auto-run-cycle.ts`) through main-process ports: terminal spawns call the
 * terminal runtime in-process, projections read straight off disk,
 * diagnostics go to the daily JSONL, and the automation mode comes from the
 * main-owned intent sidecar (Phase 1). Because main's timers are never
 * occlusion-throttled, a locked screen no longer stalls run progression.
 *
 * The renderer stays the display owner: every store mutation the cycle
 * performs against main's run view is mirrored to all windows as a
 * `sprintengine:runtime-op` broadcast, applied by the renderer bridge
 * (`sprintengineRuntimeBridge.ts`). The renderer registers each sprint
 * workspace's context (identity, run settings, persisted runtime residue)
 * since main cannot read renderer localStorage; renderer-originated lifecycle
 * stops (terminal closed, workspace removed) are pushed here so the scheduler
 * pauses in step with the UI.
 *
 * Phase 2 scope: the window must still be open to HOST terminal views (and to
 * provide a WebContents event sink for spawns); Phase 3 removes that.
 */
import { basename, dirname } from 'path'
import { randomUUID } from 'crypto'
import type {
  DiagnosticLogEntry,
  DiagnosticLogInput,
  MemoryRootStatus,
  SprintEngineArtifactCommandResult,
  SprintEngineProjectionReadResult,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import type { AgentState } from '../shared/sprintengine/agent-state'
import type {
  SprintEngineRosterSession,
  SprintEngineState,
  SprintEngineWorkspaceView,
} from '../shared/sprintengine/run-types'
import type {
  SprintEngineAutoState,
  SprintEngineAutomationEvent,
} from '../shared/sprintengine/automation-types'
import {
  sprintEngineAutomationShouldRun,
  transitionSprintEngineAutomation,
} from '../shared/sprintengine/automation-lifecycle'
import type { SprintEngineAutomationIntentRecord } from '../shared/sprintengine/automation-intent'
import {
  buildSprintEngineAgentRosterForState,
  normalizeSprintEngineProjection,
  resolveSprintEngineAgentRuntime,
} from '../shared/sprintengine/state'
import {
  createSprintEngineAutoRunCycleState,
  reconcileWorkspaceSessions,
  superviseWorkspace,
  type ArchitectTriageMessage,
  type SprintEngineAutoRunCyclePorts,
  type SprintEngineAutoRunCycleState,
  type SprintEngineAutoRunDepartedWorkerTeardown,
  type SprintEngineAutoRunProjectionRefreshResult,
} from '../shared/sprintengine/auto-run-cycle'
import type { RoleContinuationGrace, SprintEngineDispatchAttempt } from '../shared/sprintengine/auto-run'
import type { TerminalSpawnArgs } from '../shared/sprintengine/auto-run-executor'
import type { SprintEngineLaunchSettings } from '../shared/sprintengine/launch-settings'
import type {
  SprintRuntimeOp,
  SprintRuntimeRunRegistration,
  SprintRuntimeStopReasonPush,
} from '../shared/sprintengine/runtime-bridge'
import type { SprintPowerManager } from './sprint-power-manager'

// Match the renderer supervisor's historical cadence: active runs tick every
// 4s; the first 10s after runtime start reconciles only (no spawning), so an
// app relaunch never races projection hydration into duplicate spawns.
const SPRINT_RUNTIME_TICK_MS = 4000
const SPRINT_RUNTIME_STARTUP_SPAWN_DELAY_MS = 10_000

type MutableRef<T> = { current: T }

type RunEntry = {
  statePath: string
  workspaceName: string
  view: SprintEngineWorkspaceView & { name: string; folderPath: string }
  rosterSessions: Record<string, SprintEngineRosterSession>
  cycleState: SprintEngineAutoRunCycleState
  refs: {
    inFlightSpawns: MutableRef<Set<string>>
    sentArtifactApprovalMessages: MutableRef<Map<string, number>>
    autoApprovalDiagnostics: MutableRef<Map<string, number>>
    sentContinuationMessages: MutableRef<Map<string, SprintEngineDispatchAttempt>>
    sentDispatchMessages: MutableRef<Map<string, SprintEngineDispatchAttempt>>
    sentArchitectTriageMessages: MutableRef<Map<string, ArchitectTriageMessage>>
    sentAgentNotificationEvents: MutableRef<Set<string>>
    continuationGraceByTask: MutableRef<Map<string, RoleContinuationGrace>>
    projectionTokensByWorkspace: MutableRef<Map<string, string>>
    idleClockByAgent: MutableRef<Map<string, number>>
    retirementCooldownByAgent: MutableRef<Map<string, number>>
  }
}

export type SprintRuntimeDeps = {
  terminal: {
    list(): TerminalSessionSnapshot[]
    write(sessionId: string, data: string): void
    kill(sessionId: string): void
    status(sessionId: string): Promise<{ processAlive: boolean }>
    /** In-process spawn; fails cleanly when no window can host the terminal view (Phase 2 limit). */
    spawn(args: TerminalSpawnArgs): Promise<TerminalSpawnResult>
  }
  artifacts: {
    readProjection(input: { statePath: string; knownToken?: string }): Promise<SprintEngineProjectionReadResult>
    autoApproveArtifact(input: { statePath: string; artifactId: string }): Promise<SprintEngineArtifactCommandResult>
    replenishRoster(input: { statePath: string }): Promise<SprintEngineArtifactCommandResult>
  }
  pathExists(path: string): Promise<boolean>
  resolveMemoryRoot(workspaceRoot: string | null, relativeRoot: string | null): Promise<MemoryRootStatus>
  getPluginCatalogEntries(): readonly PluginRegistryListEntry[]
  getLaunchSettings(): SprintEngineLaunchSettings
  readAutomationMode(statePath: string): Promise<SprintEngineAutomationIntentRecord | null>
  powerManager: Pick<SprintPowerManager, 'markRunActive' | 'markRunInactive' | 'shutdown'>
  broadcastOp(op: SprintRuntimeOp): void
  logDiagnostic(input: DiagnosticLogInput): Promise<DiagnosticLogEntry | void> | void
  now?(): number
  timers?: {
    setInterval(handler: () => void, ms: number): unknown
    clearInterval(handle: unknown): void
  }
}

export type SprintRuntime = ReturnType<typeof createSprintRuntime>

function synthesizeAgent(id: string, name: string): AgentState {
  return {
    id,
    name,
    status: 'idle',
    execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
    kind: 'sprintengine',
  }
}

/**
 * The main-side equivalent of the renderer's roster reconcile: every roster
 * seat has an agent record with its role runtime resolved, existing records
 * keep their launch flags/resume state. Names default to roster labels (the
 * renderer's friendly-name picking is a display concern that stays there).
 */
function reconcileViewAgents(view: RunEntry['view'], state: SprintEngineState | null): void {
  if (!state) return
  const next: Record<string, AgentState> = {}
  for (const rosterAgent of buildSprintEngineAgentRosterForState(state)) {
    const current = view.agents[rosterAgent.id]
    const resolved = resolveSprintEngineAgentRuntime(state.roleRuntimes, rosterAgent.role, current)
    const base = current ?? synthesizeAgent(rosterAgent.id, rosterAgent.label)
    next[rosterAgent.id] = {
      ...base,
      cli: resolved.cli ?? base.cli,
      ...(resolved.cliModel !== undefined ? { cliModel: resolved.cliModel } : {}),
    }
  }
  // Keep records for agents that carry live launch state but fell off the
  // roster snapshot (projection lag must not drop an in-flight spawn's flags).
  for (const [agentId, agent] of Object.entries(view.agents)) {
    if (!next[agentId] && (agent.cliStartRequested || agent.cliSessionId)) next[agentId] = agent
  }
  view.agents = next
}

export function createSprintRuntime(deps: SprintRuntimeDeps) {
  const now = deps.now ?? (() => Date.now())
  const timers = deps.timers ?? {
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  }

  const runsByStatePath = new Map<string, RunEntry>()
  const runsByWorkspaceId = new Map<string, RunEntry>()
  const startedAt = now()
  let tickHandle: unknown = null
  let tickInProgress = false
  let disposed = false

  function entryForWorkspaceId(workspaceId: string): RunEntry | undefined {
    return runsByWorkspaceId.get(workspaceId)
  }

  function applyAutomationEventToView(entry: RunEntry, event: SprintEngineAutomationEvent): void {
    entry.view.sprintEngineAutoState = transitionSprintEngineAutomation(
      currentAutoState(entry),
      event,
      now(),
    )
    reconcilePower(entry)
  }

  function currentAutoState(entry: RunEntry): SprintEngineAutoState {
    return entry.view.sprintEngineAutoState ?? {
      desiredMode: 'manual',
      runtimeState: 'idle',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    }
  }

  function reconcilePower(entry: RunEntry): void {
    if (sprintEngineAutomationShouldRun(entry.view.sprintEngineAutoState)) {
      deps.powerManager.markRunActive(entry.statePath)
    } else {
      deps.powerManager.markRunInactive(entry.statePath)
    }
  }

  // The renderer supervisor's stop-reason vocabulary, applied to main's view.
  // Mirrors `applySprintEngineAutomationStopReason` (the renderer util) minus
  // the store: the same reducer, the same reasons, no audit here (the renderer
  // window audits lifecycle transitions for display; headless audit parity is
  // Phase 3's completion-teardown work).
  function automationEventForStopReason(
    reason: SprintRuntimeStopReasonPush['reason'],
    context?: SprintRuntimeStopReasonPush['context'],
  ): SprintEngineAutomationEvent | null {
    switch (reason) {
      case 'user_manual_toggle':
        // Mode intent changes route through the Phase 1 automation service and
        // arrive via notifyAutomationChanged, never through stop reasons.
        return null
      case 'blocked_on_external_input':
        return {
          type: 'runner_blocked',
          message: context?.message ?? 'The run is blocked on user input.',
          taskId: context?.taskId,
          agentId: context?.agentId,
        }
      case 'all_tasks_done':
        return { type: 'runner_complete', message: context?.message }
      case 'agent_terminal_closed':
        return {
          type: 'runner_paused',
          reason: 'terminal_closed',
          message: context?.message ?? 'An agent terminal was closed.',
          taskId: context?.taskId,
          agentId: context?.agentId,
        }
      case 'workspace_removed':
        return {
          type: 'runner_paused',
          reason: 'workspace_removed',
          message: context?.message ?? 'The workspace was removed.',
        }
      case 'folder_missing':
        return {
          type: 'runner_failed',
          reason: 'folder_missing',
          message: context?.message ?? 'The workspace folder is missing.',
          taskId: context?.taskId,
          agentId: context?.agentId,
        }
      case 'agent_spawn_failed':
        return {
          type: 'runner_failed',
          reason: 'spawn_failed',
          message: context?.message ?? 'An agent could not be started.',
          taskId: context?.taskId,
          agentId: context?.agentId,
        }
    }
  }

  // Ports are keyed by workspaceId internally (the cycle passes workspace.id
  // into every store-shaped call), so one ports object serves every run.
  function buildPorts(): SprintEngineAutoRunCyclePorts {
    return {
      // Terminal runtime, in-process --------------------------------------
      terminalList: async () => deps.terminal.list(),
      terminalWrite: async (sessionId, data) => deps.terminal.write(sessionId, data),
      terminalKill: async (sessionId) => deps.terminal.kill(sessionId),
      terminalStatus: (sessionId) => deps.terminal.status(sessionId),
      terminalSpawn: (args) => deps.terminal.spawn(args),

      // Filesystem + engine seams ------------------------------------------
      pathExists: (path) => deps.pathExists(path),
      readSprintEngineProjection: (statePath) => deps.artifacts.readProjection({ statePath }),
      autoApproveSprintEngineArtifact: (statePath, artifactId) =>
        deps.artifacts.autoApproveArtifact({ statePath, artifactId }),
      replenishSprintEngineRoster: (input) => deps.artifacts.replenishRoster(input),
      memoryResolveRoot: ({ workspaceRoot, relativeRoot }) =>
        deps.resolveMemoryRoot(workspaceRoot, relativeRoot),

      publishDiagnostic: async (input) => {
        await deps.logDiagnostic(input)
      },

      // UI affordances that have no meaning off-window ---------------------
      applyTerminalRevealPolicy: () => undefined,
      isAgentTabVisible: () => false,
      getActiveWorkspaceId: () => null,

      getPluginCatalogEntries: () => deps.getPluginCatalogEntries(),
      getSpawnSettings: () => {
        const settings = deps.getLaunchSettings()
        return {
          projectKnowledgeRoots: settings.projectKnowledgeRoots,
          sprintEngineModelCatalog: settings.sprintEngineModelCatalog,
        }
      },

      // Main-held run view (reads are synchronous inside the cycle) --------
      getWorkspace: (workspaceId) => entryForWorkspaceId(workspaceId)?.view,
      setSprintEngineState: (workspaceId, state) => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return
        target.view.sprintEngineState = state
        reconcileViewAgents(target.view, state)
        // No broadcast: the renderer polls projection.json itself; pushing a
        // second copy would only race its own normalizer.
      },
      setSprintEngineAutoPendingSpawns: (workspaceId, pendingSpawns) => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return
        target.view.sprintEngineAutoState = {
          ...currentAutoState(target),
          pendingSpawns,
        }
        deps.broadcastOp({ kind: 'pending_spawns', statePath: target.statePath, pendingSpawns })
      },
      setSprintEngineAutomationMode: () => {
        // The cycle never sets the mode directly (mode intent belongs to the
        // Phase 1 service); the renderer's manual-toggle path pushes through
        // that service and arrives via notifyAutomationChanged.
      },
      setFolderMissing: (workspaceId, missing) => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return
        target.view.folderMissing = missing
        deps.broadcastOp({ kind: 'folder_missing', statePath: target.statePath, missing })
      },
      updateAgent: (workspaceId, agentId, update) => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return
        const current = target.view.agents[agentId] ?? synthesizeAgent(agentId, agentId)
        target.view.agents = { ...target.view.agents, [agentId]: { ...current, ...update } }
        deps.broadcastOp({ kind: 'agent_updated', statePath: target.statePath, agentId, update })
      },
      markSprintEngineAgentNotificationDelivered: (workspaceId, eventKey) => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return
        const autoState = currentAutoState(target)
        if (!autoState.deliveredAgentNotificationEventKeys.includes(eventKey)) {
          target.view.sprintEngineAutoState = {
            ...autoState,
            deliveredAgentNotificationEventKeys: [
              ...autoState.deliveredAgentNotificationEventKeys,
              eventKey,
            ],
          }
        }
        deps.broadcastOp({ kind: 'notification_delivered', statePath: target.statePath, eventKey })
      },
      applyAutomationStopReason: (workspaceId, reason, context) => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return
        const event = automationEventForStopReason(reason as SprintRuntimeStopReasonPush['reason'], context)
        if (event) applyAutomationEventToView(target, event)
        deps.broadcastOp({
          kind: 'stop_reason',
          statePath: target.statePath,
          reason: reason as SprintRuntimeStopReasonPush['reason'],
          context,
        })
      },

      // Session-identity mirroring ------------------------------------------
      dispatchAssignTerminalSession: (workspaceId, agentId, sessionId, cli) => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return
        deps.broadcastOp({ kind: 'assign_session', statePath: target.statePath, agentId, sessionId, cli })
      },
      dispatchUpdateTerminalLaunchState: (workspaceId, agentId, update) => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return
        deps.broadcastOp({ kind: 'launch_state', statePath: target.statePath, agentId, update })
      },

      // Projection refresh ---------------------------------------------------
      refreshWorkspaceProjection: async ({ workspace, tokens, force }): Promise<SprintEngineAutoRunProjectionRefreshResult> => {
        const target = entryForWorkspaceId(workspace.id)
        if (!target) return { status: 'skipped', reason: 'missing-context' }
        const knownToken = force ? undefined : tokens.get(workspace.id)
        let result: SprintEngineProjectionReadResult
        try {
          result = await deps.artifacts.readProjection({
            statePath: target.statePath,
            ...(knownToken ? { knownToken } : {}),
          })
        } catch (error) {
          return { status: 'error', message: error instanceof Error ? error.message : String(error) }
        }
        if (!result.ok) return { status: 'error', message: result.message }
        if (result.unchanged) return { status: 'unchanged', state: target.view.sprintEngineState ?? null }
        if (result.token) tokens.set(workspace.id, result.token)
        const normalized = normalizeSprintEngineProjection(result.data, target.workspaceName)
        if (!normalized) return { status: 'error', message: 'Projection could not be normalized.' }
        target.view.sprintEngineState = normalized
        reconcileViewAgents(target.view, normalized)
        return { status: 'changed', state: normalized }
      },

      // Completion dormancy ---------------------------------------------------
      enterDormancy: (workspace) => {
        const target = entryForWorkspaceId(workspace.id)
        if (!target) return
        const autoState = currentAutoState(target)
        // One-shot: bound to the completion transition, exactly like the
        // renderer marker semantics.
        if (autoState.completionTeardownAt !== undefined) return
        applyAutomationEventToView(target, { type: 'runner_complete' })
        const at = now()
        target.view.sprintEngineAutoState = {
          ...currentAutoState(target),
          completionTeardownAt: at,
        }
        // The renderer's projection-driven dormancy owns the actual panel
        // teardown (record resumable sessions, dispose PTYs, remove tabs) while
        // a window exists — Phase 3 moves that here for headless runs. The
        // broadcasts keep every window's lifecycle state in step immediately
        // instead of waiting for its next projection poll.
        deps.broadcastOp({
          kind: 'stop_reason',
          statePath: target.statePath,
          reason: 'all_tasks_done',
        })
        deps.broadcastOp({ kind: 'completion_teardown_at', statePath: target.statePath, at })
      },

      // Departed task-scoped worker teardown ---------------------------------
      tearDownDepartedTaskScopedWorker: async (
        workspaceId,
        agentId,
        preloadedSessions,
      ): Promise<SprintEngineAutoRunDepartedWorkerTeardown> => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return { recorded: false, removedAgent: false, removedTab: false, closedSessionId: null }
        const sessions = preloadedSessions ?? deps.terminal.list()
        const agent = target.view.agents[agentId]
        const liveSession = sessions.find((session) =>
          session.processAlive
          && session.kind === 'agent'
          && session.sprintEngineStatePath === target.statePath
          && (session.agentId === agentId || (agent?.cliSessionId && session.sessionId === agent.cliSessionId))
        )

        // Record the resumable session before killing anything so a later
        // manual reopen lands in a warm conversation (MC-1444 semantics).
        let recorded = false
        const role = target.view.sprintEngineState?.sprintEngineAgents?.[agentId]?.role
        const cliSessionId = agent?.cliSessionId ?? liveSession?.cliSessionId ?? liveSession?.sessionId
        const cli = agent?.cli ?? liveSession?.cli ?? undefined
        if (role && cli && cliSessionId) {
          const session: SprintEngineRosterSession = {
            role,
            cli,
            cliSessionId,
            ...(agent?.harnessSessionId ? { harnessSessionId: agent.harnessSessionId } : {}),
            ...(agent?.cliModel ? { cliModel: agent.cliModel } : {}),
            ...(agent?.name ? { name: agent.name } : {}),
            recordedAt: now(),
          }
          target.rosterSessions[agentId] = session
          deps.broadcastOp({ kind: 'roster_session_recorded', statePath: target.statePath, agentId, session })
          recorded = true
        }

        const closedSessionId = liveSession?.sessionId ?? null
        if (closedSessionId) {
          try {
            deps.terminal.kill(closedSessionId)
          } catch {
            // Already gone — retirement is idempotent.
          }
        }

        // Clear the launch flags in main's view; the renderer removes the tab
        // and its own agent record when it applies the retirement op.
        if (agent) {
          target.view.agents = {
            ...target.view.agents,
            [agentId]: {
              ...agent,
              cliStartRequested: false,
              cliHasLaunched: false,
              cliOnboardingPromptSent: false,
              cliSessionId: undefined,
            },
          }
        }
        deps.broadcastOp({ kind: 'worker_retired', statePath: target.statePath, agentId, closedSessionId })
        return { recorded, removedAgent: false, removedTab: false, closedSessionId }
      },

      randomUUID: () => randomUUID(),
    }
  }

  async function tick(): Promise<void> {
    if (tickInProgress || disposed) return
    tickInProgress = true
    try {
      const spawnDelayElapsed = now() - startedAt >= SPRINT_RUNTIME_STARTUP_SPAWN_DELAY_MS
      for (const entry of [...runsByStatePath.values()]) {
        reconcilePower(entry)
        if (!sprintEngineAutomationShouldRun(entry.view.sprintEngineAutoState)) continue
        const ports = buildPorts()
        try {
          // Keep the view's projection fresh before deciding anything — main
          // has no renderer projection supervisor feeding it.
          await ports.refreshWorkspaceProjection({
            workspace: entry.view,
            tokens: entry.refs.projectionTokensByWorkspace.current,
            cause: 'auto-run',
          })
          await reconcileWorkspaceSessions(ports, entry.cycleState, entry.view)
          if (!spawnDelayElapsed) continue
          await superviseWorkspace(
            ports,
            entry.cycleState,
            entry.view,
            deps.getLaunchSettings().cliRuntimes,
            deps.getLaunchSettings().mcp,
            entry.refs.inFlightSpawns,
            entry.refs.sentArtifactApprovalMessages,
            entry.refs.autoApprovalDiagnostics,
            entry.refs.sentContinuationMessages,
            entry.refs.sentDispatchMessages,
            entry.refs.sentArchitectTriageMessages,
            entry.refs.sentAgentNotificationEvents,
            entry.refs.continuationGraceByTask,
            entry.refs.projectionTokensByWorkspace,
            entry.refs.idleClockByAgent,
            entry.refs.retirementCooldownByAgent,
          )
        } catch (error) {
          void deps.logDiagnostic({
            level: 'warning',
            source: 'sprintengine',
            title: 'Sprint scheduler tick failed',
            message: `The main-process auto-run tick failed for ${entry.workspaceName}; it retries on the next tick.`,
            details: error instanceof Error ? error.stack ?? error.message : String(error),
          })
        }
      }
    } finally {
      tickInProgress = false
    }
  }

  function ensureTicking(): void {
    if (tickHandle !== null || disposed) return
    tickHandle = timers.setInterval(() => {
      void tick()
    }, SPRINT_RUNTIME_TICK_MS)
  }

  return {
    /** Renderer announces/refreshes a sprint run's context. Idempotent upsert. */
    registerRun(registration: SprintRuntimeRunRegistration): void {
      if (disposed) return
      const existing = runsByStatePath.get(registration.statePath)
      const teamDirectoryPath = dirname(registration.statePath)
      const teamSlug = basename(teamDirectoryPath)
      if (existing) {
        // Context refresh: identity + run configuration follow the renderer;
        // scheduler-owned runtime residue (pendingSpawns, delivered keys,
        // runtimeState) stays main-owned once adopted.
        if (existing.view.id !== registration.workspaceId) {
          runsByWorkspaceId.delete(existing.view.id)
          existing.view.id = registration.workspaceId
          runsByWorkspaceId.set(registration.workspaceId, existing)
        }
        existing.workspaceName = registration.workspaceName
        existing.view.name = registration.workspaceName
        existing.view.folderPath = registration.folderPath
        existing.view.memory = { relativeRoot: registration.memoryRelativeRoot }
        existing.view.sprintEngineAutoState = {
          ...currentAutoState(existing),
          cliPermissionPreset: registration.cliPermissionPreset,
          maxConcurrentAgents: registration.maxConcurrentAgents,
          ...(registration.architectGuidance !== undefined
            ? { architectGuidance: registration.architectGuidance }
            : {}),
        }
        reconcilePower(existing)
        return
      }

      const entry: RunEntry = {
        statePath: registration.statePath,
        workspaceName: registration.workspaceName,
        view: {
          id: registration.workspaceId,
          name: registration.workspaceName,
          folderPath: registration.folderPath,
          agents: { ...registration.agents },
          sprintEngineState: null,
          sprintEngineAutoState: {
            desiredMode: 'manual',
            runtimeState: 'idle',
            cliPermissionPreset: registration.cliPermissionPreset,
            maxConcurrentAgents: registration.maxConcurrentAgents,
            pendingSpawns: registration.pendingSpawns,
            deliveredAgentNotificationEventKeys: registration.deliveredAgentNotificationEventKeys,
            ...(registration.completionTeardownAt !== undefined
              ? { completionTeardownAt: registration.completionTeardownAt }
              : {}),
            ...(registration.architectGuidance !== undefined
              ? { architectGuidance: registration.architectGuidance }
              : {}),
          },
          sprintEngineContext: {
            teamName: registration.workspaceName,
            teamSlug,
            teamDirectoryPath,
            statePath: registration.statePath,
          },
          memory: { relativeRoot: registration.memoryRelativeRoot },
        },
        rosterSessions: { ...registration.rosterSessions },
        cycleState: createSprintEngineAutoRunCycleState(),
        refs: {
          inFlightSpawns: { current: new Set() },
          sentArtifactApprovalMessages: { current: new Map() },
          autoApprovalDiagnostics: { current: new Map() },
          sentContinuationMessages: { current: new Map() },
          sentDispatchMessages: { current: new Map() },
          sentArchitectTriageMessages: { current: new Map() },
          sentAgentNotificationEvents: { current: new Set() },
          continuationGraceByTask: { current: new Map() },
          projectionTokensByWorkspace: { current: new Map() },
          idleClockByAgent: { current: new Map() },
          retirementCooldownByAgent: { current: new Map() },
        },
      }
      runsByStatePath.set(registration.statePath, entry)
      runsByWorkspaceId.set(registration.workspaceId, entry)
      ensureTicking()

      // Adopt the authoritative mode intent (Phase 1 sidecar). Until the read
      // lands the run stays manual — a scheduler must never spawn on a guess.
      void deps.readAutomationMode(registration.statePath)
        .then((record) => {
          if (!record || disposed) return
          const target = runsByStatePath.get(registration.statePath)
          if (!target) return
          applyAutomationEventToView(target, { type: 'user_set_mode', mode: record.desiredMode })
          void tick()
        })
        .catch(() => undefined)
    },

    /** Renderer stops tracking a run (workspace removed). */
    unregisterRun(statePath: string): void {
      const entry = runsByStatePath.get(statePath)
      if (!entry) return
      runsByStatePath.delete(statePath)
      runsByWorkspaceId.delete(entry.view.id)
      deps.powerManager.markRunInactive(statePath)
    },

    /** Renderer-originated lifecycle stop (terminal closed, blocked, removed…). */
    applyStopReason(push: SprintRuntimeStopReasonPush): void {
      const entry = runsByStatePath.get(push.statePath)
      if (!entry) return
      const event = automationEventForStopReason(push.reason, push.context)
      if (event) applyAutomationEventToView(entry, event)
      // No broadcast back: the renderer that pushed already applied it
      // locally, and other windows receive the same store state through the
      // renderer's own sync; echoing would re-apply.
    },

    /**
     * The Phase 1 automation service reports every intent write here (before
     * broadcasting to windows) so scheduling reacts immediately: the mode
     * transition runs through the same reducer the renderer uses, and an
     * enabling write wakes the tick loop instead of waiting out the interval.
     */
    notifyAutomationChanged(statePath: string, record: SprintEngineAutomationIntentRecord): void {
      const entry = runsByStatePath.get(statePath)
      if (!entry) return
      const current = currentAutoState(entry)
      if (current.desiredMode === record.desiredMode) return
      applyAutomationEventToView(entry, { type: 'user_set_mode', mode: record.desiredMode })
      if (sprintEngineAutomationShouldRun(entry.view.sprintEngineAutoState)) void tick()
    },

    /** Introspection for diagnostics/tests. */
    inspectRun(statePath: string): {
      view: SprintEngineWorkspaceView
      rosterSessions: Record<string, SprintEngineRosterSession>
    } | null {
      const entry = runsByStatePath.get(statePath)
      if (!entry) return null
      return { view: entry.view, rosterSessions: entry.rosterSessions }
    },

    /** Run one scheduler tick immediately (tests; wake paths). */
    tickNow(): Promise<void> {
      return tick()
    },

    shutdown(): void {
      disposed = true
      if (tickHandle !== null) {
        timers.clearInterval(tickHandle)
        tickHandle = null
      }
      deps.powerManager.shutdown()
    },
  }
}

export type { SprintRuntimeRunRegistration, SprintRuntimeStopReasonPush, SprintRuntimeOp }
