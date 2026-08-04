import { app } from 'electron'
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { unlink } from 'fs/promises'
import { join } from 'path'
import type { AgentCli, CliRuntimeSettings, SprintEngineCliPermissionPreset, TerminalPathStyle } from '../shared/electron-api'
import { applyDebugDirective } from '../shared/debug-directive'
import { buildAgentShellCommand, pluginIdForCli, renderAgentLaunchArgv, renderCliLaunchEnv, resolveCliRuntimeSettings, resolveDebugSkillInvocation } from './agent-launch-render'
import { resolveAgentStateSocketPath } from './agent-state-service'
import { renderReasoningArgs } from './plugin-render'
import { getPluginById, getPluginSprintEngineRegistryRoots } from './plugin-registry-instance'
import { withMulticodeCliPath } from './cli-install'
import { getColorScheme } from './color-scheme-store'
import { ensureManagedRuntimeShims, getManagedPython, withManagedRuntimePath } from './managed-runtime'

export type ShellLaunchConfig = {
  command: string
  args: string[]
  cwd?: string
  pathStyle: TerminalPathStyle
  initialInput?: string
  env?: Record<string, string>
  startupScriptPath?: string
}

export function getTerminalEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )

  delete env.ELECTRON_RUN_AS_NODE
  env.TERM = env.TERM || 'xterm-256color'

  // Surface CLIs installed into the managed npm prefix (e.g. Codex) on PATH so
  // launched agent sessions can find them. The shims themselves stay out of the
  // user shell — they exist for our install commands, not interactive use.
  const shims = ensureManagedRuntimeShims()
  const withManagedBins = shims
    ? withManagedRuntimePath(env, shims.prefixBinDir, process.platform)
    : env

  return withMulticodeCliPath(withManagedBins)
}

// Per-agent identity exposed to the launched session so a typed handoff ("work
// on backlog/foo.md") can record the same Backlog item ↔ agent link the
// drag-drop path writes. The durable key is workspaceId + agentId (never the
// PTY/CLI session id, which is reaped or changes across relaunch); the name is
// for the link label. Only non-empty values are emitted, so a plain terminal or
// an identity-less launch adds nothing. Mirrors how `withSprintEngineEnv` places
// MULTICODE_* values directly on the session env record.
//
// Agent launches also carry THIS instance's agent-state socket address. The
// reporter hook prefers the env address over the `--socket` arg baked into the
// repo's shared `.claude/settings.local.json`, because that file is
// last-writer-wins across app instances (a second dev instance or E2E profile
// rewrites it and every other instance's agents then report phases to a dead
// socket — the 2026-07-07 parked-agents incident). Env is per-process, so an
// agent always reports to the instance that launched it.
export function agentIdentityEnv(input: {
  workspaceId?: string
  agentId?: string
  agentName?: string
}): Record<string, string> {
  const workspaceId = input.workspaceId?.trim()
  const agentId = input.agentId?.trim()
  const agentName = input.agentName?.trim()
  const agentStateSocketPath = agentId ? agentStateSocketPathForLaunch() : null
  return {
    ...(workspaceId ? { MULTICODE_WORKSPACE_ID: workspaceId } : {}),
    ...(agentId ? { MULTICODE_AGENT_ID: agentId } : {}),
    ...(agentName ? { MULTICODE_AGENT_NAME: agentName } : {}),
    ...(agentStateSocketPath ? { MULTICODE_AGENT_STATE_SOCKET: agentStateSocketPath } : {}),
  }
}

// Same resolution the agent-state service uses (deterministic from the profile
// dir), so the launch env and the live listener always agree. Lazy + guarded:
// outside a real Electron app (unit tests bundling this module) `app.getPath`
// is unavailable — identity env then simply omits the socket address.
function agentStateSocketPathForLaunch(): string | null {
  try {
    return resolveAgentStateSocketPath(app.getPath('userData'))
  } catch {
    return null
  }
}

// The identity vars `agentIdentityEnv` owns. Cleared from a base env before the
// session's own identity is applied, so a stale `MULTICODE_AGENT_ID` inherited
// by the app's own process (e.g. the app launched from inside an agent shell)
// never leaks into a plain terminal or the wrong agent.
const AGENT_IDENTITY_ENV_KEYS = ['MULTICODE_WORKSPACE_ID', 'MULTICODE_AGENT_ID', 'MULTICODE_AGENT_NAME', 'MULTICODE_AGENT_STATE_SOCKET'] as const

// Apply this session's agent identity onto a base env: strip any inherited
// identity first (no leak), then set this session's values. A non-agent launch
// passes no ids, so the result simply carries no identity.
export function applyAgentIdentityEnv(
  baseEnv: Record<string, string>,
  input: { workspaceId?: string; agentId?: string; agentName?: string }
): Record<string, string> {
  const next = { ...baseEnv }
  for (const key of AGENT_IDENTITY_ENV_KEYS) delete next[key]
  return { ...next, ...agentIdentityEnv(input) }
}

