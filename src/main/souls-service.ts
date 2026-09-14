import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { SoulPromptResult, SpecialistActionId } from '../shared/electron-api'
import { getManagedPython, managedPythonSpawnEnv, type ResolvedPython } from './managed-runtime'
import { readStudioEnv } from '../shared/studio-env'

type SoulsCliResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string }

function findRepositoryRoot(): string {
  const explicit = readStudioEnv('SPRINTENGINE_SOULS_REPO_ROOT')
  if (explicit) return resolve(explicit)
  const starts = [
    process.cwd(),
    __dirname,
    process.resourcesPath,
    process.env['APPDIR'],
  ].filter(Boolean) as string[]
  for (const start of starts) {
    let current = resolve(start)
    for (;;) {
      if (existsSync(join(current, 'souls', '__main__.py')) || existsSync(join(current, 'scripts', 'souls'))) {
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

async function runSoulsCli(args: string[]): Promise<SoulsCliResult> {
  const repoRoot = findRepositoryRoot()
  const resolvedPython = findPythonExecutable(repoRoot)
  const python = resolvedPython.command
  const existingPythonPath = process.env['PYTHONPATH']
  const pathSeparator = process.platform === 'win32' ? ';' : ':'

  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(python, ['-m', 'souls', ...args], {
        cwd: repoRoot,
        env: managedPythonSpawnEnv({
          ...process.env,
          PYTHONPATH: existingPythonPath ? `${repoRoot}${pathSeparator}${existingPythonPath}` : repoRoot,
        }, resolvedPython.source),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({
        ok: false,
        message: error instanceof Error
          ? `Souls CLI unavailable: failed to spawn '${python}': ${error.message}`
          : `Souls CLI unavailable: failed to spawn '${python}'.`,
      })
      return
    }
    if (!child.stdout || !child.stderr) {
      resolvePromise({
        ok: false,
        message: `Souls CLI unavailable: '${python}' was spawned without pipe streams.`,
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
      resolvePromise({ ok: false, message: `Souls CLI unavailable: ${error.message}` })
    })
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        try {
          const parsed = JSON.parse(stdout.trim() || '{}') as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            resolvePromise({ ok: false, message: 'Souls CLI returned invalid JSON output.' })
            return
          }
          resolvePromise({ ok: true, payload: parsed as Record<string, unknown> })
        } catch {
          resolvePromise({ ok: false, message: 'Souls CLI returned invalid JSON output.' })
        }
        return
      }

      const stderrTrimmed = stderr.trim()
      try {
        const parsed = JSON.parse(stderrTrimmed || stdout.trim() || '{}') as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const payload = parsed as Record<string, unknown>
          const message = typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Souls CLI exited with code ${exitCode}.`
          resolvePromise({ ok: false, message })
          return
        }
      } catch {
        // Fall through to raw stderr/stdout messaging below.
      }
      resolvePromise({
        ok: false,
        message: stderrTrimmed || stdout.trim() || `Souls CLI exited with code ${exitCode}.`,
      })
    })
  })
}

export async function readSpecialistSoul(specialistId: SpecialistActionId): Promise<SoulPromptResult> {
  // A specialist id is its registry role id, so it is used directly as the role.
  // The registry resolves any declared alias (e.g. `qa-test` -> `tester`) and
  // `souls get` reports a clean error if the role does not resolve.
  const role = specialistId
  if (!role) {
    return {
      ok: false,
      message: `Unknown Soul: ${specialistId}`,
      path: null,
    }
  }

  const result = await runSoulsCli(['get', role, '--format', 'json'])
  if (!result.ok) {
    return { ok: false, message: result.message, path: null }
  }

  const payload = result.payload
  const content = payload.content
  const path = payload.path
  if (typeof content !== 'string' || typeof path !== 'string') {
    return {
      ok: false,
      message: `Souls registry returned unexpected payload for '${role}'.`,
      path: null,
    }
  }

  return { ok: true, prompt: content, path }
}
