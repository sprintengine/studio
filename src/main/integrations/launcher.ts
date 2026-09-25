// The Studio launcher: the one command every hook and MCP entry this app writes
// outside its own data directory runs.
//
// Why it exists. A hook or an MCP entry written into a repository (or into a
// CLI's user config) outlives the process that wrote it. Before this, each one
// named something that does not outlive the app: a bare `node` (an error on
// every event on a machine with no Node on PATH), a reporter copied into the
// workspace, the app's own executable run as Node, or a bridge inside one
// versioned app folder. Uninstall the app, or let an update prune that folder,
// and every session of that CLI in that checkout starts with a failing hook or
// an "MCP server failed to start".
//
// So every entry names a small script at a path that does not move —
// `~/.sprintengine/bin/studio-run` (a POSIX `sh` script) and, on Windows,
// `studio-run.cmd` beside it — and the script finds the app through a pointer
// file the app rewrites whenever it starts:
//
//   ~/.sprintengine/bin/current     node=<the Node to run>
//                                   run_as_node=<1 when that Node is the app's Electron>
//                                   payload=<the directory holding hooks/ and automation/>
//
// When the pointer, the Node or the script it names is missing, the launcher
// does the harmless thing instead of failing: a hook drains its stdin and exits
// 0, and the MCP target serves an MCP server with no tools — it answers
// `initialize` and lists nothing — so the CLI starts with one quiet server
// rather than an error about a missing one. One cost remains: a status line of
// the person's own that ours wraps (`--wrap`) shows nothing once the app is
// gone, because nothing is left to run it through — removing the app's
// integrations (Settings, or the Windows uninstaller) puts theirs back. A WSL
// distribution gets the same
// pair under its own home, pointing at the distribution's pinned Node and the
// helper's installed payload.
//
// The launcher is invoked through `/bin/sh` on POSIX rather than executed, so a
// file written into a distribution over `\\wsl.localhost` needs no execute bit.

import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join, posix, resolve, win32 } from 'node:path'

import { writeFileAtomically } from '../config-file-write'

/** The app's per-user directory under a home, which already holds `hooks/` for user-scoped reporters. */
export const STUDIO_HOME_DIR = '.sprintengine'
/** The launcher's directory, relative to the home. */
export const LAUNCHER_DIR_REL = `${STUDIO_HOME_DIR}/bin`
export const POSIX_LAUNCHER_NAME = 'studio-run'
export const WINDOWS_LAUNCHER_NAME = 'studio-run.cmd'
/** The PowerShell companion the Windows launcher runs as its no-tools MCP server. */
export const WINDOWS_EMPTY_MCP_NAME = 'studio-run-empty-mcp.ps1'
export const LAUNCHER_POINTER_NAME = 'current'

/**
 * What the launcher can run, by name. The names are the command's first
 * argument, so they are part of every entry already written: never rename one.
 */
export const LAUNCHER_TARGETS = {
  'agent-state': 'hooks/sprintengine-agent-state.mjs',
  'status-line': 'hooks/sprintengine-status-line.mjs',
  'knowledge-activity': 'hooks/claude-knowledge-activity.mjs',
  mcp: 'automation/mcp-stdio-bridge.mjs',
} as const

export type LauncherTarget = keyof typeof LAUNCHER_TARGETS

/** How a command naming the launcher is spelled: which shell reads it. */
export type LauncherShell = 'posix' | 'windows'

/** A launcher as a command names it: the script's path on the machine that runs it, and that machine's shell. */
export type StudioLauncherRef = {
  /** Absolute path of `studio-run` (POSIX) or `studio-run.cmd` (Windows), as the running shell names it. */
  path: string
  shell: LauncherShell
}

/** The launcher under `home`, for a machine whose shell is `shell`. `home` is a path on that machine. */
export function launcherRefForHome(home: string, shell: LauncherShell): StudioLauncherRef {
  if (shell === 'windows') {
    return { path: win32.join(home, STUDIO_HOME_DIR, 'bin', WINDOWS_LAUNCHER_NAME).split('\\').join('/'), shell }
  }
  return { path: posix.join(home, STUDIO_HOME_DIR, 'bin', POSIX_LAUNCHER_NAME), shell }
}

/** The launcher for this machine's own home. */
export function localLauncherRef(home: string, platform: NodeJS.Platform = process.platform): StudioLauncherRef {
  return launcherRefForHome(home, platform === 'win32' ? 'windows' : 'posix')
}

