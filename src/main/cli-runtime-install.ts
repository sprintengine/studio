import type {
  AgentCli,
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliRuntimeSettings,
} from '../shared/electron-api'
import type { PluginInstallMethod, PluginInstallPlatform, PluginManifest } from '../shared/plugin-manifest'
import { getPluginManifest } from './plugin-registry-instance'
import { chooseCliUpdateCommand } from './cli-version-advisory'
import { currentRuntimeEnv, ensureManagedRuntimeShims, withManagedRuntimePath } from './managed-runtime'
import { runSpawnDescriptor, type RunOutcome, type SpawnDescriptor } from './process-run'
import { knownDefaultWslDistro, resolveDefaultWslDistro, wslLoginScript, wslScriptDescriptor } from './wsl-host'
import { createLoginShellPathResolver, findExecutable, searchDirectories } from './login-shell-path'

// Exit code our probe scripts use to signal "binary not found on PATH" so we
// can distinguish a missing CLI from a CLI that exists but whose --version
// failed for some other reason.
const NOT_FOUND_EXIT = 3
const PATH_SENTINEL = 'SPRINTENGINE_PATH:'

export type { SpawnDescriptor }

// Maps the OS platform + per-CLI WSL override onto the manifest install bucket.
// WSL is a logical target (Windows host, POSIX guest) distinct from win32.
export function resolveInstallPlatform(platform: NodeJS.Platform, useWsl: boolean): PluginInstallPlatform {
  if (platform === 'win32') return useWsl ? 'wsl' : 'win32'
  if (platform === 'darwin') return 'darwin'
  // Treat any other POSIX-like platform (linux, and uncommon ones) as linux.
  return 'linux'
}

// Reads the default distribution's name before a WSL descriptor is built, so
// the descriptor can pass it to `-d`. Cached, so only the first call starts
// `wsl.exe`; a failed read leaves the descriptor without `-d`, which is the
// default distribution anyway.
async function knowWslDistro(target: PluginInstallPlatform): Promise<void> {
  if (target === 'wsl') await resolveDefaultWslDistro().catch(() => null)
}

function isPosixTarget(target: PluginInstallPlatform): boolean {
  return target === 'darwin' || target === 'linux' || target === 'wsl'
}

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Wraps a shell snippet in the right host shell for the target. POSIX targets
// run through a login shell so user-local install dirs (~/.local/bin, npm
// global prefix) are on PATH. WSL routes through wsl.exe into the default
// distribution by name, with the script on stdin (see wsl-host.ts for why
// never on the command line); its stdin is closed for everything the script
// runs, so a command that reads input cannot swallow the rest of the script.
function shellDescriptorForScript(target: PluginInstallPlatform, script: string): SpawnDescriptor {
  if (target === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    }
  }
  if (target === 'wsl') {
    return wslScriptDescriptor(knownDefaultWslDistro(), wslLoginScript(`{\n${script}\n} </dev/null`))
  }
  return { file: 'bash', args: ['-lc', script] }
}

