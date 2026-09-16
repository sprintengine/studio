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
  SprintEngineTaskWorktreeResult,
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
  SprintEngineAutomationRuntimeState,
} from '../shared/sprintengine/automation-types'
import {
  sprintEngineAutomationShouldRun,
  transitionSprintEngineAutomation,
} from '../shared/sprintengine/automation-lifecycle'
import type {
  SprintEngineAutomationIntentRecord,
  SprintEngineAutomationRuntimeResidue,
} from '../shared/sprintengine/automation-intent'
import {
  buildSprintEngineAgentRosterForState,
  isCanceledSprintEngineRun,
  isCompletedSprintEngineRun,
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
import type { SprintEngineDispatchAttempt } from '../shared/sprintengine/auto-run'
import { setSprintEngineAutoRunPerfLogger } from '../shared/sprintengine/auto-run'
import { samePath } from '../shared/paths'
import type { TerminalSpawnArgs } from '../shared/sprintengine/auto-run-executor'
import {
  agentCliSupportsConversationResume,
  agentCliUsesStableSessionIdForResume,
  resumeCapabilitiesForCli,
} from '../shared/agent-cli-resume'
import type { AgentLaunchSettings } from '../shared/sprintengine/launch-settings'
import type {
  SprintRuntimeAgentConfig,
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
// MC-1906: how long a session's `visible` flag counts as "the operator is
// currently looking at it" without a fresh visibility edge or keystroke. Past
// this, a latched flag (undelivered unmount hide) stops blocking retirement.
const SPRINT_VISIBLE_TAB_HOLD_MS = 15 * 60_000
// Generous — engine CLI operations (projection reads, auto-approval)
// legitimately take seconds; the watchdog exists for hung subprocesses, not
// slow ones.
const SPRINT_RUNTIME_TICK_WATCHDOG_MS = 120_000

type MutableRef<T> = { current: T }

type RunEntry = {
  statePath: string
  workspaceName: string
  view: SprintEngineWorkspaceView & { name: string; folderPath: string }
  rosterSessions: Record<string, SprintEngineRosterSession>
  cycleState: SprintEngineAutoRunCycleState
  // A cycle pass is still running (or was watchdog-abandoned and has not yet
  // settled). Two concurrent passes over the same ledgers double-send prompts
  // and double-spawn, so ticks skip the entry until the work resolves.
  tickInFlight: boolean
  refs: {
    inFlightSpawns: MutableRef<Set<string>>
    sentArtifactApprovalMessages: MutableRef<Map<string, number>>
    autoApprovalDiagnostics: MutableRef<Map<string, number>>
    sentContinuationMessages: MutableRef<Map<string, SprintEngineDispatchAttempt>>
    sentDispatchMessages: MutableRef<Map<string, SprintEngineDispatchAttempt>>
    sentArchitectTriageMessages: MutableRef<Map<string, ArchitectTriageMessage>>
    sentAgentNotificationEvents: MutableRef<Set<string>>
    projectionTokensByWorkspace: MutableRef<Map<string, string>>
    idleClockByAgent: MutableRef<Map<string, number>>
    retirementCooldownByAgent: MutableRef<Map<string, number>>
  }
}

export type SprintRuntimeDeps = {
  terminal: {
    list(): TerminalSessionSnapshot[]
    write(sessionId: string, data: string): void
    /**
     * Deliver a dispatch prompt through the agent control plane (MC-102): one
     * serialized turn per session, so a review-guide prompt or a future
     * composer send cannot land between this paste and its submit. Optional so
     * a test harness can drive the raw write seam.
     */
    sendPrompt?(sessionId: string, text: string): Promise<{ ok: boolean; message?: string }>
    kill(sessionId: string): void
    status(sessionId: string): Promise<{ processAlive: boolean }>
    /** In-process spawn; fails cleanly when no window can host the terminal view (Phase 2 limit). */
    spawn(args: TerminalSpawnArgs): Promise<TerminalSpawnResult>
    /**
     * Move a run's live sessions onto a new workspace id (MC-2153): a
     * boot-discovered run spawns under a placeholder id and adopts the window's
     * real one, and every workspace-keyed session lookup outside the scheduler
     * — the board roster, duplicate-session disposal — must follow it.
     */
    adoptWorkspaceId?(input: { statePath: string; workspaceId: string }): void
  }
  artifacts: {
    readProjection(input: { statePath: string; knownToken?: string }): Promise<SprintEngineProjectionReadResult>
    autoApproveArtifact(input: { statePath: string; artifactId: string }): Promise<SprintEngineArtifactCommandResult>
    ensureTaskWorktree(input: { statePath: string; taskId: string }): Promise<SprintEngineTaskWorktreeResult>
  }
  pathExists(path: string): Promise<boolean>
  resolveMemoryRoot(workspaceRoot: string | null, relativeRoot: string | null): Promise<MemoryRootStatus>
  getPluginCatalogEntries(): readonly PluginRegistryListEntry[]
  getLaunchSettings(): AgentLaunchSettings
  readAutomationMode(statePath: string): Promise<SprintEngineAutomationIntentRecord | null>
  /**
   * Durable scheduler bookkeeping (Phase 3): persists delivered notification
   * keys, the completion-teardown marker, and roster resume records into the
   * automation sidecar so headless retirements and completions survive with
   * zero windows and an app restart re-adopts main's own record rather than a
   * stale renderer mirror. Fire-and-forget.
   */
  persistRuntimeResidue(statePath: string, runtime: SprintEngineAutomationRuntimeResidue): void
  powerManager: Pick<SprintPowerManager, 'markRunActive' | 'markRunInactive' | 'shutdown'>
  broadcastOp(op: SprintRuntimeOp): void
  /**
   * Tell the cross-project run index (the Sprints door) a run's on-disk state
   * changed OUTSIDE any registered runtime — e.g. a cancel of a run whose
   * workspace is not resident. Ops from registered runs already notify the
   * index via broadcastOp; this is the non-resident escape hatch.
   */
  notifyRunsChanged?(statePath: string): void
  /**
   * Product telemetry for a run reaching its end. Optional so bare test
   * harnesses stay unchanged; production wiring always provides it.
   *
   * It hangs off this function rather than off a wrapper the way the launch and
   * create doors do, because `enterTerminalDormancy` is the ONLY place a run
   * becomes terminal — the auto-run gate and the direct cancel both land here —
   * and there is no outside surface that sees both.
   */
  recordRunFinished?(input: { outcome: 'complete' | 'canceled' }): void
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
      ...(resolved.cliReasoning !== undefined ? { cliReasoning: resolved.cliReasoning } : {}),
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
  // MC-1906: the shared auto-run corpus's perf/skip audit (idle-retire-skipped,
  // task-scoped-worker-torn-down, …) defaulted to a no-op in main, so the
  // instrumentation built for retirement stalls (MC-1751) was dark in the one
  // process that now runs the cycle. Route it to the main console (Electron
  // log); the audit is why the 2026-07-26 leak needed a live post-mortem.
  setSprintEngineAutoRunPerfLogger((scope, event, payload) => {
    console.info(`[${scope}] ${event} ${payload ? JSON.stringify(payload) : ''}`)
  })
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
      cliPermissionPreset: 'manual',
      maxConcurrentAgents: 3,
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

  /**
   * Adopt an authoritative desired mode (the sidecar read at registration, or
   * the automation service's hydration seeding) into main's view. Unlike a
   * live `user_set_mode` intent this is a re-attach, not a gesture: the
   * lifecycle the renderer registered (paused/blocked/failed/complete) is
   * preserved, so an app relaunch never auto-resumes a run the user saw
   * stopped and never re-activates a completed one. `idle` carries no
   * enabling-mode lifecycle and maps to `running`, exactly like the legacy
   * renderer normalizer.
   */
  function adoptDesiredMode(target: RunEntry, record: SprintEngineAutomationIntentRecord): void {
    const current = currentAutoState(target)
    if (current.desiredMode === record.desiredMode) return
    if (record.desiredMode === 'manual') {
      applyAutomationEventToView(target, { type: 'user_set_mode', mode: 'manual' })
      return
    }
    const runtimeState = current.runtimeState === 'idle' ? 'running' : current.runtimeState
    target.view.sprintEngineAutoState = {
      ...current,
      desiredMode: record.desiredMode,
      runtimeState,
      ...(runtimeState === 'running'
        ? {
          reason: undefined,
          reasonMessage: undefined,
          reasonTaskId: undefined,
          reasonAgentId: undefined,
        }
        : {}),
      changedAt: now(),
    }
    reconcilePower(target)
    if (sprintEngineAutomationShouldRun(target.view.sprintEngineAutoState)) void tick()
  }

  function persistResidue(entry: RunEntry): void {
    const autoState = currentAutoState(entry)
    deps.persistRuntimeResidue(entry.statePath, {
      deliveredAgentNotificationEventKeys: autoState.deliveredAgentNotificationEventKeys,
      ...(autoState.completionTeardownAt !== undefined
        ? { completionTeardownAt: autoState.completionTeardownAt }
        : {}),
      rosterSessions: entry.rosterSessions,
    })
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
      ...(deps.terminal.sendPrompt
        ? { terminalSendPrompt: (sessionId: string, text: string) => deps.terminal.sendPrompt!(sessionId, text) }
        : {}),
      terminalKill: async (sessionId) => deps.terminal.kill(sessionId),
      terminalStatus: (sessionId) => deps.terminal.status(sessionId),
      terminalSpawn: (args) => deps.terminal.spawn(args),

      // Filesystem + engine seams ------------------------------------------
      pathExists: (path) => deps.pathExists(path),
      readSprintEngineProjection: (statePath) => deps.artifacts.readProjection({ statePath }),
      autoApproveSprintEngineArtifact: (statePath, artifactId) =>
        deps.artifacts.autoApproveArtifact({ statePath, artifactId }),
      memoryResolveRoot: ({ workspaceRoot, relativeRoot }) =>
        deps.resolveMemoryRoot(workspaceRoot, relativeRoot),
      ensureSprintEngineTaskWorktree: (input) => deps.artifacts.ensureTaskWorktree(input),

      publishDiagnostic: async (input) => {
        const entry = await deps.logDiagnostic(input)
        // Cycle diagnostics are user-facing (auto-approval skipped, spawn
        // failed, bootstrap stall…): mirror them into every
        // window's notification store, matching the retired renderer
        // supervisor's publishDiagnostic. Routed by workspaceId; a diagnostic
        // without one is log-only.
        const target = input.workspaceId ? entryForWorkspaceId(input.workspaceId) : undefined
        if (!target) return
        deps.broadcastOp({
          kind: 'diagnostic',
          statePath: target.statePath,
          entry: entry ?? { ...input, id: randomUUID(), timestamp: new Date(now()).toISOString() },
        })
      },

      // UI affordances -------------------------------------------------------
      // Tab maintenance is a window concern: broadcast so each window with an
      // open tab for the agent renames it to the current task label and
      // re-stamps its config's sessionId (a stale sessionId keeps the panel on
      // the killed previous session). Auto-run never opens new tabs, so the
      // 'background' policy semantics are preserved by the renderer applier.
      applyTerminalRevealPolicy: (workspaceId, agentId, name, revealPolicy, config) => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return
        const sessionId = typeof config?.sessionId === 'string' ? config.sessionId : undefined
        deps.broadcastOp({
          kind: 'reveal_policy',
          statePath: target.statePath,
          agentId,
          name,
          revealPolicy,
          ...(sessionId ? { sessionId } : {}),
        })
      },
      // "Never close the terminal the operator is looking at": main has no
      // flexlayout model, but the terminal runtime tracks per-session view
      // visibility (`setTerminalVisible` from mounted views), which is the
      // same signal one hop earlier — a visible live session means an open,
      // watched tab.
      //
      // MC-1906: `visible` LATCHES true when a view's unmount hide is never
      // delivered (window reload, remount), and a latched flag skipped every
      // retirement of a run forever — the incident run leaked all 15 done
      // workers this way. Bound the hold: "currently looking at" requires a
      // visibility edge or keystroke inside the window; a stale latch expires
      // and the retirement proceeds (the recorded session still resumes).
      isAgentTabVisible: (workspaceId, agentId) => {
        const target = entryForWorkspaceId(workspaceId)
        if (!target) return false
        const staleBefore = now() - SPRINT_VISIBLE_TAB_HOLD_MS
        return deps.terminal.list().some((session) =>
          session.kind === 'agent'
          && samePath(session.sprintEngineStatePath ?? null, target.statePath)
          && session.agentId === agentId
          && session.processAlive
          && session.visible === true
          && Math.max(session.lastVisibleAt ?? 0, session.lastInputAt ?? 0) > staleBefore
        )
      },

      getPluginCatalogEntries: () => deps.getPluginCatalogEntries(),
      getSpawnSettings: () => {
        const settings = deps.getLaunchSettings()
        return {
          projectKnowledgeRoots: settings.projectKnowledgeRoots,
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
        // Config-field mutations from the cycle (e.g. consuming a startup
        // prompt at spawn) stamp configEditedAt so a stale window
        // registration cannot resurrect the consumed value.
        const touchesConfig =
          'cliRuntimeOverride' in update || 'name' in update || 'cliStartupPrompt' in update
        const stamped = touchesConfig && update.configEditedAt === undefined
          ? { ...update, configEditedAt: now() }
          : update
        target.view.agents = { ...target.view.agents, [agentId]: { ...current, ...stamped } }
        deps.broadcastOp({ kind: 'agent_updated', statePath: target.statePath, agentId, update: stamped })
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
        persistResidue(target)
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
        // Stamp resume capabilities on MAIN's record too — the renderer
        // learns them from the bridge op below, but the next respawn decision
        // (retained-resume, MC-1444) runs against main's view, which would
        // otherwise keep the spawn-time `cliResumeAvailable: false` forever
        // and cold-spawn every follow-up.
        const caps = resumeCapabilitiesForCli(cli, deps.getPluginCatalogEntries())
        const agent = target.view.agents[agentId]
        if (agent) {
          target.view.agents = {
            ...target.view.agents,
            [agentId]: {
              ...agent,
              cliSessionId: sessionId,
              cli,
              cliResumeAvailable: agentCliSupportsConversationResume(caps),
              cliUsesStableSessionId: agentCliUsesStableSessionIdForResume(caps),
            },
          }
        }
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
        // Scope expansion re-arms completion teardown (Phase 3): when a
        // completed run gains new open tasks, clear the one-shot marker so the
        // next completion tears down again — the renderer reconcile has done
        // this per-window; main owns it now.
        const autoState = currentAutoState(target)
        if (
          autoState.completionTeardownAt !== undefined
          && !isCompletedSprintEngineRun(normalized)
        ) {
          target.view.sprintEngineAutoState = {
            ...autoState,
            completionTeardownAt: undefined,
          }
          deps.broadcastOp({ kind: 'completion_teardown_at', statePath: target.statePath, at: undefined })
          persistResidue(target)
        }
        return { status: 'changed', state: normalized }
      },

      // Completion / cancellation dormancy ------------------------------------
      // One entry point for both terminal transitions (the auto-run hard gate
      // routes a completed OR canceled run here). `enterTerminalDormancy` reads
      // the run's stored cancel flag to fire the right terminal event and then
      // runs the shared one-shot teardown.
      enterDormancy: (workspace) => {
        const target = entryForWorkspaceId(workspace.id)
        if (!target) return
        enterTerminalDormancy(target)
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
        return retireWorkerSession(target, agentId, sessions)
      },

      randomUUID: () => randomUUID(),
    }
  }

  /**
   * Merge renderer-owned per-agent configuration (mid-run runtime override,
   * rename, queued custom startup prompt) into main's view — these are user
   * edits the next spawn must honour; launch flags stay main-owned.
   * Last-write-wins on `configEditedAt`: a registration stamped older than
   * the edit main already holds is a lagging window's mirror and is ignored,
   * so it can never clobber a newer edit from another window. Explicit `null`
   * fields are tombstones (the user cleared the value); absent fields leave
   * main's copy alone.
   */
  function mergeAgentConfigs(
    entry: RunEntry,
    agentConfigsInput: SprintRuntimeRunRegistration['agentConfigs'] | undefined,
  ): void {
    // IPC payloads are defensive-read: an older window build may not send the
    // field at all.
    const agentConfigs = agentConfigsInput ?? {}
    const next = { ...entry.view.agents }
    let changed = false
    const applyConfig = (agent: AgentState, config: SprintRuntimeAgentConfig): AgentState => ({
      ...agent,
      ...(config.cliRuntimeOverride !== undefined
        ? { cliRuntimeOverride: config.cliRuntimeOverride ?? undefined }
        : {}),
      ...(config.name !== undefined ? { name: config.name } : {}),
      ...(config.cliStartupPrompt !== undefined
        ? { cliStartupPrompt: config.cliStartupPrompt ?? undefined }
        : {}),
      ...(config.configEditedAt !== undefined ? { configEditedAt: config.configEditedAt } : {}),
    })
    for (const [agentId, config] of Object.entries(agentConfigs)) {
      const agent = next[agentId]
      if (agent) {
        // An unstamped config never displaces a stamped record, and an older
        // stamp never displaces a newer edit.
        const currentStamp = agent.configEditedAt
        if (
          currentStamp !== undefined
          && (config.configEditedAt === undefined || config.configEditedAt < currentStamp)
        ) {
          continue
        }
        const merged = applyConfig(agent, config)
        if (
          merged.cliRuntimeOverride !== agent.cliRuntimeOverride
          || merged.name !== agent.name
          || merged.cliStartupPrompt !== agent.cliStartupPrompt
          || merged.configEditedAt !== agent.configEditedAt
        ) {
          next[agentId] = merged
          changed = true
        }
      } else {
        next[agentId] = applyConfig(synthesizeAgent(agentId, config.name ?? agentId), config)
        changed = true
      }
    }
    if (changed) entry.view.agents = next
  }

  /**
   * Mirror each live session's harness resume id into main's agent record.
   * The agent-state hook captures the CLI's own session id onto the terminal
   * session (`session.cliSessionId`); the respawn/retirement paths read it
   * from the agent record, which main must therefore keep synced (the
   * renderer learns the same value through its own session snapshot store).
   */
  function syncAgentSessionIdentity(entry: RunEntry): void {
    for (const session of deps.terminal.list()) {
      if (session.kind !== 'agent' || session.sprintEngineStatePath !== entry.statePath) continue
      const agentId = session.agentId
      if (!agentId) continue
      const agent = entry.view.agents[agentId]
      if (!agent || agent.cliSessionId !== session.sessionId) continue
      const harnessSessionId = session.cliSessionId ?? undefined
      if (harnessSessionId && agent.harnessSessionId !== harnessSessionId) {
        entry.view.agents = {
          ...entry.view.agents,
          [agentId]: { ...agent, harnessSessionId },
        }
      }
    }
  }

  /**
   * The shared one-shot teardown for a run that reached a terminal state
   * (completion or cancellation): record every agent's resumable session and
   * dispose its PTY — LIVE and SUSPENDED sessions alike (idle-reaped agents are
   * exactly the population a completed/canceled run carries), plus agents whose
   * terminals already exited but whose records still hold a resumable identity.
   * Windows apply the retirement ops (record + tab removal) and their
   * projection-driven dormancy remains an idempotent no-op after this. Guarded
   * by the persisted `completionTeardownAt` marker so it fires exactly once per
   * terminal entry (the marker is generic, shared by both terminal reasons).
   */
  function performTerminalTeardown(target: RunEntry): void {
    if (currentAutoState(target).completionTeardownAt !== undefined) return
    const at = now()
    target.view.sprintEngineAutoState = {
      ...currentAutoState(target),
      completionTeardownAt: at,
    }
    const sessions = deps.terminal.list()
    const agentIdsToRetire = new Set<string>()
    for (const session of sessions) {
      if (
        (session.processAlive || session.suspended)
        && session.kind === 'agent'
        && session.sprintEngineStatePath === target.statePath
        && session.agentId
      ) {
        agentIdsToRetire.add(session.agentId)
      }
    }
    for (const [agentId, agent] of Object.entries(target.view.agents)) {
      if (agent.cli && agent.cliSessionId) agentIdsToRetire.add(agentId)
    }
    for (const agentId of agentIdsToRetire) {
      retireWorkerSession(target, agentId, sessions)
    }
    deps.broadcastOp({ kind: 'completion_teardown_at', statePath: target.statePath, at })
    persistResidue(target)
  }

  /**
   * Drive a run into its terminal dormant state. Completion and cancellation
   * share the exact same teardown; only the terminal automation event differs,
   * chosen from the run's stored cancel flag (`isCanceledSprintEngineRun`).
   * The terminal transition must always land — a run re-adopted into `running`
   * while the one-shot teardown marker is still set would otherwise stay active
   * forever, holding the power-save blocker and burning a projection read every
   * tick. The completion path keeps its renderer `stop_reason` broadcast; the
   * cancel glyph is derived from the projection's stored flag instead, so no
   * new bridge stop-reason is introduced here.
   */
  function enterTerminalDormancy(target: RunEntry, opts?: { canceled?: boolean }): void {
    const runState = target.view.sprintEngineState
    // The direct cancel path knows its intent; the auto-run gate derives it from
    // the run's stored flag. `opts.canceled` lets cancelRun park a run before its
    // projection view has refreshed to carry the flag.
    const canceled = opts?.canceled ?? (runState ? isCanceledSprintEngineRun(runState) : false)
    const targetRuntimeState: SprintEngineAutomationRuntimeState = canceled ? 'canceled' : 'complete'
    if (currentAutoState(target).runtimeState !== targetRuntimeState) {
      applyAutomationEventToView(
        target,
        canceled ? { type: 'runner_canceled' } : { type: 'runner_complete' },
      )
      // Inside the transition guard, so a run that is parked twice — a cancel
      // of an already-canceled run, a re-adopted terminal run — is counted
      // once, exactly like the view event beside it.
      deps.recordRunFinished?.({ outcome: targetRuntimeState })
      if (!canceled) {
        deps.broadcastOp({
          kind: 'stop_reason',
          statePath: target.statePath,
          reason: 'all_tasks_done',
        })
      }
    }
    performTerminalTeardown(target)
  }

  /**
   * User-initiated run cancellation (MC-1604): the board/workspace Cancel action
   * (wired by the renderer/IPC layer in MC-1604b) calls this after the engine
   * cancel op (`sprintengine cancel`) has written run/task status. It parks the
   * run through the same terminal dormancy as completion — terminal `canceled`
   * automation state (stops polling) and the shared one-shot teardown (records
   * resumable sessions, disposes PTYs, removes panels). Unlike the auto-run hard
   * gate (which only reaches a run whose automation is running), this direct
   * path also tears down a paused/manual run with live agents. Idempotent via
   * the reducer's terminal guard and the persisted teardown marker.
   */
  function cancelRun(statePath: string): void {
    const entry = runsByStatePath.get(statePath)
    if (!entry) {
      // The run's workspace is not resident (a Sprints-door cancel of a closed
      // run): there is no runtime to tear down, but the engine already wrote
      // the canceled state — the cross-project run index must still hear about
      // it, or the door keeps pulsing the stale "running" summary forever.
      deps.notifyRunsChanged?.(statePath)
      return
    }
    enterTerminalDormancy(entry, { canceled: true })
  }

  /**
   * Retire one agent's live session: record the resumable session before
   * killing anything (a later manual reopen lands in a warm conversation —
   * MC-1444 semantics), dispose the PTY, clear main's launch flags, and
   * broadcast so windows record the session, remove the tab, and drop the
   * agent record. Idempotent for already-dead sessions.
   */
  function retireWorkerSession(
    target: RunEntry,
    agentId: string,
    sessions: TerminalSessionSnapshot[],
  ): SprintEngineAutoRunDepartedWorkerTeardown {
    const agent = target.view.agents[agentId]
    // Suspended sessions count: an idle-reaped agent still owns a disposable
    // placeholder + snapshot sidecar and a recordable resume identity.
    // MC-1906: statePaths compare normalized, and a CLI-session-id match works
    // on its own (the id is a uuid — collision-proof) — a session the statePath
    // arm misses must still be found, or the kill below is silently skipped
    // while `worker_retired` reports a clean teardown.
    const liveSession = sessions.find((session) =>
      (session.processAlive || session.suspended)
      && session.kind === 'agent'
      && (
        (samePath(session.sprintEngineStatePath ?? null, target.statePath)
          && (session.agentId === agentId || (agent?.cliSessionId && session.sessionId === agent.cliSessionId)))
        || (agent?.cliSessionId != null
          && (session.sessionId === agent.cliSessionId || session.cliSessionId === agent.cliSessionId))
      )
    )

    let recorded = false
    const role = target.view.sprintEngineState?.sprintEngineAgents?.[agentId]?.role
    const cliSessionId = agent?.cliSessionId ?? liveSession?.cliSessionId ?? liveSession?.sessionId
    const cli = agent?.cli ?? liveSession?.cli ?? undefined
    // Parity with the renderer teardown: the harness resume token prefers the
    // agent record but falls back to the live session's captured id — CLIs
    // that mint their own resume id (codex-style) surface it only there.
    const harnessSessionId = agent?.harnessSessionId ?? liveSession?.cliSessionId ?? undefined
    if (role && cli && cliSessionId) {
      const session: SprintEngineRosterSession = {
        role,
        cli,
        cliSessionId,
        ...(harnessSessionId ? { harnessSessionId } : {}),
        ...(agent?.cliModel ? { cliModel: agent.cliModel } : {}),
        ...(agent?.cliReasoning ? { cliReasoning: agent.cliReasoning } : {}),
        ...(agent?.name ? { name: agent.name } : {}),
        recordedAt: now(),
      }
      target.rosterSessions[agentId] = session
      deps.broadcastOp({ kind: 'roster_session_recorded', statePath: target.statePath, agentId, session })
      persistResidue(target)
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
  }

  /** Move `<oldWorkspaceId>:<agentId>` spawn-in-flight keys onto the new id. */
  function rekeyInFlightSpawns(entry: RunEntry, fromWorkspaceId: string, toWorkspaceId: string): void {
    const inFlight = entry.refs.inFlightSpawns.current
    for (const key of [...inFlight]) {
      if (!key.startsWith(`${fromWorkspaceId}:`)) continue
      inFlight.delete(key)
      inFlight.add(`${toWorkspaceId}:${key.slice(fromWorkspaceId.length + 1)}`)
    }
  }

  async function tick(): Promise<void> {
    if (tickInProgress || disposed) return
    tickInProgress = true
    try {
      const spawnDelayElapsed = now() - startedAt >= SPRINT_RUNTIME_STARTUP_SPAWN_DELAY_MS
      for (const entry of [...runsByStatePath.values()]) {
        reconcilePower(entry)
        const shouldRun = sprintEngineAutomationShouldRun(entry.view.sprintEngineAutoState)
        // Paused/blocked/failed runs still get a session-only reconcile: the
        // idle reaper disposes sprint PTYs regardless of automation state, and
        // without this pass the launch flags it strands (cliStartRequested
        // with no live session) keep every roster row on "Starting…" until
        // the run resumes. No projection read, no supervise — spawning stays
        // gated on shouldRun. Terminal states (complete/canceled) are skipped:
        // their one-shot teardown already cleared the flags.
        const idleRuntimeState = currentAutoState(entry).runtimeState
        const reconcileOnly = !shouldRun
          && (idleRuntimeState === 'paused' || idleRuntimeState === 'blocked' || idleRuntimeState === 'failed')
        if (!shouldRun && !reconcileOnly) continue
        // A watchdog-abandoned pass may still be settling; never run a second
        // cycle over the same entry's ledgers concurrently.
        if (entry.tickInFlight) continue
        const ports = buildPorts()
        const entryWork = async (): Promise<void> => {
          if (reconcileOnly) {
            await reconcileWorkspaceSessions(ports, entry.cycleState, entry.view)
            syncAgentSessionIdentity(entry)
            return
          }
          // Keep the view's projection fresh before deciding anything — main
          // has no renderer projection supervisor feeding it.
          await ports.refreshWorkspaceProjection({
            workspace: entry.view,
            tokens: entry.refs.projectionTokensByWorkspace.current,
            cause: 'auto-run',
          })
          await reconcileWorkspaceSessions(ports, entry.cycleState, entry.view)
          syncAgentSessionIdentity(entry)
          if (!spawnDelayElapsed) return
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
            entry.refs.projectionTokensByWorkspace,
            entry.refs.idleClockByAgent,
            entry.refs.retirementCooldownByAgent,
          )
        }
        entry.tickInFlight = true
        const work = entryWork()
        // Release the per-entry lock only when the work actually settles —
        // the watchdog below abandons WAITING on it, never cancels it, so
        // until then ticks skip this entry (see the tickInFlight guard).
        void work.catch(() => undefined).finally(() => {
          entry.tickInFlight = false
        })
        try {
          // Watchdog: a hung engine subprocess (projection read,
          // auto-approve) must not wedge the app-lifetime loop for every run.
          // On timeout the loop moves on to the other runs; this run resumes
          // once the stalled work settles.
          await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              setTimeout(
                () => reject(new Error(`Scheduler tick exceeded ${SPRINT_RUNTIME_TICK_WATCHDOG_MS}ms`)),
                SPRINT_RUNTIME_TICK_WATCHDOG_MS,
              ).unref?.()
            }),
          ])
        } catch (error) {
          void deps.logDiagnostic({
            level: 'warning',
            source: 'sprintengine',
            title: 'Sprint scheduler tick failed',
            message: `The main-process auto-run tick failed for ${entry.workspaceName}; it retries once the current attempt settles.`,
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
    /**
     * The registered run a workspace's auto-run events belong to (MC-1754
     * Phase 3): feeds the on-disk runner log's per-run file resolution.
     * First match wins — a workspace holds one active sprint run entry.
     */
    resolveRunnerLogTarget(workspaceId: string): { statePath: string; folderPath: string | null } | null {
      for (const entry of runsByStatePath.values()) {
        if (entry.view.id === workspaceId) {
          return { statePath: entry.statePath, folderPath: entry.view.folderPath ?? null }
        }
      }
      return null
    },
    /** Renderer announces/refreshes a sprint run's context. Idempotent upsert. */
    registerRun(registration: SprintRuntimeRunRegistration): void {
      if (disposed) return
      const existing = runsByStatePath.get(registration.statePath)
      const teamDirectoryPath = dirname(registration.statePath)
      const teamSlug = basename(teamDirectoryPath)
      // A boot-discovered run (MC-2153) holds a PLACEHOLDER workspace id until
      // the window that owns it registers, and it can have spawned agents under
      // it already. Move that run's sessions onto the announced id — the
      // workspace-keyed lookups outside the scheduler (the board's "is this
      // agent live?", duplicate-session disposal) would otherwise miss a live
      // agent and start a second one. Unconditional and idempotent, so it also
      // catches a session minted by a spawn that was still in flight during an
      // earlier hand-off.
      deps.terminal.adoptWorkspaceId?.({
        statePath: registration.statePath,
        workspaceId: registration.workspaceId,
      })
      if (existing) {
        // Context refresh: identity + run configuration follow the renderer;
        // scheduler-owned runtime residue (delivered keys, runtimeState) stays
        // main-owned once adopted.
        if (existing.view.id !== registration.workspaceId) {
          if (runsByWorkspaceId.get(existing.view.id) === existing) {
            runsByWorkspaceId.delete(existing.view.id)
          }
          // The in-flight spawn ledger is keyed `<workspaceId>:<agentId>`: carry
          // its entries too, or a spawn already in flight looks absent and the
          // next tick spawns the same agent twice.
          rekeyInFlightSpawns(existing, existing.view.id, registration.workspaceId)
          existing.view.id = registration.workspaceId
        }
        // Unconditional re-insert (newest registration wins) heals a mapping
        // lost to a same-workspace old-run unregister.
        runsByWorkspaceId.set(registration.workspaceId, existing)
        existing.workspaceName = registration.workspaceName
        existing.view.name = registration.workspaceName
        existing.view.folderPath = registration.folderPath
        existing.view.memory = { relativeRoot: registration.memoryRelativeRoot }
        existing.view.sprintEngineAutoState = {
          ...currentAutoState(existing),
          cliPermissionPreset: registration.cliPermissionPreset,
          maxConcurrentAgents: registration.maxConcurrentAgents,
        }
        mergeAgentConfigs(existing, registration.agentConfigs)
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
            // Desired mode stays 'manual' until the authoritative sidecar
            // read/hydration lands (a scheduler must never spawn on a guess);
            // the renderer-persisted lifecycle seeds now so that adoption can
            // preserve a paused/blocked/failed/complete run instead of
            // forcing it back to 'running'.
            desiredMode: 'manual',
            runtimeState: registration.runtimeState ?? 'idle',
            ...(registration.reason !== undefined ? { reason: registration.reason } : {}),
            ...(registration.reasonMessage !== undefined
              ? { reasonMessage: registration.reasonMessage }
              : {}),
            ...(registration.reasonTaskId !== undefined
              ? { reasonTaskId: registration.reasonTaskId }
              : {}),
            ...(registration.reasonAgentId !== undefined
              ? { reasonAgentId: registration.reasonAgentId }
              : {}),
            cliPermissionPreset: registration.cliPermissionPreset,
            maxConcurrentAgents: registration.maxConcurrentAgents,
            deliveredAgentNotificationEventKeys: registration.deliveredAgentNotificationEventKeys,
            ...(registration.completionTeardownAt !== undefined
              ? { completionTeardownAt: registration.completionTeardownAt }
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
        tickInFlight: false,
        refs: {
          inFlightSpawns: { current: new Set() },
          sentArtifactApprovalMessages: { current: new Map() },
          autoApprovalDiagnostics: { current: new Map() },
          sentContinuationMessages: { current: new Map() },
          sentDispatchMessages: { current: new Map() },
          sentArchitectTriageMessages: { current: new Map() },
          sentAgentNotificationEvents: { current: new Set() },
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
      // Same-mode reads are skipped (mirroring notifyAutomationChanged): a
      // concurrent write's notify may have already applied a transition, and a
      // stale same-mode re-apply would restart a just-paused run.
      void deps.readAutomationMode(registration.statePath)
        .then((record) => {
          if (!record || disposed) return
          const target = runsByStatePath.get(registration.statePath)
          if (!target) return
          // The sidecar's runtime residue is MAIN's own durable bookkeeping
          // and supersedes the renderer-mirrored residue the registration
          // seeded (which can be stale after a headless completion or a
          // window that missed broadcasts).
          if (record.runtime) {
            target.view.sprintEngineAutoState = {
              ...currentAutoState(target),
              deliveredAgentNotificationEventKeys: record.runtime.deliveredAgentNotificationEventKeys,
              ...(record.runtime.completionTeardownAt !== undefined
                ? { completionTeardownAt: record.runtime.completionTeardownAt }
                : {}),
            }
            target.rosterSessions = { ...target.rosterSessions, ...record.runtime.rosterSessions }
          }
          adoptDesiredMode(target, record)
        })
        .catch(() => undefined)
    },

    /**
     * The Phase 1 service hydrated a legacy run's sidecar (first write, no
     * broadcast): adopt the now-authoritative mode here — without this a
     * freshly created or legacy run whose registration raced the hydration
     * would sit at `manual` in the scheduler forever while the board showed
     * an automation mode. Lifecycle-preserving (see `adoptDesiredMode`).
     */
    adoptAutomationRecord(statePath: string, record: SprintEngineAutomationIntentRecord): void {
      const entry = runsByStatePath.get(statePath)
      if (!entry) return
      adoptDesiredMode(entry, record)
    },

    /** Renderer stops tracking a run (workspace removed). */
    unregisterRun(statePath: string): void {
      const entry = runsByStatePath.get(statePath)
      if (!entry) return
      runsByStatePath.delete(statePath)
      // Only drop the workspace mapping when this entry still owns it — a
      // newer run in the same workspace (new team dir) may have taken it
      // over, and deleting blindly would orphan that run's port lookups.
      if (runsByWorkspaceId.get(entry.view.id) === entry) {
        runsByWorkspaceId.delete(entry.view.id)
      }
      deps.powerManager.markRunInactive(statePath)
    },

    /**
     * Renderer-originated resume (the board's Resume control, a future mobile
     * resume): a paused/blocked/failed run re-enters `running` without a mode
     * change — `runner_started` is the designed same-mode recovery gesture and
     * has no other path into main (same-mode intent writes are structural
     * no-ops by design). Wakes the tick loop immediately.
     */
    applyResume(statePath: string): void {
      const entry = runsByStatePath.get(statePath)
      if (!entry) return
      applyAutomationEventToView(entry, { type: 'runner_started' })
      if (sprintEngineAutomationShouldRun(entry.view.sprintEngineAutoState)) void tick()
    },

    /**
     * Input-resolution recovery: a run the cycle parked on `blocked` re-enters
     * `running` once a needs_input resolution lands (the engine mutation has
     * already moved the task out of needs_input, so the next cycle only
     * re-blocks if a DIFFERENT user blocker remains — the correct outcome).
     * Deliberately narrower than applyResume: `paused` is a user gesture and
     * `failed` needs attention — resolving an input must restart neither.
     * Unlike applyResume (whose initiating window applies runner_started
     * locally), this transition originates in main, so it broadcasts
     * `automation_resumed` for every window to clear its Blocked pill.
     */
    resumeIfBlocked(statePath: string): void {
      const entry = runsByStatePath.get(statePath)
      if (!entry) return
      if (currentAutoState(entry).runtimeState !== 'blocked') return
      applyAutomationEventToView(entry, { type: 'runner_started' })
      deps.broadcastOp({ kind: 'automation_resumed', statePath })
      if (sprintEngineAutomationShouldRun(entry.view.sprintEngineAutoState)) void tick()
    },

    /**
     * User-initiated run cancellation (MC-1604). Called after the engine cancel
     * op has written run/task status; parks the run in terminal `canceled`
     * dormancy with the shared completion teardown (records sessions, disposes
     * PTYs, removes panels, stops polling). Safe for a paused/manual run too.
     */
    cancelRun(statePath: string): void {
      cancelRun(statePath)
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

    /**
     * Every run the scheduler holds, with whether it is actively auto-running
     * (MC-2156). Read by the background tray, which must answer "what is still
     * going?" with no window open — so it reads the scheduler's own map rather
     * than a renderer projection.
     */
    listRuns(): Array<{ statePath: string; name: string; autoRunning: boolean }> {
      return [...runsByStatePath.values()].map((entry) => ({
        statePath: entry.statePath,
        name: entry.view.name || entry.workspaceName,
        autoRunning: sprintEngineAutomationShouldRun(currentAutoState(entry)),
      }))
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

export type { SprintRuntimeRunRegistration, SprintRuntimeStopReasonPush }
