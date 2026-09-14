import { app } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { unlink } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentCli, CliRuntimeSettings, SprintEngineCliPermissionPreset, TerminalPathStyle } from '../shared/electron-api'
import type { PluginContextInjectionMode } from '../shared/plugin-manifest'
import { applyDebugDirective } from '../shared/debug-directive'
import { DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME } from '../shared/design-system/bundle-scaffold'
import { buildHostContextDocument, wrapHostContextForPrompt } from '../shared/host-context/document'
import { buildAgentShellCommand, cliTakesLaunchPlugins, pluginIdForCli, renderAgentLaunchArgv, renderCliLaunchEnv, resolveCliRuntimeSettings, resolveDebugSkillInvocation } from './agent-launch-render'
import { buildLaunchStatusLineSetting } from './agent-state'
import { resolveAgentStateSocketPath } from './agent-state-service'
import { renderReasoningArgs, resolvePermissionArgs } from './plugin-render'
import {
  getPluginById,
  getPluginManifest,
  getPluginSprintEngineRegistryRoots,
} from './plugin-registry-instance'
import { withMulticodeCliPath } from './cli-install'
import { getColorScheme } from './color-scheme-store'
import { ensureManagedRuntimeShims, getManagedPython, withManagedRuntimePath } from './managed-runtime'
import { compatStudioEnvEntry, studioEnvNames, withoutStudioEnv } from '../shared/studio-env'

export type ShellLaunchConfig = {
  command: string
  args: string[]
  cwd?: string
  pathStyle: TerminalPathStyle
  initialInput?: string
  env?: Record<string, string>
  startupScriptPath?: string
  /**
   * Where this launch's host-context document was written, when one was. The
   * caller keeps it on the session so the file is reaped at teardown alongside
   * the startup script; see `cleanupHostContextFile`.
   */
  hostContextPath?: string
}