// Identity/terminal keys a CLI manifest's `launch.env` must never override.
// The agent-identity vars are owned by `applyAgentIdentityEnv` (applied at spawn
// time, so they already win); TERM/COLORTERM are the terminal's own identity.
// Listed here so the provider-env merge refuses to clobber them even if a
// manifest declared one. The set is the boundary between what the app knows
// about a session and what a manifest may configure: a manifest describes its
// PROVIDER, and every key in here is a fact about the pane or about which agent
// this is — neither of which a manifest is in a position to restate.
const PROTECTED_LAUNCH_ENV_KEYS = new Set<string>([
  ...AGENT_IDENTITY_ENV_KEYS,
  'TERM',
  'COLORTERM',
])

// True when the provider env redirects the Anthropic endpoint (a different
// base URL, or our own auth token). On a redirect, an inherited ANTHROPIC_API_KEY
// belongs to the DEFAULT Anthropic endpoint — NOT the redirect target — so it
// must never travel: leaving it set would transmit the user's real Anthropic key
// to the third-party endpoint (e.g. api.z.ai) on the auth header. This is the
// critical case to cover even when no token is configured (endpoint redirected,
// key inherited): the launch should fail closed (401), not leak the key.
function redirectsAnthropicEndpoint(providerEnv: Record<string, string>): boolean {
  return Boolean(providerEnv.ANTHROPIC_BASE_URL || providerEnv.ANTHROPIC_AUTH_TOKEN)
}

// Merge a CLI manifest's rendered `launch.env` onto a base session env. The
// provider env wins on collision (it is the whole point — e.g. pointing
// ANTHROPIC_BASE_URL at Z.AI) except for the protected identity keys above.
// No-op (returns the base unchanged) for the common case of a manifest with no
// `launch.env`.
export function mergeProviderLaunchEnv(
  base: Record<string, string>,
  providerEnv: Record<string, string> | undefined
): Record<string, string> {
  if (!providerEnv || Object.keys(providerEnv).length === 0) return base
  const next = { ...base }
  if (redirectsAnthropicEndpoint(providerEnv)) {
    delete next.ANTHROPIC_API_KEY
  }
  for (const [key, value] of Object.entries(providerEnv)) {
    if (PROTECTED_LAUNCH_ENV_KEYS.has(key)) continue
    next[key] = value
  }
  return next
}

// JSON for the dynamic plugin registry roots the souls CLI should also search
// (consumed by souls/registry.py via MULTICODE_SPRINTENGINE_REGISTRY_ROOTS).
// Mirrors the plugin roots the spawn menu discovers through
// sprintEngineRegistryRootsForRead(), so `souls get` resolves the same
// plugin-contributed specialists the menu offered. The canonical user-install
// root is discovered natively by the souls CLI, so it is intentionally omitted
// here. Returns null when no plugin roots are present.
function sprintEngineRegistryRootsEnvValue(): string | null {
  const roots = getPluginSprintEngineRegistryRoots()
  return roots.length ? JSON.stringify(roots) : null
}

