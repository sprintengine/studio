import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, resolve } from 'path'

export type SwarmToolInvocation = {
  args: string[]
  cwd: string
}

export type SwarmToolExecutionResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type SwarmToolExecutor = (invocation: SwarmToolInvocation) => Promise<SwarmToolExecutionResult>

export function createSwarmToolExecutor(swarmToolPath: string): SwarmToolExecutor {
  return (invocation) => new Promise((resolvePromise) => {
    const executable = getWorkspacePythonExecutable(invocation.cwd)
    const child = spawn(executable, [swarmToolPath, ...invocation.args], {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        SPRINTENGINE_REPO_WRAPPER_PATH: join(invocation.cwd, 'scripts', 'sprintengine_tool.py'),
        SPRINTENGINE_REPO_TOOL_PATH: join(invocation.cwd, '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
      },
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      resolvePromise({ exitCode: 1, stdout, stderr: stderr || error.message })
    })
    child.on('close', (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr })
    })
  })
}

export function defaultSwarmToolPath(): string {
  return resolve(process.cwd(), 'scripts', 'sprintengine_tool.py')
}

export function parseToolJson(stdout: string): { ok: boolean; data?: unknown; message?: string; error?: string } {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>
    return {
      ok: data.ok === true,
      data,
      message: typeof data.message === 'string' ? data.message : undefined,
      error: typeof data.error === 'string' ? data.error : undefined,
    }
  } catch {
    return { ok: false, error: 'Sprint Engine tool did not return valid JSON.' }
  }
}

export function redactToolArgs(args: string[]): string[] {
  const redacted = [...args]
  for (let index = 0; index < redacted.length - 1; index += 1) {
    if (redacted[index] === '--feedback' || redacted[index] === '--goal' || redacted[index] === '--handover-text') {
      redacted[index + 1] = '[redacted]'
    }
  }
  return redacted
}

function getWorkspacePythonExecutable(workspaceRoot: string): string {
  const venvPython = process.platform === 'win32'
    ? join(workspaceRoot, '.venv', 'Scripts', 'python.exe')
    : join(workspaceRoot, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython

  const windowsVenvPython = join(workspaceRoot, '.venv', 'Scripts', 'python.exe')
  if (existsSync(windowsVenvPython)) return windowsVenvPython

  return process.platform === 'win32' ? 'python' : 'python3'
}
