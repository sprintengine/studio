/**
 * Renderer host of the Sprint Engine auto-run RECONCILE phase — view-only.
 *
 * Scheduling (superviseWorkspace: dispatch planning, spawning, retirement,
 * dormancy) is owned by the main-process scheduler in
 * `src/main/sprint-runtime.ts` (sprint-runtime-ownership Phase 2), which
 * drives the shared cycle in `src/shared/sprintengine/auto-run-cycle.ts` and
 * mirrors its store mutations back through `sprintengineRuntimeBridge.ts`.
 * The component below only reconciles this window's agent launch flags
 * against live terminal sessions (`reconcileWorkspaceSessions`) so the UI
 * never shows a launched agent whose PTY is gone.
 *
 * This file also keeps the renderer-bound pieces of the shared cycle:
 *
 * - `rendererCyclePorts`: the cycle's port surface bound to `window.api`
 *   (via the executor default ports), the Zustand store, the
 *   `workspaceSyncClient` session-identity mirror, `modelRegistry`,
 *   `crypto.randomUUID`, and the renderer projection-refresh / dormancy /
 *   teardown helpers.
 * - `cycleState`: the cross-tick in-memory ledgers, created at module level to
 *   preserve the previous module-level lifetime.
 * - The poll loop (`createAutoRunPollerController`) and the React component
 *   that drives reconcile ticks.
 * - Bound re-exports of every cycle function the existing tests and callers
 *   import from this module, with their historical signatures.
 */

import { useEffect, useRef, type MutableRefObject } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { workspaceSyncClient } from '../../store/workspaceSyncClient'
import type {
  AgentCli,
  CliRuntimeSettings,
  McpSettings,
  SprintEngineState,
  Workspace,
} from '../../types/workspace'
import {
  AUTO_RUN_IDLE_RETIREMENT_MS as PLANNER_IDLE_RETIREMENT_MS,
  AUTO_RUN_RETIREMENT_COOLDOWN_MS,
  AUTO_RUN_MAX_PROMPT_RETRIES as PLANNER_MAX_PROMPT_RETRIES,
  AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES as PLANNER_MAX_WAKE_RETRIES,
  type AutoRunCandidate,
  type SprintEngineDispatchAttempt,
  type SprintEngineDispatchPlan,
} from '../../utils/sprintengineAutoRun'
import {
  createDefaultSprintEngineAutoRunExecutorPorts,
  listTerminalSessionsForAutoRun as executorListTerminalSessionsForAutoRun,
  type SprintEngineAutoRunExecutorPorts,
} from '../../utils/sprintengineAutoRunExecutor'
import {
  createSprintEngineAutoRunCycleState,
  deliverAgentNotificationEvents as cycleDeliverAgentNotificationEvents,
  enterDormancyIfRunComplete as cycleEnterDormancyIfRunComplete,
  escalateStalledLiveIdleAgents as cycleEscalateStalledLiveIdleAgents,
  executeSprintEngineDispatchPlan as cycleExecuteSprintEngineDispatchPlan,
  getSprintEngineAutoState,
  isSprintEngineRunnerActive,
  reconcileWorkspaceSessions as cycleReconcileWorkspaceSessions,
  respawnDeadSprintEngineClaimants as cycleRespawnDeadSprintEngineClaimants,
  sendApprovalToNextEligibleArtifactProducer as cycleSendApprovalToNextEligibleArtifactProducer,
  sendContinuationPromptsToIdleAgents as cycleSendContinuationPromptsToIdleAgents,
  sendDispatchPromptsToRunningAgents as cycleSendDispatchPromptsToRunningAgents,
  spawnAutoRunCandidate as cycleSpawnAutoRunCandidate,
  sprintEngineArtifactApprovalDesired,
  superviseRunnerActiveCycle as cycleSuperviseRunnerActiveCycle,
  type RunningContinuationCapacity,
  type SprintEngineAutoRunCyclePorts,
  type SprintEngineAutoRunDormancyPorts,
  type SprintEngineDispatchExecution,
  type SprintEngineDispatchLedgers,
  type SprintEngineDispatchSpawnContext,
  type SprintEngineRunnerActiveCycleInput,
} from '../../../../shared/sprintengine/auto-run-cycle'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { MULTICODE_DISABLE_SPRINTENGINE_AUTORUN } from '../../utils/runtimeFlags'
import { isAgentTabVisible, type AgentTerminalRevealPolicy } from '../../utils/modelRegistry'
import {
  enterSprintEngineDormancy,
  refreshSprintEngineWorkspaceProjection,
  type SprintEngineDormancyPorts,
} from '../../utils/sprintengineProjectionRefresh'
import {
  tearDownCompletedSprintRunAgents,
  tearDownDepartedTaskScopedWorker,
} from '../../utils/sprintengineRunTeardown'
import { registerTimer, type TimerHandle } from '../../utils/diagnostics/timerRegistry'
import { deriveSprintEngineAutomationMode } from '../../utils/sprintengineAutomation'

