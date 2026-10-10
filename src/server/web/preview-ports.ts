import { execFile } from 'node:child_process'
import { readFile, readdir, readlink } from 'node:fs/promises'

// The ports a preview may offer without the person typing one (phase 9 spec,
// 3.6): TCP listeners on loopback or a wildcard address, held by processes
// that descend from the server (the agent CLIs it spawned and whatever they
// started, a dev server among them). The server's own listeners are never
// listed, and neither is anything another process on the machine opened: a
// preview exposes a port to a browser, so only what an agent of this server
// started is offered unasked.
//
// Linux reads `/proc` (the listening sockets, then which process holds each
// socket's inode); macOS asks `ps` for the process tree and `lsof` for those
// processes' listeners. Elsewhere, and on any failure, the list is empty: the
// person can still type a port.

export type AgentListener = { port: number; pid: number; command: string }

export type PreviewPortDeps = {
  readFile?: (path: string) => Promise<string>
  readdir?: (path: string) => Promise<string[]>
  readlink?: (path: string) => Promise<string>
  exec?: (file: string, args: string[]) => Promise<string>
}

export type ListAgentListenersInput = PreviewPortDeps & {
  /** The server's own pid: its descendants are the agents' processes. */
  rootPid: number
  /** Ports the server itself listens on, never offered. */
  ownPorts: readonly number[]
  platform?: NodeJS.Platform
}

const COMMAND_CHARS = 120

function defaultExec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      // `lsof` exits 1 when it finds nothing; what it printed is still the answer.
      if (error && !stdout) reject(error)
      else resolve(stdout)
    })
  })
}

/** Every pid that descends from `root`, not counting `root` itself. */
export function descendantsOf(root: number, parents: ReadonlyMap<number, number>): Set<number> {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of parents) {
    const list = children.get(ppid)
    if (list) list.push(pid)
    else children.set(ppid, [pid])
  }
  const found = new Set<number>()
  const queue = [...(children.get(root) ?? [])]
  while (queue.length > 0) {
    const pid = queue.pop() as number
    if (pid === root || found.has(pid)) continue
    found.add(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return found
}

// `/proc/net/tcp*` writes addresses as host-order hex words.
const LOOPBACK_OR_ANY_HEX = new Set([
  '00000000', // 0.0.0.0
  '0100007F', // 127.0.0.1
  '00000000000000000000000000000000', // ::
  '00000000000000000000000001000000', // ::1
  '0000000000000000FFFF00000100007F', // ::ffff:127.0.0.1
  '0000000000000000FFFF000000000000', // ::ffff:0.0.0.0
])

/** The listening sockets in one `/proc/net/tcp` table: inode → port. */
export function parseProcNetTcp(table: string): Map<string, number> {
  const listening = new Map<string, number>()
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 10) continue
    const [address, portHex] = fields[1].split(':')
    if (fields[3] !== '0A' || !LOOPBACK_OR_ANY_HEX.has(address?.toUpperCase() ?? '')) continue
    const port = Number.parseInt(portHex ?? '', 16)
    const inode = fields[9]
    if (Number.isInteger(port) && port > 0 && inode && inode !== '0') listening.set(inode, port)
  }
  return listening
}

type ProcReaders = {
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<string[]>
  link: (path: string) => Promise<string>
}

function procReaders(deps: PreviewPortDeps): ProcReaders {
  return {
    read: deps.readFile ?? ((path: string) => readFile(path, 'utf8')),
    list: deps.readdir ?? ((path: string) => readdir(path)),
    link: deps.readlink ?? ((path: string) => readlink(path)),
  }
}

/** Every loopback or wildcard listening socket on the machine, IPv4 and IPv6: inode → port. */
async function readListeningSockets({ read }: ProcReaders): Promise<Map<string, number>> {
  const sockets = new Map<string, number>()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await read(table).catch(() => '')
    for (const [inode, port] of parseProcNetTcp(text)) sockets.set(inode, port)
  }
  return sockets
}

/**
 * Which of `pids` hold one of `sockets`, read off each process's open file
 * descriptors. A port held by two of them (a forked worker sharing its
 * parent's socket) is listed once, for the first pid that has it.
 */
async function socketHolders(
  pids: Iterable<number>,
  sockets: ReadonlyMap<string, number>,
  { list, link }: ProcReaders,
): Promise<Array<{ pid: number; port: number }>> {
  const found: Array<{ pid: number; port: number }> = []
  const seen = new Set<number>()
  for (const pid of pids) {
    const fds = await list(`/proc/${pid}/fd`).catch(() => [] as string[])
    for (const fd of fds) {
      const target = await link(`/proc/${pid}/fd/${fd}`).catch(() => '')
      const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1]
      const port = inode ? sockets.get(inode) : undefined
      if (port === undefined || seen.has(port)) continue
      seen.add(port)
      found.push({ pid, port })
    }
  }
  return found
}

