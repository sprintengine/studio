// Phase 1 safety detector: before suspending an idle agent terminal, confirm
// there is nothing live running under its pty — most importantly a dev server
// the agent (or user) started. Killing the terminal kills that child tree.
//
// The precise "there is a server here" signal is a LISTENING TCP socket held by
// any process in the pty subtree: dev servers (vite/webpack/next/…) hold a port,
// while stdio MCP servers do NOT, so this doesn't false-positive on the MCP
// helpers every agent spawns. A second signal — a subtree process burning CPU —
// catches a busy non-server command (a build/test) that holds no port.
//
// Pure core (testable without spawning); the OS reads (`ps`, `lsof`) are
// injected. Runs once per sweep over the small set of reap candidates, not per
// process, so the cost is two subprocesses regardless of candidate count. Any
// failure resolves to "live" (keep the terminal alive) — never the reverse.

import { execFile } from 'node:child_process'

// A subtree process above this CPU share counts as "doing work" → keep alive.
// High enough to ignore idle MCP/helper jitter, low enough to catch a build.
export const SUBTREE_BUSY_CPU_PERCENT = 15

export type ProcRow = { pid: number; ppid: number; cpuPercent: number }

export function parsePsTree(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpuPercent: Number(match[3]) })
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

// True when `rootPid`'s descendant tree contains a process that is listening on
// a TCP port or is busy. The root itself (the pty shell) is not counted — we are
// asking whether something the shell launched is still live.
export function subtreeHasLiveProcess(
  rootPid: number,
  procs: readonly ProcRow[],
  listeningPids: ReadonlySet<number>,
  options: { busyCpuPercent?: number } = {}
): boolean {
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
    if (listeningPids.has(proc.pid)) return true
    if (proc.cpuPercent > busyCpuPercent) return true
    const children = childrenByParent.get(proc.pid)
    if (children) stack.push(...children)
  }
  return false
}

// Resolves to null on any error so the caller can tell "command failed" apart
// from "command ran and returned nothing" — critical because an empty `lsof`
// result must NOT be read as "no servers" when lsof simply failed/was missing.
function execFileTextOrNull(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout)
    )
  })
}

export type SubtreeProbeDeps = {
  platform?: NodeJS.Platform
  runPs?: () => Promise<string | null>
  runLsofListening?: () => Promise<string | null>
}

// Resolves each root pid to whether its subtree has a live process. A root
// absent from the returned map (or any failure) means "undetermined" — callers
// MUST treat that as live/keep-alive.
export async function probeSubtreesForLiveProcesses(
  rootPids: readonly number[],
  deps: SubtreeProbeDeps = {}
): Promise<Map<number, boolean>> {
  const platform = deps.platform ?? process.platform
  const result = new Map<number, boolean>()
  if (rootPids.length === 0) return result
  if (platform !== 'darwin' && platform !== 'linux') return result // undetermined → keep-alive

  const runPs = deps.runPs ?? (() => execFileTextOrNull('ps', ['-axo', 'pid=,ppid=,pcpu=']))
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
      result.set(rootPid, subtreeHasLiveProcess(rootPid, procs, listening))
    }
  } catch {
    return new Map() // undetermined → keep-alive
  }
  return result
}
