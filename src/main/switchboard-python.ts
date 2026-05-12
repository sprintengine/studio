import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { APP_INSTANCE_ID, acquireWorkspaceRunnerLock, releaseWorkspaceRunnerLock } from './workspace-runner-lock'
import type {
  SwitchboardAddCommentInput,
  SwitchboardCancelTaskInput,
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardCreateTaskInput,
  SwitchboardInitApiResult,
  SwitchboardImportItem,
  SwitchboardImportItemResult,
  SwitchboardMoveTaskInput,
  SwitchboardMutationResult,
  SwitchboardPromoteInboxTaskInput,
  SwitchboardPublishTaskInput,
  SwitchboardReadResult,
  SwitchboardAgentSpawnDescriptor,
  SwitchboardPrepareSessionResult,
  SwitchboardRecoverLockInput,
  SwitchboardRecoverLockResult,
  SwitchboardRequeueTaskInput,
  SwitchboardRunnerResult,
  SwitchboardRunnerStartInput,
  SwitchboardExecutionLogsInput,
  SwitchboardExecutionLogsResult,
  SwitchboardExecutionStatusInput,
  SwitchboardExecutionStatusResult,
  SwitchboardStopExecutionInput,
  SwitchboardStopExecutionResult,
  SwitchboardTaskRecord,
  SwitchboardUpdateTaskInput,
  WatchtowerRunListResult,
  WatchtowerRunResult,
  WatchtowerStartReviewInput,
  WatchtowerStartTriageInput,
} from '../shared/switchboard'

type SwitchboardSessionSpawner = (input: {
  workspaceId?: string
  workspaceRoot: string
  descriptor: SwitchboardAgentSpawnDescriptor
}) => Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>

type SwitchboardSessionStopper = (input: {
  workspaceRoot: string
  executionId: string
}) => void

type SwitchboardRuntimeInventoryProvider = (workspaceRoot: string) => string[]

type PythonCommandResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | null }

function findRepositoryRoot(): string {
  const starts = [
    process.env['MULTICODE_SWITCHBOARD_CORE_ROOT'],
    process.cwd(),
    __dirname,
    process.resourcesPath,
    process.env['APPDIR'],
  ].filter(Boolean) as string[]
  for (const start of starts) {
    let current = resolve(start)
    for (;;) {
      if (existsSync(join(current, 'switchboard_core')) || existsSync(join(current, 'scripts', 'switchboard'))) {
        return current
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return process.cwd()
}

function findPythonExecutable(repoRoot: string): string {
  const posixVenv = join(repoRoot, '.venv', 'bin', 'python')
  if (existsSync(posixVenv)) return posixVenv
  const windowsVenv = join(repoRoot, '.venv', 'Scripts', 'python.exe')
  if (existsSync(windowsVenv)) return windowsVenv
  return process.platform === 'win32' ? 'python' : 'python3'
}

function parseJsonPayload(output: string): Record<string, unknown> {
  const trimmed = output.trim()
  if (!trimmed) throw new Error('Switchboard core returned no JSON output.')
  const parsed = JSON.parse(trimmed) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Switchboard core returned invalid JSON output.')
  }
  return parsed as Record<string, unknown>
}

async function runSwitchboardCore(args: string[]): Promise<PythonCommandResult> {
  const repoRoot = findRepositoryRoot()
  const python = findPythonExecutable(repoRoot)

  return new Promise((resolvePromise) => {
    const existingPythonPath = process.env['PYTHONPATH']
    let child: ChildProcess
    try {
      child = spawn(python, ['-m', 'switchboard_core', ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PYTHONPATH: existingPythonPath ? `${repoRoot}${process.platform === 'win32' ? ';' : ':'}${existingPythonPath}` : repoRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      inFlightPythonChildren.add(child)
    } catch (error) {
      resolvePromise({
        ok: false,
        message: error instanceof Error
          ? `Failed to spawn '${python}': ${error.message}`
          : `Failed to spawn '${python}'.`,
      })
      return
    }
    if (!child.stdout || !child.stderr) {
      // Should never happen for stdio: ['ignore', 'pipe', 'pipe'], but
      // surface a clear error if some Electron/Node combination yields
      // null streams instead of a TypeError on the next .setEncoding.
      inFlightPythonChildren.delete(child)
      resolvePromise({
        ok: false,
        message: `'${python}' was spawned without pipe streams (stdout=${Boolean(child.stdout)}, stderr=${Boolean(child.stderr)}).`,
      })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      inFlightPythonChildren.delete(child)
      resolvePromise({ ok: false, message: error.message })
    })
    child.on('close', (exitCode) => {
      inFlightPythonChildren.delete(child)
      if (exitCode === 0) {
        try {
          resolvePromise({ ok: true, payload: parseJsonPayload(stdout) })
        } catch (error) {
          resolvePromise({
            ok: false,
            message: error instanceof Error ? error.message : 'Switchboard core returned invalid output.',
            stdout,
            stderr,
            exitCode,
          })
        }
        return
      }

      let message = stderr.trim() || stdout.trim() || `Switchboard core exited with code ${exitCode}.`
      try {
        const payload = parseJsonPayload(stderr || stdout)
        if (typeof payload.message === 'string') message = payload.message
      } catch {
        // Keep raw stderr/stdout message.
      }
      resolvePromise({ ok: false, message, stdout, stderr, exitCode })
    })
  })
}

function mutationResult(result: PythonCommandResult, fallbackMessage: string): SwitchboardMutationResult {
  if (!result.ok) return { ok: false, message: result.message || fallbackMessage }
  const record = result.payload.record
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, message: 'Switchboard core returned a mutation without a task record.' }
  }
  return { ok: true, record: record as SwitchboardTaskRecord }
}

function claimResult(result: PythonCommandResult): SwitchboardClaimTaskResult {
  if (!result.ok) return { ok: false, message: result.message || 'Unable to claim Switchboard task.' }
  if (result.payload.claimed === false) {
    return { ok: false, message: typeof result.payload.message === 'string' ? result.payload.message : 'No eligible task.' }
  }
  return mutationResult(result, 'Unable to claim Switchboard task.') as SwitchboardClaimTaskResult
}

function workspaceArgs(workspaceRoot: string): string[] {
  return ['--workspace', workspaceRoot]
}

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
  switchboardRunnerWorkspaceIds.delete(runnerKey(workspaceRoot))
}

