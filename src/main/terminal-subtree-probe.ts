// Safety detector for the idle reaper: before suspending/disposing an idle
// agent terminal, confirm there is nothing live running under its pty. Killing
// the terminal kills the CLI process, and the CLI's shutdown kills every
// background task it is tracking — so reaping a session with live background
// work aborts that work mid-flight (the resumed session then reports "No
// completion record was found for this background shell command").
//
// Three signals mark a subtree as holding live work:
//   1. A LISTENING TCP socket held by any subtree process — dev servers
//      (vite/webpack/next/…) hold a port, while stdio MCP servers do NOT, so
//      this doesn't false-positive on the MCP helpers every agent spawns.
//   2. A subtree process burning CPU — catches a busy non-server command (a
//      build/test) that holds no port.
//   3. A Claude Code tool shell (`~/.claude/shell-snapshots/…` wrapper) — the
//      signature of every shell the agent's Bash tool runs, foreground or
//      `run_in_background`. This is what protects the quiet waiters signals 1
//      and 2 cannot see: a backgrounded `sleep`/poll/blocked-on-IO shell burns
//      ~0% CPU and holds no port, but killing the CLI still kills it. MCP
//      helpers never match it, so idle sessions stay reapable.
//
// Pure core (testable without spawning); the OS reads (`ps`, `lsof`, and on
// Windows one PowerShell or one `wsl.exe` per distribution) are injected. Runs
// once per sweep over the small set of reap candidates, not per process, so
// the cost is a fixed handful of subprocesses regardless of candidate count.
// Any failure resolves to "live" (keep the terminal alive) — never the reverse.

import { execFile } from 'node:child_process'

import type { TerminalPathStyle } from '../shared/ipc/terminal'
import { runSpawnDescriptor, type RunOutcome } from './process-run'
import { killProcessTree } from './process-tree-kill'
import { resolveWslDistroForPath, runWslScript, WSL_SESSION_PID_DIR, wslSessionPidKey } from './wsl-host'

// A subtree process above this CPU share counts as "doing work" → keep alive.
// High enough to ignore idle MCP/helper jitter, low enough to catch a build.
const SUBTREE_BUSY_CPU_PERCENT = 15

// Every shell the Claude Code Bash tool runs — foreground or backgrounded —
// sources its snapshot from this directory, making it a precise marker for
// "the agent has a shell command in flight" that idle MCP servers never match.
export const CLAUDE_TOOL_SHELL_SIGNATURE = '.claude/shell-snapshots/'

export type ProcRow = { pid: number; ppid: number; cpuPercent: number; command: string }

// Why a subtree counts as live. Carried into the reap skip audit so a held
// session names the evidence ("tool_shell" vs "listening_port" vs "busy_cpu").
export type SubtreeLiveReason = 'listening_port' | 'busy_cpu' | 'tool_shell'

export function parsePsTree(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]),
      command: match[4],
    })
  }
  return rows
}

// `lsof -t` prints one pid per line. A pid may repeat (multiple sockets); a Set
// dedups.
export function parseListeningPids(stdout: string): Set<number> {
  const pids = new Set<number>()
  for (const raw of stdout.split('\n')) {
    const value = Number(raw.trim())
    if (Number.isInteger(value) && value > 0) pids.add(value)
  }
  return pids
}

// The first live-work reason found in `rootPid`'s descendant tree, or null when
// the subtree holds nothing live. The root itself (the pty shell) is not
// counted — we are asking whether something the shell launched is still live.
export function subtreeLiveReason(
  rootPid: number,
  procs: readonly ProcRow[],
  listeningPids: ReadonlySet<number>,
  options: { busyCpuPercent?: number } = {},
): SubtreeLiveReason | null {
  const busyCpuPercent = options.busyCpuPercent ?? SUBTREE_BUSY_CPU_PERCENT
  const childrenByParent = new Map<number, ProcRow[]>()
  for (const proc of procs) {
    const list = childrenByParent.get(proc.ppid)
    if (list) list.push(proc)
    else childrenByParent.set(proc.ppid, [proc])
  }

  const seen = new Set<number>([rootPid])
  const stack = [...(childrenByParent.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const proc = stack.pop()!
    if (seen.has(proc.pid)) continue
    seen.add(proc.pid)
    if (listeningPids.has(proc.pid)) return 'listening_port'
    if (proc.cpuPercent > busyCpuPercent) return 'busy_cpu'
    if (proc.command.includes(CLAUDE_TOOL_SHELL_SIGNATURE)) return 'tool_shell'
    const children = childrenByParent.get(proc.pid)
    if (children) stack.push(...children)
  }
  return null
}

export function subtreeHasLiveProcess(
  rootPid: number,
  procs: readonly ProcRow[],
  listeningPids: ReadonlySet<number>,
  options: { busyCpuPercent?: number } = {},
): boolean {
  return subtreeLiveReason(rootPid, procs, listeningPids, options) !== null
}

// Resolves to null on any error so the caller can tell "command failed" apart
// from "command ran and returned nothing" — critical because an empty `lsof`
// result must NOT be read as "no servers" when lsof simply failed/was missing.
function execFileTextOrNull(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    )
  })
}

