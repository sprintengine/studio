import { randomUUID } from 'node:crypto'

import type {
  AutomationDefinition,
  AutomationRun,
  AutomationRunEventStatus,
  AutomationRunEventTrigger,
  AutomationRunStatus,
  AutomationTriggerPollEvent,
  AutomationTriggerPollContext,
  AutomationTriggerProvider,
  AutomationsRunEvent,
  ScheduleTriggerConfig,
} from '../../shared/automations/contracts'
import type { AgentPhaseEvent } from '../../shared/agent-runtime'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { deriveActivityFromPhase, isAgentTurnEndEvent, isAgentTurnFailureEvent } from '../agent-state'
import { AutomationsStore, type AutomationStoreProblem, type AutomationStoreState } from './store'
import type { AutomationPullRequestResult } from './pull-request'
import { computeNextRun, scheduleCadenceCanExhaust, validateScheduleTriggerConfig } from './schedule'
import { evaluatePollingTriggerDefinition } from './polling-trigger-runner'
import { readTranscriptSummary } from './transcript-summary'
import { enqueueTriggerEventRun, type TriggerEventRunResult } from './trigger-event-runner'

export type AutomationsProjectFolder = {
  workspaceId: string
  folderPath: string
}

export type AutomationRunExecutionInput = {
  workspaceRoot: string
  definition: AutomationDefinition
  run: AutomationRun
  triggerPayload: Record<string, unknown>
  // An explicit workspace an agent-backed run launches its agent into (legacy /
  // MCP callers), so it is not spawned in a freshly created standard workspace.
  // Undefined for runs with no explicit target — the common case now that the
  // Automations surface is a global screen rather than a per-project workspace.
  workspaceId?: string
}

export type AutomationRunExecutor = (input: AutomationRunExecutionInput) => Promise<Partial<AutomationRun>>

export type AutomationsEngineProblem = {
  workspaceRoot?: string
  automationId?: string
  code: string
  message: string
}

export type AutomationsEngineRunSummary = {
  workspaceRoot: string
  automationId: string
  runId: string
  status: AutomationRunStatus
}

export type AutomationsEngineEvaluationResult = {
  scheduled: { workspaceRoot: string; automationId: string; nextRunAt: string }[]
  fired: AutomationsEngineRunSummary[]
  skipped: AutomationsEngineRunSummary[]
  droppedInFlight: { workspaceRoot: string; automationId: string }[]
  problems: AutomationsEngineProblem[]
}

export type AutomationsEngineRunNowResult =
  | { ok: true; definition: AutomationDefinition; run: AutomationRun }
  | { ok: false; problem: AutomationsEngineProblem }

export type AutomationsEngineTriggerEventDeliveryResult =
  | { ok: true; definition: AutomationDefinition; delivery: Exclude<TriggerEventRunResult, { status: 'problem' }> }
  | { ok: false; problem: AutomationsEngineProblem }

export type AutomationsEngineFinalizeResult =
  | { ok: true; run: AutomationRun }
  | { ok: false; problem: AutomationsEngineProblem }

export type AutomationRunPullRequestOpener = (input: {
  workspaceRoot: string
  worktreePath: string
  branch: string
  title: string
  body: string
  // Gates the backstop commit/push: a review_only run refuses to publish an
  // unexpected working diff (see openAutomationRunPullRequest).
  autonomy: AutomationDefinition['autonomyDefault']
}) => Promise<AutomationPullRequestResult>

export type AutomationRunWorktreeRemover = (input: {
  workspaceRoot: string
  worktreePath: string
}) => Promise<void>

// Disposes the run's spawned agent (kill terminal + drop tab + delete record) at
// finalize, so a one-shot automation agent never outlives its torn-down worktree
// and loop-relaunches into the dead cwd. Best-effort and idempotent.
export type AutomationRunAgentDisposer = (input: {
  workspaceId: string
  agentId: string
}) => Promise<void>

export type AutomationsEngineOptions = {
  getProjectFolders?: () => AutomationsProjectFolder[] | Promise<AutomationsProjectFolder[]>
  getWorkspaceSnapshot?: () => WorkspaceSyncSnapshot | Promise<WorkspaceSyncSnapshot>
  createStore?: (workspaceRoot: string) => AutomationsStore
  triggerProviders?: AutomationTriggerProvider[]
  getTriggerProviders?: () => AutomationTriggerProvider[]
  isIntegrationAvailable?: (id: string) => boolean | undefined
  runAutomation: AutomationRunExecutor
  now?: () => number
  createRunId?: (input: { workspaceRoot: string; automationId: string; dueAt: string }) => string
  pollIntervalMs?: number
  onEvaluation?: (result: AutomationsEngineEvaluationResult) => void
  /**
   * Run-lifecycle event sink. `definition` is the automation the event belongs
   * to, handed through from the emit site so subscribers needing definition
   * metadata (e.g. `ownerModuleId` for module-scoped fan-out) never re-derive
   * it from the event's workspaceId — which can be the run-hosting workspace,
   * not the one whose store holds the definition.
   */
  onRunEvent?: (event: AutomationsRunEvent, definition: AutomationDefinition) => void
  // Agent-backed run finalize collaborators (injected for testability).
  openRunPullRequest?: AutomationRunPullRequestOpener
  removeRunWorktree?: AutomationRunWorktreeRemover
  disposeRunAgent?: AutomationRunAgentDisposer
  // Live agent-session executionIds, used by the startup reconcile to tell an
  // orphaned pending run (agent gone while Multicode was down) from one whose
  // agent is still live. Absent in tests that do not exercise reconcile.
  getLiveAgentExecutionIds?: () => string[]
  // How long a turn-end must stand before it finalizes the run (see
  // DEFAULT_TURN_SETTLE_MS). Injectable so tests do not wait it out.
  turnSettleMs?: number
  // Reads the run summary from an agent transcript (defaults to
  // transcript-summary's reader). Injectable so tests can hold the read open
  // and pin the finalize races that live inside its await.
  readRunTranscriptSummary?: (transcriptPath: string) => Promise<string | undefined>
  // Backstop cap on a pending agent run's wall-clock life (see
  // DEFAULT_MAX_AGENT_RUN_MS).
  maxAgentRunMs?: number
}

type EvaluationMode = 'startup' | 'timer'

// A turn-end that has been observed and is waiting out the settle window. A
// working-phase frame for the same agent cancels it; the timer firing (or the
// agent's pty exiting first) finalizes the run with this outcome.
type ArmedTurnEnd = {
  outcome: 'completed' | 'failed'
  // Untrusted reporter path; read best-effort at fire time (transcript-summary
  // is the containment boundary), so a cancelled turn-end costs no file read.
  transcriptPath?: string
  timer: ReturnType<typeof setTimeout>
  // Single-flight finalize. Set when the settle timer (or a racing pty exit)
  // fires the turn-end; the armed record stays on the run until finalizeRun
  // takes over, so an exit landing during the transcript read joins this
  // promise instead of recording `failed` over a successful run.
  finalizing?: Promise<void>
}