/**
 * The loopback or wildcard TCP listeners `pids` hold, from `/proc` alone: no
 * `lsof`, which a slim Linux image or a container often does not ship. Empty
 * where there is no `/proc` to read.
 */
export async function listProcListeners(
  pids: Iterable<number>,
  deps: PreviewPortDeps = {},
): Promise<Array<{ pid: number; port: number }>> {
  const readers = procReaders(deps)
  const sockets = await readListeningSockets(readers)
  return sockets.size === 0 ? [] : socketHolders(pids, sockets, readers)
}

async function listLinux(input: ListAgentListenersInput): Promise<AgentListener[]> {
  const readers = procReaders(input)
  const { read, list } = readers
  const sockets = await readListeningSockets(readers)
  if (sockets.size === 0) return []

  const parents = new Map<number, number>()
  const pids = (await list('/proc').catch(() => [] as string[])).filter((name) => /^\d+$/u.test(name)).map(Number)
  for (const pid of pids) {
    const stat = await read(`/proc/${pid}/stat`).catch(() => '')
    // The command name may hold spaces and parentheses; the ppid follows the last `)`.
    const ppid = Number(
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/u)[1],
    )
    if (Number.isInteger(ppid)) parents.set(pid, ppid)
  }
  const agents = descendantsOf(input.rootPid, parents)
  const own = new Set(input.ownPorts)
  const ownFree = new Map([...sockets].filter(([, port]) => !own.has(port)))
  const found: AgentListener[] = []
  for (const { pid, port } of await socketHolders(agents, ownFree, readers)) {
    const cmdline = await read(`/proc/${pid}/cmdline`).catch(() => '')
    found.push({ port, pid, command: cmdline.split('\0').join(' ').trim().slice(0, COMMAND_CHARS) })
  }
  return found.sort((a, b) => a.port - b.port)
}

/** `ps -A -o pid=,ppid=,comm=`: pid → ppid, and pid → command. */
export function parsePs(output: string): { parents: Map<number, number>; commands: Map<number, string> } {
  const parents = new Map<number, number>()
  const commands = new Map<number, string>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
    if (!match) continue
    parents.set(Number(match[1]), Number(match[2]))
    commands.set(Number(match[1]), match[3].trim().slice(0, COMMAND_CHARS))
  }
  return { parents, commands }
}

/** A listening address `lsof -n` prints, as loopback or wildcard, or null for anything else. */
function loopbackOrAnyPort(name: string): number | null {
  const match = /^(.*):(\d+)$/u.exec(name.split('->')[0].trim())
  if (!match) return null
  const host = match[1]
  const loopbackOrAny = ['*', '127.0.0.1', '0.0.0.0', '[::1]', '[::]', 'localhost'].includes(host)
  return loopbackOrAny ? Number(match[2]) : null
}

/** `lsof -Fpcn` field output: the listening ports each process holds. */
export function parseLsof(output: string): Array<{ pid: number; command: string; port: number }> {
  const found: Array<{ pid: number; command: string; port: number }> = []
  let pid = 0
  let command = ''
  for (const line of output.split('\n')) {
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') {
      pid = Number(value)
      command = ''
    } else if (field === 'c') command = value
    else if (field === 'n' && pid > 0) {
      const port = loopbackOrAnyPort(value)
      if (port !== null) found.push({ pid, command, port })
    }
  }
  return found
}

async function listMac(input: ListAgentListenersInput): Promise<AgentListener[]> {
  const exec = input.exec ?? defaultExec
  const { parents, commands } = parsePs(await exec('ps', ['-A', '-o', 'pid=,ppid=,comm=']).catch(() => ''))
  const agents = descendantsOf(input.rootPid, parents)
  if (agents.size === 0) return []
  const output = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn', '-a', '-p', [...agents].join(',')]).catch(
    () => '',
  )
  const own = new Set(input.ownPorts)
  const seen = new Set<number>()
  const found: AgentListener[] = []
  for (const entry of parseLsof(output)) {
    // `lsof -p` lists what was asked; checked again so a stray line cannot widen it.
    if (!agents.has(entry.pid) || own.has(entry.port) || seen.has(entry.port)) continue
    seen.add(entry.port)
    found.push({ port: entry.port, pid: entry.pid, command: commands.get(entry.pid) ?? entry.command })
  }
  return found.sort((a, b) => a.port - b.port)
}

/** The agents' listeners, or an empty list on any platform or failure that cannot say. */
export async function listAgentListeners(input: ListAgentListenersInput): Promise<AgentListener[]> {
  const platform = input.platform ?? process.platform
  try {
    if (platform === 'linux') return await listLinux(input)
    if (platform === 'darwin') return await listMac(input)
  } catch {
    // An empty list: the person can still type a port.
  }
  return []
}