export type SubtreeProbeDeps = HostProbeDeps & {
  platform?: NodeJS.Platform
  runPs?: () => Promise<string | null>
  runLsofListening?: () => Promise<string | null>
}

// Resolves each root pid to the live-work reason found in its subtree (null =
// probed clean, safe to reap). A root absent from the returned map (or any
// failure) means "undetermined" — callers MUST treat that as live/keep-alive.
export async function probeSubtreesForLiveWork(
  rootPids: readonly number[],
  deps: SubtreeProbeDeps = {},
): Promise<Map<number, SubtreeLiveReason | null>> {
  const platform = deps.platform ?? process.platform
  const result = new Map<number, SubtreeLiveReason | null>()
  if (rootPids.length === 0) return result
  if (platform !== 'darwin' && platform !== 'linux') return result // undetermined → keep-alive

  const runPs = deps.runPs ?? (() => execFileTextOrNull('ps', ['-axo', 'pid=,ppid=,pcpu=,args=']))
  const runLsofListening =
    deps.runLsofListening ?? (() => execFileTextOrNull('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-t']))

  try {
    const [psOut, lsofOut] = await Promise.all([runPs(), runLsofListening()])
    // If EITHER read failed, we can't trust the result — an empty lsof would be
    // misread as "no servers". Leave every root undetermined → keep-alive.
    if (psOut === null || lsofOut === null) return result
    const procs = parsePsTree(psOut)
    if (procs.length === 0) return result // ps yielded nothing usable → undetermined
    const listening = parseListeningPids(lsofOut)
    for (const rootPid of rootPids) {
      result.set(rootPid, subtreeLiveReason(rootPid, procs, listening))
    }
  } catch {
    return new Map() // undetermined → keep-alive
  }
  return result
}

// Boolean projection kept for callers that only need live/not-live.
export async function probeSubtreesForLiveProcesses(
  rootPids: readonly number[],
  deps: SubtreeProbeDeps = {},
): Promise<Map<number, boolean>> {
  const reasons = await probeSubtreesForLiveWork(rootPids, deps)
  const result = new Map<number, boolean>()
  for (const [pid, reason] of reasons) result.set(pid, reason !== null)
  return result
}

// A CLI process that outlives its terminal teardown. The pty kill reaches the
// shell, but a CLI child that survives the resulting SIGHUP reparents to
// launchd and nothing tracks it afterwards — the 2026-07-26 incident leaked 15
// idle Opus agents this way. The one durable handle on such a process is its
// own argv: agent CLIs are launched with an explicit `--session-id <uuid>`,
// which survives reparenting and cannot collide.
export function matchCliSessionPids(psOutput: string, cliSessionId: string): number[] {
  if (!cliSessionId) return []
  const needle = `--session-id ${cliSessionId}`
  const pids: number[] = []
  for (const line of psOutput.split('\n')) {
    if (!line.includes(needle)) continue
    const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10)
    if (Number.isFinite(pid) && pid > 0) pids.push(pid)
  }
  return pids
}

/**
 * Post-teardown escalation: after the pty kill has had `delayMs` to propagate,
 * SIGKILL any process still carrying this terminal's `--session-id`. Callers
 * fire-and-forget it right after the kill; a clean exit means the ps sweep
 * finds nothing and this is a no-op. Returns the pids it killed (for tests
 * and audit).
 *
 * `host` says where the session ran. On Windows a native session's survivors
 * are found by command line through CIM and ended with their trees; a WSL
 * session's are found and killed inside its distribution, where killing
 * `wsl.exe` on the Windows side does not reach them.
 */
