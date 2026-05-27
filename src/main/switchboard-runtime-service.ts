import { resolve } from 'path'
import { APP_INSTANCE_ID, acquireWorkspaceRunnerLock, releaseWorkspaceRunnerLock } from './workspace-runner-lock'
import type {
  SwitchboardAgentSpawnDescriptor,
  SwitchboardPrepareSessionResult,
  SwitchboardRunnerExecution,
  SwitchboardRunnerResult,
  SwitchboardRunnerStartInput,
  SwitchboardStopExecutionInput,
  SwitchboardStopExecutionResult,
} from '../shared/switchboard'
import type { McpSettings } from '../shared/electron-api'
import { runSwitchboardCore, workspaceArgs } from './switchboard-core-client'
import { shutdownSwitchboardPythonCommands } from './switchboard-python'

type SwitchboardSessionSpawner = (input: {
  workspaceId?: string
  workspaceRoot: string
  descriptor: SwitchboardAgentSpawnDescriptor
  mcpSettings?: McpSettings
}) => Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>

type SwitchboardSessionStopper = (input: {
  workspaceRoot: string
  executionId: string
}) => void

type SwitchboardRuntimeInventoryProvider = (workspaceRoot: string) => string[]

const SWITCHBOARD_RUNNER_INTERVAL_MS = 5_000

let switchboardSessionSpawner: SwitchboardSessionSpawner | null = null
let switchboardSessionStopper: SwitchboardSessionStopper | null = null
let switchboardExecutionStopper: SwitchboardSessionStopper | null = null
let switchboardRuntimeInventoryProvider: SwitchboardRuntimeInventoryProvider | null = null
const switchboardRunnerIntervals = new Map<string, NodeJS.Timeout>()
const switchboardRunnerWorkspaceIds = new Map<string, string>()
const switchboardRunnerMcpSettings = new Map<string, McpSettings>()
const inFlightWorkspaceTicks = new Set<string>()
let switchboardRuntimeShuttingDown = false

function runnerKey(workspaceRoot: string): string {
  return resolve(workspaceRoot)
}

function stopElectronRunnerLoop(workspaceRoot: string): void {
  const key = runnerKey(workspaceRoot)
  const interval = switchboardRunnerIntervals.get(key)
  if (!interval) return
  clearInterval(interval)
  switchboardRunnerIntervals.delete(key)
}

function clearElectronRunnerWorkspace(workspaceRoot: string): void {
  const key = runnerKey(workspaceRoot)
  switchboardRunnerWorkspaceIds.delete(key)
  switchboardRunnerMcpSettings.delete(key)
}

export function stopAllSwitchboardRunnerLoops(): void {
  for (const interval of switchboardRunnerIntervals.values()) {
    clearInterval(interval)
  }
  switchboardRunnerIntervals.clear()
}

export function beginSwitchboardPythonRuntimeShutdown(): void {
  switchboardRuntimeShuttingDown = true
  stopAllSwitchboardRunnerLoops()
  inFlightWorkspaceTicks.clear()
}

export async function shutdownSwitchboardPythonRuntime(): Promise<void> {
  beginSwitchboardPythonRuntimeShutdown()
  await shutdownSwitchboardPythonCommands()
}

function startElectronRunnerLoop(workspaceRoot: string, workspaceId?: string): void {
  const key = runnerKey(workspaceRoot)
  if (workspaceId) switchboardRunnerWorkspaceIds.set(key, workspaceId)
  if (switchboardRunnerIntervals.has(key)) return
  const interval = setInterval(() => {
    void prepareAndSpawnSwitchboardSession(workspaceRoot, workspaceId)
  }, SWITCHBOARD_RUNNER_INTERVAL_MS)
  interval.unref()
  switchboardRunnerIntervals.set(key, interval)
  void prepareAndSpawnSwitchboardSession(workspaceRoot, workspaceId)
}

async function prepareAndSpawnSwitchboardSession(workspaceRoot: string, workspaceId?: string): Promise<void> {
  if (switchboardRuntimeShuttingDown) return
  const key = runnerKey(workspaceRoot)
  if (inFlightWorkspaceTicks.has(key)) return
  inFlightWorkspaceTicks.add(key)
  try {
    await runtimeTickAndSpawnSwitchboardSessions(workspaceRoot, workspaceId)
  } finally {
    inFlightWorkspaceTicks.delete(key)
  }
}