// An agent-backed run that was dispatched as `running` and is awaiting its
// agent's terminal outcome. Correlated to agent-state phase frames by
// (workspaceId, agentId) — the pair every frame carries and every launched run
// records — so finalization never depends on an executionId the launch probe
// may have missed.
type PendingAgentRun = {
  workspaceRoot: string
  automationId: string
  runId: string
  // Absent on a runInWorktree:false run, which finalizes like any other.
  worktreePath?: string
  workspaceId?: string
  agentId?: string
  // Terminal-session executionId of the run's spawned agent, when it was
  // resolvable. Only the pty-exit path and the startup reconcile use it; the
  // phase path does not need it.
  executionId?: string
  // Wall-clock start, for the max-duration sweep.
  startedAtMs: number
  // A turn-end can only finalize a run that was seen working first, so an idle
  // frame arriving before the prompt lands cannot dispose a live agent.
  observedWorkingPhase: boolean
  armedTurnEnd?: ArmedTurnEnd
}

const DEFAULT_POLL_INTERVAL_MS = 60_000

// A turn end is not the same as being done: a Stop hook in the user's own repo
// settings can continue the turn, an agent can end its turn to ask a question,
// plan mode ends a turn, and ESC ends a turn. Finalizing is destructive (opens a
// PR, removes the worktree, kills the agent), so an armed turn-end waits this
// long and any working-phase frame in the window disarms it.
const DEFAULT_TURN_SETTLE_MS = 15_000

// Bounded backstop for runs whose agent never reports a turn end: a CLI outside
// the reporter set (see agentStateSupportsCli) emits no frame at all, and a
// frame can be lost. Past this age a pending run is failed rather than left
// Running forever — the bug this whole path exists to fix.
const DEFAULT_MAX_AGENT_RUN_MS = 6 * 60 * 60 * 1000

export class AutomationsEngine {
  private readonly getProjectFolders?: () => AutomationsProjectFolder[] | Promise<AutomationsProjectFolder[]>
  private readonly getWorkspaceSnapshot?: () => WorkspaceSyncSnapshot | Promise<WorkspaceSyncSnapshot>
  private readonly createStore: (workspaceRoot: string) => AutomationsStore
  private readonly getTriggerProviders: () => AutomationTriggerProvider[]
  private readonly isIntegrationAvailable?: (id: string) => boolean | undefined
  private readonly runAutomation: AutomationRunExecutor
  private readonly now: () => number
  private readonly createRunId: (input: { workspaceRoot: string; automationId: string; dueAt: string }) => string
  private readonly pollIntervalMs: number
  private readonly onEvaluation?: (result: AutomationsEngineEvaluationResult) => void
  private readonly onRunEvent?: (event: AutomationsRunEvent, definition: AutomationDefinition) => void
  private readonly openRunPullRequest?: AutomationRunPullRequestOpener
  private readonly removeRunWorktree?: AutomationRunWorktreeRemover
  private readonly disposeRunAgent?: AutomationRunAgentDisposer
  private readonly getLiveAgentExecutionIds?: () => string[]
  private readonly turnSettleMs: number
  private readonly maxAgentRunMs: number
  private readonly readRunTranscriptSummary: (transcriptPath: string) => Promise<string | undefined>
  private readonly inFlight = new Set<string>()
  private readonly pendingAgentRuns = new Map<string, PendingAgentRun>()
  // Per-run finalize lock (pendingRunKey shape). Closes the manual-IPC vs
  // signal-scan TOCTOU: only the first caller finalizes; a concurrent caller
  // gets the in-progress/terminal run back instead of double-opening a PR.
  private readonly finalizingRuns = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false
  private startupEvaluation: Promise<AutomationsEngineEvaluationResult> | null = null
  private timerEvaluation: Promise<AutomationsEngineEvaluationResult> | null = null