export async function killCliSessionSurvivors(
  cliSessionId: string,
  deps: SubtreeProbeDeps & {
    delayMs?: number
    kill?: (pid: number, signal: NodeJS.Signals) => void
    killTree?: (pid: number) => void
    host?: HostSurvivorTarget
  } = {},
): Promise<number[]> {
  if (!cliSessionId) return []
  const platform = deps.platform ?? process.platform
  const style = deps.host?.pathStyle ?? (platform === 'win32' ? 'windows' : 'posix')
  const onWindows = style === 'wsl' || style === 'windows'
  if (onWindows ? platform !== 'win32' : platform !== 'darwin' && platform !== 'linux') return []
  const delayMs = deps.delayMs ?? 2_000
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  if (onWindows) {
    try {
      return style === 'wsl'
        ? await killWslSurvivors(cliSessionId, deps.host ?? {}, deps)
        : await killWindowsSurvivors(cliSessionId, deps)
    } catch {
      return []
    }
  }
  const runPs = deps.runPs ?? (() => execFileTextOrNull('ps', ['-axo', 'pid=,ppid=,pcpu=,args=']))
  const psOut = await runPs()
  if (psOut === null) return [] // undetermined — never kill on a failed read
  const killImpl = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const killed: number[] = []
  for (const pid of matchCliSessionPids(psOut, cliSessionId)) {
    try {
      killImpl(pid, 'SIGKILL')
      killed.push(pid)
    } catch {
      // Already gone between the ps read and the kill — the goal state.
    }
  }
  return killed
}

// =============================================================================
// Windows and WSL sessions
//
// A pty on Windows runs either PowerShell (a native session) or `wsl.exe` (a
// session whose shell and CLI live in a WSL distribution). Neither has `ps` or
// `lsof` on the Windows side, so each gets one read per sweep of its own:
//
//   - native: one PowerShell that lists every process with its parent and
//     command line (CIM `Win32_Process`), the pids holding a listening TCP
//     socket (`Get-NetTCPConnection`), and CPU from two samples of each
//     process's processor time half a second apart.
//   - WSL: one `sh` in the distribution, sent on stdin, that prints each
//     session's pid file (the Linux shell the startup script ran in; the pty's
//     own pid is `wsl.exe`, which means nothing inside), `ps`, and the listening
//     pids from `ss` (or `lsof`). One run per distribution, however many
//     sessions it holds.
//
// Both feed the same `subtreeLiveReason`. As everywhere in this file, a read
// that failed, or a session whose root cannot be found, is undetermined —
// held, never reaped.
// =============================================================================

// How long a sweep waits on a Windows-side read. The sweep runs every three
// minutes and a held session is simply asked again next time.
const HOST_PROBE_TIMEOUT_MS = 15_000

export type HostRunner = (script: string, options: { timeoutMs: number }) => Promise<RunOutcome>
export type WslRunner = (distro: string | null, script: string, options: { timeoutMs: number }) => Promise<RunOutcome>

export type HostProbeDeps = {
  // Runs a PowerShell script (native Windows reads).
  runPowerShell?: HostRunner
  // Runs a `sh` script inside a distribution (WSL reads).
  runWslScript?: WslRunner
  // The distribution a WSL session with this cwd runs in.
  resolveWslDistro?: (cwd: string | undefined) => Promise<string | null>
}

function defaultRunPowerShell(script: string, options: { timeoutMs: number }): Promise<RunOutcome> {
  return runSpawnDescriptor(
    {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
    },
    { timeoutMs: options.timeoutMs },
  )
}

function outcomeText(outcome: RunOutcome): string | null {
  return outcome.timedOut || outcome.code !== 0 ? null : outcome.stdout
}

// ── WSL ──────────────────────────────────────────────────────────────────────

const WSL_SECTION = {
  pids: '@@SPRINTENGINE_PIDS',
  ps: '@@SPRINTENGINE_PS',
  listen: '@@SPRINTENGINE_LISTEN',
  failed: '@@SPRINTENGINE_FAILED',
  end: '@@SPRINTENGINE_END',
} as const

