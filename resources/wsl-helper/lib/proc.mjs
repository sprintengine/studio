// Process reads for the idle reaper and the survivor kill, straight from /proc.
//
// The pty main holds for a WSL terminal is the Windows `wsl.exe`, which means
// nothing inside the distribution. Each WSL startup script therefore records
// the Linux pid of the shell it runs in, in a pid file named after the script
// (see `hosts/wsl-distro.ts` on the Windows side), and every CLI the script
// starts is that shell's child. A snapshot reads those files, builds the
// process tree from /proc, and gives each session the same verdict the macOS
// and Linux reaper gives from `ps` and `lsof`:
//
//   - `listening_port`: something under the shell holds a listening TCP socket
//     (a dev server). Found from /proc/net/tcp{,6} and each process's fds.
//   - `busy_cpu`: something under it used more than 15% of a CPU across the
//     sample.
//   - `tool_shell`: a Claude Code tool shell (its command line names
//     `.claude/shell-snapshots/`), which is how a quiet background command
//     looks.
//
// A session whose pid file is missing, or whose shell's command line no longer
// names its script (the pid was reused), gets no verdict: undetermined, which
// main holds. Nothing here ever reads as "safe to reap" on a failed read.

import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const BUSY_CPU_PERCENT = 15
export const CLAUDE_TOOL_SHELL_SIGNATURE = '.claude/shell-snapshots/'
// Linux reports process times in clock ticks, 100 a second on every kernel
// WSL ships.
const CLOCK_TICKS_PER_SECOND = 100
const PID_KEY = /^[A-Za-z0-9._-]+$/u

/**
 * `/proc/<pid>/stat` as the fields the reaper needs. The command name sits in
 * parentheses and may itself hold spaces and parentheses, so the fields are
 * read after the LAST `)`.
 */
export function parseProcStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u)
  // After the name: state, ppid, pgrp, session, tty, tpgid, flags, minflt,
  // cminflt, majflt, cmajflt, utime, stime.
  const ppid = Number(fields[1])
  const utime = Number(fields[11])
  const stime = Number(fields[12])
  // Field 22, the start time in clock ticks since boot.
  const started = fields[19] ?? ''
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime)) {
    return null
  }
  return { pid, ppid, ticks: utime + stime, started }
}

/** The socket inodes in LISTEN state (`0A`) in a /proc/net/tcp or tcp6 table. */
export function parseListeningInodes(text) {
  const inodes = new Set()
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 10) continue
    if (fields[3] === '0A' && fields[9] !== '0') inodes.add(fields[9])
  }
  return inodes
}

/** A socket fd's link target (`socket:[12345]`) as its inode, else null. */
export function socketInode(link) {
  const match = /^socket:\[(\d+)\]$/u.exec(link)
  return match ? match[1] : null
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Every process /proc lists, with its parent, CPU ticks and command line. */
export function readProcessTable(procRoot = '/proc') {
  let entries
  try {
    entries = readdirSync(procRoot)
  } catch {
    return null
  }
  const rows = []
  for (const name of entries) {
    if (!/^\d+$/u.test(name)) continue
    const stat = readText(join(procRoot, name, 'stat'))
    const parsed = stat ? parseProcStat(stat) : null
    if (!parsed) continue
    const cmdline = readText(join(procRoot, name, 'cmdline')) ?? ''
    rows.push({ ...parsed, command: cmdline.split('\0').join(' ').trim() })
  }
  return rows
}

/** The pids among `pids` holding one of `inodes` open. */
export function listeningPids(procRoot, pids, inodes) {
  const found = new Set()
  if (inodes.size === 0) return found
  for (const pid of pids) {
    let fds
    try {
      fds = readdirSync(join(procRoot, String(pid), 'fd'))
    } catch {
      continue
    }
    for (const fd of fds) {
      let link
      try {
        link = readlinkSync(join(procRoot, String(pid), 'fd', fd))
      } catch {
        continue
      }
      const inode = socketInode(link)
      if (inode && inodes.has(inode)) {
        found.add(pid)
        break
      }
    }
  }
  return found
}

/** `root`'s descendants (not `root` itself), in no particular order. */
export function descendants(root, rows) {
  const children = new Map()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }
  const seen = new Set([root])
  const out = []
  const stack = [...(children.get(root) ?? [])]
  while (stack.length > 0) {
    const row = stack.pop()
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    out.push(row)
    stack.push(...(children.get(row.pid) ?? []))
  }
  return out
}

/**
 * The first live-work reason in `root`'s subtree, or null for none. The same
 * rule, in the same order, as `subtreeLiveReason` in main's
 * `terminal-subtree-probe.ts`: a port first, then CPU, then a tool shell.
 */
export function subtreeLiveReason(root, rows, listening, cpuByPid, busyCpuPercent = BUSY_CPU_PERCENT) {
  for (const row of descendants(root, rows)) {
    if (listening.has(row.pid)) return 'listening_port'
    if ((cpuByPid.get(row.pid) ?? 0) > busyCpuPercent) return 'busy_cpu'
    if (row.command.includes(CLAUDE_TOOL_SHELL_SIGNATURE)) return 'tool_shell'
  }
  return null
}