export { TerminalListIpcError } from '../../utils/sprintengineAutoRunExecutor'
export type {
  SprintEngineDispatchExecution,
  SprintEngineDispatchLedgers,
  SprintEngineDispatchSpawnContext,
} from '../../../../shared/sprintengine/auto-run-cycle'

const defaultExecutorPorts: SprintEngineAutoRunExecutorPorts =
  createDefaultSprintEngineAutoRunExecutorPorts()

// Cross-tick cycle ledgers. Module-level (not per component instance) to
// preserve the lifetime the previous module-level maps/sets had.
const cycleState = createSprintEngineAutoRunCycleState()

export function listTerminalSessionsForAutoRun(
  workspace: Workspace,
  cause: string
): Promise<TerminalSessionSnapshot[]> {
  return executorListTerminalSessionsForAutoRun(defaultExecutorPorts, workspace, cause)
}

// SprintEngine is a background runner: agents do not need re-engagement within
// a couple of seconds, and every active tick does O(terminals) IPC plus planning
// on the renderer's main thread — the same thread that handles keystrokes and
// clicks. A 4s cadence halves that per-second cost (and the projection read it
// pairs with) for no user-visible loss in a long-running run.
const AUTO_RUN_POLL_MS = 4000
const INACTIVE_AUTO_RUN_POLL_MS = 15000
export const AUTO_RUN_MAX_PROMPT_RETRIES = PLANNER_MAX_PROMPT_RETRIES
export const AUTO_RUN_IDLE_RETIREMENT_MS = PLANNER_IDLE_RETIREMENT_MS
export { AUTO_RUN_RETIREMENT_COOLDOWN_MS }
export const AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES = PLANNER_MAX_WAKE_RETRIES

type RoleContinuationMessage = SprintEngineDispatchAttempt

// Ports for entering dormancy from the supervisor's hard-completion gate: the
// same completion transition the projection reconcile (T1) uses. Routing the gate
// through it binds teardown to the completion this 4s poll may detect first —
// rather than to a follow-up poll that dormancy is about to stop.
const supervisorDormancyPorts: SprintEngineDormancyPorts = {
  applySprintEngineAutomationEvent: (workspaceId, event) =>
    useWorkspaceStore.getState().applySprintEngineAutomationEvent(workspaceId, event),
  tearDownCompletedRunAgents: (workspaceId) => tearDownCompletedSprintRunAgents(workspaceId),
  setCompletionTeardownAt: (workspaceId, at) =>
    useWorkspaceStore.getState().setSprintEngineCompletionTeardownAt(workspaceId, at),
}

