import type { ExecutionHostId } from '../../shared/execution-host'
import { distroOfUncPath, isWindowsPath, toWslPath, wslToWindowsPath } from '../../shared/host-paths'

// Paths at the edge between the Windows front door and a WSL server (phase 7
// spec, 5.6). The server speaks Linux paths end to end; the front door's
// callers speak the workspace root as Windows spells it. Only the typed path
// fields the router forwards are translated: a chat's root and key, the
// commands and arguments of a stdio MCP server, a mention or a skill named by
// a Windows path, and the few typed paths that come back (a plan's file, a
// handoff's root, an approval rule's root). Free text and tool inputs inside
// events are left as the agent wrote them.

export class WslEdgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WslEdgeError'
  }
}

export type WslPathEdge = {
  readonly distro: string
  /** A workspace root as the server spells it. Throws `WslEdgeError` for a drive path when the distribution mounts none. */
  rootIn(root: string): string
  /** A Linux path from the server as Windows opens it: the root it was handed back in its own spelling. */
  pathOut(path: string): string
  /** A call's arguments as the server takes them. */
  args(member: string, args: unknown[]): unknown[]
  /** A call's answer as the front door's callers read it. */
  result(member: string, value: unknown): unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * How a client spells one server's paths. The typed path fields the router
 * forwards are translated with it, both ways (`createPathEdge`).
 */
export type PathSpelling = {
  /** Whether a path is in the client's own spelling, and so is translated. */
  isClientPath(path: string): boolean
  /** A client path as the server takes it. Throws in words for one the server cannot open. */
  toServer(path: string): string
  /** A server path as the client reads it. */
  pathOut(path: string): string
  /** The machine a handed-off terminal runs the CLI on, when the client names one. */
  handoffHostId?: ExecutionHostId
}

export type PathEdge = Omit<WslPathEdge, 'distro'>

/** The typed-field translation both kinds of server share: a WSL distribution's, an SSH machine's. */
export function createPathEdge(spelling: PathSpelling): PathEdge {
  // Each root handed in, by its server spelling, so a root handed back reads
  // exactly as its caller wrote it (`\\wsl$\…` stays `\\wsl$\…`).
  const spelled = new Map<string, string>()

  const rootIn = (root: string): string => {
    if (!spelling.isClientPath(root)) return root
    // A root typed with a separator at its end is the same folder: the server
    // keys its chats by the root, and its children are found under it.
    const translated = spelling.toServer(root)
    const server = translated.length > 1 ? translated.replace(/\/+$/u, '') || '/' : translated
    spelled.set(server, root)
    return server
  }

  const pathOut = (path: string): string => {
    if (!path.startsWith('/')) return path
    const exact = spelled.get(path)
    if (exact) return exact
    for (const [server, client] of spelled) {
      if (path.startsWith(`${server}/`)) {
        const rest = path.slice(server.length + 1)
        const separator = client.includes('\\') ? '\\' : '/'
        return `${client.replace(/[\\/]+$/u, '')}${separator}${rest.split('/').join(separator)}`
      }
    }
    return spelling.pathOut(path)
  }

  const toServer = (path: string): string => (spelling.isClientPath(path) ? spelling.toServer(path) : path)

  const keyIn = (key: unknown): unknown =>
    isRecord(key) && typeof key.workspaceRoot === 'string' ? { ...key, workspaceRoot: rootIn(key.workspaceRoot) } : key

  const mcpServersIn = (servers: unknown): unknown =>
    Array.isArray(servers)
      ? servers.map((server) =>
          isRecord(server) && server.transport === 'stdio'
            ? {
                ...server,
                ...(typeof server.command === 'string' ? { command: toServer(server.command) } : {}),
                ...(Array.isArray(server.args)
                  ? { args: server.args.map((arg) => (typeof arg === 'string' ? toServer(arg) : arg)) }
                  : {}),
              }
            : server,
        )
      : servers

  const firstIn = (member: string, first: unknown): unknown => {
    if (!isRecord(first)) return first
    let next: Record<string, unknown> = first
    if (typeof next.workspaceRoot === 'string') next = { ...next, workspaceRoot: rootIn(next.workspaceRoot) }
    if (isRecord(next.key)) next = { ...next, key: keyIn(next.key) }
    if (member === 'startSession' && next.mcpServers !== undefined)
      next = { ...next, mcpServers: mcpServersIn(next.mcpServers) }
    if (member === 'sendTurn') {
      if (Array.isArray(next.mentions))
        next = {
          ...next,
          mentions: next.mentions.map((mention) =>
            isRecord(mention) && typeof mention.path === 'string'
              ? { ...mention, path: toServer(mention.path) }
              : mention,
          ),
        }
      if (Array.isArray(next.skills))
        next = {
          ...next,
          skills: next.skills.map((skill) =>
            isRecord(skill) && typeof skill.sourcePath === 'string'
              ? { ...skill, sourcePath: toServer(skill.sourcePath) }
              : skill,
          ),
        }
    }
    return next
  }

  return {
    rootIn,
    pathOut,
    args(member, args) {
      if (args.length === 0) return args
      return [firstIn(member, args[0]), ...args.slice(1)]
    },
    result(member, value) {
      if (!isRecord(value)) return value
      if (member === 'planDocument' && value.ok === true && typeof value.path === 'string')
        return { ...value, path: pathOut(value.path) }
      if (member === 'terminalHandoffTarget' && value.ok === true && isRecord(value.target)) {
        const target = value.target
        const cliRuntimes =
          isRecord(target.cliRuntimes) && spelling.handoffHostId
            ? Object.fromEntries(
                Object.entries(target.cliRuntimes).map(([cli, runtime]) => [
                  cli,
                  // The server ran it locally; the terminal that takes over runs it on that machine.
                  isRecord(runtime) ? { ...runtime, hostId: spelling.handoffHostId } : runtime,
                ]),
              )
            : target.cliRuntimes
        return {
          ...value,
          target: {
            ...target,
            ...(typeof target.workspaceRoot === 'string' ? { workspaceRoot: pathOut(target.workspaceRoot) } : {}),
            ...(cliRuntimes ? { cliRuntimes } : {}),
          },
        }
      }
      if (member === 'listApprovalRules' && value.ok === true && Array.isArray(value.rules))
        return {
          ...value,
          rules: value.rules.map((rule) =>
            isRecord(rule) && typeof rule.workspaceRoot === 'string'
              ? { ...rule, workspaceRoot: pathOut(rule.workspaceRoot) }
              : rule,
          ),
        }
      return value
    },
  }
}

export function createWslPathEdge(input: { distro: string; driveMountRoot: string | null }): WslPathEdge {
  const { distro, driveMountRoot } = input
  const toLinux = (path: string): string => {
    const uncDistro = distroOfUncPath(path)
    if (uncDistro !== null) {
      if (uncDistro.toLowerCase() !== distro.toLowerCase())
        throw new WslEdgeError(`${path} is in WSL: ${uncDistro}, not in ${distro}.`)
      return toWslPath(path)
    }
    if (path.startsWith('\\\\')) throw new WslEdgeError(`${path} is a network share, which WSL: ${distro} cannot open.`)
    if (driveMountRoot === null)
      throw new WslEdgeError(
        `WSL: ${distro} mounts no Windows drives (automount is off in its /etc/wsl.conf), so a chat in ${path} cannot run there.`,
      )
    return toWslPath(path, { driveMountRoot })
  }
  return {
    distro,
    ...createPathEdge({
      // A share spelled with forward slashes (`//wsl.localhost/Ubuntu/…`, as
      // Git for Windows prints a repository root there) is routed here like
      // its backslash spelling, so it is translated like it too.
      isClientPath: (path) => isWindowsPath(path) || distroOfUncPath(path) !== null,
      toServer: toLinux,
      pathOut: (path) => wslToWindowsPath(path, { distro, ...(driveMountRoot ? { driveMountRoot } : {}) }),
      handoffHostId: `wsl:${distro}` as ExecutionHostId,
    }),
  }
}