// Whether this machine's launcher could be written this run. A command naming a
// launcher that is not there fails on every event, which is worse than the
// older form that names this build directly; so when the write failed, writers
// fall back to that form until the next start tries again. True until told
// otherwise: the app says so at start, and a test never writes one.
let localLauncherWritten = true

export function setLocalLauncherWritten(written: boolean): void {
  localLauncherWritten = written
}

/** This machine's launcher, or null when it could not be written this run. */
export function usableLocalLauncherRef(
  home: string,
  platform: NodeJS.Platform = process.platform,
): StudioLauncherRef | null {
  return localLauncherWritten ? localLauncherRef(home, platform) : null
}

// ── Commands ────────────────────────────────────────────────────────────────

/** Single-quoted for a POSIX shell: nothing inside is ever expanded. */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`
}

// A Windows path any of the shells a CLI might run a hook under — cmd.exe,
// PowerShell, Git Bash — reads the same way unquoted.
const PLAIN_WINDOWS_PATH = /^[A-Za-z]:[A-Za-z0-9_./-]+$/u

/**
 * The hook command string for one target. POSIX runs the script through
 * `/bin/sh` and single-quotes everything. Windows names the `.cmd` directly,
 * unquoted whenever the path allows: a command line that STARTS with a quote is
 * one `cmd /c` strips the outer quotes from and PowerShell reads as a string
 * rather than a command. Only a home with a space in it gets the quoted form.
 * `env` puts variables in front on POSIX (a WSL launch's own).
 */
export function buildLauncherCommand(
  launcher: StudioLauncherRef,
  target: LauncherTarget,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
): string {
  if (launcher.shell === 'windows') {
    const quoted = args.map((arg) => (arg.startsWith('--') ? arg : `"${arg}"`))
    const program = PLAIN_WINDOWS_PATH.test(launcher.path) ? launcher.path : `"${launcher.path}"`
    return [program, target, ...quoted].join(' ')
  }
  const prefix = Object.entries(env).map(([key, value]) => `${key}=${quotePosix(value)}`)
  const quoted = args.map((arg) => (arg.startsWith('--') ? arg : quotePosix(arg)))
  return [
    ...(prefix.length > 0 ? ['env', ...prefix] : []),
    '/bin/sh',
    quotePosix(launcher.path),
    target,
    ...quoted,
  ].join(' ')
}

/** The MCP gateway as a stdio server: the program and its argv, no shell involved. */
export function buildLauncherMcpServer(launcher: StudioLauncherRef): { command: string; args: string[] } {
  if (launcher.shell === 'windows') {
    // A CLI built on Node cannot spawn a `.cmd` without a shell, so cmd.exe runs
    // it — the same route the app already uses for `npx` on Windows.
    return { command: 'cmd', args: ['/d', '/c', launcher.path.split('/').join('\\'), 'mcp'] }
  }
  return { command: '/bin/sh', args: [launcher.path, 'mcp'] }
}

const LAUNCHER_PATH_SUFFIX = /[\\/]\.sprintengine[\\/]bin[\\/]studio-run(?:\.cmd)?$/u

/** Whether a path names a Studio launcher (either spelling, any home). */
export function isLauncherPath(value: unknown): boolean {
  return typeof value === 'string' && LAUNCHER_PATH_SUFFIX.test(value.trim().replace(/^["']|["']$/gu, ''))
}

/** The command-string shape of a launcher hook for `target`: the launcher path (quoted or not), then the target. */
export function launcherCommandPattern(target: LauncherTarget): RegExp {
  return new RegExp(`\\/\\.sprintengine\\/bin\\/studio-run(?:\\.cmd)?["']? ${target}(?: |$)`, 'u')
}

/** Whether an MCP server entry (either `{command,args}` or OpenCode's command array) runs the launcher's MCP target. */
export function isLauncherMcpServer(entry: { command?: unknown; args?: unknown }): boolean {
  const argv = [
    ...(Array.isArray(entry.command) ? entry.command : [entry.command]),
    ...(Array.isArray(entry.args) ? entry.args : []),
  ]
  const index = argv.findIndex((part) => isLauncherPath(part))
  return index >= 0 && argv[index + 1] === 'mcp'
}

// ── The pointer ─────────────────────────────────────────────────────────────