export function stopAllSwitchboardRunnerLoops(): void {
  for (const interval of switchboardRunnerIntervals.values()) {
    clearInterval(interval)
  }
  switchboardRunnerIntervals.clear()
}

let switchboardRuntimeShuttingDown = false

export function beginSwitchboardPythonRuntimeShutdown(): void {
  switchboardRuntimeShuttingDown = true
  stopAllSwitchboardRunnerLoops()
  inFlightWorkspaceTicks.clear()
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolvePromise(false)
    }, timeoutMs)
    const onClose = () => {
      clearTimeout(timer)
      resolvePromise(true)
    }
    child.once('close', onClose)
  })
}

export async function shutdownSwitchboardPythonRuntime(): Promise<void> {
  beginSwitchboardPythonRuntimeShutdown()
  const children = [...inFlightPythonChildren]
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Process may have exited between snapshot and shutdown.
      }
    }
  }
  const settled = await Promise.all(children.map((child) => waitForChildExit(child, 1_500)))
  children.forEach((child, index) => {
    if (!settled[index] && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Best effort during app shutdown.
      }
    }
  })
  await Promise.all(children.map((child) => waitForChildExit(child, 500)))
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
    const spawned = await switchboardSessionSpawner({ workspaceId, workspaceRoot, descriptor })
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

async function stopSpawnedWatchtowerSessions(
  workspaceRoot: string,
  descriptors: SwitchboardAgentSpawnDescriptor[],
  message: string,
): Promise<void> {
  await Promise.all(descriptors.map(async (descriptor) => {
    switchboardSessionStopper?.({ workspaceRoot, executionId: descriptor.executionId })
    await stopPreparedSessionExecution(workspaceRoot, descriptor.executionId, message)
  }))
}

const SWITCHBOARD_RUNNER_INTERVAL_MS = 5_000
let switchboardSessionSpawner: SwitchboardSessionSpawner | null = null
let switchboardSessionStopper: SwitchboardSessionStopper | null = null
let switchboardRuntimeInventoryProvider: SwitchboardRuntimeInventoryProvider | null = null
const switchboardRunnerIntervals = new Map<string, NodeJS.Timeout>()
const switchboardRunnerWorkspaceIds = new Map<string, string>()
const inFlightWorkspaceTicks = new Set<string>()
const inFlightPythonChildren = new Set<ChildProcess>()

export function configureSwitchboardSessionSpawner(spawner: SwitchboardSessionSpawner): void {
  switchboardSessionSpawner = spawner
}

