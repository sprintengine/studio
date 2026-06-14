import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

// Per-process thread counts for the diagnostics panel. Electron's
// app.getAppMetrics() does not expose thread counts, so this reads them from the
// OS. The cost the panel must avoid is doing this on the 1s metrics poll, so the
// IPC handler samples this on a throttled cadence (THREAD_SAMPLE_THROTTLE_MS),
// off the hot path, fire-and-forget — never blocking the metrics response. macOS
// uses a single `ps -M` spawn for all pids; Linux reads /proc (no spawn); other
// platforms return nothing and the panel shows "—".
export const THREAD_SAMPLE_THROTTLE_MS = 5_000

// macOS `ps -M -p <pids>` prints a header, then one line per thread. Each
// process's first thread line carries USER + PID; continuation thread lines have
// a blank USER column but still carry the PID as their first integer token. So
// the pid is the first integer token on every line, and the thread count is the
// number of lines whose pid is one we asked for. Pure so it unit-tests without a
// process spawn.
export function parsePsThreadCounts(stdout: string, requestedPids: ReadonlySet<number>): Map<number, number> {
  const counts = new Map<number, number>()
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('USER')) continue
    for (const token of line.split(/\s+/)) {
      if (/^\d+$/.test(token)) {
        const pid = Number(token)
        if (requestedPids.has(pid)) counts.set(pid, (counts.get(pid) ?? 0) + 1)
        // The pid is always the first integer token; stop so a numeric column
        // later in the row (CPU, times, command args) can't be miscounted.
        break
      }
    }
  }
  return counts
}

// /proc/<pid>/status carries a `Threads:\t<n>` line on Linux — one cheap file
// read per pid, no spawn.
export function parseProcStatusThreads(text: string): number | null {
  const match = text.match(/^Threads:\s*(\d+)/m)
  return match ? Number(match[1]) : null
}

export type ThreadCountDeps = {
  platform?: NodeJS.Platform
  // Injected for tests; defaults shell out / read /proc.
  runPs?: (pids: readonly number[]) => Promise<string>
  readProcStatus?: (pid: number) => Promise<string>
}

function defaultRunPs(pids: readonly number[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-M', '-p', pids.join(',')],
      { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? '' : stdout)
    )
  })
}

function defaultReadProcStatus(pid: number): Promise<string> {
  return readFile(`/proc/${pid}/status`, 'utf8')
}

// Best-effort per-pid thread counts. Returns an empty map (never throws) when the
// platform is unsupported or the OS call fails, so callers can attach what they
// got and the panel degrades to "—".
export async function sampleThreadCounts(
  pids: readonly number[],
  deps: ThreadCountDeps = {}
): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map()
  const platform = deps.platform ?? process.platform

  if (platform === 'darwin') {
    const runPs = deps.runPs ?? defaultRunPs
    try {
      return parsePsThreadCounts(await runPs(pids), new Set(pids))
    } catch {
      return new Map()
    }
  }

  if (platform === 'linux') {
    const readProcStatus = deps.readProcStatus ?? defaultReadProcStatus
    const counts = new Map<number, number>()
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const threads = parseProcStatusThreads(await readProcStatus(pid))
          if (threads !== null) counts.set(pid, threads)
        } catch {
          // Process exited between sampling and read — skip it.
        }
      })
    )
    return counts
  }

  return new Map()
}