// The cycle's port surface bound to the renderer environment: the executor
// default ports (window.api / store / diagnostics / reveal policy) plus the
// cycle-specific seams — store touchpoints, the workspaceSyncClient
// session-identity mirror, the projection refresh, the dormancy transition,
// the departed-worker teardown, tab visibility, and UUID minting.
const rendererCyclePorts: SprintEngineAutoRunCyclePorts = {
  ...defaultExecutorPorts,
  getActiveWorkspaceId: () => useWorkspaceStore.getState().activeWorkspaceId,
  getPluginCatalogEntries: () => useWorkspaceStore.getState().pluginCatalogEntries,
  getSpawnSettings: () => {
    const { appSettings } = useWorkspaceStore.getState()
    return {
      projectKnowledgeRoots: appSettings.projectKnowledgeRoots,
      sprintEngineModelCatalog: appSettings.sprintEngineModelCatalog,
    }
  },
  dispatchAssignTerminalSession: (workspaceId, agentId, sessionId, cli) =>
    workspaceSyncClient.dispatchAssignTerminalSession(workspaceId, agentId, sessionId, cli),
  dispatchUpdateTerminalLaunchState: (workspaceId, agentId, update) =>
    workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspaceId, agentId, update),
  refreshWorkspaceProjection: (input) =>
    refreshSprintEngineWorkspaceProjection({
      // The cycle threads the view type; at runtime this is always the real
      // store workspace object.
      workspace: input.workspace as Workspace,
      tokens: input.tokens,
      cause: input.cause,
      force: input.force,
      ports: {
        readSprintEngineProjection: defaultExecutorPorts.readSprintEngineProjection,
        setSprintEngineState: defaultExecutorPorts.setSprintEngineState,
      },
    }),
  enterDormancy: (workspace, dormancyPorts?: SprintEngineAutoRunDormancyPorts) =>
    enterSprintEngineDormancy(
      workspace as Pick<Workspace, 'id' | 'sprintEngineAutoState'>,
      dormancyPorts ?? supervisorDormancyPorts,
    ),
  tearDownDepartedTaskScopedWorker: (workspaceId, agentId, preloadedSessions) =>
    tearDownDepartedTaskScopedWorker(workspaceId, agentId, undefined, preloadedSessions),
  isAgentTabVisible: (workspaceId, agentId) => isAgentTabVisible(workspaceId, agentId),
  randomUUID: () => crypto.randomUUID(),
}

// Hard-completion gate over the shared cycle helper; see auto-run-cycle.ts.
// Kept as a renderer export (with the store-bound default dormancy ports) for
// the existing test surface and callers.
export function enterDormancyIfRunComplete(
  workspace: Pick<Workspace, 'id' | 'sprintEngineAutoState'>,
  sprintEngineState: Pick<SprintEngineState, 'tasks'>,
  ports: SprintEngineDormancyPorts = supervisorDormancyPorts,
): boolean {
  return cycleEnterDormancyIfRunComplete(rendererCyclePorts, workspace, sprintEngineState, ports)
}

export type AutoRunPollerController = {
  /** Start or stop the poll interval + timer to match current demand. Idempotent. */
  sync: () => void
  /** Effect-cleanup: clear the interval and unregister the timer if live. */
  dispose: () => void
}

// Owns the auto-run poll interval and its registered timer, keeping BOTH alive
// only while `isPollerNeeded` holds (at least one workspace is running a
// non-manual automation). When nothing needs it — every run manual, finished, or
// dormant — there is no live interval and no 'SprintEngine auto-run poll' timer,
// so the renderer does no per-4s O(workspaces) scan or perf emission. `sync()` is
// re-invoked from a store subscription, so a `user_set_mode` back to a running
// mode re-arms the poller. Timer/interval ports are injectable for tests.
export function createAutoRunPollerController(ports: {
  isPollerNeeded: () => boolean
  tick: () => Promise<void> | void
  registerTimer?: (label: string, cadenceMs: number) => TimerHandle
  setInterval?: (handler: () => void, ms: number) => number
  clearInterval?: (id: number) => void
}): AutoRunPollerController {
  const registerTimerFn = ports.registerTimer ?? registerTimer
  const setIntervalFn = ports.setInterval ?? ((handler, ms) => window.setInterval(handler, ms))
  const clearIntervalFn = ports.clearInterval ?? ((id: number) => window.clearInterval(id))

  let timer: TimerHandle | null = null
  let interval: number | null = null
  let disposed = false

  const runTick = (): void => {
    const startedAt = performance.now()
    void Promise.resolve(ports.tick()).finally(() => timer?.recordTick(performance.now() - startedAt))
  }

  const sync = (): void => {
    if (disposed) return
    const needed = ports.isPollerNeeded()
    if (needed && interval === null) {
      timer = registerTimerFn('SprintEngine auto-run poll', AUTO_RUN_POLL_MS)
      runTick()
      interval = setIntervalFn(runTick, AUTO_RUN_POLL_MS)
    } else if (!needed && interval !== null) {
      clearIntervalFn(interval)
      interval = null
      timer?.unregister()
      timer = null
    }
  }

  const dispose = (): void => {
    disposed = true
    if (interval !== null) {
      clearIntervalFn(interval)
      interval = null
    }
    timer?.unregister()
    timer = null
  }

  return { sync, dispose }
}