/**
 * The one script a sweep runs per distribution. Pid-file keys are the
 * startup-script names `wslSessionPidKey` produced, which hold no shell
 * metacharacters; they are quoted all the same.
 */
export function buildWslSubtreeProbeScript(pidKeys: readonly string[]): string {
  const keys = pidKeys.map((key) => `'${key.replace(/'/g, `'\\''`)}'`).join(' ')
  return [
    `d="${WSL_SESSION_PID_DIR}"`,
    `echo '${WSL_SECTION.pids}'`,
    ...(keys ? [`for k in ${keys}; do printf '%s %s\\n' "$k" "$(head -n 1 "$d/$k.pid" 2>/dev/null)"; done`] : []),
    `echo '${WSL_SECTION.ps}'`,
    `ps -axo pid=,ppid=,pcpu=,args= 2>/dev/null || echo '${WSL_SECTION.failed}'`,
    `echo '${WSL_SECTION.listen}'`,
    'if command -v ss >/dev/null 2>&1; then',
    `  ss -Hltnp 2>/dev/null || echo '${WSL_SECTION.failed}'`,
    'elif command -v lsof >/dev/null 2>&1; then',
    `  lsof -nP -iTCP -sTCP:LISTEN -t 2>/dev/null || echo '${WSL_SECTION.failed}'`,
    'else',
    `  echo '${WSL_SECTION.failed}'`,
    'fi',
    `echo '${WSL_SECTION.end}'`,
  ].join('\n')
}

/**
 * The pids holding a listening socket, from `ss -Hltnp` or `lsof -t`.
 *
 *   LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=4242,fd=20))
 *
 * `ss` names every process sharing the socket; `lsof -t` prints bare pids.
 */
export function parseSsListening(stdout: string): Set<number> {
  const pids = new Set<number>()
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line) continue
    if (/^\d+$/u.test(line)) {
      pids.add(Number(line))
      continue
    }
    for (const match of line.matchAll(/pid=(\d+)/gu)) pids.add(Number(match[1]))
  }
  return pids
}

export type WslSubtreeSnapshot = {
  // Each asked-for key's root pid, or null when its pid file was absent.
  rootPids: Map<string, number | null>
  procs: ProcRow[]
  listening: Set<number>
}

/** The WSL probe's output, or null when any part of it failed. */
export function parseWslSubtreeProbeOutput(stdout: string): WslSubtreeSnapshot | null {
  const sections = new Map<string, string[]>()
  let current: string[] | null = null
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trimEnd()
    if (
      line === WSL_SECTION.pids ||
      line === WSL_SECTION.ps ||
      line === WSL_SECTION.listen ||
      line === WSL_SECTION.end
    ) {
      current = []
      sections.set(line, current)
      continue
    }
    current?.push(line)
  }
  // A missing end marker means the output was cut short; a failed marker, that
  // a read failed. Either way nothing in it can clear a session.
  if (!sections.has(WSL_SECTION.end)) return null
  const pidLines = sections.get(WSL_SECTION.pids)
  const psLines = sections.get(WSL_SECTION.ps)
  const listenLines = sections.get(WSL_SECTION.listen)
  if (!pidLines || !psLines || !listenLines) return null
  if (psLines.includes(WSL_SECTION.failed) || listenLines.includes(WSL_SECTION.failed)) return null
  const procs = parsePsTree(psLines.join('\n'))
  if (procs.length === 0) return null
  const rootPids = new Map<string, number | null>()
  for (const line of pidLines) {
    const match = /^(\S+)\s*(\d*)\s*$/u.exec(line.trim())
    if (!match) continue
    const pid = match[2] ? Number(match[2]) : null
    rootPids.set(match[1], pid !== null && pid > 0 ? pid : null)
  }
  return { rootPids, procs, listening: parseSsListening(listenLines.join('\n')) }
}

/**
 * Live-work verdicts for WSL sessions in one distribution, by pid-file key.
 * A key absent from the result is undetermined.
 */
export async function probeWslSubtrees(
  distro: string | null,
  pidKeys: readonly string[],
  deps: HostProbeDeps = {},
): Promise<Map<string, SubtreeLiveReason | null>> {
  const result = new Map<string, SubtreeLiveReason | null>()
  if (pidKeys.length === 0) return result
  const run = deps.runWslScript ?? runWslScript
  try {
    const text = outcomeText(
      await run(distro, buildWslSubtreeProbeScript(pidKeys), { timeoutMs: HOST_PROBE_TIMEOUT_MS }),
    )
    const snapshot = text === null ? null : parseWslSubtreeProbeOutput(text)
    if (!snapshot) return result
    const alive = new Set(snapshot.procs.map((proc) => proc.pid))
    for (const key of pidKeys) {
      const root = snapshot.rootPids.get(key)
      // No pid file, or its shell is gone: nothing says what this session runs.
      if (root === null || root === undefined || !alive.has(root)) continue
      result.set(key, subtreeLiveReason(root, snapshot.procs, snapshot.listening))
    }
  } catch {
    return new Map()
  }
  return result
}

// ── Native Windows ───────────────────────────────────────────────────────────

/**
 * One PowerShell read of every process (pid, parent, command line, CPU) and
 * every pid holding a listening TCP socket, as JSON.
 *
 * CPU is the processor time each process used between two samples at least
 * half a second apart, as a percentage of one core — the same scale `ps`
 * reports. The performance-counter classes would give it directly but can take
 * seconds to answer; two reads of `TotalProcessorTime` do not.
 */
export const WINDOWS_SUBTREE_PROBE_SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
  `$clock = [System.Diagnostics.Stopwatch]::StartNew()`,
  `$before = @{}`,
  `foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { try { $before[[int]$p.Id] = $p.TotalProcessorTime.Ticks } catch {} }`,
  `$rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CommandLine)`,
  `$listeningOk = $true`,
  `try { $listening = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique) }`,
  `catch { $listening = @(); $listeningOk = $false }`,
  `$wait = 5000000 - $clock.Elapsed.Ticks`,
  `if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]($wait / 10000)) }`,
  `$elapsed = [double]$clock.Elapsed.Ticks`,
  `$cpu = @{}`,
  `foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { try { $id = [int]$p.Id; if ($before.ContainsKey($id)) { $cpu[$id] = [Math]::Round(100.0 * ($p.TotalProcessorTime.Ticks - $before[$id]) / $elapsed, 1) } } catch {} }`,
  `$processes = @($rows | ForEach-Object { $id = [int]$_.ProcessId; [pscustomobject]@{ pid = $id; ppid = [int]$_.ParentProcessId; cpu = $(if ($cpu.ContainsKey($id)) { $cpu[$id] } else { 0 }); cmd = [string]$_.CommandLine } })`,
  `ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ listeningOk = $listeningOk; listening = $listening; processes = $processes })`,
].join('\n')

export type WindowsSubtreeSnapshot = { procs: ProcRow[]; listening: Set<number> }

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

/**
 * The PowerShell read as process rows, or null when it failed or its listening
 * read did. Command lines get forward slashes, so a Claude tool shell's
 * snapshot path (`.claude\shell-snapshots\…`) matches the same signature as
 * on macOS and Linux.
 */
export function parseCimProcessJson(stdout: string): WindowsSubtreeSnapshot | null {
  let data: unknown
  try {
    data = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const record = data as { listeningOk?: unknown; listening?: unknown; processes?: unknown }
  if (record.listeningOk !== true) return null
  const procs: ProcRow[] = []
  for (const raw of asArray(record.processes)) {
    const row = raw as { pid?: unknown; ppid?: unknown; cpu?: unknown; cmd?: unknown } | null
    if (!row || typeof row.pid !== 'number' || typeof row.ppid !== 'number') continue
    procs.push({
      pid: row.pid,
      ppid: row.ppid,
      cpuPercent: typeof row.cpu === 'number' && Number.isFinite(row.cpu) ? row.cpu : 0,
      command: typeof row.cmd === 'string' ? row.cmd.replace(/\\/g, '/') : '',
    })
  }
  if (procs.length === 0) return null
  const listening = new Set<number>()
  for (const pid of asArray(record.listening)) if (typeof pid === 'number' && pid > 0) listening.add(pid)
  return { procs, listening }
}

/** Live-work verdicts for native Windows sessions, by pty root pid. */
export async function probeWindowsSubtrees(
  rootPids: readonly number[],
  deps: HostProbeDeps = {},
): Promise<Map<number, SubtreeLiveReason | null>> {
  const result = new Map<number, SubtreeLiveReason | null>()
  if (rootPids.length === 0) return result
  const run = deps.runPowerShell ?? defaultRunPowerShell
  try {
    const text = outcomeText(await run(WINDOWS_SUBTREE_PROBE_SCRIPT, { timeoutMs: HOST_PROBE_TIMEOUT_MS }))
    const snapshot = text === null ? null : parseCimProcessJson(text)
    if (!snapshot) return result
    const alive = new Set(snapshot.procs.map((proc) => proc.pid))
    for (const rootPid of rootPids) {
      if (!alive.has(rootPid)) continue
      result.set(rootPid, subtreeLiveReason(rootPid, snapshot.procs, snapshot.listening))
    }
  } catch {
    return new Map()
  }
  return result
}

// ── Every session, whatever it runs on ───────────────────────────────────────

/** What the reaper knows about a session it may reap. */
export type SessionProbeTarget = {
  sessionId: string
  // The pty's pid: the shell itself on macOS, Linux and native Windows,
  // `wsl.exe` for a WSL session.
  rootPid: number
  pathStyle?: TerminalPathStyle
  cwd?: string
  // The WSL session's startup script, whose name keys its pid file.
  startupScriptPath?: string
}

/**
 * Live-work verdicts for sessions of any kind, by session id: each group read
 * the way its host allows, one read per group. A session absent from the
 * result is undetermined and must be held.
 */
export async function probeSessionSubtrees(
  targets: readonly SessionProbeTarget[],
  deps: SubtreeProbeDeps = {},
): Promise<Map<string, SubtreeLiveReason | null>> {
  const platform = deps.platform ?? process.platform
  const result = new Map<string, SubtreeLiveReason | null>()
  const posix: SessionProbeTarget[] = []
  const windows: SessionProbeTarget[] = []
  const wsl: SessionProbeTarget[] = []
  for (const target of targets) {
    const style = target.pathStyle ?? (platform === 'win32' ? 'windows' : 'posix')
    if (style === 'wsl') wsl.push(target)
    else if (style === 'windows') windows.push(target)
    else posix.push(target)
  }

  const reads: Promise<void>[] = []
  if (posix.length > 0) {
    reads.push(
      probeSubtreesForLiveWork(
        posix.map((target) => target.rootPid),
        deps,
      ).then((verdicts) => {
        for (const target of posix) {
          if (verdicts.has(target.rootPid)) result.set(target.sessionId, verdicts.get(target.rootPid) ?? null)
        }
      }),
    )
  }
  if (platform === 'win32' && windows.length > 0) {
    reads.push(
      probeWindowsSubtrees(
        windows.map((target) => target.rootPid),
        deps,
      ).then((verdicts) => {
        for (const target of windows) {
          if (verdicts.has(target.rootPid)) result.set(target.sessionId, verdicts.get(target.rootPid) ?? null)
        }
      }),
    )
  }
  if (platform === 'win32' && wsl.length > 0) {
    reads.push(
      (async () => {
        const resolveDistro = deps.resolveWslDistro ?? ((cwd: string | undefined) => resolveWslDistroForPath(cwd))
        const byDistro = new Map<string, Array<{ sessionId: string; key: string }>>()
        for (const target of wsl) {
          const key = wslSessionPidKey(target.startupScriptPath)
          if (!key) continue // no pid file to read: undetermined
          const distro = (await resolveDistro(target.cwd).catch(() => null)) ?? ''
          const group = byDistro.get(distro) ?? []
          group.push({ sessionId: target.sessionId, key })
          byDistro.set(distro, group)
        }
        await Promise.all(
          [...byDistro].map(async ([distro, members]) => {
            const verdicts = await probeWslSubtrees(
              distro || null,
              members.map((member) => member.key),
              deps,
            )
            for (const member of members) {
              if (verdicts.has(member.key)) result.set(member.sessionId, verdicts.get(member.key) ?? null)
            }
          }),
        )
      })(),
    )
  }
  await Promise.all(reads).catch(() => undefined)
  return result
}

// ── Survivors on Windows and in WSL ──────────────────────────────────────────

/**
 * The script that kills a WSL session's survivors: every process whose argv
 * carries `--session-id <id>`, and, when the session's shell is still the one
 * its pid file names, that shell and everything under it. The shell is only
 * trusted while its command line still names the startup script, so a pid the
 * system has since handed to something else is never touched.
 */
export function buildWslSurvivorKillScript(cliSessionId: string, pidKey: string | null): string {
  // `pgrep -f` takes an extended regex; the id is matched literally.
  const pattern = `--session-id ${cliSessionId.replace(/[.[\]()*+?{}|^$\\]/g, '\\$&')}`
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  const lines = [`killed=''`, `pids="$(pgrep -f -- ${quote(pattern)} 2>/dev/null)"`]
  if (pidKey) {
    lines.push(
      `f="${WSL_SESSION_PID_DIR}/${pidKey}.pid"`,
      `root="$(head -n 1 "$f" 2>/dev/null)"`,
      `if [ -n "$root" ] && tr '\\0' ' ' < "/proc/$root/cmdline" 2>/dev/null | grep -qF -- ${quote(pidKey)}; then`,
      `  tree="$root"; level="$root"`,
      `  while [ -n "$level" ]; do next=''; for p in $level; do next="$next $(pgrep -P "$p" 2>/dev/null)"; done; level="$(echo $next)"; tree="$tree $level"; done`,
      `  pids="$pids $tree"`,
      'fi',
      'rm -f "$f"',
    )
  }
  lines.push(
    'for p in $pids; do [ "$p" = "$$" ] && continue; kill -9 "$p" 2>/dev/null && killed="$killed $p"; done',
    `echo "@@SPRINTENGINE_KILLED$killed"`,
  )
  return lines.join('\n')
}

/** The pids a survivor-kill script reports it killed. */
export function parseKilledPids(stdout: string): number[] {
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.startsWith('@@SPRINTENGINE_KILLED'))
  if (!line) return []
  return line
    .slice('@@SPRINTENGINE_KILLED'.length)
    .trim()
    .split(/\s+/u)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/**
 * The PowerShell that lists every process whose command line carries
 * `--session-id <id>`, one pid per line. CIM is the one place Windows keeps
 * another process's command line.
 */
export function buildWindowsSurvivorQueryScript(cliSessionId: string): string {
  const needle = `--session-id ${cliSessionId}`.replace(/'/g, "''")
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$needle = '${needle}'`,
    `Get-CimInstance -ClassName Win32_Process -Property ProcessId, CommandLine | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) -and $_.ProcessId -ne $PID } | ForEach-Object { [string]$_.ProcessId }`,
  ].join('\n')
}

