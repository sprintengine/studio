import { app } from 'electron'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import type { LaunchContribution, LaunchContributionRequest } from '../../shared/modules/launch-contributions'
import { getManagedPython } from '../managed-runtime'
import { getPluginSprintEngineRegistryRoots } from '../plugin-registry-instance'

/**
 * The Sprint Engine module's launch contribution: env, PATH shims (including
 * `souls` until MC-2512 deletes that CLI), the `sprintengine()` / `souls()`
 * shell functions, and a managed-session tag when the launch carries a run
 * state path.
 *
 * This is the body that used to live in `withSprintEngineEnv` /
 * `buildSprintEngineShellBootstrap`. Core no longer names these env vars.
 */
export function createSprintEngineLaunchContribution(): LaunchContribution {
  return (launch) => contributeSprintEngineLaunch(launch)
}

export function contributeSprintEngineLaunch(launch: LaunchContributionRequest) {
  const cwd = launch.workspaceRoot
  const bundledToolPath = getBundledSprintEngineToolPath()
  const soulsRoot = getBundledSoulsRoot()
  const registryRootsEnv = sprintEngineRegistryRootsEnvValue()
  const managedPython = getManagedPython(cwd)
  const managedPythonEnv: Record<string, string> =
    managedPython.source === 'bundled' || managedPython.source === 'override'
      ? { SPRINTENGINE_PYTHON: managedPython.command }
      : {}

  const env: Record<string, string> = {
    SPRINTENGINE_REPO_TOOL_PATH: join(cwd, '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
    SPRINTENGINE_REPO_WRAPPER_PATH: join(cwd, 'scripts', 'sprintengine_tool.py'),
    ...managedPythonEnv,
    ...(bundledToolPath ? { SPRINTENGINE_TOOL_PATH: bundledToolPath } : {}),
    ...(soulsRoot ? { SPRINTENGINE_SOULS_ROOT: soulsRoot } : {}),
    ...(registryRootsEnv ? { SPRINTENGINE_REGISTRY_ROOTS: registryRootsEnv } : {}),
    ...(launch.statePath ? { SPRINTENGINE_STATE_PATH: launch.statePath } : {}),
    ...(launch.knowledgeRoot
      ? { SPRINTENGINE_KNOWLEDGE_ROOT: launch.knowledgeRoot, SPRINTENGINE_MEMORY_ROOT: launch.knowledgeRoot }
      : {}),
  }

  const shimDirectory =
    launch.pathStyle === 'windows' ? ensureWindowsSprintEngineShimDirectory() : ensurePosixToolShimDirectory()
  const pathEntries = shimDirectory ? [shimDirectory] : []

  return {
    env,
    pathEntries,
    shellFunctions: buildSprintEngineShellFunctions(launch, {
      bundledToolPath,
      soulsRoot,
      registryRootsEnv,
      posixShimDirectory: launch.pathStyle === 'windows' ? null : shimDirectory,
    }),
    identityKeys: ['SPRINTENGINE_REGISTRY_ROOTS'],
    session: {
      managed: Boolean(launch.statePath),
    },
  }
}

function sprintEngineRegistryRootsEnvValue(): string | null {
  const roots = getPluginSprintEngineRegistryRoots()
  return roots.length ? JSON.stringify(roots) : null
}

function getBundledSprintEngineToolPath(): string | null {
  if (app.isPackaged) {
    const packagedToolPath = join(process.resourcesPath, 'scripts', 'sprintengine_tool.py')
    return existsSync(packagedToolPath) ? packagedToolPath : null
  }

  const candidates = [
    join(process.cwd(), 'scripts', 'sprintengine_tool.py'),
    join(process.cwd(), '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
    join(app.getAppPath(), 'scripts', 'sprintengine_tool.py'),
    join(app.getAppPath(), '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
    join(__dirname, '..', '..', 'scripts', 'sprintengine_tool.py'),
    join(__dirname, '..', '..', '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
    join(__dirname, '..', '..', '..', 'scripts', 'sprintengine_tool.py'),
    join(__dirname, '..', '..', '..', '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
  ]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function getBundledSoulsRoot(): string | null {
  const candidates = app.isPackaged
    ? [process.resourcesPath, app.getAppPath()]
    : [
        process.cwd(),
        app.getAppPath(),
        join(__dirname, '..', '..'),
        join(__dirname, '..', '..', '..'),
      ]

  return candidates.find((candidate) => existsSync(join(candidate, 'souls', '__main__.py'))) ?? null
}

function ensurePosixToolShimDirectory(): string | null {
  try {
    const shimDirectory = join(app.getPath('userData'), 'tool-bin')
    const sprintEngineShimPath = join(shimDirectory, 'sprintengine')
    const soulsShimPath = join(shimDirectory, 'souls')
    mkdirSync(shimDirectory, { recursive: true })
    writeFileSync(
      sprintEngineShimPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'tool_path=""',
        'if [[ -n "${SPRINTENGINE_REPO_WRAPPER_PATH:-}" && -f "$SPRINTENGINE_REPO_WRAPPER_PATH" ]]; then tool_path="$SPRINTENGINE_REPO_WRAPPER_PATH";',
        'elif [[ -n "${SPRINTENGINE_REPO_TOOL_PATH:-}" && -f "$SPRINTENGINE_REPO_TOOL_PATH" ]]; then tool_path="$SPRINTENGINE_REPO_TOOL_PATH";',
        'elif [[ -n "${SPRINTENGINE_TOOL_PATH:-}" && -f "$SPRINTENGINE_TOOL_PATH" ]]; then tool_path="$SPRINTENGINE_TOOL_PATH";',
        'elif [[ -n "${MULTICODE_SPRINTENGINE_TOOL_PATH:-}" && -f "$MULTICODE_SPRINTENGINE_TOOL_PATH" ]]; then tool_path="$MULTICODE_SPRINTENGINE_TOOL_PATH";',
        'else echo "Sprint Engine tool not found" >&2; exit 127; fi',
        'python_exe="python3"',
        'if [[ -n "${SPRINTENGINE_PYTHON:-}" && -x "$SPRINTENGINE_PYTHON" ]]; then python_exe="$SPRINTENGINE_PYTHON";',
        'elif [[ -n "${MULTICODE_PYTHON:-}" && -x "$MULTICODE_PYTHON" ]]; then python_exe="$MULTICODE_PYTHON";',
        'elif [[ -x "$PWD/.venv/bin/python" ]]; then python_exe="$PWD/.venv/bin/python";',
        'elif [[ -x "$PWD/.venv/Scripts/python.exe" ]]; then python_exe="$PWD/.venv/Scripts/python.exe"; fi',
        'exec "$python_exe" "$tool_path" "$@"',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 }
    )
    chmodSync(sprintEngineShimPath, 0o755)
    writeFileSync(
      soulsShimPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'python_exe="python3"',
        'if [[ -n "${SPRINTENGINE_PYTHON:-}" && -x "$SPRINTENGINE_PYTHON" ]]; then python_exe="$SPRINTENGINE_PYTHON";',
        'elif [[ -n "${MULTICODE_PYTHON:-}" && -x "$MULTICODE_PYTHON" ]]; then python_exe="$MULTICODE_PYTHON";',
        'elif [[ -x "$PWD/.venv/bin/python" ]]; then python_exe="$PWD/.venv/bin/python";',
        'elif [[ -x "$PWD/.venv/Scripts/python.exe" ]]; then python_exe="$PWD/.venv/Scripts/python.exe"; fi',
        'if [[ -n "${SPRINTENGINE_SOULS_ROOT:-}" ]]; then',
        '  export PYTHONPATH="$SPRINTENGINE_SOULS_ROOT:${PYTHONPATH:-}"',
        'fi',
        'exec "$python_exe" -m souls "$@"',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 }
    )
    chmodSync(soulsShimPath, 0o755)
    return shimDirectory
  } catch {
    return null
  }
}

function ensureWindowsSprintEngineShimDirectory(): string | null {
  if (process.platform !== 'win32') return null

  try {
    const shimDirectory = join(app.getPath('userData'), 'sprintengine-bin')
    const shimPath = join(shimDirectory, 'sprintengine.cmd')
    const soulsShimPath = join(shimDirectory, 'souls.cmd')
    mkdirSync(shimDirectory, { recursive: true })
    writeFileSync(
      shimPath,
      [
        '@echo off',
        'setlocal',
        'set "TOOL=%SPRINTENGINE_REPO_WRAPPER_PATH%"',
        'if exist "%TOOL%" goto run',
        'set "TOOL=%SPRINTENGINE_REPO_TOOL_PATH%"',
        'if exist "%TOOL%" goto run',
        'set "TOOL=%SPRINTENGINE_TOOL_PATH%"',
        'if exist "%TOOL%" goto run',
        'echo Sprint Engine tool not found 1>&2',
        'exit /b 127',
        ':run',
        'set "PYTHON_EXE="',
        'if defined SPRINTENGINE_PYTHON if exist "%SPRINTENGINE_PYTHON%" set "PYTHON_EXE=%SPRINTENGINE_PYTHON%"',
        'if not defined SPRINTENGINE_PYTHON if defined MULTICODE_PYTHON if exist "%MULTICODE_PYTHON%" set "PYTHON_EXE=%MULTICODE_PYTHON%"',
        'if defined PYTHON_EXE goto run_python',
        'if exist ".venv\\Scripts\\python.exe" set "PYTHON_EXE=.venv\\Scripts\\python.exe"',
        'if defined PYTHON_EXE goto run_python',
        'if "%SPRINTENGINE_REPO_WRAPPER_PATH%"=="" goto global_python',
        'for %%I in ("%SPRINTENGINE_REPO_WRAPPER_PATH%") do set "WRAPPER_DIR=%%~dpI"',
        'if exist "%WRAPPER_DIR%..\\.venv\\Scripts\\python.exe" set "PYTHON_EXE=%WRAPPER_DIR%..\\.venv\\Scripts\\python.exe"',
        'if defined PYTHON_EXE goto run_python',
        ':global_python',
        'for /f "delims=" %%P in (\'where python 2^>nul\') do if not defined PYTHON_EXE if /I not "%%~dpP"=="%LOCALAPPDATA%\\Microsoft\\WindowsApps\\" set "PYTHON_EXE=%%P"',
        'if defined PYTHON_EXE goto run_python',
        'echo python not found; expected repo venv at .venv\\Scripts\\python.exe 1>&2',
        'exit /b 127',
        ':run_python',
        '"%PYTHON_EXE%" "%TOOL%" %*',
        'exit /b %errorlevel%',
        '',
      ].join('\r\n'),
      'utf8'
    )
    writeFileSync(
      soulsShimPath,
      [
        '@echo off',
        'setlocal',
        'set "PYTHON_EXE="',
        'if defined SPRINTENGINE_PYTHON if exist "%SPRINTENGINE_PYTHON%" set "PYTHON_EXE=%SPRINTENGINE_PYTHON%"',
        'if not defined SPRINTENGINE_PYTHON if defined MULTICODE_PYTHON if exist "%MULTICODE_PYTHON%" set "PYTHON_EXE=%MULTICODE_PYTHON%"',
        'if defined PYTHON_EXE goto run_python',
        'if exist ".venv\\Scripts\\python.exe" set "PYTHON_EXE=.venv\\Scripts\\python.exe"',
        'if defined PYTHON_EXE goto run_python',
        'for /f "delims=" %%P in (\'where python 2^>nul\') do if not defined PYTHON_EXE if /I not "%%~dpP"=="%LOCALAPPDATA%\\Microsoft\\WindowsApps\\" set "PYTHON_EXE=%%P"',
        'if defined PYTHON_EXE goto run_python',
        'echo python not found; expected repo venv at .venv\\Scripts\\python.exe 1>&2',
        'exit /b 127',
        ':run_python',
        'if not "%SPRINTENGINE_SOULS_ROOT%"=="" set "PYTHONPATH=%SPRINTENGINE_SOULS_ROOT%;%PYTHONPATH%"',
        '"%PYTHON_EXE%" -m souls %*',
        'exit /b %errorlevel%',
        '',
      ].join('\r\n'),
      'utf8'
    )
    return shimDirectory
  } catch {
    return null
  }
}

function buildSprintEngineShellFunctions(
  launch: LaunchContributionRequest,
  input: {
    bundledToolPath: string | null
    soulsRoot: string | null
    registryRootsEnv: string | null
    posixShimDirectory: string | null
  }
): string[] {
  if (launch.pathStyle === 'windows') return []

  const convert = (value: string) => (launch.pathStyle === 'wsl' ? toWslPath(value) : value)
  const shellStatePath = launch.statePath ? convert(launch.statePath) : undefined
  const shellMemoryRootPath = launch.knowledgeRoot ? convert(launch.knowledgeRoot) : undefined
  const shellBundledToolPath = input.bundledToolPath ? convert(input.bundledToolPath) : null
  const shellSoulsRoot = input.soulsRoot ? convert(input.soulsRoot) : null
  const shellPosixShimDirectory = input.posixShimDirectory ? convert(input.posixShimDirectory) : null

  const lines = [
    'export SPRINTENGINE_REPO_TOOL_PATH="$PWD/.agents/skills/sprintengine/scripts/sprintengine_tool.py"',
    'export SPRINTENGINE_REPO_WRAPPER_PATH="$PWD/scripts/sprintengine_tool.py"',
  ]

  if (shellPosixShimDirectory) {
    lines.push(`export PATH=${quotePosix(shellPosixShimDirectory)}":$PATH"`)
  }

  if (shellStatePath) {
    lines.push(`export SPRINTENGINE_STATE_PATH=${quotePosix(shellStatePath)}`)
  }

  if (shellMemoryRootPath) {
    lines.push(`export SPRINTENGINE_KNOWLEDGE_ROOT=${quotePosix(shellMemoryRootPath)}`)
    lines.push(`export SPRINTENGINE_MEMORY_ROOT=${quotePosix(shellMemoryRootPath)}`)
  }

  if (shellBundledToolPath) {
    lines.push(`export SPRINTENGINE_TOOL_PATH=${quotePosix(shellBundledToolPath)}`)
  }

  if (shellSoulsRoot) {
    lines.push(`export SPRINTENGINE_SOULS_ROOT=${quotePosix(shellSoulsRoot)}`)
  }

  if (input.registryRootsEnv) {
    lines.push(`export SPRINTENGINE_REGISTRY_ROOTS=${quotePosix(input.registryRootsEnv)}`)
  }

  lines.push(
    [
      'sprintengine() {',
      'local tool_path="";',
      'if [ -f "$SPRINTENGINE_REPO_WRAPPER_PATH" ]; then tool_path="$SPRINTENGINE_REPO_WRAPPER_PATH";',
      'elif [ -f "$SPRINTENGINE_REPO_TOOL_PATH" ]; then tool_path="$SPRINTENGINE_REPO_TOOL_PATH";',
      'elif [ -n "${SPRINTENGINE_TOOL_PATH:-}" ] && [ -f "$SPRINTENGINE_TOOL_PATH" ]; then tool_path="$SPRINTENGINE_TOOL_PATH";',
      'elif [ -n "${MULTICODE_SPRINTENGINE_TOOL_PATH:-}" ] && [ -f "$MULTICODE_SPRINTENGINE_TOOL_PATH" ]; then tool_path="$MULTICODE_SPRINTENGINE_TOOL_PATH";',
      'else echo "Sprint Engine tool not found" >&2; return 127; fi;',
      'local python_exe="python3";',
      'if [ -n "${SPRINTENGINE_PYTHON:-}" ] && [ -x "$SPRINTENGINE_PYTHON" ]; then python_exe="$SPRINTENGINE_PYTHON";',
      'elif [ -n "${MULTICODE_PYTHON:-}" ] && [ -x "$MULTICODE_PYTHON" ]; then python_exe="$MULTICODE_PYTHON";',
      'elif [ -x "$PWD/.venv/bin/python" ]; then python_exe="$PWD/.venv/bin/python";',
      'elif [ -x "$PWD/.venv/Scripts/python.exe" ]; then python_exe="$PWD/.venv/Scripts/python.exe"; fi;',
      '"$python_exe" "$tool_path" "$@";',
      '}',
    ].join(' '),
    'export -f sprintengine >/dev/null 2>&1 || true',
    [
      'souls() {',
      'local python_exe="python3";',
      'if [ -n "${SPRINTENGINE_PYTHON:-}" ] && [ -x "$SPRINTENGINE_PYTHON" ]; then python_exe="$SPRINTENGINE_PYTHON";',
      'elif [ -n "${MULTICODE_PYTHON:-}" ] && [ -x "$MULTICODE_PYTHON" ]; then python_exe="$MULTICODE_PYTHON";',
      'elif [ -x "$PWD/.venv/bin/python" ]; then python_exe="$PWD/.venv/bin/python";',
      'elif [ -x "$PWD/.venv/Scripts/python.exe" ]; then python_exe="$PWD/.venv/Scripts/python.exe"; fi;',
      'if [ -n "${SPRINTENGINE_SOULS_ROOT:-}" ]; then PYTHONPATH="$SPRINTENGINE_SOULS_ROOT:${PYTHONPATH:-}" "$python_exe" -m souls "$@";',
      'else "$python_exe" -m souls "$@"; fi;',
      '}',
    ].join(' '),
    'export -f souls >/dev/null 2>&1 || true',
  )

  return [lines.join('; ')]
}

function toWslPath(dirPath: string): string {
  const normalized = dirPath.replace(/\\/g, '/')
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (!driveMatch) return normalized
  const [, drive, rest] = driveMatch
  return `/mnt/${drive.toLowerCase()}/${rest}`
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}