function withSprintEngineEnv(
  env: Record<string, string>,
  cwd: string,
  sprintEngineStatePath?: string,
  memoryRootPath?: string,
  memoryRelativeRoot?: string,
  managedMcpEnv?: Record<string, string>
): Record<string, string> {
  const bundledToolPath = getBundledSprintEngineToolPath()
  const soulsRoot = getBundledSoulsRoot()
  const registryRootsEnv = sprintEngineRegistryRootsEnvValue()
  // Expose the bundled CPython to the tool shims, but only when we actually have
  // a managed interpreter (bundled runtime or operator override). When we'd fall
  // back to a repo `.venv` or system Python, leave MULTICODE_PYTHON unset so the
  // shims keep their existing dev-friendly `$PWD/.venv → python3` behavior.
  const managedPython = getManagedPython(cwd)
  const managedPythonEnv: Record<string, string> =
    managedPython.source === 'bundled' || managedPython.source === 'override'
      ? { MULTICODE_PYTHON: managedPython.command }
      : {}
  const nextEnv = {
    ...env,
    SPRINTENGINE_REPO_TOOL_PATH: join(cwd, '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
    SPRINTENGINE_REPO_WRAPPER_PATH: join(cwd, 'scripts', 'sprintengine_tool.py'),
    ...managedPythonEnv,
    ...(bundledToolPath ? { MULTICODE_SPRINTENGINE_TOOL_PATH: bundledToolPath } : {}),
    ...(soulsRoot ? { MULTICODE_SOULS_ROOT: soulsRoot } : {}),
    ...(registryRootsEnv ? { MULTICODE_SPRINTENGINE_REGISTRY_ROOTS: registryRootsEnv } : {}),
    ...(sprintEngineStatePath ? { SPRINTENGINE_STATE_PATH: sprintEngineStatePath } : {}),
    ...(managedMcpEnv ?? {}),
    ...(memoryRootPath ? { MULTICODE_KNOWLEDGE_ROOT: memoryRootPath, MULTICODE_MEMORY_ROOT: memoryRootPath } : {}),
    ...(memoryRelativeRoot
      ? { MULTICODE_KNOWLEDGE_RELATIVE_ROOT: memoryRelativeRoot, MULTICODE_MEMORY_RELATIVE_ROOT: memoryRelativeRoot }
      : {}),
  }

  // Never let a stale registry-roots value inherited from the base env (e.g. the
  // app launched from inside an agent shell that had it set) leak into a spawn
  // that resolved none of its own — otherwise `souls get` would search another
  // session's plugin roots. Mirrors the AGENT_IDENTITY_ENV_KEYS stripping above.
  if (!registryRootsEnv) delete nextEnv.MULTICODE_SPRINTENGINE_REGISTRY_ROOTS

  if (process.platform !== 'win32') {
    const shimDirectory = ensurePosixToolShimDirectory()
    if (!shimDirectory) return nextEnv

    const pathKey = Object.keys(nextEnv).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    return {
      ...nextEnv,
      [pathKey]: `${shimDirectory}:${nextEnv[pathKey] ?? ''}`,
    }
  }

  const shimDirectory = ensureWindowsSprintEngineShimDirectory()
  if (!shimDirectory) return nextEnv

  const pathKey = Object.keys(nextEnv).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  return {
    ...nextEnv,
    [pathKey]: `${shimDirectory};${nextEnv[pathKey] ?? ''}`,
  }
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
        'elif [[ -n "${MULTICODE_SPRINTENGINE_TOOL_PATH:-}" && -f "$MULTICODE_SPRINTENGINE_TOOL_PATH" ]]; then tool_path="$MULTICODE_SPRINTENGINE_TOOL_PATH";',
        'else echo "Sprint Engine tool not found" >&2; exit 127; fi',
        'python_exe="python3"',
        'if [[ -n "${MULTICODE_PYTHON:-}" && -x "$MULTICODE_PYTHON" ]]; then python_exe="$MULTICODE_PYTHON";',
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
        'if [[ -n "${MULTICODE_PYTHON:-}" && -x "$MULTICODE_PYTHON" ]]; then python_exe="$MULTICODE_PYTHON";',
        'elif [[ -x "$PWD/.venv/bin/python" ]]; then python_exe="$PWD/.venv/bin/python";',
        'elif [[ -x "$PWD/.venv/Scripts/python.exe" ]]; then python_exe="$PWD/.venv/Scripts/python.exe"; fi',
        'if [[ -n "${MULTICODE_SOULS_ROOT:-}" ]]; then',
        '  export PYTHONPATH="$MULTICODE_SOULS_ROOT:${PYTHONPATH:-}"',
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
        'set "TOOL=%MULTICODE_SPRINTENGINE_TOOL_PATH%"',
        'if exist "%TOOL%" goto run',
        'echo Sprint Engine tool not found 1>&2',
        'exit /b 127',
        ':run',
        'set "PYTHON_EXE="',
        'if defined MULTICODE_PYTHON if exist "%MULTICODE_PYTHON%" set "PYTHON_EXE=%MULTICODE_PYTHON%"',
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
        'if defined MULTICODE_PYTHON if exist "%MULTICODE_PYTHON%" set "PYTHON_EXE=%MULTICODE_PYTHON%"',
        'if defined PYTHON_EXE goto run_python',
        'if exist ".venv\\Scripts\\python.exe" set "PYTHON_EXE=.venv\\Scripts\\python.exe"',
        'if defined PYTHON_EXE goto run_python',
        'for /f "delims=" %%P in (\'where python 2^>nul\') do if not defined PYTHON_EXE if /I not "%%~dpP"=="%LOCALAPPDATA%\\Microsoft\\WindowsApps\\" set "PYTHON_EXE=%%P"',
        'if defined PYTHON_EXE goto run_python',
        'echo python not found; expected repo venv at .venv\\Scripts\\python.exe 1>&2',
        'exit /b 127',
        ':run_python',
        'if not "%MULTICODE_SOULS_ROOT%"=="" set "PYTHONPATH=%MULTICODE_SOULS_ROOT%;%PYTHONPATH%"',
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

function toWslPath(dirPath: string): string {
  const normalized = dirPath.replace(/\\/g, '/')
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/)

  if (!driveMatch) {
    return normalized
  }

  const [, drive, rest] = driveMatch
  return `/mnt/${drive.toLowerCase()}/${rest}`
}

function toWindowsPath(dirPath: string): string {
  const normalized = dirPath.replace(/\\/g, '/')
  const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/)

  if (!wslMatch) {
    return dirPath
  }

  const [, drive, rest] = wslMatch
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search && search !== replacement ? value.split(search).join(replacement) : value
}