export function getTerminalEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )

  delete env.ELECTRON_RUN_AS_NODE
  env.TERM = env.TERM || 'xterm-256color'
  // Put us on the hyperlink allowlist. Claude Code (and every other CLI using
  // `supports-hyperlinks`) only emits the OSC 8 escape when its probe passes,
  // and that probe is a list of terminal identities — FORCE_HYPERLINK first,
  // then TERM_PROGRAM against a fixed set of emulator names, then
  // TERMINAL_EMULATOR, then WT_SESSION. TERM alone fails every branch, so a
  // `[file] …` line arrived as inert text no matter what the renderer did.
  // FORCE_HYPERLINK is the honest branch to take: we DO render them (see
  // `terminalOscLinks.ts`), and claiming to be iTerm by setting TERM_PROGRAM
  // would tell every other CLI a lie about a dozen unrelated capabilities.
  // Left alone when the user already exported it, so `FORCE_HYPERLINK=0`
  // remains a way to turn the escapes off.
  env.FORCE_HYPERLINK = env.FORCE_HYPERLINK || '1'

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
// SPRINTENGINE_* values directly on the session env record.
//
// Agent launches also carry THIS instance's agent-state socket address. The
// reporter hook prefers the env address over the `--socket` arg baked into the
// repo's shared `.claude/settings.local.json`, because that file is
// last-writer-wins across app instances (a second dev instance or E2E profile
// rewrites it and every other instance's agents then report phases to a dead
// socket — the 2026-07-07 parked-agents incident). Env is per-process, so an
// agent always reports to the instance that launched it.
function agentIdentityEnv(input: {
  workspaceId?: string
  agentId?: string
  agentName?: string
}): Record<string, string> {
  const workspaceId = input.workspaceId?.trim()
  const agentId = input.agentId?.trim()
  const agentName = input.agentName?.trim()
  const agentStateSocketPath = agentId ? agentStateSocketPathForLaunch() : null
  // Both spellings of every value. The reader is a hook script the app copied
  // into the person's workspace at some earlier version and does not rewrite on
  // launch; a copy from before the rename reads MULTICODE_*, one from after
  // reads SPRINTENGINE_*, and the same app instance has to satisfy both.
  return {
    ...compatStudioEnvEntry('SPRINTENGINE_WORKSPACE_ID', workspaceId),
    ...compatStudioEnvEntry('SPRINTENGINE_AGENT_ID', agentId),
    ...compatStudioEnvEntry('SPRINTENGINE_AGENT_NAME', agentName),
    ...compatStudioEnvEntry('SPRINTENGINE_AGENT_STATE_SOCKET', agentStateSocketPath),
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

// The app-owned plugin directories a launch hands a CLI that declares
// `launchPlugins` — this app's skills, its agent-state hook and its MCP server,
// for that session only, instead of installed into the person's repository.
//
// Published by app-services once the copy has been materialised rather than
// resolved here, because materialising is async and a launch must not wait for
// it. Until then (and for a build whose plugin did not ship) this resolves to
// nothing: the launch renders exactly the argv it always did, and the workspace
// installer stays responsible for agent state — see `resolveLaunchInjectsPlugins`.
let launchPluginDirsResolver: (() => string[]) | null = null

export function setLaunchPluginDirsResolver(resolver: (() => string[]) | null): void {
  launchPluginDirsResolver = resolver
}

/**
 * This launch's plugin directories, in the path style the launched shell reads.
 *
 * The directories are native paths belonging to the app; a WSL launch runs a
 * Linux shell that cannot open `C:\...`, so they are converted exactly as every
 * other host path crossing that boundary is.
 */
function pluginDirsForLaunch(cli: AgentCli, target: 'posix' | 'windows' | 'wsl'): string[] {
  // Windows is deliberately left on the workspace install for now, BOTH native
  // and through WSL, and the skip predicate in app-services agrees with this so
  // the two can never each think the other is registering the hook.
  //
  // WSL is the reason: the copy is materialised once with absolute paths
  // substituted into it — the hook command, the node binary that runs the MCP
  // bridge, the bridge itself — and those are Windows paths. Converting the
  // DIRECTORY for the flag does not convert the paths inside the files, so a
  // Linux `claude` would run `node "C:/Users/…/agent-state.mjs"` and report
  // MODULE_NOT_FOUND for every event. Native Windows would work, but one
  // platform answering two ways is how the double registration gets back in.
  if (!launchPluginsSupportedOnThisPlatform()) return []
  if (!cliTakesLaunchPlugins(cli)) return []
  let dirs: string[]
  try {
    dirs = launchPluginDirsResolver?.() ?? []
  } catch {
    return []
  }
  if (target === 'posix') return dirs
  return dirs.map((dir) => (target === 'wsl' ? toWslPath(dir) : toWindowsPath(dir)))
}

/**
 * Whether this platform takes the app's plugin directories at launch.
 *
 * Exported so the workspace installer asks the same question: one answer, or
 * both halves write the hook and every event is reported twice.
 */
// The status-line forwarder inside the app's own plugin copy. Published by
// app-services alongside the plugin directories; empty until that copy lands.
let launchStatusLineScriptResolver: (() => string) | null = null

export function setLaunchStatusLineScriptResolver(resolver: (() => string) | null): void {
  launchStatusLineScriptResolver = resolver
}

/**
 * The settings document this launch passes, or undefined for none.
 *
 * Gated on the plugin directories deliberately: the status line is only sent
 * where the workspace install is being SKIPPED. A launch that still writes the
 * workspace's own settings registers the status line there, exactly as before,
 * and sending it here as well would put two of them in front of one session.
 */
function launchSettingsForLaunch(
  cli: AgentCli,
  cwd: string,
  target: 'posix' | 'windows' | 'wsl'
): Record<string, unknown> | undefined {
  if (pluginDirsForLaunch(cli, target).length === 0) return undefined
  let scriptPath: string
  try {
    scriptPath = launchStatusLineScriptResolver?.() ?? ''
  } catch {
    return undefined
  }
  if (!scriptPath) return undefined
  const socketPath = agentStateSocketPathForLaunch()
  if (!socketPath) return undefined
  // Read against the NATIVE cwd: the settings files being consulted are this
  // machine's, whatever path style the launched shell speaks.
  const statusLine = buildLaunchStatusLineSetting({
    workspaceRoot: cwd,
    scriptPath,
    socketPath,
    homeDir: homedir(),
    env: process.env,
  })
  return statusLine ? { statusLine } : undefined
}

export function launchPluginsSupportedOnThisPlatform(): boolean {
  return process.platform !== 'win32'
}

// The identity vars `agentIdentityEnv` owns. Cleared from a base env before the
// session's own identity is applied, so a stale `SPRINTENGINE_AGENT_ID` inherited
// by the app's own process (e.g. the app launched from inside an agent shell)
// never leaks into a plain terminal or the wrong agent.
const AGENT_IDENTITY_ENV_KEYS = [
  'SPRINTENGINE_WORKSPACE_ID',
  'SPRINTENGINE_AGENT_ID',
  'SPRINTENGINE_AGENT_NAME',
  'SPRINTENGINE_AGENT_STATE_SOCKET',
] as const

// Apply this session's agent identity onto a base env: strip any inherited
// identity first (no leak), then set this session's values. A non-agent launch
// passes no ids, so the result simply carries no identity.
export function applyAgentIdentityEnv(
  baseEnv: Record<string, string>,
  input: { workspaceId?: string; agentId?: string; agentName?: string }
): Record<string, string> {
  // Stripped under BOTH names: the app's own process may have inherited a
  // legacy-named identity from the shell that started it, and clearing only the
  // new name would leave that to be read as this session's agent.
  return { ...withoutStudioEnv(baseEnv, AGENT_IDENTITY_ENV_KEYS), ...agentIdentityEnv(input) }
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
  // Both spellings: `agentIdentityEnv` writes both, so protecting only the new
  // one would leave a manifest able to set the legacy name and have an older
  // hook copy report this session under another agent's identity.
  ...AGENT_IDENTITY_ENV_KEYS.flatMap(studioEnvNames),
  'TERM',
  'COLORTERM',
  // Same reasoning as TERM: whether this terminal renders OSC 8 hyperlinks is a
  // fact about the pane, which a CLI manifest is in no position to know. A
  // manifest that set it to '0' would silently un-click every `[file] …` line;
  // one that set it to '1' for a pane that could not render them would print
  // raw escapes.
  'FORCE_HYPERLINK',
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

// Merge a CLI manifest's rendered `launch.env` (and its `contextInjection.env`,
// which rides the same record) onto a base session env. The provider env wins on
// collision (it is the whole point — e.g. pointing ANTHROPIC_BASE_URL at Z.AI)
// except for the protected identity keys above. No-op (returns the base
// unchanged) for the common case of a manifest with no env at all.
//
// ONE exception to "wins on collision": when both sides are JSON objects, they
// are merged rather than replaced. This is the host-context env channel
// (OpenCode's OPENCODE_CONFIG_CONTENT, a whole config document): a user who
// exports their own config content must not lose it because we wanted to add one
// `instructions` entry, and they must not lose our entry either. The rule is
// stated in terms of JSON, not of any CLI — no manifest is named here.
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
    next[key] = mergeJsonEnvValue(next[key], value)
  }
  return next
}

/**
 * `next` merged over `existing` when both are JSON objects, else `next`.
 *
 * Shallow on objects and concatenating on arrays, which is what "add my entry to
 * your list" needs and all this channel is for. Anything that does not parse —
 * the overwhelming majority of env values — takes the plain replacement path, so
 * this is invisible to every other manifest.
 */
function mergeJsonEnvValue(existing: string | undefined, next: string): string {
  if (!existing) return next
  const left = parseJsonObject(existing)
  const right = parseJsonObject(next)
  if (!left || !right) return next
  const merged: Record<string, unknown> = { ...left }
  for (const [key, value] of Object.entries(right)) {
    const previous = merged[key]
    merged[key] = Array.isArray(previous) && Array.isArray(value) ? [...previous, ...value] : value
  }
  return JSON.stringify(merged)
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

// JSON for the dynamic plugin registry roots the souls CLI should also search
// (consumed by souls/registry.py via SPRINTENGINE_REGISTRY_ROOTS).
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
  managedMcpEnv?: Record<string, string>
): Record<string, string> {
  const bundledToolPath = getBundledSprintEngineToolPath()
  const soulsRoot = getBundledSoulsRoot()
  const registryRootsEnv = sprintEngineRegistryRootsEnvValue()
  // Expose the bundled CPython to the tool shims, but only when we actually have
  // a managed interpreter (bundled runtime or operator override). When we'd fall
  // back to a repo `.venv` or system Python, leave SPRINTENGINE_PYTHON unset so the
  // shims keep their existing dev-friendly `$PWD/.venv → python3` behavior.
  const managedPython = getManagedPython(cwd)
  const managedPythonEnv: Record<string, string> =
    managedPython.source === 'bundled' || managedPython.source === 'override'
      ? { SPRINTENGINE_PYTHON: managedPython.command }
      : {}
  // Annotated rather than inferred: spreading `env` into a literal drops its
  // index signature, and the PATH lookup below indexes by a key computed at
  // runtime (the variable's case differs by platform).
  const nextEnv: Record<string, string> = {
    ...env,
    SPRINTENGINE_REPO_TOOL_PATH: join(cwd, '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
    SPRINTENGINE_REPO_WRAPPER_PATH: join(cwd, 'scripts', 'sprintengine_tool.py'),
    ...managedPythonEnv,
    ...(bundledToolPath ? { SPRINTENGINE_TOOL_PATH: bundledToolPath } : {}),
    ...(soulsRoot ? { SPRINTENGINE_SOULS_ROOT: soulsRoot } : {}),
    ...(registryRootsEnv ? { SPRINTENGINE_REGISTRY_ROOTS: registryRootsEnv } : {}),
    ...(sprintEngineStatePath ? { SPRINTENGINE_STATE_PATH: sprintEngineStatePath } : {}),
    ...(managedMcpEnv ?? {}),
    ...(memoryRootPath ? { SPRINTENGINE_KNOWLEDGE_ROOT: memoryRootPath, SPRINTENGINE_MEMORY_ROOT: memoryRootPath } : {}),
  }

  // Never let a stale registry-roots value inherited from the base env (e.g. the
  // app launched from inside an agent shell that had it set) leak into a spawn
  // that resolved none of its own — otherwise `souls get` would search another
  // session's plugin roots. Mirrors the AGENT_IDENTITY_ENV_KEYS stripping above.
  if (!registryRootsEnv) {
    for (const key of studioEnvNames('SPRINTENGINE_REGISTRY_ROOTS')) delete nextEnv[key]
  }

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

/**
 * Rewrite every absolute path this launch knows about into the path style the
 * launched shell speaks. Applied to the initial prompt and to the host-context
 * document alike — both name the workspace, the knowledge root and the context
 * file itself, and a Windows path handed to a CLI running under WSL points at
 * nothing.
 */
function normalizeTextPaths(
  text: string | undefined,
  target: 'windows' | 'wsl',
  paths: Array<string | undefined>
): string | undefined {
  if (!text) return text

  let normalizedPrompt = text
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

// One argument as the MSVC runtime (CommandLineToArgvW) parses it back: quoted
// when it holds whitespace or a quote, `"` escaped, and the backslashes that
// run up to a quote doubled.
function quoteWindowsCommandLineArg(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value
  let quoted = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    quoted += char === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

// Exported for terminal-launch.test.ts. The tail of the native Windows launch
// script: run `$command` with `$arguments` (set by the caller).
//
// Windows PowerShell 5.1 — which powershell.exe always is — does not escape
// embedded double quotes when it builds a native exe's command line, so
// `& claude.exe @arguments` handed Claude Code `--settings {theme:dark}` for
// the argument `{"theme":"dark"}`, and Claude Code rejected it as invalid
// settings on every launch. Any prompt with a quote in it was mangled the same
// way. So for an .exe the command line is built here, escaped exactly, and
// passed through the stop-parsing token, which hands the rest of the line to
// the exe verbatim (expanding only %VAR%). A .ps1/.cmd shim keeps the old
// splat: --% means something else to a script, and cmd.exe re-parses quotes
// by its own rules.
export function buildNativeWindowsInvocation(args: string[]): string[] {
  if (args.length === 0) return ['& $command']
  return [
    `$env:SPRINTENGINE_LAUNCH_ARGS = ${powerShellBase64Literal(args.map(quoteWindowsCommandLineArg).join(' '))}`,
    `$resolvedCommand = Get-Command $command -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `if ($resolvedCommand -and $resolvedCommand.CommandType -eq 'Application' -and $resolvedCommand.Source -match '\\.(exe|com)$') {`,
    // Nothing may follow --% on this line: it would be passed to the exe too.
    `  & $resolvedCommand.Source --% %SPRINTENGINE_LAUNCH_ARGS%`,
    `} else {`,
    `  & $command @arguments`,
    `}`,
    `Remove-Item Env:SPRINTENGINE_LAUNCH_ARGS -ErrorAction SilentlyContinue`,
  ]
}

function nativeWindowsCodexPromptArg(value: string | undefined): string | undefined {
  return value
    ?.replace(/\r\n|\r|\n/g, '\\n')
    .replace(/"/g, '\\"')
}

// Permission args for the acknowledged-legacy codex Windows-native path, read
// from the CLI's own manifest. This used to be a second hardcoded copy of the
// per-CLI mapping sitting alongside the manifests, which is exactly how the
// Claude Code mapping drifted (MC-2210) — a manifest edit did not reach here.
// A CLI with no loaded manifest renders no permission args, which is the same
// fail-safe the ladder takes for an undeclared preset: never invent a flag.
function getCliPermissionArgs(
  cli: AgentCli,
  preset: SprintEngineCliPermissionPreset = 'manual'
): string[] {
  const manifest = getPluginManifest(cli)
  return manifest ? resolvePermissionArgs(manifest, preset) : []
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
    lines.push(`export SPRINTENGINE_KNOWLEDGE_ROOT=${quotePosix(shellMemoryRootPath)}`)
    lines.push(`export SPRINTENGINE_MEMORY_ROOT=${quotePosix(shellMemoryRootPath)}`)
  }

  if (shellBundledToolPath) {
    lines.push(`export SPRINTENGINE_TOOL_PATH=${quotePosix(shellBundledToolPath)}`)
  }

  if (shellSoulsRoot) {
    lines.push(`export SPRINTENGINE_SOULS_ROOT=${quotePosix(shellSoulsRoot)}`)
  }

  const shellRegistryRootsEnv = sprintEngineRegistryRootsEnvValue()
  if (shellRegistryRootsEnv) {
    lines.push(`export SPRINTENGINE_REGISTRY_ROOTS=${quotePosix(shellRegistryRootsEnv)}`)
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

  return lines.join('; ')
}

function buildUserShellStartup(): string {
  return [
    'for profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do [ -r "$profile" ] && . "$profile" && break; done',
    '[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
    '[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"',
  ].join('; ')
}

// ── Shell integration: OSC 7 (cwd) and OSC 133 (prompt marks) ───────────────
//
// A pane's `executionRoot` is the directory it was LAUNCHED in, so the moment a
// user types `cd` every relative path printed afterwards resolves against the
// wrong tree — silently, because the wrong tree usually holds a file by that
// name too. OSC 7 (`ESC ] 7 ; file://<host>/<path> ST`) is the standard way a
// shell keeps its terminal up to date, and xterm registers no handler for it,
// so both halves are ours: emit it here, read it in
// `terminalOscLinks.ts`/`PlainTerminalPanel`.
//
// Neither macOS shell emits it unprompted. The awkward part is that our startup
// script does its work and then `exec`s the user's real interactive shell —
// which is the right thing to do, and it means a function or a hook defined in
// the script is gone by the time there is a prompt to hook. Only the
// ENVIRONMENT survives the exec, so each shell is reached the one way it can be
// reached through env alone:
//
// - **bash** imports `PROMPT_COMMAND` from the environment and runs it before
//   every prompt, so the whole emitter travels as one exported string.
// - **zsh** has no such variable (`precmd_functions` is an array, and arrays do
//   not travel in env), but it does read its startup files from `$ZDOTDIR`. So
//   we point that at a generated directory whose files hand straight back to
//   the user's own and then add the hook. The user's files still see their own
//   `$ZDOTDIR` while they run, and the shell is left holding it afterwards.
//
// A user who has already set `PROMPT_COMMAND` or `ZDOTDIR` keeps it: both are
// captured into a `SPRINTENGINE_USER_…` variable before they are replaced, and
// theirs is run behind ours (`PROMPT_COMMAND`) or handed back to them
// (`ZDOTDIR`). Both captures are guarded against a relaunch inside one of our
// own terminals, where the inherited value is already ours. A rc file that
// appends to `PROMPT_COMMAND` (the common case) keeps ours as well. A rc that
// ASSIGNS `PROMPT_COMMAND` outright wins and no OSC 7 arrives — which is the
// same as any other shell that does not emit it, and the renderer falls back
// to the launch directory rather than breaking.
//
// The host is deliberately empty (`file:///Users/…`, not `file://mymac/…`):
// the renderer refuses any `file:` URI that names a host, because a pane
// attached to another machine must never resolve a local path, and a payload
// carrying THIS machine's hostname is indistinguishable from one carrying
// someone else's.
//
// OSC 133 rides the SAME two mechanisms — one exported `PROMPT_COMMAND`, one
// generated `$ZDOTDIR` — because a second injection would be a second thing to
// keep working. Four marks: `133;A` prompt start, `133;B` prompt end, `133;C`
// pre-execution, `133;D;<status>` command finished. A and D come from the
// pre-prompt hook (which is why the hook now captures `$?` before it does
// anything else, and restores it afterwards so a prompt that shows the last
// exit status still sees the real one). B is appended to `PS1` and C to bash's
// `PS0`/zsh's `preexec`, both idempotently and both re-checked every prompt, so
// a theme that rebuilds `PS1` costs at most one prompt's mark rather than
// stacking copies.
//
// Three honest limitations, each degrading to "fewer marks", never to
// breakage. `PS0` arrived in bash 4.4, so macOS's system bash 3.2 emits no C
// and the renderer therefore attributes no exit status to it (see
// `terminalShellMarks.ts`: a D with no C before it is ignored, which is also
// what an empty Enter and the very first prompt emit). A prompt theme that
// regenerates `PS1` AFTER our hook runs — powerlevel10k, or a user
// `PROMPT_COMMAND` appended behind ours — drops B for as long as it keeps
// doing so. And a zsh with `PROMPT_PERCENT` off has no zero-width prompt
// escape at all, so it is given no B rather than a literal `%{` in its
// prompt.
//
// Nothing here reaches agent state. Agent phase comes from `agent-state.ts`
// over the state socket (decision of record 2026-08-31, hooks only), and these
// marks are armed for `shell` panes alone — an agent pane runs a CLI, not a
// prompt, and never sees this setup.

/** The path characters that would change what the URI means if left raw. */
const OSC7_PATH_ESCAPES: Array<[string, string]> = [
  // `%` first: every replacement below introduces one, and re-escaping those
  // would turn `%5C` into `%255C`.
  ['%', '%25'],
  // `#` starts a fragment and `?` a query — either would TRUNCATE the path at
  // that point rather than corrupt it, which is the failure that looks like a
  // working link to the wrong directory.
  ['#', '%23'],
  ['?', '%3F'],
  // The URL parser folds `\` to `/` for file URIs, so a directory named with
  // one would come back as an extra path segment.
  ['\\', '%5C'],
]

/**
 * One OSC sequence (`ESC ] <payload> ESC \`) as the literal text a shell needs
 * in a `printf` format or in `PS1`/`PS0`.
 *
 * Written once because the escaping is three layers deep — a TypeScript string
 * literal, a single-quoted shell word, then the shell's own `\nnn` decoding —
 * and a hand-copied version that got one layer wrong would read correctly in
 * the source and put garbage on the wire.
 */
function oscSequenceLiteral(payload: string): string {
  return `\\033]${payload}\\033\\\\`
}

/**
 * bash's emitter, as one self-contained line.
 *
 * It has to be self-contained because it travels as an environment variable
 * through an `exec` — there is no function definition on the far side to call.
 */
export const OSC7_BASH_PROMPT_COMMAND: string = [
  '__multicode_osc7=${PWD}',
  ...OSC7_PATH_ESCAPES.map(([from, to]) => `__multicode_osc7=\${__multicode_osc7//\\${from}/${to}}`),
  `printf '\\033]7;file://%s\\033\\\\' "$__multicode_osc7"`,
].join('; ')

/**
 * The first thing the exported `PROMPT_COMMAND` does, and it has to be first.
 *
 * `$?` is the status of the command the user just ran, and ANY command replaces
 * it — a plain assignment included, which is exactly what the OSC 7 emitter
 * opens with.
 */
export const OSC133_BASH_STATUS_CAPTURE: string = '__multicode_status=$?'

/**
 * The variable name above, on its own: `buildShellIntegrationSetup` matches on
 * it to tell an inherited `PROMPT_COMMAND` that is ALREADY ours from a user's.
 * Named here so the two cannot drift.
 */
export const OSC133_BASH_STATUS_CAPTURE_VARIABLE: string = '__multicode_status'

/**
 * bash's OSC 133 marks, appended to the same exported `PROMPT_COMMAND`.
 *
 * Four lines, in the order they have to run:
 *
 * 1. `133;D;<status>` for the command that just finished, then `133;A` for the
 *    prompt about to be drawn. One `printf`, because two would let a slow pipe
 *    interleave something between them.
 * 2. `133;B` (prompt end) appended to `PS1`, guarded so it lands once. The
 *    guard is re-run every prompt rather than once at setup: a theme that
 *    rebuilds `PS1` per prompt would otherwise lose the mark permanently, and
 *    one that does not would otherwise gain a copy per prompt. `\[`…`\]` is
 *    what stops readline counting the escape as columns — without it the shell
 *    mis-measures the prompt and wraps the user's typing in the wrong place.
 * 3. `133;C` (pre-execution) appended to `PS0`, which bash expands after
 *    reading a command and before running it. bash 4.4+; on macOS's system
 *    bash 3.2 the variable is simply unused, so no C is emitted and the
 *    renderer attributes no exit status. Fewer marks, never a broken prompt.
 * 4. `$?` put back, so a user `PROMPT_COMMAND` appended behind ours — or a
 *    `PS1` that reads `$?` through `promptvars` — still sees the real status.
 *    The subshell is skipped on success, which is the common case.
 */
export const OSC133_BASH_PROMPT_COMMAND: string = [
  `printf '${oscSequenceLiteral('133;D;%s')}${oscSequenceLiteral('133;A')}' "$__multicode_status"`,
  `case \${PS1-} in *'${oscSequenceLiteral('133;B')}'*) ;; *) PS1=\${PS1-}'\\[${oscSequenceLiteral('133;B')}\\]' ;; esac`,
  `case \${PS0-} in *'${oscSequenceLiteral('133;C')}'*) ;; *) PS0=\${PS0-}'${oscSequenceLiteral('133;C')}' ;; esac`,
  'case $__multicode_status in 0) ;; *) ( exit $__multicode_status ) ;; esac',
].join('; ')

/**
 * Everything bash's `PROMPT_COMMAND` carries: capture the status, report the
 * directory, emit the marks. One variable because only one survives the `exec`.
 */
export const SHELL_INTEGRATION_BASH_PROMPT_COMMAND: string = [
  OSC133_BASH_STATUS_CAPTURE,
  OSC7_BASH_PROMPT_COMMAND,
  OSC133_BASH_PROMPT_COMMAND,
].join('; ')

/** zsh's emitter plus the `precmd` hook that runs it, appended to our `.zshrc`. */
const OSC7_ZSH_HOOK: string = [
  '__multicode_osc7_cwd() {',
  // The user's option set is theirs; this function should not depend on it.
  '  emulate -L zsh',
  '  local d=$PWD',
  ...OSC7_PATH_ESCAPES.map(([from, to]) => `  d=\${d//\\${from}/${to}}`),
  `  printf '\\033]7;file://%s\\033\\\\' "$d"`,
  '}',
  'typeset -ag precmd_functions',
  // Idempotent: a nested zsh reads this file again and must not stack the hook.
  'if (( ! ${precmd_functions[(I)__multicode_osc7_cwd]} )); then',
  '  precmd_functions+=(__multicode_osc7_cwd)',
  'fi',
  // The first prompt has no `cd` before it, so report the launch directory too.
  '__multicode_osc7_cwd',
].join('\n')

/**
 * zsh's OSC 133 marks: one `precmd` hook, one `preexec` hook, appended to the
 * same generated `.zshrc` OSC 7's hook lives in.
 *
 * The precmd hook is PREPENDED to `precmd_functions` rather than appended, and
 * that is the whole subtlety: only the first hook in the list sees the real
 * `$?`, because every hook before it has already replaced it with its own last
 * command's status. It therefore captures the status on its first line and
 * `return`s it, so the hooks behind it — the user's prompt theme included —
 * still see what they saw before we were here.
 *
 * `__multicode_osc133_active` is what keeps a bare Enter from being reported as
 * a command: D is emitted only when a C opened one. (The renderer applies the
 * same rule independently — see `terminalShellMarks.ts` — because the marks are
 * attacker-controlled and this hook is not the only thing that can print them.)
 */
const OSC133_ZSH_HOOK: string = [
  '__multicode_osc133_precmd() {',
  // Before `emulate`, before anything: any command at all replaces `$?`.
  '  local __multicode_ret=$?',
  '  emulate -L zsh',
  '  if (( __multicode_osc133_active )); then',
  `    printf '${oscSequenceLiteral('133;D;%s')}' "$__multicode_ret"`,
  '    __multicode_osc133_active=0',
  '  fi',
  `  printf '${oscSequenceLiteral('133;A')}'`,
  // Prompt end. `%{`…`%}` is zsh's "these bytes occupy no columns"; without it
  // the shell mis-measures the prompt and wraps the user's typing early.
  // Re-checked every prompt so a theme that rebuilds PS1 costs one mark rather
  // than losing it for the session, and guarded so one that does not rebuild it
  // does not collect a copy per prompt.
  `  if (( __multicode_osc133_prompt_percent )) && [[ $PS1 != *$'\\e]133;B'* ]]; then`,
  `    PS1=$PS1$'%{\\e]133;B\\e\\\\%}'`,
  '  fi',
  // The status the rest of the prompt machinery expects to find.
  '  return $__multicode_ret',
  '}',
  '__multicode_osc133_preexec() {',
  '  emulate -L zsh',
  '  __multicode_osc133_active=1',
  `  printf '${oscSequenceLiteral('133;C')}'`,
  '}',
  'typeset -g __multicode_osc133_active=0',
  // Whether `%{`…`%}` means anything in this shell, read HERE rather than in the
  // hook: `emulate -L zsh` inside a function reports zsh's default option set,
  // not the user's, and a user who turned PROMPT_PERCENT off would otherwise
  // get a literal `%{` printed into their prompt. Read after their own .zshrc
  // has run, which is the state the prompt will actually be rendered under.
  'typeset -g __multicode_osc133_prompt_percent=0',
  'if [[ -o promptpercent ]]; then __multicode_osc133_prompt_percent=1; fi',
  'typeset -ag precmd_functions',
  // Idempotent prepend: the filter drops any copy a nested zsh already added,
  // then puts exactly one back at the front.
  'precmd_functions=(__multicode_osc133_precmd "${(@)precmd_functions:#__multicode_osc133_precmd}")',
  'typeset -ag preexec_functions',
  'if (( ! ${preexec_functions[(I)__multicode_osc133_preexec]} )); then',
  '  preexec_functions+=(__multicode_osc133_preexec)',
  'fi',
].join('\n')

/**
 * One of the four files zsh reads out of `$ZDOTDIR`, as a shim in front of the
 * user's own copy.
 *
 * All four exist because zsh takes the WHOLE set from `$ZDOTDIR`: shim only
 * `.zshrc` and a login shell silently loses its `.zprofile`.
 */
export function buildShellIntegrationZshShim(fileName: '.zshenv' | '.zprofile' | '.zshrc' | '.zlogin'): string {
  const lines = [
    '# SprintEngine Studio shell integration (OSC 7 working directory, OSC 133 prompt marks).',
    '# Generated — rewritten on every terminal launch, so do not edit.',
    '#',
    '# This directory stands in front of the user\'s $ZDOTDIR and hands each stage',
    '# straight back to it, so their own files run with their own $ZDOTDIR set.',
    'SPRINTENGINE_ZDOTDIR_SELF=${ZDOTDIR}',
    'ZDOTDIR=${SPRINTENGINE_USER_ZDOTDIR:-$HOME}',
    '# A nested launch could point us at ourselves; $HOME is the shell\'s own default.',
    // The right side of `==` inside `[[ ]]` is a GLOB PATTERN unless it is
    // quoted, and this path is `~/Library/Application Support/<productName>/…`
    // — one `[`, `*`, `?` or `(` in the product name or the user's home and the
    // self-reference guard either stops firing or fires against a directory
    // that merely matched, throwing away a real `~/.config/zsh`.
    'if [[ $ZDOTDIR == "$SPRINTENGINE_ZDOTDIR_SELF" ]]; then ZDOTDIR=$HOME; fi',
    // Quoted for the same reason one layer down: these run with the USER'S
    // options in effect (their .zshenv has already been sourced by the shim
    // above), so `SH_WORD_SPLIT` or `GLOB_SUBST` would otherwise reach an
    // unquoted expansion of a path we do not control.
    `if [[ -f "$ZDOTDIR/${fileName}" ]]; then source "$ZDOTDIR/${fileName}"; fi`,
    '# Their file may have moved $ZDOTDIR itself; that is the value to keep.',
    'export SPRINTENGINE_USER_ZDOTDIR="$ZDOTDIR"',
  ]

  if (fileName === '.zshrc') {
    // Interactive shells end here, so this is where the shell gets its own
    // $ZDOTDIR back for good and where the hook goes.
    lines.push(
      'ZDOTDIR=$SPRINTENGINE_USER_ZDOTDIR',
      'unset SPRINTENGINE_ZDOTDIR_SELF',
      '',
      OSC7_ZSH_HOOK,
      '',
      OSC133_ZSH_HOOK,
    )
  } else {
    lines.push('ZDOTDIR=$SPRINTENGINE_ZDOTDIR_SELF', 'unset SPRINTENGINE_ZDOTDIR_SELF')
  }

  return `${lines.join('\n')}\n`
}

/**
 * The generated `$ZDOTDIR`, or null when it could not be written (a read-only
 * profile directory, say). Null simply means no OSC 7 from zsh.
 *
 * Stable rather than per-session: the contents do not vary, and a per-session
 * directory would need reaping on a path where a crashed app leaves it behind.
 */
function ensureShellIntegrationZshZdotdir(): string | null {
  try {
    const directory = join(app.getPath('userData'), 'shell-integration', 'zsh')
    mkdirSync(directory, { recursive: true })
    for (const fileName of ['.zshenv', '.zprofile', '.zshrc', '.zlogin'] as const) {
      replaceFileAtomically(join(directory, fileName), buildShellIntegrationZshShim(fileName))
    }
    return directory
  } catch {
    return null
  }
}

/**
 * Write, then rename into place — never `O_TRUNC` over a file something else
 * may be reading.
 *
 * This directory is STABLE and SHARED, and these four files are rewritten on
 * every shell-pane launch. Restoring a saved layout starts several panes at
 * once: a plain `writeFileSync` truncates `.zshrc` to nothing and refills it,
 * so the zsh one pane just spawned can read the empty middle of another pane's
 * write. The user's own `.zshrc` then silently never sources, and `$ZDOTDIR`
 * is left pointing at the shim for the life of that shell. `rename(2)` is
 * atomic within a filesystem, so a reader sees either the old file or the new
 * one and never a half of either.
 *
 * The temporary name carries the pid and a UUID so two processes writing the
 * same target cannot collide on the temporary either.
 *
 * Exported for terminal-launch.test.ts, which holds a descriptor open across a
 * replace — the one observation that tells `rename` apart from `O_TRUNC`.
 */
export function replaceFileAtomically(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, filePath)
  } catch (error) {
    // A failed rename leaves the temporary behind; a failed write may too.
    try {
      unlinkSync(temporaryPath)
    } catch {
      // Nothing to clean up, or nothing we can do about it.
    }
    throw error
  }
}

/**
 * The startup-script line that arms OSC 7 for this shell, or null for a shell
 * we have no env-only way to reach (`sh`, `fish`, a login shell we do not know).
 */
export function buildShellIntegrationSetup(shellName: string | undefined, zdotdir: string | null): string | null {
  if (shellName === 'bash') {
    return [
      // The user's own exported `PROMPT_COMMAND`, captured before it is
      // replaced — the same shape the zsh branch below uses for `$ZDOTDIR`.
      // A bare `export PROMPT_COMMAND=…` destroyed an inherited value outright,
      // which is what the header of this section always claimed it did not do.
      //
      // The `case` is the self-reference guard: relaunching inside one of our
      // own terminals inherits `<ours>; <theirs>`, and re-capturing THAT would
      // append our emitter to itself once per nesting level. `__multicode_status`
      // appears only in our string, and `SPRINTENGINE_USER_PROMPT_COMMAND` is
      // exported, so the nested shell keeps the value the outer one captured.
      `case "\${PROMPT_COMMAND:-}" in *${OSC133_BASH_STATUS_CAPTURE_VARIABLE}*) ;; *) SPRINTENGINE_USER_PROMPT_COMMAND=\${PROMPT_COMMAND:-}; export SPRINTENGINE_USER_PROMPT_COMMAND ;; esac`,
      // Theirs runs AFTER ours, which is the order the emitter is built for:
      // its last act is to put `$?` back, so a command appended behind it still
      // reads the real exit status. A plain assignment rather than
      // `export NAME=…` so no shell can field-split the joined value.
      `PROMPT_COMMAND=${quotePosix(SHELL_INTEGRATION_BASH_PROMPT_COMMAND)}\${SPRINTENGINE_USER_PROMPT_COMMAND:+"; \$SPRINTENGINE_USER_PROMPT_COMMAND"}`,
      'export PROMPT_COMMAND',
    ].join('; ')
  }
  if (shellName === 'zsh' && zdotdir) {
    return [
      // Captured before it is replaced, and guarded so a relaunch inside one of
      // our own terminals does not record the shim directory as "the user's".
      `if [ "\${ZDOTDIR:-}" != ${quotePosix(zdotdir)} ]; then export SPRINTENGINE_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"; fi`,
      `export ZDOTDIR=${quotePosix(zdotdir)}`,
    ].join('; ')
  }
  return null
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

// ── Host context ────────────────────────────────────────────────────────────
//
// Everything the host wants the agent to know that is NOT the user's request —
// today: an attached design system, and the project's Knowledge Graph. It used
// to be two sentences the RENDERER pasted after the user's prompt, which meant
// the model could not tell host from user, a resumed session was never told at
// all, and a headless launch got only half of it. It is built here instead,
// because this is the one seam every launcher passes through: the interactive
// spawn, the mobile spawn, and `AgentLaunchService` (gateway, automations) all
// reach the pty through `getShellLaunchConfig`.
//
// The manifest decides the channel (`contextInjection`), not this file.

/** Where per-session context documents live, beside the startup scripts. */
const HOST_CONTEXT_DIRECTORY = 'host-context'

/**
 * Exported for terminal-launch.test.ts: the delivery decision and the path
 * normalisation over it are the rules this file owns, and driving them through
 * `getShellLaunchConfig` would need a real Electron `userData` and a real
 * workspace on disk. The manifest-by-manifest argv/env each mode actually
 * produces is proved in agent-launch-render.test.ts, against the bundled
 * manifests and through the same renderer every launch uses.
 */
export type HostContextDelivery = {
  /** The manifest's declared channel. A CLI declaring none falls back to `prompt`. */
  mode: PluginContextInjectionMode
  /** The document, or null when the host has nothing to say about this launch. */
  document: string | null
  /** Where it was written, for the file/env channels. Null in `prompt` mode. */
  filePath: string | null
}

/**
 * Resolve, build and (for the out-of-band channels) write this launch's host
 * context.
 *
 * The design-system predicate is unchanged from the renderer's: the document
 * carries a design section when and only when `<executionRoot>/design-system/`
 * exists — deliberately KG-independent, so a repo with a design system and no
 * knowledge graph still gets told. A failed write degrades to no context rather
 * than to an empty flag: `--append-system-prompt-file ""` is worse than silence.
 */
function resolveHostContextDelivery(input: {
  cwd: string
  sessionId: string
  cli: AgentCli
  memoryRootPath?: string
  memoryRelativeRoot?: string
}): HostContextDelivery {
  const mode = getPluginManifest(input.cli)?.contextInjection?.mode ?? 'prompt'
  const bundlePath = join(input.cwd, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME)
  const attached = designSystemAttached(bundlePath)
  const document = buildHostContextDocument({
    ...(attached ? { designSystem: { bundlePath } } : {}),
    // `memoryRootPath` is set only when the configured root actually resolved,
    // so its presence IS the ok/not-ok the shared builder asks for — the same
    // pair the launch already carries into the session env.
    ...(input.memoryRootPath || input.memoryRelativeRoot
      ? {
          knowledge: {
            ok: Boolean(input.memoryRootPath),
            ...(input.memoryRootPath ? { rootPath: input.memoryRootPath } : {}),
            ...(input.memoryRelativeRoot ? { relativeRoot: input.memoryRelativeRoot } : {}),
          },
        }
      : {}),
  })
  if (!document || mode === 'prompt') return { mode, document, filePath: null }
  return { mode, document, filePath: writeHostContextFile(input.sessionId, input.cwd, document) }
}

/** Never let a probe failure (a permission error on the root) fail a launch. */
function designSystemAttached(bundlePath: string): boolean {
  try {
    return existsSync(bundlePath)
  } catch {
    return false
  }
}

/**
 * Write the document under `<userData>/host-context/<sessionId>.md`, overwriting
 * on every launch and resume. Returns null when it cannot be written (outside a
 * real Electron app there is no `userData`), which the caller reads as "deliver
 * nothing".
 *
 * A launch with no session id to name the file after is real: a bare
 * `codex resume` passes an empty id. It falls back to a digest of the execution
 * root, which is what the document is actually derived from anyway.
 */
function writeHostContextFile(sessionId: string, cwd: string, document: string): string | null {
  try {
    const directory = join(app.getPath('userData'), HOST_CONTEXT_DIRECTORY)
    const safeSessionId =
      sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
      || `cwd-${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`
    const filePath = join(directory, `${safeSessionId}.md`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(filePath, `${document}\n`, { encoding: 'utf8', mode: 0o600 })
    return filePath
  } catch {
    return null
  }
}

/** Reap a session's host-context document, mirroring the startup-script reap. */
export function cleanupHostContextFile(contextPath: string | undefined): void {
  if (!contextPath) return
  void unlink(contextPath).catch(() => {})
}

/**
 * The `contextFile` / `contextText` a manifest's templates render against, in
 * the path style this launch's shell speaks.
 *
 * Both are withheld together when the document could not be written, so a
 * manifest that spends `{{contextFile}}` never renders a flag with an empty
 * value. `contextText` is path-normalized too: it names the design-system folder
 * and the knowledge root absolutely, and a Windows path inside a document handed
 * to a CLI running under WSL points at nothing.
 */
/** What a manifest's `contextInjection` templates render against. */
export type HostContextRenderInputs = { contextFile?: string; contextText?: string }

export function hostContextRenderInputs(
  delivery: HostContextDelivery,
  target: 'windows' | 'wsl' | null,
  paths: Array<string | undefined>,
): HostContextRenderInputs {
  if (delivery.mode === 'prompt' || !delivery.document || !delivery.filePath) return {}
  if (!target) return { contextFile: delivery.filePath, contextText: delivery.document }
  const allPaths = [...paths, delivery.filePath]
  return {
    contextFile: target === 'wsl' ? toWslPath(delivery.filePath) : toWindowsPath(delivery.filePath),
    contextText: normalizeTextPaths(delivery.document, target, allPaths) ?? delivery.document,
  }
}

/**
 * The initial prompt for a CLI with no out-of-band channel at all: the document
 * wrapped in `<host-context>` tags, BEFORE the user's request.
 *
 * Only when there IS a request. A CLI launched with nothing typed is meant to
 * sit at its prompt waiting for the user; handing it a host-context block as its
 * first message would start it working on the host's words.
 */
export function applyHostContextToPrompt(
  delivery: HostContextDelivery,
  initialPrompt: string | undefined,
): string | undefined {
  if (delivery.mode !== 'prompt' || !delivery.document || !initialPrompt?.trim()) return initialPrompt
  return wrapHostContextForPrompt(delivery.document, initialPrompt)
}

function buildWslShellScript(
  cwd: string,
  sessionId: string,
  resume = false,
  sprintEngineStatePath?: string,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SprintEngineCliPermissionPreset = 'manual',
  cliModel?: string,
  memoryRootPath?: string,
  managedMcpEnv?: Record<string, string>,
  debugMode = false,
  providerLaunchEnv?: Record<string, string>,
  cliReasoning?: string,
  hostContext: HostContextRenderInputs = {}
): string {
  const shellInitialPrompt = normalizeTextPaths(initialPrompt, 'wsl', [cwd, sprintEngineStatePath, memoryRootPath])
  return [
    buildUserShellStartup(),
    `cd ${quotePosix(toWslPath(cwd))}`,
    buildSprintEngineShellBootstrap(sprintEngineStatePath, memoryRootPath, managedMcpEnv, providerLaunchEnv),
    buildAgentLaunchCommand(cli, sessionId, resume, shellInitialPrompt, cliRuntime, cliPermissionPreset, cliModel, debugMode, cliReasoning, undefined, hostContext, pluginDirsForLaunch(cli, 'wsl'), launchSettingsForLaunch(cli, cwd, 'wsl')),
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
  cliPermissionPreset: SprintEngineCliPermissionPreset = 'manual',
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

  // The host's own context for this launch (an attached design system, the
  // project's Knowledge Graph), built here so EVERY launcher gets the same
  // document — interactive, mobile, and the headless AgentLaunchService all
  // arrive at this function. The manifest's `contextInjection` decides the
  // channel; only the prompt fallback touches the user's message, and then only
  // by putting the block in front of it.
  const hostContext = resolveHostContextDelivery({
    cwd,
    sessionId,
    cli,
    ...(memoryRootPath ? { memoryRootPath } : {}),
    ...(memoryRelativeRoot ? { memoryRelativeRoot } : {}),
  })
  const launchPrompt = applyHostContextToPrompt(hostContext, initialPrompt)
  const hostContextPath = hostContext.filePath ?? undefined

  // CLI manifests may redirect the agent at an alternate API endpoint via
  // `launch.env` (e.g. the Z.AI runtime points the `claude` binary at Z.AI's
  // Anthropic-compatible endpoint). Render it once here with the resolved auth
  // token, then inject it into the spawned env (PTY env for native, bootstrap
  // exports for WSL). Empty for the ordinary CLIs, so their launch is unchanged.
  // A manifest delivering host context through the environment (OpenCode) is
  // rendered by the same call, so it rides the same injection.
  const providerLaunchEnv = renderCliLaunchEnv({
    cli,
    sessionId,
    initialPrompt: launchPrompt,
    cliRuntime,
    cliPermissionPreset,
    cliModel,
    cliReasoning,
    debugMode,
    colorScheme: getColorScheme(),
    secretToken: cliAuthToken,
    ...hostContextRenderInputs(hostContext, process.platform === 'win32' ? (cliRuntime.useWsl ? 'wsl' : 'windows') : null, [cwd, sprintEngineStatePath, memoryRootPath]),
  })

  if (process.platform === 'win32' && !cliRuntime.useWsl) {
    const windowsCwd = toWindowsPath(cwd)
    const windowsStatePath = sprintEngineStatePath ? toWindowsPath(sprintEngineStatePath) : undefined
    const windowsMemoryRootPath = memoryRootPath ? toWindowsPath(memoryRootPath) : undefined
    const windowsHostContext = hostContextRenderInputs(hostContext, 'windows', [cwd, sprintEngineStatePath, memoryRootPath])
    const shellInitialPrompt = normalizeTextPaths(launchPrompt, 'windows', [cwd, sprintEngineStatePath, memoryRootPath, hostContext.filePath ?? undefined])
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
        cliReasoning,
        windowsHostContext,
        pluginDirsForLaunch(cli, 'windows'),
        launchSettingsForLaunch(cli, cwd, 'windows')
      )
    )

    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', startupScriptPath],
      env: mergeProviderLaunchEnv(
        withSprintEngineEnv(getTerminalEnv(), windowsCwd, windowsStatePath, windowsMemoryRootPath, managedMcpEnv),
        providerLaunchEnv
      ),
      cwd: windowsCwd,
      pathStyle: 'windows',
      startupScriptPath,
      ...(hostContextPath ? { hostContextPath } : {}),
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
        launchPrompt,
        cliRuntime,
        cliPermissionPreset,
        cliModel,
        memoryRootPath,
        managedMcpEnv,
        debugMode,
        providerLaunchEnv,
        cliReasoning,
        hostContextRenderInputs(hostContext, 'wsl', [cwd, sprintEngineStatePath, memoryRootPath])
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
      ...(hostContextPath ? { hostContextPath } : {}),
    }
  }

  const shellPath = getPosixShellPath()
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const launchCommand = [
    buildSprintEngineShellBootstrap(sprintEngineStatePath, memoryRootPath, managedMcpEnv, providerLaunchEnv),
    buildAgentLaunchCommand(
      cli,
      sessionId,
      resume,
      launchPrompt,
      cliRuntime,
      cliPermissionPreset,
      cliModel,
      debugMode,
      cliReasoning,
      resolvedBinaryPath,
      hostContextRenderInputs(hostContext, null, []),
      pluginDirsForLaunch(cli, 'posix'),
      launchSettingsForLaunch(cli, cwd, 'posix')
    ),
    buildInteractiveShellExec(shellPath, shellName),
  ].join('; ')
  const startupScriptPath = createTerminalStartupScript(sessionId, 'sh', launchCommand)

  return {
    command: shellPath,
    args: isLoginShell(shellName) ? ['-l', startupScriptPath] : [startupScriptPath],
    cwd,
    env: mergeProviderLaunchEnv(
      withSprintEngineEnv(getTerminalEnv(), cwd, sprintEngineStatePath, memoryRootPath, managedMcpEnv),
      providerLaunchEnv
    ),
    pathStyle: 'posix',
    startupScriptPath,
    ...(hostContextPath ? { hostContextPath } : {}),
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
  // Only a shell pane gets shell integration — OSC 7 and OSC 133 alike. An
  // agent pane runs a CLI rather than a prompt (nothing would fire the hook),
  // and a fleet pane must not resolve a local path at all — so this is the one
  // launcher that arms it. The 133 marks are shell ergonomics and nothing else:
  // agent phase comes from `agent-state.ts` over the state socket, and no pane
  // ever derives it from what a shell printed.
  const shellIntegrationSetup = buildShellIntegrationSetup(
    shellName,
    shellName === 'zsh' ? ensureShellIntegrationZshZdotdir() : null,
  )
  const launchCommand = [
    buildSprintEngineShellBootstrap(sprintEngineStatePath),
    ...(shellIntegrationSetup ? [shellIntegrationSetup] : []),
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
  cliPermissionPreset: SprintEngineCliPermissionPreset = 'manual',
  cliModel?: string,
  debugMode = false,
  cliReasoning?: string,
  hostContext: HostContextRenderInputs = {},
  pluginDirs: string[] = [],
  launchSettings?: Record<string, unknown>
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
    workspaceRoot: cwd,
    initialPrompt,
    cliRuntime,
    cliPermissionPreset,
    cliModel,
    cliReasoning,
    debugMode,
    colorScheme: getColorScheme(),
    pluginDirs,
    ...(launchSettings ? { launchSettings } : {}),
    ...hostContext,
  })
  // argv[0] is the binary; the remainder are the arguments PowerShell needs
  // to base64-encode for round-trip safety through nested quoting layers.
  const args = argv.slice(1)
  return [
    `$ErrorActionPreference = 'Continue'`,
    `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
    `$command = ${quotePowerShell(binary)}`,
    `$arguments = @(${args.map((arg) => powerShellBase64Literal(arg)).join(', ')})`,
    ...buildNativeWindowsInvocation(args),
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
  cliPermissionPreset: SprintEngineCliPermissionPreset = 'manual',
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
    ? applyDebugDirective(initialPrompt ?? '', true, nativeInvocation, cwd)
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
  cliPermissionPreset: SprintEngineCliPermissionPreset = 'manual',
  cliModel?: string,
  debugMode = false,
  cliReasoning?: string,
  resolvedBinaryPath?: string,
  hostContext: HostContextRenderInputs = {},
  pluginDirs: string[] = [],
  launchSettings?: Record<string, unknown>
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
    pluginDirs,
    ...(launchSettings ? { launchSettings } : {}),
    ...hostContext,
  })
}
