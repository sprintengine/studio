/**
 * Renderer bindings for the shared Sprint Engine auto-run cycle.
 *
 * The auto-run supervisor is retired (sprint-runtime-ownership Phase 3): the
 * renderer runs NO scheduling and no reconcile loop — the main-process
 * scheduler (`src/main/sprint-runtime.ts`) drives the shared cycle
 * (`src/shared/sprintengine/auto-run-cycle.ts`), including per-tick session
 * reconcile, and mirrors every store mutation back through
 * `sprintengineRuntimeBridge.ts`. The renderer keeps board/roster/terminal
 * views and manual controls only.
 *
 * What remains here are the renderer-environment bindings:
 *
 * - `rendererCyclePorts`: the cycle's port surface bound to `window.api`
 *   (via the executor default ports), the Zustand store, the
 *   `workspaceSyncClient` session-identity mirror, `modelRegistry`,
 *   `crypto.randomUUID`, and the renderer projection-refresh / dormancy /
 *   teardown helpers — used by the bound re-exports below and by manual
 *   renderer paths (e.g. board-driven dormancy).
 * - `cycleState`: cross-call in-memory ledgers, module-level to preserve the
 *   historical lifetime.
 * - `createAutoRunPollerController`: the (no longer production-mounted)
 *   demand-gated poller, kept for its test surface.
 * - Bound re-exports of every cycle function the existing tests and callers
 *   historically imported from the supervisor, with unchanged signatures.
 */

import { useWorkspaceStore } from '../store/workspaceStore'
import { workspaceSyncClient } from '../store/workspaceSyncClient'

// Structural mirror of React's MutableRefObject — callers pass React refs,
// which remain assignable; this module itself has no React dependency.
type MutableRefObject<T> = { current: T }
import type {
  AgentCli,
  CliRuntimeSettings,
  McpSettings,
  SprintEngineState,
  Workspace,
} from '../types/workspace'
import {
  AUTO_RUN_IDLE_RETIREMENT_MS as PLANNER_IDLE_RETIREMENT_MS,
  AUTO_RUN_RETIREMENT_COOLDOWN_MS,
  AUTO_RUN_MAX_PROMPT_RETRIES as PLANNER_MAX_PROMPT_RETRIES,
  AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES as PLANNER_MAX_WAKE_RETRIES,
  type AutoRunCandidate,
  type SprintEngineDispatchAttempt,
  type SprintEngineDispatchPlan,
} from './sprintengineAutoRun'
import {
  createDefaultSprintEngineAutoRunExecutorPorts,
  listTerminalSessionsForAutoRun as executorListTerminalSessionsForAutoRun,
  type SprintEngineAutoRunExecutorPorts,
} from './sprintengineAutoRunExecutor'
import {
  createSprintEngineAutoRunCycleState,
  deliverAgentNotificationEvents as cycleDeliverAgentNotificationEvents,
  enterDormancyIfRunComplete as cycleEnterDormancyIfRunComplete,
  escalateStalledLiveIdleAgents as cycleEscalateStalledLiveIdleAgents,
  executeSprintEngineDispatchPlan as cycleExecuteSprintEngineDispatchPlan,
  reconcileWorkspaceSessions as cycleReconcileWorkspaceSessions,
  respawnDeadSprintEngineClaimants as cycleRespawnDeadSprintEngineClaimants,
  sendApprovalToNextEligibleArtifactProducer as cycleSendApprovalToNextEligibleArtifactProducer,
  sendContinuationPromptsToIdleAgents as cycleSendContinuationPromptsToIdleAgents,
  sendDispatchPromptsToRunningAgents as cycleSendDispatchPromptsToRunningAgents,
  spawnAutoRunCandidate as cycleSpawnAutoRunCandidate,
  superviseRunnerActiveCycle as cycleSuperviseRunnerActiveCycle,
  type SprintEngineAutoRunCyclePorts,
  type SprintEngineAutoRunDormancyPorts,
  type SprintEngineDispatchExecution,
  type SprintEngineDispatchLedgers,
  type SprintEngineDispatchSpawnContext,
  type SprintEngineRunnerActiveCycleInput,
} from '../../../shared/sprintengine/auto-run-cycle'
import { isAgentTabVisible, type AgentTerminalRevealPolicy } from './modelRegistry'
import {
  enterSprintEngineDormancy,
  refreshSprintEngineWorkspaceProjection,
  type SprintEngineDormancyPorts,
} from './sprintengineProjectionRefresh'
import {
  tearDownCompletedSprintRunAgents,
  tearDownDepartedTaskScopedWorker,
} from './sprintengineRunTeardown'
import { registerTimer, type TimerHandle } from './diagnostics/timerRegistry'

export { TerminalListIpcError } from './sprintengineAutoRunExecutor'
export {
  getSprintEngineAutoState,
  isSprintEngineRunnerActive,
  sprintEngineArtifactApprovalDesired,
} from '../../../shared/sprintengine/auto-run-cycle'
export type {
  SprintEngineDispatchExecution,
  SprintEngineDispatchLedgers,
  SprintEngineDispatchSpawnContext,
} from '../../../shared/sprintengine/auto-run-cycle'

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
  getPluginCatalogEntries: () => useWorkspaceStore.getState().pluginCatalogEntries,
  getSpawnSettings: () => {
    const { appSettings } = useWorkspaceStore.getState()
    return {
      projectKnowledgeRoots: appSettings.projectKnowledgeRoots,
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
  idleAgentIds: ReadonlySet<string>,
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
    idleAgentIds,
    sentContinuationMessages,
    spawnDeps,
  )
}

export async function sendContinuationPromptsToIdleAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  idleAgentIds: ReadonlySet<string>,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<void> {
  return cycleSendContinuationPromptsToIdleAgents(
    rendererCyclePorts,
    cycleState,
    workspace,
    sprintEngineState,
    idleAgentIds,
    sentContinuationMessages,
  )
}

export async function escalateStalledLiveIdleAgents(
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  idleAgentIds: ReadonlySet<string>,
  sentContinuationMessages: MutableRefObject<Map<string, RoleContinuationMessage>>
): Promise<'restarted' | 'none'> {
  return cycleEscalateStalledLiveIdleAgents(
    rendererCyclePorts,
    cycleState,
    workspace,
    sprintEngineState,
    idleAgentIds,
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
  options: { revealPolicy?: AgentTerminalRevealPolicy } = {}
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

/**
 * Renderer-bound session reconcile. No production loop calls this since the
 * main scheduler owns per-tick reconcile (Phase 3); kept for the historical
 * test surface and any manual renderer path that needs a one-shot reconcile.
 */
export function reconcileWorkspaceSessions(workspace: Workspace): Promise<void> {
  return cycleReconcileWorkspaceSessions(rendererCyclePorts, cycleState, workspace)
}
