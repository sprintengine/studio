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
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { AutomationsStore, type AutomationStoreProblem, type AutomationStoreState } from './store'
import type { AutomationApprovalGate } from './approval-ledger'
import type { AutomationPullRequestResult } from './pull-request'
import { computeNextRun, scheduleCadenceCanExhaust, validateScheduleTriggerConfig } from './schedule'
import { evaluatePollingTriggerDefinition } from './polling-trigger-runner'
import { completeAutomationRun as completeRun } from './run-record'
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
  { ok: true; definition: AutomationDefinition; run: AutomationRun } | { ok: false; problem: AutomationsEngineProblem }

export type AutomationsEngineTriggerEventDeliveryResult =
  | { ok: true; definition: AutomationDefinition; delivery: Exclude<TriggerEventRunResult, { status: 'problem' }> }
  | { ok: false; problem: AutomationsEngineProblem }

export type AutomationsEngineFinalizeResult =
  { ok: true; run: AutomationRun } | { ok: false; problem: AutomationsEngineProblem }

export type AutomationRunPullRequestOpener = (input: {
  workspaceRoot: string
  worktreePath: string
  branch: string
  title: string
  body: string
}) => Promise<AutomationPullRequestResult>

export type AutomationRunWorktreeRemover = (input: { workspaceRoot: string; worktreePath: string }) => Promise<void>

// Disposes the run's chat agent (stop its conversation session + delete its
// record) at finalize, so a one-shot automation agent never outlives its
// torn-down worktree and is never typed into against a dead working root.
// Best-effort and idempotent.
export type AutomationRunAgentDisposer = (input: { workspaceId: string; agentId: string }) => Promise<void>

// A turn of a chat conversation, as the owning module routes it from the
// conversation runtime. Every chat's turns arrive here; only a run's own agent
// (matched on its sessionId, else its workspaceId and agentId) does anything.
// `turn_completed` is a turn that really ended — a turn a steer closed carries
// on as the next one and is not routed as an end.
export type AutomationConversationTurnEvent = {
  type: 'turn_started' | 'turn_completed' | 'turn_failed'
  sessionId?: string | null
  workspaceId: string | null
  agentId: string
  // Background agents the conversation still had running when the turn ended.
  // They keep it working after its turn, so a turn end with any left is not
  // the run's end.
  backgroundAgents?: number
}

// The end of a run's conversation with no turn end behind it: its session
// closed (stopped, or its provider went away), or its first message never
// became a turn at all.
export type AutomationConversationEndEvent = {
  reason: 'session_closed' | 'first_send_failed'
  sessionId?: string | null
  workspaceId?: string | null
  agentId?: string
  message?: string
}