export function configureSwitchboardSessionStopper(stopper: SwitchboardSessionStopper): void {
  switchboardSessionStopper = stopper
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

export async function initializeSwitchboard(input: { workspaceRoot: string }): Promise<SwitchboardInitApiResult> {
  const result = await runSwitchboardCore(['init', ...workspaceArgs(input.workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to initialize Switchboard.' }
  return result.payload as SwitchboardInitApiResult
}

export async function readAllSwitchboardTasks(input: { workspaceRoot: string }): Promise<SwitchboardReadResult> {
  const result = await runSwitchboardCore(['read-all', ...workspaceArgs(input.workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to read Switchboard tasks.' }
  return result.payload as SwitchboardReadResult
}

export async function createSwitchboardTask(input: SwitchboardCreateTaskInput): Promise<SwitchboardMutationResult> {
  const result = await runSwitchboardCore([
    'create',
    ...workspaceArgs(input.workspaceRoot),
    '--input-json',
    JSON.stringify(input),
  ])
  return mutationResult(result, 'Unable to create Switchboard task.')
}

export async function importSwitchboardItem(
  workspaceRoot: string,
  item: SwitchboardImportItem
): Promise<SwitchboardImportItemResult> {
  const result = await runSwitchboardCore([
    'import-task',
    ...workspaceArgs(workspaceRoot),
    '--input-json',
    JSON.stringify(item),
  ])
  if (!result.ok) {
    return {
      provider: item.provider,
      externalKey: item.externalKey,
      externalUrl: item.externalUrl,
      status: 'error',
      message: result.message || 'Unable to import task.',
    }
  }
  if (result.payload.created === true) {
    return {
      provider: item.provider,
      externalKey: item.externalKey,
      externalUrl: item.externalUrl,
      status: 'created',
      taskId: typeof result.payload.id === 'string' ? result.payload.id : null,
    }
  }
  return {
    provider: item.provider,
    externalKey: item.externalKey,
    externalUrl: item.externalUrl,
    status: 'skipped',
    message: 'Duplicate source identity.',
  }
}

export async function updateSwitchboardTask(input: SwitchboardUpdateTaskInput): Promise<SwitchboardMutationResult> {
  const result = await runSwitchboardCore([
    'update',
    ...workspaceArgs(input.workspaceRoot),
    input.id,
    '--updates-json',
    JSON.stringify(input.updates),
  ])
  return mutationResult(result, 'Unable to update Switchboard task.')
}

export async function moveSwitchboardTask(input: SwitchboardMoveTaskInput): Promise<SwitchboardMutationResult> {
  const result = await runSwitchboardCore(['move', ...workspaceArgs(input.workspaceRoot), input.id, '--to', input.to])
  return mutationResult(result, 'Unable to move Switchboard task.')
}

export async function promoteSwitchboardInboxTask(input: SwitchboardPromoteInboxTaskInput): Promise<SwitchboardMutationResult> {
  const result = await runSwitchboardCore(['promote', ...workspaceArgs(input.workspaceRoot), input.id])
  return mutationResult(result, 'Unable to promote Switchboard inbox task.')
}

export async function cancelSwitchboardTask(input: SwitchboardCancelTaskInput): Promise<SwitchboardMutationResult> {
  const result = await runSwitchboardCore(['cancel', ...workspaceArgs(input.workspaceRoot), input.id])
  return mutationResult(result, 'Unable to cancel Switchboard task.')
}

export async function addSwitchboardComment(input: SwitchboardAddCommentInput): Promise<SwitchboardMutationResult> {
  const args = ['comment', ...workspaceArgs(input.workspaceRoot), input.id, '--body', input.body]
  if (input.author?.name) args.push('--author', input.author.name)
  if (input.author?.type) args.push('--author-type', input.author.type)
  if (input.author?.id) args.push('--author-id', input.author.id)
  if (input.kind) args.push('--kind', input.kind)
  const result = await runSwitchboardCore(args)
  return mutationResult(result, 'Unable to add Switchboard comment.')
}

export async function claimSwitchboardTask(input: SwitchboardClaimTaskInput): Promise<SwitchboardClaimTaskResult> {
  const result = await runSwitchboardCore([
    'claim',
    ...workspaceArgs(input.workspaceRoot),
    '--from',
    input.from,
    '--agent',
    input.owner,
  ])
  return claimResult(result)
}

export async function publishSwitchboardTask(input: SwitchboardPublishTaskInput): Promise<SwitchboardMutationResult> {
  const to = input.to ?? 'testing'
  const args = ['publish', ...workspaceArgs(input.workspaceRoot), input.id, '--to', to]
  if (input.summary?.trim()) args.push('--summary', input.summary.trim())
  for (const artifact of input.artifacts ?? []) {
    if (artifact.trim()) args.push('--artifact', artifact.trim())
  }
  for (const command of input.commandsRun ?? []) {
    if (command.trim()) args.push('--command', command.trim())
  }
  for (const touchedFile of input.touchedFiles ?? []) {
    if (touchedFile.trim()) args.push('--touched-file', touchedFile.trim())
  }
  if (input.comment?.trim()) args.push('--comment', input.comment.trim())
  const result = await runSwitchboardCore(args)
  return mutationResult(result, 'Unable to publish Switchboard task.')
}

export async function recoverSwitchboardLock(input: SwitchboardRecoverLockInput): Promise<SwitchboardRecoverLockResult> {
  const result = await runSwitchboardCore([
    'recover-lock',
    ...workspaceArgs(input.workspaceRoot),
    '--status',
    input.status,
  ])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to recover Switchboard lock.' }
  return result.payload as SwitchboardRecoverLockResult
}

export async function requeueSwitchboardTask(input: SwitchboardRequeueTaskInput): Promise<SwitchboardMutationResult> {
  const args = ['requeue', ...workspaceArgs(input.workspaceRoot), input.id]
  if (input.reason?.trim()) args.push('--reason', input.reason.trim())
  const result = await runSwitchboardCore(args)
  return mutationResult(result, 'Unable to requeue Switchboard task.')
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
  startElectronRunnerLoop(input.workspaceRoot, input.workspaceId)
  return result.payload as SwitchboardRunnerResult
}

export async function pauseSwitchboardRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
  stopElectronRunnerLoop(workspaceRoot)
  const result = await runSwitchboardCore(['runner', 'pause', ...workspaceArgs(workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to pause Switchboard runner.' }
  return result.payload as SwitchboardRunnerResult
}

export async function resumeSwitchboardRunner(input: { workspaceRoot: string; workspaceId?: string }): Promise<SwitchboardRunnerResult> {
  const lock = await acquireWorkspaceRunnerLock(input.workspaceRoot)
  if (!lock.ok) return { ok: false, message: lock.message }
  const result = await runSwitchboardCore(['runner', 'resume', ...workspaceArgs(input.workspaceRoot)])
  if (!result.ok) {
    await releaseWorkspaceRunnerLock(input.workspaceRoot)
    return { ok: false, message: result.message || 'Unable to resume Switchboard runner.' }
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

export async function tickSwitchboardRunner(input: { workspaceRoot: string; workspaceId?: string }): Promise<SwitchboardRunnerResult> {
  const lock = await acquireWorkspaceRunnerLock(input.workspaceRoot)
  if (!lock.ok) return { ok: false, message: lock.message }
  await prepareAndSpawnSwitchboardSession(input.workspaceRoot, input.workspaceId ?? switchboardRunnerWorkspaceIds.get(runnerKey(input.workspaceRoot)))
  return getSwitchboardRunnerState(input.workspaceRoot)
}

export async function getSwitchboardRunnerState(workspaceRoot?: string): Promise<SwitchboardRunnerResult> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'workspaceRoot is required.' }
  const result = await runSwitchboardCore(['runner', 'status', ...workspaceArgs(workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to read Switchboard runner status.' }
  return result.payload as SwitchboardRunnerResult
}

export async function stopSwitchboardExecution(input: SwitchboardStopExecutionInput): Promise<SwitchboardStopExecutionResult> {
  const args = ['execution', 'stop', ...workspaceArgs(input.workspaceRoot), input.executionId]
  if (input.reason?.trim()) args.push('--reason', input.reason.trim())
  const fallback = await runSwitchboardCore(args)
  if (!fallback.ok) return { ok: false, message: fallback.message || 'Unable to stop Switchboard execution.' }
  return fallback.payload as SwitchboardStopExecutionResult
}

export async function getSwitchboardExecutionStatus(
  input: SwitchboardExecutionStatusInput,
): Promise<SwitchboardExecutionStatusResult> {
  if (!input.workspaceRoot?.trim()) return { ok: false, message: 'workspaceRoot is required.' }
  if (!input.executionId?.trim()) return { ok: false, message: 'executionId is required.' }
  const fallback = await runSwitchboardCore([
    'execution',
    'status',
    ...workspaceArgs(input.workspaceRoot),
    input.executionId,
  ])
  if (!fallback.ok) {
    return { ok: false, message: fallback.message || 'Unable to read Switchboard execution status.' }
  }
  return fallback.payload as SwitchboardExecutionStatusResult
}

export async function getSwitchboardExecutionLogs(
  input: SwitchboardExecutionLogsInput,
): Promise<SwitchboardExecutionLogsResult> {
  if (!input.workspaceRoot?.trim()) return { ok: false, message: 'workspaceRoot is required.' }
  if (!input.executionId?.trim()) return { ok: false, message: 'executionId is required.' }
  if (input.stream !== 'stdout' && input.stream !== 'stderr') {
    return { ok: false, message: 'stream must be stdout or stderr.' }
  }
  const tail = Number.isFinite(input.tail) ? Math.max(1, Math.min(5000, Math.floor(input.tail as number))) : 200
  const fallback = await runSwitchboardCore([
    'execution',
    'logs',
    ...workspaceArgs(input.workspaceRoot),
    input.executionId,
    '--stream',
    input.stream,
    '--tail',
    String(tail),
  ])
  if (!fallback.ok) {
    return { ok: false, message: fallback.message || 'Unable to read Switchboard execution logs.' }
  }
  return fallback.payload as SwitchboardExecutionLogsResult
}

export async function startWatchtowerReview(input: WatchtowerStartReviewInput): Promise<WatchtowerRunResult> {
  const args = [
    'watchtower',
    'start-review',
    ...workspaceArgs(input.workspaceRoot),
    '--preset',
    input.preset,
    '--app-instance-id',
    APP_INSTANCE_ID,
  ]
  if (input.workspaceId) args.push('--workspace-id', input.workspaceId)
  const result = await runSwitchboardCore(args)
  if (!result.ok) return { ok: false, message: result.message || 'Unable to start Watchtower review.' }
  const payload = result.payload as WatchtowerRunResult
  if (payload.ok) {
    const spawnedDescriptors: SwitchboardAgentSpawnDescriptor[] = []
    for (const descriptor of payload.descriptors ?? []) {
      const spawned = await switchboardSessionSpawner?.({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, descriptor })
      if (spawned && !spawned.ok) {
        await stopPreparedSessionExecution(input.workspaceRoot, descriptor.executionId, spawned.message)
        await stopSpawnedWatchtowerSessions(
          input.workspaceRoot,
          spawnedDescriptors,
          spawned.message || 'Watchtower review startup failed.',
        )
        return { ok: false, message: spawned.message || 'Unable to start Watchtower review terminal.' }
      }
      if (spawned?.ok) spawnedDescriptors.push(descriptor)
    }
  }
  return payload
}

export async function startWatchtowerTriage(input: WatchtowerStartTriageInput): Promise<WatchtowerRunResult> {
  const args = [
    'watchtower',
    'start-triage',
    ...workspaceArgs(input.workspaceRoot),
    '--scope',
    input.scope,
    '--app-instance-id',
    APP_INSTANCE_ID,
  ]
  if (input.workspaceId) args.push('--workspace-id', input.workspaceId)
  if (input.taskId?.trim()) args.push('--task-id', input.taskId.trim())
  const result = await runSwitchboardCore(args)
  if (!result.ok) return { ok: false, message: result.message || 'Unable to start Watchtower triage.' }
  const payload = result.payload as WatchtowerRunResult
  if (payload.ok) {
    const spawnedDescriptors: SwitchboardAgentSpawnDescriptor[] = []
    for (const descriptor of payload.descriptors ?? []) {
      const spawned = await switchboardSessionSpawner?.({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, descriptor })
      if (spawned && !spawned.ok) {
        await stopPreparedSessionExecution(input.workspaceRoot, descriptor.executionId, spawned.message)
        await stopSpawnedWatchtowerSessions(
          input.workspaceRoot,
          spawnedDescriptors,
          spawned.message || 'Watchtower triage startup failed.',
        )
        return { ok: false, message: spawned.message || 'Unable to start Watchtower triage terminal.' }
      }
      if (spawned?.ok) spawnedDescriptors.push(descriptor)
    }
  }
  return payload
}

export async function getWatchtowerRun(input: { workspaceRoot: string; runId: string }): Promise<WatchtowerRunResult> {
  const result = await runSwitchboardCore(['watchtower', 'run-status', ...workspaceArgs(input.workspaceRoot), input.runId])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to read Watchtower run.' }
  return result.payload as WatchtowerRunResult
}

export async function listWatchtowerRuns(workspaceRoot: string): Promise<WatchtowerRunListResult> {
  const result = await runSwitchboardCore(['watchtower', 'run-list', ...workspaceArgs(workspaceRoot)])
  if (!result.ok) return { ok: false, message: result.message || 'Unable to list Watchtower runs.' }
  return result.payload as WatchtowerRunListResult
}