// Builds a script that prints the resolved path and version, or exits
// NOT_FOUND_EXIT when the binary is not on PATH.
export function buildProbeDescriptor(input: {
  binary: string
  versionArgs: string[]
  target: PluginInstallPlatform
}): SpawnDescriptor {
  const { binary, versionArgs, target } = input
  if (isPosixTarget(target)) {
    const bin = posixSingleQuote(binary)
    const versionPart = versionArgs.map(posixSingleQuote).join(' ')
    const script = [
      `command -v ${bin} >/dev/null 2>&1 || exit ${NOT_FOUND_EXIT}`,
      `printf '${PATH_SENTINEL}%s\\n' "$(command -v ${bin})"`,
      `${bin} ${versionPart} 2>&1 || true`,
    ].join('\n')
    return shellDescriptorForScript(target, script)
  }
  const bin = powerShellSingleQuote(binary)
  const versionPart = versionArgs.map(powerShellSingleQuote).join(' ')
  const script = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$c = Get-Command ${bin}`,
    `if (-not $c) { exit ${NOT_FOUND_EXIT} }`,
    `'${PATH_SENTINEL}' + $c.Source`,
    `& ${bin} ${versionPart} 2>&1`,
  ].join('\n')
  return shellDescriptorForScript(target, script)
}

// Builds a script that exits NOT_FOUND_EXIT when a prerequisite binary (npm,
// brew, curl, …) is absent, without invoking it.
export function buildExistsDescriptor(input: { binary: string; target: PluginInstallPlatform }): SpawnDescriptor {
  const { binary, target } = input
  if (isPosixTarget(target)) {
    const bin = posixSingleQuote(binary)
    return shellDescriptorForScript(target, `command -v ${bin} >/dev/null 2>&1 || exit ${NOT_FOUND_EXIT}`)
  }
  const bin = powerShellSingleQuote(binary)
  return shellDescriptorForScript(
    target,
    `if (-not (Get-Command ${bin} -ErrorAction SilentlyContinue)) { exit ${NOT_FOUND_EXIT} }`,
  )
}

// Builds the descriptor that runs an install method's command verbatim in the
// target shell.
export function buildInstallDescriptor(input: { shell: string; target: PluginInstallPlatform }): SpawnDescriptor {
  return shellDescriptorForScript(input.target, input.shell)
}

export function parseProbeOutput(
  code: number,
  stdout: string,
): { installed: boolean; version: string | null; resolvedPath: string | null } {
  if (code === NOT_FOUND_EXIT) {
    return { installed: false, version: null, resolvedPath: null }
  }
  let resolvedPath: string | null = null
  const versionLines: string[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith(PATH_SENTINEL)) {
      resolvedPath = line.slice(PATH_SENTINEL.length).trim() || null
      continue
    }
    versionLines.push(line)
  }
  // First non-path line that carries a version-looking token, else the first
  // line, else null.
  const version = versionLines.find((line) => /\d+\.\d+/.test(line)) ?? versionLines[0] ?? null
  return { installed: true, version, resolvedPath }
}

function runDescriptor(
  desc: SpawnDescriptor,
  onData?: (chunk: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  // When set, the child is killed at the deadline and the outcome reads as
  // not-found — a probe that hangs (e.g. a slow interactive shell profile)
  // must never wedge the caller. Callers that must tell "no such binary" from
  // "the probe never answered" read the outcome's `timedOut` instead.
  timeoutMs?: number,
): Promise<RunOutcome> {
  return runSpawnDescriptor(desc, {
    ...(onData ? { onData } : {}),
    env,
    ...(timeoutMs ? { timeoutMs } : {}),
    timedOutCode: NOT_FOUND_EXIT,
  })
}

function resolveBinary(manifest: PluginManifest, runtime?: Partial<CliRuntimeSettings>): string {
  const override = typeof runtime?.command === 'string' ? runtime.command.trim() : ''
  return override || manifest.binary
}

// Builds the environment used to run install commands (and the post-install
// re-detect): the managed `node`/`npm` shims and the writable npm prefix bin
// are prepended to PATH so npm-based installs (e.g. Codex) work with no user
// Node, and the freshly installed binary is discoverable on the next probe.
// Returns null when no managed runtime is vendored, so callers fall back to the
// user's own PATH unchanged.
function stringProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

// Probes run shells whose profiles we do not control, and CLIs whose
// `--version` we do not control either; a hard deadline keeps a pathological
// config (a ~/.bash_profile that starts tmux, prompts, or waits on a network
// mount) or a hung binary from wedging provider listing or availability checks.
const PROBE_TIMEOUT_MS = 10_000

function managedInstallEnv(): Record<string, string> | null {
  const runtimeEnv = currentRuntimeEnv()
  const shims = ensureManagedRuntimeShims(runtimeEnv)
  if (!shims) return null
  const withShims = withManagedRuntimePath(stringProcessEnv(), shims.shimDir, runtimeEnv.platform)
  return withManagedRuntimePath(withShims, shims.prefixBinDir, runtimeEnv.platform)
}

export type ProbeVerdict = {
  parsed: ReturnType<typeof parseProbeOutput>
  // True when a probe was killed at its deadline, so an "absent" parse is a
  // non-answer rather than a verdict.
  inconclusive: boolean
}

// The login-shell PATH for the whole app session (see login-shell-path.ts): one
// shell answers it, every binary lookup after that is done in this process.
const loginShellPath = createLoginShellPathResolver({
  run: (descriptor, env) => runDescriptor(descriptor, undefined, env, descriptor.timeoutMs),
  shell: () => process.env.SHELL,
})

/**
 * Drop the session's login-shell PATH so the next probe asks a shell again.
 * Called on a forced availability refresh and before the re-detect that follows
 * an install or update: an installer is exactly what appends a directory to
 * `~/.zshrc`, and the verdict after it must see that directory.
 */
export function invalidateLoginShellPath(): void {
  loginShellPath.invalidate()
}

/**
 * The session's login-shell PATH, for another process the app starts on the
 * person's behalf with the tools their terminal would find (the worktree
 * pool's dependency installs). Shared with the CLI probes: one shell answers.
 */
export function resolveSessionLoginPath(env: NodeJS.ProcessEnv): Promise<string | null> {
  return loginShellPath.resolve(env)
}

// Host macOS/Linux: resolve the binary against the session's login-shell PATH
// in this process, then run only the binary itself for its version. That is
// one process per INSTALLED CLI and none for an absent one, where this used to
// be a login shell per CLI and a second, interactive one for every CLI bash
// could not see.
async function runHostVersionProbe(input: {
  binary: string
  versionArgs: string[]
  env: NodeJS.ProcessEnv
}): Promise<ProbeVerdict> {
  const { binary, versionArgs, env } = input
  const loginPath = await loginShellPath.resolve(env)
  const directories = searchDirectories(loginPath, env.PATH)
  const resolvedPath = await findExecutable(binary, directories)
  if (!resolvedPath) {
    // Absent from the process PATH alone is not a verdict: that PATH is the one
    // a Dock launch gets, without anything the person's shell config adds.
    return { parsed: { installed: false, version: null, resolvedPath: null }, inconclusive: loginPath === null }
  }
  // The binary is run with the PATH it was found on, so a `#!/usr/bin/env node`
  // script finds the same `node` a terminal would give it.
  const outcome = await runDescriptor(
    { file: resolvedPath, args: versionArgs },
    undefined,
    { ...env, PATH: directories.join(':') },
    PROBE_TIMEOUT_MS,
  )
  // Found, whatever `--version` did: the shell probe ignored its exit code too
  // (`|| true`). A binary that would not start or answered nothing is installed
  // with no version, never "not installed".
  const printed = outcome.spawnFailed ? '' : `${outcome.stdout}\n${outcome.stderr}`
  const parsed = parseProbeOutput(0, `${PATH_SENTINEL}${resolvedPath}\n${printed}`)
  return { parsed, inconclusive: false }
}