export type AutomationsEngineOptions = {
  // The approval ledger. Required, so no engine is ever built that runs a
  // definition nobody said yes to: every fire — schedule, polled trigger,
  // webhook delivery, Run now — asks it first (approval-ledger.ts).
  approvals: AutomationApprovalGate
  getProjectFolders?: () => AutomationsProjectFolder[] | Promise<AutomationsProjectFolder[]>
  getWorkspaceSnapshot?: () => WorkspaceSyncSnapshot | Promise<WorkspaceSyncSnapshot>
  createStore?: (workspaceRoot: string) => AutomationsStore
  triggerProviders?: AutomationTriggerProvider[]
  getTriggerProviders?: () => AutomationTriggerProvider[]
  isIntegrationAvailable?: (id: string) => boolean | undefined
  runAutomation: AutomationRunExecutor
  now?: () => number
  createRunId?: (input: { workspaceRoot: string; automationId: string; dueAt: string }) => string
  // The cadence for work that has no due time of its own: polling triggers, a
  // workspace snapshot that could not be read, a run dropped because the last
  // one was still going. Schedules do not wait for it (see
  // `nextAutomationsWakeDelayMs`).
  pollIntervalMs?: number
  // The longest the scheduler sleeps with nothing due (DEFAULT_MAX_SLEEP_MS).
  maxSleepMs?: number
  // Injected so the arming is testable without real time.
  timers?: {
    setTimeout(handler: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
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
  // Live conversation sessionIds, used by the startup reconcile to tell an
  // orphaned pending run (its conversation gone while the studio was down)
  // from one whose conversation is still live. Absent in tests that do not
  // exercise reconcile.
  getLiveConversationSessionIds?: () => string[]
  // How long a turn-end must stand before it finalizes the run (see
  // DEFAULT_TURN_SETTLE_MS). Injectable so tests do not wait it out.
  turnSettleMs?: number
  // Reads the run summary from the run's conversation: its last reply.
  // Absent, a completed run gets the generic summary. Injectable so tests can
  // hold the read open and pin the finalize races that live inside its await.
  readRunConversationSummary?: (input: {
    sessionId?: string
    workspaceId?: string
    agentId?: string
  }) => Promise<string | undefined>
  // Backstop cap on a pending agent run's wall-clock life (see
  // DEFAULT_MAX_AGENT_RUN_MS).
  maxAgentRunMs?: number
}

type EvaluationMode = 'startup' | 'timer'

// A turn-end that has been observed and is waiting out the settle window. A
// new turn of the same conversation cancels it; the timer firing (or the
// conversation ending first) finalizes the run with this outcome. The summary
// is read at fire time, so a cancelled turn-end costs no read.
type ArmedTurnEnd = {
  outcome: 'completed' | 'failed'
  timer: ReturnType<typeof setTimeout>
  // Single-flight finalize. Set when the settle timer (or a racing session
  // close) fires the turn-end; the armed record stays on the run until
  // finalizeRun takes over, so a close landing during the summary read joins
  // this promise instead of recording `failed` over a successful run.
  finalizing?: Promise<void>
}

// An agent-backed run that was dispatched as `running` and is awaiting its
// conversation's outcome. Correlated to conversation events by the sessionId
// the launch returned, or by (workspaceId, agentId) — the pair every event
// carries and every launched run records.
type PendingAgentRun = {
  workspaceRoot: string
  automationId: string
  runId: string
  // Absent on a runInWorktree:false run, which finalizes like any other.
  worktreePath?: string
  workspaceId?: string
  agentId?: string
  // The conversation session the run's launch started. The startup reconcile
  // reads it to tell a live conversation from one the restart ended.
  sessionId?: string
  // Wall-clock start, for the max-duration sweep.
  startedAtMs: number
  // A turn-end can only finalize a run that was seen working first, so a turn
  // end of anything but the run's own prompt cannot dispose a live agent.
  observedWorkingPhase: boolean
  armedTurnEnd?: ArmedTurnEnd
}

// Conversation events for a chat no pending run matched yet. A run's agent
// starts its first turn while the launch is still being recorded — the first
// message goes out as the session comes up, and the run is registered only
// once the executor has returned and the run is on disk — so the start of the
// turn (and, for a fast failure, its end) can arrive before the run it
// belongs to. They wait here, by chat, and are replayed when a run for that
// chat is registered. Bounded: every chat's events pass through, and only the
// newest few chats need remembering.
type UnmatchedConversationEvent =
  | { kind: 'turn'; event: AutomationConversationTurnEvent; at: number }
  | { kind: 'end'; event: AutomationConversationEndEvent; at: number }
const MAX_UNMATCHED_CONVERSATIONS = 32
const MAX_UNMATCHED_EVENTS_PER_CONVERSATION = 8
const UNMATCHED_CONVERSATION_EVENT_TTL_MS = 60_000

const DEFAULT_POLL_INTERVAL_MS = 60_000

// The scheduler sleeps until the next thing it knows is due. This caps that
// sleep, for what it cannot know about: a definition edited by hand on disk, a
// project folder added with automations already in it. Writes through the app
// wake the scheduler at once (`wake`), and so does waking from sleep — which
// matters, because a timer armed before a sleep counts only the time the
// machine was awake, so a schedule due during the nap would otherwise fire
// late by however long the nap was.
const DEFAULT_MAX_SLEEP_MS = 15 * 60_000

// The earliest a wake is re-armed. A due time a hair in the future must not
// become a tight loop of zero-length timers.
const MIN_WAKE_DELAY_MS = 1_000

export type AutomationsWakeInput = {
  now: number
  // The last evaluation's result, or null when it failed outright.
  result: AutomationsEngineEvaluationResult | null
  // Whether that evaluation polled any trigger provider. Polling triggers have
  // no due time; they are asked on the poll cadence.
  polledTriggers: boolean
  // Wall-clock deadlines of pending agent runs (their max-duration sweep).
  pendingRunDeadlines: number[]
  pollIntervalMs: number
  maxSleepMs: number
}

/**
 * How long the automations scheduler may sleep after an evaluation.
 *
 * It used to tick every sixty seconds whether or not anything existed to run,
 * and every tick re-read every project's automations from disk. Now it wakes
 * for the soonest of: the next scheduled run, the next pending run's
 * max-duration deadline, the poll cadence when something needs polling (or the
 * evaluation could not finish), and the max-sleep cap. A machine with no
 * automations wakes four times an hour instead of sixty.
 */
export function nextAutomationsWakeDelayMs(input: AutomationsWakeInput): number {
  let delay = input.maxSleepMs
  const needsPolling =
    input.result === null ||
    input.polledTriggers ||
    input.result.droppedInFlight.length > 0 ||
    input.result.problems.some((problem) => problem.code === 'workspace_snapshot_failed')
  if (needsPolling) delay = Math.min(delay, input.pollIntervalMs)

  const dueTimes = [
    ...(input.result?.scheduled ?? []).map((entry) => Date.parse(entry.nextRunAt)),
    ...input.pendingRunDeadlines,
  ]
  for (const dueAt of dueTimes) {
    if (!Number.isFinite(dueAt)) continue
    // Something already due that this evaluation did not fire is not a reason
    // to spin: the poll cadence is the retry, exactly as it was before.
    const until = dueAt - input.now
    delay = Math.min(delay, until > 0 ? until : input.pollIntervalMs)
  }
  return Math.max(MIN_WAKE_DELAY_MS, Math.ceil(delay))
}

// A turn end is not the same as being done: an agent can carry on by itself
// (a background agent finishing, a hook in the user's own settings continuing
// the turn), and it can end its turn to ask a question. Finalizing is
// destructive (opens a PR, removes the worktree, disposes the agent), so an
// armed turn-end waits this long and a new turn in the window disarms it.
const DEFAULT_TURN_SETTLE_MS = 15_000

// Bounded backstop for runs whose conversation never reports a turn end: a
// provider that hangs mid-turn, or an event lost to a crash between the
// runtime and this engine. Past this age a pending run is failed rather than
// left Running forever — the bug this whole path exists to fix.
const DEFAULT_MAX_AGENT_RUN_MS = 6 * 60 * 60 * 1000

// Why a definition that is waiting for approval did not run, in the words the
// Automations screen and an MCP caller both read.
export const AUTOMATION_NEEDS_APPROVAL_CODE = 'needs_approval'

export class AutomationsEngine {
  private readonly approvals: AutomationApprovalGate
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
  private readonly getLiveConversationSessionIds?: () => string[]
  private readonly turnSettleMs: number
  private readonly maxAgentRunMs: number
  private readonly readRunConversationSummary?: AutomationsEngineOptions['readRunConversationSummary']
  private readonly inFlight = new Set<string>()
  private readonly pendingAgentRuns = new Map<string, PendingAgentRun>()
  // Keyed by chat (workspaceId, agentId); insertion order is age.
  private readonly unmatchedConversationEvents = new Map<string, UnmatchedConversationEvent[]>()
  // Per-run finalize lock (pendingRunKey shape). Closes the manual-IPC vs
  // signal-scan TOCTOU: only the first caller finalizes; a concurrent caller
  // gets the in-progress/terminal run back instead of double-opening a PR.
  private readonly finalizingRuns = new Set<string>()
  private readonly maxSleepMs: number
  private readonly timers: { setTimeout(handler: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
  private timer: unknown = null
  // When the armed timer fires (engine clock), so a deadline that turns up
  // between evaluations can tell whether it needs an earlier one.
  private timerDueAt: number | null = null
  // Set by an evaluation that asked a trigger provider to poll.
  private polledTriggers = false
  private timerLoopActive = false
  private evaluateAgain = false
  private started = false
  private startupEvaluation: Promise<AutomationsEngineEvaluationResult> | null = null
  private timerEvaluation: Promise<AutomationsEngineEvaluationResult> | null = null

  constructor(options: AutomationsEngineOptions) {
    this.approvals = options.approvals
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
    this.maxSleepMs = Math.max(1_000, Math.floor(options.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS))
    this.timers = options.timers ?? {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    this.onEvaluation = options.onEvaluation
    this.onRunEvent = options.onRunEvent
    this.openRunPullRequest = options.openRunPullRequest
    this.removeRunWorktree = options.removeRunWorktree
    this.disposeRunAgent = options.disposeRunAgent
    this.getLiveConversationSessionIds = options.getLiveConversationSessionIds
    this.turnSettleMs = Math.max(0, Math.floor(options.turnSettleMs ?? DEFAULT_TURN_SETTLE_MS))
    this.maxAgentRunMs = Math.max(1_000, Math.floor(options.maxAgentRunMs ?? DEFAULT_MAX_AGENT_RUN_MS))
    this.readRunConversationSummary = options.readRunConversationSummary
  }

  start(): void {
    if (this.started) return
    this.started = true

    const startup = this.handleStartup()
    void startup
      .catch(() => null)
      .then((result) => {
        if (!this.started || this.timer !== null) return
        this.armWake(result)
      })
  }

  /**
   * Evaluate now and re-arm from what that finds. For anything that may have
   * moved a due time the sleeping timer does not know about: a definition
   * written through the app, and a wake from sleep.
   */
  wake(): void {
    if (!this.started) return
    this.clearWake()
    void this.runTimerEvaluation()
  }

  private clearWake(): void {
    if (this.timer === null) return
    this.timers.clearTimeout(this.timer)
    this.timer = null
    this.timerDueAt = null
  }

  private setWake(delay: number): void {
    this.timerDueAt = this.now() + delay
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      this.timerDueAt = null
      void this.runTimerEvaluation()
    }, delay)
  }

  /**
   * A pending run registered outside a timer evaluation — a manual run, a
   * webhook delivery, a run a finished evaluation dispatched in the background —
   * brings a max-duration deadline the armed timer was not computed from. Pull
   * the timer in to that deadline when it is sooner, so the limit is enforced on
   * time rather than at the next quarter-hour wake. An evaluation in flight
   * re-arms from the pending set when it ends, and one that has not started yet
   * (startup) arms afterwards, so both are left alone.
   */
  private armForDeadline(deadline: number): void {
    if (!this.started || this.timer === null || this.timerLoopActive) return
    if (this.timerDueAt !== null && this.timerDueAt <= deadline) return
    this.clearWake()
    this.setWake(Math.max(MIN_WAKE_DELAY_MS, Math.ceil(deadline - this.now())))
  }

  private armWake(result: AutomationsEngineEvaluationResult | null): void {
    this.clearWake()
    if (!this.started) return
    const now = this.now()
    const delay = nextAutomationsWakeDelayMs({
      now,
      result,
      polledTriggers: this.polledTriggers,
      pendingRunDeadlines: [...this.pendingAgentRuns.values()].map(
        (pending) => pending.startedAtMs + this.maxAgentRunMs,
      ),
      pollIntervalMs: this.pollIntervalMs,
      maxSleepMs: this.maxSleepMs,
    })
    this.setWake(delay)
  }

  // One timer evaluation, joined if one is already running, then re-armed. A
  // wake that lands mid-evaluation asks for one more pass: the evaluation in
  // flight may have read the definitions before the write that caused it.
  private async runTimerEvaluation(): Promise<void> {
    if (this.timerLoopActive) {
      this.evaluateAgain = true
      return
    }
    this.timerLoopActive = true
    let result: AutomationsEngineEvaluationResult | null = null
    try {
      do {
        this.evaluateAgain = false
        try {
          result = await (this.timerEvaluation ?? this.tick())
        } catch {
          result = null
        }
      } while (this.evaluateAgain && this.started)
    } finally {
      this.timerLoopActive = false
    }
    if (this.started) this.armWake(result)
  }

  stop(): void {
    // Armed turn-ends are cleared unconditionally: a settle timer that survives
    // stop() would finalize a run — opening a PR and disposing an agent — for an
    // engine the app has already torn down. Disarming also aborts an in-flight
    // armed finalize at its post-summary-read check; only a finalize that has
    // already entered finalizeRun still runs to completion.
    for (const pending of this.pendingAgentRuns.values()) this.disarmTurnEnd(pending)
    if (!this.started && this.timer === null) return
    this.started = false
    this.clearWake()
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
    // Run now is a fire like any other: a person pressing it on a definition
    // they have not approved is asked to review it, not handed a run of it.
    const unapproved = await this.approvalProblem(input.workspaceRoot, definition)
    if (unapproved) return { ok: false, problem: unapproved }
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
          workspaceId: input.workspaceId ?? (await this.resolveWorkspaceIdForRoot(input.workspaceRoot)) ?? undefined,
        })
        const completedAt = patch.completedAt ?? new Date(this.now()).toISOString()
        finalRun = completeRun(run, patch, completedAt)
      } catch (error) {
        const failedAt = new Date(this.now()).toISOString()
        finalRun = completeRun(
          run,
          {
            status: 'failed',
            completedAt: failedAt,
            summary: error instanceof Error ? error.message : 'Automation action failed.',
          },
          failedAt,
        )
      }

      const completed = await store.recordRun(finalRun)
      if (!completed.ok) {
        return { ok: false, problem: storeProblem(input.workspaceRoot, completed.error, definition.id) }
      }
      const eventWorkspaceId =
        input.workspaceId ?? (await this.resolveWorkspaceIdForRoot(input.workspaceRoot)) ?? finalRun.workspaceId
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
        result,
        // Manual "Run now" does not consume a once-off's single triggered fire.
        { consumeOnceOffShot: false },
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
    // The receiver only routes approved definitions, but it routes from its last
    // refresh, and a `git pull` since then does not refresh it. So the delivery
    // re-reads and asks again rather than trusting the route table.
    const unapproved = await this.approvalProblem(input.workspaceRoot, definition)
    if (unapproved) return { ok: false, problem: unapproved }
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

    const missingIntegrations = (provider.requiredIntegrations ?? []).filter(
      (id) => this.isIntegrationAvailable?.(id) !== true,
    )
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
    const workspaceId = input.workspaceId ?? (await this.resolveWorkspaceIdForRoot(input.workspaceRoot)) ?? ''
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

  // The finalize trigger for the happy path: a turn of a chat conversation.
  // Turns of chats that own no pending run (every chat but a run's agent) are
  // held briefly in case their run is still being recorded, then forgotten.
  //
  // A turn start marks the run as having done work and disarms any settle
  // timer. A turn end arms one, but only past the guards — each of which stands
  // between a live agent and a destructive finalize that opens a PR from
  // half-finished work, removes the agent's working root, and disposes it:
  //   - the run has been seen working, so a turn end that is not the end of
  //     the run's own prompt cannot finalize it;
  //   - the conversation has no background agents still running — they keep it
  //     working past its turn, and it carries on with a new turn when they
  //     report back;
  //   - the settle window elapses with no new turn (see DEFAULT_TURN_SETTLE_MS).
  async noteConversationTurn(event: AutomationConversationTurnEvent): Promise<void> {
    const pending = this.findPendingRunForConversation(event)
    if (!pending) {
      this.rememberUnmatchedConversationEvent({ kind: 'turn', event, at: this.now() })
      return
    }
    if (event.sessionId && !pending.sessionId) pending.sessionId = event.sessionId

    if (event.type === 'turn_started') {
      pending.observedWorkingPhase = true
      this.disarmTurnEnd(pending)
      return
    }

    if (!pending.observedWorkingPhase) return
    if (event.type === 'turn_completed' && (event.backgroundAgents ?? 0) > 0) return
    if (pending.armedTurnEnd) return

    pending.armedTurnEnd = {
      outcome: event.type === 'turn_failed' ? 'failed' : 'completed',
      timer: setTimeout(() => {
        void this.finalizeArmedTurnEnd(pending)
      }, this.turnSettleMs),
    }
    pending.armedTurnEnd.timer.unref?.()
  }

  // The other finalize trigger: the run's conversation ended with no turn end
  // behind it — its session closed, or its first message was refused. The
  // owning module routes both here. Correlates on the sessionId or on
  // (workspaceId, agentId); an end matching no pending run (any other chat, or
  // an already-finalized run) is held like an unmatched turn and then ignored.
  //
  // An armed turn-end WINS over the end: an agent that finished its turn and
  // whose session then closed inside the settle window succeeded, and
  // recording it as failed would throw away its PR. Only an end with no
  // turn-end behind it is a failure. Routed 'timer' so a failed auto-finalize
  // still emits a run-event while a completed one stays silent. Shares
  // finalizeRun's lock and idempotency, so a concurrent tick/manual finalize
  // still yields one record.
  async finalizeRunOnConversationEnd(input: AutomationConversationEndEvent): Promise<void> {
    const pending = this.findPendingRunForConversation(input)
    if (!pending) {
      this.rememberUnmatchedConversationEvent({ kind: 'end', event: input, at: this.now() })
      return
    }

    if (pending.armedTurnEnd) {
      await this.finalizeArmedTurnEnd(pending)
      // The armed finalize can abort if a straggler turn start disarmed it
      // mid-summary-read. The conversation is over either way, so a run the
      // abort left pending falls through to the end's outcome below instead of
      // hanging until the max-duration sweep.
      if (!this.pendingAgentRuns.has(this.pendingRunKey(pending.workspaceRoot, pending.automationId, pending.runId))) {
        return
      }
    }
    const detail = input.message?.trim()
    await this.finalizeRun({
      workspaceRoot: pending.workspaceRoot,
      automationId: pending.automationId,
      runId: pending.runId,
      outcome: 'failed',
      summary:
        input.reason === 'first_send_failed'
          ? `The agent never started on the task: ${detail || 'its first message was refused.'}`
          : `The agent stopped before it finished${detail ? `: ${detail}` : '.'}`,
      workspaceId: pending.workspaceId,
      eventTrigger: 'timer',
    })
  }

  // Fire an armed turn-end. Single-flight: the settle timer and a racing
  // conversation end share one in-flight finalize, so the armed outcome always
  // wins over the end's `failed`. The armed record stays on the run while the
  // summary is read; anything that disarms it during that read — a new turn
  // (the agent carried on), a manual finalize, stop() — aborts the finalize
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
  // Best-effort by design — no reply, or one that cannot be read, degrades to a
  // generic summary and never blocks the finalize.
  private async finalizeTurnEnd(pending: PendingAgentRun, armed: ArmedTurnEnd): Promise<void> {
    const replySummary =
      armed.outcome === 'completed' && this.readRunConversationSummary
        ? await this.readRunConversationSummary({
            sessionId: pending.sessionId,
            workspaceId: pending.workspaceId,
            agentId: pending.agentId,
          }).catch(() => undefined)
        : undefined
    // Disarmed during the summary read: the turn-end no longer stands, so
    // finalizing now would dispose an agent that is working again (or drive an
    // engine that has been stopped). finalizeRun below re-disarms and drops the
    // pending entry synchronously, so this check cannot miss its own finalize.
    if (pending.armedTurnEnd !== armed) return
    // Every summary here is read verbatim by a person in the run row, so it names
    // the cause in plain language and never in the runtime's vocabulary: a "turn"
    // is an agent-runtime concept, and a user reading their automation history has
    // no model for it. The completed fallback in particular must not overclaim —
    // with no reply, all that is actually known is that the agent stopped
    // talking, so it says exactly that rather than "finished its turn".
    const summary =
      armed.outcome === 'failed'
        ? 'The agent hit an error and stopped before it finished.'
        : replySummary?.trim() || 'The agent finished, but left no summary of what it did.'
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
    store: AutomationsStore,
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

    let pullRequestUrl: string | undefined
    const summaryParts: string[] = []
    if (input.summary?.trim()) summaryParts.push(input.summary.trim())

    if (input.outcome === 'completed' && run.branch && run.worktreePath && this.openRunPullRequest) {
      const pr = await this.openRunPullRequest({
        workspaceRoot: input.workspaceRoot,
        worktreePath: run.worktreePath,
        branch: run.branch,
        title: `Automation: ${definitionName}`,
        body: `Opened by the "${definitionName}" automation (run ${run.id}).`,
      })
      if (pr.ok) {
        pullRequestUrl = pr.url
        summaryParts.push(pr.created ? `Opened pull request ${pr.url}.` : `Linked existing pull request ${pr.url}.`)
      } else {
        summaryParts.push(`No pull request linked: ${pr.reason}`)
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
    // finalize for runs orphaned while the studio was down), so a crash mid-run is
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
        input.workspaceId ?? run.workspaceId ?? (await this.resolveWorkspaceIdForRoot(input.workspaceRoot)) ?? undefined
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
      // Force-fail runs orphaned while the studio was down before the scan below
      // gets a chance to leave them pending forever (their agent is gone).
      await this.reconcileOrphanedAgentRuns()
    }
    const pollContext = createTriggerPollContext()
    const triggerProvidersByKind = new Map(this.getTriggerProviders().map((provider) => [provider.kind, provider]))
    this.polledTriggers = false

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
        summary: `The agent was still running after ${formatRunLimit(this.maxAgentRunMs)}, so SprintEngine stopped waiting and ended the run.`,
        workspaceId: pending.workspaceId,
        eventTrigger: 'timer',
      })
    }
  }

  // Startup reconciliation: an agent-backed run recorded `running` whose
  // sessionId is NOT among the live conversation sessions had its conversation
  // end while the studio was down — force-fail it. A run whose session is still
  // live stays pending for its turns; a run with no recorded sessionId is never
  // force-failed here (nothing proves its agent is gone) and is covered by the
  // max-duration sweep instead.
  private async reconcileOrphanedAgentRuns(): Promise<void> {
    if (!this.getLiveConversationSessionIds || this.pendingAgentRuns.size === 0) return
    const liveSessionIds = new Set(this.getLiveConversationSessionIds())
    for (const pending of [...this.pendingAgentRuns.values()]) {
      if (!pending.sessionId || liveSessionIds.has(pending.sessionId)) continue
      await this.finalizeRun({
        workspaceRoot: pending.workspaceRoot,
        automationId: pending.automationId,
        runId: pending.runId,
        outcome: 'failed',
        summary: 'The agent stopped while the app was closed, so this run never finished.',
        workspaceId: pending.workspaceId,
        eventTrigger: 'timer',
      })
    }
  }

  // The run a conversation event belongs to. The sessionId the launch
  // returned is the key when both sides have it — a chat whose session was
  // replaced (a window restarting it) is then not mistaken for the run's —
  // and (workspaceId, agentId), stamped on every agent-backed run at launch
  // and carried by every event, is the key otherwise. A partial key matches
  // nothing.
  private findPendingRunForConversation(event: {
    sessionId?: string | null
    workspaceId?: string | null
    agentId?: string
  }): PendingAgentRun | undefined {
    const sessionId = event.sessionId?.trim()
    if (sessionId) {
      for (const pending of this.pendingAgentRuns.values()) {
        if (pending.sessionId === sessionId) return pending
      }
    }
    if (!event.workspaceId || !event.agentId) return undefined
    for (const pending of this.pendingAgentRuns.values()) {
      if (pending.workspaceId !== event.workspaceId || pending.agentId !== event.agentId) continue
      if (sessionId && pending.sessionId && pending.sessionId !== sessionId) continue
      return pending
    }
    return undefined
  }

  private rememberUnmatchedConversationEvent(entry: UnmatchedConversationEvent): void {
    const { workspaceId, agentId } = entry.event
    if (!workspaceId || !agentId) return
    const key = conversationKey(workspaceId, agentId)
    const events = this.unmatchedConversationEvents.get(key) ?? []
    this.unmatchedConversationEvents.delete(key)
    events.push(entry)
    this.unmatchedConversationEvents.set(key, events.slice(-MAX_UNMATCHED_EVENTS_PER_CONVERSATION))
    while (this.unmatchedConversationEvents.size > MAX_UNMATCHED_CONVERSATIONS) {
      const oldest = this.unmatchedConversationEvents.keys().next().value
      if (oldest === undefined) break
      this.unmatchedConversationEvents.delete(oldest)
    }
  }

  // Replay what a newly registered run's conversation said before the run was
  // on record, in the order it said it.
  private async replayUnmatchedConversationEvents(pending: PendingAgentRun): Promise<void> {
    if (!pending.workspaceId || !pending.agentId) return
    const key = conversationKey(pending.workspaceId, pending.agentId)
    const events = this.unmatchedConversationEvents.get(key)
    if (!events) return
    this.unmatchedConversationEvents.delete(key)
    const oldest = this.now() - UNMATCHED_CONVERSATION_EVENT_TTL_MS
    for (const entry of events) {
      if (entry.at < oldest) continue
      if (entry.event.sessionId && pending.sessionId && entry.event.sessionId !== pending.sessionId) continue
      if (entry.kind === 'turn') await this.noteConversationTurn(entry.event)
      else await this.finalizeRunOnConversationEnd(entry.event)
    }
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
  // entry keeps its live turn state and only refreshes its correlation fields.
  // A new entry then hears what its conversation said before it was recorded.
  private trackPendingAgentRun(workspaceRoot: string, run: AutomationRun, workspaceId?: string): void {
    if (run.status !== 'running') return
    const key = this.pendingRunKey(workspaceRoot, run.automationId, run.id)
    const existing = this.pendingAgentRuns.get(key)
    if (existing) {
      existing.worktreePath = run.worktreePath ?? existing.worktreePath
      existing.workspaceId = workspaceId ?? run.workspaceId ?? existing.workspaceId
      existing.agentId = run.agentId ?? existing.agentId
      existing.sessionId = run.sessionId ?? existing.sessionId
      return
    }
    const startedAt = Date.parse(run.startedAt ?? '')
    const startedAtMs = Number.isFinite(startedAt) ? startedAt : this.now()
    const pending: PendingAgentRun = {
      workspaceRoot,
      automationId: run.automationId,
      runId: run.id,
      worktreePath: run.worktreePath,
      workspaceId: workspaceId ?? run.workspaceId,
      agentId: run.agentId,
      sessionId: run.sessionId,
      startedAtMs,
      observedWorkingPhase: false,
    }
    this.pendingAgentRuns.set(key, pending)
    this.armForDeadline(startedAtMs + this.maxAgentRunMs)
    void this.replayUnmatchedConversationEvents(pending)
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
    result: AutomationsEngineEvaluationResult,
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
        result,
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
    result: AutomationsEngineEvaluationResult,
  ): Promise<void> {
    const workspaceRoot = projectFolder.folderPath
    if (definition.status !== 'enabled') return
    // Before anything the definition says is acted on — its trigger polled, its
    // `nextRunAt` read, its state written. A repo can ship a `nextRunAt` in the
    // past; honouring it would fire the moment the approval landed, so an
    // unapproved definition's schedule is not even looked at, and approval clears
    // it so the next evaluation computes it fresh (automations-ipc.ts).
    const unapproved = await this.approvalProblem(workspaceRoot, definition)
    if (unapproved) {
      // The state cache is the same file's other copy of that schedule. Dropped
      // from this evaluation's copy of it, so a state write later in this pass
      // (another automation's) cannot put back the entry an approval clears.
      delete state.nextRunAtByAutomationId[definition.id]
      result.problems.push(unapproved)
      return
    }
    if (definition.trigger.kind !== 'schedule') {
      // Anything a provider can poll has no due time, so its cadence is what
      // wakes the scheduler. A push-only trigger (a webhook) is delivered, not
      // polled, and keeps nobody awake.
      if (triggerProvidersByKind.get(definition.trigger.kind)?.poll) this.polledTriggers = true
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
    result: AutomationsEngineEvaluationResult,
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
    result: AutomationsEngineEvaluationResult,
  ): Promise<void> {
    const completedAt = new Date(now).toISOString()
    const run = this.runRecord(workspaceRoot, definition.id, dueAt, {
      status: 'skipped',
      startedAt: null,
      completedAt,
      blockedReason: 'overdue_not_replayed',
      summary: 'Missed while SprintEngine was not running; skipped instead of replaying catch-up runs.',
    })
    const recorded = await store.recordRun(run)
    if (!recorded.ok) {
      result.problems.push(storeProblem(workspaceRoot, recorded.error, definition.id))
      return
    }

    const nextRunAt = nextRunIso(config, now)
    const updated = await this.updateDefinitionAfterRun(
      store,
      state,
      workspaceRoot,
      definition,
      config,
      run,
      nextRunAt,
      now,
      result,
    )
    if (updated) result.skipped.push({ workspaceRoot, automationId: definition.id, runId: run.id, status: run.status })
  }

  private async fireDueRun(
    store: AutomationsStore,
    state: AutomationStoreState,
    projectFolder: AutomationsProjectFolder,
    definition: AutomationDefinition,
    config: ScheduleTriggerConfig,
    dueAt: string,
    result: AutomationsEngineEvaluationResult,
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
      const updated = await this.updateDefinitionAfterRun(
        store,
        state,
        workspaceRoot,
        definition,
        config,
        finalRun,
        nextRunAt,
        Date.parse(completedAt),
        result,
      )
      if (updated)
        result.fired.push({ workspaceRoot, automationId: definition.id, runId: finalRun.id, status: finalRun.status })
    } catch (error) {
      const failedAt = new Date(this.now()).toISOString()
      const failedRun = completeRun(
        run,
        {
          status: 'failed',
          completedAt: failedAt,
          summary: error instanceof Error ? error.message : 'Automation action failed.',
        },
        failedAt,
      )
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
      const updated = await this.updateDefinitionAfterRun(
        store,
        state,
        workspaceRoot,
        definition,
        config,
        failedRun,
        nextRunAt,
        Date.parse(failedAt),
        result,
      )
      if (updated)
        result.fired.push({ workspaceRoot, automationId: definition.id, runId: failedRun.id, status: failedRun.status })
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
    result: AutomationsEngineEvaluationResult,
    // `runNow` passes false: a once-off (`disableAfterRun`) pauses after one
    // *triggered* fire — a manual run never consumes the shot.
    options?: { consumeOnceOffShot?: boolean },
  ): Promise<boolean> {
    // Once-off consumption: pause instead of rescheduling. A skipped overdue run
    // routes through here too, so a missed once-off records its `skipped` run and
    // then pauses (the documented missed-run rule). A failed run also consumed
    // the shot — the user re-enables to arm it again.
    const pauseAfterRun =
      options?.consumeOnceOffShot !== false && definition.disableAfterRun === true && definition.status === 'enabled'
    if (!pauseAfterRun && !nextRunAt && !scheduleCadenceCanExhaust(config)) {
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
    // exactly once instead of staying due forever. A paused once-off has no
    // upcoming run either, whatever its cadence would have computed.
    const persistedNextRunAt = pauseAfterRun ? null : nextRunAt
    const updated = await store.updateDefinition({
      ...definition,
      ...(pauseAfterRun ? { status: 'paused' as const } : {}),
      nextRunAt: persistedNextRunAt,
      lastRunAt: run.completedAt ?? new Date(updatedAt).toISOString(),
      lastRunId: run.id,
      updatedAt: new Date(updatedAt).toISOString(),
    })
    if (!updated.ok) {
      result.problems.push(storeProblem(workspaceRoot, updated.error, definition.id))
      return false
    }

    state.nextRunAtByAutomationId[definition.id] = persistedNextRunAt
    const stateWrite = await store.writeState(state)
    if (!stateWrite.ok) {
      result.problems.push(storeProblem(workspaceRoot, stateWrite.error, definition.id))
      return false
    }
    if (persistedNextRunAt)
      result.scheduled.push({ workspaceRoot, automationId: definition.id, nextRunAt: persistedNextRunAt })
    return true
  }

  private async approvalProblem(
    workspaceRoot: string,
    definition: AutomationDefinition,
  ): Promise<AutomationsEngineProblem | null> {
    let approval: Awaited<ReturnType<AutomationApprovalGate['check']>>
    try {
      approval = await this.approvals.check(workspaceRoot, definition)
    } catch {
      // A ledger that cannot be read approves nothing.
      approval = { state: 'needs-approval', fingerprint: '', reason: 'unreviewed' }
    }
    if (approval.state === 'approved') return null
    return {
      workspaceRoot,
      automationId: definition.id,
      code: AUTOMATION_NEEDS_APPROVAL_CODE,
      message:
        approval.reason === 'changed'
          ? `Automation "${definition.name}" changed since you allowed it, so it will not run until you review it again in Automations.`
          : `Automation "${definition.name}" was not made in this app on this machine, so it will not run until you review and allow it in Automations.`,
    }
  }

  private runRecord(
    workspaceRoot: string,
    automationId: string,
    dueAt: string,
    fields: Pick<AutomationRun, 'status' | 'startedAt' | 'completedAt'> & Partial<AutomationRun>,
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
      return (
        dedupeProjectFolders(projectFolders).find(
          (folder) => normalizeWorkspaceRoot(folder.folderPath) === normalizedRoot,
        )?.workspaceId ?? null
      )
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
    }),
  )
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

// NUL is in neither id, so the pair cannot collide.
function conversationKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}\u0000${agentId}`
}

function storeProblem(
  workspaceRoot: string,
  error: AutomationStoreProblem,
  automationId?: string,
): AutomationsEngineProblem {
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
