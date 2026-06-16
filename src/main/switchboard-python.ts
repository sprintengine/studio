import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { getManagedPython, managedPythonSpawnEnv, type ResolvedPython } from './managed-runtime'

export type SwitchboardPythonCommandResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | null }

const inFlightPythonChildren = new Set<ChildProcess>()

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

function findPythonExecutable(repoRoot: string): ResolvedPython {
  // Bundled CPython first, then the repo's own `.venv` (dev), then system Python.
  return getManagedPython(repoRoot)
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

export async function runSwitchboardPythonJsonCommand(args: string[]): Promise<SwitchboardPythonCommandResult> {
  const repoRoot = findRepositoryRoot()
  const resolvedPython = findPythonExecutable(repoRoot)
  const python = resolvedPython.command

  return new Promise((resolvePromise) => {
    const existingPythonPath = process.env['PYTHONPATH']
    let child: ChildProcess
    try {
      child = spawn(python, ['-m', 'switchboard_core', ...args], {
        cwd: repoRoot,
        env: managedPythonSpawnEnv({
          ...process.env,
          PYTHONPATH: existingPythonPath ? `${repoRoot}${process.platform === 'win32' ? ';' : ':'}${existingPythonPath}` : repoRoot,
        }, resolvedPython.source),
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
      inFlightPythonChildren.delete(child)
      child.kill()
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

export async function shutdownSwitchboardPythonCommands(): Promise<void> {
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
