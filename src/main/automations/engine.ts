import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

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
import { normalizeReportPath } from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { AutomationsStore, type AutomationStoreProblem, type AutomationStoreState } from './store'
import type { AutomationPullRequestResult } from './pull-request'
import { computeNextRun, validateScheduleTriggerConfig } from './schedule'
import { evaluatePollingTriggerDefinition } from './polling-trigger-runner'
import { parseRunSignal, runSignalPath } from './run-signal'
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
  onRunEvent?: (event: AutomationsRunEvent) => void
  // Agent-backed run finalize collaborators (injected for testability).
  openRunPullRequest?: AutomationRunPullRequestOpener
  removeRunWorktree?: AutomationRunWorktreeRemover
}

type EvaluationMode = 'startup' | 'timer'

// An agent-backed run that was dispatched as `running` and is awaiting the
// agent's terminal outcome, declared via the run-status signal file in its
// worktree. The per-tick scan reads that file and finalizes the run.
type PendingAgentRun = {
  workspaceRoot: string
  automationId: string
  runId: string
  worktreePath: string
  workspaceId?: string
}

const DEFAULT_POLL_INTERVAL_MS = 60_000

// The run-status signal is a tiny JSON object ({status, summary}). Cap the
// per-tick read so a stray/oversize file (a buggy or compromised agent) is
// treated as malformed and never loaded into memory; the run stays pending.
const MAX_RUN_SIGNAL_BYTES = 64 * 1024

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
  private readonly onRunEvent?: (event: AutomationsRunEvent) => void
  private readonly openRunPullRequest?: AutomationRunPullRequestOpener
  private readonly removeRunWorktree?: AutomationRunWorktreeRemover
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
    // Report files the agent declared. Each is containment-guarded (under
    // reports/) before it lands on AutomationRun.reportPaths; bad paths drop.
    reports?: string[]
    workspaceId?: string
    // Routes the terminal run-event. 'manual' (default, IPC button) always emits;
    // 'timer' (signal-scan auto-finalize) emits only on failure so the completed
    // happy path stays silent during background ticks.
    eventTrigger?: AutomationRunEventTrigger
  }): Promise<AutomationsEngineFinalizeResult> {
    const runKey = this.pendingRunKey(input.workspaceRoot, input.automationId, input.runId)
    // Drop from the pending registry on any finalize (manual or scan-driven) so a
    // later tick never re-scans a run that is already being finalized.
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

  private async finalizeRunLocked(
    input: {
      workspaceRoot: string
      automationId: string
      runId: string
      outcome: 'completed' | 'failed'
      summary?: string
      reports?: string[]
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

    // Map declared reports onto the run only for paths that pass the shared
    // containment guard; escaping/out-of-reports paths are dropped without
    // failing finalize. Keep any existing reportPaths when none survive.
    const reportPaths = containReportPaths(input.reports)
    const finalRun: AutomationRun = {
      ...run,
      status: input.outcome,
      completedAt: new Date(this.now()).toISOString(),
      pullRequestUrl,
      blockedReason: withheldChangesReason ?? run.blockedReason,
      summary: summaryParts.length > 0 ? summaryParts.join(' ') : run.summary,
      reportPaths: reportPaths.length > 0 ? reportPaths : run.reportPaths,
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

  // Auto-finalize: read each pending agent run's signal file; a valid signal
  // finalizes the run (timer-routed) and drops it from the registry, while a
  // missing or invalid signal leaves the run pending for a later tick.
  private async scanPendingAgentRuns(): Promise<void> {
    if (this.pendingAgentRuns.size === 0) return
    for (const pending of [...this.pendingAgentRuns.values()]) {
      const signalPath = runSignalPath(pending.worktreePath)
      let raw: string
      try {
        const stats = await stat(signalPath)
        if (stats.size > MAX_RUN_SIGNAL_BYTES) {
          // Oversize signal — treat as malformed (never load it); stay pending.
          continue
        }
        raw = await readFile(signalPath, 'utf8')
      } catch {
        // No signal file yet (or unreadable) — the agent has not declared an
        // outcome; leave the run pending.
        continue
      }
      const signal = parseRunSignal(raw)
      if (!signal) continue // malformed/unrecognized — never coerce; stay pending.
      await this.finalizeRun({
        workspaceRoot: pending.workspaceRoot,
        automationId: pending.automationId,
        runId: pending.runId,
        outcome: signal.outcome,
        summary: signal.summary,
        reports: signal.reports,
        workspaceId: pending.workspaceId,
        eventTrigger: 'timer',
      })
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

  private trackPendingAgentRun(workspaceRoot: string, run: AutomationRun, workspaceId?: string): void {
    if (run.status !== 'running' || !run.worktreePath) return
    this.pendingAgentRuns.set(this.pendingRunKey(workspaceRoot, run.automationId, run.id), {
      workspaceRoot,
      automationId: run.automationId,
      runId: run.id,
      worktreePath: run.worktreePath,
      workspaceId: workspaceId ?? run.workspaceId,
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
    const updated = await this.updateDefinitionAfterRun(store, state, workspaceRoot, definition, run, nextRunAt, now, result)
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
      const updated = await this.updateDefinitionAfterRun(store, state, workspaceRoot, definition, finalRun, nextRunAt, Date.parse(completedAt), result)
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
      const updated = await this.updateDefinitionAfterRun(store, state, workspaceRoot, definition, failedRun, nextRunAt, Date.parse(failedAt), result)
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
    run: AutomationRun,
    nextRunAt: string | null,
    updatedAt: number,
    result: AutomationsEngineEvaluationResult
  ): Promise<boolean> {
    if (!nextRunAt) {
      result.problems.push({
        workspaceRoot,
        automationId: definition.id,
        code: 'next_run_unavailable',
        message: `Unable to compute next run for automation "${definition.id}".`,
      })
      return false
    }

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
    result.scheduled.push({ workspaceRoot, automationId: definition.id, nextRunAt })
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
      this.onRunEvent(event)
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
    promptFingerprint: patch.promptFingerprint,
    touchedFiles: patch.touchedFiles,
    commandsRan: patch.commandsRan,
    summary: patch.summary,
    worktreePath: patch.worktreePath,
    branch: patch.branch,
    pullRequestUrl: patch.pullRequestUrl,
  }
}

// Normalize and contain declared report paths, dropping any that fail the
// shared guard (absolute, '..' traversal, or outside reports/) and de-duping
// the survivors. A failing path never fails finalize — it is simply omitted.
function containReportPaths(reports: string[] | undefined): string[] {
  if (!reports) return []
  const seen = new Set<string>()
  const contained: string[] = []
  for (const raw of reports) {
    const normalized = normalizeReportPath(raw)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    contained.push(normalized)
  }
  return contained
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