export type LauncherPointer = {
  /** The Node executable, as the launcher's shell names it. */
  node: string
  /** True when `node` is the app's Electron binary, which runs as Node only with ELECTRON_RUN_AS_NODE. */
  runAsNode: boolean
  /** The directory the target scripts are relative to. */
  payload: string
  /** Whether a packaged build wrote it: a development build never replaces a packaged build's live pointer. */
  packaged: boolean
}

export function renderLauncherPointer(pointer: LauncherPointer): string {
  for (const value of [pointer.node, pointer.payload]) {
    if (/[\r\n]/u.test(value)) throw new Error('A launcher pointer path cannot contain a line break.')
  }
  return [
    `node=${pointer.node}`,
    `run_as_node=${pointer.runAsNode ? '1' : '0'}`,
    `payload=${pointer.payload}`,
    `packaged=${pointer.packaged ? '1' : '0'}`,
    '',
  ].join('\n')
}

export function parseLauncherPointer(text: string): LauncherPointer | null {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/u)) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1))
  }
  const node = fields.get('node') ?? ''
  const payload = fields.get('payload') ?? ''
  if (!node || !payload) return null
  return { node, payload, runAsNode: fields.get('run_as_node') === '1', packaged: fields.get('packaged') === '1' }
}

// ── The scripts ─────────────────────────────────────────────────────────────

/**
 * The no-tools MCP server, in `sh`: one `read` per message (never a block
 * read, which a pipe would stall on), fields taken with `grep -o` and `sed -E`,
 * both of which GNU, BSD and BusyBox userlands share. It answers what a client
 * asks before it lists anything — `initialize` (echoing the client's protocol
 * version), `ping`, and the three list calls — and refuses everything else
 * with "method not found". Notifications have no id and are not answered.
 */
const POSIX_EMPTY_MCP = String.raw`se_field() {
  printf '%s\n' "$1" | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|-?[0-9]+)" | head -n 1 | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*//'
}
se_empty_mcp() {
  while IFS= read -r line || [ -n "$line" ]; do
    id=$(se_field "$line" id)
    [ -n "$id" ] || continue
    method=$(se_field "$line" method)
    case "$method" in
      '"initialize"')
        version=$(se_field "$line" protocolVersion)
        [ -n "$version" ] || version='"2025-06-18"'
        result="{\"protocolVersion\":$version,\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"sprintengine-studio\",\"version\":\"0.0.0\"},\"instructions\":\"SprintEngine Studio is not installed on this machine, so this server offers no tools.\"}" ;;
      '"tools/list"') result='{"tools":[]}' ;;
      '"resources/list"') result='{"resources":[]}' ;;
      '"resources/templates/list"') result='{"resourceTemplates":[]}' ;;
      '"prompts/list"') result='{"prompts":[]}' ;;
      '"ping"') result='{}' ;;
      *) printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"SprintEngine Studio is not installed on this machine."}}\n' "$id"; continue ;;
    esac
    printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$result"
  done
  exit 0
}`

export function renderPosixLauncher(): string {
  const cases = Object.entries(LAUNCHER_TARGETS)
    .map(([target, script]) => `  ${target}) script='${script}' ;;`)
    .join('\n')
  return `#!/bin/sh
# SprintEngine Studio launcher. Written by the app; rewritten on every start.
#
# Every hook and MCP entry SprintEngine Studio writes into a repository or a
# CLI's configuration runs this script rather than naming the app directly, so
# none of them breaks when the app moves, updates or is uninstalled. It reads
# the app's location from ./${LAUNCHER_POINTER_NAME}. When the app is gone, a hook exits
# quietly and the MCP server offers no tools. Settings -> Remove integrations
# in the app removes every entry that names this file, and this file.
${POSIX_EMPTY_MCP}
target=\${1:-}
[ $# -gt 0 ] && shift
case "$target" in
${cases}
  *) cat >/dev/null 2>&1; exit 0 ;;
esac
dir=$(dirname "$0")
node=''
payload=''
run_as_node=0
if [ -f "$dir/${LAUNCHER_POINTER_NAME}" ]; then
  while IFS= read -r kv || [ -n "$kv" ]; do
    case "$kv" in
      node=*) node=\${kv#node=} ;;
      payload=*) payload=\${kv#payload=} ;;
      run_as_node=*) run_as_node=\${kv#run_as_node=} ;;
    esac
  done < "$dir/${LAUNCHER_POINTER_NAME}"
fi
if [ -z "$node" ] || [ ! -x "$node" ] || [ ! -f "$payload/$script" ]; then
  [ "$target" = mcp ] && se_empty_mcp
  cat >/dev/null 2>&1
  exit 0
fi
if [ "$run_as_node" = 1 ]; then
  ELECTRON_RUN_AS_NODE=1
  export ELECTRON_RUN_AS_NODE
fi
exec "$node" "$payload/$script" "$@"
`
}

