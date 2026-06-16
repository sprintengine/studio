import { app } from 'electron'
import { existsSync } from 'fs'
import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { MultiloopInitInput, MultiloopInitResult } from '../shared/electron-api'
import { isMissingPathError } from './filesystem-workspace'
import { getManagedPython, managedPythonSpawnEnv, type ResolvedPython } from './managed-runtime'

function getBundledMultiloopToolPath(): string | null {
  if (app.isPackaged) {
    const packagedToolPath = join(process.resourcesPath, 'scripts', 'multiloop_tool.py')
    return existsSync(packagedToolPath) ? packagedToolPath : null
  }

  const candidates = [
    join(process.cwd(), 'scripts', 'multiloop_tool.py'),
    join(app.getAppPath(), 'scripts', 'multiloop_tool.py'),
    join(__dirname, '..', '..', 'scripts', 'multiloop_tool.py'),
    join(__dirname, '..', '..', '..', 'scripts', 'multiloop_tool.py'),
  ]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function getMultiloopPythonExecutable(toolPath: string): ResolvedPython {
  // Bundled CPython first, then the tool's repo `.venv` (dev), then system.
  const repoRoot = dirname(dirname(toolPath))
  return getManagedPython(repoRoot)
}

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function installMultiloopWorkspaceCli(workspaceRoot: string): Promise<void> {
  const toolPath = getBundledMultiloopToolPath()
  if (!toolPath) {
    throw new Error('Multiloop Python tool is unavailable: scripts/multiloop_tool.py was not found.')
  }

  const toolRoot = dirname(dirname(toolPath))
  const pythonExecutable = getMultiloopPythonExecutable(toolPath).command
  const scriptDirectory = join(workspaceRoot, 'scripts')
  await mkdir(scriptDirectory, { recursive: true })

  const shellWrapper = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `export PYTHONPATH=${quoteSh(toolRoot)}:\${PYTHONPATH:-}`,
    `exec ${quoteSh(pythonExecutable)} ${quoteSh(toolPath)} "$@"`,
    '',
  ].join('\n')
  const shellPath = join(scriptDirectory, 'multiloop')
  await writeFile(shellPath, shellWrapper, 'utf8')
  await chmod(shellPath, 0o755).catch(() => {})

  const cmdWrapper = [
    '@echo off',
    `set "PYTHONPATH=${toolRoot};%PYTHONPATH%"`,
    `"${pythonExecutable}" "${toolPath}" %*`,
    '',
  ].join('\r\n')
  await writeFile(join(scriptDirectory, 'multiloop.cmd'), cmdWrapper, 'utf8')
}

function slugifyMultiloopName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) {
    throw new Error('Loop name must contain at least one letter or digit.')
  }
  return slug
}

async function resolveMultiloopWorkspaceRoot(input: unknown): Promise<string> {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Workspace root is required.')
  }

  const rawWorkspaceRoot = input.trim()
  if (!isAbsolute(rawWorkspaceRoot)) {
    throw new Error('Workspace root must be an absolute path.')
  }

  const workspaceRoot = resolve(rawWorkspaceRoot)
  let workspaceStats
  try {
    workspaceStats = await stat(workspaceRoot)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error('Workspace root must be an existing directory.')
    }
    throw error
  }
  if (!workspaceStats.isDirectory()) {
    throw new Error('Workspace root must be an existing directory.')
  }

  return realpath(workspaceRoot)
}

function readRequiredMultiloopText(input: unknown, label: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`${label} is required.`)
  }
  return input.trim()
}

