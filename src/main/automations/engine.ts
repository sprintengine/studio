import { randomUUID } from 'node:crypto'

import type {
  AutomationDefinition,
  AutomationRun,
  AutomationRunEventStatus,
  AutomationRunEventTrigger,
  AutomationRunStatus,
  AutomationsRunEvent,
  ScheduleTriggerConfig,
} from '../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { AutomationsStore, type AutomationStoreProblem, type AutomationStoreState } from './store'
import { computeNextRun, validateScheduleTriggerConfig } from './schedule'

export type AutomationsProjectFolder = {
  workspaceId: string
  folderPath: string
}

export type AutomationRunExecutionInput = {
  workspaceRoot: string
  definition: AutomationDefinition
  run: AutomationRun
  triggerPayload: Record<string, unknown>
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

export type AutomationsEngineOptions = {
  getProjectFolders?: () => AutomationsProjectFolder[] | Promise<AutomationsProjectFolder[]>
  getWorkspaceSnapshot?: () => WorkspaceSyncSnapshot | Promise<WorkspaceSyncSnapshot>
  createStore?: (workspaceRoot: string) => AutomationsStore
  runAutomation: AutomationRunExecutor
  now?: () => number
  createRunId?: (input: { workspaceRoot: string; automationId: string; dueAt: string }) => string
  pollIntervalMs?: number
  onEvaluation?: (result: AutomationsEngineEvaluationResult) => void
  onRunEvent?: (event: AutomationsRunEvent) => void
}

type EvaluationMode = 'startup' | 'timer'

const DEFAULT_POLL_INTERVAL_MS = 60_000

export class AutomationsEngine {
  private readonly getProjectFolders?: () => AutomationsProjectFolder[] | Promise<AutomationsProjectFolder[]>
  private readonly getWorkspaceSnapshot?: () => WorkspaceSyncSnapshot | Promise<WorkspaceSyncSnapshot>
  private readonly createStore: (workspaceRoot: string) => AutomationsStore
  private readonly runAutomation: AutomationRunExecutor
  private readonly now: () => number
  private readonly createRunId: (input: { workspaceRoot: string; automationId: string; dueAt: string }) => string
  private readonly pollIntervalMs: number
  private readonly onEvaluation?: (result: AutomationsEngineEvaluationResult) => void
  private readonly onRunEvent?: (event: AutomationsRunEvent) => void
  private readonly inFlight = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false
  private startupEvaluation: Promise<AutomationsEngineEvaluationResult> | null = null

  constructor(options: AutomationsEngineOptions) {
    this.getProjectFolders = options.getProjectFolders
    this.getWorkspaceSnapshot = options.getWorkspaceSnapshot
    this.createStore = options.createStore ?? ((workspaceRoot) => new AutomationsStore(workspaceRoot))
    this.runAutomation = options.runAutomation
    this.now = options.now ?? Date.now
    this.createRunId = options.createRunId ?? (() => `automation-run-${randomUUID()}`)
    this.pollIntervalMs = Math.max(1_000, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS))
    this.onEvaluation = options.onEvaluation
    this.onRunEvent = options.onRunEvent
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
    return this.evaluate('timer')
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

  private async evaluate(mode: EvaluationMode): Promise<AutomationsEngineEvaluationResult> {
    const result = emptyEvaluationResult()
    const now = this.now()
    const projectFolders = await this.loadProjectFolders(result)

    for (const projectFolder of projectFolders) {
      await this.evaluateProject(projectFolder, mode, now, result)
    }

    this.onEvaluation?.(result)
    return result
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
      await this.evaluateDefinition(store, state, projectFolder, definition, mode, now, result)
    }
  }

  private async evaluateDefinition(
    store: AutomationsStore,
    state: AutomationStoreState,
    projectFolder: AutomationsProjectFolder,
    definition: AutomationDefinition,
    mode: EvaluationMode,
    now: number,
    result: AutomationsEngineEvaluationResult
  ): Promise<void> {
    const workspaceRoot = projectFolder.folderPath
    if (definition.status !== 'enabled' || definition.trigger.kind !== 'schedule') return

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
      })
      const completedAt = patch.completedAt ?? new Date(this.now()).toISOString()
      const finalRun = completeRun(run, patch, completedAt)
      const completed = await store.recordRun(finalRun)
      if (!completed.ok) {
        result.problems.push(storeProblem(workspaceRoot, completed.error, definition.id))
        return
      }
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
  return {
    ...run,
    status: patch.status ?? 'completed',
    completedAt,
    blockedReason: patch.blockedReason,
    workspaceId: patch.workspaceId,
    agentId: patch.agentId,
    promptFingerprint: patch.promptFingerprint,
    touchedFiles: patch.touchedFiles,
    commandsRan: patch.commandsRan,
    summary: patch.summary,
  }
}

function nextRunIso(config: ScheduleTriggerConfig, after: number): string | null {
  const nextRun = computeNextRun(config, after)
  return nextRun === null ? null : new Date(nextRun).toISOString()
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