function normalizeInitialPromptPaths(
  initialPrompt: string | undefined,
  target: 'windows' | 'wsl',
  paths: Array<string | undefined>
): string | undefined {
  if (!initialPrompt) return initialPrompt

  let normalizedPrompt = initialPrompt
  for (const pathValue of paths) {
    if (!pathValue) continue

    const targetPath = target === 'wsl' ? toWslPath(pathValue) : toWindowsPath(pathValue)
    const candidates = Array.from(new Set([pathValue, toWindowsPath(pathValue), toWslPath(pathValue)]))
    for (const candidate of candidates) {
      normalizedPrompt = replaceAllLiteral(normalizedPrompt, candidate, targetPath)
    }
  }

  return normalizedPrompt
}

function isNativeWindowsPath(dirPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dirPath) || /^\\\\/.test(dirPath)
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function quotePosixCommand(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : quotePosix(value)
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function powerShellBase64Literal(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quotePowerShell(Buffer.from(value, 'utf8').toString('base64'))}))`
}

function nativeWindowsCodexPromptArg(value: string | undefined): string | undefined {
  return value
    ?.replace(/\r\n|\r|\n/g, '\\n')
    .replace(/"/g, '\\"')
}

function getCliPermissionArgs(
  cli: AgentCli,
  preset: SprintEngineCliPermissionPreset = 'default'
): string[] {
  if (preset === 'auto_workspace') {
    return cli === 'codex'
      ? ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']
      : ['--permission-mode', 'auto']
  }

  if (preset === 'bypass_all') {
    return cli === 'codex'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--permission-mode', 'bypassPermissions']
  }

  return []
}

function getCliRuntimeSettings(
  cli: AgentCli,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
): CliRuntimeSettings {
  // Delegates to the shared resolver so blank commands fall back to the plugin
  // manifest binary at render time.
  return resolveCliRuntimeSettings(cli, cliRuntimes)
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

function buildSprintEngineShellBootstrap(
  sprintEngineStatePath?: string,
  memoryRootPath?: string,
  memoryRelativeRoot?: string,
  managedMcpEnv?: Record<string, string>,
  providerLaunchEnv?: Record<string, string>
): string {
  const shellStatePath =
    sprintEngineStatePath && process.platform === 'win32' ? toWslPath(sprintEngineStatePath) : sprintEngineStatePath
  const shellMemoryRootPath =
    memoryRootPath && process.platform === 'win32' ? toWslPath(memoryRootPath) : memoryRootPath
  const bundledToolPath = getBundledSprintEngineToolPath()
  const soulsRoot = getBundledSoulsRoot()
  const posixShimDirectory = ensurePosixToolShimDirectory()
  const shellBundledToolPath =
    bundledToolPath && process.platform === 'win32' ? toWslPath(bundledToolPath) : bundledToolPath
  const shellSoulsRoot =
    soulsRoot && process.platform === 'win32' ? toWslPath(soulsRoot) : soulsRoot
  const shellPosixShimDirectory =
    posixShimDirectory && process.platform === 'win32' ? toWslPath(posixShimDirectory) : posixShimDirectory
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

  for (const [key, value] of Object.entries(managedMcpEnv ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      lines.push(`export ${key}=${quotePosix(value)}`)
    }
  }

  // CLI manifest `launch.env` (e.g. the Z.AI runtime's ANTHROPIC_* redirect).
  // Emitted as exports so the value is authoritative inside the login shell and
  // crosses the WSL boundary, where the Windows process env is not inherited.
  // ANTHROPIC_API_KEY is unset first on any Anthropic-endpoint redirect, matching
  // the PTY-env precedence in `mergeProviderLaunchEnv` — so an inherited real
  // Anthropic key is never sent to the redirect target.
  if (providerLaunchEnv && redirectsAnthropicEndpoint(providerLaunchEnv)) {
    lines.push('unset ANTHROPIC_API_KEY')
  }
  for (const [key, value] of Object.entries(providerLaunchEnv ?? {})) {
    if (PROTECTED_LAUNCH_ENV_KEYS.has(key)) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      lines.push(`export ${key}=${quotePosix(value)}`)
    }
  }

  if (shellMemoryRootPath) {
    lines.push(`export MULTICODE_KNOWLEDGE_ROOT=${quotePosix(shellMemoryRootPath)}`)
    lines.push(`export MULTICODE_MEMORY_ROOT=${quotePosix(shellMemoryRootPath)}`)
  }

  if (memoryRelativeRoot) {
    lines.push(`export MULTICODE_KNOWLEDGE_RELATIVE_ROOT=${quotePosix(memoryRelativeRoot)}`)
    lines.push(`export MULTICODE_MEMORY_RELATIVE_ROOT=${quotePosix(memoryRelativeRoot)}`)
  }

  if (shellBundledToolPath) {
    lines.push(`export MULTICODE_SPRINTENGINE_TOOL_PATH=${quotePosix(shellBundledToolPath)}`)
  }

  if (shellSoulsRoot) {
    lines.push(`export MULTICODE_SOULS_ROOT=${quotePosix(shellSoulsRoot)}`)
  }

  const shellRegistryRootsEnv = sprintEngineRegistryRootsEnvValue()
  if (shellRegistryRootsEnv) {
    lines.push(`export MULTICODE_SPRINTENGINE_REGISTRY_ROOTS=${quotePosix(shellRegistryRootsEnv)}`)
  }

  lines.push(
    [
      'sprintengine() {',
      'local tool_path="";',
      'if [ -f "$SPRINTENGINE_REPO_WRAPPER_PATH" ]; then tool_path="$SPRINTENGINE_REPO_WRAPPER_PATH";',
      'elif [ -f "$SPRINTENGINE_REPO_TOOL_PATH" ]; then tool_path="$SPRINTENGINE_REPO_TOOL_PATH";',
      'elif [ -n "${MULTICODE_SPRINTENGINE_TOOL_PATH:-}" ] && [ -f "$MULTICODE_SPRINTENGINE_TOOL_PATH" ]; then tool_path="$MULTICODE_SPRINTENGINE_TOOL_PATH";',
      'else echo "Sprint Engine tool not found" >&2; return 127; fi;',
      'local python_exe="python3";',
      'if [ -n "${MULTICODE_PYTHON:-}" ] && [ -x "$MULTICODE_PYTHON" ]; then python_exe="$MULTICODE_PYTHON";',
      'elif [ -x "$PWD/.venv/bin/python" ]; then python_exe="$PWD/.venv/bin/python";',
      'elif [ -x "$PWD/.venv/Scripts/python.exe" ]; then python_exe="$PWD/.venv/Scripts/python.exe"; fi;',
      '"$python_exe" "$tool_path" "$@";',
      '}',
    ].join(' '),
    'export -f sprintengine >/dev/null 2>&1 || true',
    [
      'souls() {',
      'local python_exe="python3";',
      'if [ -n "${MULTICODE_PYTHON:-}" ] && [ -x "$MULTICODE_PYTHON" ]; then python_exe="$MULTICODE_PYTHON";',
      'elif [ -x "$PWD/.venv/bin/python" ]; then python_exe="$PWD/.venv/bin/python";',
      'elif [ -x "$PWD/.venv/Scripts/python.exe" ]; then python_exe="$PWD/.venv/Scripts/python.exe"; fi;',
      'if [ -n "${MULTICODE_SOULS_ROOT:-}" ]; then PYTHONPATH="$MULTICODE_SOULS_ROOT:${PYTHONPATH:-}" "$python_exe" -m souls "$@";',
      'else "$python_exe" -m souls "$@"; fi;',
      '}',
    ].join(' '),
    'export -f souls >/dev/null 2>&1 || true',
  )

  return lines.join('; ')
}

function buildUserShellStartup(): string {
  return [
    'for profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do [ -r "$profile" ] && . "$profile" && break; done',
    '[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
    '[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"',
  ].join('; ')
}

function isLoginShell(shellName: string | undefined): boolean {
  return shellName === 'bash' || shellName === 'zsh'
}

function isExecutableFile(filePath: string | undefined): filePath is string {
  if (!filePath) return false
  try {
    const stats = statSync(filePath)
    return stats.isFile()
  } catch {
    return false
  }
}

function assertExistingDirectory(dirPath: string): void {
  try {
    if (statSync(dirPath).isDirectory()) return
  } catch {
    // Fall through to the clearer terminal-specific error below.
  }

  throw new Error(`Terminal working directory does not exist: ${dirPath}`)
}

function getPosixShellPath(): string {
  const configuredShell = process.env.SHELL?.trim()
  if (configuredShell?.startsWith('/') && isExecutableFile(configuredShell)) {
    return configuredShell
  }

  const fallbackShell = ['/bin/zsh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/bash', '/bin/sh'].find(isExecutableFile)
  return fallbackShell ?? 'sh'
}

function buildInteractiveShellExec(shellPath: string, shellName: string | undefined): string {
  const loginArg = isLoginShell(shellName) ? ' -l' : ''
  return `exec ${quotePosixCommand(shellPath)}${loginArg}`
}

function createTerminalStartupScript(
  sessionId: string,
  extension: 'sh' | 'ps1',
  content: string
): string {
  const scriptDirectory = join(app.getPath('userData'), 'terminal-startup')
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  const scriptPath = join(scriptDirectory, `${safeSessionId}-${Date.now()}.${extension}`)
  mkdirSync(scriptDirectory, { recursive: true })
  writeFileSync(scriptPath, `${content.trim()}\n`, { encoding: 'utf8', mode: 0o600 })
  return scriptPath
}

export function cleanupTerminalStartupScript(scriptPath: string | undefined): void {
  if (!scriptPath) return
  void unlink(scriptPath).catch(() => {})
}

function buildWslShellScript(
  cwd: string,
  sessionId: string,
  resume = false,
  sprintEngineStatePath?: string,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SprintEngineCliPermissionPreset = 'default',
  cliModel?: string,
  memoryRootPath?: string,
  memoryRelativeRoot?: string,
  managedMcpEnv?: Record<string, string>,
  debugMode = false,
  providerLaunchEnv?: Record<string, string>,
  cliReasoning?: string
): string {
  const shellInitialPrompt = normalizeInitialPromptPaths(initialPrompt, 'wsl', [cwd, sprintEngineStatePath, memoryRootPath])
  return [
    buildUserShellStartup(),
    `cd ${quotePosix(toWslPath(cwd))}`,
    buildSprintEngineShellBootstrap(sprintEngineStatePath, memoryRootPath, memoryRelativeRoot, managedMcpEnv, providerLaunchEnv),
    buildAgentLaunchCommand(cli, sessionId, resume, shellInitialPrompt, cliRuntime, cliPermissionPreset, cliModel, debugMode, cliReasoning),
    'exec bash -li',
  ].join('; ')
}

export function getShellLaunchConfig(
  cwd: string,
  sessionId: string,
  resume = false,
  sprintEngineStatePath?: string,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
  cliPermissionPreset: SprintEngineCliPermissionPreset = 'default',
  cliModel?: string,
  memoryRootPath?: string,
  memoryRelativeRoot?: string,
  managedMcpEnv?: Record<string, string>,
  debugMode = false,
  cliAuthToken?: string,
  cliReasoning?: string,
  // Absolute binary path resolved by the spawn pre-flight; see
  // AgentLaunchRenderInput.resolvedBinaryPath. Undefined leaves the launch on
  // the manifest binary name (Windows/WSL, or an undecided probe).
  resolvedBinaryPath?: string
): ShellLaunchConfig {
  assertExistingDirectory(cwd)

  const cliRuntime = getCliRuntimeSettings(cli, cliRuntimes)

  // CLI manifests may redirect the agent at an alternate API endpoint via
  // `launch.env` (e.g. the Z.AI runtime points the `claude` binary at Z.AI's
  // Anthropic-compatible endpoint). Render it once here with the resolved auth
  // token, then inject it into the spawned env (PTY env for native, bootstrap
  // exports for WSL). Empty for the ordinary CLIs, so their launch is unchanged.
  const providerLaunchEnv = renderCliLaunchEnv({
    cli,
    sessionId,
    initialPrompt,
    cliRuntime,
    cliPermissionPreset,
    cliModel,
    cliReasoning,
    debugMode,
    colorScheme: getColorScheme(),
    secretToken: cliAuthToken,
  })

  if (process.platform === 'win32' && !cliRuntime.useWsl) {
    const windowsCwd = toWindowsPath(cwd)
    const windowsStatePath = sprintEngineStatePath ? toWindowsPath(sprintEngineStatePath) : undefined
    const windowsMemoryRootPath = memoryRootPath ? toWindowsPath(memoryRootPath) : undefined
    const shellInitialPrompt = normalizeInitialPromptPaths(initialPrompt, 'windows', [cwd, sprintEngineStatePath, memoryRootPath])
    if (!isNativeWindowsPath(windowsCwd)) {
      throw new Error(
        `Workspace path "${cwd}" is not available as a Windows path. Turn on "Run through WSL" for ${cli}.`
      )
    }
    const startupScriptPath = createTerminalStartupScript(
      sessionId,
      'ps1',
      buildNativeAgentLaunchPowerShellScript(
        cli,
        sessionId,
        resume,
        windowsCwd,
        shellInitialPrompt,
        cliRuntime,
        cliPermissionPreset,
        cliModel,
        debugMode,
        cliReasoning
      )
    )

    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', startupScriptPath],
      env: mergeProviderLaunchEnv(
        withSprintEngineEnv(getTerminalEnv(), windowsCwd, windowsStatePath, windowsMemoryRootPath, memoryRelativeRoot, managedMcpEnv),
        providerLaunchEnv
      ),
      cwd: windowsCwd,
      pathStyle: 'windows',
      startupScriptPath,
    }
  }

  if (process.platform === 'win32') {
    const startupScriptPath = createTerminalStartupScript(
      sessionId,
      'sh',
      buildWslShellScript(
        cwd,
        sessionId,
        resume,
        sprintEngineStatePath,
        cli,
        initialPrompt,
        cliRuntime,
        cliPermissionPreset,
        cliModel,
        memoryRootPath,
        memoryRelativeRoot,
        managedMcpEnv,
        debugMode,
        providerLaunchEnv,
        cliReasoning
      )
    )
    return {
      command: 'wsl.exe',
      args: [
        '-e',
        'bash',
        '-li',
        toWslPath(startupScriptPath),
      ],
      pathStyle: 'wsl',
      startupScriptPath,
    }
  }

  const shellPath = getPosixShellPath()
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const launchCommand = [
    buildSprintEngineShellBootstrap(sprintEngineStatePath, memoryRootPath, memoryRelativeRoot, managedMcpEnv, providerLaunchEnv),
    buildAgentLaunchCommand(cli, sessionId, resume, initialPrompt, cliRuntime, cliPermissionPreset, cliModel, debugMode, cliReasoning, resolvedBinaryPath),
    buildInteractiveShellExec(shellPath, shellName),
  ].join('; ')
  const startupScriptPath = createTerminalStartupScript(sessionId, 'sh', launchCommand)

  return {
    command: shellPath,
    args: isLoginShell(shellName) ? ['-l', startupScriptPath] : [startupScriptPath],
    cwd,
    env: mergeProviderLaunchEnv(
      withSprintEngineEnv(getTerminalEnv(), cwd, sprintEngineStatePath, memoryRootPath, memoryRelativeRoot, managedMcpEnv),
      providerLaunchEnv
    ),
    pathStyle: 'posix',
    startupScriptPath,
  }
}

export function getPlainShellLaunchConfig(
  cwd: string,
  sprintEngineStatePath?: string,
  sessionId = 'plain-terminal'
): ShellLaunchConfig {
  assertExistingDirectory(cwd)

  if (process.platform === 'win32') {
    const windowsCwd = toWindowsPath(cwd)
    const windowsStatePath = sprintEngineStatePath ? toWindowsPath(sprintEngineStatePath) : undefined

    if (isNativeWindowsPath(windowsCwd)) {
      return {
        command: 'powershell.exe',
        args: ['-NoLogo'],
        env: withSprintEngineEnv(getTerminalEnv(), windowsCwd, windowsStatePath),
        cwd: windowsCwd,
        pathStyle: 'windows',
      }
    }

    const startupScriptPath = createTerminalStartupScript(
      sessionId,
      'sh',
      [
        buildUserShellStartup(),
        `cd ${quotePosix(toWslPath(cwd))}`,
        buildSprintEngineShellBootstrap(sprintEngineStatePath),
        'exec bash -li',
      ].join('; ')
    )

    return {
      command: 'wsl.exe',
      args: [
        '-e',
        'bash',
        '-li',
        toWslPath(startupScriptPath),
      ],
      pathStyle: 'wsl',
      startupScriptPath,
    }
  }

  const shellPath = getPosixShellPath()
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const launchCommand = [
    buildSprintEngineShellBootstrap(sprintEngineStatePath),
    buildInteractiveShellExec(shellPath, shellName),
  ].join('; ')
  const startupScriptPath = createTerminalStartupScript(sessionId, 'sh', launchCommand)

  return {
    command: shellPath,
    cwd,
    args: isLoginShell(shellName) ? ['-l', startupScriptPath] : [startupScriptPath],
    pathStyle: 'posix',
    startupScriptPath,
  }
}

function buildNativeAgentLaunchPowerShellScript(
  cli: AgentCli,
  sessionId: string,
  resume: boolean,
  cwd: string,
  initialPrompt: string | undefined,
  cliRuntime: CliRuntimeSettings,
  cliPermissionPreset: SprintEngineCliPermissionPreset = 'default',
  cliModel?: string,
  debugMode = false,
  cliReasoning?: string
): string {
  // Codex keeps its legacy Windows path because of two plugin-specific
  // behaviours that do not generalise: a `-C cwd` flag the Windows codex CLI
  // requires for workspace propagation, and an npm-shim detection that
  // unwraps codex.cmd/codex.ps1 to a direct node.exe invocation. These will
  // move into the plugin manifest when the plugin schema gains executable
  // hooks (post v1).
  if (pluginIdForCli(cli) === 'codex') {
    return buildCodexLegacyNativeAgentLaunchPowerShellScript(
      sessionId,
      resume,
      cwd,
      initialPrompt,
      cliRuntime,
      cliPermissionPreset,
      cliModel,
      debugMode,
      cliReasoning
    )
  }

  const { argv, binary } = renderAgentLaunchArgv({
    cli,
    sessionId,
    resume,
    initialPrompt,
    cliRuntime,
    cliPermissionPreset,
    cliModel,
    cliReasoning,
    debugMode,
    colorScheme: getColorScheme(),
  })
  // argv[0] is the binary; the remainder are the arguments PowerShell needs
  // to base64-encode for round-trip safety through nested quoting layers.
  const args = argv.slice(1)
  return [
    `$ErrorActionPreference = 'Continue'`,
    `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
    `$command = ${quotePowerShell(binary)}`,
    `$arguments = @(${args.map((arg) => powerShellBase64Literal(arg)).join(', ')})`,
    `& $command @arguments`,
  ].join('\r\n')
}