/**
 * The Windows twin. cmd.exe has no `shift` that reaches `%*`, so the arguments
 * after the target are passed on positionally; every command this app writes
 * carries at most four. The no-tools MCP server is the PowerShell file beside
 * it, because cmd.exe cannot read JSON.
 */
export function renderWindowsLauncher(): string {
  const lines = [
    '@echo off',
    'rem SprintEngine Studio launcher. Written by the app; rewritten on every start.',
    'rem Every hook and MCP entry SprintEngine Studio writes runs this file, so none of',
    'rem them breaks when the app moves, updates or is uninstalled. Settings -> Remove',
    'rem integrations in the app removes every entry that names this file, and this file.',
    'setlocal',
    'set "SE_TARGET=%~1"',
    'set "SE_SCRIPT="',
    ...Object.entries(LAUNCHER_TARGETS).map(
      ([target, script]) => `if /i "%SE_TARGET%"=="${target}" set "SE_SCRIPT=${script.split('/').join('\\')}"`,
    ),
    // A target this launcher does not know (one a later build added) still
    // reads its input before it exits, like every other quiet path.
    'if not defined SE_SCRIPT findstr "^" >nul 2>&1',
    'if not defined SE_SCRIPT exit /b 0',
    'set "SE_NODE="',
    'set "SE_PAYLOAD="',
    'set "SE_RUN_AS_NODE="',
    // The pointer is UTF-8, and `for /f` decodes in the console's code page: a
    // home folder with a non-ASCII name would otherwise read as a path that
    // does not exist. The code page is put back afterwards.
    'set "SE_CP="',
    'for /f "tokens=2 delims=:" %%C in (\'chcp\') do set "SE_CP=%%C"',
    'if defined SE_CP set "SE_CP=%SE_CP: =%"',
    'if defined SE_CP set "SE_CP=%SE_CP:.=%"',
    'chcp 65001 >nul 2>&1',
    `if exist "%~dp0${LAUNCHER_POINTER_NAME}" for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0${LAUNCHER_POINTER_NAME}") do (`,
    '  if /i "%%A"=="node" set "SE_NODE=%%B"',
    '  if /i "%%A"=="payload" set "SE_PAYLOAD=%%B"',
    '  if /i "%%A"=="run_as_node" set "SE_RUN_AS_NODE=%%B"',
    ')',
    'if defined SE_CP chcp %SE_CP% >nul 2>&1',
    'if not defined SE_NODE goto missing',
    'if not exist "%SE_NODE%" goto missing',
    'if not exist "%SE_PAYLOAD%\\%SE_SCRIPT%" goto missing',
    'if "%SE_RUN_AS_NODE%"=="1" set "ELECTRON_RUN_AS_NODE=1"',
    '"%SE_NODE%" "%SE_PAYLOAD%\\%SE_SCRIPT%" %2 %3 %4 %5 %6 %7 %8 %9',
    'exit /b %ERRORLEVEL%',
    ':missing',
    `if /i "%SE_TARGET%"=="mcp" powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0${WINDOWS_EMPTY_MCP_NAME}"`,
    'if /i "%SE_TARGET%"=="mcp" exit /b 0',
    // A hook's input is read before it exits, so the CLI writing it never
    // meets a closed pipe.
    'findstr "^" >nul 2>&1',
    'exit /b 0',
    '',
  ]
  return lines.join('\r\n')
}

