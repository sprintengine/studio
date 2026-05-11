import { spawn } from 'child_process'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { dirname, join, resolve } from 'path'
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
    const child = spawn(python, ['-m', 'switchboard_core', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PYTHONPATH: existingPythonPath ? `${repoRoot}${process.platform === 'win32' ? ';' : ':'}${existingPythonPath}` : repoRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
      resolvePromise({ ok: false, message: error.message })
    })
    child.on('close', (exitCode) => {
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

function serverDescriptorPath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), '.multi-code', 'switchboard', 'runner', 'server.json')
}

type SwitchboardServerDescriptor = { host: string; port: number; token: string; pid?: number }
const SWITCHBOARD_SERVER_API_VERSION = 2

export function readSwitchboardServerDescriptor(workspaceRoot: string): SwitchboardServerDescriptor | null {
  return readServerDescriptor(workspaceRoot)
}

export type { SwitchboardServerDescriptor }

function readServerDescriptor(workspaceRoot: string): SwitchboardServerDescriptor | null {
  try {
    const parsed = JSON.parse(readFileSync(serverDescriptorPath(workspaceRoot), 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const descriptor = parsed as { host?: unknown; port?: unknown; token?: unknown; pid?: unknown }
    if (typeof descriptor.host !== 'string' || typeof descriptor.port !== 'number' || typeof descriptor.token !== 'string') return null
    return {
      host: descriptor.host,
      port: descriptor.port,
      token: descriptor.token,
      pid: typeof descriptor.pid === 'number' ? descriptor.pid : undefined,
    }
  } catch {
    return null
  }
}

function removeServerDescriptor(workspaceRoot: string): void {
  try {
    unlinkSync(serverDescriptorPath(workspaceRoot))
  } catch {
    // The descriptor may already have been removed by the backend.
  }
}

function terminateServerDescriptorProcess(workspaceRoot: string, descriptor: SwitchboardServerDescriptor | null): void {
  if (!descriptor?.pid || descriptor.pid <= 0) return
  try {
    process.kill(descriptor.pid, 'SIGTERM')
  } catch {
    // The process may have exited between the failed request and fallback stop.
  }
  removeServerDescriptor(workspaceRoot)
}

async function backendHealthy(descriptor: SwitchboardServerDescriptor): Promise<boolean> {
  try {
    const response = await fetch(`http://${descriptor.host}:${descriptor.port}/health`, {
      headers: { Authorization: `Bearer ${descriptor.token}` },
    })
    if (!response.ok) return false
    const payload = parseJsonPayload(await response.text())
    return payload.apiVersion === SWITCHBOARD_SERVER_API_VERSION
  } catch {
    return false
  }
}

async function ensureSwitchboardBackend(
  workspaceRoot: string
): Promise<{ ok: true; descriptor: SwitchboardServerDescriptor } | { ok: false; message: string }> {
  const existing = readServerDescriptor(workspaceRoot)
  if (existing && (await backendHealthy(existing))) return { ok: true, descriptor: existing }

  const repoRoot = findRepositoryRoot()
  const python = findPythonExecutable(repoRoot)
  const existingPythonPath = process.env['PYTHONPATH']
  const child = spawn(python, ['-m', 'switchboard_core', 'runner', 'run', ...workspaceArgs(workspaceRoot)], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PYTHONPATH: existingPythonPath ? `${repoRoot}${process.platform === 'win32' ? ';' : ':'}${existingPythonPath}` : repoRoot,
    },
  })
  child.unref()

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    const descriptor = readServerDescriptor(workspaceRoot)
    if (descriptor && (await backendHealthy(descriptor))) return { ok: true, descriptor }
  }
  return { ok: false, message: 'Switchboard backend did not become healthy.' }
}

