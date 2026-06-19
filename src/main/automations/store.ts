import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type {
  AutomationDefinition,
  AutomationRun,
  AutomationRunStatus,
  AutomationStatus,
} from '../../shared/automations/contracts'

export const AUTOMATIONS_STORE_DIRECTORY = '.multi-code/automations'
export const AUTOMATION_RUN_HISTORY_LIMIT = 50

export type AutomationStoreProblemCode =
  | 'already_exists'
  | 'invalid_id'
  | 'invalid_json'
  | 'invalid_payload'
  | 'missing'
  | 'read_failed'
  | 'write_failed'

export type AutomationStoreProblem = {
  code: AutomationStoreProblemCode
  path: string
  message: string
}

export type AutomationStoreReadResult<T> = { ok: true; value: T } | { ok: false; error: AutomationStoreProblem }
export type AutomationStoreListResult<T> = { ok: true; values: T[] } | { ok: false; errors: AutomationStoreProblem[] }
export type AutomationStoreWriteResult<T> = { ok: true; value: T } | { ok: false; error: AutomationStoreProblem }
export type AutomationStoreDeleteResult = { ok: true } | { ok: false; error: AutomationStoreProblem }

export type AutomationStoreLock = {
  ownerId: string
  acquiredAt: string
  expiresAt: string
}

export type AutomationStoreState = {
  nextRunAtByAutomationId: Record<string, string | null>
  repoEventDedupByAutomationId?: Record<string, Record<string, string>>
  triggerBlockedReasonByAutomationId?: Record<string, string | null>
  lock: AutomationStoreLock | null
}

const AUTOMATION_STATUSES = new Set<AutomationStatus>(['enabled', 'paused', 'blocked'])
const AUTOMATION_RUN_STATUSES = new Set<AutomationRunStatus>([
  'queued',
  'running',
  'completed',
  'failed',
  'blocked',
  'skipped',
])
const SAFE_FILE_ID = /^[A-Za-z0-9._-]+$/