/** The Windows launcher's no-tools MCP server, for when the app is gone. */
export function renderWindowsEmptyMcp(): string {
  return [
    '# SprintEngine Studio: an MCP server with no tools, run when the app is not installed.',
    '# Written by the app beside studio-run.cmd; see that file.',
    '$ErrorActionPreference = "SilentlyContinue"',
    '$stdin = [Console]::In',
    '$stdout = [Console]::Out',
    'while ($null -ne ($line = $stdin.ReadLine())) {',
    '  try { $message = $line | ConvertFrom-Json } catch { continue }',
    '  if ($null -eq $message -or $null -eq $message.id) { continue }',
    '  $id = ConvertTo-Json -Compress -InputObject $message.id',
    // `continue` inside a `switch` only leaves the switch, so every branch sets
    // `$result` (reset here) and the one write below decides between the two.
    '  $result = $null',
    '  switch ($message.method) {',
    '    "initialize" {',
    '      $version = if ($message.params.protocolVersion) { [string]$message.params.protocolVersion } else { "2025-06-18" }',
    '      $result = @{ protocolVersion = $version; capabilities = @{ tools = @{} }; serverInfo = @{ name = "sprintengine-studio"; version = "0.0.0" }; instructions = "SprintEngine Studio is not installed on this machine, so this server offers no tools." } | ConvertTo-Json -Compress -Depth 5',
    '    }',
    '    "tools/list" { $result = \'{"tools":[]}\' }',
    '    "resources/list" { $result = \'{"resources":[]}\' }',
    '    "resources/templates/list" { $result = \'{"resourceTemplates":[]}\' }',
    '    "prompts/list" { $result = \'{"prompts":[]}\' }',
    '    "ping" { $result = "{}" }',
    '  }',
    '  if ($null -eq $result) {',
    '    $stdout.WriteLine(\'{"jsonrpc":"2.0","id":\' + $id + \',"error":{"code":-32601,"message":"SprintEngine Studio is not installed on this machine."}}\')',
    '  } else {',
    '    $stdout.WriteLine(\'{"jsonrpc":"2.0","id":\' + $id + \',"result":\' + $result + \'}\')',
    '  }',
    '  $stdout.Flush()',
    '}',
    '',
  ].join('\r\n')
}

// ── Writing them ────────────────────────────────────────────────────────────

/** Every file the launcher directory holds, for the machine whose shell is `shell`. */
export function launcherFiles(shell: LauncherShell): Array<{ name: string; content: string; executable: boolean }> {
  const files = [{ name: POSIX_LAUNCHER_NAME, content: renderPosixLauncher(), executable: true }]
  if (shell === 'windows') {
    files.push(
      { name: WINDOWS_LAUNCHER_NAME, content: renderWindowsLauncher(), executable: false },
      { name: WINDOWS_EMPTY_MCP_NAME, content: renderWindowsEmptyMcp(), executable: false },
    )
  }
  return files
}

/** The launcher directory under a home, as THIS process opens it (a `\\wsl.localhost` path for a distribution). */
export function launcherDirForHome(nativeHome: string): string {
  return join(nativeHome, STUDIO_HOME_DIR, 'bin')
}

async function writeIfDifferent(path: string, content: string, executable: boolean): Promise<boolean> {
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current === content) return false
  await writeFileAtomically(path, content)
  if (executable) await chmod(path, 0o755).catch(() => undefined)
  return true
}

export type EnsureLauncherResult = { dir: string; wrote: string[] }

/**
 * Write the launcher scripts (unchanged ones are left alone) and, when given,
 * the pointer. A development build does not replace a packaged build's pointer
 * while the Node it names still exists: the installed app is what outlives a
 * dev session, and hooks written by either run the same scripts.
 */
export async function ensureStudioLauncher(input: {
  /** The home, as this process opens it. */
  nativeHome: string
  shell: LauncherShell
  pointer?: LauncherPointer | null
  /** Whether `pointer.node` exists; injected for a distribution this process cannot stat through. Default: existsSync. */
  pointerTargetExists?: (pointer: LauncherPointer) => boolean
}): Promise<EnsureLauncherResult> {
  const dir = launcherDirForHome(input.nativeHome)
  await mkdir(dir, { recursive: true })
  const wrote: string[] = []
  for (const file of launcherFiles(input.shell)) {
    const path = join(dir, file.name)
    if (await writeIfDifferent(path, file.content, file.executable)) wrote.push(path)
  }
  if (input.pointer) {
    const pointerPath = join(dir, LAUNCHER_POINTER_NAME)
    const existing = parseLauncherPointer((await readFile(pointerPath, 'utf8').catch(() => null)) ?? '')
    const exists = input.pointerTargetExists ?? ((pointer: LauncherPointer) => existsSync(pointer.node))
    const keepPackaged = !input.pointer.packaged && existing?.packaged === true && exists(existing)
    if (!keepPackaged && (await writeIfDifferent(pointerPath, renderLauncherPointer(input.pointer), false))) {
      wrote.push(pointerPath)
    }
  }
  return { dir, wrote }
}

/** Whether a directory is the launcher directory of some home. */
export function isLauncherDir(path: string): boolean {
  return /[\\/]\.sprintengine[\\/]bin[\\/]?$/u.test(resolve(path))
}