/**
 * The per-user directory the startup scripts write their pid files into, or
 * null when it is not ours. Another user could create `/tmp/sprintengine-…`
 * first; a directory we do not own is never read, so its files can never
 * point the survivor kill at anything.
 */
export function trustedPidDir(pidDir, uid) {
  for (const dir of [join(pidDir, '..'), pidDir]) {
    try {
      const stats = lstatSync(dir)
      if (!stats.isDirectory() || stats.isSymbolicLink()) return null
      if (typeof uid === 'number' && stats.uid !== uid) return null
    } catch {
      return null
    }
  }
  return pidDir
}

/** The shell pid a session's pid file names, when that shell still runs its script. */
export function sessionRoot({ procRoot, pidDir, key, rows }) {
  if (!pidDir || !PID_KEY.test(key)) return null
  const text = readText(join(pidDir, `${key}.pid`))
  const [pidText, startedText] = (text ?? '').trim().split('\n')[0].split(/\s+/u)
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 1) return null
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row) return null
  // The pid is only trusted while it is still the same process: a pid the
  // kernel has since handed to something else is not ours. The start time the
  // script recorded says so, and survives the script's final `exec` of the
  // terminal's shell. A pid file without one (written before the start time
  // was recorded) falls back to the command line still naming the script.
  if (startedText) return row.started === startedText ? pid : null
  const cmdline = readText(join(procRoot, String(pid), 'cmdline'))
  if (cmdline === null || !cmdline.includes(key)) return null
  return pid
}

function listeningInodes(procRoot) {
  const tcp = readText(join(procRoot, 'net', 'tcp'))
  const tcp6 = readText(join(procRoot, 'net', 'tcp6'))
  if (tcp === null && tcp6 === null) return null
  return new Set([...parseListeningInodes(tcp ?? ''), ...parseListeningInodes(tcp6 ?? '')])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Live-work verdicts for sessions, keyed by pid-file key. A key absent from
 * the result is undetermined.
 */
export async function snapshot({ procRoot = '/proc', pidDir, keys, sampleMs = 500, uid }) {
  const verdicts = {}
  const dir = pidDir ? trustedPidDir(pidDir, uid) : null
  const first = readProcessTable(procRoot)
  if (!first || !dir) return verdicts
  const roots = new Map()
  for (const key of keys) {
    const root = sessionRoot({ procRoot, pidDir: dir, key, rows: first })
    if (root !== null) roots.set(key, root)
  }
  if (roots.size === 0) return verdicts
  await sleep(sampleMs)
  const second = readProcessTable(procRoot)
  const inodes = listeningInodes(procRoot)
  if (!second || inodes === null) return verdicts
  const before = new Map(first.map((row) => [row.pid, row.ticks]))
  const cpuByPid = new Map()
  for (const row of second) {
    const start = before.get(row.pid)
    if (start === undefined) continue
    cpuByPid.set(row.pid, ((row.ticks - start) / CLOCK_TICKS_PER_SECOND / (sampleMs / 1000)) * 100)
  }
  for (const [key, root] of roots) {
    const tree = descendants(root, second).map((row) => row.pid)
    const listening = listeningPids(procRoot, tree, inodes)
    verdicts[key] = subtreeLiveReason(root, second, listening, cpuByPid)
  }
  return verdicts
}

/**
 * The pids a suspended or closed session left behind: every process whose
 * command line carries `--session-id <id>`, and, while its shell still runs its
 * script, that shell and everything under it. `selfPid` (the helper) is never
 * in the list.
 */
export function survivorPids({ procRoot = '/proc', pidDir, cliSessionId, key, uid, selfPid }) {
  const rows = readProcessTable(procRoot)
  if (!rows) return []
  const pids = new Set()
  if (cliSessionId) {
    const needle = `--session-id ${cliSessionId}`
    for (const row of rows) if (row.command.includes(needle)) pids.add(row.pid)
  }
  const dir = pidDir ? trustedPidDir(pidDir, uid) : null
  if (key && dir) {
    const root = sessionRoot({ procRoot, pidDir: dir, key, rows })
    if (root !== null) {
      pids.add(root)
      for (const row of descendants(root, rows)) pids.add(row.pid)
    }
  }
  pids.delete(selfPid)
  pids.delete(1)
  return [...pids]
}

/**
 * Ends every session this profile's pid files still name: each shell that is
 * still the one that wrote its file, and everything under it. For the app
 * quitting, and for a first start after a main that is gone left sessions
 * running. A pid the kernel has since given to something else is not touched
 * (see `sessionRoot`). Each pid file is removed. Returns the pids signalled.
 */
export function endAllSessions({ procRoot = '/proc', pidDir, uid, selfPid, kill = process.kill }) {
  const dir = pidDir ? trustedPidDir(pidDir, uid) : null
  if (!dir) return []
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const killed = []
  for (const name of names) {
    const match = /^(.+)\.pid$/u.exec(name)
    if (!match || !PID_KEY.test(match[1])) continue
    for (const pid of survivorPids({ procRoot, pidDir: dir, cliSessionId: '', key: match[1], uid, selfPid })) {
      try {
        kill(pid, 'SIGKILL')
        killed.push(pid)
      } catch {
        // Gone already.
      }
    }
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // Removed by someone else.
    }
  }
  return killed
}