async function runtimeTickAndSpawnSwitchboardSessions(workspaceRoot: string, workspaceId?: string): Promise<void> {
  if (!switchboardSessionSpawner) return
  const key = runnerKey(workspaceRoot)
  const result = await runSwitchboardCore([
    'runner',
    'runtime-tick',
    ...workspaceArgs(workspaceRoot),
    '--app-instance-id',
    APP_INSTANCE_ID,
    '--live-execution-ids-json',
    JSON.stringify(switchboardRuntimeInventoryProvider?.(workspaceRoot) ?? []),
    ...(workspaceId ? ['--workspace-id', workspaceId] : []),
  ])
  if (!result.ok) return
  const payload = result.payload as unknown as SwitchboardPrepareSessionResult & { descriptors?: SwitchboardAgentSpawnDescriptor[] }
  if (!payload.ok) return
  const descriptors = payload.descriptors ?? (payload.prepared ? [payload.descriptor] : [])
  for (const descriptor of descriptors) {
    const spawned = await switchboardSessionSpawner({
      workspaceId,
      workspaceRoot,
      descriptor,
      mcpSettings: switchboardRunnerMcpSettings.get(key),
    })
    if (!spawned.ok) {
      await stopPreparedSessionExecution(workspaceRoot, descriptor.executionId, spawned.message)
    }
  }
}

async function stopPreparedSessionExecution(
  workspaceRoot: string,
  executionId: string,
  message: string,
): Promise<void> {
  const reason = message.trim()
    ? `Terminal session did not start: ${message.trim()}`
    : 'Terminal session did not start.'
  await runSwitchboardCore([
    'execution',
    'stop',
    ...workspaceArgs(workspaceRoot),
    executionId,
    '--reason',
    reason,
  ])
}

export async function stopSpawnedWatchtowerSessions(
  workspaceRoot: string,
  descriptors: SwitchboardAgentSpawnDescriptor[],
  message: string,
): Promise<void> {
  const uniqueDescriptors = new Map<string, SwitchboardAgentSpawnDescriptor>()
  for (const descriptor of descriptors) {
    uniqueDescriptors.set(descriptor.executionId, descriptor)
  }
  await Promise.all([...uniqueDescriptors.values()].map(async (descriptor) => {
    switchboardSessionStopper?.({ workspaceRoot, executionId: descriptor.executionId })
    await stopPreparedSessionExecution(workspaceRoot, descriptor.executionId, message)
  }))
}

export async function spawnSwitchboardAgentSession(input: {
  workspaceId?: string
  workspaceRoot: string
  descriptor: SwitchboardAgentSpawnDescriptor
  mcpSettings?: McpSettings
}): Promise<{ ok: true; sessionId: string } | { ok: false; message: string } | undefined> {
  return switchboardSessionSpawner?.(input)
}

export function configureSwitchboardSessionSpawner(spawner: SwitchboardSessionSpawner): void {
  switchboardSessionSpawner = spawner
}

export function configureSwitchboardSessionStopper(stopper: SwitchboardSessionStopper): void {
  switchboardSessionStopper = stopper
}

export function configureSwitchboardExecutionStopper(stopper: SwitchboardSessionStopper): void {
  switchboardExecutionStopper = stopper
}

export function configureSwitchboardRuntimeInventoryProvider(provider: SwitchboardRuntimeInventoryProvider): void {
  switchboardRuntimeInventoryProvider = provider
}

export async function recordSwitchboardSessionExit(input: {
  workspaceRoot: string
  workspaceId?: string
  executionId: string
  exitCode: number
}): Promise<void> {
  await runSwitchboardCore([
    'execution',
    'record-session-exit',
    ...workspaceArgs(input.workspaceRoot),
    input.executionId,
    '--exit-code',
    String(input.exitCode),
  ])
  if (!switchboardRuntimeShuttingDown) {
    await prepareAndSpawnSwitchboardSession(input.workspaceRoot, input.workspaceId ?? switchboardRunnerWorkspaceIds.get(runnerKey(input.workspaceRoot)))
  }
}

export async function startSwitchboardRunner(input: SwitchboardRunnerStartInput): Promise<SwitchboardRunnerResult> {
  const lock = await acquireWorkspaceRunnerLock(input.workspaceRoot)
  if (!lock.ok) return { ok: false, message: lock.message }

  const args = ['runner', 'start', ...workspaceArgs(input.workspaceRoot)]
  args.push('--provider', input.provider ?? 'electron-session')
  args.push('--cli', input.cli ?? 'codex')
  for (const queue of input.queues ?? []) args.push('--queue', queue)
  if (typeof input.maxConcurrency === 'number') args.push('--max-concurrency', String(input.maxConcurrency))
  const result = await runSwitchboardCore(args)
  if (!result.ok) {
    await releaseWorkspaceRunnerLock(input.workspaceRoot)
    return { ok: false, message: result.message || 'Unable to start Switchboard runner.' }
  }
  const key = runnerKey(input.workspaceRoot)
  if (input.mcpSettings) {
    switchboardRunnerMcpSettings.set(key, input.mcpSettings)
  } else {
    switchboardRunnerMcpSettings.delete(key)
  }
  startElectronRunnerLoop(input.workspaceRoot, input.workspaceId)
  return result.payload as SwitchboardRunnerResult
}