  constructor(options: AutomationsEngineOptions) {
    this.getProjectFolders = options.getProjectFolders
    this.getWorkspaceSnapshot = options.getWorkspaceSnapshot
    this.createStore = options.createStore ?? ((workspaceRoot) => new AutomationsStore(workspaceRoot))
    const staticTriggerProviders = options.triggerProviders ?? []
    this.getTriggerProviders = options.getTriggerProviders ?? (() => staticTriggerProviders)
    this.isIntegrationAvailable = options.isIntegrationAvailable
    this.runAutomation = options.runAutomation
    this.now = options.now ?? Date.now
    this.createRunId = options.createRunId ?? (() => `automation-run-${randomUUID()}`)
    this.pollIntervalMs = Math.max(1_000, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS))
    this.onEvaluation = options.onEvaluation
    this.onRunEvent = options.onRunEvent
    this.openRunPullRequest = options.openRunPullRequest
    this.removeRunWorktree = options.removeRunWorktree
    this.disposeRunAgent = options.disposeRunAgent
    this.getLiveAgentExecutionIds = options.getLiveAgentExecutionIds
    this.turnSettleMs = Math.max(0, Math.floor(options.turnSettleMs ?? DEFAULT_TURN_SETTLE_MS))
    this.maxAgentRunMs = Math.max(1_000, Math.floor(options.maxAgentRunMs ?? DEFAULT_MAX_AGENT_RUN_MS))
    this.readRunTranscriptSummary = options.readRunTranscriptSummary ?? readTranscriptSummary
  }

  start(): void {
    if (this.started) return
    this.started = true

    const startup = this.handleStartup()
    void startup
      .catch(() => undefined)
      .finally(() => {
        if (!this.started || this.timer) return
        this.timer = setInterval(() => {
          void this.tick()
        }, this.pollIntervalMs)
      })
  }

  stop(): void {
    // Armed turn-ends are cleared unconditionally: a settle timer that survives
    // stop() would finalize a run — opening a PR and disposing an agent — for an
    // engine the app has already torn down. Disarming also aborts an in-flight
    // armed finalize at its post-transcript-read check; only a finalize that has
    // already entered finalizeRun still runs to completion.
    for (const pending of this.pendingAgentRuns.values()) this.disarmTurnEnd(pending)
    if (!this.started && !this.timer) return
    this.started = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  isRunning(): boolean {
    return this.started
  }

  async handleStartup(): Promise<AutomationsEngineEvaluationResult> {
    if (this.startupEvaluation) return this.startupEvaluation

    let startup: Promise<AutomationsEngineEvaluationResult>
    startup = this.evaluate('startup').finally(() => {
      if (this.startupEvaluation === startup) this.startupEvaluation = null
    })
    this.startupEvaluation = startup
    return startup
  }

  async tick(): Promise<AutomationsEngineEvaluationResult> {
    const startup = this.startupEvaluation
    if (startup) await startup
    if (this.timerEvaluation) return emptyEvaluationResult()

    let timerEvaluation: Promise<AutomationsEngineEvaluationResult>
    timerEvaluation = this.evaluate('timer').finally(() => {
      if (this.timerEvaluation === timerEvaluation) this.timerEvaluation = null
    })
    this.timerEvaluation = timerEvaluation
    return timerEvaluation
  }

  async runNow(input: {
    workspaceRoot: string
    automationId: string
    workspaceId?: string
    triggerPayload?: Record<string, unknown>
  }): Promise<AutomationsEngineRunNowResult> {
    const store = this.createStore(input.workspaceRoot)
    const definitionResult = await store.getDefinition(input.automationId)
    if (!definitionResult.ok) {
      return { ok: false, problem: storeProblem(input.workspaceRoot, definitionResult.error, input.automationId) }
    }

    const definition = definitionResult.value
    if (definition.trigger.kind !== 'schedule') {
      return {
        ok: false,
        problem: {
          workspaceRoot: input.workspaceRoot,
          automationId: definition.id,
          code: 'unsupported_trigger',
          message: `Automation "${definition.id}" cannot run because trigger "${definition.trigger.kind}" is not supported.`,
        },
      }
    }

    const validation = validateScheduleTriggerConfig(definition.trigger.config)
    if (!validation.ok) {
      return {
        ok: false,
        problem: {
          workspaceRoot: input.workspaceRoot,
          automationId: definition.id,
          code: 'invalid_schedule',
          message: validation.error,
        },
      }
    }

    const stateResult = await store.readState()
    if (!stateResult.ok) {
      return { ok: false, problem: storeProblem(input.workspaceRoot, stateResult.error, definition.id) }
    }
    const state: AutomationStoreState = stateResult.value ?? { nextRunAtByAutomationId: {}, lock: null }
    const inFlightKey = this.inFlightKey(input.workspaceRoot, definition.id)
    if (this.inFlight.has(inFlightKey)) {
      return {
        ok: false,
        problem: {
          workspaceRoot: input.workspaceRoot,
          automationId: definition.id,
          code: 'in_flight',
          message: `Automation "${definition.id}" is already running.`,
        },
      }
    }

    this.inFlight.add(inFlightKey)
    try {
      const now = this.now()
      const dueAt = new Date(now).toISOString()
      const run = this.runRecord(input.workspaceRoot, definition.id, dueAt, {
        status: 'running',
        startedAt: dueAt,
        completedAt: null,
      })

      const started = await store.recordRun(run)
      if (!started.ok) {
        return { ok: false, problem: storeProblem(input.workspaceRoot, started.error, definition.id) }
      }

      let finalRun: AutomationRun
      try {
        const patch = await this.runAutomation({
          workspaceRoot: input.workspaceRoot,
          definition,
          run,
          triggerPayload: input.triggerPayload ?? { kind: 'manual', dueAt },
          workspaceId: input.workspaceId ?? await this.resolveWorkspaceIdForRoot(input.workspaceRoot) ?? undefined,
        })
        const completedAt = patch.completedAt ?? new Date(this.now()).toISOString()
        finalRun = completeRun(run, patch, completedAt)
      } catch (error) {
        const failedAt = new Date(this.now()).toISOString()
        finalRun = completeRun(run, {
          status: 'failed',
          completedAt: failedAt,
          summary: error instanceof Error ? error.message : 'Automation action failed.',
        }, failedAt)
      }

      const completed = await store.recordRun(finalRun)
      if (!completed.ok) {
        return { ok: false, problem: storeProblem(input.workspaceRoot, completed.error, definition.id) }
      }
      const eventWorkspaceId =
        input.workspaceId
        ?? await this.resolveWorkspaceIdForRoot(input.workspaceRoot)
        ?? finalRun.workspaceId
      this.trackPendingAgentRun(input.workspaceRoot, finalRun, eventWorkspaceId)
      this.emitRunEvent({
        workspaceId: eventWorkspaceId,
        definition,
        run: finalRun,
        trigger: 'manual',
      })

      const completedAt = Date.parse(finalRun.completedAt ?? dueAt)
      const result = emptyEvaluationResult()
      const nextRunAt = nextRunIso(validation.value, completedAt)
      const updated = await this.updateDefinitionAfterRun(
        store,
        state,
        input.workspaceRoot,
        definition,
        validation.value,
        finalRun,
        nextRunAt,
        completedAt,
        result
      )
      if (!updated) {
        return {
          ok: false,
          problem: result.problems[0] ?? {
            workspaceRoot: input.workspaceRoot,
            automationId: definition.id,
            code: 'definition_update_failed',
            message: `Automation "${definition.id}" ran, but its schedule could not be updated.`,
          },
        }
      }

      const refreshed = await store.getDefinition(definition.id)
      if (!refreshed.ok) {
        return { ok: false, problem: storeProblem(input.workspaceRoot, refreshed.error, definition.id) }
      }
      return { ok: true, definition: refreshed.value, run: finalRun }
    } finally {
      this.inFlight.delete(inFlightKey)
    }
  }

  async deliverTriggerEvent(input: {
    workspaceRoot: string
    automationId: string
    event: AutomationTriggerPollEvent
    workspaceId?: string
  }): Promise<AutomationsEngineTriggerEventDeliveryResult> {
    const store = this.createStore(input.workspaceRoot)
    const definitionResult = await store.getDefinition(input.automationId)
    if (!definitionResult.ok) {
      return { ok: false, problem: storeProblem(input.workspaceRoot, definitionResult.error, input.automationId) }
    }

    const definition = definitionResult.value
    if (definition.status !== 'enabled') {
      return {
        ok: false,
        problem: {
          workspaceRoot: input.workspaceRoot,
          automationId: definition.id,
          code: 'automation_disabled',
          message: `Automation "${definition.id}" is not enabled.`,
        },
      }
    }
    if (definition.trigger.kind === 'schedule') {
      return {
        ok: false,
        problem: {
          workspaceRoot: input.workspaceRoot,
          automationId: definition.id,
          code: 'unsupported_trigger',
          message: `Automation "${definition.id}" cannot receive external trigger events for schedule triggers.`,
        },
      }
    }

    const provider = this.getTriggerProviders().find((candidate) => candidate.kind === definition.trigger.kind)
    if (!provider) {
      return {
        ok: false,
        problem: {
          workspaceRoot: input.workspaceRoot,
          automationId: definition.id,
          code: 'unknown_trigger',
          message: `No automation trigger provider is registered for "${definition.trigger.kind}".`,
        },
      }
    }

    const validation = provider.validateConfig?.(definition.trigger.config)
    if (validation && !validation.ok) {
      return {
        ok: false,
        problem: {
          workspaceRoot: input.workspaceRoot,
          automationId: definition.id,
          code: 'invalid_trigger_config',
          message: validation.error,
        },
      }
    }

    const missingIntegrations = (provider.requiredIntegrations ?? [])
      .filter((id) => this.isIntegrationAvailable?.(id) !== true)
    if (missingIntegrations.length > 0) {
      return {
        ok: false,
        problem: {
          workspaceRoot: input.workspaceRoot,
          automationId: definition.id,
          code: 'missing_trigger_integration',
          message: `Required trigger integration is unavailable: ${missingIntegrations.join(', ')}.`,
        },
      }
    }

    const stateResult = await store.readState()
    if (!stateResult.ok) {
      return { ok: false, problem: storeProblem(input.workspaceRoot, stateResult.error, definition.id) }
    }
    const state: AutomationStoreState = stateResult.value ?? { nextRunAtByAutomationId: {}, lock: null }
    const result = emptyEvaluationResult()
    const workspaceId = input.workspaceId ?? await this.resolveWorkspaceIdForRoot(input.workspaceRoot) ?? ''
    const delivery = await enqueueTriggerEventRun({
      store,
      state,
      projectFolder: { workspaceId, folderPath: input.workspaceRoot },
      definition,
      event: input.event,
      runAutomation: this.runAutomation,
      now: this.now,
      createRunId: this.createRunId,
      inFlight: this.inFlight,
      emitRunEvent: (event) => {
        this.trackPendingAgentRun(input.workspaceRoot, event.run, event.workspaceId ?? workspaceId)
        this.emitRunEvent({ ...event, trigger: 'timer' })
      },
      result,
    })

    if (delivery.status === 'problem') return { ok: false, problem: delivery.problem }
    return { ok: true, definition, delivery }
  }

  // Records the terminal outcome of an agent-backed run that was dispatched as
  // `running`. On a `completed` outcome it backstop-commits + opens (or reuses) a
  // PR for the run's branch; either way it tears down the run's worktree, records
  // the terminal run, and emits the run-event. Idempotent: a run already in a
  // terminal state is returned unchanged.
  async finalizeRun(input: {
    workspaceRoot: string
    automationId: string
    runId: string
    outcome: 'completed' | 'failed'
    summary?: string
    workspaceId?: string
    // Routes the terminal run-event. 'manual' (default, IPC button) always emits;
    // 'timer' (auto-finalize) emits only on failure so the completed happy path
    // stays silent during background ticks.
    eventTrigger?: AutomationRunEventTrigger
  }): Promise<AutomationsEngineFinalizeResult> {
    const runKey = this.pendingRunKey(input.workspaceRoot, input.automationId, input.runId)
    // Drop from the pending registry on any finalize (manual or auto) so a later
    // frame or tick never re-finalizes a run that is already being finalized —
    // and cancel any settle timer still armed for it.
    const pending = this.pendingAgentRuns.get(runKey)
    if (pending) this.disarmTurnEnd(pending)
    this.pendingAgentRuns.delete(runKey)

    const store = this.createStore(input.workspaceRoot)
    // Serialize finalize per run: a concurrent manual IPC finalize and the
    // per-tick scan must not both pass the 'running' check below and double-open
    // a PR / double-emit. The first caller holds the lock; a second caller reads
    // the current run and returns it (in-progress or terminal) without re-running.
    if (this.finalizingRuns.has(runKey)) {
      const concurrentRun = await store.getRun(input.automationId, input.runId)
      if (!concurrentRun.ok) {
        return { ok: false, problem: storeProblem(input.workspaceRoot, concurrentRun.error, input.automationId) }
      }
      return { ok: true, run: concurrentRun.value }
    }
    this.finalizingRuns.add(runKey)
    try {
      return await this.finalizeRunLocked(input, store)
    } finally {
      this.finalizingRuns.delete(runKey)
    }
  }

  // The finalize trigger for the happy path: an accepted agent-state phase
  // transition for one of this app's agent terminals. Frames for agents that own
  // no pending run (every non-automation agent) fall straight through.
  //
  // A working phase marks the run as having done work and disarms any settle
  // timer. A turn end (or an OpenCode session error) arms one, but only past the
  // guards — each of which stands between a live agent and a destructive
  // finalize that opens a PR from half-finished work, removes the agent's cwd,
  // and kills it:
  //   - the event is a real turn end, not a Task subagent's (the predicates own
  //     this: SubagentStop maps to the same phase as Stop, so only the raw event
  //     can tell them apart);
  //   - the run has been seen working, so a stray idle frame before the prompt
  //     lands cannot finalize instantly;
  //   - the agent has no wakeup armed — a self-paced (/loop) agent intends to
  //     resume, and pendingWakeupAt is resolved from the SESSION because the
  //     reporter never attaches a wakeup to a turn-end frame;
  //   - the settle window elapses with no further work (see DEFAULT_TURN_SETTLE_MS).
  async noteAgentPhase(event: AgentPhaseEvent): Promise<void> {
    const pending = this.findPendingRunByAgent(event.workspaceId, event.agentId)
    if (!pending) return
    // Backfill an executionId the launch probe missed, so the pty-exit path can
    // still correlate on it for a run whose agentId is somehow absent.
    if (event.executionId && !pending.executionId) pending.executionId = event.executionId

    // "Working" is read through the shared phase vocabulary rather than a local
    // phase list, so a new working phase cannot silently stop cancelling a
    // settle timer here.
    if (deriveActivityFromPhase(event.phase, event.ts)?.kind === 'working') {
      pending.observedWorkingPhase = true
      this.disarmTurnEnd(pending)
      return
    }

    const failed = isAgentTurnFailureEvent(event.event)
    if (!failed && !isAgentTurnEndEvent(event.event)) return
    if (!pending.observedWorkingPhase) return
    if (event.pendingWakeupAt !== null && event.pendingWakeupAt > this.now()) return
    if (pending.armedTurnEnd) return

    pending.armedTurnEnd = {
      outcome: failed ? 'failed' : 'completed',
      transcriptPath: event.transcriptPath,
      timer: setTimeout(() => {
        void this.finalizeArmedTurnEnd(pending)
      }, this.turnSettleMs),
    }
    pending.armedTurnEnd.timer.unref?.()
  }

  // Agent-lifecycle finalize trigger: the owning module routes a real agent-
  // session pty exit here. Correlates on the executionId or on
  // (workspaceId, agentId); an exit matching no pending run (a non-automation
  // agent, or an already-finalized run) is ignored.
  //
  // An armed turn-end WINS over the exit: an agent that finished its turn and
  // then exited inside the settle window succeeded, and recording it as failed
  // would throw away its PR. Only an exit with no turn-end behind it is a
  // failure. Routed 'timer' so a failed auto-finalize still emits a run-event
  // while a completed one stays silent. Shares finalizeRun's lock and
  // idempotency, so a concurrent tick/manual finalize still yields one record.
  async finalizeRunOnAgentExit(input: {
    executionId?: string
    workspaceId?: string
    agentId?: string
    exitCode: number
  }): Promise<void> {
    const executionId = input.executionId?.trim()
    const pending =
      (executionId ? this.findPendingRunByExecutionId(executionId) : undefined)
      ?? this.findPendingRunByAgent(input.workspaceId ?? null, input.agentId ?? '')
    if (!pending) return

    if (pending.armedTurnEnd) {
      await this.finalizeArmedTurnEnd(pending)
      // The armed finalize can abort if a straggler working frame disarmed it
      // mid-transcript-read. The pty is gone either way, so a run the abort
      // left pending falls through to the exit outcome below instead of
      // hanging until the max-duration sweep.
      if (!this.pendingAgentRuns.has(this.pendingRunKey(pending.workspaceRoot, pending.automationId, pending.runId))) {
        return
      }
    }
    await this.finalizeRun({
      workspaceRoot: pending.workspaceRoot,
      automationId: pending.automationId,
      runId: pending.runId,
      outcome: 'failed',
      summary: `The agent stopped before it finished (exit code ${input.exitCode}).`,
      workspaceId: pending.workspaceId,
      eventTrigger: 'timer',
    })
  }

  // Fire an armed turn-end. Single-flight: the settle timer and a racing pty
  // exit share one in-flight finalize, so the armed outcome always wins over
  // the exit's `failed`. The armed record stays on the run while the transcript
  // is read; anything that disarms it during that read — a working-phase frame
  // (the agent resumed), a manual finalize, stop() — aborts the finalize
  // instead of racing it.
  private finalizeArmedTurnEnd(pending: PendingAgentRun): Promise<void> {
    const armed = pending.armedTurnEnd
    if (!armed) return Promise.resolve()
    if (!armed.finalizing) {
      clearTimeout(armed.timer)
      armed.finalizing = this.finalizeTurnEnd(pending, armed)
    }
    return armed.finalizing
  }

  // The body of an armed turn-end finalize: derive the summary, then finalize.
  // Best-effort by design — no transcript, or an unreadable one, degrades to a
  // generic summary and never blocks the finalize.
  private async finalizeTurnEnd(pending: PendingAgentRun, armed: ArmedTurnEnd): Promise<void> {
    const transcriptSummary = armed.transcriptPath
      ? await this.readRunTranscriptSummary(armed.transcriptPath)
      : undefined
    // Disarmed during the transcript read: the turn-end no longer stands, so
    // finalizing now would dispose an agent that is working again (or drive an
    // engine that has been stopped). finalizeRun below re-disarms and drops the
    // pending entry synchronously, so this check cannot miss its own finalize.
    if (pending.armedTurnEnd !== armed) return
    // Every summary here is read verbatim by a person in the run row, so it names
    // the cause in plain language and never in the runtime's vocabulary: a "turn"
    // is an agent-runtime concept, and a user reading their automation history has
    // no model for it. The completed fallback in particular must not overclaim —
    // with no transcript, all that is actually known is that the agent stopped
    // talking, so it says exactly that rather than "finished its turn".
    const summary =
      armed.outcome === 'failed'
        ? 'The agent hit an error and stopped before it finished.'
        : transcriptSummary ?? 'The agent finished, but left no summary of what it did.'
    await this.finalizeRun({
      workspaceRoot: pending.workspaceRoot,
      automationId: pending.automationId,
      runId: pending.runId,
      outcome: armed.outcome,
      summary,
      workspaceId: pending.workspaceId,
      eventTrigger: 'timer',
    })
  }

  private disarmTurnEnd(pending: PendingAgentRun): void {
    if (!pending.armedTurnEnd) return
    clearTimeout(pending.armedTurnEnd.timer)
    pending.armedTurnEnd = undefined
  }

  private async finalizeRunLocked(
    input: {
      workspaceRoot: string
      automationId: string
      runId: string
      outcome: 'completed' | 'failed'
      summary?: string
      workspaceId?: string
      eventTrigger?: AutomationRunEventTrigger
    },
    store: AutomationsStore
  ): Promise<AutomationsEngineFinalizeResult> {
    const runResult = await store.getRun(input.automationId, input.runId)
    if (!runResult.ok) {
      return { ok: false, problem: storeProblem(input.workspaceRoot, runResult.error, input.automationId) }
    }
    const run = runResult.value
    if (run.status !== 'running' && run.status !== 'queued') {
      // Already finalized — return it unchanged (idempotent re-finalize).
      return { ok: true, run }
    }

    const definitionResult = await store.getDefinition(input.automationId)
    const definitionName = definitionResult.ok ? definitionResult.value.name : input.automationId
    // When the definition is unreadable we cannot prove review_only, so default to
    // allow_changes (preserve existing behavior); configured review_only runs have
    // a readable definition at finalize, which is what the safeguard targets.
    const autonomy = definitionResult.ok ? definitionResult.value.autonomyDefault : 'allow_changes'

    let pullRequestUrl: string | undefined
    let withheldChangesReason: string | undefined
    const summaryParts: string[] = []
    if (input.summary?.trim()) summaryParts.push(input.summary.trim())

    if (input.outcome === 'completed' && run.branch && run.worktreePath && this.openRunPullRequest) {
      const pr = await this.openRunPullRequest({
        workspaceRoot: input.workspaceRoot,
        worktreePath: run.worktreePath,
        branch: run.branch,
        title: `Automation: ${definitionName}`,
        body: `Opened by the "${definitionName}" automation (run ${run.id}).`,
        autonomy,
      })
      if (pr.ok) {
        pullRequestUrl = pr.url
        summaryParts.push(pr.created ? `Opened pull request ${pr.url}.` : `Linked existing pull request ${pr.url}.`)
      } else {
        summaryParts.push(`No pull request linked: ${pr.reason}`)
        // Surface a withheld review_only diff as a blocked reason so the finalize
        // is visibly not a clean success (no silent push, no silent success).
        if (pr.withheldChanges) withheldChangesReason = pr.reason
      }
    }

    if (run.worktreePath && this.removeRunWorktree) {
      try {
        await this.removeRunWorktree({ workspaceRoot: input.workspaceRoot, worktreePath: run.worktreePath })
      } catch {
        // Worktree teardown is best-effort; a leftover worktree is swept later
        // and must not fail the finalize.
      }
    }

    // Dispose the run's one-shot agent alongside its worktree: kill the terminal,
    // drop the tab, delete the record. This is what prevents the dead-cwd relaunch
    // loop — with no surviving agent there is nothing to relaunch into the removed
    // worktree. Best-effort, and reached by the startup reconcile too (it re-runs
    // finalize for runs orphaned while Multicode was down), so a crash mid-run is
    // also covered.
    if (run.workspaceId && run.agentId && this.disposeRunAgent) {
      try {
        await this.disposeRunAgent({ workspaceId: run.workspaceId, agentId: run.agentId })
      } catch {
        // Best-effort teardown; a failure leaves the pre-fix behavior, not worse.
      }
    }

    const finalRun: AutomationRun = {
      ...run,
      status: input.outcome,
      completedAt: new Date(this.now()).toISOString(),
      pullRequestUrl,
      blockedReason: withheldChangesReason ?? run.blockedReason,
      summary: summaryParts.length > 0 ? summaryParts.join(' ') : run.summary,
    }
    const recorded = await store.recordRun(finalRun)
    if (!recorded.ok) {
      return { ok: false, problem: storeProblem(input.workspaceRoot, recorded.error, input.automationId) }
    }

    const eventTrigger = input.eventTrigger ?? 'manual'
    const emitTerminalEvent = eventTrigger === 'manual' || finalRun.status === 'failed'
    if (definitionResult.ok && emitTerminalEvent) {
      const eventWorkspaceId =
        input.workspaceId
        ?? run.workspaceId
        ?? await this.resolveWorkspaceIdForRoot(input.workspaceRoot)
        ?? undefined
      this.emitRunEvent({
        workspaceId: eventWorkspaceId,
        definition: definitionResult.value,
        run: finalRun,
        trigger: eventTrigger,
      })
    }

    return { ok: true, run: finalRun }
  }

  private async evaluate(mode: EvaluationMode): Promise<AutomationsEngineEvaluationResult> {
    const result = emptyEvaluationResult()
    const now = this.now()
    const projectFolders = await this.loadProjectFolders(result)
    // Rebuild the pending-run registry from disk once at startup so agent runs
    // dispatched before an app restart are still finalized when their signal lands.
    if (mode === 'startup') {
      await this.seedPendingAgentRuns(projectFolders)
      // Force-fail runs orphaned while Multicode was down before the scan below
      // gets a chance to leave them pending forever (their agent is gone).
      await this.reconcileOrphanedAgentRuns()
    }
    const pollContext = createTriggerPollContext()
    const triggerProvidersByKind = new Map(
      this.getTriggerProviders().map((provider) => [provider.kind, provider])
    )

    for (const projectFolder of projectFolders) {
      await this.evaluateProject(projectFolder, mode, now, pollContext, triggerProvidersByKind, result)
    }

    await this.scanPendingAgentRuns()

    this.onEvaluation?.(result)
    return result
  }

  // Max-duration sweep — the per-tick backstop, and the only thing the tick does
  // for pending runs now that finalization is frame-driven. A run whose agent
  // reports no frames at all (a CLI outside the reporter set) or whose turn-end
  // frame was lost would otherwise sit Running forever; past the cap it is
  // failed. A younger run is left alone for its frames.
  private async scanPendingAgentRuns(): Promise<void> {
    if (this.pendingAgentRuns.size === 0) return
    const now = this.now()
    for (const pending of [...this.pendingAgentRuns.values()]) {
      if (now - pending.startedAtMs < this.maxAgentRunMs) continue
      await this.finalizeRun({
        workspaceRoot: pending.workspaceRoot,
        automationId: pending.automationId,
        runId: pending.runId,
        outcome: 'failed',
        // Names the limit it actually hit: "past its maximum duration" leaves the
        // user with no way to tell a hung agent from one that simply needed longer.
        summary: `The agent was still running after ${formatRunLimit(this.maxAgentRunMs)}, so Multicode stopped waiting and ended the run.`,
        workspaceId: pending.workspaceId,
        eventTrigger: 'timer',
      })
    }
  }

  // Startup reconciliation: an agent-backed run recorded `running` whose
  // executionId is NOT among the live agent executions had its agent end while
  // Multicode was down — force-fail it. A run whose executionId is still live
  // stays pending for its frames; a run with no recorded executionId is never
  // force-failed here (nothing proves its agent is gone) and is covered by the
  // max-duration sweep instead.
  private async reconcileOrphanedAgentRuns(): Promise<void> {
    if (!this.getLiveAgentExecutionIds || this.pendingAgentRuns.size === 0) return
    const liveExecutionIds = new Set(this.getLiveAgentExecutionIds())
    for (const pending of [...this.pendingAgentRuns.values()]) {
      if (!pending.executionId || liveExecutionIds.has(pending.executionId)) continue
      await this.finalizeRun({
        workspaceRoot: pending.workspaceRoot,
        automationId: pending.automationId,
        runId: pending.runId,
        outcome: 'failed',
        summary: 'The agent stopped while Multicode was closed, so this run never finished.',
        workspaceId: pending.workspaceId,
        eventTrigger: 'timer',
      })
    }
  }

  private findPendingRunByExecutionId(executionId: string): PendingAgentRun | undefined {
    for (const pending of this.pendingAgentRuns.values()) {
      if (pending.executionId === executionId) return pending
    }
    return undefined
  }

  // (workspaceId, agentId) is the correlation key on the frame path: both are
  // stamped on every agent-backed run at launch-confirm, and both ride every
  // agent-state frame. A partial key matches nothing.
  private findPendingRunByAgent(workspaceId: string | null, agentId: string): PendingAgentRun | undefined {
    if (!workspaceId || !agentId) return undefined
    for (const pending of this.pendingAgentRuns.values()) {
      if (pending.workspaceId === workspaceId && pending.agentId === agentId) return pending
    }
    return undefined
  }

  private async seedPendingAgentRuns(projectFolders: AutomationsProjectFolder[]): Promise<void> {
    for (const projectFolder of projectFolders) {
      const store = this.createStore(projectFolder.folderPath)
      const definitions = await store.listDefinitions()
      if (!definitions.ok) continue
      for (const definition of definitions.values) {
        const runs = await store.listRuns(definition.id)
        if (!runs.ok) continue
        for (const run of runs.values) {
          this.trackPendingAgentRun(projectFolder.folderPath, run, projectFolder.workspaceId)
        }
      }
    }
  }

  // Register a dispatched agent-backed run for finalization. A run WITHOUT a
  // worktree (runInWorktree: false) is registered too — it used to be dropped
  // here, which is why those runs had no finalize path at all and sat Running
  // forever. Called on dispatch and again on the startup seed, so an existing
  // entry keeps its live phase state and only refreshes its correlation fields.
  private trackPendingAgentRun(workspaceRoot: string, run: AutomationRun, workspaceId?: string): void {
    if (run.status !== 'running') return
    const key = this.pendingRunKey(workspaceRoot, run.automationId, run.id)
    const existing = this.pendingAgentRuns.get(key)
    if (existing) {
      existing.worktreePath = run.worktreePath ?? existing.worktreePath
      existing.workspaceId = workspaceId ?? run.workspaceId ?? existing.workspaceId
      existing.agentId = run.agentId ?? existing.agentId
      existing.executionId = run.executionId ?? existing.executionId
      return
    }
    const startedAt = Date.parse(run.startedAt ?? '')
    this.pendingAgentRuns.set(key, {
      workspaceRoot,
      automationId: run.automationId,
      runId: run.id,
      worktreePath: run.worktreePath,
      workspaceId: workspaceId ?? run.workspaceId,
      agentId: run.agentId,
      executionId: run.executionId,
      startedAtMs: Number.isFinite(startedAt) ? startedAt : this.now(),
      observedWorkingPhase: false,
    })
  }

  private pendingRunKey(workspaceRoot: string, automationId: string, runId: string): string {
    return `${normalizeWorkspaceRoot(workspaceRoot)}\u0000${automationId}\u0000${runId}`
  }

  private async loadProjectFolders(result: AutomationsEngineEvaluationResult): Promise<AutomationsProjectFolder[]> {
    try {
      const projectFolders = this.getProjectFolders
        ? await this.getProjectFolders()
        : this.getWorkspaceSnapshot
          ? projectFoldersFromWorkspaceSyncSnapshot(await this.getWorkspaceSnapshot())
          : []
      return dedupeProjectFolders(projectFolders)
    } catch (error) {
      result.problems.push({
        code: 'workspace_snapshot_failed',
        message: error instanceof Error ? error.message : 'Unable to read workspace snapshot.',
      })
      return []
    }
  }

  private async evaluateProject(
    projectFolder: AutomationsProjectFolder,
    mode: EvaluationMode,
    now: number,
    pollContext: AutomationTriggerPollContext,
    triggerProvidersByKind: ReadonlyMap<string, AutomationTriggerProvider>,
    result: AutomationsEngineEvaluationResult
  ): Promise<void> {
    const workspaceRoot = projectFolder.folderPath
    const store = this.createStore(workspaceRoot)
    const definitions = await store.listDefinitions()
    if (!definitions.ok) {
      for (const error of definitions.errors) {
        result.problems.push(storeProblem(workspaceRoot, error))
      }
      return
    }

    const stateResult = await store.readState()
    if (!stateResult.ok) {
      result.problems.push(storeProblem(workspaceRoot, stateResult.error))
      return
    }

    const state: AutomationStoreState = stateResult.value ?? { nextRunAtByAutomationId: {}, lock: null }
    for (const definition of definitions.values) {
      await this.evaluateDefinition(
        store,
        state,
        projectFolder,
        definition,
        mode,
        now,
        pollContext,
        triggerProvidersByKind,
        result
      )
    }
  }

  private async evaluateDefinition(
    store: AutomationsStore,
    state: AutomationStoreState,
    projectFolder: AutomationsProjectFolder,
    definition: AutomationDefinition,
    mode: EvaluationMode,
    now: number,
    pollContext: AutomationTriggerPollContext,
    triggerProvidersByKind: ReadonlyMap<string, AutomationTriggerProvider>,
    result: AutomationsEngineEvaluationResult
  ): Promise<void> {
    const workspaceRoot = projectFolder.folderPath
    if (definition.status !== 'enabled') return
    if (definition.trigger.kind !== 'schedule') {
      await evaluatePollingTriggerDefinition({
        store,
        state,
        projectFolder,
        definition,
        triggerProvidersByKind,
        pollContext,
        isIntegrationAvailable: this.isIntegrationAvailable,
        runAutomation: this.runAutomation,
        now: this.now,
        createRunId: this.createRunId,
        inFlight: this.inFlight,
        emitRunEvent: (event) => {
          this.trackPendingAgentRun(projectFolder.folderPath, event.run, event.workspaceId ?? projectFolder.workspaceId)
          this.emitRunEvent({ ...event, trigger: 'timer' })
        },
        result,
      })
      return
    }

    const validation = validateScheduleTriggerConfig(definition.trigger.config)
    if (!validation.ok) {
      result.problems.push({
        workspaceRoot,
        automationId: definition.id,
        code: 'invalid_schedule',
        message: validation.error,
      })
      return
    }

    const nextRunAt = definition.nextRunAt ?? state.nextRunAtByAutomationId[definition.id] ?? null
    if (!nextRunAt) {
      await this.persistNextRun(store, state, workspaceRoot, definition, validation.value, now, result)
      return
    }

    const dueAt = Date.parse(nextRunAt)
    if (!Number.isFinite(dueAt)) {
      result.problems.push({
        workspaceRoot,
        automationId: definition.id,
        code: 'invalid_next_run_at',
        message: `Automation "${definition.id}" has an invalid nextRunAt value.`,
      })
      return
    }

    if (mode === 'startup' && dueAt < now) {
      await this.skipOverdueRun(store, state, workspaceRoot, definition, validation.value, nextRunAt, now, result)
      return
    }

    if (dueAt <= now) {
      await this.fireDueRun(store, state, projectFolder, definition, validation.value, nextRunAt, result)
      return
    }

    if (state.nextRunAtByAutomationId[definition.id] !== nextRunAt) {
      state.nextRunAtByAutomationId[definition.id] = nextRunAt
      const written = await store.writeState(state)
      if (!written.ok) result.problems.push(storeProblem(workspaceRoot, written.error, definition.id))
    }
    result.scheduled.push({ workspaceRoot, automationId: definition.id, nextRunAt })
  }

  private async persistNextRun(
    store: AutomationsStore,
    state: AutomationStoreState,
    workspaceRoot: string,
    definition: AutomationDefinition,
    config: ScheduleTriggerConfig,
    after: number,
    result: AutomationsEngineEvaluationResult
  ): Promise<void> {
    const nextRunAt = nextRunIso(config, after)
    if (!nextRunAt) {
      // A one-shot whose fire time has passed simply has no upcoming run —
      // documented terminal state, nothing to persist and nothing to report.
      if (scheduleCadenceCanExhaust(config)) return
      result.problems.push({
        workspaceRoot,
        automationId: definition.id,
        code: 'next_run_unavailable',
        message: `Unable to compute next run for automation "${definition.id}".`,
      })
      return
    }

    const updated = await store.updateDefinition({
      ...definition,
      nextRunAt,
      updatedAt: new Date(after).toISOString(),
    })
    if (!updated.ok) {
      result.problems.push(storeProblem(workspaceRoot, updated.error, definition.id))
      return
    }

    state.nextRunAtByAutomationId[definition.id] = nextRunAt
    const written = await store.writeState(state)
    if (!written.ok) {
      result.problems.push(storeProblem(workspaceRoot, written.error, definition.id))
      return
    }
    result.scheduled.push({ workspaceRoot, automationId: definition.id, nextRunAt })
  }

  private async skipOverdueRun(
    store: AutomationsStore,
    state: AutomationStoreState,
    workspaceRoot: string,
    definition: AutomationDefinition,
    config: ScheduleTriggerConfig,
    dueAt: string,
    now: number,
    result: AutomationsEngineEvaluationResult
  ): Promise<void> {
    const completedAt = new Date(now).toISOString()
    const run = this.runRecord(workspaceRoot, definition.id, dueAt, {
      status: 'skipped',
      startedAt: null,
      completedAt,
      blockedReason: 'overdue_not_replayed',
      summary: 'Missed while Multicode was not running; skipped instead of replaying catch-up runs.',
    })
    const recorded = await store.recordRun(run)
    if (!recorded.ok) {
      result.problems.push(storeProblem(workspaceRoot, recorded.error, definition.id))
      return
    }

    const nextRunAt = nextRunIso(config, now)
    const updated = await this.updateDefinitionAfterRun(store, state, workspaceRoot, definition, config, run, nextRunAt, now, result)
    if (updated) result.skipped.push({ workspaceRoot, automationId: definition.id, runId: run.id, status: run.status })
  }

  private async fireDueRun(
    store: AutomationsStore,
    state: AutomationStoreState,
    projectFolder: AutomationsProjectFolder,
    definition: AutomationDefinition,
    config: ScheduleTriggerConfig,
    dueAt: string,
    result: AutomationsEngineEvaluationResult
  ): Promise<void> {
    const workspaceRoot = projectFolder.folderPath
    const inFlightKey = this.inFlightKey(workspaceRoot, definition.id)
    if (this.inFlight.has(inFlightKey)) {
      result.droppedInFlight.push({ workspaceRoot, automationId: definition.id })
      return
    }

    this.inFlight.add(inFlightKey)
    const startedAt = new Date(this.now()).toISOString()
    const run = this.runRecord(workspaceRoot, definition.id, dueAt, {
      status: 'running',
      startedAt,
      completedAt: null,
    })

    try {
      const started = await store.recordRun(run)
      if (!started.ok) {
        result.problems.push(storeProblem(workspaceRoot, started.error, definition.id))
        return
      }

      const patch = await this.runAutomation({
        workspaceRoot,
        definition,
        run,
        triggerPayload: { kind: 'schedule', dueAt },
        workspaceId: projectFolder.workspaceId,
      })
      const completedAt = patch.completedAt ?? new Date(this.now()).toISOString()
      const finalRun = completeRun(run, patch, completedAt)
      const completed = await store.recordRun(finalRun)
      if (!completed.ok) {
        result.problems.push(storeProblem(workspaceRoot, completed.error, definition.id))
        return
      }
      this.trackPendingAgentRun(workspaceRoot, finalRun, projectFolder.workspaceId)
      this.emitRunEvent({
        workspaceId: projectFolder.workspaceId,
        definition,
        run: finalRun,
        trigger: 'timer',
      })

      const nextRunAt = nextRunIso(config, Date.parse(completedAt))
      const updated = await this.updateDefinitionAfterRun(store, state, workspaceRoot, definition, config, finalRun, nextRunAt, Date.parse(completedAt), result)
      if (updated) result.fired.push({ workspaceRoot, automationId: definition.id, runId: finalRun.id, status: finalRun.status })
    } catch (error) {
      const failedAt = new Date(this.now()).toISOString()
      const failedRun = completeRun(run, {
        status: 'failed',
        completedAt: failedAt,
        summary: error instanceof Error ? error.message : 'Automation action failed.',
      }, failedAt)
      const recorded = await store.recordRun(failedRun)
      if (!recorded.ok) result.problems.push(storeProblem(workspaceRoot, recorded.error, definition.id))
      else {
        this.emitRunEvent({
          workspaceId: projectFolder.workspaceId,
          definition,
          run: failedRun,
          trigger: 'timer',
        })
      }

      const nextRunAt = nextRunIso(config, Date.parse(failedAt))
      const updated = await this.updateDefinitionAfterRun(store, state, workspaceRoot, definition, config, failedRun, nextRunAt, Date.parse(failedAt), result)
      if (updated) result.fired.push({ workspaceRoot, automationId: definition.id, runId: failedRun.id, status: failedRun.status })
    } finally {
      this.inFlight.delete(inFlightKey)
    }
  }

  private async updateDefinitionAfterRun(
    store: AutomationsStore,
    state: AutomationStoreState,
    workspaceRoot: string,
    definition: AutomationDefinition,
    config: ScheduleTriggerConfig,
    run: AutomationRun,
    nextRunAt: string | null,
    updatedAt: number,
    result: AutomationsEngineEvaluationResult
  ): Promise<boolean> {
    if (!nextRunAt && !scheduleCadenceCanExhaust(config)) {
      result.problems.push({
        workspaceRoot,
        automationId: definition.id,
        code: 'next_run_unavailable',
        message: `Unable to compute next run for automation "${definition.id}".`,
      })
      return false
    }

    // A null nextRunAt here is a fired (or already-past) one-shot: persisting
    // the null — definition AND state cache — is exactly what makes it fire
    // exactly once instead of staying due forever.
    const updated = await store.updateDefinition({
      ...definition,
      nextRunAt,
      lastRunAt: run.completedAt ?? new Date(updatedAt).toISOString(),
      lastRunId: run.id,
      updatedAt: new Date(updatedAt).toISOString(),
    })
    if (!updated.ok) {
      result.problems.push(storeProblem(workspaceRoot, updated.error, definition.id))
      return false
    }

    state.nextRunAtByAutomationId[definition.id] = nextRunAt
    const stateWrite = await store.writeState(state)
    if (!stateWrite.ok) {
      result.problems.push(storeProblem(workspaceRoot, stateWrite.error, definition.id))
      return false
    }
    if (nextRunAt) result.scheduled.push({ workspaceRoot, automationId: definition.id, nextRunAt })
    return true
  }

  private runRecord(
    workspaceRoot: string,
    automationId: string,
    dueAt: string,
    fields: Pick<AutomationRun, 'status' | 'startedAt' | 'completedAt'> & Partial<AutomationRun>
  ): AutomationRun {
    return {
      id: this.createRunId({ workspaceRoot, automationId, dueAt }),
      automationId,
      dueAt,
      ...fields,
    }
  }

  private inFlightKey(workspaceRoot: string, automationId: string): string {
    return `${workspaceRoot}\u0000${automationId}`
  }

  private emitRunEvent(input: {
    workspaceId?: string | null
    definition: AutomationDefinition
    run: AutomationRun
    trigger: AutomationRunEventTrigger
  }): void {
    if (!this.onRunEvent || !isRunEventStatus(input.run.status)) return
    const workspaceId = input.workspaceId?.trim()
    if (!workspaceId) return
    const event: AutomationsRunEvent = {
      automationId: input.definition.id,
      runId: input.run.id,
      workspaceId,
      ...(input.run.agentId ? { agentId: input.run.agentId } : {}),
      definitionName: input.definition.name,
      status: input.run.status,
      trigger: input.trigger,
    }
    try {
      this.onRunEvent(event, input.definition)
    } catch {
      // Renderer delivery is best-effort; run records and IPC results are authoritative.
    }
  }

  private async resolveWorkspaceIdForRoot(workspaceRoot: string): Promise<string | null> {
    try {
      const projectFolders = this.getProjectFolders
        ? await this.getProjectFolders()
        : this.getWorkspaceSnapshot
          ? projectFoldersFromWorkspaceSyncSnapshot(await this.getWorkspaceSnapshot())
          : []
      const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot)
      return dedupeProjectFolders(projectFolders).find((folder) => normalizeWorkspaceRoot(folder.folderPath) === normalizedRoot)?.workspaceId ?? null
    } catch {
      return null
    }
  }
}