export class AutomationsStore {
  readonly rootPath: string

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: { runHistoryLimit?: number } = {}
  ) {
    this.rootPath = join(workspaceRoot, AUTOMATIONS_STORE_DIRECTORY)
  }

  async createDefinition(definition: AutomationDefinition): Promise<AutomationStoreWriteResult<AutomationDefinition>> {
    const target = this.definitionPath(definition.id)
    if (!target.ok) return target

    const validation = this.validateDefinition(definition, target.path)
    if (!validation.ok) return validation

    if (await pathExists(target.path)) {
      return {
        ok: false,
        error: this.problem('already_exists', target.path, `Automation definition "${definition.id}" already exists.`),
      }
    }

    return this.writeDefinition(definition, target.path)
  }

  async updateDefinition(definition: AutomationDefinition): Promise<AutomationStoreWriteResult<AutomationDefinition>> {
    const target = this.definitionPath(definition.id)
    if (!target.ok) return target

    const validation = this.validateDefinition(definition, target.path)
    if (!validation.ok) return validation

    if (!(await pathExists(target.path))) {
      return {
        ok: false,
        error: this.problem('missing', target.path, `Automation definition "${definition.id}" does not exist.`),
      }
    }

    return this.writeDefinition(definition, target.path)
  }

  async deleteDefinition(automationId: string): Promise<AutomationStoreDeleteResult> {
    const target = this.definitionPath(automationId)
    if (!target.ok) return target
    const runDirectory = this.runsDirectory(automationId)
    if (!runDirectory.ok) return runDirectory

    try {
      await unlink(target.path)
      await rm(runDirectory.path, { recursive: true, force: true })
      return { ok: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      return {
        ok: false,
        error: this.problem(
          code === 'ENOENT' ? 'missing' : 'write_failed',
          target.path,
          error instanceof Error ? error.message : `Failed to delete automation definition "${automationId}".`
        ),
      }
    }
  }

  async getDefinition(automationId: string): Promise<AutomationStoreReadResult<AutomationDefinition>> {
    const target = this.definitionPath(automationId)
    if (!target.ok) return target
    return this.readDefinitionFile(target.path)
  }

  async listDefinitions(): Promise<AutomationStoreListResult<AutomationDefinition>> {
    const directory = this.definitionsDirectory()
    const files = await listJsonFiles(directory)
    if (!files.ok) {
      const error = files.errors[0]
      if (error?.code === 'missing') return { ok: true, values: [] }
      return { ok: false, errors: [this.problem(error?.code ?? 'read_failed', directory, error?.message ?? 'Failed to read definitions.')] }
    }

    const definitions: AutomationDefinition[] = []
    const errors: AutomationStoreProblem[] = []
    for (const fileName of files.values) {
      const result = await this.readDefinitionFile(join(directory, fileName))
      if (result.ok) definitions.push(result.value)
      else errors.push(result.error)
    }

    if (errors.length > 0) return { ok: false, errors }
    return { ok: true, values: definitions.sort((left, right) => left.id.localeCompare(right.id)) }
  }

  async recordRun(run: AutomationRun): Promise<AutomationStoreWriteResult<AutomationRun>> {
    const definitionTarget = this.definitionPath(run.automationId)
    if (!definitionTarget.ok) return definitionTarget

    const runTarget = this.runPath(run.automationId, run.id)
    if (!runTarget.ok) return runTarget

    const validation = this.validateRun(run, runTarget.path)
    if (!validation.ok) return validation

    const definition = await this.readDefinitionFile(definitionTarget.path)
    if (!definition.ok) return { ok: false, error: definition.error }

    const written = await this.writeRun(run, runTarget.path)
    if (!written.ok) return written

    const pruned = await this.pruneRunHistory(run.automationId)
    if (!pruned.ok) return { ok: false, error: pruned.error }

    return written
  }

  async getRun(automationId: string, runId: string): Promise<AutomationStoreReadResult<AutomationRun>> {
    const target = this.runPath(automationId, runId)
    if (!target.ok) return target
    return this.readRunFile(target.path)
  }

  async listRuns(automationId: string): Promise<AutomationStoreListResult<AutomationRun>> {
    return this.listRunsStrict(automationId)
  }

  private async listRunsStrict(automationId: string): Promise<AutomationStoreListResult<AutomationRun>> {
    const directoryResult = this.runsDirectory(automationId)
    if (!directoryResult.ok) return { ok: false, errors: [directoryResult.error] }
    const directory = directoryResult.path
    const files = await listJsonFiles(directory)
    if (!files.ok) {
      const error = files.errors[0]
      if (error?.code === 'missing') return { ok: true, values: [] }
      return { ok: false, errors: [this.problem(error?.code ?? 'read_failed', directory, error?.message ?? 'Failed to read runs.')] }
    }

    const runs: AutomationRun[] = []
    const errors: AutomationStoreProblem[] = []
    for (const fileName of files.values) {
      const result = await this.readRunFile(join(directory, fileName))
      if (result.ok) runs.push(result.value)
      else errors.push(result.error)
    }

    if (errors.length > 0) return { ok: false, errors }
    return { ok: true, values: runs.sort(compareRunsNewestFirst) }
  }

  private async listReadableRunsForWrite(automationId: string): Promise<AutomationStoreListResult<AutomationRun>> {
    const directoryResult = this.runsDirectory(automationId)
    if (!directoryResult.ok) return { ok: false, errors: [directoryResult.error] }
    const directory = directoryResult.path
    const files = await listJsonFiles(directory)
    if (!files.ok) {
      const error = files.errors[0]
      if (error?.code === 'missing') return { ok: true, values: [] }
      return { ok: false, errors: [this.problem(error?.code ?? 'read_failed', directory, error?.message ?? 'Failed to read runs.')] }
    }

    const runs: AutomationRun[] = []
    for (const fileName of files.values) {
      const result = await this.readRunFile(join(directory, fileName))
      if (result.ok) runs.push(result.value)
    }

    return { ok: true, values: runs.sort(compareRunsNewestFirst) }
  }

  async readState(): Promise<AutomationStoreReadResult<AutomationStoreState | null>> {
    const target = this.statePath()
    const parsed = await this.readJson(target)
    if (!parsed.ok) {
      if (parsed.error.code === 'missing') return { ok: true, value: null }
      return parsed
    }
    return this.validateState(parsed.value, target)
  }

  async writeState(state: AutomationStoreState): Promise<AutomationStoreWriteResult<AutomationStoreState>> {
    const target = this.statePath()
    const validation = this.validateState(state, target)
    if (!validation.ok) return validation

    const written = await this.writeJson(target, state)
    if (!written.ok) return written
    return { ok: true, value: state }
  }

  private definitionsDirectory(): string {
    return join(this.rootPath, 'definitions')
  }

  private runsRootDirectory(): string {
    return join(this.rootPath, 'runs')
  }

  private runsDirectory(automationId: string): { ok: true; path: string } | { ok: false; error: AutomationStoreProblem } {
    const safeId = this.safeId(automationId)
    if (!safeId.ok) return safeId
    return this.containedPath(this.runsRootDirectory(), automationId)
  }

  private statePath(): string {
    return join(this.rootPath, 'state.json')
  }

  private definitionPath(automationId: string): { ok: true; path: string } | { ok: false; error: AutomationStoreProblem } {
    const safeId = this.safeId(automationId)
    if (!safeId.ok) return safeId
    return this.containedPath(this.definitionsDirectory(), `${automationId}.json`)
  }

  private runPath(
    automationId: string,
    runId: string
  ): { ok: true; path: string } | { ok: false; error: AutomationStoreProblem } {
    const safeAutomationId = this.safeId(automationId)
    if (!safeAutomationId.ok) return safeAutomationId
    const safeRunId = this.safeId(runId)
    if (!safeRunId.ok) return safeRunId
    const directory = this.runsDirectory(automationId)
    if (!directory.ok) return directory
    return this.containedPath(directory.path, `${runId}.json`)
  }

  private safeId(id: string): { ok: true } | { ok: false; error: AutomationStoreProblem } {
    if (SAFE_FILE_ID.test(id) && id !== '.' && id !== '..') return { ok: true }
    return {
      ok: false,
      error: {
        code: 'invalid_id',
        path: AUTOMATIONS_STORE_DIRECTORY,
        message:
          'Automation store ids must be non-empty file names containing only letters, numbers, dot, underscore, or hyphen, and cannot be dot segments.',
      },
    }
  }

  private containedPath(
    directory: string,
    childName: string
  ): { ok: true; path: string } | { ok: false; error: AutomationStoreProblem } {
    const parent = resolve(directory)
    const target = resolve(directory, childName)
    const relativePath = relative(parent, target)
    if (relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
      return { ok: true, path: target }
    }

    return {
      ok: false,
      error: this.problem('invalid_id', target, 'Automation store id resolves outside its expected directory.'),
    }
  }

  private async writeDefinition(
    definition: AutomationDefinition,
    path: string
  ): Promise<AutomationStoreWriteResult<AutomationDefinition>> {
    const written = await this.writeJson(path, definition)
    if (!written.ok) return written
    return { ok: true, value: definition }
  }

  private async writeRun(run: AutomationRun, path: string): Promise<AutomationStoreWriteResult<AutomationRun>> {
    const written = await this.writeJson(path, run)
    if (!written.ok) return written
    return { ok: true, value: run }
  }

  private async writeJson<T>(path: string, value: T): Promise<AutomationStoreWriteResult<T>> {
    try {
      await atomicWriteJson(path, value)
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        error: this.problem('write_failed', path, error instanceof Error ? error.message : 'Failed to write automations store file.'),
      }
    }
  }

  private async readDefinitionFile(path: string): Promise<AutomationStoreReadResult<AutomationDefinition>> {
    const parsed = await this.readJson(path)
    if (!parsed.ok) return parsed
    return this.validateDefinition(parsed.value, path)
  }

  private async readRunFile(path: string): Promise<AutomationStoreReadResult<AutomationRun>> {
    const parsed = await this.readJson(path)
    if (!parsed.ok) return parsed
    return this.validateRun(parsed.value, path)
  }

  private async readJson(path: string): Promise<AutomationStoreReadResult<unknown>> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      return {
        ok: false,
        error: this.problem(
          code === 'ENOENT' ? 'missing' : 'read_failed',
          path,
          error instanceof Error ? error.message : 'Failed to read automations store file.'
        ),
      }
    }

    try {
      return { ok: true, value: JSON.parse(raw) }
    } catch (error) {
      return {
        ok: false,
        error: this.problem(
          'invalid_json',
          path,
          error instanceof Error ? `Automations store file is not valid JSON: ${error.message}` : 'Automations store file is not valid JSON.'
        ),
      }
    }
  }

  private validateDefinition(
    value: unknown,
    path: string
  ): AutomationStoreReadResult<AutomationDefinition> | AutomationStoreWriteResult<AutomationDefinition> {
    if (isAutomationDefinition(value)) return { ok: true, value }
    return { ok: false, error: this.problem('invalid_payload', path, 'Automation definition payload is malformed.') }
  }

  private validateRun(value: unknown, path: string): AutomationStoreReadResult<AutomationRun> | AutomationStoreWriteResult<AutomationRun> {
    if (isAutomationRun(value)) return { ok: true, value }
    return { ok: false, error: this.problem('invalid_payload', path, 'Automation run payload is malformed.') }
  }

  private validateState(
    value: unknown,
    path: string
  ): AutomationStoreReadResult<AutomationStoreState> | AutomationStoreWriteResult<AutomationStoreState> {
    if (!isAutomationStoreState(value)) {
      return { ok: false, error: this.problem('invalid_payload', path, 'Automation state payload is malformed.') }
    }

    for (const automationId of Object.keys(value.nextRunAtByAutomationId)) {
      const safeId = this.safeId(automationId)
      if (!safeId.ok) {
        return { ok: false, error: this.problem('invalid_payload', path, `Automation state contains invalid id "${automationId}".`) }
      }
    }

    for (const automationId of Object.keys(value.repoEventDedupByAutomationId ?? {})) {
      const safeId = this.safeId(automationId)
      if (!safeId.ok) {
        return { ok: false, error: this.problem('invalid_payload', path, `Automation repo-event state contains invalid id "${automationId}".`) }
      }
    }

    for (const automationId of Object.keys(value.triggerBlockedReasonByAutomationId ?? {})) {
      const safeId = this.safeId(automationId)
      if (!safeId.ok) {
        return { ok: false, error: this.problem('invalid_payload', path, `Automation trigger-blocked state contains invalid id "${automationId}".`) }
      }
    }

    return { ok: true, value }
  }

  private async pruneRunHistory(automationId: string): Promise<AutomationStoreDeleteResult> {
    const runs = await this.listReadableRunsForWrite(automationId)
    if (!runs.ok) return { ok: false, error: aggregateProblems(runs.errors) }

    const limit = this.options.runHistoryLimit ?? AUTOMATION_RUN_HISTORY_LIMIT
    if (runs.values.length <= limit) return { ok: true }

    for (const staleRun of runs.values.slice(limit)) {
      const target = this.runPath(staleRun.automationId, staleRun.id)
      if (!target.ok) return target
      try {
        await unlink(target.path)
      } catch (error) {
        return {
          ok: false,
          error: this.problem(
            'write_failed',
            target.path,
            error instanceof Error ? error.message : `Failed to prune stale automation run "${staleRun.id}".`
          ),
        }
      }
    }

    return { ok: true }
  }

  private problem(code: AutomationStoreProblemCode, path: string, message: string): AutomationStoreProblem {
    return { code, path: this.projectRelativePath(path), message }
  }

  private projectRelativePath(path: string): string {
    return relative(this.workspaceRoot, path).split(/[\\/]/).join('/') || basename(path)
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function listJsonFiles(directory: string): Promise<AutomationStoreListResult<string>> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return {
      ok: false,
      errors: [
        {
          code: code === 'ENOENT' ? 'missing' : 'read_failed',
          path: directory,
          message: error instanceof Error ? error.message : 'Failed to read automations store directory.',
        },
      ],
    }
  }
  return { ok: true, values: entries.filter((entry) => entry.endsWith('.json')).sort() }
}

