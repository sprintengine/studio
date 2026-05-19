import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { MultiloopRole, SoulPromptResult, SpecialistActionId } from '../shared/electron-api'

const specialistSoulRoles: Record<SpecialistActionId, string> = {
  architect: 'architect',
  'product-strategist': 'product',
  developer: 'developer',
  'devops-infra': 'devops',
  performance: 'performance',
  'blog-writer': 'blog_writer',
  'frontend-design-review': 'frontend',
  'qa-test': 'tester',
  'security-review': 'security',
  'code-review': 'code_reviewer',
  'spec-review': 'spec_reviewer',
}

type SoulsCliResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string }

function findRepositoryRoot(): string {
  const explicit = process.env['MULTICODE_SOULS_REPO_ROOT']
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

function findPythonExecutable(repoRoot: string): string {
  const posixVenv = join(repoRoot, '.venv', 'bin', 'python')
  if (existsSync(posixVenv)) return posixVenv
  const windowsVenv = join(repoRoot, '.venv', 'Scripts', 'python.exe')
  if (existsSync(windowsVenv)) return windowsVenv
  return process.platform === 'win32' ? 'python' : 'python3'
}

async function runSoulsCli(args: string[]): Promise<SoulsCliResult> {
  const repoRoot = findRepositoryRoot()
  const python = findPythonExecutable(repoRoot)
  const existingPythonPath = process.env['PYTHONPATH']
  const pathSeparator = process.platform === 'win32' ? ';' : ':'

  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(python, ['-m', 'souls', ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PYTHONPATH: existingPythonPath ? `${repoRoot}${pathSeparator}${existingPythonPath}` : repoRoot,
        },
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
  const role = specialistSoulRoles[specialistId]
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

export async function readMultiloopPrompt(role: MultiloopRole): Promise<SoulPromptResult> {
  return {
    ok: true,
    prompt: buildMultiloopPromptFetchInstruction(role),
    path: 'multiloop_core/prompts.py',
  }
}

function buildMultiloopPromptFetchInstruction(role: MultiloopRole): string {
  if (role === 'coordinator') {
    return [
      'Fetch your current Multiloop coordinator prompt from the Multiloop CLI before doing role-specific work.',
      '',
      'Run:',
      '',
      '```bash',
      'scripts/multiloop --state <state-path> milestone plan-next',
      '```',
      '',
      'Treat the returned text as the active Multiloop coordination prompt.',
    ].join('\n')
  }

  return [
    'Fetch your current Multiloop role prompt from the Multiloop CLI before doing role-specific work.',
    '',
    'Run:',
    '',
    '```bash',
    `scripts/multiloop --state <state-path> milestone review --role ${role}`,
    '```',
    '',
    'Treat the returned text as read-only Multiloop milestone context and follow the linked Sprint Engine task instructions for execution.',
  ].join('\n')
}
