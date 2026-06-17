import { randomUUID } from 'node:crypto'

import type { AutomationDefinition, AutomationRun, AutomationRunStatus, ScheduleTriggerConfig } from '../../shared/automations/contracts'
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

export type AutomationsEngineOptions = {
  getProjectFolders?: () => AutomationsProjectFolder[] | Promise<AutomationsProjectFolder[]>
  getWorkspaceSnapshot?: () => WorkspaceSyncSnapshot | Promise<WorkspaceSyncSnapshot>
  createStore?: (workspaceRoot: string) => AutomationsStore
  runAutomation: AutomationRunExecutor
  now?: () => number
  createRunId?: (input: { workspaceRoot: string; automationId: string; dueAt: string }) => string
  pollIntervalMs?: number
  onEvaluation?: (result: AutomationsEngineEvaluationResult) => void
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
  private readonly inFlight = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: AutomationsEngineOptions) {
    this.getProjectFolders = options.getProjectFolders
    this.getWorkspaceSnapshot = options.getWorkspaceSnapshot
    this.createStore = options.createStore ?? ((workspaceRoot) => new AutomationsStore(workspaceRoot))
    this.runAutomation = options.runAutomation
    this.now = options.now ?? Date.now
    this.createRunId = options.createRunId ?? (() => `automation-run-${randomUUID()}`)
    this.pollIntervalMs = Math.max(1_000, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS))
    this.onEvaluation = options.onEvaluation
  }

  start(): void {
    if (this.timer) return
    void this.handleStartup()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.pollIntervalMs)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  async handleStartup(): Promise<AutomationsEngineEvaluationResult> {
    return this.evaluate('startup')
  }

  async tick(): Promise<AutomationsEngineEvaluationResult> {
    return this.evaluate('timer')
  }

  private async evaluate(mode: EvaluationMode): Promise<AutomationsEngineEvaluationResult> {
    const result = emptyEvaluationResult()
    const now = this.now()
    const projectFolders = await this.loadProjectFolders(result)

    for (const projectFolder of projectFolders) {
      await this.evaluateProject(projectFolder.folderPath, mode, now, result)
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
    workspaceRoot: string,
    mode: EvaluationMode,
    now: number,
    result: AutomationsEngineEvaluationResult
  ): Promise<void> {
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
      await this.evaluateDefinition(store, state, workspaceRoot, definition, mode, now, result)
    }
  }

  private async evaluateDefinition(
    store: AutomationsStore,
    state: AutomationStoreState,
    workspaceRoot: string,
    definition: AutomationDefinition,
    mode: EvaluationMode,
    now: number,
    result: AutomationsEngineEvaluationResult
  ): Promise<void> {
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
      await this.fireDueRun(store, state, workspaceRoot, definition, validation.value, nextRunAt, result)
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
    workspaceRoot: string,
    definition: AutomationDefinition,
    config: ScheduleTriggerConfig,
    dueAt: string,
    result: AutomationsEngineEvaluationResult
  ): Promise<void> {
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
