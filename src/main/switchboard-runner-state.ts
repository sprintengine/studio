import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type {
  AgentCli,
} from '../shared/electron-api'
import type {
  SwitchboardExecutionProviderKind,
  SwitchboardRunnerExecution,
  SwitchboardRunnerQueue,
} from '../shared/switchboard'

export const SWITCHBOARD_RUNNER_SCHEMA_VERSION = 1
export const DEFAULT_SWITCHBOARD_RUNNER_QUEUES: SwitchboardRunnerQueue[] = ['ready', 'testing', 'review']
export const DEFAULT_SWITCHBOARD_RUNNER_PROVIDER: SwitchboardExecutionProviderKind = 'desktop-terminal'
export const DEFAULT_SWITCHBOARD_RUNNER_CLI: AgentCli = 'codex'

export type SwitchboardRunnerFileState = {
  schemaVersion: 1
  enabled: boolean
  paused: boolean
  workspaceRoot: string
  provider: SwitchboardExecutionProviderKind
  cli: AgentCli
  queues: SwitchboardRunnerQueue[]
  maxConcurrency: number
  activeExecutions: SwitchboardRunnerExecution[]
  lastError: string | null
  updatedAt: string
}

export type SwitchboardRunnerEvent = {
  type: string
  workspaceRoot: string
  at: string
  executionId?: string
  taskId?: string
  message?: string
  data?: Record<string, unknown>
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function switchboardRunnerDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), '.multi-code', 'switchboard', 'runner')
}

export function switchboardRunnerStatePath(workspaceRoot: string): string {
  return path.join(switchboardRunnerDir(workspaceRoot), 'state.json')
}

export function switchboardRunnerEventsPath(workspaceRoot: string): string {
  return path.join(switchboardRunnerDir(workspaceRoot), 'events.jsonl')
}

export function normalizeRunnerQueues(input?: readonly string[]): SwitchboardRunnerQueue[] {
  const queues = input?.length ? input : DEFAULT_SWITCHBOARD_RUNNER_QUEUES
  return [
    ...new Set(
      queues.filter((queue): queue is SwitchboardRunnerQueue =>
        DEFAULT_SWITCHBOARD_RUNNER_QUEUES.includes(queue as SwitchboardRunnerQueue)
      )
    ),
  ]
}

export function normalizeRunnerMaxConcurrency(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return 1
  return Math.max(1, Math.min(8, Math.floor(input)))
}

export function createDefaultRunnerState(workspaceRoot: string): SwitchboardRunnerFileState {
  return {
    schemaVersion: SWITCHBOARD_RUNNER_SCHEMA_VERSION,
    enabled: false,
    paused: true,
    workspaceRoot: path.resolve(workspaceRoot),
    provider: DEFAULT_SWITCHBOARD_RUNNER_PROVIDER,
    cli: DEFAULT_SWITCHBOARD_RUNNER_CLI,
    queues: DEFAULT_SWITCHBOARD_RUNNER_QUEUES,
    maxConcurrency: 1,
    activeExecutions: [],
    lastError: null,
    updatedAt: nowIso(),
  }
}

function normalizeProvider(value: unknown): SwitchboardExecutionProviderKind {
  if (value === 'headless-process' || value === 'codex-app-server') return value
  return DEFAULT_SWITCHBOARD_RUNNER_PROVIDER
}

function normalizeCli(value: unknown): AgentCli {
  return value === 'claude' ? 'claude' : DEFAULT_SWITCHBOARD_RUNNER_CLI
}

function normalizeExecution(value: unknown): SwitchboardRunnerExecution | null {
  if (!value || typeof value !== 'object') return null
  const execution = value as Partial<SwitchboardRunnerExecution>
  if (
    typeof execution.executionId !== 'string' ||
    typeof execution.taskId !== 'string' ||
    typeof execution.role !== 'string' ||
    typeof execution.claimedFrom !== 'string' ||
    typeof execution.claimedStatus !== 'string' ||
    typeof execution.startedAt !== 'string' ||
    typeof execution.lastSeenAt !== 'string'
  ) {
    return null
  }
  return {
    executionId: execution.executionId,
    taskId: execution.taskId,
    role: execution.role,
    claimedFrom: execution.claimedFrom as SwitchboardRunnerQueue,
    claimedStatus: execution.claimedStatus as SwitchboardRunnerExecution['claimedStatus'],
    provider: normalizeProvider(execution.provider),
    providerRef: execution.providerRef && typeof execution.providerRef === 'object' ? execution.providerRef : {},
    startedAt: execution.startedAt,
    lastSeenAt: execution.lastSeenAt,
    status: execution.status,
  }
}

export async function readRunnerState(workspaceRoot: string): Promise<SwitchboardRunnerFileState> {
  const statePath = switchboardRunnerStatePath(workspaceRoot)
  if (!existsSync(statePath)) return createDefaultRunnerState(workspaceRoot)
  const parsed = JSON.parse(await readFile(statePath, 'utf-8')) as Partial<SwitchboardRunnerFileState>
  return {
    schemaVersion: SWITCHBOARD_RUNNER_SCHEMA_VERSION,
    enabled: parsed.enabled === true,
    paused: parsed.paused !== false,
    workspaceRoot: path.resolve(typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : workspaceRoot),
    provider: normalizeProvider(parsed.provider),
    cli: normalizeCli(parsed.cli),
    queues: normalizeRunnerQueues(parsed.queues),
    maxConcurrency: normalizeRunnerMaxConcurrency(parsed.maxConcurrency),
    activeExecutions: Array.isArray(parsed.activeExecutions)
      ? parsed.activeExecutions.map(normalizeExecution).filter((execution): execution is SwitchboardRunnerExecution => Boolean(execution))
      : [],
    lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(),
  }
}

export async function writeRunnerState(state: SwitchboardRunnerFileState): Promise<void> {
  const runnerDir = switchboardRunnerDir(state.workspaceRoot)
  await mkdir(runnerDir, { recursive: true })
  const statePath = switchboardRunnerStatePath(state.workspaceRoot)
  const tmpPath = path.join(runnerDir, `.state.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmpPath, `${JSON.stringify({ ...state, updatedAt: state.updatedAt || nowIso() }, null, 2)}\n`, 'utf-8')
  await writeFile(switchboardRunnerEventsPath(state.workspaceRoot), '', { flag: 'a' })
  await rename(tmpPath, statePath)
}

export async function appendRunnerEvent(event: SwitchboardRunnerEvent): Promise<void> {
  const runnerDir = switchboardRunnerDir(event.workspaceRoot)
  await mkdir(runnerDir, { recursive: true })
  await writeFile(switchboardRunnerEventsPath(event.workspaceRoot), `${JSON.stringify(event)}\n`, { flag: 'a' })
}