export function createAutomationsEngine(options: AutomationsEngineOptions): AutomationsEngine {
  return new AutomationsEngine(options)
}

export function projectFoldersFromWorkspaceSyncSnapshot(snapshot: WorkspaceSyncSnapshot): AutomationsProjectFolder[] {
  return dedupeProjectFolders(
    snapshot.state.workspaces.flatMap((workspace) => {
      const folderPath = workspace.folderPath?.trim()
      return folderPath ? [{ workspaceId: workspace.id, folderPath }] : []
    })
  )
}

function completeRun(run: AutomationRun, patch: Partial<AutomationRun>, completedAt: string): AutomationRun {
  const status = patch.status ?? 'completed'
  // An agent-backed run returns `running`: the action launched a long-lived
  // agent and the run stays in-progress (linked to its terminal) until
  // finalizeRun records the real outcome. Non-terminal runs carry no
  // completedAt and emit no terminal run-event.
  return {
    ...run,
    status,
    completedAt: isTerminalRunStatus(status) ? completedAt : null,
    blockedReason: patch.blockedReason,
    workspaceId: patch.workspaceId,
    agentId: patch.agentId,
    executionId: patch.executionId,
    promptFingerprint: patch.promptFingerprint,
    touchedFiles: patch.touchedFiles,
    commandsRan: patch.commandsRan,
    summary: patch.summary,
    worktreePath: patch.worktreePath,
    branch: patch.branch,
    pullRequestUrl: patch.pullRequestUrl,
  }
}