function aggregateProblems(errors: AutomationStoreProblem[]): AutomationStoreProblem {
  if (errors.length === 1) return errors[0]
  return {
    code: 'invalid_payload',
    path: AUTOMATIONS_STORE_DIRECTORY,
    message: `${errors.length} automations store files are malformed or unreadable.`,
  }
}

function isAutomationDefinition(value: unknown): value is AutomationDefinition {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string'
    && typeof value.name === 'string'
    && isAutomationStatus(value.status)
    && isKindConfig(value.trigger)
    && (value.condition === undefined || isKindConfig(value.condition))
    && isKindConfig(value.action)
    && (value.autonomyDefault === 'review_only' || value.autonomyDefault === 'allow_changes')
    && isNullableString(value.nextRunAt)
    && isNullableString(value.lastRunAt)
    && isNullableString(value.lastRunId)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
  )
}

function isAutomationRun(value: unknown): value is AutomationRun {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string'
    && typeof value.automationId === 'string'
    && isAutomationRunStatus(value.status)
    && typeof value.dueAt === 'string'
    && isNullableString(value.startedAt)
    && isNullableString(value.completedAt)
    && isOptionalString(value.blockedReason)
    && isOptionalString(value.workspaceId)
    && isOptionalString(value.agentId)
    && isOptionalString(value.promptFingerprint)
    && isOptionalStringArray(value.touchedFiles)
    && isOptionalStringArray(value.commandsRan)
    && isOptionalString(value.summary)
  )
}