export type HostSurvivorTarget = { pathStyle?: TerminalPathStyle; cwd?: string; startupScriptPath?: string }

async function killWslSurvivors(
  cliSessionId: string,
  host: HostSurvivorTarget,
  deps: HostProbeDeps,
): Promise<number[]> {
  const resolveDistro = deps.resolveWslDistro ?? ((cwd: string | undefined) => resolveWslDistroForPath(cwd))
  const run = deps.runWslScript ?? runWslScript
  const distro = await resolveDistro(host.cwd).catch(() => null)
  const outcome = await run(
    distro,
    buildWslSurvivorKillScript(cliSessionId, wslSessionPidKey(host.startupScriptPath)),
    {
      timeoutMs: HOST_PROBE_TIMEOUT_MS,
    },
  )
  return outcome.timedOut ? [] : parseKilledPids(outcome.stdout)
}

async function killWindowsSurvivors(
  cliSessionId: string,
  deps: HostProbeDeps & { killTree?: (pid: number) => void },
): Promise<number[]> {
  const run = deps.runPowerShell ?? defaultRunPowerShell
  const text = outcomeText(
    await run(buildWindowsSurvivorQueryScript(cliSessionId), { timeoutMs: HOST_PROBE_TIMEOUT_MS }),
  )
  if (text === null) return [] // never kill on a failed read
  const killTree = deps.killTree ?? ((pid: number) => killProcessTree({ pid, kill: () => true }, { platform: 'win32' }))
  const killed: number[] = []
  for (const line of text.split(/\r?\n/u)) {
    const pid = Number(line.trim())
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      killTree(pid)
      killed.push(pid)
    } catch {
      // Already gone.
    }
  }
  return killed
}
