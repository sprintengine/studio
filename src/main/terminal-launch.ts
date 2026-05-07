import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { unlink } from 'fs/promises'
import { join } from 'path'
import type { AgentCli, CliRuntimeSettings, SwarmCliPermissionPreset } from '../shared/electron-api'

export type ShellLaunchConfig = {
  command: string
  args: string[]
  cwd?: string
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

  return env
}

function withSwarmEnv(
  env: Record<string, string>,
  cwd: string,
  swarmStatePath?: string,
  memoryRootPath?: string,
  memoryRelativeRoot?: string
): Record<string, string> {
  const bundledToolPath = getBundledSwarmToolPath()
  const soulsRoot = getBundledSoulsRoot()
  const nextEnv = {
    ...env,
    SPRINTENGINE_REPO_TOOL_PATH: join(cwd, '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
    SPRINTENGINE_REPO_WRAPPER_PATH: join(cwd, 'scripts', 'sprintengine_tool.py'),
    ...(bundledToolPath ? { MULTICODE_SPRINTENGINE_TOOL_PATH: bundledToolPath } : {}),
    ...(soulsRoot ? { MULTICODE_SOULS_ROOT: soulsRoot } : {}),
    ...(swarmStatePath ? { SPRINTENGINE_STATE_PATH: swarmStatePath } : {}),
    ...(memoryRootPath ? { MULTICODE_MEMORY_ROOT: memoryRootPath } : {}),
    ...(memoryRelativeRoot ? { MULTICODE_MEMORY_RELATIVE_ROOT: memoryRelativeRoot } : {}),
  }

  if (process.platform !== 'win32') return nextEnv

  const shimDirectory = ensureWindowsSwarmShimDirectory()
  if (!shimDirectory) return nextEnv

  const pathKey = Object.keys(nextEnv).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  return {
    ...nextEnv,
    [pathKey]: `${shimDirectory};${nextEnv[pathKey] ?? ''}`,
  }
}

function ensureWindowsSwarmShimDirectory(): string | null {
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
  preset: SwarmCliPermissionPreset = 'default'
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
  return {
    command: cliRuntimes?.[cli]?.command?.trim() || cli,
    useWsl: Boolean(cliRuntimes?.[cli]?.useWsl),
  }
}

function getBundledSwarmToolPath(): string | null {
  const candidates = [
    join(process.cwd(), '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
    join(app.getAppPath(), '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
    join(__dirname, '..', '..', '.agents', 'skills', 'sprintengine', 'scripts', 'sprintengine_tool.py'),
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

function buildSwarmShellBootstrap(
  swarmStatePath?: string,
  memoryRootPath?: string,
  memoryRelativeRoot?: string
): string {
  const shellStatePath =
    swarmStatePath && process.platform === 'win32' ? toWslPath(swarmStatePath) : swarmStatePath
  const shellMemoryRootPath =
    memoryRootPath && process.platform === 'win32' ? toWslPath(memoryRootPath) : memoryRootPath
  const bundledToolPath = getBundledSwarmToolPath()
  const soulsRoot = getBundledSoulsRoot()
  const shellBundledToolPath =
    bundledToolPath && process.platform === 'win32' ? toWslPath(bundledToolPath) : bundledToolPath
  const shellSoulsRoot =
    soulsRoot && process.platform === 'win32' ? toWslPath(soulsRoot) : soulsRoot
  const lines = [
    'export SPRINTENGINE_REPO_TOOL_PATH="$PWD/.agents/skills/sprintengine/scripts/sprintengine_tool.py"',
    'export SPRINTENGINE_REPO_WRAPPER_PATH="$PWD/scripts/sprintengine_tool.py"',
  ]

  if (shellStatePath) {
    lines.push(`export SPRINTENGINE_STATE_PATH=${quotePosix(shellStatePath)}`)
  }

  if (shellMemoryRootPath) {
    lines.push(`export MULTICODE_MEMORY_ROOT=${quotePosix(shellMemoryRootPath)}`)
  }

  if (memoryRelativeRoot) {
    lines.push(`export MULTICODE_MEMORY_RELATIVE_ROOT=${quotePosix(memoryRelativeRoot)}`)
  }

  if (shellBundledToolPath) {
    lines.push(`export MULTICODE_SPRINTENGINE_TOOL_PATH=${quotePosix(shellBundledToolPath)}`)
  }

  if (shellSoulsRoot) {
    lines.push(`export MULTICODE_SOULS_ROOT=${quotePosix(shellSoulsRoot)}`)
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
      'if [ -x "$PWD/.venv/bin/python" ]; then python_exe="$PWD/.venv/bin/python";',
      'elif [ -x "$PWD/.venv/Scripts/python.exe" ]; then python_exe="$PWD/.venv/Scripts/python.exe"; fi;',
      '"$python_exe" "$tool_path" "$@";',
      '}',
    ].join(' '),
    'export -f sprintengine >/dev/null 2>&1 || true',
    [
      'souls() {',
      'local python_exe="python3";',
      'if [ -x "$PWD/.venv/bin/python" ]; then python_exe="$PWD/.venv/bin/python";',
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
  swarmStatePath?: string,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default',
  memoryRootPath?: string,
  memoryRelativeRoot?: string
): string {
  const shellInitialPrompt = normalizeInitialPromptPaths(initialPrompt, 'wsl', [cwd, swarmStatePath, memoryRootPath])
  return [
    buildUserShellStartup(),
    `cd ${quotePosix(toWslPath(cwd))}`,
    buildSwarmShellBootstrap(swarmStatePath, memoryRootPath, memoryRelativeRoot),
    buildAgentLaunchCommand(cli, sessionId, resume, shellInitialPrompt, cliRuntime, cliPermissionPreset),
    'exec bash -li',
  ].join('; ')
}

export function getShellLaunchConfig(
  cwd: string,
  sessionId: string,
  resume = false,
  swarmStatePath?: string,
  cli: AgentCli = 'codex',
  initialPrompt?: string,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default',
  memoryRootPath?: string,
  memoryRelativeRoot?: string
): ShellLaunchConfig {
  const cliRuntime = getCliRuntimeSettings(cli, cliRuntimes)

  if (process.platform === 'win32' && !cliRuntime.useWsl) {
    const windowsCwd = toWindowsPath(cwd)
    const windowsStatePath = swarmStatePath ? toWindowsPath(swarmStatePath) : undefined
    const windowsMemoryRootPath = memoryRootPath ? toWindowsPath(memoryRootPath) : undefined
    const shellInitialPrompt = normalizeInitialPromptPaths(initialPrompt, 'windows', [cwd, swarmStatePath, memoryRootPath])
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
        cliPermissionPreset
      )
    )

    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', startupScriptPath],
      env: withSwarmEnv(getTerminalEnv(), windowsCwd, windowsStatePath, windowsMemoryRootPath, memoryRelativeRoot),
      cwd: windowsCwd,
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
        swarmStatePath,
        cli,
        initialPrompt,
        cliRuntime,
        cliPermissionPreset,
        memoryRootPath,
        memoryRelativeRoot
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
      startupScriptPath,
    }
  }

  const shellPath = process.env.SHELL || 'bash'
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const launchCommand = [
    buildSwarmShellBootstrap(swarmStatePath, memoryRootPath, memoryRelativeRoot),
    buildAgentLaunchCommand(cli, sessionId, resume, initialPrompt, cliRuntime, cliPermissionPreset),
    buildInteractiveShellExec(shellPath, shellName),
  ].join('; ')
  const startupScriptPath = createTerminalStartupScript(sessionId, 'sh', launchCommand)

  return {
    command: shellPath,
    args: isLoginShell(shellName) ? ['-l', startupScriptPath] : [startupScriptPath],
    cwd,
    env: withSwarmEnv(getTerminalEnv(), cwd, swarmStatePath, memoryRootPath, memoryRelativeRoot),
    startupScriptPath,
  }
}

export function getPlainShellLaunchConfig(
  cwd: string,
  swarmStatePath?: string,
  sessionId = 'plain-terminal'
): ShellLaunchConfig {
  if (process.platform === 'win32') {
    const windowsCwd = toWindowsPath(cwd)
    const windowsStatePath = swarmStatePath ? toWindowsPath(swarmStatePath) : undefined

    if (isNativeWindowsPath(windowsCwd)) {
      return {
        command: 'powershell.exe',
        args: ['-NoLogo'],
        env: withSwarmEnv(getTerminalEnv(), windowsCwd, windowsStatePath),
        cwd: windowsCwd,
      }
    }

    const startupScriptPath = createTerminalStartupScript(
      sessionId,
      'sh',
      [
        buildUserShellStartup(),
        `cd ${quotePosix(toWslPath(cwd))}`,
        buildSwarmShellBootstrap(swarmStatePath),
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
      startupScriptPath,
    }
  }

  const shellPath = process.env.SHELL || 'bash'
  const shellName = shellPath.split(/[\\/]/).at(-1)
  const launchCommand = [
    buildSwarmShellBootstrap(swarmStatePath),
    buildInteractiveShellExec(shellPath, shellName),
  ].join('; ')
  const startupScriptPath = createTerminalStartupScript(sessionId, 'sh', launchCommand)

  return {
    command: shellPath,
    cwd,
    args: isLoginShell(shellName) ? ['-l', startupScriptPath] : [startupScriptPath],
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
  cliPermissionPreset: SwarmCliPermissionPreset = 'default'
): string {
  const permissionArgs = getCliPermissionArgs(cli, cliPermissionPreset)
  const command = cliRuntime.command || cli
  const promptArg = cli === 'codex' ? nativeWindowsCodexPromptArg(initialPrompt) : initialPrompt
  const args = cli === 'codex'
    ? [
        ...permissionArgs,
        ...(resume ? ['resume'] : []),
        '-C',
        cwd,
        ...(!resume && promptArg ? [promptArg] : []),
      ]
    : [
        ...permissionArgs,
        resume ? '--resume' : '--session-id',
        sessionId,
        ...(promptArg ? [promptArg] : []),
      ]

  return [
    `$ErrorActionPreference = 'Continue'`,
    `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
    `$command = ${quotePowerShell(command)}`,
    `$arguments = @(${args.map((arg) => powerShellBase64Literal(arg)).join(', ')})`,
    ...(cli === 'codex' ? [
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
    ] : []),
    `& $command @arguments`,
  ].join('\r\n')
}

function buildAgentLaunchCommand(
  cli: AgentCli,
  sessionId: string,
  resume = false,
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default'
): string {
  if (cli === 'claude') {
    return buildClaudeLaunchCommand(sessionId, resume, initialPrompt, cliRuntime, cliPermissionPreset)
  }
  return buildCodexLaunchCommand(resume, initialPrompt, cliRuntime, cliPermissionPreset)
}

function buildCommandAvailabilityCheck(cli: AgentCli, command: string): string {
  return [
    `if ! command -v ${quotePosixCommand(command)} >/dev/null 2>&1; then`,
    `echo ${quotePosix(`${cli === 'codex' ? 'Codex' : 'Claude'} CLI was not found. Check the ${cli} command in Multicode Settings.`)};`,
    'else',
  ].join(' ')
}

function buildCodexLaunchCommand(
  resume = false,
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default'
): string {
  const promptArg = initialPrompt ? ` ${quotePosix(initialPrompt)}` : ''
  const configuredCommand = cliRuntime?.command?.trim()
  const permissionArgs = getCliPermissionArgs('codex', cliPermissionPreset).map(quotePosixCommand)
  const permissionArgText = permissionArgs.length ? ` ${permissionArgs.join(' ')}` : ''

  return [
    buildCommandAvailabilityCheck('codex', configuredCommand || 'codex'),
    resume
      ? `${quotePosixCommand(configuredCommand || 'codex')}${permissionArgText} resume;`
      : `${quotePosixCommand(configuredCommand || 'codex')}${permissionArgText}${promptArg};`,
    'fi',
  ].join(' ')
}

function buildClaudeLaunchCommand(
  sessionId: string,
  resume = false,
  initialPrompt?: string,
  cliRuntime?: CliRuntimeSettings,
  cliPermissionPreset: SwarmCliPermissionPreset = 'default'
): string {
  const quotedSessionId = quotePosix(sessionId)
  const claudeCommand = quotePosixCommand(cliRuntime?.command?.trim() || 'claude')
  const configuredCommand = cliRuntime?.command?.trim() || 'claude'
  const promptArg = initialPrompt ? ` ${quotePosix(initialPrompt)}` : ''
  const permissionArgs = getCliPermissionArgs('claude', cliPermissionPreset).map(quotePosixCommand)
  const permissionArgText = permissionArgs.length ? ` ${permissionArgs.join(' ')}` : ''

  if (!resume) {
    return [
      buildCommandAvailabilityCheck('claude', configuredCommand),
      `${claudeCommand}${permissionArgText} --session-id ${quotedSessionId}${promptArg};`,
      'fi',
    ].join(' ')
  }

  // Some panes get a generated session id before the user actually starts a Claude
  // conversation. In that case there is nothing persisted to resume yet, so fall
  // back to starting a fresh session with the same id instead of surfacing the
  // "No conversation found" error on every app launch.
  return [
    buildCommandAvailabilityCheck('claude', configuredCommand),
    `if find "$HOME/.claude/projects" -type f -name ${quotePosix(`${sessionId}.jsonl`)} -print -quit 2>/dev/null | grep -q .; then`,
    `${claudeCommand}${permissionArgText} --resume ${quotedSessionId}${promptArg};`,
    `else`,
    `${claudeCommand}${permissionArgText} --session-id ${quotedSessionId}${promptArg};`,
    `fi`,
    'fi',
  ].join(' ')
}