// Exported for agent-launch-render.test.ts: this acknowledged-legacy Windows
// path builds codex args by hand instead of going through renderAgentLaunchArgv,
// so it needs its own regression coverage for debug-directive injection and the
// permission-arg orthogonality invariant. Not part of the module's public API.
export function buildCodexLegacyNativeAgentLaunchPowerShellScript(
  sessionId: string,
  resume: boolean,
  cwd: string,
  initialPrompt: string | undefined,
  cliRuntime: CliRuntimeSettings,
  cliPermissionPreset: SprintEngineCliPermissionPreset = 'default',
  cliModel?: string,
  debugMode = false,
  cliReasoning?: string
): string {
  const permissionArgs = getCliPermissionArgs('codex', cliPermissionPreset)
  const command = cliRuntime.command || 'codex'
  // This acknowledged-legacy path builds codex args by hand instead of going
  // through renderAgentLaunchArgv, so the shared debug boundary does not cover
  // it — apply the directive here too, including the codex-native skill
  // invocation pulled from the manifest. Permission args above stay untouched.
  const codexPlugin = getPluginById('codex')
  const nativeInvocation = debugMode && codexPlugin ? resolveDebugSkillInvocation(codexPlugin) : undefined
  const debugPrompt = debugMode
    ? applyDebugDirective(initialPrompt ?? '', true, nativeInvocation)
    : initialPrompt
  const promptArg = nativeWindowsCodexPromptArg(debugPrompt)
  // The model flag is hardcoded like the rest of this acknowledged-legacy
  // codex-specific path; the manifest-rendered paths read modelSelection.args.
  const model = cliModel?.trim()
  // Effort is NOT hardcoded here: its render rule (differs-from-default, level
  // declared) is shared with the manifest paths through renderReasoningArgs, so
  // this path cannot drift into passing a level codex would reject. A missing
  // manifest yields no effort args, exactly like an unset level. Resume passes
  // none at all, matching codex's manifest resume argv: the CLI persists the
  // level per session, so re-passing it would clobber a mid-session change.
  const reasoningArgs = !resume && codexPlugin
    ? renderReasoningArgs(codexPlugin.manifest, cliReasoning)
    : []
  const args = [
    ...permissionArgs,
    ...(model ? ['--model', model] : []),
    ...reasoningArgs,
    // Targeted resume when the harness session id is known (mirrors the manifest
    // resume argv); falls back to bare `resume` (last session) otherwise.
    ...(resume ? ['resume', ...(sessionId ? [sessionId] : [])] : []),
    '-C',
    cwd,
    ...(!resume && promptArg ? [promptArg] : []),
  ]

  return [
    `$ErrorActionPreference = 'Continue'`,
    `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
    `$command = ${quotePowerShell(command)}`,
    `$arguments = @(${args.map((arg) => powerShellBase64Literal(arg)).join(', ')})`,
    `$resolvedCommand = Get-Command $command -ErrorAction SilentlyContinue`,
    `$resolvedSource = if ($resolvedCommand) { $resolvedCommand.Source } else { $null }`,
    `$resolvedLeaf = if ($resolvedSource) { Split-Path -Leaf $resolvedSource } else { '' }`,
    `$isCodexNpmShim = $resolvedLeaf -in @('codex.cmd', 'codex.ps1')`,
    `if ($isCodexNpmShim) {`,
    `  $codexJs = Join-Path (Split-Path -Parent $resolvedSource) 'node_modules\\@openai\\codex\\bin\\codex.js'`,
    `  if (!(Test-Path -LiteralPath $codexJs)) { throw "Codex npm shim detected, but codex.js was not found at $codexJs." }`,
    `  $command = 'node.exe'`,
    `  $arguments = @($codexJs) + $arguments`,
    `}`,
    `& $command @arguments`,
  ].join('\r\n')
}

function buildAgentLaunchCommand(
  cli: AgentCli,
  sessionId: string,
  resume = false,
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SprintEngineCliPermissionPreset = 'default',
  cliModel?: string,
  debugMode = false,
  cliReasoning?: string,
  resolvedBinaryPath?: string
): string {
  return buildAgentShellCommand({
    cli,
    sessionId,
    resume,
    initialPrompt,
    cliRuntime,
    cliPermissionPreset,
    cliModel,
    cliReasoning,
    debugMode,
    colorScheme: getColorScheme(),
    resolvedBinaryPath,
  })
}