export async function pauseSwitchboardRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
  stopElectronRunnerLoop(workspaceRoot)
  const result = await runSwitchboardCore(['runner', 'pause', ...workspaceArgs(workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to pause Switchboard runner.' }
  return result.payload as SwitchboardRunnerResult
}

export async function resumeSwitchboardRunner(input: { workspaceRoot: string; workspaceId?: string; mcpSettings?: McpSettings }): Promise<SwitchboardRunnerResult> {
  const lock = await acquireWorkspaceRunnerLock(input.workspaceRoot)
  if (!lock.ok) return { ok: false, message: lock.message }
  const result = await runSwitchboardCore(['runner', 'resume', ...workspaceArgs(input.workspaceRoot)])
  if (!result.ok) {
    await releaseWorkspaceRunnerLock(input.workspaceRoot)
    return { ok: false, message: result.message || 'Unable to resume Switchboard runner.' }
  }
  if (input.mcpSettings) {
    switchboardRunnerMcpSettings.set(runnerKey(input.workspaceRoot), input.mcpSettings)
  }
  startElectronRunnerLoop(input.workspaceRoot, input.workspaceId ?? switchboardRunnerWorkspaceIds.get(runnerKey(input.workspaceRoot)))
  return result.payload as SwitchboardRunnerResult
}

export async function stopSwitchboardRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
  stopElectronRunnerLoop(workspaceRoot)
  clearElectronRunnerWorkspace(workspaceRoot)
  const result = await runSwitchboardCore(['runner', 'stop', ...workspaceArgs(workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to stop Switchboard runner.' }
  await releaseWorkspaceRunnerLock(workspaceRoot)
  return result.payload as SwitchboardRunnerResult
}

export async function tickSwitchboardRunner(input: { workspaceRoot: string; workspaceId?: string; mcpSettings?: McpSettings }): Promise<SwitchboardRunnerResult> {
  const lock = await acquireWorkspaceRunnerLock(input.workspaceRoot)
  if (!lock.ok) return { ok: false, message: lock.message }
  if (input.mcpSettings) {
    switchboardRunnerMcpSettings.set(runnerKey(input.workspaceRoot), input.mcpSettings)
  }
  await prepareAndSpawnSwitchboardSession(input.workspaceRoot, input.workspaceId ?? switchboardRunnerWorkspaceIds.get(runnerKey(input.workspaceRoot)))
  return getSwitchboardRunnerState(input.workspaceRoot)
}

export async function getSwitchboardRunnerState(input?: string | { workspaceRoot?: string; mcpSettings?: McpSettings }): Promise<SwitchboardRunnerResult> {
  const workspaceRoot = typeof input === 'string' ? input : input?.workspaceRoot
  if (!workspaceRoot?.trim()) return { ok: false, message: 'workspaceRoot is required.' }
  if (typeof input === 'object' && input.mcpSettings) {
    switchboardRunnerMcpSettings.set(runnerKey(workspaceRoot), input.mcpSettings)
  }
  const result = await runSwitchboardCore(['runner', 'status', ...workspaceArgs(workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to read Switchboard runner status.' }
  return result.payload as SwitchboardRunnerResult
}

function isLiveSwitchboardTaskExecution(execution: SwitchboardRunnerExecution): boolean {
  return (
    execution.kind === 'switchboard_task'
    && (!execution.status || execution.status === 'active' || execution.status === 'launching')
  )
}

export async function stopSwitchboardRunnerAndExecutions(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
  const stopResult = await stopSwitchboardRunner(workspaceRoot)
  if (stopResult.ok === false) return stopResult

  const failures: string[] = []
  const executions = stopResult.activeExecutions.filter(isLiveSwitchboardTaskExecution)
  for (const execution of executions) {
    const executionResult = await stopSwitchboardExecution({
      workspaceRoot,
      executionId: execution.executionId,
      reason: 'Stopped with Switchboard runner.',
    })
    if (executionResult.ok === false) {
      failures.push(`${execution.executionId}: ${executionResult.message}`)
      continue
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      message: `Runner stopped, but ${failures.length} active execution${failures.length === 1 ? '' : 's'} could not be stopped. ${failures.join(' ')}`,
    }
  }

  return getSwitchboardRunnerState(workspaceRoot)
}

export async function stopSwitchboardExecution(input: SwitchboardStopExecutionInput): Promise<SwitchboardStopExecutionResult> {
  const args = ['execution', 'stop', ...workspaceArgs(input.workspaceRoot), input.executionId]
  if (input.reason?.trim()) args.push('--reason', input.reason.trim())
  const fallback = await runSwitchboardCore(args)
  if (!fallback.ok) return { ok: false, message: fallback.message || 'Unable to stop Switchboard execution.' }
  switchboardExecutionStopper?.({
    workspaceRoot: input.workspaceRoot,
    executionId: input.executionId,
  })
  return fallback.payload as SwitchboardStopExecutionResult
}
