import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type {
  SwitchboardAddCommentInput,
  SwitchboardCancelTaskInput,
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardCreateTaskInput,
  SwitchboardInitApiResult,
  SwitchboardMoveTaskInput,
  SwitchboardMutationResult,
  SwitchboardPromoteInboxTaskInput,
  SwitchboardPublishTaskInput,
  SwitchboardReadResult,
  SwitchboardTask,
  SwitchboardTaskRecord,
  SwitchboardUpdateTaskInput,
} from '../shared/switchboard'

type PythonCommandResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | null }

function findRepositoryRoot(): string {
  const starts = [process.cwd(), __dirname, process.resourcesPath].filter(Boolean)
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
    const child = spawn(python, ['-m', 'switchboard_core', ...args], {
      cwd: repoRoot,
      env: process.env,
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

async function readTaskForPublish(workspaceRoot: string, id: string): Promise<SwitchboardTask | null> {
  const result = await runSwitchboardCore(['show', ...workspaceArgs(workspaceRoot), id])
  if (!result.ok) return null
  const record = result.payload.record as { task?: SwitchboardTask } | undefined
  return record?.task ?? null
}

export async function publishSwitchboardTask(input: SwitchboardPublishTaskInput): Promise<SwitchboardMutationResult> {
  if (input.summary?.trim()) {
    const task = await readTaskForPublish(input.workspaceRoot, input.id)
    if (task) {
      const evidence = { ...task.evidence, summary: input.summary.trim() }
      const updated = await updateSwitchboardTask({
        workspaceRoot: input.workspaceRoot,
        id: input.id,
        updates: { evidence },
      })
      if (!updated.ok) return updated
    }
  }
  const to = input.to ?? 'testing'
  const result = await runSwitchboardCore(['publish', ...workspaceArgs(input.workspaceRoot), input.id, '--to', to])
  return mutationResult(result, 'Unable to publish Switchboard task.')
}
