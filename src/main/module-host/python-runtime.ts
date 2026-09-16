import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { delimiter } from 'node:path'

import { getManagedPython, managedPythonSpawnEnv, type PythonSource, type ResolvedPython } from '../managed-runtime'

// Host-owned Python spawn. The module names a package directory and an entry
// (`-m` or a script); this file resolves the managed interpreter, prepends the
// package directory to PYTHONPATH, and never hands the interpreter path back.
// Callers (the sidecar kernel, `runPython`) inject spawn/resolve in tests.

export type PythonSidecarConfig = {
  /** Directory of Python packages, relative to the module root (absolute when the module has no root). */
  root: string
  /** `python -m <module>`. */
  module: string
  args?: string[]
  env?: Record<string, string>
}

export type RunPythonRequest = {
  root: string
  script?: string
  module?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export type RunPythonResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type PythonRuntimeDeps = {
  resolveInterpreter?: (repoRoot?: string) => ResolvedPython
  spawnProcess?: typeof spawn
}

export const PYTHON_SIDECAR_STOP_GRACE_MS = 1_000

export function resolvePythonInterpreter(repoRoot: string | undefined, deps: PythonRuntimeDeps = {}): ResolvedPython {
  return (deps.resolveInterpreter ?? ((root) => getManagedPython(root)))(repoRoot)
}

export function buildManagedPythonEnv(
  pythonRoot: string,
  base: NodeJS.ProcessEnv,
  source: PythonSource
): NodeJS.ProcessEnv {
  const pythonPath = [pythonRoot, base.PYTHONPATH].filter(Boolean).join(delimiter)
  return managedPythonSpawnEnv({ ...base, PYTHONPATH: pythonPath }, source)
}

export function spawnManagedPython(
  input: {
    pythonRoot: string
    module?: string
    script?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
  },
  deps: PythonRuntimeDeps = {}
): { child: ChildProcessWithoutNullStreams; command: string; argv: string[] } {
  if (Boolean(input.module) === Boolean(input.script)) {
    throw new Error('Python spawn requires exactly one of module or script.')
  }
  const resolved = resolvePythonInterpreter(input.pythonRoot, deps)
  const argv = input.module
    ? ['-m', input.module, ...(input.args ?? [])]
    : [input.script as string, ...(input.args ?? [])]
  const env = buildManagedPythonEnv(
    input.pythonRoot,
    input.env ? { ...process.env, ...input.env } : { ...process.env },
    resolved.source
  )
  const spawnProcess = deps.spawnProcess ?? spawn
  const child = spawnProcess(resolved.command, argv, {
    cwd: input.cwd ?? input.pythonRoot,
    env,
  }) as ChildProcessWithoutNullStreams
  return { child, command: resolved.command, argv }
}

export function runManagedPython(
  input: {
    pythonRoot: string
    module?: string
    script?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    timeoutMs?: number
  },
  deps: PythonRuntimeDeps = {}
): Promise<RunPythonResult> {
  const { child } = spawnManagedPython(input, deps)
  return waitForPythonChild(child, input.timeoutMs)
}

export function waitForPythonChild(
  child: ChildProcessWithoutNullStreams,
  timeoutMs?: number
): Promise<RunPythonResult> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: RunPythonResult): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      resolve(result)
    }
    const timeout = timeoutMs !== undefined
      ? setTimeout(() => {
          if (child.pid && !child.killed) child.kill('SIGKILL')
          finish({ exitCode: null, stdout, stderr })
        }, timeoutMs)
      : undefined

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      if (timeout) clearTimeout(timeout)
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('close', (exitCode) => {
      finish({ exitCode, stdout, stderr })
    })
  })
}

export async function stopPythonChild(child: ChildProcessWithoutNullStreams | null | undefined): Promise<void> {
  if (!child || child.killed) return
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(grace)
      clearTimeout(kill)
      resolve()
    }
    const grace = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, PYTHON_SIDECAR_STOP_GRACE_MS)
    const kill = setTimeout(finish, PYTHON_SIDECAR_STOP_GRACE_MS * 2)
    child.once('exit', finish)
    child.kill()
  })
}
