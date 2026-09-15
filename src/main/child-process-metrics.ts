import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type { ProcessMetricKind, ProcessMetricSample } from '../shared/electron-api'

export const CHILD_PROCESS_SAMPLE_THROTTLE_MS = 5_000

export type PsProcessRow = {
  pid: number
  ppid: number
  rssKb: number
  cpuPercent: number
  command: string
  args: string
}

type ChildProcessClassification = {
  kind: ProcessMetricKind
  name: string
}

export type ChildProcessMetricDeps = {
  platform?: NodeJS.Platform
  runPs?: () => Promise<string>
}

export function parsePsProcessRows(stdout: string): PsProcessRow[] {
  const rows: PsProcessRow[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([+-]?(?:\d+\.?\d*|\.\d+))\s+(\S+)(?:\s+(.*))?$/)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      cpuPercent: Math.max(0, Math.round(Number(match[4]) * 10) / 10),
      command: match[5],
      args: match[6] ?? '',
    })
  }
  return rows
}

function commandBase(row: PsProcessRow): string {
  return basename(row.command).toLowerCase()
}

export function classifyChildProcess(row: PsProcessRow): ChildProcessClassification {
  const command = commandBase(row)
  const args = row.args.toLowerCase()
  if (command === 'claude' || args.startsWith('claude ') || args.includes('/claude ')) {
    // Headless conversation sessions run the same binary in stream-json mode
    // (the Claude Agent SDK's wire format); label them distinctly so the
    // process tree tells terminals and chat agents apart.
    if (args.includes('stream-json')) {
      return { kind: 'agent', name: 'Claude conversation' }
    }
    return { kind: 'agent', name: 'Claude CLI' }
  }
  if (command === 'codex' || args.startsWith('codex ') || args.includes('/codex ')) {
    return { kind: 'agent', name: 'Codex CLI' }
  }
  if (args.includes('playwright-mcp') || args.includes('@playwright/mcp')) {
    return { kind: 'helper', name: 'Playwright MCP' }
  }
  if (
    /\s-m\s+\S+/.test(` ${args}`)
    && (command === 'python' || command === 'python3' || command.startsWith('python'))
  ) {
    return { kind: 'helper', name: 'Python sidecar' }
  }
  if (args.includes('/terminal-startup/') || ['zsh', 'bash', 'fish', 'sh'].includes(command)) {
    return { kind: 'terminal', name: 'Terminal shell' }
  }
  if (['node', 'npm', 'npx', 'python', 'python3'].some((runtime) => command === runtime || command.startsWith(`${runtime}.`))) {
    return { kind: 'helper', name: `${command} helper` }
  }
  return { kind: 'other', name: command || 'child process' }
}

export function collectChildProcessMetrics(
  rows: readonly PsProcessRow[],
  rootPid: number,
  excludedPids: ReadonlySet<number>
): ProcessMetricSample[] {
  const byParent = new Map<number, PsProcessRow[]>()
  for (const row of rows) {
    const current = byParent.get(row.ppid) ?? []
    current.push(row)
    byParent.set(row.ppid, current)
  }

  const result: ProcessMetricSample[] = []
  const seen = new Set<number>()
  const visit = (pid: number) => {
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      visit(child.pid)
      if (excludedPids.has(child.pid)) continue
      const classification = classifyChildProcess(child)
      result.push({
        pid: child.pid,
        kind: classification.kind,
        type: 'Child',
        name: classification.name,
        cpuPercent: child.cpuPercent,
        memoryBytes: Math.max(0, child.rssKb) * 1024,
      })
    }
  }
  visit(rootPid)
  return result
}

function defaultRunPs(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,rss=,pcpu=,comm=,args='],
      { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? '' : stdout)
    )
  })
}

export async function sampleChildProcessMetrics(
  rootPid: number,
  excludedPids: readonly number[],
  deps: ChildProcessMetricDeps = {}
): Promise<ProcessMetricSample[]> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') return []
  const runPs = deps.runPs ?? defaultRunPs
  try {
    return collectChildProcessMetrics(
      parsePsProcessRows(await runPs()),
      rootPid,
      new Set([rootPid, ...excludedPids])
    )
  } catch {
    return []
  }
}