async function readExistingMultiloopState(
  statePath: string,
  loopName: string,
  loopSlug: string,
  finalGoal: string
): Promise<{ exists: false } | { exists: true; conflicting: false } | { exists: true; conflicting: true; message: string }> {
  try {
    const stateContent = await readFile(statePath, 'utf8')
    const state = JSON.parse(stateContent) as unknown
    if (!state || typeof state !== 'object' || !('loop' in state)) {
      return { exists: true, conflicting: true, message: 'Existing Multiloop state file is not valid.' }
    }

    const loop = (state as { loop?: unknown }).loop
    if (!loop || typeof loop !== 'object') {
      return { exists: true, conflicting: true, message: 'Existing Multiloop state file has no loop metadata.' }
    }

    const record = loop as Record<string, unknown>
    if (record.name !== loopSlug || record.displayName !== loopName) {
      return { exists: true, conflicting: true, message: 'A different Multiloop state already exists for this loop path.' }
    }
    if (record.finalGoal !== finalGoal) {
      return { exists: true, conflicting: true, message: 'A Multiloop state already exists with a different final goal.' }
    }

    return { exists: true, conflicting: false }
  } catch (error) {
    if (isMissingPathError(error)) return { exists: false }
    if (error instanceof SyntaxError) {
      return { exists: true, conflicting: true, message: 'Existing Multiloop state file is not valid JSON.' }
    }
    throw error
  }
}

function runMultiloopInitTool(
  workspaceRoot: string,
  statePath: string,
  loopName: string,
  finalGoal: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const toolPath = getBundledMultiloopToolPath()
    if (!toolPath) {
      resolvePromise({
        exitCode: 127,
        stdout: '',
        stderr: 'Multiloop Python tool is unavailable: scripts/multiloop_tool.py was not found.',
      })
      return
    }

    const repoRoot = dirname(dirname(toolPath))
    const resolvedPython = getMultiloopPythonExecutable(toolPath)
    const child = spawn(
      resolvedPython.command,
      [toolPath, '--state', statePath, 'init', '--name', loopName, '--final-goal', finalGoal],
      {
        cwd: workspaceRoot,
        env: managedPythonSpawnEnv({
          ...process.env,
          PYTHONPATH: [repoRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
        }, resolvedPython.source),
        windowsHide: true,
      }
    )
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      resolvePromise({
        exitCode: null,
        stdout,
        stderr: stderr || `Multiloop Python tool could not start: ${error.message}`,
      })
    })
    child.on('close', (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr })
    })
  })
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(targetPath))
  return (
    relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath) && !relativePath.split(sep).includes('..'))
  )
}

export async function initializeMultiloopState(payload: MultiloopInitInput): Promise<MultiloopInitResult> {
  try {
    const loopName = readRequiredMultiloopText(payload?.loopName, 'Loop name')
    const finalGoal = readRequiredMultiloopText(payload?.finalGoal, 'Final goal')
    const loopSlug = slugifyMultiloopName(loopName)
    const workspaceRoot = await resolveMultiloopWorkspaceRoot(payload?.workspaceRoot)
    const loopDirectory = resolve(workspaceRoot, 'multiloop', loopSlug)
    const statePath = resolve(loopDirectory, 'state.json')

    if (!isPathInsideOrEqual(workspaceRoot, statePath) || basename(dirname(loopDirectory)) !== 'multiloop') {
      throw new Error('Multiloop state path must stay inside multiloop/<loop>/state.json.')
    }

    const existing = await readExistingMultiloopState(statePath, loopName, loopSlug, finalGoal)
    if (existing.exists) {
      if (existing.conflicting) {
        return { ok: false, message: existing.message }
      }
      await installMultiloopWorkspaceCli(workspaceRoot)
      return {
        ok: true,
        data: { workspaceRoot, loopName, loopSlug, loopDirectory, statePath, created: false },
      }
    }

    const completed = await runMultiloopInitTool(workspaceRoot, statePath, loopName, finalGoal)
    if (completed.exitCode !== 0) {
      return {
        ok: false,
        message: completed.stderr.trim() || completed.stdout.trim() || 'Multiloop initialization failed.',
        stdout: completed.stdout,
        stderr: completed.stderr,
        exitCode: completed.exitCode ?? 'spawn-error',
      }
    }

    const created = await readExistingMultiloopState(statePath, loopName, loopSlug, finalGoal)
    if (!created.exists || created.conflicting) {
      return {
        ok: false,
        message: created.exists && created.conflicting
          ? created.message
          : 'Multiloop initialization did not create state.json.',
        stdout: completed.stdout,
        stderr: completed.stderr,
        exitCode: completed.exitCode ?? undefined,
      }
    }

    await installMultiloopWorkspaceCli(workspaceRoot)

    return {
      ok: true,
      data: { workspaceRoot, loopName, loopSlug, loopDirectory, statePath, created: true },
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