export async function sendApprovalToNextEligibleArtifactProducer(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  sentArtifactApprovalMessages: MutableRefObject<Map<string, number>>,
  autoApprovalDiagnostics: MutableRefObject<Map<string, number>>,
  projectionTokensByWorkspace: MutableRefObject<Map<string, string>>
): Promise<'sent' | 'failed' | 'none'> {
  return cycleSendApprovalToNextEligibleArtifactProducer(
    rendererCyclePorts,
    workspace,
    sprintEngineState,
    sentArtifactApprovalMessages,
    autoApprovalDiagnostics,
    projectionTokensByWorkspace,
  )
}

export async function deliverAgentNotificationEvents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>,
  sentAgentNotificationEvents: MutableRefObject<Set<string>>
): Promise<'started' | 'failed' | 'none'> {
  return cycleDeliverAgentNotificationEvents(
    rendererCyclePorts,
    cycleState,
    workspace,
    sprintEngineState,
    runningAgentIds,
    cliRuntimes,
    mcpSettings,
    inFlightSpawns,
    sentAgentNotificationEvents,
  )
}

export async function executeSprintEngineDispatchPlan(
  workspace: Workspace,
  plan: SprintEngineDispatchPlan,
  ledgers: SprintEngineDispatchLedgers,
  spawnContext?: SprintEngineDispatchSpawnContext,
  /** Records the time each agent is retired so the planner can enforce the re-retirement cooldown across ticks. */
  retirementCooldown?: Map<string, number>,
  /** Reuse the caller's per-cycle terminal snapshot instead of fetching a fresh one for session lookups. */
  sharedSessionsSnapshot?: TerminalSessionSnapshot[]
): Promise<SprintEngineDispatchExecution> {
  return cycleExecuteSprintEngineDispatchPlan(
    rendererCyclePorts,
    cycleState,
    workspace,
    plan,
    ledgers,
    spawnContext,
    retirementCooldown,
    sharedSessionsSnapshot,
  )
}

export async function respawnDeadSprintEngineClaimants(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: ReadonlySet<string>,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>,
  spawnDeps: {
    cliRuntimes: Record<AgentCli, CliRuntimeSettings>
    mcpSettings: McpSettings
    inFlightSpawns: MutableRefObject<Set<string>>
  }
): Promise<void> {
  return cycleRespawnDeadSprintEngineClaimants(
    rendererCyclePorts,
    cycleState,
    workspace,
    sprintEngineState,
    runningAgentIds,
    continuationCapacity,
    sentContinuationMessages,
    spawnDeps,
  )
}

export async function sendContinuationPromptsToIdleAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<void> {
  return cycleSendContinuationPromptsToIdleAgents(
    rendererCyclePorts,
    cycleState,
    workspace,
    sprintEngineState,
    continuationCapacity,
    sentContinuationMessages,
  )
}

export async function escalateStalledLiveIdleAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  continuationCapacity: RunningContinuationCapacity,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<'restarted' | 'none'> {
  return cycleEscalateStalledLiveIdleAgents(
    rendererCyclePorts,
    cycleState,
    workspace,
    sprintEngineState,
    continuationCapacity,
    sentContinuationMessages,
  )
}

export async function sendDispatchPromptsToRunningAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  runningAgentIds: Set<string>,
  sentDispatchMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<void> {
  return cycleSendDispatchPromptsToRunningAgents(
    rendererCyclePorts,
    cycleState,
    workspace,
    sprintEngineState,
    runningAgentIds,
    sentDispatchMessages,
  )
}

export async function spawnAutoRunCandidate(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  nextRun: AutoRunCandidate,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  mcpSettings: McpSettings,
  inFlightSpawns: MutableRefObject<Set<string>>,
  options: { trackPendingSpawn?: boolean; revealPolicy?: AgentTerminalRevealPolicy } = {}
): Promise<'started' | 'failed' | 'skipped'> {
  return cycleSpawnAutoRunCandidate(
    rendererCyclePorts,
    workspace,
    sprintEngineState,
    nextRun,
    cliRuntimes,
    mcpSettings,
    inFlightSpawns,
    options,
  )
}