// The max-run limit as a person would say it, for the sweep's run summary. Read
// from the configured cap rather than hardcoded, so the number a user is told is
// always the number that was actually applied.
function formatRunLimit(ms: number): string {
  const hours = ms / 3_600_000
  if (hours >= 1) {
    const rounded = Math.round(hours * 10) / 10
    return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`
  }
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

function isTerminalRunStatus(status: AutomationRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'blocked' || status === 'skipped'
}

function nextRunIso(config: ScheduleTriggerConfig, after: number): string | null {
  const nextRun = computeNextRun(config, after)
  return nextRun === null ? null : new Date(nextRun).toISOString()
}

function createTriggerPollContext(): AutomationTriggerPollContext {
  const sharedValues = new Map<string, Promise<unknown>>()
  return {
    getSharedValue<T>(key: string, factory: () => Promise<T>): Promise<T> {
      const existing = sharedValues.get(key)
      if (existing) return existing as Promise<T>
      const created = Promise.resolve().then(factory)
      sharedValues.set(key, created)
      return created
    },
  }
}

function dedupeProjectFolders(projectFolders: AutomationsProjectFolder[]): AutomationsProjectFolder[] {
  const seen = new Set<string>()
  const deduped: AutomationsProjectFolder[] = []
  for (const projectFolder of projectFolders) {
    const folderPath = projectFolder.folderPath.trim()
    if (!folderPath) continue
    const key = folderPath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push({ workspaceId: projectFolder.workspaceId, folderPath })
  }
  return deduped
}

function isRunEventStatus(status: AutomationRunStatus): status is AutomationRunEventStatus {
  return status === 'completed' || status === 'failed' || status === 'blocked'
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return workspaceRoot.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function storeProblem(workspaceRoot: string, error: AutomationStoreProblem, automationId?: string): AutomationsEngineProblem {
  return {
    workspaceRoot,
    automationId,
    code: error.code,
    message: `${error.path}: ${error.message}`,
  }
}

function emptyEvaluationResult(): AutomationsEngineEvaluationResult {
  return {
    scheduled: [],
    fired: [],
    skipped: [],
    droppedInFlight: [],
    problems: [],
  }
}