// Windows and WSL: the shell probe, unchanged: `command -v` inside WSL's login
// bash, or `Get-Command` in PowerShell.
async function runShellVersionProbe(input: {
  binary: string
  versionArgs: string[]
  target: PluginInstallPlatform
  env: NodeJS.ProcessEnv
}): Promise<ProbeVerdict> {
  const { binary, versionArgs, target, env } = input
  const outcome = await runDescriptor(
    buildProbeDescriptor({ binary, versionArgs, target }),
    undefined,
    env,
    PROBE_TIMEOUT_MS,
  )
  return { parsed: parseProbeOutput(outcome.code, outcome.stdout), inconclusive: outcome.timedOut }
}

function isHostPosixTarget(target: PluginInstallPlatform): boolean {
  return target === 'darwin' || target === 'linux'
}

async function runVersionProbe(input: {
  binary: string
  versionArgs: string[]
  target: PluginInstallPlatform
  env: NodeJS.ProcessEnv
}): Promise<ProbeVerdict> {
  return isHostPosixTarget(input.target) ? runHostVersionProbe(input) : runShellVersionProbe(input)
}

// PATH augmentation matching what terminal launches get (the managed runtime
// shims), so a managed install is never invisible to a probe.
export function defaultProbeEnv(): NodeJS.ProcessEnv {
  return managedInstallEnv() ?? stringProcessEnv()
}

// Runs an installed CLI with fixed arguments through the same host shell the
// version probe uses (login bash on POSIX, PowerShell on Windows, wsl.exe for a
// WSL runtime), so a command that detection found is the command that runs.
// POSIX `exec`s the binary so the deadline's kill reaches the CLI itself rather
// than only the shell wrapped around it; PowerShell hands the CLI's own exit
// code back. Model discovery is the caller: `codex debug models` and siblings.
export function buildCommandDescriptor(input: {
  binary: string
  args: string[]
  target: PluginInstallPlatform
}): SpawnDescriptor {
  const { binary, args, target } = input
  if (isPosixTarget(target)) {
    return shellDescriptorForScript(target, `exec ${[binary, ...args].map(posixSingleQuote).join(' ')}`)
  }
  const argv = [binary, ...args].map(powerShellSingleQuote).join(' ')
  return shellDescriptorForScript(target, `& ${argv}\nexit $LASTEXITCODE`)
}

export type CliCommandOutcome = RunOutcome

export async function runCliCommand(input: {
  binary: string
  args: string[]
  useWsl: boolean
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}): Promise<CliCommandOutcome> {
  const target = resolveInstallPlatform(process.platform, input.useWsl)
  await knowWslDistro(target)
  return runDescriptor(
    buildCommandDescriptor({ binary: input.binary, args: input.args, target }),
    undefined,
    input.env ?? defaultProbeEnv(),
    input.timeoutMs,
  )
}