export async function superviseRunnerActiveCycle(
  input: SprintEngineRunnerActiveCycleInput
): Promise<void> {
  return cycleSuperviseRunnerActiveCycle(rendererCyclePorts, cycleState, input)
}

function reconcileWorkspaceSessions(workspace: Workspace): Promise<void> {
  return cycleReconcileWorkspaceSessions(rendererCyclePorts, cycleState, workspace)
}

export default function SprintEngineAutoRunSupervisor() {
  const lastInactiveTickByWorkspace = useRef(new Map<string, number>())
  const tickInProgress = useRef(false)

  useEffect(() => {
    if (MULTICODE_DISABLE_SPRINTENGINE_AUTORUN) {
      console.info('[SprintEngineAutoRun] disabled by runtime flag')
      return
    }

    let disposed = false

    const tick = async () => {
      if (tickInProgress.current) return
      tickInProgress.current = true

      try {
        const tickStartedAt = performance.now()
        const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState()
        const now = Date.now()
        const autoWorkspaces = workspaces.filter((workspace) =>
          isSprintEngineRunnerActive(workspace)
        ).filter((workspace) => {
          if (workspace.id === activeWorkspaceId) return true

          const lastTick = lastInactiveTickByWorkspace.current.get(workspace.id) ?? 0
          if (now - lastTick < INACTIVE_AUTO_RUN_POLL_MS) return false
          lastInactiveTickByWorkspace.current.set(workspace.id, now)
          return true
        })

        lastInactiveTickByWorkspace.current.forEach((_, workspaceId) => {
          if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
            lastInactiveTickByWorkspace.current.delete(workspaceId)
          }
        })
        logPerfEvent('SprintEngineAutoRun', 'tick-start', {
          activeWorkspaceId,
          autoWorkspaceCount: autoWorkspaces.length,
          autoWorkspaces: autoWorkspaces.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            enabled: isSprintEngineRunnerActive(workspace),
            automationMode: deriveSprintEngineAutomationMode(getSprintEngineAutoState(workspace), workspace.sprintEngineState?.runner),
            runnerCliWatchPolling: workspace.sprintEngineState?.runner?.cliWatchPolling ?? null,
            runtimeState: getSprintEngineAutoState(workspace).runtimeState ?? null,
            artifactApprovalDesired: sprintEngineArtifactApprovalDesired(getSprintEngineAutoState(workspace)),
          })),
        })

        // Reconcile only: the supervise (scheduling) phase moved to the
        // main-process scheduler (src/main/sprint-runtime.ts), which drives
        // the same shared cycle and mirrors its store mutations back through
        // the runtime bridge.
        const eligibleWorkspaceIds = new Set(autoWorkspaces.map((workspace) => workspace.id))
        const refreshedState = useWorkspaceStore.getState()
        for (const workspace of refreshedState.workspaces.filter((candidate) => eligibleWorkspaceIds.has(candidate.id))) {
          if (disposed) return
          await reconcileWorkspaceSessions(workspace)
        }

        logPerfEvent('SprintEngineAutoRun', 'tick-end', {
          elapsedMs: Math.round(performance.now() - tickStartedAt),
          autoWorkspaceCount: autoWorkspaces.length,
        })
      } finally {
        tickInProgress.current = false
      }
    }

    // The poll interval + timer exist only while at least one workspace is
    // running a non-manual automation. A store change (e.g. a run finishing into
    // dormancy, or a user re-selecting a running mode) re-evaluates demand and
    // starts/stops the loop, so a fully manual/finished set of workspaces holds
    // no live interval and no registered timer.
    const controller = createAutoRunPollerController({
      isPollerNeeded: () =>
        useWorkspaceStore.getState().workspaces.some((workspace) => isSprintEngineRunnerActive(workspace)),
      tick,
    })
    controller.sync()
    const unsubscribe = useWorkspaceStore.subscribe(() => controller.sync())

    return () => {
      disposed = true
      unsubscribe()
      controller.dispose()
    }
  }, [])

  // The 10-minute background PR merge sweep was removed: it was a forever
  // `gh`-subprocess + forced-projection-read loop that kept running even for
  // finished, dormant runs. The open run summary still polls the active
  // workspace, and on-demand PR refresh for a workspace is delivered by T4, so no
  // renderer timer needs to poll merge state for non-open workspaces.

  return null
}