function isAutomationStoreState(value: unknown): value is AutomationStoreState {
  return (
    isRecord(value)
    && isNextRunAtCache(value.nextRunAtByAutomationId)
    && (value.repoEventDedupByAutomationId === undefined || isRepoEventDedupCache(value.repoEventDedupByAutomationId))
    && (
      value.triggerBlockedReasonByAutomationId === undefined
      || isTriggerBlockedReasonCache(value.triggerBlockedReasonByAutomationId)
    )
    && (value.lock === null || isAutomationStoreLock(value.lock))
  )
}

function isNextRunAtCache(value: unknown): value is Record<string, string | null> {
  return isRecord(value) && Object.values(value).every((entry) => isNullableString(entry))
}

function isRepoEventDedupCache(value: unknown): value is Record<string, Record<string, string>> {
  return (
    isRecord(value)
    && Object.values(value).every((entry) =>
      isRecord(entry) && Object.values(entry).every((seenAt) => typeof seenAt === 'string')
    )
  )
}

function isTriggerBlockedReasonCache(value: unknown): value is Record<string, string | null> {
  return isRecord(value) && Object.values(value).every((entry) => isNullableString(entry))
}

function isAutomationStoreLock(value: unknown): value is AutomationStoreLock {
  return (
    isRecord(value)
    && typeof value.ownerId === 'string'
    && typeof value.acquiredAt === 'string'
    && typeof value.expiresAt === 'string'
  )
}

function isKindConfig(value: unknown): value is { kind: string; config: unknown } {
  return isRecord(value) && typeof value.kind === 'string' && Object.hasOwn(value, 'config')
}

function isAutomationStatus(value: unknown): value is AutomationStatus {
  return typeof value === 'string' && AUTOMATION_STATUSES.has(value as AutomationStatus)
}

function isAutomationRunStatus(value: unknown): value is AutomationRunStatus {
  return typeof value === 'string' && AUTOMATION_RUN_STATUSES.has(value as AutomationRunStatus)
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function compareRunsNewestFirst(left: AutomationRun, right: AutomationRun): number {
  const timeDelta = runTimestamp(right) - runTimestamp(left)
  if (timeDelta !== 0) return timeDelta
  return right.id.localeCompare(left.id)
}

function runTimestamp(run: AutomationRun): number {
  const parsed = Date.parse(run.completedAt ?? run.startedAt ?? run.dueAt)
  return Number.isFinite(parsed) ? parsed : 0
}