// Outcome of probing a binary the app does not manage as an Agent CLI (`git`,
// `gh`). The three cases stay distinct: a probe that could not answer is never
// reported as a missing binary, and a resolved outcome always carries a real
// version line.
export type BinaryVersionProbe =
  | { outcome: 'resolved'; version: string; resolvedPath: string | null }
  | { outcome: 'not_installed' }
  | { outcome: 'probe_failed' }

// Exported so the branch that keeps a killed probe out of the not-installed
// bucket is directly asserted; probeBinaryVersion is the only caller.
export function binaryVersionProbeFrom({ parsed, inconclusive }: ProbeVerdict): BinaryVersionProbe {
  if (!parsed.installed) return inconclusive ? { outcome: 'probe_failed' } : { outcome: 'not_installed' }
  // Resolved without a version line means the probe ran but told us nothing
  // usable; reporting success with an empty version would put a placeholder on
  // screen.
  if (!parsed.version) return { outcome: 'probe_failed' }
  return { outcome: 'resolved', version: parsed.version, resolvedPath: parsed.resolvedPath }
}

export async function probeBinaryVersion(binary: string): Promise<BinaryVersionProbe> {
  try {
    return binaryVersionProbeFrom(
      await runVersionProbe({
        binary,
        versionArgs: ['--version'],
        target: resolveInstallPlatform(process.platform, false),
        env: defaultProbeEnv(),
      }),
    )
  } catch {
    return { outcome: 'probe_failed' }
  }
}

// ── Batched detection (Windows and WSL) ─────────────────────────────────────
//
// On Windows every probe is a `powershell.exe` or a `wsl.exe` login shell, each
// a second or more to start, and the registry holds around ten CLIs. Probing
// them one process each cost ten such starts per refresh. A batch asks about
// every CLI for one target in ONE process: a single login shell in the
// distribution, or a single PowerShell. The CLIs' `--version` calls run side by
// side inside it, each with its own deadline, so one slow CLI costs its own
// answer and not everyone's.

const BATCH_BLOCK_MARKER = '@@SPRINTENGINE_CLI '
const BATCH_NOT_FOUND = '@@SPRINTENGINE_NOT_FOUND'
const BATCH_TIMED_OUT = '@@SPRINTENGINE_TIMED_OUT'
// Each CLI's `--version` inside the batch.
export const BATCH_PER_CLI_TIMEOUT_MS = 8_000
// The whole batch: a login shell or PowerShell start, then the slowest CLI.
const BATCH_TIMEOUT_MS = 25_000

export type BatchProbeRequest = { binary: string; versionArgs: string[] }
export type BatchProbeAnswer = ReturnType<typeof parseProbeOutput> | { error: string }

function posixBatchProbeScript(requests: readonly BatchProbeRequest[], perCliTimeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(perCliTimeoutMs / 1000))
  return [
    // `timeout` is coreutils and nearly always present; without it the batch
    // deadline still bounds the run.
    `T=''; command -v timeout >/dev/null 2>&1 && T='timeout -k 2 ${seconds}'`,
    `d="$(mktemp -d 2>/dev/null)" || d="/tmp/sprintengine-probe-$$"; mkdir -p "$d"`,
    'probe() {',
    '  i="$1"; b="$2"; shift 2',
    `  p="$(command -v "$b" 2>/dev/null)" || { printf '%s\\n' '${BATCH_NOT_FOUND}' > "$d/$i"; return; }`,
    `  { printf '${PATH_SENTINEL}%s\\n' "$p"; $T "$b" "$@" </dev/null 2>&1; [ $? -eq 124 ] && printf '%s\\n' '${BATCH_TIMED_OUT}'; } > "$d/$i"`,
    '}',
    ...requests.map(
      (request, index) =>
        `probe ${index} ${[request.binary, ...request.versionArgs].map(posixSingleQuote).join(' ')} &`,
    ),
    'wait',
    `for i in ${requests.map((_, index) => index).join(' ')}; do printf '${BATCH_BLOCK_MARKER}%s\\n' "$i"; cat "$d/$i" 2>/dev/null; done`,
    'rm -rf "$d"',
  ].join('\n')
}