async function requestSwitchboardBackend(
  workspaceRoot: string,
  pathName: string,
  body?: Record<string, unknown>
): Promise<PythonCommandResult> {
  const backend = await ensureSwitchboardBackend(workspaceRoot)
  if (!backend.ok) return backend
  try {
    const response = await fetch(`http://${backend.descriptor.host}:${backend.descriptor.port}${pathName}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${backend.descriptor.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const payload = parseJsonPayload(await response.text())
    if (!response.ok || payload.ok === false) {
      return { ok: false, message: typeof payload.message === 'string' ? payload.message : 'Switchboard backend request failed.' }
    }
    return { ok: true, payload }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Switchboard backend request failed.' }
  }
}

async function requestSwitchboardBackendReplacingNotFound(
  workspaceRoot: string,
  pathName: string,
  body?: Record<string, unknown>
): Promise<PythonCommandResult> {
  const first = await requestSwitchboardBackend(workspaceRoot, pathName, body)
  if (first.ok || first.message.toLowerCase() !== 'not found.') return first

  const descriptor = readServerDescriptor(workspaceRoot)
  terminateServerDescriptorProcess(workspaceRoot, descriptor)
  return requestSwitchboardBackend(workspaceRoot, pathName, body)
}

async function requestExistingSwitchboardBackend(
  workspaceRoot: string,
  pathName: string,
  body?: Record<string, unknown>
): Promise<PythonCommandResult> {
  const descriptor = readServerDescriptor(workspaceRoot)
  if (!descriptor || !(await backendHealthy(descriptor))) {
    return { ok: false, message: 'Switchboard backend is not running.' }
  }
  try {
    const response = await fetch(`http://${descriptor.host}:${descriptor.port}${pathName}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${descriptor.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const payload = parseJsonPayload(await response.text())
    if (!response.ok || payload.ok === false) {
      return { ok: false, message: typeof payload.message === 'string' ? payload.message : 'Switchboard backend request failed.' }
    }
    return { ok: true, payload }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Switchboard backend request failed.' }
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
  const result = await requestSwitchboardBackend(input.workspaceRoot, '/runner/start', {
    provider: input.provider ?? 'local-process',
    cli: input.cli ?? 'codex',
    queues: input.queues,
    maxConcurrency: input.maxConcurrency,
  })
  if (!result.ok) return { ok: false, message: result.message || 'Unable to start Switchboard runner.' }
  return result.payload as SwitchboardRunnerResult
}

export async function pauseSwitchboardRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
  const result = await requestSwitchboardBackend(workspaceRoot, '/runner/pause', {})
  if (!result.ok) return { ok: false, message: result.message || 'Unable to pause Switchboard runner.' }
  return result.payload as SwitchboardRunnerResult
}

export async function resumeSwitchboardRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
  const result = await requestSwitchboardBackend(workspaceRoot, '/runner/resume', {})
  if (!result.ok) return { ok: false, message: result.message || 'Unable to resume Switchboard runner.' }
  return result.payload as SwitchboardRunnerResult
}

export async function stopSwitchboardRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
  const descriptor = readServerDescriptor(workspaceRoot)
  const result = await requestExistingSwitchboardBackend(workspaceRoot, '/runner/stop', {})
  if (result.ok) return result.payload as SwitchboardRunnerResult
  const fallback = await runSwitchboardCore(['runner', 'stop', ...workspaceArgs(workspaceRoot)])
  if (!fallback.ok) return { ok: false, message: fallback.message || 'Unable to stop Switchboard runner.' }
  terminateServerDescriptorProcess(workspaceRoot, descriptor)
  return fallback.payload as SwitchboardRunnerResult
}

export async function tickSwitchboardRunner(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
  const result = await requestSwitchboardBackend(workspaceRoot, '/runner/tick', {})
  if (!result.ok) return { ok: false, message: result.message || 'Unable to tick Switchboard runner.' }
  return result.payload as SwitchboardRunnerResult
}

export async function getSwitchboardRunnerState(workspaceRoot?: string): Promise<SwitchboardRunnerResult> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'workspaceRoot is required.' }
  const result = await requestExistingSwitchboardBackend(workspaceRoot, '/runner/status', {})
  if (result.ok) return result.payload as SwitchboardRunnerResult
  const fallback = await runSwitchboardCore(['runner', 'status', ...workspaceArgs(workspaceRoot)])
  if (!fallback.ok) return { ok: false, message: fallback.message || 'Unable to read Switchboard runner status.' }
  return fallback.payload as SwitchboardRunnerResult
}

export async function stopSwitchboardExecution(input: SwitchboardStopExecutionInput): Promise<SwitchboardStopExecutionResult> {
  const body = input.reason?.trim() ? { reason: input.reason.trim() } : {}
  const result = await requestExistingSwitchboardBackend(input.workspaceRoot, `/execution/${input.executionId}/stop`, body)
  if (result.ok) return result.payload as SwitchboardStopExecutionResult
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
  const path = `/execution/${encodeURIComponent(input.executionId)}/status`
  const result = await requestExistingSwitchboardBackend(input.workspaceRoot, path)
  if (result.ok) return result.payload as SwitchboardExecutionStatusResult
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
  const query = new URLSearchParams({ stream: input.stream, tail: String(tail) }).toString()
  const path = `/execution/${encodeURIComponent(input.executionId)}/logs?${query}`
  const result = await requestExistingSwitchboardBackend(input.workspaceRoot, path)
  if (result.ok) return result.payload as SwitchboardExecutionLogsResult
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
  const result = await requestSwitchboardBackendReplacingNotFound(input.workspaceRoot, '/watchtower/start-review', {
    preset: input.preset,
  })
  if (!result.ok) return { ok: false, message: result.message || 'Unable to start Watchtower review.' }
  return result.payload as WatchtowerRunResult
}

export async function startWatchtowerTriage(input: WatchtowerStartTriageInput): Promise<WatchtowerRunResult> {
  const body: Record<string, unknown> = { scope: input.scope }
  if (input.taskId?.trim()) body.taskId = input.taskId.trim()
  const result = await requestSwitchboardBackendReplacingNotFound(input.workspaceRoot, '/watchtower/start-triage', body)
  if (!result.ok) return { ok: false, message: result.message || 'Unable to start Watchtower triage.' }
  return result.payload as WatchtowerRunResult
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