function powerShellBatchProbeScript(requests: readonly BatchProbeRequest[], perCliTimeoutMs: number): string {
  const list = requests
    .map(
      (request) =>
        `@{ b = ${powerShellSingleQuote(request.binary)}; a = @(${request.versionArgs.map(powerShellSingleQuote).join(', ')}) }`,
    )
    .join(', ')
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `$requests = @(${list})`,
    // Every found CLI's `--version` starts in its own runspace inside this one
    // process, so they run side by side and each can be abandoned alone.
    `$jobs = @()`,
    `foreach ($r in $requests) {`,
    `  $c = Get-Command $r.b | Select-Object -First 1`,
    `  if (-not $c) { $jobs += ,@{ found = $false }; continue }`,
    `  $ps = [PowerShell]::Create()`,
    `  [void]$ps.AddScript({ param($b, $a) & $b @a 2>&1 | Out-String -Width 4096 }).AddArgument($r.b).AddArgument($r.a)`,
    `  $jobs += ,@{ found = $true; source = $c.Source; ps = $ps; handle = $ps.BeginInvoke() }`,
    `}`,
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${perCliTimeoutMs})`,
    `for ($i = 0; $i -lt $jobs.Count; $i++) {`,
    `  '${BATCH_BLOCK_MARKER}' + $i`,
    `  $j = $jobs[$i]`,
    `  if (-not $j.found) { '${BATCH_NOT_FOUND}'; continue }`,
    `  '${PATH_SENTINEL}' + $j.source`,
    `  $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)`,
    `  if ($j.handle.AsyncWaitHandle.WaitOne($left)) { try { $j.ps.EndInvoke($j.handle) } catch {} }`,
    `  else { '${BATCH_TIMED_OUT}'; [void]$j.ps.BeginStop($null, $null) }`,
    `}`,
    `exit 0`,
  ].join('\n')
}

/**
 * One process that probes every request for a Windows-side target: a login
 * shell in the distribution for `wsl`, a PowerShell for `win32`. The output is
 * one block per request, in order, read by `parseBatchProbeOutput`.
 */
export function buildBatchProbeDescriptor(input: {
  requests: readonly BatchProbeRequest[]
  target: 'wsl' | 'win32'
  distro?: string | null
  perCliTimeoutMs?: number
}): SpawnDescriptor {
  const perCliTimeoutMs = input.perCliTimeoutMs ?? BATCH_PER_CLI_TIMEOUT_MS
  if (input.target === 'wsl') {
    return wslScriptDescriptor(
      input.distro ?? null,
      wslLoginScript(`{\n${posixBatchProbeScript(input.requests, perCliTimeoutMs)}\n} </dev/null`),
    )
  }
  const script = powerShellBatchProbeScript(input.requests, perCliTimeoutMs)
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  }
}

/**
 * A batch's output as one answer per request, in request order. Anything
 * before the first block (a login banner) is ignored. A request with no block
 * — the shell died part way, or printed something else — is an error, never
 * "not installed": only a probe that ran says a CLI is absent.
 */
export function parseBatchProbeOutput(stdout: string, count: number): BatchProbeAnswer[] {
  const blocks = new Map<number, string[]>()
  let current: string[] | null = null
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith(BATCH_BLOCK_MARKER)) {
      const index = Number(line.slice(BATCH_BLOCK_MARKER.length).trim())
      current = Number.isInteger(index) && index >= 0 && index < count ? [] : null
      if (current) blocks.set(index, current)
      continue
    }
    current?.push(line)
  }
  const answers: BatchProbeAnswer[] = []
  for (let index = 0; index < count; index += 1) {
    const lines = blocks.get(index)
    if (!lines) {
      answers.push({ error: 'The probe printed no answer for this CLI.' })
      continue
    }
    if (lines.includes(BATCH_NOT_FOUND)) {
      answers.push(parseProbeOutput(NOT_FOUND_EXIT, ''))
      continue
    }
    // A CLI whose `--version` hit its own deadline was still found: installed,
    // with whatever version it printed before, if any.
    answers.push(parseProbeOutput(0, lines.filter((line) => line !== BATCH_TIMED_OUT).join('\n')))
  }
  return answers
}

export type DetectCliBatchDeps = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  resolveDistro?: () => Promise<string | null>
  run?: (desc: SpawnDescriptor, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<RunOutcome>
}

type BatchItem = { index: number; binary: string; versionArgs: string[] }

function detectResult(cli: AgentCli, binary: string, useWsl: boolean, answer: BatchProbeAnswer): CliDetectResult {
  if ('error' in answer) {
    return { cli, binary, installed: false, version: null, resolvedPath: null, useWsl, error: answer.error }
  }
  return {
    cli,
    binary,
    installed: answer.installed,
    version: answer.version,
    resolvedPath: answer.resolvedPath,
    useWsl,
    error: null,
  }
}

async function runBatchGroup(
  target: 'wsl' | 'win32',
  items: readonly BatchItem[],
  deps: DetectCliBatchDeps,
  env: NodeJS.ProcessEnv,
): Promise<BatchProbeAnswer[]> {
  const run =
    deps.run ??
    ((desc: SpawnDescriptor, runEnv: NodeJS.ProcessEnv, timeoutMs: number) =>
      runDescriptor(desc, undefined, runEnv, timeoutMs))
  const resolveDistro = deps.resolveDistro ?? (() => resolveDefaultWslDistro())
  try {
    const distro = target === 'wsl' ? await resolveDistro().catch(() => null) : null
    const outcome = await run(buildBatchProbeDescriptor({ requests: items, target, distro }), env, BATCH_TIMEOUT_MS)
    if (outcome.timedOut) {
      return items.map(() => ({ error: `The CLI check timed out after ${BATCH_TIMEOUT_MS / 1000} s.` }))
    }
    const answers = parseBatchProbeOutput(outcome.stdout, items.length)
    if (outcome.code !== 0 && answers.every((answer) => 'error' in answer)) {
      // `wsl.exe` itself failed: no distribution, WSL not installed, the VM
      // would not start. Its reason is the first line it printed.
      const detail = outcome.stderr.trim().split(/\r?\n/)[0] ?? ''
      return items.map(() => ({ error: `The CLI check exited with code ${outcome.code}. ${detail}`.trim() }))
    }
    return answers
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return items.map(() => ({ error: message }))
  }
}

/**
 * `detectCli` for many CLIs at once. On Windows, one process per target (the
 * CLIs that run through WSL, the ones that run natively) whatever the count; on
 * macOS and Linux each CLI keeps its own probe, which has the interactive-shell
 * fallback a batch does not.
 */
export async function detectCliBatch(
  requests: ReadonlyArray<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }>,
  deps: DetectCliBatchDeps = {},
): Promise<CliDetectResult[]> {
  const platform = deps.platform ?? process.platform
  const results: CliDetectResult[] = []
  const groups = new Map<'wsl' | 'win32', BatchItem[]>()
  const posix: number[] = []
  requests.forEach(({ cli, runtime }, index) => {
    const manifest = getPluginManifest(cli)
    const useWsl = runtime?.useWsl ?? false
    if (!manifest) {
      results[index] = detectResult(cli, cli, useWsl, { error: `No plugin manifest found for "${cli}".` })
      return
    }
    const target = resolveInstallPlatform(platform, useWsl)
    if (target !== 'wsl' && target !== 'win32') {
      posix.push(index)
      return
    }
    const group = groups.get(target) ?? []
    group.push({
      index,
      binary: resolveBinary(manifest, runtime),
      versionArgs: manifest.detect?.versionArgs ?? ['--version'],
    })
    groups.set(target, group)
  })

  const env = deps.env ?? defaultProbeEnv()
  await Promise.all([
    ...posix.map(async (index) => {
      results[index] = await detectCli(requests[index].cli, requests[index].runtime, deps.env)
    }),
    ...[...groups].map(async ([target, items]) => {
      const answers = await runBatchGroup(target, items, deps, env)
      items.forEach((item, position) => {
        results[item.index] = detectResult(requests[item.index].cli, item.binary, target === 'wsl', answers[position])
      })
    }),
  ])
  return results
}

export async function detectCli(
  cli: AgentCli,
  runtime?: Partial<CliRuntimeSettings>,
  env?: NodeJS.ProcessEnv,
): Promise<CliDetectResult> {
  const manifest = getPluginManifest(cli)
  const useWsl = runtime?.useWsl ?? false
  if (!manifest) {
    return {
      cli,
      binary: cli,
      installed: false,
      version: null,
      resolvedPath: null,
      useWsl,
      error: `No plugin manifest found for "${cli}".`,
    }
  }
  const binary = resolveBinary(manifest, runtime)
  const target = resolveInstallPlatform(process.platform, useWsl)
  // On Windows a single CLI goes through the batch too, so every probe there
  // is built, run and read one way.
  if (target === 'wsl' || target === 'win32') {
    const [result] = await detectCliBatch([{ cli, runtime }], env ? { env } : {})
    return result
  }
  const versionArgs = manifest.detect?.versionArgs ?? ['--version']
  try {
    // An explicit caller env still wins over the default probe PATH.
    const { parsed, inconclusive } = await runVersionProbe({
      binary,
      versionArgs,
      target,
      env: env ?? defaultProbeEnv(),
    })
    // On the host, a binary missing while no shell would say what PATH the
    // person has is a non-answer. Reported as an error, availability leaves it
    // out (the renderer keeps it visible as "unknown") and does not cache it,
    // rather than holding a false "not installed" for the length of the cache.
    if (inconclusive && !parsed.installed && isHostPosixTarget(target)) {
      return {
        cli,
        binary,
        installed: false,
        version: null,
        resolvedPath: null,
        useWsl,
        error: 'No login shell answered with a PATH to look the binary up on.',
      }
    }
    return {
      cli,
      binary,
      installed: parsed.installed,
      version: parsed.version,
      resolvedPath: parsed.resolvedPath,
      useWsl,
      error: null,
    }
  } catch (error) {
    return {
      cli,
      binary,
      installed: false,
      version: null,
      resolvedPath: null,
      useWsl,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function prerequisiteAvailable(requires: string, target: PluginInstallPlatform): Promise<boolean> {
  try {
    const outcome = await runDescriptor(buildExistsDescriptor({ binary: requires, target }))
    return outcome.code !== NOT_FOUND_EXIT
  } catch {
    return false
  }
}

function selectInstallMethods(manifest: PluginManifest, target: PluginInstallPlatform): PluginInstallMethod[] {
  return manifest.install?.[target] ?? []
}

export async function cliInstallMethods(
  cli: AgentCli,
  runtime?: Partial<CliRuntimeSettings>,
): Promise<CliInstallMethodInfo[]> {
  const manifest = getPluginManifest(cli)
  if (!manifest) return []
  const useWsl = runtime?.useWsl ?? false
  const target = resolveInstallPlatform(process.platform, useWsl)
  await knowWslDistro(target)
  const methods = selectInstallMethods(manifest, target)
  const infos = await Promise.all(
    methods.map(async (method): Promise<CliInstallMethodInfo> => {
      const available = method.requires ? await prerequisiteAvailable(method.requires, target) : true
      return {
        id: method.id,
        label: method.label,
        available,
        unavailableReason: available || !method.requires ? null : `Requires "${method.requires}" on PATH`,
        recommended: method.recommended ?? false,
        commandPreview: method.shell,
        platform: target,
      }
    }),
  )
  return infos
}

export async function installCli(
  input: CliInstallInput,
  runtime: Partial<CliRuntimeSettings> | undefined,
  onData?: (chunk: string) => void,
): Promise<CliInstallResult> {
  const manifest = getPluginManifest(input.cli)
  const useWsl = runtime?.useWsl ?? false
  if (!manifest) {
    return {
      ok: false,
      cli: input.cli,
      installed: false,
      version: null,
      resolvedPath: null,
      log: '',
      error: `No plugin manifest found for "${input.cli}".`,
    }
  }
  const target = resolveInstallPlatform(process.platform, useWsl)
  await knowWslDistro(target)
  const method = selectInstallMethods(manifest, target).find((entry) => entry.id === input.methodId)
  if (!method) {
    return {
      ok: false,
      cli: input.cli,
      installed: false,
      version: null,
      resolvedPath: null,
      log: '',
      error: `No install method "${input.methodId}" for ${input.cli} on ${target}.`,
    }
  }

  const banner = `$ ${method.shell}\n`
  onData?.(banner)
  let log = banner
  const capture = (chunk: string): void => {
    log += chunk
    onData?.(chunk)
  }

  // Run the install (and the re-detect below) with the managed node/npm on
  // PATH so npm-based installers work without a user Node and the resulting
  // binary is discoverable. Falls back to the user's PATH when no managed
  // runtime is vendored.
  const installEnv = managedInstallEnv() ?? undefined

  let runError: string | null = null
  try {
    const outcome = await runDescriptor(buildInstallDescriptor({ shell: method.shell, target }), capture, installEnv)
    if (outcome.code !== 0) {
      runError = `Install command exited with code ${outcome.code}.`
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error)
  }

  // Re-detect regardless of exit code: some installers report a non-zero exit
  // while still placing the binary (e.g. PATH advisories). Against a freshly
  // asked login PATH, since an installer may have just added to it.
  invalidateLoginShellPath()
  const detected = await detectCli(input.cli, runtime, installEnv)
  const ok = detected.installed && runError === null
  return {
    ok,
    cli: input.cli,
    installed: detected.installed,
    version: detected.version,
    resolvedPath: detected.resolvedPath,
    log,
    error: ok ? null : (runError ?? (detected.installed ? null : 'CLI not found on PATH after install.')),
  }
}

// Builds the descriptor that runs the CLI's own updater: the resolved binary
// with the manifest `update.args`, in the target shell so PATH resolution
// matches detection and terminal launches.
export function buildUpdateDescriptor(input: {
  binary: string
  args: string[]
  target: PluginInstallPlatform
}): SpawnDescriptor {
  const { binary, args, target } = input
  if (isPosixTarget(target)) {
    return shellDescriptorForScript(target, [binary, ...args].map(posixSingleQuote).join(' '))
  }
  return shellDescriptorForScript(target, `& ${[binary, ...args].map(powerShellSingleQuote).join(' ')}`)
}

// Update an installed CLI. No staleness detection: a CLI's "latest"
// belongs to the vendor's channel, so this is an action, not a state. Where
// the manifest declares an `update` spec the CLI's own updater runs; otherwise
// the install spec is re-run, which for npm installs is exactly "update to
// latest" and no-ops when current.
export async function updateCli(
  cli: AgentCli,
  runtime: Partial<CliRuntimeSettings> | undefined,
  onData?: (chunk: string) => void,
): Promise<CliInstallResult> {
  const manifest = getPluginManifest(cli)
  if (!manifest) {
    return {
      ok: false,
      cli,
      installed: false,
      version: null,
      resolvedPath: null,
      log: '',
      error: `No plugin manifest found for "${cli}".`,
    }
  }
  const target = resolveInstallPlatform(process.platform, runtime?.useWsl ?? false)
  await knowWslDistro(target)

  if (manifest.update?.args?.length) {
    const binary = resolveBinary(manifest, runtime)
    const banner = `$ ${[binary, ...manifest.update.args].join(' ')}\n`
    onData?.(banner)
    let log = banner
    const capture = (chunk: string): void => {
      log += chunk
      onData?.(chunk)
    }
    const updateEnv = managedInstallEnv() ?? undefined
    let runError: string | null = null
    try {
      const outcome = await runDescriptor(
        buildUpdateDescriptor({ binary, args: manifest.update.args, target }),
        capture,
        updateEnv,
      )
      if (outcome.code !== 0) {
        runError = `Update command exited with code ${outcome.code}.`
      }
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error)
    }
    invalidateLoginShellPath()
    const detected = await detectCli(cli, runtime, updateEnv)
    const ok = detected.installed && runError === null
    return {
      ok,
      cli,
      installed: detected.installed,
      version: detected.version,
      resolvedPath: detected.resolvedPath,
      log,
      error: ok ? null : (runError ?? (detected.installed ? null : 'CLI not found on PATH after update.')),
    }
  }

  // No updater of its own: update through the package manager that installed
  // it — brew when the binary lives under Homebrew, else npm. Updating through
  // a manager other than the one that installed it leaves the original copy
  // ahead on PATH, so the update would look like it did nothing.
  // `brew install` on an installed formula is a no-op, so this is the
  // only path that actually moves a Homebrew-installed CLI forward.
  const detectedBefore = await detectCli(cli, runtime)
  const chosen = chooseCliUpdateCommand({ manifest, resolvedPath: detectedBefore.resolvedPath })
  if (chosen && (chosen.kind === 'brew' || chosen.kind === 'npm')) {
    const banner = `$ ${chosen.command}\n`
    onData?.(banner)
    let log = banner
    const capture = (chunk: string): void => {
      log += chunk
      onData?.(chunk)
    }
    const updateEnv = managedInstallEnv() ?? undefined
    let runError: string | null = null
    try {
      const outcome = await runDescriptor(buildInstallDescriptor({ shell: chosen.command, target }), capture, updateEnv)
      if (outcome.code !== 0) runError = `Update command exited with code ${outcome.code}.`
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error)
    }
    invalidateLoginShellPath()
    const detected = await detectCli(cli, runtime, updateEnv)
    const ok = detected.installed && runError === null
    return {
      ok,
      cli,
      installed: detected.installed,
      version: detected.version,
      resolvedPath: detected.resolvedPath,
      log,
      error: ok ? null : (runError ?? (detected.installed ? null : 'CLI not found on PATH after update.')),
    }
  }

  const methods = await cliInstallMethods(cli, runtime)
  const method =
    methods.find((entry) => entry.recommended && entry.available) ??
    methods.find((entry) => entry.available) ??
    methods[0]
  if (!method) {
    return {
      ok: false,
      cli,
      installed: false,
      version: null,
      resolvedPath: null,
      log: '',
      error: `No update path for ${cli} on ${target}: the manifest declares no update spec and no install methods.`,
    }
  }
  return installCli({ cli, methodId: method.id }, runtime, onData)
}
